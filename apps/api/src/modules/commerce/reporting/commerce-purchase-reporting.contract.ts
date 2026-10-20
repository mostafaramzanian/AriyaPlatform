/**
 * `PurchaseDocumentStatus` — the lifecycle member a query or a row names, one of the six
 * members `purchase-status.ts` declares — is imported as a TYPE from that PURE module
 * (no NestJS, no Prisma, no repository, no clock), so the contract can state the closed set
 * without the port gaining a dependency on any implementation. The reader imports the same
 * module by VALUE to zero-fill the summary; one file owns the vocabulary either way.
 */
import type { PurchaseDocumentStatus } from '../purchase/purchase-status';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Commerce-owned READ CONTRACT for the second
 * Reporting capability — «گزارش وضعیت و چرخه عمر درخواست‌های خرید».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN COMMERCE (NOT IN REPORTING)
 * ---------------------------------------------------------------------
 * This is the Commerce half of the seam the CHECK-REQUEST-REPORT phase established for
 * Financial, repeated one-for-one because the ownership reasoning is identical and does
 * not depend on which bounded context is being read: Reporting must read Commerce truth
 * without BECOMING Commerce truth. Commerce OWNS this contract (its source tables, its
 * lifecycle vocabulary, its tenant predicate), and Reporting CONSUMES it through one
 * injected token. Commerce never imports Reporting; Reporting never imports a Commerce
 * repository, service, controller, Prisma client, generated client or DTO.
 *
 * WHAT THIS CONTRACT IS
 * ---------------------
 * A narrow, read-only, tenant-scoped port over the `PurchaseDocument` rows Commerce
 * already persists in `commerce_db` plus their platform audit trail. Three reads plus a
 * summary, no writes, no lifecycle commands, no workflow controls, no completion act.
 *
 * THE LIFECYCLE VOCABULARY IS THE FULL IMPLEMENTED SET — the six members of
 * `purchase-status.ts` (`DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `CANCELLED`,
 * `CLOSED`). That file is the single authority (§5.11) and is deliberately imported by
 * VALUE rather than re-declared, so the report can never count a status the lifecycle
 * does not have or miss one it does.
 *
 * WHAT THIS CONTRACT IS NOT
 * -------------------------
 * NOT the Commerce repository wholesale: the write surface (create/update/submit/close,
 * the commercial and workflow transitions) is unreachable through this token.
 * NOT a second history table: the timeline half delegates to the SAME platform audit
 * trail Commerce's own timeline route reads (`commerce.purchase_document`, bound to the
 * tenant-scoped row). NOT a KPI engine: the summary counts rows per status over the SAME
 * filtered population — no rates, no durations, no SLA, no growth, no derived money.
 *
 * THE ONE DELIBERATE DEVIATION FROM THE FINANCIAL PRECEDENT, AND WHY
 * -----------------------------------------------------------------
 * `createdAt` IS on this report's row whitelist, where the Financial row omitted its
 * source's `createdAt`/`updatedAt` as database bookkeeping. The reason is structural:
 * `CheckRequest` carries a DOMAIN column `requestDate` (the date the request states),
 * so Financial had a request date that was not the insert clock. `PurchaseDocument`
 * has no such column — §5.1 gives it `documentNumber`, `kind`, `status`, the money
 * totals and the completion facts, and nothing else. A purchase register with no date
 * at all could not answer "when was this requested", so the row's own creation instant
 * IS the request date here, and hiding it to match a precedent whose source had a
 * better field would make the report less truthful, not more. `updatedAt` stays
 * omitted: it is rewritten by every touch, it is only the server's sort key, and no
 * question this report answers needs it.
 */
export const COMMERCE_PURCHASE_REPORTING_READER = 'CommercePurchaseReportingReader' as const;

/**
 * Tenant identity, resolved server-side from the request context — never a client field.
 */
export interface CommerceReportingScope {
  tenantId: string;
}

/**
 * The report query. ONLY the filters the Commerce list contract already supports,
 * minus one: `status` (the closed lifecycle set) and `search` (the ONE text column a
 * caller can quote — `documentNumber`, since a purchase document carries no title).
 *
 * `requesterId` IS DELIBERATELY ABSENT even though `ListPurchaseDocumentsQueryDto`
 * accepts it. It is a raw actor id with no reporting display contract — the same
 * reason the Financial report kept `requesterUserId` out of both its query and its
 * row. A filter a screen cannot label honestly is not offered.
 *
 * Date/window filtering is deliberately ABSENT: the Commerce list contract has no
 * bounded date parameter, and inventing one here would be a new filter vocabulary
 * without a source behind it.
 */
export interface CommercePurchaseReportQuery {
  status?: PurchaseDocumentStatus;
  search?: string;
  page?: number;
  pageSize?: number;
  /**
   * Phase KPI-RUNTIME — the additive DATE-WINDOW pair the governance catalog requires
   * before a period-scoped value may be served (`docs/architecture/KPI-CATALOG.md`,
   * "Future KPI runtime contract").
   *
   * TWO fields rather than one because Commerce's two approved KPIs cohort on DIFFERENT
   * instants, and the catalog is explicit about it:
   *   * `completedAt` — KPI-003, whose cohort is the COMPLETION month ("the completion
   *     closes the measurement");
   *   * `createdAt` — KPI-004, whose cohort is the CREATION month ("what became of
   *     documents raised in the window").
   * A single generic window would have made one of the two definitions unexpressible, and
   * a seam that cannot state a governed definition is not the seam that definition names.
   *
   * Half-open ISO 8601 instants (UTC): `[from, to)`. Absent bound = unbounded on that side.
   * ADDITIVE AND OPTIONAL: every existing caller passes none and keeps today's behaviour.
   */
  createdFrom?: string;
  createdTo?: string;
  completedFrom?: string;
  completedTo?: string;
}

/**
 * One report row — an EXPLICIT WHITELIST of twelve fields the source model carries
 * and the report needs.
 *
 * Deliberately OMITTED, each for a stated reason:
 *  * `tenantId` — the scope, never a payload field.
 *  * `requesterId` and `completedByUserId` — raw actor ids with no reporting display
 *    contract, exactly as the Financial row omits its three actor columns. The
 *    requester's identity is Commerce's own detail surface's business (it resolves
 *    profiles through the identity gateway), and this port reaches no directory.
 *  * `updatedAt` — rewritten by every touch and only the server's sort key.
 *  * `completionPolicyVersionId`, `commercialConfigurationVersionId`,
 *    `lineRoutingVersionId` — internal pins the settings surfaces read, never
 *    document facts (the same three `PurchaseService.serialize` keeps off the wire).
 *  * every line's contents — the register answers "which documents, in what state",
 *    not "what is on them"; Commerce's own detail route owns the lines, and only
 *    `lineCount` (a count of rows that exist) crosses into this report.
 *  * every Prisma/storage shape, and the raw `Date` forms of the two instants below.
 *
 * `subtotalAmount`/`taxAmount`/`totalAmount` are `string | null`: an exact decimal
 * amount, or `null` meaning "not priced yet" — never `0`, which would claim free
 * items. (Shape note, recorded honestly: the driver trims the column's trailing
 * zeros on the way out — `1260`, not `1260.0000` — exactly as it does for
 * Commerce's own wire. The invariant is "exact amounts, never rounded or lost",
 * not a four-decimal shape the driver never promised.)
 */
export interface CommercePurchaseReportRow {
  id: string;
  documentNumber: string;
  kind: string;
  status: string;
  supplierId: string | null;
  currency: string | null;
  subtotalAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  lineCount: number;
  completedAt: string | null;
  createdAt: string;
}

/** One page of report rows — the repository's own paging convention. */
export interface CommercePurchaseReportPage {
  items: CommercePurchaseReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — explicit per-status COUNTS over the same authorized filtered
 * population the list answers. `total` is the filtered total; each `byStatus` entry
 * counts rows in exactly that lifecycle state, and every one of the six members is
 * always present (zero-filled) so a strip never has to invent a missing key.
 */
export interface CommercePurchaseReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist Commerce already uses. */
export interface CommercePurchaseReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface CommercePurchaseReportTimelinePage {
  items: CommercePurchaseReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * PHASE W2-C — the pending-aging row: one IN-CIRCULATION document and the age
 * of its CURRENT status.
 *
 * `statusEnteredAt` is the authoritative state-entry instant — the
 * `statusChangedAt` column the status statements write, falling back to
 * `createdAt` for rows that predate the column. It is NEVER `updatedAt`:
 * that column is rewritten by every edit and would make "how long has this
 * been waiting for approval" answer "when was anything last touched".
 *
 * `ageDays` and `agingBucket` are computed by the reader against ONE
 * `generatedAt` instant, so a page and its bucket strip describe the same
 * moment. The buckets are a fixed vocabulary, not per-tenant configuration —
 * inventing tenant-configurable brackets here would be a policy nobody asked
 * for.
 */
export type CommercePurchaseAgingBucket =
  | 'DAYS_0_7'
  | 'DAYS_8_30'
  | 'DAYS_31_90'
  | 'OVER_90';

export interface CommercePurchaseAgingRow {
  id: string;
  documentNumber: string;
  /** Always one of DRAFT / SUBMITTED / APPROVED — terminal rows are not pending. */
  status: string;
  statusEnteredAt: string;
  /** Whole days between `statusEnteredAt` and `generatedAt`. Never negative. */
  ageDays: number;
  agingBucket: CommercePurchaseAgingBucket;
  totalAmount: string | null;
  currency: string | null;
  createdAt: string;
}

/** The pending-aging answer: the page PLUS per-bucket counts over the WHOLE pending set. */
export interface CommercePurchaseAgingPage {
  items: CommercePurchaseAgingRow[];
  total: number;
  page: number;
  pageSize: number;
  byBucket: Record<CommercePurchaseAgingBucket, number>;
  /** The single instant every `ageDays`/`agingBucket` was computed against. */
  generatedAt: string;
}

/**
 * PHASE W2-C — the committed-cost row: one `costCenter` × `currency` bucket and
 * the three money facts that can be stated HONESTLY from Commerce's own tables.
 *
 * WHY `costCenter` AND NOT A PROJECT: `PurchaseDocument` owns no project column
 * and no Project entity exists in Ariya — Financial's `projectReference` is an
 * opaque string from the external project list (Preflight §18). Inventing a
 * project join here would fabricate a relationship the bounded context never
 * stored. `costCenter` is the document's own stated charge target («مرکز
 * هزینه»), the only authoritative grouping this schema holds; when a real
 * project link lands this report gains it, not before.
 *
 * THE THREE NUMBERS, each a distinct fact so nothing is double-counted:
 *   * `committedAmount` — Σ `totalAmount` over NON-CANCELLED documents. A
 *     cancelled request committed nothing.
 *   * `paidAmount` — the NET of the append-only payment ledger (compensations
 *     are negative rows, so Σ `amount` is already the honest paid figure).
 *   * `outstandingAmount` — `committed − paid` in exact `Decimal(18,4)`; can be
 *     negative when a cancellation followed real payments.
 *
 * Money stays a STRING in the storage domain — never a JavaScript number.
 */
export interface CommercePurchaseCostRow {
  costCenter: string;
  currency: string | null;
  documentCount: number;
  committedAmount: string;
  paidAmount: string;
  outstandingAmount: string;
}

/** The cost answer: the full set of buckets plus the instant it was computed at. */
export interface CommercePurchaseCostReport {
  items: CommercePurchaseCostRow[];
  generatedAt: string;
}

/**
 * The narrow read contract. Every method takes the server-resolved scope FIRST — there
 * is no shape of this port that reads another tenant's rows.
 */
export interface CommercePurchaseReportingReader {
  listReportRows(
    scope: CommerceReportingScope,
    query: CommercePurchaseReportQuery
  ): Promise<CommercePurchaseReportPage>;
  getReportSummary(
    scope: CommerceReportingScope,
    query: CommercePurchaseReportQuery
  ): Promise<CommercePurchaseReportSummary>;
  getReportRow(
    scope: CommerceReportingScope,
    documentId: string
  ): Promise<CommercePurchaseReportRow | null>;
  getReportTimeline(
    scope: CommerceReportingScope,
    documentId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<CommercePurchaseReportTimelinePage>;
  /**
   * PHASE W2-C — «گزارش تأخیر درخواست‌های خرید در جریان»: the tenant's
   * non-terminal documents aged by their CURRENT-status entry instant, oldest
   * first, with per-bucket counts over the whole pending population.
   */
  listPendingAging(
    scope: CommerceReportingScope,
    query: { page?: number; pageSize?: number }
  ): Promise<CommercePurchaseAgingPage>;
  /**
   * PHASE W2-C — «بهای تمام‌شده بر اساس مرکز هزینه»: committed vs paid vs
   * outstanding per cost center, from the document's own charge target and the
   * append-only payment ledger. Currency is part of the bucket key: amounts in
   * different currencies are never summed together.
   */
  listCostByCenter(scope: CommerceReportingScope): Promise<CommercePurchaseCostReport>;
}
