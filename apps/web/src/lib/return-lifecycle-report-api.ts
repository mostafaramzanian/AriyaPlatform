import { COMMERCE_RETURN_STATES, type CommerceReturnState } from './commerce-api';
import { coreGet } from './core-http';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Reporting client for
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی» — FIVE GETs mirroring
 * `return-lifecycle-report.controller.ts` exactly:
 *
 *   GET /reporting/commerce/return-lifecycle          (page + summary)
 *   GET /reporting/commerce/return-lifecycle/:id      (one report row + lines)
 *   GET /reporting/commerce/return-lifecycle/:id/timeline (lifecycle audit trail)
 *   GET /reporting/commerce/return-lifecycle/export/xlsx
 *   GET /reporting/commerce/return-lifecycle/export/docx
 *
 * THE STATE VOCABULARY IS NOT REDEFINED HERE: `COMMERCE_RETURN_STATES` and
 * `CommerceReturnState` come from `commerce-api.ts`, the same closed FIVE-member
 * set the Commerce returns section's own client uses — one vocabulary, one file,
 * both surfaces speaking it. The Persian words come from `commerceReturnStateLabel`
 * (`commerce-labels.ts`), which the server's export drift-spec pins.
 */

export { COMMERCE_RETURN_STATES };
export type { CommerceReturnState };

/** One returned quantity as the detail read carries it — exact decimal strings. */
export interface ReportingReturnLine {
  id: string;
  purchaseLineId: string;
  receiptLineId: string;
  quantity: string;
  createdAt: string;
}

/** One report row — the backend contract's explicit eight-field whitelist. */
export interface ReportingReturnRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  /** The PROJECTED lifecycle member — never a column, answered by `projectReturnState`. */
  state: CommerceReturnState;
  reason: string;
  replacementRequired: boolean;
  lineCount: number;
  /** The request instant of the return — the report's PRIMARY date. */
  createdAt: string;
}

/** The detail projection: the report row plus its lines, oldest first. */
export interface ReportingReturnDetail extends ReportingReturnRow {
  lines: ReportingReturnLine[];
}

/** One audit-backed lifecycle event of a return. */
export interface ReportingReturnTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingReturnTimelinePage {
  items: ReportingReturnTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** Per-state counts over the SAME authorized filtered population as the list. */
export interface ReportingReturnSummary {
  total: number;
  byState: Record<string, number>;
}

export interface ReportingReturnLifecyclePage {
  items: ReportingReturnRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingReturnSummary;
}

/**
 * The report list query — only the fields the DTO validates. `createdFrom`/
 * `createdTo` are the HALF-OPEN `[from, to)` ISO-instants the contract filters on;
 * the day-picker helpers below build them from civil days so the screen never
 * hand-rolls a boundary.
 */
export interface ReportingReturnLifecycleQuery {
  page?: number;
  pageSize?: number;
  state?: CommerceReturnState;
  search?: string;
  purchaseDocumentId?: string;
  createdFrom?: string;
  createdTo?: string;
}

/** The page size this report's screens use when the caller states none. */
export const RETURN_LIFECYCLE_REPORT_PAGE_SIZE = 20;

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

/**
 * A picked civil day (`YYYY-MM-DD`) → the INCLUSIVE lower instant of the report's
 * half-open window: that day at 00:00 UTC. The server reads `[from, to)` on
 * `createdAt`, so the lower bound is exact — no day ambiguity on this side.
 */
export function returnLifecycleDayToFromInstant(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * A picked civil day (`YYYY-MM-DD`) → the EXCLUSIVE upper instant: the START of the
 * NEXT day at 00:00 UTC. A «تا» of day D therefore includes every instant of D and
 * none of D+1 — same-day behaviour is «that whole day», stated in one place so the
 * screen, the export path and the spec below all speak the identical boundary.
 */
export function returnLifecycleDayToToInstant(day: string): string {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

/** One filtered page of the register, WITH its summary strip. */
export function fetchReturnLifecycleReport(
  query: ReportingReturnLifecycleQuery
): Promise<ReportingReturnLifecyclePage> {
  return coreGet<ReportingReturnLifecyclePage>(
    `/reporting/commerce/return-lifecycle${queryString(query)}`
  );
}

/** One report row with its lines — 404 (a typed error) when the id is unknown or foreign. */
export function fetchReturnLifecycleReportRow(id: string): Promise<ReportingReturnDetail> {
  return coreGet<ReportingReturnDetail>(
    `/reporting/commerce/return-lifecycle/${encodeURIComponent(id)}`
  );
}

/** This return's audit-backed lifecycle timeline — resourceId = THIS return id. */
export function fetchReturnLifecycleReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingReturnTimelinePage> {
  return coreGet<ReportingReturnTimelinePage>(
    `/reporting/commerce/return-lifecycle/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 */
export function returnLifecycleReportExportPath(
  query: ReportingReturnLifecycleQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/commerce/return-lifecycle/export/${format}${queryString(query)}`;
}
