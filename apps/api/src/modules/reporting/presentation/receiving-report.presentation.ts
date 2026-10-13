import { RECEIVING_STATUSES, type ReceivingStatus } from '../../commerce/receiving/receiving-status';
import type {
  CommerceReceivingReportPage,
  CommerceReceivingReportQuery,
  CommerceReceivingReportSummary,
} from '../../commerce/reporting/commerce-receiving-reporting.contract';
import {
  reportDateTimeLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the receiving report's EXPORT
 * presentation — «گزارش وضعیت دریافت‌های بازرگانی» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query —
 * same rows, same summary, same filters — through the shared
 * `ReportExportDocument` shape the eight sibling reports use. COLUMNS MIRROR THE
 * REGISTER TABLE: document number, receiving status, ordered quantity, received
 * quantity (Σ over the whole history — negative on a fully-compensated line),
 * the latest receiving instant, and the count of compensating events. No rate,
 * no fulfillment percentage, no delay, no SLA, no supplier performance, no
 * inventory balance: the schema stores none of them and the scope gate refuses
 * inventing them.
 *
 * STATUS WORDS ARE TYPE-SEALED over the closed three-member set and pinned to the
 * web's `RECEIVING_STATUS_LABELS` wording by `report-export-labels.spec.ts` —
 * one vocabulary, two surfaces, one spelling each.
 */
export const RECEIVING_REPORT_TITLE = 'گزارش وضعیت دریافت‌های بازرگانی';

export const RECEIVING_REPORT_FILE_BASE = 'commerce-receiving-status-report';

/** The status word per member — the web's `RECEIVING_STATUS_LABELS` wording. */
export const RECEIVING_REPORT_STATUS_LABELS: Record<ReceivingStatus, string> = {
  NOT_RECEIVED: 'دریافت‌نشده',
  PARTIALLY_RECEIVED: 'دریافت جزئی',
  FULLY_RECEIVED: 'دریافت کامل',
};

export function receivingReportStatusExportLabel(status: string): string {
  return RECEIVING_REPORT_STATUS_LABELS[status as ReceivingStatus] ?? status;
}

export type ReceivingReportExportResult = CommerceReceivingReportPage & {
  summary: CommerceReceivingReportSummary;
};

export function toReceivingReportExportDocument(
  result: ReceivingReportExportResult,
  query: CommerceReceivingReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: RECEIVING_REPORT_TITLE,
    fileNameBase: RECEIVING_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status
        ? [{ label: 'وضعیت دریافت', value: receivingReportStatusExportLabel(query.status) }]
        : []),
      ...(query.search ? [{ label: 'جستجو', value: query.search }] : []),
      ...(query.purchaseDocumentId
        ? [{ label: 'شناسه سند خرید', value: query.purchaseDocumentId }]
        : []),
      ...(query.purchaseLineId
        ? [{ label: 'شناسه ردیف خرید', value: query.purchaseLineId }]
        : []),
      ...(query.receivedFrom
        ? [{ label: 'از (تاریخ دریافت)', value: reportDateTimeLabel(query.receivedFrom) }]
        : []),
      ...(query.receivedTo
        ? [{ label: 'تا (تاریخ دریافت)', value: reportDateTimeLabel(query.receivedTo) }]
        : []),
    ],
    summary: [
      ...RECEIVING_STATUSES.map((status) => ({
        label: receivingReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'شماره سند', kind: 'text' },
      { header: 'وضعیت دریافت', kind: 'text' },
      { header: 'مقدار سفارش', kind: 'number' },
      { header: 'مقدار دریافتی', kind: 'number' },
      { header: 'آخرین تاریخ دریافت', kind: 'text' },
      { header: 'رویدادهای جبرانی', kind: 'number' },
    ],
    rows: result.items.map((row) => [
      row.purchaseDocumentNumber,
      receivingReportStatusExportLabel(row.receivingStatus),
      Number(row.orderedQuantity),
      Number(row.receivedQuantity),
      row.receivedAt !== null ? reportDateTimeLabel(row.receivedAt) : '—',
      row.compensationCount,
    ]),
  };
}
