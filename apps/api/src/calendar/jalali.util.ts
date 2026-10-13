/**
 * Phase 49I: the Jalali ⇄ instant conversion boundary.
 *
 * This file is the ONLY place in the Core backend that knows how a Persian
 * calendar date becomes a canonical timestamp, and it is deliberately explicit
 * about the two things that go wrong in every naive implementation:
 *
 *  1. A Jalali date string is NEVER an instant. `۱۸ آبان ۱۴۰۵ ۱۴:۳۰` is a WALL
 *     CLOCK reading in a zone; only after the zone is applied does it become a
 *     point on the timeline. `jalaliWallTimeToInstant` is that application, and
 *     it is the single function allowed to produce a `dueAt`.
 *  2. The zone offset is NOT a constant. Iran abolished DST in 2022, so today the
 *     offset happens to be +03:30 for every instant — but that is a fact about
 *     the current tz database, not an invariant. `zoneOffsetMinutes` therefore
 *     asks the platform tz database for the offset AT THAT INSTANT, via Intl, and
 *     nothing here ever writes `3.5`, `210` or `+03:30`.
 *
 * No new dependency is introduced: the arithmetic is the well-known Jalali
 * algorithm and the zone lookup is `Intl.DateTimeFormat`, which is available in
 * the pinned Node runtime with full ICU (verified: ICU 78 in both the host and
 * the api image). `date-fns@2` is already a dependency but has no Jalali or
 * IANA-zone support, so it cannot serve this boundary.
 */

/** The application's user-facing zone. Every wall-clock reading is in this zone. */
export const APP_TIME_ZONE = 'Asia/Tehran';

/**
 * Accepted Jalali year window for the API contract. Wide enough for any real
 * reminder, narrow enough that a malformed or overflowing number is rejected
 * rather than converted into a nonsense instant.
 */
export const MIN_JALALI_YEAR = 1300;
export const MAX_JALALI_YEAR = 1500;

/** Persian month names, in order. Presentation labels for the API contract. */
export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;

/** Persian weekday names, indexed by `jalaliWeekday()` (0 = شنبه). */
export const JALALI_WEEKDAYS = [
  'شنبه',
  'یکشنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
] as const;

export interface JalaliDate {
  /** Jalali year, e.g. 1405. */
  jy: number;
  /** Jalali month, 1-12. */
  jm: number;
  /** Jalali day of month, 1-31. */
  jd: number;
}

/** Integer division that truncates toward zero, as the source algorithm assumes. */
function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

/**
 * Gregorian → Jalali. Pure calendar arithmetic on a civil date: it carries no
 * time and no zone, so it must only ever be fed a date that was already resolved
 * in `APP_TIME_ZONE`.
 */
export function gregorianToJalali(gy: number, gm: number, gd: number): JalaliDate {
  const gDaysToMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;

  let days =
    355666 +
    365 * gy +
    div(gy2 + 3, 4) -
    div(gy2 + 99, 100) +
    div(gy2 + 399, 400) +
    gd +
    gDaysToMonth[gm - 1];

  let jy = -1595 + 33 * div(days, 12053);
  days %= 12053;

  jy += 4 * div(days, 1461);
  days %= 1461;

  if (days > 365) {
    jy += div(days - 1, 365);
    days = (days - 1) % 365;
  }

  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);

  return { jy, jm, jd };
}

/** Jalali → Gregorian civil date. Same contract as above: no time, no zone. */
export function jalaliToGregorian(
  jy: number,
  jm: number,
  jd: number,
): { gy: number; gm: number; gd: number } {
  const shiftedYear = jy + 1595;

  let days =
    -355668 +
    365 * shiftedYear +
    div(shiftedYear, 33) * 8 +
    div((shiftedYear % 33) + 3, 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);

  let gy = 400 * div(days, 146097);
  days %= 146097;

  if (days > 36524) {
    days -= 1;
    gy += 100 * div(days, 36524);
    days %= 36524;
    if (days >= 365) days += 1;
  }

  gy += 4 * div(days, 1461);
  days %= 1461;

  if (days > 365) {
    gy += div(days - 1, 365);
    days = (days - 1) % 365;
  }

  let gd = days + 1;
  const isLeap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthLengths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  let gm = 1;
  while (gm <= 12 && gd > monthLengths[gm - 1]) {
    gd -= monthLengths[gm - 1];
    gm += 1;
  }

  return { gy, gm, gd };
}

/**
 * Length of a Jalali month. Esfand is 29 or 30 days, and rather than encode a
 * separate leap rule (a second source of truth that could disagree with the
 * conversion above) leapness is DERIVED: Esfand 30 exists exactly when it
 * round-trips back to itself.
 */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;

  const { gy, gm, gd } = jalaliToGregorian(jy, 12, 30);
  const back = gregorianToJalali(gy, gm, gd);

  return back.jy === jy && back.jm === 12 && back.jd === 30 ? 30 : 29;
}

export function isJalaliLeapYear(jy: number): boolean {
  return jalaliMonthLength(jy, 12) === 30;
}

/** True when (jy, jm, jd) is a real Jalali date inside the accepted window. */
export function isValidJalaliDate(jy: number, jm: number, jd: number): boolean {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return false;
  if (jy < MIN_JALALI_YEAR || jy > MAX_JALALI_YEAR) return false;
  if (jm < 1 || jm > 12) return false;

  return jd >= 1 && jd <= jalaliMonthLength(jy, jm);
}

interface ZonedWallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Formatter cache. `Intl.DateTimeFormat` construction is the expensive part and
 * the reminder dispatcher calls into this module on every tick, so a formatter is
 * built at most once per zone.
 */
const wallTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function wallTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = wallTimeFormatters.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  wallTimeFormatters.set(timeZone, formatter);
  return formatter;
}

/** Reads the wall-clock fields an instant shows in `timeZone`. */
function zonedWallTime(instant: Date, timeZone: string = APP_TIME_ZONE): ZonedWallTime {
  const parts = wallTimeFormatter(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

/**
 * Offset of `timeZone` from UTC, in minutes, AT `instant`. Derived from the
 * platform tz database — never a literal. A positive value means ahead of UTC.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string = APP_TIME_ZONE): number {
  const wall = zonedWallTime(instant, timeZone);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );

  // Both sides are truncated to whole seconds so the sub-second remainder of
  // `instant` cannot leak into the offset.
  return (asIfUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000;
}

/**
 * Turns a Gregorian wall-clock reading in `timeZone` into an instant.
 *
 * The offset depends on the instant, and the instant is what we are solving for,
 * so this guesses once with the offset that applies at the naive UTC reading and
 * then corrects with the offset that actually applies at the candidate. One
 * correction is sufficient for every real zone rule: offsets shift by at most a
 * couple of hours, far less than the granularity that would need a second pass.
 */
export function zonedWallTimeToInstant(
  gy: number,
  gm: number,
  gd: number,
  hour: number,
  minute: number,
  timeZone: string = APP_TIME_ZONE,
): Date {
  const naiveUtc = Date.UTC(gy, gm - 1, gd, hour, minute, 0, 0);

  const firstOffset = zoneOffsetMinutes(new Date(naiveUtc), timeZone);
  const candidate = new Date(naiveUtc - firstOffset * 60000);

  const secondOffset = zoneOffsetMinutes(candidate, timeZone);
  if (secondOffset === firstOffset) return candidate;

  return new Date(naiveUtc - secondOffset * 60000);
}

/**
 * The single authorised way to produce a canonical timestamp from a Jalali date
 * plus a wall-clock time. Every reminder `dueAt` in this phase comes from here.
 */
export function jalaliWallTimeToInstant(
  jy: number,
  jm: number,
  jd: number,
  hour: number,
  minute: number,
  timeZone: string = APP_TIME_ZONE,
): Date {
  const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
  return zonedWallTimeToInstant(gy, gm, gd, hour, minute, timeZone);
}

/** The Jalali civil date an instant falls on, in `timeZone`. */
export function instantToJalaliDate(instant: Date, timeZone: string = APP_TIME_ZONE): JalaliDate {
  const wall = zonedWallTime(instant, timeZone);
  return gregorianToJalali(wall.year, wall.month, wall.day);
}

/** Wall-clock hour/minute an instant shows in `timeZone`. */
export function instantToZonedTime(
  instant: Date,
  timeZone: string = APP_TIME_ZONE,
): { hour: number; minute: number } {
  const wall = zonedWallTime(instant, timeZone);
  return { hour: wall.hour, minute: wall.minute };
}

/**
 * Weekday index of a Jalali date, 0 = شنبه … 6 = جمعه.
 *
 * Computed from the Gregorian equivalent at UTC noon: the date is a civil date
 * with no zone, and noon keeps it clear of any offset that could roll it into a
 * neighbouring day.
 */
export function jalaliWeekday(jy: number, jm: number, jd: number): number {
  const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
  const dayOfWeek = new Date(Date.UTC(gy, gm - 1, gd, 12)).getUTCDay(); // 0 = Sunday

  return (dayOfWeek + 1) % 7;
}

/** `YYYY/MM/DD`, Latin digits — the wire format of the date query contract. */
export function formatJalaliDateKey(date: JalaliDate): string {
  const month = String(date.jm).padStart(2, '0');
  const day = String(date.jd).padStart(2, '0');

  return `${date.jy}/${month}/${day}`;
}

/**
 * Strict parser for the `YYYY/MM/DD` wire format.
 *
 * Deliberately unforgiving: Latin digits only, exactly four/two/two digits, and
 * the result must be a real Jalali date. Returns null instead of throwing so the
 * caller decides the HTTP shape of the failure. Persian digits are NOT accepted at
 * the API boundary — presentation digits belong to the UI, and accepting both
 * would create two spellings of the same key.
 */
export function parseJalaliDateKey(value: unknown): JalaliDate | null {
  if (typeof value !== 'string') return null;

  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const jy = Number(match[1]);
  const jm = Number(match[2]);
  const jd = Number(match[3]);

  return isValidJalaliDate(jy, jm, jd) ? { jy, jm, jd } : null;
}

/** The Jalali day that follows `date`. Rolls month and year. */
export function nextJalaliDay(date: JalaliDate): JalaliDate {
  if (date.jd < jalaliMonthLength(date.jy, date.jm)) {
    return { jy: date.jy, jm: date.jm, jd: date.jd + 1 };
  }

  return date.jm < 12
    ? { jy: date.jy, jm: date.jm + 1, jd: 1 }
    : { jy: date.jy + 1, jm: 1, jd: 1 };
}

/**
 * Half-open instant range `[start, end)` covering one Jalali day in `timeZone`.
 *
 * Half-open on purpose: a closed range would either double-count or drop the
 * final millisecond of the day, and "next day at 00:00" is exactly what an
 * indexed `dueAt >= start AND dueAt < end` scan wants.
 */
export function jalaliDayRange(
  date: JalaliDate,
  timeZone: string = APP_TIME_ZONE,
): { start: Date; end: Date } {
  const next = nextJalaliDay(date);

  return {
    start: jalaliWallTimeToInstant(date.jy, date.jm, date.jd, 0, 0, timeZone),
    end: jalaliWallTimeToInstant(next.jy, next.jm, next.jd, 0, 0, timeZone),
  };
}

export interface JalaliDayDescriptor {
  /** `YYYY/MM/DD`, Latin digits. The stable key clients pass back. */
  date: string;
  jy: number;
  jm: number;
  jd: number;
  /** Persian month name. */
  monthName: string;
  /** Persian weekday name. */
  weekdayName: string;
  /** 0 = شنبه … 6 = جمعه. */
  weekday: number;
}

/** Server-authoritative description of a Jalali day, ready for the wire. */
export function describeJalaliDay(date: JalaliDate): JalaliDayDescriptor {
  const weekday = jalaliWeekday(date.jy, date.jm, date.jd);

  return {
    date: formatJalaliDateKey(date),
    jy: date.jy,
    jm: date.jm,
    jd: date.jd,
    monthName: JALALI_MONTHS[date.jm - 1],
    weekdayName: JALALI_WEEKDAYS[weekday],
    weekday,
  };
}

/**
 * "Today" in `APP_TIME_ZONE`, resolved from the supplied instant.
 *
 * The clock is a parameter so the dispatcher and the tests can pass a controlled
 * instant, and so nothing here reads the ambient process timezone — `TZ` is empty
 * in the api container (verified), which is precisely why the zone must be named
 * explicitly rather than inherited.
 */
export function jalaliToday(now: Date = new Date(), timeZone: string = APP_TIME_ZONE): JalaliDate {
  return instantToJalaliDate(now, timeZone);
}
