import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MissionRepository } from '../mission/mission.repository';
import { MISSION_REQUEST_STATUSES, type MissionRequestStatus } from '../domain/mission-status';
import type { MissionDurationMode, MissionEngagementType, MissionLocationType } from '../domain/mission-options';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_RESOURCE, HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';
import type {
  HrMissionRequestReportPage,
  HrMissionRequestReportQuery,
  HrMissionRequestReportRow,
  HrMissionRequestReportSummary,
  HrMissionRequestReportTimelinePage,
  HrMissionRequestReportingReader,
  HrMissionRequestReportingScope,
} from './hr-mission-reporting.contract';

/**
 * The request row as the two reporting reads receive it — a row plus its employee
 * label, stated STRUCTURALLY so the seam never names a Prisma type. The repository
 * returns strictly more columns; the whitelist below is what crosses.
 */
interface MissionReportRecord {
  id: string;
  durationMode: MissionDurationMode;
  locationType: MissionLocationType;
  engagementType: MissionEngagementType;
  startDate: Date;
  endDate: Date;
  startTime: string | null;
  endTime: string | null;
  destination: string | null;
  description: string | null;
  correctionReason: string | null;
  rejectionReason: string | null;
  submittedRevision: number | null;
  status: MissionRequestStatus;
  createdAt: Date;
  employee: { id: string; employeeCode: string };
}

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the HR-owned IMPLEMENTATION of the Reporting
 * read contract — the approved seam Reporting reads through, the exact shape the six
 * sibling readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the
 * contract's explicit whitelist, so the repository's write surface (create, update,
 * submit, resubmit, cancel, the approval decisions) stays unreachable by construction.
 *
 * List and detail reuse the SAME tenant-scoped repository statements the register's
 * own routes read — `listRequestPage` and `findRequestById` — so a request can never
 * be described two ways by the two surfaces. The summary counts per status over the
 * SAME filter via one bounded `groupBy` on the ONE shared predicate builder. The
 * timeline proves existence tenant-scoped first, then reads the SAME platform audit
 * trail the register writes (`hr.mission`) through `HrAuditGateway.read`.
 *
 * NOTHING IS INVENTED HERE. No duration, no rate, no SLA, no aging, no inferred
 * event, no status the lifecycle does not declare. The one decision this file owns is
 * the zero-fill of the summary over `MISSION_REQUEST_STATUSES`, and even that
 * completes a count the database produced — it never makes one up.
 */
@Injectable()
export class HrMissionRequestReportingReaderService implements HrMissionRequestReportingReader {
  private readonly logger = new Logger(HrMissionRequestReportingReaderService.name);

  constructor(
    private readonly mission: MissionRepository,
    private readonly audit: HrAuditGateway
  ) {}

  /** One filtered page of the register, latest created first. */
  async listReportRows(
    scope: HrMissionRequestReportingScope,
    query: HrMissionRequestReportQuery
  ): Promise<HrMissionRequestReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.mission.listRequestPage(
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
    scope: HrMissionRequestReportingScope,
    query: HrMissionRequestReportQuery
  ): Promise<HrMissionRequestReportSummary> {
    const filter = toRepositoryFilter(query);
    const [counts, page] = await Promise.all([
      this.mission.countByStatus(scope.tenantId, filter),
      this.mission.listRequestPage(scope.tenantId, filter, { skip: 0, take: 1 }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const status of MISSION_REQUEST_STATUSES) {
      byStatus[status] = counts.get(status) ?? 0;
    }

    return { total: page[1], byStatus };
  }

  /** One report row, or `null` for another tenant's row. */
  async getReportRow(
    scope: HrMissionRequestReportingScope,
    missionRequestId: string
  ): Promise<HrMissionRequestReportRow | null> {
    const row = await this.mission.findRequestById(scope.tenantId, missionRequestId);
    return row ? toReportRow(row) : null;
  }

  /**
   * This request's report timeline — existence tenant-scoped FIRST (so a foreign id
   * is an empty page, not an audit probe), then the SAME `hr.mission` trail the
   * register writes. A rejected audit read is re-thrown as the platform's closed
   * `AUDIT_READ_FAILED` so the service can answer 503 — never an empty page.
   */
  async getReportTimeline(
    scope: HrMissionRequestReportingScope,
    missionRequestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrMissionRequestReportTimelinePage> {
    const existing = await this.mission.findRequestById(scope.tenantId, missionRequestId);
    if (!existing) {
      return { items: [], page: 1, pageSize: HR_DEFAULT_PAGE_SIZE, total: 0 };
    }

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: HR_AUDIT_RESOURCE.MISSION,
      resourceId: missionRequestId,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      const error = new Error('Audit history is temporarily unavailable.') as Error & {
        code?: string;
      };
      error.code = result.code ?? 'AUDIT_READ_FAILED';
      throw error;
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
 * resolved to UTC-midnight `Date` bounds (the SAME day arithmetic the register
 * performs), plus the three remaining filters the register supports. The FORMAT of
 * each bound is validated at the DTO boundary; the DATE ITSELF (a well-shaped but
 * impossible day, an inverted window) is refused here with the SAME 400 the register
 * answers, so both surfaces refuse the same window.
 */
function toRepositoryFilter(query: HrMissionRequestReportQuery): {
  employeeId?: string;
  status?: MissionRequestStatus;
  durationMode?: 'HOURLY' | 'DAILY';
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
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.durationMode === 'HOURLY' || query.durationMode === 'DAILY'
      ? { durationMode: query.durationMode }
      : {}),
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
 * the same round trip the leave report performs, so the report and the register
 * refuse the same day with the same 400.
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
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, `employeeId`, option selections,
 * `approvedAt`, `rejectedAt`, `cancelledAt` and `updatedAt`, and none of them is on
 * this report. A spread-through would publish the next column the schema gains
 * without this file ever deciding it is safe for this surface. The two `@db.Date`
 * days are rendered as `YYYY-MM-DD` (a DAY, not «midnight UTC»); the two clock times
 * are stored `HH:MM[:SS]` strings and pass through verbatim; `createdAt` stays ISO,
 * because a moment stripped of its offset is a different moment.
 */
function toReportRow(row: MissionReportRecord): HrMissionRequestReportRow {
  return {
    id: row.id,
    employeeCode: row.employee.employeeCode,
    durationMode: row.durationMode,
    locationType: row.locationType,
    engagementType: row.engagementType,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    startTime: row.startTime,
    endTime: row.endTime,
    destination: row.destination,
    description: row.description,
    correctionReason: row.correctionReason,
    rejectionReason: row.rejectionReason,
    submittedRevision: row.submittedRevision,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
