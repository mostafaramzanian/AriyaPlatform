import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase C1 Step M (§5.5–§5.8, §20, §21): the workflow CONFIGURATION repository read BACK as
 * text — the executable form of the promises `workflow-configuration.repository.ts` states in
 * its own header, joined to the ones `purchase.repository.ts` already stated for step L.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every promise below is a promise about what the source does NOT contain ("no `findUnique`",
 * "no statement touches `PurchaseDocument`", "raw SQL stays in the persistence layer"), and no
 * type checks an absence. A statement added back into a service — the exact way a persistence
 * boundary is lost — compiles, boots, and passes every unit test that mocks the repository;
 * only a scan of the source notices that `this.prisma.` appeared where it does not belong.
 * The scan is TEXT, like `commerce-schema.spec.ts` and `commerce-entitlement.spec.ts`, and for
 * the same reason: the files it joins (repository ↔ repository, slice ↔ slice) import nothing
 * from each other, so "the same rule, in both places" is the only statement available.
 *
 * WHAT IS PINNED, AND WHY EACH PIN IS FALSIFIABLE
 * ----------------------------------------------
 *  A. every Prisma statement in the module is issued from a `.repository.ts` file, and the set
 *     of repositories is asserted BY NAME — a third repository, or a service's first statement,
 *     is a deliberate edit to this gate;
 *  B. `findUnique`/`findUniqueOrThrow` appear NOWHERE — the one Prisma read that cannot carry a
 *     tenant predicate (a "find by id" written with it reads another tenant's workflow for an
 *     id that happened to collide) — and neither repository performs an unconditional
 *     `.update(`/`.delete(` on a unique key: every write states its condition in `where`;
 *  C. `tenantId` is the FIRST parameter of every public repository method, and EVERY `where`
 *     fragment — inline or hoisted — names the tenant;
 *  D. raw SQL stays in the persistence layer, names the tenant COLUMN, and the workflow slice
 *     holds none at all (step M owns no counter and no upsert);
 *  E. §20/§21/§5.9 as absences: no file in the workflow slice names `WorkflowInstance`,
 *     `WorkflowStepInstance`, `PurchaseDocument`, `PurchaseLine` or the purchase counter — the
 *     prohibition on execution is enforced by there being no statement to execute — and the
 *     purchase slice names no workflow table;
 *  F. the persistence layer records no audit and publishes no event: the trail is the service's
 *     (§I8), and a repository that wrote one would be a second place the envelope is built.
 *
 * NON-VACUITY. Every scan asserts the number of things it read (§4: "do not create tests that
 * technically exist but can pass because the scan matches zero files"): the repository list is
 * compared exactly, the method, `where` and raw-SQL scans each carry a floor, and G hands the
 * `findUnique`, method, `where` and raw-SQL scans a PLANTED defect and requires each to refuse
 * it — a guard that cannot fail is a comment.
 */

const MODULE_DIR = join(__dirname, '..');

/**
 * The files allowed to issue a statement — asserted by NAME, never discovered. FOUR
 * since §14.3 split this guard: step N adds `workflow-execution.repository.ts` for the
 * two RUNTIME tables, and the split is what keeps each side's absences assertable — the
 * configuration repository still writes no instance row, the execution one writes no
 * configuration row. Step P adds its two commercial repositories the same way: they own
 * `CommercialGroup`/`CommercialConfigurationVersion` and the three lifecycle tables.
 * Step Q adds the SEVENTH, `payment/payment-history.repository.ts`, whose surface is
 * append plus tenant-scoped reads only (contract §3-A: no update and no delete exist in
 * the file), and no other file in the module may touch any of the seven.
 *
 * Step R adds the EIGHTH, `receiving/receiving-history.repository.ts` (contract §13:
 * "gains exactly the eighth name"), and step S the NINTH,
 * `returns/return-history.repository.ts` (S contract §13: "a ninth name — exactly the
 * deliberate edit its header anticipates"). Both are append-only histories of the same
 * write shape as Q's — `.create(` for the row (and its lines, nested) plus tenant-scoped
 * reads — so the `updateMany`-or-`create` branch below already covers them and no further
 * edit to this gate is needed for either. The name list stays asserted EXACTLY: a tenth
 * repository, or a slice that reaches for `commerce_db` from a service, still fails
 * here by name.
 */
const REPOSITORY_NAMES = [
  'commercial/commercial-configuration.repository.ts',
  'commercial/commercial-lifecycle.repository.ts',
  // PHASE C4-R (GAP-3): the completion policy's persistence boundary — one model,
  // `PurchaseCompletionPolicyVersion`, and no cross-slice read at all.
  'completion/purchase-completion-policy.repository.ts',
  // PHASE W2-B: the integration slice's persistence boundary — `InventoryPosting`,
  // the durable posting record, and no cross-slice read at all.
  'integration/inventory-posting.repository.ts',
  'payment/payment-history.repository.ts',
  // PAYMENT PLAN (دستور پرداخت): the instruction slice's persistence boundary —
  // `PaymentPlan` + nested `PaymentInstallment`, lifecycle `updateMany` only,
  // and the document/payment reads its gates need. `PaymentRecord` stays the
  // payment history's sole writer.
  'payment-plan/payment-plan.repository.ts',
  // PHASE W3.2: the aggregated traceability read's persistence boundary —
  // tenant-scoped reads across receipt, return, payment, plan and posting
  // rows for ONE document. READ-ONLY by contract (see below): it holds no
  // write path at all, so it is pinned in READ_ONLY_REPOSITORIES instead of
  // being forced to grow a write the rule below exists to shape.
  'purchase/purchase-history.repository.ts',
  'purchase/purchase.repository.ts',
  // PHASE GAP-6: the price quotation's persistence boundary — `PriceQuotation` /
  // `QuotationLine` (nested) plus its audit outbox row, and the ONE cross-slice
  // read every child lifecycle shares (the parent document's status).
  'quotation/quotation.repository.ts',
  'receiving/receiving-history.repository.ts',
  'returns/return-history.repository.ts',
  // SUPPLIER MASTER DATA: the supplier directory's persistence boundary —
  // `Supplier` plus its audit outbox row, and the two cross-slice READ seams
  // (purchase documents and quotations that name a supplier).
  'supplier/supplier.repository.ts',
  'workflow/workflow-configuration.repository.ts',
  'workflow/workflow-execution.repository.ts',
  'workflow/workflow-line-routing.repository.ts',
];

/**
 * PHASE W3.2: repositories that hold NO write path at all — pure read
 * boundaries. The `.updateMany(`/`.create(` requirement below exists to force
 * conditional writes where writes exist; demanding one from a read-only file
 * would force it to grow exactly the write its contract forbids. Membership
 * here is a deliberate edit — a write path appearing in one of these files
 * without leaving this list is still caught by the write-shape assertion on
 * the OTHER repositories.
 */
const READ_ONLY_REPOSITORIES = ['purchase/purchase-history.repository.ts'];

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
 * Comment lines dropped before scanning. Without this the guard would report its own
 * neighbours for QUOTING a forbidden model in documentation — the repository's header names
 * `WorkflowInstance` to explain that it never writes it, and dropping that sentence to satisfy
 * a test would delete the explanation rather than the defect.
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

/** A file's CODE: no comment-only lines, no trailing `//` comments. Prose disappears entirely. */
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

const repositories = sourceFiles.filter((file) => file.endsWith('.repository.ts'));

/**
 * The index of the character that closes the region opened at `open`, counting nesting and
 * ignoring quoted text — the scans below need whole object literals and whole parameter lists,
 * not single lines, because a repository states a `where` across as many lines as it reads
 * best on and a method's parameters the same way.
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

/**
 * The index of the backtick closing the template literal opened at `open`. `balancedRegion`
 * cannot serve here — it treats a backtick as a quote and would jump to the NEXT one — while a
 * statement's `${…}` interpolations must be skipped as a whole, since a formatted expression
 * may carry braces of its own.
 */
function templateEnd(code: string, open: number): number {
  for (let index = open + 1; index < code.length; index += 1) {
    const char = code[index];
    if (char === '\\') index += 1;
    else if (char === '`') return index;
    else if (char === '$' && code[index + 1] === '{') {
      index = balancedRegion(code, index + 1, '{', '}');
    }
  }
  return code.length - 1;
}

const lineAt = (code: string, index: number) => code.slice(0, index).split('\n').length;

/**
 * Every PUBLIC method's parameter list, taken from the class body: the method name through its
 * matching `)`.
 *
 * `private`, `static` and `constructor` are excluded deliberately rather than by oversight: a
 * private helper receives `tx` — the transaction client it was called ON — as its first
 * parameter, and the tenant is the caller's to pass down, not the helper's to discover. The
 * rule this scan states is about the SURFACE the service calls: a missing tenant there is
 * missing in every call site, while a helper's `tx` is the same client its caller scoped.
 */
function publicMethodParameters(source: string): { name: string; params: string }[] {
  const code = codeOf(source);
  const declaration = /^ {2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  const methods: { name: string; params: string }[] = [];
  for (const match of code.matchAll(declaration)) {
    if (match[1] === 'constructor') continue;
    const open = match.index + match[0].length - 1;
    const close = balancedRegion(code, open, '(', ')');
    methods.push({ name: match[1], params: code.slice(open + 1, close) });
  }
  return methods;
}

/**
 * Every fragment a tenant predicate could live in: the object literal after `where:` (inline)
 * and the initialiser of a hoisted `const where` (handed to a call as a bare `where`).
 *
 * Only the INITIALISER of a hoisted variable is scanned — the guard cannot see which call
 * consumes the variable, exactly as the HR isolation guard records for its own hoisted wheres,
 * so the initialiser is where the rule must hold.
 */
function whereFragments(source: string): { line: number; fragment: string }[] {
  const code = codeOf(source);
  const starts = /(?:where\s*:\s*|const\s+where\b[^{=]*=)\s*\{/g;
  const fragments: { line: number; fragment: string }[] = [];
  for (const match of code.matchAll(starts)) {
    const open = match.index + match[0].length - 1;
    const close = balancedRegion(code, open, '{', '}');
    fragments.push({ line: lineAt(code, match.index), fragment: code.slice(open, close + 1) });
  }
  return fragments;
}

/** Every raw-SQL statement, as the whole tagged template that issues it. */
function rawSqlStatements(source: string): { line: number; statement: string }[] {
  const code = codeOf(source);
  const starts = /\$(?:queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b[^`]*`/g;
  const statements: { line: number; statement: string }[] = [];
  for (const match of code.matchAll(starts)) {
    const open = match.index + match[0].length - 1;
    statements.push({
      line: lineAt(code, match.index),
      statement: code.slice(open, templateEnd(code, open) + 1),
    });
  }
  return statements;
}

describe('C1 step M: the workflow configuration persistence boundary (§5.5–§5.8, §20, §21)', () => {
  it('A. issues every statement from a repository, and the repository set is pinned by name', () => {
    // Non-vacuity first: the scans below are module-wide, so the module they read must be the
    // real one — a walk that found nothing would pass every one of them.
    expect(sourceFiles.length).toBeGreaterThanOrEqual(20);
    expect(repositories.map(name).sort()).toEqual([...REPOSITORY_NAMES].sort());

    // The persistence layer is the ONLY place a statement is issued. `database/` is the client's
    // own home and `commerce.module.ts` the composition root that imports it; anywhere else — a
    // service, a controller, a DTO, a gateway, a pure rule file — a client or its generated
    // types would be a second persistence boundary, and nothing but this scan would notice.
    // Phase B2.3: the relay service directly uses CommercePrismaService to poll/manage the outbox.
    const allowed = [
      ...repositories,
      join(MODULE_DIR, 'commerce.module.ts'),
      join(MODULE_DIR, 'commerce-audit-outbox-relay.service.ts'),
    ];
    const offenders = sourceFiles
      .filter((file) => !allowed.includes(file) && !name(file).startsWith('database/'))
      .filter((file) =>
        /this\.prisma\.|CommercePrismaService|generated\/commerce-client/.test(
          codeOf(readModule(file))
        )
      )
      .map(name);
    expect(offenders).toEqual([]);
  });

  it('B. reads by condition, never by a unique key alone — findUnique cannot carry the tenant', () => {
    // The one Prisma read that cannot take a tenant predicate, so a "find by id" written with it
    // reads another tenant's workflow for an id that happened to collide. Asserted over the WHOLE
    // module rather than the persistence layer alone: the import is what a service would reach
    // for, and by then the statement is already written.
    expect(offenderFiles(/\.findUnique\(|\.findUniqueOrThrow\(/)).toEqual([]);

    // A conditional write expresses "only if it still matches this predicate" — which is what
    // makes two concurrent publishes impossible rather than unlikely. `update` and `delete`
    // target a unique key and can express nothing else; each repository uses the plural forms
    // — OR, since step Q (contract §3-A), performs NO row-mutating write beyond `.create(`:
    // an append-only repository can never contain an `updateMany`, and a rule that demanded
    // one would force it to grow exactly the write the contract forbids.
    for (const file of repositories) {
      const code = codeOf(readModule(file));
      expect(code).not.toMatch(/\.update\(|\.delete\(/);
      if (READ_ONLY_REPOSITORIES.includes(name(file))) {
        // A read boundary asserts the STRONGER shape: no mutating call at all.
        expect(code).not.toMatch(/\.updateMany\(|\.create\(|\.createMany\(|\.upsert\(|\.deleteMany\(/);
        continue;
      }
      expect(code).toMatch(/\.updateMany\(|\.create\(/);
    }

    // Step Q's repository is additionally pinned BY METHOD NAME (contract §3-A): append
    // plus tenant-scoped reads is the whole surface, and an `updatePayment` that appeared
    // with a "just this once" fix would rewrite a settled row — the exact absence the
    // repository's own header promises. A new public method is therefore a deliberate
    // edit to this gate, not a silent addition.
    // PHASE REPORTING-COMMERCE-PAYMENT-HISTORY: the report register gains exactly THREE
    // tenant-scoped reads — `listReportPage`, `countReportByMethod`, `findReportRow` —
    // each taking `tenantId` first (checked by C below) and none of them a write. The
    // pin grows with them, by name: a fourth would be a second deliberate edit.
    //
    // PHASE W4-B / W4-C (lock-order unification, `docs/reports/PHASE-W4-DECISIONS.md` §1):
    // NINE names arrive or leave, and the change is DELIBERATE on both edges:
    //
    //   outgoing — `findCompensation`. It was the read half of the withdrawn
    //     "at most one compensation per payment" rule. W4-B replaced that rule with
    //     REQUESTED/partial refunds under a cumulative cap, so the single-compensation
    //     probe has no caller left anywhere in the module: the compensation path reads
    //     `lockDocumentForPayment` → `lockPaymentForCompensation` →
    //     `findPaymentForCompensation` → `sumCompensations` (payment-history.service.ts
    //     `compensateIn`). A repository method with no call site is not kept "just in
    //     case" — the pin records the surface that EXISTS.
    //
    //   incoming — `lockDocumentForPayment`, `lockPaymentForCompensation` and
    //     `sumCompensations`. Two issue `SELECT … FOR UPDATE` and one an aggregate, all
    //     inside the CALLER's unit of work, so a return refund and a manual compensation
    //     serialize on the SAME first lock (PurchaseDocument FOR UPDATE → PaymentRecord
    //     FOR UPDATE → aggregates → INSERT). That ordering is what makes the refundable
    //     capacity unraceable: without the payment lock two concurrent partial refunds
    //     could both read the same remaining capacity.
    //
    // Each new method takes `tenantId` first (checked by C below), each is confined to
    // the caller's `tx`, and NONE of them is a write — no `update`, no `delete`, no
    // second INSERT. The append-only promise this file's header makes is unchanged:
    // `append` remains the only statement here that can add a row. Any further silent
    // addition — or re-addition — still fails this test, deliberately.
    const paymentRepository = repositories.find(
      (file) => name(file) === 'payment/payment-history.repository.ts'
    );
    expect(paymentRepository).toBeDefined();
    expect(
      publicMethodParameters(readModule(paymentRepository as string))
        .map((method) => method.name)
        .sort()
    ).toEqual(
      [
        'append',
        'countReportByMethod',
        'findDocumentForPayment',
        'findPaymentForCompensation',
        'findReportRow',
        'listReportPage',
        'lockDocumentForPayment',
        'lockPaymentForCompensation',
        'readPaymentPage',
        'sumCompensations',
      ].sort()
    );
  });

  it('C. states the tenant FIRST on every public method, and names it in EVERY where', () => {
    let methodsChecked = 0;
    const untenantedMethods: string[] = [];
    for (const file of repositories) {
      for (const { name: method, params } of publicMethodParameters(readModule(file))) {
        methodsChecked += 1;
        if (!params.trimStart().startsWith('tenantId: string')) {
          untenantedMethods.push(`${name(file)}: ${method}(...) does not take tenantId first`);
        }
      }
    }
    expect(untenantedMethods).toEqual([]);
    // A floor, so a signature parser that matched nothing cannot pass: 15 public methods in the
    // configuration repository, 10 in the execution one and 5 in the purchase one today, and
    // every count only grows.
    expect(methodsChecked).toBeGreaterThanOrEqual(18);

    let fragmentsChecked = 0;
    const untenantedWheres: string[] = [];
    for (const file of repositories) {
      for (const { line, fragment } of whereFragments(readModule(file))) {
        fragmentsChecked += 1;
        if (!fragment.includes('tenantId')) {
          untenantedWheres.push(`${name(file)}:${line} has no tenant predicate`);
        }
      }
    }
    expect(untenantedWheres).toEqual([]);
    expect(fragmentsChecked).toBeGreaterThanOrEqual(18);
  });

  it('D. keeps raw SQL in the persistence layer, where it states the tenant COLUMN', () => {
    // The platform precedent accepts raw SQL where Prisma's typed API cannot express the
    // statement — the counter's `ON CONFLICT … RETURNING` upsert. What it does not accept is raw
    // SQL written anywhere else, or one that leaves tenancy to a default: raw SQL has no `where`
    // for the scan above to read, so the COLUMN is the check.
    const owners = sourceFiles.filter((file) => rawSqlStatements(readModule(file)).length > 0);
    expect(owners.filter((file) => !file.endsWith('.repository.ts')).map(name)).toEqual([]);

    let statementsChecked = 0;
    const untenanted: string[] = [];
    for (const file of owners) {
      for (const { line, statement } of rawSqlStatements(readModule(file))) {
        statementsChecked += 1;
        if (!statement.includes('"tenant_id"')) {
          untenanted.push(`${name(file)}:${line} names no tenant column`);
        }
      }
    }
    expect(untenanted).toEqual([]);
    expect(statementsChecked).toBeGreaterThanOrEqual(1);

    // Step M owns no counter and no upsert, so the workflow slice issues NO raw SQL: a statement
    // added there would be the first, and this fails on it rather than on a review nobody did.
    const workflowSources = sourceFiles.filter((file) => name(file).startsWith('workflow/'));
    expect(workflowSources.length).toBeGreaterThanOrEqual(7);
    expect(
      workflowSources.filter((file) => rawSqlStatements(readModule(file)).length > 0).map(name)
    ).toEqual([]);
  });

  it('E. touches no execution table and no purchase row — §20, §21 and §5.9 as absences', () => {
    const workflowSources = sourceFiles.filter((file) => name(file).startsWith('workflow/'));
    // §14.3 SPLIT, the half that stayed. Step N owns the two RUNTIME tables, so the files of the
    // execution side NAME `WorkflowInstance`, `WorkflowStepInstance` and the document a run is
    // about — that is their subject, and their own guard (`workflow-execution.guards.spec.ts`)
    // pins what they must not name and must not do. What THIS spec keeps pinning is the
    // CONFIGURATION side: the files below may not name execution or purchase at all, so a
    // statement added to one of them still fails here rather than on a review nobody did.
    const EXECUTION_SLICE_FILES = [
      'workflow/workflow-execution.repository.ts',
      'workflow/workflow-execution.ts',
      'workflow/workflow-execution.service.ts',
      'workflow/workflow-facts.ts',
      'workflow/workflow-run-status.ts',
      'workflow/workflow-line-routing.ts',
      'workflow/workflow-line-routing.service.ts',
      'workflow/workflow-line-routing.repository.ts',
    ];
    const configurationSources = workflowSources.filter(
      (file) => !EXECUTION_SLICE_FILES.includes(name(file))
    );
    expect(configurationSources.length).toBeGreaterThanOrEqual(7);
    // §20's prohibition on EXECUTION is enforced by there being no statement to execute: no file
    // in this slice may name `WorkflowInstance`, `WorkflowStepInstance`, `PurchaseDocument`,
    // `PurchaseLine` or the purchase counter — not even as a TYPE, which is why this scan reads
    // code rather than statements alone.
    const EXECUTION = /\b(?:WorkflowInstance|WorkflowStepInstance|PurchaseDocumentCounter)\b/;
    const PURCHASE = /\b(?:PurchaseDocument|PurchaseLine)\b/;
    expect(offenderFiles(EXECUTION, configurationSources)).toEqual([]);
    expect(offenderFiles(PURCHASE, configurationSources)).toEqual([]);
    // Nor does the CONFIGURATION slice reach across its own boundary: no purchase module, no Core
    // client, no HR client. A configuration change may not affect a purchase that is already
    // running. The EXECUTION side is exempt for one stated reason and no other: it must read the
    // document it is about (`workflow-facts.ts` takes the purchase KIND vocabulary, and the
    // repository reads the document row), which is the subject of §8.2 — not a configuration
    // concern leaking sideways.
    expect(
      offenderFiles(/from '[^']*purchase\/|core-client|hr-client/, configurationSources)
    ).toEqual([]);

    // And the reverse — §5.11's three prohibitions cannot be crossed from that side either:
    // purchase names no workflow table, so no document status can become a workflow status.
    const purchaseSources = sourceFiles.filter((file) => name(file).startsWith('purchase/'));
    expect(purchaseSources.length).toBeGreaterThanOrEqual(7);
    expect(
      offenderFiles(
        /\b(?:WorkflowDefinition|WorkflowDefinitionVersion|WorkflowStep|WorkflowInstance)\b/,
        purchaseSources
      )
    ).toEqual([]);
  });

  it('F. records no audit and publishes no event from the persistence layer', () => {
    // §I8 gives the TRAIL to the service and the envelope to the gateway: a repository that
    // recorded an event would build a second envelope, and one that published would make a
    // storage detail an integration one. The service specs assert what IS recorded; this
    // asserts the layer that must stay silent.
    expect(
      offenderFiles(
        /CommerceAuditGateway|CommerceNotificationGateway|\baudit\.record\b|\bnotification\.publish\b/,
        repositories
      )
    ).toEqual([]);
  });

  it('G. fails on a PLANTED defect — every scan refuses what it exists to refuse', () => {
    // The floors in A/C/D prove the scans matched something REAL; they cannot prove the scans
    // REJECT. A guard that cannot fail is a comment, so each one is handed its own defect here,
    // in synthetic text, and must refuse it. These fixtures are why the assertions above are
    // worth trusting when they are green.
    expect(codeOf('  // WorkflowInstance\n')).not.toMatch(/\bWorkflowInstance\b/);
    expect(codeOf('const x = 1; // PurchaseDocument\n')).not.toMatch(/\bPurchaseDocument\b/);
    expect(codeOf("const x = 'a // b'; // ok\n")).toContain("'a // b'");

    const uniqueRead = 'return this.prisma.workflowDefinition.findUnique({ where: { id } });';
    // The pattern B runs over every file, run here over text that CONTAINS the defect: a pattern
    // that no longer fires would make B green for the wrong reason.
    expect(/\.findUnique\(|\.findUniqueOrThrow\(/.test(codeOf(uniqueRead))).toBe(true);

    const plantedMethods = publicMethodParameters(
      ['class Leak {', '  async find(id: string) {', '    return id;', '  }', '}'].join('\n')
    );
    expect(plantedMethods).toHaveLength(1);
    expect(plantedMethods[0].params.trimStart().startsWith('tenantId: string')).toBe(false);
    const scopedMethods = publicMethodParameters(
      [
        'class Scoped {',
        '  async find(tenantId: string, id: string) {',
        '    return id;',
        '  }',
        '}',
      ].join('\n')
    );
    expect(scopedMethods).toHaveLength(1);
    expect(scopedMethods[0].params.trimStart().startsWith('tenantId: string')).toBe(true);

    // Both shapes a tenant could hide in: the literal after `where:` and a hoisted initialiser —
    // and NOT the shorthand `{ where }` of a call, which the regex skips on purpose (the scan
    // judges the initialiser, never the call that consumes it).
    expect(whereFragments('return x.findFirst({ where: { id: 1 } });')).toHaveLength(1);
    expect(whereFragments('return x.findFirst({ where: { id: 1 } });')[0].fragment).not.toContain(
      'tenantId'
    );
    expect(whereFragments('return x.count({ where });')).toEqual([]);
    const hoisted = whereFragments('return x.count({ where });\nconst where = { id: 1 };');
    expect(hoisted).toHaveLength(1);
    expect(hoisted[0].fragment).not.toContain('tenantId');
    expect(
      whereFragments('return x.findFirst({ where: { tenantId, id } });')[0].fragment
    ).toContain('tenantId');

    // Raw SQL: the whole template is read — generic type arguments between the tag and the
    // backtick, `${…}` interpolations skipped as one unit — and the tenant column named or not.
    const plantedSql = rawSqlStatements('return this.prisma.$queryRaw`SELECT ${where}`;');
    expect(plantedSql).toHaveLength(1);
    expect(plantedSql[0].statement).toBe('`SELECT ${where}`');
    expect(plantedSql[0].statement).not.toContain('"tenant_id"');
    const typed = rawSqlStatements(
      'const rows = await tx.$queryRaw<Array<{ counter: number }>>`\n' +
        '  INSERT INTO "PurchaseDocumentCounter" ("id", "tenant_id", "kind")\n' +
        '  VALUES (gen_random_uuid(), ${tenantId}, ${kind}::"PurchaseDocumentKind")\n' +
        '  ON CONFLICT ("tenant_id", "kind") DO UPDATE SET "counter" = 1\n' +
        '  RETURNING "counter"`;'
    );
    expect(typed).toHaveLength(1);
    expect(typed[0].statement).toContain('"tenant_id"');
    expect(typed[0].statement).toContain('RETURNING "counter"');

    // F: the pattern that keeps the persistence layer silent, over text that trips it — the
    // negative in F is only worth trusting if this predicate fires on something.
    expect(
      /CommerceAuditGateway|CommerceNotificationGateway|\baudit\.record\b|\bnotification\.publish\b/.test(
        codeOf('await this.audit.record(actor, act);')
      )
    ).toBe(true);
    expect(
      /CommerceAuditGateway|CommerceNotificationGateway|\baudit\.record\b|\bnotification\.publish\b/.test(
        codeOf('// the service calls this.audit.record, never the repository')
      )
    ).toBe(false);
  });
});
