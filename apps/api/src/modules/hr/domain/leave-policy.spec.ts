import {
  LEAVE_LIFECYCLE_STATUS_MEMBERS,
  LEAVE_LIMIT_CONSUMED_STATES,
  LEAVE_LIMIT_COUNTING_BASES,
  LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES,
  LEAVE_LIMIT_PERIOD_KINDS,
  LEAVE_LIMIT_RULE_SET_ID,
  isLeaveLimitConsumedState,
  isLeaveLimitConsumedStatesEnforceable,
  isLeaveLimitCountingBasis,
  isLeaveLimitPeriodKind,
  leaveLimitEnforceabilityRefusal,
  type LeaveLimitConsumedState,
} from './leave-policy';
import { LEAVE_REQUEST_STATUSES } from './leave-status';

/**
 * Phase 54-D (§16.1, §16.4, §21.6): the leave-policy vocabulary, and the derivation that keeps
 * the phase split honest.
 *
 * WHAT THESE GATES ARE FOR. §38.2 refuses a gate that can only pass by construction. Each
 * assertion below can genuinely fail, and the one that matters is the last group: it fails if a
 * later phase narrows the authorable contract (loses `APPROVED`), or if the lifecycle gains a
 * member without the derivation widening, or if the enforcement path starts claiming it can count
 * a state the database cannot store.
 */
describe('leave policy vocabulary (§16, D7)', () => {
  describe('counting basis — two semantics, never a bare number', () => {
    it('declares exactly the two bases the specification names', () => {
      expect([...LEAVE_LIMIT_COUNTING_BASES]).toEqual(['REQUEST_COUNT', 'DAY_COUNT']);
    });

    it('accepts only those two, so a third basis cannot be stored unnoticed', () => {
      expect(isLeaveLimitCountingBasis('REQUEST_COUNT')).toBe(true);
      expect(isLeaveLimitCountingBasis('DAY_COUNT')).toBe(true);
      expect(isLeaveLimitCountingBasis('HOUR_COUNT')).toBe(false);
      expect(isLeaveLimitCountingBasis('')).toBe(false);
      expect(isLeaveLimitCountingBasis(undefined)).toBe(false);
    });
  });

  describe('period — one kind, resolved to a window by the domain', () => {
    it('declares YEAR as the only period in this phase', () => {
      expect([...LEAVE_LIMIT_PERIOD_KINDS]).toEqual(['YEAR']);
      expect(isLeaveLimitPeriodKind('YEAR')).toBe(true);
      expect(isLeaveLimitPeriodKind('MONTH')).toBe(false);
    });
  });

  describe('consumed states — the AUTHORABLE contract', () => {
    it('keeps APPROVED, because dropping it would be the narrowing §39.10 forbids', () => {
      // THE ASSERTION THAT PROTECTS THE CONTRACT. If a later edit removes `APPROVED` from the
      // authorable vocabulary — the exact narrowing this phase refused to make — this fails.
      expect(LEAVE_LIMIT_CONSUMED_STATES).toContain('APPROVED');
    });

    it('also allows APPROVED + PENDING, the "reservation" shape D7 names', () => {
      expect(LEAVE_LIMIT_CONSUMED_STATES).toContain('PENDING');
      expect([...LEAVE_LIMIT_CONSUMED_STATES]).toEqual(['APPROVED', 'PENDING']);
    });

    it('never admits CANCELLED — a withdrawn request was never leave', () => {
      expect(LEAVE_LIMIT_CONSUMED_STATES).not.toContain('CANCELLED');
      expect(isLeaveLimitConsumedState('CANCELLED')).toBe(false);
      expect(isLeaveLimitConsumedState('APPROVED')).toBe(true);
    });
  });

  describe('consumed states — the ENFORCEABLE subset is derived, not re-listed', () => {
    it('agrees with the leave lifecycle it derives from', () => {
      // The anti-drift gate for the local member set. `leave-policy.ts` cannot import
      // `leave-status.ts` (the domain tier imports nothing), so the two are compared HERE
      // instead of being trusted to agree. A lifecycle that gains APPROVED fails this until the
      // local set is updated — which is the maintenance contract, enforced rather than written.
      expect([...LEAVE_LIFECYCLE_STATUS_MEMBERS].sort()).toEqual(
        [...LEAVE_REQUEST_STATUSES].sort()
      );
    });

    it('evaluates to exactly APPROVED + PENDING on this phase\u2019s lifecycle', () => {
      // Pins the derivation to a concrete, reviewable value rather than "some subset": the failure
      // mode this catches is the filter silently producing an EMPTY list, which would make every
      // limit unenforceable while looking like it worked.
      //
      // TWO MEMBERS SINCE 54-E, where it was exactly `['PENDING']`. That is the phase's own claim
      // made checkable: once a request can BE approved, "consumed" includes approved requests, so
      // the enforceable set stops being a strict subset and the gap §39.10 documented CLOSES. The
      // order is the AUTHORED order (`LEAVE_LIMIT_CONSUMED_STATES` is `['APPROVED', 'PENDING']` and
      // the filter preserves it), so this assertion also pins that the filter is a `filter` rather
      // than a re-sort.
      expect([...LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES]).toEqual(['APPROVED', 'PENDING']);
    });

    it('is now EQUAL to the authorable contract — the gap the phase split left is closed', () => {
      // The inverse of the previous phase's strictness assertion, and deliberately so. 54-E made
      // the last authorable state reachable, so a limit naming `APPROVED` describes a population
      // that CAN be assembled from stored rows. An ENFORCEABILITY REFUSAL is therefore no longer
      // produced for either authorable state — which is why this asserts equality rather than
      // `toBeLessThan`, and why the refusal this file still declares remains correct for a FUTURE
      // authorable-but-unreachable state rather than for either of these two.
      expect([...LEAVE_LIMIT_ENFORCEABLE_CONSUMED_STATES]).toEqual([
        ...LEAVE_LIMIT_CONSUMED_STATES,
      ]);
      expect(LEAVE_LIMIT_CONSUMED_STATES).toContain('APPROVED');
    });
  });

  describe('enforceability refusal — typed, and specific about WHICH defect', () => {
    it('refuses an empty set, because §16.4 forbids counting everything or nothing', () => {
      expect(leaveLimitEnforceabilityRefusal([])).toBe('CONSUMED_STATES_EMPTY');
      expect(isLeaveLimitConsumedStatesEnforceable([])).toBe(false);
    });

    it('ADMITS a set naming APPROVED since 54-E made it reachable', () => {
      // THIS TEST INVERTED IN 54-E, and the inversion is the phase's own claim. Before it, the
      // declared set `['APPROVED']` was legal policy the runtime could not count — a request could
      // never BE approved — so the honest answer was `CONSUMED_STATE_NOT_IN_LIFECYCLE`. Now a
      // routed flow can reach that state, so a limit naming it counts a population that exists and
      // the refusal would be a lie about the system's own data.
      //
      // The refusal CODE and its type are deliberately NOT removed: they describe a property of the
      // relationship between the authorable contract and the lifecycle, and that relationship will
      // become a gap again the day a fifth state is authored before it is reachable.
      expect(leaveLimitEnforceabilityRefusal(['APPROVED'])).toBeNull();
      expect(leaveLimitEnforceabilityRefusal(['APPROVED', 'PENDING'])).toBeNull();
      expect(isLeaveLimitConsumedStatesEnforceable(['APPROVED'])).toBe(true);
    });

    it('admits PENDING alone, the population the lifecycle has always been able to assemble', () => {
      expect(leaveLimitEnforceabilityRefusal(['PENDING'])).toBeNull();
      expect(isLeaveLimitConsumedStatesEnforceable(['PENDING'])).toBe(true);
    });

    it('still distinguishes an unstated set from a state the lifecycle cannot reach', () => {
      // THE BRANCH IS REACHED THROUGH A CAST ON PURPOSE, and the cast is the assertion. Since 54-E
      // widened the lifecycle, `LeaveLimitConsumedState` is exactly `'APPROVED' | 'PENDING'` and the
      // enforceable subset is the same two members — so the compiler now proves that NO
      // well-typed caller can reach `CONSUMED_STATE_NOT_IN_LIFECYCLE`.
      //
      // The branch is still worth a test rather than deletion, because the FUNCTION's job is to
      // refuse a declared set wider than the lifecycle, and that set can arrive from STORED
      // configuration written before a narrowing — which is a row, not a TypeScript value. Casting
      // through `unknown` is how a spec simulates that row, and it keeps the refusal a live rule
      // instead of dead code the compiler happens to preserve.
      const storedState = 'RETIRED' as unknown as LeaveLimitConsumedState;

      expect(leaveLimitEnforceabilityRefusal(['PENDING'])).toBeNull();
      expect(leaveLimitEnforceabilityRefusal([storedState])).toBe(
        'CONSUMED_STATE_NOT_IN_LIFECYCLE'
      );
      expect(leaveLimitEnforceabilityRefusal([])).not.toBe(
        leaveLimitEnforceabilityRefusal([storedState])
      );
    });
  });

  describe('rule-set identity', () => {
    it('is a single namespaced constant, so three sites cannot drift', () => {
      expect(LEAVE_LIMIT_RULE_SET_ID).toBe('hr.leave.limit');
    });
  });
});
