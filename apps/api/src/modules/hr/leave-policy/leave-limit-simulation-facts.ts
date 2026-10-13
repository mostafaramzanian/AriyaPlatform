import type {
  RuleFieldCatalogue,
  RuleCollectionFieldDeclaration,
} from '../../../rules/rule-condition.interface';
import { RULE_LIMITS } from '../../../rules/core/rule-limits';
import type { RuleFactValue } from '../../../rules/rule.types';
import { LEAVE_LIMIT_CONSUMED_STATES, LEAVE_LIMIT_EMPLOYMENT_TYPES } from '../domain/leave-policy';
import type { LeaveLimitCountingBasis } from '../domain/leave-policy';
import { inclusiveCalendarDays, type CountableLeaveRequest } from './leave-limit-counting';

/**
 * Phase 54-H (§14, §16.3, §16.7, D7, D12): the HR-OWNED typed fact catalogue and the collection
 * projections the leave-limit simulation supplies to the generic Rule Engine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * §14 says a simulation runs "the real engine over a supplied context". Supplying that context needs
 * two things HR has and the engine must never learn: a declaration of which facts a leave-limit
 * question is composed of, and the assembly of those facts from stored rows. Both live here, on the
 * HR side of the boundary, because §8.3 makes the catalogue the CONSUMING DOMAIN's property —
 * "owned by the consuming domain and supplied to the engine as data. The engine never learns where
 * it came from and never queries for it".
 *
 * THE COUNTING BASIS IS CARRIED BY THE COLLECTION IDENTITY, NOT BY A NEW OPERATOR
 * -------------------------------------------------------------------------------
 * This is the decision that lets `DAY_COUNT` stay correct without teaching the engine anything:
 *
 *     REQUEST_COUNT → count over `leaveRequestsInWindow` → cardinality of qualifying requests
 *     DAY_COUNT     → count over `leaveDaysInWindow`     → cardinality of covered calendar days
 *
 * `leaveDaysInWindow` DOES NOT CLAIM THE ENGINE UNDERSTANDS A DAY. It is a projection of an
 * arithmetic fact HR already computed: one record per calendar day, produced by HR's EXISTING
 * `inclusiveCalendarDays` (§16.3). The engine counts records — the only thing its frozen `count`
 * node does (§8.4) — and that record COUNT is the day count because HR built the collection that
 * way. §16.3's "derived at evaluation from the stored start_date / end_date range of each counted
 * request — never a stored duration column" is honoured exactly: the derivation happens here, at
 * evaluation time, and no `durationDays` is invented or stored.
 *
 * WHY THE ENGINE NEEDS NO NEW OPERATOR (§16.1, D7)
 * -----------------------------------------------
 * `RuleCountOperator` is deliberately only `greaterThan | greaterThanOrEqual | lessThan |
 * lessThanOrEqual`. A counting BASIS is not an ordering, so encoding it as one would be a category
 * error — "3 requests" and "3 days" are not two spellings of one number. Modelling them as two
 * collections keeps the basis in the STRUCTURE of the question, where §16.1 says it belongs, and
 * leaves the comparison operator doing only what it is for.
 *
 * THE COLLECTIONS ARRIVE ALREADY FILTERED, SO THE ENGINE RE-APPLIES NO HR SEMANTICS
 * -------------------------------------------------------------------------------
 * Every projection below is built from rows the caller already narrowed by tenant, leave type,
 * employee and the limit's resolved window, and each item is filtered by the limit's own
 * `consumesStates` through HR's single consumed-state rule (§16.4). The engine therefore never
 * learns what a leave type, a tenant or a consumed state is; it counts records a projection handed
 * it and compares the cardinality against the configured maximum.
 */

/**
 * The declared fact name for `REQUEST_COUNT`'s countable collection.
 *
 * ONE MEMBER PER QUALIFYING LEAVE REQUEST. The name states the unit, so a rule that counts it cannot
 * be misread as counting days.
 */
export const LEAVE_REQUEST_WINDOW_COLLECTION = 'leaveRequestsInWindow';

/**
 * The declared fact name for `DAY_COUNT`'s countable collection.
 *
 * ONE MEMBER PER CALENDAR DAY COVERED BY EACH QUALIFYING REQUEST — not per request, and not
 * deduplicated. §16.3 counts calendar days per counted request, so two overlapping requests for the
 * same day contribute 2. Merging would silently rewrite every stored maximum's meaning, which is why
 * the projection below does not merge and this comment says so where the decision lives.
 */
export const LEAVE_DAY_WINDOW_COLLECTION = 'leaveDaysInWindow';

/**
 * The scalar facts a leave-limit simulation context may carry.
 *
 * EACH ONE IS EITHER THE LIMIT'S OWN AUTHORED CONFIGURATION OR THE QUESTION'S OWN COORDINATES, and
 * every one of them is already a §16 field — nothing here is minted for simulation. The list is
 * deliberately closed and short: §39/§40 forbid monetary limits, accrual, carry-over and
 * working-day arithmetic, so no fact for any of those exists to be declared.
 *
 * THERE IS NO TENANT FACT, AND THAT IS A §24.5 REQUIREMENT RATHER THAN AN OMISSION. The engine "is
 * tenant-agnostic and therefore never tenant-authoritative … its result carries no tenant field".
 * Tenancy is what the CALLER filtered the collections by, before handing them over.
 */
export const LEAVE_LIMIT_SIMULATION_SCALARS = Object.freeze([
  /** The leave type the question is about. */
  { name: 'leaveTypeId', type: 'string' },
  /**
   * §16.6's employment scope of the QUESTION's employee. Absent means "cannot be stated for this
   * range", which is insufficient context that a scoped limit must refuse rather than assume.
   */
  { name: 'employmentType', type: 'enum', enumValues: [...LEAVE_LIMIT_EMPLOYMENT_TYPES] },
  /** The requested range's inclusive first and last calendar day. */
  { name: 'requestedFrom', type: 'date' },
  { name: 'requestedTo', type: 'date' },
  /** §16.1: the limit's declared basis, mandatory wherever a count is meaningful (D7). */
  { name: 'countingBasis', type: 'enum', enumValues: ['REQUEST_COUNT', 'DAY_COUNT'] },
  /** §16.1: the limit's declared maximum, integer > 0. */
  { name: 'maximum', type: 'number' },
  /** §16.2: the limit's RESOLVED window, as two inclusive calendar days. */
  { name: 'windowStart', type: 'date' },
  { name: 'windowEnd', type: 'date' },
] as const);

/**
 * WHY THERE IS NO `consumesStates` SCALAR FACT, AND WHY THAT IS NOT A LOSS
 * ----------------------------------------------------------------------
 * §16.4's consumed-state set is the one §16 field that does NOT become scalar fact, and the reason is
 * a fact about the engine's type system rather than a simplification: `RuleFactValue` is
 * `RuleFactScalar | null | readonly RuleFactRecord[]` (`rule.types.ts`), so a bare `string[]` is not
 * a fact value at all — an array is only ever a COLLECTION of records, which is precisely the
 * distinction §8.4 draws between "a list to count" and "a value to compare".
 *
 * The set is nonetheless fully expressed, twice over, and both places are authoritative:
 *
 *   * the rule's `where` clause carries the states as an `in` operand, so the match history records
 *     WHICH states were counted (§13.1) — that operand is where the authored set belongs, because
 *     §16.4 makes it a property of the LIMIT's own definition rather than a fact about the request;
 *   * `RuleLimitRefusalAction.countingBasis`/`maximum` already travel in the action, so a refusal
 *     states its grounds without needing the set on the context.
 *
 * An EMPTY set stays expressible as well: §8.3 makes an absent fact empty, so `isEmpty` still answers
 * about a limit that declared no states. Declaring a redundant scalar here would have forced the
 * value into a shape the engine cannot receive, which is why it is omitted rather than reshaped.
 */

/**
 * The item vocabulary both collections share.
 *
 * `leaveTypeId` and `status` are the facts a per-item `where` needs so an explanation can state
 * "only this leave type, only these states" (§13, §23.5).
 *
 * `day` IS THE ONE FIELD THE DAY COLLECTION ADDS, and it is the projection's own marker that this
 * member is a calendar day rather than a request. It is a `date` — a `YYYY-MM-DD` string — so the
 * engine can order or compare it without ever performing calendar arithmetic of its own (D12).
 */
const COLLECTION_ITEM_FIELDS = Object.freeze([
  { name: 'leaveTypeId', type: 'string' },
  { name: 'status', type: 'enum', enumValues: [...LEAVE_LIMIT_CONSUMED_STATES] },
] as const);

/**
 * The catalogue handed to the engine for a leave-limit simulation (§8.3).
 *
 * BOTH COLLECTIONS ARE DECLARED ON EVERY CONTEXT, even when the limit being simulated uses only one
 * of the bases. A catalogue that varied with the configuration would make a rule's admissibility a
 * function of which version was selected, which is the "two answers can disagree" failure this
 * module's single-source rules exist to prevent. Declaring both is also what lets ONE catalogue serve
 * a whole policy version carrying limits on either basis.
 *
 * `maxSize` IS `RULE_LIMITS.maxCountCollectionSize`, the engine's own bound, rather than a number
 * invented here: §8.4 makes exceeding it a context error (never a silent truncation), and the caller
 * refuses on the same constant — `MAX_COUNTED_LEAVE_REQUESTS` — before it assembles anything.
 */
export const LEAVE_LIMIT_SIMULATION_CATALOGUE: RuleFieldCatalogue = Object.freeze([
  ...LEAVE_LIMIT_SIMULATION_SCALARS,
  Object.freeze({
    name: LEAVE_REQUEST_WINDOW_COLLECTION,
    type: 'collection',
    maxSize: RULE_LIMITS.maxCountCollectionSize,
    itemFields: COLLECTION_ITEM_FIELDS,
  }) satisfies RuleCollectionFieldDeclaration,
  Object.freeze({
    name: LEAVE_DAY_WINDOW_COLLECTION,
    type: 'collection',
    maxSize: RULE_LIMITS.maxCountCollectionSize,
    itemFields: Object.freeze([...COLLECTION_ITEM_FIELDS, { name: 'day', type: 'date' }] as const),
  }) satisfies RuleCollectionFieldDeclaration,
] as const);

/** The collection a counting basis counts over. The basis → collection map, in one place. */
export function simulationCollectionFor(basis: LeaveLimitCountingBasis): string {
  return basis === 'REQUEST_COUNT' ? LEAVE_REQUEST_WINDOW_COLLECTION : LEAVE_DAY_WINDOW_COLLECTION;
}

/**
 * The scalar half of a simulation context, read off the limit and the question.
 *
 * `employmentType` IS ABSENT RATHER THAN `null`-VALUED WHEN IT CANNOT BE STATED, and that is a
 * deliberate §16.6 choice: §8.3 makes a missing fact distinct from a stated one — "a missing fact is
 * never silently satisfying, and it is also never silently disqualifying" — so the engine reports it
 * in `missingFields` and a rule that needs it is `UNKNOWN` rather than decided-false. Writing `null`
 * for "we could not tell" and `null` for "there is no type" would be different sentences, and the
 * engine reserves `null` for the second.
 */
export function leaveLimitSimulationScalars(input: {
  readonly leaveTypeId: string;
  readonly employmentType: string | null;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly maximum: number;
  readonly windowStart: string;
  readonly windowEnd: string;
}): Readonly<Record<string, RuleFactValue>> {
  return {
    leaveTypeId: input.leaveTypeId,
    // Absent when unstateable; see the doc above.
    ...(input.employmentType === null ? {} : { employmentType: input.employmentType }),
    requestedFrom: input.requestedFrom,
    requestedTo: input.requestedTo,
    countingBasis: input.countingBasis,
    maximum: input.maximum,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  };
}

/** A stored `@db.Date` column as the inclusive calendar day it holds (no timezone drift). */
export function toSimulationDay(instant: Date): string {
  const year = instant.getUTCFullYear();
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const day = String(instant.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `REQUEST_COUNT`'s collection: one record per qualifying request.
 *
 * EMPTY WHEN THE BASIS IS NOT `REQUEST_COUNT`, because the other collection is the one that answers
 * the question — declaring an unused collection empty is honest rather than a truncation. The engine
 * only ever counts the collection a `count.over` names.
 *
 * THE REQUEST IDS ARE NOT PROJECTED. A request id is internal HR data (§24.6: "an employee's view can
 * only ever render their own request"), and §13.3 keeps rule internals out of the lower evidence
 * levels, so a context carrying them would place an identifier in a structure the engine hands back
 * verbatim. What an explanation needs — how many, which leave type, which state — is what is
 * declared.
 */
export function leaveRequestWindowProjection(input: {
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly leaveTypeId: string;
  readonly consumedStates: readonly string[];
  readonly requests: readonly CountableLeaveRequest[];
}): readonly Readonly<Record<string, RuleFactValue>>[] {
  if (input.countingBasis !== 'REQUEST_COUNT') return [];

  return input.requests
    .filter((request) => input.consumedStates.includes(request.status))
    .map((request) => ({
      leaveTypeId: input.leaveTypeId,
      status: request.status,
    }));
}

/**
 * `DAY_COUNT`'s collection: one record per CALENDAR DAY covered by each qualifying request.
 *
 * THE ARITHMETIC IS HR'S EXISTING ONE. `inclusiveCalendarDays` is imported from
 * `leave-limit-counting.ts` — the module §16.3 already designates as the single home of that
 * derivation — so the simulation and the request path cannot disagree about what a day is. A second
 * `end - start + 1` written here would be precisely that second answer.
 *
 * ONE ENTRY PER DAY PER REQUEST, INCLUSIVE OF BOTH ENDPOINTS, WITH NO DEDUPLICATION. A one-day
 * request contributes one record; a three-day request contributes three. Two requests covering the
 * same day contribute two, because §16.3 sums each counted request's own span. Merging or de-duping
 * would under-count, and under-counting is an ALLOWANCE — the one direction §16.7 forbids.
 *
 * A MALFORMED ROW (an inverted range) CONTRIBUTES NOTHING RATHER THAN THROWING, because the caller
 * has already asked `countLeaveLimitUsage` — the authority on malformed rows — and refused on it
 * before reaching here. Manufacturing a second refusal for the same row would report one data defect
 * twice, in two vocabularies.
 */
export function leaveDayWindowProjection(input: {
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly leaveTypeId: string;
  readonly consumedStates: readonly string[];
  readonly requests: readonly CountableLeaveRequest[];
}): readonly Readonly<Record<string, RuleFactValue>>[] {
  if (input.countingBasis !== 'DAY_COUNT') return [];

  const days: Record<string, RuleFactValue>[] = [];

  for (const request of input.requests) {
    if (!input.consumedStates.includes(request.status)) continue;

    const span = inclusiveCalendarDays(request.startDate, request.endDate);
    if (span === null) continue;

    for (let offset = 0; offset < span; offset += 1) {
      const day = new Date(request.startDate.getTime());
      day.setUTCDate(day.getUTCDate() + offset);

      days.push({
        leaveTypeId: input.leaveTypeId,
        status: request.status,
        day: toSimulationDay(day),
      });
    }
  }

  return days;
}
