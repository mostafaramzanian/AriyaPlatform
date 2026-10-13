# PHASE C4 — COMMERCE / PROCUREMENT
# GAP-3 — PURCHASE DOCUMENT `CLOSED` TRANSITION
# DISCOVERY RESULT: **BLOCKED BY CONTRACT** — NO IMPLEMENTATION PERFORMED

**Repository:** `E:\ERP` · **Phase:** C4 (discovery-first) · **Outcome:** the authoritative sources
establish the MEANING of purchase completion but do NOT state its **allowed source statuses**, its
**permission**, or its **prerequisites**; the phase therefore stopped before writing any code, exactly
as the C1 governance requires.

**Declared status:** `COMMERCE BACKEND PARTIALLY COMPLETE — GAP-3 BLOCKED BY CONTRACT`

**Authority, in order:** `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md` (§5.11, §22, §26, §29),
`docs/PHASE-C1-EXECUTION-PROMPT.md` (§13, §19), `docs/PHASE-C1-START-PROMPT.md`, then the step
contracts (M/N/O/P/Q/R/S), then `docs/PHASE-C2-…`, `docs/PHASE-C3-…`, `docs/PHASE-UI-0-…`,
`docs/PHASE-UI-5-…`. Code, schema and executable tests are evidence of what exists, never a source of
new business rules.

**THE STOP CITATION (not an interpretation).** The C1 execution prompt, §19 "STOP CONDITIONS —
AUTHORITATIVE §22", lists among the conditions that require stopping: *"**an unresolved
business-policy decision is required**"* and *"repository evidence contradicts the requested
implementation"* — and §22 S7 stops the phase that is *"about to invent a new pattern that is not
supported by"* the listed precedents. C4 hit the first of these on three counts (§E, §H, §D) and
stopped there rather than choosing a rule.

---

## A. DISCOVERY — WHAT WAS READ, AND WHAT WAS SEARCHED

**Read in full or in the cited regions:** `prisma/commerce/schema.prisma` (`PurchaseDocumentStatus`,
`PurchaseDocument`, `PurchaseLine`, and the whole document model's notes);
`purchase-status.ts` + `purchase-status.spec.ts`; `purchase.service.ts`, `purchase.repository.ts`,
`purchase.controller.ts`, `purchase.dto.ts`; `workflow-execution.service.ts`;
`commercial-lifecycle.service.ts` / `commercial-projection.ts` / `commercial-rule.ts`;
`payment-history.service.ts` + `payment-status.ts`; `receiving-history.service.ts` +
`receiving-status.ts`; `return-history.service.ts` + `return-lifecycle.ts`;
`commerce.module.ts`, `commerce-isolation.spec.ts`, `commerce-schema.spec.ts`;
`test/commerce-lifecycle.e2e-spec.ts`, `test/commerce-tenant.e2e-spec.ts`,
`test/commerce-integration.e2e-spec.ts`; and the documents listed under §B of the C3 contract plus
UI-0 §26-GAP-3 and the UI-5 gap table.

**Searched repository-wide (case-insensitive, one file never relied on):** `CLOSED`, `close`,
`closed`, `complete`, `completed`, `completion`, `finish`, `finished`, `archive`, `archived`,
`closedAt`, `completedAt`, `closeReason`, `completion actor`, `completion timestamp` — in
`apps/api/src`, `apps/api/test`, `apps/api/prisma/**` (schema + every migration), `docs/**`, and the
frontend surface (`apps/web/src`), so a UI-side expectation could be found if one existed.

**Result of the sweep (this is the whole of it):**

| Where `CLOSED` appears | What it is |
|---|---|
| `PurchaseDocumentStatus` enum (schema) + `PURCHASE_DOCUMENT_STATUSES` (pure tuple) | the VOCABULARY member; nothing more |
| `PURCHASE_DOCUMENT_TRANSITIONS` | `CLOSED: Object.freeze([])` — **no writer, deliberately absent (§11)** |
| `purchase-status.spec.ts` | a test that asserts **EVERY** route to `CLOSED` is refused: *"refuses EVERY route to CLOSED — §11 records completion as an unsolved owner question"* |
| C1 prompt §5.11 | the status list of the document lifecycle |
| C1 prompt §26 CASE B | an ILLUSTRATIVE lifecycle-independence example ("Commercial = CLOSED" beside "Purchase = IN_PROGRESS"), which the same section declares non-final ("The exact final enums may vary after preflight") |
| C1 prompt §29 | the definition of purchase COMPLETION (below) |
| P contract §11.1 | completion recorded as a STOP item, with *"Owner contract needed later: who may complete, from which statuses, with what guards."* |
| UI-0 §26-GAP-3 | *"precondition/permission/owner unspecified … APPROVED is the practical terminal until product defines closure"* |
| P/Q/R/S contracts | statements that completion is NOT payment/receiving/workflow completion and that no document status gates payment or receiving |

There is **no** `close`/`complete` service method, repository statement, controller route, DTO, error
code, permission coupling, migration column or test scenario anywhere in `apps/api`. There is **no**
`closedAt`/`closedBy`/`completedAt`/`completedBy` column. There is **no** frontend control (UI-0
forbids one until product defines closure, and the UI honesty suite enforces it).

---

## B. WHAT `CLOSED` MEANS — [CONFIRMED]

Source: C1 prompt §29 ("PURCHASE COMPLETION"), read verbatim; schema + `purchase-status.ts` notes.

1. **`CLOSED` is the state of an explicit business EVENT — completion — not a derived consequence.**
   §29: *"Purchase completion is a distinct business event"*, *"Final completion must be explicit"*,
   and *"Do not make completion a dangerous accidental one-click action."* The schema states the
   vocabulary's meaning: `CLOSED — the purchase has run its course`.
2. **Completion, when it happens, has these effects and ONLY these (§29):**
   - normal editing is locked;
   - the completion ACTOR is recorded;
   - the completion TIMESTAMP is recorded;
   - the completion state is persisted/projected;
   - history is preserved;
   - later payments continue on the same purchase.
3. **Completion is NOT any of the other lifecycles' completion** — stated three times in §29:
   *"Payment completion is NOT purchase completion. Receiving completion is NOT purchase completion.
   Workflow completion is NOT purchase completion."*
4. **`APPROVED` ≠ `CLOSED`** — P contract P11: *"`APPROVED` and `CLOSED` stay semantically distinct;
   workflow-approved never implies closed"*; and no projection closes a document.

## C. LIFECYCLE OWNER — [CONFIRMED]

The owner is the **`PurchaseDocument` commercial/document lifecycle** (`PurchaseDocument.status`,
§5.11), and nothing else. §5.11's three prohibitions (workflow state, payment state, receiving state)
and §29's three "NOT" statements close every other candidate. The workflow, payment, receiving and
return lifecycles stay separate — a separation the C2/C3 phases and the V-*/C2-* e2e scenarios already
prove from the other side.

## D. PREREQUISITES — [UNKNOWN] / [DECISION REQUIRED]

This is the first blocking unknown, and it is a deliberate gap, not an oversight:
`PURCHASE_DOCUMENT_TRANSITIONS`'s own comment says *"completion is an explicit business event whose
precondition, permission and owner no document in C1 states, so P records the gap rather than
inventing the edge"*; the P contract's §11.1 says *"states no completion precondition or
permission"*.

**What the source DOES forbid me to assume (each is an explicit non-rule):**

| Candidate prerequisite | Verdict from source |
|---|---|
| payment completion / full payment | **FORBIDDEN as an implication** — §29 "Payment completion is NOT purchase completion"; Q6 additionally makes payment independent and even allows payments on a CLOSED document |
| receiving completion / full receipt | **FORBIDDEN as an implication** — §29; R contract §3-I ("no document status gates receiving", reciprocally) |
| document-workflow completion | **FORBIDDEN as an implication** — §29; P11 ("workflow-approved never implies closed") |
| commercial approval | **FORBIDDEN as an implication** — P11/P12: commercial approval is its own lifecycle; APPROVED ≠ CLOSED |
| no open return / all returns resolved | **FORBIDDEN as an implication** — S contract §12: a return NEVER changes `PurchaseDocument.status`; no source ties closure to returns |
| line-level completion states | **FORBIDDEN as an implication** — §I18's "completion states" are per-LINE workflow/route states; no source maps them onto document closure |
| type-specific rules per `lineType` | nothing states any; `kind` is closed at `PURCHASE_REQUEST` |

**And what the source also does NOT say — the actual gap:** whether closure is permitted
**unconditionally** (any status an authorised actor names) or **conditioned** (some set of states and
facts). Neither reading may be adopted by a phase: choosing "unconditional" invents a rule as surely
as choosing "APPROVED-only" does.

## E. PERMISSION — [UNKNOWN] / [DECISION REQUIRED]

No source states which permission closes a document. It is not derivable from the permission names:
§10's catalogue comments justify each existing name by the routes that use it — `commerce.read` (all
reads), `commerce.manage` (documents + payments/receiving/returns writes), `commerce.approve`
(decisions), `commerce.configure` (configuration), `commerce.workflow.manage` (workflow version
lifecycle) — and none of them is stated to own completion. UI-0 §26-GAP-3 records exactly this:
*"precondition/permission/owner unspecified"*. Choosing one "by intuition" is what the C4 brief and
the C1 stop rules forbid.

## F. ACTOR — [CONFIRMED in part] / [DERIVED]

- **[CONFIRMED]** the completion actor must be RECORDED (§29), so the act has a server-resolved
  subject — exactly the module's `resolveCommerceActor(req)` → `{tenantId, userId, requestId, …}`
  pattern (no client-supplied identity, no client `tenantId`).
- **[UNKNOWN]** *who* may perform it (any member with the close permission? the requester? an
  approver? a holder of a yet-to-be-named capability?) — this is §E's gap seen from the actor side.
- **[CONFIRMED]** whether the acting user equals some other role on the row is NOT checkable today:
  the existing "actor rule" precedents use `resolvedApproverId` on workflow steps and
  `approverUserId` on commercial approvals; the document has no such column.

## G. TENANT MODEL — [CONFIRMED]

Identical to every Commerce route: the tenant comes from the authenticated actor/context and
structurally constrains every statement; `tenantId` first on every repository method; `findUnique`
never; a foreign id answers 404; a smuggled `tenantId` answers 422 under the production pipe. Nothing
about closure may relax this, and nothing needs to be decided here.

---

## H. THE EXACT TRANSITION — destination [CONFIRMED], source [UNKNOWN]

- **Source states — [UNKNOWN], and that is blocking.** The P contract's own recorded gap is the
  literal wording: *"Owner contract needed later: **from which statuses**"*. Neither the C1 prompt,
  the step contracts, the C2/C3 contracts, the UI contracts, the schema, the migrations nor any test
  names a source status for `→ CLOSED`. The `SUBMITTED → CLOSED` shape in the C4 brief is explicitly
  illustrative ("These examples are illustrative only") and may not be adopted. Candidate readings
  that all remain open: `APPROVED → CLOSED` only; `APPROVED | REJECTED | CANCELLED → CLOSED`
  (settling every terminal branch); or an unconditional act from any status — no source chooses.
- **Destination — [CONFIRMED]: `CLOSED`.** The enum member exists (no migration needed for the status
  itself); it is already in `PURCHASE_DOCUMENT_STATUSES` and in the schema.
- **The edge itself — [UNKNOWN] by rule.** `purchase-status.ts` states the discipline: *"an edge
  appears HERE only in the step that WRITES it"* and *"`→ CLOSED` IS DELIBERATELY ABSENT (§11)"*. So
  the edge may be added only by the phase that implements a writer together with a contract that
  defines that writer's source states — exactly what does not exist yet. `purchase-status.spec.ts`
  additionally PINNS the current absence (it fails today if any route to `CLOSED` exists), so adding
  an edge also means amending that test — legitimate only once the semantics are decided.
- **The writer — [CONFIRMED in shape, UNKNOWN in authority].** Document-status writes are deliberately
  narrow here: `purchase.repository.ts` holds `writeSubmitted` (DRAFT→SUBMITTED, conditional on
  `status: 'DRAFT'`) and `applyCommercialTransitionIn` (SUBMITTED→APPROVED|REJECTED, conditional on
  `status: 'SUBMITTED'`), both `updateMany` with a status predicate, pinned by the isolation suite as
  the ONLY document-status statements. A close writer would be a THIRD statement in that repository —
  the module's established pattern, once the contract names its predicate.

## I. HTTP SURFACE — [UNKNOWN] → NOT IMPLEMENTED

§14 of this brief forbids approving a path by shape (`POST …/close` — "THIS IS NOT APPROVED"), and no
contract names a route. What is established is only the *frame*: any close action would live on the
module's `commerce` prefix with the `purchase-documents` collection path ([DERIVED] from the five
existing purchase routes and the isolation suite's pinned surface), carry the full standard chain
(`@RequiresModule`/`@RequiresFeature`/entitlement/`JwtAuthGuard` + `resolveCommerceActor`), and declare
a `@Roles(...)` whose value is the §E decision. Nothing was added: `commerce-isolation.spec.ts` still
pins the 56-route / 9-controller surface exactly as C3 left it.

## J. REQUEST / RESPONSE — [UNKNOWN] → NOT SPECIFIED, NOT IMPLEMENTED

§29 requires the act to be *explicit* and to record actor + timestamp; it does not say whether the
body carries a confirmation flag, a reason/comment, or nothing. Every Commerce write precedent carries
the minimum its own domain states (submit: no body; commercial decision: `decision` + optional
comment; cancel: no body), and no source states which of those precedents completion follows. The
response shape (reloaded document vs `{id, status}` ack) is likewise unstated for this act.

## K. ERROR TAXONOMY — frame [DERIVED], codes [UNKNOWN]

If/when implemented, refusals would follow the module's established taxonomy: 401 (no principal), 403
(entitlement or missing permission), 404 (unknown or foreign id), 409 (invalid state — the
established Commerce answer for "this state cannot take that transition"), 422 (malformed body under
the production pipe). The **named code** for "document cannot be closed from this state" does not
exist anywhere and must not be invented: every Commerce 409 carries a named code
(`WORKFLOW_INSTANCE_NOT_RUNNING`, `WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED`,
`COMMERCIAL_INVALID_REASSIGNMENT`, …), and a new one is a vocabulary addition that belongs with the
decided contract.

## L. CONCURRENCY — mechanism [CONFIRMED], its predicate [PENDING the decision]

The module has ONE established state-concurrency mechanism and C4 would reuse it unchanged
[CONFIRMED]: a conditional `updateMany` whose `where` carries `{id, tenantId, status: <current>}`,
with `count === 0` reported as the established 409 rather than as success. That is how
`writeSubmitted`, `applyCommercialTransitionIn` and `updateEditableDocument` already behave, and the
schema records why no optimistic-version column exists (*"no C1 contract states a conflict response,
so the column would have no reader"*). Two racing closes would therefore produce exactly one winner
and one 409 **once the predicate is decided** — until then the predicate itself is the unknown, so no
write was added. No second concurrency strategy (locks, versions, queues) may be introduced.

## M. TERMINALITY / REVERSIBILITY — [UNKNOWN], with one important non-fact

- No source says `CLOSED` is terminal, none says it may be reopened, and none defines an outgoing
  edge of any kind. The empty `CLOSED: Object.freeze([])` row is **not** evidence of terminality: by
  this codebase's own rule it means only "no writer exists yet" — the very absence C4 investigated.
- **[CONFIRMED] what closure would NOT change:** §29 requires normal editing to be locked, and that is
  ALREADY satisfied structurally — `PURCHASE_DOCUMENT_EDITABLE_STATUSES = ['DRAFT']` plus the edit
  path's `status: 'DRAFT'` predicate mean a `CLOSED` document is uneditable for the same reason every
  non-DRAFT document is. Repeated-close refusal is [DERIVED] from the conditional-write pattern, but
  WHICH state answers it (already-CLOSED vs a state that can never close) depends on §H's unknown.

---

## N. INTERACTION WITH WORKFLOW — [CONFIRMED: independent]

- Closure is **NOT** a workflow transition and workflow completion is **NOT** a prerequisite
  [CONFIRMED]: §29's third "NOT" line; P11's "workflow-approved never implies closed"; §5.11's
  "Do not use this enum as workflow state".
- [CONFIRMED] C2's workflow HTTP (approve/decide/cancel) never writes `PurchaseDocument.status`, and
  the commercial projection — not the workflow — writes `SUBMITTED → APPROVED|REJECTED`. Closing
  therefore cannot be reached by deciding a run, and a `CLOSED` document does not move any
  `WorkflowInstance`.
- [DERIVED] because closure is an independent act, no relationship such as "close only a completed
  run" may be added later without a contract; that would be one of §D's forbidden implications.

## O. INTERACTION WITH PAYMENT — [CONFIRMED: independent, and explicitly open in both directions]

- [CONFIRMED] §29: *"later payments continue on the same purchase"* and *"Payment completion is NOT
  purchase completion"*; Q6 implements the reciprocal: **no payment is gated on the document's
  status at all** — a payment may be appended on any status including `CLOSED`.
- [CONFIRMED] closure must not write, create, compensate or validate a `PaymentRecord`; payment state
  is a read-time projection of append-only rows and stays an independent dimension.
- [CONFIRMED non-rule] "paid before closed" is NOT a source-defined prerequisite (§D).

## P. INTERACTION WITH RECEIVING — [CONFIRMED: independent]

- [CONFIRMED] §29: *"Receiving completion is NOT purchase completion"*; R §3-I: receiving never
  changes `PurchaseDocument.status` and no document status gates receiving.
- [CONFIRMED] closure must not write a `Receipt`/`ReceiptLine` or alter receiving history; receiving
  remains a read-time projection of append-only events.
- [CONFIRMED non-rule] "fully received before closed" is NOT a source-defined prerequisite (§D).

## Q. INTERACTION WITH RETURNS — [CONFIRMED: independent]

- [CONFIRMED] S §12: a return NEVER changes `PurchaseDocument.status`; a REJECTED return never
  rejects the parent; receive-back never marks the purchase completed — *"purchase completion stays
  §29's own guards"* (i.e., an owner contract that still does not exist).
- [CONFIRMED] closure must not write return rows or change any return's state; return state remains a
  read-time projection of its own history.
- [CONFIRMED non-rule] "no open return" is NOT a source-defined prerequisite (§D).

## R. MIGRATION — none performed; one would be REQUIRED by §29 if implementation proceeds

§29 requires the completion **actor** and **timestamp** to be recorded, and the schema has no such
columns today (searched: `closedAt`, `completedAt`, `completion*` — zero hits in
`prisma/commerce/**`). So a faithful implementation needs an **additive** migration (nullable
`closed`-actor/timestamp-style columns on `PurchaseDocument`, tenant-agnostic per the schema's
opaque-identity convention) — **but its shape is decided together with §D/§E, not before**. The status
enum itself already contains `CLOSED`, so no `ALTER TYPE … ADD VALUE` is needed. Default for C4:
**NO MIGRATION**, no `db push`, no historical edit.

## S. TESTS — none added; the existing executable pins are the deliverable of this phase

| Suite | What it proves today | C4 result |
|---|---|---|
| `purchase-status.spec.ts` | **every** route to `CLOSED` is refused (`toClosed === []`), the table is total, frozen and schema-joined | unchanged, green |
| `commerce-isolation.spec.ts` | the pinned 56-route / 9-controller surface contains **no** close route; only two document-status writers exist | unchanged, green (34/34) |
| `commerce-schema.spec.ts` | `PurchaseDocumentStatus` is the six-member vocabulary with `CLOSED` present, tenant-first, no `EXPENSE`-style drift | unchanged, green |
| `commerce-lifecycle.e2e-spec.ts` (V-*/C2-*/C3-*) | the five lifecycles move independently; payment/receiving/returns never move document status | unchanged, green (25/25) |
| frontend honesty suite (UI-5) | no "close/complete purchase" control may render while the backend defines no writer | untouched (no web file changed) |

No C4 scenario tests (C4-A…C4-F) were written: this phase's own rule is "do not test invented rules".

## T. EXPLICIT NON-RULES — what C4 did NOT do

- Did **not** add a `→ CLOSED` edge, a close writer, a close service method, a controller route, a
  DTO, a permission, an error code, a migration column, an audit/notification event or a test
  asserting any close behaviour.
- Did **not** treat any of the §D candidates as a prerequisite — including the *absence* of a
  prerequisite (unconditional close would itself be an invented rule).
- Did **not** choose a permission by intuition, reuse a neighbouring slice's permission, or introduce
  a new `commerce.*` name.
- Did **not** touch any other GAP, any frontend file, any other module, or any dependency; did not
  "clean up" unrelated code.

---

## U. UNKNOWN — every open item, one list

| # | Open question |
|---|---|
| U1 | **From which statuses may a document be closed?** (§H) |
| U2 | **Which permission (if any) authorises closure?** (§E) |
| U3 | **Are there prerequisites — and if so which?** (§D; "none" is also an undecided position) |
| U4 | **Is `CLOSED` terminal? May it be reversed/reopened?** (§M) |
| U5 | **May a REJECTED or CANCELLED document ever close**, and what would closing one mean? (§H) |
| U6 | **How is completion explicit on the wire** — confirmation flag, reason/comment, or a bare action? (§J) |
| U7 | **The named 409 code** for an illegal close. (§K) |
| U8 | **Column shape for the recorded completion actor + timestamp** (§R): names, nullability, whether existing rows may ever be closed retroactively. |
| U9 | **Audit/notification on completion** — §29 is silent; the module audits every configured write, but no source states this act's treatment. |
| U10 | **Is "explicit only" absolute** — i.e. may no other lifecycle ever trigger closure implicitly? §29 states completion must be explicit, but no source enumerates allowed implicit triggers either. |

## V. DECISION REQUIRED — the exact decisions, stated as OPTIONS ONLY

These are questions for the contract owner. **C4 chooses none of them.**

**D1 — allowed source status(es)** (unblocks U1, U5)
- Option A: `APPROVED → CLOSED` only (completion = "the positive decision has run its course").
- Option B: `APPROVED | REJECTED | CANCELLED → CLOSED` (every decision outcome can be settled).
- Option C: any status except `CLOSED` (an unconditional explicit act; §29's guard becomes the
  explicitness plus the permission alone).
- Option D: another set, stated by product.

**D2 — permission** (unblocks U2)
- Option A: reuse `commerce.manage` (the document-write remit: submit, payments, receiving, returns).
- Option B: reuse `commerce.approve` (the "decides the document" remit: commercial decisions).
- Option C: reuse `commerce.workflow.manage` (the lifecycle-management remit).
- Option D: a NEW `commerce.*` name — an additive Core permission migration that must be registered
  and recorded in a contract first; no source requests one today.

**D3 — prerequisites** (unblocks U3)
- Option A: none — closure is purely an authorised explicit act (consistent with §29's three NOTs, but
  not stated by §29).
- Option B: a stated set (e.g. document workflow terminal and/or commercial decision terminal) — it
  must be ENUMERATED by product; none may be inferred.

**D4 — terminality/reversibility** (unblocks U4): A terminal with no route out; B reversible with its
own edge + permission; C leave undecided and ship only D1–D3's act.

**D5 — wire shape** (unblocks U6, U7, U8): reason/comment field (commercial-decision style) vs bare
action (submit/cancel style); the completion columns' names; the named 409 code; document vs
`{id, status}` ack.

**D6 — audit/notification on completion** (unblocks U9): audit yes/no (module convention audits every
write through `CommerceAuditGateway`; D7 currently pins only the routing-configuration silence as a
measured exception); notification none of the current events covers completion.

---

## §29 OF THE C4 BRIEF — THE BLOCKING LIST

1. **Missing semantics:** (a) allowed source status(es) for `→ CLOSED`; (b) the authorising
   permission; (c) any prerequisites — plus the dependent items U4–U10.
2. **Why the source cannot establish them:** every authoritative document is *explicit about the gap*
   rather than merely silent — `purchase-status.ts` ("whose precondition, permission and owner no
   document in C1 states"), P contract §11.1 ("Owner contract needed later: who may complete, from
   which statuses, with what guards"), UI-0 §26-GAP-3 ("precondition/permission/owner unspecified …
   until product defines closure"), and C1 §29 (which defines the EVENT and its effects but no guard).
   The executable tests pin the *absence* of the edge, not semantics for it. Reading an example
   (§26 CASE B, or the brief's illustrative `SUBMITTED → CLOSED`) or a neighbouring slice's
   permission would be exactly the guessing this phase forbids, and the C1 execution prompt §19's
   STOP condition — *"an unresolved business-policy decision is required"* — applies verbatim.
3. **Exact decision needed:** D1, D2, D3 (blocking); D4, D5, D6 (before those rows can be closed).
4. **Affected APIs/models once resolved:** `PURCHASE_DOCUMENT_TRANSITIONS` (+ its spec pin);
   `purchase.repository.ts` (a third conditional document-status statement); `purchase.service.ts`
   (the act + audit); `purchase.controller.ts` (one route); `purchase.dto.ts` (body, if any);
   `PurchaseDocument` (§29's completion actor/timestamp columns → one additive migration);
   `commerce-isolation.spec.ts` (pinned surface and writer counts); `commerce-schema.spec.ts` (the
   frozen-vocabulary pin); the UI honesty suite's GAP-3 needle (in a later UI phase); a new named 409
   code; optionally an audit resource/action.
5. **Options:** see D1–D6 above. **No option is adopted by this phase.**

## §27 — PRE-CODING DECISION TABLE (as required)

| Question | Source evidence | Status |
|---|---|---|
| CLOSED owner | §5.11 + §29 + P11 — `PurchaseDocument.status`, document lifecycle | **[CONFIRMED]** |
| CLOSED meaning | §29 + schema note ("the purchase has run its course"; explicit event; actor+timestamp+state recorded; editing locked; history kept; later payments continue) | **[CONFIRMED]** |
| allowed source states | P §11.1 "from which statuses" left open; no other source | **[UNKNOWN]** |
| prerequisites | P §11.1 "no completion precondition"; §29 forbids the obvious candidates as implications; nothing states "none" | **[DECISION REQUIRED]** |
| actor | §29 must record the actor → server-resolved `resolveCommerceActor` | **[CONFIRMED]** pattern / **[UNKNOWN]** who may act |
| permission | UI-0 §26-GAP-3 "permission unspecified"; §10 names none | **[DECISION REQUIRED]** |
| terminal? | no source; an empty edge table is not terminality | **[UNKNOWN]** |
| reversible? | no source | **[UNKNOWN]** |
| workflow dependency | §29 "Workflow completion is NOT purchase completion"; P11 | **[CONFIRMED: none]** |
| payment dependency | §29 + Q6 (payments never gated; allowed on `CLOSED`) | **[CONFIRMED: none]** |
| receiving dependency | §29 + R §3-I (reciprocal independence) | **[CONFIRMED: none]** |
| return dependency | S §12 (returns never write parent status) | **[CONFIRMED: none]** |
| concurrency behavior | conditional `updateMany` + 409 (`writeSubmitted`, `applyCommercialTransitionIn`, `updateEditableDocument`) | **[CONFIRMED]** mechanism; this act's predicate pending |
| HTTP surface | no contract names one; brief §14 forbids approving by shape | **[UNKNOWN → not implemented]** |

## ACCEPTANCE CRITERIA (§28) — HONEST SCORECARD

- [x] lifecycle owner confirmed · [x] destination state confirmed · [x] actor pattern confirmed
  (server-resolved, recorded) · [x] workflow/payment/receiving/return relationships confirmed as
  independent · [x] nothing guessed and nothing implemented · [x] architecture/isolation green
  (unchanged) · [x] documentation complete · [x] no frontend redesign · [x] no unrelated GAP
  implemented · [x] regression suite passes (tree unchanged)
- [ ] authoritative CLOSED semantics found — **BLOCKED: source states are unknown**
- [ ] no guessed prerequisite/source-state/permission — **BLOCKED: any implementation would invent one**
- [ ] permission confirmed · [ ] terminality confirmed · [ ] reversibility confirmed ·
  [ ] THIS act's concurrency behaviour confirmed · [ ] production implementation exists ·
  [ ] HTTP surface exists · [ ] 401/403/404/409 verified for this act · [ ] real e2e close scenario ·
  [ ] repeated/stale scenario — **NOT APPLICABLE until D1–D6 are decided**

---

## FINAL STATUS

COMMERCE BACKEND PARTIALLY COMPLETE — GAP-3 BLOCKED BY CONTRACT




