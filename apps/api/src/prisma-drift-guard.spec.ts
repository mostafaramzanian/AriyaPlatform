import * as fs from 'fs';
import * as path from 'path';
import { DATASOURCE_OWNERS } from './runtime-datasources';

/**
 * Phase POST-SMOKE: guard against the exact runtime failure observed in
 * Phase Live Runtime & E2E Smoke Verification:
 *
 *   Migration added 'FINANCIAL' to the PostgreSQL enum, but the Prisma schema
 *   omitted it. The generated Prisma client therefore rejected rows with that
 *   value at runtime, causing login/permission resolution to 500.
 *
 * This spec turns that class of drift into a failing test BEFORE the code
 * reaches a running container.
 *
 * It compares, for every implemented datasource owner:
 *   - enum declarations in the Prisma schema
 *   - the effective enum state derived from the migration history
 *     (CREATE TYPE baseline + ALTER TYPE ADD VALUE additions in migration order)
 *   - enum objects emitted by the generated Prisma client
 *
 * Any mismatch is reported as a concrete diff so the fix is obvious.
 */

const apiRoot = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

type EnumMap = Record<string, string[]>;

function parseSchemaEnums(schemaPath: string): EnumMap {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema not found: ${schemaPath}`);
  }
  const source = read(schemaPath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const enums: EnumMap = {};
  const regex = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    const values = match[2]
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    enums[name] = values;
  }
  return enums;
}

function parseMigrationEnums(migrationsDir: string): EnumMap {
  const enums: EnumMap = {};
  if (!fs.existsSync(migrationsDir)) return enums;

  const dirs = fs
    .readdirSync(migrationsDir)
    .filter((name) => fs.statSync(path.join(migrationsDir, name)).isDirectory())
    .sort();

  for (const dir of dirs) {
    const sqlPath = path.join(migrationsDir, dir, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const sql = read(sqlPath);

    // Baseline: CREATE TYPE "EnumName" AS ENUM ('A', 'B');
    const createRegex = /CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM\s*\(([\s\S]*?)\);/gi;
    let cm: RegExpExecArray | null;
    while ((cm = createRegex.exec(sql)) !== null) {
      const name = cm[1];
      const values = cm[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^['"]|['"]$/g, ''));
      enums[name] = values;
    }

    // Additions: ALTER TYPE "EnumName" ADD VALUE [IF NOT EXISTS] 'X';
    const alterRegex = /ALTER\s+TYPE\s+"([^"]+)"\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
    let am: RegExpExecArray | null;
    while ((am = alterRegex.exec(sql)) !== null) {
      const [, name, value] = am;
      const list = (enums[name] = enums[name] ?? []);
      if (!list.includes(value)) list.push(value);
    }
  }

  return enums;
}

function parseGeneratedEnums(clientIndexPath: string): EnumMap {
  if (!fs.existsSync(clientIndexPath)) {
    throw new Error(
      `generated client index not found: ${clientIndexPath} — run prisma:generate first`
    );
  }
  const source = read(clientIndexPath);
  const enums: EnumMap = {};
  // exports.EnumName = exports.$Enums.EnumName = { ... };
  const regex = /exports\.(\w+) = exports\.\$Enums\.\w+ = \{([\s\S]*?)\n\};/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    const keys = match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(':')[0].trim())
      .filter(Boolean);
    enums[name] = keys;
  }
  return enums;
}

function symmetricDifference(a: string[], b: string[]): string[] {
  const setA = new Set(a);
  const setB = new Set(b);
  return [
    ...a.filter((v) => !setB.has(v)),
    ...b.filter((v) => !setA.has(v)),
  ];
}

const implementedOwners = Object.values(DATASOURCE_OWNERS).filter(
  (owner) => owner.status === 'implemented'
);

describe('Prisma enum drift guard', () => {
  it('covers at least one implemented owner', () => {
    expect(implementedOwners.length).toBeGreaterThanOrEqual(1);
  });

  for (const owner of implementedOwners) {
    describe(`owner: ${owner.owner}`, () => {
      const schemaPath = path.join(apiRoot, owner.prismaSchema);
      const migrationsDir = path.join(apiRoot, owner.migrationRoot);
      const clientIndexPath = path.join(
        apiRoot,
        'src',
        'generated',
        owner.generatedClientDir,
        'index.js'
      );

      const schemaEnums = parseSchemaEnums(schemaPath);
      const migrationEnums = parseMigrationEnums(migrationsDir);
      const generatedEnums = parseGeneratedEnums(clientIndexPath);

      it('schema enum declarations match the effective migration history', () => {
        const mismatches: string[] = [];
        const allEnumNames = new Set([
          ...Object.keys(schemaEnums),
          ...Object.keys(migrationEnums),
        ]);

        for (const name of allEnumNames) {
          const schemaValues = schemaEnums[name] ?? [];
          const migrationValues = migrationEnums[name] ?? [];

          if (schemaValues.length === 0) {
            mismatches.push(
              `${name}: declared by migrations but missing from schema (value(s): ${migrationValues.join(', ')})`
            );
            continue;
          }
          if (migrationValues.length === 0) {
            mismatches.push(
              `${name}: declared by schema but missing from migrations`
            );
            continue;
          }

          const diff = symmetricDifference(schemaValues, migrationValues);
          if (diff.length > 0) {
            mismatches.push(
              `${name}: schema=[${schemaValues.join(', ')}] migrations=[${migrationValues.join(', ')}] diff=[${diff.join(', ')}]`
            );
          }
        }

        expect(mismatches).toEqual([]);
      });

      it('generated Prisma client enum objects match the schema', () => {
        const mismatches: string[] = [];

        for (const [name, schemaValues] of Object.entries(schemaEnums)) {
          const generatedValues = generatedEnums[name];
          if (!generatedValues) {
            mismatches.push(
              `${name}: missing from generated client (${owner.generatedClientDir}/index.js)`
            );
            continue;
          }

          const diff = symmetricDifference(schemaValues, generatedValues);
          if (diff.length > 0) {
            mismatches.push(
              `${name}: schema=[${schemaValues.join(', ')}] generated=[${generatedValues.join(', ')}] diff=[${diff.join(', ')}]`
            );
          }
        }

        expect(mismatches).toEqual([]);
      });
    });
  }
});
