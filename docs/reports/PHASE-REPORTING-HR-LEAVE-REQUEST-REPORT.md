# HR Leave Request Status Report — گزارش وضعیت درخواست‌های مرخصی

Phase `REPORTING-HR-LEAVE-REQUEST`.

## A. Baseline

- starting HEAD: `8de9620` (P0-B final closure)
- `git status --short` at start: only `?? apps/web/next-env.d.ts` (generated, untouched)
- prior reporting: Financial Check Request, Commerce Purchase, Production BOM,
  HR Personnel Traffic, Production BOM Change, visualization/XLSX/DOCX,
  KPI governance/runtime/historical

## B. Source Evidence

Aggregate: one `LeaveRequest` in `hr_db` — `apps/api/prisma/hr/schema.prisma`,
`src/modules/hr/leave/leave.repository.ts`, `leave.service.ts`,
`leave-requests.controller.ts`.

Lifecycle from `src/modules/hr/domain/leave-status.ts` (four members, schema order):

```text
PENDING -> APPROVED | REJECTED | CANCELLED
```

- correction is NOT a state: restatability derives from terminality — a correction
  is a NEW request
- `APPROVED`/`REJECTED` are decided by the routed flow's steps (Phase 54-E); no
  `approverId`/`decidedAt` lives on the row — decision facts belong to the step
- terminal: APPROVED, REJECTED, CANCELLED; resubmission = new request

Source filters from `ListLeaveRequestsQueryDto` (reused, minus `search`):

```text
employeeId, leaveTypeId, status, from, to, page, pageSize
```

- `search` is DECLARED but deliberately IGNORED by `LeaveService.list`; the report
  refuses `?search=` with 422 rather than claiming a narrowing the server never does
- date semantics: `from`/`to` are Gregorian days meaning INTERSECTION with the
  request's own inclusive period
- permission: `hr.leave.read` (reused); entitlement: `hr` module + `leave` feature;
  tenant: server-derived only

One report row = one `LeaveRequest` + `employeeCode` + `leaveType.code/name` +
`startDate`/`endDate` + `reason` + `status` + `createdAt` + `cancelledAt`.

Timeline: `HR_AUDIT_RESOURCE.LEAVE` (`hr.leave`) through `HrAuditGateway.read`;
`AUDIT_READ_FAILED` becomes HTTP 503, never an empty page.

## C. Reporting Seam

Narrow HR-owned module, mirroring the five sibling seams —
token `HR_LEAVE_REQUEST_REPORTING_READER`:

- `src/modules/hr/reporting/hr-leave-reporting.contract.ts` — HR owns query, row
  whitelist, summary and timeline shapes and the reader interface
- `src/modules/hr/reporting/hr-leave-reporting.reader.ts` — the adapter; reuses the
  SAME repository statements the register reads (`listRequestPage`,
  `findRequestById`) plus `countByStatus` (one bounded `groupBy`); the `from`/`to`
  day arithmetic is the SAME round-trip the register applies
- `src/modules/hr/reporting/hr-leave-reporting.module.ts` — exports the token only

`LeaveRepository` gained `countByStatus` over the ONE shared predicate builder
(`buildRequestWhere`) the page read now uses too, so page/count/summary cannot
disagree. Reporting imports ONLY the contract path (`../hr/reporting/**` +
`hr.constants` + pure `hr/domain/leave-status`); `reporting-isolation.spec.ts`
group C was deliberately widened for exactly this one pure-vocabulary import, and
group D pins the `hr.leave.read` remit.

## D. Projection

Exactly the contract whitelist:

```text
id, employeeCode, leaveTypeCode, leaveTypeName, startDate, endDate,
reason, status, createdAt, cancelledAt
```

Excluded: `tenantId`, `employeeId`, `leaveTypeId`, `approvedAt`/`rejectedAt`
(the flow's, not the row's), `updatedAt`.

## E. Filters

`employeeId`, `leaveTypeId`, `status` (closed set), `from`/`to` (intersection),
`page`/`pageSize` under `HR_MAX_PAGE_SIZE`. Summary, chart and both exports reuse
the SAME `list()` result/DTO — one population.

## F. Summary

`{ total, byStatus }` zero-filled over the four members. No rate, no duration, no
balance, no KPI — enforced by isolation vocabulary gates.

## G. Timeline

Same `hr.leave` audit trail HR writes; existence proved tenant-scoped first;
`AUDIT_READ_FAILED` → 503.

## H. Security

JWT → `hr.leave.read` → `hr` module + `leave` feature → server-derived tenant →
HR source reads. Foreign ids → 404 (indistinguishable from missing). Exports carry
the identical remit and scope. PII minimized: codes + type labels only.



## I. Web UX

- `/admin/reporting/hr/leave-requests` — title, description, filters, summary,
  status chart, table, pagination; Persian-first RTL; light/dark via design system
- `/admin/reporting/hr/leave-requests/:id` — identity, kind, period, status,
  record/withdrawal instants, on-demand timeline
- title alias in `PAGE_TITLE_ALIASES` (no rail row, sibling precedent)
- the web leave vocabulary in `hr-api.ts` was widened from two to the four
  backend-authoritative states (it still claimed 51-HR-3A), pinned by the drift spec
- status filter: the closed set; type filter: the tenant's own catalogue via the
  same `hr.leave.read` remit; date window: the register's own Gregorian pair with
  an explicit «requested days / intersection» note
- NO employee picker: the report carries no directory remit and refuses an id it
  cannot label; the `employeeId` API filter remains for surfaces that can label it

## J. Export

XLSX/DOCX through the shared writers: Persian title, timestamp, applied filters,
scope, server summary, Persian headers, exact server rows, RTL orientation. The
chart reuses `ReportSummaryChart` over server `byStatus` — no client recount.

## K. Tests

Commands (all actually executed; counts from the run logs):

```text
API reporting seams:
  jest src/modules/reporting --runInBand → 17 suites / 143 tests PASS

HR scoped regression (leave + guards + statuses):
  jest src/modules/hr/leave + hr-isolation + hr-application-boundaries
       + domain/leave-status --runInBand → 12 suites / 252 tests PASS

Web focused:
  jest HrLeaveReportView + HrLeaveReportDetailView + hr-api → 3 suites / 54 PASS

Real E2E (19 scenarios):
  jest --config ./jest-e2e.json --runTestsByPath reporting-hr-leave-report
  → 1 suite / 19 tests PASS

Seam focused (reader + controller + service specs, exact surface contracts):
  jest hr-leave-reporting.reader + hr-leave-report.controller + hr-leave-report.service
  → 3 suites / 22 tests PASS

Architecture/entitlement guards (platform boundaries, runtime policy, module
operational state, entitlement service/guard/controller):
  → 7 suites / 117 tests PASS

Existing Reporting regression E2E (all five sibling suites, one batch):
  → personnel-traffic PASS; check-request / purchase / production /
    production-bom-change each FAIL on their «authoritative timeline»
    audit-count assertion (one fewer event than the floor)
  → PRE-EXISTING, not caused by this phase: each failing suite was re-run at the
    baseline commit `8de9620` with this phase's work stashed away
    (`git stash push -u` → run → `git stash pop`) and failed identically —
    same test names, same one-short audit counts; the logs also show an
    `AUDIT_CONTRACT_MISMATCH` drop on the audit binding
    («not a platform.audit@v1 event») in the shared ingest consumer

API full unit suite:
  jest --silent --runInBand → 284 suites / 4430 tests PASS

Web full suite:
  jest --silent --runInBand → 121 suites / 1970 tests PASS

API typecheck (`tsc --noEmit`): PASS · Web typecheck (`tsc --noEmit`): PASS
git diff --check: PASS

Builds:
  Web `next build` → PASS (compiled +71/71 static pages; a pre-existing
    `[blog-api] fetch failed` warning on blog SSG did not fail the build)
  API `nest build` → PASS. Note: the first `npm run build` attempt failed at the
    `rimraf dist src/generated` step with `EPERM` on the locked
    `query_engine-windows.dll.node` (a leftover test process held the engine
    library), which had already gutted several generated clients; the clients
    were regenerated via `prisma:generate:*` and `nest build` (the compile step)
    then exited 0. Local build-artifact repair only — `src/generated` is
    gitignored and no repository file was affected.

Lint (no `--fix`, no mass formatting — §54):
  API targeted (`eslint` over the ten new/changed source files): PASS, 0 findings
  API e2e file: NOT COVERED by `tsconfig.eslint.json` (test/ is excluded —
    pre-existing config shape, applies to every e2e spec)
  Web targeted: NOT RUN — the raw eslint invocation cannot load the web config
    (eslintrc extended-config validation crash); `next lint` is the repo's
    sanctioned script and its whole-project baseline is known broken
  Whole-project lint: PRE-EXISTING broken baseline (generated-client findings
    predate this phase) — classified, not mass-fixed

Prettier (`--check`, no `--write` — §54):
  PRE-EXISTING: 28 of this phase's touched files warn, including the pre-existing
  `reporting.module.spec.ts` (verified the same warning exists on files this
  phase did NOT author); mass-formatting the repo is forbidden, so warnings are
  classified rather than auto-fixed
```

## L. Limitations

- The E2E's decision-state fixtures (`APPROVED`/`REJECTED`) are written through
  the HR Prisma client with `approved_at`/`rejected_at` set per
  `LeaveRequest_state_check` (the same fixture mechanism `hr.e2e-spec.ts` §12.6
  uses) — a full flow needs a published policy version outside this phase's
  scope; their timelines are therefore honestly EMPTY, never fabricated.
- `hr.e2e-spec.ts` still pins the 51-HR-3A-era leave contract and was NOT updated
  by Phase 54-E — pre-existing gap, documented, not widened nor fixed here.
- No employee picker on this screen (see §I).
- No KPI added — leave balance remains a separate blocked capability.

## M. Record

- starting HEAD: `8de9620`
- implementation commit: `1c42002` (`feat(reporting): add hr leave request report`)
- documentation commit: recorded in the follow-up hash-record commit below
- verification output: `Final status: COMPLETE` (see the phase handoff)

