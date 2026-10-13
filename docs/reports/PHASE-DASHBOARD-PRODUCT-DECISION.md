# PHASE-DASHBOARD-PRODUCT-DECISION — Executive / Management Dashboard: Product + Architecture Decision

> **Phase type:** PRODUCT + ARCHITECTURE DECISION — **NO dashboard was implemented.**
> No dashboard API, endpoint, DTO, Prisma model, page, card, widget, aggregation service,
> cache, scheduler, builder, DSL, new KPI, new report, AI behavior, or cross-domain Prisma
> join exists or was created in this phase. Allowed changes were documentation only.
> **Baseline:** `HEAD = 1025482ee5c74756477fbf26ae3d39ec39629caa` · Branch `master` ·
> Working tree: only untracked generated `apps/web/next-env.d.ts` (verified with
> `git rev-parse HEAD` and `git status --short` at phase start).
> **Commit strategy:** documentation-only — `docs(platform): define management dashboard product decision`.
> **Succeeds** `docs/reports/PHASE-REPORTING-PORTFOLIO-EVIDENCE-REVIEW.md` (baseline
> `f35b643`), whose candidates #29 Executive Dashboard / #30 Management Dashboard were
> classified `PRODUCT_DECISION` with the instruction «define purpose/owner/sources; see
> section O». This document IS that decision.

## A. Baseline

| Item | Evidence |
|---|---|
| Starting HEAD | `1025482ee5c74756477fbf26ae3d39ec39629caa` — `docs(reporting): document commerce receiving status report` (read from `git log -1`, not assumed) |
| Branch | `master` |
| Working tree at start | clean except untracked generated `apps/web/next-env.d.ts` |
| Previous evidence review exists | ✅ `PHASE-REPORTING-PORTFOLIO-EVIDENCE-REVIEW.md` — §O «Dashboard Review», §M «Cross-Domain Review» |
| Operational Reporting portfolio | ✅ 10 reports, each source-owned (`apps/api/src/modules/reporting/`): Financial Check Request, Commerce Purchase Request, Production BOM Summary, Production BOM Change Request, HR Personnel Traffic, HR Leave Request, HR Mission Request, Commerce Payment History, Commerce Return Lifecycle, Commerce Receiving |
| READY operational Reporting candidates remaining | **0** — evidence review §R «None (0)»; Commerce Receiving, the last READY_WITH_SCOPE_DECISION, was implemented afterwards |
| KPI governance / runtime / history intact | ✅ `kpi-catalog`, `kpi-governance`, `kpi-runtime.{service,period,engine,history,comparison}` all PASS **this phase** (§Verification) |
| P0-B | ✅ CLOSED — `PHASE-P0-PLATFORM-HARDENING-REPORT.md` §«P0-B = CLOSED» |
| P0-C cross-context policy | ✅ ENFORCED — `docs/CROSS-CONTEXT-INTEGRATION-POLICY.md`; `architecture-boundaries.spec.ts` PASS **this phase** |
| Historical hashes | NOT assumed — every claim re-read from the repository at this baseline |

The next architectural question, exactly as the evidence review left it:
**WHAT SHOULD A REAL MANAGEMENT / EXECUTIVE DASHBOARD BE?**

## B. Current Dashboard Inventory (source-first)

Inspected live source, not filenames.

| Surface | Route | What it actually is (source evidence) | Classification |
|---|---|---|---|
| `CoreDashboard` | `/admin` (metadata title «خانه») | Renders `WIDGET_IDS = identity, access, notifications, reminders` (`core-widgets.ts`) in a per-user stored order/visibility (`dashboardLayout` via `GET/PATCH /me/preferences`); one shared `GET /rbac`; code comment: «NO NEW DATA … There is still no KPI, chart or trend on this page»; widgets are «deliberately not a composed `/dashboard` endpoint» | **PERSONAL dashboard** |
| Server widget catalogue | `apps/api/src/preferences/widget-catalogue.ts` | Mirrors client ids; NO permission field by design («renders a PERSONAL surface»); unknown id refused on write, appended on read | personalization (Core-owned) |
| `HrDashboardView` | `/admin/hr` | 4 org counters + 5 recent employees from ONE endpoint (`GET /hr/organization/summary`, `hr.organization.read`) | operational module home (single context) |
| `CommerceHomeView` | `/admin/commerce` | server list totals as counters, task-first; explicitly «No KPI, no spend figure (GAP-4)» | operational module home |
| Financial / Production / Correspondence homes | `/admin/financial`, `/admin/production`, `/admin/correspondence` | module landing surfaces (registers/links), no composed analytics | operational module homes |
| KPI overview + detail | `/admin/kpis`, `/admin/kpis/[key]` | `GET /kpis` (values + server-resolved `previousPeriod` + per-key `comparisons`), `GET /kpis/:key`, `GET /kpis/:key/history`; first-class rail row (`Gauge`), gated on `anyOfPermissions: [production.bom.read, commerce.read, financial.check.read]`; five approved KPIs (KPI-001..005); KPI-006..009 not executable | **KPI surface** |
| Reporting registers | `/admin/reporting/**` (10 routes) | list (+ server `summary` = `{total, byStatus}` zero-filled), detail, timeline, XLSX/DOCX; `ReportSummaryChart` fed by the server summary; **deliberately NO rail rows** (only `pageTitleFor` aliases) | Reporting surfaces |
| Unread counts | header bell, correspondence inbox | `/notifications/unread-count`, `/correspondence/inbox/unread-count` | personal attention, not management analytics |
| Dashboard API / DTO / Prisma model / `app/admin/dashboard` route | — | **do not exist** (repository-wide search returned only Core preference vocabulary and legacy CRM permission strings) | none |

**Conceptual verdict:** REPORT PAGE = one focused dataset (exists, ×10). KPI SURFACE =
governed metrics with history (exists, `/admin/kpis`). DASHBOARD = intentionally composes
multiple independent data sources for a defined managerial purpose — **does not exist.**

**Current-state answer:** Personal dashboard YES (`CoreDashboard`) · Operational
module homes YES-but-not-dashboards · Management NO · Executive NO · KPI surface YES
(separate) → **for management/executive purposes: NONE.**

## C. CoreDashboard Classification

| Question | Answer | Evidence |
|---|---|---|
| Personal? | **YES** | per-user `dashboardLayout`; widgets show the caller's own identity, RBAC, notifications, reminders |
| Role-aware? | link-level only | widgets intersect links with `visibleNavGroups()`; composition is not role-conditional |
| Tenant-aware? | implicitly, server-side | its data routes resolve tenant themselves; the page carries no tenant logic |
| Customizable widget home? | **YES** | reorder / hide / show / reset persisted per user; server mirrors ids |
| Platform utilities rather than management intelligence? | **YES** | identity, access, notifications, reminders — explicitly no KPI/chart/trend |
| Intended to become the executive dashboard? | **NO evidence** | no such statement anywhere; Phase 49C-4 moved navigation-derived widgets OFF it to reduce duplication |
| Extending it would couple utilities with management analytics? | **YES** | it would push admin-gated, entitlement-sensitive widgets into a catalogue that deliberately has NO permission field, and re-open the composed-endpoint question its own code refuses |

**Decision [ARCHITECTURE-DECISION]:** do **not** extend `CoreDashboard`. Introduce a
**separate Management Dashboard**; `CoreDashboard` stays the personal entry page, unchanged.

| Option | Verdict | Why |
|---|---|---|
| A. Extend `CoreDashboard` | REJECTED | mixes personal utility widgets with governed analytics; needs permission/entitlement logic inside a personal registry; conflates `dashboardLayout` with management layout; no evidence anyone wants the personal home to become management intelligence |
| B. Separate Management Dashboard | **APPROVED** | preserves every existing boundary; management composition gets its own authorization, failure and period semantics; KPI/Reporting/Personal surfaces stay exactly where they are |

## D. KPI vs Reporting vs Dashboard Boundary

```text
KPI lane      /admin/kpis         governed definitions + runtime + history  → owns FORMULAS
Reporting     /admin/reporting/** operational registers, source-owned seams → owns ROWS + summaries
Dashboard     /admin/management   composition ONLY over read contracts      → owns NOTHING but layout
```

| Rule | Decision |
|---|---|
| Dashboard owns KPI formulas? | **FORBIDDEN** |
| Dashboard owns report queries / recomputes counts? | **FORBIDDEN** — values come from server `summary`, list `total`, or KPI comparisons |
| Dashboard owns Prisma / datasources? | **FORBIDDEN** — V1 needs no backend module at all |
| Reporting relabelled a dashboard? | **FORBIDDEN** (evidence review §O) |
| KPI surface absorbed into dashboard? | **FORBIDDEN** — `/admin/kpis` stays first-class |
| Targets/thresholds introduced here? | **FORBIDDEN** (see checklist «Target/threshold boundary») |

## E. Product Audience

- **V1 audience [PRODUCT-DECISION]:** any authenticated tenant user holding **at least one**
  of the four V1 source remits: `production.bom.read` · `commerce.read` ·
  `financial.check.read` · `hr.mission.approve`. Composition is fixed; cards appear or are
  skipped per remit (presentation-only), the server re-asks on every underlying request.
- **Personas considered:** CEO/Executive — no distinct V1 question set is evidenced anywhere
  («executive dashboard» appears only as an explicit KPI-lane *non-goal*) → deferred;
  Finance / Procurement / Production / HR managers — served by permission-gated card
  visibility inside ONE surface, **not** by ten dashboard variants.
- **Rejected:** one variant per role (no evidence, no layout mechanism) and
  «same dashboard for everyone regardless of permission» (would issue requests that cannot
  succeed).


## F. Business Questions

Candidate questions from the brief were filtered against source/business evidence.
**Approved (all six answerable today by an existing contract):**

| # | Question (fa) | Audience | Source | Owner | Update freq | Scope | Drill-down | Authorization | Tenant |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | کدام شاخص‌های مصوب این ماه نسبت به ماه قبل تغییر محسوس داشتند؟ | any holder of a KPI remit | `GET /kpis` (values + `previousPeriod` + `comparisons`) | KPI runtime (source-owned remits) | monthly cohort, read on page load | current Jalali month, **server-resolved** | `/admin/kpis/[key]` | `KPI_READ_REMITS` union + per-definition filter, server-side | server-resolved actor |
| Q2 | وضعیت فعلی درخواست‌های چک چیست؟ | `financial.check.read` | `GET reporting/financial/check-requests` → `summary` | Financial (its reporting seam) | on demand (stock) | tenant, default filter | `/admin/reporting/check-requests` | `financial.check.read` + entitlement | server-resolved |
| Q3 | وضعیت فعلی اسناد خرید چیست؟ | `commerce.read` | `GET reporting/commerce/purchase-documents` → `summary` | Commerce (its reporting seam) | on demand (stock) | tenant, default filter | `/admin/reporting/purchase-requests` | `commerce.read` + entitlement | server-resolved |
| Q4 | وضعیت فعلی ساختارهای BOM چیست؟ | `production.bom.read` | `GET reporting/production/boms` → `summary` | Production (its reporting seam) | on demand (stock) | tenant, default filter | `/admin/reporting/production` | `production.bom.read` + entitlement | server-resolved |
| Q5 | چه تصمیم‌های بازرگانی در انتظار مانده‌اند؟ | `commerce.read` | `GET commerce/pending-decisions` (`total`) | Commerce (operational inbox) | on demand (stock) | tenant, route's own assignee scope | `/admin/commerce/tasks` | `commerce.read` + entitlement | server-resolved |
| Q6 | چه مأموریت‌هایی در انتظار تأیید مانده‌اند؟ | `hr.mission.approve` | `GET hr/missions/approvals/pending` (`length`) | HR | on demand (stock) | tenant | `/admin/hr/missions/approvals` | `hr.mission.approve` + entitlement | server-resolved |

**Rejected candidates (each with its evidence):**

| Candidate question | Why rejected |
|---|---|
| «درآمد/هزینه کل سازمان» (GAP-4) | metrics/formulas undefined — documented «product decision first»; no governed money vocabulary → still `PRODUCT_DECISION`, NOT a dashboard card |
| Cross-domain bottleneck / enterprise overview ranking | no governed cross-context read contract, four DBs, no owning context → `BLOCKED_SOURCE_CONTRACT` (evidence review #20/#28) |
| «روند ماهانه توزیع وضعیت گزارش‌ها» | report contracts have no period-cohort semantics; a client-side trend would invent new semantics |
| Attendance rate / approval-rate figures | KPI-006/007 DRAFT, decision points undecided — KPI lane owns them |
| «آخرین فعالیت‌های سازمان» (recent activity) | no unified activity contract; audit reads are per-domain with their own remits |
| «نامه‌های خوانده‌نشده» / unread counts | personal attention surfaces already exist (bell, inbox); not a management question |
| Red/green performance, SLA, targets | no targets/thresholds exist in KPI governance → see §Q/checklist |

## G. Dashboard Type

**MANAGEMENT** — not PERSONAL (that is `CoreDashboard`), not EXECUTIVE (no evidenced
executive question set), not HYBRID (no mechanism and no requirement to merge the two).

## H. Surface Count

**ONE** — *one management dashboard with persona-specific composition via permissions.*
A second «Executive» surface would be two code paths answering the same evidenced questions;
the KPI catalogue itself records «executive dashboard» as an explicit non-goal of the KPI
lane, and no requirement document anywhere demands a separate executive destination
[PRODUCT-DECISION, revisit only with a new evidenced executive question set].


## I. V1 Scope

V1 is deliberately small: **6 cards in 3 bands**, every card backed by a contract that
already exists. No decorative analytics, no speculative charts, no fake data, no
placeholders presented as real.

```text
┌─ Band A — governed metrics ────────────────────────────────────────────┐
│  MGT-KPI-01   KPI strip (up to 5 approved KPIs + server comparison)    │
├─ Band C — attention / work queues ─────────────────────────────────────┤
│  MGT-QUE-01   Commerce decisions pending   │  MGT-QUE-02  Missions pending │
├─ Band B — domain operational status (server `summary`) ───────────────┤
│  MGT-FIN-01   Check requests  │  MGT-COM-01  Purchase docs  │  MGT-PRD-01  BOMs │
└────────────────────────────────────────────────────────────────────────┘
 footer: shortcuts to the KPI overview and the three registers (navigation, not data)
```

**V1 NON-GOALS:** dashboard builder/DSL, widget marketplace, AI, scheduler, alerts,
KPI target engine, any new API, any new database object, cross-domain aggregation,
personalization, period selector, auto-refresh, caching, exports.

## J. Card Catalog

### J.1 Overview

| ID | Persian label | Type | Source contract (existing) | Owner | KPI/Report relationship | Priority |
|---|---|---|---|---|---|---|
| MGT-KPI-01 | شاخص‌های کلیدی — ماه جاری | KPI CARD | `GET /kpis` | KPI runtime / governance | **IS KPI display** (read-only reuse; drill → `/admin/kpis/[key]`) | P0 |
| MGT-FIN-01 | وضعیت درخواست‌های چک | STATUS DISTRIBUTION | `GET reporting/financial/check-requests` (`summary`) | Financial via reporting seam | report summary reuse; drill → `/admin/reporting/check-requests` | P0 |
| MGT-COM-01 | وضعیت اسناد خرید | STATUS DISTRIBUTION | `GET reporting/commerce/purchase-documents` (`summary`) | Commerce via reporting seam | report summary reuse; drill → `/admin/reporting/purchase-requests` | P0 |
| MGT-PRD-01 | وضعیت ساختارهای BOM | STATUS DISTRIBUTION | `GET reporting/production/boms` (`summary`) | Production via reporting seam | report summary reuse; drill → `/admin/reporting/production` | P0 |
| MGT-QUE-01 | در انتظار تصمیم بازرگانی | ACTION / WORK QUEUE | `GET commerce/pending-decisions` (`total`) | Commerce | NOT a report, NOT a KPI — operational inbox count; drill → `/admin/commerce/tasks` | P1 |
| MGT-QUE-02 | در انتظار تأیید مأموریت | ACTION / WORK QUEUE | `GET hr/missions/approvals/pending` (`length`) | HR | operational approvals count; drill → `/admin/hr/missions/approvals` | P1 |

### J.2 Per-card decisions (all fields required by the brief)

**MGT-KPI-01** — «شاخص‌های کلیدی — ماه جاری»
Question: which approved KPIs changed materially vs the previous month. Filter/scope: none
stated (server default = current Jalali month); only KPIs the caller may read are shown —
the same server-side filter `GET /kpis` already applies. Period: current Jalali month,
server-resolved; a partial month is labeled «در جریان» by the existing KPI UI.
Refresh: on page load + manual refresh. Permission: union `production.bom.read |
commerce.read | financial.check.read` (client `canReadAnyKpi`, presentation-only; server
`@Roles(...KPI_READ_REMITS)` + per-definition check decisive). Entitlement: per-source
module entitlement, enforced by the KPI runtime. Drill-down: `/admin/kpis/[key]`.
Empty: «شاخصی برای این ماه محاسبه نشده است.» Unavailable: 403 → «در دسترس نیست».
Error: retry card-level. Product owner: KPI governance. Definition status: APPROVED (5/9).

**MGT-FIN-01 / MGT-COM-01 / MGT-PRD-01** — domain status distribution
Question: what is the current state of this domain's core register. Filter/scope: default
(unfiltered) tenant scope — the SAME query the report page uses with no filters. Period:
**stock / as-of-now** (not a month cohort; the server counts rows under the current filter).
Refresh: on page load + manual refresh. Permission: the source report's own remit
(`financial.check.read` / `commerce.read` / `production.bom.read`) — no `reporting.*`
permission exists or is invented. Entitlement: the same module/feature entitlement the
report controller declares. Drill-down: the report register route (existing). Empty:
«موردی ثبت نشده است.» Unavailable: 403 → «در دسترس نیست». Error: card-level retry.
Product owner: the source domain (Financial / Commerce / Production). Definition status:
EXISTING-IMPLEMENTATION (server `summary` already published).

**MGT-QUE-01 / MGT-QUE-02** — attention queues (count only)
Question: how much approved work is waiting. Filter/scope: the route's own server-resolved
scope (assignee/approver as each route defines). Period: as-of-now. Refresh: page load +
manual refresh. Permission: `commerce.read` / `hr.mission.approve` (both verified on the
controllers). Entitlement: module entitlement of the source. Drill-down: the operational
queue page. Empty: «موردی در انتظار نیست.» Unavailable: 403 → «در دسترس نیست».
Error: card-level retry. **Rows are NEVER rendered on the dashboard — only the count**
(see §R). Product owner: Commerce / HR. Definition status: EXISTING-IMPLEMENTATION.

### J.3 Considered and deferred (NOT in V1)

| Card idea | Deferred because |
|---|---|
| HR status cards (leave / mission / personnel-traffic summaries) | contracts exist; deferred to keep Band B symmetric with the three KPI-bearing domains in V1 — first V1.1 candidates [PRODUCT-DECISION] |
| HR headcount card (`GET /hr/organization/summary`) | single-domain but module-home content; duplicating it dilutes the management purpose — revisit with V1.1 |
| Correspondence unread / letter status | letter report audience undecided (`PRODUCT_DECISION` #31); unread is personal |
| Commerce spend / GAP-4 summary | metrics undefined — `PRODUCT_DECISION` #33 |
| Trend charts on the dashboard | trends live on `/admin/kpis/[key]` (KPI history); report-summary trends need source-side cohort semantics first |
| Recent activity feed | no unified activity contract |
| Report shortcuts as data cards | navigation only — kept as a footer link row, not cards |


## K. Cross-Domain Contract Matrix

**Every V1 card is SINGLE-DOMAIN.** The dashboard never reads a second domain for one card,
so no new cross-context contract is required for V1.

| Card | Source domains | Cross-context contract needed? | Ownership | Authorization | Freshness | Risk | Status |
|---|---|---|---|---|---|---|---|
| MGT-KPI-01 | Production + Commerce + Financial (one KPI at a time, server-filtered) | NO — KPI runtime is already the approved composition point (it consumes the three approved reporting readers, `CROSS-CONTEXT-INTEGRATION-POLICY.md` §2.2) | KPI runtime | `KPI_READ_REMITS` union | monthly cohort | low | **PASS** |
| MGT-FIN-01 | Financial | NO | Financial seam → Reporting | `financial.check.read` | as-of query | low | **PASS** |
| MGT-COM-01 | Commerce | NO | Commerce seam → Reporting | `commerce.read` | as-of query | low | **PASS** |
| MGT-PRD-01 | Production | NO | Production seam → Reporting | `production.bom.read` | as-of query | low | **PASS** |
| MGT-QUE-01 | Commerce | NO | Commerce (operational) | `commerce.read` | as-of query | low | **PASS** |
| MGT-QUE-02 | HR | NO | HR (operational) | `hr.mission.approve` | as-of query | low | **PASS** |
| *any card combining 2+ domains in one number* | multi | **REQUIRED — none exists** | nobody owns it | undefined | undefined | high | **BLOCKED_SOURCE_CONTRACT** |

**Composition decision [ARCHITECTURE-DECISION]: A — frontend composition of existing APIs.**

| Option | Verdict | Trade-off analysis |
|---|---|---|
| A. Frontend fan-out to existing endpoints | **APPROVED for V1** | authorization stays at its source (no third copy); partial failure isolated per card; tenant isolation inherited; bounded N (≤6 requests, no per-row fan-out); no new P0-C consumer; observability = existing HTTP paths; latency = one parallel round |
| B. One dedicated management aggregation endpoint | REJECTED for V1 | would have to re-implement four sources' authorization edges in a third place (the exact reason `CoreDashboard` refuses a composed endpoint); would become a second application service; would require amending the P0-C approved-consumer list + guard changes; introduces tenancy-keyed caching questions before any proven need |
| C. Platform-level management read contracts | REJECTED for V1 | no such contract family exists; creating one is a platform decision with owners, not a dashboard shortcut |
| D. Source-owned dashboard card contracts | RESERVED | the correct future evolution if card count/latency ever proves fan-out insufficient — each source publishes its own dashboard card read, owner-scoped, never a dashboard→Prisma path |
| E. Hybrid | REJECTED for V1 | premature: no measurement justifies part of B |

## L. Tenant / SaaS Model

- **Tenant A (Production + HR)** sees MGT-KPI-01 (Production KPIs only), MGT-PRD-01,
  MGT-QUE-02; Financial/Commerce cards are **not issued** (presentation gate) — if issued,
  the source's entitlement guard refuses and the card renders FORBIDDEN/UNAVAILABLE.
- **Tenant B (Commerce + Financial)** sees MGT-KPI-01 (Commerce+Financial KPIs), MGT-FIN-01,
  MGT-COM-01, MGT-QUE-01; Production/HR cards hidden.
- **Tenant C (all)** sees all six.
- Rules [PRODUCT-DECISION]: (1) no card ever sends or receives a `tenantId` — every source
  resolves the tenant server-side; (2) module entitlement refusal = card state, never a
  page failure; (3) **hide vs unavailable**: card whose remit the caller lacks → not issued
  (hidden); card whose request is refused (403/entitlement) → visible FORBIDDEN state, not
  silent disappearance; (4) no tenant-admin default layout and no role default layout in V1
  (fixed composition); (5) personalization of cards = future decision D6, not implemented.

## M. Roles / Permissions

- **No new permission string, no new `reporting.*`, no `dashboard.*` permission**
  (consistent with KPI governance's «no new permission and no new surface»).
- Client gating is **presentation-only** (precedent: `canReadAnyKpi`, `KpiListView`): it
  decides whether a request is worth ISSUING; every underlying route re-asks behind
  `@Roles(...)` + `ModuleEntitlementGuard` and its 403 stays decisive.
- The nav row gate is the UNION of the four V1 remits, stated identically in
  `core-nav.ts` (`anyOfPermissions`) and `apps/api/src/preferences/nav-catalogue.ts` — the
  49K drift test pins the two catalogues entry for entry.

## N. Personalization

| Setting | Owner after this decision |
|---|---|
| Core personal dashboard order/visibility (`dashboardLayout`, `widget-catalogue`) | **Core — unchanged** |
| Management dashboard composition | **Management dashboard — intentionally FIXED in V1** (no reorder, no hide, no favorites inside the page) |
| Tenant default layout | not supported in V1 (FUTURE D6) |
| Role default layout | not supported in V1 (FUTURE D6) |

Rationale [PRODUCT-DECISION]: a management surface answers management questions; letting
each user hide a KPI or a queue would silently change what «the dashboard reports». If
personalization is ever wanted it needs a NEW preference namespace — reusing
`dashboardLayout` would require permission fields in the personal widget catalogue and is
explicitly rejected.


## O. Period / Freshness

- **No global period selector in V1.** A selector that only moves one card would be a lie;
  the six cards do not share one time semantics and V1 computes no cross-card comparison.
- **Two honest time semantics, stated on every card subtitle:**
  - Band A (KPI): **flow over the current Jalali month**, server-resolved
    (`resolveKpiPeriod`, `Asia/Tehran`, half-open windows); partial month labeled
    «در جریان»; previous-period comparison computed by the SERVER (`previousPeriod` +
    `comparisons` on `GET /kpis`) — never derived in the browser.
  - Band B/C (status + queues): **stock as-of-now** — the server's counts under the default
    filter at query time; labeled «وضعیت فعلی».
- Incompatible periods are never compared: no card subtracts a stock from a flow, and no
  client-side date math exists (no browser-clock Gregorian/Jalali derivation).
- **Refresh:** page-load fetch + one manual «بروزرسانی» control. NO polling, NO auto
  refresh, NO scheduler, NO background computation [PRODUCT-DECISION].
- **Freshness requirements:** none beyond «fetched at page load/refresh»; V1 shows no
  as-of timestamp because it holds no cache (a timestamp on a live read would imply
  otherwise). Mixed freshness is communicated by the band labels above.

## P. UX Specification (textual / wireframe level — no visual UI built)

**Identity:** Persian-first, RTL-native (`<html dir="rtl">`), enterprise-calm,
information-dense but not crowded, accessible, responsive, dark/light via existing tokens.

```text
┌ header (existing AdminShell) ──────────────────────────────────────────┐
│ h2 «نمای مدیریت»   ·  scope line: «ماه جاری: … (سمت سرور)» + دکمه بروزرسانی │
├ Band A ────────────────────────────────────────────────────────────────┤
│ [کارت شاخص ۱] [۲] [۳] [۴] [۵]   ← value + «نسبت به ماه قبل» + link      │
├ Band C ────────────────────────────────────────────────────────────────┤
│ [در انتظار تصمیم بازرگانی: n]        [در انتظار تأیید مأموریت: n]         │
├ Band B ────────────────────────────────────────────────────────────────┤
│ [وضعیت درخواست‌های چک + bars] [وضعیت اسناد خرید + bars] [وضعیت BOM + bars] │
├ footer ────────────────────────────────────────────────────────────────┤
│ پیوندهای سریع: شاخص‌ها · گزارش چک‌ها · گزارش خرید · گزارش BOM              │
└────────────────────────────────────────────────────────────────────────┘
```

- **Hierarchy order:** (1) identity/title → (2) period/scope → (3) critical KPI values →
  (4) attention/exceptions (queues) → (5) operational summaries → (6) domain shortcuts.
  The order follows the approved questions Q1→Q6, not decoration.
- **Card size hierarchy:** Band A cards equal-weight; Band C two cards (numeric emphasis);
  Band B three equal cards; footer links smallest.
- **Responsive:** ≥1280px four-column grid (Band A five cells); 1024px two-column; 768px
  one column stacked in band order; ≤480px single column, numbers wrap, charts keep RTL bars.
- **RTL:** logical utilities (`ms-`/`me-`, `start`/`end`) throughout, existing
  `core-card` / `CoreStates` vocabulary, Vazirmatn.
- **Accessibility:** each card an `h3` region with an accessible name; charts have a text
  equivalent (the server numbers rendered as text — same rule as `ReportSummaryChart`);
  keyboard-reachable drill-down links; focus-visible tokens; contrast via semantic tokens.
- **Dark/light:** existing `data-theme` tokens only, no new palette.

**Chart policy [PRODUCT-DECISION]:** Band B MAY reuse the existing `ReportSummaryChart`
(RTL horizontal bars) fed by the server `summary` — no client recount, no percentages
computed locally. Band A renders values + server comparison only (trends belong to
`/admin/kpis/[key]`'s `KpiTrendChart`). NOT approved: gauges without a semantic target,
pie/donut without meaningful categories, decorative charts, any new visualization library,
any chart whose numbers are computed in the browser. Every card carries a business question
(J §J.1), a source, a semantic definition, a scope and an accessible text equivalent.

**Target/threshold boundary [PRODUCT-DECISION]:**
`TARGETS / THRESHOLDS: NOT YET PART OF V1.` KPI governance records
`Target = NOT_DEFINED / Threshold = NOT_DEFINED` («no SLA evidence exists in the repo»), so
no red/green semantics, warning thresholds, SLA coloring or target lines may appear.

## Q. Error / Empty / Unavailable Semantics (decided BEFORE implementation)

**A failed card must not destroy the dashboard.** Each card owns its own request and its own
boundary; the page shell only fails when the caller is unauthenticated.

| State | Exact trigger | Rendering rule |
|---|---|---|
| **LOADING** | request in flight | skeleton/`CoreLoading`-style placeholder inside the card only |
| **EMPTY** | HTTP 200 with zero items / zero counts | «موردی وجود ندارد» with the card's own wording — **never** converted to an error |
| **FORBIDDEN** | 401/403 from the source | «این کارت برای شما در دسترس نیست» — no retry loop, drill-down link removed |
| **UNAVAILABLE** | contract/deployment gap: 404/405 on the expected route, or client-known module not entitled for the tenant (via the existing modules/entitlement read) | «در حال حاضر در دسترس نیست» — distinct copy from FORBIDDEN; card frame retained |
| **ERROR** | 5xx / network failure / timeout | «خطا در دریافت اطلاعات» + a per-card retry button; **other cards unaffected** |
| **STALE** | reserved for a future cache; **not reachable in V1** (no cache) | if ever introduced, a source timestamp becomes mandatory first |

Rules: no state is silently converted into another; a partial page (some cards EMPTY,
some FORBIDDEN, one ERROR) is a normal, expected rendering — never a page-level failure.


## R. Security / PII

- **Minimum projection rule:** V1 cards render **counts, statuses and governed KPI values
  only**. Explicitly NOT on the dashboard: raw actor IDs, internal UUIDs, employee/person
  names, vendor names, amounts/credentials, letter contents, approval free-text.
- Queue cards show the **count only**; rows of people appear only after drill-down, on the
  target page, under that page's own authorization (where they already are today).
- Every card with person/vendor-adjacent data would need: minimum projection + reason +
  permission + tenant scope + sensitivity — **none is required in V1** because none is shown.
- No exports on the dashboard (export stays a report-page capability with its own audit).
- **Audit/observability [PRODUCT-DECISION]:** dashboard views are read-only and are **not**
  audited; no new audit storage is introduced. Failures surface in the UI; HTTP observability
  of the underlying routes is unchanged. Drill-down/export auditing remains whatever each
  source already does.

## S. Performance Architecture

- **Network model: A — frontend fan-out.** On load the page issues at most **6 parallel
  GETs** (1 KPI + 3 report summaries + 2 queues), zero per-row fan-out, zero dynamic card
  count (N is fixed by the catalogue). Bounded, measurable, no N+1.
- Timeout/failure: each request inherits the existing `core-http` client behavior; failure
  maps to the card's ERROR state with per-card retry (§Q) — no page-level retry cascade.
- Source load: 6 reads per page view against routes that already serve register pages;
  no source sees more than one extra read per view.
- **Rejected for V1:** a single `/dashboard` aggregation endpoint (see §K trade-offs).
  If a future measurement shows fan-out insufficiency, the sanctioned evolution is
  option D — **source-owned dashboard card contracts** — never dashboard→Prisma.

## T. Caching Decision

**NO CACHE in V1.** Not request-level memoization, not server cache, not precomputed
summary. Every page load reads live. Consequences stated up front: if caching is ever
proposed, it must first publish (a) freshness semantics per card, (b) an explicit
**tenancy key** — sensitive tenant data must never be cached without one, and (c) how STALE
renders. None of these exist today → caching is FUTURE, not V1.

## U. AI Boundary

AI is **not** implemented and not required by V1. Classified for a future
**AI Decision Support** lane only: narrative summary · anomaly explanation · recommended
actions · natural-language questions. V1 works fully without AI (the capability matrix
records `TEXT_GENERATION ❌`, embed-only gateway). No AI vocabulary enters the dashboard
code or docs beyond this paragraph.

## V. Navigation

| Decision | Value |
|---|---|
| Route | **`/admin/management`** |
| Nav label | **«نمای مدیریت»** |
| Placement | `CORE_NAV` group `overview` («عمومی»), row order: «خانه» → **«نمای مدیریت»** → «شاخص‌های کلیدی عملکرد» |
| Gate | `anyOfPermissions: ['production.bom.read', 'commerce.read', 'financial.check.read', 'hr.mission.approve']` (the union of V1 source remits), restated server-side in `nav-catalogue.ts` with the matching `NAV_TARGETS` entry — the 49K drift test stays entry-for-entry |
| Discoverability / active state | first-class rail row with its own icon; `isNavItemActive` highlights for `/admin/management` |
| Favorite/recent | favoriteable (default true) and recordable as a visit (`isNavTarget` via `NAV_TARGETS`) |
| Title | `pageTitleFor('/admin/management')` resolves from the row; add a fallback alias only if the row is ever filtered (KPI precedent) |

Why not the alternatives: `/admin/dashboard` — semantically collides with `CoreDashboard`
(«خانه», `dashboardLayout` vocabulary) and reads as «the personal dashboard»;
`/admin/executive` — wrong, V1 is management not executive (§H). Reporting routes keep their
deliberate «no rail row» rule; `/admin/kpis` keeps its existing row untouched.


## W. Implementation Backlog (decided now, built later — NOT implemented in this phase)

**PHASE D1 — Dashboard platform shell.**
Objective: route + navigation row + page skeleton + per-card state boundary, no cards yet.
Dependency: none (reuses `core-card`, `CoreStates`, `core-http`, `useCorePermissions`).
Owner: Platform (web). Prerequisite: this decision document. Scope:
`app/admin/management/page.tsx` + nav row + server `NAV_TARGETS` entry + drift-test
entries + card boundary + five card states. Acceptance: renders for a caller with ≥1
remit; hidden otherwise; drift test stays entry-for-entry; `typecheck` green. Security:
none beyond a union-gated row. Tests: view spec with a per-remit gate matrix, like the
`CoreDashboard` spec.

**PHASE D2 — KPI strip card (MGT-KPI-01).**
Objective: governed values + server comparisons from the existing `GET /kpis`. Dependency:
KPI runtime (green). Prerequisite: D1. Scope: strip only, no new chart, drill-down wired.
Acceptance: exactly what the route returns; no client recalculation (fixture parity with
`KpiListView`). Tests: values, comparisons, EMPTY_COHORT, «در جریان» label.

**PHASE D3 — Operational status cards (MGT-FIN-01, MGT-COM-01, MGT-PRD-01).**
Objective: three status distributions from the three existing report summaries.
Prerequisite: D1. Scope: summary rendering + existing `ReportSummaryChart` + drill-down.
Acceptance: numbers equal each report page's own summary strip for the same tenant/filter.
Tests: card specs + bucket parity with `report-chart.ts`.

**PHASE D4 — Attention queue cards (MGT-QUE-01, MGT-QUE-02).**
Objective: two count-only cards from the two existing pending routes. Prerequisite: D1.
Scope: counts, not rows; drill-down to queue pages. Acceptance: count parity with the
target page; zero rows rendered (PII rule asserted in spec). Tests: parity, FORBIDDEN on
revoked remit, no row leakage.

**PHASE D5 — Interaction polish.** Manual refresh control, responsive/a11y pass, scope
labels, keyboard focus behavior. Dependency: D2–D4. No new contracts.

**PHASE D6 — SaaS tenant/role personalization (deferred).** Only if demanded later, in a
NEW preference namespace with its own decision. Explicitly NOT the Core `dashboardLayout`
mechanism.

## X. Dependencies

| Dependency | State |
|---|---|
| KPI runtime list (`GET /kpis` with comparisons) | ✅ exists + green this phase |
| Report list contracts with `summary` (×3 for V1) | ✅ exist + green this phase |
| Commerce pending-decisions / HR mission pending-approvals routes | ✅ exist |
| `core-http`, `useCorePermissions`, `CoreStates`, `core-card`, `ReportSummaryChart` | ✅ exist |
| `CORE_NAV` + server `nav-catalogue.ts` + drift test | mechanism exists; entries added in D1 |
| Any dashboard backend, cache, scheduler, AI capability | NOT needed for V1 |
| Cross-domain read contract family | NOT needed for V1 (all cards single-domain) |


## Y. BLOCKED / FUTURE Items

- **BLOCKED_SOURCE_CONTRACT:** any card combining ≥2 domains in one number (enterprise
  overviews, cross-domain bottleneck rankings) — needs a named owner + a governed
  cross-context read contract first (evidence review #20). Dashboard NEVER reaches for
  sibling Prisma as the workaround.
- **PRODUCT_DECISION still open (not V1):** Correspondence letter status (#31),
  Commercial Assignment history (#32), Commerce GAP-4 KPI/summary family (#33) — unchanged
  by this phase, unblocked only by their own named decisions.
- **FUTURE (after V1 proves the shell):** HR status cards (first V1.1 candidates),
  executive surface (needs an evidenced executive question set), role/tenant defaults
  (D6), period selector for the KPI band, trend rendering of report summaries (needs
  source-side cohort semantics), tenant-keyed caching, alerts/scheduler, AI lane.
- **Hard-stop check (§36 of the brief):** NONE of the eight stop conditions triggered —
  audience, questions, card semantics, contracts, CoreDashboard placement, lane
  boundaries, tenant/permission behavior and the performance model were all decided from
  evidence. This phase is **COMPLETE**, not BLOCKED.

## Z. Final Product Decision

**Identity.** Name: Management Dashboard · Persian name «نمای مدیریت» · Purpose: one page
answering Q1–Q6 by composing existing governed sources · Audience: any manager holding ≥1
V1 source remit · Route: `/admin/management` · Navigation: rail row in group «عمومی»,
خانه → نمای مدیریت → شاخص‌های کلیدی عملکرد.
**Type:** MANAGEMENT. **Surfaces:** ONE (permission-composed; executive separate only on
new evidence). **V1:** 6 cards, 3 bands (A: KPI strip · C: 2 queue counts · B: 3 status
distributions) + shortcut footer; fixed composition; page-load + manual refresh; no cache;
no polling; no personalization; count-only queues (no PII); drill-down into existing
register/queue/KPI-detail pages.
**Architecture:** frontend composition over existing read contracts; no new backend; no
KPI duplication; no Prisma; no cross-context aggregation; per-card failure isolation;
five explicit card states.
**Non-goals (binding):** dashboard builder · widget marketplace · AI · scheduler · alerts
· KPI target engine · direct Prisma · cross-context shortcuts · ungoverned metrics · new
permissions · absorbing `/admin/kpis` · relabeling reports.


## Product Decision Checklist (§30)

- [x] Existing dashboard surfaces inventoried (§B)
- [x] CoreDashboard classified (§C)
- [x] KPI surface classified (§B, §D)
- [x] Reporting surface classified (§B, §D)
- [x] Executive vs Management distinction decided (§H — ONE management surface)
- [x] Surface count decided (§H)
- [x] Audience decided (§E)
- [x] Management questions decided (§F — Q1–Q6 approved, rest rejected with evidence)
- [x] V1 cards decided (§I–J — 6 cards, catalogue + deferred list)
- [x] KPI boundary decided (§D, §K)
- [x] Reporting boundary decided (§D, §K — every card drills into an existing report/register)
- [x] Cross-domain contract needs identified (§K — none needed for V1; multi-domain cards BLOCKED)
- [x] Tenant behavior decided (§L)
- [x] Role/permission model decided (§M)
- [x] Personalization decision made (§N — management layout fixed in V1)
- [x] Period model decided (§O — no global selector; two stated semantics)
- [x] Freshness model decided (§O — page-load + manual refresh; no polling)
- [x] Partial failure behavior decided (§Q)
- [x] UX hierarchy decided (§P)
- [x] Chart policy decided (§P — reuse only)
- [x] Target/threshold boundary decided (§P — NOT YET PART OF V1)
- [x] PII policy decided (§R — counts/statuses/KPI values only)
- [x] Navigation/route decided (§V — `/admin/management`, «نمای مدیریت»)
- [x] Performance architecture decided (§S — frontend fan-out)
- [x] Caching decision made (§T — none in V1)
- [x] AI boundary documented (§U)
- [x] Dashboard V1 explicitly bounded (§I, §Z)
- [x] Implementation backlog created (§W — D1–D6, unbuilt)
- [x] Dependencies identified (§X)
- [x] BLOCKED items identified (§Y)
- [x] Product decisions separated from architecture decisions (§Evidence vs Decision)

## Evidence vs Decision

Every statement in this document carries one label:

- **SOURCE-PROVEN** — read from the exact source named this phase (e.g. «CoreDashboard
  has no KPI/chart/trend» from its code comment; controller paths; `@Roles` strings).
- **EXISTING-IMPLEMENTATION** — a live backend/frontend contract named exactly
  (e.g. `GET /kpis` comparisons; report `summary` shape; `ReportSummaryChart`).
- **PRODUCT-DECISION** — an approved choice: ONE management surface, V1 audience,
  Q1–Q6, the 6-card catalogue, route/label/placement, refresh model, PII rule, V1 scope.
- **ARCHITECTURE-DECISION** — an approved structural rule: separate dashboard (not Core
  extension), frontend fan-out, no new backend, five card states, fixed composition.
- **FUTURE** — stated but unbuilt: D1–D6, caching, personalization, executive surface, AI.
- **BLOCKED** — stopped at a named gate: multi-domain aggregation cards
  (`BLOCKED_SOURCE_CONTRACT`), GAP-4/correspondence/assignment (their own decisions).

No product decision is presented as existing architecture; no future item as V1 scope.

## Verification

Documentation-first phase — existing suites only, run to prove the lanes this decision
composes remain intact. Runner note: `npx` is blocked by the machine execution policy, so
suites ran as `node <root>/node_modules/jest/bin/jest.js --runInBand …` with output
redirected (windows execution detail, no behavioral difference).

| Lane | Suites | Tests | Result |
|---|---|---|---|
| Architecture (`architecture-boundaries`, `reporting-isolation`, `reporting.module`) | 3/3 PASS | (inside the 135 below) | PASS |
| KPI (`kpi-governance`, `kpi-catalog`, `kpi-runtime.{service,period,engine,history,comparison}`) | 7/7 PASS | (inside the 135 below) | PASS |
| API focused (the 10 above) | 10/10 | 135/135 | PASS |
| Reporting API (`src/modules/reporting`, all 10 reports + isolation + presentation) | 25/25 | 199/199 | PASS |
| Reporting web (`src/components/reporting`, ×18 incl. `ReportSummaryChart`) | 18/18 | 197/197 | PASS |
| Dashboard/Core web (`CoreDashboard`, `core-nav`) | 2/2 | (inside the 96 below) | PASS |
| KPI web (`KpiListView`, `KpiDetailView`) | 2/2 | (inside the 96 below) | PASS |
| Web focused (the 5 above) | 5/5 | 96/96 | PASS |

No FAIL anywhere. `typecheck` was not re-run: **no production code changed** (documentation
only); every count above re-proves the current architecture still holds — CoreDashboard
personal, KPI governed and separate, Reporting source-owned, P0-C guards green.

## Commit Record

```text
Working tree before commit:  one NEW untracked file (this document);
                             one UNTRACKED generated file (apps/web/next-env.d.ts, not staged)
git diff --check:              (run at commit time — required to pass)
Implementation code changed:   NONE
Commit:                        docs(platform): define management dashboard product decision
Blind git add:                 FORBIDDEN — stage only docs/reports/PHASE-DASHBOARD-PRODUCT-DECISION.md
```

