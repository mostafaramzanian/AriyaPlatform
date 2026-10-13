import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { LeaveApprovalInstanceStatus } from '../domain/leave-approval-status';
import type { HrAuditOutboxPayload } from '../hr-audit.gateway';

/**
 * Phase 54-E (§17, §18): the APPROVAL-RUNTIME persistence boundary — the router's writes and the
 * router's reads.
 *
 * WHY THIS IS A SECOND FILE RATHER THAN MORE METHODS ON `LeaveRepository`
 * ---------------------------------------------------------------------
 * §18 names TWO aggregates here and they are not the same aggregate:
 *
 *   * `LeaveRequest` + `LeaveType` — what was ASKED FOR. `LeaveRepository` owns them, and its own
 *     header states why the two share one file: a composite `(tenant_id, leave_type_id)` foreign
 *     key makes them one fact about one tenant.
 *   * `LeaveApprovalDefinition` → `LeaveApprovalStepDefinition` → `LeaveSubstitutionDefinition`
 *     (configuration) and `LeaveApprovalInstance` → `LeaveApprovalStepInstance` (runtime) — WHO IS
 *     ASKED, AND WHAT THEY STATED. A different lifecycle, a different retention rule (the runtime
 *     rows are never rewritten, §17.6) and a different read shape.
 *
 * Putting both in one file would make `LeaveRepository` the place where "a request exists" and
 * "a flow was routed" are the same kind of statement — and they are not: a request may exist
 * with NO instance at all (§18.5, an ungoverned request), which is precisely the distinction a
 * merged file would blur.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT REFUSES TO
 * -------------------------------------------
 * It owns the statements: the configuration reads the resolver needs, the instance and step
 * INSERTs, the decision write, the cascade write, and the transactional composite for opening a
 * flow. It owns NO rule. "Is this step last?", "what happens to the steps nobody asked?", "may
 * this step be activated?" and "may this person decide this step?" are answered in
 * `domain/leave-approval-routing.ts` and in the sending service — this layer only knows how to
 * WRITE what it is told, which is what keeps the routing rule testable without a database.
 *
 * NO AUDIT IS WRITTEN HERE (§49 — the service audits), and NO EXCEPTION IS TRANSLATED HERE (the
 * service owns the domain meaning of an empty read).
 *
 * TENANCY. Like every repository in this module, `tenantId` is the FIRST parameter of every read
 * and every write. `findUnique` appears nowhere: it cannot carry a tenant predicate. Reads of a
 * single runtime row go through `findFirst` with `{ id, tenantId }`, and writes address the
 * compound key `{ tenantId_id: { tenantId, id } }`. `hr-application-boundaries.spec.ts` rule 6
 * fails the build on a `find*`/`list*`/`has*` method whose first parameter is not `tenantId`.
 *
 * WHY THE ROUTING WRITE IS ONE INTERACTIVE `$transaction` AND NOT A SEQUENCE
 * -------------------------------------------------------------------------
 * §18.1 requires that a step is activated in the SAME transaction that closes its predecessor:
 * "there is never a routed, undecided request with nobody asked to decide it". A sequence of
 * awaits would leave exactly that window open — a request whose step 1 is `APPROVED` and whose
 * step 2 is still `PENDING`, which reads as a flow nobody can advance. The callback form is
 * therefore the shape, not a stylistic choice: the instance INSERT, its step INSERTs and the
 * first step's activation either all land or none do.
 */
@Injectable()
export class LeaveApprovalRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /**
   * The labels every runtime read carries, so a step is renderable without a second query.
   *
   * `resolvedApproverEmployee` carries the employee CODE and never a name: names come from Core
   * through `HrIdentityGateway` (§6d) and this layer never learns about identity. `decidedByEmployee`
   * is included for the same reason — "who decided this" is an HR fact and the login behind it is not.
   */
  private static readonly STEP_LABEL = {
    resolvedApproverEmployee: { select: { id: true, employeeCode: true } },
    decidedByEmployee: { select: { id: true, employeeCode: true } },
  } as const;

  // -------------------------------------------------------------------------
  // Configuration — the reads the resolver performs before it routes anything
  // -------------------------------------------------------------------------

  /**
   * The step definitions of a flow, in ROUTING order.
   *
   * Ordered by `order` explicitly, NEVER by `createdAt`: §17 states that insertion order is not
   * the order, because a re-ordered draft would otherwise silently re-route requests recorded
   * against the old sequence. `id` is the tie-breaker, so the read is TOTAL and cannot vary
   * between two calls.
   */
  async listStepDefinitions(tenantId: string, approvalDefinitionId: string) {
    return this.prisma.leaveApprovalStepDefinition.findMany({
      where: { tenantId, approvalDefinitionId },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The substitution rows whose PRIMARY is one of `primaryEmployeeIds` and which are effective
   * for the requested range.
   *
   * The predicate is an INTERSECTION test, not containment: a substitution open-ended on the
   * right (`effectiveTo` NULL) must match a range that merely starts inside it, and a
   * substitution covering PART of the range is the substitution in force for those days.
   * Containment would hide exactly the open-ended row this table's header says NULL means.
   *
   * `effectiveTo: null` is Prisma's spelling of SQL NULL, which is why the OR is written with it
   * rather than as a raw predicate — `{ gte: ... }` alone would silently exclude every
   * open-ended substitution, which is the most common shape.
   */
  async listEffectiveSubstitutions(
    tenantId: string,
    primaryEmployeeIds: readonly string[],
    range: { startDate: Date; endDate: Date }
  ) {
    if (primaryEmployeeIds.length === 0) return [];

    return this.prisma.leaveSubstitutionDefinition.findMany({
      where: {
        tenantId,
        primaryEmployeeId: { in: [...primaryEmployeeIds] },
        effectiveFrom: { lte: range.endDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.startDate } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
    });
  }

  /**
   * Whether a person has an APPROVED leave request covering any day of the range — the
   * `ON_APPROVED_LEAVE` availability signal (§20).
   *
   * `status: 'APPROVED'` is only answerable because 54-E adds that state; the availability file
   * says so explicitly, which is why this signal belongs to this phase rather than a later one.
   *
   * The intersection test is the register's own: `endDate >= startDate` and `startDate <=
   * endDate` of the requested range, so a long approved request that swallows the range whole is
   * FOUND rather than hidden — the same deliberate choice `LeaveRepository.listRequestPage`
   * documents for its own bounds.
   *
   * `findFirst` with `select: { id: true }` rather than a `count`: the question is existential,
   * and a count would scan rows to answer a boolean. Named `has...` so rule 6 of the boundary spec
   * checks its tenant parameter, and so this method reads as a predicate at its call site.
   */
  async hasApprovedLeaveInRange(
    tenantId: string,
    employeeId: string,
    range: { startDate: Date; endDate: Date }
  ) {
    return this.prisma.leaveRequest.findFirst({
      where: {
        tenantId,
        employeeId,
        status: 'APPROVED',
        startDate: { lte: range.endDate },
        endDate: { gte: range.startDate },
      },
      select: { id: true },
    });
  }

  // -------------------------------------------------------------------------
  // The runtime flow
  // -------------------------------------------------------------------------

  /**
   * The request's LIVE flow, or `null` (§18.5).
   *
   * `status: 'ACTIVE'` is the partial unique index's own predicate restated as a read: only one
   * instance per request may be `ACTIVE`, so this is at most one row. A `COMPLETED` instance is
   * deliberately NOT returned — a request whose flow has ended is not being routed any more, and
   * handing back the finished flow would let a caller decide a step of a closed history.
   */
  async findLiveInstance(tenantId: string, leaveRequestId: string) {
    return this.prisma.leaveApprovalInstance.findFirst({
      where: { tenantId, leaveRequestId, status: 'ACTIVE' },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  }

  /**
   * EVERY flow the request has ever had, newest first — the history read.
   *
   * A LIST rather than a single row, because the relation is genuinely one-to-many over the
   * request's life (a withdrawn flow, then a corrected request's flow) and the header of
   * `LeaveApprovalInstance` says so. Ordered by `routedAt` then `id`, so the order is total.
   */
  async listInstances(tenantId: string, leaveRequestId: string) {
    return this.prisma.leaveApprovalInstance.findMany({
      where: { tenantId, leaveRequestId },
      orderBy: [{ routedAt: 'desc' }, { id: 'asc' }],
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  }

  /**
   * The flow's own record of itself: the instance, its steps in order with their labels, and the
   * RULE VERSION the decisions are made under.
   *
   * The `approvalDefinition.policyVersion.versionLabel` hop is what fills
   * `LeaveApprovalStepInstance.ruleVersionLabel`: §17.5 requires the document IN FORCE at the
   * moment of the decision to be recorded, because configuration is allowed to change afterwards
   * and an explanation that joined live configuration would silently rewrite history.
   *
   * A SINGLE `include` rather than three awaits: the three answers describe one instant, and one
   * statement cannot observe a configuration that changed between them.
   */
  async describeInstance(tenantId: string, approvalInstanceId: string) {
    return this.prisma.leaveApprovalInstance.findFirst({
      where: { tenantId, id: approvalInstanceId },
      include: {
        steps: { orderBy: { order: 'asc' }, include: LeaveApprovalRepository.STEP_LABEL },
        approvalDefinition: {
          select: { id: true, code: true, policyVersion: { select: { versionLabel: true } } },
        },
      },
    });
  }

  /**
   * Opens a flow and its steps in ONE transaction (§18.1, §18.4).
   *
   * `steps` arrives already RESOLVED — the resolver has named the approver, the reason and the
   * signal for every position — because "who is asked" is an authorization-and-availability
   * question (§19) and this layer would otherwise have to re-read half the schema to answer it.
   *
   * The first step is written `ACTIVE` and the rest `PENDING`: that is DENSE ACTIVATION stated as
   * data rather than as an `if`, and an instance whose first step is not active would be a flow
   * nobody has been asked to decide. Later activation is `recordDecision`'s job, in the same
   * transaction as the decision that caused it.
   *
   * `stepCount` is the LENGTH OF THAT LIST, never a count read back from configuration: §17 says
   * the instance snapshots its own step count precisely because live configuration may disagree
   * with the step rows the instance actually owns, and `resolveDecisionOutcome` reads the snapshot
   * to decide whether a step is the last one.
   */
  async openInstance(input: {
    tenantId: string;
    leaveRequestId: string;
    approvalDefinitionId: string;
    requestStartDate: Date;
    requestEndDate: Date;
    steps: readonly {
      approvalStepDefinitionId: string;
      order: number;
      resolvedApproverEmployeeId: string | null;
      resolutionReason: 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';
      resolutionSignal: string | null;
      ruleVersionLabel: string | null;
    }[];
  }) {
    const { tenantId, steps } = input;

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.leaveApprovalInstance.create({
        data: {
          tenantId,
          leaveRequestId: input.leaveRequestId,
          approvalDefinitionId: input.approvalDefinitionId,
          status: 'ACTIVE',
          requestStartDate: input.requestStartDate,
          requestEndDate: input.requestEndDate,
          stepCount: steps.length,
        },
      });

      await tx.leaveApprovalStepInstance.createMany({
        data: steps.map((step) => ({
          tenantId,
          approvalInstanceId: instance.id,
          approvalStepDefinitionId: step.approvalStepDefinitionId,
          order: step.order,
          status: step.order === steps[0].order ? 'ACTIVE' : 'PENDING',
          resolvedApproverEmployeeId: step.resolvedApproverEmployeeId,
          resolutionReason: step.resolutionReason,
          resolutionSignal: step.resolutionSignal,
          ruleVersionLabel: step.ruleVersionLabel,
        })),
      });

      return instance;
    });
  }

  // -------------------------------------------------------------------------
  // The decision — the composite write, in ONE transaction
  // -------------------------------------------------------------------------

  /**
   * Records ONE decision and everything that follows from it, atomically (§18.1, §18.2).
   *
   * THE FIVE WRITES, and why they are five rather than one:
   *
   *   1. the DECIDED STEP — status, decision, decider, reason, instant and the rule version. The
   *      status and the decision move TOGETHER because the migration's CHECK ties them in BOTH
   *      directions: a `REJECTED` step with a NULL decision, or an `APPROVED` decision sitting on
   *      a step that is not `APPROVED`, are both unwritable.
   *   2. the REQUEST — only when the outcome actually changes it. `requestOutcome === 'PENDING'`
   *      means "this decision did not end the flow", and writing `PENDING` over `PENDING` would be
   *      a no-op UPDATE that stamps `updated_at` and makes a mid-flow approval look like an edit
   *      to the request. `approvedAt` / `rejectedAt` are set in the SAME statement as the status
   *      because the migration's CHECK couples them in both directions.
   *   3. the INSTANCE — `COMPLETED` with its timestamp, or left strictly alone. `completedAt` is
   *      written only when the status is `COMPLETED`, for the same CHECK reason.
   *   4. the NEXT STEP — `ACTIVE`, in this same transaction, which is §18.1's "the next step
   *      activates in the SAME transaction, so there is never a routed, undecided request with
   *      nobody asked to decide it". Density is `mayActivateStep`'s rule; by the time the order
   *      reaches here it has already been authorised, and this write is the mechanical part.
   *   5. the CASCADE — every still-`PENDING` step becomes `SKIPPED` (a rejection) or `CANCELLED`
   *      (a withdrawal). `status: 'PENDING'` IN THE PREDICATE is the scope, so a step that was
   *      already decided cannot be touched even if the caller passed the wrong list: §18.3's
   *      "decided steps keep their decisions" is enforced by the WHERE clause, not by a
   *      convention the caller has to remember.
   *
   * `updateMany` RATHER THAN `update`, because the step's identity here is `(instance, order)` —
   * the compound unique the router works in — and because the cascade is inherently a set. Each
   * count is asserted by the caller through the returned step, never assumed.
   *
   * `decisionAt` IS PASSED IN rather than read from `new Date()` here: the audit entry the service
   * writes and the row it describes must state the same instant, and two independent `new Date()`
   * calls are two different instants.
   */
  async recordDecision(input: {
    tenantId: string;
    leaveRequestId: string;
    approvalInstanceId: string;
    stepOrder: number;
    decision: 'APPROVED' | 'REJECTED';
    decidedByEmployeeId: string;
    decisionReason: string | null;
    decisionAt: Date;
    ruleVersionLabel: string | null;
    requestOutcome: 'PENDING' | 'APPROVED' | 'REJECTED';
    instanceStatus: LeaveApprovalInstanceStatus;
    nextStepOrder: number | null;
    cascade: 'SKIPPED' | 'CANCELLED' | null;
    outbox?: HrAuditOutboxPayload;
  }) {
    const { tenantId } = input;

    return this.prisma.$transaction(async (tx) => {
      await tx.leaveApprovalStepInstance.updateMany({
        where: {
          tenantId,
          approvalInstanceId: input.approvalInstanceId,
          order: input.stepOrder,
        },
        data: {
          status: input.decision,
          decision: input.decision,
          decidedByEmployeeId: input.decidedByEmployeeId,
          decisionReason: input.decisionReason,
          decidedAt: input.decisionAt,
          ruleVersionLabel: input.ruleVersionLabel,
        },
      });

      if (input.requestOutcome !== 'PENDING') {
        await tx.leaveRequest.update({
          where: { tenantId_id: { tenantId, id: input.leaveRequestId } },
          data: {
            status: input.requestOutcome,
            approvedAt: input.requestOutcome === 'APPROVED' ? input.decisionAt : null,
            rejectedAt: input.requestOutcome === 'REJECTED' ? input.decisionAt : null,
          },
        });
      }

      if (input.instanceStatus === 'COMPLETED') {
        await tx.leaveApprovalInstance.update({
          where: { tenantId_id: { tenantId, id: input.approvalInstanceId } },
          data: { status: 'COMPLETED', completedAt: input.decisionAt },
        });
      }

      if (input.nextStepOrder !== null) {
        await tx.leaveApprovalStepInstance.updateMany({
          where: {
            tenantId,
            approvalInstanceId: input.approvalInstanceId,
            order: input.nextStepOrder,
          },
          data: { status: 'ACTIVE' },
        });
      }

      if (input.cascade !== null) {
        await tx.leaveApprovalStepInstance.updateMany({
          where: {
            tenantId,
            approvalInstanceId: input.approvalInstanceId,
            status: 'PENDING',
          },
          data: { status: input.cascade },
        });
      }

      if (input.outbox) {
        await tx.auditOutbox.create({ data: input.outbox });
      }

      return tx.leaveApprovalStepInstance.findFirst({
        where: {
          tenantId,
          approvalInstanceId: input.approvalInstanceId,
          order: input.stepOrder,
        },
        include: LeaveApprovalRepository.STEP_LABEL,
      });
    });
  }

  /**
   * ENDS the live flow because the REQUEST was withdrawn (§18.3) — the cascade without a decision.
   *
   * WHY THIS IS SEPARATE FROM `recordDecision` RATHER THAN A FLAG ON IT. A withdrawal has NO
   * decider, NO decision and NO decision reason: nobody stated anything. Folding it into the
   * decision write would mean threading a `decision: null` through a parameter the domain layer
   * types as `'APPROVED' | 'REJECTED'`, weakening a type to describe an act that is not a
   * decision. The two writes share the CASCADE mechanics and share nothing else.
   *
   * The steps become `CANCELLED` and never `SKIPPED`: §18.2 draws that line deliberately — the
   * requester stopped the flow, so nothing was skipped around them. The `status: 'PENDING'`
   * predicate is the same scope guard `recordDecision` uses, so a step that had already been
   * APPROVED keeps its decision: a withdrawal is the requester's act and does not retroactively
   * un-say what an approver stated.
   *
   * The returned count is what the service records as "how many steps were closed", so the
   * explanation is written from what actually happened rather than from what was expected.
   */
  async closeInstanceOnWithdrawal(input: {
    tenantId: string;
    approvalInstanceId: string;
    closedAt: Date;
  }) {
    const { tenantId } = input;

    return this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.leaveApprovalStepInstance.updateMany({
        where: {
          tenantId,
          approvalInstanceId: input.approvalInstanceId,
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });

      await tx.leaveApprovalInstance.update({
        where: { tenantId_id: { tenantId, id: input.approvalInstanceId } },
        data: { status: 'COMPLETED', completedAt: input.closedAt },
      });

      return cancelled.count;
    });
  }

  /**
   * The STEP instance a caller is addressing, read by its `(instance, order)` identity rather
   * than by id, because that is the coordinate the router works in.
   *
   * Named `findStepInstance` so boundary-spec rule 6 checks its tenant parameter. Returns `null`
   * rather than throwing: the service is the layer that decides whether an absent step is a 404
   * or a 409, and this layer has no opinion about the domain meaning of an empty read.
   */
  async findStepInstance(tenantId: string, approvalInstanceId: string, order: number) {
    return this.prisma.leaveApprovalStepInstance.findFirst({
      where: { tenantId, approvalInstanceId, order },
      include: LeaveApprovalRepository.STEP_LABEL,
    });
  }

  /**
   * What is WAITING for one person — the read
   * `LeaveApprovalStepInstance_tenantId_resolvedApprover_status_idx` exists to serve.
   *
   * `status: 'ACTIVE'` ONLY: a `PENDING` step is not yet that person's to decide (a predecessor
   * has not been decided), and returning it would put a step into somebody's queue that the
   * router has not asked them for. The index is declared on exactly this triple, so this is the
   * read it was created for and it stays an index scan as the table grows.
   *
   * `approvalInstance` is included with the request's SNAPSHOTTED range (§17.4) so an approver
   * sees the days they are being asked about, not the days the request has since been corrected
   * to — the same reason the instance copies that range at routing time.
   */
  async listAwaitingSteps(tenantId: string, approverEmployeeId: string) {
    return this.prisma.leaveApprovalStepInstance.findMany({
      where: { tenantId, resolvedApproverEmployeeId: approverEmployeeId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        ...LeaveApprovalRepository.STEP_LABEL,
        approvalInstance: {
          select: {
            id: true,
            leaveRequestId: true,
            requestStartDate: true,
            requestEndDate: true,
            stepCount: true,
          },
        },
      },
    });
  }
}
