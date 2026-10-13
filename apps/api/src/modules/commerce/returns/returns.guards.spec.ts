import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase C1 Step S (contract §13): the return slice read BACK as text — the
 * executable form of the promises its files state in their own headers, the
 * mirror of `receiving.guards.spec.ts` for this slice.
 *
 * WHAT IS PINNED HERE, AND WHY EACH PIN IS FALSIFIABLE
 * ----------------------------------------------------
 *  A. the slice is exactly S's nine files (a tenth is a deliberate edit to
 *     this gate, never a drive-by addition);
 *  B. APPEND-ONLY, structurally: no `.update(`/`.updateMany(`/`.delete(`/
 *     `.deleteMany(`/`.upsert(` anywhere, no raw UPDATE/DELETE/INSERT/DROP,
 *     no `updatedAt` — the only writes are the two nested `create`s of the
 *     repository (S-D4: no correction model exists to reach for);
 *  C. the concurrency hinge is exactly ONE raw statement — a tenant-scoped
 *     `SELECT … FOR UPDATE` on `PurchaseDocument` — and it is taken FIRST on
 *     BOTH write paths, before any receipt-history or return-history read
 *     (§9, the lock-before-history falsifiable stand-in);
 *  D. the transaction boundary stays in the persistence layer:
 *     `unwrapCommerceTransaction` / `Prisma.TransactionClient` / the
 *     generated client appear only in the repository, while the service
 *     names the port `CommerceUnitOfWork`;
 *  E. the Q boundary and the isolation: the slice's code names NO
 *     `PaymentRecord`/payment repository and reaches Q only through
 *     `PaymentHistoryService`'s public surface — while the workflow,
 *     commercial, receiving-WRITE, notification and identity surfaces are
 *     absent, and no parent `status` is ever read or written (§4-E, §12);
 *  F. the controller wires exactly SIX routes — one GET and five POSTs, NO
 *     `@Patch`/`@Put`/`@Delete`, no seventh — with `commerce.read` /
 *     `commerce.manage` ONLY, `ParseUUIDPipe` on both path ids, the actor
 *     resolver on every handler, and the entitlement guard OUTSIDE the JWT
 *     guard (§4-H, §7);
 *  G. `CommerceModule` provides the repository and the service, registers
 *     the controller, and exports NEITHER;
 *  H. migration `20260929000004_return_foundation` is ADDITIVE and
 *     tenant-first: exactly three tables, one five-member enum, every index
 *     leading with `tenant_id`, every foreign key composite with RESTRICT in
 *     BOTH directions, the positivity CHECK, nothing else touched;
 *  I. every table and column the migration creates is a model and a mapped
 *     field of `schema.prisma` — the join no compiler performs — the three
 *     models carry NO mutable column, and the parents gained ONLY virtual
 *     back-relations;
 *  J. the repository surface is pinned BY NAME (eight methods, tenantId
 *     first, no `findUnique`, every `where` names the tenant), the audit
 *     vocabulary is exactly the five contract actions on
 *     `RETURN_DOCUMENT` and never `PAYMENT_RECORD` (§11, §13);
 *  K. cross-module isolation: no Core/HR/Finance/WMS client, no Rule Engine,
 *     no notification, no identity gateway import anywhere in the slice, and
 *     no cross-database reference in the migration (§5).
 *
 * NON-VACUITY. Every scan carries a floor, and K1 hands each scan a PLANTED
 * defect and requires it to be refused — a guard that cannot fail is a
 * comment.
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
  '20260929000004_return_foundation',
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

const readModule = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(MODULE_DIR, file).replace(/\\/g, '/');

const sliceFiles = walk(SLICE_DIR);
const sliceNames = sliceFiles.map(name).sort();

/**
 * The files the scanners run against: every slice file EXCEPT this guard.
 * K1 below hands each scanner a PLANTED defect — synthetic text containing
 * exactly the tokens the scans refuse — and the guard necessarily contains
 * those literals to do so. Excluding ITSELF (the `commerce-entitlement`
 * precedent) is what keeps the planted defects evidential instead of
 * self-inflicted; every other file is scanned, with a floor below.
 */
const implFiles = sliceFiles.filter((file) => name(file) !== 'returns/returns.guards.spec.ts');

/**
 * The SHIPPED files: the five non-spec sources. The `status` scan of E reads
 * THESE, because a falsifiable spec must NAME the fact it refuses — S-D2's own
 * spec asserts the column is absent by writing the word — while no line that
 * ships may carry it. The narrowing is scoped to that one scan and it carries
 * a floor, so it can never pass by scanning nothing.
 */
const shippedFiles = implFiles.filter((file) => !file.endsWith('.spec.ts'));

/**
 * §10's CLOSED 409 vocabulary, verbatim — five tokens, no sixth ("no other
 * 404/409 wording may be introduced in the S slice without amending THIS
 * contract first"). J scans the service's declaration against this list and
 * K1 plants a sixth token to prove the scan refuses one.
 */
const RETURN_FAILURE_TOKENS = [
  'invalid_origin',
  'invalid_transition',
  'line_reference_mismatch',
  'over_return',
  'refund_compensation_failed',
];

/** Comment lines dropped before scanning — prose may QUOTE a forbidden token. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  );
}

/** One line with a TRAILING comment removed, quotes respected — a `//` in a string stays. */
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

/** Every route decorator in a controller, in source order. */
function routesOf(source: string): { method: string; path: string }[] {
  const code = codeOf(source);
  const routes: { method: string; path: string }[] = [];
  for (const match of code.matchAll(/@(Get|Post|Patch|Put|Delete)\('([^']*)'\)/g)) {
    routes.push({ method: match[1], path: match[2] });
  }
  return routes;
}

/** Every raw-SQL statement's TEXT (this slice's interpolations hold no backticks). */
function rawStatements(source: string): string[] {
  const code = codeOf(source);
  return [
    ...code.matchAll(/\$(?:queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b[^`]*`([^`]*)`/g),
  ]
    .map((match) => match[1])
    .filter((statement) => statement.trim().length > 0);
}

/**
 * The write verbs a raw statement may never carry. `FOR UPDATE` is excluded
 * because it is the LOCK — the hinge section C exists around — and not a
 * mutation; K1 proves the mask below hides only that clause.
 */
const RAW_WRITE_VERBS = /\b(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/i;

/**
 * A raw statement with its LOCK clause masked, so the write scan can refuse
 * every mutation without refusing the one `SELECT … FOR UPDATE` this slice is
 * built on. Falsifiable BOTH ways in K1: a real `UPDATE … SET` survives the
 * mask, `FOR UPDATE` alone does not.
 */
const withoutLockClause = (statement: string) =>
  statement.replace(/\bFOR\s+UPDATE\b/gi, 'FOR LOCK');

/** The body of one service method: from its signature to the next method's signature. */
const METHOD_SIGNATURES = [
  'async list(',
  'async create(',
  'private async runTransition(',
  'async approve(',
  'async reject(',
  'async receiveBack(',
  'async refund(',
];

function methodBody(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start < 0) return '';
  let end = code.length;
  for (const other of METHOD_SIGNATURES) {
    const index = code.indexOf(other, start + signature.length);
    if (index >= 0 && index < end) end = index;
  }
  return code.slice(start, end);
}

/** Every public method's name + parameters (the workflow inventory guard's rule). */
function publicMethodParameters(source: string): { name: string; params: string }[] {
  const code = codeOf(source);
  const declaration = /^ {2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  const methods: { name: string; params: string }[] = [];
  for (const match of code.matchAll(declaration)) {
    if (match[1] === 'constructor') continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = code.length;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === '(') depth += 1;
      else if (code[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    methods.push({ name: match[1], params: code.slice(open + 1, close) });
  }
  return methods;
}

/** Every `where: { … }` object literal in a file (the inventory guard's scan). */
function whereFragments(source: string): string[] {
  const code = codeOf(source);
  const fragments: string[] = [];
  for (const match of code.matchAll(/where\s*:\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = code.length;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === '{') depth += 1;
      else if (code[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    fragments.push(code.slice(open, close + 1));
  }
  return fragments;
}

/** The body of `enum <name> { … }` / `model <name> { … }`, or '' when absent. */
function schemaBlock(schema: string, kind: 'enum' | 'model', blockName: string): string {
  const start = schema.indexOf(`${kind} ${blockName} {`);
  if (start < 0) return '';
  const end = schema.indexOf('\n}', start);
  return end < 0 ? '' : schema.slice(start, end);
}

/** The `decorator: [ … ]` array of the module file, as trimmed entries. */
function decoratorArray(source: string, decorator: string): string[] {
  const match = new RegExp(`${decorator}:\\s*\\[([^\\]]*)\\]`).exec(codeOf(source));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

describe("C1 step S guards: the slice's shape, append-only core and the lock (A, B, C)", () => {
  it("A. the slice is EXACTLY S's nine files — a tenth is a deliberate edit to this gate", () => {
    expect(sliceNames).toEqual(
      [
        'returns/return-history.controller.ts',
        'returns/return-history.repository.ts',
        'returns/return-history.service.spec.ts',
        'returns/return-history.service.ts',
        'returns/return.dto.spec.ts',
        'returns/return.dto.ts',
        'returns/return-lifecycle.spec.ts',
        'returns/return-lifecycle.ts',
        'returns/returns.guards.spec.ts',
      ].sort()
    );
    expect(sliceFiles.length).toBeGreaterThanOrEqual(9); // non-vacuity
  });

  it('B. NOT ONE mutation verb, raw write, or updatedAt exists anywhere in the slice', () => {
    expect(implFiles.length).toBeGreaterThanOrEqual(8); // non-vacuity, minus this guard
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      expect({
        file: name(file),
        mutations: code.match(/\.(update|updateMany|delete|deleteMany|upsert)\(/g) ?? [],
      }).toEqual({ file: name(file), mutations: [] });
      // Raw SQL may READ and LOCK — it may never write or drop. The lock
      // clause is masked first, so `SELECT … FOR UPDATE` is not mistaken for a
      // mutation while a real `UPDATE … SET` still is.
      for (const statement of rawStatements(readModule(file))) {
        expect(withoutLockClause(statement)).not.toMatch(RAW_WRITE_VERBS);
      }
    }

    // NO MUTABLE CLOCK in anything that SHIPS. The four spec files are
    // excluded by exactly the rule E's `status` scan states: a falsifiable
    // spec must NAME the token it refuses, and `return-lifecycle.spec.ts`
    // asserts the three models carry no `updatedAt` by writing the word. The
    // narrowing is scoped to this one claim and it carries the same floor E
    // pins, so it can never pass by scanning nothing.
    expect(shippedFiles).toHaveLength(5);
    for (const file of shippedFiles) {
      expect({
        file: name(file),
        updatedAt: /\bupdatedAt\b/.test(codeOf(readModule(file))),
      }).toEqual({ file: name(file), updatedAt: false });
    }

    // The writes in the slice: the repository's two nested creates plus the Phase B2.3
    // durable outbox write (`auditOutbox.create`) inside the transition method.
    const repositoryCode = codeOf(readModule(join(SLICE_DIR, 'return-history.repository.ts')));
    expect(repositoryCode).toContain('returnDocument.create(');
    expect(repositoryCode).toContain('returnLifecycleTransition.create(');
    expect(repositoryCode).toContain('auditOutbox.create(');
    expect(repositoryCode.match(/\.create\(/g)).toHaveLength(3);
    const serviceCode = codeOf(readModule(join(SLICE_DIR, 'return-history.service.ts')));
    expect(serviceCode).not.toContain('.create('); // services never issue statements
    expect(serviceCode).not.toContain('.update(');
  });

  it('C. the ONLY raw statement is the tenant-scoped FOR UPDATE lock — and it runs FIRST on both write paths', () => {
    const raw = implFiles.flatMap((file) => rawStatements(readModule(file)));
    expect(raw).toHaveLength(1); // exactly one raw statement in the whole slice
    expect(raw[0]).toContain('FROM "PurchaseDocument"');
    expect(raw[0]).toContain('"tenant_id"');
    expect(raw[0]).toContain('FOR UPDATE');

    const code = codeOf(readModule(join(SLICE_DIR, 'return-history.service.ts')));
    const createBody = methodBody(code, 'async create(');
    const transitionBody = methodBody(code, 'private async runTransition(');
    expect(createBody.length).toBeGreaterThan(0); // non-vacuity: the body was found
    expect(transitionBody.length).toBeGreaterThan(0);

    // create: lock BEFORE purchase lines, receipt lines, returns, append.
    const lockInCreate = createBody.indexOf('lockDocumentForReturn');
    expect(lockInCreate).toBeGreaterThanOrEqual(0);
    for (const read of [
      'listPurchaseLines',
      'listReceiptLines',
      'listReturnDocuments',
      'appendReturn',
    ]) {
      expect({ read, afterLock: createBody.indexOf(read) > lockInCreate }).toEqual({
        read,
        afterLock: true,
      });
    }
    // commands: lock BEFORE the scoped return load, the matrix and the append.
    const lockInTransition = transitionBody.indexOf('lockDocumentForReturn');
    expect(lockInTransition).toBeGreaterThanOrEqual(0);
    for (const step of ['findReturnDocument', 'projectReturnState', 'appendTransition']) {
      expect({ step, afterLock: transitionBody.indexOf(step) > lockInTransition }).toEqual({
        step,
        afterLock: true,
      });
    }
    // The READ path takes no lock and issues no write (§12.6)…
    const listBody = methodBody(code, 'async list(');
    expect(listBody).toContain('readReturnHistory');
    expect(listBody).not.toContain('lockDocumentForReturn');
    expect(listBody).not.toContain('append');
    // …and exactly TWO units of work exist — the two write paths — so no
    // read-check-write sequence can live outside one.
    expect(code.match(/this\.unitOfWork\.run\(/g)).toHaveLength(2);
  });
});

describe('C1 step S guards: persistence boundary, Q boundary, isolation (D, E)', () => {
  it('D. the unwrapper and the generated client live ONLY in the repository', () => {
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      const isRepository = name(file) === 'returns/return-history.repository.ts';
      const crossings = code.match(
        /unwrapCommerceTransaction|Prisma\.TransactionClient|CommercePrismaService|generated\/commerce-client/g
      );
      if (isRepository) {
        expect(crossings).not.toBeNull(); // the repository DOES unwrap — non-vacuity
        expect(code).toContain('unwrapCommerceTransaction');
      } else {
        expect({ file: name(file), crossings: crossings ?? [] }).toEqual({
          file: name(file),
          crossings: [],
        });
      }
    }
    // …and the service names the PORT, never the unwrapper.
    const serviceCode = codeOf(readModule(join(SLICE_DIR, 'return-history.service.ts')));
    expect(serviceCode).toContain('CommerceUnitOfWork');
    expect(serviceCode).not.toContain('unwrapCommerceTransaction');
  });

  it('E. Q is reached only through PaymentHistoryService; parent state and foreign surfaces are absent', () => {
    const serviceCode = codeOf(readModule(join(SLICE_DIR, 'return-history.service.ts')));
    const repositoryCode = codeOf(readModule(join(SLICE_DIR, 'return-history.repository.ts')));

    // THE Q BOUNDARY (§4-E): the established public service IS the call —
    // the payment repository and model NEVER are.
    expect(serviceCode).toContain('PaymentHistoryService');
    expect(serviceCode).toContain('this.payments.compensate(');
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      expect({
        file: name(file),
        paymentLeak:
          code.match(/paymentRecord|PaymentHistoryRepository|payment-history\.repository/g) ?? [],
      }).toEqual({ file: name(file), paymentLeak: [] });
      // …not even in PROSE: a comment naming Q's repository is how the next
      // reader starts looking for it.
      expect(readModule(file)).not.toContain('payment-history.repository');
    }

    // PARENT STATE (§12): no `status` token in any SHIPPED file's CODE — a
    // return never reads nor writes PurchaseDocument.status. The four specs
    // are excluded because a falsifiable guard must NAME the fact it refuses
    // (S-D2's spec asserts the column's absence by writing it), and the floor
    // below keeps the narrowing from scanning an empty set.
    expect(shippedFiles).toHaveLength(5);
    for (const file of shippedFiles) {
      const code = codeOf(readModule(file));
      expect({ file: name(file), hasStatus: /\bstatus\b/.test(code) }).toEqual({
        file: name(file),
        hasStatus: false,
      });
    }

    // ISOLATION (§5, §12.7): no workflow/commercial row, no receiving WRITE,
    // no notification/identity gateway, no Rule Engine.
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      const foreign = code.match(
        /WorkflowInstance|WorkflowStepInstance|CommercialAssignment|CommercialApproval|CommerceNotificationGateway|CommerceIdentityGateway|PureRuleEngine|notification\.publish|receipt\.create|receipt\.update|receiptLine\.create|receiptLine\.update|purchaseDocument\.update|purchaseLine\.update/g
      );
      expect({ file: name(file), foreign: foreign ?? [] }).toEqual({
        file: name(file),
        foreign: [],
      });
    }
    // The repository READS receipt lines (the invariant's input) and nothing
    // else — the delegate appears ONLY beside `findMany`.
    expect(repositoryCode).toContain('receiptLine.findMany(');
    expect(repositoryCode).not.toMatch(/receiptLine\.(?!findMany)[a-z]/);
  });
});

describe('C1 step S guards: the six routes, the module wiring (F, G)', () => {
  const CONTROLLER_FILE = join(SLICE_DIR, 'return-history.controller.ts');
  const controllerSource = readModule(CONTROLLER_FILE);

  it('F. exactly the six contract routes exist — one GET, five POSTs, no PATCH/PUT/DELETE, no seventh', () => {
    const routes = routesOf(controllerSource);
    expect(routes).toHaveLength(6); // non-vacuity: the scan found them all
    expect(routes).toEqual([
      { method: 'Get', path: ':id/returns' },
      { method: 'Post', path: ':id/returns' },
      { method: 'Post', path: ':id/returns/:returnId/approve' },
      { method: 'Post', path: ':id/returns/:returnId/reject' },
      { method: 'Post', path: ':id/returns/:returnId/receive-back' },
      { method: 'Post', path: ':id/returns/:returnId/refund' },
    ]);
    expect(
      routes.filter(
        (route) => route.method === 'Patch' || route.method === 'Put' || route.method === 'Delete'
      )
    ).toEqual([]);
    expect(codeOf(controllerSource)).not.toContain('@Patch');
    expect(codeOf(controllerSource)).not.toContain('@Put');
    expect(codeOf(controllerSource)).not.toContain('@Delete');
  });

  it('F. permissions are commerce.read ONCE and commerce.manage FIVE times — no seventh name', () => {
    const code = codeOf(controllerSource);
    expect(code.match(/@Roles\(Permissions\.COMMERCE_READ\)/g)).toHaveLength(1);
    expect(code.match(/@Roles\(Permissions\.COMMERCE_MANAGE\)/g)).toHaveLength(5);
    // The ONLY permission identifiers this controller names.
    const named = [...code.matchAll(/Permissions\.([A-Z_]+)/g)].map((match) => match[1]);
    expect([...new Set(named)].sort()).toEqual(['COMMERCE_MANAGE', 'COMMERCE_READ']);
    // No return-specific permission exists anywhere in the slice's CODE (§4-H)
    // — prose may name one only to refuse it, which is why this reads CODE.
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      expect({ file: name(file), returnPermission: code.includes('commerce.return.') }).toEqual({
        file: name(file),
        returnPermission: false,
      });
      expect({ file: name(file), approvePermission: code.includes('commerce.approve') }).toEqual({
        file: name(file),
        approvePermission: false,
      });
    }
  });

  it('F. decorator order is module -> feature -> entitlement guard -> JWT guard, LAST', () => {
    const code = codeOf(controllerSource);
    const moduleIndex = code.indexOf('@RequiresModule(COMMERCE_MODULE_ID)');
    const featureIndex = code.indexOf(
      '@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)'
    );
    const entitlementIndex = code.indexOf('@UseGuards(ModuleEntitlementGuard)');
    const jwtIndex = code.indexOf('@UseGuards(JwtAuthGuard)');
    expect(moduleIndex).toBeGreaterThanOrEqual(0); // non-vacuity
    expect(moduleIndex).toBeLessThan(featureIndex);
    expect(featureIndex).toBeLessThan(entitlementIndex);
    expect(entitlementIndex).toBeLessThan(jwtIndex); // authentication innermost
  });

  it('F. both path ids sit behind ParseUUIDPipe, and every handler resolves the actor from the session', () => {
    const code = codeOf(controllerSource);
    expect(code.match(/'id', ParseUUIDPipe/g)).toHaveLength(6); // every route
    expect(code.match(/'returnId', ParseUUIDPipe/g)).toHaveLength(4); // every command
    expect(code.match(/resolveCommerceActor\(req\)/g)).toHaveLength(6); // every handler
    // The controller imports NO identity of its own — the resolver is the
    // only source (§4-G).
    expect(code).not.toMatch(/req\.(body|query|params)\.\w*[Tt]enant/);
  });

  it('G. CommerceModule provides the repository and service, registers the controller, exports NEITHER', () => {
    const moduleSource = readModule(MODULE_FILE);
    expect(decoratorArray(moduleSource, 'controllers')).toContain('ReturnHistoryController');
    const providers = decoratorArray(moduleSource, 'providers');
    expect(providers).toContain('ReturnHistoryRepository');
    expect(providers).toContain('ReturnHistoryService');
    const exports = decoratorArray(moduleSource, 'exports');
    expect(exports).not.toContain('ReturnHistoryRepository');
    expect(exports).not.toContain('ReturnHistoryService');
    expect(exports).not.toContain('ReturnHistoryController');
    // Non-vacuity: the array scans read a real list, not an empty one.
    expect(providers.length).toBeGreaterThanOrEqual(15);
    expect(decoratorArray(moduleSource, 'controllers').length).toBeGreaterThanOrEqual(6);
  });
});

describe('C1 step S guards: the additive, tenant-first migration (H)', () => {
  const migrationSql = readModule(MIGRATION_SQL_FILE);

  it('H. creates EXACTLY three tables and the five-member enum — nothing else is touched', () => {
    expect(migrationSql.length).toBeGreaterThan(0); // non-vacuity: the file was read
    const tables = [...migrationSql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(['ReturnDocument', 'ReturnLifecycleTransition', 'ReturnLine']);
    const enumMatch = /CREATE TYPE "ReturnState" AS ENUM \(([^)]*)\)/.exec(migrationSql);
    expect(enumMatch).not.toBeNull();
    expect(enumMatch![1].trim()).toBe(
      "'REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED'"
    );
    // ADDITIVE ONLY: no destructive statement, no historical table rewritten —
    // the only ALTERs are the five AddForeignKey statements on Return* tables.
    expect(migrationSql).not.toMatch(/^\s*DROP\s/im);
    expect(migrationSql).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(migrationSql).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(migrationSql).not.toMatch(/^\s*UPDATE\s+/im);
    const altered = [...migrationSql.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(altered).toEqual([
      'ReturnDocument',
      'ReturnLine',
      'ReturnLine',
      'ReturnLine',
      'ReturnLifecycleTransition',
    ]);
    // No other owner, no cross-database reference (§14).
    expect(migrationSql).not.toMatch(/core_db|hr_db|cms_db|correspondence_db|observability_db/);
    expect(migrationSql).not.toMatch(/CREATE EXTENSION|dblink|postgres_fdw|CREATE FOREIGN TABLE/i);
  });

  it('H. every index leads tenant_id, every FK is composite and RESTRICT/RESTRICT, the positivity CHECK exists', () => {
    const indexes = [
      ...migrationSql.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"\(([^)]*)\)/g),
    ];
    expect(indexes.length).toBeGreaterThanOrEqual(8); // eight indexes, non-vacuity floor
    for (const [, table, columns] of indexes) {
      expect({ table, tenantFirst: columns.startsWith('"tenant_id"') }).toEqual({
        table,
        tenantFirst: true,
      });
    }
    const fks = [
      ...migrationSql.matchAll(
        /ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("tenant_id", "[^"]+"\) REFERENCES "([^"]+)"\("tenant_id", "id"\) ON DELETE (\w+) ON UPDATE (\w+)/g
      ),
    ];
    expect(fks).toHaveLength(5); // non-vacuity
    for (const [, table, parent, onDelete, onUpdate] of fks) {
      expect({ table, parent, onDelete, onUpdate }).toEqual({
        table,
        parent,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
      });
    }
    // The §14 positivity CHECK — the strongest construct the engine offers
    // for S-D1 at the database level.
    expect(migrationSql).toContain(
      'CONSTRAINT "ReturnLine_quantity_positive_check" CHECK ("quantity" > 0)'
    );
    // Tenant-first names, including the shortened transition index (§6).
    expect(migrationSql).toContain(
      '"ReturnDocument_tenant_id_purchase_document_id_created_at_idx"'
    );
    expect(migrationSql).toContain('"ReturnLine_tenant_id_receipt_line_id_idx"');
    expect(migrationSql).toContain(
      '"ReturnTransition_tenant_id_return_document_id_created_at_idx"'
    );
  });
});

describe('C1 step S guards: the schema join — models, columns, back-relations (I)', () => {
  const schema = readModule(SCHEMA_FILE);

  it('I. every migration table and column is a model and a mapped field of schema.prisma', () => {
    for (const model of ['ReturnDocument', 'ReturnLine', 'ReturnLifecycleTransition']) {
      const block = schemaBlock(schema, 'model', model);
      expect(block.length).toBeGreaterThan(0); // non-vacuity: the model exists
      expect(block).toContain('@map("tenant_id")');
      expect(block).toContain('@@unique([tenantId, id]');
      expect(block).toMatch(/^\s+createdAt\s+DateTime/m);
      expect({ model, updatedAt: /\bupdatedAt\b/.test(block) }).toEqual({
        model,
        updatedAt: false,
      });
    }
    const document = schemaBlock(schema, 'model', 'ReturnDocument');
    for (const column of ['purchase_document_id', 'requested_by_user_id', 'replacement_required']) {
      expect(document).toContain(`@map("${column}")`);
    }
    const line = schemaBlock(schema, 'model', 'ReturnLine');
    for (const column of ['return_document_id', 'purchase_line_id', 'receipt_line_id']) {
      expect(line).toContain(`@map("${column}")`);
    }
    expect(line).toMatch(/quantity\s+Decimal\s+@db\.Decimal\(18, 4\)/);
    const transition = schemaBlock(schema, 'model', 'ReturnLifecycleTransition');
    expect(transition).toMatch(/^\s+state\s+ReturnState\s*$/m);
    expect(transition).toContain('@map("return_document_id")');
    // The enum join: schema members equal the migration's, in order.
    const enumBody = schemaBlock(schema, 'enum', 'ReturnState');
    const members = enumBody
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Z][A-Z_]*$/.test(entry));
    expect(members).toEqual(['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED']);
    // NO mutable status/state column on the document (S-D2) — the field the
    // whole design refuses, checked where it could sneak in.
    const documentFields = document
      .split('\n')
      .filter((entry) => !entry.trim().startsWith('///'))
      .join('\n');
    expect(documentFields).not.toMatch(/^\s+status\s/m);
    expect(documentFields).not.toMatch(/^\s+state\s/m);
  });

  it('I. the parents gained ONLY virtual back-relations — no column, no status, nothing stateful', () => {
    const purchaseDocument = schemaBlock(schema, 'model', 'PurchaseDocument');
    const purchaseLine = schemaBlock(schema, 'model', 'PurchaseLine');
    const receiptLine = schemaBlock(schema, 'model', 'ReceiptLine');
    expect(purchaseDocument).toContain(
      'returns ReturnDocument[] @relation("ReturnDocumentPurchaseDocument")'
    );
    expect(purchaseLine).toContain('returnLines ReturnLine[] @relation("ReturnLinePurchaseLine")');
    expect(receiptLine).toContain('returnLines ReturnLine[] @relation("ReturnLineReceiptLine")');
    // Virtual means VIRTUAL: no new MAPPED scalar mentions "return" on either
    // parent — a column would have produced DDL the migration does not have.
    for (const [model, block] of [
      ['PurchaseDocument', purchaseDocument],
      ['PurchaseLine', purchaseLine],
      ['ReceiptLine', receiptLine],
    ] as const) {
      const mappedScalars = block
        .split('\n')
        .filter((entry) => !entry.trim().startsWith('///') && entry.includes('@map('))
        .join('\n');
      expect({ model, returnScalar: /@map\("return/.test(mappedScalars) }).toEqual({
        model,
        returnScalar: false,
      });
    }
    // No many-to-many bridge model exists (S-D5): the join is by scalars.
    expect(schema).not.toContain('model ReturnLineReceiptLine');
    expect(schemaBlock(schema, 'model', 'ReturnLine')).toContain('receiptLineId');
  });
});

describe('C1 step S guards: the repository surface and the audit vocabulary (J)', () => {
  const repositorySource = readModule(join(SLICE_DIR, 'return-history.repository.ts'));
  const serviceSource = readModule(join(SLICE_DIR, 'return-history.service.ts'));

  it('J. the repository surface is pinned BY NAME — eleven methods, tenantId first, no findUnique', () => {
    const methods = publicMethodParameters(repositorySource);
    // PHASE REPORTING-COMMERCE-RETURN-LIFECYCLE: the report register gains exactly
    // THREE tenant-scoped reads — `listReportPage`, `countReportByState`,
    // `findReportRow` — each taking `tenantId` first (checked below) and none of them
    // a write. The pin grows with them, by name: a fourth would be a second
    // deliberate edit (the payment register's pin records the same rule).
    expect(methods.map((method) => method.name).sort()).toEqual(
      [
        'appendReturn',
        'appendTransition',
        'countReportByState',
        'findReportRow',
        'findReturnDocument',
        'listPurchaseLines',
        'listReceiptLines',
        'listReportPage',
        'listReturnDocuments',
        'lockDocumentForReturn',
        'readReturnHistory',
      ].sort()
    );
    const untenanted = methods
      .filter((method) => !method.params.trimStart().startsWith('tenantId: string'))
      .map((method) => method.name);
    expect(untenanted).toEqual([]); // tenant FIRST, every one
    // `findUnique` cannot carry a tenant — absent module-wide, and here.
    for (const file of implFiles) {
      const code = codeOf(readModule(file));
      expect({ file: name(file), findUnique: /\.findUnique(OrThrow)?\(/.test(code) }).toEqual({
        file: name(file),
        findUnique: false,
      });
    }
    // Every `where` fragment names the tenant (the inventory guard's rule,
    // asserted on this repository too).
    const fragments = whereFragments(repositorySource);
    expect(fragments.length).toBeGreaterThanOrEqual(5); // non-vacuity
    const untenantedWheres = fragments.filter((fragment) => !fragment.includes('tenantId'));
    expect(untenantedWheres).toEqual([]);
    // The persistence layer records no audit (§I8) — the trail is the service's.
    expect(codeOf(repositorySource)).not.toMatch(/CommerceAuditGateway|\baudit\.record\b/);
  });

  it('J. the audit vocabulary is exactly the five contract actions on RETURN_DOCUMENT — never PAYMENT_RECORD', () => {
    const serviceCode = codeOf(serviceSource);
    expect(serviceCode).toContain('COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT');
    expect(serviceCode).toContain('RETURN_AUDIT_ACTION');
    // The five member references — no sixth action token anywhere in code.
    const memberUses = [...serviceCode.matchAll(/RETURN_AUDIT_ACTION\.([A-Z_]+)/g)].map(
      (match) => match[1]
    );
    expect([...new Set(memberUses)].sort()).toEqual([
      'APPROVE',
      'CREATE',
      'RECEIVE_BACK',
      'REFUND',
      'REJECT',
    ]);
    // S never writes Q's audit resource — the refund's payment trail is Q's.
    expect(serviceCode).not.toContain('COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD');
    expect(serviceCode).not.toContain('COMMERCE_AUDIT_RESOURCE.RECEIPT');
    // ONE `audit.record` call site — the create's best-effort non-durable path.
    // The command spine's durable events use `audit.buildOutboxPayload` instead (Phase B2.3).
    expect(serviceCode.match(/this\.audit\.record\(/g)).toHaveLength(1);
    expect(serviceCode.match(/this\.audit\.buildOutboxPayload\(/g)).toHaveLength(1);
    const listBody = methodBody(serviceCode, 'async list(');
    expect(listBody).not.toContain('audit.record');
  });

  it("J. the 409 vocabulary is §10's five tokens — four at throw sites, every one an object payload", () => {
    const serviceCode = codeOf(serviceSource);
    // EVERY conflict in the service opens an OBJECT payload whose `code` is a
    // `RETURN_FAILURE` member: §10 refuses vague generic answers, and a
    // bare-string refusal would reach the client with no token at all.
    const conflicts = serviceCode.match(/new ConflictException\(/g) ?? [];
    expect(conflicts).toHaveLength(4);
    const coded = serviceCode.match(/new ConflictException\(\{\s*code: RETURN_FAILURE\./g) ?? [];
    expect(coded).toHaveLength(4);
    // The members actually thrown — the four reachable refusals. The fifth,
    // `INVALID_ORIGIN`, is reserved-but-unreachable (the scoped 404 answers
    // first — §10's own "when not already 404 by scoping").
    const members = [...serviceCode.matchAll(/RETURN_FAILURE\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(members)].sort()).toEqual([
      'INVALID_TRANSITION',
      'LINE_REFERENCE_MISMATCH',
      'OVER_RETURN',
      'REFUND_COMPENSATION_FAILED',
    ]);
    // The DECLARATION is §10's closed five — its VALUES, read from the record
    // block itself, because a scan of references sees only the four thrown.
    const record = /export const RETURN_FAILURE = \{([\s\S]*?)\} as const;/.exec(serviceSource);
    expect(record).not.toBeNull();
    const declared = [...record![1].matchAll(/([A-Z_]+): '([a-z_]+)'/g)].map((match) => match[2]);
    expect(declared.sort()).toEqual([...RETURN_FAILURE_TOKENS].sort());
  });
});

describe('C1 step S guards: cross-module isolation (K2)', () => {
  it('K2. no Core/HR/Finance/WMS client, Rule Engine, notification or identity import reaches the slice', () => {
    for (const file of implFiles) {
      const imports = [...readModule(file).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      const foreign = imports.filter((specifier) =>
        /core-client|hr-client|cms-client|warehouse|wms|finance|rule-engine|notifications\/|user-directory|identity\.gateway/i.test(
          specifier
        )
      );
      expect({ file: name(file), foreign }).toEqual({ file: name(file), foreign: [] });
    }
    // The ONE cross-slice import the contract authorises is Q's service…
    const serviceImports = [...readService().matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(serviceImports).toContain('../payment/payment-history.service');
    // …and nothing else in the service leaves the returns directory except
    // the module's own collaborators — the actor resolver, the audit gateway,
    // the constants, the unit of work, P's money arithmetic and Q's service.
    expect(serviceImports.filter(leavesTheSlice)).toEqual([]);
    // Non-vacuity, the other way: the allowlist is REAL — every collaborator
    // S is supposed to name is actually imported, so a predicate that refused
    // everything could not hide a lawful import the service lost.
    for (const allowed of SERVICE_ALLOWED_IMPORTS) {
      expect({ allowed, imported: serviceImports.includes(allowed) }).toEqual({
        allowed,
        imported: true,
      });
    }
  });
});

/** The service source, read fresh for the import assertions above. */
function readService(): string {
  return readModule(join(SLICE_DIR, 'return-history.service.ts'));
}

/**
 * The cross-directory specifiers a service file MAY name — each one a
 * collaborator the contract put in reach, stated as an explicit list rather
 * than a prefix, so a new import is a deliberate edit to this gate. Prefix
 * rules are how `../hr/hr-client` slips past a filter written for
 * `../commerce-*`.
 */
const SERVICE_ALLOWED_IMPORTS = [
  '../payment/payment-history.service',
  '../purchase/purchase-money',
  '../database/commerce-transaction',
  '../commerce-actor',
  '../commerce-audit.gateway',
  '../commerce.constants',
];

/**
 * Does this specifier leave the returns directory for somewhere the service
 * may not go? K2 runs it over the real imports and K1 plants a foreign
 * specifier into it, so the predicate is falsifiable on both sides — a rule
 * that answered `false` for everything would leave K2 green for the wrong
 * reason.
 */
const leavesTheSlice = (specifier: string) =>
  specifier.startsWith('../') && !SERVICE_ALLOWED_IMPORTS.includes(specifier);

describe('C1 step S guards: every scan refuses a PLANTED defect (K1)', () => {
  it('B: mutation verbs and raw writes are refused when they appear', () => {
    // The exact patterns section B runs over each file, pointed at text that
    // contains the defect: a pattern that no longer fires would leave B green
    // for the wrong reason.
    for (const defect of [
      'return repo.returnDocument.update({ where: { id } });',
      'return repo.returnDocument.updateMany({ where: { tenantId } });',
      'return repo.returnDocument.delete({ where: { id } });',
      'return repo.returnDocument.deleteMany({ where: { tenantId } });',
      'return repo.returnDocument.upsert({ where: { id } });',
    ]) {
      expect(defect).toMatch(/\.(update|updateMany|delete|deleteMany|upsert)\(/);
    }
    const raw = rawStatements('return tx.$executeRaw`DELETE FROM "ReturnDocument"`;');
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatch(/\b(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/i);
    // …while the REAL statement passes the same scan.
    const lock = rawStatements(
      'return tx.$queryRaw`SELECT "id" FROM "PurchaseDocument" WHERE "tenant_id" = ${tenantId} FOR UPDATE`;'
    );
    expect(withoutLockClause(lock[0])).not.toMatch(RAW_WRITE_VERBS);
    // …and the MASK hides ONLY that clause: the same scan, pointed at a real
    // mutation, still fires — so the lock's exemption cannot smuggle an
    // `UPDATE … SET` past B.
    expect(withoutLockClause('UPDATE "ReturnDocument" SET "reason" = NULL')).toMatch(
      RAW_WRITE_VERBS
    );
    // A code line claiming an updatedAt fails even after comment-stripping…
    expect(codeOf('const clock = row.updatedAt;')).toMatch(/\bupdatedAt\b/);
    // …while prose explaining the ABSENCE does not.
    expect(codeOf('// rows never carry an updatedAt here')).not.toMatch(/\bupdatedAt\b/);
  });

  it('C: a lock without FOR UPDATE serializes nothing — the predicate is the whole hinge', () => {
    const planted = 'SELECT "id" FROM "PurchaseDocument" WHERE "tenant_id" = $1';
    expect(planted).not.toContain('FOR UPDATE'); // the scan that B/C run
    // …and a read placed BEFORE the lock is the exact ordering defect C
    // refuses: the comparison must answer false for the planted body.
    const plantedBody =
      'const rows = listReturnDocuments(tenant, doc, tx); lockDocumentForReturn(tenant, doc, tx);';
    expect(
      plantedBody.indexOf('listReturnDocuments') > plantedBody.indexOf('lockDocumentForReturn')
    ).toBe(false);
    // The real bodies answer true for every step (asserted in C above).
  });

  it('D/E/J: a foreign client, a payment leak, a parent status and an untenanted method are all refused', () => {
    expect(codeOf('const c = unwrapCommerceTransaction(tx);')).toContain(
      'unwrapCommerceTransaction'
    );
    expect(codeOf('constructor(private tx: Prisma.TransactionClient) {}')).toContain(
      'Prisma.TransactionClient'
    );
    expect(codeOf('return tx.paymentRecord.findMany({ where: { tenantId } });')).toMatch(
      /paymentRecord/
    );
    expect(codeOf('const s = document.status;')).toMatch(/\bstatus\b/);
    expect(codeOf('// PurchaseDocument.status is never read here')).not.toMatch(/\bstatus\b/);
    expect(codeOf('return this.prisma.returnDocument.findUnique({ where: { id } });')).toMatch(
      /\.findUnique\(/
    );
    const untenanted = publicMethodParameters(
      ['class Leak {', '  async find(id: string) {', '    return id;', '  },', '}'].join('\n')
    );
    expect(untenanted).toHaveLength(1);
    expect(untenanted[0].params.trimStart().startsWith('tenantId: string')).toBe(false);
    const untenantedWhere = whereFragments('return x.findFirst({ where: { id: 1 } });');
    expect(untenantedWhere).toHaveLength(1);
    expect(untenantedWhere[0]).not.toContain('tenantId');
  });

  it('F/H/I: a seventh route, a destructive migration line, an untied column and an exported provider are refused', () => {
    const patched = routesOf("@Patch(':id/returns')\nasync edit() {}");
    expect(patched).toEqual([{ method: 'Patch', path: ':id/returns' }]); // §7 forbids it
    const destructive = 'DROP TABLE "ReturnDocument";';
    expect(destructive).toMatch(/^\s*DROP\s/im);
    const untiedIndex = 'CREATE INDEX "x_idx" ON "ReturnLine"("quantity");';
    const [, untiedColumns] = /ON "([^"]+)"\(([^)]*)\)/.exec(untiedIndex)!;
    expect(untiedColumns.startsWith('"tenant_id"')).toBe(false); // H refuses it
    const looseFk =
      /FOREIGN KEY \("tenant_id", "[^"]+"\) REFERENCES "[^"]+"\("tenant_id", "id"\) ON DELETE (\w+) ON UPDATE (\w+)/.exec(
        'FOREIGN KEY ("tenant_id", "return_document_id") REFERENCES "ReturnDocument"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE'
      )!;
    expect(looseFk[1]).not.toBe('RESTRICT'); // H refuses a cascade
    const missingColumn = schemaBlock(
      'model X {\n  tenantId String @map("tenant_id")\n}',
      'model',
      'X'
    );
    expect(missingColumn).not.toContain('@map("return_document_id")'); // I refuses the join
    const exported = decoratorArray('exports: [ReturnHistoryService]', 'exports');
    expect(exported).toContain('ReturnHistoryService'); // G refuses exactly this
  });

  it('J: a token-less conflict, or a sixth token, is refused', () => {
    // The predicate J runs, pointed at the shape §10 forbids: a bare-string
    // refusal, which would reach the client with no `code` at all…
    const coded = /new ConflictException\(\{\s*code: RETURN_FAILURE\./g;
    const bare = codeOf("throw new ConflictException('Refund compensation failed: x');");
    expect(bare.match(coded)).toBeNull();
    // …and at a sixth member a drifted service might declare: it EXISTS in the
    // text, and J's closed five still refuse it.
    const recordShape = /export const RETURN_FAILURE = \{([\s\S]*?)\} as const;/;
    const drifted = "export const RETURN_FAILURE = {\n  OVER_REFUND: 'over_refund',\n} as const;";
    const declared = [...recordShape.exec(drifted)![1].matchAll(/([A-Z_]+): '([a-z_]+)'/g)].map(
      (match) => match[2]
    );
    expect(declared).toEqual(['over_refund']); // the scan FINDS the token…
    expect(declared.sort()).not.toEqual([...RETURN_FAILURE_TOKENS].sort()); // …and J refuses it
  });

  it('K2: a specifier leaving the slice is refused — while the lawful ones are not', () => {
    // The predicate K2 runs, pointed at specifiers that must be refused…
    for (const foreign of [
      '../hr/hr-client',
      '../hr/hr.module',
      '../core/database/core-prisma.service',
      '../finance/invoice.service',
      '../warehouse/stock.repository',
      '../payment/payment-history.repository',
      '../workflow/workflow-execution.service',
    ]) {
      expect({ foreign, refused: leavesTheSlice(foreign) }).toEqual({ foreign, refused: true });
    }
    // …and at the collaborators the contract DID put in reach, which it must
    // let through (a rule refusing everything would make K2 vacuous).
    for (const allowed of [
      ...SERVICE_ALLOWED_IMPORTS,
      './return.dto',
      './return-lifecycle',
      './return-history.repository',
      '@nestjs/common',
      'express',
    ]) {
      expect({ allowed, refused: leavesTheSlice(allowed) }).toEqual({
        allowed,
        refused: false,
      });
    }
  });
});
