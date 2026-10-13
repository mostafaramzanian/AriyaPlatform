import { Test } from '@nestjs/testing';
import {
  DATASOURCES,
  Datasource,
  RUNTIME_IDS,
  RuntimeId,
  instantiatedDatasources,
  notUsedDatasources,
} from '../runtime-datasources';
import { DatasourceHealthProbe } from './datasource-health.probe';
import { HealthService } from './health.service';
import { createHealthProviders } from './health.providers';
import { DATASOURCE_CHECK_KEYS } from './health.contract';
import {
  DATASOURCE_PROBES,
  DATASOURCE_PROBE_PROVIDERS,
  DatasourceProbeProvider,
} from './datasource-probe.registry';

/**
 * Phase ARCH-2: the COMPOSED health graph, assembled by `createHealthProviders`.
 *
 * The registry spec proves the registration is derived from the policy. This file proves
 * the derived registration actually COMPOSES in a Nest container — which is the property
 * that matters, because a policy-driven plan that cannot be injected is worthless, and a
 * graph that silently omits a required client is worse.
 *
 * Everything here runs against the real provider list the runtimes use; the only
 * substitute is the client, which is a mock because the question is "was this datasource
 * reached?", not "does this database answer?".
 *
 * The HR cases are the reason the file exists: `future-hr` must be able to probe HR
 * through a BOUND provider while no HR module, schema or service exists, and must FAIL
 * CLOSED while that provider is unbound. That is the seam Phase 51-HR will cross.
 */

interface FakeClient {
  $queryRaw: jest.Mock;
  ping: jest.Mock;
}

const ENV_KEYS: string[] = [...DATASOURCES, 'REDIS_URL', 'RABBITMQ_URL', 'MINIO_ENDPOINT'];

describe('the composed health graph', () => {
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
    jest.restoreAllMocks();
  });

  const configured = (datasource: Datasource) => {
    process.env[datasource] = 'postgresql://user:pw@db:5432/app';
  };

  /** Satisfies both probe shapes, so one mock can stand in for any client. */
  const fakeClient = (): FakeClient => ({
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    ping: jest.fn(async () => true),
  });

  /**
   * Builds the REAL health provider list of a runtime, binding clients only for the
   * datasources named in `bound` — the exact shape a runtime without an HR client has.
   */
  const graphFor = async (runtime: RuntimeId, bound: Datasource[]) => {
    const clients = new Map<Datasource, FakeClient>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...createHealthProviders(runtime),
        ...bound.map((datasource) => {
          const client = fakeClient();
          clients.set(datasource, client);
          return { provide: DATASOURCE_PROBES[datasource].clientToken, useValue: client };
        }),
      ],
    }).compile();

    return {
      probe: moduleRef.get(DatasourceHealthProbe),
      readiness: moduleRef.get(HealthService),
      registry: moduleRef.get<DatasourceProbeProvider[]>(DATASOURCE_PROBE_PROVIDERS),
      clients,
      close: () => moduleRef.close(),
    };
  };

  /** The registered datasources, normalized to declaration order. */
  const registered = (registry: DatasourceProbeProvider[]) =>
    DATASOURCES.filter((datasource) =>
      registry.some((provider) => provider.datasource === datasource)
    );

  describe('registration is the policy', () => {
    it('registers exactly the datasources a runtime instantiates, once every client is bound', async () => {
      for (const runtime of RUNTIME_IDS) {
        const graph = await graphFor(runtime, instantiatedDatasources(runtime));

        expect({ runtime, registered: registered(graph.registry) }).toEqual({
          runtime,
          registered: instantiatedDatasources(runtime),
        });
        await graph.close();
      }
    });

    it('registers nothing for a not-used datasource, even when its client IS bound', async () => {
      const graph = await graphFor('core', [...instantiatedDatasources('core'), 'HR_DATABASE_URL']);

      expect(registered(graph.registry)).not.toContain('HR_DATABASE_URL');
      expect(notUsedDatasources('core')).toContain('HR_DATABASE_URL');
      await graph.close();
    });

    it('reports a not-used datasource as skipped and never queries its bound client', async () => {
      // Core marks HR `not-used` (Phase 51-HR-1 hosts HR in the combined runtime instead), so a
      // Core graph with an HR client bound must still refuse to query it.
      configured('HR_DATABASE_URL');
      const graph = await graphFor('core', [...instantiatedDatasources('core'), 'HR_DATABASE_URL']);

      const result = await graph.probe.probe('HR_DATABASE_URL');

      expect(result).toMatchObject({
        key: 'hrDatabase',
        status: 'not-used',
        requirement: 'not-used',
      });
      const hrClient = graph.clients.get('HR_DATABASE_URL') as FakeClient;
      expect(hrClient.$queryRaw).not.toHaveBeenCalled();
      expect(hrClient.ping).not.toHaveBeenCalled();
      await graph.close();
    });

    it('fails closed for an instantiated datasource whose client was not bound', async () => {
      for (const datasource of instantiatedDatasources('combined')) configured(datasource);
      const graph = await graphFor('combined', ['CORE_DATABASE_URL']);

      const core = await graph.probe.probe('CORE_DATABASE_URL');
      const cms = await graph.probe.probe('CMS_DATABASE_URL');

      expect(core.status).toBe('ok');
      expect(cms.status).toBe('failed');
      expect(cms.detail).toMatch(/no probe provider is registered for CMS_DATABASE_URL/);
      await graph.close();
    });
  });

  describe('future-hr: the standalone HR runtime, still a declared target', () => {
    it('is NOT ready while no client is bound for the HR datasource, and names the blocker', async () => {
      configured('CORE_DATABASE_URL');
      configured('HR_DATABASE_URL');
      const graph = await graphFor('future-hr', ['CORE_DATABASE_URL']);

      const hr = await graph.probe.probe('HR_DATABASE_URL');
      const report = await graph.readiness.getReadinessStatus();

      expect(hr.status).toBe('failed');
      expect(hr.requirement).toBe('required');
      expect(report.healthy).toBe(false);
      expect(report.blocking).toEqual([DATASOURCE_CHECK_KEYS.HR_DATABASE_URL]);
      await graph.close();
    });

    it('probes HR through a bound provider, with no HR module in the graph', async () => {
      configured('CORE_DATABASE_URL');
      configured('HR_DATABASE_URL');
      const graph = await graphFor('future-hr', ['CORE_DATABASE_URL', 'HR_DATABASE_URL']);

      const hr = await graph.probe.probe('HR_DATABASE_URL');

      expect(hr).toMatchObject({ key: 'hrDatabase', status: 'ok', requirement: 'required' });
      const hrClient = graph.clients.get('HR_DATABASE_URL') as FakeClient;
      expect(hrClient.$queryRaw).toHaveBeenCalledTimes(1);

      const report = await graph.readiness.getReadinessStatus();

      expect(report.healthy).toBe(true);
      expect(report.blocking).toEqual([]);
      await graph.close();
    });

    it('keeps HR not-used in every runtime that does not serve it, bound or not', async () => {
      for (const runtime of ['core', 'cms'] as RuntimeId[]) {
        configured('HR_DATABASE_URL');
        const graph = await graphFor(runtime, ['HR_DATABASE_URL']);

        const result = await graph.probe.probe('HR_DATABASE_URL');

        expect({ runtime, status: result.status }).toEqual({ runtime, status: 'not-used' });
        await graph.close();
      }
    });
  });

  describe('one graph, one policy', () => {
    it('reports the requirements of the runtime it was composed for', async () => {
      // A graph that paired one runtime's identity with another runtime's policy would
      // show up here as the wrong requirement for HR — the one datasource whose
      // requirement differs between runtimes.
      for (const runtime of RUNTIME_IDS) {
        const graph = await graphFor(runtime, []);

        const report = await graph.readiness.getReadinessStatus();

        expect({
          runtime,
          hr: report.requirements[DATASOURCE_CHECK_KEYS.HR_DATABASE_URL],
        }).toEqual({
          runtime,
          // Two runtimes now serve HR: the combined one that hosts the module, and the
          // standalone one that will. The Core-only and CMS-only graphs report `not-used`.
          hr: runtime === 'core' || runtime === 'cms' ? 'not-used' : 'required',
        });
        await graph.close();
      }
    });
  });
});
