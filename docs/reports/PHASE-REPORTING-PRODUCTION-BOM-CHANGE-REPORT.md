# PHASE-REPORTING-PRODUCTION-BOM-CHANGE-REPORT — Production BOM Change Request Status Report

**Report:** «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)»
**Route:** `GET /api/v1/reporting/production/bom-change-requests` (+ `:id`, `:id/timeline`, `export/xlsx`, `export/docx`)
**Web:** `/admin/reporting/production/bom-change-requests` (+ `/[id]`)
**Status:** implemented, verified, committed (hashes in §13).

## 1. Mission and outcome

Expose the existing Production BOM Change Request business capability through the
Reporting bounded context as a complete, read-only, tenant-safe reporting slice that
answers: _what BOM changes have been requested, what state is each request in, and how
has each request moved through its lifecycle?_

No Production business behavior was implemented, no lifecycle was modified, no second
workflow or status vocabulary was created, no generic framework was built, and no
platform P0 hardening item (CI/E2E release gate, audit outbox, cross-context
integration policy) was touched — see §12.

## 2. Preflight evidence (repository-authoritative)

Source implementation inspected before any change (`HEAD b0e02340`, clean tree):

| Fact                                                                                                                                         | Evidence                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four-state lifecycle `DRAFT/SUBMITTED/APPROVED/REJECTED`; correction is a transition back to `DRAFT`                                         | `apps/api/src/modules/production/bom-change/bom-change.ts` (re-exports `bom-status.ts`; `REQUEST_CORRECTION` lands on the editable state)                               |
| Register filters `bomId/projectRef/status/search/page/pageSize`; no `tenantId`/`requesterId` on the wire                                     | `bom-change.dto.ts` (`ListBomChangeRequestsQueryDto`); `resolveProductionActor(req)`                                                                                    |
| One row = one `BomChangeRequest` (+ bounded `_count` possible); detail rows = `BomChangeRequestItem` with source-owned coefficient snapshots | `prisma/production/schema.prisma` (`model BomChangeRequest`, `model BomChangeRequestItem`); `bom-change.repository.ts` (`findItemById`, `listItems`, `countForRequest`) |
| Tenant-first repository (`tenantId` first arg of every method, `findFirst` never `findUnique`)                                               | `bom-change.repository.ts` class doc + methods                                                                                                                          |
| Audit trail: nine families, all with `resourceId = <change request id>`                                                                      | `production.constants.ts` (`BOM_CHANGE_REQUEST: 'production.bom.change'`); `bom-change.service.ts` (`PRODUCTION_BOM_CHANGE_AUDIT_ACTION.*`)                             |
| Permissions `production.bom.read/manage/approve`; entitlement `production`/`bom`                                                             | `bom-change.controller.ts` (no new permission invented)                                                                                                                 |
| Reporting seam precedent (one narrow module per report)                                                                                      | `production/reporting/production-reporting.{contract,reader,module}.ts`; `reporting-isolation.spec.ts`; `reporting.module.ts`                                           |
| Source UI terminology                                                                                                                        | `apps/web/.../ProductionBomChangeListView.tsx` («جستجو بر اساس عنوان», «پروژه», «شناسه BOM»)                                                                            |

## 3. Seam decision: a second Production token, recorded

§4 of the phase required a determination whether one Production reporting module can
expose multiple narrow tokens. The evidence answered: **no**. `ProductionReportingModule`
is the BOM HEADER's seam (header rows, header vocabulary, `production.bom` audit
resource) and is additionally consumed by KPI runtime cohort reads; widening it with a
change-request token would give one interface two aggregate shapes and two audit
resources. Following the one-narrow-module-per-report precedent, this phase composes a
second Production-owned narrow module beside the first, exports its token only, and
weakens no isolation guard (the Reporting isolation suite still refuses every
non-token Production import — verified green, §9).

## 4. Projection whitelist (exact, final)

`ProductionBomChangeReportRow` — **eleven fields**:

```text
id · bomId · title · projectRef · productTreeRef · status · managerOpinion ·
itemCount · submittedAt · decidedAt · createdAt
```

Withheld by construction: `tenantId`, `requesterUserId`, `approverUserId`,
`decidedByUserId`, `notes`, `requestDate`, `updatedAt`, every relation object, and ALL
detail-row coefficient snapshots (`itemCount` is the only line fact that crosses).
Asserted against a raw row in `production-bom-change-reporting.reader.spec.ts` and
byte-exact in E2E (`reporting-production-bom-change-report.e2e-spec.ts`).

Detail (`GET :id`) returns the same row — no coefficient rows, no mutation controls.

## 5. Filters (evidence-backed, closed)

| Filter            | Semantics                                                                                        | Source proof                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bomId`           | exact `Uuid` column match; 422 on malformed                                                      | register DTO `@IsUUID('4')`; schema `@db.Uuid`; index `[tenantId, bomId]`                  |
| `projectRef`      | EXACT (not fuzzy) string match on the opaque reference copied off the BOM                        | register `where.projectRef =` (no `contains`); `bom-change.dto.ts` (no FK, no prefix rule) |
| `status`          | `IsIn(BOM_STATUSES)` — the closed four                                                           | `bom-status.ts` (single authority)                                                         |
| `search`          | fuzzy `contains` over `title` ONLY                                                               | register `where.title = { contains }`; title is the source's one free-text column          |
| `page`/`pageSize` | `PRODUCTION_MAX_PAGE_SIZE` contract + reader clamp; deterministic order `createdAt desc, id asc` | `production.constants.ts`; `list()` orderBy                                                |

No `requester`/`approver`/`decidedBy` filter (no display contract for an opaque actor
id — rejected by design on the screen, not just absent), no tenant field, no date
range, no sort parameter. The web `bomId` field validates UUID-v4 client-side so a
typo is a field message, not a 422. Empty `search` is dropped ("no search").

## 6. Summary, status semantics, timeline, audit failure

- **Status vocabulary:** exactly `DRAFT/SUBMITTED/APPROVED/REJECTED`. No
  `NEEDS_CORRECTION`/`CORRECTION`/`REOPENED` row exists on the surface; summary chips
  and chart buckets iterate `BOM_STATUSES` only.
- **Summary:** `{ total, byStatus }` over the SAME effective predicate as the list
  (one `groupBy` on `buildListWhere` shared with `list`), zero-filled over the closed
  set. No rates, durations, aging, SLA or KPI of any kind.
- **Timeline:** `GET :id/timeline` — existence proved tenant-scoped first (404 for
  foreign), then `ProductionAuditGateway.read` with
  `resource = 'production.bom.change'`, `resourceId = <request id>` — the same trail
  Production's own route reads. No inferred events, no `updatedAt` reconstruction.
- **Audit failure:** rejected read re-thrown with closed code; the Reporting service
  maps `AUDIT_READ_FAILED` → **503**, everything else re-thrown untouched.

## 7. Authorization, entitlement, tenant isolation

- **Permission:** existing `production.bom.read` on all five handlers — minimum remit,
  no `reporting.*` invention (same reasoning as the four siblings).
- **Entitlement:** `production` + `bom`, identical to Production's own reads.
- **Tenant:** server-resolved only (`resolveReportingActor`); `tenantId` on the wire is
  a 422; every repository method is tenant-first; cross-tenant id → 404
  indistinguishable from missing. Proven both directions in unit and E2E (list, detail,
  timeline, XLSX, DOCX).

## 8. Implementation map (exact file list)

**Production source seam** (`apps/api/src/modules/production/`):

| File                                                       | Role                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bom-change/bom-change.repository.ts`                      | + `BomChangeRequestFilter` (extracted), `buildListWhere` shared predicate, `listWithItemCount`, `findByIdWithItemCount`, `countByStatus`; `list` refactored onto the same predicate (behavior unchanged)   |
| `reporting/production-bom-change-reporting.contract.ts`    | token `PRODUCTION_BOM_CHANGE_REPORTING_READER = 'ProductionBomChangeReportingReader'`, scope/query/row/page/summary/timeline types, 4-method read-only interface                                           |
| `reporting/production-bom-change-reporting.reader.ts`      | adapter: window clamp, conditional filter pass-through, 11-field whitelist projection, zero-filled summary, exists-first timeline bound to `production.bom.change`, `AUDIT_READ_FAILED` re-throw with code |
| `reporting/production-bom-change-reporting.module.ts`      | narrow module: `ProductionPrismaModule` + `PlatformAuditModule`; provides gateway + repository + reader; exports the token only                                                                            |
| `reporting/production-bom-change-reporting.reader.spec.ts` | 12 seam tests: projection, omission sweep, scope, filter vocab, window clamp, zero-fill, null-for-foreign, empty-vs-rejected timeline, resource binding, reads-only                                        |

**Reporting context** (`apps/api/src/modules/reporting/`):

| File                                                        | Role                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `production-bom-change-report.dto.ts`                       | list query + timeline window DTOs (lengths as commented literals, not owner-DTO imports — group C)            |
| `production-bom-change-report.service.ts`                   | list (+summary, parallel), export, getOne, getTimeline (403 fail-closed, 404 not-found, 503 outage)           |
| `production-bom-change-report.controller.ts`                | `reporting/production/bom-change-requests` — five GETs, `production.bom.read`, `production`/`bom` entitlement |
| `presentation/production-bom-change-report.presentation.ts` | export document; status wording aliased (not re-declared) from the BOM report's pinned map                    |
| `*.service.spec.ts` / `*.controller.spec.ts`                | application contract + route metadata tests                                                                   |

**Composition updated:** `reporting.module.ts` (+import/controller/provider);
`reporting.module.spec.ts` (+mount/token non-export assertions);
`reporting-isolation.spec.ts` (fifth file/controller/module/remit/handler lists);
`report-export-labels.spec.ts` (change-request wording pin);
`production-isolation.spec.ts` (floors 29/18 → 33/21); `bom-change.repository.spec.ts`
(report-read describes).

**E2E:** `apps/api/test/reporting-production-bom-change-report.e2e-spec.ts` — 20 tests,
real runtime, unmocked repository, run-scoped data (1 DRAFT / 1 SUBMITTED / 1 APPROVED /
1 REJECTED + tenant-B row), covering every scenario the phase requires (§9).

**Web** (`apps/web/src/`):

| File                                                                             | Role                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/production-bom-change-report-api.ts`                                        | client: statuses tuple, 11-field row/page/timeline types, query builder, fetch ×3, export path                                                                                   |
| `components/reporting/ProductionBomChangeReportView.tsx`                         | register: identity, 4-filter bar (+`bomId` UUID validation state), summary chips, server-summary chart, export buttons, table + pagination, loading/error/empty/forbidden states |
| `components/reporting/ProductionBomChangeReportDetailView.tsx`                   | read-only detail: identity card (BOM ref, project, tree, status, opinion, line count, instants) + on-demand timeline, back link into the report only                             |
| `components/reporting/ProductionBomChangeReportTimeline.tsx`                     | authoritative flow section: loading/error/empty/pagination states                                                                                                                |
| `app/admin/reporting/production/bom-change-requests/page.tsx`                    | list route (static segment beside `[id]` — static wins)                                                                                                                          |
| `app/admin/reporting/production/bom-change-requests/[id]/page.tsx`               | detail route (async params)                                                                                                                                                      |
| `components/core/core-nav.ts`                                                    | `PAGE_TITLE_ALIASES` entry only (no rail row — 49K drift untouched)                                                                                                              |
| `components/reporting/__tests__/ProductionBomChangeReport{,Detail}View.spec.tsx` | 30 behavior tests: identity, server filters, `bomId` validation, gate, summary/chart honesty, export query propagation, links, states, scope protection                          |

## 9. Verification (actually executed, exact)

| Check                                                                                                           | Result                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Source seam tests (reader 12 + repo 4 new)                                                                      | 12/12, 4/4 PASS                                                                                                                         |
| Reporting unit tests                                                                                            | 128/128 PASS (15/15 suites)                                                                                                             |
| Architecture guards (production isolation + boundaries)                                                         | 33/33 PASS                                                                                                                              |
| Production change-request unit (incl. repository refactor)                                                      | unchanged + new, in API full run                                                                                                        |
| New BOM Change Report E2E (real runtime)                                                                        | 20/20 PASS                                                                                                                              |
| E2E batch: production BOM report, financial check-request, commerce purchase, HR personnel-traffic, KPI runtime | 99/99 PASS (6/6 suites)                                                                                                                 |
| Web focused tests                                                                                               | 30/30 PASS (2/2 suites)                                                                                                                 |
| Web full suite                                                                                                  | 1950/1950 PASS (119/119 suites)                                                                                                         |
| API full unit suite                                                                                             | 4324/4324 PASS (275/275 suites)                                                                                                         |
| API typecheck (`tsc --noEmit`)                                                                                  | PASS                                                                                                                                    |
| Web typecheck (`tsc --noEmit`)                                                                                  | PASS                                                                                                                                    |
| ESLint (touched API files, `--no-fix`)                                                                          | PASS                                                                                                                                    |
| ESLint web                                                                                                      | NOT RUN — `apps/web/.eslintrc.js` crashes at baseline for any file (`Converting circular structure to JSON`, pre-existing config fault) |
| Prettier (`--check`, touched files)                                                                             | PASS (scoped `--write` applied to touched files only)                                                                                   |
| API build (`nest build`)                                                                                        | PASS (no error lines)                                                                                                                   |
| Web build (`next build`)                                                                                        | PASS (compiled; both new routes in the route table; one unrelated pre-existing `blog-api` data-fetch warning)                           |
| `git diff --check`                                                                                              | PASS (exit 0; autocrlf notices only)                                                                                                    |

## 10. Visualization, export, UX

- **Chart:** shared `ReportSummaryChart` (RTL horizontal bars), fed by
  `buildReportChartBuckets(summary.byStatus, PRODUCTION_BOM_CHANGE_REPORT_STATUSES, …)`
  — server summary in, no client recount, no percentages. The screen-level invariant
  holds structurally: one `reportQuery` object derives the list fetch, the chart buckets
  and the export path, so table/chart/file describe the same population.
- **XLSX:** Persian headers `[فهرست مواد (BOM)، عنوان، پروژه، وضعیت، نظر مدیر، تعداد
اقلام تغییر، تاریخ ایجاد]`; `itemCount` stays numeric; title + applied filters +
  summary + rows. **DOCX:** RTL-friendly (`<w:bidi/>`), title, generated timestamp,
  filters, summary, single table — no narrative.
- **Exports share** the controller's `@Roles(production.bom.read)` + entitlement +
  tenant scope (same DTO); cross-tenant export proved in E2E.
- **Web UX:** Persian-first RTL; hierarchy Title → Description → Filters (4) →
  Summary chips → Chart → Export → Table → Pagination; loading skeleton (no fake
  digits), Persian error + retry, filter-scoped empty, forbidden without the read
  remit, rows preserved during refetch, responsive; `bomId` invalid input is an
  `role="alert"` field message with `aria-invalid`, not a request.
- **No write affordance:** no link into `/admin/production/…`, no approve/reject/edit
  vocabulary on the register — spec-pinned by source scan. Terminology follows the
  Production change-request screens exactly.

## 11. Limitations (honest, no commitments)

1. **No coefficient detail:** report shows the change-LINE COUNT only. Per-item
   originals/deltas stay on Production's own detail surface — a deliberate minimal
   projection, not a data gap to "complete later".
2. **`requestDate` withheld:** creation/submission/decision instants answer "when";
   the source's picker-defaulted date is not part of this projection.
3. **`notes` withheld:** free-text internal remarks are not a reporting field.
4. **No per-actor filtering/display:** actor ids have no display contract anywhere.
5. **`projectRef` is exact-match:** the screen labels it «پروژه (مطابقت دقیق)».
6. **No new KPI, no lifecycle model change, no migration** — this phase added zero
   schema/migration/permission/entitlement artifacts.

## 12. P0 platform-hardening boundary (observed, not touched)

Per the phase's `P0 PLATFORM HARDENING BOUNDARY`: this phase implemented NONE of
(1) CI + real-E2E release gate, (2) audit durability / transactional outbox,
(3) cross-context integration policy — and none blocked it:

- **No P0 blocker was discovered.** The Reporting slice completes over the existing
  synchronous audit gateway with the closed `AUDIT_READ_FAILED → 503` contract; no
  stop condition fired.
- **Web ESLint is broken at baseline** (config fault, proved on an untouched file) —
  recorded here as an observed limitation, not fixed opportunistically.
- **Non-blocking observation:** the hard requirement that Reporting DTOs never import
  owner-DTO constants (group C caught `bom-change.dto` import) forces literal
  duplication of column widths with source comments — a known, accepted cost of the
  boundary, not a P0.

## 13. Commits and final git state

Implementation:

```text
feat(reporting): add production bom change request report
9fe65a83727a155218528f38b27fa198610c3f47
```

Documentation:

```text
docs(reporting): record bom change request reporting slice
2ba945cf49d3e3babc21811de9dfaf52522f880b
```

Hash-record commit (`docs(reporting): record bom change request reporting slice
commit hash`, per the repository's convention of recording phase hashes):

```text
Implementation commit:  9fe65a83727a155218528f38b27fa198610c3f47
Documentation commit:   2ba945cf49d3e3babc21811de9dfaf52522f880b
Hash-record commits:    follow in `git log` (a commit cannot record the hash of the
                        commit carrying it — see the portfolio review precedent)
HEAD:                   reported in the phase verification report
Working tree clean:     YES
```
