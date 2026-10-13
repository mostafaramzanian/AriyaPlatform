import * as fs from 'fs';
import * as path from 'path';
import {
  DATASOURCE_OWNERS,
  RUNTIME_DOCKER_IMAGE,
  RUNTIME_IDS,
  RuntimeId,
  requiredDatasources,
} from './runtime-datasources';

/**
 * Phase POST-SMOKE: guard against the Docker packaging drift observed in
 * Phase Live Runtime & E2E Smoke Verification:
 *
 *   The combined runtime image did not COPY `apps/api/prisma/observability`,
 *   so `npm run db:migrate` inside the container failed even though the
 *   repository's own orchestration includes `prisma:migrate:observability`.
 *
 * This spec asserts that every runtime image carries the Prisma project(s)
 * its deployment contract actually needs. The expected set is derived from
 * the canonical runtime policy in `runtime-datasources.ts`, so a new owner
 * cannot pass the gate without being represented in both places.
 *
 * Distinction between required and optional artifacts is preserved:
 *   - core / cms images copy only the projects of their REQUIRED datasources.
 *   - combined image copies every implemented Prisma project because it is
 *     the all-owner runtime and the target of `npm run db:migrate`.
 */

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** Prisma project directories the Dockerfile COPYs from the builder stage. */
function copiedPrismaProjects(dockerfile: string): string[] {
  const regex = /COPY --from=builder \/app\/apps\/api\/prisma\/(\w+) .\/apps\/api\/prisma\/\1/g;
  const matches = [...read(dockerfile).matchAll(regex)];
  return matches
    .map((m) => m[1])
    .filter((name) =>
      Object.values(DATASOURCE_OWNERS).some((owner) => owner.owner === name)
    )
    .sort();
}

/** The owner names whose Prisma projects must be present in a runtime image. */
function expectedPrismaProjects(runtime: RuntimeId): string[] {
  const allOwners = Object.values(DATASOURCE_OWNERS)
    .filter((owner) => owner.status === 'implemented')
    .map((owner) => owner.owner);

  if (runtime === 'combined') {
    // The combined image hosts the all-owner `db:migrate` orchestration and every
    // datasource is either required or optional-but-instantiated. It must ship
    // every Prisma schema/migration directory so any owner can be migrated inside
    // the container.
    return allOwners.sort();
  }

  // Core/CMS images are single-purpose: they only need the projects of their
  // required datasources. Optional datasources (e.g., observability in core)
  // degrade without migrations, so their schemas are not required in these
  // images.
  return requiredDatasources(runtime)
    .map((datasource) => DATASOURCE_OWNERS[datasource].owner)
    .sort();
}

describe('Docker runtime artifact completeness', () => {
  it('declares images only for implemented runtimes', () => {
    const runtimesWithImages = RUNTIME_IDS.filter(
      (runtime) => RUNTIME_DOCKER_IMAGE[runtime].dockerfile !== null
    );
    expect(runtimesWithImages).toEqual(['core', 'cms', 'combined']);
  });

  for (const runtime of RUNTIME_IDS) {
    const dockerfile = RUNTIME_DOCKER_IMAGE[runtime].dockerfile;
    if (!dockerfile) continue;

    const dockerfilePath = path.join(repoRoot, dockerfile);

    it(`${runtime} Dockerfile exists at the declared path`, () => {
      expect({ runtime, exists: fs.existsSync(dockerfilePath) }).toEqual({
        runtime,
        exists: true,
      });
    });

    it(`${runtime} Dockerfile copies exactly the expected Prisma projects`, () => {
      const copied = copiedPrismaProjects(dockerfilePath);
      const expected = expectedPrismaProjects(runtime);
      expect({ runtime, copied }).toEqual({ runtime, copied: expected });
    });
  }
});
