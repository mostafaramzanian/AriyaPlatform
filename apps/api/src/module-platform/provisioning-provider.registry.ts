import { Injectable, Logger } from '@nestjs/common';
import { LocalProvisioningProvider } from './local-provisioning.provider';
import type {
  IModuleProvisioningProvider,
  ProvisioningTargetTypeValue,
} from './module-provisioning.contract';

/**
 * Phase 49M-1: the registry that turns a stored `ProvisioningTarget.targetType` into a
 * provider.
 *
 * ONE ENTRY, BECAUSE THERE IS ONE IMPLEMENTATION — the same rule
 * `IntegrationProviderRegistry` (49L) states for having a single `IntegrationKey`, and
 * `AIProviderRegistry` for declaring exactly four: registering a type with no class
 * behind it lets an administrator save a target the registry cannot resolve, converting a
 * successful save into a 500 on the first action.
 *
 * REMOTE_AGENT IS DELIBERATELY DECLARED AND DELIBERATELY UNRESOLVABLE. It exists in the
 * enum, in the schema and in `describe()` — so the shape a future agent must satisfy is
 * fixed now, and the admin UI can show it as unavailable rather than hiding it — and
 * `resolve()` returns `undefined` for it, which the service normalises to
 * `PROVIDER_UNAVAILABLE`. That combination is what makes "DEFERRED" a visible state
 * instead of a silent gap. It is never reported as a passing capability.
 *
 * THIS CLASS IS WHY THE CONTROL PLANE IS PROVIDER-NEUTRAL RATHER THAN "LOCAL WITH EXTRA
 * STEPS". `ModuleProvisioningService` depends on this registry and on the contract types;
 * it never imports `LocalProvisioningProvider`. Adding a remote agent is: write the
 * adapter, add a case below, add a descriptor. No service change, no schema change (the
 * enum member already exists), and no business module can see any of it.
 */

export interface ProvisioningProviderDescriptor {
  targetType: ProvisioningTargetTypeValue;
  /** Operator-facing label. Persian, because the admin UI is Persian and RTL. */
  displayName: string;
  /**
   * Whether a provider actually exists for this type. FALSE for REMOTE_AGENT, which is
   * how the UI knows to disable its actions rather than offering one that will fail.
   */
  available: boolean;
  /**
   * Steps this provider structurally cannot perform, so the UI can disable exactly those
   * buttons instead of discovering `STEP_UNSUPPORTED` after the operator clicks.
   */
  unsupportedActions: readonly string[];
}

const DESCRIPTORS: Record<ProvisioningTargetTypeValue, ProvisioningProviderDescriptor> = {
  LOCAL_SERVER: {
    targetType: 'LOCAL_SERVER',
    displayName: 'سرور محلی',
    available: true,
    // RESTART only. `stop` IS supported here, in the narrow registry sense the provider
    // documents: an instance can be made ineligible to serve. Restarting requires having
    // started, and nothing in this system did.
    unsupportedActions: ['RESTART'],
  },
  REMOTE_AGENT: {
    targetType: 'REMOTE_AGENT',
    displayName: 'عامل راه دور (پیاده‌سازی نشده)',
    available: false,
    // Every action, because there is no provider at all. Listing only some would imply a
    // partial implementation exists.
    unsupportedActions: [
      'PROVISION',
      'CONFIGURE',
      'VERIFY',
      'ACTIVATE',
      'STOP',
      'RESTART',
      'UPGRADE',
      'ROLLBACK',
      'DECOMMISSION',
    ],
  },
};

@Injectable()
export class ProvisioningProviderRegistry {
  private readonly logger = new Logger(ProvisioningProviderRegistry.name);

  /**
   * Injected by class, not constructed here — `new LocalProvisioningProvider()` would
   * bypass DI and produce a second instance with its own logger and its own
   * `ModuleHealthService`. Same shape `IntegrationProviderRegistry` and
   * `AIProviderRegistry` use.
   */
  constructor(private readonly local: LocalProvisioningProvider) {}

  /**
   * The ONLY lookup into DESCRIPTORS.
   *
   * `DESCRIPTORS[key]` alone is unsafe: it is a plain object literal, so `'constructor'`
   * and friends resolve through `Object.prototype` and return a truthy non-descriptor
   * that an `if (!descriptor)` guard would pass. The own-property check makes every
   * public method below prototype-safe at once — the identical hazard and the identical
   * fix as 49L's registry.
   */
  private descriptor(targetType: string): ProvisioningProviderDescriptor | undefined {
    return Object.prototype.hasOwnProperty.call(DESCRIPTORS, targetType)
      ? DESCRIPTORS[targetType as ProvisioningTargetTypeValue]
      : undefined;
  }

  /** Every declared target type, available or not. Feeds the admin UI. */
  list(): ProvisioningProviderDescriptor[] {
    return Object.values(DESCRIPTORS).map((descriptor) => ({
      ...descriptor,
      unsupportedActions: [...descriptor.unsupportedActions],
    }));
  }

  /** Metadata for one type, or undefined for an unknown string. */
  describe(targetType: string): ProvisioningProviderDescriptor | undefined {
    const descriptor = this.descriptor(targetType);

    return descriptor
      ? { ...descriptor, unsupportedActions: [...descriptor.unsupportedActions] }
      : undefined;
  }

  /** True when this string names a declared target type — available or not. */
  isKnown(targetType: string): boolean {
    return this.descriptor(targetType) !== undefined;
  }

  /**
   * Resolves a target type to its provider, or `undefined`.
   *
   * RETURNS UNDEFINED RATHER THAN THROWING, the one deliberate divergence from
   * `IntegrationProviderRegistry.resolve` (which throws `NotFoundException`). The reason
   * is the caller: a provisioning request against REMOTE_AGENT is an EXPECTED, documented
   * outcome that must become a normalised `PROVIDER_UNAVAILABLE` on an execution row, not
   * a 404 an operator has to interpret. 49L's callers had no such state to record.
   */
  resolve(targetType: string): IModuleProvisioningProvider | undefined {
    switch (targetType) {
      case 'LOCAL_SERVER':
        return this.local;
      case 'REMOTE_AGENT':
        // DEFERRED, not broken. Logged at debug rather than error: this is a configuration
        // an operator can legitimately have, and an error-level line per attempt would
        // train them to ignore the log.
        this.logger.debug({ targetType }, 'REMOTE_AGENT provisioning is not implemented');
        return undefined;
      default:
        this.logger.error({ targetType }, 'Unknown provisioning target type requested');
        return undefined;
    }
  }
}
