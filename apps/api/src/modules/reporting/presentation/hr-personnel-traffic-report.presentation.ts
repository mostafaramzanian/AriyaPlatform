import {
  HR_PERSONNEL_TRAFFIC_SOURCES,
  type HrPersonnelTrafficSource,
} from '../../hr/attendance/hr-attendance-source';
import type {
  HrPersonnelTrafficReportPage,
  HrPersonnelTrafficReportQuery,
  HrPersonnelTrafficReportSummary,
} from '../../hr/reporting/hr-personnel-traffic-reporting.contract';
import {
  reportDayLabel,
  reportPageScopeLines,
  reportTimeLabel,
  reportWeekdayLabel,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the HR report's EXPORT presentation —
 * «گزارش تردد پرسنل» as a document.
 *
 * Same discipline as the three siblings: built from the EXACT `list()` result the screen
 * rendered for the SAME day window / source / code search, through the shared
 * `ReportExportDocument` shape, by THIS function and no registry.
 *
 * DATE SEMANTICS, RESTATED BECAUSE AN EXPORT IS WHERE THEY ARE EASIEST TO BREAK:
 *  * `dateKey` is the register's OWN Jalali day — rendered in Persian digits, converted
 *    by nobody (the same reading `hrAttendanceDayLabel` performs);
 *  * `workDate` is a Gregorian DAY — its weekday is read in UTC, so the stored day can
 *    never move;
 *  * `clockIn`/`clockOut` are INSTANTS — rendered as Tehran wall-clock time, and a
 *    `null` `clockOut` is an open day: «—», never a zero hour.
 *
 * The summary counts rows per SOURCE over the same filtered population — no rate, no
 * duration, no attendance verdict: the HR schema stores none, so the document asserts
 * none. Source words are type-sealed over the closed two-member set and pinned to the
 * web's `hr-api.ts` wording by the drift spec.
 */
export const PERSONNEL_TRAFFIC_REPORT_TITLE = 'گزارش تردد پرسنل';

export const PERSONNEL_TRAFFIC_REPORT_FILE_BASE = 'personnel-traffic-report';

/** The source word per member — the web's `ATTENDANCE_SOURCE_LABELS` wording. */
export const PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS: Record<HrPersonnelTrafficSource, string> = {
  DEVICE: 'پانچ دستگاه',
  MANUAL: 'اصلاح دستی',
};

export function personnelTrafficReportSourceExportLabel(source: string): string {
  return PERSONNEL_TRAFFIC_REPORT_SOURCE_LABELS[source as HrPersonnelTrafficSource] ?? source;
}

export type HrPersonnelTrafficReportExportResult = HrPersonnelTrafficReportPage & {
  summary: HrPersonnelTrafficReportSummary;
};

export function toHrPersonnelTrafficReportExportDocument(
  result: HrPersonnelTrafficReportExportResult,
  query: HrPersonnelTrafficReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: PERSONNEL_TRAFFIC_REPORT_TITLE,
    fileNameBase: PERSONNEL_TRAFFIC_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.dateKey ? [{ label: 'روز (شمسی)', value: reportDayLabel(query.dateKey) }] : []),
      ...(query.from ? [{ label: 'از (میلادی)', value: query.from }] : []),
      ...(query.to ? [{ label: 'تا (میلادی)', value: query.to }] : []),
      ...(query.source !== undefined
        ? [{ label: 'منبع', value: personnelTrafficReportSourceExportLabel(query.source) }]
        : []),
      ...(query.search ? [{ label: 'جستجو (کد پرسنل)', value: query.search }] : []),
    ],
    summary: [
      ...HR_PERSONNEL_TRAFFIC_SOURCES.map((source) => ({
        label: personnelTrafficReportSourceExportLabel(source),
        value: result.summary.bySource[source] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'کد پرسنل', kind: 'text' },
      { header: 'تاریخ', kind: 'text' },
      { header: 'روز هفته', kind: 'text' },
      { header: 'ورود', kind: 'text' },
      { header: 'خروج', kind: 'text' },
      { header: 'منبع', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.employeeCode,
      reportDayLabel(row.dateKey),
      reportWeekdayLabel(row.workDate),
      reportTimeLabel(row.clockIn),
      reportTimeLabel(row.clockOut),
      personnelTrafficReportSourceExportLabel(row.source),
    ]),
  };
}
