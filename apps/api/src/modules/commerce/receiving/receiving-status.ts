/**
 * Phase C1 Step R (§5.16, contract R5/R9 and §3-B): the receiving status of a
 * purchase LINE — the closed vocabulary and its DETERMINISTIC PROJECTION, as a
 * pure module with NO dependencies at all (no NestJS, no Prisma, no repository,
 * no clock).
 *
 * WHY A PROJECTION AND NOT A COLUMN (R5)
 * --------------------------------------
 * The append-only receipt events are the source of truth, so the status is
 * COMPUTED from them and the line's own ordered `quantity` at read time. There
 * is therefore no receiving status column and no receiving status enum anywhere
 * in `prisma/commerce/schema.prisma` — on `Receipt`, on `ReceiptLine`, on
 * `PurchaseLine` or on `PurchaseDocument`. A stored status would be a SECOND
 * source of truth that can disagree with the events it summarises (a +30 event
 * appended after a stored `FULLY_RECEIVED` would leave the lie readable until
 * someone repaired it). `payment-status.spec.ts`'s TEXT join is mirrored in
 * `receiving-status.spec.ts`: this file's tuple is checked against the schema,
 * and the ABSENCE of a status enum/column is asserted.
 *
 * WHY THIS FILE HAS NO DEPENDENCIES (the `payment-status.ts` precedent)
 * ---------------------------------------------------------------------
 * The DTO validates against the tuple, the service projects the status, and a
 * spec proves the rules exhaustively — three callers that must agree. A rule
 * re-typed in the service is how `NOT_RECEIVED` and `FULLY_RECEIVED` both end
 * up true for the same quantities. All arithmetic goes through `compareMoney`
 * (exact string comparison over `Decimal(18,4)` values), never through JS
 * floats: `100.0000` received against `100` ordered is `FULLY_RECEIVED`,
 * never a hair below it.
 *
 * THE IMPOSSIBLE STATE IS REFUSED, NOT VOCABULARISED (contract §3-B)
 * -----------------------------------------------------------------
 * `received > ordered` THROWS instead of returning a fourth status: R1/R2 make
 * over-receipt impossible in valid persisted history, so a `RangeError` here is
 * the loudest possible answer to "your invariant was broken somewhere else" —
 * while adding `OVER_RECEIVED` would quietly turn a bug into a feature.
 *
 * NOT WORKFLOW STATE, NOT COMMERCIAL STATE, NOT PAYMENT STATE (R6): nothing in
 * this file reads a document status, a workflow instance, a payment row or any
 * other table. The projection's ONLY inputs are the summed receipt lines and
 * the line's own ordered quantity.
 */

import { compareMoney } from '../purchase/purchase-money';

/**
 * The receiving status vocabulary (R5/R9), in the specification's own order.
 *
 * CLOSED at three members: a fourth status would describe a distinction no
 * contract in C1 makes, and it would arrive together with the projection rule
 * that produces it — never as a string a serializer invents.
 */
export const RECEIVING_STATUSES = ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'] as const;

export type ReceivingStatus = (typeof RECEIVING_STATUSES)[number];

/**
 * Project the receiving status of ONE purchase line from its ordered quantity
 * and the SUM of all its receipt events (contract §3-B):
 *
 *  1. `received <= 0`     → `NOT_RECEIVED`   — no events, or events fully
 *     offset by compensations (a line whose arrivals were all withdrawn has
 *     received nothing again; the rule is checked BEFORE the comparison with
 *     ordered so a compensated-to-zero line never reads as a sliver).
 *  2. `received < ordered` → `PARTIALLY_RECEIVED`
 *  3. `received == ordered` → `FULLY_RECEIVED` — exact equality, never a
 *     tolerance (R2: there is none to reach for).
 *  4. `received > ordered` → `RangeError` — not a status (see the header).
 *
 * `received` is Σ of the line's receipt-line quantities, computed over the
 * WHOLE document history by the caller — compensating lines are negative and
 * therefore subtract. `ordered` arrives exactly as the line stores it; it is
 * REQUIRED and POSITIVE (a line without a quantity is not a line), so no
 * "zero ordered" branch exists to guess at.
 */
export function projectReceivingStatus(
  orderedQuantity: string,
  receivedQuantity: string
): ReceivingStatus {
  if (compareMoney(receivedQuantity, '0') <= 0) return 'NOT_RECEIVED';
  const versusOrdered = compareMoney(receivedQuantity, orderedQuantity);
  if (versusOrdered < 0) return 'PARTIALLY_RECEIVED';
  if (versusOrdered === 0) return 'FULLY_RECEIVED';
  throw new RangeError(
    `over-receipt cannot exist in valid persisted history: ordered ${orderedQuantity}, received ${receivedQuantity}`
  );
}
