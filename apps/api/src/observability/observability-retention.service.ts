import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { ObservabilityConfigService, RETENTION_DISABLED, RetentionCategory } from './observability.config';


/**
 * Phase 49M-2: bounded retention.
 *
 * WHY THIS SERVICE IS NOT OPTIONAL. An observability platform without retention is a disk
 * that fills. `ApplicationLog` receives a row per request, and the recorded evidence for
 * this installation — 35,757 rows in five weeks from a fraction of the eventual emit sites —
 * means a year of unpruned logging is millions of rows in the table an operator queries
 * during an incident.
 *
 * WHY IT DELETES IN BOUNDED CHUNKS RATHER THAN ONE STATEMENT. A single
 * `DELETE FROM "ApplicationLog" WHERE "occurredAt" < cutoff` over a million rows takes one
 * long transaction, holds locks, and produces a WAL spike that stalls concurrent inserts —
 * so the cleanup would degrade the very writes it exists to protect. Deleting
 * `DELETE_CHUNK_SIZE` rows at a time keeps each transaction short and lets normal traffic
 * interleave. `truncated: true` on the `RetentionRun` row records that a cap was hit and
 * the next pass has more to do, so a chunk limit never looks like completion.
 *
 * WHY `setInterval` AND NOT `@nestjs/schedule`: neither `@nestjs/schedule` nor `cron` is a
 * dependency (re-verified against `apps/api/package.json`), and this repository already runs
 * four periodic loops this exact way — `AuditDispatcherService`, `ReminderDispatcherService`
 * (49I), `AutomationRetryService` (49L) and `ModuleSweepService` (49M). Adding a scheduling
 * framework to run four DELETEs a day buys nothing.
 *
 * WHY IT IS SAFE WITH SEVERAL API INSTANCES. It needs no lock and no claim, because the
 * operation is IDEMPOTENT and CONVERGENT: two processes deleting rows older than the same
 * cutoff cannot delete the same row twice, and whichever gets there first simply leaves less
 * for the other. Duplicate `RetentionRun` rows for one window are honest history — each
 * records what that process actually deleted.
 *
 * IT NEVER TOUCHES core_db. Retention here operates only on the four observability tables;
 * `AuditLog` in core_db is out of scope by §51 and is not pruned by anything in this phase.
 */

/** Rows deleted per statement. Small enough that one DELETE is a short transaction. */
export const DELETE_CHUNK_SIZE = 5_000;

/** Chunks per category per pass, so one tick has a hard upper bound of work. */
export const MAX_CHUNKS_PER_RUN = 20;

/**
 * How often retention runs.
 *
 * SIX HOURS, not daily: a daily pass concentrates all deletion into one window, and if the
 * process happens to be restarting then, retention silently does not happen that day. Four
 * smaller passes converge on the same steady state with a quarter of the per-pass work.
 */
export const RETENTION_TICK_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the first pass after boot.
 *
 * Deliberately not immediate. Startup is when connection pools warm and migrations settle,
 * and a bulk DELETE competing with that is a self-inflicted slow start.
 */
export const RETENTION_START_DELAY_MS = 60_000;

@Injectable()
export class ObservabilityRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObservabilityRetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against a slow pass overlapping the next tick inside this process. */
  private ticking = false;

  constructor(
    private readonly prisma: ObservabilityPrismaService,
    private readonly config: ObservabilityConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.enabled) return;
    this.running = true;
    this.startTimer = setTimeout(() => void this.tick(), RETENTION_START_DELAY_MS);
    this.startTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), RETENTION_TICK_MS);
    // `unref` so a pending timer never holds the process — or a Jest run — open.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
  }

  /** One pass over all four categories. Never throws; each category is independent. */
  async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      // Sequential, not `Promise.all`. Four concurrent bulk DELETEs against one database
      // is exactly the load spike the chunking exists to avoid.
      for (const category of [
        'application_log',
        'audit_event',
        'security_event',
        'lifecycle_event',
      ] as RetentionCategory[]) {
        await this.runCategory(category);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Prunes one category and records exactly one `RetentionRun` row.
   *
   * THE ROW IS WRITTEN EVEN WHEN THE PASS FAILS, with `succeeded: false` and the error
   * message. A retention table that only records successes cannot answer the one question it
   * exists for — "is retention actually running?" — because a silent absence of rows looks
   * identical to a healthy system that had nothing to delete.
   */
  async runCategory(category: RetentionCategory): Promise<void> {
    const startedAt = Date.now();
    const days = this.config.retentionDaysFor(category);

    // 0 MEANS NEVER DELETE. No RetentionRun row is written for a disabled category either:
    // a row recording `deletedCount: 0` would be indistinguishable from a healthy pass that
    // found nothing, and would hide the fact that retention is switched off for that table.
    if (days === RETENTION_DISABLED) return;

    const cutoff = new Date(startedAt - days * 24 * 60 * 60 * 1000);

    let deletedCount = 0;
    let truncated = false;
    let succeeded = false;
    let errorMessage: string | null = null;

    try {
      for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk += 1) {
        const deleted = await this.deleteChunk(category, cutoff);
        deletedCount += deleted;
        if (deleted < DELETE_CHUNK_SIZE) break;
        // Hit the per-pass ceiling with rows still older than the cutoff: report it rather
        // than looping, so one pass can never become an unbounded delete storm.
        if (chunk === MAX_CHUNKS_PER_RUN - 1) truncated = true;
      }
      succeeded = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'unknown retention error';
      this.logger.warn({ category, err: errorMessage }, 'Retention pass failed');
    }

    const durationMs = Date.now() - startedAt;

    try {
      await this.prisma.retentionRun.create({
        data: {
          category,
          cutoff,
          deletedCount,
          truncated,
          succeeded,
          errorMessage: errorMessage ? errorMessage.slice(0, 500) : null,
          finishedAt: new Date(),
          durationMs,
        },
      });
    } catch (err) {
      // If even the bookkeeping row cannot be written the database is unavailable, and the
      // only remaining channel is pino. Retrying here would just fail again.
      this.logger.warn(
        { category, err: err instanceof Error ? err.message : 'unknown' },
        'Failed to record RetentionRun row',
      );
    }
  }

  /**
   * Deletes one bounded chunk from one table.
   *
   * `deleteMany` HAS NO `LIMIT` IN PRISMA, so the chunk is expressed as a subquery on `id`
   * via `$executeRaw`. The alternative — selecting ids then deleting by `IN (...)` — is two
   * round trips and a parameter list of 5,000 uuids per chunk.
   *
   * The table name is NOT interpolated from caller input: it comes from this `switch`, so
   * every SQL string here is a compile-time constant and there is no injection surface even
   * though raw SQL is involved. `cutoff` is a bound parameter.
   */
  private async deleteChunk(category: RetentionCategory, cutoff: Date): Promise<number> {
    switch (category) {
      case 'application_log':
        return this.prisma.$executeRaw`
          DELETE FROM "ApplicationLog"
          WHERE "id" IN (
            SELECT "id" FROM "ApplicationLog"
            WHERE "occurredAt" < ${cutoff}
            LIMIT ${DELETE_CHUNK_SIZE}
          )`;
      case 'audit_event':
        return this.prisma.$executeRaw`
          DELETE FROM "AuditEvent"
          WHERE "id" IN (
            SELECT "id" FROM "AuditEvent"
            WHERE "occurredAt" < ${cutoff}
            LIMIT ${DELETE_CHUNK_SIZE}
          )`;
      case 'security_event':
        return this.prisma.$executeRaw`
          DELETE FROM "SecurityEvent"
          WHERE "id" IN (
            SELECT "id" FROM "SecurityEvent"
            WHERE "occurredAt" < ${cutoff}
            LIMIT ${DELETE_CHUNK_SIZE}
          )`;
      case 'lifecycle_event':
        return this.prisma.$executeRaw`
          DELETE FROM "LifecycleEvent"
          WHERE "id" IN (
            SELECT "id" FROM "LifecycleEvent"
            WHERE "occurredAt" < ${cutoff}
            LIMIT ${DELETE_CHUNK_SIZE}
          )`;
    }
  }
}
