# Phase Report — Reporting First Vertical Slice: Check Request Status & Flow Report

> **گزارش وضعیت و گردش درخواست‌های صدور چک**
>
> Implementation commit: **`eb71005`** — `feat(reporting): finalize financial reporting slice`.
> Baseline before this phase: `2bebd11` (Reporting UI/UX foundation hash commit).

## 1. What this phase is

The **first real end-to-end Reporting capability** in the ERP:

```text
Financial source-of-truth (finance_db)
        ↓
approved Reporting read contract (Financial-owned, read-only, tenant-scoped)
        ↓
Reporting application/use case
        ↓
Reporting API (three GETs)
        ↓
Reporting Web UI/UX (register + summary + read-only detail + flow)
        ↓
tests + e2e
```

A read-only analytical view that answers one management question:

> **What is the current status of cheque-issuance requests, how are they
> distributed across lifecycle states, and how has each request moved
> through its existing lifecycle?**

The report never mutates Financial data, never approves/rejects/edits, and
invents no status, filter, KPI or field. The governing principles held:

```text
TRUSTWORTHY REPORTING > DECORATIVE DASHBOARDS
REPORTING READS FINANCIAL TRUTH. REPORTING NEVER BECOMES FINANCIAL TRUTH.
ONE REAL REPORT > A SPECULATIVE REPORTING PLATFORM
```

## 2. A. Pre-flight evidence — files and contracts inspected

| Area | What was read |
| ---- | ------------- |
| Financial source contract | `apps/api/src/modules/financial/check-request/` — `check-request-status.ts` (the closed lifecycle set), `check-request.repository.ts` (tenant predicate, list filters, ordering), `check-request.dto.ts` (the `status`/`search`/window filters and the page ceiling), `check-request.service.ts` (list/detail/timeline orchestration + the seven-field timeline projection), `check-request.controller.ts` (route chain + `financial.check.read` remit), `financial-actor.ts`, `financial.constants.ts` |
| Source data model | `apps/api/prisma/financial/schema.prisma` — `CheckRequest` columns, stage tables, tenancy keys, indexes |
| Financial module wiring | `financial.module.ts`, `database/financial-prisma.module.ts`, `financial-audit.gateway.ts` (the platform audit seam), `financial-isolation.spec.ts` |
| Reporting foundation | `reporting.module.ts`, `reporting.module.spec.ts`, `reporting-isolation.spec.ts`, `src/ai/ai-boundaries.spec.ts` (Reporting's AI-half gates) |
| Architecture gates | `src/architecture-boundaries.spec.ts` (cross-context import rules, independent-module registry), `platform/entitlement/**` (the entitlement chain), `auth/rbac/constants/permissions.ts` (existing remits) |
| Existing records | `docs/reports/PHASE-REPORTING-FIRST-CAPABILITY-EVIDENCE.md`, `PHASE-REPORTING-BOUNDED-CONTEXT.md`, `PHASE-REPORTING-UI-UX-FOUNDATION.md`, `docs/PHASE-FINANCIAL-CHECK-REQUEST-F1-IMPLEMENTATION.md`, `docs/PHASE-FINANCIAL-CHECK-ISSUATION-IMPLEMENTATION.md` |
| Frontend conventions | `apps/web/src/components/financial/*` (register/detail/timeline patterns, `financial-ui.tsx` classes), `apps/web/src/lib/financial-api.ts` + `financial-labels.ts` (wire mirror + Persian labels), `core-nav.ts` (the `/admin/reporting` title alias, no rail row), `CoreStates.tsx`, the Reporting landing components and their specs |

### The one honest deviation: the lifecycle range

The phase brief states the contract as `0/1/2/3/50` and forbids introducing
stages `4–7`. **Pre-flight found that stages `4–8` are not “to be
introduced” — they are already implemented**: Phase CHECK-ISSUATION shipped
the full `{0,1,2,3,4,5,6,7,8,50}` set in `check-request-status.ts`, the five
stage tables, the stage routes and the wizard. The `0/1/2/3/50` framing
describes the F1-era slice; the code has since grown.

Decision: **the report renders the authoritative set as it exists.** A
report that hid live stages 4–8 would misdescribe the register it claims to
describe — the exact failure “trustworthy reporting” forbids. No NEW state
was invented; no state was renamed; the presentation mapping
(`financial-labels.ts`) is Financial's own existing vocabulary. Everything
else in the brief (no `4–7` invention, no cheque-issuance behavior added by
Reporting) holds: this phase adds no lifecycle behavior whatsoever.

## 3. B. Requirement decision — why this report is first

1. **A real, implemented source contract exists**: `CheckRequest` with a
   closed lifecycle, tenant predicate, list/detail/timeline reads, filters
   (`status`, `search`) and a platform audit trail — more contract substance
   than any other candidate (the evidence review classified every other
   candidate as roadmap/unsupported).
2. **A concrete management question** (status distribution + flow) is
   answerable honestly from data that already exists — no KPI formula has
   to be invented.
3. **The Reporting foundation and UI shell already exist** (bounded
   context, isolation gates, landing route) waiting for exactly this seam.
4. **No persistence is needed**: the report is a projection of Financial
   truth, so Reporting stays database-free (the isolation gate that must
   keep holding).

## 4. C. Contract

| Element | Value |
| ------- | ----- |
| **Use Case** | Read the filtered register of «درخواست صدور چک» rows with their lifecycle status, a per-status summary over the same population, one row's report detail, and that row's authoritative flow timeline |
| **Actor** | An authenticated user holding the existing `financial.check.read` remit, inside an entitled tenant |
| **Tenant Scope** | Server-resolved (`RequestContextService` → `resolveReportingActor`); a missing tenant is 403; `tenantId` is never accepted from query/body/path (the global `forbidNonWhitelisted` pipe refuses it — proven in e2e) |
| **Input** | `status?` (closed lifecycle set), `search?` (title match), `page?`, `pageSize?` (ceiling = `FINANCIAL_MAX_PAGE_SIZE` = 100, default 20); detail/timeline take a UUID path parameter + timeline window |
| **Source of Truth** | `finance_db."CheckRequest"` + the platform audit trail (`financial.check-request` bound to the tenant-scoped row). Reporting owns NO persistence |
| **Read Seam** | `FINANCIAL_CHECK_REQUEST_REPORTING_READER` token → `FinancialCheckRequestReportingReaderService` → `CheckRequestRepository` (the same tenant-scoped statements Financial's own reads use) + `FinancialAuditGateway.read`. The narrow `FinancialCheckRequestReportingModule` is the ONLY Financial module Reporting imports |
| **Business Rules** | Read-only; the report re-derives no status, no event and no date; timeline events come from the audit port only (never inferred from timestamps); summary is a per-status count of rows, nothing else |
| **Filters** | Exactly `status` + `search` — the two the Financial list contract already supports. **Date filtering deliberately absent** (the source list contract has no bounded date/window parameter) |
| **Output** | A Reporting DTO: `{ items: [12-field row], total, page, pageSize, summary: { total, byStatus } }`; detail = the same 12-field row; timeline = the existing 7-field whitelist. The row whitelist: `id, title, checkIssueType, purchaseType, orderReference, projectReference, requestDate, requesterOpinion, status, managerDecision, submittedAt, decidedAt` |
| **Summary calculations** | `byStatus[s] = count(rows matching the query AND status = s)`, zero-filled over the closed set; `total = Σ byStatus`. One bounded `groupBy` in the repository — no row loading, no rate/duration/value/growth formula |
| **Authorization** | `@Roles(Permissions.FINANCIAL_CHECK_READ)` on all three routes — the EXISTING Financial read remit, because the report reads exactly the rows/trail that remit covers. **No `reporting.*` permission invented** (no seeder/grant/role would exist behind it); entitlement declares `financial` / `check-request`, the same requirement Financial's reads declare |
| **Failure behavior** | No tenant → 403; no permission → 403; unauthenticated → 401; unknown OR foreign id → 404 (indistinguishable); audit outage → 503 `AUDIT_READ_FAILED` (never an empty timeline); invalid query (incl. `tenantId`) → 422; empty filter result → 200 with `items: []` |
| **Persistence** | **None for Reporting.** No migration, no `prisma/reporting`, no `REPORTING_DATABASE_URL`, no Reporting-owned projection — verified by the isolation suite |

## 5. D. Architecture

```text
finance_db (Financial-owned)
        ↓  CheckRequestRepository / FinancialAuditGateway (tenant-scoped)
FinancialCheckRequestReportingModule  ← Financial-owned NARROW read module
        ↓  FINANCIAL_CHECK_REQUEST_REPORTING_READER token (read-only contract)
ReportingApplication: CheckRequestReportService
        ↓
Reporting API: CheckRequestReportController  (GET ×3, @Roles(financial.check.read))
        ↓
Reporting UI: ReportingView + CheckRequestReportDetailView + Timeline
```

Direction is one-way by construction: Financial never imports Reporting;
Reporting imports only `modules/financial/reporting/**` + the module/feature
constants (the pure lifecycle vocabulary file is the DTO's import for the
status filter). The executable guards: `reporting-isolation.spec.ts`
(dependency direction, approved-seam allowlist, package allowlist) and
`financial-isolation.spec.ts` (unchanged — Financial still exposes no
repository/service outside its own module).

## 6. E. Security

- **Tenant isolation**: every seam method takes the server-resolved scope
  first; `findWithStages(tenantId, id)` is the only id lookup; a foreign id
  is 404 on detail and timeline; e2e proves tenant B rows never appear in
  tenant A's register.
- **Authorization**: least privilege — the report is gated by the same read
  remit as Financial's register, never by a mutation grant; no RbacModule
  imported (the global `RolesGuard` resolves `@Roles` metadata).
- **Projection**: the twelve-field whitelist lives in the adapter and is
  asserted against a raw row (tenantId, actor ids, `createdAt/updatedAt`,
  `managerComment`, `processPin` all stay server-side); timeline keeps the
  existing 7-field whitelist; no raw actor ids are rendered in the UI (no
  display contract exists for them).
- **Prohibited dependencies (executable)**: no `FinancialPrismaService`,
  no `CheckRequestRepository`/`CheckRequestService` import from Reporting
  sources, no financial controller/DTO internals, no generated client, no
  `RbacModule`, no notification/search/workflow/scheduler machinery.

## 7. F. Implementation — changed files and purpose

**API — new**

| File | Purpose |
| ---- | ------- |
| `src/modules/financial/reporting/financial-check-request-reporting.contract.ts` | The Financial-owned READ CONTRACT: scope, query (status/search/window), the 12-field row whitelist, summary/timeline shapes, the four-method read-only interface, the DI token |
| `src/modules/financial/reporting/financial-check-request-reporting.reader.ts` | The adapter: delegates to `CheckRequestRepository` (same tenant-scoped statements) + `FinancialAuditGateway.read`, projects rows onto the whitelist, zero-fills the summary over the closed lifecycle set, maps audit rejection to a typed failure |
| `src/modules/financial/reporting/financial-check-request-reporting.module.ts` | The NARROW Financial module Reporting imports: Financial Prisma + audit port + repository + gateway + reader, exporting ONLY the token. No controllers, no write services, no storage/identity/entitlement surface |
| `src/modules/financial/reporting/financial-check-request-reporting.reader.spec.ts` | Seam contract: projection (raw row → twelve fields), tenant forwarding, filter pass-through, summary zero-fill, null-for-foreign, empty-vs-rejected timeline, four reads only |
| `src/modules/reporting/check-request-report.dto.ts` | The Reporting wire contract: list query (status/search/page/pageSize, class-validator + Financial page ceiling) and the timeline window |
| `src/modules/reporting/reporting-actor.ts` | Server-side actor resolution (mirror of `resolveFinancialActor`): tenant from `RequestContextService` only, 403 when absent |
| `src/modules/reporting/check-request-report.service.ts` | The application: `list` (page + summary in parallel), `getOne` (404 on null), `getTimeline` (existence first, 503 on audit outage) |
| `src/modules/reporting/check-request-report.controller.ts` | The three GETs under `reporting/financial/check-requests`, full chain (`@RequiresModule` → `@RequiresFeature` → `ModuleEntitlementGuard` → `JwtAuthGuard` → `@Roles(financial.check.read)`) |
| `src/modules/reporting/check-request-report.service.spec.ts` | Scope/filter pass-through, 404 mappings, projection not re-widened, 503 mapping, read-only surface, fail-closed without tenant |
| `src/modules/reporting/check-request-report.controller.spec.ts` | Exactly three GET handlers, one `@Roles(financial.check.read)` each, no mutating decorator |
| `test/reporting-check-request-report.e2e-spec.ts` | The vertical slice, end to end (12 tests, see §G) |

**API — modified**

| File | Change |
| ---- | ------ |
| `src/modules/financial/check-request/check-request.repository.ts` | + `countByStatus` (one bounded `groupBy` for the summary) and + `findWithStages` (public alias of the existing tenant-scoped statement — no query rewritten) |
| `src/modules/reporting/reporting.module.ts` | Composes the entitlement gate and the approved Financial read module; registers the report controller + service |
| `src/modules/reporting/reporting-isolation.spec.ts` | The foundation's “no contract yet” gates replaced by “exactly ONE contract” gates: exact source-file list, approved seam allowlist, package allowlist, `financial.check.read`-only roles, no `reporting.*` permission, report-vocabulary + no-export-route gates |
| `src/modules/reporting/reporting.module.spec.ts` | Stubs `FinancialPrismaService`, asserts the read token + controller resolve through the real module graph |

**Web — new/changed**

| File | Purpose |
| ---- | ------- |
| `src/lib/reporting-api.ts` | The client mirror of the three GETs; 12-field row type; no write/export/AI method |
| `src/components/reporting/ReportingView.tsx` | The report workspace: identity, filter bar (status + search), summary strip (chips = the status filter), table, pagination, loading/empty/error/forbidden states |
| `src/components/reporting/CheckRequestReportDetailView.tsx` | The read-only detail: identity/classification, status+decision, dates, back link; no mutation |
| `src/components/reporting/CheckRequestReportTimeline.tsx` | The flow section: selected request's audit timeline only, fetched on demand, outage → retry |
| `src/app/admin/reporting/check-requests/[id]/page.tsx` | The detail route (async params, metadata) |
| `src/components/reporting/ReportingEmptyState.tsx` | Repurposed: the filter-scoped «برای این فیلترها درخواستی پیدا نشد.» empty state (the old “no reports exist” copy is obsolete) |
| `src/app/admin/reporting/page.tsx` | Comment corrected: the route now hosts a real report |
| `src/components/reporting/__tests__/*.spec.tsx` | 21 tests: identity, server filters, authorization gate, summary-from-API, row vocabulary, links, empty/error/skeleton states, scope protection; detail: projection render, timeline-on-demand, 404 sentence, no raw actor ids |

**Not changed**: any Prisma schema or migration (none needed), any Financial
route/service/rule, RBAC constants, `PermissionDomain`, `core-nav.ts`
(no nav placeholder is added — see §I), the AI seam.

## 8. G. Verification — exact commands and actual results

Ran against the Docker stack (postgres/redis/minio/rabbitmq up; API health
200) and the seeded development database.

| # | Gate | Command (repository root unless noted) | Result |
| - | ---- | -------------------------------------- | ------ |
| 1 | API typecheck | `apps/api: tsc --noEmit -p tsconfig.json` | **PASS** — exit 0 |
| 2 | Web typecheck | `apps/web: tsc --noEmit` | **PASS** — exit 0 |
| 3 | Reporting + Financial-adapter unit | API: `jest --runInBand src/modules/reporting src/modules/financial/reporting src/modules/financial/financial-isolation.spec.ts` | **PASS** — isolation/wiring/service/controller + reader seam green |
| 4 | Financial regressions | API: `jest --runInBand src/modules/financial` | **PASS** — 10 suites / 152 tests |
| 5 | Full API unit suite | API: `jest --silent` | **PASS** — **252 suites / 4083 tests** (pre-existing “worker process failed to exit” warning only) |
| 6 | Report e2e (the slice) | API: `jest --config ./jest-e2e.json --runInBand test/reporting-check-request-report.e2e-spec.ts` | **PASS** — **12/12** (register+summary, tenantId refusal 422, status/search filters, empty page, tenant isolation register/detail/timeline, 12-field projection, 404 semantics, authoritative timeline, 403s, 401, no write route) |
| 7 | Reporting + detail frontend | Web: `jest src/components/reporting` | **PASS** — 2 suites / 21 tests |
| 8 | Full web suite | Web: `jest --silent` | 106 suites / 1782 tests: **1770 pass**; 12 failures in 6 unrelated suites — pre-existing (see §G.1) |

### §G.1 — the 12 full-run web failures are PRE-EXISTING, not introduced

- The 6 failing suites (`CoreGlobalSearch`, `MissionApprovalDefinitionPanel`,
  `CoreSurveyEditorView`, `MissionPolicyVersionPanel`, `CoreDirectoryView`,
  `CoreSurveyDetailView`) reference no Reporting or Financial file.
- Re-running exactly those 6 suites alone: **6/6 suites, 142/142 tests PASS**
  — they fail only under full-suite parallel load (worker/timeout pressure),
  a flake pattern predating this phase.
- Reporting + Financial web suites pass inside the full run; the full API
  suite (252/252) includes every Reporting/Financial spec.

**Failure classification: INTRODUCED — none. PRE-EXISTING — the full-suite
web flake; the web `next lint` toolchain breakage (F1 report). ENVIRONMENT —
none blocking (the stack answered all e2e).**

## 9. H. UX review

- **Desktop/laptop**: heading → report identity → filter bar → summary strip
  → table; calm, one scroll, table primary. Theme-resolved ERP tokens in both
  themes; status tone classes identical to Financial's.
- **Tablet**: `تصمیم مدیر` collapses below `md:`; filter bar wraps.
- **Mobile**: `نوع صدور چک` hides below `sm:` (title link stays the tap
  target); chips wrap; two-button pagination with a Persian counter.
- **RTL**: document dir inherited; semantic table (`caption`, `scope`,
  `aria-busy`, `aria-pressed` on chips); keyboard-native links/buttons;
  status labels are text-first (the ordinal is the redundant channel).
- **States verified by test**: initial skeleton with no fake digits, compact
  summary placeholders, filter-scoped empty, Persian error + retry,
  forbidden without the read remit, rows persist during refetch.
- **Detail**: identity/classification, status+decision, dates, back link;
  on-demand flow; 404 sentence; no mutation affordance (spec-pinned).
- **Terminology**: «درخواست صدور چک» everywhere — DTOs, headings, tests,
  this record.

## 10. I. Remaining gaps

| Classification | Item |
| -------------- | ---- |
| **implemented** | The first Reporting capability end to end: seam, use case, three GETs, register + summary + detail + flow, guards, tests, e2e, this record |
| **intentionally deferred** | Export (Excel/PDF/CSV); scheduling/sharing; average approval time / processing-time / SLA (working-hours, timezone, pause semantics were never defined); AI summaries (gateway offers embed only); generic report builder / cross-domain dashboard |
| **future** | A second report's seam (same pattern); views beyond `status`+`search`; project/order reference RESOLUTION (still opaque); identity enrichment (needs a display contract first — no per-row lookups today) |
| **unsupported** | Any KPI formula, rate, growth, money aggregation, manager-performance metric; dashboard/widgets |
| **blocked** | AI text generation (no implemented provider); cross-context data without a source-owned contract |

## 11. J. Commit

- Feature commit: **`eb71005`** — `feat(reporting): finalize financial
  reporting slice` (this file's header carries the feature hash).
- Documentation commit: `docs(reporting): record reporting slice commit
  hashes` (this file's header and §J updated with the real hashes).

The governing invariant held: **ONE REAL REPORT > A SPECULATIVE REPORTING
PLATFORM.**


