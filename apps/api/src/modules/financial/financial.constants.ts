/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial module's own constants.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The values below are shared across files that CANNOT import each other: the module id
 * must agree between Financial's controller decorators, the Core provisioning migration's
 * SQL and the platform's registry rows — none of which live under
 * `src/modules/financial/**`. Declaring them once here is what stops "the migration seeds
 * `financial` but the controller asks for `Financial`" from becoming a `403` that names a
 * module nobody can find.
 *
 * This is `production.constants.ts`'s shape, adopted rather than reinvented — and
 * `commerce.constants.ts` and `hr.constants.ts` hold theirs for exactly the same reason.
 */

/**
 * The module's CANONICAL ID — `financial` — as the platform's registry knows it
 * (`core_db."ModuleRegistration".moduleId`).
 *
 * THE ID IS DECLARED HERE, ENTITLEMENT IS NOT DECIDED HERE. Financial *declares* the
 * requirement; the answer to "is this tenant entitled?" belongs to the platform's
 * `ModuleEntitlementGuard`. The id appears in places that must never drift apart — the
 * `@RequiresModule(...)` decorator, the `ModuleRegistration` row the Core provisioning
 * migration inserts, and the `ModuleFeature` rows that hang off it — so it is a constant.
 */
export const FINANCIAL_MODULE_ID = 'financial';

/**
 * The FEATURE ids Financial declares, as a frozen record. ONE member today.
 *
 * `check-request` is the capability this phase ships: the CheckRequest aggregate —
 * create it, submit it, let the manager decide it, with tenant isolation, authorization,
 * a timeline and request-stage attachments. Allocation, document review, executive
 * approval, issuance and delivery are LATER phases and deliberately do NOT appear here:
 * states 3..7 are not implemented at all in F1, so a feature that could be withheld
 * independently of the request would describe a capability this module does not have.
 *
 * A feature id is a slug, scoped by the module: `financial` + `check-request`, never a
 * bare `check-request`.
 */
export const FINANCIAL_FEATURE = {
  CHECK_REQUEST: 'check-request',
} as const;

/**
 * The audit `resource` string for the Financial rows this phase audits.
 *
 * Audit rows are written by `FinancialAuditGateway` through `AUDIT_PORT` into
 * `core_db."AuditLog"`. Financial keeps NO audit table of its own — a second trail per
 * module would make "who did what, when" unanswerable — so these constants are the
 * `resource` column values of the ONE platform trail.
 *
 * ONE MEMBER PER AGGREGATE, and `financial.check-request` is the ONLY member because the
 * request is the only aggregate this phase owns. The attachments are a BOUNDED PART of
 * the request (they have no status of their own and cannot exist outside one — the same
 * reasoning `production.bom.change` records for its detail rows), so their events carry
 * `resourceId = <request id>` and the attachment's own id travels inside
 * `oldValue`/`newValue`. Splitting them would need a `resourceId` the timeline route
 * cannot correlate on, which would make a request's own document history unreachable.
 */
export const FINANCIAL_AUDIT_RESOURCE = {
  CHECK_REQUEST: 'financial.check-request',
} as const;

/**
 * The page ceiling of every Financial list route, and the size an unstated `pageSize`
 * resolves to.
 *
 * The value is the same shape HR, Commerce and Production use: three bounded contexts
 * that answer "how big may a page be?" differently would make the answer depend on which
 * route a client happens to call.
 *
 * TWO BOUNDS, DELIBERATELY. The DTO enforces the ceiling as a CONTRACT (an absurd
 * `pageSize` is a 400 with a field error, not a silent clamp) and the service clamps with
 * `Math.min` as the GUARANTEE (an internal caller that builds a query object itself
 * cannot exceed it either).
 */
export const FINANCIAL_MAX_PAGE_SIZE = 100;

/** The page size a Financial list route uses when the caller states none. */
export const FINANCIAL_DEFAULT_PAGE_SIZE = 20;

/**
 * The source's `Section` value for REQUEST-stage documents (Preflight §9.1):
 * `ListQuery1` filtered «پیوست ها» by `IdSodoorCheck = <request>` AND `Section = 2`.
 * F1 writes this and only this; sections 6 (cheque image) and 7 (delivery receipt)
 * belong to deferred stages and must not be reachable.
 */
export const FINANCIAL_REQUEST_ATTACHMENT_SECTION = 2;

/** Hard upload ceiling for one attachment. Identical to the 49F/50 contract. */
export const FINANCIAL_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
