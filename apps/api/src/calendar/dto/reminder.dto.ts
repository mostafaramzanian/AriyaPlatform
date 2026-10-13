import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Phase 49I: reminder write contracts.
 *
 * No DTO here carries a `userId`, `tenantId`, `dueAt`, `deliveredAt` or any
 * timezone field. The owner is the authenticated subject, the tenant is a snapshot
 * of that subject's tenant, `dueAt` is DERIVED server-side from the Jalali date +
 * time through `jalaliWallTimeToInstant`, and delivery state belongs exclusively to
 * the dispatcher. A client therefore cannot create a reminder for someone else, in
 * another tenant, already-delivered, or at an instant of its own choosing.
 *
 * The client sends a WALL-CLOCK reading, never an instant:
 *
 *   date: '1405/08/18'   (Jalali, Latin digits, strictly YYYY/MM/DD)
 *   time: '14:30'        (24h, omitted when allDay is true)
 *
 * `time` is deliberately NOT an ISO timestamp. Accepting one would let the client
 * decide the timezone interpretation, which is exactly the ambiguity this phase
 * exists to remove: `Asia/Tehran` is applied server-side and nowhere else.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so any
 * additional property is rejected rather than silently ignored.
 */

export const MAX_REMINDER_TITLE = 160;
export const MAX_REMINDER_NOTE = 1000;

/** `YYYY/MM/DD`, Latin digits. Semantic validity is checked by the service. */
const JALALI_DATE_PATTERN = /^\d{4}\/\d{2}\/\d{2}$/;

/** `HH:mm`, 24-hour, zero-padded. */
const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateReminderDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REMINDER_TITLE)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REMINDER_NOTE)
  note?: string;

  /**
   * Jalali day, `YYYY/MM/DD`. The shape is checked here; whether the day actually
   * exists (Esfand 30 in a non-leap year, month 13, …) is decided by
   * `parseJalaliDateKey` in the service, which owns the calendar.
   */
  @IsString()
  @Matches(JALALI_DATE_PATTERN, {
    message: 'date must be a Jalali date in YYYY/MM/DD form using Latin digits',
  })
  date!: string;

  /**
   * Wall-clock time in `Asia/Tehran`. Required unless `allDay` is true; supplying
   * both is refused by the service rather than silently ignored, so an all-day
   * reminder can never carry a half-honoured clock time.
   */
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_PATTERN, { message: 'time must be HH:mm in 24-hour form' })
  time?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  /** Defaults to true. A reminder created disabled is legal and simply never fires. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Partial update. Every field is optional, but the combination is still validated:
 * moving a delivered reminder forward re-arms it, and turning a timed reminder into
 * an all-day one must drop its clock time rather than keep a stale value.
 *
 * `note` accepts an explicit empty string to mean "clear the note"; the service
 * normalises that to NULL, so "no note" keeps exactly one representation.
 */
export class UpdateReminderDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REMINDER_TITLE)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MAX_REMINDER_NOTE)
  note?: string;

  @IsOptional()
  @IsString()
  @Matches(JALALI_DATE_PATTERN, {
    message: 'date must be a Jalali date in YYYY/MM/DD form using Latin digits',
  })
  date?: string;

  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_PATTERN, { message: 'time must be HH:mm in 24-hour form' })
  time?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Reminder list query.
 *
 * Two mutually exclusive modes, both bounded:
 *  - `date` → every reminder on that Jalali day (a day holds few reminders, so the
 *    day view is not paginated; it is bounded by the day itself).
 *  - no `date` → the UPCOMING list: `dueAt >= now`, ascending, `limit`-capped.
 *
 * There is no "all reminders ever" mode: an unbounded history read is exactly what
 * §19 of the contract forbids, so it has no query representation.
 */
export class ReminderQueryDto {
  @IsOptional()
  @IsString()
  @Matches(JALALI_DATE_PATTERN, {
    message: 'date must be a Jalali date in YYYY/MM/DD form using Latin digits',
  })
  date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /**
   * Include already-delivered reminders in the upcoming list. Off by default: the
   * upcoming view answers "what is still going to happen".
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includeDelivered?: boolean;
}

/**
 * Calendar month query. Bounded by construction: a month, not a range, so no
 * request can ask for an unbounded span.
 */
export class CalendarMonthQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1300)
  @Max(1500)
  jy!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  jm!: number;
}
