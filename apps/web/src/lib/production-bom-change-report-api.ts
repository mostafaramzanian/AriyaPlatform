import { coreGet } from './core-http';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Reporting client for
 * «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)» — five GETs mirroring
 * `production-bom-change-report.controller.ts` exactly:
 *
 *   GET /reporting/production/bom-change-requests                (page + summary)
 *   GET /reporting/production/bom-change-requests/:id            (one report row)
 *   GET /reporting/production/bom-change-requests/:id/timeline   (read-only flow)
 *
 * plus the two export paths built from the SAME query string.
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO requester/approver filter — the source contract supports no actor-id
 *    filter, and no display contract exists for a raw actor id, so the DTO
 *    refuses it and this client never sends it.
 *  * NO date filter — the source list contract has none, so the client cannot
 *    send one.
 *
 * The row type is the contract's ELEVEN-field whitelist, mirroring
 * `ProductionBomChangeReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an actor id, `notes` or `updatedAt`.
 */

/** The lifecycle members the report summary counts over — the source's closed set. */
export const PRODUCTION_BOM_CHANGE_REPORT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
] as const;

export type ProductionBomChangeReportStatus =
  (typeof PRODUCTION_BOM_CHANGE_REPORT_STATUSES)[number];

/** One report row — the backend contract's explicit eleven-field whitelist. */
export interface ReportingProductionBomChangeRow {
  id: string;
  bomId: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  status: string;
  managerOpinion: string | null;
  itemCount: number;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingProductionBomChangeSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingProductionBomChangePage {
  items: ReportingProductionBomChangeRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingProductionBomChangeSummary;
}

export interface ReportingProductionBomChangeTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingProductionBomChangeTimelinePage {
  items: ReportingProductionBomChangeTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingProductionBomChangeReportQuery {
  page?: number;
  pageSize?: number;
  bomId?: string;
  projectRef?: string;
  status?: ProductionBomChangeReportStatus;
  search?: string;
}

/** The page size this report's screens use when the caller states none. */
export const PRODUCTION_BOM_CHANGE_REPORT_PAGE_SIZE = 20;

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
export function fetchProductionBomChangeReport(
  query: ReportingProductionBomChangeReportQuery
): Promise<ReportingProductionBomChangePage> {
  return coreGet<ReportingProductionBomChangePage>(
    `/reporting/production/bom-change-requests${queryString(query)}`
  );
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchProductionBomChangeReportRow(
  id: string
): Promise<ReportingProductionBomChangeRow> {
  return coreGet<ReportingProductionBomChangeRow>(
    `/reporting/production/bom-change-requests/${encodeURIComponent(id)}`
  );
}

/** This request's report timeline — read-only, and only on demand. */
export function fetchProductionBomChangeReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingProductionBomChangeTimelinePage> {
  return coreGet<ReportingProductionBomChangeTimelinePage>(
    `/reporting/production/bom-change-requests/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * The download path for a report export — the SAME query the screen lists with,
 * rendered by the server as a file.
 *
 * A PATH, NOT A FETCH: the binary download runs through `downloadReportExport` (the one
 * authenticated blob helper), and this function only names `export/xlsx` + `export/docx`
 * + the query string every other function in this module builds.
 */
export function productionBomChangeReportExportPath(
  query: ReportingProductionBomChangeReportQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/production/bom-change-requests/export/${format}${queryString(query)}`;
}
