import { Injectable } from '@nestjs/common';
import { PurchaseRepository } from '../purchase/purchase.repository';

/**
 * PHASE W2-C — the Commerce side of Financial's `PurchaseOrderReferencePort`.
 *
 * WHY A FACADE AND NOT AN ADAPTER IN FINANCIAL: Financial's own isolation
 * contract forbids it from importing anything under `modules/commerce/**`, and
 * Commerce's isolation contract forbids any file here from importing Financial's
 * port type — so neither side may name the other's file. The binding lives in a
 * NEUTRAL bridge module (`modules/purchase-order-reference/`) that imports this
 * module's exported facade and Financial's port token; the facade's signature is
 * STRUCTURALLY the port's `resolve`, so the bridge needs no translation layer.
 *
 * WHAT ONE RESOLUTION ANSWERS — the two facts the source form actually read
 * (the order exists, the project it belongs to) plus an opaque display name:
 *   * `orderReference` — the caller's reference, echoed verbatim;
 *   * `projectReference` — `null`, always: `PurchaseDocument` owns no project
 *     column today, and inventing a derived one here would fabricate a fact the
 *     bounded context never stored. When a real project link lands this field
 *     fills from it, not before;
 *   * `displayName` — the issued `documentNumber`, the document's own display
 *     identity.
 *
 * TENANT IS A PARAMETER, not ambient state: the caller holds the request actor,
 * so the tenant travels explicitly and this method can never be asked for
 * another tenant's order. A reference this tenant does not hold resolves to
 * `null` — indistinguishable from an absent order.
 */
export interface PurchaseOrderReferenceResolution {
  orderReference: string;
  projectReference: string | null;
  displayName: string | null;
}

@Injectable()
export class CommerceOrderReferenceFacade {
  constructor(private readonly purchases: PurchaseRepository) {}

  async resolve(
    tenantId: string,
    orderReference: string
  ): Promise<PurchaseOrderReferenceResolution | null> {
    const row = await this.purchases.findOrderReference(tenantId, orderReference);
    if (!row) return null;
    return {
      orderReference,
      projectReference: null,
      displayName: row.documentNumber,
    };
  }
}
