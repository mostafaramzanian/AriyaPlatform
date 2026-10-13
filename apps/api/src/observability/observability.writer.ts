import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { ObservabilityConfigService } from './observability.config';
import { DROPPABLE_LEVELS, LogLevelValue, WriterStats } from './observability.contract';

/**
 * Phase 49M-2 §22: the bounded, batching, droppable log writer.
 *
 * THIS CLASS IS THE REASON THE PHASE IS SAFE. Everything about it exists to guarantee one
 * property: NO BUSINESS REQUEST EVER WAITS ON, OR FAILS BECAUSE OF, A LOG WRITE.
 *
 * FOUR MECHANISMS, EACH ANSWERING A SPECIFIC FAILURE
 * --------------------------------------------------
 * 1. A BOUNDED ARRAY (`queueMax`). The naive implementation — `void prisma.create()` per
 *    log line — creates one unawaited promise per line. Under a traffic spike, or with the
 *    database slow, those accumulate without limit and the process dies of memory
 *    exhaustion while appearing healthy. A bounded queue converts an unbounded memory
 *    failure into a counted, reported drop.
 *
 * 2. BATCH `createMany`. 500 individual inserts are 500 round trips; one `createMany` of
 *    500 rows is one. At the volume this table sees — recall 21,401 `validation_failed`
 *    rows in five weeks from ONE code path — per-row inserts would make the observability
 *    database the slowest thing in the system.
 *
 * 3. A DROP POLICY WITH AN ORDER (TRACE → DEBUG → INFO → WARN). When the queue is full,
 *    something must be discarded, and discarding the NEWEST arrival is wrong: the newest
 *    line is the one describing the incident in progress. So the writer evicts the
 *    LOWEST-VALUE line instead, and ERROR/FATAL are never evicted.
 *
 * 4. A FINITE WRITE TIMEOUT. `createMany` against a hung connection can wait a very long
 *    time. Without a timeout the flush loop stops flushing, the queue fills, and every
 *    subsequent line is dropped — one stuck query silently disables all logging.
 *
 * WHY IT IS NOT A WORKER THREAD, A REDIS BUFFER OR KAFKA: a batching in-process queue is
 * the mechanism this repository already uses for deferred work (`AuditDispatcherService`,
 * `ReminderDispatcherService`, `AutomationRetryService`, `ModuleSweepService`), and none of
 * those alternatives is a dependency. Adding one would trade a bounded array for a network
 * hop that has its own failure modes — and something would still have to decide what to
 * do when it is unavailable.
 */

/** One pending row. `Record` rather than the Prisma input type, to keep the queue plain. */
type PendingLogRow = Record<string, unknown> & { level: LogLevelValue };

@Injectable()
export class ObservabilityWriter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObservabilityWriter.name);

  private queue: PendingLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private flushing = false;
  /**
   * Chain of flushes triggered by a full queue.
   *
   * `enqueue` is synchronous, so a batch-size-triggered flush cannot be awaited by its
   * caller — but SOMETHING has to be able to await it, or `onModuleDestroy` can return while
   * a write is still in flight and the process exits mid-batch. Chaining rather than firing
   * and forgetting keeps every triggered flush reachable from `drain()`.
   */
  private pending: Promise<void> = Promise.resolve();

  private enqueued = 0;
  private written = 0;
  private dropped = 0;
  private failedBatches = 0;
  private lastFlushAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastErrorMessage: string | null = null;

  constructor(
    private readonly prisma: ObservabilityPrismaService,
    private readonly config: ObservabilityConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.enabled) {
      this.logger.log('Observability writer disabled (OBSERVABILITY_ENABLED is not "true")');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    // `unref` so a pending timer never holds the process — or a Jest run — open. Same
    // reasoning as ModuleSweepService and AutomationRetryService.
    this.timer.unref?.();
  }

  /**
   * Stops the loop and makes ONE last flush attempt.
   *
   * THE FINAL FLUSH IS THE POINT. Without it, everything buffered since the last tick is
   * lost on every deploy — and the lines written immediately before a shutdown are
   * disproportionately the ones explaining WHY the process is going down.
   *
   * It is awaited but cannot hang: `writeBatch` carries its own timeout.
   */
  async onModuleDestroy() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Awaits any flush already in flight FIRST, so the final flush cannot be skipped by the
    // `flushing` guard while a triggered write is still settling.
    await this.drain();
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  /**
   * Accepts one row, or drops one.
   *
   * SYNCHRONOUS AND `void`. It performs no I/O and returns no promise, so a caller cannot
   * accidentally await a log line, and there is no unhandled-rejection surface. The whole
   * cost on the request path is an array push.
   *
   * RETURNS `true` only if the row was accepted, purely so tests can assert the drop
   * policy; no production caller inspects it.
   */
  enqueue(row: PendingLogRow): boolean {
    if (!this.config.enabled) return false;

    this.enqueued += 1;

    if (this.queue.length >= this.config.queueMax) {
      const evictedIndex = this.findEvictionIndex();
      if (evictedIndex === -1) {
        // The queue is full of ERROR/FATAL rows and the newcomer is droppable. Refusing
        // the newcomer is correct: a queue of nothing but errors is the state where the
        // errors matter most.
        this.dropped += 1;
        return false;
      }
      this.queue.splice(evictedIndex, 1);
      this.dropped += 1;
    }

    this.queue.push(row);

    // A queue that reaches batch size before the tick is flushed immediately, so a burst
    // is written at burst speed rather than waiting out the interval. Chained onto `pending`
    // so `drain()` — and therefore shutdown and the tests — can await it.
    if (this.queue.length >= this.config.batchSize && !this.flushing) {
      this.pending = this.pending.then(() => this.flush());
    }
    return true;
  }

  /**
   * Awaits every flush this writer has started, including ones triggered from `enqueue`.
   *
   * EXISTS BECAUSE `enqueue` IS SYNCHRONOUS BY DESIGN. Callers must not await a log line, so
   * a batch-triggered flush is unawaitable at its call site; without `drain` a shutdown or a
   * test could observe the writer between "batch removed from the queue" and "batch written",
   * which looks exactly like data loss.
   */
  async drain(): Promise<void> {
    await this.pending;
  }

  /**
   * Chooses the row to evict: the OLDEST row at the LOWEST droppable level present.
   *
   * TRACE FIRST, THEN DEBUG, THEN INFO, THEN WARN. Scanning by level rather than simply
   * dropping the head means a full queue sheds its least valuable content instead of its
   * oldest — the head might be the ERROR that started the incident.
   *
   * Returns -1 when every queued row is ERROR or FATAL, which the caller reads as "refuse
   * the newcomer rather than evict an error".
   */
  private findEvictionIndex(): number {
    for (const level of DROPPABLE_LEVELS) {
      const index = this.queue.findIndex((row) => row.level === level);
      if (index !== -1) return index;
    }
    return -1;
  }

  /**
   * Writes at most one batch.
   *
   * NEVER THROWS AND NEVER OVERLAPS. `flushing` guards against a slow write being
   * re-entered by the next tick — the same guard `ModuleSweepService` uses — because two
   * concurrent flushes could interleave `splice` calls and duplicate or lose rows.
   *
   * A FAILED BATCH IS DISCARDED, NOT REQUEUED. Requeueing looks kinder and is worse: if the
   * database is down, a requeued batch is retried forever while new lines are dropped to
   * make room, so the platform ends up preserving the oldest data and losing everything
   * current. The loss is counted in `failedBatches` and surfaced by the health probe.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    if (!this.config.enabled) return;

    this.flushing = true;
    const batch = this.queue.splice(0, this.config.batchSize);

    try {
      await this.writeBatch(batch);
      this.written += batch.length;
      this.lastFlushAt = new Date();
    } catch (err) {
      this.failedBatches += 1;
      this.dropped += batch.length;
      this.lastErrorAt = new Date();
      this.lastErrorMessage = err instanceof Error ? err.message : 'unknown write error';
      // pino, NOT this platform: routing an observability failure back into the
      // observability queue is how a failing writer generates infinite work for itself.
      this.logger.warn(
        { failedBatches: this.failedBatches, droppedRows: batch.length, err: this.lastErrorMessage },
        'Observability batch write failed; rows discarded',
      );
    } finally {
      this.flushing = false;
    }
  }

  /**
   * The actual insert, wrapped in a race against a timer.
   *
   * `Promise.race` RATHER THAN A PRISMA-LEVEL TIMEOUT: Prisma 5's `createMany` has no
   * per-query timeout option, and `statement_timeout` would have to be set on the
   * connection for every query including the reads. The race bounds exactly this call.
   *
   * `skipDuplicates: false` is the default and is correct: every row has a fresh uuid, so a
   * duplicate would indicate a bug worth surfacing rather than silently absorbing.
   */
  private async writeBatch(batch: PendingLogRow[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`observability write exceeded ${this.config.writeTimeoutMs}ms`)),
        this.config.writeTimeoutMs,
      );
      timer.unref?.();
    });

    try {
      await Promise.race([
        this.prisma.applicationLog.createMany({ data: batch as never }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Writer state for the health probe and the metrics surface.
   *
   * `dropped` IS WHY THIS METHOD EXISTS. A platform that silently discards rows under
   * pressure and reports nothing is worse than one that does not log at all, because it
   * lies to whoever is reading the table during an incident.
   */
  stats(): WriterStats {
    return {
      queued: this.queue.length,
      queueCapacity: this.config.queueMax,
      enqueued: this.enqueued,
      written: this.written,
      dropped: this.dropped,
      failedBatches: this.failedBatches,
      lastFlushAt: this.lastFlushAt ? this.lastFlushAt.toISOString() : null,
      lastErrorAt: this.lastErrorAt ? this.lastErrorAt.toISOString() : null,
      lastErrorMessage: this.lastErrorMessage,
      flushing: this.flushing,
    };
  }

  /** Whether the periodic loop is active. Read by the health probe. */
  isRunning(): boolean {
    return this.running;
  }
}
