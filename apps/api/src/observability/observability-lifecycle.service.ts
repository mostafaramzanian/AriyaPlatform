import { Injectable, Logger } from '@nestjs/common';
import { ObservabilityAuditService } from './observability-audit.service';
import { ObservabilityConfigService } from './observability.config';
import { LifecycleEventInput } from './observability.contract';

/**
 * Phase 49M-2: the lifecycle emission seam for 49L / 49M / 49M-1.
 *
 * WHY A SEPARATE FACADE OVER `ObservabilityAuditService.recordLifecycle`: the callers are
 * existing services — `IntegrationService`, `ModuleRegistryService`, `ModuleProvisioningService`
 * — and they must not have to know about durable-write semantics, timeouts or return values to
 * record history. Every method here is `void` and unawaitable-by-accident, so adding a lifecycle
 * emission to an existing method cannot change that method's failure behaviour.
 *
 * WHAT THE NORMALIZATION BUYS: three domains with different vocabularies (an integration
 * dispatch attempt, a module heartbeat, a provisioning step) become ONE indexed table with a
 * shared `phase`, so "what happened around 14:32" is a single query instead of three joins
 * across three tables that do not reference each other. `outcomeCode` keeps each domain's own
 * code verbatim, so nothing is lost in the flattening.
 *
 * IT DOES NOT REPLACE THE DOMAIN TABLES. `IntegrationDelivery`, `ModuleInstance` and the
 * provisioning rows remain the source of truth for CURRENT STATE; this records the TRANSITIONS,
 * which those tables overwrite by design.
 */
@Injectable()
export class ObservabilityLifecycleService {
  private readonly logger = new Logger(ObservabilityLifecycleService.name);

  constructor(
    private readonly durable: ObservabilityAuditService,
    private readonly config: ObservabilityConfigService,
  ) {}

  /**
   * Records one lifecycle transition, fire-and-forget.
   *
   * `void`, NOT `Promise<boolean>`, unlike the durable service it delegates to. A caller in the
   * middle of a provisioning step must not be able to fail because the history write failed —
   * and it must not be able to accidentally add a database round trip to its own latency by
   * awaiting. The failure is still counted and surfaced by the health probe.
   */
  record(input: LifecycleEventInput): void {
    if (!this.config.enabled) return;
    void this.durable.recordLifecycle(input).catch(() => {
      // `recordLifecycle` already swallows and counts its own failures; this catch exists only
      // so an unexpected synchronous throw cannot become an unhandled rejection.
    });
  }

  /** 49L: an integration dispatch or callback transition. */
  integration(
    eventType: string,
    phase: LifecycleEventInput['phase'],
    subject: { id?: string; key?: string },
    extra: Partial<LifecycleEventInput> = {},
  ): void {
    this.record({
      domain: 'INTEGRATION',
      eventType,
      phase,
      subjectType: 'integration',
      subjectId: subject.id,
      subjectKey: subject.key,
      actorType: extra.actorType ?? 'SYSTEM',
      ...extra,
    });
  }

  /** 49M: a module registration, heartbeat, health or invocation transition. */
  module(
    eventType: string,
    phase: LifecycleEventInput['phase'],
    subject: { id?: string; key?: string },
    extra: Partial<LifecycleEventInput> = {},
  ): void {
    this.record({
      domain: 'MODULE',
      eventType,
      phase,
      subjectType: 'module',
      subjectId: subject.id,
      subjectKey: subject.key,
      actorType: extra.actorType ?? 'SYSTEM',
      ...extra,
    });
  }

  /** 49M-1: a provisioning run or step transition. */
  provisioning(
    eventType: string,
    phase: LifecycleEventInput['phase'],
    subject: { id?: string; key?: string },
    extra: Partial<LifecycleEventInput> = {},
  ): void {
    this.record({
      domain: 'PROVISIONING',
      eventType,
      phase,
      subjectType: 'provisioning',
      subjectId: subject.id,
      subjectKey: subject.key,
      actorType: extra.actorType ?? 'SYSTEM',
      ...extra,
    });
  }
}
