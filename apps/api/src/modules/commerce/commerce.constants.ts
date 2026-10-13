/**
 * Phase C1: the Commerce module's own constants.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The values below are shared across files that CANNOT import each other: the module
 * id must agree between Commerce's controller decorators, the Core provisioning
 * migration's SQL and the platform's registry rows — none of which live under
 * `src/modules/commerce/**`. Declaring them once here is what stops "the migration
 * seeds `commerce` but the controller asks for `Commerce`" from becoming a `403` that
 * names a module nobody can find, and it is what the isolation suite reads instead of
 * re-typing. The same reasoning, verbatim, is why `hr.constants.ts` holds
 * `HR_MODULE_ID` rather than a literal on each controller.
 */

/**
 * The module's CANONICAL ID — `commerce` — as the platform's registry knows it
 * (`core_db."ModuleRegistration".moduleId`).
 *
 * WHY IT IS A CONSTANT AND NOT A LITERAL ON EACH CONTROLLER. The id appears in
 * places that must never drift apart: the module-requirement decorator each Commerce
 * controller carries at the boundary, the `ModuleRegistration` row the Core
 * provisioning migration inserts, and the `ModuleFeature` rows that hang off it
 * (`ModuleFeature.moduleId`). The failure mode of a literal is specific and
 * expensive — a renamed string on one side refuses a module that is working in
 * production, with a `403` that names a module id. The isolation gate reads the
 * provisioning migration's SQL as TEXT and compares it against this constant,
 * precisely because the two files cannot import each other across the
 * Core/Commerce boundary.
 *
 * Commerce *declares* this id; it does not decide entitlement with it. The answer to
 * "is this tenant entitled?" belongs to the platform's own entitlement guard, provided
 * at the module boundary, never to this module's application layer.
 */
export const COMMERCE_MODULE_ID = 'commerce';

/**
 * The FEATURE ids Commerce declares, as a frozen record.
 *
 * ONE member today. The feature level is the one that can be granted per tenant
 * (`ModuleFeature` / `ModuleFeatureGrant`), so this record is the list of things an
 * operator can grant, switch off or withhold independently of the module as a whole.
 * `PURCHASE` is the procurement capability C1 ships end to end — a purchase document
 * through its configured workflow to completion, with payment, receiving and return
 * history attached — the smallest surface that is honestly a *feature* rather than a
 * route.
 *
 * Workflow and commercial CONFIGURATION deliberately do NOT appear here: within an
 * entitled tenant they are a question of WHO may act (§10 permissions), not of
 * whether the tenant has the capability at all, and splitting them into features
 * would let a tenant hold purchases nobody is able to govern.
 *
 * A feature id is a slug, and it is scoped by the module: `commerce` + `purchase`,
 * never a bare `purchase`.
 */
export const COMMERCE_FEATURE = {
  PURCHASE: 'purchase',
} as const;

/**
 * The audit `resource` string for every Commerce row that is audited.
 *
 * Audit rows are written by `CommerceAuditGateway` through `AUDIT_PORT` into
 * `core_db."AuditLog"` (§12). Commerce keeps NO audit TRAIL of its own — a second
 * trail per module would make "who did what, when" unanswerable — so these constants
 * are the `resource` column values of the ONE platform trail: a query for Commerce
 * actions is a query on `resource` rather than on a string that has to be grepped
 * for. Services pass a member of this record to the gateway; a resource string typed
 * inline in a service is a defect, because the vocabulary then lives in two places
 * and the trail splits silently.
 */
export const COMMERCE_AUDIT_RESOURCE = {
  /**
   * The purchase document itself (§5.1) — the subject every business act is asked
   * about: "who submitted / decided / cancelled / closed THIS purchase?". Workflow
   * DECISIONS are audited HERE rather than against their step-instance rows, for the
   * reason HR audits `hr.leave` and not its approval-step rows: the operator's
   * question names the document, and the step rows remain the mechanics that answer
   * HOW it was decided. Commercial acts that address the document ride on this
   * resource for the same reason. The rule behind both: `resource_id` names the row
   * the act addressed — a commercial entity that gains its own row identity earns
   * its own resource when that surface ships, declared HERE and nowhere else.
   */
  PURCHASE_DOCUMENT: 'commerce.purchase_document',
  /**
   * The workflow CONFIGURATION container (`WorkflowDefinition`, §5.5).
   *
   * A SEPARATE RESOURCE FROM ITS VERSIONS, for the reason HR keeps
   * `hr.leave_policy` separate from `hr.leave_policy_version`: creating or renaming
   * a container is an administrative act with no rules in it, while authoring,
   * validating, publishing and archiving a VERSION are the acts that decide what
   * purchases are governed by. An operator asking "who put this flow in force?" must
   * not have to filter out "somebody renamed a container on Tuesday" — and one
   * `resource_id` can name only one row, so sharing a string would make the trail
   * ambiguous about which row an act addressed.
   */
  WORKFLOW_DEFINITION: 'commerce.workflow_definition',
  /**
   * One workflow version's own lifecycle (`WorkflowDefinitionVersion`, §5.5) —
   * authoring, validate, publish, archive. Published versions are immutable, so the
   * audit trail is the only place a version's history lives.
   */
  WORKFLOW_DEFINITION_VERSION: 'commerce.workflow_definition_version',
  /**
   * One payment event (`PaymentRecord`, §5.14). Payment history is append-only and
   * settled rows are never rewritten: a correction is a compensating ROW, so each
   * event is its own audited act against its own `resource_id`.
   */
  PAYMENT_RECORD: 'commerce.payment_record',
  /**
   * One receiving event (`Receipt`, §5.16) — append-only evidence of actual received
   * quantity, which is what a dispute over over-receipt is answered from.
   */
  RECEIPT: 'commerce.receipt',
  /**
   * The return document (`ReturnDocument`, §5.17) — the return's OWN lifecycle,
   * kept apart from the purchase it originated from because a return must never
   * erase or rewrite the parent's history. Refunds themselves are payment rows and
   * are audited as `PAYMENT_RECORD`.
   */
  RETURN_DOCUMENT: 'commerce.return_document',
  /**
   * A commercial group (`CommercialGroup`, step P/P2) — the tenant-local row
   * that groups commercial responsibility and holds the configured liaison.
   * It earns its OWN resource because it has its own row identity and its own
   * audited acts (`created`, `updated`, `liaison_changed`): an operator asking
   * "who changed this group's liaison?" must not have to filter purchase acts.
   */
  COMMERCIAL_GROUP: 'commerce.commercial_group',
  /**
   * One commercial policy version (`CommercialConfigurationVersion`, step P).
   * Separate from the group for the reason workflow definitions are separate
   * from their versions: authoring, validating, publishing and archiving a
   * version are the acts that decide what purchases are governed by, and one
   * `resource_id` can name only one row.
   */
  COMMERCIAL_CONFIGURATION_VERSION: 'commerce.commercial_configuration_version',
  /**
   * The CURRENT assignment row of one line (`CommercialAssignment`, step P) —
   * `assigned` / `reassigned` are acts against the current row, while the
   * append-only history rows they produced are the record of HOW the row got
   * there (no second audit trail is created for them, §12).
   */
  COMMERCIAL_ASSIGNMENT: 'commerce.commercial_assignment',
  /**
   * One commercial approval decision (`CommercialApproval`, step P): who
   * decided a line's commercial outcome, when and with what comment. Its own
   * resource because the decision addresses THIS record, not the document.
   */
  COMMERCIAL_APPROVAL: 'commerce.commercial_approval',
  /**
   * PHASE C4-R (GAP-3): one purchase completion policy version
   * (`PurchaseCompletionPolicyVersion`) — authoring, editing, validating, publishing and
   * archiving the configuration that decides WHEN a purchase may be completed. Separate
   * from the document for the reason the commercial version is separate from its groups:
   * one `resource_id` names one row, and "who published the policy that completed this
   * purchase?" must be answerable without filtering document acts.
   *
   * The COMPLETION ACT itself is audited as `PURCHASE_DOCUMENT` — it is an act on the
   * document, recorded beside `create`/`update`/`submit`, and a second resource for the
   * same row would split one document's trail in two.
   */
  PURCHASE_COMPLETION_POLICY_VERSION: 'commerce.purchase_completion_policy_version',
} as const;

/**
 * The page ceiling of every Commerce list route, and the size an unstated
 * `pageSize` resolves to.
 *
 * WHY THE CEILING IS A MODULE CONSTANT AND NOT A LITERAL PER DTO. Steps L
 * through S each expose a list, and a bound re-typed beside each one is how the
 * fifth list ends up accepting `pageSize=100000` and reading a tenant's whole
 * purchase history in one request. The value is the same shape HR uses
 * (`HR_MAX_PAGE_SIZE` / `HR_DEFAULT_PAGE_SIZE`), because two bounded contexts
 * that answer "how big may a page be?" differently make the answer depend on
 * which route a client happens to call.
 *
 * TWO BOUNDS, DELIBERATELY. A DTO enforces the ceiling as a CONTRACT (an
 * absurd `pageSize` is a 400 with a field error, not a silent clamp), and the
 * service clamps with `Math.min` as the GUARANTEE (an internal caller that
 * builds a query object itself cannot exceed it either). Neither replaces the
 * other: only the DTO can tell a client it asked for something wrong, and only
 * the clamp covers the callers that never went through the DTO.
 *
 * These are pagination limits, not permissions and not entitlement: what a
 * caller may READ is decided by `commerce.read` and the entitlement gate, never
 * by how many rows fit on a page.
 */
export const COMMERCE_MAX_PAGE_SIZE = 100;

/** The page size a list route uses when the caller states none. */
export const COMMERCE_DEFAULT_PAGE_SIZE = 20;
