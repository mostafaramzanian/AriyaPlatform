import { Inject, Injectable } from '@nestjs/common';
import {
  DATASOURCES,
  INFRASTRUCTURE_SERVICES,
  ProbeStatus,
  Requirement,
  RuntimeId,
  runtimePolicy,
} from '../runtime-datasources';
import { RUNTIME_ID } from './health-tokens';
import {
  CHECK_KEYS,
  CheckKey,
  DATASOURCE_CHECK_KEYS,
  HealthChecks,
  INFRASTRUCTURE_CHECK_KEYS,
  ProbeResult,
  ReadinessReport,
} from './health.contract';

/**
 * Phase ARCH-1.3: turns probe results into a readiness verdict, using the runtime
 * policy and nothing else.
 *
 * This is the only place that decides whether a runtime is READY, which is what
 * makes the answer auditable: the same `RUNTIME_DATASOURCE_MATRIX` that generated
 * the image's datasource set decides what a failure means here.
 *
 * Two rules matter beyond the obvious "required failure blocks readiness":
 *
 *  - FAIL CLOSED. A dependency the runtime policy says it needs, but for which no
 *    probe result was produced at all, is a failure (and blocking when required).
 *    A missing probe is never mistaken for a passing one.
 *  - POLICY OVER PROBE. A probe that reports `not-used` for a dependency the
 *    policy instantiates is treated as a failure. A probe implementation cannot
 *    downgrade its own requirement.
 */
@Injectable()
export class ReadinessEvaluator {
  constructor(@Inject(RUNTIME_ID) private readonly runtimeId: RuntimeId) {}

  evaluate(results: ProbeResult[]): ReadinessReport {
    const requirements = this.requirements();
    const byKey = new Map<CheckKey, ProbeResult>();
    for (const result of results) {
      byKey.set(result.key, result);
    }

    const statuses = {} as Record<CheckKey, ProbeStatus>;
    const details = {} as Record<CheckKey, string | null>;
    const checks = {} as HealthChecks;
    const blocking: CheckKey[] = [];
    const notConfigured: CheckKey[] = [];
    const optionalDegraded: CheckKey[] = [];
    let ok = 0;
    let skipped = 0;

    for (const key of CHECK_KEYS) {
      const requirement = requirements[key];

      if (requirement === 'not-used') {
        statuses[key] = 'not-used';
        details[key] = null;
        checks[key] = true;
        skipped++;
        continue;
      }

      const result = byKey.get(key);
      const status: ProbeStatus =
        !result || result.status === 'not-used' ? 'failed' : result.status;

      statuses[key] = status;
      details[key] = result ? result.detail : 'no probe result was produced for this dependency';
      // Stage 4: `not-configured` must not masquerade as healthy. checks=false
      // reports the real state; readiness stays healthy because only `failed`
      // entries enter `blocking`/`optionalDegraded` below (not-configured goes
      // to the separate notConfigured list instead).
      checks[key] = status === 'ok';

      if (status === 'ok') ok++;
      if (status === 'not-configured') notConfigured.push(key);
      if (status !== 'failed') continue;

      if (requirement === 'required') blocking.push(key);
      else optionalDegraded.push(key);
    }

    return {
      healthy: blocking.length === 0,
      checks,
      requirements,
      statuses,
      details,
      optionalDegraded,
      notConfigured,
      blocking,
      ok,
      skipped,
    };
  }

  private requirements(): Record<CheckKey, Requirement> {
    const policy = runtimePolicy(this.runtimeId);
    const out = {} as Record<CheckKey, Requirement>;
    for (const datasource of DATASOURCES) {
      out[DATASOURCE_CHECK_KEYS[datasource]] = policy.datasources[datasource];
    }
    for (const service of INFRASTRUCTURE_SERVICES) {
      out[INFRASTRUCTURE_CHECK_KEYS[service]] = policy.infrastructure[service];
    }
    return out;
  }
}
