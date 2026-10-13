# PHASE C4-R — COMMERCE / PROCUREMENT
# CONFIGURABLE PURCHASE COMPLETION POLICY + `CLOSED` TRANSITION
# ARCHITECTURE-FIRST / NO-GUESS

**Repository:** `E:\ERP` · **Phase:** C4-R (backend + minimal existing settings integration) ·
**Status:** `COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-3 CONFIGURABLE COMPLETION POLICY`

**Authority, in order:** `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (§5.11, §22, §26, §29),
`docs/PHASE-C1-EXECUTION-PROMPT.md` (§13, §14, §19), the step contracts (L/M/N/O/P/Q/R/S), then
`docs/PHASE-C2-…`, `docs/PHASE-C3-…`, `docs/PHASE-C4-CLOSED-TRANSITION-CONTRACT.md` (the blocking
discovery) and `docs/PHASE-UI-0-…` / `docs/PHASE-UI-5-…`. Code, schema and executable tests are
evidence of what exists, never a source of new business rules.

**Classification tags used below:** `[CONFIRMED]` (stated by an authoritative source),
`[DERIVED]` (forced by an existing artifact, with the reasoning shown), `[PROPOSED]` (a choice this
phase makes and documents so it can be reviewed), `[UNKNOWN]`, `[DECISION REQUIRED]`.

---

## A. THE PROBLEM — `[CONFIRMED]`

Phase C4 stopped before writing any code, and its contract records exactly why: C1 §29 defines
purchase completion's **effects** and forbids three false equivalences, but **no authoritative
document states** (D1) which statuses a document may be completed FROM, (D2) which permission
authorises it, (D3) what (if any) prerequisites it has, (D4/D5) whether `CLOSED` is terminal and
what the wire shape is. `purchase-status.ts` records the gap in its own table: `→ CLOSED` is absent
*"because completion is an explicit business event whose precondition, permission and owner no
document in C1 states"*.

C4-R does **not** answer D1 by choosing. It removes D1 from the codebase's authority by making the
question **configuration**: the tenant's *Purchase Completion Policy* decides which statuses may be
completed, and the backend evaluates that policy — never a constant — when the completion act runs.

## B. WHY A HARD-CODED `CLOSED` WAS REJECTED — `[CONFIRMED]`

- `APPROVED → CLOSED` is one of the D1 *options* the C4 contract lists (Option A) — never a stated
  rule. Writing it would have invented a business rule in the same act that claimed to implement one.
- The alternative ("no prerequisites, unconditional close") is Option C — equally unstated:
  *"choosing 'unconditional' invents a rule as surely as choosing 'APPROVED-only' does"* (C4 §D).
- So the transition became **an explicit, versioned, product-owned configuration** with a
  fail-closed default: no policy ⇒ no completion. That is the shape this phase implements.

## C. THE AUTHORITATIVE MEANING OF `CLOSED` — `[CONFIRMED]`

C1 §29, read verbatim: purchase completion is *"a distinct business event"*; when it happens,
**normal editing is locked**, the **completion actor is recorded**, the **completion timestamp is
recorded**, the **completion state is persisted/projected**, **history is preserved**, and
**later payments continue on the same purchase**; *"final completion must be explicit"*; and three
independence statements — *"Payment completion is NOT purchase completion. Receiving completion is
NOT purchase completion. Workflow completion is NOT purchase completion."* The schema's own note
adds `CLOSED — the purchase has run its course`, and §5.11 fixes the owner as
`PurchaseDocument.status`, not any other lifecycle's state.

## D. POLICY OWNERSHIP — `[CONFIRMED]`

| Concern | Owner | Evidence |
|---|---|---|
| identity, RBAC, permissions, entitlement | Core / platform | C1 §10, the entitlement decorators every Commerce controller carries |
| the completion POLICY (what state may be completed) | Commerce | §E–§H of this contract |
| the completion ACT (the conditional write + its records) | Commerce | §M |
| configuration *presentation* | the existing Platform Settings Center | §W |

Business meaning stays in Commerce; security stays in Core/RBAC. No permission table, role
vocabulary or dynamic RBAC is created inside Commerce, and no prerequisite vocabulary is invented.

## E. CONFIGURABLE DIMENSIONS — each classified from source

| # | Dimension | Classification | Why (source) |
|---|---|---|---|
| A | **Allowed source status(es)** — `allowedFromStatuses` | **[CONFIRMED CONFIGURABLE]** | The P contract's recorded gap is literally *"from which statuses"*; the candidate set is the document's OWN §5.11 vocabulary (`PURCHASE_COMPLETION_SOURCE_STATUSES` = the six members minus the destination). The product chooses the subset; the code chooses nothing. |
| B | Business prerequisites | **[NOT SUPPORTED — §F]** | No source states any. C4 §D records each candidate as *"FORBIDDEN as an implication"* / *"NOT a source-defined prerequisite"*, and the C4-R brief's §8 forbids coupling lifecycles by assumption. The model therefore has **no field for one**. |
| C | Completion authority / eligibility | **[CONFIRMED FIXED]**, not configurable | No Commerce-owned actor relationship exists for completion (`PurchaseDocument` has no approver/liaison column; the "actor rule" precedents live on workflow steps and commercial approvals). Identity/RBAC cannot move into Commerce, so eligibility beyond authorization is not modelled. |
| D | Terminality | **[CONFIRMED FIXED: terminal]** | `PURCHASE_DOCUMENT_TRANSITIONS.CLOSED = []`, and no writer exists or is defined for any outgoing edge. |
| E | Reversibility | **[CONFIRMED FIXED: not reversible]** | Same evidence: no outgoing edge, no reopen route, no source. |
| F | Effective/versioning behaviour | **[CONFIRMED]**, reused rather than invented | The module's established version lifecycle (`WorkflowDefinitionVersionStatus`: DRAFT → VALIDATED → PUBLISHED → ARCHIVED) with the commercial configuration's single-published invariant, plus the established **pin on `PurchaseDocument`** (`commercialConfigurationVersionId` / `lineRoutingVersionId` precedent). |

## F. NON-CONFIGURABLE DIMENSIONS — the required record for every candidate

**Condition: document workflow completion (a terminal document-scope run)**
Source: `WorkflowInstance.status` (with `subjectType = DOCUMENT`) — `workflow-run-status.ts`.
Meaning: the workflow's own lifecycle, independent of the document's.
Valid values: the run's vocabulary (never `PurchaseDocumentStatus`).
Evaluation: a read of `WorkflowInstance` by `(subjectType, subjectId)`.
What does NOT count: nothing is evaluated — a run being `APPROVED` is workflow state, and P11 states
*"workflow-approved never implies closed"*; no source makes a terminal run a completion precondition.
→ **[DECISION REQUIRED]** (product must state it *and* a source must establish the relationship).

**Condition: payment state (`PAID`, or ≥ an amount)**
Source: the document-level projection `projectPaymentStatus(totalAmount, paidAmount)`.
Meaning: `UNPAID / PARTIAL / PAID / OVERPAID` are projections of append-only `PaymentRecord` rows.
Valid values: those four, or `null` (no total stated yet).
Evaluation: deterministic, cheap, already implemented for the payments read.
What does NOT count: §29 says payment completion is *not* purchase completion, and Q6 allows payments
on any status — including `CLOSED`. "Paid before closed" is explicitly NOT a source-defined
prerequisite (C4 §D). → **[DECISION REQUIRED]**; the brief §8 forbids implementing it because it
sounds reasonable.

**Condition: receiving state (`FULLY_RECEIVED`)**
Source: `projectReceivingStatus(ordered, received)` — **line-level only** (R5).
Meaning: a per-line projection of append-only receipt events.
Valid values: `NOT_RECEIVED / PARTIALLY_RECEIVED / FULLY_RECEIVED`.
Evaluation: no authoritative DOCUMENT-level aggregation exists; a document-level "fully received"
would be a new rule this phase would have to invent.
What does NOT count: §29's receiving independence; R §3-I (reciprocal). → **[NOT SUPPORTED]** as a
condition (ambiguous at document scope).

**Condition: no open returns**
Source: `ReturnState` per return + `ReturnLifecycleTransition` history.
Meaning: each return walks its own child lifecycle.
Valid values: `REQUESTED / APPROVED / RECEIVED_BACK / REFUNDED / REJECTED`.
Evaluation: "open" is **not defined** anywhere; choosing the terminal states would be an invented
interpretation of the return lifecycle at the document level.
What does NOT count: S §12 (a return NEVER changes `PurchaseDocument.status`). → **[NOT SUPPORTED]**
(ambiguous); **[DECISION REQUIRED]** if the product wants it.

**Condition: commercial approval / "commercial completion"**
Source: the commercial projection (`commercial-projection.ts`) — which writes
`SUBMITTED → APPROVED | REJECTED` on the very column this policy governs.
Meaning: it is the document's own status.
Evaluation: already representable as `allowedFromStatuses: ['APPROVED']`.
What does NOT count: there is no separate fact to evaluate. → **[NOT A SEPARATE CONDITION]**.

**The rule this phase applied:** a condition is exposed only when it (1) exists, (2) has
authoritative semantics, (3) is safe and deterministic to evaluate, (4) has a stable state
representation — **and** (5) the source establishes it as a completion relationship. Nothing passed
(5), so nothing is exposed; the consequence is stated in the UI as a sentence rather than hidden as
a disabled toggle (§W).

## G. THE POLICY SCHEMA — `[CONFIRMED]` shape, `[DERIVED]` model

**Stored row — `PurchaseCompletionPolicyVersion`** (one new table; the smallest correct model):

| Column | Type | Meaning |
|---|---|---|
| `id` | `UUID` PK | row identity |
| `tenant_id` | `TEXT` | the owning tenant — first in every key, as everywhere in this database |
| `status` | `WorkflowDefinitionVersionStatus` default `DRAFT` | the ESTABLISHED lifecycle enum, reused (no new type) |
| `version_label` | `VARCHAR(64)` | the tenant's own label; unique inside the tenant |
| `allowed_from_statuses` | `JSONB` | THE POLICY: a non-empty array of `PurchaseDocumentStatus` members, each drawn from `PURCHASE_COMPLETION_SOURCE_STATUSES` |
| `created_at` / `updated_at` | `TIMESTAMPTZ(6)` | as every configuration row |

Indexes: `UNIQUE (tenant_id, id)` (the FK target), `UNIQUE (tenant_id, version_label)`,
`INDEX (tenant_id, status)` (the published read). RESTRICT relation from `PurchaseDocument`.

**Why JSON for the set — `[DERIVED]`:** the value is a candidate LIST, exactly like `routeRules`
(routing) and `assignmentRules` (commercial); the module's three existing configuration rows all
store their lists as JSON validated against a frozen allowlist. The allowlist is enforced in three
places (DTO `@IsIn`, publish checklist, completion evaluator) — see §H.

**Document columns — `[DERIVED]` from C1 §29 + the existing pin pattern:**

| Column | Type | Why |
|---|---|---|
| `completed_by_user_id` | `TEXT` NULL | §29's *completion actor* — opaque Core id, server-resolved, never client-supplied |
| `completed_at` | `TIMESTAMPTZ(6)` NULL | §29's *completion timestamp* — written once, inside the conditional write |
| `completion_policy_version_id` | `UUID` NULL, FK `(tenant_id, id)` RESTRICT | which policy authorised the completion — the same pin shape as `commercialConfigurationVersionId` / `lineRoutingVersionId` |

The projection exposes the first two (`completedByUserId`, `completedAt`) and deliberately NOT the
pin — the two existing pins are not on the wire either; the pin is what the settings surface reads
from the policy resource.

**Deliberately added by nothing:** no default policy row, no prerequisite columns, no `reopened_at`,
no audit table, no second status vocabulary.

## H. VALIDATION — `[CONFIRMED]`

`completionPolicyIssues(raw)` (pure) is the ONE checklist; it returns a LIST of reasons (never a
throw), so the same function answers the routes and can be exercised exhaustively:

1. **not an array** → refused;
2. **a member outside `PURCHASE_COMPLETION_SOURCE_STATUSES`** (including `CLOSED`, `PAID`,
   `FULLY_RECEIVED` or an invented string) → refused, naming the member;
3. **an empty set** → refused (a policy that could complete nothing is a contradiction dressed as
   configuration; the honest spelling of "not configured" is NO published policy);
4. **a duplicate member** → refused (the value claims to be a set and is not one).

Enforcement points, each with its own job — `[DERIVED]`:

| Layer | What it refuses | Status |
|---|---|---|
| DTO (`@IsIn(PURCHASE_COMPLETION_SOURCE_STATUSES, { each: true })`, `@ArrayMinSize(1)`) | a member or shape the wire may not carry | **422** `VALIDATION_FAILED` |
| Service at create and draft edit (`assertPolicyShape`) | a set that could never be published (empty/duplicate) | **409** `PURCHASE_COMPLETION_POLICY_INVALID` with the reason |
| Service at validate AND publish (`assertStoredPolicy`) | a STORED row failing any of the four rules — whatever wrote it | **409** `PURCHASE_COMPLETION_POLICY_INVALID` with the complete reason list; nothing is written |
| Completion act (`readAllowedFromStatuses`) | a published row that cannot be evaluated | **409** `PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED` (fail closed, never a guess) |

A refused validation or publication writes NOTHING: the row keeps its status and no audit row is
recorded for a transition that did not happen.

## I. VERSIONING — `[CONFIRMED]` (reused, not invented)

DRAFT → VALIDATED → PUBLISHED → ARCHIVED — the same lifecycle the workflow definition version, the
line-routing version and the commercial configuration version already walk (the column's type IS
`WorkflowDefinitionVersionStatus`). Only a DRAFT may be edited; a change is a NEW version, which is
what keeps "which policy governed this purchase" answerable forever.

## J. PUBLICATION — `[DERIVED]` from the commercial configuration, `[CONFIRMED]` by test

`POST …/:id/publish` performs, in ONE unit of work: (DRAFT → VALIDATED if needed) → VALIDATED →
PUBLISHED, and **archives every currently published policy of this tenant** first. The tenant
therefore has AT MOST ONE published policy — the single-published invariant the completion act
relies on — and a failure anywhere rolls the act back, leaving the previous policy in force.

Retirement is `POST …/:id/archive`, including the published row: the tenant then has NO published
policy and completion fails closed until a new one is published. Nothing is deleted, and a purchase
completed under an archived policy keeps its pin.

## K. EFFECTIVE BEHAVIOUR — `[DERIVED]` (evaluate at close time, record what was used)

The policy is evaluated **at close time** against the tenant's currently PUBLISHED row, and the row
used is **recorded on the document** in the same conditional write. Therefore:

* a document is judged by the policy in force WHEN IT IS COMPLETED;
* publishing V2 changes what the NEXT close does, immediately;
* a completion that already happened is never re-evaluated, and the document still names the policy
  that authorised it.

**Why not pin at document creation — `[DERIVED]`:** the commercial and line-routing pins exist
because those configurations become part of a *running* process (an assignment, a routed line). The
completion policy governs a single act at a single instant, and there is nothing to pin earlier than
that instant — pinning at creation would evaluate a policy for a decision that may happen much later
under a policy the tenant has since replaced.

## L. HISTORICAL SAFETY — `[CONFIRMED]` by test

* Publishing a new policy never rewrites a completion: the C4-D scenario closes one purchase under
  V1, publishes V2 (allowed set `['DRAFT']`), closes a second purchase under V2, and asserts that
  the first document still reports `completionPolicyVersionId = V1` while the second reports V2.
* `CLOSED` is terminal, so no later act can "reopen" a document into another policy's judgement
  (no outgoing edge exists and no writer is defined).
* The FK is RESTRICT: a policy that governed a completion cannot be deleted while that document
  exists.

## M. COMPLETION EXECUTION — `[CONFIRMED]` shape, `[DERIVED]` layering

`PurchaseCompletionService.close(actor, id)` is the ONE path to `CLOSED`:

1. **read** the document, tenant-scoped (`PurchaseRepository.findDocumentById(tenantId, id)`) → 404;
2. **already `CLOSED`** → 409 `PURCHASE_DOCUMENT_ALREADY_COMPLETED` (checked BEFORE the policy, so a
   repeat click answers identically in every tenant);
3. **resolve the published policy**
   (`PurchaseCompletionPolicyRepository.findPublished(tenantId)`) → none, or an unevaluable row →
   409 `PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED`;
4. **evaluate** `canCompletePurchaseDocument(document.status, allowedFromStatuses)` (pure) → 409
   `PURCHASE_COMPLETION_STATUS_NOT_ALLOWED`, naming both the actual status and the configured set;
5. **write, once, conditionally** (`purchase.repository.ts → writeCompletedIn`), carrying the
   policy's WHOLE source set in the `where` AND `completedAt: null`, and setting `status = CLOSED`,
   `completed_by_user_id = actor.userId`, `completed_at = <server clock>` and
   `completion_policy_version_id = policy.id` in the SAME statement;
6. `count === 0` → 409 `PURCHASE_COMPLETION_WRITE_CONFLICT` (never a silent success);
7. **audit** one row on the document's own resource (`commerce.purchase_document`, action `close`,
   old/new status plus the recorded facts), then answer with the module's ordinary document
   projection.

The controller (`POST commerce/purchase-documents/:id/close`) resolves the actor and delegates — no
rule, no status decision, no policy read, no eligibility assembly above the service. `[DERIVED]` from
the brief §14 architecture, which this slice implements literally
(`Controller → Completion Service → Policy Resolver → domain reads → conditional write → response`).

**The static transition table is deliberately unchanged — `[DERIVED]`:** `→ CLOSED` is NOT added to
`PURCHASE_DOCUMENT_TRANSITIONS`. An edge there would claim an unconditional legality the policy
decides; the table still proves that nothing else (no projection, no other route) reaches `CLOSED`,
and `purchase-status.spec.ts` still pins `toClosed === []` for the static table.

## N. PERMISSION MODEL — `[CONFIRMED]` Core ownership, `[DERIVED]` the two remits

**No new permission is introduced.** The Core/RBAC catalogue in `permissions.ts` and the Core
migration `20260926100100_seed_commerce_permission_grants` are untouched; the isolation gate that
counts the Commerce permissions in SQL still measures the same number.

| Surface | Permission | Why this one — `[DERIVED]` |
|---|---|---|
| `GET /commerce/completion-policies`, `GET …/:id` | `commerce.read` | the module's read convention for every collection |
| `POST /commerce/completion-policies`, `PATCH …/:id`, `POST …/:id/validate`, `…/publish`, `…/archive` | `commerce.configure` | the configuration-lifecycle remit §10 assigns to authoring/validating/publishing/archiving a configuration — the commercial configuration version's own permission, and the closest precedent (a versioned business-policy row, not a workflow version) |
| `POST /commerce/purchase-documents/:id/close` | `commerce.manage` | §10 assigns every DOCUMENT write to `commerce.manage` (create, update, submit, payments, receiving, returns). Completion is the same kind of write on the same row, so it reuses the existing permission rather than inventing one. `commerce.approve` and `commerce.workflow.manage` are deliberately NOT used: a decision is not a completion, and completion is not a workflow transition. |

**The two layers remain separate and both must succeed — `[CONFIRMED]`:** Core answers *may this
caller act at all?* (entitlement guard → JwtAuthGuard → RolesGuard), and Commerce answers *may THIS
document be completed under the tenant's policy?* Neither layer is configurable from the other, and
no policy field can widen or narrow who may act.

## O. ACTOR MODEL — `[CONFIRMED]`

* The actor is resolved ONCE per request by `resolveCommerceActor(req)` — `tenantId` from the request
  context, `userId` from the session (`req.user.sub ?? req.user.id ?? context.userId ?? null`). No
  request field is consulted, and a request with no tenant is refused (403) before anything else.
* The completion act records `actor.userId` as `completed_by_user_id` and `new Date()` as
  `completed_at`; a machine caller legitimately records NULL (the module's standing convention).
* The actor is never the document's requester: §29 records **who completed**, and the requester is a
  different fact that the document already carries.

## P. TENANT ISOLATION — `[CONFIRMED]` by test

`tenantId` is the first parameter of every repository method and appears in every `where`;
`findUnique` is never used for tenant-sensitive access. No DTO, query or path carries a tenant. A
foreign id answers **404** (never 403 — existence is not confirmed across tenants). The C4-E scenario
proves: B's list contains none of A's rows, B reading/editing/publishing A's policy is 404, B closing
A's document is 404, and B's own tenant with no published policy fails closed.

## Q. CONCURRENCY — `[CONFIRMED]` mechanism, `[DERIVED]` predicate

The module's ONE mechanism, reused unchanged: a conditional `updateMany` whose `where` carries
`{ id, tenantId, status: { in: <the policy's source set> }, completedAt: null }`, with `count === 0`
reported as the established 409 rather than as success. The C4-F scenario fires two simultaneous
closes and asserts `[200, 409]`, that the loser's code is
`PURCHASE_DOCUMENT_ALREADY_COMPLETED` or `PURCHASE_COMPLETION_WRITE_CONFLICT`, and that the recorded
actor/timestamp/pin appear exactly once (never overwritten or duplicated). No locks, no optimistic
version column, no queue is introduced — the schema records why no version column exists.

## R. PAYMENT INTERACTION — `[CONFIRMED: independent, both directions]`

* Nothing in the completion path reads, writes, creates or compensates a `PaymentRecord`; the policy
  model has no payment field, and the completion service's dependency surface (two repositories +
  the projection service + the audit gateway + the unit of work) has no payment call to reach.
* Payments are never gated on the document's status (Q6), so **later payments continue on the same
  purchase** — §29 — and the C4-G scenario appends one *after* completion, asserting the projection
  moves to `PAID` while the document stays `CLOSED` with its completion record intact.
* "Paid before closed" is NOT implemented as a rule (§F).

## S. RECEIVING INTERACTION — `[CONFIRMED: independent]`

Completion writes no `Receipt`/`ReceiptLine` and reads none; receiving never writes
`PurchaseDocument.status` (R §3-I, reciprocal). The C4-G scenario asserts a completed purchase's
receipt read still answers `NOT_RECEIVED` — completion changed nothing there.

## T. RETURN INTERACTION — `[CONFIRMED: independent]`

Returns remain a child lifecycle (S §12): a return NEVER changes `PurchaseDocument.status`, and
completion never writes a return row or a `ReturnLifecycleTransition`. The C4-G scenario asserts a
completed purchase still has its (empty) return list, and §F records "no open return" as NOT
SUPPORTED as a condition.

## U. WORKFLOW INTERACTION — `[CONFIRMED: independent]`

* Workflow completion is NOT purchase completion (§29), and the commercial projection — not the
  workflow — is what moves `SUBMITTED → APPROVED | REJECTED`. The close route never decides a step,
  never settles a run and never moves a `WorkflowInstance`; the C4-G scenario asserts the completed
  document's line run still holds its own `APPROVED` outcome.
* The inverse is unchanged too: a decided workflow/step never closes a document — the C4-C scenario
  shows a `SUBMITTED` document with an approved workflow refusing completion under a policy that
  does not name `SUBMITTED`.
* No automatic double transition exists: one close request changes exactly one row.

## V. HTTP API — `[PROPOSED]` paths, `[DERIVED]` shape

**Configuration — `commerce/completion-policies`** (seven routes on the `commerce` prefix, the
module's configuration-collection convention):

| Method | Path | Permission | Success | Refusals |
|---|---|---|---|---|
| GET | `/api/v1/commerce/completion-policies` | `commerce.read` | 200 page `{items,page,pageSize,total}` | 401, 403 |
| GET | `/api/v1/commerce/completion-policies/:id` | `commerce.read` | 200 row | 401, 403, 404 |
| POST | `/api/v1/commerce/completion-policies` | `commerce.configure` | **201** row (DRAFT) | 401, 403, 409 `…_LABEL_TAKEN` / `…_POLICY_INVALID`, 422 |
| PATCH | `/api/v1/commerce/completion-policies/:id` | `commerce.configure` | 200 row | 401, 403, 404, 409 `…_POLICY_INVALID`, 422 |
| POST | `/api/v1/commerce/completion-policies/:id/validate` | `commerce.configure` | 200 row (VALIDATED) | 401, 403, 404, 409 `…_POLICY_INVALID` |
| POST | `/api/v1/commerce/completion-policies/:id/publish` | `commerce.configure` | 200 row (PUBLISHED) | 401, 403, 404, 409 `…_POLICY_INVALID` |
| POST | `/api/v1/commerce/completion-policies/:id/archive` | `commerce.configure` | 200 row (ARCHIVED) | 401, 403, 404, 409 `…_POLICY_INVALID` |

Body (create): `{ versionLabel: string(≤64), allowedFromStatuses: PurchaseCompletionSourceStatus[] }`;
body (PATCH): `{ allowedFromStatuses: … }` — the label is the row's identity and is not editable.
Response: `{ id, status, versionLabel, allowedFromStatuses, createdAt, updatedAt }` — never `tenantId`.
Unknown fields (including `tenantId`) are 422 from the production pipe.

**Execution — `POST /api/v1/commerce/purchase-documents/:id/close`** — `[PROPOSED]` verb, following
the family's own naming (`submit` → SUBMITTED, so `close` → CLOSED), on the document collection that
owns the id:

| Aspect | Decision |
|---|---|
| permission | `commerce.manage` (§N) |
| body | **none** — `[PROPOSED]`. The action IS the route; no reason or confirmation field is invented because no source states one. §29's "explicit" is satisfied by a dedicated, permissioned, policy-gated transition, and §29's "warning/confirmation" belongs to the UI control the brief §30 defers. |
| success | **200** with the module's ordinary document projection (`status: 'CLOSED'`, `completedByUserId`, `completedAt` included) — the same shape the GET route returns, read back through `PurchaseService` |
| refusals | 401 (no principal) · 403 (entitlement / missing `commerce.manage`) · 404 (unknown or foreign id) · 409 `PURCHASE_DOCUMENT_ALREADY_COMPLETED` \| `PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED` \| `PURCHASE_COMPLETION_STATUS_NOT_ALLOWED` \| `PURCHASE_COMPLETION_WRITE_CONFLICT` |
| client-supplied | none accepted: no `tenantId`, no actor id, no `completedBy`, no timestamp |

**Error vocabulary (closed):** `PURCHASE_COMPLETION_POLICY_LABEL_TAKEN`,
`PURCHASE_COMPLETION_POLICY_INVALID`, `PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED`,
`PURCHASE_COMPLETION_STATUS_NOT_ALLOWED`, `PURCHASE_DOCUMENT_ALREADY_COMPLETED`,
`PURCHASE_COMPLETION_WRITE_CONFLICT` — declared once in `completion.constants.ts`; no other public
code may be added without amending this contract.

## W. SETTINGS CENTER INTEGRATION — the EXISTING surface, one new section

`Settings → تدارکات و فرآیند خرید → تکمیل خرید`, i.e. `/admin/settings?tab=commerce&view=completion`.
This reuses the Platform Settings Center and the Commerce domain panel UI-4 already mounts
(`CoreSettingsCenter` → `CommerceSettingsView`); nothing else was created — no new settings
application, no sidebar entry, no duplicate route, no second settings centre, and no change to
unrelated settings. The panel is presentation only: every rule lives in the backend contract above.

What the panel states, in the administrator's own language (brief §29):

* the rule IN FORCE, as one sentence: «با این تنظیمات، سند درخواست خرید تنها در وضعیت «…» قابل تکمیل
  است» — or, with none published, «… برای هیچ سندی امکان‌پذیر نیست» (fail-closed made visible);
* the version lifecycle in the words the domain already uses (پیش‌نویس / اعتبارسنجی‌شده / منتشرشده /
  آرشیوشده), with each state's meaning as its hint;
* a draft editor with ONE label and five checkboxes (the register's own status labels), **nothing
  pre-selected**, the save disabled until a label and at least one status are stated — no invented
  default anywhere;
* a live preview of the resulting rule, phrased as «با این تنظیمات … قابل تکمیل است»;
* explicit confirmation before publishing (stating that the previously published rule is archived)
  and before archiving (stating that completion stops while the published rule is retired);
* one honest sentence stating what the rule does NOT govern — payment, receiving, workflow and
  returns are independent lifecycles and no source makes any of them a completion condition;
* the standard Persian/RTL, keyboard-accessible shell (the shared settings dialog and the shared
  confirm dialog), with unsaved edits protected by the domain's existing dirty guard.

**The close action has NO UI** — deliberately (brief §30). `closeCommercePurchaseDocument` exists in
the client so the contract is complete, and the UI-5 honesty gate still refuses any close control and
its vocabulary until an explicit UI task designs one with §29's warning/confirmation.

## X. TESTS — what exists, and what each proves

**Backend unit (new):**

| File | Tests | What it pins |
|---|---|---|
| `completion/purchase-completion-policy.spec.ts` | 12 | the candidate vocabulary equals the lifecycle minus `CLOSED`; the checklist accepts every non-empty subset and refuses non-arrays, empty sets, `CLOSED`, foreign lifecycle states, invented strings and duplicates (reporting EVERY reason); `readAllowedFromStatuses` fails closed |
| `completion/purchase-completion-policy.dto.spec.ts` | 10 | the label bound from both sides; every source status individually plus multi-status sets; `CLOSED`/`PAID`/empty/mixed sets and client-supplied `tenantId`/`status`/`id` refused at the edge; the list's inherited page window and absent filters |
| `completion/purchase-completion-policy.service.spec.ts` | 21 | tenant-first writes; label trim/bounds/409; create/edit/validate/publish/archive ordering; immutability of PUBLISHED; ARCHIVED not revivable; the checklist applied to the STORED row at validate and publish; every race (`null` from a conditional write) a 409 with no audit; no `tenantId` in any view |
| `completion/purchase-completion.service.spec.ts` | 12 | 404 tenant-first; already-`CLOSED` checked BEFORE the policy; fail-closed with no policy and with an unevaluable row (no write, no audit); the policy's own set refusing a status (message naming both sides); the conditional write carrying set + actor + clock + pin; one audit row on the document resource; the projection returned; the four-step order (document → policy → write → projection) |

**Backend pins updated (not weakened):** `purchase-status.spec.ts` gained the completion vocabulary
and evaluator blocks (including an exhaustive 6 × 5 pair matrix) and keeps the static-table assertion
`toClosed === []` with its rationale rewritten; `commerce-isolation.spec.ts` learned the tenth
controller, the sixty-fourth route, the twenty-first model, the twelfth late column, the three new
indexes and the tenth repository; the workflow-configuration repository gate names the new repository.

**Backend e2e (real boundary stack + `commerce_db`):** `test/commerce-lifecycle.e2e-spec.ts` gained
the eight C4-R scenarios (C4-A, C4-A2, C4-B, C4-C, C4-F, C4-D, C4-E, C4-G).

**Frontend:** `CommerceCompletionSettings.spec.tsx` (8 tests: fail-closed wording, published rule in
product language, no pre-selected default + live preview + exact create payload, draft edit/validate,
publish and archive confirmations, no write affordance without the grant, honest read failure with a
working retry); `CommerceFinalHonesty.spec.tsx` updated for the new live route prefix and for the new
reason the no-close-control rule still holds; `commerce-fixtures.ts` carries the two new projection
fields.

## Y. AUDIT INTERACTION — `[DERIVED]` from the module's one-trail rule

`CommerceAuditGateway` remains the ONLY audit surface (no Commerce audit table exists or was added).
Two resources are involved:

* `commerce.purchase_completion_policy_version` — one row per configuration act (`created`,
  `updated`, `validated`, `published`, `archived`), carrying the old/new status and, where relevant,
  the status set;
* `commerce.purchase_document` — the completion act itself, action `close`, old/new status plus
  `completedAt`, `completedByUserId` and the pinned policy id.

Audit failure never fails the business act (the gateway swallows and logs by contract). Notifications
are untouched: completion emits NO event (the brief puts notifications out of scope; a future GAP-9
could add one).

## Z. UNKNOWN — what remains genuinely open

| # | Item | Status |
|---|---|---|
| U1 | Whether a tenant will want a prerequisite at all (payment / receiving / workflow / returns) | **[DECISION REQUIRED]** — the model has no field for one until a source establishes the relationship |
| U2 | Whether completion should ever be reversible | **[UNKNOWN]** — no source; no writer exists, so nothing is promised |
| U3 | Whether the close action needs a reason/comment on the wire | **[UNKNOWN]** — no source states one; the route accepts no body today |
| U4 | Whether the close CONTROL should exist, and where | **[DECISION REQUIRED]** — brief §30 defers it to an explicit UI task |
| U5 | Whether a completion should notify anyone | **[UNKNOWN]** — future GAP-9 |
| U6 | Whether `CLOSED` should block anything else in the product (new payments are proven allowed) | **[UNKNOWN]** — no source states any other consequence |

## AA. DECISION REQUIRED — for the contract owner

1. **Prerequisite policy** (U1): if any lifecycle condition is ever to constrain completion, the
   product must state WHICH one and a source must establish it as a completion relationship — then the
   model grows ONE typed field and this contract is amended.
2. **Reversibility** (U2): a reopen would require an outgoing edge, a permission, a reason field and a
   writer — a new phase, not a configuration toggle.
3. **The close UI** (U4): design the control with §29's warning/confirmation (the shared
   `CommerceConfirmDialog` is the established surface) against the 409 vocabulary above.

## AB. EXPLICIT NON-RULES — what this phase did NOT do

* No hard-coded `APPROVED → CLOSED`; no invented default policy; no implicit "no prerequisites".
* No prerequisite field, condition editor, expression language, SQL formula, `eval`, script or second
  rule engine. The Pure Rule Engine was NOT reused: the required capability is set membership over the
  document's own vocabulary, not a workflow/routing fact tree.
* No new permission, role, actor relationship or RBAC surface in Commerce.
* No change to the static transition table beyond its rationale comment; no reopen writer.
* No change to payment, receiving, return or workflow behaviour; no retroactive rewriting of history.
* No Reporting, no Search, no Quotation, no notifications, no new audit store, no scope creep.
* No frontend redesign: one new section inside the existing Commerce settings panel, plus the client
  methods and the projection fields the contract states.
* No deletion of any row anywhere: retiring a policy is `ARCHIVED`, and documents keep their pins.

## VALIDATION RESULTS (measured in this workspace, 2026‑10‑01)

| # | Check | Command (as run) | Result |
|---|---|---|---|
| 1 | Targeted completion-policy tests | `jest --runInBand modules/commerce/completion` | **4 suites / 55 tests — pass** |
| 2 | Targeted PurchaseDocument tests | `jest --runInBand modules/commerce/purchase` | **5 suites / 101 tests — pass** |
| 3 | Commerce full suite | `jest --runInBand modules/commerce` | **40 suites / 640 tests — pass** (C3 baseline: 36 / 580) |
| 4 | API full unit suite | `jest --runInBand` | **200 suites / 3284 tests — 0 failures** (C3 baseline: 196 / 3224) |
| 5 | Architecture + runtime-policy suites | `jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **2 suites / 56 tests — pass** |
| 6 | Commerce e2e — lifecycle (incl. the eight C4-R scenarios) | `jest --config ./jest-e2e.json --runInBand --forceExit test/commerce-lifecycle.e2e-spec.ts` | **1 suite / 33 tests — pass** (25 before C4-R) |
| 7 | Commerce e2e — integration + tenant isolation | same command, both files | **2 suites / 33 tests — pass** |
| 8 | API TypeScript | `tsc --noEmit -p tsconfig.json` | **clean** |
| 9 | Prisma validate / generate | `prisma validate` · `prisma generate` (`--schema=prisma/commerce/schema.prisma`) | **valid · generated** |
| 10 | Prisma migrate deploy | `prisma migrate deploy --schema=prisma/commerce/schema.prisma` | **12 migrations applied**; `migrate status` → *Database schema is up to date* |
| 11 | Drift check | `prisma migrate diff --from-url <commerce_db> --to-schema-datamodel …` | only the PRE-EXISTING `PaymentRecord.id DROP DEFAULT` difference (declared by `20260929000002_payment_history`, unrelated to C4-R) — **no C4-R drift** |
| 12 | Targeted frontend tests | `jest CommerceCompletionSettings CommerceSettingsView CommerceFinalHonesty` | **3 suites / 30 tests — pass** |
| 13 | Frontend full suite | `jest --runInBand` (apps/web) | **90 suites / 1621 tests — 0 failures** |
| 14 | Frontend TypeScript | `tsc --noEmit -p tsconfig.json` | **clean** |
| 15 | Frontend production build | `npm run build` (apps/web) | **`next build` compiled successfully**; the `[blog-api] fetch failed` line is the app's pre-existing static-generation probe against an unavailable external service, not a build failure |
| 16 | Browser QA of the settings flow | — | **NOT PERFORMED — this environment exposes no browser tooling.** The flow is covered end-to-end at component level (mocked API) and at API level (real HTTP + `commerce_db`); a manual browser pass remains for the UI owner |

**Baseline failures introduced: none.** The API run is 200/200 suites and the frontend run 90/90; the
three e2e suites are green. **C4-R failures: none outstanding.** **Environment-only notes:** row 11's
drift line and row 15's `blog-api` warning are both pre-existing on the untouched tree.

---

## ACCEPTANCE CRITERIA (brief §32) — HONEST SCORECARD

- [x] Purchase completion policy is explicitly defined — `PurchaseCompletionPolicyVersion` + this contract
- [x] Configurable dimensions are source-backed — `allowedFromStatuses` only (§E)
- [x] Unsupported conditions are not exposed — no prerequisite field exists (§F, §W)
- [x] No arbitrary rule language exists — a finite typed set; every refusal stated (§G, §H)
- [x] No second rule engine exists — the Pure Rule Engine was NOT reused, and nothing new was added
- [x] Source status semantics confirmed — `PURCHASE_COMPLETION_SOURCE_STATUSES`, pinned by spec
- [x] Completion authority semantics confirmed — the existing permissions, Core-owned (§N)
- [x] Security/RBAC remains Core-owned — no catalogue change; the SQL permission count is unchanged
- [x] Prerequisites are explicit and typed — explicitly ABSENT, with the six-line record per candidate (§F)
- [x] Policy validation exists — `completionPolicyIssues`, at the edge, at create/edit, at validate/publish, and at evaluation
- [x] Published configuration is protected from unsafe mutation — 409 + conditional writes + single-published invariant
- [x] Historical behaviour is safe — evaluate-at-close + recorded pin, proven by C4-D
- [x] Real completion service exists — `PurchaseCompletionService.close`
- [x] `CLOSED` transition exists — `writeCompletedIn` (conditional, once)
- [x] Actor stored — `completed_by_user_id` (and projected)
- [x] Timestamp stored — `completed_at` (and projected)
- [x] History preserved — nothing deleted; returns/payments/receipts untouched; audit recorded
- [x] Tenant isolation verified — e2e C4-E + the structural gates
- [x] Repository boundary preserved — one new repository; one writer per model (isolation matrix)
- [x] Concurrency verified — e2e C4-F (exactly one 200, one 409, records written once)
- [x] 401/403/404/409 behaviour verified — e2e C4-A, C4-A2, C4-B, C4-C, C4-E, C4-F
- [x] Configuration HTTP API exists where required — seven routes (§V)
- [x] Completion HTTP API exists where required — `POST …/purchase-documents/:id/close` (§V)
- [x] Existing Settings Center integration works — `?tab=commerce&view=completion` (§W), with tests
- [x] No unrelated GAP implemented — Reporting, Search, Quotation, Audit UI and Notifications untouched
- [x] No Reporting implemented
- [x] Full regression suite green — 200/200 API unit suites, 90/90 frontend suites, 3/3 e2e suites
- [x] Documentation complete — this file

**Two honest caveats, stated rather than hidden:** browser QA (row 16) was not run because this
environment exposes no browser tooling; and the close ACTION has no UI by design (brief §30).

---

## FINAL STATUS

```
COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-3 CONFIGURABLE COMPLETION POLICY
```

GAP-3 (the document `CLOSED` transition) is closed by a **configurable, versioned, tenant-safe
Purchase Completion Policy** whose only configurable dimension is the set of source statuses the
product chooses. Completion is executed by ONE service against that policy, records §29's actor and
timestamp, pins the policy that authorised it, and fails closed when no policy is published. The
remaining open items — prerequisites, reversibility, the close control, notifications — are
enumerated in §Z and §AA as product decisions this phase deliberately did not take.

Do not start another phase automatically.









