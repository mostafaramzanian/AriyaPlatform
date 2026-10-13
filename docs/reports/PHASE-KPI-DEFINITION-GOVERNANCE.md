# Phase Report — KPI Definition & Governance: First KPI Cohort

> **Scope:** definitions, ownership, formulas, source contracts — executable and
> evidence-backed. **No KPI runtime, no dashboard, no engine, no DSL, no scheduler, no
> alerts** — by design (§26, §31, §34 of the phase brief).
>
> Baseline: `HEAD = 30794bc` (`docs(reporting): record visualization and export foundation
commit hash`), working tree clean — verified with `git rev-parse HEAD` + `git status --short`
> before any edit (§36).

## 1. What this phase is

The first **KPI Definition & Governance layer** for the ERP. A KPI in this repository is a
governed, reviewable **definition** — not a number:

```text
Business Question → KPI Definition → Business Owner → Authoritative Source → Formula
  → Time Semantics → Scope → Dimensions → Unit → Target/Threshold → Authorization
  → Refresh Semantics → Data Quality → Approval State
```

The phase establishes that chain for nine KPIs (the five-KPI first cohort plus four
documented future candidates), proves every claim against real domain evidence, and makes
the whole thing falsifiable from the file system with executable guards.

### Artifacts

| Artifact                                          | Role                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api/src/kpi/kpi-definition.model.ts`        | Typed model + §22 quality gates (`kpiApprovalIssues`, `validateKpiRegistry`) |
| `apps/api/src/kpi/kpi-catalog.ts`                 | The nine frozen definitions (typed registry)                                 |
| `apps/api/src/kpi/kpi-catalog.spec.ts`            | Definition / formula / status integrity tests (§29)                          |
| `apps/api/src/kpi/kpi-governance.spec.ts`         | No-runtime-leakage + documentation guards (§29, §30)                         |
| `docs/architecture/KPI-CATALOG.md`                | **Primary governance record** (one section per KPI + readiness matrix)       |
| `docs/reports/PHASE-KPI-DEFINITION-GOVERNANCE.md` | This phase record                                                            |

## 2. A. Preflight — evidence inspected (§3)

| Domain     | Key facts established                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production | 4 statuses; APPROVED/REJECTED terminal; `submittedAt`/`decidedAt` single-writer, atomic with status moves; correction → DRAFT; remits `production.bom.read/manage/approve`; seam row carries both instants + zero-filled byStatus summary                         |
| Commerce   | 6 statuses; `markDocumentSubmitted` writes **only status** (no instant); `completedAt` sole writer `writeCompletedIn` (conditional, policy-gated, fail-closed); every non-CLOSED status is a legal completion source; no `submittedAt` column                     |
| Financial  | Ordinals 0..8 + 50, terminal `{8,50}`; `submittedAt` stamped at MANAGER_REVIEW entry; `decide` stamps `decidedAt` + `managerDecision`; neither cleared on resubmit → stale-pair risk handled by ordering rule                                                     |
| HR         | Closed `DEVICE\|MANUAL`; DEVICE row never touched by corrections (source in row key); **no** status/absence/duration/rate semantics in the source or the seam                                                                                                     |
| Reporting  | Four read-only tenant-scoped seams; no date-window filter (except HR day bounds); remits `production.bom.read`, `commerce.read`, `financial.check.read`, `hr.attendance.read`; **the isolation suite forbids the token `kpi` in `src/modules/reporting/**` code** |

**Consequence of the last row:** the registry lives in a dedicated, dependency-free
`apps/api/src/kpi/` folder — _outside_ the Reporting bounded context — so the existing
report-platform-vocabulary guard stays untouched and still does its job. KPI governance
sits _above_ Reporting (§27) and reaches the four seam contracts by `import type` only.

## 3. Decisions (evidence-driven, no guessing)

1. **Formulas are structural**, closed unions (`MEAN_ELAPSED`, `RATIO_PERCENT`) over
   source fields and closed status vocabularies — no expression strings, no SQL, no eval
   (§23). Status lists are checked with `satisfies readonly BomStatus[]` etc., so a typo
   is a compile error.
2. **Statistic = MEAN** for durations: the simplest deterministic single-value statistic;
   median/percentiles explicitly deferred as a product decision (§7) — recorded as a known
   limitation, never smuggled in.
3. **Cohort fields:** duration cohorts close on the _ending_ event (`decidedAt`,
   `completedAt`) — only decided/completed windows are ever complete; KPI-004 cohorts on
   `createdAt` (creation cohort; right-censoring documented).
4. **Zero denominators → `NOT_AVAILABLE`, never 0%** — reporting 0% for "no decisions
   existed" would be a fabricated measurement.
5. **Invalid rows are excluded, never zero-filled:** null instants and `to < from` pairs
   drop out of the population and are documented (§7).
6. **Stale-pair rule (Financial):** neither submit nor decide clears the pair, so the
   population is defined by `decidedAt >= submittedAt`, not by `managerDecision` alone —
   deterministic, not guessed.
7. **Targets/thresholds = `NOT_DEFINED` with evidence of absence** for all nine (§17):
   no SLA column exists; the reporting phases explicitly deferred SLA semantics.
8. **Time semantics:** UTC storage, Asia/Tehran wall clock (`APP_TIME_ZONE`), **Jalali
   month** bucketing matching the product's Jalali presentation convention (§18).
9. **Persian names follow repository terminology:** «فهرست مواد (BOM)»، «چرخه عمر
   درخواست‌های خرید»، «درخواست‌های صدور چک»، «گزارش تردد پرسنل».
10. **HR KPI-007 is classified an attendance data-source/process KPI** — explicitly _not_
    employee attendance, reliability, performance, or compliance (the source lacks those
    semantics by contract).

## 4. KPI readiness matrix (evidence-determined — §21, §34)

| KPI                                 | Status                        | DQ      | Why (evidence)                                                                                   |
| ----------------------------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| KPI-001 BOM Decision Cycle Time     | `APPROVED`                    | YELLOW  | Terminal population closed; single-writer instants; final-round-only + no seam date filter noted |
| KPI-002 BOM Approval Rate           | `APPROVED`                    | GREEN   | Denominator closed by verified terminal vocabulary; zero-fill summary exists                     |
| KPI-003 Purchase Cycle Time         | `APPROVED`                    | YELLOW  | createdAt→completedAt same lifecycle; completion ≠ receipt/payment (C1 §29); policy-gated        |
| KPI-004 Purchase Completion Rate    | `APPROVED`                    | YELLOW  | Numerator sole-writer; denominator = all cohort rows (no invented exclusions); censoring noted   |
| KPI-005 Check Request Decision Time | `APPROVED`                    | YELLOW  | submit/decide single writers; stale-pair rule explicit; manager-gate scope only                  |
| KPI-006 Check Request Approval Rate | `DRAFT` (candidate)           | BLOCKED | Three decision points (manager/executive/terminal); no evidence designates "the approval"        |
| KPI-007 Manual Attendance Ratio     | `DRAFT` (candidate)           | YELLOW  | Row-share vs day-share denominator open; data-source classification enforced                     |
| KPI-008 Pending Approval Aging      | `EVIDENCE_REVIEW` (candidate) | GREEN   | Start (`submittedAt`) + population (`SUBMITTED`) proven; aggregation/as-of pending               |
| KPI-009 Pending Purchase Aging      | `BLOCKED`                     | BLOCKED | `START_EVENT_AND_POPULATION_NOT_ESTABLISHED`: no submission/state-entry instant on the aggregate |

**First runtime candidates (approved):** KPI-001, KPI-002, KPI-003, KPI-004, KPI-005.
The five were not auto-approved: each passed `kpiApprovalIssues` (empty issues list), and
the four candidates stayed unapproved exactly where evidence ran out.

## 5. Testing (§29, §30)

- **Definition integrity** (`kpi-catalog.spec.ts`): 9 entries; unique ids/keys;
  `validateKpiRegistry` = `[]`; every APPROVED entry passes every §22 gate; candidates and
  blocked entries carry open questions / blocked reason; every target/threshold
  `NOT_DEFINED`; every scope tenant-scoped; no new permissions.
- **Status integrity:** stripping `businessOwner`, `formula`, or `timeSemantics` from an
  approved entry makes `kpiApprovalIssues` fail it; duplicating an entry fails the registry.
- **Formula fixtures** (test-local helpers, not runtime code): `8/(8+2) → 80%`,
  `3/10 → 30%`, mean(12h,6h) → `32400s`, mean(48h,12h) → `108000s`, invalid/null pairs
  excluded (never zeroed), empty denominators → `null` (NOT_AVAILABLE).
- **No runtime leakage** (`kpi-governance.spec.ts`): non-spec sources import only the
  local model by value and the four seam contracts/vocabularies **by type only**; no
  nest/prisma/repository/service/controller specifier; no decorator, no clock read, no
  eval/SQL; no controller/module/service/DTO file exists in the folder.
- **Documentation guards (§30):** `docs/architecture/KPI-CATALOG.md` exists; its nine
  `## KPI-nnn` headings, technical keys, and statuses are unique and match the typed
  registry exactly; BLOCKED/DRAFT sections contain no runtime-implementation claims
  (no routes, no persistence markers).

## 6. Future KPI runtime contract (§33) — documented, not built

```text
Authoritative source → domain-owned seam → Reporting → KPI governance definition
        → KPI runtime → API → Management UI → Charts / Export
```

A future runtime must: consume only explicit source contracts; compute deterministically
from the structural formulas; stay tenant-scoped; reuse the source report remit; define
refresh explicitly; extend the seams with date-window filters first (all four reporting
seams expose `status`/`search` only today — HR additionally has day bounds); never invent
targets/thresholds; re-validate the registry on every change. Full text:
`docs/architecture/KPI-CATALOG.md`.

## 7. Explicitly deferred (§35)

KPI dashboard/API runtime/engine/DSL; target-threshold UI; scheduled computation; alerts;
AI insights; executive dashboard; KPI tables/caches/aggregation services; cross-domain
KPIs; any web UI (this is a documentation-first phase). The four existing reports were
**not** modified; no chart/export changes were made (§32).

## 8. Verification report (§38)

```text
KPI definition tests:        15/15 PASS  (src/kpi/kpi-catalog.spec.ts)
KPI governance guards:        8/8 PASS   (src/kpi/kpi-governance.spec.ts)
Reporting architecture:      PASS        (reporting-isolation + reporting.module + architecture-boundaries: 47/47)
API typecheck:               PASS        (tsc --noEmit, apps/api/tsconfig.json)
Web typecheck:               NOT RUN     (no web changes in this phase)
Lint:                        PASS        (eslint, apps/api/src/kpi/**/*.ts)
Prettier:                    PASS        (checked + written on all phase files)
Build:                       PASS        (npm run build --workspace=apps/api — nest build + prisma generate)
git diff --check:            PASS
```

Approved KPIs:

- KPI-001 Production BOM Decision Cycle Time
- KPI-002 Production BOM Approval Rate
- KPI-003 Commerce Purchase Cycle Time
- KPI-004 Commerce Purchase Completion Rate
- KPI-005 Financial Check Request Decision Time

Blocked KPIs:

- KPI-009 Commerce Pending Purchase Aging (start event + population not established)

Candidate KPIs (documented, unapproved):

- KPI-006 Financial Check Request Approval Rate (DRAFT — decision point undecided)
- KPI-007 HR Manual Attendance Ratio (DRAFT — row/day denominator undecided)
- KPI-008 Production Pending Approval Aging (EVIDENCE_REVIEW — aggregation/as-of pending)

## 9. Git final state

Real hashes, recorded after the commits (§37 — never fabricated):

```text
Governance commit:    a1180b1  feat(reporting): establish kpi definition governance
Documentation commit: 2f1ceb7  docs(reporting): record kpi definition governance
Working tree clean:   YES (only the phase's own files were touched)
```

## 10. Final principle

**Define trustworthy KPIs before calculating them.** This phase fixed definitions,
ownership, formulas, source contracts, time semantics, units, tenant scope, authorization
and data-quality honesty for nine KPIs — five of them approved for a future runtime phase —
and built nothing that computes a number. The progression stands:

```text
Existing domain evidence → KPI definition → Formula + semantics → Owner + governance
        → Approved KPI cohort → (future) KPI runtime → (future) Management Dashboard
```
