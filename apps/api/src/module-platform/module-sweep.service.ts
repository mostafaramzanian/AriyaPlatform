import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRegistryService } from './module-registry.service';
import { MODULE_HEARTBEAT_INTERVAL_MS } from './module.contract';

/**
 * Phase 49M §14/§45: the bounded staleness sweep.
 *
 * WHY A `setInterval` AND NOTHING ELSE
 * ------------------------------------
 * The repository already contains exactly this mechanism, three times:
 * `AuditDispatcherService` (`src/common/audit-dispatcher.service.ts`),
 * `ReminderDispatcherService` (49I) and `AutomationRetryService` (49L) are all `setInterval`
 * loops that act on a BOUNDED batch and stop on module destroy. That is the audited precedent
 * this class follows, rather than introducing:
 *
 *  - `@nestjs/schedule` / `cron` — neither is a dependency (re-verified: absent from
 *    `apps/api/package.json`), and adding a scheduling framework to run one query per minute
 *    buys nothing this loop does not already do;
 *  - Kafka, Redis Pub/Sub, Redis Streams, RabbitMQ-as-scheduler or Kubernetes CronJobs — §3
 *    forbids introducing any of them for this phase, and there is nothing here they would make
 *    possible.
 *
 * THIS SWEEP MAKES NO NETWORK CALLS, and that is the §14/§45 point. It is a DATABASE query
 * against the partial index: instances whose `lastSeenAt` is older than the threshold are
 * demoted to UNAVAILABLE. Health arrives by HEARTBEAT — modules pushing to Core — rather than
 * by Core polling every module every minute, which is what "no excessive requests" and "no
 * unbounded polling" mean in practice. A live probe happens only when an administrator asks for
 * one.
 *
 * WHY IT IS SAFE WITH SEVERAL API INSTANCES
 * -----------------------------------------
 * It needs no claim and no lock, unlike 49L's retry pass. The update is IDEMPOTENT: marking an
 * already-UNAVAILABLE instance UNAVAILABLE is a no-op, so two processes sweeping concurrently
 * produce the same state as one. Correctness comes from the operation's shape, not from
 * process topology.
 */

/**
 * How often the sweep runs.
 *
 * ONE HEARTBEAT INTERVAL (30s), against a 90s stale threshold. Deliberately faster than the
 * threshold rather than equal to it: a sweep interval equal to the threshold would let an
 * instance sit up to one full interval past its deadline before anything noticed, so worst-case
 * detection latency would be 180s rather than the ~120s this gives.
 */
export const SWEEP_TICK_MS = MODULE_HEARTBEAT_INTERVAL_MS;

@Injectable()
export class ModuleSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModuleSweepService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against a slow tick overlapping the next one inside this process. */
  private ticking = false;

  constructor(private readonly registry: ModuleRegistryService) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(() => void this.tick(), SWEEP_TICK_MS);
    // `unref` so a pending timer never holds the process — or a Jest run — open.
    this.handle.unref?.();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * One pass. Exported for tests, which call it directly rather than waiting on a timer — the
   * same shape `AutomationRetryService.tick` and `ReminderDispatcherService.processDue` use.
   *
   * NO UNBOUNDED WORK AND NO THROW. The batch size is fixed in
   * `ModuleRegistryService.sweepStaleInstances`, and a failure is logged rather than propagated:
   * an unhandled rejection in a timer callback terminates the Node process, which would turn one
   * bad row into an outage.
   */
  async tick(): Promise<number> {
    if (!this.running || this.ticking) return 0;
    this.ticking = true;

    try {
      return await this.registry.sweepStaleInstances();
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : 'unknown' },
        'Module staleness sweep failed',
      );
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}
