import { coreGet } from './core-http';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Reporting client for
 * «گزارش خلاصه و وضعیت عملیات تولید» — three GETs mirroring
 * `production-report.controller.ts` exactly:
 *
 *   GET /reporting/production/boms                (page + summary)
 *   GET /reporting/production/boms/:id            (one report row)
 *   GET /reporting/production/boms/:id/timeline   (read-only flow)
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO export, scheduling, or AI method — no backend contract exists for any of
 *    them (the isolation suite pins the absence).
 *  * NO date/window filter — the source read contract has none, so the client
 *    cannot send one.
 *  * NO `requesterUserId` filter — the source contract supports no actor-id
 *    filter, and no display contract exists for a raw actor id, so the DTO
 *    refuses it and this client never sends it.
 *
 * The row type is the contract's ten-field whitelist, mirroring
 * `ProductionReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an actor id, `comments`, `updatedAt`
 * or a version pin.
 */

/** The lifecycle members the report summary counts over — the source's closed set. */
export const PRODUCTION_REPORT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type ProductionReportStatus = (typeof PRODUCTION_REPORT_STATUSES)[number];

/** One report row — the backend contract's explicit ten-field whitelist. */
export interface ReportingProductionRow {
  id: string;
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
export interface ReportingProductionSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingProductionPage {
  items: ReportingProductionRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingProductionSummary;
}

export interface ReportingProductionTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingProductionTimelinePage {
  items: ReportingProductionTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingProductionReportQuery {
  page?: number;
  pageSize?: number;
  status?: ProductionReportStatus;
  search?: string;
}

/** The page size this report's screens use when the caller states none. */
export const PRODUCTION_REPORT_PAGE_SIZE = 20;

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
export function fetchProductionReport(
  query: ReportingProductionReportQuery
): Promise<ReportingProductionPage> {
  return coreGet<ReportingProductionPage>(`/reporting/production/boms${queryString(query)}`);
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchProductionReportRow(id: string): Promise<ReportingProductionRow> {
  return coreGet<ReportingProductionRow>(`/reporting/production/boms/${encodeURIComponent(id)}`);
}

/** This BOM's report timeline — read-only, and only on demand. */
export function fetchProductionReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingProductionTimelinePage> {
  return coreGet<ReportingProductionTimelinePage>(
    `/reporting/production/boms/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 *
 * A PATH, NOT A FETCH: the binary download runs through `downloadReportExport` (the one
 * authenticated blob helper), and this function only names `export/xlsx` + the query
 * string every other function in this module builds.
 */
export function productionReportExportPath(
  query: ReportingProductionReportQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/production/boms/export/${format}${queryString(query)}`;
}
