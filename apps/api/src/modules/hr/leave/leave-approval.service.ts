import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeaveApprovalRepository } from './leave-approval.repository';
import { LeaveRepository } from './leave.repository';
import { EmployeeRepository } from '../employees/employees.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  DECIDABLE_LEAVE_REQUEST_STATUS,
  isOpenLeaveApprovalInstance,
  resolveDecisionOutcome,
  resolveWithdrawalOutcome,
  type LeaveRequestDecision,
} from '../domain/leave-approval-routing';
import {
  isDecidableLeaveApprovalStepStatus,
  resolveLeaveApprovalDecisionability,
  type LeaveApprovalStepStatus,
} from '../domain/leave-approval-status';

/**
 * Phase 54-E (§18, §21, §25): the DECISION application service — who may decide a step, what a
 * decision does to the flow, and what the platform is told about it.
 *
 * WHY THIS IS A THIRD SERVICE RATHER THAN MORE METHODS ON `LeaveService`
 * -------------------------------------------------------------------
 * `LeaveService` owns the REQUEST: what was asked for, over which days, and whether it may still be
 * restated. A decision is a different act by a different actor on a different object — a STEP — and
 * the two share nothing but a foreign key. §18 is explicit that the runtime rows have their own
 * lifecycle (never rewritten, §17.6) and that a decision is recorded against the STEP, not the
 * request; putting `decide()` on `LeaveService` would make that file the place where "somebody asked
 * for leave" and "somebody refused it" are the same kind of statement.
 *
 * The boundary guards agree, and their agreement required a deliberate edit rather than passing
 * silently: both `hr-application-boundaries.spec.ts` (the service inventory) and
 * `hr-isolation.spec.ts` (the audit inventory) assert their file sets EXACTLY, so this file's
 * arrival is a reviewed change to two guards. That is the point of an exact assertion — a new
 * service is never an accident.
 *
 * WHAT THIS SERVICE OWNS, AND WHERE EACH RULE ACTUALLY LIVES
 * --------------------------------------------------------
 * It owns ORDER and the HTTP meaning of an empty read. It owns NO routing rule: every "what happens
 * next" question is answered by `domain/leave-approval-routing.ts`, and every "may this person
 * decide this step" question by the check below. The writes are the repository's.
 *
 *   * WHICH STEP IS DECIDED is READ, never sent — the live flow's `ACTIVE` step. A caller naming a
 *     later step would decide out of turn, which `mayActivateStep` exists to prevent (§18.3; the
 *     DTO header states the same thing from the wire's side).
 *   * WHO DECIDES is the ACTOR, resolved to an `Employee` of this tenant (§25.2). A body naming the
 *     decider would make "who decided this?" a client-chosen fact. The resolution has THREE
 *     refusals and each says something different: no login cannot decide anything; a login with no
 *     personnel record is not an employee here; and an employee who is not the RESOLVED approver of
 *     THIS step is not entitled to it even holding `hr.leave.approve` — §25.2's whole content, and
 *     the reason "has the permission" is never "may decide this one".
 *   * WHAT THE DECISION DOES is `resolveDecisionOutcome`'s answer, computed from the decided step's
 *     POSITION and the instance's snapshotted `stepCount`. A rejection ends the flow wherever it
 *     stands and the still-`PENDING` steps become `SKIPPED`; an approval that is not last leaves the
 *     request `PENDING`, the instance `ACTIVE`, and activates the next step IN THE SAME TRANSACTION
 *     (§18.1). None of that is re-derived here.
 *   * A WITHDRAWAL OF A ROUTED REQUEST closes the flow too (§18.3), so `closeOnWithdrawal` is here
 *     rather than in `LeaveService`: the cascade is a fact about the INSTANCE, and a withdrawal is
 *     the only thing that closes a flow without a decision. DECIDED STEPS KEEP THEIR DECISIONS — the
 *     cascade is scoped to still-`PENDING` steps by the repository's predicate, not by a convention
 *     this file has to remember.
 *
 * TENANCY. Every read and every write is scoped by `actor.tenantId`, and the actor is server-derived
 * (`hr-actor.ts`); no route accepts a tenant and no DTO has the field.
 */
@Injectable()
export class LeaveApprovalService {
  constructor(
    private readonly approvals: LeaveApprovalRepository,
    private readonly leave: LeaveRepository,
    private readonly employees: EmployeeRepository,
    private readonly audit: HrAuditGateway
  ) {}

  // -------------------------------------------------------------------------
  // Reads — the flow as it stands
  // -------------------------------------------------------------------------

  /**
   * The request's CURRENT flow, or `null` when it has none.
   *
   * `null` is a STATE, NOT AN ERROR (§18.5): a request recorded before any policy existed, or one
   * whose flow already completed, has no live instance, and an approver's screen renders "nothing
   * is waiting" for both. Throwing a 404 here would make an ungoverned request indistinguishable
   * from a missing one.
   */
  async getLiveFlow(actor: HrActor, leaveRequestId: string) {
    await this.assertRequestExists(actor, leaveRequestId);
    const instance = await this.approvals.findLiveInstance(actor.tenantId, leaveRequestId);
    if (!instance) return null;

    // The DECIDER'S OWN EMPLOYEE, resolved once for the whole read with `required: false` — the
    // same stance `listMyQueue` takes. An actor who is not an employee of this tenant simply is not
    // the resolved approver of anything, so every step answers `AWAITING_OTHER` (or the flow is
    // unresolvable), which is the truth rather than a 403 on a read that was allowed to ask.
    const employee = await this.resolveActorEmployee(actor, { required: false });
    return LeaveApprovalService.attachDecisionability(
      LeaveApprovalService.serializeInstance(instance),
      employee?.id ?? null
    );
  }

  /**
   * ANSWERS ONE QUESTION AND RETURNS THE ANSWER, NOT THE INGREDIENTS (§27).
   *
   * The returned fact is `decidableByActor` (+ a typed reason) and nothing else about the actor:
   * no tenant, no actor id and — deliberately — no employee id of this session. The client needs to
   * know whether to draw Approve and Reject; giving it the identity that the comparison was computed
   * from would be handing it the right hand side of a check it is forbidden to recompute (§8), and
   * would put a second, browser-side authorization rule where the write path already owns the only
   * authoritative one.
   *
   * THE READ CHANGES NOBODY'S AUTHORITY. It is advisory presentation state: `POST :id/approve` and
   * `POST :id/reject` still require `hr.leave.approve` AND re-run the very same predicate below
   * before mutating, so a client that lies about having seen `false`, or that ignores `true`, is
   * refused by the write path regardless of what the read promised. This is why the field can be
   * safely rendered by the browser: it is a *prediction of the server's own answer*, computed from
   * the same function, not an input to it.
   */
  private static attachDecisionability<
    T extends {
      steps: readonly {
        order: number;
        status: LeaveApprovalStepStatus;
        resolvedApproverEmployeeId: string | null;
      }[];
      // The ROW COLUMNS THIS ENDPOINT DELIBERATELY DROPS (§5). Typed here rather than asserted at
      // the destructuring: the serializer's generic narrows to what its own contract needs, so the
      // columns it carries through `...instance` are not on its return type even though they are on
      // every row the repository returns. Naming them states the endpoint's shape honestly — and
      // makes a column RENAMED in the schema a compile error here rather than a field that silently
      // survives onto the wire.
      tenantId?: string;
      approvalDefinitionId?: string;
      createdAt?: Date;
      updatedAt?: Date;
    } & Record<string, unknown>,
  >(instance: T, deciderEmployeeId: string | null) {
    const active = instance.steps.find((step) => isDecidableLeaveApprovalStepStatus(step.status));
    const decisionability = active
      ? resolveLeaveApprovalDecisionability({
          deciderEmployeeId,
          resolvedApproverEmployeeId: active.resolvedApproverEmployeeId ?? null,
        })
      : { decidableByActor: false, undecidableReason: null };

    // §5 — "Return the answer, not the ingredients." `serializeInstance` spreads the ROW, so
    // `tenantId`, `approvalDefinitionId` and the `createdAt`/`updatedAt` bookkeeping arrive with it.
    // The keys are DELETED from a copy — not destructured-into-unused-bindings, which would buy
    // readability at the price of four `no-unused-vars` findings the repo's lint correctly refuses.
    // Removing the keys entirely is what the wire must do; this is the narrowest way to say so.
    // It happens HERE rather than in the serializer because the HISTORY read shares that serializer
    // and its existing contract is not this phase's to change: this endpoint promises exactly what
    // §7.5 asks — the decisionability answer, the facts an approval screen renders, and nothing an
    // authorization rule could be rebuilt from.
    const renderable = { ...instance } as T & Record<string, unknown>;
    delete renderable.tenantId;
    delete renderable.approvalDefinitionId;
    delete renderable.createdAt;
    delete renderable.updatedAt;

    return { ...renderable, ...decisionability };
  }

  /**
   * EVERY flow the request has had, newest first — the history read.
   *
   * A list rather than one row because a request's life may contain several: a flow withdrawn
   * mid-route, then a corrected request routed again. The request is checked first so a nonexistent
   * or foreign request is a 404 rather than an empty list, which would otherwise claim "this request
   * exists and has never been routed".
   */
  async listFlowHistory(actor: HrActor, leaveRequestId: string) {
    await this.assertRequestExists(actor, leaveRequestId);
    const instances = await this.approvals.listInstances(actor.tenantId, leaveRequestId);
    return instances.map((instance) => LeaveApprovalService.serializeInstance(instance));
  }

  /**
   * The steps waiting on the ACTOR — an approver's own queue.
   *
   * Resolved from the actor rather than from a query parameter, and that is the whole security
   * content of the endpoint: "what is waiting for me" cannot be asked about somebody else. An actor
   * with no personnel record has an EMPTY queue rather than a 403 — not being an approver is a
   * legitimate state for an HR operator, and a refusal would turn a normal empty answer into an
   * error. The read is by `resolvedApproverEmployeeId`, so a step nobody was resolved for
   * (`NO_RESOLUTION`) appears in nobody's queue, which is what makes it BLOCK rather than disappear.
   */
  async listMyQueue(actor: HrActor) {
    const employee = await this.resolveActorEmployee(actor, { required: false });
    if (!employee) return [];
    return this.approvals.listAwaitingSteps(actor.tenantId, employee.id);
  }

  // -------------------------------------------------------------------------

  /**
   * Records a decision on the request's LIVE `ACTIVE` step.
   *
   * THE ORDER OF CHECKS IS THE CONTRACT, and each one answers a question the next cannot:
   *
   *   1. THE REQUEST EXISTS AND IS DECIDABLE. A decision on an `APPROVED`, `REJECTED` or `CANCELLED`
   *      request is a 409 — `DECIDABLE_LEAVE_REQUEST_STATUS` states which status is acceptable, as
   *      ONE constant rather than a comparison sprinkled through this file. This is what makes "the
   *      second approval" impossible: without it, a stale screen could approve a request that was
   *      refused a minute earlier, and the flow would end up with a decision contradicting the one
   *      already recorded.
   *   2. A LIVE FLOW EXISTS. A request with no `ACTIVE` instance has nothing to decide: 409 rather
   *      than 404, because the request is present and the ABSENCE of a flow is the conflict (§18.5).
   *   3. THE FLOW IS OPEN AND HAS AN `ACTIVE` STEP. `isOpenLeaveApprovalInstance` is read first, then
   *      the `ACTIVE` step is looked up in the instance's own steps. No `ACTIVE` step means the flow
   *      is mid-transition or malformed, and refusing is the honest answer: an approval recorded
   *      against no step would be an act with nowhere to live.
   *   4. THE ACTOR IS THE RESOLVED APPROVER OF THAT STEP (§25.2), which is the last check precisely
   *      because it needs the step. 403 rather than 404: the step is visible to whoever can read the
   *      request, and pretending it is missing would hide a flow somebody must be able to see.
   *   5. A REJECTION STATES WHY. The DTO makes `reason` required, so this is the belt to that
   *      braces: the domain contract is enforced where the value is written, and the database's
   *      CHECK is the guarantee behind both.
   *
   * `decisionAt` IS READ ONCE, before the write, and passed to BOTH the repository and the audit
   * entry. Two `new Date()` calls would be two instants, and the audit row would describe a moment
   * the step row does not state — the failure `recordDecision`'s own header names.
   */
  async decide(
    actor: HrActor,
    leaveRequestId: string,
    decision: LeaveRequestDecision,
    reason: string | undefined
  ) {
    const request = await this.leave.findRequestById(actor.tenantId, leaveRequestId);
    if (!request) throw new NotFoundException('Leave request not found');

    if (request.status !== DECIDABLE_LEAVE_REQUEST_STATUS) {
      throw new ConflictException(
        `A ${request.status} request cannot be decided; only a ${DECIDABLE_LEAVE_REQUEST_STATUS} request may be awaiting a decision.`
      );
    }

    const instance = await this.approvals.findLiveInstance(actor.tenantId, leaveRequestId);
    if (!instance) {
      throw new ConflictException(
        'This request has no open approval flow, so there is nothing to decide.'
      );
    }
    if (!isOpenLeaveApprovalInstance(instance.status)) {
      throw new ConflictException('This approval flow has already completed.');
    }

    const activeStep = instance.steps.find((step) => step.status === 'ACTIVE');
    if (!activeStep) {
      throw new ConflictException(
        'This approval flow has no step awaiting a decision, so it cannot be advanced.'
      );
    }

    const decider = await this.assertMayDecideStep(actor, activeStep.resolvedApproverEmployeeId);
    const statement = LeaveApprovalService.normalizeReason(decision, reason);

    const outcome = resolveDecisionOutcome({
      decision,
      order: activeStep.order,
      stepCount: instance.stepCount,
      hasNextStep: instance.steps.some((step) => step.order === activeStep.order + 1),
    });

    const decidedAt = new Date();

    // Phase B2.5: build the durable outbox payload BEFORE the repository write so
    // it commits atomically with the business mutation inside the same transaction.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: decision === 'APPROVE' ? HR_AUDIT_ACTION.APPROVE : HR_AUDIT_ACTION.REJECT,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: leaveRequestId,
      newValue: {
        approvalInstanceId: instance.id,
        stepOrder: activeStep.order,
        decision: outcome.stepStatus,
        decidedByEmployeeId: decider.id,
        requestOutcome: outcome.requestOutcome,
        instanceStatus: outcome.instanceStatus,
        nextStepOrder: outcome.nextStepOrder,
        cascade: outcome.cascade,
        decidedAt: decidedAt.toISOString(),
      },
      reason: statement,
    });

    const step = await this.approvals.recordDecision({
      tenantId: actor.tenantId,
      leaveRequestId,
      approvalInstanceId: instance.id,
      stepOrder: activeStep.order,
      decision: outcome.stepStatus,
      decidedByEmployeeId: decider.id,
      decisionReason: statement,
      decisionAt: decidedAt,
      ruleVersionLabel: activeStep.ruleVersionLabel,
      requestOutcome: outcome.requestOutcome,
      instanceStatus: outcome.instanceStatus,
      nextStepOrder: outcome.nextStepOrder,
      cascade: outcome.cascade,
      outbox,
    });

    return {
      request: {
        id: leaveRequestId,
        status: outcome.requestOutcome,
        decidedAt: decidedAt.toISOString(),
      },
      instance: {
        id: instance.id,
        status: outcome.instanceStatus,
        nextStepOrder: outcome.nextStepOrder,
        cascade: outcome.cascade,
      },
      step: step ? LeaveApprovalService.serializeStep(step) : null,
    };
  }

  /** `POST :id/approve` — the positive decision, with the reason OPTIONAL (§21). */
  async approve(actor: HrActor, leaveRequestId: string, reason?: string) {
    return this.decide(actor, leaveRequestId, 'APPROVE', reason);
  }

  /**
   * `POST :id/reject` — the negative decision, which MUST state why.
   *
   * A separate method rather than a boolean on `decide`, because the REQUIREMENT differs: the reason
   * is mandatory here and optional there, and expressing that as an argument's presence is how the
   * rule ends up optional in the wrong direction. `decide` still performs the check, so a caller
   * reaching it directly cannot bypass the requirement.
   */
  async reject(actor: HrActor, leaveRequestId: string, reason: string) {
    return this.decide(actor, leaveRequestId, 'REJECT', reason);
  }

  /**
   * Closes the LIVE flow because the REQUEST was withdrawn (§18.3) — no decision is recorded.
   *
   * CALLED BY `LeaveService.cancel` AFTER its own write, and it deliberately does NOTHING when there
   * is no live flow: an ungoverned request (§18.5) is withdrawn exactly as before, so this is a
   * no-op rather than an error. Refusing would make a withdrawal fail on the very requests that have
   * the least to unwind.
   *
   * THE CASCADE IS `CANCELLED`, NOT `SKIPPED`, and the difference is the point of having two
   * members: the requester stopped the flow, so nothing was skipped around anybody. Steps already
   * `APPROVED` or `REJECTED` KEEP THEIR DECISIONS — a withdrawal is the requester's act and does not
   * retroactively un-say what an approver stated — which the repository's `status: 'PENDING'`
   * predicate enforces rather than this file.
   *
   * `pendingOrders` and `approvedOrders` are read from the instance's OWN steps, so the outcome is
   * computed from the rows the flow actually owns instead of from a re-read of live configuration.
   */
  async closeOnWithdrawal(actor: HrActor, leaveRequestId: string, reason: string) {
    const instance = await this.approvals.findLiveInstance(actor.tenantId, leaveRequestId);
    if (!instance) return null;

    const pendingOrders = instance.steps
      .filter((step) => step.status === 'PENDING')
      .map((step) => step.order);
    const approvedOrders = instance.steps
      .filter((step) => step.status === 'APPROVED')
      .map((step) => step.order);

    const outcome = resolveWithdrawalOutcome({ pendingOrders, approvedOrders });

    // `closedAt` is read ONCE and passed in, so the instance's completion instant is the same one
    // the response states — the same rule `decide` follows for `decidedAt`.
    const closedAt = new Date();

    // THE COUNT COMES BACK FROM THE WRITE and is what is reported, never `pendingOrders.length`:
    // the cascade's predicate is the ARBITER of how many steps actually closed, and a step decided
    // between the read above and this statement would make the expectation wrong while the write
    // stayed correct. Reporting the count is reporting what happened.
    const cancelledCount = await this.approvals.closeInstanceOnWithdrawal({
      tenantId: actor.tenantId,
      approvalInstanceId: instance.id,
      closedAt,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CANCEL,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: leaveRequestId,
      newValue: {
        approvalInstanceId: instance.id,
        instanceStatus: outcome.instanceStatus,
        cancelledSteps: cancelledCount,
        hadApproval: outcome.hadApproval,
      },
      reason,
    });

    return {
      instanceId: instance.id,
      instanceStatus: outcome.instanceStatus,
      cancelledSteps: cancelledCount,
      hadApproval: outcome.hadApproval,
      closedAt: closedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Guards and helpers
  // -------------------------------------------------------------------------

  /**
   * The actor's personnel record, or a refusal.
   *
   * `required: false` is the queue's use — an operator who is not an employee is a legitimate actor
   * with an EMPTY queue rather than an error. When `required`, the absence is a 403 and NOT a 404:
   * the caller is asking to ACT AS AN APPROVER, and "there is no personnel record for your login" is
   * an authorization answer, not a missing-resource one. A 404 would also be a lie — the request
   * exists, and it is the caller's standing that is absent.
   *
   * The THREE refusals around this method are deliberately distinguishable in their messages,
   * because an operator diagnosing "why can't I approve?" needs to know which one applies:
   *   1. the login is not linked to any personnel record in this tenant;
   *   2. the employee is not the step's resolved approver (`assertMayDecideStep`);
   *   3. no approver was resolved for the step at all (`assertMayDecideStep`).
   */
  private async resolveActorEmployee(actor: HrActor, options: { required: boolean }) {
    if (!actor.userId) {
      if (options.required) {
        throw new ForbiddenException(
          'A decision requires a login linked to a personnel record, and this request carries no identity.'
        );
      }
      return null;
    }

    const employee = await this.employees.findByIdentityUserId(actor.tenantId, actor.userId);
    if (!employee && options.required) {
      throw new ForbiddenException(
        'Your login is not linked to a personnel record in this organization, so it cannot decide a leave request.'
      );
    }
    return employee;
  }

  /**
   * §25.2 — the decider must be the step's RESOLVED approver.
   *
   * THIS IS NOT THE PERMISSION CHECK, AND THE ROUTE'S `@Roles(HR_LEAVE_APPROVE)` IS NOT THIS RULE.
   * The permission answers "may this actor approve leave at all"; this answers "may this actor
   * approve THIS STEP". §25.2 is exactly that distinction, and it is why the check lives here rather
   * than in the guard: a guard sees a route and an actor and never a step, so it could only ever
   * answer the weaker question.
   *
   * A STEP WITH NO RESOLVED APPROVER CANNOT BE DECIDED AT ALL. `resolvedApproverEmployeeId` is NULL
   * only for `NO_RESOLUTION` (§17.3), whose whole purpose is to BLOCK — the honest rendering of
   * "nobody stated who should decide this". Letting any holder of the permission step in would
   * silently convert a policy gap into a decision, which is the same failure
   * `mayResolveToRequester` documents from the requester's side.
   */
  private async assertMayDecideStep(actor: HrActor, resolvedApproverEmployeeId: string | null) {
    const employee = await this.resolveActorEmployee(actor, { required: true });
    const decider = employee as NonNullable<typeof employee>;

    // THE SAME FUNCTION THE READ USES (§4 of the A1 correction) — the decisionability rule has
    // exactly one implementation, in the domain file where it has no dependencies and cannot drift
    // from the fact the browser is shown. `decider.id` is always a real employee id here, so only
    // `NOT_RESOLVED` and `AWAITING_OTHER` are reachable below.
    const { decidableByActor, undecidableReason } = resolveLeaveApprovalDecisionability({
      deciderEmployeeId: decider.id,
      resolvedApproverEmployeeId,
    });

    if (!decidableByActor && undecidableReason === 'NOT_RESOLVED') {
      throw new ConflictException(
        'No approver was resolved for the step awaiting a decision, so it cannot be decided; the leave policy must be corrected.'
      );
    }

    if (!decidableByActor) {
      throw new ForbiddenException(
        'This step is awaiting a different approver, so it is not yours to decide.'
      );
    }

    return decider;
  }

  /** The request must exist in the actor's tenant — a foreign or unknown id is a 404. */
  private async assertRequestExists(actor: HrActor, leaveRequestId: string) {
    const request = await this.leave.findRequestById(actor.tenantId, leaveRequestId);
    if (!request) throw new NotFoundException('Leave request not found');
    return request;
  }

  /**
   * The reason a decision records, or a refusal.
   *
   * A `null` for an approval with no reason is CORRECT and not an empty string: the column is
   * nullable precisely so "the approver said nothing" is representable, and the CHECK ties only a
   * REJECTION to a non-blank value. Writing `''` would claim a statement that says nothing.
   *
   * A REJECTION WITHOUT A REASON IS REFUSED HERE AS WELL AS BY THE DTO, and the duplication is
   * deliberate: the DTO states it for the WIRE, this states it for the DOMAIN, and the database's
   * CHECK is the guarantee behind both. A caller reaching `decide()` from another service never
   * passes through the DTO, so a check only there would leave that caller able to write the shape
   * the CHECK refuses — a 500 instead of a 400.
   *
   * A 409 rather than a 400 for the blank case, because it is reached only by a caller that got past
   * the DTO: for the wire the DTO has already answered with a 400, and this branch is the DOMAIN
   * refusing a shape it cannot record. The conflict is with the step's contract, not the request's
   * syntax.
   */
  private static normalizeReason(
    decision: LeaveRequestDecision,
    reason: string | undefined
  ): string | null {
    const statement = typeof reason === 'string' ? reason.trim() : '';

    if (decision === 'REJECT' && statement.length === 0) {
      throw new ConflictException('A rejection must state a reason.');
    }

    return statement.length === 0 ? null : statement;
  }

  /**
   * The wire view of an instance: DAY-shaped fields become `YYYY-MM-DD`, instants stay ISO.
   *
   * The same boundary rule `LeaveService.serialize` states — a `@db.Date` column IS a calendar day,
   * and emitting `2026-09-18T00:00:00.000Z` would hand a reader in another timezone a different day.
   *
   * `steps` is re-sorted by `order` here rather than trusted to arrive sorted. The repository already
   * orders it, and this makes the RESPONSE's order a property of the response rather than of a
   * caller's query, so a future read that omitted the `orderBy` cannot render a flow out of sequence
   * — which for an approval screen would show the wrong step as "the one awaiting you".
   */
  private static serializeInstance<
    T extends {
      requestStartDate: Date;
      requestEndDate: Date;
      // The step fields the READS OF THE FLOW actually depend on: its position, whether it is the
      // one being asked, and who owns it. Widening the previous `{ order: number }` to these three
      // makes the serializer's signature state what it already returned implicitly — the repository
      // always selects them — so `attachDecisionability` can read them without a cast. NOTHING NEW
      // IS SELECTED: this documents the existing shape rather than expanding the response.
      steps: readonly {
        order: number;
        status: LeaveApprovalStepStatus;
        resolvedApproverEmployeeId: string | null;
      }[];
    },
  >(instance: T) {
    return {
      ...instance,
      requestStartDate: instance.requestStartDate.toISOString().slice(0, 10),
      requestEndDate: instance.requestEndDate.toISOString().slice(0, 10),
      steps: [...instance.steps].sort((a, b) => a.order - b.order),
    };
  }

  /**
   * `decidedAt` is an INSTANT and stays one — unlike the two day-shaped fields above.
   *
   * A moment stripped of its offset is a different moment, so `toISOString()` is the correct
   * conversion and `slice(0, 10)` would be a defect. The two helpers sit next to each other because
   * the CONTRAST is the rule.
   */
  private static serializeStep<T extends { decidedAt: Date | null }>(step: T) {
    return {
      ...step,
      decidedAt: step.decidedAt ? step.decidedAt.toISOString() : null,
    };
  }
}
