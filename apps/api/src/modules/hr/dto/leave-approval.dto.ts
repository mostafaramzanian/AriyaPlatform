import { IsString, MaxLength, MinLength } from 'class-validator';
import { TrimmedReason } from './attendance.dto';

/**
 * Phase 54-E (§18, §21, §25): the approval RUNTIME DTOs — the two bodies an approver sends.
 *
 * WHY THERE ARE TWO ROUTES RATHER THAN ONE WITH A `decision` FIELD
 * ---------------------------------------------------------------
 * `POST :id/approve` and `POST :id/reject` are separate routes because the DECISION IS THE URL,
 * and that is a security statement rather than a REST nicety. If one endpoint took a `decision`
 * field, then "may this actor APPROVE this request?" and "may this actor REJECT it?" would be the
 * SAME permission check — and a future policy that granted one and not the other would have
 * nowhere to live. The route is also what the audit trail names (§49) and what a Core permission
 * gates, so a decision that is not in the path is a decision that is not gated.
 *
 * The `decision` the service writes is therefore resolved from the ROUTE and passed in as a
 * parameter — never read from the body. A body that could name its own decision would let a
 * caller reach the rejection branch through the approval route.
 *
 * WHAT A DECISION CARRIES, AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------------------
 * The body states WHY the step was decided, and nothing else.
 *
 *   * NO `approverEmployeeId`. The decider is the ACTOR — the person whose login made the call —
 *     and the service resolves that actor to the employee who was actually ASKED (§25.2). Letting
 *     a body name the decider would make "who decided this?" a field a client can choose, which is
 *     the one fact a decision record exists to establish. It is also §16's rule: a client never
 *     sends an identity.
 *   * NO `stepOrder` / `stepInstanceId`. WHICH step is being decided is not a caller's choice
 *     either: the router knows which step is `ACTIVE`, and a body that could name a later step
 *     would let an approver decide out of turn — the exact hole `mayActivateStep` closes (§18.3).
 *     The service reads the live `ACTIVE` step and decides THAT one.
 *   * NO `decidedAt`. The instant is the server's, passed into the write as ONE value so the audit
 *     entry and the row state the same moment.
 *   * NO `requestStatus` / `instanceStatus`. What a decision does to the request and to the flow is
 *     `resolveDecisionOutcome`'s answer (§18.2), computed from the decided step's POSITION. A
 *     caller able to state the outcome could mark a request `APPROVED` from a step that is not the
 *     last — precisely the rule that function exists to state.
 *
 * WHY THERE ARE TWO CLASSES AFTER ALL, WHEN THE SHAPE IS ALMOST IDENTICAL
 * ---------------------------------------------------------------------
 * `RejectLeaveRequestDto.reason` is REQUIRED; `ApproveLeaveRequestDto.reason` is OPTIONAL. Both
 * facts come from the SAME contract — `LeaveApprovalStepInstance`'s header states that
 * `decisionReason` is "OPTIONAL for an approval, MANDATORY and non-blank for a rejection", and the
 * migration's CHECK refuses the stored shape a bypassing writer could otherwise produce.
 *
 * The classes follow the shape of the DATA. `reason` is required on the rejection class rather
 * than checked in the service, because "a refusal states why" is a fact about the BODY, which is
 * what a DTO is for; the rule is then visible in one place to whoever asks what a rejection may
 * contain. The service still refuses a blank reason, for the reason `CancelLeaveRequestDto`
 * documents — the database's CHECK is the guarantee and the 400 is the courtesy.
 *
 * `TrimmedReason` IS REUSED, not re-declared: it is the module's ONE spelling of "a trimmed,
 * non-blank reason", shared with `CancelLeaveRequestDto` and attendance's adjustment DTO. A second
 * spelling of trimming is how two records end up disagreeing about whether `'  '` is a reason.
 *
 * `MAX_LEAVE_DECISION_REASON_LENGTH` IS DECLARED HERE rather than reusing `leave.dto.ts`'s
 * `MAX_LEAVE_REASON_LENGTH`: the bound belongs to `decision_reason` (`varchar(500)`) and that
 * other constant belongs to `LeaveRequest.reason`. The two agree today; if either column widens,
 * they move independently, and this file is where a reviewer looks. One constant stated in terms
 * of another column is a fact about the wrong column.
 */

/** Upper bound matching `LeaveApprovalStepInstance.decision_reason` (`varchar(500)`) in `hr_db`. */
export const MAX_LEAVE_DECISION_REASON_LENGTH = 500;

/**
 * Approves the step that is currently `ACTIVE`: `POST /hr/leave-requests/:id/approve`.
 *
 * AN APPROVAL NEED NOT SAY WHY (§21). Requiring a reason here would invent a rule nobody agreed:
 * an approver who simply agrees has nothing to add, and forcing a sentence out of them would
 * produce boilerplate rather than evidence. `reason` is therefore OPTIONAL — but it is accepted,
 * because "approved, subject to X" is a legitimate thing for an approver to record, and the step's
 * own `decision_reason` column is where it belongs.
 *
 * The step that is decided is the LIVE `ACTIVE` step of the request's open flow, read by the
 * service. The caller never names it (see the header), which is what stops a later step being
 * decided out of turn.
 */
export class ApproveLeaveRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_DECISION_REASON_LENGTH)
  reason?: string;
}

/**
 * Rejects the step that is currently `ACTIVE`: `POST /hr/leave-requests/:id/reject`.
 *
 * A REFUSAL STATES WHY, and that requirement is the whole difference between this class and the
 * one above. The reason is MANDATORY and non-blank: `@TrimmedReason()` trims it FIRST, so `'   '`
 * reaches `@MinLength(1)` as `''` and is a 400 — rather than being written as an empty string that
 * would satisfy the database's `IS NOT NULL` CHECK while saying nothing.
 *
 * A rejection ENDS the flow wherever it stands (§18.2): the request becomes `REJECTED` and every
 * still-`PENDING` step is closed `SKIPPED`. The reason therefore travels with an act that has
 * consequences beyond this one step, which is a second reason to require it: there is no later
 * step at which an explanation could still be supplied.
 */
export class RejectLeaveRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_DECISION_REASON_LENGTH)
  reason!: string;
}
