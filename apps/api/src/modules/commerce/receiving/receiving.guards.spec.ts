import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase C1 Step R (§5.16, contract R1–R9; §3-E, §3-F, §3-G; §14.3; §21): the
 * receiving slice read BACK as text — the executable form of the promises its
 * five files state in their own headers, and the mirror of
 * `workflow-execution.guards.spec.ts`/`workflow-configuration.repository.spec.ts`
 * for a slice this small.
 *
 * WHAT IS PINNED HERE, AND WHY EACH PIN IS FALSIFIABLE
 * ---------------------------------------------------
 *  A. the slice is exactly R's five files (a sixth is a deliberate edit to this
 *     gate, never a drive-by addition);
 *  B. APPEND-ONLY, structurally: no `update`/`updateMany`/`delete`/`deleteMany`/
 *     `upsert` anywhere in the slice, no raw write, and the only write is one
 *     nested `receipt.create` — a correction is a NEW row, never an edit (R4);
 *  C. the concurrency hinge is exactly ONE raw statement: a tenant-scoped
 *     `SELECT … FOR UPDATE` on `PurchaseDocument`, and it is taken on BOTH write
 *     paths before the history read it exists to serialize (§3-H, §22);
 *  D. the transaction boundary stays in the persistence layer:
 *     `unwrapCommerceTransaction`/`Prisma.TransactionClient` appear only in the
 *     repository, while the service names the port `CommerceUnitOfWork` and
 *     nothing else — no file of this slice can hold a client;
 *  E. no other slice's table, gateway or platform port is reached from here:
 *     receiving is an INDEPENDENT lifecycle (R6, §3-I);
 *  F. the controller wires exactly THREE routes — one GET and two POSTs, NO
 *     `@Patch`/`@Put`/`@Delete` — with `commerce.read`/`commerce.manage` and no
 *     receiving-specific permission (R7, R8), roles on every route, and the
 *     entitlement guard OUTSIDE the JWT guard;
 *  G. `CommerceModule` provides the repository and the service, registers the
 *     controller, and exports NONE of them (the module's published surface is
 *     unchanged);
 *  H. migration `20260929000003_receiving_foundation` is ADDITIVE and
 *     tenant-first: exactly two tables, every index leading with `tenant_id`,
 *     every foreign key composite, nothing else touched and no drift repaired;
 *  I. every table and column the migration creates is a model and a mapped field
 *     of `schema.prisma` — the join no compiler performs.
 *
 * NON-VACUITY. Every scan carries a floor, and K hands each scan a PLANTED
 * defect and requires it to be refused — a guard that cannot fail is a comment.
 *
 * NOT PINNED HERE, DELIBERATELY. Tenant-first parameters, one-unit-of-work per
 * write, the lock's PRECEDENCE over the SUM read and the repository's exact
 * surface are already asserted against the fakes in
 * `receiving-history.service.spec.ts`; the module-wide gateway and no-second-
 * audit-trail gates are `commerce-gateways.spec.ts`'s. This file reads the FILES
 * — the claims no compiler, no runtime and no fake can fail.
 */

const SLICE_DIR = __dirname;
const MODULE_DIR = join(__dirname, '..');
const API_DIR = join(MODULE_DIR, '..', '..', '..');
const SCHEMA_FILE = join(API_DIR, 'prisma', 'commerce', 'schema.prisma');
const MODULE_FILE = join(MODULE_DIR, 'commerce.module.ts');
const MIGRATION_SQL_FILE = join(
  API_DIR,
  'prisma',
  'commerce',
  'migrations',
  '20260929000003_receiving_foundation',
  'migration.sql'
);

/** Every TypeScript file in the slice, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const sliceFiles = walk(SLICE_DIR);
const sliceSources = sliceFiles.filter((file) => !file.endsWith('.spec.ts'));
const sliceName = (file: string) => relative(SLICE_DIR, file).replace(/\\/g, '/');

/** The five files R ships, pinned by NAME rather than discovered. */
const SLICE_SOURCES = [
  'receiving-history.controller.ts',
  'receiving-history.repository.ts',
  'receiving-history.service.ts',
  'receiving-status.ts',
  'receiving.dto.ts',
];

/**
 * Comment lines dropped before scanning, and trailing `//` comments stripped
 * (the workflow guards' helpers, duplicated rather than shared because a common
 * test helper would be a third file every guard's parsing had to agree with):
 * the repository's header NAMES `$queryRaw` and `PurchaseDocument` to explain
 * what it owns, and deleting those sentences to satisfy a scan would delete the
 * explanation, not a defect.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  );
}

/** One line with a TRAILING comment removed, quotes respected. */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '/' && line[index + 1] === '/') {
      return line.slice(0, index);
    }
  }
  return line;
}

/** A file's CODE: no comment-only lines, no trailing `//` comments. */
const codeOf = (source: string) =>
  source
    .split('\n')
    .filter((line) => line.trim().length > 0 && !isCommentLine(line))
    .map(stripLineComment)
    .join('\n');

/** SQL comment lines dropped — a migration's prose may name what it must not do. */
const sqlCode = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const readNamed = (file: string) => readFileSync(file, 'utf8');
const codeNamed = (basename: string) => codeOf(readNamed(join(SLICE_DIR, basename)));
/** Every mutating ORM operation a file asks for — the append-only ban. */
function mutatingCalls(code: string): string[] {
  return [...code.matchAll(/\.(?:update|updateMany|delete|deleteMany|upsert)\s*\(/g)].map((match) =>
    match[0].trim()
  );
}

/** Every raw statement that WRITES — the repository's one raw call may only read. */
function rawWrites(code: string): string[] {
  return [...code.matchAll(/\$(?:executeRaw|queryRawUnsafe|executeRawUnsafe)\b/g)].map(
    (match) => match[0]
  );
}

/** The routes a controller declares, and any decorator that would mutate or erase. */
function routesOf(code: string) {
  return {
    gets: [...code.matchAll(/@Get\([^)]*\)/g)].map((match) => match[0]),
    posts: [...code.matchAll(/@Post\([^)]*\)/g)].map((match) => match[0]),
    forbidden: [...code.matchAll(/@(?:Patch|Put|Delete|Head|Options)\([^)]*\)/g)].map(
      (match) => match[0]
    ),
  };
}

/** The entries of one `key: [ … ]` array inside a `@Module({ … })` decorator. */
function decoratorArray(source: string, key: string): string[] {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(codeOf(source));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The names of `class X` / `export class X` / `export interface X` declared by a file. */
const declaredClasses = (code: string) =>
  [...code.matchAll(/export class (\w+)/g)].map((match) => match[1]);

/** The transaction-boundary names only the persistence layer may hold. */
const CLIENT_NAMES = /\bunwrapCommerceTransaction\b|Prisma\.TransactionClient/;

/**
 * Another slice's tables, services and the platform ports this slice must not
 * reach — the Prisma model name AND the camelCase delegate the generated client
 * exposes (`PaymentRecord`/`paymentRecord`), because a statement reaches the
 * delegate and a scan that knew only one spelling could be walked around.
 */
const FOREIGN_NAMES =
  /\b(?:PaymentRecord|paymentRecord|PaymentHistoryRepository|WorkflowInstance|workflowInstance|WorkflowStepInstance|workflowStepInstance|WorkflowDefinitionVersion|workflowDefinitionVersion|WorkflowStep|workflowStep|CommercialLifecycle|commercialLifecycle|CommerceIdentityGateway|USER_DIRECTORY|AUDIT_PORT|NotificationPublisher|PureRuleEngine|RuleEngine|evaluateRule)\b|HrPrismaService|generated\/prisma-(?:core|hr|finance)/;

describe('C1 step R: the receiving slice’s boundaries, read back as text (§5.16, §3-E, §3-F, §3-H)', () => {
  it('A. is exactly R’s five files — a sixth is a deliberate edit to this gate', () => {
    expect(sliceSources.map(sliceName).sort()).toEqual([...SLICE_SOURCES].sort());
    // Non-vacuity: the walk found the slice, and the guard files are excluded by suffix.
    expect(sliceFiles.length).toBeGreaterThan(sliceSources.length);
    for (const file of sliceFiles) expect(file.endsWith('.ts')).toBe(true);
  });

  it('B. is APPEND-ONLY: no update, no delete, no upsert and no raw write anywhere (R4)', () => {
    const mutating = sliceSources
      .flatMap((file) => mutatingCalls(codeOf(readNamed(file))))
      .filter((call) => call.length > 0);
    expect(mutating).toEqual([]);

    const raw = sliceSources
      .flatMap((file) => rawWrites(codeOf(readNamed(file))))
      .filter((call) => call.length > 0);
    expect(raw).toEqual([]);

    const repository = codeNamed('receiving-history.repository.ts');
    // Non-vacuity: the slice DOES write — one nested create, and reads of its own tables.
    expect(repository).toMatch(/receipt\.create\(/);
    expect(repository).toMatch(/receiptLine\.findFirst\(/);
    expect(repository).toMatch(/receipt\.findMany\(/);
    // And the correction is expressible only as another create: the compensating
    // row is a NEW `Receipt` whose line names the target, never an edit of it.
    expect(repository).not.toMatch(/reversesReceiptLineId:\s*\{\s*set:/);
  });

  it('C. takes the lock through ONE tenant-scoped raw `FOR UPDATE`, before the SUM it judges (§3-H)', () => {
    const repository = codeNamed('receiving-history.repository.ts');
    const rawCalls = [...repository.matchAll(/\$queryRaw\b/g)];
    expect(rawCalls).toHaveLength(1);

    // The statement is the DOCUMENT row of THIS tenant, unlocked by no one else.
    const statement = repository.slice(
      repository.indexOf('$queryRaw'),
      repository.indexOf('$queryRaw') + 400
    );
    expect(statement).toContain('SELECT "id" FROM "PurchaseDocument"');
    expect(statement).toContain('WHERE "tenant_id" =');
    expect(statement).toContain('FOR UPDATE');

    // No other file of the slice opens a raw statement at all.
    const others = sliceSources
      .filter((file) => sliceName(file) !== 'receiving-history.repository.ts')
      .filter((file) => /\$queryRaw|\$executeRaw/.test(codeOf(readNamed(file))))
      .map(sliceName);
    expect(others).toEqual([]);

    // The LOCK is read by both writes, and by a plain row read nowhere else.
    const service = codeNamed('receiving-history.service.ts');
    expect(service.match(/lockDocumentForReceipt\(/g) ?? []).toHaveLength(2);
  });

  it('D. keeps the transaction boundary in the persistence layer (commerce-transaction.ts)', () => {
    // The repository receives a HANDLE and unwraps it; the service receives the
    // PORT and calls `run`. Anywhere else holding a client would be the erosion
    // `commerce-transaction.ts` names.
    const offenders = sliceSources
      .filter((file) => !file.endsWith('.repository.ts'))
      .filter((file) => CLIENT_NAMES.test(codeOf(readNamed(file))))
      .map(sliceName);
    expect(offenders).toEqual([]);

    // Non-vacuity: the pattern fires where the client legitimately lives, and the
    // service names the port — not a client — as its third dependency.
    expect(codeNamed('receiving-history.repository.ts')).toMatch(/\bunwrapCommerceTransaction\(/);
    expect(codeNamed('receiving-history.service.ts')).toMatch(/\bCommerceUnitOfWork\b/);
  });
});

/**
 * The remaining scans: independence, the controller's route boundary, the
 * module registration, the migration and the schema join. Split from A–D only
 * because the file grew in two sittings — each block still states one claim.
 */
describe('C1 step R: the receiving slice’s remaining boundaries (§3-F, §3-I, R6–R8)', () => {
  it('E. names no other slice’s table, no other gateway and no platform port (R6, §3-I)', () => {
    const offenders = sliceSources
      .filter((file) => FOREIGN_NAMES.test(codeOf(readNamed(file))))
      .map(sliceName);
    expect(offenders).toEqual([]);

    // Non-vacuity: the slice DOES name its own resources and its own gateway.
    expect(codeNamed('receiving-history.service.ts')).toMatch(/CommerceAuditGateway/);
    expect(codeNamed('receiving-history.repository.ts')).toMatch(/CommercePrismaService/);
  });

  it('F. wires exactly THREE routes — one GET, two POSTs, and no PATCH/PUT/DELETE (R7, R8)', () => {
    const controller = codeNamed('receiving-history.controller.ts');
    const routes = routesOf(controller);

    expect(routes.gets).toEqual(["@Get(':id/receipts')"]);
    expect(routes.posts).toEqual([
      "@Post(':id/receipts')",
      "@Post(':id/receipts/:receiptLineId/compensate')",
    ]);
    expect(routes.forbidden).toEqual([]);
    // The controller path is the DOCUMENT's, deliberately: a receipt has no
    // meaning apart from the document it receives against.
    expect(controller).toContain("@Controller('commerce/purchase-documents')");

    // No DTO for an update or a delete exists either: three payload classes, of
    // which one is the nested line.
    expect(declaredClasses(codeNamed('receiving.dto.ts')).sort()).toEqual(
      ['CompensateReceiptLineDto', 'CreateReceiptDto', 'ReceiptLineInputDto'].sort()
    );

    // Permissions: one read, two writes — a receiving-specific permission is NOT
    // created (R8), and the module's `commerce.*` names are untouched.
    expect([...controller.matchAll(/Permissions\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(
      ['COMMERCE_MANAGE', 'COMMERCE_MANAGE', 'COMMERCE_READ']
    );
    const constants = codeOf(readNamed(join(MODULE_DIR, 'commerce.constants.ts')));
    expect(constants).not.toMatch(/COMMERCE_RECEIVE|COMMERCE_RECEIVING|RECEIVING_/);

    // Every route states a role, every path parameter is a UUID at the edge
    // (four USES — `:id` twice and `:receiptLineId` — not the import line), and
    // three times, once per route.
    expect(controller.match(/@Roles\(/g) ?? []).toHaveLength(3);
    expect(controller.match(/ParseUUIDPipe\)/g) ?? []).toHaveLength(4);
    expect(controller.match(/resolveCommerceActor\(req\)/g) ?? []).toHaveLength(3);

    // The entitlement guard is OUTERMOST: no entitlement question is asked about
    // an anonymous caller (the payment controller's precedent).
    const entitlement = controller.indexOf('@UseGuards(ModuleEntitlementGuard)');
    const jwt = controller.indexOf('@UseGuards(JwtAuthGuard)');
    expect(entitlement).toBeGreaterThan(-1);
    expect(jwt).toBeGreaterThan(-1);
    expect(entitlement).toBeLessThan(jwt);
  });

  it('G. is registered in CommerceModule — provided, never exported', () => {
    expect(existsSync(MODULE_FILE)).toBe(true);
    const moduleSource = readNamed(MODULE_FILE);
    const controllers = decoratorArray(moduleSource, 'controllers');
    const providers = decoratorArray(moduleSource, 'providers');
    const exports = decoratorArray(moduleSource, 'exports');

    // Non-vacuity: the arrays were actually parsed and are the module's own.
    expect(controllers.length).toBeGreaterThanOrEqual(5);
    expect(providers.length).toBeGreaterThanOrEqual(12);
    // The three gateways PLUS W2-C's `CommerceOrderReferenceFacade` — the
    // deliberately narrow seam the neutral bridge module consumes for
    // Financial's purchase-order resolution. Still no slice provider.
    expect(exports.length).toBe(4);

    expect(controllers).toContain('ReceivingHistoryController');
    expect(providers).toContain('ReceivingHistoryRepository');
    expect(providers).toContain('ReceivingHistoryService');
    // The published surface stays the three gateways: no slice provider is
    // exported, so nothing outside this bounded context can call the service or
    // issue a query against `commerce_db` through the repository.
    expect(exports.join(',')).not.toMatch(/Receiving/);
    // Registered repository-then-service, the module's own convention. Located
    // BY NAME rather than by position from the end of the array: "the last two
    // providers" was only ever true while no later slice existed, and step S
    // (contract §13) registers its own pair after R's — a locator that refuses
    // every future slice would be asserting the wrong fact. The CLAIM is
    // unchanged and still falsifiable: the service must sit IMMEDIATELY after
    // its repository, and registering it before the repository — or twice —
    // fails here.
    const repositoryAt = providers.indexOf('ReceivingHistoryRepository');
    expect(repositoryAt).toBeGreaterThan(-1);
    expect(providers[repositoryAt + 1]).toBe('ReceivingHistoryService');
    expect(providers.filter((provider) => provider === 'ReceivingHistoryService')).toHaveLength(1);
  });
  it('H. migration 20260929000003 is ADDITIVE and tenant-first: two tables, nothing else (R3, §3-F)', () => {
    expect(existsSync(MIGRATION_SQL_FILE)).toBe(true);
    const code = sqlCode(readNamed(MIGRATION_SQL_FILE));

    const tables = [...code.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map((match) => match[1]);
    expect(tables.sort()).toEqual(['Receipt', 'ReceiptLine']);

    for (const table of tables) {
      const body = createTableBody(code, table);
      expect(body.length).toBeGreaterThan(0);
      expect({ table, tenantFirst: /"tenant_id" TEXT NOT NULL/.test(body) }).toEqual({
        table,
        tenantFirst: true,
      });
    }

    const indexes = [...code.matchAll(/^CREATE (?:UNIQUE )?INDEX [^\n]*/gm)].map(
      (match) => match[0]
    );
    expect(indexes.length).toBeGreaterThanOrEqual(5);
    for (const index of indexes) {
      expect({ index, tenantFirst: index.includes('("tenant_id"') }).toEqual({
        index,
        tenantFirst: true,
      });
    }

    const alters = [...code.matchAll(/^ALTER TABLE [^\n]*/gm)].map((match) => match[0]);
    expect(alters.length).toBeGreaterThanOrEqual(4);
    for (const alter of alters) {
      // Every constraint R adds is COMPOSITE with the tenant: a receipt line can
      // never name another tenant's row even if its UUID were guessed.
      expect({ alter, composite: /FOREIGN KEY \("tenant_id",/.test(alter) }).toEqual({
        alter,
        composite: true,
      });
    }
    const altered = [
      ...new Set(alters.map((alter) => /^ALTER TABLE "([^"]+)"/.exec(alter)?.[1] ?? '')),
    ];
    expect(altered.sort()).toEqual(['Receipt', 'ReceiptLine']);

    // Purely additive, and it REPAIRS NOTHING: no destructive statement, no
    // column change, and no touch of the pre-existing drift R's own header
    // excludes (`ALTER TABLE "PaymentRecord" … DROP DEFAULT`).
    expect(code).not.toMatch(/^\s*DROP\s/im);
    expect(code).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/ALTER COLUMN|DROP DEFAULT/);
    expect(code).not.toMatch(/PaymentRecord/);
    // No new vocabulary: R states receiving with the tables it adds, and the
    // projection's three members live in TypeScript, not in a database enum.
    expect(code).not.toMatch(/CREATE TYPE/);
  });

  it('I. joins the migration to schema.prisma: every table and every column', () => {
    expect(existsSync(SCHEMA_FILE)).toBe(true);
    const sql = sqlCode(readNamed(MIGRATION_SQL_FILE));
    const schema = readNamed(SCHEMA_FILE);

    for (const table of ['Receipt', 'ReceiptLine']) {
      const columns = [...createTableBody(sql, table).matchAll(/^\s*"([^"]+)"/gm)].map(
        (match) => match[1]
      );
      expect(columns.length).toBeGreaterThanOrEqual(6);

      const model = new RegExp(`model ${table} \\{([^}]*)\\}`).exec(schema)?.[1] ?? '';
      expect(model.length).toBeGreaterThan(0);
      // The model maps to the table the migration creates — `@@map` is the
      // table-level statement, stripped below so a table named `Receipt` cannot
      // masquerade as a column of itself.
      expect(model).toContain(`@@map("${table}")`);

      // Forward: every column the migration creates is declared by the model —
      // either by its `@map`, or by the field name the column spells in snake_case.
      for (const column of columns) {
        const declared =
          model.includes(`@map("${column}")`) ||
          new RegExp(`^\\s*${camelCaseOf(column)}\\s`, 'm').test(model);
        expect({ table, column, declared }).toEqual({ table, column, declared: true });
      }

      // Reverse: no mapped column of the model is absent from the migration, so
      // the schema cannot grow a receiving column no migration created.
      const mapped = [...model.replace(/@@map\("[^"]+"\)/g, '').matchAll(/@map\("([^"]+)"\)/g)].map(
        (match) => match[1]
      );
      expect({ table, orphaned: mapped.filter((column) => !columns.includes(column)) }).toEqual({
        table,
        orphaned: [],
      });
    }
  });
});

/** The body of one `CREATE TABLE "name" ( … );` statement, or `''` when absent. */
function createTableBody(sql: string, table: string): string {
  return new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? '';
}

/** `reverses_receipt_line_id` → `reversesReceiptLineId` — the Prisma field spelling. */
const camelCaseOf = (column: string) =>
  column.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());

describe('C1 step R: the planted defects — every scan refuses what it exists to refuse', () => {
  it('K. fails on each planted defect, so none of A–I is a comment', () => {
    // B: an `update` — or a raw DELETE — anywhere is the mutation append-only
    // history forbids, while a plain `create` is exactly how it appends.
    expect(mutatingCalls(codeOf('return repo.receipt.update({ where: { id } });'))).toEqual([
      '.update(',
    ]);
    expect(
      mutatingCalls(codeOf('return repo.receipt.deleteMany({ where: { tenantId } });'))
    ).toEqual(['.deleteMany(']);
    expect(mutatingCalls(codeOf('return repo.receipt.create({ data });'))).toEqual([]);
    expect(rawWrites(codeOf('return tx.$executeRaw`DELETE FROM "Receipt"`;'))).toEqual([
      '$executeRaw',
    ]);

    // C: a lock without `FOR UPDATE` serializes nothing — the predicate is the
    // whole of the concurrency hinge.
    expect('SELECT "id" FROM "PurchaseDocument" WHERE "tenant_id" = $1').not.toContain(
      'FOR UPDATE'
    );

    // D: a non-repository holding the unwrapper, or a raw client, is the erosion
    // — while naming the PORT is what the service is supposed to do, and a
    // comment that explains the rule is still not a defect.
    expect(CLIENT_NAMES.test(codeOf('const client = unwrapCommerceTransaction(tx);'))).toBe(true);
    expect(CLIENT_NAMES.test(codeOf('constructor(private tx: Prisma.TransactionClient) {}'))).toBe(
      true
    );
    expect(CLIENT_NAMES.test(codeOf('// the repository receives a HANDLE and unwraps it'))).toBe(
      false
    );
    expect(
      CLIENT_NAMES.test(codeOf('constructor(private readonly unit: CommerceUnitOfWork) {}'))
    ).toBe(false);

    // E: another slice's delegate reached from here — in either spelling.
    expect(
      FOREIGN_NAMES.test(codeOf('return tx.paymentRecord.findMany({ where: { tenantId } });'))
    ).toBe(true);
    expect(
      FOREIGN_NAMES.test(
        codeOf('return tx.workflowStepInstance.updateMany({ where: { tenantId } });')
      )
    ).toBe(true);
    expect(FOREIGN_NAMES.test(codeOf('return tx.receipt.findMany({ where: { tenantId } });'))).toBe(
      false
    );

    // F: a fourth route that could rewrite a settled event — and a route set
    // without roles would leave the permission assertion with nothing to read.
    expect(routesOf(codeOf("@Patch(':id/receipts')\nasync edit() {}")).forbidden).toEqual([
      "@Patch(':id/receipts')",
    ]);
    expect(routesOf(codeOf("@Put(':id/receipts')\nasync replace() {}")).forbidden).toEqual([
      "@Put(':id/receipts')",
    ]);
    expect(routesOf(codeOf("@Post(':id/receipts')")).forbidden).toEqual([]);

    // G: an exported slice provider would publish the service to every module.
    expect(decoratorArray('exports: [ReceivingHistoryService]', 'exports')).toEqual([
      'ReceivingHistoryService',
    ]);

    // H: a destructive statement, or a repair of the drift R excludes.
    expect(sqlCode('DROP TABLE "Receipt";')).toMatch(/^\s*DROP\s/im);
    expect(sqlCode('TRUNCATE "ReceiptLine";')).toMatch(/^\s*TRUNCATE\b/im);
    expect(sqlCode('-- DROP TABLE "Receipt";')).not.toMatch(/^\s*DROP\s/im);
    const drift = sqlCode('ALTER TABLE "PaymentRecord" ALTER COLUMN "id" DROP DEFAULT;');
    expect(drift).toMatch(/ALTER COLUMN|DROP DEFAULT/);
    expect([...drift.matchAll(/^ALTER TABLE "([^"]+)"/gm)].map((match) => match[1])).toEqual([
      'PaymentRecord',
    ]);

    // I: a column the model does not declare would pass every other scan here.
    const model = 'model X {\n  tenantId String @map("tenant_id")\n}';
    const plantedColumn = 'purchase_document_id';
    expect(
      model.includes(`@map("${plantedColumn}")`) ||
        new RegExp(`^\\s*${camelCaseOf(plantedColumn)}\\s`, 'm').test(model)
    ).toBe(false);
    // …and the same check passes for a column the model DOES declare.
    expect(
      model.includes('@map("tenant_id")') ||
        new RegExp(`^\\s*${camelCaseOf('tenant_id')}\\s`, 'm').test(model)
    ).toBe(true);
  });
});
