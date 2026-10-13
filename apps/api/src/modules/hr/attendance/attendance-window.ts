import { BadRequestException } from '@nestjs/common';
import { jalaliToGregorian, parseJalaliDateKey } from '../../../calendar/jalali.util';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the attendance register's calendar arithmetic,
 * extracted from `AttendanceService` VERBATIM so the register read and the Reporting read
 * share ONE implementation of «which days does this query mean?».
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `AttendanceService` owned `resolveDayBounds`/`parseGregorianDay` as private statics —
 * correct, but private. The personnel-traffic report needs exactly the same resolution
 * (the Jalali `dateKey` day and the Gregorian `from`/`to` pair both end as inclusive
 * `work_date` bounds), and a second copy inside the Reporting reader would be a second
 * opinion about the same question: the two would drift the first time a validation rule
 * changed, and a register and its own report could then disagree about which days they
 * describe. The service now DELEGATES to the functions below; its behaviour — including
 * every 400 message — is unchanged, which is what its existing spec keeps proving.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything about employees, sources, summaries, paging or
 * identity. This is the day-window arithmetic of ONE register, and nothing else.
 */

/** The day filters the register and the report both accept, as wire strings. */
export interface AttendanceDayWindowQuery {
  /** Inclusive Gregorian lower bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive Gregorian upper bound, `YYYY-MM-DD`. */
  to?: string;
  /** One Jalali day, `YYYY/MM/DD` — mutually exclusive with `from`/`to`. */
  dateKey?: string;
}

/** Inclusive `work_date` bounds resolved from the wire query. */
export interface AttendanceDayBounds {
  from?: Date;
  to?: Date;
}

/**
 * The register's day filter, resolved once.
 *
 * `dateKey` (a Jalali day) and `from`/`to` (Gregorian bounds) both end as the same
 * inclusive `work_date` bounds, so the day view and the range view cannot disagree.
 * Combining them is a 400 rather than a silent precedence rule: two answers to "which
 * days?" is exactly the ambiguity a register cannot afford.
 *
 * The FORMAT of each parameter is validated at the DTO boundary (`HR_ISO_DATE_PATTERN`
 * / `HR_JALALI_DATE_KEY_PATTERN`); this function validates the DATE ITSELF — a
 * well-shaped but impossible value (`2026-02-31`, `1405/13/45`) is refused here rather
 * than becoming a filter that silently matches nothing.
 */
export function resolveAttendanceDayBounds(query: AttendanceDayWindowQuery): AttendanceDayBounds {
  if (query.dateKey) {
    if (query.from || query.to) {
      throw new BadRequestException(
        'dateKey names one Jalali day and cannot be combined with from or to.'
      );
    }

    const jalali = parseJalaliDateKey(query.dateKey);
    if (!jalali) {
      throw new BadRequestException('dateKey must be a real Jalali date in YYYY/MM/DD form.');
    }

    const { gy, gm, gd } = jalaliToGregorian(jalali.jy, jalali.jm, jalali.jd);
    const day = new Date(Date.UTC(gy, gm - 1, gd));
    return { from: day, to: day };
  }

  const from = query.from ? parseAttendanceGregorianDay(query.from, 'from') : undefined;
  const to = query.to ? parseAttendanceGregorianDay(query.to, 'to') : undefined;

  if (from && to && to < from) {
    throw new BadRequestException('to must not precede from.');
  }

  return { from, to };
}

/** `YYYY-MM-DD` → the UTC midnight instant Prisma stores for a `@db.Date` column. */
export function parseAttendanceGregorianDay(value: string, field: string): Date {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) {
    throw new BadRequestException(`${field} must be a real YYYY-MM-DD date`);
  }
  return day;
}

/**
 * `YYYY-MM-DD` for a stored `@db.Date`, read back in UTC so the day never shifts.
 *
 * The wire view of a register day: a `@db.Date` column IS a calendar day, and emitting
 * its driver `Date` as `2026-09-18T00:00:00.000Z` would hand the caller a timestamp that
 * means "midnight UTC" to a reader in Tehran — the exact ambiguity the Jalali `dateKey`
 * exists to remove. One implementation, shared by the register's own boundary
 * serialization and the Reporting seam's projection.
 */
export function attendanceWorkDateKey(workDate: Date): string {
  return workDate.toISOString().slice(0, 10);
}
