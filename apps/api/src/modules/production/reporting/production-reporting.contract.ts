/**
 * `BomStatus` — the lifecycle member a query or a row names, one of the four members
 * `bom-status.ts` declares — is imported as a TYPE from that PURE module (no NestJS, no
 * Prisma, no repository, no clock), so the contract can state the closed set without the
 * port gaining a dependency on any implementation. The reader imports the same module by
 * VALUE to zero-fill the summary; one file owns the vocabulary either way.
 */
import type { BomStatus } from '../bom/bom-status';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Production-owned READ CONTRACT for the third
 * Reporting capability — «گزارش خلاصه و وضعیت عملیات تولید».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN PRODUCTION (NOT IN REPORTING)
 * -----------------------------------------------------------------------
 * This is the Production half of the seam the CHECK-REQUEST-REPORT phase established for
 * Financial and the PURCHASE-REPORT phase repeated for Commerce — the same ownership
 * reasoning a third time, because it does not depend on which bounded context is read:
 * Reporting must read Production truth without BECOMING Production truth. Production
 * OWNS this contract (its source rows, its lifecycle vocabulary, its tenant predicate),
 * and Reporting CONSUMES it through one injected token. Production never imports
 * Reporting; Reporting never imports a Production repository, service, controller, Prisma
 * client, generated client or DTO.
 *
 * WHAT THIS REPORT IS, AND WHAT ONE ROW MEANS
 * -------------------------------------------
 * One row is ONE BOM HEADER of the acting tenant — the Production aggregate root that
 * carries the document lifecycle (`BomStatus`) and the operational dates this register
 * answers with. The register answers «which BOMs, in what state, with how many items»;
 * it does not answer what is ON them (items are Production's own detail surface) and it
 * does not answer anything Production has no column for (no quantities, no completion
 * percentage, no cost, no efficiency — none of which this schema models).
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over `BomHeader` rows in `production_db` plus
 * their platform audit trail. Three reads plus a summary, no writes, no lifecycle
 * commands, no submission or decision surface. The lifecycle vocabulary is the FULL
 * implemented set — the four members of `bom-status.ts` — imported by TYPE here and by
 * VALUE in the reader, so the report can never count a status the lifecycle does not
 * have or miss one it does.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the Production repository wholesale: the write surface (create, update, submit,
 * the three decision acts) is unreachable through this token. NOT a second history
 * table: the timeline half delegates to the SAME platform audit trail Production's own
 * BOM timeline route reads (`production.bom`, bound to the tenant-scoped row). NOT a KPI
 * engine: the summary counts rows per status over the SAME filtered population — no
 * rates, no durations, no yield, no downtime, no cost, no derived figures of any kind.
 *
 * DATE SEMANTICS, STATED BECAUSE A REGISTER WITHOUT DATES CANNOT ANSWER «WHEN»
 * --------------------------------------------------------------------------
 * The row carries the three INSTANTS the schema actually stores and the domain actually
 * writes: `createdAt` (the header was authored), `submittedAt` (stamped by `submit` —
 * the instant routing began) and `decidedAt` (stamped by `decide` — the instant the
 * approver answered). No other date exists on this aggregate, and none is invented for
 * Reporting. `updatedAt` is deliberately ABSENT: it is the server's sort key, rewritten
 * by every touch, and not a fact this register states. NO date/window FILTER is offered —
 * the Production list contract has none (`status` + `search` only), exactly the absence
 * the Financial and Commerce contracts record, and inventing one here would be a filter
 * vocabulary without a source behind it.
 *
 * DELIBERATELY OMITTED FROM THE ROW (and why):
 *  * `tenantId` — the scope, never a payload field.
 *  * `requesterUserId` / `approverUserId` / `decidedByUserId` — raw platform actor ids
 *    with no display contract on this surface; without a directory read a screen could
 *    only render an opaque uuid (the Financial row omits its actor ids for the same
 *    reason; the Commerce row omits `requesterId` for the same reason).
 *  * `comments` — free-text document detail, owned by Production's own detail route;
 *    a register states facts it can label, not prose it would strip of context.
 *  * `updatedAt` — database bookkeeping and the sort key, never a report fact.
 *  * the items themselves — `itemCount` (a count of rows that exist) crosses instead,
 *    because "how big is this BOM / does it have items to submit" is operational status,
 *    while the item lines are Production's own aggregate detail.
 *  * every Prisma/storage shape, and the raw `Date` forms of the instants above.
 */
export const PRODUCTION_REPORTING_READER = 'ProductionReportingReader' as const;

/** Tenant identity, resolved server-side — never a client field. */

/**
 * One report row — an EXPLICIT WHITELIST of the ten fields the source model carries and
 * this report needs. See the header note for the full omission list; the projection from
 * the stored row happens in the reader, and a spread-through would publish the next
 * column the schema gains without this file ever deciding it is safe for this surface.
 *
 * `itemCount` is Prisma's bounded `_count` over the header's own `items` relation, read
 * WITH the row — a count of rows that exist, never a figure computed from them.
 */
export interface ProductionReportRow {
  id: string;
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
export interface ProductionReportPage {
  items: ProductionReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — explicit per-status COUNTS over the same authorized filtered
 * population the list answers. `total` is the filtered total; each `byStatus` entry
 * counts rows in exactly that lifecycle state, and every one of the four members is
 * always present (zero-filled) so a strip never has to invent a missing key.
 */
export interface ProductionReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist Production's own route uses. */
export interface ProductionReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface ProductionReportTimelinePage {
  items: ProductionReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope FIRST — there
 * is no shape of this port that reads another tenant's rows.
 */
export interface ProductionReportingReader {
  listReportRows(
    scope: ProductionReportingScope,
    query: ProductionReportQuery
  ): Promise<ProductionReportPage>;
  getReportSummary(
    scope: ProductionReportingScope,
    query: ProductionReportQuery
  ): Promise<ProductionReportSummary>;
  getReportRow(scope: ProductionReportingScope, bomId: string): Promise<ProductionReportRow | null>;
  getReportTimeline(
    scope: ProductionReportingScope,
    bomId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<ProductionReportTimelinePage>;
}

export interface ProductionReportingScope {
  tenantId: string;
}

/**
 * The report query. ONLY the filters the Production read contract already supports:
 * `status` (the closed four-member lifecycle) and `search` (title match — the header's
 * one free-text column), plus the repository's own page window.
 */
export interface ProductionReportQuery {
  status?: BomStatus;
  search?: string;
  page?: number;
  pageSize?: number;
  /**
   * Phase KPI-RUNTIME — the additive DATE-WINDOW the governance catalog requires before a
   * period-scoped value may be served (`docs/architecture/KPI-CATALOG.md`, "Future KPI
   * runtime contract": the seams expose `status`/`search` only until this extension lands).
   *
   * A half-open instant window on `decidedAt` — ISO 8601 strings, UTC: `[decidedFrom,
   * decidedTo)`. It filters; it never reorders, converts or rounds, and it names the ONE
   * field KPI-001 and KPI-002 cohort on (`timeSemantics.cohortField = 'decidedAt'`). An
   * absent bound is unbounded on that side, exactly like an absent `status`.
   *
   * ADDITIVE AND OPTIONAL: every existing caller (the Production register, the four report
   * surfaces) passes neither and gets byte-identical behaviour.
   */
  decidedFrom?: string;
  decidedTo?: string;
}
