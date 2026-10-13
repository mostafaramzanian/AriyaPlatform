# PHASE — COMMERCE GAP-4 PRODUCT DECISION

> **Phase type:** PRODUCT DECISION / RE-SCOPING / CLOSURE — DOCUMENTS + EVIDENCE ONLY.
> Baseline: `HEAD = 631be4a615f9f11b638af07d2b488b775bb67362` · Branch `master`.
> Commit: `docs(commerce): define GAP-4 product decision`.

## A. Executive Decision

**Classification: B — PARTIALLY SUPERSEDED, remainder D — STILL VALID BUT FUTURE / NON-V1.**

GAP-4 splits into two parts with different fates:

| Part | Historical wording | Verdict |
|---|---|---|
| GAP-4a — dashboard counters | "No GET summary analog … counters from list totals" | [SUPERSEDED for `/admin/management` V1] — V1 answers every approved Commerce question with existing contracts; no new endpoint needed or allowed |
| GAP-4b — richer analytics | "richer analytics need a new endpoint family (product decision first)" | [DEFERRED / FUTURE — NOT REQUIRED for V1] — no approved question, metric, formula, or owner contract exists |

**Implementation allowed now: NO.** GAP-4a is closed-by-supersession; GAP-4b stays
deferred until a concrete question with all Section H fields CONFIRMED reopens it.

**Product conclusion:** the counters half died when Dashboard V1 was approved as
composition-only over existing source-owned reads — purchase `summary` plus
pending-decisions `total` plus KPI-003/004 answer Q1/Q3/Q5 honestly with zero new
backend. The richer half never became a requirement: no spend vocabulary, no
aggregation semantic, no cohort, no owner decision exists, and Dashboard §F/J.3/Y
explicitly rejected it for V1. GAP-4 closes as a V1 requirement and remains only
as a named future door with explicit reopen criteria.
## B. Starting Evidence

Baseline HEAD `631be4a` (Management Dashboard decision), branch `master`, tree clean
except generated `apps/web/next-env.d.ts`. Predecessors: Dashboard decision §§F/J.3/Y
(GAP-4 #33 kept PRODUCT_DECISION); portfolio review #33 (GAP-4 KPI/summary family,
PRODUCT_DECISION, "define metrics or drop permanently"); UI-0 §26-GAP-4 (original
two-sentence record); UI-5 §B (STILL OPEN among 44 Commerce operational routes).

Four Commerce report seams exist (each list WITH summary strip, `commerce.read` +
`commerce`/`purchase` entitlement, tenant-scoped): purchase
(`GET reporting/commerce/purchase-documents` → `{total, byStatus}`, token
`COMMERCE_PURCHASE_REPORTING_READER`); payment
(`GET reporting/commerce/payment-history` → `{total, byMethod}`, count-only by scope
gate); return (`GET reporting/commerce/return-lifecycle` → per-state counts);
receiving (`GET reporting/commerce/receiving` → per-status counts). Operational:
`GET commerce/pending-decisions` (`commerce.read`, `{items,page,pageSize,total}`);
`GET hr/missions/approvals/pending` (`hr.mission.approve`). KPI: KPI-003/004 APPROVED
via purchase seam; KPI-009 BLOCKED (no start instant); `GET /kpis` = union gate
`KPI_READ_REMITS` + per-definition filter (HR-only caller → 403 on KPI list, an
intentional FORBIDDEN not EMPTY).
## C. Historical GAP-4 Definition

UI-0 §26-GAP-4 verbatim: "Reports/aggregates for the Commerce dashboard — No
`GET …/summary` analog exists (HR has `/hr/organization/summary`). Dashboard counters
must come from list totals (§7.2); richer analytics need a new endpoint family
(product decision first)." Context [CONFIRMED]: written when no Commerce seam, no KPI
runtime, no management decision existed; "Commerce dashboard" = Commerce module home
(`CommerceHomeView` tiles from list totals), NOT `/admin/management`. Amendments:
UI-5 §B kept it STILL OPEN (no metric defined); portfolio #33 re-homed it OUT of
Reporting ("KPI/dashboard-shaped, not a register"); Dashboard §F rejected spend as V1
card, §J.3 deferred it, §Y left #33 to its own decision (this document). No amendment
ever supplied a question, actor, formula, dimension, cohort, authorization, or owner.
## D. Current Commerce Capabilities

Summaries answer (server counts, same population as list, zero-filled):
purchase `{total,byStatus}` = Q3/MGT-COM-01; payment `{total,byMethod}` (NO money
totals — "a count summary, not a KPI"); return per-state; receiving per-status.
Operational: pending-decisions `total` = Q5/MGT-QUE-01 (count only, PII rule);
`GET /kpis` Commerce subset (KPI-003/004 + comparisons) = Q1 Commerce part.
Deliberate absences: no operational `GET /commerce/summary` [NOT REQUIRED — HR
summary serves HR module home; Commerce home uses tested list-total tiles]; no
money sums [EXCLUDED — supplierId opaque, single kind, no spend vocabulary];
no aging [BLOCKED under KPI-009, not GAP-4's]; no cross-domain aggregate
[BLOCKED_SOURCE_CONTRACT]; no summary trends [NOT REQUIRED — no cohort semantic].
## E. Current Management Dashboard Relationship

V1 = 6 cards, 3 bands, all on existing contracts, route `/admin/management`,
composition-only, fan-out ≤6 GETs, five states (LOADING/EMPTY/FORBIDDEN/
UNAVAILABLE/ERROR, never converted). Commerce cards: MGT-COM-01 (purchase
`summary` → Q3), MGT-QUE-01 (pending-decisions `total` → Q5), MGT-KPI-01 Commerce
subset (KPI-003/004 → Q1 part). Dashboard intentionally avoided GAP-4 [CONFIRMED]:
§F rejected "revenue/expense" (metrics undefined), §J.3 deferred "Commerce spend /
GAP-4 summary", §Y left #33 to its own decision. No V1 question lacks a contract
(§E.3 answer: NO) — the empty remaining-question set is why GAP-4a is SUPERSEDED.
"Commerce dashboard" (UI-0, module home) ≠ `/admin/management` (management
composition) [EXPLICIT PRODUCT DECISION]: the module home keeps list-total tiles;
the management surface reads the Reporting summary (same numbers as the register,
zero divergence).
## F. KPI Boundary

KPI-003/004 APPROVED via purchase seam (`commerce.read`, monthly cohorts);
KPI-009 BLOCKED (no submission/state-entry instant — unblock = domain-modeled
instant, not a GAP-4 endpoint). Ruling [EXPLICIT PRODUCT DECISION]: NO KPI
semantics under GAP-4 ever — any ratio/rate/cycle/aging/trend/comparison enters
through the KPI catalog lane with full quality gates, never as a GAP-4 endpoint.
A GAP-4 metric would duplicate governed KPIs, bypass `validateKpiRegistry`, and
violate "Dashboard owns formulas? FORBIDDEN" + "reports count rows; KPIs compute
indicators".
## G. Duplication Analysis

| Capability | Available? | Owned elsewhere? | Verdict |
|---|---|---|---|
| Purchase status counts | YES — `summary.byStatus` | Commerce seam | DUPLICATE — forbidden |
| Queue count | YES — `pending-decisions.total` | Commerce operational | DUPLICATE — forbidden |
| KPI-003/004 values | YES — `GET /kpis` | KPI runtime | DUPLICATE — forbidden |
| Aging figure | NO — KPI-009 owns it (BLOCKED) | KPI governance | DUPLICATE + BLOCKED — forbidden |
| Money sums | NO — deliberately unvocabularized | NOBODY | INVENTION — forbidden until Section P met |
| Method/state/line distributions | YES — three sibling summaries | Commerce seams | DUPLICATE — forbidden |
| Cross-domain number | NO — BLOCKED_SOURCE_CONTRACT | NOBODY | FORBIDDEN (P0-C) |
| Summary trend | NO — no cohort semantic | NOBODY | FORBIDDEN (would invent semantics) |
| Generic `GET /commerce/summary` | NO — home uses list totals | module home + 2 seams | DUPLICATE (third counter definition) — not required |

No GAP-4-shaped capability is simultaneously unserved, unowned, and unblocked —
the evidence that GAP-4a is superseded and GAP-4b lacks a question.
## H. Business Question Assessment

For GAP-4b: Business Question UNKNOWN (floated "counters/spend figures" never
stated as one decidable question); Actor UNKNOWN; Permission UNKNOWN (presumed
`commerce.read`, unconfirmed); Tenant Scope CONFIRMED-as-pattern (server-resolved
current tenant — mandatory for any successor); Source Owner UNKNOWN-as-presumed
(Commerce owns documents/payments/receipts/returns; Financial/supplier facts NOT
Commerce-owned); Authoritative Data BLOCKED (no money vocabulary, no aging start,
no supplier domain, single kind); Dimensions/Filters/Time/Aggregations/Output/
Freshness/Authorization-detail/Drill-down UNKNOWN; Lane UNDECIDED (Commerce vs
Reporting vs KPI vs nobody; Dashboard forbidden — composition only). Ruling: with
the question UNKNOWN, Option C (narrow contract) is unwritable without guessing —
GAP-4b stays DEFERRED.
## I. Source-Ownership Assessment

Commerce owns documents/payments/receipts/returns + pending-decisions projection —
every V1-countable Commerce fact is published via a Commerce-owned seam. Financial
owns check-requests only (no ledger → Commerce spend joins BLOCKED_SOURCE_DATA on
both sides). HR summary precedent is owner-local (module home), not a pattern to
copy. KPI runtime is the only lawful home for future Commerce metrics. Reporting
owns rows + count summaries, never cross-DB reads. Dashboard owns layout only.
Rule: future GAP-4b needing foreign truth waits for that context's narrow contract
first — else BLOCKED_SOURCE_CONTRACT, never a join.
## J. Candidate Decision Options

OPTION A (CLOSE AS SUPERSEDED): fits GAP-4a — V1 cards + four summaries +
pending-decisions + KPI-003/004 obsolete the "no summary" premise. Does NOT fit
GAP-4b as whole-label close (never specified → cannot be "satisfied"). OPTION B
(RETAIN AS FUTURE/DEFERRED): fits GAP-4b — conceivable, unapproved, trigger-gated.
OPTION C (NARROW CONTRACT): REJECTED — question UNKNOWN, owner split, seams
cover counts while sums/rates/aging lack vocabulary, §G non-duplication fails.
OPTION D (BLOCKED): not the label — KPI-009 and cross-domain blockers belong to
their own lanes; GAP-4b misses the question itself, so DEFERRED is precise.
## K. Selected Decision

PARTIALLY SUPERSEDED, remainder DEFERRED. (1) GAP-4a SUPERSEDED, closed for V1
permanently — superseded by four report summaries + pending-decisions + KPI-003/004
+ composition architecture; history preserved in §C; a future `GET /commerce/summary`
would triple-define counters and is NOT REQUIRED (must pass §P to be proposed).
(2) GAP-4b DEFERRED, future non-V1, unspecified — §§F/G/H route metrics to KPI,
prove duplication, and record UNKNOWNs; reopens only via §P. (3) Unchanged:
KPI-009 BLOCKED (KPI lane), cross-domain BLOCKED_SOURCE_CONTRACT, Dashboard V1
exact, four reports exact, KPI catalog frozen at nine.
## L. Exact Product Contract, if any

NONE — Option C rejected. Normative shape for any lawful successor (checklist, not
pre-approval): route under the owner's subtree (never dashboard-owned, never
generic `/analytics`); owner = source-aggregate context; one-sentence question +
drill-down; named fields/units/zero-vs-null/buckets imported from source pure
modules; existing remit + entitlement (no new permission without grants); tenant
server-resolved, no wire `tenantId`, 404-for-foreign; narrow read-only seam token
(P0-C); non-goals per §M restated.
## M. Explicit Non-Goals

Binding on any successor: no generic endpoint/builder/aggregation/BI/DSL; no money
totals without a governed vocabulary; no aging outside KPI-009; no KPI-shaped number
outside the catalog; no summary trends without source cohorts; no cross-domain number
without owner + contract; no Redis/warehouse/materialization/scheduler/polling without
evidence (none exists); no new permission without grants; no dashboard business logic
or Prisma-into-Commerce; no relabeling existing surfaces as "GAP-4 delivered".
## N. Cross-Context Constraints

P0-C absolute: Reporting/Dashboard NEVER read Commerce Prisma/privates — only the
four approved reader tokens; KPI Runtime consumes the same tokens (policy §2.2).
Foreign truth needs that context's narrow contract first, else BLOCKED_SOURCE_
CONTRACT. Sibling Prisma imports, cross-DB SQL, duplicated repos, copied models,
generalized joins are never a GAP-4 solution (guards fail by design).
## O. Authorization / Tenant Semantics

Existing, unchanged: reports `commerce.read` + `commerce`/`purchase`, tenant from
server context, 403-no-tenant, 404-for-foreign; pending-decisions same remit,
session-scoped; `GET /kpis` union `@Roles(...KPI_READ_REMITS)` + per-definition
remit + entitlement (unauthorized dropped pre-computation). HR-only note
(intentional, preserved): strictly-HR caller (no KPI remit — `hr.mission.approve`
is NOT in the union) gets 403 on the KPI list; the dashboard KPI card MUST render
FORBIDDEN (distinct copy, no retry, drill-down removed) — never EMPTY, never
page-level failure. Commerce cards are per-card gated likewise. Supersession holds
because each card fails CLOSED per remit, not because every caller sees every card.
Future successors inherit the pattern (existing remit + entitlement, no wire
`tenantId`, no grantless permission).
## P. Reopen Criteria

GAP-4b ONLY (GAP-4a closed) reopens when ALL hold: (1) one-sentence question (who
decides what, drills where); (2) actor + remit (new remit only with grants);
(3) owner + aggregate + column-level source evidence; (4) closed vocabularies from
source pure modules; (5) time semantics (stock/cohort/window, tz, calendar, events);
(6) aggregation semantic + §G non-duplication proof; (7) lane assignment vs §§F/G;
(8) shape + zero-vs-null + freshness + failure; (9) drill-down target; (10) §§M/N
honored. Any miss = stays deferred. Reopening is itself an evidence-first PRODUCT
DECISION; §§L+M are its checklist.
## Q. Implementation Eligibility

Implementation allowed now: NO. GAP-4a NO (SUPERSEDED — would duplicate §G);
GAP-4b NO (DEFERRED — would invent product); aging-via-GAP-4 NO (KPI-009 BLOCKED
lane); cross-domain NO (BLOCKED_SOURCE_CONTRACT); operational `/commerce/summary`
NO (NOT REQUIRED — would triple-define counters). Future phases claiming GAP-4
parentage must cite §P items satisfied.
## R. Evidence vs Decision Matrix

| # | Statement | Label | Ground |
|---|---|---|---|
| 1 | UI-0 §26-GAP-4 two-sentence record | [CONFIRMED] | UI-0:1458-1462 quoted in §C |
| 2 | "Commerce dashboard" = module home, not `/admin/management` | [INFERRED, high confidence] | UI-0 predates Dashboard; §7.2 tile context |
| 3 | Four Commerce summaries exist, source-owned, count-only | [CONFIRMED] | four controllers + four `commerce-*-reporting.contract.ts` |
| 4 | No operational `/commerce/summary`; only HR `@Get('summary')` | [CONFIRMED] | codebase search (HR org controller :70 only) |
| 5 | `GET commerce/pending-decisions` with `total`, `commerce.read` | [CONFIRMED] | pending-decisions.controller.ts:42-46 |
| 6 | KPI-003/004 APPROVED; KPI-009 BLOCKED (no start instant) | [CONFIRMED] | kpi-catalog.ts:245-449, 824-908 |
| 7 | V1 six cards on existing contracts; spend rejected/deferred | [CONFIRMED] | Dashboard §§F/J.3/Y |
| 8 | Dashboard avoided GAP-4 by design | [EXPLICIT PRODUCT DECISION cited] | prior decision, not reopened |
| 9 | GAP-4a needs nothing new for V1 | [EXPLICIT PRODUCT DECISION — this doc] | §§E.3/G/K |
| 10 | GAP-4b has no approved question/vocabulary | [CONFIRMED absence] | #33 + Dashboard §F + catalog states |
| 11 | KPI shapes belong in KPI lane | [EXPLICIT PRODUCT DECISION — this doc] | §F |
| 12 | Cross-domain needs a contract first | [BLOCKED_SOURCE_CONTRACT] | Dashboard §K + P0-C |
| 13 | HR-only KPI card = FORBIDDEN, never EMPTY | [EXPLICIT PRODUCT DECISION preserved] | kpi-runtime.controller + Dashboard §Q (§O) |
| 14 | No implementation allowed | [EXPLICIT PRODUCT DECISION — this doc] | §Q |
## S. Verification

Docs-only: no production code created/modified. Start: HEAD `631be4a`,
`git status --short` = only `?? apps/web/next-env.d.ts`. Every named
route/remit/token/file re-read from CURRENT source (§§B/D/F/O); guards untouched
(no re-run needed beyond Dashboard's green record, cited not re-claimed).
Pre-commit: one new untracked file (this doc) + generated next-env (unstaged);
`git diff --check` must pass; `git diff --stat` shows only this file.
## T. Git Record

```text
Working tree before commit:  one NEW untracked file (this document);
                             one UNTRACKED generated file (apps/web/next-env.d.ts, not staged)
git diff --check:              (run at commit time — required to pass)
Implementation code changed:   NONE
Commit:                        docs(commerce): define GAP-4 product decision
Blind git add:                 FORBIDDEN — stage only docs/reports/PHASE-COMMERCE-GAP-4-PRODUCT-DECISION.md
```
