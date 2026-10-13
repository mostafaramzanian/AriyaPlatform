import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IntegrationService } from './integration.service';

/**
 * Phase 49L §21: the bounded retry pass.
 *
 * WHY A `setInterval` AND NOTHING ELSE
 * ------------------------------------
 * The repository already contains exactly this mechanism, twice:
 * `AuditDispatcherService` (`src/common/audit-dispatcher.service.ts`) and
 * `ReminderDispatcherService` (49I) are both `setInterval` loops that select rows
 * whose due time has passed, act on a BOUNDED batch, and stop on module destroy.
 * That is the audited precedent this class follows deliberately, rather than
 * introducing:
 *
 *  - `@nestjs/schedule` / `cron` — neither is a dependency (verified: absent from
 *    `apps/api/package.json`), and adding a scheduling framework to run one query
 *    every 30 seconds buys nothing this loop does not already do;
 *  - Redis Pub/Sub, Redis Streams, Kafka, RabbitMQ-as-scheduler or Kubernetes
 *    CronJobs — all forbidden by §1 absent repository evidence, and there is none:
 *    no queue table, no job model, no worker process.
 *
 * RabbitMQ IS present and IS used (`NotificationPublisher`), so it deserves an
 * explicit answer rather than a blanket refusal: it publishes audit events onto a
 * topic exchange, fire-and-forget, with no consumer in this repository and no
 * delayed-delivery plugin configured. Using it as a retry timer would mean adding a
 * consumer process and a delay mechanism — new infrastructure — to replace a
 * conditional UPDATE that already gives exactly-once claiming.
 *
 * WHY IT IS SAFE WITH SEVERAL API INSTANCES
 * -----------------------------------------
 * It does not rely on being alone. `IntegrationService.processRetries` claims each
 * row with a conditional UPDATE, so a second instance's claim matches zero rows and
 * it does nothing. Correctness comes from Postgres row locking, not from process
 * topology.
 */

/** How often the due scan runs. Matches AuditDispatcherService's cadence. */
export const RETRY_TICK_MS = 30_000;

@Injectable()
export class AutomationRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationRetryService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against a slow tick overlapping the next one inside this process. */
  private ticking = false;

  constructor(private readonly integrations: IntegrationService) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(() => void this.tick(), RETRY_TICK_MS);
    // `unref` so a pending timer never holds the process — or a Jest run — open.
    this.handle.unref?.();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * One pass. Exported for tests, which call it directly rather than waiting on a
   * timer — the same shape `ReminderDispatcherService.processDue` uses.
   *
   * NO UNBOUNDED WORK AND NO THROW. The batch size is fixed in
   * `IntegrationService.processRetries`, and a failure is logged rather than
   * propagated: an unhandled rejection in a timer callback terminates the Node
   * process, which would turn a misconfigured integration into an outage.
   */
  async tick(): Promise<number> {
    if (!this.running || this.ticking) return 0;
    this.ticking = true;

    try {
      return await this.integrations.processRetries();
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : 'unknown' },
        'Automation retry pass failed',
      );
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}
