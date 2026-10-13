import {
  evaluateLeaveLimit,
  MAX_COUNTED_LEAVE_REQUESTS,
  type EvaluableLeaveLimit,
} from './leave-limit-enforcement';
import type { CountableLeaveRequest } from './leave-limit-counting';
import {
  LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES,
  type LeaveLimitConsumedState,
} from '../domain/leave-policy';

/**
 * Phase 54-G (§16.4, §16.6, §16.7, §34) — the THREE-GATE evaluator's focused spec.
 *
 * `evaluateLeaveLimit` is where a stored limit becomes a decision, and the ORDER of its gates is
 * the whole logic: employment scope, then enforceability, then boundedness, then the arithmetic.
 * Each assertion below is written to fail if a gate is SKIPPED or REORDERED, because every gate
 * refuses rather than skips and a skipped gate is an allowance in the direction a limit must never
 * err (§16.7).
 *
 * The three arms of the outcome are kept APART in the assertions: a refusal carries a `refusal`
 * code, a non-applicable limit carries `applicable: false`, and a judged limit carries `exceeded`.
 * Collapsing any two would make the caller (the runtime, and then the request path) act on the
 * wrong meaning — the exact corruption the three-arm type exists to prevent.
 */

/** The enforceable states, read from the domain so this spec tracks the live lifecycle. */
const ENFORCEABLE_STATES = LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES;

const WINDOW_START = new Date('2026-03-21T00:00:00.000Z');
const WINDOW_END = new Date('2027-03-20T00:00:00.000Z');

function limit(overrides: Partial<EvaluableLeaveLimit> = {}): EvaluableLeaveLimit {
  return {
    id: 'limit-1',
    leaveTypeId: 'type-annual',
    employmentType: null,
    maximum: 3,
    countingBasis: 'REQUEST_COUNT',
    consumedStates: ENFORCEABLE_STATES,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

function request(
  id: string,
  startDate: string,
  endDate: string,
  status: LeaveLimitConsumedState = 'APPROVED'
): CountableLeaveRequest {
  return { id, startDate: new Date(startDate), endDate: new Date(endDate), status };
}

/** The typical case: three APPROVED requests already inside the window, maximum three. */
const THREE_APPROVED = [
  request('r1', '2026-04-01', '2026-04-03'),
  request('r2', '2026-05-01', '2026-05-02'),
  request('r3', '2026-06-10', '2026-06-14'),
];

describe('54-G — employment scope gate (§16.6)', () => {
  it('refuses as EMPLOYMENT_CONTEXT_MISSING when the limit is scoped and no type can be stated', () => {
    // The THREE-VALUED scope rule returns a refusal string here, and it must land in the refusal
    // arm — NOT in `applicable: false`, which would read as "this limit does not govern you" and
    // silently widen the entitlement the scope was authored to protect.
    const outcome = evaluateLeaveLimit({
      limit: limit({ employmentType: 'FULL_TIME' }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(false);
    expect('refusal' in outcome && outcome.refusal).toBe('EMPLOYMENT_CONTEXT_MISSING');
    // It must NOT be filed as the "not applicable" decision.
    expect('applicable' in outcome).toBe(false);
  });

  it('is NOT applicable (a decision, not a refusal) when the limit is scoped to another type', () => {
    const outcome = evaluateLeaveLimit({
      limit: limit({ employmentType: 'FULL_TIME' }),
      requests: THREE_APPROVED,
      employmentType: 'CONTRACT',
    });

    expect(outcome.refusable).toBe(false);
    expect('applicable' in outcome && outcome.applicable).toBe(false);
    // A not-applicable limit carries no refusal code — that would misreport correct configuration.
    expect('refusal' in outcome).toBe(false);
  });

  it('applies an unscoped limit to every employment type, including none', () => {
    const unscoped = evaluateLeaveLimit({
      limit: limit({ employmentType: null }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(unscoped.refusable).toBe(true);
    expect('exceeded' in unscoped && unscoped.exceeded).toBe(false);
  });

  it('applies a scoped limit when the stated type matches', () => {
    const outcome = evaluateLeaveLimit({
      limit: limit({ employmentType: 'FULL_TIME' }),
      requests: THREE_APPROVED,
      employmentType: 'FULL_TIME',
    });

    expect(outcome.refusable).toBe(true);
    expect('exceeded' in outcome && outcome.exceeded).toBe(false);
  });
});

describe('54-G — enforceability gate (§16.4)', () => {
  it('refuses rather than counting a state set the live lifecycle cannot produce', () => {
    // A configured consumed state that is not in the CURRENT lifecycle (the domain's derivation)
    // is refused with the domain's own code — the set is never silently narrowed to the members
    // that happen to survive, because narrowing would grant what the author's set denies.
    const outcome = evaluateLeaveLimit({
      limit: limit({ consumedStates: ['ARCHIVED'] as unknown as LeaveLimitConsumedState[] }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(false);
    expect('refusal' in outcome && outcome.refusal).toBe('CONSUMED_STATE_NOT_IN_LIFECYCLE');
  });

  it('refuses an EMPTY consumed-state set (§16.4: required, never defaulted)', () => {
    const outcome = evaluateLeaveLimit({
      limit: limit({ consumedStates: [] }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(false);
    expect('refusal' in outcome && outcome.refusal).toBe('CONSUMED_STATES_EMPTY');
  });
});

describe('54-G — boundedness gate (§34)', () => {
  it('refuses a count larger than one evaluation may read, rather than truncating it', () => {
    const many = Array.from({ length: MAX_COUNTED_LEAVE_REQUESTS + 1 }, (_, i) =>
      request(`r${i}`, '2026-04-01', '2026-04-03')
    );

    const outcome = evaluateLeaveLimit({
      limit: limit({ maximum: MAX_COUNTED_LEAVE_REQUESTS + 2 }),
      requests: many,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(false);
    expect('refusal' in outcome && outcome.refusal).toBe('REQUEST_COUNT_UNBOUNDED');
  });
});

describe('54-G — the arithmetic and its boundary (§16.3, §16.7)', () => {
  it('permits a count EXACTLY at the maximum: a limit of N means N, not N-1', () => {
    const outcome = evaluateLeaveLimit({
      limit: limit({ maximum: 3 }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(true);
    expect('exceeded' in outcome && outcome.count).toBe(3);
    expect('exceeded' in outcome && outcome.exceeded).toBe(false);
  });

  it('refuses one over the maximum, and states the count that produced it', () => {
    const outcome = evaluateLeaveLimit({
      limit: limit({ maximum: 2 }),
      requests: THREE_APPROVED,
      employmentType: null,
    });

    expect(outcome.refusable).toBe(true);
    expect('exceeded' in outcome && outcome.count).toBe(3);
    expect('exceeded' in outcome && outcome.exceeded).toBe(true);
    // §16.7/§23.5: the grounds travel with the refusal so an explanation can show "3 of 2".
    if (outcome.refusable) {
      expect(outcome.countingBasis).toBe('REQUEST_COUNT');
      expect(outcome.maximum).toBe(2);
      expect(outcome.windowStart).toEqual(WINDOW_START);
      expect(outcome.windowEnd).toEqual(WINDOW_END);
      expect(outcome.contributingRequestIds).toEqual(['r1', 'r2', 'r3']);
    }
  });

  it('counts DAY_COUNT inclusively over the same request set, differently from REQUEST_COUNT', () => {
    // r1 = 3 days, r2 = 2 days, r3 = 5 days → 10 days, but only 3 requests. The two bases are
    // DIFFERENT SEMANTICS over the same rows; a spec that ignored the basis would not see this.
    const dayRequests = [
      request('r1', '2026-04-01', '2026-04-03'),
      request('r2', '2026-05-01', '2026-05-02'),
      request('r3', '2026-06-10', '2026-06-14'),
    ];

    const days = evaluateLeaveLimit({
      limit: limit({ countingBasis: 'DAY_COUNT', maximum: 9 }),
      requests: dayRequests,
      employmentType: null,
    });
    const counts = evaluateLeaveLimit({
      limit: limit({ countingBasis: 'REQUEST_COUNT', maximum: 9 }),
      requests: dayRequests,
      employmentType: null,
    });

    expect(counts.refusable && counts.count).toBe(3);
    expect(days.refusable && days.count).toBe(10);
    expect(counts.refusable && counts.exceeded).toBe(false);
    expect(days.refusable && days.exceeded).toBe(true);
  });
});
