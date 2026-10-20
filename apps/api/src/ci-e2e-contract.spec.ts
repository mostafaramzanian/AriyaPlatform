import * as fs from 'fs';
import * as path from 'path';
import { DATASOURCES, DATASOURCE_OWNERS, Datasource } from './runtime-datasources';

/**
 * Phase P1 — the CI E2E gate's own contract.
 *
 * WHY THIS SPEC EXISTS (two defects of one class: the workflow and the code
 * disagreed, and no guard read the workflow)
 * -------------------------------------------------------------------------
 *  1. `npm run db:migrate` is an ALL-OWNER orchestration — it ends with
 *     `prisma:migrate:inventory`, and every owner's schema resolves its
 *     connection string with `env("..._DATABASE_URL")`. The `e2e-checks` job
 *     provisioned only the eight databases that existed before the Inventory
 *     owner landed and defined no `INVENTORY_DATABASE_URL` in any of its three
 *     write-producing steps — so the gate could not run the orchestration it
 *     invokes (`Environment variable not found: INVENTORY_DATABASE_URL`; the
 *     tracked `apps/api/.env` is git-ignored, so a CI runner has no fallback).
 *  2. The harness's isolation guard
 *     (`test/global-setup.ts::assertE2ePostgresTargetIsSafe`) REFUSES to
 *     migrate or seed unless the resolved cluster is attested, and the job
 *     attested nothing — so global setup threw before the first statement.
 *
 * Both are invisible to every existing guard: the runtime-policy specs read
 * `runtime-datasources.ts`, the Docker guard reads Dockerfiles, and nothing
 * read `.github/workflows/ci.yml`. The assertions below compare the workflow
 * against the SAME runtime policy the orchestration is derived from, so an
 * owner cannot be added to the code and forgotten in CI again.
 *
 * The gate's spec list has ONE source of truth: the wired `test:e2e:ci` script.
 * This spec asserts that the workflow calls that script, that the script runs in
 * band (both gated suites mutate cluster-wide role-grant rows), and that every
 * spec it enumerates exists — so a renamed or deleted suite fails the gate
 * instead of silently reducing coverage.
 */

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

const workflow = read(path.join(repoRoot, '.github', 'workflows', 'ci.yml'));
const manifest = JSON.parse(read(path.join(apiRoot, 'package.json'))) as {
  scripts: Record<string, string>;
};

/** The `e2e-checks` job's text: from its key to the end of the file. */
function e2eJob(): string {
  const start = workflow.indexOf('\n  e2e-checks:');
  if (start === -1) throw new Error('ci.yml has no e2e-checks job');
  return workflow.slice(start);
}

/** One step's text: from its `- name:` line to the next step's. */
function step(name: string): string {
  const job = e2eJob();
  const marker = `- name: ${name}`;
  const start = job.indexOf(marker);
  if (start === -1) throw new Error(`ci.yml's e2e-checks job has no step "${name}"`);
  const rest = job.slice(start + marker.length);
  const next = rest.indexOf('- name:');
  return next === -1 ? rest : rest.slice(0, next);
}

/** `core` owns `core_db`; Financial is the one owner whose database is renamed. */
function databaseOf(datasource: Datasource): string {
  const owner = DATASOURCE_OWNERS[datasource].owner;
  return owner === 'financial' ? 'finance_db' : `${owner}_db`;
}

describe('CI e2e gate contract', () => {
  it('provisions every database the all-owner migration orchestration migrates', () => {
    const orchestration = manifest.scripts['db:migrate'] ?? '';
    for (const datasource of DATASOURCES) {
      expect(orchestration).toContain(
        `npm run prisma:migrate:${DATASOURCE_OWNERS[datasource].prismaProject}`
      );
    }

    // The provisioned set is read from the workflow's own creation loop.
    const loop = /for db in ([^;]+); do/.exec(e2eJob());
    const provisioned = (loop ? loop[1] : '').trim().split(/\s+/).sort();
    expect(provisioned).toEqual(DATASOURCES.map(databaseOf).sort());
  });

  it('gives every write-producing step every owner connection string', () => {
    // Migrations, seed and the jest run each resolve the owner URLs themselves:
    // a missing one is not a warning, it is an un-bootable step.
    for (const name of ['Run migrations (all owners)', 'Seed test data', 'Run E2E suite']) {
      const body = step(name);
      for (const datasource of DATASOURCES) {
        expect({ step: name, datasource, present: body.includes(`${datasource}: postgresql://`) })
          .toMatchObject({ step: name, datasource, present: true });
      }
    }
  });

  it('generates the harness .env.e2e with every owner datasource', () => {
    // `test/jest-setup.ts` / `global-setup.ts` load this generated file, and the
    // app under test boots from the same process environment.
    const suite = step('Run E2E suite');
    for (const datasource of DATASOURCES) {
      expect({ datasource, keyed: suite.includes(`'${datasource}'`) }).toMatchObject({
        datasource,
        keyed: true,
      });
    }
  });

  it('attests the cluster it is about to migrate and seed', () => {
    const job = e2eJob();
    // Either the strong form (a pinned system_identifier, literal or exported to
    // the later steps), or the documented shared-target opt-in. Nothing else
    // gets past `assertE2ePostgresTargetIsSafe`.
    const pinned =
      /E2E_PG_EXPECTED_SYSTEM_ID:\s*['"]?\d+/.test(job) ||
      /E2E_PG_EXPECTED_SYSTEM_ID=.*>>\s*"?\$GITHUB_ENV/.test(job);
    const optIn = /E2E_ALLOW_SHARED_PG:\s*['"]?1['"]?/.test(job);
    expect({ pinned, optIn, attested: pinned || optIn }).toMatchObject({ attested: true });
  });

  it('runs the wired script in band, and every spec it names exists', () => {
    const suite = step('Run E2E suite');
    expect(suite).toContain('npm run test:e2e:ci');
    // The spec list must not be repeated in the workflow: that is how the two
    // copies drift apart.
    expect(/jest[^\n]*\.e2e-spec\.ts/.test(suite)).toBe(false);

    const script = manifest.scripts['test:e2e:ci'] ?? '';
    expect(script).toContain('--runInBand');
    const specs = [...script.matchAll(/test\/[\w.-]+\.e2e-spec\.ts/g)].map((m) => m[0]);
    expect(specs).toContain('test/inventory-entitlement.e2e-spec.ts');
    for (const spec of specs) {
      expect({ spec, exists: fs.existsSync(path.join(apiRoot, spec)) }).toMatchObject({
        spec,
        exists: true,
      });
    }
  });
});