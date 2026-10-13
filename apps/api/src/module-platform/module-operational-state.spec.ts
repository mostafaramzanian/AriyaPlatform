import {
  IN_FLIGHT_OPERATIONAL_STATES,
  INITIAL_OPERATIONAL_STATE,
  MODULE_OPERATIONAL_STATES,
  TERMINAL_OPERATIONAL_STATES,
  allowedTransitions,
  canTransition,
  checkTransition,
  isInFlightState,
  isOperationalState,
  isTerminalState,
  type ModuleOperationalStateValue,
} from './module-operational-state';

/**
 * Phase 49M-1 §2.4: the operational transition table.
 *
 * WHY THIS SPEC ENUMERATES ALL 81 PAIRS rather than testing a handful of paths: the whole point
 * of moving the rule into data was that the legal set becomes finite and checkable. A test that
 * asserts "REGISTERED can go to PROVISIONING" proves nothing about the transitions somebody
 * might add later; an exhaustive assertion fails the moment ANY unlisted edge appears, which is
 * the only way a permissive edge cannot be added quietly.
 */

/** The complete legal edge set, written out independently of the implementation. */
const LEGAL_EDGES: ReadonlyArray<[ModuleOperationalStateValue, ModuleOperationalStateValue]> = [
  ['REGISTERED', 'PROVISIONING'],
  ['REGISTERED', 'FAILED'],
  ['PROVISIONING', 'CONFIGURING'],
  ['PROVISIONING', 'FAILED'],
  ['CONFIGURING', 'VERIFYING'],
  ['CONFIGURING', 'FAILED'],
  ['VERIFYING', 'ACTIVE'],
  ['VERIFYING', 'FAILED'],
  ['ACTIVE', 'UPDATING'],
  ['ACTIVE', 'DISABLED'],
  ['UPDATING', 'ACTIVE'],
  ['UPDATING', 'FAILED'],
  ['DISABLED', 'ACTIVE'],
  ['DISABLED', 'DECOMMISSIONED'],
  ['FAILED', 'PROVISIONING'],
  ['FAILED', 'DISABLED'],
];

const isLegal = (from: ModuleOperationalStateValue, to: ModuleOperationalStateValue) =>
  LEGAL_EDGES.some(([a, b]) => a === from && b === to);

describe('ModuleOperationalState declarations', () => {
  it('declares exactly nine states, and does not include DISCOVERED', () => {
    expect(MODULE_OPERATIONAL_STATES).toHaveLength(9);
    // DISCOVERED is a DERIVED state of the LOGICAL module in 49M. This machine is keyed by
    // instance, where it could never be true — the row cannot exist before the instance does.
    expect(MODULE_OPERATIONAL_STATES).not.toContain('DISCOVERED' as never);
    // Health lives on ModuleInstance.health and is deliberately not duplicated here.
    expect(MODULE_OPERATIONAL_STATES).not.toContain('DEGRADED' as never);
    expect(MODULE_OPERATIONAL_STATES).not.toContain('UNAVAILABLE' as never);
  });

  it('starts at REGISTERED, never at ACTIVE', () => {
    // 49M already refuses to let a self-registration serve before an admin admits it; an
    // operational default of ACTIVE would contradict that from the other side.
    expect(INITIAL_OPERATIONAL_STATE).toBe('REGISTERED');
    expect(INITIAL_OPERATIONAL_STATE).not.toBe('ACTIVE');
  });

  it('treats DECOMMISSIONED as the only terminal state', () => {
    expect(TERMINAL_OPERATIONAL_STATES).toEqual(['DECOMMISSIONED']);
    expect(isTerminalState('DECOMMISSIONED')).toBe(true);
    expect(isTerminalState('FAILED')).toBe(false);
    // FAILED being non-terminal is the point: a failed provision must be retryable.
    expect(allowedTransitions('FAILED')).toEqual(['PROVISIONING', 'DISABLED']);
  });

  it('declares the four in-flight states used by the concurrency guard', () => {
    expect(IN_FLIGHT_OPERATIONAL_STATES).toEqual([
      'PROVISIONING',
      'CONFIGURING',
      'VERIFYING',
      'UPDATING',
    ]);

    expect(isInFlightState('UPDATING')).toBe(true);
    expect(isInFlightState('ACTIVE')).toBe(false);
    expect(isInFlightState('FAILED')).toBe(false);
  });
});

describe('canTransition — exhaustive', () => {
  it('permits exactly the sixteen declared edges out of eighty-one pairs', () => {
    const permitted: string[] = [];

    for (const from of MODULE_OPERATIONAL_STATES) {
      for (const to of MODULE_OPERATIONAL_STATES) {
        if (canTransition(from, to)) permitted.push(`${from}->${to}`);
      }
    }

    expect(permitted).toHaveLength(LEGAL_EDGES.length);
    expect(permitted.sort()).toEqual(LEGAL_EDGES.map(([a, b]) => `${a}->${b}`).sort());
  });

  it('agrees with the independently written edge list for every pair', () => {
    for (const from of MODULE_OPERATIONAL_STATES) {
      for (const to of MODULE_OPERATIONAL_STATES) {
        expect(canTransition(from, to)).toBe(isLegal(from, to));
      }
    }
  });

  it('refuses every self-transition', () => {
    // A no-op state write still moves `stateChangedAt`; an idempotent retry must be recognised
    // by its idempotencyKey instead.
    for (const state of MODULE_OPERATIONAL_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('refuses any transition out of DECOMMISSIONED', () => {
    for (const to of MODULE_OPERATIONAL_STATES) {
      expect(canTransition('DECOMMISSIONED', to)).toBe(false);
    }

    expect(allowedTransitions('DECOMMISSIONED')).toEqual([]);
  });

  it('has no shortcut to ACTIVE that skips VERIFYING', () => {
    // The five-condition activation gate runs during VERIFYING, so a REGISTERED -> ACTIVE or
    // PROVISIONING -> ACTIVE edge would be a way to activate without checksum or capability
    // verification.
    expect(canTransition('REGISTERED', 'ACTIVE')).toBe(false);
    expect(canTransition('PROVISIONING', 'ACTIVE')).toBe(false);
    expect(canTransition('CONFIGURING', 'ACTIVE')).toBe(false);
    expect(canTransition('FAILED', 'ACTIVE')).toBe(false);
    expect(canTransition('VERIFYING', 'ACTIVE')).toBe(true);
  });

  it('requires DECOMMISSIONED to be reached through DISABLED', () => {
    // Decommissioning is destructive, so it must pass through a deliberate disable step.
    for (const from of MODULE_OPERATIONAL_STATES) {
      expect(canTransition(from, 'DECOMMISSIONED')).toBe(from === 'DISABLED');
    }
  });
});

describe('prototype safety', () => {
  it('does not treat inherited Object properties as states', () => {
    // `TRANSITIONS['constructor']` on a plain object literal resolves through Object.prototype
    // and returns a truthy non-array — the exact hazard IntegrationProviderRegistry documents.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isOperationalState(key)).toBe(false);
      expect(canTransition(key as never, 'ACTIVE')).toBe(false);
      expect(canTransition('ACTIVE', key as never)).toBe(false);
      expect(allowedTransitions(key as never)).toEqual([]);
      expect(checkTransition(key as never, 'ACTIVE').failure).toBe('UNKNOWN_STATE');
    }
  });

  it('rejects non-string values without throwing', () => {
    for (const value of [undefined, null, 0, 1, {}, [], true]) {
      expect(isOperationalState(value)).toBe(false);
    }
  });
});

describe('allowedTransitions', () => {
  it('returns a fresh array that cannot mutate the table', () => {
    const first = allowedTransitions('ACTIVE') as ModuleOperationalStateValue[];
    first.push('DECOMMISSIONED');

    // If the table had been handed out by reference, this second read would now contain the
    // pushed value and the whole process would accept an illegal transition.
    expect(allowedTransitions('ACTIVE')).toEqual(['UPDATING', 'DISABLED']);
    expect(canTransition('ACTIVE', 'DECOMMISSIONED')).toBe(false);
  });

  it('lists the forward path exactly once each', () => {
    expect(allowedTransitions('REGISTERED')).toEqual(['PROVISIONING', 'FAILED']);
    expect(allowedTransitions('PROVISIONING')).toEqual(['CONFIGURING', 'FAILED']);
    expect(allowedTransitions('CONFIGURING')).toEqual(['VERIFYING', 'FAILED']);
    expect(allowedTransitions('VERIFYING')).toEqual(['ACTIVE', 'FAILED']);
    expect(allowedTransitions('UPDATING')).toEqual(['ACTIVE', 'FAILED']);
    expect(allowedTransitions('DISABLED')).toEqual(['ACTIVE', 'DECOMMISSIONED']);
  });

  it('lets every non-terminal state fail', () => {
    // Every step of the forward path can fail; that is why FAILED is reachable from all of them.
    for (const from of ['REGISTERED', 'PROVISIONING', 'CONFIGURING', 'VERIFYING', 'UPDATING'] as const) {
      expect(canTransition(from, 'FAILED')).toBe(true);
    }

    // ACTIVE and DISABLED do NOT go to FAILED: a healthy or intentionally-off instance has no
    // failing operation in flight, and health regressions are ModuleInstance.health's job.
    expect(canTransition('ACTIVE', 'FAILED')).toBe(false);
    expect(canTransition('DISABLED', 'FAILED')).toBe(false);
  });
});

describe('checkTransition — reasons', () => {
  it('reports ok with no failure code for a legal edge', () => {
    expect(checkTransition('REGISTERED', 'PROVISIONING')).toEqual({ ok: true });
    expect(checkTransition('VERIFYING', 'ACTIVE')).toEqual({ ok: true });
  });

  it('distinguishes a terminal source from an illegal edge', () => {
    // "This instance is decommissioned" and "you cannot go from ACTIVE to VERIFYING" lead an
    // operator to completely different next steps, so they must not share a code.
    expect(checkTransition('DECOMMISSIONED', 'PROVISIONING')).toEqual({
      ok: false,
      failure: 'TERMINAL_STATE',
    });

    expect(checkTransition('ACTIVE', 'VERIFYING')).toEqual({
      ok: false,
      failure: 'ILLEGAL_TRANSITION',
    });
  });

  it('reports UNKNOWN_STATE before any other reason', () => {
    expect(checkTransition('NOPE' as never, 'ACTIVE')).toEqual({
      ok: false,
      failure: 'UNKNOWN_STATE',
    });

    expect(checkTransition('ACTIVE', 'NOPE' as never)).toEqual({
      ok: false,
      failure: 'UNKNOWN_STATE',
    });

    // Even from a terminal state, an unknown target is reported as UNKNOWN_STATE: the caller
    // supplied something this build cannot interpret, which is the more actionable fact.
    expect(checkTransition('DECOMMISSIONED', 'NOPE' as never).failure).toBe('UNKNOWN_STATE');
  });

  it('agrees with canTransition for every pair', () => {
    for (const from of MODULE_OPERATIONAL_STATES) {
      for (const to of MODULE_OPERATIONAL_STATES) {
        expect(checkTransition(from, to).ok).toBe(canTransition(from, to));
      }
    }
  });
});
