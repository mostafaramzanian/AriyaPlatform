import {
  APP_TIME_ZONE,
  describeJalaliDay,
  formatJalaliDateKey,
  gregorianToJalali,
  instantToJalaliDate,
  instantToZonedTime,
  isJalaliLeapYear,
  isValidJalaliDate,
  jalaliDayRange,
  jalaliMonthLength,
  jalaliToGregorian,
  jalaliToday,
  jalaliWallTimeToInstant,
  jalaliWeekday,
  MAX_JALALI_YEAR,
  MIN_JALALI_YEAR,
  nextJalaliDay,
  parseJalaliDateKey,
  zoneOffsetMinutes,
} from './jalali.util';

/**
 * Phase 49I: conversion-boundary tests.
 *
 * The anchor values are checked against ICU itself rather than against numbers
 * written by hand: `Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn')` is an
 * independent implementation of the same calendar, so agreeing with it over a
 * multi-year sweep is real evidence and not a restatement of our own arithmetic.
 */

/** ICU's opinion of the Jalali date for an instant, as an oracle. */
function icuJalali(instant: Date, timeZone = APP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);

  return { jy: value('year'), jm: value('month'), jd: value('day') };
}

describe('jalali.util — calendar arithmetic', () => {
  it('agrees with ICU for every day across a four-year window including a leap year', () => {
    // 1403 is a Jalali leap year, so the window spans a 30-day Esfand and the
    // 1404/1405 boundaries around it.
    const from = Date.UTC(2024, 0, 1, 9); // 09:00 UTC = 12:30 Tehran, mid-day either way
    const to = Date.UTC(2027, 0, 1, 9);

    let checked = 0;

    for (let time = from; time < to; time += 86400000) {
      const instant = new Date(time);
      const expected = icuJalali(instant);
      const actual = instantToJalaliDate(instant);

      expect(actual).toEqual(expected);
      checked += 1;
    }

    expect(checked).toBeGreaterThan(1000);
  });

  it('round-trips Jalali → Gregorian → Jalali', () => {
    for (let jy = 1400; jy <= 1410; jy += 1) {
      for (let jm = 1; jm <= 12; jm += 1) {
        for (const jd of [1, 15, jalaliMonthLength(jy, jm)]) {
          const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
          expect(gregorianToJalali(gy, gm, gd)).toEqual({ jy, jm, jd });
        }
      }
    }
  });

  it('derives month lengths, including a 30-day Esfand only in leap years', () => {
    for (let jm = 1; jm <= 6; jm += 1) expect(jalaliMonthLength(1405, jm)).toBe(31);
    for (let jm = 7; jm <= 11; jm += 1) expect(jalaliMonthLength(1405, jm)).toBe(30);

    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(jalaliMonthLength(1403, 12)).toBe(30);

    expect(isJalaliLeapYear(1405)).toBe(false);
    expect(jalaliMonthLength(1405, 12)).toBe(29);
  });

  it('rejects impossible dates and dates outside the accepted window', () => {
    expect(isValidJalaliDate(1405, 12, 29)).toBe(true);
    expect(isValidJalaliDate(1405, 12, 30)).toBe(false); // 1405 is not a leap year
    expect(isValidJalaliDate(1403, 12, 30)).toBe(true);

    expect(isValidJalaliDate(1405, 7, 31)).toBe(false); // Mehr has 30 days
    expect(isValidJalaliDate(1405, 0, 1)).toBe(false);
    expect(isValidJalaliDate(1405, 13, 1)).toBe(false);
    expect(isValidJalaliDate(1405, 1, 0)).toBe(false);

    expect(isValidJalaliDate(MIN_JALALI_YEAR - 1, 1, 1)).toBe(false);
    expect(isValidJalaliDate(MAX_JALALI_YEAR + 1, 1, 1)).toBe(false);
    expect(isValidJalaliDate(1405.5, 1, 1)).toBe(false);
    expect(isValidJalaliDate(Number.NaN, 1, 1)).toBe(false);
  });

  it('names weekdays consistently with the Gregorian weekday', () => {
    // 1405/06/09 ⇄ 2026-08-31, a Monday → دوشنبه, index 2.
    expect(jalaliWeekday(1405, 6, 9)).toBe(2);
    expect(describeJalaliDay({ jy: 1405, jm: 6, jd: 9 })).toEqual({
      date: '1405/06/09',
      jy: 1405,
      jm: 6,
      jd: 9,
      monthName: 'شهریور',
      weekdayName: 'دوشنبه',
      weekday: 2,
    });
  });

  it('rolls to the next day across month and year boundaries', () => {
    expect(nextJalaliDay({ jy: 1405, jm: 6, jd: 9 })).toEqual({ jy: 1405, jm: 6, jd: 10 });
    expect(nextJalaliDay({ jy: 1405, jm: 6, jd: 31 })).toEqual({ jy: 1405, jm: 7, jd: 1 });
    expect(nextJalaliDay({ jy: 1405, jm: 12, jd: 29 })).toEqual({ jy: 1406, jm: 1, jd: 1 });
    expect(nextJalaliDay({ jy: 1403, jm: 12, jd: 29 })).toEqual({ jy: 1403, jm: 12, jd: 30 });
  });
});

describe('jalali.util — timezone boundary', () => {
  it('reads the zone offset from the tz database rather than a literal', () => {
    // Post-2022 Iran has no DST, so every instant currently resolves to +03:30 —
    // asserted as an OBSERVATION of the platform tz database, which is exactly
    // where the value must come from.
    const winter = new Date('2026-01-15T00:00:00Z');
    const summer = new Date('2026-07-15T00:00:00Z');

    expect(zoneOffsetMinutes(winter)).toBe(210);
    expect(zoneOffsetMinutes(summer)).toBe(210);

    // A zone that DOES observe DST must produce two different offsets, proving the
    // lookup is instant-dependent and not a constant in disguise.
    expect(zoneOffsetMinutes(winter, 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(summer, 'Europe/Berlin')).toBe(120);
  });

  it('never interprets a Jalali wall-clock reading as UTC', () => {
    // ۱۸ آبان ۱۴۰۵ ۱۴:۳۰ Tehran ⇄ 2026-11-09 → 14:30 − 03:30 = 11:00Z.
    const instant = jalaliWallTimeToInstant(1405, 8, 18, 14, 30);

    expect(instant.toISOString()).toBe('2026-11-09T11:00:00.000Z');

    // The naive (wrong) reading would have been 14:30Z. Asserting inequality keeps
    // the regression visible if the zone application is ever dropped.
    expect(instant.toISOString()).not.toBe('2026-11-09T14:30:00.000Z');
  });

  it('round-trips a wall-clock reading through the instant', () => {
    const cases: Array<[number, number, number, number, number]> = [
      [1405, 1, 1, 0, 0],
      [1405, 6, 9, 23, 59],
      [1405, 8, 18, 14, 30],
      [1403, 12, 30, 12, 0],
      [1406, 1, 1, 0, 1],
    ];

    for (const [jy, jm, jd, hour, minute] of cases) {
      const instant = jalaliWallTimeToInstant(jy, jm, jd, hour, minute);

      expect(instantToJalaliDate(instant)).toEqual({ jy, jm, jd });
      expect(instantToZonedTime(instant)).toEqual({ hour, minute });
    }
  });

  it('resolves a day boundary correctly rather than off by the offset', () => {
    // 00:00 Tehran is 20:30Z the PREVIOUS Gregorian day. A naive implementation
    // reports the previous Jalali day here.
    const midnight = jalaliWallTimeToInstant(1405, 6, 10, 0, 0);

    expect(midnight.toISOString()).toBe('2026-08-31T20:30:00.000Z');
    expect(instantToJalaliDate(midnight)).toEqual({ jy: 1405, jm: 6, jd: 10 });
  });

  it('produces a half-open day range aligned to Tehran midnight', () => {
    const { start, end } = jalaliDayRange({ jy: 1405, jm: 6, jd: 9 });

    expect(start.toISOString()).toBe('2026-08-30T20:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T20:30:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(86400000);

    // The last representable millisecond of the day is inside the range and the
    // first millisecond of the next day is not.
    expect(new Date(end.getTime() - 1) >= start).toBe(true);
    expect(new Date(end.getTime()) < end).toBe(false);
  });

  it('rolls the day range across a month boundary', () => {
    const { start, end } = jalaliDayRange({ jy: 1405, jm: 6, jd: 31 });

    expect(instantToJalaliDate(start)).toEqual({ jy: 1405, jm: 6, jd: 31 });
    expect(instantToJalaliDate(new Date(end.getTime()))).toEqual({ jy: 1405, jm: 7, jd: 1 });
    expect(end.getTime() - start.getTime()).toBe(86400000);
  });

  it('resolves today from the supplied clock, not the ambient process timezone', () => {
    // 20:15Z is already the NEXT Tehran day (23:45 local is 09 Shahrivar; 20:15Z
    // is 23:45 local). Both readings below are the same instant expressed twice.
    const beforeMidnightTehran = new Date('2026-08-31T20:14:00Z'); // 23:44 local
    const afterMidnightTehran = new Date('2026-08-31T20:31:00Z'); // 00:01 local, next day

    expect(jalaliToday(beforeMidnightTehran)).toEqual({ jy: 1405, jm: 6, jd: 9 });
    expect(jalaliToday(afterMidnightTehran)).toEqual({ jy: 1405, jm: 6, jd: 10 });
  });
});

describe('jalali.util — date query contract', () => {
  it('formats the wire key with Latin digits and fixed width', () => {
    expect(formatJalaliDateKey({ jy: 1405, jm: 6, jd: 9 })).toBe('1405/06/09');
    expect(formatJalaliDateKey({ jy: 1405, jm: 12, jd: 29 })).toBe('1405/12/29');
  });

  it('parses only a strict YYYY/MM/DD Latin-digit key', () => {
    expect(parseJalaliDateKey('1405/06/09')).toEqual({ jy: 1405, jm: 6, jd: 9 });
    expect(parseJalaliDateKey('  1405/06/09  ')).toEqual({ jy: 1405, jm: 6, jd: 9 });
  });

  it('refuses everything else instead of guessing', () => {
    const rejected = [
      '1405/6/9', // unpadded
      '1405-06-09', // wrong separator
      '۱۴۰۵/۰۶/۰۹', // Persian digits are a UI concern, not a wire format
      '1405/06/09T00:00', // not a date key
      '1405/13/01', // impossible month
      '1405/12/30', // impossible day in a non-leap year
      '2026/08/31', // Gregorian year is outside the Jalali window
      '0000/00/00',
      '',
      'today',
      null,
      undefined,
      1405,
      {},
      [],
    ];

    for (const value of rejected) {
      expect(parseJalaliDateKey(value as unknown)).toBeNull();
    }
  });

  it('accepts a leap-year Esfand 30 key', () => {
    expect(parseJalaliDateKey('1403/12/30')).toEqual({ jy: 1403, jm: 12, jd: 30 });
  });
});
