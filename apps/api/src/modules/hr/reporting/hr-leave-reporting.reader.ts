import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LeaveRepository } from '../leave/leave.repository';
import { LEAVE_REQUEST_STATUSES } from '../domain/leave-status';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_RESOURCE, HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';
import type {
  HrLeaveRequestReportPage,
  HrLeaveRequestReportQuery,
  HrLeaveRequestReportRow,
  HrLeaveRequestReportSummary,
  HrLeaveRequestReportTimelinePage,
  HrLeaveRequestReportingReader,
  HrLeaveRequestReportingScope,
} from './hr-leave-reporting.contract';

/**
 * The register row as the two reporting reads receive it — a row plus its two
 * labels, stated STRUCTURALLY so the seam never names a Prisma type. The
 * repository returns strictly more columns; the whitelist below is what crosses.
 */
interface LeaveReportRecord {
  id: string;
  startDate: Date;
  endDate: Date;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  createdAt: Date;
  cancelledAt: Date | null;
  employee: { id: string; employeeCode: string };
  leaveType: { id: string; code: string; name: string; status: string };
}

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the HR-owned IMPLEMENTATION of the Reporting
 * read contract — the approved seam Reporting reads through, the exact shape the
 * Financial, Commerce, Production and HR-attendance readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the
 * contract's explicit whitelist, so the repository's write surface (submit,
 * restate, withdraw, the approval decisions) stays unreachable by construction.
 *
 * List and detail reuse the SAME tenant-scoped repository statements the register's
 * own routes read — `listRequestPage` and `findRequestById` — so a request can never
 * be described two ways by the two surfaces. The summary counts per status over the
 * SAME filter via one bounded `groupBy`. The timeline proves existence tenant-scoped
 * first, then reads the SAME platform audit trail the register writes (`hr.leave`)
 * through `HrAuditGateway.read`.
 *
 * NOTHING IS INVENTED HERE. No balance, no duration, no rate, no SLA, no aging, no
 * inferred event, no status the lifecycle does not declare. The one decision this
 * file owns is the zero-fill of the summary over `LEAVE_REQUEST_STATUSES`, and even
 * that completes a count the database produced — it never makes one up.
 */
@Injectable()
export class HrLeaveRequestReportingReaderService implements HrLeaveRequestReportingReader {
  private readonly logger = new Logger(HrLeaveRequestReportingReaderService.name);

  constructor(
    private readonly leave: LeaveRepository,
    private readonly audit: HrAuditGateway
  ) {}

  /** One filtered page of the register, latest period first. */
  async listReportRows(
    scope: HrLeaveRequestReportingScope,
    query: HrLeaveRequestReportQuery
  ): Promise<HrLeaveRequestReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.leave.listRequestPage(
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

  /** Per-status counts over the SAME filter the list answers. */
  async getReportSummary(
    scope: HrLeaveRequestReportingScope,
    query: HrLeaveRequestReportQuery
  ): Promise<HrLeaveRequestReportSummary> {
    const counts = await this.leave.countByStatus(scope.tenantId, toRepositoryFilter(query));

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const status of LEAVE_REQUEST_STATUSES) {
      const count = counts.get(status) ?? 0;
      byStatus[status] = count;
      total += count;
    }
    return { total, byStatus };
  }

  /** One register row, or `null` for an id this tenant does not hold. */
  async getReportRow(
    scope: HrLeaveRequestReportingScope,
    leaveRequestId: string
  ): Promise<HrLeaveRequestReportRow | null> {
    const row = await this.leave.findRequestById(scope.tenantId, leaveRequestId);
    if (!row) return null;
    return toReportRow(row);
  }

  /** This row's report timeline — existence proven tenant-scoped FIRST. */
  async getReportTimeline(
    scope: HrLeaveRequestReportingScope,
    leaveRequestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrLeaveRequestReportTimelinePage> {
    const row = await this.leave.findRequestById(scope.tenantId, leaveRequestId);
    if (!row) {
      return { items: [], page: 1, pageSize: HR_DEFAULT_PAGE_SIZE, total: 0 };
    }

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      this.logger.error(`Reporting audit read rejected for leave ${row.id}: ${result.code}`);
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
 * The wire query → the repository's own filter: the `from`/`to` intersection window
 * resolved to UTC-midnight `Date` bounds (the SAME day arithmetic the register's
 * `LeaveService.resolveWindow` performs), plus the three remaining filters the
 * register supports. The FORMAT of each bound is validated at the DTO boundary; the
 * DATE ITSELF (a well-shaped but impossible day, an inverted window) is refused here
 * with the SAME 400 the register answers, so both surfaces refuse the same window.
 */
function toRepositoryFilter(query: HrLeaveRequestReportQuery): {
  employeeId?: string;
  leaveTypeId?: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  from?: Date;
  to?: Date;
} {
  const from = query.from ? parseReportDay(query.from, 'from') : undefined;
  const to = query.to ? parseReportDay(query.to, 'to') : undefined;
  if (from && to && to < from) {
    throw new BadRequestException('to must not precede from.');
  }

  return {
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

/**
 * `YYYY-MM-DD` → the UTC midnight instant Prisma stores for a `@db.Date` column.
 *
 * The DTO's `Matches` guarantees the SHAPE; this guards the remaining hole — a
 * well-shaped but NONEXISTENT day such as `2026-02-31`, which the ISO parser rolls
 * over instead of refusing. The day is read back and compared with what was sent,
 * the same round trip `LeaveService.parseDay` performs, so the report and the
 * register refuse the same day with the same 400.
 */
function parseReportDay(value: string, field: string): Date {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} must be a real YYYY-MM-DD date`);
  }
  return day;
}

/**
 * Projects a stored row onto the contract's reporting fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, `employeeId`, `leaveTypeId`,
 * `approvedAt`, `rejectedAt` and `updatedAt`, and none of them is on this report. A
 * spread-through would publish the next column the schema gains without this file
 * ever deciding it is safe for this surface. The two `@db.Date` days are rendered as
 * `YYYY-MM-DD` (a DAY, not «midnight UTC»); the two instants stay ISO, because a
 * moment stripped of its offset is a different moment.
 */
function toReportRow(row: LeaveReportRecord): HrLeaveRequestReportRow {
  return {
    id: row.id,
    employeeCode: row.employee.employeeCode,
    leaveTypeCode: row.leaveType.code,
    leaveTypeName: row.leaveType.name,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}
