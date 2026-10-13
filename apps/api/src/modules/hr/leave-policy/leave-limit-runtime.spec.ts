import { evaluateLeaveRequestAgainstLimits } from './leave-limit-runtime';
import type { LeaveLimitRuntimePorts, StoredLimitRow } from './leave-limit-runtime';
import type { CountableLeaveRequest } from './leave-limit-counting';
import type { HrActor } from '../hr-actor';
import type { LeaveLimitConsumedState } from '../domain/leave-policy';

/**
 * Phase 54-G (§12, §16.6, §16.7, §21.7) — the RUNTIME ORCHESTRATION's focused spec.
 *
 * `evaluateLeaveRequestAgainstLimits` is the piece that asks 54-F's resolver what governs, then
 * drives the three-gate evaluator over each applicable limit. What is under test here is NOT the
 * arithmetic (that is `leave-limit-enforcement.spec.ts`) but the SEQUENCING decisions:
 *
 *   * `version === null` is the ONLY "no policy" answer — a governed version with no limits is a
 *     DIFFERENT answer and must not be misread as ungoverned (§16.7/§21.7).
 *   * the resolver's `undecidableLimits` become refusals, not silence.
 *   * a limit the scope rule rejected as `applicable: false` is SKIPPED, never filed as an
 *     undecidable refusal — sorting those two arms the other way would refuse an entitled request.
 *   * the clock is read ONCE, and the caller never supplies `asOf`.
 *
 * The ports are plain fakes: the resolver, the countable read, and the clock are all injected, so
 * the whole decision runs without a database and every branch is reachable.
 */

const ACTOR = { tenantId: 'tenant-a', userId: 'user-1' } as HrActor;
const AS_OF = new Date('2026-09-22T00:00:00.000Z');
const WINDOW_START = new Date('2026-03-21T00:00:00.000Z');
const WINDOW_END = new Date('2027-03-20T00:00:00.000Z');
const ENFORCEABLE: readonly LeaveLimitConsumedState[] = ['APPROVED', 'PENDING'];

function storedLimit(overrides: Partial<StoredLimitRow> = {}): StoredLimitRow {
  return {
    id: 'limit-1',
    policyVersionId: 'version-1',
    leaveTypeId: 'type-annual',
    employmentType: null,
    maximum: 2,
    countingBasis: 'REQUEST_COUNT',
    consumesStates: ENFORCEABLE,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

/** A governed resolution: one published version, one limit. */
function governed(limits: StoredLimitRow[], undecidableLimits: StoredLimitRow[] = []) {
  return { version: { id: 'version-1' }, limits, undecidableLimits };
}

function makePorts({
  resolve,
  countable = [],
}: {
  resolve: LeaveLimitRuntimePorts['resolveEffective'];
  countable?: CountableLeaveRequest[];
}): LeaveLimitRuntimePorts {
  return {
    resolveEffective: resolve,
    findCountableRequests: async () => countable,
    now: () => AS_OF,
  };
}

const APPROVED_REQUESTS: CountableLeaveRequest[] = [
  {
    id: 'r1',
    startDate: new Date('2026-04-01'),
    endDate: new Date('2026-04-03'),
    status: 'APPROVED',
  },
  {
    id: 'r2',
    startDate: new Date('2026-05-01'),
    endDate: new Date('2026-05-02'),
    status: 'APPROVED',
  },
];

const INPUT = { leaveTypeId: 'type-annual', employeeId: 'emp-1', employmentType: null } as const;

describe('54-G — the governing-policy question (§12, §16.7, §21.7)', () => {
  it('reports NO GOVERNING POLICY only when the resolver names no version', async () => {
    const ports = makePorts({
      resolve: async () => ({ version: null, limits: [], undecidableLimits: [] }),
    });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    expect(outcome.governed).toBe(false);
    if (!outcome.governed) expect(outcome.reason).toBe('NO_GOVERNING_POLICY');
  });

  it('treats a GOVERNED version with NO limits as governed-with-no-entitlement, not as "no policy"', async () => {
    // The subtle distinction: an empty limit set under a named version means the policy is in force
    // but states no entitlement for this type/day — NOT that nothing governs. Reading it as ungoverned
    // would let a request bypass the fact that a policy exists.
    const ports = makePorts({ resolve: async () => governed([]) });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    expect(outcome.governed).toBe(true);
    if (outcome.governed) {
      expect(outcome.policyVersionId).toBe('version-1');
      expect(outcome.refusals).toHaveLength(0);
      expect(outcome.undecidable).toHaveLength(0);
    }
  });

  it('reads the clock ONCE and judges the request against that day, never a caller-supplied asOf', async () => {
    let seenAsOf: string | undefined;
    const ports: LeaveLimitRuntimePorts = {
      resolveEffective: async (_actor, query) => {
        seenAsOf = query.asOf;
        return governed([]);
      },
      findCountableRequests: async () => [],
      now: () => AS_OF,
    };

    await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    // The resolver received the CLOCK's day (formatted), not anything from the input.
    expect(seenAsOf).toBe('2026-09-22');
  });
});

describe('54-G — undecidable limits become refusals (§16.6)', () => {
  it('carries a resolver-undecidable limit into `undecidable`, so the caller refuses on it', async () => {
    const undecidable = storedLimit({ id: 'limit-scoped', employmentType: 'FULL_TIME' });
    const ports = makePorts({ resolve: async () => governed([], [undecidable]) });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    expect(outcome.governed).toBe(true);
    if (outcome.governed) {
      expect(outcome.undecidable).toHaveLength(1);
      expect(outcome.undecidable[0]).toMatchObject({
        refusable: false,
        refusal: 'EMPLOYMENT_CONTEXT_MISSING',
      });
    }
  });
});

describe('54-G — applicable:false is SKIPPED, never an undecidable refusal', () => {
  it('does not refuse on a limit scoped to a different employment type', async () => {
    // The three-gate evaluator returns the `applicable: false` ARM for a scoped limit that does not
    // match. If the runtime sorted `refusable: false` BEFORE checking `applicable`, this would land
    // in `undecidable` and the caller would refuse an entitled request.
    const otherType = storedLimit({ id: 'limit-ft', employmentType: 'FULL_TIME' });
    const ports = makePorts({
      resolve: async () => governed([otherType]),
      countable: APPROVED_REQUESTS,
    });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, {
      actor: ACTOR,
      ...INPUT,
      employmentType: 'CONTRACT',
    });

    expect(outcome.governed).toBe(true);
    if (outcome.governed) {
      expect(outcome.undecidable).toHaveLength(0);
      expect(outcome.refusals).toHaveLength(0);
      // The limit WAS evaluated (it is in `evaluated`) but produced the not-applicable decision.
      expect(outcome.evaluated).toHaveLength(1);
      expect(outcome.evaluated[0]).toMatchObject({ refusable: false, applicable: false });
    }
  });
});

describe('54-G — refusal grounds reach the caller (§16.7)', () => {
  it('returns a refusal carrying count, maximum, and window when the maximum is exceeded', async () => {
    const ports = makePorts({
      resolve: async () => governed([storedLimit({ maximum: 1 })]),
      countable: APPROVED_REQUESTS,
    });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    expect(outcome.governed).toBe(true);
    if (outcome.governed) {
      expect(outcome.refusals).toHaveLength(1);
      const refusal = outcome.refusals[0];
      if (refusal.refusable) {
        expect(refusal.count).toBe(2);
        expect(refusal.maximum).toBe(1);
        expect(refusal.exceeded).toBe(true);
        expect(refusal.windowStart).toEqual(WINDOW_START);
        expect(refusal.windowEnd).toEqual(WINDOW_END);
      }
    }
  });

  it('names the governing version from the RESOLVER, not from a limit row', async () => {
    const ports = makePorts({ resolve: async () => governed([]) });

    const outcome = await evaluateLeaveRequestAgainstLimits(ports, { actor: ACTOR, ...INPUT });

    expect(outcome.governed && outcome.policyVersionId).toBe('version-1');
  });
});
