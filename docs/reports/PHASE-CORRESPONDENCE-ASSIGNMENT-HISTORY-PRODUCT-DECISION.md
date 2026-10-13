# PHASE — CORRESPONDENCE #31 + COMMERCIAL ASSIGNMENT HISTORY #32
# FINAL PRODUCT DECISION / CONTRACT CLOSURE (LAST DOCS-ONLY GATE)

> Phase type: FINAL PRODUCT DECISION — DOCUMENTS + EVIDENCE ONLY.
> Starting HEAD = 3d9101d38938dfdab699ce2934ea2bf92abe1113 (master), tree clean
> except generated `apps/web/next-env.d.ts`.
> NOTHING was implemented: no controllers, routes, services, repositories,
> Prisma/schema/migrations, API clients, UI pages/components, navigation,
> permissions/remits, exports, charts, KPIs, dashboard cards, source-context
> read seams, cross-context adapters, or generic history/correspondence
> frameworks.
> This document is the FINAL DECISION RECORD superseding the candidate-state
> record committed at that HEAD.

## A. Executive Decision

**#31 Correspondence (tenant-wide manager register slice) — final class:
`DUPLICATE — ALREADY COVERED` [DUPLICATE].** The business question the candidate
carried (tenant-wide lifecycle listing with filters, for a manager) is answered
today, row-for-row, by the SOURCE's own operational read: `GET
/api/v1/correspondence/search` composes every candidate row through the single
`visibleLetterWhere` predicate, whose manager branch (held `correspondence.manage`,
seeded 20260912120600) widens to the whole tenant — confidential rows additionally
requiring `correspondence.confidential.read` — with source-owned filters, cursor
paging, one-row-per-`Letter` grain, and drill-down to `GET correspondence/:id` /
`:id/content` / `:id/tracking` under the same predicate family. A Reporting
register would be a SECOND definition of the same rows, for the same audience,
under the same authorization — forbidden duplication. The previous record's claim
"tenant-wide register does NOT exist" is **SUPERSEDED** by this code evidence
[EXPLICIT PRODUCT DECISION].

**#32 Commercial Assignment History (tenant-wide history slice) — final class:
`DEFERRED` [DEFERRED].** `CommercialAssignmentHistory` is a genuine append-only
business-assignment event record [CONFIRMED]: one row per assignment change per
purchase line, written in the same unit of work as create/reassign, with closed
vocabularies. But repository evidence establishes NO business question, NO
audience, NO decision this register would inform, NO tenant-wide authorization
for it, and NO Commerce-owned tenant-wide read — the only existing read is
document-scoped (`GET commerce/commercial-assignments` REQUIRES `documentId`).
Rule-change and who-changed-what readings are already owned elsewhere
[NOT_REPORTING] (configuration version surface + platform audit trail). The
product does not currently require the surviving business-history reading →
DEFERRED, with an explicit conditional [BLOCKED_SOURCE_CONTRACT] overlay noted
in §J/§R for any future reopen.

**Implementation allowed now: NO for both.** Neither candidate is
implementation-eligible (§P). Technical feasibility is not product authorization
[EXPLICIT PRODUCT DECISION]: "the fields exist", "the table is append-only", "a
route could be written", "a UI would be easy", "managers might find it useful",
"a permission looks close enough", "an existing report could be copied", "a seam
would be easy to add" were each considered and each rejected as upgrade grounds
(§13).

Product conclusion: #31 closes as already covered — the answer to "managers need
a tenant-wide correspondence register" is "they have one, inside Correspondence";
#32 closes as deferred — report-shaped storage without a product requirement is
not a product capability. No candidate may enter Reporting, KPI, or Dashboard on
this evidence.

## B. Baseline

Starting HEAD 3d9101d38938dfdab699ce2934ea2bf92abe1113, branch master;
`git status --short` at phase start showed only `?? apps/web/next-env.d.ts`
(generated, untracked). Baseline decisions carried forward unchanged, none
reopened [EXPLICIT PRODUCT DECISION — prior phases]:

- Reporting is read-only and source-owned; Reporting owns no datasource, no
  client, no permission; 10 registers consume 10 source-owned narrow seams.
- Reporting does not own source business semantics; KPI is separate from
  Reporting; Dashboard is composition-only; CoreDashboard is personal.
- Management Dashboard V1 is separate and already product-decided.
- GAP-4a is closed/superseded for Dashboard V1; GAP-4b is deferred
  future/non-V1 — both untouched here.
- Cross-context private Prisma/repository access is forbidden.
- Existing audit data does not automatically constitute a business-history
  contract.
- No generic history/report builder may be introduced.

## C. Previous Decision State

| Candidate | State entering this phase | Blockers recorded then |
|---|---|---|
| #31 tenant-wide manager register | B — REPORTING / PRODUCT DECISION REQUIRED | manager business question; audience; confidentiality/BCC projection; remit; entitlement; grain; filters; time semantics; drill-down; export; Correspondence-owned read seam |
| #31 operational + participant slices | C source-context / D already covered | closed earlier |
| #32 CommercialAssignmentHistory slice | B — REPORTING / PRODUCT DECISION REQUIRED | business question; purpose (audit vs configuration vs business history); grain; output shape; tenant-wide authorization; filters/time window; remit; entitlement; drill-down; Commerce-owned source seam; inbox separation |
| #32 current-state list | D duplicate (#35) | closed earlier |
| #32 workflow/approval/ticket/HR/generic meanings | C / D / F | closed earlier |

This phase's mandate: convert both B rows into terminal, evidence-supported
classifications; no B may remain unless the residual unknown is itself a
recorded product decision (it is not — §D, §H).

## D. Correspondence Final Decision

**Final classification: `DUPLICATE — ALREADY COVERED` [DUPLICATE].**
Scope: ONLY the tenant-wide manager register slice (#31-mgr) that entered this
phase as B. Operational/authoring slices stay C; participant slices stay D;
letter creation, message sending, notification center, email and document
generation remain non-goals — none reopened.

Gate-by-gate reasoning (§3):

1. **Business question (§3.1).** No evidence-backed sentence exists that
   `GET correspondence/search` does not already answer for a manager: status
   filter + createdAt window + manager-widened `visibleLetterWhere` yields
   "which letters exist tenant-wide, in which lifecycle state, in a period"
   row-for-row [CONFIRMED — E5/E6]. "Managers need visibility" is explicitly
   rejected as a question. Verdict: no NEW question → a second surface would be
   duplication, not capability.
2. **Audience (§3.2).** Existing vocabulary only: holders of seeded
   `correspondence.manage` (+ `correspondence.confidential.read` for
   confidential rows), migration 20260912120600, ADMIN/SUPER_ADMIN [CONFIRMED].
   No new role, no new permission — no new surface is granted.
3. **Confidentiality / BCC (§3.3).** Resolved BY THE SOURCE and this resolution
   closes the candidate (§G): list rows never project recipients at all; BCC
   identity selection is a CorrespondenceService projection rule; confidential
   letters are predicate-gated. The safe manager projection already exists —
   inside Correspondence, not Reporting.
4. **Row grain (§3.4).** One `Letter` per row (LETTER_BASE_SELECT + count)
   [CONFIRMED]. No mixed grain exists to block, because no new row is created.
5. **Filters / time (§3.5).** Evidence-backed set already served: q,
   letterNumber, subject, senderId, recipientId, status, urgency,
   classification, category, createdAt window (inclusive bounds, source
   instants), hasAttachments, confidential [CONFIRMED]. Reporting adds none.
6. **Lifecycle (§3.6).** Source vocabulary DRAFT/READY_TO_SEND/SCHEDULED/SENT/
   CANCELLED used verbatim; no generic statuses invented [CONFIRMED].
7. **Drill-down (§3.7).** Exists: `GET correspondence/:id` (+ content,
   tracking, attachments) under the same predicate family; 404-safe; no route
   invented [CONFIRMED].
8. **Export (§3.8).** No export exists anywhere in Correspondence and no
   evidence requires one [CONFIRMED absence]. Not granted; "users might want
   to export" rejected per §13.
9. **Seam (§6).** No Correspondence reporting seam exists (E13). Because the
   candidate is DUPLICATE, none is required and none may be built: the source's
   own read surface IS the authoritative capability.

**Why not READY:** every contract field resolves onto the EXISTING operational
surface; a Reporting register over the same rows, audience and predicate would
be a second definition of one capability — §9 forbids registers justified by a
sibling surface showing related data, and here it is the SAME data.
**Why not DEFERRED/BLOCKED:** the capability is not missing — it exists and is
reachable today; labeling it future/blocked would misstate the repository
[EXPLICIT PRODUCT DECISION].

## E. Correspondence Evidence

| # | Fact | Label | Ground |
|---|---|---|---|
| E1 | Independent context: own DB/client/migrations, composition-root registered | CONFIRMED | prisma/correspondence/schema.prisma (CORRESPONDENCE_DATABASE_URL); correspondence.module.ts; correspondence-isolation.spec |
| E2 | `visibleLetterWhere` = single predicate: participant edges + manager branch | CONFIRMED | correspondence.service.ts:632-658 |
| E3 | Manager branch: canManage → tenantId + OR[participants, classification in (canReadConfidential ? all : NORMAL)] | CONFIRMED | correspondence.service.ts:639-655 |
| E4 | canManage/canReadConfidential/canWriteConfidential resolved from RBAC server-side | CONFIRMED | correspondence.service.ts:446-465 (CORRESPONDENCE_MANAGE / CONFIDENTIAL_READ / CONFIDENTIAL_MANAGE) |
| E5 | `GET correspondence/search` = manager-capable register: filters + cursor page + manager-widened predicate | CONFIRMED | correspondence.controller.ts:88-91; correspondence.service.ts:2509-2618 |
| E6 | Search filters: q/letterNumber/subject/senderId/recipientId/status/urgency/classification/category/createdAt window/hasAttachments/confidential | CONFIRMED | correspondence.service.ts:2529-2595; dto letter.dto.ts:368-455 |
| E7 | Row projection excludes recipients/body/storageKey/tenantId: LETTER_BASE_SELECT + attachmentCount | CONFIRMED | correspondence.service.ts:94-109, 2597-2615 |
| E8 | DTO declares `scope: 'visible' \| 'all'` documented "tenant-wide (managers only)" | CONFIRMED | dto letter.dto.ts:439-443 |
| E9 | Drill-down routes exist under same predicate family; 404-safe | CONFIRMED | correspondence.controller.ts:289-342; attachment 404 contract (same as detail) |
| E10 | BCC privacy = source projection rule: BCC identities only for sender + manager(manage) [+confidential.read for confidential letters] | CONFIRMED | correspondence.service.ts:57-72; correspondence.service.spec (BCC plan) |
| E11 | Three seeded permissions; personal workflow ungated; only PATCH classification Roles-gated | CONFIRMED | seed 20260912120600; correspondence.controller.ts:57-68 |
| E12 | Lifecycle closed: LetterStatus 5 states (SENT/CANCELLED terminal); recipient states; NORMAL/CONFIDENTIAL/SECRET | CONFIRMED | letter-status.util.ts; schema enums |
| E13 | NO correspondence reporting seam, NO reporting entitlement shape, NO reporting permission, NO export route | CONFIRMED absence | reporting.module.ts imports (10 owners, none Correspondence); portfolio evidence §21; controller grep (no xlsx/docx/export) |
| E14 | NO correspondence KPI, NO dashboard card | CONFIRMED absence | kpi-catalog (9 entries, none correspondence); dashboard composition record |
| E15 | Prior claim "tenant-wide register does NOT exist" contradicted by E2-E5 | SUPERSEDED [EXPLICIT PRODUCT DECISION] | this document §D/§E |

Correspondence IS (unchanged): formal letters + attachments + referral workflow
+ per-letter tracking, participant-scoped by construction, manager-widened by
permission. Correspondence IS NOT: notification, message, chat, email client,
editor, template, signature-workflow, delivery system, storage system — and,
after this decision, NOT a Reporting capability.

## F. Correspondence Product Contract

No NEW contract is granted (classification DUPLICATE). This table records the
authoritative EXISTING contract so no future phase re-opens settled fields; any
UNKNOWN row would independently forbid eligibility.

| Field | Value | Label |
|---|---|---|
| Business Question | None distinct from the operational search's already-served question | [DUPLICATE] |
| Audience | Holders of `correspondence.manage` (+`correspondence.confidential.read` for confidential rows) | [CONFIRMED] |
| Owner | Correspondence context | [CONFIRMED] |
| Tenant Scope | Server-derived tenantId inside every predicate branch | [CONFIRMED] |
| Authorization | RBAC correspondence.manage / correspondence.confidential.read, resolved server-side | [CONFIRMED] |
| Entitlement | No reporting entitlement exists or is created; source routes carry none by design (personal routes + service edges) | [CONFIRMED] |
| Row Grain | One `Letter` | [CONFIRMED] |
| Primary Fields (existing rows) | id, letterNumber, subject, category, urgency, classification, status, letterDate, sentAt, readyAt, createdAt, updatedAt, senderId, signatureId, attachmentCount | [CONFIRMED] |
| Forbidden Fields | recipients (incl. BCC), bodyHtml, storageKey, tenantId, any identity beyond senderId | [CONFIRMED] |
| Lifecycle Vocabulary | DRAFT / READY_TO_SEND / SCHEDULED / SENT / CANCELLED (verbatim) | [CONFIRMED] |
| Filters | The E6 set, source-owned; no additions | [CONFIRMED] |
| Time Semantics | createdAt window, inclusive bounds on source instants; letterDate = official date 00:00 Asia/Tehran | [CONFIRMED] |
| Drill-Down | `GET correspondence/:id` (+content/tracking), same predicate family | [CONFIRMED] |
| Export | NONE exists, NONE required, NONE granted | [CONFIRMED absence / EXPLICIT PRODUCT DECISION] |
| Freshness | Read-through per request; no cache/materialization in source | [CONFIRMED] |
| Error/Unavailable Semantics | 403 context/tenant failures; 404 invisible-or-absent indistinguishable; DTO whitelist rejects foreign fields | [CONFIRMED] |
| Required Source Seam | NONE — the candidate may not become a Reporting capability at all | [DUPLICATE] |
| Explicit Non-Goals | Reporting correspondence register; correspondence KPI; dashboard card; export; generic correspondence framework; notification/email/document-generation changes | [EXPLICIT PRODUCT DECISION] |

## G. Correspondence Authorization / Confidentiality

Mandatory decision point (§3.3), resolved from actual source semantics:

| Field class | Status | Ground |
|---|---|---|
| letterNumber, subject, category, urgency, classification, status, dates, senderId, attachmentCount | **VISIBLE** in manager list rows | LETTER_BASE_SELECT; E7 |
| recipients TO/CC (detail/content views) | **VISIBLE** only to viewers the predicate admits; list rows never project them | E7/E9 |
| BCC identities | **VISIBLE** only to sender + manager holding correspondence.manage (+confidential.read when letter is confidential); NEVER to TO/CC; BCC recipient sees only own BCC status | [CONFIRMED] E10 |
| bodyHtml | **VISIBLE** only through `:id/content` under the same predicate; never in list/search rows | [CONFIRMED] E7/E9 |
| attachments (metadata + download) | **VISIBLE** under same predicate; storageKey never leaves server | [CONFIRMED] correspondence.controller.ts:329-422 |
| CONFIDENTIAL/SECRET letters to a manager without confidential.read | **NOT VISIBLE** (filtered out of the manager's tenant-wide branch) | [CONFIRMED] E3 |
| tenantId, internal isolation metadata | **NOT VISIBLE** (never projected) | [CONFIRMED] E7 |
| Export of any of the above | **UNKNOWN → NONE** — no export surface exists or is granted | [CONFIRMED absence] E13 |

**Verdict:** a safe manager projection is already established — by
Correspondence, for Correspondence's own surface. The confidentiality gate that
would have BLOCKED a Reporting candidate is instead moot: the register is
[DUPLICATE] of the source surface that already enforces these rules. Reporting
must not re-implement any of these projections. Classification of a future
report-shaped correspondence export remains UNKNOWN and is not granted here.

## H. Assignment History Final Decision

**Final classification: `DEFERRED` [DEFERRED].**
Scope: ONLY the tenant-wide Commercial Assignment History slice (#32-hist) that
entered this phase as B. Current-state list stays D; workflow/approval inboxes
stay C; generic frameworks stay F; no other meaning reopened.

Gate-by-gate reasoning (§4):

1. **Business purpose (§4.1).** Three candidate meanings were tested:
   - BUSINESS HISTORY — "which commercial assignment changes occurred over
     time, tenant-wide, so that WHO can make WHAT decision?" → the decision and
     the decider are UNKNOWN in all repository evidence [UNKNOWN]. No document,
     route, seed, or permission states a tenant-wide assignment-history need.
   - TECHNICAL AUDIT — "who changed a routing rule / an assignment?" → already
     owned: platform audit trail records ASSIGN/REASSIGN actions
     (CommerceAuditGateway.record on writeAssignment and manual reassign)
     [CONFIRMED, §K], and configuration versions own rule-change history.
   - CONFIGURATION — "how are assignment routes configured?" → owned by the
     commercial-configuration surface, not Reporting [NOT_REPORTING].
   Because no business-history QUESTION with an audience and a decision can be
   proven, the slice cannot become READY; because the data shape is real and a
   future question is plausible, it is DEFERRED rather than UNSUPPORTED.
2. **Rule-audit vs assignment-history (§4.2).** Evidence establishes exactly
   what the table represents: one row per assignment change per purchase line,
   written in the SAME unit of work as create/reassign; append-only (single
   INSERT path, no update/delete); `changedAt` = the instant the assignment
   state took effect; `source` distinguishes rule-driven
   (PURCHASE_SUBMITTED / AFTER_DOCUMENT_WORKFLOW_APPROVED) from MANUAL;
   manual rows carry actorUserId + reason; current assignment is separately
   derivable from the current-row table (unique per tenant+line), and history
   is the authoritative past (§3-C "January stays readable after February")
   [CONFIRMED]. The name alone was not trusted.
3. **Grain (§4.3).** ONE ROW = one assignment-change event on ONE purchase line
   (purchaseLineId + changedAt, no documentId on the row by design — the
   repository states history's shape is "what happened to this LINE")
   [CONFIRMED]. A tenant-wide register row would need line→document context;
   mixing document/line/workflow/rule grains into one row is forbidden.
4. **Tenant-wide authorization (§4.4).** NOT proven. The only existing read is
   `GET commerce/commercial-assignments`, which REQUIRES `documentId`
   (CommercialDocumentQueryDto @IsUUID, mandatory) under `commerce.read` +
   module entitlement — a document-scoped operational read, not a tenant-wide
   one [CONFIRMED]. No route, permission grant, or document authorizes a
   tenant-wide assignment-history projection. Adding one is explicitly refused
   in this phase [EXPLICIT PRODUCT DECISION] → hard gate FAILS.
5. **Filters (§4.5).** Document/assignee/type/date/actor filters are NOT
   granted: their existence in the table is not a product requirement; with no
   question there are no evidence-backed filters.
6. **Inbox separation (§4.6).** Stated explicitly in §L; no use case of this
   slice belongs to pending-decisions, approval inbox, workflow history, or the
   current assignment list.

**Conditional overlay:** IF a future phase first supplies a proven one-sentence
business question + audience + decision, the slice reopens as
[BLOCKED_SOURCE_CONTRACT] — Commerce owns no tenant-wide assignment-history
read seam (§M) — and only after §4.4 authorization is product-decided. Until
then the terminal state is DEFERRED. The technical/audit readings remain
[NOT_REPORTING] permanently unless a separate confirmed business requirement
appears (§4.1 rule).

**Why not READY:** business question UNKNOWN, audience UNKNOWN, tenant-wide
authorization not proven, seam absent — four independent failures.
**Why not BLOCKED_SOURCE_CONTRACT as primary:** the primary blocker is the
absent product requirement, not the absent seam; a seam without a question
would be capacity looking for a purpose [EXPLICIT PRODUCT DECISION].
**Why not NOT_REPORTING outright:** the assignment-change record is genuinely
business-shaped (who is responsible for this line, since when, why) — it is the
REQUIREMENT that is missing, not the semantics.

## I. Assignment History Evidence

| # | Fact | Label | Ground |
|---|---|---|---|
| I1 | Current row: one per (tenantId, purchaseLineId); states ASSIGNED/UNASSIGNED; unique constraint | CONFIRMED | commercial-lifecycle.repository.ts (P5); commercial-status.ts COMMERCIAL_ASSIGNMENT_STATES |
| I2 | History append-only: ONE INSERT path (`appendAssignmentHistoryIn`), no update, no delete sibling | CONFIRMED | commercial-lifecycle.repository.ts:217-237 ("January stays readable after February") |
| I3 | Create/reassign writes current + history + platform audit in the SAME unit of work | CONFIRMED | commercial-lifecycle.service.ts writeAssignment (create → append → audit.record) and manual reassign path |
| I4 | Closed vocabularies: status ASSIGNED/UNASSIGNED; source PURCHASE_SUBMITTED / AFTER_DOCUMENT_WORKFLOW_APPROVED / MANUAL; matched rule label + config version | CONFIRMED | commercial-status.ts; schema enums |
| I5 | History grain: LINE-scoped — `purchaseLineId`, no `purchaseDocumentId` by design ("what happened to this LINE") | CONFIRMED | commercial-lifecycle.repository.ts listHistoryByLines doc-block |
| I6 | Manual rows carry actorUserId + reason; rule-driven rows carry source + rule label/version | CONFIRMED | service manual assign (reason optional, §3-H) vs writeAssignment |
| I7 | Ordering: [changedAt asc, id asc] per line; changedAt = instant the state took effect | CONFIRMED | repository listHistoryByLine(s) orderBy |
| I8 | Existing read = DOCUMENT-scoped only: GET commercial-assignments REQUIRES documentId, returns current + history; Roles: commerce.read; entitlement module commerce/feature purchase | CONFIRMED | commercial.controller.ts:215-219; CommercialDocumentQueryDto (mandatory @IsUUID documentId) |
| I9 | NO tenant-wide assignment read route exists; NO list-by-assignee/by-actor/by-date route | CONFIRMED absence | controller route table (fifteen routes, §9 closed); repository has no tenant-wide history finder |
| I10 | Audit trail ALSO records ASSIGN/REASSIGN (CommerceAuditGateway.record with old/new values on manual reassign) | CONFIRMED | service audit.record calls; P0 durable-table audit rows |
| I11 | Rule-change history owned by commercial configuration versions (publish/archive, pinned per document) | CONFIRMED | commercial-configuration routes; document pins commercialConfigurationVersionId |
| I12 | NO assignment reporting seam (4 Commerce seams only: purchase, payment, return, receiving); NO assignment READER token | CONFIRMED absence | commerce/reporting/* directory listing; reporting.module.ts imports |
| I13 | NO assignment KPI, NO dashboard card; pending-decisions inbox is operational and refuses task-engine semantics | CONFIRMED absence | kpi-catalog; dashboard record; pending module header |
| I14 | Current assignment list = D duplicate (#35), already served by GET commercial-assignments | CONFIRMED (prior decision) | prior portfolio review; I8 |
| I15 | Tenant-wide authorization for history projection: no route, grant, or document states it | UNKNOWN / NOT PROVEN | absence across controller, seeds, permissions catalogue |

## J. Assignment History Product Contract

No contract is granted (classification DEFERRED). Fields recorded to close the
candidate honestly; any UNKNOWN row independently forbids eligibility.

| Field | Value | Label |
|---|---|---|
| Business Question | NOT ESTABLISHED — no evidenced "who needs to know which assignment changes, for what decision" | [UNKNOWN] → [DEFERRED] |
| Audience | NOT ESTABLISHED (a hypothetical auditor/manager is not seeded, not documented, not evidenced) | [UNKNOWN] |
| Owner | Commerce context (would-be source of any future seam) | [CONFIRMED] |
| Tenant Scope | tenantId present on every row; tenant-wide REACH not authorized | [CONFIRMED columns / UNKNOWN authorization] |
| Authorization | Document-scoped `commerce.read` proven (I8); tenant-wide history projection NOT proven; no new permission in this phase | [UNKNOWN] → gate fails |
| Entitlement | module `commerce` / feature `purchase` exists for source routes; no reporting entitlement decision made | [CONFIRMED pattern / decision not made] |
| Row Grain | ONE ROW = one assignment-change event on one purchase line (line + changedAt) | [CONFIRMED] I5/I7 |
| Primary Fields | purchaseLineId, commercialGroupId, status, source, resolvedUserId, matchedRuleLabel, configurationVersionId, actorUserId, reason, changedAt | [CONFIRMED] I2-I6 |
| Forbidden Fields | NOT DECIDED — projection beyond the source's own document-scoped response is unreviewed (actor identities, reasons) | [UNKNOWN] |
| Lifecycle Vocabulary | ASSIGNED / UNASSIGNED + 3-member source vocabulary (verbatim) | [CONFIRMED] I4 |
| Filters | NONE granted — document/assignee/type/date/actor not evidence-backed without a question | [DEFERRED] |
| Time Semantics | changedAt instant, ordered asc per line; no window/timezone convention decided for a register | [CONFIRMED field / UNKNOWN register semantics] |
| Drill-Down | Document/line detail exists for the document-scoped surface; tenant-wide register drill-down NOT decided | [CONFIRMED operational / UNKNOWN for register] |
| Export | NONE required, NONE granted | [EXPLICIT PRODUCT DECISION] |
| Freshness | Read-through from source (would-be); no materialization anywhere | [CONFIRMED] |
| Error/Unavailable Semantics | NOT DECIDED for a register that may not be built | [UNKNOWN] |
| Required Source Seam | Commerce-owned tenant-wide assignment-history reader — DOES NOT EXIST; must not be built without §R reopen | [BLOCKED_SOURCE_CONTRACT — conditional, post-reopen only] |
| Explicit Non-Goals | generic assignment history; workflow/approval/task inbox; current assignment list (D); routing configuration; delegation; notification history; generic history framework | [EXPLICIT PRODUCT DECISION] |

## K. Assignment History vs Rule Audit

Mandatory distinction (§4.2), settled on evidence:

| Reading | Owning surface | Verdict | Label |
|---|---|---|---|
| "Who changed a routing/assignment RULE?" | Commercial configuration versions (publish/archive, pinned per document; matchedRuleLabel + configurationVersionId stamped onto rows) | Configuration surface, not Reporting | [NOT_REPORTING] |
| "Who performed which assignment ACT, when?" | Platform audit trail — CommerceAuditGateway.record runs in the same unit of work as every writeAssignment and manual reassign, with old/new values | Audit lane; audit data does not auto-constitute a business-history contract (baseline rule) | [NOT_REPORTING] |
| "Why is THIS line assigned to THIS group/person now?" | Document-scoped GET commercial-assignments (current + history) | Source-context operational read, served | [CONFIRMED] I8 |
| "Which assignment changes happened tenant-wide over time, for what decision?" | Nobody — no route, no seam, no question, no audience | Product requirement absent | [UNKNOWN] → [DEFERRED] |

Evidence-based semantics (name not trusted): a history row IS a business
assignment event — it records the assignment state that TOOK EFFECT on one
line, its provenance (rule vs manual), the resolved person, and (for manual
acts) the actor and reason [CONFIRMED I2-I7]. It is NOT a rule-change record
(configuration versions are), and it is NOT the audit trail (the gateway is).
Replacement/reassignment is represented as a NEW row; the previous row remains;
current state is derivable from the current-row table; history is authoritative
for the past [CONFIRMED].

## L. Assignment History vs Inbox / Workflow

Explicit separation (§4.6), each line a recorded product decision:

```text
Commercial Assignment History
  != Pending Decisions (pending-decisions inbox: operational, task-shaped,
     refuses task-engine semantics — I13)
  != Approval Inbox (CommercialApproval: PENDING/APPROVED/REJECTED with its own
     decision routes — a queue, not a history)
  != Workflow Instance History (WorkflowInstance/StepInstance: execution trace
     of workflow steps, different vocabulary, different owner)
  != Current Assignment List (CommercialAssignment current rows, GET
     commercial-assignments — classified D duplicate, #35, I14)
  != Routing Configuration (commercial configuration versions — §K)
```

Any future use case belonging to one of those surfaces is classified THERE and
excluded from the Reporting candidate [EXPLICIT PRODUCT DECISION]. The DEFERRED
slice in §H is only the tenant-wide, cross-document, time-oriented reading of
assignment changes — and it stays deferred until §R is satisfied.

## M. Source-Owned Seam Requirements

This phase MAY decide what seam a future reopen would require; it MUST NOT
build one. Nothing below exists today; nothing below was created.

**#31 (post-DUPLICATE):** no seam is required, because no Reporting capability
is granted. IF a future phase ever approved a genuinely distinct
correspondence reporting question (one that `search` does not answer), the
would-be owner is the Correspondence context and the seam would have to be a
narrow module exporting ONE reader token carrying: tenant predicate, field
projection (E7 whitelist + §G confidentiality rules), lifecycle vocabulary,
authorization boundary (correspondence.manage / confidential.read resolved
source-side). Reporting may consume only that token. Current state: NONE
NEEDED [DUPLICATE].

**#32 (post-DEFERRED):** IF AND ONLY IF §R reopen criteria are met, the
required seam is a Commerce-owned narrow module exporting ONE reader token
with: tenant predicate, line-grain row shape (I5), closed vocabularies (I4),
changedAt ordering (I7), a product-decided field projection (including an
explicit decision on actor/reason visibility), and authorization evaluated
inside Commerce. Until reopen: MUST NOT BE BUILT [EXPLICIT PRODUCT DECISION].
Current state: ABSENT [BLOCKED_SOURCE_CONTRACT — conditional, activates only
after reopen].

Rule (unchanged): Source Context → seam → Reporting → Web. Cross-context
private Prisma/repository access stays forbidden in both directions; source
contexts never import Reporting (direction is one-way by construction).

## N. Reporting / KPI / Dashboard Boundaries

- **Reporting (§9):** the 10 existing registers are untouched: financial check
  request, commerce purchase, production, hr personnel traffic, production BOM
  change, hr leave, hr mission, commerce payment history, commerce return
  lifecycle, commerce receiving status [CONFIRMED — reporting.module.ts]. No
  11th or 12th register was added; no existing register's contract changed.
  No correspondence/assignment controller, service, DTO, route, or seam exists
  or was created.
- **KPI (§11):** catalog unchanged (9 entries; KPI-009 BLOCKED untouched). No
  correspondence rate, correspondence throughput, assignment rate, assignment
  performance, assignment aging, or any similar KPI semantics were created —
  explicitly forbidden this phase [EXPLICIT PRODUCT DECISION].
- **Dashboard (§10):** Management Dashboard V1 unchanged and product-decided;
  composition-only. Neither #31 nor #32 became a Dashboard capability to
  satisfy a management-visibility desire [EXPLICIT PRODUCT DECISION].
  Dashboard must not (unchanged): own correspondence semantics, reconstruct
  assignment history, query Correspondence/Commerce Prisma, or create
  business-history semantics. CoreDashboard stays personal, out of scope.
- **GAP-4:** GAP-4a (superseded for V1) and GAP-4b (deferred future) untouched
  [CONFIRMED — no GAP-4 file modified this phase].
- **Permissions / remits / navigation / entitlements / exports / charts:**
  none added, none modified, none seeded.

## O. Duplication Analysis

Mandatory comparison (§9) of the surviving candidates against everything
shipping today:

| Existing surface | Covers #31? | Covers #32? | Note |
|---|---|---|---|
| All 10 Reporting registers + their timelines/summaries | NO | NO | None reads correspondence or assignment data; zero field overlap |
| Source-owned summaries (purchase counts, receiving projection, payment timeline, return lifecycle) | NO | NO | Different aggregates, different owners |
| Management Dashboard V1 | NO | NO | Composes approved questions only; no correspondence/assignment source |
| KPI surface (9 KPIs) | NO | NO | No correspondence/assignment KPI exists |
| Core observability (audit trail, health, logs) | NO | partial (audit acts only) | Audit records assignment ACTS; that is audit, not a business register (§K) |
| **Operational `GET correspondence/search` + detail/content/tracking** | **YES — fully** | no | THE reason #31 is [DUPLICATE]: same rows, audience, predicate, grain, lifecycle, drill-down |
| **Operational `GET commercial-assignments` (document-scoped)** | no | partial (one document at a time) | Serves the per-document question; the tenant-wide question has no requirement (§H) |
| Correspondence web workflow (inbox/sent/drafts/archive/search UI) | YES (participant + manager views) | no | Full workflow exists; nav unchanged |
| Commercial configuration surface + pending/approval inboxes | no | adjacent but distinct | Rule changes / queues owned there (§K/§L) |

No new register was created because a sibling page shows related data — and
for #31 the sibling shows the SAME data, which is why it closes as DUPLICATE
rather than a contract [EXPLICIT PRODUCT DECISION].

## P. Implementation Eligibility

Explicit checklist (§5). A candidate is IMPLEMENTATION ELIGIBLE only if ALL
items are TRUE; any FALSE or UNKNOWN → NO.

**#31 Correspondence — tenant-wide manager register:**

| Item | Result | Ground |
|---|---|---|
| one-sentence business question confirmed | FALSE (none distinct from search's served question) | §D.1 |
| audience confirmed | TRUE (correspondence.manage holders) | §D.2 |
| source owner confirmed | TRUE (Correspondence) | E1 |
| authoritative source confirmed | TRUE (Letter + predicate) | E2/E3 |
| exact row grain confirmed | TRUE (one Letter) | E7 |
| lifecycle/state semantics confirmed | TRUE (5-state LetterStatus) | E12 |
| tenant scope confirmed | TRUE (tenantId in predicate) | E3 |
| authorization/remit confirmed | TRUE (seeded RBAC) | E4/E11 |
| module entitlement confirmed | TRUE (none by design, no reporting entitlement created) | §F |
| safe field projection confirmed | TRUE (E7 whitelist + §G rules) | §G |
| required filters confirmed | TRUE (E6 set, source-owned) | E6 |
| time semantics confirmed | TRUE (createdAt inclusive window) | §F |
| drill-down decision confirmed | TRUE (detail/content/tracking exist) | E9 |
| export decision confirmed | TRUE (NONE — decided, not unknown) | §D.8 |
| source-owned read seam exists | TRUE (the operational read IS the surface; no seam needed) | §M |
| no cross-context private access required | TRUE (nothing new built) | §M |
| **no duplication with an existing surface exists** | **FALSE — duplicates `GET correspondence/search` exactly** | §O |

**IMPLEMENTATION ELIGIBLE = NO** (duplication item FALSE; also the question
item FALSE). Final class [DUPLICATE].

**#32 Commercial Assignment History — tenant-wide register:**

| Item | Result | Ground |
|---|---|---|
| one-sentence business question confirmed | FALSE (UNKNOWN — no evidenced question/decision) | §H.1 |
| audience confirmed | FALSE (UNKNOWN) | §J |
| source owner confirmed | TRUE (Commerce) | I1-I7 |
| authoritative source confirmed | TRUE (CommercialAssignmentHistory) | I2 |
| exact row grain confirmed | TRUE (line event) | I5 |
| lifecycle/state semantics confirmed | TRUE (ASSIGNED/UNASSIGNED + source vocab) | I4 |
| tenant scope confirmed | TRUE (tenantId columns) | I1 |
| authorization/remit confirmed | FALSE (tenant-wide NOT proven; document-scoped only) | §H.4, I8/I15 |
| module entitlement confirmed | FALSE (no reporting entitlement decision made) | §J |
| safe field projection confirmed | FALSE (actor/reason visibility undecided) | §J |
| required filters confirmed | FALSE (none evidence-backed) | §H.5 |
| time semantics confirmed | FALSE (register window/timezone undecided) | §J |
| drill-down decision confirmed | FALSE (tenant-wide drill undecided) | §J |
| export decision confirmed | TRUE (NONE — decided) | §J |
| source-owned read seam exists | FALSE (absent — conditional BLOCKED_SOURCE_CONTRACT) | I12, §M |
| no cross-context private access required | TRUE (rule unchanged, nothing built) | §M |
| no duplication with an existing surface exists | TRUE for the tenant-wide slice itself (document-scoped surface is a different scope; current list already excluded as D) | §O |

**IMPLEMENTATION ELIGIBLE = NO** (seven FALSE items). Final class [DEFERRED].

## Q. Final Classification Matrix

| Slice | Owner | Seam | Question | Final class | Eligible |
|---|---|---|---|---|---|
| #31-mgr tenant-wide manager register | Correspondence | none needed (operational read exists) | served by existing search | **DUPLICATE — ALREADY COVERED** [DUPLICATE] | NO |
| #31-op operational/authoring workflow | Correspondence | n/a (source-context) | operational | C — NOT REPORTING (unchanged) | NO |
| #31-part participant rows as reports | Correspondence | n/a | — | D — ALREADY COVERED (unchanged) | NO |
| #32-hist tenant-wide assignment history | Commerce (would-be) | ABSENT (conditional BLOCKED_SOURCE_CONTRACT) | UNKNOWN | **DEFERRED** [DEFERRED] | NO |
| #32-audit "who changed assignments/rules" | Platform audit / Commerce config | n/a (audit + config own it) | audit/config | NOT_REPORTING (unchanged, §K) | NO |
| #32-cur current assignment list | Commerce | GET commercial-assignments | served | D — DUPLICATE #35 (unchanged) | NO |
| #32-inbox workflow/approval/pending/ticket/HR/generic meanings | various/none | operational/absent | — | C / D / F (unchanged) | NO |

Neither candidate remains generic B after this phase [EXPLICIT PRODUCT DECISION].
No item was upgraded to READY_FOR_IMPLEMENTATION. KPI-009 and GAP-4a/b states
untouched.

## R. Reopen / Future Criteria

**#31 (DUPLICATE) reopens ONLY if ALL hold:**
1. A business question is stated in one sentence that `GET
   correspondence/search` does NOT already answer for the manager audience
   (e.g. a materially different grain, aggregation, or cross-domain join —
   never "visibility" or "search/export") [EXPLICIT PRODUCT DECISION].
2. Evidence (documented requirement + requester/decider) is attached; "the
   fields exist", "UI would be easy", "managers might want it" remain invalid.
3. A Correspondence-owned narrow read seam is approved for creation in that
   implementation phase (§M) — still never a cross-context Prisma reach.
4. Confidentiality projection is re-verified against §G at that time.
Absent these, #31 stays [DUPLICATE] permanently.

**#32 (DEFERRED) reopens ONLY if ALL hold:**
1. One-sentence BUSINESS-history question + named audience + the decision the
   register informs are documented (audit/configuration questions route to
   §K surfaces instead and stay [NOT_REPORTING]).
2. Tenant-wide authorization is product-decided using EXISTING permission
   vocabulary; a new permission requires its own seed/grant phase first
   (never in a decision phase).
3. Grain (line event), projection (explicit actor/reason visibility), filters,
   time semantics, drill-down, and export are each decided from source
   evidence.
4. Commerce-owned read seam approved and created in that implementation phase
   (§M); until then the slice is additionally [BLOCKED_SOURCE_CONTRACT].
5. §L separations re-verified: the use case is not an inbox, queue, workflow
   history, or current-state list.
If 1 fails permanently (requirement never materializes), the honest terminal
state becomes [UNSUPPORTED] at the next review.

## S. Evidence vs Decision Matrix

| # | Evidence-backed statement | Label | Drives |
|---|---|---|---|
| 1 | Manager tenant-wide correspondence read exists today via search + predicate | [CONFIRMED] E2-E5 | #31 → DUPLICATE |
| 2 | Safe BCC/confidentiality projection exists source-side | [CONFIRMED] E10, §G | #31 → DUPLICATE (gate moot) |
| 3 | No correspondence export/KPI/card/seam/entitlement exists or is required | [CONFIRMED absence] E13/E14 | no new surface |
| 4 | Prior "no tenant-wide register" claim superseded | [EXPLICIT PRODUCT DECISION] E15 | baseline correction |
| 5 | CommercialAssignmentHistory = append-only line-grain assignment events, semantics proven from code | [CONFIRMED] I1-I7 | #32 not UNSUPPORTED |
| 6 | Existing assignment read is document-scoped; no tenant-wide route/grant | [CONFIRMED] I8/I9 | #32 authorization gate fails |
| 7 | Audit and configuration own who-changed-what / rule-change readings | [CONFIRMED] I10/I11, §K | those readings [NOT_REPORTING] |
| 8 | Business question + audience for tenant-wide history absent | [UNKNOWN] §H.1, §J | #32 → DEFERRED |
| 9 | Commerce assignment reporting seam absent | [BLOCKED_SOURCE_CONTRACT] I12, §M | conditional overlay only |
| 10 | Current assignment list duplicate stands | [CONFIRMED] I14 | #32-cur stays D |
| 11 | #31 not eligible (duplication FALSE) | [EXPLICIT PRODUCT DECISION] §P | no implementation |
| 12 | #32 not eligible (seven FALSE) | [EXPLICIT PRODUCT DECISION] §P | no implementation |
| 13 | 10 registers / KPI-009 / GAP-4a/b / Dashboard V1 untouched | [CONFIRMED] §N | boundaries held |
| 14 | No READY_FOR_IMPLEMENTATION granted to either candidate | [EXPLICIT PRODUCT DECISION] §A/§Q | honesty rule §13 |
| 15 | Technical feasibility ≠ product authorization (all eight forbidden upgrade grounds rejected) | [EXPLICIT PRODUCT DECISION] §A | honesty rule §13 |

## T. Verification

STRICT DOCS-ONLY. Checks performed for this commit:

| Check | Expected | Result |
|---|---|---|
| `git status --short` (before staging) | only ` M docs/reports/PHASE-CORRESPONDENCE-ASSIGNMENT-HISTORY-PRODUCT-DECISION.md` + `?? apps/web/next-env.d.ts` (pre-existing generated file) | PASS — recorded at commit time |
| `git diff --check` | no whitespace errors | PASS |
| `git diff --name-only` (unstaged, pre-stage) | ONLY this decision document | PASS |
| Production source (controllers/routes/services/repositories) | unchanged | PASS — none touched |
| Tests | unchanged | PASS |
| Prisma schema / migrations | unchanged | PASS |
| Navigation / permissions / remits / entitlements | unchanged | PASS |
| KPI catalog / definitions | unchanged | PASS |
| Dashboard / cards / GAP-4 documents | unchanged | PASS |
| Dependencies (package.json / lockfiles) | unchanged | PASS |
| Stage scope | ONLY `docs/reports/PHASE-CORRESPONDENCE-ASSIGNMENT-HISTORY-PRODUCT-DECISION.md` | PASS — explicit `git add` of this path |
| `git diff --cached --stat` | shows ONLY this file | PASS |
| Commit count for this phase | exactly ONE | PASS |
| Commit message | `docs(reporting): close correspondence and assignment history product decisions` | PASS |

Post-commit working tree: only the pre-existing untracked
`apps/web/next-env.d.ts` remains [CONFIRMED].

## U. Git Record

```text
Starting HEAD: 3d9101d38938dfdab699ce2934ea2bf92abe1113 (master)
Baseline status: ?? apps/web/next-env.d.ts (generated, untracked)
Changed files:   docs/reports/PHASE-CORRESPONDENCE-ASSIGNMENT-HISTORY-PRODUCT-DECISION.md (rewrite: candidate-state record → FINAL DECISION RECORD)
Code changed:    NONE (docs-only; no controllers, routes, services, repositories,
                 schema, migrations, tests, navigation, permissions, KPIs,
                 dashboards, GAP-4 files, or dependencies)
Staged:          ONLY docs/reports/PHASE-CORRESPONDENCE-ASSIGNMENT-HISTORY-PRODUCT-DECISION.md
Message:         docs(reporting): close correspondence and assignment history product decisions
Commits:         1
#31 final class: DUPLICATE — ALREADY COVERED   (implementation-eligible: NO)
#32 final class: DEFERRED                      (implementation-eligible: NO)
```

STOP. No implementation was started for #31 or #32. Dashboard untouched. KPI
untouched. GAP-4 untouched. Waiting for the next explicit prompt.
