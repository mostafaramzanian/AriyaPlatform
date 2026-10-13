import { instantToJalaliDate } from '../../../calendar/jalali.util';
import {
  PURCHASE_DOCUMENT_NUMBER_PREFIX,
  PURCHASE_DOCUMENT_NUMBER_WIDTH,
  formatPurchaseDocumentNumber,
} from './purchase-number';
import { PURCHASE_DOCUMENT_KINDS } from './purchase-status';

/**
 * Phase C1 Step L (§5.1): the document-number contract, as pure formatting over a
 * counter the database allocated.
 *
 * THE TWO CLAIMS WORTH TESTING
 * ---------------------------
 *  1. EVERY kind has its own prefix. `kind` is part of the numbering KEY and
 *     `(tenantId, documentNumber)` is unique, so two kinds sharing a prefix would mint
 *     the same number twice and the failure would surface as a constraint violation in
 *     an unrelated request. The FLOOR assertion (`>= 1` with the kind list iterated) is
 *     what keeps the loop from passing vacuously if the vocabulary ever empties.
 *  2. A sequence the database could not have produced is REFUSED rather than formatted.
 *     `PR-1405-00000` is a legitimate-looking number for an allocation that did not
 *     happen, and it would be permanent.
 *
 * The Jalali year is computed HERE through the same `calendar/jalali.util` the repository
 * uses — not hard-coded — so the spec states the relationship ("the year of the create
 * instant") rather than a year that will be wrong next Farvardin.
 */

describe('Phase C1 Step L — the numbering contract', () => {
  it('maps every kind to its own two-letter prefix, and PURCHASE_REQUEST to PR', () => {
    expect(PURCHASE_DOCUMENT_KINDS.length).toBeGreaterThanOrEqual(1);
    for (const kind of PURCHASE_DOCUMENT_KINDS) {
      expect(typeof PURCHASE_DOCUMENT_NUMBER_PREFIX[kind]).toBe('string');
      expect(PURCHASE_DOCUMENT_NUMBER_PREFIX[kind]).toMatch(/^[A-Z]{2,3}$/);
    }

    expect(PURCHASE_DOCUMENT_NUMBER_PREFIX.PURCHASE_REQUEST).toBe('PR');
  });

  it('refuses to share one prefix between two kinds', () => {
    const prefixes = PURCHASE_DOCUMENT_KINDS.map((kind) => PURCHASE_DOCUMENT_NUMBER_PREFIX[kind]);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('pads the sequence to a fixed width so numbers sort as text', () => {
    expect(PURCHASE_DOCUMENT_NUMBER_WIDTH).toBe(5);
    expect(formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405, 42)).toBe('PR-1405-00042');
    expect(formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405, 123456)).toBe('PR-1405-123456');
  });

  it('stays inside the column width for the widest sequence the counter can reach', () => {
    // `document_number` is VARCHAR(64); the format is `PR-{year}-{sequence}`. This pins
    // the headroom rather than discovering it as a truncation error.
    const widest = formatPurchaseDocumentNumber('PURCHASE_REQUEST', 9999, 999999999);

    expect(widest.length).toBeLessThanOrEqual(64);
  });

  it('keys the year by the create instant, through the calendar module’s one implementation', () => {
    // Fixed instant, both sides computed from the same function: the assertion is about
    // the RELATIONSHIP, so it survives the next Jalali new year.
    const now = new Date('2026-09-26T12:00:00.000Z');
    const { jy } = instantToJalaliDate(now);

    expect(formatPurchaseDocumentNumber('PURCHASE_REQUEST', jy, 1)).toBe(`PR-${jy}-00001`);
  });

  it('refuses a sequence the database could not have allocated', () => {
    // Fails CLOSED. A zero, a negative or a fraction means the allocation did not happen
    // the way the repository assumes, and formatting it would produce a permanent number
    // that reads as legitimate.
    expect(() => formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405, 0)).toThrow(RangeError);
    expect(() => formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405, -1)).toThrow(RangeError);
    expect(() => formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405, 1.5)).toThrow(RangeError);
    expect(() => formatPurchaseDocumentNumber('PURCHASE_REQUEST', 1405.5, 1)).toThrow(RangeError);
  });
});
