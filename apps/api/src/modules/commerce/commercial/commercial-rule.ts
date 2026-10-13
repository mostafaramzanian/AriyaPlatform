import { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { RuleEvaluationOutcome } from '../../../rules/rule-engine.interface';
import { RuleSetVersion, RuleSpec } from '../../../rules/rule-spec.interface';
import { RULE_ENGINE_SCHEMA_VERSION } from '../../../rules/core/rule-limits';
import {
  COMMERCE_WORKFLOW_FACT_CATALOGUE,
  COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE,
} from '../workflow/workflow-facts';
import { workflowContentDigest } from '../workflow/workflow-execution';
import {
  COMMERCIAL_APPROVAL_RULE_SET_ID,
  COMMERCIAL_ASSIGNMENT_RULE_ID_PREFIX,
  COMMERCIAL_ASSIGNMENT_RULE_SET_ID,
} from './commercial.constants';

/**
 * Phase C1 Step P (§5): the PURE commercial planner — the assignment rule set
 * and the approval-applicability rule set, built as VALUES from a pinned
 * configuration version. No repository, no Prisma, no gateway, no clock.
 *
 * ONE ENGINE. `RuleEngineService.evaluateSync` is the only evaluator; this
 * file builds the sets and interprets the deterministic outcome exactly as
 * `workflow-line-routing.ts` does for routing. There is no second filter
 * engine, no `eval`, no `new Function`.
 *
 * CATALOGUES ARE IMPORTED UNCHANGED (§5): the assignment set speaks the frozen
 * LINE catalogue (line-first determination, §3-D — the catalogue O's routing
 * speaks), and the applicability set speaks the frozen DOCUMENT catalogue
 * (thresholds over document amounts are the §0 "thresholds"). P does not
 * widen, re-declare or bypass either; a condition naming any other fact is
 * rejected at validation, so a rule cannot reach a raw Prisma row.
 */

/** The tautology O uses for unconditional routes — every line has a `lineType`. */
export const COMMERCIAL_UNCONDITIONAL_CONDITION: RuleConditionNode = Object.freeze({
  field: 'lineType',
  op: 'isNotEmpty',
});

/** One tenant-authored assignment candidate (§3-D). */
export interface CommercialAssignmentRule {
  readonly label: string;
  readonly priority: number;
  readonly condition: RuleConditionNode | null;
  readonly commercialGroupId: string;
}

export interface CommercialAssignmentPlan {
  readonly outcome: 'ASSIGNED';
  readonly commercialGroupId: string;
  readonly matchedLabel: string;
  readonly ruleSetVersion: string;
}

export interface CommercialUnassignedPlan {
  readonly outcome: 'UNASSIGNED';
  readonly ruleSetVersion: string;
}

export interface CommercialAmbiguousPlan {
  readonly outcome: 'AMBIGUOUS';
  readonly tiedGroupIds: readonly string[];
  readonly ruleSetVersion: string;
}

export interface CommercialInvalidPlan {
  readonly outcome: 'INVALID';
  readonly reason: string;
  readonly ruleSetVersion: string;
}

export type CommercialAssignmentPlanResult =
  | CommercialAssignmentPlan
  | CommercialUnassignedPlan
  | CommercialAmbiguousPlan
  | CommercialInvalidPlan;

export function commercialAssignmentRuleId(commercialGroupId: string, label: string): string {
  return `${COMMERCIAL_ASSIGNMENT_RULE_ID_PREFIX}${commercialGroupId}:${label}`;
}

/** The content digest of an assignment rule list: label, priority, condition, group. */
export function commercialAssignmentSetVersion(rules: readonly CommercialAssignmentRule[]): string {
  const ordered = [...rules].sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
  });

  return workflowContentDigest([
    COMMERCIAL_ASSIGNMENT_RULE_SET_ID,
    'assignment-rules',
    ordered.map((rule) => [
      rule.label,
      rule.priority,
      rule.condition ?? COMMERCIAL_UNCONDITIONAL_CONDITION,
      rule.commercialGroupId,
    ]),
  ]);
}

function commercialAssignmentAction(rule: CommercialAssignmentRule) {
  return Object.freeze({
    type: 'REQUIRED_APPROVAL_STEP' as const,
    stepOrder: 1,
    approverRuleRef: rule.commercialGroupId,
  });
}

/** The `commerce.commercial.assignment` Rule Set built from the stored candidates. */
export function commercialAssignmentRuleSet(
  rules: readonly CommercialAssignmentRule[]
): RuleSetVersion {
  const version = commercialAssignmentSetVersion(rules);

  const specRules = rules.map((rule): RuleSpec =>
    Object.freeze({
      id: commercialAssignmentRuleId(rule.commercialGroupId, rule.label),
      version,
      name: rule.label,
      priority: rule.priority,
      condition: rule.condition ?? COMMERCIAL_UNCONDITIONAL_CONDITION,
      actions: Object.freeze([commercialAssignmentAction(rule)]),
    })
  );

  return Object.freeze({
    ruleSetId: COMMERCIAL_ASSIGNMENT_RULE_SET_ID,
    version,
    status: 'PUBLISHED' as const,
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE,
    rules: Object.freeze(specRules),
  });
}

interface EngineMatchShape {
  readonly matchHistory: readonly {
    readonly matched: boolean;
    readonly priority: number;
    readonly ruleId: string;
  }[];
  readonly winningRule: { readonly ruleId: string; readonly ruleVersion: string } | null;
}

function matchedAssignmentGroupIds(
  rules: readonly CommercialAssignmentRule[],
  result: EngineMatchShape
): readonly string[] {
  const ids: string[] = [];
  for (const record of result.matchHistory) {
    if (!record.matched) continue;
    const rule = rules.find(
      (candidate) =>
        commercialAssignmentRuleId(candidate.commercialGroupId, candidate.label) === record.ruleId
    );
    if (rule && !ids.includes(rule.commercialGroupId)) ids.push(rule.commercialGroupId);
  }
  return ids;
}

/**
 * Read the engine's deterministic outcome and produce the assignment plan.
 *
 * Mirrors `planWorkflowLineRouting`: `HIGHEST_PRIORITY` lets the engine order
 * by priority/specificity but still refuses a tie at the top; `AMBIGUOUS_ERROR`
 * refuses whenever more than one rule's condition is true. No match is NOT an
 * error here — it becomes the configured no-assignment behaviour (§3-D), which
 * the service applies.
 */
export function planCommercialAssignment(
  rules: readonly CommercialAssignmentRule[],
  matchBehavior: 'HIGHEST_PRIORITY' | 'AMBIGUOUS_ERROR',
  outcome: RuleEvaluationOutcome | null
): CommercialAssignmentPlanResult {
  const ruleSetVersion = commercialAssignmentSetVersion(rules);

  if (rules.length === 0) {
    return { outcome: 'UNASSIGNED', ruleSetVersion };
  }
  if (outcome === null) {
    return { outcome: 'INVALID', reason: 'COMMERCIAL_RULE_NOT_EVALUATED', ruleSetVersion };
  }
  if (!outcome.evaluated) {
    return { outcome: 'INVALID', reason: outcome.reason, ruleSetVersion };
  }

  const result = outcome.result as EngineMatchShape & {
    readonly status: string;
  };
  if (result.status === 'REFUSED_INVALID_VERSION' || result.status === 'REFUSED_BOUNDS_EXCEEDED') {
    return { outcome: 'INVALID', reason: result.status, ruleSetVersion };
  }
  if (result.status === 'NO_MATCH') {
    return { outcome: 'UNASSIGNED', ruleSetVersion };
  }

  const matchedGroupIds = matchedAssignmentGroupIds(rules, result);
  if (matchedGroupIds.length > 1) {
    if (matchBehavior === 'AMBIGUOUS_ERROR') {
      return { outcome: 'AMBIGUOUS', tiedGroupIds: matchedGroupIds, ruleSetVersion };
    }
    const matched = result.matchHistory.filter((record) => record.matched);
    const topPriority = Math.max(...matched.map((record) => record.priority));
    const topTied = matched.filter((record) => record.priority === topPriority);
    if (topTied.length > 1) {
      return { outcome: 'AMBIGUOUS', tiedGroupIds: matchedGroupIds, ruleSetVersion };
    }
  }

  const winningRule = result.winningRule;
  if (winningRule === null) {
    return { outcome: 'INVALID', reason: 'COMMERCIAL_RULE_WINNING_RULE_MISSING', ruleSetVersion };
  }

  const winner = rules.find(
    (rule) => commercialAssignmentRuleId(rule.commercialGroupId, rule.label) === winningRule.ruleId
  );
  if (!winner) {
    return { outcome: 'INVALID', reason: 'COMMERCIAL_RULE_REFERENCE_MISMATCH', ruleSetVersion };
  }

  return {
    outcome: 'ASSIGNED',
    commercialGroupId: winner.commercialGroupId,
    matchedLabel: winner.label,
    ruleSetVersion,
  };
}

/** The content digest of the bound applicability condition (§3-G). */
export function commercialApplicabilitySetVersion(condition: RuleConditionNode): string {
  return workflowContentDigest([COMMERCIAL_APPROVAL_RULE_SET_ID, 'applicability', condition]);
}

/**
 * The `commerce.commercial.approval-applicability` Rule Set: the optional
 * bound condition of the pinned configuration version, built as a one-rule
 * set over the frozen DOCUMENT catalogue (§5).
 */
export function commercialApprovalApplicabilityRuleSet(
  condition: RuleConditionNode
): RuleSetVersion {
  const version = commercialApplicabilitySetVersion(condition);
  const rule: RuleSpec = Object.freeze({
    id: `${COMMERCIAL_APPROVAL_RULE_SET_ID}:applicability`,
    version,
    name: 'commercial-approval-applicability',
    priority: 1,
    condition,
    actions: Object.freeze([{ type: 'AUTO_APPROVE' as const }]),
  });

  return Object.freeze({
    ruleSetId: COMMERCIAL_APPROVAL_RULE_SET_ID,
    version,
    status: 'PUBLISHED' as const,
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: COMMERCE_WORKFLOW_FACT_CATALOGUE,
    rules: Object.freeze([rule]),
  });
}
