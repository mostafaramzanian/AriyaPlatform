import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type {
  MissionDurationMode,
  MissionEngagementType,
  MissionLocationType,
} from '../domain/mission-options';
import type { MissionRequestStatus } from '../domain/mission-status';
import type { HrAuditOutboxPayload } from '../hr-audit.gateway';

/**
 * Phase 55: the Mission request, option catalogue, selections and report persistence
 * boundary.
 *
 * WHY ONE FILE COVERS REQUEST, OPTIONS AND REPORTS
 * ------------------------------------------------
 * A Mission request, its option catalogue and its post-approval report are one fact
 * about one tenant. The composite `(tenant_id, ...)` foreign keys keep them together,
 * and a single reader can see every statement that pairs them.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * This file owns INSERTs, UPDATEs and tenant-scoped SELECTs. It does NOT decide
 * whether a date is valid, whether an option is active, or whether a transition is
 * allowed. Those decisions live in the pure domain and, later, in the service layer.
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every method and appears in every `where`.
 * `findUnique` is never used: it cannot carry a tenant predicate.
 */

@Injectable()
export class MissionRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  private static readonly REQUEST_LABEL = {
    employee: { select: { id: true, employeeCode: true } },
    optionSelections: {
      orderBy: { createdAt: 'asc' as const },
      include: {
        optionGroup: { select: { id: true, code: true, label: true } },
        option: { select: { id: true, code: true, label: true } },
      },
    },
    approvalInstances: {
      orderBy: { sequenceNumber: 'desc' as const },
      take: 1,
    },
  } as const;

  // -------------------------------------------------------------------------
  // MissionRequest
  // -------------------------------------------------------------------------

  /**
   * The tenant predicate of EVERY request read in this file — ONE builder, so the page
   * read, the total and the per-status counts can never disagree about what a filter
   * meant (the exact reasoning `LeaveRepository.buildRequestWhere` states for leave).
   *
   * `from` / `to` are already-resolved `Date` bounds and mean INTERSECTION with a
   * request's own period — `endDate >= from` and `startDate <= to`.
   */
  private static buildRequestWhere(
    tenantId: string,
    filter: {
      employeeId?: string;
      status?: MissionRequestStatus;
      durationMode?: MissionDurationMode;
      from?: Date;
      to?: Date;
    }
  ) {
    return {
      tenantId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.durationMode ? { durationMode: filter.durationMode } : {}),
      ...(filter.to ? { startDate: { lte: filter.to } } : {}),
      ...(filter.from ? { endDate: { gte: filter.from } } : {}),
    };
  }

  /** One page of the tenant's Mission requests as `[rows, total]`, newest first. */
  async listRequestPage(
    tenantId: string,
    filter: {
      employeeId?: string;
      status?: MissionRequestStatus;
      durationMode?: MissionDurationMode;
      from?: Date;
      to?: Date;
    },
    window: { skip: number; take: number }
  ) {
    const where = MissionRepository.buildRequestWhere(tenantId, filter);

    return this.prisma.$transaction([
      this.prisma.missionRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        include: MissionRepository.REQUEST_LABEL,
      }),
      this.prisma.missionRequest.count({ where }),
    ]);
  }

  /**
   * Per-status COUNTS over the SAME filter the page read answers — one bounded
   * `groupBy` on the ONE shared predicate, so the summary strip, the chart and the
   * table cannot disagree.
   */
  async countByStatus(
    tenantId: string,
    filter: {
      employeeId?: string;
      status?: MissionRequestStatus;
      durationMode?: MissionDurationMode;
      from?: Date;
      to?: Date;
    }
  ): Promise<Map<MissionRequestStatus, number>> {
    const rows = await this.prisma.missionRequest.groupBy({
      by: ['status'],
      where: MissionRepository.buildRequestWhere(tenantId, filter),
      _count: { status: true },
    });

    return new Map(rows.map((row) => [row.status as MissionRequestStatus, row._count.status]));
  }

  /** One request plus its labels, or `null` for another tenant's row. */
  async findRequestById(tenantId: string, id: string) {
    return this.prisma.missionRequest.findFirst({
      where: { id, tenantId },
      include: MissionRepository.REQUEST_LABEL,
    });
  }

  /** The CREATE for a Mission request. `status` is the schema default `DRAFT`. */
  async createRequest(
    tenantId: string,
    data: {
      employeeId: string;
      durationMode: MissionDurationMode;
      locationType: MissionLocationType;
      engagementType: MissionEngagementType;
      startDate: Date;
      endDate: Date;
      startTime?: string | null;
      endTime?: string | null;
      destination?: string | null;
      description?: string | null;
    }
  ) {
    return this.prisma.missionRequest.create({
      data: {
        tenantId,
        employeeId: data.employeeId,
        durationMode: data.durationMode,
        locationType: data.locationType,
        engagementType: data.engagementType,
        startDate: data.startDate,
        endDate: data.endDate,
        ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
        ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
        ...(data.destination !== undefined ? { destination: data.destination } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
      include: MissionRepository.REQUEST_LABEL,
    });
  }

  /** Restate the editable content of a request while it is still restatable. */
  async updateRequest(
    tenantId: string,
    id: string,
    data: {
      durationMode?: MissionDurationMode;
      locationType?: MissionLocationType;
      engagementType?: MissionEngagementType;
      startDate?: Date;
      endDate?: Date;
      startTime?: string | null;
      endTime?: string | null;
      destination?: string | null;
      description?: string | null;
    }
  ) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.durationMode !== undefined ? { durationMode: data.durationMode } : {}),
        ...(data.locationType !== undefined ? { locationType: data.locationType } : {}),
        ...(data.engagementType !== undefined ? { engagementType: data.engagementType } : {}),
        ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
        ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
        ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
        ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
        ...(data.destination !== undefined ? { destination: data.destination } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
      include: MissionRepository.REQUEST_LABEL,
    });
  }

  /** SUBMITTED: the request is handed to the routing layer. */
  async markSubmitted(tenantId: string, id: string, submittedRevision: number) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'SUBMITTED', submittedRevision },
    });
  }

  /** IN_APPROVAL: the request is under active routing. */
  async markInApproval(tenantId: string, id: string) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'IN_APPROVAL' },
    });
  }

  /** APPROVED: the last step approved. */
  async markApproved(tenantId: string, id: string, approvedAt: Date) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'APPROVED', approvedAt },
    });
  }

  /** REJECTED: a step rejected. */
  async markRejected(tenantId: string, id: string, rejectedAt: Date, rejectionReason: string) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'REJECTED', rejectedAt, rejectionReason },
    });
  }

  /** CANCELLED: withdrawn by the requester. */
  async markCancelled(tenantId: string, id: string, cancelledAt: Date) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'CANCELLED', cancelledAt },
    });
  }

  /** CORRECTION_REQUIRED: a step requested correction. */
  async markCorrectionRequired(tenantId: string, id: string, correctionReason: string) {
    return this.prisma.missionRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'CORRECTION_REQUIRED', correctionReason },
    });
  }

  // -------------------------------------------------------------------------
  // Phase B2.5: transactional durable submission paths
  // -------------------------------------------------------------------------

  /**
   * AUTO-APPROVE: mark SUBMITTED then APPROVED, with durable outbox events, in
   * one transaction. Two outbox rows (SUBMIT + APPROVE) commit atomically with
   * the two status transitions.
   */
  async submitAndAutoApprove(
    tenantId: string,
    id: string,
    submittedRevision: number,
    approvedAt: Date,
    outboxes: HrAuditOutboxPayload[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'SUBMITTED', submittedRevision },
      });
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'APPROVED', approvedAt },
      });
      for (const ob of outboxes) {
        await tx.auditOutbox.create({ data: ob });
      }
    });
  }

  /**
   * AUTO-REJECT: mark SUBMITTED then REJECTED, with durable outbox events, in
   * one transaction.
   */
  async submitAndAutoReject(
    tenantId: string,
    id: string,
    submittedRevision: number,
    rejectedAt: Date,
    rejectionReason: string,
    outboxes: HrAuditOutboxPayload[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'SUBMITTED', submittedRevision },
      });
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'REJECTED', rejectedAt, rejectionReason },
      });
      for (const ob of outboxes) {
        await tx.auditOutbox.create({ data: ob });
      }
    });
  }

  /**
   * ENTER-APPROVAL: mark IN_APPROVAL with a durable outbox event in one
   * transaction. The approval instance has already been opened by
   * `MissionApprovalRepository.openInstance`.
   */
  async markInApprovalDurable(
    tenantId: string,
    id: string,
    outbox: HrAuditOutboxPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.missionRequest.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'IN_APPROVAL' },
      });
      await tx.auditOutbox.create({ data: outbox });
    });
  }

  // -------------------------------------------------------------------------
  // Option catalogue
  // -------------------------------------------------------------------------

  /** One page of the tenant's option groups, ordered by `sortOrder` then `code`. */
  async listOptionGroupPage(
    tenantId: string,
    filter: { active?: boolean; required?: boolean },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.active !== undefined ? { active: filter.active } : {}),
      ...(filter.required !== undefined ? { required: filter.required } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.missionOptionGroup.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' as const }, { code: 'asc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        include: {
          options: {
            orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
          },
        },
      }),
      this.prisma.missionOptionGroup.count({ where }),
    ]);
  }

  /** One option group, or `null` if it belongs to another tenant. */
  async findOptionGroupById(tenantId: string, id: string) {
    return this.prisma.missionOptionGroup.findFirst({
      where: { id, tenantId },
      include: {
        options: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  /** The code lookup the group's own uniqueness rule presses on. */
  async findOptionGroupByCode(tenantId: string, code: string) {
    return this.prisma.missionOptionGroup.findFirst({
      where: { tenantId, code },
      include: {
        options: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  async createOptionGroup(
    tenantId: string,
    data: { code: string; label: string; required?: boolean; sortOrder?: number }
  ) {
    return this.prisma.missionOptionGroup.create({
      data: {
        tenantId,
        code: data.code,
        label: data.label,
        required: data.required ?? true,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  async updateOptionGroup(
    tenantId: string,
    id: string,
    data: { label?: string; required?: boolean; sortOrder?: number; active?: boolean }
  ) {
    return this.prisma.missionOptionGroup.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.required !== undefined ? { required: data.required } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
  }

  /** One option by id, scoped to the tenant and its group. */
  async findOptionById(tenantId: string, id: string) {
    return this.prisma.missionOption.findFirst({
      where: { id, tenantId },
      include: { group: { select: { id: true, code: true } } },
    });
  }

  /** Create an option under a group. The group must already have been read by the service. */
  async createOption(
    tenantId: string,
    optionGroupId: string,
    data: { code: string; label: string; active?: boolean; sortOrder?: number }
  ) {
    return this.prisma.missionOption.create({
      data: {
        tenantId,
        optionGroupId,
        code: data.code,
        label: data.label,
        active: data.active ?? true,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  async updateOption(
    tenantId: string,
    id: string,
    data: { label?: string; active?: boolean; sortOrder?: number }
  ) {
    return this.prisma.missionOption.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Option selections
  // -------------------------------------------------------------------------

  /** Atomically replace a request's option selections. */
  async replaceOptionSelections(
    tenantId: string,
    missionRequestId: string,
    selections: { optionGroupId: string; missionOptionId: string }[]
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.missionRequestOptionSelection.deleteMany({
        where: { tenantId, missionRequestId },
      });

      if (selections.length > 0) {
        await tx.missionRequestOptionSelection.createMany({
          data: selections.map((s) => ({
            tenantId,
            missionRequestId,
            optionGroupId: s.optionGroupId,
            missionOptionId: s.missionOptionId,
          })),
        });
      }

      return tx.missionRequestOptionSelection.findMany({
        where: { tenantId, missionRequestId },
        orderBy: { createdAt: 'asc' as const },
        include: {
          optionGroup: { select: { id: true, code: true } },
          option: { select: { id: true, code: true } },
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** One page of the tenant's mission reports as `[rows, total]`, newest first. */
  async listReportPage(
    tenantId: string,
    filter: { missionRequestId?: string; employeeId?: string },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.missionRequestId ? { missionRequestId: filter.missionRequestId } : {}),
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.missionReport.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        include: { submitter: { select: { id: true, employeeCode: true } } },
      }),
      this.prisma.missionReport.count({ where }),
    ]);
  }

  /** One report, or `null` for another tenant's row. */
  async findReportById(tenantId: string, id: string) {
    return this.prisma.missionReport.findFirst({
      where: { id, tenantId },
      include: { submitter: { select: { id: true, employeeCode: true } } },
    });
  }

  async createReport(
    tenantId: string,
    data: { missionRequestId: string; employeeId: string; content: string }
  ) {
    return this.prisma.missionReport.create({
      data: {
        tenantId,
        missionRequestId: data.missionRequestId,
        employeeId: data.employeeId,
        content: data.content,
      },
    });
  }
}
