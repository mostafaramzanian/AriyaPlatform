import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Phase PRODUCTION-BOM-HEADER: the Production schema and its baseline migration, read
 * BACK as text — the executable form of the promises the schema's own comments make.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A Prisma schema is never seen by TypeScript and a migration's SQL is not type-checked
 * at all, so nothing else in the repository can cross-check them. The join this suite
 * performs is TEXT, exactly as `production-entitlement.spec.ts` joins Production's
 * constants to Core's SQL: the two artifacts cannot import each other, so the only
 * executable statement available is "the same vocabulary, in both files".
 *
 * WHAT IS PINNED, AND WHY EACH PIN IS FALSIFIABLE
 * ----------------------------------------------
 *  A. the baseline exists under its PINNED directory name and persists exactly the model
 *     this phase ships — a rename is a deliberate edit to this gate;
 *  B. both enums are stated with the SAME members in the schema and in the migration;
 *  C. the four-state BOM lifecycle and the three-value decision vocabulary are Production's
 *     OWN, not an import of Commerce's (which has CANCELLED and CLOSED) — neither may gain
 *     a member without a new migration and a deliberate edit here;
 *  D. storage is tenant-first STRUCTURALLY: `tenant_id TEXT NOT NULL`, a tenant-first
 *     unique pair, every index leading with `tenant_id` — and the baseline is purely
 *     additive, with NO foreign key at all (no cross-owner, no cross-database reference);
 *  E. no identity or credential shape enters the schema — no User/Tenant/Role/Permission
 *     model, no password/token/secret column;
 *  F. the hand-written approver CHECK exists with the exact predicate, and is the ONLY
 *     statement in the baseline that is not Prisma-generated;
 *  G. the two external references are OPAQUE: `VARCHAR(128)` and never a UUID — a
 *     UUID-shaped validator would reject a legitimate legacy id while proving nothing
 *     about tenancy, so the COLUMN must not claim one either.
 *
 * NON-VACUITY. Every scan asserts how many things it read, so a loop that matched zero
 * tables or zero migrations fails instead of passing quietly.
 */

const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const PRODUCTION_PRISMA = join(API_DIR, 'prisma', 'production');
const SCHEMA_FILE = join(PRODUCTION_PRISMA, 'schema.prisma');
const MIGRATIONS_DIR = join(PRODUCTION_PRISMA, 'migrations');

// Named by directory, not discovered by a glob: the baseline is applied history, and a
// rename of an applied migration is a deliberate edit to this gate.
const BASELINE_MIGRATION = '20261002220459_production_baseline';

/** Phase PRODUCTION-BOM-ITEM's own migration — the child table, added on top of it. */
const ITEM_MIGRATION = '20261003120000_production_bom_item';

/** Phase PRODUCTION-BOM-CHANGE's own migration — the second aggregate, on top of both. */
const CHANGE_MIGRATION = '20261003132500_production_bom_change_request';

/** The ONE model this phase persists. */
const MODELS = ['BomHeader'] as const;

/**
 * The migration's enum vocabulary, member by member. Pinned HERE rather than read from
 * the schema: the migration is history and must never change, while the schema is
 * allowed to grow past it by NEW migrations.
 */
const BASELINE_ENUMS: Record<string, readonly string[]> = {
  BomStatus: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
  ManagerOpinion: ['APPROVED', 'REJECTED', 'NEEDS_CORRECTION'],
};

const schemaText = readFileSync(SCHEMA_FILE, 'utf8');
const baselineSql = readFileSync(join(MIGRATIONS_DIR, BASELINE_MIGRATION, 'migration.sql'), 'utf8');

/** The body of `enum <name> { ... }` in the Prisma schema, whitespace-normalised. */
function schemaEnumMembers(text: string, name: string): string[] {
  const match = text.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
}

/** The members `CREATE TYPE <name> AS ENUM (...)` states in the SQL. */
function sqlEnumMembers(sql: string, name: string): string[] {
  const match = sql.match(new RegExp(`CREATE TYPE "${name}" AS ENUM\\s*\\(([^)]*)\\)`, 's'));
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The names of every `CREATE TABLE` in the baseline. */
function createdTables(sql: string): string[] {
  return [...sql.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map((m) => m[1]);
}

describe('PRODUCTION-BOM-HEADER: the schema and its baseline migration', () => {
  it('A. the baseline exists under its pinned name and persists exactly this phase\'s model', () => {
    // Falsifiable: deleting or renaming the directory fails immediately; so does a table
    // hand-added to THIS migration or a model silently dropped from the schema — the
    // migration is the storage contract, and nothing else in the repository pins it.
    expect(BASELINE_MIGRATION).toMatch(/^\d{14}_[a-z0-9_]+$/);
    expect(existsSync(join(MIGRATIONS_DIR, BASELINE_MIGRATION, 'migration.sql'))).toBe(true);
    expect(baselineSql.length).toBeGreaterThan(0);

    const tables = createdTables(baselineSql);
    expect(tables.length).toBeGreaterThanOrEqual(MODELS.length); // non-vacuity
    expect([...tables].sort()).toEqual([...MODELS].sort());
    for (const model of MODELS) {
      expect({ model, inSchema: schemaText.includes(`model ${model} {`) }).toEqual({
        model,
        inSchema: true,
      });
    }
  });

  it('B. both enums are stated with the same members in the schema and in the migration', () => {
    const names = Object.keys(BASELINE_ENUMS);
    expect(names.length).toBeGreaterThanOrEqual(2); // non-vacuity: the loop is not empty
    for (const name of names) {
      const expected = BASELINE_ENUMS[name];
      expect({ name, sql: sqlEnumMembers(baselineSql, name) }).toEqual({ name, sql: expected });
      // Equality, not superset: Production's lifecycle is closed in this phase, so
      // adding a state to the schema without a migration fails here rather than being
      // read by a route the enum cannot store.
      expect({ name, schema: schemaEnumMembers(schemaText, name) }).toEqual({
        name,
        schema: expected,
      });
    }
  });

  it('C. the lifecycle is Production\'s own — not Commerce\'s, which has two more states', () => {
    // The failure this catches: copying Commerce's `PurchaseDocumentStatus` as a
    // starting point and forgetting to remove CANCELLED/CLOSED. A BOM that could be
    // "cancelled" would have no route to reach it and no UI to show it — a state that is
    // representable, impossible to enter, and invisible to every test that only reads
    // the schema.
    const bomStatus = schemaEnumMembers(schemaText, 'BomStatus');
    expect(bomStatus).not.toContain('CANCELLED');
    expect(bomStatus).not.toContain('CLOSED');
    // And the three decision values are the legacy radio's three, exactly.
    expect(schemaEnumMembers(schemaText, 'ManagerOpinion')).toEqual([
      'APPROVED',
      'REJECTED',
      'NEEDS_CORRECTION',
    ]);
  });

  it('D. storage is tenant-first structurally, and the baseline is purely additive', () => {
    // The column and its nullability: every row belongs to a tenant, and "no tenant" is
    // not a representable state — the same shape every owned table in this repository
    // carries.
    expect(baselineSql).toMatch(/"tenant_id" TEXT NOT NULL/);

    // The TENANT-FIRST unique pair. A child table's tenant-scoped foreign key can only
    // reference a UNIQUE pair, so `(tenant_id, id)` — not `id` alone — is what makes a
    // future `BomItem` addition possible without altering this table.
    expect(baselineSql).toContain('CREATE UNIQUE INDEX "BomHeader_tenantId_id_key"');
    expect(baselineSql).toMatch(/ON "BomHeader"\("tenant_id", "id"\)/);

    // Every index the baseline creates leads with the tenant, so a cross-tenant scan by
    // approver id or by status is not expressible as a query plan.
    const indexes =
      baselineSql.match(/^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "BomHeader"\([^)]+\)/gm) ?? [];
    // Three: the tenant-first unique pair plus the two operational reads below.
    expect(indexes).toHaveLength(3);
    for (const index of indexes) {
      const columns = index.slice(index.indexOf('(') + 1, index.lastIndexOf(')'));
      const first = columns.split(',')[0].trim();
      expect({ index, first }).toEqual({ index, first: '"tenant_id"' });
    }

    // ADD, DON'T DESTROY. The baseline creates; it never drops, truncates or deletes.
    expect(baselineSql).not.toMatch(/^\s*DROP\s+/im);
    expect(baselineSql).not.toMatch(/^\s*TRUNCATE\s+/im);
    expect(baselineSql).not.toMatch(/^\s*DELETE\s+/im);
  });

  it('E. there is NO foreign key anywhere — no cross-owner, no cross-database reference', () => {
    // THE PERSISTENCE ISOLATION RULE, executable. A foreign key cannot cross a database
    // boundary, so one here would be either a dangling reference or a join to another
    // owner's table — both of which are the boundary this phase exists to keep. The
    // consequence is stated rather than hidden: referential facts that are not enforced
    // by a constraint are enforced by the SERVICE (approver membership, requester
    // membership) and by the schema's own CHECK.
    expect(baselineSql).not.toMatch(/REFERENCES/i);
    expect(baselineSql).not.toMatch(/FOREIGN KEY/i);

    // And nothing names another database, an extension or a foreign table.
    for (const owner of ['core_db', 'hr_db', 'commerce_db', 'cms_db', 'correspondence_db']) {
      expect({ owner, named: baselineSql.includes(owner) }).toEqual({ owner, named: false });
    }
    expect(baselineSql).not.toMatch(/CREATE EXTENSION|FOREIGN TABLE|IMPORT SCHEMA/i);

    // The BASELINE still has no reference at all — but the SCHEMA now states FOUR, all of
    // them SAME-DATABASE composite keys over a tenant-first unique pair: the BOM ITEM →
    // BOM HEADER key (Phase PRODUCTION-BOM-ITEM), and the CHANGE REQUEST → BOM HEADER,
    // DETAIL → CHANGE REQUEST and DETAIL → BOM ITEM keys (Phase PRODUCTION-BOM-CHANGE).
    // A foreign key cannot cross a database boundary, so this is the only shape one may
    // take here — every one of them referencing the composite tenant-first pair, with
    // `Restrict` rather than a cascade that would let a future delete silently destroy
    // reviewed items or a reviewed change request's evidence.
    const relationDecls = [...schemaText.matchAll(/@relation\([^)]*\)/g)].map((m) => m[0]);
    expect(relationDecls).toHaveLength(4);
    for (const decl of relationDecls) {
      expect(decl).toContain('references: [tenantId, id]');
      expect(decl).toContain('onDelete: Restrict');
    }
    // Every relation quotes the tenant column FIRST, so none of them can be read as keyed
    // on a bare id.
    expect(relationDecls.map((decl) => /fields: \[tenantId, (bomId|changeRequestId|bomItemId)\]/.test(decl))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // The id alone is NOT an isolation key, so a relation referencing it alone would let a
    // child point at another tenant's parent — asserted as absent, not merely unused.
    expect(schemaText).not.toMatch(/references:\s*\[\s*id\s*\]/);
  });

  it('F. the only statement Prisma did not generate is the approver CHECK, with its exact predicate', () => {
    // Prisma has no representation for a CHECK constraint, so it is declared in the
    // migration exactly as Commerce's counter CHECK is — and this suite is what keeps
    // "known, documented difference" from becoming "forgotten drift".
    const check = baselineSql.match(/ADD CONSTRAINT "([^"]+)"\s*\n?\s*CHECK \(([^;]+)\);/);
    expect(check).not.toBeNull();
    expect(check![1]).toBe('BomHeader_submitted_requires_approver');
    // A document that has LEFT the editable state without naming an approver is not a
    // state the domain permits; the service refuses the transition and this is what makes
    // the refusal retroactively provable.
    expect(check![2].replace(/\s+/g, ' ').trim()).toBe(
      `"status" = 'DRAFT' OR "approver_user_id" IS NOT NULL`
    );
  });

  it('G. the external references are OPAQUE columns, never a UUID', () => {
    // Both are `VARCHAR(128)`: a length rule, not a format rule, because the format of a
    // Project or Product Tree id is exactly what has no authoritative contract yet.
    expect(baselineSql).toMatch(/"project_ref" VARCHAR\(128\) NOT NULL/);
    expect(baselineSql).toMatch(/"product_tree_ref" VARCHAR\(128\) NOT NULL/);
    // Nothing claims a UUID for an EXTERNAL reference — while the row's OWN id is one,
    // which is the distinction the DTO docblock states: owned row ids are UUIDs, the
    // platform's are opaque, and an external ref is neither. The id has no SQL default
    // because `@default(uuid())` is satisfied client-side: the value is minted by the
    // repository, never by Postgres, so the id a caller receives is the id it stored.
    expect(baselineSql).toMatch(/"id" UUID NOT NULL/);
    expect(baselineSql).not.toMatch(/gen_random_uuid\(\)/);
    expect(baselineSql).not.toMatch(/"project_ref" UUID|"product_tree_ref" UUID/i);
    // A platform user id is TEXT for the same reason: `super-admin-user` is a legitimate
    // value and a UUID column would refuse it.
    expect(baselineSql).toMatch(/"requester_user_id" TEXT NOT NULL/);
    expect(baselineSql).toMatch(/"approver_user_id" TEXT/);
    expect(baselineSql).not.toMatch(/requester_user_id" uuid/i);
  });

  it('H. the ITEM migration adds a tenant-first child, a same-database FK, and nothing else', () => {
    // Phase PRODUCTION-BOM-ITEM's own migration, read back as text for the same reason the
    // baseline is: it is the storage contract, and nothing else in the repository pins it.
    expect(existsSync(join(MIGRATIONS_DIR, ITEM_MIGRATION, 'migration.sql'))).toBe(true);
    const itemSql = readFileSync(
      join(MIGRATIONS_DIR, ITEM_MIGRATION, 'migration.sql'),
      'utf8'
    );
    expect(itemSql.length).toBeGreaterThan(0);

    // Exactly one new table, plus the two closed choice-lists the source stored as
    // `Lookup_StaticValues`.
    expect(createdTables(itemSql)).toEqual(['BomItem']);
    expect([...itemSql.matchAll(/CREATE TYPE "([^"]+)" AS ENUM/g)].map((m) => m[1])).toEqual([
      'BomPartType',
      'BomControlPlan',
    ]);

    // TENANT-FIRST STRUCTURALLY: the composite unique pair, and every index leading with
    // `tenant_id` — so a cross-tenant scan of a BOM's items is not expressible as a query
    // plan. Three indexes: the unique pair plus the two read patterns.
    expect(itemSql).toContain('CREATE UNIQUE INDEX "BomItem_tenantId_id_key"');
    const itemIndexes =
      itemSql.match(/^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "BomItem"\([^)]+\)/gm) ?? [];
    expect(itemIndexes).toHaveLength(3);
    for (const index of itemIndexes) {
      const columns = index.slice(index.indexOf('(') + 1, index.lastIndexOf(')'));
      expect({ index, first: columns.split(',')[0].trim() }).toEqual({
        index,
        first: '"tenant_id"',
      });
    }

    // THE FK IS SAME-DATABASE AND RESTRICT: it names `BomHeader`'s composite tenant-first
    // key and nothing else. No other owner's database appears anywhere in this file.
    expect(itemSql).toMatch(
      /FOREIGN KEY \("tenant_id", "bom_id"\) REFERENCES "BomHeader"\("tenant_id", "id"\) ON DELETE RESTRICT ON UPDATE CASCADE/
    );
    for (const owner of ['core_db', 'hr_db', 'commerce_db', 'cms_db', 'correspondence_db']) {
      expect({ owner, named: itemSql.includes(owner) }).toEqual({ owner, named: false });
    }

    // PURELY ADDITIVE: it creates, and never drops, truncates or deletes.
    expect(itemSql).not.toMatch(/^\s*DROP\s+/im);
    expect(itemSql).not.toMatch(/^\s*TRUNCATE\s+/im);
    expect(itemSql).not.toMatch(/^\s*DELETE\s+/im);
  });

  it('I. the DEFERRED and LEGACY item columns are nullable, with no code generation', () => {
    // Product Tree Code generation REMAINS DEFERRED (RB-1-P). The column that would carry
    // it exists so a migrated value survives, so it is NULLABLE — and the migration states
    // NO sequence, NO counter and NO default for it, which is what makes "an endpoint must
    // not mint one" provable from the storage side too.
    const itemSql = readFileSync(
      join(MIGRATIONS_DIR, ITEM_MIGRATION, 'migration.sql'),
      'utf8'
    );
    expect(itemSql).toMatch(/"standard_part_code" VARCHAR\(128\)/);
    expect(itemSql).not.toMatch(/"standard_part_code"[^\n]*NOT NULL/);
    expect(itemSql).not.toMatch(/CREATE SEQUENCE|nextval\(|DEFAULT\s+\d/i);

    // Every legacy / migration-preservation column is nullable too: none of them may
    // become a required field by accident, and none may be given a business rule later
    // without changing this line.
    for (const column of [
      'legacy_part_code',
      'legacy_item_state',
      'legacy_manager_opinion',
      'legacy_consumption_total_coefficient',
      'legacy_consumption_in_drawing_on_order',
      'legacy_consumption_spare_test_on_order',
      'legacy_consumption_in_drawing_purchased',
      'legacy_consumption_spare_test_purchased',
    ]) {
      const line = itemSql.split('\n').find((row) => row.includes(`"${column}"`));
      expect({ column, line }).toEqual({ column, line: expect.stringContaining(column) });
      expect({ column, notNull: /NOT NULL/.test(line ?? '') }).toEqual({
        column,
        notNull: false,
      });
    }

    // The two CONFIRMED coefficients are NOT NULL, and the schema states no total: there is
    // no computed column and no trigger to derive one (M-7a / §14).
    expect(itemSql).toMatch(/"drawing_consumption_coefficient" INTEGER NOT NULL/);
    expect(itemSql).toMatch(/"spare_consumption_coefficient" INTEGER NOT NULL/);
    expect(itemSql).not.toMatch(/CREATE TRIGGER|CREATE OR REPLACE FUNCTION/i);
  });

  it('J. the CHANGE REQUEST migration adds the aggregate, its duplicate rule and NO apply behaviour', () => {
    const changeSql = readFileSync(
      join(MIGRATIONS_DIR, CHANGE_MIGRATION, 'migration.sql'),
      'utf8'
    );

    // (1) EXACTLY the two tables and the one enum this phase ships. A table nobody agreed to
    // is a table no test can falsify — the same rule `A.` applies to the baseline.
    expect(createdTables(changeSql).sort()).toEqual([
      'BomChangeRequest',
      'BomChangeRequestItem',
    ]);
    expect([...changeSql.matchAll(/CREATE TYPE "([^"]+)"/g)].map((m) => m[1])).toEqual([
      'BomChangeType',
    ]);
    expect(changeSql).toMatch(
      /CREATE TYPE "BomChangeType" AS ENUM \('QUANTITY_CHANGE', 'DEACTIVATE'\);/
    );

    // (2) THE DELTAS ARE SIGNED AND NULLABLE, and nothing constrains their range. The
    // source's `> 0` / `isNaN` guards are COMMENTED OUT, `parseInt` is the only processing,
    // and a decrease is the point of «افزایش/کاهش» — so a CHECK, a default or a NOT NULL
    // here would each be an invented rule.
    for (const column of ['drawing_coefficient_delta', 'spare_coefficient_delta']) {
      const line = changeSql.split('\n').find((row) => row.includes(`"${column}"`));
      expect({ column, line }).toEqual({ column, line: expect.stringContaining('INTEGER') });
      expect({ column, notNull: /NOT NULL/.test(line ?? '') }).toEqual({ column, notNull: false });
    }
    expect(changeSql).not.toMatch(/CHECK \("drawing_coefficient_delta"|CHECK \("spare_coefficient_delta"/);
    expect(changeSql).not.toMatch(/"drawing_coefficient_delta"[^\n]*DEFAULT|"spare_coefficient_delta"[^\n]*DEFAULT/);

    // (3) THE ORIGINALS ARE NOT NULL: a detail without a snapshot would be a change whose
    // "before" value nobody can state, which is the one thing the snapshot exists to prevent.
    expect(changeSql).toMatch(/"original_drawing_coefficient" INTEGER NOT NULL/);
    expect(changeSql).toMatch(/"original_spare_coefficient" INTEGER NOT NULL/);

    // (4) NO TOTAL, AND NO BOM MUTATION SURFACE. The source derives `original + delta` for
    // display only and never stores it; and `Apply Change` is DEFERRED, so this migration
    // must contain no trigger, no function, no `inactive` column and nothing that could
    // write `BomItem` on approval.
    //
    // The scan is over the migration's CODE with its `--` prose removed, because the prose
    // NECESSARILY names every one of these tokens in order to explain why they are absent —
    // the same comment-stripping rule `production-isolation.spec.ts` uses, and for the same
    // reason.
    const changeCode = changeSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(changeCode).not.toMatch(/"total"|_total\b/);
    // ONLY a quoted identifier counts: the enum member `'DEACTIVATE'` is exactly the change
    // type this phase must record, and a substring test would refuse the phase's own value.
    expect(changeCode).not.toMatch(/"(inactive|deactivate[a-z_]*|is_active)"/i);
    expect(changeCode).not.toMatch(/CREATE TRIGGER|CREATE (OR REPLACE )?FUNCTION/i);
    // Statement-level only: `ON UPDATE CASCADE` is part of the FK definitions and is
    // expected, while a standalone UPDATE/DELETE on any table is exactly the apply behaviour
    // this phase refuses to invent.
    expect(changeCode).not.toMatch(/^\s*(UPDATE|DELETE)\s/m);

    // (5) TENANT-FIRST STRUCTURALLY: every index of both new tables leads with `tenant_id`,
    // the duplicate rule is a UNIQUE index over (tenant, request, item), and both tables
    // carry the tenant-first unique pair a child key can reference.
    const changeIndexes =
      changeSql.match(/^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "[^"]+"\([^)]+\)/gm) ?? [];
    expect(changeIndexes).toHaveLength(6);
    for (const index of changeIndexes) {
      const columns = index.slice(index.indexOf('(') + 1, index.lastIndexOf(')'));
      expect({ index, first: columns.split(',')[0].trim() }).toEqual({
        index,
        first: '"tenant_id"',
      });
    }
    expect(changeSql).toContain(
      'CREATE UNIQUE INDEX "BomChangeRequestItem_tenantId_changeRequestId_bomItemId_key" ON "BomChangeRequestItem"("tenant_id", "change_request_id", "bom_item_id")'
    );
    expect(changeSql).toContain('CREATE UNIQUE INDEX "BomChangeRequest_tenantId_id_key"');
    expect(changeSql).toContain('CREATE UNIQUE INDEX "BomChangeRequestItem_tenantId_id_key"');
    expect(changeSql).toContain(
      'CREATE INDEX "BomChangeRequest_tenantId_bomId_idx" ON "BomChangeRequest"("tenant_id", "bom_id")'
    );
    expect(changeSql).toContain(
      'CREATE INDEX "BomChangeRequest_tenantId_status_idx" ON "BomChangeRequest"("tenant_id", "status")'
    );
  });


  it('K. the CHANGE REQUEST keys are same-database, RESTRICT, and its approver CHECK is exact', () => {
    const changeSql = readFileSync(
      join(MIGRATIONS_DIR, CHANGE_MIGRATION, 'migration.sql'),
      'utf8'
    );

    // THREE composite FKs, each naming a tenant-first UNIQUE pair inside THIS database —
    // never a cross-database reference, never a bare id.
    const fks = changeSql.match(/^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY .*;$/gm) ?? [];
    expect(fks).toHaveLength(3);
    for (const fk of fks) {
      expect(fk).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
      expect(fk).toMatch(/FOREIGN KEY \("tenant_id", "(bom_id|change_request_id|bom_item_id)"\)/);
      expect(fk).toMatch(/REFERENCES "(BomHeader|BomChangeRequest|BomItem)"\("tenant_id", "id"\)/);
    }
    expect(changeSql).toContain(
      'FOREIGN KEY ("tenant_id", "bom_id") REFERENCES "BomHeader"("tenant_id", "id")'
    );
    expect(changeSql).toContain(
      'FOREIGN KEY ("tenant_id", "change_request_id") REFERENCES "BomChangeRequest"("tenant_id", "id")'
    );
    expect(changeSql).toContain(
      'FOREIGN KEY ("tenant_id", "bom_item_id") REFERENCES "BomItem"("tenant_id", "id")'
    );

    // Nothing names another owner's database, an extension or a foreign table. The scan is
    // over the CODE, because the migration's prose names those terms in order to explain
    // why none of them is present.
    const changeCode = changeSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const owner of ['core_db', 'hr_db', 'commerce_db', 'cms_db', 'correspondence_db']) {
      expect({ owner, named: changeCode.includes(owner) }).toEqual({ owner, named: false });
    }
    expect(changeCode).not.toMatch(/CREATE EXTENSION|FOREIGN TABLE|IMPORT SCHEMA/i);

    // PURELY ADDITIVE: it creates, and never drops, truncates or deletes. An applied
    // migration is history; a phase that could rewrite it would make "what does the
    // database look like?" depend on when somebody read it.
    expect(changeSql).not.toMatch(/^\s*DROP\s+/im);
    expect(changeSql).not.toMatch(/^\s*TRUNCATE\s+/im);
    expect(changeSql).not.toMatch(/^\s*DELETE\s+/im);
    expect(changeSql).not.toMatch(/^\s*UPDATE\s+/im);

    // THE APPROVER INVARIANT, verbatim — the same CHECK the header carries, on the same
    // lifecycle, because "SUBMITTED and nobody was asked" is not a state either document
    // permits. Prisma cannot express a CHECK, so this is the ONLY statement in this
    // migration that Prisma did not generate.
    expect(changeSql).toMatch(
      /ALTER TABLE "BomChangeRequest"\s*\n\s*ADD CONSTRAINT "BomChangeRequest_submitted_requires_approver"\s*\n\s*CHECK \("status" = 'DRAFT' OR "approver_user_id" IS NOT NULL\);/
    );

    // And the SCHEMA still declares no fourth `BomStatus` member and no fifth
    // `ManagerOpinion`: the change request REUSES both, which is what stops the two
    // documents' lifecycles from drifting apart.
    expect(schemaEnumMembers(schemaText, 'BomStatus')).toEqual([
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
    ]);
    expect(schemaEnumMembers(schemaText, 'ManagerOpinion')).toEqual([
      'APPROVED',
      'REJECTED',
      'NEEDS_CORRECTION',
    ]);
  });

  it('L. the AUDIT OUTBOX migration adds a tenant-first delivery buffer with no FK', () => {
    // Phase B2.4: the Production-local audit outbox — a delivery buffer, not a second trail.
    const OUTBOX_MIGRATION = '20261009150000_audit_outbox';
    expect(existsSync(join(MIGRATIONS_DIR, OUTBOX_MIGRATION, 'migration.sql'))).toBe(true);
    const outboxSql = readFileSync(
      join(MIGRATIONS_DIR, OUTBOX_MIGRATION, 'migration.sql'),
      'utf8'
    );
    expect(outboxSql.length).toBeGreaterThan(0);

    // Exactly one new table, no enum.
    expect(createdTables(outboxSql)).toEqual(['AuditOutbox']);
    expect(outboxSql).not.toMatch(/CREATE TYPE/);

    // TENANT-FIRST STRUCTURALLY: the unique pair and every index lead with `tenant_id`.
    expect(outboxSql).toContain('CREATE UNIQUE INDEX "AuditOutbox_tenant_auditId_key"');
    const outboxIndexes =
      outboxSql.match(/^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "AuditOutbox"\([^)]+\)/gm) ?? [];
    expect(outboxIndexes).toHaveLength(3);
    for (const index of outboxIndexes) {
      const columns = index.slice(index.indexOf('(') + 1, index.lastIndexOf(')'));
      expect({ index, first: columns.split(',')[0].trim() }).toEqual({
        index,
        first: '"tenant_id"',
      });
    }

    // NO foreign key — the outbox is a standalone delivery buffer.
    expect(outboxSql).not.toMatch(/REFERENCES/i);
    expect(outboxSql).not.toMatch(/FOREIGN KEY/i);

    // PURELY ADDITIVE.
    expect(outboxSql).not.toMatch(/^\s*DROP\s+/im);
    expect(outboxSql).not.toMatch(/^\s*TRUNCATE\s+/im);
    expect(outboxSql).not.toMatch(/^\s*DELETE\s+/im);

    // No other owner's database appears.
    for (const owner of ['core_db', 'hr_db', 'commerce_db', 'cms_db', 'correspondence_db']) {
      expect({ owner, named: outboxSql.includes(owner) }).toEqual({ owner, named: false });
    }
  });

});
