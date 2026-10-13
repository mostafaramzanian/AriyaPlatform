# PHASE-KPI-RUNTIME-UX — the read-only KPI surface in Persian/RTL

## 1. What was built and why it is shaped this way

`GET /kpis` and `GET /kpis/:technicalKey` compute values; `KPI-CATALOG.md` defines them.
The web surface renders them. The phase's governing insight — inherited from the runtime
contract — is that every KPI number arrives with its own qualifiers: an availability, an
absence reason, a data-readiness word (never a performance verdict), and the supporting
context that explains the cohort. A screen that dropped any of those four would let a
“measure of how long BOM decisions took” read as “BOM decisions are slow”, which is exactly
the `NOT_ASSESSED` / `NOT_DEFINED` design.

Concretely, this phase adds:

- `apps/web/src/lib/kpi-api.ts` — the two fetches plus the exact CLOSED unions echoed from
  `kpi-runtime.contract.ts` (`KPI_READ_REMITS`, `canReadAnyKpi`, the `jy`/`jm` query builder).
- `apps/web/src/lib/kpi-labels.ts` — every closed code point rendered as a Persian sentence,
  kept apart from the wire exactly like `production-labels.ts`. `kpiQualityClassificationLabel`
  deliberately does NOT turn `GREEN`/`YELLOW` into praise or blame; that job is
  `KPI_PERFORMANCE_NOTE`, rendered under every figure.
- `KpiListView` at `/admin/kpis` and `KpiDetailView` at `/admin/kpis/[key]` — thin server
  pages (`page.tsx` hosts, view owns fetch) following the established
  `ProductionReportView` kitchen: `h2` below the shell `h1`, `core-card`, `CoreStates`,
  `toPersianDigits` at the edge, `encodeURIComponent` on the key.
- A first-class rail destination — `CORE_NAV` row with a `Gauge` glyph (`/admin/kpis`,
  title «شاخص‌های کلیدی عملکرد»), unlike the Reporting routes which deliberately have
  none. A KPI overview is a management destination of its own, not a register of another
  module, so it is discoverable rather than reachable only by URL.

## 2. The union gate — why `anyOfPermissions` exists on both sides

Single `permission` strings answer one question, but the five approved KPIs read from three
domains: Production, Commerce and Financial. Gating the rail row on any ONE remit would hide
the page from exactly the callers the backend serves (a Commerce-only reader must reach the
page), and gating it on none would show it to callers it refuses.

So this phase introduces `CoreNavItem.anyOfPermissions` (and its server mirror,
`NavTarget.anyOfPermissions` in `nav-catalogue.ts`): the row renders — and the href may be
stored as a favourite — when the caller holds ANY of the three read remits:

- `production.bom.read`, `commerce.read`, `financial.check.read`

Both layers stay presentation-only: the list routes re-ask the same union behind
`@Roles(...)` plus a per-definition permission AND entitlement check, and their 403 stays
decisive. `kpi-runtime.controller.ts` needs no change (its `KPI_READ_REMITS` is the
authority), and the 49K drift test stays entry-for-entry because `/admin/kpis` was added to
`SERVER_NAV_TARGETS` in the same step as `NAV_TARGETS`.

## 3. Period honesty — the label is the server's month

The list view never trusts a browser clock. `period` state starts `null`, meaning “server,
pick the current month”; the picker renders `monthName` + year from the RESPONSE's
`period`, and prev/next/current send explicit `jy`/`jm` (or an empty object) back to
`GET /kpis`. The label a screen shows and the cohort the seam filtered on are therefore the
same two instants by construction.

## 4. Quality is data readiness; performance is never assessed

Every card and the detail quality panel render three things and ONLY three things:

- the readiness badge («داده: ناقص» / «کامل» / «ارزیابی نشده»),
- `KPI_PERFORMANCE_NOTE` — the sentence that keeps a data-quality colour from becoming a
  verdict,
- the unconditional target/threshold rows («هدف: تعریف نشده», «عملکرد: ارزیابی نشده»).

Absence renders as an em dash with its own reason sentence; zero digits never stand in for
“nothing existed”. The specs pin both rules.

## 5. Cross-app pinning — the web restates, the specs prove it

`apps/web` cannot import from `apps/api`, so `KPI_READ_REMITS` is restated in `kpi-api.ts`
the same way `nav-catalogue.ts` restates the nav tree. It stays honest the same way:
`kpi-api.spec.ts` reads `kpi-runtime.controller.ts` and `permissions.ts` OFF DISK and
asserts the two lists agree member for member, so a drifted hand-copy fails with both
sides printed rather than a blank rail row at runtime.
