import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrEmployeeStatus } from '../dto/hr-query.dto';
import type { EmploymentIntervalCreateData } from '../employment/employment.repository';

/**
 * Phase 51-HR-ARCH-1: the `Employee` PERSISTENCE boundary.
 *
 * WHAT THIS FILE OWNS. Every Prisma call for the personnel record: the paged list, the
 * tenant-scoped read, the two duplicate-code pre-checks, the INSERT, the mutable-field
 * UPDATE and the lifecycle transition. `EmployeesService` keeps the rules that make those
 * statements mean something — the code is normalised before it is compared, a duplicate is a
 * 409 and not a 500, an identity link must be a member of the actor's tenant, and the current
 * assignment is derived from history rather than stored here.
 *
 * THE TENANT IS AN ARGUMENT, NEVER AN AMBIENT FACT. `tenantId` is the first parameter of
 * every method and appears in the `where` of every query, including the filter built for the
 * list. That is what `hr-isolation.spec.ts` asserts about this layer.
 *
 * THE ONE CROSS-MODEL WRITE, AND WHY IT IS HERE. `createWithFirstInterval` inserts an
 * `EmploymentRecord` alongside the `Employee` row. It is not a leak of the employment
 * aggregate: an `Employee` without a first interval has no unit, no position, no start date
 * and no honest rendering, so the two rows are ONE aggregate operation and must commit
 * together. Splitting it across two repositories would put half of an atomic write in each
 * one and require the service to drive a transaction the persistence layer could not express
 * — worse for exactly the reason the write is atomic in the first place.
 *
 * NO `findUnique` (it cannot carry a tenant predicate), no audit write (§49 — the service
 * audits), no translated exception (the service owns the domain meaning of a `P2002`).
 */
@Injectable()
export class EmployeeRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /**
   * One page of the tenant's employees as `[rows, total]`.
   *
   * The assignment filter is a property of the INTERVAL, so it is expressed as a relational
   * filter over `employmentRecords`, pinned to the OPEN interval (`endDate: null`): "who is in
   * Finance now" is what the screen asks. Pinned to the tenant as well, because a caller can
   * only be in one tenant but the row must say so.
   */
  async listPage(
    tenantId: string,
    filter: {
      status?: HrEmployeeStatus;
      search?: string;
      organizationUnitId?: string;
      positionId?: string;
    },
    window: { skip: number; take: number }
  ) {
    const intervalFilter =
      filter.organizationUnitId || filter.positionId
        ? {
            employmentRecords: {
              some: {
                tenantId,
                endDate: null,
                ...(filter.organizationUnitId
                  ? { organizationUnitId: filter.organizationUnitId }
                  : {}),
                ...(filter.positionId ? { positionId: filter.positionId } : {}),
              },
            },
          }
        : {};

    const where = {
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...intervalFilter,
      ...(filter.search
        ? { employeeCode: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        orderBy: [{ employeeCode: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.employee.count({ where }),
    ]);
  }

  /** The whole employee row, or `null` — another tenant's employee is indistinguishable. */
  async findById(tenantId: string, id: string) {
    return this.prisma.employee.findFirst({ where: { id, tenantId } });
  }

  /**
   * The personnel record for a Core identity, or `null` (Phase 54-E §25.2).
   *
   * WHY THIS READ EXISTS, AND WHY IT IS SCOPED. A decision's decider is never sent by the client
   * (see `dto/leave-approval.dto.ts`): the service knows the ACTOR — a Core `userId` — and a
   * `LeaveApprovalStepInstance.decidedByEmployeeId` must be an `Employee.id` of this tenant. This
   * is the one lookup that crosses that boundary, and it does so in the safe direction: a Core id
   * is turned into an HR id, never the reverse, so nothing here exposes a login.
   *
   * IT IS NOT UNIQUE, AND THAT IS THE SCHEMA'S DECISION RATHER THAN AN OVERSIGHT. `Employee.userId`
   * carries no `@@unique([tenantId, userId])` because HR history outlives Core accounts: a login
   * may be reassigned, and a former holder's record must keep naming the identity that acted. So
   * `findFirst` is the honest read — the method says "the personnel record", and the ordering makes
   * which one it is DETERMINISTIC (oldest `createdAt`, then `id`) rather than whatever the planner
   * happens to return. A caller that needs to detect the ambiguity reads the list; the decision
   * path, which needs the actor's record, gets a stable answer instead of a flaky one.
   *
   * The index `Employee_tenantId_userId_idx` exists for exactly this lookup, and `tenantId` is the
   * FIRST predicate — the boundary guard (`hr-isolation.spec.ts` rule 6) requires every repository
   * read to name its tenant first, so this cannot be called across tenants by accident.
   */
  async findByIdentityUserId(tenantId: string, userId: string) {
    return this.prisma.employee.findFirst({
      where: { tenantId, userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** The pre-check for a duplicate code on create. The unique index is the arbiter. */
  async findIdByCode(tenantId: string, employeeCode: string) {
    return this.prisma.employee.findFirst({
      where: { tenantId, employeeCode },
      select: { id: true },
    });
  }

  /** The same pre-check on update, excluding the row being edited. */
  async findIdByCodeExcludingId(tenantId: string, employeeCode: string, excludeId: string) {
    return this.prisma.employee.findFirst({
      where: { tenantId, employeeCode, id: { not: excludeId } },
      select: { id: true },
    });
  }

  /**
   * The personnel record and its first interval, in ONE transaction.
   *
   * The transaction is here rather than in the service because it is a property of the write,
   * not of the request: either both rows exist or neither does. A `P2002` from either INSERT
   * escapes untranslated; the caller turns it into the 409 that names the duplicate code.
   *
   * `firstInterval` IS A BUILDER, NOT A PAYLOAD, and the row's own id is the reason: the
   * interval points at the employee row this transaction is about to create, so its payload
   * cannot exist one line earlier. Passing a function keeps the interval's shape defined
   * exactly once (`EmploymentService.buildIntervalData`) while the write stays atomic — a
   * payload parameter would force the caller either to invent an id or to split the
   * transaction, which is the whole defect this method exists to prevent.
   */
  async createWithFirstInterval(
    employee: {
      tenantId: string;
      userId: string | null;
      employeeCode: string;
      status: HrEmployeeStatus | null;
    },
    firstInterval: (employeeId: string) => EmploymentIntervalCreateData
  ) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          tenantId: employee.tenantId,
          userId: employee.userId,
          employeeCode: employee.employeeCode,
          ...(employee.status ? { status: employee.status } : {}),
        },
      });

      await tx.employmentRecord.create({ data: firstInterval(created.id) });

      return created;
    });
  }

  /** The mutable columns of an employee. `id` alone: the tenant-scoped read already ran. */
  async updateFields(
    id: string,
    data: { employeeCode?: string; userId?: string | null; status?: HrEmployeeStatus }
  ) {
    return this.prisma.employee.update({ where: { id }, data });
  }

  /**
   * The lifecycle transition ACTIVE ⇄ INACTIVE.
   *
   * `TERMINATED` is never written here: terminating an employment closes the open interval on
   * a chosen date and is a different act with a different audit action. That rule lives in the
   * service; this method writes the value it is given.
   */
  async setStatus(id: string, status: HrEmployeeStatus) {
    return this.prisma.employee.update({ where: { id }, data: { status } });
  }
}
