import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type {
  MissionApprovalInstanceStatus,
  MissionApprovalStepDecision,
  MissionApprovalStepStatus,
} from '../domain/mission-approval';
import type { MissionRoutingMode } from '../domain/mission-approval';
import type { MissionRequestStatus } from '../domain/mission-status';
import type { HrAuditOutboxPayload } from '../hr-audit.gateway';

/**
 * Phase 55: the Mission approval configuration and runtime persistence boundary.
 *
 * WHY ONE FILE COVERS CONFIGURATION AND RUNTIME
 * ---------------------------------------------
 * `MissionApprovalDefinition` → `MissionApprovalDefinitionStep` (configuration) and
 * `MissionApprovalInstance` → `MissionApprovalStepInstance` (runtime) are one fact about
 * who is asked and what they stated. The service that configures the flow and the service
 * that records decisions both read the same shape, and keeping them in one file means the
 * tenant scoping is written once.
 *
 * WHY NO RULES
 * ------------
 * This file writes what it is told. It does not decide whether a step is last, whether a
 * decision is allowed, or whether an actor may decide. Those are domain/service questions.
 *
 * HISTORY IS IMMUTABLE
 * --------------------
 * A step row is written once: its decision fields are set by `recordStepDecision` and are
 * never overwritten. Resubmission creates a NEW instance.
 */

@Injectable()
export class MissionApprovalRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  private static readonly STEP_LABEL = {
    resolvedApprover: { select: { id: true, employeeCode: true } },
    decidedBy: { select: { id: true, employeeCode: true } },
  } as const;

  // -------------------------------------------------------------------------
  // Approval definition (configuration)
  // -------------------------------------------------------------------------

  /** One page of the tenant's approval definitions, ordered by name. */
  async listDefinitionPage(
    tenantId: string,
    filter: { status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT' },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.missionApprovalDefinition.findMany({
        where,
        orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.missionApprovalDefinition.count({ where }),
    ]);
  }

  /** One definition plus its ordered steps, or `null` for another tenant. */
  async findDefinitionById(tenantId: string, id: string) {
    return this.prisma.missionApprovalDefinition.findFirst({
      where: { id, tenantId },
      include: {
        steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  /** Create a definition and its steps in one transaction. */
  async createDefinition(
    tenantId: string,
    data: {
      name: string;
      routingMode: MissionRoutingMode;
      parallelCompletionMode: 'ALL_REQUIRED';
      selfApprovalMode: 'NOT_ALLOWED' | 'ALLOWED';
      ruleSetId?: string;
      steps: {
        order: number;
        name: string;
        approverEmployeeId?: string | null;
        approverRole?: string | null;
        required?: boolean;
      }[];
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const definition = await tx.missionApprovalDefinition.create({
        data: {
          tenantId,
          name: data.name,
          routingMode: data.routingMode,
          parallelCompletionMode: data.parallelCompletionMode,
          selfApprovalMode: data.selfApprovalMode,
          ...(data.ruleSetId !== undefined ? { ruleSetId: data.ruleSetId } : {}),
        },
      });

      if (data.steps.length > 0) {
        await tx.missionApprovalDefinitionStep.createMany({
          data: data.steps.map((s) => ({
            tenantId,
            approvalDefinitionId: definition.id,
            order: s.order,
            name: s.name,
            approverEmployeeId: s.approverEmployeeId ?? null,
            approverRole: s.approverRole ?? null,
            required: s.required ?? true,
          })),
        });
      }

      return tx.missionApprovalDefinition.findFirst({
        where: { id: definition.id, tenantId },
        include: {
          steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
        },
      });
    });
  }

  async updateDefinition(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      routingMode?: MissionRoutingMode;
      parallelCompletionMode?: 'ALL_REQUIRED';
      selfApprovalMode?: 'NOT_ALLOWED' | 'ALLOWED';
      status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT';
    }
  ) {
    return this.prisma.missionApprovalDefinition.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.routingMode !== undefined ? { routingMode: data.routingMode } : {}),
        ...(data.parallelCompletionMode !== undefined
          ? { parallelCompletionMode: data.parallelCompletionMode }
          : {}),
        ...(data.selfApprovalMode !== undefined ? { selfApprovalMode: data.selfApprovalMode } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
  }

  /** Ordered steps of one definition, scoped to the tenant. */
  async listDefinitionSteps(tenantId: string, approvalDefinitionId: string) {
    return this.prisma.missionApprovalDefinitionStep.findMany({
      where: { tenantId, approvalDefinitionId },
      orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }],
    });
  }

  /** Replace the ordered steps of a definition atomically. */
  async replaceDefinitionSteps(
    tenantId: string,
    approvalDefinitionId: string,
    steps: {
      order: number;
      name: string;
      approverEmployeeId: string | null;
      approverRole: string | null;
      required: boolean;
    }[]
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.missionApprovalDefinitionStep.deleteMany({
        where: { tenantId, approvalDefinitionId },
      });
      if (steps.length > 0) {
        await tx.missionApprovalDefinitionStep.createMany({
          data: steps.map((s) => ({
            tenantId,
            approvalDefinitionId,
            order: s.order,
            name: s.name,
            approverEmployeeId: s.approverEmployeeId,
            approverRole: s.approverRole,
            required: s.required,
          })),
        });
      }
      return tx.missionApprovalDefinition.findFirst({
        where: { id: approvalDefinitionId, tenantId },
        include: { steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] } },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Approval instance (runtime)
  // -------------------------------------------------------------------------

  /** The request's live instance, or `null`. */
  async findLiveInstance(tenantId: string, missionRequestId: string) {
    return this.prisma.missionApprovalInstance.findFirst({
      where: { tenantId, missionRequestId, status: 'ACTIVE' },
      include: {
        steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  /** All instances of a request, newest first. */
  async listInstances(tenantId: string, missionRequestId: string) {
    return this.prisma.missionApprovalInstance.findMany({
      where: { tenantId, missionRequestId },
      orderBy: [{ sequenceNumber: 'desc' as const }, { id: 'asc' as const }],
      include: {
        steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  /** Active steps for which `employeeId` is the resolved approver. */
  async listActiveStepsForApprover(tenantId: string, employeeId: string) {
    return this.prisma.missionApprovalStepInstance.findMany({
      where: { tenantId, resolvedApproverEmployeeId: employeeId, status: 'ACTIVE' },
      orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }],
      include: { instance: { select: { missionRequestId: true } } },
    });
  }

  /** One instance with its ordered steps and labels, or `null`. */
  async describeInstance(tenantId: string, approvalInstanceId: string) {
    return this.prisma.missionApprovalInstance.findFirst({
      where: { id: approvalInstanceId, tenantId },
      include: {
        steps: {
          orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }],
          include: MissionApprovalRepository.STEP_LABEL,
        },
        definition: { select: { id: true, name: true } },
      },
    });
  }

  /** Open an instance and its steps in one transaction. */
  async openInstance(input: {
    tenantId: string;
    missionRequestId: string;
    approvalDefinitionId: string;
    submissionRevision: number;
    routingMode: MissionRoutingMode;
    parallelCompletionMode: 'ALL_REQUIRED';
    selfApprovalMode: 'NOT_ALLOWED' | 'ALLOWED';
    sequenceNumber: number;
    steps: {
      approvalStepDefinitionId: string;
      order: number;
      resolvedApproverEmployeeId: string | null;
      resolutionReason: 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';
      resolutionSignal: string | null;
    }[];
  }) {
    const { tenantId } = input;

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.missionApprovalInstance.create({
        data: {
          tenantId,
          missionRequestId: input.missionRequestId,
          approvalDefinitionId: input.approvalDefinitionId,
          submissionRevision: input.submissionRevision,
          sequenceNumber: input.sequenceNumber,
          status: 'ACTIVE',
          routingMode: input.routingMode,
          parallelCompletionMode: input.parallelCompletionMode,
          selfApprovalMode: input.selfApprovalMode,
        },
      });

      if (input.steps.length > 0) {
        await tx.missionApprovalStepInstance.createMany({
          data: input.steps.map((s) => ({
            tenantId,
            approvalInstanceId: instance.id,
            approvalStepDefinitionId: s.approvalStepDefinitionId,
            order: s.order,
            status: (input.routingMode === 'PARALLEL' || s.order === input.steps[0].order
              ? 'ACTIVE'
              : 'PENDING') as MissionApprovalStepStatus,
            resolvedApproverEmployeeId: s.resolvedApproverEmployeeId,
            resolutionReason: s.resolutionReason,
            resolutionSignal: s.resolutionSignal,
          })),
        });
      }

      return tx.missionApprovalInstance.findFirst({
        where: { id: instance.id, tenantId },
        include: {
          steps: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
        },
      });
    });
  }

  /** Supersede the current instance before opening a new one on resubmission. */
  async supersedeInstance(tenantId: string, approvalInstanceId: string, supersededAt: Date) {
    return this.prisma.missionApprovalInstance.update({
      where: { tenantId_id: { tenantId, id: approvalInstanceId } },
      data: { status: 'SUPERSEDED', supersededAt },
    });
  }

  /** Record one step decision. The service has already computed the outcome. */
  async recordStepDecision(input: {
    tenantId: string;
    approvalInstanceId: string;
    stepOrder: number;
    decision: MissionApprovalStepDecision;
    decidedByEmployeeId: string;
    decisionReason: string | null;
    decidedAt: Date;
  }) {
    const { tenantId } = input;
    return this.prisma.missionApprovalStepInstance.updateMany({
      where: {
        tenantId,
        approvalInstanceId: input.approvalInstanceId,
        order: input.stepOrder,
        status: 'ACTIVE',
      },
      data: {
        status: input.decision as MissionApprovalStepStatus,
        decision: input.decision,
        decidedByEmployeeId: input.decidedByEmployeeId,
        decisionReason: input.decisionReason,
        decidedAt: input.decidedAt,
      },
    });
  }

  /**
   * Phase 55: record one step decision, update the request and the instance, and adjust
   * remaining pending steps — all inside one transaction. This is the narrow extension
   * the service integration proves necessary: `recordStepDecision` only writes the step,
   * while the approval flow also needs the request and instance state to move atomically.
   */
  async recordDecision(input: {
    tenantId: string;
    missionRequestId: string;
    approvalInstanceId: string;
    stepOrder: number;
    decision: MissionApprovalStepDecision;
    decidedByEmployeeId: string;
    decisionReason: string | null;
    decidedAt: Date;
    requestStatus: MissionRequestStatus;
    instanceStatus: MissionApprovalInstanceStatus;
    nextStepOrder: number | null;
    pendingDisposition: 'SKIP' | 'CANCEL' | null;
    outbox?: HrAuditOutboxPayload;
  }) {
    const {
      tenantId,
      missionRequestId,
      approvalInstanceId,
      stepOrder,
      nextStepOrder,
      pendingDisposition,
    } = input;
    const { decidedAt } = input;

    const requestData: Record<string, unknown> = { status: input.requestStatus };
    if (input.requestStatus === 'APPROVED') {
      requestData.approvedAt = decidedAt;
    } else if (input.requestStatus === 'REJECTED') {
      requestData.rejectedAt = decidedAt;
      requestData.rejectionReason = input.decisionReason ?? '';
    } else if (input.requestStatus === 'CORRECTION_REQUIRED') {
      requestData.correctionReason = input.decisionReason ?? '';
    }

    const instanceData: Record<string, unknown> = { status: input.instanceStatus };
    if (input.instanceStatus !== 'ACTIVE') {
      instanceData.completedAt = decidedAt;
    }

    const pendingUpdate =
      pendingDisposition === 'SKIP'
        ? { status: 'SKIPPED' as MissionApprovalStepStatus }
        : { status: 'CANCELLED' as MissionApprovalStepStatus };

    return this.prisma.$transaction(async (tx) => {
      await tx.missionApprovalStepInstance.updateMany({
        where: {
          tenantId,
          approvalInstanceId,
          order: stepOrder,
          status: 'ACTIVE',
        },
        data: {
          status: input.decision as MissionApprovalStepStatus,
          decision: input.decision,
          decidedByEmployeeId: input.decidedByEmployeeId,
          decisionReason: input.decisionReason,
          decidedAt,
        },
      });
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id: missionRequestId } },
        data: requestData,
      });
      await tx.missionApprovalInstance.update({
        where: { tenantId_id: { tenantId, id: approvalInstanceId } },
        data: instanceData,
      });
      if (nextStepOrder !== null) {
        await tx.missionApprovalStepInstance.updateMany({
          where: { tenantId, approvalInstanceId, order: nextStepOrder, status: 'PENDING' },
          data: { status: 'ACTIVE' as MissionApprovalStepStatus },
        });
      }
      if (pendingDisposition !== null) {
        await tx.missionApprovalStepInstance.updateMany({
          where: { tenantId, approvalInstanceId, status: 'PENDING' },
          data: pendingUpdate,
        });
      }
      if (input.outbox) {
        await tx.auditOutbox.create({ data: input.outbox });
      }
    });
  }

  /** Activate the next step in the same transaction as the decision that caused it. */
  async activateStep(tenantId: string, approvalInstanceId: string, stepOrder: number) {
    return this.prisma.missionApprovalStepInstance.updateMany({
      where: { tenantId, approvalInstanceId, order: stepOrder },
      data: { status: 'ACTIVE' },
    });
  }

  /** Close still-pending steps after a rejection or withdrawal. */
  async skipRemainingSteps(tenantId: string, approvalInstanceId: string) {
    return this.prisma.missionApprovalStepInstance.updateMany({
      where: { tenantId, approvalInstanceId, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
  }

  /** Close still-pending steps after a withdrawal. */
  async cancelRemainingSteps(tenantId: string, approvalInstanceId: string) {
    return this.prisma.missionApprovalStepInstance.updateMany({
      where: { tenantId, approvalInstanceId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  }

  /** Mark the instance as completed/rejected/correction-required. */
  async markInstanceStatus(
    tenantId: string,
    approvalInstanceId: string,
    status: MissionApprovalInstanceStatus,
    completedAt: Date | null
  ) {
    return this.prisma.missionApprovalInstance.update({
      where: { tenantId_id: { tenantId, id: approvalInstanceId } },
      data: {
        status,
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
    });
  }
}
