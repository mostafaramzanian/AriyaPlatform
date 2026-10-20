/**
 * PHASE W3 — THE AUTHORITATIVE CLOSURE ELIGIBILITY EVALUATOR (product-owner rule):
 *
 *   A purchase document may be closed only when ALL purchases it represents have
 *   been completed AND all required payments have been fully settled.
 *
 * WHY A PURE MODULE AND NOT A SERVICE METHOD (the `receiving-status.ts` /
 * `payment-status.ts` precedent): the rule is evaluated in exactly one place, by
 * one function with no NestJS, no Prisma and no clock. The service assembles the
 * FACTS (under the document row lock, inside the close transaction); this file
 * turns facts into an answer, so the rule cannot drift between a UI preview and
 * the write path.
 *
 * FULFILLMENT: a line is fulfilled exactly when its receiving projection is
 * `FULLY_RECEIVED` — Σ of its append-only `ReceiptLine` quantities (compensating
 * lines negative) equal to its ordered `quantity`, exact `compareMoney`
 * arithmetic, never a tolerance. SERVICE and NON_STANDARD lines use the SAME
 * quantity projection: receiving is this domain's fulfilment act for every line
 * type (`ReceiptLine` carries no stock semantics — stock evidence is the
 * separate `InventoryPosting` duty, already gated by the unresolved-posting
 * refusal). A returned-and-fully-compensated line is NOT fulfilled: the
 * compensation subtracts, the projection answers NOT/PARTIALLY_RECEIVED.
 *
 * RETURNS: a return in a NON-TERMINAL state (REQUESTED / APPROVED /
 * RECEIVED_BACK) is unresolved — goods or refund disposition is still open, so
 * the document may not close on it. Terminal states (REFUNDED, REJECTED) are
 * resolved by definition. The caller supplies each return's projected state;
 * this file does not re-project.
 *
 * SETTLEMENT (W3.1 amendment — the product owner's resolved-return decision):
 * the document is settled exactly when its payment projection against the
 * NET PAYABLE is `PAID`. Net payable is `totalAmount − refundedAmount`, where
 * `refundedAmount` is Σ of the compensation-row magnitudes of the
 * `PaymentRecord`s a `REFUNDED` return transition names as settled
 * (`refundedPaymentId` — the persisted link the refund act writes). A returned-and-fully-refunded purchase therefore closes: the refund
 * reduced what the supplier is still owed, and `paidAmount` only has to cover
 * what remains. A manual compensation (no REFUNDED transition names it) does
 * NOT lower the payable — it lowers what was paid, so it answers
 * `PAYMENT_SETTLEMENT_INCOMPLETE`, correctly refusing a document whose money
 * went back without a resolved return.
 *
 * `OVERPAID` against the net payable is a financial inconsistency, not success:
 * `paymentStatus null` (no stated total) or `OVERPAID` answer
 * `PAYMENT_INCONSISTENT`; `UNPAID`/`PARTIAL` answer
 * `PAYMENT_SETTLEMENT_INCOMPLETE`. An APPROVED payment plan with non-cancelled,
 * unexecuted installments is an open obligation the plan itself declared — it
 * blocks even when the raw sum says PAID (`PAYMENT_INCONSISTENT`: settled sum
 * beside open obligations cannot both be right) and otherwise rides the
 * settlement refusal.
 *
 * WHAT THIS FILE NEVER DOES: read a document status, a workflow instance or a
 * posting row (the caller has already refused on those), invent a service-line
 * acceptance contract the domain does not define, or return booleans — every
 * refusal is a machine-readable reason the client and the error contract can
 * answer specifically.
 */

import { projectPaymentStatus } from '../payment/payment-status';
import { compareMoney, negateMoney, sumMoney } from '../purchase/purchase-money';
import { projectReceivingStatus } from '../receiving/receiving-status';

/** The machine-readable closure-refusal codes this evaluator produces. */
export const CLOSURE_REFUSAL = {
  FULFILLMENT_INCOMPLETE: 'PURCHASE_FULFILLMENT_INCOMPLETE',
  RETURN_UNRESOLVED: 'PURCHASE_RETURN_UNRESOLVED',
  PAYMENT_SETTLEMENT_INCOMPLETE: 'PURCHASE_PAYMENT_SETTLEMENT_INCOMPLETE',
  PAYMENT_INCONSISTENT: 'PURCHASE_PAYMENT_INCONSISTENT',
  /**
   * W4-B: a REFUNDED transition whose refund link cannot be resolved to one
   * precise compensation row (a legacy `refundedPaymentId` whose payment now
   * carries several compensations). Ambiguous money is never guessed — the
   * closure refuses and names the link that needs review.
   */
  REFUND_AMBIGUOUS: 'PURCHASE_REFUND_AMBIGUOUS',
} as const;

export type ClosureRefusalCode = (typeof CLOSURE_REFUSAL)[keyof typeof CLOSURE_REFUSAL];

export interface ClosureRefusal {
  code: ClosureRefusalCode;
  /** Free-text detail for operators/UIs — never machine-parsed. */
  detail: string;
}

/** One purchase line's fulfillment facts, as the repository read them. */
export interface ClosureLineFact {
  lineId: string;
  lineNumber: number;
  orderedQuantity: string;
  /** Σ of the line's receipt-line quantities, compensations included. */
  receivedQuantity: string;
}

/** One return document's projected state (see `projectReturnState`). */
export interface ClosureReturnFact {
  returnId: string;
  state: 'REQUESTED' | 'APPROVED' | 'RECEIVED_BACK' | 'REFUNDED' | 'REJECTED';
}

/** The payment facts of the document. */
export interface ClosurePaymentFact {
  /** The document's stored total — NULL means not stated, never zero. */
  totalAmount: string | null;
  /** Σ `PaymentRecord.amount` over the WHOLE history (compensations negative). */
  paidAmount: string;
  /**
   * Σ of the actual refunded amounts settled BY returns: the magnitudes of the
   * COMPENSATION rows of the `PaymentRecord`s that REFUNDED return transitions
   * name via `refundedPaymentId` (W4 — a partial refund writes a partial
   * compensation, and only that stated figure lowers the payable). Subtracted
   * from `totalAmount` to get the net payable; manual compensations are
   * deliberately NOT in this sum.
   */
  refundedAmount: string;
  /**
   * W4-B: one or more REFUNDED transitions name a refund whose exact
   * compensation row cannot be resolved (legacy link, several compensations
   * on the named payment). When true `refundedAmount` is PARTIAL — it covers
   * only the refunds whose row is known — and the evaluator refuses rather
   * than settle against an unknowable payable.
   */
  refundAmbiguous: boolean;
  /** Σ of open (non-cancelled, unexecuted) installments of APPROVED plans. */
  openInstallmentAmount: string;
  /** Count of those open installments, for the refusal detail. */
  openInstallmentCount: number;
}

export interface ClosureFacts {
  lines: readonly ClosureLineFact[];
  returns: readonly ClosureReturnFact[];
  payment: ClosurePaymentFact;
}

export interface ClosureEligibility {
  eligible: boolean;
  /** Every refusal found — not just the first — so the UI can explain fully. */
  reasons: ClosureRefusal[];
}

const UNRESOLVED_RETURN_STATES = new Set(['REQUESTED', 'APPROVED', 'RECEIVED_BACK']);

/**
 * Evaluate the confirmed closure rule against authoritative facts. Returns
 * `eligible: true` only when every line is FULLY_RECEIVED, no return is
 * unresolved, and the payment projection is exactly PAID with no open
 * installment obligations.
 */
export function evaluatePurchaseClosure(facts: ClosureFacts): ClosureEligibility {
  const reasons: ClosureRefusal[] = [];

  for (const line of facts.lines) {
    if (projectReceivingStatus(line.orderedQuantity, line.receivedQuantity) !== 'FULLY_RECEIVED') {
      reasons.push({
        code: CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE,
        detail:
          `line ${line.lineNumber}: ordered ${line.orderedQuantity}, ` +
          `net received ${line.receivedQuantity}`,
      });
    }
  }

  const unresolved = facts.returns.filter((r) => UNRESOLVED_RETURN_STATES.has(r.state));
  if (unresolved.length > 0) {
    reasons.push({
      code: CLOSURE_REFUSAL.RETURN_UNRESOLVED,
      detail:
        `${unresolved.length} return(s) still open: ` +
        unresolved.map((r) => `${r.returnId} (${r.state})`).join(', '),
    });
  }

  // W4-B: an unresolvable refund link makes the payable unknowable — refuse
  // with the dedicated reason instead of settling against a partial sum.
  if (facts.payment.refundAmbiguous) {
    reasons.push({
      code: CLOSURE_REFUSAL.REFUND_AMBIGUOUS,
      detail:
        'a refunded return names a payment whose exact refund row cannot be determined ' +
        '(legacy link with multiple compensations); the refund association needs review',
    });
    return { eligible: false, reasons };
  }

  // W3.1: the payable is the document total MINUS what resolved returns
  // refunded — never the raw total, never a guessed figure.
  const netPayable =
    facts.payment.totalAmount === null
      ? null
      : sumMoney([facts.payment.totalAmount, negateMoney(facts.payment.refundedAmount)]);
  // W3.1: `projectPaymentStatus` answers UNPAID for `paid <= 0` by contract
  // (§3-B — no payment rows is UNPAID, never PAID). A fully refunded document
  // is the exception the projection's vocabulary cannot express: payable 0
  // with paid exactly 0 IS settled — every rial paid came back through named
  // refunds. Positive or negative paid beside a zero payable is inconsistent.
  const zeroPayable =
    netPayable !== null && compareMoney(netPayable, '0.0000') === 0;
  const settled = zeroPayable
    ? compareMoney(facts.payment.paidAmount, '0.0000') === 0
    : projectPaymentStatus(netPayable, facts.payment.paidAmount) === 'PAID';
  const inconsistent = zeroPayable
    ? !settled
    : projectPaymentStatus(netPayable, facts.payment.paidAmount) === null ||
      projectPaymentStatus(netPayable, facts.payment.paidAmount) === 'OVERPAID';
  if (inconsistent) {
    reasons.push({
      code: CLOSURE_REFUSAL.PAYMENT_INCONSISTENT,
      detail:
        netPayable === null
          ? 'document total is not stated; settlement cannot be evaluated'
          : `paid ${facts.payment.paidAmount} is inconsistent with net payable ${netPayable} (total ${facts.payment.totalAmount} minus refunded ${facts.payment.refundedAmount})`,
    });
  } else if (!settled) {
    reasons.push({
      code: CLOSURE_REFUSAL.PAYMENT_SETTLEMENT_INCOMPLETE,
      detail: `paid ${facts.payment.paidAmount} of net payable ${netPayable}`,
    });
  } else if (facts.payment.openInstallmentCount > 0) {
    // PAID on the raw sum while APPROVED-plan installments still wait for
    // execution — the plan and the ledger disagree; refuse as inconsistent.
    reasons.push({
      code: CLOSURE_REFUSAL.PAYMENT_INCONSISTENT,
      detail:
        `${facts.payment.openInstallmentCount} approved installment(s) totalling ` +
        `${facts.payment.openInstallmentAmount} remain unexecuted although payments sum to PAID`,
    });
  }

  return { eligible: reasons.length === 0, reasons };
}
