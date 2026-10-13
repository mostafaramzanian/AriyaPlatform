import { RULE_ENGINE_SCHEMA_VERSION } from '../../../rules/core/rule-limits';
import type { RuleAction } from '../../../rules/rule-action.interface';
import type {
  RuleConditionNode,
  RuleComparisonCondition,
} from '../../../rules/rule-condition.interface';
import type { RuleSetVersion, RuleSpec } from '../../../rules/rule-spec.interface';
import type { RuleSetStatus } from '../../../rules/rule.types';
import { LEAVE_LIMIT_RULE_SET_ID } from '../domain/leave-policy';
import type { LeaveLimitCountingBasis, LeaveLimitEmploymentType } from '../domain/leave-policy';
import {
  LEAVE_LIMIT_SIMULATION_CATALOGUE,
  simulationCollectionFor,
  toSimulationDay,
} from './leave-limit-simulation-facts';

/**
 * Phase 54-H (§14, §16, §10.1-§10.3, D1): the SIMULATION-ONLY projection of a stored leave-policy
 * version into a `RuleSetVersion` the generic engine can validate and evaluate.
 *
 * WHY A PROJECTION IS NEEDED AT ALL, AND WHY IT IS THE SMALLEST POSSIBLE ONE
 * ------------------------------------------------------------------------
 * §14 defines the simulation contract over a `ruleSetId` and a version, because the engine's unit is
 * a `RuleSetVersion` (§10.1). HR stores a `LeavePolicyVersion` in `hr_db` — a lifecycle state, an
 * effective window, and a set of authored LIMITS. The two are different shapes, and §1/D1 puts the
 * boundary exactly here: "reusable rule execution belongs to Platform; business rule configuration
 * belongs to the consuming bounded domain."
 *
 * So this function is the crossing, and it goes ONE WAY ONLY: HR reads its own stored rows and hands
 * the engine a VALUE. It is deliberately not a repository, not a Nest provider and not a store:
 *
 *   * it PERSISTS NOTHING. Its return value is discarded after evaluation, so no `RuleSetVersion`
 *     row, column or registry entry is created (§14.1, §23.7: "simulation produces no snapshot at
 *     all"). There is no `RuleRegistryService` call anywhere in this file, which is what makes a
 *     simulated DRAFT unable to become a runtime version by being simulated.
 *   * it does not add a lifecycle. The four HR states ARE the four engine states (`DRAFT`,
 *     `VALIDATED`, `PUBLISHED`, `ARCHIVED`), so the projection only has to copy the state across —
 *     §10.3's evaluation rules then apply unchanged, which is why the caller reaches the engine
 *     through `simulateSync` (the version-as-value door) rather than `simulateVersion` (which
 *     refuses anything unpublished).
 *   * the generated rules are GENERAL, not hard-coded to one policy. Each stored limit becomes one
 *     rule, so a version carrying five limits simulates five rules in one evaluation.
 *
 * WHY EVERY VERSION MAPS TO ONE LOGICAL IDENTITY
 * ----------------------------------------------
 * `LEAVE_LIMIT_RULE_SET_ID` (`'hr.leave.limit'`) is the ONE logical identity every participating
 * version maps to (A1). The projection is what makes that a fact about data rather than a comment:
 * every version HR simulates reports the same `ruleSetId`, so a caller cannot invent a second
 * identity and the engine cannot see two sets where the tenant has one configuration.
 */

/**
 * The version LABEL the projection reports for a stored policy version.
 *
 * AN EXPLICIT INPUT, NOT A RE-DERIVATION. The caller passes the stored row's own identity, so the
 * engine's `(ruleSetId, version)` pair names the same thing HR's row names — §10.1 makes that pair an
 * identity, and inventing a label here (a sequence number, a hash, "latest") would create a second
 * way to refer to one version, which is the drift §10.2's "a reused label is never a new version"
 * exists to prevent.
 *
 * It is the `versionLabel` the author typed when the version was created, because that is the label
 * the authoring screens and the audit trail already use.
 */
export interface LeaveLimitSimulationVersionInput {
  readonly versionLabel: string;
  readonly status: RuleSetStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly limits: readonly LeaveLimitSimulationLimit[];
}

/** One stored limit, reduced to the fields the projection needs — the stored row, not an auth row. */
export interface LeaveLimitSimulationLimit {
  readonly id: string;
  readonly leaveTypeId: string;
  readonly employmentType: LeaveLimitEmploymentType | null;
  readonly maximum: number;
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly consumedStates: readonly string[];
}

/**
 * The rule id of one projected limit.
 *
 * DERIVED FROM THE LIMIT'S OWN ID so the id is stable across evaluations of the same stored row: two
 * simulations of one version produce identical results (§36.4's idempotency, and §13.2's "an
 * explanation is derived, never recomputed"). The `hr.leave.limit.` prefix keeps it inside the
 * namespace the rule-set identity establishes, and the shape satisfies `isSafeIdentifier`.
 */
function ruleIdFor(limitId: string): string {
  return `${LEAVE_LIMIT_RULE_SET_ID}.${limitId}`;
}

/**
 * One stored limit as a rule that REFUSES when the count exceeds the maximum (§16.7).
 *
 * THE CONDITION IS ONE `count` NODE OVER THE BASIS'S COLLECTION, and that is the whole translation:
 *
 *   REQUEST_COUNT → over: leaveRequestsInWindow
 *   DAY_COUNT     → over: leaveDaysInWindow
 *
 * `op` IS `greaterThan` AND THE THRESHOLD IS THE MAXIMUM, because `exceeded` is defined as
 * `count > maximum` in Phase 54-G's `evaluateLeaveLimit` and re-stating it as
 * `greaterThanOrEqual maximum + 1` would encode the same rule twice with two chances to drift. §16's
 * `maximum` is an INCLUDED ceiling, and `greaterThan` is exactly that.
 *
 * THE `where` CLAUSE RE-STATES THE FILTERS THE PROJECTION ALREADY APPLIED, deliberately: the engine's
 * match history and leaf paths are what an explanation is rendered from (§13.1), so a rule whose
 * condition names `leaveTypeId` and `status` can say WHICH facts decided it. A condition of one bare
 * `count` would decide identically but explain nothing, and §13.2 makes "derive, never recompute" a
 * requirement — an explanation cannot re-run a filter the condition never stated.
 */
function projectionRuleFor(limit: LeaveLimitSimulationLimit): RuleSpec {
  const collection = simulationCollectionFor(limit.countingBasis);

  const where: RuleComparisonCondition[] = [
    { field: 'leaveTypeId', op: 'equals', value: limit.leaveTypeId },
    { field: 'status', op: 'in', value: [...limit.consumedStates] },
  ];

  const condition: RuleConditionNode = {
    count: {
      over: collection,
      where,
      op: 'greaterThan',
      value: limit.maximum,
    },
  };

  /**
   * §16.7's grounds, verbatim in the engine's own action type. `limitRef` is the STORED limit id, so
   * an explanation's "which limit said no" resolves to the row an operator can open; the remaining
   * four fields are the ones `LeaveLimitEvaluation` already carries, which is why the runtime and the
   * simulation cannot describe the same refusal differently.
   */
  const action: RuleAction = {
    type: 'LIMIT_REFUSAL',
    limitRef: limit.id,
    countingBasis: limit.countingBasis,
    maximum: limit.maximum,
    windowStart: toSimulationDay(limit.windowStart),
    windowEnd: toSimulationDay(limit.windowEnd),
  };

  return {
    id: ruleIdFor(limit.id),
    /**
     * The rule's own revision label. It is the limit's id again rather than a counter, for the
     * stability reason `ruleIdFor` records: a decision must be able to name the text it used (§13),
     * and "the third rule of the fourth evaluation" does not.
     */
    version: limit.id,
    name: `${collection}:${limit.id}`,
    /**
     * Every projected rule carries the SAME priority, and D11 is why that is safe rather than lazy:
     * the limits of one policy version are all in force simultaneously, and a request that breaches
     * two of them has breached two. There is no "winner" to pick, so none is invented to pick one —
     * equal priorities let the evaluation report the group, and the caller renders EVERY breach
     * (§13, §16.7) instead of one. A descending priority would silently discard the second refusal,
     * which is exactly the "silent winner" D11 forbids.
     */
    priority: 0,
    condition,
    actions: [action],
  };
}

/**
 * Projects a stored policy version into the simulation-only `RuleSetVersion` the engine evaluates.
 *
 * WHAT IS COPIED, AND WHAT IS DELIBERATELY NOT
 * -------------------------------------------
 *   * `ruleSetId` is `LEAVE_LIMIT_RULE_SET_ID` — the one logical identity (A1).
 *   * `version` is the stored row's own label (A3): no translation, no fallback.
 *   * `status` is the stored state, copied UNCHANGED, so §10.3's evaluation rules apply to the four
 *     HR states as they already are. Nothing here promotes, validates or archives anything.
 *   * `fields` is HR's own catalogue — the consuming domain owns it (§8.3).
 *   * `effectiveFrom`/`effectiveTo` are the stored version's own dates, so a historical simulation
 *     reports the window the version actually occupied (§11, §23.2).
 *
 * THE PROJECTION IS FROZEN AT EVERY LEVEL. §10.6 requires a stored version to be immutable ("frozen
 * when published and never mutated"); this value is never published, but freezing it means a caller
 * cannot edit a projected draft and thereby simulate a configuration that exists nowhere. What is
 * frozen is what was stored.
 */
export function projectLeaveLimitRuleSetVersion(
  input: LeaveLimitSimulationVersionInput
): RuleSetVersion {
  const rules = input.limits.map((limit) => Object.freeze(projectionRuleFor(limit)));

  return Object.freeze({
    ruleSetId: LEAVE_LIMIT_RULE_SET_ID,
    version: input.versionLabel,
    status: input.status,
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: LEAVE_LIMIT_SIMULATION_CATALOGUE,
    rules: Object.freeze(rules),
    // `supersedes` is deliberately ABSENT rather than `null`: a policy version records what replaced
    // it through the ARCHIVED state and the successor's effective date, and repeating that here would
    // be a second answer to "what replaced this?" that a projection cannot keep true.
    effectiveFrom: toSimulationDay(input.effectiveFrom),
    effectiveTo: input.effectiveTo === null ? null : toSimulationDay(input.effectiveTo),
  });
}
