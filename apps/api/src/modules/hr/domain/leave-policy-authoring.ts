/**
 * Phase 54-F (§11, §12.3, §15, §16): the vocabulary a POLICY VERSION is VALIDATED against — the
 * refusal reasons publish must be able to state, and the closed sets those refusals are decided
 * from.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * §11 freezes validation as MANDATORY AND TOTAL before publish: "unknown fields, type mismatches,
 * missing versions, non-deterministic ids, unbounded collections and conflicts are refused". A
 * refusal is a VALUE in this module rather than a sentence (the convention `TransitionFailure`,
 * `CompatibilityFailure`, `LeaveLimitEnforceabilityRefusal` and `LeaveLimitEmploymentScopeRefusal`
 * already follow), because the caller needs a machine code and prose belongs at the edge.
 *
 * WHY IT IMPORTS NOTHING
 * ----------------------
 * `hr-application-boundaries.spec.ts` asserts mechanically that every non-spec file under
 * `domain/` has zero import specifiers, so this file states the vocabulary WITHOUT importing
 * `domain/leave-policy.ts` to reach its counting bases. That is not a duplication to be
 * de-duplicated: `leave-policy.ts` states the vocabulary a limit is AUTHORED in, and this file
 * states the shapes a version is REFUSED for. The two lists are compared mechanically by
 * `leave-policy-authoring.spec.ts` rather than trusted, exactly as `leave-policy.spec.ts` compares
 * `LEAVE_LIMIT_CONSUMED_STATES` against the lifecycle it derives from.
 *
 * WHY THE REFUSAL IS A UNION AND NOT A BOOLEAN OR A STRING
 * -------------------------------------------------------
 * §12.3's diagnostics requirement is explicit: "the validator returns a conflict report (rule ids,
 * the conflicting dimension, the computed ordering) so the UI can show it and the API can refuse
 * the publish with a readable message — never a silent winner (D11)". A `boolean` would lose the
 * dimension entirely; a bare `string` would let a typo become a new reason. A closed union makes
 * every refusal reason a compile-time-known member, so the API's error mapping is total by type and
 * a spec can enumerate the whole vocabulary.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT STATE
 * -----------------------------------------
 * No business rule beyond the frozen specification appears here. Where the specification names a
 * REQUIRED fact (§16: `countingBasis` mandatory, `consumesStates` required with no default, a
 * maximum `integer > 0`, the window resolved not guessed), a refusal member exists for it. Where
 * the specification is silent, no member exists — because a refusal a policy author cannot act on
 * is a rule this repository was not authorized to state (§39).
 */

/**
 * WHY a policy version cannot be published, as a machine code.
 *
 * ORDER IS NOT PRECEDENCE. The validator reports EVERY applicable refusal rather than the first
 * (see `leave-policy-validation.ts`), so a member's position here never decides which one a caller
 * sees. The order groups them by the part of the document they concern, which is how a UI renders
 * them beside the offending field.
 */
export type LeavePolicyVersionValidationRefusal =
  /** §16.1: `countingBasis` is mandatory and never implied — a limit without one fails. */
  | 'LIMIT_COUNTING_BASIS_MISSING'
  /** §16.1: the basis must be one of the two declared semantics, never a third spelling. */
  | 'LIMIT_COUNTING_BASIS_UNSUPPORTED'
  /** §16: a maximum is `integer > 0`; zero or negative is not a limit. */
  | 'LIMIT_MAXIMUM_NOT_POSITIVE'
  /** §16: `maximum` is an integer — a fractional limit has no counting semantics. */
  | 'LIMIT_MAXIMUM_NOT_INTEGER'
  /** §16.4: `consumesStates` is REQUIRED and has no default — absent or empty fails. */
  | 'LIMIT_CONSUMED_STATES_EMPTY'
  /** §16.4: a declared state must be one the vocabulary knows. */
  | 'LIMIT_CONSUMED_STATE_UNSUPPORTED'
  /** §16.4/§21.6: a declared state the current lifecycle cannot reach is not countable today. */
  | 'LIMIT_CONSUMED_STATE_NOT_IN_LIFECYCLE'
  /** §16.2: the period is a CLOSED vocabulary; an unknown period cannot resolve to a window. */
  | 'LIMIT_PERIOD_UNSUPPORTED'
  /** §16.2: the window is RESOLVED and stored — a missing resolved window is unpublishable. */
  | 'LIMIT_WINDOW_MISSING'
  /** §16.2: two resolved inclusive days, the first not after the last. */
  | 'LIMIT_WINDOW_INVERTED'
  /** §16.2: the window belongs to the version's own stated Jalali year. */
  | 'LIMIT_WINDOW_YEAR_MISMATCH'
  /** §16.6: an employment scope is a closed vocabulary or absent ("applies to every type"). */
  | 'LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED'
  /** §15.2/§24.3: a limit names a leave type of THIS tenant; an unresolved reference is refused. */
  | 'LIMIT_LEAVE_TYPE_UNRESOLVED'
  /** §15.4/§16: two limits for one leave type at one employment scope conflict — precedence for
   * "which maximum governs" is not something the specification states, so it is refused rather
   * than resolved by array order (D11's own prohibition). */
  | 'LIMIT_DUPLICATE_SCOPE'
  /** §15.4: two limits of one version with overlapping effective intervals of the same scope. */
  | 'LIMIT_EFFECTIVE_INTERVAL_OVERLAP'
  /** §15.4: effective dating follows the employment doctrine — a start day is required. */
  | 'LIMIT_EFFECTIVE_FROM_MISSING'
  /** §15.4: an interval whose end precedes its start is not an interval. */
  | 'LIMIT_EFFECTIVE_INTERVAL_INVERTED'
  /** §15.4/§16: a limit's effective interval must lie inside the version's own window. */
  | 'LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION'
  /** §15.4/D10: the version states which Jalali year it is authored for — required. */
  | 'VERSION_JALALI_YEAR_MISSING'
  /** §15.4: `effectiveFrom` is required; a version with no start is in force on no day. */
  | 'VERSION_EFFECTIVE_FROM_MISSING'
  /** §15.4: `effectiveTo` is nullable (open-ended) but never precedes `effectiveFrom`. */
  | 'VERSION_EFFECTIVE_INTERVAL_INVERTED'
  /** §10.1/§15: the version label identifies the version within its policy — required. */
  | 'VERSION_LABEL_MISSING'
  /** §15.6: the body the engine validated is STORED — an absent payload has nothing to render an
   * old explanation from (§10.6, §13.2). */
  | 'VERSION_PAYLOAD_MISSING'
  /** §15.2: the policy a version belongs to must be resolvable inside the acting tenant. */
  | 'POLICY_UNRESOLVED'
  /** §10.3/§11: only a VALIDATED version may be published; DRAFT has not passed the gate. */
  | 'VERSION_NOT_VALIDATED'
  /** §10.4: publishing a version into an interval a live PUBLISHED version already occupies would
   * leave two equally-current published versions of one policy. */
  | 'PUBLISHED_INTERVAL_OVERLAP';

/**
 * Every refusal reason, as data — so a spec can enumerate the whole vocabulary and a UI can map
 * each one, rather than discovering a new member when a payload happens to carry it.
 *
 * A `satisfies` clause rather than a second hand-written type: adding a member to the union above
 * without adding it here is a COMPILE error, which is the only way "the vocabulary is stated once"
 * stays true across the two declarations.
 */
export const LEAVE_POLICY_VERSION_VALIDATION_REFUSALS = [
  'LIMIT_COUNTING_BASIS_MISSING',
  'LIMIT_COUNTING_BASIS_UNSUPPORTED',
  'LIMIT_MAXIMUM_NOT_POSITIVE',
  'LIMIT_MAXIMUM_NOT_INTEGER',
  'LIMIT_CONSUMED_STATES_EMPTY',
  'LIMIT_CONSUMED_STATE_UNSUPPORTED',
  'LIMIT_CONSUMED_STATE_NOT_IN_LIFECYCLE',
  'LIMIT_PERIOD_UNSUPPORTED',
  'LIMIT_WINDOW_MISSING',
  'LIMIT_WINDOW_INVERTED',
  'LIMIT_WINDOW_YEAR_MISMATCH',
  'LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED',
  'LIMIT_LEAVE_TYPE_UNRESOLVED',
  'LIMIT_DUPLICATE_SCOPE',
  'LIMIT_EFFECTIVE_INTERVAL_OVERLAP',
  'LIMIT_EFFECTIVE_FROM_MISSING',
  'LIMIT_EFFECTIVE_INTERVAL_INVERTED',
  'LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION',
  'VERSION_JALALI_YEAR_MISSING',
  'VERSION_EFFECTIVE_FROM_MISSING',
  'VERSION_EFFECTIVE_INTERVAL_INVERTED',
  'VERSION_LABEL_MISSING',
  'VERSION_PAYLOAD_MISSING',
  'POLICY_UNRESOLVED',
  'VERSION_NOT_VALIDATED',
  'PUBLISHED_INTERVAL_OVERLAP',
] as const satisfies readonly LeavePolicyVersionValidationRefusal[];

/**
 * ONE refusal, with the coordinate that produced it.
 *
 * WHY A COORDINATE AND NOT JUST A CODE. §12.3 requires the refusal to be READABLE — "a readable
 * message — never a silent winner". A code alone tells an HR administrator that *something* about
 * their policy is wrong but not WHICH limit, so a report without this would send them looking
 * through a document they may have authored months earlier. `limitIndex`/`limitLeaveTypeId` are
 * deliberately absent when the defect is not about a limit.
 */
export interface LeavePolicyVersionValidationIssue {
  readonly refusal: LeavePolicyVersionValidationRefusal;
  /** Zero-based position of the offending limit inside the version's declared limit list. */
  readonly limitIndex?: number;
  /** The leave type the offending limit names, when the defect is scoped to one. */
  readonly limitLeaveTypeId?: string;
}

/**
 * The closed set of request states a limit's `consumesStates` may name (§16.4).
 *
 * This is the DOMAIN's spelling of the two members `domain/leave-policy.ts` declares as
 * `LEAVE_LIMIT_CONSUMED_STATES`. It is stated here rather than imported because `domain/` files
 * carry no import specifiers, and the equality of the two lists is ASSERTED by
 * `leave-policy-authoring.spec.ts` rather than assumed — the same maintenance contract that file
 * documents for its own derivation.
 */
export const LEAVE_POLICY_LIMIT_CONSUMED_STATES = ['APPROVED', 'PENDING'] as const;

/** One consumed state, as this vocabulary spells it. */
export type LeavePolicyLimitConsumedState = (typeof LEAVE_POLICY_LIMIT_CONSUMED_STATES)[number];

/** True for a value that is one of the declared consumed states. */
export function isLeavePolicyLimitConsumedState(
  value: unknown
): value is LeavePolicyLimitConsumedState {
  return (
    typeof value === 'string' &&
    (LEAVE_POLICY_LIMIT_CONSUMED_STATES as readonly string[]).includes(value)
  );
}

/**
 * The `countingBasis` members this vocabulary accepts (§16.1).
 *
 * Stated as data so `isLeavePolicyLimitCountingBasis` decides membership from ONE list, and so a
 * spec can assert the accepted set exactly instead of sampling values.
 */
export const LEAVE_POLICY_LIMIT_COUNTING_BASES = ['REQUEST_COUNT', 'DAY_COUNT'] as const;

/** One accepted counting basis. */
export type LeavePolicyLimitCountingBasis = (typeof LEAVE_POLICY_LIMIT_COUNTING_BASES)[number];

/** True for a value that is one of the declared bases. */
export function isLeavePolicyLimitCountingBasis(
  value: unknown
): value is LeavePolicyLimitCountingBasis {
  return (
    typeof value === 'string' &&
    (LEAVE_POLICY_LIMIT_COUNTING_BASES as readonly string[]).includes(value)
  );
}

/**
 * The `period` members this vocabulary accepts (§16.2). ONE member in this phase, and deliberately
 * a union so a second kind becomes a compile error at every site that reads it — the same reason
 * `LeaveLimitPeriodKind` is a union rather than a bare string.
 */
export const LEAVE_POLICY_LIMIT_PERIODS = ['YEAR'] as const;

/** One accepted period kind. */
export type LeavePolicyLimitPeriod = (typeof LEAVE_POLICY_LIMIT_PERIODS)[number];

/** True for a value that is one of the declared period kinds. */
export function isLeavePolicyLimitPeriod(value: unknown): value is LeavePolicyLimitPeriod {
  return (
    typeof value === 'string' && (LEAVE_POLICY_LIMIT_PERIODS as readonly string[]).includes(value)
  );
}

/**
 * Whether an ordered pair of inclusive `YYYY-MM-DD` days OVERLAPS.
 *
 * WHY STRING COMPARISON IS CORRECT HERE, AND WHY IT IS NOT AN ACCIDENT
 * -------------------------------------------------------------------
 * `LeavePolicyVersion.effectiveFrom`/`effectiveTo` and `LeaveLimitDefinition.windowStart`/
 * `windowEnd` are all stored `@db.Date`, and this module's single stored spelling of a calendar day
 * is the zero-padded `YYYY-MM-DD` string the window resolver already produces
 * (`leave-policy-window.ts`). For that fixed-width, zero-padded, big-endian format, lexicographic
 * order IS chronological order, so no parsing and no timezone enters the comparison — which is the
 * property that keeps a date-only fact from becoming an instant. A `Date` comparison would
 * reintroduce exactly the timezone dependence `@db.Date` was chosen to remove.
 *
 * `null` END IS OPEN-ENDED and therefore overlaps every later interval, matching the DB guard's own
 * reading (`daterange(from, COALESCE(to, DATE 'infinity'), '[]')`): the two must agree, and this
 * function states the same rule in the domain so a validation refusal can be produced BEFORE the
 * constraint would answer with a driver-level error.
 */
export function doInclusiveDayRangesOverlap(
  firstStart: string,
  firstEnd: string | null,
  secondStart: string,
  secondEnd: string | null
): boolean {
  // A `null` end is infinity, so "the other starts after I end" can never be satisfied by it.
  if (firstEnd !== null && secondStart > firstEnd) return false;
  if (secondEnd !== null && firstStart > secondEnd) return false;
  return true;
}
