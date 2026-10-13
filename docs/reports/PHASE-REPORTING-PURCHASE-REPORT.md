# Phase Report — Reporting Second Vertical Slice: Purchase Request Status & Lifecycle Report

> **گزارش وضعیت و چرخه عمر درخواست‌های خرید**
>
> Implementation commit: **`6d2723e`** — `feat(reporting): finalize commerce purchase reporting slice`.
> Baseline before this phase: `2bebd11` (Reporting UI/UX foundation hash commit).

## 1. What this phase is

The **second end-to-end Reporting capability** in the ERP, mirroring the first
(Financial check-request) slice one-for-one:

```text
Commerce source-of-truth (commerce_db)
        ↓
approved Reporting read contract (Commerce-owned, read-only, tenant-scoped)
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

> **What is the current status of purchase requests, how are they distributed
> across the commercial lifecycle states, and how has each request moved through
> its existing lifecycle?**


## 2. A. Pre-flight evidence — files and contracts inspected

| Area | What was read |
| ---- | ------------- |
| Commerce source contract | `modules/commerce/purchase/` — `purchase-status.ts` (the closed six-member lifecycle set), `purchase.repository.ts` (`listDocumentPage`, `findDocumentById`, tenant predicate), `purchase.dto.ts` (`status`/`requesterId`/`search`/window + page ceiling), `purchase.service.ts` (list/detail + `serialize` wire projection; money as exact strings), `purchase-timeline.service.ts` (audit read + seven-field projection), `purchase.controller.ts` (route chain + `commerce.read` remit), `commerce-actor.ts`, `commerce.constants.ts` (module/feature ids, `PURCHASE_DOCUMENT` audit resource, page pair) |
| Source data model | `prisma/commerce/schema.prisma` — `PurchaseDocument` columns (NO domain `requestDate`: only `createdAt`), `PurchaseLine`, tenancy keys, indexes |
| Commerce module wiring | `commerce.module.ts`, `database/commerce-prisma.module.ts`, `commerce-audit.gateway.ts` (`record` + `read`, the platform audit seam), `commerce-gateways.spec.ts` (the I8 gate: port behind ONE surface, module imported at the root), `commerce-isolation.spec.ts` (ownership matrix — `purchaseDocument` written by `purchase.repository.ts` alone) |
| Reporting foundation | `reporting.module.ts`, `reporting.module.spec.ts`, `reporting-isolation.spec.ts`, `src/ai/ai-boundaries.spec.ts` (Reporting's AI-half gates) |
| Financial precedent | `financial/reporting/` (contract + reader + narrow module + reader spec), `reporting/check-request-*` (controller + DTO + service + specs), `test/reporting-check-request-report.e2e-spec.ts`, `docs/reports/PHASE-REPORTING-CHECK-REQUEST-REPORT.md` |
| Architecture gates | `architecture-boundaries.spec.ts` (no cross-module-import rule blocks the seam), the entitlement chain, `auth/rbac/constants/permissions.ts` (the `commerce.read` remit, seeded to SUPER_ADMIN/ADMIN) |
| Existing records | `PHASE-REPORTING-BOUNDED-CONTEXT.md`, `PHASE-REPORTING-UI-UX-FOUNDATION.md`, `PHASE-REPORTING-FIRST-CAPABILITY-EVIDENCE.md` |
| Frontend conventions | `components/commerce/commerce-ui.tsx` (badges, tones, pagination), `commerce-api.ts` + `commerce-labels.ts` (wire mirror + Persian labels), `core-nav.ts` (the `/admin/reporting` title alias, no rail row), `CoreStates.tsx`, the Reporting components and their specs |

## 3. B. Requirement Evidence — CONFIRMED / SUPPORTED / FUTURE / INFERRED / UNSUPPORTED

| Requirement | Classification | Evidence |
| ----------- | -------------- | -------- |
| Read-only register of purchase requests over the tenant's own rows | **CONFIRMED** | `listDocumentPage` is tenant-scoped first; the page window clamps; the precedent contract/service/controller/specs were read line by line |
| Per-status summary over the same filtered population | **SUPPORTED** | Financial `countByStatus` (one `groupBy`) + zero-fill over the closed set; Commerce had NO such method — added here in the same shape |
| Read-only detail for one row | **CONFIRMED** | `findDocumentById(tenantId, id)`; 404-for-foreign semantics in both precedents |
| Read-only timeline per row | **CONFIRMED** | `PurchaseTimelineService` (existence-first 404, `commerce.purchase_document` resource, 7-field whitelist, 503 `AUDIT_READ_FAILED`) + `CommerceAuditGateway.read` |
| Filters `status` + `search` (on `documentNumber`) | **CONFIRMED** | `PurchaseDocumentFilter` and `ListPurchaseDocumentsQueryDto`; DTO validates `status` with `@IsIn(PURCHASE_DOCUMENT_STATUSES)` |
| No `requesterId` filter, no requester display | **SUPPORTED** | Omitted deliberately: a raw actor id has no reporting display contract, exactly as Financial omits `requesterUserId` everywhere |
| `createdAt` on the row | **SUPPORTED** | The one honest deviation: `CheckRequest` has a domain `requestDate`; `PurchaseDocument` has no such column, so the creation instant IS the request date; `updatedAt` stays omitted |
| `lineCount`, money strings, `completedAt`, `kind`, `supplierId`, `currency` | **SUPPORTED** | Derived from columns the SAME reads already load; money crossed the wire as exact strings in `serialize`; `null` keeps meaning "not priced yet" |
| Entitlement `commerce`/`purchase` | **CONFIRMED** | The same pair Commerce's own routes declare; the report is a view over the capability, not a new one |
| Authorization `commerce.read`, no `reporting.*` | **CONFIRMED** | `Permissions.COMMERCE_READ` exists and is seeded; the read remit covers exactly the rows/fields/trail the report exposes |
| Lines on the report row | **FUTURE** | Cut deliberately: the register answers "which documents, in what state"; Commerce's own detail route owns the lines; only `lineCount` crosses |
| Requester/profile enrichment | **FUTURE** | Would pull the identity gateway (→ Core Prisma) into the narrow module; refused as Financial kept its actor columns out |
| Export / scheduling / AI / KPIs / dashboards | **UNSUPPORTED** | No contract establishes them; the isolation suite pins the absence, as before |
| Any new lifecycle state, date filter, or write on the report | **UNSUPPORTED** | Inventing one would be a new vocabulary without a source behind it |

The report never mutates Commerce data, never approves/rejects/edits/completes,
and invents no status, filter, KPI or field. The governing principles held:

```text
TRUSTWORTHY REPORTING > DECORATIVE DASHBOARDS
REPORTING READS COMMERCE TRUTH. REPORTING NEVER BECOMES COMMERCE TRUTH.
ONE REAL REPORT > A SPECULATIVE REPORTING PLATFORM
```


## 4. C. Commerce Purchase Reporting Read Contract

`src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts`, Commerce-owned:

- Token `COMMERCE_PURCHASE_REPORTING_READER`; every method takes `{ tenantId }` FIRST — there is no shape of the port that reads another tenant's rows.
- Query: `status` (the `PurchaseDocumentStatus` union — the pure module, imported by TYPE only) + `search` + `page`/`pageSize`. `requesterId` deliberately ABSENT (§B).
- Row: the twelve-field whitelist — `id`, `documentNumber`, `kind`, `status`, `supplierId`, `currency`, `subtotalAmount`, `taxAmount`, `totalAmount`, `lineCount`, `completedAt`, `createdAt`.
- `CommercePurchaseReportPage`, `CommercePurchaseReportSummary` (zero-filled `byStatus` over the SIX members), the seven-field timeline shapes, the four-method reader interface.

## 5. D. Composition — guards

- **Commerce-owned narrow module** `commerce-purchase-reporting.module.ts`: imports ONLY `CommercePrismaModule` + `PlatformAuditModule`; provides `CommerceAuditGateway`, `PurchaseRepository`, reader, and the token; **exports only the token**. It cannot mount a Commerce route or issue a Commerce write, by construction.
- **Repository**: `PurchaseRepository` gains `countByStatus` (one `groupBy`, returning a `Map` so an absent status is `undefined` until the reader zero-fills it); the tenant predicate was factored into ONE private builder (`buildDocumentWhere`) so the page read and the counts share it verbatim.
- **Reporting**: `PurchaseReportController` under `reporting/commerce/purchase-documents` (full decorator chain: `@RequiresModule(commerce)` → `@RequiresFeature(commerce, purchase)` → `ModuleEntitlementGuard` → `JwtAuthGuard` → `@Roles(COMMERCE_READ)` ×3), `PurchaseReportService` (tenant-first 403, page+summary in parallel, 404s, 503 mapping), `ListPurchaseReportQueryDto` + `PurchaseReportTimelineQueryDto` (the COMMERCE page ceiling, `@IsIn(PURCHASE_DOCUMENT_STATUSES)`).
- **Gate updates** (the documented mechanism — each suite fails on new surface until deliberately widened): `reporting-isolation.spec.ts` (two controllers/services in the exact NON_SPEC list; TWO approved read seams; per-source remit assertions `FINANCIAL_CHECK_READ`/`COMMERCE_READ`; the export/vocabulary gates now loop both surfaces with per-file non-vacuity), `reporting.module.spec.ts` (Commerce Prisma stub; both tokens resolve; neither is re-exported), `commerce-gateways.spec.ts` (I8 keeps the PORT behind exactly one file — `CommerceAuditGateway` — while the MODULE may now appear in exactly the two COMPOSITION ROOTS, with a `.module.ts` shape check so a service importing it still fails).


## 6. E. Security

- **Tenant isolation**: scope is the server-resolved first argument of every seam read; `findDocumentById(tenantId, id)` is the only id lookup; a foreign id is 404 on detail and timeline, never 403; e2e proves tenant B rows never appear in tenant A's register (status-filtered list + detail + timeline).
- **Authorization**: least privilege — gated by `commerce.read`, the same remit as Commerce's register, never a mutation grant; no `RbacModule` imported (the global `RolesGuard` resolves `@Roles` metadata); a client-supplied `tenantId` is 422 (`whitelist` + `forbidNonWhitelisted`), an unknown `status` is 422 at the production pipe (class-validator member refusal maps to `UnprocessableEntityException` — the refusal is what's pinned, not the 400/422 digit).
- **Projection**: the twelve-field whitelist lives in the adapter and is asserted against a raw row (`tenantId`, actor ids, version pins, `updatedAt`, `lines` stay server-side); timeline keeps the existing 7-field whitelist; no raw actor ids are rendered in the UI (no display contract exists for them).
- **Prohibited dependencies (executable)**: no `CommercePrismaService`, no `PurchaseRepository`/`PurchaseService` import from Reporting sources, no Commerce controller/DTO internals (only the pure `purchase-status` type and the module/feature-id constants), no generated client, no `RbacModule`, no notification/search/workflow/scheduler machinery.

## 7. F. Implementation — changed files and purpose (API)

**API — new**

| File | Purpose |
| ---- | ------- |
| `src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts` | The Commerce-owned READ CONTRACT: scope, query (status/search/window), the 12-field row whitelist, summary/timeline shapes, the four-method read-only interface, the DI token |
| `src/modules/commerce/reporting/commerce-purchase-reporting.reader.ts` | The adapter: delegates to `PurchaseRepository` (same tenant-scoped statements) + `CommerceAuditGateway.read`, projects rows onto the whitelist, zero-fills the summary over the six-member set, maps audit rejection to a typed failure |
| `src/modules/commerce/reporting/commerce-purchase-reporting.module.ts` | The NARROW Commerce module Reporting imports: Commerce Prisma + audit port + repository + gateway + reader, exporting ONLY the token. No controllers, no write services, no notification/search/identity/entitlement surface |
| `src/modules/commerce/reporting/commerce-purchase-reporting.reader.spec.ts` | Seam contract: projection (raw row → twelve fields), omission sweep, NULL-totals honesty, tenant forwarding, filter pass-through, COMMERCE window clamp, summary zero-fill, null-for-foreign, empty-vs-rejected timeline, four reads only |
| `src/modules/reporting/purchase-report.dto.ts` | The Reporting wire contract: list query (status/search/page/pageSize, class-validator + COMMERCE page ceiling) and the timeline window |
| `src/modules/reporting/purchase-report.service.ts` | The application: `list` (page + summary in parallel), `getOne` (404 on null), `getTimeline` (existence first, 503 on audit outage) |
| `src/modules/reporting/purchase-report.controller.ts` | The three GETs under `reporting/commerce/purchase-documents`, full chain (`@RequiresModule` → `@RequiresFeature` → `ModuleEntitlementGuard` → `JwtAuthGuard` → `@Roles(commerce.read)`) |
| `src/modules/reporting/purchase-report.service.spec.ts` | Scope/filter pass-through, summary attached, 404 mappings, projection not re-widened, 503 mapping, read-only surface, fail-closed without tenant |
| `src/modules/reporting/purchase-report.controller.spec.ts` | Exactly three GET handlers, one `@Roles(commerce.read)` each, no mutating decorator |


**API — modified**

| File | Change |
| ---- | ------ |
| `src/modules/commerce/purchase/purchase.repository.ts` | + `countByStatus` (one bounded `groupBy`); the tenant predicate factored into ONE shared builder (`buildDocumentWhere`) so page and counts cannot disagree |
| `src/modules/reporting/reporting.module.ts` | Composes the entitlement gate, BOTH approved read modules; registers both controllers + services |
| `src/modules/reporting/reporting-isolation.spec.ts` | TWO contracts' gates: exact 8-file source list, two approved read seams, per-source remit assertions, both surfaces under the vocabulary + no-export gates |
| `src/modules/reporting/reporting.module.spec.ts` | Stubs `CommercePrismaService`; asserts BOTH read tokens + controllers resolve through the real module graph; asserts neither token is re-exported |
| `src/modules/commerce/commerce-gateways.spec.ts` | I8: the PORT stays behind exactly one file while the MODULE appears in exactly the two COMPOSITION ROOTS, with a `.module.ts` shape check |
| `test/reporting-purchase-report.e2e-spec.ts` | The vertical slice, end to end (13 tests: register+summary, tenantId refusal, bad-status refusal, status/search filters, empty page, cross-tenant 404s, 12-field projection, unknown id 404, authoritative timeline, 403/401, no write route) |

**Web — new/changed**

| File | Purpose |
| ---- | ------- |
| `src/lib/purchase-report-api.ts` | The client mirror of the three GETs; 12-field row type; statuses, summary/timeline shapes; no write/export/AI method |
| `src/lib/commerce-labels.ts` | + `commercePurchaseAuditActionLabel` (trail verbs → product language; unknown verbs fall through, never hidden). **Reworded once during the run**: the first draft used the UI-5-refused bare term («سند خرید») and a Close-control word («بستن سند») — the final Commerce honesty gate failed, exactly as designed, and the map now says «تکمیل سند درخواست خرید» (a state change, not a button). |
| `src/components/reporting/PurchaseReportView.tsx` | The report workspace: identity, filter bar (status + document-number search), summary strip (chips = the status filter), table (number/kind/status/total/lines/date), pagination, loading/empty/error/forbidden states |
| `src/components/reporting/PurchaseReportDetailView.tsx` | The read-only detail: identity, totals, status, completion, back link; no mutation |
| `src/components/reporting/PurchaseReportTimeline.tsx` | The flow section: this document's audit timeline only, fetched on demand, outage → retry |
| `src/app/admin/reporting/purchase-requests/page.tsx` | The register route |
| `src/app/admin/reporting/purchase-requests/[id]/page.tsx` | The detail route (async params, metadata) |
| `src/components/core/core-nav.ts` | `PAGE_TITLE_ALIASES` entry for the new route (no rail row, per precedent) |
| `src/components/reporting/__tests__/PurchaseReportView.spec.tsx` | 17 tests: identity, server filters, authorization gate, summary-from-API, row vocabulary, dash-for-unpriced, links, filters-from-bar-and-chips, empty/error/skeleton states, scope protection |

**Not changed**: any Prisma schema or migration (none needed), any Commerce
route/service/rule, RBAC constants, `PermissionDomain`, the AI seam, the
`/admin/reporting` landing.


## 8. G. Verification — exact commands and actual results

Ran against the Docker stack (postgres/redis/minio/rabbitmq up; the e2e harness boots
the REAL combined runtime from source and migrates all six datasources itself).

| # | Gate | Command (repository root unless noted) | Result |
| - | ---- | -------------------------------------- | ------ |
| 1 | API typecheck | `apps/api: tsc --noEmit -p tsconfig.json` | **PASS** — exit 0 |
| 2 | Web typecheck + full suite | `apps/web: tsc --noEmit` (exit 0) + `jest --silent` | **PASS** — **107 suites / 1798 tests** (incl. 17 new + the UI-5 gate) |
| 2b | Web UI-5 honesty gate (Commerce) | `apps/web: jest CommerceFinalHonesty` | **PASS after 1 fix** — 15 tests; the report's `commerce-labels.ts` audit map initially used the gate-refused bare term + a Close-control word; reworded inside the gate (see §7) |
| 3 | Reporting + Commerce-adapter unit | API: `jest --runInBand src/modules/reporting src/modules/commerce/reporting src/modules/commerce/commerce-gateways.spec.ts src/modules/commerce/commerce-isolation.spec.ts` | **PASS** — 7 suites / 56 tests |
| 4 | Commerce regressions | API: `jest --runInBand src/modules/commerce` | **PASS** — 48 suites / 726 tests (incl. the 11 new reader tests + the widened I8 gate) |
| 5 | Full API unit suite | API: `jest --runInBand` | **PASS** — **255 suites / 4106 tests** (before formatting-only passes; no logic touched since) |
| 6 | Report e2e | API: `jest --config ./jest-e2e.json --runInBand test/reporting-purchase-report.e2e-spec.ts` | **PASS** — **13/13** (register+summary, 422 tenantId, 422 bad status, status filter, search filter, empty page, cross-tenant 404 ×3, 12-field projection + exact amounts, unknown-id 404, timeline whitelist, 403 ×3, 401, no-write ×3) |

**Failure classification: INTRODUCED — none (two e2e assertions corrected during the
run, both RECORDED: unknown-status expects 422 not 400 per the production pipe; money
expects exact amounts numerically because the driver trims trailing zeros).
PRE-EXISTING — none touched. ENVIRONMENT — PG reachable only via the
`localhost:5544` e2e proxy (direct 5432 down); e2e used it by default.**


**During the run, two gates caught two real violations (both fixed, both recorded):**
both are cross-module honesty rules firing exactly as designed — see §6.

## 9. H. UX review

- **Desktop/laptop**: heading → report identity → filter bar → summary strip → table;
  calm, one scroll, table primary. Theme-resolved ERP tokens in both themes; status
  tone classes identical to Commerce's own badges.
- **Tablet**: مبلغ/اقلام collapse below `md:`; filter bar wraps.
- **Mobile**: نوع hides below `sm:` (document-number link stays the tap target); chips
  wrap; two-button pagination with a Persian counter.
- **RTL**: document dir inherited; semantic table (`caption`, `scope`, `aria-busy`,
  `aria-pressed` on chips); keyboard-native links/buttons; status labels are
  text-first (tone is the redundant channel).
- **States verified by test**: initial skeleton with no fake digits, compact summary
  placeholders, filter-scoped empty, Persian error + retry, forbidden without the read
  remit, rows persist during refetch.
- **Detail**: identity, totals, status, completion, back link; on-demand flow; 404
  sentence; no mutation affordance (spec-pinned); unpriced documents render a dash,
  never a zero.
- **Terminology**: «درخواست خرید» / «سند» everywhere — DTOs, headings, tests, this record.

## 10. I. Remaining gaps

| Classification | Item |
| -------------- | ---- |
| **implemented** | The second Reporting capability end to end: seam, use case, three GETs, register + summary + detail + flow, guards, tests, e2e, this record |
| **intentionally deferred** | Export (Excel/PDF/CSV); scheduling/sharing; processing-time/SLA (working-hours semantics were never defined); AI summaries (gateway offers embed only); report builder / cross-domain dashboard |
| **future** | A THIRD report's seam (same pattern, third allowlist entry); views beyond `status`+`search`; supplier RESOLUTION (still opaque); requester/profile enrichment (needs a display contract first — no per-row lookups today); line-level content on the detail (the register deliberately stops at `lineCount`) |
| **unsupported** | Any KPI formula, rate, growth, money aggregation, manager-performance metric; dashboards/widgets; any new lifecycle state or write on the report |
| **blocked** | AI text generation (no implemented provider); cross-context data without a source-owned contract |

## 11. J. Commit

- Feature commit: **`6d2723e`** — `feat(reporting): finalize commerce
  purchase reporting slice` (this file's header carries the feature commit).
- Documentation commit: `docs(reporting): record reporting slice commit
  hashes` (this file's header and §J updated with the real hashes).

The governing invariant held, twice now: **ONE REAL REPORT > A SPECULATIVE
REPORTING PLATFORM.**
