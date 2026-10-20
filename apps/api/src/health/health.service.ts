import { Injectable, Logger } from '@nestjs/common';
import { DatasourceHealthProbe } from './datasource-health.probe';
import { InfrastructureHealthProbe } from './infrastructure-health.probe';
import { ReadinessEvaluator } from './readiness.evaluator';
import { RevocationFeedProbe } from './revocation-feed.probe';
import { ProbeResult, ReadinessReport, sanitizeDetail } from './health.contract';

/**
 * Phase ARCH-1.3: `HealthService` is a FACADE, and deliberately a thin one.
 *
 * Before ARCH-1.3 this class did everything: it read the runtime policy, held six
 * optional clients, opened a Redis connection of its own, invented a fallback AMQP
 * credential, ran the probes and computed the verdict. Every one of those concerns
 * is now a separate, individually testable unit:
 *
 *   DatasourceHealthProbe     — policy-driven datasource probes
 *   InfrastructureHealthProbe — Redis/RabbitMQ/MinIO probes, no owned connections
 *   ReadinessEvaluator        — the readiness verdict, from the policy alone
 *   HealthService             — runs both probes and hands the results to the verdict
 *
 * The split is what makes the semantics provable: "optional observability is down
 * but the runtime is ready" is now a test on the evaluator with a fixed input,
 * not an assertion about a method that also happened to open sockets.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly datasourceProbe: DatasourceHealthProbe,
    private readonly infrastructureProbe: InfrastructureHealthProbe,
    private readonly revocationProbe: RevocationFeedProbe,
    private readonly evaluator: ReadinessEvaluator
  ) {}

  /**
   * The readiness report for this runtime.
   *
   * Probes run sequentially, in two families: health is polled on a timer, so the
   * cost is bounded and predictable, and a thundering herd of parallel probes against
   * the same database on every poll is exactly what a readiness endpoint should not
   * provoke.
   *
   * A probe family that throws is CAUGHT and recorded rather than propagated. Both
   * probes are documented never to throw, so this is a backstop for the day one of
   * them does: a thrown error here would surface as HTTP 500 (the request failed),
   * when the truthful answer is HTTP 503 (this runtime is not ready). The evaluator
   * fails closed on the missing results, and the error text stays in the log.
   */
  async getReadinessStatus(): Promise<ReadinessReport> {
    const results: ProbeResult[] = [
      ...(await this.runProbeFamily('datasources', () => this.datasourceProbe.probeAll())),
      ...(await this.runProbeFamily('infrastructure', () => this.infrastructureProbe.probeAll())),
      // PHASE W3: the revocation feed's posture is a synchronous read of the
      // registry's own snapshot — no I/O, so it rides the family backstop.
      ...(await this.runProbeFamily('security', () =>
        Promise.resolve(this.revocationProbe.probe())
      )),
    ];
    return this.evaluator.evaluate(results);
  }

  private async runProbeFamily(
    family: 'datasources' | 'infrastructure' | 'security',
    probe: () => Promise<ProbeResult[]>
  ): Promise<ProbeResult[]> {
    try {
      return await probe();
    } catch (err) {
      this.logger.error({
        message: `health probe family "${family}" threw; reporting its checks as unavailable`,
        detail: sanitizeDetail(err),
      });
      return [];
    }
  }
}
