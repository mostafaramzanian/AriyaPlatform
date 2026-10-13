import {
  LEAVE_REQUEST_STATUSES,
  type LeaveRequestStatus,
} from '../../hr/domain/leave-status';
import type {
  HrLeaveRequestReportPage,
  HrLeaveRequestReportQuery,
  HrLeaveRequestReportSummary,
} from '../../hr/reporting/hr-leave-reporting.contract';
import {
  reportDateLabel,
  reportDayLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the HR leave report's EXPORT presentation —
 * «گزارش وضعیت درخواست‌های مرخصی» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query —
 * same rows, same summary, same filters — through the shared `ReportExportDocument`
 * shape. COLUMNS MIRROR THE REGISTER TABLE: employee code, leave kind, requested
 * period, status, reason, recorded/withdrawn instants. No duration is computed (the
 * HR schema stores none — §13), no balance is derived, no KPI is stated.
 *
 * STATUS WORDS ARE TYPE-SEALED over the four-member lifecycle and pinned to the
 * web's leave wording by the drift spec.
 */
export const HR_LEAVE_REPORT_TITLE = 'گزارش وضعیت درخواست‌های مرخصی';

export const HR_LEAVE_REPORT_FILE_BASE = 'hr-leave-request-report';

/** The lifecycle word per member — the web's leave wording. */
export const HR_LEAVE_REPORT_STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  PENDING: 'ثبت‌شده',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
};

export function hrLeaveReportStatusExportLabel(status: string): string {
  return HR_LEAVE_REPORT_STATUS_LABELS[status as LeaveRequestStatus] ?? status;
}

export type HrLeaveReportExportResult = HrLeaveRequestReportPage & {
  summary: HrLeaveRequestReportSummary;
};

export function toHrLeaveReportExportDocument(
  result: HrLeaveReportExportResult,
  query: HrLeaveRequestReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: HR_LEAVE_REPORT_TITLE,
    fileNameBase: HR_LEAVE_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status !== undefined
        ? [{ label: 'وضعیت', value: hrLeaveReportStatusExportLabel(query.status) }]
        : []),
      ...(query.from ? [{ label: 'از (بازه درخواست)', value: reportDayLabel(query.from) }] : []),
      ...(query.to ? [{ label: 'تا (بازه درخواست)', value: reportDayLabel(query.to) }] : []),
    ],
    summary: [
      ...LEAVE_REQUEST_STATUSES.map((status) => ({
        label: hrLeaveReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'کد پرسنلی', kind: 'text' },
      { header: 'نوع مرخصی', kind: 'text' },
      { header: 'از تاریخ', kind: 'text' },
      { header: 'تا تاریخ', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'دلیل', kind: 'text' },
      { header: 'ثبت', kind: 'text' },
      { header: 'لغو', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.employeeCode,
      `${row.leaveTypeName} (${row.leaveTypeCode})`,
      reportDayLabel(row.startDate),
      reportDayLabel(row.endDate),
      hrLeaveReportStatusExportLabel(row.status),
      row.reason,
      reportDateLabel(row.createdAt),
      reportDateLabel(row.cancelledAt),
    ]),
  };
}
