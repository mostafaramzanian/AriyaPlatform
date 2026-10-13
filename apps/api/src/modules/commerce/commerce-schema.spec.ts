import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Phase C1 Step K (§21.K): the Commerce schema and its FIRST migration, read
 * BACK as text — the executable form of the promises the schema's own comments
 * make.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Step K writes two artifacts that NOTHING else can cross-check: a Prisma
 * schema (TS never sees it) and a migration (SQL is not type-checked at all).
 * The schema's `PurchaseLineType` note promises that "the Step K guard spec
 * reads this block AND the migration's CREATE TYPE, so slipping the member in
 * later fails the suite instead of quietly widening a vocabulary no test
 * defined" — this suite is that reader. The join it performs is TEXT, exactly
 * like `commerce-entitlement.spec.ts` joins Commerce's constants to Core's
 * SQL: the schema and the migration cannot import each other, so the only
 * executable statement available is "the same vocabulary, in both files".
 *
 * WHAT IS PINNED, AND WHY EACH PIN IS FALSIFIABLE
 * ----------------------------------------------
 *  A. the baseline migration exists under its pinned DIRECTORY name (a rename
 *     is a deliberate edit to this gate, never a silent re-point);
 *  B. every enum in the schema is present in the baseline with the SAME
 *     members — and the members the baseline states are pinned exactly, so
 *     editing an applied migration fails here;
 *  C. `PurchaseLineType` is EXACTLY the three members §5.2 closes, in BOTH
 *     files, and no enum member named `EXPENSE` exists anywhere — in the
 *     schema or in ANY migration ever added, so §5.2's refusal cannot be
 *     walked around by a later `ALTER TYPE … ADD VALUE`;
 *  D. the specification-closed vocabularies (§5.6 execution modes, §5.8 actor
 *     sources, §5.9/§5.10 scopes/statuses/decisions, §5.1 kind) are stated
 *     exactly; the three LIFECYCLES later C1 steps are expected to extend
 *     (`PurchaseDocumentStatus` for §29, `WorkflowInstanceStatus`,
 *     `WorkflowDefinitionVersionStatus`) are pinned as NO-REMOVAL: a member
 *     may be added by a later migration, never silently dropped or renamed —
 *     which is why the schema check there is a superset, not equality;
 *  E. the version lifecycle and the approval decision REUSE the repository's
 *     existing vocabulary — compared against `prisma/hr/schema.prisma`, the
 *     precedent §5.5 tells preflight to adopt;
 *  F. storage is tenant-first STRUCTURALLY: every table carries
 *     `tenant_id TEXT NOT NULL`, every index leads with `tenant_id`, every
 *     foreign key is composite with `tenant_id` — and the baseline is purely
 *     additive (no DROP / TRUNCATE / DELETE), with no cross-owner or
 *     cross-database reference anywhere (`core_db`, `hr_db`, extensions,
 *     foreign tables);
 *  G. no forbidden identity or credential shape enters the schema or the
 *     migration — §7/§31's "no User/Tenant/Role/Permission, no credentials".
 *
 * NON-VACUITY. Every scan asserts the number of things it read: a loop that
 * matched zero enums, zero tables or zero migrations would fail instead of
 * passing quietly (the rule §4 states: "do not create tests that technically
 * exist but can pass because the scan matches zero files").
 */

const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const COMMERCE_PRISMA = join(API_DIR, 'prisma', 'commerce');
const SCHEMA_FILE = join(COMMERCE_PRISMA, 'schema.prisma');
const MIGRATIONS_DIR = join(COMMERCE_PRISMA, 'migrations');
const HR_SCHEMA_FILE = join(API_DIR, 'prisma', 'hr', 'schema.prisma');

// Named by directory, not discovered by a glob: the baseline is history, and a
// rename of an applied migration is a deliberate edit to this gate.
const BASELINE_MIGRATION = '20260926121430_commerce_baseline';

const schemaText = readFileSync(SCHEMA_FILE, 'utf8');
const baselineSql = readFileSync(join(MIGRATIONS_DIR, BASELINE_MIGRATION, 'migration.sql'), 'utf8');
const hrSchemaText = readFileSync(HR_SCHEMA_FILE, 'utf8');

/** The seven models Step K persists — §5.1, §5.2, §5.5, §5.6, §5.9, §5.10. */
const MODELS = [
  'PurchaseDocument',
  'PurchaseLine',
  'WorkflowDefinition',
  'WorkflowDefinitionVersion',
  'WorkflowStep',
  'WorkflowInstance',
  'WorkflowStepInstance',
] as const;

/**
 * The baseline migration's enum vocabulary, member by member. Pinned HERE, not
 * read from the schema: the migration is applied history and must never change,
 * while the schema is allowed to grow past it by NEW migrations.
 */
const BASELINE_ENUMS: Record<string, readonly string[]> = {
  PurchaseLineType: ['STANDARD', 'NON_STANDARD', 'SERVICE'],
  PurchaseDocumentKind: ['PURCHASE_REQUEST'],
  PurchaseDocumentStatus: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'],
  WorkflowDefinitionVersionStatus: ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'],
  WorkflowStepExecutionMode: ['SEQUENTIAL', 'PARALLEL', 'CONDITIONAL'],
  WorkflowActorSource: [
    'REQUESTER_MANAGER',
    'GROUP_MANAGER',
    'COMMERCIAL_LIAISON',
    'CONFIGURED_USER',
    'CONFIGURED_ROLE',
    'RULE_RESOLVER',
  ],
  WorkflowSubjectType: ['PURCHASE_DOCUMENT', 'PURCHASE_LINE'],
  WorkflowInstanceStatus: ['RUNNING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  WorkflowScopeType: ['DOCUMENT', 'LINE'],
  WorkflowStepInstanceStatus: ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'DELEGATED'],
  WorkflowStepDecision: ['APPROVED', 'REJECTED'],
};

/** The members the schema may never lose: {@link BASELINE_ENUMS} covers these. */
const EXTENSIBLE_BY_MIGRATION = new Set([
  'PurchaseDocumentStatus',
  'WorkflowInstanceStatus',
  'WorkflowDefinitionVersionStatus',
]);

/** The member list of one `enum NAME { … }` block in a Prisma schema. */
function schemaEnumMembers(text: string, name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(text);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** Every `enum NAME` a schema declares, so each loop can prove its non-emptiness. */
function schemaEnumNames(text: string): string[] {
  return [...text.matchAll(/^enum ([A-Za-z0-9_]+) \{/gm)].map((match) => match[1]);
}

/** The member list of one `CREATE TYPE "NAME" AS ENUM (…)` statement. */
function sqlEnumMembers(sql: string, name: string): string[] {
  const block = new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\);`).exec(sql);
  if (!block) return [];
  return block[1]
    .split(',')
    .map((member) => member.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((member) => member.length > 0);
}

/** Every table a migration SQL creates, in file order. */
function createdTables(sql: string): string[] {
  return [...sql.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map((match) => match[1]);
}

/** Every `CREATE [UNIQUE] INDEX …` statement, so each can be checked tenant-first. */
function indexStatements(sql: string): string[] {
  return sql.match(/^CREATE (?:UNIQUE )?INDEX [^\n]+$/gm) ?? [];
}

/** Every `ADD CONSTRAINT … FOREIGN KEY (…)` statement. */
function foreignKeyStatements(sql: string): string[] {
  return sql.match(/^ALTER TABLE [^\n]*FOREIGN KEY [^\n]+$/gm) ?? [];
}

/** Every `migration.sql` under the Commerce migration root, baseline included. */
function migrationSqlFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR).flatMap((entry) => {
    const direct = join(MIGRATIONS_DIR, entry);
    if (!statSync(direct).isDirectory()) return [];
    const file = join(direct, 'migration.sql');
    return existsSync(file) ? [file] : [];
  });
}

describe('C1 step K: the Commerce schema and its baseline migration (§5, gate G5)', () => {
  it('A. the baseline migration exists under its pinned name and persists exactly the seven Step K models', () => {
    // Falsifiable: deleting or renaming the directory fails immediately; so
    // does a table hand-added to THIS migration or a model silently dropped
    // from the schema — the migration is the storage contract §18 names, and
    // nothing else in the repository pins it.
    expect(BASELINE_MIGRATION).toMatch(/^\d{14}_[a-z0-9_]+$/);
    expect(existsSync(join(MIGRATIONS_DIR, BASELINE_MIGRATION, 'migration.sql'))).toBe(true);
    expect(baselineSql.length).toBeGreaterThan(0);

    const tables = createdTables(baselineSql);
    expect(tables.length).toBeGreaterThanOrEqual(MODELS.length);
    expect([...tables].sort()).toEqual([...MODELS].sort());
    for (const model of MODELS) {
      expect({ model, inSchema: schemaText.includes(`model ${model} {`) }).toEqual({
        model,
        inSchema: true,
      });
    }
  });

  it('B. every enum is in the baseline with exactly the members the baseline pins, and the schema never loses one', () => {
    // Falsifiable: editing an already-applied migration (its members are
    // pinned HERE, not read from the schema) fails; dropping or renaming a
    // member from the schema fails the no-removal check. The direction is
    // deliberate: the migration is history and may not change, while the
    // schema may grow past it by NEW migrations — which is exactly how §29's
    // completion and the step Q/R/S lifecycles are expected to arrive.
    const names = Object.keys(BASELINE_ENUMS);
    expect(names.length).toBeGreaterThanOrEqual(11); // non-vacuity: the loop is not empty
    for (const name of names) {
      const expected = BASELINE_ENUMS[name];
      expect({ name, sql: sqlEnumMembers(baselineSql, name) }).toEqual({ name, sql: expected });

      const inSchema = schemaEnumMembers(schemaText, name);
      if (EXTENSIBLE_BY_MIGRATION.has(name)) {
        for (const member of expected) {
          expect({ name, member, declared: inSchema.includes(member) }).toEqual({
            name,
            member,
            declared: true,
          });
        }
      } else {
        // The specification closes this vocabulary; widening it is a
        // deliberate edit to this gate, never a drive-by addition.
        expect({ name, schema: inSchema }).toEqual({ name, schema: expected });
      }
    }
  });

  it('C. PurchaseLineType is exactly §5.2’s three members in BOTH artifacts, and EXPENSE exists in no enum anywhere', () => {
    // Falsifiable: adding EXPENSE to the schema block, to the baseline, or to
    // ANY later migration (`ALTER TYPE … ADD VALUE 'EXPENSE'`) fails — the
    // promise the schema's own note makes ("slipping the member in later fails
    // the suite instead of quietly widening a vocabulary no test defined").
    expect(schemaEnumMembers(schemaText, 'PurchaseLineType')).toEqual([
      'STANDARD',
      'NON_STANDARD',
      'SERVICE',
    ]);
    expect(sqlEnumMembers(baselineSql, 'PurchaseLineType')).toEqual([
      'STANDARD',
      'NON_STANDARD',
      'SERVICE',
    ]);

    const declared = schemaEnumNames(schemaText);
    expect(declared.length).toBeGreaterThanOrEqual(11); // non-vacuity
    for (const name of declared) {
      expect({ name, hasExpense: schemaEnumMembers(schemaText, name).includes('EXPENSE') }).toEqual(
        {
          name,
          hasExpense: false,
        }
      );
    }

    const files = migrationSqlFiles();
    expect(files.length).toBeGreaterThanOrEqual(1); // non-vacuity
    for (const file of files) {
      expect({ file, addsExpense: readFileSync(file, 'utf8').includes("'EXPENSE'") }).toEqual({
        file,
        addsExpense: false,
      });
    }
  });

  it('D. the version lifecycle and the step decision reuse the vocabulary §5.5 tells preflight to adopt', () => {
    // Falsifiable: renaming a member on either side fails — which is the
    // point. Two spellings of "published" would let a PUBLISHED version be
    // read as something else by whichever owner compares it, and the failure
    // would be a wrong decision, not a compile error.
    const hrLifecycle = schemaEnumMembers(hrSchemaText, 'LeavePolicyVersionStatus');
    const hrMissionLifecycle = schemaEnumMembers(hrSchemaText, 'MissionPolicyVersionStatus');
    const hrDecision = schemaEnumMembers(hrSchemaText, 'LeaveApprovalStepDecision');
    expect(hrLifecycle.length).toBeGreaterThan(0); // non-vacuity: the joins are not empty
    expect(hrMissionLifecycle.length).toBeGreaterThan(0);
    expect(hrDecision.length).toBeGreaterThan(0);

    expect(schemaEnumMembers(schemaText, 'WorkflowDefinitionVersionStatus')).toEqual(hrLifecycle);
    expect(schemaEnumMembers(schemaText, 'WorkflowDefinitionVersionStatus')).toEqual(
      hrMissionLifecycle
    );
    expect(schemaEnumMembers(schemaText, 'WorkflowStepDecision')).toEqual(hrDecision);
  });

  it('E. the baseline is tenant-first at every level, purely additive, and names no other owner', () => {
    // Falsifiable: a hand-written constraint or index that does not lead with
    // `tenant_id`, a non-composite FK, or a destructive statement fails here.
    // No runtime check can see this: PostgreSQL enforces none of it on a
    // database that merely exists, and a tenant leak found in production is a
    // read of another tenant's purchase — the exact failure §11 forbids.
    const tables = createdTables(baselineSql);
    expect(tables.length).toBeGreaterThanOrEqual(7); // non-vacuity
    for (const table of tables) {
      const body =
        new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(baselineSql)?.[1] ?? '';
      expect({ table, tenantFirst: /"tenant_id" TEXT NOT NULL/.test(body) }).toEqual({
        table,
        tenantFirst: true,
      });
    }

    const indexes = indexStatements(baselineSql);
    expect(indexes.length).toBeGreaterThanOrEqual(15); // non-vacuity
    for (const index of indexes) {
      expect({ index, tenantFirst: index.includes('("tenant_id"') }).toEqual({
        index,
        tenantFirst: true,
      });
    }

    const foreignKeys = foreignKeyStatements(baselineSql);
    expect(foreignKeys.length).toBeGreaterThanOrEqual(6); // non-vacuity
    for (const fk of foreignKeys) {
      expect({ fk, tenantFirst: /FOREIGN KEY \("tenant_id",/.test(fk) }).toEqual({
        fk,
        tenantFirst: true,
      });
    }

    expect(baselineSql).not.toMatch(/^\s*DROP\s+/im);
    expect(baselineSql).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(baselineSql).not.toMatch(/^\s*DELETE FROM\b/im);
    expect(baselineSql).not.toMatch(/CREATE EXTENSION|dblink|postgres_fdw|CREATE FOREIGN TABLE/i);
    expect(baselineSql).not.toMatch(/core_db|hr_db|cms_db|correspondence_db|observability_db/);
    for (const owner of ['User', 'Tenant', 'Role', 'Permission', 'Employee']) {
      expect({ owner, created: new RegExp(`CREATE TABLE "${owner}"`).test(baselineSql) }).toEqual({
        owner,
        created: false,
      });
    }
  });

  it('F. no forbidden identity, credential or duplicate-RBAC shape enters the schema', () => {
    // Falsifiable: adding `model User` (or a password column) to commerce_db is
    // §7/§31's forbidden duplication — TypeScript would compile it and Prisma
    // would migrate it, so only a text scan refuses it.
    for (const model of ['User', 'Tenant', 'Role', 'Permission', 'RolePermission']) {
      expect({ model, declared: new RegExp(`^model ${model} \\{`, 'm').test(schemaText) }).toEqual({
        model,
        declared: false,
      });
    }
    // Credential-adjacent COLUMN declarations, matched on declaration shape —
    // the schema's prose is allowed to (and does) state the prohibition.
    expect(schemaText).not.toMatch(
      /^\s*\w*(?:password|secret|token|credential|apikey|hash)\w*\s+String/im
    );
  });

  it('G. the model-less accommodation is gone: the Commerce project generates WITH models', () => {
    // Falsifiable: `--allow-no-models` existed only while step D's schema had
    // no models. Reintroducing it (or emptying the schema's enums) would make
    // the client regenerate empty while every other gate still passes.
    const packageJson = JSON.parse(readFileSync(join(API_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['prisma:generate:commerce']).toContain(
      'prisma generate --schema=prisma/commerce/schema.prisma'
    );
    expect(packageJson.scripts['prisma:generate:commerce']).not.toContain('--allow-no-models');
    expect(schemaEnumNames(schemaText).length).toBeGreaterThanOrEqual(11); // non-vacuity
  });
});
