import { RuleActionType } from '../rule.types';
import { RuleAction, ruleDecisionSignature } from '../rule-action.interface';
import { RuleComparisonCondition, RuleConditionNode } from '../rule-condition.interface';
import { RuleSpec } from '../rule-spec.interface';
import { RuleConflictReport, RuleOrderingBasis } from '../rule-validation.interface';
import { conflictReport } from './rule-error';
import { conditionSpecificity } from './rule-ordering';

/**
 * Conflict detection: the four frozen conflicts of §12.3, reported so a UI can show them and the
 * API can refuse the publish with a readable message — never a silent winner (D11).
 *
 *  1. `DUPLICATE_RULE_ID` — two rules with the same id in one set/version.
 *  2. `TERMINAL_OUTCOME` — two equal-authority rules that would terminate the same decision
 *     point differently by approving one way and rejecting the other.
 *  3. `AMBIGUOUS_PRECEDENCE` — two equal-authority rules whose decisions differ and which have no
 *     declared precedence.
 *  4. `TYPE_CONTRADICTION` — a rule whose condition can never be true (a validation error, not a
 *     silently dead rule).
 *
 * Authority means equal on both ranking keys that precede the id tie-break (§12.1): equal priority
 * **and** equal specificity. Two such rules are ordered only by their ids, which is a tie-break for
 * reporting, not a policy — so an incompatibility between them must be refused rather than
 * resolved.
 */

/** The two action types that terminate a decision point by approving or refusing (§9). */
const TERMINAL_DECISIONS: readonly RuleActionType[] = Object.freeze([
  'AUTO_APPROVE',
  'AUTO_REJECT',
]);

/** Every conflict of a set of rules (§12.3). */
export function detectRuleConflicts(rules: readonly RuleSpec[]): RuleConflictReport[] {
  return [
    ...detectDuplicateIds(rules),
    ...detectAuthorityConflicts(rules),
    ...detectContradictions(rules),
  ];
}

/** The three ordering keys of one rule, as reported (§13). */
export function ruleOrderingBasisOf(rule: RuleSpec): RuleOrderingBasis {
  return {
    ruleId: rule.id,
    priority: rule.priority,
    specificity: conditionSpecificity(rule.condition),
  };
}

/** §12.3 — two rules with the same id in one set/version. */
function detectDuplicateIds(rules: readonly RuleSpec[]): RuleConflictReport[] {
  const byId = new Map<string, RuleSpec[]>();
  for (const rule of rules) {
    const group = byId.get(rule.id);
    if (group === undefined) {
      byId.set(rule.id, [rule]);
    } else {
      group.push(rule);
    }
  }

  const reports: RuleConflictReport[] = [];
  for (const [ruleId, group] of byId) {
    if (group.length > 1) {
      reports.push(
        conflictReport(
          'DUPLICATE_RULE_ID',
          [ruleId],
          [ruleOrderingBasisOf(group[0])],
          `rule id "${ruleId}" appears ${group.length} times in one version`
        )
      );
    }
  }
  return reports;
}

interface Bound {
  readonly value: string | number | boolean;
  readonly inclusive: boolean;
  readonly op: string;
}

/**
 * The accumulated constraints on one field inside one conjunction. Single pass and `O(n)` per
 * group, so a rule with a hundred leaves cannot make validation quadratic.
 */
function contradictionInField(
  field: string,
  comparisons: readonly RuleComparisonCondition[]
): string | null {
  let equalsLiteral: string | number | boolean | null = null;
  let sawEmpty = false;
  let sawNotEmpty = false;
  let lower: Bound | null = null;
  let upper: Bound | null = null;

  for (const comparison of comparisons) {
    const operand = comparison.value;

    switch (comparison.op) {
      case 'equals': {
        if (!isScalarLiteral(operand)) {
          break;
        }
        if (equalsLiteral !== null && !sameLiteral(equalsLiteral, operand)) {
          return `field "${field}" is required to equal both ${render(equalsLiteral)} and ${render(operand)}`;
        }
        equalsLiteral = operand;
        break;
      }

      case 'in': {
        const members = Array.isArray(operand) ? operand : null;
        if (members === null || equalsLiteral === null) {
          break;
        }
        const current = equalsLiteral;
        if (!members.some((member) => sameLiteral(member, current))) {
          return `field "${field}" is required to equal ${render(current)} and to be one of ${render(members)}`;
        }
        break;
      }

      case 'isEmpty':
        sawEmpty = true;
        break;

      case 'isNotEmpty':
        sawNotEmpty = true;
        break;

      case 'greaterThan':
      case 'greaterThanOrEqual':
        if (isScalarLiteral(operand)) {
          lower = {
            value: operand,
            inclusive: comparison.op === 'greaterThanOrEqual',
            op: comparison.op,
          };
        }
        break;

      case 'lessThan':
      case 'lessThanOrEqual':
        if (isScalarLiteral(operand)) {
          upper = {
            value: operand,
            inclusive: comparison.op === 'lessThanOrEqual',
            op: comparison.op,
          };
        }
        break;

      default:
        break;
    }

    if (sawEmpty && sawNotEmpty) {
      return `field "${field}" is required to be empty and not empty at once`;
    }

    if (lower !== null && upper !== null) {
      if (intervalIsEmpty(lower, upper)) {
        return `field "${field}" is bounded by ${lower.op} ${render(lower.value)} and ${upper.op} ${render(upper.value)}, which cannot both hold`;
      }
      if (equalsLiteral !== null && !insideInterval(equalsLiteral, lower, upper)) {
        return `field "${field}" is required to equal ${render(equalsLiteral)}, which lies outside ${lower.op} ${render(lower.value)} and ${upper.op} ${render(upper.value)}`;
      }
    }
  }

  return null;
}

function intervalIsEmpty(lower: Bound, upper: Bound): boolean {
  if (typeof lower.value !== typeof upper.value) {
    return false;
  }
  if (lower.value > upper.value) {
    return true;
  }
  return lower.value === upper.value && !(lower.inclusive && upper.inclusive);
}

function insideInterval(value: string | number | boolean, lower: Bound, upper: Bound): boolean {
  if (typeof value !== typeof lower.value || typeof value !== typeof upper.value) {
    return true;
  }
  if (value < lower.value || value > upper.value) {
    return false;
  }
  if (value === lower.value && !lower.inclusive) {
    return false;
  }
  if (value === upper.value && !upper.inclusive) {
    return false;
  }
  return true;
}

function isComparisonCondition(node: RuleConditionNode): node is RuleComparisonCondition {
  return 'field' in node;
}

function isScalarLiteral(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function sameLiteral(a: unknown, b: unknown): boolean {
  return isScalarLiteral(a) && isScalarLiteral(b) && typeof a === typeof b && a === b;
}

/** A deterministic rendering of a literal for a diagnostics message (never a sentence for a user). */
function render(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => render(entry)).join(', ')}]`;
  }
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * §12.3 — equal authority, incompatible decisions.
 *
 * @remarks The decision signature compares declared action **types**, in order, and ignores
 * parameters: two rules that produce the same kinds of decision are compatible even if they name
 * different references, and two that produce different kinds are not. That keeps the check total
 * and free of domain knowledge. A conflict that turns on approval versus rejection is reported
 * under the more precise `TERMINAL_OUTCOME` dimension rather than twice.
 */
function detectAuthorityConflicts(rules: readonly RuleSpec[]): RuleConflictReport[] {
  const byAuthority = new Map<string, RuleSpec[]>();
  for (const rule of rules) {
    const key = `${rule.priority}|${conditionSpecificity(rule.condition)}`;
    const group = byAuthority.get(key);
    if (group === undefined) {
      byAuthority.set(key, [rule]);
    } else {
      group.push(rule);
    }
  }

  const reports: RuleConflictReport[] = [];
  for (const group of byAuthority.values()) {
    if (group.length < 2) {
      continue;
    }
    const ordered = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const report = authorityConflict(ordered[i], ordered[j]);
        if (report !== null) {
          reports.push(report);
        }
      }
    }
  }
  return reports;
}

function authorityConflict(a: RuleSpec, b: RuleSpec): RuleConflictReport | null {
  const aSignature = ruleDecisionSignature(a.actions);
  const bSignature = ruleDecisionSignature(b.actions);
  if (aSignature === bSignature) {
    return null;
  }

  const ordering = [ruleOrderingBasisOf(a), ruleOrderingBasisOf(b)];
  const aTerminal = terminalDecisionOf(a.actions);
  const bTerminal = terminalDecisionOf(b.actions);

  if (aTerminal !== null && bTerminal !== null && aTerminal !== bTerminal) {
    return conflictReport(
      'TERMINAL_OUTCOME',
      [a.id, b.id],
      ordering,
      `equal authority (priority ${a.priority}, specificity ${ordering[0].specificity}) but one rule decides ${aTerminal} and the other ${bTerminal}`
    );
  }

  return conflictReport(
    'AMBIGUOUS_PRECEDENCE',
    [a.id, b.id],
    ordering,
    `equal authority (priority ${a.priority}, specificity ${ordering[0].specificity}) but different decisions (${aSignature} vs ${bSignature}) with no declared precedence`
  );
}

/** The first terminal decision of a rule's action list, if it has one. */
function terminalDecisionOf(actions: readonly RuleAction[]): RuleActionType | null {
  for (const action of actions) {
    if (TERMINAL_DECISIONS.includes(action.type)) {
      return action.type;
    }
  }
  return null;
}

/**
 * §12.3 — a rule whose condition can never be true.
 *
 * @remarks This is a **bounded, documented** contradiction analysis, not a theorem prover. It
 * examines the direct positive comparisons of every conjunction node (`all`) of a rule, because a
 * conjunction is the only construct that can be unsatisfiable: an alternative is satisfiable as
 * soon as one branch is, and a negation states no positive fact. Inside one conjunction it detects
 * the four contradictions a policy author actually writes by accident —
 *
 *   - two different `equals` values for one field,
 *   - `equals X` together with `in [...]` that does not contain `X`,
 *   - `isEmpty` together with `isNotEmpty`,
 *   - a lower and an upper bound that cannot both hold, or an `equals` outside the stated interval.
 *
 * A `count` node's per-item filter is deliberately **not** analysed: an unsatisfiable filter makes
 * a count of zero, which is a statement (if a useless one), not a dead rule. A rule containing
 * more than one contradiction is reported once, for the first finding in declared order: the rule
 * is refused either way, and a bounded report is what a person can read.
 */
function detectContradictions(rules: readonly RuleSpec[]): RuleConflictReport[] {
  const reports: RuleConflictReport[] = [];
  for (const rule of rules) {
    const finding = findContradiction(rule);
    if (finding !== null) {
      reports.push(finding);
    }
  }
  return reports;
}

function findContradiction(rule: RuleSpec): RuleConflictReport | null {
  const groups: RuleComparisonCondition[][] = [];
  collectConjunctionGroups(rule.condition, groups);

  for (const group of groups) {
    const finding = contradictionInGroup(group, rule);
    if (finding !== null) {
      return finding;
    }
  }
  return null;
}

/** Collects the positive comparison children of every `all` node reachable from `node`. */
function collectConjunctionGroups(
  node: RuleConditionNode,
  sink: RuleComparisonCondition[][]
): void {
  if ('all' in node) {
    sink.push(node.all.filter(isComparisonCondition));
    for (const child of node.all) {
      collectConjunctionGroups(child, sink);
    }
    return;
  }
  if ('any' in node) {
    for (const child of node.any) {
      collectConjunctionGroups(child, sink);
    }
    return;
  }
  return;
}

function contradictionInGroup(
  comparisons: readonly RuleComparisonCondition[],
  rule: RuleSpec
): RuleConflictReport | null {
  const byField = new Map<string, RuleComparisonCondition[]>();
  for (const comparison of comparisons) {
    const group = byField.get(comparison.field);
    if (group === undefined) {
      byField.set(comparison.field, [comparison]);
    } else {
      group.push(comparison);
    }
  }

  for (const [field, group] of byField) {
    const finding = contradictionInField(field, group);
    if (finding !== null) {
      return conflictReport('TYPE_CONTRADICTION', [rule.id], [ruleOrderingBasisOf(rule)], finding);
    }
  }
  return null;
}
