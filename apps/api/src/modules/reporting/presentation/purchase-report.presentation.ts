import {
  PURCHASE_DOCUMENT_STATUSES,
  type PurchaseDocumentKind,
  type PurchaseDocumentStatus,
} from '../../commerce/purchase/purchase-status';
import type {
  CommercePurchaseReportPage,
  CommercePurchaseReportQuery,
  CommercePurchaseReportSummary,
} from '../../commerce/reporting/commerce-purchase-reporting.contract';
import {
  reportDateLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the Commerce report's EXPORT presentation —
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query — same
 * rows, same summary, same filters — through the shared `ReportExportDocument` shape the
 * Financial export established. Nothing here is a report definition: this function is the
 * only thing that knows how THIS report becomes a document.
 *
 * COLUMNS MIRROR THE REGISTER TABLE, plus «ارز» beside «مبلغ کل» — the money column is
 * meaningless without its unit, and the unit lives in the same report row, so carrying it
 * is reading the contract rather than widening it. `totalAmount` stays `null` when the
 * document is unpriced: an empty cell / «—» means «not priced yet», never a zero that
 * would claim free goods (the contract's own rule).
 *
 * STATUS WORDS ARE TYPE-SEALED over the six-member lifecycle and pinned to the web's
 * `commerce-labels.ts` wording by the drift spec.
 */
export const PURCHASE_REPORT_TITLE = 'گزارش وضعیت و چرخه عمر درخواست‌های خرید';

export const PURCHASE_REPORT_FILE_BASE = 'purchase-report';

/** The lifecycle word per member — the web's `DOCUMENT_STATUS_LABELS` wording. */
export const PURCHASE_REPORT_STATUS_LABELS: Record<PurchaseDocumentStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'در حال بررسی',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
  CLOSED: 'بسته‌شده',
};

/** The one document kind §5.1 allows, in the web's `DOCUMENT_KIND_LABELS` wording. */
export const PURCHASE_REPORT_KIND_LABELS: Record<PurchaseDocumentKind, string> = {
  PURCHASE_REQUEST: 'درخواست خرید',
};

export function purchaseReportStatusExportLabel(status: string): string {
  return PURCHASE_REPORT_STATUS_LABELS[status as PurchaseDocumentStatus] ?? status;
}

export function purchaseReportKindExportLabel(kind: string): string {
  return PURCHASE_REPORT_KIND_LABELS[kind as PurchaseDocumentKind] ?? kind;
}

export type PurchaseReportExportResult = CommercePurchaseReportPage & {
  summary: CommercePurchaseReportSummary;
};

export function toPurchaseReportExportDocument(
  result: PurchaseReportExportResult,
  query: CommercePurchaseReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: PURCHASE_REPORT_TITLE,
    fileNameBase: PURCHASE_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status !== undefined
        ? [{ label: 'وضعیت', value: purchaseReportStatusExportLabel(query.status) }]
        : []),
      ...(query.search ? [{ label: 'جستجو (شماره سند)', value: query.search }] : []),
    ],
    summary: [
      ...PURCHASE_DOCUMENT_STATUSES.map((status) => ({
        label: purchaseReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'شماره سند', kind: 'text' },
      { header: 'نوع سند', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'مبلغ کل', kind: 'number' },
      { header: 'ارز', kind: 'text' },
      { header: 'تعداد اقلام', kind: 'number' },
      { header: 'تاریخ ایجاد', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.documentNumber,
      purchaseReportKindExportLabel(row.kind),
      purchaseReportStatusExportLabel(row.status),
      row.totalAmount !== null ? Number(row.totalAmount) : null,
      row.currency ?? '—',
      row.lineCount,
      reportDateLabel(row.createdAt),
    ]),
  };
}
