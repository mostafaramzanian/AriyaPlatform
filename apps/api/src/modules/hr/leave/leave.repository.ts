import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrRecordStatus } from '../dto/hr-query.dto';
import type { LeaveRequestStatus } from '../domain/leave-status';
import type { LeaveLimitConsumedState } from '../domain/leave-policy';

/**
 * Phase 51-HR-3A: the LEAVE persistence boundary — the register and the type catalogue.
 *
 * WHY ONE FILE COVERS BOTH TABLES, WHEN THE MODULE'S RULE IS "ONE FILE PER AGGREGATE"
 * ---------------------------------------------------------------------------------
 * `LeaveType` is not a second aggregate living next door: it is a LEAF of the leave aggregate,
 * and `LeaveRequest`'s `(tenant_id, leave_type_id)` composite foreign key is the proof — a
 * request and its type are one fact about one tenant, kept in one file so that EVERY statement
 * which pairs them is written where a single reader can see the pairing. Two files would mean
 * the same-tenant guarantee stated twice, in two places free to drift, which is what
 * `hr-isolation.spec.ts` exists to prevent.
 *
 * EVERY `where` CARRIES THE TENANT, and the WRITES address the compound unique key rather than
 * an id: `LeaveRequest_tenantId_id_key` and `LeaveType_tenantId_id_key` both exist in `hr_db`,
 * so an update is scoped BY CONSTRUCTION — `{ tenantId_id: { tenantId, id } }` — instead of by
 * a convention the caller has to remember. `findUnique` appears nowhere: it cannot carry a
 * tenant predicate at all.
 *
 * WHAT THIS FILE OWNS: the two paged reads, the two tenant-scoped row reads, the code lookup
 * the catalogue's uniqueness rule presses on, and the INSERTs/UPDATEs. `LeaveService` keeps the
 * rules that make those statements mean something — the period is a real period, a reason is
 * stated, a withdrawn request is terminal, a retired type cannot be chosen for a NEW request,
 * and every act is audited. No audit write happens here (§49 — the service audits) and no
 * exception is translated here (the service owns the domain meaning).
 */
export interface LeaveRequestFilter {
  employeeId?: string;
  leaveTypeId?: string;
  status?: LeaveRequestStatus;
  from?: Date;
  to?: Date;
}

@Injectable()
export class LeaveRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /**
   * The labels every register read carries, so a row is renderable without a second query.
   *
   * `employeeCode` is the person's stable, human-facing key — a NAME would come from Core
   * through `HrIdentityGateway`, and this layer never learns about identity. The type's `code`
   * and `name` are HR's own and are included, because a register that showed a type uuid would
   * make the operator look it up one row at a time.
   */
  private static readonly REQUEST_LABEL = {
    employee: { select: { id: true, employeeCode: true } },
    leaveType: { select: { id: true, code: true, name: true, status: true } },
  } as const;

  // -------------------------------------------------------------------------
  // The request register
  // -------------------------------------------------------------------------

  /**
   * The tenant predicate of EVERY request read in this file — ONE builder, so the
   * page read and the status counts can never disagree about what a filter meant.
   *
   * `from` / `to` are already-resolved `Date` bounds and mean INTERSECTION with a
   * request's own period — `endDate >= from` and `startDate <= to`.
   */
  private static buildRequestWhere(
    tenantId: string,
    filter: {
      employeeId?: string;
      leaveTypeId?: string;
      status?: LeaveRequestStatus;
      from?: Date;
      to?: Date;
    }
  ) {
    return {
      tenantId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.leaveTypeId ? { leaveTypeId: filter.leaveTypeId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.to ? { startDate: { lte: filter.to } } : {}),
      ...(filter.from ? { endDate: { gte: filter.from } } : {}),
    };
  }

  /**
   * One page of the tenant's requests as `[rows, total]`, latest period first.
   *
   * `from` / `to` are already-resolved `Date` bounds and mean INTERSECTION with a request's own
   * period — `endDate >= from` and `startDate <= to` — so "what leave touches this window" is
   * answered by a request that merely OVERLAPS it. That is the question the register asks, and
   * it is a deliberate choice against a containment filter, which would hide a long request
   * that swallows the window whole.
   *
   * The order is TOTAL (`startDate`, then `createdAt`, then `id`): three keys, so two rows
   * sharing a start date and a creation instant still have one stable order and paging cannot
   * repeat or skip one of them.
   */
  async listRequestPage(
    tenantId: string,
    filter: {
      employeeId?: string;
      leaveTypeId?: string;
      status?: LeaveRequestStatus;
      from?: Date;
      to?: Date;
    },
    window: { skip: number; take: number }
  ) {
    const where = LeaveRepository.buildRequestWhere(tenantId, filter);

    return this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        include: LeaveRepository.REQUEST_LABEL,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);
  }

  /**
   * Phase REPORTING-HR-LEAVE-REQUEST: per-status counts over the SAME filter the
   * page read above answers — the report summary's database aggregation.
   *
   * WHY A `groupBy` AND NOT A LOOP OVER `listRequestPage`: the summary strip renders
   * four numbers; answering them by loading the register into application memory would
   * make a report that is supposed to describe a tenant's whole leave history read
   * that history to describe it. ONE `groupBy`, no rows materialised, and the SAME
   * `buildRequestWhere` predicate as the page read — so the counts and the page can
   * never disagree about what the filter meant, because one place builds it.
   *
   * `Map<LeaveRequestStatus, number>` (NOT a plain record) so a caller that forgets
   * to zero-fill gets `undefined` for an absent status rather than a plausible `0` it
   * did not ask for; the reader decides the fill, over the closed vocabulary.
   *
   * Read-only, tenant-scoped first like every other method here, and it writes nothing
   * — which is why it belongs beside the reads rather than behind a second client.
   */
  async countByStatus(
    tenantId: string,
    filter: {
      employeeId?: string;
      leaveTypeId?: string;
      status?: LeaveRequestStatus;
      from?: Date;
      to?: Date;
    }
  ): Promise<Map<LeaveRequestStatus, number>> {
    const where = LeaveRepository.buildRequestWhere(tenantId, filter);

    const rows = await this.prisma.leaveRequest.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });

    return new Map(rows.map((row) => [row.status as LeaveRequestStatus, row._count.status]));
  }

  /** The whole row plus its labels, or `null` — another tenant's request is absent. */
  async findRequestById(tenantId: string, id: string) {
    return this.prisma.leaveRequest.findFirst({
      where: { id, tenantId },
      include: LeaveRepository.REQUEST_LABEL,
    });
  }

  /**
   * Phase 54-G: the requests that may COUNT against one leave limit — tenant-scoped, leave-type
   * scoped, WINDOW-scoped, and narrowed to the states the limit's own configuration names.
   *
   * WHY THIS IS NOT `listRequestPage`. That method is a LISTING: it pages, it orders for display, it
   * joins labels, and it takes a caller-supplied `status`. A limit needs the opposite of each — the
   * WHOLE set (a page would under-count, and under-counting is an ALLOWANCE, §16.7's one forbidden
   * direction of error), no ordering to display, no labels, and states chosen by the POLICY rather
   * than by whoever is asking. Reusing the listing for enforcement would put a `take` between a
   * request and the rule that judges it.
   *
   * THE OVERLAP TEST IS THE INCLUSIVE ONE the listing already uses (`startDate <= to` AND
   * `endDate >= from`), which is what makes a request that STRADDLES a window boundary countable
   * rather than invisible. It is a coarse candidate filter, not the window rule: the authoritative
   * window predicate lives in `leave-limit-counting.ts`, and duplicating it here would create the
   * second implementation this phase exists to avoid.
   *
   * `employeeId` NARROWS TO ONE PERSON when the caller supplies it. A limit is stated per leave type
   * and how far it reaches is a §16.6 scope decision — for the per-employee entitlement question the
   * caller passes the employee, and the count then answers "how much has THIS person used".
   *
   * ONLY THE FOUR COLUMNS THE COUNTING CONTRACT DECLARES ARE SELECTED, and `status` is narrowed by a
   * PREDICATE rather than returned-and-filtered: the caller has already validated the state set
   * against the lifecycle (`leaveLimitEnforceabilityRefusal`), so an unenforceable set never reaches
   * a query at all — the refusal is reported where it can be explained, not silently as "0 requests".
   */
  async findCountableRequests(
    tenantId: string,
    filter: {
      leaveTypeId: string;
      employeeId?: string;
      from: Date;
      to: Date;
      statuses: readonly LeaveLimitConsumedState[];
    }
  ) {
    return this.prisma.leaveRequest.findMany({
      where: {
        tenantId,
        leaveTypeId: filter.leaveTypeId,
        ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
        status: { in: [...filter.statuses] },
        startDate: { lte: filter.to },
        endDate: { gte: filter.from },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The INSERT for a submitted request.
   *
   * `status` IS NOT A PARAMETER. It is written as the value the database's own DEFAULT
   * declares, so a caller cannot produce a request in any state but the one an act of
   * submitting can produce — even the creating call has no way to say "APPROVED", on the day
   * that member exists. `cancelledAt` is absent for the other direction of the same reason:
   * `LeaveRequest_cancelled_state_check` refuses an instant on a pending row, and the only
   * shape that satisfies it here is the truthful one.
   */
  async createRequest(
    tenantId: string,
    data: {
      employeeId: string;
      leaveTypeId: string;
      startDate: Date;
      endDate: Date;
      reason: string;
    }
  ) {
    return this.prisma.leaveRequest.create({
      data: {
        tenantId,
        employeeId: data.employeeId,
        leaveTypeId: data.leaveTypeId,
        startDate: data.startDate,
        endDate: data.endDate,
        reason: data.reason,
        status: 'PENDING',
      },
      include: LeaveRepository.REQUEST_LABEL,
    });
  }

  /**
   * The restatement of a pending request's own content.
   *
   * `tenantId_id` IS THE TENANT GUARANTEE, not a convenience: the compound key is the one the
   * migration created for the same-tenant foreign keys, so this statement cannot address
   * another tenant's request even if it were handed the id. Whether the restatement is ALLOWED
   * is not decided here — `LeaveService` has already read the row through a tenant-scoped
   * predicate and refused a withdrawn one, and the transition table that says so lives in
   * `domain/leave-status.ts`.
   */
  async updateRequest(
    tenantId: string,
    id: string,
    data: {
      leaveTypeId?: string;
      startDate?: Date;
      endDate?: Date;
      reason?: string;
    }
  ) {
    return this.prisma.leaveRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.leaveTypeId !== undefined ? { leaveTypeId: data.leaveTypeId } : {}),
        ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
        ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      },
      include: LeaveRepository.REQUEST_LABEL,
    });
  }

  /**
   * The WITHDRAWAL: one statement, both halves of the state change.
   *
   * `status` and `cancelledAt` are written TOGETHER because `LeaveRequest_cancelled_state_check`
   * ties them in both directions — a withdrawal that set one and not the other is not a partial
   * success, it is an error the database would raise. There is no second call to reconcile
   * them afterwards, which is what makes "when was this withdrawn?" answerable by the row
   * itself rather than by its history.
   */
  async cancelRequest(tenantId: string, id: string, cancelledAt: Date) {
    return this.prisma.leaveRequest.update({
      where: { tenantId_id: { tenantId, id } },
      data: { status: 'CANCELLED', cancelledAt },
      include: LeaveRepository.REQUEST_LABEL,
    });
  }

  // -------------------------------------------------------------------------
  // The type catalogue
  // -------------------------------------------------------------------------

  /** One page of the tenant's OWN catalogue, ordered by `code` — the stable catalogue order. */
  async listTypePage(
    tenantId: string,
    filter: { status?: HrRecordStatus; search?: string },
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
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

    return this.prisma.$transaction([
      this.prisma.leaveType.findMany({
        where,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.leaveType.count({ where }),
    ]);
  }

  /** One catalogue entry, or `null` — another tenant's entry is absent, not forbidden. */
  async findTypeById(tenantId: string, id: string) {
    return this.prisma.leaveType.findFirst({ where: { id, tenantId } });
  }

  /**
   * The entry a code ALREADY denotes in this tenant, read through the index
   * `LeaveType_tenantId_code_key` makes unique.
   *
   * The service presses on this before an insert so a duplicate is a 409 rather than a raw
   * `P2002`; the index stays the arbiter, because two concurrent creates can both find nothing.
   * `code` arrives already normalised — the DTO normalised it, and the service normalises again
   * so a direct caller cannot bypass that — which is what stops this lookup from missing a row
   * whose stored spelling differs only by case.
   */
  async findTypeByCode(tenantId: string, code: string) {
    return this.prisma.leaveType.findFirst({
      where: { tenantId, code },
      select: { id: true, code: true, name: true, status: true },
    });
  }

  /** The INSERT for a catalogue entry. The initial lifecycle state is the catalogue's own. */
  async createType(tenantId: string, data: { code: string; name: string }) {
    return this.prisma.leaveType.create({
      data: { tenantId, code: data.code, name: data.name, status: 'ACTIVE' },
    });
  }

  /**
   * A rename, or the retirement and return of an entry.
   *
   * THERE IS NO DELETE, AND NO METHOD HERE COULD ADD ONE SAFELY: a type that has ever been
   * requested is referenced by `LeaveRequest_tenant_leave_type_fkey` (`ON DELETE RESTRICT`), so
   * retirement is a STATUS — which is what lets a historical request keep rendering the name of
   * the leave it was recorded under while the entry is unavailable for anything new.
   */
  async updateType(tenantId: string, id: string, data: { name?: string; status?: HrRecordStatus }) {
    return this.prisma.leaveType.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
  }
}
