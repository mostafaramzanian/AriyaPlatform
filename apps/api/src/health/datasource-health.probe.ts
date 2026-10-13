import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATASOURCES, Datasource, RuntimeId, runtimePolicy } from '../runtime-datasources';
import { RUNTIME_ID } from './health-tokens';
import { DATASOURCE_PROBE_PROVIDERS, DatasourceProbeProvider } from './datasource-probe.registry';
import {
  DATASOURCE_CHECK_KEYS,
  ProbeResult,
  isDatasourceConfigured,
  sanitizeDetail,
} from './health.contract';

/**
 * Phase ARCH-1.3: probes ONE datasource of ONE runtime.
 * Phase ARCH-2: it knows the POLICY and the REGISTRY, and nothing about clients.
 *
 * It asks the policy first and the registry second, in that order, because the policy —
 * not the DI graph — decides what this runtime is allowed to touch:
 *
 *   not-used → 'not-used'      : never queried, never reported as healthy-by-luck
 *   unset    → 'not-configured' (optional) / 'failed' (required)
 *   probe    → 'ok' / 'failed'
 *
 * The engine no longer holds a client per datasource, and has no `switch` that maps a
 * datasource to one: it receives whatever the runtime's policy produced as
 * `DATASOURCE_PROBE_PROVIDERS`, and asks that provider to probe itself. Which token
 * carries which datasource's client is declared in `datasource-probe.registry.ts`, so
 * this class cannot be the reason a new datasource needs engine surgery.
 *
 * A datasource whose provider is absent is never silently reported as healthy: for a
 * required datasource that is a blocking failure, and for a future datasource (HR
 * today) it is a blocking failure too, which is what stops a readiness endpoint from
 * claiming health for a client that was never built.
 */
@Injectable()
export class DatasourceHealthProbe {
  /** The providers this runtime's policy produced, keyed by their own datasource. */
  private readonly providers: ReadonlyMap<Datasource, DatasourceProbeProvider>;

  constructor(
    @Inject(RUNTIME_ID) private readonly runtimeId: RuntimeId,
    @Optional()
    @Inject(DATASOURCE_PROBE_PROVIDERS)
    providers: readonly DatasourceProbeProvider[] = []
  ) {
    this.providers = new Map(providers.map((provider) => [provider.datasource, provider]));
  }

  /** Probes every declared datasource. Order is the declared policy order. */
  async probeAll(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const datasource of DATASOURCES) {
      results.push(await this.probe(datasource));
    }
    return results;
  }

  async probe(datasource: Datasource): Promise<ProbeResult> {
    const requirement = runtimePolicy(this.runtimeId).datasources[datasource];
    const key = DATASOURCE_CHECK_KEYS[datasource];

    if (requirement === 'not-used') {
      return { key, status: 'not-used', requirement, detail: null };
    }

    if (!isDatasourceConfigured(datasource)) {
      // OPTIONAL-BUT-CONDITIONAL: with no configuration there is nothing to reach,
      // which is a distinct state from "configured and unreachable".
      return {
        key,
        status: requirement === 'optional' ? 'not-configured' : 'failed',
        requirement,
        detail: `${datasource} is not configured`,
      };
    }

    const provider = this.providers.get(datasource);
    if (!provider) {
      // FAIL CLOSED, and say why. Either the policy instantiates a datasource whose
      // client token has no provider in this graph (HR today, while its owner is a
      // `target`), or a runtime instantiated a datasource and did not import its Prisma
      // module. Both are wiring faults that must not read as "healthy".
      return {
        key,
        status: 'failed',
        requirement,
        detail: `no probe provider is registered for ${datasource} by this runtime's health graph`,
      };
    }

    try {
      const ok = await provider.query();
      return { key, status: ok ? 'ok' : 'failed', requirement, detail: ok ? null : 'probe failed' };
    } catch (err) {
      return { key, status: 'failed', requirement, detail: sanitizeDetail(err) };
    }
  }
}
