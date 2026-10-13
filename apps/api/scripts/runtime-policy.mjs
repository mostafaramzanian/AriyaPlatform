#!/usr/bin/env node
/**
 * Phase ARCH-1.3: the ONE way a Dockerfile asks "which Prisma clients does this
 * runtime ship?" — instead of writing the answer down again.
 *
 * It reads `apps/api/runtime-policy.json`, the machine-readable projection of
 * `apps/api/src/runtime-datasources.ts` (regenerate with
 * `npm run arch:policy --workspace=apps/api`). Dockerfiles cannot import
 * TypeScript, so the JSON plus this script is the bridge, and
 * `src/runtime-policy.spec.ts` (a) fails if the JSON drifts from the source, and
 * (b) RUNS these commands and compares their output with the policy.
 *
 * Usage: node apps/api/scripts/runtime-policy.mjs <command> [runtime]
 *
 *   runtimes                  every declared runtime, one per line
 *   prune-clients-for <rt>    generated client dirs this runtime must NOT ship:
 *                             `not-used` datasources plus the disclosed image
 *                             opt-outs (see RUNTIME_DOCKER_IMAGE in the source)
 *   shipped-clients-for <rt>  generated client dirs this runtime MUST ship
 *
 * Output is one value per line so a Dockerfile can iterate it directly:
 *
 *   RUN for client in $(node apps/api/scripts/runtime-policy.mjs prune-clients-for core); do \
 *         rm -rf /app/apps/api/src/generated/$client; done
 *
 * An unknown command or runtime exits 1 with a message naming the remedy rather
 * than silently printing nothing, which in a Dockerfile would mean "prune nothing"
 * — a silent artifact leak.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const projectionPath = join(apiRoot, 'runtime-policy.json');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function loadProjection() {
  let raw;
  try {
    raw = readFileSync(projectionPath, 'utf8');
  } catch {
    fail(
      `runtime policy projection not found: ${projectionPath}\n` +
        'regenerate it with: npm run arch:policy --workspace=apps/api'
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(
      `runtime policy projection is not valid JSON: ${projectionPath}\n` +
        `(${err instanceof Error ? err.message : 'unknown parse error'})\n` +
        'regenerate it with: npm run arch:policy --workspace=apps/api'
    );
  }
}

function runtimeEntry(projection, runtime) {
  const entry = projection.runtimes?.[runtime];
  if (!entry) {
    fail(
      `unknown runtime "${runtime}"\n` +
        `declared runtimes: ${Object.keys(projection.runtimes ?? {}).join(', ')}`
    );
  }
  return entry;
}

/**
 * The clients an image must not carry: the `not-used` datasources' clients (which
 * an image should never have generated at all) plus the disclosed opt-outs of that
 * image (`image.prunedArtifacts`), which are instantiated by the runtime but
 * deliberately absent from the artifact so a service can degrade to a no-op.
 */
function pruneClients(entry) {
  const disclosed = (entry.image.prunedArtifacts ?? []).map((artifact) => artifact.clientDir);
  return [...new Set([...entry.prunedClientDirs, ...disclosed])].sort();
}

function shippedClients(entry) {
  const pruned = new Set(pruneClients(entry));
  return entry.generatedClientDirs.filter((dir) => !pruned.has(dir)).sort();
}

function main() {
  const [command, runtime] = process.argv.slice(2);
  const projection = loadProjection();

  switch (command) {
    case 'runtimes':
      return Object.keys(projection.runtimes ?? {});
    case 'prune-clients-for':
      return pruneClients(runtimeEntry(projection, runtime));
    case 'shipped-clients-for':
      return shippedClients(runtimeEntry(projection, runtime));
    default:
      return fail(
        `unknown command "${command ?? ''}"\n` +
          'usage: runtime-policy.mjs <runtimes|prune-clients-for|shipped-clients-for> [runtime]'
      );
  }
}

const values = main();
if (Array.isArray(values)) {
  process.stdout.write(`${values.join('\n')}\n`);
}
