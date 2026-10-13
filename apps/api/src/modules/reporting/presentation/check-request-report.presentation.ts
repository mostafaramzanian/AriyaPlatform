import {
  CHECK_ISSUE_TYPE_LABELS,
  CHECK_REQUEST_STATUSES,
  MANAGER_DECISION_LABELS,
  type CheckIssueType,
  type CheckRequestStatus,
  type ManagerDecision,
} from '../../financial/check-request/check-request-status';
import type {
  FinancialCheckRequestReportPage,
  FinancialCheckRequestReportQuery,
  FinancialCheckRequestReportSummary,
} from '../../financial/reporting/financial-check-request-reporting.contract';
import {
  reportDateLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the Financial report's EXPORT presentation —
 * «گزارش وضعیت و گردش درخواست‌های صدور چک» as a document.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------
 * It is the Financial half of the shared presentation model: the report's Persian title,
 * its applied-filter lines, its summary lines and its table — built from the EXACT
 * `list()` result the screen rendered for the same query. It is NOT a report definition:
 * there is no generic registry, no column DSL and no runtime declaration — this function
 * is the only thing that knows how this report becomes a document.
 *
 * COLUMNS MIRROR THE REGISTER TABLE. The five columns the screen shows, with the same
 * Persian labels and the same label functions the source vocabulary owns
 * (`CHECK_ISSUE_TYPE_LABELS`, `MANAGER_DECISION_LABELS`). Nothing the table does not
 * show is added here, so «the file and the table describe the same rows» stays checkable.
 *
 * STATUS WORDS ARE TYPE-SEALED. `Record<CheckRequestStatus, string>` is exhaustive over
 * the source's CLOSED ordinal set, so a ninth→tenth status added to `check-request-status`
 * fails this file's compile until a Persian word for it exists — and `report-export-labels
 * .spec.ts` pins the wording to the web's own `FINANCIAL_STATUS_LABELS`, so the export and
 * the screen can never disagree about what a status is called.
 */
export const CHECK_REQUEST_REPORT_TITLE = 'گزارش وضعیت و گردش درخواست‌های صدور چک';

/** The ASCII file-name base — report identity only, never a tenant or a row id. */
export const CHECK_REQUEST_REPORT_FILE_BASE = 'check-request-report';

/**
 * The lifecycle word for each stage ordinal — the SAME wording the web's
 * `financial-labels.ts` renders (`FINANCIAL_STATUS_LABELS`), restated here because a
 * server-generated document cannot import a browser module. The drift spec pins both.
 */
export const CHECK_REQUEST_REPORT_STATUS_LABELS: Record<CheckRequestStatus, string> = {
  0: 'پیش‌نویس',
  1: 'ارجاع شده / برای اصلاح',
  2: 'در انتظار تصمیم مدیر',
  3: 'صدور فرم تخصیص',
  4: 'بررسی اسناد',
  5: 'تأیید ریاست',
  6: 'صدور چک',
  7: 'تحویل چک',
  8: 'پایان گردش',
  50: 'خاتمه یافته',
};

/** Unknown ordinal → the raw number, never an invented word. */
export function checkRequestReportStatusExportLabel(status: number): string {
  return CHECK_REQUEST_REPORT_STATUS_LABELS[status as CheckRequestStatus] ?? String(status);
}

/** The service's `list()` answer — page + summary, one authoritative read pair. */
export type CheckRequestReportExportResult = FinancialCheckRequestReportPage & {
  summary: FinancialCheckRequestReportSummary;
};

/**
 * Builds the export document from the SAME result `list()` returned for `query`.
 *
 * `generatedAt` is a parameter (not a `new Date()` inside) so the document's timestamp is
 * the CALLER's honest render instant and the tests can freeze it.
 */
export function toCheckRequestReportExportDocument(
  result: CheckRequestReportExportResult,
  query: FinancialCheckRequestReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: CHECK_REQUEST_REPORT_TITLE,
    fileNameBase: CHECK_REQUEST_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status !== undefined
        ? [
            {
              label: 'وضعیت',
              value: checkRequestReportStatusExportLabel(query.status),
            },
          ]
        : []),
      ...(query.search ? [{ label: 'جستجو (عنوان)', value: query.search }] : []),
    ],
    summary: [
      ...CHECK_REQUEST_STATUSES.map((status) => ({
        label: checkRequestReportStatusExportLabel(status),
        value: result.summary.byStatus[String(status)] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'عنوان', kind: 'text' },
      { header: 'نوع چک', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'تصمیم مدیر', kind: 'text' },
      { header: 'تاریخ درخواست', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.title,
      CHECK_ISSUE_TYPE_LABELS[row.checkIssueType as CheckIssueType] ?? row.checkIssueType,
      checkRequestReportStatusExportLabel(row.status),
      row.managerDecision
        ? (MANAGER_DECISION_LABELS[row.managerDecision as ManagerDecision] ?? row.managerDecision)
        : '—',
      reportDateLabel(row.requestDate),
    ]),
  };
}
