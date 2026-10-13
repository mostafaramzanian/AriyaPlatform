import type { CalendarOccasion } from './calendar-api';

/**
 * Phase 49I-1: the SINGLE home of the Friday-vs-official-holiday rule.
 *
 * The 49I-1 contract requires this decision to live in ONE helper, not scattered
 * across components: a holiday is styled "special red" ONLY when it is a real
 * official holiday AND the day is NOT the weekly Friday closure. Friday must
 * keep its normal styling even when it coincides with an official holiday.
 *
 *  - `isFriday`      : is this day the weekly closure (weekday 6 = جمعه)?
 *  - `isSpecialRedHoliday` : official holiday present AND not Friday.
 */

export const FRIDAY_WEEKDAY = 6;

/** Weekly Friday closure check. Weekday index follows `CalendarDay.weekday` (0=شنبه). */
export function isFriday(weekday: number): boolean {
  return weekday === FRIDAY_WEEKDAY;
}

/**
 * Whether a day deserves the special red official-holiday treatment.
 *
 * `holiday = officialHoliday === true && jalaliWeekday !== FRIDAY`.
 *
 * The caller decides `isHolidayToday` from the DAY'S DATA (does any occasion on
 * that date carry `isHoliday`). This helper then applies the Friday exclusion —
 * it never looks up holiday names itself, so there is no client-side holiday map.
 */
export function isSpecialRedHoliday(weekday: number, isHolidayToday: boolean): boolean {
  return isHolidayToday && !isFriday(weekday);
}

/**
 * Whether at least one occasion on a day is an official holiday.
 *
 * Multi-occasion support: a day is a holiday if ANY of its occasions is one
 * (49I-1 "holiday status is true if at least one official occasion is a holiday").
 */
export function hasOfficialHoliday(occasions: Pick<CalendarOccasion, 'isHoliday'>[]): boolean {
  return occasions.some((o) => o.isHoliday);
}

/**
 * The single most important occasion of a day, for the "show the highest-priority
 * holiday/reason" cell rule. Prefers holidays; among them and among non-holidays,
 * the row with the highest `sortOrder` is the one the server already sorted first.
 */
export function primaryOccasion(
  occasions: Pick<CalendarOccasion, 'isHoliday' | 'title'>[],
): Pick<CalendarOccasion, 'isHoliday' | 'title'> | null {
  if (occasions.length === 0) return null;
  return occasions.find((o) => o.isHoliday) ?? occasions[0];
}
