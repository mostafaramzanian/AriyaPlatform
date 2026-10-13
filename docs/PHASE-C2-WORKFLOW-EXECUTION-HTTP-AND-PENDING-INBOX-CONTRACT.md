# PHASE C2 — Commerce backend GAP closure: GAP-1 (Workflow Execution HTTP) and GAP-1b (server-side pending-decisions inbox)

Backend-only phase, architecture-first and zero-guess: every semantic below was read from
source before any code was written, and every route, predicate and refusal either exists in
the N contract / step contracts or is explicitly marked as a C2 decision with its reasoning.
No frontend file was touched.

## A. PRE-IMPLEMENTATION FINDINGS (from source, zero-guess)

1. The workflow-execution DOMAIN is complete and tested but unreachable in production:
   `planWorkflowStepDecision` plans **both** `APPROVED` and `REJECTED` (ALL/ANY join
   semantics), `planWorkflowCancellation` plans **cancellation** (RUNNING → CANCELLED,
   PENDING → SKIPPED, "two writes"), the repository has every conditional write
   (`recordStepDecision`, `skipPendingStepInstances`, `settleInstance`) and §11's reads
   (`listInstancePage` with an `approverId` filter, `findInstanceDetail`). The service wired
   ONLY the approve path, and e2e reached it solely through a test probe controller
   (`POST …/steps/:stepKey/approve`, returning 201 because it had no `@HttpCode`).
2. The commercial decision contract already established and must not change:
   `POST /api/v1/commerce/commercial-approvals/:id/decision`, `commerce.approve`,
   PENDING → APPROVED|REJECTED, server actor, no tenantId/userId in DTOs, stale → conflict.
3. N contract §11 pins the four execution routes (list/detail/decide/cancel), the two
   permissions (`commerce.read`, `commerce.approve`) and "no new permission".
4. Eligibility predicates: workflow = step `PENDING` ∧ `resolvedApproverId = me` ∧ run
   `RUNNING` (rows only exist for ACTIVATED groups); commercial = `status = PENDING` ∧
   `approverUserId = me` — exactly what each execution route enforces before writing.
5. `WorkflowStepInstance` already has the composite index
   `[tenantId, resolvedApproverId, status]`; `CommercialApproval` has NO approver-leading
   index → C2 adds one, shaped like N's.
6. Error codes in the service: `WORKFLOW_STEP_NOT_FOUND` (404), `WORKFLOW_INSTANCE_NOT_RUNNING`,
   `WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR`/`WORKFLOW_STEP_UNKNOWN`/`WORKFLOW_STEP_NOT_ACTIONABLE`
   (refusals), all carried as `{code, message}`. The e2e pins actor-mismatch → **400**.
7. Module conventions: page `{items, page, pageSize, total}` via `resolveCommercePageWindow`;
   actor from `resolveCommerceActor(req)` only; transitions answer 200/201 with the
   SERVER-authoritative resulting state; state conflicts answer 409; DTO whitelist violations
   answer 422 under the exact production pipe.

## B. GAP RE-VERIFICATION (zero-guess, from source)

* **GAP-1 — CONFIRMED.** No production controller exposed §11's routes: `commerce.module.ts`
  registered six controllers, none named `workflow-execution`; the isolation spec PINNED the
  absence ("N and O are application services without an HTTP surface"). Rejection and
  cancellation existed only in the planner — `approveStep(..., decision: 'APPROVED')` was the
  only wired shape. Any client needing "my runs" or "decide this step" had no endpoint.
* **GAP-1b — CONFIRMED.** No server endpoint lists a user's actionable decisions. The UI-0
  contract documented the only option (client-side Option A: page documents, fetch
  approvals per document, filter `PENDING && approverUserId===me` in the browser) as a
  bounded compromise; workflow pending steps were not even representable client-side.
  Decision authority and eligibility lived server-side but the QUESTION "what do I act on
  now" was answered by the client, from data it must not trust.

## C. CAPABILITIES NEWLY AVAILABLE

1. `GET/POST` workflow execution surface (four routes, §11) — list runs, read a run with
   persisted outcomes, decide APPROVED|REJECTED on a step instance, cancel a running run.
2. `GET /api/v1/commerce/pending-decisions` — the session user's cross-system actionable
   inbox (workflow steps + commercial approvals), paged, tenant-scoped, server-enforced.
3. The server-authoritative conflicts C2 adds: stale decisions/cancels answer 409 with the
   planner's named code (previously unreachable through HTTP at all for these paths).

## D. FILES CREATED

* `apps/api/src/modules/commerce/workflow/workflow-execution.controller.ts`
* `apps/api/src/modules/commerce/workflow/workflow-execution.dto.ts`
* `apps/api/src/modules/commerce/pending/pending-decisions.controller.ts`
* `apps/api/src/modules/commerce/pending/pending-decisions.service.ts`
* `apps/api/src/modules/commerce/pending/pending-decisions.service.spec.ts`
* `apps/api/prisma/commerce/migrations/20260930000000_commercial_approval_inbox_index/migration.sql`
* `docs/PHASE-C2-WORKFLOW-EXECUTION-HTTP-AND-PENDING-INBOX-CONTRACT.md` (this file)

## E. FILES MODIFIED

* `workflow/workflow-execution.service.ts` — `approveStep` refactored into
  `loadRun` + shared `applyDecision` (decision parameterised); new `decideStep`,
  `cancelInstance`, `listInstances`, `getInstance`, the two view serializers, and the
  `workflowDecisionRefusal` HTTP-class mapper; the conditional-write race now surfaces as
  409 instead of silent success.
* `workflow/workflow-execution.repository.ts` — additive read `listPendingStepPage` (+ row
  include/types above the class).
* `commercial/commercial-lifecycle.repository.ts` — additive read `listPendingApprovalPage`.
* `purchase/purchase.repository.ts` — additive batch reads `findDocumentNumbersByIds`,
  `findDocumentIdsByLineIds`.
* `commerce.module.ts` — two controllers + one provider registered (exports unchanged:
  still the three gateways).
* `prisma/commerce/schema.prisma` — one additive `@@index([tenantId, approverUserId, status])`
  on `CommercialApproval`.
* Specs: `workflow-execution.service.spec.ts` (+10 tests, 2 refusal-class amendments),
  `workflow-execution.guards.spec.ts` (array-form `$transaction` count 1→2),
  `commerce-isolation.spec.ts` (surface 47→52 routes, 6→8 controllers, migration pin,
  service inventory, D7 region anchor, index count 56→57),
  `commerce-lifecycle.e2e-spec.ts` (mounted the two controllers + inbox service, read-only
  member `userA3`, scenarios C2-A…C2-F).
* Docs: N contract §11 status block; this report; UI-0 contract amendment note (below §26).

## F. CONTRACT DECISIONS (documented before code)

| Surface | Decision | Basis |
|---|---|---|
| Execution routes | Exactly N §11: `commerce/workflow-instances[/:id][/steps/:stepInstanceId/decision\|/cancel]` | N contract §11 (read from source before implementation) |
| Decide body | `{decision: 'APPROVED'\|'REJECTED', comment?: string ≤ 500}` | `WORKFLOW_STEP_DECISIONS` closed set; 500 mirrors the column `VarChar(500)` |
| Decide/cancel response | `200 {instanceId, status}` | module transition convention; server-authoritative resulting state |
| Inbox route | `GET commerce/pending-decisions` (session-scoped, no user param) | the question is "mine"; an id the client can type is not an authorization source |
| Inbox item | discriminated union on `kind` (`WORKFLOW_STEP` \| `COMMERCIAL_APPROVAL`) + opaque ids + display fields | the domain has two systems; one merged model would invent fields neither has |
| Inbox eligibility | the exact predicate each execution route enforces (repository WHERE, not in-memory filter) | listed-as-actionable ⇒ the server can authorize the action |
| Inbox ordering | `createdAt` desc, `id` asc tie-break; `total = Σ counts`; window `take = skip+take` per source, merge, slice | deterministic, no invented business priority (promised by UI-0 §26's D) |
| Cancel authority | `commerce.approve` permission only, tenant-scoped id | N contract: "no cancellation roles" — an identity rule would be invented |
| State refusals | 409 with N code intact; actor/plan refusals stay 400; not-found stays 404 | module conflict convention + the e2e's pinned 400 for actor mismatch |
| `tenantId` | never accepted in a DTO, never returned in a view | module-wide rule; whitelist makes sending it a 422 |

No semantic remained UNKNOWN at implementation time; the two deliberate C2 choices beyond
verbatim contract text are the 409 refusal class (with reasoning in §I) and the inbox route
name/shape (with reasoning in §H).

## G. GAP-1 SURFACE — FINAL STATE

`WorkflowExecutionController` (`@Controller('commerce')`, the module's five-decorator chain
verbatim: `@RequiresModule` → `@RequiresFeature(…PURCHASE)` → `ModuleEntitlementGuard` →
`JwtAuthGuard`, `@Roles` per route):

| Method | Path | Roles | HttpCode | Delegates to |
|---|---|---|---|---|
| GET | `commerce/workflow-instances` | `COMMERCE_READ` | — | `listInstances(actor, query)` |
| GET | `commerce/workflow-instances/:id` | `COMMERCE_READ` | — | `getInstance(actor, id)` |
| POST | `commerce/workflow-instances/:id/steps/:stepInstanceId/decision` | `COMMERCE_APPROVE` | 200 | `decideStep(actor, id, stepInstanceId, decision, comment)` |
| POST | `commerce/workflow-instances/:id/cancel` | `COMMERCE_APPROVE` | 200 | `cancelInstance(actor, id)` |

Both `:id` and `:stepInstanceId` carry `ParseUUIDPipe({version:'4'})`, matching the
commercial controller's id treatment. The controller resolves the actor and delegates —
no rule, status decision, plan or audit call appears in it.

Service pipeline (ONE implementation, two shapes): `loadRun` (tenant-scoped instance →
pinned version → acting-user presence) → step located by KEY for `approveStep`, by INSTANCE
ID for `decideStep` (404 + `WORKFLOW_STEP_NOT_FOUND` when the id is not a step of this run)
→ `applyDecision` = the original planner → conditional write (now with `count === 0` → 409)
→ skip settled → §9.2 advance/activation → settle → §3-F dispatch on terminal statuses.
`cancelInstance` = tenant-scoped load → `planWorkflowCancellation` → (skip PENDING, settle)
in ONE unit of work with a `settled === 0` → 409 guard → **no dispatch**.

Read views: list items = run row minus `tenantId` + ISO dates + version identity + per-step
`{id, workflowStepId, status, resolvedApproverId, decision, decidedAt, stepKey, stepName,
ordering}`; detail adds every persisted outcome field (`decisionComment`, `conditionResult`,
`conditionRuleSetId`, `conditionRuleVersion`, scope, timings, step config shape). The ONLY
deliberate omissions are `tenantId` and §5.7's `conditionInputSnapshot` (raw facts — backend
evidence; §10.5's UI contract never asked for it, and a read never evaluates).

## H. GAP-1b INBOX — FINAL STATE

`GET /api/v1/commerce/pending-decisions?page&pageSize` (`COMMERCE_READ`, session-scoped):

```json
{ "items": [ { "kind": "WORKFLOW_STEP" | "COMMERCIAL_APPROVAL",
               "id": "…", "status": "PENDING", "createdAt": "ISO",
               "purchaseDocumentId": "…|null", "documentNumber": "…|null",
               "purchaseLineId": "…|null", "workflowInstanceId": "…|null",
               "stepKey": "…|null", "stepName": "…|null" } ],
  "page": 1, "pageSize": 25, "total": 7 }
```

* **Why this shape:** `kind` is the discriminator the two systems genuinely have; workflow
  rows carry the run + authored step identity, commercial rows carry their line; document
  ids/numbers are batch-resolved (one statement per shape, never per row), including
  line-scoped runs resolved through `findDocumentIdsByLineIds`. An unresolvable opaque
  reference renders `null` — never a guess, never another tenant's row.
* **Why repository-side:** eligibility is two indexed WHERE clauses mirroring each DECIDE
  route's own precondition; nothing about actionability is decided in memory or by the
  client. A session without a user id answers an EMPTY page without querying at all.
* **Exact paging:** per-source `take = skip + take`, union sorted `createdAt` desc / `id`
  asc, sliced to the page; `total = stepTotal + approvalTotal` (each count from the SAME
  array-form transaction as its rows — one snapshot per source).
* **What it is NOT:** no assignment, priority, SLA, delegation or cross-domain rule; no
  notification; the two kinds are never merged into a shared model (UI-0 §26's honesty).

## I. ERROR / CONFLICT TAXONOMY — FINAL STATE

Full table in the N contract §11 status block (kept beside the routes it describes). The
C2-specific decision: **state refusals became 409, actor/plan refusals stayed 400.**
Reasoning: (1) the module answers state conflicts 409 everywhere (submit's stale-DRAFT,
commercial's not-pending, receiving, returns); (2) §10.I requires the stale decision/cancel
to use the established 409 semantics; (3) the e2e's pinned
`WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR → 400` (identity refusal) is preserved exactly, as is
every N code — only the HTTP class of `WORKFLOW_INSTANCE_NOT_RUNNING` and
`WORKFLOW_STEP_NOT_ACTIONABLE` changed, with exactly two unit assertions amended (§P). The
race guards (`recordStepDecision`/`settleInstance` returning 0) now throw 409 with those
same codes — the commercial decision's `count === 0` posture, so two racing callers can
never both report a success neither recorded.

## J. SECURITY / ISOLATION — FINAL STATE

Authentication (401 from the global JWT layer) → tenant resolution (403 with the exact
tenant-context message, before any read/write) → module entitlement (id from
`commerce.constants.ts`) → `@Roles` (403 for missing permission; the e2e's new read-only
member proves `commerce.read` and `commerce.approve` are different doors) → actor from
`resolveCommerceActor(req)` only. DTOs accept no tenantId/userId (whitelist → 422).
Every repository statement is tenant-first; cross-tenant ids are indistinguishable from
absent ones (404 on detail/decide, absent from both lists). Inbox identity is the session —
there is no parameter that names another user. Views never carry `tenantId`.

## K. PAGINATION / ORDERING / CACHING — FINAL STATE

Both list surfaces use `CommercePageQueryDto` + `resolveCommercePageWindow` (the window is
clamped and echoed). Run list order: `updatedAt` desc, `id` asc (the register's convention,
via `listInstancePage`). Inbox order: `createdAt` desc, `id` asc — technical, not
prioritized, and stable across reads (the id tie-break exists exactly for same-instant rows).
No caching was added anywhere (nothing in the module caches; a fresh read answers).

## L. SCHEMA / MIGRATION — ADDITIVE ONLY

`20260930000000_commercial_approval_inbox_index` — one statement:
`CREATE INDEX "CommercialApproval_tenantId_approverUserId_status_idx" ON
"CommercialApproval"("tenant_id", "approver_user_id", "status");`
Schema counterpart: `@@index([tenantId, approverUserId, status], map: "…")` with a doc
comment stating what it serves. No column, table, type, constraint or foreign key changes;
both prior `CommercialApproval` indexes keep their names and columns; the migration is
pinned in the isolation spec's `MIGRATIONS`/`MIGRATION_CONTRIBUTIONS` as `[0, 0, 1, 0]` and
applied to the dev/e2e `commerce_db` during this phase (`prisma migrate deploy`, 11/11).

## M. AUDIT / NOTIFICATION IMPACT — NONE, DELIBERATELY

C2 adds READ surfaces and exposes writes that already existed. No new audit event type, no
notification, no queue/worker/scheduler, no event-publisher change: cancellation performs
exactly the two writes N's contract prescribes with no dispatch (asserted in unit and e2e),
and the decision pipeline's §3-F dispatch was already there for the approve/reject settle.
The inbox reads only. The service-inventory guard records the inbox service as UNAUDITED
with its measured reason (read-only projection — no command to audit), and D7's documented
exclusion region was re-anchored from `approveStep` to the shared `applyDecision` because
the pipeline moved, not because the silence changed.

## N. DESIGN REUSE / EXPLICIT NON-GOALS

Reused as-is: planner + planners' codes, repository conditional writes and §11 reads, the
`CommerceActor`/`resolveCommerceActor` seam, `CommercePageQueryDto`, the commercial
decision contract (regression-tested), the identity gateway, the guards, the audit gateway
(unchanged), and the e2e harness (mounted into, not forked). NOT done, on purpose:
no frontend wiring (backend-only phase — the frontend keeps its Option A until a later UI
phase adopts the new endpoint), no `approverId` filter on the run list (an identity the
caller can type is not an authorization source — "my runs" is the inbox's job), no
cancellation roles/notifications/expiry, no audit on the previously unaudited decision
pipeline (reopening step N's documented exclusion is a separate decision), no new
permissions, no `findUnique` anywhere, no cross-slice import beyond the module's own
`PurchaseRepository` display joins (a read the purchase repository already owns).

## O. ARCHITECTURE GUARD AMENDMENTS (each falsifiable, each with its reason)

1. Isolation A1: the `workflow-execution.controller.ts` absence assertion was REMOVED —
   C2 is precisely the phase that gives N its §11 controller; the `workflow-line-routing`
   absence remains, and A2–A5 now hold the new controller to the identical chain, surface,
   permission and registration tests (52 pinned routes, 8 pinned controllers).
2. Isolation surface/migrations/index pins: 47→52 routes, 6→8 controllers, 56→57 indexes,
   one migration row `[0,0,1,0]`, service inventory +1 (UNAUDITED, reasoned), D7 region
   anchor → `applyDecision`.
3. Workflow guards C: the array-form `$transaction` count 1→2 (the inbox page read is a
   second PAGE read, same snapshot discipline); every other gate (tenant-first, handle
   second, readable tables, conditional writes, no interactive transaction, unwrap count)
   holds unchanged.
4. Refusal-class amendments: exactly two assertions in `workflow-execution.service.spec.ts`
   (state refusals BadRequest → Conflict), with comments recording why.
Every amendment changed a COUNT or an ANCHOR that a future edit must now satisfy — none was
loosened to make room for the new code.

## P. TESTS ADDED / AMENDED

Unit — `workflow-execution.service.spec.ts` (+10 new): REJECTED decide through the same
pipeline (settle + §3-F dispatch, no routing); unknown step-instance id → 404 with no
writes; non-approver decide → 400; lost conditional-write race → 409 with no settle;
cancel happy path (skip `['si-1']`, settle CANCELLED, NO decision/birth/dispatch);
cancel of a settled run → 409; cancel race → 409; cancel of an absent id → 404; list page
(strip `tenantId`, ISO dates, list projection, tenant-first repository call); detail page
(outcome fields present, snapshot absent) + 404. Amended (class only): "instance not
running" and "repeat decision" now expect `ConflictException`.

Unit — `pending-decisions.service.spec.ts` (new, 7 tests): exact actor+window arguments
(`take = skip+take`); no-user → empty page with no queries; merged newest-first ordering
with summed totals and both item shapes; same-instant tie-break by id; page slicing across
kinds; LINE-scoped resolution through the line batch; unresolvable number → `null`.

Guards — `workflow-execution.guards.spec.ts`: array-form transaction count 1→2 (each still
asserted array-form); header wording amended. All other gates untouched and green.

Isolation — 34/34 with the amendments in §O.

E2E — `commerce-lifecycle.e2e-spec.ts` gains scenario suite C2-A…C2-F through the REAL
boundary stack (see §S), mounted on the existing two-tenant harness with one new seam
member (`userA3`, read-only) — the harness copy discipline (own registry, own fakes)
unchanged.

## Q. KNOWN LIMITATIONS (stated, not hidden)

1. The frontend does NOT yet call any C2 route (backend-only phase); Option A's client-side
   composition remains the UI's current behavior until a later UI phase adopts the inbox.
2. The inbox's `total` is a sum of two source counts read in two transactions — each source
   internally consistent, but a decision landing between the two reads can make `total`
   differ from `items.length + what page 2 holds` by a row for one page view. Both sources
   are re-read on every request; no stale window persists.
3. The merged top-N paging reads up to `skip+take` rows per source (bounded by the shared
   page-size ceiling) — at the maximum window this is two bounded reads per source, not an
   unbounded scan.
4. Audit remains absent on the decision pipeline (step N's documented, D7-measured
   exclusion). C2 re-exposed that region to HTTP without adding the trail — reopening that
   gap is a separate, explicit decision, not a silent continuation.
5. `cancel` does not distinguish who may cancel beyond `commerce.approve` — the N contract
   says "no cancellation roles"; if a future phase adds them, the refusal vocabulary must
   grow with a named code, not a message string.
6. The e2e's refusal statuses follow the harness pipe: DTO/whitelist violations answer 422
   there (`VALIDATION_FAILED`), while planner refusals answer their 400/404/409 — both are
   asserted explicitly rather than assumed.

## R. VALIDATION ORDER & RESULTS

1. **Targeted unit** (service + guards + inbox + isolation) — iterated until green; the two
   failures it caught were real and fixed at the source (missing `createdAt` in test
   fixtures; the D7 region anchor), never by weakening an assertion.
2. **Full API unit suite** — `npx jest --runInBand`: **194 suites, 3195 tests, 0 failures**
   (includes `architecture-boundaries`, `runtime-policy`, both commerce guard suites and the
   isolation spec).
3. **Prisma** — `prisma validate` on `prisma/commerce/schema.prisma`: **valid**;
   `prisma migrate deploy`: **11/11 applied** (the C2 index is live in the shared
   dev/e2e `commerce_db`); `prisma generate` re-run so the generated client matches the
   schema (`src/generated/` is gitignored — generated at build time).
4. **Typecheck** — `npx tsc --noEmit -p tsconfig.json` (apps/api): **clean** (only npm
   config warnings); ts-jest compiled every e2e spec, catching and confirming the one
   helper-typing fix (`send(unknown)` → `send(object)`).
5. **E2E** — `commerce-integration`, `commerce-lifecycle`, `commerce-tenant`:
   **3 suites, 50 tests, all passing** after amending the two integration pins that
   asserted the OLD refusal class for state refusals (400 → the module's 409, codes
   unchanged) and the one lifecycle expectation that assumed the step-level stale code where
   the run-level code has precedence (single-step run already settled).
6. **Baseline, stated not hidden** — `hr.e2e-spec.ts` + `hr-runtime.e2e-spec.ts` fail in
   this environment (37 failed / 12 passed) BOTH standalone and in the full run, in a module
   C2 does not touch: their first failure is a 403 on an HR org-unit create (permission
   baseline), they import nothing from `commerce/`, and the C2 diff changes no HR, core or
   platform file. Recorded as pre-existing, out of this phase's scope, unchanged by C2.

## S. E2E SCENARIOS — FINAL STATE (through the real boundary stack)

* **C2-A** — submit creates the line run; the approver's paged list shows it with the window
  echoed; invalid `status` and a smuggled `tenantId` query are refused (422); the detail
  read (as the read-only member) returns persisted `PENDING/null` outcomes and never
  `tenantId` or `conditionInputSnapshot`; tenant B's list lacks the run and the id is a 404
  for B.
* **C2-B** — the inbox returns BOTH kinds for their owner, `createdAt` descending across
  kinds, both rows carrying resolved `documentNumber` (LINE-scoped run resolved through its
  line); the requester's inbox contains NONE of them (`total = 0`); tenant B's contains no
  A id.
* **C2-C** — no principal → 401 on all four routes; unresolvable principal → 403 with the
  exact tenant message on read and cancel; the read-only member may read both surfaces and
  is refused 403 on decide and cancel; DTO-smuggled scope and an unknown decision → 422.
* **C2-D** — non-approver decide → 400 `WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR`; unknown step
  instance → 404 `WORKFLOW_STEP_NOT_FOUND`; cross-tenant decide → 404; decide → 200
  `{instanceId, status:'APPROVED'}`; detail shows decision + comment + decidedAt; repeat →
  409 (run-level code, precedence stated); the workflow row leaves the inbox while the
  commercial row of the same document stays; the document stays SUBMITTED.
* **C2-E** — the commercial decision (existing route) → 200; its inbox row disappears;
  a second decision is ≥400; the document now APPROVED (line + approval both decided).
* **C2-F** — the inbox shows the cancel target first; cancel (requester, holding
  `commerce.approve` — "no cancellation roles") → 200 `{status:'CANCELLED'}`; detail shows
  CANCELLED + step SKIPPED + no decision; the row leaves the inbox; repeat cancel → 409
  `WORKFLOW_INSTANCE_NOT_RUNNING`; the document is untouched (SUBMITTED) and its commercial
  approval stays PENDING.

## T. FULL SUITE RESULTS

| Gate | Result |
|---|---|
| API unit suites | 194 / 194 |
| API unit tests | 3195 / 3195 |
| Commerce e2e suites | 3 / 3 (integration, lifecycle, tenant) |
| Commerce e2e tests | 50 / 50 |
| Isolation suite | 34 / 34 |
| Guard suites (workflow execution, and the module's others) | green in the 194 |
| HR e2e | 37F/12P — pre-existing, commerce-independent, out of scope (§R.6) |
| Web (frontend) | untouched by C2 — no web gate run |

## U. TYPECHECK / PRISMA / BUILD

`tsc --noEmit` clean; `prisma validate` valid; commerce migration deployed (11/11);
`prisma generate` re-run (client is generated, gitignored). `nest build`/web build were
not re-run because C2 changes no build configuration and the API compiles clean under the
full typecheck that the build itself uses; the frontend has no changes in this phase.

## V. FINAL STATEMENT

GAP-1 and GAP-1b are closed on the backend, by composition rather than by new machinery:
the four §11 execution routes now exist exactly as the N contract specifies, over the same
planner, repository and dispatch pipeline the domain always had; rejection and cancellation
are reachable; stale attempts answer the module's 409 with the planner's own codes; and
«نیازمند اقدام من» is one paged, tenant-scoped, actor-scoped read whose eligibility is the
execution routes' own precondition — never a client-side filter. Every guard that pinned
the old shape (route surface, controller count, index count, migration table, service
inventory, D7 region) was updated as a MEASURED fact with its reason recorded, and every
test that pinned the old refusal class was amended in exactly the one dimension C2
re-decided. Nothing else moved: no permission, no audit, no notification, no frontend.

COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-1 + GAP-1b





