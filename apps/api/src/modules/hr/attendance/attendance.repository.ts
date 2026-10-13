import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrAttendanceSource } from '../dto/hr-query.dto';

/**
 * Phase 51-HR-3: the `Attendance` PERSISTENCE boundary.
 *
 * The mirror of `EmployeeRepository` and `PositionRepository`, for the same reasons:
 * every Prisma call for the register is issued here, the tenant arrives as an argument
 * and appears in the `where` of every query, and `findUnique` is never used because it
 * cannot carry a tenant predicate.
 *
 * WHAT THIS FILE OWNS: the paged register read, the tenant-scoped row read, the
 * identity lookup the uniqueness rule presses on, the INSERT, the clock-out UPDATE and
 * the idempotent correction UPSERT. `AttendanceService` keeps the rules that make those
 * statements mean something — the day is DERIVED from the punch, a second clock-in for
 * the same day is a 409 rather than a second row, a day cannot close before it opens,
 * a correction never touches the `DEVICE` row, and every act is audited.
 *
 * WHY THE CORRECTION IS AN `upsert` AND NOT A `find` THEN `create`-or-`update`: the
 * unique key `(tenantId, employeeId, workDate, source)` is the row's identity, so the
 * database can decide in ONE statement. A read-then-write pair would be correct under
 * the index — the loser of a race gets a `P2002` — but it would surface that race as a
 * 500 instead of the 409/200 the caller deserves, and it would put the same rule in two
 * places. Here the statement is atomic and the service only reports what happened.
 *
 * NO `findUnique` (it cannot carry a tenant predicate), no audit write (§49 — the
 * service audits), no translated exception (the service owns the domain meaning).
 */
@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /**
   * The employee label every register read carries, so a row is renderable without a
   * second query. `employeeCode` is the person's stable, human-facing key; a name would
   * come from Core through `HrIdentityGateway` and is deliberately not resolved here —
   * this layer never learns about identity.
   */
  private static readonly EMPLOYEE_LABEL = {
    employee: { select: { id: true, employeeCode: true } },
  } as const;

  /**
   * The tenant predicate of EVERY read in this file — ONE builder, so the page read and
   * the source counts can never disagree about what a filter meant (the exact shape
   * `PurchaseRepository.buildDocumentWhere` established for its report summary).
   *
   * `search` presses on the EMPLOYEE CODE through a relation pinned to the SAME tenant,
   * so a search can never reach across tenants even though the joined table holds the
   * text. `from`/`to` are already-resolved `Date` bounds on `work_date` (the caller owns
   * the calendar arithmetic — `attendance-window.ts`).
   */
  private static buildWhere(
    tenantId: string,
    filter: {
      employeeId?: string;
      from?: Date;
      to?: Date;
      source?: HrAttendanceSource;
      search?: string;
    }
  ) {
    return {
      tenantId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.from || filter.to
        ? {
            workDate: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
      ...(filter.search
        ? {
            employee: {
              is: {
                tenantId,
                employeeCode: { contains: filter.search, mode: 'insensitive' as const },
              },
            },
          }
        : {}),
    };
  }

  /**
   * One page of the tenant's register as `[rows, total]`, newest day first.
   *
   * The predicate comes from `buildWhere` — shared verbatim with `countBySource` below.
   */
  async listPage(
    tenantId: string,
    filter: {
      employeeId?: string;
      from?: Date;
      to?: Date;
      source?: HrAttendanceSource;
      search?: string;
    },
    window: { skip: number; take: number }
  ) {
    const where = AttendanceRepository.buildWhere(tenantId, filter);

    return this.prisma.$transaction([
      this.prisma.attendance.findMany({
        where,
        orderBy: [{ workDate: 'desc' }, { clockIn: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        include: AttendanceRepository.EMPLOYEE_LABEL,
      }),
      this.prisma.attendance.count({ where }),
    ]);
  }

  /**
   * Phase REPORTING-HR-PERSONNEL-TRAFFIC: per-source counts over the SAME filter the
   * page read above answers — the report summary's database aggregation.
   *
   * WHY A `groupBy` AND NOT A LOOP OVER `listPage`: the summary strip renders numbers
   * for the WHOLE filtered population; answering them by loading the register into
   * application memory would make a report that describes a tenant's traffic read that
   * traffic row by row to describe it. ONE `groupBy`, no rows materialised, and the SAME
   * `buildWhere` predicate as the page read — so the counts and the page can never
   * disagree about what the filter meant, because one place builds it.
   *
   * `Map<HrAttendanceSource, number>` (NOT a plain record) so a caller that forgets to
   * zero-fill gets `undefined` for an absent source rather than a plausible `0` it did
   * not ask for; the reader decides the fill, over the closed two-member vocabulary.
   *
   * Read-only, tenant-scoped first like every method here — which is why it belongs
   * beside the reads rather than behind a second client.
   */
  async countBySource(
    tenantId: string,
    filter: {
      employeeId?: string;
      from?: Date;
      to?: Date;
      source?: HrAttendanceSource;
      search?: string;
    }
  ): Promise<Map<HrAttendanceSource, number>> {
    const where = AttendanceRepository.buildWhere(tenantId, filter);

    const rows = await this.prisma.attendance.groupBy({
      by: ['source'],
      where,
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.source, row._count._all]));
  }

  /** The whole row plus its employee label, or `null` — another tenant's row is absent. */
  async findById(tenantId: string, id: string) {
    return this.prisma.attendance.findFirst({
      where: { id, tenantId },
      include: AttendanceRepository.EMPLOYEE_LABEL,
    });
  }

  /**
   * The row's identity, read: one day, one employee, one source.
   *
   * `source` is a parameter rather than a constant because the caller asks two different
   * questions with the same statement — "is this day already open?" (`DEVICE`) and "is
   * there already a correction for it?" (`MANUAL`) — and both are answered by the unique
   * key. The insert can still race; `Attendance_tenantId_employeeId_workDate_source_key`
   * is the arbiter, and the service turns the loser's `P2002` into a 409.
   */
  async findDayBySource(
    tenantId: string,
    employeeId: string,
    workDate: Date,
    source: HrAttendanceSource
  ) {
    return this.prisma.attendance.findFirst({
      where: { tenantId, employeeId, workDate, source },
      select: { id: true, clockIn: true, clockOut: true },
    });
  }

  /** The INSERT for a punch. `source` is decided by the service, never by a caller. */
  async create(data: {
    tenantId: string;
    employeeId: string;
    workDate: Date;
    dateKey: string;
    clockIn: Date;
    clockOut: Date | null;
    source: HrAttendanceSource;
    reason?: string | null;
  }) {
    return this.prisma.attendance.create({
      data: {
        tenantId: data.tenantId,
        employeeId: data.employeeId,
        workDate: data.workDate,
        dateKey: data.dateKey,
        clockIn: data.clockIn,
        clockOut: data.clockOut,
        source: data.source,
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      },
      include: AttendanceRepository.EMPLOYEE_LABEL,
    });
  }

  /**
   * The clock-out. `id` alone: the tenant-scoped read already ran in the service, which
   * is the only shape in which an id-only predicate is allowed here (see
   * `hr-isolation.spec.ts` rule 7).
   */
  async close(id: string, clockOut: Date) {
    return this.prisma.attendance.update({
      where: { id },
      data: { clockOut },
      include: AttendanceRepository.EMPLOYEE_LABEL,
    });
  }

  /**
   * The MANUAL correction: create the row for this employee-day if it does not exist,
   * otherwise SET it. The `DEVICE` row is unreachable from here by construction —
   * `source` is part of the key, and it is a constant in both halves of the statement,
   * so no payload this method can be given turns the correction into an edit of the
   * evidence (§13).
   *
   * The compound key's own `where` carries the tenant, which is why this method needs no
   * separate tenant read to be tenant-safe: the key IS `(tenantId, employeeId, workDate,
   * source)`, so a caller cannot address another tenant's row even by guessing ids.
   */
  async upsertManual(
    tenantId: string,
    employeeId: string,
    workDate: Date,
    data: { dateKey: string; clockIn: Date; clockOut: Date | null; reason: string }
  ) {
    return this.prisma.attendance.upsert({
      where: {
        tenantId_employeeId_workDate_source: {
          tenantId,
          employeeId,
          workDate,
          source: 'MANUAL',
        },
      },
      update: {
        dateKey: data.dateKey,
        clockIn: data.clockIn,
        clockOut: data.clockOut,
        reason: data.reason,
      },
      create: {
        tenantId,
        employeeId,
        workDate,
        dateKey: data.dateKey,
        clockIn: data.clockIn,
        clockOut: data.clockOut,
        source: 'MANUAL',
        reason: data.reason,
      },
      include: AttendanceRepository.EMPLOYEE_LABEL,
    });
  }
}
