/**
 * PHASE C1, STEP T — ARCHITECTURE ISOLATION (the A→S boundary, made falsifiable).
 *
 * Steps M–S each shipped one slice of the Commerce bounded context and each proved its
 * own slice's contract. This suite proves the thing none of them could prove alone: that
 * the whole context still sits behind ONE authentication/authorization gate, on ONE
 * database, reached through ONE set of repositories, with no way for one slice to write
 * another slice's models.
 *
 * WHAT IS PINNED HERE, and the failure each group refuses:
 *
 *   A. THE ENTRY POINT (step L's gate, re-read from the file system)
 *      Every Commerce controller is discovered, not listed: the set on disk, the set the
 *      module registers and the set of classes declared must be the same ten. Each must
 *      carry the chain `@Controller` → `@RequiresModule` → `@RequiresFeature` →
 *      `@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)`, and its routes
 *      must be exactly the pinned surface, one `@Roles(...)` per route, drawn from the five
 *      named permissions the catalogue defines — so a route added without a role fails even
 *      though every sibling still passes. No route may carry the other guard family's
 *      `@Permissions(…)`, none may be `@Public()`, and every handler must resolve its actor
 *      from the SESSION (`resolveCommerceActor(req)`) instead of trusting a field of the
 *      request body, query or params.
 *
 *   B. THE DATABASE (the twelve applied migrations, re-read from the file system)
 *      Nothing in the history may DROP, TRUNCATE, DELETE, ALTER a column, RENAME, or
 *      SET NOT NULL: the history is ADDITIVE. Every ALTER TABLE is an ADD COLUMN or an
 *      ADD CONSTRAINT, and both are counted. All twenty-five tables lead with `tenant_id`,
 *      and so do all seventy-three indexes. All twenty-seven foreign keys are the composite pair
 *      `(tenant_id, …) → (tenant_id, id)` with ON DELETE RESTRICT, every target is a table
 *      this database created and exposes a unique `(tenant_id, id)` key for, and no
 *      statement reaches outside it: no extension, no foreign table, no dblink, and no
 *      reference to core_db or hr_db. The isolation is physical, not conventional.
 *
 *   C. THE SCHEMA (the join between `schema.prisma` and the migrations, BOTH directions)
 *      Every model maps to a created table and every created table is a mapped model;
 *      every enum's members equal the members its `CREATE TYPE` declares plus the ONE
 *      `ALTER TYPE … ADD VALUE` (which must EXTEND an existing type, not redefine one);
 *      every `@@index`/`@@unique` name in the schema appears in the SQL and vice versa,
 *      with no name reused; every column the history added by ALTER TABLE has a nullable
 *      mapped field and is ABSENT from that table's `CREATE TABLE`; and the datasource,
 *      the generated client and the service name ONE database, read from
 *      COMMERCE_DATABASE_URL.
 *
 *   D. THE OWNERSHIP MATRIX (three-way: OWNED / READ-ONLY CROSS-SLICE / FORBIDDEN)
 *      OWNED — a repository may write the models it owns, and every model is written by
 *      exactly ONE file: seventeen through a Prisma delegate, `receiptLine` and
 *      `returnLine` through a nested create inside their OWNER's statement, and
 *      `purchaseDocumentCounter` through one raw upsert. READ-ONLY CROSS-SLICE — a
 *      repository may read another slice's model, and the only such seams are the eight
 *      the step contracts allowed: the purchase document is read by N, Q, R and S, the
 *      purchase line by R and S, the receipt line by S, and the definition version by N.
 *      FORBIDDEN — a cross-slice WRITE, a second writer for an owned model, a single-row
 *      `delete`, a `findUnique` (it cannot carry a tenant predicate), a delegate call
 *      outside `src/modules/commerce`, raw SQL outside the three repositories that need
 *      it, and any raw statement that is not tenant-scoped and parameterized.
 *
 * ONE documented EXCLUSION, not a failure: the audit gap `WorkflowExecutionService.
 * approveStep` carries is recorded in the step P contract as a known omission of that
 * step, so this suite does not turn it into a red test. Everything else under
 * `src/modules/commerce/**` is in scope.
 *
 * NOT PINNED HERE, deliberately: the per-slice route table and DTO surface (steps L/M–S
 * own those); the rule that every repository method's FIRST parameter is `tenantId`
 * (`commerce-schema.spec.ts` owns it); and tenant isolation itself — that a query cannot
 * RETURN another tenant's row is step U's behavioural proof, not this structural one.
 *
 * NON-VACUITY: group E proves every scan below FAILS on a planted defect of its own kind,
 * each planted in fixture input only. A scan that cannot fail is documentation, not a
 * test.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, relative } from 'path';

/** `src/`, `apps/api/` and the three artifacts this suite joins: module, schema, history. */
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const COMMERCE_PRISMA_DIR = join(API_DIR, 'prisma', 'commerce');
const MIGRATIONS_DIR = join(COMMERCE_PRISMA_DIR, 'migrations');
const SCHEMA_FILE = join(COMMERCE_PRISMA_DIR, 'schema.prisma');
const LOCK_FILE = join(MIGRATIONS_DIR, 'migration_lock.toml');
const MODULE_DIR = __dirname;
const MODULE_FILE = join(MODULE_DIR, 'commerce.module.ts');
/**
 * One repository's slice of the ownership matrix.
 *
 * `writes` is the FULL truth — every model the file writes by ANY of the three write paths
 * (Prisma delegate, nested create inside an owned parent's statement, raw statement). Keeping
 * the non-delegate paths in the same list is what lets D3 prove that the twenty-nine models
 * partition across the ten files with no overlap, instead of clearing the three files that
 * use the other two paths from the check.
 */
interface OwnershipSlice {
  readonly file: string;
  readonly writes: readonly string[];
  /** Which of `writes` this file never names with a delegate: nested create or raw statement. */
  readonly writesWithoutDelegate: readonly string[];
  /** Models ANOTHER slice owns, which this file may only read — the cross-slice seams. */
  readonly reads: readonly string[];
}

/**
 * THE MATRIX (D2/D3/D4). Every one of the twenty-nine models appears in exactly ONE `writes` list;
 * every entry of `reads` is a model owned by a different file, and the union of all `reads`
 * entries is the complete set of cross-slice seams the step contracts allow:
 *
 *   N (workflow execution) reads the definition version it executes and the purchase document
 *     it acts on, writing neither: execution observes documents, it does not own them.
 *   Q (payment) reads the purchase document a payment settles.
 *   R (receiving) reads the purchase document and the purchase line it receives against.
 *   S (returns) reads the purchase document, the purchase line and the RECEIPT LINE it gives
 *     back — the newest seam, and the reason `receiptLine` is read by two files while only R
 *     writes it.
 *
 * The commercial slice's `PurchaseDocument` projection is NOT a second writer: it goes through
 * `purchase.repository.ts` (the sole writer of that model), which is why
 * `commercial-lifecycle.repository.ts` writes only `Commercial*` models here.
 */
const OWNERSHIP: readonly OwnershipSlice[] = [
  {
    file: 'purchase/purchase.repository.ts',
    // Phase B2.3: auditOutbox — durable outbox writes inside submit/close transactions.
    // PHASE W3: purchaseStatusEvent — the append-only transition history, written
    // inside the same transactions as the status changes it records.
    writes: [
      'auditOutbox',
      'purchaseDocument',
      'purchaseDocumentCounter',
      'purchaseLine',
      'purchaseStatusEvent',
    ],
    writesWithoutDelegate: ['purchaseDocumentCounter'],
    reads: [],
  },
  {
    file: 'workflow/workflow-configuration.repository.ts',
    writes: ['workflowDefinition', 'workflowDefinitionVersion', 'workflowStep'],
    writesWithoutDelegate: [],
    reads: [],
  },
  {
    file: 'workflow/workflow-execution.repository.ts',
    writes: ['workflowInstance', 'workflowStepInstance'],
    writesWithoutDelegate: [],
    reads: ['purchaseDocument', 'workflowDefinitionVersion'],
  },
  {
    file: 'workflow/workflow-line-routing.repository.ts',
    writes: ['workflowLineRoutingVersion'],
    writesWithoutDelegate: [],
    reads: [],
  },
  {
    file: 'commercial/commercial-configuration.repository.ts',
    writes: ['commercialConfigurationVersion', 'commercialGroup'],
    writesWithoutDelegate: [],
    reads: [],
  },
  {
    file: 'commercial/commercial-lifecycle.repository.ts',
    // Phase B2.3: auditOutbox — durable outbox write inside approval decision transaction.
    writes: ['auditOutbox', 'commercialApproval', 'commercialAssignment', 'commercialAssignmentHistory'],
    writesWithoutDelegate: [],
    reads: [],
  },
  {
    file: 'payment/payment-history.repository.ts',
    // Phase B2.3: auditOutbox — durable outbox write inside payment append/compensate.
    writes: ['auditOutbox', 'paymentRecord'],
    writesWithoutDelegate: [],
    reads: ['purchaseDocument'],
  },
  // PAYMENT PLAN (دستور پرداخت / رژیم پرداخت): the instruction slice owns
  // `PaymentPlan` + `PaymentInstallment` (stages created nested under their
  // plan) and writes NO `PaymentRecord` — the money event stays the payment
  // history's sole write, appended through Q's repository inside the caller's
  // unit of work, while this file only states the installment→payment link.
  {
    file: 'payment-plan/payment-plan.repository.ts',
    writes: ['paymentInstallment', 'paymentPlan'],
    writesWithoutDelegate: [],
    reads: ['paymentRecord', 'purchaseDocument'],
  },
  {
    file: 'receiving/receiving-history.repository.ts',
    writes: ['receipt', 'receiptLine'],
    writesWithoutDelegate: ['receiptLine'],
    reads: ['purchaseDocument', 'purchaseLine'],
  },
  {
    file: 'returns/return-history.repository.ts',
    // Phase B2.3: auditOutbox — durable outbox write inside return transition.
    writes: ['auditOutbox', 'returnDocument', 'returnLifecycleTransition', 'returnLine'],
    writesWithoutDelegate: ['returnLine'],
    reads: ['purchaseDocument', 'purchaseLine', 'receiptLine'],
  },
  // PHASE C4-R (GAP-3): the completion slice owns exactly ONE model —
  // `PurchaseCompletionPolicyVersion` — and reads nobody else's: the completion act reads
  // the policy through this file and the document through `purchase.repository.ts` (which
  // stays that model's only writer, so `writeCompletedIn` adds no owner). The completion
  // slice therefore introduces NO new cross-slice seam; the eight pairs above are unchanged.
  {
    file: 'completion/purchase-completion-policy.repository.ts',
    writes: ['purchaseCompletionPolicyVersion'],
    writesWithoutDelegate: [],
    reads: [],
  },
  // PHASE GAP-6: the quotation slice owns `PriceQuotation` and — through nested
  // creates only — `QuotationLine`, plus its audit outbox row. It READS the
  // purchase document (status is the "still in circulation" guard) and never
  // writes it: quotations are a child lifecycle, so no second writer exists for
  // any model another slice owns.
  {
    file: 'quotation/quotation.repository.ts',
    writes: ['auditOutbox', 'priceQuotation', 'quotationLine'],
    writesWithoutDelegate: ['quotationLine'],
    reads: ['purchaseDocument'],
  },
  // SUPPLIER MASTER DATA: the supplier slice owns `Supplier` plus its audit
  // outbox row, and introduces TWO new cross-slice READ seams — the purchase
  // documents and the quotations that NAME a supplier (`supplierId`) — the
  // same observation-only posture payment/receiving use. Quotation's optional
  // `supplierId` validation runs through this repository from
  // `quotation.service.ts` (application layer), so it adds NO persistence
  // seam of its own.
  {
    file: 'supplier/supplier.repository.ts',
    writes: ['auditOutbox', 'supplier'],
    writesWithoutDelegate: [],
    reads: ['purchaseDocument', 'priceQuotation'],
  },
  // PHASE W2-B: the integration slice owns `InventoryPosting` ALONE — the
  // durable record Commerce writes in the same transaction as the receiving
  // or dispatch event it plans from. It reads no other slice's model: the
  // origin lookups answer from its own table, which is exactly why no new
  // seam joins the list below.
  {
    file: 'integration/inventory-posting.repository.ts',
    writes: ['inventoryPosting', 'inventoryPostingAttempt'],
    writesWithoutDelegate: [],
    reads: [],
  },
  // PHASE W3.2: the aggregated traceability read's repository — the ONLY
  // slice that writes nothing. Its six seams are the read set the history
  // stream correlates; ownership is unchanged because this file's whole
  // contract is observation.
  {
    file: 'purchase/purchase-history.repository.ts',
    writes: [],
    writesWithoutDelegate: [],
    reads: [
      'commercialApproval',
      'commercialAssignment',
      'inventoryPosting',
      'inventoryPostingAttempt',
      'paymentPlan',
      'paymentRecord',
      'priceQuotation',
      'purchaseLine',
      'receipt',
      'returnDocument',
    ],
  },
];

/** The write operations: a model named with one of these is a model the file WRITES. */
const WRITE_OPERATIONS: readonly string[] = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

/**
 * The read operations. `findUnique` is listed so it is COUNTED and then refused (D5): the
 * repositories document why it is never used — it cannot carry a tenant predicate, so a
 * "find by id" written with it reads whichever tenant's row happens to share that id.
 */
const READ_OPERATIONS: readonly string[] = [
  'count',
  'aggregate',
  'findFirst',
  'findMany',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'groupBy',
];

/** Every operation the delegate scan recognises, writes and reads together. */
const DELEGATE_OPERATIONS = [...WRITE_OPERATIONS, ...READ_OPERATIONS];

/**
 * The SEVEN named permissions the Commerce catalogue defines — six that the
 * controllers had used until PHASE GAP-6 and the seventh
 * (`COMMERCE_SUPPLIER_MANAGE`) the supplier-directory controller added — every
 * `@Roles(...)` in the module names exactly one of these, once per route. An
 * eighth name invented at a call site would not exist in Core's catalogue, so
 * the guard would compare a real permission against `undefined` and refuse
 * everyone — a failure mode worth pinning at the source rather than discovering
 * as a 403. GAP-6 gave `COMMERCE_COMMERCIAL_MANAGE` its first routes; the
 * supplier slice gave `COMMERCE_SUPPLIER_MANAGE` its seven.
 */
const COMMERCE_PERMISSIONS: readonly string[] = [
  'COMMERCE_APPROVE',
  'COMMERCE_COMMERCIAL_MANAGE',
  'COMMERCE_CONFIGURE',
  'COMMERCE_MANAGE',
  'COMMERCE_READ',
  'COMMERCE_SUPPLIER_MANAGE',
  'COMMERCE_WORKFLOW_MANAGE',
];

/**
 * The class-level decorator chain, in order, that every controller carries between
 * `@Controller(…)` and `export class`: Core's entitlement decorators (step L) name the module
 * and the feature the controller belongs to, and the two guards are the ones that gate it.
 * The chain is compared WHOLE rather than as membership, because dropping either guard opens
 * every route in the file at once while leaving the other in place — a change that a
 * per-decorator presence check would not notice.
 */
const CLASS_DECORATOR_CHAIN: readonly string[] = [
  '@RequiresModule(COMMERCE_MODULE_ID)',
  '@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)',
  '@UseGuards(ModuleEntitlementGuard)',
  '@UseGuards(JwtAuthGuard)',
];

/**
 * A request field the CALLER controls, naming a tenant or a user: `req.body.tenantId`,
 * `req.headers['x-tenant-id']`, `req.query.userId`. Commerce reads identity from the session
 * only — `resolveCommerceActor(req)` — so any of these shapes reaching code would be a handler
 * electing to believe the caller.
 *
 * The pattern is an ACCESSOR, not a proximity window: it matches the key being read off
 * `req.body`/`query`/`params`/`headers` in the same expression, which is what keeps an
 * unrelated `req.headers['user-agent']` on one line and a session-derived `userId` on the next
 * from being read as a violation. Read on comment-stripped source, so `commerce-actor.ts`'s own
 * warning — that `req.body.tenantId` and friends are not consulted — is a comment, not a hit.
 */
const CLIENT_SUPPLIED_ACTOR =
  /\breq\.(?:body|query|params|headers)\s*(?:\?\.)?\s*(?:\.\s*(?:tenantId|userId|actorId)\b|\[\s*['"`](?:x-)?(?:tenant|user|actor)[-_]?id['"`]\s*\])/i;

/**
 * The HTTP surface, route by route: `method|path|permission` for all seventy-nine handlers.
 * One artifact, read by two checks. A1 compares `method|path`, so the surface is exactly this
 * — nothing added, nothing moved to another prefix, nothing turned from a read into a write.
 * A3 compares the permission, so the route that settles a payment stays `MANAGE`, the route
 * that decides an approval stays `APPROVE`, and a route quietly relaxed to `READ` is caught
 * even though every count still balances.
 *
 * The positional pairing is sound: each handler carries exactly ONE route decorator and
 * exactly ONE `@Roles(...)`, so the k-th route in the file belongs to the k-th role whether
 * the role is written above or below the route decorator.
 *
 * PHASE C2 (GAP-1, GAP-1b): the two NEW controllers join this artifact the same way every
 * earlier slice did — `workflow/workflow-execution.controller.ts` (N's §11 read/decide/cancel
 * routes, four of them) and `pending/pending-decisions.controller.ts` (the inbox, one). Both
 * carry the same class decorator chain as their siblings and declare their permission per
 * route; nothing here was relaxed to add them.
 *
 * PHASE C3 (GAP-2): the line-routing CONFIGURATION surface joins the same way —
 * `workflow/workflow-line-routing.controller.ts`, four routes (list, read, create, publish).
 * Reads answer `COMMERCE_READ` like every collection read here; the two writes answer
 * `COMMERCE_WORKFLOW_MANAGE`, the permission that already owns the version lifecycle this row
 * reuses. Again nothing was relaxed: the artifact GAINED four pinned lines and no existing
 * line moved.
 */
const CONTROLLER_SURFACE: Readonly<Record<string, readonly string[]>> = {
  'commercial/commercial.controller.ts': [
    'Get|commercial-groups|COMMERCE_READ',
    'Get|commercial-groups/:id|COMMERCE_READ',
    'Post|commercial-groups|COMMERCE_CONFIGURE',
    'Patch|commercial-groups/:id|COMMERCE_CONFIGURE',
    'Get|commercial-configurations|COMMERCE_READ',
    'Get|commercial-configurations/:id|COMMERCE_READ',
    'Post|commercial-configurations|COMMERCE_CONFIGURE',
    'Patch|commercial-configurations/:id|COMMERCE_CONFIGURE',
    'Post|commercial-configurations/:id/validate|COMMERCE_CONFIGURE',
    'Post|commercial-configurations/:id/publish|COMMERCE_CONFIGURE',
    'Post|commercial-configurations/:id/archive|COMMERCE_CONFIGURE',
    'Get|commercial-assignments|COMMERCE_READ',
    'Post|commercial-assignments|COMMERCE_MANAGE',
    'Get|commercial-approvals|COMMERCE_READ',
    'Post|commercial-approvals/:id/decision|COMMERCE_APPROVE',
  ],
  'payment/payment-history.controller.ts': [
    'Get|:id/payments|COMMERCE_READ',
    'Post|:id/payments|COMMERCE_MANAGE',
    'Post|:id/payments/:paymentId/compensate|COMMERCE_MANAGE',
  ],
  // PAYMENT PLAN (دستور پرداخت / رژیم پرداخت): the instruction surface — the
  // same `commerce/purchase-documents` collection, the same permission split,
  // extended by `COMMERCE_APPROVE` on the two decision routes: approving the
  // plan and approving each later payment stage, which is exactly the
  // requirements' "each subsequent payment needs the manager's approval".
  'payment-plan/payment-plan.controller.ts': [
    'Get|:id/payment-plans|COMMERCE_READ',
    'Post|:id/payment-plans|COMMERCE_MANAGE',
    'Get|:id/payment-plans/:planId|COMMERCE_READ',
    'Post|:id/payment-plans/:planId/submit|COMMERCE_MANAGE',
    'Post|:id/payment-plans/:planId/approve|COMMERCE_APPROVE',
    'Post|:id/payment-plans/:planId/cancel|COMMERCE_MANAGE',
    'Post|:id/payment-plans/:planId/supersede|COMMERCE_MANAGE',
    'Post|:id/payment-plans/:planId/installments/:seq/approve|COMMERCE_APPROVE',
    'Post|:id/payment-plans/:planId/installments/:seq/cancel|COMMERCE_MANAGE',
    'Post|:id/payment-plans/:planId/installments/:seq/execute|COMMERCE_MANAGE',
  ],
  'purchase/purchase.controller.ts': [
    'Get||COMMERCE_READ',
    // WIP REPAIR (working tree): the KPI summary route the register work added —
    // a read of tenant aggregates, so `commerce.read` like the list it sits beside.
    'Get|summary|COMMERCE_READ',
    'Get|:id|COMMERCE_READ',
    'Post||COMMERCE_MANAGE',
    'Patch|:id|COMMERCE_MANAGE',
    'Post|:id/submit|COMMERCE_MANAGE',
    // PHASE C4-R (GAP-3): the completion act — the same permission as every other document
    // write, and the ONE route that reaches `CLOSED`.
    'Post|:id/close|COMMERCE_MANAGE',
    // REACTIVATION (GAP-6 follow-up): the reopen act — same write remit, the ONE route
    // that reaches `DRAFT` from `REJECTED`.
    'Post|:id/reopen|COMMERCE_MANAGE',
    // PHASE C7 (GAP-7): the audit timeline — a READ of the document's own trail, so
    // `commerce.read` like every other read on this collection. The route binds only
    // `:id`; resource, resourceId and tenant are server-built.
    'Get|:id/timeline|COMMERCE_READ',
    // PHASE W3 (GAP-7b): the append-only status-transition history — a READ of the
    // document's own rows, `commerce.read` like the timeline beside it. History
    // itself is written only inside the status mutations' transactions, never
    // through this route.
    'Get|:id/status-events|COMMERCE_READ',
    // PHASE W3.2: the aggregated traceability read — status events, correlated
    // audit events and posting diagnostics under server-side filters. A READ
    // of the document's own truth sources, `commerce.read`.
    'Get|:id/history|COMMERCE_READ',
  ],
  'receiving/receiving-history.controller.ts': [
    'Get|:id/receipts|COMMERCE_READ',
    'Post|:id/receipts|COMMERCE_MANAGE',
    'Post|:id/receipts/:receiptLineId/compensate|COMMERCE_MANAGE',
  ],
  'returns/return-history.controller.ts': [
    'Get|:id/returns|COMMERCE_READ',
    'Post|:id/returns|COMMERCE_MANAGE',
    'Post|:id/returns/:returnId/approve|COMMERCE_MANAGE',
    'Post|:id/returns/:returnId/reject|COMMERCE_MANAGE',
    'Post|:id/returns/:returnId/receive-back|COMMERCE_MANAGE',
    'Post|:id/returns/:returnId/refund|COMMERCE_MANAGE',
  ],
  // PHASE W2-B: the integration's operational surface — the posting queue
  // read under `commerce.read`, the retry act under `commerce.manage`.
  'integration/inventory-posting.controller.ts': [
    'Get||COMMERCE_READ',
    'Post|:id/retry|COMMERCE_MANAGE',
  ],
  'workflow/workflow-configuration.controller.ts': [
    'Get|workflow-definitions|COMMERCE_READ',
    'Get|workflow-definitions/:id|COMMERCE_READ',
    'Post|workflow-definitions|COMMERCE_CONFIGURE',
    'Patch|workflow-definitions/:id|COMMERCE_CONFIGURE',
    'Get|workflow-definitions/:id/versions|COMMERCE_READ',
    'Post|workflow-definitions/:id/versions|COMMERCE_WORKFLOW_MANAGE',
    'Get|workflow-versions/:versionId|COMMERCE_READ',
    'Patch|workflow-versions/:versionId|COMMERCE_WORKFLOW_MANAGE',
    'Post|workflow-versions/:versionId/validate|COMMERCE_WORKFLOW_MANAGE',
    'Post|workflow-versions/:versionId/publish|COMMERCE_WORKFLOW_MANAGE',
    'Post|workflow-versions/:versionId/archive|COMMERCE_WORKFLOW_MANAGE',
    'Post|workflow-versions/:versionId/steps|COMMERCE_WORKFLOW_MANAGE',
    'Patch|workflow-versions/:versionId/steps/:stepId|COMMERCE_WORKFLOW_MANAGE',
    'Delete|workflow-versions/:versionId/steps/:stepId|COMMERCE_WORKFLOW_MANAGE',
    'Put|workflow-versions/:versionId/steps/order|COMMERCE_WORKFLOW_MANAGE',
  ],
  // PHASE C2 (GAP-1): N's execution routes, exactly as the N contract §11 specifies them.
  'workflow/workflow-execution.controller.ts': [
    'Get|workflow-instances|COMMERCE_READ',
    'Get|workflow-instances/:id|COMMERCE_READ',
    'Post|workflow-instances/:id/steps/:stepInstanceId/decision|COMMERCE_APPROVE',
    'Post|workflow-instances/:id/cancel|COMMERCE_APPROVE',
  ],
  // PHASE C2 (GAP-1b): the session-scoped inbox — a read, `commerce.read`, like every list.
  'pending/pending-decisions.controller.ts': ['Get|pending-decisions|COMMERCE_READ'],
  // PHASE C3 (GAP-2): line-routing CONFIGURATION — two reads, and the create/publish pair
  // that authorizes the row this module's version lifecycle already knows how to govern.
  'workflow/workflow-line-routing.controller.ts': [
    'Get|routing-versions|COMMERCE_READ',
    'Get|routing-versions/:id|COMMERCE_READ',
    'Post|routing-versions|COMMERCE_WORKFLOW_MANAGE',
    'Post|routing-versions/:id/publish|COMMERCE_WORKFLOW_MANAGE',
  ],
  // PHASE C4-R (GAP-3): the PURCHASE COMPLETION POLICY — two reads, and the five writes of
  // the versioned-configuration lifecycle (`commerce.configure`, the commercial
  // configuration's own remit). No new permission enters the catalogue.
  'completion/purchase-completion-policy.controller.ts': [
    'Get|completion-policies|COMMERCE_READ',
    'Get|completion-policies/:id|COMMERCE_READ',
    'Post|completion-policies|COMMERCE_CONFIGURE',
    'Patch|completion-policies/:id|COMMERCE_CONFIGURE',
    'Post|completion-policies/:id/validate|COMMERCE_CONFIGURE',
    'Post|completion-policies/:id/publish|COMMERCE_CONFIGURE',
    'Post|completion-policies/:id/archive|COMMERCE_CONFIGURE',
  ],
  // PHASE GAP-6: the PRICE QUOTATION routes — the document's quotation trail
  // (a read, `commerce.read`) and the two writes that record/decide a version,
  // answering `commerce.commercial.manage` — the permission Core's catalogue
  // description always assigned to quotation entry/confirmation/correction.
  // GAP-6 follow-up 3.3: the attachment pair joins them — upload (multipart)
  // under the same `commerce.commercial.manage` remit, download under
  // `commerce.read` like every other evidence read.
  'quotation/quotation.controller.ts': [
    'Get|price-quotations|COMMERCE_READ',
    'Post|price-quotations|COMMERCE_COMMERCIAL_MANAGE',
    'Post|price-quotations/:id/decision|COMMERCE_COMMERCIAL_MANAGE',
    'Post|price-quotations/:id/attachment|COMMERCE_COMMERCIAL_MANAGE',
    'Get|price-quotations/:id/attachment|COMMERCE_READ',
  ],
  // SUPPLIER MASTER DATA: the directory's SEVEN routes. Reads answer
  // `COMMERCE_READ` like every collection read here; the two writes AND the
  // sensitive BANKING projection answer `COMMERCE_SUPPLIER_MANAGE` — the
  // seventh catalogue permission, seeded by core migration
  // 20261017140100_seed_commerce_supplier_permission. The banking route is
  // deliberately its own route so the five sensitive fields never ride along
  // on a `COMMERCE_READ` projection.
  'supplier/supplier.controller.ts': [
    'Get|suppliers|COMMERCE_READ',
    'Post|suppliers|COMMERCE_SUPPLIER_MANAGE',
    // PHASE W2-C: the reconciliation read — declared before `:id` so the
    // literal segment is never swallowed as a supplier id.
    'Get|suppliers/reconciliation|COMMERCE_READ',
    'Get|suppliers/:id|COMMERCE_READ',
    'Patch|suppliers/:id|COMMERCE_SUPPLIER_MANAGE',
    'Get|suppliers/:id/banking|COMMERCE_SUPPLIER_MANAGE',
    'Get|suppliers/:id/purchases|COMMERCE_READ',
    'Get|suppliers/:id/quotations|COMMERCE_READ',
  ],
};

/**
 * Statements the history may never contain, with the reason each is destructive rather than
 * additive. The patterns run against COMMENT-STRIPPED SQL (`sqlCode`) because the history
 * legitimately QUOTES statements it refuses: the receiving migration records
 * ``-- `ALTER TABLE "PaymentRecord" ALTER COLUMN "id" DROP DEFAULT;` `` in a comment stating
 * that payment ids are never rewritten. A scan that could not tell that prose from a statement
 * would either fail on it or be loosened until it proved nothing.
 */
const FORBIDDEN_SQL: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // W4-B CARVE-OUT: `DROP INDEX` removes a constraint's INDEX, never data — the
  // multi-partial-refund migration drops the obsolete one-compensation unique
  // and replaces its safety with the locked cumulative cap. Every other DROP
  // form (TABLE, COLUMN, …) stays refused.
  { name: 'DROP', pattern: /^\s*DROP\s+(?!INDEX\b)/im },
  { name: 'TRUNCATE', pattern: /^\s*TRUNCATE\b/im },
  { name: 'DELETE', pattern: /^\s*DELETE\b/im },
  { name: 'ALTER COLUMN', pattern: /\bALTER\s+COLUMN\b/i },
  { name: 'RENAME', pattern: /\bRENAME\b/i },
  { name: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  { name: 'SET DEFAULT', pattern: /\bSET\s+DEFAULT\b/i },
  { name: 'CREATE EXTENSION', pattern: /\bCREATE\s+EXTENSION\b/i },
  { name: 'FOREIGN TABLE', pattern: /\bFOREIGN\s+TABLE\b/i },
  { name: 'foreign-data wrapper', pattern: /\b(?:dblink|postgres_fdw)\b/i },
  { name: "another owner's database", pattern: /\b(?:core_db|hr_db)\b/i },
];

/** The nested-create sites, and the model each one puts rows into (D3). */
const NESTED_CREATES: readonly { file: string; parent: string; model: string }[] = [
  // PAYMENT PLAN: a plan with its stage list, in ONE create — a plan whose
  // stages could land separately would be a half-visible instruction.
  {
    file: 'payment-plan/payment-plan.repository.ts',
    parent: 'paymentPlan',
    model: 'paymentInstallment',
  },
  // PHASE GAP-6: one quotation version with its itemised lines, in ONE create.
  {
    file: 'quotation/quotation.repository.ts',
    parent: 'priceQuotation',
    model: 'quotationLine',
  },
  { file: 'receiving/receiving-history.repository.ts', parent: 'receipt', model: 'receiptLine' },
  { file: 'returns/return-history.repository.ts', parent: 'returnDocument', model: 'returnLine' },
  {
    file: 'returns/return-history.repository.ts',
    parent: 'returnDocument',
    model: 'returnLifecycleTransition',
  },
];

/** The ONE raw statement that writes, and the conflict target that makes it tenant-safe (D3). */
const RAW_WRITE = {
  file: 'purchase/purchase.repository.ts',
  model: 'purchaseDocumentCounter',
  insert: 'INSERT INTO "PurchaseDocumentCounter"',
  conflict: 'ON CONFLICT ("tenant_id", "kind", "jalali_year")',
  returning: 'RETURNING "counter"',
} as const;

/** Every file under `dir`, recursively: the controller set is discovered, never listed. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const readModule = (file: string) => readFileSync(file, 'utf8');

/** A path relative to the module with forward slashes, so expectations read the same on Windows. */
const relName = (file: string) => relative(MODULE_DIR, file).replace(/\\/g, '/');

/** Everything under `src/modules/commerce`, and the four roles a file there can play. */
const moduleFiles = walk(MODULE_DIR);
const sourceFiles = moduleFiles.filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts')
);
const repositoryFiles = sourceFiles.filter((file) => file.endsWith('.repository.ts'));
const controllerFiles = sourceFiles.filter((file) => file.endsWith('.controller.ts'));

/**
 * A line whose content is entirely a comment: the three spellings the module uses — `//`,
 * `/*`, and the `*`-led bodies of JSDoc blocks.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** `line` with a trailing `// …` removed. The `://` of a URL is not a comment. */
function stripLineComment(line: string): string {
  const at = line.indexOf('//');
  if (at < 0 || line.slice(at - 1, at + 1) === ':/') return line;
  return line.slice(0, at);
}

/**
 * The module's TypeScript with comments removed: what a scan is allowed to read as code.
 * Without this, the documentation that DESCRIBES a rule ("`findUnique` is never used",
 * "the delete is scoped by tenant AND document") would be read as a violation of it.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .map((line) => stripLineComment(line))
    .join('\n');
}

/**
 * The same treatment for SQL. Prisma's generated migrations write comments as WHOLE `--`
 * lines (`-- CreateTable`, `-- AddForeignKey`, and the hand-written notes that explain a
 * refusal), so stripping those lines — and any C-style block comment — leaves executable text
 * only.
 */
function sqlCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** The route decorators, in source order: `@Get('documents')`, `@Post()`, `@Patch(':id')`, … */
const ROUTE_DECORATOR = /@(Get|Post|Patch|Put|Delete)\(([^)]*)\)/g;

function routesOf(source: string): { method: string; path: string }[] {
  return [...codeOf(source).matchAll(ROUTE_DECORATOR)].map((match) => ({
    method: match[1],
    path: match[2].replace(/^['"]|['"]$/g, ''),
  }));
}

/** What the authorization scan reads on ONE controller: routes, roles, guards and actor calls. */
function authorizationOf(source: string) {
  const code = codeOf(source);
  return {
    routes: routesOf(source),
    roles: [...code.matchAll(/@Roles\(([^)]*)\)/g)].map((match) => match[1]),
    guards: [...code.matchAll(/@UseGuards\((\w+)\)/g)].map((match) => match[1]),
    actors: [...code.matchAll(/resolveCommerceActor\(req\)/g)].length,
  };
}

/** A delegate call: an identifier, the operation, and the parenthesis that opens its argument. */
interface Delegation {
  readonly model: string;
  readonly operation: string;
}

/**
 * The delegate-call pattern. The operation alternatives are ordered longest-first, so
 * `createMany(` can never be read as `create` followed by a stray `Many`: with the trailing
 * `(` required, the order decides whether the engine can even consider the shorter
 * alternative without backtracking past it.
 */
const DELEGATE_CALL = new RegExp(
  `\\b([A-Za-z_][A-Za-z0-9_]*)\\.(${[...DELEGATE_OPERATIONS]
    .sort((left, right) => right.length - left.length)
    .join('|')})\\(`,
  'g'
);

function delegationsOf(source: string): Delegation[] {
  return [...codeOf(source).matchAll(DELEGATE_CALL)].map((match) => ({
    model: match[1],
    operation: match[2],
  }));
}

/**
 * The text of each call `needle` opens, up to the parenthesis that closes it, with `needle` at
 * the front. `needle` must END with `(`: a tagged template — the raw statements — has no
 * closing parenthesis, which is why `rawSqlOf` reads those instead.
 */
function callRegions(source: string, needle: string): string[] {
  const code = codeOf(source);
  const regions: string[] = [];
  for (let index = code.indexOf(needle); index >= 0; index = code.indexOf(needle, index + 1)) {
    let depth = 0;
    let close = code.length;
    for (let cursor = index + needle.length - 1; cursor < code.length; cursor += 1) {
      if (code[cursor] === '(') depth += 1;
      else if (code[cursor] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    regions.push(code.slice(index, close + 1));
  }
  return regions;
}

/**
 * The raw-SQL template literals a file contains, verbatim: the text between the backticks of
 * each `$queryRaw`/`$executeRaw` tagged template. `…Unsafe` is excluded by name. The raw
 * statements in the module interpolate plain bindings (`${tenantId}`, `${jy}`) and nest no
 * template of their own, so the first unescaped backtick closes the statement.
 */
function rawSqlOf(source: string): string[] {
  const code = codeOf(source);
  const templates: string[] = [];
  for (const match of code.matchAll(/\$(?:query|execute)Raw(?![A-Za-z])/g)) {
    const start = code.indexOf('`', (match.index ?? 0) + match[0].length);
    if (start < 0) continue;
    let cursor = start + 1;
    while (cursor < code.length && !(code[cursor] === '`' && code[cursor - 1] !== '\\')) {
      cursor += 1;
    }
    templates.push(code.slice(start + 1, cursor));
  }
  return templates;
}

/** The body of one `CREATE TABLE "name" ( … );` statement, or '' when the history has none. */
function tableBody(sql: string, table: string): string {
  return new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? '';
}

/** The `"a", "b"` column list inside a key or index definition, in order. */
const columnsOf = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

/** A `CREATE [UNIQUE] INDEX` from the history, with the table and columns it keys on. */
interface IndexArtifact {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

function indexesOf(sql: string): IndexArtifact[] {
  // The LIVE artifact set: every index the history created, minus the ones a
  // later migration dropped (W4-B: the obsolete one-compensation unique — the
  // only DROP INDEX the history may ever carry, carved out in FORBIDDEN_SQL).
  const dropped = new Set(
    [...sql.matchAll(/DROP INDEX "([^"]+)"/g)].map((match) => match[1])
  );
  return [...sql.matchAll(/CREATE (UNIQUE )?INDEX "([^"]+)"\s+ON\s+"(\w+)"\s*\(([^)]*)\)/g)]
    .map((match) => ({
      name: match[2],
      table: match[3],
      columns: columnsOf(match[4]),
      unique: match[1] === 'UNIQUE ',
    }))
    .filter((index) => !dropped.has(index.name));
}

/** An `ADD CONSTRAINT … FOREIGN KEY … REFERENCES …` from the history, with both column lists. */
interface ForeignKeyArtifact {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly target: string;
  readonly targetColumns: readonly string[];
  readonly onDelete: string;
  readonly onUpdate: string;
}

/** Every constraint the history adds is written by Prisma in exactly this one-line shape. */
const FOREIGN_KEY = new RegExp(
  'ALTER TABLE "(\\w+)"\\s+ADD CONSTRAINT "([^"]+)" FOREIGN KEY \\(([^)]*)\\) ' +
    'REFERENCES "(\\w+)"\\(([^)]*)\\) ON DELETE (\\w+) ON UPDATE (\\w+);',
  'g'
);

function foreignKeysOf(sql: string): ForeignKeyArtifact[] {
  return [...sql.matchAll(FOREIGN_KEY)].map((match) => ({
    name: match[2],
    table: match[1],
    columns: columnsOf(match[3]),
    target: match[4],
    targetColumns: columnsOf(match[5]),
    onDelete: match[6],
    onUpdate: match[7],
  }));
}

/**
 * The members `CREATE TYPE` itself declares, before any later `ADD VALUE`: the list an appended
 * member must be absent from, which is how C2 tells "declared with the type" from "added after".
 */
function createdMembersOf(sql: string, name: string): string[] {
  const created = new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`).exec(sql)?.[1] ?? '';
  return created
    .split(',')
    .map((value) => value.trim().replace(/^'|'$/g, ''))
    .filter((value) => value.length > 0);
}

/** The members a migration gives `name`: the `CREATE TYPE` list, then any `ADD VALUE` members. */
function enumMembersOf(sql: string, name: string): string[] {
  const added = [...sql.matchAll(new RegExp(`ALTER TYPE "${name}" ADD VALUE '([^']+)'`, 'g'))].map(
    (match) => match[1]
  );
  return [...createdMembersOf(sql, name), ...added];
}

/** The `model` blocks of the schema, name and body, so a check can read a model's own fields. */
function modelBlocks(schema: string): { name: string; body: string }[] {
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((match) => ({
    name: match[1],
    body: match[2],
  }));
}

/** The members one `enum` block declares, in order, with `@map` attributes and `@@` lines cut. */
function schemaEnumMembers(schema: string, name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema)?.[1];
  if (!block) return [];
  return codeOf(block)
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((member) => member.length > 0 && !member.startsWith('@'));
}

/**
 * The scalar types a Prisma field can carry and still be a column of its own. A field typed
 * with a MODEL name is a relation — a join, not a column — which is how `columnFieldsOf` tells
 * the two apart without needing the relation attributes.
 */
const SCALAR_TYPES = [
  'String',
  'Int',
  'Boolean',
  'DateTime',
  'Json',
  'Decimal',
  'BigInt',
  'Float',
  'Bytes',
];

/**
 * The columns one model maps, in file order: the fields whose type is a scalar or one of the
 * schema's own enums, named as the column they land in — `@map("…")` when the field is
 * camelCase, the field name itself when it is not.
 */
function columnFieldsOf(
  body: string,
  enums: readonly string[]
): { field: string; column: string }[] {
  const columns: { field: string; column: string }[] = [];
  for (const line of body.split('\n')) {
    const field = /^\s{2}(?!@)([A-Za-z_]\w*)\s+([A-Za-z_][\w[\]?]*)/.exec(line);
    if (!field) continue;
    const type = field[2].replace(/[[\]?]/g, '');
    if (!SCALAR_TYPES.includes(type) && !enums.includes(type)) continue;
    columns.push({ field: field[1], column: /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field[1] });
  }
  return columns;
}

/** `PaymentRecord` → `paymentRecord`: the delegate name Prisma generates for a model. */
const camelCaseOf = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** `purchaseDocumentId` → `purchase_document_id`: the column a camelCase field maps to. */
const snakeCaseOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/** `commercial-configuration` → `CommercialConfiguration`: the class-name spelling of a slice. */
const pascalCaseOf = (name: string) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/** `commercial/commercial.controller.ts` → `CommercialController`, the registered class name. */
const classNameOf = (file: string) =>
  pascalCaseOf(basename(file).replace(/\.controller\.ts$/, '')) + 'Controller';

/**
 * The decorator lines between `@Controller(…)` and `export class`, comments and blank lines
 * removed: the class-level gate exactly as the file writes it, so a guard that was moved,
 * reordered or dropped shows up as a different chain rather than as a passing membership test.
 */
function classDecoratorChainOf(source: string): string[] {
  const lines = source.split('\n').map((line) => stripLineComment(line).trim());
  const start = lines.findIndex((line) => line.startsWith('@Controller('));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('export class '));
  return lines
    .slice(start, end < 0 ? lines.length : end)
    .filter((line) => line.length > 0 && line.startsWith('@'));
}

/** The permission each handler requires, in file order: one `@Roles(Permissions.…)` per route. */
function permissionsOf(source: string): string[] {
  return [...codeOf(source).matchAll(/@Roles\(([^)]*)\)/g)].map((match) => match[1].trim());
}

/**
 * The schema and the history are read AFTER the pinned constants below, because the constants
 * name the migrations: see `schemaText` and its neighbours at the foot of this preamble.
 */

/**
 * The applied history, in application order: directory-name order IS application order, so
 * a new migration sorts last, and renaming one that has been applied is a deliberate edit
 * to this list — which is the point.
 */
const MIGRATIONS = [
  '20260926121430_commerce_baseline',
  '20260926130000_purchase_document_counter',
  '20260926220642_workflow_execution',
  '20260928000000_line_routing',
  '20260929000000_commercial_foundation',
  '20260929000001_commercial_assignment_rule_label',
  '20260929000002_payment_history',
  '20260929000003_receiving_foundation',
  '20260929000004_return_foundation',
  '20260929000005_line_routing_version_pin',
  '20260930000000_commercial_approval_inbox_index',
  // PHASE C4-R (GAP-3): the Purchase Completion Policy — one table (the existing
  // `WorkflowDefinitionVersionStatus` type, so no new enum), three indexes, one RESTRICT
  // foreign key, and three nullable columns on `PurchaseDocument`.
  '20261001000000_purchase_completion_policy',
  // Phase B2.3: Commerce audit outbox — one table, three indexes, no FK.
  '20261008150000_audit_outbox',
  // WIP REPAIR (working tree): `PurchaseDocument.costCenter` — one late nullable
  // column on an existing table, no table, no type, no index, no foreign key.
  '20261015130000_purchase_cost_center',
  // PHASE GAP-6: the price quotation — two tables, one new enum type, six indexes
  // (three per table: the tenant handle, the ordering/version key and the list
  // read) and two composite RESTRICT foreign keys.
  '20261017000000_price_quotation',
  // SUPPLIER MASTER DATA: the supplier directory — one table, two enum types,
  // four indexes and one nullable column added to PriceQuotation.
  '20261017140000_supplier_master',
  // PAYMENT PLAN (دستور پرداخت / رژیم پرداخت): the payment-instruction pair —
  // two tables, two enum types, seven indexes, four composite RESTRICT
  // foreign keys.
  '20261018120000_payment_plan',
  // PHASE W2-B: the durable Commerce→Inventory posting record — one table
  // (InventoryPosting), one enum type (InventoryPostingStatus), four
  // tenant-first indexes, no foreign key (opaque cross-context references
  // are never FK'd).
  '20261019120000_inventory_posting',
  // PHASE W2-C: `PurchaseDocument.status_changed_at` — one late nullable column
  // with an honest COALESCE backfill; no table, no type, no index, no foreign key.
  '20261019130000_purchase_status_changed_at',
  // PHASE W3 (GAP-7b): `PurchaseStatusEvent` — the append-only transition
  // history; one table, one enum type, two indexes (the tenant handle and the
  // per-document timeline read), one composite RESTRICT foreign key into the
  // document it belongs to. NO backfill — see the migration's own note.
  '20261020120000_purchase_status_event',
  // PHASE W3.1 (resolved-return closure): one ADD COLUMN —
  // `ReturnLifecycleTransition.refunded_payment_id`, the persisted
  // return→settlement link. No backfill.
  '20261021120000_return_refunded_payment',
  // PHASE W3.2 (attempt-level traceability): one table
  // (InventoryPostingAttempt), four indexes (the posting's tenant handle
  // unique, the attempt row's tenant handle, the ordinal-per-posting unique
  // and the per-posting history read), one composite foreign key.
  '20261022120000_inventory_posting_attempt',
  // PHASE W4-B (repeated partial refunds + the exact refund link): no table,
  // two indexes (the reversal read replacing the dropped one-compensation
  // unique, the refund-association read), one composite foreign key, one
  // ADD COLUMN (`ReturnLifecycleTransition.refund_compensation_payment_id`).
  '20261023120000_multi_partial_refund',
  // PHASE W4-D: the partial unique on `refund_compensation_payment_id` — one
  // compensation settles one REFUNDED transition, enforced by the database.
  '20261024120000_refund_compensation_unique_link',
] as const;

/** How many tables, enum types, indexes and foreign keys each migration contributed. */
type Contribution = readonly [tables: number, types: number, indexes: number, foreignKeys: number];

const MIGRATION_CONTRIBUTIONS: Readonly<Record<string, Contribution>> = {
  '20260926121430_commerce_baseline': [7, 11, 22, 6],
  '20260926130000_purchase_document_counter': [1, 0, 1, 0],
  '20260926220642_workflow_execution': [0, 3, 0, 0],
  '20260928000000_line_routing': [1, 3, 2, 0],
  '20260929000000_commercial_foundation': [5, 8, 13, 6],
  '20260929000001_commercial_assignment_rule_label': [0, 0, 0, 0],
  '20260929000002_payment_history': [1, 1, 3, 2],
  '20260929000003_receiving_foundation': [2, 0, 6, 4],
  '20260929000004_return_foundation': [3, 1, 8, 5],
  '20260929000005_line_routing_version_pin': [0, 0, 1, 1],
  // PHASE C2 (GAP-1b): one additive index for the inbox's actor-scoped read. Nothing else
  // moves — no table, no type, no foreign key, no column.
  '20260930000000_commercial_approval_inbox_index': [0, 0, 1, 0],
  // PHASE C4-R (GAP-3): one table, no type (the version lifecycle's enum already exists),
  // three indexes (both tenant-first uniques and the published read) and one foreign key.
  '20261001000000_purchase_completion_policy': [1, 0, 3, 1],
  // Phase B2.3: one table (AuditOutbox), no type, three indexes (unique auditId,
  // nextAt for polling, tenantId for isolation), no foreign key.
  '20261008150000_audit_outbox': [1, 0, 3, 0],
  // WIP REPAIR: one ADD COLUMN on PurchaseDocument, nothing else.
  '20261015130000_purchase_cost_center': [0, 0, 0, 0],
  // PHASE GAP-6: two tables, one enum type, six indexes, two foreign keys.
  '20261017000000_price_quotation': [2, 1, 6, 2],
  // SUPPLIER MASTER DATA: one table (Supplier), two enum types, four indexes
  // (the tenant handle unique, the national-code unique, the directory list
  // read, and the quotation-supplier history read), no foreign key.
  '20261017140000_supplier_master': [1, 2, 4, 0],
  // PAYMENT PLAN: two tables, two enum types, seven indexes (both tenant
  // handles, the supersession unique, the seq unique, the executed-payment
  // unique, the register read and the plan's stages read), four foreign keys.
  '20261018120000_payment_plan': [2, 2, 6, 4],
  // PHASE W2-B: one table (InventoryPosting), one enum type
  // (InventoryPostingStatus), four indexes (the one-posting-per-line unique,
  // the operational queue read, the per-purchase-line read and the origin
  // lookup), no foreign key.
  '20261019120000_inventory_posting': [1, 1, 4, 0],
  // PHASE W2-C: one ADD COLUMN + one UPDATE backfill; contributes nothing counted.
  '20261019130000_purchase_status_changed_at': [0, 0, 0, 0],
  // PHASE W3: one table (PurchaseStatusEvent), one enum type
  // (PurchaseStatusEventSource), two indexes (the tenant handle unique and the
  // document timeline read), one composite foreign key.
  '20261020120000_purchase_status_event': [1, 1, 2, 1],
  // PHASE W3.1: one ADD COLUMN (`ReturnLifecycleTransition.refunded_payment_id`)
  // — no table, enum, index or foreign key contribution.
  '20261021120000_return_refunded_payment': [0, 0, 0, 0],
  // PHASE W3.2: one table (InventoryPostingAttempt), four indexes (the
  // posting's tenant handle unique + the attempt row's own three), one
  // composite foreign key.
  '20261022120000_inventory_posting_attempt': [1, 0, 4, 1],
  // PHASE W4-B: two indexes (reversal read + refund-association read — the
  // dropped one-compensation unique subtracts one at C3), one foreign key.
  '20261023120000_multi_partial_refund': [0, 0, 2, 1],
  // PHASE W4-D: one partial UNIQUE index, no table, no column, no key.
  '20261024120000_refund_compensation_unique_link': [0, 0, 1, 0],
};

/**
 * The THIRTEEN controllers, the path each serves and the number of routes each exposes. The
 * counts are the slices' own totals, so a route added anywhere without its `@Roles` is a
 * failure of A3's count even though every sibling route still passes.
 *
 * N (workflow execution) gained its HTTP surface with PHASE C2: four routes on
 * `workflow-execution.controller.ts`, declared in the N contract §11 before the shell
 * carried them. O (line routing) gained ITS HTTP surface with PHASE C3 (GAP-2): four
 * configuration routes on `workflow-line-routing.controller.ts` — list, read, create and
 * publish — over the capability step O built and that A1 previously pinned as absent.
 * A1–A5 hold that controller to the same chain, surface, permission and registration
 * tests as every other file here. PHASE GAP-6 (quotation) joins as the eleventh.
 */
const CONTROLLERS: Readonly<Record<string, { readonly prefix: string; readonly routes: number }>> =
  {
    'commercial/commercial.controller.ts': { prefix: 'commerce', routes: 15 },
    // PHASE C4-R (GAP-3): the completion-policy lifecycle gained its HTTP surface — list,
    // read, create, edit-a-draft, validate, publish and archive, on `commerce`.
    'completion/purchase-completion-policy.controller.ts': { prefix: 'commerce', routes: 7 },
    'payment/payment-history.controller.ts': { prefix: 'commerce/purchase-documents', routes: 3 },
    // PAYMENT PLAN: the instruction slice's ten routes on the same collection.
    'payment-plan/payment-plan.controller.ts': {
      prefix: 'commerce/purchase-documents',
      routes: 10,
    },
    // PHASE W2-B: the integration operational surface — the posting queue
    // read and the retry act on `commerce/inventory-postings`.
    'integration/inventory-posting.controller.ts': {
      prefix: 'commerce/inventory-postings',
      routes: 2,
    },
    // WIP REPAIR + PHASE GAP-6 + REACTIVATION: nine routes now — §29's completion act,
    // C7's timeline, the working tree's KPI summary read and the reopen act joined L's five,
    // on the same `commerce/purchase-documents` collection.
    'purchase/purchase.controller.ts': { prefix: 'commerce/purchase-documents', routes: 11 },
    'receiving/receiving-history.controller.ts': {
      prefix: 'commerce/purchase-documents',
      routes: 3,
    },
    'returns/return-history.controller.ts': { prefix: 'commerce/purchase-documents', routes: 6 },
    'workflow/workflow-configuration.controller.ts': { prefix: 'commerce', routes: 15 },
    'workflow/workflow-execution.controller.ts': { prefix: 'commerce', routes: 4 },
    // PHASE C3 (GAP-2): line-routing configuration — list, read, open a DRAFT, publish.
    'workflow/workflow-line-routing.controller.ts': { prefix: 'commerce', routes: 4 },
    'pending/pending-decisions.controller.ts': { prefix: 'commerce', routes: 1 },
    // PHASE GAP-6: the quotation controller — list, record one version, decide it.
    'quotation/quotation.controller.ts': { prefix: 'commerce', routes: 5 },
    // SUPPLIER MASTER DATA: the supplier controller — list, create, read,
    // update, banking projection, purchase history and quotation history.
    'supplier/supplier.controller.ts': { prefix: 'commerce', routes: 8 },
  };

/**
 * The schema and the history, read once. Every check below is a JOIN of these two artifacts:
 * the schema states the intent, the SQL is what the database actually receives, and a boundary
 * that holds in only one of them does not hold. `allSql` is comment-stripped; `allRawSql` keeps
 * the comments, and exists so a non-vacuity proof can show the stripping is load-bearing.
 *
 * These sit below the pinned constants on purpose: `MIGRATIONS` names the directories read
 * here, so reading them earlier would touch the constant before it is initialised.
 */
const schemaText = readModule(SCHEMA_FILE);
const migrationSql = MIGRATIONS.map((dir) => ({
  dir,
  raw: readModule(join(MIGRATIONS_DIR, dir, 'migration.sql')),
}));
const migrationByDir = Object.fromEntries(migrationSql.map((entry) => [entry.dir, entry]));
const sqlOfMigration = (dir: string) => sqlCode(migrationByDir[dir]?.raw ?? '');
const allSql = migrationSql.map(({ raw }) => sqlCode(raw)).join('\n');

/** The twenty-nine models: name, body, the table each maps to, and the delegate Prisma generates. */
const modelList = modelBlocks(schemaText).map(({ name, body }) => ({
  name,
  body,
  table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? '',
  delegate: camelCaseOf(name),
}));
const delegateNames = modelList.map(({ delegate }) => delegate);
const schemaTables = modelList.map(({ table }) => table).sort();

/** The artifacts every join reads: tables, indexes, keys, enums and the columns added later. */
const createdTables = [...allSql.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]);
const sqlIndexes = indexesOf(allSql);
const sqlForeignKeys = foreignKeysOf(allSql);
const schemaEnums = [...schemaText.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1]);

/**
 * The indexes the schema declares, with the FIELDS each one keys on: the counterpart of
 * `sqlIndexes`, which carries the mapped COLUMN names. C3 joins the two by name and translates
 * the field list, so an index that keeps its name while changing its columns is a failure.
 */
const schemaIndexes = modelList.flatMap(({ table, body }) =>
  [...body.matchAll(/@@(index|unique)\(([^)]*)\)/g)].map((match) => ({
    name: /map: "([^"]+)"/.exec(match[2])?.[1] ?? '',
    table,
    fields: (match[2].match(/\[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
    unique: match[1] === 'unique',
  }))
);

/**
 * The columns the history ADDS to a table that already exists, table by table. Prisma pads the
 * clauses of a multi-clause `ALTER TABLE` — `ADD COLUMN     "x"` — so the whitespace after
 * `ADD COLUMN` is `\s+`, not one space. The one-space spelling matched NOTHING at all, which
 * made C4's provenance check pass over an empty list: the exact failure mode `E` exists for.
 * It is a NAMED scan so `E` can hand the padded spelling to the very function C4 runs.
 */
const addedColumnsOf = (sql: string) =>
  [...sql.matchAll(/ALTER TABLE "(\w+)"[^;]*;/g)].flatMap((statement) =>
    [...statement[0].matchAll(/ADD COLUMN\s+"(\w+)"/g)].map((match) => ({
      table: statement[1],
      column: match[1],
    }))
  );
const addedColumns = addedColumnsOf(allSql);

/**
 * The columns the two artifacts claim, as `table.column` pairs: what `schema.prisma` maps, and
 * what the history's own DDL creates — `CREATE TABLE` bodies plus the twelve late `ADD COLUMN`s.
 */
const schemaColumns = modelList.flatMap(({ table, body }) =>
  columnFieldsOf(body, schemaEnums).map(({ field, column }) => ({ table, field, column }))
);
const sqlColumns = [
  ...modelList.flatMap(({ table }) =>
    [...tableBody(allSql, table).matchAll(/^\s{4}"(\w+)"/gm)].map((match) => ({
      table,
      column: match[1],
    }))
  ),
  ...addedColumns,
];

describe('A. the entry point: every route behind one authenticated, entitled gate', () => {
  it('A1 — discovers the twelve controllers on disk, and no @Controller hiding in another file', () => {
    expect(controllerFiles.map(relName).sort()).toEqual(Object.keys(CONTROLLERS).sort());

    // Discovery is by DECORATOR across every source file, not by file name: a controller added
    // to a service file would never appear in `controllerFiles`, and would open a route that
    // nothing else in this suite looks at. So the two sets are compared, rather than the
    // file-name set being trusted to be the whole truth.
    const declaring = sourceFiles.filter((file) =>
      codeOf(readModule(file)).includes('@Controller(')
    );
    expect(declaring.map(relName).sort()).toEqual(controllerFiles.map(relName).sort());

    // THE TWO CONTROLLERS THAT USED TO BE PINNED AS ABSENT. N lost its absence-pin in
    // PHASE C2 and O in PHASE C3 (GAP-2); each is now a member of `CONTROLLERS` above, so
    // the discovery check above still covers them — a controller that hides in a file the
    // surface tests do not read fails the `declaring` comparison rather than escaping.
    // The check below is what remains of the old pin: NO line-routing controller may exist
    // under a name that would put it outside the pinned set (the discovery assertion and
    // this one are both measured from disk).
    const strays = moduleFiles.filter(
      (file) =>
        file.endsWith('.controller.ts') &&
        /workflow-line-routing/.test(basename(file)) &&
        !Object.keys(CONTROLLERS).includes(relName(file))
    );
    expect(strays.map(relName)).toEqual([]);
  });

  it('A2 — carries the same five-decorator chain on every controller, in order', () => {
    const chains = Object.fromEntries(
      controllerFiles.map((file) => [relName(file), classDecoratorChainOf(readModule(file))])
    );
    const expected = Object.fromEntries(
      Object.keys(CONTROLLERS).map((name) => [
        name,
        [`@Controller('${CONTROLLERS[name].prefix}')`, ...CLASS_DECORATOR_CHAIN],
      ])
    );
    expect(chains).toEqual(expected);
  });

  it('A3 — registers exactly those fourteen classes in commerce.module.ts', () => {
    const region = /controllers:\s*\[([\s\S]*?)\]/.exec(codeOf(readModule(MODULE_FILE)))?.[1] ?? '';
    const registered = [...region.matchAll(/(\w+Controller)\b/g)].map((match) => match[1]).sort();
    expect(registered).toEqual(controllerFiles.map(classNameOf).sort());
    expect(registered).toHaveLength(14);
  });

  it('A4 — serves exactly the pinned eighty-three routes, on the pinned prefixes', () => {
    const surface = Object.fromEntries(
      controllerFiles.map((file) => [
        relName(file),
        routesOf(readModule(file)).map(({ method, path }) => `${method}|${path}`),
      ])
    );
    const expected = Object.fromEntries(
      Object.keys(CONTROLLER_SURFACE).map((name) => [
        name,
        CONTROLLER_SURFACE[name].map((route) => route.split('|').slice(0, 2).join('|')),
      ])
    );
    expect(surface).toEqual(expected);

    // The route counts in CONTROLLERS were measured apart from the surface above; comparing
    // them catches an edit that updates one artifact and forgets the other.
    const counts = Object.fromEntries(
      Object.keys(CONTROLLERS).map((name) => [name, CONTROLLER_SURFACE[name].length])
    );
    expect(counts).toEqual(
      Object.fromEntries(Object.keys(CONTROLLERS).map((name) => [name, CONTROLLERS[name].routes]))
    );
  });

  it('A5 — gives every route exactly one role, and only roles the catalogue defines', () => {
    const roles = Object.fromEntries(
      controllerFiles.map((file) => [relName(file), permissionsOf(readModule(file))])
    );
    const expected = Object.fromEntries(
      Object.keys(CONTROLLER_SURFACE).map((name) => [
        name,
        CONTROLLER_SURFACE[name].map((route) => `Permissions.${route.split('|')[2]}`),
      ])
    );
    expect(roles).toEqual(expected);

    const used = [...new Set(Object.values(roles).flat())].sort();
    expect(used).toEqual(COMMERCE_PERMISSIONS.map((name) => `Permissions.${name}`).sort());

    // The other guard family's decorator, and the escape hatch that switches the gate off,
    // must not appear anywhere under this module.
    const foreignGate = sourceFiles.filter((file) =>
      /@Permissions\(|@Public\(/.test(codeOf(readModule(file)))
    );
    expect(foreignGate.map(relName)).toEqual([]);
  });

  it('A6 — resolves the actor once per handler, from the session, never from the request', () => {
    const actors = Object.fromEntries(
      controllerFiles.map((file) => [relName(file), authorizationOf(readModule(file)).actors])
    );
    const expected = Object.fromEntries(
      Object.keys(CONTROLLER_SURFACE).map((name) => [name, CONTROLLER_SURFACE[name].length])
    );
    expect(actors).toEqual(expected);

    const trusting = sourceFiles.filter((file) =>
      CLIENT_SUPPLIED_ACTOR.test(codeOf(readModule(file)))
    );
    expect(trusting.map(relName)).toEqual([]);
  });
});

/**
 * The migrations read as an application plan: which tables are visible when each migration
 * runs, and the ALTERs that name a table before the migration creating it. B4 runs this over
 * the real history; `E` plants a premature ALTER in a fixture plan and runs the same function,
 * so the scan itself — not a copy of it — is what is proved fail-able.
 */
function historyPlanned(plans: readonly { readonly dir: string; readonly sql: string }[]): {
  readonly premature: string[];
  readonly visible: string[];
} {
  const visible = new Set<string>();
  const premature: string[] = [];
  for (const { dir, sql } of plans) {
    const createdHere = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]);
    const inScope = new Set([...visible, ...createdHere]);
    for (const match of sql.matchAll(/ALTER TABLE "(\w+)"/g)) {
      if (!inScope.has(match[1])) premature.push(`${dir} → ${match[1]}`);
    }
    for (const table of createdHere) visible.add(table);
  }
  return { premature, visible: [...visible] };
}

describe('B. the history: additive at every step, tenant-first in every key', () => {
  it('B1 — is the pinned migrations, each contributing exactly the measured total', () => {
    const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...MIGRATIONS].sort());

    // The lock file is what a fresh `migrate deploy` reads before it reads anything else.
    expect(readModule(LOCK_FILE)).toContain('provider = "postgresql"');

    // And each migration contributes exactly the tables, enum types, indexes and foreign keys
    // counted when this boundary was pinned. A migration that quietly grows a second table
    // moves one tuple here and nothing else in the suite notices.
    const contributions = Object.fromEntries(
      MIGRATIONS.map((directory) => {
        const sql = sqlOfMigration(directory);
        return [
          directory,
          [
            [...sql.matchAll(/CREATE TABLE "/g)].length,
            [...sql.matchAll(/CREATE TYPE "/g)].length,
            indexesOf(sql).length,
            foreignKeysOf(sql).length,
          ],
        ];
      })
    );
    expect(contributions).toEqual(MIGRATION_CONTRIBUTIONS);
  });

  it('B2 — ALTER only ever adds, and no refused statement appears in executable SQL', () => {
    const alters = allSql.match(/ALTER TABLE[^;]*;/g) ?? [];
    // SUPPLIER MASTER DATA: one more ALTER — the `PriceQuotation` supplier_id
    // column, an ADD COLUMN like every other late column in this history.
    // W2-C: `status_changed_at` is ALTER forty-four; W3.1:
    // `ReturnLifecycleTransition.refunded_payment_id` is ALTER forty-five;
    // W3.2: the InventoryPostingAttempt foreign key is forty-six; W4-B:
    // the refund-compensation column and its key are forty-seven/-eight.
    expect(alters).toHaveLength(49);
    expect(alters.filter((statement) => !/ADD COLUMN|ADD CONSTRAINT/.test(statement))).toEqual([]);

    // Columns and constraints are counted apart from the statements carrying them: one ALTER
    // can add four columns, so five columns arriving in two statements is not the same history
    // as five arriving in five. PHASE C4-R added three column statements and one constraint;
    // the working tree's costCenter added one more, and PHASE GAP-6 two FK constraint
    // statements on top.
    // W2-C: `status_changed_at` is the fifteenth late column (one ALTER).
    expect([...allSql.matchAll(/ADD COLUMN/g)]).toHaveLength(17);
    expect([...allSql.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(35);

    // The one enum member added after its type already existed, and the only place this
    // history ever appends a value. No `RENAME VALUE`, so a published member keeps its name.
    expect(allSql.match(/ALTER TYPE[^;]*;/g)).toEqual([
      `ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'AFTER_DOCUMENT_WORKFLOW_APPROVED';`,
    ]);

    const offending = FORBIDDEN_SQL.filter(({ pattern }) => pattern.test(allSql));
    expect(offending.map(({ name }) => name)).toEqual([]);
  });

  it('B3 — puts the tenant in the key of every table, every index and every foreign key', () => {
    // Table shape, read off the SQL rather than the schema: `id` identifies the row, `tenant_id`
    // scopes it, and it is the SECOND column in all twenty-one tables. One table could drop that
    // column, or take a different scoping name, without moving any count in this suite.
    const shapes = Object.fromEntries(
      schemaTables.map((table) => {
        const columns = [...tableBody(allSql, table).matchAll(/^\s{4}"(\w+)"/gm)].map(
          (column) => column[1]
        );
        return [table, [columns[0], columns[1]]];
      })
    );
    expect(shapes).toEqual(
      Object.fromEntries(schemaTables.map((table) => [table, ['id', 'tenant_id']]))
    );

    // Every index leads with `tenant_id`: an index that could cross
    // tenants is an index no tenant-scoped query would ever want, and none exists.
    // PHASE GAP-6 added six (the quotation pair's three each); SUPPLIER MASTER
    // DATA added four (three on Supplier, one on PriceQuotation).
    expect(sqlIndexes).toHaveLength(91);
    expect(sqlIndexes.filter(({ columns }) => columns[0] !== 'tenant_id')).toEqual([]);

    // And every foreign key is composite on the tenant, pointing at the `(tenant_id, id)` key,
    // so a child row cannot name a parent in another tenant. Deletion is RESTRICTED on all:
    // no parent row is ever removed by deleting its children. Update differs — the majority
    // cascade and the return slice's five restrict — and it is pinned per count,
    // because "twenty-two plus five" is the part a hand-edit is most likely to change silently.
    // PHASE GAP-6 added two cascade-on-update, restrict-on-delete keys.
    expect(sqlForeignKeys).toHaveLength(34);
    expect(
      sqlForeignKeys.filter(
        (key) =>
          key.columns[0] !== 'tenant_id' ||
          key.targetColumns.join() !== 'tenant_id,id' ||
          key.onDelete !== 'RESTRICT'
      )
    ).toEqual([]);
    const onUpdate = sqlForeignKeys.reduce<Record<string, number>>((counts, key) => {
      counts[key.onUpdate] = (counts[key.onUpdate] ?? 0) + 1;
      return counts;
    }, {});
    expect(onUpdate).toEqual({ CASCADE: 29, RESTRICT: 5 });
  });

  it('B4 — alters only tables that exist by the end of that same migration', () => {
    const { premature, visible } = historyPlanned(
      MIGRATIONS.map((dir) => ({ dir, sql: sqlOfMigration(dir) }))
    );
    expect(premature).toEqual([]);
    expect([...visible].sort()).toEqual(schemaTables);
  });

  it('B5 — names only the tables this owner owns, in every DDL position', () => {
    const named = new Set<string>();
    for (const match of allSql.matchAll(/CREATE TABLE "(\w+)"/g)) named.add(match[1]);
    for (const match of allSql.matchAll(/ALTER TABLE "(\w+)"/g)) named.add(match[1]);
    for (const match of allSql.matchAll(/REFERENCES "(\w+)"/g)) named.add(match[1]);
    for (const { table } of sqlIndexes) named.add(table);

    // Four positions, one set: a statement that reached into another owner's table would have
    // to name it in at least one of them, and no such name is a Commerce table.
    expect([...named].sort()).toEqual(schemaTables);
    expect(schemaTables).toHaveLength(30);
  });
});

/**
 * The two patterns C5 reads the module's own source with: an import of ANOTHER owner's
 * generated client, and the class names a foreign persistence layer would arrive under. Both
 * are matched against comment-stripped code, because the module documents what it refuses.
 */
const FOREIGN_CLIENT_PATH = /generated\/(?:core|hr|cms|correspondence|observability)-client/;
const FOREIGN_CLIENT_NAME =
  /\b(?:PrismaService|PrismaModule|HrPrisma\w*|CmsPrisma\w*|CorrespondencePrisma\w*)\b/;

describe('C. the schema and the history: one artifact, joined in both directions', () => {
  it('C1 — maps every model to a created table, and every created table to a mapped model', () => {
    expect(modelList).toHaveLength(30);

    // Every model states its table. Without `@@map`, Prisma would name the table after the
    // model, and a table the history never created is a table only the client believes in.
    expect(modelList.filter(({ table }) => table === '').map(({ name }) => name)).toEqual([]);
    expect([...new Set(schemaTables)]).toHaveLength(30);
    expect([...new Set(createdTables)]).toHaveLength(30);
    expect([...createdTables].sort()).toEqual(schemaTables);

    // One delegate per model: D attributes a write to a file BY this name, so two models sharing
    // a delegate would attribute one model's write to another model's owner.
    expect([...new Set(delegateNames)]).toHaveLength(30);
  });

  it('C2 — declares the same thirty types, member for member, and extends exactly one', () => {
    const sqlEnums = [...allSql.matchAll(/CREATE TYPE "(\w+)"/g)].map((match) => match[1]);
    expect(sqlEnums).toHaveLength(34);
    expect([...new Set(sqlEnums)]).toHaveLength(34);
    expect([...sqlEnums].sort()).toEqual([...schemaEnums].sort());

    // The strong form: the same MEMBERS in the same ORDER for each of the twenty-seven. This is
    // what makes the single `ALTER TYPE … ADD VALUE` load-bearing — the joined list is compared
    // with the schema's, so the appended member has to be the one the schema declares last, on
    // the type the schema declares it on.
    const declared = Object.fromEntries(
      schemaEnums.map((name) => [name, schemaEnumMembers(schemaText, name)])
    );
    const joined = Object.fromEntries(
      schemaEnums.map((name) => [name, enumMembersOf(allSql, name)])
    );
    expect(joined).toEqual(declared);
    expect(schemaEnums.filter((name) => declared[name].length === 0)).toEqual([]);

    // And the addition EXTENDS a type this history already created: the members the joined
    // history carries that its own `CREATE TYPE` did not declare are exactly the appended ones,
    // so this names the type they extend and the member they append in one assertion. A
    // redefinition is impossible — a second `CREATE TYPE` under one name collides, and
    // `RENAME VALUE` is refused in B2.
    const appended = appendedMembersOf(allSql, schemaEnums);
    expect(appended).toEqual(['WorkflowTriggerEvent.AFTER_DOCUMENT_WORKFLOW_APPROVED']);
  });

  it('C3 — builds the same seventy-three indexes, on the same tables and the same columns', () => {
    expect(schemaIndexes).toHaveLength(90);
    expect(sqlIndexes).toHaveLength(91);

    // A name is used once and only once on each side: a reused name would let the join below
    // pair one index with a different index's shape and still compare equal.
    expect([...new Set(schemaIndexes.map(({ name }) => name))]).toHaveLength(90);
    expect([...new Set(sqlIndexes.map(({ name }) => name))]).toHaveLength(91);
    expect(
      schemaIndexes
        .filter((index) => !sqlIndexes.some((candidate) => candidate.name === index.name))
        .map(({ name }) => name)
    ).toEqual([]);
    // W4-D: ONE index exists on the SQL side alone — the partial UNIQUE on
    // `refund_compensation_payment_id` Prisma's @@index cannot express. It is
    // named here, deliberately, so a second unmodelled index cannot hide in
    // the same carve-out.
    expect(
      sqlIndexes
        .filter((index) => !schemaIndexes.some((candidate) => candidate.name === index.name))
        .map(({ name }) => name)
    ).toEqual(['ReturnLifecycleTransition_tenant_id_refund_compensation_key']);

    // Compared as `name|table|unique|columns` tuples: the schema lists FIELDS and the SQL lists
    // mapped COLUMNS, so the field list is translated the way Prisma translates it. An index
    // that keeps its name while its columns change fails here, where a name-only join would not.
    const modelled = schemaIndexes
      .map(
        ({ name, table, unique, fields }) =>
          `${name}|${table}|${unique}|${fields.map(snakeCaseOf).join(',')}`
      )
      .sort();
    const physical = sqlIndexes
      .filter(({ name }) => name !== 'ReturnLifecycleTransition_tenant_id_refund_compensation_key')
      .map(({ name, table, unique, columns }) => `${name}|${table}|${unique}|${columns.join(',')}`)
      .sort();
    expect(physical).toEqual(modelled);
  });

  it('C4 — gives every column a field, and the fourteen late columns no place in their CREATE TABLE', () => {
    // 262 before SUPPLIER MASTER DATA, +18 on the new `Supplier` table, +1
    // for `PriceQuotation.supplier_id` — the fourteenth late column — and +1
    // for `PurchaseDocument.status_changed_at` (W2-C), the fifteenth, and +1
    // for `ReturnLifecycleTransition.refunded_payment_id` (W3.1), the sixteenth.
    expect(schemaColumns).toHaveLength(351);
    expect(sqlColumns).toHaveLength(351);
    expect(addedColumns).toHaveLength(17);

    // The join at COLUMN granularity, both directions: the columns the `CREATE TABLE`
    // statements declare, plus the 14 the history added to tables that already existed.
    // Nothing the database holds is unmodelled, and nothing the schema maps is absent
    // from the database.
    const pairOf = (entry: { table: string; column: string }) => `${entry.table}.${entry.column}`;
    const mapped = schemaColumns.map(pairOf).sort();
    const created = sqlColumns.map(pairOf).sort();
    expect([...new Set(mapped)]).toHaveLength(351);
    expect([...new Set(created)]).toHaveLength(351);
    expect(created).toEqual(mapped);

    // And the PROVENANCE of the twelve: each is ABSENT from the `CREATE TABLE` that created its
    // table — so it arrived by ALTER, not by rewriting history — and each is an OPTIONAL mapped
    // field, so the migration added no NOT NULL to a table that already held rows.
    for (const { table, column } of addedColumns) {
      expect(tableBody(allSql, table)).not.toContain(`"${column}"`);
      const field =
        (modelList.find((model) => model.table === table)?.body ?? '')
          .split('\n')
          .find((line) => line.includes(`@map("${column}")`)) ?? '';
      expect(field).toContain(`@map("${column}")`);
      expect(field).toMatch(/\?\s+@/);
    }
  });

  it('C5 — reads one URL, through one provider, and constructs no second client', () => {
    // The datasource is the only place this database is NAMED, and it names it once: the
    // engine the history was written for, and a URL taken from the environment rather than
    // from any file under the module.
    const datasource = /^datasource db \{([\s\S]*?)^\}/m.exec(schemaText)?.[1] ?? '';
    expect(datasource).toContain('provider = "postgresql"');
    expect(datasource).toContain('url      = env("COMMERCE_DATABASE_URL")');
    expect([...schemaText.matchAll(/env\(/g)]).toHaveLength(1);

    // ONE provider of the health probe's client token under this module, and it is the module's
    // own client module: without it the Commerce datasource probe fails closed, and the first
    // provider is the first place a second connection could hide.
    const providers = sourceFiles.filter((file) =>
      /provide:\s*COMMERCE_PRISMA_CLIENT/.test(codeOf(readModule(file)))
    );
    expect(providers.map(relName)).toEqual(['database/commerce-prisma.module.ts']);

    // The one client is the generated COMMERCE client, and exactly one class extends it. No
    // file constructs a client of its own; no file reaches another owner's — not its client,
    // not its module, not its service; and the URL never appears as code in any of them, only
    // in the documentation that explains why it does not.
    const service = codeOf(readModule(join(MODULE_DIR, 'database', 'commerce-prisma.service.ts')));
    expect(service).toContain("import { PrismaClient } from '../../../generated/commerce-client';");
    expect(service).toContain('export class CommercePrismaService extends PrismaClient');

    expect(
      sourceFiles.filter((file) => FOREIGN_CLIENT_PATH.test(codeOf(readModule(file)))).map(relName)
    ).toEqual([]);
    expect(
      sourceFiles.filter((file) => FOREIGN_CLIENT_NAME.test(codeOf(readModule(file)))).map(relName)
    ).toEqual([]);
    expect(
      sourceFiles
        .filter((file) =>
          /new\s+(?:PrismaClient|CommercePrismaService)\b/.test(codeOf(readModule(file)))
        )
        .map(relName)
    ).toEqual([]);
    expect(
      sourceFiles
        .filter((file) => /COMMERCE_DATABASE_URL/.test(codeOf(readModule(file))))
        .map(relName)
    ).toEqual([]);
  });
});

/**
 * The TEN services that record audit history, one `await this.audit.record(actor, …)` per
 * command, all through the module's single `CommerceAuditGateway`. The service files that do
 * NOT are pinned beside them in `UNAUDITED_SERVICES`, each with the reason its silence is
 * allowed: the client and the rule-resolving service are asserted (D7) to perform no delegate
 * write of their own, and `workflow-execution.service.ts` carries the ONE documented exclusion
 * this suite's header names — its decision pipeline (`applyDecision`, the region both decide
 * shapes delegate to since PHASE C2) settles an instance and records no event — while C2's
 * inbox service is a read-only projection with no command to audit. D7 keeps
 * that gap a MEASURED fact (the region writes through repository methods and no trail follows)
 * instead of letting it hide inside a check that would otherwise have to read it as a failure.
 */
const AUDITED_SERVICES: readonly string[] = [
  'commercial/commercial-configuration.service.ts',
  'commercial/commercial-lifecycle.service.ts',
  // PHASE C4-R (GAP-3): both completion services record — the policy lifecycle's five
  // acts (created/updated/validated/published/archived) and the document's completion.
  'completion/purchase-completion-policy.service.ts',
  'completion/purchase-completion.service.ts',
  'payment/payment-history.service.ts',
  // PAYMENT PLAN: every mutating act records — create, submit, approve,
  // supersede, cancel, and the three stage acts; the money event itself stays
  // audited as `PAYMENT_RECORD` through the payment slice's own append trail.
  'payment-plan/payment-plan.service.ts',
  'purchase/purchase.service.ts',
  // PHASE GAP-6: the quotation service records both of its acts — version created
  // (outbox builder) and decision recorded (outbox payload).
  'quotation/quotation.service.ts',
  'receiving/receiving-history.service.ts',
  'returns/return-history.service.ts',
  // SUPPLIER MASTER DATA: the supplier service records both of its acts —
  // supplier created and supplier updated (outbox builders inside the unit of
  // work); its reads audit nothing (the module's read rule).
  'supplier/supplier.service.ts',
  'workflow/workflow-configuration.service.ts',
  'workflow/workflow-line-routing.service.ts',
];

/** The service files with no audit call, and the reason each absence is not a second gap. */
const UNAUDITED_SERVICES: readonly { readonly file: string; readonly because: string }[] = [
  {
    file: 'database/commerce-prisma.service.ts',
    because: 'infrastructure: it IS the client and writes nothing through it',
  },
  {
    file: 'workflow/workflow-line-routing-configuration.service.ts',
    because: 'it resolves rules and walks executions: no delegate write of its own',
  },
  {
    file: 'workflow/workflow-execution.service.ts',
    because: "the header's one documented exclusion: approveStep",
  },
  {
    file: 'pending/pending-decisions.service.ts',
    because: 'PHASE C2: a read-only projection — no delegate write, so no command to audit',
  },
  {
    file: 'purchase/purchase-timeline.service.ts',
    because:
      'PHASE C7: it READS the platform audit trail through the gateway — no delegate write and no command of its own, so there is nothing to record',
  },
  {
    file: 'purchase/purchase-history.service.ts',
    because:
      'PHASE W3.2: the aggregated traceability read — it READS status events, audit trail and posting diagnostics and writes nothing, so there is no command to record',
  },
  {
    file: 'search/commerce-search-source.service.ts',
    because:
      'PHASE C9: it READS commerce rows for the platform search authorization re-read and pushes projections to the platform INDEX — no delegate write, and search indexing is not an audited Commerce command (§50), so there is nothing to record',
  },
  {
    file: 'commerce-audit-outbox-relay.service.ts',
    because:
      'Phase B2.3: infrastructure relay — polls the local outbox and delivers through AUDIT_PORT; no business command, no audit.record call',
  },
  {
    file: 'integration/inventory-integration.service.ts',
    because:
      'Phase W2-B: integration plumbing — it plans/attempts posting records and the POSTED/FAILED bookkeeping is the durable evidence; the business act it follows (receipt append, return dispatch) is already audited by its own slice, and the stock effect is audited inventory-side',
  },
];

/**
 * The models a file WRITES through a Prisma delegate. The receiver is filtered by NAME against
 * the twenty generated delegates, so a service calling a repository METHOD that happens to be
 * called `create` — `this.purchases.create(…)` — is never read as a write of a model named
 * `purchases`. Nothing in the module is attributed to a table on the strength of a method name.
 */
function delegateWritesOf(source: string, delegates: readonly string[]): string[] {
  return [
    ...new Set(
      delegationsOf(source)
        .filter(
          (call) => delegates.includes(call.model) && WRITE_OPERATIONS.includes(call.operation)
        )
        .map((call) => call.model)
    ),
  ].sort();
}

/** The models a file READS through a delegate, by the same receiver-name filter. */
function delegateReadsOf(source: string, delegates: readonly string[]): string[] {
  return [
    ...new Set(
      delegationsOf(source)
        .filter(
          (call) => delegates.includes(call.model) && READ_OPERATIONS.includes(call.operation)
        )
        .map((call) => call.model)
    ),
  ].sort();
}

/**
 * The models a `parent` delegate's `create` calls put rows into BESIDE the parent's own row —
 * the child of a relation written as `lines: { create: … }` inside its `data`. The relation's
 * FIELD name is resolved against the parent's own `model` block (`lines ReceiptLine[]`), so the
 * scan reports the MODEL that receives the row rather than the field that spelled it:
 * `receiptLine`, never `lines`. A relation that does not resolve reads as `<parent>.<field>?`,
 * so a planted defect changes the list instead of silently shortening it.
 */
function nestedCreatesOf(source: string, parentDelegate: string): string[] {
  const parent = modelList.find(({ delegate }) => delegate === parentDelegate);
  if (!parent) return [];
  return callRegions(source, `${parentDelegate}.create(`).flatMap((region) =>
    [...region.matchAll(/(\w+):\s*\{\s*create:/g)].map((match) => {
      const relation = new RegExp(`^\\s{2}${match[1]}\\s+(\\w+)\\[\\]`, 'm').exec(parent.body)?.[1];
      return relation ? camelCaseOf(relation) : `${parentDelegate}.${match[1]}?`;
    })
  );
}

/**
 * Every reason a raw statement is refused, given the tables the file may name: the statement
 * must carry the tenant predicate, must BIND its values through `${…}` and never a concatenated
 * literal, and must name only tables its owner owns or the matrix lets it read. No refusal
 * returns none — which is not a pass by default, because D4 measures this list over the real
 * statements while E proves each refusal fires on a planted statement of its own kind.
 */
function rawViolationsOf(statements: readonly string[], allowed: ReadonlySet<string>): string[] {
  return statements.flatMap((statement) => {
    const refusals: string[] = [];
    if (!statement.includes('"tenant_id"')) refusals.push('unscoped');
    if (!statement.includes('${')) refusals.push('unbound');
    for (const match of statement.matchAll(/\b(?:FROM|INTO|UPDATE)\s+"(\w+)"/g)) {
      if (!allowed.has(match[1])) refusals.push(`foreign:${match[1]}`);
    }
    return refusals;
  });
}

/**
 * The operations the module refuses, per file: `findUnique` (it selects by primary key, not by
 * tenant) or `delete` on any of the twenty-one delegates, and any use of the Unsafe raw builders at
 * all. Returned as `<model>.<operation>` / `$RawUnsafe`, so D5's pin is a list of names.
 */
function refusedCallsOf(source: string, delegates: readonly string[]): string[] {
  const refused = delegationsOf(source)
    .filter(
      (call) =>
        delegates.includes(call.model) &&
        (call.operation === 'findUnique' || call.operation === 'delete')
    )
    .map((call) => `${call.model}.${call.operation}`);
  const unsafe = /\$(?:query|execute)RawUnsafe/.test(codeOf(source)) ? ['$RawUnsafe'] : [];
  return [...refused, ...unsafe].sort();
}

/** The delegate calls a file makes on the module's own models: `<delegate>.<operation>`, in order. */
function foreignDelegateCallsOf(source: string, delegates: readonly string[]): string[] {
  return delegationsOf(source)
    .filter((call) => delegates.includes(call.model))
    .map((call) => `${call.model}.${call.operation}`);
}

/**
 * How many audit interactions a file makes: `this.audit.record(` for best-effort events and
 * `this.audit.buildOutboxPayload(` for durable events (Phase B2.3). The module's two ways
 * to produce an audit trail — both through the single `CommerceAuditGateway`.
 */
const auditsOf = (source: string) => {
  const code = codeOf(source);
  return (
    [...code.matchAll(/this\.audit\.record\(/g)].length +
    [...code.matchAll(/this\.audit\.buildOutboxPayload\(/g)].length
  );
};

/**
 * The members a history APPENDS to its own `CREATE TYPE`s, as `Type.MEMBER` names: what the
 * joined history carries that the `CREATE TYPE` never declared. Named so `E` replays the exact
 * computation C2 compares, instead of a paraphrase that could keep passing on its own.
 */
function appendedMembersOf(sql: string, names: readonly string[]): string[] {
  return names.flatMap((name) =>
    enumMembersOf(sql, name)
      .filter((member) => !createdMembersOf(sql, name).includes(member))
      .map((member) => `${name}.${member}`)
  );
}

/**
 * D. The ownership matrix, checked against the code instead of against itself: the walk finds
 * the ten repositories, every delegate call in them is attributed to a table by NAME, the
 * writes reproduce the matrix's write lists file by file, the reads outside a file's own writes
 * are exactly the named seams, the twenty-nine models have one writer each across all three write
 * paths (delegate, nested create, raw statement), and the two operations the module refuses are
 * absent from every file it holds — including the ones outside `modules/commerce`.
 */
describe('D. the ownership matrix, replayed against the repository code', () => {
  it('D1 — wires every repository to the matrix, file by file and model by model', () => {
    // The walk names the repositories, so a tenth one — or a slice whose file was renamed —
    // fails here as an unequal list instead of going unread.
    expect(repositoryFiles.map(relName).sort()).toEqual(OWNERSHIP.map(({ file }) => file).sort());

    const delegateWrites = Object.fromEntries(
      repositoryFiles.map((file) => [
        relName(file),
        delegateWritesOf(readModule(file), delegateNames),
      ])
    );
    const delegateReads = Object.fromEntries(
      repositoryFiles.map((file) => [
        relName(file),
        delegateReadsOf(readModule(file), delegateNames),
      ])
    );

    // What a file writes through a delegate is the matrix's write list MINUS the models the
    // file writes through another path (D3 accounts for those three). A file that LOST a
    // delegate write — an update moved into a service, say — differs here even though its
    // `writes` list still names the model.
    expect(delegateWrites).toEqual(
      Object.fromEntries(
        OWNERSHIP.map(({ file, writes, writesWithoutDelegate }) => [
          file,
          writes.filter((model) => !writesWithoutDelegate.includes(model)).sort(),
        ])
      )
    );

    // Reading a model the file does not OWN is allowed only where a step contract named the
    // seam. The foreign reads are compared per file, so a new read appears in the list of the
    // file that added it, and a read that MOVED between files cannot hide inside a union.
    const owned = Object.fromEntries(OWNERSHIP.map(({ file, writes }) => [file, new Set(writes)]));
    const seams = Object.fromEntries(
      Object.entries(delegateReads).map(([file, models]) => [
        file,
        models.filter((model) => !owned[file].has(model)),
      ])
    );
    expect(seams).toEqual(
      Object.fromEntries(OWNERSHIP.map(({ file, reads }) => [file, [...reads].sort()]))
    );

    // And the seams as NAMES: seventeen (file → model) pairs, so each of them
    // is pinned where it can be read, not only counted. PHASE GAP-6 adds the
    // quotation slice's document-status read; SUPPLIER MASTER DATA adds the
    // supplier slice's two history reads; PHASE W3.2 adds the six reads the
    // aggregated history's read-only repository needs.
    expect(
      Object.entries(seams)
        .flatMap(([file, models]) => models.map((model) => `${file} → ${model}`))
        .sort()
    ).toEqual([
      'payment-plan/payment-plan.repository.ts → paymentRecord',
      'payment-plan/payment-plan.repository.ts → purchaseDocument',
      'payment/payment-history.repository.ts → purchaseDocument',
      'purchase/purchase-history.repository.ts → commercialApproval',
      'purchase/purchase-history.repository.ts → commercialAssignment',
      'purchase/purchase-history.repository.ts → inventoryPosting',
      'purchase/purchase-history.repository.ts → inventoryPostingAttempt',
      'purchase/purchase-history.repository.ts → paymentPlan',
      'purchase/purchase-history.repository.ts → paymentRecord',
      'purchase/purchase-history.repository.ts → priceQuotation',
      'purchase/purchase-history.repository.ts → purchaseLine',
      'purchase/purchase-history.repository.ts → receipt',
      'purchase/purchase-history.repository.ts → returnDocument',
      'quotation/quotation.repository.ts → purchaseDocument',
      'receiving/receiving-history.repository.ts → purchaseDocument',
      'receiving/receiving-history.repository.ts → purchaseLine',
      'returns/return-history.repository.ts → purchaseDocument',
      'returns/return-history.repository.ts → purchaseLine',
      'returns/return-history.repository.ts → receiptLine',
      'supplier/supplier.repository.ts → priceQuotation',
      'supplier/supplier.repository.ts → purchaseDocument',
      'workflow/workflow-execution.repository.ts → purchaseDocument',
      'workflow/workflow-execution.repository.ts → workflowDefinitionVersion',
    ]);
  });

  it('D2 — gives every one of the twenty-nine models exactly ONE writer file', () => {
    const writtenBy = Object.fromEntries(
      repositoryFiles.map((file) => {
        const source = readModule(file);
        const delegates = delegateWritesOf(source, delegateNames);
        const nested = delegates.flatMap((parent) => nestedCreatesOf(source, parent));
        const raw = rawSqlOf(source).some((statement) => statement.includes(RAW_WRITE.insert))
          ? [RAW_WRITE.model]
          : [];
        return [relName(file), [...delegates, ...nested, ...raw]];
      })
    );

    const writers = Object.fromEntries(
      delegateNames.map((model) => [
        model,
        Object.entries(writtenBy)
          .filter(([, models]) => models.includes(model))
          .map(([file]) => file)
          .sort(),
      ])
    );

    // One file per BUSINESS model, and the file the matrix names. A second writer — through a
    // delegate, a nested create or the raw upsert — lands in the same list as the owner and
    // makes it two entries long; an owner that stopped writing leaves the list empty.
    // EXCEPTION: `auditOutbox` is infrastructure shared across durable-required repositories
    // (Phase B2.3), not a business model, so it is excluded from the single-writer rule.
    const SHARED_INFRA_DELEGATES = ['auditOutbox'];
    const businessWriters = Object.fromEntries(
      Object.entries(writers).filter(([model]) => !SHARED_INFRA_DELEGATES.includes(model))
    );
    expect(businessWriters).toEqual(
      Object.fromEntries(
        delegateNames
          .filter((model) => !SHARED_INFRA_DELEGATES.includes(model))
          .map((model) => [
            model,
            OWNERSHIP.filter(({ writes }) => writes.includes(model))
              .map(({ file }) => file)
              .sort(),
          ])
      )
    );
    expect(Object.values(businessWriters).filter((files) => files.length !== 1)).toEqual([]);
    // auditOutbox is written by multiple durable-required repositories — the six
    // durable writers (purchase, commercial lifecycle, payment, returns, GAP-6
    // quotation, and the supplier directory).
    expect(writers['auditOutbox']).toHaveLength(6);

    // The ten `writes` lists cover every delegate: every business model is owned once, and
    // `auditOutbox` is shared across durable-required repositories (Phase B2.3).
    const allWrites = [...new Set(OWNERSHIP.flatMap(({ writes }) => writes))].sort();
    expect(allWrites).toEqual([...delegateNames].sort());

    // The three models a large part of this suite exists for: the ones no delegate statement
    // names. Each is pinned beside the path that DOES write it — the two nested sites and the
    // one raw upsert — and D3 replays those paths from the code.
    expect(OWNERSHIP.flatMap(({ writesWithoutDelegate }) => writesWithoutDelegate).sort()).toEqual([
      'purchaseDocumentCounter',
      'quotationLine',
      'receiptLine',
      'returnLine',
    ]);
  });

  it('D3 — writes through the nested sites and the raw statement only where the matrix says', () => {
    // The nested sites, discovered rather than listed: for every delegate a file CREATES, the
    // children written inside that create's `data`. The pairs D discovers must be the pairs
    // NESTED_CREATES names — nothing more (a fourth nested write is a second, unrecorded path
    // into a table) and nothing less (a vanished site leaves its model written by nobody).
    const nested = repositoryFiles.flatMap((file) => {
      const source = readModule(file);
      return delegateWritesOf(source, delegateNames).flatMap((parent) =>
        nestedCreatesOf(source, parent).map((model) => ({ file: relName(file), parent, model }))
      );
    });
    expect(nested).toEqual([...NESTED_CREATES]);

    // The ONE raw statement that writes, tenant-safe the way the counter's key demands: the
    // conflict target is the composite `(tenant_id, kind, jalali_year)`, so two tenants may
    // award number N in the same year concurrently and each increment lands on its own row.
    const rawWrite = rawSqlOf(readModule(join(MODULE_DIR, RAW_WRITE.file))).filter((statement) =>
      statement.includes(RAW_WRITE.insert)
    );
    expect(rawWrite).toHaveLength(1);
    expect(rawWrite[0]).toContain(RAW_WRITE.conflict);
    expect(rawWrite[0]).toContain(RAW_WRITE.returning);

    // That statement is why the counter needs no delegate: the purchase repository owns the
    // model, and this is the only file whose text names the table in a write at all.
    const rawOwners = repositoryFiles
      .filter((file) =>
        rawSqlOf(readModule(file)).some((statement) => statement.includes(RAW_WRITE.insert))
      )
      .map(relName);
    expect(rawOwners).toEqual([RAW_WRITE.file]);
  });

  it('D4 — replays the three raw statements and finds nothing to refuse', () => {
    // Every raw template in the module, file by file. The SET of files is pinned as well as the
    // count, so a fourth hand-written statement — the easiest way to slip past a scan that only
    // reads delegate calls — cannot join the module and leave this list looking unchanged.
    const statements = Object.fromEntries(
      repositoryFiles.map((file) => [relName(file), rawSqlOf(readModule(file))])
    );
    const nonEmpty = Object.entries(statements).filter(([, found]) => found.length > 0);
    expect(nonEmpty.map(([file]) => file)).toEqual([
      'payment/payment-history.repository.ts',
      'purchase/purchase.repository.ts',
      'receiving/receiving-history.repository.ts',
      'returns/return-history.repository.ts',
    ]);
    expect(nonEmpty.flatMap(([, found]) => found)).toHaveLength(6);

    // The matrix lists MODELS (delegate names); a raw statement names TABLES. The two are
    // joined through the schema before the comparison, so an owner is allowed its own table
    // and a seam is allowed the table the model it reads maps to. The refusals come back
    // EMPTY — nothing unscoped, nothing unbound, nothing pointing at a table the file may not
    // name — and E proves each refusal fires on a planted statement of its own kind.
    const tableOf = (model: string) =>
      modelList.find(({ delegate }) => delegate === model)?.table ?? model;
    const refused = Object.entries(statements).flatMap(([file, found]) => {
      const slice = OWNERSHIP.find((owner) => owner.file === file);
      expect(slice).toBeDefined();
      return rawViolationsOf(
        found,
        new Set([...slice!.writes.map(tableOf), ...slice!.reads.map(tableOf)])
      );
    });
    expect(refused).toEqual([]);
  });

  it('D5 — finds the refused operations nowhere, including outside the repositories', () => {
    // `findUnique` — it selects by primary key, not by tenant — and `delete` are counted
    // wherever they appear on one of the twenty-one delegates, and the Unsafe raw builders
    // anywhere in a module file. The list is EMPTY: either operation, or a template that skips
    // the parameterised raw builders, is exactly what this suite exists to catch.
    const refused = sourceFiles.flatMap((file) =>
      refusedCallsOf(readModule(file), delegateNames).map((call) => `${relName(file)} → ${call}`)
    );
    expect(refused).toEqual([]);

    // Both refusals are operations `delegationsOf` can SEE: `findUnique` is listed among the
    // reads and `delete` among the writes precisely so they are counted here and refused. Drop
    // either from the split and this test goes quietly vacuous, so the listing is pinned.
    expect(DELEGATE_OPERATIONS).toEqual(expect.arrayContaining(['findUnique', 'delete']));
  });

  it('D6 — finds no Commerce delegate call, and no writer, outside modules/commerce', () => {
    // EVERY `.ts` file the API holds outside the module — other modules, infrastructure, their
    // specs — read through the same name filter. The list is EMPTY: no file outside reaches a
    // Commerce table through a delegate, so the tables are unreachable from the rest of the
    // application except through the seams this suite pins. Generated files are excluded for
    // the reason they are generated: the client names every table because it implements them.
    // Phase B2.3: `auditOutbox` is a delegate name shared by Commerce AND Financial (each
    // context has its own `AuditOutbox` table in its own datasource). Exclude it from the
    // cross-module check — Financial's usage of its own `auditOutbox` is not a Commerce leak.
    const crossModuleDelegates = delegateNames.filter((name) => name !== 'auditOutbox');
    const apiSource = join(MODULE_DIR, '..', '..');
    const outside = walk(apiSource)
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.startsWith(MODULE_DIR) &&
          !file.includes('generated') &&
          !file.includes('node_modules')
      )
      .flatMap((file) =>
        foreignDelegateCallsOf(readModule(file), crossModuleDelegates).map(
          (call) => `${relative(apiSource, file).replace(/\\/g, '/')} → ${call}`
        )
      );
    expect(outside).toEqual([]);

    // And inside the module, only a repository writes: a service that reached a delegate
    // directly — skipping its slice's repository — would be one writer too many even though it
    // lives where it belongs.
    // Phase B2.3: the relay service writes `auditOutbox` directly (delete on delivery,
    // update for retry scheduling) — it is infrastructure, not a business service.
    const RELAY_SERVICE = 'commerce-audit-outbox-relay.service.ts';
    expect(
      sourceFiles
        .filter((file) => !file.endsWith('.repository.ts') && !file.endsWith(RELAY_SERVICE))
        .flatMap((file) =>
          delegateWritesOf(readModule(file), delegateNames).map(
            (model) => `${relName(file)} → ${model}`
          )
        )
    ).toEqual([]);
  });

  it('D7 — accounts for every service file: twelve carry the trail, five are pinned apart', () => {
    // The service files are discovered, and the two lists must COVER them: a new service lands
    // in neither list and fails here before anything can be assumed about what it records.
    const serviceFiles = sourceFiles.filter((file) => file.endsWith('.service.ts'));
    expect(serviceFiles.map(relName).sort()).toEqual(
      [...AUDITED_SERVICES, ...UNAUDITED_SERVICES.map(({ file }) => file)].sort()
    );

    // The ten are exactly the files whose text records an event, and the recording goes
    // through the one gateway: each names it and calls `this.audit.record(`. A service that
    // started waking the gateway appears in the first list; one that stopped, in the second.
    const withTrail = serviceFiles
      .filter((file) => auditsOf(readModule(file)) > 0)
      .map(relName)
      .sort();
    expect(withTrail).toEqual([...AUDITED_SERVICES].sort());
    for (const file of AUDITED_SERVICES) {
      const source = codeOf(readModule(join(MODULE_DIR, file)));
      expect(source).toContain('CommerceAuditGateway');
      // Phase B2.3: services may use record() for non-durable events and/or
      // buildOutboxPayload() for durable events — at least one must be present.
      const hasRecord = source.includes('this.audit.record(');
      const hasOutbox = source.includes('this.audit.buildOutboxPayload(');
      expect(hasRecord || hasOutbox).toBe(true);
    }

    // The FOUR silences, each with a reason D7 can MEASURE. The client: it IS the client —
    // the class extends it, writes nothing through a delegate of its own, and records nothing
    // because it decides nothing. The rule-resolving service: it reads executions and resolves
    // rule sets, with no delegate write in its own code, so there is no event of its own to
    // record.
    expect(
      codeOf(readModule(join(MODULE_DIR, 'database', 'commerce-prisma.service.ts')))
    ).toContain('extends PrismaClient');
    expect(
      delegateWritesOf(
        codeOf(readModule(join(MODULE_DIR, 'database', 'commerce-prisma.service.ts'))),
        delegateNames
      )
    ).toEqual([]);

    const routing = codeOf(
      readModule(join(MODULE_DIR, 'workflow', 'workflow-line-routing-configuration.service.ts'))
    );
    expect(delegateWritesOf(routing, delegateNames)).toEqual([]);
    expect(auditsOf(routing)).toBe(0);

    // THE THIRD. The decision region used to be `approveStep`'s own body; PHASE C2 factored
    // the shared pipeline into `applyDecision` (approveShape and decideShape both delegate to
    // it), and it is now THAT region which writes the decision and settles the instance
    // through the execution repository with NO event following — the one exclusion the D
    // preamble records. Both halves are pinned, so the day an append lands in that region
    // this test says so: the write is there to lose, and no trail accompanies it.
    const execution = codeOf(
      readModule(join(MODULE_DIR, 'workflow', 'workflow-execution.service.ts'))
    );
    expect(auditsOf(execution)).toBe(0);
    const start = execution.indexOf('private async applyDecision(');
    expect(start).toBeGreaterThan(-1);
    const end = execution.indexOf('\n  private isLastGroup', start + 1);
    const body = execution.slice(start, end < 0 ? execution.length : end);
    expect(body).toContain('recordStepDecision(');
    expect(body).not.toContain('this.audit.record(');

    // PHASE C7's silence, measured the same way: the timeline service reads the trail
    // (`this.audit.read(`) and must record nothing and write nothing — a `.record(` or a
    // delegate write appearing in it would mean Commerce had started authoring audit
    // events of its own or touching a model it does not own.
    const timeline = codeOf(
      readModule(join(MODULE_DIR, 'purchase', 'purchase-timeline.service.ts'))
    );
    expect(auditsOf(timeline)).toBe(0);
    expect(delegateWritesOf(timeline, delegateNames)).toEqual([]);
    expect(timeline).toContain('this.audit.read(');
    expect(timeline).toContain('CommerceAuditGateway');

    // PHASE C9's silence, measured the same way: the search source adapter reads the
    // authority (the repository) and pushes to the platform INDEX (`handle.project`) —
    // both are non-recorded by design (search indexing is not an audited Commerce
    // command), and it must write through NO delegate of its own and call no audit
    // surface; a delegate write or a `.record(` appearing in it would mean Commerce had
    // started touching a model it does not own or writing a trail from search.
    const adapter = codeOf(
      readModule(join(MODULE_DIR, 'search', 'commerce-search-source.service.ts'))
    );
    expect(auditsOf(adapter)).toBe(0);
    expect(delegateWritesOf(adapter, delegateNames)).toEqual([]);
    expect(adapter).toContain('this.handle.project(');
    expect(adapter).toContain('findDocumentSearchRowsByIds');
  });
});

/**
 * E. The scans above, taken to their own failures. Every check in this file is a scan compared
 * against a pinned list; a scan that cannot fail is not a check but a decoration, and the
 * cheapest way to fake compliance is a scan whose pattern no longer matches ANYTHING — then
 * its empty result reads as a pass. Each test below hands the very function a check runs a
 * planted defect of its own kind and requires the function to CHANGE its answer, so each
 * check's green result is a measurement rather than a silence. The planted inputs are string
 * fixtures and never files: nothing here can change what a check reads from the module.
 */
describe('E. every scan fails on a planted defect of its own kind', () => {
  it('E1 — the forbidden-SQL list fires on a planted statement, and the strip is load-bearing', () => {
    // The statement the list exists for: a DELETE, planted beside an ALTER TABLE that must NOT
    // fire — additions are allowed, removals are not.
    const planted =
      'ALTER TABLE "PurchaseDocument" ADD COLUMN "note" text;\nDELETE FROM "PurchaseLine" WHERE "tenant_id" = 1;\n';
    const fired = FORBIDDEN_SQL.filter(({ pattern }) => pattern.test(sqlCode(planted)));
    expect(fired).toHaveLength(1);
    expect(fired[0].pattern.test('DELETE FROM "PurchaseLine"')).toBe(true);

    // And the comment strip is load-bearing too: the same DELETE quoted in a comment is NOT
    // executable SQL, so the scan that fires above stays silent on the prose that explains it.
    const quoted =
      '-- DELETE FROM "PurchaseLine" is refused; add instead.\nALTER TABLE "PurchaseDocument" ADD COLUMN "note" text;\n';
    expect(sqlCode(quoted)).not.toContain('DELETE');
    expect(FORBIDDEN_SQL.filter(({ pattern }) => pattern.test(sqlCode(quoted)))).toEqual([]);
  });

  it('E2 — the enum join separates the CREATE TYPE list from the members a history appends', () => {
    // The split C2 compares along, replayed: what `CREATE TYPE` declared, what the joined
    // history carries, and the difference the appended-member pin is made of.
    const one =
      'CREATE TYPE "WorkflowTriggerEvent" AS ENUM (\'SUBMITTED\');\n' +
      'ALTER TYPE "WorkflowTriggerEvent" ADD VALUE \'APPROVED\';\n';
    expect(createdMembersOf(one, 'WorkflowTriggerEvent')).toEqual(['SUBMITTED']);
    expect(enumMembersOf(one, 'WorkflowTriggerEvent')).toEqual(['SUBMITTED', 'APPROVED']);
    expect(appendedMembersOf(one, ['WorkflowTriggerEvent'])).toEqual([
      'WorkflowTriggerEvent.APPROVED',
    ]);

    // A SECOND appended member where the real history appends one makes C2's equality fail:
    // the check can fail, so its pass is a measurement.
    const two = one + 'ALTER TYPE "WorkflowTriggerEvent" ADD VALUE \'REJECTED\';\n';
    expect(appendedMembersOf(two, ['WorkflowTriggerEvent'])).toEqual([
      'WorkflowTriggerEvent.APPROVED',
      'WorkflowTriggerEvent.REJECTED',
    ]);
  });

  it('E3 — the writer scan attributes by receiver, and the read/write split is real', () => {
    // A write is a write because its RECEIVER is one of the twenty-one delegates. A service method
    // merely NAMED `create` is not one — the false positive the receiver filter exists for.
    expect(delegateWritesOf('await this.purchases.create({ data });', delegateNames)).toEqual([]);
    expect(
      delegateWritesOf('await tx.purchaseDocument.update({ where, data });', delegateNames)
    ).toEqual(['purchaseDocument']);
    expect(
      delegateReadsOf('await tx.purchaseDocument.findMany({ where });', delegateNames)
    ).toEqual(['purchaseDocument']);
    expect(
      delegateWritesOf('await tx.purchaseDocument.findMany({ where });', delegateNames)
    ).toEqual([]);

    // And on the real code: the payment repository READS its seam's document without writing
    // it, so the two functions cannot both be answering the same question.
    const payment = readModule(join(MODULE_DIR, 'payment', 'payment-history.repository.ts'));
    expect(delegateReadsOf(payment, delegateNames)).toContain('purchaseDocument');
    expect(delegateWritesOf(payment, delegateNames)).not.toContain('purchaseDocument');
  });

  it('E4 — the nested-create scan names the model, not the field, and flags what it cannot resolve', () => {
    // `lines` and `orphan` are FIELD names; only the first points at a model this schema
    // knows, and the scan answers accordingly — the model for the resolvable one, a marked
    // entry for the one a planted field invented.
    const fixture =
      'await tx.receipt.create({ data: { lines: { create: rows }, orphan: { create: rows } } });';
    expect(nestedCreatesOf(fixture, 'receipt')).toEqual(['receiptLine', 'receipt.orphan?']);

    // And on the real code: the receiving repository's `receipt.create` is the nested site the
    // matrix names, and `lines — the field it is written through — appears nowhere in the
    // answer, because the scan reports what RECEIVES the row.
    const receiving = readModule(join(MODULE_DIR, 'receiving', 'receiving-history.repository.ts'));
    expect(nestedCreatesOf(receiving, 'receipt')).toEqual(['receiptLine']);
  });

  it('E5 — the raw-statement refusals fire one by one', () => {
    const allowed = new Set(['PurchaseDocument']);
    expect(
      rawViolationsOf(['SELECT "id" FROM "PurchaseDocument" WHERE "id" = ${id}'], allowed)
    ).toEqual(['unscoped']);
    expect(
      rawViolationsOf(['SELECT "id" FROM "PurchaseDocument" WHERE "id" = 1'], allowed)
    ).toEqual(['unscoped', 'unbound']);
    expect(
      rawViolationsOf(['SELECT "id" FROM "OtherTable" WHERE "tenant_id" = ${id}'], allowed)
    ).toEqual(['foreign:OtherTable']);
    expect(
      rawViolationsOf(['SELECT "id" FROM "PurchaseDocument" WHERE "tenant_id" = ${id}'], allowed)
    ).toEqual([]);

    // The reader behind the scan takes the PARAMETERISED builders' templates and leaves the
    // Unsafe ones out: using one of those is refused outright, in E6.
    expect(rawSqlOf('await tx.$queryRaw(`SELECT ${id} FROM "PurchaseDocument"`);')).toEqual([
      'SELECT ${id} FROM "PurchaseDocument"',
    ]);
    expect(rawSqlOf('await tx.$executeRawUnsafe(`DELETE FROM "PurchaseDocument"`);')).toEqual([]);
  });

  it('E6 — the refused operations fire, and an allowed read stays silent', () => {
    expect(
      refusedCallsOf('await tx.purchaseDocument.findUnique({ where });', delegateNames)
    ).toEqual(['purchaseDocument.findUnique']);
    expect(refusedCallsOf('await tx.purchaseDocument.delete({ where });', delegateNames)).toEqual([
      'purchaseDocument.delete',
    ]);
    expect(refusedCallsOf('await tx.$executeRawUnsafe(`DELETE FROM "X"`);', delegateNames)).toEqual(
      ['$RawUnsafe']
    );
    expect(refusedCallsOf('await tx.purchaseDocument.findMany({ where });', delegateNames)).toEqual(
      []
    );
  });

  it('E7 — the outside-the-module scan fires on a foreign delegate and ignores a service method', () => {
    // The same receiver filter that keeps the module's scans honest decides what a file
    // OUTSIDE the module is guilty of: reaching a Commerce delegate at all.
    expect(
      foreignDelegateCallsOf('await prisma.purchaseDocument.findMany({ where });', delegateNames)
    ).toEqual(['purchaseDocument.findMany']);
    expect(foreignDelegateCallsOf('await this.purchases.create({ data });', delegateNames)).toEqual(
      []
    );
  });

  it('E8 — the audit scan counts the gateway call and ignores the same words in prose', () => {
    expect(auditsOf('await this.audit.record(actor, { action: "purchase.draft.created" });')).toBe(
      1
    );
    expect(
      auditsOf(
        '// this.audit.record( is documented here.\nawait this.purchases.append(actor, data);'
      )
    ).toBe(0);
  });

  it('E9 — the added-columns scan reads the padded clause Prisma writes', () => {
    // Prisma pads the clauses of a multi-clause `ALTER TABLE` — `ADD COLUMN     "x"` — and the
    // one-space spelling that once read this scan matched NOTHING, which made C4's provenance
    // check pass over an empty list. The padded statement goes to the very function C4 runs,
    // and the fourteen late additions the real history carries come back as fourteen.
    const padded = 'ALTER TABLE "PurchaseDocument" ADD COLUMN     "delivery_date" TIMESTAMP(6);';
    expect(addedColumnsOf(padded)).toEqual([
      { table: 'PurchaseDocument', column: 'delivery_date' },
    ]);
    expect(/ADD COLUMN "/.test(padded)).toBe(false);
    expect(addedColumnsOf(allSql)).toHaveLength(17);
  });

  it('E10 — the route/permission pairing fails the moment a handler drops its gate', () => {
    // The pairing A5 checks, replayed: drop the second handler's `@Roles(…)` and the two
    // counts diverge — two routes, one permission — which is exactly the failure the check is
    // built to see.
    const gated =
      '@Get("a")\n@Roles(Permissions.COMMERCE_READ)\nasync a() {}\n@Post()\n@Roles(Permissions.COMMERCE_READ)\nasync b() {}';
    const dropped =
      '@Get("a")\n@Roles(Permissions.COMMERCE_READ)\nasync a() {}\n@Post()\nasync b() {}';
    expect(routesOf(gated)).toHaveLength(2);
    expect(permissionsOf(gated)).toHaveLength(2);
    expect(routesOf(dropped)).toHaveLength(2);
    expect(permissionsOf(dropped)).toHaveLength(1);
  });

  it('E11 — the schema walk reports the table a model does NOT state', () => {
    // C1 requires every model to state its table; the same `@@map` lookup `modelList` applies
    // answers `''` for a model that does not, and that empty table is the entry the check
    // fails on — never a model read under a name the schema never chose.
    expect(
      modelBlocks('model X {\n  id String @id\n}\n').map(({ name, body }) => ({
        name,
        table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? '',
      }))
    ).toEqual([{ name: 'X', table: '' }]);
  });
});
