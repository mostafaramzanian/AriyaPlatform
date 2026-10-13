import { Logger } from '@nestjs/common';
import { HealthService } from './health.service';
import { DatasourceHealthProbe } from './datasource-health.probe';
import { InfrastructureHealthProbe } from './infrastructure-health.probe';
import { ReadinessEvaluator } from './readiness.evaluator';
import { ProbeResult } from './health.contract';
import { RuntimeId } from '../runtime-datasources';

/**
 * Phase ARCH-1.3: `HealthService` is a facade, so it is tested as one.
 *
 * The assertions here are about the three things a facade can still get wrong once
 * the probes and the evaluator are covered individually:
 *
 *   - it must USE the real evaluator verdict rather than re-derive one;
 *   - it must keep answering (as a not-ready report) when a probe family throws,
 *     instead of letting a health check turn into an unhandled failure;
 *   - it must not leak a credential into the log it writes.
 *
 * The evaluator is deliberately NOT mocked: a mocked verdict would test that the
 * service can return whatever it was handed, which is not the property in question.
 */

const ok = (key: ProbeResult['key'], requirement: ProbeResult['requirement']): ProbeResult => ({
  key,
  status: 'ok',
  requirement,
  detail: null,
});

const notUsed = (key: ProbeResult['key']): ProbeResult => ({
  key,
  status: 'not-used',
  requirement: 'not-used',
  detail: null,
});

const notConfigured = (key: ProbeResult['key']): ProbeResult => ({
  key,
  status: 'not-configured',
  requirement: 'optional',
  detail: `${key} is not configured`,
});

const failed = (key: ProbeResult['key'], requirement: ProbeResult['requirement']): ProbeResult => ({
  key,
  status: 'failed',
  requirement,
  detail: 'down',
});

const infraNotConfigured = async (): Promise<ProbeResult[]> => [
  notConfigured('redis'),
  notConfigured('rabbitmq'),
  notConfigured('storage'),
];

describe('HealthService', () => {
  let loggerSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const serviceFor = (
    runtime: RuntimeId,
    probes: {
      datasources?: () => Promise<ProbeResult[]>;
      infrastructure?: () => Promise<ProbeResult[]>;
    } = {}
  ) =>
    new HealthService(
      { probeAll: probes.datasources ?? (async () => []) } as unknown as DatasourceHealthProbe,
      {
        probeAll: probes.infrastructure ?? (async () => []),
      } as unknown as InfrastructureHealthProbe,
      new ReadinessEvaluator(runtime)
    );

  it('reports the evaluator verdict for its own runtime, not a verdict of its own', async () => {
    const service = serviceFor('combined', {
      datasources: async () => [
        ok('coreDatabase', 'required'),
        ok('cmsDatabase', 'required'),
        ok('correspondenceDatabase', 'required'),
        failed('observabilityDatabase', 'optional'),
        // Phase 51-HR-1: HR is `required` in the COMBINED runtime, so its probe answer has to
        // agree with the policy — a `not-used` result here would be downgraded to a failure by
        // the evaluator's POLICY OVER PROBE rule (see `readiness.evaluator.ts`).
        ok('hrDatabase', 'required'),
        // Phase C1 step F: Commerce is `required` in the COMBINED runtime for exactly the
        // same reason, so its answer is mandatory here too — a missing answer would fail
        // closed and block readiness (see `readiness.evaluator.ts`).
        ok('commerceDatabase', 'required'),
        // Phase PRODUCTION-BOM-HEADER: Production is `required` in the COMBINED runtime for
        // the same reason — the composition root imports `ProductionPrismaModule`, so a
        // missing answer would fail closed and block readiness.
        ok('productionDatabase', 'required'),
        // Phase F1 — FINANCIAL FOUNDATION: Financial is `required` in the COMBINED runtime
        // for the same reason — the composition root imports `FinancialPrismaModule`.
        ok('financeDatabase', 'required'),
      ],
      infrastructure: infraNotConfigured,
    });

    const report = await service.getReadinessStatus();

    expect(report.healthy).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.optionalDegraded).toEqual(['observabilityDatabase']);
    expect(report.notConfigured).toEqual(['redis', 'rabbitmq', 'storage']);
    expect(report.checks.observabilityDatabase).toBe(false);
  });

  it('is not ready when a required datasource fails', async () => {
    const service = serviceFor('combined', {
      datasources: async () => [
        failed('coreDatabase', 'required'),
        ok('cmsDatabase', 'required'),
        ok('correspondenceDatabase', 'required'),
        notUsed('observabilityDatabase'),
        // The optional-ish datasources above are all `required` (or `not-used`) to this runtime;
        // HR is `required` too, and healthy, so the only blocker is the Core database.
        ok('hrDatabase', 'required'),
        // Phase C1 step F: Commerce is `required` in the COMBINED runtime too, and healthy,
        // so it is not a blocker either.
        ok('commerceDatabase', 'required'),
        // Phase PRODUCTION-BOM-HEADER: Production is `required` too, and healthy, so it is
        // not a blocker either.
        ok('productionDatabase', 'required'),
        // Phase F1 — FINANCIAL FOUNDATION: Financial is `required` too, and healthy, so it
        // is not a blocker either.
        ok('financeDatabase', 'required'),
      ],
      infrastructure: infraNotConfigured,
    });

    const report = await service.getReadinessStatus();

    expect(report.healthy).toBe(false);
    expect(report.blocking).toEqual(['coreDatabase']);
  });

  it('reports the runtime it was composed for, including its not-used datasources', async () => {
    const service = serviceFor('core', {
      datasources: async () => [
        ok('coreDatabase', 'required'),
        notUsed('cmsDatabase'),
        notUsed('correspondenceDatabase'),
        // Core marks observability as 'optional', not 'not-used': a runtime-local
        // optional dependency still gets a real probe result.
        ok('observabilityDatabase', 'optional'),
        notUsed('hrDatabase'),
        // Phase PRODUCTION-BOM-HEADER: the Core-only runtime does not serve Production, so
        // its policy is `not-used` here too and the probe is skipped.
        notUsed('productionDatabase'),
        // Phase F1 — FINANCIAL FOUNDATION: and the same for Financial.
        notUsed('financeDatabase'),
      ],
    });

    const report = await service.getReadinessStatus();

    expect(report.healthy).toBe(true);
    expect(report.skipped).toBe(6); // cms, correspondence, HR, Commerce, Production and Financial
    expect(report.requirements.cmsDatabase).toBe('not-used');
    expect(report.requirements.commerceDatabase).toBe('not-used');
    expect(report.requirements.productionDatabase).toBe('not-used');
    expect(report.requirements.financeDatabase).toBe('not-used');
    expect(report.requirements.observabilityDatabase).toBe('optional');
  });

  it('probes datasources before infrastructure', async () => {
    const order: string[] = [];
    const service = serviceFor('core', {
      datasources: async () => {
        order.push('datasources');
        return [ok('coreDatabase', 'required')];
      },
      infrastructure: async () => {
        order.push('infrastructure');
        return [];
      },
    });

    await service.getReadinessStatus();

    expect(order).toEqual(['datasources', 'infrastructure']);
  });

  it('answers with a not-ready report, and logs, when a probe family throws', async () => {
    const service = serviceFor('core', {
      datasources: async () => {
        throw new Error('failed to reach postgresql://health:sup3rsecret@db:5432/app');
      },
      infrastructure: infraNotConfigured,
    });

    const report = await service.getReadinessStatus();

    // The required core database has no probe result at all, so the evaluator fails
    // closed: a thrown probe must not read as a healthy dependency.
    expect(report.healthy).toBe(false);
    expect(report.blocking).toEqual(['coreDatabase']);
    expect(report.checks.coreDatabase).toBe(false);

    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(loggerSpy.mock.calls[0]);
    expect(logged).toContain('datasources');
    expect(logged).toContain('<redacted-url>');
    expect(logged).not.toContain('sup3rsecret');
  });

  it('never rejects, whatever the probes do', async () => {
    const service = serviceFor('combined', {
      datasources: async () => {
        throw new Error('boom');
      },
      infrastructure: async () => {
        throw new Error('boom');
      },
    });

    await expect(service.getReadinessStatus()).resolves.toMatchObject({ healthy: false });
  });
});
