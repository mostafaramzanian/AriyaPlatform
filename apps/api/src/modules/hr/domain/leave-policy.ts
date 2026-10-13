/**
 * Phase 54-D: the LEAVE POLICY vocabulary — counting bases, consumed states, period kinds and
 * the rule-set identity — stated ONCE, with no imports at all.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `domain/leave-status.ts` exists because "may this request be withdrawn?" is decided by two
 * strings and a rule that needs a container in order to be TESTED will not be tested. The same
 * argument applies verbatim to a leave limit, and it is stronger here: a limit is a statement
 * about somebody's entitlement, so the vocabulary it is stated in must be readable in one
 * sitting rather than discovered across a DTO, a service and a migration.
 *
 * WHY IT IMPORTS NOTHING
 * ----------------------
 * `hr-application-boundaries.spec.ts` asserts mechanically that every non-spec file under
 * `domain/` has zero import specifiers. This file obeys that rule rather than being an exception
 * to it, which is why the engine's own type vocabulary (`RuleCountingBasis`, `RuleSetStatus`) is
 * NOT imported here: the domain states what the DOMAIN means by a counting basis, and the
 * application layer reconciles the two spellings — exactly as `leave-status.ts` states
 * `PENDING`/`CANCELLED` without importing the Prisma enum that also carries them.
 *
 * WHY THE CONSUMED STATES ARE THE PHASE 54 SPLIT, AND WHY THAT IS NOT A NARROWING
 * ------------------------------------------------------------------------------
 * The frozen specification (§16.4, D7) requires a limit to declare `consumesStates` and forbids
 * a default, because "does a pending request consume the limit?" is a POLICY question rather
 * than an implementation detail. The specification's own illustration offers two shapes —
 * `APPROVED` alone, or `APPROVED` + `PENDING` ("reservation").
 *
 * `APPROVED` is NOT a member of `LeaveRequestStatus` in this phase (see `leave-status.ts`), and
 * §21.2 requires the enum member, the migration's CHECK, the transition table, the permission
 * and its Core seed row to move TOGETHER. Introducing the member here to make a limit
 * expressible would land a decision state nobody is yet entitled to write, in one phase, in
 * order to satisfy a *different* phase's configuration surface.
 *
 * SO THIS FILE STATES TWO THINGS SEPARATELY, AND THE SEPARATION IS THE DESIGN:
 *
 *   1. `LEAVE_LIMIT_CONSUMED_STATES` — the vocabulary a policy AUTHOR may state. It contains
 *      `APPROVED`, because the frozen contract keeps it and dropping it would be the
 *      unauthorized narrowing §39.10 forbids. A policy is configuration: it may state a rule
 *      the current runtime cannot yet count, and saying so is honest.
 *   2. `LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES` — the subset the CURRENT lifecycle can count,
 *      because counting `APPROVED` requires `APPROVED` to exist. This is derived from the same
 *      two members `LeaveRequestStatus` declares, so the day 54-E adds the member this
 *      derivation widens by itself and no list has to be remembered.
 *
 * An enforcement path that meets a declared set outside the enforceable subset must REFUSE AS
 * INSUFFICIENT CONTEXT — never count a substitute population, and never quietly drop the
 * declaration. That is the difference between a scope split (this) and a semantic narrowing
 * (which the specification forbids).
 */

/**
 * The `countingBasis` values the frozen specification declares (§16.1, D7).
 *
 * TWO SEMANTICS, NOT TWO SPELLINGS OF ONE NUMBER. `REQUEST_COUNT` counts REQUESTS; `DAY_COUNT`
 * counts the CALENDAR DAYS those requests cover. A stored `3` is never interpreted without its
 * basis, which is why there is no default anywhere in this module and why a maximum is only ever
 * rendered together with the basis it was stated on.
 */
export type LeaveLimitCountingBasis = 'REQUEST_COUNT' | 'DAY_COUNT';

/** The members, in the order the specification declares them. */
export const LEAVE_LIMIT_COUNTING_BASES = ['REQUEST_COUNT', 'DAY_COUNT'] as const;

/** True for a value that is one of the two bases — used to validate stored configuration. */
export function isLeaveLimitCountingBasis(value: unknown): value is LeaveLimitCountingBasis {
  return (
    typeof value === 'string' && (LEAVE_LIMIT_COUNTING_BASES as readonly string[]).includes(value)
  );
}

/**
 * What each basis counts, as a readable statement — so the two can never be rendered as if they
 * were interchangeable.
 *
 * `DAY_COUNT` is INCLUSIVE CALENDAR DAYS (`end_date - start_date + 1`) and is deliberately NOT
 * working days: HR has no read path to `CalendarOccasion`, and a workday figure computed without
 * one would be invented arithmetic (§16.3, §40). No stored `durationDays` exists anywhere, for
 * the reason the schema already states.
 */
export const LEAVE_LIMIT_COUNTING_BASIS_MEANING: Readonly<Record<LeaveLimitCountingBasis, string>> =
  {
    REQUEST_COUNT: 'counts REQUESTS in the consumed states',
    DAY_COUNT: 'counts INCLUSIVE CALENDAR DAYS covered by requests in the consumed states',
  };

/**
 * The `period` kinds a limit may state. ONE member in this phase, and it is deliberately a union
 * rather than a bare string so a second kind becomes a compile error at every site that reads it.
 *
 * `YEAR` is the TENANT-VISIBLE JALALI YEAR (§16.2, D7). The window is RESOLVED at configuration
 * time through `src/calendar/jalali.util.ts` and stored as two inclusive calendar days, because
 * the engine performs no calendar arithmetic (§34.3, D12) — it cannot answer "when does this
 * year start", and it does not need to.
 */
export type LeaveLimitPeriodKind = 'YEAR';

/** The members, in the order the specification declares them. */
export const LEAVE_LIMIT_PERIOD_KINDS = ['YEAR'] as const;

/** True for a value that is one of the period kinds. */
export function isLeaveLimitPeriodKind(value: unknown): value is LeaveLimitPeriodKind {
  return (
    typeof value === 'string' && (LEAVE_LIMIT_PERIOD_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The request states a policy AUTHOR may state as consuming a limit (§16.4, D7).
 *
 * `APPROVED` IS PRESENT ON PURPOSE AND MUST NOT BE REMOVED. It is the state the frozen contract
 * names, and the reason a limit is not yet ENFORCEABLE — not a reason for the contract to stop
 * being expressible. Two shapes are therefore authorable: `['APPROVED']` (decided leave counts)
 * and `['APPROVED', 'PENDING']` (decided leave plus reservations count).
 *
 * `CANCELLED` IS DELIBERATELY ABSENT. A withdrawn request was never leave, so "does it consume a
 * limit?" is not a question this vocabulary answers with a member: a policy that wanted it would
 * be stating that a withdrawal still spends entitlement, which is a different product decision
 * and not one this phase is authorized to make.
 */
export const LEAVE_LIMIT_CONSUMED_STATES = ['APPROVED', 'PENDING'] as const;

/** One authorable consumed state. */
export type LeaveLimitConsumedState = (typeof LEAVE_LIMIT_CONSUMED_STATES)[number];

/** True for a value that is an authorable consumed state. */
export function isLeaveLimitConsumedState(value: unknown): value is LeaveLimitConsumedState {
  return (
    typeof value === 'string' && (LEAVE_LIMIT_CONSUMED_STATES as readonly string[]).includes(value)
  );
}

/**
 * The request states `LeaveRequestStatus` declares TODAY, as a membership set.
 *
 * DECLARED LOCALLY BECAUSE THIS FILE IMPORTS NOTHING, and kept as a `Set` so the filter below is
 * a membership test rather than a second traversal. It is NOT the authoritative list — that is
 * `LEAVE_REQUEST_STATUSES` in `domain/leave-status.ts`, and a spec asserts the two agree — so a
 * reader must not treat this as a second source of truth to edit.
 *
 * WHY THE DUPLICATION IS SAFE: the two are compared mechanically rather than trusted. See
 * `leave-policy.spec.ts` ("agrees with the leave lifecycle it derives from"), which fails if the
 * lifecycle gains a member and this set is not updated — exactly the maintenance contract
 * `leave-status.ts` writes for whoever adds `APPROVED`.
 *
 * THAT CONTRACT WAS DISCHARGED IN PHASE 54-E, and this is what it looked like: the lifecycle gained
 * `APPROVED` and `REJECTED`, the spec below failed on the next run, and this set was widened in the
 * same change. The four members are listed in SCHEMA ORDER, matching `LEAVE_REQUEST_STATUSES`, so
 * the two reads can be compared by eye as well as by the spec.
 */
export const LEAVE_LIFECYCLE_STATUS_MEMBERS: ReadonlySet<string> = new Set<string>([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

/**
 * THE STATES THE CURRENT LIFECYCLE CAN ACTUALLY COUNT — derived, never re-listed by hand.
 *
 * WHY THIS EXISTS AT ALL. A limit whose declared set names a state the lifecycle cannot reach
 * describes a population that cannot yet be assembled from stored rows. The honest answer to "how
 * many are consumed?" is then *this cannot be counted* — not `0`, and not "everything not
 * cancelled".
 *
 * WHY IT IS DERIVED. It filters `LEAVE_LIMIT_CONSUMED_STATES` through the lifecycle members, so
 * 54-E's addition of `APPROVED` widened this WITHOUT an edit on this line — the maintenance
 * contract is discharged by construction rather than by a comment asking somebody to remember.
 * On this phase's data it evaluates to `['APPROVED', 'PENDING']`: both members of the authorable
 * set are now reachable, so the gap the previous phase documented is CLOSED and a limit naming
 * `APPROVED` is enforceable rather than merely authorable. A spec pins exactly that list, so the
 * derivation cannot silently become empty — which would make every limit unenforceable while
 * looking like it worked.
 */
export const LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES: readonly LeaveLimitConsumedState[] = (
  LEAVE_LIMIT_CONSUMED_STATES as readonly LeaveLimitConsumedState[]
).filter((state) => LEAVE_LIFECYCLE_STATUS_MEMBERS.has(state));

/**
 * WHY an authorable set is not enforceable, stated as a machine code the API returns and the UI
 * renders. A refusal is a VALUE here rather than a sentence, for the reason the engine's own
 * refusals are typed (§6.4): the caller needs a code, and prose belongs at the edge.
 */
export type LeaveLimitEnforceabilityRefusal =
  /** A limit must consume at least one state — an empty set counts everything or nothing. */
  | 'CONSUMED_STATES_EMPTY'
  /** The declared set names a state the current lifecycle does not have (§21.6, D2). */
  | 'CONSUMED_STATE_NOT_IN_LIFECYCLE';

/**
 * The refusal, or `null` when the set can be counted today.
 *
 * RETURNED RATHER THAN THROWN so a simulation can REPORT it (§14, §32) while an enforcement path
 * turns it into a refusal. The same computation serves both, which is what stops "what the
 * simulator said" and "what the request path did" from disagreeing.
 *
 * AN EMPTY SET IS REFUSED FIRST AND SEPARATELY. §16.4 refuses it because a limit with no declared
 * state "silently counts everything or nothing", and that is a different defect from naming a
 * state the lifecycle lacks: the first is an unstated policy, the second is a policy that is
 * stated and not yet runnable. Collapsing them would lose the distinction the UI needs.
 */
export function leaveLimitEnforceabilityRefusal(
  states: readonly LeaveLimitConsumedState[]
): LeaveLimitEnforceabilityRefusal | null {
  if (states.length === 0) {
    return 'CONSUMED_STATES_EMPTY';
  }

  return states.some((state) => !LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES.includes(state))
    ? 'CONSUMED_STATE_NOT_IN_LIFECYCLE'
    : null;
}

/** True when the current lifecycle can assemble a population for this declared set. */
export function isLeaveLimitConsumedStatesEnforceable(
  states: readonly LeaveLimitConsumedState[]
): boolean {
  return leaveLimitEnforceabilityRefusal(states) === null;
}

/**
 * The employment types a limit's `employmentType` scope may name (§16.6).
 *
 * DECLARED LOCALLY BECAUSE THIS FILE IMPORTS NOTHING, for the reason the whole file exists. The
 * authoritative list is the `EmploymentType` enum in `prisma/hr/schema.prisma`, and
 * `leave-policy.spec.ts` asserts the two agree mechanically, so this is a mirror under a test
 * rather than a second source of truth to edit. A reader who adds an enum member and not this
 * list breaks that spec — which is the point: the drift is reported rather than discovered when a
 * limit silently stops matching a group of employees.
 *
 * `null` on a stored limit means UNSCOPED — every employment type — and is NOT a member here
 * (§16.6): "applies to everyone" and "applies to full-timers" are different statements, and
 * collapsing them would make an unscoped limit indistinguishable from a scoped one.
 */
export type LeaveLimitEmploymentType =
  'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'TEMPORARY' | 'INTERNSHIP';

/**
 * The members, in the order the enum declares them.
 *
 * An ARRAY rather than a `Set` because the order is load-bearing for the spec that compares it to
 * the Prisma enum's declaration order, which is how that spec detects a member added in the
 * middle rather than merely at the end.
 */
export const LEAVE_LIMIT_EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'TEMPORARY',
  'INTERNSHIP',
] as const;

/** True for a value that is one of the employment types — used to validate stored configuration. */
export function isLeaveLimitEmploymentType(value: unknown): value is LeaveLimitEmploymentType {
  return (
    typeof value === 'string' && (LEAVE_LIMIT_EMPLOYMENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * WHY an employment scope could not be decided (§16.6), as a machine code.
 *
 * A REFUSAL IS A VALUE, for the reason `LeaveLimitEnforceabilityRefusal` is: the caller needs a
 * code and prose belongs at the edge. The distinction this type exists to preserve is that
 * *insufficient context* is not *not applicable*: a limit scoped to `FULL_TIME` is not satisfied
 * by an employee whose employment record is missing, and it is not violated by them either. The
 * question cannot be answered, and answering it anyway — either way — is the silent default
 * §16.6 forbids.
 */
export type LeaveLimitEmploymentScopeRefusal = 'EMPLOYMENT_TYPE_UNKNOWN';

/**
 * Whether a limit's declared employment scope applies to an employment type, or WHY that cannot
 * be decided (§16.6).
 *
 * `null` FOR THE SCOPE MEANS UNSCOPED and applies to every type. That is the only case where an
 * absent employment type is harmless: nothing needs to be compared, so nothing is unknown.
 *
 * NO SILENT DEFAULT TO EITHER ANSWER. A scoped limit asked about a `null` employment type returns
 * a refusal rather than `false`. Returning `false` would read as "this limit does not govern you",
 * which is an allowance the engine would then act on — a limit that fails open on missing data is
 * worse than no limit, because the refusal it was authored to produce is the thing that silently
 * stops happening.
 */
export function leaveLimitEmploymentScopeRefusal(
  scopedEmploymentType: LeaveLimitEmploymentType | null,
  employmentType: LeaveLimitEmploymentType | null
): LeaveLimitEmploymentScopeRefusal | null {
  if (scopedEmploymentType === null) {
    return null;
  }

  return employmentType === null ? 'EMPLOYMENT_TYPE_UNKNOWN' : null;
}

/**
 * Whether the limit governs this employee's employment type.
 *
 * Three-valued on purpose, and the caller must handle all three. A `boolean` return would force
 * "cannot tell" to masquerade as one of the two answers, and the engine's refusal semantics
 * (§16.7) need to tell two situations apart — a scope that does NOT apply, and a scope whose
 * applicability cannot be decided. Deciding whether an *undecidable* scope stops evaluation is the
 * evaluator's business; this function only refuses to invent the answer. The distinction is carried
 * by the three variants rather than by a sentence.
 */
export function isLeaveLimitApplicableToEmploymentType(
  scopedEmploymentType: LeaveLimitEmploymentType | null,
  employmentType: LeaveLimitEmploymentType | null
): boolean | LeaveLimitEmploymentScopeRefusal {
  const refusal = leaveLimitEmploymentScopeRefusal(scopedEmploymentType, employmentType);
  if (refusal !== null) {
    return refusal;
  }

  // Unscoped limits govern everyone; a scoped limit governs its own type.
  return scopedEmploymentType === null || scopedEmploymentType === employmentType;
}

/**
 * THE RULE-SET IDENTITY the leave limits are evaluated under, in `hr_db` and in the engine's
 * registry alike.
 *
 * ONE STRING, DECLARED ONCE, because it appears in the tenant's stored policy row, in the
 * version a decision is taken under, and in the engine's `(rule-set id, version)` key (§10.1). A
 * literal retyped at three sites is how a published policy becomes unreachable without any test
 * failing — the drift §43.10 gate 4 exists for, applied to HR's own configuration.
 *
 * The `hr.` prefix matches the module id HR declares (`HR_MODULE_ID`) and the `resource` strings
 * the audit trail already carries, so an operator reading a policy's identity can tell whose it
 * is without a join.
 */
export const LEAVE_LIMIT_RULE_SET_ID = 'hr.leave.limit';
