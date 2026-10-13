import type { LeaveLimitCountingBasis } from '../domain/leave-policy';
import { leaveLimitEnforceabilityRefusal } from '../domain/leave-policy';
import type {
  LeaveLimitConsumedState,
  LeaveLimitEnforceabilityRefusal,
} from '../domain/leave-policy';

/**
 * Phase 54-D (§16.1, §16.3, §16.7): the LEAVE LIMIT COUNTING ASSEMBLY — HR's half of the limit
 * decision.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------------
 * The platform Rule Engine is domain-agnostic: it compares numbers and produces a
 * `RuleLimitRefusalAction`. It has no idea what a leave request is, cannot read `hr_db`, and must
 * never learn. HR's job is everything UP TO that comparison: fetch the stored configuration, work
 * out which stored requests qualify, count them on the declared basis, and hand the engine a typed
 * set of grounds.
 *
 * That boundary is why this file contains no Prisma call, no Nest decorator and no HTTP: it takes
 * ALREADY-FETCHED rows (shaped as the narrow interfaces below) and returns a typed result. The
 * caller — the application layer that owns the transaction and the tenant — does the reading.
 * Putting a query here would make the counting untestable without a database, which is precisely
 * the property that lets the two bases be compared in a unit test.
 *
 * WHY THE COUNT IS DERIVED AND NEVER STORED
 * ----------------------------------------
 * §16.3 forbids a stored `durationDays`, and not as a performance preference: a stored duration is
 * a SECOND answer to "how many days is this request", computed once at write time from a
 * calendar that may since have been corrected. `DAY_COUNT` therefore derives the day count from
 * the stored inclusive `start_date`..`end_date` at evaluation time, so the count and the dates can
 * never disagree. This file performs that derivation and nothing else.
 *
 * DAY_COUNT IS INCLUSIVE, AND IT IS CALENDAR DAYS
 * ----------------------------------------------
 * A single-day request is 1, not 0: both endpoints count. The days are CALENDAR days — no working
 * calendar, no holiday subtraction, no weekend rule, no overlap merging. Each of those is a policy
 * this phase is not authorized to state (§16.8), and inventing one here would silently change
 * every stored maximum's meaning.
 */

/**
 * One stored leave request, reduced to the four facts counting needs.
 *
 * A NARROW STRUCTURAL TYPE RATHER THAN THE PRISMA ROW, so the assembly can be tested without a
 * database and so a future column cannot quietly become an input to a decision. `status` is the
 * declared vocabulary rather than a bare `string`, which is what makes the consumed-state filter
 * below a comparison the type system understands.
 */
export interface CountableLeaveRequest {
  readonly id: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly status: LeaveLimitConsumedState;
}

/**
 * WHY a limit could not be counted, as a machine code.
 *
 * A REFUSAL IS A VALUE, exactly as `LeaveLimitEnforceabilityRefusal` is, and for the same reason:
 * the caller needs a code and prose belongs at the edge. The grounds are kept SEPARATE from the
 * enforceability refusal's grounds rather than merged into one union, because they answer
 * different questions — "the policy names a state I cannot count" is a statement about the
 * AUTHORED configuration, while a malformed request row is a statement about the DATA. A UI that
 * renders one as the other would send an operator to edit the wrong thing.
 */
export type LeaveLimitCountingRefusal =
  /** A request row whose end precedes its start cannot be counted on any basis. */
  | 'REQUEST_WINDOW_INVERTED'
  /** The lifecycle has no member for this request's stored status. */
  | 'REQUEST_STATUS_NOT_IN_LIFECYCLE';

/**
 * The typed outcome of counting one limit: either the count, or WHY it could not be produced.
 *
 * A DISCRIMINATED UNION RATHER THAN A `number | null`, for the reason §6.4 gives everywhere else:
 * `null` collapses "counted zero" into "did not count", and those are different answers with
 * different consequences — a maximum of `0` is refused by the schema precisely because zero and
 * "unknown" must not be confusable. The engine receives grounds; this type is what HR builds them
 * from.
 *
 * `countedStates` reports WHICH states were actually summed, so a decision can be explained
 * without re-deriving the filter. It is not decoration: §16.4's whole point is that the author's
 * declared set is what governs, and a reviewer must be able to see that set as it was applied.
 */
export type LeaveLimitCountingOutcome =
  | {
      readonly counted: true;
      readonly countingBasis: LeaveLimitCountingBasis;
      readonly count: number;
      /** The declared states that this count summed, in the order the limit declared them. */
      readonly countedStates: readonly LeaveLimitConsumedState[];
      /** The requests that contributed to `count`, ordered by (startDate, id) for determinism. */
      readonly contributingRequestIds: readonly string[];
    }
  | {
      readonly counted: false;
      /**
       * WHICH family refused, stated in the type rather than inferred from the string. A counting
       * refusal comes from the stored DATA (a malformed row); an enforceability refusal comes from
       * the AUTHORED configuration (§16.4). They have different remedies, so a caller must be able
       * to branch on them — `isEnforceabilityRefusal` is that branch.
       */
      readonly refusal: LeaveLimitCountingRefusal | LeaveLimitEnforceabilityRefusal;
    };

/**
 * The inclusive calendar-day span of one request.
 *
 * BOTH ENDPOINTS COUNT (§16.3): a one-day request spans one day. `Math.round` rather than a
 * truncating division because the operands are two midnight-anchored `@db.Date` values whose
 * difference is an exact multiple of 86 400 000 ms; rounding removes any dependence on how the
 * driver materialized that midnight in the tenant's zone.
 *
 * `null` WHEN THE SPAN IS INVERTED, rather than a negative or a zero: an end before a start is
 * not a short request, it is a malformed one, and reporting it as `0` days would let it pass a
 * maximum unchallenged.
 */
export function inclusiveCalendarDays(startDate: Date, endDate: Date): number | null {
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  );
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());

  if (end < start) {
    return null;
  }

  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * A predicate: does this stored status appear in the declared set?
 *
 * PURE AND ORDER-PRESERVING ON THE DECLARED SIDE. The declared set governs (§16.4); the request
 * is asked whether it belongs. `includes` over a short array is deliberate — the sets here are
 * one or two members, and a `Set` allocation per request would buy nothing.
 */
export function isRequestCountedByStates(
  request: CountableLeaveRequest,
  consumedStates: readonly LeaveLimitConsumedState[]
): boolean {
  return consumedStates.includes(request.status);
}

/**
 * Count the requests an employee has that consume this limit, on the declared basis.
 *
 * THE ORDER OF THE TWO REFUSALS IS LOAD-BEARING. Enforceability is decided FIRST, from the
 * declared set alone, so a policy naming a state the lifecycle cannot reach is refused even when
 * the employee happens to have no matching rows at all. Deciding it after the filter would report
 * `0` for an uncountable policy whenever the data was empty — the silent substitution §16.7
 * forbids, arrived at by accident.
 *
 * `requests` ARE EXPECTED TO BE ALREADY SCOPED by the caller to the tenant, the employee, the
 * leave type and the resolved window. This function applies the CONSUMED-STATE filter and, on
 * `DAY_COUNT`, sums the derived spans; it does not re-apply a date window, because a second
 * window predicate here would be a second place for the window rule to live.
 *
 * A SINGLE MALFORMED REQUEST REFUSES THE WHOLE COUNT rather than being skipped. Skipping it would
 * under-count, and under-counting is an ALLOWANCE — the one direction of error a limit must never
 * make silently (§16.7).
 */
export function countLeaveLimitUsage(input: {
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly consumedStates: readonly LeaveLimitConsumedState[];
  readonly requests: readonly CountableLeaveRequest[];
}): LeaveLimitCountingOutcome {
  const enforceabilityRefusal = leaveLimitEnforceabilityRefusal(input.consumedStates);
  if (enforceabilityRefusal !== null) {
    return { counted: false, refusal: enforceabilityRefusal };
  }

  const qualifying = input.requests
    .filter((request) => isRequestCountedByStates(request, input.consumedStates))
    .slice()
    .sort((left, right) => {
      const byStart = left.startDate.getTime() - right.startDate.getTime();
      return byStart !== 0 ? byStart : left.id.localeCompare(right.id);
    });

  if (input.countingBasis === 'REQUEST_COUNT') {
    return {
      counted: true,
      countingBasis: 'REQUEST_COUNT',
      count: qualifying.length,
      countedStates: input.consumedStates,
      contributingRequestIds: qualifying.map((request) => request.id),
    };
  }

  let days = 0;
  const contributingRequestIds: string[] = [];

  for (const request of qualifying) {
    const span = inclusiveCalendarDays(request.startDate, request.endDate);
    if (span === null) {
      return { counted: false, refusal: 'REQUEST_WINDOW_INVERTED' };
    }

    days += span;
    contributingRequestIds.push(request.id);
  }

  return {
    counted: true,
    countingBasis: 'DAY_COUNT',
    count: days,
    countedStates: input.consumedStates,
    contributingRequestIds,
  };
}

/**
 * True when a refusal came from §16.4's authored configuration rather than from the stored data.
 *
 * WHY THE CALLER NEEDS TO KNOW, AND WHY IT IS A FUNCTION RATHER THAN A COMMENT. The two refusal
 * families have different remedies — one is fixed by editing the policy, the other by correcting
 * a row — so the API must be able to map them to different responses without inspecting strings at
 * the edge. Listing the enforceability refusals here means a member added to
 * `LeaveLimitEnforceabilityRefusal` in a future phase fails the assertion below at compile time
 * rather than falling through into the wrong family.
 */
const ENFORCEABILITY_REFUSALS: readonly LeaveLimitEnforceabilityRefusal[] = [
  'CONSUMED_STATES_EMPTY',
  'CONSUMED_STATE_NOT_IN_LIFECYCLE',
];

export function isEnforceabilityRefusal(
  refusal: LeaveLimitCountingRefusal | LeaveLimitEnforceabilityRefusal
): refusal is LeaveLimitEnforceabilityRefusal {
  return (ENFORCEABILITY_REFUSALS as readonly string[]).includes(refusal);
}
