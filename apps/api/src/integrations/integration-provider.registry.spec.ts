import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import { N8nIntegrationProvider } from './n8n-integration.provider';

/**
 * Phase 49L: the provider registry and the bounded retry timer.
 *
 * REGISTRY: the point of the tests below is that the key set and the CLASS set cannot
 * drift. A registry entry with no adapter behind it lets an administrator save a
 * configuration that fails on first dispatch, which is precisely the failure
 * `AIProviderRegistry` documents avoiding.
 *
 * TIMER: what matters is that it is bounded, non-overlapping, unref'd and
 * crash-proof — an unhandled rejection in a `setInterval` callback terminates the Node
 * process, so a misconfigured integration would become an outage.
 */

describe('IntegrationProviderRegistry', () => {
  let registry: IntegrationProviderRegistry;
  const n8n = { key: 'N8N' as const, send: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        IntegrationProviderRegistry,
        { provide: N8nIntegrationProvider, useValue: n8n },
      ],
    }).compile();

    registry = moduleRef.get(IntegrationProviderRegistry);
  });

  it('lists exactly the integrations that have an adapter', () => {
    expect(registry.list().map((entry) => entry.key)).toEqual(['N8N']);
  });

  it('carries an operator-facing label and a suggested path, both server-owned', () => {
    const [entry] = registry.list();

    expect(entry.displayName).toContain('n8n');
    // A SUGGESTION, not a workflow id: §1 forbids hard-coding those.
    expect(entry.defaultWebhookPath).toBe('/webhook/aria');
  });

  it('resolves N8N to the DI singleton, not a new instance', () => {
    expect(registry.resolve('N8N')).toBe(n8n);
  });

  it('throws NotFound for an unknown key instead of returning undefined', () => {
    expect(() => registry.resolve('ZAPIER')).toThrow(NotFoundException);
  });

  it('reports unknown keys softly through find/isKnown', () => {
    expect(registry.find('ZAPIER')).toBeUndefined();
    expect(registry.isKnown('ZAPIER')).toBe(false);
    expect(registry.isKnown('N8N')).toBe(true);
  });

  it('is prototype-safe: inherited property names are not integrations', () => {
    // `DESCRIPTORS['constructor']` resolves through Object.prototype and returns a truthy
    // non-descriptor, which a `if (!descriptor)` guard would pass — then explode on
    // `.displayName`. The own-property check is what prevents a 500 here.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(registry.isKnown(name)).toBe(false);
      expect(registry.find(name)).toBeUndefined();
      expect(() => registry.resolve(name)).toThrow(NotFoundException);
    }
  });

  it('hands back COPIES, so a caller cannot mutate the module-level table', () => {
    const first = registry.list();
    first[0].displayName = 'mutated';
    first[0].defaultWebhookPath = '/hacked';

    const second = registry.list();
    expect(second[0].displayName).not.toBe('mutated');
    expect(second[0].defaultWebhookPath).toBe('/webhook/aria');
  });
});
