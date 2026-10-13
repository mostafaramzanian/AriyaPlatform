/**
 * Phase PRODUCTION-BOM-HEADER: the BOM HEADER's own lifecycle, as PURE data and pure
 * functions — no NestJS, no Prisma, no repository, no clock, no HTTP.
 *
 * WHY A PURE MODULE AND NOT RULES INSIDE THE SERVICE
 * -------------------------------------------------
 * The vocabulary below is the same strings `prisma/production/schema.prisma` declares as
 * enums, and four different callers need to agree on them: the DTO validates against
 * them (a 400 for `DRAFTY`, never a database error), the service decides whether a
 * transition is legal, the controller returns the status back, and the tests pin the
 * whole graph. A rule re-typed in the service is how "DRAFT is editable" and "DRAFT may
 * not be submitted twice" both end up true.
 *
 * `PURCHASE_DOCUMENT_STATUSES` in `purchase/purchase-status.ts` is the precedent,
 * adopted rather than reinvented; `mission-status.ts` in HR is the same shape.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The STATUS vocabulary, the EDITABLE predicate, the TRANSITION guard, and the Persian
 * labels for the three legacy decision values.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 * ---------------------------------
 *  * No BOM ITEM rules. "A BOM must have items before it can be submitted" is a rule of
 *    the ITEM aggregate, and the item aggregate does not exist yet. The submit gate is
 *    therefore DEFERRED — and, crucially, this file does NOT fake item existence: there
 *    is no `hasItems` flag, no placeholder and no always-true placeholder rule. When
 *    `BomItem` lands, the gate returns `submitBlockedByMissingItems` and this module
 *    gains one predicate.
 *  * No approver identity rule. "Is this actor the approver?" needs the row; see
 *    `bom.service.ts`, which is where the tenant and the directory contract live.
 *  * No workflow. This is a state machine on ONE row (M-5 Option A), not an engine.
 */

/**
 * The BOM header's business lifecycle, in the schema's order (M-5 Option A).
 *
 * DRAFT      — authored and editable; the requester may change header fields.
 * SUBMITTED  — routed to the snapshotted approver; ordinary editing is frozen.
 * APPROVED   — the stored approver's decision was positive.
 * REJECTED   — the stored approver's decision was negative.
 *
 * CORRECTION IS NOT A STATE: the legacy approval task's `نیاز به اصلاح` branch wrote
 * `State = 0`, i.e. it returned the document to the EDITABLE state. `requestCorrection`
 * below moves `SUBMITTED → DRAFT` and records the decision, which distinguishes
 * "returned for correction" from "never submitted" without inventing a state the source
 * does not have.
 */
export const BOM_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type BomStatus = (typeof BOM_STATUSES)[number];

/**
 * The approver's decision, in the legacy vocabulary, preserved exactly (M-5b).
 *
 * The legacy `RadioButtons` control offered `تایید;رد;نیاز به اصلاح`, and these three
 * code points are the same three facts in the schema's own enum. The LABELS below are
 * what the wire renders — the same shape `commerce-labels.ts` uses for a status the API
 * states in English and the screen shows in Persian.
 */
export const BOM_MANAGER_OPINIONS = ['APPROVED', 'REJECTED', 'NEEDS_CORRECTION'] as const;

export type BomManagerOpinion = (typeof BOM_MANAGER_OPINIONS)[number];

export const BOM_MANAGER_OPINION_LABELS: Record<BomManagerOpinion, string> = {
  APPROVED: 'تایید',
  REJECTED: 'رد',
  NEEDS_CORRECTION: 'نیاز به اصلاح',
};

/**
 * Which transitions this phase implements, one per row.
 *
 * The `from` is the ONLY state the route accepts, so a second call on an already-decided
 * BOM is a refusal naming the current status rather than a silent no-op, and a transition
 * nobody has declared cannot be reached by writing a status field (no route accepts one).
 */
export const BOM_TRANSITIONS = {
  SUBMIT: 'DRAFT',
  APPROVE: 'SUBMITTED',
  REJECT: 'SUBMITTED',
  REQUEST_CORRECTION: 'SUBMITTED',
} as const satisfies Record<string, BomStatus>;

/**
 * A header may be edited only while it is a DRAFT (M-5: `submit` freezes it).
 *
 * APPROVED and REJECTED are terminal in this phase: nothing in the source re-opens a
 * decided BOM, and a route that could would have to be justified by a contract nobody
 * has written yet.
 */
export function isBomHeaderEditable(status: BomStatus): boolean {
  return status === 'DRAFT';
}

/**
 * Whether `next` is reachable from `current`.
 *
 * The map is EXPLICIT rather than computed: five entries in a table is a list a reader
 * can check, whereas a generalised rule ("any to any but one") invites a future reader
 * to conclude that `APPROVED → DRAFT` is legal because nothing says no.
 */
export function canTransitionBomHeader(current: BomStatus, next: BomStatus): boolean {
  switch (next) {
    case 'SUBMITTED':
      return current === 'DRAFT';
    case 'DRAFT':
      return current === 'SUBMITTED';
    case 'APPROVED':
    case 'REJECTED':
      return current === 'SUBMITTED';
    default:
      return false;
  }
}

/**
 * The status a transition lands on, or `null` when `current` does not permit it.
 *
 * Returning `null` rather than throwing keeps this a predicate: the service is where the
 * refusal becomes a 409 with the current status attached, so the HTTP vocabulary stays
 * out of a pure module.
 */
export function bomStatusAfter(
  current: BomStatus,
  action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'REQUEST_CORRECTION'
): BomStatus | null {
  const next: BomStatus =
    action === 'APPROVE'
      ? 'APPROVED'
      : action === 'REJECT'
        ? 'REJECTED'
        : action === 'SUBMIT'
          ? 'SUBMITTED'
          : 'DRAFT';

  return canTransitionBomHeader(current, next) ? next : null;
}
