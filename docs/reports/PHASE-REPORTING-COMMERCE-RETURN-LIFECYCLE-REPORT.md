# PHASE — REPORTING-COMMERCE-RETURN-LIFECYCLE-REPORT

«گزارش چرخه حیات مرجوعی‌های بازرگانی» — the ninth Reporting capability, over the
third Commerce-owned narrow read seam.

## A. Baseline

| Item | Value |
| --- | --- |
| Starting HEAD | `3e52e3f` (docs(reporting): document commerce payment history report) |
| Previous phase | Commerce Payment History Report — COMPLETE (`942d633` impl / `3e52e3f` docs) |
| Pre-existing artifact | `?? apps/web/next-env.d.ts` — verified at start, NOT phase-owned, NOT committed |
| Baseline focused API suite | 37 suites / 487 tests PASS (returns + commerce/reporting + reporting + payment + purchase + architecture-boundaries) |
| Baseline Commerce suite | 49 suites / 748 tests PASS |
| Baseline payment E2E | 1 suite / 20 tests PASS (real DB available) |
| Baseline API typecheck | PASS |
| Baseline web typecheck | PASS |
| Baseline `git diff --check` | clean |

## B. Scope Decision

| Field | Decision |
| --- | --- |
| Selected scope | **A — RETURN REQUEST LIFECYCLE** |
| Row grain | ONE row = ONE `ReturnDocument` (a return request against its parent purchase document) |
| Primary aggregate | `ReturnDocument` + children `ReturnLine[]`, `ReturnLifecycleTransition[]` |
| Child/line relationship | 1..N `ReturnLine`; the LIST row carries `lineCount`, the DETAIL read nests the lines |
| Lifecycle | 5 persisted states, projected at read time by `projectReturnState` over the frozen matrix (see F) |
| Primary date | `ReturnDocument.createdAt` — written with the `REQUESTED` transition ⇒ it IS the request instant |
| Supported filters | `state` (5-member vocabulary), `search` (reason OR parent documentNumber), `purchaseDocumentId`, half-open `[createdFrom, createdTo)` on `createdAt`, page/pageSize |
| Timeline support | YES — audit is bound to the RETURN (`resourceId = return document id`), so a per-row timeline cannot lie by grain |
| Export support | XLSX + DOCX through the shared writers, structurally the SAME `list()` |
| Commerce ownership | 100% — every field lives in `commerce_db` |
| Financial dependency | NONE — no money, no refund amount, no payment row crosses this report |
| Refund dependency | The REFUNDED STATE crosses; the refund's money effect (Q's compensation) intentionally does not |
| Sensitive data | `tenantId`, `requestedByUserId`, transition `actorUserId` all withheld; line contents only on detail |
| Exclusions | money/refund amounts, supplier, warehouse, actor filters, cancellation/inspection states (none exist), SLA/aging/KPI |
| Decision | **APPROVED** |

## C. Source Evidence (high points)

- `prisma/commerce/schema.prisma:1982` — `model ReturnDocument`: «ONE return request
  against the purchase document it originated from»; NO `status`/`state` column, NO
  `updatedAt`, NO number/RMA, NO financial columns (each absence documented in the
  schema's own comments).
- `schema.prisma:2106` — `model ReturnLifecycleTransition`: the ONLY place state
  exists; `state` on the history row; `(createdAt, id)` ordering.
- `schema.prisma:1940` — `enum ReturnState { REQUESTED, APPROVED, RECEIVED_BACK,
  REFUNDED, REJECTED }`.
- `returns/return-lifecycle.ts` — the PURE matrix: `REQUESTED → APPROVED | REJECTED`,
  `APPROVED → RECEIVED_BACK`, `RECEIVED_BACK → REFUNDED`; REJECTED/REFUNDED terminal;
  `projectReturnState` sorts `(createdAt, id)`, validates the chain, answers the LAST
  row. No cancel/correction edge exists (S-D4).
- `returns/return-history.controller.ts` — six routes: one GET + five POSTs (create,
  approve, reject, receive-back, refund) under `commerce.read` / `commerce.manage`.
- `returns/return-history.service.ts` — one audit row per successful command,
  `resource = commerce.return_document`, `resourceId = return document id`, five
  actions (`create`, `approve`, `reject`, `receive_back`, `refund`), after commit.
- Refund: `service.refund` calls Q's `PaymentHistoryService.compensate` in the SAME
  unit of work; a Q refusal = 409 with NO `REFUNDED` row. The money lives on
  `PaymentRecord` (Commerce-internal); this report never touches it.

## D. Return Ownership

Commerce owns ALL report semantics: the documents, the lines, the transition history,
the lifecycle vocabulary, the tenant predicate and the audit family. `finance_db` is
never read; Financial remains a separate bounded context with no contract needed —
the report projects the REFUNDED state and nothing monetary (section I).

## E. Row Grain

One row = one `ReturnDocument`. Document-level and line-level rows are never mixed:
the register and both exports count documents; lines appear ONLY inside the detail
projection (`lines[]`), and `lineCount` on the row is a COUNT of `ReturnLine` rows
that exist — not a figure computed from them. «What does one row represent?» — ONE
return request, in its projected lifecycle state, against one purchase document.

## F. Lifecycle / Status

SOURCE-PROVEN five-member vocabulary (`RETURN_STATES`, one authority in
`returns/return-lifecycle.ts`, imported BY VALUE in the reader for zero-fill and BY
TYPE in the contract/DTO):

| # | State | Terminal? |
| --- | --- | --- |
| 1 | `REQUESTED` | no — → APPROVED / REJECTED |
| 2 | `APPROVED` | no — → RECEIVED_BACK |
| 3 | `RECEIVED_BACK` | no — → REFUNDED |
| 4 | `REFUNDED` | YES |
| 5 | `REJECTED` | YES |

Because the schema has NO state column, the reader projects every row through
`projectReturnState` (the ONE rule engine), while the state FILTER is a relation
predicate over the transition history: «has X, and has none of the states that only
come after X on X's path». Over every history the matrix permits, predicate and
projection are provably equal (each valid path visits each state at most once) — and
the E2E proves the equivalence on real data for all five states (section Q). No
status is ever inferred from a timestamp.

## G. Date Semantics

`createdAt` (the return's own clock) is the primary reporting date — the ONLY header
instant the append-only schema has, and it equals the request moment (the `REQUESTED`
transition is written in the same transaction). Range: HALF-OPEN `[createdFrom,
createdTo)` — `gte` on the lower bound, `lt` on the upper; the same-day boundary is
the caller's civil day rendered as `[day 00:00Z, next day 00:00Z)` by the web's
`returnLifecycleDayToFrom/ToInstant` helpers — one boundary, stated once. Invalid
instant → 422 at the DTO; inverted window → 400 at the reader BEFORE any statement;
list, summary, chart and both exports consume the SAME predicate (the export path
calls the service's own `list()`).

## H. Filters

| Filter | Source field | Comparison | Notes |
| --- | --- | --- | --- |
| `state` | transition-history relation predicate | membership in `RETURN_STATES` (DTO `@IsIn`) | unknown member = 422; predicate ⇔ projection proven in E2E |
| `search` | `ReturnDocument.reason` OR parent `PurchaseDocument.documentNumber` | case-insensitive `contains` | the only text a return carries |
| `purchaseDocumentId` | `purchaseDocumentId` | exact UUID (DTO `@IsUUID('4')`) | one document's returns |
| `createdFrom`/`createdTo` | `createdAt` | half-open `[gte, lt)` | inverted → 400 before any statement |
| `page`/`pageSize` | — | DTO clamped to COMMERCE ceiling (100) | reader re-clamps as guarantee |

No global search, no fuzzy matching, no actor/supplier/warehouse/amount filters —
none of them exists on this grain.

## I. Commerce vs Financial / Refund Boundary

The refund's money effect is Q's `PaymentRecord` compensation — Commerce-internal,
never projected here. The report carries NO amount, NO currency, NO payment id, NO
accounting figure; `REFUNDED` is the whole refund fact this lifecycle report states.
Financial (`finance_db`) is never read, no cross-context contract was required, and
Commerce Reporting did not absorb any Financial responsibility.

## J. Reporting Seam

- `commerce/reporting/return-lifecycle-reporting.contract.ts` — token
  `COMMERCE_RETURN_LIFECYCLE_REPORTING_READER`, scope, query, the eight-field row
  whitelist, detail (+lines), summary, timeline shapes, the FOUR-method read-only
  interface.
- `commerce/reporting/return-lifecycle-reporting.reader.ts` — the adapter: delegates
  to `ReturnHistoryRepository`'s three NEW tenant-scoped report reads, projects rows
  through `projectReturnState`, zero-fills the summary over `RETURN_STATES`, reads
  the timeline through `CommerceAuditGateway`, maps audit rejection to the typed
  failure, refuses inverted/malformed windows with 400 before any statement.
- `commerce/reporting/return-lifecycle-reporting.module.ts` — the NARROW module:
  Commerce Prisma + audit port + repository + gateway + reader; exports ONLY the
  token.
- `ReturnHistoryRepository` gained exactly THREE public reads beside its eight
  domain methods — `listReportPage`, `countReportByState`, `findReportRow` — each
  `tenantId`-first on the ONE shared `buildReportWhere`/`buildStateWhere` builder.
  The `returns.guards.spec.ts` pin J grew from eight to eleven names with a phase
  comment (the payment register's precedent, verbatim); no write path was added and
  no guard was weakened.
- Reporting imports ONLY the token plus the pure vocabulary
  (`../commerce/returns/return-lifecycle`) — approved in the B3 architecture
  pattern list, the isolation APPROVED suffix list and the group-C seam check.


## K. API

Five GETs, no writes, under `reporting/commerce/return-lifecycle`:

| Route | Purpose | Remit |
| --- | --- | --- |
| `GET /api/v1/reporting/commerce/return-lifecycle` | page + server summary | `commerce.read` |
| `GET …/export/xlsx` | the SAME page as a spreadsheet | `commerce.read` |
| `GET …/export/docx` | the SAME page as a Word document | `commerce.read` |
| `GET …/:id` | one row + its lines | `commerce.read` |
| `GET …/:id/timeline` | the return-bound audit trail | `commerce.read` |

Entitlement: `commerce` module + `purchase` feature — the same chain Commerce's own
return reads declare. Reporting DTOs: `ListReturnLifecycleReportQueryDto` (state/
search/document/window/page) and `ReturnLifecycleReportTimelineQueryDto` (page only).
Reporting service: 403 on missing tenant (fail closed), 404 for missing-OR-foreign
rows (existence never leaks), `AUDIT_READ_FAILED` → 503 (an outage never renders as
an empty history), exports structurally identical to `list()`.

## L. Web

- Route `/admin/reporting/commerce/return-lifecycle` (+ `[id]`) — thin server
  components; `PAGE_TITLE_ALIASES` entry added (no rail row, sibling precedent);
  the `/admin/reporting` landing has no card list (payment precedent) — unchanged.
- `ReturnLifecycleReportView` — identity → filters (state select, reason/number
  search, from/to days) → summary chips (the chips ARE the state filter) →
  `ReportSummaryChart` → `ReportExportButtons` → table → pagination. RTL, calm
  enterprise styles, existing empty/error/loading states, rows persist during refetch.
- `ReturnLifecycleReportDetailView` — header facts, the lines table, and the
  audit-backed timeline (rendered raw `action` words as the timeline components do);
  a timeline outage shows a notice without hiding the row.
- `lib/return-lifecycle-report-api.ts` — five GETs mirroring the controller; the
  state vocabulary is IMPORTED from `commerce-api.ts` (one union, both surfaces).
- `__tests__/ReturnLifecycleReportView.spec.tsx` — 9 tests: identity, query shape,
  the read gate, summary honesty, vocabulary, detail link, half-open window, server
  state filter, empty state.

## M. Chart

`ReportSummaryChart` over `summary.byState` with the CLOSED five-member order and
`commerceReturnStateLabel` — a status distribution fed ONLY by the server summary.
No reason/supplier chart: the reason is unbounded free text (not chartable) and no
supplier column exists on this grain.

## N. XLSX / DOCX

Shared writers via `renderReportExport`. The presentation
(`presentation/return-lifecycle-report.presentation.ts`) states title
«گزارش چرخه حیات مرجوعی‌های بازرگانی», file base `commerce-return-lifecycle-report`,
six columns (document number, state word, reason, replacement, line count, request
instant), a five-state zero-filled summary block, and the active filter lines.
`RETURN_REPORT_STATE_LABELS` is pinned word-for-word to the web's
`RETURN_STATE_LABELS` by `report-export-labels.spec.ts` (ninth pin). Exports render
the service's OWN `list()` result — same rows, same summary, same filters, no second
query path. E2E parses both files back: header row, 5 rows, exact state words, RTL
`<w:bidi/>`, one table, and no tenant id / return id / actor id in either file.

## O. Audit / Timeline

Timeline reads `commerce.return_document` with `resourceId = return document id`
through `CommerceAuditGateway.read` — existence proved tenant-scoped FIRST (unknown/
foreign → 404, never an audit probe), the platform's seven-field item whitelist, and
a rejected read re-thrown with the closed `AUDIT_READ_FAILED` code (service → 503).
E2E proves real events end-to-end: the REFUNDED return's page holds EXACTLY
`create+approve+receive_back+refund` (4), the REJECTED one exactly `create+reject`
(2) — resourceId-bound, never a sibling's events. No event is ever synthesized from
a timestamp.

## P. Security / Tenant

- 401 unauthenticated (list/export/timeline), 403 without `commerce.read` (all five
  routes), entitlement `commerce/purchase` on the controller class.
- Tenant scope is the server-resolved actor's `tenantId`, first argument of every
  seam read; no client `tenantId` (the global whitelist turns one into a 422).
- Cross-tenant: tenant B's return never appears in tenant A's register; foreign id →
  404 on detail AND timeline; tenant B's export contains no tenant-A document
  numbers — proven in both directions by E2E.
- Sensitive fields withheld at the REPOSITORY SELECT (not stripped later):
  `tenantId`, `requestedByUserId`, transition actors; exports additionally verified
  free of tenant id, return ids and the actor id.


## Q. Tests / E2E

| Suite | Scope | Result |
| --- | --- | --- |
| `return-lifecycle-reporting.reader.spec.ts` (new) | projection whitelist, impossible-history refusal, detail lines, tenant forwarding, filter pass-through, absent-keys-absent, inverted 400-before-statement, clamp, five-state zero-fill, null-for-foreign, timeline family/pagination/unknown-row, rejection re-throw, four-read surface | 14/14 PASS |
| `return-lifecycle-report.service.spec.ts` (new) | tenant scoping, source-only filter pass-through, 404 missing-OR-foreign, existence-before-timeline, AUDIT_READ_FAILED→503, other-error re-throw, projection untouched, no-write surface, export through the same list | PASS |
| `return-lifecycle-report.controller.spec.ts` (new) | exactly five GETs, one `commerce.read` remit, entitlement chain, no mutating decorator, timeline route present | PASS |
| `report-export-labels.spec.ts` (+1 pin) | the five export state words EQUAL the web's `RETURN_STATE_LABELS` | PASS |
| `reporting-isolation.spec.ts` (+phase edits) | non-spec file list, NINE controllers, exact imports, group-C seam (`returns/return-lifecycle` approved), group-D remit row (COMMERCE_READ ×5), group-F five-handler list | PASS |
| `reporting.module.spec.ts` (+phase edits) | nine read seams compose, ninth controller/service/token mount, token not re-exported | PASS |
| `returns.guards.spec.ts` (+phase edits) | pin J: ELEVEN repository methods (three report reads named, phase comment), tenantId-first, no findUnique, every `where` names the tenant, no status token | PASS |
| `architecture-boundaries.spec.ts` (+phase edit) | B3 approved vocabulary now includes `/return-lifecycle` | PASS |
| Reporting unit (whole `modules/reporting`) | 23 suites / 184 tests | PASS |
| Real-DB E2E `reporting-return-lifecycle-report.e2e-spec.ts` (new) | 24 scenarios — see below | **24/24 PASS** |
| Web `ReturnLifecycleReportView.spec.tsx` (new) | 9 scenarios — see L | PASS |
| Web full | 125 suites / 2008 tests | PASS |

E2E scenarios (driven through the REAL Commerce write API — document → receipt →
payment → five returns covering ALL five states via approve/reject/receive-back/
refund, plus tenant B's probe): register+summary; exact one-row-per-document grain
and projection; newest-`createdAt` order; state filter ⇔ projection equivalence for
all five states; summary partition (five counts = total); half-open window
(whole-run, exclusive edge, same-day); inverted 400 + malformed 422; unknown state +
oversized page 422; search by reason/phrase/document number; impossible filter →
zero-filled empty page; pagination; 403 (list/detail/timeline/export); 401
(list/export/timeline); cross-tenant list/detail/timeline; detail whitelist + lines;
unknown id → 404 (detail+timeline); audit timeline exact actions (4 and 2, resource-
bound); timeline window; LIVE lifecycle transition (create → reject moves the
register and summary); no write verbs (POST/PATCH/DELETE → 404); XLSX parsed (header,
five rows, five state words, reason, replacement flags, no scope/ids); DOCX parsed
(title, bidi, one table, header+5 rows, no scope/ids); cross-tenant export;
state-filtered export; NO-WRITE STATE PROOF (7 documents + 7 lines + 15 transitions +
13 audit events byte-identical after exercising every read surface).

## R. Pre-existing Issues (baseline-proven only)

- `Failed to persist a platform audit event` WARNs from
  `ProductionAuditOutboxRelayService` during E2E — **20 occurrences in the BASELINE
  payment E2E run and 20 in this phase's run**: unrelated Production-relay noise,
  identical before/after, not phase-owned.
- Historical knowns from the phase brief (sibling Reporting timeline E2E flakes,
  prettier drift, raw web eslint limitations, generated-client lint issues, unrelated
  web build warnings) were not assumed fixed and are not phase-owned; the suites run
  in this phase passed without needing them.

## S. Phase-owned Fixes

- `architecture-boundaries.spec.ts`: added `/return-lifecycle` to the B3 approved
  vocabulary patterns — a deliberate, commented extension of the approved list (the
  mission-date-time precedent), not a guard weakening.
- Guard pins grown deliberately with phase comments (payment precedent):
  `returns.guards.spec.ts` J (8 → 11 method names), `reporting-isolation.spec.ts`
  (file/controller/imports/remit/handler lists), `reporting.module.spec.ts` (ninth
  surface), `report-export-labels.spec.ts` (ninth word pin).
- E2E fixture fixes during the phase: `feature.id` (not `featureRowId`) for the
  grant; phrase-search scoped to the run's document (leftover runs are real rows);
  snapshot scope includes the live sixth return; numeric XLSX cell asserted as the
  parser's exact string form (payment precedent `-20`).

## T. Limitations

- The state FILTER's predicate ⇔ projection equivalence is proven for every history
  the matrix permits (E2E: all five states on real rows); an IMPOSSIBLE history
  (only a write-side bug could create one) makes the row's projection THROW — the
  report surfaces an error rather than fabricating a state, exactly as Commerce's
  own routes behave.
- The timeline depends on the platform audit relay's latency: events appear when
  the outbox delivers (the E2E waits for them explicitly). The rows themselves are
  immediately consistent.
- Refund AMOUNTS, reason analytics (free text), supplier views and aging/KPI are
  INTENTIONALLY NOT SUPPORTED — separate product/KPI decisions with sources of
  their own, out of this phase's scope.


## Evidence vs Assumption

Every Return semantic behind this report, classified:

| Semantic | Classification | Where |
| --- | --- | --- |
| Return = one request against its purchase document; multi-line | SOURCE-PROVEN | `schema.prisma` `model ReturnDocument/ReturnLine` (§5.17, contract S-D5) |
| State lives ONLY in append-only transitions; no status column | SOURCE-PROVEN | `schema.prisma` model comments + `returns.guards.spec.ts` E-scan |
| Five-member vocabulary + frozen matrix + terminal states | SOURCE-PROVEN | `returns/return-lifecycle.ts`, `enum ReturnState`, migration `20260929000004` |
| Projection = last row by `(createdAt, id)`, chain-validated | SOURCE-PROVEN | `projectReturnState` + `return-lifecycle.spec.ts` |
| Approval, rejection, receipt-back, refund commands exist | SOURCE-PROVEN | `return-history.controller.ts` six routes; lifecycle E2E drives all four |
| NO cancellation / correction / inspection state | SOURCE-PROVEN (absence) | controller header (S-D4), schema absences, matrix has no such edge |
| Refund = delegated Q compensation; money never stored on the return | SOURCE-PROVEN | `return-history.service.ts` §4-E; schema "the only money effect of a refund is the delegated Q compensation" |
| `createdAt` = request instant (created with REQUESTED row) | SOURCE-PROVEN | `appendReturn` writes document + REQUESTED transition in ONE transaction |
| Audit family `commerce.return_document`, resourceId = return id, 5 actions | SOURCE-PROVEN | `return-history.service.ts` + `commerce.constants.ts` + `return-history.service.spec.ts` |
| Timeline trustworthy per-row (grain matches) | SOURCE-PROVEN + TEST-PROVEN | above + E2E exact 4/2 event pages |
| State filter predicate ⇔ projection on real data | TEST-PROVEN | E2E: all five states, each returns exactly its own row + honest summary |
| Row grain (one row = one return document) | TEST-PROVEN | E2E grain/whitelist/export row-count assertions |
| Half-open `[createdFrom, createdTo)` semantics | SOURCE-PROVEN + TEST-PROVEN | purchase/payment window precedent on same-owner tables + E2E edge/same-day |
| Refund amounts, SLA, aging, rates, KPI | INTENTIONALLY-NOT-SUPPORTED | scope exclusions (no source columns; KPI is a separate concern) |
| Supplier / warehouse / item filters | INTENTIONALLY-NOT-SUPPORTED | no such columns on `ReturnDocument` (schema §5 refusal) |
| Cancellation/inspection reporting | INTENTIONALLY-NOT-SUPPORTED | the states do not exist (S-D4) |
| Financial/contract dependency for refund money | NOT REQUIRED — boundary preserved | section I; no `finance_db` read anywhere |
| BLOCKED items | NONE | every stop condition checked and cleared (§31) |


## U. Final Verification

| Gate | Result |
| --- | --- |
| Scope decision completed | APPROVED (section B) |
| Row grain proven | PASS — E2E one-row-per-document + export row counts |
| Commerce ownership / refund boundary proven | PASS — sections D/I; no `finance_db` read anywhere |
| Lifecycle proven | PASS — source matrix + E2E all five states |
| Date semantics / filters proven | PASS — section G/H + E2E edge/same-day/inverted |
| Authorization + tenant isolation proven | PASS — 401/403/404 both directions, exports included |
| Audit/timeline proven | PASS — return-bound resource, exact 4/2 event pages |
| Sensitive-data review | PASS — repository-level select whitelist + export scans |
| Commerce seam + canonical predicate | PASS — ONE `buildReportWhere`/`buildStateWhere` for page, counts, detail |
| List/summary/detail/timeline/XLSX/DOCX | all PASS — E2E |
| Web list/detail/chart/RTL/exports | PASS — 9-test view spec + builds |
| No-write proven | PASS — 7 documents + 7 lines + 15 transitions + audit trail byte-identical |
| Source seam tests | 14/14 PASS |
| Reporting unit (modules/reporting) | 23 suites / 184 PASS |
| Commerce + Reporting + architecture regression | 74 suites / 975 PASS |
| Full API suite | **293 suites / 4504 tests PASS** |
| Return E2E (real DB) | **24/24 PASS** |
| Full web suite | **125 suites / 2008 tests PASS** |
| API typecheck (`tsc --noEmit`) | PASS |
| Web typecheck (`tsc --noEmit`) | PASS |
| API build (`nest build` into fresh `dist`, incl. new files) | PASS |
| Web build (`next build`, `Compiled successfully`, 74/74 static) | PASS |
| `git diff --check` | PASS (clean) |
| Prettier on phase-owned files | PASS (only the 25 phase files formatted; sibling/base files untouched) |
| Architecture guards (B3, I8, isolation, pins) | PASS — every guard extended deliberately, none weakened |

Notes on the build gate: the repo's `prebuild` (`rimraf dist src/generated` +
`prisma generate`) initially failed with `EPERM` on `query_engine-windows.dll.node`
while stale test processes still held the files (a local environment contention, not
a code issue). After the stale processes were stopped and `npm run prisma:generate`
completed (8/8 clients), `nest build` produced a fresh `dist` containing this phase's
files. The web build's `[blog-api] fetch failed` warning is the documented
pre-existing local warning (payment-phase report §R) — the build exits with the full
route table including `/admin/reporting/commerce/return-lifecycle` (ƒ) and its `[id]`
detail.

## V. Commits

- Implementation: `ae9ee1c` — `feat(reporting): add commerce return lifecycle report`
- Documentation: `<docs-hash>` — `docs(reporting): document commerce return lifecycle report`

