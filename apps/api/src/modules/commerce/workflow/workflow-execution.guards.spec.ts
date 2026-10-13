import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase C1 Step N (§5.7, §8, §9, §11, §14.3, §15): the workflow EXECUTION side read BACK as text
 * — the executable form of the promises `workflow-execution.repository.ts` states in its own
 * header, and the MIRROR of `workflow-configuration.repository.spec.ts`.
 *
 * WHY A SECOND FILE, WHICH IS THE SPLIT §14.3 NAMED
 * ------------------------------------------------
 * Steps L and M proved their boundaries by scanning for ABSENCES: no statement outside a
 * repository, and "the workflow slice names no instance table". Step N makes two of those
 * absences FALSE ON PURPOSE — the two runtime tables become written, and the execution side names
 * the run, its steps and the document they are about. Deleting the assertions would leave the
 * configuration side unpinned; weakening them would leave it under-pinned. So the gate is split:
 * M's spec keeps asserting that the CONFIGURATION side names no execution table and writes no
 * instance row, and this file asserts the mirror — the EXECUTION side writes ONLY instance rows,
 * and reaches for nothing the runtime does not own.
 *
 * WHAT IS PINNED HERE, AND WHY EACH PIN IS FALSIFIABLE
 * ---------------------------------------------------
 *  A. §14.3's split, positively: the only WRITES are on `WorkflowInstance`/`WorkflowStepInstance`,
 *     and the only tables READ are the configuration a plan pins and the document it is about — a
 *     write to `WorkflowStep` or `PurchaseDocument` would be the other slice's job done here;
 *  B. every write is CONDITIONAL on the runtime's own status constant: the decision, the skip and
 *     the settlement each state `WHERE status = …` from `workflow-run-status.ts` rather than a
 *     literal that could drift from the planner's;
 *  C. every WRITE takes a unit of work — `tenantId` first, the handle second (M's gate C reads
 *     every repository's surface for the TENANT; this reads the execution one for the HANDLE) —
 *     and the only `$transaction`s in the file are array-form PAGE reads: an interactive
 *     transaction opened here would be a second unit of work beside `CommerceUnitOfWork`;
 *  D. the transaction boundary stays in the persistence layer: `unwrapCommerceTransaction`,
 *     `Prisma.TransactionClient` and `CommerceUnitOfWork` appear in `database/` and in
 *     `.repository.ts` files and nowhere else, so no service, controller, DTO, gateway or planner
 *     can hold a client (`commerce-transaction.ts` states the whole argument);
 *  E. §5.7 as an absence: the history read selects no rule-bearing configuration column — an
 *     explanation can never be recomputed from today's thresholds — and DOES carry the persisted
 *     input snapshot the outcome was computed from;
 *  F. §15's "repositories issue no business decisions, no rule evaluation": the execution
 *     repository imports no rule engine and calls no evaluator — the engine is the planner's.
 *
 * NON-VACUITY. Every scan carries a floor (delegations, methods, conditional writes, boundary
 * owners) and G hands each scan a PLANTED defect and requires it to be refused — a guard that
 * cannot fail is a comment, and these fixtures are why the assertions above are worth trusting
 * when they are green.
 *
 * NOT PINNED HERE, DELIBERATELY. Tenant-first parameters, `findUnique` and `updateMany`-over-
 * `update` are already read over EVERY `.repository.ts` file by M's gate B/C, and this repository
 * satisfies them by being a repository listed there by name (§14.3). A second copy of that scan
 * would be one rule written in two places, which is the thing both files exist to prevent.
 */

const MODULE_DIR = join(__dirname, '..');

/** The file this guard is about, pinned by NAME rather than discovered. */
const EXECUTION_FILE = join(MODULE_DIR, 'workflow/workflow-execution.repository.ts');

/** Where a client may legitimately be held: the client's own home — plus every repository below. */
const BOUNDARY_OWNER = 'database/commerce-transaction.ts';

/** Every TypeScript file in the module, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const readModule = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(MODULE_DIR, file).replace(/\\/g, '/');

const moduleFiles = walk(MODULE_DIR);
const sourceFiles = moduleFiles.filter((file) => !file.endsWith('.spec.ts'));

/**
 * Comment lines dropped before scanning, and trailing `//` comments stripped — the rule (and the
 * helpers) M's guard records for its own scans, duplicated rather than shared because a common
 * test helper would be a third file every guard's parsing had to agree with. Prose disappears
 * entirely: the repository's header NAMES `WorkflowInstance` to explain what it owns, and
 * deleting that sentence to satisfy a scan would delete the explanation, not a defect.
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

/** One line with a TRAILING comment removed, quotes respected — a `//` inside a string stays. */
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

/** Files whose CODE mentions the pattern. */
function offenderFiles(pattern: RegExp, files: string[] = sourceFiles): string[] {
  return files
    .filter((file) => pattern.test(codeOf(readModule(file))))
    .map(name)
    .sort();
}

/**
 * The index of the character that closes the region opened at `open`, counting nesting and
 * ignoring quoted text — whole object literals are what the scans below need, not single lines.
 */
function balancedRegion(code: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length - 1;
}

/** One model/operation pair a statement asks for: `workflowStepInstance.updateMany`, as a fact. */
type Delegation = { model: string; operation: string };

const RUNTIME_TABLES = ['workflowInstance', 'workflowStepInstance'];
const READABLE_TABLES = [
  ...RUNTIME_TABLES,
  'workflowDefinitionVersion',
  'workflowStep',
  'purchaseDocument',
];
const WRITE_OPERATIONS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

/**
 * Every delegation a file asks of a client, judged as the PAIR (model, operation): the same
 * operation on a configuration table belongs to the other slice, while the same table under a
 * read is this one's business. The regex lives INSIDE the function because a module-level `/g`
 * pattern carries `lastIndex` between calls, which is how a scan starts reading from the middle.
 */
function delegationsOf(code: string): Delegation[] {
  const pattern =
    /\b(workflowInstance|workflowStepInstance|workflowDefinitionVersion|workflowDefinition|workflowStep|purchaseDocument|purchaseDocumentCounter)\.(createMany|updateMany|deleteMany|create|update|delete|upsert|findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count)\b/g;
  return [...code.matchAll(pattern)].map((match) => ({
    model: match[1],
    operation: match[2],
  }));
}

/** Every `updateMany` argument as its whole object literal — the predicate AND the data written. */
function updateManyRegions(code: string): string[] {
  const regions: string[] = [];
  for (const match of code.matchAll(/\.updateMany\(\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    regions.push(code.slice(open, balancedRegion(code, open, '{', '}') + 1));
  }
  return regions;
}

/**
 * Every PUBLIC method's parameter list, taken from the class body — the same parse as M's gate C,
 * so a method this reads as handle-bearing is a method that gate reads as tenant-first. `private`,
 * `static` and `constructor` are excluded by the two-space indent the declaration regex demands: a
 * private helper receives the client it was called ON, and the surface the service calls is what
 * these scans judge.
 */
function publicMethodParameters(source: string): { name: string; params: string }[] {
  const code = codeOf(source);
  const declaration = /^ {2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  const methods: { name: string; params: string }[] = [];
  for (const match of code.matchAll(declaration)) {
    if (match[1] === 'constructor') continue;
    const open = match.index + match[0].length - 1;
    const close = balancedRegion(code, open, '(', ')');
    methods.push({ name: match[1], params: code.slice(open + 1, close).trim() });
  }
  return methods;
}

/** The text of a `const NAME = { … }` literal, from its opening brace to its matching close. */
function objectLiteral(source: string, declaration: string): string | null {
  const code = codeOf(source);
  const start = code.indexOf(declaration);
  if (start === -1) return null;
  const open = code.indexOf('{', start);
  if (open === -1) return null;
  return code.slice(open, balancedRegion(code, open, '{', '}') + 1);
}

/** The five write methods, and the four reads §8.2/§8.3 perform INSIDE the transaction. */
const WRITE_METHODS = [
  'createInstance',
  'createStepInstances',
  'recordStepDecision',
  'skipPendingStepInstances',
  'settleInstance',
];
const TRANSACTIONAL_READS = [
  'findSelectionCandidates',
  'findPinnedVersion',
  'findSubjectDocument',
  'findInstanceDetail',
];

/**
 * What the execution repository may not reach for: the engine and the catalogue it feeds (§15's
 * "one engine, no second evaluator" — the planner owns both). Declared once, because F asserts
 * with it and G hands it a planted defect: two spellings would let a typo in one make the other
 * green for the wrong reason.
 */
const ENGINE_NAMES =
  /\brules\/|\bevaluateRule\b|\bRuleEngine\b|\bworkflow-condition\b|\bworkflow-facts\b/;

describe('C1 step N: the workflow execution persistence boundary (§5.7, §8, §9, §11, §14.3, §15)', () => {
  it('A. writes ONLY the two runtime tables, and reads only what a plan needs (§14.3)', () => {
    const found = delegationsOf(codeOf(readModule(EXECUTION_FILE)));
    // Non-vacuity first: a scan that matched nothing would pass every assertion below.
    expect(found.length).toBeGreaterThanOrEqual(9);

    const writes = found.filter((entry) => WRITE_OPERATIONS.includes(entry.operation));
    const reads = found.filter((entry) => !WRITE_OPERATIONS.includes(entry.operation));
    expect(writes.length).toBeGreaterThanOrEqual(5);
    expect(reads.length).toBeGreaterThanOrEqual(4);

    // §14.3 positively: the runtime tables are the ONLY ones written, and BOTH of them are — a
    // repository that wrote a configuration row would be step M's writer living in step N's file.
    expect([...new Set(writes.map((entry) => entry.model))].sort()).toEqual(
      [...RUNTIME_TABLES].sort()
    );
    expect(writes.filter((entry) => !RUNTIME_TABLES.includes(entry.model))).toEqual([]);

    // Reads are wider on purpose, and the wide part is PINNED rather than left open: the version
    // being pinned, the step definitions it carries and the document the run is about. Nothing
    // else — not the purchase lines, not a counter, and not the definition row a version label
    // already answers for.
    expect(reads.filter((entry) => !READABLE_TABLES.includes(entry.model))).toEqual([]);
  });

  it('B. makes every write conditional on the RUNTIME status constant (§8.3, §9.3)', () => {
    const regions = updateManyRegions(codeOf(readModule(EXECUTION_FILE)));
    expect(regions).toHaveLength(3);
    const unconditional = regions.filter(
      (region) =>
        !/status: WORKFLOW_STEP_INSTANCE_PENDING|status: WORKFLOW_INSTANCE_RUNNING/.test(region)
    );
    expect(unconditional).toEqual([]);

    // The two transitions the runtime performs, each once per table: a step moves only while it is
    // PENDING, a run settles only while it is RUNNING — and a step's `status` moves WITH the
    // `decision` it recorded, in one statement, so the two can never disagree.
    const code = codeOf(readModule(EXECUTION_FILE));
    expect(/status: WORKFLOW_STEP_INSTANCE_PENDING/.test(code)).toBe(true);
    expect(/status: WORKFLOW_INSTANCE_RUNNING/.test(code)).toBe(true);
    expect(/status: input\.decision,\s*\n\s*decision: input\.decision,/.test(code)).toBe(true);
  });

  it('C. takes the unit of work on every write, and opens no transaction of its own (§8.2, §11)', () => {
    const methods = publicMethodParameters(readModule(EXECUTION_FILE));
    expect(methods.length).toBeGreaterThanOrEqual(10);
    const byName = new Map(methods.map((method) => [method.name, method.params]));

    for (const write of WRITE_METHODS) {
      const params = byName.get(write);
      expect(params).toBeDefined();
      // §15 orders this surface: the tenant first (M's gate C reads the same characters), the
      // handle second — and the handle itself, never the raw client (asserted after the loop).
      expect(params!.startsWith('tenantId: string')).toBe(true);
      expect(params!).toContain('tx: CommerceTransactionHandle');
    }

    // The reads a decision is PLANNED from take the handle too, optionally: §8.3 evaluates the run
    // the transaction is about to write against, and §11's page read outside a transaction is the
    // same statement with no handle to unwrap.
    for (const read of TRANSACTIONAL_READS) {
      const params = byName.get(read);
      expect(params).toBeDefined();
      expect(params!).toContain('tx?: CommerceTransactionHandle');
    }

    // No PUBLIC method names the raw client: unwrapping is a private helper's job, which is what
    // keeps `Prisma.TransactionClient` out of every call site.
    expect(
      methods
        .filter((method) => method.params.includes('Prisma.TransactionClient'))
        .map((method) => method.name)
    ).toEqual([]);

    // The transactions, all in the array form: each page read needs its count and its rows from
    // one snapshot (§11's run page, and C2's inbox page), and an INTERACTIVE transaction here
    // would be a second unit of work beside `CommerceUnitOfWork` — the boundary this file
    // exists to keep. Two reads, so two array-form transactions, every one of them an array.
    const code = codeOf(readModule(EXECUTION_FILE));
    const forms = [...code.matchAll(/\$transaction\s*\(/g)].map((match) =>
      code.slice(match.index, match.index + 40)
    );
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form).toMatch(/\$transaction\(\s*\[/);
    }

    // The unwrapper is called exactly where a statement needs a raw client: the five writes, and
    // the reader that serves the mid-transaction loads.
    expect(code.match(/unwrapCommerceTransaction\(/g) ?? []).toHaveLength(WRITE_METHODS.length + 1);
  });

  it('D. keeps the transaction boundary in the persistence layer (§15, commerce-transaction.ts)', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(20);
    const BOUNDARY_NAMES =
      /\b(?:unwrapCommerceTransaction|CommerceUnitOfWork)\b|Prisma\.TransactionClient/;

    // The client's own home holds it, and every repository receives a HANDLE and unwraps it: those
    // are the two places a client may exist. Anywhere else — a service, a controller, a DTO, a
    // gateway, the planner, the fact catalogue — holding one would be the boundary erosion
    // `commerce-transaction.ts` names.
    const offenders = sourceFiles
      .filter((file) => !file.endsWith('.repository.ts') && name(file) !== BOUNDARY_OWNER)
      .filter((file) => !file.endsWith('.service.ts') && name(file) !== 'commerce.module.ts')
      .filter((file) => BOUNDARY_NAMES.test(codeOf(readModule(file))))
      .map(name);
    expect(offenders).toEqual([]);

    // Non-vacuity: the pattern DOES fire where the client legitimately lives, and the execution
    // repository unwraps rather than opening a transaction of its own.
    expect(codeOf(readModule(join(MODULE_DIR, BOUNDARY_OWNER)))).toMatch(BOUNDARY_NAMES);
    expect(codeOf(readModule(EXECUTION_FILE))).toMatch(/\bunwrapCommerceTransaction\(/);
  });

  it('E. never recomputes a decision on read, and never hides the one that was made (§5.7)', () => {
    const detail = objectLiteral(
      readModule(EXECUTION_FILE),
      'const WORKFLOW_INSTANCE_DETAIL_INCLUDE ='
    );
    expect(detail).not.toBeNull();

    // The persisted explanation: the outcome AND the inputs it was computed from, so a reader
    // renders what actually ran rather than what today's configuration would produce.
    expect(detail!).toContain('conditionResult: true');
    expect(detail!).toContain('conditionInputSnapshot: true');
    // The decision, in the decider's own words — never a recomputed summary.
    expect(detail!).toContain('decision: true');
    expect(detail!).toContain('decisionComment: true');

    // And the rule-bearing columns of the CONFIGURATION are absent from this read: a page that
    // carried today's thresholds beside yesterday's decision would invite exactly the recomputation
    // §5.7 forbids.
    expect(detail!).not.toMatch(/\b(?:thresholds|lineFilters|configuration)\s*:/);
  });

  it('F. evaluates no rule and issues no business decision from the repository (§15)', () => {
    // The engine is the planner's (`workflow-execution.ts`), and the catalogue is
    // `workflow-facts.ts`: a repository that imported either would be a second evaluator.
    expect(offenderFiles(ENGINE_NAMES, [EXECUTION_FILE])).toEqual([]);
  });

  it('G. fails on a PLANTED defect — every scan refuses what it exists to refuse', () => {
    // A. a write to a configuration table is the OTHER slice's job: the pair (model, operation) is
    // what the scan judges, and this fixture is a write to `WorkflowStep`.
    const plantedWrite = delegationsOf(
      'return tx.workflowStep.updateMany({ where: { tenantId } });'
    );
    expect(plantedWrite).toHaveLength(1);
    expect(WRITE_OPERATIONS.includes(plantedWrite[0].operation)).toBe(true);
    expect(RUNTIME_TABLES.includes(plantedWrite[0].model)).toBe(false);
    // …and a READ of the same table is this slice's business, which is why the pair, not the name.
    const plantedRead = delegationsOf('return tx.workflowStep.findMany({ where: { tenantId } });');
    expect(WRITE_OPERATIONS.includes(plantedRead[0].operation)).toBe(false);
    expect(READABLE_TABLES.includes(plantedRead[0].model)).toBe(true);

    // B. an unconditional write is exactly the race the predicate exists to lose.
    const plantedUpdate = updateManyRegions(
      'await tx.workflowStepInstance.updateMany({ where: { id }, data: { status: "APPROVED" } });'
    );
    expect(plantedUpdate).toHaveLength(1);
    expect(
      /status: WORKFLOW_STEP_INSTANCE_PENDING|status: WORKFLOW_INSTANCE_RUNNING/.test(
        plantedUpdate[0]
      )
    ).toBe(false);

    // C. the handle is the SECOND parameter, and the surface carries no raw client.
    const plantedSurface = publicMethodParameters(
      [
        'class Leak {',
        '  async createInstance(tx: CommerceTransactionHandle, tenantId: string) {',
        '    return tx;',
        '  }',
        '  async raw(tenantId: string, tx: Prisma.TransactionClient) {',
        '    return tx;',
        '  }',
        '}',
      ].join('\n')
    );
    expect(plantedSurface).toHaveLength(2);
    expect(plantedSurface[0].params.startsWith('tenantId: string')).toBe(false);
    expect(plantedSurface[1].params.startsWith('tenantId: string')).toBe(true);
    expect(plantedSurface[1].params.includes('Prisma.TransactionClient')).toBe(true);
    // An interactive transaction is refused by the array-form predicate this spec asserts on.
    expect(
      /\$transaction\(\s*\[/.test(
        codeOf(
          'return this.prisma.$transaction(async (client) => client.workflowInstance.create({}));'
        )
      )
    ).toBe(false);

    // D. a service holding a unit of work — or a client — is the erosion the boundary forbids,
    // while a COMMENT that explains the rule is not.
    const BOUNDARY_NAMES =
      /\b(?:unwrapCommerceTransaction|CommerceUnitOfWork)\b|Prisma\.TransactionClient/;
    expect(
      BOUNDARY_NAMES.test(codeOf('constructor(private readonly unit: CommerceUnitOfWork) {}'))
    ).toBe(true);
    expect(BOUNDARY_NAMES.test(codeOf('// a service never holds a CommerceUnitOfWork'))).toBe(
      false
    );

    // E. a read that selected today's thresholds would pass every other assertion here.
    const plantedInclude = objectLiteral(
      'const X = { select: { thresholds: true } };',
      'const X ='
    );
    expect(plantedInclude).toMatch(/\b(?:thresholds|lineFilters|configuration)\s*:/);

    // F. a rule evaluation reached from the repository would be a second engine — refused by the
    // SAME pattern F asserts with, and a comment that says so is still not a defect.
    expect(ENGINE_NAMES.test(codeOf("import { evaluateRule } from './workflow-condition';"))).toBe(
      true
    );
    expect(ENGINE_NAMES.test(codeOf('// the repository never evaluates a rule'))).toBe(false);
  });
});
