# HR Mission Request Status Report — گزارش وضعیت درخواست‌های مأموریت

Phase `REPORTING-HR-MISSION-REQUEST`.

## A. Baseline

- starting HEAD: `205a829` (`docs(reporting): record hr leave request reporting slice`)
- `git status --short` at start: only `?? apps/web/next-env.d.ts` (generated, untouched)
- prior reporting: Financial Check Request, Commerce Purchase, Production BOM,
  HR Personnel Traffic, Production BOM Change, HR Leave Request,
  KPI governance/runtime/historical
- previous environment issues carried forward: four sibling Reporting timeline-count
  E2E failures caused by pre-existing `AUDIT_CONTRACT_MISMATCH` audit-ingest drops,
  whole-project lint baseline broken, Prettier warnings on touched files

## B. Source Evidence (Mission vs Leave — the deltas this phase had to prove)

Aggregate: `MissionRequest` in `hr_db` — `apps/api/prisma/hr/schema.prisma`
(lines 1881+), `src/modules/hr/mission/{mission.repository,mission.service,
mission.controller}.ts`, `domain/mission-status.ts`.

### B.1 Lifecycle — SEVEN members, not Leave's four

From `domain/mission-status.ts` (`MISSION_REQUEST_STATUSES`, schema order):

```text
DRAFT ──> SUBMITTED | CANCELLED
SUBMITTED ──> IN_APPROVAL | CANCELLED
IN_APPROVAL ──> APPROVED | REJECTED | CORRECTION_REQUIRED | CANCELLED
CORRECTION_REQUIRED ──> SUBMITTED | CANCELLED
APPROVED, REJECTED, CANCELLED   (terminal, empty transition lists)
```

- NO `COMPLETED`: completion is not a request state (`mission-status.ts` header);
  post-approval reports are their own table (`MissionReport`), not part of this report.
- NO `PENDING`: the word Leave uses for «recorded» is Mission's `DRAFT` +
  `SUBMITTED`; using Leave's word here would be a lie about the source.
- Correction is NOT a new request (unlike Leave): `CORRECTION_REQUIRED →
  SUBMITTED` resubmits the SAME row with `submittedRevision` bumped and the prior
  approval instance superseded (`mission.service.ts resubmit/performSubmission`).
- The three sibling vocabularies are kept separate: `MissionApprovalStepStatus`
  (7 members, the flow's) and `MissionApprovalInstanceStatus` (5 members) never
  cross the report as request states.

### B.2 Submission branches (policy-gated)

`MissionService.performSubmission` → `MissionPolicyService.resolveDecision`:

- `AUTO_APPROVE` → `submitAndAutoApprove` (SUBMIT + APPROVE outbox in one tx,
  `approvedAt` stamped) — DRAFT ends APPROVED.
- `AUTO_REJECT` → `submitAndAutoReject` (SUBMIT + REJECT outbox, `rejectedAt` +
  `reasonCode`).
- `REQUIRED_APPROVAL` → markSubmitted → prepareInstanceSteps → openInstance →
  markInApprovalDurable (SUBMIT/RESUBMIT outbox) → `IN_APPROVAL`.
- NO published policy → `ConflictException` («No published Mission policy governs
  this request») — submit is REFUSED, which is why the flow/decision states are
  Prisma fixtures in E2E (§L).

### B.3 Cancel / correction / decision facts

- `cancel`: non-terminal → `CANCELLED`, `cancelledAt` stamped, reason audited on
  `hr.mission` (`mission.service.ts cancel`, transition gate
  `isMissionRequestRestatable`).
- correction / rejection / approval decisions live on the flow; the ROW carries
  `correctionReason` / `rejectionReason` as scalar columns (serializer comment in
  `serializeRequest`), `approvedAt`/`rejectedAt` as instants, and
  `submittedRevision` per submit/resubmit.

### B.4 Date semantics — INTERSECTION (same rule as Leave)

`MissionRepository.listRequestPage`: `startDate <= to AND endDate >= from` over
UTC-midnight `@db.Date` days — INTERSECTION with the mission's own inclusive
period, never creation/decision date. HOURLY missions (`startDate == endDate` +
`startTime`/`endTime < HH:MM>`) are day-intersection too: times are display, never
a filter dimension. Boundary behaviour proven by E2E: last-day window catches the
long row, single-day window on a HOURLY row catches exactly it, record ending on
the filter's first day and record starting on the filter's last day both match,
outside records do not, inverted window → 400, `2026-02-31` → 400 (read-back
round trip in the reader).

### B.5 Filters — the register's own five, nothing else

From `ListMissionRequestsQueryDto` (`dto/mission.dto.ts`): `employeeId`,
`status` (`@IsIn(MISSION_REQUEST_STATUSES)`), `durationMode`
(`@IsIn(MISSION_DURATION_MODES)`), `from`/`to` (`HR_ISO_DATE_PATTERN`),
`page`/`pageSize` (`HrPageQueryDto`, `HR_MAX_PAGE_SIZE = 100`). NO `search`
(never declared — the report answers 422 rather than silently matching
everything), NO `locationType`/`engagementType`/`destination` filter (stored but
unfiltered by the source — 422), NO `tenantId` (server-derived scope).

One predicate, one builder: `MissionRepository.buildRequestWhere` (NEW this
phase, extracted from the inline `where` so page/total/countByStatus cannot
disagree) feeds `listRequestPage` AND the new `countByStatus`.

### B.6 Status vocabulary — exact, seven, pinned

```text
DRAFT پیش‌نویس · SUBMITTED ارسال‌شده · IN_APPROVAL در گردش تأیید ·
CORRECTION_REQUIRED نیازمند اصلاح · APPROVED تأییدشده · REJECTED ردشده ·
CANCELLED لغوشده
```

Source of truth: `domain/mission-status.ts` (backend) ↔ `hr-mission-api.ts`
(`HrMissionRequestStatus`, web, ALREADY seven members — verified, NO drift found)
↔ `hr-mission-labels.ts` (total `Record`, tones: APPROVED=ok,
REJECTED/CORRECTION_REQUIRED=danger, rest=muted) ↔
`presentation/hr-mission-report.presentation.ts` (export map, pinned to the web
by `report-export-labels.spec.ts`).

## C. HR Reporting Seam

Token `HR_MISSION_REQUEST_REPORTING_READER` — the THIRD HR-owned seam (attendance,
leave, now mission), mirroring the five earlier seams:

- `src/modules/hr/reporting/hr-mission-reporting.contract.ts` — HR owns query,
  row whitelist, summary and timeline shapes and the reader interface; imports
  ONLY pure domain types (`mission-status`, `mission-options`).
- `src/modules/hr/reporting/hr-mission-reporting.reader.ts` — the adapter;
  reuses the SAME repository statements the register reads (`listRequestPage`,
  `findRequestById`) plus the new `countByStatus` (one bounded `groupBy` on the
  shared predicate builder); the `from`/`to` day arithmetic is the SAME round
  trip the register applies (`parseReportDay` read-back, inverted window 400).
- `src/modules/hr/reporting/hr-mission-reporting.module.ts` — narrow module
  (`HrPrismaModule` + `PlatformAuditModule`), exports the token ONLY.
- `MissionRepository` gained `buildRequestWhere` (extracted) + `countByStatus`;
  no business rule changed.
- Reporting imports ONLY `../hr/reporting/hr-mission-reporting.contract` +
  `hr.constants` + pure `hr/domain/mission-status` + pure
  `hr/domain/mission-options`; `reporting-isolation.spec.ts` group C was widened
  for exactly `domain/mission-status`, `domain/mission-date-time` and
  `domain/mission-options`, and group D pins `hr.mission.read`.

## D. Projection (explicit whitelist)

```text
id, employeeCode, durationMode, locationType, engagementType,
startDate, endDate, startTime, endTime, destination, description,
correctionReason, rejectionReason, submittedRevision, status, createdAt
```

Excluded (asserted in E2E): `tenantId`, `employeeId`, `approvedAt`, `rejectedAt`,
`cancelledAt`, `updatedAt`, `optionSelections`.

- `approvedAt`/`rejectedAt`/`cancelledAt` are decision INSTANTS the row carries;
  this report exposes the row's own REASONS + `createdAt` and answers «when
  decided» through the audit timeline instead — a column with no filter over it
  would invite a claim the wire cannot support.
- `startTime`/`endTime` are `HH:MM[:SS]` display values, NULL for DAILY.
- No duration-days, no cost, no rate: the schema stores none.

## E. Authorization

- Permission: `Permissions.HR_MISSION_READ` («hr.mission.read») on ALL five
  handlers — the register's own read remit (`mission.controller.ts` lines 63/70);
  no `reporting.*` invented.
- Entitlement: `@RequiresModule(HR_MODULE_ID)` + `@RequiresFeature(HR_MODULE_ID,
  HR_FEATURE.MISSION)` + `ModuleEntitlementGuard` + `JwtAuthGuard` — the SAME
  chain HR's mission reads declare.
- Missing tenant → 403 fail-closed (`resolveReportingActor`); missing/foreign row
  → 404 (never 403 — existence must not leak across tenants).
- E2E: anonymous → 401 on all five families; authenticated-without-grant → 403 on
  list/detail/timeline/export; tenant A ⇄ tenant B isolation on list, detail,
  timeline and both exports.

## F. Audit / Timeline semantics

- Resource: `HR_AUDIT_RESOURCE.MISSION = 'hr.mission'` (distinct from
  `hr.mission_option`, `hr.mission_approval_definition`,
  `hr.mission_policy_version`).
- The reader proves existence tenant-scoped FIRST (foreign id → empty page, never
  an audit probe), then reads the SAME trail through `HrAuditGateway.read`.
  A rejected read re-throws as `AUDIT_READ_FAILED` → HTTP 503, never an empty page.
- Real-path events proven by E2E: create-through-the-register carries `create`;
  cancel carries `create` + `cancel` with its stated reason. Policy-gated fixture
  rows (SUBMITTED / IN_APPROVAL / CORRECTION_REQUIRED / APPROVED / REJECTED)
  were written directly, so their timelines are HONESTLY EMPTY (0 events) —
  documented, never fabricated.
- Known pre-existing infra noise observed during runs (not this phase's):
  «Dropped a message on the audit binding that is not a platform.audit@v1 event»
  — the same `AUDIT_CONTRACT_MISMATCH` family that makes four sibling suites fail
  on timeline counts.

## G. API Routes (five GETs, no writes)

```text
GET /api/v1/reporting/hr/mission-requests
GET /api/v1/reporting/hr/mission-requests/export/xlsx
GET /api/v1/reporting/hr/mission-requests/export/docx
GET /api/v1/reporting/hr/mission-requests/:id
GET /api/v1/reporting/hr/mission-requests/:id/timeline
```

Wire refusals (all proven): unknown `status`/`search`/`tenantId`/
`locationType`/`engagementType` → 422 (`forbidNonWhitelisted`/`@IsIn`);
inverted window and impossible day → 400; POST/PATCH/DELETE and register verbs
(`submit`/`cancel`/`approve`) under the reporting path → 404.

## H. Web Routes

- `/admin/reporting/hr/mission-requests` (list) and `/[id]` (detail) — thin
  server components over `HrMissionReportView` / `HrMissionReportDetailView`.
- `PAGE_TITLE_ALIASES` entry in `core-nav.ts` («گزارش وضعیت درخواست‌های
  مأموریت») — NO new rail row, the sibling precedent.
- Client `lib/hr-mission-report-api.ts`: five GETs mirroring the controller; no
  tenantId, no write method, no search; status vocabulary re-exported from
  `hr-mission-api.ts` (one vocabulary, both surfaces).

## I. Web UX

- Vertical order: identity → filters → summary → status chart → export → table
  → pagination (the sibling order).
- Filters rendered: `وضعیت` (closed seven), `حالت مدت` (HOURLY/DAILY), `از/تا
  تاریخ (میلادی)` (intersection note below: «روزهای مأموریت را می‌سنجد … نه
  تاریخ ثبت و نه تاریخ تصمیم»). NO employee picker, NO catalogue filter, NO
  search — register declares none; the spec pins each absence.
- Summary: server `summary` straight over the SAME filter (total card +
  per-status cards, `data-testid="hr-mission-report-summary-<STATUS>"`).
- Chart: shared `ReportSummaryChart` over `buildReportChartBuckets(summary,
  HR_MISSION_REQUEST_STATUSES, label)` — schema order, never DB-enum order;
  all-zero renders the honest empty message.
- Table columns: کد پرسنلی (link to detail) · حالت مدت · بازه مأموریت (Persian
  digits + location/engagement sub-label) · وضعیت (badge word + tone) · تاریخ ثبت
  · جزئیات link. NO duration/cost/rate columns exist.
- Detail: identity → «مشخصات مأموریت» card (all 15 whitelist fields with Persian
  labels, reasons verbatim-or-honest-absent sentences, times-or-absent sentence,
  revision-or-not-submitted sentence) → `HrMissionReportTimeline`; the ONLY
  navigation is back to the report.
- Timeline: `create/submit/resubmit/cancel/approve/reject/correction` named in
  Persian, unknown actions verbatim, 503 → retryable refusal.

## J. Chart, XLSX, DOCX

- All three consume the EXACT `list()` result for the same query — no second
  filter implementation, no recount from rows, same predicate end to end.
- XLSX (shared writer): 13 columns mirroring the table, all seven Persian words
  in the status column, `خلاصه` metadata block, ASCII name
  `hr-mission-request-report-YYYY-MM-DD.xlsx`.
- DOCX (shared writer): Persian title + filters + summary + status distribution
  + one table (header + data rows), `<w:bidi/>` RTL. No tenant id, no row id.

## K. Tests

Focused (phase-owned, all PASS):

- `hr-mission-reporting.reader.spec.ts`: projection whitelist+exclusions,
  tenant threading, filter pass-through (employee/status/duration/window/page),
  inverted/impossible window 400, seven-member zero-fill, foreign-row null +
  empty timeline without audit, never-empty-timeline-on-rejection, 4-read surface.
- `hr-mission-report.service.spec.ts`: tenant scoping, source-only filter
  pass-through, 404-for-missing-OR-foreign, AUDIT_READ_FAILED→503 + passthrough
  re-throw, XLSX/DOCX through the same list path (mime+name+bytes),
  export-fails-closed-without-tenant, read-only surface, fail-closed tenant.
- `hr-mission-report.controller.spec.ts`: exactly five GETs, `hr.mission.read`
  on each, module+feature entitlement chain, no mutating decorator.
- Web `HrMissionReportView.spec.tsx` (14) + `HrMissionReportDetailView.spec.tsx`
  (7): identity/no-h1, server-only filters (incl. refusal-shaped absence probes),
  reset, vocabulary rendering, empty/error/loading/forbidden, pagination through
  server, export actions for current scope, chart over server summary, no-write/
  no-metric/no-search vocabulary audits, detail identity/classification/reasons/
  timeline-on-demand.

Full suites: see §M (numbers) and §N (classification of failures).

## L. E2E Scenarios (real DB, 23/23 PASS)

| # | scenario | result |
|---|----------|--------|
| 0 | register drift probe: static GET family shadowed by `:id` (pre-existing, external) | PASS (400s as documented) |
| 1 | list + summary, exact 7-state distribution over 8 rows | PASS |
| 2 | projection whitelist: exact 16 keys, 7 forbidden absent, values | PASS |
| 3 | status filter ×7 members, zero-filled 7-key summaries | PASS |
| 4 | durationMode filter (DAILY 7 rows, HOURLY 1 row) | PASS |
| 5 | employeeId filter (A → 8, A2 → empty + zero summary) | PASS |
| 6 | window intersection: last-day, HOURLY same-day, both-edge overlap | PASS |
| 7 | empty page + zero-filled summary | PASS |
| 8 | pagination echo (pageSize=3, total=8) | PASS |
| 9 | undeclared filters refused: search/status=ARCHIVED/locationType/engagementType → 422 | PASS |
| 10 | client-supplied tenantId → 422 | PASS |
| 11 | inverted window + impossible day → 400 | PASS |
| 12 | detail projection/values/exclusions | PASS |
| 13 | fixture facts verbatim (reasons, revision, HOURLY times) | PASS |
| 14 | 404 foreign/unknown on detail+timeline, BOTH directions | PASS |
| 15 | timeline: create + create/cancel acts; fixture timelines EMPTY | PASS |
| 16 | 403 without `hr.mission.read` (list/detail/timeline) | PASS |
| 17 | 401 anonymous on all five families | PASS |
| 18 | tenant-scoped list both directions (incl. cross-employee empty probe) | PASS |
| 19 | no write path: POST/PATCH/DELETE/submit/cancel/approve → 404 | PASS |
| 20 | NO-WRITE PROOF: count + full rows byte-identical after every read family | PASS |
| 21 | XLSX parsed: 13 headers, 8 rows, codes == list, all 7 words, clock times, خلاصه | PASS |
| 22 | DOCX parsed: title, bidi, 1 tbl, 1+8 tr, no tenant/id leak; 403/401 kept | PASS |

Fixture honesty: DRAFT ×2 + CANCELLED through the REAL register (create via
`POST /hr/missions` with the fact catalogue, cancel via `POST :id/cancel`);
SUBMITTED / IN_APPROVAL / CORRECTION_REQUIRED / APPROVED / REJECTED written via
the HR Prisma client with the state/instant/reason columns the lifecycle owns
(`MissionRequest` declares NO state CHECK) — READ path fully real, timelines
honestly EMPTY where a published policy would be required to route through the
service.



## M. Record

- starting HEAD: `205a829`
- implementation commit: `80f2f4b` (`feat(reporting): add hr mission request report`)
- documentation commit: recorded in the follow-up hash-record commit below

## N. Final Verification

```text
Source seam unit (reader):            8/8 PASS
Reporting unit (service + controller + presentation/labels):
  service:                            9/9 PASS
  controller:                         4/4 PASS
  report-export-labels (+ mission):   8/8 PASS
Reporting isolation:                  PASS (remit/seven-seam/verbs/export-scope)
Reporting module:                     PASS (seven seams mount)
HR regression:                        40 suites / 565 tests PASS
Architecture boundaries (B3):         28/28 PASS (incl. mission-date-time vocab row)
API FULL unit suite:                  287/287 suites, 4452/4452 tests PASS
Mission real E2E:                     23/23 PASS (22 scenarios + drift probe)
Web focused (list + detail):          21/21 PASS
Web FULL suite:                       123/123 suites, 1991/1991 tests PASS
API typecheck:                        PASS (tsc --noEmit, 0 errors)
Web typecheck:                        PASS (tsc --noEmit, 0 errors)
API build:                            PASS (nest build — silent success, no output;
                                      prisma schema untouched so `prisma:generate`
                                      not required for this phase)
Web build:                            PASS (next build — full route table printed,
                                      prerendered pages listed, no failure)
git diff --check:                     PASS
Targeted API lint:                    9 phase files → 6 findings, ALL pre-existing
                                      at HEAD (arch-boundaries ×3 + mission.repository
                                      outbox `as any` ×3); 0 introduced; preserved
                                      per §22 (not mass-fixed)
```

## O. Evidence vs Assumption

Every Mission-specific semantic, classified:

SOURCE-PROVEN (file + symbol quoted in §B):

- seven statuses + transition table (`domain/mission-status.ts`)
- terminal states APPROVED/REJECTED/CANCELLED — NO COMPLETED (`mission-status.ts`
  header + schema model without such a member)
- DRAFT (create), submit-from-DRAFT-only, resubmit-from-CORRECTION-only,
  revision+instance semantics (`mission.service.ts`)
- AUTO_APPROVE / AUTO_REJECT / REQUIRED_APPROVAL / NO_DECISION /
  no-published-policy → 409 (`mission.service.ts`, `mission-policy.service.ts`)
- cancel gate non-terminal-only, cancelledAt + audit reason (`mission.service.ts`)
- correction/rejection reasons + approvedAt/rejectedAt on the ROW; approval/instance
  statuses on the FLOW (`mission.service.ts serializeRequest`,
  `domain/mission-approval.ts`)
- intersection date predicate (`mission.repository.ts` — before AND after this
  phase's refactor)
- the register's own five filters (`dto/mission.dto.ts:ListMissionRequestsQueryDto`)
- `hr.mission.read` + `hr`/`mission` entitlement (`mission.controller.ts`)
- `hr.mission` audit resource + action families (`hr.constants.ts`,
  `mission.service.ts` outbox calls)
- tenant-first-param + `findFirst` repository convention (`mission.repository.ts`)
- duration/location/engagement closed classifications
  (`domain/mission-options.ts` + `domain/mission-date-time.ts`)
- web `HrMissionRequestStatus` seven members + total Persian Records
  (`hr-mission-api.ts`, `hr-mission-labels.ts`) — NO drift vs backend
- `@Get(':id')`-before-static-GETs shadowing in `MissionController` (route
  declaration order, proven by the E2E probe returning 400 on
  `option-groups`/`approval-definitions`/`policy-versions`)

TEST-PROVEN (this phase's specs):

- zero-filled seven-key summary always; predicate equality list/summary/export
- whitelist/exclusion projection correctness; 400/422/401/403/404 wirings
- both-direction tenant isolation; no-write full-row equality; export isolation
- chart over server summary; Persian pinning table/chart/XLSX/DOCX

INTENTIONALLY NOT SUPPORTED (deliberate, documented):

- `COMPLETED` request state, `PENDING`, KPI/balance/duration/rates
- `MissionReport` post-approval content
- `search`, `locationType`/`engagementType`/`destination` filters, employee picker
- exposing `approvedAt`/`rejectedAt`/`cancelledAt` decision instants
- end-to-end (policy-routed) submit inside THIS phase's E2E — requires a PUBLISHED
  version; approval definitions, policy authoring and validation remain the
  register's concern and were only reached through catalogue WRITES, never policy
  writes
- fixing the register's static-GET shadowing — Phase B3 architecture guards are
  not a hotfix license for a different bounded context's routes

## P. Phase-Owned Fixes (ONLY what this phase changed)

1. `mission.repository.ts`: shared `buildRequestWhere` + `countByStatus`
   (list/count/summary can no longer disagree; no rule change).
2. New HR seam: `hr-mission-reporting.{contract,reader,module}.ts` + reader spec.
3. New Reporting surface: `hr-mission-report.{dto,service,controller}.ts` + both
   unit specs + `presentation/hr-mission-report.presentation.ts`.
4. `reporting.module.ts`: seventh capability wiring.
5. `reporting-isolation.spec.ts`: six→seven seam/controller/volume/Exports lists,
   `mission-status`/`mission-date-time`/`mission-options` group-C approvals,
   `hr.mission.read` group-D row; `reporting.module.spec.ts`: module import,
   `missionRequest` stub, seventh mount assertions.
6. `report-export-labels.spec.ts`: seven Mission lifecycle words pinned to the web.
7. `architecture-boundaries.spec.ts` (Phase B3 guard): ONE approved vocabulary
   row — `mission-date-time` (HOURLY/DAILY) — beside the existing
   `hr-attendance-source` row, for the DTO's `MISSION_DURATION_MODES` import.
8. `arch` fix scope is exactly this gate row; no guard was weakened.
9. Web: report client, list/detail/timeline components + their specs,
   both admin routes, one `PAGE_TITLE_ALIASES` entry.
10. `test/reporting-hr-mission-report.e2e-spec.ts`: 23-test real-DB slice.
11. No HR business file, no register route, no policy file was touched.

## Q. Pre-Existing Issues (baseline-proven, NOT phase-owned)

- Four sibling Reporting E2E timeline-count failures (check/purchase/production/
  production-bom-change): each expects one more `create`-trail event than the
  trail delivers, on the SAME «authoritative timeline» assertion. A stash-based
  reproduction on this phase's baseline HEAD (205a829) was ATTEMPTED for one
  suite (check-request) but the run was killed by the tool's 30s timeout before
  it completed — INCONCLUSIVE as a direct repro. Classification therefore rests
  on two independent proofs: (a) the failing test NAMES and assertions are
  byte-identical to the ones the Leave phase reproduced at ITS baseline
  (8de9620) and documented in Leave §K; (b) this phase's diff touches NO
  audit/production/financial/commerce code — only `hr/mission`,
  `hr/reporting`, `reporting`, one Phase B3 vocabulary guard row, the mission
  web surface, and the new mission E2E. The run logs show the shared audit
  ingest dropping events with `AUDIT_CONTRACT_MISMATCH`
  («not a platform.audit@v1 event»). Current batch: 4 failed / 104 passed of
  108 over the six sibling suites, with both HR siblings
  (personnel-traffic, leave) fully green.
- `AUDIT_CONTRACT_MISMATCH` noise also appears in this phase's own runs
  (platform relay logs) — Mission's timeline assertions are written to be exact
  where the register itself writes (`create`/`cancel`) and honestly-EMPTY where
  the service was never routed through, so they do NOT depend on the dropped
  binding.
- `MissionController` static GETs shadowed by `@Get(':id')` (this phase's E2E
  probe 400s) — pre-dates this phase; register-external; E2E reaches the same
  rows through POST writes + hrDb reads.
- `hr.e2e-spec.ts` still pins the 51-HR-3A-era leave contract; whole-project lint
  baseline broken (generated clients); web raw-eslint config crash (`next lint`
  sanctioned); Prettier warnings on touched files; `next build` blog-SSG fetch
  warning; `rimraf` EPERM lock requiring `prisma:generate` + `nest build` retry.
  All preserved, recorded, not mass-fixed.

## R. Non-Goals (explicitly NOT added)

KPIs/runtime/targets/alerts · AI/DSL/ad-hoc builder · generic filter/chart/export
frameworks · employee directory/selector · workflow or policy redesign · any write
endpoint · business-to-business Prisma · direct Reporting→Prisma · `COMPLETED` ·
`search` · balance/duration/rate/SLA/aging · `MissionReport` content · catalogue
or policy management UI · project linkage.

