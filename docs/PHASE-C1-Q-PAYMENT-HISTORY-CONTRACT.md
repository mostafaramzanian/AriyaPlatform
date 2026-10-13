# PHASE C1 — STEP Q — PAYMENT HISTORY
# FINAL CONTRACT — APPEND-ONLY / DETERMINISTIC PROJECTION / TENANT-SAFE

**STATUS: CONTRACT RECORD** — the Q rulings Q1–Q9 (§2) and the semantics that the documents
below left unspecified and that step Q cannot be built without (§3), settled HERE once,
before any Q code is written, by the same convention steps N, O and P used.

**AUTHORITY.** This document is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (authoritative Commerce specification —
  §5.13 payment state, §5.14 payment history, §13 payment/finance boundary, §I16, §24's test
  matrix items 14–19, §29)
- `docs/PHASE-C1-EXECUTION-PROMPT.md` (authoritative execution contract)
- `docs/PHASE-C1-START-PROMPT.md` (phase start contract)
- `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md` (§4 of P names Q/R/S as the owners of
  payment/receiving/return; P deliberately implements none of them)

Where this contract is silent, those documents decide. Where a behaviour was UNSPECIFIED by
them and had to be settled to implement step Q, it is settled HERE, once — so that the
implementation is a reading of an approved contract rather than a local invention.

**BASELINE.** Step P repair `3675c22` (`fix(commerce): repair C1 P commercial foundation`) —
the Q preflight baseline. Gates at preflight: architecture 24, policy 32, full API suite as
recorded in the final report — all PASS.

**SCOPE OF STEP Q.** Q makes payment history a first-class, append-only Commerce domain:
a `PaymentRecord` child of the purchase document, one row per payment event, a read-time
payment status projection (§5.13), compensating rows as the only correction mechanism, and
three routes under `/commerce/purchase-documents/:id/payments`. Backend only. No frontend,
no receiving (R), no returns (S), no Finance module, no cheque/bank entities, no invoice
entity — those are outside Q and are recorded as deferred in §8.

---

## 0. THE PRINCIPLE THIS STEP IS BUILT ON

**APPEND-ONLY MONEY HISTORY, PROJECTED — NEVER REWRITTEN, NEVER STORED TWICE.**

- Every payment event is a ROW that is written once and never updated or deleted
  (§5.14, §I16). A correction is a NEW row that points at the row it reverses.
- The payment status (UNPAID / PARTIAL / PAID / OVERPAID) is a DETERMINISTIC PROJECTION of
  those rows at read time (§5.13). There is no stored status column, no status writer and no
  projection table to rebuild — the history is the source of truth, so a status can never
  disagree with the rows it summarises.
- Payment state is an INDEPENDENT dimension: it is not workflow state, not commercial state,
  not receiving state and not the purchase document's own lifecycle (§5.11, §5.12, tests 18
  and 19). Nothing in Q reads or writes a workflow table, and nothing in Q gates a payment
  on a document status (§3-F).

**Architectural invariants are NOT configurable and NOT negotiable:**

- tenant isolation (`tenantId` first, every query, every index, every foreign key);
- Commerce DB ownership; statements issued only from `.repository.ts` files;
- identity / audit / notification reached only through the three Commerce gateways;
- one money domain — `Decimal(18,4)`, exact string arithmetic in `purchase-money.ts`;
- no cross-database foreign keys; no second audit trail; no async processing in C1;
- `commerce_db` grows ONE table and ONE enum in Q, additively.

---

## 1. NON-NEGOTIABLE NO-GUESS RULE

Do not invent business entities, invoice entities, cheque entities, payment statuses,
transitions, thresholds, permissions, API behaviour, fallback behaviour or historical
semantics. If a semantic Q needs is genuinely absent from the documents and this contract:
STOP, record the exact missing contract here (or in §8), and do NOT silently implement it.

The rulings in §2 and §3 are this contract's own decisions and are settled; §8 records what
is deliberately NOT decided.

---

## 2. FINAL DECISIONS — Q1 TO Q9

### Q1 — `PaymentRecord` is a child of the purchase document
§5.14 allows "child of the purchase document OR explicit invoice entity". C1 has no invoice
entity anywhere (§13: Commerce records payment events/history/projection/references), so Q
attaches every payment to `PurchaseDocument` through an OPAQUE `purchaseDocumentId` plus the
tenant — composite foreign key `(tenant_id, purchase_document_id) → PurchaseDocument(tenant_id, id)`,
RESTRICT, exactly like every other relation in the schema. Every later payment against the
same purchase appends to the SAME document (§5.14's example, §29's "later payments continue
on the same purchase"); a new Purchase Request is never created for a later payment.

### Q2 — Payment status is a READ-TIME projection, with no stored column
§5.13 permits a stored state column only if it is declared a projection, rebuildable
deterministically and proven by tests. Q takes the simpler branch the same section describes
first: the state "may be a deterministic projection" — so it IS one, computed in
`payment-status.ts` from the stored rows and the document's own `totalAmount`. Therefore:

- there is NO `PaymentStatus` column and NO `PaymentStatus` enum in `prisma/commerce/schema.prisma`;
- the vocabulary lives once, in TypeScript (`PAYMENT_STATUSES`), and a guard spec fails if a
  `PaymentStatus` enum/column ever appears in the schema (the projection would then have two
  sources of truth);
- tests prove the projection exhaustively (§7), which is exactly the third §5.13 condition.

### Q3 — Payment methods: `CASH`, `PETTY_CASH`, `CHECK` — CHECK IS A LABEL, NOT A FINANCE ENTITY
The method vocabulary is closed at three members (the step-Q specification's own list) and is
stored as the `PaymentMethod` enum. `CHECK` names a payment method a tenant states; it does
NOT create a cheque, bank, instrument, endorsement or clearing model in Commerce, and Q
creates no Finance port (§13: "Do NOT build a fake full Finance module"). The payment's own
`externalReference` / `invoiceRef` strings are where a future Finance contract will find its
opaque identifier — references, not relationships. A fourth method arrives as an additive
migration plus its DTO membership, never as a free-text column.

### Q4 — Corrections are COMPENSATING ROWS; full reversal; one per row
- The ONLY correction is `POST …/payments/:paymentId/compensate`, which INSERTs a new row
  whose `amount` is the EXACT NEGATION of the target's amount and whose `reversesPaymentId`
  names the target. The pair therefore sums to zero and the projection reflects it
  immediately — the original row is untouched, and the history shows both what was recorded
  and that it was withdrawn.
- FULL reversal only. A partial correction would need an owner contract for how much of a
  payment may be undone and how the remainder is described; none exists in C1, so Q does not
  invent one. A client that needs a net adjustment appends a NEW payment row (§5.14's
  30% + 40% + 30% example is three positive appends).
- At most ONE compensation per row, enforced STRUCTURALLY by
  `UNIQUE (tenant_id, reverses_payment_id)` — two concurrent compensations of the same
  payment cannot both land, and the loser receives 409 rather than a second reversal.
- There is NO `PATCH`, NO `PUT`, NO `DELETE` on payments, ever. The repository exposes no
  update or delete method at all, and the guard spec that pins the repository surface fails
  if one appears (§7).

### Q5 — The currency is SNAPSHOTTED from the document, never client-stated
A payment is settled in the currency of the purchase it pays, so the DTO carries NO
`currency` field (the global pipe rejects one) and the service copies
`PurchaseDocument.currency` into the row at append time — NULL stays NULL, because the
schema deliberately has no default currency (§5.1's money note). Stating a currency per
payment would let two rows on one document disagree, and the projection sums amounts: an
amount without an agreed unit is not a fact. The compensating row mirrors the original
row's currency and method — a reversal of a CHECK payment is not a CASH payment, and a
reversal cannot re-denominate money.

### Q6 — No payment is gated on the document's lifecycle status
Nowhere does C1 state a payment precondition, and §5.11/§5.12/§I15 forbid conflating the
lifecycle dimensions (test 18: "workflow state independent from payment state"). So Q
refuses a payment ONLY when the document does not exist in the acting tenant (404). A
payment may be appended on a DRAFT, a SUBMITTED, an APPROVED, a REJECTED, a CANCELLED or a
CLOSED document, and §29's "later payments continue on the same purchase" is satisfied
without special-casing completion. Deciding that some status must refuse payments is a
business rule; it would arrive with the step that owns that transition, stated in a contract
— not here.

### Q7 — Existing permissions only
`commerce.read` for the read, `commerce.manage` for both writes — the same §10 split the
purchase routes use (§3-I of P's contract: reuse existing `commerce.*` names; any genuinely
new permission is an additive Core migration recorded first, and Q requires none).
`commerce.approve` stays absent: no payment route decides anything.

### Q8 — No Q notifications
No Commerce event is published by Q (P's §3-N precedent, and §I9's "the event vocabulary
belongs next to the rule that produces each event"): no reader exists for a payment event,
and an event nobody acts on is a payload with no consumer. The step that gives a payment an
effect outside this slice adds its own event beside the code that emits it.

### Q9 — The page is paginated; the projection is ALWAYS the whole history
The list route uses the shared `CommercePageQueryDto` / `resolveCommercePageWindow` envelope
(§8's list shape, `COMMERCE_MAX_PAGE_SIZE`), and its optional filters (`method`, `search`)
narrow only the PAGE. The `paymentStatus` block returned beside the page is computed over
ALL of the document's payment rows, unfiltered — a filtered page that silently reported a
filtered total would be a status that changes when a user types into a search box. The sum
and the page are read in ONE array-form `$transaction`, so the status cannot describe a
different moment than the rows rendered with it.

---

## 3. SETTLED SEMANTICS — THE UNDERSPECIFIED BEHAVIOURS, SETTLED HERE ONCE

Each letter records a behaviour the documents above left open and that step Q cannot be
built without. These are contract rulings, not implementation accidents.

### A. Append-only is enforced in the APPLICATION LAYER, structurally
`commerce_db` has no trigger precedent and Q does not add the first one (a trigger would be
a rule invisible to the repository's reviewers and untestable by the suite). Instead:

- `PaymentHistoryRepository` EXPOSES ONLY `append` and tenant-scoped `read` methods — no
  update, no upsert, no delete exists in the file, so no caller can rewrite a settled row;
- the repository-surface guard (§7) already refuses `.update(` / `.delete(` in EVERY
  Commerce repository and additionally pins the append-only repository's method list;
- the schema carries no `updated_at` on `PaymentRecord` (a column that only ever changes
  once is a lie about mutation) — the row's own clock is `createdAt`, like
  `CommercialAssignmentHistory.changedAt`;
- the unique `(tenant_id, reverses_payment_id)` makes the correction link itself a
  one-to-one fact rather than a convention.

### B. The projection, defined exactly (§5.13)
Inputs: `paidAmount` = Σ `amount` over ALL of the document's payment rows (compensating rows
are negative and therefore subtract), and the document's stored `totalAmount`.

| # | Condition | Status |
|---|---|---|
| 1 | `totalAmount IS NULL` (document not priced — §5.1's "not stated yet", NEVER zero) | `null` — the projection is UNDEFINED, and stating `UNPAID` for a document with no stated total would invent one |
| 2 | `paidAmount ≤ 0` (no rows, or only reversals) | `UNPAID` |
| 3 | `paidAmount = totalAmount` (exact) | `PAID` |
| 4 | `paidAmount > totalAmount` | `OVERPAID` |
| 5 | otherwise (`0 < paidAmount < totalAmount`) | `PARTIAL` |

Notes, each deliberate:

- `status` is `PaymentStatus | null` on the wire — `null` ONLY through rule 1, and the
  `paidAmount` / `totalAmount` / `currency` beside it are still reported, so a client can
  render "no total stated" honestly instead of a fake `UNPAID`.
- Comparisons are EXACT (`compareMoney` over `Decimal(18,4)`), never float — a document
  totalling `26.2500` with `26.2500` paid is `PAID`, not `PARTIAL`, and never `OVERPAID`.
- A priced document whose lines are free totals `0.0000`; with nothing paid rule 2 answers
  `UNPAID`, and any positive payment immediately answers `OVERPAID`. Both are correct: the
  document asks for nothing and money arrived anyway.
- The projection never reads workflow, commercial or receiving state — rule 1 reads the
  document's own total and nothing else (test 19).

### C. Money
Every amount crosses the wire as its exact `Decimal(18,4)` STRING (the repository's
convention, §8's "do not expose Prisma models"), is validated at the boundary with
`@IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE })` + `@Max(PURCHASE_MAX_MONEY_AMOUNT)`
(the same numbers the columns hold), and is converted with `moneyFromNumber` before it
reaches Prisma. Q ADDS two pure functions to `purchase-money.ts` rather than re-deriving
arithmetic in the slice: `compareMoney` (exact three-way comparison, the projection's rule
engine) and `negateMoney` (the compensating amount — a pure sign flip of the exact scaled
value, so a reversal is bit-for-bit the original's magnitude). `purchase-money.spec.ts`
grows with them: money has ONE home.

### D. The compensating row, field by field

| Field | On compensation |
|---|---|
| `amount` | `negateMoney(original.amount)` — never client-stated |
| `method` | mirrored from the original (Q5) |
| `currency` | mirrored from the original (Q5) |
| `reversesPaymentId` | the original's `id`, inside the acting tenant |
| `paymentDate` | the caller's stated instant, else the row default (now) |
| `externalReference` | the caller's own reference for the correction, else NULL |
| `payerRef` / `payeeRef` / `invoiceRef` | NULL — each row states its OWN references; the original's are the original's evidence |
| `recordedByUserId` | the acting session's user (`actor.userId`, NULL for a machine context) |

`reason` (optional, `≤ 500` chars) is accepted and handed to the platform audit event's own
`reason` field — the ROW states WHAT reversed what, the ONE trail states WHO did it and WHY.
Commerce keeps no second trail (§12), so the correction's rationale is deliberately not a
column.

### E. Failure vocabulary (§28's shape — named refusals, never silent)

| Situation | Answer |
|---|---|
| document id not held by the acting tenant (or not a UUID) | `404` / `400` — indistinguishable from "does not exist"; a 403 would confirm a foreign id (§8's read rule) |
| payment id not held by that document in that tenant | `404` |
| compensating a payment that already has a compensating row (the read race's loser) | `409`, naming the existing reversal — the unique index is the authority, the read is the early answer |
| a validation failure (non-positive amount, unknown method, fifth decimal, oversized reference) | `400` with the field, at the DTO — never a driver error |
| audit or identity gateway failure | never a business branch: the write already succeeded; `CommerceAuditGateway` logs and swallows (§I8) |

No fallback, no default method, no "auto-unpaid", no silent clamp.

### F. Tenancy
`tenantId` is the FIRST parameter of every repository method and appears in EVERY `where`
(the module-wide guard reads the source for exactly this), every index leads with
`tenant_id`, and both foreign keys are composite on `tenant_id`. No DTO, path or query
carries a tenant; the actor resolves it. A payment row can therefore never name another
tenant's document even if its UUID were guessed — the FK and the predicate both require the
tenant.

### G. Audit (§I8)
One trail, through `CommerceAuditGateway`, resource `COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD`
(`commerce.payment_record` — already declared in step G's constants for exactly this row),
two actions declared beside the code that records them:

- `append` — `resourceId` = the new row, `newValue` = the row's own facts (document id,
  amount, currency, method, payment date, references);
- `compensate` — `resourceId` = the compensating row, `oldValue` = the target's id and
  amount, `newValue` = the reversal's amount and `reversesPaymentId`, `reason` = the stated
  reason.

The repository records NO audit (the guard §7 proves the persistence layer stays silent) and
neither write publishes an event (Q8). Reads audit nothing — Q has no mutating read.

### H. The currency-change edge, recorded rather than patched
A document's `currency` is editable while the document is DRAFT (step L), so a document
could in theory collect one payment in `IRR`, then be re-stated to `EUR` and collect
another. Each row keeps ITS snapshot (Q5) and the projection sums amounts regardless — which
in that scenario would compare mixed units. Q does NOT invent a rule forbidding either act
(no contract states one, and refusing a legitimate edit is also a rule). Recorded in §8 as
an owner-contract gap: "may a document's currency change once payment history exists?".

---

## 4. RELATION TO P, TO R/S, AND TO THE FINANCE BOUNDARY

- **P** owns commercial groups, assignment, approval and the ONE document-status projection
  writer. P's contract §4 states P MUST NOT implement payment history — Q ships it now, with
  no commercial field on `PaymentRecord` and no commercial state read by Q. The two slices
  touch only the shared `PurchaseDocument` row (P writes its status; Q reads its totals),
  never each other's tables.
- **R (receiving)** and **S (returns)** own receipts and the return lifecycle. Per §5.17,
  refunds "append to payment history through compensating records" — i.e. the API Q exposes
  in §6 is the mechanism S will call; S adds no write path of its own to `PaymentRecord`.
- **Finance (§13)**: Q establishes the Commerce payment records and their contract only.
  Future accounting integration happens through an explicit port added later, reading these
  rows' opaque references. No Finance module, no cheque table, no bank model, no fake
  ledger, no double-entry anything in C1.

```text
Purchase Lifecycle ≠ Workflow Lifecycle ≠ Commercial Lifecycle
                  ≠ Payment Lifecycle  ≠ Receiving Lifecycle ≠ Return Lifecycle
```

---

## 5. SCHEMA GAP SET — THE MINIMUM MODELS (§22's shape)

One additive migration: `prisma/commerce/migrations/20260929000002_payment_history/`.

```prisma
enum PaymentMethod {
  CASH
  PETTY_CASH
  CHECK
}

model PaymentRecord {
  id                   String        @id @default(uuid()) @db.Uuid
  tenantId             String        @map("tenant_id") @db.Text
  purchaseDocumentId   String        @map("purchase_document_id") @db.Uuid
  amount               Decimal       @map("amount") @db.Decimal(18, 4)
  currency             String?       @db.VarChar(3)
  method               PaymentMethod
  paymentDate          DateTime      @default(now()) @map("payment_date") @db.Timestamptz(6)
  payerRef             String?       @map("payer_ref") @db.VarChar(128)
  payeeRef             String?       @map("payee_ref") @db.VarChar(128)
  invoiceRef           String?       @map("invoice_ref") @db.VarChar(128)
  externalReference    String?       @map("external_reference") @db.VarChar(128)
  reversesPaymentId    String?       @map("reverses_payment_id") @db.Uuid
  recordedByUserId     String?       @map("recorded_by_user_id") @db.Text
  createdAt            DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  // no updatedAt: an append-only row never changes (§3-A)
}
```

Decisions the shape above states:

- **fields** are §5.14's own list (amount, currency, method, paymentDate, payerRef, payeeRef,
  invoiceRef, externalReference, reversesPaymentId, createdAt) plus `recordedByUserId`,
  which every Commerce history row carries (`CommercialAssignmentHistory.actorUserId`
  precedent) because an append-only fact that cannot say who recorded it is only half an
  answer;
- **reference columns are `VARCHAR(128)` opaque strings**, never resolved entities — there
  is no supplier, bank or invoice table to point at, and §13 asks for references;
- **relations**: composite `(tenant_id, purchase_document_id)` → `PurchaseDocument`, RESTRICT;
  composite `(tenant_id, reverses_payment_id)` → `PaymentRecord` itself, RESTRICT (nullable,
  so an ordinary payment's link column is simply not matched);
- **indexes**: `UNIQUE (tenant_id, id)` (the tenant-first read every table has),
  `UNIQUE (tenant_id, reverses_payment_id)` (Q4's one-reversal rule), and the history read's
  `(tenant_id, purchase_document_id, created_at)` — every one LEADING with `tenant_id`;
- **no `PaymentStatus`**, no document-level payment column, no total: the projection is
  computed (Q2), so the document stays free of payment state exactly as its own note
  demands ("not a payments/receipts ledger or a projection storage").

NOT added: invoice entity, cheque/bank table, payment status column, `updatedAt`, `reason`
column, cross-database anything.

---

## 6. API SURFACE (§25's shape — nothing beyond this)

Controller `PaymentHistoryController`, `@Controller('commerce/purchase-documents')` — the
path names the ROW the calls address, exactly as the purchase controller's own note
anticipates ("its payment history (step Q) … hang off this document"). Standard boundary:
`@RequiresModule` + `@RequiresFeature(PURCHASE)` + `ModuleEntitlementGuard` + `JwtAuthGuard`,
`resolveCommerceActor(req)`, DTOs without `tenantId`, no Prisma exposure.

| Method + route | Permission | Purpose |
|---|---|---|
| `GET  commerce/purchase-documents/:id/payments` | `commerce.read` | page of payment rows, oldest first, PLUS the `paymentStatus` projection over the whole history |
| `POST commerce/purchase-documents/:id/payments` | `commerce.manage` | append one payment event (201: the stored row) |
| `POST commerce/purchase-documents/:id/payments/:paymentId/compensate` | `commerce.manage` | append the compensating row (201: the stored row) |

Deliberately absent: `PATCH`/`PUT`/`DELETE` on payments, a status-transition route, a
`currency` or `reversesPaymentId` field on the create payload, a route that mints a second
purchase document, and any payment list outside a document (payments have no meaning apart
from the document they settle).

Response shape (explicit projection, so that `tenantId` never reaches a body):

```text
GET  …/payments → {
  items: [{ id, amount, currency, method, paymentDate, payerRef, payeeRef, invoiceRef,
            externalReference, reversesPaymentId, recordedByUserId, createdAt }],
  page, pageSize, total,
  paymentStatus: { status: PaymentStatus | null, paidAmount, totalAmount, currency }
}
POST …/payments                → the stored row, same field list
POST …/payments/:id/compensate → the stored row, same field list
```

---

## 7. TESTS, GUARDS, ISOLATION, MIGRATIONS

**Domain tests (new files; the §24 matrix items in bold):**

- `payment/payment-status.spec.ts` — **the projection exhaustively** (rules 1–5 of §3-B,
  including unpriced → `null`, exact `PAID`, `OVERPAID`, a reversal returning the status to
  `UNPAID`); plus the vocabulary ↔ schema TEXT join: `PAYMENT_METHODS` equals the schema's
  `PaymentMethod` members in order, and NO `PaymentStatus` enum/column exists anywhere in the
  schema (Q2's falsifiable half — the mirror of `purchase-status.spec.ts`).
- `payment/payment.dto.spec.ts` — boundary refusals: non-positive amount, fifth decimal,
  amount above `PURCHASE_MAX_MONEY_AMOUNT`, unknown method, oversized references, and
  compensation accepting an empty body (every field is optional by design).
- `payment/payment-history.service.spec.ts` — **14 partial payment**, **15 multiple payments
  on the same request**, **16 compensating payment record**, plus: the actor's tenant is the
  repository's FIRST argument on every call; a foreign or unknown document is 404 BEFORE any
  write; currency is snapshotted from the document and never taken from a payload; the
  compensating amount is the exact negation with method and currency mirrored; a second
  compensation is 409 (both the early read and the unique-index `null`); **18** no
  workflow/commercial read of any kind; **19** status depends on the document's total and
  the rows only; **21** tenant-first calls and no `tenantId` in any response; **22** no
  identity lookup is needed (every reference is opaque — the gateway stays the only identity
  path precisely by having none here); **23** exactly one audit row per write, through
  `CommerceAuditGateway`, on the step-G resource.
- `purchase-money.spec.ts` — `compareMoney` / `negateMoney` (exactness, sign, refusal of
  what cannot be stored).

**Existing guards, extended deliberately (each edit is a gate decision, not a weakening):**

- `workflow-configuration.repository.spec.ts` — `REPOSITORY_NAMES` gains
  `payment/payment-history.repository.ts` (the repository set is pinned BY NAME; a seventh
  repository is exactly the "deliberate edit to this gate" its header anticipates), and the
  write-shape rule gains the append-only branch: a repository must contain NEITHER
  `.update(` NOR `.delete(` (unchanged) AND must contain `.updateMany(` OR `.create(` —
  i.e. it either performs conditional plural writes or performs NO row-mutating write at all.
  §3-A is why: an append-only repository that can never satisfy "has an updateMany" would
  otherwise be forced to grow a write the contract forbids. The floors and the
  planted-defect fixtures of that spec stay untouched.
- `commerce-entitlement.spec.ts` — automatically covers the new controller (every
  `*.controller.ts` must declare the module id, the feature pair and the platform guard);
  no edit.
- `commerce-gateways.spec.ts`, `commerce-schema.spec.ts` — no edit required: Q adds no
  gateway, no platform token and no baseline change (the baseline migration is history; the
  new enum and table arrive in their own migration, which is exactly how B expects the
  schema to grow past it).

**Isolation / repository rules proven for Q** (module-wide scans already cover them; Q's
tests make them non-vacuous for this file): statements only from the repository; no
`findUnique`; `tenantId` first on every public method; every `where` names the tenant; no
audit, no notification, no Rule Engine, no `generated/commerce-client` import outside the
persistence layer; no cross-database FK; no Commerce audit table.

**Migrations:** additive only; never edit an applied migration; the SQL is generated with
`prisma migrate diff`, INSPECTED by hand (no `DROP`/`TRUNCATE`/`DELETE`, no `core_db` or
other owner names, tenant-leading indexes, composite tenant FKs), then `prisma validate`,
`prisma generate` and `prisma migrate status` before the suite runs.
