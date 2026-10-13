/**
 * Phase KPI-RUNTIME — the period resolver's own contract.
 *
 * WHY THESE ASSERTIONS ARE ARITHMETIC RATHER THAN STRINGS
 * -------------------------------------------------------
 * A Jalali month has 29, 30 or 31 days and Esfand is 29 or 30 depending on leapness, so the
 * only way to state a month's window WITHOUT encoding a second leap rule is to convert both
 * ends through the calendar module and check they land where they must. Every assertion here
 * therefore round-trips an instant back through `instantToJalaliDate`, or compares against a
 * neighbouring month's start — never against a hand-written Gregorian literal that would
 * bake an assumption about offsets or leap years into the test.
 */

import {
  instantToJalaliDate,
  isJalaliLeapYear,
  jalaliMonthLength,
} from '../../calendar/jalali.util';
import {
  KPI_PERIOD_BOUNDS,
  currentJalaliMonth,
  isValidKpiPeriod,
  kpiPeriodWindow,
  resolveKpiPeriod,
} from './kpi-runtime.period';

const DAY_MS = 86_400_000;

describe('KPI period — one Jalali month, half-open in UTC', () => {
  it('opens at the 1st of the month in the app zone and closes at the next month’s 1st', () => {
    const { start, end } = kpiPeriodWindow(1405, 8);

    expect(instantToJalaliDate(start)).toEqual({ jy: 1405, jm: 8, jd: 1 });
    expect(instantToJalaliDate(end)).toEqual({ jy: 1405, jm: 9, jd: 1 });
    expect(start.getTime()).toBeLessThan(end.getTime());
  });

  it('hands the next month a window that begins exactly where this one ends', () => {
    // Continuity is the property that prevents a row being counted twice or dropped between
    // two adjacent periods — the seam filters `[start, end)`, so a shared boundary instant
    // must belong to the LATER month and to that one only.
    const october = kpiPeriodWindow(1405, 8);
    const november = kpiPeriodWindow(1405, 9);

    expect(november.start.toISOString()).toBe(october.end.toISOString());
  });

  it('rolls the year at Esfand, not at month 13', () => {
    const esfand = kpiPeriodWindow(1405, 12);
    const farvardinNext = kpiPeriodWindow(1406, 1);

    expect(farvardinNext.start.toISOString()).toBe(esfand.end.toISOString());
    expect(instantToJalaliDate(esfand.end)).toEqual({ jy: 1406, jm: 1, jd: 1 });
  });

  it('derives Esfand’s length from leapness — 30 days in a leap year, 29 otherwise', () => {
    // The regression this guards: a "+30 days" shortcut would be wrong twice a year, and
    // wrong by a whole day of cohort rows — silently, in exactly the months a review reads.
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1405)).toBe(false);

    expect(
      kpiPeriodWindow(1403, 12).end.getTime() - kpiPeriodWindow(1403, 12).start.getTime()
    ).toBe(jalaliMonthLength(1403, 12) * DAY_MS);
    expect(
      kpiPeriodWindow(1405, 12).end.getTime() - kpiPeriodWindow(1405, 12).start.getTime()
    ).toBe(jalaliMonthLength(1405, 12) * DAY_MS);
  });

  it('is 31 days for the first six months and 30 for the next five', () => {
    for (let jm = 1; jm <= 6; jm += 1) {
      const { start, end } = kpiPeriodWindow(1405, jm);
      expect(end.getTime() - start.getTime()).toBe(31 * DAY_MS);
    }
    for (let jm = 7; jm <= 11; jm += 1) {
      const { start, end } = kpiPeriodWindow(1405, jm);
      expect(end.getTime() - start.getTime()).toBe(30 * DAY_MS);
    }
  });
});

describe('KPI period — the descriptor a result echoes back', () => {
  it('resolves an explicit month to the window the seam filters on', () => {
    const period = resolveKpiPeriod({ jy: 1405, jm: 8 });

    expect(period).toMatchObject({
      jy: 1405,
      jm: 8,
      monthName: 'آبان',
      timeZone: 'Asia/Tehran',
      calendar: 'JALALI',
    });
    // The bounds a screen shows are the bounds the query used — not a second derivation.
    expect(period.start).toBe(kpiPeriodWindow(1405, 8).start.toISOString());
    expect(period.end).toBe(kpiPeriodWindow(1405, 8).end.toISOString());
  });

  it('defaults only the parts the caller omitted', () => {
    const now = new Date('2026-10-06T12:00:00.000Z');
    const current = currentJalaliMonth(now);

    expect(resolveKpiPeriod({}, now)).toMatchObject(current);
    expect(resolveKpiPeriod({ jy: 1404 }, now).jm).toBe(current.jm);
    expect(resolveKpiPeriod({ jm: 3 }, now).jy).toBe(current.jy);
    // A caller that states neither still gets an explicit, echoable month — never "all time".
    expect(resolveKpiPeriod({}, now).start).not.toBe('');
    expect(resolveKpiPeriod({}, now).end).not.toBe('');
  });

  it('refuses a month the calendar itself would not accept', () => {
    expect(isValidKpiPeriod(1405, 8)).toBe(true);
    expect(isValidKpiPeriod(KPI_PERIOD_BOUNDS.minYear, 1)).toBe(true);
    expect(isValidKpiPeriod(KPI_PERIOD_BOUNDS.maxYear, 12)).toBe(true);

    expect(isValidKpiPeriod(KPI_PERIOD_BOUNDS.minYear - 1, 1)).toBe(false);
    expect(isValidKpiPeriod(KPI_PERIOD_BOUNDS.maxYear + 1, 12)).toBe(false);
    expect(isValidKpiPeriod(1405, 0)).toBe(false);
    expect(isValidKpiPeriod(1405, 13)).toBe(false);
    expect(isValidKpiPeriod(1405.5, 8)).toBe(false);
    expect(isValidKpiPeriod(Number.NaN, 8)).toBe(false);

    expect(() => resolveKpiPeriod({ jy: 1405, jm: 13 })).toThrow(/Invalid KPI period/);
    expect(() => resolveKpiPeriod({ jy: 999, jm: 1 })).toThrow(/Invalid KPI period/);
  });
});

describe('KPI period — completed vs partial, stated explicitly', () => {
  const NOW = new Date('2026-10-06T12:00:00.000Z');

  it('marks the CURRENT (unfinished) month incomplete and past months completed', () => {
    // Mehr 1405 is still running on 6 October; Shahrivar and Aban have both ended
    // relative to the same instant — one clock, one verdict per month.
    expect(resolveKpiPeriod({}, NOW).completed).toBe(false);
    expect(resolveKpiPeriod({ jy: 1405, jm: 6 }, NOW).completed).toBe(true);
    // Aban 1405 has not even started on 6 October — also not completed. The flag is
    // about whether the month ENDED, never about past-vs-future presentation.
    expect(resolveKpiPeriod({ jy: 1405, jm: 8 }, NOW).completed).toBe(false);
  });

  it('flips a month to completed the moment its end instant passes', () => {
    const end = kpiPeriodWindow(1405, 7).end;
    expect(resolveKpiPeriod({ jy: 1405, jm: 7 }, new Date(end.getTime() - 1)).completed).toBe(
      false
    );
    expect(resolveKpiPeriod({ jy: 1405, jm: 7 }, end).completed).toBe(true);
  });
});
