# PHASE-KPI-HISTORICAL-INTELLIGENCE — governed history, comparison and trend

## 1. Baseline

Verified repository baseline before implementation:

```text
HEAD:                 7636b6a42ccf81b421c1b8553d986c027eba8dd2
Branch:               master
Working tree clean:   YES
KPI Runtime:          703c767
KPI Web UX:           7636b6a
```

Starting state re-verified (`git rev-parse HEAD`, `git status --short`, last 15 commits)
against the phase brief's §2/§47 preflight: `apps/api/src/kpi/`,
`apps/api/src/modules/kpi-runtime/`, `apps/web/.../kpi/`,
`docs/architecture/KPI-CATALOG.md`, `docs/reports/PHASE-KPI-RUNTIME-UX.md`,
all five KPI definitions, the runtime engine, the API DTOs, the period resolver,
both Web views, the report routes, the three seam contracts and their runtime-phase
date-window extensions were all read before any design decision was made.

The prior phase's known caveat is carried, not hidden: its Web full suite reported
`1900/1901 PASS` with one `CoreSurveyDetailView` failure, passing in isolation and
identified as a parallel-worker flake unrelated to KPI work.

## 2. What was built

The five approved KPIs (KPI-001…KPI-005) gained a first, deliberately narrow
management-intelligence surface, all through the SAME governed definitions, the SAME
structural formulas, and the SAME seams:

```text
Current KPI
      ↓
Historical periods      — GET /kpis/:key/history (bounded, chronological)
      ↓
Comparison              — server arithmetic over two governed values
      ↓
Trend                   — real months as a line with honest gaps + a text table
      ↓
Supporting report       — the governed source register (KPI-to-report drill-down)
```

No target/threshold, no alerting, no dashboard builder, no snapshot table, no
warehouse, no generic time-series engine, no AI insights. KPI-006…KPI-009 stay
non-executable; their governance state is unchanged.

## 3. Period and comparison semantics (governance, §5–§6 of the brief)

The first cohort's time semantics were preserved and completed, not replaced:

- **Measurement period**: the Jalali month the KPI value is cohorted on
  (`timeSemantics.cohortField` per KPI — `decidedAt` for KPI-001/002/005,
  `completedAt` for KPI-003, `createdAt` for KPI-004).
- **Comparison period**: the immediately preceding governed month, resolved by the
  SERVER through `resolveKpiPeriod` + `previousJalaliMonth` — a screen never derives
  «ماه قبل» from a browser clock (§6: no browser-local Gregorian dates, no mixing).
- **Timezone/calendar**: `Asia/Tehran`, Jalali month boundaries, half-open
  `[start, end)` windows — the existing `kpi-runtime.period.ts` resolver, extended
  only with a `completed` flag on `KpiPeriod` (made optional so every existing
  payload literal keeps compiling).
- **Missing periods**: three distinguishable states — `EMPTY_COHORT` (nothing
  happened), `EMPTY_DENOMINATOR` (rows exist, none terminal — e.g. a month whose
  only decisions were correction-returns), `NO_VALID_ROWS` — plus a capped-read
  refusal. An unavailable value is always `null`, never zero (§10, §13).
- **Completed vs partial** (§33): a month whose exclusive end has not passed is
  marked `completed: false` and rendered «در جریان». The current (partial) month
  is comparable only with that label; the detail comparison states the caution
  outright.

One read-only route, mirroring `kpi-runtime.controller.ts` exactly:

```text
GET /kpis/:technicalKey/history
```

All query fields optional; empty = the server's own default (last 6 months):

```text
periodCount               last N months ending at the current month (N >= 2)
fromJy/fromJm/toJy/toJm   an explicit month pair, walked forward, oldest first
```

The list route also serves card context: `GET /kpis` now returns `previousPeriod`
(server-resolved, never browser-derived) plus a per-visible-key `comparisons`
record — every comparison computed through the SAME `compute` as the current
value, so five KPI cards need no second formula and no client-side derivation.

### The bound is evidence-based (§9, §12)

`KPI_HISTORY_MAX_PERIODS = 12` (one Jalali year). Evidence: a MEAN month costs at
most `ceil(5000/100) = 50` seam pages under the existing ceilings, so a 12-month
history costs at most 600 page reads per KPI — the same ORDER as twelve
single-period reads a screen could already issue, now stated once in the
resolver. Ratios cost one bounded `groupBy` per month.

No generalized time-series engine was introduced: each month reuses the
single-period compute path (`resolveKnownKpiPeriod` → `compute`), and if any
month throws, the WHOLE history throws — partial series are never published
(§10). When exceeded, the failure is deterministic:

```text
HISTORY_RANGE_EXCEEDS_LIMIT      (HTTP 400, closed code)
HISTORY_INVALID_RANGE            (HTTP 400 — inverted, undersized, unparseable)
```

The `periodCount` ceiling is owned by the RANGE RESOLVER, deliberately not by
the DTO: an oversized ask fails with `HISTORY_RANGE_EXCEEDS_LIMIT` rather than
a generic validation error. Impossible month fields keep their calendar bounds
in the DTO (422: a malformed request, not a range question).

### Comparison (§14–§17)

## 6. Completed/incomplete period policy (§32–§33)

Default views (verified safe for all five KPIs):

- overview: current period + server-computed previous comparison;
- detail: the last 6 months ending at the current month.

A completed month is one whose exclusive end passed the reading clock. The
current month is therefore `completed: false` and labelled «در جریان»
wherever it appears (card chip, value period, chart table, list period); the
comparison adds the caution that a partial month is being read against a full
one. Past months are `completed: true`. Only resolvable Jalali months are
accepted as periods, so no future-month fabrication is possible.

## 7. Chart behaviour (§22–§24)

`KpiTrendChart` (dependency-free SVG, RTL-native, dark/light via tokens):

- one point per requested period from the server's own values (display
  projection when the catalogue authorised one);
- chronological order preserved in the RTL reading direction (oldest at the
  right edge, newest at the left) with the month name under every point;
- every unavailable month BREAKS the line: a dashed guide plus an em dash,
  never a zero point, never a bridged segment (§23);
- units are named on the figure; value labels show the exact plotted number;
- accessible equivalent is FIRST-CLASS: the `figure` carries a figcaption
  summary and the SVG an `aria-label` summary, and the SAME months are rendered
  as a real table (period/value/availability, with «در جریان» where
  applicable) beneath the chart.

Single-point runs render as dots (no line through one point); an all-absent
series renders an all-absent table, not a bare axis.

## 8. Drill-down mapping (§29–§30)

`supportingReportFor` maps each approved key to its governing register:

```text
production-bom-*                  → /admin/reporting/production
commerce-purchase-*               → /admin/reporting/purchase-requests
financial-check-request-…         → /admin/reporting
```

Same tenant (request context), same authorization (the KPI's own source remit —
the precise remits the report routes declare). Wording is
«مشاهده گزارش مبنا» with the note that this is the SOURCE REPORT, not another
KPI. HONEST LIMITATION (stated in the UI and here): the report list DTOs carry
NO date-window filters (status/search only), so the drill-down links the
register WITHOUT injecting period filters it cannot honour — no fake

## 9. Security and tenant isolation (§35–§36)

History and comparison inherit the current-runtime authorization, key for key:

- `@UseGuards(JwtAuthGuard)` + the union `@Roles(...KPI_READ_REMITS)` gate;
- per-definition permission AND module/feature entitlement before ANY seam read;
- unknown key → 404 `KPI_NOT_FOUND` (the catalogue is public record, so an
  unknown key discloses nothing — but a REAL key the caller may not read still
  answers 403, never a 404 that would hide a published definition);
- candidate rejection: `servedKpiDefinitions()` is exactly the five `APPROVED`
  entries; `DRAFT`/`EVIDENCE_REVIEW`/`BLOCKED`/unknown keys all 404 on the
  history route — no candidate KPI can have historical results;
- tenant scope is the request context only; a sent `tenantId` is a 422.

Isolation is proven in BOTH directions in the real-runtime E2E (two fresh
tenants, each blind to the other's rows — cohort counts, not just values).

## 10. Performance and query behavior (§12, §44)

Measured and documented rather than optimised prematurely:

- history = N sequential single-period computes (formula path reused, no second
  engine); list with card comparisons = 2 computes per visible KPI;
- seam ceiling per MEAN month: at most 50 page reads (`KPI_PAGE_SIZE` 100 ×
  `KPI_READ_LIMIT` 5000); ratios: one bounded summary per month; a ceiling hit
  refuses the whole month as `COHORT_EXCEEDS_LIMIT`, never a partial mean;
- the oversized-range check runs BEFORE any seam is touched;
- Web: overview issues ONE list request (comparisons server-side); detail
  issues ONE single-period + ONE history request in parallel on independent
  state — a history outage shows a scoped retry while the current value stays
  readable.

No request may compute thousands of periods: 12 is the hard ceiling, enforced
in the resolver and mapped to a closed code.

## 11. What is explicitly deferred (§42–§45)

NONE of these was introduced, and none was smuggled through a side door:

- targets/thresholds (all five remain `NOT_DEFINED`; `NOT_ASSESSED` throughout);
- performance colours (the `GREEN`/`YELLOW` governance word stays DATA
  READINESS; cards and charts use neutral presentation);
- email/push/in-app alerting or monitoring of any kind;
- KPI snapshot/history persistence, scheduled computation, warehouse, caches;
- generic time-series engines, DSLs, dashboard builders, AI insights;
- `prettier --check` repository-wide hand-formatting noise remains the standing
  caveat: no broad formatting rewrites were made to chase a green check.

## 12. Verification — exact executed values

```text
KPI runtime unit tests:          5 suites / 62 tests PASS
                                 (engine, period, service, comparison, history)
KPI historical tests:            17 of the 62 above are new this phase
                                 (4 comparison + 4 history-range + 7 service-history
                                 + 2 completed-period)
KPI governance tests:            2 suites / 23 tests PASS (kpi-catalog, kpi-governance)
KPI architecture guards:         PASS (kpi-governance.spec no-leakage + doc-sync)
KPI E2E:                         10 tests PASS (test/kpi-runtime.e2e-spec.ts)
Historical comparison E2E:       covered by the same suite — elapsed + percentage
                                 comparisons, zero-denominator, unavailable period
Reporting regression E2E:        4 suites / 69 tests PASS
                                 (production, purchase, hr, check-request — exit 0)
Web KPI focused tests:           4 suites / 57 tests PASS
Web full suite:                  117 suites / 1920 tests PASS
                                 (includes CoreSurveyDetailView PASS — the prior
                                 phase's parallel-worker flake did NOT reproduce;
                                 full suite is green this phase)
API full suite:                  272 suites / 4292 tests PASS
API typecheck:                   PASS (tsc --noEmit, 0 diagnostics)
Web typecheck:                   PASS (tsc --noEmit, 0 diagnostics)
Lint:                            kpi-runtime scope: PASS.
                                 NOT RUN as a green gate: repo-wide eslint reports
                                 4595 PRE-EXISTING errors at baseline (no-explicit-any
                                 class, unrelated to this phase; the same class as the
                                 standing prettier caveat)
Prettier:                        PASS for all 25 files of this phase (check + write).
                                 Repo-wide baseline noise NOT chased (standing caveat)
git diff --check:                PASS (no whitespace errors)
API build:                       PASS via `nest build` (fresh dist). The `npm run build`
                                 wrapper's `rimraf` step fails on this Windows host with
                                 EPERM on Prisma's locked `query_engine-windows.dll.node`
                                 (platform/tooling issue, unrelated to KPI code)
Web build:                       PASS (compiled successfully, 69/69 static pages)
```

The `CoreSurveyDetailView` caveat is reported exactly: this phase's full web suite
ran `1920/1920 PASS` — the previous `1900/1901` failure did not reappear, and the
file itself reports PASS in the run. No KPI file is involved in that test either way.

## 13. Definition of Done — how each clause was met

- five approved KPIs support governed historical calculations — unit tests for
  all five (service/history specs) + real-runtime E2E for KPI-001/002;
- period semantics explicit — `completed` on `KpiPeriod`, Jalali/Tehran/monthly
  boundaries preserved, comparison anchored server-side;
- completed-period behaviour correct — past months `true`, current month
  `false` (unit + E2E), labelled «در جریان» everywhere;
- unavailable values never zero-filled — `EMPTY_COHORT`/`EMPTY_DENOMINATOR`
  carried, gaps in the chart, counted in the table;
- percentage-point vs relative never confused — server fields +
  `kpiComparisonSummary` + the E2E 0%-previous case;
- no fake trends — segments break on gaps, single dots do not join, all-absent
  series show an honest table;
- charts have accessible equivalents — figcaption summary, `aria-label`, real
  table;
- cards expose comparison context — `comparisons` on `GET /kpis`, delta +
  period on every card, neutral styling;
- detail explains change in human language — summary sentence, zero-note,
  partial-note, always-present no-target sentence;
- guides explain comparison semantics — the detail «راهنمای شاخص» answers every
  §28 question, including the explicit
  «هدف یا آستانه عملکردی برای این شاخص تعریف نشده است.»;
- drill-down works where safely supported — governed hrefs, real entitled route
  verified, unmappable period honestly omitted;
- candidate/blocked KPIs remain non-executable — 404 on history, unit + E2E;
- tenant isolation preserved — E2E cohort-count proof in both directions;
- no performance-colour semantics invented; no targets/thresholds invented; no
  alerting; no snapshot warehouse without evidence;
- existing KPI runtime + Reporting remain green — full suites rerun.

## 14. Git record (commits of this phase)

```text
Implementation commit:  4b26a23096486b5fd47422c2181ceb36136af256
                        feat(reporting): add kpi historical intelligence
Documentation commit:   8c176396932ad8df0f509d960218a8195f38f5db
                        docs(reporting): record kpi historical intelligence
HEAD:                   8c176396932ad8df0f509d960218a8195f38f5db
Working tree clean:     YES (at documentation commit)
```

The implementation commit carries 23 files (API runtime + Web UX + E2E). The
documentation commit carries the phase report and the KPI-CATALOG addendum
(historical & comparison semantics + preamble truthfulness fix).

traceability, no fabricated query parameter. Record-level traceability is not
claimed.

Pure module `kpi-runtime.comparison.ts` — arithmetic over two already-governed
values, no seam, no clock, no rounding:

- either side unavailable → `NOT_AVAILABLE` with its own reason;
- previous value zero → `relativeChange` is `NOT_AVAILABLE`
  (`PREVIOUS_ZERO_RELATIVE_UNAVAILABLE`), the absolute delta still answered;
- percentage KPIs answer `percentagePointChange` as the PRIMARY delta
  (70% → 80% is +10 points, never the primary +14.29%); elapsed KPIs carry no
  point delta (`null`, never `0`);
- `direction` is MATHEMATICAL movement only, never a performance verdict:
  `interpretation.performance` stays `NOT_ASSESSED` and no green/red may be
  derived (§16, §41).

`changeDisplay` projects the primary delta through the SAME `toDisplay` the
current value uses, so no screen converts seconds to hours on its own.

## 5. Formulas — the same path, stated once (§4, §11)

No formula was duplicated. Per period, history resolves the month and calls the
existing `compute`: `MEAN_ELAPSED` via `evaluateMeanElapsed` (null/non-instant
excluded, stale `to < from` excluded rather than floored, empty population →
`null`); `RATIO_PERCENT` via `evaluateRatioPercent` over the seam's bounded
summary (empty denominator → `null` per `zeroDenominator: 'NOT_AVAILABLE'`).
Trends use exact governed values, never rounded display conversions (§23).
