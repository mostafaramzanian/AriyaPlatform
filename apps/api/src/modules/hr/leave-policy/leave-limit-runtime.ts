import type { HrActor } from '../hr-actor';
import type { ResolveEffectiveLeavePolicyQueryDto } from '../dto/leave-policy.dto';
import {
  evaluateLeaveLimit,
  type EvaluableLeaveLimit,
  type LeaveLimitEvaluation,
} from './leave-limit-enforcement';
import type { CountableLeaveRequest } from './leave-limit-counting';
import type {
  LeaveLimitCountingBasis,
  LeaveLimitConsumedState,
  LeaveLimitEmploymentType,
} from '../domain/leave-policy';

/**
 * Phase 54-G: the LEAVE REQUEST RUNTIME'S view of limit enforcement.
 *
 * WHERE THIS SITS, AND WHY IT IS NOT THE GENERIC ENGINE
 * -----------------------------------------------------
 * The generic Rule Engine (`apps/api/src/rules/`) is domain-agnostic: it never reads Prisma, never
 * reads a clock, never resolves a tenant, and never learns what a "leave limit" is. The HR side is
 * the opposite — it owns policy selection (§12), calendar resolution (§16.2), fact assembly, and the
 * interpretation of the engine's typed answer. This module is that HR side, stated as PORTS.
 *
 * IT IS DELIBERATELY PORT-SHAPED RATHER THAN NEST-SHAPED. `LeaveLimitRuntime` names the four things
 * the runtime needs — the 54-F governing-policy resolver, the countable-request read, the clock, and
 * the employment type of the requesting employee — and nothing else. That makes the enforcement
 * decision testable without a database, and it keeps the DECISION (which policy governs, which
 * limits apply, whether the count exceeds) in this file rather than in a SQL `WHERE` clause.
 *
 * WHAT THE CALLER MAY NOT CONTROL
 * -------------------------------
 * `tenantId` comes from the actor. `asOf` is the clock's answer for a NEW request, never a caller's.
 * `policyVersionId` is not a parameter anywhere: the version is resolved from the limits' own rows
 * (§12), so no request body can name the configuration that judges it. And there is no `force` /
 * `skipLimitCheck` / `overrideLimit` flag, because an enforcement rule with a bypass argument is an
 * enforcement rule with a documented defeat.
 */
export interface LeaveLimitRuntimePorts {
  /**
   * §12/§16: THE authoritative governing-policy resolver. Phase 54-F's `LeavePolicyService
   * .resolveEffective`, injected as a function so this module has no Nest dependency and cannot
   * acquire a second policy-selection path.
   */
  resolveEffective(
    actor: HrActor,
    query: ResolveEffectiveLeavePolicyQueryDto
  ): Promise<{
    /**
     * The governing version, or `null` when no published policy covers this leave type on this
     * day. THIS — not empty limit arrays — is what "no policy" means: a published version with no
     * limits for the day still governs (it just states no entitlement), and reading that as
     * "no policy" would let the request proceed as ungoverned when a policy is in force.
     */
    version: { readonly id: string } | null;
    limits: readonly StoredLimitRow[];
    undecidableLimits: readonly StoredLimitRow[];
  }>;

  /** §34: the tenant-scoped, window-scoped, state-narrowed countable requests for one limit. */
  findCountableRequests(
    tenantId: string,
    filter: {
      leaveTypeId: string;
      employeeId?: string;
      from: Date;
      to: Date;
      statuses: readonly LeaveLimitConsumedState[];
    }
  ): Promise<readonly CountableLeaveRequest[]>;

  /** The clock. Read HERE, once, so the decision has one instant and no layer below reads one. */
  now(): Date;
}

/**
 * The stored-limit shape the resolver returns, narrowed to what enforcement reads.
 *
 * `employmentType` is the closed vocabulary rather than `string` because the column is
 * migration-constrained to it, so the boundary check is structural rather than a cast trusted at
 * runtime — the same reasoning `EvaluableLeaveLimit` records.
 */
export interface StoredLimitRow {
  readonly id: string;
  /** The version the limit belongs to. Never a parameter of the evaluation — it is READ. */
  readonly policyVersionId: string;
  readonly leaveTypeId: string;
  readonly employmentType: LeaveLimitEmploymentType | null;
  readonly maximum: number;
  readonly countingBasis: LeaveLimitCountingBasis;
  /**
   * THE AUTHORED STATE SET. Spelled `consumesStates` because that is the STORED name
   * (`StoredLeaveLimit`), and a local rename to `consumedStates` would put two names on one
   * column — the second one only in this file, where nobody reads it.
   */
  readonly consumesStates: readonly LeaveLimitConsumedState[];
  /**
   * The inclusive window the limit's period RESOLVED to, read straight from the stored columns.
   *
   * NO CALENDAR ARITHMETIC HAPPENS HERE, and none may: §16.2 puts period-to-window resolution at
   * CONFIGURATION time, and 54-F already performed it through `resolveLeaveLimitWindow` before the
   * row was written. `StoredLeaveLimit` documents these two columns as "the authored window, as
   * stored — NOT re-derived here", so reading them is reading a resolved fact rather than
   * re-deriving one. A limit authored as a Jalali year therefore arrives with its Gregorian bounds
   * already computed, and this module never asks which period kind produced them.
   */
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/**
 * What the request path is told.
 *
 * THREE OUTCOMES, BECAUSE §16.7 MAKES THREE ANSWERS POSSIBLE and collapsing them corrupts one:
 *
 *   * `GOVERNED` — a policy governs and it was evaluated. `refusals` carries the limits the request
 *     would exceed (empty means the request is permitted), and `undecidable` carries the limits that
 *     could not be judged because the context was insufficient. §16.7's refusal is a DECISION, so a
 *     permitted request and a refused one are the same kind of answer with different contents.
 *   * `UNPOLICED` — §16.7/§21.7: no published policy covers this leave type on this day. The request
 *     is NOT auto-approved and NOT auto-rejected; it proceeds without an entitlement decision, which
 *     is what "no policy has been stated" renders as.
 */
export type LeaveLimitRuntimeOutcome =
  | {
      readonly governed: true;
      /** The limits the request would exceed — non-empty means REFUSE. */
      readonly refusals: readonly LeaveLimitEvaluation[];
      /** §16.6: limits the context could not decide. Non-empty means REFUSE, not "not applicable". */
      readonly undecidable: readonly LeaveLimitEvaluation[];
      /** Every limit evaluated, for the explanation (§23.5 "4 of 3" rather than "refused"). */
      readonly evaluated: readonly LeaveLimitEvaluation[];
      readonly policyVersionId: string | null;
      readonly asOf: Date;
    }
  | {
      readonly governed: false;
      readonly reason: 'NO_GOVERNING_POLICY';
      readonly asOf: Date;
    };

/**
 * Evaluates one submitted request against the governance in force for its day.
 *
 * THE SEQUENCE IS §16's, IN ORDER, AND EACH STEP REFUSES RATHER THAN DEFAULTS:
 *
 *   1. ASK THE GOVERNING POLICY. §12 makes `resolveEffective` the ONE answer to "what governs this
 *      leave type on this day" — this module does not call a repository query of its own, because a
 *      second selection path is a second answer that could disagree with it.
 *   2. IF NOTHING GOVERNS, SAY SO. `governed: false` travels to the caller, which proceeds WITHOUT
 *      an entitlement decision: §16.7/§21.7 render "no policy has been stated" as exactly that and
 *      forbid inventing a default in either direction.
 *   3. DECIDE THE UNDECIDABLE FIRST. §16.6's insufficient-context limits are reported as refusals
 *      rather than dropped, because dropping them would turn "the context cannot answer this" into
 *      "no limit governs you" — an entitlement nobody stated.
 *   4. THEN COUNT AND COMPARE, one limit at a time, over the requests the limit's OWN window
 *      matches. The window is the limit's stored `windowStart`/`windowEnd`, resolved when the policy
 *      was authored; this module does no calendar arithmetic and the engine does none either.
 *
 * `employmentType` IS REQUIRED AS A PARAMETER, `null` INCLUDED. `null` means "the request's employee
 * has no employment type recorded", which is a §16.6 insufficient-context case for a scoped limit and
 * is NOT the same as omitting the argument — a defaulted parameter would make the two indistinguishable
 * and would silently widen an entitlement.
 *
 * `maximum` IS AN INCLUDED CEILING (`count > maximum` refuses), and the comparison is made inside
 * `evaluateLeaveLimit` so the boundary has one definition.
 */
export async function evaluateLeaveRequestAgainstLimits(
  ports: LeaveLimitRuntimePorts,
  input: {
    readonly actor: HrActor;
    readonly leaveTypeId: string;
    readonly employeeId: string;
    /** §16.6: the employment type of the request's employee, or `null` when it is not recorded. */
    readonly employmentType: LeaveLimitEmploymentType | null;
  }
): Promise<LeaveLimitRuntimeOutcome> {
  // One instant for the whole decision, read here so nothing below reads a clock and so the
  // countable-request windows and the governing-policy date cannot drift apart mid-evaluation.
  const asOf = ports.now();

  const resolution = await ports.resolveEffective(input.actor, {
    // The DAY is the question and the clock answers it. A caller-supplied `asOf` would let a request
    // be judged against a policy that does not govern the day it is actually for.
    asOf: toStoredDay(asOf),
    leaveTypeId: input.leaveTypeId,
    ...(input.employmentType === null ? {} : { employmentType: input.employmentType }),
  });

  // §16.7/§21.7: an ungoverned request is neither approved nor rejected — it proceeds with no
  // entitlement decision, and the caller records that fact rather than a fabricated verdict.
  //
  // THE TEST IS `version === null`, NOT EMPTY LIMITS, because those are different answers: a
  // published version that covers this day but authored no limit for it still GOVERNS — it simply
  // states no entitlement — and reporting it as "no policy" would let the request proceed as
  // ungoverned when a policy is in force. Only the resolver's own "nothing covers this day"
  // answer (`version: null`) is "no policy has been stated".
  if (resolution.version === null) {
    return { governed: false, reason: 'NO_GOVERNING_POLICY', asOf };
  }

  const evaluated: LeaveLimitEvaluation[] = [];
  const refusals: LeaveLimitEvaluation[] = [];
  const undecidable: LeaveLimitEvaluation[] = [];

  // §16.6 FIRST, for the limits the resolver could not scope. They are evaluated with an empty
  // request set so they produce the CONTEXT refusal rather than a count nobody can interpret.
  for (const limit of resolution.undecidableLimits) {
    const outcome = evaluateLeaveLimit({
      limit: toEvaluable(limit),
      requests: [],
      employmentType: input.employmentType,
    });

    evaluated.push(outcome);
    undecidable.push(outcome);
  }

  for (const limit of resolution.limits) {
    // A limit whose states cannot exist in the live lifecycle is refused by `evaluateLeaveLimit`
    // BEFORE it reads anything, which is why this asks for the count unconditionally rather than
    // pre-filtering: the refusal is the answer, and a pre-filter would have to re-derive it here.
    const requests = await ports.findCountableRequests(input.actor.tenantId, {
      leaveTypeId: limit.leaveTypeId,
      employeeId: input.employeeId,
      from: limit.windowStart,
      to: limit.windowEnd,
      statuses: limit.consumesStates,
    });

    const outcome = evaluateLeaveLimit({
      limit: toEvaluable(limit),
      requests,
      employmentType: input.employmentType,
    });

    evaluated.push(outcome);

    // THE `applicable: false` ARM IS CHECKED FIRST, before the refusal test — the two are both
    // `refusable: false` and sorting them the other way would file a limit scoped to a DIFFERENT
    // employment type as "undecidable", which the caller refuses on. That arm is a DECISION (the
    // limit does not govern this request), not a gap in the context, so it is skipped: there is
    // nothing to count and nothing to compare.
    if ('applicable' in outcome && outcome.applicable === false) continue;

    // A remaining `refusable: false` is a genuine refusal — the configuration or the context could
    // not be counted — and it is reported in `undecidable` rather than silently treated as
    // satisfied.
    if (!outcome.refusable) {
      undecidable.push(outcome);
      continue;
    }

    // `refusable: true` and not exceeded: permitted. `exceeded` is the refusal condition itself,
    // computed once in `evaluateLeaveLimit`.
    if (!outcome.exceeded) continue;

    refusals.push(outcome);
  }

  return {
    governed: true,
    refusals,
    undecidable,
    evaluated,
    // From the version the resolver named, not from a limit row: a governing version with no
    // limits for the day still governs, and `limits[0]` would report `null` for it.
    policyVersionId: resolution.version.id,
    asOf,
  };
}

/**
 * The stored row, narrowed to the fields the evaluator reads.
 *
 * A NAMED FUNCTION RATHER THAN AN INLINE OBJECT, so the narrowing has ONE definition: the evaluator
 * takes `EvaluableLeaveLimit`, the resolver returns the full stored row, and the difference is
 * exactly the fields enforcement does not read (`policyId`, `createdAt`, …). Widening
 * `EvaluableLeaveLimit` to the stored row instead would let persistence fields reach the evaluator.
 */
function toEvaluable(limit: StoredLimitRow): EvaluableLeaveLimit {
  return {
    id: limit.id,
    leaveTypeId: limit.leaveTypeId,
    employmentType: limit.employmentType,
    maximum: limit.maximum,
    countingBasis: limit.countingBasis,
    consumedStates: limit.consumesStates,
    windowStart: limit.windowStart,
    windowEnd: limit.windowEnd,
  };
}

/**
 * §15.4: the DAY a stored `@db.Date` column holds, taken from an instant without timezone drift.
 *
 * `toISOString().slice(0, 10)` would move a local midnight to the previous day west of UTC, which
 * for this decision would judge a request against the wrong policy. The UTC fields are used because
 * the column is a DATE — a calendar day, not an instant — so the UTC day IS the stored day.
 */
function toStoredDay(instant: Date): string {
  const year = instant.getUTCFullYear();
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const day = String(instant.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
