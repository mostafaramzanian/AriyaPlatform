import { gregorianToJalali, jalaliMonthLength } from '../../calendar/jalali.util';
import { resolveLeaveLimitWindow, resolveLeaveLimitYearWindow } from './leave-policy-window';

/**
 * Phase 54-D (§16.2, D7): the period is resolved to an explicit window at CONFIGURATION time.
 *
 * WHAT THESE GATES PROTECT. The engine performs no calendar arithmetic (§34.3, D12), so whatever
 * this file computes is what the engine compares forever after. An off-by-one day here is an
 * off-by-one day in somebody's entitlement, and it would be invisible in the engine because the
 * engine only ever sees the two stored strings.
 *
 * So the assertions are ROUND-TRIPS AND BEST-EFFORT BOUNDARIES rather than literals copied from
 * a run: round-tripping through the platform's own Jalali util proves the window is the year it
 * claims to be, and comparing against the NEXT year's start proves `windowEnd` does not spill
 * over into Nowruz — the specific defect an assumed 30-day Esfand produces.
 */
describe('leave policy window resolution (§16.2, D7)', () => {
  describe('a Jalali YEAR — the tenant-visible year, resolved once', () => {
    it('starts on Farvardin 1 of that year, verified by round-trip', () => {
      const window = resolveLeaveLimitYearWindow(1404);
      const [gy, gm, gd] = window.start.split('-').map(Number);
      const back = gregorianToJalali(gy, gm, gd);

      expect({ jy: back.jy, jm: back.jm, jd: back.jd }).toEqual({ jy: 1404, jm: 1, jd: 1 });
    });

    it('ends on Esfand 29 or 30 — whichever that year actually has', () => {
      const window = resolveLeaveLimitYearWindow(1404);
      const [gy, gm, gd] = window.end.split('-').map(Number);
      const back = gregorianToJalali(gy, gm, gd);

      expect(back.jy).toBe(1404);
      expect(back.jm).toBe(12);
      expect(back.jd).toBe(jalaliMonthLength(1404, 12));
    });

    it('does NOT spill into the following year — the assumed-30-days defect', () => {
      // THE ASSERTION THAT CATCHES THE OFF-BY-ONE. `windowEnd + 1` must be exactly the next
      // year's Farvardin 1. If Esfand were assumed to be 30 days in a common year, the end would
      // land one day LATER than this, and this comparison is what fails.
      const window = resolveLeaveLimitYearWindow(1404);
      const nextYear = resolveLeaveLimitYearWindow(1405);

      expect(dayAfter(window.end)).toBe(nextYear.start);
    });

    it('is a genuine span of 365 or 366 days, never 360 or 370', () => {
      // A whole Jalali year is 365 days, or 366 in a leap year. Anything else means the two ends
      // were derived from different calendars or the leap derivation disagreed with itself.
      const window = resolveLeaveLimitYearWindow(1404);
      const days = daysBetween(window.start, window.end) + 1;

      expect([365, 366]).toContain(days);
    });

    it('holds for both a leap and a common year, so leapness is really derived', () => {
      // 1403 and 1404 straddle a leap boundary in the Jalali cycle; asserting one of each means
      // the Esfand derivation is exercised, not just the ordinary path.
      const leap = [1400, 1401, 1402, 1403, 1404, 1405, 1406, 1407].filter(
        (jy) => jalaliMonthLength(jy, 12) === 30
      );
      const common = [1400, 1401, 1402, 1403, 1404, 1405, 1406, 1407].filter(
        (jy) => jalaliMonthLength(jy, 12) === 29
      );

      expect(leap.length).toBeGreaterThan(0);
      expect(common.length).toBeGreaterThan(0);

      for (const jy of [...leap, ...common]) {
        const window = resolveLeaveLimitYearWindow(jy);
        const [gy, gm, gd] = window.end.split('-').map(Number);
        expect(gregorianToJalali(gy, gm, gd).jd).toBe(jalaliMonthLength(jy, 12));
      }
    });

    it('formats both days as zero-padded YYYY-MM-DD, the stored shape', () => {
      const window = resolveLeaveLimitYearWindow(1404);

      expect(window.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(window.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('orders the window so start <= end lexically, as text comparison requires', () => {
      // The engine compares these as STRINGS. A window whose start sorted after its end would
      // match nothing at all — silently, and with no error anywhere.
      const window = resolveLeaveLimitYearWindow(1404);

      expect(window.start <= window.end).toBe(true);
    });
  });

  describe('resolveLeaveLimitWindow — the declared period kind', () => {
    it('resolves YEAR to exactly the year window', () => {
      expect(resolveLeaveLimitWindow('YEAR', 1404)).toEqual(resolveLeaveLimitYearWindow(1404));
    });

    it('is deterministic: the same input yields the same window, always', () => {
      expect(resolveLeaveLimitWindow('YEAR', 1404)).toEqual(resolveLeaveLimitWindow('YEAR', 1404));
    });
  });
});

/** The calendar day after `day` (`YYYY-MM-DD`), computed in UTC so no zone can shift it. */
function dayAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));

  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `to`, inclusive-of-nothing (both parsed as UTC midnight). */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);

  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / (24 * 60 * 60 * 1000));
}
