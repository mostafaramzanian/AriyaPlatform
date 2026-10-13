/**
 * Phase 54-E (§18, §21): the ROUTING state machine — what a decision does to the flow — stated
 * ONCE, as a pure function of the states involved.
 *
 * WHY THE ROUTING OUTCOME IS COMPUTED HERE RATHER THAN WRITTEN AS `if`s IN THE SERVICE
 * ------------------------------------------------------------------------------------
 * The service has to answer four coupled questions in one transaction: what does the decided
 * step become, what does the request become, what does the instance become, and what happens to
 * the steps that have not been asked yet. Written as `if`s in a 400-line service, the answer to
 * the fourth is the one that gets forgotten — and a forgotten cascade is not a crash, it is a
 * flow that silently keeps a `PENDING` step behind a `REJECTED` request, which reads as though
 * somebody is still expected to decide something.
 *
 * So the outcome is a PURE FUNCTION with NO IMPORTS AT ALL, and the service executes what it
 * returns. `hr-application-boundaries.spec.ts` asserts that mechanically: its rule 3 requires the
 * `domain/` directory to import NOTHING, not merely "nothing unsafe", so a single sibling `import
 * type` would fail the build.
 *
 * THAT IS WHY THE VOCABULARIES BELOW ARE RE-DECLARED RATHER THAN IMPORTED. This file needs the
 * members of `LeaveRequestStatus`, `LeaveApprovalInstanceStatus` and `LeaveApprovalStepStatus`, and
 * the obvious move — a sibling `import type` — is exactly what rule 3 refuses. So the members this
 * rule engine can PRODUCE are stated here as literal unions, and the real vocabularies live in
 * `leave-approval-status.ts` and the leave-status module beside it. THE DUPLICATION IS THE PRICE OF
 * RULE 3, and it is a bounded price: these are three closed unions of string literals that §17
 * freezes, and the files are one directory apart. What rules out silent drift is not a comment but
 * the ONE-WAY ASSIGNMENT at every boundary — the service passes these values to `recordDecision` and
 * to the repository, whose parameters are typed with the real Prisma enums, so a member invented
 * here and absent there is a `tsc` error at the call site.
 *
 * WHAT IS NOT HERE, DELIBERATELY
 * ------------------------------
 * No database, no container, no clock, no audit and no permission. "Who may decide?" is an
 * authorization question (§25) and "has this already been written?" is a persistence question;
 * neither belongs in a function whose job is to state the SHAPE of the transition.
 */

/** Mirrors `LeaveRequestStatus`. Four members, because a decision or a withdrawal can reach all four. */
type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
/** Mirrors `LeaveApprovalInstanceStatus`: two members, and a decision can reach both. */
type LeaveApprovalInstanceStatus = 'ACTIVE' | 'COMPLETED';
/** Mirrors `LeaveApprovalStepStatus`. All six are reachable from this file's functions. */
type LeaveApprovalStepStatus =
  'PENDING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELLED';

/**
 * What the request becomes when a step decides.
 *
 * Its own type rather than a bare `LeaveRequestStatus`, because "the request stays PENDING"
 * and "the request is untouched by this act" are different statements — and a rejection at step
 * 2 of 5 must leave the request `PENDING` while still moving the INSTANCE to `COMPLETED`.
 */
export type LeaveRequestOutcome = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * What one not-yet-decided step becomes when the flow ends early.
 *
 * `SKIPPED`   — the flow ended because a step REJECTED. The step was never asked, and saying
 *               `CANCELLED` would blame the requester for a decision somebody else made.
 * `CANCELLED` — the flow ended because the REQUEST was withdrawn. Here `CANCELLED` is exactly
 *               right: the requester stopped the flow, so nothing was skipped around them.
 *
 * THE TWO ARE DISTINCT ON PURPOSE (§18.2). Collapsing them would make "was this request
 * withdrawn or refused?" require reading the request row — and an explanation rendered from the
 * step alone must answer that question by itself.
 */
export type LeaveApprovalCascadeOutcome = 'SKIPPED' | 'CANCELLED';
/**
 * The two things an approver may state, and the ONLY two (§18.2, D6).
 *
 * These are VERBS — `APPROVE` / `REJECT` — and deliberately not the statuses they produce
 * (`APPROVED` / `REJECTED`). The distinction is not cosmetic: a decision is an ACT, a status is
 * the STATE that act leaves behind, and one act produces states on THREE different rows at once
 * (the step's status, the request's status, the instance's status) which are not all the same word.
 * Spelling the intent `'APPROVED'` would invite `decision` and `stepStatus` to be treated as the
 * same field, and they are exactly the pair `recordDecision` types separately.
 *
 * The array is `as const` so the union below is derived from it rather than typed twice: adding a
 * member here is adding it everywhere, and a fourth member cannot appear without a reviewer seeing
 * it. §17.6 refuses delegation, escalation, timeout and reminders, so there is no third verb.
 */
export const LEAVE_REQUEST_DECISIONS = ['APPROVE', 'REJECT'] as const;

/** One approver's intent — the `decision` a route resolves and `resolveDecisionOutcome` reads. */
export type LeaveRequestDecision = (typeof LEAVE_REQUEST_DECISIONS)[number];

/**
 * The complete effect of ONE decision, as data.
 *
 * Returned rather than applied, so the service can perform the writes in ONE transaction and the
 * tests can assert the routing rules without a database connection.
 */
export interface LeaveApprovalDecisionOutcome {
  /** The decided step's new status: `APPROVED` or `REJECTED`. */
  stepStatus: 'APPROVED' | 'REJECTED';
  /** What the REQUEST becomes. `PENDING` means this decision did not end the flow. */
  requestOutcome: LeaveRequestOutcome;
  /** What the INSTANCE becomes. */
  instanceStatus: LeaveApprovalInstanceStatus;
  /**
   * The step that becomes `ACTIVE` next — `null` when the flow ended, when the decided step was
   * the last, or when there is no next step. The service reads it to perform the activation.
   */
  nextStepOrder: number | null;
  /** How every still-`PENDING` step is closed, or `null` when the flow continues. */
  cascade: LeaveApprovalCascadeOutcome | null;
}

/**
 * What the instance becomes when the request is WITHDRAWN mid-route (§18.3).
 *
 * `COMPLETED` rather than a third state, and the undecided steps become `CANCELLED` — a
 * withdrawal ends the flow without inventing an outcome for steps nobody asked. DECIDED steps
 * KEEP THEIR DECISIONS: a withdrawal is the REQUESTER's act, and it does not retroactively
 * un-say what an approver stated, which is why the cascade is scoped to still-`PENDING` steps.
 */
export interface LeaveApprovalWithdrawalOutcome {
  instanceStatus: 'COMPLETED';
  /** The status every still-`PENDING` step receives. */
  cascade: LeaveApprovalCascadeOutcome;
  /** `true` when a step had already reached `APPROVED`. */
  hadApproval: boolean;
}

/**
 * The decision outcome, computed from the DECIDED step's position — the whole routing rule.
 *
 * `decision` is the intent ('APPROVE' | 'REJECT'), `order` is the decided step's dense position,
 * `stepCount` is how many steps the instance has, and `hasNextStep` states whether a step at
 * `order + 1` exists as a row.
 *
 * THE THREE CASES, AND WHY EACH IS WHAT IT IS
 * -------------------------------------------
 *   REJECT                 → request `REJECTED`, instance `COMPLETED`, later steps `SKIPPED`.
 *                            A rejection ends the flow immediately: continuing would ask an
 *                            approver to decide a request that is already refused, and a
 *                            `PENDING` step behind a `REJECTED` request is an unanswered
 *                            question that nothing will ever answer.
 *   APPROVE, not last      → request STAYS `PENDING`, instance STAYS `ACTIVE`, next step
 *                            `ACTIVE`. §18.1: the next step activates in the SAME transaction,
 *                            so there is never a routed, undecided request with nobody asked to
 *                            decide it.
 *   APPROVE, last step     → request `APPROVED`, instance `COMPLETED`, no cascade. The last
 *                            approval is what makes the request approved; there is no separate
 *                            "finalize" act, because a second act is a second thing to forget.
 *
 * `hasNextStep` IS CHECKED RATHER THAN TRUSTED from `order < stepCount`: the two disagree only
 * for a malformed instance, and disagreeing silently is how a flow activates a step row that
 * does not exist (or ends a flow one step early). A `nextStepOrder` of `null` therefore means
 * "the flow is over", which is the safe reading.
 */
export function resolveDecisionOutcome(input: {
  decision: 'APPROVE' | 'REJECT';
  order: number;
  stepCount: number;
  hasNextStep: boolean;
}): LeaveApprovalDecisionOutcome {
  const { decision, order, stepCount, hasNextStep } = input;

  if (decision === 'REJECT') {
    return {
      stepStatus: 'REJECTED',
      requestOutcome: 'REJECTED',
      instanceStatus: 'COMPLETED',
      nextStepOrder: null,
      cascade: 'SKIPPED',
    };
  }

  // The guard is `order >= stepCount - 1` OR a missing successor row: EITHER is enough to end
  // the flow, so a malformed instance ends it rather than activating nothing and staying ACTIVE
  // forever.
  const isLastStep = !hasNextStep || order >= stepCount - 1;

  if (isLastStep) {
    return {
      stepStatus: 'APPROVED',
      requestOutcome: 'APPROVED',
      instanceStatus: 'COMPLETED',
      nextStepOrder: null,
      cascade: null,
    };
  }

  return {
    stepStatus: 'APPROVED',
    requestOutcome: 'PENDING',
    instanceStatus: 'ACTIVE',
    nextStepOrder: order + 1,
    cascade: null,
  };
}

/**
 * The withdrawal outcome — every still-`PENDING` step becomes `CANCELLED`.
 *
 * `pendingOrders` is passed so the caller does not have to pre-filter, and `approvedOrders`
 * states whether a step had already been decided. A step whose status is `APPROVED` or
 * `REJECTED` is history and is NOT in this list's remit. That scoping is the whole point —
 * §18.3 says decided steps keep their decisions — and expressing it as an input rather than a
 * filter at the call site is what makes it testable.
 */
export function resolveWithdrawalOutcome(input: {
  pendingOrders: readonly number[];
  approvedOrders: readonly number[];
}): LeaveApprovalWithdrawalOutcome {
  return {
    instanceStatus: 'COMPLETED',
    cascade: 'CANCELLED',
    hadApproval: input.approvedOrders.length > 0,
  };
}

/**
 * Whether a step at `order` may be activated, given the step that is currently `ACTIVE`.
 *
 * DENSE, SEQUENTIAL ACTIVATION (§18.1, §18.4): a step may be activated only when it is exactly
 * one position after the currently active one, or when there is no active step and it is the
 * FIRST still-pending position. "A later step cannot activate before its predecessor decided"
 * is therefore this function rather than a comment: activating step 3 while step 2 is active is
 * refused, and so is activating step 2 while step 1 is still `PENDING`.
 */
export function mayActivateStep(input: {
  order: number;
  activeOrder: number | null;
  pendingOrders: readonly number[];
}): boolean {
  const { order, activeOrder, pendingOrders } = input;

  if (activeOrder === null) {
    // No step is active: only the lowest still-pending position may be activated, which is what
    // keeps activation dense even after an unusual sequence of events.
    const lowestPending = [...pendingOrders].sort((a, b) => a - b)[0];
    return lowestPending === order;
  }

  return order === activeOrder + 1;
}

/**
 * The status a request must be in for a decision to be acceptable at all.
 *
 * Read by the service as ONE guard rather than a sprinkling of comparisons. A decision on a
 * request that is already `APPROVED`, `REJECTED` or `CANCELLED` is a 409: those states are
 * terminal, and "the second approval" is the failure this single constant prevents.
 */
export const DECIDABLE_LEAVE_REQUEST_STATUS: LeaveRequestStatus = 'PENDING';

/**
 * True when the instance is still open — the other half of "may this step be decided?".
 *
 * A `COMPLETED` instance is history: even if a step row somehow still reads `ACTIVE`, the flow
 * it belonged to is over, so no decision may be recorded against it.
 */
export function isOpenLeaveApprovalInstance(status: LeaveApprovalInstanceStatus): boolean {
  return status === 'ACTIVE';
}

/** Re-exported so a routing caller has one import for the states it reasons about. */
export type { LeaveApprovalStepStatus };
