import { EvaluationResult, SimulationResult } from './rule-evaluation.interface';
import { RuleLifecycleIssue, RuleValidationResult } from './rule-validation.interface';

/**
 * The engine **tier**'s outcome contract (§6.1, §6.3, §6.4).
 *
 * The pure core of `core/` answers one question: given a version and a context, what is decided.
 * This contract answers the question in front of it — *which version is being asked, and may it
 * decide at all* — because that is a fact about the store, not about the decision. The two answers
 * are kept apart on purpose, so a caller can never read "no version is published" as "the request
 * was refused by policy": the first arm carries a decision, the second carries a lifecycle issue.
 *
 * Neither arm is an exception (§6.4). The domain path receives a value and turns it into a readable
 * 409/422; the legacy synchronous API keeps its historic `NotFoundException`, and the two never
 * share a code path.
 */

/**
 * Reasons no version was evaluated (§6.4, §10.3).
 *
 * @remarks These are the engine tier's own codes. The frozen lifecycle vocabulary
 * (`RuleLifecycleIssueCode`) is used *inside* the second arm for the version's own refusal, and is
 * not extended or renamed here: a store-level "there is nothing to evaluate" is a different fact
 * from "this version may not be published", and conflating them would corrupt the frozen vocabulary.
 */
export type RuleNotEvaluatedReason =
  /** No version with this `(rule-set id, version)` is stored (§10.1). */
  | 'RULE_SET_VERSION_UNKNOWN'
  /** The version exists, but it is not the version a business decision may use (§10.3). */
  | 'RULE_SET_VERSION_NOT_EVALUABLE';

/**
 * Nothing was evaluated, and this is why.
 *
 * @remarks A refusal is always *specific*: `ruleSetVersion` is the version that was asked about,
 * and `null` only in the one case where nothing was asked about a version at all — a rule set with
 * no published version (§14 defaults to the published version, and day one has none, §15.8).
 */
export type RuleNotEvaluated =
  | {
      readonly evaluated: false;
      readonly reason: 'RULE_SET_VERSION_UNKNOWN';
      readonly ruleSetId: string;
      readonly ruleSetVersion: string;
    }
  | {
      readonly evaluated: false;
      readonly reason: 'RULE_SET_VERSION_NOT_EVALUABLE';
      readonly ruleSetId: string;
      readonly ruleSetVersion: string | null;
      /** The lifecycle refusal, from the frozen vocabulary (§11). */
      readonly issue: RuleLifecycleIssue;
      /**
       * The version's own validation report, so "why may it not decide" is answerable without
       * re-validating, or `null` when no version was selected to report on.
       */
      readonly validation: RuleValidationResult | null;
    };

/** A decision, or the typed reason no version could decide it (§6.3, §6.4). */
export type RuleEvaluationOutcome =
  { readonly evaluated: true; readonly result: EvaluationResult } | RuleNotEvaluated;

/** A simulation, or the typed reason there was nothing to simulate (§14). */
export type RuleSimulationOutcome =
  { readonly evaluated: true; readonly result: SimulationResult } | RuleNotEvaluated;
