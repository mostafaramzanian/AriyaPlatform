import { RETURN_STATES, type ReturnState } from '../../commerce/returns/return-lifecycle';
import type {
  CommerceReturnReportPage,
  CommerceReturnReportQuery,
  CommerceReturnReportSummary,
} from '../../commerce/reporting/return-lifecycle-reporting.contract';
import {
  reportDateTimeLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the return report's EXPORT presentation —
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query — same
 * rows, same summary, same filters — through the shared `ReportExportDocument` shape
 * the sibling reports use. COLUMNS MIRROR THE REGISTER TABLE: parent document number,
 * the PROJECTED lifecycle state, the stated reason, replacement and line count, and
 * the request instant (the report's PRIMARY date). No money, no refund amount, no
 * rate, no aging, no SLA: the schema stores none of them on this grain.
 *
 * STATE WORDS ARE TYPE-SEALED over the closed five-member set and pinned to the
 * web's `RETURN_STATE_LABELS` wording by `report-export-labels.spec.ts` — the exact
 * words the commerce returns section already shows («درخواست‌شده»/«تأییدشده»/«کالا
 * برگشت خورد»/«بازپرداخت‌شده»/«ردشده»): one lifecycle, two surfaces, one wording.
 */
export const RETURN_LIFECYCLE_REPORT_TITLE = 'گزارش چرخه حیات مرجوعی‌های بازرگانی';

export const RETURN_LIFECYCLE_REPORT_FILE_BASE = 'commerce-return-lifecycle-report';

/** The state word per member — the web's `RETURN_STATE_LABELS` wording. */
export const RETURN_REPORT_STATE_LABELS: Record<ReturnState, string> = {
  REQUESTED: 'درخواست‌شده',
  APPROVED: 'تأییدشده',
  RECEIVED_BACK: 'کالا برگشت خورد',
  REFUNDED: 'بازپرداخت‌شده',
  REJECTED: 'ردشده',
};

export function returnReportStateExportLabel(state: string): string {
  return RETURN_REPORT_STATE_LABELS[state as ReturnState] ?? state;
}

export type ReturnReportExportResult = CommerceReturnReportPage & {
  summary: CommerceReturnReportSummary;
};

export function toReturnLifecycleReportExportDocument(
  result: ReturnReportExportResult,
  query: CommerceReturnReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: RETURN_LIFECYCLE_REPORT_TITLE,
    fileNameBase: RETURN_LIFECYCLE_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.state !== undefined
        ? [{ label: 'وضعیت', value: returnReportStateExportLabel(query.state) }]
        : []),
      ...(query.search ? [{ label: 'جستجو', value: query.search }] : []),
      ...(query.purchaseDocumentId
        ? [{ label: 'شناسه سند خرید', value: query.purchaseDocumentId }]
        : []),
      ...(query.createdFrom
        ? [{ label: 'از (تاریخ درخواست)', value: reportDateTimeLabel(query.createdFrom) }]
        : []),
      ...(query.createdTo
        ? [{ label: 'تا (تاریخ درخواست)', value: reportDateTimeLabel(query.createdTo) }]
        : []),
    ],
    summary: [
      ...RETURN_STATES.map((state) => ({
        label: returnReportStateExportLabel(state),
        value: result.summary.byState[state] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'شماره سند خرید', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'دلیل', kind: 'text' },
      { header: 'جایگزینی', kind: 'text' },
      { header: 'تعداد اقلام', kind: 'number' },
      { header: 'تاریخ درخواست', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.purchaseDocumentNumber,
      returnReportStateExportLabel(row.state),
      row.reason,
      row.replacementRequired ? 'بله' : 'خیر',
      row.lineCount,
      reportDateTimeLabel(row.createdAt),
    ]),
  };
}
