/**
 * Phase 51-HR-3A: the leave REQUEST lifecycle — PENDING -> CANCELLED, stated ONCE.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `prisma/hr/schema.prisma` names this file in the maintenance contract for whoever adds
 * approval, and the contract is worth writing down only if there is ONE file that holds the
 * transitions: the enum member, `LeaveRequest_cancelled_state_check` in the migration, the
 * table below, the permission that gates the new route and its Core seed row must all move
 * TOGETHER. Otherwise a new state is unreachable — or, worse, the table here silently
 * disagrees with the database and the disagreement is discovered by a support ticket. It is
 * the same role `letter-status.util.ts` plays for correspondence, for the same reason.
 *
 * WHY IT IMPORTS NOTHING
 * ----------------------
 * A rule that needs a Nest container, a database or a request in order to be TESTED is a
 * rule that will not be tested. "May this request be withdrawn?" is decided by two strings,
 * so it is decided here, in a file with no dependencies at all — which
 * `hr-application-boundaries.spec.ts` asserts mechanically rather than trusting.
 *
 * WHY PENDING AND CANCELLED ARE THE ONLY MEMBERS
 * ----------------------------------------------
 * There is no authoritative approval rule in this repository: the readiness audit sketches
 * "approve/reject for the reporting subtree" and that traversal does not exist. A decision
 * state nobody can legitimately write is not a placeholder, it is a lie with a column name.
 * So the ONE transition that needs no new policy is the one implemented here — a pending
 * request is WITHDRAWN by the operator who holds the tenant's leave permission — and
 * APPROVED / REJECTED arrive later with their authority, their permission and their seed
 * row, in one change. `hr.leave.manage` already gates the withdrawal, so no new permission
 * is claimed for authority this phase does not have.
 */

/**
 * Where a leave request stands. FOUR members, exactly as `LeaveRequestStatus` in `hr_db`.
 *
 *   PENDING   — recorded, and nothing further has happened to it. The only state a create
 *               can produce.
 *   APPROVED  — a routed flow reached its LAST step, and that step approved (Phase 54-E §21).
 *               TERMINAL.
 *   REJECTED  — a step in the flow rejected (Phase 54-E §21). TERMINAL, whether or not it was
 *               the last step: a refusal ends the flow where it stands. The step's
 *               `decisionReason` is MANDATORY and travels with the decision, not with the
 *               request — see the schema note on why no decision column exists on `LeaveRequest`.
 *   CANCELLED — withdrawn before any decision, or withdrawn mid-route. TERMINAL.
 */
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** The members, in the order the schema declares them. The wire vocabulary, spelled once. */
export const LEAVE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

/** The state every create produces. Never accepted from a caller — see the DTO. */
export const LEAVE_REQUEST_INITIAL_STATUS: LeaveRequestStatus = 'PENDING';

/**
 * The transition table — THE rule, and the only place it is written.
 *
 * A TERMINAL STATE HAS AN EMPTY LIST rather than being absent from the record: a state that
 * is missing from the table and a state whose list is empty would otherwise both mean "no
 * way out", and one of them means "nobody added it yet". `APPROVED`, `REJECTED` and
 * `CANCELLED` are all listed and empty, so "a decided request cannot be re-decided" is a
 * statement this file makes rather than a statement it fails to make.
 *
 * WHY APPROVED AND REJECTED SHARE ONE SOURCE RATHER THAN TWO
 * ---------------------------------------------------------
 * Both are reached from `PENDING` and from nowhere else. The DIFFERENCE between them is not a
 * property of this table but of the FLOW: `APPROVED` requires the LAST step to approve, while
 * `REJECTED` may come from any step. That distinction is the routing rule's, stated in
 * `leave-approval-routing.ts`, and this table deliberately does not try to spell it twice — a
 * table cannot see the flow, so a table that claimed to decide it would be wrong about the
 * interesting case.
 */
export const LEAVE_REQUEST_STATUS_TRANSITIONS: Readonly<
  Record<LeaveRequestStatus, readonly LeaveRequestStatus[]>
> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** True for a value that is one of the four members — used to validate stored data. */
export function isLeaveRequestStatus(value: unknown): value is LeaveRequestStatus {
  return typeof value === 'string' && (LEAVE_REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether `from` may become `to`.
 *
 * A no-op is REFUSED (`PENDING -> PENDING` is false): re-stating a request's state is not a
 * transition, and answering "yes" here would let a caller write a second audit event for an
 * act that did not happen.
 */
export function canTransitionLeaveRequest(
  from: LeaveRequestStatus,
  to: LeaveRequestStatus
): boolean {
  return LEAVE_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

/** True when no transition leaves this state — `APPROVED`, `REJECTED` and `CANCELLED`. */
export function isTerminalLeaveRequestStatus(status: LeaveRequestStatus): boolean {
  return LEAVE_REQUEST_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Whether the request's own content may still be restated (its days, type or reason).
 *
 * DERIVED FROM TERMINALITY RATHER THAN LISTED SEPARATELY. "Restatable" and "not terminal"
 * are the same fact about all four states, and writing the fact twice is how the two
 * spellings start to disagree; the derivation also stayed correct on the day `APPROVED`
 * arrived, because a decided request is terminal and therefore not restatable. The schema
 * states the consequence: a decided request is never edited in place — a correction is a
 * NEW request, which is what keeps the flow's history intact.
 */
export function isLeaveRequestRestatable(status: LeaveRequestStatus): boolean {
  return !isTerminalLeaveRequestStatus(status);
}
