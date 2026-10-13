import {
  PURCHASE_MAX_MONEY_AMOUNT,
  PURCHASE_MONEY_PRECISION,
  PURCHASE_MONEY_SCALE,
  addMoney,
  compareMoney,
  moneyFromNumber,
  multiplyMoney,
  negateMoney,
  sumMoney,
} from './purchase-money';

/**
 * Phase C1 Step L (§5.1, §5.2): the exact money arithmetic a purchase document's stored
 * totals are computed with.
 *
 * WHAT IS ACTUALLY BEING PINNED
 * ----------------------------
 * Not "the function returns a number". The claim is that a document's stored
 * `subtotalAmount` / `taxAmount` / `totalAmount` and every line's `lineTotal` are the
 * EXACT decimals its own numbers imply — so the assertions below are written as literal
 * decimal strings (`'0.3000'`, not `0.3`), because the failure this file exists to
 * prevent is precisely `0.1 + 0.2 === 0.30000000000000004` becoming a stored fact.
 *
 * The refusals are pinned too, and they are half the contract: a value outside
 * `DECIMAL(18,4)` must raise HERE rather than reach Postgres and come back as a driver
 * error, and a non-finite operand must never be silently treated as zero.
 */

describe('Phase C1 Step L — money over Decimal(18,4)', () => {
  it('keeps the storage domain in two constants that agree with the schema', () => {
    expect({ scale: PURCHASE_MONEY_SCALE, precision: PURCHASE_MONEY_PRECISION }).toEqual({
      scale: 4,
      precision: 18,
    });
  });

  it('states a bound the arithmetic itself accepts, and refuses one unit above it', () => {
    // This is the claim the DTO leans on: `@Max(PURCHASE_MAX_MONEY_AMOUNT)` admits a
    // value `moneyFromNumber` can store. A bound one unit higher (10^14) is refused by
    // `parseScaled` — which is why the bound is NOT written as the column's literal
    // maximum: its nearest double IS 10^14, so that bound would 500 at its own edge.
    expect(PURCHASE_MAX_MONEY_AMOUNT).toBe(10 ** 14 - 1);
    expect(moneyFromNumber(PURCHASE_MAX_MONEY_AMOUNT)).toBe('99999999999999.0000');
    expect(() => moneyFromNumber(PURCHASE_MAX_MONEY_AMOUNT + 1)).toThrow(RangeError);
    expect(10 ** 14 - 10 ** -4).toBe(10 ** 14);
  });
});

describe('Phase C1 Step L — exact arithmetic', () => {
  it('computes 0.1 × 3 exactly, where a JavaScript number would not', () => {
    expect(0.1 * 3).not.toBe(0.3);
    expect(multiplyMoney(0.1, 3)).toBe('0.3000');
  });

  it('adds 0.1 + 0.2 exactly, where a JavaScript number would not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addMoney('0.1', '0.2')).toBe('0.3000');
  });

  it('renders every result in the column’s scale, zero-padded on both sides', () => {
    expect(moneyFromNumber(0)).toBe('0.0000');
    expect(moneyFromNumber(1)).toBe('1.0000');
    expect(moneyFromNumber(1.5)).toBe('1.5000');
    expect(moneyFromNumber(0.1234)).toBe('0.1234');
  });

  it('rounds a value below the column’s scale to zero rather than inventing a digit', () => {
    // Exponent notation from `Number.prototype.toString`, and inside the domain after
    // rounding: `1e-7` is smaller than the fourth decimal, so it is 0.0000 — a column
    // that cannot hold 0.0000001 must not be handed one.
    expect(moneyFromNumber(1e-7)).toBe('0.0000');
    expect(moneyFromNumber(2.5e-7)).toBe('0.0000');
    expect(moneyFromNumber(1e-5)).toBe('0.0000');
    expect(moneyFromNumber(1e-4)).toBe('0.0001');
  });

  it('rounds HALF-UP at the fourth decimal, stated once and applied everywhere', () => {
    // 0.00005 is exactly half of the last representable digit, so it rounds AWAY from
    // zero. The value is reached through the shortest round-trip decimal text, which is
    // what makes the assertion stable rather than dependent on binary representation.
    expect(moneyFromNumber(0.00005)).toBe('0.0001');
    expect(moneyFromNumber(0.00004)).toBe('0.0000');
    expect(moneyFromNumber(1.000049)).toBe('1.0000');
  });

  it('accepts a positive-exponent operand, where the digits are what decide, not the text', () => {
    // `1e21` is exponent notation AND outside the domain: the range check runs on the
    // parsed digits, so it is refused rather than mis-parsed into a huge amount.
    expect(() => moneyFromNumber(1e21)).toThrow(RangeError);
    // And an exponent notation value INSIDE the domain parses exactly.
    expect(moneyFromNumber(1.5e3)).toBe('1500.0000');
  });

  it('multiplies two four-decimal operands and keeps the scale, not the eight digits', () => {
    // 1.2345 × 2.0000 = 2.4690 exactly; the intermediate carries eight fractional digits,
    // which is why the rounding happens here rather than in a caller.
    expect(multiplyMoney(1.2345, 2)).toBe('2.4690');
    expect(multiplyMoney(0.3333, 3)).toBe('0.9999');
    // EACH OPERAND IS QUANTIZED TO THE COLUMN'S SCALE FIRST, exactly as Postgres multiplies
    // two `Decimal(18,4)` values: 0.33335 is stored as 0.3334, and × 3 is 1.0002 — not the
    // 1.0001 that multiplying the unrounded decimals would give.
    expect(moneyFromNumber(0.33335)).toBe('0.3334');
    expect(multiplyMoney(0.33335, 3)).toBe('1.0002');
  });

  it('sums a document’s lines exactly, in the order they were written', () => {
    expect(sumMoney(['0.1', '0.2', '0.3'])).toBe('0.6000');
    expect(sumMoney(['1.0001', '2.0002', '3.0003'])).toBe('6.0006');
  });

  it('sums an empty set to zero, which is a statement only a total may make', () => {
    // `computeDocumentTotals` (the service) refuses to derive totals from zero lines;
    // this is the arithmetic's own answer, and the two rules are deliberately separate.
    expect(sumMoney([])).toBe('0.0000');
  });
});

describe('Phase C1 Step L — refusals', () => {
  it('refuses a value outside Decimal(18,4) instead of clamping it', () => {
    // Silently clamping would store a number nobody wrote, in the one column a dispute
    // is argued from.
    expect(() => moneyFromNumber(10 ** 15)).toThrow(RangeError);
    expect(() => sumMoney(['99999999999999.9999', '0.0001'])).toThrow(RangeError);
  });

  it('refuses a non-finite operand rather than treating it as zero', () => {
    expect(() => moneyFromNumber(Number.NaN)).toThrow(RangeError);
    expect(() => moneyFromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => multiplyMoney(Number.NaN, 1)).toThrow(RangeError);
    expect(() => multiplyMoney(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('names the offending value in the error, because these reach a log and nobody else', () => {
    expect(() => moneyFromNumber(Number.NaN, 'quantity')).toThrow(/quantity/);
  });
});

describe('Phase C1 Step Q — compareMoney and negateMoney (contract §3-C)', () => {
  it('compares two Decimal(18,4) strings exactly, across representations', () => {
    expect(compareMoney('26.2500', '26.2500')).toBe(0);
    // The SAME amount written at either scale is equal — integer equality on the
    // scaled domain, so `26.25` can never be a hair above `26.2500`.
    expect(compareMoney('26.25', '26.2500')).toBe(0);
    expect(compareMoney('26.2499', '26.2500')).toBe(-1);
    expect(compareMoney('26.2501', '26.2500')).toBe(1);
  });

  it('is the projection’s rule engine: exact sums, never float and never a tolerance', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; as exact money the sum is 0.3000 and
    // the projection answers PAID against a 0.3000 total rather than PARTIAL.
    expect(compareMoney(sumMoney(['0.1', '0.2']), '0.3000')).toBe(0);
    expect(compareMoney('0.2999', '0.3000')).toBe(-1);
    expect(compareMoney('0.3001', '0.3000')).toBe(1);
  });

  it('negates bit-for-bit: the same magnitude, the opposite sign', () => {
    // The compensating row's amount (§5.14, Q4) — the pair must sum to zero exactly.
    expect(negateMoney('26.2500')).toBe('-26.2500');
    expect(negateMoney('-26.2500')).toBe('26.2500');
    expect(negateMoney('0.0001')).toBe('-0.0001');
    expect(negateMoney(negateMoney('0.0001'))).toBe('0.0001');
    expect(compareMoney(negateMoney('70.0000'), '-70.0000')).toBe(0);
  });

  it('normalises the negation of zero — the column cannot hold a signed zero', () => {
    expect(negateMoney('0.0000')).toBe('0.0000');
    expect(negateMoney('0')).toBe('0.0000');
    expect(negateMoney('-0.0000')).toBe('0.0000');
  });

  it('refuses what cannot be stored, in both directions', () => {
    expect(() => compareMoney('not a number', '1.0000')).toThrow(RangeError);
    expect(() => compareMoney('1.0000', 'also not')).toThrow(RangeError);
    expect(() => negateMoney('100000000000000.0000')).toThrow(RangeError);
  });
});
