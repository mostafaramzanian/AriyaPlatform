import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  PermissionToDomain,
  Permissions,
  PermissionsByDomain,
} from '../../auth/rbac/constants/permissions';
import { PRODUCTION_FEATURE, PRODUCTION_MODULE_ID } from './production.constants';

/**
 * Phase PRODUCTION-BOM-HEADER: the permission & entitlement wiring, read BACK as text —
 * the executable form of the same checkpoints Commerce's `commerce-entitlement.spec.ts`
 * pins for its four Core migrations.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four places cannot import each other: `production.constants.ts` (Production's source of
 * truth), `permissions.ts` (Core's catalogue) and Core's own migration history (SQL, a
 * different ownership boundary entirely). Drift between them compiles, passes every type
 * check, and then produces a `403` naming a module id or a permission string nobody
 * provisioned. SQL is not type-checked, so the only join available is the TEXT of the
 * files, and this suite is that join.
 *
 * CHECKPOINTS, AND WHY EACH IS FALSIFIABLE
 * ----------------------------------------
 *  A. the constants declare `production` / `bom`, and the SQL uses THOSE strings —
 *     renaming `PRODUCTION_FEATURE.BOM` to `'boms'` without editing the seed makes
 *     section C fail, which is the point;
 *  B. the four migrations exist under their pinned names (pinned by directory, so a
 *     rename is a deliberate edit to this gate);
 *  C. the seeds match the constants, read the tenant set (CROSS JOIN), are idempotent
 *     and carry stop-guards;
 *  D. the namespace is `production.*`, exactly the three names the decision closure's
 *     §17.3 declared, mirrored in `PermissionToDomain`, `PermissionsByDomain`, the schema
 *     enum and the seed SQL — in BOTH directions, so a fourth string or a dropped one fails;
 *  E. nothing outside the namespace is written, nothing is UPDATEd or DELETEd, every
 *     INSERT is conflict-guarded, and no `'hr'` or `'commerce'` row is touched;
 *  F. `ProductionModule` wires the entitlement gate exactly as HR, Correspondence and
 *     Commerce wire it;
 *  G. no Production-owned guard, no `CanActivate`, no entitlement-named source file;
 *  H. entitlement appears only where the rule puts it — the composition root and the
 *     controller boundary that DECLARES the requirement — and nowhere else in source;
 *  I. the HR and Commerce registration seeds still exist, unmodified in structure;
 *  J. permission and entitlement are separate records in separate migrations — a
 *     permission row never decides tenancy, an entitlement row never grants a user.
 *
 * Bounded by directory walk, excluding this file (it necessarily contains every
 * forbidden string as a literal or regex), exactly as the other guards exclude
 * themselves.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const CORE_MIGRATIONS = join(API_DIR, 'prisma', 'core', 'migrations');
const CORE_SCHEMA = join(API_DIR, 'prisma', 'core', 'schema.prisma');

// Named by directory, not discovered by a glob: a renamed or reordered migration file is
// a deliberate edit to this gate rather than a silent re-point of what it reads.
const DOMAIN_MIGRATION = '20261002100000_add_production_permission_domain';
const PERMISSIONS_MIGRATION = '20261002100100_seed_production_permission_grants';
const MEMBERSHIP_MIGRATION = '20261002100200_seed_production_module_tenant_membership';
const FEATURE_MIGRATION = '20261002100300_seed_production_bom_feature_entitlement';

// The registration seeds of the modules that were here first — read by their PINNED names
// so section I proves this phase left them alone rather than assuming it did.
const HR_MEMBERSHIP_MIGRATION = '20260921120300_seed_hr_module_tenant_membership';
const COMMERCE_MEMBERSHIP_MIGRATION = '20260926100200_seed_commerce_module_tenant_membership';

const PRODUCTION_MIGRATIONS = [
  DOMAIN_MIGRATION,
  PERMISSIONS_MIGRATION,
  MEMBERSHIP_MIGRATION,
  FEATURE_MIGRATION,
];

// The §17.3 list, verbatim from the decision closure — the names this suite pins. This
// DECLARES the namespace; section D proves the catalogue, the maps, the schema enum and
// the seed SQL all agree with it.
const EXPECTED_NAMESPACE = [
  'production.bom.approve',
  'production.bom.manage',
  'production.bom.read',
];

const readSql = (migration: string): string =>
  readFileSync(join(CORE_MIGRATIONS, migration, 'migration.sql'), 'utf8');
const readSource = (file: string): string => readFileSync(join(MODULE_DIR, file), 'utf8');

/** Every TypeScript file in the module, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const allFiles = walk(MODULE_DIR);
const GUARD_FILE = join(MODULE_DIR, 'production-entitlement.spec.ts');
const MODULE_FILE = join(MODULE_DIR, 'production.module.ts');

/**
 * The module's own SOURCE, at any depth — specs excluded, and this file excluded twice
 * over (it is a spec, and it necessarily contains every forbidden string as a literal).
 * Sections G and H read this list, which is why it is declared once: two filters would
 * let one of them drift while the other still passed.
 */
const NON_SPEC = allFiles.filter(
  (file) => !file.endsWith('.spec.ts') && file !== GUARD_FILE
);

/** The `production.*` strings the catalogue actually declares, as sorted values. */
const declaredNamespace = Object.values(Permissions)
  .filter((value) => value.startsWith('production.'))
  .sort();

const permissionSql = readSql(PERMISSIONS_MIGRATION);
const membershipSql = readSql(MEMBERSHIP_MIGRATION);
const featureSql = readSql(FEATURE_MIGRATION);

describe('PRODUCTION-BOM-HEADER: permission & entitlement wiring (A-J)', () => {
  it('A. the constants declare the module id and feature, in source and in value', () => {
    // Falsifiable: change PRODUCTION_MODULE_ID or PRODUCTION_FEATURE.BOM in
    // production.constants.ts alone and the expectations below fail here — while section C
    // fails against the SQL, which is the drift neither tsc nor the runtime can see.
    expect(PRODUCTION_MODULE_ID).toBe('production');
    expect(PRODUCTION_FEATURE.BOM).toBe('bom');
    expect(readSource('production.constants.ts')).toContain(
      `export const PRODUCTION_MODULE_ID = '${PRODUCTION_MODULE_ID}';`
    );
    expect(readSource('production.constants.ts')).toMatch(
      new RegExp(`BOM:\\s*'${PRODUCTION_FEATURE.BOM}',`)
    );
  });

  it('B. the four Core migrations exist under their pinned names and stay additive', () => {
    for (const migration of PRODUCTION_MIGRATIONS) {
      expect(existsSync(join(CORE_MIGRATIONS, migration, 'migration.sql'))).toBe(true);
      const sql = readSql(migration);
      // ADD, DON'T DESTROY: no row is ever rewritten or removed, so the only safety
      // property a pre-provisioned operator row needs is that these files skip it.
      expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
      expect(sql).not.toMatch(/^\s*DELETE\s+/im);
      // Idempotent: every statement that writes is conflict-guarded, one for one.
      const inserts = (sql.match(/^INSERT INTO/gm) ?? []).length;
      const guards = (sql.match(/^ON CONFLICT/gm) ?? []).length;
      expect(guards).toBe(inserts);
      // Our rows are ours: not one quoted `'hr'` or `'commerce'` literal anywhere in the
      // four files, so the other registrations cannot be rewritten from this side even
      // accidentally.
      expect(sql).not.toMatch(/'hr'/);
      expect(sql).not.toMatch(/'commerce'/);
    }
  });

  it('C. seeds match the constants, read the tenant set, and carry stop-guards', () => {
    // The registration names EXACTLY the id the constants export — the text join across
    // the Core/Production boundary, since neither file may import the other.
    expect(membershipSql).toContain('INSERT INTO "ModuleRegistration"');
    expect(membershipSql).toContain(`'${PRODUCTION_MODULE_ID}'`);
    expect(membershipSql).toContain('ON CONFLICT ("moduleId") DO NOTHING');
    // Fail-closed storage posture, stated in SQL rather than trusted to a comment:
    // enabled, RESTRICTED_MEMBERS with the EMPTY legacy array, so membership lives in
    // "ModuleRegistrationTenant" alone.
    expect(membershipSql).toMatch(/true,\s*'RESTRICTED_MEMBERS',\s*ARRAY\[\]::TEXT\[\]/);
    // READ, NOT LISTED: one membership row per tenant that exists at this moment.
    expect(membershipSql).toMatch(
      /INSERT INTO "ModuleRegistrationTenant"[\s\S]*?CROSS JOIN "Tenant"/
    );
    expect(membershipSql).toContain('ON CONFLICT ("registrationId", "tenantId") DO NOTHING');
    expect(membershipSql).toContain('RAISE EXCEPTION');

    // The feature pair hangs off the SAME module id, and grants are enumerated the same
    // way — the pair (module, feature) decided once, not two facts seeded together.
    expect(featureSql).toMatch(
      new RegExp(
        `INSERT INTO "ModuleFeature"[\\s\\S]*?'${PRODUCTION_MODULE_ID}',\\s*'${PRODUCTION_FEATURE.BOM}',`
      )
    );
    expect(featureSql).toContain('ON CONFLICT ("moduleId", "featureId") DO NOTHING');
    expect(featureSql).toMatch(/INSERT INTO "ModuleFeatureGrant"[\s\S]*?CROSS JOIN "Tenant"/);
    expect(featureSql).toContain('ON CONFLICT ("featureRowId", "tenantId") DO NOTHING');
    expect(featureSql).toContain('RAISE EXCEPTION');
  });

  it('D. the namespace is production.* — catalogue, maps, schema and SQL agree', () => {
    // The exact §17.3 list: a fourth `production.*` string (or a dropped one) fails here.
    expect(declaredNamespace).toEqual(EXPECTED_NAMESPACE);
    // Every string sits under a PRODUCTION_-prefixed key — a production.* value hung on an
    // HR_ key would split one remit across two vocabularies while looking correct.
    const productionKeys = Object.entries(Permissions).filter(([, value]) =>
      value.startsWith('production.')
    );
    expect(productionKeys.every(([key]) => key.startsWith('PRODUCTION_'))).toBe(true);
    for (const [, value] of productionKeys) {
      expect(PermissionToDomain[value as keyof typeof PermissionToDomain]).toBe('PRODUCTION');
    }
    // The admin UI grouping carries exactly the same set.
    expect([...PermissionsByDomain.PRODUCTION].sort()).toEqual(EXPECTED_NAMESPACE);
    // The schema declares the member the domain migration adds, and the migration adds
    // exactly that member — schema and SQL history cannot diverge either.
    const coreSchema = readFileSync(CORE_SCHEMA, 'utf8');
    expect(coreSchema).toMatch(/enum PermissionDomain \{[^}]*PRODUCTION[^}]*\}/);
    expect(readSql(DOMAIN_MIGRATION)).toContain(
      `ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'PRODUCTION';`
    );
    // The seed SQL holds the SAME three strings, checked in BOTH directions.
    for (const value of declaredNamespace) expect(permissionSql).toContain(`'${value}'`);
    const sqlLiterals = [...permissionSql.matchAll(/'(production\.[a-z.]+)'/g)].map((m) => m[1]);
    expect([...new Set(sqlLiterals)].sort()).toEqual(EXPECTED_NAMESPACE);
    // And every catalogue row carries the PRODUCTION domain tag.
    const domainTaggedRows = (
      permissionSql.match(
        /^\s*\('production-[a-z-]+',\s*'production\.[a-z.]+',\s*'[^']+',\s*'PRODUCTION'/gm
      ) ?? []
    ).length;
    expect(domainTaggedRows).toBe(EXPECTED_NAMESPACE.length);
  });
});


describe('PRODUCTION-BOM-HEADER: what each seed may write (E-G)', () => {
  it('E. nothing outside the namespace is written, and no other owner is touched', () => {
    // Every INSERT is conflict-guarded (B), nothing is rewritten or deleted (B), and the
    // only tables the permission seed writes are the catalogue's own two.
    expect(permissionSql.match(/^INSERT INTO "(?:Permission|RolePermission)"/gm)).toHaveLength(3);
    const permissionStatements = (permissionSql.match(/^INSERT INTO .*$/gm) ?? []).join('\n');
    expect(permissionStatements).not.toMatch(
      /ModuleRegistration|ModuleFeature|ModuleFeatureGrant|ModuleRegistrationTenant/
    );
    // Neither entitlement seed writes a permission, and no quoted `production.*` literal
    // appears in them — the vocabulary of one system simply does not occur in the other's
    // files, which is what makes "holding every permission still fails for an unentitled
    // tenant" true by construction rather than by policy.
    for (const migration of [MEMBERSHIP_MIGRATION, FEATURE_MIGRATION]) {
      const sql = readSql(migration);
      const entitlementStatements = (sql.match(/^INSERT INTO .*$/gm) ?? []).join('\n');
      expect(entitlementStatements).not.toMatch(/"Permission"|"RolePermission"/);
      expect(sql).not.toMatch(/'production\.[a-z]/);
    }
  });

  it('F. the composition root wires the entitlement gate as the other modules do', () => {
    const moduleSource = readFileSync(MODULE_FILE, 'utf8');
    // The GUARD is provided where Nest instantiates it; the DECLARATION is on the
    // controller. Without the first half the second is decoration.
    expect(moduleSource).toContain('ModuleEntitlementGuard');
    expect(moduleSource).toContain('PlatformEntitlementModule');
    // The repository is provided but NOT exported, so nothing outside this bounded
    // context can issue a query against `production_db`.
    expect(moduleSource).toContain('BomHeaderRepository');
    expect(/exports:\s*\[[^\]]*BomHeaderRepository/s.test(moduleSource)).toBe(false);
    expect(moduleSource).toMatch(/exports:\s*\[\s*ProductionAuditGateway\s*\]/);
  });

  it('G. no Production-owned guard, no CanActivate, no entitlement-named source file', () => {
    // The platform DECIDES; Production only declares. A second guard in this module would
    // be a second answer to "is this tenant entitled?", and the two would disagree the
    // first time one of them changed.
    const offenders = allFiles
      .filter((file) => file !== GUARD_FILE)
      .filter((file) => /entitlement/i.test(file.replace(/\.spec\.ts$/, '')));
    expect(offenders).toEqual([]);

    const canActivate = NON_SPEC.filter((file) =>
      /implements\s+CanActivate/.test(readFileSync(file, 'utf8'))
    );
    expect(canActivate).toEqual([]);
  });
});


describe('PRODUCTION-BOM-HEADER: where entitlement may appear (H-J)', () => {
  it('H. entitlement is declared only at the composition root and the controller', () => {
    // Why non-spec files only: a spec that reads `@RequiresFeature`'s metadata key is
    // CHECKING the wiring, not deciding anything — the same distinction that keeps
    // `RolesGuard` untested at runtime while the decorator is pinned at the boundary.
    // A SERVICE reaching for the port, on the other hand, would make tenancy a question
    // the application layer answers for itself.
    const entitled = NON_SPEC.filter((file) => {
      // Stripped to CODE: `production.constants.ts` is a file of prose about the
      // decorators, and a rule that matched its own jsdoc would stop catching the thing
      // it is for — a service reaching for the port — the moment a comment named one.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return (
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') &&
            !trimmed.startsWith('*/')
          );
        })
        .join('\n');
      return (
        code.includes('@RequiresModule(') ||
        code.includes('@RequiresFeature(') ||
        code.includes('ModuleEntitlementGuard') ||
        code.includes('ENTITLEMENT_PORT')
      );
    });
    expect(entitled.map((file) => file.replace(/\\/g, '/').split('/').pop()).sort()).toEqual([
      'bom-change.controller.ts',
      'bom-item.controller.ts',
      'bom.controller.ts',
      'production.module.ts',
    ]);
  });

  it('I. the HR and Commerce registration seeds still stand, untouched by this phase', () => {
    // HR's and Commerce's membership seeds are read by their PINNED names and still
    // provision their own module in the same idempotent RESTRICTED_MEMBERS shape this
    // phase adopted — four files that name ONLY `production`, so three registrations,
    // three ids, is what the seeds produce. Never a merge and never a rename.
    const hrSql = readSql(HR_MEMBERSHIP_MIGRATION);
    expect(hrSql).toContain(`'hr'`);
    expect(hrSql).toContain("'RESTRICTED_MEMBERS'");
    expect(hrSql).toContain('ON CONFLICT ("moduleId") DO NOTHING');

    const commerceSql = readSql(COMMERCE_MEMBERSHIP_MIGRATION);
    expect(commerceSql).toContain(`'commerce'`);
    expect(commerceSql).toContain("'RESTRICTED_MEMBERS'");
    expect(commerceSql).toContain('ON CONFLICT ("moduleId") DO NOTHING');

    expect(membershipSql).not.toContain(`'hr'`);
    expect(membershipSql).not.toContain(`'commerce'`);
  });

  it('J. permission and entitlement are separate records in separate migrations', () => {
    // THE RULE, executable: a permission row answers "may this USER act" and is written
    // only into "Permission"/"RolePermission"; an entitlement row answers "may this
    // TENANT hold the module" and is written only into the registration/feature tables.
    // Neither side writes the other's tables, so no single row — and no single file —
    // can decide both questions at once.
    expect((permissionSql.match(/^INSERT INTO .*$/gm) ?? []).join('\n')).not.toMatch(
      /ModuleRegistration|ModuleFeature|ModuleFeatureGrant|ModuleRegistrationTenant/
    );
    for (const migration of [MEMBERSHIP_MIGRATION, FEATURE_MIGRATION]) {
      const sql = readSql(migration);
      expect((sql.match(/^INSERT INTO .*$/gm) ?? []).join('\n')).not.toMatch(
        /"Permission"|"RolePermission"/
      );
      expect(sql).not.toMatch(/'production\.[a-z]/);
    }
  });
});
