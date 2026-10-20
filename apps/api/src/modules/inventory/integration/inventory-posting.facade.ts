import { Injectable } from '@nestjs/common';

import { InventoryActor } from '../inventory-actor';
import { ItemRepository } from '../item/item.repository';
import { StockService } from '../stock/stock.service';

/**
 * Phase W2-B: the ONLY surface Commerce may call into the Inventory context —
 * a narrow facade exported by `InventoryModule` so the posting contract lives
 * on the provider that owns the database it mutates.
 *
 * WHAT COMMERCE SUPPLIES: tenant, the inventory item id it resolved (or the
 * SKU it wants resolved), the destination cell, the quantity IN THE ITEM'S
 * declared unit vocabulary, and the opaque source reference
 * (`sourceType`, `sourceId`). Inventory owns conversion to base quantity, the
 * append-only ledger row, the balance effect, the tracking checks and the
 * idempotency unique — Commerce can ask but can never write.
 *
 * WHY A SYNCHRONOUS FACADE AND NOT A QUEUE: the two contexts run in one
 * process in this deployment; the durable at-least-once record already lives
 * on the Commerce side (`InventoryPosting`), so the facade only needs to be
 * deterministic and idempotent, not async.
 */

/** The parameters an integration posting carries — Commerce's contract shape. */
export interface InventoryPostingRequest {
  /** The source line's tenant — re-stated, never trusted blindly: the facade
   *  uses it to build the actor, and every repository predicate enforces it. */
  tenantId: string;
  /** The Commerce actor's user id — recorded on the movement and the audit row. */
  userId: string | null;
  itemId: string;
  warehouseId: string;
  locationId?: string;
  quantity: number;
  unit: string;
  lotNumber?: string;
  serialNumber?: string;
  expiryDate?: string;
  note?: string;
}

function integrationActor(tenantId: string, userId: string | null): InventoryActor {
  return {
    tenantId,
    userId,
    requestId: 'commerce-integration',
    ip: null,
    userAgent: null,
  };
}

@Injectable()
export class InventoryPostingFacade {
  constructor(
    private readonly stock: StockService,
    private readonly items: ItemRepository
  ) {}

  /**
   * Resolve a catalogue SKU to an inventory item id. `null` when the SKU is
   * unknown in this tenant — the caller maps that to a FAILED posting row,
   * which stays retryable because an item may be created later.
   */
  async resolveItemBySku(tenantId: string, sku: string): Promise<{ id: string } | null> {
    const item = await this.items.findBySku(tenantId, sku);
    return item ? { id: item.id } : null;
  }

  /** Inbound: a Commerce physical receipt. Ledger kind `RECEIPT`. */
  postReceiptPosting(params: InventoryPostingRequest & { sourceId: string }) {
    return this.stock.postReceipt(integrationActor(params.tenantId, params.userId), {
      itemId: params.itemId,
      warehouseId: params.warehouseId,
      locationId: params.locationId,
      quantity: params.quantity,
      unit: params.unit,
      sourceType: 'commerce.receipt',
      sourceId: params.sourceId,
      lotNumber: params.lotNumber,
      serialNumber: params.serialNumber,
      expiryDate: params.expiryDate,
      note: params.note,
    });
  }

  /**
   * Outbound: a compensating receipt line or a dispatched supplier return —
   * the caller names the honest kind (`ISSUE` for a quantity correction,
   * `SUPPLIER_RETURN` for goods going back to the supplier).
   */
  postOutboundPosting(
    params: InventoryPostingRequest & { kind: 'ISSUE' | 'SUPPLIER_RETURN'; sourceType: string; sourceId: string }
  ) {
    return this.stock.postOutbound(integrationActor(params.tenantId, params.userId), {
      itemId: params.itemId,
      warehouseId: params.warehouseId,
      locationId: params.locationId,
      quantity: params.quantity,
      unit: params.unit,
      kind: params.kind,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      lotNumber: params.lotNumber,
      serialNumber: params.serialNumber,
      note: params.note,
    });
  }
}
