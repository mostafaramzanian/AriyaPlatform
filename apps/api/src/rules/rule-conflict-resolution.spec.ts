import { RuleSetStatus } from './rule.types';
import { RuleFieldCatalogue, RuleConditionNode } from './rule-condition.interface';
import { RuleAction } from './rule-action.interface';
import { EvaluationContext } from './rule-evaluation.interface';
import { RuleSpec, RuleSetVersion } from './rule-spec.interface';
import { RuleRegistryService } from './rule-registry.service';
import { RULE_ENGINE_SCHEMA_VERSION } from './core/rule-limits';
import { evaluateRuleSetVersion } from './core/rule-evaluator';
import { validateRuleSetVersion } from './core/rule-validator';

/**
 * §38.2 gate 3 — the **conflict-resolution gate** (§12).
 *
 * The gate is about the three questions §12 answers, and each is asserted against the engine rather
 * than against a convention:
 *
 *  1. equal authority with incompatible decisions is **refused**, at validation and again at publish,
 *     and a refused publish stores nothing — no silent winner (D11);
 *  2. a declared difference in priority **resolves** the overlap in the declared order;
 *  3. an equal-authority pair whose decisions *are* compatible is broken by the stable rule id, and
 *     the outcome does not depend on the order the rules were written in.
 */

const CATALOGUE: RuleFieldCatalogue = [{ name: 'days', type: 'number' }];

const CONTEXT: EvaluationContext = {
  evaluationInstant: '2024-06-01T00:00:00.000Z',
  facts: { days: 12 },
};

const SET_ID = 'hr.leave.conflict';

/** One condition, reused verbatim, so two rules built from it have *equal specificity* by construction. */
const OVERLAPPING: RuleConditionNode = {
  all: [
    { field: 'days', op: 'greaterThan', value: 10 },
    { field: 'days', op: 'lessThanOrEqual', value: 30 },
  ],
};

const APPROVE = (priority: number, id = 'hr.leave.conflict.approve'): RuleSpec => ({
  id,
  version: '1',
  name: 'Long request approved',
  priority,
  condition: OVERLAPPING,
  actions: [{ type: 'AUTO_APPROVE' }],
});

const REJECT = (priority: number, id = 'hr.leave.conflict.reject'): RuleSpec => ({
  id,
  version: '1',
  name: 'Long request refused',
  priority,
  condition: OVERLAPPING,
  actions: [{ type: 'AUTO_REJECT', reasonCode: 'policy.long-request' }],
});

const STEP = (id: string, stepOrder: number, approverRuleRef: string): RuleSpec => ({
  id,
  version: '1',
  name: 'Approval step',
  priority: 10,
  condition: OVERLAPPING,
  actions: [{ type: 'REQUIRED_APPROVAL_STEP', stepOrder, approverRuleRef }],
});

function versionOf(rules: readonly RuleSpec[], status: RuleSetStatus): RuleSetVersion {
  return {
    ruleSetId: SET_ID,
    version: '1',
    status,
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: CATALOGUE,
    rules,
  };
}

const actionsOf = (rule: RuleSpec): readonly RuleAction[] => rule.actions;

describe('§38.2 gate 3 — conflicts are refused, precedence is declared, ties are stable', () => {
  it('refuses equal-authority rules that decide incompatibly, and stores nothing', () => {
    const candidate = versionOf([APPROVE(10), REJECT(10)], 'VALIDATED');

    const validation = validateRuleSetVersion(candidate);
    expect(validation.valid).toBe(false);
    expect(validation.conflicts.map((conflict) => conflict.dimension)).toEqual([
      'TERMINAL_OUTCOME',
    ]);
    expect(validation.conflicts[0].ruleIds).toEqual([
      'hr.leave.conflict.approve',
      'hr.leave.conflict.reject',
    ]);
    expect(validation.conflicts[0].ordering.map((basis) => basis.ruleId)).toEqual(
      validation.conflicts[0].ruleIds
    );

    const registry = new RuleRegistryService();
    const outcome = registry.publishVersion(candidate);

    expect(outcome.planned).toBe(false);
    if (outcome.planned) return;
    expect(outcome.validation.valid).toBe(false);
    expect(outcome.issues.map((issue) => issue.code)).toContain('RULE_SET_VERSION_NOT_PUBLISHABLE');
    expect(registry.listVersions(SET_ID)).toEqual([]);
    expect(registry.getPublishedVersion(SET_ID)).toBeUndefined();
  });

  it('refuses two rules with the same id in one version', () => {
    const validation = validateRuleSetVersion(versionOf([APPROVE(20), APPROVE(10)], 'DRAFT'));

    expect(validation.valid).toBe(false);
    expect(validation.conflicts.map((conflict) => conflict.dimension)).toEqual([
      'DUPLICATE_RULE_ID',
    ]);
  });

  it('resolves an overlap in the declared order when the priorities differ', () => {
    const version = versionOf([APPROVE(10), REJECT(20)], 'PUBLISHED');
    const validation = validateRuleSetVersion(version);
    expect(validation.valid).toBe(true);
    expect(validation.conflicts).toEqual([]);

    const result = evaluateRuleSetVersion({ ruleSetVersion: version, context: CONTEXT });

    expect(result.status).toBe('DECIDED');
    expect(result.winningRule?.ruleId).toBe('hr.leave.conflict.reject');
    expect(result.winningRule?.priority).toBe(20);
    expect(result.decision).toEqual(actionsOf(REJECT(20))[0]);
    expect(validation.ordering[0].ruleId).toBe('hr.leave.conflict.reject');
    expect(validation.minSpecificity).toBeLessThanOrEqual(validation.maxSpecificity);
    expect(validation.minSpecificity).toBeGreaterThan(0);
  });

  it('breaks an equal-authority tie by the stable rule id, whatever order the rules were written in', () => {
    /**
     * Two rules of genuinely equal authority — same priority, identical condition, same decision
     * signature — so nothing but the id can separate them. If the engine consulted declaration order,
     * `beta` would win whenever it is written first.
     */
    const alpha = STEP('hr.leave.conflict.alpha', 1, 'approver.a');
    const beta = STEP('hr.leave.conflict.beta', 2, 'approver.b');

    const writtenFirst = evaluateRuleSetVersion({
      ruleSetVersion: versionOf([alpha, beta], 'PUBLISHED'),
      context: CONTEXT,
    });
    const writtenSecond = evaluateRuleSetVersion({
      ruleSetVersion: versionOf([beta, alpha], 'PUBLISHED'),
      context: CONTEXT,
    });

    for (const result of [writtenFirst, writtenSecond]) {
      expect(result.status).toBe('DECIDED');
      expect(result.winningRule?.ruleId).toBe('hr.leave.conflict.alpha');
      expect(result.matchHistory[0].ruleId).toBe('hr.leave.conflict.alpha');
      expect(result.validation.valid).toBe(true);
      expect(result.validation.conflicts).toEqual([]);
    }

    /** Equal on both ranking keys that precede the tie-break: the id is what decided this. */
    const [first, second] = writtenFirst.validation.ordering;
    expect(first.priority).toBe(second.priority);
    expect(first.specificity).toBe(second.specificity);
    expect(first.ruleId).toBe('hr.leave.conflict.alpha');

    expect(writtenSecond.validation.ordering).toEqual(writtenFirst.validation.ordering);
    expect(writtenSecond.matchHistory).toEqual(writtenFirst.matchHistory);
    expect(writtenSecond.explanationText).toBe(writtenFirst.explanationText);
    expect(writtenSecond.decision).toEqual(writtenFirst.decision);
  });
});
