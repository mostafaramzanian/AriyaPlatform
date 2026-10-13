/**
 * Phase ARCH-1.3: the machine-readable projection of the runtime policy.
 *
 * `runtime-datasources.ts` is the single declaration; this module is the ONE
 * function that turns it into a stable, order-independent JSON document. It is used
 * by two callers and by nothing else:
 *
 *   - `scripts/emit-runtime-policy.ts` (`npm run arch:policy`) writes
 *     `apps/api/runtime-policy.json` from it.
 *   - `runtime-policy.spec.ts` calls it in-process and compares the result with the
 *     committed JSON, so a policy change that was not regenerated fails a test
 *     rather than shipping a stale projection to Docker.
 *
 * Everything here is DERIVED: there is no requirement, owner, project or client
 * directory written down twice, so the projection cannot disagree with the policy
 * it describes. Key order is the declaration order in `runtime-datasources.ts`,
 * which makes the emitted file diffable instead of random.
 */
import {
  DATASOURCE_OWNERS,
  DATASOURCES,
  Datasource,
  INFRASTRUCTURE_SERVICES,
  InfrastructureService,
  RUNTIME_DOCKER_IMAGE,
  RUNTIME_HEALTH_COMPOSITION,
  RUNTIME_IDS,
  Requirement,
  RuntimeId,
  generatedClientDirsForRuntime,
  instantiatedDatasources,
  notUsedDatasources,
  ownersForRuntime,
  prismaProjectsForRuntime,
  prunedClientDirsForRuntime,
  runtimePolicy,
  prismaGenerateScriptsForRuntime,
} from './runtime-datasources';

/** Path of the projection, relative to `apps/api` (and to the repository root). */
export const POLICY_PROJECTION_FILE = 'runtime-policy.json';

/** The command that regenerates the projection. Printed in the file and in errors. */
export const POLICY_PROJECTION_GENERATOR = 'npm run arch:policy --workspace=apps/api';

/** The source of truth the projection is derived from, relative to the repo root. */
export const POLICY_SOURCE_FILE = 'apps/api/src/runtime-datasources.ts';

export interface DatasourceProjection {
  readonly requirement: Requirement;
  readonly owner: string;
  readonly prismaProject: string;
  readonly prismaSchema: string;
  readonly generatedClientDir: string;
  readonly generateScript: string;
  /** `implemented` | `target`: whether the owner's artifacts exist yet. */
  readonly artifactStatus: string;
}

export interface RuntimePolicyProjectionEntry {
  readonly runtime: RuntimeId;
  readonly datasources: Record<Datasource, DatasourceProjection>;
  readonly infrastructure: Record<InfrastructureService, { readonly requirement: Requirement }>;
  readonly instantiatedDatasources: Datasource[];
  readonly notUsedDatasources: Datasource[];
  readonly instantiatedOwners: string[];
  readonly notInstantiatedOwners: string[];
  readonly prismaProjects: string[];
  readonly generatedClientDirs: string[];
  readonly prunedClientDirs: string[];
  readonly generateScripts: string[];
  readonly health: {
    readonly className: string;
    readonly file: string;
    readonly appModuleFile: string;
    readonly status: string;
  };
  readonly image: {
    readonly dockerfile: string | null;
    readonly prunedArtifacts: { readonly clientDir: string; readonly reason: string }[];
  };
}

export interface RuntimePolicyProjection {
  readonly projectionOf: string;
  readonly generatedBy: string;
  readonly runtimes: Record<RuntimeId, RuntimePolicyProjectionEntry>;
}

export function buildRuntimePolicyProjection(): RuntimePolicyProjection {
  const runtimes = {} as Record<RuntimeId, RuntimePolicyProjectionEntry>;

  for (const runtime of RUNTIME_IDS) {
    const policy = runtimePolicy(runtime);

    const datasources = {} as Record<Datasource, DatasourceProjection>;
    for (const datasource of DATASOURCES) {
      const owner = DATASOURCE_OWNERS[datasource];
      datasources[datasource] = {
        requirement: policy.datasources[datasource],
        owner: owner.owner,
        prismaProject: owner.prismaProject,
        prismaSchema: owner.prismaSchema,
        generatedClientDir: owner.generatedClientDir,
        generateScript: owner.generateScript,
        artifactStatus: owner.status,
      };
    }

    const infrastructure = {} as Record<InfrastructureService, { requirement: Requirement }>;
    for (const service of INFRASTRUCTURE_SERVICES) {
      infrastructure[service] = { requirement: policy.infrastructure[service] };
    }

    const health = RUNTIME_HEALTH_COMPOSITION[runtime];
    const image = RUNTIME_DOCKER_IMAGE[runtime];

    runtimes[runtime] = {
      runtime,
      datasources,
      infrastructure,
      instantiatedDatasources: instantiatedDatasources(runtime),
      notUsedDatasources: notUsedDatasources(runtime),
      instantiatedOwners: ownersForRuntime(runtime),
      notInstantiatedOwners: ownersForRuntime(runtime, 'not-instantiated'),
      prismaProjects: prismaProjectsForRuntime(runtime),
      generatedClientDirs: generatedClientDirsForRuntime(runtime),
      prunedClientDirs: prunedClientDirsForRuntime(runtime),
      generateScripts: prismaGenerateScriptsForRuntime(runtime),
      health: {
        className: health.className,
        file: health.file,
        appModuleFile: health.appModuleFile,
        status: health.status,
      },
      image: {
        dockerfile: image.dockerfile,
        prunedArtifacts: image.prunedArtifacts.map((artifact) => ({ ...artifact })),
      },
    };
  }

  return {
    projectionOf: POLICY_SOURCE_FILE,
    generatedBy: POLICY_PROJECTION_GENERATOR,
    runtimes,
  };
}

/**
 * The projection as a JSON document: stable key order (policy declaration order, so
 * diffs stay reviewable), two-space indent.
 *
 * This is the CONTENT of the committed file, not necessarily its final bytes: the
 * emitter (`scripts/emit-runtime-policy.ts`) runs this through the repo's prettier
 * config before writing, so that `npm run format` treats `runtime-policy.json` as
 * already formatted and never rewrites it. Consumers that must agree with the file
 * compare PARSED documents (see `runtime-policy.spec.ts`), which is insensitive to
 * both whitespace and key order.
 */
export function serializeRuntimePolicyProjection(
  projection = buildRuntimePolicyProjection()
): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
