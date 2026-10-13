import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { MissionRepository } from './mission.repository';
import { MissionApprovalRepository } from './mission-approval.repository';
import { MissionPolicyService } from './mission-policy.service';
import { MissionApprovalService } from './mission-approval.service';
import { EmployeeRepository } from '../employees/employees.repository';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HrNotificationGateway } from '../hr-notification.gateway';
import { HrActor } from '../hr-actor';
import {
  HR_AUDIT_ACTION,
  HR_AUDIT_RESOURCE,
  HR_DEFAULT_PAGE_SIZE,
  HR_MAX_PAGE_SIZE,
} from '../hr.constants';
import type { MissionRequestStatus } from '../domain/mission-status';
import {
  isMissionRequestRestatable,
  isTerminalMissionRequestStatus,
} from '../domain/mission-status';
import { validateMissionDateTime } from '../domain/mission-date-time';
import { validateMissionOptionSelections } from '../domain/mission-options';
import type {
  MissionFacts,
  MissionOptionGroupDefinition,
  MissionDurationMode,
} from '../domain/mission-options';

import type {
  CreateMissionRequestDto,
  UpdateMissionRequestDto,
  CancelMissionRequestDto,
  CreateMissionReportDto,
  CreateMissionOptionGroupDto,
  UpdateMissionOptionGroupDto,
  CreateMissionOptionDto,
  UpdateMissionOptionDto,
  CreateMissionApprovalDefinitionDto,
  UpdateMissionApprovalDefinitionDto,
} from '../dto/mission.dto';

function parseIsoDate(iso: string): Date | null {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDayKey(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return utc.toISOString().slice(0, 10);
}

function sanitizePage(page?: number, pageSize?: number): { skip: number; take: number } {
  const p = Math.max(1, page ?? 1);
  const size = Math.min(HR_MAX_PAGE_SIZE, Math.max(1, pageSize ?? HR_DEFAULT_PAGE_SIZE));
  return { skip: (p - 1) * size, take: size };
}

type ResolvedEmployee = { id: string };

/**
 * Phase 55: the Mission request, catalogue and configuration application service.
 *
 * The service owns orchestration: it translates DTOs into domain facts, resolves
 * policy through the Rule Engine, and writes audit and notifications. It does not
 * issue raw Prisma queries; persistence lives in `MissionRepository` and
 * `MissionApprovalRepository`.
 */
@Injectable()
export class MissionService {
  constructor(
    private readonly missionRepo: MissionRepository,
    private readonly approvalRepo: MissionApprovalRepository,
    private readonly approvals: MissionApprovalService,
    private readonly policy: MissionPolicyService,
    private readonly employees: EmployeeRepository,
    private readonly audit: HrAuditGateway,
    private readonly notifications: HrNotificationGateway
  ) {}

  private static throwIfNull<T>(value: T | null, message: string): T {
    if (value === null) throw new NotFoundException(message);
    return value;
  }

  // -------------------------------------------------------------------------
  // Actor/employee resolution
  // -------------------------------------------------------------------------

  private async resolveEmployee(actor: HrActor, employeeId?: string): Promise<ResolvedEmployee> {
    if (employeeId) {
      const employee = await this.employees.findById(actor.tenantId, employeeId);
      if (!employee) throw new NotFoundException('Employee not found.');
      return employee;
    }

    if (!actor.userId) {
      throw new ForbiddenException('No identity is resolved for this request.');
    }
    const employee = await this.employees.findByIdentityUserId(actor.tenantId, actor.userId);
    if (!employee) throw new ForbiddenException('No employee record is linked to this identity.');
    return employee;
  }

  // -------------------------------------------------------------------------
  // Options and facts
  // -------------------------------------------------------------------------

  private async resolveOptionDefinitions(
    tenantId: string
  ): Promise<readonly MissionOptionGroupDefinition[]> {
    const [groups] = await this.missionRepo.listOptionGroupPage(
      tenantId,
      {},
      { skip: 0, take: HR_MAX_PAGE_SIZE }
    );
    return groups.map((g) => ({
      code: g.code,
      required: g.required,
      options: g.options.map((o) => ({ code: o.code, active: o.active })),
    }));
  }

  private async validateSelectionsAndFacts(
    tenantId: string,
    selections: { optionGroupId: string; missionOptionId: string }[]
  ): Promise<MissionFacts> {
    const [groups] = await this.missionRepo.listOptionGroupPage(
      tenantId,
      { active: true },
      { skip: 0, take: HR_MAX_PAGE_SIZE }
    );
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const optionById = new Map<
      string,
      { id: string; optionGroupId: string; code: string; active: boolean }
    >();
    for (const g of groups) {
      for (const o of g.options) {
        optionById.set(o.id, o);
      }
    }

    const codedSelections: { groupCode: string; optionCode: string }[] = [];
    for (const s of selections) {
      const group = groupById.get(s.optionGroupId);
      if (!group) throw new BadRequestException('Unknown option group.');
      const option = optionById.get(s.missionOptionId);
      if (!option || option.optionGroupId !== group.id)
        throw new BadRequestException('Selected option does not belong to the group.');
      if (!option.active) throw new ConflictException('Selected option is inactive.');
      codedSelections.push({ groupCode: group.code, optionCode: option.code });
    }

    const definitions = await this.resolveOptionDefinitions(tenantId);
    const result = validateMissionOptionSelections(codedSelections, definitions);
    if (!result.ok) throw new BadRequestException(result.reason);
    return result.facts;
  }

  private resolveDatePeriod(dto: { startDate: string; endDate: string }): {
    startDate: Date;
    endDate: Date;
  } {
    const startDate = parseIsoDate(dto.startDate);
    const endDate = parseIsoDate(dto.endDate);
    if (!startDate) throw new BadRequestException('Invalid startDate.');
    if (!endDate) throw new BadRequestException('Invalid endDate.');
    return { startDate, endDate };
  }

  // -------------------------------------------------------------------------
  // Request lifecycle
  // -------------------------------------------------------------------------

  async create(actor: HrActor, dto: CreateMissionRequestDto) {
    const employee = await this.resolveEmployee(actor, dto.employeeId);
    const facts = await this.validateSelectionsAndFacts(actor.tenantId, dto.selections);
    const { startDate, endDate } = this.resolveDatePeriod(dto);
    const dateValidation = validateMissionDateTime({
      mode: facts.durationMode,
      startDate: dto.startDate,
      endDate: dto.endDate,
      startTime: dto.startTime,
      endTime: dto.endTime,
    });
    if (!dateValidation.ok) throw new BadRequestException(dateValidation.reason);

    const request = await this.missionRepo.createRequest(actor.tenantId, {
      employeeId: employee.id,
      durationMode: facts.durationMode,
      locationType: facts.locationType,
      engagementType: facts.engagementType,
      startDate,
      endDate,
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
      destination: dto.destination ?? null,
      description: dto.description ?? null,
    });

    await this.missionRepo.replaceOptionSelections(actor.tenantId, request.id, dto.selections);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: request.id,
      newValue: {
        employeeId: request.employeeId,
        durationMode: request.durationMode,
        locationType: request.locationType,
        engagementType: request.engagementType,
        startDate: toDayKey(request.startDate),
        endDate: toDayKey(request.endDate),
      },
    });

    return this.serializeRequest(request, { includeApproval: false });
  }

  async getById(actor: HrActor, id: string) {
    const request = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    return this.serializeRequest(request, { includeApproval: true });
  }

  async list(
    actor: HrActor,
    query: {
      page?: number;
      pageSize?: number;
      employeeId?: string;
      status?: MissionRequestStatus;
      durationMode?: MissionDurationMode;
      from?: string;
      to?: string;
    }
  ) {
    const window = sanitizePage(query.page, query.pageSize);
    let fromDate: Date | undefined;
    let toDate: Date | undefined;
    if (query.from !== undefined) {
      const parsed = parseIsoDate(query.from);
      if (parsed) fromDate = parsed;
    }
    if (query.to !== undefined) {
      const parsed = parseIsoDate(query.to);
      if (parsed) toDate = parsed;
    }
    const [requests, total] = await this.missionRepo.listRequestPage(
      actor.tenantId,
      {
        employeeId: query.employeeId,
        status: query.status,
        durationMode: query.durationMode,
        from: fromDate,
        to: toDate,
      },
      window
    );
    return {
      items: requests.map((r) => this.serializeRequest(r, { includeApproval: false })),
      total,
      page: query.page ?? 1,
      pageSize: window.take,
    };
  }

  async update(actor: HrActor, id: string, dto: UpdateMissionRequestDto) {
    const before = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    if (!isMissionRequestRestatable(before.status)) {
      throw new ConflictException(`A ${before.status} request cannot be restated.`);
    }

    let startDate: Date = before.startDate!;
    let endDate: Date = before.endDate!;
    if (dto.startDate !== undefined) {
      const parsed = parseIsoDate(dto.startDate);
      if (!parsed) throw new BadRequestException('Invalid startDate.');
      startDate = parsed;
    }
    if (dto.endDate !== undefined) {
      const parsed = parseIsoDate(dto.endDate);
      if (!parsed) throw new BadRequestException('Invalid endDate.');
      endDate = parsed;
    }

    let facts = {
      durationMode: before.durationMode,
      locationType: before.locationType,
      engagementType: before.engagementType,
    } as MissionFacts;
    let selections =
      before.optionSelections?.map((s) => ({
        optionGroupId: s.optionGroupId,
        missionOptionId: s.missionOptionId,
      })) ?? [];
    if (dto.selections && dto.selections.length > 0) {
      facts = await this.validateSelectionsAndFacts(actor.tenantId, dto.selections);
      selections = dto.selections;
    }

    const dateValidation = validateMissionDateTime({
      mode: facts.durationMode,
      startDate: toDayKey(startDate),
      endDate: toDayKey(endDate),
      startTime: dto.startTime ?? before.startTime ?? undefined,
      endTime: dto.endTime ?? before.endTime ?? undefined,
    });
    if (!dateValidation.ok) throw new BadRequestException(dateValidation.reason);

    const updated = await this.missionRepo.updateRequest(actor.tenantId, id, {
      durationMode: facts.durationMode,
      locationType: facts.locationType,
      engagementType: facts.engagementType,
      startDate: startDate as Date,
      endDate: endDate as Date,
      startTime: dto.startTime !== undefined ? (dto.startTime ?? null) : before.startTime,
      endTime: dto.endTime !== undefined ? (dto.endTime ?? null) : before.endTime,
      destination: dto.destination !== undefined ? (dto.destination ?? null) : before.destination,
      description: dto.description !== undefined ? (dto.description ?? null) : before.description,
    });

    if (dto.selections && dto.selections.length > 0) {
      await this.missionRepo.replaceOptionSelections(actor.tenantId, id, selections);
    }

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: updated.id,
      newValue: {
        status: updated.status,
        durationMode: updated.durationMode,
        locationType: updated.locationType,
      },
    });

    return this.serializeRequest(updated, { includeApproval: false });
  }

  async cancel(actor: HrActor, id: string, dto: CancelMissionRequestDto) {
    const before = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    if (isTerminalMissionRequestStatus(before.status)) {
      throw new ConflictException(`A ${before.status} request cannot be cancelled.`);
    }

    const cancelled = await this.missionRepo.markCancelled(actor.tenantId, id, new Date());
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CANCEL,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: cancelled.id,
      newValue: { status: cancelled.status, reason: dto.reason },
    });
    const refreshed = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    return this.serializeRequest(refreshed, { includeApproval: false });
  }

  // -------------------------------------------------------------------------
  // Submit / resubmit
  // -------------------------------------------------------------------------

  async submit(actor: HrActor, id: string) {
    const request = await this.requireRequestForSubmission(actor, id, 'DRAFT');
    return this.performSubmission(actor, request, 1, null);
  }

  async resubmit(actor: HrActor, id: string, dto: UpdateMissionRequestDto) {
    await this.requireRequestForSubmission(actor, id, 'CORRECTION_REQUIRED');
    await this.update(actor, id, dto);
    const request = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    const liveInstance = await this.approvalRepo.findLiveInstance(actor.tenantId, id);
    return this.performSubmission(
      actor,
      request,
      (request.submittedRevision ?? 0) + 1,
      liveInstance
    );
  }

  private async requireRequestForSubmission(
    actor: HrActor,
    id: string,
    expected: 'DRAFT' | 'CORRECTION_REQUIRED'
  ) {
    const request = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, id),
      'Mission request not found.'
    );
    if (request.status !== expected) {
      throw new ConflictException(
        `A ${request.status} request cannot be ${expected === 'DRAFT' ? 'submitted' : 'resubmitted'}.`
      );
    }
    return request;
  }

  private async performSubmission(
    actor: HrActor,
    request: NonNullable<Awaited<ReturnType<MissionRepository['findRequestById']>>>,
    submittedRevision: number,
    priorInstance: Awaited<ReturnType<MissionApprovalRepository['findLiveInstance']>> | null
  ) {
    const facts = await this.validateSelectionsAndFacts(
      actor.tenantId,
      (request.optionSelections ?? []).map((s) => ({
        optionGroupId: s.optionGroupId,
        missionOptionId: s.missionOptionId,
      }))
    );
    const dateValidation = validateMissionDateTime({
      mode: facts.durationMode,
      startDate: toDayKey(request.startDate),
      endDate: toDayKey(request.endDate),
      startTime: request.startTime ?? undefined,
      endTime: request.endTime ?? undefined,
    });
    if (!dateValidation.ok) throw new BadRequestException(dateValidation.reason);

    const decision = await this.policy.resolveDecision(actor, facts);
    const refresh = async () =>
      MissionService.throwIfNull(
        await this.missionRepo.findRequestById(actor.tenantId, request.id),
        'Mission request not found.'
      );

    if (decision.kind === 'AUTO_APPROVE') {
      const approvedAt = new Date();
      const submitOutbox = this.audit.buildOutboxPayload(actor, {
        action: HR_AUDIT_ACTION.SUBMIT,
        resource: HR_AUDIT_RESOURCE.MISSION,
        resourceId: request.id,
        newValue: { status: 'APPROVED', submittedRevision },
      });
      const approveOutbox = this.audit.buildOutboxPayload(actor, {
        action: HR_AUDIT_ACTION.APPROVE,
        resource: HR_AUDIT_RESOURCE.MISSION,
        resourceId: request.id,
        newValue: { status: 'APPROVED', ruleVersion: decision.versionLabel },
      });
      await this.missionRepo.submitAndAutoApprove(
        actor.tenantId,
        request.id,
        submittedRevision,
        approvedAt,
        [submitOutbox, approveOutbox],
      );
      const approved = await refresh();
      await this.notifications.notifyApproved(actor, approved.id, request.employeeId);
      return this.serializeRequest(approved, { includeApproval: true });
    }

    if (decision.kind === 'AUTO_REJECT') {
      const rejectedAt = new Date();
      const submitOutbox = this.audit.buildOutboxPayload(actor, {
        action: HR_AUDIT_ACTION.SUBMIT,
        resource: HR_AUDIT_RESOURCE.MISSION,
        resourceId: request.id,
        newValue: { status: 'REJECTED', submittedRevision },
      });
      const rejectOutbox = this.audit.buildOutboxPayload(actor, {
        action: HR_AUDIT_ACTION.REJECT,
        resource: HR_AUDIT_RESOURCE.MISSION,
        resourceId: request.id,
        newValue: {
          status: 'REJECTED',
          ruleVersion: decision.versionLabel,
          reasonCode: decision.reasonCode,
        },
      });
      await this.missionRepo.submitAndAutoReject(
        actor.tenantId,
        request.id,
        submittedRevision,
        rejectedAt,
        decision.reasonCode,
        [submitOutbox, rejectOutbox],
      );
      const rejected = await refresh();
      await this.notifications.notifyRejected(
        actor,
        rejected.id,
        request.employeeId,
        decision.reasonCode
      );
      return this.serializeRequest(rejected, { includeApproval: true });
    }

    if (decision.kind === 'REQUIRED_APPROVAL') {
      const definition = MissionService.throwIfNull(
        await this.approvalRepo.findDefinitionById(actor.tenantId, decision.approvalDefinitionId),
        'The approval definition selected by policy was not found.'
      );

      const sequenceNumber = priorInstance ? (priorInstance.sequenceNumber ?? 0) + 1 : 1;
      if (priorInstance) {
        await this.approvalRepo.supersedeInstance(actor.tenantId, priorInstance.id, new Date());
      }

      // Mark submitted first (non-transactional — the durable outbox is written
      // together with the IN_APPROVAL transition below).
      await this.missionRepo.markSubmitted(actor.tenantId, request.id, submittedRevision);

      const steps = await this.approvals.prepareInstanceSteps(
        actor.tenantId,
        definition,
        request.employeeId,
        { startDate: request.startDate, endDate: request.endDate }
      );

      const instance = MissionService.throwIfNull(
        await this.approvalRepo.openInstance({
          tenantId: actor.tenantId,
          missionRequestId: request.id,
          approvalDefinitionId: definition.id,
          submissionRevision: submittedRevision,
          routingMode: definition.routingMode,
          parallelCompletionMode: 'ALL_REQUIRED',
          selfApprovalMode: definition.selfApprovalMode,
          sequenceNumber,
          steps,
        }),
        'The approval instance was not created.'
      );

      const outbox = this.audit.buildOutboxPayload(actor, {
        action: priorInstance ? HR_AUDIT_ACTION.RESUBMIT : HR_AUDIT_ACTION.SUBMIT,
        resource: HR_AUDIT_RESOURCE.MISSION,
        resourceId: request.id,
        newValue: {
          status: 'IN_APPROVAL',
          submittedRevision,
          instanceId: instance.id,
          ruleVersion: decision.versionLabel,
        },
      });

      await this.missionRepo.markInApprovalDurable(actor.tenantId, request.id, outbox);
      const inApproval = await refresh();
      const approverIds = instance.steps
        .map((s) => s.resolvedApproverEmployeeId)
        .filter((id): id is string => id !== null);

      if (priorInstance) {
        await this.notifications.notifyResubmitted(
          actor,
          inApproval.id,
          request.employeeId,
          approverIds
        );
      } else {
        await this.notifications.notifySubmitted(
          actor,
          inApproval.id,
          request.employeeId,
          approverIds
        );
      }
      return this.serializeRequest(inApproval, { includeApproval: true });
    }

    throw new ConflictException('Mission policy did not produce a decision.');
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async submitReport(actor: HrActor, requestId: string, dto: CreateMissionReportDto) {
    const request = MissionService.throwIfNull(
      await this.missionRepo.findRequestById(actor.tenantId, requestId),
      'Mission request not found.'
    );
    if (request.status !== 'APPROVED') {
      throw new ConflictException('A report may only be submitted for an approved mission.');
    }
    const report = await this.missionRepo.createReport(actor.tenantId, {
      missionRequestId: requestId,
      employeeId: request.employeeId,
      content: dto.content,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: report.id,
      newValue: { missionRequestId: requestId },
    });
    return report;
  }

  async getReport(actor: HrActor, id: string) {
    const report = await this.missionRepo.findReportById(actor.tenantId, id);
    if (!report) throw new NotFoundException('Mission report not found.');
    return report;
  }

  // -------------------------------------------------------------------------
  // Option catalogue
  // -------------------------------------------------------------------------

  async listOptionGroups(
    actor: HrActor,
    query: { active?: boolean; page?: number; pageSize?: number }
  ) {
    const window = sanitizePage(query.page, query.pageSize);
    // THE REPOSITORY RETURNS A POSITIONAL TUPLE `[rows, count]`, and every OTHER list on this
    // service answers `{ items, total, page, pageSize }` — `list` above, and `LeaveService`'s
    // register before it. The tuple is destructured HERE rather than spread so the wire shape is
    // uniform: a caller that paged one list and then another must not have to switch shapes.
    const [items, total] = await this.missionRepo.listOptionGroupPage(
      actor.tenantId,
      { active: query.active },
      window
    );
    return {
      items,
      total,
      // The SAME two expressions `list` uses, so the echoed page is the EFFECTIVE one after
      // `sanitizePage` clamped it — a request for `pageSize=100000` is answered with the real
      // `HR_MAX_PAGE_SIZE`, not with the number that was asked for.
      page: query.page ?? 1,
      pageSize: window.take,
    };
  }

  async getOptionGroup(actor: HrActor, id: string) {
    return MissionService.throwIfNull(
      await this.missionRepo.findOptionGroupById(actor.tenantId, id),
      'Option group not found.'
    );
  }

  async createOptionGroup(actor: HrActor, dto: CreateMissionOptionGroupDto) {
    const group = await this.missionRepo.createOptionGroup(actor.tenantId, {
      code: dto.code,
      label: dto.label,
      required: dto.required,
      sortOrder: dto.sortOrder,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION_OPTION,
      resourceId: group.id,
      newValue: { code: group.code, label: group.label, required: group.required },
    });
    return group;
  }

  async updateOptionGroup(actor: HrActor, id: string, dto: UpdateMissionOptionGroupDto) {
    const group = await this.missionRepo.updateOptionGroup(actor.tenantId, id, {
      label: dto.label,
      required: dto.required,
      sortOrder: dto.sortOrder,
      active: dto.active,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.MISSION_OPTION,
      resourceId: group.id,
      newValue: { code: group.code, label: group.label, active: group.active },
    });
    return group;
  }

  async createOption(actor: HrActor, optionGroupId: string, dto: CreateMissionOptionDto) {
    await this.getOptionGroup(actor, optionGroupId);
    const option = await this.missionRepo.createOption(actor.tenantId, optionGroupId, {
      code: dto.code,
      label: dto.label,
      active: dto.active,
      sortOrder: dto.sortOrder,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION_OPTION,
      resourceId: option.id,
      newValue: { code: option.code, label: option.label, groupId: optionGroupId },
    });
    return option;
  }

  async updateOption(actor: HrActor, id: string, dto: UpdateMissionOptionDto) {
    const option = await this.missionRepo.updateOption(actor.tenantId, id, {
      label: dto.label,
      active: dto.active,
      sortOrder: dto.sortOrder,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.MISSION_OPTION,
      resourceId: option.id,
      newValue: { code: option.code, label: option.label, active: option.active },
    });
    return option;
  }

  // -------------------------------------------------------------------------
  // Approval definition configuration
  // -------------------------------------------------------------------------

  async listApprovalDefinitions(
    actor: HrActor,
    query: { status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT'; page?: number; pageSize?: number }
  ) {
    const window = sanitizePage(query.page, query.pageSize);
    // The same `[rows, count]` -> `{ items, total, page, pageSize }` normalization `list` and
    // `listOptionGroups` perform, for the same reason: one wire shape for every Mission list.
    const [items, total] = await this.approvalRepo.listDefinitionPage(
      actor.tenantId,
      { status: query.status },
      window
    );
    return {
      items,
      total,
      page: query.page ?? 1,
      pageSize: window.take,
    };
  }

  async getApprovalDefinition(actor: HrActor, id: string) {
    return MissionService.throwIfNull(
      await this.approvalRepo.findDefinitionById(actor.tenantId, id),
      'Approval definition not found.'
    );
  }

  async createApprovalDefinition(actor: HrActor, dto: CreateMissionApprovalDefinitionDto) {
    const definition = await this.approvalRepo.createDefinition(actor.tenantId, {
      name: dto.name,
      routingMode: dto.routingMode,
      parallelCompletionMode: 'ALL_REQUIRED',
      selfApprovalMode: dto.selfApprovalMode,
      steps: dto.steps.map((s) => ({
        order: s.order,
        name: s.name,
        approverEmployeeId: s.approverEmployeeId ?? null,
        approverRole: s.approverRole ?? null,
        required: s.required ?? true,
      })),
    });
    if (!definition) throw new ConflictException('Approval definition could not be created.');
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION_APPROVAL_DEFINITION,
      resourceId: definition.id,
      newValue: { name: definition.name, routingMode: definition.routingMode },
    });
    return definition;
  }

  async updateApprovalDefinition(
    actor: HrActor,
    id: string,
    dto: UpdateMissionApprovalDefinitionDto
  ) {
    const definition = await this.approvalRepo.updateDefinition(actor.tenantId, id, {
      name: dto.name,
      routingMode: dto.routingMode,
      selfApprovalMode: dto.selfApprovalMode,
      status: dto.status,
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.MISSION_APPROVAL_DEFINITION,
      resourceId: definition.id,
      newValue: { name: definition.name, status: definition.status },
    });
    return definition;
  }

  async replaceApprovalDefinitionSteps(
    actor: HrActor,
    id: string,
    steps: CreateMissionApprovalDefinitionDto['steps']
  ) {
    const definition = await this.getApprovalDefinition(actor, id);
    await this.approvalRepo.replaceDefinitionSteps(
      actor.tenantId,
      id,
      steps.map((s) => ({
        order: s.order,
        name: s.name,
        approverEmployeeId: s.approverEmployeeId ?? null,
        approverRole: s.approverRole ?? null,
        required: s.required ?? true,
      }))
    );
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.MISSION_APPROVAL_DEFINITION,
      resourceId: definition.id,
      newValue: { stepCount: steps.length },
    });
    return this.getApprovalDefinition(actor, id);
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  private serializeRequest(
    request: Awaited<ReturnType<MissionRepository['findRequestById']>>,
    opts: { includeApproval?: boolean }
  ) {
    if (!request) throw new NotFoundException('Mission request not found.');
    const latest = (request.approvalInstances ?? [])[0] ?? null;
    return {
      id: request.id,
      status: request.status,
      submittedRevision: request.submittedRevision,
      employee: request.employee
        ? { id: request.employee.id, employeeCode: request.employee.employeeCode }
        : null,
      durationMode: request.durationMode,
      locationType: request.locationType,
      engagementType: request.engagementType,
      startDate: toDayKey(request.startDate),
      endDate: toDayKey(request.endDate),
      startTime: request.startTime,
      endTime: request.endTime,
      destination: request.destination,
      description: request.description,
      // THE TWO DECISION REASONS THE REQUEST ITSELF CARRIES. They are scalar columns the repository
      // already returns (`findRequestById` uses `include`, never a narrower `select`), and the
      // correction and reject flows write them — but the serializer previously dropped them, so an
      // employee looking at a `CORRECTION_REQUIRED` request could not learn WHY it came back
      // without holding `hr.mission.approve` and reading the approval steps. That put the only
      // explanation of a refusal behind a DIFFERENT permission than the one that may act on it.
      //
      // `null` means "no decision of that kind was recorded", and it stays `null`: no fallback
      // sentence, no copy of the other field, no derivation. A reason is a statement a PERSON made
      // and only the row's own column may supply it.
      correctionReason: request.correctionReason,
      rejectionReason: request.rejectionReason,
      selections: (request.optionSelections ?? []).map((s) => ({
        optionGroupId: s.optionGroupId,
        missionOptionId: s.missionOptionId,
      })),
      approval: opts.includeApproval
        ? latest
          ? {
              id: latest.id,
              status: latest.status,
              routingMode: latest.routingMode,
            }
          : null
        : undefined,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    };
  }
}
