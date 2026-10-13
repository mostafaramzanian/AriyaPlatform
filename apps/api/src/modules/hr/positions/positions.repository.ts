import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrRecordStatus } from '../dto/hr-query.dto';

/**
 * Phase 51-HR-ARCH-1: the `Position` PERSISTENCE boundary.
 *
 * The mirror of `OrganizationRepository`, for the same reasons: every Prisma call for the
 * position catalogue is issued here, the tenant arrives as an argument and appears in the
 * `where` of every query, and `findUnique` is never used because it cannot carry a tenant
 * predicate. `PositionsService` keeps the rules — a code is unique per tenant, a position
 * belongs to exactly one unit of that tenant, and `title` is deliberately not unique.
 *
 * THE COMPOSITE FOREIGN KEY IS STILL THE REAL GUARANTEE. `Position_tenant_unit_fkey`
 * (`(tenant_id, organization_unit_id) -> OrganizationUnit(tenant_id, id)`) makes a
 * cross-tenant position impossible to write even by a writer that bypasses this layer
 * entirely; the repository is what makes the ordinary path readable, not what makes it safe.
 *
 * `listLabels` exists because the employee projection renders a position TITLE for each row
 * of a page. It lives here, not in the employee layer, so that the position table has
 * exactly one reader — a second file selecting `code`/`title` is how the two definitions of
 * "what a position label is" start to drift.
 */
@Injectable()
export class PositionRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /** The unit relation every positional read includes, so a caller never needs a second query. */
  private static readonly UNIT_LABEL = {
    organizationUnit: { select: { id: true, code: true, name: true } },
  } as const;

  /** One page of the tenant's positions as `[rows, total]`, each carrying its unit label. */
  async listPage(
    tenantId: string,
    filter: { organizationUnitId?: string; status?: HrRecordStatus; search?: string },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.organizationUnitId ? { organizationUnitId: filter.organizationUnitId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { code: { contains: filter.search, mode: 'insensitive' as const } },
              { title: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.position.findMany({
        where,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        include: PositionRepository.UNIT_LABEL,
      }),
      this.prisma.position.count({ where }),
    ]);
  }

  /** The whole row plus its unit label, or `null` — another tenant's position is absent. */
  async findById(tenantId: string, id: string) {
    return this.prisma.position.findFirst({
      where: { id, tenantId },
      include: PositionRepository.UNIT_LABEL,
    });
  }

  /** The lifecycle and parentage columns the interval guard reads. */
  async findUsabilityById(tenantId: string, id: string) {
    return this.prisma.position.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, organizationUnitId: true },
    });
  }

  /** The pre-check for a duplicate code. `Position_tenantId_code_key` is the arbiter. */
  async findIdByCode(tenantId: string, code: string) {
    return this.prisma.position.findFirst({
      where: { tenantId, code },
      select: { id: true },
    });
  }

  /** Labels for a batch of ids: ONE query for a whole page, never one per row. */
  async listLabels(tenantId: string, ids: readonly string[]) {
    return this.prisma.position.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, code: true, title: true },
    });
  }

  /** The INSERT. A duplicate code surfaces as the driver's `P2002`, untranslated. */
  async create(
    tenantId: string,
    data: {
      organizationUnitId: string;
      code: string;
      title: string;
      status?: HrRecordStatus;
    }
  ) {
    return this.prisma.position.create({
      data: {
        tenantId,
        organizationUnitId: data.organizationUnitId,
        code: data.code,
        title: data.title,
        ...(data.status ? { status: data.status } : {}),
      },
    });
  }

  /** Rename, move between units, or (de)activate. `id` alone: the tenant read already ran. */
  async update(
    id: string,
    data: { title?: string; organizationUnitId?: string; status?: HrRecordStatus }
  ) {
    return this.prisma.position.update({ where: { id }, data });
  }

  /** The lifecycle transition. No DELETE exists: history references positions (§10). */
  async setStatus(id: string, status: HrRecordStatus) {
    return this.prisma.position.update({ where: { id }, data: { status } });
  }
}
