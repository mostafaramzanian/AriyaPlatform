# PHASE C1 — STEP S — RETURN FOUNDATION
# FINAL CONTRACT — APPEND-ONLY LIFECYCLE / DETERMINISTIC PROJECTION / TENANT-SAFE

**STATUS: CONTRACT RECORD** — the approved rulings S-D1 through S-D5 (§3) and every
behaviour §5.17 and §15 left unspecified that step S cannot be built without (§4),
settled HERE once, before any S code, by the same convention steps N, O, P, Q and R
used. This document was produced by CONTRACT AUTHORING ONLY: no schema, no migration,
no source, no test and no frontend file for S exists or may exist until S Preflight has
passed over this contract and the HEAD code together.

**AUTHORITY.** This document is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` — the authoritative Commerce
  specification: §5.17 returns, §15 return/rejection boundary, §I16 append-only
  records, §I17 return is a child lifecycle, §10 permissions, §11 tenant safety, §13
  payment/finance boundary, §14 receiving/warehouse boundary, §16 database principles,
  §17 migration rules, §24 required domain test 17 ("return child lifecycle").
- `docs/PHASE-C1-EXECUTION-PROMPT.md` (authoritative execution contract)
- `docs/PHASE-C1-START-PROMPT.md` (phase start contract)
- `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md` (§4 names S the owner of the
  return lifecycle; P deliberately implements none of it)
- `docs/PHASE-C1-Q-PAYMENT-HISTORY-CONTRACT.md` (§4: per §5.17, "refunds append to
  payment history through compensating records" — Q's §6 API is the mechanism S calls;
  S adds no write path of its own to `PaymentRecord`)
- `docs/PHASE-C1-R-RECEIVING-FOUNDATION-CONTRACT.md` (§4: S will reference receipt and
  receipt-line ids as OPAQUE references; R guarantees their append-only stability and
  writes NO return record, NO return state)

Where this contract is silent, those documents decide. Where a behaviour was
UNSPECIFIED by them and had to be settled to author step S, it is settled HERE, once —
so that the implementation is a reading of an approved contract rather than a local
invention.

**BASELINE.** Step R `38148cf1bd3e008236b35ba1f6c542fe59478b78`
(`feat(commerce): add receiving foundation (C1 R)`) — the S contract's baseline. R is
COMPLETE, Q is COMPLETE, S HAS NOT STARTED.

**SCOPE OF STEP S.** S makes the return a first-class, append-only child lifecycle: a
`ReturnDocument` with its `ReturnLine`s under a purchase document, an append-only
lifecycle transition history whose read-time projection is the return's current state,
the cumulative quantity invariant bounded by R's net received quantity, and exactly six
routes under `/commerce/purchase-documents/:id/returns`. Backend only. No frontend, no
workflow machinery, no warehouse, no inventory, no Finance module, and no
`PaymentRecord` write path of S's own.

---

## 0. THE PRINCIPLE THIS STEP IS BUILT ON

**APPEND-ONLY RETURN LIFECYCLE, PROJECTED — BOUNDED BY RECEIVING HISTORY, SETTLED BY Q.**

- A return is a CHILD lifecycle (§I17, §15): it references its origin through opaque
  ids and appends new business facts. It never erases or rewrites the parent purchase's
  history (§5.17), and it never writes `PurchaseDocument.status`.
- The return's record is written once; each lifecycle command APPENDS an immutable
  transition row; the current state is a DETERMINISTIC READ-TIME PROJECTION over those
  rows (S-D2). There is no mutable status column, no status writer, and no stored state
  that can disagree with the history it summarises.
- Return quantity is CUMULATIVE and BOUNDED by the net received quantity R's
  append-only receipt history establishes for the referenced receipt line (S-D1).
  Over-return is refused with 409 and no partial write.
- Reaching `REFUNDED` uses Q's established payment-compensation contract and nothing
  else (§4-E). S never touches `PaymentRecord` directly, never creates a payment
  repository or a second compensation model, and never invents a Finance integration.
- Architectural invariants are NOT configurable and NOT negotiable: tenant isolation
  (`tenantId` first, every query, every index, every foreign key); Commerce DB
  ownership with statements issued only from `.repository.ts` files; identity, audit
  and notification reached only through the three Commerce gateways; `Decimal(18,4)`
  exact quantity arithmetic through `purchase-money.ts`; no cross-database foreign
  keys; no second audit trail; existing `commerce.read` / `commerce.manage`
  permissions only.

---

## 1. NON-NEGOTIABLE NO-GUESS RULE

Do not invent business entities, RMA numbers, numbering series, stock movements,
warehouse locations, restocking records, cancellation or reverse-return operations,
transitions, permissions, API routes, error behaviours, locking architectures or
Finance integrations that are not stated in this contract or in the specification
sections it cites. The approved decisions in §3 are AUTHORITATIVE: the implementation
may not reinterpret, weaken or replace them. Where the source is silent and this
contract settles the behaviour, that ruling lives in §4 and is contract, not a code
comment. Where a genuine contradiction exists between this contract and repository
evidence, the rule is STOP — amend HERE first, never in code.


---

## 2. AUTHORITATIVE SOURCE REQUIREMENTS — RECORDED, NOT RECONCILED SILENTLY

What the specification actually says, before any decision is applied to it:

### §5.17 RETURNS (the source text, faithfully)

- Entities: `ReturnDocument`, `ReturnLine`.
- "A return must reference its origin through opaque identifiers: purchase, purchase
  line, receipt line/event."
- "Return owns its lifecycle."
- Possible states: `REQUESTED`, `APPROVED`, `RECEIVED_BACK`, `REFUNDED`, `REJECTED` —
  followed by "Adapt to actual repository convention if needed."
- "A return may use the same Commerce workflow machinery."
- "Return activity must NOT erase or rewrite the parent purchase history."
- "Refunds append to payment history through compensating records."

### §15 RETURN / REJECTION BOUNDARY (the source text, faithfully)

- "Rejected received goods create a return lifecycle."
- "Never simply overwrite: `PurchaseDocument.status` with `REJECTED`."
- "Return preserves: origin, line, receipt, reason, requester, decision, resolution,
  replacement / repurchase requirement."
- "History remains intact."

### §I17 — RETURN IS A CHILD LIFECYCLE

"A return is not merely `PurchaseDocument.status = REJECTED`. A return has its own
lifecycle. It references its origin and appends new business facts." §I16 adds the
general rule S inherits: corrections and reversals are new records; settled rows are
never overwritten.

### §13 / §14 — THE BOUNDARIES AROUND S

§13: Commerce records payment events/history/projection/references; "Do NOT build a
fake full Finance module"; future accounting integration only through explicit
contracts. §14: Commerce may own "return references"; Warehouse is not absorbed;
"Future Warehouse integration must use a contract/port."

### §24 TEST 17

"return child lifecycle" is a REQUIRED domain test — its obligations are defined in
S's test contract (§13).

**RECORDED TENSION.** §5.17's "A return may use the same Commerce workflow machinery"
sits against the repository's append-only convention and against approved decision
S-D3, which declines that option for C1-S. This contract does not pretend the source
said otherwise: both are recorded here, and S-D3 plus §16 state that the APPROVED
DECISION OVERRIDES THE IMPLEMENTATION DEFAULT FOR C1-S — append-only transition
history + read-time projection, no workflow participation.

---

## 3. APPROVED DESIGN DECISIONS — S-D1 TO S-D5 (AUTHORITATIVE)

These five decisions are AUTHORITATIVE for C1-S. They may not be reinterpreted,
weakened or replaced by the implementation.

### S-D1 — QUANTITY INVARIANT

Each `ReturnLine` references exactly ONE `ReceiptLine`. A `ReturnDocument` may contain
multiple `ReturnLine`s. Return quantity is cumulative and bounded by the NET RECEIVED
quantity of the referenced `ReceiptLine`:

    cumulative net returned quantity
      + requested return quantity
    <= net received quantity of that ReceiptLine

Partial returns are allowed. Multiple return operations/documents against the same
`ReceiptLine` are allowed while the invariant holds. Over-return MUST be refused with
HTTP 409 semantics using the exact vocabulary in §10 — never a silent cap, never a
silent clamp. The quantity calculation explicitly considers the receiving
history/projection established by R: §4-C defines "net received" from R's append-only
receipt history, including compensating receipt lines. Concurrency is explicit (§9):
the invariant MUST be evaluated against a consistent, serialized view of the relevant
receipt history AND return history, so that no later implementation can bypass it
through a read-check-write race.

### S-D2 — RETURN LIFECYCLE

The return lifecycle is an independent CHILD lifecycle. Return state MUST NOT be stored
as a mutable status column that is overwritten in place. Lifecycle transitions are
represented through APPEND-ONLY transition history, with the current state obtained by
deterministic read-time projection. The authoritative state vocabulary is exactly:

    REQUESTED
    APPROVED
    RECEIVED_BACK
    REFUNDED
    REJECTED

Allowed lifecycle paths — and ONLY these:

    REQUESTED     -> APPROVED
    APPROVED      -> RECEIVED_BACK
    RECEIVED_BACK -> REFUNDED
    REQUESTED     -> REJECTED

No other transition exists in C1-S. There is no reverse transition, no transition out
of `REJECTED`, and no transition after `REFUNDED` (both are terminal). The return
lifecycle MUST NOT mutate `PurchaseDocument.status`, the purchase document's workflow
state, purchase line workflow state, the commercial lifecycle, the receiving lifecycle
or payment state directly. Return rejection does NOT reject the parent purchase —
stated again as an invariant in §12.

### S-D3 — WORKFLOW PARTICIPATION (CONSCIOUSLY DECLINED)

C1-S does NOT invoke Commerce workflow machinery. §5.17's statement that a return "may
use the same Commerce workflow machinery" is consciously declined for C1-S. Return
lifecycle commands are controlled by the explicit S lifecycle contract (§8). Do not
introduce workflow selection, workflow execution, workflow version pinning or
additional workflow facts into S. Future phases may extend this explicitly; C1-S
remains standalone.

### S-D4 — CORRECTION MODEL: NONE

C1-S provides NO correction, compensation or cancellation operation for a
`ReturnDocument` or `ReturnLine`. There is: no DELETE, no PATCH, no PUT, no
reverse-return operation, no compensating `ReturnLine`, no return-cancellation
transition. Once a return record or lifecycle transition has been successfully written,
it is not edited in place. The only negative lifecycle outcome is
`REQUESTED -> REJECTED`. Q remains the owner of payment compensation; S MUST NOT
create a direct `PaymentRecord` write path.

### S-D5 — RETURN GRANULARITY

A `ReturnDocument` may contain multiple `ReturnLine`s. Each `ReturnLine` MUST reference
exactly one `PurchaseLine` AND exactly one `ReceiptLine`. The `ReturnDocument` itself
references the originating `PurchaseDocument`. Every `ReturnLine` therefore has precise
line-level traceability:

    ReturnDocument -> PurchaseDocument
    ReturnLine     -> PurchaseLine
    ReturnLine     -> ReceiptLine

No many-to-many `ReturnLine`-to-`ReceiptLine` relation is allowed in C1-S.

**REFUND BOUNDARY (part of the approved decisions).** Reaching
`RECEIVED_BACK -> REFUNDED` is NOT a direct `PaymentRecord` mutation. The refund
operation MUST use the established Q payment-compensation contract (settled in §4-E).
S MUST NOT: access `PaymentRecord` through Commerce Prisma directly; create another
payment repository; create another payment service; create another compensation model;
or add a second `PaymentRecord` write path. Q remains payment-history owner; refund/
payment compensation follows Q's established compensation rules; S does not duplicate
Q's payment model. The transition to `REFUNDED` may be considered successful only when
the required Q-side refund/compensation operation succeeds according to the
established Q contract, and a failed Q-side operation MUST NOT leave S projecting
`REFUNDED`. Do NOT invent a new Finance integration.

---

## 4. SETTLED SEMANTICS — THE UNDERSPECIFIED BEHAVIOURS, SETTLED HERE ONCE

Each letter records a behaviour the documents above left open and that step S cannot be
built without. These are contract rulings, not implementation accidents.

### A. Lifecycle storage and projection — defined exactly

There is NO `status`/`state` column on `ReturnDocument` and NO mutable state field
anywhere in the S slice. State lives once: as rows in the append-only transition
history. The pure module `return-lifecycle.ts` (the `payment-status.ts` /
`receiving-status.ts` precedent) owns two things and nothing else:

1. the TRANSITION MATRIX — the four allowed paths of S-D2 plus the terminal rules;
   `canTransition(from, to)` answers true/false and a refusal names the legal sources;
2. the PROJECTION — `projectReturnState(transitions)` orders the return's transition
   rows by `(createdAt ASC, id ASC)` (the deterministic ordering precedent R uses for
   receipt history) and answers the state of the LAST row. An empty history cannot
   exist for a persisted return: creating the return writes its first row,
   `REQUESTED`, in the same transaction as the document and its lines.

Every lifecycle command appends exactly ONE transition row and runs under the
serialization boundary of §9, so a successful command's row is written strictly after
the row it follows and the total order above is the true order. Commands against a
terminal state (`REJECTED`, `REFUNDED`) are refused by the matrix BEFORE any write.

### B. Reason, requester, decision, resolution, replacement/repurchase — exact C1-S shapes

§15 requires a return to preserve origin, line, receipt, reason, requester, decision,
resolution and replacement/repurchase requirement. Settled:

- **origin, line, receipt** = the opaque references of S-D5, structurally enforced by
  the foreign keys of §6 (`purchaseDocumentId` on the document; `purchaseLineId` +
  `receiptLineId` on each line). Nothing else represents them.
- **reason** = bounded FREE TEXT on `ReturnDocument`, NOT a closed enum: one column,
  required at creation, `1…500` characters after trim (the `@MaxLength(500)` reason
  precedent in `receiving.dto.ts` and Q's compensate DTO). Empty after trim is 400.
- **requester** = `requestedByUserId`, an OPAQUE text reference copied from the
  AUTHENTICATED Commerce actor (`resolveCommerceActor(req).userId`), never from
  `tenantId` and never from a DTO field. No DTO may accept `requesterId`,
  `requestedByUserId` or any actor identity (§4-G).
- **decision** and **resolution** = the lifecycle transition history itself, not new
  columns: the decision is the `APPROVED`/`REJECTED` transition row (resulting state,
  actor, timestamp, optional reason); the resolution is the terminal row — `REJECTED`
  or `REFUNDED`. A separate mutable `decision`/`resolution` column would be a second
  source of truth over the same facts and is NOT created; the transition rows plus the
  document's `reason` are the minimum that preserves them.
- **replacement / repurchase requirement** = a `replacementRequired BOOLEAN NOT NULL`
  column on `ReturnDocument`, explicitly stated by the caller at creation (required
  DTO field — no silent default; `false` is a stated fact, not an omission). It is the
  MINIMUM representation §15 needs. No linkage to a replacement purchase document is
  invented: a repurchase LINK would require a purchase-creation contract S does not
  have (§15 requires preserving the requirement, not creating a follow-on document).

### C. "Net received" — defined from R's history, not re-invented

The S-D1 cap is computed against R's append-only receipt history for the referenced
receipt line `R` (all rows in the same tenant):

    netReceived(R) = R.quantity
                     + Σ { L.quantity : L is a receipt line whose
                                        reversesReceiptLineId = R.id }


Compensating receipt lines carry NEGATIVE quantities, so the sum is signed and equals
exactly R's own `available` rule (R contract §3-D). Exact `Decimal(18,4)` arithmetic
through `purchase-money.ts` (`compareMoney`, `addMoney`, `sumMoney`) — never floats,
never a second precision model. S READS receipt lines (read/reference-only, §5); S
never appends, updates or deletes them.

The CUMULATIVE side:

    alreadyReturned(R) = Σ { RL.quantity : RL is a return line whose receiptLineId = R.id
                                            AND its return's projected state
                                                is NOT REJECTED }

A `REJECTED` return never moved goods or money, so its lines stop counting the moment
the projection reads `REJECTED`; every other state counts — including `REQUESTED`,
which is what reserves quantity while a request is pending. This is a RECORDED
AMENDMENT: the source says "cumulative net returned quantity" without defining the
exclusion, and excluding a return that was refused is the faithful reading of "net
returned". The check at creation is exact-boundary inclusive:

    alreadyReturned(R) + requested(R) <= netReceived(R)

Equality is ACCEPTED (received = 100, already returned = 0, requested = 100 → valid);
one unit more → 409 with §10's vocabulary and NO document, NO line and NO transition
written.

### D. Quantity immutability

A `ReturnLine.quantity` never changes after creation — no route could change it
(S-D4). The cumulative sum therefore changes only by (1) creating a return, or (2) a
return entering `REJECTED`, which frees its quantity. No update path exists.

### E. Refund — the Q-side operation, its ordering, and its failure semantics

`POST …/returns/:returnId/refund` settles `RECEIVED_BACK -> REFUNDED` through Q:

1. The body states the Q-side target: `paymentId` (UUID) — the payment row to be
   compensated. This is not a new model: it is the target Q's own §6 compensation API
   requires (`POST …/payments/:paymentId/compensate`), surfaced here because Q's
   contract is the ONLY compensation mechanism a refund may use (§5.17's "refunds
   append to payment history through compensating records" + Q contract §4). The body
   may also state `reason` (≤500) which rides into Q's compensation reason.
2. S validates the return (existence, tenant, document scope) and its projected state
   (`RECEIVED_BACK`, else §10's invalid-transition 409) FIRST, then invokes Q's
   established application-layer contract — the `PaymentHistoryService` surface,
   provided by the same composition root — with the acting actor, the return's origin
   `purchaseDocumentId`, the stated `paymentId` and the reason. S MUST NOT call Q's
   repository, Q's Prisma client, or Commerce Prisma against `PaymentRecord`.
3. If the Q-side operation FAILS (unknown/foreign payment, already compensated,
   anything Q refuses), S maps it to 409 `refund_compensation_failed` (§10), appends
   NO transition, projects NO `REFUNDED`, writes NO S audit row. The return stays
   `RECEIVED_BACK`.
4. Only after the Q-side operation SUCCEEDS does S append the `REFUNDED` transition
   and write its ONE audit row. The Q-side compensation itself is audited BY Q as
   `PAYMENT_RECORD` per Q's contract — S never writes a payment audit resource.

RECORDED ORDERING EDGE (not silently reconciled): Q's append runs outside S's unit of
work (Q has no unit of work by contract), so the two writes are ordered, not atomic.
Q-side first guarantees the hard rule — a failed Q operation can never leave S
projecting `REFUNDED`. The residual direction (Q succeeded, then S's transition append
failed) leaves `RECEIVED_BACK` plus a compensation row; because Q permits at most ONE
compensation per payment row, a retry of the same refund surfaces Q's deterministic
409 rather than double-compensating. Recovery from that residual is an owner-contract
question recorded in §15; C1-S invents no repair operation for it.

### F. Reads are whole-history and unpaged

`GET …/returns` returns ALL of the one document's returns with their lines and
transition histories, oldest first (`createdAt`, `id`), UNPAGED deliberately — this is
one document's return history, not a tenant-wide list (R contract §6 reasoning; Q9's
pagination belongs to Q's paginated route, and inventing a page envelope here would
add an unagreed contract surface). Reads audit nothing.

### G. Actor, tenant, identity

Actor resolution: `resolveCommerceActor(req)` — the ONLY identity source, exactly as
P/Q/R. A missing/empty tenant in the request context throws `ForbiddenException`
(existing behaviour). Tenant isolation is structural:

    Route -> Actor -> Service -> Repository -> Prisma

Every repository method that operates on tenant-scoped data MUST receive `tenantId`
as its FIRST argument; every `where` names the tenant; `findUnique` stays forbidden;
compound uniques are tenant-first. No DTO may accept `tenantId`, `requesterId`,
`actorId` or arbitrary identity — the global ValidationPipe's `whitelist` +
`forbidNonWhitelisted` answers 400 for an unknown field. No cross-DB identity lookup;
no `User`/`Tenant`/`Role`/`Permission` model in Commerce; opaque identity references
only (`requestedByUserId`, transition `actorUserId` are plain text, never resolved).

### H. Permissions — existing names only, mapped per route

No new permission is authorized by this contract: no `commerce.return.read`, no
`commerce.return.manage`, no `commerce.approve`, no other name (§10 of the prompt
lists candidates; "Do not blindly create every permission" — S requires none, as Q7
recorded for payments). Mapping, decided here:

| Route | Permission |
|---|---|
| `GET  …/returns` | `commerce.read` |
| `POST …/returns` (create) | `commerce.manage` |
| `POST …/returns/:returnId/approve` | `commerce.manage` |
| `POST …/returns/:returnId/reject` | `commerce.manage` |
| `POST …/returns/:returnId/receive-back` | `commerce.manage` |
| `POST …/returns/:returnId/refund` | `commerce.manage` |

Standard Commerce guard ordering on the controller, unchanged:
`@RequiresModule(COMMERCE_MODULE_ID)` → `@RequiresFeature(COMMERCE_MODULE_ID,
COMMERCE_FEATURE.PURCHASE)` → `@UseGuards(ModuleEntitlementGuard)` →
`@UseGuards(JwtAuthGuard)` LAST, with `@Roles(...)` on each handler — the exact
decorator order of `payment-history.controller.ts` and `receiving-history.controller.ts`.

---

## 5. RELATION TO Q, R, P, N/O, THE WAREHOUSE AND FINANCE BOUNDARY

- **Q (payment)** stays the owner of payment history. S reads no `PaymentRecord`, and
  its ONLY payment effect is the one delegated call of §4-E through Q's established
  contract. S creates no payment repository, no payment service, no compensation
  model, no second write path, no payment audit resource. Q's projection never reads
  returns (unchanged).
- **R (receiving)** is READ/REFERENCE-ONLY from S: S reads receipt lines to compute
  `netReceived` and stores `receiptLineId` as an opaque reference. S appends nothing
  to `Receipt`/`ReceiptLine`, never rewrites receiving history because a return
  occurred, and never redefines R's projection. R's guarantee of append-only id
  stability (R contract §4) is what makes the opaque reference safe.
- **P (commercial)** stays independent: S never touches `CommercialAssignment`,
  `CommercialApproval`, `CommercialGroup` and never resolves a liaison.
- **N/O (workflow)** stay independent: S never reads or writes `WorkflowInstance` /
  `WorkflowStepInstance`, never starts or pins a workflow (S-D3). Reaching S therefore
  needs NO Rule Engine import — `PureRuleEngineModule` is NOT added to this slice.
- **Warehouse / WMS / inventory / stock ledger / stock movement / logistics /
  shipping**: OUT OF SCOPE. Future integration is an explicit contract/port over S's
  ids (§14 of the prompt). No Warehouse Prisma client, no restocking record.
- **Finance / accounting / cheque / bank / payment records / payment compensation
  records**: OUT OF SCOPE beyond the delegated Q call (§13 of the prompt). No new
  Finance port, no new integration invented here.
- **Notifications, external return/RMA integrations, workflow execution**: OUT OF SCOPE
  — no gateway publishes a return event in C1-S (Q8's reasoning: an event nobody acts
  on is a payload with no consumer).

```text
Purchase Lifecycle ≠ Workflow Lifecycle ≠ Commercial Lifecycle
                  ≠ Payment Lifecycle   ≠ Receiving Lifecycle ≠ Return Lifecycle
```

C1-S owns: `ReturnDocument`, `ReturnLine`, return lifecycle transition history,
return-state projection, and return quantity validation against R's receiving history
and Q's compensation contract as explicitly permitted above. C1-S does NOT own:
Warehouse, WMS, inventory, stock ledger, stock movement, Finance, accounting, cheque
lifecycle, payment records, payment compensation records, logistics, shipping,
external return/RMA integrations, notifications, workflow execution. No cross-DB
relation is introduced.

---

## 6. DATA MODEL — THE LOGICAL CONTRACT BEFORE IMPLEMENTATION

AUTHORITATIVE STRUCTURE: `ReturnDocument`, `ReturnLine`,
`ReturnLifecycleTransition` (the explicit append-only history model). Every field is
classified as AUTHORITATIVE (named by the source), REQUIRED BY APPROVED DECISION (or
by §15/§11 of the prompt), or NOT IN C1-S:

### ReturnDocument

| Field | Classification | Shape |
|---|---|---|
| `id` | AUTHORITATIVE (opaque identity) | UUID, system-generated |
| `tenantId` | REQUIRED (§11 tenant safety) | TEXT, first column, first index column |
| `purchaseDocumentId` | AUTHORITATIVE (§5.17 "purchase") | UUID, composite FK `(tenant_id, purchase_document_id) → PurchaseDocument`, RESTRICT |
| `requestedByUserId` | REQUIRED BY §15 (requester) | TEXT?, the actor's userId as opaque metadata, server-derived (§4-B) |
| `reason` | REQUIRED BY §15 | TEXT `1…500`, free text, NOT an enum (§4-B) |
| `replacementRequired` | REQUIRED BY §15 (replacement/repurchase) | BOOLEAN NOT NULL, caller-stated (§4-B) |
| `createdAt` | REQUIRED | `timestamptz(6)` default now; NO `updatedAt` |
| `lines` | AUTHORITATIVE | `ReturnLine[]` |
| `transitions` | REQUIRED BY S-D2 | `ReturnLifecycleTransition[]` |

`@@unique([tenantId, id])`; `@@index([tenantId, purchaseDocumentId, createdAt])`.

### ReturnLine

| Field | Classification | Shape |
|---|---|---|
| `id` | AUTHORITATIVE | UUID |
| `tenantId` | REQUIRED (§11) | TEXT |
| `returnDocumentId` | REQUIRED BY S-D5 | UUID, composite FK `(tenant_id, return_document_id) → ReturnDocument`, RESTRICT |
| `purchaseLineId` | AUTHORITATIVE (§5.17 "purchase line") | UUID, composite FK `(tenant_id, purchase_line_id) → PurchaseLine`, RESTRICT |
| `receiptLineId` | AUTHORITATIVE (§5.17 "receipt line/event") | UUID, composite FK `(tenant_id, receipt_line_id) → ReceiptLine`, RESTRICT |
| `quantity` | REQUIRED BY S-D1 | `Decimal(18,4)`, strictly positive, exact decimal string on the wire |
| `createdAt` | REQUIRED | `timestamptz(6)`; NO `updatedAt` |

`@@unique([tenantId, id])`; `@@index([tenantId, returnDocumentId])`;
`@@index([tenantId, receiptLineId])` (the cumulative-quantity read);
`@@index([tenantId, purchaseLineId])`.

### ReturnLifecycleTransition

| Field | Classification | Shape |
|---|---|---|
| `id` | REQUIRED (row identity) | UUID |
| `tenantId` | REQUIRED (§11) | TEXT |
| `returnDocumentId` | REQUIRED BY S-D2 | UUID, composite FK `(tenant_id, return_document_id) → ReturnDocument`, RESTRICT |
| `state` | AUTHORITATIVE (§5.17 vocabulary) | closed enum `ReturnState { REQUESTED, APPROVED, RECEIVED_BACK, REFUNDED, REJECTED }` — stored ON THE APPEND-ONLY ROW, never as a document column (§16 of the prompt: enums for closed vocabularies) |
| `actorUserId` | REQUIRED (§4-G actor info) | TEXT?, the acting user as opaque metadata; NULL allowed for a machine caller |
| `reason` | REQUIRED (optional transition reason) | TEXT `1…500` NULL — the stated reason of approve/reject/refund when given |
| `createdAt` | REQUIRED | `timestamptz(6)`; NO `updatedAt` |

`@@unique([tenantId, id])`; `@@index([tenantId, returnDocumentId, createdAt])`.
The resulting `state` uniquely determines which command produced the row (each state
has exactly one incoming edge in the S-D2 matrix), so no redundant command column is
added; the contract's "actor/source information" is state + actor together.

`PurchaseDocument` and `PurchaseLine` gain only virtual back-relations
(`returns` / `returnLines`) — NO column, NO status, NOTHING stateful on either parent.

### Explicitly NOT created (each refusal recorded)

RMA number / series / counter; warehouse location; restocking record; SKU copy; stock
movement; financial account; bank/cheque fields; logistics metadata; replacement
purchase linkage; cancellation or reverse-return row; many-to-many
`ReturnLine`↔`ReceiptLine`; any mutable status column; any `updatedAt` on an
append-only row; any Commerce audit table; any notification/event payload.

---

## 7. API SURFACE — NOTHING BEYOND THIS

Controller `ReturnHistoryController` in the `returns/` slice (§18's required file
structure), `@Controller('commerce/purchase-documents')` — the path names the ROW the
calls address, mirroring `payment-history.controller.ts` and
`receiving-history.controller.ts` exactly: same decorator order (§4-H), both path ids
behind `ParseUUIDPipe` (400 at the edge, 404 from the service), and
`resolveCommerceActor(req)` as the ONLY identity source.

| # | Method + route | Permission |
|---|---|---|
| 1 | `GET  /commerce/purchase-documents/:id/returns` | `commerce.read` |
| 2 | `POST /commerce/purchase-documents/:id/returns` | `commerce.manage` |
| 3 | `POST /commerce/purchase-documents/:id/returns/:returnId/approve` | `commerce.manage` |
| 4 | `POST /commerce/purchase-documents/:id/returns/:returnId/reject` | `commerce.manage` |
| 5 | `POST /commerce/purchase-documents/:id/returns/:returnId/receive-back` | `commerce.manage` |
| 6 | `POST /commerce/purchase-documents/:id/returns/:returnId/refund` | `commerce.manage` |

No PATCH, no PUT, no DELETE, no extra route, no return list outside a document, no
status-transition route beyond the four named commands, no cancellation route.

**Path parameters.** `:id` = the origin `PurchaseDocument` UUID; `:returnId` = the
`ReturnDocument` UUID, looked up SCOPED by `(tenantId, purchaseDocumentId, returnId)` —
so a return of another tenant, of another document, or an unknown id are the SAME 404,
indistinguishable by design (no probe). A non-UUID in either position is 400 from
`ParseUUIDPipe` before any service call.

**Request bodies.**

    # 2 create:
    { reason: string (1..500, trimmed, required),
      replacementRequired: boolean (required),
      lines: [ { purchaseLineId: UUID, receiptLineId: UUID,
                 quantity: number (>0, ≤4 decimal places) } ] }   // min 1 line

    # 3 approve:   { reason?: string (1..500) }   // empty body is complete
    # 4 reject:    { reason?: string (1..500) }
    # 5 receive-back: {}                          // empty body is complete by design
    # 6 refund:    { paymentId: UUID, reason?: string (1..500) }

**Fields FORBIDDEN from every payload** (400 under the global pipe's `whitelist` +
`forbidNonWhitelisted`, and asserted by the DTO spec): `tenantId`, `requesterId`,
`requestedByUserId`, `actorId`, `receiverId`, `id`, `state`/`status`,
`purchaseDocumentId`, `createdAt`, `transitions`, `reversesReturnLineId`, any
`replacementPurchaseId`, any stock/warehouse/RMA field, `currency` (a return states no
money — Q owns money).

**Actor derivation.** Every handler passes `resolveCommerceActor(req)`; the requester
of a create and the `actorUserId` of every transition come from that actor only.

**Response shapes** (explicit projections — `tenantId` can never reach a body by
omission of thought; quantities are EXACT decimal strings):

    #1 GET  …/returns →
      { returns: [ { id, reason, replacementRequired, requestedByUserId, createdAt,
                     state,                       // §4-A projection, not a column
                     lines: [ { id, purchaseLineId, receiptLineId, quantity, createdAt } ],
                     transitions: [ { id, state, actorUserId, reason, createdAt } ] } ] }
      // OLDEST FIRST (createdAt, id); whole history; UNPAGED (§4-F)

    #2 POST …/returns               → 201, the stored document view (shape above)
    #3..#6 each command             → 201, the document view AFTER the appended
                                       transition (the command appended a row: the
                                       same 201-with-stored-row precedent as Q's
                                       compensate). `state` shows the projection.

**Status codes.** 200/201 success; 400 invalid UUID / invalid or empty payload /
forbidden field / reason or quantity bounds; 403 missing actor (existing resolver);
404 unknown/foreign origin, line, receipt line or return (§10); 409 invalid lifecycle
transition, over-return, reference mismatch, refund/Q-compensation failure (§10).

---

## 8. STATE COMMAND SEMANTICS — PRECONDITIONS, EXACTLY

    APPROVE      (route 3):  REQUESTED     -> APPROVED       requires current = REQUESTED
    RECEIVE-BACK (route 5):  APPROVED      -> RECEIVED_BACK  requires current = APPROVED
    REFUND       (route 6):  RECEIVED_BACK -> REFUNDED       requires current = RECEIVED_BACK
    REJECT       (route 4):  REQUESTED     -> REJECTED       requires current = REQUESTED

- CREATE (route 2) appends the initial `REQUESTED` row together with the document and
  its lines — one transaction, all-or-nothing.
- Every command runs the §4-A matrix FIRST; any invalid transition is rejected with
  409 (`invalid_transition`, §10) WITHOUT mutating state: no transition row, no
  document write, no audit row. The response names the current state and the legal
  sources of the requested command.
- No transition may mutate `PurchaseDocument.status` — asserted structurally (S reads
  no parent status to gate a command: like Q6/R's §3-I, no document status restricts
  who may act on a return; inventing such a gate would be a silent default).
- REFUND additionally carries §4-E: Q-side compensation must succeed BEFORE the
  `REFUNDED` row exists.
- Each successful command is audited exactly once (§11). Refused commands and reads
  audit nothing.

---

## 9. QUANTITY INVARIANT AND THE CONCURRENCY OBLIGATION

**The invariant** (S-D1, §4-C): for every receipt line referenced by a created line,

    alreadyReturned(R) + requested(R) <= netReceived(R)

evaluated with exact `Decimal(18,4)` arithmetic over (a) R's append-only receipt
history for `R`, including negative compensating receipt lines, and (b) the tenant's
return lines excluding `REJECTED` returns — a consistent view of BOTH histories.

**The serialization requirement (binding on the later implementation).** Because
returnability is bounded by receipt-line net received quantity, the invariant MUST be
evaluated against a consistent SERIALIZED view of the relevant receipt history and
return history. The implementation MUST NOT perform:

    1. read available quantity
    2. release consistency
    3. write the return

without holding the required lock/transaction boundary across all three. Two
concurrent creations against the same receipt line must not both pass the check; the
loser receives 409 with no partial write, exactly as R's over-receipt rule refuses its
own race.

**Grounding, deliberately not invented here.** R already solves the identical problem
for over-receipt (R contract §3-H): every write path FIRST takes a PostgreSQL row lock
(`SELECT … FOR UPDATE`) inside the caller's `CommerceUnitOfWork`, then reads history
and evaluates the invariant — database-native, no invented distributed lock. S's write
paths MUST follow the same pattern: ONE `CommerceUnitOfWork.run` per command whose
FIRST act acquires the required serialization boundary BEFORE any receipt-history read
or return-history read. The EXACT lock target and lock order may be specified only
after S Preflight grounds it in the actual R schema and repository structure (the
precedent candidate is the same tenant-scoped `PurchaseDocument` row lock R takes,
which would serialize S against R's own writes; the alternative of locking the receipt
line must be evaluated against R's index structure at preflight). This contract states
the invariant and the serialization requirement; it does NOT invent an unrelated
locking architecture, and implementation may not proceed without a preflight-approved
lock target.


---

## 10. ERROR VOCABULARY — CLOSED, DETERMINISTIC, NO VAGUE GENERIC ANSWERS

Each entry is a distinct, testable answer. Messages are exact; no other 404/409 wording
may be introduced in the S slice without amending THIS contract first.

**400 (DTO/edge)**

| Refusal | Where it is answered |
|---|---|
| non-UUID `:id` / `:returnId` | `ParseUUIDPipe` at the edge |
| invalid/empty create payload (no lines, empty `lines`, non-positive or >4-decimal quantity, failed bounds) | DTO validation |
| forbidden field (`tenantId`, `state`, `requestedByUserId`, …) | global pipe `whitelist` + `forbidNonWhitelisted` |
| `reason` empty-after-trim or >500 | DTO validation |

**403** — missing tenant/actor: `resolveCommerceActor` throws `ForbiddenException`
(existing behaviour, unchanged).

**404 (existence/ownership — foreign, wrong-document and unknown are INDISTINGUISHABLE
by design, no probe):**

| Exact message | Meaning |
|---|---|
| `Purchase document not found` | origin document unknown or other tenant |
| `Purchase line not found` | line id not owned by THIS document/tenant |
| `Receipt line not found` | receipt line unknown, other tenant, or not part of this document — including a receipt line from another document (the lookup is scoped by document AND tenant, R's rule) |
| `Return document not found` | `:returnId` unknown, other tenant, or not a return OF this `:id` |

**409 (conflict — the named S refusals):**

| Code token | Exact message shape | Meaning |
|---|---|---|
| `over_return` | `Return quantity exceeds the net received quantity of its receipt line: net received <a>, already returned <b>, requested <c>` | S-D1 violated; names all three quantities exactly as R's over-receipt does |
| `invalid_transition` | `Only a return in <sources> may be <command>; this return is <state>` | matrix refusal (§8); `<sources>` is the legal set, `<state>` the projection |
| `line_reference_mismatch` | `Return line's receipt line does not belong to its purchase line` | both references exist in scope but contradict each other (S-D5) |
| `invalid_origin` | `Purchase line does not belong to the origin purchase document` | stated line not part of `:id` (when not already 404 by scoping) |
| `refund_compensation_failed` | `Refund compensation failed: <Q's refusal message>` | Q-side operation failed (§4-E); NO transition, NO `REFUNDED`, NO S audit |

An over-return discovered under concurrency (the race loser after §9's lock) answers
the same `over_return` 409. A second compensation of the same `paymentId` reaches S as
`refund_compensation_failed` carrying Q's deterministic "already has a compensating
row" refusal. Any ADDITIONAL error may be added only if explicitly necessary and
defined HERE before implementation.

---

## 11. AUDIT — ONE TRAIL, FIVE ACTIONS, THE EXISTING RESOURCE

Resource: `COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT` (`commerce.return_document`) —
reserved in step G exactly for this row; NOTHING else may be audited by S. A dedicated
`RETURN_AUDIT_ACTION` record lives in the future implementation layer beside the code
that records it, following the `PAYMENT_AUDIT_ACTION` / `RECEIVING_AUDIT_ACTION`
convention (§3-G of Q, §3-G of R):

    RETURN_AUDIT_ACTION = {
      CREATE:      'create',        // route 2 — the new document
      APPROVE:     'approve',       // route 3
      REJECT:      'reject',        // route 4
      RECEIVE_BACK:'receive_back',  // route 5
      REFUND:      'refund',        // route 6 — the LIFECYCLE act only
    }

- Exactly ONE audit row per successful lifecycle command, through
  `CommerceAuditGateway` (§12 of the prompt; repositories never audit — the Q/R
  pattern). `resourceId` = the return document id; `oldValue` carries the prior
  projected state, `newValue` carries the resulting state and the appended transition
  id; the stated reason rides the ONE trail rather than becoming a second column.
- Reads audit nothing. Refused operations (404/409/400) audit nothing.
- The REFUND row is the return's transition act on `commerce.return_document` — it is
  NOT a payment audit: the payment side is audited BY Q as `PAYMENT_RECORD` per Q's
  contract. S must not create a duplicate refund/payment audit resource, and S must
  not write `COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD`.


---

## 12. PARENT LIFECYCLE PROTECTION — INVARIANTS THAT MUST HOLD

These are invariants of the S slice, each later covered by an executable
lifecycle-independence test (§13, §24 test 17 and its siblings):

1. A return NEVER changes `PurchaseDocument.status`.
2. A REJECTED return NEVER rejects the parent purchase (§15's "never simply overwrite
   `PurchaseDocument.status` with `REJECTED`" — the return's own `REJECTED` state is
   the rejection; the parent is untouched).
3. Return APPROVAL never approves the purchase (document/workflow/commercial state
   unchanged).
4. RECEIVE-BACK never marks the purchase received/completed — receiving stays R's
   projection, purchase completion stays §29's own guards.
5. REFUND never changes purchase workflow, commercial or receiving state; its only
   external effect is the delegated Q compensation (§4-E).
6. Return history remains independently queryable — reading returns never requires
   reading a parent status, and reading a parent never requires reading returns.
7. Nothing in S reads or writes `WorkflowInstance`, `WorkflowStepInstance`,
   `CommercialAssignment`, `CommercialApproval`, `Receipt`, `ReceiptLine` (beyond the
   read of §4-C) or `PaymentRecord` (beyond the delegated call of §4-E).

---

## 13. TEST CONTRACT — OBLIGATIONS DEFINED HERE, TESTS NOT CREATED NOW

Executable test obligations for the later S implementation (falsifiable, with
planted-defect fixtures in the scans, as Q/R did). Do not create these tests until S
implementation begins.

**Domain / projection (`return-lifecycle.spec.ts`):** the transition matrix exhaustively
— the four legal paths accepted, every other pair refused, terminal rules
(`REJECTED` and `REFUNDED` accept nothing out); projection over ordered rows — first
row `REQUESTED`, last row wins, `(createdAt, id)` determinism; vocabulary ↔ schema join:
`ReturnState` members equal the five §5.17 states in order, and NO
`ReturnDocument.status`/`state` column exists anywhere in the schema (S-D2's falsifiable
half, the mirror of `purchase-status.spec.ts` / Q2's guard).

**Quantity (`return-quantity` behaviour in the service spec):** cumulative return
quantity across MULTIPLE return documents on ONE receipt line; exact-boundary ACCEPTANCE
(`==` passes); one-unit-over REFUSAL with NO document, NO line, NO transition, NO audit;
`netReceived` derived from R history INCLUDING negative compensating receipt lines;
`REJECTED` returns excluded from the sum while every other state counts; multi-line
creation is atomic (one bad line refuses the whole document); `Decimal(18,4)` exactness
(no float comparison).

**Concurrency structure:** the source guard pins the `FOR UPDATE`/lock statement and the
service test proves the lock is taken BEFORE any receipt/return history read (R §3-H's
two falsifiable stand-ins, applied to S); no read-check-write sequence exists outside
the unit of work.

**Lifecycle independence:** a rejected return does not mutate `PurchaseDocument.status`;
approve/receive-back/refund do not touch parent/workflow/commercial/receiving/payment
state (§24 tests 17–20's S half); return history reads standalone.

**Q boundary:** refund goes through `PaymentHistoryService`'s public surface; S's
sources contain NO `paymentHistory.repository`/`PaymentRecord` access, no Commerce
Prisma call against payment tables; a Q-side failure yields
`refund_compensation_failed` with NO `REFUNDED` transition and NO S audit; the audit
scan proves S writes only `COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT`.

**Granularity (S-D5):** one `ReturnLine` → one `ReceiptLine` + one `PurchaseLine`
(structurally by composite FK, asserted by schema TEXT join); multi-line
`ReturnDocument` supported; no many-to-many table exists.

**Append-only / repository:** repository surface pinned BY NAME; NOT ONE
`.update(`/`.updateMany(`/`.delete(`/`.deleteMany(`/`.upsert(` anywhere in the S
repository; no `updatedAt` on the three S tables; `tenantId` first on every public
method; every `where` names the tenant; no `findUnique`.

**Actor / permissions / routes:** requester and `actorUserId` derived from session, not
payload (a DTO accepting `tenantId`/`requestedByUserId` is 400); the six routes and
their exact permissions (§7) — no seventh route, no `commerce.approve`, no new
permission name; guard-ordering spec covers the new controller automatically
(`commerce-entitlement.spec.ts`'s `*.controller.ts` scan); no PATCH/PUT/DELETE
decorator exists in the slice.

**Audit count/vocabulary:** exactly one audit row per successful command; zero for
reads and refusals; the service-source scan asserts the closed action set is exactly
`CREATE, APPROVE, REJECT, RECEIVE_BACK, REFUND` on `RETURN_DOCUMENT` (R's
`RECEIVING_AUDIT_ACTION` scan pattern).

**Cross-module isolation:** no Core/HR/Finance/WMS client import, no Rule Engine, no
notification, no identity gateway in the S slice; no cross-database FK; migration SQL
free of other owners' names; the module-wide isolation suite covers S once the files
exist.

**Existing guards, extended deliberately (each edit is a gate decision):**
`workflow-configuration.repository.spec.ts`'s `REPOSITORY_NAMES` gains the S
repository's name (a ninth name — exactly the deliberate edit its header anticipates),
with the append-only write-shape branch already in place; `commerce-entitlement.spec.ts`
and `commerce-gateways.spec.ts` need no edit (S adds no gateway, no token, no baseline
change).

---

## 14. MIGRATION CONTRACT — ONE ADDITIVE MIGRATION, DESCRIBED NOT CREATED

The future S implementation uses exactly ONE new migration directory (the next free
sequence after `20260929000003_receiving_foundation` — preflight confirms the exact
name, intended shape `20260929000004_return_foundation`) under
`apps/api/prisma/commerce/migrations/`. Required properties, binding on that
migration:

- ADDITIVE only: creates the three S tables, the `ReturnState` enum and their
  indexes/FKs. NO existing table is rewritten; no column is added to
  `PurchaseDocument` or `PurchaseLine` beyond virtual back-relations; NO historical
  migration is edited; NO `db push` / `migrate dev` against an applied history.
- Tenant-first: `tenant_id` leads every index and every composite unique; every
  composite FK is `(tenant_id, <fk>) → parent(tenant_id, id)` (composite-FK safe,
  tenant-scoped so a cross-tenant reference cannot resolve).
- RESTRICT-based: every `ON DELETE`/`ON UPDATE` is `RESTRICT` — lifecycle rows are
  never cascade-deleted (no Commerce lifecycle deletion, §4 gate 14).
- Free of cross-DB relations: no reference to `core_db`, `hr_db` or any other owner's
  tables; identity stays opaque text (§17 of the prompt).
- The SQL is generated with `prisma migrate diff`, INSPECTED by hand (no
  `DROP`/`TRUNCATE`/`DELETE`), then `prisma validate`, `prisma generate`,
  `prisma migrate status`, applied via the repository's established commerce migrate
  script (`npm run db:migrate:commerce`, Q/R precedent).

Schema constraints the migration MUST express (from §6): composite FKs named above,
`@@unique([tenantId, id])` on all three tables, the four named indexes per §6, and —
where §16 of the prompt demands critical invariants not rest solely on application
code — the strongest the engine allows for S-D1 (the cumulative cap is cross-row and
cannot be a CHECK; its database-level support is the serialization boundary of §9 plus
the NOT NULL/positive CHECK on `ReturnLine.quantity`, with the cap itself proven by
the §13 tests. Any stronger construct preflight finds in the actual engine is a
preflight finding, not an implementation improvisation).

---

## 15. OUT OF SCOPE / DELIBERATELY NOT DECIDED HERE

Recorded rather than patched, per Q §8's convention:

- **Workflow participation.** Declined for C1-S (S-D3). §5.17's MAY stands for future
  phases; re-enabling it requires an explicit contract amendment, not code.
- **Return cancellation / correction / reverse-return.** None in C1-S (S-D4). Whether
  a later phase adds a compensating return model is an owner decision.
- **Recovery from the refund ordering edge** of §4-E (Q succeeded, S's transition
  append failed): no repair operation is invented; a future contract must settle it.
- **Multi-payment refunds in one command** (one refund command compensating several
  payment rows): not in C1-S — one refund transition (terminal) with one Q-side
  compensation per invocation.
- **Replacement/repurchase linkage** to a real follow-on purchase document: only the
  `replacementRequired` flag exists (§4-B).
- **Return numbering / RMA**: refused (R3's reasoning applied to S).
- **Notifications/events** for return transitions: none (Q8's reasoning).
- **Frontend/UI**: zero content in this contract; S UI, if ever, is its own step with
  its own contract.

---

## 16. CONSISTENCY CHECK — PERFORMED BEFORE COMMIT

| Compared against | Result |
|---|---|
| §5.17 vs decisions | Vocabulary identical (five states); opaque origin refs encoded as S-D5 FKs; "owns its lifecycle" = S-D2; "must NOT erase/rewrite parent" = §12; "refunds append through compensating records" = §4-E via Q. The one tension — "may use the same Commerce workflow machinery" — is RECORDED in §2 and RESOLVED in favour of append-only transition history + read-time projection: **APPROVED DECISION OVERRIDES IMPLEMENTATION DEFAULT FOR C1-S** (S-D3), consistent with §5.17's own "Adapt to actual repository convention if needed". |
| §15 vs decisions | reason/requester/decision/resolution/replacement all have exact shapes (§4-B); "never overwrite `PurchaseDocument.status`" = §12 invariants; "history remains intact" = append-only + parent independence. |
| Q contract vs refund boundary | S adds no `PaymentRecord` write path; the only payment effect is the delegated `PaymentHistoryService` call of §4-E; audit split (S: `RETURN_DOCUMENT`; Q: `PAYMENT_RECORD`) matches Q §3-G and the step-G resource notes. No contradiction with Q4/Q7 (no new permission, one compensation per row — carried into §10). |
| R contract vs receiving references | `receiptLineId` opaque, read-only; `netReceived` reuses R's exact `available` rule (§4-C); §9 mirrors R §3-H's lock-first pattern without duplicating R's code; R §4's "S will later reference receipt ids" guarantee honoured. |
| Permissions/actor vs P/Q/R | `commerce.read`/`commerce.manage` only, same guard order, `resolveCommerceActor(req)` only, DTOs free of identity — identical patterns (§4-G/§4-H). |
| Tenant isolation (§11) | `tenantId` first everywhere, composite tenant FKs, tenant-first uniques/indexes, indistinguishable 404s — no contradiction. |
| Lifecycle separation | Return lifecycle touches no other dimension (§5, §12); consistent with §5.11–§5.13, §I15/I17 and Q6/R §3-I. |
| Frontend/UI | None introduced — documentation only. |
| Implementation files | None changed — only this document is staged. |

---

**FINAL GATE: CONTRACT COMPLETE — READY FOR S PREFLIGHT**
