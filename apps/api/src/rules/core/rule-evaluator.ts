import {
  EvaluationResult,
  RuleBoundsReport,
  RuleEvaluationRequest,
  RuleMatchRecord,
  RuleObservedCount,
  RuleWinningRule,
} from '../rule-evaluation.interface';
import { RuleSetVersion } from '../rule-spec.interface';
import { RULE_DECISION_NONE, RuleEvaluationStatus } from '../rule.types';
import { ruleDecisionSignature } from '../rule-action.interface';
import {
  ConditionEvaluation,
  indexFields,
  evaluateConditionTree,
} from './rule-condition-evaluator';
import { ruleOrderingBasisOf } from './rule-conflict';
import { describeOrderingBasis, orderRuleSpecs, RankedRuleSpec } from './rule-ordering';
import { RULE_LIMITS } from './rule-limits';
import { conflictReport, describeFailure, invariant } from './rule-error';
import { isIsoInstant } from './rule-facts';
import { validateRuleSetVersion } from './rule-validator';
import { RuleConflictReport, RuleValidationResult } from '../rule-validation.interface';

/**
 * The evaluator: pure, total, bounded and explainable (§6.3, §13, §34).
 *
 * What this function deliberately does **not** do:
 *
 *  - it does not read a clock (`evaluationInstant` is an argument, D12) and does not resolve a
 *    tenant (that is the caller's concern, §14.3);
 *  - it does not query anything: facts arrive assembled and bounded (§6.1, §8.4);
 *  - it does not throw for a data problem. Every outcome is a `status` and a report (§6.4);
 *  - it does not stop at the first match. Every rule of the version is evaluated and recorded, in
 *    the declared ordering, which is the completeness §13.1 requires and the previous first-match
 *    engine could not provide (§6.0).
 *
 * What it does guarantee: identical `(version, context)` inputs produce an identical result,
 * including the ordering of the match history (D11, §38).
 */

/** A rule together with the record of its evaluation, in declared order (§12.1). */
interface EvaluatedRule {
  readonly ranked: RankedRuleSpec;
  readonly record: RuleMatchRecord;
  readonly evaluation: ConditionEvaluation | null;
}

/**
 * The outcome of a completed pass: decide, refuse, or report that nothing matched (§6.4, §12.3).
 *
 * @remarks `evaluated` is in the declared ordering, so the first matching entry is the winner
 * (§12.1), and one entry's index orders it against another without re-sorting.
 */
function assembleResult(params: {
  readonly version: RuleSetVersion;
  readonly validation: RuleValidationResult;
  readonly evaluationInstant: string;
  readonly evaluated: readonly EvaluatedRule[];
  readonly observedCounts: ReadonlyMap<string, number>;
  readonly boundBreach: RuleBoundsReport | null;
}): EvaluationResult {
  const history = params.evaluated.map((entry) => entry.record);
  const counts = sortObservedCounts(params.observedCounts);

  if (params.boundBreach !== null) {
    return refusalResult({
      version: params.version,
      validation: params.validation,
      status: 'REFUSED_BOUNDS_EXCEEDED',
      evaluationInstant: params.evaluationInstant,
      missingFields: [],
      conflicts: [],
      observedCounts: counts,
      matchHistory: history,
      bounds: params.boundBreach,
      explanationText: `status=REFUSED_BOUNDS_EXCEEDED ruleSet=${params.version.ruleSetId}@${params.version.version} instant=${params.evaluationInstant} limit=${params.boundBreach.limit} observed=${params.boundBreach.observed} maximum=${params.boundBreach.maximum} considered=${history.length}`,
    });
  }

  const matching = params.evaluated.filter((entry) => entry.record.matched);
  const conflict = adjacentAuthorityConflict(matching);

  if (conflict !== null) {
    return refusalResult({
      version: params.version,
      validation: params.validation,
      status: 'CONFLICT',
      evaluationInstant: params.evaluationInstant,
      missingFields: [],
      conflicts: [...params.validation.conflicts, conflict],
      observedCounts: counts,
      matchHistory: history,
      explanationText: `status=CONFLICT ruleSet=${params.version.ruleSetId}@${params.version.version} instant=${params.evaluationInstant} rules=${conflict.ruleIds.join(',')} considered=${history.length}`,
    });
  }

  const winner = matching.length > 0 ? matching[0] : null;
  const winnerIndex = winner === null ? -1 : params.evaluated.indexOf(winner);
  const unresolvedIndex = params.evaluated.findIndex(
    (entry) => entry.record.conditionOutcome === 'UNKNOWN' && entry.record.error === undefined
  );

  /**
   * An undecidable rule that outranks the winner could have displaced it, and one that outranks
   * everything leaves nothing to decide: evaluation is refused as insufficient context rather than
   * resolved by assuming a value (§16.6). A rule ranked below a decided winner cannot change that
   * decision, so it is reported in the history without blocking it.
   */
  const blockedByUnresolved =
    unresolvedIndex >= 0 && (winnerIndex === -1 || unresolvedIndex < winnerIndex);

  if (blockedByUnresolved) {
    const considered =
      winnerIndex === -1
        ? params.evaluated.filter((entry) => entry.record.conditionOutcome === 'UNKNOWN')
        : params.evaluated
            .slice(0, winnerIndex)
            .filter((entry) => entry.record.conditionOutcome === 'UNKNOWN');
    const missingFields = sortedUnique(
      considered.flatMap((entry) => [...entry.record.missingFields])
    );

    return refusalResult({
      version: params.version,
      validation: params.validation,
      status: 'REFUSED_INSUFFICIENT_CONTEXT',
      evaluationInstant: params.evaluationInstant,
      missingFields,
      conflicts: [],
      observedCounts: counts,
      matchHistory: history,
      explanationText: `status=REFUSED_INSUFFICIENT_CONTEXT ruleSet=${params.version.ruleSetId}@${params.version.version} instant=${params.evaluationInstant} missing=${missingFields.join(',')} considered=${history.length} matched=${matching.length}`,
    });
  }

  if (winner === null) {
    return refusalResult({
      version: params.version,
      validation: params.validation,
      status: 'NO_MATCH',
      evaluationInstant: params.evaluationInstant,
      missingFields: [],
      conflicts: [],
      observedCounts: counts,
      matchHistory: history,
      explanationText: `status=NO_MATCH ruleSet=${params.version.ruleSetId}@${params.version.version} instant=${params.evaluationInstant} considered=${history.length}`,
    });
  }

  const rule = winner.ranked.rule;
  const basis = ruleOrderingBasisOf(rule);
  const primaryAction = rule.actions.length > 0 ? rule.actions[0] : null;

  /** The validation gate refuses a rule without an action, so this state cannot be reached; if it
   *  ever were, the engine says so instead of inventing a `NONE` decision for a matching rule. */
  invariant(primaryAction !== null, `rule "${rule.id}" matched without an action`);

  const winningRule: RuleWinningRule = {
    ...basis,
    ruleName: rule.name,
    ruleVersion: rule.version,
    action: primaryAction,
  };

  /**
   * The win explains itself: the ordering basis, how many rules were considered, how many matched
   * — all as codes, ids, numbers and dates, never as prose (§13.4).
   */
  const explanationText = `status=DECIDED ruleSet=${params.version.ruleSetId}@${params.version.version} instant=${params.evaluationInstant} decision=${primaryAction.type} winner={${describeOrderingBasis(basis)}} considered=${history.length} matched=${matching.length}`;

  return {
    ruleSetId: params.version.ruleSetId,
    ruleSetVersion: params.version.version,
    evaluationInstant: params.evaluationInstant,
    status: 'DECIDED',
    decision: primaryAction,
    winningRule,
    decisionActions: rule.actions,
    matchHistory: history,
    orderingBasis: basis,
    observedCounts: counts,
    missingFields: sortedUnique(history.flatMap((record) => [...record.missingFields])),
    explanationText,
    conflicts: params.validation.conflicts,
    validation: params.validation,
  };
}

/** Observed counts reported in one deterministic order (§38). */
function sortObservedCounts(counts: ReadonlyMap<string, number>): RuleObservedCount[] {
  return [...counts.entries()]
    .map(([over, count]) => ({ over, count }))
    .sort((a, b) => (a.over < b.over ? -1 : a.over > b.over ? 1 : 0));
}

/**
 * Evaluates one set version over one context.
 *
 * @remarks The version is validated first, every time: a definition that has not passed the gate
 * is refused rather than executed (§14.2), and the refusal carries the same report publish would
 * have produced. The gate is affordable — validation visits each node once, and the frozen budgets
 * are sized so that an admissible version always fits (§34).
 */
export function evaluateRuleSetVersion(input: RuleEvaluationRequest): EvaluationResult {
  const version = input.ruleSetVersion;
  const context = input.context;
  const validation = validateRuleSetVersion(version);

  if (!isIsoInstant(context.evaluationInstant)) {
    return refusalResult({
      version,
      validation,
      status: 'REFUSED_INSUFFICIENT_CONTEXT',
      evaluationInstant: '',
      missingFields: ['evaluationInstant'],
      conflicts: [],
      observedCounts: [],
      explanationText: `status=REFUSED_INSUFFICIENT_CONTEXT ruleSet=${version.ruleSetId}@${version.version} reason=missing:evaluationInstant`,
    });
  }

  if (!isFactBag(context.facts)) {
    return refusalResult({
      version,
      validation,
      status: 'REFUSED_INSUFFICIENT_CONTEXT',
      evaluationInstant: context.evaluationInstant,
      missingFields: ['facts'],
      conflicts: [],
      observedCounts: [],
      explanationText: `status=REFUSED_INSUFFICIENT_CONTEXT ruleSet=${version.ruleSetId}@${version.version} instant=${context.evaluationInstant} reason=missing:facts`,
    });
  }

  if (!validation.valid) {
    return refusalResult({
      version,
      validation,
      status: 'REFUSED_INVALID_VERSION',
      evaluationInstant: context.evaluationInstant,
      missingFields: [],
      conflicts: validation.conflicts,
      observedCounts: [],
      explanationText: `status=REFUSED_INVALID_VERSION ruleSet=${version.ruleSetId}@${version.version} instant=${context.evaluationInstant} issues=${validation.issues.length} conflicts=${validation.conflicts.length}`,
    });
  }

  const ranked = orderRuleSpecs(version.rules);
  const fields = indexFields(version.fields);
  const observedCounts = new Map<string, number>();
  const evaluated: EvaluatedRule[] = [];

  let remainingWork = RULE_LIMITS.maxEvaluationSteps;
  let boundBreach: RuleBoundsReport | null = null;

  for (const entry of ranked) {
    if (remainingWork <= 0) {
      boundBreach = {
        limit: 'maxEvaluationSteps',
        observed: RULE_LIMITS.maxEvaluationSteps,
        maximum: RULE_LIMITS.maxEvaluationSteps,
      };
      break;
    }

    let evaluation: ConditionEvaluation | null = null;
    let record: RuleMatchRecord;

    try {
      evaluation = evaluateConditionTree(entry.rule.condition, {
        facts: context.facts,
        fields,
        maxWorkUnits: remainingWork,
      });
      remainingWork -= evaluation.steps;

      if (evaluation.breach !== null) {
        boundBreach = {
          limit: evaluation.breach.limit,
          observed: evaluation.breach.observed,
          maximum: evaluation.breach.maximum,
        };
        break;
      }

      for (const observation of evaluation.observedCounts) {
        observedCounts.set(observation.over, observation.count);
      }

      record = matchRecord(entry, evaluation);
    } catch (error) {
      record = failedRecord(entry, describeFailure(error));
    }

    evaluated.push({ ranked: entry, record, evaluation });
  }

  return assembleResult({
    version,
    validation,
    evaluationInstant: context.evaluationInstant,
    evaluated,
    observedCounts,
    boundBreach,
  });
}

/** One rule's frozen match record (§13). */
function matchRecord(entry: RankedRuleSpec, evaluation: ConditionEvaluation): RuleMatchRecord {
  const rule = entry.rule;
  const matched = evaluation.outcome === 'TRUE';
  const primary = rule.actions.length > 0 ? rule.actions[0].type : undefined;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersion: rule.version,
    priority: rule.priority,
    specificity: entry.specificity,
    matched,
    conditionOutcome: evaluation.outcome,
    failedLeaves: evaluation.failedLeaves,
    matchedLeaves: evaluation.matchedLeaves,
    missingFields: evaluation.missingFields,
    ...(matched && primary !== undefined ? { decision: primary } : {}),
  };
}

/**
 * A rule that failed during evaluation: skipped and recorded, never fatal (§6.4).
 *
 * @remarks A validated definition cannot reach this branch — conditions are interpreted data, and
 * the interpreter has no failing operation. The branch exists because §6.4 requires that one bad
 * rule can never turn a whole evaluation into a 500, whichever layer produced the bad rule.
 */
function failedRecord(entry: RankedRuleSpec, message: string): RuleMatchRecord {
  const rule = entry.rule;
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersion: rule.version,
    priority: rule.priority,
    specificity: entry.specificity,
    matched: false,
    conditionOutcome: 'UNKNOWN',
    failedLeaves: [],
    matchedLeaves: [],
    missingFields: [],
    error: { message },
  };
}

/** The supplied facts must be a plain record of values, not an array or a scalar. */
function isFactBag(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Everything a refusal needs, so the shape of a refusal cannot drift (§6.4). */
interface RefusalParams {
  readonly version: RuleSetVersion;
  readonly validation: RuleValidationResult;
  readonly status: RuleEvaluationStatus;
  readonly evaluationInstant: string;
  readonly missingFields: readonly string[];
  readonly conflicts: readonly RuleConflictReport[];
  readonly observedCounts: readonly RuleObservedCount[];
  readonly explanationText: string;
  readonly matchHistory?: readonly RuleMatchRecord[];
  readonly bounds?: RuleBoundsReport;
}

/** A refusal: a typed outcome with no decision, and never a thrown exception (§6.4). */
function refusalResult(params: RefusalParams): EvaluationResult {
  return {
    ruleSetId: params.version.ruleSetId,
    ruleSetVersion: params.version.version,
    evaluationInstant: params.evaluationInstant,
    status: params.status,
    decision: RULE_DECISION_NONE,
    winningRule: null,
    decisionActions: [],
    matchHistory: params.matchHistory ?? [],
    orderingBasis: null,
    observedCounts: params.observedCounts,
    missingFields: [...params.missingFields],
    explanationText: params.explanationText,
    conflicts: params.conflicts,
    validation: params.validation,
    ...(params.bounds === undefined ? {} : { bounds: params.bounds }),
  };
}

/** Sorted, deduplicated strings: one deterministic order for every report (§38). */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Equal-authority incompatible matches, detected in the evaluated order (§12.3).
 *
 * @remarks Equal `(priority, specificity)` rules are contiguous in the frozen ordering, so
 * comparing neighbours is complete and bounded — a legitimate version cannot reach this point
 * (validation refuses such a pair at publish), and if one ever does, no winner is chosen.
 */
function adjacentAuthorityConflict(matching: readonly EvaluatedRule[]): RuleConflictReport | null {
  for (let index = 1; index < matching.length; index += 1) {
    const previous = matching[index - 1];
    const current = matching[index];
    if (
      previous.record.priority !== current.record.priority ||
      previous.record.specificity !== current.record.specificity
    ) {
      continue;
    }
    const previousSignature = ruleDecisionSignature(previous.ranked.rule.actions);
    const currentSignature = ruleDecisionSignature(current.ranked.rule.actions);
    if (previousSignature === currentSignature) {
      continue;
    }
    return conflictReport(
      'AMBIGUOUS_PRECEDENCE',
      [previous.record.ruleId, current.record.ruleId],
      [ruleOrderingBasisOf(previous.ranked.rule), ruleOrderingBasisOf(current.ranked.rule)],
      `equal authority at evaluation (priority ${previous.record.priority}, specificity ${previous.record.specificity}) with different decisions (${previousSignature} vs ${currentSignature}); no winner is chosen`
    );
  }
  return null;
}
