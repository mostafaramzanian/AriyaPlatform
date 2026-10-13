import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AIConfigService } from './ai-config.service';
import type { CreateAIProviderConfigDto, UpdateAIProviderConfigDto } from './dto/ai-config.dto';
import { AIProviderRegistry } from './ai-provider.registry';
import { AIRuntimeResolver } from './ai-runtime.resolver';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { OpenAIProvider } from './openai.provider';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { ClaudeProvider } from './claude.provider';
import { LocalLLMProvider } from './local-llm.provider';

/**
 * Phase 49J-0 unit coverage for AI provider configuration.
 *
 * The four invariants this file exists to pin down, in the order they matter:
 *
 *  1. THE CREDENTIAL NEVER LEAVES. Every projection is checked for the three
 *     envelope columns, and the audit payloads are checked too — an API that
 *     masks its responses but writes the key into an audit row has still leaked it.
 *
 *  2. CAPABILITY HONESTY at BOTH ends: refused on write, and refused again at
 *     resolution time, because the matrix is code and a row saved under an older
 *     matrix must not keep resolving.
 *
 *  3. ONE DEFAULT PER CAPABILITY, demoted INSIDE the transaction. The test
 *     asserts the demotion happens through the transaction client `tx`, not
 *     through `this.prisma` — the latter compiles, passes a naive test, and
 *     leaves a window with two defaults.
 *
 *  4. `process.env` IS LEFT EXACTLY AS IT WAS. Since Phase AI-ARCH-HARDENING there
 *     is no credential-scoped env runner left to restore it: the connection probe
 *     passes the credential as an EXPLICIT parameter to the adapter, and this file
 *     asserts on every probe that the environment is untouched. The earlier
 *     env-scoped runner was the one place a request-supplied key could outlive the
 *     request and interleave with a live execution.
 *
 * The real AIProviderRegistry is used rather than a mock: the capability rules
 * being enforced here ARE the registry's matrix, and a mocked `supports()` would
 * let this file pass while the pair disagreed. Its four provider dependencies are
 * stubbed, since only `generateEmbedding` is ever called.
 */

describe('AIConfigService', () => {
  let service: AIConfigService;
  let prisma: {
    aIProviderConfig: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let openai: { generateEmbedding: jest.Mock };

  const actor = 'user-admin-1';
  const configId = '11111111-1111-4111-8111-111111111111';
  const originalEnv = { ...process.env };

  /**
   * Deterministic fake crypto. The real algorithm is proven against real Node
   * crypto in crypto.service.spec.ts; what matters HERE is that the service
   * encrypts before writing and decrypts before use, which a reversible fake shows
   * more legibly than ciphertext would.
   */
  const crypto = {
    encrypt: jest.fn((plain: string) => ({
      ciphertext: `ct(${plain})`,
      iv: `iv(${plain})`,
      authTag: `tag(${plain})`,
    })),
    decrypt: jest.fn((envelope: { ciphertext: string }) =>
      envelope.ciphertext.replace(/^ct\((.*)\)$/, '$1')
    ),
    matches: jest.fn(),
  };

  const providerStub = () => ({
    generateText: jest.fn(),
    generateEmbedding: jest.fn(),
    generateCompletion: jest.fn(),
  });

  /** A stored row. OPENAI/EMBEDDING because it is the only supported cell. */
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: configId,
    provider: 'OPENAI',
    capability: 'EMBEDDING',
    modelName: 'text-embedding-3-small',
    baseUrl: null,
    enabled: true,
    isDefault: true,
    credentialCiphertext: 'ct(sk-stored)',
    credentialIv: 'iv(sk-stored)',
    credentialAuthTag: 'tag(sk-stored)',
    credentialUpdatedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

  /** The tx client handed to the `$transaction` callback. Recreated per test. */
  let tx: { aIProviderConfig: Record<string, jest.Mock> };

  beforeEach(async () => {
    tx = {
      aIProviderConfig: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AIConfigService,
        AIProviderRegistry,
        AIRuntimeResolver,
        { provide: OpenAIProvider, useValue: providerStub() },
        { provide: AzureOpenAIProvider, useValue: providerStub() },
        { provide: ClaudeProvider, useValue: providerStub() },
        { provide: LocalLLMProvider, useValue: providerStub() },
        { provide: CryptoService, useValue: crypto },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: PrismaService,
          useValue: {
            aIProviderConfig: {
              findMany: jest.fn().mockResolvedValue([]),
              findFirst: jest.fn().mockResolvedValue(null),
              findUnique: jest.fn().mockResolvedValue(null),
              updateMany: jest.fn(),
              delete: jest.fn(),
            },
            // Runs the callback with the tx client, so a write issued through
            // `this.prisma` instead of `tx` is visible as a missing tx call.
            $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AIConfigService);
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    openai = moduleRef.get(OpenAIProvider);

    process.env.OPENAI_API_KEY = 'sk-from-env';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  /** Everything the service ever hands out, flattened for leak assertions. */
  const serialised = (value: unknown) => JSON.stringify(value);

  // ─────────────────────────────────────────────────────────────────────────────
  // Reads and masking
  // ─────────────────────────────────────────────────────────────────────────────

  describe('listConfigs', () => {
    it('masks the credential and reports only its PRESENCE', async () => {
      prisma.aIProviderConfig.findMany.mockResolvedValue([row()]);

      const result = await service.listConfigs();
      const [config] = result.configs;

      expect(config.hasCredential).toBe(true);
      expect(config.credentialUpdatedAt).toEqual(new Date('2026-09-01T00:00:00Z'));

      // The three envelope columns, by name and by value. A future projection that
      // spread the row would fail here rather than in production.
      expect(config).not.toHaveProperty('credentialCiphertext');
      expect(config).not.toHaveProperty('credentialIv');
      expect(config).not.toHaveProperty('credentialAuthTag');
      expect(serialised(result)).not.toContain('sk-stored');
      expect(serialised(result)).not.toContain('ct(');
    });

    it('reports hasCredential false for a row without one', async () => {
      prisma.aIProviderConfig.findMany.mockResolvedValue([
        row({ credentialCiphertext: null, credentialIv: null, credentialAuthTag: null }),
      ]);

      expect((await service.listConfigs()).configs[0].hasCredential).toBe(false);
    });

    it('never DECRYPTS on a read path', async () => {
      // Reads must not touch the master key at all: a read that decrypts fails
      // wholesale after a key rotation, and puts plaintext on the response path.
      prisma.aIProviderConfig.findMany.mockResolvedValue([row()]);

      await service.listConfigs();

      expect(crypto.decrypt).not.toHaveBeenCalled();
    });

    it('ships the capability matrix alongside the rows', async () => {
      // So the UI does not keep its own copy, which would drift.
      const { providers } = await service.listConfigs();

      expect(providers.map((p) => p.key)).toEqual(['OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'LOCAL']);
      expect(providers.find((p) => p.key === 'OPENAI')?.capabilities).toEqual(['EMBEDDING']);
    });

    it('orders by capability then provider, so the list is stable', async () => {
      await service.listConfigs();

      expect(prisma.aIProviderConfig.findMany).toHaveBeenCalledWith({
        orderBy: [{ capability: 'asc' }, { provider: 'asc' }],
      });
    });

    it('does not audit a read', async () => {
      prisma.aIProviderConfig.findMany.mockResolvedValue([row()]);

      await service.listConfigs();

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('getConfig', () => {
    it('masks the credential', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());

      const config = await service.getConfig(configId);

      expect(config.hasCredential).toBe(true);
      expect(serialised(config)).not.toContain('sk-stored');
    });

    it('throws NotFoundException for an unknown id', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(null);

      await expect(service.getConfig(configId)).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // createConfig
  // ─────────────────────────────────────────────────────────────────────────────

  describe('createConfig', () => {
    const createDto = {
      provider: 'OPENAI' as const,
      capability: 'EMBEDDING' as const,
      modelName: 'text-embedding-3-small',
    };

    it('encrypts the credential and stores the whole envelope plus a timestamp', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row({ isDefault: false, enabled: false }));

      await service.createConfig(actor, { ...createDto, credential: 'sk-new' });

      expect(crypto.encrypt).toHaveBeenCalledWith('sk-new');

      const { data } = tx.aIProviderConfig.create.mock.calls[0][0];
      expect(data.credentialCiphertext).toBe('ct(sk-new)');
      expect(data.credentialIv).toBe('iv(sk-new)');
      expect(data.credentialAuthTag).toBe('tag(sk-new)');
      // All four together, per the DB CHECK, and the timestamp is server-side.
      expect(data.credentialUpdatedAt).toBeInstanceOf(Date);
      // The plaintext must not survive anywhere in the write.
      expect(serialised(data)).not.toContain('sk-new"');
    });

    it('writes all four credential columns as NULL when no credential is supplied', async () => {
      // The legitimate all-NULL case: a LOCAL provider on a trusted network. A
      // partially-null envelope would violate the CHECK constraint.
      tx.aIProviderConfig.create.mockResolvedValue(
        row({ credentialCiphertext: null, credentialIv: null, credentialAuthTag: null })
      );

      await service.createConfig(actor, createDto);

      const { data } = tx.aIProviderConfig.create.mock.calls[0][0];
      expect(data.credentialCiphertext).toBeNull();
      expect(data.credentialIv).toBeNull();
      expect(data.credentialAuthTag).toBeNull();
      expect(data.credentialUpdatedAt).toBeNull();
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('defaults enabled and isDefault to FALSE, so a create cannot redirect live traffic', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row({ enabled: false, isDefault: false }));

      await service.createConfig(actor, createDto);

      const { data } = tx.aIProviderConfig.create.mock.calls[0][0];
      expect(data.enabled).toBe(false);
      expect(data.isDefault).toBe(false);
    });

    it('normalises an omitted baseUrl to null rather than undefined', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row());

      await service.createConfig(actor, createDto);

      expect(tx.aIProviderConfig.create.mock.calls[0][0].data.baseUrl).toBeNull();
    });

    it('REFUSES a capability the provider does not support', async () => {
      // Anthropic ships no embedding model: storing this row would store a
      // guaranteed runtime failure, and the DB cannot express the rule.
      await expect(
        service.createConfig(actor, {
          ...createDto,
          provider: 'ANTHROPIC',
          capability: 'EMBEDDING',
        })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("reuses the registry's own explanation, so the API and the UI cannot disagree", async () => {
      await expect(
        service.createConfig(actor, {
          ...createDto,
          provider: 'ANTHROPIC',
          capability: 'EMBEDDING',
        })
      ).rejects.toThrow(/هرگز/);
    });

    it('refuses TEXT_GENERATION for every provider, since none implements it', async () => {
      for (const provider of ['OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'LOCAL'] as const) {
        await expect(
          service.createConfig(actor, { ...createDto, provider, capability: 'TEXT_GENERATION' })
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('refuses an unknown provider before touching the database', async () => {
      await expect(
        service.createConfig(actor, {
          ...createDto,
          provider: 'MISTRAL' as CreateAIProviderConfigDto['provider'],
        }),
      ).rejects.toThrow(/Unknown AI provider/);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses isDefault while disabled, mirroring the DB CHECK with a readable 400', async () => {
      await expect(
        service.createConfig(actor, { ...createDto, isDefault: true, enabled: false })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not encrypt when validation fails, so a rejected key is never processed', async () => {
      await expect(
        service.createConfig(actor, {
          ...createDto,
          provider: 'LOCAL',
          credential: 'sk-should-not-be-encrypted',
        })
      ).rejects.toThrow(BadRequestException);

      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('demotes the incumbent default INSIDE the transaction, before inserting', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row());

      await service.createConfig(actor, { ...createDto, enabled: true, isDefault: true });

      // Through `tx`, not `this.prisma`: two statements outside one transaction
      // leave a window with two defaults, and the partial unique index would
      // reject the insert anyway.
      expect(tx.aIProviderConfig.updateMany).toHaveBeenCalledWith({
        where: { capability: 'EMBEDDING', isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.aIProviderConfig.updateMany).not.toHaveBeenCalled();

      const demoteOrder = tx.aIProviderConfig.updateMany.mock.invocationCallOrder[0];
      const createOrder = tx.aIProviderConfig.create.mock.invocationCallOrder[0];
      expect(demoteOrder).toBeLessThan(createOrder);
    });

    it('does not demote anything when the new row is not the default', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row({ isDefault: false }));

      await service.createConfig(actor, createDto);

      expect(tx.aIProviderConfig.updateMany).not.toHaveBeenCalled();
    });

    it('audits the create with credential PRESENCE only', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row({ isDefault: false }));

      await service.createConfig(actor, { ...createDto, credential: 'sk-new' });

      const event = audit.log.mock.calls[0][0];
      expect(event.action).toBe('AI_PROVIDER_CREATED');
      expect(event.resource).toBe('ai-provider-config');
      expect(event.resourceId).toBe(configId);
      expect(event.userId).toBe(actor);
      expect(event.newValue.hasCredential).toBe(true);
      // The audit table is long-lived and widely readable; a key here would be a
      // leak that outlives the request.
      expect(serialised(event)).not.toContain('sk-new');
      expect(serialised(event)).not.toContain('ct(sk-new)');
    });

    it('emits a SEPARATE SELECTED event when the new row is the default', async () => {
      tx.aIProviderConfig.create.mockResolvedValue(row());

      await service.createConfig(actor, { ...createDto, enabled: true, isDefault: true });

      // A provider becoming live is the event an incident review looks for; it must
      // not be buried inside a CREATED payload.
      expect(audit.log.mock.calls.map((c: Array<{ action: string }>) => c[0].action)).toEqual([
        'AI_PROVIDER_CREATED',
        'AI_PROVIDER_SELECTED',
      ]);
    });

    it('translates a duplicate (provider, capability) into 409 with actionable wording', async () => {
      prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: ['AIProviderConfig_provider_capability_key'] },
        })
      );

      await expect(service.createConfig(actor, createDto)).rejects.toThrow(ConflictException);
      await expect(service.createConfig(actor, createDto)).rejects.toThrow(/edit it instead/);
    });

    it('translates a partial-default-index violation into a distinct 409', async () => {
      // This index does not appear in schema.prisma, so a raw 500 naming it would be
      // baffling to whoever hits it.
      prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: ['AIProviderConfig_capability_default_key'] },
        })
      );

      await expect(service.createConfig(actor, createDto)).rejects.toThrow(
        /already the default for EMBEDDING/
      );
    });

    it('rethrows an unrelated database error unchanged', async () => {
      // Only constraint violations are translated; masking everything else as a 409
      // would hide real faults.
      const boom = new Error('connection reset');
      prisma.$transaction.mockRejectedValue(boom);

      await expect(service.createConfig(actor, createDto)).rejects.toBe(boom);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // updateConfig
  // ─────────────────────────────────────────────────────────────────────────────

  describe('updateConfig', () => {
    /** Stores `before` and echoes the patch back as the updated row. */
    const existing = (overrides: Record<string, unknown> = {}) => {
      const before = row(overrides);
      prisma.aIProviderConfig.findUnique.mockResolvedValue(before);
      tx.aIProviderConfig.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...before,
          ...data,
        }),
      );
      return before;
    };

    it('throws NotFoundException for an unknown id', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(null);

      await expect(service.updateConfig(actor, configId, { modelName: 'x' })).rejects.toThrow(
        NotFoundException
      );
    });

    it('re-encrypts a rotated credential and restamps credentialUpdatedAt', async () => {
      existing();

      await service.updateConfig(actor, configId, { credential: 'sk-rotated' });

      expect(crypto.encrypt).toHaveBeenCalledWith('sk-rotated');

      const { data } = tx.aIProviderConfig.update.mock.calls[0][0];
      expect(data.credentialCiphertext).toBe('ct(sk-rotated)');
      expect(data.credentialIv).toBe('iv(sk-rotated)');
      expect(data.credentialAuthTag).toBe('tag(sk-rotated)');
      expect(data.credentialUpdatedAt).toBeInstanceOf(Date);
    });

    it('LEAVES THE STORED KEY UNTOUCHED when credential is omitted', async () => {
      // What makes a masked GET safe to round-trip: the UI resubmits the form it
      // was given, having never seen the key, and the key survives.
      existing();

      await service.updateConfig(actor, configId, { modelName: 'text-embedding-3-large' });

      const { data } = tx.aIProviderConfig.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('credentialCiphertext');
      expect(data).not.toHaveProperty('credentialIv');
      expect(data).not.toHaveProperty('credentialAuthTag');
      expect(data).not.toHaveProperty('credentialUpdatedAt');
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('clears ALL FOUR credential columns on clearCredential', async () => {
      existing();

      await service.updateConfig(actor, configId, { clearCredential: true });

      const { data } = tx.aIProviderConfig.update.mock.calls[0][0];
      expect(data.credentialCiphertext).toBeNull();
      expect(data.credentialIv).toBeNull();
      expect(data.credentialAuthTag).toBeNull();
      expect(data.credentialUpdatedAt).toBeNull();
    });

    it('refuses to set AND clear the credential in one request', async () => {
      // Otherwise the outcome depends on which branch runs first.
      existing();

      await expect(
        service.updateConfig(actor, configId, { credential: 'sk-x', clearCredential: true })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('refuses isDefault while disabled', async () => {
      existing({ enabled: false, isDefault: false });

      await expect(
        service.updateConfig(actor, configId, { isDefault: true, enabled: false })
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to disable the ACTIVE DEFAULT, demanding a replacement first', async () => {
      // Disabling it would take the capability offline and silently fall back to
      // env on the next embedding call.
      existing({ enabled: true, isDefault: true });

      await expect(
        service.updateConfig(actor, configId, { enabled: false, isDefault: false })
      ).rejects.toThrow(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('allows disabling a non-default row', async () => {
      existing({ enabled: true, isDefault: false });

      await service.updateConfig(actor, configId, { enabled: false });

      expect(tx.aIProviderConfig.update.mock.calls[0][0].data.enabled).toBe(false);
    });

    it('writes NOTHING and audits NOTHING when the patch changes no value', async () => {
      // A patch that re-sends the current values is the normal outcome of "save"
      // on an untouched form. Recording it would pad the trail with events that
      // changed nothing.
      const before = existing({ modelName: 'text-embedding-3-small', baseUrl: null });

      const result = await service.updateConfig(actor, configId, {
        modelName: 'text-embedding-3-small',
        enabled: before.enabled,
        isDefault: before.isDefault,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.aIProviderConfig.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(result.id).toBe(configId);
    });

    it('treats an explicit baseUrl of null as a change back to the provider default', async () => {
      // `!== undefined` rather than truthiness: null is meaningful here, and a
      // truthiness test would silently drop the revert.
      existing({ baseUrl: 'https://gateway.internal' });

      await service.updateConfig(actor, configId, {
        baseUrl: undefined as UpdateAIProviderConfigDto['baseUrl'],
      });
      expect(tx.aIProviderConfig.update).not.toHaveBeenCalled();

      await service.updateConfig(actor, configId, {
        // Wire-level null is meaningful here: class-validator's @IsOptional
        // passes null through, while the DTO's TS type only states string | undefined.
        baseUrl: null as unknown as UpdateAIProviderConfigDto['baseUrl'],
      });
      expect(tx.aIProviderConfig.update.mock.calls[0][0].data.baseUrl).toBeNull();
    });

    it('records the CHANGED FIELD NAMES, including credential, but never its value', async () => {
      existing({ modelName: 'old-model' });

      await service.updateConfig(actor, configId, {
        modelName: 'text-embedding-3-large',
        credential: 'sk-rotated',
      });

      const event = audit.log.mock.calls[0][0];
      expect(event.action).toBe('AI_PROVIDER_UPDATED');
      expect(event.newValue.changedFields).toEqual(['modelName', 'credential']);
      expect(event.changedFields).toEqual(['modelName', 'credential']);
      // A rotation is visible; the rotated value is not.
      expect(serialised(event)).not.toContain('sk-rotated');
      expect(serialised(event)).not.toContain('ct(sk-rotated)');
    });

    it('emits a dedicated ENABLED event on enable', async () => {
      existing({ enabled: false, isDefault: false });

      await service.updateConfig(actor, configId, { enabled: true });

      expect(audit.log.mock.calls.map((c: Array<{ action: string }>) => c[0].action)).toEqual([
        'AI_PROVIDER_UPDATED',
        'AI_PROVIDER_ENABLED',
      ]);
    });

    it('emits a dedicated DISABLED event on disable', async () => {
      existing({ enabled: true, isDefault: false });

      await service.updateConfig(actor, configId, { enabled: false });

      expect(audit.log.mock.calls.map((c: Array<{ action: string }>) => c[0].action)).toEqual([
        'AI_PROVIDER_UPDATED',
        'AI_PROVIDER_DISABLED',
      ]);
    });

    it('demotes the incumbent through tx and emits SELECTED on promotion', async () => {
      existing({ enabled: true, isDefault: false });

      await service.updateConfig(actor, configId, { isDefault: true });

      // Excludes itself from the demotion, or the promotion would undo itself.
      expect(tx.aIProviderConfig.updateMany).toHaveBeenCalledWith({
        where: { capability: 'EMBEDDING', isDefault: true, id: { not: configId } },
        data: { isDefault: false },
      });
      expect(prisma.aIProviderConfig.updateMany).not.toHaveBeenCalled();
      expect(audit.log.mock.calls.map((c: Array<{ action: string }>) => c[0].action)).toEqual([
        'AI_PROVIDER_UPDATED',
        'AI_PROVIDER_SELECTED',
      ]);
    });

    it('does not demote when the row is ALREADY the default', async () => {
      existing({ enabled: true, isDefault: true });

      await service.updateConfig(actor, configId, { modelName: 'text-embedding-3-large' });

      expect(tx.aIProviderConfig.updateMany).not.toHaveBeenCalled();
    });

    it('emits no SELECTED event when isDefault goes to false', async () => {
      existing({ enabled: true, isDefault: false });

      await service.updateConfig(actor, configId, { modelName: 'new-model' });

      expect(audit.log.mock.calls.map((c: Array<{ action: string }>) => c[0].action)).toEqual(['AI_PROVIDER_UPDATED']);
    });

    it('masks the credential in the returned row', async () => {
      existing();

      const result = await service.updateConfig(actor, configId, { credential: 'sk-rotated' });

      expect(result.hasCredential).toBe(true);
      expect(result).not.toHaveProperty('credentialCiphertext');
      expect(serialised(result)).not.toContain('sk-rotated');
    });

    it('translates a P2002 on update into a 409', async () => {
      existing({ enabled: true, isDefault: false });
      prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: ['AIProviderConfig_capability_default_key'] },
        })
      );

      await expect(service.updateConfig(actor, configId, { isDefault: true })).rejects.toThrow(
        ConflictException
      );

      // A failed write must not produce an audit trail claiming it happened.
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // deleteConfig
  // ─────────────────────────────────────────────────────────────────────────────

  describe('deleteConfig', () => {
    it('deletes a non-default row and audits it', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row({ isDefault: false }));

      const result = await service.deleteConfig(actor, configId);

      expect(prisma.aIProviderConfig.delete).toHaveBeenCalledWith({ where: { id: configId } });
      expect(result).toEqual({ id: configId, deleted: true });

      const event = audit.log.mock.calls[0][0];
      expect(event.action).toBe('AI_PROVIDER_DELETED');
      // The row is gone; the audit payload is the only remaining record of what it
      // was, so provider/capability/model are kept — and the key still is not.
      expect(event.newValue).toEqual({
        provider: 'OPENAI',
        capability: 'EMBEDDING',
        modelName: 'text-embedding-3-small',
      });
      expect(serialised(event)).not.toContain('sk-stored');
    });

    it('REFUSES to delete the active default', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row({ enabled: true, isDefault: true }));

      await expect(service.deleteConfig(actor, configId)).rejects.toThrow(ConflictException);

      expect(prisma.aIProviderConfig.delete).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('allows deleting a default row that is DISABLED', async () => {
      // Disabled means it serves no traffic, so it is not load-bearing.
      prisma.aIProviderConfig.findUnique.mockResolvedValue(
        row({ enabled: false, isDefault: true })
      );

      await expect(service.deleteConfig(actor, configId)).resolves.toEqual({
        id: configId,
        deleted: true,
      });
    });

    it('throws NotFoundException for an unknown id', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(null);

      await expect(service.deleteConfig(actor, configId)).rejects.toThrow(NotFoundException);
      expect(prisma.aIProviderConfig.delete).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // testConnection
  // ─────────────────────────────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('probes with the STORED credential and reports success', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue(new Array(1536).fill(0));

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('SUCCESS');
      expect(crypto.decrypt).toHaveBeenCalledWith({
        ciphertext: 'ct(sk-stored)',
        iv: 'iv(sk-stored)',
        authTag: 'tag(sk-stored)',
      });
      expect(openai.generateEmbedding).toHaveBeenCalledTimes(1);
      // The credential travels as a PARAMETER (§6): visible inside the call, and
      // nowhere else — not in `process.env`, not in the response, not in the audit.
      expect(openai.generateEmbedding.mock.calls[0][1]).toEqual(
        expect.objectContaining({ credential: 'sk-stored' })
      );
    });

    it('prefers a SUBMITTED credential over the stored one, enabling verify-before-save', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue([0.1, 0.2]);

      const result = await service.testConnection(actor, configId, { credential: 'sk-submitted' });

      expect(result.status).toBe('SUCCESS');
      // The stored key is not even decrypted when a candidate was supplied.
      expect(crypto.decrypt).not.toHaveBeenCalled();
      expect(openai.generateEmbedding.mock.calls[0][1]).toEqual(
        expect.objectContaining({ credential: 'sk-submitted' })
      );
    });

    it('NEVER writes process.env, even while probing with a submitted credential', async () => {
      // The env-scoped runner this replaced was the one place a request-supplied
      // key could outlive the request — and interleave with a live execution that
      // had its own credential.
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue([0.1]);

      await service.testConnection(actor, configId, { credential: 'sk-submitted' });

      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
    });

    it('NEVER writes process.env when the probe THROWS', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await service.testConnection(actor, configId, { credential: 'sk-bad' });

      expect(result.status).toBe('FAILURE');
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
    });

    it('leaves a previously-unset OPENAI_API_KEY unset', async () => {
      // The old implementation restored by assignment, which left the key defined
      // as the string "undefined" — configured, to every later `if (!key)` check.
      delete process.env.OPENAI_API_KEY;
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue([0.1]);

      await service.testConnection(actor, configId, { credential: 'sk-submitted' });

      expect('OPENAI_API_KEY' in process.env).toBe(false);
    });

    it('probes with the row\'s OWN model and baseUrl (§13 runtime-effective)', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(
        row({ modelName: 'text-embedding-3-large', baseUrl: 'http://ollama:11434/v1' })
      );
      openai.generateEmbedding.mockResolvedValue([0.1]);

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('SUCCESS');
      expect(openai.generateEmbedding.mock.calls[0][1]).toEqual({
        model: 'text-embedding-3-large',
        baseUrl: 'http://ollama:11434/v1',
        credential: 'sk-stored',
      });
    });

    it('returns FAILURE with NO upstream detail when the provider errors', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockRejectedValue(
        new Error('401 {"error":{"message":"Incorrect API key provided: sk-lea...kEd"}}')
      );

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('FAILURE');
      // No status code, no upstream body, no key fragment: the message is fixed.
      expect(result.message).not.toMatch(/401|Incorrect API key|sk-lea/);
      expect(Object.keys(result).sort()).toEqual(['message', 'status']);
    });

    it('returns FAILURE when the provider yields an empty vector', async () => {
      // A 200 with no embedding is not a working connection.
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue([]);

      expect((await service.testConnection(actor, configId, {})).status).toBe('FAILURE');
    });

    it('returns FAILURE without probing when no credential is available anywhere', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(
        row({ credentialCiphertext: null, credentialIv: null, credentialAuthTag: null })
      );

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('FAILURE');
      expect(openai.generateEmbedding).not.toHaveBeenCalled();
    });

    it('returns FAILURE without probing for an unsupported capability', async () => {
      // Calling a method known to throw would report a network-shaped failure for
      // what is really a "not built yet".
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row({ capability: 'TEXT_GENERATION' }));

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('FAILURE');
      expect(openai.generateEmbedding).not.toHaveBeenCalled();
    });

    it('returns FAILURE WITHOUT probing when the stored credential cannot be decrypted', async () => {
      // §14: a broken stored envelope is a REAL failure. The silent alternative —
      // falling through to the process-wide env key — would mask a rotated master
      // key behind apparently-working behaviour.
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      crypto.decrypt.mockImplementationOnce(() => {
        throw new Error('bad auth tag');
      });

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('FAILURE');
      expect(openai.generateEmbedding).not.toHaveBeenCalled();
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
    });

    it('returns FAILURE WITHOUT probing when the stored endpoint violates the policy (§18)', async () => {
      // Runtime-effective baseUrl means the policy must gate it: a link-local
      // address (the cloud metadata service lives there) predating the policy
      // must not steer the probe either.
      prisma.aIProviderConfig.findUnique.mockResolvedValue(
        row({ baseUrl: 'http://169.254.169.254/latest/meta-data/' })
      );

      const result = await service.testConnection(actor, configId, {});

      expect(result.status).toBe('FAILURE');
      expect(openai.generateEmbedding).not.toHaveBeenCalled();
      // The refusal reason is never echoed into the response shape.
      expect(Object.keys(result).sort()).toEqual(['message', 'status']);
    });

    it('audits BOTH outcomes, recording which key was exercised but not the key', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      openai.generateEmbedding.mockResolvedValue([0.1]);

      await service.testConnection(actor, configId, { credential: 'sk-submitted' });

      const success = audit.log.mock.calls[0][0];
      expect(success.action).toBe('AI_PROVIDER_CONNECTION_TESTED');
      expect(success.success).toBe(true);
      expect(success.newValue.result).toBe('SUCCESS');
      expect(success.newValue.usedSubmittedCredential).toBe(true);
      expect(serialised(success)).not.toContain('sk-submitted');

      audit.log.mockClear();
      openai.generateEmbedding.mockRejectedValue(new Error('nope'));

      await service.testConnection(actor, configId, {});

      const failure = audit.log.mock.calls[0][0];
      expect(failure.success).toBe(false);
      expect(failure.newValue.result).toBe('FAILURE');
      expect(failure.newValue.usedSubmittedCredential).toBe(false);
    });

    it('throws NotFoundException for an unknown id', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(null);

      await expect(service.testConnection(actor, configId, {})).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Runtime resolution moved to `ai-runtime.resolver.spec.ts` (§9); execution
  // moved to `platform/ai/ai-gateway.service.spec.ts` — this service no longer
  // resolves, embeds, or hands out provider instances.
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // Endpoint policy at WRITE time (§18) — the runtime half lives in
  // ai-runtime.resolver.spec.ts, so a row predating the policy cannot steer a call.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('baseUrl endpoint policy (§18)', () => {
    const dto = {
      provider: 'OPENAI' as const,
      capability: 'EMBEDDING' as const,
      modelName: 'text-embedding-3-small',
    };

    it('REFUSES a link-local address on create with a 400, before any write', async () => {
      // 169.254.169.254 is the cloud metadata service. `@IsUrl()` alone accepts it;
      // the policy does not.
      await expect(
        service.createConfig(actor, { ...dto, baseUrl: 'http://169.254.169.254/latest/' })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('REFUSES a URL carrying embedded credentials on create', async () => {
      // §21: a credential never belongs in a URL — it would be logged, echoed in
      // errors and sent in cleartext.
      await expect(
        service.createConfig(actor, { ...dto, baseUrl: 'https://user:pass@api.openai.com/v1' })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts an EXTERNAL endpoint and an INTERNAL local one — no name-shaming', async () => {
      // The local LLM topology (`http://ollama:11434`) must keep working, and it is
      // accepted by the SAME rules as every other hostname: there is no special-case
      // branch to bypass, and none to break.
      tx.aIProviderConfig.create.mockResolvedValue(row({ baseUrl: 'http://ollama:11434/v1' }));

      await expect(
        service.createConfig(actor, { ...dto, baseUrl: 'https://api.openai.com/v1' })
      ).resolves.toBeDefined();

      await expect(
        service.createConfig(actor, { ...dto, baseUrl: 'http://ollama:11434/v1' })
      ).resolves.toBeDefined();
    });

    it('REFUSES a policy-violating baseUrl on update before any write', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());

      await expect(
        service.updateConfig(actor, configId, { baseUrl: 'http://169.254.169.254/' })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('leaves baseUrl untouched when the field is ABSENT on update', async () => {
      prisma.aIProviderConfig.findUnique.mockResolvedValue(row());
      tx.aIProviderConfig.update.mockResolvedValue(row({ modelName: 'text-embedding-3-large' }));

      await expect(
        service.updateConfig(actor, configId, { modelName: 'text-embedding-3-large' })
      ).resolves.toBeDefined();

      expect(tx.aIProviderConfig.update.mock.calls[0][0].data).not.toHaveProperty('baseUrl');
    });
  });
});
