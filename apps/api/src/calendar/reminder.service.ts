import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OccasionCategory, Prisma } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import {
  APP_TIME_ZONE,
  describeJalaliDay,
  formatJalaliDateKey,
  instantToJalaliDate,
  instantToZonedTime,
  jalaliDayRange,
  jalaliMonthLength,
  jalaliToday,
  jalaliWallTimeToInstant,
  parseJalaliDateKey,
  type JalaliDate,
  type JalaliDayDescriptor,
} from './jalali.util';
import {
  CalendarMonthQueryDto,
  CreateReminderDto,
  ReminderQueryDto,
  UpdateReminderDto,
} from './dto/reminder.dto';

/**
 * Phase 49I: personal reminders.
 *
 * Scope is USER-OWNED + TENANT CONTEXT, resolved from RequestContextService exactly
 * as DirectoryService (49D-1), NotificationService (49E), MessagingService (49F),
 * SupportService (49G) and SurveysService (49H) do. Every read and write is keyed on
 * the authenticated owner — never on a body field, query parameter or path segment —
 * so no route can reach another user's reminder, and a reminder in another tenant is
 * indistinguishable from one that does not exist.
 *
 * There is NO permission gate. Keeping one's own reminders is an ordinary
 * authenticated-user capability; ownership is the authorization edge.
 *
 * `dueAt` is produced in exactly one place (`resolveDueAt` → `jalaliWallTimeToInstant`)
 * and nothing here ever parses a client-supplied timestamp.
 */

export const DEFAULT_REMINDER_LIMIT = 20;
export const MAX_REMINDER_LIMIT = 100;

/** Notification metadata for a fired reminder. Shared with the dispatcher. */
export const REMINDER_SOURCE_TYPE = 'calendar.reminder';

/**
 * Allowlisted projection. `userId`/`tenantId` are deliberately absent: the owner is
 * always the caller, and the tenant is internal isolation metadata that must never
 * reach the browser.
 */
const REMINDER_SELECT = {
  id: true,
  title: true,
  note: true,
  dueAt: true,
  allDay: true,
  enabled: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReminderSelect;

type ReminderRow = Prisma.ReminderGetPayload<{ select: typeof REMINDER_SELECT }>;

export interface ReminderDto {
  id: string;
  title: string;
  note: string | null;
  /** Canonical instant. The client displays the Jalali fields below instead. */
  dueAt: Date;
  /** Server-derived Jalali day of `dueAt`, in Asia/Tehran. */
  date: string;
  /** Server-derived wall-clock `HH:mm` in Asia/Tehran. Null for an all-day reminder. */
  time: string | null;
  allDay: boolean;
  enabled: boolean;
  /** Non-null once the dispatcher has created the notification. */
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Alias so the DTO surface reads naturally and stays in step with the enum. */
export type OCCASION_CATEGORY_LITERALS = `${OccasionCategory}`;

export interface ReminderListResult {
  items: ReminderDto[];
  hasMore: boolean;
}

export interface ReminderDayResult {
  day: JalaliDayDescriptor;
  items: ReminderDto[];
}

/**
 * One official occasion/holiday as projected for the month view (Phase 49I-1).
 *
 * `id` is deliberately NOT included: the Jalali date is the public identity, and
 * exposing the internal database identifier serves nobody. `sourceYear` is kept
 * so a client can distinguish rows of the published 1405 dataset from a future
 * year's correction without leaking the full provenance string on every row.
 */
export interface CalendarOccasionDto {
  /** `YYYY/MM/DD`, Latin digits — the same wire form a reminder's `date` uses. */
  date: string;
  title: string;
  description: string | null;
  isHoliday: boolean;
  category: OCCASION_CATEGORY_LITERALS;
  sourceYear: number;
}

interface Scope {
  userId: string;
  tenantId: string | null;
}

@Injectable()
export class ReminderService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the caller's own scope and asserts it matches the subject the
   * controller passed in. A mismatch is refused rather than trusting the argument.
   */
  private scope(userId: string): Scope {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Reminder context is required');
    }

    return { userId, tenantId: context.tenantId ?? null };
  }

  /**
   * The single ownership predicate for every read and write.
   *
   * Tenant is always part of it, including when it is null: dropping a null tenant
   * would silently widen the query to every tenant-less reminder in the database.
   */
  private ownership(scope: Scope): Prisma.ReminderWhereInput {
    return { userId: scope.userId, tenantId: scope.tenantId };
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? DEFAULT_REMINDER_LIMIT, 1), MAX_REMINDER_LIMIT);
  }

  /** Strictly parses a `YYYY/MM/DD` Jalali key or refuses with 400. */
  private requireJalaliDate(value: string, field = 'date'): JalaliDate {
    const parsed = parseJalaliDateKey(value);

    if (!parsed) {
      throw new BadRequestException(
        `${field} must be a valid Jalali date in YYYY/MM/DD form using Latin digits`,
      );
    }

    return parsed;
  }

  /** Splits a validated `HH:mm` into numbers. The pattern is enforced by the DTO. */
  private parseWallClock(value: string): { hour: number; minute: number } {
    const [hour, minute] = value.split(':').map(Number);
    return { hour, minute };
  }

  /**
   * THE conversion boundary for writes.
   *
   * Turns the client's wall-clock reading into the canonical instant, and applies the
   * two validation rules the contract asks for explicitly:
   *
   *  - all-day and a clock time are mutually exclusive. Sending both is refused
   *    rather than silently dropping one, so the stored row can never disagree with
   *    what the user submitted.
   *  - a TIMED reminder in the past is REJECTED (the contract's preferred option A).
   *    An ALL-DAY reminder is judged at day granularity — "today, all day" is still
   *    meaningful at 14:00 — so it is rejected only once the whole day has passed.
   */
  private resolveDueAt(
    date: JalaliDate,
    time: string | undefined,
    allDay: boolean,
    now: Date,
  ): Date {
    if (allDay && time !== undefined) {
      throw new BadRequestException('An all-day reminder cannot carry a time');
    }

    if (!allDay && time === undefined) {
      throw new BadRequestException('time is required unless the reminder is all-day');
    }

    if (allDay) {
      // Day-level anchor: the start of that Jalali day in Asia/Tehran.
      const { start, end } = jalaliDayRange(date, APP_TIME_ZONE);

      if (end.getTime() <= now.getTime()) {
        throw new BadRequestException('An all-day reminder cannot be created for a past day');
      }

      return start;
    }

    const { hour, minute } = this.parseWallClock(time as string);
    const dueAt = jalaliWallTimeToInstant(date.jy, date.jm, date.jd, hour, minute, APP_TIME_ZONE);

    if (dueAt.getTime() <= now.getTime()) {
      throw new BadRequestException('A reminder cannot be created for a past moment');
    }

    return dueAt;
  }

  /**
   * Projects a row for the wire, re-deriving the Jalali day and wall-clock time from
   * the canonical instant.
   *
   * Re-deriving rather than storing them is the point: there is one authoritative
   * value, so a display field can never drift out of agreement with the schedule.
   */
  private project(row: ReminderRow): ReminderDto {
    const jalali = instantToJalaliDate(row.dueAt, APP_TIME_ZONE);
    const { hour, minute } = instantToZonedTime(row.dueAt, APP_TIME_ZONE);

    return {
      id: row.id,
      title: row.title,
      note: row.note,
      dueAt: row.dueAt,
      date: formatJalaliDateKey(jalali),
      time: row.allDay
        ? null
        : `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      allDay: row.allDay,
      enabled: row.enabled,
      deliveredAt: row.deliveredAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Loads a reminder the caller owns, or throws 404. */
  private async requireOwned(scope: Scope, id: string): Promise<ReminderRow> {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, ...this.ownership(scope) },
      select: REMINDER_SELECT,
    });

    if (!reminder) {
      // Someone else's reminder and a non-existent one are indistinguishable, so
      // ids cannot be probed.
      throw new NotFoundException('Reminder not found');
    }

    return reminder;
  }

  /**
   * Creates a reminder for the authenticated owner.
   *
   * The tenant is snapshotted from the caller's request context, not from the body —
   * there is no body field for it — so a reminder can never be planted in another
   * tenant.
   */
  async createReminder(
    userId: string,
    dto: CreateReminderDto,
    now: Date = new Date(),
  ): Promise<ReminderDto> {
    const scope = this.scope(userId);
    const date = this.requireJalaliDate(dto.date);
    const allDay = dto.allDay ?? false;
    const dueAt = this.resolveDueAt(date, dto.time, allDay, now);

    const row = await this.prisma.reminder.create({
      data: {
        userId: scope.userId,
        tenantId: scope.tenantId,
        title: dto.title,
        note: dto.note ?? null,
        dueAt,
        allDay,
        enabled: dto.enabled ?? true,
      },
      select: REMINDER_SELECT,
    });

    return this.project(row);
  }

  /**
   * Every reminder on one Jalali day, ascending.
   *
   * Bounded by the day itself: the query is a half-open `dueAt` range over the
   * `(userId, dueAt)` index, so it never degrades into a table scan and needs no
   * cursor. Disabled and already-delivered reminders ARE included — the day view
   * describes the day, and hiding them would make an entry vanish once it fired.
   */
  async listRemindersForDay(userId: string, dateKey: string): Promise<ReminderDayResult> {
    const scope = this.scope(userId);
    const date = this.requireJalaliDate(dateKey);
    const { start, end } = jalaliDayRange(date, APP_TIME_ZONE);

    const rows = await this.prisma.reminder.findMany({
      where: { ...this.ownership(scope), dueAt: { gte: start, lt: end } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      // A hard ceiling even here: a day cannot hold an unbounded list.
      take: MAX_REMINDER_LIMIT,
      select: REMINDER_SELECT,
    });

    return { day: describeJalaliDay(date), items: rows.map((row) => this.project(row)) };
  }

  /**
   * Bounded "upcoming" list: `dueAt >= now`, ascending, `limit`-capped, one extra row
   * fetched to report `hasMore`.
   *
   * There is no unbounded-history counterpart by design (§19).
   */
  async listUpcomingReminders(
    userId: string,
    query: ReminderQueryDto,
    now: Date = new Date(),
  ): Promise<ReminderListResult> {
    const scope = this.scope(userId);
    const limit = this.clampLimit(query.limit);

    const where: Prisma.ReminderWhereInput = {
      ...this.ownership(scope),
      dueAt: { gte: now },
      ...(query.includeDelivered ? {} : { deliveredAt: null }),
    };

    const rows = await this.prisma.reminder.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: REMINDER_SELECT,
    });

    return {
      items: rows.slice(0, limit).map((row) => this.project(row)),
      hasMore: rows.length > limit,
    };
  }

  /** One reminder the caller owns. */
  async getReminder(userId: string, id: string): Promise<ReminderDto> {
    const scope = this.scope(userId);
    return this.project(await this.requireOwned(scope, id));
  }

  /**
   * Partial update of the caller's own reminder.
   *
   * Rescheduling rules, stated explicitly because they are the subtle part:
   *
   *  - the new `dueAt` is recomputed from the EFFECTIVE date/time/allDay triple, so
   *    changing only the time keeps the existing day and vice versa;
   *  - moving a reminder to a future instant CLEARS `deliveredAt`, re-arming it. That
   *    is the only path back into the dispatcher's index, and it is deliberate: a
   *    user who moves a fired reminder forward expects it to fire again;
   *  - a reschedule is subject to the same past-instant rejection as creation, so an
   *    edit cannot achieve what a create is refused.
   */
  async updateReminder(
    userId: string,
    id: string,
    dto: UpdateReminderDto,
    now: Date = new Date(),
  ): Promise<ReminderDto> {
    const scope = this.scope(userId);
    const current = await this.requireOwned(scope, id);

    const data: Prisma.ReminderUpdateInput = {};

    if (dto.title !== undefined) data.title = dto.title;
    // An explicit empty string clears the note; NULL is the single representation of
    // "no note", so a blank string is never stored.
    if (dto.note !== undefined) data.note = dto.note.length > 0 ? dto.note : null;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    const reschedules =
      dto.date !== undefined || dto.time !== undefined || dto.allDay !== undefined;

    if (reschedules) {
      const currentDate = instantToJalaliDate(current.dueAt, APP_TIME_ZONE);
      const currentClock = instantToZonedTime(current.dueAt, APP_TIME_ZONE);

      const nextDate = dto.date !== undefined ? this.requireJalaliDate(dto.date) : currentDate;
      const nextAllDay = dto.allDay ?? current.allDay;

      // The effective time: an explicit value wins; otherwise the existing clock is
      // reused, and only when the result is still a timed reminder.
      const inheritedTime = current.allDay
        ? undefined
        : `${String(currentClock.hour).padStart(2, '0')}:${String(currentClock.minute).padStart(2, '0')}`;

      const nextTime = nextAllDay ? dto.time : (dto.time ?? inheritedTime);

      if (!nextAllDay && nextTime === undefined) {
        // Turning an all-day reminder into a timed one requires a time: there is no
        // sensible clock value to inherit from a day-level anchor.
        throw new BadRequestException('time is required when a reminder is not all-day');
      }

      // `resolveDueAt` still refuses the all-day + time combination, so an explicit
      // time sent alongside allDay=true is rejected rather than silently dropped.
      data.dueAt = this.resolveDueAt(nextDate, nextTime, nextAllDay, now);
      data.allDay = nextAllDay;

      // Re-arm: the reminder has moved into the future, so its previous delivery no
      // longer describes it.
      if (current.deliveredAt !== null) {
        data.deliveredAt = null;
      }
    }

    if (Object.keys(data).length === 0) {
      // Nothing to change. Returning the current state keeps PATCH idempotent
      // instead of failing a no-op.
      return this.project(current);
    }

    // The ownership predicate is repeated in the WHERE clause, so even a mistaken
    // call site cannot update a row the caller does not own.
    const result = await this.prisma.reminder.updateMany({
      where: { id, ...this.ownership(scope) },
      data,
    });

    if (result.count === 0) {
      throw new NotFoundException('Reminder not found');
    }

    return this.project(await this.requireOwned(scope, id));
  }

  /**
   * Deletes the caller's own reminder.
   *
   * Any notification already created for it is deliberately left alone: a delivered
   * notification is a historical record in the recipient's own inbox, and
   * `sourceType`/`sourceId` are documented as non-FK precisely so a notification
   * survives deletion of its source.
   */
  async deleteReminder(userId: string, id: string): Promise<{ id: string; deleted: true }> {
    const scope = this.scope(userId);

    const result = await this.prisma.reminder.deleteMany({
      where: { id, ...this.ownership(scope) },
    });

    if (result.count === 0) {
      throw new NotFoundException('Reminder not found');
    }

    return { id, deleted: true };
  }

  /**
   * Calendar month view: the Jalali grid, a per-day reminder count, and the
   * official occasions/holidays (Phase 49I-1).
   *
   * Bounded by construction — one month — and BOTH datasets come from a SINGLE
   * range/equality query each, never one query per day, so the month view costs
   * two queries (reminders + occasions) regardless of how many days carry data
   * (no N+1; 49I-1 "one bounded date-range query per calendar view").
   *
   * Official occasions are REFERENCE DATA: platform-global (no owner, no tenant),
   * seeded by migration from the published official calendar, and read-only for
   * every authenticated user. `isHoliday` is the DATA answer — Friday's weekly
   * closure is NOT a row here and is applied at render time (FRIDAY LOGIC).
   */
  async getMonth(userId: string, query: CalendarMonthQueryDto, now: Date = new Date()) {
    const scope = this.scope(userId);
    const { jy, jm } = query;

    const lastDay = jalaliMonthLength(jy, jm);
    const monthStart = jalaliDayRange({ jy, jm, jd: 1 }, APP_TIME_ZONE).start;
    const monthEnd = jalaliDayRange({ jy, jm, jd: lastDay }, APP_TIME_ZONE).end;

    const rows = await this.prisma.reminder.findMany({
      where: { ...this.ownership(scope), dueAt: { gte: monthStart, lt: monthEnd } },
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
    });

    // Phase 49I-1: ONE bounded equality query for the whole month returns every
    // occasion/holiday in it, including multiple rows sharing a date. Grouped in
    // memory afterwards, which is safe only because the query is already bounded.
    const occasionRows = await this.prisma.calendarOccasion.findMany({
      where: { jy, jm, isActive: true },
      orderBy: [{ sortOrder: 'desc' }, { title: 'asc' }],
    });

    const occasions = occasionRows.map((row) => ({
      date: row.jalaliDate,
      title: row.title,
      description: row.description,
      isHoliday: row.isHoliday,
      category: row.category,
      sourceYear: row.sourceYear,
    }));

    // Grouping in memory is safe here BECAUSE the query is already bounded to one
    // month of one user's reminders. It is not a substitute for a bounded query.
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = formatJalaliDateKey(instantToJalaliDate(row.dueAt, APP_TIME_ZONE));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const today = jalaliToday(now, APP_TIME_ZONE);
    const todayKey = formatJalaliDateKey(today);

    // Per-day occasions, so the client renders each cell without re-grouping the
    // flat list (and without a date-key parse). Kept alongside the flat `occasions`
    // array so a caller who wants the whole month's occasions in one list can read
    // it directly. `holidays` is REMOVED (was a permanent `null` stub): the real
    // dataset now replaces it.
    const occasionsByKey = new Map<string, CalendarOccasionDto[]>();
    for (const occasion of occasions) {
      const list = occasionsByKey.get(occasion.date) ?? [];
      list.push(occasion);
      occasionsByKey.set(occasion.date, list);
    }

    const days = Array.from({ length: lastDay }, (_, index) => {
      const descriptor = describeJalaliDay({ jy, jm, jd: index + 1 });

      return {
        ...descriptor,
        isToday: descriptor.date === todayKey,
        reminderCount: counts.get(descriptor.date) ?? 0,
        occasions: occasionsByKey.get(descriptor.date) ?? [],
      };
    });

    return {
      jy,
      jm,
      monthName: days[0].monthName,
      /** Weekday index of the 1st, so the client can offset the grid. */
      startWeekday: days[0].weekday,
      dayCount: lastDay,
      today: describeJalaliDay(today),
      days,
      occasions,
    };
  }

  /**
   * Server-authoritative "today", for the sidebar date chip.
   *
   * The chip does NOT compute the date from the browser clock: a client-side date
   * would disagree with the schedule a reminder is stored against whenever the two
   * disagree about the zone. Scope is asserted so the endpoint cannot be used as an
   * unauthenticated clock oracle.
   */
  async getToday(userId: string, now: Date = new Date()): Promise<JalaliDayDescriptor> {
    this.scope(userId);

    return describeJalaliDay(jalaliToday(now, APP_TIME_ZONE));
  }
}
