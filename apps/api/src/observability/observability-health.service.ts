import { Injectable } from '@nestjs/common';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { ObservabilityAuditService } from './observability-audit.service';
import { ObservabilityConfigService } from './observability.config';
import { ObservabilityService } from './observability.service';

/**
 * Phase 49M-2: the observability health probe and the metrics surface.
 *
 * WHY OBSERVABILITY NEEDS ITS OWN HEALTH ANSWER. The existing `/health` reports on core_db,
 * Redis and RabbitMQ. If it also reported observability, an unreachable log database would
 * make the whole API look unhealthy and a load balancer would pull a process that is
 * perfectly capable of serving business traffic. Logging is OPTIONAL infrastructure; its
 * failure must be visible without being fatal.
 *
 * THE PROBE ANSWERS THREE SEPARATE QUESTIONS, because "is logging working" has three
 * independent failure modes:
 *   1. CONNECTIVITY  — can we reach observability_db at all (`ping`)?
 *   2. WRITE STATE   — are batches succeeding, and how many rows have been dropped?
 *   3. TRAIL STATE   — have any DURABLE audit/security writes failed?
 * A system can pass (1) and fail (2) — a connection that establishes but times out on write
 * is the classic case, and a single boolean would hide it.
 *
 * `degraded` RATHER THAN `unhealthy` FOR DROPS. Dropped rows mean the platform is under
 * pressure and shedding its droppable tier as designed; that is a signal to investigate, not
 * an outage. A FAILED DURABLE WRITE is different — it means the audit trail has holes — so
 * that reports `unhealthy`.
 *
 * THE METRICS SURFACE IS PROVIDER-NEUTRAL. `metrics()` returns plain
 * `{ name, value, labels }` records. `prom-client` is NOT a dependency of this repository,
 * and adding a Prometheus registry would make an exporter mandatory for everyone. Whoever
 * eventually wants Prometheus, OTLP or StatsD reads this array and formats it; nothing here
 * assumes which.
 */

export type ObservabilityHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled';

export interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

@Injectable()
export class ObservabilityHealthService {
  constructor(
    private readonly prisma: ObservabilityPrismaService,
    private readonly config: ObservabilityConfigService,
    private readonly logs: ObservabilityService,
    private readonly durable: ObservabilityAuditService,
  ) {}

  /**
   * Full probe. Includes one `SELECT 1`, so it is cheap but not free — it is a poll target,
   * never something a request path calls.
   */
  async check(): Promise<Record<string, unknown>> {
    if (!this.config.enabled) {
      // DISABLED IS NOT A FAILURE. An installation that never set OBSERVABILITY_ENABLED is
      // correctly configured for its choice, and reporting it as unhealthy would train
      // operators to ignore this endpoint.
      return {
        status: 'disabled' as ObservabilityHealthStatus,
        reason: 'OBSERVABILITY_ENABLED is not "true"',
        config: this.config.describe(),
      };
    }

    const reachable = await this.prisma.ping();
    const writer = this.logs.stats();
    const durable = this.durable.stats();
    const status = this.deriveStatus(reachable, writer.dropped, writer.failedBatches, durable);

    return {
      status,
      database: {
        reachable,
        error: this.prisma.connectionError(),
      },
      writer: {
        ...writer,
        // The single most useful derived number: a queue near capacity means drops are
        // imminent, which is visible here before any row is actually lost.
        queueUtilization: writer.queueCapacity > 0 ? writer.queued / writer.queueCapacity : 0,
      },
      durable,
      config: this.config.describe(),
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Maps raw counters onto one status word.
   *
   * ORDERED WORST-FIRST, and the ordering encodes the design: unreachable database or a
   * failed DURABLE write is `unhealthy` because the audit trail is incomplete; dropped rows
   * or failed batches are `degraded` because the droppable tier did exactly what it promised
   * to do under pressure. Collapsing those two into one state would either cry wolf over a
   * dropped DEBUG line or stay silent about a missing audit record.
   */
  private deriveStatus(
    reachable: boolean,
    dropped: number,
    failedBatches: number,
    durable: Record<string, unknown>,
  ): ObservabilityHealthStatus {
    if (!reachable) return 'unhealthy';

    const durableFailures =
      Number(durable.auditFailed ?? 0) +
      Number(durable.securityFailed ?? 0) +
      Number(durable.lifecycleFailed ?? 0);
    if (durableFailures > 0) return 'unhealthy';

    if (dropped > 0 || failedBatches > 0) return 'degraded';
    return 'healthy';
  }

  /**
   * The same numbers as a flat, provider-neutral metric list.
   *
   * COUNTERS ARE CUMULATIVE PER PROCESS and gauges are instantaneous, following the
   * conventions every metrics backend shares, so a scraper can compute rates without this
   * code knowing what a scraper is. No `prom-client`, no registry, no exporter dependency —
   * see the class comment.
   */
  metrics(): MetricSample[] {
    const writer = this.logs.stats();
    const durable = this.durable.stats();
    const labels = {
      service: this.config.identity.service,
      environment: this.config.identity.environment,
    };

    return [
      { name: 'observability_enabled', value: this.config.enabled ? 1 : 0, labels },
      { name: 'observability_queue_depth', value: writer.queued, labels },
      { name: 'observability_queue_capacity', value: writer.queueCapacity, labels },
      { name: 'observability_rows_enqueued_total', value: writer.enqueued, labels },
      { name: 'observability_rows_written_total', value: writer.written, labels },
      { name: 'observability_rows_dropped_total', value: writer.dropped, labels },
      { name: 'observability_batches_failed_total', value: writer.failedBatches, labels },
      { name: 'observability_unknown_message_code_total', value: writer.rejectedUnknownCode, labels },
      { name: 'observability_audit_written_total', value: Number(durable.auditWritten ?? 0), labels },
      { name: 'observability_audit_failed_total', value: Number(durable.auditFailed ?? 0), labels },
      { name: 'observability_security_written_total', value: Number(durable.securityWritten ?? 0), labels },
      { name: 'observability_security_failed_total', value: Number(durable.securityFailed ?? 0), labels },
      { name: 'observability_lifecycle_written_total', value: Number(durable.lifecycleWritten ?? 0), labels },
      { name: 'observability_lifecycle_failed_total', value: Number(durable.lifecycleFailed ?? 0), labels },
    ];
  }
}
