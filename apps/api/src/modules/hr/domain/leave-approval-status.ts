/**
 * Phase 54-E (§17, §18): the APPROVAL vocabularies — step status, instance status and the
 * resolution reason — stated ONCE, with no imports at all.
 *
 * WHY THREE VOCABULARIES IN ONE FILE
 * ----------------------------------
 * They are one fact about one object: "where does this step stand, and why did the flow put it
 * there?". Splitting them would let the step table and the instance table disagree about what
 * `COMPLETED` means, and the disagreement would be discovered by a support ticket rather than
 * by the compiler (the same reasoning `leave-status.ts` records for its own single table).
 *
 * WHY THIS FILE HAS NO IMPORTS
 * ---------------------------
 * A rule that needs a Nest container, a database or a request in order to be TESTED is a rule
 * that will not be tested. "May this step be decided?" is decided by three strings, so it is
 * decided here, in a file with no dependencies — which
 * `hr-application-boundaries.spec.ts` asserts mechanically rather than trusting.
 *
 * THE VOCABULARY IS CLOSED (§20). A status, a resolution reason or an availability signal
 * spelled anywhere else is a SECOND answer to a question this file already answers, and the
 * migration's CHECK plus the publish validation both press on the lists below.
 */

/**
 * Where ONE approval STEP stands. Exactly six members — §17's frozen step vocabulary.
 *
 *   PENDING   — configured, not yet activated (a predecessor has not reached its decision).
 *   ACTIVE    — awaiting exactly the resolved approver's decision. At most ONE per instance
 *               (§18), which the partial unique index enforces in the database rather than
 *               leaving to this file's callers.
 *   APPROVED  — decided positively. The decision reason is OPTIONAL.
 *   REJECTED  — decided negatively. The decision reason is MANDATORY (`decisionReason`), and
 *               the service is what refuses a blank one.
 *   SKIPPED   — the flow ended before this step needed a decision (a rejection upstream).
 *   CANCELLED — closed because the REQUEST was withdrawn. A withdrawal is not a rejection, so
 *               it does not produce `SKIPPED`.
 *
 * THERE IS DELIBERATELY NO `DELEGATED`, `ESCALATED`, `EXPIRED` OR `ON_HOLD`. §17.6 refuses
 * escalation, timeout and reminder outright: there is no scheduler in these layers, and a
 * member for a state nothing can reach is a promise with a column name rather than a
 * placeholder. A substitute is not a `DELEGATED` step — it is the SAME step with a different
 * resolved approver, which is why `SUBSTITUTE` is a RESOLUTION REASON and not a status.
 */
export type LeaveApprovalStepStatus =
  'PENDING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELLED';

/** The members, in the order the schema declares them. The wire vocabulary, spelled once. */
export const LEAVE_APPROVAL_STEP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'APPROVED',
  'REJECTED',
  'SKIPPED',
  'CANCELLED',
] as const;

/**
 * Where ONE approval INSTANCE stands. Exactly two members (§17).
 *
 *   ACTIVE    — routed, and no step has produced a terminal request state yet.
 *   COMPLETED — a step decided (the request reached APPROVED or REJECTED), OR the request was
 *               withdrawn. Terminal: an instance is never deleted and never rewritten, and
 *               re-routing is expressed as a NEW request rather than by reopening this one
 *               (§18.4).
 *
 * THERE IS DELIBERATELY NO `CANCELLED` MEMBER. A withdrawn flow has still ENDED, and giving
 * withdrawal its own instance state would create a second spelling of "this flow is over" —
 * the request's own `CANCELLED` already says which way it ended, and the STEP rows say which
 * steps were decided and which were not.
 */
export type LeaveApprovalInstanceStatus = 'ACTIVE' | 'COMPLETED';

/**
 * WHY a step's resolved approver is the person it is (§17.3).
 *
 *   PRIMARY         — a decider was resolved from the step's own configured approver.
 *   SUBSTITUTE      — the configured approver was unavailable under a stated signal and an
 *                     effective, exclusive substitution supplied exactly one replacement.
 *   NO_RESOLUTION   — nothing could be resolved. The step is still written (the configured
 *                     approver and the signals consulted are history worth keeping), but there
 *                     is NO resolved approver and therefore NOBODY who may decide it. This is
 *                     the fail-closed spelling: an unresolvable step blocks the flow rather
 *                     than silently approving, rejecting or routing to an arbitrary person.
 *
 * `NO_RESOLUTION` carries the typed availability outcome alongside it, so "why did this go
 * nowhere?" is answerable from history rather than reconstructed from current configuration.
 */
export type LeaveApprovalResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';

/** The members, in the order the schema declares them. */
export const LEAVE_APPROVAL_RESOLUTION_REASONS = [
  'PRIMARY',
  'SUBSTITUTE',
  'NO_RESOLUTION',
] as const;

/**
 * The terminal step states: a step here has an OUTCOME and is frozen by the storage guard.
 *
 * `SKIPPED` and `CANCELLED` are terminal too — they are how a flow that ended early records
 * that it ended — so the list is exactly the complement of the two live states.
 */
export const TERMINAL_LEAVE_APPROVAL_STEP_STATUSES = [
  'APPROVED',
  'REJECTED',
  'SKIPPED',
  'CANCELLED',
] as const satisfies readonly LeaveApprovalStepStatus[];

/**
 * The live step states: the two a step may be MOVED OUT OF by the routing engine.
 *
 * Listing them here rather than deriving them keeps the "at most one ACTIVE step" rule's
 * complement explicit — a step is either waiting its turn (`PENDING`) or being asked
 * (`ACTIVE`), and everything else is history.
 */
export const LIVE_LEAVE_APPROVAL_STEP_STATUSES = [
  'PENDING',
  'ACTIVE',
] as const satisfies readonly LeaveApprovalStepStatus[];

/** True for a value that is one of the six members — used to validate stored data. */
export function isLeaveApprovalStepStatus(value: unknown): value is LeaveApprovalStepStatus {
  return (
    typeof value === 'string' && (LEAVE_APPROVAL_STEP_STATUSES as readonly string[]).includes(value)
  );
}

/** True for a value that is one of the two members — used to validate stored data. */
export function isLeaveApprovalInstanceStatus(
  value: unknown
): value is LeaveApprovalInstanceStatus {
  return (
    typeof value === 'string' &&
    (LEAVE_APPROVAL_INSTANCE_STATUSES as readonly string[]).includes(value)
  );
}

/** True for a value that is one of the three resolution reasons — used to validate stored data. */
export function isLeaveApprovalResolutionReason(
  value: unknown
): value is LeaveApprovalResolutionReason {
  return (
    typeof value === 'string' &&
    (LEAVE_APPROVAL_RESOLUTION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * True when a step has reached an outcome that no later act may rewrite.
 *
 * Read by the service before a decision is attempted ("already decided" is a 409 rather than a
 * silent overwrite) AND mirrored by the storage guard, which is the guarantee that survives a
 * writer that bypasses this module entirely.
 */
export function isTerminalLeaveApprovalStepStatus(status: LeaveApprovalStepStatus): boolean {
  return (TERMINAL_LEAVE_APPROVAL_STEP_STATUSES as readonly string[]).includes(status);
}

/**
 * True when a step may still be asked for a decision — `ACTIVE`, and only `ACTIVE`.
 *
 * DERIVED FROM THE VOCABULARY RATHER THAN LISTED. "May this step be decided?" and "is this step
 * the one being asked?" are the same fact, so writing it twice is how the two spellings start
 * to disagree. §17.5 makes the consequence explicit: the resolved approver cannot decide a step
 * that is not `ACTIVE`, and the refusal writes no success audit event.
 *
 * `PENDING` is deliberately NOT decidable: a predecessor has not decided yet, and allowing a
 * later step to decide early would let the flow reach a terminal state out of order (§18.3).
 */
export function isDecidableLeaveApprovalStepStatus(status: LeaveApprovalStepStatus): boolean {
  return status === 'ACTIVE';
}

/** The members, in the order the schema declares them. */
export const LEAVE_APPROVAL_INSTANCE_STATUSES = ['ACTIVE', 'COMPLETED'] as const;

/**
 * The state every routed instance starts in. Never accepted from a caller.
 *
 * The instance is opened AT the moment the request is routed, and the first configured step is
 * activated in the SAME transaction — there is no window in which a routed request has no
 * `ACTIVE` step, because that window would be a request nobody is asked to decide.
 */
export const LEAVE_APPROVAL_INSTANCE_INITIAL_STATUS: LeaveApprovalInstanceStatus = 'ACTIVE';
/**
 * WHY THE ACTIVE STEP'S OWNER COULD NOT BE ASKED — the typed reason a read reports (§20, §27).
 *
 * A REASON, NOT AN EXCEPTION MESSAGE. The write path refuses with prose (`ForbiddenException`,
 * `ConflictException`) because a caller who attempted a decision is owed an explanation. A READ is
 * different: the browser renders it, compares nothing, and must not parse English to decide whether
 * to draw a button. So the read states the same two facts as members of a closed vocabulary, and the
 * header note above applies unchanged — a reason spelled anywhere else is a second answer.
 *
 *   NOT_RESOLVED   — no approver was resolved for the step, so NOBODY may decide it. This is
 *                    `NO_RESOLUTION` seen from the actor's side: the fail-closed block of §17.3.
 *   AWAITING_OTHER — a resolved approver owns it and it is not this actor.
 *
 * THERE IS DELIBERATELY NO `ALREADY_DECIDED`, `FLOW_CLOSED` OR `REQUEST_NOT_DECIDABLE`. Those are
 * facts about the INSTANCE or the REQUEST, and both are already on the wire as their own statuses
 * (`instance.status`, the request's `status`). A step-level reason restating them would let the two
 * representations disagree — and the UI reads the instance state to decide whether ANY decision is
 * possible at all, so a duplicate reason here would be a second, weaker authority for the same fact.
 */
export type LeaveApprovalUndecidableReason = 'NOT_RESOLVED' | 'AWAITING_OTHER';

/** The members, in the order this file declares them. */
export const LEAVE_APPROVAL_UNDECIDABLE_REASONS = ['NOT_RESOLVED', 'AWAITING_OTHER'] as const;

/**
 * The ONE implementation of "may this actor decide this step?" (§25.2).
 *
 * IT IS A PURE FUNCTION OF TWO FACTS, AND THAT IS THE POINT. Both the live-flow READ and the
 * decision WRITE call it, so the button an approver is shown and the check that actually protects
 * the decision cannot drift apart — the failure mode where the UI offers an action the server then
 * refuses, or withholds one it would have allowed. A second copy of this rule in the service, or in
 * the browser, is precisely the divergence this function exists to make impossible.
 *
 * WHAT IT DELIBERATELY DOES *NOT* TAKE:
 *
 *   * NO tenant, no actor identity, no role and no permission. "Does this actor hold
 *     `hr.leave.approve`?" is answered by the route guard, and §25.2 makes the two questions
 *     different: holding the permission is never "may decide THIS one". Folding permission in here
 *     would make the read claim an authority it does not own.
 *   * NO step status. Whether a step is `ACTIVE` is `isDecidableLeaveApprovalStepStatus`'s
 *     question, and the caller resolves the active step before asking. A status parameter would
 *     invite a caller to ask about a `PENDING` step and get a misleading `true`.
 *
 * `deciderEmployeeId` is null when the actor has no personnel record in this tenant — an HR
 * operator who is not an employee. Such an actor is not the resolved approver of anything, and
 * comparing null against a resolved id would make them the owner of a `null`-owned step, which is
 * why the null case is answered FIRST rather than left to the comparison.
 */
export function resolveLeaveApprovalDecisionability(input: {
  deciderEmployeeId: string | null;
  resolvedApproverEmployeeId: string | null;
}):
  | { decidableByActor: true; undecidableReason: null }
  | { decidableByActor: false; undecidableReason: LeaveApprovalUndecidableReason } {
  // NOBODY WAS ASKED. Reported before any comparison, so a null decider can never match a
  // null approver and appear to own an unresolvable step.
  if (!input.resolvedApproverEmployeeId) {
    return { decidableByActor: false, undecidableReason: 'NOT_RESOLVED' };
  }

  if (input.deciderEmployeeId !== input.resolvedApproverEmployeeId) {
    return { decidableByActor: false, undecidableReason: 'AWAITING_OTHER' };
  }

  return { decidableByActor: true, undecidableReason: null };
}

/**
 * The full answer to "may this actor decide?" — the two checks §25.2 ANDs together.
 *
 * The step's own status is checked here rather than in the caller so the read cannot report an
 * action on a step that is not being asked, and the decisionability rule stays the one above.
 */
export function mayDecideLeaveApprovalStep(input: {
  deciderEmployeeId: string | null;
  resolvedApproverEmployeeId: string | null;
  stepStatus: LeaveApprovalStepStatus;
}): { decidableByActor: boolean; undecidableReason: LeaveApprovalUndecidableReason | null } {
  if (!isDecidableLeaveApprovalStepStatus(input.stepStatus)) {
    return { decidableByActor: false, undecidableReason: null };
  }

  return resolveLeaveApprovalDecisionability(input);
}
