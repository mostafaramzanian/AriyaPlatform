import { MISSION_REQUEST_STATUSES, type MissionRequestStatus } from '../../hr/domain/mission-status';
import type {
  HrMissionRequestReportPage,
  HrMissionRequestReportQuery,
  HrMissionRequestReportSummary,
} from '../../hr/reporting/hr-mission-reporting.contract';
import {
  reportDateLabel,
  reportDayLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the HR mission report's EXPORT presentation —
 * «گزارش وضعیت درخواست‌های مأموریت» as a document.
 *
 * Built from the EXACT `list()` result the screen rendered for the same query —
 * same rows, same summary, same filters — through the shared `ReportExportDocument`
 * shape. COLUMNS MIRROR THE REGISTER TABLE: employee code, classification, requested
 * period with clock times, status, destination, decision reasons. No duration is
 * computed (the HR schema stores none), no rate is derived, no KPI is stated.
 *
 * STATUS WORDS ARE TYPE-SEALED over the seven-member lifecycle and pinned to the
 * web's mission wording by the drift spec (`report-export-labels.spec.ts`).
 */
export const HR_MISSION_REPORT_TITLE = 'گزارش وضعیت درخواست‌های مأموریت';

export const HR_MISSION_REPORT_FILE_BASE = 'hr-mission-request-report';

/** The lifecycle word per member — the web's mission wording (`hr-mission-labels.ts`). */
export const HR_MISSION_REPORT_STATUS_LABELS: Record<MissionRequestStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارسال‌شده',
  IN_APPROVAL: 'در گردش تأیید',
  CORRECTION_REQUIRED: 'نیازمند اصلاح',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
};

export function hrMissionReportStatusExportLabel(status: string): string {
  return HR_MISSION_REPORT_STATUS_LABELS[status as MissionRequestStatus] ?? status;
}

/** The classification word per member — the web's mission wording. */
export const HR_MISSION_REPORT_DURATION_LABELS: Record<string, string> = {
  HOURLY: 'ساعتی',
  DAILY: 'روزانه',
};

export function hrMissionReportDurationExportLabel(mode: string): string {
  return HR_MISSION_REPORT_DURATION_LABELS[mode] ?? mode;
}

/** The classification words for location and engagement — web's mission wording. */
export const HR_MISSION_REPORT_LOCATION_LABELS: Record<string, string> = {
  IN_CITY: 'درون‌شهری',
  OUT_OF_CITY: 'بیرون‌شهری',
};

export const HR_MISSION_REPORT_ENGAGEMENT_LABELS: Record<string, string> = {
  PROJECT: 'پروژه‌ای',
  NON_PROJECT: 'غیرپروژه‌ای',
};

export type HrMissionReportExportResult = HrMissionRequestReportPage & {
  summary: HrMissionRequestReportSummary;
};

export function toHrMissionReportExportDocument(
  result: HrMissionReportExportResult,
  query: HrMissionRequestReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: HR_MISSION_REPORT_TITLE,
    fileNameBase: HR_MISSION_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status !== undefined
        ? [{ label: 'وضعیت', value: hrMissionReportStatusExportLabel(query.status) }]
        : []),
      ...(query.durationMode !== undefined
        ? [{ label: 'حالت مدت', value: hrMissionReportDurationExportLabel(query.durationMode) }]
        : []),
      ...(query.from ? [{ label: 'از (بازه مأموریت)', value: reportDayLabel(query.from) }] : []),
      ...(query.to ? [{ label: 'تا (بازه مأموریت)', value: reportDayLabel(query.to) }] : []),
    ],
    summary: [
      ...MISSION_REQUEST_STATUSES.map((status) => ({
        label: hrMissionReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'کد پرسنلی', kind: 'text' },
      { header: 'حالت مدت', kind: 'text' },
      { header: 'محل', kind: 'text' },
      { header: 'نوع همکاری', kind: 'text' },
      { header: 'از تاریخ', kind: 'text' },
      { header: 'تا تاریخ', kind: 'text' },
      { header: 'ساعت شروع', kind: 'text' },
      { header: 'ساعت پایان', kind: 'text' },
      { header: 'مقصد', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'دلیل اصلاح', kind: 'text' },
      { header: 'دلیل رد', kind: 'text' },
      { header: 'ثبت', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.employeeCode,
      hrMissionReportDurationExportLabel(row.durationMode),
      HR_MISSION_REPORT_LOCATION_LABELS[row.locationType] ?? row.locationType,
      HR_MISSION_REPORT_ENGAGEMENT_LABELS[row.engagementType] ?? row.engagementType,
      reportDayLabel(row.startDate),
      reportDayLabel(row.endDate),
      row.startTime ?? '—',
      row.endTime ?? '—',
      row.destination ?? '—',
      hrMissionReportStatusExportLabel(row.status),
      row.correctionReason ?? '—',
      row.rejectionReason ?? '—',
      reportDateLabel(row.createdAt),
    ]),
  };
}
