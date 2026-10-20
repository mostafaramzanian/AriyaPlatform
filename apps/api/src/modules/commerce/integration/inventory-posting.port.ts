import type { InventoryPostingRequest } from '../../inventory/integration/inventory-posting.facade';
import type { StockMovement } from '../../inventory/stock/stock-types';

/**
 * Phase W2-B: the port Commerce binds to the Inventory context.
 *
 * ONE-WAY, and deliberately minimal: Commerce states WHAT posted (kind +
 * source line id) and the integration service supplies the mapped item, cell,
 * quantity and unit. Inventory owns the ledger append, the balance effect,
 * the tracking checks and the `(sourceType, sourceId, kind)` idempotency —
 * this port can never reach a balance or a movement row directly.
 *
 * TYPE IMPORTS ACROSS THE BOUNDARY: the request shape and the movement view
 * are inventory's PLAIN type mirrors (not generated-client classes and not
 * Prisma services). The isolation tests still forbid importing inventory's
 * Prisma client or services.
 */
export const INVENTORY_POSTING_PORT = 'InventoryPostingPort';

export interface InventoryPostingPort {
  /** SKU → item id, or null when the tenant has no such stocked item. */
  resolveItemBySku(tenantId: string, sku: string): Promise<{ id: string } | null>;

  /** Ledger `RECEIPT` for a physical receipt line. */
  postReceiptPosting(
    params: InventoryPostingRequest & { sourceId: string }
  ): Promise<StockMovement>;

  /** Ledger outbound for a compensation (`ISSUE`) or dispatch (`SUPPLIER_RETURN`). */
  postOutboundPosting(
    params: InventoryPostingRequest & {
      kind: 'ISSUE' | 'SUPPLIER_RETURN';
      sourceType: string;
      sourceId: string;
    }
  ): Promise<StockMovement>;
}
