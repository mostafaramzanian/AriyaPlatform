# PHASE C5 — GAP-6 — COMMERCIAL / QUOTATION CAPABILITY DISCOVERY + CLOSURE
# FINAL CONTRACT RECORD — ARCHITECTURE-FIRST / NO-GUESS / BACKEND-FIRST

**STATUS: DISCOVERY COMPLETE — NO PRODUCTION CODE PRODUCED — QUOTATION BLOCKED BY CONTRACT**

**DATE:** 2026-10-01
**BASELINE (pre-C5 git state):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e` on `master`,
with PRE-EXISTING uncommitted work from C2, C3, C4-R and the UI-1…UI-5 phases (recorded in
§B). C5 changes this document only.

**AUTHORITY.** This document is subordinate to:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (authoritative Commerce specification)
- `docs/PHASE-C1-EXECUTION-PROMPT.md`
- `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md` (approved commercial foundation contract P1–P12)
- `docs/PHASE-C2-WORKFLOW-EXECUTION-HTTP-AND-PENDING-INBOX-CONTRACT.md`
- `docs/PHASE-C3-LINE-ROUTING-CONFIGURATION-HTTP-CONTRACT.md`
- `docs/PHASE-C4R-PURCHASE-COMPLETION-POLICY-CONTRACT.md`
- `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md`, `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md`

Where this contract is silent, those documents decide.

---

## 0. OUTCOME — READ THIS FIRST

```text
COMMERCE BACKEND PARTIALLY COMPLETE — GAP-6
QUOTATION / REQUESTER-CONFIRMATION / CORRECTION: BLOCKED BY CONTRACT
EVERY EXISTING COMMERCIAL CAPABILITY: CONFIRMED CLOSED (NO CHANGE REQUIRED)
SUPPLIER-OFFER / COMPARISON / SELECTION / AWARD: NOT IN DOMAIN
```

C5 implemented **zero** production routes, models, migrations or frontend changes, because
discovery proved there is **no confirmed-but-unimplemented GAP-6 capability**:

- every capability that authoritative source actually DEFINES is already implemented,
  served over HTTP, covered by tests and UI — [CONFIRMED]
- every capability that is missing is missing because its **contract/semantics do not
  exist** — not because an implementation step was skipped — [CONFIRMED]

Per §7 of the C5 prompt (no invented quotation lifecycle) and §36 (blocked-by-contract is a
valid outcome), no quotation domain was created.

---

## A. DISCOVERY — WHAT WAS INSPECTED

All of the following were read/searched before any decision — [CONFIRMED]:

| # | Artifact | Result |
|---|---|---|
| A1 | `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` | quotation appears exactly 3×: §5.15 (cash/non-cash EXAMPLE), §8 (API foundation list), §27 (process diagram) |
| A2 | `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md` | §9 closes API at 15 routes; §11-3 defers quotation/confirmation; §11-2 defers correction/re-activation |
| A3 | `docs/PHASE-C1-EXECUTION-PROMPT.md`, `PHASE-C1-START-PROMPT.md` | zero quotation mentions |
| A4 | Commerce Prisma schema (`apps/api/prisma/commerce/schema.prisma`, 2133 lines) | no quotation/confirmation/correction/supplier model |
| A5 | `commercial/` source (controller, dto, lifecycle service, configuration service, repositories, status, constants, projection, rule, liaison) | no quotation code path anywhere |
| A6 | Global search: `quotation`, `quote`, `RFQ`, `vendor`, `supplier`, `استعلام`, `مناقصه`, `پیشنهاد قیمت`, `bid`, `tender`, `award`, `selected supplier`, `supplier comparison` | quotation only in comments/docs/permission seeds; استعلام only in an unrelated `lovable/` mock page; no supplier entity at all |
| A7 | `commerce.commercial.manage` permission | catalogued + seeded, referenced by ZERO routes [CONFIRMED] |
| A8 | E2E tests (`commerce-lifecycle`, `commerce-integration`, `commerce-tenant`) | commercial surfaces covered; no quotation test exists |
| A9 | Frontend (`CommerceCommercialSettings.tsx`, UI-0/UI-5 contracts) | quotation surfaces deliberately absent (UI-0 §4.4, GAP-6) |
| A10 | Migration history (`prisma/commerce/migrations/`) | no quotation table ever existed |
| A11 | Architecture/isolation/policy specs | route inventory pinned; C5 adds no route, so no guard edit needed |
| A12 | Workflow / line-routing / purchase / completion relationships | commercial hooks are `onPurchaseSubmitted` + `onWorkflowSettled` only |

---

## B. GIT BASELINE

- HEAD: `c0fab92c8f5394253353478348feef1edfd4888e` (branch `master`) — [CONFIRMED]
- Pre-existing uncommitted work (NOT touched by C5): modified `commerce/schema.prisma`,
  `commerce.constants.ts`, `commerce.module.ts`, `commercial-lifecycle.repository.ts`,
  purchase/workflow files, e2e specs, `nav-catalogue.ts`, `CoreSettingsCenter.tsx`; untracked
  `completion/`, `pending/`, workflow controllers/DTOs, C2/C3/C4-R docs, UI docs, UI shots,
  `backups/`, `secrets/` — [CONFIRMED]
- C5 working-tree delta: **this document only** — [CONFIRMED]
- No commit made (no instruction to commit) — [CONFIRMED]

---

## C. COMMERCIAL CAPABILITY INVENTORY (§4 of the C5 prompt)

| Capability | Exists in source? | Contracted? | HTTP? | UI? | Tests? | Status |
|---|---|---|---|---|---|---|
| Commercial Groups | YES (model+service) | YES (P §9, P2) | YES — 4 routes | YES (UI-1) | YES | **CLOSED** |
| Commercial Configuration | YES (versioned policy) | YES (P §9, §7) | YES — 7 routes | YES | YES | **CLOSED** |
| Line Assignment (+reassign, history) | YES (current row + append-only history) | YES (P3/P5/P7, §9) | YES — GET+POST | YES (UI-2) | YES | **CLOSED** |
| Commercial Approval (PENDING→APPROVED/REJECTED) | YES | YES (§3-G, §9) | YES — GET+decision | YES (UI-3) | YES | **CLOSED** |
| Pending-Decision Inbox (C2 GAP-1b) | YES | YES (C2) | YES — GET pending-decisions | YES | YES | **CLOSED** |
| Quotation entry / update | NO — no model, service, DTO, route, test | NAME-ONLY (C1 §8); P §11-3 explicitly DEFERRED | NO | NO (UI-0 forbidden) | NO | **CONTRACT BLOCKED** |
| Requester confirmation | NO | NAME-ONLY (C1 §8/§27); P §11-3 DEFERRED | NO | NO | NO | **CONTRACT BLOCKED** |
| Correction / commercial re-activation | NO | P §11-2: re-activation model undefined | NO | NO | NO | **CONTRACT BLOCKED** |
| Quotation request (RFQ) | NO | never named in any contract | NO | NO | NO | **NOT IN DOMAIN** |
| Supplier offer | NO — no supplier entity; `PurchaseDocument.supplierId` is opaque TEXT | never contracted | NO | NO | NO | **NOT IN DOMAIN** |
| Quotation comparison | NO | never contracted | NO | NO | NO | **NOT IN DOMAIN** |
| Supplier selection / award | NO | never contracted | NO | NO | NO | **NOT IN DOMAIN** |
| Manual unassignment (HTTP) | NO (only automatic `UNASSIGNED` outcome exists) | NOT contracted (P §9 has no unassign route) | NO | NO | NO | **NOT IN DOMAIN** |
| Group deletion/archive | NO | P §11-7: "No API and no contract semantics" | NO | NO | NO | **CONTRACT BLOCKED** |

**Gap-type classification (§5 of the C5 prompt):** every row above is type **D**
(contract missing) or type **E** (not part of Commerce) — there is **no type-A**
(domain+service exists, HTTP missing) row. — [CONFIRMED]

---

## D. GAP-TYPE ANALYSIS — WHY NOTHING WAS IMPLEMENTED

- **Type A (HTTP missing): NONE.** Every public method of `CommercialConfigurationService`
  (list/get/create/update groups; list/get/create/update/validate/publish/archive
  configurations) and `CommercialLifecycleService` (assign, decide, listAssignments,
  listApprovals; hooks `onPurchaseSubmitted`, `onWorkflowSettled`) is either a route or an
  internal event hook called by purchase/workflow execution. — [CONFIRMED]
- **Type B/C (partial domain): NONE.** No half-built quotation/confirmation/correction code
  exists. — [CONFIRMED]
- **Type D (contract missing): quotation family.** C1 §8 names "quotation entry,
  quotation update, requester confirmation, correction" as API foundations to establish, but
  supplies **zero semantics** (no entity, no fields, no states, no attachment point, no
  actor, no lifecycle); the implementing contract (P §11 items 2–3) formally deferred them.
  Implementing here would require inventing the domain — forbidden by C5 §7. — [CONFIRMED]
- **Type E (not in domain): supplier-offer/comparison/selection/award.** No supplier model
  exists anywhere; `supplierId` is documented as an opaque free-text identifier with no
  directory (schema header; UI-0 risk R5). — [CONFIRMED]

---

## E. QUOTATION SEMANTICS — DECISION GATE (§35 of the C5 prompt)

| Question | Source evidence | Result |
|---|---|---|
| Is quotation a defined Commerce capability? | C1 §8 lists it as a foundation; P §11-3 defers it; UI-0/UI-5 record GAP-6 "STILL OPEN (by design)" | **NAME CONFIRMED / SEMANTICS UNKNOWN** |
| What is a quotation? | Only "Quotation / price evidence" (C1 §27 diagram) | UNKNOWN |
| Who creates it / who responds? | no source | UNKNOWN |
| Entity ownership? | no model; candidate parents (PurchaseDocument/PurchaseLine/CommercialGroup) all unnamed | UNKNOWN |
| Lifecycle / states? | no enum, no state list, anywhere | UNKNOWN — **not invented** |
| Supplier relationship? | no supplier entity | UNKNOWN |
| Comparison / selection semantics? | no source | NOT IN DOMAIN |
| Permission? | `commerce.commercial.manage` = "Record assignments, quotations, confirmations and corrections" — already seeded | CONFIRMED (no new permission needed later) |
| Actor / tenant? | `resolveCommerceActor(req)` + tenant-first repository (existing infrastructure) | CONFIRMED (infrastructure only) |
| Historical pinning? | configuration pinning exists (P §3-B); quotation-specific pinning undefined | UNKNOWN |
| Required HTTP surface? | P §9: "no endpoints for quotation…"; deferred to its own step | DECISION REQUIRED |

**Gate verdict:** the minimum semantics needed for implementation remain UNKNOWN →
**DO NOT IMPLEMENT QUOTATION** (C5 §35). — [CONFIRMED]

---

## F. QUOTATION LIFECYCLE — NONE DECLARED

There is no quotation lifecycle in Aria source. The states
`DRAFT/REQUESTED/RECEIVED/EVALUATED/SELECTED/REJECTED/EXPIRED` were **NOT created** —
classic ERP folklore, explicitly forbidden by C5 §7/§23. The only lifecycle vocabulary that
exists is `PurchaseDocumentStatus` (DRAFT…CLOSED, §5.11), which is the commercial DOCUMENT
lifecycle and is not a quotation. — [CONFIRMED]

---

## G. COMMERCIAL GROUP SEMANTICS — UNCHANGED [CONFIRMED]

- Owner: tenant-local Commerce (`CommercialGroup`, `tenantId`-first `@@unique([tenantId, code])`).
- Not a Core role, not an HR unit (P2). Purpose: group commercial responsibility and
  determine liaison ownership.
- Mutation: create + update (rename/liaison swap) via `commerce.configure`; liaison change
  audited as `liaison_changed`. No delete (relations RESTRICT); no archive API (not
  contracted). Group changes do not rewrite running purchases' pinned configuration (§3-B).
- Quotation relationship: **none defined**.

## H. ASSIGNMENT SEMANTICS — UNCHANGED [CONFIRMED]

- LINE-scoped only (P3, §3-J): `POST /commerce/commercial-assignments` with
  `{lineId, groupId, reason?}`, permission `commerce.manage`.
- `GET /commerce/commercial-assignments?documentId=` returns current rows + append-only
  history. Manual repeat call = reassignment writing history (`COMMERCIAL_INVALID_REASSIGNMENT`
  for same group+user; `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE` in terminal documents).
- List/read/history/reassignment: **already exist**. Unassignment/batch/document-level:
  **not contracted** → not implemented.

## I. APPROVAL SEMANTICS — UNCHANGED [CONFIRMED]

- Line-scoped `CommercialApproval`, `@@unique([tenantId, purchaseLineId])`; activation by
  pinned event; approver stored at activation; `POST /commerce/commercial-approvals/:id/decision`
  `{decision, comment?}`, permission `commerce.approve`, transition `PENDING → APPROVED|REJECTED`,
  actor equality with stored `approverUserId`, repeated decision → 409
  (`COMMERCIAL_APPROVAL_NOT_PENDING`).
- REJECTED is terminal; re-activation deferred by P §11-2. No quotation linkage exists.
- C5 did NOT touch, refactor or duplicate any of this. — [CONFIRMED]

## J. SUPPLIER SELECTION SEMANTICS — NONE [CONFIRMED]

No supplier-selection entity, selected-supplier field, award decision or commercial-winner
concept exists in schema or contracts. Nothing was invented (C5 §11).

---

## K. API CONTRACTS — NO NEW ENDPOINTS

C5 adds **zero** routes. The commercial surface remains exactly the fifteen routes of P §9
(groups ×4: GET list/GET one/POST/PATCH; configurations ×7: GET list/GET one/POST/PATCH/
validate/publish/archive; assignments ×2: GET+POST; approvals ×2: GET+POST decision) plus
the C2 `GET commerce/pending-decisions`. — [CONFIRMED]

## L. PERMISSIONS — NO CHANGES [CONFIRMED]

- Existing four in use: `commerce.read`, `commerce.configure`, `commerce.manage`,
  `commerce.approve` (P §3-I).
- `commerce.commercial.manage` stays catalogued+seeded and unused — it is the pre-agreed
  remit for a FUTURE quotation step ("Record assignments, quotations, confirmations and
  corrections"), so no new permission name is created now and Core/RBAC (owner of RBAC) is
  untouched. — [CONFIRMED]

## M. ACTOR MODEL — UNCHANGED [CONFIRMED]

Every commercial route resolves `resolveCommerceActor(req)` once; no client-supplied
identity/tenant fields exist in any DTO (global pipe whitelist → 400); no second resolver
created; no impersonation surface added.

## N. TENANT ISOLATION — UNCHANGED, VERIFIED [CONFIRMED]

Existing tenant-first repository methods (`tenantId` first argument, tenant-scoped
predicates, NotFound posture for foreign rows) and e2e isolation tests
(`commerce-tenant.e2e-spec.ts`: foreign group read 404, foreign PATCH refused, tenant A
cannot see B's groups/configurations) re-ran green in C5 (§V).

## O. DATABASE / MIGRATIONS — NONE [CONFIRMED]

No schema addition is justified: nothing to store without contract. No migration created,
no `db push`, historical migrations untouched; `prisma validate` on
`prisma/commerce/schema.prisma` passes ("The schema … is valid"). — [CONFIRMED]

## P. VERSIONING — NOT APPLICABLE [CONFIRMED]

Commercial configuration versioning (single-published, pin-on-first-use, P §3-B) already
exists and is unchanged. Quotation versioning cannot be decided until quotation exists —
UNKNOWN, and deliberately not pre-versioned (C5 §20).

## Q. HISTORICAL BEHAVIOR — PRESERVED [CONFIRMED]

Assignment history is append-only; approval decisions record decision user, timestamp and
comment; configuration pinning preserved; no historical row modified by C5 (no code
changed). No new audit/history table created (C5 §21).

## R. CONCURRENCY — UNCHANGED [CONFIRMED]

Existing conflict answers remain the only ones: `COMMERCIAL_INVALID_REASSIGNMENT`,
`COMMERCIAL_APPROVAL_NOT_PENDING` (409), conditional `null → id` configuration pin write,
single projection writer in one unit of work. No new race exists without a new capability.

## S. AUDIT INTERACTION — UNCHANGED [CONFIRMED]

`CommerceAuditGateway` remains the single audit path; commercial actions audit inside their
unit of work; no audit/read-timeline surface added (GAP-7 untouched); no quotation audit
action invented.

## T. SETTINGS COMPATIBILITY — UNCHANGED [CONFIRMED]

Settings → تدارکات و فرآیند خرید → بازرگانی continues to serve the six commercial
configuration lifecycle routes through existing Settings APIs; no new settings application;
no Settings Center redesign; no configuration field added.

## U. FRONTEND COMPATIBILITY — NO CHANGES [CONFIRMED]

C5 touched no file under `apps/web/`. UI-0's rule ("No UI may be designed for quotation
entry — §4.4") remains in force until the contract exists. The existing Commercial tab,
assignments, approval-decision and configuration surfaces are untouched, so no frontend test
run was required (C5 §25 default: NO FRONTEND CHANGES).

---

## V. TESTS AND VALIDATION (§39) — ALL GREEN

| Gate | Command | Result |
|---|---|---|
| Commerce unit | `npm run test --workspace=apps/api -- modules/commerce --runInBand` | **40 suites / 640 tests PASS** |
| Architecture | `npm run test:architecture --workspace=apps/api` | **1 suite / 24 tests PASS** |
| Runtime policy | `npm run test:policy --workspace=apps/api` | **1 suite / 32 tests PASS** |
| Commerce e2e (real HTTP: lifecycle + integration + tenant) | `npm run test:e2e --workspace=apps/api -- commerce` | **3 suites / 66 tests PASS** |
| TypeScript | `npx tsc --noEmit -p apps/api/tsconfig.json` | **exit 0, no errors** |
| Prisma validate (commerce) | `npx prisma validate --schema prisma/commerce/schema.prisma` | **valid** |
| Full API unit suite | `npm run test --workspace=apps/api -- --runInBand` | see §V.1 |
| Migrations | not applicable (no migration) | n/a |
| Frontend | not applicable (no frontend change) | n/a |

### V.1 Full API suite

**Full API unit suite:** `npm run test --workspace=apps/api -- --runInBand` →
**200 suites / 3284 tests PASS, 0 failed** (includes architecture + policy + all module
suites; run on the C5 tree with pre-existing uncommitted C2/C3/C4-R/UI work intact).

Failures classified: **baseline 0 / C5 regression 0 / C5 implementation 0 / environment 0**
(C5 produced no implementation, so a failure could only be baseline or environment).

Coverage of the C5 §29 e2e matrix: C5-A (discovery regression — all commercial surfaces
green) ✓ · C5-B/C5-C (authorized operation + tenant isolation — covered by
`commerce-tenant`/`commerce-integration`) ✓ · C5-D (actor isolation — approver equality
tests) ✓ · C5-E (conflict behavior — repeated decision 409) ✓ · C5-F (Commercial Approval
regression) ✓ · C5-G (Assignment regression incl. foreign target + tenant isolation) ✓ ·
C5-Q1…Q10 **not created — no confirmed quotation semantics to test** (C5 §29: "Do not
create test scenarios for nonexistent semantics").

---

## W. REMAINING COMMERCE GAPS (unchanged inventory)

GAP-4 KPI/Reporting DEFERRED · GAP-5 Global Search OPEN · **GAP-6 quotation/confirmation/
correction = BLOCKED BY CONTRACT (this phase)** · GAP-7 Audit read OPEN · GAP-8 Member/seed
PARTIAL · GAP-9 Notifications OPEN · GAP-ENV Deployment OPEN. No other gap was touched —
[CONFIRMED].

---

## X. UNKNOWN

- All quotation semantics (shape, actor, attachment, lifecycle, pricing/currency/tax/delivery
  fields, expiry, optionality, multiplicity). — [UNKNOWN]
- Whether quotation belongs to document, line, group or a new entity. — [UNKNOWN]
- Whether §5.15's cash/non-cash reroute requires a persisted "actual quotation" fact; today
  `workflow-configuration.ts` records that §5.15 gives the threshold a MEANING but no SHAPE,
  and no threshold vocabulary exists anywhere. — [UNKNOWN]
- Whether requester confirmation and correction are separate surfaces or one flow. — [UNKNOWN]

---

## Y. DECISION REQUIRED (the exact decisions to unblock quotation)

1. **Entity & ownership** — what a quotation IS and which row owns it
   (PurchaseDocument / PurchaseLine / CommercialGroup / new entity). — [DECISION REQUIRED]
2. **Fields** — price/currency/tax/delivery/attachment/validity columns and their bounds. — [DECISION REQUIRED]
3. **Lifecycle** — states, transitions, and which actor may perform each (if any lifecycle is
   wanted at all; a purely informational price-evidence entry is also an option). — [DECISION REQUIRED]
4. **Multiplicity & supplier** — zero/one/many quotations per document and per line; supplier
   identity (free text vs a future supplier directory). — [DECISION REQUIRED]
5. **Relationships** — does quotation feed requester-confirmation, correction/re-activation
   (P §11-2), cash/non-cash reroute (§5.15), approval applicability, or
   `PurchaseDocument.status`? — [DECISION REQUIRED]
6. **Permission binding** — confirm `commerce.commercial.manage` (already seeded for
   "quotation entry, confirmation, correction") is the route permission. — [DECISION REQUIRED]
7. **Correction/re-activation model** for REJECTED commercial decisions (P §11-2) — a
   prerequisite if confirmation/correction are to be built. — [DECISION REQUIRED]

Possible options (OPTIONS ONLY — not chosen):
A) informational price-evidence entry attached to PurchaseLine, no lifecycle;
B) request/response quotation pair with explicit states;
C) fold quotation into configurable workflow steps only (no new entity);
D) defer until a supplier directory exists.
Future data-model impact: option B implies a new tenant-scoped table + pinning questions;
option A is additive columns; option C needs no schema. Impact on `PurchaseDocument` flow:
none for A/C; B must state whether/when it may write `PurchaseDocument.status` (today only
the single projection writer may).

---

## Z. EXPLICITLY REJECTED ASSUMPTIONS (none assumed, none implemented)

lowest quotation wins · quotation mandatory · three quotations mandatory · supplier
comparison required · supplier selection required · quotation expiration · automatic award ·
manager/requester approval for quotation · commercial manager role · price-only comparison ·
delivery-time ranking · automatic negotiation · automatic supplier replacement · automatic
purchase-price update · quotation directly changing `PurchaseDocument.status` · invented
`DRAFT/REQUESTED/RECEIVED/EVALUATED/SELECTED/EXPIRED` lifecycle · new permission names ·
new settings surface · quotation UI — **ALL NOT ASSUMED, NONE IMPLEMENTED**. — [CONFIRMED]

---

## PER-CAPABILITY FINAL CLASSIFICATION

```text
Commercial Groups ......... CLOSED
Commercial Configuration ... CLOSED
Line Assignment ........... CLOSED
Commercial Approval ....... CLOSED
Pending-Decision Inbox .... CLOSED
Quotation entry/update .... CONTRACT BLOCKED
Requester confirmation .... CONTRACT BLOCKED
Correction / reactivation . CONTRACT BLOCKED
Group deletion/archive .... CONTRACT BLOCKED
RFQ / supplier offer ...... NOT IN DOMAIN
Quotation comparison ...... NOT IN DOMAIN
Supplier selection / award. NOT IN DOMAIN
Overall GAP-6 ............. PARTIAL — BLOCKED BY CONTRACT
```

---

## FINAL PRINCIPLE

```text
Existing contracts win. Existing source wins. Existing tests win.
GAP-6 was NOT permission to invent a quotation module —
and discovery proved there was nothing else left to close.
```




