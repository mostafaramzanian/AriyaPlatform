import { RuleConflictDimension, RuleSetStatus } from './rule.types';
import { RuleSetVersion } from './rule-spec.interface';

/**
 * Validation, conflict and lifecycle contracts (§7, §11, §12.3).
 *
 * All of these are **values**. A refusal is never signalled by an HTTP exception from the pure
 * engine (§6.4): the domain path receives a typed outcome and turns it into a readable 409/422.
 */

/**
 * Every reason the validator can refuse a set version. Codes are stable and are the contract; the
 * `message` is a developer-facing fallback, not a sentence for an end user (§13.4).
 */
export type RuleValidationIssueCode =
  // structure of the version itself
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'RULE_SET_ID_INVALID'
  | 'RULE_SET_VERSION_INVALID'
  | 'RULE_SET_VERSION_SUPERSEDES_INVALID'
  | 'EFFECTIVE_RANGE_INVALID'
  | 'RULE_COUNT_EXCEEDED'
  // the field catalogue
  | 'CATALOGUE_FIELD_COUNT_EXCEEDED'
  | 'CATALOGUE_FIELD_INVALID'
  | 'RESERVED_FIELD_NAME'
  | 'DUPLICATE_FIELD_NAME'
  | 'ENUM_DECLARATION_INVALID'
  | 'COLLECTION_DECLARATION_INVALID'
  // rules
  | 'RULE_ID_INVALID'
  | 'RULE_VERSION_INVALID'
  | 'RULE_NAME_INVALID'
  | 'PRIORITY_INVALID'
  | 'MISSING_CONDITION'
  | 'MISSING_ACTION'
  | 'ACTION_COUNT_EXCEEDED'
  | 'ACTION_TYPE_UNKNOWN'
  | 'ACTION_PARAMETER_INVALID'
  | 'UNKNOWN_ACTION_PARAMETER'
  // condition tree
  | 'CONDITION_NODE_INVALID'
  | 'UNKNOWN_CONDITION_KEY'
  | 'EMPTY_GROUP'
  | 'NOT_ARITY_INVALID'
  | 'CONDITION_COUNT_EXCEEDED'
  | 'CONDITION_DEPTH_EXCEEDED'
  | 'COUNT_NODE_COUNT_EXCEEDED'
  | 'COUNT_WHERE_COUNT_EXCEEDED'
  // operands and typing
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_OPERATOR'
  | 'TYPE_MISMATCH'
  | 'OPERAND_REQUIRED'
  | 'OPERAND_FORBIDDEN'
  | 'OPERAND_INVALID'
  | 'INVALID_DATE'
  | 'INVALID_DATE_RANGE'
  | 'ENUM_VALUE_UNKNOWN'
  | 'UNSAFE_OPERAND'
  | 'COUNT_OPERATOR_INVALID'
  | 'COUNT_VALUE_INVALID'
  | 'COUNT_TARGET_INVALID';

/** One validation finding, always located by a deterministic path (§7). */
export interface RuleValidationIssue {
  readonly code: RuleValidationIssueCode;
  /** Deterministic location, e.g. `rules[2].condition.all[1].field:leaveTypeRef`. */
  readonly path: string;
  readonly message: string;
}

/** The three ordering keys that produced a winner, or that explain an ordering (§12.1, §13). */
export interface RuleOrderingBasis {
  readonly ruleId: string;
  readonly priority: number;
  readonly specificity: number;
}

/**
 * A conflict that must fail validation/publish (§12.3), reported so a UI can show it and the API
 * can refuse the publish with a readable message — never a silent winner (D11).
 */
export interface RuleConflictReport {
  readonly dimension: RuleConflictDimension;
  readonly ruleIds: readonly string[];
  /** The computed ordering of the rules involved, so the report is self-explanatory. */
  readonly ordering: readonly RuleOrderingBasis[];
  readonly detail: string;
}

/** The result of validating one set version. */
export interface RuleValidationResult {
  readonly valid: boolean;
  readonly ruleSetId: string;
  readonly version: string;
  readonly issues: readonly RuleValidationIssue[];
  readonly conflicts: readonly RuleConflictReport[];
  readonly ruleCount: number;
  /** The computed ordering (highest first) — the frozen diagnostics of §12.3. */
  readonly ordering: readonly RuleOrderingBasis[];
  readonly minSpecificity: number;
  readonly maxSpecificity: number;
}

/** Reasons a lifecycle operation can be refused (§10, §11). */
export type RuleLifecycleIssueCode =
  | 'RULE_SET_VERSION_IMMUTABLE'
  | 'RULE_SET_VERSION_NOT_PUBLISHABLE'
  | 'RULE_SET_VERSION_NOT_MONOTONE'
  | 'RULE_SET_TRANSITION_INVALID';

export interface RuleLifecycleIssue {
  readonly code: RuleLifecycleIssueCode;
  readonly path: string;
  readonly message: string;
}

/**
 * The planned effect of publishing a validated version: the version to store as `PUBLISHED`, and
 * the previously published version to store as `ARCHIVED` **in the same act** (§10.4). Both are
 * frozen, so the plan cannot be applied by mutating either side (D10).
 */
export interface RulePublishPlan {
  readonly publish: RuleSetVersion;
  readonly archive: RuleSetVersion | null;
}

/** A publish is either planned or refused with reasons; it is never a silent partial success. */
export type RulePublishOutcome =
  | {
      readonly planned: true;
      readonly plan: RulePublishPlan;
      readonly validation: RuleValidationResult;
    }
  | {
      readonly planned: false;
      readonly issues: readonly RuleLifecycleIssue[];
      readonly validation: RuleValidationResult;
    };

/** The status of a set version, for diagnostics that must not import the engine internals. */
export interface RuleVersionStatusReport {
  readonly ruleSetId: string;
  readonly version: string;
  readonly status: RuleSetStatus;
}
