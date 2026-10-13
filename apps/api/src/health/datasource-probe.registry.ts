import { Provider } from '@nestjs/common';
import {
  DATASOURCE_OWNERS,
  Datasource,
  RuntimeId,
  instantiatedDatasources,
} from '../runtime-datasources';
import {
  CMS_PRISMA_CLIENT,
  COMMERCE_PRISMA_CLIENT,
  CORRESPONDENCE_PRISMA_CLIENT,
  CORE_PRISMA_CLIENT,
  FINANCE_PRISMA_CLIENT,
  HR_PRISMA_CLIENT,
  OBSERVABILITY_PRISMA_CLIENT,
  PRODUCTION_PRISMA_CLIENT,
  ObservabilityPrismaLike,
  PrismaLikeClient,
} from './health-tokens';

/**
 * Phase ARCH-2: the datasource PROBE REGISTRY — the seam between "which datasource"
 * and "how to reach it".
 *
 * Before ARCH-2 the health engine held one optional constructor parameter per
 * datasource and resolved them with a private `switch (datasource)`: the engine itself
 * knew that `CORE_DATABASE_URL` means `corePrisma`, and that
 * `OBSERVABILITY_DATABASE_URL` means `observabilityPrisma.ping()`. Every new datasource
 * therefore meant editing the engine — and `HR_DATABASE_URL` was already a branch in
 * that switch returning `undefined`, i.e. the engine had been taught about a datasource
 * that does not exist.
 *
 * There are now three separate things, and none of them is the engine:
 *
 *   1. `DatasourceProbeProvider` — the ONLY question the engine asks about a datasource:
 *      "probe yourself and tell me whether you answered".
 *   2. `DATASOURCE_PROBES` — a declaration, one entry per datasource, of which client
 *      token carries that datasource's client and how to probe it. It is a
 *      `Record<Datasource, ...>`, so adding a datasource without declaring how to probe
 *      it is a COMPILE error rather than a runtime surprise.
 *   3. `createDatasourceProbeProviders(runtime)` — assembles the registry for one
 *      runtime from the RUNTIME POLICY: the plan is exactly
 *      `instantiatedDatasources(runtime)`, so a datasource the policy marks `not-used`
 *      has no provider and can never be probed, and a datasource the policy
 *      instantiates is in the plan even when no client is bound yet.
 *
 * Registration is `optional` — deliberately. A plan entry whose client token has no
 * provider in the graph yields NO registered provider, which the engine reports as
 * `failed` (fail closed). The alternative readings are both wrong: a hard DI error
 * would make a datasource un-bootable, and treating "no client" as "fine" is how a
 * readiness endpoint ends up certifying a database it never touched.
 */

/** The one question the health engine asks about a datasource. */
export interface DatasourceProbeProvider {
  readonly datasource: Datasource;
  query(): Promise<boolean>;
}

/**
 * The assembled registry, injected into `DatasourceHealthProbe`.
 *
 * It is an ARRAY value under one token rather than one token per datasource, because
 * the engine must not be able to look a datasource up by naming a token: it receives
 * whatever this runtime's policy produced, keyed by the datasource each provider
 * declares for itself.
 */
export const DATASOURCE_PROBE_PROVIDERS = Symbol('DATASOURCE_PROBE_PROVIDERS');

/** How to probe ONE datasource, using the client THAT datasource's token carries. */
export interface DatasourceProbeDefinition {
  readonly datasource: Datasource;
  /** The injection token of this datasource's client, and of no other datasource. */
  readonly clientToken: symbol;
  /**
   * Turns an injected client into a probe provider.
   *
   * The parameter is `unknown` because the registry is heterogeneous: a SQL datasource
   * client answers `$queryRaw`, the observability client answers `ping()`. The cast
   * that narrows it lives here, once per datasource, next to the reason for it —
   * instead of in the engine, where it would be a switch.
   */
  bind(client: unknown): DatasourceProbeProvider;
}

/**
 * A datasource whose client can answer a bare `SELECT 1` on its own connection.
 *
 * Core, CMS, Correspondence and HR share this because they are the same shape of
 * question — "does this client's database answer at all?" — and nothing more: a
 * readiness probe that ran business queries would be a probe that fails for business
 * reasons.
 */
function sqlProbe(datasource: Datasource, clientToken: symbol): DatasourceProbeDefinition {
  return {
    datasource,
    clientToken,
    bind: (client) => {
      const prisma = client as PrismaLikeClient;
      return {
        datasource,
        query: async () => {
          await prisma.$queryRaw`SELECT 1`;
          return true;
        },
      };
    },
  };
}

/**
 * One entry per declared datasource — the completeness is the type.
 *
 * `HR_DATABASE_URL` is declared here alongside the others, and Phase 51-HR-1 is what
 * made the declaration pay off: `prisma/hr`, `HrPrismaModule` and its client now exist,
 * so this entry's token is bound in the combined runtime's graph and HR is probed with
 * no change to the health engine, the controller or the evaluator. The entry existed
 * BEFORE the domain did — for two phases — and that is the point: the seam was proven
 * while it was still empty, so shipping HR could not require editing the engine.
 *
 * Phase C1 repeats that move for Commerce: `COMMERCE_DATABASE_URL` is declared here
 * the moment the datasource is declared, while the Commerce OWNER is still a
 * `target`. The probe seam exists before the domain does, so shipping Commerce is a
 * matter of binding `COMMERCE_PRISMA_CLIENT` in `CommercePrismaModule` — again with
 * no change to the engine.
 */
export const DATASOURCE_PROBES: Record<Datasource, DatasourceProbeDefinition> = {
  CORE_DATABASE_URL: sqlProbe('CORE_DATABASE_URL', CORE_PRISMA_CLIENT),
  CMS_DATABASE_URL: sqlProbe('CMS_DATABASE_URL', CMS_PRISMA_CLIENT),
  OBSERVABILITY_DATABASE_URL: {
    datasource: 'OBSERVABILITY_DATABASE_URL',
    clientToken: OBSERVABILITY_PRISMA_CLIENT,
    bind: (client) => {
      const observability = client as ObservabilityPrismaLike;
      return {
        datasource: 'OBSERVABILITY_DATABASE_URL',
        query: () => observability.ping(),
      };
    },
  },
  CORRESPONDENCE_DATABASE_URL: sqlProbe(
    'CORRESPONDENCE_DATABASE_URL',
    CORRESPONDENCE_PRISMA_CLIENT
  ),
  HR_DATABASE_URL: sqlProbe('HR_DATABASE_URL', HR_PRISMA_CLIENT),
  COMMERCE_DATABASE_URL: sqlProbe('COMMERCE_DATABASE_URL', COMMERCE_PRISMA_CLIENT),
  // Phase PRODUCTION-BOM-HEADER: Production's datasource, declared here with the probe
  // definition its module binds. The token has a provider from the first phase that
  // declares the datasource, so the probe is live the moment a runtime's policy
  // instantiates it; a runtime that marks it `not-used` never reaches this entry.
  PRODUCTION_DATABASE_URL: sqlProbe('PRODUCTION_DATABASE_URL', PRODUCTION_PRISMA_CLIENT),
  // Phase F1 — FINANCIAL FOUNDATION: the same entry for Financial's datasource; the
  // token's provider is `FinancialPrismaModule`, and only a runtime whose policy
  // instantiates `FINANCE_DATABASE_URL` ever reaches this definition.
  FINANCE_DATABASE_URL: sqlProbe('FINANCE_DATABASE_URL', FINANCE_PRISMA_CLIENT),
};

/**
 * What this runtime's policy tells the registry to register, in policy order.
 *
 * The plan is derived from the policy and nothing else, which is what makes "the
 * registered providers" and "the instantiated datasources" the same set by
 * construction rather than by review.
 */
export function datasourceProbeDefinitions(runtime: RuntimeId): DatasourceProbeDefinition[] {
  return instantiatedDatasources(runtime).map((datasource) => DATASOURCE_PROBES[datasource]);
}

/**
 * Instantiated datasources whose client artifact does not exist yet.
 *
 * This is a DECLARATION-level fact (`DATASOURCE_OWNERS[datasource].status`), not a
 * runtime one: it says which datasource is expected to have no client bound anywhere in
 * the repository today. Every owner is `implemented` as of Phase 51-HR-1, so this
 * returns `[]` for every runtime — which is the assertion that replaced "HR has not
 * arrived yet". The function stays because a future owner will be declared before it is
 * built, and the architecture tests fail if such an owner is silently instantiated with
 * no client.
 */
export function datasourcesAwaitingProbeClient(runtime: RuntimeId): Datasource[] {
  return instantiatedDatasources(runtime).filter(
    (datasource) => DATASOURCE_OWNERS[datasource].status === 'target'
  );
}

/**
 * The registry provider of one runtime's health graph.
 *
 * `inject` is built from the plan, so the set of injected tokens IS the policy: there
 * is no second list that a datasource could be missing from, or present in by mistake.
 */
export function createDatasourceProbeProviders(runtime: RuntimeId): Provider {
  const definitions = datasourceProbeDefinitions(runtime);

  return {
    provide: DATASOURCE_PROBE_PROVIDERS,
    inject: definitions.map((definition) => ({
      token: definition.clientToken,
      optional: true,
    })),
    useFactory: (...clients: unknown[]): DatasourceProbeProvider[] =>
      definitions.flatMap((definition, index) => {
        const client = clients[index];
        return client === undefined || client === null ? [] : [definition.bind(client)];
      }),
  };
}
