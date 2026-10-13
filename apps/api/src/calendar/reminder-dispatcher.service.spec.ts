import { Test } from '@nestjs/testing';
import { NotificationType } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import {
  REMINDER_BATCH_SIZE,
  REMINDER_NOTIFICATION_TITLE,
  ReminderDispatcherService,
} from './reminder-dispatcher.service';
import { REMINDER_SOURCE_TYPE } from './reminder.service';

/**
 * Phase 49I unit coverage for reminder delivery.
 *
 * The claim is modelled the way Postgres actually behaves: `updateMany` with
 * `deliveredAt: null` in the predicate is backed here by a tiny in-memory store, so
 * the SECOND caller genuinely observes `count: 0` instead of the test asserting the
 * intent. That is what makes the exactly-once assertions evidence rather than a
 * restatement of the implementation.
 */

describe('ReminderDispatcherService', () => {
  let service: ReminderDispatcherService;
  let prisma: { reminder: Record<string, jest.Mock> };
  let notifications: { createForUser: jest.Mock };

  /** Reminder rows the fake store holds, keyed by id. */
  let store: Map<string, { id: string; deliveredAt: Date | null; enabled: boolean }>;

  const now = new Date('2026-11-09T11:00:05.000Z');

  const due = (overrides: Record<string, unknown> = {}) => ({
    id: 'reminder-1',
    userId: 'user-1',
    title: 'جلسه تیم فناوری',
    // 1405/08/18 14:30 Tehran.
    dueAt: new Date('2026-11-09T11:00:00.000Z'),
    allDay: false,
    ...overrides,
  });

  beforeEach(async () => {
    store = new Map();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReminderDispatcherService,
        {
          provide: PrismaService,
          useValue: {
            reminder: {
              findMany: jest.fn().mockResolvedValue([]),
              // Models the conditional UPDATE: only rows matching the predicate are
              // affected, and the predicate includes `deliveredAt: null`.
              updateMany: jest.fn(
                async ({
                  where,
                  data,
                }: {
                  where: { id: string; deliveredAt?: null; enabled?: boolean };
                  data: { deliveredAt: Date | null };
                }) => {
                const row = store.get(where.id);

                if (!row) return { count: 0 };
                if (where.deliveredAt === null && row.deliveredAt !== null) return { count: 0 };
                if (where.enabled === true && !row.enabled) return { count: 0 };

                row.deliveredAt = data.deliveredAt;
                return { count: 1 };
              }),
            },
          },
        },
        { provide: NotificationService, useValue: { createForUser: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(ReminderDispatcherService);
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);

    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  /** Seeds the store and the due-scan result for one reminder. */
  const arm = (row = due(), enabled = true) => {
    store.set(row.id, { id: row.id, deliveredAt: null, enabled });
    prisma.reminder.findMany.mockResolvedValue([row]);
    return row;
  };

  it('scans only pending, enabled, already-due reminders', async () => {
    await service.processDue(now);

    const args = prisma.reminder.findMany.mock.calls[0][0];

    expect(args.where).toEqual({ enabled: true, deliveredAt: null, dueAt: { lte: now } });
    expect(args.take).toBe(REMINDER_BATCH_SIZE);
    expect(args.orderBy).toEqual({ dueAt: 'asc' });
  });

  it('claims the reminder before creating its notification', async () => {
    arm();

    const order: string[] = [];
    prisma.reminder.updateMany.mockImplementation(async () => {
      order.push('claim');
      return { count: 1 };
    });
    notifications.createForUser.mockImplementation(async () => {
      order.push('notify');
      return {};
    });

    await service.processDue(now);

    // Claim first: a crash between the two loses a notification, which is strictly
    // better than sending one twice.
    expect(order).toEqual(['claim', 'notify']);
  });

  it('delivers through the existing Notification Center contract', async () => {
    const row = arm();

    await service.processDue(now);

    expect(notifications.createForUser).toHaveBeenCalledTimes(1);
    expect(notifications.createForUser).toHaveBeenCalledWith({
      userId: row.userId,
      type: NotificationType.INFORMATION,
      title: REMINDER_NOTIFICATION_TITLE,
      body: 'جلسه تیم فناوری — ساعت 14:30',
      sourceType: REMINDER_SOURCE_TYPE,
      sourceId: row.id,
    });
  });

  it('never sends a recipient other than the reminder owner', async () => {
    arm(due({ userId: 'owner-only' }));

    await service.processDue(now);

    const payload = notifications.createForUser.mock.calls[0][0];
    expect(payload.userId).toBe('owner-only');
    // No tenant is asserted: NotificationService snapshots the recipient's own.
    expect(payload).not.toHaveProperty('tenantId');
  });

  it('renders an all-day reminder with its Jalali date instead of a clock time', async () => {
    arm(
      due({
        allDay: true,
        title: 'مرخصی',
        dueAt: new Date('2026-11-08T20:30:00.000Z'), // 00:00 Tehran, 1405/08/18
      }),
    );

    await service.processDue(now);

    expect(notifications.createForUser.mock.calls[0][0].body).toBe(
      'مرخصی — 18 آبان 1405 (تمام روز)',
    );
  });

  it('delivers exactly once across two ticks', async () => {
    arm();

    const first = await service.processDue(now);
    // The row is still returned by the scan mock, simulating a stale/overlapping read.
    const second = await service.processDue(now);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(notifications.createForUser).toHaveBeenCalledTimes(1);
  });

  it('delivers exactly once when two workers race the same reminder', async () => {
    arm();

    // Both "workers" see the same due row and claim concurrently. Only the one whose
    // conditional UPDATE affects a row may notify.
    const [a, b] = await Promise.all([service.processDue(now), service.processDue(now)]);

    expect(a + b).toBe(1);
    expect(notifications.createForUser).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the claim was lost', async () => {
    const row = arm();
    // Another worker got there first.
    store.get(row.id)!.deliveredAt = new Date('2026-11-09T11:00:01.000Z');

    const delivered = await service.processDue(now);

    expect(delivered).toBe(0);
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });

  it('does not claim a disabled reminder even if the scan returned it', async () => {
    arm(due(), false);

    const delivered = await service.processDue(now);

    expect(delivered).toBe(0);
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });

  it('keeps the claim when the notification fails, so it cannot be sent twice', async () => {
    const row = arm();
    notifications.createForUser.mockRejectedValue(new Error('notification store down'));

    const delivered = await service.processDue(now);

    expect(delivered).toBe(0);
    // The claim stands: a retry would risk a duplicate, which is the worse failure.
    expect(store.get(row.id)!.deliveredAt).not.toBeNull();
  });

  it('survives a failing scan instead of crashing the process', async () => {
    prisma.reminder.findMany.mockRejectedValue(new Error('db unavailable'));

    await expect(service.processDue(now)).resolves.toBe(0);
  });

  it('does nothing after the module is destroyed', async () => {
    arm();
    service.onModuleDestroy();

    await expect(service.processDue(now)).resolves.toBe(0);
    expect(prisma.reminder.findMany).not.toHaveBeenCalled();
  });

  it('processes a whole batch in one tick', async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      due({ id: `reminder-${index}`, userId: `user-${index}` }),
    );

    for (const row of rows) store.set(row.id, { id: row.id, deliveredAt: null, enabled: true });
    prisma.reminder.findMany.mockResolvedValue(rows);

    await expect(service.processDue(now)).resolves.toBe(3);
    expect(notifications.createForUser).toHaveBeenCalledTimes(3);
  });
});
