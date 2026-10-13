import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MissionApprovalRepository } from './mission-approval.repository';
import { LeaveApprovalRepository } from '../leave/leave-approval.repository';
import { MissionRepository } from './mission.repository';
import { EmployeeRepository } from '../employees/employees.repository';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HrNotificationGateway } from '../hr-notification.gateway';
import { HrActor } from '../hr-actor';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  resolveMissionApprovalDecisionability,
  resolveSequentialRouting,
  resolveParallelOutcome,
  isDecidableMissionApprovalStepStatus,
} from '../domain/mission-approval';
import type {
  MissionApprovalStepDecision,
  MissionStepState,
  MissionRequestStatus,
  MissionApprovalInstanceStatus,
} from '../domain/mission-approval';
type MissionApprovalDefinitionWithSteps = NonNullable<
  Awaited<ReturnType<MissionApprovalRepository['findDefinitionById']>>
>;

@Injectable()
export class MissionApprovalService {
  constructor(
    private readonly approvalRepo: MissionApprovalRepository,
    private readonly leaveApprovals: LeaveApprovalRepository,
    private readonly missionRepo: MissionRepository,
    private readonly employees: EmployeeRepository,
    private readonly audit: HrAuditGateway,
    private readonly notifications: HrNotificationGateway
  ) {}

  private static throwIfNull<T>(value: T | null, message: string): T {
    if (value === null) throw new NotFoundException(message);
    return value;
  }

  private async resolveActorEmployee(actor: HrActor) {
    if (!actor.userId) {
      throw new ForbiddenException('No identity is resolved for this request.');
    }
    const employee = await this.employees.findByIdentityUserId(actor.tenantId, actor.userId);
    if (!employee) throw new ForbiddenException('No employee record is linked to this identity.');
    return employee;
  }

  private toStepStates(
    steps: readonly { order: number; status: string; required?: boolean }[]
  ): MissionStepState[] {
    return steps.map((s) => ({
      order: s.order,
      status: s.status as MissionStepState['status'],
      required: s.required ?? true,
    }));
  }

  /**
   * Resolve the concrete approver for each definition step. Primary approver is the
   * configured employee; if an active Leave substitution covers the mission period,
   * the substitute acts instead. No fallback and no invented role resolver.
   */
  async prepareInstanceSteps(
    tenantId: string,
    definition: MissionApprovalDefinitionWithSteps,
    requesterEmployeeId: string,
    range: { startDate: Date; endDate: Date }
  ) {
    const primaryIds = definition.steps
      .map((s) => s.approverEmployeeId)
      .filter((id): id is string => id !== null && id !== undefined);

    const substitutions: { primaryEmployeeId: string; id: string; substituteEmployeeId: string }[] =
      primaryIds.length > 0
        ? await this.leaveApprovals.listEffectiveSubstitutions(tenantId, primaryIds, range)
        : [];
    const substituteByPrimary = new Map<string, { id: string; substituteEmployeeId: string }>();
    for (const sub of substitutions) {
      if (!substituteByPrimary.has(sub.primaryEmployeeId)) {
        substituteByPrimary.set(sub.primaryEmployeeId, {
          id: sub.id,
          substituteEmployeeId: sub.substituteEmployeeId,
        });
      }
    }

    return definition.steps.map((step) => {
      if (step.approverRole && (!step.approverEmployeeId || step.approverEmployeeId.length === 0)) {
        throw new ConflictException(
          'Role-based approver resolution is not available for Mission; the step must name a concrete approverEmployeeId.'
        );
      }

      if (!step.approverEmployeeId || step.approverEmployeeId.length === 0) {
        return {
          approvalStepDefinitionId: step.id,
          order: step.order,
          resolvedApproverEmployeeId: null,
          resolutionReason: 'NO_RESOLUTION' as const,
          resolutionSignal: null,
        };
      }

      const substitute = substituteByPrimary.get(step.approverEmployeeId);
      if (substitute) {
        return {
          approvalStepDefinitionId: step.id,
          order: step.order,
          resolvedApproverEmployeeId: substitute.substituteEmployeeId,
          resolutionReason: 'SUBSTITUTE' as const,
          resolutionSignal: substitute.id,
        };
      }

      return {
        approvalStepDefinitionId: step.id,
        order: step.order,
        resolvedApproverEmployeeId: step.approverEmployeeId,
        resolutionReason: 'PRIMARY' as const,
        resolutionSignal: null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Queue / detail
  // -------------------------------------------------------------------------

  async listPendingApprovals(actor: HrActor) {
    const actorEmployee = await this.resolveActorEmployee(actor);
    const stepRows = await this.approvalRepo.listActiveStepsForApprover(
      actor.tenantId,
      actorEmployee.id
    );
    const requestIds = [
      ...new Set(
        stepRows.map((s: { instance: { missionRequestId: string } }) => s.instance.missionRequestId)
      ),
    ];
    const requests = await Promise.all(
      requestIds.map((id) => this.missionRepo.findRequestById(actor.tenantId, id))
    );
    return requests
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => this.serializeRequest(r));
  }

  async getApprovalDetail(actor: HrActor, requestId: string) {
    const request = MissionApprovalService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, requestId),
      'Mission request not found.'
    );
    const actorEmployee = await this.resolveActorEmployee(actor);
    const instance = await this.approvalRepo.findLiveInstance(actor.tenantId, requestId);
    if (!instance) return { request: this.serializeRequest(request), instance: null };

    const activeSteps = instance.steps.filter((s) => s.status === 'ACTIVE');
    const canDecideAny = activeSteps.some((s) =>
      this.isDecider(
        actorEmployee.id,
        s.resolvedApproverEmployeeId,
        request.employeeId,
        instance.selfApprovalMode
      )
    );
    return {
      request: this.serializeRequest(request),
      instance: {
        id: instance.id,
        status: instance.status,
        routingMode: instance.routingMode,
        sequenceNumber: instance.sequenceNumber,
        submissionRevision: instance.submissionRevision,
        canDecide: canDecideAny,
        steps: instance.steps.map((s) => ({
          order: s.order,
          status: s.status,
          decision: s.decision,
          decisionReason: s.decisionReason,
          decidedByEmployeeId: s.decidedByEmployeeId,
          resolvedApproverEmployeeId: s.resolvedApproverEmployeeId,
          resolutionReason: s.resolutionReason,
          decidableByActor: this.isDecider(
            actorEmployee.id,
            s.resolvedApproverEmployeeId,
            request.employeeId,
            instance.selfApprovalMode
          ),
        })),
      },
    };
  }

  private isDecider(
    deciderEmployeeId: string,
    resolvedApproverEmployeeId: string | null,
    requesterEmployeeId: string,
    selfApprovalMode: 'NOT_ALLOWED' | 'ALLOWED'
  ): boolean {
    const result = resolveMissionApprovalDecisionability({
      deciderEmployeeId,
      resolvedApproverEmployeeId,
      requesterEmployeeId,
      selfApprovalMode,
    });
    return result.decidableByActor;
  }

  private serializeRequest(request: Awaited<ReturnType<MissionRepository['findRequestById']>>) {
    if (!request) throw new NotFoundException('Mission request not found.');
    const toDay = (d: Date) =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        .toISOString()
        .slice(0, 10);
    return {
      id: request.id,
      status: request.status,
      employeeId: request.employeeId,
      durationMode: request.durationMode,
      locationType: request.locationType,
      engagementType: request.engagementType,
      startDate: toDay(request.startDate),
      endDate: toDay(request.endDate),
      startTime: request.startTime,
      endTime: request.endTime,
      destination: request.destination,
      description: request.description,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  async approve(actor: HrActor, requestId: string, reason: string | null) {
    return this.decide(actor, requestId, 'APPROVED', reason ?? null);
  }

  async reject(actor: HrActor, requestId: string, reason: string) {
    if (!reason || reason.trim().length === 0)
      throw new ConflictException('Rejection reason is required.');
    return this.decide(actor, requestId, 'REJECTED', reason);
  }

  async requestCorrection(actor: HrActor, requestId: string, reason: string) {
    if (!reason || reason.trim().length === 0)
      throw new ConflictException('Correction reason is required.');
    return this.decide(actor, requestId, 'CORRECTION_REQUIRED', reason);
  }

  private async decide(
    actor: HrActor,
    requestId: string,
    decision: MissionApprovalStepDecision,
    reason: string | null
  ) {
    const request = MissionApprovalService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, requestId),
      'Mission request not found.'
    );
    if (request.status !== 'IN_APPROVAL') {
      throw new ConflictException(`A ${request.status} request is not in approval.`);
    }

    const instance = await this.approvalRepo.findLiveInstance(actor.tenantId, requestId);
    if (!instance || !instance.steps.some((s) => s.status === 'ACTIVE')) {
      throw new ConflictException('No active approval step is currently decisionable.');
    }

    const actorEmployee = await this.resolveActorEmployee(actor);
    const activeSteps = instance.steps.filter((s) =>
      isDecidableMissionApprovalStepStatus(s.status)
    );
    const eligibleStep = activeSteps.find((s) =>
      this.isDecider(
        actorEmployee.id,
        s.resolvedApproverEmployeeId,
        request.employeeId,
        instance.selfApprovalMode
      )
    );
    if (!eligibleStep) {
      throw new ForbiddenException(
        'You are not the resolved approver of any currently active step.'
      );
    }

    const stepStates = this.toStepStates(instance.steps);
    const pendingDisposition =
      decision === 'REJECTED' ? 'SKIP' : decision === 'CORRECTION_REQUIRED' ? 'CANCEL' : null;

    let requestStatus: MissionRequestStatus;
    let instanceStatus: MissionApprovalInstanceStatus;
    let nextStepOrder: number | null = null;

    if (instance.routingMode === 'SEQUENTIAL') {
      const routing = resolveSequentialRouting({
        decision,
        order: eligibleStep.order,
        stepCount: instance.steps.length,
        hasNextStep: eligibleStep.order < instance.steps.length,
      });
      requestStatus = routing.requestStatus;
      instanceStatus = routing.instanceStatus;
      nextStepOrder = routing.nextStepOrder;
    } else {
      const nextStates = stepStates.map((s) =>
        s.order === eligibleStep.order
          ? { ...s, status: decision as MissionStepState['status'] }
          : s
      );
      const outcome = resolveParallelOutcome(nextStates);
      requestStatus = outcome.requestStatus;
      instanceStatus = outcome.instanceStatus;
    }

    const decidedAt = new Date();

    const action =
      decision === 'APPROVED'
        ? HR_AUDIT_ACTION.APPROVE
        : decision === 'REJECTED'
          ? HR_AUDIT_ACTION.REJECT
          : HR_AUDIT_ACTION.CORRECTION;
    const outbox = this.audit.buildOutboxPayload(actor, {
      action,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: request.id,
      newValue: { status: requestStatus, stepOrder: eligibleStep.order, reason },
    });

    await this.approvalRepo.recordDecision({
      tenantId: actor.tenantId,
      missionRequestId: request.id,
      approvalInstanceId: instance.id,
      stepOrder: eligibleStep.order,
      decision,
      decidedByEmployeeId: actorEmployee.id,
      decisionReason: reason,
      decidedAt,
      requestStatus,
      instanceStatus,
      nextStepOrder,
      pendingDisposition,
      outbox,
    });

    const refreshed = MissionApprovalService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, requestId),
      'Mission request not found.'
    );

    if (
      decision === 'APPROVED' &&
      (requestStatus === 'APPROVED' || instanceStatus === 'COMPLETED')
    ) {
      await this.notifications.notifyApproved(actor, request.id, request.employeeId);
    } else if (decision === 'APPROVED' && instanceStatus === 'ACTIVE' && nextStepOrder !== null) {
      const next = await this.approvalRepo.describeInstance(actor.tenantId, instance.id);
      const nextStep = next?.steps.find((s) => s.order === nextStepOrder && s.status === 'ACTIVE');
      if (nextStep?.resolvedApproverEmployeeId) {
        await this.notifications.notifyNextApprover(actor, request.id, request.employeeId, [
          nextStep.resolvedApproverEmployeeId,
        ]);
      }
    } else if (decision === 'REJECTED') {
      await this.notifications.notifyRejected(actor, request.id, request.employeeId, reason);
    } else if (decision === 'CORRECTION_REQUIRED') {
      await this.notifications.notifyCorrection(actor, request.id, request.employeeId, reason);
    }

    return this.serializeRequest(refreshed);
  }
}
