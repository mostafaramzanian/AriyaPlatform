/**
 * Phase C1 Step L (§5.1, §5.2, §5.11, §8): the purchase document's commercial
 * lifecycle and the line vocabulary, as PURE data and pure functions.
 *
 * WHY A PURE MODULE AND NOT CONSTANTS INSIDE THE SERVICE
 * ------------------------------------------------------
 * The vocabularies below are the same strings `prisma/commerce/schema.prisma`
 * declares as enums, and three different callers need to agree on them: the DTO
 * validates against them (a 400 for `EXPENSE`, never a database error), the service
 * decides whether a document is editable and whether a transition is legal, and the
 * wire projection states the status back. A rule re-typed in the service is how
 * "DRAFT is editable" and "DRAFT may not be updated" both end up true.
 *
 * `MISSION_REQUEST_STATUSES` in `hr/domain/mission-status.ts` is the precedent: the
 * tuple is declared once, the DTO reads it with `@IsIn`, and the schema's enum is
 * linked to it by a spec rather than by hope. This file follows that shape, and
 * `purchase-status.spec.ts` reads the Prisma schema as TEXT and fails if the two ever
 * drift apart — no import can do that, because the schema is not a module.
 *
 * THIS FILE HAS NO DEPENDENCIES AT ALL — no NestJS, no Prisma, no repository, no
 * clock. That is what lets the rules be tested exhaustively, and it is why the service
 * can state a REFUSAL (a 409 naming the current status) instead of asking the database
 * to enforce a rule the database does not know.
 */

/**
 * The commercial lifecycle of a purchase DOCUMENT (§5.11), in the schema's order.
 *
 * DRAFT     — authored, still editable, not yet routed.
 * SUBMITTED — routed for decision; the document is in the workflow's hands.
 * APPROVED  — the document's decision was positive.
 * REJECTED  — the document's decision was negative.
 * CANCELLED — withdrawn before completion.
 * CLOSED    — the purchase has run its course.
 *
 * THIS IS NOT WORKFLOW STATE, NOT PAYMENT STATE, NOT RECEIVING STATE (§5.11's three
 * prohibitions). `WorkflowInstance.status` is its own lifecycle and payment state is
 * a projection of append-only history; neither is representable here, and nothing in
 * this file may grow to carry one.
 */
export const PURCHASE_DOCUMENT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const;

export type PurchaseDocumentStatus = (typeof PURCHASE_DOCUMENT_STATUSES)[number];

/**
 * The kinds of document §5.1 lets this database hold — closed at ONE member, which is
 * the specification's own state, not an omission: nowhere in C1 does a second
 * purchase-document kind appear.
 *
 * Declared here as well as in the schema because it is part of the NUMBERING KEY
 * (`tenantId`, `kind`, `jalaliYear`), and the formatter must map every kind to its own
 * prefix — a second kind sharing the first one's series would mint a duplicate
 * `documentNumber`. Keeping the union total is what makes that mapping checkable by
 * the compiler rather than by a comment.
 */
export const PURCHASE_DOCUMENT_KINDS = ['PURCHASE_REQUEST'] as const;

export type PurchaseDocumentKind = (typeof PURCHASE_DOCUMENT_KINDS)[number];

/**
 * The line vocabulary (§5.2), closed at its three members — the specification's own
 * list, and the reason `EXPENSE` is refused at the DTO rather than stored and
 * explained later.
 *
 * All three may appear in ONE document: §5.2's example carries STANDARD, NON_STANDARD
 * and SERVICE lines, which is exactly why the type is a column per line and never a
 * flag on the document.
 */
export const PURCHASE_LINE_TYPES = ['STANDARD', 'NON_STANDARD', 'SERVICE'] as const;

/** One line's kind (§5.2), derived from the tuple above rather than written twice.
 *
 * Exported as a TYPE so the repository's line-write shape and the DTO's `lineType` field
 * can both name it: the column is an enum in `commerce_db`, the DTO validates against the
 * tuple and the repository writes the value through, so all three read the same union
 * rather than each re-stating `'STANDARD' | 'NON_STANDARD' | 'SERVICE'`. `as const` on
 * the tuple is what makes this a union of literals instead of `string`, which is what
 * lets the DTO's `@IsIn(PURCHASE_LINE_TYPES)` and the column type agree: a value that
 * validates cannot be one the database would refuse.
 */
export type PurchaseLineType = (typeof PURCHASE_LINE_TYPES)[number];

/**
 * The statuses in which a document's content may still be changed — ONE member.
 *
 * WHY ONLY `DRAFT`: §8 asks for "update while editable", and the moment a document is
 * SUBMITTED its lines are the evidence a decision is being taken on. Editing them
 * afterwards would rewrite what an approver is looking at, which §5.3 refuses in the
 * same terms it refuses erasing line history. "Return for correction" is a workflow
 * outcome that puts a document BACK into the editable set deliberately (step N) —
 * it is not a licence for the update route to bypass the workflow.
 *
 * The tuple exists so the rule has ONE definition: `isPurchaseDocumentEditable` is
 * what the service asks, and the wire projection's `editable` flag is the same
 * function, so the flag a client renders can never disagree with the guard that
 * refuses its next PATCH.
 */
export const PURCHASE_DOCUMENT_EDITABLE_STATUSES = ['DRAFT'] as const;

export type PurchaseDocumentEditableStatus = (typeof PURCHASE_DOCUMENT_EDITABLE_STATUSES)[number];

/** Whether a document in this status may still be changed. */
export function isPurchaseDocumentEditable(
  status: PurchaseDocumentStatus
): status is PurchaseDocumentEditableStatus {
  return (PURCHASE_DOCUMENT_EDITABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The legal commercial transitions, as a TOTAL table over the vocabulary.
 *
 * WHY EVERY MEMBER IS A KEY, AND WHY ALL BUT ONE EDGE IS EMPTY. The table is total so
 * that adding a status to the tuple is a compile error here rather than an
 * unreachable state nobody thought about. The EDGES are the other half of the same
 * discipline, and it is the rule the schema records for the enum itself: an edge
 * appears HERE only in the step that WRITES it. Step L writes exactly one —
 * DRAFT → SUBMITTED, through the submit route — so exactly one edge exists today.
 * Decisions (SUBMITTED → APPROVED / REJECTED), withdrawal (→ CANCELLED) and
 * completion (→ CLOSED, §29) are written by the steps that own them (N and P), and
 * each adds its own edge together with the code that reaches it. An edge declared
 * early would describe a transition no writer performs and no test can falsify.
 *
 * A `Readonly<Record<…>>` rather than a `Map`: the vocabulary is closed and known at
 * compile time, so a lookup that misses is a compile error, not a runtime branch.
 *
 * STEP P ADDS TWO EDGES AND NO OTHERS (§3-F): `SUBMITTED → APPROVED` and
 * `SUBMITTED → REJECTED`, written by the ONE commercial projection writer when the
 * pinned policy says so. They are declared HERE, beside the code that reaches them, and
 * nowhere else: a fourth edge would describe a transition no writer performs.
 *
 * `→ CLOSED` IS DELIBERATELY ABSENT FROM THIS STATIC TABLE, AND REMAINS SO AFTER PHASE C4-R.
 * Completion (C1 §29) is not an unconditional edge: it is permitted only when the tenant's
 * PUBLISHED Purchase Completion Policy names the document's current status among its
 * `allowedFromStatuses`. An edge here would claim a legality the policy decides, so the
 * policy-driven act has its own evaluator below (`canCompletePurchaseDocument`) and its own
 * writer in `purchase.repository.ts`. What the table still guarantees is that NOTHING ELSE
 * reaches `CLOSED`: `APPROVED` never becomes `CLOSED` by projection, and no other status does.
 */
export const PURCHASE_DOCUMENT_TRANSITIONS: Readonly<
  Record<PurchaseDocumentStatus, readonly PurchaseDocumentStatus[]>
> = Object.freeze({
  DRAFT: Object.freeze(['SUBMITTED'] as const),
  SUBMITTED: Object.freeze(['APPROVED', 'REJECTED'] as const),
  APPROVED: Object.freeze([] as const),
  // REACTIVATION (GAP-6 follow-up): the ONE route out of REJECTED, written ONLY by the
  // reopen act (`POST …/purchase-documents/:id/reopen`). The rejection itself is never
  // erased — it stays on the settled workflow instance and in the audit trail — and the
  // reopened document lands back in DRAFT, the one editable status, from which a fresh
  // submit starts a fresh approval round. CANCELLED and CLOSED deliberately have no
  // outgoing edge: withdrawal and completion are one-way.
  REJECTED: Object.freeze(['DRAFT'] as const),
  CANCELLED: Object.freeze([] as const),
  CLOSED: Object.freeze([] as const),
});

/** Whether the commercial lifecycle permits `from → to`. */
export function canTransitionPurchaseDocument(
  from: PurchaseDocumentStatus,
  to: PurchaseDocumentStatus
): boolean {
  return PURCHASE_DOCUMENT_TRANSITIONS[from].includes(to);
}

/**
 * PHASE C4-R — THE COMPLETION VOCABULARY (C1 §29, the C4 contract's D1 gap).
 *
 * THE DESTINATION IS FIXED AND IS NOT CONFIGURABLE: completion means `CLOSED`, the member
 * §5.11 already declares ("the purchase has run its course"). A policy selects SOURCES; it
 * never invents a destination.
 */
export const PURCHASE_COMPLETION_TARGET_STATUS = 'CLOSED' as const;

/**
 * THE STATUSES A COMPLETION POLICY MAY NAME — every member of §5.11's vocabulary except the
 * destination itself, in the vocabulary's own order.
 *
 * WHY "EVERYTHING BUT `CLOSED`" IS NOT A BUSINESS DECISION. It is a structural fact of the
 * lifecycle: a document that is already `CLOSED` cannot be completed a second time (the
 * table above refuses every self-transition, and the repeated-close question has the
 * module's established 409 answer), so `CLOSED` is the one member no policy can name. WHICH
 * of the five candidates a tenant allows is NOT decided here — that is precisely the choice
 * C4 could not make for the product and C4-R makes configurable instead. `DRAFT`,
 * `SUBMITTED`, `APPROVED`, `REJECTED` and `CANCELLED` are all legal policy inputs; the
 * source never ranked them, and neither does this file.
 */
export const PURCHASE_COMPLETION_SOURCE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type PurchaseCompletionSourceStatus = (typeof PURCHASE_COMPLETION_SOURCE_STATUSES)[number];

/**
 * Whether a status may APPEAR in a policy's `allowedFromStatuses`. This is the allowlist the
 * DTO validates against (an unknown member or `CLOSED` is refused at the boundary), the
 * publish checklist re-checks against the stored row, and the completion evaluator applies
 * before it reads the set — one definition, three callers.
 */
export function isPurchaseCompletionSourceStatus(
  status: string
): status is PurchaseCompletionSourceStatus {
  return (PURCHASE_COMPLETION_SOURCE_STATUSES as readonly string[]).includes(status);
}

/**
 * WHETHER A DOCUMENT IN `from` MAY BE COMPLETED UNDER A POLICY THAT ALLOWS
 * `allowedFromStatuses` — the completion act's ONE pure rule.
 *
 * BOTH HALVES ARE NECESSARY. The status must be a legal SOURCE at all (the allowlist above,
 * so a stored set that somehow names `CLOSED` or an unknown string can never authorise
 * anything), and the policy must actually NAME it (the tenant's configured choice). The
 * caller resolves the policy; this function never reads a database, a clock or a request.
 *
 * NOTHING ELSE IS A PREREQUISITE, AND THAT IS DELIBERATE. C1 §29 states that payment,
 * receiving and workflow completion are NOT purchase completion, and no C1/C2/C3 document
 * establishes any of them — or returns, or the commercial lifecycle — as a completion
 * precondition. C4-R therefore exposes NO prerequisite dimension: payment state, receiving
 * state, workflow run state and return state are read nowhere in this rule, because a
 * condition the source never sanctions must not become a configurable one.
 */
export function canCompletePurchaseDocument(
  from: PurchaseDocumentStatus,
  allowedFromStatuses: readonly string[]
): boolean {
  return isPurchaseCompletionSourceStatus(from) && allowedFromStatuses.includes(from);
}
