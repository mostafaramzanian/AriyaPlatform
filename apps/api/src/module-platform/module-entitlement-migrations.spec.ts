import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateModuleRegistrationDto, UpdateModuleRegistrationDto } from './dto/module.dto';

/**
 * Phase 54-C (§43.10 gate 5, §45.8): THE CORE-SIDE MIGRATION GATES.
 *
 * WHAT THESE ASSERT, AND WHY THEY READ FILES AS TEXT. Every claim Amendment 1 and Amendment 3
 * make about storage is a claim about SQL that Prisma generates nothing of: a replaced `CHECK`, a
 * new enum member added in its own transaction, an enumerated row per tenant, a fail-closed
 * absence. None of that is visible to a TypeScript test through a client — the client can only be
 * asked what it was generated from — so the migration files are read as TEXT, exactly the technique
 * `hr-isolation.spec.ts` and `correspondence-isolation.spec.ts` already use for the SQL a boundary
 * must not import.
 *
 * The failures these gates exist to catch are the ones that survive review:
 *
 *  * a "cleanup" edit that raises the legacy 64-entry bound or drops the frozen `RESTRICTED` branch
 *    while adding the new one — which would silently widen every existing restricted module;
 *  * the new enum value being USED in the transaction that adds it (PostgreSQL `55P04`), which
 *    fails only on a fresh database and therefore never in the environment where it was written;
 *  * a seed that lists tenant ids instead of reading them, which truncates on a bigger
 *    installation and looks complete on a smaller one;
 *  * a column that carries a `@db.` native type on one side of a foreign key and not on the other,
 *    which `prisma migrate` compiles happily and PostgreSQL then refuses.
 */

const API_DIR = join(__dirname, '..', '..');
const CORE_MIGRATIONS = join(API_DIR, 'prisma', 'core', 'migrations');
const CORE_SCHEMA = join(API_DIR, 'prisma', 'core', 'schema.prisma');
const DTO_FILE = join(API_DIR, 'src', 'module-platform', 'dto', 'module.dto.ts');

/** Named by directory, so a renamed or reordered migration is a failure rather than a skip. */
const ENUM_MIGRATION = '20260921120100_add_module_tenant_scope_explicit';
const MEMBERSHIP_MIGRATION = '20260921120200_add_module_registration_tenant_membership';
const MEMBERSHIP_SEED = '20260921120300_seed_hr_module_tenant_membership';
const FEATURE_MIGRATION = '20260921120000_add_module_feature_entitlement';
const FEATURE_SEED = '20260921120400_seed_hr_leave_feature_entitlement';
/**
 * Phase 55's counterpart to `FEATURE_SEED`: the same provisioning act for the Mission feature.
 *
 * NAMED SEPARATELY rather than folded into `FEATURE_SEED`, because the two are different features
 * with different grant rows — the leave seed must keep asserting exactly what it always asserted,
 * and a renamed or reordered Mission seed has to fail here rather than be silently skipped. The
 * later `SEEDS` list is what subjects both to the same four gates (read-not-listed, idempotent,
 * stop-guard, additive).
 */
const MISSION_FEATURE_SEED = '20260923130000_seed_hr_mission_feature_entitlement';

const read = (file: string) => readFileSync(file, 'utf8');
const sqlOf = (name: string) => read(join(CORE_MIGRATIONS, name, 'migration.sql'));

/**
 * The EXECUTABLE lines of a SQL file: full-line `--` comments removed, blank lines kept as-is.
 *
 * The distinction matters for two of the gates below and is the reason they cannot be written as
 * `toContain` on the raw text. The enum file legitimately DISCUSSES `'RESTRICTED_MEMBERS'` in its
 * commentary — it exists to explain why the value is added in its own transaction — while being
 * forbidden from USING it, so a raw scan would fail on the file's own reasoning and the "fix"
 * would be to delete the explanation. Reading code lines makes the rule mean what it says.
 */
const sqlCode = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

/** One `model X { … }` block of `prisma/core/schema.prisma`. */
function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

/** The declared scalar type of `model.field` — `String`, `DateTime`, … — never the attributes. */
function scalarType(schema: string, model: string, field: string): string {
  const line = modelBlock(schema, model)
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s+${field}\\s+\\S`).test(candidate));
  expect(line).toBeDefined();
  return (line as string).trim().split(/\s+/)[1];
}

describe('Phase 54-C migration gates (§43.10 gate 5, §45.6, §45.8)', () => {
  it('reads the files it claims to read — a renamed migration must fail, not pass vacuously', () => {
    for (const migration of [
      ENUM_MIGRATION,
      MEMBERSHIP_MIGRATION,
      MEMBERSHIP_SEED,
      FEATURE_MIGRATION,
      FEATURE_SEED,
      MISSION_FEATURE_SEED,
    ]) {
      expect(existsSync(join(CORE_MIGRATIONS, migration, 'migration.sql'))).toBe(true);
    }
    expect(existsSync(CORE_SCHEMA)).toBe(true);
    expect(existsSync(DTO_FILE)).toBe(true);
  });

  it('enum separation: the value is ADDED in one file and USED in another — never in the same transaction (55P04)', () => {
    const enumSql = sqlOf(ENUM_MIGRATION);
    const enumCode = sqlCode(enumSql);

    // Added once, with `IF NOT EXISTS`, which is also what makes the file idempotent.
    expect(enumCode).toContain(
      `ALTER TYPE "ModuleTenantScope" ADD VALUE IF NOT EXISTS 'RESTRICTED_MEMBERS';`
    );
    expect((enumCode.match(/ALTER TYPE "ModuleTenantScope" ADD VALUE/g) ?? []).length).toBe(1);

    // USED NOWHERE in this file. Asserted as the exact set of code lines that mention the value,
    // so a `CHECK`, an `INSERT` or a `DEFAULT` added later fails here instead of at deploy time on
    // a database nobody has migrated yet.
    const mentions = enumCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("'RESTRICTED_MEMBERS'"));
    expect(mentions).toEqual([
      `ALTER TYPE "ModuleTenantScope" ADD VALUE IF NOT EXISTS 'RESTRICTED_MEMBERS';`,
    ]);

    // ...and the value IS used by the later files, so the rule above is not satisfied by a value
    // that nothing ever reads.
    for (const later of [MEMBERSHIP_MIGRATION, MEMBERSHIP_SEED]) {
      expect(sqlCode(sqlOf(later))).toContain("'RESTRICTED_MEMBERS'");
    }
  });

  it('the constraint is REPLACED, and the replacement does not narrow the frozen branch it inherits', () => {
    const code = sqlCode(sqlOf(MEMBERSHIP_MIGRATION));

    // One constraint dropped, under the name a reader greps for, and re-added under the SAME name —
    // so "which constraint exists" has one answer before and after.
    const drops = code.split(/\r?\n/).filter((line) => line.includes('DROP CONSTRAINT'));
    expect(drops.map((line) => line.trim())).toEqual([
      'ALTER TABLE "ModuleRegistration" DROP CONSTRAINT "ModuleRegistration_tenantScope_consistent";',
    ]);
    expect(code).toContain(
      'ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_tenantScope_consistent"'
    );

    // THE FROZEN BRANCH, VERBATIM. `RESTRICTED` keeps its 1-64 bound and its meaning for every
    // module that is not `RESTRICTED_MEMBERS`: not raised, not removed, not re-scoped. This is the
    // assertion that catches the tempting "while I am here, 64 is small" edit — which would widen
    // every existing restricted registration without touching a single row.
    expect(code).toContain(
      `OR ("tenantScope" = 'RESTRICTED' AND coalesce(array_length("tenantIds", 1), 0) BETWEEN 1 AND 64)`
    );
    // The `ALL` branch is unchanged too, including the rule that `ALL` with a populated array stays
    // unrepresentable (the empty array is what `ALL` MEANS, and a botched write must not be able to
    // turn "everyone" into "restricted" or the reverse).
    expect(code).toContain(
      `("tenantScope" = 'ALL' AND coalesce(array_length("tenantIds", 1), 0) = 0)`
    );

    // THE REPRESENTATION RULE (§45.8 representation gate): the new branch requires an EMPTY array,
    // so one row can never carry two competing membership sources — the array for `RESTRICTED` and
    // the child table for `RESTRICTED_MEMBERS`.
    expect(code).toContain(
      `OR ("tenantScope" = 'RESTRICTED_MEMBERS' AND coalesce(array_length("tenantIds", 1), 0) = 0)`
    );

    // ADDITIVE ONLY. Nothing is dropped, truncated, deleted or altered in type — and no column is
    // narrowed — anywhere in the file.
    expect(code).not.toMatch(/\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bALTER\s+TYPE\b|\bALTER\s+COLUMN\b/i);
    // The one bound in the file's own DDL is the tenant-id column's, and it is a `CREATE TABLE` of
    // new rows, never a rewrite of existing ones.
    expect(code).toContain('CREATE TABLE "ModuleRegistrationTenant"');
    expect(code).toContain(
      'CREATE UNIQUE INDEX "ModuleRegistrationTenant_registrationId_tenantId_key"'
    );
    // Both foreign keys CASCADE, which is the repository-consistent deletion semantics §45.5
    // inspected rather than invented: a membership is a fact ABOUT a tenant and a registration.
    expect(code).toContain(
      'FOREIGN KEY ("registrationId") REFERENCES "ModuleRegistration"("id") ON DELETE CASCADE'
    );
    expect(code).toContain('FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE');
  });

  it('the seeds READ the tenant set, are idempotent, and stop rather than leave a partial enumeration (§45.8 seed gate)', () => {
    const membershipSeed = sqlCode(sqlOf(MEMBERSHIP_SEED));
    const featureSeed = sqlCode(sqlOf(FEATURE_SEED));
    // Phase 55's Mission seed is gated exactly as the leave one is: the four properties below are
    // about PROVISIONING, so a second feature seed cannot buy a lighter rule by being newer.
    const missionSeed = sqlCode(sqlOf(MISSION_FEATURE_SEED));
    const seeds = [membershipSeed, featureSeed, missionSeed];

    // READ, NOT LISTED. The tenant set is SELECTed from `"Tenant"`, so the row count is the tenant
    // table's count and no installation's ids appear in a migration file — which is also why these
    // files are correct on a deployment with a different tenant set, and why "162 tenants" appears
    // in the reasoning but never in the SQL.
    expect(membershipSeed).toContain('CROSS JOIN "Tenant"');
    expect(featureSeed).toContain('FROM "Tenant"');
    expect(missionSeed).toContain('CROSS JOIN "Tenant"');
    for (const seed of seeds) {
      expect(seed).not.toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }

    // IDEMPOTENT: every insert targets the unique key that makes its row a database fact, so a
    // second run is indistinguishable from a first — and an operator who provisioned by hand first
    // is not overwritten (`DO NOTHING` cannot rewrite a live registration's scope or `enabled`).
    //
    // The two files are REPORTED rather than counted, so the assertion names which file lost a
    // guard, and the counts are exact: a third insert added without an `ON CONFLICT` is a
    // deliberate edit to this gate, not a silent hole.
    const guardedInserts = (
      [
        ['membership', membershipSeed],
        ['feature grant', featureSeed],
        ['mission feature grant', missionSeed],
      ] as const
    ).map(([label, seed]) => {
      const lines = seed.split(/\r?\n/);
      return {
        label,
        inserts: lines.filter((line) => /^\s*INSERT INTO/i.test(line)).length,
        conflicts: lines.filter((line) => /ON CONFLICT\s*\(/i.test(line)).length,
      };
    });

    expect(guardedInserts).toEqual([
      { label: 'membership', inserts: 2, conflicts: 2 },
      { label: 'feature grant', inserts: 2, conflicts: 2 },
      { label: 'mission feature grant', inserts: 2, conflicts: 2 },
    ]);

    for (const seed of seeds) {
      expect(seed).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }

    // THE STOP-GUARD EXISTS AND RAISES (§43.7's clause, kept as written): each file compares the
    // rows it produced with the tenant count AT THAT MOMENT. A migration that warns is a migration
    // that finished, and a partial enumeration left behind looks exactly like a complete one — so
    // the failure direction is chosen to be visible and recoverable.
    for (const seed of seeds) {
      expect(seed).toMatch(/DO \$\$[\s\S]*?RAISE EXCEPTION[\s\S]*?END \$\$/);
      expect(seed).toMatch(/<> tenant_count THEN/);
    }
  });

  it('every file in the amendment is ADDITIVE: nothing is dropped, truncated or deleted', () => {
    const files = [
      FEATURE_MIGRATION,
      ENUM_MIGRATION,
      MEMBERSHIP_MIGRATION,
      MEMBERSHIP_SEED,
      FEATURE_SEED,
      MISSION_FEATURE_SEED,
    ];

    for (const file of files) {
      const code = sqlCode(sqlOf(file));

      // `DROP CONSTRAINT` is permitted ONCE, in the membership file, because a `CHECK` cannot be
      // replaced in place — and it is re-added under the same name in the same file (asserted
      // above). Anywhere else, a drop is a deletion wearing DDL.
      if (file !== MEMBERSHIP_MIGRATION) {
        expect(code.split(/\r?\n/).filter((line) => /DROP\s+CONSTRAINT/i.test(line))).toEqual([]);
      }

      expect(code).not.toMatch(
        /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i
      );
    }

    // The D14 DDL file: two tables, their keys, their format `CHECK`s and their FKs — and NO data
    // statement at all, because provisioning is a separate migration with its own purpose (§43.7).
    const featureDdl = sqlCode(sqlOf(FEATURE_MIGRATION));
    expect(featureDdl).toContain('CREATE TABLE "ModuleFeature"');
    expect(featureDdl).toContain('CREATE TABLE "ModuleFeatureGrant"');
    expect(featureDdl).toContain('CREATE UNIQUE INDEX "ModuleFeature_moduleId_featureId_key"');
    expect(featureDdl).toContain(
      'CREATE UNIQUE INDEX "ModuleFeatureGrant_featureRowId_tenantId_key"'
    );
    expect(featureDdl).toContain(
      'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE'
    );
    expect(featureDdl).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('no native `@db.` type and no foreign-key type mismatch (column-type gate, §45.8)', () => {
    const schema = read(CORE_SCHEMA);

    // The tables and columns D14/D16 introduce carry NO `@db.` native type: their types are
    // Prisma-level, which is what keeps the two sides of a foreign key identical by construction.
    // The slip this catches is a native type on one side and not the other — the shape that
    // compiles in `prisma migrate` and is then refused by PostgreSQL.
    for (const model of ['ModuleRegistrationTenant', 'ModuleFeature', 'ModuleFeatureGrant']) {
      expect(modelBlock(schema, model)).not.toContain('@db.');
    }

    // Every foreign-key column's type IS the referenced column's type, asserted as a COMPARISON
    // rather than as five hard-coded `String`s, so a change on either side fails here.
    const foreignKeys: [string, string, string, string][] = [
      ['ModuleRegistrationTenant', 'registrationId', 'ModuleRegistration', 'id'],
      ['ModuleRegistrationTenant', 'tenantId', 'Tenant', 'id'],
      ['ModuleFeature', 'moduleId', 'ModuleRegistration', 'moduleId'],
      ['ModuleFeatureGrant', 'featureRowId', 'ModuleFeature', 'id'],
      ['ModuleFeatureGrant', 'tenantId', 'Tenant', 'id'],
    ];

    const mismatches = foreignKeys
      .filter(
        ([child, childField, parent, parentField]) =>
          scalarType(schema, child, childField) !== scalarType(schema, parent, parentField)
      )
      .map(
        ([child, childField, parent, parentField]) =>
          `${child}.${childField} != ${parent}.${parentField}`
      );

    expect(mismatches).toEqual([]);

    // The parents are plain `String` uuids — no `@db.Uuid` anywhere — which is this repository's
    // shape for a tenant id (§45.5) and the reason the membership's `tenantId` is a plain `String`.
    expect(scalarType(schema, 'Tenant', 'id')).toBe('String');
    expect(scalarType(schema, 'ModuleRegistration', 'moduleId')).toBe('String');
  });

  it('the admin write contract cannot express RESTRICTED_MEMBERS — and cannot name it in code either (§45.4 item 5, §45.8 DTO gate)', async () => {
    const dto = read(DTO_FILE);

    // THE FROZEN PAIR, UNCHANGED: extending `TENANT_SCOPES` is how a scope edit would become a grant
    // decision (moving a module INTO the member scope) or a silent widening (moving it OUT, from an
    // enumerated membership to every tenant).
    expect(dto).toContain("export const TENANT_SCOPES = ['ALL', 'RESTRICTED'] as const;");
    expect(dto).toContain('export const MAX_TENANT_IDS = 64;');

    // THE READ DIRECTION: the DTO layer cannot name the scope anywhere in CODE. A scope the admin
    // contract cannot express is one it cannot render as manageable, and one it cannot round-trip
    // out of a stored member-scoped row into an editable field.
    const dtoCode = dto
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(dtoCode).not.toContain('RESTRICTED_MEMBERS');

    // THE WRITE DIRECTION, as VALIDATION rather than as a union: the value reaches the API as a JSON
    // string, so a TypeScript type is not what refuses it. Both admin DTOs are exercised, because the
    // create path is how a scope is set and the update path is how it would be changed afterwards.
    for (const dtoClass of [CreateModuleRegistrationDto, UpdateModuleRegistrationDto]) {
      const body = plainToInstance(dtoClass, {
        moduleId: 'hr',
        displayName: 'Human Resources',
        tenantScope: 'RESTRICTED_MEMBERS',
        tenantIds: ['tenant-1'],
      });

      const errors = await validate(body, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors.map((error) => error.property)).toContain('tenantScope');
    }
  });
});
