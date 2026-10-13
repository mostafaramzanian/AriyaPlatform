import type { LeaveRequestStatus } from '../domain/leave-status';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the HR-owned READ CONTRACT for the sixth
 * Reporting capability — «گزارش وضعیت درخواست‌های مرخصی».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN HR (NOT IN REPORTING)
 * ----------------------------------------------------------------
 * This is the HR half of the seam the CHECK-REQUEST-REPORT phase established for
 * Financial, the PURCHASE-REPORT phase repeated for Commerce, the PRODUCTION-REPORT
 * phase repeated for Production and the HR-PERSONNEL-TRAFFIC phase repeated for HR
 * attendance — the same ownership reasoning a sixth time, because it does not depend
 * on which bounded context or which aggregate is read: Reporting must read HR truth
 * without BECOMING HR truth. HR OWNS this contract (its source rows, its leave
 * lifecycle vocabulary, its tenant predicate), and Reporting CONSUMES it through one
 * injected token. HR never imports Reporting; Reporting never imports an HR
 * repository, service, controller, Prisma client, generated client or DTO.
 *
 * WHAT THIS REPORT IS, AND WHAT ONE ROW MEANS
 * -------------------------------------------
 * One row is ONE `LeaveRequest` REGISTER ENTRY — one employee, one leave type, one
 * inclusive whole-day period (`startDate`/`endDate`), one lifecycle state and the
 * requester's stated reason. The register answers «what leave was recorded, for whom,
 * of which kind, over which days, and where does it stand». It does NOT answer leave
 * balance, attendance, overtime, working hours or productivity: `prisma/hr/schema.prisma`
 * stores no entitlement accumulation for leave, and §13 deliberately stores no computed
 * `durationDays` — which days of the range are WORKING days is a question for the
 * calendar and the shift. This contract therefore carries NO balance, NO duration and
 * NO rate, and the report built on it may not invent them either.
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over the `LeaveRequest` rows HR already
 * persists in `hr_db` plus their platform audit trail. Three reads plus a summary, no
 * writes, no approval commands, no correction surface, no catalogue management. The
 * source lifecycle vocabulary is the FULL implemented set — the four members of
 * `domain/leave-status.ts` (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`) —
 * imported by TYPE here and by VALUE in the reader, so the report can never count a
 * status the lifecycle does not have or miss one it does.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the HR repository wholesale: the write surface (submit, restate, withdraw, the
 * approval decisions) is unreachable through this token. NOT a second history table:
 * the timeline half delegates to the SAME platform audit trail HR's own register writes
 * (`hr.leave`, bound to the tenant-scoped row, read through `HrAuditGateway.read`).
 * NOT an HR analytics engine: the summary counts rows per status over the SAME filtered
 * population — no approval rate, no average duration, no balance, no SLA, no aging.
 */

/** The server-resolved tenant scope — the ONLY scope every read below carries. */
export interface HrLeaveRequestReportingScope {
  tenantId: string;
}

/** The token Reporting injects — the ONLY HR surface Reporting reaches for leave. */
export const HR_LEAVE_REQUEST_REPORTING_READER = 'HR_LEAVE_REQUEST_REPORTING_READER';

/**
 * The report query — ONLY the filters the leave register supports (`employeeId`,
 * `leaveTypeId`, `status`, the `from`/`to` intersection window), plus the
 * repository's own page window.
 */
export interface HrLeaveRequestReportQuery {
  employeeId?: string;
  leaveTypeId?: string;
  status?: LeaveRequestStatus;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * DATE SEMANTICS — INTERSECTION, stated because a leave report is where it breaks.
 * `from`/`to` are GREGORIAN `YYYY-MM-DD` days meaning INTERSECTION with the request's
 * own inclusive period (`endDate >= from`, `startDate <= to`) — exactly as
 * `LeaveService.resolveWindow` + `LeaveRepository.listRequestPage` state it. A
 * containment reading would hide a long request swallowing the window whole.
 * `createdAt` is the insert clock and `cancelledAt` the withdrawal instant; neither
 * is a filter — the register filters on the REQUESTED days.
 *
 * CORRECTION IS A NEW REQUEST, NOT A STATE. Restatability derives from terminality,
 * so no fifth «correction» status exists to count here.
 *
 * One report row — an EXPLICIT WHITELIST. OMITTED: `tenantId` (scope, never a field),
 * `employeeId`/`leaveTypeId` (internal uuids — the CODE + NAME labels cross instead),
 * `approvedAt`/`rejectedAt` (the FLOW's instants — the timeline answers «when decided»),
 * `updatedAt` (the sort key). `createdAt` IS carried (no submission column exists, and a
 * register with no «when recorded» cannot answer the report); `cancelledAt` IS carried
 * (the row's own «when withdrawn», present exactly when `CANCELLED`).
 */
export interface HrLeaveRequestReportRow {
  id: string;
  employeeCode: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: LeaveRequestStatus;
  createdAt: string;
  cancelledAt: string | null;
}

/** One page of report rows — the repository's own paging convention. */
export interface HrLeaveRequestReportPage {
  items: HrLeaveRequestReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — per-status COUNTS over the SAME filtered population. Every one
 * of the four lifecycle members is always present (zero-filled). No rate, no duration,
 * no balance, no percentage.
 */
export interface HrLeaveRequestReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist the sibling seams use. */
export interface HrLeaveRequestReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface HrLeaveRequestReportTimelinePage {
  items: HrLeaveRequestReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope FIRST.
 */
export interface HrLeaveRequestReportingReader {
  listReportRows(
    scope: HrLeaveRequestReportingScope,
    query: HrLeaveRequestReportQuery
  ): Promise<HrLeaveRequestReportPage>;
  getReportSummary(
    scope: HrLeaveRequestReportingScope,
    query: HrLeaveRequestReportQuery
  ): Promise<HrLeaveRequestReportSummary>;
  getReportRow(
    scope: HrLeaveRequestReportingScope,
    leaveRequestId: string
  ): Promise<HrLeaveRequestReportRow | null>;
  getReportTimeline(
    scope: HrLeaveRequestReportingScope,
    leaveRequestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrLeaveRequestReportTimelinePage>;
}
