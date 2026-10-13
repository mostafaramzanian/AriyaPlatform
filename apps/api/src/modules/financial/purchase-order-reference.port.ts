/**
 * Phase F1 — FINANCIAL FOUNDATION: the FUTURE Purchase Order reference seam, declared as
 * an INTERFACE ONLY.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS ONLY A DECLARATION
 * -------------------------------------------------------------
 * The source's request form resolved a purchase ORDER at creation: `c_IdShomareSefaresh`
 * carried an order id, the form loaded the order, read `NameProjeKala` from the linked
 * project and stamped both the project and a title from it (Preflight §18). That is a
 * READ-ONLY LOOKUP, and Preflight §18.1 records it as a **Future Contract Requirement** —
 * the Commerce module owns purchase documents, and its tables, client and repositories are
 * unreachable from Financial BY DESIGN (no cross-database FK, no second Prisma client
 * import, no direct query).
 *
 * WHAT F1 DOES INSTEAD: `CheckRequest.orderReference` is an OPAQUE string (the wire
 * field, the column) and NOTHING resolves it. This interface exists so the future
 * integration has a named seam to implement — one method, one direction — instead of
 * being invented later from whatever the first caller happens to need.
 *
 * WHAT F1 DELIBERATELY DOES NOT CREATE (the brief §6 forbids all of it):
 *   * NO adapter — there is no `PurchaseOrderReferenceAdapter` anywhere in this module;
 *   * NO binding — nothing in `FinancialModule` provides `PURCHASE_ORDER_REFERENCE_PORT`,
 *     so no service can inject it: an unbound token fails DI loudly rather than silently
 *     reaching a stub;
 *   * NO network call, NO HTTP client, NO Commerce Prisma import, NO mock presented as a
 *     production dependency.
 *
 * The interface itself must not grow a business rule either: no title derivation, no
 * project-name formatting, no caching policy — those are decisions for the phase that
 * actually has the Purchase contract, and baking them in here would make THIS file a
 * contract nobody has ratified.
 */

/** DI token for the port. Declared, deliberately UNBOUND in F1. */
export const PURCHASE_ORDER_REFERENCE_PORT = 'PurchaseOrderReferencePort';

/**
 * What a future resolution WOULD answer about one opaque order reference.
 *
 * The shape is deliberately minimal — the two facts the source actually used (an order
 * exists, and the project it belongs to) plus an opaque display name — and it carries no
 * amounts, no lines, no supplier and no lifecycle: none of those was read by the source
 * form, and a wider projection would be a business model invented here rather than
 * agreed in the Purchase contract.
 */
export interface PurchaseOrderReferenceResolution {
  /** The opaque order reference that was resolved, echoed back. */
  orderReference: string;
  /** The order's project reference, when the order carries one. */
  projectReference: string | null;
  /** A human-readable order name, when the Purchase contract offers one. */
  displayName: string | null;
}

/**
 * The one question a future phase may ask.
 *
 * `resolve` is tenant-scoped by CONSTRUCTION: the implementation the future phase writes
 * will read the tenant from the same request context every other platform port uses, so
 * this signature cannot be asked for another tenant's order. It is async because any
 * real implementation is, and returning `null` — not throwing — is reserved for "this
 * tenant has no such order", mirroring `UserDirectoryContract.findTenantMember`.
 */
export interface PurchaseOrderReferencePort {
  resolve(orderReference: string): Promise<PurchaseOrderReferenceResolution | null>;
}
