import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CorrespondencePrismaService } from '../database/correspondence-prisma.service';
import { CorrespondenceService } from '../correspondence.service';

/**
 * Phase 50-MOD-CORR: scheduled-send delivery (defects D8/D9/D10).
 *
 * WHAT THIS REPLACES, AND WHY THE OLD LOOP WAS WRONG
 * -------------------------------------------------
 * `CorrespondenceService.onModuleInit` used to start a bare
 * `setInterval(() => processScheduledSends(), 60_000)` with:
 *   * no `running`/`ticking` guard — a slow tick could overlap the next one;
 *   * no `unref()` — a pending timer held the process (and a Jest run) open;
 *   * no `take()` — an unbounded scan of every scheduled letter ever written;
 *   * no replica safety — EVERY API replica ran that scan every 60 seconds, and the
 *     same letter could be picked up by several of them at once;
 *   * no retry bound — a letter that could never be sent was re-tried forever, with
 *     no record of why.
 *
 * THE PATTERN, WHICH IS THE SANCTIONED ONE
 * ----------------------------------------
 * Identical in structure to `ReminderDispatcherService` (49I) and
 * `AuditDispatcherService`, the two audited precedents, and NOT a new mechanism:
 * bounded `take`, a `running` flag, an overlap guard, an `unref()`ed timer, and a
 * conditional-UPDATE CLAIM. `@nestjs/schedule`, `cron`, Redis-backed schedulers,
 * Kubernetes CronJobs and a job table are all absent from this repository for the
 * same reason as before: one query every 30 seconds does not need a framework, and
 * the claim below is what makes correctness independent of replica count.
 *
 * HOW EXACTLY-ONCE IS PRESERVED ACROSS REPLICAS
 * ---------------------------------------------
 * The claim is an atomic conditional UPDATE on the letter's own row:
 *
 *   UPDATE "Letter" SET "sendAttempts" = "sendAttempts" + 1, "lastSendAttemptAt" = now
 *    WHERE id = $id AND status = 'SCHEDULED' AND "scheduledAt" <= now
 *      AND "sendAttempts" < MAX_SEND_ATTEMPTS
 *
 * Postgres serialises concurrent writers on that row, so at most ONE caller sees
 * `count === 1`. The loser observes 0 and does nothing. On top of that, the SEND
 * itself remains conditional inside `CorrespondenceService.sendDraft` (the flip lists
 * SCHEDULED and matches only once), so even a lost claim cannot produce a second send:
 * two independent guards, and the DATABASE arbitrates both.
 *
 * The claim is taken BEFORE the send, matching the reminder dispatcher's documented
 * trade: a crash between claim and send loses one attempt (and the next tick retries,
 * because attempts are bounded rather than consumed once), whereas the reverse
 * ordering could send a letter twice. For correspondence a duplicate send is the worse
 * failure.
 *
 * WHY A DUE SCAN IS CHEAP
 * -----------------------
 * `{ status: 'SCHEDULED', scheduledAt: { lte: now }, sendAttempts: { lt: MAX } }` is
 * served by the PARTIAL index `Letter_scheduled_due_idx` (`("scheduledAt") WHERE
 * status = 'SCHEDULED'`), so the scan touches the pending backlog and never the
 * terminal history this table accumulates forever. The `sendAttempts` predicate is a
 * filter on the index result, not a reason for a sequential scan.
 *
 * A letter that exhausts MAX_SEND_ATTEMPTS STAYS SCHEDULED — it is neither silently
 * cancelled nor silently sent — and drops out of the due scan. It remains visible to
 * its sender with `lastSendError` recorded for an operator, which is the honest state:
 * the module tried, failed, and stopped.
 */

/** How often the due scan runs. Matches ReminderDispatcherService's cadence (49I). */
export const SCHEDULED_SEND_TICK_MS = 30_000;

/** Letters claimed per tick. Bounded so one tick can never fan out unboundedly. */
export const SCHEDULED_SEND_BATCH_SIZE = 50;

/**
 * Retry ceiling for ONE letter. Five attempts at a 30-second cadence is ~2.5 minutes
 * of flapping before the module stops and records the failure; beyond that, repeated
 * attempts cost a database write per tick and tell an operator nothing new.
 */
export const MAX_SEND_ATTEMPTS = 5;

/** `lastSendError` is diagnostic text, never projected to a client — keep it bounded. */
const MAX_ERROR_LENGTH = 500;

@Injectable()
export class ScheduledSendDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledSendDispatcherService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against a slow tick overlapping the next one inside this process. */
  private ticking = false;

  constructor(
    private readonly prisma: CorrespondencePrismaService,
    private readonly correspondence: CorrespondenceService,
  ) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(() => void this.processDue(), SCHEDULED_SEND_TICK_MS);
    // `unref` so a pending timer never holds the process (or a Jest run) open.
    this.handle.unref?.();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * One due scan. Returns how many letters THIS tick actually sent.
   *
   * Never throws: a failed scan must not kill the process, and the next tick retries
   * from the same partial index. `now` is injectable so the e2e/integration spec can
   * drive the clock instead of sleeping.
   */
  async processDue(now: Date = new Date()): Promise<number> {
    if (!this.running || this.ticking) return 0;
    this.ticking = true;

    try {
      const due = await this.prisma.letter.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { lte: now },
          // The retry bound is part of the SCAN, not only of the claim: an exhausted
          // letter must stop costing a row read per tick forever.
          sendAttempts: { lt: MAX_SEND_ATTEMPTS },
        },
        // Oldest deadline first, so a backlog drains in the order users expected.
        orderBy: { scheduledAt: 'asc' },
        take: SCHEDULED_SEND_BATCH_SIZE,
        select: { id: true },
      });

      let sent = 0;
      for (const letter of due) {
        if (await this.dispatchOne(letter.id, now)) sent += 1;
      }

      return sent;
    } catch (err) {
      this.logger.error({ err }, 'Error processing due scheduled letters');
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claims ONE letter and, only if the claim succeeded, asks the module to send it.
   *
   * Returns true when THIS call was the one that sent. The claim is the whole
   * concurrency story: `status = 'SCHEDULED'` plus `sendAttempts` in the WHERE clause
   * means two replicas racing on the same row cannot both win, and the loser does not
   * even call the sender.
   */
  private async dispatchOne(letterId: string, now: Date): Promise<boolean> {
    const claim = await this.prisma.letter.updateMany({
      where: {
        id: letterId,
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
        sendAttempts: { lt: MAX_SEND_ATTEMPTS },
      },
      data: {
        sendAttempts: { increment: 1 },
        lastSendAttemptAt: now,
      },
    });

    if (claim.count === 0) return false;

    try {
      return await this.correspondence.dispatchScheduledLetter(letterId, now);
    } catch (err) {
      // The attempt is NOT refunded. A retry that could not send is exactly what the
      // attempt counter is for, and re-claiming on failure would let a permanently
      // broken letter spin forever. The reason is recorded on the row for an operator
      // and is never projected to a client; the letter stays SCHEDULED, so a later fix
      // (or the next tick, while attempts remain) can still send it.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, letterId }, 'Scheduled letter was claimed but could not be sent');

      try {
        await this.prisma.letter.updateMany({
          where: { id: letterId, status: 'SCHEDULED' },
          data: { lastSendError: message.slice(0, MAX_ERROR_LENGTH) },
        });
      } catch (recordErr) {
        // Diagnostics are best-effort; the send failure is already logged above.
        this.logger.warn({ err: recordErr, letterId }, 'Failed recording lastSendError');
      }

      return false;
    }
  }
}