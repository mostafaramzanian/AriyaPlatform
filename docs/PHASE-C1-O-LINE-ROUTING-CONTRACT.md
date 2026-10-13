# PHASE C1 — STEP O — CONFIGURABLE LINE-LEVEL ROUTING
# FINAL CONTRACT — ARCHITECTURE-FIRST / NO-GUESS / TENANT-SAFE

**STATUS:** APPROVED — exact configurable vocabulary now recorded.

**AUTHORITY.** This document is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md`
- `docs/PHASE-C1-EXECUTION-PROMPT.md`
- `docs/PHASE-C1-START-PROMPT.md`
- `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md`

Where this contract is silent, those documents decide.

**BASELINE.** Step N `66697d1` (`feat(commerce): add workflow execution (C1 N)`).

---

## 0. PRINCIPLE

Commerce purchase process behaviour must be **Maximum Practically Configurable** through versioned configuration plus the existing pure Rule Engine, without TypeScript changes for ordinary variations.

**Architectural invariants are NOT configurable:** tenant isolation, Commerce DB ownership, repository boundary, identity/audit/notification boundaries, Rule Engine purity, published-version immutability, running-version pinning, lifecycle separation, no cross-DB FKs, no async processor, no duplicate evaluator.

---

## 1. APPROVED PRODUCT DECISIONS

### O-A — Each `PurchaseLine` has its OWN independent `WorkflowInstance`

```text
Purchase
├── Document Workflow (N)
└── Line Workflows (O)
    ├── Line 1 → WorkflowInstance A (subjectType = PURCHASE_LINE)
    ├── Line 2 → WorkflowInstance B (subjectType = PURCHASE_LINE)
    └── Line 3 → WorkflowInstance C (subjectType = PURCHASE_LINE)
```

- Do not collapse line execution into the document `WorkflowInstance`.
- `WorkflowSubjectType.PURCHASE_LINE` and `WorkflowScopeType.LINE` must now be used.
- Each `WorkflowStepInstance` for a line uses `scopeType = LINE`, `scopeId = lineId`.

### O-B — No second decision engine

Line routing uses the existing `RuleEngineService.evaluateSync(...)`.  
Forbidden: `SimpleFilterEngine`, `LineFilterEngine`, `CommerceRuleEngine`, custom expression evaluators, `eval`, `new Function`.

### O-C — Route selection is Rule-Engine driven and deterministic

A `PurchaseLine` is evaluated against configured route candidates.  
Selection is deterministic. Multi-match resolution must be **configurable**.  
No arbitrary first-row, database-order, latest-version, or random choice.

### O-D — No-route behaviour is configurable

When no route matches, the outcome must be explicitly configured.

### O-E — Multiple matching routes are resolved by configured policy

Multiple matches must not silently select one.

### O-F — Line workflows are independent; document aggregation is configurable

One line can be `APPROVED`, another `REJECTED`, another `RUNNING` simultaneously.  
The relationship between line results and document-level state must be **explicitly configured**.

### O-G — Line fact catalogue is Commerce-owned and allowlisted

Line routing uses a frozen, allowlisted `RuleFieldCatalogue`.  
The Rule Engine must never receive an unrestricted `PurchaseLine` object.

### O-H — Actor source for O remains `CONFIGURED_USER`

Only `CONFIGURED_USER` is executable in O.  
Unsupported resolver sources remain refused at publish.  
Commercial Liaison belongs to step P.

### O-I — Reuse and extend the generic N workflow API

No duplicate workflow API for lines.  
Extend the existing workflow boundary to support `PURCHASE_DOCUMENT` / `PURCHASE_LINE` and `DOCUMENT` / `LINE` scope.

---

## 2. ARCHITECTURAL BOUNDARIES

- N = document-scope execution.
- O = line-scope routing + execution foundation.
- P = commercial foundation / liaison resolution.
- Lifecycle dimensions remain separated: `PurchaseDocument`, document workflow, line workflow, payment, receiving, return.
- Reuse `CommerceUnitOfWork` / `CommerceTransactionHandle` for atomicity.
- Services orchestrate; Rule Engine evaluates; repositories persist; gateways communicate.
- `tenantId` is first parameter of every public repository method; every query is tenant-qualified.
- No `PrismaService`, Core Prisma, HR Prisma, or direct cross-DB access.

---

## 3. FINAL APPROVED CONFIGURABLE VOCABULARY

### O1 — Line routing trigger/timing

Supported values for `WorkflowTriggerEvent`:

- `PURCHASE_SUBMITTED`
- `AFTER_DOCUMENT_WORKFLOW_APPROVED`

These are configuration choices stored in the routing version.

### O2 — No-route behaviour

Enum `WorkflowLineRoutingNoRouteBehavior`:

- `REJECT_OPERATION`
- `LEAVE_UNROUTED`

`REJECT_OPERATION` returns a named refusal and rolls back required writes.  
`LEAVE_UNROUTED` records an explicit `UNROUTED` state without creating a fake workflow.

### O3 — Multiple matching routes

Enum `WorkflowLineRoutingMatchBehavior`:

- `HIGHEST_PRIORITY`
- `AMBIGUOUS_ERROR`

`HIGHEST_PRIORITY` selects the highest priority match; a tie at the top is an `AMBIGUOUS_ERROR`.  
`AMBIGUOUS_ERROR` fails deterministically when more than one route matches.

### O4 — Document aggregation

Enum `WorkflowLineRoutingAggregationPolicy`:

- `ALL_APPROVED`
- `INDEPENDENT`

`ALL_APPROVED` means the PurchaseDocument is treated as approved only when all routable lines are approved.  
`INDEPENDENT` means line outcomes remain independent and no automatic document-level transition occurs.

Mixed line states (`RUNNING`, `APPROVED`, `REJECTED`, `UNROUTED`) must remain representable.

### O5 — Line fact catalogue v1

Allowed facts for `commerce.workflow.line.selection`:

- `lineType`
- `lineNumber`
- `quantity`
- `unit`
- `unitPrice`
- `tax`
- `lineTotal`
- `itemReference`
- `externalRef`
- `technicalDescription`

### O6 — Routing Rule Set identity

Dedicated line routing rule set:

```text
commerce.workflow.line.selection
```

### O7 — Route representation

A route is a JSON rule inside `WorkflowLineRoutingVersion.routeRules` with:

- `priority`: number
- `condition`: Rule Engine condition tree (nullable = unconditional)
- `targetWorkflowDefinitionVersionId`: exact published version to pin
- `description`: optional human label

The set of routes is normalized into one `RuleSetVersion` for `RuleEngineService.evaluateSync(...)`.

---

## 4. IMPLEMENTATION NOTES

- Add `AFTER_DOCUMENT_WORKFLOW_APPROVED` to `WorkflowTriggerEvent` via additive migration.
- Introduce `WorkflowLineRoutingVersion` model with lifecycle, trigger, policies and `routeRules` JSON.
- Extend `workflow-facts.ts` with `COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE`.
- Extend `WorkflowExecutionRepository` to create `PURCHASE_LINE` instances and `LINE` step instances.
- Implement `workflow-line-routing.ts` pure planner for route selection.
- Add `WorkflowLineRoutingService` and `WorkflowLineRoutingRepository`.
- Reuse `CommerceUnitOfWork` for atomic submit/approval-triggered routing.
- Add source-scan and falsifiability guards.
- Do not start frontend/UI.

---

## 5. VALIDATION DISCIPLINE

When implementing, run:

- `npx prisma validate`
- `npx prisma generate`
- `npx prisma migrate status`
- `npx tsc --noEmit`
- Commerce focused tests
- O tests
- full API suite
- architecture / policy / entitlement / tenant / isolation tests
- repository guard tests
- build
- ESLint touched files
- Prettier touched files
- `git diff --check`

Do not fix unrelated pre-existing failures.

---

## 6. GIT DISCIPLINE

1. `docs(commerce): record C1 final configurable line routing decisions`
2. `feat(commerce): add line-level routing (C1 O)`

Never stage `secrets/`, `backups/`, `apps/web/next-env.d.ts`, or unrelated changes.

---

## 7. FINAL PRINCIPLE

The desired runtime is:

```text
PurchaseLine
    ↓
Versioned Routing Configuration
    ↓
commerce.workflow.line.selection
    ↓
Exact WorkflowDefinitionVersion
    ↓
Line WorkflowInstance
    ↓
Workflow Execution
    ↓
Configured Line Result
    ↓
Optional Configured Document Aggregation
```

Never hard-code normal business routing, invent platform resolvers, create duplicate engines, expose unrestricted data to rules, bypass repositories, bypass tenant isolation, dynamically drift versions, introduce async processing, or start frontend/UI.

---

## O4 REMEDIATION AMENDMENT — C1

**Date:** 2026-09-29
**Reason:** Resolve the O4 production gap identified at preflight: `WorkflowLineRoutingVersion.aggregationPolicy` was persisted and validated but had no runtime consumer. This amendment authorizes the schema change, pin semantics, routable-line definition, interaction with P's `CommercialProjectionPolicy`, and test obligations required before implementation.
**Original ambiguity/gap:** No `PurchaseDocument` pin for the active `WorkflowLineRoutingVersion`, no contract definition of "routable line", no settled interaction between `WorkflowLineRoutingAggregationPolicy` and `CommercialProjectionPolicy`, and no rule for existing documents without a pin.

### O4-D1 — Line Routing Version Pin

A `PurchaseDocument` MUST pin the exact `WorkflowLineRoutingVersion` whose `aggregationPolicy` governs its line-routing aggregation semantics.

- Target field: `PurchaseDocument.lineRoutingVersionId`.
- Relation: `(tenantId, lineRoutingVersionId) -> (tenantId, WorkflowLineRoutingVersion.id)`.
- `WorkflowLineRoutingVersion` MUST expose the tenant-first unique target `@@unique([tenantId, id])` to support this composite foreign key.
- The pin is established when the first applicable document-level line-routing trigger (`PURCHASE_SUBMITTED` or `AFTER_DOCUMENT_WORKFLOW_APPROVED`) resolves the routing version used for the document and records it in the same transaction.
- The pin is immutable for the lifetime of the document's relevant routing execution.
- A later published `WorkflowLineRoutingVersion` MUST NOT silently change the aggregation semantics of an already-pinned `PurchaseDocument`.

### O4-D2 — Routable Line Definition

For C1, a "routable line" is a `PurchaseLine` for which the line-routing execution creates a line-level `WorkflowInstance` under the configured routing behavior.

- A line for which routing produces `LEAVE_UNROUTED` does NOT count as a routable line.
- The mere existence of a `PurchaseLine` does NOT make it routable.
- The line type (`STANDARD`, `NON_STANDARD`, `SERVICE`) does not by itself determine routability.
- Routability is determined by the actual line-routing result under the pinned `WorkflowLineRoutingVersion`.

### O4-D3 — O4 / P Projection Interaction

The two configuration spaces remain distinct. P remains the sole owner and writer of `PurchaseDocument.status`. O4 does NOT create a second `PurchaseDocument` status writer.

Runtime dependency direction:

```text
O (WorkflowLineRoutingVersion.aggregationPolicy)
  -> aggregation decision/input
  -> P projection
  -> PurchaseDocument.status mutation
```

Commercial code MUST NOT directly read `WorkflowLineRoutingVersion` through a cross-slice repository. The O-to-P boundary carries the O4 aggregation input.

#### Exact Interaction Matrix

| O4 `aggregationPolicy` | P `CommercialProjectionPolicy` | Effect |
|---|---|---|
| `ALL_APPROVED` | `ALL_LINES` | Document `APPROVED` may occur from line routing only when all routable lines are `APPROVED`. |
| `ALL_APPROVED` | `ALL_LINES_AND_COMMERCIAL` | Document `APPROVED` requires all routable lines `APPROVED` **and** every required commercial approval `APPROVED`. |
| `ALL_APPROVED` | `DOCUMENT_WORKFLOW` | O4 does not override the document-workflow projection; the result is governed by `DOCUMENT_WORKFLOW`. |
| `INDEPENDENT` | `ALL_LINES` | Line-routing outcomes MUST NOT independently produce a document-level `APPROVED`; `INDEPENDENT` prevents the line-routing path from satisfying `ALL_LINES` by itself. |
| `INDEPENDENT` | `ALL_LINES_AND_COMMERCIAL` | Line-routing outcomes MUST NOT independently satisfy the line portion; commercial approval remains a required independent condition under P. |
| `INDEPENDENT` | `DOCUMENT_WORKFLOW` | The document workflow continues to govern document approval; `INDEPENDENT` does not suppress `DOCUMENT_WORKFLOW`. |

This matrix is authoritative for C1. Neither configuration is silently renamed or replaced by the other.

### O4-D4 — Zero Routable Lines

When `aggregationPolicy = ALL_APPROVED`, a document with zero routable lines MUST NOT satisfy the `ALL_APPROVED` line-aggregation condition. This is consistent with the P `ALL_LINES` convention that zero routed lines do not satisfy the all-lines condition.

When `aggregationPolicy = INDEPENDENT`, zero routable lines do not create a line-driven document approval.

### O4-D5 — Existing Documents Without Pin

Existing `PurchaseDocument` rows created before the O4 pin migration may have `lineRoutingVersionId = NULL`. For C1, NULL means:

- O4 aggregation is NOT retroactively inferred from the currently published `WorkflowLineRoutingVersion`.
- No backfill, inference, or hidden fallback is performed.
- For a NULL pin, O4 is treated as NOT APPLICABLE.
- The existing P `CommercialProjectionPolicy` remains authoritative for that document under its existing semantics.

### O4-D6 — Ownership Boundary

- O owns `WorkflowLineRoutingVersion`, `aggregationPolicy`, and routing semantics.
- P owns `PurchaseDocument.status`, commercial projection, and the final document-level status mutation.
- O passes the aggregation decision/input to P through the approved dependency boundary.
- P performs the one `PurchaseDocument.status` write.
- P MUST NOT reach into O's persistence through an unauthorized cross-slice repository.

### O4-D7 — Version Pinning Moment

The `PurchaseDocument.lineRoutingVersionId` pin is assigned in the same transaction in which the first applicable document-level line-routing trigger (`PURCHASE_SUBMITTED` or `AFTER_DOCUMENT_WORKFLOW_APPROVED`) resolves the routing version and routes the document's lines. Subsequent line-routing execution for the same `PurchaseDocument` MUST use the pinned version's semantics and MUST NOT silently switch to a newly published version.

### O4-D8 — Transaction / Tenant Requirement

The pin assignment and the routing execution it describes MUST be consistent within the applicable `CommerceUnitOfWork` / `CommerceTransactionHandle`. Requirements already in force are preserved:

- one Commerce DB;
- tenant-first composite relation;
- no cross-DB FK;
- repository boundary;
- `tenantId` first in repository methods;
- no direct Prisma from services/controllers;
- no second workflow/aggregation store.

### O4-D9 — Migration Requirement

Implementation requires ONE additive Commerce migration:

1. Add `@@unique([tenantId, id])` to `WorkflowLineRoutingVersion`.
2. Add nullable `PurchaseDocument.lineRoutingVersionId`.
3. Add composite tenant-first FK `(tenantId, lineRoutingVersionId) -> (tenantId, WorkflowLineRoutingVersion.id)`.
4. Use the repository's established `ON DELETE RESTRICT` / `ON UPDATE CASCADE` behavior for this relation.
5. No backfill.
6. No historical migration edits.
7. No cross-database relation.

### O4-D10 — Test Obligations

The implementation MUST be falsifiable by tests covering at least:

A. `ALL_APPROVED` + all routable lines approved → line aggregation condition satisfied.
B. `ALL_APPROVED` + one routable line not approved → line aggregation condition not satisfied.
C. `INDEPENDENT` + approved lines → no line-driven document approval.
D. `ALL_APPROVED` + zero routable lines → no line aggregation approval.
E. P `DOCUMENT_WORKFLOW` behavior remains unchanged by O4.
F. P `ALL_LINES` behavior remains correct when O4 applies.
G. P `ALL_LINES_AND_COMMERCIAL` behavior remains correct when O4 applies.
H. Existing document with `NULL` pin does not infer current published aggregation policy.
I. Publishing a new `WorkflowLineRoutingVersion` after a document is pinned does not change the pinned document's aggregation semantics.
J. Tenant A pin cannot be read/used by tenant B.
K. No second `PurchaseDocument.status` writer appears.
L. O4 input is passed from O to P through the approved dependency boundary.
M. No commercial service directly accesses O's repository.

---

## C3 AMENDMENT — LINE-ROUTING CONFIGURATION HTTP SURFACE (status note; NO semantic change)

**Date:** 2026-09-30
**Reason:** GAP-2 — the configuration capability THIS contract defines was reachable only from test
probes. Phase C3 exposed it over HTTP. This note records the surface; no clause above is amended,
superseded or reinterpreted, and no O1–O7 vocabulary, lifecycle rule or pin semantic changed.

- Routes (under the global `/api/v1`): `GET commerce/routing-versions` (`commerce.read`, paged),
  `GET commerce/routing-versions/:id` (`commerce.read`), `POST commerce/routing-versions`
  (`commerce.workflow.manage`, 201, a DRAFT), `POST commerce/routing-versions/:id/publish`
  (`commerce.workflow.manage`, 200, the existing validated transition).
- Create writes §O7's route payload verbatim as a DRAFT; §O1–§O4's closed vocabularies are unchanged
  and are now also stated at the wire boundary from the SAME tuples the publication gate compares
  against (one statement of each vocabulary, not two).
- Publication remains the ONE validated transition (§4, §5): the C3 route delegates to the existing
  gate rather than re-implementing any part of it.
- §O4-D1 immutability and §O4-D7 pinning are untouched; C3 adds no archive, no draft-edit and no
  delete, and no runtime route changed.
- Exactly one published version per tenant and trigger remains the operational invariant
  (`findPublishedForTrigger` has no tie-break): the surface does not relax it, and the C3 e2e proves a
  submit still resolves the SAME version it did before this phase.
- Authority for the surface, the DTOs, the refusals and the tests:
  `docs/PHASE-C3-LINE-ROUTING-CONFIGURATION-HTTP-CONTRACT.md`.

