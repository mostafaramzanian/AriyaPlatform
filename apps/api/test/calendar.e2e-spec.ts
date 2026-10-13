import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
import { CalendarModule } from '../src/calendar/calendar.module';
import { ReminderDispatcherService } from '../src/calendar/reminder-dispatcher.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49I — Calendar / Reminders E2E against the real Core database.
 *
 * Modelled on surveys.e2e-spec.ts (49H): a minimal test guard supplies identity in a
 * header and the REAL TenantContextInterceptor resolves tenant from the database, so
 * ownership and tenant isolation are genuinely enforced rather than stubbed.
 *
 * No RolesGuard here, and that absence is the point: this phase introduces no
 * permission. Ownership is the only authorization edge, so there is nothing for a role
 * gate to enforce and nothing seeded to clean up afterwards.
 *
 * DELIVERY IS TESTED WITH A CONTROLLED CLOCK, not by sleeping: `processDue(now)` takes
 * the instant as a parameter, so a reminder can be made due by passing a later `now`
 * instead of waiting for a real 30-second tick.
 */

/** Fields that must never appear on a projected reminder. */
const FORBIDDEN_REMINDER_FIELDS = ['userId', 'tenantId'];

class CalendarTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('Calendar E2E (reminders, timezone, ownership, exactly-once delivery)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: ReminderDispatcherService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];

  let ownerId: string;
  let peerId: string;
  let foreignId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `calendar-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUsers.push(user.id);
    return user;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const patch = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).patch(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const del = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).delete(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /**
   * A Jalali day comfortably in the future, so the past-instant rule never makes the
   * suite time-dependent. Derived from the API's own `today`, not hardcoded.
   */
  let futureDate: string;

  const createReminder = async (callerId: string, overrides: Record<string, unknown> = {}) => {
    const res = await post('/calendar/reminders', callerId).send({
      title: 'جلسه تیم فناوری',
      date: futureDate,
      time: '14:30',
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [CalendarModule, PrismaModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: CalendarTestGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.length,
          }),
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    dispatcher = app.get(ReminderDispatcherService);

    const tenantA = await prisma.tenant.create({ data: { code: `calendar-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `calendar-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    ownerId = (await makeUser({ tenantId: tenantAId, firstName: 'بهار', lastName: 'نوری' })).id;
    peerId = (await makeUser({ tenantId: tenantAId, firstName: 'سینا', lastName: 'کریمی' })).id;
    foreignId = (await makeUser({ tenantId: tenantBId, firstName: 'مینا', lastName: 'رضایی' })).id;

    // Anchor every write on a day one Jalali year ahead of the server's own "today", so
    // the suite can never be broken by the past-instant rule.
    const todayRes = await get('/calendar/today', ownerId);
    expect(todayRes.status).toBe(200);
    futureDate = `${todayRes.body.jy + 1}/${String(todayRes.body.jm).padStart(2, '0')}/01`;
  });

  afterAll(async () => {
    // Reminders cascade from User, but they are removed explicitly so a failure in user
    // deletion cannot leave rows behind.
    if (createdUsers.length > 0) {
      await prisma.reminder.deleteMany({ where: { userId: { in: createdUsers } } });
      await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    }

    if (tenantAId) await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });

    await app.close();
  });

  /** Removes every reminder and notification between tests. */
  afterEach(async () => {
    await prisma.reminder.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });
  });

  describe('authentication', () => {
    it('rejects an anonymous caller on every route', async () => {
      await expect(get('/calendar/today').then((r) => r.status)).resolves.toBe(401);
      await expect(get('/calendar/reminders').then((r) => r.status)).resolves.toBe(401);
      await expect(
        post('/calendar/reminders')
          .send({ title: 'x', date: futureDate, time: '10:00' })
          .then((r) => r.status),
      ).resolves.toBe(401);
    });
  });

  describe('today', () => {
    it('returns a server-authoritative Jalali day', async () => {
      const res = await get('/calendar/today', ownerId);

      expect(res.status).toBe(200);
      expect(res.body.date).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
      expect(res.body.jy).toBeGreaterThan(1400);
      expect(res.body.monthName).toEqual(expect.any(String));
      expect(res.body.weekdayName).toEqual(expect.any(String));
    });
  });

  describe('creation and projection', () => {
    it('stores dueAt in Asia/Tehran and never projects userId or tenantId', async () => {
      const body = await createReminder(ownerId);

      for (const field of FORBIDDEN_REMINDER_FIELDS) {
        expect(body).not.toHaveProperty(field);
      }

      expect(body.date).toBe(futureDate);
      expect(body.time).toBe('14:30');
      expect(body.allDay).toBe(false);
      expect(body.deliveredAt).toBeNull();

      // The stored instant is the wall-clock reading MINUS the Tehran offset, so the
      // UTC hour is never 14.
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.dueAt.getUTCHours()).not.toBe(14);
      expect(row.userId).toBe(ownerId);
      expect(row.tenantId).toBe(tenantAId);
    });

    it('ignores a client-supplied userId or tenantId by rejecting the request', async () => {
      // `forbidNonWhitelisted` means an impersonation attempt is refused outright rather
      // than silently stripped, which is the stronger guarantee.
      const res = await post('/calendar/reminders', ownerId).send({
        title: 'تلاش برای جعل',
        date: futureDate,
        time: '10:00',
        userId: peerId,
        tenantId: tenantBId,
      });

      expect(res.status).toBe(422);
      await expect(prisma.reminder.count({ where: { userId: peerId } })).resolves.toBe(0);
    });

    it('anchors an all-day reminder to midnight Tehran', async () => {
      const body = await createReminder(ownerId, { allDay: true, time: undefined });

      expect(body.allDay).toBe(true);
      expect(body.time).toBeNull();
      expect(body.date).toBe(futureDate);

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: body.id } });
      // 00:00 Tehran is 20:30Z or 19:30Z the previous day — never 00:00Z.
      expect(row.dueAt.getUTCHours()).not.toBe(0);
    });

    it('refuses an all-day reminder that also carries a time', async () => {
      const res = await post('/calendar/reminders', ownerId).send({
        title: 'ناسازگار',
        date: futureDate,
        time: '10:00',
        allDay: true,
      });

      expect(res.status).toBe(400);
    });

    it('rejects a reminder in the past', async () => {
      const res = await post('/calendar/reminders', ownerId).send({
        title: 'گذشته',
        date: '1400/01/01',
        time: '10:00',
      });

      expect(res.status).toBe(400);
    });

    it('rejects a date that is well-formed but impossible', async () => {
      // 1405 is not a leap year, so Esfand 30 does not exist.
      const res = await post('/calendar/reminders', ownerId).send({
        title: 'ناموجود',
        date: '1405/12/30',
        time: '10:00',
      });

      expect([400, 422]).toContain(res.status);
    });

    it('rejects a malformed date or time at the DTO boundary', async () => {
      for (const payload of [
        { title: 'x', date: '1405-08-18', time: '10:00' },
        { title: 'x', date: '۱۴۰۵/۰۸/۱۸', time: '10:00' },
        { title: 'x', date: futureDate, time: '25:00' },
        { title: 'x', date: futureDate, time: '9:00' },
        { title: '', date: futureDate, time: '10:00' },
      ]) {
        const res = await post('/calendar/reminders', ownerId).send(payload);
        expect(res.status).toBe(422);
      }
    });

    it('enforces the title and note bounds', async () => {
      const tooLongTitle = await post('/calendar/reminders', ownerId).send({
        title: 'ا'.repeat(161),
        date: futureDate,
        time: '10:00',
      });
      const tooLongNote = await post('/calendar/reminders', ownerId).send({
        title: 'عنوان',
        note: 'ب'.repeat(1001),
        date: futureDate,
        time: '10:00',
      });

      expect(tooLongTitle.status).toBe(422);
      expect(tooLongNote.status).toBe(422);
    });
  });

  describe('ownership and tenant isolation', () => {
    it("404s another user's reminder in the same tenant", async () => {
      const mine = await createReminder(ownerId);

      const read = await get(`/calendar/reminders/${mine.id}`, peerId);
      const edit = await patch(`/calendar/reminders/${mine.id}`, peerId).send({ title: 'ربوده' });
      const remove = await del(`/calendar/reminders/${mine.id}`, peerId);

      expect(read.status).toBe(404);
      expect(edit.status).toBe(404);
      expect(remove.status).toBe(404);

      // Untouched.
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: mine.id } });
      expect(row.title).toBe('جلسه تیم فناوری');
    });

    it("404s a reminder across a tenant boundary", async () => {
      const mine = await createReminder(ownerId);

      const res = await get(`/calendar/reminders/${mine.id}`, foreignId);
      expect(res.status).toBe(404);
    });

    it('never lists another user\'s reminders', async () => {
      await createReminder(ownerId);
      await createReminder(peerId, { title: 'مال دیگری' });

      const mine = await get(`/calendar/reminders?date=${encodeURIComponent(futureDate)}`, ownerId);
      const theirs = await get(`/calendar/reminders?date=${encodeURIComponent(futureDate)}`, peerId);

      expect(mine.status).toBe(200);
      expect(mine.body.items).toHaveLength(1);
      expect(mine.body.items[0].title).toBe('جلسه تیم فناوری');

      expect(theirs.body.items).toHaveLength(1);
      expect(theirs.body.items[0].title).toBe('مال دیگری');
    });

    it('does not leak reminders into the month aggregate across users', async () => {
      await createReminder(peerId);

      const [jy, jm] = futureDate.split('/').map(Number);
      const res = await get(`/calendar/month?jy=${jy}&jm=${jm}`, ownerId);

      expect(res.status).toBe(200);
      expect(res.body.days.every((day) => day.reminderCount === 0)).toBe(true);
    });
  });

  describe('reads', () => {
    it('lists a day and describes it in Persian', async () => {
      await createReminder(ownerId);

      const res = await get(`/calendar/reminders?date=${encodeURIComponent(futureDate)}`, ownerId);

      expect(res.status).toBe(200);
      expect(res.body.day.date).toBe(futureDate);
      expect(res.body.day.monthName).toEqual(expect.any(String));
      expect(res.body.items[0].time).toBe('14:30');
    });

    it('returns an empty day rather than an error when nothing is scheduled', async () => {
      const res = await get(`/calendar/reminders?date=${encodeURIComponent(futureDate)}`, ownerId);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('rejects a malformed date query instead of ignoring it', async () => {
      const res = await get('/calendar/reminders?date=1405-08-18', ownerId);
      expect(res.status).toBe(422);
    });

    it('bounds the upcoming list and reports hasMore', async () => {
      await createReminder(ownerId, { time: '09:00' });
      await createReminder(ownerId, { time: '10:00' });
      await createReminder(ownerId, { time: '11:00' });

      const res = await get('/calendar/reminders?limit=2', ownerId);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.hasMore).toBe(true);
      // Ascending by dueAt.
      expect(res.body.items[0].time).toBe('09:00');
      expect(res.body.items[1].time).toBe('10:00');
    });

    it('builds a Jalali month grid with per-day counts', async () => {
      await createReminder(ownerId);

      const [jy, jm] = futureDate.split('/').map(Number);
      const res = await get(`/calendar/month?jy=${jy}&jm=${jm}`, ownerId);

      expect(res.status).toBe(200);
      expect(res.body.dayCount).toBe(jm <= 6 ? 31 : jm <= 11 ? 30 : res.body.dayCount);
      expect(res.body.days).toHaveLength(res.body.dayCount);
      expect(res.body.days[0].reminderCount).toBe(1);
      // Phase 49I-1 replaced the permanent `holidays: null` stub with the real
      // occasion layer, so the key is GONE rather than null: the flat `occasions`
      // array and each day's own `occasions` array are the holiday dataset now
      // (reminder.service.ts getMonth(), which also keeps this bounded to one
      // equality query per month).
      expect(res.body.holidays).toBeUndefined();
      expect(Array.isArray(res.body.occasions)).toBe(true);
      expect(Array.isArray(res.body.days[0].occasions)).toBe(true);
    });

    it('rejects a month outside the supported Jalali range', async () => {
      const badYear = await get('/calendar/month?jy=1200&jm=1', ownerId);
      const badMonth = await get('/calendar/month?jy=1405&jm=13', ownerId);

      expect(badYear.status).toBe(422);
      expect(badMonth.status).toBe(422);
    });
  });

  describe('editing', () => {
    it('reschedules the time and keeps the day', async () => {
      const created = await createReminder(ownerId);

      const res = await patch(`/calendar/reminders/${created.id}`, ownerId).send({ time: '09:15' });

      expect(res.status).toBe(200);
      expect(res.body.date).toBe(futureDate);
      expect(res.body.time).toBe('09:15');
    });

    it('disables and re-enables without losing the schedule', async () => {
      const created = await createReminder(ownerId);

      const off = await patch(`/calendar/reminders/${created.id}`, ownerId).send({
        enabled: false,
      });
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);
      expect(off.body.time).toBe('14:30');

      const on = await patch(`/calendar/reminders/${created.id}`, ownerId).send({ enabled: true });
      expect(on.body.enabled).toBe(true);
      expect(on.body.dueAt).toBe(off.body.dueAt);
    });

    it('refuses to reschedule into the past', async () => {
      const created = await createReminder(ownerId);

      const res = await patch(`/calendar/reminders/${created.id}`, ownerId).send({
        date: '1400/01/01',
      });

      expect(res.status).toBe(400);
    });

    it("deletes only the caller's own reminder", async () => {
      const created = await createReminder(ownerId);

      const res = await del(`/calendar/reminders/${created.id}`, ownerId);

      expect(res.status).toBe(200);
      await expect(prisma.reminder.count({ where: { id: created.id } })).resolves.toBe(0);
    });
  });

  describe('delivery', () => {
    /** Makes a reminder due by rewriting `dueAt` directly — no real waiting. */
    const makeDue = async (id: string) => {
      await prisma.reminder.update({
        where: { id },
        data: { dueAt: new Date(Date.now() - 60_000) },
      });
    };

    it('creates exactly one Notification for a due reminder', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);

      const delivered = await dispatcher.processDue(new Date());

      expect(delivered).toBe(1);

      const notifications = await prisma.notification.findMany({ where: { userId: ownerId } });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('INFORMATION');
      expect(notifications[0].title).toBe('یادآوری');
      expect(notifications[0].body).toContain('جلسه تیم فناوری');
      expect(notifications[0].sourceType).toBe('calendar.reminder');
      expect(notifications[0].sourceId).toBe(created.id);
      // Tenant is snapshotted from the recipient, not from the reminder payload.
      expect(notifications[0].tenantId).toBe(tenantAId);
    });

    it('does not deliver twice across repeated ticks', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);

      const first = await dispatcher.processDue(new Date());
      const second = await dispatcher.processDue(new Date());
      const third = await dispatcher.processDue(new Date());

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(third).toBe(0);
      await expect(prisma.notification.count({ where: { userId: ownerId } })).resolves.toBe(1);
    });

    it('does not deliver twice when ticks race', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);

      const results = await Promise.all([
        dispatcher.processDue(new Date()),
        dispatcher.processDue(new Date()),
        dispatcher.processDue(new Date()),
      ]);

      // The conditional UPDATE is what makes this hold against the real database.
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      await expect(prisma.notification.count({ where: { userId: ownerId } })).resolves.toBe(1);
    });

    it('stamps deliveredAt and reports it on the reminder', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);

      await dispatcher.processDue(new Date());

      const res = await get(`/calendar/reminders/${created.id}`, ownerId);
      expect(res.body.deliveredAt).not.toBeNull();
    });

    it('never delivers a disabled reminder', async () => {
      const created = await createReminder(ownerId);
      await prisma.reminder.update({
        where: { id: created.id },
        data: { enabled: false, dueAt: new Date(Date.now() - 60_000) },
      });

      await expect(dispatcher.processDue(new Date())).resolves.toBe(0);
      await expect(prisma.notification.count({ where: { userId: ownerId } })).resolves.toBe(0);
    });

    it('never delivers a reminder that is not yet due', async () => {
      await createReminder(ownerId);

      await expect(dispatcher.processDue(new Date())).resolves.toBe(0);
      await expect(prisma.notification.count({ where: { userId: ownerId } })).resolves.toBe(0);
    });

    it('re-arms a delivered reminder when the owner moves it forward', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);
      await dispatcher.processDue(new Date());

      const moved = await patch(`/calendar/reminders/${created.id}`, ownerId).send({
        date: futureDate,
        time: '16:45',
      });

      expect(moved.status).toBe(200);
      expect(moved.body.deliveredAt).toBeNull();

      // It fires again once due — and again only once.
      await makeDue(created.id);
      await expect(dispatcher.processDue(new Date())).resolves.toBe(1);
      await expect(dispatcher.processDue(new Date())).resolves.toBe(0);
      await expect(prisma.notification.count({ where: { userId: ownerId } })).resolves.toBe(2);
    });

    it('notifies only the owner, never another user', async () => {
      const created = await createReminder(ownerId);
      await makeDue(created.id);

      await dispatcher.processDue(new Date());

      await expect(prisma.notification.count({ where: { userId: peerId } })).resolves.toBe(0);
      await expect(prisma.notification.count({ where: { userId: foreignId } })).resolves.toBe(0);
    });
  });
});
