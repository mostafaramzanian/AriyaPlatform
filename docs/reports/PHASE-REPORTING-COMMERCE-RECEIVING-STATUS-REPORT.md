# Commerce Receiving Status Report — «گزارش وضعیت دریافت‌های بازرگانی»

> **Phase type:** IMPLEMENTATION — the tenth operational Reporting capability, approved by the Portfolio Evidence Review (`9726f7e`) at classification `READY_WITH_SCOPE_DECISION` with exactly ONE open gate: the row grain.
> **Baseline:** `HEAD = 9726f7e63e4d9fe18dad72cc8025d06b47c8586a` · Branch `master` · Working tree clean at phase start except the pre-existing untracked generated file `apps/web/next-env.d.ts`.
> **Implementation commit:** `feat(reporting): add commerce receiving status report`
> **Documentation commit:** `docs(reporting): document commerce receiving status report`

## A. Baseline

Recorded at phase start (`git log -1`, `git status --short`):

```text
HEAD:      9726f7e63e4d9fe18dad72cc8025d06b47c8586a — docs(reporting): complete reporting portfolio evidence review
Branch:    master
Tree:      clean (only `?? apps/web/next-env.d.ts` — generated, pre-existing, never staged)
```

Regression baselines captured BEFORE coding (all green):
- Commerce suite: 50 suites / 762 tests
- Reporting suite: 23 suites / 185 tests (23→ post-phase with the new specs)
- Full API suite and full web suite: evidence-review numbers (`4504/4504`, `2007/2008` with the proven survey flake); re-run after implementation (sections S/V).

## B. Scope Decision

**Selected scope: A — PER-PURCHASE-LINE RECEIVING REGISTER.** Decision: **APPROVED.**

**Row grain: ONE ROW = ONE `PurchaseLine` (per-line register row)** — the row's
identity is the purchase line itself; each row answers «which purchase line of
which document, in what projected receiving state, ordered how much, received
how much, when was the line's latest receiving event, and how many of its
events are compensations».

**Primary aggregate:** `PurchaseLine` against the whole append-only `Receipt` /
`ReceiptLine` history of that line (Σ received), inside the tenant.

Why A, stated from the source — no reliance on the prior document:
- `receiving/receiving-status.ts` projects `projectReceivingStatus(ordered, received)` per LINE, where `received` is Σ of the line's receipt lines (whole history, never filtered), via `compareMoney` over exact `Decimal(18,4)` strings.
- The Commerce read route answers the SAME per-line set (`perLine` projection beside `receiptView`, every line present — including one with no events at all, rule 1: nothing received → `NOT_RECEIVED`).
- Compensating lines are NEGATIVE by construction (`compensate()` derives the sign from the path's target), so Σ already nets them; no receipt state is rewritten or erased.
- No document-level status exists ANYWHERE: not on `Receipt`, not on `ReceiptLine`, not on `PurchaseLine`, not on `PurchaseDocument` — asserted by `receiving-status.spec.ts` (R5). A per-DOCUMENT report row would invent it.
- Option B (document roll-up) is INTENTIONALLY-NOT-SUPPORTED: it would require Commerce to publish a roll-up semantic this phase must not invent.

`docs/reports/PHASE-REPORTING-PORTFOLIO-EVIDENCE-REVIEW.md` classified this item `#10 READY_WITH_SCOPE_DECISION`; this section records the now-taken decision. Nothing in option B was built.

## C. Source Evidence

Re-verified from the source code (the source remains authoritative over the prior document):

| Symbol | File | Proven fact |
|---|---|---|
| `Receipt` | `prisma/commerce/schema.prisma` | header event: `tenantId` first, `purchaseDocumentId` (composite FK), `receivedAt` (caller-stated instant, default now — the BUSINESS date), `receiverId` opaque, NO `updatedAt` (append-only) |
| `ReceiptLine` | same | one actual received quantity for ONE purchase line: `quantity Decimal(18,4)`, POSITIVE ordinary / NEGATIVE only server-derived compensation, `reversesReceiptLineId` NULL on originals (no uniqueness — partial compensations may repeat), NO `updatedAt` |
| `projectReceivingStatus` | `receiving/receiving-status.ts` | pure, closed 3-member vocabulary in spec order, four rules (§D of the prior doc); inputs = ordered string + Σ receipt lines; `received > ordered` THROWS (RangeError, not a fourth state) |
| `RECEIVING_STATUSES` | same | `['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']` — also mirrored verbatim in the web's `commerce-api.ts` |
| Receiving routes | `receiving-history.controller.ts` | THREE only: `GET :id/receipts` (`commerce.read`), two POSTs (`commerce.manage`); NO receiving-specific permission |
| Per-line projection | `receiving-history.service.ts` `list()` | every line answered (incl. no events) via Σ over the WHOLE document history; compensating lines net by construction |
| Receiving repository | `receiving-history.repository.ts` | append-only reads + reads; `listByDocument` deterministic; `tenantId` first everywhere; ONE `$queryRaw` (the `FOR UPDATE` lock — untouched) |
| Receiving guards | `receiving.guards.spec.ts` | append-only ban, raw-count pin, foreign-name ban (`purchaseLine`/`purchaseDocument` NOT foreign — pre-existing own relations), route pin |
| Receiving audit | same service | `RECEIPT: 'commerce.receipt'`, `resourceId: receipt.id` for BOTH append and compensate — per-RECEIPT-EVENT grain (grounds the no-timeline ruling) |
| Persian words/tones | `commerce-labels.ts` | `RECEIVING_STATUS_LABELS` + `commerceReceivingStatusTone` (FULLY→ok, PARTIAL→info, else muted); `decimalDisplayLabel` for exact Decimal strings |
| Report precedents | `payment-*` / `return-*` | per-row timeline allowed ONLY when the audit resource names the row grain (return: yes; payment: no — receiving follows payment's ruling) |

**"What does one report row represent?"** — A source-proven receiving-LINE record: one `PurchaseLine` with Σ over its whole receipt history. Not a receipt operation, not a document aggregate.

## D. Row Grain

HARD LOCK (scope gate A, decided in §B):

- **One row = ONE `PurchaseLine`.** The row's `id` IS the purchase line's id; the detail route reads `GET …/:id` with the line id.
- **Multiple receipt lines DO refer to the same purchase line** (one receipt carries many lines; one receipt event appends per touched line; corrections repeat via compensation) — that is exactly why the grain is the LINE and not the event: events are many-per-line.
- **Appends cannot collapse:** the repository aggregates (`Σ`, latest instant, compensation count) but never drops sibling rows; the reader projects one contract row per line.
- **No document roll-up:** no document-level column, predicate, summary key, label, chart bucket or export cell carries a document status — the summary counts LINE rows per LINE status.
- **Proven in E2E:** three lines → three rows; two events + one compensation on one document ≠ two rows (see §R).

## E. Receiving Status Projection

The exact three-member vocabulary from `receiving-status.ts` (`RECEIVING_STATUSES`), in deterministic order for the chart/summary — consumed BY VALUE, never re-typed:

| State | Backend value | Meaning | Source production | Persian label | Web tone |
|---|---|---|---|---|---|
| 1 | `NOT_RECEIVED` | nothing received (no events, or arrivals fully offset) | Σ ≤ 0 → `projectReceivingStatus` | دریافت‌نشده | muted |
| 2 | `PARTIALLY_RECEIVED` | some, not all | 0 < Σ < ordered | دریافت جزئی | info |
| 3 | `FULLY_RECEIVED` | all of it | Σ == ordered (exact BigInt equality) | دریافت کامل | ok |

- **Persisted or projected?** PROJECTED at read time — no status column exists anywhere (R5); the web renders `StatusBadge` from the contract row's `receivingStatus` field.
- **Terminal/non-terminal:** receiving status is a position, not a phase — later events move the line (`compensate()` keeps the line live; even a fully-received line can be netted back down). §30's "terminal" stall condition does not apply (no document-level roll-up exists to freeze).
- **Deterministic order:** `RECEIVING_STATUSES` order everywhere (summary zero-fill, chart buckets, select options) — `byStatus` always carries all three keys.
- **Impossible state:** `received > ordered` throws RangeError inside the domain pure module and would surface as 500 — exactly as Commerce's own screen behaves; no fourth status invents it quiet.

## F. Compensating Rows

Proven from the service/DTO/schema (contract §3-C/§3-D, §16):
- **Stored:** a NEW `Receipt` + `ReceiptLine` row whose `quantity` is the server-derived NEGATION of the stated magnitude; `reversesReceiptLineId` names the target; the original row is never touched (R4 — no update path exists in the repository).
- **Relation:** child-to-target via the path-named link; a compensating line cannot itself be compensated (409); partial compensations may repeat (no uniqueness on the link — the cap is enforced in the locked unit of work, not in a constraint).
- **Visible as rows?** The compensating EVENT rows are part of the line's Σ and are counted in `compensationCount` (a count of rows that exist), but report rows stay per-line: corrections never appear as their own report rows and never pair off visibly — the row shows the net Σ and the count.
- **Quantity/sign:** the server derives the sign; a client may never state a negative receiving (DTO `@Min(0.0001)`); the Σ may therefore be negative only through fully-offset compentations.
- **Projection reading:** `projectReceivingStatus` reads Σ as one signed quantity: `≤ 0` → NOT_RECEIVED (checked BEFORE the ordered comparison, so a compensated-to-zero line never reads as a sliver).
- **No net-receipt invention:** the report carries Σ as the exact stored string and projects status from it; it does NOT display "net received" as a business verdict, derive a fulfillment rate, or hide the compensation count.

## G. Date Semantics

- **Primary date:** `receivedAt` — the caller-stated instant of the receipt *header* (default now), Timestamptz, never rewritten. `createdAt` is bookkeeping, never a filter (documented in the contract).
- **Per-row instant:** the LATEST `receivedAt` across the line's events (max by header clock). `receivedAt: null` for a line with NO events (matches no bound, but the row is still listed when unbounded — tested).
- **Window:** HALF-OPEN `[receivedFrom, receivedTo)` — `gte` lower / `lt` upper — the exact sibling-register shape.
- **Boundary matrix (all TEST-PROVEN in E2E §R):** inclusive lower ✓; exclusive upper ✓ (an instant equal to `receivedTo` is OUT); same-day ✓ (a day's own hours); before ✗/after ✗ fall outside; invalid date → 422; inverted range → 400 (`receivedTo must not precede receivedFrom`).
- **ONE canonical predicate:** the reader's `computeRegister` pipeline (projection → status/date narrowing → deterministic order) drives list, summary, chart and both exports identically — verified by the population-consistency tests.

## H. Filters

Source-proven only (each with symbol, type, comparison, tenant scope, auth, E2E):

| Filter | Source | Semantics |
|---|---|---|
| `status` | `RECEIVING_STATUSES` (exact 3, `@IsIn`) | computed-narrowing equality on the projected status — NOT a storage column; unknown → 422 refusal |
| `purchaseDocumentId` | `Receipt.purchaseDocumentId` (UUID v4) | exact equality, pushed to SQL |
| `purchaseLineId` | `ReceiptLine.purchaseLineId` (UUID v4) | exact equality, pushed to SQL |
| `search` | parent `documentNumber` ONLY (contains, insensitive, same-owner join) | receipt rows carry no text of their own — no ref/item/notes search exists to expose |
| `receivedFrom` / `receivedTo` | latest `receivedAt` per line | half-open `[from, to)`; NULL excluded by any stated bound; invalid → 422, inverted → 400 |
| `page` / `pageSize` | Commerce window (default 20, ceiling 100) | clamped in the reader for callers that bypass the DTO |

Refused by design: `supplierId` (opaque, no display contract), `warehouseId` (no warehouse in the schema — INTENTIONALLY-NOT-SUPPORTED), `unit`/quantity/range (free text / no range vocabulary), `receiverId` (raw actor id, no display contract), any document-level status (does not exist), `createdAt` (bookkeeping), `tenantId` as a client field (server-derived; sending one is 422).

## I. Commerce Ownership

The receiving aggregate is OWNED by Commerce — ownership never crossed this phase:
- Rows live in `commerce_db` (`Receipt` / `ReceiptLine`); the projection lives in Commerce's pure module.
- The narrow read module is `commerce/reporting/commerce-receiving-reporting.module.ts` (contract + reader + repository + Prisma handle; exports ONLY the token; no audit binding — no timeline; no controllers, no writes).
- The repository extension is `ReceivingHistoryRepository.readReportSourceRows` — tenant-first predicate, `purchaseLine`/`purchaseDocument` delegates the slice already owned, no new `$queryRaw` (guard C's exactly-one lock preserved), no update/delete/upsert (guard B holds), no foreign tables (guard E holds).
- The reader projects `projectReceivingStatus` BY VALUE via the aggregate's own token `COMMERCE_RECEIVING_REPORTING_READER`.
- Reporting imports exactly: `../commerce/reporting/*` (seam) + `../commerce/receiving/receiving-status` (pure vocabulary) + `../commerce/commerce.constants` (module/feature ids) — all in the isolation APPROVED list (grown deliberately in this phase).
- No Financial import, no cross-context Prisma: `finance_db` and every other context are unreachable from these reads.

## J. Reporting Seam

- `commerce-receiving-reporting.contract.ts` — explicit 8-field row whitelist, closed query shape, three-read port, `CommerceReceivingReportingScope` (tenant only).
- `commerce-receiving-reporting.reader.ts` — the ONE pipeline; per-line rows sourced per-line; zero-filled summary; detail via the same pipeline (existence + projection); no timeline method (documented grain ruling).
- `commerce-receiving-reporting.module.ts` — narrow composition (token-only export).
- Reader spec: `commerce-receiving-reporting.reader.spec.ts` — projection, scope forwarding, filter pass-through, window refusals, clamping, summary honesty, deterministic order, no-write/no-timeline surface (12 tests, round-3 green).

## K. API

`GET /api/v1/reporting/commerce/receiving` (list + summary), `export/xlsx`, `export/docx`, `GET …/:id` (detail). FOUR GETs — no timeline (grain ruling, asserted absent in controller/isolation specs), no write verb (POST/PATCH/PUT/DELETE return 404, E2E-proven). All handlers carry exactly `commerce.read`; same module/feature chain the slice's own reads declare (`commerce` / `purchase`); tenant from the session context only. Detail id = purchase-line UUID (`ParseUUIDPipe` v4); foreign/unknown id → 404, never 403 (no existence leak).

## L. Web

- `/admin/reporting/commerce/receiving` → `ReceivingReportView`; `/[id]` → `ReceivingReportDetailView`.
- List: status select (closed 3) + document-number search + date range + summary chips that ARE the status filter + status chart + export buttons + table (document, status badge, ordered, received as exact decimals via `decimalDisplayLabel`, latest instant, compensation count) + pagination. Persian RTL, existing tones/labels/chart/empty-state.
- Detail: line-of-document identity, the eight projected facts (tenantId/receiverId never rendered), compensation count, ISO instant label. No editor, no wizard, no timeline.
- `PAGE_TITLE_ALIASES` entry (no rail row — platform-navigation decision, sibling precedent). No dashboard surface, no KPI.

## M. Chart

`ReportSummaryChart` over the server `summary.byStatus`, in `RECEIVING_STATUSES` order via `buildReportChartBuckets(summary, RECEIVING_STATUSES, commerceReceivingStatusLabel)` — same filters, same three-state vocabulary, no browser counting, no new chart surface.

## N. XLSX / DOCX

Shared writers over the `list()` result (structural scope equality — the export renders what `list()` answered, verified by list/export consistency tests):
- XLSX columns: شماره سند · وضعیت دریافت · مقدار سفارش · مقدار دریافتی · آخرین تاریخ دریافت · رویدادهای جبرانی — line grain preserved; quantities exact; status words Persian; no tenant/actor internals. Parsed back in E2E (`parseXlsxSheet`).
- DOCX: title + scope + generated timestamp + active filters + server summary + line table; `<w:bidi/>` RTL; one table; row count `1 + items`; no scope leakage; no rate/SLA/KPI invention. Verified via `readZipEntry`.

## O. Audit / Timeline

**Timeline: N/A — implemented as absent.** Receiving audit events bind `resourceId = receipt.id` for both append and compensate; the report row is a purchase line. A per-line timeline would answer its siblings' events as its own history (payment register's exact ruling, contract §"WHAT IS DELIBERATELY ABSENT"). The OFF-condition from §30 therefore applied: audit grain (receipt event) is NOT the row grain (purchase line) → no timeline. The contract offers no timeline method; the controller has no timeline route (asserted absent twice); E2E proves `:id/timeline` → 404.

## P. Security / Tenant

All E2E-proven on the real runtime: unauthenticated → 401 (list + export); unauthorized (no `commerce.read`) → 403 (list + detail + export); tenant A never sees tenant B rows (list, detail → 404 for foreign, exports); exports obey the same remit; no tenantId input exists (DTO whitelist + global pipe forbids it); server-derived tenant everywhere on the read path.

## Q. No-Write Proof

Real-DB E2E (`NO-WRITE PROOF` test): before snapshot of this run's `PurchaseLine` rows + `ReceiptLine` events (byte-serialized) and the `commerce.receipt` audit count; exercise list, scoped list, filtered lists, detail, xlsx, docx; after snapshot EQUALS before on rows, and audit count is UNCHANGED. Non-vacuity: 4 lines, 4 events, ≥4 audit events present before exercising.

## R. Tests / E2E

Unit/component (all green before the E2E round, all re-verified in the full runs):
- `commerce-receiving-reporting.reader.spec.ts` — 12 tests: projection whitelist, scope forwarding, pushable-only pass-through, absent-keys-absent, inverted/malformed window 400-before-read, ceiling clamp, zero-filled summary, computed status narrowing, half-open window + NULL exclusion, deterministic order, foreign→null, exactly-three-reads surface.
- `receiving-report.service.spec.ts` — 9 tests: tenant scoping, fail-closed tenant, filter pass-through, summary attachment, 404 mappings, eight-field whitelist, same-list exports, exactly-three-methods surface.
- `receiving-report.controller.spec.ts` — 4 tests: exactly FOUR GETs, one remit, entitlement chain, no write/timeline.
- `report-export-labels.spec.ts` — grown by the receiving three-word pin (screen ↔ file exact match).
- `reporting-isolation.spec.ts` — grown deliberately: TEN controllers/services/modules, receiving remit×4, pure-vocabulary APPROVED entry, four-handler no-write block. `reporting.module.spec.ts` — ten seams, receiving token resolution, stub delegates.
- Web `ReceivingReportView.spec.tsx` — 8 tests: identity, query shape, closed gate, summary honesty, per-line grain, detail link, half-open window, empty state. Full web suite: **2016/2016 (126 suites)**.

Real-DB E2E (`test/reporting-commerce-receiving-status-report.e2e-spec.ts`) — 21 tests, ALL GREEN on the live combined runtime with data driven through the Commerce HTTP API:
1. contract shape (list/summary/closed-set keys); 2. EXACT row grain (3 lines → 3 rows; `40.0000` partial / `80.0000` netted-compensated / `0.0000` + NULL untouched; latest-DESC + nulls-last order); 3. status filter incl. `FULLY_RECEIVED` exclusion of the netted line; 4. unknown status → 422; 5. half-open window incl. exclusive-end and NULL exclusion; 6. inverted → 400 / malformed → 422; 7. search = document number ONLY; 8. `purchaseLineId` grain-of-one; 9. impossible filter → empty page with zeroed summary; 10. summary/list partition equality; 11. cross-tenant list+detail isolation; 12. eight-field detail whitelist; 13. unknown/foreign id → 404; 14. NO timeline route → 404; 15. 403/401; 16. XLSX parsed (headers/rows/netted-80/status word/no internals); 17. cross-tenant exports; 18. DOCX (title/RTL/one table/row count/no scope); 19. NO write routes; 20. NO-WRITE PROOF (rows + `commerce.receipt` audit byte-identical).

## S. Pre-existing Issues

(ONLY issues proven at/beforethe `9726f7e` baseline — with evidence, none touched:)
- `apps/web/next-env.d.ts` untracked/generated — pre-existing, never staged.
- Web full-suite survey flake (`CoreSurveyDetailView`), proven in the evidence-review phase (20/20 in isolation) — unrelated survey surface; this phase's full web run is clean 2016/2016.
- The reporting isolation spec's historical prose counted fewer controllers than its own executable assertions — pre-existing cosmetic lag, documented in the evidence review; this phase grew the EXECUTABLE pins and left all prose accurate (TEN).
- E2E console noise (`Failed to persist a platform audit event` in the global run log): infrastructure log from the audit-outbox relay in the test environment — the phase's own no-write proof measures `commerce.receipt` audit counts directly and passes; payment/return predecessors log the same class of noise.
- API full-suite informational ERROR lines during unrelated audit-failure-path tests (`AUDIT_READ_FAILED` rejection assertions) — exercised failure paths, not failures; suite 296/296 green.

No sibling regression introduced: Purchase, Payment History, Return Lifecycle, Check Request, BOM Summary, BOM Change, Personnel Traffic, Leave, Mission suites all green in the full runs (295→296 API suites, 125→126 web suites).

## T. Phase-owned Fixes

(ONLY changes required by this phase — every item is the report itself or its deliberate guard growth:)
- New: Commerce seam (`commerce-receiving-reporting.{contract,reader,module}` + reader spec), repository read (`readReportSourceRows` + filter/source-row types), Reporting layer (`receiving-report.{dto,service,controller}` × specs + presentation), web API client + list/detail views + route pages + nav alias, receiving E2E spec, this document.
- Modified: `reporting.module.ts` (tenth surface registered), `receiving-history.repository.ts` (additive reads only — no write touched, guard B/C/E hold), `reporting-isolation.spec.ts` (pins 9→10 deliberately), `reporting.module.spec.ts` (tenth seam + stub delegates), `report-export-labels.spec.ts` (three-word pin), `core-nav.ts` (title alias only).
- NO fixes to receiving business logic, audit trails, other reports, or platform files.

## U. Limitations

- The register materializes the candidate purchase-line set and its events per read (bounded by the tenant's line population): the honest cost of a projection Prisma cannot page in SQL without raw SQL, which the slice guard forbids (`$queryRaw` pinned to the ONE `FOR UPDATE` lock). Documented in the repository header; no `GROUP BY` shortcut was taken.
- `list` + `summary` run the pipeline twice in parallel (per-request cost ×2) — the same equality-over-efficiency choice the siblings make with two SQL reads; list and summary can never disagree.
- An over-receipt that the write path could not commit throws RangeError from the domain pure module and surfaces as 500 — exactly as Commerce's own screen behaves; by construction such history cannot be persisted (locked 409 at append).
- Date bounds apply to the line's LATEST event instant; per-event history browsing remains the Commerce operational surface (`GET :id/receipts`), not this register.

## V. Final Verification

```text
Working tree:              implementation files + this document staged by path;
                           `apps/web/next-env.d.ts` untracked/generated, never staged
git diff --check:          (run at commit time — required to pass)
git diff --stat:           only phase files (no cleanup, no formatting)
Implementation commit:     feat(reporting): add commerce receiving status report
Documentation commit:      docs(reporting): document commerce receiving status report
Blind git add:             FORBIDDEN — staged explicitly by path
```

## W. Commits

Recorded after the phase (a commit cannot record the hash of the commit carrying it — see `git log`):
- Implementation: `feat(reporting): add commerce receiving status report`
- Documentation: `docs(reporting): document commerce receiving status report`

## Evidence vs Assumption

For each major receiving semantic:

| Semantic | Verdict | Ground |
|---|---|---|
| Per-line row grain | SOURCE-PROVEN + TEST-PROVEN | service `list()`'s per-line projection + E2E 3-lines→3-rows |
| Three-state vocabulary | SOURCE-PROVEN + TEST-PROVEN | `RECEIVING_STATUSES` verbatim; closed-set spec + E2E |
| `projectReceivingStatus` reuse | SOURCE-PROVEN + TEST-PROVEN | imported BY VALUE in the reader; no re-typed rule anywhere |
| Compensating-row netting | SOURCE-PROVEN + TEST-PROVEN | 100→−20 ⇒ `80.0000` + `compensationCount: 1` in E2E |
| Date window + NULL rule | SOURCE-PROVEN + TEST-PROVEN | header instant semantics; half-open/exclusive/NULL tests |
| Filters | SOURCE-PROVEN + TEST-PROVEN | each filtered individually against real rows |
| `commerce.read` + tenant isolation | TEST-PROVEN | 401/403/404 matrix on the live runtime |
| Audit/timeline N/A | SOURCE-PROVEN | `resourceId = receipt.id` in the service — grain mismatch is a fact, not a gap |
| No-write | TEST-PROVEN | byte-identical snapshots + unchanged audit count |
| Export scope equality | TEST-PROVEN | parsed XLSX + DOCX against the listed population |
| Warehouse/location | INTENTIONALLY-NOT-SUPPORTED | no warehouse exists in the schema — refused, not omitted |
| Document-level status | INTENTIONALLY-NOT-SUPPORTED | R5 asserts it exists NOWHERE — refused, not deferred |
| Rates/SLA/aging/quality | INTENTIONALLY-NOT-SUPPORTED | separate KPI/product decisions, documented |
| Anything beyond §H filters | BLOCKED / REQUIRES FOLLOW-UP | nothing else has source evidence — must pass a new scope gate |







