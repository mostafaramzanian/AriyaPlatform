import { coreGet } from './core-http';
import { HR_ATTENDANCE_SOURCES, type HrAttendanceSource } from './hr-api';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the Reporting client for
 * «گزارش تردد پرسنل» — three GETs mirroring
 * `hr-personnel-traffic-report.controller.ts` exactly:
 *
 *   GET /reporting/hr/personnel-traffic                (page + summary)
 *   GET /reporting/hr/personnel-traffic/:id            (one report row)
 *   GET /reporting/hr/personnel-traffic/:id/timeline   (read-only flow)
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO export, scheduling, or AI method — no backend contract exists for any of
 *    them (the isolation suite pins the absence).
 *  * NO `employeeId` filter — a raw personnel uuid with no display contract and
 *    no reporting navigation target; `search` presses on the employee CODE, the
 *    person key an operator actually knows (the same reason the sibling report
 *    clients refuse an actor-id filter).
 *  * NO status / attendance-rate / duration field — the HR schema stores none of
 *    them (§13), and a client type claiming one would be lying about the wire.
 *
 * The row type is the contract's eight-field whitelist, mirroring
 * `HrPersonnelTrafficReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an `employeeId` or a bookkeeping column.
 *
 * THE SOURCE VOCABULARY IS NOT REDEFINED HERE: `HR_ATTENDANCE_SOURCES` and
 * `HrAttendanceSource` come from `hr-api.ts`, the same closed two-member set
 * (`DEVICE`, `MANUAL`) the HR register's own client uses — one vocabulary, one
 * file, both the register screen and this report speaking it.
 */

export { HR_ATTENDANCE_SOURCES };
export type { HrAttendanceSource };

/** One report row — the backend contract's explicit eight-field whitelist. */
export interface ReportingPersonnelTrafficRow {
  id: string;
  employeeCode: string;
  /** Gregorian civil day, `YYYY-MM-DD`. */
  workDate: string;
  /** The same day in the Jalali calendar, `YYYY/MM/DD` — the server's derivation. */
  dateKey: string;
  /** The punch that opened the day — ISO instant. */
  clockIn: string;
  /** The punch that closed it, or `null` while the day is open. */
  clockOut: string | null;
  source: HrAttendanceSource;
  /** A correction's stated reason; `null` on a device row. */
  reason: string | null;
}

/** Per-source counts over the SAME authorized filtered population as the list. */
export interface ReportingPersonnelTrafficSummary {
  total: number;
  bySource: Record<string, number>;
}

export interface ReportingPersonnelTrafficPage {
  items: ReportingPersonnelTrafficRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingPersonnelTrafficSummary;
}

export interface ReportingPersonnelTrafficTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingPersonnelTrafficTimelinePage {
  items: ReportingPersonnelTrafficTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingPersonnelTrafficQuery {
  page?: number;
  pageSize?: number;
  /** Inclusive Gregorian bounds, `YYYY-MM-DD` — mutually exclusive with `dateKey`. */
  from?: string;
  to?: string;
  /** One Jalali day, `YYYY/MM/DD`. */
  dateKey?: string;
  source?: HrAttendanceSource;
  search?: string;
}

/** The page size this report's screens use when the caller states none. */
export const HR_PERSONNEL_TRAFFIC_PAGE_SIZE = 20;

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
export function fetchHrPersonnelTrafficReport(
  query: ReportingPersonnelTrafficQuery
): Promise<ReportingPersonnelTrafficPage> {
  return coreGet<ReportingPersonnelTrafficPage>(
    `/reporting/hr/personnel-traffic${queryString(query)}`
  );
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchHrPersonnelTrafficReportRow(
  id: string
): Promise<ReportingPersonnelTrafficRow> {
  return coreGet<ReportingPersonnelTrafficRow>(
    `/reporting/hr/personnel-traffic/${encodeURIComponent(id)}`
  );
}

/** This row's report timeline — read-only, and only on demand. */
export function fetchHrPersonnelTrafficReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingPersonnelTrafficTimelinePage> {
  return coreGet<ReportingPersonnelTrafficTimelinePage>(
    `/reporting/hr/personnel-traffic/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 *
 * A PATH, NOT A FETCH: the binary download runs through `downloadReportExport` (the one
 * authenticated blob helper), and this function only names `export/xlsx` + the query
 * string every other function in this module builds — day window, source and code
 * search alike, so the file and the table are the same question asked twice.
 */
export function hrPersonnelTrafficReportExportPath(
  query: ReportingPersonnelTrafficQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/hr/personnel-traffic/export/${format}${queryString(query)}`;
}
