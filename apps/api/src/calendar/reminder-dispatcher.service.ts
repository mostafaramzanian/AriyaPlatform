import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { REMINDER_SOURCE_TYPE } from './reminder.service';
import {
  APP_TIME_ZONE,
  instantToJalaliDate,
  instantToZonedTime,
  JALALI_MONTHS,
} from './jalali.util';

/**
 * Phase 49I: reminder delivery.
 *
 * WHY A BOUNDED POLLING LOOP AND NOTHING ELSE
 *
 * The repository already contains exactly this mechanism: AuditDispatcherService
 * (`src/common/audit-dispatcher.service.ts`) is a `setInterval` that selects rows
 * whose `nextAt <= now`, acts on a bounded batch, and stops on module destroy. That
 * is the audited precedent this class follows deliberately, rather than introducing:
 *
 *  - `@nestjs/schedule` / `cron` — neither is a dependency (verified: absent from
 *    node_modules and from apps/api/package.json), and adding a scheduling framework
 *    to run one query every 30 seconds buys nothing this loop does not already do;
 *  - Redis Pub/Sub, Redis Streams, Kafka, RabbitMQ-as-scheduler, Kubernetes CronJobs
 *    or an external cron service — all forbidden by the contract absent repository
 *    evidence, and there is none: no queue table, no job model, no worker process.
 *
 * WHY IT DOES NOT DUPLICATE NOTIFICATIONS
 *
 * Delivery is claimed with a conditional UPDATE on the reminder's own row:
 *
 *   UPDATE "Reminder" SET "deliveredAt" = $now
 *    WHERE id = $id AND "deliveredAt" IS NULL AND "enabled"
 *
 * Postgres serialises concurrent writers on that row, so at most ONE caller sees
 * `count === 1`, and only that caller creates the Notification. A second API
 * instance, a restart mid-tick, an overlapping tick, a retry or a duplicate poll all
 * observe `count === 0` and do nothing. Nothing about correctness depends on there
 * being a single process, and no advisory lock, queue or job table is required.
 *
 * The claim is taken BEFORE the notification is created. That ordering is the
 * deliberate trade: a crash between the two loses at most one notification, whereas
 * the reverse ordering could deliver the same reminder twice. For a reminder, a
 * duplicate is the worse failure.
 */

/** How often the due scan runs. Matches AuditDispatcherService's cadence. */
export const REMINDER_TICK_MS = 30_000;

/** Rows claimed per tick. Bounded so one tick can never fan out unboundedly. */
export const REMINDER_BATCH_SIZE = 100;

/** Notification copy. Persian, plain text — NotificationService refuses markup. */
export const REMINDER_NOTIFICATION_TITLE = 'یادآوری';

@Injectable()
export class ReminderDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderDispatcherService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against a slow tick overlapping the next one inside this process. */
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(() => void this.processDue(), REMINDER_TICK_MS);
    // `unref` so a pending timer never holds the process (or a Jest run) open.
    this.handle.unref?.();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * One tick: claim due reminders and notify their owners.
   *
   * Returns the number of notifications actually created, so a test can assert
   * exactly-once behaviour by ticking twice and expecting 0 the second time.
   */
  async processDue(now: Date = new Date()): Promise<number> {
    if (!this.running || this.ticking) return 0;
    this.ticking = true;

    try {
      // Bounded, index-only predicate: this is precisely the partial index
      // `Reminder_pending_dueAt_idx` (enabled AND deliveredAt IS NULL), so the scan
      // touches the pending backlog rather than the whole table.
      const due = await this.prisma.reminder.findMany({
        where: { enabled: true, deliveredAt: null, dueAt: { lte: now } },
        orderBy: { dueAt: 'asc' },
        take: REMINDER_BATCH_SIZE,
        select: { id: true, userId: true, title: true, dueAt: true, allDay: true },
      });

      let delivered = 0;

      for (const reminder of due) {
        if (await this.deliverOne(reminder, now)) delivered += 1;
      }

      return delivered;
    } catch (err) {
      // A failed tick must never crash the process: the next tick retries, and an
      // unclaimed reminder is still in the index.
      this.logger.error({ err }, 'Error processing due reminders');
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claims one reminder and, only if the claim succeeded, creates its notification.
   *
   * Returns true when THIS call was the one that delivered.
   */
  private async deliverOne(
    reminder: { id: string; userId: string; title: string; dueAt: Date; allDay: boolean },
    now: Date,
  ): Promise<boolean> {
    // THE claim. `deliveredAt: null` in the WHERE clause is what makes delivery
    // idempotent: a concurrent worker's update matches zero rows.
    const claim = await this.prisma.reminder.updateMany({
      where: { id: reminder.id, deliveredAt: null, enabled: true },
      data: { deliveredAt: now },
    });

    if (claim.count === 0) return false;

    try {
      await this.notifications.createForUser({
        userId: reminder.userId,
        type: NotificationType.INFORMATION,
        title: REMINDER_NOTIFICATION_TITLE,
        body: this.body(reminder),
        sourceType: REMINDER_SOURCE_TYPE,
        sourceId: reminder.id,
      });

      return true;
    } catch (err) {
      // The claim is NOT rolled back. Retrying would risk a duplicate notification,
      // and a reminder is a nudge: losing one is strictly better than sending it
      // twice. The failure is logged with the id so it is diagnosable.
      this.logger.warn(
        { err, reminderId: reminder.id },
        'Reminder was claimed but its notification could not be created',
      );

      return false;
    }
  }

  /**
   * Notification body. Plain text with no markup, because NotificationService
   * refuses `<`/`>` outright rather than escaping them.
   *
   * The time is rendered in `Asia/Tehran` — the same zone the user entered it in —
   * and an all-day reminder shows its Jalali date instead of a clock time, since it
   * has no meaningful one.
   */
  private body(reminder: { title: string; dueAt: Date; allDay: boolean }): string {
    if (reminder.allDay) {
      const date = instantToJalaliDate(reminder.dueAt, APP_TIME_ZONE);
      return `${reminder.title} — ${date.jd} ${JALALI_MONTHS[date.jm - 1]} ${date.jy} (تمام روز)`;
    }

    const { hour, minute } = instantToZonedTime(reminder.dueAt, APP_TIME_ZONE);
    const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    return `${reminder.title} — ساعت ${clock}`;
  }
}
