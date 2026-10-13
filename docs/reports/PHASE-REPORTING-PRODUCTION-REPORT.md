# Phase Report — Reporting Third Vertical Slice: Production Summary & Operational Status Report

> **گزارش خلاصه و وضعیت عملیات تولید**
>
> Implementation commit: **`ed34f6b`** — `feat(reporting): add production operational status report`.
> Baseline before this phase: `2374784` (reporting slice hashes commit, working tree clean).

## 1. What this phase is

The **third end-to-end Reporting capability** in the ERP, mirroring the Financial and Commerce slices one-for-one:

```text
Production source-of-truth (production_db)
        ↓
approved Reporting read contract (Production-owned, read-only, tenant-scoped)
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

> **What is the current status of our BOM documents, how are they distributed across the four-step approval lifecycle, how large is each one, and how has each moved through its existing flow?**

One report row = one **BOM header** (`BomHeader`) — the Production aggregate root that carries the document lifecycle. The report deliberately does NOT model production quantities, completion, cost, efficiency or downtime: the Production schema has no such columns, and inventing them would be fabrication (§10 records these as unsupported).

## 2. A. Pre-flight evidence — files and contracts inspected

| Area                       | What was read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production source contract | `modules/production/bom/` — `bom-status.ts` (the closed four-member lifecycle `BOM_STATUSES` + manager-opinion vocabulary), `bom.repository.ts` (tenant-first `list`/`findById`, `BomHeaderListQuery`, no `findUnique`), `bom.dto.ts` (status/search/window + page ceiling + `BomTimelineQueryDto`), `bom.service.ts` (list/detail/submit/decide + `getTimeline` audit read + `PRODUCTION_BOM_AUDIT_ACTION`), `bom.controller.ts` (route chain + `production.bom.read/manage/approve` remits) |
| Production data model      | `prisma/production/schema.prisma` — `BomHeader` columns (`status`, `managerOpinion`, `submittedAt`, `decidedAt`, `createdAt`, `updatedAt`, opaque refs, actor ids), `BomItem` (the `items` relation the bounded count reads), `BomChangeRequest`                                                                                                                                                                                                                                              |
| Production module wiring   | `production.module.ts`, `database/production-prisma.module.ts`, `production-audit.gateway.ts` (`record` + `read`, the platform audit seam), `production-isolation.spec.ts` (one-controller/one-delegate gates — floors raised by exactly this phase's four seam files)                                                                                                                                                                                                                        |
| Reporting foundation       | `reporting.module.ts`, `reporting.module.spec.ts`, `reporting-isolation.spec.ts`, `src/ai/ai-boundaries.spec.ts` (Reporting's AI-half gates)                                                                                                                                                                                                                                                                                                                                                  |
| Sibling precedents         | `financial/reporting/` + `commerce/reporting/` (contract + reader + narrow module + reader spec), `reporting/check-request-report.*` + `reporting/purchase-report.*`, their e2e specs, `PHASE-REPORTING-PURCHASE-REPORT.md`                                                                                                                                                                                                                                                                   |
| Architecture gates         | `architecture-boundaries.spec.ts`, the entitlement chain (`ModuleEntitlementGuard` + `production`/`bom` grants probed live in `core_db`: tenant-test-1 holds both), `auth/rbac/constants/permissions.ts` (`production.bom.read` seeded to SUPER_ADMIN/ADMIN)                                                                                                                                                                                                                                  |
| Existing records           | `PHASE-REPORTING-BOUNDED-CONTEXT.md`, `PHASE-REPORTING-CHECK-REQUEST-REPORT.md`, `PHASE-REPORTING-PURCHASE-REPORT.md`, `PHASE-PRODUCTION-BOM-AUDIT-TIMELINE-IMPLEMENTATION.md`                                                                                                                                                                                                                                                                                                                |
| Frontend conventions       | `production-api.ts` + `production-labels.ts` (wire mirror + Persian status/opinion/audit-action/date labels — reused, not duplicated), `core-nav.ts` (title alias mechanism), `CoreStates.tsx`, the two sibling components and their specs                                                                                                                                                                                                                                                    |

## 3. B. Requirement Evidence — CONFIRMED / SUPPORTED / FUTURE / INFERRED / UNSUPPORTED

| Requirement                                                        | Classification           | Evidence                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only register of BOM documents over the tenant's own rows     | **CONFIRMED**            | `BomHeader` is the Production aggregate root with a real four-member lifecycle; `list`/`findById` are tenant-first                                      |
| Status vocabulary for filter + summary                             | **CONFIRMED**            | `BOM_STATUSES` = `DRAFT/SUBMITTED/APPROVED/REJECTED` (`bom-status.ts`, pure module, schema enum mirror)                                                 |
| Date semantics                                                     | **CONFIRMED**            | `createdAt` (authored), `submittedAt` (stamped by `submit`), `decidedAt` (stamped by `decide`) — all domain columns, no invented dates                  |
| Summary counts per status over the same filter                     | **SUPPORTED**            | one bounded `groupBy` (`countByStatus`) over the same shared where-builder the page uses                                                                |
| Operational size of each BOM                                       | **SUPPORTED**            | `itemCount` = Prisma's bounded `_count` over the header's own `items` relation, read with the row (a count of rows that exist)                          |
| Authoritative timeline                                             | **CONFIRMED**            | platform audit trail resource `production.bom`; Production's own `/production/boms/:id/timeline` already reads it through `ProductionAuditGateway.read` |
| Date/window filter                                                 | **INTENTIONALLY ABSENT** | the Production list contract has none (`status` + `search` only) — same deliberate absence both sibling contracts record                                |
| Quantities, completion %, cost, efficiency, downtime, quality KPIs | **UNSUPPORTED**          | no such columns exist in `prisma/production/schema.prisma`; not fabricated                                                                              |
| Change-request register (`BomChangeRequest`)                       | **FUTURE**               | a second aggregate with its own report identity; out of this slice's one-row-one-aggregate rule                                                         |
| Export / scheduling / AI                                           | **UNSUPPORTED**          | no backend contract; the isolation suite pins each absence                                                                                              |

## 4. C. Source seam — contract, reader, ownership, tenant behavior

| Seam element          | Value                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token                 | `PRODUCTION_REPORTING_READER` = `'ProductionReportingReader'` (string token, same style as the two siblings)                                                                                                                                            |
| Contract              | `src/modules/production/reporting/production-reporting.contract.ts` — scope, query (`status`/`search`/window), the ten-field row, page/summary/timeline shapes, the four-method read-only interface                                                     |
| Reader                | `src/modules/production/reporting/production-reporting.reader.ts` — `ProductionReportingReaderService`                                                                                                                                                  |
| Narrow module         | `src/modules/production/reporting/production-reporting.module.ts` — imports `ProductionPrismaModule` + `PlatformAuditModule`; provides `ProductionAuditGateway`, `BomHeaderRepository`, the reader and the token binding; **exports the token only**    |
| Ownership             | Production owns contract + reader + repository queries. Reporting imports ONLY the contract path (`../production/reporting/**` + `production.constants` + pure `bom/bom-status`), enforced by `reporting-isolation.spec.ts` group C                     |
| Repository delegation | reader → `BomHeaderRepository.{listWithItemCount, findByIdWithItemCount, countByStatus}` (all tenant-first, all built by ONE shared `buildListWhere` predicate) → `ProductionAuditGateway.read` for the timeline                                        |
| Tenant behavior       | `scope.tenantId` is the first argument of every repository call and is present in every `where`; `getReportRow`/`getReportTimeline` use tenant-scoped `findFirst` (never `findUnique`), so a foreign id is `null` → 404, indistinguishable from missing |

New source-owned repository capability (the smallest the report needed — `bom.repository.ts`, whose charter is "every statement against `production_db`"):

- `listWithItemCount` — the same predicate/order/page pairing as `list`, plus one bounded `_count` over the header's own `items`;
- `findByIdWithItemCount` — the `findById` shape plus the same bounded `_count`;
- `countByStatus` — one bounded `groupBy` over the same predicate (the summary);
- `buildListWhere` — the predicate factored so page, total and summary CANNOT disagree.

## 5. D. Projection, filters, summary, timeline — exact semantics

**Projection (ten fields, whitelist in the reader, asserted three times):**

| Field            | Source                     | Semantics                                                           |
| ---------------- | -------------------------- | ------------------------------------------------------------------- |
| `id`             | `BomHeader.id`             | the BOM's identity                                                  |
| `title`          | `BomHeader.title`          | the header's free-text name (the register's only search column)     |
| `projectRef`     | `BomHeader.projectRef`     | opaque project reference (not resolved — no Project domain exists)  |
| `productTreeRef` | `BomHeader.productTreeRef` | opaque product-tree reference (same rule)                           |
| `status`         | `BomHeader.status`         | one of the four `BOM_STATUSES`                                      |
| `managerOpinion` | `BomHeader.managerOpinion` | `APPROVED`/`REJECTED`/`NEEDS_CORRECTION` or `null` (nobody decided) |
| `itemCount`      | `_count.items`             | bounded count of `BomItem` rows that exist, read WITH the row       |
| `submittedAt`    | `BomHeader.submittedAt`    | ISO instant stamped by `submit` (routing began), or `null`          |
| `decidedAt`      | `BomHeader.decidedAt`      | ISO instant stamped by `decide` (decision recorded), or `null`      |
| `createdAt`      | `BomHeader.createdAt`      | ISO instant the header was authored — the register's date           |

Omitted by name: `tenantId`, `updatedAt` (sort key/bookkeeping), `requesterUserId` / `approverUserId` / `decidedByUserId` (raw actor ids with no display contract), `comments` (free-text detail owned by Production's own detail route), the item lines themselves.

**Filters (both proven by the source list contract):** `status` (`@IsIn(BOM_STATUSES)` — a 422 at the boundary for an unknown member) and `search` (title `contains`, MaxLength 200) + the page window (ceiling `PRODUCTION_MAX_PAGE_SIZE` = 100, enforced by the DTO and clamped again in the reader). NO date/window filter, NO actor-id filter (§3).

**Summary:** `{ total, byStatus }` — per-status counts from ONE `groupBy` over the SAME filters as the list, zero-filled over the closed four-member set so the strip never has a hole. No rates, durations, yields or derived figures. List and summary run in parallel over the identical query object.

## 6. E. Security

- **Tenant isolation**: scope is the server-resolved first argument of every seam read; `findByIdWithItemCount(tenantId, id)` is the only id lookup; a foreign id is 404 on detail and timeline, never 403; e2e proves tenant B's row never appears in tenant A's register and tenant B sees ONLY its own row (positive isolation both directions).
- **Authorization**: least privilege — gated by the EXISTING `production.bom.read` remit (no `reporting.*` permission invented); no `RbacModule` imported (the global `RolesGuard` resolves `@Roles` metadata); entitlement declares the SAME `production`/`bom` requirement Production's own reads declare. A client-supplied `tenantId` is 422 (`whitelist` + `forbidNonWhitelisted`); unknown `status` is 422. e2e: authenticated+authorized → 200, authenticated+unauthorized → 403 (all three routes), unauthenticated → 401.
- **Projection**: the ten-field whitelist lives in the reader and is asserted against a raw row; timeline keeps the seven-field whitelist; no raw actor ids render in the UI.
- **Prohibited dependencies (executable)**: no `ProductionPrismaService`, no `BomHeaderRepository`/`BomHeaderService` import from Reporting sources, no Production controller/DTO internals, no generated client, no `RbacModule`, no notification/search/workflow/scheduler machinery — `reporting-isolation.spec.ts` groups B/C/D/F.

## 7. F. Implementation — changed files and purpose

**API — new**

| File                                                                   | Purpose                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/production/reporting/production-reporting.contract.ts`    | The Production-owned READ CONTRACT: scope, query, the ten-field row whitelist, summary/timeline shapes, the four-method read-only interface, the DI token                                                               |
| `src/modules/production/reporting/production-reporting.reader.ts`      | The adapter: delegates to the three repository reads + `ProductionAuditGateway.read`, projects rows onto the whitelist, zero-fills the summary over the four-member set, re-throws audit rejection with its closed code |
| `src/modules/production/reporting/production-reporting.module.ts`      | The NARROW Production module Reporting imports: Production Prisma + audit port + repository + gateway + reader, exporting ONLY the token                                                                                |
| `src/modules/production/reporting/production-reporting.reader.spec.ts` | Seam contract: projection (raw row → ten fields), omission sweep, scope forwarding, filter pass-through, window clamp, zero-fill, null-for-foreign, empty-vs-rejected timeline, four reads only                         |
| `src/modules/reporting/production-report.dto.ts`                       | The Reporting wire contract: list query (status/search/page/pageSize, class-validator + Production ceiling) and the timeline window                                                                                     |
| `src/modules/reporting/production-report.service.ts`                   | The application: `list` (page + summary in parallel), `getOne` (404 on null), `getTimeline` (existence first, 503 on audit outage)                                                                                      |
| `src/modules/reporting/production-report.controller.ts`                | The three GETs under `reporting/production/boms`, full chain (`@RequiresModule` → `@RequiresFeature` → `ModuleEntitlementGuard` → `JwtAuthGuard` → `@Roles(production.bom.read)`)                                       |

| `src/modules/reporting/production-report.service.spec.ts` | Scope/filter pass-through, summary attached, 404 mappings, projection not re-widened, 503 mapping, read-only surface, fail-closed without tenant |
| `src/modules/reporting/production-report.controller.spec.ts` | Exactly three GET handlers, one `@Roles(production.bom.read)` each, no mutating decorator |
| `test/reporting-production-report.e2e-spec.ts` | The vertical slice, end to end (16 tests, data driven through the REAL Production HTTP API — draft/submitted/approved/rejected + a tenant-B draft) |

**API — modified**

| File                                                  | Change                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/production/bom/bom.repository.ts`        | + `listWithItemCount`, `findByIdWithItemCount`, `countByStatus`; the list predicate factored into ONE shared `buildListWhere` so page/count/summary cannot disagree                                                                                                           |
| `src/modules/production/bom/bom.repository.spec.ts`   | + describes for the three reads: same-predicate pairing, tenant-first even unfiltered, single-statement `_count`, groupBy shape and Map-honesty                                                                                                                               |
| `src/modules/production/production-isolation.spec.ts` | Non-vacuity floors raised 25/15 → 29/18 (exactly this phase's four seam files) — no gate weakened                                                                                                                                                                             |
| `src/modules/production/production-audit.gateway.ts`  | Doc-only: the stale "NO ROUTE CALLS THIS" note on `read()` now records its two real callers (the BOM timeline route + the reporting seam)                                                                                                                                     |
| `src/modules/reporting/reporting.module.ts`           | Composes the entitlement gate and ALL THREE approved read modules; registers the third controller + service                                                                                                                                                                   |
| `src/modules/reporting/reporting.module.spec.ts`      | Stubs `ProductionPrismaService`; asserts the Production read token + controller resolve through the real module graph; asserts the token is NOT re-exported                                                                                                                   |
| `src/modules/reporting/reporting-isolation.spec.ts`   | THREE contracts' gates: exact 11-file source list, three approved read seams (`../production/` added with `production.constants` + `bom/bom-status` suffixes), per-source remit assertions (`PRODUCTION_BOM_READ`), all three surfaces under the vocabulary + no-export gates |

**Web — new**

| File                                                                     | Purpose                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/production-report-api.ts`                                       | The client mirror of the three GETs; ten-field row type; statuses, summary/timeline shapes; no write/export/AI method                                                                                                           |
| `src/components/reporting/ProductionReportView.tsx`                      | The report workspace: identity, filter bar (status + title search), summary strip (chips = the status filter), table (title/project/status/decision/item count/creation date), pagination, loading/empty/error/forbidden states |
| `src/components/reporting/ProductionReportDetailView.tsx`                | The read-only detail: identity, classification, status, decision, item count, dates, back link; no mutation                                                                                                                     |
| `src/components/reporting/ProductionReportTimeline.tsx`                  | The flow section: this BOM's audit timeline only, fetched on demand, outage → retry                                                                                                                                             |
| `src/app/admin/reporting/production/page.tsx`                            | The register route                                                                                                                                                                                                              |
| `src/app/admin/reporting/production/[id]/page.tsx`                       | The detail route (async params, metadata)                                                                                                                                                                                       |
| `src/components/reporting/__tests__/ProductionReportView.spec.tsx`       | 16 tests: identity, server filters, authorization gate, summary-from-API, row vocabulary, dash-for-undecided, links, filters-from-bar-and-chips, empty/error/skeleton states, scope protection                                  |
| `src/components/reporting/__tests__/ProductionReportDetailView.spec.tsx` | 7 tests: row identity/fields, authorization gate, error state, timeline entries in Production words, empty vs outage                                                                                                            |

**Web — modified**

| File                              | Change                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `src/components/core/core-nav.ts` | `PAGE_TITLE_ALIASES` entry for the new route (no rail row, per precedent) |

**Not changed**: any Prisma schema or migration (none needed), any Production route/service/rule, RBAC constants, `PermissionDomain`, the AI seam, the `/admin/reporting` landing.

## 8. G. Verification — exact commands and actual results

All runs on the FINAL (post-format) state, against the live Docker stack (the e2e harness boots the REAL combined runtime from source and migrates all owners itself; `tenant-test-1` production/bom entitlement probed live: member + grant = true).

| #   | Gate                               | Command (from `apps/api` / `apps/web` unless noted)                                                                                         | Result                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API typecheck                      | `tsc --noEmit -p tsconfig.json`                                                                                                             | **PASS** — exit 0                                                                                                                                                                                                                                                                                          |
| 2   | Production unit tests              | `jest --runInBand src/modules/production`                                                                                                   | **PASS** — **19 suites / 288 tests**                                                                                                                                                                                                                                                                       |
| 3   | Reporting unit tests               | `jest --runInBand src/modules/reporting`                                                                                                    | **PASS** — **8 suites / 57 tests**                                                                                                                                                                                                                                                                         |
| 4   | Architecture guards                | `jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts src/prisma-drift-guard.spec.ts`                            | **PASS** — **3 suites / 74 tests**                                                                                                                                                                                                                                                                         |
| 5   | Full API unit suite                | `jest --runInBand`                                                                                                                          | **PASS** — **258 suites / 4133 tests** (baseline was 255/4106)                                                                                                                                                                                                                                             |
| 6   | Production Reporting E2E           | `jest --config ./test/jest-e2e.json --runInBand test/reporting-production-report.e2e-spec.ts`                                               | **PASS** — **16/16**                                                                                                                                                                                                                                                                                       |
| 7   | Financial + Commerce Reporting E2E | `jest --config ./test/jest-e2e.json --runInBand test/reporting-check-request-report.e2e-spec.ts test/reporting-purchase-report.e2e-spec.ts` | **PASS** — **2 suites / 25 tests** (regression: both prior slices green)                                                                                                                                                                                                                                   |
| 8   | Web focused tests                  | `jest --runInBand src/components/reporting/__tests__`                                                                                       | **PASS** — **5 suites / 60 tests** (incl. the 2 new Production suites: 23 tests)                                                                                                                                                                                                                           |
| 9   | Web full suite                     | `jest --silent`                                                                                                                             | **PASS** — **109 suites / 1821 tests** (baseline was 107/1798)                                                                                                                                                                                                                                             |
| 10  | Web typecheck                      | `tsc --noEmit`                                                                                                                              | **PASS** — exit 0                                                                                                                                                                                                                                                                                          |
| 11  | Lint                               | `eslint` (repo config, **no `--fix`**) on the 16 touched `src` files                                                                        | **PASS** — exit 0 (the repo's own lint script scopes `src/**/*.ts`; `test/` is outside `tsconfig.eslint.json` and outside that scope — recorded, not claimed)                                                                                                                                              |
| 12  | Prettier                           | `prettier --check` on all touched files                                                                                                     | **PASS after scoped `--write`** — one PRE-EXISTING baseline failure was in the touched set (`bom.repository.spec.ts` failed the API config AT HEAD, verified at a real path after a vacuous `.tmp` probe was discarded); all other touched files were baseline-clean, so no unrelated region was rewritten |
| 13  | Build                              | `next build`                                                                                                                                | **PASS** — exit 0, "Compiled successfully", **67/67** static pages (baseline 65 + the two new routes)                                                                                                                                                                                                      |

**Failure classification: INTRODUCED — none.** Two eslint findings (an unused import and an unused test constant in the new reader spec) were fixed in-phase; three e2e fixture compile errors (schema-field names read from the wrong precedent — `name` vs `firstName`/`lastName`/`code`, `userRole` vs nested `userRoles`) were fixed to mirror the purchase slice's real fixture code. PRE-EXISTING — none touched (the `[blog-api] ECONNREFUSED` prerender warning on the marketing pages is a pre-existing local-environment warning; the build exits 0 with or without it).

**Timeline:** implemented — authoritative. Existence is proved tenant-scoped first (missing/foreign → empty page WITHOUT touching the audit port), then the SAME platform audit trail Production's own timeline route reads (`resource: 'production.bom'`), projecting the existing seven-field whitelist. A rejected read is re-thrown with the platform's closed code; the Reporting service maps `AUDIT_READ_FAILED` → 503 — an outage never renders as an empty history. No event is ever inferred from a timestamp.

## 9. H. UX review

- **Desktop/laptop**: heading → report identity → filter bar → summary strip → table; calm, one scroll, table primary. Theme-resolved ERP tokens in both themes; status tone classes identical to Production's own BOM badges (existing `productionBomStatusTone`).
- **Tablet**: نظر مدیر / تعداد اقلام collapse below `md:`; filter bar wraps.
- **Mobile**: پروژه hides below `sm:` (title link stays the tap target); chips wrap; two-button pagination with a Persian counter.
- **RTL**: document dir inherited; semantic table (`caption`, `scope`, `aria-busy`, `aria-pressed` on chips); keyboard-native links/buttons; status labels are text-first (tone is the redundant channel); dates through the existing Jalali `productionDateLabel`.
- **States verified by test**: initial skeleton with no fake digits, compact summary placeholders, filter-scoped empty, Persian error + retry, forbidden without the read remit, rows persist during refetch.
- **Detail**: identity (title/project/product tree), status, manager opinion, item count, creation/submission/decision instants, back link; on-demand flow; no mutation affordance (spec-pinned — no `/admin/production/` link, no approve/reject vocabulary in the register source).
- **Terminology**: «گزارش خلاصه و وضعیت عملیات تولید» / «فهرست مواد (BOM)» everywhere — DTOs, headings, tests, this record. The shell header alias reads «گزارش عملیات تولید» (`PAGE_TITLE_ALIASES`, no rail row, per the established precedent).

## 10. I. Remaining gaps

| Classification             | Item                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **implemented**            | The third Reporting capability end to end: Production-owned seam, use case, three GETs, register + summary + detail + flow, guards, tests, e2e, this record                                                                                                                        |
| **intentionally deferred** | Date/window filter (the Production list contract has none — a source contract must come first); export (Excel/PDF/CSV); scheduling/sharing; report builder / cross-domain dashboard; a change-request report (a second aggregate with its own report identity)                     |
| **future**                 | Enrichment of opaque refs (Project/Product Tree resolution needs those domains to exist); requester/approver name display (needs a display contract first — no per-row directory lookups today); item-level content on the detail (the register deliberately stops at `itemCount`) |
| **unsupported**            | Any KPI formula, rate, yield, efficiency, downtime, cost or quality metric; quantities/units at header level (the schema has none); dashboards/widgets; any new lifecycle state or write on the report                                                                             |
| **blocked**                | AI text generation (no implemented provider); cross-context data without a source-owned contract                                                                                                                                                                                   |

## 11. J. Commit

- Feature commit: **`ed34f6b`** — `feat(reporting): add production operational status report` (this file's header carries the feature commit).
- Documentation commit: `docs(reporting): record production reporting slice commit hash` (this file's header and §J updated with the real hash).

The governing invariant held, a third time: **ONE REAL REPORT > A SPECULATIVE FRAMEWORK.** Evidence → narrow source-owned contract → tenant-safe read → Reporting API → polished Persian RTL UI → executable boundary guards → real-runtime E2E → traceable commits. The Production domain decided the projection (ten fields, four statuses, three instants, one bounded count) — not a template borrowed from a sibling.
