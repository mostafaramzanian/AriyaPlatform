/**
 * Phase PRODUCTION-BOM-HEADER: the Production module's own constants.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The values below are shared across files that CANNOT import each other: the module id
 * must agree between Production's controller decorators, the Core provisioning
 * migration's SQL and the platform's registry rows — none of which live under
 * `src/modules/production/**`. Declaring them once here is what stops "the migration
 * seeds `production` but the controller asks for `Production`" from becoming a `403`
 * that names a module nobody can find.
 *
 * This is `commerce.constants.ts`'s shape, adopted rather than reinvented — and
 * `hr.constants.ts` holds `HR_MODULE_ID` for exactly the same reason.
 */

/**
 * The module's CANONICAL ID — `production` — as the platform's registry knows it
 * (`core_db."ModuleRegistration".moduleId`).
 *
 * THE ID IS DECLARED HERE, ENTITLEMENT IS NOT DECIDED HERE. Production *declares* the
 * requirement; the answer to "is this tenant entitled?" belongs to the platform's
 * `ModuleEntitlementGuard`. The id appears in places that must never drift apart — the
 * `@RequiresModule(...)` decorator, the `ModuleRegistration` row the Core provisioning
 * migration inserts, and the `ModuleFeature` rows that hang off it — so it is a
 * constant, and the entitlement gate reads the migration's SQL as TEXT and compares it
 * against this value, precisely because the two files cannot import each other.
 */
export const PRODUCTION_MODULE_ID = 'production';

/**
 * The FEATURE ids Production declares, as a frozen record. ONE member today.
 *
 * `bom` is the capability this phase ships: the BOM HEADER aggregate — create it,
 * route it, decide it, with tenant isolation, authorization and audit. Items, code
 * generation and Purchase consumption are LATER phases and deliberately do NOT appear
 * here: within an entitled tenant they are a question of WHO may act (the permissions
 * below), not of whether the tenant holds the capability at all, and a feature that can
 * be withheld independently of the BOM would let a tenant hold BOMs nobody may govern.
 *
 * A feature id is a slug, scoped by the module: `production` + `bom`, never a bare
 * `bom`.
 */
export const PRODUCTION_FEATURE = {
  BOM: 'bom',
} as const;

/**
 * The audit `resource` string for every Production row that is audited.
 *
 * Audit rows are written by `ProductionAuditGateway` through `AUDIT_PORT` into
 * `core_db."AuditLog"`. Production keeps NO audit table of its own — a second trail per
 * module would make "who did what, when" unanswerable — so these constants are the
 * `resource` column values of the ONE platform trail: a query for Production actions is
 * a query on `resource` rather than on a string that has to be grepped for.
 *
 * ONE MEMBER PER AGGREGATE, because each aggregate is a different row with a different
 * identity and a different lifetime: collapsing them would make "who changed this header?"
 * require filtering item acts out of the trail, and vice versa. The BOM HEADER's six events
 * write `production.bom`; the BOM ITEM's three write `production.bom.item`; the BOM CHANGE
 * REQUEST's nine write `production.bom.change`. `.` is the separator because a resource
 * here is `<module>.<aggregate>` — never a bare `bom` that could collide with some other
 * module's identically named row.
 *
 * WHY THE CHANGE REQUEST IS ONE RESOURCE INCLUDING ITS DETAIL ACTS, WHEREAS THE BOM IS NOT.
 * -------------------------------------------------------------------------------------
 * `production.bom` and `production.bom.item` are split because a BOM ITEM is its own
 * aggregate with its own identity and lifetime — the item contract states it. A change
 * request's detail rows are a BOUNDED PART of the request: they have no status of their
 * own, they cannot exist outside one, and the brief requires the request's timeline to
 * carry `add_item` / `update_item` / `remove_item`. Correlating those to the request would
 * otherwise need a `resourceId` the read contract cannot filter on (the same structural
 * wall `PHASE-PRODUCTION-BOM-AUDIT-TIMELINE-IMPLEMENTATION.md` records for the BOM's item
 * events), so ALL NINE families carry `resourceId = <change request id>` and the detail's
 * own id travels inside `newValue` / `changedFields`.
 */
export const PRODUCTION_AUDIT_RESOURCE = {
  BOM: 'production.bom',
  BOM_ITEM: 'production.bom.item',
  BOM_CHANGE_REQUEST: 'production.bom.change',
} as const;

/**
 * The page ceiling of every Production list route, and the size an unstated `pageSize`
 * resolves to.
 *
 * The value is the same shape HR and Commerce use (`HR_MAX_PAGE_SIZE` /
 * `COMMERCE_MAX_PAGE_SIZE`): three bounded contexts that answer "how big may a page be?"
 * differently make the answer depend on which route a client happens to call.
 *
 * TWO BOUNDS, DELIBERATELY. The DTO enforces the ceiling as a CONTRACT (an absurd
 * `pageSize` is a 400 with a field error, not a silent clamp) and the service clamps
 * with `Math.min` as the GUARANTEE (an internal caller that builds a query object itself
 * cannot exceed it either). Neither replaces the other.
 *
 * These are pagination limits, not permissions and not entitlement: what a caller may
 * READ is decided by `production.bom.read` and the entitlement gate, never by how many
 * rows fit on a page.
 */
export const PRODUCTION_MAX_PAGE_SIZE = 100;

/** The page size a Production list route uses when the caller states none. */
export const PRODUCTION_DEFAULT_PAGE_SIZE = 20;
