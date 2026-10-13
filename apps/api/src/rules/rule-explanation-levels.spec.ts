import { RuleFieldCatalogue } from './rule-condition.interface';
import { EvaluationContext } from './rule-evaluation.interface';
import { RuleSetVersion } from './rule-spec.interface';
import { RuleEvidenceLevel } from './rule.types';
import { RULE_ENGINE_SCHEMA_VERSION } from './core/rule-limits';
import { evaluateRuleSetVersion } from './core/rule-evaluator';
import { RuleExplanation, buildRuleExplanation } from './core/rule-explanation';

/**
 * §38.2 gate 11 — the **explanation gate** (§13, §27.2).
 *
 * A level is a projection of one already-taken decision, never a different evaluation and never a
 * client-side filter over a fat payload (§27.1, §27.2). The gate asserts the projection itself:
 *
 *  - an employee's explanation carries the outcome and the applicable stipulation, and no internal
 *    rule text — no rule id, no rule name, no priority, no specificity, no match history;
 *  - a manager's carries the action, and the reason requirement of a rejection;
 *  - nothing, at any level, exposes JSON, SQL, a leaf path or the typed condition tree.
 *
 * The last point is why this spec walks the *serialized* projection: a field that is withheld must be
 * absent from the payload, not empty-by-convention in a comment.
 */

const CATALOGUE: RuleFieldCatalogue = [
  { name: 'employmentType', type: 'enum', enumValues: ['PERMANENT', 'CONTRACT'] },
  { name: 'days', type: 'number' },
  { name: 'requestedFrom', type: 'string' },
  {
    name: 'sickRequests',
    type: 'collection',
    maxSize: 50,
    itemFields: [{ name: 'leaveTypeRef', type: 'string' }],
  },
];

const CONTEXT: EvaluationContext = {
  evaluationInstant: '2024-06-01T00:00:00.000Z',
  facts: {
    employmentType: 'CONTRACT',
    days: 3,
    sickRequests: [{ leaveTypeRef: 'SICK' }, { leaveTypeRef: 'SICK' }, { leaveTypeRef: 'SICK' }],
  },
};

const LIMIT_SET: RuleSetVersion = {
  ruleSetId: 'hr.leave.explain',
  version: '1',
  status: 'PUBLISHED',
  schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
  fields: CATALOGUE,
  rules: [
    {
      id: 'hr.leave.explain.limit',
      version: '1',
      name: 'Contract sick limit',
      priority: 30,
      condition: {
        all: [
          { field: 'employmentType', op: 'equals', value: 'CONTRACT' },
          {
            count: {
              over: 'sickRequests',
              where: [{ field: 'leaveTypeRef', op: 'equals', value: 'SICK' }],
              op: 'greaterThanOrEqual',
              value: 3,
            },
          },
        ],
      },
      actions: [
        {
          type: 'LIMIT_REFUSAL',
          limitRef: 'limit.contract.sick',
          countingBasis: 'REQUEST_COUNT',
          maximum: 3,
          windowStart: '2024-01-01',
          windowEnd: '2024-12-31',
        },
      ],
    },
    {
      id: 'hr.leave.explain.step',
      version: '1',
      name: 'Very long requests need a step',
      priority: 20,
      condition: { field: 'days', op: 'greaterThan', value: 30 },
      actions: [{ type: 'REQUIRED_APPROVAL_STEP', stepOrder: 2, approverRuleRef: 'approver.hr' }],
    },
    {
      id: 'hr.leave.explain.notify',
      version: '1',
      name: 'Notify HR',
      priority: 10,
      condition: { field: 'employmentType', op: 'equals', value: 'CONTRACT' },
      actions: [
        {
          type: 'NOTIFY',
          templateRef: 'template.hr.contract.notice',
          recipientRole: 'HR_ADMIN',
        },
      ],
    },
    {
      id: 'hr.leave.explain.reject',
      version: '1',
      name: 'A rule the context cannot decide',
      priority: 5,
      condition: { field: 'requestedFrom', op: 'equals', value: 'HR' },
      actions: [{ type: 'AUTO_REJECT', reasonCode: 'policy.unauthorized-source' }],
    },
  ],
};

const REJECTION_SET: RuleSetVersion = {
  ruleSetId: 'hr.leave.explain.rejection',
  version: '1',
  status: 'PUBLISHED',
  schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
  fields: CATALOGUE,
  rules: [
    {
      id: 'hr.leave.explain.rejection.too-long',
      version: '1',
      name: 'Long requests are refused',
      priority: 10,
      condition: { field: 'days', op: 'greaterThan', value: 2 },
      actions: [{ type: 'AUTO_REJECT', reasonCode: 'policy.long-request' }],
    },
  ],
};

const LEVELS: readonly RuleEvidenceLevel[] = Object.freeze([
  'EMPLOYEE',
  'MANAGER',
  'HR_ADMIN',
  'PLATFORM_ADMIN',
]);

const explained = (version: RuleSetVersion, level: RuleEvidenceLevel): RuleExplanation =>
  buildRuleExplanation(
    evaluateRuleSetVersion({ ruleSetVersion: version, context: CONTEXT }),
    level
  );

describe('§38.2 gate 11 — every level is a projection of one decision', () => {
  it('gives the employee the outcome and the stipulation, and no internal rule text', () => {
    const employee = explained(LIMIT_SET, 'EMPLOYEE');

    expect(employee.detailLevel).toBe('EMPLOYEE');
    expect(employee.status).toBe('DECIDED');
    expect(employee.decisionType).toBe('LIMIT_REFUSAL');
    expect(employee.decisionActions).toEqual([
      {
        type: 'LIMIT_REFUSAL',
        limitRef: 'limit.contract.sick',
        countingBasis: 'REQUEST_COUNT',
        maximum: 3,
        windowStart: '2024-01-01',
        windowEnd: '2024-12-31',
      },
    ]);

    /** The codes a UI renders the refusal's words from (§13.4, §28.4). */
    expect(employee.reasonCodes).toContain('STATUS_DECIDED');
    expect(employee.reasonCodes).toContain('ACTION_LIMIT_REFUSAL');
    expect(employee.reasonCodes).toContain('LIMIT_BASIS_REQUEST_COUNT');
    expect(employee.reasonCodes).toContain('LIMIT_MAXIMUM_3');
    expect(employee.reasonCodes).toContain('LIMIT_WINDOW_2024-01-01_2024-12-31');
    expect(employee.reasonCodes.some((code) => code.startsWith('ORDERING_'))).toBe(false);

    expect(employee.winningRuleId).toBeNull();
    expect(employee.winningRuleVersion).toBeNull();
    expect(employee.orderingBasis).toBeNull();
    expect(employee.matchHistory).toEqual([]);
    expect(employee.grounds).toEqual([]);
    expect(employee.failedLeaves).toEqual([]);
    expect(employee.conflicts).toEqual([]);

    const payload = JSON.stringify(employee);
    expect(payload).not.toContain('hr.leave.explain.limit');
    expect(payload).not.toContain('Contract sick limit');
    expect(payload).not.toContain('priority');
    expect(payload).not.toContain('specificity');
    expect(payload).not.toContain('winner=');
  });

  it('gives the manager the action and the rejection reason requirement', () => {
    const manager = explained(REJECTION_SET, 'MANAGER');

    expect(manager.decisionType).toBe('AUTO_REJECT');
    expect(manager.decisionActions).toEqual([
      { type: 'AUTO_REJECT', reasonCode: 'policy.long-request' },
    ]);
    expect(manager.reasonCodes).toContain('REJECTION_REASON_policy.long-request');

    /** Which rule decided is Level 2 detail; which *version* of it is not (§13.3). */
    expect(manager.winningRuleId).toBe('hr.leave.explain.rejection.too-long');
    expect(manager.winningRuleVersion).toBeNull();
    expect(manager.matchHistory).toEqual([]);
    expect(manager.orderingBasis).toBeNull();
    expect(manager.grounds).toEqual([]);
  });

  it('narrows the history and the ordering basis to the levels entitled to them', () => {
    const platform = explained(LIMIT_SET, 'PLATFORM_ADMIN');
    const hrAdmin = explained(LIMIT_SET, 'HR_ADMIN');

    expect(platform.matchHistory).toHaveLength(4);
    expect(platform.orderingBasis).toEqual({
      ruleId: 'hr.leave.explain.limit',
      priority: 30,
      specificity: platform.orderingBasis?.specificity,
    });
    expect(platform.reasonCodes.some((code) => code.startsWith('ORDERING_PRIORITY_30'))).toBe(true);
    expect(platform.failedLeaves.some((leaf) => leaf.startsWith('field:days'))).toBe(true);
    expect(platform.explanationText).toContain('winner={');

    expect(hrAdmin.matchHistory.map((match) => match.matched)).toEqual([true, true]);
    expect(hrAdmin.orderingBasis).toBeNull();
    expect(hrAdmin.failedLeaves).toEqual([]);
    expect(hrAdmin.grounds.length).toBeGreaterThan(0);
    expect(hrAdmin.reasonCodes.some((code) => code.startsWith('ORDERING_'))).toBe(false);
    expect(hrAdmin.explanationText).not.toContain('{');
  });

  /**
   * The internals check, as a function rather than a set of inline assertions, so the same code can
   * be run against a payload that *does* leak — which is what makes this gate able to fail.
   */
  const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
    'condition',
    'when',
    'then',
    'rules',
    'actions',
    'all',
    'any',
    'not',
    'where',
    'field',
    'op',
    'value',
    'data',
  ]);
  const SQL = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|JOIN)\b/i;
  const LEAF_PATH = /(^|[^A-Za-z])(field:|count:)/;

  function violationsOf(value: unknown, level: RuleEvidenceLevel): string[] {
    const violations: string[] = [];
    const strict = level === 'EMPLOYEE' || level === 'MANAGER';

    const visit = (node: unknown, at: string): void => {
      if (typeof node === 'string') {
        if (SQL.test(node)) violations.push(`${at}: SQL-looking value "${node}"`);
        if (node.trim().startsWith('{') || node.trim().startsWith('[')) {
          violations.push(`${at}: JSON-looking value "${node}"`);
        }
        if (strict && (node.includes('{') || LEAF_PATH.test(node))) {
          violations.push(`${at}: internal detail "${node}"`);
        }
        return;
      }
      if (typeof node === 'number' || typeof node === 'boolean' || node === null) return;
      if (Array.isArray(node)) {
        node.forEach((child, index) => visit(child, `${at}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.includes(key)) violations.push(`${at}.${key}: typed-model key`);
        /**
         * `count` is the one ambiguous name: a §8.4 aggregate is an object (`{ count: { … } }`), while
         * `RuleObservedCount.count` is a reported number. Only the object form is a condition node.
         */
        if (key === 'count' && typeof child === 'object' && child !== null) {
          violations.push(`${at}.count: condition node`);
        }
        visit(child, `${at}.${key}`);
      }
    };

    visit(value, 'explanation');
    return violations;
  }

  it('exposes no JSON, no SQL, no leaf path and no condition tree, at any level', () => {
    for (const level of LEVELS) {
      for (const version of [LIMIT_SET, REJECTION_SET]) {
        const explanation = explained(version, level);

        expect(violationsOf(explanation, level)).toEqual([]);
        /** Every level states which policy decided, because the record of it is policy identity. */
        expect(explanation.ruleSetVersion).toBe(version.version);
        expect(explanation.detailLevel).toBe(level);
      }
    }
  });

  it('can fail: the same check flags a payload that leaks internals', () => {
    const leaky = {
      ruleSetVersion: '1',
      detailLevel: 'EMPLOYEE',
      condition: { all: [{ field: 'days', op: 'greaterThan', value: 3 }] },
      explanationText: '{"winner":{"ruleId":"hr.leave.explain.limit"}}',
      grounds: ['field:days'],
    };

    const violations = violationsOf(leaky, 'EMPLOYEE');

    expect(violations.length).toBeGreaterThan(2);
    expect(violations.join('\n')).toContain('typed-model key');
    expect(violations.join('\n')).toContain('JSON-looking value');
  });
});
