import { formatIsoDate, parseIsoDateValue, startsAfterPreviousStart } from './employment-interval';

/**
 * Phase 51-HR-ARCH-1B: the employment interval rules, tested WITHOUT Nest, WITHOUT a
 * database and WITHOUT a Prisma fake.
 *
 * These specs are the reason the rules were extracted: every assertion below is a rule
 * that used to be reachable only by standing up the whole service plus a fake Prisma
 * driver. The predicates themselves are unchanged, so this file is a second, cheaper
 * reader of the same truth — not a replacement for `employment.service.spec.ts`, which
 * still proves the HTTP mapping (400 vs 409 vs 404) through the real repository.
 */
describe('HR domain — employment interval', () => {
  describe('parseIsoDateValue', () => {
    const MIN_YEAR = 1900;

    it('reads a date-only string as the UTC midnight of that day', () => {
      const result = parseIsoDateValue('2026-03-01', MIN_YEAR);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.date.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      }
    });

    it('does not shift the day for a positive-offset timezone', () => {
      // The failure this guards against is `new Date('2026-03-01').getDate() === 28` on a
      // machine west of UTC. Reading the day back through `formatIsoDate` must round-trip.
      const result = parseIsoDateValue('2026-03-01', MIN_YEAR);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(formatIsoDate(result.date)).toBe('2026-03-01');
      }
    });

    it('reports `invalid-format` for a string that is not a date', () => {
      expect(parseIsoDateValue('2026-13-45', MIN_YEAR)).toEqual({
        ok: false,
        reason: 'invalid-format',
      });
      expect(parseIsoDateValue('01-03-2026', MIN_YEAR)).toEqual({
        ok: false,
        reason: 'invalid-format',
      });
      expect(parseIsoDateValue('not-a-date', MIN_YEAR)).toEqual({
        ok: false,
        reason: 'invalid-format',
      });
    });

    it('reports `before-min-year` only for a real date below the bound', () => {
      expect(parseIsoDateValue('1899-12-31', 1900)).toEqual({
        ok: false,
        reason: 'before-min-year',
      });
      expect(parseIsoDateValue('1900-01-01', 1900).ok).toBe(true);
    });

    it('prefers the format refusal over the year refusal', () => {
      // The shipped service test asserts the message for an unparseable string, so the
      // order of these two refusals is observable behaviour, not an implementation detail.
      expect(parseIsoDateValue('0000-99-99', 1900)).toEqual({
        ok: false,
        reason: 'invalid-format',
      });
    });
  });

  describe('formatIsoDate', () => {
    it('writes a date-only string and nothing else', () => {
      expect(formatIsoDate(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03-01');
    });

    it('returns null for an open interval boundary', () => {
      expect(formatIsoDate(null)).toBeNull();
      expect(formatIsoDate(undefined)).toBeNull();
    });
  });

  describe('startsAfterPreviousStart', () => {
    it('accepts a successor that starts strictly later', () => {
      expect(
        startsAfterPreviousStart(
          new Date('2026-04-01T00:00:00.000Z'),
          new Date('2026-03-01T00:00:00.000Z')
        )
      ).toBe(true);
    });

    it('rejects a successor that starts on the same day', () => {
      // The bug this encodes: the same start date is not a move, and it would produce a
      // zero-length interval in the history.
      const same = new Date('2026-03-01T00:00:00.000Z');
      expect(startsAfterPreviousStart(same, same)).toBe(false);
    });

    it('rejects a successor that starts before the previous interval began', () => {
      expect(
        startsAfterPreviousStart(
          new Date('2026-02-01T00:00:00.000Z'),
          new Date('2026-03-01T00:00:00.000Z')
        )
      ).toBe(false);
    });
  });
});
