import { randomUUID } from 'crypto';
import type { InventoryPostingPort } from '../../src/modules/commerce/integration/inventory-posting.port';
import type { InventoryPostingRequest } from '../../src/modules/inventory/integration/inventory-posting.facade';
import type { StockMovement } from '../../src/modules/inventory/stock/stock-types';

/**
 * In-memory double for the Commerce→Inventory posting seam.
 *
 * The e2e commerce harnesses wire the REAL `InventoryPostingRepository` and
 * `InventoryIntegrationService`, so the durable `InventoryPosting` state
 * machine (PENDING → POSTED/FAILED) is exercised against the real commerce
 * database; only Inventory's ledger append — which lives behind this port in
 * production (`InventoryPostingFacade`, bound through `InventoryModule`) — is
 * faked here, because inventory_db is a different owner and the posting
 * contract, not the ledger, is what these suites verify.
 */
export interface RecordedPostingCall {
  readonly method: 'postReceiptPosting' | 'postOutboundPosting';
  readonly params: InventoryPostingRequest & { sourceId: string };
}

export function createFakeInventoryPostingPort(): InventoryPostingPort & {
  calls: RecordedPostingCall[];
  reset(): void;
} {
  const calls: RecordedPostingCall[] = [];
  // `InventoryPosting.itemId`/`movementId` are @db.Uuid columns — the ids this
  // double returns must be real UUIDs or the marking write itself fails and the
  // posting lands FAILED for a reason that exists only in the test.
  return {
    calls,
    reset(): void {
      calls.length = 0;
    },
    async resolveItemBySku() {
      return { id: randomUUID() };
    },
    async postReceiptPosting(
      params: InventoryPostingRequest & { sourceId: string }
    ): Promise<StockMovement> {
      calls.push({ method: 'postReceiptPosting', params });
      return { id: randomUUID() } as StockMovement;
    },
    async postOutboundPosting(
      params: InventoryPostingRequest & {
        kind: 'ISSUE' | 'SUPPLIER_RETURN';
        sourceType: string;
        sourceId: string;
      }
    ): Promise<StockMovement> {
      calls.push({ method: 'postOutboundPosting', params });
      return { id: randomUUID() } as StockMovement;
    },
  };
}
