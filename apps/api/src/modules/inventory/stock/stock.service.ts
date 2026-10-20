import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InventoryItem, StockAdjustment, StockCount, StockIssue, StockMovement, StockTransfer } from './stock-types';
import type { Warehouse } from '../warehouse/warehouse-types';
import type { InventoryActor } from '../inventory-actor';
import { InventoryAuditGateway } from '../inventory-audit.gateway';
import { INVENTORY_AUDIT_RESOURCE } from '../inventory.constants';
import { InventoryUnitOfWork } from '../database/inventory-transaction';
import { ItemRepository } from '../item/item.repository';
import { WarehouseRepository } from '../warehouse/warehouse.repository';
import { StockRepository } from './stock.repository';
import {
  absQuantity,
  addQuantity,
  compareQuantity,
  isZeroQuantity,
  multiplyQuantity,
  negateQuantity,
  quantityFromNumber,
} from './quantity-math';

/**
 * Phase W1: every stock business rule.
 *
 * OWNERSHIP, AS EVERY COMMERCE/FINANCIAL SERVICE STATES IT
 * -------------------------------------------------------
 * The service orchestrates; `StockRepository`, `ItemRepository` and
 * `WarehouseRepository` own the statements; `InventoryUnitOfWork` is the only
 * transaction. Validation happens BEFORE the unit of work opens for reads
 * that cannot change between them (item exists and is stocked, warehouse is
 * active, unit is declared) and INSIDE it for anything concurrent (the
 * balance decrement carries its guard in the predicate — the only correct
 * place for an availability check).
 *
 * THE INVARIANTS, STATED
 * ----------------------
 *   - A movement and its balance delta commit together or not at all (uow).
 *   - A ledger row posts ONCE per (sourceType, sourceId, kind): the unique
 *     index turns a retry into a P2002 → 409, never a second movement.
 *   - A decrement posts only when `onHand >= qty` holds inside the update —
 *     negative stock is structurally impossible, and concurrent over-issue is
 *     answered with 409 by the loser.
 *   - A reversal is a REVERSAL row plus the opposite delta; the unique index
 *     on `reversesMovementId` compensates a movement at most once.
 *   - An issue cannot exceed available stock. `available = onHand - reserved
 *     - blocked`, and with reservations not yet implemented `onHand` is the
 *     whole guard — stated here so the contract change is visible when
 *     reservations land.
 *   - A transfer never increases destination stock at request creation:
 *     DISPATCH decrements the source (in-transit), RECEIVE increments the
 *     destination — quantity is conserved between the two ledger rows.
 *
 * THE OPAQUE SOURCE REFERENCE
 * ---------------------------
 * `sourceType`/`sourceId` come from the caller — e.g. a Commerce integration
 * posting `('commerce.receipt', <receipt id>)`. Inventory deliberately does
 * NOT validate the referenced operation inside another module's database:
 * there is no cross-database FK and none is invented. The posting caller owns
 * that validation; Inventory owns the guarantee that the reference posts at
 * most once.
 */

/** The same structural check the Commerce repositories use — no generated-client
 * import in a service. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export class InsufficientStockError extends ConflictException {
  constructor(itemId: string, warehouseId: string) {
    super(`Insufficient stock for item ${itemId} in warehouse ${warehouseId}.`);
  }
}

export class DuplicatePostingError extends ConflictException {
  constructor(sourceType: string, sourceId: string, kind: string) {
    super(
      `A ${kind} movement already exists for ${sourceType} ${sourceId}; the operation is idempotent and was not repeated.`
    );
  }
}

interface TrackingFields {
  lotNumber?: string;
  serialNumber?: string;
  expiryDate?: string;
}

@Injectable()
export class StockService {
  constructor(
    private readonly stock: StockRepository,
    private readonly items: ItemRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly uow: InventoryUnitOfWork,
    private readonly audit: InventoryAuditGateway
  ) {}

  // -------------------------------------------------------------------------
  // SHARED VALIDATION
  // -------------------------------------------------------------------------

  private async stockedItem(actor: InventoryActor, itemId: string): Promise<InventoryItem> {
    const item = await this.items.findById(actor.tenantId, itemId);
    if (!item) throw new NotFoundException('Item not found.');
    if (item.itemType !== 'STOCKED') {
      throw new BadRequestException(
        `Item ${item.sku} is ${item.itemType}; only STOCKED items appear on stock movements.`
      );
    }
    if (item.status !== 'ACTIVE') {
      throw new BadRequestException(`Item ${item.sku} is inactive.`);
    }
    return item;
  }

  private async activeWarehouse(
    actor: InventoryActor,
    warehouseId: string
  ): Promise<Warehouse> {
    const warehouse = await this.warehouses.findById(actor.tenantId, warehouseId);
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (warehouse.status !== 'ACTIVE') {
      throw new BadRequestException(`Warehouse ${warehouse.code} is inactive.`);
    }
    return warehouse;
  }

  /** Returns the locationId the ledger stores ("" = warehouse-level). */
  private async locationKey(
    actor: InventoryActor,
    warehouseId: string,
    locationId: string | undefined
  ): Promise<string> {
    if (!locationId) return '';
    const location = await this.warehouses.findLocationInWarehouse(
      actor.tenantId,
      warehouseId,
      locationId
    );
    if (!location) {
      throw new NotFoundException('Location not found in the given warehouse.');
    }
    if (location.status !== 'ACTIVE') {
      throw new BadRequestException(`Location ${location.code} is inactive.`);
    }
    return location.id;
  }

  /** The ONLY conversion path: base unit ratio 1, else a declared ItemUnit. */
  private async baseQuantityOf(
    actor: InventoryActor,
    item: InventoryItem,
    quantity: string,
    unit: string
  ): Promise<string> {
    if (unit === item.baseUnit) return quantity;
    const declared = await this.items.findUnit(actor.tenantId, item.id, unit);
    if (!declared) {
      throw new BadRequestException(
        `Unit "${unit}" is not declared for item ${item.sku}; only the base unit or a governed ratio may move stock.`
      );
    }
    return multiplyQuantity(quantity, declared.ratioToBase.toString());
  }

  /** Tracking-policy checks every poster applies to a signed quantity. */
  private assertTracking(item: InventoryItem, fields: TrackingFields, quantity: string, inbound: boolean) {
    if (item.trackingMode === 'LOT' && !fields.lotNumber?.trim()) {
      throw new BadRequestException(`Item ${item.sku} is lot-tracked; lotNumber is required.`);
    }
    if (item.trackingMode === 'SERIAL') {
      if (!fields.serialNumber?.trim()) {
        throw new BadRequestException(`Item ${item.sku} is serial-tracked; serialNumber is required.`);
      }
      if (compareQuantity(absQuantity(quantity), '1') !== 0) {
        throw new BadRequestException(
          `Item ${item.sku} is serial-tracked; each movement carries exactly one serial unit.`
        );
      }
    }
    if (item.expiryTracked && inbound && !fields.expiryDate?.trim()) {
      throw new BadRequestException(`Item ${item.sku} is expiry-tracked; expiryDate is required on inbound.`);
    }
  }

  private auditWrite(actor: InventoryActor, act: Parameters<InventoryAuditGateway['record']>[1]) {
    return this.audit.record(actor, act);
  }

  // -------------------------------------------------------------------------
  // RECEIPTS — inbound posting, idempotent on (sourceType, sourceId)
  // -------------------------------------------------------------------------

  async postReceipt(
    actor: InventoryActor,
    dto: {
      itemId: string;
      warehouseId: string;
      locationId?: string;
      quantity: number;
      unit: string;
      sourceType: string;
      sourceId: string;
      lotNumber?: string;
      serialNumber?: string;
      expiryDate?: string;
      note?: string;
    }
  ): Promise<StockMovement> {
    const item = await this.stockedItem(actor, dto.itemId);
    await this.activeWarehouse(actor, dto.warehouseId);
    const locationId = await this.locationKey(actor, dto.warehouseId, dto.locationId);
    const quantity = quantityFromNumber(dto.quantity);
    const baseQuantity = await this.baseQuantityOf(actor, item, quantity, dto.unit);
    this.assertTracking(item, dto, quantity, true);

    try {
      const movement = await this.uow.run(async (tx) => {
        const row = await this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: 'RECEIPT',
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity,
          unit: dto.unit,
          baseQuantity,
          lotNumber: dto.lotNumber,
          serialNumber: dto.serialNumber,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
          note: dto.note,
          recordedByUserId: actor.userId,
        });
        await this.stock.addToBalance(
          tx,
          { tenantId: actor.tenantId, itemId: item.id, warehouseId: dto.warehouseId, locationId },
          baseQuantity
        );
        return row;
      });
      await this.auditWrite(actor, {
        action: 'inventory.stock.receipt',
        resource: INVENTORY_AUDIT_RESOURCE.MOVEMENT,
        resourceId: movement.id,
        newValue: {
          kind: movement.kind,
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity,
          unit: dto.unit,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
        },
      });
      return movement;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePostingError(dto.sourceType, dto.sourceId, 'RECEIPT');
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // ISSUES — outbound posting with an in-predicate availability guard
  // -------------------------------------------------------------------------

  async createIssue(
    actor: InventoryActor,
    dto: {
      itemId: string;
      warehouseId: string;
      locationId?: string;
      quantity: number;
      unit: string;
      issuedTo: string;
      lotNumber?: string;
      serialNumber?: string;
      note?: string;
    }
  ): Promise<StockIssue> {
    const item = await this.stockedItem(actor, dto.itemId);
    await this.activeWarehouse(actor, dto.warehouseId);
    const locationId = await this.locationKey(actor, dto.warehouseId, dto.locationId);
    const quantity = quantityFromNumber(dto.quantity);
    const baseQuantity = await this.baseQuantityOf(actor, item, quantity, dto.unit);
    this.assertTracking(item, dto, quantity, false);

    const issue = await this.uow.run(async (tx) => {
      const cell = {
        tenantId: actor.tenantId,
        itemId: item.id,
        warehouseId: dto.warehouseId,
        locationId,
      };
      const decremented = await this.stock.subtractFromBalance(tx, cell, baseQuantity);
      if (decremented.count === 0) {
        throw new InsufficientStockError(item.id, dto.warehouseId);
      }
      const row = await this.stock.createIssue(
        actor.tenantId,
        {
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity,
          unit: dto.unit,
          baseQuantity,
          issuedTo: dto.issuedTo.trim(),
          lotNumber: dto.lotNumber,
          serialNumber: dto.serialNumber,
          note: dto.note,
          createdByUserId: actor.userId,
        },
        tx
      );
      const movement = await this.stock.appendMovement(tx, {
        tenantId: actor.tenantId,
        kind: 'ISSUE',
        itemId: item.id,
        warehouseId: dto.warehouseId,
        locationId,
        quantity: negateQuantity(quantity),
        unit: dto.unit,
        baseQuantity: negateQuantity(baseQuantity),
        lotNumber: dto.lotNumber,
        serialNumber: dto.serialNumber,
        sourceType: 'inventory.issue',
        sourceId: row.id,
        note: dto.note,
        recordedByUserId: actor.userId,
      });
      await this.stock.linkIssueMovement(tx, actor.tenantId, row.id, movement.id);
      return { ...row, movementId: movement.id };
    });
    await this.auditWrite(actor, {
      action: 'inventory.stock.issue',
      resource: INVENTORY_AUDIT_RESOURCE.ISSUE,
      resourceId: issue.id,
      newValue: {
        itemId: item.id,
        warehouseId: dto.warehouseId,
        quantity,
        unit: dto.unit,
        issuedTo: dto.issuedTo.trim(),
      },
    });
    return issue;
  }

  /**
   * Outbound posting for cross-context integration (Commerce receipt
   * compensations and dispatched supplier returns): the SAME guarded
   * decrement + idempotent append as `createIssue`, but the caller states the
   * business kind and the source reference — there is no issue record, the
   * source document IS the audit.
   *
   * `kind` is deliberately narrow: only outbound kinds a source document may
   * claim. Idempotency is the ledger's `(sourceType, sourceId, kind)` unique —
   * a retry with the same key answers 409 DuplicatePostingError, which the
   * integration layer reads as "already posted", not as a failure.
   */
  async postOutbound(
    actor: InventoryActor,
    dto: {
      itemId: string;
      warehouseId: string;
      locationId?: string;
      quantity: number;
      unit: string;
      kind: 'ISSUE' | 'SUPPLIER_RETURN';
      sourceType: string;
      sourceId: string;
      lotNumber?: string;
      serialNumber?: string;
      note?: string;
    }
  ): Promise<StockMovement> {
    const item = await this.stockedItem(actor, dto.itemId);
    await this.activeWarehouse(actor, dto.warehouseId);
    const locationId = await this.locationKey(actor, dto.warehouseId, dto.locationId);
    const quantity = quantityFromNumber(dto.quantity);
    const baseQuantity = await this.baseQuantityOf(actor, item, quantity, dto.unit);
    this.assertTracking(item, dto, quantity, false);

    try {
      const movement = await this.uow.run(async (tx) => {
        const cell = {
          tenantId: actor.tenantId,
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
        };
        const decremented = await this.stock.subtractFromBalance(tx, cell, baseQuantity);
        if (decremented.count === 0) {
          throw new InsufficientStockError(item.id, dto.warehouseId);
        }
        return this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: dto.kind,
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity: negateQuantity(quantity),
          unit: dto.unit,
          baseQuantity: negateQuantity(baseQuantity),
          lotNumber: dto.lotNumber,
          serialNumber: dto.serialNumber,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
          note: dto.note,
          recordedByUserId: actor.userId,
        });
      });
      await this.auditWrite(actor, {
        action: `inventory.stock.${dto.kind === 'SUPPLIER_RETURN' ? 'supplier-return' : 'outbound'}`,
        resource: INVENTORY_AUDIT_RESOURCE.MOVEMENT,
        resourceId: movement.id,
        newValue: {
          kind: movement.kind,
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity,
          unit: dto.unit,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
        },
      });
      return movement;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePostingError(dto.sourceType, dto.sourceId, dto.kind);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // ADJUSTMENTS — signed, reason-coded, guarded on the negative side
  // -------------------------------------------------------------------------

  async createAdjustment(
    actor: InventoryActor,
    dto: {
      itemId: string;
      warehouseId: string;
      locationId?: string;
      quantity: number;
      unit: string;
      reason: StockAdjustment['reason'];
      lotNumber?: string;
      serialNumber?: string;
      note?: string;
    }
  ): Promise<StockAdjustment> {
    if (dto.quantity === 0) {
      throw new BadRequestException('An adjustment quantity of zero is not a correction.');
    }
    const item = await this.stockedItem(actor, dto.itemId);
    await this.activeWarehouse(actor, dto.warehouseId);
    const locationId = await this.locationKey(actor, dto.warehouseId, dto.locationId);
    const quantity = quantityFromNumber(dto.quantity);
    const baseQuantity = await this.baseQuantityOf(actor, item, quantity, dto.unit);
    this.assertTracking(item, dto, quantity, compareQuantity(quantity, '0') > 0);

    const adjustment = await this.uow.run(async (tx) => {
      const cell = {
        tenantId: actor.tenantId,
        itemId: item.id,
        warehouseId: dto.warehouseId,
        locationId,
      };
      if (compareQuantity(baseQuantity, '0') < 0) {
        const decremented = await this.stock.subtractFromBalance(tx, cell, absQuantity(baseQuantity));
        if (decremented.count === 0) {
          throw new InsufficientStockError(item.id, dto.warehouseId);
        }
      } else {
        await this.stock.addToBalance(tx, cell, baseQuantity);
      }
      const row = await this.stock.createAdjustment(
        actor.tenantId,
        {
          itemId: item.id,
          warehouseId: dto.warehouseId,
          locationId,
          quantity,
          unit: dto.unit,
          baseQuantity,
          reason: dto.reason,
          note: dto.note,
          lotNumber: dto.lotNumber,
          serialNumber: dto.serialNumber,
          createdByUserId: actor.userId,
        },
        tx
      );
      const movement = await this.stock.appendMovement(tx, {
        tenantId: actor.tenantId,
        kind: 'ADJUSTMENT',
        itemId: item.id,
        warehouseId: dto.warehouseId,
        locationId,
        quantity,
        unit: dto.unit,
        baseQuantity,
        lotNumber: dto.lotNumber,
        serialNumber: dto.serialNumber,
        sourceType: 'inventory.adjustment',
        sourceId: row.id,
        note: `${dto.reason}${dto.note ? ` — ${dto.note}` : ''}`,
        recordedByUserId: actor.userId,
      });
      await this.stock.linkAdjustmentMovement(tx, actor.tenantId, row.id, movement.id);
      return { ...row, movementId: movement.id };
    });
    await this.auditWrite(actor, {
      action: 'inventory.stock.adjustment',
      resource: INVENTORY_AUDIT_RESOURCE.ADJUSTMENT,
      resourceId: adjustment.id,
      newValue: {
        itemId: item.id,
        warehouseId: dto.warehouseId,
        quantity,
        unit: dto.unit,
        reason: dto.reason,
      },
    });
    return adjustment;
  }

  // -------------------------------------------------------------------------
  // REVERSALS — a compensating row, never an edit
  // -------------------------------------------------------------------------

  async reverseMovement(
    actor: InventoryActor,
    movementId: string,
    note?: string
  ): Promise<StockMovement> {
    const original = await this.stock.findMovement(actor.tenantId, movementId);
    if (!original) throw new NotFoundException('Movement not found.');
    if (original.kind === 'REVERSAL') {
      throw new BadRequestException('A reversal row is not itself reversed; correct the original act instead.');
    }

    const quantity = original.quantity.toString();
    const baseQuantity = original.baseQuantity.toString();

    try {
      const reversal = await this.uow.run(async (tx) => {
        const cell = {
          tenantId: actor.tenantId,
          itemId: original.itemId,
          warehouseId: original.warehouseId,
          locationId: original.locationId,
        };
        const reversedBase = negateQuantity(baseQuantity);
        if (compareQuantity(reversedBase, '0') < 0) {
          const decremented = await this.stock.subtractFromBalance(tx, cell, absQuantity(reversedBase));
          if (decremented.count === 0) {
            throw new InsufficientStockError(original.itemId, original.warehouseId);
          }
        } else {
          await this.stock.addToBalance(tx, cell, reversedBase);
        }
        return this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: 'REVERSAL',
          itemId: original.itemId,
          warehouseId: original.warehouseId,
          locationId: original.locationId,
          quantity: negateQuantity(quantity),
          unit: original.unit,
          baseQuantity: reversedBase,
          lotNumber: original.lotNumber,
          serialNumber: original.serialNumber,
          expiryDate: original.expiryDate,
          sourceType: 'inventory.reversal',
          sourceId: original.id,
          reversesMovementId: original.id,
          note: note ?? `Reversal of ${original.kind} ${original.id}`,
          recordedByUserId: actor.userId,
        });
      });
      await this.auditWrite(actor, {
        action: 'inventory.stock.reversal',
        resource: INVENTORY_AUDIT_RESOURCE.MOVEMENT,
        resourceId: reversal.id,
        newValue: { reversesMovementId: original.id, kind: original.kind },
      });
      return reversal;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This movement is already compensated; a reversal posts at most once.');
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // TRANSFERS — in-transit is a state, not a shortcut
  // -------------------------------------------------------------------------

  async createTransfer(
    actor: InventoryActor,
    dto: {
      itemId: string;
      fromWarehouseId: string;
      fromLocationId?: string;
      toWarehouseId: string;
      toLocationId?: string;
      quantity: number;
      unit: string;
      lotNumber?: string;
      serialNumber?: string;
      note?: string;
    }
  ): Promise<StockTransfer> {
    const item = await this.stockedItem(actor, dto.itemId);
    await this.activeWarehouse(actor, dto.fromWarehouseId);
    await this.activeWarehouse(actor, dto.toWarehouseId);
    const fromLocationId = await this.locationKey(actor, dto.fromWarehouseId, dto.fromLocationId);
    const toLocationId = await this.locationKey(actor, dto.toWarehouseId, dto.toLocationId);
    if (dto.fromWarehouseId === dto.toWarehouseId && fromLocationId === toLocationId) {
      throw new BadRequestException('A transfer to the same warehouse cell is not a transfer.');
    }
    const quantity = quantityFromNumber(dto.quantity);
    const baseQuantity = await this.baseQuantityOf(actor, item, quantity, dto.unit);
    this.assertTracking(item, dto, quantity, false);

    const transfer = await this.stock.createTransfer(actor.tenantId, {
      itemId: item.id,
      quantity,
      unit: dto.unit,
      baseQuantity,
      lotNumber: dto.lotNumber,
      serialNumber: dto.serialNumber,
      fromWarehouseId: dto.fromWarehouseId,
      fromLocationId,
      toWarehouseId: dto.toWarehouseId,
      toLocationId,
      note: dto.note,
      createdByUserId: actor.userId,
    });
    await this.auditWrite(actor, {
      action: 'inventory.transfer.create',
      resource: INVENTORY_AUDIT_RESOURCE.TRANSFER,
      resourceId: transfer.id,
      newValue: {
        itemId: item.id,
        fromWarehouseId: dto.fromWarehouseId,
        toWarehouseId: dto.toWarehouseId,
        quantity,
        unit: dto.unit,
      },
    });
    return transfer;
  }

  /** DISPATCH: source decremented, TRANSFER_OUT posted, status → DISPATCHED —
   * all inside one transaction; destination is NOT touched. */
  async dispatchTransfer(actor: InventoryActor, transferId: string): Promise<StockTransfer> {
    const transfer = await this.stock.findTransfer(actor.tenantId, transferId);
    if (!transfer) throw new NotFoundException('Transfer not found.');
    if (transfer.status !== 'DRAFT') {
      throw new ConflictException(`Transfer is ${transfer.status}; only DRAFT can be dispatched.`);
    }

    try {
      await this.uow.run(async (tx) => {
        const decremented = await this.stock.subtractFromBalance(
          tx,
          {
            tenantId: actor.tenantId,
            itemId: transfer.itemId,
            warehouseId: transfer.fromWarehouseId,
            locationId: transfer.fromLocationId,
          },
          transfer.baseQuantity.toString()
        );
        if (decremented.count === 0) {
          throw new InsufficientStockError(transfer.itemId, transfer.fromWarehouseId);
        }
        await this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: 'TRANSFER_OUT',
          itemId: transfer.itemId,
          warehouseId: transfer.fromWarehouseId,
          locationId: transfer.fromLocationId,
          quantity: negateQuantity(transfer.quantity.toString()),
          unit: transfer.unit,
          baseQuantity: negateQuantity(transfer.baseQuantity.toString()),
          lotNumber: transfer.lotNumber,
          serialNumber: transfer.serialNumber,
          sourceType: 'inventory.transfer',
          sourceId: transfer.id,
          note: transfer.note,
          recordedByUserId: actor.userId,
        });
        const flipped = await this.stock.setTransferStatus(tx, actor.tenantId, transfer.id, 'DRAFT', {
          status: 'DISPATCHED',
          dispatchedByUserId: actor.userId,
          dispatchedAt: new Date(),
        });
        if (flipped.count === 0) {
          throw new ConflictException('Transfer was concurrently dispatched; state was not repeated.');
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePostingError('inventory.transfer', transfer.id, 'TRANSFER_OUT');
      }
      throw error;
    }
    await this.auditWrite(actor, {
      action: 'inventory.transfer.dispatch',
      resource: INVENTORY_AUDIT_RESOURCE.TRANSFER,
      resourceId: transfer.id,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'DISPATCHED' },
    });
    return { ...transfer, status: 'DISPATCHED' };
  }

  /** RECEIVE: destination incremented, TRANSFER_IN posted, status → RECEIVED. */
  async receiveTransfer(actor: InventoryActor, transferId: string): Promise<StockTransfer> {
    const transfer = await this.stock.findTransfer(actor.tenantId, transferId);
    if (!transfer) throw new NotFoundException('Transfer not found.');
    if (transfer.status !== 'DISPATCHED') {
      throw new ConflictException(`Transfer is ${transfer.status}; only DISPATCHED can be received.`);
    }

    try {
      await this.uow.run(async (tx) => {
        await this.stock.addToBalance(
          tx,
          {
            tenantId: actor.tenantId,
            itemId: transfer.itemId,
            warehouseId: transfer.toWarehouseId,
            locationId: transfer.toLocationId,
          },
          transfer.baseQuantity.toString()
        );
        await this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: 'TRANSFER_IN',
          itemId: transfer.itemId,
          warehouseId: transfer.toWarehouseId,
          locationId: transfer.toLocationId,
          quantity: transfer.quantity.toString(),
          unit: transfer.unit,
          baseQuantity: transfer.baseQuantity.toString(),
          lotNumber: transfer.lotNumber,
          serialNumber: transfer.serialNumber,
          sourceType: 'inventory.transfer',
          sourceId: transfer.id,
          note: transfer.note,
          recordedByUserId: actor.userId,
        });
        const flipped = await this.stock.setTransferStatus(tx, actor.tenantId, transfer.id, 'DISPATCHED', {
          status: 'RECEIVED',
          receivedByUserId: actor.userId,
          receivedAt: new Date(),
        });
        if (flipped.count === 0) {
          throw new ConflictException('Transfer was concurrently received; state was not repeated.');
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePostingError('inventory.transfer', transfer.id, 'TRANSFER_IN');
      }
      throw error;
    }
    await this.auditWrite(actor, {
      action: 'inventory.transfer.receive',
      resource: INVENTORY_AUDIT_RESOURCE.TRANSFER,
      resourceId: transfer.id,
      oldValue: { status: 'DISPATCHED' },
      newValue: { status: 'RECEIVED' },
    });
    return { ...transfer, status: 'RECEIVED' };
  }

  async cancelTransfer(actor: InventoryActor, transferId: string): Promise<StockTransfer> {
    const transfer = await this.stock.findTransfer(actor.tenantId, transferId);
    if (!transfer) throw new NotFoundException('Transfer not found.');
    if (transfer.status !== 'DRAFT') {
      // A dispatched transfer is physically in transit; the honest cancel is a
      // return transfer after receipt, not a status flip that would orphan
      // the in-transit quantity.
      throw new ConflictException(
        `Transfer is ${transfer.status}; only a DRAFT can be cancelled — receive it first, then transfer back.`
      );
    }
    await this.uow.run(async (tx) => {
      const flipped = await this.stock.setTransferStatus(tx, actor.tenantId, transfer.id, 'DRAFT', {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });
      if (flipped.count === 0) {
        throw new ConflictException('Transfer state changed concurrently; cancellation not repeated.');
      }
    });
    await this.auditWrite(actor, {
      action: 'inventory.transfer.cancel',
      resource: INVENTORY_AUDIT_RESOURCE.TRANSFER,
      resourceId: transfer.id,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'CANCELLED' },
    });
    return { ...transfer, status: 'CANCELLED' };
  }

  // -------------------------------------------------------------------------
  // STOCK COUNTS — snapshot, count, post variances
  // -------------------------------------------------------------------------

  async createCount(
    actor: InventoryActor,
    dto: { warehouseId: string; note?: string; lines: Array<{ itemId: string; locationId?: string }> }
  ): Promise<StockCount> {
    await this.activeWarehouse(actor, dto.warehouseId);
    const lines = [];
    const seen = new Set<string>();
    for (const line of dto.lines) {
      const item = await this.stockedItem(actor, line.itemId);
      const locationId = await this.locationKey(actor, dto.warehouseId, line.locationId);
      const key = `${item.id}|${locationId}`;
      if (seen.has(key)) {
        throw new BadRequestException(`Item ${item.sku} is counted twice in one session.`);
      }
      seen.add(key);
      const balance = await this.stock.findBalance(actor.tenantId, item.id, dto.warehouseId, locationId);
      lines.push({
        itemId: item.id,
        locationId,
        expectedQty: balance?.onHand.toString() ?? '0',
      });
    }
    const count = await this.stock.createCount(actor.tenantId, {
      warehouseId: dto.warehouseId,
      note: dto.note,
      createdByUserId: actor.userId,
      lines,
    });
    await this.auditWrite(actor, {
      action: 'inventory.count.create',
      resource: INVENTORY_AUDIT_RESOURCE.COUNT,
      resourceId: count.id,
      newValue: { warehouseId: dto.warehouseId, lineCount: lines.length },
    });
    return count;
  }

  async enterCountLine(
    actor: InventoryActor,
    countId: string,
    lineId: string,
    countedQty: number
  ): Promise<void> {
    const count = await this.stock.findCount(actor.tenantId, countId);
    if (!count) throw new NotFoundException('Stock count not found.');
    if (count.status !== 'OPEN') {
      throw new ConflictException(`Count is ${count.status}; entries are closed.`);
    }
    const line = count.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException('Count line not found.');
    const counted = quantityFromNumber(countedQty);
    const variance = addQuantity(counted, negateQuantity(line.expectedQty.toString()));
    const updated = await this.stock.enterCounted(undefined, actor.tenantId, countId, lineId, counted, variance);
    if (updated.count === 0) {
      throw new ConflictException('This line is already counted; a count entry is not editable — post a variance or start a recount.');
    }
  }

  /** POST: every non-zero variance becomes a COUNT_VARIANCE movement plus a
   * balance delta, inside one transaction; status flips OPEN→POSTED guarded. */
  async postCount(actor: InventoryActor, countId: string): Promise<StockCount> {
    const count = await this.stock.findCount(actor.tenantId, countId);
    if (!count) throw new NotFoundException('Stock count not found.');
    if (count.status !== 'OPEN') {
      throw new ConflictException(`Count is ${count.status}; only OPEN can be posted.`);
    }
    const uncounted = count.lines.filter((l) => l.countedQty === null);
    if (uncounted.length > 0) {
      throw new BadRequestException(`${uncounted.length} line(s) are not yet counted.`);
    }

    await this.uow.run(async (tx) => {
      for (const line of count.lines) {
        const variance = line.variance!.toString();
        if (isZeroQuantity(variance)) {
          await this.stock.markCountLinePosted(tx, actor.tenantId, line.id, null);
          continue;
        }
        const movement = await this.stock.appendMovement(tx, {
          tenantId: actor.tenantId,
          kind: 'COUNT_VARIANCE',
          itemId: line.itemId,
          warehouseId: count.warehouseId,
          locationId: line.locationId,
          quantity: variance,
          unit: line.item.baseUnit,
          baseQuantity: variance,
          sourceType: 'inventory.count',
          sourceId: line.id,
          note: `Stock count ${count.id}`,
          recordedByUserId: actor.userId,
        });
        const cell = {
          tenantId: actor.tenantId,
          itemId: line.itemId,
          warehouseId: count.warehouseId,
          locationId: line.locationId,
        };
        if (compareQuantity(variance, '0') < 0) {
          const decremented = await this.stock.subtractFromBalance(tx, cell, absQuantity(variance));
          if (decremented.count === 0) {
            throw new InsufficientStockError(line.itemId, count.warehouseId);
          }
        } else {
          await this.stock.addToBalance(tx, cell, variance);
        }
        await this.stock.markCountLinePosted(tx, actor.tenantId, line.id, movement.id);
      }
      const flipped = await this.stock.setCountStatus(tx, actor.tenantId, count.id, 'OPEN', {
        status: 'POSTED',
        postedByUserId: actor.userId,
        postedAt: new Date(),
      });
      if (flipped.count === 0) {
        throw new ConflictException('Count was concurrently posted; variances were not reposted.');
      }
    });
    await this.auditWrite(actor, {
      action: 'inventory.count.post',
      resource: INVENTORY_AUDIT_RESOURCE.COUNT,
      resourceId: count.id,
      oldValue: { status: 'OPEN' },
      newValue: { status: 'POSTED' },
    });
    return this.stock.findCount(actor.tenantId, countId) as Promise<StockCount>;
  }

  // -------------------------------------------------------------------------
  // READS
  // -------------------------------------------------------------------------

  listMovements(actor: InventoryActor, filters: Parameters<StockRepository['listMovements']>[1], page: number, pageSize: number) {
    return this.stock.listMovements(actor.tenantId, filters, page, pageSize);
  }

  async listBalances(
    actor: InventoryActor,
    filters: Parameters<StockRepository['listBalances']>[1],
    page: number,
    pageSize: number
  ) {
    const result = await this.stock.listBalances(actor.tenantId, filters, page, pageSize);
    return {
      ...result,
      items: result.items.map((row) => ({
        ...row,
        // THE AVAILABILITY CONTRACT, DEFINED ONCE: available = onHand - reserved - blocked.
        available: addQuantity(
          addQuantity(row.onHand.toString(), negateQuantity(row.reserved.toString())),
          negateQuantity(row.blocked.toString())
        ),
      })),
    };
  }

  listTransfers(actor: InventoryActor, filters: Parameters<StockRepository['listTransfers']>[1], page: number, pageSize: number) {
    return this.stock.listTransfers(actor.tenantId, filters, page, pageSize);
  }

  listIssues(actor: InventoryActor, filters: Parameters<StockRepository['listIssues']>[1], page: number, pageSize: number) {
    return this.stock.listIssues(actor.tenantId, filters, page, pageSize);
  }

  listAdjustments(actor: InventoryActor, filters: Parameters<StockRepository['listAdjustments']>[1], page: number, pageSize: number) {
    return this.stock.listAdjustments(actor.tenantId, filters, page, pageSize);
  }

  listCounts(actor: InventoryActor, filters: Parameters<StockRepository['listCounts']>[1], page: number, pageSize: number) {
    return this.stock.listCounts(actor.tenantId, filters, page, pageSize);
  }

  findTransfer(actor: InventoryActor, id: string) {
    return this.stock.findTransfer(actor.tenantId, id);
  }

  findCount(actor: InventoryActor, id: string) {
    return this.stock.findCount(actor.tenantId, id);
  }

  /**
   * RECONCILIATION: recomputes Σ ledger per balance cell and compares it with
   * the stored projection. The ledger is the truth; a drifted row is reported
   * with both figures, never silently corrected from a read.
   */
  async reconcile(actor: InventoryActor, warehouseId?: string) {
    const [sums, balances] = await Promise.all([
      this.stock.ledgerSums(actor.tenantId, warehouseId),
      this.stock.listAllBalances(actor.tenantId, warehouseId),
    ]);
    const cells = new Map<string, { itemId: string; warehouseId: string; locationId: string; ledger: string; stored: string }>();
    for (const s of sums) {
      cells.set(`${s.itemId}|${s.warehouseId}|${s.locationId}`, {
        itemId: s.itemId,
        warehouseId: s.warehouseId,
        locationId: s.locationId,
        ledger: s.sum,
        stored: '0',
      });
    }
    for (const b of balances) {
      const key = `${b.itemId}|${b.warehouseId}|${b.locationId}`;
      const cell = cells.get(key) ?? {
        itemId: b.itemId,
        warehouseId: b.warehouseId,
        locationId: b.locationId,
        ledger: '0',
        stored: '0',
      };
      cell.stored = b.onHand.toString();
      cells.set(key, cell);
    }
    const rows = [...cells.values()].map((cell) => ({
      ...cell,
      drift: addQuantity(cell.stored, negateQuantity(cell.ledger)),
      balanced: compareQuantity(cell.stored, cell.ledger) === 0,
    }));
    return {
      checked: rows.length,
      balanced: rows.filter((r) => r.balanced).length,
      drifted: rows.filter((r) => !r.balanced),
    };
  }
}
