import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrRecordStatus } from '../dto/hr-query.dto';
import type { OrganizationUnitKind } from '../dto/organization.dto';

/**
 * Phase 51-HR-ARCH-1: the `OrganizationUnit` PERSISTENCE boundary.
 *
 * WHAT THIS FILE OWNS. Every Prisma call for the organization catalogue is issued here and
 * nowhere else. That is the whole reason `OrganizationService` no longer injects a client:
 * the service decides WHAT the rules are (a code is unique per tenant, the hierarchy is a
 * forest, a unit that history points at is never deleted) and this file decides HOW a row
 * is read or written. Before the split the two were interleaved in one file, so a change to
 * a domain rule and a change to a query looked the same in review.
 *
 * THE TENANT IS AN ARGUMENT, NEVER AN AMBIENT FACT. `tenantId` is the first parameter of
 * every method below and appears in the `where` of every query. Reading `actor.tenantId`
 * here would work and would be worse: "which rows can this call see?" would depend on a
 * whole actor object passed in, instead of being visible in the signature.
 * `hr-isolation.spec.ts` fails the build when a `where` in this layer is not tenant-scoped.
 *
 * NO `findUnique`, EVER. It is the one Prisma read that selects by primary key alone and so
 * cannot carry a tenant predicate; the module bans it outright, and a single row is read
 * here with `findFirst({ where: { id, tenantId } })`.
 *
 * WHAT IS DELIBERATELY NOT HERE: no audit write (the service owns the audit row, §49), no
 * translated exception, no business decision. A duplicate code reaches the caller as the
 * driver's `P2002`; deciding that a `P2002` and a 409 are the same fact belongs to the
 * service, which is the layer that can explain it to an API client.
 */
/**
 * The headcount projection every unit read shares.
 *
 * `headcount` is a LIVE count of ACTIVE EmploymentRecords pointing at the unit —
 * computed per row by the database (`_count`), never a stored column, so a unit
 * can never drift from the employment history that actually references it.
 * `stripCount` unwraps the Prisma `_count` envelope so the wire shape carries a
 * flat `headcount` and no Prisma internals.
 */
const headcountInclude = (tenantId: string) =>
  ({
    _count: {
      select: {
        employmentRecords: { where: { status: 'ACTIVE' as const, tenantId } },
        positions: { where: { tenantId } },
      },
    },
  }) as const;

function stripCount<T extends { _count?: { employmentRecords: number; positions: number } }>(
  row: T
): Omit<T, '_count'> & { headcount: number; positionsCount: number } {
  const { _count, ...rest } = row;
  return {
    ...rest,
    headcount: _count?.employmentRecords ?? 0,
    positionsCount: _count?.positions ?? 0,
  };
}

@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /** One page of the tenant's units as `[rows, total]`, ordered `(code, id)` for paging. */
  async listPage(
    tenantId: string,
    filter: { parentId?: string; status?: HrRecordStatus; search?: string },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.parentId !== undefined ? { parentId: filter.parentId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { code: { contains: filter.search, mode: 'insensitive' as const } },
              { name: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.organizationUnit.findMany({
        where,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        include: headcountInclude(tenantId),
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.organizationUnit.count({ where }),
    ]);

    return [rows.map(stripCount), total];
  }

  /** Up to `take` units of the tenant, for the in-memory tree assembly. */
  async listForTree(tenantId: string, take: number) {
    const rows = await this.prisma.organizationUnit.findMany({
      where: { tenantId },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      include: headcountInclude(tenantId),
      take,
    });
    return rows.map(stripCount);
  }

  /**
   * Labels for a batch of ids: ONE query for a whole page, never one per row.
   *
   * The employee projection renders a unit NAME for every row of a page, so this read is
   * batched. It lives here, with the rest of the unit catalogue, so that the unit table has
   * exactly one reader — a second file selecting `code`/`name` is how two definitions of
   * "what a unit label is" start to drift.
   */
  async listLabels(tenantId: string, ids: readonly string[]) {
    return this.prisma.organizationUnit.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, code: true, name: true },
    });
  }

  /** The six counts of the HR home screen, in one round trip. */
  async summaryCounts(tenantId: string) {
    return this.prisma.$transaction([
      this.prisma.organizationUnit.count({ where: { tenantId } }),
      this.prisma.organizationUnit.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.prisma.position.count({ where: { tenantId } }),
      this.prisma.position.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.prisma.employee.count({ where: { tenantId } }),
      this.prisma.employee.count({ where: { tenantId, status: 'ACTIVE' } }),
    ]);
  }

  /** The whole unit row, or `null` — another tenant's unit is indistinguishable from absent. */
  async findById(tenantId: string, id: string) {
    const row = await this.prisma.organizationUnit.findFirst({
      where: { id, tenantId },
      include: headcountInclude(tenantId),
    });
    return row ? stripCount(row) : null;
  }

  /** Existence alone, for the two guards: a row either is in this tenant or is not. */
  async findIdById(tenantId: string, id: string) {
    return this.prisma.organizationUnit.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
  }

  /** The lifecycle columns the usability guard reads. */
  async findUsabilityById(tenantId: string, id: string) {
    return this.prisma.organizationUnit.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
  }

  /** One ancestor step of the cycle walk: the parent id of a unit in this tenant. */
  async findParentIdById(tenantId: string, id: string) {
    return this.prisma.organizationUnit.findFirst({
      where: { id, tenantId },
      select: { parentId: true },
    });
  }

  /** The pre-check for a duplicate code. `OrganizationUnit_tenantId_code_key` is the arbiter. */
  async findIdByCode(tenantId: string, code: string) {
    return this.prisma.organizationUnit.findFirst({
      where: { tenantId, code },
      select: { id: true },
    });
  }

  /** The profile columns a create or update may carry, all optional. */
  async create(
    tenantId: string,
    data: {
      code: string;
      name: string;
      parentId: string | null;
      kind?: OrganizationUnitKind;
      managerName?: string | null;
      location?: string | null;
      monthlyBudget?: string | null;
      responsibility?: string | null;
    }
  ) {
    return this.prisma.organizationUnit.create({ data: { tenantId, ...data } });
  }

  /** The mutable columns of a unit. `id` alone is safe here: the tenant read already ran. */
  async update(
    id: string,
    data: {
      name?: string;
      parentId?: string | null;
      kind?: OrganizationUnitKind;
      managerName?: string | null;
      location?: string | null;
      monthlyBudget?: string | null;
      responsibility?: string | null;
    }
  ) {
    return this.prisma.organizationUnit.update({ where: { id }, data });
  }

  /** The lifecycle transition. No DELETE exists: history references units (§10). */
  async setStatus(id: string, status: HrRecordStatus) {
    return this.prisma.organizationUnit.update({ where: { id }, data: { status } });
  }
}
