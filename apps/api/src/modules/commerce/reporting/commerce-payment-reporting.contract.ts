/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Commerce-owned READ CONTRACT for the
 * eighth Reporting capability — «گزارش تاریخچه پرداخت‌های بازرگانی».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN COMMERCE (NOT IN REPORTING)
 * ---------------------------------------------------------------------
 * Reporting must read Commerce truth without BECOMING Commerce truth. Commerce OWNS this
 * contract (the `PaymentRecord` rows in `commerce_db`, the closed `PaymentMethod`
 * vocabulary of `payment/payment-status.ts`, the tenant predicate), and Reporting
 * CONSUMES it through one injected token. Commerce never imports Reporting; Reporting
 * never imports a Commerce repository, service, controller, Prisma client, generated
 * client or DTO.
 *
 * WHAT ONE ROW MEANS (the SCOPE GATE's row-grain ruling)
 * ------------------------------------------------------
 * One row is ONE `PaymentRecord` — the append-only payment event child of
 * `PurchaseDocument` (contract §Q1: «a payment has no meaning apart from the document it
 * settles»), INCLUDING its compensating (negating) rows. It answers «what payment was
 * recorded, against which document, when, in what amount and unit, by which method, with
 * which opaque references, and does it reverse another row».
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY — each an SCOPE GATE exclusion, not an oversight:
 *  * NO payment status per row (`UNPAID/PARTIAL/PAID/OVERPAID`): the schema has NO
 *    `PaymentStatus` column (asserted by `payment-status.spec.ts`); the vocabulary is a
 *    READ-TIME projection over ONE document's WHOLE history plus its `totalAmount`
 *    (`projectPaymentStatus`) — never a fact about a single row, so it never appears on
 *    a row and never filters one.
 *  * NO lifecycle/attempt/provider/settlement/cancellation columns: none exist in
 *    `prisma/commerce/schema.prisma`; the only correction mechanism is a compensating
 *    row (`reversesPaymentId`), which IS on this row.
 *  * NO timeline method: the payment audit trail is bound to the DOCUMENT
 *    (`payment-history.service.ts` stamps `resourceId: documentId` for BOTH `append` and
 *    `compensate`), so an audit read keyed to a payment id cannot answer «this row's
 *    history» without returning its siblings' events too — a timeline here would lie by
 *    grain, so none is offered.
 *  * NO Financial fact: `finance_db` is a different bounded context; the opaque
 *    references on this row are where a FUTURE source-owned contract would look (§13).
 *
 * DATE SEMANTICS — `paymentDate` is the primary reporting date (the caller's stated
 * instant, defaulting to the row's insert clock — the schema's `payment_date`,
 * `default(now())`, NOT NULL). `paymentFrom/paymentTo` are a HALF-OPEN `[from, to)`
 * window on that column — `gte` on the lower bound, `lt` on the upper — the exact shape
 * the purchase register's KPI-RUNTIME windows state (`purchase.repository.ts`). Same-day
 * behaviour belongs to the caller's stated bounds (an end-exclusive instant carries no
 * day ambiguity). `createdAt` is bookkeeping and never a filter; `updatedAt` does not
 * exist (append-only rows never change).
 */
import type { PaymentMethod } from '../payment/payment-status';

/** The server-resolved tenant scope — the ONLY scope every read below carries. */
export interface CommercePaymentReportingScope {
  tenantId: string;
}

/** The token Reporting injects — the ONLY payment surface Reporting reaches. */
export const COMMERCE_PAYMENT_REPORTING_READER = 'CommercePaymentReportingReader' as const;

/**
 * The report query — ONLY the proven filters plus the page window. ABSENT KEYS STAY
 * ABSENT in the repository's where (never defaulted), so a caller that names no filter
 * reads the whole tenant population.
 *
 * WHAT IS DELIBERATELY ABSENT: NO `status` (no per-row status exists), NO `currency`
 * (a snapshot column with no closed set), NO amount range (no source-backed vocabulary),
 * NO `recordedByUserId` filter (a raw actor id with no display contract), NO free-text
 * beyond the row's own references + the parent `documentNumber`.
 */
export interface CommercePaymentReportQuery {
  method?: PaymentMethod;
  search?: string;
  purchaseDocumentId?: string;
  paymentFrom?: string;
  paymentTo?: string;
  page?: number;
  pageSize?: number;
}

/**
 * One report row — an EXPLICIT WHITELIST of twelve fields. OMITTED: `tenantId` (the
 * scope, never a payload field), `recordedByUserId` (raw actor id with no display
 * contract — the same reason the purchase register withholds `requesterId`), `createdAt`
 * (insert clock; `paymentDate` is the business date), every Prisma/storage shape, and
 * the per-document payment status (a whole-history projection, never a row fact).
 *
 * `amount` is the exact stored `Decimal(18,4)` STRING (NEGATIVE on a compensating row —
 * never re-formatted, never a JS number). `currency` is the per-row snapshot (NULL = none
 * stated, never `0`). `purchaseDocumentNumber` is the parent's number via the SAME
 * database's same-owner join — display, never a second lookup, never an N+1.
 */
export interface CommercePaymentReportRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  amount: string;
  currency: string | null;
  method: string;
  paymentDate: string;
  payerRef: string | null;
  payeeRef: string | null;
  invoiceRef: string | null;
  externalReference: string | null;
  reversesPaymentId: string | null;
}

export interface CommercePaymentReportPage {
  items: CommercePaymentReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — per-METHOD COUNTS over the SAME filtered population the list
 * answers (`total` is the filtered total; every one of the three `PAYMENT_METHODS`
 * members is always present, zero-filled by the reader). NO per-status counts (status is
 * a per-document projection), no rates, no money totals: this is a count summary, not a
 * KPI.
 */
export interface CommercePaymentReportSummary {
  total: number;
  byMethod: Record<string, number>;
}

/**
 * The narrow read contract — THREE reads, no writes, no timeline (see the header's
 * grain ruling). Every method takes the server-resolved scope FIRST: there is no shape
 * of this port that reads another tenant's rows.
 */
export interface CommercePaymentReportingReader {
  listReportRows(
    scope: CommercePaymentReportingScope,
    query: CommercePaymentReportQuery
  ): Promise<CommercePaymentReportPage>;
  getReportSummary(
    scope: CommercePaymentReportingScope,
    query: CommercePaymentReportQuery
  ): Promise<CommercePaymentReportSummary>;
  getReportRow(
    scope: CommercePaymentReportingScope,
    paymentId: string
  ): Promise<CommercePaymentReportRow | null>;
}
