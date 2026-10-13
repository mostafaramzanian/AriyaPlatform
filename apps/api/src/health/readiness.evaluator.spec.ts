import {
  DATASOURCES,
  INFRASTRUCTURE_SERVICES,
  RUNTIME_DATASOURCE_MATRIX,
  Requirement,
  RuntimeId,
} from '../runtime-datasources';
import { ReadinessEvaluator } from './readiness.evaluator';
import {
  CHECK_KEYS,
  CheckKey,
  DATASOURCE_CHECK_KEYS,
  INFRASTRUCTURE_CHECK_KEYS,
  ProbeResult,
} from './health.contract';

/**
 * Phase ARCH-1.3: the readiness VERDICT, tested without a database, a socket or a
 * Nest container.
 *
 * These cases decide whether a runtime is taken out of rotation, and every one of
 * them is a decision about the POLICY rather than about a connection. That is the
 * point of splitting the evaluator out of `HealthService`: the same input produces
 * the same verdict here and in production.
 */

const result = (
  key: CheckKey,
  status: ProbeResult['status'],
  requirement: Requirement,
  detail: string | null = null
): ProbeResult => ({ key, status, requirement, detail });

const ds = (datasource: keyof typeof DATASOURCE_CHECK_KEYS): CheckKey =>
  DATASOURCE_CHECK_KEYS[datasource];

const evaluatorFor = (runtime: RuntimeId) => new ReadinessEvaluator(runtime);

const requirementFor = (runtime: RuntimeId, key: CheckKey): Requirement => {
  const policy = RUNTIME_DATASOURCE_MATRIX[runtime];
  for (const datasource of DATASOURCES) {
    if (DATASOURCE_CHECK_KEYS[datasource] === key) return policy.datasources[datasource];
  }
  for (const service of INFRASTRUCTURE_SERVICES) {
    if (INFRASTRUCTURE_CHECK_KEYS[service] === key) return policy.infrastructure[service];
  }
  throw new Error(`No requirement declared for check "${key}"`);
};

/**
 * A COMPLETE probe result set for a runtime: every check accounted for, required
 * and optional ones `ok`, `not-used` ones reported as skipped. Tests then override
 * only the check they are about, so a failure cannot come from an unrelated check
 * that the test forgot to declare.
 */
const baseline = (
  runtime: RuntimeId,
  overrides: Partial<Record<CheckKey, ProbeResult['status']>> = {}
): ProbeResult[] =>
  CHECK_KEYS.map((key) => {
    const requirement = requirementFor(runtime, key);
    const status = overrides[key] ?? (requirement === 'not-used' ? 'not-used' : 'ok');
    return result(key, status, requirement);
  });

describe('ReadinessEvaluator', () => {
  describe('combined runtime', () => {
    it('is ready when core, cms and correspondence databases answer', () => {
      const report = evaluatorFor('combined').evaluate(baseline('combined'));

      expect(report.healthy).toBe(true);
      expect(report.blocking).toEqual([]);
      expect(report.checks.coreDatabase).toBe(true);
      expect(report.checks.cmsDatabase).toBe(true);
      expect(report.checks.correspondenceDatabase).toBe(true);
      expect(report.optionalDegraded).toEqual([]);
      expect(report.notConfigured).toEqual([]);
    });

    it('is NOT ready when the correspondence database fails, because it is required there', () => {
      const report = evaluatorFor('combined').evaluate(
        baseline('combined', { correspondenceDatabase: 'failed' })
      );

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['correspondenceDatabase']);
      expect(report.checks.correspondenceDatabase).toBe(false);
    });

    it('stays ready when the optional observability database fails, and still says so', () => {
      const report = evaluatorFor('combined').evaluate(
        baseline('combined', { observabilityDatabase: 'failed' })
      );

      expect(report.healthy).toBe(true);
      expect(report.blocking).toEqual([]);
      expect(report.optionalDegraded).toEqual(['observabilityDatabase']);
      // Degraded is still visible: the status map carries the failure even though
      // it does not gate readiness.
      expect(report.checks.observabilityDatabase).toBe(false);
      expect(report.statuses.observabilityDatabase).toBe('failed');
    });

    it('separates "not configured" from "configured and down" without failing readiness', () => {
      const report = evaluatorFor('combined').evaluate(
        baseline('combined', {
          observabilityDatabase: 'not-configured',
          redis: 'not-configured',
        })
      );

      expect(report.healthy).toBe(true);
      expect(report.notConfigured).toEqual(['observabilityDatabase', 'redis']);
      expect(report.optionalDegraded).toEqual([]);
      // Stage 4 contract: `not-configured` is reported honestly as checks=false
      // while overall readiness stays healthy (nothing blocking, no degradation).
      expect(report.checks.observabilityDatabase).toBe(false);
      expect(report.checks.redis).toBe(false);
    });
  });

  describe('core runtime', () => {
    it('does not require a datasource the policy marks not-used, even with no probe result at all', () => {
      const report = evaluatorFor('core').evaluate(baseline('core'));

      expect(report.healthy).toBe(true);
      expect(report.skipped).toBe(6); // cms, correspondence, HR, Commerce, Production and Financial
      expect(report.statuses.cmsDatabase).toBe('not-used');
      expect(report.checks.cmsDatabase).toBe(true);
      expect(report.statuses.correspondenceDatabase).toBe('not-used');
      expect(report.statuses.hrDatabase).toBe('not-used');
      expect(report.statuses.commerceDatabase).toBe('not-used');
      // Phase PRODUCTION-BOM-HEADER: the Core-only runtime does not serve Production, so
      // `production_db` is `not-used` there — reported, skipped, and never a blocker.
      expect(report.statuses.productionDatabase).toBe('not-used');
      // Phase F1 — FINANCIAL FOUNDATION: and the same for `finance_db`.
      expect(report.statuses.financeDatabase).toBe('not-used');
      expect(report.blocking).toEqual([]);
    });

    it('is NOT ready when the core database fails', () => {
      const report = evaluatorFor('core').evaluate(baseline('core', { coreDatabase: 'failed' }));

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['coreDatabase']);
      expect(report.checks.coreDatabase).toBe(false);
    });

    it('stays ready when the optional observability database is absent', () => {
      const report = evaluatorFor('core').evaluate(
        baseline('core', { observabilityDatabase: 'not-configured' })
      );

      expect(report.healthy).toBe(true);
      expect(report.notConfigured).toEqual(['observabilityDatabase']);
      expect(report.optionalDegraded).toEqual([]);
    });
  });

  describe('cms runtime', () => {
    it('requires core and cms, and treats observability as not-used rather than optional', () => {
      const report = evaluatorFor('cms').evaluate(baseline('cms'));

      expect(report.healthy).toBe(true);
      expect(report.requirements.observabilityDatabase).toBe('not-used');
      expect(report.statuses.observabilityDatabase).toBe('not-used');
      expect(report.requirements.coreDatabase).toBe('required');
      expect(report.requirements.cmsDatabase).toBe('required');
    });

    it('is not ready when only the CMS database fails', () => {
      const report = evaluatorFor('cms').evaluate(baseline('cms', { cmsDatabase: 'failed' }));

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['cmsDatabase']);
      expect(report.statuses.correspondenceDatabase).toBe('not-used');
      expect(report.statuses.hrDatabase).toBe('not-used');
    });
  });

  describe('fail-closed and policy-over-probe rules', () => {
    it('treats a REQUIRED dependency with no probe result as failed and blocking', () => {
      const report = evaluatorFor('core').evaluate([]);

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['coreDatabase']);
      expect(report.statuses.coreDatabase).toBe('failed');
      expect(report.details.coreDatabase).toMatch(/no probe result/);
    });

    it('treats an OPTIONAL dependency with no probe result as degraded, never blocking', () => {
      const withoutOptionalDatasource = baseline('core').filter(
        (r) => r.key !== ds('OBSERVABILITY_DATABASE_URL')
      );

      const report = evaluatorFor('core').evaluate(withoutOptionalDatasource);

      expect(report.healthy).toBe(true);
      expect(report.optionalDegraded).toEqual(['observabilityDatabase']);
      expect(report.checks.observabilityDatabase).toBe(false);
      expect(report.statuses.observabilityDatabase).toBe('failed');
      expect(report.details.observabilityDatabase).toMatch(/no probe result/);
    });

    it('does not let a probe downgrade its own requirement by reporting not-used', () => {
      const report = evaluatorFor('core').evaluate(baseline('core', { coreDatabase: 'not-used' }));

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['coreDatabase']);
      expect(report.statuses.coreDatabase).toBe('failed');
    });

    it('fails closed for the HR datasource when no probe result arrives for it', () => {
      // `future-hr` declares HR_DATABASE_URL 'required'; a missing result must be `failed` and
      // blocking, so a runtime built for it reports not-ready rather than ready-with-caveat.
      const results = baseline('future-hr').filter((r) => r.key !== ds('HR_DATABASE_URL'));

      const report = evaluatorFor('future-hr').evaluate(results);

      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual(['hrDatabase']);
      expect(report.statuses.hrDatabase).toBe('failed');
    });
  });

  describe('report shape', () => {
    it('reports every declared check exactly once, for every runtime', () => {
      for (const runtime of ['core', 'cms', 'combined', 'future-hr'] as const) {
        const report = evaluatorFor(runtime).evaluate([]);

        expect(Object.keys(report.checks).sort()).toEqual([...CHECK_KEYS].sort());
        expect(Object.keys(report.requirements).sort()).toEqual([...CHECK_KEYS].sort());
        expect(Object.keys(report.statuses).sort()).toEqual([...CHECK_KEYS].sort());
        expect(Object.keys(report.details).sort()).toEqual([...CHECK_KEYS].sort());
        // Every check lands in exactly one bucket, so an operator reading the body
        // sees the runtime's whole dependency surface and not just the failures.
        expect(
          report.ok +
            report.skipped +
            report.blocking.length +
            report.optionalDegraded.length +
            report.notConfigured.length
        ).toBe(CHECK_KEYS.length);
      }
    });

    it('declares a requirement for every check the contract can report', () => {
      const report = evaluatorFor('combined').evaluate([]);

      for (const key of CHECK_KEYS) {
        expect(['required', 'optional', 'not-used']).toContain(report.requirements[key]);
      }
      // Both families are represented — a contract that dropped one would silently
      // stop reporting it.
      expect(DATASOURCES.length).toBeGreaterThan(0);
      expect(INFRASTRUCTURE_SERVICES.length).toBeGreaterThan(0);
      expect(CHECK_KEYS).toHaveLength(DATASOURCES.length + INFRASTRUCTURE_SERVICES.length);
    });

    it('keeps every requirement in the report identical to the runtime policy', () => {
      const report = evaluatorFor('combined').evaluate([]);

      for (const datasource of DATASOURCES) {
        expect(report.requirements[DATASOURCE_CHECK_KEYS[datasource]]).toBe(
          RUNTIME_DATASOURCE_MATRIX.combined.datasources[datasource]
        );
      }
    });
  });
});
