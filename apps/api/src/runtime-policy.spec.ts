import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  DATASOURCE_OWNERS,
  DATASOURCES,
  INFRASTRUCTURE_SERVICES,
  RUNTIME_DOCKER_IMAGE,
  RUNTIME_HEALTH_COMPOSITION,
  RUNTIME_IDS,
  RuntimeId,
  instantiatedDatasources,
  notUsedDatasources,
  prunedClientDirsForRuntime,
  requiredDatasources,
  runtimePolicy,
} from './runtime-datasources';
import {
  POLICY_PROJECTION_FILE,
  buildRuntimePolicyProjection,
  serializeRuntimePolicyProjection,
} from './runtime-policy.projection';
import {
  datasourceProbeDefinitions,
  datasourcesAwaitingProbeClient,
} from './health/datasource-probe.registry';

/**
 * Phase ARCH-1.3: the runtime policy is ONE declaration with THREE consumers, so
 * this file turns agreement between them into a failing test instead of a review.
 *
 * Consumers:
 *   1. health      — health/{core,cms,combined}-health.module.ts + the probes
 *   2. images      — infrastructure/docker/Dockerfile.{core,cms,backend}
 *   3. tooling     — apps/api/runtime-policy.json, read by scripts/runtime-policy.mjs
 *
 * The rules below are deliberately written against the FILESYSTEM and the committed
 * JSON, not against re-imported constants: a spec that only compared two imported
 * objects would pass even if a Dockerfile, a health module or the committed JSON had
 * drifted — which is exactly the failure this phase exists to prevent.
 */

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

/**
 * A JSON document rendered with sorted keys and no whitespace.
 *
 * Two documents rendered this way are equal exactly when they hold the same data, so
 * this is what "the committed projection has not drifted" should be measured with:
 * comparing the raw file text would make the drift check a formatter check — red on a
 * whitespace-only rewrite, silently green on a reformatted file with a stale field
 * removed if the indentation happened to match. Key order is sorted away too, because
 * a projection that lists the same facts in a different order is the same projection.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The runtime-policy helper the Dockerfiles shell out to. */
const POLICY_SCRIPT = path.join(apiRoot, 'scripts', 'runtime-policy.mjs');
const policyScriptSource = read(POLICY_SCRIPT);

/**
 * Generated clients a Dockerfile lists in a `rm -rf` prune line, BY NAME.
 *
 * Phase ARCH-1.3 made every image derive its prune list at build time
 * (`node apps/api/scripts/runtime-policy.mjs prune-clients-for <runtime>`), so this
 * is expected to come back empty — and the emptiness is the assertion. A client
 * name written out in a Dockerfile is a SECOND copy of the artifact boundary, and a
 * second copy is what drifts: the previous `rm -rf .../cms-client` list here stopped
 * matching the policy the moment a datasource or runtime changed, silently shipping
 * (or pruning) the wrong generated client.
 */
function prunedClientsInDockerfile(dockerfile: string): string[] {
  const pruned = new Set<string>();
  for (const match of read(dockerfile).matchAll(/rm -rf[^\n]*/g)) {
    for (const dir of match[0].matchAll(/([\w-]+)-client/g)) {
      pruned.add(dir[0]);
    }
  }
  return [...pruned].sort();
}

/**
 * Prisma module classes a runtime health module imports.
 *
 * Two specifier shapes exist and both must be matched, because the Core client
 * module is the older `database/prisma.module.ts` while every other owner uses
 * `database/<owner>-prisma.module.ts`: matching only on the capitalised
 * `PrismaModule` token finds nothing, since a module PATH is lowercase.
 */
function prismaModulesInHealthModule(moduleFile: string): string[] {
  const classes = new Set<string>();
  for (const match of read(moduleFile).matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*prisma\.module['"]/gi
  )) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed.endsWith('PrismaModule')) classes.add(trimmed);
    }
  }
  return [...classes].sort();
}

/** Prisma module classes the policy says a runtime instantiates. */
function expectedPrismaModules(runtime: RuntimeId): string[] {
  return [
    ...new Set(instantiatedDatasources(runtime).map((d) => DATASOURCE_OWNERS[d].prismaModuleClass)),
  ].sort();
}

/**
 * The runtime a Dockerfile passes to the policy helper, or null if it passes none.
 *
 * The capture is `[\w-]+` rather than `\S+` because the call sits inside shell
 * command substitution — `$(node ... prune-clients-for core); do` — so a
 * whitespace-delimited match would return `core);` instead of `core`.
 */
function prunedRuntimeInDockerfile(dockerfile: string): string | null {
  const match = read(dockerfile).match(/prune-clients-for\s+([\w-]+)/);
  return match ? match[1] : null;
}

/** Runs `scripts/runtime-policy.mjs` exactly as a Dockerfile does, through node. */
function runPolicyScript(...args: string[]): string[] {
  const output = execFileSync(process.execPath, [POLICY_SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Runs it expecting failure, returning the exit code and stderr. */
function runPolicyScriptExpectingFailure(...args: string[]): { status: number; stderr: string } {
  try {
    runPolicyScript(...args);
  } catch (err) {
    const failure = err as { status?: number; stderr?: Buffer | string };
    const stderr = failure.stderr ?? '';
    return {
      status: failure.status ?? 1,
      stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
    };
  }
  throw new Error(`expected "${args.join(' ')}" to exit non-zero, but it succeeded`);
}

/** The clients a Dockerfile must not ship, according to the projection. */
function expectedPrunedClients(runtime: RuntimeId): string[] {
  const disclosed = RUNTIME_DOCKER_IMAGE[runtime].prunedArtifacts.map((a) => a.clientDir);
  return [...new Set([...prunedClientDirsForRuntime(runtime), ...disclosed])].sort();
}

const dockerRuntimeEntries = RUNTIME_IDS.map((runtime) => ({
  runtime,
  dockerfile: RUNTIME_DOCKER_IMAGE[runtime].dockerfile,
})).filter(
  (entry): entry is { runtime: RuntimeId; dockerfile: string } => entry.dockerfile !== null
);

describe('runtime policy projection and its consumers', () => {
  const projection = buildRuntimePolicyProjection();

  describe('the committed projection', () => {
    it('exists next to the policy it describes', () => {
      expect(fs.existsSync(path.join(apiRoot, POLICY_PROJECTION_FILE))).toBe(true);
    });

    it('holds exactly the data runtime-datasources.ts projects, whatever the whitespace', () => {
      // The remedy is stated in the failure message because the fix is mechanical.
      const onDisk: unknown = JSON.parse(read(path.join(apiRoot, POLICY_PROJECTION_FILE)));
      const projected: unknown = JSON.parse(serializeRuntimePolicyProjection(projection));
      const verdict =
        canonicalJson(onDisk) === canonicalJson(projected)
          ? 'in sync'
          : `DRIFTED — regenerate with: ${projection.generatedBy}`;
      expect(verdict).toBe('in sync');
    });

    it('ends with exactly one newline, so the repo formatter leaves it alone', () => {
      // Whitespace is not a correctness property, but this file is GENERATED and the
      // repo's `format` / `format:check` glob `**/*.json`: a stray blank line at EOF is
      // enough to make the formatter rewrite a generated artifact, which is how the
      // "does a script or a human own this file?" question comes back.
      const onDisk = read(path.join(apiRoot, POLICY_PROJECTION_FILE));
      expect({
        endsWithSingleNewline: onDisk.endsWith('\n') && !onDisk.endsWith('\n\n'),
      }).toEqual({ endsWithSingleNewline: true });
    });

    it('names the file it was projected from', () => {
      expect(projection.projectionOf).toBe('apps/api/src/runtime-datasources.ts');
    });
  });

  describe('the projection states every runtime fact once', () => {
    it('covers every runtime', () => {
      expect(Object.keys(projection.runtimes).sort()).toEqual([...RUNTIME_IDS].sort());
    });

    it('carries the policy requirements verbatim for every runtime, datasource and service', () => {
      for (const runtime of RUNTIME_IDS) {
        const entry = projection.runtimes[runtime];
        const policy = runtimePolicy(runtime);
        for (const datasource of DATASOURCES) {
          expect({
            runtime,
            datasource,
            requirement: entry.datasources[datasource].requirement,
          }).toEqual({ runtime, datasource, requirement: policy.datasources[datasource] });
        }
        for (const service of INFRASTRUCTURE_SERVICES) {
          expect({
            runtime,
            service,
            requirement: entry.infrastructure[service].requirement,
          }).toEqual({ runtime, service, requirement: policy.infrastructure[service] });
        }
      }
    });

    it('derives instantiated / not-used from the requirements alone', () => {
      for (const runtime of RUNTIME_IDS) {
        const entry = projection.runtimes[runtime];
        expect(entry.instantiatedDatasources).toEqual(instantiatedDatasources(runtime));
        expect(entry.notUsedDatasources).toEqual(notUsedDatasources(runtime));
        expect(entry.instantiatedDatasources.length + entry.notUsedDatasources.length).toBe(
          DATASOURCES.length
        );
      }
    });

    it('never lists a datasource as both instantiated and not-used', () => {
      for (const runtime of RUNTIME_IDS) {
        const entry = projection.runtimes[runtime];
        const overlap = entry.instantiatedDatasources.filter((d) =>
          entry.notUsedDatasources.includes(d)
        );
        expect({ runtime, overlap }).toEqual({ runtime, overlap: [] });
      }
    });

    it('describes every datasource owner exactly as declared, with no second copy of the matrix', () => {
      for (const runtime of RUNTIME_IDS) {
        for (const datasource of DATASOURCES) {
          const declared = DATASOURCE_OWNERS[datasource];
          expect(projection.runtimes[runtime].datasources[datasource]).toEqual({
            requirement: runtimePolicy(runtime).datasources[datasource],
            owner: declared.owner,
            prismaProject: declared.prismaProject,
            prismaSchema: declared.prismaSchema,
            generatedClientDir: declared.generatedClientDir,
            generateScript: declared.generateScript,
            artifactStatus: declared.status,
          });
        }
      }
    });

    it('carries the health composition of every runtime', () => {
      for (const runtime of RUNTIME_IDS) {
        const declared = RUNTIME_HEALTH_COMPOSITION[runtime];
        expect(projection.runtimes[runtime].health).toEqual({
          className: declared.className,
          file: declared.file,
          appModuleFile: declared.appModuleFile,
          status: declared.status,
        });
      }
    });
  });

  describe('the unit-conversion policy: required vs optional vs not-used', () => {
    it('never blocks readiness on a dependency it does not require', () => {
      // The evaluator blocks on `required` only, so this is the rule the readiness
      // endpoint is really built on: every non-required entry must be absent from
      // requiredDatasources.
      for (const runtime of RUNTIME_IDS) {
        const required = requiredDatasources(runtime);
        for (const datasource of DATASOURCES) {
          const requirement = runtimePolicy(runtime).datasources[datasource];
          expect({ runtime, datasource, blocking: required.includes(datasource) }).toEqual({
            runtime,
            datasource,
            blocking: requirement === 'required',
          });
        }
      }
    });

    it('keeps every runtime able to reach Core, the shared identity database', () => {
      for (const runtime of RUNTIME_IDS) {
        expect({ runtime, required: runtimePolicy(runtime).datasources.CORE_DATABASE_URL }).toEqual(
          {
            runtime,
            required: 'required',
          }
        );
      }
    });

    it('requires HR exactly where a process serves it, and marks it not-used everywhere else', () => {
      // Phase 51-HR-1: the combined runtime HOSTS the HR module (`AppModule` imports
      // `HrModule`) and therefore requires `hr_db`, exactly as it requires
      // `correspondence_db` for the module that lives there. `core` and `cms` still never
      // open it, which is what keeps the Core-only and CMS-only images free of the HR
      // client and the HR routes.
      for (const runtime of RUNTIME_IDS) {
        const servesHr = runtime === 'combined' || runtime === 'future-hr';
        expect({ runtime, hr: runtimePolicy(runtime).datasources.HR_DATABASE_URL }).toEqual({
          runtime,
          hr: servesHr ? 'required' : 'not-used',
        });
      }
    });

    it('declares a requirement for every service of every runtime, never a missing lookup', () => {
      for (const runtime of RUNTIME_IDS) {
        for (const service of INFRASTRUCTURE_SERVICES) {
          const requirement = runtimePolicy(runtime).infrastructure[service];
          expect({
            runtime,
            service,
            valid: ['required', 'optional', 'not-used'].includes(requirement),
          }).toEqual({ runtime, service, valid: true });
        }
      }
    });
  });

  describe('each image derives its artifact boundary from the policy', () => {
    it('declares an image for every runtime that has one, and none that does not exist yet', () => {
      expect(dockerRuntimeEntries.map((entry) => entry.runtime)).toEqual([
        'core',
        'cms',
        'combined',
      ]);
      // Phase 51-HR: `future-hr` has no image, and must not gain one before its
      // runtime exists. The absence is declared, not merely forgotten.
      expect(RUNTIME_DOCKER_IMAGE['future-hr'].dockerfile).toBeNull();
    });

    it('exists on disk wherever the policy says it does', () => {
      for (const { runtime, dockerfile } of dockerRuntimeEntries) {
        expect({ runtime, exists: fs.existsSync(path.join(repoRoot, dockerfile)) }).toEqual({
          runtime,
          exists: true,
        });
      }
    });

    it('does not enumerate generated client names in a Dockerfile', () => {
      for (const { runtime, dockerfile } of dockerRuntimeEntries) {
        expect({
          runtime,
          enumerated: prunedClientsInDockerfile(path.join(repoRoot, dockerfile)),
        }).toEqual({ runtime, enumerated: [] });
      }
    });

    it('prunes the list of its OWN runtime, not another runtime’s', () => {
      // `prune-clients-for cms` inside the Core image would silently ship CMS's
      // clients in the Core image: the boundary would look derived while being wrong.
      for (const { runtime, dockerfile } of dockerRuntimeEntries) {
        expect({
          runtime,
          prunesFor: prunedRuntimeInDockerfile(path.join(repoRoot, dockerfile)),
        }).toEqual({ runtime, prunesFor: runtime });
      }
    });

    it('discloses every opt-out as a reason, never as a silent extra prune', () => {
      for (const runtime of RUNTIME_IDS) {
        for (const artifact of RUNTIME_DOCKER_IMAGE[runtime].prunedArtifacts) {
          expect({
            runtime,
            artifact: artifact.clientDir,
            justified: artifact.reason.trim().length > 0,
          }).toEqual({ runtime, artifact: artifact.clientDir, justified: true });
        }
      }
    });
  });

  describe('each health module is exactly its runtime policy graph', () => {
    const implementedRuntimes = RUNTIME_IDS.filter(
      (runtime) => RUNTIME_HEALTH_COMPOSITION[runtime].status === 'implemented'
    );

    it('covers the runtimes the composition declares implemented', () => {
      expect(implementedRuntimes).toEqual(['core', 'cms', 'combined']);
    });

    it('exists at the declared path, and declares the class the composition names', () => {
      for (const runtime of implementedRuntimes) {
        const composition = RUNTIME_HEALTH_COMPOSITION[runtime];
        const file = path.join(apiRoot, 'src', composition.file);
        expect({ runtime, exists: fs.existsSync(file) }).toEqual({ runtime, exists: true });
        expect({
          runtime,
          declaresClass: read(file).includes(`export class ${composition.className}`),
        }).toEqual({ runtime, declaresClass: true });
      }
    });

    it('imports precisely the Prisma modules of its INSTANTIATED datasources', () => {
      // The graph is the policy: a `not-used` datasource must have no Prisma module
      // here, and an instantiated one must have exactly its own. Core's and CMS's
      // health modules are the two cases where getting this wrong is easy, because
      // both instantiate Core and only one of them owns CMS.
      for (const runtime of implementedRuntimes) {
        const file = path.join(apiRoot, 'src', RUNTIME_HEALTH_COMPOSITION[runtime].file);
        expect({ runtime, imports: prismaModulesInHealthModule(file) }).toEqual({
          runtime,
          imports: expectedPrismaModules(runtime),
        });
      }
    });

    it('has no health module for a runtime that is not implemented', () => {
      const target = RUNTIME_IDS.find(
        (runtime) => RUNTIME_HEALTH_COMPOSITION[runtime].status === 'target'
      ) as RuntimeId;
      expect(target).toBe('future-hr');
      expect(
        fs.existsSync(path.join(apiRoot, 'src', RUNTIME_HEALTH_COMPOSITION[target].file))
      ).toBe(false);
    });

    it('registers a probe provider for exactly the datasources its policy instantiates', () => {
      // Phase ARCH-2: provider registration is derived from this policy and from nothing
      // else, so the two sets are equal for every runtime — including `future-hr`, where HR
      // is planned and has no client bound anywhere yet.
      for (const runtime of RUNTIME_IDS) {
        expect({
          runtime,
          planned: datasourceProbeDefinitions(runtime).map((definition) => definition.datasource),
        }).toEqual({ runtime, planned: instantiatedDatasources(runtime) });
      }
    });

    it('requires a client only for a datasource whose artifact exists, and fails closed otherwise', () => {
      // `target` is the ONLY reason a planned datasource may have no client anywhere in the
      // repository, and this derives it from the committed PROJECTION rather than from the
      // source constant. Phase 51-HR-1 was written to cross exactly this gate: the day HR
      // became `implemented`, the list below had to become empty — proving the HR client is
      // bound rather than merely planned — instead of a stale "ready for HR" claim surviving
      // HR's arrival.
      for (const runtime of RUNTIME_IDS) {
        const awaiting = datasourcesAwaitingProbeClient(runtime);
        const targets = instantiatedDatasources(runtime).filter(
          (datasource) =>
            projection.runtimes[runtime].datasources[datasource].artifactStatus === 'target'
        );
        expect({ runtime, awaiting }).toEqual({ runtime, awaiting: targets });
      }
      expect(datasourcesAwaitingProbeClient('future-hr')).toEqual([]);
    });
  });

  describe('the runtime-policy helper the Dockerfiles call', () => {
    it('is the bridge the Dockerfiles use, and reads the committed projection', () => {
      expect(fs.existsSync(POLICY_SCRIPT)).toBe(true);
      // The script must not carry a second copy of the policy: it reads the JSON.
      expect(policyScriptSource).toContain(POLICY_PROJECTION_FILE);
    });

    it('is named in every Dockerfile that exists', () => {
      for (const { runtime, dockerfile } of dockerRuntimeEntries) {
        expect({
          runtime,
          usesHelper: read(path.join(repoRoot, dockerfile)).includes('runtime-policy.mjs'),
        }).toEqual({ runtime, usesHelper: true });
      }
    });

    it('lists every declared runtime', () => {
      expect(runPolicyScript('runtimes')).toEqual([...RUNTIME_IDS]);
    });

    it('reports the clients each runtime must not ship, matching the source policy', () => {
      for (const runtime of RUNTIME_IDS) {
        expect({ runtime, pruned: runPolicyScript('prune-clients-for', runtime) }).toEqual({
          runtime,
          pruned: expectedPrunedClients(runtime),
        });
      }
    });

    it('reports the clients each runtime must ship, matching the source policy', () => {
      for (const runtime of RUNTIME_IDS) {
        const pruned = new Set(expectedPrunedClients(runtime));
        const shipped = projection.runtimes[runtime].generatedClientDirs
          .filter((dir) => !pruned.has(dir))
          .sort();
        expect({ runtime, shipped: runPolicyScript('shipped-clients-for', runtime) }).toEqual({
          runtime,
          shipped,
        });
      }
    });

    it('fails loudly on an unknown runtime instead of printing nothing', () => {
      // Printing nothing in a Dockerfile means "prune nothing" — a silent artifact
      // leak, which is the exact failure this helper exists to prevent.
      const failure = runPolicyScriptExpectingFailure('prune-clients-for', 'no-such-runtime');
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).toMatch(/unknown runtime "no-such-runtime"/);
      expect(failure.stderr).toMatch(/core/);
    });

    it('fails loudly on an unknown command instead of printing nothing', () => {
      const failure = runPolicyScriptExpectingFailure('prune-everything');
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).toMatch(/unknown command "prune-everything"/);
    });
  });
});
