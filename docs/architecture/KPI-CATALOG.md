# KPI Catalog — Definition & Governance

> **Phase:** KPI-DEFINITION-GOVERNANCE (first KPI cohort)
> **Primary governance record** for KPI definitions in this repository. The typed registry
> (`apps/api/src/kpi/kpi-catalog.ts`) and this document are pinned to each other by
> `kpi-governance.spec.ts`: same nine IDs, same technical keys, same statuses. One cannot
> drift from the other without failing the build.
>
> **This phase defines KPIs; it does not calculate them.** The definitions below were
> established documentation-first. The later KPI-RUNTIME and KPI-HISTORICAL-INTELLIGENCE
> phases compute the five `APPROVED` entries read-only through the reporting seams
> (`apps/api/src/modules/kpi-runtime/`), including bounded history and period comparison —
> still by design with **no KPI database, no scheduler, no alerting, no dashboard builder,
> and no generic calculation engine**. Runtime semantics live in that context and in
> `docs/reports/PHASE-KPI-HISTORICAL-INTELLIGENCE.md`; this document remains the authority
> for WHAT each KPI means.

## How to read this catalog

Every KPI below carries the complete governance chain required before any number may be
calculated:

```text
Business Question → KPI Definition → Business Owner → Authoritative Source → Formula
      → Time Semantics → Scope/Filters → Dimensions → Unit → Target/Threshold
      → Authorization → Refresh Semantics → Data Quality → Approval State
```

**No KPI is approved when any critical semantic part is guessed.** Where repository evidence
was insufficient, the KPI is `DRAFT`, `EVIDENCE_REVIEW`, or `BLOCKED` with the missing
evidence named explicitly — never filled in with a plausible default.

### Lifecycle states

| State             | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `DRAFT`           | Definition sketched; required semantics or evidence still open.             |
| `EVIDENCE_REVIEW` | Source evidence reviewed and documented; product/runtime decisions pending. |
| `APPROVED`        | Every quality gate (below) satisfied — eligible for a future runtime phase. |
| `BLOCKED`         | Required semantic/source evidence does not exist; `blockedReason` names it. |
| `DEPRECATED`      | Retained for history; must not be consumed by a future runtime.             |

### Quality gates for `APPROVED` (enforced executably)

`kpiApprovalIssues` in `apps/api/src/kpi/kpi-definition.model.ts` checks each gate; the
registry fails to validate if an approved entry misses any:

- definition unambiguous, business question stated, owner known (bounded-context category);
- authoritative source named (aggregate + seam contract + single-writer evidence);
- structural formula present (no expression strings, no SQL, no eval);
- population **and** exclusions explicit; invalid rows excluded, never zero-filled;
- time semantics explicit (cohort field, start/end events, window, timezone, calendar);
- unit explicit (storage-independent semantic unit + presentation unit);
- tenant scope = current authenticated tenant; dimensions source-supported;
- authorization understood (existing source remit, no new permission);
- data-quality notes and known limitations stated; evidence list non-empty;
- target/threshold either `DEFINED` (with evidence) or explicitly `NOT_DEFINED`
  (with evidence of absence) — targets are **optional at this stage**, invention is not;
- no open questions, no blocked reason.

### Shared governance decisions (apply to all nine)

- **Tenant scope:** `CURRENT_AUTHENTICATED_TENANT` — every KPI is tenant-scoped; cross-tenant
  executive aggregation is a later architectural decision and exists nowhere today.
- **Timezone:** storage is UTC instants (`timestamptz`); the wall clock is
  `Asia/Tehran` (`APP_TIME_ZONE`, `src/calendar/jalali.util.ts`).
- **Calendar:** elapsed durations are calendar-independent instant differences; period
  bucketing is the **Jalali calendar month in Asia/Tehran**, matching the product's existing
  Jalali presentation convention (`reportDateLabel`, `jalaliYear` document numbering, HR
  `dateKey`).
- **Targets/thresholds:** every entry is `NOT_DEFINED` with evidence — no schema carries an
  SLA column and the three reporting phases explicitly deferred SLA/processing-time semantics.
- **Refresh:** `NOT_APPLICABLE_DEFINITION_ONLY` — nothing computes, stores, or refreshes a
  KPI value in this phase.
- **Authorization:** KPI reads answer to the _source report's_ existing remit
  (`production.bom.read`, `commerce.read`, `financial.check.read`, `hr.attendance.read`) plus
  the module entitlement. KPI governance introduces **no new permission and no new surface**.
- **Dependency direction (unchanged):** Domain → domain-owned reporting seam → Reporting →
  KPI governance. The registry reaches seam contracts **by type only** (`import type`, erased
  at compile time) — proven by `kpi-governance.spec.ts`.
- **Formulas are structural:** closed unions (`MEAN_ELAPSED`, `RATIO_PERCENT`) over source
  fields and closed status vocabularies. No `eval`, no SQL strings, no formula DSL.

## Readiness matrix

| KPI                                           | Status                        | Data quality | Cohort |
| --------------------------------------------- | ----------------------------- | ------------ | ------ |
| KPI-001 Production BOM Decision Cycle Time    | `APPROVED`                    | YELLOW       | FIRST  |
| KPI-002 Production BOM Approval Rate          | `APPROVED`                    | GREEN        | FIRST  |
| KPI-003 Commerce Purchase Cycle Time          | `APPROVED`                    | YELLOW       | FIRST  |
| KPI-004 Commerce Purchase Completion Rate     | `APPROVED`                    | YELLOW       | FIRST  |
| KPI-005 Financial Check Request Decision Time | `APPROVED`                    | YELLOW       | FIRST  |
| KPI-006 Financial Check Request Approval Rate | `DRAFT` (candidate)           | BLOCKED      | SECOND |
| KPI-007 HR Manual Attendance Ratio            | `DRAFT` (candidate)           | YELLOW       | SECOND |
| KPI-008 Production Pending Approval Aging     | `EVIDENCE_REVIEW` (candidate) | GREEN        | SECOND |
| KPI-009 Commerce Pending Purchase Aging       | `BLOCKED`                     | BLOCKED      | SECOND |

Every status above is evidence-determined (§34): the five first-cohort KPIs passed all
quality gates; the four second-cohort entries are documented for future implementation with
their open questions or blocked reasons named — none was approved automatically.

## KPI-001 — Production BOM Decision Cycle Time

- Technical key: `production-bom-decision-cycle-time`
- Status: `APPROVED`
- Persian name: **میانگین زمان تصمیم‌گیری فهرست مواد (BOM)**
- Owner context: `production` — **Production** owns the BOM lifecycle; decision authority is
  the snapshotted approver holding `production.bom.approve`.
- Business question: How long does an approver take, on average, to decide a submitted BOM?

**Definition.** Population: BOM headers of the current tenant with status `APPROVED` or
`REJECTED` (the two verified terminal states), `submittedAt` non-null, `decidedAt` non-null,
and `decidedAt >= submittedAt`. One row contributes one value:
`elapsed(decidedAt − submittedAt)` in seconds. Only the **final correction round** is
measured — `REQUEST_CORRECTION` returns the row to `DRAFT`, resubmission overwrites
`submittedAt`, and a new decision overwrites `decidedAt`.

**Formula (structural).** `MEAN_ELAPSED { from: submittedAt, to: decidedAt, statistic: MEAN,
validRowRule: BOTH_TIMESTAMP_FIELDS_NON_NULL, orderingRule: TO_NOT_BEFORE_FROM }`. Mean was
chosen as the simplest deterministic single-value statistic; median/percentiles require a
product decision and are deferred (recorded below, not smuggled in).

**Authoritative source.** `BomHeader` (aggregate root, `production_db`) as projected by the
Production-approved read seam `ProductionReportingReader`
(`apps/api/src/modules/production/reporting/production-reporting.contract.ts`).

**Source contract (single-writer evidence).**

- `BomHeaderRepository.submit` stamps `submittedAt` atomically with the `DRAFT→SUBMITTED` move.
- `BomHeaderRepository.decide` stamps `decidedAt` atomically with the decision move
  (`SUBMITTED→APPROVED|REJECTED`, `REQUEST_CORRECTION→DRAFT`).
- Row fields consumed: `status`, `managerOpinion`, `submittedAt`, `decidedAt`, `createdAt`.
- Tenant-scoped: yes (`scope: { tenantId }`, resolved server-side).

**Time semantics.** Cohort field: `decidedAt` — a BOM submitted in Bahman and decided in
Esfand belongs to the **Esfand** cohort; the decision, not the submission, closes the
measurement, so only `decidedAt` windows are ever complete. Window: Jalali calendar month
in Asia/Tehran. Storage: UTC instants; durations are calendar-independent.

**Population / exclusions.** Excluded and never zero-filled: `DRAFT` rows (including
`NEEDS_CORRECTION` returns — unresolved, not terminal decisions), `SUBMITTED` rows
(undecided), null instants, `decidedAt < submittedAt` (stale pairs), other tenants.

**Dimensions.** `status`, `projectRef`, `productTreeRef`, `decidedAt` (month).
**Unit.** Semantic: `SECONDS` (exact elapsed). Presentation: hours — display conversion only.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` — no SLA evidence exists in the repo.
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization.** `production.bom.read` + `production` module entitlement; no new permission.

**Data quality: YELLOW.**

- Only the final correction round is measurable: submit/decide overwrite the same two
  columns; earlier round pairs are not retained.
- MEAN is outlier-sensitive; median/percentiles deferred pending a product decision.
- The reporting seam exposes `status`/`search` filters only (no date window): period-scoped
  computation requires a seam extension in a future runtime phase.

**Known limitations.** Final-round latency only (cumulative multi-round effort not stored);
no target/threshold.

**Evidence.** `bom-status.ts` (four-member vocabulary; APPROVED/REJECTED terminal;
corrections return to DRAFT) · `bom.repository.ts` (single writers) ·
`production-reporting.contract.ts` (row whitelist carries both instants).

## KPI-002 — Production BOM Approval Rate

- Technical key: `production-bom-approval-rate`
- Status: `APPROVED`
- Persian name: **نرخ تایید فهرست مواد (BOM)**
- Owner context: `production` — **Production** owns the BOM lifecycle; decision authority is
  the snapshotted approver holding `production.bom.approve`.
- Business question: What share of decided BOMs are approved rather than rejected?

**Definition.** Numerator: tenant BOM headers with status `APPROVED` and `decidedAt` inside
the window. Denominator: tenant BOM headers with status `APPROVED` or `REJECTED` with
`decidedAt` inside the window. A window with zero terminal decisions yields
`NOT_AVAILABLE` — **never 0%**.

**Formula (structural).** `RATIO_PERCENT { numerator: {status, oneOf: [APPROVED]},
denominator: {status, oneOf: [APPROVED, REJECTED]}, zeroDenominator: NOT_AVAILABLE }`.
The denominator is closed by the verified four-member lifecycle: APPROVED and REJECTED are
the only terminal states, so no other decision population can leak in; `DRAFT`/`SUBMITTED`
are unresolved **by state-machine evidence, not by choice**.

**Authoritative source.** `BomHeader` via `ProductionReportingReader`; terminal status and
`decidedAt` are written by `BomHeaderRepository.decide` in the same conditional statement
(from `SUBMITTED` only), so terminal rows always carry both.

**Time semantics.** Cohort field: `decidedAt` (Jalali month, Asia/Tehran). Attribution by
submission was considered and **rejected**: it would count undecided rows and keep past
periods open (non-final).

**Population / exclusions.** Excluded: `DRAFT` (editable; correction returns land here),
`SUBMITTED` (routed but undecided), other tenants. Empty denominators → `NOT_AVAILABLE`.

**Dimensions.** `projectRef`, `productTreeRef`, `decidedAt` (month).
**Unit.** Semantic: `PERCENT` (0–100); no presentation rounding is governed.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization.** `production.bom.read` + `production` module entitlement.

**Data quality: GREEN.** Terminal counts are exact (the seam summary zero-fills every
vocabulary member over the filtered population; terminal rows carry `decidedAt` by
construction). Correction history does not leak: corrections return rows to `DRAFT`
(unresolved) until a terminal decision lands; each row contributes exactly one terminal
outcome.

**Known limitations.** No target/threshold.

**Evidence.** `bom-status.ts` (terminality; CORRECTION IS NOT A STATE) ·
`production-reporting.contract.ts` (summary counts per status, zero-filled).

## KPI-003 — Commerce Purchase Cycle Time

- Technical key: `commerce-purchase-cycle-time`
- Status: `APPROVED`
- Persian name: **میانگین زمان چرخه عمر درخواست خرید**
- Owner context: `commerce` — **Commerce** owns the `PurchaseDocument` lifecycle; completion
  authority is gated by the tenant completion policy and the `commerce.manage` remit.
- Business question: How long does a purchase request take, on average, from creation to
  completion?

**Definition.** Population: purchase documents of the current tenant with status `CLOSED`,
`createdAt` non-null, `completedAt` non-null, and `completedAt >= createdAt`. One row
contributes one value: `elapsed(completedAt − createdAt)` in seconds. `PurchaseDocument`
stores **no submission instant** (submit writes only status), so the pair starts at document
creation — the register's own request date — not at routing.

**Formula (structural).** `MEAN_ELAPSED { from: createdAt, to: completedAt, statistic: MEAN,
validRowRule: BOTH_TIMESTAMP_FIELDS_NON_NULL, orderingRule: TO_NOT_BEFORE_FROM }`.

**Authoritative source.** `PurchaseDocument` (aggregate root, `commerce_db`) as projected by
the Commerce-approved read seam `CommercePurchaseReportingReader`
(`apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts`).

**Source contract (single-writer evidence).**

- `PurchaseRepository.createDocument` — `createdAt` is the row creation instant, which the
  reporting contract declares **is** the request date here (no other request-date column
  exists on this aggregate).
- `PurchaseRepository.writeCompletedIn` (via `PurchaseCompletionService`) — the **only**
  writer of `completedAt`, conditional on `completedAt` null, always together with
  status `CLOSED`.
- Row fields consumed: `status`, `kind`, `supplierId`, `createdAt`, `completedAt`.
- Tenant-scoped: yes.

**Time semantics.** Cohort field: `completedAt` — a request created in Bahman and completed
in Esfand belongs to the **Esfand** cohort; the completion closes the measurement. Window:
Jalali calendar month in Asia/Tehran; storage UTC; durations calendar-independent.

**Population / exclusions.** Excluded and never zero-filled: non-`CLOSED` rows (uncompleted),
null `completedAt`, `completedAt < createdAt` (anomaly), other tenants.

**Dimensions.** `status`, `kind`, `supplierId`, `completedAt` (month).
**Unit.** Semantic: `SECONDS`. Presentation: days — display conversion only.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization.** `commerce.read` + `commerce` module entitlement; no new permission.

**Data quality: YELLOW.**

- `completedAt` means the **documented completion act** (`CLOSED`) — not goods receipt,
  payment, or workflow completion; C1 §29 keeps those lifecycles independent by design.
- Creation precedes routing: the aggregate persists no submission instant, so the measured
  cycle starts at document creation (the register's request date).
- Completion is policy-gated and fail-closed: a tenant with no published completion policy
  completes nothing, so zero completions may mean configuration, not performance.

**Known limitations.** Only completed documents are measurable (open documents excluded by
definition); no target/threshold.

**Evidence.** `purchase-status.ts` (six-status vocabulary; `CLOSED` is the completion
destination; every non-`CLOSED` status is a legal completion source) ·
`purchase-completion.service.ts` + `writeCompletedIn` (sole conditional writer) ·
`commerce-purchase-reporting.contract.ts` (row carries `createdAt` = request date and
`completedAt`; no `submittedAt` column exists).

## KPI-004 — Commerce Purchase Completion Rate

- Technical key: `commerce-purchase-completion-rate`
- Status: `APPROVED`
- Persian name: **نرخ تکمیل درخواست‌های خرید**
- Owner context: `commerce` — **Commerce** owns the `PurchaseDocument` lifecycle; completion
  authority is gated by the tenant completion policy and the `commerce.manage` remit.
- Business question: What share of raised purchase requests are actually completed?

**Definition.** Numerator: tenant purchase documents created inside the window with status
`CLOSED`. Denominator: **all** tenant purchase documents created inside the window (every
status). A window with zero created documents yields `NOT_AVAILABLE` — **never 0%**.

**Formula (structural).** `RATIO_PERCENT { numerator: {status, oneOf: [CLOSED]},
denominator: {status, all}, zeroDenominator: NOT_AVAILABLE }`. No exclusion was invented for
the denominator: `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED` and `CANCELLED` are all legal
completion sources by the domain's own vocabulary — every non-`CLOSED` status is a
completion-eligible source, so excluding any of them would fabricate ineligibility.

**Authoritative source.** `PurchaseDocument` via `CommercePurchaseReportingReader`;
numerator rows exist only through `PurchaseCompletionService.close` →
`PurchaseRepository.writeCompletedIn` (fail-closed: no published policy, no completion).

**Time semantics.** Cohort field: `createdAt` (creation cohort, Jalali month,
Asia/Tehran): a request created in Bahman and completed in Esfand still belongs to the
**Bahman** creation cohort — the rate measures what became of documents raised in the
window (right-censoring documented below).

**Population / exclusions.** Excluded: none by status — no exclusion invented. Empty
cohorts → `NOT_AVAILABLE`. Other tenants excluded by tenant scope.

**Dimensions.** `kind`, `supplierId`, `createdAt` (month).
**Unit.** Semantic: `PERCENT` (0–100); no presentation rounding governed.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization.** `commerce.read` + `commerce` module entitlement.

**Data quality: YELLOW.**

- Right-censoring: recently created cohorts are incomplete — documents created near the
  window end may complete later, so immature cohorts read low by construction.
- Policy-dependence: completion is fail-closed; a tenant with no published completion policy
  cannot complete anything, so a low rate may indicate configuration.
- The `CANCELLED` vocabulary exists ("withdrawn before completion") but no inbound
  transition edge reaches it at baseline; if a cancellation writer lands, cohort semantics
  stay unchanged (`CANCELLED` remains a non-completed cohort member) — flagged for re-review.

**Known limitations.** Only the documented completion act (`CLOSED`) counts — not payment,
receiving, or workflow; no target/threshold.

**Evidence.** `purchase-status.ts` (six statuses; completion destination fixed at `CLOSED`;
every non-`CLOSED` member a legal completion source) · `purchase-completion.service.ts`
(fail-closed: no published policy means completion is unavailable, never defaulted).

## KPI-005 — Financial Check Request Decision Time

- Technical key: `financial-check-request-decision-time`
- Status: `APPROVED`
- Persian name: **میانگین زمان تصمیم مدیر درخواست صدور چک**
- Owner context: `financial` — **Financial** owns the `CheckRequest` lifecycle; decision
  authority is the manager holding the `financial.check.manage` remit (the
  «آیا چک صادر شود؟» gate).
- Business question: How long does the manager take, on average, to decide a submitted check
  request?

**Definition.** Population: check requests of the current tenant with `managerDecision`
non-null, `submittedAt` non-null, `decidedAt` non-null, and `decidedAt >= submittedAt`. One
row contributes one value: `elapsed(decidedAt − submittedAt)` in seconds. Only the
**latest manager round** is measured: `REQUEST_CORRECTION` returns the row to `SUBMITTED`
and resubmission overwrites `submittedAt` while a new decision overwrites `decidedAt`.
Rows awaiting a decision for the current submission — including stale pairs where
resubmission moved `submittedAt` ahead of the previous `decidedAt` — are excluded, never
zero-filled.

**Formula (structural).** `MEAN_ELAPSED { from: submittedAt, to: decidedAt, statistic: MEAN,
validRowRule: BOTH_TIMESTAMP_FIELDS_NON_NULL, orderingRule: TO_NOT_BEFORE_FROM }` — the same
governed shape as the approved KPI-001.

**Authoritative source.** `CheckRequest` (aggregate root, `finance_db`) as projected by the
Financial-approved read seam `FinancialCheckRequestReportingReader`
(`apps/api/src/modules/financial/reporting/financial-check-request-reporting.contract.ts`).

**Source contract (single-writer evidence).**

- `CheckRequestRepository.submit` stamps `submittedAt` when the row enters `MANAGER_REVIEW`
  (first submission or after a correction).
- `CheckRequestRepository.decide` stamps `decidedAt` with `managerDecision` in the same
  conditional transition; downstream stages (allocation, document review, executive,
  issuance, delivery) write stage rows and **never** touch `decidedAt`.
- Row fields consumed: `status`, `managerDecision`, `submittedAt`, `decidedAt`,
  `requestDate`, `checkIssueType`, `purchaseType`.
- Tenant-scoped: yes.

**Time semantics.** Cohort field: `decidedAt` — the decision closes the measurement (Jalali
month, Asia/Tehran). Storage UTC; durations calendar-independent.

**Population / exclusions.** Excluded and never zero-filled: rows without a manager
decision; null instants; `decidedAt < submittedAt` (stale pair after resubmission —
awaiting the next decision); other tenants. The stale case is **deterministic**: neither
submit nor decide clears the pair, so the ordering rule — not `managerDecision` alone —
defines the population.

**Dimensions.** `status`, `managerDecision`, `checkIssueType`, `purchaseType`, `decidedAt`
(month).
**Unit.** Semantic: `SECONDS`. Presentation: hours — display conversion only.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization.** `financial.check.read` + `financial` module entitlement; no new permission.

**Data quality: YELLOW.**

- Only the latest manager round is measurable; earlier rounds are not retained as pairs.
- A row in `MANAGER_REVIEW` may carry a stale pair from the previous round — resolved by
  the ordering rule, not by guessing.
- The Financial seam deliberately exposes no date-window filter: period-scoped computation
  requires a seam extension in a future runtime phase.

**Known limitations.** Measures **manager decision latency only** — allocation, document
review, executive, issuance and delivery stages are out of scope and must never be inferred
from audit events or `updatedAt`; MEAN is outlier-sensitive (median/percentiles deferred);
no target/threshold.

**Evidence.** `check-request-status.ts` (ten ordinals including terminal 8 and 50; manager
decision vocabulary `APPROVE|REJECT|REQUEST_CORRECTION`) ·
`check-request.repository.ts` (submit stamps `submittedAt` at `MANAGER_REVIEW` entry;
decide stamps `decidedAt` + `managerDecision`) ·
`financial-check-request-reporting.contract.ts` (row exposes the exact instants — no
audit-derived facts).

## KPI-006 — Financial Check Request Approval Rate

- Technical key: `financial-check-request-approval-rate`
- Status: `DRAFT`
- Persian name: **نرخ تایید درخواست‌های صدور چک**
- Owner context: `financial` — **Financial** owns the `CheckRequest` lifecycle.
- Business question: What share of decided check requests are approved rather than rejected?

**Definition (candidate only — no authoritative definition exists).** The Financial
lifecycle has three distinct decision points — the manager gate («آیا چک صادر شود؟» →
`decidedAt`), the executive gate (stage 5), and the terminal outcome (`COMPLETED` vs
`TERMINATED`) — and no repository evidence designates any one of them as "the approval".
Per the no-guessing rule, no formula may be approved until the business names the point.

**Candidate formulas (prose, not executable):**

- Manager-gate: `100 × count(managerDecision=APPROVE) / count(managerDecision ∈ {APPROVE,
REJECT})` — excludes `REQUEST_CORRECTION` as unresolved at the gate.
- Terminal-outcome: `100 × count(status=COMPLETED) / count(status ∈ {COMPLETED,
TERMINATED})` — terminal states verified `{8, 50}`, but `COMPLETED` means the whole
  issuance flow finished, not merely "approved".

**Authoritative source (for any future formula).** `CheckRequest` via
`FinancialCheckRequestReportingReader`; row fields available: `status`,
`managerDecision`, `decidedAt`, `submittedAt`.

**Time semantics / population / exclusions.** UNDEFINED — depend on the undecided decision
point (manager gate vs terminal). Documented as such rather than guessed.

**Dimensions (available when defined).** `status`, `managerDecision`, `decidedAt`.
**Unit.** `PERCENT` (planned).
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization (future).** Would read under `financial.check.read` + `financial`
entitlement; no new permission planned.

**Data quality: BLOCKED.** `APPROVAL_DECISION_POINT_NOT_ESTABLISHED`: manager-gate,
executive-gate and terminal readings each have structure but answer different business
questions; choosing one just because it looks symmetrical with the BOM approval rate is
explicitly forbidden by the governance brief — the choice needs product evidence.

**Open questions.**

1. Which decision point does the business mean by "approval": manager gate, executive gate,
   or terminal outcome?
2. Should `REQUEST_CORRECTION` count as a decision outcome in the denominator, given it
   returns the request for revision rather than refusing it?

**Evidence.** `check-request-status.ts` (ten ordinals; terminal `{8, 50}`; three distinct
decision gates — manager, document, executive).

## KPI-007 — HR Manual Attendance Ratio

- Technical key: `hr-manual-attendance-ratio`
- Status: `DRAFT`
- Persian name: **نرخ ثبت‌های دستی در تردد پرسنل**
- Owner context: `hr` — **HR** owns the `Attendance` register; `MANUAL` rows are written
  through the correction act guarded by the `hr.attendance.manage` remit.
- Business question: How much of the attendance register is manual correction rather than
  device record?

**Definition (candidate).** Ratio of register rows with `source=MANUAL` to register rows
with any source in the window. Register **rows**, not days or employees: a corrected
employee-day can carry BOTH a `DEVICE` row and a `MANUAL` row (`source` is part of the row
key; the `DEVICE` row is never touched by a correction), so a day-level reading would need
different logic.

**Candidate formulas (prose, not executable):**

- Row-share: `100 × count(source=MANUAL) / count(source ∈ {DEVICE, MANUAL})` — directly
  answered by the traffic summary `bySource` counts.
- Day-share: `100 × employee-days having ≥1 MANUAL row / employee-days` — needs per-row
  reads, not available from the summary; semantics undecided.

**Authoritative source.** `Attendance` register in `hr_db` via
`HrPersonnelTrafficReportingReader`; row fields: `workDate`, `dateKey`, `clockIn`,
`clockOut`, `source`.

**Time semantics / population / exclusions.** UNDEFINED as governed share — the row-share
vs day-share choice is open. Period bucketing would follow the register's `workDate`
(Gregorian day / `dateKey` Jalali day) once defined.

**Dimensions (available when defined).** `workDate`, `dateKey`, `source`.
**Unit.** `PERCENT` (planned).
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization (future).** Would read under `hr.attendance.read` + `hr` entitlement.

**Data quality: YELLOW.**

- This is an attendance **data-source/process** KPI (how the register is recorded). It must
  **NOT** be represented as employee attendance, reliability, performance, or compliance —
  the Attendance source explicitly lacks attendance-status, absence, duration and rate
  semantics (the seam carries no status and no percentage by contract).
- A `MANUAL` row rides alongside the stored day; `DEVICE` and `MANUAL` rows for the same
  day coexist by key design, so any day-share reading differs from the row-share sketch.

**Open questions.**

1. Row-share vs day-share denominator: share of manual ROWS (seam-ready) or share of
   manually-corrected DAYS (needs per-row logic)?
2. Is a manual-correction mix even wanted as a governed KPI, or is it only diagnostic?

**Evidence.** `hr-attendance-source.ts` (closed two-member set `DEVICE|MANUAL`; register has
no attendance status/absence/duration semantics) · `attendance.service.ts` (clock-in writes
`DEVICE`; adjust writes the `MANUAL` row and never touches `DEVICE`) ·
`hr-personnel-traffic-reporting.contract.ts` (row carries `source`, `workDate`, `dateKey`;
summary strip counts per source exactly).

## KPI-008 — Production Pending Approval Aging

- Technical key: `production-pending-approval-aging`
- Status: `EVIDENCE_REVIEW`
- Persian name: **سن ماندگاری فهرست مواد در انتظار تایید**
- Owner context: `production` — **Production** owns the BOM lifecycle; decision authority is
  the snapshotted approver holding `production.bom.approve`.
- Business question: How long have the currently undecided BOMs been waiting for a decision?

**Definition (candidate, evidence-reviewed).** Population: BOM headers of the current
tenant with status `SUBMITTED` and `submittedAt` non-null. Per row:
`elapsed(EVALUATION_INSTANT − submittedAt)` in seconds. **Not** measured from `createdAt`:
a `SUBMITTED` row's routing began exactly when `submit` stamped `submittedAt` — the §15 rule
against `now − createdAt` is satisfied by evidence, not convenience.

**Candidate formulas (prose, not executable):**

- Snapshot mean age: `mean over pending rows of elapsed(asOf − submittedAt)`.
- Oldest-wait-first: `max over pending rows of elapsed(asOf − submittedAt)` — which single
  number (or banded distribution) the business wants is undecided.

**Authoritative source.** `BomHeader` via `ProductionReportingReader`; row fields:
`status`, `submittedAt`, `projectRef`, `productTreeRef`.

**Time semantics.** Cohort field: `EVALUATION_INSTANT` — no period window; aging is
meaningful only as-of an evaluation instant (UTC), to be fixed by the future runtime
contract. Wall clock at evaluation: Asia/Tehran.

**Population / exclusions.** Excluded: `DRAFT` including `NEEDS_CORRECTION` returns
(awaiting the **requester**, not the approver); terminal rows (decided); null `submittedAt`;
other tenants.

**Dimensions.** `projectRef`, `productTreeRef`, `submittedAt`.
**Unit.** Semantic: `SECONDS`. Presentation: days — display conversion only.
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization (future).** Would read under `production.bom.read` + `production` entitlement.

**Data quality: GREEN.** `submittedAt` is stamped atomically with the `SUBMITTED` move, so
every pending row carries the pending-start instant by construction.

**Open questions.**

1. Which single number (or distribution) defines "aging": mean age, oldest age, or age bands?
2. How is the as-of evaluation instant fixed and rendered (the future runtime contract)?

**Evidence.** `bom.repository.ts` ("submittedAt is stamped here because this is the instant
the routing fact began") · `bom-status.ts` (`SUBMITTED` is the only routed-but-undecided
state; correction returns to `DRAFT` — requester-owned, not approval-pending).

## KPI-009 — Commerce Pending Purchase Aging

- Technical key: `commerce-pending-purchase-aging`
- Status: `BLOCKED`
- Persian name: **سن ماندگاری درخواست خرید در انتظار تکمیل**
- Owner context: `commerce` — **Commerce** owns the `PurchaseDocument` lifecycle.
- Business question: How long have the currently open purchase requests been waiting?

**Definition (blocked — no authoritative definition exists).** `PurchaseDocument` persists
no submission or state-entry instant for its open states: `markDocumentSubmitted` writes
only `status` (no timestamp), so "when did this purchase become pending" has no
document-level column.

**Candidate formula (prose, not executable).** `age = asOf − <authoritative open-state
entry instant>` for the pending population — both the instant and the population are
undefined today (see blocked reason).

**Authoritative source (structural facts only).** `PurchaseDocument` via
`CommercePurchaseReportingReader`; available date columns: `createdAt`, `completedAt`
(plus `updatedAt`, which is rewritten by every touch).

**Time semantics / population / exclusions.** UNDEFINED — no authoritative open-state entry
instant exists on the aggregate.

**Dimensions.** None claimable until unblocked.
**Unit.** `SECONDS` (planned; not computable until unblocked).
**Target / Thresholds.** `NOT_DEFINED` / `NOT_DEFINED` (no SLA evidence).
**Refresh.** `NOT_APPLICABLE_DEFINITION_ONLY`.
**Authorization (future).** Would read under `commerce.read` + `commerce` entitlement.

**Data quality: BLOCKED.**

- `START_EVENT_NOT_AUTHORITATIVE`: `createdAt` is document creation (pre-routing),
  `updatedAt` is rewritten by every touch — neither is an open-state entry instant (§15
  forbids defaulting to `now − createdAt`).
- `WorkflowInstance.createdAt` exists only for documents that entered a workflow and is a
  different aggregate not exposed on the Commerce reporting seam — cross-aggregate
  derivation would bypass the seam contract.

**Blocked reason.** `START_EVENT_AND_POPULATION_NOT_ESTABLISHED`: PurchaseDocument stores
no submission or state-entry timestamp (only the completion act stamps an instant), and the
pending population is undefined — decision-pending vs completion-pending are different
clocks. Deriving the start from `updatedAt` or from the workflow aggregate is forbidden by
the governance rules.

**Open questions.**

1. Which statuses constitute "pending purchase" (`SUBMITTED`? `APPROVED`-awaiting-`CLOSED`?
   `DRAFT`?)
2. Which event starts the pending clock — and on which aggregate does it live?

**Evidence.** `purchase.repository.ts` (`writeSubmitted` persists only status — no instant;
`completedAt` is the only stamped lifecycle instant) ·
`commerce-purchase-reporting.contract.ts` (row projects only the document columns above;
workflow internals are out of contract).

## Historical & comparison semantics (governed by the runtime phases)

Addendum of KPI-HISTORICAL-INTELLIGENCE — these statements apply uniformly to the five
`APPROVED` KPIs and are enforced executable in `apps/api/src/modules/kpi-runtime/`
(`kpi-runtime.period.ts`, `kpi-runtime.comparison.ts`, `kpi-runtime.history.ts`):

- **Measurement period**: the Jalali month named by the definition's own
  `timeSemantics.cohortField`, half-open `[start, end)`, resolved in `Asia/Tehran` —
  unchanged by history or comparison.
- **Comparison period**: the immediately preceding governed Jalali month, resolved by the
  SERVER's clock — never a browser date. `Aban 1405 vs Mehr 1405` is the shape; a
  "previous calendar month" is never assumed where the KPI's time semantics differ.
- **Same formula both sides**: comparison and trend values are computed by the identical
  structural formula on the identical population for each month; no stored value, no
  rounded display figure, and no second calculation path exists.
- **Missing periods**: an unavailable month is carried as `NOT_AVAILABLE` with its reason
  (`EMPTY_COHORT` / `EMPTY_DENOMINATOR` / `NO_VALID_ROWS` / capped read) and value `null` —
  never zero, never omitted from the series, never interpolated into a trend.
- **Zero denominators**: a previous value of exactly zero makes the RELATIVE change
  `NOT_AVAILABLE`; the absolute change still stands. Percentage KPIs compare in
  **percentage points** as the primary reading (70% → 80% is +10 points); the relative
  ratio is secondary and never substituted for it.
- **Completed vs partial**: a month whose end instant has not passed is marked incomplete
  and must be labelled as such wherever it is compared or charted.
- **Bound**: history is capped at 12 months per request (`HISTORY_RANGE_EXCEEDS_LIMIT`
  beyond it); no snapshot table, scheduler, or KPI persistence exists — every historical
  figure is computed on demand from the authoritative seams.

## Future KPI runtime contract

Documented direction only — **not implemented**, not started, and not implied by anything
in this phase (§33):

```text
Authoritative source (domain aggregate)
        ↓
Domain-owned reporting/source seam (read contract, tenant-scoped)
        ↓
Reporting (filter-consistent reads)
        ↓
KPI governance definition (this catalog + typed registry)
        ↓
KPI runtime (translates structural formulas into computation)
        ↓
API  →  Management UI  →  Charts / Export
```

Rules a future runtime must honor, fixed here so it cannot silently renegotiate them:

- consumes only **explicit source contracts** — never direct domain persistence;
- computes deterministically from the structural formulas in the typed registry;
- is tenant-scoped to the current authenticated tenant;
- carries the authorization of the source report remit (no new KPI permission unless a
  future phase adds one deliberately);
- must define refresh cadence explicitly (this phase defines none);
- must extend the reporting seams with date-window filters before period-scoped values can
  be served (all four seams currently expose `status`/`search` only — except HR, which has
  day bounds);
- may not invent targets/thresholds: they must arrive as governed `DEFINED` entries with
  evidence;
- must re-validate the registry (`validateKpiRegistry`) on every change.

## First runtime candidates

Eligible for a future runtime phase **because they are approved** (§34):

1. KPI-001 Production BOM Decision Cycle Time
2. KPI-002 Production BOM Approval Rate
3. KPI-003 Commerce Purchase Cycle Time
4. KPI-004 Commerce Purchase Completion Rate
5. KPI-005 Financial Check Request Decision Time

Not eligible, with reasons: KPI-006 (decision point undecided), KPI-007 (row-vs-day
semantics open), KPI-008 (aggregation/as-of semantics pending), KPI-009 (blocked — start
event and population not established).

## Explicitly deferred work

Per the phase scope, none of the following exists and none was built:

- KPI dashboard, KPI API runtime, generic KPI calculation engine, generic KPI DSL;
- target/threshold management UI, scheduled KPI computation, KPI alerts, AI insights,
  executive dashboard;
- KPI database tables, KPI caches, KPI aggregation services;
- cross-domain/enterprise KPIs (overall ERP efficiency, total company performance) —
  every first-cohort KPI is owned by exactly one bounded context;
- web UI for this phase: the catalog is documentation-first; no management dashboard and
  no live KPI values exist anywhere.

## Governance guards (executable)

| Guard                               | File                             | Proves                                             |
| ----------------------------------- | -------------------------------- | -------------------------------------------------- |
| Definition/formula/status integrity | `src/kpi/kpi-catalog.spec.ts`    | 9 entries, unique IDs/keys, §22 gates, fixtures    |
| No runtime leakage + doc sync       | `src/kpi/kpi-governance.spec.ts` | type-only seam imports, no surface, doc ↔ registry |

Run with the API workspace Jest suite (`npm test --workspace=apps/api`).
