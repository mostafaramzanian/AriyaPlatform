/**
 * PHASE GAP-6: the quotation confirmation vocabulary and its rules, as PURE data
 * and pure functions — the same shape `purchase-status.ts` established for the
 * document lifecycle and `return-lifecycle.ts` for returns.
 *
 * WHY A PURE MODULE: three callers must agree on these strings — the DTO validates
 * a decision against them, the service decides whether a transition is legal and
 * whether a document may still take quotations, and the wire projection states the
 * status back. A rule re-typed per caller is how PENDING ends up both "decidable"
 * and "not decidable" in the same release.
 *
 * NO DEPENDENCIES AT ALL — no NestJS, no Prisma, no clock. That is what lets the
 * rules be tested exhaustively and makes the refusals stateable as named 409s.
 *
 * THIS IS NOT DOCUMENT STATUS, NOT PAYMENT STATUS, NOT RECEIVING STATUS. A
 * quotation's confirmation is its OWN dimension (§5.11's independence, from the
 * quotation's side): nothing in this file may read or write another lifecycle.
 */
import type { PurchaseDocumentStatus } from '../purchase/purchase-status';
import { compareMoney, moneyFromNumber } from '../purchase/purchase-money';
import type { QuotationDecision } from './quotation.constants';

/** The confirmation vocabulary, in the schema enum's order. */
export const QUOTATION_STATUSES = ['PENDING', 'CONFIRMED', 'RETURNED'] as const;

export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/**
 * The legal confirmation transitions, TOTAL over the vocabulary so a future
 * member is a compile error here rather than an unreachable state. Exactly ONE
 * edge per terminal member, both leaving PENDING: a decision moves a quotation
 * once and decided rows are never rewritten — the correction loop continues on
 * the NEXT version row, which is why CONFIRMED and RETURNED have no outgoing
 * edges at all.
 */
export const QUOTATION_TRANSITIONS: Readonly<Record<QuotationStatus, readonly QuotationStatus[]>> =
  Object.freeze({
    PENDING: Object.freeze(['CONFIRMED', 'RETURNED'] as const),
    CONFIRMED: Object.freeze([] as const),
    RETURNED: Object.freeze([] as const),
  });

/** Whether the confirmation lifecycle permits `from → to`. */
export function canTransitionQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  return QUOTATION_TRANSITIONS[from].includes(to);
}

/**
 * Where each wire decision LANDS. The decision vocabulary lives in
 * `quotation.constants.ts` (it is a wire concern) and the status vocabulary here
 * (it is a storage concern); this map is the ONE bridge, and its spec proves every
 * member names a legal transition — so a fourth decision cannot be added without
 * the transition table admitting it first.
 */
export const QUOTATION_TARGET_OF: Readonly<Record<QuotationDecision, QuotationStatus>> =
  Object.freeze({
    CONFIRM: 'CONFIRMED',
    RETURN: 'RETURNED',
  });

/**
 * The document statuses a quotation act (create OR decide) may run against —
 * every member of the document vocabulary except the two that mean the purchase
 * is no longer in circulation: `CLOSED` (the purchase has run its course, C1 §29)
 * and `CANCELLED` (withdrawn). A quotation is price evidence for a purchase that
 * can still happen; after either terminal document state there is nothing to
 * price, and recording evidence there would contradict completion's own lock.
 *
 * `DRAFT`, `SUBMITTED` and `APPROVED` all admit quotations deliberately: price
 * may be obtained before an approval completes (the group asks for an early
 * estimate) and after it completes (the approved purchase still needs its
 * proforma before payment) — neither the workflow nor the commercial lifecycle
 * gates this child dimension.
 */
export const QUOTATION_DOCUMENT_STATUSES: readonly PurchaseDocumentStatus[] = Object.freeze([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
]);

/** Whether a quotation act may run against a document in this status. */
export function canQuoteDocument(status: PurchaseDocumentStatus): boolean {
  return (QUOTATION_DOCUMENT_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// CASH / NON-CASH ROUTING (GAP-6 follow-up, §3.5)
// ---------------------------------------------------------------------------

/**
 * The PROVISIONAL cash ceiling: the organization's current documented rule is
 * "a confirmed quotation total at or below 30,000,000 (تومان) is a cash
 * purchase; above it is non-cash (چک)". It is a DEFAULT, not a law:
 * `PURCHASE_CASH_MAX_AMOUNT` overrides it per deployment, and moving this rule
 * to a per-tenant versioned policy is a recorded business decision.
 */
export const DEFAULT_PURCHASE_CASH_MAX_AMOUNT = 30_000_000;

/** How the routing classification was reached — stated beside the answer so a reader never guesses. */
export interface PurchasePaymentRouting {
  readonly basis: 'confirmedQuotationTotal';
  /** The exact `Decimal(18,4)` threshold string the classification compared against. */
  readonly cashMaxAmount: string;
  /** `CASH` (total ≤ threshold), `NON_CASH` (above), or `null` — no confirmed total to classify. */
  readonly classification: 'CASH' | 'NON_CASH' | null;
  /** The CONFIRMED quotation the total came from, when one exists. */
  readonly sourceQuotationId: string | null;
}

/**
 * The routing rule — ONE comparison, exact, with the boundary stated here:
 * `total <= threshold` is CASH (inclusive at the threshold, matching the
 * organization's «کمتر یا مساوی سقف نقدی» rule), anything above is NON_CASH.
 *
 * `null` IN — no CONFIRMED quotation total — is NOT classified: an unpriced or
 * unconfirmed request has no price evidence to route on, and inventing a
 * default side would make the badge lie. An unusable threshold is likewise
 * `null` rather than a silently widened cash band.
 */
export function classifyPurchaseRouting(
  confirmedTotalAmount: string | null,
  cashMaxAmount: number
): 'CASH' | 'NON_CASH' | null {
  if (confirmedTotalAmount === null) return null;
  if (!Number.isFinite(cashMaxAmount) || cashMaxAmount < 0) return null;
  return compareMoney(confirmedTotalAmount, moneyFromNumber(cashMaxAmount)) <= 0
    ? 'CASH'
    : 'NON_CASH';
}
