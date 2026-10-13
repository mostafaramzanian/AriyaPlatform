import type { HrPersonnelTrafficSource } from '../attendance/hr-attendance-source';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the HR-owned READ CONTRACT for the fourth
 * Reporting capability — «گزارش تردد پرسنل».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN HR (NOT IN REPORTING)
 * ----------------------------------------------------------------
 * This is the HR half of the seam the CHECK-REQUEST-REPORT phase established for
 * Financial, the PURCHASE-REPORT phase repeated for Commerce and the PRODUCTION-REPORT
 * phase repeated for Production — the same ownership reasoning a fourth time, because it
 * does not depend on which bounded context is read: Reporting must read HR truth without
 * BECOMING HR truth. HR OWNS this contract (its source rows, its day vocabulary, its
 * tenant predicate), and Reporting CONSUMES it through one injected token. HR never
 * imports Reporting; Reporting never imports an HR repository, service, controller,
 * Prisma client, generated client or DTO.
 *
 * WHAT THIS REPORT IS, AND WHAT ONE ROW MEANS
 * -------------------------------------------
 * One row is ONE `Attendance` REGISTER ENTRY — one employee, one work day, one source
 * (`Attendance_tenantId_employeeId_workDate_source_key` IS the row's identity). The
 * register answers «who punched in on which day, from when to when, and was that row
 * recorded by a device or as a manual correction». It does NOT answer present/absent/
 * late: `prisma/hr/schema.prisma` and `AttendanceService` deliberately store no `status`,
 * no `lateMinutes`, no `overtimeMinutes` and no worked-minutes figure — those would be
 * computed verdicts that can disagree with the punches they came from (§13). This
 * contract therefore carries NO attendance state, NO duration and NO percentage, and the
 * report built on it may not invent them either.
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over `Attendance` rows in `hr_db` plus their
 * platform audit trail. Three reads plus a summary, no writes, no punches, no
 * corrections, no clock-in/clock-out surface. The source vocabulary is the FULL
 * implemented set — the two members of `hr-attendance-source.ts` (`DEVICE`, `MANUAL`) —
 * imported by TYPE here and by VALUE in the reader, so the report can never count a
 * source the register does not have or miss one it does.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the HR repository wholesale: the write surface (clock-in, clock-out, adjustment)
 * is unreachable through this token. NOT a second history table: the timeline half
 * delegates to the SAME platform audit trail HR's own register writes (`hr.attendance`,
 * bound to the tenant-scoped row, read through `HrAuditGateway.read`). NOT an HR
 * analytics engine: the summary counts rows per source over the SAME filtered
 * population — no attendance rate, no punctuality, no overtime, no productivity, no
 * derived figure of any kind.
 *
 * DATE SEMANTICS, STATED BECAUSE A REGISTER WITHOUT DATES CANNOT ANSWER «WHEN»
 * ---------------------------------------------------------------------------
 * The row carries the three calendar facts the schema actually stores:
 *  * `workDate` — the GREGORIAN civil day the punches belong to (`@db.Date`, derived
 *    server-side from `clockIn`, never supplied by a client), rendered as `YYYY-MM-DD`;
 *  * `dateKey` — the same day as the server derived it in the Jalali calendar
 *    (`YYYY/MM/DD`), the register's own Persian key;
 *  * `clockIn`/`clockOut` — the two ISO INSTANTS of the punch window; `clockOut` is
 *    `null` while the day is open, which is a fact about the day, not a missing value.
 * The report's own window filter accepts the spellings the register accepts — Gregorian
 * `from`/`to` or one Jalali `dateKey` — and resolves them through the SAME
 * `attendance-window.ts` implementation the register's list uses, so the report and the
 * register can never disagree about which days a query names.
 *
 * WHAT DELIBERATELY DOES NOT CROSS THIS SEAM
 * ------------------------------------------
 *  * `tenantId` — the scope is a method parameter, never a row field.
 *  * `updatedAt` — rewritten by every touch and only the server's bookkeeping.
 *  * `employeeId` — the raw personnel uuid has no display contract and this report
 *    never navigates into an HR screen; the human-facing `employeeCode` is the row's
 *    person identity (the same reason the sibling contracts withhold actor ids).
 *  * the employee relation wholesale — only `employeeCode` crosses, selected by the
 *    repository's own bounded label projection.
 *  * every Prisma/storage shape, and the raw `Date` forms of the fields above.
 */
export const HR_PERSONNEL_TRAFFIC_REPORTING_READER = 'HrPersonnelTrafficReportingReader' as const;

/** Tenant identity, resolved server-side — never a client field. */
export interface HrPersonnelTrafficReportingScope {
  tenantId: string;
}

/**
 * The report query. ONLY the filters the attendance register itself supports:
 * the day window (`from`/`to` as Gregorian `YYYY-MM-DD`, `dateKey` as one Jalali
 * `YYYY/MM/DD` day — mutually exclusive, exactly as the register refuses the
 * combination), `source` (the closed two-member vocabulary) and `search` (match
 * against the employee's CODE — the register's own free-text question), plus the
 * repository's own page window.
 */
export interface HrPersonnelTrafficReportQuery {
  from?: string;
  to?: string;
  dateKey?: string;
  source?: HrPersonnelTrafficSource;
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * One report row — an EXPLICIT WHITELIST of the eight fields the source model carries
 * and this report needs. See the header note for the full omission list; the projection
 * from the stored row happens in the reader, and a spread-through would publish the next
 * column the schema gains without this file ever deciding it is safe for this surface.
 */
export interface HrPersonnelTrafficReportRow {
  id: string;
  employeeCode: string;
  /** Gregorian civil day, `YYYY-MM-DD` — never an instant. */
  workDate: string;
  /** The SAME day in the Jalali calendar, `YYYY/MM/DD` — the server's own derivation. */
  dateKey: string;
  /** The punch that opened the day — ISO instant, offset preserved. */
  clockIn: string;
  /** The punch that closed it, or `null` while the day is open. */
  clockOut: string | null;
  /** Where the row came from: `DEVICE` (the evidence) or `MANUAL` (the correction). */
  source: HrPersonnelTrafficSource;
  /** A correction's stated reason — required on every `MANUAL` row, `null` on `DEVICE`. */
  reason: string | null;
}

/** One page of report rows — the repository's own paging convention. */
export interface HrPersonnelTrafficReportPage {
  items: HrPersonnelTrafficReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — explicit per-source COUNTS over the same authorized filtered
 * population the list answers. `total` is the filtered total; each `bySource` entry
 * counts rows recorded by exactly that source, and both members of the closed vocabulary
 * are always present (zero-filled) so a strip never has to invent a missing key.
 * Nothing else: no rate, no duration total, no attendance percentage.
 */
export interface HrPersonnelTrafficReportSummary {
  total: number;
  bySource: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist the sibling seams use. */
export interface HrPersonnelTrafficReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface HrPersonnelTrafficReportTimelinePage {
  items: HrPersonnelTrafficReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope FIRST — there
 * is no shape of this port that reads another tenant's rows.
 */
export interface HrPersonnelTrafficReportingReader {
  listReportRows(
    scope: HrPersonnelTrafficReportingScope,
    query: HrPersonnelTrafficReportQuery
  ): Promise<HrPersonnelTrafficReportPage>;
  getReportSummary(
    scope: HrPersonnelTrafficReportingScope,
    query: HrPersonnelTrafficReportQuery
  ): Promise<HrPersonnelTrafficReportSummary>;
  getReportRow(
    scope: HrPersonnelTrafficReportingScope,
    attendanceId: string
  ): Promise<HrPersonnelTrafficReportRow | null>;
  getReportTimeline(
    scope: HrPersonnelTrafficReportingScope,
    attendanceId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<HrPersonnelTrafficReportTimelinePage>;
}
