/**
 * Jest Setup - Load E2E environment variables
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Inside Docker, rootDir is /app/apps/api. Jest config sets rootDir: "."
// So __dirname for this file would be /app/apps/api/test
const candidates = [
  path.join(__dirname, '.env.e2e'),           // /app/apps/api/test/.env.e2e
  path.join(__dirname, '..', '.env.e2e'),     // /app/apps/api/.env.e2e
  '.env.e2e',                                  // ./env.e2e (pwd = /app/apps/api)
];
const found = candidates.find((p) => fs.existsSync(p));
if (found) {
  dotenv.config({ path: found });
  console.log('[Jest Setup] Loaded ' + found);
} else if (process.env.CI === 'true') {
  throw new Error(
    '[Jest Setup] .env.e2e is required in CI but was not found. Checked: ' + candidates.join(', '),
  );
} else {
  console.warn('[Jest Setup] .env.e2e not found in test or parent directory, using default environment');
  console.warn('[Jest Setup] Checked paths:', candidates);
}

// Set test environment
process.env.NODE_ENV = 'test';
