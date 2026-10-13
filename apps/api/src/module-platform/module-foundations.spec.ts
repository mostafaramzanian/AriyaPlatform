import {
  DECLARED_CONFLICT_POLICIES,
  DEFAULT_CONFLICT_POLICY,
  PROVISIONING_STEPS,
  remainingProvisioningSteps,
} from './module-foundations';

/**
 * Phase 49M §36/§37/§38: the future-foundation declarations.
 *
 * WHAT THIS FILE PROVES, AND IT IS DELIBERATELY SHORT:
 *
 *  - NOTHING IS IMPLEMENTED. The module exports types, two constant lists and ONE pure function.
 *    That is asserted by the only behaviour test being about ordering — there is no sync engine, no
 *    conflict resolver and no provisioner to test, because §36/§37/§38 forbid building them.
 *  - LAST_WRITE_WINS IS NEVER THE DEFAULT. It silently discards data and depends on clock agreement
 *    between machines that have no reason to agree; §37 permits it "only where explicitly selected",
 *    so nothing here selects it.
 *  - THE PROVISIONING ORDER IS THE ORDER THE PHASE ALREADY PERFORMS MANUALLY, so the type describes
 *    existing behaviour rather than promising new behaviour.
 */

describe('conflict policy declarations (§37)', () => {
  it('declares four policies and defaults to OWNER_WINS', () => {
    expect(DECLARED_CONFLICT_POLICIES).toEqual([
      'OWNER_WINS',
      'VERSION_MISMATCH',
      'EXPLICIT_RESOLUTION',
      'LAST_WRITE_WINS',
    ]);

    expect(DEFAULT_CONFLICT_POLICY).toBe('OWNER_WINS');
  });

  it('never defaults to LAST_WRITE_WINS', () => {
    // When a remote module owns a record, Core's copy is a cache — and a cache must not overwrite
    // its origin because two clocks disagreed.
    expect(DEFAULT_CONFLICT_POLICY).not.toBe('LAST_WRITE_WINS');
    // It is listed LAST, so nothing that picks "the first available policy" picks it either.
    expect(DECLARED_CONFLICT_POLICIES[DECLARED_CONFLICT_POLICIES.length - 1]).toBe(
      'LAST_WRITE_WINS',
    );
  });
});

describe('provisioning foundation (§38)', () => {
  it('declares the four steps in the order the platform already performs them', () => {
    expect(PROVISIONING_STEPS).toEqual(['REGISTER', 'AUTHENTICATE', 'VERIFY', 'ACTIVATE']);
  });

  it('reports what remains, preserving declared order', () => {
    expect(remainingProvisioningSteps([])).toEqual([
      'REGISTER',
      'AUTHENTICATE',
      'VERIFY',
      'ACTIVATE',
    ]);

    expect(remainingProvisioningSteps(['REGISTER', 'AUTHENTICATE'])).toEqual(['VERIFY', 'ACTIVATE']);
    expect(remainingProvisioningSteps([...PROVISIONING_STEPS])).toEqual([]);
  });

  it('does not assume the completed steps are contiguous', () => {
    // A manual operator can perform these out of order; reporting "nothing remains" because the
    // FIRST step is missing would be a lie.
    expect(remainingProvisioningSteps(['ACTIVATE'])).toEqual(['REGISTER', 'AUTHENTICATE', 'VERIFY']);
    expect(remainingProvisioningSteps(['VERIFY'])).toEqual(['REGISTER', 'AUTHENTICATE', 'ACTIVATE']);
  });

  it('ignores an unknown step rather than throwing', () => {
    expect(remainingProvisioningSteps(['NOPE' as never])).toEqual([...PROVISIONING_STEPS]);
  });
});
