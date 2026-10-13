import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  PermissionToDomain,
  Permissions,
  PermissionsByDomain,
} from '../../auth/rbac/constants/permissions';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from './commerce.constants';

/**
 * Phase C1 Step J (§21.J / gate G13): the permission & entitlement wiring, read BACK as
 * text — the executable form of §14's checkpoints A–J.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Step J touches three places that CANNOT import each other: `commerce.constants.ts`
 * (Commerce's source of truth), `permissions.ts` (Core's catalogue) and Core's own
 * migration history (SQL, a different ownership boundary entirely). Drift between them
 * compiles, passes every type check, and then produces a `403` naming a module id or a
 * permission string nobody provisioned — the exact failure `hr-isolation.spec.ts` gate 4
 * exists for on the HR side. SQL is not type-checked, so the only join available is the
 * TEXT of the files, and this suite is that join.
 *
 * CHECKPOINTS, AND WHY EACH IS FALSIFIABLE (§14)
 * ----------------------------------------------
 *  A. the constants declare `commerce` / `purchase`, and the SQL uses THOSE strings —
 *     renaming `COMMERCE_FEATURE.PURCHASE` to `'procurement'` without editing the seed
 *     makes section C fail, which is the point;
 *  B. the four migrations exist under their pinned names (pinned by directory, so a
 *     rename is a deliberate edit to this gate);
 *  C. the seeds match the constants, read the tenant set (CROSS JOIN), are idempotent
 *     and carry stop-guards;
 *  D. the namespace is `commerce.*`, exactly the six names C1 §10 declares, mirrored in
 *     `PermissionToDomain`, `PermissionsByDomain`, the schema enum and the seed SQL —
 *     in BOTH directions, so a seventh string or a dropped one fails;
 *  E. nothing outside the namespace is written, nothing is UPDATEd or DELETEd, every
 *     INSERT is conflict-guarded (additive / idempotent invariant), and no `'hr'` row is
 *     touched;
 *  F. `CommerceModule` wires the entitlement gate exactly as HR wires it;
 *  G. no Commerce-owned guard, no `CanActivate`, no entitlement-named source file;
 *  H. entitlement appears only where §14 puts it — the module's composition root and
 *     the controller boundary that DECLARES the requirement — and nowhere else in source;
 *  I. the HR registration seed still exists, unmodified in structure;
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
const DOMAIN_MIGRATION = '20260926100000_add_commerce_permission_domain';
const PERMISSIONS_MIGRATION = '20260926100100_seed_commerce_permission_grants';
const MEMBERSHIP_MIGRATION = '20260926100200_seed_commerce_module_tenant_membership';
const FEATURE_MIGRATION = '20260926100300_seed_commerce_purchase_feature_entitlement';
const HR_MEMBERSHIP_MIGRATION = '20260921120300_seed_hr_module_tenant_membership';

const COMMERCE_MIGRATIONS = [
  DOMAIN_MIGRATION,
  PERMISSIONS_MIGRATION,
  MEMBERSHIP_MIGRATION,
  FEATURE_MIGRATION,
];

// The §10 list, verbatim from the authoritative specification — the names this suite
// pins. This DECLARES the namespace; section D proves the catalogue, the maps, the
// schema enum and the seed SQL all agree with it.
const EXPECTED_NAMESPACE = [
  'commerce.approve',
  'commerce.commercial.manage',
  'commerce.configure',
  'commerce.manage',
  'commerce.read',
  'commerce.workflow.manage',
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
const GUARD_FILE = join(MODULE_DIR, 'commerce-entitlement.spec.ts');
const MODULE_FILE = join(MODULE_DIR, 'commerce.module.ts');

/** The `commerce.*` strings the catalogue actually declares, as sorted values. */
const declaredNamespace = Object.values(Permissions)
  .filter((value) => value.startsWith('commerce.'))
  .sort();

const permissionSql = readSql(PERMISSIONS_MIGRATION);
const membershipSql = readSql(MEMBERSHIP_MIGRATION);
const featureSql = readSql(FEATURE_MIGRATION);

describe('C1 step J: permission & entitlement wiring (§14 A-J, gate G13)', () => {
  it('A. the constants declare the module id and feature, in source and in value', () => {
    // Falsifiable: change COMMERCE_MODULE_ID or COMMERCE_FEATURE.PURCHASE in
    // commerce.constants.ts alone and the expectations below fail here — while section C
    // fails against the SQL, which is the drift neither tsc nor the runtime can see.
    expect(COMMERCE_MODULE_ID).toBe('commerce');
    expect(COMMERCE_FEATURE.PURCHASE).toBe('purchase');
    expect(readSource('commerce.constants.ts')).toContain(
      `export const COMMERCE_MODULE_ID = '${COMMERCE_MODULE_ID}';`
    );
    expect(readSource('commerce.constants.ts')).toMatch(
      new RegExp(`PURCHASE:\\s*'${COMMERCE_FEATURE.PURCHASE}',`)
    );
  });

  it('B. the four Core migrations exist under their pinned names and stay additive', () => {
    for (const migration of COMMERCE_MIGRATIONS) {
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
      // Our rows are ours: not one quoted `'hr'` literal anywhere in the four files, so
      // the HR registration cannot be rewritten from this side even accidentally.
      expect(sql).not.toMatch(/'hr'/);
    }
  });

  it('C. seeds match the constants, read the tenant set, and carry stop-guards (§14 C)', () => {
    // The registration names EXACTLY the id the constants export — the text join across
    // the Core/Commerce boundary, since neither file may import the other.
    expect(membershipSql).toContain('INSERT INTO "ModuleRegistration"');
    expect(membershipSql).toContain(`'${COMMERCE_MODULE_ID}'`);
    expect(membershipSql).toContain('ON CONFLICT ("moduleId") DO NOTHING');
    // Fail-closed storage posture, stated in SQL rather than trusted to a comment:
    // enabled, RESTRICTED_MEMBERS with the EMPTY legacy array (the replacement CHECK's
    // third branch), so membership lives in "ModuleRegistrationTenant" alone.
    expect(membershipSql).toMatch(/true,\s*'RESTRICTED_MEMBERS',\s*ARRAY\[\]::TEXT\[\]/);
    // READ, NOT LISTED: one membership row per tenant that exists at this moment.
    expect(membershipSql).toMatch(
      /INSERT INTO "ModuleRegistrationTenant"[\s\S]*?CROSS JOIN "Tenant"/
    );
    expect(membershipSql).toContain('ON CONFLICT ("registrationId", "tenantId") DO NOTHING');
    expect(membershipSql).toContain('RAISE EXCEPTION');

    // The feature pair hangs off the SAME module id, and grants are enumerated the same
    // way — the pair `(module, feature)` decided once, not two facts seeded together.
    expect(featureSql).toMatch(
      new RegExp(
        `INSERT INTO "ModuleFeature"[\\s\\S]*?'${COMMERCE_MODULE_ID}',\\s*'${COMMERCE_FEATURE.PURCHASE}',`
      )
    );
    expect(featureSql).toContain('ON CONFLICT ("moduleId", "featureId") DO NOTHING');
    expect(featureSql).toMatch(/INSERT INTO "ModuleFeatureGrant"[\s\S]*?CROSS JOIN "Tenant"/);
    expect(featureSql).toContain('ON CONFLICT ("featureRowId", "tenantId") DO NOTHING');
    expect(featureSql).toContain('RAISE EXCEPTION');
  });

  it('D. the namespace is commerce.* — catalogue, maps, schema and SQL agree (§14 D)', () => {
    // The exact §10 list: a seventh `commerce.*` string (or a dropped one) fails here.
    expect(declaredNamespace).toEqual(EXPECTED_NAMESPACE);
    // Every string sits under a COMMERCE_-prefixed key — a commerce.* value hung on an
    // HR_ key would split one remit across two vocabularies while looking correct.
    const commerceKeys = Object.entries(Permissions).filter(([, value]) =>
      value.startsWith('commerce.')
    );
    expect(commerceKeys.every(([key]) => key.startsWith('COMMERCE_'))).toBe(true);
    for (const [, value] of commerceKeys) {
      expect(PermissionToDomain[value as keyof typeof PermissionToDomain]).toBe('COMMERCE');
    }
    // The admin UI grouping carries exactly the same set — no commerce string missing
    // from the group, no string in the group that the catalogue does not declare.
    expect([...PermissionsByDomain.COMMERCE].sort()).toEqual(EXPECTED_NAMESPACE);
    // The schema declares the member the domain migration adds, and the migration adds
    // exactly that member — schema and SQL history cannot diverge either.
    const coreSchema = readFileSync(CORE_SCHEMA, 'utf8');
    expect(coreSchema).toMatch(/enum PermissionDomain \{[^}]*COMMERCE[^}]*\}/);
    expect(readSql(DOMAIN_MIGRATION)).toContain(
      `ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'COMMERCE';`
    );
    // The seed SQL holds the SAME six strings, checked in BOTH directions: every
    // declared name appears in the SQL, and every quoted commerce.* literal in the SQL
    // is a declared name — neither side can drift alone.
    for (const value of declaredNamespace) expect(permissionSql).toContain(`'${value}'`);
    const sqlLiterals = [...permissionSql.matchAll(/'(commerce\.[a-z.]+)'/g)].map((m) => m[1]);
    expect([...new Set(sqlLiterals)].sort()).toEqual(EXPECTED_NAMESPACE);
    // And every catalogue row carries the COMMERCE domain tag — six VALUES rows, one per
    // declared string: a row seeded with domain 'HR' would file Commerce under HR.
    const domainTaggedRows = (
      permissionSql.match(
        /^\s*\('commerce-[a-z-]+',\s*'commerce\.[a-z.]+',\s*'[^']+',\s*'COMMERCE'/gm
      ) ?? []
    ).length;
    expect(domainTaggedRows).toBe(EXPECTED_NAMESPACE.length);
  });

  it('E. the migrations create only commerce records and modify nothing (§14 E)', () => {
    // The complete set of tables the four files may write — the platform registry, the
    // feature level, and the catalogue with its role map, nothing else. A join table, a
    // tenant row or a role row written from here would expand the set and fail.
    const insertTargets = COMMERCE_MIGRATIONS.flatMap(
      (migration) => readSql(migration).match(/^INSERT INTO "[A-Za-z]+"/gm) ?? []
    );
    expect([...new Set(insertTargets)].sort()).toEqual([
      'INSERT INTO "ModuleFeature"',
      'INSERT INTO "ModuleFeatureGrant"',
      'INSERT INTO "ModuleRegistration"',
      'INSERT INTO "ModuleRegistrationTenant"',
      'INSERT INTO "Permission"',
      'INSERT INTO "RolePermission"',
    ]);
    // Nothing existing is UPDATEd or DELETEd (B proves it per file), every write is
    // conflict-guarded (B counts them), and D proves the permission names are exactly
    // the declared six — so a duplicate row, or a rewritten pre-existing one, is
    // unreachable rather than merely unlikely.
  });

  it('F. CommerceModule wires the entitlement gate exactly as HR wires it (§14 F)', () => {
    const moduleSource = readSource('commerce.module.ts');
    // Provided where Nest instantiates it, and the port arrives through the ONE import
    // site §43.6 allows — each asserted INSIDE its own decorator array, so the token in
    // a comment, in the doc block or in `exports` cannot satisfy it.
    expect(moduleSource).toMatch(/providers:\s*\[[^\]]*ModuleEntitlementGuard/);
    expect(moduleSource).toMatch(/imports:\s*\[[^\]]*PlatformEntitlementModule/);
    // As real import statements, not string mentions: a comment cannot wire DI.
    expect(moduleSource).toContain(
      "import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';"
    );
    expect(moduleSource).toContain(
      "import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';"
    );
    // Never re-exported: the port's home is not Commerce's to publish — the same rule
    // the gateway guard states for the other platform modules.
    const exportsBlock = /exports:\s*\[[^\]]*\]/.exec(moduleSource)?.[0] ?? '';
    expect(exportsBlock).not.toContain('Entitlement');
  });

  it('G. no Commerce-specific entitlement guard exists (§14 G)', () => {
    // The decision point is platform-owned and singular: a guard, a `CanActivate`
    // implementation or an entitlement-named SOURCE file under Commerce would be a
    // second place where "is this tenant entitled?" gets answered — the drift §14 G
    // forbids. Spec files are excluded from the name scan because this file is itself
    // named *entitlement*; source files are not.
    const sourceFiles = allFiles.filter((file) => !file.endsWith('.spec.ts'));
    expect(sourceFiles.filter((file) => /entitle/i.test(file))).toEqual([]);
    expect(
      sourceFiles.filter((file) => /implements\s+CanActivate/.test(readFileSync(file, 'utf8')))
    ).toEqual([]);
  });

  it('H. nothing outside commerce.module.ts references entitlement (§14 H)', () => {
    // THE PROHIBITION, in the shape hr-isolation states it: entitlement may appear in a
    // CONTROLLER (none exists yet) or in the module definition, and NOWHERE ELSE in
    // SOURCE — no service, no gateway, no repository, no DTO, no constants. Raw-text on
    // purpose: an import taken for a TYPE is still a reference, and a comment that
    // mentions a guard token has already started to think about entitlement. Spec files
    // take the import assertion instead, for the reason commerce-gateways.spec.ts
    // records: a test that writes a token into a regex is not a consumer of the port,
    // whereas a test that imports the contract is.
    const ENTITLEMENT =
      /\b(ENTITLEMENT_PORT|ModuleEntitlementGuard|RequiresModule|RequiresFeature)\b|platform\/entitlement/;
    const CONTROLLER_SUFFIX = '.controller.ts';
    const sourceFiles = allFiles.filter((file) => !file.endsWith('.spec.ts'));
    const surfaces = sourceFiles.filter(
      (file) =>
        file !== MODULE_FILE &&
        !file.endsWith(CONTROLLER_SUFFIX) &&
        ENTITLEMENT.test(readFileSync(file, 'utf8'))
    );
    expect(surfaces).toEqual([]);
    // The CONTROLLER is the other place §14 names, and step L is the first step that has
    // one: it DECLARES the requirement at the boundary while the decision stays the
    // platform guard's. Each controller must therefore declare the whole of it — the
    // module id, the feature pair and the guard — because a Commerce route missing one
    // of the three would be reachable by a caller whose tenant is not entitled to
    // purchase at all. The floor keeps this loop from passing on an empty set.
    const controllers = sourceFiles.filter((file) => file.endsWith(CONTROLLER_SUFFIX));
    expect(controllers.length).toBeGreaterThanOrEqual(1);
    for (const file of controllers) {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/@RequiresModule\(COMMERCE_MODULE_ID\)/);
      expect(source).toMatch(/@RequiresFeature\(COMMERCE_MODULE_ID, COMMERCE_FEATURE\.PURCHASE\)/);
      expect(source).toContain('@UseGuards(ModuleEntitlementGuard)');
    }
    const specImports = allFiles.filter(
      (file) =>
        file.endsWith('.spec.ts') &&
        file !== GUARD_FILE &&
        /^import .*from '[^']*platform\/entitlement/m.test(readFileSync(file, 'utf8'))
    );
    expect(specImports).toEqual([]);
  });

  it('I. the HR registration seed still stands, and Commerce rewrites no row (§14 I)', () => {
    // HR's membership seed is read by its PINNED name and still provisions `hr` in the
    // same idempotent RESTRICTED_MEMBERS shape Commerce adopted — step J adds a second
    // registration beside it, never a modification of it (B proves our four files carry
    // no UPDATE or DELETE that could reach any row, HR's included; D proves the
    // catalogue gained exactly six rows and no existing name was touched).
    const hrSql = readSql(HR_MEMBERSHIP_MIGRATION);
    expect(hrSql).toContain(`'hr'`);
    expect(hrSql).toContain("'RESTRICTED_MEMBERS'");
    expect(hrSql).toContain('ON CONFLICT ("moduleId") DO NOTHING');
    // Coexistence: our registration names only `commerce`, so two rows — two ids — is
    // what the seeds produce, never a merge or a rename.
    expect(membershipSql).not.toContain(`'hr'`);
  });

  it('J. permission and entitlement are separate records in separate migrations (§14 J)', () => {
    // THE RULE, executable: a permission row answers "may this USER act" and is written
    // only into "Permission"/"RolePermission"; an entitlement row answers "may this
    // TENANT hold the module" and is written only into the registration/feature tables.
    // Neither side writes the other's tables, so no single row — and no single file —
    // can decide both questions at once. This is what makes "a SUPER_ADMIN holding
    // every permission string is still refused when the tenancy is not entitled"
    // true by construction rather than by policy.
    const permissionStatements = (permissionSql.match(/^INSERT INTO .*$/gm) ?? []).join('\n');
    expect(permissionStatements).not.toMatch(
      /ModuleRegistration|ModuleFeature|ModuleFeatureGrant|ModuleRegistrationTenant/
    );
    expect(permissionSql.match(/^INSERT INTO "(?:Permission|RolePermission)"/gm)).toHaveLength(3);
    for (const migration of [MEMBERSHIP_MIGRATION, FEATURE_MIGRATION]) {
      const sql = readSql(migration);
      const entitlementStatements = (sql.match(/^INSERT INTO .*$/gm) ?? []).join('\n');
      expect(entitlementStatements).not.toMatch(/"Permission"|"RolePermission"/);
      // No quoted commerce.* permission literal anywhere in the entitlement seeds — the
      // vocabulary of one system simply does not occur in the other's files.
      expect(sql).not.toMatch(/'commerce\.[a-z]/);
    }
  });
});
