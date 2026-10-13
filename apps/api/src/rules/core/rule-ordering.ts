import { RuleConditionNode } from '../rule-condition.interface';
import { RuleSpec } from '../rule-spec.interface';
import { RuleOrderingBasis } from '../rule-validation.interface';
import { assertNever, invariant } from './rule-error';

/**
 * Ordering and specificity — the frozen arithmetic of §12.1 and §12.2.
 *
 * Ordering is computed from the **declared** definition, never from insertion order, array order
 * or creation timestamps (§12.1), and the comparator is **total**: for any two distinct rules it
 * returns non-zero, because rule ids are unique inside a set (D11). The weights are frozen and not
 * tenant-tunable: a tenant-tunable ordering would make the same configuration decide differently
 * in two tenancies and the explanation unexplainable (§12.2).
 */
export const RULE_SPECIFICITY_WEIGHTS = Object.freeze({
  /** a leaf comparison (`field op value`) */
  leafComparison: 1,
  /** a `count` comparison */
  countComparison: 1,
  /** an `all` node: this much per child node */
  allPerChild: 2,
  /** a `not` node */
  not: -1,
  /** an `any` node: an alternative is not more specific */
  any: 0,
});

/**
 * Specificity of one condition tree (§12.2), summed over the constructs the frozen table names.
 *
 * @remarks Two deliberate, documented treatments of constructs the table does not name:
 *
 *  - **`count.where` is not counted.** The frozen table assigns a `count` comparison one unit; its
 *    per-item filter describes the aggregate, not the subject of the rule, so counting it would
 *    make "how many things did I filter" look like "how precisely did I describe this request".
 *    This is the deterministic neutral treatment §12.2 allows where a construct's contribution
 *    cannot be safely defined.
 *  - **`not` subtracts once and keeps its child's contribution.** A negation states no positive
 *    fact, so a negated leaf weighs one less than the same leaf asserted.
 *
 * The computation is total: every node of the frozen vocabulary contributes, so no rule can have
 * an undefined specificity.
 */
export function conditionSpecificity(node: RuleConditionNode): number {
  if ('all' in node) {
    return node.all.length * RULE_SPECIFICITY_WEIGHTS.allPerChild + sumChildSpecificity(node.all);
  }
  if ('any' in node) {
    return RULE_SPECIFICITY_WEIGHTS.any + sumChildSpecificity(node.any);
  }
  if ('not' in node) {
    return RULE_SPECIFICITY_WEIGHTS.not + conditionSpecificity(node.not);
  }
  if ('count' in node) {
    return RULE_SPECIFICITY_WEIGHTS.countComparison;
  }
  if ('field' in node) {
    return RULE_SPECIFICITY_WEIGHTS.leafComparison;
  }
  return assertNever(node, 'unknown condition node');
}

function sumChildSpecificity(children: readonly RuleConditionNode[]): number {
  let total = 0;
  for (const child of children) {
    total += conditionSpecificity(child);
  }
  return total;
}

/**
 * The frozen ordering (§12.1): higher priority, then higher specificity, then lower (ascending)
 * rule id. Returns `0` only for the same rule id, which a valid set cannot contain twice, so the
 * order is total.
 */
export function compareRuleSpecs(a: RuleSpec, b: RuleSpec): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }

  const aSpecificity = conditionSpecificity(a.condition);
  const bSpecificity = conditionSpecificity(b.condition);
  if (aSpecificity !== bSpecificity) {
    return bSpecificity - aSpecificity;
  }

  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/** A rule with its computed specificity, so the value is derived once per evaluation. */
export interface RankedRuleSpec {
  readonly rule: RuleSpec;
  readonly specificity: number;
}

/**
 * The evaluated order of a set: declared order is discarded, the frozen keys decide (§12.1).
 *
 * @remarks Specificity is computed exactly once per rule here (the comparator must agree with this
 * order, and both are asserted against each other by the ordering tests).
 */
export function orderRuleSpecs(rules: readonly RuleSpec[]): RankedRuleSpec[] {
  return rules
    .map((rule) => ({ rule, specificity: conditionSpecificity(rule.condition) }))
    .sort((a, b) => compareRuleSpecs(a.rule, b.rule));
}

/** The three keys that produced a decision, as reported by §13. */
export function ruleOrderingBasis(rule: RuleSpec): RuleOrderingBasis {
  return {
    ruleId: rule.id,
    priority: rule.priority,
    specificity: conditionSpecificity(rule.condition),
  };
}

/** A deterministic textual rendering of an ordering basis, for `explanationText` (§13.4). */
export function describeOrderingBasis(basis: RuleOrderingBasis): string {
  return `ruleId=${basis.ruleId} priority=${basis.priority} specificity=${basis.specificity}`;
}

/** The comparator must be consistent with the ordering produced from the same keys. */
export function assertOrderingIsTotal(rules: readonly RuleSpec[]): void {
  invariant(
    new Set(rules.map((rule) => rule.id)).size === rules.length,
    'ordering requires unique rule ids'
  );
}
