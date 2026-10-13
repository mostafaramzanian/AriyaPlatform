import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { RequestContextService } from '../common/request-context.service';
import { AIProviderRegistry, type AICapabilityValue } from './ai-provider.registry';
import { AIRuntimeResolver } from './ai-runtime.resolver';
import { AIEndpointPolicyError, assertAIEndpointAllowed } from './ai-endpoint.policy';
import {
  CreateAIProviderConfigDto,
  TestAIProviderConnectionDto,
  UpdateAIProviderConfigDto,
} from './dto/ai-config.dto';

/**
 * Phase 49J-0: owns AI provider CONFIGURATION — the control plane.
 *
 * Phase AI-ARCH-HARDENING (§9): runtime RESOLUTION and provider EXECUTION no longer
 * live here. This class creates/updates/deletes/audits rows and probes connections;
 * `AIRuntimeResolver` turns a stored row into effective per-call configuration, and
 * the platform AI gateway (`src/platform/ai/`) is the execution seam every consumer
 * uses. That split is what keeps this service from becoming the everything-service
 * that an embedding caller, an admin form and a future Reporting module all reach
 * into — and what let `runWithCredential` (a `process.env` mutation) be deleted
 * rather than extended.
 *
 * RULES THIS CLASS STILL ENFORCES:
 *
 * 1. THE CREDENTIAL NEVER LEAVES. `toPublic()` is the ONLY projection used by any
 *    route, and it has no branch that emits the key — not for SUPER_ADMIN, not on
 *    create (where the plaintext is in hand), not in an error message. What a
 *    caller learns is whether a key is stored and when it last changed.
 *
 * 2. CAPABILITY HONESTY. A configuration is refused if the registry does not
 *    declare that provider capable of that capability. Storing "Claude for
 *    embeddings" would be storing a guaranteed runtime failure, and the DB has no
 *    way to express the rule, so it is enforced here on every write.
 *
 * 3. AT MOST ONE DEFAULT PER CAPABILITY, and it must be enabled. Promotion demotes
 *    the incumbent inside ONE transaction — two statements outside a transaction
 *    would leave a window with two defaults (or none), and the partial unique
 *    index would reject the second write anyway.
 *
 * 4. ENDPOINT POLICY AT WRITE TIME (§18). A `baseUrl` the AI endpoint policy refuses
 *    is a 400 here, so an unacceptable address is never stored — and the resolver
 *    re-asserts the policy on every read, for rows that predate it.
 *
 * ENV IS A BOOTSTRAP, NOT A MIRROR. When no enabled default exists for a
 * capability, resolution falls back to the provider's own env configuration
 * (OPENAI_API_KEY / EMBEDDING_MODEL), which is how 49J-A works today and is why
 * that path keeps passing. Nothing in this class ever COPIES an env key into the
 * database: the DB would then hold a credential no administrator entered, and
 * rotating the env var would silently stop taking effect.
 */

/** Audit action names, one per state change worth reconstructing later. */
const AUDIT_ACTIONS = {
  CREATED: 'AI_PROVIDER_CREATED',
  UPDATED: 'AI_PROVIDER_UPDATED',
  ENABLED: 'AI_PROVIDER_ENABLED',
  DISABLED: 'AI_PROVIDER_DISABLED',
  SELECTED: 'AI_PROVIDER_SELECTED',
  DELETED: 'AI_PROVIDER_DELETED',
  CONNECTION_TESTED: 'AI_PROVIDER_CONNECTION_TESTED',
} as const;

/**
 * The fixed probe input for a connection test (§11).
 *
 * Server-side and constant on purpose: if the caller supplied this text, the
 * endpoint would be an authenticated proxy that bills the operator's account for
 * arbitrary content. Persian, because the deployment is Persian and a non-ASCII
 * probe additionally proves the encoding path end to end.
 */
const CONNECTION_PROBE_TEXT = 'آزمایش اتصال به سرویس هوش مصنوعی';

export interface PublicAIProviderConfig {
  id: string;
  provider: string;
  capability: string;
  modelName: string;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  /** Whether a credential is stored. NOT the credential, nor its length. */
  hasCredential: boolean;
  credentialUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Outcome of a connection test. Deliberately coarse — see `testConnection`. */
export interface AIConnectionTestResult {
  status: 'SUCCESS' | 'FAILURE';
  /** Operator-facing Persian message. Never carries an upstream body or a key. */
  message: string;
}

/**
 * The stored-row columns the connection probe reads. Structural, so the Prisma row
 * satisfies it without a cast; deliberately NOT the whole model — the probe has no
 * business with `enabled`, `isDefault` or timestamps.
 */
type StoredConfigRow = {
  provider: string;
  capability: string;
  modelName: string;
  baseUrl: string | null;
  credentialCiphertext: string | null;
  credentialIv: string | null;
  credentialAuthTag: string | null;
};
@Injectable()
export class AIConfigService {
  private readonly logger = new Logger(AIConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AIProviderRegistry,
    private readonly crypto: CryptoService,
    // Runtime resolution lives in its own class (§9): this service reads/writes rows,
    // the resolver turns a row into an effective execution configuration, and neither
    // owns the other's rules.
    private readonly resolver: AIRuntimeResolver,
    // Optional for the same reason SurveysService and BlogService make it
    // optional: a trimmed test module must be able to exercise the domain rules
    // without wiring the audit pipeline, and a missing audit sink must never break
    // business logic.
    @Optional() private readonly audit?: AuditService
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Every configured row, plus the registry's capability matrix so the UI can
   * render what is configurable WITHOUT hard-coding a provider list of its own.
   * A frontend copy of that matrix is the classic way for the UI to keep offering
   * a capability the backend has removed.
   */
  async listConfigs(): Promise<{
    configs: PublicAIProviderConfig[];
    providers: ReturnType<AIProviderRegistry['list']>;
  }> {
    const rows = await this.prisma.aIProviderConfig.findMany({
      orderBy: [{ capability: 'asc' }, { provider: 'asc' }],
    });

    return {
      configs: rows.map((row) => this.toPublic(row)),
      providers: this.registry.list(),
    };
  }

  async getConfig(id: string): Promise<PublicAIProviderConfig> {
    return this.toPublic(await this.loadOrThrow(id));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Writes
  // ───────────────────────────────────────────────────────────────────────────

  async createConfig(
    actorId: string,
    dto: CreateAIProviderConfigDto
  ): Promise<PublicAIProviderConfig> {
    this.assertCapabilitySupported(dto.provider, dto.capability);
    this.assertEndpointAllowed(dto.baseUrl);

    const enabled = dto.enabled ?? false;
    const isDefault = dto.isDefault ?? false;

    // Mirrors the DB CHECK. Checked here too so the caller gets a 400 with a
    // readable message instead of a 500 carrying a constraint name.
    if (isDefault && !enabled) {
      throw new BadRequestException(
        'A provider cannot be made default while it is disabled - enable it in the same request'
      );
    }

    const envelope = dto.credential ? this.crypto.encrypt(dto.credential) : null;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Demote first, inside the transaction: the partial unique index would
        // otherwise reject this insert outright.
        if (isDefault) {
          await tx.aIProviderConfig.updateMany({
            where: { capability: dto.capability, isDefault: true },
            data: { isDefault: false },
          });
        }

        return tx.aIProviderConfig.create({
          data: {
            provider: dto.provider,
            capability: dto.capability,
            modelName: dto.modelName,
            baseUrl: dto.baseUrl ?? null,
            enabled,
            isDefault,
            credentialCiphertext: envelope?.ciphertext ?? null,
            credentialIv: envelope?.iv ?? null,
            credentialAuthTag: envelope?.authTag ?? null,
            credentialUpdatedAt: envelope ? new Date() : null,
          },
        });
      });

      await this.record(AUDIT_ACTIONS.CREATED, actorId, created.id, {
        provider: created.provider,
        capability: created.capability,
        modelName: created.modelName,
        enabled: created.enabled,
        isDefault: created.isDefault,
        // Presence only. The key itself is never in an audit payload.
        hasCredential: Boolean(envelope),
      });

      if (created.isDefault) {
        await this.record(AUDIT_ACTIONS.SELECTED, actorId, created.id, {
          capability: created.capability,
          provider: created.provider,
        });
      }

      return this.toPublic(created);
    } catch (err) {
      throw this.translateWriteError(err, dto.provider, dto.capability);
    }
  }

  /**
   * Partial update. `provider` and `capability` are not updatable — see the DTO.
   *
   * The audit trail is SPLIT: a general UPDATE event carrying the changed field
   * names, plus a dedicated ENABLED / DISABLED / SELECTED event when the
   * corresponding flag flips. An enable is the moment live traffic starts reaching
   * a provider; finding that inside a diff of an `AI_PROVIDER_UPDATED` payload is
   * exactly the kind of needle nobody spots during an incident.
   */
  async updateConfig(
    actorId: string,
    id: string,
    dto: UpdateAIProviderConfigDto
  ): Promise<PublicAIProviderConfig> {
    const before = await this.loadOrThrow(id);
    this.assertEndpointAllowed(dto.baseUrl);

    if (dto.credential && dto.clearCredential) {
      throw new BadRequestException(
        'Cannot set and clear the credential in one request - send only one of them'
      );
    }

    const enabled = dto.enabled ?? before.enabled;
    const isDefault = dto.isDefault ?? before.isDefault;

    if (isDefault && !enabled) {
      throw new BadRequestException(
        'A provider cannot be default while it is disabled - enable it in the same request'
      );
    }

    // A row that is currently the enabled default cannot simply be switched off:
    // that would leave the capability with no default at all, and the next
    // embedding call would silently fall back to env. The operator must promote a
    // replacement first, which makes the substitution explicit and auditable.
    if (before.isDefault && !enabled) {
      throw new ConflictException(
        'This provider is the active default - promote another provider for this capability first'
      );
    }

    const changed: string[] = [];
    const data: Record<string, unknown> = {};

    if (dto.modelName !== undefined && dto.modelName !== before.modelName) {
      data.modelName = dto.modelName;
      changed.push('modelName');
    }

    // `!== undefined` rather than a truthiness test: `baseUrl: null` is a
    // meaningful value (revert to the provider default) and truthiness would drop it.
    const nextBaseUrl = dto.baseUrl ?? null;
    if (dto.baseUrl !== undefined && nextBaseUrl !== before.baseUrl) {
      data.baseUrl = nextBaseUrl;
      changed.push('baseUrl');
    }

    if (enabled !== before.enabled) {
      data.enabled = enabled;
      changed.push('enabled');
    }

    if (isDefault !== before.isDefault) {
      data.isDefault = isDefault;
      changed.push('isDefault');
    }

    if (dto.credential) {
      const envelope = this.crypto.encrypt(dto.credential);
      data.credentialCiphertext = envelope.ciphertext;
      data.credentialIv = envelope.iv;
      data.credentialAuthTag = envelope.authTag;
      data.credentialUpdatedAt = new Date();
      // The FIELD NAME is recorded, so a rotation is visible in the audit log.
      // The value is not.
      changed.push('credential');
    }

    if (dto.clearCredential) {
      // All four columns together: the DB CHECK requires the envelope to be
      // all-null or all-present.
      data.credentialCiphertext = null;
      data.credentialIv = null;
      data.credentialAuthTag = null;
      data.credentialUpdatedAt = null;
      changed.push('credential');
    }

    if (changed.length === 0) {
      // No write, no audit event. Recording a no-op mutation would pad the trail
      // with events that changed nothing.
      return this.toPublic(before);
    }

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        if (isDefault && !before.isDefault) {
          await tx.aIProviderConfig.updateMany({
            where: { capability: before.capability, isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
        }

        return tx.aIProviderConfig.update({ where: { id }, data });
      });
    } catch (err) {
      throw this.translateWriteError(err, before.provider, before.capability);
    }

    await this.record(AUDIT_ACTIONS.UPDATED, actorId, id, {
      provider: updated.provider,
      capability: updated.capability,
      modelName: updated.modelName,
      changedFields: changed,
    });

    if (changed.includes('enabled')) {
      await this.record(
        updated.enabled ? AUDIT_ACTIONS.ENABLED : AUDIT_ACTIONS.DISABLED,
        actorId,
        id,
        { provider: updated.provider, capability: updated.capability }
      );
    }

    if (changed.includes('isDefault') && updated.isDefault) {
      await this.record(AUDIT_ACTIONS.SELECTED, actorId, id, {
        provider: updated.provider,
        capability: updated.capability,
      });
    }

    return this.toPublic(updated);
  }

  /**
   * Deletes a configuration row.
   *
   * The active default is protected here as well: deleting it would take the
   * capability offline with no trace beyond a DELETE event, and the operator
   * almost certainly meant to replace it.
   */
  async deleteConfig(actorId: string, id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.loadOrThrow(id);

    if (row.isDefault && row.enabled) {
      throw new ConflictException(
        'This provider is the active default - promote another provider for this capability first'
      );
    }

    await this.prisma.aIProviderConfig.delete({ where: { id } });

    await this.record(AUDIT_ACTIONS.DELETED, actorId, id, {
      provider: row.provider,
      capability: row.capability,
      modelName: row.modelName,
    });

    return { id, deleted: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection test
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Verifies that a configuration actually works, using the FIXED probe text.
   *
   * The return shape is SUCCESS/FAILURE plus a safe message and nothing else. It
   * deliberately does not include the HTTP status, the upstream error body, the
   * response headers or the latency:
   *  - an upstream body can echo request content and occasionally key fragments;
   *  - a status code distinguishes "bad key" from "no quota" from "no such model",
   *    which turns this endpoint into a probe for account state.
   * The detail IS logged for the operator; it is simply not returned.
   *
   * CAPABILITY-BASED (§17): the probe is selected by the row's own capability, and
   * CREDENTIAL-SAFE (§6): the effective configuration travels as an explicit
   * parameter into the adapter — `process.env` is never written, so this endpoint
   * can no longer interleave with a live execution and hand it the wrong key.
   */
  async testConnection(
    actorId: string,
    id: string,
    dto: TestAIProviderConnectionDto
  ): Promise<AIConnectionTestResult> {
    const row = await this.loadOrThrow(id);

    let result: AIConnectionTestResult;

    try {
      result = await this.probe(row, dto);
    } catch (err) {
      // Logged for the operator, NOT returned. `err.message` from a provider can
      // contain an upstream payload.
      this.logger.warn(
        {
          configId: id,
          provider: row.provider,
          capability: row.capability,
          error: err instanceof Error ? err.message : 'unknown',
        },
        'AI provider connection test failed'
      );

      result = { status: 'FAILURE', message: 'اتصال به سرویس برقرار نشد.' };
    }

    // Audited either way: a failed test is as interesting as a successful one, and
    // a burst of failures is a signal. The `success` column carries the outcome; no
    // credential and no upstream detail is in the payload.
    await this.record(
      AUDIT_ACTIONS.CONNECTION_TESTED,
      actorId,
      id,
      {
        provider: row.provider,
        capability: row.capability,
        modelName: row.modelName,
        result: result.status,
        // Records WHICH key was exercised without recording the key.
        usedSubmittedCredential: Boolean(dto.credential),
      },
      result.status === 'SUCCESS'
    );

    return result;
  }

  /**
   * The capability dispatch (§17). An unsupported cell returns the registry's own
   * explanation instead of probing a method known to throw.
   */
  private async probe(
    row: StoredConfigRow,
    dto: TestAIProviderConnectionDto
  ): Promise<AIConnectionTestResult> {
    if (!this.registry.supports(row.provider, row.capability as AICapabilityValue)) {
      return {
        status: 'FAILURE',
        message:
          this.registry.unsupportedReason(row.provider, row.capability as AICapabilityValue) ??
          'این قابلیت برای ارائهدهنده انتخابشده پشتیبانی نمیشود.',
      };
    }

    switch (row.capability) {
      case 'EMBEDDING':
        return this.probeEmbedding(row, dto);
      default:
        // Unreachable while the matrix is honest (every cell is asserted in
        // ai-provider.registry.spec.ts); present so a capability that gains support
        // later cannot silently fall through to an embedding probe.
        return {
          status: 'FAILURE',
          message: 'این قابلیت برای ارائهدهنده انتخابشده پشتیبانی نمیشود.',
        };
    }
  }

  /**
   * One embedding probe through the resolver — the same resolution the runtime path
   * uses, so the test cannot disagree with execution about model, endpoint or
   * credential precedence (submitted wins; decryption is skipped when it does).
   *
   * NO ENV MUTATION AND NO FALLBACK (§6/§14): the credential travels as a parameter,
   * and a row whose stored envelope cannot be decrypted is a FAILURE — never a
   * silent probe with the process-wide key.
   */
  private async probeEmbedding(
    row: StoredConfigRow,
    dto: TestAIProviderConnectionDto
  ): Promise<AIConnectionTestResult> {
    const execution = this.resolver.resolveStoredRow(row, dto.credential);

    if (!execution.executionOptions?.credential) {
      return {
        status: 'FAILURE',
        message: 'کلید API ذخیره نشده است؛ ابتدا کلید را وارد کنید.',
      };
    }

    const vector = await execution.adapter.generateEmbedding(
      CONNECTION_PROBE_TEXT,
      execution.executionOptions
    );

    return Array.isArray(vector) && vector.length > 0
      ? { status: 'SUCCESS', message: `اتصال برقرار شد (بردار ${vector.length} بعدی).` }
      : { status: 'FAILURE', message: 'پاسخ سرویس معتبر نبود.' };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Note: runtime RESOLUTION used to live here (`resolveProvider`,
  // `runWithCredential`, `generateEmbedding`, `getEmbeddingProvider`,
  // `getTextProvider`). Phase AI-ARCH-HARDENING moved it to `AIRuntimeResolver`
  // (effective configuration, credential decryption, endpoint policy) and the
  // execution itself to the platform AI gateway — consumers no longer receive a
  // provider INSTANCE from this service at all.
  // ───────────────────────────────────────────────────────────────────────────






  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async loadOrThrow(id: string) {
    const row = await this.prisma.aIProviderConfig.findUnique({ where: { id } });

    if (!row) {
      throw new NotFoundException('AI provider configuration not found');
    }

    return row;
  }

  private assertCapabilitySupported(provider: string, capability: string): void {
    if (!this.registry.find(provider)) {
      throw new BadRequestException(`Unknown AI provider: ${provider}`);
    }

    if (!this.registry.supports(provider, capability as AICapabilityValue)) {
      // The registry's own explanation is reused so the API and the UI cannot
      // disagree about why something is unavailable.
      throw new BadRequestException(
        this.registry.unsupportedReason(provider, capability as AICapabilityValue) ??
          `Provider ${provider} does not support ${capability}`
      );
    }
  }

  /**
   * Write-time endpoint policy (§18). An ABSENT baseUrl passes — that is the update
   * "leave unchanged" case and the create "provider default" case — while anything
   * submitted must be an address the policy accepts. The resolver re-asserts the
   * same policy at read time, so this check is about failing an operator's typo at
   * the form, not about being the only gate.
   */
  private assertEndpointAllowed(baseUrl: string | undefined): void {
    if (!baseUrl) return;

    try {
      assertAIEndpointAllowed(baseUrl);
    } catch (err) {
      if (err instanceof AIEndpointPolicyError) {
        // The reason is a closed set of policy phrases, never the caller's raw URL
        // echoed back through a framework error page.
        throw new BadRequestException(`baseUrl is not an acceptable AI endpoint: ${err.reason}`);
      }
      throw err;
    }
  }


  /**
   * THE ONLY PROJECTION. Note what is absent: `credentialCiphertext`,
   * `credentialIv`, `credentialAuthTag`. There is no parameter, no role check and
   * no debug flag that makes this function emit them — the only way to leak a key
   * through the API would be to write a different projection.
   */
  private toPublic(row: {
    id: string;
    provider: string;
    capability: string;
    modelName: string;
    baseUrl: string | null;
    enabled: boolean;
    isDefault: boolean;
    credentialCiphertext: string | null;
    credentialUpdatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PublicAIProviderConfig {
    return {
      id: row.id,
      provider: row.provider,
      capability: row.capability,
      modelName: row.modelName,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      isDefault: row.isDefault,
      hasCredential: Boolean(row.credentialCiphertext),
      credentialUpdatedAt: row.credentialUpdatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Turns Prisma's constraint errors into meaningful HTTP responses. Without this
   * the two unique indexes surface as a 500 with a raw index name — the partial
   * default index in particular is invisible in schema.prisma, so its violation
   * would be baffling.
   */
  private translateWriteError(err: unknown, provider: string, capability: string): unknown {
    const code = (err as { code?: string })?.code;

    if (code === 'P2002') {
      const target = String((err as { meta?: { target?: unknown } })?.meta?.target ?? '');

      if (target.includes('capability_default')) {
        return new ConflictException(`Another provider is already the default for ${capability}`);
      }

      return new ConflictException(
        `A configuration for ${provider} / ${capability} already exists - edit it instead`
      );
    }

    return err;
  }

  /**
   * Writes one audit event. Mirrors the shape SurveysService uses: actor from the
   * request context, resource `ai-provider-config`, and a payload that NEVER
   * contains a credential.
   */
  private async record(
    action: string,
    actorId: string,
    resourceId: string,
    payload: Record<string, unknown>,
    success = true
  ): Promise<void> {
    if (!this.audit) return;

    const ctx = RequestContextService.get();

    await this.audit.log({
      requestId: ctx?.requestId ?? `ai-config-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: actorId,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      action,
      resource: 'ai-provider-config',
      resourceId,
      newValue: payload,
      changedFields: Array.isArray(payload.changedFields)
        ? (payload.changedFields as string[])
        : [],
      success,
    });
  }
}
