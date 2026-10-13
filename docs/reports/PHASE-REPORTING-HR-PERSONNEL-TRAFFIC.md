# Phase Report — Reporting Fourth Vertical Slice: HR Personnel Traffic Report

> **گزارش تردد پرسنل**
>
> Implementation commit: **`c6d5cc6`** — `feat(reporting): add hr personnel traffic report`.
> Documentation commit: **`81c7842`**.
> Baseline before this phase: `d8651a1` (reporting documentation commit, working tree clean).

## 1. What this phase is

The **fourth end-to-end Reporting capability** in the ERP, mirroring the Financial, Commerce and Production slices:

```text
HR attendance register (hr_db, Phase 51-HR-3)
        ↓
HR-owned reporting read contract (read-only, tenant-scoped)
        ↓
Reporting application/use case
        ↓
Reporting API (three GETs)
        ↓
Reporting Web UI/UX (register + summary + read-only detail + flow)
        ↓
architecture guards + unit tests + real-runtime e2e
```

One management question, answered read-only:

> **What traffic did we record — who punched in on which day, from when to when, and was each row recorded by a device or as a manual correction?**

One report row = **one `Attendance` register entry** (`Attendance_tenantId_employeeId_workDate_source_key`: one employee, one work day, one source). The report deliberately does NOT model attendance status, lateness, absence, duration, hours, overtime or presence percentages: `prisma/hr/schema.prisma` and `AttendanceService` state that those are computed verdicts that must never be stored (§13), so the schema has no such columns and this report invents none.

## 2. A. Preflight evidence — files and contracts inspected

| Area                                      | What was read                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR attendance capability                  | `modules/hr/attendance/` — `attendance.controller.ts` (route chain, `hr.attendance.read/manage` remits), `attendance.service.ts` (day derivation, explicitly no stored status — §13), `attendance.repository.ts` (tenant-first `listPage`/`findById`, no `findUnique`), `dto/attendance.dto.ts` + `dto/hr-query.dto.ts` (from/to/dateKey/source/search filters) |
| HR data model                             | `prisma/hr/schema.prisma` — `Attendance` (`workDate` `@db.Date`, `dateKey`, `clockIn`/`clockOut`, `source AttendanceSource`, `reason`, composite tenant key) and `Employee` (`employeeCode`)                                                                                                                                                                    |
| HR vocabulary                             | `AttendanceSource` = `DEVICE \| MANUAL` (`20260918140000_hr_attendance/migration.sql`); **no attendance status enum exists anywhere**                                                                                                                                                                                                                           |
| HR audit                                  | `hr.constants.ts` (`HR_AUDIT_RESOURCE.ATTENDANCE = 'hr.attendance'`, actions `create/update/adjust`), `hr-audit.gateway.ts` (write-only before this phase)                                                                                                                                                                                                      |
| HR guards                                 | `hr-isolation.spec.ts` (sole audit-seam file, tenant-scoped reads, entitlement-at-boundary), `hr-application-boundaries.spec.ts` (layer inventory, rules 5/6)                                                                                                                                                                                                   |
| Existing personnel-traffic implementation | `HrTrafficReportView.tsx` (Phase 51-HR-2F, `/admin/hr/traffic-report` — proves the bounded-window report already reads `GET /hr/attendance`; its own header documents «NO NEW ENDPOINT» and «no stored status ⇒ no fabricated summary»)                                                                                                                         |
| Reporting precedents                      | the three completed slices' contract/reader/module/DTO/service/controller + `reporting-isolation.spec.ts`, `reporting.module.spec.ts`, sibling e2e specs                                                                                                                                                                                                        |

## 3. Preflight decision gate

| Gate question               | Answer, from evidence                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Source capability**    | The `Attendance` register (51-HR-3): `AttendanceRepository` + `AttendanceService` + `AttendanceController`.                                                                                                                                                                                                                                      |
| **B. One report row**       | One `Attendance` row — the register's own identity (tenant, employee, work day, source). Chosen from the unique index, not by convention.                                                                                                                                                                                                        |
| **C. Authoritative date**   | `workDate` (Gregorian `@db.Date`, derived server-side from `clockIn`) plus the server-derived Jalali `dateKey`; `clockIn`/`clockOut` are the ISO instants of the punch window. No timestamp was manufactured.                                                                                                                                    |
| **D. Authoritative states** | There is no attendance state. The only closed vocabulary is `AttendanceSource` = `DEVICE \| MANUAL`. The report uses exactly that and nothing else — no Reporting-specific status, no present/late/absent.                                                                                                                                       |
| **E. Summary**              | `total` + per-`source` counts only — one bounded `groupBy` over the same predicate, zero-filled over the two-member set. No rate, duration or percentage (no schema support).                                                                                                                                                                    |
| **F. Detail**               | Yes — `AttendanceRepository.findById(tenantId, id)` (tenant-scoped `findFirst`) supports meaningful detail: person code, both calendars, the window, the source, the correction reason.                                                                                                                                                          |
| **G. Timeline**             | Yes — authoritative: HR writes every register act to the ONE platform trail as `resource: 'hr.attendance'` (`create`/`update`/`adjust`) through `HrAuditGateway.record`. The gateway was **write-only**, so the smallest source-owned read capability was added: a `read()` passthrough (§4). No event is inferred from `createdAt`/`updatedAt`. |

**Architectural case applied:** Case 2 (repository sufficient for list/detail) + Case 3 in its narrowest form (two smallest source-owned reads added: `AttendanceRepository.countBySource` for the summary, `HrAuditGateway.read` for the timeline). No generic attendance framework, no new HR endpoint, no HTTP loop-back.

## 4. Source seam

| Item            | Value                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files           | `apps/api/src/modules/hr/reporting/hr-personnel-traffic-reporting.{contract,reader,module}.ts` + `hr-personnel-traffic-reporting.reader.spec.ts`                                                            |
| Token           | `HR_PERSONNEL_TRAFFIC_REPORTING_READER` = `'HrPersonnelTrafficReportingReader'`                                                                                                                             |
| Reader          | `HrPersonnelTrafficReportingReaderService` — implements exactly the four contract reads; delegates to `AttendanceRepository` + `HrAuditGateway`                                                             |
| Ownership       | HR owns contract + reader + module. Reporting imports only the contract path — never a repository, service, controller, Prisma client, generated client or DTO.                                             |
| Module          | `HrPersonnelTrafficReportingModule` imports `HrPrismaModule` + `PlatformAuditModule`; provides gateway/repository/reader/token; **exports the token only** — no write surface is reachable by construction. |
| Tenant behavior | `scope.tenantId` is the first argument of every repository/audit call; detail/timeline use tenant-scoped `findFirst`, so a foreign id is `null` → 404, indistinguishable from missing.                      |

**Shared day-window implementation:** `attendance-window.ts` — the register's `resolveDayBounds`/`parseGregorianDay` extracted VERBATIM so the register and the report resolve «which days?» through one implementation (a contradictory window is the SAME 400 on both surfaces). `AttendanceService` now delegates; its behavior and messages are unchanged (its spec stays green). `hr-attendance-source.ts` re-states the closed `DEVICE|MANUAL` set as a pure module (Reporting may not import owner DTO internals); `hr-attendance-source.spec.ts` pins the two spellings equal to `HR_ATTENDANCE_SOURCES`, member for member and in order.

**Smallest source-owned additions:** `AttendanceRepository.countBySource` (one `groupBy`, shared `buildWhere`) and `HrAuditGateway.read` (a passthrough of `AUDIT_PORT.read`, mirroring `ProductionAuditGateway.read`; the gateway remains the ONLY file importing the platform audit contract — both HR guards still pass unmodified).

## 5. Contract, projection, filters

**Row whitelist — exactly 8 fields:** `id`, `employeeCode`, `workDate` (`YYYY-MM-DD`,
never an instant), `dateKey` (`YYYY/MM/DD` — the server's own derivation), `clockIn`
(ISO instant, offset preserved), `clockOut` (ISO instant, or `null` while the day is
open — a fact, not a missing value), `source`, `reason` (`null` on device rows).

**Never crosses the seam:** `tenantId` (the scope is a method parameter, never a row
field), `employeeId` (the raw personnel uuid has no display contract and the report
never navigates into an HR screen — `employeeCode` is the person identity, the same
reason the sibling contracts withhold actor ids), `createdAt`/`updatedAt`, the employee
relation wholesale, every Prisma/storage shape, and any status/duration/rate field —
none exists, and a spread-through would publish the next column the schema gains
without this file ever deciding it is safe.

**Filters — each with authoritative field → validation → repository → tenant → API →
UI → tests:**

| Filter                     | Authoritative source            | Validation                                                                                       | Repository behavior                                 |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `dateKey` (one Jalali day) | server-derived `dateKey` column | `HR_JALALI_DATE_KEY_PATTERN` at the DTO; real-date + exclusivity in `attendance-window.ts` (400) | converted ONCE to `from = to` bounds on `work_date` |
| `from`/`to` (Gregorian)    | `workDate` `@db.Date`           | `HR_ISO_DATE_PATTERN` at the DTO; `to < from` refused (400)                                      | inclusive `gte`/`lte` on the indexed column         |
| `source`                   | `AttendanceSource` enum         | `@IsIn(HR_PERSONNEL_TRAFFIC_SOURCES)` — an unknown member is 422 at the boundary                 | equality predicate                                  |
| `search`                   | `Employee.employeeCode`         | `MaxLength(200)`                                                                                 | tenant-pinned relation, case-insensitive `contains` |
| `page`/`pageSize`          | HR's own page window            | `1..HR_MAX_PAGE_SIZE` (100) at the DTO; clamped again in the reader                              | `skip`/`take`, echoed back                          |

**Not implemented (each with a repository-based stop):** `employeeId` filter (a raw
personnel uuid with no reporting display contract — deferred until a display or
navigation contract exists); any attendance status/lateness/overtime filter (the schema
has no such column, so a parameter would be a filter that matches nothing); an
unbounded «all days» mode (a full-register scan — the register's own report screen
refuses it too).

## 6. Summary, detail, timeline

- **Summary:** `{ total, bySource: { DEVICE, MANUAL } }` — one
  `AttendanceRepository.countBySource` `groupBy` over the **same** `buildWhere`
  predicate the page read uses (factored exactly like
  `PurchaseRepository.buildDocumentWhere`, so page and counts can never disagree),
  zero-filled over the closed set. Same tenant, same filter, same request as the
  list — the service reads both in parallel and returns one answer.
- **Detail:** the same 8-field projection; an open day renders `clockOut: null` as a
  fact; a correction renders its stored `reason`.
- **Timeline: implemented — authoritative.** Existence is proved tenant-scoped first
  (foreign/unknown → 404 before the audit port is touched), then the SAME platform
  trail HR's register writes (`resource: 'hr.attendance'` bound to the row) through
  `HrAuditGateway.read`, projecting the siblings' seven-field whitelist (`id`,
  `action`, `actorId`, `success`, `reason`, `changedFields`, `createdAt`). A rejected
  read re-throws the platform's closed code; the Reporting service maps
  `AUDIT_READ_FAILED` → 503 — an outage never renders as an empty history. No event is
  ever inferred from a timestamp. E2E observed the real split: `create`+`update` on a
  closed device row, the lone `adjust` on the correction row (the `create` belongs to
  the DEVICE row's id — the audit binds an act to the row it addressed, and the test
  pins that split rather than merging it away).

## 7. Security

- **Authentication:** the global `JwtAuthGuard` on all three routes; no token → 401
  (proven by e2e).
- **Authorization:** the existing read remit `hr.attendance.read` on every handler.
  A user without it gets 403 on list, detail and timeline (proven by e2e). No
  `reporting.*` permission was invented — a second permission string would be
  authorization theatre.
- **Entitlement:** `@RequiresModule('hr')` and deliberately NO `@RequiresFeature` —
  `HR_FEATURE` carries only `leave` and `mission`; HR's own attendance routes declare
  the module requirement alone, and a decorator naming an attendance feature that no
  provisioning migration seeds would 403 a tenancy HR itself serves. The controller's
  own spec asserts the module decorator AND refutes the feature decorator.
- **Tenant isolation:** the tenant comes only from the server-resolved request
  context (`resolveReportingActor`), never a query/body/param field (a sent `tenantId`
  is 422 via the global whitelist pipe). Every source query receives the scope first;
  detail/timeline stay tenant-scoped through `findById`. E2E proves both directions:
  A never sees B's row (404, indistinguishable from missing), B reads exactly its own.

## 8. API, UI, guards

**API — three read-only GETs, no writes:**

```text
GET /api/v1/reporting/hr/personnel-traffic                (page + summary)
GET /api/v1/reporting/hr/personnel-traffic/:id            (one report row)
GET /api/v1/reporting/hr/personnel-traffic/:id/timeline   (read-only flow)
```

`POST`/`PATCH`/`DELETE` on the surface are 404 (proven by e2e). Data correctness: the
sent `+03:30` instants read back as the same moments in UTC (`04:30Z` — a moment
stripped of its offset would be a different moment); `workDate` reads as a `YYYY-MM-DD`
day in UTC (never midnight-UTC ambiguity); nothing is rounded, inferred or re-zoned.

**UI — Persian-first, RTL, at `/admin/reporting/hr/personnel-traffic` (+ `[id]`):**

- Identity: «گزارش تردد پرسنل» under the «گزارش‌گیری» heading (no h1); the shell
  header resolves through a new `PAGE_TITLE_ALIASES` entry — deliberately no rail row
  (a platform-navigation decision, the three precedents).
- Filters: the window shape selector (یک روز شمسی via the existing
  `CoreJalaliDatePicker` seeded from the SERVER's `/calendar/today` — never
  client-computed — or a Gregorian از/تا pair), made mutually exclusive structurally
  so the API's 400 cannot be built; the source select (the closed vocabulary), and the
  employee-code search. No employee-uuid field. A window prompt renders until a window
  exists — no request and never a fake «۰ رکورد».
- Summary: only the server-computed chips (همه + per-source), which ARE the source
  filter; the component owns no counting code.
- Table: employee code (detail link), Jalali day + weekday, punch in/out times,
  source badge (label + tone) — and nothing else (no status, no duration, no rate).
- Detail: person, day in both calendars, window, source, correction reason, back link;
  the authoritative flow below (ثبت/به‌روزرسانی/اصلاح, fetched on demand, outage →
  retry). Raw actor ids are never rendered.

**Architecture guards — updated, never weakened:**

- `reporting-isolation.spec.ts`: exact 14-file source list, module imports pin the
  fourth seam, the decorator chain (module → guards → roles on all handlers; feature
  required on the three feature surfaces, deliberately absent on HR's), the
  per-source remit matrix now covering `HR_ATTENDANCE_READ`, the approved-seam
  suffixes (`../hr/reporting/`, `hr.constants`, the two pure attendance modules)
  with absolute `modules/hr` paths still refused, per-file no-mutation + vocabulary
  gates extended to all four surfaces.
- `reporting.module.spec.ts`: an `HrPrismaService` stub (never opens the fourth
  database), the HR token resolves and is NOT re-exported, the fourth controller +
  service mount.
- HR guards (`hr-isolation`, `hr-application-boundaries`): **unmodified and green** —
  the seam was designed around them: the reader is not a `.service.ts` (rule 5
  untouched), the module has no controller (entitlement-at-boundary untouched), the
  gateway remains the ONLY importer of the platform audit contract, no new repository
  file, no `tenantId`-less read, no timer, no DTO in `/dto/`.

## 9. Verification — actual executed results

| Check                                                                                                                     | Result                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| HR seam unit tests (reader incl. projection/tenancy/filter/window clamp/zero-fill/404/timeline)                           | **10/10 PASS** (plus `hr-attendance-source` vocabulary spec 3/3)                                                                               |
| Reporting unit tests (service scope/pass-through/summary/404/503/read-only + controller routes/remit/no-feature/no-write) | **13/13 PASS**                                                                                                                                 |
| HR guards (`hr-isolation` + `hr-application-boundaries`) + HR attendance suites                                           | **green** (HR suite: 41 suites / 540 tests — included in full run)                                                                             |
| Reporting guards (`reporting-isolation` 17/17 + `reporting.module.spec` + architecture/ai/runtime boundaries)             | **green**                                                                                                                                      |
| Full API unit suite                                                                                                       | **261 suites / 4157 tests PASS** (baseline 258/4106)                                                                                           |
| HR Personnel Traffic E2E (real runtime, HR HTTP writes → Reporting reads)                                                 | **19/19 PASS**                                                                                                                                 |
| Financial/Commerce/Production Reporting E2E (regression, both prior slices green)                                         | **3 suites / 41 tests PASS**                                                                                                                   |
| Web focused (`components/reporting/__tests__`, incl. the 2 new HR suites)                                                 | **7 suites / 81 tests PASS**                                                                                                                   |
| Web full suite                                                                                                            | **111 suites / 1842 tests PASS** (one transient survey-suite flake in a single intermediate run; green in isolation and in the final full run) |
| API typecheck (`tsc --noEmit`)                                                                                            | **PASS**                                                                                                                                       |
| Web typecheck (`tsc --noEmit`)                                                                                            | **PASS**                                                                                                                                       |
| Lint (API touched files)                                                                                                  | **PASS**; web ESLint could not run — pre-existing config crash (`Converting circular structure to JSON` on the checked-in `.eslintrc.js`)      |
| Prettier (touched files)                                                                                                  | **PASS**                                                                                                                                       |
| Web build (`next build`)                                                                                                  | **PASS** — «Compiled successfully», both new routes emitted                                                                                    |
| `git diff --check`                                                                                                        | **PASS**                                                                                                                                       |

No historical result is reported as current: the numbers above are the final-state
runs (unit post-format, full API ×2, web focused + full, typechecks, build, e2e).

## 10. Known limitations and deferred capabilities

| Classification              | Item                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **intentionally omitted**   | `employeeId` in the projection and as a filter (raw uuid, no display/navigation contract — deferred until one exists); rail navigation row (platform-navigation decision, all four precedents); org-unit/position enrichment (HR's own detail domain, not the register's); any attendance/lateness/overtime/status analytics (§13 — the schema cannot carry them, and the phase brief closes the door) |
| **explicitly out of scope** | payroll, compensation, employee performance, utilization, forecasting, KPI frameworks, generic analytics, AI insights, cross-domain dashboards                                                                                                                                                                                                                                                         |
| **future**                  | per-row employee display names (needs a Reporting-reachable display contract — HR identity stays behind `UserDirectoryContract`); an unbounded-window summary for very large tenancies (needs a source-side aggregation contract first)                                                                                                                                                                |

## 11. Commits

- Implementation commit: **`c6d5cc6`** — `feat(reporting): add hr personnel traffic report` (28 files: HR seam, register predicate/`countBySource`, audit `read()`, Reporting module/controller/service/DTO, web workspace + routes, E2E; guards widened in the same change).
- Documentation commit: **`81c7842`** — `docs(reporting): record hr personnel traffic reporting slice` (this file).

The governing invariant held, a fourth time: **ONE REAL REPORT > A SPECULATIVE FRAMEWORK.** Evidence → narrow source-owned contract → tenant-safe read → Reporting API → polished Persian RTL UI → executable boundary guards → real-runtime E2E → traceable commits. The HR domain decided the projection (eight fields, two sources, one shared day window, one bounded groupBy) — not a template borrowed from a sibling.
