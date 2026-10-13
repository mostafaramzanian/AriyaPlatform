export interface RuleContext {
  facts: Record<string, unknown>;
  tenantId?: string | null;
  correlationId?: string;
  userId?: string;
}

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  priority: number;
  decision: string;
  metadata?: Record<string, unknown>;
  version?: string;
}

/**
 * Root vocabulary of the Platform Rule Engine (Phase 54).
 *
 * The legacy synchronous contract above (`RuleContext` / `RuleResult`) is preserved verbatim for
 * its existing consumers and specs (§6.3, §6.4). Everything below is additive and belongs to the
 * typed, pure core introduced by Phase 54-B: declarative rule versions, typed facts, typed
 * decisions. No naming here may collide with an existing symbol.
 */

/**
 * Version lifecycle of a rule set (§10.3, §11).
 * `DRAFT` is editable but not evaluable by business paths; `PUBLISHED` is immutable; `ARCHIVED` is
 * not selected for new evaluations but stays readable for historical explanations.
 */
export type RuleSetStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/**
 * Declared type of a catalogue fact (§8.3).
 * `collection` exists only to host the §8.4 `count` aggregate; it is not a general array type.
 */
export type RuleFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'collection';

/** Every field type except `collection` (i.e. a type that can appear in a comparison). */
export type RuleScalarFieldType = Exclude<RuleFieldType, 'collection'>;

/** A calendar day, `YYYY-MM-DD`. The engine performs no calendar arithmetic (§16.2). */
export type RuleCalendarDay = string;

/** An explicit instant, ISO-8601. The engine never reads a clock (§6.3, D12). */
export type RuleInstant = string;

/** A scalar fact value as supplied by the consuming application layer. */
export type RuleFactScalar = string | number | boolean;

/**
 * A fact value: a scalar, `null` (explicitly absent), or a bounded collection of records
 * (only for a field declared `collection`; never nested).
 */
export type RuleFactValue = RuleFactScalar | null | readonly RuleFactRecord[];

export interface RuleFactRecord {
  readonly [field: string]: RuleFactValue;
}

/** The frozen action vocabulary (§9). The engine produces these; the application applies them. */
export type RuleActionType =
  | 'REQUIRED_APPROVAL_STEP'
  | 'AUTO_APPROVE'
  | 'AUTO_REJECT'
  | 'LIMIT_REFUSAL'
  | 'STEP_ACTIVATION'
  | 'APPROVER_RESOLUTION'
  | 'NOTIFY';

/** Counting basis of a leave limit (§16). Mandatory wherever a count is meaningful — a bare
 *  number is never interpreted without its basis (D7). */
export type RuleCountingBasis = 'REQUEST_COUNT' | 'DAY_COUNT';

/** Why a named approver was resolved the way it was (§17.3). */
export type RuleApproverResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'UNAVAILABLE';

/** Detail levels of an explanation (§13.3). The renderer chooses; the engine never decides. */
export type RuleEvidenceLevel = 'EMPLOYEE' | 'MANAGER' | 'HR_ADMIN' | 'PLATFORM_ADMIN';

/** The literal used by `EvaluationResult.decision` when no rule produced a decision (§13). */
export const RULE_DECISION_NONE = 'NONE' as const;

export type RuleDecisionNone = typeof RULE_DECISION_NONE;

/**
 * Typed outcome of an evaluation (§6.4). A refusal is a value, never a thrown HTTP exception: the
 * domain path turns it into a readable 409/422.
 */
export type RuleEvaluationStatus =
  /** a rule matched and a decision was produced */
  | 'DECIDED'
  /** every rule was decided false — no rule matched */
  | 'NO_MATCH'
  /** an undecidable rule outranks every match, so no decision may be assumed (§16.6) */
  | 'REFUSED_INSUFFICIENT_CONTEXT'
  /** the supplied version failed validation and was never executed (§14.2, §6.4) */
  | 'REFUSED_INVALID_VERSION'
  /** a bounded-execution limit was exceeded; nothing was silently truncated (§34) */
  | 'REFUSED_BOUNDS_EXCEEDED'
  /** equal-authority incompatible matches were observed; no silent winner is chosen (§12.3) */
  | 'CONFLICT';

/**
 * Three-valued outcome of one condition node (§8).
 *
 * `UNKNOWN` exists because the engine refuses to resolve a missing fact as `false` (§8.3: a
 * missing fact is never silently satisfying, and it is also never silently disqualifying): a rule
 * whose condition cannot be decided does not match, and the evaluation records *why* it could not
 * be decided instead of inventing an answer.
 */
export type RuleConditionOutcome = 'TRUE' | 'FALSE' | 'UNKNOWN';

/** The conflicting dimension of a conflict report (§12.3). */
export type RuleConflictDimension =
  'DUPLICATE_RULE_ID' | 'AMBIGUOUS_PRECEDENCE' | 'TERMINAL_OUTCOME' | 'TYPE_CONTRADICTION';
