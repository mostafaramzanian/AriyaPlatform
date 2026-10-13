/**
 * Phase 54-G (§16, §16.3, §16.4, §16.6, §16.7, §21.7, D7, D11, D12): LEAVE LIMIT RUNTIME ENFORCEMENT
 * — the layer that turns a stored policy into a decision about ONE leave request that is being
 * created right now.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * -------------------------------------------------
 * It is the HR side of the §11 division of labour: "this phase CONFIGURES the rules and the engine
 * ENFORCES them". It is NOT a second evaluator. Every rule of counting already lives in
 * `leave-limit-counting.ts`, every rule of applicability already lives in `domain/leave-policy.ts`,
 * and the generic decision procedure already lives in `src/rules/`. What was missing is the piece
 * that OWNS THE ASSEMBLY: read the governing policy, gather the requests that could count, reduce
 * each limit to typed grounds, and hand them to the engine.
 *
 * SO THIS FILE CONTAINS NO RULE OF ITS OWN. It contains the wiring between three things that each
 * already know their own business, which is why it can be a pure function: the only thing it needs
 * from outside is the data the caller already had to read for its own reasons.
 *
 * WHY IT IS PURE, AND WHY THAT IS A REQUIREMENT RATHER THAN A STYLE
 * ----------------------------------------------------------------
 * The evaluation of a request must be REPRODUCIBLE — §23.5 asks a historical decision to explain
 * itself, and an explainer cannot re-run a function that reads a clock or a connection. So this
 * module takes facts and returns a verdict, and the caller performs the I/O. That also makes the
 * whole decision testable without a database, which is the only way the boundary cases (a limit
 * exactly at its maximum, a consumed state the lifecycle no longer contains) get tested at all.
 *
 * D12 IS HONOURED IN THE DIRECTION THAT MATTERS: the generic engine performs NO calendar
 * arithmetic, so all of it happens here — `inclusiveCalendarDays` for a request's span, and the
 * caller's already-resolved window bounds for a limit's period. The engine receives integers and
 * instants, never a Jalali year and never a timezone.
 */

import { countLeaveLimitUsage, type CountableLeaveRequest } from './leave-limit-counting';
import {
  isLeaveLimitApplicableToEmploymentType,
  type LeaveLimitConsumedState,
  type LeaveLimitCountingBasis,
  type LeaveLimitEmploymentType,
  type LeaveLimitEnforceabilityRefusal,
} from '../domain/leave-policy';

/**
 * The maximum number of stored requests one enforcement may read.
 *
 * WHY A BOUND EXISTS AT ALL (§34's bounded-query rule): an unbounded read on a request path is a
 * query whose cost grows with the tenant's history, which means the endpoint's latency grows with
 * data nobody is looking at. The window below is already narrow — one leave type, one tenant, one
 * limit period — so the bound is a backstop rather than a working limit.
 *
 * WHY EXCEEDING IT REFUSES RATHER THAN TRUNCATING: a truncated count is a WRONG count, and a wrong
 * count produces a wrong decision that is indistinguishable from a right one. §16.5's whole point is
 * that a limit must not be exceeded "because the check could not see"; refusing names the real
 * problem, while truncating would silently under-count and ALLOW a request that should be refused.
 */
export const MAX_COUNTED_LEAVE_REQUESTS = 5000;

/**
 * WHY a limit could not be reduced to grounds the engine can evaluate.
 *
 * A SEPARATE UNION FROM THE COUNTING AND ENFORCEABILITY REFUSALS, and kept separate on purpose: the
 * two inherited families answer "the configuration or the data is unusable", while these two answer
 * "the QUESTION this evaluation asked was not answerable". §16.6 is explicit that missing employment
 * context is refused as insufficient CONTEXT and never resolved by assuming a type — and a caller
 * that reported that as a malformed row would send an operator to inspect data that is fine.
 */
export type LeaveLimitEnforcementRefusal =
  /** §16.6: the limit is scoped and the evaluation has no employment type to match it against. */
  | 'EMPLOYMENT_CONTEXT_MISSING'
  /** §34: more requests matched than one evaluation may read, so the count cannot be trusted. */
  | 'REQUEST_COUNT_UNBOUNDED';

/**
 * One limit, reduced to the grounds a refusal is stated in, or the reason it could not be.
 *
 * THE GROUNDS ARE §16.7'S OWN (`limitRef`, `countingBasis`, `maximum`, `windowStart`, `windowEnd`)
 * — the same four facts `RuleLimitRefusalAction` declares, so the HR side never invents a
 * vocabulary the engine does not already speak and the engine never learns one it cannot.
 *
 * `counted` CARRIES THE COUNT AS WELL AS THE COMPARISON, because an explanation has to be able to
 * say "4 of 3" rather than "refused": a decision that cannot show its arithmetic is the kind §23.5
 * exists to prevent.
 */
export type LeaveLimitEvaluation =
  | {
      readonly refusable: true;
      readonly limitRef: string;
      readonly leaveTypeId: string;
      readonly employmentType: string | null;
      /** §16.3: the basis the limit declares, which is what makes "3 of 2" mean something. */
      readonly countingBasis: string;
      readonly maximum: number;
      readonly windowStart: Date;
      readonly windowEnd: Date;
      /** The produced count, for the explanation. */
      readonly count: number;
      readonly countedStates: readonly LeaveLimitConsumedState[];
      readonly contributingRequestIds: readonly string[];
      /** `count > maximum` — the refusal condition itself, computed once and named. */
      readonly exceeded: boolean;
    }
  | {
      readonly refusable: false;
      readonly limitRef: string;
      readonly leaveTypeId: string;
      readonly refusal:
        | LeaveLimitEnforcementRefusal
        | LeaveLimitEnforceabilityRefusal
        | 'REQUEST_WINDOW_INVERTED'
        | 'REQUEST_STATUS_NOT_IN_LIFECYCLE';
    }
  | {
      /**
       * §16.6: the limit is scoped to a DIFFERENT employment type, so it does not govern this request
       * at all. THIS IS A DECISION, NOT A REFUSAL, and it is a THIRD ARM rather than a `refusable:
       * false` with an empty `refusal` — collapsing it into either neighbour would corrupt the answer:
       *
       *   * Into the refusal arm, and a scoped limit authored for PERMANENT staff would refuse every
       *     CONTRACTOR request it was never meant to govern — the refusal vocabulary would report a
       *     configuration problem where the configuration is exactly right.
       *   * Into `refusable: true` with `maximum`/`window`, and the caller would compare a count
       *     against a limit that does not apply and refuse an entitled request.
       *
       * `applicable: false` IS THE ONLY FIELD, because it is the only thing this outcome knows: there
       * is nothing to count, nothing to compare, and no grounds to state.
       *
       * §16.6'S INSUFFICIENT-CONTEXT CASE IS DELIBERATELY NOT IN THIS ARM, although it looks like it
       * belongs here: a limit scoped to a type the evaluation cannot name is the OPPOSITE meaning —
       * "I cannot tell whether this limit governs you" rather than "this limit does not govern you".
       * The first is an entitlement being honoured, the second is a gap that must refuse, so the
       * function below separates them by testing the scope rule's THREE-VALUED result rather than the
       * truthiness of a match, and the refusal lands in the arm above, which is the only one carrying
       * a `refusal`.
       */
      readonly refusable: false;
      readonly applicable: false;
      readonly limitRef: string;
      readonly leaveTypeId: string;
    };

/**
 * One authored limit, reduced to the facts enforcement needs — NOT the stored row.
 *
 * A NARROW STRUCTURAL TYPE, for the reason `CountableLeaveRequest` is one: it keeps the declaration
 * free of the generated client, keeps a future column from quietly becoming an input to a decision,
 * and lets the whole evaluation be exercised without a database.
 *
 * `windowStart`/`windowEnd` ARRIVE ALREADY RESOLVED. §16.2 and D12 put calendar arithmetic on this
 * side of the boundary, and the caller resolves a period to days using the version's `jalaliYear`
 * through the module's one calendar entry point. This module therefore never sees a Jalali year and
 * never constructs a window — it receives the bounds the window rule already produced.
 */
export interface EvaluableLeaveLimit {
  readonly id: string;
  readonly leaveTypeId: string;
  /**
   * `null` MEANS UNSCOPED — it applies to every employment type (§16.6) — and the type is the
   * domain's closed vocabulary rather than `string`, because that is exactly what the column holds:
   * the migration constrains it to the enum, so a wider type here would only defer the check to a
   * runtime cast the scoping rule would then have to trust. A caller holding a stored row therefore
   * validates with `isLeaveLimitEmploymentType` at the boundary, which is the same shape the
   * repository's own limit mapping uses for `consumesStates`.
   */
  readonly employmentType: LeaveLimitEmploymentType | null;
  readonly maximum: number;
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly consumedStates: readonly LeaveLimitConsumedState[];
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/**
 * Evaluates ONE authored limit against the requests that could count towards it.
 *
 * THE ORDER OF THE THREE GATES IS THE WHOLE LOGIC, and each gate refuses rather than skips, because
 * every skip is an allowance in the direction a limit must never err (§16.7):
 *
 *   1. §16.6 EMPLOYMENT SCOPE. A limit scoped to a type the evaluation cannot name is refused as
 *      insufficient CONTEXT — never treated as "not applicable", which would let an unscoped gap in
 *      the caller's own data widen an entitlement. `isLeaveLimitApplicableToEmploymentType` answers
 *      the match, so the scope rule keeps its single definition.
 *   2. §16.4 ENFORCEABILITY. A limit whose declared consumed states cannot exist in the live
 *      lifecycle is refused rather than counted with a narrowed set: counting the states that
 *      happen to survive would silently grant what the author's set denies. The refusal code is the
 *      domain's own, obtained from `countLeaveLimitUsage`, which performs this check before counting.
 *   3. §34 BOUNDEDNESS. A window that matched more stored requests than one evaluation may read is
 *      refused, because a truncated count is a wrong count that looks like a right one.
 *
 * WHAT THE RETURNED `count` IS NOT: it is the count BEFORE the requested request is stored — this is
 * a PRE-CREATION check, and §16.7's "evaluated, never a stored counter" means the comparison happens
 * against the maximum as it stands. `exceeded` is `count > maximum`, computed once and named so the
 * caller compares a boolean rather than an inequality the explainer would have to re-derive.
 *
 * `maximum` IS AN INCLUDED CEILING: `count > maximum` refuses, so a count exactly equal to the
 * maximum is permitted. A limit of N means N, not N-1.
 */
export function evaluateLeaveLimit(input: {
  readonly limit: EvaluableLeaveLimit;
  /** The requests the caller read for this limit's window, tenant-scoped and already bounded. */
  readonly requests: readonly CountableLeaveRequest[];
  /**
   * §16.6: the employment type of the request's employee, or `null` when it is not known.
   *
   * THE CLOSED VOCABULARY RATHER THAN `string`, for the same reason `EvaluableLeaveLimit.employmentType`
   * is: this is the value the scope rule MATCHES against, and a `string` here would let an
   * unrecognized type reach `isLeaveLimitApplicableToEmploymentType` — which answers a refusal for
   * exactly that case, but only because a caller remembered to route an unvalidated value through it.
   * Bounding the type here makes the check structural. A caller holding a stored row validates with
   * `isLeaveLimitEmploymentType` first (the row's own column is migration-constrained to the same
   * set, so this is a check at a boundary the database already draws), and a caller that has no
   * employment type at all passes `null` — which is a KNOWN ABSENCE, not an unknown value, and the
   * domain distinguishes the two.
   */
  readonly employmentType: LeaveLimitEmploymentType | null;
}): LeaveLimitEvaluation {
  const { limit } = input;

  // Gate 1 — §16.6. The scope decision's ONE definition lives in the domain, and it is
  // THREE-VALUED: `true` governs, `false` does not, and a refusal string means applicability could
  // not be decided. Collapsing the third into either of the first two is the error the domain helper
  // exists to prevent, so it is handled as its own case rather than via a truthiness test.
  const scope = isLeaveLimitApplicableToEmploymentType(limit.employmentType, input.employmentType);

  if (typeof scope === 'string') {
    // A limit scoped to a type the evaluation cannot name, when it has no type to match against, is
    // INSUFFICIENT CONTEXT — refused rather than treated as "not applicable", which would let an
    // unscoped gap in the caller's own data widen an entitlement.
    //
    // IT RETURNS THE REFUSAL ARM, NOT THE `applicable: false` ARM, and that placement is the whole
    // point: the two outcomes are reachable from the same helper and mean opposite things. Reporting
    // this one as "not applicable" would make an indeterminate scope indistinguishable from a decided
    // non-match, and the caller would then honour an entitlement it cannot actually establish.
    return {
      refusable: false,
      limitRef: limit.id,
      leaveTypeId: limit.leaveTypeId,
      refusal: 'EMPLOYMENT_CONTEXT_MISSING',
    };
  }

  if (!scope) {
    // A scoped limit that genuinely does not match this employment type is simply not applicable —
    // a decision, not a refusal, so it is reported as non-refusable with `applicable: false` rather
    // than routed into the refusal vocabulary. `count: 0` against `maximum: 0` would be wrong, and
    // the caller distinguishes on the `applicable` flag the outcome carries.
    return {
      refusable: false,
      applicable: false,
      limitRef: limit.id,
      leaveTypeId: limit.leaveTypeId,
    };
  }

  // Gate 2 — §16.4/§16.7. The counting module performs the enforceability check itself and reports
  // the domain's own refusal code, so this does not restate which states are countable.
  const outcome = countLeaveLimitUsage({
    countingBasis: limit.countingBasis,
    consumedStates: limit.consumedStates,
    requests: input.requests,
  });

  if (!outcome.counted) {
    return {
      refusable: false,
      limitRef: limit.id,
      leaveTypeId: limit.leaveTypeId,
      refusal: outcome.refusal,
    };
  }

  // Gate 3 — §34. Checked AFTER counting so the refusal names the real problem (too much data to
  // trust) rather than a configuration error the caller does not have.
  if (outcome.count > MAX_COUNTED_LEAVE_REQUESTS) {
    return {
      refusable: false,
      limitRef: limit.id,
      leaveTypeId: limit.leaveTypeId,
      refusal: 'REQUEST_COUNT_UNBOUNDED',
    };
  }

  return {
    refusable: true,
    limitRef: limit.id,
    leaveTypeId: limit.leaveTypeId,
    employmentType: limit.employmentType,
    countingBasis: limit.countingBasis,
    maximum: limit.maximum,
    windowStart: limit.windowStart,
    windowEnd: limit.windowEnd,
    count: outcome.count,
    countedStates: outcome.countedStates,
    contributingRequestIds: outcome.contributingRequestIds,
    exceeded: outcome.count > limit.maximum,
  };
}
