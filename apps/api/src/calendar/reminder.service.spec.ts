import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MAX_REMINDER_LIMIT, ReminderService } from './reminder.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49I unit coverage for the reminder service.
 *
 * What this file is responsible for proving:
 *  - scope is resolved from the request context and never from an argument;
 *  - every read and write carries BOTH userId and tenantId, so a cross-user or
 *    cross-tenant reminder is unreachable rather than merely unlisted;
 *  - the Jalali → instant conversion happens server-side, in Asia/Tehran, and a
 *    client-supplied date is never trusted as an instant;
 *  - a past TIMED reminder is rejected, and an all-day one is judged per day;
 *  - all-day and a clock time are mutually exclusive;
 *  - rescheduling forward re-arms delivery, and the day/upcoming reads stay bounded.
 *
 * Cross-tenant behaviour and exactly-once delivery are additionally proven against a
 * real database in test/calendar.e2e-spec.ts.
 */

describe('ReminderService', () => {
  let service: ReminderService;
  let prisma: {
    reminder: Record<string, jest.Mock>;
    calendarOccasion: Record<string, jest.Mock>;
  };

  const owner = 'user-owner';
  const tenantA = 'tenant-a';

  /** 2026-08-31T20:00:00Z = 23:30 Tehran on 1405/06/09. */
  const now = new Date('2026-08-31T20:00:00Z');

  const setContext = (userId: string | undefined, tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  /**
   * Establishes the request context INSIDE the test body.
   *
   * `AsyncLocalStorage.enterWith` does not propagate from a `beforeEach` into the
   * test callback — they are separate async continuations — so the context has to be
   * entered within the test itself. The existing 49E/49H specs call `setContext` as
   * the first line of every test for the same reason; this wrapper does it once.
   */
  const scoped = (name: string, body: () => Promise<void> | void) =>
    it(name, async () => {
      setContext(owner, tenantA);
      await body();
    });

  const reminderRow = (overrides: Record<string, unknown> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'جلسه با واحد فناوری اطلاعات',
    note: null,
    // 1405/08/18 14:30 Tehran.
    dueAt: new Date('2026-11-09T11:00:00.000Z'),
    allDay: false,
    enabled: true,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReminderService,
        {
          provide: PrismaService,
          useValue: {
            reminder: {
              findMany: jest.fn().mockResolvedValue([]),
              findFirst: jest.fn(),
              create: jest.fn(),
              updateMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            // Phase 49I-1: official occasions. Reference data, so reads exist but
            // there is no create/update/delete on the service surface.
            calendarOccasion: {
              findMany: jest.fn().mockResolvedValue([]),
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ReminderService);
    prisma = moduleRef.get(PrismaService);

    setContext(owner, tenantA);
  });

  describe('scope', () => {
    scoped('refuses a request with no identity in the context', async () => {
      setContext(undefined, tenantA);

      await expect(service.listUpcomingReminders(owner, {}, now)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.reminder.findMany).not.toHaveBeenCalled();
    });

    scoped('refuses when the context identity differs from the requested subject', async () => {
      setContext('someone-else', tenantA);

      await expect(service.listUpcomingReminders(owner, {}, now)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.reminder.findMany).not.toHaveBeenCalled();
    });

    scoped('takes the tenant from the context, never from the caller', async () => {
      setContext(owner, 'tenant-from-context');
      await service.listUpcomingReminders(owner, {}, now);

      expect(prisma.reminder.findMany.mock.calls[0][0].where).toMatchObject({
        userId: owner,
        tenantId: 'tenant-from-context',
      });
    });

    scoped('keeps a null tenant in the predicate rather than dropping it', async () => {
      setContext(owner, null);
      await service.listUpcomingReminders(owner, {}, now);

      expect(prisma.reminder.findMany.mock.calls[0][0].where).toMatchObject({
        userId: owner,
        tenantId: null,
      });
    });
  });

  describe('createReminder', () => {
    scoped('derives dueAt from the Jalali wall-clock reading in Asia/Tehran', async () => {
      prisma.reminder.create.mockResolvedValue(reminderRow());

      await service.createReminder(
        owner,
        { title: 'جلسه', date: '1405/08/18', time: '14:30' },
        now,
      );

      const data = prisma.reminder.create.mock.calls[0][0].data;

      // 14:30 Tehran, NOT 14:30Z. This is the assertion that fails if the zone is
      // ever dropped.
      expect(data.dueAt.toISOString()).toBe('2026-11-09T11:00:00.000Z');
      expect(data.allDay).toBe(false);
      expect(data.userId).toBe(owner);
      expect(data.tenantId).toBe(tenantA);
    });

    scoped('anchors an all-day reminder to the start of the Jalali day', async () => {
      prisma.reminder.create.mockResolvedValue(reminderRow({ allDay: true }));

      await service.createReminder(
        owner,
        { title: 'مرخصی', date: '1405/08/18', allDay: true },
        now,
      );

      const data = prisma.reminder.create.mock.calls[0][0].data;

      // 00:00 Tehran on 1405/08/18 is 20:30Z the previous Gregorian day.
      expect(data.dueAt.toISOString()).toBe('2026-11-08T20:30:00.000Z');
      expect(data.allDay).toBe(true);
    });

    scoped('refuses an all-day reminder that also carries a time', async () => {
      await expect(
        service.createReminder(
          owner,
          { title: 'x', date: '1405/08/18', time: '14:30', allDay: true },
          now,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.reminder.create).not.toHaveBeenCalled();
    });

    scoped('refuses a timed reminder with no time', async () => {
      await expect(
        service.createReminder(owner, { title: 'x', date: '1405/08/18' }, now),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.reminder.create).not.toHaveBeenCalled();
    });

    scoped('rejects a timed reminder in the past', async () => {
      // 08:00 Tehran on 1405/06/09 is already behind `now` (23:30 Tehran).
      await expect(
        service.createReminder(owner, { title: 'x', date: '1405/06/09', time: '08:00' }, now),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.reminder.create).not.toHaveBeenCalled();
    });

    scoped('accepts an all-day reminder for today, because the day has not ended', async () => {
      prisma.reminder.create.mockResolvedValue(reminderRow({ allDay: true }));

      await expect(
        service.createReminder(owner, { title: 'x', date: '1405/06/09', allDay: true }, now),
      ).resolves.toBeDefined();
    });

    scoped('rejects an all-day reminder for a day that has fully passed', async () => {
      await expect(
        service.createReminder(owner, { title: 'x', date: '1405/06/08', allDay: true }, now),
      ).rejects.toThrow(BadRequestException);
    });

    scoped('rejects a semantically impossible Jalali date that passes the DTO pattern', async () => {
      // 1405 is not a leap year, so Esfand 30 does not exist.
      await expect(
        service.createReminder(owner, { title: 'x', date: '1405/12/30', time: '10:00' }, now),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.reminder.create).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    scoped('scopes the day view to a half-open Tehran-midnight range', async () => {
      await service.listRemindersForDay(owner, '1405/06/09');

      const args = prisma.reminder.findMany.mock.calls[0][0];

      expect(args.where.userId).toBe(owner);
      expect(args.where.tenantId).toBe(tenantA);
      expect(args.where.dueAt.gte.toISOString()).toBe('2026-08-30T20:30:00.000Z');
      expect(args.where.dueAt.lt.toISOString()).toBe('2026-08-31T20:30:00.000Z');
      // `lt`, not `lte`: a closed range would double-count the boundary.
      expect(args.where.dueAt.lte).toBeUndefined();
    });

    scoped('bounds the day view even though it is not cursor-paginated', async () => {
      await service.listRemindersForDay(owner, '1405/06/09');
      expect(prisma.reminder.findMany.mock.calls[0][0].take).toBe(MAX_REMINDER_LIMIT);
    });

    scoped('rejects a malformed day key instead of querying', async () => {
      await expect(service.listRemindersForDay(owner, '1405-06-09')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.listRemindersForDay(owner, '۱۴۰۵/۰۶/۰۹')).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.reminder.findMany).not.toHaveBeenCalled();
    });

    scoped('re-derives the display date and time from the stored instant', async () => {
      prisma.reminder.findMany.mockResolvedValue([reminderRow()]);

      const result = await service.listRemindersForDay(owner, '1405/08/18');

      expect(result.day).toMatchObject({
        date: '1405/08/18',
        monthName: 'آبان',
      });
      expect(result.items[0]).toMatchObject({ date: '1405/08/18', time: '14:30' });
    });

    scoped('reports no time for an all-day reminder rather than 00:00', async () => {
      prisma.reminder.findMany.mockResolvedValue([
        reminderRow({ allDay: true, dueAt: new Date('2026-11-08T20:30:00.000Z') }),
      ]);

      const result = await service.listRemindersForDay(owner, '1405/08/18');

      expect(result.items[0].allDay).toBe(true);
      expect(result.items[0].time).toBeNull();
    });

    scoped('bounds the upcoming list and excludes delivered reminders by default', async () => {
      await service.listUpcomingReminders(owner, { limit: 5 }, now);

      const args = prisma.reminder.findMany.mock.calls[0][0];

      expect(args.where.dueAt.gte).toBe(now);
      expect(args.where.deliveredAt).toBeNull();
      // limit + 1, so `hasMore` needs no second COUNT query.
      expect(args.take).toBe(6);
      expect(args.orderBy).toEqual([{ dueAt: 'asc' }, { id: 'asc' }]);
    });

    scoped('caps an oversized limit instead of honouring it', async () => {
      await service.listUpcomingReminders(owner, { limit: 10_000 }, now);
      expect(prisma.reminder.findMany.mock.calls[0][0].take).toBe(MAX_REMINDER_LIMIT + 1);
    });

    scoped('reports hasMore from the extra row and does not return it', async () => {
      prisma.reminder.findMany.mockResolvedValue([
        reminderRow({ id: 'a' }),
        reminderRow({ id: 'b' }),
        reminderRow({ id: 'c' }),
      ]);

      const result = await service.listUpcomingReminders(owner, { limit: 2 }, now);

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    scoped('includes delivered reminders only when asked', async () => {
      await service.listUpcomingReminders(owner, { includeDelivered: true }, now);
      expect(prisma.reminder.findMany.mock.calls[0][0].where.deliveredAt).toBeUndefined();
    });

    scoped('404s a reminder the caller does not own', async () => {
      prisma.reminder.findFirst.mockResolvedValue(null);

      await expect(service.getReminder(owner, 'some-id')).rejects.toThrow(NotFoundException);
      // The ownership predicate is part of the query, so another user's row is never
      // even fetched.
      expect(prisma.reminder.findFirst.mock.calls[0][0].where).toMatchObject({
        userId: owner,
        tenantId: tenantA,
      });
    });
  });

  describe('updateReminder', () => {
    const id = '11111111-1111-4111-8111-111111111111';

    scoped('keeps the existing day when only the time changes', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { time: '09:15' }, now);

      const data = prisma.reminder.updateMany.mock.calls[0][0].data;
      // Still 1405/08/18, now at 09:15 Tehran = 05:45Z.
      expect(data.dueAt.toISOString()).toBe('2026-11-09T05:45:00.000Z');
    });

    scoped('keeps the existing time when only the day changes', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { date: '1405/08/19' }, now);

      const data = prisma.reminder.updateMany.mock.calls[0][0].data;
      expect(data.dueAt.toISOString()).toBe('2026-11-10T11:00:00.000Z');
    });

    scoped('re-arms a delivered reminder when it is moved forward', async () => {
      prisma.reminder.findFirst.mockResolvedValue(
        reminderRow({ deliveredAt: new Date('2026-11-09T11:00:05.000Z') }),
      );
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { date: '1405/09/01' }, now);

      expect(prisma.reminder.updateMany.mock.calls[0][0].data.deliveredAt).toBeNull();
    });

    scoped('does not touch deliveredAt when only the title changes', async () => {
      prisma.reminder.findFirst.mockResolvedValue(
        reminderRow({ deliveredAt: new Date('2026-11-09T11:00:05.000Z') }),
      );
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { title: 'عنوان جدید' }, now);

      const data = prisma.reminder.updateMany.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('deliveredAt');
      expect(data).not.toHaveProperty('dueAt');
    });

    scoped('applies the same past-instant rejection as creation', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());

      await expect(
        service.updateReminder(owner, id, { date: '1405/06/09', time: '08:00' }, now),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.reminder.updateMany).not.toHaveBeenCalled();
    });

    scoped('requires a time when an all-day reminder becomes timed', async () => {
      prisma.reminder.findFirst.mockResolvedValue(
        reminderRow({ allDay: true, dueAt: new Date('2026-11-08T20:30:00.000Z') }),
      );

      await expect(service.updateReminder(owner, id, { allDay: false }, now)).rejects.toThrow(
        BadRequestException,
      );
    });

    scoped('drops the clock time when a timed reminder becomes all-day', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { allDay: true }, now);

      const data = prisma.reminder.updateMany.mock.calls[0][0].data;
      expect(data.allDay).toBe(true);
      expect(data.dueAt.toISOString()).toBe('2026-11-08T20:30:00.000Z');
    });

    scoped('clears the note on an explicit empty string', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow({ note: 'قدیمی' }));
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { note: '' }, now);

      expect(prisma.reminder.updateMany.mock.calls[0][0].data.note).toBeNull();
    });

    scoped('treats an empty patch as a no-op instead of failing', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());

      await expect(service.updateReminder(owner, id, {}, now)).resolves.toMatchObject({ id });
      expect(prisma.reminder.updateMany).not.toHaveBeenCalled();
    });

    scoped('carries the ownership predicate into the UPDATE as well as the read', async () => {
      prisma.reminder.findFirst.mockResolvedValue(reminderRow());
      prisma.reminder.updateMany.mockResolvedValue({ count: 1 });

      await service.updateReminder(owner, id, { enabled: false }, now);

      expect(prisma.reminder.updateMany.mock.calls[0][0].where).toMatchObject({
        id,
        userId: owner,
        tenantId: tenantA,
      });
    });
  });

  describe('deleteReminder', () => {
    scoped('deletes only within the caller ownership predicate', async () => {
      prisma.reminder.deleteMany.mockResolvedValue({ count: 1 });

      await service.deleteReminder(owner, 'target-id');

      expect(prisma.reminder.deleteMany.mock.calls[0][0].where).toMatchObject({
        id: 'target-id',
        userId: owner,
        tenantId: tenantA,
      });
    });

    scoped('404s when nothing matched, so another user cannot probe ids', async () => {
      prisma.reminder.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.deleteReminder(owner, 'target-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('calendar surfaces', () => {
    scoped('builds a Jalali month grid with a bounded single query', async () => {
      prisma.reminder.findMany.mockResolvedValue([
        { dueAt: new Date('2026-11-09T11:00:00.000Z') },
        { dueAt: new Date('2026-11-09T14:00:00.000Z') },
      ]);

      const month = await service.getMonth(owner, { jy: 1405, jm: 8 }, now);

      // One query for the whole month: no per-day fan-out.
      expect(prisma.reminder.findMany).toHaveBeenCalledTimes(1);
      expect(month.dayCount).toBe(30); // Aban has 30 days
      expect(month.monthName).toBe('آبان');
      expect(month.days).toHaveLength(30);
      expect(month.days[17]).toMatchObject({ date: '1405/08/18', reminderCount: 2 });
      expect(month.days[0].reminderCount).toBe(0);
      expect(month.occasions).toEqual([]);
    });

    scoped('reports the right day count for each half of the year and for Esfand', async () => {
      const farvardin = await service.getMonth(owner, { jy: 1405, jm: 1 }, now);
      const esfand = await service.getMonth(owner, { jy: 1405, jm: 12 }, now);
      const leapEsfand = await service.getMonth(owner, { jy: 1403, jm: 12 }, now);

      expect(farvardin.dayCount).toBe(31);
      expect(esfand.dayCount).toBe(29);
      expect(leapEsfand.dayCount).toBe(30);
    });

    scoped('attaches official occasions with a single bounded month query (no N+1)', async () => {
      // Two official occasions sharing one date (Phase 49I-1 multi-occasion rule).
      prisma.calendarOccasion.findMany.mockResolvedValue([
        {
          id: 'occ-1',
          jalaliDate: '1405/08/22',
          jy: 1405,
          jm: 8,
          jd: 22,
          title: 'شهادت حضرت فاطمه زهرا (س)',
          description: '۳ جمادی‌الثانی ۱۴۴۸',
          isHoliday: true,
          category: 'RELIGIOUS',
          source: 'official-iranian-calendar-1405',
          sourceYear: 1405,
          sortOrder: 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'occ-2',
          jalaliDate: '1405/08/13',
          jy: 1405,
          jm: 8,
          jd: 13,
          title: 'روز دانش آموز',
          description: null,
          isHoliday: false,
          category: 'NATIONAL',
          source: 'official-iranian-calendar-1405',
          sourceYear: 1405,
          sortOrder: 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const month = await service.getMonth(owner, { jy: 1405, jm: 8 }, now);

      // ONE bounded query for the whole month's occasions, no per-day fan-out.
      expect(prisma.calendarOccasion.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.calendarOccasion.findMany.mock.calls[0][0].where).toEqual({
        jy: 1405,
        jm: 8,
        isActive: true,
      });
      // Flat list carries both occasions, each with the published metadata.
      expect(month.occasions).toHaveLength(2);
      expect(month.occasions[0]).toMatchObject({
        date: '1405/08/22',
        title: 'شهادت حضرت فاطمه زهرا (س)',
        isHoliday: true,
        category: 'RELIGIOUS',
        sourceYear: 1405,
      });
      expect(month.occasions[0]).not.toHaveProperty('id'); // internal id not exposed
      // Per-day attachment makes the client re-grouping-free.
      expect(month.days[12].occasions).toHaveLength(1);
      expect(month.days[12].occasions[0].title).toBe('روز دانش آموز');
      expect(month.days[21].occasions[0].isHoliday).toBe(true);
      // A day with no occasion gets an empty array, never a null that needs guarding.
      expect(month.days[0].occasions).toEqual([]);
    });

    scoped('marks today and reports the occasion layer is data-backed', async () => {
      const month = await service.getMonth(owner, { jy: 1405, jm: 6 }, now);

      expect(month.today.date).toBe('1405/06/09');
      expect(month.days.filter((day) => day.isToday)).toHaveLength(1);
      expect(month.days[8].isToday).toBe(true);
      // The old `holidays: null` stub is gone; the occasion layer is a real array.
      expect(month.occasions).toEqual([]);
      expect(month.days[8].occasions).toEqual([]);
    });

    scoped('resolves today in Asia/Tehran, not from the ambient process timezone', async () => {
      // 20:00Z is 23:30 Tehran on 1405/06/09; 21:00Z is 00:30 on 1405/06/10.
      await expect(service.getToday(owner, now)).resolves.toMatchObject({
        date: '1405/06/09',
        weekdayName: 'دوشنبه',
        monthName: 'شهریور',
      });

      await expect(
        service.getToday(owner, new Date('2026-08-31T21:00:00Z')),
      ).resolves.toMatchObject({ date: '1405/06/10' });
    });

    scoped('still asserts scope on the chip endpoint', async () => {
      setContext(undefined, tenantA);
      await expect(service.getToday(owner, now)).rejects.toThrow(ForbiddenException);
    });
  });
});
