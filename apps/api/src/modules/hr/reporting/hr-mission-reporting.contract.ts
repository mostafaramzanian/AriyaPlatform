import type { MissionRequestStatus } from '../domain/mission-status';
import type {
  MissionDurationMode,
  MissionEngagementType,
  MissionLocationType,
} from '../domain/mission-options';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the HR-owned READ CONTRACT for the seventh
 * Reporting capability — «گزارش وضعیت درخواست‌های مأموریت».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN HR (NOT IN REPORTING)
 * ---------------------------------------------------------------
 * The same ownership reasoning the Financial, Commerce, Production, HR-attendance and
 * HR-leave seams state — because it does not depend on which aggregate is read:
 * Reporting must read HR truth without BECOMING HR truth. HR OWNS this contract (its
 * source rows, its seven-member mission lifecycle vocabulary, its tenant predicate);
 * Reporting CONSUMES it through one injected token. HR never imports Reporting;
 * Reporting never imports an HR repository, service, controller, Prisma client,
 * generated client or DTO.
 *
 * WHAT THIS REPORT IS, AND WHAT ONE ROW MEANS
 * -------------------------------------------
 * One row is ONE `MissionRequest` — one employee, one classification
 * (`durationMode`/`locationType`/`engagementType`), one inclusive mission period with
 * optional clock times for HOURLY missions, one of the SEVEN lifecycle states and the
 * request's own decision reasons. It answers «what mission was recorded, for whom,
 * where, over which days, and where does it stand». It does NOT answer mission cost,
 * distance, working hours, KPI, balance or productivity: `prisma/hr/schema.prisma`
 * stores none of them. The post-approval `MissionReport` content is a DIFFERENT table
 * and is deliberately not part of this contract.
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over the `MissionRequest` rows HR persists
 * plus their platform audit trail. Three reads plus a summary, no writes, no submit,
 * no approve/reject/cancel commands, no catalogue/policy management. The source
 * lifecycle vocabulary is the FULL implemented set — the seven members of
 * `domain/mission-status.ts` — imported by TYPE here and by VALUE in the reader.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the HR repository wholesale. NOT a second history table: the timeline delegates
 * to the SAME platform audit trail HR's own register writes (`hr.mission`). NOT an HR
 * analytics engine: the summary counts rows per status over the SAME filtered
 * population — no approval rate, no duration, no SLA, no aging.
 *
 * THE THREE REQUEST VOCABULARIES ARE NEVER MIXED. `MissionRequestStatus` (7 members)
 * is this report's; `MissionApprovalStepStatus` (7 members) and
 * `MissionApprovalInstanceStatus` (5 members) belong to the FLOW and never cross this
 * seam as request states. There is no `COMPLETED` request state: a mission ends at
 * APPROVED, REJECTED or CANCELLED.
 */

/** The server-resolved tenant scope — the ONLY scope every read below carries. */
export interface HrMissionRequestReportingScope {
  tenantId: string;
}

/** The token Reporting injects — the ONLY HR surface Reporting reaches for missions. */
export const HR_MISSION_REQUEST_REPORTING_READER = 'HR_MISSION_REQUEST_REPORTING_READER';

/**
 * The report query — ONLY the filters the mission register supports
 * (`employeeId`, `status`, `durationMode`, the `from`/`to` intersection window) plus
 * pagination. There is no `search`, no `leaveTypeId` equivalent and no
 * location/engagement/destination filter in `ListMissionRequestsQueryDto`.
 */
export interface HrMissionRequestReportQuery {
  employeeId?: string;
  status?: MissionRequestStatus;
  durationMode?: MissionDurationMode;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * DATE SEMANTICS — INTERSECTION, exactly as `MissionRepository.listRequestPage`
 * states it: `from`/`to` are GREGORIAN `YYYY-MM-DD` days meaning INTERSECTION with the
 * mission's own inclusive period (`endDate >= from`, `startDate <= to`). `createdAt`
 * is the insert clock and the decision instants are flow facts; neither is a filter.
 * HOURLY missions store clock times, but the filter is still day-intersection —
 * `startTime`/`endTime` are display, never a query dimension.
 *
 * One report row — an EXPLICIT WHITELIST. OMITTED: `tenantId` (scope, never a field),
 * `employeeId` (internal uuid — the CODE crosses instead), option selections
 * (catalogue detail, not reporting dimensions), `updatedAt` (the sort key),
 * `approvedAt`/`rejectedAt`/`cancelledAt` (the row's decision INSTANTS — this report
 * carries the row's own decision REASONS and `createdAt`; «when decided» is answered
 * by the audit timeline).
 */
export interface HrMissionRequestReportRow {
  id: string;
  employeeCode: string;
  durationMode: MissionDurationMode;
  locationType: MissionLocationType;
  engagementType: MissionEngagementType;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  destination: string | null;
  description: string | null;
  correctionReason: string | null;
  rejectionReason: string | null;
  submittedRevision: number | null;
  status: MissionRequestStatus;
  createdAt: string;
}

/** One page of report rows — the repository's own paging convention. */
export interface HrMissionRequestReportPage {
  items: HrMissionRequestReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — per-status COUNTS over the SAME filtered population. Every one
 * of the seven lifecycle members is always present (zero-filled). No rate, no
 * duration, no percentage.
 */
export interface HrMissionRequestReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist the sibling seams use. */
export interface HrMissionRequestReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface HrMissionRequestReportTimelinePage {
  items: HrMissionRequestReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The narrow read contract. Every method takes the server-resolved scope FIRST. */
export interface HrMissionRequestReportingReader {
  listReportRows(
    scope: HrMissionRequestReportingScope,
    query: HrMissionRequestReportQuery
  ): Promise<HrMissionRequestReportPage>;
  getReportSummary(
    scope: HrMissionRequestReportingScope,
    query: HrMissionRequestReportQuery
  ): Promise<HrMissionRequestReportSummary>;
  getReportRow(
    scope: HrMissionRequestReportingScope,
    missionRequestId: string
  ): Promise<HrMissionRequestReportRow | null>;
  getReportTimeline(
    scope: HrMissionRequestReportingScope,
    missionRequestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrMissionRequestReportTimelinePage>;
}
