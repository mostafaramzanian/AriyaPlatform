import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { AutomationStatus, IntegrationKey, Prisma } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityLifecycleService } from '../observability/observability-lifecycle.service';
import type {
  LifecycleEventInput,
  LifecyclePhaseValue,
} from '../observability/observability.contract';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import { assertIntegrationUrlAllowed, evaluateIntegrationUrl } from './integration-url.guard';
import { idempotencyKeyFor } from './integration-signature';
import {
  ENVELOPE_VERSION,
  INTEGRATION_EVENT_VERSIONS,
  MAX_ENVELOPE_BYTES,
  PROBE_EVENT_TYPE,
  type AutomationDispatchResult,
  type IntegrationEvent,
  type IntegrationEventType,
  type TriggerAutomationInput,
} from './integration.contract';
import {
  CreateIntegrationDto,
  IntegrationCallbackDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

/**
 * Phase 49L: owns integration configuration, outbound dispatch, execution
 * tracking, bounded retry and inbound callback resolution.
 *
 * SIX RULES THIS CLASS EXISTS TO ENFORCE:
 *
 * 1. THE SECRET NEVER LEAVES. `toPublic()` is the ONLY projection any route uses,
 *    and it has no branch that emits the ciphertext, the IV or the tag — not for
 *    SUPER_ADMIN, not on create where the plaintext is in hand, not in an error
 *    message. A caller learns whether a secret is stored and when it changed.
 *
 * 2. A BUSINESS OPERATION NEVER FAILS BECAUSE AUTOMATION FAILED (§22). Every path
 *    in `trigger` catches, records and returns; nothing propagates. `dispatched:
 *    false` is a normal outcome, not an error.
 *
 * 3. IDEMPOTENCY IS ENFORCED BY THE DATABASE (§18). The key is deterministic and
 *    unique-indexed, so two concurrent triggers for one event cannot both insert.
 *    The second observes P2002 and returns the existing row.
 *
 * 4. RETRY IS BOUNDED AND CLAIMED (§21). `maxAttempts` is 1-5, the backoff is
 *    fixed and finite, and a claim is a conditional UPDATE — the same mechanism
 *    `ReminderDispatcherService` uses, so two API instances cannot both retry one
 *    row.
 *
 * 5. A CALLBACK CAN ONLY CHANGE DELIVERY STATUS. `applyCallback` resolves one
 *    execution by (integration, eventId) and writes status/reference/error. It
 *    performs no other mutation, and there is no code path from a callback body to
 *    any other table.
 *
 * 6. TENANT IS NEVER WIDENED. Every execution read applies the caller's tenant
 *    predicate unconditionally, INCLUDING when it is null — dropping a null tenant
 *    would silently expose every tenant-less execution in the database.
 */

/** Audit action names, one per state change worth reconstructing later (§27). */
const AUDIT_ACTIONS = {
  CREATED: 'INTEGRATION_CREATED',
  UPDATED: 'INTEGRATION_UPDATED',
  ENABLED: 'INTEGRATION_ENABLED',
  DISABLED: 'INTEGRATION_DISABLED',
  SECRET_ROTATED: 'INTEGRATION_SECRET_ROTATED',
  DELETED: 'INTEGRATION_DELETED',
  CONNECTION_TESTED: 'INTEGRATION_CONNECTION_TESTED',
  MANUAL_TRIGGER: 'AUTOMATION_MANUALLY_TRIGGERED',
} as const;

/**
 * Phase 49M-2: lifecycle event types emitted alongside the audit trail.
 *
 * ONE NAME PER LOGICAL TRANSITION, and deliberately NOT one per `record(...)` call. An
 * `updateConfig` that also flips `enabled` writes TWO audit rows — `INTEGRATION_UPDATED`
 * plus `INTEGRATION_ENABLED` — because an auditor queries by action name. The lifecycle
 * table answers a different question ("what happened to this subject, in order"), so the
 * same call emits exactly ONE row whose `eventType` names the most specific transition:
 * `integration.enabled` wins over `integration.updated`. Emitting both would double-count
 * one operator action in the timeline.
 *
 * `dotted.lowercase`, matching `PROVISIONING_AUDIT_ACTIONS` and unlike this file's own
 * SCREAMING_SNAKE audit actions: `eventType` here is a cross-domain key that is filtered
 * with `startsWith('integration.')`, not an audit action name.
 */
const LIFECYCLE_EVENTS = {
  CREATED: 'integration.config.created',
  UPDATED: 'integration.config.updated',
  ENABLED: 'integration.config.enabled',
  DISABLED: 'integration.config.disabled',
  SECRET_ROTATED: 'integration.config.secret_rotated',
  DELETED: 'integration.config.deleted',
  CONNECTION_TESTED: 'integration.connection.tested',
} as const;

/**
 * Fixed backoff schedule, in milliseconds, indexed by attempt number already made.
 *
 * EXPLICIT ARRAY RATHER THAN AN EXPONENTIAL FORMULA, because the maximum is 5
 * attempts: a formula would need its own cap and would read as if it scaled. The
 * schedule is short — a failed automation should surface within minutes, not hours
 * — and it terminates. There is no jitter because there is no thundering herd to
 * spread: the retry pass claims a bounded batch on a fixed tick.
 */
const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 600_000] as const;

/** Bytes of entropy in a generated shared secret. 32 bytes → 64 hex characters. */
const SECRET_BYTES = 32;

/** Rows one retry tick may claim. Bounded so a tick cannot fan out unboundedly. */
export const RETRY_BATCH_SIZE = 25;

/** Page size ceiling for the execution list. */
export const MAX_EXECUTION_PAGE = 50;
export const DEFAULT_EXECUTION_PAGE = 20;

export interface PublicIntegrationConfig {
  id: string;
  integration: IntegrationKey;
  baseUrl: string;
  webhookPath: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  /** Whether a secret is stored. NOT the secret, nor its length. */
  hasSecret: boolean;
  secretUpdatedAt: Date | null;
  lastTestStatus: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicAutomationExecution {
  id: string;
  integration: IntegrationKey;
  eventId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  status: AutomationStatus;
  externalExecutionId: string | null;
  attemptCount: number;
  errorCode: string | null;
  correlationId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface IntegrationTestResult {
  status: 'SUCCESS' | 'FAILURE';
  /** Operator-facing Persian message. Never an upstream body or a secret. */
  message: string;
}

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationProviderRegistry,
    private readonly crypto: CryptoService,
    // Optional for the same reason SupportService and AIConfigService make it
    // optional: a trimmed test module must be able to exercise the domain rules
    // without wiring the audit pipeline, and a missing audit sink must never break
    // business logic.
    @Optional() private readonly audit?: AuditService,
    // 49M-2: the lifecycle timeline. OPTIONAL FOR A SECOND, INDEPENDENT REASON on top of
    // the one above — `ObservabilityModule` is `@Global()`, so in the real graph this is
    // always present, but `integration.service.spec.ts` builds the subject from an explicit
    // provider list. A required dependency there would fail to resolve, which would make
    // adding observability a breaking change to every existing test of this class. It is
    // also correct in production: observability is optional infrastructure (see
    // `ObservabilityPrismaService`), so a business mutation must not depend on its presence.
    @Optional() private readonly lifecycle?: ObservabilityLifecycleService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Configured rows plus the registry's descriptors, so the UI never needs its own
   * copy of "which integrations exist" — a copy that would drift the moment an
   * adapter is added or withdrawn. Same rule `AIConfigService.listConfigs` follows.
   */
  async listConfigs(): Promise<{
    configs: PublicIntegrationConfig[];
    integrations: ReturnType<IntegrationProviderRegistry['list']>;
  }> {
    const rows = await this.prisma.integrationConfig.findMany({
      orderBy: { integration: 'asc' },
    });

    return {
      configs: rows.map((row) => this.toPublic(row)),
      integrations: this.registry.list(),
    };
  }

  async getConfig(id: string): Promise<PublicIntegrationConfig> {
    return this.toPublic(await this.loadOrThrow(id));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration writes
  // ───────────────────────────────────────────────────────────────────────────

  async createConfig(
    actorId: string,
    dto: CreateIntegrationDto,
  ): Promise<PublicIntegrationConfig> {
    if (!this.registry.isKnown(dto.integration)) {
      throw new BadRequestException(`Unknown integration: ${dto.integration}`);
    }

    // THE SSRF DECISION, made before anything is stored. A rejected URL never
    // reaches the database, so a later dispatch cannot inherit it.
    assertIntegrationUrlAllowed(dto.baseUrl);

    // Enabling without a secret would mean dispatching unsigned events. Refused
    // here with a readable message rather than discovered at first dispatch.
    if ((dto.enabled ?? false) && !dto.secret) {
      throw new BadRequestException(
        'An integration cannot be enabled before its webhook secret is set',
      );
    }

    const envelope = dto.secret ? this.crypto.encrypt(dto.secret) : null;

    try {
      const created = await this.prisma.integrationConfig.create({
        data: {
          integration: dto.integration as IntegrationKey,
          baseUrl: dto.baseUrl,
          webhookPath: dto.webhookPath,
          enabled: dto.enabled ?? false,
          timeoutMs: dto.timeoutMs ?? 10_000,
          maxAttempts: dto.maxAttempts ?? 3,
          secretCiphertext: envelope?.ciphertext ?? null,
          secretIv: envelope?.iv ?? null,
          secretAuthTag: envelope?.authTag ?? null,
          secretUpdatedAt: envelope ? new Date() : null,
        },
      });

      await this.record(AUDIT_ACTIONS.CREATED, actorId, created.id, {
        integration: created.integration,
        baseUrl: created.baseUrl,
        webhookPath: created.webhookPath,
        enabled: created.enabled,
        timeoutMs: created.timeoutMs,
        maxAttempts: created.maxAttempts,
        // Presence only. The secret itself is never in an audit payload.
        hasSecret: Boolean(envelope),
      });

      this.emitLifecycle(
        LIFECYCLE_EVENTS.CREATED,
        'SUCCEEDED',
        created.id,
        actorId,
        created.integration,
        { enabled: created.enabled, hasSecret: Boolean(envelope) },
      );

      return this.toPublic(created);
    } catch (err) {
      throw this.translateWriteError(err, dto.integration);
    }
  }

  /**
   * Partial update.
   *
   * `integration` is not accepted (see the DTO): retargeting a row would move a
   * secret negotiated with one engine onto another.
   *
   * ENABLE IS GUARDED. A row may only be enabled when a secret exists — either
   * already stored or supplied in this same request — because an enabled row with
   * no secret would dispatch unsigned envelopes.
   */
  async updateConfig(
    actorId: string,
    id: string,
    dto: UpdateIntegrationDto,
  ): Promise<PublicIntegrationConfig> {
    const before = await this.loadOrThrow(id);

    if (dto.baseUrl !== undefined) {
      assertIntegrationUrlAllowed(dto.baseUrl);
    }

    const willHaveSecret = Boolean(dto.secret) || Boolean(before.secretCiphertext);

    if (dto.enabled === true && !willHaveSecret) {
      throw new BadRequestException(
        'An integration cannot be enabled before its webhook secret is set',
      );
    }

    const envelope = dto.secret ? this.crypto.encrypt(dto.secret) : null;

    const data: Prisma.IntegrationConfigUpdateInput = {
      ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl } : {}),
      ...(dto.webhookPath !== undefined ? { webhookPath: dto.webhookPath } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
      ...(dto.maxAttempts !== undefined ? { maxAttempts: dto.maxAttempts } : {}),
      ...(envelope
        ? {
            secretCiphertext: envelope.ciphertext,
            secretIv: envelope.iv,
            secretAuthTag: envelope.authTag,
            secretUpdatedAt: new Date(),
          }
        : {}),
    };

    if (Object.keys(data).length === 0) {
      // Nothing to do. Returning the row rather than 400ing keeps a no-op PATCH
      // idempotent, which matters because the UI submits the whole form back.
      return this.toPublic(before);
    }

    const updated = await this.prisma.integrationConfig.update({ where: { id }, data });
    const changedFields = Object.keys(data);

    await this.record(AUDIT_ACTIONS.UPDATED, actorId, id, {
      integration: updated.integration,
      changedFields,
      baseUrl: updated.baseUrl,
      webhookPath: updated.webhookPath,
      timeoutMs: updated.timeoutMs,
      maxAttempts: updated.maxAttempts,
    });

    // Enable/disable and secret rotation get their OWN audit entries: they are the
    // three transitions an operator or an auditor actually looks for, and finding
    // them inside a generic "updated" payload's `changedFields` is not the same as
    // being able to query the action name.
    if (dto.enabled !== undefined && dto.enabled !== before.enabled) {
      await this.record(
        dto.enabled ? AUDIT_ACTIONS.ENABLED : AUDIT_ACTIONS.DISABLED,
        actorId,
        id,
        { integration: updated.integration },
      );
    }

    if (envelope) {
      await this.record(AUDIT_ACTIONS.SECRET_ROTATED, actorId, id, {
        integration: updated.integration,
        // Presence and timing only.
        rotatedAt: updated.secretUpdatedAt,
      });
    }

    // ONE lifecycle row for this whole call, even though up to three audit rows were just
    // written. The event type names the most specific transition — an enable/disable outranks
    // a generic update, and a rotation performed as part of an update is reported through
    // `secretRotated` in `detail` rather than as a second row. See LIFECYCLE_EVENTS.
    const enabledChanged = dto.enabled !== undefined && dto.enabled !== before.enabled;

    this.emitLifecycle(
      enabledChanged
        ? dto.enabled
          ? LIFECYCLE_EVENTS.ENABLED
          : LIFECYCLE_EVENTS.DISABLED
        : LIFECYCLE_EVENTS.UPDATED,
      'SUCCEEDED',
      id,
      actorId,
      updated.integration,
      {
        // Field NAMES only. A value could be the baseUrl, which §39 keeps out of a
        // lifecycle row.
        changedFields,
        enabled: updated.enabled,
        secretRotated: Boolean(envelope),
      },
    );

    return this.toPublic(updated);
  }

  /**
   * Generates a fresh shared secret server-side and stores it.
   *
   * RETURNED EXACTLY ONCE, in the response to this call, and never again by any
   * route: the operator must paste it into the engine, and there is no second
   * chance to read it. That is the same one-way property `AIProviderConfig`
   * credentials have, with the difference that here Aria is the ORIGIN of the
   * secret, so it has to be shown once or it could never be configured.
   *
   * 32 random bytes rendered as 64 hex characters — above `MIN_WEBHOOK_SECRET`, and
   * generated with `randomBytes`, never `Math.random`.
   */
  async rotateSecret(actorId: string, id: string): Promise<{ secret: string }> {
    const row = await this.loadOrThrow(id);

    const secret = randomBytes(SECRET_BYTES).toString('hex');
    const envelope = this.crypto.encrypt(secret);

    await this.prisma.integrationConfig.update({
      where: { id },
      data: {
        secretCiphertext: envelope.ciphertext,
        secretIv: envelope.iv,
        secretAuthTag: envelope.authTag,
        secretUpdatedAt: new Date(),
      },
    });

    await this.record(AUDIT_ACTIONS.SECRET_ROTATED, actorId, id, { generated: true });

    // `generated: true` and nothing else, exactly as the audit payload above. The rotation
    // is the fact; the 64 hex characters this method returns to the operator never enter
    // either trail.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.SECRET_ROTATED,
      'SUCCEEDED',
      id,
      actorId,
      row.integration,
      { generated: true },
    );

    return { secret };
  }

  async deleteConfig(actorId: string, id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.loadOrThrow(id);

    await this.prisma.integrationConfig.delete({ where: { id } });

    await this.record(AUDIT_ACTIONS.DELETED, actorId, id, {
      integration: row.integration,
      baseUrl: row.baseUrl,
    });

    // NO `baseUrl`, unlike the audit payload one line above. The audit trail is the place an
    // investigator needs to know which endpoint was removed; a lifecycle row is read
    // operationally and §39 keeps endpoints out of it.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.DELETED,
      'SUCCEEDED',
      id,
      actorId,
      row.integration,
      { wasEnabled: row.enabled },
    );

    return { id, deleted: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Outbound dispatch
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Emits one domain event to every enabled integration.
   *
   * THIS METHOD NEVER THROWS FOR AN INTEGRATION PROBLEM (§22). A missing config, a
   * disabled row, a blocked URL, an unreachable engine, a timeout, a 500 — all of
   * them come back as a result object. The only exceptions it raises are for a
   * CALLER mistake (unknown event type, over-large payload), because those are bugs
   * in the calling module rather than states of the world.
   *
   * ASYNC BY DEFAULT (§23). The HTTP attempt IS awaited here — one bounded call with
   * a hard timeout, so a triggering request waits at most `timeoutMs` — but its
   * failure does not propagate. A truly fire-and-forget dispatch was considered and
   * rejected: an unawaited promise inside a request means the process can exit
   * mid-flight, and Nest offers no lifecycle hook that would let the caller know.
   * Retries, by contrast, are genuinely out-of-band on the bounded pass.
   */
  async trigger(input: TriggerAutomationInput): Promise<AutomationDispatchResult> {
    const version = INTEGRATION_EVENT_VERSIONS[input.eventType as IntegrationEventType];

    // An event type not in the contract is a CALLER bug: nothing in the engine is
    // bound to it, so dispatching would be a silent no-op forever.
    if (version === undefined) {
      throw new BadRequestException(`Unknown integration event type: ${input.eventType}`);
    }

    const context = RequestContextService.get();
    const eventId = input.eventId ?? randomUUID();

    const envelope: IntegrationEvent = {
      eventId,
      eventType: input.eventType,
      version,
      occurredAt: new Date().toISOString(),
      source: input.source,
      tenant: { id: input.tenantId ?? context?.tenantId ?? null },
      ...(input.actor ? { actor: input.actor } : {}),
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      payload: input.payload,
    };

    // §11/§44: bounded payload. Checked on the SERIALISED form, because that is
    // what crosses the wire and what the signature covers.
    const serialisedBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');

    if (serialisedBytes > MAX_ENVELOPE_BYTES) {
      throw new BadRequestException(
        `Integration event payload exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      );
    }

    const config = await this.prisma.integrationConfig.findFirst({
      where: { enabled: true },
      orderBy: { integration: 'asc' },
    });

    // NO INTEGRATION CONFIGURED OR ENABLED IS A NORMAL STATE, not a failure. No row
    // is written: an execution row nothing will ever retry or complete is noise, and
    // it would make "how many automations failed" unanswerable.
    if (!config) {
      return { dispatched: false, status: 'SKIPPED' };
    }

    return this.dispatchTo(config, envelope, input.actor?.id ?? context?.userId ?? null);
  }

  /**
   * Records the execution, then attempts delivery once.
   *
   * THE ROW IS WRITTEN BEFORE THE ATTEMPT, deliberately. If the process dies during
   * the HTTP call the event is still visible as PENDING and the retry pass picks it
   * up; the reverse ordering would lose it entirely. The cost is that a crash can
   * produce a duplicate delivery, which is exactly what the idempotency key exists
   * to let the consumer absorb.
   */
  private async dispatchTo(
    config: { id: string; integration: IntegrationKey; baseUrl: string; webhookPath: string; timeoutMs: number; maxAttempts: number; secretCiphertext: string | null; secretIv: string | null; secretAuthTag: string | null },
    envelope: IntegrationEvent,
    actorId: string | null,
  ): Promise<AutomationDispatchResult> {
    const idempotencyKey = idempotencyKeyFor(
      config.integration,
      envelope.eventId,
      envelope.version,
    );

    let execution: { id: string; status: AutomationStatus };

    try {
      execution = await this.prisma.automationExecution.create({
        data: {
          integration: config.integration,
          eventId: envelope.eventId,
          eventType: envelope.eventType,
          eventVersion: envelope.version,
          source: envelope.source,
          idempotencyKey,
          tenantId: envelope.tenant.id,
          actorId,
          correlationId: envelope.correlationId ?? null,
          status: AutomationStatus.PENDING,
        },
        select: { id: true, status: true },
      });
    } catch (err) {
      // P2002 on `idempotencyKey` means this exact event was already dispatched.
      // Returning the EXISTING outcome is the §18 contract: a duplicate must not
      // produce a second delivery, and must not look like an error either.
      if (this.isUniqueViolation(err)) {
        const existing = await this.prisma.automationExecution.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true },
        });

        return {
          dispatched: false,
          duplicate: true,
          executionId: existing?.id,
          status: existing?.status ?? 'PENDING',
        };
      }

      throw err;
    }

    const secret = this.readSecret(config);

    // An enabled row with no readable secret cannot be signed for. Recorded as
    // FAILED and NOT retried: retrying cannot conjure a secret.
    if (!secret) {
      await this.finalise(execution.id, AutomationStatus.FAILED, 'NO_SECRET');
      return { dispatched: false, executionId: execution.id, status: 'FAILED', errorCode: 'NO_SECRET' };
    }

    return this.attempt(config, execution.id, envelope, secret, 0);
  }

  /**
   * One delivery attempt, plus the state transition it implies.
   *
   * `attemptsAlready` is passed in rather than re-read, so the retry pass and the
   * first dispatch share exactly one attempt/transition implementation — there is no
   * second place where "how many tries are left" could be computed differently.
   */
  private async attempt(
    config: {
      integration: IntegrationKey;
      baseUrl: string;
      webhookPath: string;
      timeoutMs: number;
      maxAttempts: number;
    },
    executionId: string,
    envelope: IntegrationEvent,
    secret: string,
    attemptsAlready: number,
  ): Promise<AutomationDispatchResult> {
    const provider = this.registry.resolve(config.integration);
    const attemptNumber = attemptsAlready + 1;

    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        attemptCount: attemptNumber,
        startedAt: attemptsAlready === 0 ? new Date() : undefined,
        // Cleared so a crash mid-attempt leaves the row claimable again rather than
        // stuck: the next tick sees a due row and retries it.
        nextAttemptAt: null,
      },
    });

    const result = await provider.send(
      {
        baseUrl: config.baseUrl,
        webhookPath: config.webhookPath,
        timeoutMs: config.timeoutMs,
      },
      envelope,
      secret,
    );

    if (result.accepted) {
      // ACCEPTED when the engine returned a reference, SENT when it returned 2xx and
      // nothing else. The distinction is honest rather than cosmetic: only ACCEPTED
      // means something exists on the other side that a callback can refer to.
      const status = result.externalExecutionId
        ? AutomationStatus.ACCEPTED
        : AutomationStatus.SENT;

      await this.prisma.automationExecution.update({
        where: { id: executionId },
        data: {
          status,
          externalExecutionId: result.externalExecutionId ?? null,
          errorCode: null,
          nextAttemptAt: null,
        },
      });

      return {
        dispatched: true,
        executionId,
        status: status === AutomationStatus.ACCEPTED ? 'ACCEPTED' : 'SENT',
      };
    }

    // BOUNDED (§21). `canRetry` requires BOTH that the failure class is retryable
    // and that the budget is not spent; there is no branch that schedules an
    // attempt beyond `maxAttempts`, and `nextAttemptAt` is only ever set from the
    // finite `RETRY_BACKOFF_MS` table.
    const canRetry = Boolean(result.retryable) && attemptNumber < config.maxAttempts;

    if (!canRetry) {
      await this.finalise(executionId, AutomationStatus.FAILED, result.errorCode ?? 'UNKNOWN');
      return {
        dispatched: false,
        executionId,
        status: 'FAILED',
        errorCode: result.errorCode,
      };
    }

    const delay = RETRY_BACKOFF_MS[Math.min(attemptsAlready, RETRY_BACKOFF_MS.length - 1)];

    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status: AutomationStatus.RETRYING,
        errorCode: result.errorCode ?? null,
        nextAttemptAt: new Date(Date.now() + delay),
      },
    });

    return {
      dispatched: false,
      executionId,
      status: 'RETRYING',
      errorCode: result.errorCode,
    };
  }

  /**
   * The bounded retry pass. Called by `AutomationRetryService` on a fixed tick.
   *
   * CLAIMS EACH ROW WITH A CONDITIONAL UPDATE, exactly as
   * `ReminderDispatcherService.deliverOne` does: `updateMany` with
   * `status: RETRYING` and `nextAttemptAt <= now` in the WHERE clause means Postgres
   * serialises concurrent writers on that row, so at most ONE caller sees
   * `count === 1`. A second API instance, an overlapping tick or a restart observes
   * zero and does nothing. Nothing about correctness depends on there being a single
   * process, and no advisory lock or queue table is needed.
   */
  async processRetries(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.automationExecution.findMany({
      where: {
        status: AutomationStatus.RETRYING,
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: RETRY_BATCH_SIZE,
    });

    let retried = 0;

    for (const row of due) {
      // THE claim. `nextAttemptAt: { lte: now }` inside the predicate is what makes
      // it exclusive; setting it to null takes the row out of the partial index.
      const claim = await this.prisma.automationExecution.updateMany({
        where: {
          id: row.id,
          status: AutomationStatus.RETRYING,
          nextAttemptAt: { lte: now },
        },
        data: { nextAttemptAt: null },
      });

      if (claim.count === 0) continue;

      const config = await this.prisma.integrationConfig.findUnique({
        where: { integration: row.integration },
      });

      // The integration was deleted or disabled between attempts. Terminal, and not
      // an error: there is nowhere left to deliver.
      if (!config || !config.enabled) {
        await this.finalise(row.id, AutomationStatus.FAILED, 'INTEGRATION_UNAVAILABLE');
        continue;
      }

      const secret = this.readSecret(config);

      if (!secret) {
        await this.finalise(row.id, AutomationStatus.FAILED, 'NO_SECRET');
        continue;
      }

      // THE PAYLOAD IS NOT STORED, so a retry cannot resend the original body. The
      // envelope is rebuilt from the recorded contract fields with an EMPTY payload
      // and the ORIGINAL eventId, so the consumer's own idempotency key still
      // matches and it can recognise the redelivery. This is the deliberate cost of
      // not persisting payloads (§19) and it is stated in the closure report rather
      // than hidden: a retry proves reachability and redelivers the event IDENTITY,
      // not the original body.
      const envelope: IntegrationEvent = {
        eventId: row.eventId,
        eventType: row.eventType as IntegrationEventType,
        version: row.eventVersion,
        occurredAt: row.createdAt.toISOString(),
        source: row.source as IntegrationEvent['source'],
        tenant: { id: row.tenantId },
        ...(row.correlationId ? { correlationId: row.correlationId } : {}),
        payload: {},
      };

      try {
        await this.attempt(config, row.id, envelope, secret, row.attemptCount);
        retried += 1;
      } catch (err) {
        // A tick must never crash the process. The row keeps its state and the next
        // tick reconsiders it.
        this.logger.error(
          { executionId: row.id, err: err instanceof Error ? err.message : 'unknown' },
          'Automation retry attempt threw',
        );
      }
    }

    return retried;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Inbound callback
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Applies a VERIFIED callback to one execution (§24/§25).
   *
   * THIS IS THE ONLY WAY AN EXTERNAL SYSTEM CAN CHANGE ANY STATE IN ARIA, and the
   * total surface of that change is: `status`, `externalExecutionId`, `errorCode`,
   * `completedAt`, on exactly one row located by (integration, eventId). There is no
   * table name, column name, operator or filter in the callback contract, so there
   * is no path from a callback body to any other row anywhere.
   *
   * SIGNATURE VERIFICATION HAPPENS IN THE CONTROLLER, before this method is reached,
   * because it needs the raw headers and body. This method assumes the caller is
   * authenticated and enforces the remaining rules: the event must exist, the
   * integration must match, and the transition must be legal.
   *
   * REPLAY PROTECTION IS THE TERMINAL-STATE CHECK (§17). A signed callback replayed
   * inside the timestamp window finds the row already COMPLETED/FAILED and gets the
   * EXISTING outcome back — the §18 "duplicate → return existing outcome safely"
   * contract. It does not re-run anything, and it is not reported as an error,
   * because a well-behaved engine retrying a callback it never saw acknowledged is
   * doing the right thing.
   */
  async applyCallback(
    integration: string,
    dto: IntegrationCallbackDto,
  ): Promise<{ executionId: string; status: AutomationStatus; duplicate: boolean }> {
    // The path parameter and the signed body must agree. Trusting either one alone
    // would let a signature over integration A be replayed onto integration B.
    if (dto.integration !== integration) {
      throw new BadRequestException('Callback integration does not match the route');
    }

    const execution = await this.prisma.automationExecution.findUnique({
      where: {
        integration_eventId: {
          integration: integration as IntegrationKey,
          eventId: dto.eventId,
        },
      },
      select: { id: true, status: true },
    });

    // An unknown event is a 404 and NOT a 400: the two are indistinguishable to the
    // caller by design, so a callback cannot be used to probe which events exist.
    if (!execution) {
      throw new NotFoundException('Automation execution not found');
    }

    const alreadyTerminal =
      execution.status === AutomationStatus.COMPLETED ||
      execution.status === AutomationStatus.FAILED;

    if (alreadyTerminal) {
      return { executionId: execution.id, status: execution.status, duplicate: true };
    }

    const status =
      dto.status === 'COMPLETED' ? AutomationStatus.COMPLETED : AutomationStatus.FAILED;

    // Conditional on the row still being non-terminal, so two concurrent callbacks
    // cannot both write: the loser matches zero rows and reads the winner's outcome.
    const claim = await this.prisma.automationExecution.updateMany({
      where: {
        id: execution.id,
        status: { notIn: [AutomationStatus.COMPLETED, AutomationStatus.FAILED] },
      },
      data: {
        status,
        completedAt: new Date(),
        nextAttemptAt: null,
        ...(dto.externalExecutionId ? { externalExecutionId: dto.externalExecutionId } : {}),
        ...(dto.errorCode ? { errorCode: dto.errorCode } : {}),
      },
    });

    if (claim.count === 0) {
      const current = await this.prisma.automationExecution.findUnique({
        where: { id: execution.id },
        select: { status: true },
      });

      return {
        executionId: execution.id,
        status: current?.status ?? execution.status,
        duplicate: true,
      };
    }

    return { executionId: execution.id, status, duplicate: false };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection test
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Live probe against the configured engine, using a FIXED server-side event.
   *
   * Returns SUCCESS/FAILURE for both outcomes, matching
   * `AIConfigService.testConnection`: a failed probe is not an HTTP error — the
   * request itself succeeded — and mapping it to a 4xx would make "the engine is
   * down" indistinguishable from "this endpoint is broken" for the UI.
   *
   * THE RETURNED MESSAGE CARRIES NO UPSTREAM DETAIL. No status code, no response
   * body, no latency: a status code distinguishes "no such workflow" from "signature
   * rejected" from "engine down", which turns this endpoint into a probe for the
   * operator's infrastructure. The detail IS logged; it is simply not returned.
   *
   * IT WRITES NO EXECUTION ROW. A test is not a domain event, and recording one
   * would pollute the delivery history §19 exists to keep meaningful. The outcome is
   * recorded on the CONFIG row (`lastTestStatus` / `lastTestedAt`) instead.
   */
  async testConnection(actorId: string, id: string): Promise<IntegrationTestResult> {
    const row = await this.loadOrThrow(id);

    let result: IntegrationTestResult;

    try {
      const policy = evaluateIntegrationUrl(row.baseUrl);

      if (!policy.ok) {
        result = { status: 'FAILURE', message: policy.message ?? 'نشانی مجاز نیست.' };
      } else {
        const secret = this.readSecret(row);

        if (!secret) {
          result = {
            status: 'FAILURE',
            message: 'کلید امضا ذخیره نشده است؛ ابتدا کلید را تولید کنید.',
          };
        } else {
          const provider = this.registry.resolve(row.integration);

          const probe: IntegrationEvent = {
            eventId: randomUUID(),
            eventType: PROBE_EVENT_TYPE,
            version: ENVELOPE_VERSION,
            occurredAt: new Date().toISOString(),
            source: 'support',
            // No tenant and no actor: a connection test is infrastructure
            // diagnostics, and attaching the testing administrator's identity would
            // send identity data the workflow has no use for (§10).
            tenant: { id: null },
            payload: { probe: true },
          };

          const sent = await provider.send(
            {
              baseUrl: row.baseUrl,
              webhookPath: row.webhookPath,
              timeoutMs: row.timeoutMs,
            },
            probe,
            secret,
          );

          result = sent.accepted
            ? { status: 'SUCCESS', message: 'اتصال برقرار شد و رویداد آزمایشی پذیرفته شد.' }
            : { status: 'FAILURE', message: 'اتصال به سرویس اتوماسیون برقرار نشد.' };
        }
      }
    } catch (err) {
      // Logged for the operator, NOT returned: `err.message` can contain the full
      // URL or an upstream payload.
      this.logger.warn(
        {
          configId: id,
          integration: row.integration,
          error: err instanceof Error ? err.message : 'unknown',
        },
        'Integration connection test failed',
      );

      result = { status: 'FAILURE', message: 'اتصال به سرویس اتوماسیون برقرار نشد.' };
    }

    await this.prisma.integrationConfig.update({
      where: { id },
      data: { lastTestStatus: result.status, lastTestedAt: new Date() },
    });

    // Audited either way: a failed test is as interesting as a successful one, and a
    // burst of failures is a signal. No secret and no upstream detail in the payload.
    await this.record(
      AUDIT_ACTIONS.CONNECTION_TESTED,
      actorId,
      id,
      { integration: row.integration, result: result.status },
      result.status === 'SUCCESS',
    );

    // THE ONE NON-CONFIGURATION EMISSION IN THIS FILE, and it qualifies because the test
    // PERSISTS state: `lastTestStatus`/`lastTestedAt` were just written above. Ordinary event
    // dispatch is still not emitted here — `AutomationExecution` already records every
    // delivery with its own timeline, and a lifecycle row per automated event would reproduce
    // exactly the high-cardinality noise that put observability in its own database.
    //
    // `phase` is the normalized answer, `outcomeCode` keeps this domain's own SUCCESS/FAILURE
    // verbatim. The Persian operator message is NOT included: it is a UI string, and the
    // failure branch's `err.message` (which can carry the full URL) never reaches here.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.CONNECTION_TESTED,
      result.status === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED',
      id,
      actorId,
      row.integration,
      { enabled: row.enabled },
      result.status,
    );

    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Execution reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Page of executions the caller may see, newest first.
   *
   * THE TENANT PREDICATE IS APPLIED UNCONDITIONALLY, INCLUDING WHEN IT IS NULL —
   * exactly as `SupportService.visibility` does. `tenantId: null` is a real
   * predicate that matches only tenant-less executions; omitting the filter for a
   * tenant-less caller would silently widen the query to every tenant in the
   * database, which is the single easiest isolation bug to write here.
   *
   * There is no cross-tenant view for any role. §9 forbids inventing a "platform
   * admin sees all tenant-less events" rule unless an existing policy defines one,
   * and none does.
   */
  async listExecutions(params: {
    limit?: number;
    cursor?: string;
  }): Promise<{ items: PublicAutomationExecution[]; nextCursor: string | null }> {
    const context = RequestContextService.get();
    const tenantId = context?.tenantId ?? null;

    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_EXECUTION_PAGE, 1),
      MAX_EXECUTION_PAGE,
    );

    const rows = await this.prisma.automationExecution.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((row) => this.projectExecution(row)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async loadOrThrow(id: string) {
    const row = await this.prisma.integrationConfig.findUnique({ where: { id } });

    if (!row) {
      throw new NotFoundException('Integration configuration not found');
    }

    return row;
  }

  /**
   * Resolves the decrypted shared secret for a config row, or undefined.
   *
   * A DECRYPTION FAILURE IS SWALLOWED HERE and reported as "no secret", unlike
   * `AIConfigService.readCredential` which rethrows. The difference is deliberate:
   * there, a failed decrypt happens inside an admin request that should surface the
   * misconfiguration; here it can happen inside a business operation that must not
   * fail because automation is misconfigured (§22). The event is recorded FAILED with
   * `NO_SECRET`, which is exactly as diagnosable and does not take the caller down.
   */
  private readSecret(row: {
    secretCiphertext: string | null;
    secretIv: string | null;
    secretAuthTag: string | null;
  }): string | undefined {
    if (!row.secretCiphertext || !row.secretIv || !row.secretAuthTag) {
      return undefined;
    }

    try {
      return this.crypto.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
      });
    } catch {
      // CryptoService already logged the failure without any crypto detail.
      return undefined;
    }
  }

  /** Terminal transition. `nextAttemptAt: null` is what the CHECK constraint requires. */
  private async finalise(
    executionId: string,
    status: AutomationStatus,
    errorCode: string,
  ): Promise<void> {
    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status,
        errorCode,
        completedAt: new Date(),
        nextAttemptAt: null,
      },
    });
  }

  /** True for a Prisma unique-constraint violation. */
  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  /**
   * THE ONLY CONFIG PROJECTION. Note what is absent: `secretCiphertext`, `secretIv`,
   * `secretAuthTag`. There is no parameter, no role check and no debug flag that
   * makes this function emit them — the only way to leak the shared secret through
   * the API would be to write a different projection.
   */
  private toPublic(row: {
    id: string;
    integration: IntegrationKey;
    baseUrl: string;
    webhookPath: string;
    enabled: boolean;
    timeoutMs: number;
    maxAttempts: number;
    secretCiphertext: string | null;
    secretUpdatedAt: Date | null;
    lastTestStatus: string | null;
    lastTestedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PublicIntegrationConfig {
    return {
      id: row.id,
      integration: row.integration,
      baseUrl: row.baseUrl,
      webhookPath: row.webhookPath,
      enabled: row.enabled,
      timeoutMs: row.timeoutMs,
      maxAttempts: row.maxAttempts,
      hasSecret: Boolean(row.secretCiphertext),
      secretUpdatedAt: row.secretUpdatedAt,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * THE ONLY EXECUTION PROJECTION.
   *
   * `tenantId` and `actorId` are deliberately NOT emitted: the caller's tenant is
   * already the filter, so echoing it back adds nothing, and the actor id would turn
   * a delivery log into a record of which administrator triggered what — visible to
   * every holder of `admin.integrations.read`. That fact lives in `AuditLog`, behind
   * `admin.audit.read`, which is where it belongs.
   */
  private projectExecution(row: {
    id: string;
    integration: IntegrationKey;
    eventId: string;
    eventType: string;
    eventVersion: number;
    source: string;
    status: AutomationStatus;
    externalExecutionId: string | null;
    attemptCount: number;
    errorCode: string | null;
    correlationId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  }): PublicAutomationExecution {
    return {
      id: row.id,
      integration: row.integration,
      eventId: row.eventId,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      source: row.source,
      status: row.status,
      externalExecutionId: row.externalExecutionId,
      attemptCount: row.attemptCount,
      errorCode: row.errorCode,
      correlationId: row.correlationId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * Turns Prisma's constraint errors into meaningful HTTP responses. Without this the
   * unique index on `integration` surfaces as a 500 with a raw index name.
   */
  private translateWriteError(err: unknown, integration: string): unknown {
    if (this.isUniqueViolation(err)) {
      return new ConflictException(
        `A configuration for ${integration} already exists - edit it instead`,
      );
    }

    return err;
  }

  /**
   * Writes one audit event. Mirrors the shape `AIConfigService.record` uses: actor
   * from the request context, resource `integration-config`, and a payload that
   * NEVER contains a secret.
   *
   * §27: important integration MUTATIONS are audited. Ordinary event dispatch is NOT
   * — an audit row per automated event would drown the security trail in traffic,
   * and `AutomationExecution` already records every delivery with its own timeline.
   */
  private async record(
    action: string,
    actorId: string,
    resourceId: string,
    payload: Record<string, unknown>,
    success = true,
  ): Promise<void> {
    if (!this.audit) return;

    const ctx = RequestContextService.get();

    await this.audit.log({
      requestId: ctx?.requestId ?? `integration-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: actorId,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      action,
      resource: 'integration-config',
      resourceId,
      newValue: payload,
      changedFields: Array.isArray(payload.changedFields)
        ? (payload.changedFields as string[])
        : [],
      success,
    });
  }

  /**
   * Emits one lifecycle transition into observability_db, best-effort.
   *
   * PHASE 49M-2. This is a SECOND, INDEPENDENT sink beside `record()` above, not a
   * replacement for it: `AuditService.log` writes `core_db."AuditLog"` (§51 KEEP) while this
   * writes `observability_db."LifecycleEvent"`, a physically separate database with its own
   * connection pool and retention. The two coexist on purpose — the audit row is the
   * compliance record of WHO changed configuration, the lifecycle row is the operational
   * timeline that interleaves with module and provisioning events.
   *
   * WHY IT IS SYNCHRONOUS AND UNAWAITED: `ObservabilityLifecycleService.record` returns
   * `void`, so this method cannot add a round trip to the caller's latency and cannot fail
   * the mutation. The try/catch is not redundant with the void return — it defends against a
   * SYNCHRONOUS throw (a missing provider method, a getter that throws) which would otherwise
   * propagate into the business path that just succeeded.
   *
   * CALLED AFTER THE WRITE HAS COMMITTED, never inside a `$transaction` callback: emitting
   * from inside one would either hold a Core transaction open for an observability write or
   * announce a transition that a later rollback un-did.
   *
   * NO SECRET, NO URL-BEARING ERROR, NO UPSTREAM BODY reaches `detail`. Callers pass ids,
   * booleans and enum values only; `sanitizeContext` in the writer is a second line of
   * defence, not the first.
   */
  private emitLifecycle(
    eventType: string,
    phase: LifecyclePhaseValue,
    configId: string,
    actorId: string | null,
    integration: string,
    detail: Record<string, unknown> = {},
    outcomeCode?: string,
  ): void {
    if (!this.lifecycle) return;

    try {
      const extra: Partial<LifecycleEventInput> = {
        // A human operator performed every mutation in this file; the callback path, which is
        // the only machine-initiated flow, does not emit here.
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId,
        outcomeCode: outcomeCode ?? null,
        detail: { integration, ...detail },
      };

      // `subjectKey` is the integration KEY (`N8N`), so a timeline can be read per engine
      // without joining core_db; `subjectId` is the config row id. Neither is a URL.
      this.lifecycle.integration(eventType, phase, { id: configId, key: integration }, extra);
    } catch (err) {
      this.logger.warn(
        { eventType, err: err instanceof Error ? err.message : 'unknown' },
        'Integration lifecycle emission failed',
      );
    }
  }
}









