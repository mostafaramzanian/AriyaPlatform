import {
  isFriday,
  isSpecialRedHoliday,
  hasOfficialHoliday,
  primaryOccasion,
} from '../calendar-occasions';

/**
 * Phase 49I-1 §FRIDAY LOGIC — the single home of the rule
 * `isSpecialRedHoliday = officialHoliday === true && jalaliWeekday !== FRIDAY`.
 *
 * These deterministically pin the four contract cases:
 *   Friday + holiday record        → NOT special-red (keeps Friday styling)
 *   non-Friday + holiday record    → special-red
 *   Friday + non-holiday occasion  → not special-red
 *   non-Friday + non-holiday occasion → not special-red
 */
describe('calendar-occasions FRIDAY LOGIC', () => {
  describe('isFriday', () => {
    it('identifies weekday 6 (جمعه) as Friday', () => {
      expect(isFriday(6)).toBe(true);
    });

    it('treats every other weekday as non-Friday', () => {
      for (let weekday = 0; weekday < 6; weekday += 1) {
        expect(isFriday(weekday)).toBe(false);
      }
    });
  });

  describe('isSpecialRedHoliday', () => {
    it('case #1 — Friday + holiday record: NOT special-red', () => {
      // A Friday that is also an official holiday keeps the normal Friday styling.
      expect(isSpecialRedHoliday(6, true)).toBe(false);
    });

    it('case #2 — non-Friday + holiday record: special-red', () => {
      // 1405/08/22 is a Thursday and an official holiday (شهادت حضرت فاطمه).
      expect(isSpecialRedHoliday(4, true)).toBe(true);
    });

    it('case #3 — Friday + non-holiday occasion: NOT special-red', () => {
      expect(isSpecialRedHoliday(6, false)).toBe(false);
    });

    it('case #4 — non-Friday + non-holiday occasion: NOT special-red', () => {
      expect(isSpecialRedHoliday(0, false)).toBe(false);
    });
  });

  describe('hasOfficialHoliday', () => {
    it('is true when at least one occasion on the day is a holiday', () => {
      expect(
        hasOfficialHoliday([
          { isHoliday: false },
          { isHoliday: true },
        ]),
      ).toBe(true);
    });

    it('is false when every occasion is non-holiday', () => {
      expect(
        hasOfficialHoliday([
          { isHoliday: false },
          { isHoliday: false },
        ]),
      ).toBe(false);
    });

    it('is false for an empty day', () => {
      expect(hasOfficialHoliday([])).toBe(false);
    });
  });

  describe('primaryOccasion', () => {
    it('prefers a holiday over a non-holiday on the same day', () => {
      expect(
        primaryOccasion([
          { isHoliday: false, title: 'یک مناسبت' },
          { isHoliday: true, title: 'یک تعطیلی' },
        ]),
      ).toMatchObject({ isHoliday: true, title: 'یک تعطیلی' });
    });

    it('returns the first row when there is no holiday', () => {
      expect(
        primaryOccasion([{ isHoliday: false, title: 'مناسبت اول' }]),
      ).toMatchObject({ title: 'مناسبت اول' });
    });

    it('returns null for an empty day', () => {
      expect(primaryOccasion([])).toBeNull();
    });
  });
});