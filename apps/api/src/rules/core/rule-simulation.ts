import {
  RULE_SIMULATION_BANNER,
  RULE_SIMULATION_MODE,
  RuleEvaluationRequest,
  SimulationResult,
} from '../rule-evaluation.interface';
import { evaluateRuleSetVersion } from './rule-evaluator';

/**
 * Simulation: the **real** engine over a **supplied** context, applying **nothing** (§14).
 *
 * Frozen rules this function exists to satisfy:
 *
 *  1. **Non-mutating, absolutely.** There is nothing to mutate: the inputs are data, the evaluator
 *     is pure, and the output is a value. No leave record, no approval instance, no step, no
 *     notification and no success-mutation audit is touched, because the engine has no access to any
 *     of them (§9.1, D12). The engine's purity *is* the guarantee.
 *  2. **Real engine, real validation, real ordering** (§14.2). This is a wrapper, not a simplified
 *     evaluator: an invalid definition is refused with the same report publish would produce, and
 *     the ordering, specificity and match history are the production ones.
 *  3. **Labelled everywhere** (§14.5). `mode` and the banner are part of the response, so a
 *     screenshot of a simulation cannot be mistaken for a real decision.
 *  4. **Bounded** as any evaluation is (§34): the work budget, the collection bound and the
 *     explanation bound all apply unchanged.
 *
 * Tenancy (who the facts belong to) and permission (who may simulate) are the caller's concerns and
 * are deliberately absent here: the engine never resolves a tenant (§14.3, §24).
 */
export function simulateRuleSetVersion(input: RuleEvaluationRequest): SimulationResult {
  const result = evaluateRuleSetVersion(input);

  return {
    ...result,
    mode: RULE_SIMULATION_MODE,
    banner: RULE_SIMULATION_BANNER,
    wouldApply: result.decisionActions,
  };
}
