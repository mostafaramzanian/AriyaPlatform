import { coreGet } from './core-http';
import {
  HR_MISSION_REQUEST_STATUSES,
  type HrMissionDurationMode,
  type HrMissionEngagementType,
  type HrMissionLocationType,
  type HrMissionRequestStatus,
} from './hr-mission-api';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the Reporting client for
 * «گزارش وضعیت درخواست‌های مأموریت» — five GETs mirroring
 * `hr-mission-report.controller.ts` exactly:
 *
 *   GET /reporting/hr/mission-requests                (page + summary)
 *   GET /reporting/hr/mission-requests/:id            (one report row)
 *   GET /reporting/hr/mission-requests/:id/timeline   (authoritative audit flow)
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *  * NO `tenantId` — the server resolves the tenant from the session; a client
 *    field could only be refused.
 *  * NO write method — the report is read-only by contract; there is nothing to
 *    POST/PATCH/DELETE, and a client with no verb cannot offer the button.
 *  * NO `search` — `ListMissionRequestsQueryDto` declares none, so a control here
 *    would claim a narrowing the server never performs.
 *  * NO duration / rate / KPI field — the HR schema stores none of them, and a
 *    client type claiming one would be lying about the wire.
 *
 * The row type is the contract's explicit whitelist, mirroring
 * `HrMissionRequestReportRow`; nothing richer crosses the wire, so the screen
 * physically cannot render a `tenantId`, an `employeeId` or a bookkeeping column.
 *
 * THE STATUS VOCABULARY IS NOT REDEFINED HERE: `HR_MISSION_REQUEST_STATUSES` and
 * `HrMissionRequestStatus` come from `hr-mission-api.ts`, the same closed SEVEN-member
 * set the HR mission register's own client uses — one vocabulary, one file, both
 * surfaces speaking it. The Persian words come from `missionRequestStatusLabel`
 * (`hr-mission-labels.ts`), which the export drift-spec pins.
 */

export { HR_MISSION_REQUEST_STATUSES };
export type { HrMissionRequestStatus, HrMissionDurationMode, HrMissionLocationType, HrMissionEngagementType };

/** One report row — the backend contract's explicit whitelist. */
export interface ReportingMissionRow {
  id: string;
  employeeCode: string;
  /** HOURLY | DAILY — the closed mission duration classification. */
  durationMode: HrMissionDurationMode;
  /** IN_CITY | OUT_OF_CITY — the mission's place classification. */
  locationType: HrMissionLocationType;
  /** PROJECT | NON_PROJECT — a classification, never a link to a project. */
  engagementType: HrMissionEngagementType;
  /** Gregorian civil day, `YYYY-MM-DD` — the first mission day, inclusive. */
  startDate: string;
  /** Gregorian civil day, `YYYY-MM-DD` — the last mission day, inclusive. */
  endDate: string;
  /** `HH:MM[:SS]` clock times — present for HOURLY missions, else null. */
  startTime: string | null;
  endTime: string | null;
  destination: string | null;
  description: string | null;
  /** The approver's stated correction reason, or null — never a fallback sentence. */
  correctionReason: string | null;
  /** The approver's stated rejection reason, or null — never a fallback sentence. */
  rejectionReason: string | null;
  submittedRevision: number | null;
  status: HrMissionRequestStatus;
  /** When the row was recorded — ISO instant. */
  createdAt: string;
}

/** Per-status counts over the SAME authorized filtered population as the list. */
export interface ReportingMissionSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReportingMissionPage {
  items: ReportingMissionRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: ReportingMissionSummary;
}

export interface ReportingMissionTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ReportingMissionTimelinePage {
  items: ReportingMissionTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The report list query — only the fields the DTO validates. */
export interface ReportingMissionQuery {
  page?: number;
  pageSize?: number;
  /** Inclusive Gregorian bounds on the MISSION period (intersection). */
  from?: string;
  to?: string;
  status?: HrMissionRequestStatus;
  durationMode?: 'HOURLY' | 'DAILY';
  /** The person the request is FOR — a raw id, as the source filter states it. */
  employeeId?: string;
}

/** The page size this report's screens use when the caller states none. */
export const HR_MISSION_REPORT_PAGE_SIZE = 20;

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

/** One filtered page of the register, WITH its summary strip. */
export function fetchHrMissionReport(query: ReportingMissionQuery): Promise<ReportingMissionPage> {
  return coreGet<ReportingMissionPage>(`/reporting/hr/mission-requests${queryString(query)}`);
}

/** One report row — 404 (a typed error) when the id is unknown or foreign. */
export function fetchHrMissionReportRow(id: string): Promise<ReportingMissionRow> {
  return coreGet<ReportingMissionRow>(`/reporting/hr/mission-requests/${encodeURIComponent(id)}`);
}

/** This row's report timeline — read-only, and only on demand. */
export function fetchHrMissionReportTimeline(
  id: string,
  query: { page?: number; pageSize?: number } = {}
): Promise<ReportingMissionTimelinePage> {
  return coreGet<ReportingMissionTimelinePage>(
    `/reporting/hr/mission-requests/${encodeURIComponent(id)}/timeline${queryString(query)}`
  );
}

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the download path for a report export — the SAME
 * query the screen lists with, rendered by the server as a file.
 */
export function hrMissionReportExportPath(
  query: ReportingMissionQuery,
  format: 'xlsx' | 'docx'
): string {
  return `/reporting/hr/mission-requests/export/${format}${queryString(query)}`;
}
