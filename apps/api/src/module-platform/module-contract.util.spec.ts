import {
  checkCompatibility,
  contractsCompatible,
  hasCapabilities,
  isValidCapability,
  parseContract,
  satisfiesContract,
} from './module-contract.util';
import { CORE_MODULE_CONTRACT, MODULE_PROTOCOL_VERSION } from './module.contract';

/**
 * Phase 49M §16/§17/§18: contract identity and the compatibility gate.
 *
 * WHAT THIS FILE PROVES, AND WHY EACH ONE IS HERE RATHER THAN ASSUMED:
 *
 *  - A MALFORMED DESCRIPTOR IS REFUSED, NOT COERCED. `v2`, `2`, `finance` and `invoice@2` all
 *    look plausible and all mean nothing to a version comparison; accepting any of them would
 *    store a contract nothing can compare.
 *  - MAJORS MUST MATCH EXACTLY. There is no v2-reads-v1 fallback, because nothing in Core can
 *    inspect a remote response shape, so a silent downgrade would misinterpret the answer.
 *  - THE GATE IS ALL-OR-NOTHING (§18). Every failure mode produces a refusal, never a partial
 *    pass — the assertion that would catch someone later "helpfully" letting a module through
 *    with one bad capability.
 *  - CAPABILITIES ARE MATCHED, NEVER PARSED. There is no allowlist to drift, so the only test
 *    that can exist is a SHAPE test — and the absence of a known-capability list is itself
 *    asserted by `isValidCapability` accepting a domain nothing in Aria has heard of.
 */

describe('parseContract', () => {
  it('parses a well-formed descriptor', () => {
    expect(parseContract('module.invoke@v1')).toEqual({ name: 'module.invoke', major: 1 });
    expect(parseContract('invoice-export@v12')).toEqual({ name: 'invoice-export', major: 12 });
    expect(parseContract('a_b.c-d@v0')).toEqual({ name: 'a_b.c-d', major: 0 });
  });

  it('refuses every shape that cannot be compared', () => {
    // Each of these is a realistic thing somebody types, and each would silently break a version
    // comparison if it were accepted.
    expect(parseContract('module.invoke')).toBeUndefined();
    expect(parseContract('module.invoke@2')).toBeUndefined();
    expect(parseContract('module.invoke@vX')).toBeUndefined();
    expect(parseContract('module.invoke@v')).toBeUndefined();
    expect(parseContract('MODULE.INVOKE@v1')).toBeUndefined();
    expect(parseContract('@v1')).toBeUndefined();
    expect(parseContract('')).toBeUndefined();
    expect(parseContract('module..invoke@v1')).toBeUndefined();
  });

  it('refuses a descriptor longer than the stored column allows', () => {
    // The DB column is bounded; a value that could not be stored must not pass validation and
    // then fail at insert time.
    expect(parseContract(`${'a'.repeat(200)}@v1`)).toBeUndefined();
  });

  it('is not confused by a non-string', () => {
    expect(parseContract(undefined as unknown as string)).toBeUndefined();
    expect(parseContract(42 as unknown as string)).toBeUndefined();
  });
});

describe('contractsCompatible', () => {
  it('requires the same name AND the same major', () => {
    expect(contractsCompatible('module.invoke@v1', 'module.invoke@v1')).toBe(true);
    expect(contractsCompatible('module.invoke@v1', 'module.invoke@v2')).toBe(false);
    expect(contractsCompatible('module.invoke@v1', 'module.dispatch@v1')).toBe(false);
  });

  it('does NOT let a newer major satisfy an older one', () => {
    // The load-bearing assertion: a "v2 can serve v1" fallback would mean Core sends a v1 request
    // and interprets a v2 answer as v1.
    expect(contractsCompatible('module.invoke@v1', 'module.invoke@v2')).toBe(false);
    expect(contractsCompatible('module.invoke@v2', 'module.invoke@v1')).toBe(false);
  });

  it('refuses when either side is malformed', () => {
    expect(contractsCompatible('module.invoke@v1', 'module.invoke')).toBe(false);
    expect(contractsCompatible('anything', 'module.invoke@v1')).toBe(false);
  });
});

describe('satisfiesContract', () => {
  it('finds a compatible descriptor in a list', () => {
    expect(satisfiesContract('module.invoke@v1', ['other@v1', 'module.invoke@v1'])).toBe(true);
  });

  it('is false for an empty list and for a list of near-misses', () => {
    expect(satisfiesContract('module.invoke@v1', [])).toBe(false);
    expect(satisfiesContract('module.invoke@v1', ['module.invoke@v2', 'module.invoke'])).toBe(false);
  });
});

describe('isValidCapability', () => {
  it('accepts a capability from a domain this codebase has never heard of', () => {
    // THE POINT OF THE PHASE, as a test: Core validates SHAPE and knows nothing about meaning, so
    // a module can declare a capability without Core shipping a release.
    expect(isValidCapability('invoice.read')).toBe(true);
    expect(isValidCapability('employee.leave.request')).toBe(true);
    expect(isValidCapability('something-nobody-has-built.yet')).toBe(true);
  });

  it('refuses shapes that could not be matched reliably', () => {
    expect(isValidCapability('')).toBe(false);
    expect(isValidCapability('Invoice.Read')).toBe(false);
    expect(isValidCapability('invoice read')).toBe(false);
    expect(isValidCapability('invoice..read')).toBe(false);
    expect(isValidCapability('.invoice')).toBe(false);
    expect(isValidCapability('a'.repeat(200))).toBe(false);
  });
});

describe('hasCapabilities', () => {
  it('is satisfied by an empty requirement', () => {
    expect(hasCapabilities([], [])).toBe(true);
    expect(hasCapabilities(['invoice.read'], [])).toBe(true);
  });

  it('requires EVERY capability, not any', () => {
    expect(hasCapabilities(['a.read', 'a.write'], ['a.read', 'a.write'])).toBe(true);
    expect(hasCapabilities(['a.read'], ['a.read', 'a.write'])).toBe(false);
  });

  it('matches exactly, with no wildcard or prefix semantics', () => {
    // A wildcard would require Core to understand capability hierarchy.
    expect(hasCapabilities(['invoice.read'], ['invoice'])).toBe(false);
    expect(hasCapabilities(['invoice'], ['invoice.read'])).toBe(false);
    expect(hasCapabilities(['invoice.*'], ['invoice.read'])).toBe(false);
  });
});

describe('checkCompatibility', () => {
  const valid = {
    protocolVersion: MODULE_PROTOCOL_VERSION,
    apiContracts: [CORE_MODULE_CONTRACT],
    capabilities: ['invoice.read'],
  };

  it('passes a module that speaks the protocol and the base contract', () => {
    expect(checkCompatibility(valid)).toEqual({ ok: true });
  });

  it('refuses a protocol mismatch first', () => {
    // Cheapest check first: an integer comparison before any string work.
    expect(checkCompatibility({ ...valid, protocolVersion: MODULE_PROTOCOL_VERSION + 1 })).toEqual({
      ok: false,
      failure: 'PROTOCOL_MISMATCH',
    });
  });

  it('refuses a module that does not serve the base contract', () => {
    // Such a module could be registered and would then 404 on the first real call.
    expect(checkCompatibility({ ...valid, apiContracts: ['invoice.export@v1'] })).toEqual({
      ok: false,
      failure: 'CONTRACT_MISSING',
    });

    expect(checkCompatibility({ ...valid, apiContracts: [] })).toEqual({
      ok: false,
      failure: 'CONTRACT_MISSING',
    });
  });

  it('refuses a module whose OTHER contract is malformed', () => {
    // §18 is all-or-nothing: one unparseable descriptor is enough, even though the base contract
    // is present and fine.
    expect(checkCompatibility({ ...valid, apiContracts: [CORE_MODULE_CONTRACT, 'broken'] })).toEqual(
      { ok: false, failure: 'CONTRACT_MALFORMED' },
    );
  });

  it('refuses a module with one malformed capability', () => {
    expect(
      checkCompatibility({ ...valid, capabilities: ['invoice.read', 'Bad Capability'] }),
    ).toEqual({ ok: false, failure: 'CAPABILITY_MALFORMED' });
  });

  it('accepts a module with NO capabilities', () => {
    // A module that only serves the base contract and declares nothing else is legal: it can be
    // called, it just advertises no fine-grained capability.
    expect(checkCompatibility({ ...valid, capabilities: [] })).toEqual({ ok: true });
  });

  it('names no business domain anywhere in its decision', () => {
    // A module whose capabilities sound like finance and one whose capabilities sound like
    // nothing at all must get identical treatment.
    const a = checkCompatibility({ ...valid, capabilities: ['invoice.read'] });
    const b = checkCompatibility({ ...valid, capabilities: ['sprocket.polish'] });

    expect(a).toEqual(b);
  });
});

