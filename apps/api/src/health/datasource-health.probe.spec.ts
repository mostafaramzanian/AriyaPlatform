import { DatasourceHealthProbe } from './datasource-health.probe';
import { DatasourceProbeProvider } from './datasource-probe.registry';
import { DATASOURCE_CHECK_KEYS, CheckKey } from './health.contract';
import {
  DATASOURCES,
  Datasource,
  RuntimeId,
  instantiatedDatasources,
  notUsedDatasources,
} from '../runtime-datasources';

/**
 * Phase ARCH-1.3: the datasource PROBE, tested without a database.
 * Phase ARCH-2: tested without clients as well — the probe is handed a REGISTRY.
 *
 * The rules this file exists to prove:
 *
 *  1. POLICY FIRST. Which datasources this runtime may touch is a policy decision, so a
 *     provider that happens to be registered must not be able to widen it: a `not-used`
 *     datasource is never queried, even when a provider for it is present.
 *  2. THE REGISTRY IS THE ONLY SOURCE OF ANSWERS. The engine holds no client of its own
 *     and has no datasource→client switch, so a datasource the policy instantiates but
 *     the registry does not contain fails CLOSED — and a provider registered for one
 *     datasource is never reached through another.
 *  3. NOTHING IS INVENTED AND NOTHING LEAKS. A required datasource with no environment
 *     variable is `failed`, an optional one is `not-configured`, and a provider's error
 *     text is sanitized before it can reach a public readiness body.
 */

const ENV_KEYS = DATASOURCES;

describe('DatasourceHealthProbe', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  const configured = (key: Datasource, value = 'postgresql://user:pw@db:5432/app') => {
    process.env[key] = value;
  };

  /**
   * A registry entry for ONE datasource. `query` is a mock, which is how the tests below
   * prove a provider was never consulted: the engine does not receive this object, it
   * receives the array, so nothing can reach a client behind the engine's back.
   */
  const providerFor = (
    datasource: Datasource,
    behaviour: 'ok' | 'false' | 'reject' = 'ok'
  ): DatasourceProbeProvider => ({
    datasource,
    query: jest.fn(
      behaviour === 'ok'
        ? () => Promise.resolve(true)
        : behaviour === 'false'
          ? () => Promise.resolve(false)
          : () => Promise.reject(new Error('connect ECONNREFUSED'))
    ),
  });

  const probeFor = (runtime: RuntimeId, providers: DatasourceProbeProvider[] = []) =>
    new DatasourceHealthProbe(runtime, providers);

  describe('policy first, registry second', () => {
    it('never probes a datasource the policy marks not-used, even when a provider is registered', async () => {
      const cms = providerFor('CMS_DATABASE_URL');
      const correspondence = providerFor('CORRESPONDENCE_DATABASE_URL');
      const core = providerFor('CORE_DATABASE_URL');
      const probe = probeFor('core', [core, cms, correspondence]);
      configured('CMS_DATABASE_URL');
      configured('CORRESPONDENCE_DATABASE_URL');
      configured('CORE_DATABASE_URL');

      const cmsResult = await probe.probe('CMS_DATABASE_URL');
      const correspondenceResult = await probe.probe('CORRESPONDENCE_DATABASE_URL');
      const coreResult = await probe.probe('CORE_DATABASE_URL');

      expect(cmsResult.status).toBe('not-used');
      expect(correspondenceResult.status).toBe('not-used');
      expect(coreResult.status).toBe('ok');
      expect(cms.query).not.toHaveBeenCalled();
      expect(correspondence.query).not.toHaveBeenCalled();
    });

    it('reports a policy-required-but-unconfigured datasource as failed, naming the variable', async () => {
      const probe = probeFor('core', [providerFor('CORE_DATABASE_URL')]);

      const result = await probe.probe('CORE_DATABASE_URL');

      expect(result.status).toBe('failed');
      expect(result.requirement).toBe('required');
      expect(result.detail).toContain('CORE_DATABASE_URL');
    });

    it('reports an optional datasource with no env var as not-configured, not failed', async () => {
      const probe = probeFor('combined', [providerFor('OBSERVABILITY_DATABASE_URL')]);

      const result = await probe.probe('OBSERVABILITY_DATABASE_URL');

      expect(result.status).toBe('not-configured');
      expect(result.requirement).toBe('optional');
    });

    it('probes the registered provider and reports ok', async () => {
      const core = providerFor('CORE_DATABASE_URL');
      const probe = probeFor('combined', [core]);
      configured('CORE_DATABASE_URL');

      const result = await probe.probe('CORE_DATABASE_URL');

      expect(result).toMatchObject({ key: 'coreDatabase', status: 'ok', requirement: 'required' });
      expect(result.detail).toBeNull();
      expect(core.query).toHaveBeenCalledTimes(1);
    });

    it('reports the provider answer, so a provider that says no is a failure', async () => {
      const probe = probeFor('combined', [providerFor('CORE_DATABASE_URL', 'false')]);
      configured('CORE_DATABASE_URL');

      const result = await probe.probe('CORE_DATABASE_URL');

      expect(result.status).toBe('failed');
      expect(result.detail).toBe('probe failed');
    });

    it('reports failed, sanitized, when the provider rejects', async () => {
      const probe = probeFor('combined', [providerFor('CORE_DATABASE_URL', 'reject')]);
      configured('CORE_DATABASE_URL');

      const result = await probe.probe('CORE_DATABASE_URL');

      expect(result.status).toBe('failed');
      // The raw driver error text is not forwarded verbatim: whatever a driver puts in a
      // message ends up in a public readiness body, so it is sanitized here.
      expect(result.detail).toMatch(/ECONNREFUSED/);
    });

    it('redacts credentials out of a failed probe detail', async () => {
      const observability: DatasourceProbeProvider = {
        datasource: 'OBSERVABILITY_DATABASE_URL',
        query: jest
          .fn()
          .mockRejectedValue(
            new Error('failed to reach postgresql://admin:hunter2@obs:5432/metrics')
          ),
      };
      const probe = probeFor('combined', [observability]);
      configured('OBSERVABILITY_DATABASE_URL');

      const result = await probe.probe('OBSERVABILITY_DATABASE_URL');

      expect(result.status).toBe('failed');
      expect(result.detail).not.toContain('hunter2');
      expect(result.detail).not.toContain('postgresql://');
    });

    it('never reaches a datasource through a provider registered for a different one', async () => {
      // The engine keys its registry by the datasource each provider declares for itself,
      // so a CMS probe in a graph that registered only Core must fail rather than borrow
      // Core's provider.
      const core = providerFor('CORE_DATABASE_URL');
      const probe = probeFor('combined', [core]);
      configured('CORE_DATABASE_URL');
      configured('CMS_DATABASE_URL');

      const result = await probe.probe('CMS_DATABASE_URL');

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/no probe provider is registered for CMS_DATABASE_URL/);
      expect(core.query).not.toHaveBeenCalled();
    });

    it('does not invent a provider when the runtime has none for a required datasource', async () => {
      // `future-hr` requires HR_DATABASE_URL, and this graph binds none for it: the probe must
      // fail closed rather than report a green check for a database it never touched — which
      // is exactly what a runtime does before its HR client is provided.
      const probe = probeFor('future-hr', [providerFor('CORE_DATABASE_URL')]);
      configured('HR_DATABASE_URL');
      configured('CORE_DATABASE_URL');

      const result = await probe.probe('HR_DATABASE_URL');

      expect(result.status).toBe('failed');
      expect(result.requirement).toBe('required');
      expect(result.detail).toMatch(/no probe provider is registered for HR_DATABASE_URL/);
    });

    it('fails closed for every instantiated datasource when the registry is empty', async () => {
      const probe = probeFor('combined', []);
      for (const key of ENV_KEYS) configured(key);

      const results = await probe.probeAll();

      // Derived from the policy rather than restated: with no registry, exactly the
      // datasources `combined` instantiates must fail, and every `not-used` datasource
      // must be reported as skipped instead.
      expect(results.map((r) => r.key)).toEqual(DATASOURCES.map((d) => DATASOURCE_CHECK_KEYS[d]));
      const instantiated = new Set<CheckKey>(
        instantiatedDatasources('combined').map((d) => DATASOURCE_CHECK_KEYS[d])
      );
      expect(results.filter((r) => r.status === 'failed').map((r) => r.key)).toEqual(
        results.filter((r) => instantiated.has(r.key)).map((r) => r.key)
      );
      expect(results.filter((r) => r.status === 'not-used').map((r) => r.key)).toEqual(
        notUsedDatasources('combined').map((d) => DATASOURCE_CHECK_KEYS[d])
      );
    });
  });

  describe('probeAll', () => {
    it('reports every declared datasource exactly once, in policy order', async () => {
      const probe = probeFor('combined', [
        providerFor('CORE_DATABASE_URL'),
        providerFor('CMS_DATABASE_URL'),
        providerFor('CORRESPONDENCE_DATABASE_URL'),
        providerFor('OBSERVABILITY_DATABASE_URL'),
        providerFor('HR_DATABASE_URL'),
        // Phase C1 step F: Commerce is now a datasource the COMBINED runtime instantiates.
        providerFor('COMMERCE_DATABASE_URL'),
        // Phase PRODUCTION-BOM-HEADER: Production is instantiated by the COMBINED runtime
        // too, so a provider for it is registered — exactly the move Commerce needed.
        providerFor('PRODUCTION_DATABASE_URL'),
      ]);
      for (const key of ENV_KEYS) configured(key);

      const results = await probe.probeAll();

      expect(results.map((r) => r.key)).toEqual(DATASOURCES.map((d) => DATASOURCE_CHECK_KEYS[d]));
      expect(new Set(results.map((r) => r.key)).size).toBe(results.length);
    });

    it('never throws, whatever the providers do', async () => {
      const probe = probeFor('combined', [
        providerFor('CORE_DATABASE_URL', 'reject'),
        providerFor('CMS_DATABASE_URL', 'reject'),
        providerFor('CORRESPONDENCE_DATABASE_URL', 'reject'),
        providerFor('OBSERVABILITY_DATABASE_URL', 'reject'),
        providerFor('HR_DATABASE_URL', 'reject'),
        providerFor('COMMERCE_DATABASE_URL', 'reject'),
        // Phase PRODUCTION-BOM-HEADER: Production joins that set for the same reason, so its
        // provider rejects here too and the policy-derived counts stay exact.
        providerFor('PRODUCTION_DATABASE_URL', 'reject'),
      ]);
      for (const key of ENV_KEYS) configured(key);

      const results = await probe.probeAll();

      expect(results).toHaveLength(DATASOURCES.length);
      // Phase 51-HR-1: every datasource the COMBINED runtime instantiates has a provider
      // that rejects, so nothing is `not-used` any more and every declared datasource
      // fails. Phase C1 step F added Commerce to that set (now six datasources). The
      // counts are read off the policy rather than hard-coded.
      expect(results.filter((r) => r.status === 'failed')).toHaveLength(
        instantiatedDatasources('combined').length
      );
      expect(results.filter((r) => r.status === 'not-used')).toHaveLength(
        notUsedDatasources('combined').length
      );
      expect(results.filter((r) => r.status === 'failed').map((r) => r.key)).toEqual(
        instantiatedDatasources('combined').map((d) => DATASOURCE_CHECK_KEYS[d])
      );
    });
  });
});
