/**
 * PHASE Q1 — THE SEED REPLAYS THE MIGRATION-DEFINED PROVISIONING.
 *
 * THE DEFECT THIS EXISTS FOR (measured on a real fresh install)
 * ------------------------------------------------------------
 * Every `*_seed_*` migration under `prisma/core/migrations` grants what it grants by
 * ENUMERATING rows it does not own: the 43 role-grant statements read `"Role"` /
 * `"Permission"`, and the 11 membership / feature-entitlement statements read
 * `"Tenant"`. NOTHING else in this repository creates a `"Role"` or a `"Tenant"` row —
 * only `prisma/seed.ts` does — and the durable order is `db:migrate` THEN `db:seed`
 * (`test/global-setup.ts`, `.github/workflows/ci.yml`, and every fresh install in the
 * runbook). On a database that has never been seeded those `CROSS JOIN`s therefore
 * match ZERO rows: the whole family of seed migrations is a NO-OP, their `count <> count`
 * stop-guards compare `0 <> 0` and stay silent (the guards are sound — the ORDER is
 * not), and a "successful" bootstrap leaves a database that cannot authorise anybody:
 *
 *     Permission catalogue ............. 68 rows   (migrations own it: fine)
 *     RolePermission ................... 8 rows    (the seed's own BLOG grants only)
 *     admin@localhost effective grants . 4 of 68   (BLOG only -> every gated route 403)
 *     ModuleRegistrationTenant ......... 0 rows    (every module 403 MODULE_FORBIDDEN)
 *     ModuleFeatureGrant ............... 0 rows    (every gated feature 403 FEATURE_NOT_FOUND)
 *
 * WHAT THIS MODULE DOES ABOUT IT
 * -----------------------------
 * The seed is the only actor that runs AFTER the roles and the tenant exist, so the seed
 * is where the migrations' enumeration can be completed — and it completes it with the
 * MIGRATIONS' OWN SQL, read out of their `migration.sql` files and executed verbatim.
 * There is deliberately no second copy of the grant set to drift: a new permission, a new
 * module membership or a new feature grant is declared in the migration (where the
 * format, the `ON CONFLICT` target and the stop-guard live) and this replay picks it up
 * on the next seed. `REPLAYED_TABLES` is checked against the whole migration inventory,
 * so a migration that starts enumerating `"Tenant"` into some OTHER table fails this
 * module loudly instead of quietly losing rows on a fresh install again.
 *
 * TWO KINDS OF STATEMENT, TWO KINDS OF EXECUTION
 * ----------------------------------------------
 *   1. Statements that do NOT read `"Tenant"` (all 43 role-grant statements) run
 *      verbatim — the seed has just created the roles and the catalogue they read.
 *   2. Statements that DO read `"Tenant"` (membership and feature-entitlement rows) would,
 *      verbatim, enrol EVERY tenant in the database. On a fresh install that is the same
 *      thing (only the bootstrap tenant exists), but a replay must also be safe on a live
 *      database, where the migrations already enumerated the tenant set that existed at
 *      migration time. So those statements run inside a transaction whose `search_path`
 *      puts a TEMPORARY `"Tenant"` table first (`pg_temp, public`): the SQL is still the
 *      migration's own text, but its `CROSS JOIN "Tenant"` now reads exactly ONE row — the
 *      bootstrap tenant — while the INSERT's real target (`"ModuleRegistrationTenant"` /
 *      `"ModuleFeatureGrant"`, with their foreign keys and unique keys) is untouched.
 *      Rows for any OTHER tenant are counted before and after, inside the same
 *      transaction, and a difference ABORTS the transaction.
 *
 * IDEMPOTENT BY CONSTRUCTION: all 54 replayed statements carry `ON CONFLICT ... DO
 * NOTHING` against the unique key the schema declares, so a second run inserts nothing and
 * an operator's hand-provisioned rows are never rewritten (asserted here, not assumed).
 *
 * AND IT CERTIFIES ITSELF: `assertSeedProvisioningComplete` re-reads the declared grant /
 * membership / feature sets by running each migration statement's OWN enumeration against
 * the database (never by re-typing the grant set and never by regex-reading its predicates),
 * and refuses to let the seed finish while any declared row is missing or while any
 * statement's enumeration is empty — a bootstrap that loses a grant fails loudly instead of
 * producing a working-looking database.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '../src/generated/core-client';

/** `apps/api/prisma/core/migrations` — resolved from this file, never from `process.cwd()`. */
const CORE_MIGRATIONS_DIR = path.join(__dirname, 'core', 'migrations');

/**
 * The tables a seed-owned Core migration fills by enumerating `"Role"` / `"Tenant"`.
 * The complement is enforced: any OTHER statement in the inventory that reads `"Tenant"`
 * makes `extractSeedReplayStatements` throw, so this list cannot fall behind the
 * migration set in silence.
 */
export const REPLAYED_TABLES: readonly string[] = [
  'RolePermission',
  'ModuleRegistrationTenant',
  'ModuleFeatureGrant',
];

/** One `INSERT` statement, read out of its migration and kept verbatim. */
export interface SeedReplayStatement {
  /** The migration directory it came from — its ordering key. */
  migration: string;
  /** The table the statement inserts into. */
  table: string;
  /** `true` when the statement reads `"Tenant"` and therefore runs under the tenant shadow. */
  enumeratesTenant: boolean;
  /** The statement itself, exactly as the migration wrote it (comment lines removed). */
  sql: string;
}

/**
 * A whole-line SQL comment (`-- ...`) is dropped; an inline `--` is NOT touched, so a
 * statement that contains `--` inside a string literal cannot be corrupted by this.
 */
const stripLineComments = (sql: string): string => sql.replace(/^[ \t]*--[^\r\n]*/gm, '');

const INSERT_RE = /INSERT\s+INTO\s+"([A-Za-z_]+)"([\s\S]*?);/gi;
// NOTE: no trailing `\b` after the quoted name — `"Tenant"` ends with a non-word character,
// so `"Tenant"\b` can never match and would silently classify every tenant-scoped statement
// as verbatim (i.e. "enumerate EVERY tenant"), which is precisely the wrong direction.
const READS_TENANT = /\b(?:FROM|JOIN)\s+"Tenant"/i;

/**
 * Reads the replay set out of `prisma/core/migrations`, in migration order (the directory
 * name IS the ordering key Prisma applies), and fails closed on every way the set could
 * become wrong rather than merely smaller.
 */
export function extractSeedReplayStatements(
  migrationsDir: string = CORE_MIGRATIONS_DIR,
): SeedReplayStatement[] {
  const replay: SeedReplayStatement[] = [];
  const unhandled: SeedReplayStatement[] = [];

  for (const migration of fs.readdirSync(migrationsDir).sort()) {
    const file = path.join(migrationsDir, migration, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const cleaned = stripLineComments(fs.readFileSync(file, 'utf8'));
    INSERT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INSERT_RE.exec(cleaned)) !== null) {
      const statement: SeedReplayStatement = {
        migration,
        table: match[1],
        enumeratesTenant: READS_TENANT.test(match[0]),
        sql: match[0].trim(),
      };
      if (REPLAYED_TABLES.includes(statement.table)) {
        replay.push(statement);
      } else if (statement.enumeratesTenant) {
        unhandled.push(statement);
      }
    }
  }

  if (unhandled.length > 0) {
    throw new Error(
      'Q1: the migration inventory enumerates "Tenant" into tables this replay does not know, ' +
        'so a fresh install would lose them again:\n  - ' +
        unhandled.map((s) => `${s.table} (${s.migration})`).join('\n  - ') +
        '\nExtend REPLAYED_TABLES (and the invariant check below) before shipping that migration.',
    );
  }
  if (replay.length === 0) {
    throw new Error(
      `Q1: no seed-owned migration statement was found under ${migrationsDir}. A rename that ` +
        'turns this replay into a no-op must fail the seed, not pass it silently.',
    );
  }
  for (const table of REPLAYED_TABLES) {
    if (!replay.some((statement) => statement.table === table)) {
      throw new Error(
        `Q1: no migration statement inserts into "${table}" any more, but the replay (and the ` +
          'seed invariant) still expect it. Either the migration moved, or this table must be ' +
          'dropped from REPLAYED_TABLES deliberately.',
      );
    }
  }
  for (const statement of replay) {
    if (!/ON\s+CONFLICT/i.test(statement.sql)) {
      throw new Error(
        `Q1: the statement into "${statement.table}" in ${statement.migration} has no ` +
          'ON CONFLICT clause, so replaying it could duplicate rows. Refusing to replay it.',
      );
    }
  }
  return replay;
}

/** What one replay did — the seed logs exactly this. */
export interface SeedReplayReport {
  statements: number;
  migrations: string[];
  grants: number;
  memberships: number;
  featureGrants: number;
  bootstrapTenantId: string;
}

/** The one capability the counting needs — satisfied by the client and by a transaction client. */
type RawQueryClient = Pick<PrismaClient, '$queryRawUnsafe'>;

/** Rows that must NOT change: everything the replay is not allowed to touch. */
interface ForeignTenantRows {
  memberships: number;
  featureGrants: number;
}

async function countRowsForOtherTenants(
  client: RawQueryClient,
  bootstrapTenantId: string,
): Promise<ForeignTenantRows> {
  const rows = await client.$queryRawUnsafe<ForeignTenantRows[]>(
    'SELECT ' +
      '(SELECT count(*) FROM "ModuleRegistrationTenant" WHERE "tenantId" <> $1)::int AS "memberships", ' +
      '(SELECT count(*) FROM "ModuleFeatureGrant" WHERE "tenantId" <> $1)::int AS "featureGrants"',
    bootstrapTenantId,
  );
  const counted = rows[0];
  if (!counted) {
    throw new Error('Q1: the cross-tenant row count returned no row; refusing to assume it was zero.');
  }
  return counted;
}

/**
 * Replays the migration-declared provisioning, exactly once, in migration order.
 *
 * Call it AFTER the seed has created the roles, the permission catalogue and the
 * bootstrap tenant: the 43 verbatim statements read `"Role"` / `"Permission"`, and the
 * tenant-scoped ones insert rows whose `"tenantId"` foreign key must resolve.
 */
export async function replaySeedOwnedMigrationProvisioning(
  prisma: PrismaClient,
  bootstrapTenantId: string,
  migrationsDir: string = CORE_MIGRATIONS_DIR,
): Promise<SeedReplayReport> {
  const replay = extractSeedReplayStatements(migrationsDir);
  const verbatim = replay.filter((statement) => !statement.enumeratesTenant);
  const tenantScoped = replay.filter((statement) => statement.enumeratesTenant);

  const report: SeedReplayReport = {
    statements: replay.length,
    migrations: [...new Set(replay.map((statement) => statement.migration))],
    grants: 0,
    memberships: 0,
    featureGrants: 0,
    bootstrapTenantId,
  };
  const record = (table: string, rows: number): void => {
    if (table === 'RolePermission') report.grants += rows;
    else if (table === 'ModuleRegistrationTenant') report.memberships += rows;
    else report.featureGrants += rows;
  };

  for (const statement of verbatim) {
    record(statement.table, await prisma.$executeRawUnsafe(statement.sql));
  }

  if (tenantScoped.length > 0) {
    const before = await countRowsForOtherTenants(prisma, bootstrapTenantId);
    await prisma.$transaction(async (tx) => {
      // `pg_temp` FIRST, so the migration's own `CROSS JOIN "Tenant"` reads the shadow
      // created below while every real target table still resolves inside `public`.
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      await tx.$executeRawUnsafe('CREATE TEMPORARY TABLE "Tenant" ("id" text NOT NULL) ON COMMIT DROP');
      await tx.$executeRawUnsafe('INSERT INTO "Tenant" ("id") VALUES ($1)', bootstrapTenantId);

      const shadow = await tx.$queryRawUnsafe<{ rows: number }[]>(
        'SELECT count(*)::int AS rows FROM "Tenant"',
      );
      if (shadow[0]?.rows !== 1) {
        throw new Error(
          `Q1: the tenant shadow read ${String(shadow[0]?.rows)} rows instead of exactly 1 ` +
            `("${bootstrapTenantId}"). Refusing to enumerate a tenant set the seed did not choose.`,
        );
      }

      for (const statement of tenantScoped) {
        record(statement.table, await tx.$executeRawUnsafe(statement.sql));
      }

      const after = await countRowsForOtherTenants(tx, bootstrapTenantId);
      if (after.memberships !== before.memberships || after.featureGrants !== before.featureGrants) {
        throw new Error(
          'Q1: the replay changed rows belonging to a tenant other than the bootstrap tenant ' +
            `(memberships ${before.memberships} -> ${after.memberships}, feature grants ` +
            `${before.featureGrants} -> ${after.featureGrants}). Rolling back: a seed must never ` +
            're-enumerate a live installation\'s tenant set.',
        );
      }
    });
  }

  return report;
}

/** What the migration SQL DECLARES, with the migration that declares each fact. */
export interface DeclaredProvisioning {
  /** role -> permission name -> the migration that grants it. */
  grants: Map<string, Map<string, string>>;
  /** moduleId -> the migration that enrols the tenant. */
  memberships: Map<string, string>;
  /** `moduleId/featureId` -> the migration that grants the feature. */
  features: Map<string, string>;
}

/** What the database ACTUALLY holds for the bootstrap tenant. */
export interface SeedProvisioningSnapshot {
  catalogue: string[];
  roles: string[];
  grantsByRole: Record<string, string[]>;
  memberships: string[];
  features: string[];
}

/**
 * The expressions that read a statement's DECLARED facts. Each uses the aliases the
 * migrations themselves use in the statement it is applied to, so that statement's own
 * `FROM` / `JOIN` / `WHERE` text runs unchanged: no predicate is parsed, guessed or retyped.
 */
const DECLARED_COLUMNS: Readonly<Record<string, string>> = {
  RolePermission: 'r.name::text AS role, p.name::text AS permission',
  ModuleRegistrationTenant: 'r."moduleId"::text AS module_id, t.id::text AS tenant_id',
  ModuleFeatureGrant:
    "f.\"moduleId\"::text || '/' || f.\"featureId\"::text AS feature, t.id::text AS tenant_id",
};

/**
 * Turns one replayed statement into the SELECT that lists exactly what it declares.
 *
 * WHY THE STATEMENT'S OWN SELECT, AND NOT A PARSER: this inventory scopes its enumerations
 * with `p.name IN (...)`, `p.domain = 'X'` and `f."moduleId" = 'x' AND f."featureId" = 'y'`
 * — three shapes already, and a future migration may use a fourth. Running the statement's
 * own FROM/WHERE against the database makes the declared set EXACT by construction (it is
 * the database's answer, not this module's reading of a regex), and a shape this rewriting
 * cannot handle throws instead of quietly returning nothing.
 */
function declaredEnumerationSql(statement: SeedReplayStatement): string {
  const columns = DECLARED_COLUMNS[statement.table];
  if (!columns) {
    throw new Error(`Q1: no declared-fact projection is defined for "${statement.table}".`);
  }
  const conflictAt = statement.sql.search(/\bON\s+CONFLICT\b/i);
  const sql = (conflictAt === -1 ? statement.sql : statement.sql.slice(0, conflictAt)).trim();
  const head = /^INSERT\s+INTO\s+"[A-Za-z_]+"\s*\([^)]*\)\s*SELECT\s/i.exec(sql);
  if (!head) {
    throw new Error(
      `Q1: the statement into "${statement.table}" in ${statement.migration} is not an ` +
        '`INSERT ... SELECT` and cannot be read as a declaration. Refusing to guess.',
    );
  }
  const rest = sql.slice(head[0].length);
  const fromAt = /\sFROM\s/i.exec(rest);
  if (!fromAt) {
    throw new Error(
      `Q1: the statement into "${statement.table}" in ${statement.migration} has no FROM ` +
        'clause to run as a declaration.',
    );
  }
  return `SELECT ${columns}${rest.slice(fromAt.index)}`;
}

/** The one failure mode this module exists for, reported with the migration that hit it. */
function emptyEnumeration(statement: SeedReplayStatement): Error {
  return new Error(
    `Q1: the statement into "${statement.table}" declared by ${statement.migration} enumerates ` +
      'NO rows, so replaying it could only be a no-op. The seed has not created what that ' +
      'migration reads ("Role" / "Permission" / "ModuleRegistration" / "ModuleFeature" / ' +
      '"Tenant"). Refusing to report a working environment.',
  );
}

/**
 * Reads what the migration set DECLARES, by running each statement's own enumeration
 * against the database (see `declaredEnumerationSql`). Asynchronous on purpose: the answer
 * is the database's, not this module's.
 *
 * NON-VACUITY IS PART OF THE RESULT. A statement whose enumeration is empty cannot be
 * "declared and satisfied" at the same time, so an empty enumeration throws here: that is
 * precisely the Q1 failure (a migration reading `"Role"` / `"Permission"` / `"Tenant"` rows
 * the seed never created), and it must fail the seed rather than pass it quietly.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. Together with the caller's comparison it proves that
 * every fact the migrations enumerate is PRESENT for the bootstrap tenant, and that the
 * enumeration had inputs to read. It does not prove that the permission CATALOGUE is
 * complete: those rows are created by the migrations' own `INSERT INTO "Permission"`
 * statements, which do not enumerate `"Role"` / `"Tenant"` and therefore always applied —
 * their completeness is a property of the migration set, not of this replay.
 */
export async function declaredProvisioning(
  client: RawQueryClient,
  statements: readonly SeedReplayStatement[],
  bootstrapTenantId: string,
): Promise<DeclaredProvisioning> {
  const grants = new Map<string, Map<string, string>>();
  const memberships = new Map<string, string>();
  const features = new Map<string, string>();

  for (const statement of statements) {
    const enumeration = declaredEnumerationSql(statement);
    if (statement.table === 'RolePermission') {
      const rows = await client.$queryRawUnsafe<{ role: string; permission: string }[]>(enumeration);
      if (rows.length === 0) throw emptyEnumeration(statement);
      for (const row of rows) {
        const forRole = grants.get(row.role) ?? new Map<string, string>();
        forRole.set(row.permission, statement.migration);
        grants.set(row.role, forRole);
      }
    } else if (statement.table === 'ModuleRegistrationTenant') {
      const rows = await client.$queryRawUnsafe<{ module_id: string }[]>(
        `SELECT module_id FROM (${enumeration}) AS d WHERE d.tenant_id = $1`,
        bootstrapTenantId,
      );
      if (rows.length === 0) throw emptyEnumeration(statement);
      for (const row of rows) memberships.set(row.module_id, statement.migration);
    } else {
      const rows = await client.$queryRawUnsafe<{ feature: string }[]>(
        `SELECT feature FROM (${enumeration}) AS d WHERE d.tenant_id = $1`,
        bootstrapTenantId,
      );
      if (rows.length === 0) throw emptyEnumeration(statement);
      for (const row of rows) features.set(row.feature, statement.migration);
    }
  }

  return { grants, memberships, features };
}

/** Reads the bootstrap tenant's real provisioning. Read-only; safe to call anywhere. */
export async function measureSeedProvisioning(
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
  bootstrapTenantId: string,
): Promise<SeedProvisioningSnapshot> {
  const catalogue = await prisma.$queryRawUnsafe<{ name: string }[]>(
    'SELECT name::text AS name FROM "Permission" ORDER BY name',
  );
  const roles = await prisma.$queryRawUnsafe<{ name: string }[]>(
    'SELECT name::text AS name FROM "Role" ORDER BY name',
  );
  const grants = await prisma.$queryRawUnsafe<{ role: string; permission: string }[]>(
    'SELECT r.name::text AS role, p.name::text AS permission FROM "RolePermission" rp ' +
      'JOIN "Role" r ON r.id = rp."roleId" ' +
      'JOIN "Permission" p ON p.id = rp."permissionId" ORDER BY 1, 2',
  );
  const memberships = await prisma.$queryRawUnsafe<{ moduleId: string }[]>(
    'SELECT r."moduleId"::text AS "moduleId" FROM "ModuleRegistrationTenant" mt ' +
      'JOIN "ModuleRegistration" r ON r.id = mt."registrationId" WHERE mt."tenantId" = $1 ' +
      'ORDER BY 1',
    bootstrapTenantId,
  );
  const features = await prisma.$queryRawUnsafe<{ moduleId: string; featureId: string }[]>(
    'SELECT f."moduleId"::text AS "moduleId", f."featureId"::text AS "featureId" ' +
      'FROM "ModuleFeatureGrant" g JOIN "ModuleFeature" f ON f.id = g."featureRowId" ' +
      'WHERE g."tenantId" = $1 ORDER BY 1, 2',
    bootstrapTenantId,
  );

  const grantsByRole: Record<string, string[]> = {};
  for (const row of grants) {
    (grantsByRole[row.role] ??= []).push(row.permission);
  }

  return {
    catalogue: catalogue.map((row) => row.name),
    roles: roles.map((row) => row.name),
    grantsByRole,
    memberships: memberships.map((row) => row.moduleId),
    features: features.map((row) => `${row.moduleId}/${row.featureId}`),
  };
}

/**
 * Every declared fact that the database does NOT hold, and — when `allowedExtraGrants` is
 * given — every row the database holds that nothing declares. The two directions are kept
 * apart on purpose: "missing" is the Q1 defect, "unexpected" is an over-grant, and only the
 * suite asks for the second one (a live database may legitimately carry permissions an
 * operator granted by hand, so the SEED must not refuse to run because of them).
 */
export interface SeedProvisioningDifference {
  missing: string[];
  unexpected: string[];
}

function differenceOf(
  declared: DeclaredProvisioning,
  snapshot: SeedProvisioningSnapshot,
  allowedExtraGrants: Readonly<Record<string, readonly string[]>>,
): SeedProvisioningDifference {
  const missing: string[] = [];
  const unexpected: string[] = [];

  const roles = new Set([
    ...declared.grants.keys(),
    ...Object.keys(allowedExtraGrants),
    ...Object.keys(snapshot.grantsByRole),
  ]);
  for (const role of roles) {
    const declaredForRole = declared.grants.get(role);
    const actual = snapshot.grantsByRole[role] ?? [];
    if (declaredForRole && !snapshot.roles.includes(role) && actual.length === 0) {
      missing.push(`role "${role}" does not exist at all (declared by the migration set)`);
      continue;
    }
    const expected = new Set([...(declaredForRole?.keys() ?? []), ...(allowedExtraGrants[role] ?? [])]);
    for (const name of expected) {
      if (!actual.includes(name)) {
        missing.push(`${role} -> ${name} (declared by ${declaredForRole?.get(name) ?? 'the harness'})`);
      }
    }
    for (const name of actual) {
      if (!expected.has(name)) unexpected.push(`${role} -> ${name}`);
    }
  }

  for (const [moduleId, migration] of declared.memberships) {
    if (!snapshot.memberships.includes(moduleId)) {
      missing.push(`bootstrap tenant -> ${moduleId} membership (declared by ${migration})`);
    }
  }
  for (const moduleId of snapshot.memberships) {
    if (!declared.memberships.has(moduleId)) unexpected.push(`tenant -> ${moduleId} membership`);
  }

  for (const [pair, migration] of declared.features) {
    if (!snapshot.features.includes(pair)) {
      missing.push(`bootstrap tenant -> ${pair} feature grant (declared by ${migration})`);
    }
  }
  for (const pair of snapshot.features) {
    if (!declared.features.has(pair)) unexpected.push(`tenant -> ${pair} feature grant`);
  }

  return { missing, unexpected };
}

/**
 * The seed's own completion check: the migration-declared provisioning must be PRESENT
 * before `db:seed` reports success. Deliberately one-directional — an operator's extra
 * hand-granted rows are not this check's business (see `differenceOf`).
 */
export async function assertSeedProvisioningComplete(
  prisma: PrismaClient,
  bootstrapTenantId: string,
  migrationsDir: string = CORE_MIGRATIONS_DIR,
): Promise<SeedProvisioningSnapshot> {
  const replay = extractSeedReplayStatements(migrationsDir);
  const snapshot = await measureSeedProvisioning(prisma, bootstrapTenantId);
  const declared = await declaredProvisioning(prisma, replay, bootstrapTenantId);
  const { missing } = differenceOf(declared, snapshot, {});

  if (missing.length > 0) {
    throw new Error(
      'Q1: this database is INCOMPLETE — the migrations declare provisioning that is not ' +
        `present for tenant "${bootstrapTenantId}":\n  - ` +
        missing.join('\n  - ') +
        '\nRefusing to report a successful bootstrap for a database that cannot authorise its ' +
        'own administrator.',
    );
  }
  return snapshot;
}

/**
 * The SUITE's check (`test/seed-conformance.e2e-spec.ts`): both directions, derived from
 * the same migration SQL — this is where "only the intended permissions, memberships and
 * feature grants exist" is proved. `allowedExtraGrants` carries the one grant set the SEED
 * itself owns outside the migration graph (the BLOG catalogue it creates), so that extra is
 * named rather than excused.
 */
export async function compareSeedProvisioningExactly(
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
  expectation: {
    bootstrapTenantId: string;
    allowedExtraGrants?: Readonly<Record<string, readonly string[]>>;
  },
  migrationsDir: string = CORE_MIGRATIONS_DIR,
): Promise<{ snapshot: SeedProvisioningSnapshot; difference: SeedProvisioningDifference }> {
  const replay = extractSeedReplayStatements(migrationsDir);
  const snapshot = await measureSeedProvisioning(prisma, expectation.bootstrapTenantId);
  const declared = await declaredProvisioning(prisma, replay, expectation.bootstrapTenantId);
  return {
    snapshot,
    difference: differenceOf(declared, snapshot, expectation.allowedExtraGrants ?? {}),
  };
}
