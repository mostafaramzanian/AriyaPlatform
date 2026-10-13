import { RuleAction } from '../rule-action.interface';
import { EvaluationResult, RuleMatchRecord, RuleObservedCount } from '../rule-evaluation.interface';
import { RuleOrderingBasis, RuleConflictReport } from '../rule-validation.interface';
import { RuleEvidenceLevel, RuleEvaluationStatus } from '../rule.types';

/**
 * The explanation model (§13): a decision **and why**, in a shape that can be rendered without
 * re-evaluating and without exposing rule internals.
 *
 * Two frozen rules shape everything here:
 *
 *  1. **Derived, never recomputed** (§13.2). Every field below is read from an `EvaluationResult`
 *     that was already produced — including the rule and set versions it names — so rendering a
 *     decision taken last year does not consult today's configuration.
 *  2. **Levels, not filters at the edge** (§13.3). `buildRuleExplanation` takes the level and
 *     returns only what that level may see, so an employee-facing response cannot leak a rule id, a
 *     priority or another rule's failures by accident. The engine emits codes, ids, numbers and
 *     dates — never Persian prose (§13.4) — so a UI renders text from its own catalogue.
 */

/** What one evidence level may see (§13.3). */
export const RULE_EVIDENCE_LEVEL_FIELDS: Readonly<
  Record<
    RuleEvidenceLevel,
    {
      readonly orderingBasis: boolean;
      readonly matchHistory: 'FULL' | 'MATCHED_ONLY' | 'NONE';
      readonly grounds: boolean;
      readonly failedLeaves: boolean;
      readonly ruleIdentity: boolean;
      readonly versionIdentity: boolean;
    }
  >
> = Object.freeze({
  PLATFORM_ADMIN: {
    orderingBasis: true,
    matchHistory: 'FULL',
    grounds: true,
    failedLeaves: true,
    ruleIdentity: true,
    versionIdentity: true,
  },
  HR_ADMIN: {
    orderingBasis: false,
    matchHistory: 'MATCHED_ONLY',
    grounds: true,
    failedLeaves: false,
    ruleIdentity: true,
    versionIdentity: true,
  },
  MANAGER: {
    orderingBasis: false,
    matchHistory: 'NONE',
    grounds: false,
    failedLeaves: false,
    ruleIdentity: true,
    versionIdentity: false,
  },
  EMPLOYEE: {
    orderingBasis: false,
    matchHistory: 'NONE',
    grounds: false,
    failedLeaves: false,
    ruleIdentity: false,
    versionIdentity: false,
  },
});

/** The fields one evidence level may see — the projection a level is built from (§13.3). */
export type RuleEvidenceLevelFields = (typeof RULE_EVIDENCE_LEVEL_FIELDS)[RuleEvidenceLevel];

/** One rule's presence in an explanation, already narrowed to the requested level. */
export interface RuleExplanationMatch {
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly matched: boolean;
  readonly conditionOutcome: RuleMatchRecord['conditionOutcome'];
  readonly decision: RuleMatchRecord['decision'] | null;
  readonly grounds: readonly string[];
  readonly failedLeaves: readonly string[];
  readonly missingFields: readonly string[];
  readonly error: string | null;
}

/**
 * Builds the explanation for one already-taken decision, at one level of detail.
 *
 * @remarks Nothing here can fail: the result is data and an explanation is a projection of it. A
 * refusal is explained exactly like a decision — including *which* facts were missing (§16.6) — so
 * "we could not decide" is never a dead end for the person it affects.
 */
export function buildRuleExplanation(
  result: EvaluationResult,
  level: RuleEvidenceLevel
): RuleExplanation {
  const allowed = RULE_EVIDENCE_LEVEL_FIELDS[level];
  const winner = result.winningRule;
  const winnerRecord =
    winner === null
      ? null
      : (result.matchHistory.find((record) => record.ruleId === winner.ruleId) ?? null);

  const history =
    allowed.matchHistory === 'NONE'
      ? []
      : result.matchHistory
          .filter((record) => allowed.matchHistory === 'FULL' || record.matched)
          .map((record) => explanationMatch(record, allowed));

  /**
   * The codes for this level, and — for the levels that may not see the ordering basis — the
   * technical summary of §13 is withheld with it: `explanationText` names the winning rule's
   * priority and specificity, so it is advanced detail by the same argument as `orderingBasis`
   * (§13.3, §27.2). What a lower level receives instead is the code rendering, which is the same
   * evidence in the vocabulary that level is entitled to.
   */
  const reasonCodes = explanationReasonCodes(result, allowed);

  return {
    ruleSetId: result.ruleSetId,
    ruleSetVersion: result.ruleSetVersion,
    evaluationInstant: result.evaluationInstant,
    detailLevel: level,
    status: result.status,
    decisionType: winner === null ? null : winner.action.type,
    decisionActions: result.decisionActions,
    winningRuleId: winner === null || !allowed.ruleIdentity ? null : winner.ruleId,
    winningRuleVersion: winner === null || !allowed.versionIdentity ? null : winner.ruleVersion,
    orderingBasis: allowed.orderingBasis ? result.orderingBasis : null,
    matchHistory: history,
    grounds: allowed.grounds && winnerRecord !== null ? winnerRecord.matchedLeaves : [],
    failedLeaves: allowed.failedLeaves
      ? result.matchHistory.flatMap((record) => [...record.failedLeaves])
      : [],
    missingFields: result.missingFields,
    observedCounts: result.observedCounts,
    reasonCodes,
    conflicts: allowed.ruleIdentity ? result.conflicts : [],
    explanationText: allowed.orderingBasis ? result.explanationText : reasonCodes.join(' '),
  };
}

function explanationMatch(
  record: RuleMatchRecord,
  allowed: RuleEvidenceLevelFields
): RuleExplanationMatch {
  return {
    ruleId: allowed.ruleIdentity ? record.ruleId : null,
    ruleName: allowed.ruleIdentity ? record.ruleName : null,
    matched: record.matched,
    conditionOutcome: record.conditionOutcome,
    decision: record.decision ?? null,
    grounds: allowed.grounds ? record.matchedLeaves : [],
    failedLeaves: allowed.failedLeaves ? record.failedLeaves : [],
    missingFields: record.missingFields,
    error: record.error?.message ?? null,
  };
}

/**
 * The typed codes an explanation is rendered from (§13.4), **narrowed to one evidence level**.
 *
 * @remarks Codes, not sentences: `STATUS_DECIDED`, `ACTION_LIMIT_REFUSAL`, `LIMIT_BASIS_DAY_COUNT`,
 * `CONTEXT_MISSING_employmentType`. A UI resolves them through its own catalogue, so one decision
 * reads correctly in every locale and the engine never emits prose — Persian or otherwise.
 *
 * The level narrows the codes as it narrows the fields. `ORDERING_*` codes name the internal ranking
 * that produced the decision, so they are emitted exactly for the levels that may see the ordering
 * basis (§13.3): an employee's payload carries the outcome and the grounds of the refusal, never
 * which rule outranked which (§27.2 — the lower layer's payload does not *contain* the advanced
 * detail, rather than having it filtered out on a client).
 */
export function explanationReasonCodes(
  result: EvaluationResult,
  allowed: RuleEvidenceLevelFields
): string[] {
  const codes: string[] = [`STATUS_${result.status}`];
  const winner = result.winningRule;

  if (winner !== null && allowed.orderingBasis) {
    codes.push(`ORDERING_PRIORITY_${winner.priority}`);
    codes.push(`ORDERING_SPECIFICITY_${winner.specificity}`);
  }

  for (const action of result.decisionActions) {
    codes.push(`ACTION_${action.type}`);
    if (action.type === 'LIMIT_REFUSAL') {
      codes.push(`LIMIT_BASIS_${action.countingBasis}`);
      codes.push(`LIMIT_MAXIMUM_${action.maximum}`);
      codes.push(`LIMIT_WINDOW_${action.windowStart}_${action.windowEnd}`);
    }
    if (action.type === 'AUTO_REJECT') {
      codes.push(`REJECTION_REASON_${action.reasonCode}`);
    }
  }

  for (const field of result.missingFields) {
    codes.push(`CONTEXT_MISSING_${field}`);
  }
  if (result.bounds !== undefined) {
    codes.push(`BOUNDS_${result.bounds.limit}`);
  }

  return [...new Set(codes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** An explanation: typed codes and values, at exactly one level of detail. */
export interface RuleExplanation {
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly evaluationInstant: string;
  readonly detailLevel: RuleEvidenceLevel;
  readonly status: RuleEvaluationStatus;
  readonly decisionType: RuleAction['type'] | null;
  /** The actions that were decided, in declared order, unapplied (§9, §14). */
  readonly decisionActions: readonly RuleAction[];
  readonly winningRuleId: string | null;
  readonly winningRuleVersion: string | null;
  readonly orderingBasis: RuleOrderingBasis | null;
  readonly matchHistory: readonly RuleExplanationMatch[];
  readonly grounds: readonly string[];
  readonly failedLeaves: readonly string[];
  readonly missingFields: readonly string[];
  readonly observedCounts: readonly RuleObservedCount[];
  /** The codes this level renders from (§13.4). Ordering codes appear only where the ordering basis
   *  is visible (§13.3). */
  readonly reasonCodes: readonly string[];
  /** Conflicts observed by the evaluation — withheld from levels that may not see rule identity, so a
   *  report naming rule ids and their ordering never reaches a lower layer (§27.2). */
  readonly conflicts: readonly RuleConflictReport[];
  /**
   * The evaluation's technical summary at the levels that may see the ordering basis, and the code
   * rendering below them (§13.4, §27.2). Either way it is codes, ids, numbers and dates — never
   * prose, and never JSON.
   */
  readonly explanationText: string;
}
