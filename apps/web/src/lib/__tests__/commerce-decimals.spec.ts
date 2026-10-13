import {
  compareDecimal,
  decimalDisplayLabel,
  subtractDecimal,
  sumDecimals,
} from '../commerce-decimals';

/**
 * PHASE UI-2: the display-only decimal arithmetic. The rule these specs pin is the one the
 * UI-2 prompt states outright — NO floating-point business arithmetic on the client — so
 * `1250.0000 − 1250.0000` must be exactly zero and a fifth decimal must never be silently
 * rounded away.
 */
describe('commerce-decimals — exact string arithmetic', () => {
  it('subtracts exactly where float arithmetic would drift', () => {
    expect(subtractDecimal('0.3000', '0.1000')).toBe('0.2000');
    expect(subtractDecimal('1250.0000', '1250.0000')).toBe('0.0000');
    expect(subtractDecimal('10.0000', '4.5000')).toBe('5.5000');
    expect(subtractDecimal('4.5000', '10.0000')).toBe('-5.5000');
  });

  it('returns null — never a half-computed number — for anything unparseable', () => {
    expect(subtractDecimal('abc', '1.0000')).toBeNull();
    expect(subtractDecimal('1.0000', '1.00005')).toBeNull(); // 5th decimal that is not a zero
    expect(sumDecimals(['1.0000', 'x'])).toBeNull();
  });

  it('compares exactly and sums exactly', () => {
    expect(compareDecimal('0.0001', '0.0000')).toBe(1);
    expect(compareDecimal('1.0000', '1.0000')).toBe(0);
    expect(compareDecimal('0.9999', '1.0000')).toBe(-1);
    expect(sumDecimals(['1.0000', '2.5000', '-0.5000'])).toBe('3.0000');
    expect(sumDecimals([])).toBe('0.0000');
  });

  it('formats for display without re-rounding: grouping, Persian digits, no trailing zeros', () => {
    expect(decimalDisplayLabel('4.0000')).toBe('۴');
    expect(decimalDisplayLabel('1250.0000')).toBe('۱٬۲۵۰');
    expect(decimalDisplayLabel('1234.5600')).toBe('۱٬۲۳۴٫۵۶');
    expect(decimalDisplayLabel(null)).toBe('—');
    expect(decimalDisplayLabel('not-a-number')).toBe('not-a-number');
  });
});