import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { RuleFieldCatalogue } from './rule-condition.interface';
import { EvaluationContext } from './rule-evaluation.interface';
import { RuleSpec, RuleSetVersion } from './rule-spec.interface';
import { RULE_ENGINE_SCHEMA_VERSION } from './core/rule-limits';
import { evaluateRuleSetVersion } from './core/rule-evaluator';

/**
 * §38.2 gate 1 — the **pure-evaluator gate**.
 *
 * Two claims, and both must be able to fail:
 *
 *  1. *Determinism.* One version, one context and one instant produce an identical result across
 *     repeated runs **and** across permutations of the rules' declared order — because ordering is
 *     computed from the definition (§12.1), never from array position.
 *  2. *Purity, as a module graph rather than a convention.* The engine tier is allowed to import only
 *     its own files, and no file of the engine folder may read a clock, a random source, an
 *     environment variable or a logger. The detection is asserted against a known-bad snippet, so a
 *     detector that silently stopped matching would fail this spec instead of passing it.
 */

const FIXTURE_INSTANT = '2024-06-01T00:00:00.000Z';

const CATALOGUE: RuleFieldCatalogue = [
  { name: 'employmentType', type: 'enum', enumValues: ['PERMANENT', 'CONTRACT'] },
  { name: 'leaveType', type: 'enum', enumValues: ['SICK', 'ANNUAL'] },
  { name: 'days', type: 'number' },
  /** Declared by the catalogue, deliberately absent from the fixture context: an undecidable fact. */
  { name: 'requestedFrom', type: 'string' },
];

/** Rules declared out of ranking order on purpose: nothing may depend on the array order. */
const RULES: readonly RuleSpec[] = [
  {
    id: 'hr.leave.gate.notify',
    version: '1',
    name: 'Notify the employee',
    priority: 20,
    condition: { field: 'leaveType', op: 'equals', value: 'SICK' },
    actions: [
      {
        type: 'NOTIFY',
        templateRef: 'template.hr.sick.notice',
        recipientRole: 'EMPLOYEE',
      },
    ],
  },
  {
    id: 'hr.leave.gate.step',
    version: '1',
    name: 'Requires manager approval',
    priority: 10,
    condition: {
      all: [
        { field: 'employmentType', op: 'equals', value: 'CONTRACT' },
        { field: 'days', op: 'greaterThan', value: 10 },
      ],
    },
    actions: [
      { type: 'REQUIRED_APPROVAL_STEP', stepOrder: 1, approverRuleRef: 'approver.manager' },
    ],
  },
  {
    id: 'hr.leave.gate.anyday',
    version: '1',
    name: 'Any recorded day',
    priority: 5,
    condition: { field: 'days', op: 'greaterThanOrEqual', value: 1 },
    actions: [{ type: 'AUTO_APPROVE' }],
  },
  {
    id: 'hr.leave.gate.unknown',
    version: '1',
    name: 'Reads a fact the context may not state',
    priority: 1,
    condition: { field: 'requestedFrom', op: 'equals', value: 'HR' },
    actions: [{ type: 'AUTO_REJECT', reasonCode: 'context.gap' }],
  },
];

function versionOf(rules: readonly RuleSpec[]): RuleSetVersion {
  return {
    ruleSetId: 'hr.leave.gate',
    version: '1',
    status: 'PUBLISHED',
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: CATALOGUE,
    rules,
  };
}

const CONTEXT: EvaluationContext = {
  evaluationInstant: FIXTURE_INSTANT,
  facts: {
    employmentType: 'PERMANENT',
    leaveType: 'SICK',
    days: 3,
  },
};

/** Every permutation of a small array, so "property-style" means exhaustive here, not sampled. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ])
  );
}

describe('§38.2 gate 1 — the evaluator is pure and deterministic', () => {
  it('produces an identical result across repeated runs', () => {
    const version = versionOf(RULES);

    const first = evaluateRuleSetVersion({ ruleSetVersion: version, context: CONTEXT });
    const second = evaluateRuleSetVersion({ ruleSetVersion: version, context: CONTEXT });
    const third = evaluateRuleSetVersion({ ruleSetVersion: version, context: CONTEXT });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.status).toBe('DECIDED');
    expect(first.winningRule?.ruleId).toBe('hr.leave.gate.notify');
  });

  it('produces an identical outcome for every permutation of the declared rule order', () => {
    const baseline = evaluateRuleSetVersion({
      ruleSetVersion: versionOf(RULES),
      context: CONTEXT,
    });

    const observed = permutations(RULES).map((permuted) =>
      evaluateRuleSetVersion({
        ruleSetVersion: versionOf(permuted),
        context: CONTEXT,
      })
    );

    expect(observed).toHaveLength(24);
    for (const result of observed) {
      expect(result.decision).toEqual(baseline.decision);
      expect(result.status).toBe(baseline.status);
      expect(result.winningRule).toEqual(baseline.winningRule);
      expect(result.explanationText).toBe(baseline.explanationText);
      expect(result.matchHistory.map((record) => record.ruleId)).toEqual(
        baseline.matchHistory.map((record) => record.ruleId)
      );
      expect(result.matchHistory.map((record) => record.failedLeaves)).toEqual(
        baseline.matchHistory.map((record) => record.failedLeaves)
      );
      expect(result.validation.ordering).toEqual(baseline.validation.ordering);
    }
  });

  it('reports an undecidable rule without letting it decide or block the winner', () => {
    const result = evaluateRuleSetVersion({
      ruleSetVersion: versionOf(RULES),
      context: CONTEXT,
    });
    const undecidable = result.matchHistory.find(
      (record) => record.ruleId === 'hr.leave.gate.unknown'
    );

    expect(undecidable?.conditionOutcome).toBe('UNKNOWN');
    expect(undecidable?.matched).toBe(false);
    expect(result.missingFields).toContain('requestedFrom');
    expect(result.status).toBe('DECIDED');
  });
});

/**
 * The purity contract, read from the syntax tree rather than from the text of a file: a doc comment
 * that says "no clock" is documentation, while a `Date.now()` call is a clock read.
 */
const ENGINE_ROOT = __dirname;
const PURE_TIER = path.join(ENGINE_ROOT, 'core');
const ALLOWED_PACKAGES: readonly string[] = Object.freeze(['@nestjs/common']);
const FORBIDDEN_API: readonly RegExp[] = Object.freeze([
  /\bDate\.now\b/,
  /\bnew Date\b/,
  /\bMath\.random\b/,
  /\bprocess\.env\b/,
  /\brequire\s*\(/,
  /\bconsole\./,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bfetch\s*\(/,
]);

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return entry.name.endsWith('.ts') ? [target] : [];
  });
}

function importSpecifiersIn(sourceText: string): string[] {
  const source = ts.createSourceFile('scan.ts', sourceText, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    return [statement.moduleSpecifier.text];
  });
}

function apiUsesIn(sourceText: string): string[] {
  const source = ts.createSourceFile('scan.ts', sourceText, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      const text = node.getText(source);
      for (const pattern of FORBIDDEN_API) {
        if (pattern.test(text)) hits.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const relative = (file: string): string => path.relative(ENGINE_ROOT, file).replace(/\\/g, '/');

describe('§38.2 gate 1 — the engine folder is framework-free and clock-free', () => {
  const files = filesUnder(ENGINE_ROOT);
  /**
   * Test code is excluded from the module-graph contract, visibly: a spec may legitimately import
   * `fs` or `typescript` to inspect the engine, an engine module may not. The exclusion cannot hide
   * an impurity in the pure tier, because the assertion below refuses a spec placed there.
   */
  const modules = files.filter((file) => !file.endsWith('.spec.ts'));

  it('scans the engine it claims to scan, and its pure tier holds no test files', () => {
    expect(modules.some((file) => file.endsWith(path.join('core', 'rule-evaluator.ts')))).toBe(
      true
    );
    expect(modules.some((file) => file.endsWith('rule-engine.service.ts'))).toBe(true);
    expect(modules.length).toBeGreaterThan(18);
    expect(filesUnder(PURE_TIER).some((file) => file.endsWith('.spec.ts'))).toBe(false);
  });

  it('imports nothing but its own files and the Nest decorators', () => {
    const offenders = modules.flatMap((file) =>
      importSpecifiersIn(read(file))
        .filter((specifier) => !specifier.startsWith('.') && !ALLOWED_PACKAGES.includes(specifier))
        .map((specifier) => `${relative(file)} imports "${specifier}"`)
    );

    expect(offenders).toEqual([]);
  });

  it('lets the pure tier import only the pure tier', () => {
    const offenders = filesUnder(PURE_TIER).flatMap((file) =>
      importSpecifiersIn(read(file))
        .filter((specifier) => !specifier.startsWith('.'))
        .map((specifier) => `${relative(file)} imports "${specifier}"`)
    );

    expect(offenders).toEqual([]);
  });

  it('reads no clock, no randomness, no environment and no logger', () => {
    const offenders = modules.flatMap((file) =>
      apiUsesIn(read(file)).map((use) => `${relative(file)}: ${use}`)
    );

    expect(offenders).toEqual([]);
  });

  it('can fail: the detectors match a file that would break the contract', () => {
    const offending = [
      'export const at = Date.now();',
      'export const pick = Math.random();',
      'console.log(pick);',
    ].join('\n');

    expect(apiUsesIn(offending).length).toBeGreaterThan(0);
    expect(
      importSpecifiersIn("import * as fs from 'fs';\nimport { Injectable } from '@nestjs/common';")
    ).toEqual(['fs', '@nestjs/common']);
  });
});
