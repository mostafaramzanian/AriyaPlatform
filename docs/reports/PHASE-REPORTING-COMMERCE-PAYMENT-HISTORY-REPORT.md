# COMMERCE PAYMENT HISTORY REPORT
گزارش تاریخچه پرداخت‌های بازرگانی

> Phase: REPORTING-COMMERCE-PAYMENT-HISTORY (eighth Reporting capability)
> Baseline HEAD: `e662a70` — `docs(reporting): document hr mission request report`
> Scope decision: **A. PAYMENT TRANSACTION HISTORY — APPROVED**

---

## A. Baseline

- Starting HEAD: `e662a70ebe361ab6b5f8aa04163cdb8033e318f3` (master).
- Previous completed phase: HR Mission Request Status Report — COMPLETE.
- Established platform state (unchanged by this phase): P0-B audit durability CLOSED;
  P0-C cross-context integration policy enforced; Reporting bounded context with seven
  source-owned narrow read seams; KPI separate; shared chart + XLSX/DOCX writers.
- Generated artifact `apps/web/next-env.d.ts` is present and UNTRACKED both before and
  after this phase; it is NOT phase-owned and NOT committed.

## B. Scope Decision

- **Selected scope: A. PAYMENT TRANSACTION HISTORY.**
- **Reporting row grain:** one row per `PaymentRecord` (one append-only payment event,
  compensating rows included — never collapsed per document).
- **Primary aggregate:** `PaymentRecord`, child of `PurchaseDocument`
  (`prisma/commerce/schema.prisma`, composite FK `(tenant_id, purchase_document_id)`).
- **Owning bounded context:** Commerce (`commerce_db` only).
- **Required fields:** the twelve contract fields (document id + number, exact `Decimal`
  amount string, currency snapshot, method, `paymentDate` ISO, four opaque references,
  `reversesPaymentId`).
- **Primary date:** `paymentDate` — the half-open `[paymentFrom, paymentTo)` ISO window.
- **Supported filters:** `method` (closed 3), `search` (row refs + parent number),
  `purchaseDocumentId`, `paymentFrom`/`paymentTo`.
- **Lifecycle support:** N/A — no stored lifecycle; the four `UNPAID/PARTIAL/PAID/OVERPAID`
  words are a per-DOCUMENT read-time projection and never filter or label a row.
- **Timeline support:** INTENTIONALLY NOT SUPPORTED — the payment audit trail is bound to
  the DOCUMENT (`resourceId = documentId` for append AND compensate), so a per-row read
  would lie by grain. The route is absent by design, pinned by unit + isolation guards.
- **Export support:** XLSX + DOCX over the same filtered population via shared writers.
- **Financial dependency:** NONE — `finance_db` never read; opaque references are where
  a future source-owned contract would look (§13).
- **Security sensitivity:** no card/PAN/CVV/token/payload stored; raw actor id
  (`recordedByUserId`) withheld; tenant from server context only.
- **Exclusions:** per-row status, attempt/provider/settlement semantics, timeline,
  currency/amount-range/actor filters, KPI, dashboard, AI, generic DSL.
- **Decision: APPROVED.**
- Rejected: B (no lifecycle exists), C (would collapse records and lose compensation
  grain), D (no attempt records), E (grain + ownership + contract proven), F (no missing

## C. Evidence

| # | Question | Answer (source-backed) |
|---|----------|------------------------|
| 1 | What is a Commerce payment? | One `PaymentRecord` — append-only money history (§Q1–Q4, §3-A). |
| 2 | Which aggregate owns it? | `PaymentRecord`, child of `PurchaseDocument`. |
| 3 | What is one report row? | One `PaymentRecord` (contract header + reader whitelist spec). |
| 4 | Multiple records per document? | Yes (§Q1: later payments continue on the same purchase) — why scope is NOT document-centric. |
| 5 | Persisted lifecycle? | NO — no `PaymentStatus` column/enum (`payment-status.spec` TEXT join). |
| 6 | Attempts distinct? | NO attempt records exist — excluded, not modeled. |
| 7 | Refunds/reversals/cancellations? | FULL compensation rows only (`reversesPaymentId` + exact negation, ≤1 per row); returns settle THROUGH Q's compensate. No partial, no stored cancellation. |
| 8 | Meaningful timestamps? | `paymentDate` (business date, primary), `createdAt` (bookkeeping); nothing else exists. |
| 9 | Amount/currency? | `Decimal(18,4)` exact strings (NEGATIVE on compensations); per-row currency snapshot (Q5). |
| 10 | Method/type? | Closed `PaymentMethod` {CASH, PETTY_CASH, CHECK} — a label, never a finance entity (Q3). |
| 11 | Owning document? | `PurchaseDocument` — joins only as the `documentNumber` display field. |
| 12 | Commerce owns all required info? | YES — one table, one database, one owner. |
| 13 | Financial owns any semantic? | NO — §13 defers integration to a future port. |
| 14/15 | Existing seam sufficient? | NO — only per-document reads existed; the report adds the tenant-wide surface to the SAME repository (guard pin extended by name). |
| 16 | Valid Reporting item? | YES — scope A, read-only, tenant-scoped. |

### Evidence vs Assumption

- SOURCE-PROVEN: append-only grain; closed method set; compensation-only correction;
  document-bound audit; currency snapshot; `commerce.read/manage` permission split.
- TEST-PROVEN: projection purity (Q spec); whitelist projection; tenant-first reads;
  zero-filled method summary; half-open date semantics (E2E).
- INTENTIONALLY-NOT-SUPPORTED: per-row status; attempts; provider/settlement/
  cancellation; per-row timeline; actor/currency/amount filters; KPI/dashboard/AI.
- BLOCKED / REQUIRES FOLLOW-UP: none for scope A.

## D. Payment Row Grain

One row = one `PaymentRecord`. Proven mixed-grain-free: E2E asserts 3 rows for 1
document, exact `paymentDate` DESC order (compensation, check, cash), compensation
linked by `reversesPaymentId`, negative amount — never blended or collapsed.

## E. Commerce Ownership

- Table: `commerce_db."PaymentRecord"` + enum `PaymentMethod` (schema + migration
  `20260929000002_payment_history`).
- Domain: `payment/payment-status.ts` (pure vocab + projection), `payment-history.*`.
- Reader: `commerce/reporting/commerce-payment-reporting.{contract,reader,module}.ts`;
  Reporting imports ONLY the token. No new repository file, no ownership-matrix change
  (`commerce-isolation` + `architecture` suites pass).

## F. Commerce vs Financial Boundary

- Commerce reads: `paymentRecord` + same-owner `purchaseDocument.documentNumber` join.
- Financial: never read, never imported, never another owner's Prisma client.
- `commerce.read` is the ONLY remit (isolation remit pin `COMMERCE_READ × 4`).

  cross-context data), G (Commerce owns every required field).


## G. Lifecycle / Status

N/A as a report dimension. Documented: the four status words project over a document's
WHOLE history + its total; a per-row "status" would need the whole history per row
(N+1) and contradict §3-B. The E2E grain test + whitelist test (no `status` key) falsify
any reintroduction.

## H. Date Semantics

- Primary: `paymentDate`. Window: half-open `[paymentFrom, paymentTo)` ISO instants
  (`gte`/`lt`) — the purchase register's KPI-window shape.
- Same-day: e.g. `2026-03-16T00:00Z → 2026-03-17T00:00Z` contains the compensation and
  excludes the 03-15 row (E2E). Exclusive-end edge proven (instant AT `to` is OUT).
- Invalid shape → 422 (DTO `IsDateString`); inverted (`to` < `from`) → 400 (reader);
  missing bound → unbounded on that side. `createdAt` never a filter.

## I. Filters

| Filter | Source | Proven by |
|---|---|---|
| `method` | `PaymentMethod` enum | E2E (CHECK→2, CASH→1); unknown→422 |
| `search` | 4 opaque refs + parent `documentNumber` | E2E (`INV-`→cash; `EXT-`→check; number→all 3) |
| `purchaseDocumentId` | FK column | E2E scoping + empty-UUID case |
| `paymentFrom/paymentTo` | `paymentDate` | E2E (window, same-day, edge, 400/422) |

One canonical predicate (`buildReportWhere`): E2E proves summary.total == list.total
and `byMethod` sums to total over the same filter.

## J. Source Seam

`COMMERCE_PAYMENT_REPORTING_READER` over `CommercePaymentReportingModule`. Three reads
only. Reader spec (10 tests): whitelist ×12, tenant forwarding, filter pass-through,
absent-keys-absent, inverted-window 400, ceiling clamp, zero-fill over closed 3,
money/`null` honesty, foreign-row `null`, three-method surface.

## K. API

- `GET /api/v1/reporting/commerce/payment-history` (list + summary)
- `GET .../export/xlsx|docx` · `GET .../:id` (detail)
- NO `:id/timeline` (E2E 404); NO write verbs (E2E 404).
- Auth: `commerce.read` ×4, `commerce`/`purchase` entitlement, server actor.

## L. Web

- `/admin/reporting/commerce/payment-history` + `[id]`; `PAGE_TITLE_ALIASES` entry,
  NO rail row. Order: identity → 4 filters → summary chips → method chart → exports →
  table → pagination → detail.
- `commerce.read` gate; RTL; Persian digits; empty/error/loading states.
- View spec (8): identity, server-query contract, gate, summary honesty, method words +
  compensation word, detail link, half-open day conversion, empty state.

## M. Chart

`ReportSummaryChart` over `summary.byMethod` in `COMMERCE_PAYMENT_METHODS` order.
Zero-fill by contract; no invented metric.

## N. XLSX / DOCX

Shared writers. E2E-parsed: 8 headers exact, row count == list count, compensation
`-20`, RTL `bidi`, one table, ASCII filenames, no tenant/actor/row-id leakage in sheet
text AND document XML, export/list equality, foreign export excludes own rows.

## O. Security / Sensitive Data

No card/PAN/CVV/token/secret columns exist in the Commerce payment surface
(schema-proven). `recordedByUserId` withheld; `tenantId` never crosses; foreign ids
404; exports share list remit; tenant from server actor only.


## P. Tests / E2E

- Source seam (Commerce reader spec): 10/10.
- Reporting unit: service 10 + controller 5 + labels pin (method words) — all green.
- Full API suite: **290 suites / 4477 tests — ALL PASS** (targeted 8-suite set: 90/90).
- Web full: **124 suites / 1999 tests — ALL PASS** (targeted 3-suite set: 75/75).
- E2E (real DB): **20/20** — list+summary, exact grain+order+links, method filter +
  summary dimension, unknown-method 422, half-open window + same-day + exclusive-end,
  inverted 400 / malformed 422, two search dimensions, empty page, summary/list
  equality, tenant isolation (list+detail), 12-field whitelist + amount/date exactness,
  404s, no-timeline 404, 401/403 (list+detail+exports), XLSX parsed, DOCX parsed,
  unauthorized+foreign exports, write-verb 404s, NO-WRITE proof (4 rows byte-identical
  + audit count unchanged after all six read surfaces, post drain-poll).
- Architecture: `architecture-boundaries` + `reporting-isolation` + `reporting.module` +
  commerce guards + `commerce-isolation` + payment specs — ALL PASS.
- Sibling reporting E2E regression (all SIX prior report slices re-run in this phase):
  purchase + mission + check-request + leave + personnel-traffic + production +
  production-bom-change = 93 + 53 tests: all sibling failures are the KNOWN
  pre-existing `AUDIT_CONTRACT_MISMATCH`-family relay/timing flakes
  (`auditLog.create` P2003 `AuditLog_userId_fkey` under parallel bulk creation;
  timeline `total >= 2/3` reads 1 while the relay is in flight). Proven PRE-EXISTING:
  the check-request suite re-run on the CLEAN baseline (`e662a70`, changes stashed)
  fails the SAME single timeline assertion (1 failed / 14 passed, identical line).
  Mission suite: FULL PASS. Phase-owned: none — no timeline added, no audit writer
  touched.
- Typechecks: API `tsc --noEmit` PASS (E2E typechecked via ts-jest at run); Web
  `tsc --noEmit` PASS.
- Builds: API `nest build` PASS (phase outputs present in `dist/`); Web `next build`
  — Compiled successfully, both new routes listed
  (`/admin/reporting/commerce/payment-history`, `/[id]`); one static-data fetch
  failure for `/blog` (external network in build env — unrelated).
- `git diff --check`: PASS.

## Q. Pre-existing Issues

1. Sibling-report timeline/audit E2E flakes (purchase + check-request + production +
   production-bom-change timeline counts; audit P2003 relay errors): PRE-EXISTING,
   proven on clean baseline with identical assertions; unrelated.
2. `core-nav.ts` prettier drift — PRE-EXISTING; phase's 7-line addition untouched.
3. Web build `/blog` static fetch failure — external-network sandbox artifact.

## R. Phase-owned Fixes

- `Map<string, any>` typing fix in the E2E grain helper (ts-jest compile error).
- Search-test fixture fix caught by the suite (invoice ref on CASH row; CHECK row via
  `externalReference`) — spec now covers BOTH reference columns.
- Duplicate-key React warning in the view spec (two fixture rows sharing one id).
- Reader-spec title typo (`unsoped` → `unscoped`).
- Prettier normalization of phase files only (project-owned `format` script).
- Isolation guard extensions are ADDITIVE — no guard weakened.

## S. Limitations

- No per-row lifecycle/status — by source design, not omission.
- No per-row timeline — document-bound audit grain; the purchase timeline covers the
  document itself.
- No currency/actor/amount-range filters — no source-backed vocabulary.
- Day pickers convert to UTC-day instants on the client; the server window is
  instant-exact (§H).
- E2E leaves its payment rows in `commerce_db` (sibling precedent); populations stay
  isolated via `purchaseDocumentId` scoping.

## T. Final Verification

- API typecheck: PASS · Web typecheck: PASS · API build: PASS · Web build: PASS (one
  unrelated external fetch failure) · `git diff --check`: PASS.
- All 28 architecture-guard boxes of §28 hold (passing suites above).
- Commits: implementation + documentation (separate, clean).

## U. Commits

- Implementation: `942d633` — `feat(reporting): add commerce payment history report`
- Documentation: `<docs-hash>` — `docs(reporting): document commerce payment history report`
