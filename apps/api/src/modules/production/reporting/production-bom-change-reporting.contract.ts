import type { BomStatus } from '../bom/bom-status';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Production-owned READ CONTRACT for
 * «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN PRODUCTION (NOT IN REPORTING)
 * -----------------------------------------------------------------------
 * The fourth instance of the seam the CHECK-REQUEST-REPORT, PURCHASE-REPORT and
 * PRODUCTION-REPORT phases established — the same ownership reasoning, which never
 * depended on which aggregate is read: Reporting must read Production truth without
 * BECOMING Production truth. Production OWNS this contract (its source rows, its
 * four-state lifecycle vocabulary, its tenant predicate, its audit resource) and
 * Reporting CONSUMES it through one injected token. Production never imports
 * Reporting; Reporting never imports a Production repository, service, controller,
 * Prisma client, generated client or DTO.
 *
 * WHY A SECOND PRODUCTION TOKEN RATHER THAN WIDENING THE FIRST
 * -----------------------------------------------------------
 * `production-reporting.contract.ts` is the BOM HEADER's report seam — one row is one
 * `BomHeader`, its query is the header's vocabulary, and KPI runtime injects that token
 * for the governed cohort reads. This contract is a DIFFERENT AGGREGATE: one row is one
 * `BomChangeRequest`, its filters are the change-request register's own proven set
 * (`bomId` / `projectRef` / `status` / `search`) and its timeline is bound to a
 * different audit resource (`production.bom.change`). Bolting the second aggregate's
 * reads onto the first token would make one interface answer two row shapes — the
 * "second opinion about what a row is" the header seam's own docs refuse. The existing
 * `ProductionReportingModule` therefore stays untouched, and this narrow module is
 * composed beside it exactly as each context composes one narrow module per report.
 * No isolation rule is weakened: Reporting still reaches Production only through
 * source-owned tokens, and this module still exports its token and nothing else.
 *
 * WHAT ONE ROW MEANS
 * ------------------
 * ONE BOM Change Request of the acting tenant — the document the Production register at
 * `/production/bom-change-requests` lists. The report answers «which changes have been
 * requested, what state is each in, and how did each move»; it does not answer what the
 * requested changes' coefficients are (the detail rows' snapshots are Production's own
 * detail surface) and it does not answer anything Production has no column for.
 *
 * LIFECYCLE VOCABULARY — THE FULL CLOSED SET, NOT A REPORTING DIALECT
 * -------------------------------------------------------------------
 * The four members `bom-status.ts` owns (`DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`),
 * imported by TYPE here and by VALUE in the reader. Correction is the TRANSITION back to
 * `DRAFT` (`REQUEST_CORRECTION` lands on the editable state) — never a fifth status, and
 * this contract has no field that could carry one. The report therefore cannot count a
 * status the lifecycle does not have, nor miss one it does.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the change-request repository wholesale: create, patch, the detail-row writes,
 * submit and the three decision acts are unreachable through this token. NOT a second
 * history: the timeline delegates to the SAME platform audit trail Production's own
 * change-request timeline reads (`production.bom.change`, bound to the tenant-scoped
 * row). NOT a KPI engine: the summary counts rows per status over the SAME filtered
 * population — no approval rate, no cycle time, no aging, no derived figure of any kind.
 * NOT a detail-row reader: coefficient snapshots and deltas never cross this seam, so
 * the "expose the minimal projection" rule is structural rather than a review habit.
 */
export const PRODUCTION_BOM_CHANGE_REPORTING_READER = 'ProductionBomChangeReportingReader' as const;

/**
 * WHAT CROSSES THE SEAM — the explicit projection whitelist, stated once and asserted
 * against a raw row in the reader spec:
 *
 *   id · bomId · title · projectRef · productTreeRef · status · managerOpinion ·
 *   itemCount · submittedAt · decidedAt · createdAt
 *
 * Deliberately withheld: `tenantId` (the scope, never a projection), the three actor ids
 * (`requesterUserId` / `approverUserId` / `decidedByUserId` — no display contract exists
 * for an opaque uuid), `notes` (free-text internal remarks), `requestDate` (creation and
 * lifecycle instants answer "when" without a second date), `updatedAt` (bookkeeping), and
 * every Prisma relation, raw `Date` form and write-only column.
 */

/** Tenant identity, resolved server-side — never a client field. */
export interface ProductionBomChangeReportingScope {
  tenantId: string;
}

/**
 * The report query. ONLY the filters the change-request source already proves:
 * the register's own four (`bomId`, `projectRef`, `status`, `search`) plus the page
 * window. No date vocabulary, no actor ids, no tenant — a filter this contract does not
 * name cannot reach the repository through this port.
 */
export interface ProductionBomChangeReportQuery {
  bomId?: string;
  projectRef?: string;
  status?: BomStatus;
  search?: string;
  page?: number;
  pageSize?: number;
}

/** One report row — the eleven-field whitelist stated above. */
export interface ProductionBomChangeReportRow {
  id: string;
  bomId: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  status: string;
  managerOpinion: string | null;
  itemCount: number;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** One page of report rows — the repository's own paging convention. */
export interface ProductionBomChangeReportPage {
  items: ProductionBomChangeReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — per-status COUNTS over the same authorized filtered population the
 * list answers. `total` is the filtered total; every one of the four lifecycle members is
 * always present (zero-filled by the reader over `BOM_STATUSES`) so a strip never has to
 * invent a missing key.
 */
export interface ProductionBomChangeReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist Production's own route uses. */
export interface ProductionBomChangeReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ProductionBomChangeReportTimelinePage {
  items: ProductionBomChangeReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope FIRST — there
 * is no shape of this port that reads another tenant's requests.
 */
export interface ProductionBomChangeReportingReader {
  listReportRows(
    scope: ProductionBomChangeReportingScope,
    query: ProductionBomChangeReportQuery
  ): Promise<ProductionBomChangeReportPage>;
  getReportSummary(
    scope: ProductionBomChangeReportingScope,
    query: ProductionBomChangeReportQuery
  ): Promise<ProductionBomChangeReportSummary>;
  getReportRow(
    scope: ProductionBomChangeReportingScope,
    id: string
  ): Promise<ProductionBomChangeReportRow | null>;
  getReportTimeline(
    scope: ProductionBomChangeReportingScope,
    id: string,
    query: { page?: number; pageSize?: number }
  ): Promise<ProductionBomChangeReportTimelinePage>;
}
