import { coreGet } from './core-http';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Reporting client for
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید» — three GETs mirroring
 * `purchase-report.controller.ts` exactly:
 *
 *   GET /reporting/commerce/purchase-documents                (page + summary)
 *   GET /reporting/commerce/purchase-documents/:id            (one report row)
 *   GET /reporting/commerce/purchase-documents/:id/timeline   (read-only flow)
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
 *  * NO `requesterId` filter — the source contract supports it but no display
 *    contract exists for a raw actor id, so the DTO refuses it and this client
 *    never sends it.
 *
 * The row type is the contract's twelve-field whitelist, mirroring
 * `CommercePurchaseReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an actor id or a version pin.
 */

/** The lifecycle members the report summary counts over — the source's closed set. */
export const PURCHASE_REPORT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const;

export type PurchaseReportStatus = (typeof PURCHASE_REPORT_STATUSES)[number];

/** One report row — the backend contract's explicit twelve-field whitelist. */
export interface ReportingPurchaseRow {
  id: string;
  documentNumber: string;
  kind: string;
  status: string;
  supplierId: string | null;
  currency: string | null;
  subtotalAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  lineCount: number;
  completedAt: string | null;
  createdAt: string;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingPurchaseSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingPurchasePage {
  items: ReportingPurchaseRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingPurchaseSummary;
}

export interface ReportingPurchaseTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingPurchaseTimelinePage {
  items: ReportingPurchaseTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingPurchaseReportQuery {
  page?: number;
  pageSize?: number;
  status?: PurchaseReportStatus;
  search?: string;
}

/** The page size this report's screens use when the caller states none. */
export const PURCHASE_REPORT_PAGE_SIZE = 20;

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
export function fetchPurchaseReport(
  query: ReportingPurchaseReportQuery
): Promise<ReportingPurchasePage> {
  return coreGet<ReportingPurchasePage>(
    `/reporting/commerce/purchase-documents${queryString(query)}`
  );
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchPurchaseReportRow(id: string): Promise<ReportingPurchaseRow> {
  return coreGet<ReportingPurchaseRow>(
    `/reporting/commerce/purchase-documents/${encodeURIComponent(id)}`
  );
}

/** This document's report timeline — read-only, and only on demand. */
export function fetchPurchaseReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingPurchaseTimelinePage> {
  return coreGet<ReportingPurchaseTimelinePage>(
    `/reporting/commerce/purchase-documents/${encodeURIComponent(id)}/timeline${queryString(query)}`
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
export function purchaseReportExportPath(
  query: ReportingPurchaseReportQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/commerce/purchase-documents/export/${format}${queryString(query)}`;
}
