import { coreGet } from './core-http';
import { HR_LEAVE_REQUEST_STATUSES, type HrLeaveRequestStatus } from './hr-api';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the Reporting client for
 * «گزارش وضعیت درخواست‌های مرخصی» — five GETs mirroring
 * `hr-leave-report.controller.ts` exactly:
 *
 *   GET /reporting/hr/leave-requests                (page + summary)
 *   GET /reporting/hr/leave-requests/:id            (one report row)
 *   GET /reporting/hr/leave-requests/:id/timeline   (authoritative audit flow)
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO `search` — `LeaveService.list` deliberately ignores one, so a control
 *    here would claim a narrowing the server never performs (the same rule the
 *    register's own client states in `hr-api.ts`).
 *  * NO duration / balance / rate field — the HR schema stores none of them
 *    (§13), and a client type claiming one would be lying about the wire.
 *
 * The row type is the contract's explicit whitelist, mirroring
 * `HrLeaveRequestReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an `employeeId` or a bookkeeping column.
 *
 * THE STATUS VOCABULARY IS NOT REDEFINED HERE: `HR_LEAVE_REQUEST_STATUSES` and
 * `HrLeaveRequestStatus` come from `hr-api.ts`, the same closed four-member set
 * (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`) the HR register's own client
 * uses — one vocabulary, one file, both surfaces speaking it. The Persian words
 * come from `hrLeaveRequestStatusLabel`, which the export drift-spec pins.
 */

export { HR_LEAVE_REQUEST_STATUSES };
export type { HrLeaveRequestStatus };

/** One report row — the backend contract's explicit whitelist. */
export interface ReportingLeaveRow {
  id: string;
  employeeCode: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  /** Gregorian civil day, `YYYY-MM-DD` — the first requested day, inclusive. */
  startDate: string;
  /** Gregorian civil day, `YYYY-MM-DD` — the last requested day, inclusive. */
  endDate: string;
  reason: string;
  status: HrLeaveRequestStatus;
  /** When the row was recorded — ISO instant. */
  createdAt: string;
  /** When a pending request was withdrawn, or `null` while it stands. */
  cancelledAt: string | null;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingLeaveSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingLeavePage {
  items: ReportingLeaveRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingLeaveSummary;
}

export interface ReportingLeaveTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingLeaveTimelinePage {
  items: ReportingLeaveTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingLeaveQuery {
  page?: number;
  pageSize?: number;
  /** Inclusive Gregorian bounds on the REQUESTED period (intersection). */
  from?: string;
  to?: string;
  status?: HrLeaveRequestStatus;
  /** The person the request is FOR — a raw id, as the source filter states it. */
  employeeId?: string;
  /** The tenant's own catalogue entry — a raw id, as the source filter states it. */
  leaveTypeId?: string;
}

/** The page size this report's screens use when the caller states none. */
export const HR_LEAVE_REPORT_PAGE_SIZE = 20;

function queryString(params: object): string {
  const search = new URLSearchParams();
  const entries = Object.entries(params) as [string, string | number | undefined][];
  for (const [key, value] of entries) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** One filtered page of the register, WITH its summary strip. */
export function fetchHrLeaveReport(query: ReportingLeaveQuery): Promise<ReportingLeavePage> {
  return coreGet<ReportingLeavePage>(`/reporting/hr/leave-requests${queryString(query)}`);
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchHrLeaveReportRow(id: string): Promise<ReportingLeaveRow> {
  return coreGet<ReportingLeaveRow>(`/reporting/hr/leave-requests/${encodeURIComponent(id)}`);
}

/** This row's report timeline — read-only, and only on demand. */
export function fetchHrLeaveReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingLeaveTimelinePage> {
  return coreGet<ReportingLeaveTimelinePage>(
    `/reporting/hr/leave-requests/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 */
export function hrLeaveReportExportPath(
  query: ReportingLeaveQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/hr/leave-requests/export/${format}${queryString(query)}`;
}
