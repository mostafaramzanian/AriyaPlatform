import {
  doInclusiveDayRangesOverlap,
  isLeavePolicyLimitConsumedState,
  isLeavePolicyLimitCountingBasis,
  isLeavePolicyLimitPeriod,
} from '../domain/leave-policy-authoring';
import type {
  LeavePolicyVersionValidationIssue,
  LeavePolicyVersionValidationRefusal,
} from '../domain/leave-policy-authoring';
import type { LeaveRequestStatus } from '../domain/leave-status';
import type { LeaveLimitPeriodKind } from '../domain/leave-policy';
import type { LeaveLimitWindow } from '../leave-policy-window';

/**
 * Phase 54-F (§10.3, §12.3, §15, §16): the version VALIDATOR — the one gate between a DRAFT and a
 * VALIDATED version.
 *
 * WHY THIS IS A PURE FUNCTION OVER AN EXPLICIT FACT SET
 * ----------------------------------------------------
 * Nothing here reads a clock, a database or an ambient actor. It receives the AUTHORED body and the
 * FACTS the caller resolved (which leave types exist in this tenant, which states the current
 * lifecycle can reach, which interval a live published version occupies) and answers with a LIST OF
 * REFUSALS. That shape is what makes the gate testable by assertion rather than by mocking, and it
 * is why the service, not this file, is the thing that queries.
 *
 * WHY IT REPORTS EVERY REFUSAL INSTEAD OF THE FIRST
 * ------------------------------------------------
 * §12.3 requires the refusal to be READABLE. A validator that returned at the first problem would
 * make a five-limit policy with five problems need five round trips, and — worse — would hide four
 * of them behind whichever one happens to be checked first, so "the policy is fixed now" would be
 * untrue as often as the check order happens to be unlucky. Every applicable refusal is collected.
 *
 * WHY IT IS FAIL-CLOSED
 * ---------------------
 * Every predicate below is written so that UNKNOWN, ABSENT and MALFORMED all produce a refusal
 * rather than an exemption. Concretely:
 *
 *   * an unrecognized `countingBasis`, `period`, `consumesStates` member or `employmentType` is
 *     refused rather than ignored — a value the vocabulary does not know cannot be said to satisfy
 *     it;
 *   * an unresolved leave type is refused, so an empty set of "known" types refuses every limit
 *     rather than accepting them: the failure mode is a strict validator, never a permissive one;
 *   * a refused limit still contributes its coordinates to the report, so the caller learns WHICH
 *     limit was refused even when the defect is that the limit could not be read at all.
 *
 * The single place that is deliberately NOT fail-closed is stated where it occurs: a version whose
 * `jalaliYear` is absent is refused on THAT ground alone, and window resolution is skipped rather
 * than attempted — an absent year has no window to be wrong about, and manufacturing one would
 * produce a second, misleading refusal.
 */

/**
 * Everything the validator needs that is NOT in the authored body.
 *
 * `resolveLimitWindow` IS INJECTED RATHER THAN IMPORTED so this module stays a pure function of its
 * inputs while still using the module's ONE calendar boundary in production. A spec can therefore
 * assert "this refusal came from my window" without a second Jalali implementation existing in the
 * test. The production value is `resolveLeaveLimitWindow` — and passing anything else would be
 * passing a different calendar, which is why the service passes exactly that.
 */
export interface LeavePolicyValidationFacts {
  /** Leave type ids that exist in the ACTING tenant (§15.2/§24.3). */
  readonly knownLeaveTypeIds: ReadonlySet<string>;
  /**
   * The request states the CURRENT lifecycle can actually reach, from the leave-status domain.
   * §16.4/§21.6: a limit that consumes a state nothing can reach counts nothing, so declaring one
   * is refused as INSUFFICIENT CONTEXT rather than silently ignored.
   */
  readonly reachableRequestStatuses: ReadonlySet<LeaveRequestStatus>;
  /**
   * The interval a LIVE PUBLISHED version of this policy already occupies, as two inclusive
   * `YYYY-MM-DD` days, or `null` when none is published (§10.4).
   *
   * This is the fact behind `PUBLISHED_INTERVAL_OVERLAP`, and it is a fact rather than a query
   * because the validator answers "would publishing this leave two equally-current versions?" — a
   * question about two intervals, not about a table.
   */
  readonly publishedInterval: { readonly start: string; readonly end: string | null } | null;
  /** The employment scopes this tenant's vocabulary accepts (§16.6). */
  readonly knownEmploymentTypes: ReadonlySet<string>;
  /** Resolves a period kind + year into an inclusive window. Production: `resolveLeaveLimitWindow`. */
  readonly resolveLimitWindow: (
    period: LeaveLimitPeriodKind,
    jalaliYear: number
  ) => LeaveLimitWindow;
  /**
   * The window the caller would STORE, or `null` to mean "resolve it and store the resolution".
   *
   * WHY THIS IS A FACT AND NOT A SECOND RESOLUTION
   * ----------------------------------------------
   * §16.2's window is NOT caller-supplied — the authoring DTO carries no `windowStart`/`windowEnd`
   * precisely so a caller cannot declare a window disagreeing with the year it claims to govern. In
   * the ordinary path this is `null`, and the validator resolves and confirms.
   *
   * When it is NOT `null` it is the window being checked, and the expected window is resolved
   * INDEPENDENTLY from `resolveLimitWindow`. That direction matters: checking a resolver's output
   * against a second call to the SAME resolver cannot detect a resolver that ignores its year, since
   * both calls would agree on the same wrong answer. Comparing a STORED window against an
   * independent resolution can. This is the shape a re-validation of an existing draft uses, and the
   * shape that makes `LIMIT_WINDOW_YEAR_MISMATCH` reachable rather than decorative.
   */
  readonly storedWindow: LeaveLimitWindow | null;
}

/** The authored limit, as the validator reads it — deliberately loose, because it IS untrusted. */
export interface AuthoredLeaveLimit {
  readonly leaveTypeId?: unknown;
  readonly employmentType?: unknown;
  readonly maximum?: unknown;
  readonly countingBasis?: unknown;
  readonly period?: unknown;
  readonly consumesStates?: unknown;
  readonly effectiveFrom?: unknown;
  readonly effectiveTo?: unknown;
}
/** The authored version, as the validator reads it — every field untrusted. */
export interface AuthoredLeavePolicyVersion {
  readonly versionLabel?: unknown;
  readonly jalaliYear?: unknown;
  readonly effectiveFrom?: unknown;
  readonly effectiveTo?: unknown;
  readonly payload?: unknown;
  readonly limits?: unknown;
}

// -- Reading untrusted scalars -------------------------------------------

/**
 * A non-empty, trimmed string, or `null`.
 *
 * Trimming matters: `"  "` is not a label, and a leave type id padded with a space would MISS the
 * `knownLeaveTypeIds` set and be refused as unresolvable — a confusing refusal for a value the
 * author can plainly see. Normalising here means the refusal, when it comes, is about the value the
 * author meant.
 */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A number, or `null`. `NaN` and the infinities are not numbers a policy can mean. */
function asNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** An integer, or `null`. Separate from `asNumber` so `jalaliYear: 1403.5` is refused as such. */
function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/**
 * A `YYYY-MM-DD` day, or `null`.
 *
 * The SHAPE is checked, not the calendar validity of the date: `1403-13-40` is a well-formed day
 * string that names no day. Calendar truth is the window resolver's question (§15.5) and is answered
 * there; refusing an impossible date here would duplicate that logic and risk disagreeing with it.
 * What this gate refuses is a value that is not a day at all.
 */
function asDayString(value: unknown): string | null {
  const parsed = asNonEmptyString(value);
  if (parsed === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : null;
}

/**
 * A `YYYY-MM-DD` day, `null` when the field is ABSENT, or `null` when it is present but unreadable.
 *
 * The two `null`s are deliberately conflated: an open-ended interval and a misspelled one are both
 * "no end bound", and the caller that needs to tell them apart is checking for the field's presence
 * itself, which it can do without this helper guessing on its behalf.
 */
function asOptionalDayString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return asDayString(value);
}

/**
 * ONE limit reduced to the fields the CONFLICT checks need, and only when those fields were readable.
 *
 * It exists so the pairwise scan cannot read a `null` as a value: a limit that failed to parse is
 * absent from the list entirely, which is the only way "we could not compare these" stays distinct
 * from "these compare equal".
 */
interface ReadableLimit {
  readonly index: number;
  readonly leaveTypeId: string | undefined;
  /** The employment scope, normalised to `null` when the limit applies to every type (§16.6). */
  readonly employmentType: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Whether the window that would be STORED is the window Jalali year `jalaliYear` actually spans.
 *
 * WHY THE EXPECTED WINDOW IS RESOLVED HERE AND THE CANDIDATE IS PASSED IN
 * ----------------------------------------------------------------------
 * The candidate comes from `facts.storedWindow` when the caller supplies one, and otherwise from the
 * resolver — but the EXPECTED window always comes from `resolve`, called here, independently. That
 * ordering is the whole value of the check: comparing a resolver's answer against a second call to
 * the SAME resolver can never fail, because a resolver that ignores its `jalaliYear` returns the same
 * wrong answer both times. Comparing stored data against an independent resolution can.
 *
 * The window is GREGORIAN — `resolve('YEAR', 1403)` answers `2024-03-20 .. 2025-03-20` — so a prefix
 * test against `1403` would refuse every correct window. Both bounds are compared, so a window whose
 * start belongs to the right year but whose end runs into the next Nowruz is refused rather than
 * stored.
 */
function isWindowForJalaliYear(
  candidate: LeaveLimitWindow | null,
  jalaliYear: number,
  resolve: (period: LeaveLimitPeriodKind, jalaliYear: number) => LeaveLimitWindow
): boolean {
  const start = asDayString(candidate?.start);
  const end = asDayString(candidate?.end);
  if (start === null || end === null) return false;

  const expected = resolve('YEAR', jalaliYear);
  const expectedStart = asDayString(expected?.start);
  const expectedEnd = asDayString(expected?.end);
  if (expectedStart === null || expectedEnd === null) return false;

  return start === expectedStart && end === expectedEnd;
}

/**
 * Validates an authored version and returns EVERY refusal it earns.
 *
 * AN EMPTY ARRAY IS THE ONLY ACCEPTANCE. There is no `{ ok: boolean }` wrapper, because a caller
 * that forgot to read the list could not accidentally publish: the caller must decide what an empty
 * list means, and the one honest decision is "nothing refused it".
 *
 * THE PAYLOAD IS NOT PARSED. §15.6 stores the body the engine validated; interpreting that body is
 * the engine's question, not this gate's. What is checked is that a payload EXISTS — an absent body
 * has nothing to render an old explanation from (§10.6, §13.2) — and the refusal says exactly that
 * rather than pretending the document's rules were evaluated.
 */
export function validateLeavePolicyVersion(
  version: AuthoredLeavePolicyVersion,
  facts: LeavePolicyValidationFacts
): LeavePolicyVersionValidationIssue[] {
  const issues: LeavePolicyVersionValidationIssue[] = [];
  const add = (
    refusal: LeavePolicyVersionValidationRefusal,
    limitIndex?: number,
    leaveTypeId?: string
  ) => {
    issues.push(
      limitIndex === undefined
        ? { refusal }
        : leaveTypeId === undefined
          ? { refusal, limitIndex }
          : { refusal, limitIndex, limitLeaveTypeId: leaveTypeId }
    );
  };

  // -- The version's own fields (§15.4, §10.1, §15.6) -----------------------

  if (asNonEmptyString(version.versionLabel) === null) add('VERSION_LABEL_MISSING');

  const effectiveFrom = asDayString(version.effectiveFrom);
  if (effectiveFrom === null) add('VERSION_EFFECTIVE_FROM_MISSING');

  const effectiveTo = asOptionalDayString(version.effectiveTo);
  // Reported only when a start exists: without one there is no interval to be inverted, and saying
  // "inverted" about a version that has no start would name the wrong repair.
  if (effectiveFrom !== null && typeof effectiveTo === 'string' && effectiveTo < effectiveFrom) {
    add('VERSION_EFFECTIVE_INTERVAL_INVERTED');
  }

  if (version.payload === undefined || version.payload === null) add('VERSION_PAYLOAD_MISSING');

  // Parsed ONCE, here, so the year the version declares is the year every limit resolves against.
  // `null` when absent or unreadable, which is exactly when resolution must be skipped below.
  const jalaliYear = asInteger(version.jalaliYear);
  if (jalaliYear === null) add('VERSION_JALALI_YEAR_MISSING');

  // -- The limits (§15.4, §16) ---------------------------------------------

  // Limits whose OWN fields are all readable, i.e. the only ones the pairwise checks below can
  // reason about. A limit that failed to parse still contributed its refusal above; including it
  // here would compare against `null`s and invent conflicts that are not really there.
  const readableLimits: ReadableLimit[] = [];

  const limits = Array.isArray(version.limits) ? (version.limits as AuthoredLeaveLimit[]) : [];

  limits.forEach((limit, index) => {
    const leaveTypeId = asNonEmptyString(limit.leaveTypeId) ?? undefined;

    // §15.2/§24.3: a limit names a leave type of THIS tenant. An unresolvable reference is refused
    // rather than skipped — skipping would accept a limit that governs nothing.
    if (leaveTypeId === undefined || !facts.knownLeaveTypeIds.has(leaveTypeId)) {
      add('LIMIT_LEAVE_TYPE_UNRESOLVED', index, leaveTypeId);
    }

    // §16: integer, greater than zero.
    const maximum = asNumber(limit.maximum);
    if (maximum === null || maximum <= 0) add('LIMIT_MAXIMUM_NOT_POSITIVE', index, leaveTypeId);
    if (maximum !== null && !Number.isInteger(maximum)) {
      add('LIMIT_MAXIMUM_NOT_INTEGER', index, leaveTypeId);
    }

    // §16.1: mandatory and never implied.
    if (
      limit.countingBasis === undefined ||
      limit.countingBasis === null ||
      limit.countingBasis === ''
    ) {
      add('LIMIT_COUNTING_BASIS_MISSING', index, leaveTypeId);
    } else if (!isLeavePolicyLimitCountingBasis(limit.countingBasis)) {
      add('LIMIT_COUNTING_BASIS_UNSUPPORTED', index, leaveTypeId);
    }

    // §16.2: a CLOSED vocabulary.
    if (!isLeavePolicyLimitPeriod(limit.period))
      add('LIMIT_PERIOD_UNSUPPORTED', index, leaveTypeId);

    // §16.4: required, non-empty, every member known, every member reachable.
    const consumed = Array.isArray(limit.consumesStates)
      ? (limit.consumesStates as unknown[])
      : null;
    if (consumed === null || consumed.length === 0) {
      add('LIMIT_CONSUMED_STATES_EMPTY', index, leaveTypeId);
    } else {
      for (const state of consumed) {
        if (!isLeavePolicyLimitConsumedState(state)) {
          add('LIMIT_CONSUMED_STATE_UNSUPPORTED', index, leaveTypeId);
        } else if (!facts.reachableRequestStatuses.has(state as LeaveRequestStatus)) {
          // The stored vocabulary knows the state but the CURRENT lifecycle cannot reach it, so a
          // limit consuming only it would be met by nobody (§16.4/§21.6).
          add('LIMIT_CONSUMED_STATE_NOT_IN_LIFECYCLE', index, leaveTypeId);
        }
      }
    }

    // §16.6: an employment scope is a closed vocabulary or absent.
    const employmentType = limit.employmentType;
    if (employmentType !== undefined && employmentType !== null) {
      const spelling = asNonEmptyString(employmentType);
      if (spelling === null || !facts.knownEmploymentTypes.has(spelling)) {
        add('LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED', index, leaveTypeId);
      }
    }

    // §15.4: the limit's own effective interval.
    const limitFrom = asDayString(limit.effectiveFrom);
    if (limitFrom === null) add('LIMIT_EFFECTIVE_FROM_MISSING', index, leaveTypeId);

    const limitTo = asOptionalDayString(limit.effectiveTo);
    if (limitFrom !== null && typeof limitTo === 'string' && limitTo < limitFrom) {
      add('LIMIT_EFFECTIVE_INTERVAL_INVERTED', index, leaveTypeId);
    }

    // §15.4/§16: the limit's interval must lie INSIDE the version's own interval.
    //
    // The START is checked whenever both starts are readable, regardless of the limit's END. An
    // earlier version of this test additionally required a readable `limitTo`, which silently
    // exempted the most common shape in practice — an open-ended limit — so a limit beginning before
    // its version began went unreported. The end is a SEPARATE ground: an absent end is not an
    // unbounded end when the version itself is bounded, so it is compared against the version's own
    // end below rather than skipped.
    if (limitFrom !== null && effectiveFrom !== null) {
      if (limitFrom < effectiveFrom) {
        add('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION', index, leaveTypeId);
      } else if (typeof effectiveTo === 'string') {
        // A finite version end bounds every limit inside it: a limit's open end inherits the
        // version's end, and a limit that names its own end must not pass it.
        if (typeof limitTo === 'string' ? limitTo > effectiveTo : true) {
          add('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION', index, leaveTypeId);
        }
      }
    }

    // -- §16.2: the RESOLVED window ----------------------------------------
    //
    // §16.2 requires the window to be resolved AND STORED, so resolution is not a convenience here —
    // it is part of what makes the version publishable. Resolution is attempted only when both of its
    // inputs are readable, so one defect never manufactures two refusals.

    const period = isLeavePolicyLimitPeriod(limit.period) ? limit.period : null;
    if (period !== null && jalaliYear !== null) {
      // The candidate window: what the caller would store, or the resolver's own answer when the
      // caller supplied none (§16.2 resolves it at authoring time and stores it).
      const candidate = facts.storedWindow ?? facts.resolveLimitWindow(period, jalaliYear);
      const windowStart = asDayString(candidate?.start);
      const windowEnd = asDayString(candidate?.end);

      if (windowStart === null || windowEnd === null) {
        add('LIMIT_WINDOW_MISSING', index, leaveTypeId);
      } else if (windowEnd < windowStart) {
        add('LIMIT_WINDOW_INVERTED', index, leaveTypeId);
      } else if (!isWindowForJalaliYear(candidate, jalaliYear, facts.resolveLimitWindow)) {
        // §16.2: the window belongs to the version's OWN stated year. A window that does not agree
        // with what the declared year resolves to is stored data that counts a different year's days
        // than the version claims to govern.
        add('LIMIT_WINDOW_YEAR_MISMATCH', index, leaveTypeId);
      }
    }

    // A limit whose leave type does NOT resolve is deliberately excluded from the conflict scan.
    // Two limits agreeing on an unresolvable id are not a duplicate SCOPE — neither governs anything,
    // so a conflict report beside the unresolved reference would name a repair that does not help.
    if (leaveTypeId === undefined || !facts.knownLeaveTypeIds.has(leaveTypeId)) return;

    readableLimits.push({
      index,
      leaveTypeId,
      employmentType:
        employmentType === undefined || employmentType === null
          ? null
          : asNonEmptyString(employmentType),
      from: limitFrom,
      to: limitTo,
    });
  });
  // -- Conflicts between two limits (§15.4) --------------------------------
  //
  // O(n^2) over a list that is a handful of leave types long, and deliberately so: the alternative is
  // a hash key that has to encode "same scope", "intervals overlap" and "same leave type" — three
  // different reasons — into one lookup, which is how a check like this quietly stops covering the
  // cases it was written for.

  for (let i = 0; i < readableLimits.length; i += 1) {
    for (let j = i + 1; j < readableLimits.length; j += 1) {
      const a = readableLimits[i];
      const b = readableLimits[j];
      if (a === undefined || b === undefined) continue;

      // Two limits conflict when they govern the SAME PEOPLE over the SAME LEAVE TYPE at the same
      // time. THREE cases, not one, and conflating them would either miss a real ambiguity or refuse
      // a legitimate configuration:
      //
      //   * different leave types            -> never a conflict. One window over annual and sick
      //                                         leave is the normal case.
      //   * different employment types       -> never a conflict. FULL_TIME and PART_TIME never
      //                                         describe the same employee, so both maxima hold.
      //   * one scope names a type and the
      //     other is UNSCOPED ("everyone")   -> CONFLICT. "Everyone" includes FULL_TIME, so two
      //                                         maxima govern one person. The scopes differ textually,
      //                                         which is exactly why this cannot be a `===` test.
      if (a.leaveTypeId !== b.leaveTypeId) continue;

      const scopesOverlap =
        a.employmentType === b.employmentType ||
        a.employmentType === null ||
        b.employmentType === null;
      if (!scopesOverlap) continue;

      // §15.4: two limits governing the same population whose effective intervals overlap leave
      // "which maximum governs?" unanswered. An open end is treated as unbounded, which is the
      // doctrine the rest of the module already uses for live versions.
      if (a.from !== null && b.from !== null) {
        const aTo = a.to;
        const bTo = b.to;
        const overlaps =
          aTo === null || bTo === null
            ? a.from <= (bTo ?? '9999-12-31') && b.from <= (aTo ?? '9999-12-31')
            : doInclusiveDayRangesOverlap(a.from, aTo, b.from, bTo);
        if (!overlaps) continue;

        // The refusal names WHICH ambiguity this is, because the two have different repairs: an
        // identical scope is a redundant entry to delete, while two overlapping scopes need one of
        // them narrowed or their dates separated.
        const sameScope = a.employmentType === b.employmentType;
        add(
          sameScope ? 'LIMIT_DUPLICATE_SCOPE' : 'LIMIT_EFFECTIVE_INTERVAL_OVERLAP',
          b.index,
          b.leaveTypeId
        );
      }
    }
  }

  // -- The version against what is already published (§10.4) ---------------

  // §10.4: publishing would leave two equally-current published versions of one policy, so the
  // interval the live version already occupies is checked for overlap. Only the VERSION's own
  // interval is compared — a version's limits may narrow or widen freely inside it, and a version
  // whose interval is unreadable is already refused above rather than guessed at here.
  if (
    effectiveFrom !== null &&
    facts.publishedInterval !== null &&
    typeof facts.publishedInterval.start === 'string'
  ) {
    const liveFrom = facts.publishedInterval.start;
    const liveTo = facts.publishedInterval.end;
    const thisTo = effectiveTo;
    const overlaps =
      thisTo === null || liveTo === null
        ? effectiveFrom <= (liveTo ?? '9999-12-31') && liveFrom <= (thisTo ?? '9999-12-31')
        : doInclusiveDayRangesOverlap(effectiveFrom, thisTo, liveFrom, liveTo);
    if (overlaps) add('PUBLISHED_INTERVAL_OVERLAP');
  }

  return issues;
}
