import { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { RuleEvaluationOutcome } from '../../../rules/rule-engine.interface';
import { RuleSetVersion, RuleSpec } from '../../../rules/rule-spec.interface';
import { RULE_ENGINE_SCHEMA_VERSION } from '../../../rules/core/rule-limits';
import { COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE } from './workflow-facts';
import { workflowContentDigest } from './workflow-execution';

/**
 * Phase C1 Step O (§5.15): the LINE-LEVEL ROUTING planner.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A pure function library that builds the `commerce.workflow.line.selection` Rule Set and
 * reads the engine's deterministic outcome to select the exact `WorkflowDefinitionVersion`
 * a `PurchaseLine` runs under. No repository, no Prisma, no gateway, no clock, no I/O.
 *
 * SINGLE ENGINE
 * -------------
 * `RuleEngineService.evaluateSync` is the only evaluator. This file merely builds the set
 * and interprets the result. There is no second filter engine.
 *
 * DETERMINISM
 * -----------
 * Routes are ordered by their `targetWorkflowDefinitionVersionId` before hashing, so the
 * `RuleSetVersion` is identical whatever order the database returned them in. The engine
 * orders by priority, specificity and rule id, so the winner is deterministic.
 */

/** The identity of the line routing rule set (§5.15). */
export const WORKFLOW_LINE_ROUTING_RULE_SET_ID = 'commerce.workflow.line.selection' as const;

/** The prefix every line-route rule id carries. */
export const WORKFLOW_LINE_ROUTING_RULE_ID_PREFIX = 'line-route:' as const;

/** Reasons the planner may return INVALID. */
export const WORKFLOW_LINE_ROUTING_REASON_NOT_EVALUATED = 'LINE_ROUTING_NOT_EVALUATED' as const;
export const WORKFLOW_LINE_ROUTING_REASON_WINNING_RULE_MISSING = 'LINE_ROUTING_WINNING_RULE_MISSING' as const;
export const WORKFLOW_LINE_ROUTING_REASON_RULE_REFERENCE_MISMATCH = 'LINE_ROUTING_RULE_REFERENCE_MISMATCH' as const;

/** A tautology the engine accepts for unconditional routes: every line has a `lineType`. */
export const WORKFLOW_LINE_ROUTING_UNCONDITIONAL_CONDITION: RuleConditionNode = Object.freeze({
  field: 'lineType',
  op: 'isNotEmpty',
});

/**
 * PHASE C3 (GAP-2): the three CLOSED vocabularies a routing version's policies are drawn from
 * (O2, O3, O4) and the width of its label, stated ONCE for both ends of the boundary.
 *
 * WHY THEY LIVE IN THE PURE MODULE AND NOT IN THE DTO. Exactly as the workflow slice keeps
 * `WORKFLOW_TRIGGER_EVENTS`/`WORKFLOW_MAX_VERSION_LABEL_LENGTH` in `workflow-configuration.ts`
 * and the commercial slice keeps its own in `commercial-status.ts`, the vocabulary belongs
 * beside the pure logic that interprets it. The DTO validates against these tuples
 * (`@IsIn`) and the publication gate compares against the same tuples, so the DTO is the
 * CONTRACT and this module is the GUARANTEE: a member added to only one of them would either
 * be stored and then refused at publish, or refused at the boundary while the schema could
 * hold it — the two failure modes the workflow DTO's own note names.
 */

/** O2 — what line routing does when a line matches no route. */
export const WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS = [
  'REJECT_OPERATION',
  'LEAVE_UNROUTED',
] as const;

/** O3 — how a version resolves several matching routes. */
export const WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS = [
  'HIGHEST_PRIORITY',
  'AMBIGUOUS_ERROR',
] as const;

/** O4 — how line outcomes may influence the document's state. */
export const WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES = ['ALL_APPROVED', 'INDEPENDENT'] as const;

/** `WorkflowLineRoutingVersion.versionLabel` — `VARCHAR(64)`, the storage width. */
export const WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH = 64;

/** The outcome families a line routing selection can produce. */
export type WorkflowLineRoutingSelectionOutcome =
  | 'SELECTED'
  | 'NO_ROUTE'
  | 'AMBIGUOUS'
  | 'INVALID';

/** One route candidate inside a versioned routing configuration. */
export interface WorkflowLineRoute {
  readonly priority: number;
  readonly condition: RuleConditionNode | null;
  readonly targetWorkflowDefinitionVersionId: string;
  readonly description?: string;
}

/** The subset of a routing version the planner needs. */
export interface WorkflowLineRoutingPlanInput {
  readonly routes: readonly WorkflowLineRoute[];
  readonly multipleMatchBehavior: 'HIGHEST_PRIORITY' | 'AMBIGUOUS_ERROR';
}

/** The deterministic result of selecting a route for one line. */
export interface WorkflowLineRoutingSelectionPlan {
  readonly outcome: 'SELECTED';
  readonly targetWorkflowDefinitionVersionId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSetVersion: string;
}

export interface WorkflowLineRoutingNoRoutePlan {
  readonly outcome: 'NO_ROUTE';
  readonly ruleSetVersion: string;
}

export interface WorkflowLineRoutingAmbiguousPlan {
  readonly outcome: 'AMBIGUOUS';
  readonly tiedTargetVersionIds: readonly string[];
  readonly ruleSetVersion: string;
}

export interface WorkflowLineRoutingInvalidPlan {
  readonly outcome: 'INVALID';
  readonly reason: string;
  readonly ruleSetVersion: string;
}

export type WorkflowLineRoutingPlan =
  | WorkflowLineRoutingSelectionPlan
  | WorkflowLineRoutingNoRoutePlan
  | WorkflowLineRoutingAmbiguousPlan
  | WorkflowLineRoutingInvalidPlan;

export function workflowLineRoutingRuleId(targetWorkflowDefinitionVersionId: string): string {
  return `${WORKFLOW_LINE_ROUTING_RULE_ID_PREFIX}${targetWorkflowDefinitionVersionId}`;
}

/** The content digest of a route list: every route's id, priority and condition. */
export function workflowLineRoutingSetVersion(routes: readonly WorkflowLineRoute[]): string {
  const ordered = [...routes].sort((left, right) => {
    if (left.targetWorkflowDefinitionVersionId === right.targetWorkflowDefinitionVersionId) return 0;
    return left.targetWorkflowDefinitionVersionId < right.targetWorkflowDefinitionVersionId ? -1 : 1;
  });

  return workflowContentDigest([
    WORKFLOW_LINE_ROUTING_RULE_SET_ID,
    'routes',
    ordered.map((route) => [
      route.targetWorkflowDefinitionVersionId,
      route.priority,
      route.condition ?? WORKFLOW_LINE_ROUTING_UNCONDITIONAL_CONDITION,
    ]),
  ]);
}

function workflowLineRoutingAction(targetWorkflowDefinitionVersionId: string) {
  return Object.freeze({
    type: 'REQUIRED_APPROVAL_STEP' as const,
    stepOrder: 1,
    approverRuleRef: targetWorkflowDefinitionVersionId,
  });
}

/**
 * The `commerce.workflow.line.selection` Rule Set built from the route candidates.
 *
 * Each route becomes one rule whose id and action both name the exact target version id,
 * so the engine's winning action is directly translatable into the pinned version.
 */
export function workflowLineRoutingRuleSet(
  routes: readonly WorkflowLineRoute[]
): RuleSetVersion {
  const version = workflowLineRoutingSetVersion(routes);

  const rules = routes.map((route): RuleSpec =>
    Object.freeze({
      id: workflowLineRoutingRuleId(route.targetWorkflowDefinitionVersionId),
      version,
      name: route.description ?? route.targetWorkflowDefinitionVersionId,
      priority: route.priority,
      condition: route.condition ?? WORKFLOW_LINE_ROUTING_UNCONDITIONAL_CONDITION,
      actions: Object.freeze([workflowLineRoutingAction(route.targetWorkflowDefinitionVersionId)]),
    })
  );

  return Object.freeze({
    ruleSetId: WORKFLOW_LINE_ROUTING_RULE_SET_ID,
    version,
    status: 'PUBLISHED',
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE,
    rules: Object.freeze(rules),
  });
}

/** The set of target version ids whose route condition matched. */
function matchedLineRouteTargetIds(result: { readonly matchHistory: readonly { readonly matched: boolean; readonly ruleId: string }[] }): readonly string[] {
  return result.matchHistory
    .filter((record) => record.matched)
    .map((record) => record.ruleId.slice(WORKFLOW_LINE_ROUTING_RULE_ID_PREFIX.length));
}

/** Whether more than one matched route ties at the top priority. */
function topPriorityIsTied(
  result: { readonly matchHistory: readonly { readonly matched: boolean; readonly priority: number; readonly ruleId: string }[] }
): boolean {
  const matched = result.matchHistory.filter((record) => record.matched);
  if (matched.length === 0) return false;
  const topPriority = Math.max(...matched.map((record) => record.priority));
  const topMatches = matched.filter((record) => record.priority === topPriority);
  return topMatches.length > 1;
}

/**
 * Read the engine's deterministic outcome and produce the routing plan.
 *
 * `HIGHEST_PRIORITY` lets the engine resolve by priority/specificity, but still refuses a tie
 * at the highest priority. `AMBIGUOUS_ERROR` refuses whenever more than one route's condition
 * is true, regardless of priority.
 */
export function planWorkflowLineRouting(
  input: WorkflowLineRoutingPlanInput,
  outcome: RuleEvaluationOutcome | null
): WorkflowLineRoutingPlan {
  const routes = input.routes;
  const ruleSetVersion = workflowLineRoutingSetVersion(routes);

  if (routes.length === 0) {
    return { outcome: 'NO_ROUTE', ruleSetVersion };
  }

  if (outcome === null) {
    return { outcome: 'INVALID', reason: WORKFLOW_LINE_ROUTING_REASON_NOT_EVALUATED, ruleSetVersion };
  }

  if (!outcome.evaluated) {
    return { outcome: 'INVALID', reason: outcome.reason, ruleSetVersion };
  }

  const result = outcome.result;

  if (result.status === 'REFUSED_INVALID_VERSION' || result.status === 'REFUSED_BOUNDS_EXCEEDED') {
    return { outcome: 'INVALID', reason: result.status, ruleSetVersion };
  }

  if (result.status === 'NO_MATCH') {
    return { outcome: 'NO_ROUTE', ruleSetVersion };
  }

  if (input.multipleMatchBehavior === 'AMBIGUOUS_ERROR') {
    const matchedIds = matchedLineRouteTargetIds(result);
    if (matchedIds.length > 1) {
      return { outcome: 'AMBIGUOUS', tiedTargetVersionIds: matchedIds, ruleSetVersion };
    }
  }

  if (input.multipleMatchBehavior === 'HIGHEST_PRIORITY' && topPriorityIsTied(result)) {
    const matchedIds = matchedLineRouteTargetIds(result);
    return { outcome: 'AMBIGUOUS', tiedTargetVersionIds: matchedIds, ruleSetVersion };
  }

  const winningRule = result.winningRule;
  if (winningRule === null) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_LINE_ROUTING_REASON_WINNING_RULE_MISSING,
      ruleSetVersion,
    };
  }

  const action = winningRule.action;
  const targetWorkflowDefinitionVersionId =
    action.type === 'REQUIRED_APPROVAL_STEP' ? action.approverRuleRef : undefined;

  const winnerCandidate = routes.find(
    (route) =>
      workflowLineRoutingRuleId(route.targetWorkflowDefinitionVersionId) === winningRule.ruleId
  );

  if (
    winnerCandidate === undefined ||
    targetWorkflowDefinitionVersionId !== winnerCandidate.targetWorkflowDefinitionVersionId
  ) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_LINE_ROUTING_REASON_RULE_REFERENCE_MISMATCH,
      ruleSetVersion,
    };
  }

  return {
    outcome: 'SELECTED',
    targetWorkflowDefinitionVersionId,
    ruleId: winningRule.ruleId,
    ruleVersion: winningRule.ruleVersion,
    ruleSetVersion,
  };
}
