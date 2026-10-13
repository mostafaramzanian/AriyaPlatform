# PHASE C1 — STEP P — COMMERCIAL FOUNDATION
# FINAL CONTRACT — ARCHITECTURE-FIRST / NO-GUESS / TENANT-SAFE / MAXIMUM PRACTICAL CONFIGURABILITY

**STATUS: APPROVED CONTRACT RECORD** — final owner decisions P1–P12 (project-owner ruling,
recorded 2026-09-27), together with the semantics that were unspecified by the documents
above and had to be settled once, here, before any P code is written.

**AUTHORITY.** This document is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (authoritative Commerce specification)
- `docs/PHASE-C1-EXECUTION-PROMPT.md` (authoritative execution contract)
- `docs/PHASE-C1-START-PROMPT.md` (phase start contract)
- `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md`
- `docs/PHASE-C1-O-LINE-ROUTING-CONTRACT.md`

Where this contract is silent, those documents decide. Where a behaviour was UNSPECIFIED
by them and had to be settled to implement step P, it is settled HERE, once, by the same
convention step N used, so that the implementation is a reading of an approved contract
rather than a local invention.

**BASELINE.** Step O gap closure `65e75cf` (`fix(commerce): close C1 O routing execution
gaps`) — the P preflight baseline. Gates at preflight: architecture 24, policy 32,
commerce 261 tests / 20 suites — all PASS.

**SCOPE OF STEP P.** P makes commercial responsibility a first-class, configurable Commerce
domain: commercial groups, configured liaison resolution, line-first persisted commercial
assignment with preserved history, configurable assignment timing / no-assignment /
reassignment, a Commercial Approval lifecycle that is separate from Workflow Approval, one
Rule Engine integration with an allowlisted commercial fact catalogue, and the configurable
`PurchaseDocument` projection that O deferred to P (§14 of the final P prompt). Backend
only. No frontend, no payment/receiving/return (Q/R/S), and no
quotation / requester-confirmation / correction APIs — they are outside the final P API
surface (§25 of the final P prompt) and are recorded as deferred in §11.

---

## 0. THE PRINCIPLE THIS STEP IS BUILT ON

**MAXIMUM PRACTICAL CONFIGURABILITY.** A normal business-process choice is versioned
tenant configuration plus Rule Engine data, changeable by an administrator without a
TypeScript change. Configurable in P:

- commercial group → liaison mapping
- assignment policies (line → group rules), assignment trigger/timing
- no-assignment behaviour, reassignment policy/metadata
- commercial approval activation, applicability, approver resolution
- thresholds and commercial rule conditions
- document/line aggregation (projection) policy

**Architectural invariants are NOT configurable.** They are fixed:

- tenant isolation; Commerce DB ownership; repository boundary
- identity (`CommerceIdentityGateway` → `USER_DIRECTORY`), audit (`CommerceAuditGateway`)
  and notification (`CommerceNotificationGateway`) boundaries
- Rule Engine purity (one engine, `RuleEngineService.evaluateSync`)
- published-version immutability; running purchases pinned to their configuration version
- lifecycle separation (Purchase ≠ Workflow ≠ Commercial ≠ Payment ≠ Receiving ≠ Return)
- no cross-DB foreign keys; no fake identity resolver; no async processing in C1 P

---

## 1. NON-NEGOTIABLE NO-GUESS RULE

Do not invent business entities, states, transitions, assignment semantics, approval
semantics, resolver semantics, rule facts, permission names, API behaviour, fallback
behaviour or historical semantics. If the repository/spec still lacks an essential
semantic: STOP, record the exact missing contract, and do NOT silently implement it.

The owner decisions P1–P12 in §2 are APPROVED — do not ask to re-decide them. The
settlements in §3 are this contract's own rulings and are likewise settled.

---

## 2. FINAL OWNER DECISIONS — P1 TO P12 (APPROVED)

### P1 — Liaison resolution
Commercial Liaison is a **Commerce-owned configured user assignment**. The source of truth
is Commerce configuration/state: Commercial Group → configured liaison user →
`CommerceIdentityGateway` → `USER_DIRECTORY` validation. No cross-DB relation; no direct
Core/HR queries. The configured user MUST be validated as a tenant member before use.

### P2 — Commercial group
A tenant-local Commerce business grouping inside `commerce_db`. NOT a Core role, NOT an HR
organisational unit, NOT a Core permission group. Purpose: group commercial responsibility
and determine liaison ownership. Minimum fields required by the contract; no speculative
hierarchy; no generic organisation system; tenant-owned.

### P3 — Assignment level
**LINE-FIRST.** Each `PurchaseLine` carries its own commercial responsibility. A
document-level assignment is supported only where the contract explicitly requires it —
the C1 contract does not, so P implements line-scoped assignment only (§3-J). Mixed
purchases are valid (line 1 → group A, line 2 → group B, line 3 → group A). Document
assignment never silently overwrites line assignment.

### P4 — Assignment timing
Configurable. The authorized trigger/timing is selected from the existing runtime event
vocabulary: `PURCHASE_SUBMITTED`, `AFTER_DOCUMENT_WORKFLOW_APPROVED`
(`WorkflowTriggerEvent` — closed, no new event members invented). Manual assignment is a
supported business operation where the API defines it (§3-H). Never hard-code “always at
submit” or “always after workflow approval”. The selected timing is versioned and
deterministic.

### P5 — Assignment persistence
Assignment is PERSISTED, never a purely derived read. When an assignment changes, old
history must not be rewritten: the current effective assignment and the historical record
are distinct concepts (§3-C fixes the model: current row + append-only history).

### P6 — No assignment
Configurable. Minimum approved concepts: `REJECT_OPERATION` (named refusal, transaction
rolls back) and `LEAVE_UNASSIGNED` (the line remains explicitly identifiable as
unassigned — an explicit state, never an undocumented null). Never silently route to
requester, first admin, first liaison or an arbitrary user. If an enum is absent from the
schema, add it additively and record the contract (§3-E).

### P7 — Reassignment
Allowed. The previous assignment must not be silently overwritten as if it never existed.
Reassignment captures old assignment, new assignment, actor, timestamp and
reason/comment where the contract requires one. Audit exclusively through
`CommerceAuditGateway` — no second audit system. Tenant-scoped.

### P8 — Line/document commercial result
Line commercial responsibility is independent; commercial state must not collapse into one
hidden boolean. Mixed line outcomes (APPROVED / PENDING / REJECTED) are representable.
Document-level projection is CONFIGURABLE (§3-F) and must never erase line-level history —
it is a summary of line facts, written by the one explicit projection writer (§3-F).

### P9 — Commercial rule fact catalogue
Only the existing pure Rule Engine (`RuleEngineService.evaluateSync`). Commerce owns an
allowlisted commercial fact catalogue; no second evaluator; never a raw Prisma row. The
catalogue is allowlisted, versioned, deterministic, validated and snapshot-able (§5). A
fact not in the catalogue is unreachable by a rule.

### P10 — Actor resolution
The Commercial Liaison is executable in P. `CommerceIdentityGateway` → `USER_DIRECTORY`
remains the only identity path: (1) group configuration stores an opaque `userId`;
(2) P loads it from `commerce_db`; (3) the gateway validates tenant membership/profile;
(4) P treats the validated result as the liaison actor. No `USER_DIRECTORY` expansion, no
`RoleHolderDirectory`, no `ManagerDirectory`, no HR query, no Core role enumeration.
`REQUESTER_MANAGER` and `GROUP_MANAGER` remain unsupported until a real platform contract
exists; any future contract must be additive and explicit.

### P11 — Purchase status projection
Configurable. `PurchaseDocument` lifecycle, Workflow lifecycle and Commercial lifecycle
are separated. Workflow/commercial results contribute to a configurable
`PurchaseDocument` projection policy — represented as configuration, not TypeScript.
The status vocabulary itself is architectural: `DRAFT SUBMITTED APPROVED REJECTED
CANCELLED CLOSED` — configuration may not invent or remove lifecycle states. The
projection writer is one explicit Commerce application/service responsibility (§3-F);
`PurchaseDocument.status` writes are never scattered. `APPROVED` and `CLOSED` stay
semantically distinct; workflow-approved never implies closed. Where the source defines a
completion condition, implement it; where it is genuinely missing, STOP before writing the
transition (§11 records the completion gap).

### P12 — Commercial approval
Workflow Approval ≠ Commercial Approval. Workflow configuration may determine when
Commercial Approval activates, who performs it, what conditions apply, whether it is
required and what follows — behaviour is CONFIGURABLE (§3-G): activation, applicability
(rule conditions over the commercial catalogue), assignment and thresholds may all drive
it. Never alias it to `WorkflowStepInstance.decision` unless the contract defines them as
the same — it does not, so a distinct Commercial Approval record carries its own state,
actor, time and outcome. The permission model is explicit and reuses existing
`commerce.*` permissions (§3-I); any genuinely new permission would arrive as an additive
Core migration recorded first — P requires none.

---

## 3. SETTLED SEMANTICS — THE UNDERSPECIFIED BEHAVIOURS, SETTLED HERE ONCE

Each letter records a behaviour the documents above left open and that step P cannot be
built without. These are contract rulings, not implementation accidents.

### A. Absent configuration = no automatic commercial effect (O's precedent)

O's `routeLinesForDocument` returns an empty result when no published routing version
exists for the trigger — a configured domain simply does nothing when it is not
configured. P follows the SAME rule: if no published `CommercialConfigurationVersion` is
pinned (and none is available at the first commercial activation), assignment, approval
activation and projection are no-ops; the document stays `SUBMITTED` (nothing else in
M/N/O writes those transitions). To reach `APPROVED`/`REJECTED`, a tenant publishes a
commercial configuration with a projection policy. An EXPLICIT API call (manual
assignment, a decision, a publish) never no-ops: it refuses with a named failure instead
(§10).

### B. Version pinning: first activation freezes the configuration

The first commercial operation on a document (assignment trigger, approval activation or
projection recompute) pins the tenant's currently published
`CommercialConfigurationVersion` onto the `PurchaseDocument` with a single conditional
`null → versionId` write inside the same unit of work. Every later commercial operation
for that document reads ONLY the pinned version. A configuration published after a
document's first activation therefore never changes that document's commercial meaning.
Assignment and approval rows additionally record the `configurationVersionId` they were
produced under. Publishing a new version archives the previously published one (the
established Aria `DRAFT → VALIDATED → PUBLISHED → ARCHIVED` lifecycle), so at most one
version is published per tenant; if more are ever found, activation refuses with a named
ambiguity failure rather than choosing one.

### C. Assignment storage: current row + append-only history

- `CommercialAssignment` — exactly one CURRENT row per `purchaseLineId` per tenant
  (unique `(tenantId, purchaseLineId)`), carrying the effective group, resolved user and
  an explicit state. This is what P5 forbids making derived.
- `CommercialAssignmentHistory` — append-only; every creation, reassignment and change to
  the current row writes a new history row and never rewrites an old one. January's
  Group A/User X assignment remains discoverable after February's Group B/User Y.
- A configuration change (liaison swap §8) never rewrites any assignment row: current
  rows and history carry the user resolved AT ASSIGNMENT TIME.

### D. Line → group determination: configured assignment rules, one Rule Engine

The “Configured Commercial Routing/Assignment Policy” of §11 (final P prompt) is a
tenant-authored candidate list stored as `assignmentRules` JSON on the published
configuration version — exactly how O stores `routeRules`. Each rule:
`{ label, priority, condition, commercialGroupId }`, where `condition` is an optional
allowlist-validated condition node. Deterministic evaluation per line through
`RuleEngineService.evaluateSync` under an explicit commercial rule-set identity (§5).
Multiple matches resolve by the configured behaviour; no match is the configured
no-assignment behaviour. Same vocabulary as O:

| Concept | Commercial vocabulary | Members |
|---|---|---|
| No match | `CommercialNoAssignmentBehavior` | `REJECT_OPERATION`, `LEAVE_UNASSIGNED` |
| Multiple matches | `CommercialMatchBehavior` | `HIGHEST_PRIORITY`, `AMBIGUOUS_ERROR` |

`LEAVE_UNASSIGNED` writes a current row with explicit `status = UNASSIGNED` (P6) — the
line is identifiable as unassigned by state, never by a silent null.

### E. State vocabularies (recorded here before coding, §10 of the final P prompt)

| Vocabulary | Members | Notes |
|---|---|---|
| `CommercialAssignmentState` | `ASSIGNED`, `UNASSIGNED` | explicit unassigned (P6) |
| `CommercialAssignmentSource` | `PURCHASE_SUBMITTED`, `AFTER_DOCUMENT_WORKFLOW_APPROVED`, `MANUAL` | provenance of the current row; the first two reuse `WorkflowTriggerEvent` (P4), `MANUAL` names the operation, not a new trigger event |
| `CommercialApprovalState` | `PENDING`, `APPROVED`, `REJECTED` | own lifecycle; the decision is terminal in P (correction is a later step, §11) |
| `CommercialApprovalActivation` | `NOT_REQUIRED`, `PURCHASE_SUBMITTED`, `AFTER_DOCUMENT_WORKFLOW_APPROVED` | `NOT_REQUIRED` is this step's closed member; the other two are `WorkflowTriggerEvent` values (P4 — no invented events) |
| `CommercialApprovalApprover` | `LINE_COMMERCIAL_LIAISON`, `CONFIGURED_USER` | executable resolutions only (P10: `REQUESTER_MANAGER`/`GROUP_MANAGER` unsupported) |
| `CommercialProjectionPolicy` | `DOCUMENT_WORKFLOW`, `ALL_LINES`, `DOCUMENT_WORKFLOW_AND_COMMERCIAL`, `ALL_LINES_AND_COMMERCIAL` | P11's “configured combinations” of document-workflow outcome, line outcomes and commercial approval state |

### F. Projection: one writer, fixed rules, no automatic close

`PurchaseDocument` transitions written by P, added to `PURCHASE_DOCUMENT_TRANSITIONS`
together with the code that reaches them (the table's own convention): exactly

```
SUBMITTED → APPROVED
SUBMITTED → REJECTED
```

`SUBMITTED → REJECTED` is written when the pinned document workflow instance settles
REJECTED — the document workflow is the rejection vehicle under every policy.
`SUBMITTED → APPROVED` per the pinned `CommercialProjectionPolicy`:

| Policy | APPROVED written when |
|---|---|
| `DOCUMENT_WORKFLOW` | pinned document workflow instance = APPROVED |
| `ALL_LINES` | every routed line workflow instance terminal APPROVED (a document with no routed lines never satisfies it) |
| `DOCUMENT_WORKFLOW_AND_COMMERCIAL` | document workflow APPROVED **and** every required line commercial approval APPROVED |
| `ALL_LINES_AND_COMMERCIAL` | every line workflow APPROVED **and** every required line commercial approval APPROVED |

A line approval in `REJECTED` state blocks the commercial contribution; a commercial
rejection NEVER writes `PurchaseDocument.REJECTED` (the correction loop is a later step).
The “commercial” contribution is trivially satisfied when no line approval is required.
Recomputation is deterministic and event-driven — document workflow settle, line workflow
settle, commercial decision — each time reading persisted state only, and writes only
from `SUBMITTED`. One service is the explicit writer; no other service writes these
edges. **`APPROVED` never becomes `CLOSED` automatically** — no projection writes
`CLOSED`, and the `→ CLOSED` edge is NOT added by P (§11).

### G. Commercial Approval record

- **Line-scoped**, mirroring P3: one `CommercialApproval` per line per document, unique
  `(tenantId, purchaseLineId)` in P (a correction flow needing a second record arrives
  additively later).
- Created when the pinned activation event fires for a document whose lines have a
  commercial assignment; activation `NOT_REQUIRED` → never created. Applicability per
  line is the optional bound condition evaluated against the commercial catalogue (§5) —
  `true`/no bound condition → `PENDING`, `false` → no record.
- `approverUserId` is resolved and STORED at activation: `LINE_COMMERCIAL_LIAISON` takes
  the line's current assignment user (validated through the gateway), `CONFIGURED_USER`
  takes the configuration's user (validated at publish and again at activation).
- A decision (`APPROVED`/`REJECTED`) requires the acting user to equal the stored
  approver, in-tenant, while the record is `PENDING`; it records decision user, timestamp
  and optional comment, then drives the projection recompute (F) in the same unit of work.
- Publish validation refuses `LINE_COMMERCIAL_LIAISON` approver with an activation
  trigger earlier than the assignment trigger (the approver would not exist yet).

### H. Manual assignment

`MANUAL`-sourced assignment/reassignment is an explicit API operation (§9). It refuses
with a named failure when no configuration is published (explicit calls never no-op,
§3-A) and when the document is in a terminal commercial state (`REJECTED`, `CANCELLED`,
`CLOSED`); it is allowed in `DRAFT`, `SUBMITTED` and `APPROVED`. Automatic triggers skip
lines that already have a current assignment — no duplicate assignment — while a manual
call on an already-assigned line is a REASSIGNMENT (P7) writing history, never an
overwrite in place.

### I. Permissions (existing strings only — no new permission names)

| Surface | Permission |
|---|---|
| Reads: groups, assignments, history, approvals, configuration, commercial state | `commerce.read` (`Permissions.COMMERCE_READ`) |
| Group create/update, liaison change, configuration author/validate/publish/archive | `commerce.configure` (`Permissions.COMMERCE_CONFIGURE`) |
| Manual assignment / reassignment | `commerce.manage` (`Permissions.COMMERCE_MANAGE`) — the same remit as the document operations that produce the lines |
| Commercial decision (approve/reject) | `commerce.approve` (`Permissions.COMMERCE_APPROVE`) |

All four `commerce.*` permissions already exist in Core's catalogue and seeds (steps
J–M), so P adds no permission name and no Core migration. Every endpoint additionally
carries `JwtAuthGuard` + `ModuleEntitlementGuard` + `@Roles(...)`, tenant from
`resolveCommerceActor(req)`, DTOs never carry `tenantId`.

### J. Document-level assignment is out of scope

P3 permits it only where the contract explicitly requires it; no document in C1 does.
Every assignment API is line-scoped. Nothing may infer or write a document-level owner.

### K. Liaison failures are named refusals, never fallbacks (§28)

A matched group whose `liaisonUserId` is null → `COMMERCIAL_LIAISON_NOT_CONFIGURED`; a
stored user that fails tenant validation → `COMMERCIAL_LIAISON_NOT_TENANT_MEMBER`. Both
refuse the operation (rolling back a trigger inside its unit of work); neither falls back
to another user. A line matching no rule follows the configured D behaviour instead —
“no rule matched” and “configured liaison unusable” are different failures with different
configured answers.

### L. Assignment groups may not be deleted in P

Groups are created and updated (liaison swap §8) — there is no delete API. Relations
from assignment, history and approval rows are `ON DELETE RESTRICT` (§22 of the final P
prompt), so history can never lose its group reference.

### M. Assignment rule references

The current assignment row records which rule produced it (`matchedRuleLabel`, `null`
for manual/unassigned) so the §37 UI question “why was this line assigned?” is
answerable from persisted state rather than from logs. The append-only history row a
change writes carries the same label, for the same reason: January's entry must answer
“why” as completely as February's (clarified while implementing — the column is on both
tables and was added by the additive migration
`20260929000001_commercial_assignment_rule_label`).

### N. No P notifications are added

§18 of the final P prompt requires notifications only where the contract requires them
and forbids inventing recipients. The C1 contract requires no P-specific notification;
`CommerceNotificationGateway` stays the only event path and P emits nothing new.
(Assignment/approval notifications are deferred — §11.)

### O. No second transaction mechanism, no async

All P atomicity runs through `CommerceUnitOfWork` / `CommerceTransactionHandle`
(assignment, reassignment, activation, decision, projection). Services orchestrate,
repositories use the opaque handle, `Prisma.TransactionClient` never reaches a service or
controller. Synchronous and request-driven: no queue, worker, cron or scheduler.

---

## 4. RELATION TO N, O, AND Q/R/S

- **N** owns document workflow execution. P consumes the document workflow result
  (projection input F) and reacts to its APPROVED/REJECTED settle — that is the ONLY N/P
  write path, through the one projection writer. P never rewrites `WorkflowInstance`.
- **O** owns line workflow routing and selection. P never duplicates route selection,
  never infers `Workflow A = Commercial Group X` (binding is per-D rule configuration,
  never derived), and consumes O output only as projection input. The O→P hooks are the
  same two dispatch points O already exposes: `WorkflowExecutionService` settle (document
  and line instances) and `purchase.service.submit` (assignment trigger).
- **Q/R/S** own payment, receiving and return. P MUST NOT implement payment history,
  receiving or return, must not place commercial fields on append-only
  payment/receiving structures, and commercial state remains independent of all three
  lifecycles.
- `PurchaseDocument.status` (commercial document lifecycle §5.11) is P's projection
  target only; it is never used as workflow, payment, receiving or return state.

---

## 5. RULE ENGINE AND THE COMMERCIAL FACT CATALOGUE

- ONE engine: `RuleEngineService.evaluateSync(...)` with the `RuleSetVersion` built as a
  VALUE (the M/N/O pattern) — no registry lookups, no “latest rule”, no second evaluator,
  no `eval`, no `new Function`, no SQL-as-rules.
- Two explicit commercial rule-set identities, each pinned by construction:
  `commerce.commercial.assignment` (line → group rules from `assignmentRules`) and
  `commerce.commercial.approval-applicability` (the optional bound condition on the
  configuration version).
- Catalogue v1 reuses the existing frozen, allowlisted projections in `workflow-facts.ts`
  (`COMMERCE_WORKFLOW_FACT_CATALOGUE` for document-level facts,
  `COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE` for line-level facts). P imports them
  unchanged — it does not widen, re-declare or bypass them. A condition naming any other
  fact is rejected at validation, so a rule cannot reach a raw Prisma row.
- Facts are projected deterministically from persisted values (money through the
  established four-decimal projection); the evaluation instant is a context member.
- Condition results that the contract persists are persisted (approval applicability is
  recorded on the approval row); nothing is recomputed at read time.

---

## 6. SCHEMA GAP SET — THE MINIMUM MODELS (§22 of the final P prompt)

Inspected against `prisma/commerce/schema.prisma` at `65e75cf`: it holds no
commercial-group, liaison, assignment or commercial-approval model and no
`GROUP_MANAGER`-style role. The MINIMUM set justified by this contract:

| Model | Purpose | Tenant ownership | Key constraints |
|---|---|---|---|
| `CommercialGroup` | tenant-local group with configured liaison | `tenantId` column | `@@unique([tenantId, code])`; `@@index([tenantId])`; `liaisonUserId` opaque TEXT (nullable → §3-K) |
| `CommercialConfigurationVersion` | versioned commercial policy: assignment trigger, `assignmentRules` JSON, no-assignment/match behaviours, approval activation/approver/configured user/applicability condition, projection policy | `tenantId` column | reuses `WorkflowDefinitionVersionStatus` lifecycle; `@@unique([tenantId, versionLabel])`; `@@index([tenantId, status])` |
| `CommercialAssignment` | CURRENT line assignment (never derived) | `tenantId` column | `@@unique([tenantId, purchaseLineId])`; `@@index([tenantId, purchaseDocumentId])`; FK → group `ON DELETE RESTRICT`; nullable `configurationVersionId` FK RESTRICT |
| `CommercialAssignmentHistory` | append-only assignment history | `tenantId` column | `@@index([tenantId, purchaseLineId, changedAt])`; repository exposes no update path; FK → group RESTRICT |
| `CommercialApproval` | separate commercial approval lifecycle, line-scoped | `tenantId` column | `@@unique([tenantId, purchaseLineId])`; `@@index([tenantId, state])`; FK → configuration version RESTRICT |
| `PurchaseDocument.commercialConfigurationVersionId` | additive nullable pin column (§3-B) | implicit (row is tenant-scoped) | FK → `CommercialConfigurationVersion` `ON DELETE RESTRICT` |

No other model is created. Every relation `ON DELETE RESTRICT`; every tenant-scoped
unique/index is `tenantId`-first; no cross-DB relation; migrations additive only,
generated SQL inspected, then `prisma validate` + `prisma generate` + `migrate status`.

---

## 7. PUBLISH / VALIDATION RULES (§24 of the final P prompt)

A `CommercialConfigurationVersion` may not be published unless ALL hold:

1. `versionLabel` present and tenant-unique (schema-enforced).
2. `assignmentTrigger` ∈ closed `WorkflowTriggerEvent`; activation ∈
   `CommercialApprovalActivation`; `projectionPolicy` ∈ closed vocabulary.
3. Every `assignmentRules` entry: label present, priority an integer, `commercialGroupId`
   exists IN THIS TENANT; conditions (if any) validate against the reused catalogue.
4. Applicability condition (if bound) validates against the reused catalogue.
5. `approver = CONFIGURED_USER` ⇒ `approverUserId` present and a tenant member
   (`CommerceIdentityGateway.assertMember`).
6. `approver = LINE_COMMERCIAL_LIAISON` ⇒ activation is not earlier than the assignment
   trigger (§3-G): with assignment `PURCHASE_SUBMITTED` any activation is fine; with
   assignment `AFTER_DOCUMENT_WORKFLOW_APPROVED`, activation must be
   `AFTER_DOCUMENT_WORKFLOW_APPROVED` or `NOT_REQUIRED`.
7. No unsupported resolver anywhere (no `REQUESTER_MANAGER`/`GROUP_MANAGER`).
8. `activation ≠ NOT_REQUIRED` ⇒ approver resolution present; `NOT_REQUIRED` ⇒ no
   approver configuration required.
9. Publishing archives the previously published version (single-published invariant §3-B).

Validation failures are named domain errors (`COMMERCIAL_CONFIGURATION_INVALID` with a
precise reason), never silent truncation or coercion. The M/O validate-then-publish flow
is mirrored.

---

## 8. FAILURE VOCABULARY (§28 of the final P prompt)

Named constants declared beside their writer (the N/O convention), minimal set:

- `COMMERCIAL_GROUP_NOT_FOUND`, `COMMERCIAL_GROUP_CODE_TAKEN`
- `COMMERCIAL_LIAISON_NOT_CONFIGURED`, `COMMERCIAL_LIAISON_NOT_TENANT_MEMBER`
- `COMMERCIAL_ASSIGNMENT_NOT_FOUND`, `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE`
  (terminal document state, §3-H)
- `COMMERCIAL_DUPLICATE_ASSIGNMENT` — only where the API contract explicitly forbids a
  duplicate (triggers skip already-assigned lines; manual create proceeds as
  reassignment, §3-H)
- `COMMERCIAL_INVALID_REASSIGNMENT` (same group and same resolved user)
- `COMMERCIAL_APPROVAL_NOT_FOUND`, `COMMERCIAL_APPROVAL_NOT_PENDING`,
  `COMMERCIAL_APPROVAL_ACTOR_MISMATCH`
- `COMMERCIAL_CONFIGURATION_NOT_PUBLISHED`, `COMMERCIAL_CONFIGURATION_AMBIGUOUS`,
  `COMMERCIAL_CONFIGURATION_INVALID`
- `COMMERCIAL_RULE_INVALID` (catalogue/condition violation)
- `COMMERCIAL_NO_ROUTE` (refused no-assignment), `COMMERCIAL_AMBIGUOUS_MATCH`
- `COMMERCIAL_RESOLVER_UNSUPPORTED` (publish refuses an unsupported resolver)

Cross-tenant access keeps the existing NotFound posture (never leak existence). No other
public error code is added without amending this contract first.

---

## 9. API SURFACE (§25 of the final P prompt — nothing beyond this)

Controller: `@Controller('commerce')` slice following the existing conventions
(`JwtAuthGuard` + `ModuleEntitlementGuard` + `@Roles`, `resolveCommerceActor`, DTOs
without `tenantId`, no Prisma exposure).

| Method + route | Permission | Purpose |
|---|---|---|
| `GET  commerce/commercial-groups` | `commerce.read` | page of groups |
| `GET  commerce/commercial-groups/:id` | `commerce.read` | one group |
| `POST commerce/commercial-groups` | `commerce.configure` | create group |
| `PATCH commerce/commercial-groups/:id` | `commerce.configure` | update name/liaison (§8 swap; audit `liaison_changed`) |
| `GET  commerce/commercial-configurations` | `commerce.read` | list configuration versions |
| `GET  commerce/commercial-configurations/:id` | `commerce.read` | one version |
| `POST commerce/commercial-configurations` | `commerce.configure` | create draft version |
| `PATCH commerce/commercial-configurations/:id` | `commerce.configure` | edit draft only |
| `POST commerce/commercial-configurations/:id/validate` | `commerce.configure` | run §7 checks |
| `POST commerce/commercial-configurations/:id/publish` | `commerce.configure` | validate + publish + archive previous |
| `POST commerce/commercial-configurations/:id/archive` | `commerce.configure` | archive |
| `GET  commerce/commercial-assignments?documentId=…` | `commerce.read` | current assignments + history for a document |
| `POST commerce/commercial-assignments` | `commerce.manage` | manual assign/reassign (`lineId`, `groupId`, optional `reason`) |
| `GET  commerce/commercial-approvals?documentId=…` | `commerce.read` | approvals for a document |
| `POST commerce/commercial-approvals/:id/decision` | `commerce.approve` | approve/reject (`decision`, optional `comment`) |

No duplicate workflow endpoints (generic N/O routes unchanged); no Prisma exposure; no
endpoints for quotation, requester-confirmation, correction or completion (§11).

---

## 10. TESTS, GUARDS, ISOLATION, MIGRATIONS

The §29 test matrix of the final P prompt is binding and grouped as: groups (create/
tenant ownership/update/duplicate/liaison validation), assignment (line-level, mixed
purchase, multiple groups, current + history, reassignment, tenant isolation,
no-assignment policy, configured fallback only), triggers (configured submit timing,
configured post-document-approval timing, manual assignment, no duplicate), rules
(explicit rule-set identity, exact binding, catalogue allowlist, unsupported-fact
refusal, persisted applicability, no raw passthrough, no read-time evaluation),
commercial liaison (resolves, tenant enforced, wrong-tenant rejected, missing handled by
policy), commercial approval (required/not-required, approve, reject, actor mismatch,
wrong tenant, independent from `WorkflowStepInstance.decision`, persistence), projection
(every §3-F row, mixed line outcomes, APPROVED ≠ auto-CLOSED, commercial APPROVED ≠ auto-
CLOSED), reassignment (change, previous history preserved, audit, permissions),
transactions (atomicity + proven rollback for assignment/reassignment/decision/
projection), isolation (no Core/HR Prisma, no cross-DB FK, gateways only, one Rule
Engine, no `eval`/`new Function`), repository (tenantId-first, tenant predicate, no
unsafe lookup, no service/controller Prisma, no audit/Rule Engine in repositories).

Source-scan guards (§30) extended/created with planted-defect fixtures proving they are
non-vacuous: (A) tenantId-first public methods, (B) tenant predicate per tenant-scoped
statement, (C) no forbidden tenant-unsafe lookups, (D) no direct Prisma from
services/controllers, (E) no Rule Engine from repositories, (F) no audit/notification
from repositories, (G) no cross-slice persistence leakage, (H) no cross-tenant
group/liaison/assignment lookup, (I) transaction handle never bypasses the repository
boundary.

Migrations: ADDITIVE ONLY; never edit a historical migration; no `db push`; no
destructive change; no cross-DB FK; generated SQL inspected before apply; `prisma
validate` + `prisma generate` + `prisma migrate status` after; every new relation `ON
DELETE RESTRICT`; tenantId-first uniques/indexes.

Validation suite (§36 of the final P prompt): Prisma validate/generate/migrate status,
TypeScript, focused commerce + P tests, full API tests, architecture tests, runtime
policy tests, entitlement tests, tenant tests, repository-guard tests, isolation tests,
integration tests, project build, ESLint/Prettier on touched files, `git diff --check`.
Unrelated baseline failures are NOT repaired.

---

## 11. RECORDED AS MISSING / DEFERRED — THE P STOP ITEMS (§33 of the final P prompt)

Honoured BEFORE any P implementation code:

1. **`PurchaseDocument.CLOSED` / completion (P11 stop).** §29 defines completion as an
   explicit business event (actor, timestamp, lock, explicit action) but states no
   completion precondition or permission, and §25 does not place a completion API in P.
   The `→ CLOSED` edge and its writer are therefore NOT implemented in P;
   `PURCHASE_DOCUMENT_TRANSITIONS` gains only the two edges of §3-F. Owner contract
   needed later: who may complete, from which statuses, with what guards.
2. **Correction / return-for-correction loop.** §27's correction step and the commercial
   rejection → re-approval cycle need a defined re-activation model; P records
   `REJECTED` decisions as terminal and defers re-activation.
3. **Quotation entry/update, requester confirmation (§8/§27).** Outside the final P API
   surface; deferred to their own step.
4. **`GROUP_MANAGER` / `REQUESTER_MANAGER` platform resolver (P10).** Remains
   unsupported; publish refuses it. Needs a real platform contract before it can be
   executable — additive and explicit when it arrives.
5. **Assignment/approval notifications (§18).** Deferred; none invented (§3-N).
6. **Document-level commercial assignment (P3/J).** Deferred until a contract explicitly
   requires it, together with the precedence rules it would need.
7. **Group deletion.** No API and no contract semantics; relations RESTRICT (§3-L).

If implementation reveals another genuinely missing semantic, the same rule applies:
STOP, amend this contract (or record the gap), then continue — never hide ambiguity in
code.

---

## 12. PROCESS OBLIGATIONS

- **Implementation order** (§34 of the final P prompt): clean baseline → this document
  committed separately (`docs(commerce): record C1 final commercial foundation contract`)
  → re-read N/O → schema gap analysis → minimum schema → additive migration → inspect
  SQL → generate client → repositories → groups → liaison → assignment/history →
  configurable timing/policies → Rule Engine integration → commercial approval →
  projection → N/O integration → API → audit (no new notifications) → guards → tests →
  focused then full validation → diff inspection → `feat(commerce): add commercial
  foundation (C1 P)`.
- **Git discipline** (§35): never `git add .`; never stage `secrets/`, `backups/`,
  `apps/web/next-env.d.ts`; never amend N/O.
- **Frontend** (§37): P is BACKEND ONLY. No React page, form, component or API client.
  Before the first Frontend/UI phase: STOP and notify the project owner; the future
  commercial UI follows ADMIN INTENT → CONFIGURE → BUILD RULE → PREVIEW → VALIDATE →
  PUBLISH with the §37 qualities (low cognitive load, RTL/Persian readability,
  accessibility, keyboard usability, preserved values, loading/empty/error states,
  consistency with Aria UI).
- **Final report** (§38): all 30 items, then DO NOT START STEP Q AUTOMATICALLY.

---

## FINAL ARCHITECTURAL PRINCIPLE

```text
CONFIGURATION
      ↓
RULE ENGINE (decision)
      ↓
COMMERCIAL ASSIGNMENT (group / liaison)
      ↓
COMMERCIAL LIFECYCLE (review / approval)
      ↓
CONFIGURED PURCHASE PROJECTION
```

while preserving:

```text
Purchase Lifecycle ≠ Workflow Lifecycle ≠ Commercial Lifecycle
                  ≠ Payment Lifecycle ≠ Receiving Lifecycle ≠ Return Lifecycle
```

Business behavior: CONFIGURABLE. Architecture: FIXED. Single Rule Engine. Single
Commerce DB. Strict tenant isolation. Repository boundary. Platform gateways only.
Published configuration immutable. Historical assignments preserved. No fake resolvers.
No hidden fallback. No asynchronous processor. STOP whenever a required business semantic
is unsupported by the recorded contract or actual repository evidence.

---

## O4 AGGREGATION GATE AMENDMENT — C1

**Date:** 2026-09-29
**Reason:** The `PurchaseDocument` projection policies `ALL_LINES` and `ALL_LINES_AND_COMMERCIAL` defined in §3-F are gated by `WorkflowLineRoutingAggregationPolicy` from `PHASE-C1-O-LINE-ROUTING-CONTRACT.md` §O4 Remediation Amendment.

For C1, the `ALL_LINES` and `ALL_LINES_AND_COMMERCIAL` rows of §3-F are satisfied only when the applicable `WorkflowLineRoutingAggregationPolicy` permits line outcomes to influence the document:

- When O4 = `INDEPENDENT`, line-routing outcomes MUST NOT independently satisfy the line-aggregation portion of the projection.
- When O4 = `ALL_APPROVED`, the line-aggregation portion is satisfied only when all routable lines are `APPROVED`.
- `DOCUMENT_WORKFLOW` and `DOCUMENT_WORKFLOW_AND_COMMERCIAL` remain governed by the document workflow; O4 does not suppress the document-workflow contribution.

P remains the sole owner and writer of `PurchaseDocument.status`; O supplies the aggregation input through the approved O→P dependency boundary.
