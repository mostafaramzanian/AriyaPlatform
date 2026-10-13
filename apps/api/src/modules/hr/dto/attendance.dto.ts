import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import {
  HR_ISO_DATE_PATTERN,
  HR_ISO_INSTANT_PATTERN,
  HR_JALALI_DATE_KEY_PATTERN,
} from '../hr.constants';
import { HR_ATTENDANCE_SOURCES, HrAttendanceSource, HrPageQueryDto } from './hr-query.dto';

/**
 * Phase 51-HR-3: attendance DTOs — the punch register's request contract.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY DTO HERE
 * ----------------------------------------------
 *   * `tenantId` — resolved from the request context (`resolveHrActor`);
 *   * `updatedAt` and, on every write path, `source` — a database fact and a decision
 *     the SERVICE makes (`DEVICE` for a punch, `MANUAL` for a correction). A client
 *     that could choose `source` could label its own correction as evidence;
 *   * `workDate` and `dateKey` ON WRITE — DERIVED server-side from `clockIn` (§13), so
 *     a row can never claim a Gregorian or Jalali day that contradicts its own
 *     timestamp. This is why the write DTOs carry an instant and no calendar field at
 *     all;
 *   * `status`, `lateMinutes`, `overtimeMinutes`, `workedMinutes` — all derived, and
 *     deliberately not stored anywhere (see `prisma/hr/schema.prisma`).
 *
 * The global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`, so an
 * attempt to send any of the above is a 400 rather than a silently ignored field.
 */

/** Upper bound matching `varchar(500)` for a correction's reason in `hr_db`. */
export const MAX_ATTENDANCE_REASON_LENGTH = 500;

/**
 * Trims a correction's reason and — deliberately — does NOT collapse its interior
 * whitespace: the reason is a human sentence, and rewriting it would make the audit
 * payload differ from what the operator typed for no benefit. `@MinLength(1)` then
 * matches the TRIMMED value, so a reason of `"   "` is refused here rather than
 * written as an empty string that would satisfy the database's `IS NOT NULL` CHECK.
 */
export const TrimmedReason = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Opens a day: `POST /hr/attendance/clock-in`.
 *
 * `clockIn` IS OPTIONAL AND DEFAULTS TO THE SERVER'S `now`. That is the punch path: a
 * device or a kiosk reports "this person is here, now" and passes nothing. An explicit
 * instant is for an operator recording a punch that happened earlier (a broken
 * terminal), and it must carry its offset so the derived day is unambiguous
 * (`HR_ISO_INSTANT_PATTERN`).
 */
export class ClockInDto {
  /** The person the day belongs to. Must be an employee of the ACTOR's tenant. */
  @IsUUID('4')
  employeeId!: string;

  @IsOptional()
  @Matches(HR_ISO_INSTANT_PATTERN, {
    message:
      'clockIn must be an ISO-8601 instant with an explicit offset, e.g. 2026-09-18T08:00:00+03:30',
  })
  clockIn?: string;
}

/**
 * Closes an open day: `POST /hr/attendance/:id/clock-out`. The id is the route's, so
 * the body carries at most the instant.
 *
 * There is no `employeeId` here ON PURPOSE: the day is already identified by `:id`,
 * and accepting a second subject would create a request whose two halves could
 * disagree — the shape a tenancy or audit bug hides in.
 */
export class ClockOutDto {
  @IsOptional()
  @Matches(HR_ISO_INSTANT_PATTERN, {
    message:
      'clockOut must be an ISO-8601 instant with an explicit offset, e.g. 2026-09-18T17:00:00+03:30',
  })
  clockOut?: string;
}

/**
 * A MANUAL correction for one employee-day: `POST /hr/attendance/adjustments`.
 *
 * WHAT THIS WRITES, AND WHAT IT CANNOT: a row with `source = MANUAL` for the day
 * `clockIn` falls on. It never modifies the `DEVICE` row for that day — §13's rule,
 * made structural by `source` being part of the row's unique key (see the schema). A
 * repeated correction of the same day updates the ONE `MANUAL` row rather than
 * appending a second, so "what does the register say about this day" has one answer.
 *
 * `reason` IS REQUIRED. A correction without a stated reason is an unexplained edit
 * of somebody's working record, and the database refuses it too
 * (`Attendance_manual_reason_check`).
 */
export class AdjustAttendanceDto {
  @IsUUID('4')
  employeeId!: string;

  @Matches(HR_ISO_INSTANT_PATTERN, {
    message:
      'clockIn must be an ISO-8601 instant with an explicit offset, e.g. 2026-09-18T08:00:00+03:30',
  })
  clockIn!: string;

  @IsOptional()
  @Matches(HR_ISO_INSTANT_PATTERN, {
    message:
      'clockOut must be an ISO-8601 instant with an explicit offset, e.g. 2026-09-18T16:00:00+03:30',
  })
  clockOut?: string;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ATTENDANCE_REASON_LENGTH)
  reason!: string;
}

/**
 * The register filter.
 *
 * `from` / `to` are GREGORIAN `YYYY-MM-DD` days and are INCLUSIVE, because that is what
 * `work_date` stores and indexes: a range filter that had to convert a Jalali bound per
 * row could not use the index. `dateKey` is the Jalali DAY, for the day view, and is
 * converted ONCE (by `jalaliToGregorian`) into the same `from = to` range — so the two
 * spellings of "one day" cannot diverge, and the query is the same query.
 *
 * `dateKey` is refused in combination with `from`/`to` rather than silently winning:
 * two answers to "which days?" is exactly the ambiguity a register cannot afford.
 *
 * Every returned row carries the Jalali `dateKey` the SERVER derived, so a screen that
 * groups by Jalali month — or by Jalali year, which is how a fiscal question is asked —
 * groups on that value instead of a second client-side conversion that could disagree
 * with it.
 *
 * `search` matches the EMPLOYEE CODE of the row's employee (the same free-text question
 * the personnel list answers). It is implemented through a tenant-pinned relation,
 * never as a filter over a joined value the database cannot scope.
 */
export class ListAttendanceQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  /** Inclusive lower bound on `work_date`, Gregorian. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  /** Inclusive upper bound on `work_date`, Gregorian. Refused if it precedes `from`. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  /** One Jalali day, `YYYY/MM/DD`. The format is checked here, the date by the service. */
  @IsOptional()
  @Matches(HR_JALALI_DATE_KEY_PATTERN, {
    message: 'dateKey must be a Jalali YYYY/MM/DD date',
  })
  dateKey?: string;

  @IsOptional()
  @IsIn(HR_ATTENDANCE_SOURCES)
  source?: HrAttendanceSource;
}
