import { COMMERCE_PAYMENT_METHODS, type CommercePaymentMethod } from './commerce-api';
import { coreGet } from './core-http';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Reporting client for
 * «گزارش تاریخچه پرداخت‌های بازرگانی» — four GETs mirroring
 * `payment-history-report.controller.ts` exactly:
 *
 *   GET /reporting/commerce/payment-history         (page + summary)
 *   GET /reporting/commerce/payment-history/:id     (one report row)
 *   GET /reporting/commerce/payment-history/export/xlsx
 *   GET /reporting/commerce/payment-history/export/docx
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO export, scheduling, or AI method — no backend contract exists for any of
 *    them.
 *  * NO `:id/timeline` — the contract offers no timeline (the payment audit trail is
 *    bound to the DOCUMENT, so a per-row read would lie by grain); a client method
 *    for it would be a fake endpoint by another name.
 *  * NO `paymentStatus` filter, NO currency/amount/actor filter — the source proves
 *    none of them answerable per row.
 *
 * The row type is the contract's explicit twelve-field whitelist, mirroring
 * `CommercePaymentReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, a `recordedByUserId` or a per-row status
 * that does not exist.
 *
 * THE METHOD VOCABULARY IS NOT REDEFINED HERE: `COMMERCE_PAYMENT_METHODS` and
 * `CommercePaymentMethod` come from `commerce-api.ts`, the same closed THREE-member
 * set the Commerce payment section's own client uses — one vocabulary, one file, both
 * surfaces speaking it. The Persian words come from `commercePaymentMethodLabel`
 * (`commerce-labels.ts`), which the server's export drift-spec pins.
 */

export { COMMERCE_PAYMENT_METHODS };
export type { CommercePaymentMethod };

/** One report row — the backend contract's explicit twelve-field whitelist. */
export interface ReportingPaymentRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  /** The exact stored `Decimal(18,4)` string — NEGATIVE on a compensating row. */
  amount: string;
  currency: string | null;
  method: CommercePaymentMethod;
  /** The business date of the payment — ISO instant. */
  paymentDate: string;
  payerRef: string | null;
  payeeRef: string | null;
  invoiceRef: string | null;
  externalReference: string | null;
  /** Non-null marks a COMPENSATING row naming the row it reverses. */
  reversesPaymentId: string | null;
}

/** Per-method counts over the SAME authorized filtered population as the list. */
export interface ReportingPaymentSummary {
  total: number;
  byMethod: Record<string, number>;
}

export interface ReportingPaymentHistoryPage {
  items: ReportingPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingPaymentSummary;
}

/**
 * The report list query — only the fields the DTO validates. `paymentFrom`/
 * `paymentTo` are the HALF-OPEN `[from, to)` ISO-instants the contract filters on;
 * the day-picker helpers below build them from civil days so the screen never
 * hand-rolls a boundary.
 */
export interface ReportingPaymentHistoryQuery {
  page?: number;
  pageSize?: number;
  method?: CommercePaymentMethod;
  search?: string;
  purchaseDocumentId?: string;
  paymentFrom?: string;
  paymentTo?: string;
}

/** The page size this report's screens use when the caller states none. */
export const PAYMENT_HISTORY_REPORT_PAGE_SIZE = 20;

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
 * `paymentDate`, so the lower bound is exact — no day ambiguity on this side.
 */
export function paymentHistoryDayToFromInstant(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * A picked civil day (`YYYY-MM-DD`) → the EXCLUSIVE upper instant: the START of the
 * NEXT day at 00:00 UTC. A «تا» of day D therefore includes every instant of D and
 * none of D+1 — same-day behaviour is «that whole day», stated in one place so the
 * screen, the export path and the spec below all speak the identical boundary.
 */
export function paymentHistoryDayToToInstant(day: string): string {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

/** One filtered page of the register, WITH its summary strip. */
export function fetchPaymentHistoryReport(
  query: ReportingPaymentHistoryQuery
): Promise<ReportingPaymentHistoryPage> {
  return coreGet<ReportingPaymentHistoryPage>(
    `/reporting/commerce/payment-history${queryString(query)}`
  );
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchPaymentHistoryReportRow(id: string): Promise<ReportingPaymentRow> {
  return coreGet<ReportingPaymentRow>(
    `/reporting/commerce/payment-history/${encodeURIComponent(id)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 */
export function paymentHistoryReportExportPath(
  query: ReportingPaymentHistoryQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/commerce/payment-history/export/${format}${queryString(query)}`;
}
