# Phase MANAGEMENT-DASHBOARD-V1 — Implementation Report

Status: **NOT COMPLETE** (browser E2E baseline rerun: exit 1, 11/14 PASS, 3 BLOCKED; see Verification).

Scope: corrective pass of `/admin/management` against `docs/reports/PHASE-DASHBOARD-PRODUCT-DECISION.md`.
The Product Decision is unchanged.

## What changed

- `apps/web/src/components/management/ManagementDashboardView.tsx` rewritten (frontend composition only; no new API, cache, polling or backend).
- `apps/web/src/components/management/__tests__/ManagementDashboardView.spec.tsx` rewritten (26 tests).

### Permission gate (presentation only; every source re-authorizes on the server)

| Caller remit | Requests issued |
|---|---|
| `production.bom.read` | KPI, Production status |
| `commerce.read` | KPI, Commerce status, Commerce queue |
| `financial.check.read` | KPI, Financial status |
| `hr.mission.approve` | HR queue only (no KPI; HR is not a KPI read remit) |
| none of the four | zero requests; page-level forbidden state |

A card the caller lacks is not mounted and issues nothing. RBAC still loading issues nothing. A source 403 after an issued request shows the card FORBIDDEN state.

### Error mapping

403 → FORBIDDEN; 404/405 → UNAVAILABLE; 5xx, network, or any other failure → ERROR with a per-card retry. A 500 is never shown as UNAVAILABLE. A non-ready card is never rendered as zero.

### KPI card

Uses server values only: `display`/`value`, `unit`, `period` (including `completed` → `در جریان`), `quality.readiness`, `availability`/`unavailableReason`, and the server `comparisons` map via the existing `kpi-labels` helpers. An unavailable KPI renders `—` with its reason, never `۰`. No browser-side comparison is computed. Each KPI links to `/admin/kpis/[key]`.

### Refresh and time semantics

One `بروزرسانی` control re-queries only the currently issued cards. No polling, timers or cache. The scope line states the KPI month is the server-resolved current month and other cards are `وضعیت فعلی`.

### Queues and copy

Two queues show a count only (no inbox rows). Labels: `در انتظار تصمیم بازرگانی`, `در انتظار تأیید مأموریت`, `وضعیت درخواستهای چک`, `وضعیت اسناد خرید`, `وضعیت ساختارهای BOM`, `شاخصهای کلیدی — ماه جاری`.

### Footer shortcuts

`/admin/kpis`, `/admin/reporting`, `/admin/reporting/purchase-requests`, `/admin/reporting/production`. Navigation only.

### Financial drill-down

The Financial card drills to `/admin/reporting`, which is the Financial check-request register/index. No `check-requests/page.tsx` and no redirect were added. No rail row exists for it.

## Known limitations (V1)

- **HR queue fetches full pending rows and counts them client-side.** The source service also performs an N+1 `findRequestById` after loading active steps. A count-only source contract needs explicit approval and was not added.
- Status cards use the first page (`pageSize: 1`) and the report's own server `summary.byStatus`.
- The KPI card reads only the current month; history is out of scope for this dashboard.

## Verification (gates from the earlier full-verification pass; NOT re-run in the latest pass)

Commands ran from the repo root with the hoisted `E:\ERP\node_modules\.bin` binaries. Exit codes for the gates above were recorded from each command's own run log. The browser E2E exit code is taken from a detached run that wrote its numeric exit value to `.tmp/mgmt-baseline-rerun.exit` (value `1`). Earlier notes that said the exit code was not captured are superseded by this line.

| Check | Command | Result | Evidence |
|---|---|---|---|
| Dashboard component spec | `jest src/components/management` (web) | **FRESH PASS, exit 0**, 26/26 | 1 suite, 26 tests |
| `core-nav.spec.ts` | `jest src/components/core/__tests__/core-nav.spec.ts` (web) | **FRESH PASS, exit 0**, 40/40 | 1 suite, 40 tests |
| `kpi-api.spec.ts` | `jest src/lib/__tests__/kpi-api.spec.ts` (web) | **FRESH PASS, exit 0**, 12/12 | 1 suite, 12 tests |
| Focused web suites (reporting, kpi, lib/kpi, management) | `jest src/components/reporting src/components/kpi src/lib/kpi src/components/management` (web) | **FRESH PASS, exit 0**, 21 suites / 256 tests | `Test Suites: 21 passed`, `Tests: 256 passed` |
| Web TypeScript | `tsc --noEmit` (web) | **FRESH PASS, exit 0**, no output | empty log |
| API architecture + reporting + preferences | `jest --runInBand src/architecture-boundaries.spec.ts src/modules/reporting/reporting-isolation.spec.ts src/modules/reporting/reporting.module.spec.ts src/preferences/preference.service.spec.ts` (api) | **FRESH PASS, exit 0**, 4 suites / 90 tests | `Test Suites: 4 passed`, `Tests: 90 passed` |
| `git diff --check` | `git diff --check` | **FRESH PASS, exit 0** | only CRLF working-copy notices, no whitespace errors |
| Web production build | `next build` (web) | **FRESH PASS, exit 0** | `✓ Compiled successfully`; 76/76 static pages; `/admin/management` in route table; `blog-api fetch failed` log line is unrelated and build still exits 0 |
| API domain isolation (Commerce, Production, Financial, HR) | `jest --runInBand src/modules/commerce/commerce-isolation.spec.ts src/modules/production/production-isolation.spec.ts src/modules/financial/financial-isolation.spec.ts src/modules/hr/hr-isolation.spec.ts` (api) | **FRESH PASS, exit 0**, 4 suites / 65 tests | `Test Suites: 4 passed`, `Tests: 65 passed` |

Earlier session recorded 6 isolation suites / 93 tests, which is a different grouping; it is HISTORICAL and not re-observed in this pass. Browser E2E is run 7 (below).
| Browser E2E harness (`apps/web/phase-management-dashboard-v1-browser-e2e.mjs`, baseline rerun, log `.tmp/mgmt-baseline-rerun.log`) | **Exit code 1** (from `.tmp/mgmt-baseline-rerun.exit`). `SUMMARY: 11/14 PASS`. E2E-06 PASS. E2E-07, E2E-09.404-405, E2E-09.500 BLOCKED. Per-ID results in the E2E section below. |

The earlier run 7 log (`.tmp/mgmt-baseline-run.log`) reported the same per-ID results but has no captured exit code, so it is not cited as an exit-code result.

## Not verified

- **Browser E2E (run 7, observed):**
  - PASS: E2E-01, E2E-02, E2E-03, E2E-04, E2E-05 (ready-zero only), E2E-06, E2E-08, E2E-09 (refresh only), E2E-10.kpi, E2E-10.queue-commerce, E2E-10.queue-hr.
  - BLOCKED: E2E-07 (live 403 isolation). Each source's `@Roles` remit equals the remit that issues its card, so no seeded actor reaches a live 403 without a permission change or mock. Source inspection is not live verification.
  - BLOCKED: E2E-09.404-405. No legitimate authorized route or state yields these for an issued card.
  - BLOCKED: E2E-09.500. Producing a 5xx would require a mock or artificial failure.
- **Four-remit union: UNVERIFIED.** No seeded actor holds all four remits. E2E-01 covers only the production remit and does not prove composition for a multi-remit actor.
- **Non-zero HR queue count: UNVERIFIED.** E2E-05 covers only the linked HR actor's ready-zero state (no pending mission in the tenant).
- **E2E-10 data exposure: LIMITED.** The queue check counts row elements (`table tbody tr`, `ul li`) and asserts count-or-empty. It does NOT prove that names, IDs, amounts, or other sensitive fields are absent from the rendered page.
- **Fixtures:** run-scoped fixtures (HR employee link, temporary users, role grants) are still present and have NOT been cleaned up. Cleanup needs separate authorization.
- **Verification gates are from the earlier full-verification pass and were NOT re-run in the latest pass.** Treat them as historical results. They do not cover the browser E2E outcome, which stays as listed above. Phase completion is not claimed on the gates or the browser run alone.
- The first `next build` run prints a `blog-api fetch failed` line during static generation. It is unrelated to this page; the build still exits 0.

### Role assignment: audit, cache, and token effects (source-verified, not live-verified)

Read from `apps/api/src/auth/rbac/services/role.service.ts` and `apps/api/src/common/audit.service.ts`. No endpoint was called.

- **`assignRoleToUser`** (line 55): creates `UserRole`, then calls `permissionService.invalidateUserPermissions(userId)` (line 101), increments `User.tokenVersion` (lines 103–107), publishes `rbac.role.assigned` (line 110), then calls `emitAudit` (line 118).
- **`removeRoleFromUser`** (line 132): same pattern. It invalidates the permission cache (line 164), increments `tokenVersion` (lines 166–169), publishes `rbac.role.removed` (line 173), then calls `emitAudit` (line 181).
- **`emitAudit`** (line 29) calls `AuditService.log`. That writes a Core `AuditLog` row (`prisma.auditLog.create`, audit.service.ts line 81). The audit service comments also mention a retry record keyed by `AuditLog.id`. **`AuditOutbox` is not confirmed**; `AuditDispatch` is the name in the comment and was not fully traced.
- **Caveat:** `AuditService` is injected with `@Optional()`. If it is not provided at runtime, `emitAudit` returns without writing. Provider wiring is confirmed in source: `RbacModule` lists `AuditService` in both `providers` and `exports` (`apps/api/src/auth/rbac/rbac.module.ts`, lines 40 and 48). An audit row for a given call is still **UNVERIFIED** until a live row is observed.
- **Cache:** `invalidateUserPermissions` deletes the `user:permissions:` key (permission.service.ts line 145–147). The cache TTL is confirmed at 15 minutes (`permission.service.ts` line 25). The `tokenVersion` claim is parsed in `apps/api/src/platform/auth/token-verifier.ts` (line 219). Whether the HTTP guard rejects a stale claim was not traced, so forced re-authentication is **UNVERIFIED**.
- **Consequence for the four-remit test:** a raw SQL change to `UserRole` would bypass both invalidation and `tokenVersion`. Any future mutation must use these service paths, not direct SQL.

### Fixture credentials

`.tmp/dashboard-e2e-fixtures.json` (2544 bytes) exists. It holds `tenantId`, `runId`, five `actors`, four `temporaryRolePermissions`, and `originalRoleUserCounts`. Its actor entries include plaintext test passwords, so the file is a live credential risk. It was not modified. Proposed handling, pending separate authorization: rotate the five run-scoped actor passwords through the application's password-reset or admin path, then delete the plaintext file. Other users' credentials are out of scope.

Read-only state check (SELECT only, no credential values printed): all five run-scoped actors exist, have status `EMPLOYEE`, `tokenVersion` 1, and exactly one `UserRole`. The HR actor has one ACTIVE `Employee` row in `hr_db` (`user_id` = the actor id), so the HR link exists. The actors also hold 122 `AuditLog` rows and 122 `RefreshToken` rows. Those rows are not cleaned up.
