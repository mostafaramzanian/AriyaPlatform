# Reporting Portfolio Evidence Review — Classification of Every Remaining Candidate

> **Phase type:** EVIDENCE + CLASSIFICATION + PORTFOLIO DECISION — NO report endpoint, reader, DTO, chart, export, page, KPI, dashboard, AI behavior, or cross-context query was implemented in this phase.
> **Baseline:** `HEAD = f35b643bf9303fd6900acc1d3977c73b3d4fce43` · Branch `master` · Working tree: only untracked generated `apps/web/next-env.d.ts` (verified with `git log -1`, `git status --short` at phase start).
> **Supersedes:** the previous review at baseline `f00ca9e` (committed `fb7b779`/`f601db1`/`b0e0234`), which predates 6 report slices and the platform-hardening phases; that version remains readable in git history. This document is the authoritative classification as of `f35b643`.
> **Commit strategy:** documentation-only — `docs(reporting): complete reporting portfolio evidence review`.

## A. Executive Summary

The operational Reporting portfolio is COMPLETE for its current scope: **9 reports** are implemented, each through a source-owned read seam, all verified green this phase (Reporting 185/185, architecture 28/28, source seams 94/94, KPI 23/23, full API 4504/4504, web reporting+KPI 222/222).

This phase classifies **35 candidates** (9 implemented + 26 remaining, of which 3 were newly discovered in the repository). The headline decisions:

```text
REPORTING PORTFOLIO
│
├── ✅ IMPLEMENTED (9) — the complete operational register portfolio
│
├── 🟢 READY (0) — every previously-READY candidate was built; nothing
│                  new independently passes all five gates today
│
├── 🟡 READY + SCOPE DECISION (1) — Commerce Receiving Status Report
│        (source/projection proven; row-grain decision required first)
│
├── 🔎 EVIDENCE REVIEW (1) — Production Pending Approval Aging
│        (owned by KPI-008; aggregation/as-of semantics undecided)
│
├── 🔴 BLOCKED — SOURCE DATA (8) — HR Leave Balance, financial statements,
│        finance expense/revenue/cost, production efficiency family,
│        HR attendance-rate family, pending purchase aging (KPI-009),
│        Inventory/Sales/CRM/… (modules absent), supplier activity
│
├── 🔴 BLOCKED — SOURCE CONTRACT (1) — cross-context/cross-database
│        report joins (no governed cross-domain read contract exists)
│
├── 🚫 NOT_REPORTING (7) — Project Gantt, Workflow Inbox, Employee
│        Directory, AI family, generic BI/DSL, commercial configuration
│        authoring, approval-rate figures (KPI-006/007-owned)
│
├── 🟣 PRODUCT DECISION (6) — cross-domain overviews, Executive
│        Dashboard, Management Dashboard, Correspondence Letter report,
│        Commercial Assignment history, Commerce GAP-4 summary family
│
└── ⬜ DUPLICATE / COVERED (2) — check stage sub-views, current-assignment
           list (both already served by existing surfaces)
```

**Dashboard verdict:** no true dashboard exists. `CoreDashboard` is four personal widgets with no KPI/chart/trend (code-stated); `HrDashboardView` is single-context HR counters; report pages carry per-report summary charts; `/admin/kpis` is the KPI surface. Executive/Management Dashboard remain **PRODUCT_DECISION** — purpose, owner, and composed sources are undefined.

## B. Baseline

| Item | Evidence |
|---|---|
| Starting HEAD | `f35b643bf9303fd6900acc1d3977c73b3d4fce43` — `docs(reporting): document commerce return lifecycle report` (matches the documented `f35b643`; NOT assumed, read from `git log -1`) |
| Branch | `master` |
| Working tree at start | clean except untracked generated `apps/web/next-env.d.ts` — no unrelated uncommitted implementation |
| Previous phase present | Commerce Return Lifecycle verified: `return-lifecycle-report.{controller,service,dto}` + specs, `commerce/reporting/return-lifecycle-reporting.module.ts`, web `admin/reporting/commerce/return-lifecycle/`, record `PHASE-REPORTING-COMMERCE-RETURN-LIFECYCLE-REPORT.md` |
| History since prior review | 24 commits `f00ca9e..HEAD`: prior review → BOM Change Request slice → Platform Hardening (B1/B2/B2.x/B3, P0-B closure) → HR Leave → HR Mission → Payment History → Return Lifecycle |

## C. Current Implemented Portfolio

All nine verified at three levels this phase: composition root (`reporting.module.ts` — 9 controllers + 9 services + 9 source-owned seam modules + `PlatformAIModule` + entitlement gate), source seams (each `contract + module + reader + spec` inside its owner), and web routes (`/admin/reporting/**`, 9 page groups + detail routes).

| # | Report | Source of truth (owner) | Seam | Route | Key evidence |
|---|---|---|---|---|---|
| 1 | Financial — Check Request Status & Flow | `CheckRequest` + 5 stage tables, `finance_db` (Financial) | `financial/reporting/financial-check-request-reporting.*` | `GET reporting/financial/check-requests` (+`:id`, `:id/timeline`, xlsx, docx) | impl `eb71005`; statuses `{0..8,50}`; remit `financial.check.read`; record `PHASE-REPORTING-CHECK-REQUEST-REPORT.md` |
| 2 | Commerce — Purchase Request Status & Lifecycle | `PurchaseDocument`/`PurchaseLine`, `commerce_db` (Commerce) | `commerce/reporting/commerce-purchase-reporting.*` | `GET reporting/commerce/purchase-documents` | impl `6d2723e`; 6 statuses; remit `commerce.read`; supports KPI-003/004 |
| 3 | Production — BOM Summary & Operational Status | `BomHeader`/`BomItem`, `production_db` (Production) | `production/reporting/production-reporting.*` | `GET reporting/production/boms` | impl `ed34f6b`; 4 statuses; remit `production.bom.read`; supports KPI-001/002 |
| 4 | HR — Personnel Traffic | `Attendance`, `hr_db` (HR) | `hr/reporting/hr-personnel-traffic-reporting.*` | `GET reporting/hr/personnel-traffic` | impl `c6d5cc6`; `DEVICE\|MANUAL`; remit `hr.attendance.read`; no status/duration/rate in schema (pinned) |
| 5 | Production — BOM Change Request Status | `BomChangeRequest` + items (Production) | `production/reporting/production-bom-change-reporting.*` | `GET reporting/production/bom-change-requests` | impl `9fe65a8`; 4-state lifecycle; built from prior READY/P0 |
| 6 | HR — Leave Request Status | `LeaveRequest` + `LeaveType` (HR) | `hr/reporting/hr-leave-reporting.*` | `GET reporting/hr/leave-requests` | impl `1c42002`; status/leaveType/employee/date-window filters; remit `hr.leave.read` |
| 7 | HR — Mission Request Status | `MissionRequest` + `MissionReport` (HR) | `hr/reporting/hr-mission-reporting.*` | `GET reporting/hr/mission-requests` | impl `80f2f4b`; 7-state lifecycle + durationMode; remit `hr.mission.read` |
| 8 | Commerce — Payment History | `PaymentRecord` append-only (Commerce) | `commerce/reporting/commerce-payment-reporting.*` | `GET reporting/commerce/payments` | impl `942d633`; exact `Decimal(18,4)` strings; per-document scope (documented deviation) |
| 9 | Commerce — Return Lifecycle | `ReturnDocument` + transitions (Commerce) | `commerce/reporting/return-lifecycle-reporting.*` | `GET reporting/commerce/returns` | impl `ae9ee1c`; 5 states, frozen matrix, `projectReturnState` |

**Shared platform (reuse, not rebuild):** `ReportSummaryChart` + `report-chart.ts`; `report-export.ts` + XLSX/DOCX writers + `ReportExportButtons.tsx` (isolation suite pins the handler set per controller — list, row, timeline, two formats; payment-history has no timeline, by design); KPI governance (`src/kpi/`), KPI runtime + history/comparison/trend (`src/modules/kpi-runtime/`), `/admin/kpis` UI.

**Authorization pattern (all nine):** source-owned remit, one remit per route, NO `reporting.*` permission, server-resolved tenant actor, tenant-first predicates, module entitlement guard.

## D. Candidate Discovery Method

Repository-wide search (backend + web + docs), not limited to the hard-coded brief list:

- `docs/reports/PHASE-REPORTING-*.md` (all phase records incl. the superseded prior review), `docs/architecture/KPI-CATALOG.md`, `docs/PHASE-C*`/`PHASE-UI-*` commerce contracts, `docs/PHASE-FINANCIAL-*`, `docs/PHASE-PRODUCTION-*`, ADR-0004/0005.
- `apps/api/src/modules/**` directory inventory — only cms, commerce, correspondence, financial, hr, kpi-runtime, production, reporting exist; all route names inspected (`pending-decisions`, `commercial-assignments`, `commercial-approvals`, `:id/receipts`, correspondence `search/drafts/sent/inbox/archive/tracking`).
- All five Prisma schema headers + model lists (commerce, hr, production, financial, correspondence).
- `apps/web/src/app/admin/**` route tree, `core-nav.ts` (nav + page-title aliases), component inventories (`reporting/`, `kpi/`, `core/`, `hr/`), marketing pages.
- KPI catalog entries KPI-001…KPI-009 — non-approved KPIs treated as report-shaped questions and cross-checked.
- Known-gap documents: `PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md` (GAP-1…GAP-7), `PHASE-REPORTING-FIRST-CAPABILITY-EVIDENCE.md`, `PHASE-REPORTING-BOUNDED-CONTEXT.md`.
- `.tmp` artifacts, deleted AEKES scaffold, and marketing copy treated as history/never-as-requirements.

**New candidates discovered this phase (not in the brief's list):** (1) Commerce GAP-4 KPI/summary endpoint family, (2) Financial check **stage sub-register views** (allocation/review/executive/issue/delivery), (3) Commerce **current-assignment list** as a reporting surface. Total inventory: **35 candidates** (9 implemented + 26 remaining).

## E. Evidence Method

Per candidate, an evidence packet across 16 dimensions (business purpose, source of truth, bounded context, row grain, semantic model, lifecycle, date semantics, filters, authorization, tenant, data completeness, audit/history, export suitability, KPI overlap, cross-domain dependency, product value) built ONLY from: schema headers/models, pure domain modules (status/projection files), controllers/permissions, seam contracts, phase records, KPI catalog. Five gates then decide readiness — **Gate 1 DATA → Gate 2 OWNERSHIP → Gate 3 SEMANTICS → Gate 4 ARCHITECTURE → Gate 5 PRODUCT SCOPE** — and a candidate is READY only if all five pass with scope sufficiently bounded. No numeric score was used as a readiness basis. Inference is never presented as fact (see *Evidence vs Assumption*).

## F. Classification Taxonomy

Exactly one primary classification per candidate: `IMPLEMENTED` · `READY` · `READY_WITH_SCOPE_DECISION` · `EVIDENCE_REVIEW` · `BLOCKED_SOURCE_DATA` · `BLOCKED_SOURCE_CONTRACT` · `NOT_REPORTING` · `PRODUCT_DECISION` · `DUPLICATE / COVERED` · `DEFERRED`. Vague labels (maybe/probably/later/TBD) are forbidden. `DEFERRED` ended at **0**: every parked item carries a stronger, evidence-backed label — nothing was parked without a named blocker or decision.

```text
                    Candidate
                        |
                        v
                 Source exists?  --NO--> BLOCKED_SOURCE_DATA / SOURCE_CONTRACT
                        | YES
                        v
                 Ownership clear? --NO--> BLOCKED (ambiguous owner)
                        | YES
                        v
              Stable semantics?  --NO--> EVIDENCE_REVIEW (open question named)
                        | YES
                        v
           Architecture valid?   --NO--> BLOCKED_SOURCE_CONTRACT
                        | YES
                        v
                Product fit?     --NO--> NOT_REPORTING / PRODUCT_DECISION
                        | YES
                        v
          READY / READY_WITH_SCOPE_DECISION
```

## G. Full Portfolio Matrix

Legend: ✓ proven · ✗ not proven (blocker named) · N/A genuinely does not apply. Every cell is evidence-backed; `Partial:*` states exactly what is missing.

### G.1 Implemented (rows 1–9)

| # | Candidate | Context | Purpose | Row Grain | Source | Own | Dates | Filters | Auth | Tenant | Audit | X-Domain | KPI Overlap | Fit | Class | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Check Request Status & Flow | Financial | where are our cheque requests, how did they move | one `CheckRequest` | ✓ | ✓ | ✓ requestDate/submittedAt/decidedAt | ✓ status/search | ✓ `financial.check.read` | ✓ | ✓ timeline | none | supports KPI-005 | ✓ | IMPLEMENTED | — |
| 2 | Purchase Request Status | Commerce | purchase document lifecycle state | one `PurchaseDocument` | ✓ | ✓ | ✓ createdAt/completedAt | ✓ status/search/requesterId | ✓ `commerce.read` | ✓ | ✓ timeline | none | supports KPI-003/004 | ✓ | IMPLEMENTED | — |
| 3 | BOM Summary & Status | Production | BOM register state | one `BomHeader` | ✓ | ✓ | ✓ createdAt/submittedAt/decidedAt | ✓ status/search | ✓ `production.bom.read` | ✓ | ✓ timeline | none | supports KPI-001/002 | ✓ | IMPLEMENTED | — |
| 4 | Personnel Traffic | HR | who punched in/out, when | one `Attendance` row | ✓ | ✓ | ✓ workDate/dateKey/clock times | ✓ from/to/source/search | ✓ `hr.attendance.read` | ✓ | ✓ timeline | none | KPI-007 could drill (DRAFT) | ✓ | IMPLEMENTED | — |
| 5 | BOM Change Request Status | Production | change requests against BOMs | one `BomChangeRequest` | ✓ | ✓ | ✓ requestDate/submittedAt/decidedAt | ✓ bomId/projectRef/status/search | ✓ `production.bom.read` | ✓ | ✓ timeline | none | none | ✓ | IMPLEMENTED | — |
| 6 | Leave Request Status | HR | leave request lifecycle | one `LeaveRequest` | ✓ | ✓ | ✓ startDate/endDate/cancelledAt | ✓ employee/leaveType/status/from/to | ✓ `hr.leave.read` | ✓ | ✓ timeline | none | none | ✓ | IMPLEMENTED | — |
| 7 | Mission Request Status | HR | mission request lifecycle | one `MissionRequest` | ✓ | ✓ | ✓ startDate/endDate | ✓ employee/status/durationMode/from/to | ✓ `hr.mission.read` | ✓ | ✓ timeline | none | none | ✓ | IMPLEMENTED | — |
| 8 | Payment History | Commerce | payments against documents | one `PaymentRecord` | ✓ | ✓ | ✓ paymentDate/createdAt | ✓ status/search (doc-scoped) | ✓ `commerce.read` | ✓ | ✓ | none | none | ✓ | IMPLEMENTED | — |
| 9 | Return Lifecycle | Commerce | return document lifecycle | one `ReturnDocument` | ✓ | ✓ | ✓ createdAt per transition | ✓ state/search | ✓ `commerce.read` | ✓ | ✓ timeline | none | none | ✓ | IMPLEMENTED | — |

### G.2 Remaining candidates (rows 10–19)

| # | Candidate | Context | Purpose | Row Grain | Source | Own | Dates | Filters | Auth | Tenant | Audit | X-Domain | KPI Overlap | Fit | Class | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Commerce Receiving Status | Commerce | what arrived vs ordered, per purchase line | per-line ✓ (roll-up open) | ✓ `Receipt`/`ReceiptLine` + pure `projectReceivingStatus` | ✓ | ✓ receipt/received times | Partial: doc-scoped only today | ✓ `commerce.read` | ✓ tenant-first cols | Partial: commerce audit gateway | none (same ctx as purchase) | none | ✓ "what arrived" | READY_WITH_SCOPE_DECISION | decide grain (line vs doc), then narrow Commerce seam |
| 11 | Production Pending Approval Aging | Production (KPI lane) | how long have undecided BOMs waited | snapshot metric over pending BOMs | ✓ `submittedAt` + `SUBMITTED` population | ✓ (KPI-008 owner) | ✓ `submittedAt`; as-of instant ✗ | ✗ (no window; as-of undecided) | ✓ `production.bom.read` | ✓ | N/A (metric, not rows) | none | OWNED BY KPI-008 | metric → KPI, queue already in register | EVIDENCE_REVIEW | KPI governance fixes aggregation + as-of; do NOT build as report |
| 12 | HR Leave Balance | HR | entitlement remaining per employee/type | n/a — no model | ✗ no `LeaveBalance` table (schema header defers explicitly) | HR (would own) | ✗ | ✗ | (remit exists) | — | — | none | none | real question, no source | BLOCKED_SOURCE_DATA | domain must own accumulation (balance/accrual/carry-over/adjustment) |
| 13 | Financial Statements (BS/IS/CF/Budget) | Financial | solvency/profit/cash position | n/a — no model | ✗ no journal/ledger/budget/periods | Finance | ✗ | ✗ | — | — | — | needs Commerce+Production+HR | none | ✓ but zero source | BLOCKED_SOURCE_DATA | Financial must first model accounting truth |
| 14 | Finance Expense/Revenue/Cost Analysis | Financial | spend/revenue trends | n/a | ✗ no money aggregation semantics | Finance | ✗ | ✗ | — | — | — | likely multi-ctx | none | ✓ but zero source | BLOCKED_SOURCE_DATA | governed financial vocabulary first |
| 15 | Production Efficiency/Downtime/Quality/Cost/OEE/Utilization | Production | plant performance | n/a | ✗ contract pins absence (no quantity/cost/time columns) | Production | ✗ | ✗ | — | — | — | none | would compete KPI lane | ✓ but zero source | BLOCKED_SOURCE_DATA | domain must model machine time/quality/cost |
| 16 | HR Attendance Rate/Overtime/Working Hours/Productivity | HR | reliability & effort metrics | n/a | ✗ no status/hours/shift/calendar | HR | Partial: punches only | ✗ | — | — | — | none | KPI-007-adjacent | ✓ but zero source | BLOCKED_SOURCE_DATA | shift+calendar+governed verdicts required |
| 17 | Commerce Pending Purchase Aging | Commerce (KPI lane) | age of open purchases | n/a — no start instant | ✗ `START_EVENT_AND_POPULATION_NOT_ESTABLISHED` | Commerce (KPI-009) | ✗ | ✗ | ✓ (would use commerce.read) | ✓ | — | none | OWNED BY KPI-009 (BLOCKED) | ✓ but no start event | BLOCKED_SOURCE_DATA | model submission/state-entry instant first |
| 18 | Inventory/Sales/Procurement/CRM/Maintenance/Assets analytics | (none) | future domains | n/a | ✗ module does not exist | none | — | — | — | — | — | — | none | unproven | BLOCKED_SOURCE_DATA | module must exist first |
| 19 | Supplier Activity / Supplier views | Commerce | supplier spend/performance | n/a | ✗ `supplierId` opaque; no supplier domain | — | — | — | — | — | — | needs supplier domain | none | unproven | BLOCKED_SOURCE_DATA | supplier domain first |

### G.3 Remaining candidates (rows 20–27)

| # | Candidate | Context | Purpose | Row Grain | Source | Own | Dates | Filters | Auth | Tenant | Audit | X-Domain | KPI Overlap | Fit | Class | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20 | Cross-context/cross-database report joins | (none) | enterprise row sets spanning contexts | n/a | Partial: data exists, NO contract | none owns it | — | — | — | — | — | REQUIRED (multi) | feeds dashboards/KPIs | undecided | BLOCKED_SOURCE_CONTRACT | governed cross-context read contract + owning context first |
| 21 | Project Gantt / planning / scheduling | future PM | schedule visibility | n/a | ✗ no project domain (`projectRef` opaque) | future PM context (special rule) | — | — | — | — | — | — | none | out of Reporting scope | NOT_REPORTING | never Reporting; future PM context |
| 22 | Workflow Inbox | Commerce | act on pending decisions | one pending decision | ✓ `GET commerce/pending-decisions` exists | Commerce | ✓ | ✓ | ✓ `commerce.read` | ✓ | ✓ | none | none | operational queue ≠ report | NOT_REPORTING | none — already an operational surface |
| 23 | Employee Directory / org tree | Core+HR | find people/structure | one member/unit | ✓ directory + HR org reads exist | Core/HR | — | ✓ | ✓ directory reads | ✓ | — | none | none | operational ≠ report | NOT_REPORTING | none — already an operational surface |
| 24 | AI Insights / NL report generation / anomaly explanation / narratives / recommendations | Platform AI | machine-generated interpretation | n/a | ✗ `TEXT_GENERATION` ❌ everywhere; gateway embed-only | Platform AI | — | — | — | — | — | — | none | not Reporting; capability absent | NOT_REPORTING | capability + product decision live outside Reporting |
| 25 | Generic BI / Reporting DSL / builder / scheduler / warehouse / saved+subscription reports | (none) | build-anything analytics | n/a | refused by design | none | — | — | — | — | — | — | none | no requirement; isolation suite forbids vocabulary | NOT_REPORTING | never under current guard |
| 26 | Commercial configuration authoring (workflow/commercial settings) | Commerce | configure assignment rules/versions | config version | ✓ operational settings exist | Commerce | ✓ versions | ✓ | ✓ `commerce.configure/manage` | ✓ | ✓ | none | none | operational configuration ≠ report | NOT_REPORTING | none — Commerce configuration surface |
| 27 | Approval-rate / ratio figures as reports | Financial/HR | "what % gets approved" | n/a (rate) | ✗ decision points/denominators undecided | KPI governance | — | — | — | — | — | none | OWNED BY KPI-006/007 (DRAFT) | rates are KPI territory | NOT_REPORTING | KPI governance decides; reports count rows only |

### G.4 Product decisions & duplicates (rows 28–35)

| # | Candidate | Context | Purpose | Row Grain | Source | Own | Dates | Filters | Auth | Tenant | Audit | X-Domain | KPI Overlap | Fit | Class | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | Executive / Operational Cross-Domain Reporting (procurement, purchase-to-payment, bottleneck, HR/production/enterprise overviews) | (none) | one screen answering a managerial question across contexts | n/a | ✗ no cross-domain contract; four DBs; opaque refs | no owner identified | ✗ shared period ✗ | ✗ | ✗ no remit | ✗ | — | REQUIRED (multi) | competes with KPI/dashboard lanes | question real, owner+contract+purpose undefined | PRODUCT_DECISION | name owner + requirement + contract, or stay out |
| 29 | Executive Dashboard | (none) | multi-card managerial overview of composed sources | one widget card | ✗ no dashboard exists | none | — | — | — | — | — | REQUIRED | would compose KPIs | purpose undefined | PRODUCT_DECISION | define purpose/owner/sources; see section O |
| 30 | Management Dashboard | (none) | same family as #29 | one widget card | ✗ no dashboard exists | none | — | — | — | — | — | REQUIRED | would compose KPIs | purpose undefined | PRODUCT_DECISION | same decision as #29 |
| 31 | Correspondence Letter (tenant-wide status report) | Correspondence | org-wide letter status/history beyond personal views | one `Letter` (proven) | ✓ `Letter` + 5-state canonical + per-recipient states + `LetterTrackingEvent` + referrals | ✓ | ✓ letterDate/scheduledAt/readyAt/sentAt/cancelledAt | Partial: operational search exists; report filters undecided | Partial: `correspondence.manage`/`confidential.*` seeded; report remit undecided | ✓ `tenantId` | ✓ tracking events | none | none | audience (participant vs manager) + confidentiality projection undecided | PRODUCT_DECISION | decide audience+remit; then correspondence-owned seam |
| 32 | Commercial Assignment (assignment history report) | Commerce | why/how were lines assigned over time | one history event (append-only) | ✓ `CommercialAssignment` current row + `CommercialAssignmentHistory` (`changedAt`) + `CommercialApproval` | ✓ | ✓ changedAt/createdAt | Partial: doc-scoped read exists | ✓ `commerce.read` (operational) | ✓ | ✓ history table | none | none | purpose (audit vs config surface) undecided | PRODUCT_DECISION | decide report-vs-operational; do not duplicate inbox |
| 33 | Commerce GAP-4 KPI/summary endpoint family | Commerce | home counters/spend figures | n/a (aggregates) | ✗ aggregates ungoverned (documented "product decision first") | Commerce | — | — | — | ✓ | — | none | KPI/dashboard-shaped | documented open GAP, metrics undefined | PRODUCT_DECISION | define metrics or drop GAP-4 permanently |
| 34 | Financial check stage sub-register views (allocation/review/executive/issue/delivery) | Financial | per-stage drill | stage row | ✓ stage rows exist and ARE exposed | Financial | ✓ | covered by #1 | ✓ `financial.check.read` | ✓ | ✓ | none | none | covered by report #1 detail/timeline | DUPLICATE / COVERED | none |
| 35 | Commerce current-assignment list as report | Commerce | list current assignments | current row per line | ✓ `GET commercial-assignments` exists | Commerce | ✓ | ✓ | ✓ `commerce.read` | ✓ | ✓ | none | none | covered by operational endpoint | DUPLICATE / COVERED | none |

## H. Commerce Review

**Implemented:** Purchase (#2), Payment History (#8), Return Lifecycle (#9).

**Receiving (#10) — deep source review.** The receiving domain is real: append-only `Receipt`/`ReceiptLine` (schema header: receiving events are records, never mutated), a PURE deterministic per-line projection `projectReceivingStatus` (`NOT_RECEIVED|PARTIALLY_RECEIVED|FULLY_RECEIVED`; inputs = Σ receipt-line quantities incl. negative compensations vs the line's ordered quantity; NO stored status), operational routes `GET/POST :id/receipts` + compensate under `commerce.read/manage`. Proven: source, ownership, per-line grain, timestamps, quantity semantics, tenant-first columns, remit. NOT proven: a per-**document** roll-up rule (no domain-defined document-level status), a tenant-wide listing shape (reads are per-document today), compensation presentation in a register. The grain question is a **scope decision**, not missing data → `READY_WITH_SCOPE_DECISION`. Decision required: per-line register (semantics fully proven — recommended) vs per-document roll-up (requires Commerce to define the roll-up rule = new domain semantics).

**Commercial Assignment (#32/#35).** `CommercialAssignment` is a CURRENT row (one per line per tenant, `ASSIGNED|UNASSIGNED`, source, resolved user, matched rule label, config version); `CommercialAssignmentHistory` is APPEND-ONLY (`changedAt` — every create/reassign writes a new row, no update path); `CommercialApproval` has its own `PENDING|APPROVED|REJECTED` lifecycle with decision routes. Current-state list = already served operationally (`GET commercial-assignments`) → duplicate (#35). The approval queue = workflow/operations (decision routes exist; do not duplicate Workflow Inbox). The **history** is report-shaped but its audience/purpose ("audit of rule outcomes" vs configuration-surface concern) is undecided → `PRODUCT_DECISION`.

**GAP-4 (#33).** `PHASE-UI-5` marks the Commerce KPI/summary endpoint family STILL OPEN with an explicit "product decision first" marker; no formula, no metric vocabulary exists → `PRODUCT_DECISION` (KPI/dashboard-shaped, not a register).

**Not reportable:** sales/revenue/supplier views (#19) — `supplierId` opaque, kind vocabulary `['PURCHASE_REQUEST']` only. Pending purchase aging (#17) — KPI-009 BLOCKED, no start instant. Pending-decisions inbox (#22) and commercial configuration (#26) — operational, not Reporting.

## I. HR Review

**Implemented:** Personnel Traffic (#4), Leave Request (#6), Mission Request (#7) — HR's reportable registers are complete.

**HR Leave Balance (#12) — deep source review.** Verdict: `BLOCKED_SOURCE_DATA`.
- **Persisted authoritative balance?** NO. No `LeaveBalance` table; the schema header states «LEAVE BALANCES — NOT IN THIS PHASE… a balance that no authoritative entitlement defines, moved by no approval, would be a number nothing can validate»; later sections repeat «no balance, entitlement, accrual or carry-over (§13)» / «NO BALANCE, NO COUNTER».
- **Calculated balance?** Nothing computes one; no balance arithmetic exists.
- **Owner?** Would be HR — but `LeavePolicy`/`LeaveLimitDefinition` (versioned, published-immutable) are the *policy catalogue*, not a balance.
- **Per employee/type/period?** The deferred design (`(employeeId, jalaliYear)` entitlement/used/requested) exists only as a schema comment, never as a table.
- **Accrual / carry-over / adjustment?** None modeled (`LeaveCountingBasis`/`LeaveLimitPeriodKind` are limit-definition facets; no accrual engine; no balance-adjustment rows).
- **Entitlement vs used/pending?** `LeaveRequest` statuses allow *counting* used/pending, but the domain does NOT define `balance = entitlement − approved`; inventing that equation is explicitly forbidden by the schema's own rationale.
- **Historical balances reconstructable?** NO — no snapshots, no accumulation events.
- **Reportable without inventing policy semantics?** NO.
Classification: `BLOCKED_SOURCE_DATA`. Minimum unblock: the HR domain must own accumulation (a persisted balance mutated only inside approval transactions, or a published domain equation covering entitlement/accrual/carry-over/adjustment). NOT_REPORTING was considered and rejected: the question is legitimately a reporting question — the source is what is missing.

**Attendance-rate family (#16):** the attendance service header forbids status/late/absent/hours arithmetic (only punches of `[punch, shift, calendar]`; shift/calendar domains do not exist) → `BLOCKED_SOURCE_DATA`.

**Directory/org tree (#23):** operational reads already exist (`admin/directory`, HR org views) → `NOT_REPORTING`.

## J. Production Review

**Implemented:** BOM Summary (#3), BOM Change Request (#5) — the BOM document family is complete.

**Production Pending Approval Aging (#11) — deep source review (KPI-008 boundary).** Facts: `submittedAt` is stamped atomically with DRAFT→SUBMITTED (the routing instant by construction); `SUBMITTED` is the only routed-but-undecided state (correction returns to DRAFT = requester-owned); population and start event are evidence-established; catalog entry `KPI-008` is `EVIDENCE_REVIEW` with TWO open questions — which aggregation statistic (mean / oldest / bands) and how the as-of evaluation instant is fixed — plus `target/threshold NOT_DEFINED` (no SLA evidence).

Boundary verdict — the item is THREE things, and only one is Reporting's:
1. **Live operational queue** → already served: the BOM register (report #3 + source screens) filters `status=SUBMITTED`; a queue is Workflow/Operations, and it exists.
2. **Historical/snapshot aging metric** → KPI territory (KPI-008). "Mean age of pending" is a *metric*, not a row register; building it as a report would create an ungoverned aggregate AND duplicate the future KPI runtime.
3. **Report** → nothing new: a per-row "days pending" column would re-derive what the KPI will compute, and rows already carry `submittedAt`.

Classification: `EVIDENCE_REVIEW` (owner: KPI governance). Do NOT build it as a report; KPI-008 must first fix aggregation + as-of semantics. No double-build.

**Efficiency/Downtime/Quality/Cost/OEE/Utilization (#15):** the Production reporting contract pins their absence (no quantities, completion %, cost, efficiency; `BomItem` coefficients `Int ≥ 0` with no sum rule) → `BLOCKED_SOURCE_DATA`. `planned + actual ⇒ efficiency` remains explicitly rejected.

## K. Financial Review

**Implemented:** Check Request Status & Flow (#1) — Financial's only modeled aggregate.

**Accounting statements (#13) and expense/revenue/cost analyses (#14):** `finance_db` contains `CheckRequest` + 5 stage tables + `CheckAttachment` + `AuditOutbox` — nothing else. The schema header states Financial owns no Project, no Purchase Order, no Bank, no Cheque account; prior evidence records: NO budget, NO journal, NO ledger, NO accounting periods, no debit/credit vocabulary, cheque-instrument identity NOT_ESTABLISHED. The stage-3 amounts are source-stage facts, not a governed revenue/expense vocabulary. Any P&L or cash-flow would additionally need Commerce+Production+Inventory+HR aligned semantics — none exist. → `BLOCKED_SOURCE_DATA` (both). NOT_BLOCKED_SOURCE_CONTRACT: the problem precedes contracts — there is no truth to contract over. If Financial someday models accounting, the *minimum architectural prerequisite* is a Financial-owned reporting/read seam exactly like `financial-check-request-reporting.*` — never Reporting→finance Prisma.

**Stage sub-register views (#34) — newly discovered:** the check-request report's detail already carries the five downstream stage rows (allocation/review/executive/issue/delivery) and the timeline carries their audit; separate stage endpoints would duplicate rows users already reach from the same register → `DUPLICATE / COVERED`.

**KPI-006 approval rate (#27, Financial member):** decision point (manager vs document-review vs executive) undecided → owned by KPI governance as DRAFT; reports must not compute rates → `NOT_REPORTING` as a report candidate.

**Financial operational reports not already implemented:** none exist as candidates — every other Financial route family (issuance, allocation, delivery) is either part of the check-request lifecycle covered by #1 or operational workflow already live under `financial.check.*` remits.

## L. Correspondence Review

**Correspondence Letter (#31) — deep source review.** What the source IS (proven from `prisma/correspondence/schema.prisma` + `letter-status.util.ts` + `correspondence.controller.ts`):
- **Nature:** a **document register with two governed state machines** — a canonical sender-owned lifecycle (`DRAFT → READY_TO_SEND → SCHEDULED → SENT/CANCELLED`, SENT and CANCELLED terminal, frozen transition map pinned by spec) and a per-recipient state machine (`DELIVERED → VIEWED → READ → ACTION_REQUIRED|REFERRED|ACTED`, monotonic reading axis). Plus `LetterReferral` (referral workflow) and `LetterTrackingEvent` (tracking history).
- **Source ownership:** Correspondence context, own database, own client, DC-CORR-01 identity columns (no cross-DB FK; letters survive sender deletion).
- **Row grain:** one `Letter` per row — proven; recipients are a child collection with their own states.
- **Date semantics:** `letterDate` (official date, 00:00 Asia/Tehran), `scheduledAt`, `readyAt`, `sentAt`, `cancelledAt` — all instant-bearing.
- **Tenant:** `tenantId` present; operational routes are participant-scoped by construction (inbox/sent/drafts are personal; no `@Roles` on personal routes).
- **Authorization:** three seeded permissions exist — `correspondence.manage` (tenant-wide administration), `correspondence.confidential.read`, `correspondence.confidential.manage` (CORRESPONDENCE domain, seeded by migration).
- **History:** tracking events + referrals + per-recipient states = reconstructable timeline.
- **Existing surfaces:** `GET search/drafts/sent/inbox/archive/:id/tracking` already serve the *participant* register.

What is NOT decided: (a) **audience** — does a tenant-wide *status report* serve managers, and what does a manager see of confidential letters? (b) the **confidentiality projection** (`LetterClassification` exists), (c) which remit a reporting surface answers to, (d) whether this belongs to Reporting at all vs a Correspondence-administration surface.

Verdict: a document register + communication history + workflow surface owned by Correspondence — NOT generic Reporting material by default. The missing pieces are product decisions, not evidence → `PRODUCT_DECISION`. If decided YES, the architecture is a Correspondence-owned narrow seam (same pattern as the nine), never Reporting→correspondence Prisma. Correspondence management itself (the operational module) remains `NOT_REPORTING`.

## M. Cross-Domain Review

Candidates #28 (Executive/Operational overviews), #29/#30 (dashboards). Evidence: four databases with no cross-DB FKs by architecture; refs (`projectRef`, `supplierId`, `requesterUserId`…) opaque by design; no shared period or filter vocabulary; no owning context for any overview; no requirement document anywhere (docs/, marketing, gap reports searched); `KPI-CATALOG.md` explicitly defers "cross-domain/enterprise KPIs — every first-cohort KPI is owned by exactly one bounded context" and defers "executive dashboard". The only sanctioned path to cross-domain data is a *governed cross-context read contract with a named owner* (row #20, `BLOCKED_SOURCE_CONTRACT`). Explicit boundaries preserved: **Reporting ≠ KPI ≠ Dashboard ≠ AI Decision Support.** No cross-domain report is recommended; any overview first needs a product decision naming owner, question, and contract.

## N. KPI Overlap Review

KPI portfolio verified this phase (catalog + governance specs green; runtime + history/comparison/trend present; `/admin/kpis` UI live):

| KPI | Status | Report relationship |
|---|---|---|
| KPI-001/002 Production BOM cycle/approval | APPROVED | read through report #3's seam — the report IS the drill-down |
| KPI-003/004 Commerce purchase cycle/completion | APPROVED | read through report #2's seam |
| KPI-005 Financial check decision time | APPROVED | read through report #1's seam |
| KPI-006 Check approval rate | DRAFT | decision point undecided — NOT a report (#27) |
| KPI-007 Manual attendance ratio | DRAFT | denominator undecided; could drill into #4 later |
| KPI-008 Production pending aging | EVIDENCE_REVIEW | IS candidate #11 — stays in KPI lane |
| KPI-009 Commerce pending purchase aging | BLOCKED | matches candidate #17 BLOCKED_SOURCE_DATA |

Findings: no implemented report duplicates a KPI (reports count rows; KPIs compute governed indicators with history). No remaining candidate would duplicate KPI runtime/history except #11/#17, which are *already owned* by KPI-008/009. KPI logic has never moved into Reporting; Reporting rows have never been promoted into KPI. GAP-4 (#33) is KPI/dashboard-shaped and stays PRODUCT_DECISION rather than being built as report aggregates.

## O. Dashboard Review

**Existing dashboard: NO** — in the brief's sense: a multi-card/managerial overview composing multiple independent sources/KPIs/reporting domains for a defined managerial purpose. Evidence:

| Surface | What it actually is | Dashboard? |
|---|---|---|
| `CoreDashboard` (`/admin` home) | 4 personal widgets — identity, access, notifications, reminders; code comment: «NO NEW DATA… There is still no KPI, chart or trend on this page» | NO — personal productivity, no composed data sources |
| `HrDashboardView` | HR landing: 4 server-computed org counters + 5 recent employees from ONE endpoint (`GET /hr/organization/summary`) | NO — single-context operational overview |
| Report pages (`/admin/reporting/**`) | register + per-report `ReportSummaryChart` bar | NO — a chart inside a report is not a dashboard |
| `/admin/kpis` | KPI list/detail/trend chart (historical intelligence) | NO — a KPI surface, not a composed dashboard |
| Commerce Home counters | server-total counters, task-first ("No KPI, no spend figure (GAP-4)") | NO |

**Dashboard next action:** PRODUCT_DECISION (#29/#30) — before anything is built: define managerial purpose, owning context, which independent sources/KPIs compose, refresh/authorization model, and explicitly decide report-vs-KPI-vs-dashboard per card. Nothing in Reporting may be relabeled a dashboard to shortcut that decision.

## P. AI Boundary Review

AI is not part of this phase; reviewed ONLY to catch candidates misfiled as Reporting. Findings:
- **AI Insights / anomaly explanation / narrative summaries / recommendation engines / natural-language report generation (#24):** all classified `NOT_REPORTING` — they belong to the Platform-AI capability lane, and the capability matrix records `TEXT_GENERATION ❌` everywhere with the gateway `embed`-only (`PHASE-REPORTING-AI-CONSUMER.md`). No AI behavior was implemented or simulated.
- Reporting's existing AI surface is the embed-only consumer seam (`PlatformAIModule` → `AI_GATEWAY`), guarded by isolation spec group F; it answers no business question and creates no candidate.
- Marketing copy («تولید گزارش» on `(marketing)/ai-agents`) remains INFERRED website copy, never a requirement (per FIRST-CAPABILITY-EVIDENCE classification).
- If a product decision ever wants AI-narrated reports, it requires: provider capability (text generation), an owning context, and output-validation rules — three prerequisites outside Reporting.

## Q. Architecture Review

Verified against the isolation/architecture suites (both green this phase):

| Check | Verdict | Evidence |
|---|---|---|
| Source ownership | PASS | 9/9 source-owned narrow modules (contract+reader+providers inside the owner); Reporting owns NO datasource, NO Prisma, NO client |
| Cross-context policy | PASS | no cross-DB FK/join anywhere; Phase B3 integration-policy guard green in full suite; refs stay opaque |
| Reporting/KPI boundary | PASS | `kpi-governance.spec` (type-only seams) + reporting isolation (no rate/duration vocabulary in reports) both green |
| Reporting/Dashboard boundary | PASS | no dashboard component, route or DTO inside Reporting |
| AI boundary | PASS | embed-only gateway token; isolation group F forbids provider/config reach |
| Authorization convention | PASS | one source remit per route; no `reporting.*` permission; no REPORTING PermissionDomain member |
| Tenant boundary | PASS | server-resolved actor → `ReportingScope { tenantId }` first predicate on every seam call |

Intended architecture for ANY future candidate (unchanged):
```text
Source bounded context
    ↓  (source-owned reporting/read seam: contract + reader)
Reporting
    ↓  (remit/entitlement/tenant gates)
Web / export
```
If the only available path is `Reporting → another context's Prisma`, the candidate is `BLOCKED_SOURCE_CONTRACT` (row #20). Note for reviewers: the isolation spec's prose contains a few historical count words ("four report controllers", "five") superseded by its own executable assertions (`expect(EXPECTED).toHaveLength(9)`, nine controller files) — the executable checks are authoritative and green; the prose lag is cosmetic and was NOT touched (documentation-only phase, no guard edits without factual need).

## R. READY Candidates

**None (0).** Every candidate classified READY in the prior review (BOM Change, Leave, Mission, Payment, Return) was subsequently IMPLEMENTED — that is the definition of the gate working. Applying the five gates freshly to all 26 remaining candidates:

| Candidate | DATA | OWNERSHIP | SEMANTICS | ARCH | PRODUCT | Result |
|---|---|---|---|---|---|---|
| Commerce Receiving (#10) | ✓ | ✓ | ✗ grain open | ✓ | ✓ | READY_WITH_SCOPE_DECISION (section S) |
| Correspondence Letter (#31) | ✓ | ✓ | ✓ | ✓ | ✗ audience open | PRODUCT_DECISION |
| Commercial Assignment history (#32) | ✓ | ✓ | ✓ | ✓ | ✗ purpose open | PRODUCT_DECISION |
| all others | ✗ or N/A | — | — | — | — | BLOCKED / NOT_REPORTING / EVIDENCE_REVIEW per matrix |

No candidate was forced to READY. No READY item is waiting in a hidden state.

## S. READY_WITH_SCOPE_DECISION Candidates

**1. Commerce Receiving Status Report (#10).**
- Why READY-adjacent: source (`Receipt`/`ReceiptLine` append-only), ownership (Commerce), pure projection (`projectReceivingStatus`, 3 states, compensations by construction), dates, remit (`commerce.read`), tenant-first schema — all SOURCE-PROVEN. Export/summary fit: `{total, byStatus}` over a proven state vocabulary.
- Required scope decision (must precede implementation): **row grain** — (A) per-purchase-LINE register (recommended: projection semantics fully proven) vs (B) per-DOCUMENT roll-up (requires Commerce to publish a document-level roll-up rule — that would be new domain semantics, not a report decision). Secondary: tenant-wide listing filters (document/date/status window) and compensation-row presentation.
- Guardrails: never widen the purchase/payment/return tokens — a fourth Commerce seam with its own aggregate token; no stored status; no invented document status.

## T. BLOCKED Candidates

### BLOCKED_SOURCE_DATA (8)

| Candidate | Exact blocker | Minimum unblock |
|---|---|---|
| HR Leave Balance (#12) | no `LeaveBalance` table; no accrual/carry-over/adjustment; no published balance equation (schema header forbids inventing one) | HR domain owns accumulation (persisted balance in approval transactions OR published equation) |
| Financial Statements (#13) | no journal/ledger/budget/accounting periods in `finance_db` | Financial models accounting truth first |
| Finance Expense/Revenue/Cost (#14) | no governed money vocabulary or aggregation rules | Financial publishes revenue/expense semantics |
| Production Efficiency family (#15) | no quantity/cost/machine-time/quality columns; contract pins absence | Production models those facts |
| HR Attendance Rate/OT (#16) | no status/hours/shift/calendar; attendance header forbids arithmetic | shift + calendar domains + governed verdicts |
| Commerce Pending Purchase Aging (#17) | `START_EVENT_AND_POPULATION_NOT_ESTABLISHED` (KPI-009 blocked reason) | model a submission/state-entry instant |
| Inventory/Sales/Procurement/CRM/Maintenance/Assets (#18) | modules do not exist (`apps/api/src/modules/` inventory) | build the bounded context first |
| Supplier Activity (#19) | `supplierId` opaque; no supplier domain | supplier domain first |

### BLOCKED_SOURCE_CONTRACT (1)

| Candidate | Exact blocker | Minimum unblock |
|---|---|---|
| Cross-context/cross-database report joins (#20) | no governed cross-domain read contract; four DBs, no cross-DB FK by architecture; no owning context | named owning context + published cross-context read contract (Reporting never reads sibling Prisma) |

## U. NOT_REPORTING Candidates (7)

| Candidate | Reason (owner instead) |
|---|---|
| Project Gantt / planning / scheduling (#21) | belongs to the future Project Management context; no project domain exists (`projectRef` opaque) — special rule from the brief upheld |
| Workflow Inbox (#22) | an operational queue that ALREADY EXISTS (`GET commerce/pending-decisions`, `commerce.read`) — Commerce/Workflow Operations |
| Employee Directory / org tree (#23) | operational reads already exist (Core directory; HR org views) — Core/HR operational |
| AI Insights / NL generation / anomalies / narratives / recommendations (#24) | Platform-AI capability lane; `TEXT_GENERATION ❌`, embed-only gateway; no requirement |
| Generic BI / Reporting DSL / builder / scheduler / warehouse / saved+subscription reports (#25) | no requirement anywhere; isolation suite forbids the vocabulary by design |
| Commercial configuration authoring (#26) | Commerce settings/configuration surfaces (operational), already implemented |
| Approval-rate/ratio figures as reports (#27) | rates are KPI territory — KPI-006/KPI-007 governance owns the open questions; reports count rows only |

## V. PRODUCT_DECISION Candidates (6)

| Candidate | Product question that must be answered |
|---|---|
| Executive / Operational Cross-Domain Reporting (#28) | Which concrete managerial question, who owns it, which cross-context contract, and is it report/KPI/dashboard at all? |
| Executive Dashboard (#29) | What is its managerial purpose, which independent sources compose it, who owns it? |
| Management Dashboard (#30) | Same as #29 — decide whether these are one surface or two |
| Correspondence Letter status report (#31) | Audience: participant views exist — is a tenant-wide manager view wanted, and what is the confidentiality projection + remit? |
| Commercial Assignment history (#32) | Is auditing assignment outcomes a Reporting feature or a Commercial configuration-surface concern? |
| Commerce GAP-4 KPI/summary family (#33) | Which metrics, what formulas, who owns them — or close the GAP permanently as out-of-scope |

## W. Deferred Items

**None (0).** No candidate was left in an unspecified state. Items that earlier reviews called "deferred" now carry exact labels: accounting/production/attendance analytics → BLOCKED_SOURCE_DATA; executive overviews/dashboards → PRODUCT_DECISION; inbox/directory/BI/AI → NOT_REPORTING; KPI-shaped figures → KPI-lane ownership (NOT_REPORTING as reports). "Do NOT build yet" from the prior review remains in force for all BLOCKED/NOT_REPORTING/PRODUCT_DECISION rows until their named blocker or decision is resolved.

## X. Recommended Next Roadmap

Each item references its exact classification. Items marked DECISION or BLOCKED are NOT implementation starts.

1. **[READY_WITH_SCOPE_DECISION] Decide the Commerce Receiving row grain, then implement** — product chooses: (A) per-purchase-LINE register (recommended; projection semantics fully proven) or (B) per-document roll-up (only if Commerce first publishes a document-level roll-up rule). Only after (A)/(B) is recorded may a narrow Commerce-owned receiving seam + register be built exactly like the nine (#10).
2. **[PRODUCT_DECISION] Answer the audience questions for Correspondence (#31) and Commercial Assignment history (#32)** — manager-wide letter view (with confidentiality projection + remit)? Assignment-outcome history as Reporting feature or Commercial configuration surface? Record the answers; build nothing until they are written.
3. **[PRODUCT_DECISION] Settle the dashboard/outside lane: #28/#29/#30 + GAP-4 #33** — purpose, owner, composed sources, and whether GAP-4 is dropped permanently. No cross-domain build of any kind before this.
4. **[EVIDENCE_REVIEW] KPI-008 aging stays in the KPI lane** — the KPI governance phase (not Reporting) must fix the aggregation statistic and as-of instant; the live queue is already served by report #3 + source screens.
5. **[BLOCKED_SOURCE_DATA] Nothing starts on balances/statements/metrics until the owning domain models the truth** — HR balance accumulation, Financial accounting vocabulary, Production machine-time/quality facts, shift/calendar verdicts, Commerce submission instants. Re-review on new evidence only.

## Y. Known Limitations

- This is an evidence/classification phase: no business logic was touched, so `typecheck`/build were not re-run; suites that *were* run cover every touched-nothing guarantee (section Z).
- The web full-suite single failure (`CoreSurveyDetailView`, passing 20/20 in isolation; unrelated survey surface, parallel-run flake) is reported verbatim, not hidden.
- The isolation spec's historical prose ("four report controllers", "five") lags its own green executable assertions; noted in section Q, left untouched.
- `DEFERRED: 0` is a deliberate result, not an oversight — every parked item has a named blocker or decision (section W).
- No report-shaped candidate was found for CMS content, correspondence participant views (already served), or employment-position catalogues (operational); absence of classification is NOT absence of review — those surfaces were inspected and judged operational.

## Z. Final Verification

```text
Working tree before commit:  one modified tracked file (this document);
                             one untracked GENERATED file (apps/web/next-env.d.ts, not staged)
git diff --check:            (run at commit time — required to pass)
git diff --stat:             1 file changed, only docs/reports/PHASE-REPORTING-PORTFOLIO-EVIDENCE-REVIEW.md
Implementation code changed: NONE
Commit:                      docs(reporting): complete reporting portfolio evidence review
Blind git add:               FORBIDDEN — staged explicitly by path
```

## Evidence vs Assumption

Per-candidate status tags. **SOURCE-PROVEN** = asserted from the exact source named; **TEST-PROVEN** = an executed suite in this phase; **INFERRED** = honest rounding of a documented fact; **INTENTIONALLY-NOT-SUPPORTED** = a refused inference; **BLOCKED** = classification stops at a named gate.

| Candidate | Tag | Note |
|---|---|---|
| #1–#9 (nine reports) | SOURCE-PROVEN + TEST-PROVEN | composition root, seams, routes read; Reporting 185/185, seams 94/94, arch 28/28, API 4504/4504, web reporting+KPI 222/222 all executed this phase |
| #10 Receiving | SOURCE-PROVEN (per-line) / INTENTIONALLY-NOT-SUPPORTED (document roll-up) | projection read in `receiving-status.ts`; document status absent — INFERRED as open grain, NOT as missing data |
| #11 Aging | SOURCE-PROVEN (start+population) / TEST-PROVEN (KPI-008 EVIDENCE_REVIEW) | aggregation + as-of BLOCKED at catalog level; queue-served-by-#3 is SOURCE-PROVEN |
| #12 Leave Balance | SOURCE-PROVEN (absence) | schema header explicitly defers; `balance = entitlement − approved` is INTENTIONALLY-NOT-SUPPORTED (domain never defines it) |
| #13–#19 | SOURCE-PROVEN (absence or header-pinned refusal) | inventory of models/modules read; no semantics invented |
| #20 | SOURCE-PROVEN (no contract exists) | four-DB architecture + no owning context; anything else would be inference |
| #21–#27 | SOURCE-PROVEN (their homes exist or their source does not) | inbox/directory/settings/AI-lane surfaces read or verified absent |
| #28–#30 | SOURCE-PROVEN (no owner/requirement/contract/dashboard exists) | docs searched; CoreDashboard + HrDashboardView + /admin/kpis inspected |
| #31 Correspondence | SOURCE-PROVEN (model/machines/dates/permissions/surfaces) / BLOCKED at Gate 5 | audience + projection are decisions, not evidence |
| #32 Assignment | SOURCE-PROVEN (current row/history/approvals/endpoints) / BLOCKED at Gate 5 | purpose is a decision, not evidence |
| #33 GAP-4 | SOURCE-PROVEN (open-gap marker + "product decision first") | metrics undefined — nothing invented |
| #34–#35 | SOURCE-PROVEN (existing surfaces carry the rows) | duplicate claim verified against #1 and `GET commercial-assignments` |
| Full-web flake | TEST-PROVEN (reported honestly) | 2007/2008; the one failure passes 20/20 in isolation (`CoreSurveyDetailView`) |
