import { coreGet } from './core-http';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Reporting client for
 * «گزارش وضعیت و گردش درخواست‌های صدور چک» — three GETs mirroring
 * `check-request-report.controller.ts` exactly:
 *
 *   GET /reporting/financial/check-requests                (page + summary)
 *   GET /reporting/financial/check-requests/:id            (one report row)
 *   GET /reporting/financial/check-requests/:id/timeline   (read-only flow)
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing
 *    to POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO export, scheduling, or AI method — no backend contract exists for any
 *    of them (the isolation suite pins the absence).
 *  * NO date/window filter — the source read contract has none, so the client
 *    cannot send one.
 *
 * The row type is the contract's twelve-field whitelist, mirroring
 * `FinancialCheckRequestReportRow`; nothing richer crosses the wire, so the
 * screen physically cannot render a `tenantId` or an actor id.
 */

/** The lifecycle ordinals the report summary counts over — the source set. */
export const REPORTING_CHECK_REQUEST_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 50] as const;

/** One report row — the backend contract's explicit twelve-field whitelist. */
export interface ReportingCheckRequestRow {
  id: string;
  title: string;
  checkIssueType: string;
  purchaseType: string | null;
  orderReference: string | null;
  projectReference: string | null;
  requestDate: string;
  requesterOpinion: string;
  status: number;
  managerDecision: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingCheckRequestSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingCheckRequestPage {
  items: ReportingCheckRequestRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingCheckRequestSummary;
}

export interface ReportingTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingTimelinePage {
  items: ReportingTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingCheckRequestReportQuery {
  page?: number;
  pageSize?: number;
  status?: number;
  search?: string;
}

/** The page size this report's screens use when the caller states none. */
export const REPORTING_CHECK_REQUEST_PAGE_SIZE = 20;

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
export function fetchCheckRequestReport(
  query: ReportingCheckRequestReportQuery
): Promise<ReportingCheckRequestPage> {
  return coreGet<ReportingCheckRequestPage>(
    `/reporting/financial/check-requests${queryString(query)}`
  );
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchCheckRequestReportRow(id: string): Promise<ReportingCheckRequestRow> {
  return coreGet<ReportingCheckRequestRow>(
    `/reporting/financial/check-requests/${encodeURIComponent(id)}`
  );
}

/** This request's report timeline — read-only, and only on demand. */
export function fetchCheckRequestReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingTimelinePage> {
  return coreGet<ReportingTimelinePage>(
    `/reporting/financial/check-requests/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 *
 * A PATH, NOT A FETCH: the binary download runs through `downloadReportExport` (the one
 * authenticated blob helper), and this function only names `export/xlsx` + the query
 * string every other function in this module builds. Two surfaces — table and file —
 * over one object, so the exported filters can never differ from the visible ones.
 */
export function checkRequestReportExportPath(
  query: ReportingCheckRequestReportQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/financial/check-requests/export/${format}${queryString(query)}`;
}
