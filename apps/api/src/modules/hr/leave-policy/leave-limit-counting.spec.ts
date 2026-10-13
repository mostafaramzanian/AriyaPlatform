import type { CountableLeaveRequest } from './leave-limit-counting';
import {
  countLeaveLimitUsage,
  inclusiveCalendarDays,
  isEnforceabilityRefusal,
  isRequestCountedByStates,
} from './leave-limit-counting';
import {
  LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES,
  type LeaveLimitConsumedState,
} from '../domain/leave-policy';

/**
 * Phase 54-D (§16.1, §16.3, §16.7) — the counting assembly's focused spec.
 *
 * The two bases are DIFFERENT SEMANTICS over the same stored number, so the assertions below are
 * written in pairs wherever possible: the same request set is counted both ways, and the two
 * answers are shown to differ. A spec that only checked one basis would pass even if the basis
 * were being ignored.
 */

function request(
  id: string,
  startDate: string,
  endDate: string,
  status: CountableLeaveRequest['status'] = 'PENDING'
): CountableLeaveRequest {
  return { id, startDate: new Date(startDate), endDate: new Date(endDate), status };
}

const APPROVED_AND_PENDING = ['APPROVED', 'PENDING'] as const;

/**
 * The states the CURRENT lifecycle can actually assemble — §16.4's enforceable subset.
 *
 * READ FROM THE DOMAIN RATHER THAN RETYPED, so this spec fails loudly if the derivation changes
 * instead of silently testing a stale set — which is exactly what happened in 54-E, where the
 * derivation widened to `['APPROVED', 'PENDING']` and the assertions below reported it.
 *
 * The arithmetic specs use THIS set: they are about REQUEST_COUNT/DAY_COUNT, and declaring a state
 * the lifecycle lacks would (correctly) refuse the count for the enforceability reason and mask the
 * arithmetic under test.
 */
const ENFORCEABLE_STATES = LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES;

describe('54-D — inclusive calendar days (§16.3)', () => {
  it('counts BOTH endpoints, so a single-day request spans one day, not zero', () => {
    expect(inclusiveCalendarDays(new Date('2026-03-21'), new Date('2026-03-21'))).toBe(1);
  });

  it('counts a two-day request as two, not as the one-day difference', () => {
    expect(inclusiveCalendarDays(new Date('2026-03-21'), new Date('2026-03-22'))).toBe(2);
  });

  it('spans a month boundary without reference to month length', () => {
    // 2026-03-30 .. 2026-04-02 inclusive is four days. A naive month-length rule gets this wrong.
    expect(inclusiveCalendarDays(new Date('2026-03-30'), new Date('2026-04-02'))).toBe(4);
  });

  it('spans a year boundary, including a Jalali new-year boundary', () => {
    expect(inclusiveCalendarDays(new Date('2026-03-20'), new Date('2026-03-22'))).toBe(3);
  });

  it('refuses an INVERTED span rather than reporting zero or a negative', () => {
    // Zero would let a malformed row pass a maximum unchallenged; negative would credit days.
    expect(inclusiveCalendarDays(new Date('2026-03-22'), new Date('2026-03-21'))).toBeNull();
  });

  it('is unmoved by a time-of-day component on either endpoint', () => {
    // The column is `@db.Date`; the assertion pins that the derivation reads the DAY, not the clock.
    expect(
      inclusiveCalendarDays(new Date('2026-03-21T23:59:59Z'), new Date('2026-03-22T00:00:01Z'))
    ).toBe(2);
  });
});

describe('54-D — REQUEST_COUNT counts REQUESTS, not days (§16.1)', () => {
  it('counts three requests as three, regardless of their length', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [
        request('a', '2026-03-21', '2026-03-21'),
        request('b', '2026-03-21', '2026-03-31'),
        request('c', '2026-04-01', '2026-04-30'),
      ],
    });

    expect(outcome).toMatchObject({ counted: true, countingBasis: 'REQUEST_COUNT', count: 3 });
  });

  it('is NOT the day total — the same set differs under the other basis', () => {
    // The pair that proves the basis is honoured rather than ignored.
    const requests = [
      request('a', '2026-03-21', '2026-03-23'),
      request('b', '2026-03-25', '2026-03-25'),
    ];
    const byRequest = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests,
    });
    const byDay = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests,
    });

    expect(byRequest).toMatchObject({ counted: true, count: 2 });
    expect(byDay).toMatchObject({ counted: true, count: 4 });
  });

  it('counts zero requests as zero — a real answer, distinct from a refusal', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [],
    });

    expect(outcome).toMatchObject({ counted: true, count: 0 });
    expect(outcome.counted).toBe(true);
  });

  it('returns the contributing request ids, ordered by start then id', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [
        request('z', '2026-04-01', '2026-04-01'),
        request('a', '2026-03-21', '2026-03-21'),
      ],
    });

    expect(outcome.counted && outcome.contributingRequestIds).toEqual(['a', 'z']);
  });
});

describe('54-D — DAY_COUNT counts inclusive CALENDAR days (§16.3)', () => {
  it('sums the spans of every qualifying request', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [
        request('a', '2026-03-21', '2026-03-22'),
        request('b', '2026-03-30', '2026-04-01'),
      ],
    });

    expect(outcome).toMatchObject({ counted: true, countingBasis: 'DAY_COUNT', count: 5 });
  });

  it('does NOT merge adjacent or overlapping requests — each contributes its own span', () => {
    // §16.8: overlap semantics are a policy this phase is not authorized to state. Two requests
    // over the same three days are six days here, not three.
    const outcome = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [
        request('a', '2026-03-21', '2026-03-23'),
        request('b', '2026-03-21', '2026-03-23'),
      ],
    });

    expect(outcome).toMatchObject({ counted: true, count: 6 });
  });

  it('subtracts no weekends and no holidays — these are CALENDAR days', () => {
    // 2026-03-20 is a Friday. A working-day rule would report 1; the contract says 3.
    const outcome = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [request('a', '2026-03-20', '2026-03-22')],
    });

    expect(outcome).toMatchObject({ counted: true, count: 3 });
  });

  it('REFUSES the whole count when any qualifying request has an inverted span', () => {
    // Skipping the bad row would under-count, and under-counting is an allowance.
    const outcome = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: ['PENDING'],
      requests: [
        request('ok', '2026-03-21', '2026-03-22'),
        request('bad', '2026-03-25', '2026-03-24'),
      ],
    });

    expect(outcome).toEqual({ counted: false, refusal: 'REQUEST_WINDOW_INVERTED' });
  });
});

describe('54-D — the declared CONSUMED STATES govern the count (§16.4)', () => {
  it('counts only the states the limit declared', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: ['PENDING'],
      requests: [
        request('a', '2026-03-21', '2026-03-21', 'PENDING'),
        request('b', '2026-03-22', '2026-03-22', 'CANCELLED' as never),
      ],
    });

    expect(outcome).toMatchObject({ counted: true, count: 1 });
    expect(outcome.counted && outcome.contributingRequestIds).toEqual(['a']);
  });

  it('reports WHICH states were summed, so a decision can be explained', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [...ENFORCEABLE_STATES],
      requests: [],
    });

    // WAS `['PENDING']` UNTIL 54-E. The set grew because the LIFECYCLE grew: `APPROVED` became
    // reachable, so it is now enforced as a consumed state and appears in the explanation. Reading
    // from the derivation rather than retyping is what made this test report the change instead of
    // silently passing over a stale expectation.
    expect(outcome.counted && outcome.countedStates).toEqual(['APPROVED', 'PENDING']);
  });

  it('keeps APPROVED in the authorable contract, now that the lifecycle reaches it', () => {
    // §39.10 — dropping APPROVED would be an unauthorized narrowing. 54-E made the retention
    // PAY OFF rather than merely correct: the state is not only authorable but countable.
    expect(APPROVED_AND_PENDING).toContain('APPROVED');
    expect(LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES).toContain('APPROVED');
  });

  it('derives the enforceable subset to exactly APPROVED + PENDING on this phase’s lifecycle', () => {
    expect([...LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES]).toEqual(['APPROVED', 'PENDING']);
  });

  it('COUNTS a declared set naming APPROVED, which 54-E made reachable', () => {
    // THIS TEST INVERTED IN 54-E. It previously asserted the count was REFUSED as
    // `CONSUMED_STATE_NOT_IN_LIFECYCLE`, because no flow could produce an approved request and a
    // count of them would have been a fabricated zero. Once decisions exist, the state is
    // assembleable from stored rows and refusing would be the wrong answer.
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: ['APPROVED', 'PENDING'],
      requests: [request('a', '2026-03-21', '2026-03-21', 'PENDING')],
    });

    expect(outcome).toMatchObject({ counted: true, count: 1 });
    expect(outcome.counted && outcome.countedStates).toEqual(['APPROVED', 'PENDING']);
  });

  it('refuses an EMPTY declared set first, and as its own distinct ground', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: [],
      requests: [],
    });

    expect(outcome).toEqual({ counted: false, refusal: 'CONSUMED_STATES_EMPTY' });
  });

  it('refuses a declared set naming a state the LIFECYCLE lacks — the silent-zero defect', () => {
    // If enforceability were decided after filtering, this would report a clean `0`.
    //
    // THE STATE IS `RETIRED` RATHER THAN `APPROVED` SINCE 54-E, and that substitution is the honest
    // one: `APPROVED` is now in the lifecycle, so using it here would assert a refusal the system
    // must NOT produce. The cast is required because the parameter is typed with the authorable
    // vocabulary, which 54-E made exactly equal to the enforceable subset — so no well-typed caller
    // can reach this branch. It is reached from STORED configuration, which is a row rather than a
    // TypeScript value, and simulating that row is what keeps this a live rule rather than dead code.
    const storedState = 'RETIRED' as unknown as LeaveLimitConsumedState;
    const outcome = countLeaveLimitUsage({
      countingBasis: 'DAY_COUNT',
      consumedStates: [storedState],
      requests: [],
    });

    expect(outcome).toEqual({ counted: false, refusal: 'CONSUMED_STATE_NOT_IN_LIFECYCLE' });
  });

  it('counts PENDING alone, the one population the lifecycle can assemble', () => {
    const outcome = countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: ['PENDING'],
      requests: [request('a', '2026-03-21', '2026-03-21', 'PENDING')],
    });

    expect(outcome).toMatchObject({ counted: true, count: 1 });
  });
});

describe('54-D — the refusal FAMILIES stay distinguishable at the edge', () => {
  it('classifies an authored-configuration refusal as an enforceability refusal', () => {
    expect(isEnforceabilityRefusal('CONSUMED_STATES_EMPTY')).toBe(true);
    expect(isEnforceabilityRefusal('CONSUMED_STATE_NOT_IN_LIFECYCLE')).toBe(true);
  });

  it('classifies a stored-data refusal as NOT an enforceability refusal', () => {
    // Different remedy: correct the row, not the policy.
    expect(isEnforceabilityRefusal('REQUEST_WINDOW_INVERTED')).toBe(false);
    expect(isEnforceabilityRefusal('REQUEST_STATUS_NOT_IN_LIFECYCLE')).toBe(false);
  });

  it('exposes the state predicate for callers assembling their own scoping', () => {
    expect(
      isRequestCountedByStates(request('a', '2026-03-21', '2026-03-21', 'PENDING'), ['PENDING'])
    ).toBe(true);
    expect(
      isRequestCountedByStates(request('a', '2026-03-21', '2026-03-21', 'PENDING'), ['APPROVED'])
    ).toBe(false);
  });
});

describe('54-D — the assembly is pure and deterministic', () => {
  it('returns the same outcome for the same input, always', () => {
    const input = {
      countingBasis: 'DAY_COUNT' as const,
      consumedStates: ['PENDING'] as const,
      requests: [request('a', '2026-03-21', '2026-03-23')],
    };

    expect(countLeaveLimitUsage(input)).toEqual(countLeaveLimitUsage(input));
  });

  it('does not mutate the caller’s request array', () => {
    const requests = [
      request('b', '2026-03-25', '2026-03-25'),
      request('a', '2026-03-21', '2026-03-21'),
    ];
    const before = requests.map((entry) => entry.id);

    countLeaveLimitUsage({
      countingBasis: 'REQUEST_COUNT',
      consumedStates: ['PENDING'],
      requests,
    });

    expect(requests.map((entry) => entry.id)).toEqual(before);
  });
});
