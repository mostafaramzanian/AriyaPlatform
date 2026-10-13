# Phase REPORTING-VISUALIZATION-EXPORT — Reporting Visualization & Export Foundation

**Baseline:** `5351b02` (working tree clean before this phase).

---

## 1. Evidence review — the four real reports, side by side

Before any abstraction was written, every completed Reporting slice was read end to end
(route → DTO → service → source-owned seam → projection → screen):

| Area                | Financial (eb71005)                                                                 | Commerce (6d2723e)                      | Production (ed34f6b)                      | HR (c6d5cc6)                                               |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Route               | `reporting/financial/check-requests`                                                | `reporting/commerce/purchase-documents` | `reporting/production/boms`               | `reporting/hr/personnel-traffic`                           |
| Handlers            | list, `:id`, `:id/timeline`                                                         | same three                              | same three                                | same three                                                 |
| Guards              | entitlement (module+feature) + JWT + `financial.check.read`                         | entitlement + JWT + `commerce.read`     | entitlement + JWT + `production.bom.read` | entitlement (module only) + JWT + `hr.attendance.read`     |
| List DTO            | `status` (closed ordinals), `search`, page window                                   | `status` (6), `search`, page window     | `status` (4), `search`, page window       | `from`/`to`/`dateKey`, `source` (2), `search`, page window |
| Page shape          | `{items,total,page,pageSize,summary}`                                               | identical                               | identical                                 | identical                                                  |
| Summary             | `{total, byStatus}`                                                                 | `{total, byStatus}`                     | `{total, byStatus}`                       | `{total, bySource}`                                        |
| Summary computation | run in parallel with the page, SAME query + tenant, zero-filled over the closed set | same                                    | same                                      | same                                                       |
| Row projection      | explicit 12-field whitelist                                                         | explicit 12-field whitelist             | explicit 10-field whitelist               | explicit 8-field whitelist                                 |
| Screen structure    | heading → identity → filters → summary strip → table → pagination                   | identical seven steps                   | identical                                 | identical (window-first)                                   |
| Formatting          | Persian labels from the source vocabulary, fa-IR dates                              | `commerce-labels.ts`                    | `production-labels.ts`                    | `hr-api.ts` (Jalali `dateKey`, Tehran times)               |

**Shared presentation/export infrastructure: none existed.** Verified by dependency
scan: `exceljs` / `docx` / `xlsx` / `jszip` absent from both `package.json` files and
from the hoisted `node_modules`; no chart library; no export route, download helper or
document writer anywhere in the workspace (only upload MIME allowlists named the
formats).

### Commonality table — what is genuinely common

| Concept                                    | 4/4?                                   | Verdict                                                                       |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| Report identity (Persian title)            | yes (module headers + screens)         | per-report constants, not a registry                                          |
| List+summary envelope                      | yes, byte-identical                    | already shared by contract — no new type                                      |
| Summary = `{total, Record<string,number>}` | yes (`byStatus`×3, `bySource`×1)       | chart INPUT — not a metric layer                                              |
| Filter state                               | shapes differ (ordinals vs day window) | NO shared filter model — reuse each DTO verbatim                              |
| Pagination window                          | yes (per-source ceiling)               | shared scope lines                                                            |
| Row columns                                | different per report                   | per-report presentation modules                                               |
| Date/number rendering                      | same conventions, different columns    | shared display helpers (fa-IR date, Tehran time, Persian digits, UTC weekday) |
| Charts                                     | implemented nowhere                    | one bucket helper + one bar component                                         |
| Export metadata (title/time/filters/scope) | would be identical for all four        | shared `ReportExportDocument`                                                 |

**Admitted abstraction:** one presentation/export document model + two writers + shared
display helpers + (web) one bucket helper and one bar component.
**Refused:** report-definition DSL, metric layer, shared filter model, server chart
routes, dashboard/registry/KPI vocabulary (still isolation-guarded).

---

## 2. Architecture — the data path that shipped

```text
Source Domain (Finance / Commerce / Production / HR)
        ↓  approved narrow read seam (unchanged)
Reporting service.list()  →  rows + summary   (the ONE authoritative read pair)
        ↓
per-report presentation module (title, filters, scope, summary, columns, rows)
        ↓
ReportExportDocument (the shared presentation model)
        ├── → xlsx writer (exceljs) → StreamableFile (exact MIME + ASCII attachment name)
        └── → docx writer (docx)    → StreamableFile (exact MIME + ASCII attachment name)

Web:  summary (server)  → buildReportChartBuckets → ReportSummaryChart (RTL bars)
Web:  current query     → *ReportExportPath       → downloadReportExport (blob)
```

Routes added under the repository's trailing-verb convention (mirroring `…/download`):

```text
GET /api/v1/reporting/financial/check-requests/export/{xlsx,docx}
GET /api/v1/reporting/commerce/purchase-documents/export/{xlsx,docx}
GET /api/v1/reporting/production/boms/export/{xlsx,docx}
GET /api/v1/reporting/hr/personnel-traffic/export/{xlsx,docx}
```

Every export route lives on the SAME controller (same class-level entitlement + JWT
guards), carries the SAME `@Roles` remit as its list, and validates with the SAME DTO
class. **Scope equality is structural, not conventional:** `exportReport()` calls the
class's own `list()` with the caller's query, so the file, the table, the summary and
the bars are one answer rendered four ways — no second query, no re-interpretation, no
path to a source context's persistence (the writers see only the document model).

---

## 3. Visualization

- **Type shipped:** horizontal bar (RTL), dependency-free — four denominations do not
  justify a chart library, and the repository's own audit reached the same conclusion
  (raw primitives instead of admitting one).
- **Data source:** the existing `summary` the API already returns with every list — no
  new endpoint, no second query, no client-side counting. The shared bucket helper only
  ARRANGES: vocabulary order, zero-fill, unknown keys kept raw at the end (shown, never
  hidden, never invented).
- **Enabled:** all four reports — Financial (status distribution), Commerce (status),
  Production (status), HR (source distribution).
- **Semantics:** source = report summary; aggregation = the database counts over the
  SAME filtered population as the table; ordering = each report's closed vocabulary;
  units = record counts; empty = a truthful Persian message, never a bare axis and never
  a fake zero dataset. Every row carries its Persian label and Persian-digit count as
  TEXT, so colour and hover are decoration; the report table remains the detailed
  accessible representation.

```text
Report                Chart   XLSX   DOCX
-----------------------------------------------
Financial             YES     YES    YES
Commerce              YES     YES    YES
Production            YES     YES    YES
HR                    YES     YES    YES
```

Every cell is YES with no exceptions: every report's result is tabular, its summary is
grouped over a closed vocabulary, and none of them needed a format-specific refusal.

---

## 4. Export

### XLSX (exceljs 4.4.0)

One RTL sheet per report, «metadata above, data below» as a contract (the tests locate
the header row BY VALUE, never by row number):

```text
<report title>                    (bold)
زمان تولید   | <Jalali date — Tehran time>
صفحه         | ۱ از ۳              ← scope lines
ردیف‌های این خروجی | N
مجموع (همه‌ی صفحات) | <filtered total>
<filter label> | <filter value>    (per applied filter; «—» when unfiltered)
خلاصه                              (bold)
<bucket label> | <count> …         ← the same summary the strip shows
(blank)
<localized headers>                ← bold header row, light fill
<data rows>                        ← typed cells
```

- `kind: 'number'` cells are real numbers (`1260`, not `"1260"`) with a thousands
  format — Excel/LibreOffice can sum them.
- An unpriced document (`totalAmount: null`) is an EMPTY cell — never a 0 that would
  claim free goods (the contract's own rule).
- Dates render through fa-IR in the NAMED application zone (`APP_TIME_ZONE`,
  `Asia/Tehran`) — a reading, never a mutation; a `null` time is «—», never 00:00.

### DOCX (docx 9.8.1)

```text
<title>                        bold, right-aligned, bidirectional
زمان تولید: …
<scope lines>
<filter lines>                 (or «فیلترها: —»)
خلاصه
<summary lines>
جدول داده‌ها
┌ localized headers ┐          ← the ONE table in the document
│ typed rows        │
└───────────────────┘
(when empty) برای این فیلترها ردیفی وجود ندارد.
```

Every paragraph is `bidirectional: true` + right-aligned; numbers are Persian digits;
`Arial` default run; NO fabricated narrative, NO embedded drawing (deferred — a second
chart implementation purely for Word was refused).

### Filters, authorization, size, naming

- **Filters:** the export accepts exactly the list DTO — same class, same validators,
  no second filter model, no duplicated rules.
- **Authorization:** JWT (401), the source read remit (403 — `financial.check.read`,
  `commerce.read`, `production.bom.read`, `hr.attendance.read`), the same module/
  entitlement gates, tenant from `resolveReportingActor` only. E2E asserts 401, 403 and
  cross-tenant files (row parity with the caller's own list — a leak would change the
  count).
- **Size:** synchronous, bounded by each DTO's page ceiling (100) — no queue, no async
  job, no cloud storage; documented rather than built, because current report sizes
  give no evidence for more.
- **Naming:** `<report-slug>-<YYYY-MM-DD>.<ext>` — ASCII, constant-shaped; no tenant,
  no row id, no search text can reach it. Exact OpenXML MIME + `attachment` disposition,
  both asserted by E2E.

### Dependency decisions

- `exceljs@4.4.0` + `docx@9.8.1` added to `apps/api` — both PROVEN absent workspace-wide
  before admission (lockfile + `node_modules` scan), and imported ONLY by
  `export/*.writer.ts`. The isolation suite's approved-package list grew by exactly
  these two, with the justification in its header.
- No chart library, no zip library: the tests read OOXML themselves (~40 lines over
  `zlib.inflateRawSync` + central-directory walking), so no third document dependency
  was admitted merely to read test output back.

---

## 5. Filter consistency

```text
ONE reportQuery object (web)
   ├── → list fetch        (the request the table renders)
   ├── → chart buckets     (from THAT fetch's `summary` — same response, same scope)
   └── → export path       (`…/export/xlsx?<the same query string>`)

Server side:
exportReport(query) → this.list(query) → same rows + same summary → document → file
```

The screen builds the query ONCE (extracted into `reportQuery`) and hands the same
object to all three consumers, so the filter state cannot be re-read per surface. E2E
pins the equality from the outside: the file's parsed rows are compared against the
LIST route's rows for the same query — count AND content — for every report.

A row-count mismatch between file and table is treated as a release-blocking defect,
and the parity assertions are written so that a filter drift would produce exactly that
failure.

---

## 6. Export size, performance, limitations

- Exports are **synchronous** and cover the CURRENT page window (≤ 100 rows by each
  DTO's ceiling) with the filtered total stated in the metadata — the file says what it
  holds instead of implying the whole filtered set.
- Reads per export = the reads per list (page + summary, in parallel) — no duplicate
  summary calculation, no N+1, no full-dataset load.
- Deferred with evidence, not oversight: whole-report (all-pages) export, async export
  jobs, PDF, embedded charts in DOCX, line/donut charts (no report has a time series or
  a part-to-whole question its summary does not already answer as bars).

---

## 7. Tests added

| Suite                                             | What it proves                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `presentation/report-export-presentation.spec.ts` | model helpers (ASCII naming, Persian digits, named-zone dates, scope lines) + all four builders mirror their result: columns, rows, filters, zero-filled summaries |
| `export/report-export.spec.ts`                    | XLSX re-opens (RTL view, headers by VALUE, numeric cells, truthful empty report) and DOCX unzips (title, ONE table, `w:bidi`, Persian text, no tenant/row-id leak) |
| `report-export-labels.spec.ts`                    | the export's Persian status/source words EQUAL the web's label modules (read as text across the app boundary) — one wording per concept                            |
| 4× controller specs                               | exactly five GET handlers, all on the same remit, no mutating decorator                                                                                            |
| 4× service specs                                  | `exportReport` = same list path + same query + exact MIME/ASCII name; fails closed (403, no reader call) without a tenant                                          |
| `ReportExportButtons.spec.tsx`                    | Persian labels, current-scope path, disabled + `aria-busy` while generating, Persian error alert, keyboard operation                                               |
| `ReportSummaryChart.spec.tsx` + `report-chart.ts` | vocabulary ordering, zero-fill, unknown keys kept, truthful empty state, meaning carried as text                                                                   |
| 4× web view specs                                 | export actions + bars render for the loaded summary; scope needles narrowed to the vocabulary still forbidden (scheduling/AI/csv/pdf)                              |
| 4× reporting e2e suites                           | per report: parsed XLSX + parsed DOCX with row parity vs the list of the SAME query, exact MIME + attachment headers, 401/403, cross-tenant parity                 |

**Isolation guards were updated, not weakened:** file inventory +8 (4 presentation,
3 export/presentation-model), approved packages +2 (justification in the spec header),
`src/calendar` named as the seam for `APP_TIME_ZONE`, roles count 3→5, and the old
«no export route may exist» test replaced by «exactly five reads exist, no write verb,
no csv/pdf/other-format affordance».

---

## 8. Explicit non-goals (still forbidden, still guarded)

KPI engine/registry/targets · dashboards · report builder · scheduled reports ·
subscriptions · saved report definitions · user-defined formulas · ad-hoc SQL ·
semantic layer · cross-domain executive views · AI insights · predictive analytics ·
background export jobs · cloud object-storage workflows · line/donut charts without a
data-backed need · a second chart implementation for Word.

---

## 9. Final verification (executed on the final tree, current results)

```text
Reporting unit tests:     PASS — 13/13 suites, 112/112 tests (inside the full run below)
Visualization tests:      PASS (ReportSummaryChart + ReportExportButtons + report-chart)
Export unit tests:        PASS (presentation + writers + services + labels-drift specs)
Architecture guards:      PASS — reporting-isolation 17/17, arch-boundaries, policy
API full unit suite:      265/265 suites, 4202/4202 tests PASS
Financial Reporting E2E:  15/15 PASS
Commerce Reporting E2E:   15/15 PASS
Production Reporting E2E: 18/18 PASS
HR Reporting E2E:         21/21 PASS
Export E2E:               12 new tests (3 × 4 suites) — binary-parsed, real runtime,
                          counted inside the four suite results above
Visualization E2E:        N/A — no server chart surface; chart behavior covered by the
                          Web tests over the real summary shape
Web focused tests:        reporting suites PASS (9 suites incl. 2 new specs)
Web full suite:           113/113 suites, 1862/1862 tests PASS
API typecheck:            PASS (tsc --noEmit, 0 errors)
Web typecheck:            PASS (tsc --noEmit, 0 errors)
Lint (apps/api):          PASS for every changed file — 0 findings across
                          modules/reporting/** and test/reporting* (the repo-wide run
                          carries pre-existing findings elsewhere, unchanged by this phase)
Lint (apps/web):          NOT RUN — pre-existing tooling break, §10
Prettier:                 PASS (prettier --check over all touched files)
Build (apps/api):         PASS
Build (apps/web):         PASS
git diff --check:         PASS
```

---

## 10. Environment notes (honest, phase-scoped)

- A mid-phase `build` ran concurrently with full-suite Jest runs and lost the race for
  the Prisma engine DLL: `rimraf` deleted `src/generated/**` (git-ignored), `prisma
generate` then hit EPERM on the rename while stale Jest processes still held the
  loaded engine. The stale processes were cleared, `prisma:generate` re-run to restore
  the clients, and EVERY number in §9 was re-executed afterwards on the restored final
  tree — the interim failures are deliberately not counted as results.
- Two of the new files failed Web typecheck on first run (an unneeded React import; a
  narrower label-function type) — both fixed and re-run green, recorded rather than
  hidden.
- `Lint (apps/web)`: `next lint` was removed in Next 16, and a direct ESLint 8 run
  cannot load `.eslintrc.js`'s `eslint-config-next` (flat-config mismatch — pre-existing
  tooling debt, present before this phase). Reported NOT RUN with its reason rather than
  green-washed.

---

## 11. Git record (filled by the phase's hash-recording commit)

```text
Implementation commit: ac8da3e («feat(reporting): add visualization and export foundation»)
Documentation commit:  a6b6b1d («docs(reporting): record visualization and export foundation»)
Working tree clean:    YES (`apps/web/next-env.d.ts` was briefly toolchain-generated
                       by this phase's `next build`; deleted — never tracked, never staged)
```
