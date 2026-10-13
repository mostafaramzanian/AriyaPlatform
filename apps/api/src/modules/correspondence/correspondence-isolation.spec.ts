import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase 50-MOD-CORR (§25): the ARCHITECTURAL regression guard for the extraction.
 *
 * An extraction is not a folder move, and nothing in a compiler enforces that. These
 * assertions are the executable form of the phase's boundary rules, so a later change
 * that quietly re-couples the module to Core — or re-registers it inside Core — fails
 * the unit suite instead of passing review because "the tests are green".
 *
 * WHAT IS GUARDED
 * ---------------
 *  1. No file under this module imports Core's `PrismaService`, Core's `PrismaModule`
 *     or Core's generated client. The module's ONLY database handle is its own
 *     client reading `CORRESPONDENCE_DATABASE_URL`.
 *  2. The module's identity access goes through the platform port
 *     (`USER_DIRECTORY`) — the sanctioned seam — and not through a client.
 *  3. Core no longer knows the module: `core-app.module.ts` contains no reference to
 *     it, while the composition root (`app.module.ts`) imports it from
 *     `./modules/correspondence/**`.
 *  4. The old in-Core location is GONE, so nothing can import the pre-extraction path.
 *  5. The module's Prisma schema is its own project: its own datasource env var, its
 *     own migration history, no `User` model, and no relation to identity (DC-CORR-01).
 *  6. Scheduling exists ONCE, on the dispatcher pattern: a single `setInterval`, on a
 *     `unref()`ed handle. This is the regression guard for defect D8, which was
 *     literally "a bare setInterval with no unref and no bound".
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const SCHEMA_FILE = join(API_DIR, 'prisma', 'correspondence', 'schema.prisma');
const MIGRATIONS_DIR = join(API_DIR, 'prisma', 'correspondence', 'migrations');

/** Every TypeScript file in the module, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const moduleFiles = walk(MODULE_DIR).filter(
  // The guard does NOT scan its own source: this file necessarily contains the very
  // strings it forbids (as regex literals and as prose), so including it would make
  // every assertion fail on the guard itself. Every OTHER spec in the module is
  // scanned, which is deliberate — a spec that imported Core's client would be just as
  // much of a coupling as a service that did.
  (file) => !file.endsWith('correspondence-isolation.spec.ts'),
);
const readModule = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(API_DIR, file).replace(/\\/g, '/');

/** Offenders for one predicate, as `path:line` so a failure says WHERE. */
function offenders(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of moduleFiles) {
    readModule(file)
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (pattern.test(line)) found.push(`${name(file)}:${index + 1}`);
      });
  }
  return found;
}

describe('Correspondence module isolation (§25)', () => {
  it('actually inspects the module (the guard must not pass on an empty set)', () => {
    // 15+ source files today; a floor rather than an equality so adding files is not
    // a test failure, while an empty/copied-away module IS.
    expect(moduleFiles.length).toBeGreaterThanOrEqual(15);
    expect(moduleFiles.map(name)).toContain(
      'src/modules/correspondence/jobs/scheduled-send.dispatcher.ts',
    );
  });

  it("never imports Core's PrismaService or PrismaModule", () => {
    expect(offenders(/database\/prisma\.(service|module)/)).toEqual([]);
  });

  it("never imports Core's generated client", () => {
    expect(offenders(/generated\/core-client/)).toEqual([]);
  });

  it('reads its OWN generated client instead', () => {
    expect(
      offenders(/generated\/correspondence-client/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('takes identity ONLY through the platform port, never through a client', () => {
    const service = readModule(join(MODULE_DIR, 'correspondence.service.ts'));

    expect(service).toContain("from '../../platform/user-directory/user-directory.contract'");
    expect(service).toContain('USER_DIRECTORY');
    // A raw identity table read would be exactly the coupling this phase removed.
    expect(/prisma\.user\b/.test(service)).toBe(false);
  });

  it('no longer exists at its pre-extraction location', () => {
    expect(readdirSync(SRC_DIR)).not.toContain('correspondence');
  });

  it('is registered in the composition root and NOT registered or imported by Core', () => {
    const coreApp = readFileSync(join(SRC_DIR, 'core-app.module.ts'), 'utf8');
    const compositionRoot = readFileSync(join(SRC_DIR, 'app.module.ts'), 'utf8');

    // Core must not IMPORT the module nor REGISTER it. A comment recording that the
    // module used to live here is allowed — and wanted — but nothing executable may
    // reference it, or Core would again depend on the module it just gave up.
    expect(/from '[^']*correspondence/i.test(coreApp)).toBe(false);
    expect(/CorrespondenceModule/.test(coreApp)).toBe(false);

    expect(compositionRoot).toContain(
      "from './modules/correspondence/correspondence.module'",
    );
    expect(compositionRoot).toContain('CorrespondenceModule,');
  });

  it('owns its own Prisma project: own datasource, own client, own migration history', () => {
    const schema = readFileSync(SCHEMA_FILE, 'utf8');

    expect(schema).toContain('env("CORRESPONDENCE_DATABASE_URL")');
    expect(schema).toContain('output        = "../../src/generated/correspondence-client"');
    // It must not be able to reach Core's database even by accident.
    expect(schema).not.toContain('CORE_DATABASE_URL');
    expect(readdirSync(MIGRATIONS_DIR).length).toBeGreaterThanOrEqual(1);
  });

  it('declares NO identity model and NO relation into identity (DC-CORR-01)', () => {
    const schema = readFileSync(SCHEMA_FILE, 'utf8');

    // Identity is a plain String resolved through the platform port — never a table of
    // this database, and never a cross-database foreign key. These two assertions are
    // what make "a letter outlives its author" true rather than aspirational (D2).
    expect(schema).not.toMatch(/^model User\b/m);
    expect(schema).not.toMatch(/^model Tenant\b/m);
    expect(schema).not.toMatch(/@relation\([^)]*User[^)]*\)/);
  });

  it('schedules on the dispatcher pattern: ONE interval, unref-ed and bounded (D8/D9)', () => {
    // Defect D8 was literally "a second, bare setInterval with no unref and no bound",
    // so a single host for the timer is the rule, not a preference.
    const hostFiles = Array.from(
      new Set(offenders(/setInterval\(/).map((entry) => entry.split(':')[0])),
    );
    expect(hostFiles).toEqual([
      'src/modules/correspondence/jobs/scheduled-send.dispatcher.ts',
    ]);

    const dispatcher = readModule(join(MODULE_DIR, 'jobs', 'scheduled-send.dispatcher.ts'));
    expect(dispatcher).toContain('.unref?.()');
    expect(dispatcher).toContain('take: SCHEDULED_SEND_BATCH_SIZE');
    expect(dispatcher).toContain('sendAttempts: { lt: MAX_SEND_ATTEMPTS }');
    expect(dispatcher).toContain('private ticking = false');

    // The domain service must no longer own a timer of its own.
    const service = readModule(join(MODULE_DIR, 'correspondence.service.ts'));
    expect(/setInterval\(/.test(service)).toBe(false);
  });

  it('keeps the due scan on the PARTIAL index the baseline migration declares', () => {
    const baseline = readdirSync(MIGRATIONS_DIR)
      .filter((entry) => entry.includes('baseline'))
      .map((entry) =>
        readFileSync(join(MIGRATIONS_DIR, entry, 'migration.sql'), 'utf8'),
      )
      .join('\n');

    expect(baseline).toContain('Letter_scheduled_due_idx');
    expect(baseline).toContain(`WHERE "status" = 'SCHEDULED'`);
    // The D1 correction: SCHEDULED is admitted by the status/timestamp CHECK, and it is
    // admitted WITH its clock — the state without a clock stays impossible.
    expect(baseline).toContain(`"status" = 'SCHEDULED' AND "readyAt" IS NOT NULL`);
    expect(baseline).toContain(`"scheduledAt" IS NOT NULL`);
  });
});