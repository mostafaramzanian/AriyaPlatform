/**
 * Phase C1 Step Q (§5.13, contract §2-Q2 and §3-B): the payment status of a purchase
 * document — the closed vocabulary and its DETERMINISTIC PROJECTION, as a pure module
 * with NO dependencies at all (no NestJS, no Prisma, no repository, no clock).
 *
 * WHY A PROJECTION AND NOT A COLUMN (§5.13, contract Q2)
 * -----------------------------------------------------
 * The history rows are the source of truth, so the status is COMPUTED from them and the
 * document's own `totalAmount` at read time. There is therefore no `PaymentStatus`
 * column and no `PaymentStatus` enum anywhere in `prisma/commerce/schema.prisma` — a
 * stored status would be a SECOND source of truth that can disagree with the rows it
 * summarises. `purchase-status.spec.ts`'s TEXT join is mirrored here: this file's tuple
 * is checked against the schema, and the ABSENCE of a status enum/column is asserted.
 *
 * WHY THIS FILE HAS NO DEPENDENCIES (the `purchase-status.ts` precedent)
 * ----------------------------------------------------------------------
 * The DTO validates against the tuple, the service projects the status, and a spec
 * proves the rules exhaustively — three callers that must agree. A rule re-typed in the
 * service is how `PAID` and `PARTIAL` both end up true for the same amounts. All
 * arithmetic goes through `compareMoney` (exact string comparison over `Decimal(18,4)`
 * values), never through JS floats: `26.2500` paid against `26.2500` total is `PAID`,
 * never `PARTIAL` and never `OVERPAID`.
 *
 * NOT WORKFLOW STATE, NOT COMMERCIAL STATE, NOT RECEIVING STATE (§5.11–§5.13, tests 18
 * and 19): nothing in this file reads a document status, a workflow instance or any
 * other table. The projection's ONLY inputs are the summed rows and the document's own
 * stated total.
 */

import { compareMoney } from '../purchase/purchase-money';

/**
 * The payment status vocabulary (§5.13), in the specification's own order.
 *
 * CLOSED at four members: a fifth status would describe a distinction no contract in C1
 * makes, and it would arrive together with the projection rule that produces it — never
 * as a string a serializer invents. `null` (no total stated yet) is deliberately NOT a
 * member: it is the ABSENCE of a projection, carried alongside it on the wire, because
 * stating `UNPAID` for a document whose total is not stated would invent a total.
 */
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The payment method vocabulary (contract Q3, §5.14), closed at THREE members — the
 * step-Q specification's own list, stored as the schema's `PaymentMethod` enum.
 *
 * `CHECK` NAMES A METHOD A TENANT STATES, NOT AN ENTITY: no cheque, bank, instrument,
 * endorsement or clearing model exists in Commerce (§13's "do NOT build a fake full
 * Finance module"), and the payment's opaque `externalReference` / `invoiceRef` strings
 * are where a future Finance contract will find its identifier — references, not
 * relationships. A fourth method arrives as an additive migration PLUS this tuple and
 * its DTO membership, never as a free-text column. `purchase-status.spec.ts`'s TEXT join
 * is mirrored in `payment-status.spec.ts`: this tuple is checked against the schema's
 * `PaymentMethod` members IN ORDER, so the two can never drift.
 */
export const PAYMENT_METHODS = ['CASH', 'PETTY_CASH', 'CHECK'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Project the payment status of a document from its stored rows and its own total
 * (contract §3-B, the five rules in order):
 *
 *  1. `totalAmount` is NULL  → `null`  — the projection is UNDEFINED. A document that
 *     has not stated its total cannot be "unpaid"; saying so would state a total.
 *  2. `paidAmount <= 0`      → `UNPAID` — no rows, or only reversals. Checked BEFORE
 *     equality so that a priced document totalling `0.0000` with nothing paid answers
 *     `UNPAID`, not `PAID` (§3-B's free-lines note).
 *  3. `paidAmount = total`   → `PAID`    — exact equality, never a tolerance.
 *  4. `paidAmount > total`   → `OVERPAID`
 *  5. otherwise              → `PARTIAL` — `0 < paidAmount < totalAmount`.
 *
 * `paidAmount` is Σ `amount` over ALL of the document's rows (compensating rows are
 * negative and therefore subtract — a reversal returning a document to `UNPAID` is
 * rule 2 firing again). The caller computes the sum over the WHOLE history, never over
 * a filtered page: a status that changed when a user typed into a search box would not
 * be a projection of the document (contract Q9).
 *
 * `totalAmount` arrives exactly as the document stores it — `null` only when the
 * document is not priced, never as zero-on-its-behalf.
 */
export function projectPaymentStatus(
  totalAmount: string | null,
  paidAmount: string
): PaymentStatus | null {
  if (totalAmount === null) return null;
  if (compareMoney(paidAmount, '0') <= 0) return 'UNPAID';
  const versusTotal = compareMoney(paidAmount, totalAmount);
  if (versusTotal === 0) return 'PAID';
  if (versusTotal > 0) return 'OVERPAID';
  return 'PARTIAL';
}
