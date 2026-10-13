import { RuleAction } from './rule-action.interface';
import { RuleSetVersion } from './rule-spec.interface';
import {
  RuleValidationResult,
  RuleOrderingBasis,
  RuleConflictReport,
} from './rule-validation.interface';
import {
  RuleActionType,
  RuleConditionOutcome,
  RuleDecisionNone,
  RuleEvaluationStatus,
  RuleFactValue,
  RuleInstant,
} from './rule.types';

/**
 * The evaluation contract (§6.3, §13, §14).
 *
 * Field names in `EvaluationResult`, `RuleMatchRecord` and `SimulationResult` follow the frozen
 * specification. Additive fields are marked as such in their own documentation and never change
 * the meaning of a frozen one.
 */

/**
 * Typed facts plus an **explicit** instant (§6.3, D12).
 *
 * @remarks The engine never reads a clock and never resolves a tenant: `evaluationInstant` is an
 * argument, and tenancy is the caller's concern (the tenant comes from the resolved actor, §14.3).
 * Collections are supplied bounded by the application layer; the engine never queries them.
 */
export interface EvaluationContext {
  /** Scalar facts, and bounded record arrays for fields declared `collection` (§8.3, §8.4). */
  readonly facts: Readonly<Record<string, RuleFactValue>>;
  /** Explicit evaluation instant, ISO-8601. Required: there is no default in the engine. */
  readonly evaluationInstant: RuleInstant;
}

/** What a caller hands to the typed core: a version and an assembled context. */
export interface RuleEvaluationRequest {
  readonly ruleSetVersion: RuleSetVersion;
  readonly context: EvaluationContext;
}

/** The count actually observed on a collection that a rule aggregated over (§16.7). */
export interface RuleObservedCount {
  readonly over: string;
  readonly count: number;
}

/**
 * One considered rule (§13). **Every** rule of the version appears, in the declared ordering
 * (§12.1) — the completeness the previous first-match engine did not provide (§6.0).
 */
export interface RuleMatchRecord {
  readonly ruleId: string;
  readonly ruleName: string;
  /** Additive (see the file doc): the rule's revision label, carried so a decision names its text. */
  readonly ruleVersion: string;
  readonly priority: number;
  readonly specificity: number;
  /**
   * Frozen meaning: `true` exactly when the rule's condition was proved true.
   *
   * @remarks An `UNKNOWN` condition is reported as `matched: false` — an unproven match is not a
   * match — while the reason is preserved verbatim in `conditionOutcome` and `missingFields`, so
   * no information is lost and a refusal is still explainable (§10.3, §16.6).
   */
  readonly matched: boolean;
  /** Additive: `TRUE` | `FALSE` | `UNKNOWN`, so an undecidable rule is never indistinguishable
   *  from a decided-false one. */
  readonly conditionOutcome: RuleConditionOutcome;
  /** Leaf paths whose comparison was false (§13). Always present; empty when there were none. */
  readonly failedLeaves: readonly string[];
  /** Additive: leaf paths whose comparison was true — the grounds an action is explained by
   *  without re-evaluating (§9.2). Ordered as declared. */
  readonly matchedLeaves: readonly string[];
  /** Additive: declared facts the context did not state (§16.6). Sorted; deduplicated. */
  readonly missingFields: readonly string[];
  /** Present for matching rules: the primary (first) action type of the rule (§13). */
  readonly decision?: RuleActionType;
  /** Present when the rule failed during evaluation: it is skipped, never fatal (§6.4). */
  readonly error?: { readonly message: string };
}

/** A winning rule, with the three ordering keys that produced it (§12.1, §13). */
export interface RuleWinningRule extends RuleOrderingBasis {
  readonly ruleName: string;
  readonly ruleVersion: string;
  /** The primary action. The full typed action list is `decisionActions`. */
  readonly action: RuleAction;
}

/** A bound that was exceeded, reported instead of truncating silently (§8.4, §34). */
export interface RuleBoundsReport {
  readonly limit: string;
  readonly observed: number;
  readonly maximum: number;
}

/**
 * The full result of an evaluation: the decision **and why** (§13).
 *
 * @remarks `decision` is the winning action or the literal `'NONE'` (§13); `winningRule` carries
 * the ordering keys; `matchHistory` is complete and ordered; `orderingBasis` is the exact basis of
 * the winner. `status` is the typed outcome of §6.4 and `validation` carries the same report
 * publish would have produced (§14.2) — the engine executes nothing it has not validated.
 */
export interface EvaluationResult {
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly evaluationInstant: RuleInstant;
  readonly status: RuleEvaluationStatus;
  readonly decision: RuleAction | RuleDecisionNone;
  readonly winningRule: RuleWinningRule | null;
  /** Additive: every action of the winning rule, in declared order (§9.2). */
  readonly decisionActions: readonly RuleAction[];
  readonly matchHistory: readonly RuleMatchRecord[];
  readonly orderingBasis: RuleOrderingBasis | null;
  /** Additive: observed aggregate counts, sorted by collection name (deterministic). */
  readonly observedCounts: readonly RuleObservedCount[];
  /** Additive: union of `missingFields` over rules that could not be decided, sorted. */
  readonly missingFields: readonly string[];
  /**
   * Deterministic, locale-independent summary composed from codes, ids, numbers and dates only
   * (§13.4). It contains no domain prose and no Persian; a UI renders from the typed fields.
   */
  readonly explanationText: string;
  /** Additive: conflicts observed during evaluation (which validation refuses at publish). */
  readonly conflicts: readonly RuleConflictReport[];
  /** The validation report this evaluation was gated on (§14.2). */
  readonly validation: RuleValidationResult;
  /** Additive: present only when a bound was exceeded. */
  readonly bounds?: RuleBoundsReport;
}

/**
 * A simulation: the real engine over a supplied context, applying nothing (§14).
 *
 * @remarks `mode` and `banner` are part of the response *and* of the UI (§14.5): a screenshot of a
 * simulation must be impossible to mistake for a real decision. `wouldApply` carries the typed
 * actions, unapplied.
 */
export interface SimulationResult extends EvaluationResult {
  readonly mode: 'SIMULATION';
  readonly banner: 'SIMULATION — NO DATA CHANGED';
  readonly wouldApply: readonly RuleAction[];
}

/** The frozen simulation banner literal (§14.5). */
export const RULE_SIMULATION_BANNER = 'SIMULATION — NO DATA CHANGED' as const;

/** The frozen simulation mode literal (§14). */
export const RULE_SIMULATION_MODE = 'SIMULATION' as const;
