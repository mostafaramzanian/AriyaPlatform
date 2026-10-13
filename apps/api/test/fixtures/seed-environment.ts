import { spawn } from 'child_process';
import * as path from 'path';

/**
 * PHASE GAP-8: THE DOCUMENTED BOOTSTRAP ENVIRONMENT, in one reusable place.
 *
 * These are the identifiers `prisma/seed.ts` establishes as the platform's documented
 * development environment — the tenant, and the administrator that is a MEMBER of it.
 * They are mirrored here (not re-typed at each call site) because BOTH of the GAP-8
 * e2e suites consume them, and `seed-conformance.e2e-spec.ts` asserts the live database
 * against them — so if the seed ever changes these values, that suite FAILS instead of
 * the constant silently drifting away from the seed.
 *
 * The values are deliberately OPAQUE, non-UUID strings: `Tenant.id` and `User.id` are
 * TEXT in Core, UUID v4 is only the mint default, and Commerce consumes both as opaque
 * references (GAP-8, Fork A).
 */
export const SEED_BOOTSTRAP_TENANT_ID = 'tenant-test-1';
export const SEED_ADMIN_USER_ID = 'super-admin-user';

/**
 * The administrator's credentials, resolved the SAME way `prisma/seed.ts` resolves them
 * (its own env overrides, then the documented defaults). Kept here so a spec logs in as
 * "the seeded administrator" without re-typing the pair — the same reason the ids above
 * are shared, and with the same consequence: a seed-side change updates every caller.
 */
export const SEED_ADMIN_EMAIL = process.env.E2E_SUPERADMIN_EMAIL || 'admin@localhost';
export const SEED_ADMIN_PASSWORD = process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!';

/** The API project root (`apps/api`), derived from this fixture's location. */
const API_ROOT = path.join(__dirname, '..', '..');

/**
 * Runs the AUTHORITATIVE seed entrypoint (`npm run db:seed` → `ts-node prisma/seed.ts`,
 * the same command `prisma.seed` in `package.json` names and the E2E global setup runs).
 *
 * It is spawned — not re-implemented — so the suite proves the repository's own bootstrap
 * path, not a test-only copy of it. The child inherits `process.env`, so it targets the
 * same core database this test process is configured against (`CORE_DATABASE_URL` from
 * `.env.e2e`); the Prisma client in the child resolves that URL exactly as the platform
 * client does in-process.
 *
 * Throws with the captured output when the seed exits non-zero: a bootstrap failure must
 * be reported as the seed's own failure, never as a mystery timeout. Resolves with the
 * captured stdout on success so a caller can assert the authoritative script actually
 * reached its own completion marker. ASYNC on purpose: the seeded database is shared
 * with the booted test application, and a blocking spawn would stall that app's event
 * loop (heartbeats, reconnections) for the whole compile-and-seed run.
 */
export function runDbSeed(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm run db:seed', {
      cwd: API_ROOT,
      shell: true,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`db:seed timed out after 180s\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    }, 180_000);

    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`db:seed exited with ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    });
  });
}
