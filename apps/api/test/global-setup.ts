/**
 * Global E2E Setup
 * Runs once before all E2E tests
 */
import { createRequire } from 'node:module';
import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

declare global {
  var __E2E_SETUP_TIME__: number;
}

export default async () => {
  // Load E2E environment variables
  const envPath = path.join(__dirname, '..', '.env.e2e');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log('[E2E] Loaded .env.e2e configuration');
  }

  // GAP-ENV-1: this bootstrap is wired into jest-e2e.json (globalSetup) and is
  // part of the authoritative e2e contract. It provisions the SIX owned databases
  // via the same per-owner migration chain documented for deployments — never the
  // deprecated root project (a bare `prisma migrate deploy` would silently target
  // prisma/schema.prisma + DATABASE_URL).
  console.log('[E2E] Starting global setup...');
  console.log(
    '[E2E] CORE_DATABASE_URL:',
    process.env.CORE_DATABASE_URL?.replace(/password:[^@]+/, 'password:***'),
  );

  // Wait for PostgreSQL to be ready
  await waitForPostgres();

  // Run per-owner Prisma migrations for all six datasources.
  console.log('[E2E] Running Prisma migrations (all owners)...');
  await runCommand('npm', ['run', 'db:migrate'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
  });

  // Seed minimal test data (roles, permissions, bootstrap tenant, super-admin)
  console.log('[E2E] Seeding test data...');
  await runCommand('npm', ['run', 'db:seed'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      // Stage 5.1 seed contract guard: the e2e harness is one of the two
      // sanctioned seeders (with the CI workflow's seed step). The destination
      // host allowlist passes through from the workflow step environment; the
      // database allowlist mirrors the databases this workflow creates above.
      E2E_SEED_OPT_IN: '1',
      E2E_SEED_ALLOWED_DBS:
        'core_db,cms_db,correspondence_db,hr_db,commerce_db,production_db,finance_db,observability_db',
    },
  });

  console.log('[E2E] Global setup complete');

  // Store setup completion time for test timing
  global.__E2E_SETUP_TIME__ = Date.now();
};

function waitForPostgres(): Promise<void> {
  return new Promise((resolve) => {
    const maxAttempts = 30;
    let attempts = 0;

    const checkPostgres = () => {
      attempts++;
      console.log(`[E2E] Checking PostgreSQL (attempt ${attempts}/${maxAttempts})...`);

      const pg = createRequire(__filename)('pg');
      // GAP-ENV-1: probe through the declared host-side contract — the e2e-dbproxy
      // at localhost:5544 (CORE_DATABASE_URL from .env.e2e), not a hard-coded
      // compose port that may be answered by an unrelated postgres on the host.
      const client = new pg.Client(
        process.env.CORE_DATABASE_URL || process.env.DATABASE_URL,
      );

      client
        .connect()
        .then(() => {
          console.log('[E2E] PostgreSQL is ready');
          client.end();
          resolve();
        })
        .catch((error: Error) => {
          console.log(`[E2E] PostgreSQL check failed: ${error.message}`);
          if (attempts < maxAttempts) {
            setTimeout(checkPostgres, 2000);
          } else {
            throw new Error('PostgreSQL failed to start after 60 seconds');
          }
        });
    };

    checkPostgres();
  });
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, ...options });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}
