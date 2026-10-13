# PHASE C1 — STEP N — CONFIGURABLE WORKFLOW EXECUTION (DOCUMENT SCOPE)

**STATUS: APPROVED CONTRACT RECORD** (project-owner ruling, recorded 2026-09-27)

**AUTHORITY.** This document is an amendment to, and is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (the authoritative Commerce specification)
- `docs/PHASE-C1-EXECUTION-PROMPT.md` (the authoritative execution contract)
- `docs/PHASE-C1-START-PROMPT.md` (the phase start contract)

Where this amendment is silent, the three documents above decide. Where a behaviour was
UNSPECIFIED by them and had to be settled to implement step N, it is settled HERE, once, so
that the implementation is a reading of an approved contract rather than a local invention.

**BASELINE.** Step K `2b67f71`, step L `032af22`, step M `d013b42`
(`feat(commerce): add workflow configuration (C1 M)`). Step N begins on the M tree with the
runtime tables (`WorkflowInstance`, `WorkflowStepInstance`) already declared by K and still
unused by any statement — exactly as M recorded (`workflow-configuration.repository.ts`: the
two tables "do not appear in this file at all").

**SCOPE OF STEP N.** N is the step that makes the configured workflow EXECUTE, at DOCUMENT
scope, driven by configuration plus the existing pure Rule Engine — with no new business
behaviour in TypeScript beyond what a version's own stored configuration determines.

---

## 0. THE PRINCIPLE THIS STEP IS BUILT ON

**MAXIMUM PRACTICAL CONFIGURABILITY.** A normal business-process choice — which workflow
applies, its priority, its order, its execution mode, its parallel-join policy, its
conditions, what a false condition does, who approves, which rule set decides — is VERSIONED
TENANT CONFIGURATION plus Rule Engine data, changeable by an administrator without a
TypeScript change and without a deployment.

Architectural invariants are NOT configurable. They are restated in §12 and are unchanged by
this amendment.

---

## 1. THE AGREED CONTRACT (B1–B6), IN ONE TABLE

| # | Question the specification left open | Approved resolution |
|---|--------------------------------------|---------------------|
| B1 | How is the workflow selected for a submitted purchase? | CONFIGURABLE: `trigger_event` + `selection_priority` + `selection_condition` on the version; selection is a RULE ENGINE decision over the tenant's PUBLISHED versions; deterministic; refuses on no-match and on ambiguity |
| B2 | How does a PARALLEL group complete? | CONFIGURABLE, version-level: `parallel_join_policy` ∈ {ALL, ANY}; no other policy in C1 N |
| B3 | What does a false condition do? | CONFIGURABLE, step-level: `onConditionFalse` ∈ {SKIPPED, BLOCKED, TERMINATED}; **BLOCKED is modelled and is REFUSED AT PUBLISH in N** |
| B4 | Where do rule set, rule version and facts come from? | The EXISTING pure Rule Engine; the binding is DERIVED deterministically from the PINNED version; Commerce owns a frozen, allow-listed fact catalogue (v1) |
| B5 | Which actor sources may execute? | CONFIGURED_USER is executable now; the other five sources stay representable and are REFUSED AT PUBLISH in N |
| B6 | What may N execute? | DOCUMENT scope only. LINE routing = step O, commercial resolution = step P; configurations needing them are refused at publish, never silently downgraded |

---

## 2. B1 — TRIGGER AND SELECTION

### 2.1 Trigger vocabulary

`WorkflowTriggerEvent` is a CLOSED enum. In C1 N it has exactly one member:

```
PURCHASE_SUBMITTED
```

That is the one trigger step N can fire. No other trigger event may be invented in N: a
second member arrives as a migration together with the surface that fires it.

### 2.2 Who is a candidate

On a purchase submission the runtime reads the ACTING TENANT's workflow versions where:

- `status = PUBLISHED` (a DRAFT/VALIDATED/ARCHIVED version is never selected — §5.5's
  "PUBLISHED is the state §5.9's pin can cite"), and
- `trigger_event = PURCHASE_SUBMITTED` (a version naming a different trigger, or none, does
  not participate).

### 2.3 Selection is a Rule Engine decision, and it is deterministic

Selection is NOT a row scan and NOT a `findFirst`. It is one evaluation through
`RuleEngineService.evaluateSync(...)` under the rule-set identity:

```
rule-set id : commerce.workflow.selection
version     : derived — a content identity over the candidate set (see §5.3)
```

Each candidate contributes exactly ONE rule:

```
id        : selection:<workflowDefinitionVersionId>
priority  : selection_priority (NULL reads as 0 — stated, not guessed: see §2.6)
condition : selection_condition (the version's stored tree; an absent condition is the
            unconditional tree — every candidate is therefore well-formed as a rule)
action    : REQUIRED_APPROVAL_STEP { stepOrder: 1, approverRuleRef: <versionId> }
```

Using the engine's own frozen types is deliberate: `REQUIRED_APPROVAL_STEP` is the engine's
"this request enters a configured approval flow, at this position, by this opaque configured
reference". Commerce reads the SELECTED version from the winning rule (rule id and the
action's opaque reference must name the same version — a disagreement is refused as an
infrastructure defect, never resolved by preference).

The ordering that decides is the engine's frozen one (§12.1): **priority desc, then condition
specificity desc, then rule id asc** — computed from declared data only.

### 2.4 The required failures

| Code | When |
|------|------|
| `WORKFLOW_SELECTION_NO_MATCH` | zero candidates, or the engine answers `NO_MATCH` (no condition held) |
| `WORKFLOW_SELECTION_AMBIGUOUS` | an unresolved tie on priority+specificity, a Rule Engine `CONFLICT`, a validation refusal of the built set, or any outcome the runtime cannot attribute to exactly one candidate |

An UNRESOLVED TIE means two or more MATCHED candidates whose `(priority, specificity)`
equals the winner's. The engine still names one winner (its comparator is total), but the tie
is not business precedence — it is an administrator's missing priority — so the runtime
refuses rather than shipping whichever rule id sorts first. **Never silently choose one.**

The ambiguity check is performed against the engine's OWN reported ordering basis (`priority`
+ `specificity` per matched rule), never against a locally re-implemented specificity
computation.

`WORKFLOW_SELECTION_INVALID` is the runtime's fail-closed code for a selection rule set the
engine refuses to validate at all, or one whose candidate count exceeds the engine's own
`RULE_LIMITS.maxRulesPerSet`. It cannot be produced by a correctly published configuration;
it exists so that the impossible case is a named refusal rather than a `throw new Error`.

### 2.5 The SELECTED VERSION is what gets pinned

Selection's output IS the exact `WorkflowDefinitionVersion`. There is no second question
("now which version of this workflow?") and no "latest published" lookup anywhere in the
runtime. Pinning rule, as approved:

1. Purchase A submits; V1 is selected; the instance is pinned to V1.
2. V2 is published afterwards.
3. Purchase A remains on V1 — its step instances cite V1's steps, and nothing re-reads
   "the published version".
4. Purchase B, submitted later, may select V2.

### 2.6 `selection_priority` absent

NULL reads as `0`. This is stated here rather than defaulted in SQL so that a DRAFT may be
authored without it (§5.5's incremental authoring) while PUBLISHED selection stays
deterministic. Publication DOES require the trigger event; a version with a NULL
`selection_condition` is admissible only because "unconditional" is itself a configurable
statement — two unconditional candidates with equal priority are exactly the ambiguity §2.4
refuses.

### 2.7 Submission with no applicable workflow

If selection refuses (`WORKFLOW_SELECTION_NO_MATCH` / `_AMBIGUOUS` / `_INVALID`), the SUBMIT
fails and NOTHING is written: the purchase document stays `DRAFT`, no instance exists, and
the caller receives the named refusal. The forbidden state — `PurchaseDocument = SUBMITTED`
with no `WorkflowInstance` — is therefore unreachable (see §8).

---

## 3. B2 — PARALLEL JOIN POLICY

Parallel completion is CONFIGURABLE, per version:

```
WorkflowParallelJoinPolicy = ALL | ANY
```

The version-level policy is REQUIRED at publish when the version has at least one
`PARALLEL` step, and need not be populated when it has none. It is stored on
`WorkflowDefinitionVersion`, never inferred from a count, an array position or a magic
`if (count === n)`. No other policy (QUORUM, MAJORITY, WEIGHTED, CUSTOM) exists in C1 N; a
future policy is an additive migration plus the runtime that honours it.

**ALL**

- every branch of the group must approve for the group to complete;
- the first `REJECTED` branch makes the RUN `REJECTED` (terminal);
- the group's other non-terminal (`PENDING`) siblings are transitioned to `SKIPPED` in the
  same transaction — no branch may remain ambiguously active after a terminal refusal;
- an already-decided sibling keeps its decision: history is never rewritten.

**ANY**

- the first `APPROVED` branch completes the group; the group's remaining `PENDING`
  siblings become `SKIPPED` in the same transaction;
- a `REJECTED` branch does NOT end the run while another branch may still approve;
- if every branch of the group ends `REJECTED` (or `SKIPPED` by condition) with none
  approved, the run becomes `REJECTED`.

**Group membership is configuration, never inference.** Branches of one group share the
step's `parallelGroup` label; the label's first `ordering` orders the groups against each
other. A `PARALLEL` step without a group label is refused at publish (M already refuses it;
N keeps the rule and adds: a group label used by exactly one `PARALLEL` step is admissible —
a one-branch group behaves as ALL/ANY agree on a single decision).

## 4. B3 — CONDITION-FALSE BEHAVIOUR

Per step, CONFIGURABLE:

```
WorkflowConditionFalseBehavior = SKIPPED | BLOCKED | TERMINATED
```

Conditions are evaluated **at step activation time** and the outcome is PERSISTED
(`conditionResult`, `conditionInputSnapshot`, `conditionRuleSetId`, `conditionRuleVersion`).
A read — list, detail, history, UI refresh, report — NEVER re-evaluates (§5.7).

**SKIPPED** — the step instance is persisted as `SKIPPED` with `conditionResult = false`,
the group is completed by its remaining branches (or is empty and the run advances), and the
run proceeds under the ordinary rules.

**TERMINATED** — the step instance is persisted as `SKIPPED` with `conditionResult = false`
(it was never approved and nobody refused it: recording `REJECTED` would attribute a human
decision that no human made), and the RUN becomes `REJECTED` in the same transaction. The
condition outcome, its rule identity and the configured behaviour stay auditable, and no
approval is required from the step.

**BLOCKED** — MODELLED and REFUSED AT PUBLISH in C1 N with the named code:

```
WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED
```

The reason is contractual, not technical: C1 N defines neither WHO resumes a blocked run nor
from WHICH state. Therefore N invents no resume user, no resume permission, no resume route,
no resume state, no timeout and no retry. A stored value of `BLOCKED` may exist on a DRAFT
(so an administrator can see the modelled concept); no PUBLISHED version may carry it, and
execution of `BLOCKED` is unreachable in a valid published N workflow.

**MANDATORY stays separate.** A step's `mandatory` flag, its `condition` and its
`onConditionFalse` are three independent configuration concepts. No implicit precedence
("mandatory overrides condition") is introduced anywhere.

---

## 5. B4 — RULE SET, RULE VERSION AND FACT CATALOGUE

The EXISTING pure Rule Engine decides. N creates no second evaluator, no expression
interpreter, no `eval`, no `new Function` and no SQL rule language. The integration follows
the established HR precedent (`mission-policy.service.ts`): the consuming domain constructs
the `RuleSetVersion` as a VALUE and calls `RuleEngineService.evaluateSync(...)`. The registry
is never consulted and no "latest version" is ever resolved dynamically.

### 5.1 Identities and derivation

| Purpose | rule-set id | version (deterministic content identity) |
|---------|-------------|------------------------------------------|
| Selection | `commerce.workflow.selection` | derived from the candidate set: sorted candidate version ids + their priorities + their condition texts, digested (fixed-width, deterministic) |
| Activation | `commerce.workflow.activation.<definitionCode>` | the pinned `WorkflowDefinitionVersion.id` |

Nothing about either identity changes when a different version is published later: the
activation set is read FROM the pinned version row, and the selection digest covers exactly
the candidates that participated.

### 5.2 Activation set construction

One rule per step of the pinned version, in the version's stated order:

```
id        : activation:<stepKey>
priority  : 0 (all steps carry equal, neutral authority — ordering between steps is the
            version's `ordering`, not a rule precedence)
condition : the step's stored `condition`, or the unconditional tree when absent
action    : STEP_ACTIVATION { stepOrder: <1-based position of the step in the version> }
```

`stepOrder` is the step's **1-based position in the ordered list**, not the raw `ordering`
column: the engine's frozen action semantics bound `stepOrder` to `1…64`, and publication
refuses a version with more than 64 steps rather than writing a position the engine cannot
represent. The decision's `stepOrder` is how the runtime maps an outcome back to the step it
names; a decision naming a position no step occupies is refused as an infrastructure defect.

The evaluation context carries exactly the facts of §5.4, plus `evaluationInstant` (the
transaction's clock read, passed in — the engine never reads a clock).

### 5.3 Evaluation is a decision, and it is recorded

Every evaluation result that MATTERS is persisted on the step instance it decided:
`conditionResult`, `conditionInputSnapshot` (the approved fact projection that was supplied),
`conditionRuleSetId` and `conditionRuleVersion` (§5.7/§5.10's "capture relevant rule/version
identity"). Reading history never re-runs the engine.

### 5.4 The Commerce fact catalogue, v1 — FROZEN

```
kind           enum   {PURCHASE_REQUEST}   (the document KIND vocabulary — one member today)
currency       string (the document's stated currency; absent = null)
supplierId     string
requesterId    string
subtotalAmount number
taxAmount      number
totalAmount    number
lineCount      number
maxLineTotal   number
```

These are the ONLY approved Commerce facts for step N. NOT facts: workflow status, step
status, database ids outside this list, arbitrary Prisma fields, unrestricted object
passthrough. Document/workflow status is NOT a rule fact.

**Money.** A `Decimal(18,4)` becomes a numeric fact only when it is EXACTLY representable as
a JavaScript number (i.e. the Decimal's digits convert losslessly). A value that cannot be
represented exactly — including any magnitude beyond `Number.MAX_SAFE_INTEGER` in
integer-cent terms — makes the projection FAIL CLOSED with a named error; it is never
silently rounded, and the fact is never omitted to make the evaluation "work".

**The catalogue is validated at publish and revalidated at evaluation.** Publication
validates the version's stored conditions against this catalogue through the engine's own
validator; at evaluation the same catalogue object is handed to the engine, so a rule
referencing an unsupported fact fails explicitly rather than reading `undefined`.

### 5.5 Rule-set version status

Both constructed sets carry `status: 'PUBLISHED'`: they are built exclusively from
PUBLISHED workflow versions, and the engine's business gate (`a decision is taken under a
published version and no other`) is thereby honoured rather than bypassed. A set built from
a DRAFT (there is none in N) would be `simulateSync` territory, not `evaluateSync`.

---

## 6. B5 — ACTOR / APPROVER RESOLUTION

Actor source remains CONFIGURABLE — the six modelled sources stay in the schema's vocabulary
so configuration can state the business's intent. Runtime availability is deliberately
narrower, and the narrowing is enforced at PUBLICATION, never at decision time.

### 6.1 Executable in C1 N: `CONFIGURED_USER`

- The configured `actorUserId` is verified against the ACTING TENANT through
  `CommerceIdentityGateway` → `USER_DIRECTORY` (`filterTenantMembers`) at publish (a
  configured person who is not a member of the tenant cannot be published into approval
  duty) — never by querying a Core identity table.
- At activation the step instance records `resolvedApproverId = actorUserId`.
- At decision time the ACTING user must equal `resolvedApproverId`; a decision from anyone
  else is refused (`WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR`), and `resolvedApproverId` is never
  re-resolved from "whoever is calling".

### 6.2 Preserved but not executable in N — refused at publish

| Source | Publish refusal code |
|--------|----------------------|
| `REQUESTER_MANAGER` | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` |
| `GROUP_MANAGER` | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` |
| `CONFIGURED_ROLE` | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` |
| `COMMERCIAL_LIAISON` | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` (and it belongs to step P) |
| `RULE_RESOLVER` | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` |

The reason is a contract gap, not a preference: the approved platform contracts expose
exactly four identity operations (`findProfiles`, `filterTenantMembers`, `findTenantMember`,
`findTenantId`) — there is no manager directory, no role-holder directory, no Commerce role
table, no Core Prisma access from Commerce, and no RULE_RESOLVER field set in N's fact
catalogue. N therefore invents no fallback: no "first admin", no current-user fallback, no
fake approver, no hidden HR query. Each source becomes executable when the platform contract
that resolves it is approved — an additive change.

## 7. B6 — THE N / O / P BOUNDARY

N executes **DOCUMENT-scope** workflows only:

```
PurchaseDocument → selection → document-level steps → decisions → terminal workflow result
```

N does NOT implement and MUST NOT reinterpret: line-level workflow routing, line-level
approver routing, line-specific branch assignment, `lineFilters` execution, Commercial
Liaison resolution, or commercial-specific routing. Those belong to step O (line routing)
and step P (commercial foundation/resolution).

A configuration that requires them is REFUSED at publication with a named code — never
downgraded to document scope:

| Configuration found | Publish refusal code |
|---------------------|----------------------|
| `lineFilters` present on any step | `WORKFLOW_LINE_SCOPE_UNSUPPORTED` |
| `COMMERCIAL_LIAISON` actor source | `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` |

The schema's future LINE-scope ability (`WorkflowSubjectType.PURCHASE_LINE`,
`WorkflowScopeType.LINE`) remains INTACT: N writes `PURCHASE_DOCUMENT` / `DOCUMENT` rows and
adds no constraint that would have to be unwound for O.

---

## 8. TRANSACTION ATOMICITY AND THE UNIT OF WORK — APPROVED RULING

A submit that triggers workflow execution, and every decision that advances a run, are
ATOMIC. The forbidden states are, verbatim:

```
PurchaseDocument = SUBMITTED   and   WorkflowInstance = (none)
WorkflowStepInstance decided   and   WorkflowInstance = (one step behind)
```

### 8.1 The mechanism

ONE MODULE-LEVEL INTERACTIVE TRANSACTION UNIT, owned by the Commerce module
(`database/commerce-transaction.ts`), whose runner is the ONLY caller of the Commerce
client's `$transaction` outside repositories:

```
CommerceUnitOfWork.run(work => ...)            // opens ONE interactive transaction
   → service orchestrates INSIDE the work
   → repositories accept an OPAQUE CommerceTransactionHandle
   → repositories unwrap the handle to their own Prisma.TransactionClient
```

- The handle is opaque by construction: a branded type whose only producer is the unit of
  work and whose only unwrapper is exported from the database boundary (a source-scan guard
  asserts that no service, controller, DTO or domain file mentions it).
- Services MUST NOT depend on Prisma types: no service, controller or DTO imports
  `Prisma.TransactionClient`, `PrismaService` or the generated client. Repositories own every
  statement — including inside a transaction. A repository is never bypassed because a
  transaction is open.
- Repositories that already own a transaction internally (`createDocument`, …) keep that
  form for their single-caller cases; the methods N joins with external work accept the
  handle and run in the CALLER's transaction instead of opening a nested one.

### 8.2 The submit unit of work

```
BEGIN (one interactive transaction)
  markDocumentSubmitted(tx, tenantId, id)        // conditional DRAFT → SUBMITTED
  resolve candidates (PUBLISHED, trigger)        // tenant-scoped read in the same transaction
  evaluate selection (pure engine, no I/O)
  create WorkflowInstance (pinned version)
  create + activate the first eligible step instances (conditions evaluated, approvers
    resolved, outcomes persisted)
COMMIT
then: audit (one row per audited act) and notification (one event)
```

Every refusal inside the work (no workflow, ambiguous selection, unsupported configuration
encountered at runtime) rolls the whole transaction back: no submitted document without a
run, and no orphan run without its document. Audit and notification happen AFTER the commit,
from the committed state — neither can turn a committed mutation into a failure, and neither
runs inside the transaction.

### 8.3 The decision unit of work

```
BEGIN (one interactive transaction)
  load instance + its steps            (tenant-scoped, in-transaction)
  verify actionable + resolved approver (actor equality)
  record the decision conditionally (WHERE status = PENDING → count must be 1)
  apply the configured advance: activate the next group / skip siblings / terminal outcome
COMMIT
then: audit and notification
```

A duplicate decision, a stale/non-actionable step, or an actor mismatch leaves NOTHING
written.

## 9. EXECUTION SEMANTICS

### 9.1 Instance creation

On a valid submission: resolve actor → determine the applicable published workflow (B1) →
pin the exact version → create `WorkflowInstance` (`subjectType = PURCHASE_DOCUMENT`,
`subjectId` = document id, `status = RUNNING`) → create the document-scope
`WorkflowStepInstance` rows as steps activate (`scopeType = DOCUMENT`, `scopeId` =
document id) → evaluate and persist conditions → resolve supported approvers → return the
current execution state.

`WorkflowInstance.status` and `PurchaseDocument.status` remain SEPARATE lifecycles (§5.9):
N never writes `PurchaseDocument.status` except the submit transition itself, and never
writes a purchase status from the workflow runtime.

### 9.2 Ordering, groups and activation

- Steps execute in their configured `ordering`. Nothing in the runtime names `step 1`,
  `step 2`, `step 3`: the order comes from the version's rows.
- A group is one `SEQUENTIAL`/`CONDITIONAL` step, or the set of `PARALLEL` steps sharing one
  `parallelGroup` label. Groups are ordered by their first member's `ordering`.
- Activation evaluates the group's CONDITIONAL members' conditions (persisting each outcome
  and applying `onConditionFalse`), resolves approvers for the members that become
  `PENDING`, and stops there. If the group ends with no actionable member (all skipped by
  condition), the group is complete and the runtime advances — a run whose every remaining
  step is skipped by configuration ends `APPROVED` (nothing required approval), which is a
  configuration consequence and is recorded in audit.
- `TERMINATED` ends the run immediately with `REJECTED` (§4).

### 9.3 Decisions

APPROVE: verify actor, tenant, step-belongs-to-instance, actionable state and resolved
approver; record `APPROVED` + `decidedAt` + optional comment; complete/advance per §3 and
§9.2. The final group's approval makes the run `APPROVED`.

REJECT: same verification; record `REJECTED`; the run becomes `REJECTED` immediately and the
group's remaining `PENDING` siblings become `SKIPPED` (ALL) or the run continues while a
branch may still approve (ANY). `PurchaseDocument.status` is NOT changed by a rejection —
the N contract provides no separate purchase rejection state, and none is invented.

CANCELLATION: `commerce.approve`-guarded route; a `RUNNING` run becomes `CANCELLED` and its
`PENDING` steps become `SKIPPED`, atomically. No cancellation roles, recovery policies,
reopen semantics or rollback of recorded decisions are invented. `EXPIRED` remains a modelled
state with no runtime writer in N (no scheduler, §22).

---

## 10. PUBLICATION IS WHERE CONFIGURATION BECOMES EXECUTABLE

`/validate` and `/publish` gain the completion rules N needs, with NAMED codes. An invalid
version never becomes `PUBLISHED`:

| Refusal code | Rule |
|--------------|------|
| `WORKFLOW_TRIGGER_MISSING` | a version being published must state `trigger_event` |
| `WORKFLOW_JOIN_POLICY_MISSING` | a version with any `PARALLEL` step must state `parallel_join_policy` |
| `WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED` | any step stating `onConditionFalse = BLOCKED` |
| `WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING` | a step stating a `condition` does not state `onConditionFalse` — the runtime never guesses what a false condition means |
| `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` | any step whose `actorSource` is not `CONFIGURED_USER` |
| `WORKFLOW_LINE_SCOPE_UNSUPPORTED` | any step carrying `lineFilters` (O's territory) |
| `WORKFLOW_STEP_COUNT_EXCEEDED` | more steps than the engine's frozen `maxStepOrder` (64) |
| `WORKFLOW_SELECTION_RULE_INVALID` | the version's `selectionCondition` does not validate against the Commerce fact catalogue (engine validator) |
| `WORKFLOW_VERSION_RULE_INVALID` | any step's `condition`/`actorRule` does not validate against the Commerce fact catalogue |

The existing M refusals (key/position/name/mode/parallel-group/actor-parameter/payload-safety,
duplicates, "at least one step") remain in force unchanged and keep their codes.

Publish validation walks the version's stored trees through the engine's own validator with
the Commerce catalogue — the same validator the runtime uses — so "publishable" and
"evaluable" cannot disagree.

`WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING` closes the one gap the approved table left: a
conditional step whose condition turns out FALSE has three configurable meanings (§4) and no
default — silently reading NULL as `SKIPPED` would be exactly the hard-coded behaviour §4
forbids, and reading it as `BLOCKED` or `TERMINATED` would refuse a run the administrator
never configured to be refused. The rule is named here under the approval that authorizes
"other repository-proven publish invariants … with named error codes". It is the one row the
RUNTIME also re-checks, defence in depth: a false condition met at activation with no stated
behaviour fails CLOSED in the same transaction, with the same code, so a row written outside
the publish path cannot be executed either.

## 11. API, PERMISSIONS AND BOUNDARIES

Routes follow the module's existing conventions (`/commerce/…`, DTO-validated, tenant from
`resolveCommerceActor(req)` — never from a DTO field):

```
READ  (commerce.read)     GET  /commerce/workflow-instances
                          GET  /commerce/workflow-instances/:id          (steps + persisted outcomes)
DECIDE (commerce.approve) POST /commerce/workflow-instances/:id/steps/:stepInstanceId/decision
CANCEL (commerce.approve) POST /commerce/workflow-instances/:id/cancel
```

No new permission is introduced: §10's existing `commerce.read` / `commerce.approve` cover
reads and decisions/cancellations, so the permission catalogue stays as step J shipped it
(and the permission-SQL gate stays at its current count).

A read NEVER evaluates: `GET` returns persisted `conditionResult` and stored decisions only.

### §11 STATUS — IMPLEMENTED BY PHASE C2 ( Commerce GAP-1 closure )

Step N shipped the domain behind these four routes (`planWorkflowStepDecision`,
`planWorkflowCancellation`, the repository's conditional writes and §11's list/detail reads)
but no production controller; C1 e2e reached it only through test probes. PHASE C2 exposes it
on `workflow/workflow-execution.controller.ts`, exactly the routes above — same paths, same
permissions, no fifth route — with these as-built semantics (the full contract lives in
`docs/PHASE-C2-WORKFLOW-EXECUTION-HTTP-AND-PENDING-INBOX-CONTRACT.md`):

* `GET /commerce/workflow-instances` → `{items, page, pageSize, total}`; optional
  `status` (runtime vocabulary, validated) and `subjectId` (uuid v4) filters; window from
  `CommercePageQueryDto` (ceiling `COMMERCE_MAX_PAGE_SIZE`); items strip `tenantId`, steps as
  persisted (list projection).
* `GET /commerce/workflow-instances/:id` → one run + pinned version + every step's persisted
  outcome (`decision`, `decisionComment`, `decidedAt`, `conditionResult` + rule identity).
  §5.7's `conditionInputSnapshot` deliberately does NOT ship; a read never evaluates.
* `POST …/steps/:stepInstanceId/decision` body `{decision: APPROVED|REJECTED, comment? ≤500}` →
  `200 {instanceId, status}` — the run's server-authoritative resulting status. The step key
  is derived from the instance the id belongs to (tenant-scoped), then the SAME planner,
  conditional write, advance/settle and dispatch pipeline the approve path always used.
* `POST …/cancel` (bodyless) → `200 {instanceId, status:'CANCELLED'}`; the planner's two writes
  atomically (PENDING → SKIPPED, RUNNING → CANCELLED), nothing else — no dispatch, no document
  movement. Authority is the `commerce.approve` permission alone: the contract says "no
  cancellation roles", so no per-user cancellation actor is invented.

Refusal mapping (HTTP class only; the N codes travel unchanged):

| Condition | HTTP | code |
|---|---|---|
| no principal | 401 | — |
| unresolvable tenant | 403 | exact tenant message |
| missing `commerce.read` / `commerce.approve` | 403 | RBAC |
| DTO/whitelist violation | 422 | `VALIDATION_FAILED` (harness pipe) |
| actor ≠ resolved approver; step key unknown to the pinned version | 400 | `WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR` / planner code |
| step instance id not part of the run; run not in this tenant | 404 | `WORKFLOW_STEP_NOT_FOUND` / run message |
| run not RUNNING; step not PENDING (stale/racing); lost conditional-write race | **409** | `WORKFLOW_INSTANCE_NOT_RUNNING` / `WORKFLOW_STEP_NOT_ACTIONABLE` |

The 409s are Commerce's standing conflict convention (submit / commercial decision /
receiving / returns all answer state conflicts 409); before C2 the service raised 400 for the
two state refusals, and C2 amended exactly two unit assertions while every N code stayed.

## 12. AUDIT AND NOTIFICATION

Audit goes through `CommerceAuditGateway` (never a repository, never a second trail), and
covers: selection (with its basis and refusal reason where applicable), workflow start,
version pin, step activation/skip/block-refusal, approval, rejection, cancellation and
terminal outcome. Notifications go through `CommerceNotificationGateway`: no queue, no
worker, no scheduler, no notification table — N is synchronous and request-driven.

## 13. SCHEMA AND MIGRATION (ADDITIVE ONLY)

New enums:

```
WorkflowTriggerEvent          { PURCHASE_SUBMITTED }
WorkflowParallelJoinPolicy    { ALL, ANY }
WorkflowConditionFalseBehavior{ SKIPPED, BLOCKED, TERMINATED }
```

New nullable columns (add-only; every DRAFT may be incomplete, completeness is enforced at
validate/publish):

```
WorkflowDefinitionVersion  trigger_event        WorkflowTriggerEvent?
                           selection_priority   Int?
                           selection_condition  Json?
                           parallel_join_policy WorkflowParallelJoinPolicy?
WorkflowStep               on_condition_false   WorkflowConditionFalseBehavior?
```

K's baseline migration and the L/M migrations are NOT edited. Every new reference keeps
`onDelete: Restrict`; tenant-first uniques/indexes remain mandatory. The migration is
inspected before it is applied (`migration status`, `prisma validate`, `prisma generate`).

## 14. DELIBERATE INVERSIONS (each one testable)

1. **`PureRuleEngineModule` now IS imported by `CommerceModule`.** `commerce.module.ts`
   previously recorded that it "still arrives with workflow condition evaluation", and
   `commerce-gateways.spec.ts` asserted its absence "before the step that owns it". Step N is
   that step; the comment and the assertion are inverted together, and the spec asserts the
   IMPORT is present (not merely absent-of-a-string).
2. **Publication narrows.** M accepted all six actor sources and any `lineFilters` payload at
   PUBLISH. N refuses five sources and any line filters at PUBLISH. The M specs that asserted
   acceptance are updated to assert the REFUSAL, with the refusal code, because the narrowing
   is the approved contract — not a regression.
3. **`WorkflowInstance`/`WorkflowStepInstance` become written.** M's guard asserted the
   workflow slice contains no statement against them; N adds a NEW repository for them and
   the guard is split: configuration repository still writes no instance rows, execution
   repository writes only instance rows.

---

## 15. INVARIANTS THAT REMAIN FIXED (NEVER CONFIGURABLE)

Tenant isolation (tenant-first repository methods, no `findUnique`, tenant predicate in every
`where`); bounded-context ownership; the repository boundary (services issue no statements,
repositories issue no business decisions, no audit, no notification, no rule evaluation);
Commerce's own Prisma client only (no `PrismaService`, no Core/HR Prisma, no cross-database
relation); the identity boundary (`CommerceIdentityGateway` → `USER_DIRECTORY`); the audit
boundary (`CommerceAuditGateway` → `AUDIT_PORT`); the notification boundary; Rule Engine
purity (one engine, no second evaluator, no `eval`/`new Function`); published-version
immutability; running-version pinning; lifecycle separation (workflow status ≠ document
status); synchronous execution (no queue, worker or scheduler); configuration-first for
business behaviour.

## 16. REQUIRED TEST COVERAGE

Selection (match / no-match / priority / specificity / tie refusal / engine conflict);
version pinning (V1 for A, V2 for B, A stays on V1); sequential advance; parallel ALL
(all approve; one rejects; siblings skipped; terminal); parallel ANY (first approve;
siblings skipped; all reject); conditions (true; false+SKIPPED; false+TERMINATED;
BLOCKED publish refusal; persisted outcome; **no re-evaluation on read**); rules (selection
set identity; activation set identity; version binding; unsupported fact refused; invalid
engine input refused; fact snapshot persisted); actors (CONFIGURED_USER works; tenant
membership enforced; unsupported sources refused at publish); decisions (approve, reject,
cancel, actor mismatch, wrong tenant, wrong step, duplicate, stale); atomicity (submit
rolls back entirely when the run cannot start; decision rolls back entirely when the
advance fails; no partial state); tenant safety (cross-tenant read/decision impossible);
isolation (no forbidden imports, no repository bypass, no audit in repository, no second
engine, no async processor); boundary (document scope works; line scope and commercial
liaison refused in N); falsifiable repository guards with PLANTED-DEFECT fixtures proving
each guard fails when violated.

## 17. IMPLEMENTATION ORDER

1. this document (committed alone); 2. additive migration; 3. repositories; 4. Rule Engine
integration (catalogue, rule-set builders, selection); 5. configurable selection;
6. supported actor resolution; 7. instance creation; 8. sequential execution; 9. parallel
joins; 10. conditional execution; 11. decision/cancel; 12. audit/notification; 13. complete
test matrix; 14. isolation/guard extensions; 15. full validation; 16. the N commit.

## 18. KNOWN LIMITATIONS OF STEP N (STATED, NOT HIDDEN)

- `BLOCKED` cannot be published (no resume contract exists).
- Five actor sources cannot be published (no platform resolver contract exists).
- Line scope and commercial liaison wait for O and P.
- `EXPIRED` has no runtime writer in N (no scheduler exists).
- A tenant whose published versions do not match a submitted document cannot submit
  documents at all: selection refusing is the honest answer (`WORKFLOW_SELECTION_NO_MATCH`),
  and the remedy is configuration, not a fallback.
- The fact catalogue is frozen at v1; widening it is an amendment plus a migration of the
  catalogue version, never an ad-hoc addition.

## 19. APPROVAL RECORD

The three rulings recorded on 2026-09-27 and embodied above:

1. **`BLOCKED`**: modelled; refused at publish; not executable in N.
2. **Atomicity**: one module-level interactive transaction; opaque handle to repositories;
   services never see Prisma.
3. **Documentation**: the authoritative C1 documents and this amendment are committed as
   their own commit before any N implementation code.

Frontend/UI work is explicitly OUT of scope for N and must not begin without a separate
project-owner decision on UX/UI.

END OF AMENDMENT.







