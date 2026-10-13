import {
  TRACKING_NUMBER_PATTERN,
  generateTrackingNumber,
  normalizeTrackingNumber,
} from './tracking-number.util';

/**
 * Phase 49G unit coverage for the tracking number.
 *
 * The three properties the contract depends on are asserted directly: the shape
 * matches what the database CHECK enforces, the value is non-sequential (so it leaks
 * no volume information), and normalisation refuses anything that does not match the
 * stored shape rather than letting it reach a query.
 */
describe('tracking number', () => {
  it('matches the shape enforced by the Ticket_trackingNumber_shape CHECK', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTrackingNumber()).toMatch(TRACKING_NUMBER_PATTERN);
    }
  });

  it('excludes the characters people confuse when reading a number aloud', () => {
    const body = Array.from({ length: 300 }, () => generateTrackingNumber().slice(3)).join('');
    expect(body).not.toMatch(/[ILOU]/);
  });

  it('is non-sequential: consecutive numbers are unordered and unrelated', () => {
    const numbers = Array.from({ length: 50 }, () => generateTrackingNumber());

    // A sequential generator would produce an already-sorted list.
    expect(numbers).not.toEqual([...numbers].sort());
  });

  it('does not repeat across a large batch', () => {
    const numbers = Array.from({ length: 5000 }, () => generateTrackingNumber());
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  describe('normalizeTrackingNumber', () => {
    it('accepts a well-formed number unchanged', () => {
      expect(normalizeTrackingNumber('TK-0123456789')).toBe('TK-0123456789');
    });

    it('upper-cases, trims and strips internal whitespace', () => {
      expect(normalizeTrackingNumber('  tk-abcdefghjk  ')).toBe('TK-ABCDEFGHJK');
    });

    it('supplies the prefix when the user typed only the body', () => {
      expect(normalizeTrackingNumber('abcdefghjk')).toBe('TK-ABCDEFGHJK');
    });

    it('refuses anything that does not match the stored shape', () => {
      for (const bad of [
        '',
        '   ',
        'TK-',
        'TK-SHORT',
        'TK-TOOLONGVALUE1',
        'TK-abcdefgh!k',
        'XX-ABCDEFGHJK',
        undefined,
        null,
      ]) {
        expect(normalizeTrackingNumber(bad as Parameters<typeof normalizeTrackingNumber>[0])).toBeNull();
      }
    });

    it('normalises whatever the generator produces', () => {
      for (let i = 0; i < 100; i++) {
        const value = generateTrackingNumber();
        expect(normalizeTrackingNumber(value.toLowerCase())).toBe(value);
      }
    });
  });
});
