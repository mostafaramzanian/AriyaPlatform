import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { N8nIntegrationProvider } from './n8n-integration.provider';
import type { IntegrationProvider } from './integration.contract';

/**
 * Phase 49L §3: the registry that turns a stored `IntegrationKey` into an adapter.
 *
 * ONE KEY, BECAUSE THERE IS ONE IMPLEMENTATION. `src/integrations` contains
 * `N8nIntegrationProvider` and nothing else. A second entry (Zapier, Make,
 * Temporal…) was considered and dropped for the same reason `AIProviderRegistry`
 * declares exactly four: registering a key with no class behind it would let an
 * administrator save a configuration the registry cannot resolve, converting a
 * successful save into a 500 on the first dispatch. The `IntegrationKey` enum in
 * the Prisma schema has the same single member for the same reason.
 *
 * THIS CLASS IS WHY THE PLATFORM IS PROVIDER-NEUTRAL RATHER THAN "n8n WITH EXTRA
 * STEPS". `AutomationService` depends on this registry and on the contract types;
 * it never imports `N8nIntegrationProvider`. Adding a second engine is: write an
 * adapter, add an enum member, add a case below, add a descriptor. No business
 * module changes, because no business module can see any of it.
 *
 * Descriptors carry the operator-facing label so the admin UI does not hold its own
 * copy of a name the backend owns — the same rule `AIProviderRegistry.list()`
 * follows for the AI capability matrix.
 */

export type IntegrationKeyValue = 'N8N';

export interface IntegrationDescriptor {
  key: IntegrationKeyValue;
  /** Operator-facing label. Persian, because the admin UI is Persian and RTL. */
  displayName: string;
  /**
   * Default webhook path suggested in the UI when creating the row.
   *
   * `/webhook/aria` and not a workflow id: §1 forbids hard-coding workflow ids, and
   * the path is the operator's to choose in n8n. This is a SUGGESTION rendered as a
   * placeholder, never a value written without the operator confirming it.
   */
  defaultWebhookPath: string;
}

const DESCRIPTORS: Record<IntegrationKeyValue, IntegrationDescriptor> = {
  N8N: {
    key: 'N8N',
    displayName: 'n8n (اتوماسیون محلی)',
    defaultWebhookPath: '/webhook/aria',
  },
};

@Injectable()
export class IntegrationProviderRegistry {
  private readonly logger = new Logger(IntegrationProviderRegistry.name);

  /**
   * Injected by class, not constructed here. `new N8nIntegrationProvider()` would
   * bypass DI and produce a second instance with its own logger — the same reason
   * `AIProviderRegistry` takes its four providers as constructor parameters.
   */
  constructor(private readonly n8n: N8nIntegrationProvider) {}

  /**
   * The ONLY lookup into DESCRIPTORS.
   *
   * `DESCRIPTORS[key]` alone is unsafe: it is a plain object literal, so
   * `'constructor'` and friends resolve through `Object.prototype` and return a
   * truthy non-descriptor, which a `if (!descriptor)` guard would then pass. The
   * own-property check makes every public method below prototype-safe at once.
   */
  private descriptor(key: string): IntegrationDescriptor | undefined {
    return Object.prototype.hasOwnProperty.call(DESCRIPTORS, key)
      ? DESCRIPTORS[key as IntegrationKeyValue]
      : undefined;
  }

  /** Every registered integration. Feeds the admin UI. */
  list(): IntegrationDescriptor[] {
    return Object.values(DESCRIPTORS).map((descriptor) => ({ ...descriptor }));
  }

  /** Metadata for one key, or undefined for an unknown string. */
  find(key: string): IntegrationDescriptor | undefined {
    const descriptor = this.descriptor(key);
    return descriptor ? { ...descriptor } : undefined;
  }

  /** True when this key names a registered adapter. */
  isKnown(key: string): boolean {
    return this.descriptor(key) !== undefined;
  }

  /**
   * Resolves a key to its adapter.
   *
   * Throws `NotFoundException` on an unknown key rather than returning undefined:
   * the callers are dispatch and the connection test, and both would otherwise have
   * to re-check, which is where a silent `undefined` becomes a confusing TypeError
   * deeper in the stack. A stored row can only hold an enum value, so this can
   * realistically only fire if the enum and this file diverge.
   */
  resolve(key: string): IntegrationProvider {
    switch (key) {
      case 'N8N':
        return this.n8n;
      default:
        this.logger.error({ key }, 'Unknown integration key requested');
        throw new NotFoundException(`Unknown integration: ${key}`);
    }
  }
}
