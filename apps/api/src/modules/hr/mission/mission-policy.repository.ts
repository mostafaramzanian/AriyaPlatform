import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';

type MissionPolicyVersionStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/**
 * Phase 55: the Mission policy version persistence boundary.
 *
 * WHY SEPARATE FROM `MissionRepository`
 * -------------------------------------
 * A policy version is a tenant-wide configuration document, independent of a single
 * request. It has its own lifecycle (DRAFT → VALIDATED → PUBLISHED → ARCHIVED) and its
 * own read patterns, so it belongs in its own persistence file.
 *
 * NO RULE ENGINE
 * --------------
 * This file stores and reads versions. It does NOT evaluate rules or decide which
 * version governs a request.
 */

@Injectable()
export class MissionPolicyRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /** One page of the tenant's policy versions, newest version first. */
  async listVersionPage(
    tenantId: string,
    filter: { status?: MissionPolicyVersionStatus; ruleSetId?: string },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ruleSetId ? { ruleSetId: filter.ruleSetId } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.missionPolicyVersion.findMany({
        where,
        orderBy: [{ version: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.missionPolicyVersion.count({ where }),
    ]);
  }

  /** One version, or `null` for another tenant. */
  async findVersionById(tenantId: string, id: string) {
    return this.prisma.missionPolicyVersion.findFirst({ where: { id, tenantId } });
  }

  /** The currently published version for a rule set, or `null`. */
  async findPublishedVersion(tenantId: string, ruleSetId: string) {
    return this.prisma.missionPolicyVersion.findFirst({
      where: { tenantId, ruleSetId, status: 'PUBLISHED' },
      orderBy: [{ version: 'desc' as const }, { id: 'asc' as const }],
    });
  }

  /** Create a new version starting as DRAFT. */
  async createVersion(
    tenantId: string,
    data: {
      version: number;
      ruleSetId?: string;
      configuration: unknown;
    }
  ) {
    return this.prisma.missionPolicyVersion.create({
      data: {
        tenantId,
        version: data.version,
        status: 'DRAFT',
        ruleSetId: data.ruleSetId ?? 'hr.mission.approval',
        configuration: data.configuration as never,
      },
    });
  }

  /** Transition a version's lifecycle. */
  async updateVersionStatus(
    tenantId: string,
    id: string,
    data: { status: MissionPolicyVersionStatus; publishedAt?: Date | null }
  ) {
    return this.prisma.missionPolicyVersion.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        status: data.status,
        ...(data.publishedAt !== undefined ? { publishedAt: data.publishedAt } : {}),
      },
    });
  }
}
