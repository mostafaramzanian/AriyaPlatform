import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/inventory-client';
import type {
  StockBalance,
  StockCount,
  StockIssue,
  StockAdjustment,
  StockMovement,
  StockTransfer,
} from '../../../generated/inventory-client';
import { InventoryPrismaService } from '../database/inventory-prisma.service';
import type { InventoryTransactionHandle } from '../database/inventory-transaction';
import { unwrapInventoryTransaction } from '../database/inventory-transaction';

/**
 * Phase W1: the ONLY file that may issue Prisma statements for the stock
 * ledger, balances, transfers, issues, adjustments and counts.
 *
 * THE TWO ATOMIC SHAPES EVERY POSTER USES
 * ---------------------------------------
 *   Decrement: `updateMany({ where: { ...key, onHand: { gte: qty } } })` — the
 *     guard is INSIDE the predicate, so a concurrent decrement that already
 *     consumed the quantity leaves `count === 0` and the service answers 409.
 *     There is no read-then-write race for an over-issue to slip through.
 *   Increment: `upsert` the balance cell (create-on-miss, add-on-hit) — the
 *     first posting into a cell and a concurrent posting cannot produce two
 *     rows because the cell's composite key is the primary key.
 *
 * Every writer takes an `InventoryTransactionHandle` minted by
 * `InventoryUnitOfWork` — a movement and its balance effect commit together or
 * not at all. The ledger (`inventory_stock_movements`) is INSERT-ONLY: no
 * `update`/`delete` method for it exists in this file by design, and a
 * correction is a REVERSAL row plus the opposite balance delta.
 */
@Injectable()
export class StockRepository {
  constructor(private readonly prisma: InventoryPrismaService) {}

  private client(tx?: InventoryTransactionHandle) {
    return tx ? unwrapInventoryTransaction(tx) : this.prisma;
  }

  // -------------------------------------------------------------------------
  // READS
  // -------------------------------------------------------------------------

  findMovement(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).stockMovement.findFirst({ where: { tenantId, id } });
  }

  listMovements(
    tenantId: string,
    filters: {
      itemId?: string;
      warehouseId?: string;
      kind?: string;
      sourceType?: string;
      sourceId?: string;
    },
    page: number,
    pageSize: number
  ): Promise<{ items: StockMovement[]; total: number }> {
    const where: Prisma.StockMovementWhereInput = {
      tenantId,
      ...(filters.itemId ? { itemId: filters.itemId } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.kind ? { kind: filters.kind as StockMovement['kind'] } : {}),
      ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
      ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    };
    return Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: [{ postedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  listBalances(
    tenantId: string,
    filters: { itemId?: string; warehouseId?: string; search?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: StockBalance[]; total: number }> {
    const where: Prisma.StockBalanceWhereInput = {
      tenantId,
      ...(filters.itemId ? { itemId: filters.itemId } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.search
        ? {
            item: {
              OR: [
                { sku: { contains: filters.search, mode: 'insensitive' } },
                { name: { contains: filters.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    return Promise.all([
      this.prisma.stockBalance.findMany({
        where,
        orderBy: [{ warehouseId: 'asc' }, { itemId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockBalance.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  findBalance(
    tenantId: string,
    itemId: string,
    warehouseId: string,
    locationId: string,
    tx?: InventoryTransactionHandle
  ) {
    return this.client(tx).stockBalance.findUnique({
      where: {
        tenantId_itemId_warehouseId_locationId: {
          tenantId,
          itemId,
          warehouseId,
          locationId,
        },
      },
    });
  }

  /** Reconciliation: Σ ledger baseQuantity per balance cell, computed fresh. */
  async ledgerSums(
    tenantId: string,
    warehouseId?: string
  ): Promise<Array<{ itemId: string; warehouseId: string; locationId: string; sum: string }>> {
    const rows = await this.prisma.stockMovement.groupBy({
      by: ['itemId', 'warehouseId', 'locationId'],
      where: { tenantId, ...(warehouseId ? { warehouseId } : {}) },
      _sum: { baseQuantity: true },
    });
    return rows.map((r) => ({
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      locationId: r.locationId,
      sum: r._sum.baseQuantity?.toString() ?? '0',
    }));
  }

  listAllBalances(tenantId: string, warehouseId?: string): Promise<StockBalance[]> {
    return this.prisma.stockBalance.findMany({
      where: { tenantId, ...(warehouseId ? { warehouseId } : {}) },
    });
  }

  // -------------------------------------------------------------------------
  // THE LEDGER — insert-only
  // -------------------------------------------------------------------------

  /**
   * Appends ONE ledger row. The `(tenantId, sourceType, sourceId, kind)` unique
   * index makes a retried post a P2002 the service translates to 409 — the
   * second identical call can never produce a second movement.
   */
  appendMovement(
    tx: InventoryTransactionHandle | undefined,
    data: {
      tenantId: string;
      kind: StockMovement['kind'];
      itemId: string;
      warehouseId: string;
      locationId: string;
      quantity: string;
      unit: string;
      baseQuantity: string;
      lotNumber?: string | null;
      serialNumber?: string | null;
      expiryDate?: Date | null;
      sourceType: string;
      sourceId: string;
      reversesMovementId?: string | null;
      note?: string | null;
      recordedByUserId: string | null;
    }
  ): Promise<StockMovement> {
    return this.client(tx).stockMovement.create({
      data: {
        tenantId: data.tenantId,
        kind: data.kind,
        itemId: data.itemId,
        warehouseId: data.warehouseId,
        locationId: data.locationId,
        quantity: data.quantity,
        unit: data.unit,
        baseQuantity: data.baseQuantity,
        lotNumber: data.lotNumber ?? null,
        serialNumber: data.serialNumber ?? null,
        expiryDate: data.expiryDate ?? null,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        reversesMovementId: data.reversesMovementId ?? null,
        note: data.note ?? null,
        recordedByUserId: data.recordedByUserId ?? 'system',
      },
    });
  }

  /** +delta baseQuantity onto a balance cell (upsert). Inside tx. */
  addToBalance(
    tx: InventoryTransactionHandle,
    cell: { tenantId: string; itemId: string; warehouseId: string; locationId: string },
    delta: string
  ): Promise<StockBalance> {
    return this.client(tx).stockBalance.upsert({
      where: {
        tenantId_itemId_warehouseId_locationId: cell,
      },
      create: {
        ...cell,
        onHand: delta,
        reserved: '0',
        blocked: '0',
      },
      update: { onHand: { increment: new Prisma.Decimal(delta) } },
    });
  }

  /**
   * −delta from a balance cell, GUARDED: `onHand >= delta` lives inside the
   * update predicate. Returns the number of rows updated — `0` means the
   * available stock was not there (or a concurrent decrement won) and the
   * caller must refuse with 409.
   */
  subtractFromBalance(
    tx: InventoryTransactionHandle,
    cell: { tenantId: string; itemId: string; warehouseId: string; locationId: string },
    delta: string
  ) {
    return this.client(tx).stockBalance.updateMany({
      where: {
        tenantId: cell.tenantId,
        itemId: cell.itemId,
        warehouseId: cell.warehouseId,
        locationId: cell.locationId,
        onHand: { gte: new Prisma.Decimal(delta) },
      },
      data: { onHand: { decrement: new Prisma.Decimal(delta) } },
    });
  }

  /** −delta from a balance cell's BLOCKED quantity, guarded the same way. */
  subtractBlockedFromBalance(
    tx: InventoryTransactionHandle,
    cell: { tenantId: string; itemId: string; warehouseId: string; locationId: string },
    delta: string
  ) {
    return this.client(tx).stockBalance.updateMany({
      where: {
        tenantId: cell.tenantId,
        itemId: cell.itemId,
        warehouseId: cell.warehouseId,
        locationId: cell.locationId,
        blocked: { gte: new Prisma.Decimal(delta) },
      },
      data: { blocked: { decrement: new Prisma.Decimal(delta) } },
    });
  }

  // -------------------------------------------------------------------------
  // TRANSFERS
  // -------------------------------------------------------------------------

  createTransfer(
    tenantId: string,
    data: {
      itemId: string;
      quantity: string;
      unit: string;
      baseQuantity: string;
      lotNumber?: string | null;
      serialNumber?: string | null;
      fromWarehouseId: string;
      fromLocationId: string;
      toWarehouseId: string;
      toLocationId: string;
      note?: string | null;
      createdByUserId: string | null;
    }
  ): Promise<StockTransfer> {
    return this.prisma.stockTransfer.create({
      data: {
        tenantId,
        itemId: data.itemId,
        quantity: data.quantity,
        unit: data.unit,
        baseQuantity: data.baseQuantity,
        lotNumber: data.lotNumber ?? null,
        serialNumber: data.serialNumber ?? null,
        fromWarehouseId: data.fromWarehouseId,
        fromLocationId: data.fromLocationId,
        toWarehouseId: data.toWarehouseId,
        toLocationId: data.toLocationId,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? 'system',
      },
    });
  }

  findTransfer(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).stockTransfer.findFirst({ where: { tenantId, id } });
  }

  listTransfers(
    tenantId: string,
    filters: { status?: string; warehouseId?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: StockTransfer[]; total: number }> {
    const where: Prisma.StockTransferWhereInput = {
      tenantId,
      ...(filters.status ? { status: filters.status as StockTransfer['status'] } : {}),
      ...(filters.warehouseId
        ? {
            OR: [
              { fromWarehouseId: filters.warehouseId },
              { toWarehouseId: filters.warehouseId },
            ],
          }
        : {}),
    };
    return Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  /** A lifecycle write is guarded: `status` in the predicate makes the
   * transition atomic — a stale/duplicate act sees `count === 0`, not a flip. */
  setTransferStatus(
    tx: InventoryTransactionHandle,
    tenantId: string,
    id: string,
    expected: StockTransfer['status'],
    data: {
      status: StockTransfer['status'];
      dispatchedByUserId?: string | null;
      dispatchedAt?: Date;
      receivedByUserId?: string | null;
      receivedAt?: Date;
      cancelledAt?: Date;
    }
  ) {
    return this.client(tx).stockTransfer.updateMany({
      where: { tenantId, id, status: expected },
      data,
    });
  }

  // -------------------------------------------------------------------------
  // ISSUES / ADJUSTMENTS
  // -------------------------------------------------------------------------

  createIssue(
    tenantId: string,
    data: {
      itemId: string;
      warehouseId: string;
      locationId: string;
      quantity: string;
      unit: string;
      baseQuantity: string;
      issuedTo: string;
      lotNumber?: string | null;
      serialNumber?: string | null;
      note?: string | null;
      movementId?: string | null;
      createdByUserId: string | null;
    },
    tx?: InventoryTransactionHandle
  ): Promise<StockIssue> {
    return this.client(tx).stockIssue.create({
      data: {
        tenantId,
        itemId: data.itemId,
        warehouseId: data.warehouseId,
        locationId: data.locationId,
        quantity: data.quantity,
        unit: data.unit,
        baseQuantity: data.baseQuantity,
        issuedTo: data.issuedTo,
        lotNumber: data.lotNumber ?? null,
        serialNumber: data.serialNumber ?? null,
        note: data.note ?? null,
        movementId: data.movementId ?? null,
        createdByUserId: data.createdByUserId ?? 'system',
      },
    });
  }

  /** The issue row's link back to its ledger row, inside the same tx. */
  linkIssueMovement(
    tx: InventoryTransactionHandle | undefined,
    tenantId: string,
    issueId: string,
    movementId: string
  ) {
    return this.client(tx).stockIssue.updateMany({
      where: { tenantId, id: issueId },
      data: { movementId },
    });
  }

  linkAdjustmentMovement(
    tx: InventoryTransactionHandle | undefined,
    tenantId: string,
    adjustmentId: string,
    movementId: string
  ) {
    return this.client(tx).stockAdjustment.updateMany({
      where: { tenantId, id: adjustmentId },
      data: { movementId },
    });
  }

  listIssues(
    tenantId: string,
    filters: { warehouseId?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: StockIssue[]; total: number }> {
    const where: Prisma.StockIssueWhereInput = {
      tenantId,
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    };
    return Promise.all([
      this.prisma.stockIssue.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockIssue.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  createAdjustment(
    tenantId: string,
    data: {
      itemId: string;
      warehouseId: string;
      locationId: string;
      quantity: string;
      unit: string;
      baseQuantity: string;
      reason: StockAdjustment['reason'];
      note?: string | null;
      lotNumber?: string | null;
      serialNumber?: string | null;
      movementId?: string | null;
      createdByUserId: string | null;
    },
    tx?: InventoryTransactionHandle
  ): Promise<StockAdjustment> {
    return this.client(tx).stockAdjustment.create({
      data: {
        tenantId,
        itemId: data.itemId,
        warehouseId: data.warehouseId,
        locationId: data.locationId,
        quantity: data.quantity,
        unit: data.unit,
        baseQuantity: data.baseQuantity,
        reason: data.reason,
        note: data.note ?? null,
        lotNumber: data.lotNumber ?? null,
        serialNumber: data.serialNumber ?? null,
        movementId: data.movementId ?? null,
        createdByUserId: data.createdByUserId ?? 'system',
      },
    });
  }

  listAdjustments(
    tenantId: string,
    filters: { warehouseId?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: StockAdjustment[]; total: number }> {
    const where: Prisma.StockAdjustmentWhereInput = {
      tenantId,
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    };
    return Promise.all([
      this.prisma.stockAdjustment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockAdjustment.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  // -------------------------------------------------------------------------
  // STOCK COUNTS
  // -------------------------------------------------------------------------

  createCount(
    tenantId: string,
    data: {
      warehouseId: string;
      note?: string | null;
      createdByUserId: string | null;
      lines: Array<{
        itemId: string;
        locationId: string;
        expectedQty: string;
      }>;
    }
  ) {
    return this.prisma.stockCount.create({
      data: {
        tenantId,
        warehouseId: data.warehouseId,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? 'system',
        lines: {
          create: data.lines.map((line) => ({
            // tenantId comes from the parent relation, not the nested payload —
            // the same rule the payment-plan repository hit earlier.
            itemId: line.itemId,
            locationId: line.locationId,
            expectedQty: line.expectedQty,
          })),
        },
      },
      include: { lines: { include: { item: true } } },
    });
  }

  findCount(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).stockCount.findFirst({
      where: { tenantId, id },
      include: { lines: { include: { item: true } } },
    });
  }

  listCounts(
    tenantId: string,
    filters: { warehouseId?: string; status?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: StockCount[]; total: number }> {
    const where: Prisma.StockCountWhereInput = {
      tenantId,
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.status ? { status: filters.status as StockCount['status'] } : {}),
    };
    return Promise.all([
      this.prisma.stockCount.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockCount.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  enterCounted(
    tx: InventoryTransactionHandle | undefined,
    tenantId: string,
    countId: string,
    lineId: string,
    countedQty: string,
    variance: string
  ) {
    return this.client(tx).stockCountLine.updateMany({
      where: { tenantId, countId, id: lineId, countedQty: null },
      data: { countedQty, variance },
    });
  }

  markCountLinePosted(
    tx: InventoryTransactionHandle,
    tenantId: string,
    lineId: string,
    movementId: string | null
  ) {
    return this.client(tx).stockCountLine.updateMany({
      where: { tenantId, id: lineId },
      data: { movementId },
    });
  }

  setCountStatus(
    tx: InventoryTransactionHandle,
    tenantId: string,
    id: string,
    expected: StockCount['status'],
    data: { status: StockCount['status']; postedByUserId?: string | null; postedAt?: Date }
  ) {
    return this.client(tx).stockCount.updateMany({
      where: { tenantId, id, status: expected },
      data,
    });
  }
}
