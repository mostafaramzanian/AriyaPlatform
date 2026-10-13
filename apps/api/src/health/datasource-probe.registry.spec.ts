import { FactoryProvider, OptionalFactoryDependency } from '@nestjs/common';
import {
  DATASOURCE_OWNERS,
  DATASOURCES,
  Datasource,
  RUNTIME_IDS,
  RuntimeId,
  instantiatedDatasources,
  notUsedDatasources,
} from '../runtime-datasources';
import { HR_PRISMA_CLIENT } from './health-tokens';
import {
  DATASOURCE_PROBES,
  DATASOURCE_PROBE_PROVIDERS,
  DatasourceProbeProvider,
  createDatasourceProbeProviders,
  datasourceProbeDefinitions,
  datasourcesAwaitingProbeClient,
} from './datasource-probe.registry';

/**
 * Phase ARCH-2: the invariants of the probe REGISTRY, checked without a container.
 *
 * The registry exists so that "which datasources does this runtime probe?" has exactly
 * one answer, derived from the runtime policy. These tests are the executable form of
 * that claim: completeness against the policy, one token per datasource, no provider for
 * a `not-used` datasource, and HR — the datasource whose declaration PREDATED its domain —
 * now bound in exactly the runtimes whose policy instantiates it.
 *
 * The DI-level proof that this registration actually composes lives next to it, in
 * `health.providers.spec.ts`.
 */

describe('datasource probe registry', () => {
  describe('completeness', () => {
    it('declares how to probe every datasource the policy can name, and nothing else', () => {
      expect(Object.keys(DATASOURCE_PROBES).sort()).toEqual([...DATASOURCES].sort());
    });

    it('gives every datasource its own client token, so no two can share a client', () => {
      const tokens = DATASOURCES.map((datasource) => DATASOURCE_PROBES[datasource].clientToken);
      expect(tokens).toHaveLength(DATASOURCES.length);
      expect(new Set(tokens).size).toBe(DATASOURCES.length);
    });

    it('reports each provider under the datasource it was declared for', () => {
      const client = { $queryRaw: async () => [{ '?column?': 1 }], ping: async () => true };
      for (const datasource of DATASOURCES) {
        expect(DATASOURCE_PROBES[datasource].bind(client).datasource).toBe(datasource);
      }
    });
  });

  describe('registration follows the runtime policy', () => {
    it('registers exactly the datasources each runtime instantiates, in policy order', () => {
      for (const runtime of RUNTIME_IDS) {
        expect({
          runtime,
          planned: datasourceProbeDefinitions(runtime).map((d) => d.datasource),
        }).toEqual({ runtime, planned: instantiatedDatasources(runtime) });
      }
    });

    it('never registers a provider for a datasource the runtime marks not-used', () => {
      for (const runtime of RUNTIME_IDS) {
        const planned = new Set(datasourceProbeDefinitions(runtime).map((d) => d.datasource));
        const overlap = notUsedDatasources(runtime).filter((datasource) => planned.has(datasource));
        expect({ runtime, overlap }).toEqual({ runtime, overlap: [] });
      }
    });

    it('counts a not-used datasource as absent from the plan even though a definition exists', () => {
      // The definition table is complete by construction (`Record<Datasource, ...>`), so
      // "a definition exists" must never be mistaken for "this runtime probes it".
      expect(DATASOURCE_PROBES.HR_DATABASE_URL).toBeDefined();
      expect(datasourceProbeDefinitions('core').map((d) => d.datasource)).not.toContain(
        'HR_DATABASE_URL'
      );
      expect(datasourceProbeDefinitions('future-hr').map((d) => d.datasource)).toContain(
        'HR_DATABASE_URL'
      );
    });
  });

  describe('the factory: the plan IS the injection list', () => {
    const factoryProviderOf = (runtime: RuntimeId) =>
      createDatasourceProbeProviders(runtime) as FactoryProvider;

    const injectedOf = (runtime: RuntimeId) =>
      factoryProviderOf(runtime).inject as OptionalFactoryDependency[];

    it('registers the registry under the shared registry token, and nothing else', () => {
      for (const runtime of RUNTIME_IDS) {
        expect({
          runtime,
          provide: factoryProviderOf(runtime).provide,
        }).toEqual({ runtime, provide: DATASOURCE_PROBE_PROVIDERS });
      }
    });

    it('injects exactly the planned client tokens, once each, and every one optional', () => {
      for (const runtime of RUNTIME_IDS) {
        const planned = datasourceProbeDefinitions(runtime).map((d) => d.clientToken);
        const injected = injectedOf(runtime);

        expect({ runtime, tokens: injected.map((d) => d.token) }).toEqual({
          runtime,
          tokens: planned,
        });
        // A required injection would turn "this runtime has no client for that datasource"
        // into a container-level crash. The absence has to reach the probe as a missing
        // provider, so that only the POLICY decides whether it is fatal.
        expect(injected.every((dependency) => dependency.optional === true)).toBe(true);
        expect(new Set(planned).size).toBe(planned.length);
      }
    });

    it('never injects a token of a datasource the policy marks not-used', () => {
      for (const runtime of RUNTIME_IDS) {
        const notUsedTokens = new Set<unknown>(
          notUsedDatasources(runtime).map((d) => DATASOURCE_PROBES[d].clientToken)
        );
        const overlap = injectedOf(runtime).filter((dependency) =>
          notUsedTokens.has(dependency.token)
        );

        expect({ runtime, overlap }).toEqual({ runtime, overlap: [] });
      }
    });
  });

  describe('the HR seam: a declaration that outlived its own placeholder', () => {
    const boundWith = (clients: Map<Datasource, unknown>): DatasourceProbeProvider[] => {
      const provider = createDatasourceProbeProviders('future-hr') as FactoryProvider;
      const received = datasourceProbeDefinitions('future-hr').map((definition) =>
        clients.get(definition.datasource)
      );

      return (provider.useFactory as (...args: unknown[]) => DatasourceProbeProvider[])(
        ...received
      );
    };

    it('binds the HR definition to the HR client token that HrPrismaModule provides', () => {
      expect(DATASOURCE_PROBES.HR_DATABASE_URL.clientToken).toBe(HR_PRISMA_CLIENT);
    });

    it('binds the HR datasource as soon as an HR client is handed to the factory', () => {
      const hrClient = { $queryRaw: async () => [{ '?column?': 1 }] };
      const bound = boundWith(new Map<Datasource, unknown>([['HR_DATABASE_URL', hrClient]]));

      expect(bound.map((provider) => provider.datasource)).toEqual(['HR_DATABASE_URL']);
    });

    it('binds nothing at all when no client is handed over, so the runtime fails closed', () => {
      expect(boundWith(new Map<Datasource, unknown>())).toEqual([]);
    });

    it('pins no outstanding target at all, now that Commerce has arrived', () => {
      // The mirror image of the gate this suite used to assert. While HR was a `target`,
      // this test pinned `['HR_DATABASE_URL']` as the ONE outstanding client, so "HR is
      // still a placeholder" could not quietly survive its arrival — and the day HR became
      // `implemented`, the list had to become empty. Phase C1 repeated the move for
      // Commerce: this test pinned `['COMMERCE_DATABASE_URL']` while the Commerce OWNER
      // was a `target` (steps A–E), and Phase C1 step F IS that arrival — schema,
      // migrations, generated client and Prisma module/service exist, the owner status is
      // `implemented`, and the list is empty again. An empty list is the whole point: it
      // says every owner the runtimes actually instantiate has REAL artifacts behind it.
      const awaitingAnywhere = DATASOURCES.filter(
        (datasource) => DATASOURCE_OWNERS[datasource].status === 'target'
      );

      expect(awaitingAnywhere).toEqual([]);

      // Commerce is `not-used` in `core`, `cms` and `future-hr`, so those runtimes plan no
      // probe for it even though its client exists; in the COMBINED runtime it is now
      // `required` and `implemented`, so it is instantiated with a bound client rather
      // than awaiting one.
      expect(datasourcesAwaitingProbeClient('future-hr')).toEqual([]);

      for (const runtime of RUNTIME_IDS) {
        expect({
          runtime,
          awaiting: datasourcesAwaitingProbeClient(runtime),
        }).toEqual({ runtime, awaiting: [] });
      }
    });
  });
});
