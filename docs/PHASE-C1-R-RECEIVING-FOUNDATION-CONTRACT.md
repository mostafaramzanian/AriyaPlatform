# PHASE C1 — STEP R — RECEIVING FOUNDATION

# FINAL CONTRACT — APPEND-ONLY EVENTS / DETERMINISTIC PROJECTION / TENANT-SAFE

Status: APPROVED (owner decisions R1–R10, recorded here before implementation)
Scope: backend only — `apps/api`, Commerce bounded context. No frontend, no
Warehouse, no inventory, no payment, no return writes.

============================================================ 0. THE PRINCIPLE THIS STEP IS BUILT ON
============================================================

R is RECEIVING HISTORY + RECEIVING PROJECTION. Nothing else:

    PurchaseLine
        ↓
    Append-only Receipt Events (actual received quantity)
        ↓
    Received-quantity projection over ordered quantity
        ↓
    NOT_RECEIVED | PARTIALLY_RECEIVED | FULLY_RECEIVED

Corrections are NEW negative compensating events; the original row never
changes. Over-receipt (projected > ordered) is ALWAYS REFUSED — no tolerance,
no percentage, no exception approval. Receiving is an INDEPENDENT lifecycle:
it never mutates `PurchaseDocument.status`, never touches workflow, commercial
or payment state, and those never gate receiving. Warehouse/WMS/ASN/dock/bin
semantics are OUT OF SCOPE; future integration requires an explicit
contract/port.

Business behavior: configurable where actually meaningful. Architectural
invariants: fixed. No silent defaults, no hidden state, no mutable receipt
history, no cross-tenant access, no cross-DB relations, no fake
Warehouse/Finance, no frontend.

============================================================

1. NON-NEGOTIABLE NO-GUESS RULE
   \============================================================

Everything below is either an APPROVED owner decision (R1–R10), a direct
consequence of one, or a RECORDED AMENDMENT (§3 letters) settling behaviour
the specification left open. Where the preflight found no authoritative
source (tolerance, numbering, compensation-chain rules, route shapes,
permission justification, status membership), the decision was made by the
owner and is written here BEFORE code. Nothing in implementation may invent
a rule that is not stated here or in the specification sections this
contract cites. A genuine contradiction between this contract and
repository evidence is a STOP, not a silent choice.

============================================================ 2. FINAL DECISIONS — R1 TO R10
============================================================

### R1 — Maximum receivable quantity

The maximum receivable quantity for a `PurchaseLine` equals the ordered
`PurchaseLine.quantity`. There is no other permitted-quantity definition.

### R2 — Over-receipt is FORBIDDEN in C1 R

No tolerance. No percentage tolerance. No exception approval mechanism.
Ordered = 100, received = 100 → valid; next receipt of 1 → rejected, nothing
persisted, the transaction rolls back. The check is
`currentReceived + newQuantity <= orderedQuantity`, evaluated per line
against exact `Decimal(18,4)` arithmetic — never floats, never a silent cap.

### R3 — No human receipt numbering in C1 R

Receipts are identified by their system-generated immutable id. No receiving
counter, no numbering series, no number-minting table is created.

### R4 — Receiving correction is APPEND-ONLY

Never modify or delete an existing receipt event. A correction is a NEW
compensating receiving event with NEGATIVE quantity that names the receipt
line it compensates. Original: +100, correction: −20 → net 80; the original
row remains byte-for-byte unchanged.

### R5 — Receiving status is a READ-TIME PROJECTION

Approved vocabulary: `NOT_RECEIVED`, `PARTIALLY_RECEIVED`, `FULLY_RECEIVED`.
No mutable receiving status field is persisted anywhere — not on
`Receipt`, `ReceiptLine`, `PurchaseLine` or `PurchaseDocument`.

### R6 — Receiving lifecycle is independent from `PurchaseDocument.status`

R must NOT change `PurchaseDocument.status`. Receiving completion is NOT
Purchase completion. Conversely, no document status gates receiving (§3-I).

### R7 — API

    GET   /commerce/purchase-documents/:id/receipts
    POST  /commerce/purchase-documents/:id/receipts
    POST  /commerce/purchase-documents/:id/receipts/:receiptLineId/compensate

The compensation route exists because §2's correction mechanism must be
reachable and §3-E's vocabulary names its failures; it creates a NEW receipt
event. There is NO `PATCH`, `PUT` or `DELETE` for receipt rows, ever.

### R8 — Permissions

GET → `commerce.read`. POST → `commerce.manage`. Compensation →
`commerce.manage`. No new permission, no receiving-specific Core permission.

### R9 — Receiving projection

`NOT_RECEIVED` / `PARTIALLY_RECEIVED` / `FULLY_RECEIVED`, derived from the
append-only receipt history against the ordered quantity (rules in §3-B).

### R10 — Warehouse / WMS / ASN / dock semantics OUT OF SCOPE

No Warehouse module, database, client, bin/location model or inventory
ledger. The receipt event records ACTUAL RECEIVED QUANTITY only. Future
integration requires an explicit contract/port.

============================================================ 3. SETTLED SEMANTICS — THE UNDERSPECIFIED BEHAVIOURS, SETTLED HERE ONCE
============================================================

### A. Append-only is enforced in the APPLICATION LAYER, structurally

`receiving-history.repository.ts` exposes exactly: `append`,
`listByDocument`, `listLines`, `findReceiptLineForCompensation`,
`lockDocumentForReceipt`, `readReceiptHistory`. It contains NOT ONE
`.update(` / `.updateMany(` / `.delete(` / `.deleteMany(` / `.upsert(` —
executable as a source-scan guard, the `payment-history.repository.ts`
precedent. `commerce_db` has no trigger precedent and R does not add the
first one; the schema carries no `updated_at` on `Receipt` or `ReceiptLine`
(a column that only ever changes once is a lie about mutation). The only
correction mechanism — a compensating event — arrives through the SAME
`append`, so no caller has any statement that could rewrite a settled row.
Database-level immutability (triggers) is NOT required by this contract and
is NOT added; the lock in §3-H protects the INVARIANT, not row history.

### B. The projection, defined exactly

Pure module `receiving-status.ts`, no dependencies (the
`payment-status.ts` / `purchase-status.ts` precedent). Inputs: the line's
ordered quantity and Σ of ALL receipt-line quantities for that line
(compensating lines are negative and therefore subtract).

    received <= 0                 → NOT_RECEIVED
    0 < received < ordered        → PARTIALLY_RECEIVED
    received == ordered           → FULLY_RECEIVED
    received > ordered            → throws RangeError

`OVER_RECEIVED` is deliberately NOT a member: R1/R2 make it impossible in
valid persisted history, so the projection REFUSES to project an impossible
state instead of inventing a vocabulary for it. `received <= 0` answers
NOT_RECEIVED (a fully compensated line has received nothing again), never a
negative status. Equality is exact integer equality on the scaled decimal —
`26.2500` against `26.25` is FULLY_RECEIVED, never a hair away from it.

### C. Quantity — one precision model, borrowed from PurchaseLine

Storage: `Decimal(18,4)`, exact scaled-bigint arithmetic through
`purchase-money.ts` (`moneyFromNumber`, `sumMoney`, `addMoney`,
`compareMoney`, `negateMoney`) — no floats, no silent rounding, no second
precision model. On the WIRE a quantity is the exact decimal STRING in
every response (§6), and in a REQUEST it is validated exactly like a
PurchaseLine quantity: `@IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE
})`, positive (`>= 0.0001`), at most `PURCHASE_MAX_MONEY_AMOUNT`. A normal
receipt quantity is strictly POSITIVE; a negative quantity exists ONLY as
the server-derived value of a compensating line and is never accepted from
a client.

### D. The compensating event, field by field

`POST …/:receiptLineId/compensate` appends ONE new `Receipt` holding ONE new
`ReceiptLine`:

    purchaseLineId        = the target line's purchase line (server-derived)
    quantity              = EXACT NEGATION of the client-stated positive
                            quantity (server-derived sign, client states
                            only the magnitude — never `reversesReceiptLineId`)
    reversesReceiptLineId = the path's receipt line id (server-derived)

The target must satisfy ALL of: exists; same tenant; same document; is an
ORIGINAL receipt line (its own `reversesReceiptLineId` is NULL — corrections
do not chain, the minimum safe direct-reference rule §6 asks for when
chain rules are undefined); it is never the new row itself (structurally
impossible: the link is server-set from the path).

CAP: let `available = target.quantity + Σ(quantity of existing receipt lines
whose reversesReceiptLineId = target.id)` (signed sum — prior compensations
are negative). The client-stated magnitude must satisfy
`magnitude <= available`; anything greater is `invalid_compensation` (409).
This admits PARTIAL compensation (the +50 / −10 → 40 example) and makes
full remaining compensation the boundary. Because every compensation
targets a line of the same purchase line and never exceeds its target,
Σ compensations can never exceed Σ receipts on a line — net received can
never go negative, and the original row is never read for modification.

### E. Failure vocabulary — named refusals, never silent

Closed list; each is a distinct, testable answer:

    purchase not found        → 404 `Purchase document not found`
                                (unknown id AND cross-tenant id —
                                indistinguishable by design, no probe)
    line not found            → 404 `Purchase line not found`
                                (a line id not owned by THIS document)
    original receipt not found→ 404 `Receipt line not found`
                                (covers cross-document compensation: the
                                lookup is scoped by document AND tenant)
    invalid quantity          → 400 at the DTO boundary (non-positive,
                                fifth decimal, over column max, non-numeric,
                                unknown field such as `tenantId` or
                                `reversesReceiptLineId`)
    over-receipt              → 409 ConflictException naming ordered,
                                received and requested quantities
    invalid compensation      → 409 (magnitude beyond `available`, or the
                                target is itself a compensating line)
    tenant mismatch           → 404, identical to "not found"
    self-compensation         → structurally impossible (server-set link);
                                a payload carrying `reversesReceiptLineId`
                                is a 400

No other public error code is invented; if a case arises that this list
lacks, it is an amendment to this file BEFORE it is implemented.

### F. Tenancy

Every repository method takes `tenantId` FIRST and every `where` names it
(the module-wide gate reads this too). Every write path proves, inside ONE
unit of work: the document exists IN THIS TENANT (row lock, §3-H), every
receipt line's purchase line belongs to THIS document (and therefore this
tenant), and the compensation target is scoped by document AND tenant. A
cross-tenant id stays indistinguishable from an absent one — 404, never
403, never an existence leak.

### G. Audit (§I8)

`CommerceAuditGateway`, resource `COMMERCE_AUDIT_RESOURCE.RECEIPT`
(`commerce.receipt`, reserved by step G for exactly this row). Actions,
the smallest closed vocabulary the contract needs: `append`, `compensate`.
One audit row per SUCCESSFUL write; a refused or rolled-back write audits
nothing. Repositories audit nothing (guard-proven). The audit is recorded
AFTER the unit of work commits — the platform audit port writes to
`core_db` and is not part of `commerce_db`'s transaction, so recording
inside would persist a "success" trail row for an act that then rolled
back; this follows the N contract §8.2/§8.3 precedent that keeps audit
outside the unit of work, and refines §21's step ordering accordingly.
The actor and tenant come from the resolved Commerce actor, never a
payload.

### H. Concurrency — the over-receipt race, answered by the database

Two concurrent `+10` appends against ordered = 100 / received = 90 must not
produce 110. Strategy (database-native, no invented distributed lock, per
§22): every write path FIRST takes a PostgreSQL row lock inside the unit of
work —

    SELECT "id" FROM "PurchaseDocument"
    WHERE "tenant_id" = $tenant AND "id" = $document
    FOR UPDATE

— and only then reads the document's lines and receipt history and
evaluates the invariant. All receiving writes on one document serialize on
that lock; under READ COMMITTED the second transaction re-reads the first's
committed rows and its over-receipt check sees 100, so it is refused.
Compensation takes the SAME lock before computing `available`, so two
concurrent compensations cannot both pass the cap read. The lock is
released on commit or rollback. The raw SQL lives in the repository
(names the `tenant_id` column, as the module's raw-SQL gate requires).
A true concurrent-connection test requires a live database harness the
jest suite does not have; the falsifiable stand-ins are (1) the source
guard pinning the `FOR UPDATE` statement and (2) service tests proving the
lock is taken BEFORE any history read.

### I. No lifecycle gating — independence in both directions

Mirroring Q6: no receiving write reads or writes `PurchaseDocument.status`,
a `WorkflowInstance`, a commercial row or a `PaymentRecord`, and no
receiving read requires any of them. `RECEIVED + UNPAID`,
`PAID + NOT_RECEIVED`, `workflow APPROVED + PARTIALLY_RECEIVED`,
`commercial approved + partial receiving` are all valid, coexisting states.
No document status restricts who may receive (no vocabulary in any C1
contract says a DRAFT may not be received against — inventing such a gate
would be a silent default).

### J. Fields considered and deliberately NOT created

- `externalReference` / `conditionNotes` on `Receipt`: the conceptual list
  marks them optional "only if contract explicitly supports them" — no
  section does. Not created; adding them later is an additive migration
  plus DTO fields, never a speculative column.
- Receipt numbering / counter: refused by R3.
- Tolerance columns, exception approvals, `OVER_RECEIVED` status, mutable
  receiving status on any table: refused by R2/R5/§3-B.
- Warehouse/ASN/dock/bin/inventory structures: refused by R10.

============================================================ 4. RELATION TO Q, P, N/O, S AND THE WAREHOUSE BOUNDARY
============================================================

- **Q (payment)** stays independent. R never reads or writes
  `PaymentRecord`, never infers payment from receiving or receiving from
  payment. Q's projection never reads receiving (unchanged).
- **P (commercial)** stays independent. R never touches
  `CommercialAssignment` / `CommercialApproval` / `CommercialGroup` and
  never resolves a liaison.
- **N/O (workflow)** stay independent. R never mutates
  `WorkflowInstance` / `WorkflowStepInstance`, never starts a workflow,
  never derives receiving from workflow state. Reaching R therefore needs
  NO Rule Engine import: over-receipt is a deterministic domain invariant,
  not a configurable rule — `PureRuleEngineModule` is NOT added to this
  slice.
- **S (returns)** will later reference receipt / receipt-line ids as
  OPAQUE references. R therefore guarantees id stability (append-only) and
  writes NO return record, NO return state, and never rewrites history
  because a return occurred. Return logic belongs to S.
- **Warehouse** gets nothing from R beyond the receipt event itself;
  integration later is an explicit contract/port over these ids.

============================================================ 5. SCHEMA GAP SET — THE MINIMUM MODELS
============================================================

Two models, added by ONE additive migration (`20260929000003_receiving_
foundation`) — no existing table is rewritten, no historical migration is
edited, no cross-DB relation, every foreign key `ON DELETE RESTRICT`, every
index and FK tenant-leading:

    model Receipt {           -- one receiving operation
      id                   UUID  (system-generated, R3)
      tenantId             TEXT  (first column, first index column)
      purchaseDocumentId   UUID  (composite FK with tenant → PurchaseDocument)
      receivedAt           timestamptz  (default now; caller's instant if stated)
      receiverId           TEXT? (actor's userId as OPAQUE metadata, §16)
      createdAt            timestamptz  (row's own clock; NO updatedAt)
      lines                ReceiptLine[]
    }
    @@unique([tenantId, id])
    @@index([tenantId, purchaseDocumentId, createdAt])

    model ReceiptLine {      -- actual received quantity for one PurchaseLine
      id                   UUID
      tenantId             TEXT
      receiptId            UUID  (composite FK with tenant → Receipt)
      purchaseLineId       UUID  (composite FK with tenant → PurchaseLine)
      quantity             Decimal(18,4)  -- positive, or NEGATIVE on a
                                           -- compensating line (§D)
      reversesReceiptLineId UUID? (composite self-FK with tenant; NULL on an
                                   original line — no uniqueness: partial
                                   compensations may repeat)
      createdAt            timestamptz   (NO updatedAt)
    }
    @@unique([tenantId, id])
    @@index([tenantId, receiptId])
    @@index([tenantId, purchaseLineId])
    @@index([tenantId, reversesReceiptLineId])

`PurchaseDocument` and `PurchaseLine` gain only their virtual back-
relations (`receipts`, `receiptLines`) — no column, no status, nothing
stateful. There is NO receiving status enum, NO document-level received
column, NO counter table.

============================================================ 6. API SURFACE — NOTHING BEYOND THIS
============================================================

    GET   /commerce/purchase-documents/:id/receipts        commerce.read
    POST  /commerce/purchase-documents/:id/receipts        commerce.manage
    POST  /commerce/purchase-documents/:id/receipts/:receiptLineId/compensate
                                                           commerce.manage

Controller `receiving-history.controller.ts` mirrors
`payment-history.controller.ts` exactly: same base path, same decorator
order (`@RequiresModule` → `@RequiresFeature(PURCHASE)` →
`@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)` LAST),
`ParseUUIDPipe` on both path ids (400 at the edge, 404 from the service),
`resolveCommerceActor(req)` as the ONLY identity source — no `tenantId`,
`actorId` or `receiverId` is ever read from a payload.

GET response — history OLDEST FIRST (ordered `receivedAt`, `createdAt`,
`id`; lines `createdAt`, `id` — deterministic, never implicit DB order)
beside the per-line projection, whole-history, UNPAGED deliberately (this
is one document's history, not a tenant-wide list; Q9's paging applies to
Q's paginated route, and inventing a page envelope here would add an
unagreed contract surface):

    {
      receipts: [{ id, receivedAt, receiverId, createdAt,
                   lines: [{ id, purchaseLineId, quantity, reversesReceiptLineId,
                             createdAt }] }],
      lines:    [{ purchaseLineId, orderedQuantity, receivedQuantity,
                   receivingStatus }]
    }

All quantities are EXACT decimal strings. No `tenantId`, no
`purchaseDocumentId` (the route names it) on any row.

POST `…/receipts` body:

    { receivedAt?: ISO-instant, lines: [{ purchaseLineId: UUID,
                                          quantity: number }] }

POST `…/receipts/:receiptLineId/compensate` body:

    { quantity: number (positive magnitude), receivedAt?: ISO-instant,
      reason?: string (≤500 — the AUDIT event's reason, not a column) }

No `PATCH`, no `PUT`, no `DELETE`, no receipt list outside a document, no
raw JSON, no arbitrary status field. Unrecognised fields are 400 under the
global pipe's `whitelist` + `forbidNonWhitelisted`.

============================================================ 7. TESTS, GUARDS, MIGRATION, BOUNDARIES
============================================================

Tests (falsifiable, with planted-defect fixtures in the scans): projection
rules exhaustively + schema TEXT join (no status enum/column, no
`updatedAt`); DTO boundary (quantity domain, UUID, refusal of `tenantId`,
`receiverId`, `reversesReceiptLineId`, `status`); service behaviour with
faked repository/audit/unit-of-work (tenant-first arguments, 404s before
any write, exact-boundary over-receipt, one-unit-over refusal with NO
append and NO audit, multi-line atomic refusal, compensation cap, no-chain
rule, ONE audit row per write and none for refusals, view leaks neither
`tenantId` nor `purchaseDocumentId`); source-scan guards over the
`receiving/` slice: repository surface pinned BY NAME, no update/delete/
upsert anywhere, the `FOR UPDATE` lock present and taken before history
reads, no `unwrapCommerceTransaction`/`Prisma.TransactionClient` outside
the repository, no Rule Engine, no notification, no identity gateway, no
Core/HR/Finance/WMS client import, no read of payment/workflow/commercial
tables, migration ADDITIVE with tenant-leading indexes and composite
tenant FKs; controller wiring (roles, guards, no PATCH/PUT/DELETE).

Migrations: NEW directory, ADD-ONLY SQL inspected by hand (no DROP /
TRUNCATE / DELETE, no other owner's names, no cross-DB reference), then
`prisma validate`, `prisma generate`, `migrate status`, apply via
`npm run db:migrate:commerce`. Historical migrations are never edited.

Boundaries: `commerce.receipt` audit resource (reserved in step G); no new
Core permission (existing six `commerce.*` names unchanged); no
`PureRuleEngineModule` import; no notification/websocket/queue/worker;
`CommerceUnitOfWork` + `CommerceTransactionHandle` as the ONLY transaction
mechanism; repositories never audit; `workflow-configuration.repository.
spec.ts`'s REPOSITORY_NAMES gains exactly the eighth name,
`receiving/receiving-history.repository.ts`.

STOP conditions: any genuine contradiction between this contract and
repository evidence; any inability to guarantee §3-H's lock (schema/
harness gap); any required behaviour absent from §3-E's vocabulary (amend
HERE first, never in code).

FINAL PRINCIPLE: receiving history + receiving projection. NOT warehouse,
NOT inventory, NOT finance, NOT payment, NOT return, NOT frontend.
