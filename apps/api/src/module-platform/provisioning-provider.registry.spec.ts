import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import { LocalProvisioningProvider } from './local-provisioning.provider';

/**
 * Phase 49M-1 §2.2: the provider registry.
 *
 * WHAT THIS FILE PROVES, and the second one is the load-bearing half:
 *
 *  1. LOCAL_SERVER resolves to a real provider, and REMOTE_AGENT resolves to NOTHING while
 *     still being DECLARED. "Declared but unavailable" is the shape that makes DEFERRED a
 *     visible state instead of a silent gap — a missing enum member would hide it, and a
 *     resolving stub would fake it.
 *  2. The lookup is prototype-safe. `DESCRIPTORS['constructor']` on a plain object literal
 *     returns a truthy non-descriptor, which an `if (!descriptor)` guard would pass.
 */

describe('ProvisioningProviderRegistry', () => {
  const healthStub = { probeInstance: jest.fn() } as never;

  const build = () => new ProvisioningProviderRegistry(new LocalProvisioningProvider(healthStub));

  it('resolves LOCAL_SERVER to the local provider', () => {
    const registry = build();
    const provider = registry.resolve('LOCAL_SERVER');

    expect(provider).toBeInstanceOf(LocalProvisioningProvider);
    expect(provider?.targetType).toBe('LOCAL_SERVER');
  });

  it('declares REMOTE_AGENT but resolves it to undefined', () => {
    const registry = build();

    // DECLARED: the UI can show it, and the schema enum has the member.
    expect(registry.isKnown('REMOTE_AGENT')).toBe(true);
    expect(registry.describe('REMOTE_AGENT')?.available).toBe(false);

    // UNAVAILABLE: nothing to run, which the service normalises to PROVIDER_UNAVAILABLE.
    expect(registry.resolve('REMOTE_AGENT')).toBeUndefined();
  });

  it('lists every declared target type, available or not', () => {
    const registry = build();
    const listed = registry.list();

    expect(listed.map((entry) => entry.targetType).sort()).toEqual([
      'LOCAL_SERVER',
      'REMOTE_AGENT',
    ]);

    // Exactly one is usable today. A second `available: true` entry would mean a provider
    // exists that this spec does not know about.
    expect(listed.filter((entry) => entry.available)).toHaveLength(1);
  });

  it('declares REMOTE_AGENT as unsupported for all nine actions', () => {
    // Listing only some would imply a partial implementation exists.
    const registry = build();

    expect(registry.describe('REMOTE_AGENT')?.unsupportedActions).toHaveLength(9);
  });

  it('marks RESTART unsupported for LOCAL_SERVER, and nothing else', () => {
    // `stop` IS supported in the narrow registry sense the provider documents. Restarting
    // requires having started, and nothing in this system did.
    const registry = build();

    expect(registry.describe('LOCAL_SERVER')?.unsupportedActions).toEqual(['RESTART']);
  });

  it('is prototype-safe for every lookup method', () => {
    const registry = build();

    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(registry.isKnown(key)).toBe(false);
      expect(registry.describe(key)).toBeUndefined();
      expect(registry.resolve(key)).toBeUndefined();
    }
  });

  it('returns copies, so a caller cannot widen a descriptor', () => {
    const registry = build();

    const first = registry.describe('LOCAL_SERVER');
    (first?.unsupportedActions as string[]).length = 0;

    // If the descriptor had been handed out by reference, RESTART would now appear
    // supported for the whole process and the UI would offer a button that cannot work.
    expect(registry.describe('LOCAL_SERVER')?.unsupportedActions).toEqual(['RESTART']);
    expect(registry.list()[0].unsupportedActions).toEqual(['RESTART']);
  });

  it('returns undefined rather than throwing for an unknown type', () => {
    // Deliberately different from IntegrationProviderRegistry.resolve, which throws: a
    // provisioning request must become a normalised code on an execution row, not a 404.
    const registry = build();

    expect(() => registry.resolve('KUBERNETES')).not.toThrow();
    expect(registry.resolve('KUBERNETES')).toBeUndefined();
  });
});
