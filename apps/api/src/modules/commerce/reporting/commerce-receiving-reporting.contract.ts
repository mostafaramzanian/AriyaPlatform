/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Commerce-owned READ CONTRACT for
 * the tenth Reporting capability — «گزارش وضعیت دریافت‌های بازرگانی».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN COMMERCE (NOT IN REPORTING)
 * ---------------------------------------------------------------------
 * Reporting must read Commerce truth without BECOMING Commerce truth. Commerce OWNS this
 * contract (the APPEND-ONLY `Receipt` / `ReceiptLine` rows in `commerce_db`, the line's
 * OWN stored `quantity` beside the purchase line it names, the tenant predicate), and
 * Reporting CONSUMES it through one injected token. Commerce never imports Reporting;
 * Reporting never imports a Commerce repository, service, controller, Prisma client,
 * generated client or DTO.
 *
 * WHAT ONE ROW MEANS (the SCOPE GATE's row-grain ruling — OPTION A)
 * ----------------------------------------------------------------
 * One row is ONE `PurchaseLine` — the receiving LINE-REGISTER row the scope gate
 * approved (recorded in `docs/reports/PHASE-REPORTING-COMMERCE-RECEIVING-STATUS-REPORT.md` §B):
 * it answers «which purchase line of which document, in what projected receiving
 * state, ordered how much, received how much, and when was the latest receiving
 * event for it».
 *
 * The grain is per-PURCHASE-LINE, not per-`ReceiptLine`: the domain's projection
 * (`receiving/receiving-status.ts`) is stated over the line's OWN stored quantity and
 * Σ over the WHOLE history of that line — never a filtered view — and the register
 * reports the same fact the Commerce screen itself renders (`CommerceReceivingLineProjection`
 * beside `receiptView`, every line present including one with no events at all).
 * A report that grouped the many receipt events into one purchase-document row would
 * invent the document-level status the schema deliberately carries nowhere (R5: no
 * status column on `Receipt`, `ReceiptLine`, `PurchaseLine` or `PurchaseDocument` —
 * asserted by `receiving-status.spec.ts`), and a report that rendered the raw receipt
 * EVENTS as rows would answer «which operations» rather than the stable per-line
 * question this register owns. No summing, no collapsing: the per-line quantities
 * the source states are the per-line quantities this row carries.
 *
 * The summary counts per receiving status are COUNTED AT THE REPOSITORY from the
 * per-line projection inputs (ordered quantity + Σ receipt lines) — the SAME
 * predicate the list answers — because the status is a read-time projection over
 * the whole history, never a stored column to `groupBy`. The reader difference from
 * the return register is mechanical: where the return reader counts five buckets
 * with five transition-existence predicates, this reader counts three buckets with
 * three money-comparison predicates — one decision, one file, no second rule engine
 * (the projection still lives ONLY in `receiving-status.ts`).
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY — each a SCOPE GATE exclusion, not an oversight:
 *  * NO timeline method: the receiving audit trail is bound to the RECEIPT EVENT
 *    (`receiving-history.service.ts` stamps `resourceId: receipt.id` for BOTH `append`
 *    and `compensate`), so an audit read keyed to a purchase line cannot answer «this
 *    row's history» without returning its siblings' receipt events too — a timeline
 *    here would lie by grain, so none is offered (the payment register's exact ruling).
 *  * NO document-level status: there is none in the schema (R5), and this register
 *    never invents one — the three-state vocabulary lives on the LINE, never above it.
 *  * NO warehouse/location/supplier columns: the schema stores no warehouse at all,
 *    and `supplierId` is opaque with no display contract (the payment register's
 *    supplier reasoning, for the same reason).
 *  * NO unit/price/money aggregation beyond the row's own two quantities: `unit` is a
 *    free-text label with no catalogue, money sums are KPI territory, and the rate
 *    family (fulfillment rate, SLA, aging, quality) is a separate product decision.
 *  * NO Financial fact: `finance_db` is a different bounded context; the opaque
 *    references on the parent document are where a FUTURE source-owned contract
 *    would look.
 *
 * DATE SEMANTICS — `receivedAt` is the primary reporting date (the caller's stated
 * instant, defaulting to now — the schema's `received_at`, NOT NULL). For a line with
 * NO events there is no receiving instant, so `receivedFrom/receivedTo` are a
 * HALF-OPEN `[from, to)` window on the LATEST receiving instant of the line — `gte`
 * on the lower bound, `lt` on the upper — the exact shape the sibling registers
 * state (`payment-history.repository.ts`). A line with no events bears a NULL latest
 * instant and is EXCLUDED by any stated date bound (it matches no instant); it is
 * INCLUDED when no date bound is stated. `receivedAt` is the business date;
 * `createdAt` is bookkeeping and never a filter.
 */
import type { ReceivingStatus } from '../receiving/receiving-status';

/** The server-resolved tenant scope — the ONLY scope every read below carries. */
export interface CommerceReceivingReportingScope {
  tenantId: string;
}

/** The token Reporting injects — the ONLY receiving surface Reporting reaches. */
export const COMMERCE_RECEIVING_REPORTING_READER = 'CommerceReceivingReportingReader' as const;

/**
 * The report query — ONLY the proven filters plus the page window. ABSENT KEYS STAY
 * ABSENT in the repository's where (never defaulted), so a caller that names no filter
 * reads the whole tenant population.
 *
 * WHAT IS DELIBERATELY ABSENT: NO `supplierId` (opaque, no display contract), NO
 * `warehouseId` (no warehouse in the schema), NO `unit` (free-text label, no closed
 * set), NO quantity range (no source-backed range vocabulary), NO `receiverId`
 * filter (a raw actor id with no display contract). `search` is deliberately NARROW:
 * it matches ONLY the parent `documentNumber` — receipt lines carry no searchable
 * text of their own (no item description on the receipt side, no notes column), so
 * «which document» is the one text question this register answers, through the same
 * same-owner relation the payment and return registers search with.
 */
export interface CommerceReceivingReportQuery {
  status?: ReceivingStatus;
  purchaseDocumentId?: string;
  purchaseLineId?: string;
  search?: string;
  receivedFrom?: string;
  receivedTo?: string;
  page?: number;
  pageSize?: number;
}

/**
 * One report row — an EXPLICIT WHITELIST of eight fields. OMITTED: `tenantId` (the
 * scope, never a payload field), `receiverId` (raw actor id with no display
 * contract — the payment register's `recordedByUserId` omission, for the same
 * reason), `createdAt` (insert clock; `receivedAt` is the business date), every
 * Prisma/storage shape, and any document-level status (a fiction the schema
 * refuses to state — R5).
 *
 * `id` IS the purchase line's id — the row's identity is the line itself (one row =
 * one `PurchaseLine`, §B's ruling), so the detail route reads `GET …/:id` with the
 * line id, exactly as the sibling registers key their rows to their own aggregate.
 * `orderedQuantity` is the line's OWN stored `Decimal(18,4)` STRING.
 * `receivedQuantity` is Σ over the line's WHOLE receipt history — NEGATIVE on a
 * line fully offset by compensations (never re-formatted, never a JS number) — the
 * same two inputs the domain's projection reads. `receivingStatus` is that SAME
 * pure projection (`projectReceivingStatus`), consumed BY VALUE, never re-typed.
 * `receivedAt` is the LATEST receiving instant of the line (NULL when it has no
 * events yet). `compensationCount` is the COUNT of compensating receipt lines
 * naming this line — a count of rows that exist (the return register's `lineCount`
 * reasoning), never a recomputed quantity. `purchaseDocumentNumber` is the parent's
 * number via the SAME database's same-owner join — display, never a second lookup,
 * never an N+1.
 */
export interface CommerceReceivingReportRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  orderedQuantity: string;
  receivedQuantity: string;
  receivingStatus: string;
  receivedAt: string | null;
  compensationCount: number;
}

/** One page of report rows — the repository's own paging convention. */
export interface CommerceReceivingReportPage {
  items: CommerceReceivingReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — per-STATUS COUNTS over the SAME filtered population the list
 * answers (`total` is the filtered total; every one of the three `RECEIVING_STATUSES`
 * members is always present, zero-filled by the reader). NO money totals, no rates,
 * no dates: this is a count summary, not a KPI.
 */
export interface CommerceReceivingReportSummary {
  total: number;
  byStatus: Record<string, number>;
}

/**
 * The narrow read contract — THREE reads, no writes, no timeline (see the header's
 * grain ruling). Every method takes the server-resolved scope FIRST: there is no shape
 * of this port that reads another tenant's rows.
 */
export interface CommerceReceivingReportingReader {
  listReportRows(
    scope: CommerceReceivingReportingScope,
    query: CommerceReceivingReportQuery
  ): Promise<CommerceReceivingReportPage>;
  getReportSummary(
    scope: CommerceReceivingReportingScope,
    query: CommerceReceivingReportQuery
  ): Promise<CommerceReceivingReportSummary>;
  getReportRow(
    scope: CommerceReceivingReportingScope,
    purchaseLineId: string
  ): Promise<CommerceReceivingReportRow | null>;
}


