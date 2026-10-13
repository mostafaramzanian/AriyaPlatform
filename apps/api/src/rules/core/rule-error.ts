import {
  RuleConflictReport,
  RuleOrderingBasis,
  RuleValidationIssue,
  RuleValidationIssueCode,
  RuleValidationResult,
} from '../rule-validation.interface';
import { RuleConflictDimension } from '../rule.types';
import { RULE_LIMITS } from './rule-limits';

/**
 * The typed failure layer of the pure core (§6.4, §13.4).
 *
 * Every *data* problem — an invalid definition, an undecidable rule, a bound that was exceeded, a
 * conflicted decision — is signalled as a **value** through the contracts of
 * `rule-validation.interface.ts` and `rule-evaluation.interface.ts`. The engine throws nothing for
 * a data problem: the domain path receives a typed outcome and turns it into a readable 409/422
 * (§6.4). An unknown or unpublished set is likewise a typed outcome for the domain path, while the
 * legacy synchronous API keeps its historic `NotFoundException` contract.
 *
 * The class below therefore exists for exactly one purpose: a state that **cannot be reached** —
 * an exhaustiveness hole, a null that the types say is impossible, a bound that a validated tree
 * cannot exceed. A programming mistake is then loud in tests instead of quietly mis-deciding a
 * request.
 */
export class RuleEngineInvariantError extends Error {
  readonly code = 'RULE_ENGINE_INVARIANT_VIOLATION' as const;

  constructor(detail: string) {
    super(`Rule engine invariant violated: ${detail}`);
    this.name = 'RuleEngineInvariantError';
  }
}

/** Refuses an impossible state (§see the file doc). */
export function invariant(condition: unknown, detail: string): asserts condition {
  if (!condition) {
    throw new RuleEngineInvariantError(detail);
  }
}

/** Exhaustiveness helper: reaching it means a frozen vocabulary gained a member unhandled here. */
export function assertNever(value: never, detail: string): never {
  throw new RuleEngineInvariantError(`${detail}: ${String(value)}`);
}

/**
 * A deterministic, bounded description of a failure for a match-history `error` entry (§13, §6.4).
 *
 * @remarks Only the error's name and message are reported: a stack trace is engine internals and
 * must never reach a response (§13.3). The text is truncated to the operand bound so a hostile or
 * accidental megabyte-long message cannot inflate a response (§34).
 */
export function describeFailure(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : `NonError: ${String(error)}`;

  return raw.length > RULE_LIMITS.maxStringOperandLength
    ? `${raw.slice(0, RULE_LIMITS.maxStringOperandLength)}…`
    : raw;
}

/** Builds one validation issue (§7). */
export function validationIssue(
  code: RuleValidationIssueCode,
  path: string,
  message: string
): RuleValidationIssue {
  return { code, path, message };
}

/** Builds one conflict report (§12.3). */
export function conflictReport(
  dimension: RuleConflictDimension,
  ruleIds: readonly string[],
  ordering: readonly RuleOrderingBasis[],
  detail: string
): RuleConflictReport {
  return { dimension, ruleIds, ordering, detail };
}

/**
 * Assembles a validation result, ordering issues and conflicts deterministically so the same
 * definition always produces the same report in the same order (§38).
 */
export function buildValidationResult(input: {
  readonly ruleSetId: string;
  readonly version: string;
  readonly issues: readonly RuleValidationIssue[];
  readonly conflicts: readonly RuleConflictReport[];
  readonly ruleCount: number;
  readonly ordering: readonly RuleOrderingBasis[];
  readonly specificities: readonly number[];
}): RuleValidationResult {
  const issues = [...input.issues].sort(compareIssues);
  const conflicts = [...input.conflicts].sort(compareConflicts);
  const specificities = input.specificities.length > 0 ? [...input.specificities] : [0];

  return {
    valid: issues.length === 0 && conflicts.length === 0,
    ruleSetId: input.ruleSetId,
    version: input.version,
    issues,
    conflicts,
    ruleCount: input.ruleCount,
    ordering: input.ordering,
    minSpecificity: Math.min(...specificities),
    maxSpecificity: Math.max(...specificities),
  };
}

/** Stable issue ordering: by path, then by code, so equal findings never swap places. */
function compareIssues(a: RuleValidationIssue, b: RuleValidationIssue): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  if (a.code !== b.code) {
    return a.code < b.code ? -1 : 1;
  }
  return 0;
}

/** Stable conflict ordering: by dimension, then by the rule ids involved. */
function compareConflicts(a: RuleConflictReport, b: RuleConflictReport): number {
  if (a.dimension !== b.dimension) {
    return a.dimension < b.dimension ? -1 : 1;
  }
  const aIds = a.ruleIds.join(',');
  const bIds = b.ruleIds.join(',');
  if (aIds !== bIds) {
    return aIds < bIds ? -1 : 1;
  }
  return 0;
}
