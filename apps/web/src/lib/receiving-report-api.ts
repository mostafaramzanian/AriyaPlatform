import { COMMERCE_RECEIVING_STATUSES, type CommerceReceivingStatus } from './commerce-api';
import { coreGet } from './core-http';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Reporting client for
 * «گزارش وضعیت دریافت‌های بازرگانی» — four GETs mirroring
 * `receiving-report.controller.ts` exactly:
 *
 *   GET /reporting/commerce/receiving         (page + summary)
 *   GET /reporting/commerce/receiving/:id     (one report row)
 *   GET /reporting/commerce/receiving/export/xlsx
 *   GET /reporting/commerce/receiving/export/docx
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO export/scheduling/AI method — no backend contract exists for any of them.
 *  * NO `:id/timeline` — the contract offers no timeline (the receiving audit
 *    trail is receipt-event-bound while the row is a purchase line; a client
 *    method for it would be a fake endpoint by another name).
 *  * NO supplier/warehouse/unit/quantity filters — the source proves none of
 *    them answerable (no warehouse column, opaque supplier, free-text unit).
 *
 * The row type is the contract's explicit eight-field whitelist, mirroring
 * `CommerceReceivingReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, a `receiverId` or a document-level
 * status that does not exist.
 *
 * THE STATUS VOCABULARY IS NOT REDEFINED HERE: `COMMERCE_RECEIVING_STATUSES` and
 * `CommerceReceivingStatus` come from `commerce-api.ts`, the same closed
 * THREE-member set the Commerce receiving section's own client uses — one
 * vocabulary, one file, both surfaces speaking it. The Persian words come from
 * `commerceReceivingStatusLabel` (`commerce-labels.ts`), which the server's
 * export drift-spec pins.
 */

export { COMMERCE_RECEIVING_STATUSES };
export type { CommerceReceivingStatus };

/** One report row — the backend contract's explicit eight-field whitelist. */
export interface ReportingReceivingRow {
  /** The PURCHASE LINE's id — the row IS the line (per-line grain, scope gate A). */
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  /** The line's OWN stored `Decimal(18,4)` string. */
  orderedQuantity: string;
  /** Σ over the line's whole receipt history — NEGATIVE when fully compensated away. */
  receivedQuantity: string;
  receivingStatus: CommerceReceivingStatus;
  /** The LATEST receiving instant of the line — ISO, or NULL when it has no events. */
  receivedAt: string | null;
  compensationCount: number;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingReceivingSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingReceivingPage {
  items: ReportingReceivingRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingReceivingSummary;
}

/**
 * The report list query — only the fields the DTO validates. `receivedFrom`/
 * `receivedTo` are the HALF-OPEN `[from, to)` ISO-instants the contract filters
 * on the line's LATEST receiving instant; the day-picker helpers below build
 * them from civil days so the screen never hand-rolls a boundary.
 */
export interface ReportingReceivingQuery {
  page?: number;
  pageSize?: number;
  status?: CommerceReceivingStatus;
  search?: string;
  purchaseDocumentId?: string;
  purchaseLineId?: string;
  receivedFrom?: string;
  receivedTo?: string;
}

/** The page size this report's screens use when the caller states none. */
export const RECEIVING_REPORT_PAGE_SIZE = 20;

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
 * half-open window: that day at 00:00 UTC.
 */
export function receivingDayToFromInstant(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * A picked civil day (`YYYY-MM-DD`) → the EXCLUSIVE upper instant: the START of
 * the NEXT day at 00:00 UTC. A «تا» of day D therefore includes every instant of
 * D and none of D+1 — same-day behaviour is «that whole day», stated in one
 * place so the screen, the export path and the spec below all speak the
 * identical boundary.
 */
export function receivingDayToToInstant(day: string): string {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

/** One filtered page of the register, WITH its summary strip. */
export function fetchReceivingReport(
  query: ReportingReceivingQuery
): Promise<ReportingReceivingPage> {
  return coreGet<ReportingReceivingPage>(`/reporting/commerce/receiving${queryString(query)}`);
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchReceivingReportRow(id: string): Promise<ReportingReceivingRow> {
  return coreGet<ReportingReceivingRow>(
    `/reporting/commerce/receiving/${encodeURIComponent(id)}`
  );
}

/**
 * The download path for a report export — the SAME query the screen lists with,
 * rendered by the server as a file.
 */
export function receivingReportExportPath(
  query: ReportingReceivingQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/commerce/receiving/export/${format}${queryString(query)}`;
}
