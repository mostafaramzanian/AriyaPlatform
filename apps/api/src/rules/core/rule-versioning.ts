import { RuleSetVersion } from '../rule-spec.interface';
import { RuleLifecycleIssue, RulePublishOutcome } from '../rule-validation.interface';
import { RuleSetStatus } from '../rule.types';
import { validateRuleSetVersion } from './rule-validator';

/**
 * The publish lifecycle of a set version (§10, §11).
 *
 * ```
 * DRAFT ──validate──▶ VALIDATED ──publish──▶ PUBLISHED ──publish(next) / archive──▶ ARCHIVED
 * ```
 *
 * Frozen rules this module enforces, and cannot be talked out of:
 *
 *  1. **Exactly one PUBLISHED version per set at a time** — publishing a new version archives the
 *     previous one *in the same act* (§10.4), and the plan carries both sides so the store applies
 *     one atomic change.
 *  2. **A published version is never mutated** (§10.2). Publishing produces a **new frozen object**;
 *     the archived version is a new frozen object too, and the version that was published stays
 *     byte-identical, so an old explanation still renders the text it was decided under (§10.6).
 *  3. **No deletion and no path back** (§11): the transition table below is the whole vocabulary,
 *     so `ARCHIVED` is terminal and there is no `DELETE`.
 *  4. **Versions are monotone per set** (§10.2): a new version must be a different label, must not
 *     collide with the version it follows, and when both labels are numeric it must be strictly
 *     greater. A non-numeric label is ordered by uniqueness only — inventing an order over
 *     arbitrary strings would be an interpretation, not a rule.
 */

/** The whole lifecycle vocabulary (§11). `ARCHIVED` is terminal; nothing is deleted. */
export const RULE_STATUS_TRANSITIONS: Readonly<Record<RuleSetStatus, readonly RuleSetStatus[]>> =
  Object.freeze({
    DRAFT: ['VALIDATED'],
    VALIDATED: ['PUBLISHED'],
    PUBLISHED: ['ARCHIVED'],
    ARCHIVED: [],
  });

/** True when the transition is one the frozen lifecycle declares (§11). */
export function canTransition(from: RuleSetStatus, to: RuleSetStatus): boolean {
  return RULE_STATUS_TRANSITIONS[from].includes(to);
}

/** Only a draft is editable; editing a published version is a new version, not a mutation (§10.2). */
export function isEditableStatus(status: RuleSetStatus): boolean {
  return status === 'DRAFT';
}

/** Only a published version is used for new business decisions (§10.3). */
export function isBusinessEvaluableStatus(status: RuleSetStatus): boolean {
  return status === 'PUBLISHED';
}

/**
 * The lifecycle issue for a status that may not be edited, or `null` when it may be.
 *
 * @remarks Editing is refused as a value, not as an exception: the caller decides how to present
 * it, and the engine never invents an exception class for a data problem (§6.4).
 */
export function editableIssue(version: RuleSetVersion): RuleLifecycleIssue | null {
  if (isEditableStatus(version.status)) {
    return null;
  }
  return {
    code: 'RULE_SET_VERSION_IMMUTABLE',
    path: 'status',
    message: `a ${version.status} version is immutable (§10.2): change it by publishing a new version`,
  };
}

/** The issue for a version that may not be evaluated for a business decision, or `null`. */
export function businessEvaluationIssue(version: RuleSetVersion | null): RuleLifecycleIssue | null {
  if (version === null) {
    return {
      code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
      path: 'status',
      message:
        'no version is published for this rule set, so no business decision may be taken (§10.3)',
    };
  }
  if (isBusinessEvaluableStatus(version.status)) {
    return null;
  }
  return {
    code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
    path: 'status',
    message: `a ${version.status} version is not the version new decisions use (§10.3)`,
  };
}

/**
 * Plans a publish: the version to store as `PUBLISHED` and the version to store as `ARCHIVED`, both
 * frozen. Nothing is written here — the plan is data, and the store applies it (§10.4, §11).
 */
export function planPublish(
  current: RuleSetVersion | null,
  candidate: RuleSetVersion
): RulePublishOutcome {
  const validation = validateRuleSetVersion(candidate);
  const issues: RuleLifecycleIssue[] = [];

  if (candidate.status !== 'VALIDATED') {
    issues.push({
      code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
      path: 'status',
      message: `a version is published from VALIDATED (§11), not from ${candidate.status}`,
    });
  }

  if (!validation.valid) {
    issues.push({
      code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
      path: 'rules',
      message: `validation refused this version: ${validation.issues.length} issue(s), ${validation.conflicts.length} conflict(s)`,
    });
  }

  if (current !== null) {
    if (current.ruleSetId !== candidate.ruleSetId) {
      issues.push({
        code: 'RULE_SET_TRANSITION_INVALID',
        path: 'ruleSetId',
        message: `a version of "${candidate.ruleSetId}" cannot supersede a version of "${current.ruleSetId}"`,
      });
    } else if (!isMonotoneVersion(current.version, candidate.version)) {
      issues.push({
        code: 'RULE_SET_VERSION_NOT_MONOTONE',
        path: 'version',
        message: `version "${candidate.version}" does not follow "${current.version}" (§10.2: numeric labels must strictly increase, and a reused label is never a new version)`,
      });
    } else if (
      candidate.supersedes !== undefined &&
      candidate.supersedes !== null &&
      candidate.supersedes !== current.version
    ) {
      issues.push({
        code: 'RULE_SET_VERSION_NOT_MONOTONE',
        path: 'supersedes',
        message: `supersedes must name the version it follows ("${current.version}"), not "${candidate.supersedes}"`,
      });
    } else if (current.status !== 'PUBLISHED') {
      issues.push({
        code: 'RULE_SET_TRANSITION_INVALID',
        path: 'status',
        message: `the superseded version is ${current.status}, and only a PUBLISHED version is superseded by a publish (§10.4)`,
      });
    }
  }

  if (issues.length > 0) {
    return { planned: false, issues, validation };
  }

  return {
    planned: true,
    validation,
    plan: {
      publish: freezeRuleSetVersion({ ...candidate, status: 'PUBLISHED' }),
      archive: current === null ? null : freezeRuleSetVersion({ ...current, status: 'ARCHIVED' }),
    },
  };
}

/**
 * Plans an archive of a published version: the frozen `ARCHIVED` replacement, or the reason it may
 * not be archived. An archived version stays readable and is never deleted (§11).
 */
export function planArchive(
  current: RuleSetVersion
): { readonly archived: RuleSetVersion } | { readonly issues: readonly RuleLifecycleIssue[] } {
  if (!canTransition(current.status, 'ARCHIVED')) {
    return {
      issues: [
        {
          code: 'RULE_SET_TRANSITION_INVALID',
          path: 'status',
          message: `${current.status} → ARCHIVED is not a transition of the frozen lifecycle (§11)`,
        },
      ],
    };
  }
  return { archived: freezeRuleSetVersion({ ...current, status: 'ARCHIVED' }) };
}

/**
 * Whether `next` may follow `current` (§10.2).
 *
 * @remarks Numeric labels are compared as integers: a policy that goes 1 → 3 is monotone, while
 * reusing 1 is never a new version. Non-numeric labels are only required to differ, because any
 * further claim about their order would be an invention.
 */
export function isMonotoneVersion(current: string, next: string): boolean {
  if (current === next) {
    return false;
  }
  const currentNumber = numericVersion(current);
  const nextNumber = numericVersion(next);
  if (currentNumber === null || nextNumber === null) {
    return true;
  }
  return nextNumber > currentNumber;
}

function numericVersion(label: string): number | null {
  return /^\d+$/.test(label) ? Number(label) : null;
}

/**
 * Freezes a set version **deeply**: the version, its catalogue, its rules, their condition trees and
 * their actions.
 *
 * @remarks §11 requires that a published version is immutable and §10.6 that the stored text is what
 * an old explanation is rendered from. Freezing makes that structural rather than conventional: a
 * writer holding a reference to a published version is refused by the runtime instead of quietly
 * changing policy history. The `isFrozen` short-circuit makes the walk safe on a self-referential
 * object.
 */
export function freezeRuleSetVersion(version: RuleSetVersion): RuleSetVersion {
  return deepFreeze(version);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
