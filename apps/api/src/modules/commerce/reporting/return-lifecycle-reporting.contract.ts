/**
 * The lifecycle vocabulary imported as a TYPE from the PURE module that owns it
 * (`returns/return-lifecycle.ts` — no NestJS, no Prisma, no repository, no clock),
 * so the contract can state the closed five-member set without the port gaining a
 * dependency on any implementation. The reader imports the same module BY VALUE to
 * zero-fill the summary; one file owns the vocabulary either way.
 */
import type { ReturnState } from '../returns/return-lifecycle';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Commerce-owned READ CONTRACT for the
 * ninth Reporting capability — «گزارش چرخه حیات مرجوعی‌های بازرگانی».
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES IN COMMERCE (NOT IN REPORTING)
 * ---------------------------------------------------------------------
 * Reporting must read Commerce truth without BECOMING Commerce truth. Commerce OWNS
 * this contract (the `ReturnDocument` / `ReturnLine` / `ReturnLifecycleTransition`
 * rows in `commerce_db`, the frozen five-state matrix of `returns/return-lifecycle.ts`,
 * the tenant predicate), and Reporting CONSUMES it through one injected token.
 * Commerce never imports Reporting; Reporting never imports a Commerce repository,
 * service, controller, Prisma client, generated client or DTO.
 *
 * WHAT ONE ROW MEANS (the SCOPE GATE's row-grain ruling)
 * ------------------------------------------------------
 * One row is ONE `ReturnDocument` — one return REQUEST against the purchase document
 * it originated from (the schema's own words, §5.17): a header with a bounded
 * `reason`, a `replacementRequired` flag and MANY per-line returned quantities. It
 * answers «which return, against which document, in what projected lifecycle state,
 * stated why, with how many lines, and when was it requested».
 *
 * THE STATE IS A PROJECTION, NEVER A COLUMN (S-D2). `ReturnDocument` stores no
 * status/state field: the current state is the LAST row of the append-only
 * `ReturnLifecycleTransition` history ordered by `(createdAt, id)`, answered by
 * `projectReturnState` over the frozen matrix
 * (`REQUESTED -> APPROVED | REJECTED`, `APPROVED -> RECEIVED_BACK`,
 * `RECEIVED_BACK -> REFUNDED`, `REJECTED`/`REFUNDED` terminal). This contract
 * imports that vocabulary by type; the reader projects each row through that SAME
 * pure module — there is no second rule engine anywhere on this surface.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY — each an SCOPE GATE exclusion, not an oversight:
 *  * NO money, NO refund amount, NO payment reference: the refund's money effect is
 *    the delegated Q compensation (`PaymentRecord`), which this register never
 *    projects — the REFUNDED state is the whole refund fact a lifecycle report states.
 *  * NO supplier/warehouse/stock/SKU columns: the schema stores none (contract §5).
 *  * NO `requestedByUserId` (the raw requester id) and NO transition `actorUserId`:
 *    raw actor ids with no reporting display contract — the payment register's
 *    `recordedByUserId` omission, for the same reason.
 *  * NO cancellation/inspection columns: C1-S has no cancel route and no separate
 *    inspection state (S-D4); receipt-back IS the receiving act.
 *  * NO line quantities on the LIST row: the register answers «which returns», and
 *    only `lineCount` (a count of rows that exist) crosses; the DETAIL read below
 *    carries the exact stored line quantities.
 *
 * DATE SEMANTICS — `createdAt` is the primary reporting date: the row's own clock,
 * written in the SAME transaction as its `REQUESTED` transition, so it IS the
 * request instant (the schema's only header timestamp; there is no updatedAt,
 * no submittedAt — append-only rows never change). `createdFrom/createdTo` are a
 * HALF-OPEN `[from, to)` window on that column — `gte` on the lower bound, `lt` on
 * the upper — the exact shape the purchase and payment registers state.
 *
 * TIMELINE — unlike the payment register (whose audit trail is document-bound and
 * therefore refused by grain), EVERY return lifecycle act is audited with
 * `resourceId = return document id` (five actions: create, approve, reject,
 * receive_back, refund — written AFTER commit, one per successful command), so a
 * timeline keyed to this row answers exactly this row's history. The timeline read
 * below delegates to the SAME platform audit trail Commerce's own reads use.
 */

/** The server-resolved tenant scope — the ONLY scope every read below carries. */
export interface CommerceReturnReportingScope {
  tenantId: string;
}

/** The token Reporting injects — the ONLY return surface Reporting reaches. */
export const COMMERCE_RETURN_LIFECYCLE_REPORTING_READER =
  'CommerceReturnLifecycleReportingReader' as const;

/**
 * The report query — ONLY the proven filters plus the page window. ABSENT KEYS STAY
 * ABSENT in the repository's where (never defaulted), so a caller that names no
 * filter reads the whole tenant population.
 *
 * WHAT IS DELIBERATELY ABSENT: NO global search beyond `reason` + the parent
 * `documentNumber` (the only text a return carries), NO amount filter (no money on
 * this grain), NO supplier/warehouse/item filter (no such column on
 * `ReturnDocument`), NO actor filter (raw ids, see above).
 */

/**
 * One report row — an EXPLICIT WHITELIST of eight fields. OMITTED: `tenantId` (the
 * scope, never a payload field), `requestedByUserId` (raw requester id, no display
 * contract), every transition's `actorUserId`, every Prisma/storage shape, and the
 * raw `Date` forms of the instants below.
 *
 * `state` is the PROJECTED lifecycle member (one of the five `ReturnState` values),
 * computed by `projectReturnState` over this row's ordered transitions — never a
 * column, never inferred from a timestamp. `lineCount` is a count of `ReturnLine`
 * rows that exist (like the purchase register's), not a figure computed from them.
 * `createdAt` is the request instant ISO-8601 (a moment stripped of its offset is a
 * different moment). `reason` is the verbatim bounded free text the requester
 * stated (1..500 at the DTO).
 */
export interface CommerceReturnReportRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  state: string;
  reason: string;
  replacementRequired: boolean;
  lineCount: number;
  createdAt: string;
}

/**
 * One returned quantity as the detail read carries it — the EXACT stored
 * `Decimal(18,4)` STRING (never a JS number), both opaque origin references, and
 * the line's own clock. Detail-only: the list row counts lines, it never renders them.
 */
export interface CommerceReturnReportLine {
  id: string;
  purchaseLineId: string;
  receiptLineId: string;
  quantity: string;
  createdAt: string;
}

/** The detail projection: the report row plus its lines, oldest first. */
export interface CommerceReturnReportDetail extends CommerceReturnReportRow {
  lines: CommerceReturnReportLine[];
}

/** One page of report rows — the repository's own paging convention. */
export interface CommerceReturnReportPage {
  items: CommerceReturnReportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The summary strip — explicit per-STATE COUNTS over the same authorized filtered
 * population the list answers. `total` is the filtered total; each `byState` entry
 * counts rows whose PROJECTED state is exactly that member, and every one of the
 * five `RETURN_STATES` members is always present (zero-filled) so a strip never has
 * to invent a missing key. Counts come from the repository's five predicate counts —
 * the backend is authoritative; no client recounts a page.
 */
export interface CommerceReturnReportSummary {
  total: number;
  byState: Record<string, number>;
}

/** The timeline projection — the same seven-field whitelist Commerce already uses. */
export interface CommerceReturnReportTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface CommerceReturnReportTimelinePage {
  items: CommerceReturnReportTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The narrow read contract — FOUR reads, no writes, no domain commands, no workflow
 * manipulation. Every method takes the server-resolved scope FIRST: there is no
 * shape of this port that reads another tenant's rows.
 */
export interface CommerceReturnLifecycleReportingReader {
  listReportRows(
    scope: CommerceReturnReportingScope,
    query: CommerceReturnReportQuery
  ): Promise<CommerceReturnReportPage>;
  getReportSummary(
    scope: CommerceReturnReportingScope,
    query: CommerceReturnReportQuery
  ): Promise<CommerceReturnReportSummary>;
  getReportRow(
    scope: CommerceReturnReportingScope,
    returnId: string
  ): Promise<CommerceReturnReportDetail | null>;
  getReportTimeline(
    scope: CommerceReturnReportingScope,
    returnId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<CommerceReturnReportTimelinePage>;
}
export interface CommerceReturnReportQuery {
  state?: ReturnState;
  search?: string;
  purchaseDocumentId?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}
