import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { HR_FEATURE, HR_MODULE_ID } from './hr.constants';

/**
 * Phase 51-HR-1 (§6d): the ARCHITECTURAL regression guard for the HR module.
 *
 * A module boundary is not a folder, and nothing in the compiler enforces one. HR owns a
 * SEPARATE DATABASE, so the couplings this file forbids would not even be type errors in
 * most cases: a `prisma.user.findMany()` typed against Core's client would compile
 * perfectly and then fail — or worse, silently succeed — at runtime. These assertions are
 * the executable form of the phase's §6d/§14/§16/§49 rules, so a later change that quietly
 * re-couples HR to Core fails the unit suite instead of passing review because "the tests
 * are green".
 *
 * WHAT IS GUARDED, AND WHY EACH ONE IS FALSIFIABLE
 * -----------------------------------------------
 *  1. SINGLE IDENTITY SURFACE. Exactly ONE file in the module references the platform
 *     identity port (`USER_DIRECTORY` / `user-directory.contract`): `hr-identity.gateway.ts`.
 *     This is the heart of §6d. The failure mode it prevents is concrete — a second
 *     injection point is how one call site eventually forgets `filterTenantMembers` and
 *     links an employee to ANOTHER TENANT's login, which no constraint in `hr_db` can see
 *     because `Employee.userId` is an opaque string with no foreign key.
 *  2. NO CORE DATABASE HANDLE. No file imports Core's `PrismaService`, Core's
 *     `PrismaModule`, or Core's generated client. HR's only database handle is its own
 *     client, imported from exactly one file.
 *  3. ITS OWN PRISMA PROJECT. Its own datasource env var, its own generated client output,
 *     its own migration history, its own `migration_lock.toml`, and no migration that
 *     references `core_db` or Core's `"User"` table.
 *  4. NO IDENTITY MODEL. `hr_db` has no `User`, no `Tenant`, no `Role`, no `Permission`,
 *     no credential-adjacent column and no audit table, and no `@relation` into any of
 *     them. `Employee.userId` is an optional plain string (§14), indexed but NOT unique —
 *     two personnel records may legitimately reference one login.
 *  5. HISTORY IS NEVER ERASED (§10). No `@Delete` route, no `.delete(`/`.deleteMany(`, no
 *     raw SQL escape hatch, and every Prisma relation is `onDelete: Restrict` — a unit or
 *     position can never be removed out from under an employment interval.
 *  6. THE ACTOR IS ALWAYS SERVER-DERIVED. Every route sits behind `JwtAuthGuard` and is
 *     gated on an `hr.*` permission; every handler passes `resolveHrActor(req)` as the
 *     FIRST argument to the service, and no controller reads `req.user`/`req.body`.
 *  7. TENANCY IS STRUCTURAL, NOT A CONVENTION. No DTO declares `tenantId` (or any
 *     identity/security field), every inline `where: {` fragment is tenant-scoped, every
 *     hoisted `where` carries the tenant, and a write that predicates on an `id` ALONE is
 *     permitted only as a `.update(` whose tenant-scoped read already happened.
 *     `findUnique` — the one Prisma read that cannot carry a tenant predicate — is
 *     forbidden outright.
 *  8. NO ASYNCHRONOUS WORK. 51-HR-1 has no timer, no scheduler, no queue and no upload
 *     middleware. A `setInterval` added "for later" is a module that cannot boot in a
 *     runtime that never enabled it.
 *  9. ONE AUDIT TRAIL (§49). Every mutation goes through the platform audit contract — reached
 *     through exactly ONE HR file, `hr-audit.gateway.ts`, which stamps the tenant and the event
 *     identity from the actor. HR keeps no audit table of its own, because two trails make
 *     "who did what, when" unanswerable (§49), and two ways into the trail make "which tenant
 *     does this row belong to" a per-call-site question.
 * 10. ONE PERSISTENCE FILE PER AGGREGATE (51-HR-ARCH-1). Every Prisma statement is issued
 *     from exactly four `.repository.ts` files — `Employee`, `EmploymentRecord`,
 *     `OrganizationUnit`, `Position` — and from no `.service.ts` at all. A `where` clause is
 *     not a rule, and the two were previously interleaved in the same file, so a change to a
 *     domain rule and a change to a query looked the same in review. A service that reached
 *     for the client again would re-couple the layers where nobody would notice, so the
 *     assertion fails instead of the boundary eroding.
 * 11. ENTITLEMENT IS DECLARED AT THE BOUNDARY AND NEVER KNOWN INSIDE IT (Phase 54-C, §43.6 /
 *     §43.10 gate 3). Every HR controller states the module it needs, and the two leave
 *     controllers additionally state the `leave` feature; the ids come from `hr.constants.ts`
 *     as constants rather than literals, so they cannot drift from the rows the provisioning
 *     migrations insert — a drift that would refuse a working module in production. ENTITLEMENT
 *     MAY APPEAR IN AN HR CONTROLLER AND IN `hr.module.ts`, and nowhere else: no service, no
 *     repository, no gateway, no DTO. A business module that could ask the entitlement question
 *     for itself would eventually let "who is paying" decide a business rule, which is exactly
 *     the coupling §43.6 forbids — and it is a stronger rule than "no Core database handle",
 *     because that one at least fails loudly.
 *
 * Precedent: `src/modules/correspondence/correspondence-isolation.spec.ts` (50-MOD-CORR),
 * which guards the same shape for the first independently-database-bound module.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const SCHEMA_FILE = join(API_DIR, 'prisma', 'hr', 'schema.prisma');
const MIGRATIONS_DIR = join(API_DIR, 'prisma', 'hr', 'migrations');
const MIGRATIONS_LOCK = join(MIGRATIONS_DIR, 'migration_lock.toml');

const GUARD_BASENAME = 'hr-isolation.spec.ts';

/** Every TypeScript file in the module, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const moduleFiles = walk(MODULE_DIR).filter(
  // The guard does NOT scan its own source: this file necessarily contains every string it
  // forbids (as regex literals and as prose), so including it would make each assertion
  // fail on the guard itself. Every OTHER spec in the module IS scanned, deliberately — a
  // spec that imported Core's client would be just as much of a coupling as a service that
  // did.
  (file) => !file.endsWith(GUARD_BASENAME)
);
const readModule = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(API_DIR, file).replace(/\\/g, '/');
const basename = (file: string) => name(file).split('/').pop() as string;

/**
 * A line of DOCUMENTATION, not of code.
 *
 * WHY THIS EXISTS, AND WHY A RAW LINE SCAN IS WRONG HERE. The correspondence guard scans
 * raw lines, which works because that module's comments never spell out the identifiers it
 * forbids. HR's comments deliberately DO — `hr.module.ts` explains in prose that "a
 * `setInterval` … added for later" is refused, and `hr-prisma.service.ts` explains that
 * Core's `PrismaService` is never used. A raw scan would fail on that documentation, and
 * the "fix" would be to delete the reasoning, which is the opposite of the intent. So the
 * forbidden-token scan reads CODE ONLY.
 *
 * The filter is deliberately conservative: it drops a line when its trimmed form STARTS
 * with `//`, `*` or `/*`. Those are the shapes every comment in this module has (JSDoc
 * blocks and full-line `//` notes), and it cannot mistake a trailing comment for code,
 * because a trailing comment never starts a line. A pattern that legitimately appears
 * mid-line — `where: { id }` on a line that also holds `.update(` — is still seen.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** The executable lines of a source file, with their original 1-based line numbers. */
function codeLines(source: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    if (!isCommentLine(text)) out.push({ text, line: index + 1 });
  });
  return out;
}

/**
 * Offenders for one predicate, as `path:line` so a failure says WHERE.
 *
 * The pattern MUST NOT carry the `g` flag: `RegExp.prototype.test` is stateful with
 * `lastIndex`, so a shared `g`-flagged regex would alternate hits and misses between
 * files. Helpers that need every match build their own `g` literal inside the call.
 */
function offenders(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of moduleFiles) {
    for (const { text, line } of codeLines(readModule(file))) {
      if (pattern.test(text)) found.push(`${name(file)}:${line}`);
    }
  }
  return found;
}

/** The same offenders, reduced to the distinct FILE that matched — for "exactly ONE" rules. */
function offenderFiles(pattern: RegExp): string[] {
  return Array.from(
    new Set(offenders(pattern).map((entry) => entry.slice(0, entry.lastIndexOf(':'))))
  );
}

/**
 * Every module specifier the module imports, as written: `'../../platform/...'`.
 *
 * Used for the Core-coupling rules instead of a token scan, because a token scan cannot
 * tell `import { PrismaService } from '../../database/prisma.service'` (a coupling) from
 * `export class HrPrismaService extends PrismaClient` (the module's own handle). The
 * SPECIFIER is the coupling; the file that owns it is what the guard must name.
 */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*|require\()\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

const allSpecifiers = moduleFiles.flatMap((file) => importSpecifiers(readModule(file)));

// ---------------------------------------------------------------------------
// Tenancy helpers (rule 7)
// ---------------------------------------------------------------------------

const serviceFiles = moduleFiles.filter((file) => file.endsWith('.service.ts'));

/**
 * The module's PERSISTENCE boundary (rule 10): one file per aggregate, the only files that
 * issue a Prisma statement.
 *
 * Rules 3 and 4 below scan THIS set rather than `serviceFiles`, because after 51-HR-ARCH-1
 * the `where` clauses live here. That is the point of the split: the tenancy rule is now
 * checked on the layer that actually builds a predicate, instead of on a layer that happened
 * to contain one.
 */
const persistenceFiles = moduleFiles.filter((file) => file.endsWith('.repository.ts'));

/** The aggregates the module persists, each with exactly one file. Order-independent. */
const EXPECTED_REPOSITORIES = [
  'attendance.repository.ts',
  'employees.repository.ts',
  'employment.repository.ts',
  'leave-approval.repository.ts',
  'leave-policy.repository.ts',
  'leave.repository.ts',
  'mission-approval.repository.ts',
  'mission-policy.repository.ts',
  'mission.repository.ts',
  'organization.repository.ts',
  'positions.repository.ts',
];

/**
 * The text of the object literal that OPENS at `braceIndex`, found by brace matching.
 *
 * A fixed-size window would be simpler but WRONG in the direction that matters: it would
 * let a `tenantId` from the NEXT statement satisfy the tenancy rule for the current one.
 * Matching the literal's own braces is what makes rule 7 falsifiable — the tenant predicate
 * must live inside THIS query's `where`, not somewhere after it.
 *
 * String literals and line comments are skipped, so a `}` inside `'hr.employee'` or inside
 * a trailing comment cannot close the literal early. Template literals need no special
 * case: their `${…}` braces balance, so depth still returns to zero at the right place.
 */
function literalText(source: string, braceIndex: number): string {
  let depth = 0;
  for (let i = braceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceIndex, i + 1);
    }
  }
  return source.slice(braceIndex);
}

/** The 1-based line number a character index falls on. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

/** One `where` fragment and the Prisma method it belongs to (when one is in reach). */
interface WhereFragment {
  line: number;
  method: string | null;
  fragment: string;
}

/**
 * Every INLINE `where: { … }` in a source file.
 *
 * Inline is the distinction that matters. `where: { id }` can be judged on its own; a
 * HOISTED `where` (`.findMany({ where, … })` with `const where = { … }` above it) cannot,
 * so it is checked by `hoistedWhereFragments` against the variable's own initialiser. Both
 * forms exist in this module and both are covered — neither is skipped.
 */
function inlineWhereFragments(source: string): WhereFragment[] {
  const lines = source.split(/\r?\n/);
  const out: WhereFragment[] = [];
  const re = /where:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const line = lineOf(source, match.index);
    if (isCommentLine(lines[line - 1])) continue;
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    const calls = Array.from(before.matchAll(/\.(\w+)\s*\(\s*\{/g));
    out.push({
      line,
      method: calls.length > 0 ? calls[calls.length - 1][1] : null,
      fragment: literalText(source, match.index + match[0].length - 1),
    });
  }
  return out;
}

/** Every hoisted `const where = { … }` / `let where = { … }` in a source file. */
function hoistedWhereFragments(source: string): WhereFragment[] {
  const lines = source.split(/\r?\n/);
  const out: WhereFragment[] = [];
  const re = /(?:const|let)\s+where\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const line = lineOf(source, match.index);
    if (isCommentLine(lines[line - 1])) continue;
    out.push({
      line,
      method: null,
      fragment: literalText(source, match.index + match[0].length - 1),
    });
  }
  return out;
}

/** A fragment read as one line, so `^` can anchor to the `where` keyword itself. */
const asOneLine = (fragment: string) => fragment.replace(/\s+/g, ' ');

/**
 * `{ id, … }` / `{ id: x }` / `{ id }` — a predicate on the primary key ALONE, with no
 * tenant in it.
 *
 * Anchored on the LITERAL, not on the `where:` keyword: the fragment this is tested against
 * starts at the opening brace of the object, so a pattern expecting `where:` here would
 * classify every id-only predicate as "untenanted" instead.
 *
 * This shape is not a bug in itself: it is how a `.update(` inside a `$transaction` targets
 * a row the transaction ALREADY read through a tenant-scoped predicate (an employee whose
 * `getOne` succeeded, an interval whose opener verified its employee). What would be a bug
 * is a READ in this shape — and `findUnique`, the same shape with no way to add a tenant, is
 * forbidden outright below.
 */
const ID_ONLY_WHERE = /^\{\s*id\s*[:,}]/;

/**
 * The HR schema's executable lines: models, enums and attributes, without its `//` / `///`
 * commentary.
 *
 * The schema documents the boundary at length — it explains, for instance, that it has no
 * `passwordHash` column and no `User` model — so a raw scan of it would fail on its own
 * reasoning. Stripping comments keeps those explanations while making the absence rules
 * mean something.
 */
const schemaCode = codeLines(readModule(SCHEMA_FILE))
  .map((entry) => entry.text)
  .join('\n');

/**
 * Phase B2.5: the relay is INFRASTRUCTURE, not a business service. It uses
 * `this.prisma.` and imports `AUDIT_PORT` legitimately. Named here so both
 * the prisma-in-services exclusion and the audit-seam exclusion use the
 * same constant.
 */
const HR_RELAY_BASENAME = 'hr-audit-outbox-relay.service.ts';

describe('HR module isolation (§6d)', () => {
  it('actually inspects the module (the guard must not pass on an empty set)', () => {
    // 20+ source files today; a floor rather than an equality so adding files is not a test
    // failure, while an empty/copied-away module IS.
    expect(moduleFiles.length).toBeGreaterThanOrEqual(20);
    expect(allSpecifiers.length).toBeGreaterThan(50);

    // Every file it inspects is this module's, so a mis-resolved `__dirname` cannot make
    // the "exactly ONE file" rules below pass by scanning nothing.
    for (const file of moduleFiles) {
      expect(name(file).startsWith('src/modules/hr/')).toBe(true);
    }

    // The two artifacts every rule below reasons about must be where this guard thinks
    // they are: a schema and a migration history.
    expect(existsSync(SCHEMA_FILE)).toBe(true);
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);

    const names = moduleFiles.map(basename);
    for (const expected of [
      'hr.module.ts',
      'hr-actor.ts',
      'hr-identity.gateway.ts',
      'hr-prisma.service.ts',
      'hr-prisma.module.ts',
      'employees.controller.ts',
      'organization.controller.ts',
      'positions.controller.ts',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('keeps Core identity behind exactly ONE surface: HrIdentityGateway (§6d)', () => {
    // The rule, in its executable form: the platform identity port is referenced by ONE
    // file. A second reference is the defect, whether it is an `@Inject(USER_DIRECTORY)` in
    // a new service or merely an import of the contract for a type.
    expect(offenderFiles(/USER_DIRECTORY|user-directory\.contract/)).toEqual([
      'src/modules/hr/hr-identity.gateway.ts',
    ]);

    // The gateway has to be BOUND for that to mean anything, and binding the port requires
    // importing the platform's module. That import is allowed in exactly one place — the
    // module definition — because registering a module is not using the port.
    expect(offenderFiles(/\bUserDirectoryModule\b/)).toEqual(['src/modules/hr/hr.module.ts']);

    const moduleSource = readModule(join(MODULE_DIR, 'hr.module.ts'));
    // Import, provider, export: the gateway is provided AND exported, so the next HR phase
    // (attendance, leave, reports) can reach identity without a second injection point.
    expect((moduleSource.match(/HrIdentityGateway/g) ?? []).length).toBe(3);
    expect(moduleSource).toMatch(/providers:\s*\[[\s\S]*?HrIdentityGateway,/);
    expect(moduleSource).toMatch(/exports:\s*\[[\s\S]*?HrIdentityGateway,/);

    const gateway = readModule(join(MODULE_DIR, 'hr-identity.gateway.ts'));
    // The port is injected by TOKEN and consumed as the INTERFACE. Core's client, Core's
    // schema and Core's `PrismaService` appear nowhere, which is what lets HR compile
    // without Core's generated types at all.
    expect(gateway).toContain('@Inject(USER_DIRECTORY)');
    expect(gateway).toContain('UserDirectoryContract');
    // The projection type is RE-EXPORTED as a compile-time alias, so a consumer can describe
    // what it renders without importing the contract a second time.
    expect(gateway).toContain('export type { DirectoryUserProfile }');
    expect(gateway).toMatch(/async assertMember\(/);
    expect(gateway).toMatch(/async profilesFor\(/);

    // The one consumer today proves the direction: it depends on the GATEWAY, not the port.
    const employees = readModule(join(MODULE_DIR, 'employees', 'employees.service.ts'));
    expect(employees).toContain("from '../hr-identity.gateway'");
    expect(employees).toContain('HrIdentityGateway');
  });

  it('never obtains a Core database handle', () => {
    // Core's generated client would be a second Prisma project inside one process, typed
    // against a schema this module does not own.
    expect(allSpecifiers.filter((spec) => /generated\/core-client/.test(spec))).toEqual([]);

    // Core's `PrismaService`/`PrismaModule` are the other door into `core_db`. The token scan
    // is word-bounded, so the module's OWN `HrPrismaService` / `HrPrismaModule` do not trip
    // it — while a bare `PrismaService` used as a type or constructor parameter would.
    expect(
      allSpecifiers.filter((spec) => /\/database\/prisma(\.service|\.module)$/.test(spec))
    ).toEqual([]);
    expect(offenders(/(?<!\w)PrismaService\b|(?<!\w)PrismaModule\b/)).toEqual([]);

    // The HR tables are unreachable by name too, not just by import path: no Core model is
    // read or written from this module, because there is no client that could.
    expect(offenders(/core-client/)).toEqual([]);
  });

  it('owns its own client, from its own schema, imported from exactly ONE file', () => {
    // One file imports the generated HR client. Every other file reaches the database
    // through `HrPrismaService` — which keeps the connection lifecycle in one place and
    // makes the datasource probe's activation a single fact.
    expect(offenderFiles(/generated\/hr-client/)).toEqual([
      'src/modules/hr/database/hr-prisma.service.ts',
    ]);

    const service = readModule(join(MODULE_DIR, 'database', 'hr-prisma.service.ts'));
    expect(importSpecifiers(service)).toContain('../../../generated/hr-client');
    expect(service).toContain('extends PrismaClient');
    // Eager connect: HR is a business domain, so an unreachable `hr_db` must fail at BOOT
    // rather than serving a surface where every request fails individually and silently.
    expect(service).toContain('await this.$connect()');
    expect(service).toContain('await this.$disconnect()');

    // The probe token is bound to the module's OWN service via `useExisting`, so binding it
    // cannot introduce a second client.
    const prismaModule = readModule(join(MODULE_DIR, 'database', 'hr-prisma.module.ts'));
    expect(prismaModule).toContain('{ provide: HR_PRISMA_CLIENT, useExisting: HrPrismaService }');
    expect(prismaModule).toContain('exports: [HrPrismaService, HR_PRISMA_CLIENT]');
  });

  it('owns its own Prisma project: own datasource, own migrations, no Core reach-through', () => {
    expect(schemaCode).toContain('env("HR_DATABASE_URL")');
    expect(schemaCode).toContain('output   = "../../src/generated/hr-client"');
    // It must not be able to reach Core's database even by accident.
    expect(schemaCode).not.toContain('CORE_DATABASE_URL');

    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    // ARCH-2 declared HR as a datasource owner with `status: 'target'`; the phase is only
    // complete if real migrations exist behind that declaration, not just a schema.
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    for (const migration of migrations) {
      expect(migration).toMatch(/^\d{14}_[a-z0-9_]+$/);
      expect(existsSync(join(MIGRATIONS_DIR, migration, 'migration.sql'))).toBe(true);
    }

    // Its own lock file: the history is HR's, applied against `hr_db` and never by Core's
    // tooling against Core's.
    expect(readModule(MIGRATIONS_LOCK)).toContain('provider = "postgresql"');

    // No migration may reference the other database, its tables or its env var. A
    // cross-database reference is precisely the coupling that cannot exist, and it is
    // invisible to `tsc` because SQL is not type-checked.
    const sql = migrations
      .map((migration) => readModule(join(MIGRATIONS_DIR, migration, 'migration.sql')))
      .join('\n');
    expect(sql).not.toMatch(/core_db/);
    expect(sql).not.toMatch(/"User"/);
    expect(sql).not.toMatch(/CORE_DATABASE_URL/);
  });

  it('declares NO identity model and NO relation into identity (§14/§16)', () => {
    const models = Array.from(schemaCode.matchAll(/^model (\w+) \{/gm)).map((match) => match[1]);
    // 54-D added the three leave-policy models below plus the synchronization of three columns
    // that the `20260921100000_hr_leave_policy` migration already created — the counts here are
    // asserted EXACTLY so that addition is a deliberate edit to this guard rather than a silent
    // one. None of the three is identity-adjacent: `LeavePolicy` and `LeavePolicyVersion` carry
    // the authored configuration, and `LeaveLimitDefinition` carries one limit row.
    //
    // 54-E added the five approval models, and they are deliberate here for the same reason.
    // `LeaveApprovalDefinition` → `LeaveApprovalStepDefinition` → `LeaveSubstitutionDefinition` are
    // the CONFIGURED flow (who is asked, in what order, and who covers for whom); the
    // `LeaveApprovalInstance` → `LeaveApprovalStepInstance` pair is its RUNTIME (who was actually
    // asked, and what they stated). NONE is identity-adjacent: the two runtime models reach people
    // through `resolvedApproverEmployeeId` / `decidedByEmployeeId`, which are `Employee` composite
    // foreign keys of THIS tenant (§15.3) and never a Core user id — the assertion above that
    // `@relation(...User...)` appears nowhere is what keeps that true.
    // Phase B2.5 added `AuditOutbox` — the HR-local delivery buffer for durable-required
    // audit events. It is NOT a second audit trail and NOT an identity model; it is
    // infrastructure that stages events for relay through `AUDIT_PORT`.
    expect(models.sort()).toEqual([
      'Attendance',
      'AuditOutbox',
      'Employee',
      'EmploymentRecord',
      'LeaveApprovalDefinition',
      'LeaveApprovalInstance',
      'LeaveApprovalStepDefinition',
      'LeaveApprovalStepInstance',
      'LeaveLimitDefinition',
      'LeavePolicy',
      'LeavePolicyVersion',
      'LeaveRequest',
      'LeaveSubstitutionDefinition',
      'LeaveType',
      'MissionApprovalDefinition',
      'MissionApprovalDefinitionStep',
      'MissionApprovalInstance',
      'MissionApprovalStepInstance',
      'MissionOption',
      'MissionOptionGroup',
      'MissionPolicyVersion',
      'MissionReport',
      'MissionRequest',
      'MissionRequestOptionSelection',
      'OrganizationUnit',
      'Position',
    ]);

    // Identity is a plain String reached through the port — never a table of this database,
    // never a cross-database FK, and never a copy of Core's security columns. HR stores NO
    // credential-adjacent field, because a second copy of "is this account disabled" is one
    // that can disagree with Core's.
    expect(schemaCode).not.toMatch(/^model User\b/m);
    expect(schemaCode).not.toMatch(/^model Tenant\b/m);
    expect(schemaCode).not.toMatch(/@relation\([^)]*User[^)]*\)/);
    expect(schemaCode).not.toMatch(/\bpasswordHash\b|\btokenVersion\b/);
    expect(schemaCode).not.toMatch(/^model (Role|Permission|UserRole)\b/m);
    // §49: ONE audit trail, in `core_db`, written through the platform `AuditService`. A
    // second trail here would make "who did what, when" unanswerable.
    expect(schemaCode).not.toMatch(/^model AuditLog\b/m);

    // The identity reference itself: OPTIONAL (a person is employable before they have a
    // login), a plain string, indexed for the "find the record for this identity" read, and
    // deliberately NOT unique — the schema's own note explains why.
    expect(schemaCode).toMatch(/userId\s+String\?\s+@map\("user_id"\)/);
    expect(schemaCode).toContain('@@index([tenantId, userId]');
    expect(schemaCode).not.toContain('@@unique([tenantId, userId]');
  });
  it('gates every route on an hr.* permission, behind JwtAuthGuard, with a server-derived actor', () => {
    const controllers = moduleFiles.filter((file) => file.endsWith('.controller.ts'));
    // EIGHT as of 55: employees, organization, positions, attendance, the leave pair
    // (`leave-requests` and `leave-types`, one namespace each — a controller carries
    // exactly one `@Controller()` route prefix), `leave-policies`, and the Mission controller.
    // The count is asserted EXACTLY, so a ninth controller is a deliberate edit here.
    expect(controllers).toHaveLength(8);

    for (const file of controllers) {
      const source = readModule(file);
      const label = basename(file);

      // One namespace per controller, under `hr/` — so the whole surface is addressable, and
      // gated, as one group.
      expect(source).toMatch(/@Controller\('hr\/[a-z-]+'\)/);
      // Authenticated at the CLASS level: a newly added route cannot be unauthenticated by
      // forgetting a decorator on it.
      expect(source).toContain('@UseGuards(JwtAuthGuard)');

      const lines = codeLines(source);
      const routes = lines
        .map((entry, index) => (/^\s*@(Get|Post|Patch|Put|Delete)\(/.test(entry.text) ? index : -1))
        .filter((index) => index >= 0);
      // HR exposes 35 routes across six controllers today; the floor is FOUR, because that is
      // the smallest honest resource surface this module ever declares — list, get, create and
      // update (`/hr/leave-types` is exactly that). It is a floor rather than an equality so
      // adding a route is not a failure, while DELETING the surface IS.
      expect(routes.length).toBeGreaterThanOrEqual(4);

      const ungated: string[] = [];
      for (const index of routes) {
        // Permission-gated from the RBAC catalogue — never a role-name string, and never a
        // route that is merely "authenticated". The check reads the whole decorator BLOCK
        // rather than only the next line: a route may also carry `@HttpCode`, and a comment
        // may sit between two decorators, so line adjacency is not the contract.
        const decorators: string[] = [];
        for (let cursor = index; cursor < lines.length; cursor += 1) {
          const text = lines[cursor].text.trim();
          if (cursor > index && !text.startsWith('@')) break;
          decorators.push(text);
        }
        const roles = decorators.filter((text) => text.startsWith('@Roles('));
        if (roles.length !== 1 || !/^@Roles\(Permissions\.HR_[A-Z_]+\)$/.test(roles[0] ?? '')) {
          ungated.push(`${label}:${lines[index].line} ${roles.join(' ') || '(NO @Roles)'}`);
        }
      }
      expect(ungated).toEqual([]);

      // The ACTOR is always SERVER-DERIVED: every service call passes `resolveHrActor(req)`
      // as its first argument, which is what makes a client-planted `tenantId`/`userId`
      // unreachable rather than merely rejected. No handler reads a raw request field.
      //
      // `approvals` IS IN THE ALTERNATION because 54-E added a THIRD leave service
      // (`LeaveApprovalService`) alongside `leave` and `leaveTypes`, and the mapping from a
      // controller field to the thing it delegates to is not one-to-one: `this.approvals.approve(...)`
      // is the same kind of call as `this.leave.create(...)` and must satisfy the same first-argument
      // rule. Leaving it out would have made the new routes INVISIBLE to this check rather than
      // failing it — the count assertion below is what caught that.
      // `policiesService` IS IN THE ALTERNATION because 54-F added a FOURTH leave-side service
      // (`LeavePolicyService`) for policy authoring and effective resolution, and it is injected
      // under that exact field name — the alternation matches the FIELD, so `policies` alone would
      // silently match nothing and leave all ten new routes uninspected. The count assertion below
      // is what makes that mandatory rather than optional: it caught precisely this, `calls` having
      // fallen to zero, which is the same failure mode the 54-E note above describes.
      // `simulationService` JOINED IN 54-H FOR THE SAME REASON, and the failure mode it prevents is the
      // one this comment block keeps rediscovering: a route whose service field the alternation does not
      // name is not merely unchecked, it is INVISIBLE — `calls` would still exceed `routes.length` on the
      // strength of the other ten routes, so the new route's actor derivation would go unverified while
      // every assertion passed. Naming the field is what makes §14's route subject to rule 6.
      const calls = lines.filter((entry) =>
        /this\.(employees|employment|organization|positions|attendance|leave|mission|approvals|policy|policiesService|simulationService)\./.test(
          entry.text
        )
      );
      expect(calls.length).toBeGreaterThanOrEqual(routes.length);

      // THE ARGUMENT IS READ ACROSS LINES, NOT WITHIN ONE. A call whose arguments are wrapped —
      // `this.policiesService.archiveVersion(` / `resolveHrActor(req),` / `)` — passes the actor
      // correctly, and a line-local test would report it as MISSING one. That is not a theoretical
      // concern: it is what happened when 54-F's archive route was first written, and a guard whose
      // failure can be silenced only by REFORMATTING a correct call is measuring layout rather than
      // authority. Joining a call's own continuation lines measures the thing the rule is about.
      //
      // The join stops at the first line whose parentheses BALANCE, so two ADJACENT calls cannot
      // bleed into each other and let the second inherit the first's `resolveHrActor(req)` — which
      // would turn a missing actor into a pass, the one outcome worse than a false positive.
      const callText = (start: number): string => {
        let depth = 0;
        let text = '';
        for (let cursor = start; cursor < lines.length; cursor += 1) {
          const piece = lines[cursor].text;
          text += ` ${piece.trim()}`;
          for (const character of piece) {
            if (character === '(') depth += 1;
            if (character === ')') depth -= 1;
          }
          if (depth <= 0) break;
        }
        return text;
      };

      // `lines` carries `{ text, line }` and NOT its own index, and the two are not the same number:
      // `codeLines` DROPS comment lines, so a call's position in this array is not its line number.
      // The join needs the array position, so the filter is over entries and uses its own index.
      const withoutActor = lines
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) =>
          /this\.(employees|employment|organization|positions|attendance|leave|mission|approvals|policy|policiesService|simulationService)\./.test(
            entry.text
          )
        )
        .filter(({ index }) => !/\.\w+\(\s*resolveHrActor\(req\)/.test(callText(index)))
        .map(({ entry }) => `${label}:${entry.line}`);
      expect(withoutActor).toEqual([]);
      expect(offenders(/\breq\.(user|body|query)\./)).toEqual([]);
    }
  });

  it('resolves tenancy from the actor only: no DTO can carry it, and no read fragments on an id alone', () => {
    // 1. NO DTO declares `tenantId` — or any identity/security field. The global
    //    ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so such a field is a 400
    //    rather than a silently ignored value, and the tenant on every write is the ACTOR's.
    const dtoFiles = moduleFiles.filter(
      (file) => name(file).includes('/dto/') && file.endsWith('.dto.ts')
    );
    // ELEVEN since the employee bulk-import work added `employee-import.dto.ts` (the import
    // row shares the optional Core-identity link documented for `employee.dto.ts`), and the
    // count is asserted EXACTLY so that a new DTO is a deliberate edit to this guard.
    expect(dtoFiles).toHaveLength(11);
    const dtoViolations: string[] = [];
    for (const file of dtoFiles) {
      const code = codeLines(readModule(file))
        .map((entry) => entry.text)
        .join('\n');
      const label = basename(file);

      if (/\btenantId\b/.test(code)) dtoViolations.push(`${label} declares tenantId`);
      if (/\bpasswordHash\b|\btokenVersion\b/.test(code)) {
        dtoViolations.push(`${label} declares a credential field`);
      }
      if (/^\s*(readonly\s+)?(roles?|permissions?)\s*[?!]?\s*:/m.test(code)) {
        dtoViolations.push(`${label} declares a role or permission field`);
      }

      if (label === 'employee.dto.ts') {
        // The identity link exists and is OPTIONAL: a person is employable before they are
        // given a login (§16), which is a supported state rather than an error.
        if (!/userId\?:\s*string/.test(code)) {
          dtoViolations.push('employee.dto.ts must carry userId as OPTIONAL');
        }
      } else if (label === 'employee-import.dto.ts') {
        // The bulk-import row mirrors the same OPTIONAL identity link: an imported person
        // may be bound to an existing account, and the membership check lives in the
        // service, never on the wire.
        if (!/userId\?:\s*string/.test(code)) {
          dtoViolations.push('employee-import.dto.ts must carry userId as OPTIONAL');
        }
      } else if (/\buserId\b/.test(code)) {
        dtoViolations.push(`${label} must not carry an identity link`);
      }
    }
    expect(dtoViolations).toEqual([]);

    // 2. The PERSISTENCE layer is the only place a statement is issued, every repository names
    //    the tenant, and `findUnique` — the one Prisma read that cannot carry a tenant
    //    predicate — is never used.
    //
    //    THE DIRECTION OF THIS RULE WAS INVERTED BY 51-HR-ARCH-1. A `.service.ts` used to be
    //    expected to hold Prisma calls, and now holding one is the failure. That is what keeps
    //    the split from decaying: a query added back into a service is how a persistence
    //    boundary is lost, and nothing else in the build would notice — it compiles, and its
    //    unit test would pass.
    // Phase B2.5: the relay is INFRASTRUCTURE, not a business service. It uses
    // `this.prisma.` to read/update/delete its own outbox rows, which is its sole purpose.
    // It is the ONE explicit exception to the "no prisma in services" rule.
    const servicesWithPrisma = serviceFiles
      .filter((file) => basename(file) !== HR_RELAY_BASENAME)
      .filter((file) => /this\.prisma\./.test(readModule(file)))
      .map(basename);
    expect(servicesWithPrisma).toEqual([]);

    // The aggregate list is asserted BY NAME, so a fifth repository (or a renamed one) is a
    // deliberate edit to this guard rather than a silent addition, and so rule 10 cannot pass
    // vacuously on an empty set.
    expect(persistenceFiles.map(basename).sort()).toEqual([...EXPECTED_REPOSITORIES].sort());
    const repositoriesWithoutPrisma = persistenceFiles
      .filter((file) => !/this\.prisma\./.test(readModule(file)))
      .map(basename);
    expect(repositoriesWithoutPrisma).toEqual([]);
    const untenantedRepositories = persistenceFiles
      .filter((file) => !/\btenantId\b/.test(readModule(file)))
      .map(basename);
    expect(untenantedRepositories).toEqual([]);
    expect(offenders(/\.findUnique\(|\.findUniqueOrThrow\(/)).toEqual([]);

    // 3. No inline `where` fragment is unteranted. It is either tenant-scoped, or it is the
    //    id-only predicate of an UPDATE whose tenant-scoped read already happened. The scan
    //    reads the PERSISTENCE layer, where every statement in the module now lives.
    let inlineChecked = 0;
    let idOnlyWrites = 0;
    const untenantedWheres: string[] = [];
    for (const file of persistenceFiles) {
      for (const { line, method, fragment } of inlineWhereFragments(readModule(file))) {
        inlineChecked += 1;
        if (fragment.includes('tenantId')) continue;
        const at = `${basename(file)}:${line}`;
        if (!ID_ONLY_WHERE.test(asOneLine(fragment))) {
          untenantedWheres.push(`${at} has no tenant predicate`);
        } else if (method !== 'update') {
          untenantedWheres.push(`${at} targets an id alone from ${method}(`);
        }
        idOnlyWrites += 1;
      }
    }
    expect(untenantedWheres).toEqual([]);
    // The scan must not be vacuous, and the id-only shape must stay RARE: if it started
    // appearing in most queries, the tenancy rule would be collapsing into "no tenant".
    expect(inlineChecked).toBeGreaterThanOrEqual(30);
    expect(idOnlyWrites).toBeGreaterThan(0);
    expect(idOnlyWrites).toBeLessThan(inlineChecked / 2);

    // 4. A hoisted `where` carries the tenant in its OWN initialiser — the guard cannot see
    //    which call consumes the variable, so the initialiser is where the rule must hold.
    let hoisted = 0;
    const untenantedHoisted: string[] = [];
    for (const file of persistenceFiles) {
      for (const { line, fragment } of hoistedWhereFragments(readModule(file))) {
        hoisted += 1;
        if (!fragment.includes('tenantId')) {
          untenantedHoisted.push(`${basename(file)}:${line}`);
        }
      }
    }
    expect(untenantedHoisted).toEqual([]);
    expect(hoisted).toBeGreaterThanOrEqual(3);
  });

  it('writes every mutation to the ONE platform audit trail (§49)', () => {
    const expectedServices = [
      'attendance.service.ts',
      'employees.service.ts',
      'employment.service.ts',
      'leave.service.ts',
      'leave-approval.service.ts',
      'leave-policy.service.ts',
      'mission.service.ts',
      'mission-approval.service.ts',
      'mission-policy.service.ts',
      'organization.service.ts',
      'positions.service.ts',
    ];
    const sources = new Map(
      serviceFiles.map((file) => [basename(file), readModule(file)] as const)
    );

    const missing = expectedServices.filter((expected) => !sources.has(expected));
    expect(missing).toEqual([]);

    const silent: string[] = [];
    for (const expected of expectedServices) {
      const source = sources.get(expected) as string;

      // The trail lives in `core_db` and is reached through the platform contract — never
      // through a table of HR's own (§49), and never through Core's Prisma client.
      //
      // THE SURFACE CHANGED IN ARCH-3B AND THE RULE DID NOT. What was four injections of
      // `AuditService` — each call site free to remember, or forget, the tenant and the event
      // identity — is now one injection of `HrAuditGateway`, the file that stamps both from
      // `HrActor` so neither is expressible at a call site. The assertion therefore names the
      // gateway and `record(` or `buildOutboxPayload(`, and the assertion below it pins the
      // gateway and relay as the ONLY files that reach the platform audit seam.
      //
      // Phase B2.5: durable-required events now use `this.audit.buildOutboxPayload(` instead
      // of `this.audit.record(`. Both are legitimate audit surfaces from the gateway, and both
      // count towards the "every mutation is audited" rule.
      const wired =
        source.includes("from '../hr-audit.gateway'") &&
        source.includes('private readonly audit: HrAuditGateway');
      const bestEffort = source.match(/this\.audit\.record\(/g) ?? [];
      const durable = source.match(/this\.audit\.buildOutboxPayload\(/g) ?? [];
      const totalAuditCalls = bestEffort.length + durable.length;
      // The floor is 1 rather than 3: some services (leave-approval, mission-approval)
      // handle a single decision path, which produces one or two audit events. The
      // point is that every service has AT LEAST one audit surface, not that each has three.
      if (!wired || totalAuditCalls < 1) {
        silent.push(`${expected} (audit calls: ${totalAuditCalls}, wired: ${wired})`);
      }
    }
    expect(silent).toEqual([]);

    // And no service reaches PAST the gateway: an HR service that imported the platform audit
    // contract directly would reintroduce exactly the second answer to "which tenant, which
    // event identity" this single surface exists to remove.
    //
    // Tested on IMPORT SPECIFIERS rather than raw text, deliberately: the text of a service may
    // legitimately MENTION the seam in a comment, and a guard that failed on prose would be
    // turned off rather than fixed. An import is a dependency; a sentence is not.
    const AUDIT_SEAM = /(?:platform\/audit\/audit\.contract|common\/audit\.service)$/;
    const reachesSeam = (file: string) =>
      importSpecifiers(readModule(file)).some((specifier) => AUDIT_SEAM.test(specifier));
    // Spec files are excluded — they import types for testing but are not production surfaces.
    const seamSurfaces = moduleFiles
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter(reachesSeam);

    // Phase B2.5: the relay is INFRASTRUCTURE and legitimately imports `AUDIT_PORT`. It is
    // excluded from the "no service reaches the seam" rule alongside the prisma exclusion.
    expect(
      seamSurfaces.filter(
        (file) => serviceFiles.includes(file) && basename(file) !== HR_RELAY_BASENAME
      )
    ).toEqual([]);

    // Positively: exactly TWO files in the module reach the platform audit seam: the gateway
    // (which stamps identity and constructs payloads) and the relay (which delivers durable
    // events from the outbox through `AUDIT_PORT`). Phase B2.5 added the relay as a second
    // legitimate surface — it is infrastructure, not a second call path for business services.
    expect(seamSurfaces.map(basename).sort()).toEqual([
      'hr-audit-outbox-relay.service.ts',
      'hr-audit.gateway.ts',
    ]);
  });

  /**
   * Phase 54-C (§43.6 / §43.10 gate 3): ENTITLEMENT IS DECLARED AT THE BOUNDARY, NOT KNOWN
   * INSIDE IT.
   *
   * The two falsifying failures this catches are different in kind and both silent. A new HR
   * controller that ships without the decorator and the guard is a whole resource served to a
   * tenancy that never bought it — nothing about the code looks wrong, and the unit suite would
   * stay green. And an entitlement import in a SERVICE is how a business rule starts to depend on
   * who is paying: it compiles, it reads naturally ("only do this if the tenant is entitled"),
   * and it is exactly the coupling §5's layer separation exists to prevent — which is why the
   * rule is asserted on the application layer, where it is strongest.
   */
  it('declares entitlement at the boundary only: the module on every controller, the feature on the leave and mission surfaces (§43.10 gate 3)', () => {
    const controllers = moduleFiles.filter((file) => file.endsWith('.controller.ts'));
    // Asserted EXACTLY, as rule 6 already does: a ninth controller is a deliberate edit here,
    // because this is the gate that would otherwise let it ship ungated.
    expect(controllers).toHaveLength(8);

    const violations: string[] = [];
    for (const file of controllers) {
      const source = readModule(file);
      const label = basename(file);

      // DECLARED on the class, so a route added to the controller inherits the requirement and
      // cannot be ungated by forgetting a decorator on the new handler.
      if (!source.includes('@RequiresModule(HR_MODULE_ID)')) {
        violations.push(`${label}: no @RequiresModule(HR_MODULE_ID)`);
      }

      // ...and APPLIED. A declaration without a guard is a comment: nothing reads it.
      if (!source.includes('@UseGuards(ModuleEntitlementGuard)')) {
        violations.push(`${label}: no @UseGuards(ModuleEntitlementGuard)`);
      }

      // The leave and mission surfaces carry the feature level too, and the four non-feature
      // controllers must NOT: a feature declaration on the employees surface would let an
      // operator's decision about LEAVE refuse personnel records — a gate that refuses the wrong thing.
      if (label.startsWith('leave-')) {
        if (!source.includes('@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)')) {
          violations.push(`${label}: no @RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)`);
        }
      } else if (label.startsWith('mission')) {
        if (!source.includes('@RequiresFeature(HR_MODULE_ID, HR_FEATURE.MISSION)')) {
          violations.push(`${label}: no @RequiresFeature(HR_MODULE_ID, HR_FEATURE.MISSION)`);
        }
      } else if (/@RequiresFeature\(/.test(source)) {
        violations.push(`${label}: declares a feature this surface does not own`);
      }

      // NEVER A LITERAL. Both ids come from `hr.constants.ts`, because the same two strings are
      // the rows the provisioning migrations insert — the drift gate 4 exists for. A literal here
      // would satisfy every assertion above and still name a module nobody provisioned.
      if (/@Requires(Module|Feature)\('[^']*'/.test(source)) {
        violations.push(`${label}: names an entitlement id as a string literal`);
      }
    }
    expect(violations).toEqual([]);

    // The leave SET is named rather than inferred from a prefix, so a controller renamed to
    // `leave-something` cannot satisfy the feature rule by accident, and a fourth leave surface
    // is a deliberate edit here. `leave-policies` joined in 54-F, and it belongs in this set
    // rather than beside it: a policy governs what the catalogue lists, so a tenant that never
    // had the leave feature cannot have one.
    const leaveControllers = controllers
      .filter((file) => basename(file).startsWith('leave-'))
      .map(basename)
      .sort();
    expect(leaveControllers).toEqual([
      'leave-policies.controller.ts',
      'leave-requests.controller.ts',
      'leave-types.controller.ts',
    ]);

    // The ids the decorators name are the ids the constants export — checked against the SAME
    // file gate 4 compares the migration SQL with, so the three sites cannot be reconciled two
    // against one.
    const constants = readModule(join(MODULE_DIR, 'hr.constants.ts'));
    expect(constants).toContain(`export const HR_MODULE_ID = '${HR_MODULE_ID}';`);
    expect(constants).toMatch(new RegExp(`LEAVE:\\s*'${HR_FEATURE.LEAVE}',`));
    expect(constants).toMatch(new RegExp(`MISSION:\\s*'${HR_FEATURE.MISSION}',`));

    // PROVIDED where Nest instantiates it — a guard applied to a controller but not provided in
    // the declaring module is a boot failure at best — and the port arrives through the ONE
    // import site §43.6 allows.
    const moduleSource = readModule(join(MODULE_DIR, 'hr.module.ts'));
    expect(moduleSource).toMatch(/providers:\s*\[[\s\S]*?ModuleEntitlementGuard,/);
    expect(moduleSource).toMatch(/imports:\s*\[[^\]]*PlatformEntitlementModule\s*,?\s*\]/);

    // THE PROHIBITION, and the reason this test is the one that matters: entitlement may appear
    // in a CONTROLLER or in the module definition, and NOWHERE ELSE. No service, no repository,
    // no gateway, no DTO. The scan is a raw-text one on purpose — an import taken for a TYPE is
    // still a reference, and a service that mentions the port in a comment has already started
    // to think about entitlement.
    const ENTITLEMENT =
      /\b(ENTITLEMENT_PORT|ModuleEntitlementGuard|RequiresModule|RequiresFeature)\b|platform\/entitlement/;
    const surfaces = moduleFiles.filter((file) => ENTITLEMENT.test(readModule(file)));

    expect(
      surfaces.filter((file) => serviceFiles.includes(file) || persistenceFiles.includes(file))
    ).toEqual([]);
    expect(surfaces.map(name).sort()).toEqual(
      [...controllers, join(MODULE_DIR, 'hr.module.ts')].map(name).sort()
    );
  });

  /**
   * Phase 54-C (§43.10 gate 4, §45.8 seed gate): THE CONSTANTS AND THE PROVISIONED ROWS AGREE.
   *
   * The drift this catches is expensive and invisible inside the repository: `hr.constants.ts` and
   * the provisioning migrations cannot import each other — one is HR's source, the other is Core's
   * migration history, and the direction of dependency is what makes the platform Core's rather
   * than HR's — so a rename on either side compiles, passes every other test in the suite, and then
   * refuses a module that is working in production with a `403` naming an id nobody provisioned.
   * The TEXT of the SQL is the only join available, so the two files are compared as strings, and
   * the assertions below are exactly the properties §43.7 and §45.6 promised.
   */
  it('provisions exactly what the constants name: the seed SQL read as text against hr.constants.ts (§43.10 gate 4)', () => {
    // Named by directory, not discovered by a glob: a renamed or reordered migration file is a
    // deliberate edit to this gate rather than a silent re-point of what it reads.
    const coreMigrations = join(API_DIR, 'prisma', 'core', 'migrations');
    const moduleSeed = readModule(
      join(coreMigrations, '20260921120300_seed_hr_module_tenant_membership', 'migration.sql')
    );
    const leaveFeatureSeed = readModule(
      join(coreMigrations, '20260921120400_seed_hr_leave_feature_entitlement', 'migration.sql')
    );
    const missionFeatureSeed = readModule(
      join(coreMigrations, '20260923130000_seed_hr_mission_feature_entitlement', 'migration.sql')
    );

    // The registration and the feature rows name EXACTLY these ids — the same strings the
    // decorators declare, taken from the same constants.
    expect(moduleSeed).toContain(`'${HR_MODULE_ID}'`);
    expect(leaveFeatureSeed).toContain(`'${HR_MODULE_ID}'`);
    expect(leaveFeatureSeed).toContain(`'${HR_FEATURE.LEAVE}'`);
    expect(missionFeatureSeed).toContain(`'${HR_MODULE_ID}'`);
    expect(missionFeatureSeed).toContain(`'${HR_FEATURE.MISSION}'`);

    // ...and the feature hangs off the SAME module id the registration uses, which is what makes
    // `hr` + `leave` / `hr` + `mission` ONE feature each rather than two facts that happen to be seeded together.
    expect(leaveFeatureSeed).toMatch(/INSERT INTO "ModuleFeature"[\s\S]*?'hr',\s*'leave',/);
    expect(missionFeatureSeed).toMatch(/INSERT INTO "ModuleFeature"[\s\S]*?'hr',\s*'mission',/);

    // STATE-PRESERVING: READ, NOT LISTED. The tenant set is SELECTed from `"Tenant"` — a CROSS JOIN
    // for the membership, a join for the grant — so the row count is the tenant table's count and
    // no installation's ids appear in a migration file (§45.6's "what migration 3 must never do").
    expect(moduleSeed).toMatch(/INSERT INTO "ModuleRegistrationTenant"[\s\S]*?CROSS JOIN "Tenant"/);
    expect(leaveFeatureSeed).toMatch(/INSERT INTO "ModuleFeatureGrant"[\s\S]*?FROM "Tenant"/);

    // IDEMPOTENT: every insert is guarded by `ON CONFLICT … DO NOTHING` on the key that makes its
    // row unique, so a second run is indistinguishable from a first and an operator who provisioned
    // by hand first is not overwritten.
    expect(moduleSeed).toContain('ON CONFLICT ("moduleId") DO NOTHING');
    expect(moduleSeed).toContain('ON CONFLICT ("registrationId", "tenantId") DO NOTHING');
    expect(leaveFeatureSeed).toContain('ON CONFLICT ("moduleId", "featureId") DO NOTHING');
    expect(leaveFeatureSeed).toContain('ON CONFLICT ("featureRowId", "tenantId") DO NOTHING');

    // THE STOP-GUARD EXISTS AND RAISES (§43.7's clause, §45.6): each seed compares the rows it
    // produced with the tenant count AT THAT MOMENT and raises rather than warnings — a migration
    // that warns is a migration that finished, and a partial enumeration left behind looks exactly
    // like a complete one.
    for (const sql of [moduleSeed, leaveFeatureSeed]) {
      expect(sql).toMatch(/DO \$\$[\s\S]*?RAISE EXCEPTION[\s\S]*?END \$\$/);
      expect(sql).toMatch(/<> tenant_count THEN/);
    }

    // NOTHING IS NARROWED OR ERASED. The one bound D15's gate caught — the 64-entry legacy array —
    // must not reappear here as a truncation, and a seed is not a place to delete anything.
    for (const sql of [moduleSeed, leaveFeatureSeed]) {
      expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDROP\s+TABLE\b|\bALTER\s+TYPE\b/i);
      expect(sql).not.toMatch(/\bLIMIT\s+64\b/i);
    }
  });
});
