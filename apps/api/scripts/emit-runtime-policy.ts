/**
 * Phase ARCH-1.3: `npm run arch:policy` — regenerate `apps/api/runtime-policy.json`.
 *
 * The JSON is the machine-readable projection of `src/runtime-datasources.ts` for
 * tooling that cannot import TypeScript: `infrastructure/docker/Dockerfile.{core,cms,backend}`
 * consults it (through `scripts/runtime-policy.mjs`) to decide which Prisma clients
 * a runtime image generates and which it prunes.
 *
 * The projection is DERIVED, never hand-edited, and drift is caught by
 * `src/runtime-policy.spec.ts`. Run this after ANY change to
 * `runtime-datasources.ts` and commit the result with it.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { format, resolveConfig } from 'prettier';
import {
  POLICY_PROJECTION_FILE,
  serializeRuntimePolicyProjection,
} from '../src/runtime-policy.projection';

const target = join(__dirname, '..', POLICY_PROJECTION_FILE);

/**
 * The projection is written through the SAME prettier pass the repo's `format` and
 * `format:check` scripts run, and that is deliberate: those scripts cover every JSON
 * file in the repo, so an emitter that wrote its own hand-rolled whitespace would
 * have its output rewritten by `npm run format` and rejected by `npm run format:check`.
 * A generated artifact that `format` keeps rewriting looks hand-maintained, which is
 * exactly the "is this file owned by a script?" ambiguity this phase removes.
 *
 * `resolveConfig` is not optional: `format()` does NOT read `.prettierrc` on its own,
 * and the config must be resolved FROM THE TARGET PATH so that `apps/api/.prettierrc`
 * (printWidth 100, singleQuote, ...) shapes the file rather than prettier's defaults.
 */
async function main(): Promise<void> {
  const config = (await resolveConfig(target)) ?? {};
  const rendered = await format(serializeRuntimePolicyProjection(), {
    ...config,
    filepath: target,
  });
  // `format` is not guaranteed to end the file with a newline; a committed text file
  // should, and a single one — no blank line at EOF.
  writeFileSync(target, rendered.endsWith('\n') ? rendered : `${rendered}\n`, 'utf8');
}

main()
  .then(() => {
    console.log(`runtime policy projection written: ${target}`);
  })
  .catch((error: unknown) => {
    console.error(`runtime policy projection NOT written: ${String(error)}`);
    process.exitCode = 1;
  });
