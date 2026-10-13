# PHASE COMMERCE GAP-9 — IMPLEMENTATION
## Commerce → Core Notification Center wiring

**Status:** implemented. GAP-9 = `CLOSED` (Commerce-side, in-process, against the existing Core contract).

**Repository:** `E:\ERP` · **Base:** `c0fab92` ("test(commerce): order U teardown before pinned versions") · **Preflight:** `docs/PHASE-COMMERCE-GAP-9-PREFLIGHT.md`

**Shape of the change:** one gateway method, two recipient transcripts produced by existing domain code, two call sites (purchase submit, workflow step decision), the Core Notification Center's own contract reached through the Commerce gateway only — plus tests and one architecture-gate extension. **No schema, no migration, no new table, no new endpoint, no new port, no consumer, no frontend.**

---

## 1. Scope

In scope (delivered):

* the Commerce-owned typed gateway surface for user-addressed notifications;
* recipient resolution from **already-existing** authoritative Commerce state;
* notification calls at the two business transitions that provably activate a decision owner;
* Commerce unit tests, a real-database Commerce e2e suite, and one I9 gate extension;
* this report.

Out of scope (untouched, and verified as such): the Core notification schema/migration/service/controller, `NotificationPublisher`, any Platform notification port, any event→notification consumer, notification preferences/templates/scheduling/e-mail/push, Commerce-side notification read APIs, and the frontend.

---

## 2. Authoritative Notification Center contract

Established by the preflight and re-read (not re-derived) during implementation:

| Fact | Source |
|---|---|
| Owner | Core — `src/notifications/` (`NotificationService`, `NotificationController`, `notification.module.ts`) |
| Persistence | Core `Notification` table (`prisma/core/schema.prisma`): `tenantId`, `type`, `title`, `body`, `readAt`, `sourceType`, `sourceId`, `createdAt` |
| The ONE server-side creation path | `NotificationService.createForUser({ userId, tenantId?, type, title, body, sourceType?, sourceId? })` — no HTTP route reaches it |
| Recipient model | an explicit Core `userId`; the Center resolves **no** audience (no roles, groups, permissions, workflow audiences or assignees) |
| Tenant rule inside Core | loads the recipient; a supplied `tenantId` is an **assertion** that must equal the recipient's own tenant (`ForbiddenException` otherwise); the stored `tenantId` is always the **recipient's** |
| Content rules inside Core | `title` 1–160 and `body` 1–1000 plain text (`<`/`>` refused); `sourceType`/`sourceId` opaque refs `^[A-Za-z0-9._:-]+$`, ≤64, blank → `null` |
| Categories | closed set `SYSTEM \| SECURITY \| ANNOUNCEMENT \| INFORMATION` — no per-domain type exists, and none was added |
| Read/ownership | `listNotifications` / `getUnreadCount` / `markRead` / `markAllRead`, each keyed on the caller's `{ userId, tenantId }` from the request context |
| Existing callers inspected | `support.service.ts` (assignee/requester, **actor excluded**, failure swallowed), `correspondence.service.ts` (recipient rows, failure swallowed), `calendar/reminder-dispatcher.service.ts` (explicit `userId`) |

The two conventions therefore copied rather than invented: **`INFORMATION`** for an operational, non-security user notification, and **swallow-and-report** after the business write has committed.

---

## 3. Commerce gateway design

**File:** `src/modules/commerce/commerce-notification.gateway.ts` — the pre-existing, I9-sanctioned surface, **extended, not duplicated**.

```
Commerce business service
        │  (typed content + explicit recipient ids)
        ▼
CommerceNotificationGateway.notifyUsers(actor, recipientUserIds, content)
        │  tenantId = actor.tenantId  (Core's assertion)
        ▼
Core NotificationService.createForUser(...)
```

What the gateway owns (and what a caller therefore cannot get wrong):

1. **Typed content** — `CommerceUserNotificationContent = { type, title, body, sourceType?, sourceId? }`, with `CommerceUserNotificationType` mirroring Core's closed four-value enum as string literals. (The gateway may hold no generated client — gate I9 forbids `generated/*` in gateway files — and the literal union is structurally identical at the call site, so a new Core category would surface as a compile question rather than silent drift.)
2. **Deduplication at the boundary** — `[...new Set(ids)]`, blank ids dropped, so two domain paths that resolve the same owner for one transition produce **one** notification per user.
3. **The tenant assertion** — `tenantId: actor.tenantId` travels to Core as an assertion (never as a placement override), so a recipient outside the actor's tenant is refused by Core rather than written.
4. **Empty list = no-op** — no invented recipient, no error.
5. **Failure policy** — a Core refusal (unknown recipient, tenant mismatch, invalid content) is logged as a `warn` carrying **identifiers only** (recipient id, source type/id, error message — never title/body) and is **never thrown**, because the business transition has already committed by then.

The pre-existing transport half (`publish`) is behaviourally unchanged; its regression is pinned by the gateway's own spec.

The gateway holds **no Prisma handle of any kind**, performs **no persistence of its own**, and duplicates **none** of Core's isolation logic.

---

## 4. Purchase notification path

**Transition:** `POST /api/v1/commerce/purchase-documents/:id/submit` → `PurchaseService.submit`.
**Transport event (unchanged):** `commerce.purchase_document.submitted`.

Inside the one unit of work (`CommerceUnitOfWork.run`):

1. `markDocumentSubmittedIn` — the conditional `DRAFT → SUBMITTED` write;
2. `lineRouting.routeLinesForDocument(..., 'PURCHASE_SUBMITTED', tx)` — creates the line workflow instances and their first-group step instances;
3. `commercial.onPurchaseSubmitted(..., tx)` — dispatch point 1 (assignment + approval activation);
4. the two results' **approver transcripts** are collected into a local `pendingDecisionUserIds`.

Notified **after the unit of work resolved** (i.e. after commit), with `sourceType: 'purchase-document'`, `sourceId: <documentId>`, `type: 'INFORMATION'`, and a title/body naming the document number (text written at the call site, as `support.service.ts` and `correspondence.service.ts` do).

The two transcripts, and where each value comes from:

| Source | Who is named | Authoritative field |
|---|---|---|
| Line routing | `WorkflowLineRoutingResult.pendingApproverUserIds` (**new**) | the `status === 'PENDING'` step inputs' `resolvedApproverId` — the value stored at activation |
| Commercial dispatch | `CommercialTriggerResult.activatedApprovalUserIds` (**new**) | the `approverUserId` of each `CommercialApproval` row **this activation created** (existing rows contribute nothing) |

If both transcripts are empty, the call is made with an empty recipient list and the gateway performs no Core call at all — a submit that activates nobody notifies nobody.

---

## 5. Workflow / decision notification path

**Transitions:** `POST /api/v1/commerce/workflow-instances/:id/steps/:stepInstanceId/decision` → `WorkflowExecutionService.decideStep` (and `approveStep`, which lands on the same pipeline).

`applyDecision` collects, **inside** the unit of work, every owner the decision puts in PENDING:

1. **the next group's approvers** — `activateGroup` now returns `{ runStatus, pendingApproverUserIds }`, where the ids are the `PENDING` step inputs' `resolvedApproverId` (the same value `identity.assertMember` validated moments earlier);
2. **the line-routing pass's approvers** — when a DOCUMENT run reaches `APPROVED`, the `AFTER_DOCUMENT_WORKFLOW_APPROVED` routing result's `pendingApproverUserIds`;
3. **the commercial approvals this settle activated** — `onWorkflowSettled` now returns `readonly string[]` instead of `void` (the activated approvals' stored `approverUserId`, or `[]` for every projection-only path: REJECTED settles, line settles, and a document with no pinned configuration).

The list is assigned to the caller's scope **inside** the unit of work — so a rollback discards it with every other write — and the single notification is created **after** `unitOfWork.run` resolves, with `sourceType: 'purchase-document'` and `sourceId` set to the owning document (a LINE run's notification points at the document the line belongs to).

Guards that keep the actor out, without any special-casing:

* on a **non-terminal approval**, the deciding approver's own step is no longer PENDING, so `resolvedApproverId` cannot name them for the *next* group;
* on a **single-step run** (all steps decided in one group) nothing is activated at all → empty list → no notification;
* on **REJECTED**, `plan.advance.advance` is false and no next group is activated → empty list → no notification;
* on **cancel**, `cancelInstance` runs its own two writes and never reaches `applyDecision` → no notification.

No deduplication store was introduced: the two transcripts may legitimately repeat a user (e.g. the same person owning two lines' first step), and the gateway's `Set` collapses them into one row per user for that one atomic transition.

---

## 6. Recipient resolution

Recipients are read from state that **already exists** in the same transaction that performs the transition, and from nothing else.

| Event / transition | Recipients | Excluded, deliberately |
|---|---|---|
| Purchase submit (`commerce.purchase_document.submitted`) | the new PENDING steps' `resolvedApproverId` (line routing) ∪ the newly created `CommercialApproval.approverUserId` (dispatch point 1) | the actor, `requesterId`, `liaisonUserId`, every role/permission/tenant-wide audience |
| Workflow step decision (approve/reject) | the next group's `resolvedApproverId` ∪ the APPROVED-settle’s routing approvers ∪ the settle-activated commercial approvers | the acting approver (their step is not pending), the requester, the document's `liaisonUserId` |
| Workflow cancel | none | — |
| Rejected / terminated run | none | the requester — **intentionally unwired**, see §12 |

Explicitly **not** used as a recipient source anywhere: permissions, role membership, tenant-wide membership, "users with `commerce.read`", the current session, global admins, or any audience the Center would have had to invent. `liaisonUserId` remains a stored commercial fact but is not a decision owner, so it was not wired (see §12).

Anti-assumption rule carried into the code, not just the report: **no code path notifies the actor because the actor acted.** The only way an acting user receives a notification is by independently appearing as the owner of a decision that is genuinely pending — e.g. approving step 1 of a group whose step 2 resolves to the same person.

---

## 7. Tenant isolation

Isolation stays **Core-enforced**, and Commerce adds no second mechanism:

* Commerce passes `tenantId: actor.tenantId` as **Core's assertion** only. Core loads the recipient, refuses a mismatch (`ForbiddenException`), and snapshots the **recipient's** tenant into the row.
* Commerce never passes a tenant as a placement, never queries the Core notification table, and never filters Core rows itself.
* Every recipient id Commerce passes comes from a row written **inside the same tenant-scoped transaction** (`markDocumentSubmittedIn`, `createStepInstances`, `createApprovalIn` all take `actor.tenantId` first), and each workflow approver was additionally verified as a tenant member by `CommerceIdentityGateway.assertMember` before the step row was written.
* Proven by test, not by argument: `commerce-gap9-notifications.e2e-spec.ts` asserts the persisted `tenantId` equals the recipient's tenant; that a peer-tenant user's list and unread count are empty; and that the peer tenant's user cannot mark the row read (`404`) — with the row re-read afterwards to prove it is untouched.

---

## 8. Transaction / failure semantics

| Question | Answer | Evidence |
|---|---|---|
| Inside the same DB transaction? | **No — strictly after commit.** The recipient list is captured inside the unit of work; the notification is created after `unitOfWork.run` resolves. | `purchase.service.ts`, `workflow-execution.service.ts`; unit tests assert zero notification calls on a lost race and on a rolled-back dispatch |
| Can a rolled-back action produce a visible notification? | **No.** The list is assembled inside the unit of work and assigned to the caller's variable at its end, so a rollback discards it with every write; the notify call is unreachable when the unit of work throws. | `creates no notification when the dispatch rolls the submit back`, `notifies nobody when the decision never committed` |
| Asynchronous / outbox? | **No new asynchronous machinery.** The create is awaited in-process; no queue, worker, scheduler or outbox was introduced. | `commerce-gateways.spec.ts` gate I19 still forbids timers/cron/queues module-wide |
| Error handling | **Business success is preserved; the notification failure is reported.** The gateway catches, logs a `warn` with identifiers only, and continues to the next recipient; it never throws. | gateway spec (`never fails the business operation`); the code states the reason (the act cannot be repeated, so failing the request would misreport a committed act) |
| Does it swallow *silently*? | No — one structured `warn` per failed recipient (`stage: 'commerce.notification.user.failed'`, recipient id, source type/id, error message). | gateway spec output shows the warning |
| Separate persistence boundary? | Core's own; Commerce holds no handle to it and writes nothing itself. | `commerce-gateways.spec.ts` (gateways free of persistence) plus the new I9 assertion |

The transport event (`NotificationPublisher.publish`) keeps its pre-existing semantics — best-effort, never throws — and its ordering relative to the audit row is unchanged.

---

## 9. Duplicate / idempotency behaviour

Established by inspecting the real semantics rather than inventing a mechanism:

* `createForUser` is **not** idempotent by itself (no uniqueness key on `sourceType`/`sourceId`; the table's indexes are `(userId, createdAt, id)` and `(userId, readAt)`).
* Neither Core caller enforces uniqueness through a reference field; both rely on **being called once for one transition**.
* Commerce therefore relies on the **existing transition uniqueness of its own state**:

| Path | Why a repeat cannot duplicate |
|---|---|
| Purchase submit | `markDocumentSubmittedIn` is conditional on `status = DRAFT`; a second attempt returns `null` → `409` → the notify call is never reached |
| Step decision | `recordStepDecision` is conditional on the step still being `PENDING`; the loser of a race gets `updated === 0` → `409` → no notify |
| Commercial activation | row creation is skipped for a line that already has a record, so a re-fired activation contributes **no** ids (nothing to re-notify) |
| Cancel | mutates no decision and emits no notification at all |

* Additionally, the gateway collapses duplicate ids **within** one call (`new Set`), which is the only duplication the domain can legitimately produce (the same person owning two lines of the same document).

No deduplication store, no unique index, no outbox and no idempotency key were added. Where the existing architecture could not have guaranteed uniqueness, this phase would have stopped that sub-part; it did not need to.

---

## 10. Tests and validation

New and extended tests:

| File | Kind | Proves |
|---|---|---|
| `src/modules/commerce/commerce-notification.gateway.spec.ts` (**new**, 6 tests) | gateway unit | exact ids/content reach Core; the actor's tenant travels as the assertion; deduplication and blank-id removal; empty list = no call; a Core refusal is swallowed and does not stop later recipients; the pre-GAP-9 transport envelope is unchanged |
| `src/modules/commerce/purchase/purchase.service.spec.ts` (+4 tests) | service unit | the union of both transcripts is notified once, with `sourceType`/`sourceId`; the requester and the actor are **not** recipients; empty transcripts → empty call; no notification on a lost race; no notification when the dispatch rolls the submit back |
| `src/modules/commerce/workflow/workflow-execution.service.spec.ts` (+5 tests) | service unit | the next group's `resolvedApproverId` is notified after commit; the routing + commercial transcripts are added on an APPROVED settle; a terminal rejection notifies nobody; a lost race notifies nobody; cancel notifies nobody |
| `test/commerce-gap9-notifications.e2e-spec.ts` (**new**, 8 tests) | real-HTTP e2e, **real Core Center**, real databases | a real submit persists one row for the routing approver (category, reference, unread) and nothing for the requester/actor/peer; a real decision persists one for the next approver; Core's own routes read/mark the row; another tenant sees nothing and cannot mark it read; a failed submit writes nothing; an unrouted/unconfigured submit writes nothing; the commercial approver is notified in a tenant with no routing |
| `test/fixtures/fake-notification-service.ts` (**new**) | shared contract-driven double | encodes Core's four creation rules (recipient existence, tenant assertion, content bounds, recipient-tenant snapshot) for the six pre-existing Commerce harnesses, which had to bind the gateway's new dependency |
| `src/modules/commerce/commerce-gateways.spec.ts` (+1 test) | architecture/policy | the Core Notification Center is behind the **one** gateway surface, the Core module import count is unchanged, and no Commerce file names the Core client or the core notification table |

**The main integration path uses no fake notification implementation:** the GAP-9 e2e boots the real `NotificationService` over the real `Notification` table (only `NotificationPublisher`, the AMQP transport, is a recording fake). The product code itself contains no fake at all.

Commands run, with results:

| # | Command (from `apps/api`) | Result |
|---|---|---|
| 1 | `tsc --noEmit -p tsconfig.json` | **clean** (no output) |
| 2 | `jest --runInBand src/modules/commerce src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **49 suites / 782 tests pass** |
| 3 | `jest --runInBand src/notifications src/modules/commerce/commerce-gateways.spec.ts src/modules/commerce/commerce-isolation.spec.ts` | **4 suites / 87 tests pass** |
| 4 | `jest --config ./jest-e2e.json --runInBand --testPathPattern commerce-` | **7 suites / 117 tests pass** (gap8-identity, gap9-notifications, integration, lifecycle, search, search-source, tenant) |
| 5 | `jest --config ./jest-e2e.json --runInBand --testPathPattern notifications` (Core Center e2e — regression) | **2 suites / 41 tests pass** (`notifications.e2e-spec.ts` + the GAP-9 suite) |
| 6 | `jest --config ./jest-e2e.json --runInBand --testPathPattern commerce-gap9` (re-run after formatting) | **1 suite / 8 tests pass** |
| 7 | `prettier --check` over every changed/added file | **clean** (the issues it found were fixed with `--write`) |
| 8 | `eslint` over every changed source/spec file | **exit 0, no findings** |
| 9 | `jest --runInBand src/modules/commerce src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts src/notifications` (final consolidated re-run after formatting) | **51 suites / 824 tests pass** |

`ts-jest` type-checks the `test/**` specs as part of runs 4–5, so the API TypeScript validation covers the new e2e suite as well as `src/**`.

---

## 11. Architecture / policy result

Intended and enforced direction:

```
Commerce business service
   → CommerceNotificationGateway (typed, the ONE surface)
      → Core NotificationService contract (createForUser)
```

Never `Commerce service → Core notification repository → core `Notification` table`.

* `src/modules/commerce/commerce-gateways.spec.ts` — the I9 guard — was extended with one test and no rule was weakened:
  * **one new offender list**: `NotificationService | notification.service` must appear in exactly `commerce-notification.gateway.ts` (a second injection point fails the build);
  * `NotificationModule` still appears in exactly `commerce.module.ts` (GAP-9 added **no** module edge — the module was already imported for the publisher);
  * a new negative scan: no Commerce file names `core-client` or a `notification.<delegate>` call, i.e. no direct Core persistence access.
* `src/architecture-boundaries.spec.ts` and `src/runtime-policy.spec.ts` were re-run unchanged and pass (no new datasource, runtime or module edge was introduced).
* `src/modules/commerce/commerce-isolation.spec.ts` passes unchanged: the repositories' ownership, the route inventory and the module boundaries are untouched; the two new service call sites go through the gateway that already existed.

**Result: green.** No rule was weakened, no allowlist widened, and no second dependency of any platform contract appeared.

---

## 12. Explicitly unwired events and why

Every candidate below was inspected and **deliberately left unwired**. In each case either no authoritative recipient exists in existing Commerce state, or no authoritative transition/contract supports the notification — so wiring it would have meant inventing a recipient rule, which this phase forbids.

| Event / act | Status | Why |
|---|---|---|
| `commerce.purchase_document.submitted` (transport event) | unchanged, transport-only | its *user* effect is delivered by the submit transition (§4), not by a consumer of the event. No AMQP→notification bridge was built. |
| `commerce.workflow.line.routed` (transport event) | unchanged, transport-only | the routing pass's user effect is delivered by whichever transition triggered it (submit or APPROVED settle), once, with deduplication. Wiring the emit site would double-notify the same owners. |
| Workflow **approval / rejection / cancellation → requester** (`requesterId`) | **unwired** | the requester is a stored fact but no existing Commerce contract makes them the owner of a pending decision; a terminal run activates nobody, and the preflight's candidate list is a *candidate*, not a rule. Documented here rather than invented. |
| Workflow **cancel** | unwired | cancels a run, activates no next owner. |
| **Liaison assignment** (`liaisonUserId`, `CommercialAssignment.resolvedUserId`) | **unwired** | an assignment is a commercial responsibility, not a pending *decision*; `assignment`/`reassignment` are named as out-of-scope in the phase brief, and the routing transcript already tells the actual approvers. |
| Commercial **assign / reassign / decide** actions | unwired | assignment/reassignment are out of scope; a commercial *decision* is the approver's own act and activates nothing (it only recomputes the projection). |
| **Payment** (record/compensate) | unwired | no authoritative recipient contract; only the actor is involved. |
| **Receiving** (record/compensate) | unwired | no recipient concept exists in `ReceivingHistoryService`; it publishes no event. |
| **Return** (approve/reject/receive-back/refund) | unwired | the return lifecycle's approver is the actor; ownership is by 4-eyes provisioning, not a stored per-step approver, so an audience would have to be invented. |
| **Purchase completion** (`/complete`) | unwired | moves a document to CLOSED; the state it changes is read by anyone with `commerce.read` — a tenant-wide audience is exactly what the brief forbids. |
| **Configuration changes** (workflow, routing, commercial, completion policies) | unwired | administrative acts; no per-user recipient contract. |
| **Audit / generic transport events** | unwired | the audit trail is a platform stream, not a user inbox; the platform's own consumer story is untouched. |
| `liaisonUserId` in the *purchase* path | unwired | same reason as the assignment row above. |

Nothing in the list above was partially implemented, and no speculative recipient (role, group, permission holder, tenant-wide member, admin, session user) was introduced anywhere in the code.

---

## 13. Non-goals

Not built, by design:

* no Platform notification port, schema, table, column, migration or endpoint;
* no notification consumer, worker, scheduler, outbox, or AMQP→notification bridge;
* no notification preferences, templates, digests, e-mail or push delivery;
* no role/group/department/tenant-wide audience subsystem, and no membership or provisioning API;
* no duplicate notification persistence in Commerce, and no direct access to Core notification persistence;
* no change to `NotificationService`, `NotificationController`, `NotificationPublisher`, the Core schema/migration, or the `/notifications` contract;
* no Commerce notification read API, and no frontend change (the existing Core bell/view already consumes the four Core routes and needed no change — the GAP-9 e2e proves the notification appears there);
* no unrelated cleanup or refactoring: the diff is the gateway method, two transcript fields, two call sites, their tests, the I9 gate extension and this report.

---

## 14. Final GAP-9 status

**GAP-9 = `CLOSED`** — Commerce-side, in-process, against the authoritative Core Notification Center contract. No Platform phase was required and none was built.

### Accepting the twelve success criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Commerce uses the authoritative Core Notification Center contract | ✅ `NotificationService.createForUser`, reachable through the Commerce gateway |
| 2 | No new notification persistence in Commerce | ✅ no schema/migration/table/column; Commerce holds no client for it |
| 3 | Access goes through a typed Commerce gateway/port | ✅ `CommerceNotificationGateway.notifyUsers(...)`, the pre-existing I9 surface, extended |
| 4 | Recipient selection comes only from authoritative existing Commerce state | ✅ `resolvedApproverId` of the PENDING steps a transition wrote, and `CommercialApproval.approverUserId` of the approvals it created |
| 5 | No actor-as-recipient assumption | ✅ no actor case anywhere; a deciding approver's own step is not PENDING, so they simply do not appear |
| 6 | Tenant isolation remains Core-enforced and proven | ✅ Core snapshots the recipient tenant; the e2e proves list/count/`markRead(404)` isolation across tenants |
| 7 | Purchase submission notifications only where a canonical recipient exists | ✅ routing approvers ∪ activated commercial approvers; otherwise an empty call → no row |
| 8 | Workflow/decision notifications only where a canonical recipient exists | ✅ next group's approver ∪ APPROVED-settle routing approvers ∪ settle-activated commercial approvers |
| 9 | Failed business transitions do not produce false notifications | ✅ notify strictly after commit; unit + e2e negatives |
| 10 | Tests prove persisted notification, recipient, isolation, negative paths | ✅ 8 real-DB e2e tests + 21 unit tests + the gateway's 6 |
| 11 | Architecture/policy checks remain green | ✅ I9 extended, I7/I8/I19/ownership/runtime/architecture specs unchanged and passing |
| 12 | No speculative recipient or event mapping invented | ✅ §12 lists every candidate left unwired and why |

### Exact notification paths wired

1. `PurchaseService.submit` (after commit) → `CommerceNotificationGateway.notifyUsers` with `sourceType: 'purchase-document'`, `sourceId: {documentId}`.
2. `WorkflowExecutionService.applyDecision` (after commit) → `CommerceNotificationGateway.notifyUsers` with `sourceType: 'purchase-document'`, `sourceId: {owning document}`.

### Exact recipients used

* `WorkflowStepInstance.resolvedApproverId` of the steps a transition put in `PENDING` (line-routing first group, or the advanced next group);
* `CommercialApproval.approverUserId` of the approvals a transition **created** (submit activation, or an APPROVED-settle activation).

### Exact events/acts left unwired

`commerce.purchase_document.submitted` and `commerce.workflow.line.routed` (transport unchanged; their user effect is delivered by the transition, not by an event consumer); requester/outcome notifications (approval, rejection, cancellation, completion); liaison assignment; commercial assign/reassign/decide; payment; receiving; return; configuration changes; audit/generic transport events. Reasons in §12.

### Files changed

**Added (GAP-9-only)**

| File | Lines |
|---|---|
| `apps/api/src/modules/commerce/commerce-notification.gateway.spec.ts` | 176 |
| `apps/api/test/commerce-gap9-notifications.e2e-spec.ts` | 697 |
| `apps/api/test/fixtures/fake-notification-service.ts` | 133 |
| `docs/PHASE-COMMERCE-GAP-9-IMPLEMENTATION.md` | this report |

**Modified (GAP-9 edits)**

| File | GAP-9 change |
|---|---|
| `src/modules/commerce/commerce-notification.gateway.ts` | `NotificationService` injection, `notifyUsers`, the two exported types, the header contract |
| `src/modules/commerce/workflow/workflow-line-routing.service.ts` | `WorkflowLineRoutingResult.pendingApproverUserIds`; `createLineWorkflow` returns it |
| `src/modules/commerce/commercial/commercial-lifecycle.service.ts` | `activateApprovals` returns created approver ids; `CommercialTriggerResult.activatedApprovalUserIds`; `onWorkflowSettled` returns them |
| `src/modules/commerce/purchase/purchase.service.ts` | capture both transcripts; notify after commit |
| `src/modules/commerce/workflow/workflow-execution.service.ts` | gateway injection; `activateGroup` returns pending approvers; transcript collection; notify after commit |
| `src/modules/commerce/purchase/purchase.service.spec.ts` | `notifyUsers` mock, transcript defaults, +4 tests |
| `src/modules/commerce/workflow/workflow-execution.service.spec.ts` | gateway provider, transcript defaults, +5 tests |
| `src/modules/commerce/commerce-gateways.spec.ts` | I9: the gateway constructor assertion now names both injected surfaces; a **new** "one surface" rule for `NotificationService` and a negative scan for Core persistence. The pre-existing rule that a *spec* may not import a platform contract still holds unchanged — the new gateway spec imports the gateway, never the Core service or publisher |
| `apps/api/test/commerce-{integration,lifecycle,tenant,search,search-source}.e2e-spec.ts`, `apps/api/test/commerce-gap8-identity.e2e-spec.ts` | bind the gateway's new dependency to the shared contract-driven double (the gateway is provided for real in every one of those harnesses) |

> **Note on `git diff --stat`:** the working tree was already dirty before this phase (the preflight recorded 56 modified / 26 untracked files from earlier UI/C7/C8/C9 work), so a git stat cannot isolate GAP-9. The table above is the accurate GAP-9 footprint; every other modified path in the tree belongs to those earlier phases.

### Blockers

**None.** No STOP condition was triggered: no recipient was invented, Core's service was never bypassed, its persistence was never touched, tenant isolation was never weakened, no schema or endpoint was added, no consumer architecture was introduced, and Core's semantics were left exactly as they were.
