import { PAYMENT_METHODS, type PaymentMethod } from '../../commerce/payment/payment-status';
import type {
  CommercePaymentReportPage,
  CommercePaymentReportQuery,
  CommercePaymentReportSummary,
} from '../../commerce/reporting/commerce-payment-reporting.contract';
import {
  reportDateTimeLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the payment report's EXPORT presentation —
 * «گزارش تاریخچه پرداخت‌های بازرگانی» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query — same
 * rows, same summary, same filters — through the shared `ReportExportDocument` shape the
 * seven sibling reports use. COLUMNS MIRROR THE REGISTER TABLE: document number, event
 * kind, method, amount (negative on a compensating row), currency, the payment instant
 * (the report's PRIMARY date), and the two display-safe opaque references. No rate, no
 * success ratio, no aging, no SLA, no accounting figure: the schema stores none of them.
 *
 * METHOD WORDS ARE TYPE-SEALED over the closed three-member set and pinned to the web's
 * `PAYMENT_METHOD_LABELS` wording by `report-export-labels.spec.ts`. The event-kind words
 * are the product's own: «رویداد جبرانی» is the badge `CommercePaymentsSection` already
 * shows for a compensating row, and «پرداخت» is this report's noun for every other row —
 * both derived ONLY from `reversesPaymentId !== null`, never invented per row.
 */
export const PAYMENT_HISTORY_REPORT_TITLE = 'گزارش تاریخچه پرداخت‌های بازرگانی';

export const PAYMENT_HISTORY_REPORT_FILE_BASE = 'commerce-payment-history-report';

/** The method word per member — the web's `PAYMENT_METHOD_LABELS` wording. */
export const PAYMENT_REPORT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'نقد',
  PETTY_CASH: 'تنخواه',
  CHECK: 'چک',
};

export function paymentReportMethodExportLabel(method: string): string {
  return PAYMENT_REPORT_METHOD_LABELS[method as PaymentMethod] ?? method;
}

/**
 * The event-kind words — a compensating row (non-null `reversesPaymentId`) versus an
 * ordinary payment. The distinction is source-proven (contract Q4: compensation is the
 * ONLY correction mechanism) and must be legible in a register whose negative amounts
 * would otherwise read as a mistake.
 */
export const PAYMENT_REPORT_KIND_LABELS = {
  payment: 'پرداخت',
  compensation: 'رویداد جبرانی',
} as const;

export type PaymentReportExportResult = CommercePaymentReportPage & {
  summary: CommercePaymentReportSummary;
};

export function toPaymentHistoryReportExportDocument(
  result: PaymentReportExportResult,
  query: CommercePaymentReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: PAYMENT_HISTORY_REPORT_TITLE,
    fileNameBase: PAYMENT_HISTORY_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.method !== undefined
        ? [{ label: 'روش پرداخت', value: paymentReportMethodExportLabel(query.method) }]
        : []),
      ...(query.search ? [{ label: 'جستجو', value: query.search }] : []),
      ...(query.purchaseDocumentId
        ? [{ label: 'شناسه سند خرید', value: query.purchaseDocumentId }]
        : []),
      ...(query.paymentFrom
        ? [{ label: 'از (تاریخ پرداخت)', value: reportDateTimeLabel(query.paymentFrom) }]
        : []),
      ...(query.paymentTo
        ? [{ label: 'تا (تاریخ پرداخت)', value: reportDateTimeLabel(query.paymentTo) }]
        : []),
    ],
    summary: [
      ...PAYMENT_METHODS.map((method) => ({
        label: paymentReportMethodExportLabel(method),
        value: result.summary.byMethod[method] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'شماره سند', kind: 'text' },
      { header: 'نوع رویداد', kind: 'text' },
      { header: 'روش پرداخت', kind: 'text' },
      { header: 'مبلغ', kind: 'number' },
      { header: 'ارز', kind: 'text' },
      { header: 'تاریخ پرداخت', kind: 'text' },
      { header: 'مرجع صورتحساب', kind: 'text' },
      { header: 'مرجع خارجی', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.purchaseDocumentNumber,
      row.reversesPaymentId !== null
        ? PAYMENT_REPORT_KIND_LABELS.compensation
        : PAYMENT_REPORT_KIND_LABELS.payment,
      paymentReportMethodExportLabel(row.method),
      Number(row.amount),
      row.currency ?? '—',
      reportDateTimeLabel(row.paymentDate),
      row.invoiceRef ?? '—',
      row.externalReference ?? '—',
    ]),
  };
}
