import { Injectable, Logger } from '@nestjs/common';
import { AttendanceRepository } from '../attendance/attendance.repository';
import { HR_PERSONNEL_TRAFFIC_SOURCES } from '../attendance/hr-attendance-source';
import { attendanceWorkDateKey, resolveAttendanceDayBounds } from '../attendance/attendance-window';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_RESOURCE, HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';
import type {
  HrPersonnelTrafficReportPage,
  HrPersonnelTrafficReportQuery,
  HrPersonnelTrafficReportRow,
  HrPersonnelTrafficReportSummary,
  HrPersonnelTrafficReportTimelinePage,
  HrPersonnelTrafficReportingReader,
  HrPersonnelTrafficReportingScope,
} from './hr-personnel-traffic-reporting.contract';

/**
 * The register row as the two reporting reads receive it — a row plus its employee
 * label, stated STRUCTURALLY so the seam never names a Prisma type. The repository
 * returns strictly more columns; the whitelist below is what crosses.
 */
interface AttendanceReportRecord {
  id: string;
  workDate: Date;
  dateKey: string;
  clockIn: Date;
  clockOut: Date | null;
  source: 'DEVICE' | 'MANUAL';
  reason: string | null;
  employee: { id: string; employeeCode: string };
}

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the HR-owned IMPLEMENTATION of the Reporting
 * read contract — the approved seam Reporting reads through, the exact shape the
 * Financial, Commerce and Production readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the contract's
 * explicit eight-field whitelist, so the repository's write surface (clock-in, clock-out,
 * adjustment) stays unreachable by construction rather than by review.
 *
 * List and detail reuse the SAME tenant-scoped repository statements the register's own
 * routes read — `listPage` and `findById`, both built from the ONE predicate builder
 * `AttendanceRepository.buildWhere` — so a register row can never be described two ways
 * by the two surfaces. The summary counts per source over the SAME filter via one bounded
 * `groupBy`. The timeline proves existence tenant-scoped first, then reads the SAME
 * platform audit trail the register writes (`hr.attendance`) through
 * `HrAuditGateway.read`.
 *
 * THE DAY WINDOW IS RESOLVED THROUGH `attendance-window.ts` — the implementation the
 * register's own `AttendanceService` delegates to — so «which days?» has exactly one
 * answer in this module, and an invalid or contradictory window is the SAME 400 on both
 * surfaces rather than a silent mismatch.
 *
 * NOTHING IS INVENTED HERE. No status, no duration, no attendance rate, no punctuality,
 * no overtime, no inferred event, no source the register does not declare. The one
 * decision this file owns is the zero-fill of the summary over
 * `HR_PERSONNEL_TRAFFIC_SOURCES`, and even that completes a count the database produced —
 * it never makes one up.
 */
@Injectable()
export class HrPersonnelTrafficReportingReaderService implements HrPersonnelTrafficReportingReader {
  private readonly logger = new Logger(HrPersonnelTrafficReportingReaderService.name);

  constructor(
    private readonly attendance: AttendanceRepository,
    private readonly audit: HrAuditGateway
  ) {}

  /**
   * One filtered page of the register, newest day first.
   *
   * The page window is resolved HERE as well as in the Reporting DTO: an internal caller
   * that builds a query object without going through validation cannot exceed
   * `HR_MAX_PAGE_SIZE` either. The window is echoed back, so a caller that sent nothing
   * learns what it received rather than having to infer it.
   */
  async listReportRows(
    scope: HrPersonnelTrafficReportingScope,
    query: HrPersonnelTrafficReportQuery
  ): Promise<HrPersonnelTrafficReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.attendance.listPage(
      scope.tenantId,
      toRepositoryFilter(query),
      { skip: (window.page - 1) * window.pageSize, take: window.pageSize }
    );

    return {
      items: rows.map(toReportRow),
      total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /**
   * Per-source counts over the SAME filter the list answers.
   *
   * BOTH members of the closed vocabulary are present, zero-filled: a strip never has to
   * invent a missing key, and a source the register cannot have counts zero rather than
   * disappearing from the answer.
   */
  async getReportSummary(
    scope: HrPersonnelTrafficReportingScope,
    query: HrPersonnelTrafficReportQuery
  ): Promise<HrPersonnelTrafficReportSummary> {
    const counts = await this.attendance.countBySource(scope.tenantId, toRepositoryFilter(query));

    const bySource: Record<string, number> = {};
    let total = 0;
    for (const source of HR_PERSONNEL_TRAFFIC_SOURCES) {
      const count = counts.get(source) ?? 0;
      bySource[source] = count;
      total += count;
    }
    return { total, bySource };
  }

  /** One register row, or `null` for an id this tenant does not hold. */
  async getReportRow(
    scope: HrPersonnelTrafficReportingScope,
    attendanceId: string
  ): Promise<HrPersonnelTrafficReportRow | null> {
    const row = await this.attendance.findById(scope.tenantId, attendanceId);
    if (!row) return null;
    return toReportRow(row);
  }

  /**
   * This row's report timeline — existence proven tenant-scoped FIRST (an empty page for
   * a foreign id; the Reporting service maps `null` to 404 before this is ever reached),
   * then a rejection re-thrown with its CLOSED code so the Reporting service can map it
   * to a 503 rather than the reader quietly claiming «nothing was recorded».
   */
  async getReportTimeline(
    scope: HrPersonnelTrafficReportingScope,
    attendanceId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrPersonnelTrafficReportTimelinePage> {
    const row = await this.attendance.findById(scope.tenantId, attendanceId);
    if (!row) {
      return { items: [], page: 1, pageSize: HR_DEFAULT_PAGE_SIZE, total: 0 };
    }

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: HR_AUDIT_RESOURCE.ATTENDANCE,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      this.logger.error(`Reporting audit read rejected for attendance ${row.id}: ${result.code}`);
      throw Object.assign(new Error('Audit history is temporarily unavailable.'), {
        code: result.code,
      });
    }

    return {
      items: result.page.items.map((item) => ({
        id: item.id,
        action: item.action,
        actorId: item.actorId,
        success: item.success,
        reason: item.reason,
        changedFields: item.changedFields,
        createdAt: item.createdAt,
      })),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
  }
}

/** The HR page-size pair — one place the report resolves its window. */
function resolveReportWindow(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    HR_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? HR_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/**
 * The wire query → the repository's own filter: the day window resolved through the
 * SAME `attendance-window.ts` the register's list uses, plus the two remaining filters
 * the register supports. An empty `search` is treated as absent, so `?search=` asks the
 * register the same question as no search at all.
 */
function toRepositoryFilter(query: HrPersonnelTrafficReportQuery) {
  const bounds = resolveAttendanceDayBounds(query);
  return {
    ...bounds,
    ...(query.source !== undefined ? { source: query.source } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
  };
}

/**
 * Projects a stored row onto the contract's EIGHT reporting fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, `employeeId`, `updatedAt` and the
 * employee relation, and none of them is on this report. A spread-through would publish
 * the next column the schema gains without this file ever deciding it is safe for this
 * surface. `workDate` is rendered through the register's own day-key reader (a `@db.Date`
 * is a DAY, not "midnight UTC"); the two punches stay ISO INSTANTS, because a moment
 * stripped of its offset is a different moment.
 */
function toReportRow(row: AttendanceReportRecord): HrPersonnelTrafficReportRow {
  return {
    id: row.id,
    employeeCode: row.employee.employeeCode,
    workDate: attendanceWorkDateKey(row.workDate),
    dateKey: row.dateKey,
    clockIn: row.clockIn.toISOString(),
    clockOut: row.clockOut ? row.clockOut.toISOString() : null,
    source: row.source,
    reason: row.reason,
  };
}
