/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Financial-owned READ CONTRACT for the
 * first real Reporting capability — «گزارش وضعیت و گردش درخواست‌های صدور چک».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN FINANCIAL (NOT IN REPORTING)
 * -----------------------------------------------------------------------
 * Reporting must read Financial truth without BECOMING Financial truth. The
 * direction is therefore fixed by ownership: Financial OWNS this contract (its
 * source tables, its lifecycle ordinals, its tenant predicate), and Reporting
 * CONSUMES it through one injected token. Financial never imports Reporting;
 * Reporting never imports a Financial repository, service, controller, Prisma
 * client, or DTO.
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over the CheckRequest rows Financial
 * already persists in `finance_db` plus their platform audit trail. Three reads,
 * no writes, no lifecycle commands, no attachment operations, no workflow
 * controls. The lifecycle vocabulary is the FULL implemented set the source
 * contract proves — {0,1,2,3,4,5,6,7,8,50} — because the repository's
 * `check-request-status.ts` implements the completed CHECK-ISSUATION slice. The
 * phase prompt's 0/1/2/3/50 framing describes the F1-era slice; the code has
 * since grown the downstream stages, and a report that hid them would lie about
 * the register it claims to describe (see the phase record §B for the
 * deviation, recorded honestly rather than silently).
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the Financial repository wholesale: the repository's write surface
 * (create/update/transition/stage writes) is unreachable through this token.
 * NOT a second history table: the timeline half delegates to the SAME platform
 * audit trail the Financial timeline route reads (`financial.check-request`
 * bound to the tenant-scoped row). NOT a KPI engine: the summary half counts
 * rows per status over the SAME filtered population — no rates, no durations,
 * no SLA, no growth, no money.
 */
export const FINANCIAL_CHECK_REQUEST_REPORTING_READER =
  'FinancialCheckRequestReportingReader' as const;

/** Tenant identity, resolved server-side — never a client field. */
export interface FinancialReportingScope {
  tenantId: string;
}

/**
 * The report query. ONLY the filters the Financial read contract already
 * supports: `status` (the closed lifecycle set) and `search` (title match).
 * Date filtering is deliberately ABSENT: the Financial list contract has no
 * bounded date/window parameter, and inventing one here would be a new filter
 * vocabulary without a source contract behind it.
 */
export interface FinancialCheckRequestReportQuery {
  status?: number;
  search?: string;
  page?: number;
  pageSize?: number;
  /**
   * Phase KPI-RUNTIME — the additive DATE-WINDOW the governance catalog requires before a
   * period-scoped value may be served (`docs/architecture/KPI-CATALOG.md`, "Future KPI
   * runtime contract").
   *
   * A half-open instant window on `decidedAt` — ISO 8601 strings, UTC: `[decidedFrom,
   * decidedTo)` — the field KPI-005 cohorts on (`timeSemantics.cohortField = 'decidedAt'`,
   * "the decision closes the measurement"). Absent bound = unbounded on that side.
   *
   * ADDITIVE AND OPTIONAL: the four report surfaces pass neither, so the register, its
   * summary and its exports are byte-identical to before this extension.
   */
  decidedFrom?: string;
  decidedTo?: string;
}

/**
 * One report row — an EXPLICIT WHITELIST of twelve fields the source model
 * carries and the report needs. Deliberately OMITTED: `tenantId` (the scope,
 * never a payload field), `requesterUserId` / `decidedByUserId` /
 * `projectManagerUserId` (raw actor ids with no reporting display contract),
 * stage rows (allocation/review/executive/issue/delivery — downstream detail,
 * not register content), attachment internals, `createdAt`/`updatedAt`
 * (database bookkeeping, not report facts), and every Prisma/storage shape.
 */
export interface FinancialCheckRequestReportRow {
  id: string;
  title: string;
  checkIssueType: string;
  purchaseType: string | null;
  orderReference: string | null;
  projectReference: string | null;
  requestDate: string;
  requesterOpinion: string;
  status: number;
  managerDecision: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

/** One page of report rows — the repository's own paging convention. */
export interface FinancialCheckRequestReportPage {
  items: FinancialCheckRequestReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — explicit per-status COUNTS over the same authorized
 * filtered population the list answers. `total` is the filtered total; each
 * `byStatus` entry counts rows in exactly that lifecycle state.
 */
export interface FinancialCheckRequestReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist Financial uses. */
export interface FinancialCheckRequestReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface FinancialCheckRequestReportTimelinePage {
  items: FinancialCheckRequestReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope
 * FIRST — there is no shape of this port that reads another tenant's rows.
 */
export interface FinancialCheckRequestReportingReader {
  listReportRows(
    scope: FinancialReportingScope,
    query: FinancialCheckRequestReportQuery
  ): Promise<FinancialCheckRequestReportPage>;
  getReportSummary(
    scope: FinancialReportingScope,
    query: FinancialCheckRequestReportQuery
  ): Promise<FinancialCheckRequestReportSummary>;
  getReportRow(
    scope: FinancialReportingScope,
    requestId: string
  ): Promise<FinancialCheckRequestReportRow | null>;
  getReportTimeline(
    scope: FinancialReportingScope,
    requestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<FinancialCheckRequestReportTimelinePage>;
}
