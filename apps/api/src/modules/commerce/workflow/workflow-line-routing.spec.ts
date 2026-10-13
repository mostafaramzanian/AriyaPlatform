import {
  planWorkflowLineRouting,
  workflowLineRoutingRuleSet,
  workflowLineRoutingSetVersion,
  WORKFLOW_LINE_ROUTING_RULE_SET_ID,
  WORKFLOW_LINE_ROUTING_REASON_NOT_EVALUATED,
  WORKFLOW_LINE_ROUTING_REASON_WINNING_RULE_MISSING,
  WORKFLOW_LINE_ROUTING_REASON_RULE_REFERENCE_MISMATCH,
  type WorkflowLineRoute,
} from './workflow-line-routing';
import { EvaluationResult } from '../../../rules/rule-evaluation.interface';
import { RuleEvaluationOutcome } from '../../../rules/rule-engine.interface';

function makeOutcome(result: unknown): RuleEvaluationOutcome {
  return { evaluated: true as const, result: result as unknown as EvaluationResult };
}

function makeResult(overrides: unknown): EvaluationResult {
  return overrides as EvaluationResult;
}

const STANDARD_ROUTE: WorkflowLineRoute = {
  priority: 10,
  condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
  targetWorkflowDefinitionVersionId: 'v-standard',
};

const SERVICE_ROUTE: WorkflowLineRoute = {
  priority: 5,
  condition: { field: 'lineType', op: 'equals', value: 'SERVICE' },
  targetWorkflowDefinitionVersionId: 'v-service',
};

const HIGH_PRIORITY_SERVICE_ROUTE: WorkflowLineRoute = {
  priority: 15,
  condition: { field: 'lineType', op: 'equals', value: 'SERVICE' },
  targetWorkflowDefinitionVersionId: 'v-service-high',
};

const UNCONDITIONAL_ROUTE: WorkflowLineRoute = {
  priority: 1,
  condition: null,
  targetWorkflowDefinitionVersionId: 'v-all',
};

const selectionResult = (winnerId: string): EvaluationResult =>
  makeResult({
    status: 'DECIDED',
    winningRule: {
      ruleId: `line-route:${winnerId}`,
      ruleVersion: 'v1',
      priority: 10,
      specificity: 1,
      ruleName: winnerId,
      action: { type: 'REQUIRED_APPROVAL_STEP', stepOrder: 1, approverRuleRef: winnerId },
    },
    matchHistory: [
      {
        ruleId: `line-route:${winnerId}`,
        ruleName: winnerId,
        ruleVersion: 'v1',
        priority: 10,
        specificity: 1,
        matched: true,
      },
    ],
  });

describe('Phase C1 Step O — workflow-line-routing', () => {
  it('builds the dedicated commerce.workflow.line.selection rule set', () => {
    const set = workflowLineRoutingRuleSet([STANDARD_ROUTE]);
    expect(set.ruleSetId).toBe(WORKFLOW_LINE_ROUTING_RULE_SET_ID);
    expect(set.schemaVersion).toBeDefined();
    expect(set.rules).toHaveLength(1);
    expect(set.rules[0].id).toBe('line-route:v-standard');
  });

  it('produces a deterministic set version independent of route input order', () => {
    const versionA = workflowLineRoutingSetVersion([STANDARD_ROUTE, SERVICE_ROUTE]);
    const versionB = workflowLineRoutingSetVersion([SERVICE_ROUTE, STANDARD_ROUTE]);
    expect(versionA).toBe(versionB);
  });

  it('returns NO_ROUTE for an empty route list', () => {
    const plan = planWorkflowLineRouting(
      { routes: [], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      null
    );
    expect(plan.outcome).toBe('NO_ROUTE');
  });

  it('returns NO_ROUTE when the engine reports no match', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(makeResult({ status: 'NO_MATCH', matchHistory: [] }))
    );
    expect(plan.outcome).toBe('NO_ROUTE');
  });

  it('SELECTED returns the winning rule target version', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(selectionResult('v-standard'))
    );
    expect(plan.outcome).toBe('SELECTED');
    if (plan.outcome === 'SELECTED') {
      expect(plan.targetWorkflowDefinitionVersionId).toBe('v-standard');
      expect(plan.ruleId).toBe('line-route:v-standard');
    }
  });

  it('AMBIGUOUS_ERROR refuses multiple matches', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE, UNCONDITIONAL_ROUTE], multipleMatchBehavior: 'AMBIGUOUS_ERROR' },
      makeOutcome(
        makeResult({
          status: 'DECIDED',
          winningRule: null,
          matchHistory: [
            { ruleId: 'line-route:v-standard', priority: 10, matched: true },
            { ruleId: 'line-route:v-all', priority: 1, matched: true },
          ],
        })
      )
    );
    expect(plan.outcome).toBe('AMBIGUOUS');
    if (plan.outcome === 'AMBIGUOUS') {
      expect(plan.tiedTargetVersionIds).toContain('v-standard');
      expect(plan.tiedTargetVersionIds).toContain('v-all');
    }
  });

  it('HIGHEST_PRIORITY resolves a lower-priority match without a top tie', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE, SERVICE_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(
        makeResult({
          status: 'DECIDED',
          winningRule: {
            ruleId: 'line-route:v-standard',
            ruleVersion: 'v1',
            priority: 10,
            specificity: 1,
            ruleName: 'standard',
            action: { type: 'REQUIRED_APPROVAL_STEP', stepOrder: 1, approverRuleRef: 'v-standard' },
          },
          matchHistory: [
            { ruleId: 'line-route:v-standard', priority: 10, matched: true },
            { ruleId: 'line-route:v-service', priority: 5, matched: true },
          ],
        })
      )
    );
    expect(plan.outcome).toBe('SELECTED');
    if (plan.outcome === 'SELECTED') {
      expect(plan.targetWorkflowDefinitionVersionId).toBe('v-standard');
    }
  });

  it('HIGHEST_PRIORITY returns AMBIGUOUS when the top priority is tied', () => {
    const plan = planWorkflowLineRouting(
      { routes: [SERVICE_ROUTE, HIGH_PRIORITY_SERVICE_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(
        makeResult({
          status: 'DECIDED',
          winningRule: null,
          matchHistory: [
            { ruleId: 'line-route:v-service', priority: 15, matched: true },
            { ruleId: 'line-route:v-service-high', priority: 15, matched: true },
          ],
        })
      )
    );
    expect(plan.outcome).toBe('AMBIGUOUS');
  });

  it('INVALID when the winning rule action references a different route', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(
        makeResult({
          status: 'DECIDED',
          winningRule: {
            ruleId: 'line-route:v-standard',
            ruleVersion: 'v1',
            priority: 10,
            specificity: 1,
            ruleName: 'standard',
            action: { type: 'REQUIRED_APPROVAL_STEP', stepOrder: 1, approverRuleRef: 'v-rogue' },
          },
          matchHistory: [{ ruleId: 'line-route:v-standard', priority: 10, matched: true }],
        })
      )
    );
    expect(plan.outcome).toBe('INVALID');
    if (plan.outcome === 'INVALID') {
      expect(plan.reason).toBe(WORKFLOW_LINE_ROUTING_REASON_RULE_REFERENCE_MISMATCH);
    }
  });

  it('INVALID reports a missing evaluation', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      null
    );
    expect(plan.outcome).toBe('INVALID');
    if (plan.outcome === 'INVALID') {
      expect(plan.reason).toBe(WORKFLOW_LINE_ROUTING_REASON_NOT_EVALUATED);
    }
  });

  it('INVALID reports a missing winning rule', () => {
    const plan = planWorkflowLineRouting(
      { routes: [STANDARD_ROUTE], multipleMatchBehavior: 'HIGHEST_PRIORITY' },
      makeOutcome(
        makeResult({ status: 'DECIDED', winningRule: null, matchHistory: [{ ruleId: 'line-route:v-standard', priority: 10, matched: true }] })
      )
    );
    expect(plan.outcome).toBe('INVALID');
    if (plan.outcome === 'INVALID') {
      expect(plan.reason).toBe(WORKFLOW_LINE_ROUTING_REASON_WINNING_RULE_MISSING);
    }
  });
});
