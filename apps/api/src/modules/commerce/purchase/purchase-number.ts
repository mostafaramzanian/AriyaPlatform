/**
 * Phase C1 Step L: the numbering contract of a purchase document (§5.1), as PURE
 * functions over a counter value the database allocated.
 *
 * THE DECISION THIS FILE IMPLEMENTS, AND WHERE IT WAS MADE
 * -------------------------------------------------------
 * §5.1 requires the numbering strategy to be decided ONCE and documented in the
 * schema. It is documented there — in the header of `prisma/commerce/schema.prisma`
 * and on `PurchaseDocumentCounter` — and it is the repository's ONE existing shape
 * (`LetterNumberCounter` in correspondence, `Employee.personnelCode` in HR): a
 * `(tenantId, kind, jalaliYear)` counter row, allocated by a single atomic statement
 * INSIDE the creating transaction. This file owns the part of that decision that is
 * pure arithmetic and formatting; `purchase.repository.ts` owns the statement.
 *
 * WHY THE FORMAT IS A TOTAL MAP FROM KIND, WHICH LOOKS LIKE OVERKILL FOR ONE KIND
 * -----------------------------------------------------------------------------
 * `kind` is part of the numbering KEY, so two kinds are two series — and
 * `PurchaseDocument` is UNIQUE per `(tenantId, documentNumber)`. If both series used
 * one prefix, both would mint `PR-1405-00001`, and the second tenant's second kind
 * would fail its insert for a reason nothing in the code states. Mapping EVERY kind
 * to its own prefix makes that impossible by construction, and makes a future kind a
 * deliberate edit here (a migration adds the enum member; this record must then gain
 * its prefix or the file does not compile). That is the same "future additions are
 * migrations, and the compiler says so" discipline §5.2 states for line types.
 *
 * DETERMINISTIC, NEVER RANDOM: the sequence is the database's counter, the year is
 * computed from the create instant, and nothing here consults a clock, a client value
 * or a random source. Two calls with the same arguments produce the same string —
 * which is what makes this file testable at all.
 */

import type { PurchaseDocumentKind } from './purchase-status';

/**
 * The mint prefix of every kind, and the visual language of the number.
 *
 * `PR` is the purchase-request prefix, matching `AR` for correspondence letters and
 * the reference implementation's own habit of a short uppercase token. The record is
 * `as const` so the literal type survives; a kind added to
 * {@link PurchaseDocumentKind} without an entry here fails to compile, which is the
 * whole point of writing it as a mapped record rather than as a default.
 */
export const PURCHASE_DOCUMENT_NUMBER_PREFIX = {
  PURCHASE_REQUEST: 'PR',
} as const;

/** The sequence window: `00042`. Fixed width, so numbers sort as text. */
export const PURCHASE_DOCUMENT_NUMBER_WIDTH = 5;

/**
 * The stored form of one document number: `PR-1405-00042`.
 *
 * `kind` selects the prefix (see above); `jalaliYear` is the Jalali year the counter
 * was keyed by, and `sequence` is the counter value the database returned.
 *
 * THE SEQUENCE IS REFUSED UNLESS IT IS A POSITIVE INTEGER. A counter is allocated by
 * the database and starts at 1, so a zero, a negative or a fraction means the
 * allocation did not happen the way this file assumes — and formatting it would
 * produce a number that reads as legitimate. The check is here, pure and total,
 * because the alternative is a `00000` document number discovered in production.
 */
export function formatPurchaseDocumentNumber(
  kind: PurchaseDocumentKind,
  jalaliYear: number,
  sequence: number
): string {
  if (!Number.isInteger(jalaliYear) || !Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(
      `Refusing to format a purchase document number from a non-positive sequence: ${jalaliYear}/${sequence}`
    );
  }

  const prefix = PURCHASE_DOCUMENT_NUMBER_PREFIX[kind];
  return `${prefix}-${jalaliYear}-${String(sequence).padStart(PURCHASE_DOCUMENT_NUMBER_WIDTH, '0')}`;
}
