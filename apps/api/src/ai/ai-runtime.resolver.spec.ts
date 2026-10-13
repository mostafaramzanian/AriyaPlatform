import { Test } from '@nestjs/testing';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../database/prisma.service';
import { AIExecutionError } from './ai-errors';
import { AIProviderRegistry } from './ai-provider.registry';
import { AIRuntimeResolver } from './ai-runtime.resolver';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { ClaudeProvider } from './claude.provider';
import { LocalLLMProvider } from './local-llm.provider';
import { OpenAIProvider } from './openai.provider';

/**
 * Phase AI-ARCH-HARDENING (§13/§14/§18): runtime resolution.
 *
 * The two halves this file exists to pin, in the order they matter:
 *
 *  1. THE EFFECTIVE CONFIGURATION IS EXPLICIT. A resolved execution carries the
 *     row's `modelName`, `baseUrl` and decrypted credential as per-call OPTIONS —
 *     `process.env` is never written, which is what makes concurrent executions
 *     with different credentials safe (§6).
 *
 *  2. BROKEN CONFIGURATION IS A HARD FAILURE, NEVER AN ENV FALLBACK (§14). An
 *     undecryptable credential, a withdrawn capability or a policy-rejected
 *     endpoint must reject the execution — silently swapping in the process-wide
 *     key or a different model would mask a real misconfiguration behind
 *     apparently-working behaviour.
 *
 * The real registry and real policy are used (mocked matrices would let this file
 * pass while the rules disagreed); the four provider adapters are stubs.
 */
describe('AIRuntimeResolver', () => {
  let resolver: AIRuntimeResolver;
  let prisma: { aIProviderConfig: { findFirst: jest.Mock } };
  let openai: {
    generateText: jest.Mock;
    generateEmbedding: jest.Mock;
    generateCompletion: jest.Mock;
    getEmbeddingContract: jest.Mock;
  };

  const originalEnv = { ...process.env };

  /** A stored row. OPENAI/EMBEDDING because it is the only supported cell. */
  const row = (overrides: Record<string, unknown> = {}) => ({
    provider: 'OPENAI',
    capability: 'EMBEDDING',
    modelName: 'text-embedding-3-small',
    baseUrl: null as string | null,
    credentialCiphertext: 'ct(sk-stored)',
    credentialIv: 'iv(sk-stored)',
    credentialAuthTag: 'tag(sk-stored)',
    enabled: true,
    isDefault: true,
    ...overrides,
  });

  const providerStub = () => ({
    generateText: jest.fn(),
    generateEmbedding: jest.fn(),
    generateCompletion: jest.fn(),
    getEmbeddingContract: jest.fn(() => ({ model: 'env-bootstrap-model', dimension: 1536 })),
  });

  /** Deterministic fake crypto; decryption failures are forced per test. */
  const crypto = {
    encrypt: jest.fn(),
    decrypt: jest.fn((envelope: { ciphertext: string }) =>
      envelope.ciphertext.replace(/^ct\((.*)\)$/, '$1')
    ),
    matches: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AIRuntimeResolver,
        AIProviderRegistry,
        { provide: OpenAIProvider, useValue: providerStub() },
        { provide: AzureOpenAIProvider, useValue: providerStub() },
        { provide: ClaudeProvider, useValue: providerStub() },
        { provide: LocalLLMProvider, useValue: providerStub() },
        { provide: CryptoService, useValue: crypto },
        {
          provide: PrismaService,
          useValue: { aIProviderConfig: { findFirst: jest.fn().mockResolvedValue(null) } },
        },
      ],
    }).compile();

    resolver = moduleRef.get(AIRuntimeResolver);
    prisma = moduleRef.get(PrismaService) as unknown as typeof prisma;
    openai = moduleRef.get(OpenAIProvider) as unknown as typeof openai;

    process.env.OPENAI_API_KEY = 'sk-from-env';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  /** The rejection, classified — `toThrow` alone cannot assert a `code`. */
  const rejection = async (fn: () => unknown): Promise<AIExecutionError> => {
    const error = (await Promise.resolve()
      .then(fn)
      .catch((err) => err)) as AIExecutionError;
    expect(error).toBeInstanceOf(AIExecutionError);
    return error;
  };

  describe('resolveEmbedding — environment bootstrap (no configured row)', () => {
    it('asks for exactly the ENABLED DEFAULT embedding row', async () => {
      await resolver.resolveEmbedding();

      expect(prisma.aIProviderConfig.findFirst).toHaveBeenCalledWith({
        where: { capability: 'EMBEDDING', enabled: true, isDefault: true },
      });
    });

    it('falls back to the env-configured OpenAI path with NO explicit options', async () => {
      // The 49J-A behaviour, preserved: no row means the adapter reads its own env
      // bootstrap — so there is exactly one definition of the env defaults.
      const resolved = await resolver.resolveEmbedding();

      expect(resolved.providerKey).toBe('OPENAI');
      expect(resolved.configurationSource).toBe('ENVIRONMENT');
      expect(resolved.model).toBe('env-bootstrap-model');
      expect(resolved.adapter).toBe(openai);
      expect(resolved.executionOptions).toBeUndefined();
    });
  });

  describe('resolveEmbedding — configured row (§13 runtime-effective)', () => {
    it('applies the row model, baseUrl and decrypted credential as execution options', async () => {
      prisma.aIProviderConfig.findFirst.mockResolvedValue(
        row({ modelName: 'text-embedding-3-large', baseUrl: 'http://ollama:11434/v1' })
      );

      const resolved = await resolver.resolveEmbedding();

      expect(resolved.configurationSource).toBe('DATABASE');
      expect(resolved.model).toBe('text-embedding-3-large');
      expect(resolved.baseUrl).toBe('http://ollama:11434/v1');
      expect(resolved.adapter).toBe(openai);
      expect(resolved.executionOptions).toEqual({
        model: 'text-embedding-3-large',
        baseUrl: 'http://ollama:11434/v1',
        credential: 'sk-stored',
      });
      expect(crypto.decrypt).toHaveBeenCalledWith({
        ciphertext: 'ct(sk-stored)',
        iv: 'iv(sk-stored)',
        authTag: 'tag(sk-stored)',
      });
    });

    it('NEVER writes process.env while resolving a stored credential', async () => {
      // The whole point of §6: two concurrent executions must not be able to see
      // each other's key, and the env bootstrap must stay independent of the row.
      prisma.aIProviderConfig.findFirst.mockResolvedValue(row());

      await resolver.resolveEmbedding();

      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
    });

    it('yields NO credential when the row stores none (env key applies downstream)', async () => {
      prisma.aIProviderConfig.findFirst.mockResolvedValue(
        row({ credentialCiphertext: null, credentialIv: null, credentialAuthTag: null })
      );

      const resolved = await resolver.resolveEmbedding();

      expect(resolved.executionOptions).toEqual({
        model: 'text-embedding-3-small',
        baseUrl: undefined,
        credential: undefined,
      });
      expect(crypto.decrypt).not.toHaveBeenCalled();
    });

    it('is NOT MEMOISED, so switching the default takes effect immediately (§40)', async () => {
      prisma.aIProviderConfig.findFirst.mockResolvedValue(row());

      await resolver.resolveEmbedding();
      await resolver.resolveEmbedding();

      expect(prisma.aIProviderConfig.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('HARD FAILURES — broken configuration never falls back to env (§14)', () => {
    it('rejects an UNDECRYPTABLE stored credential with CONFIGURATION_ERROR', async () => {
      prisma.aIProviderConfig.findFirst.mockResolvedValue(row());
      crypto.decrypt.mockImplementationOnce(() => {
        throw new Error('bad auth tag');
      });

      const error = await rejection(() => resolver.resolveEmbedding());

      expect(error.code).toBe('CONFIGURATION_ERROR');
      // The failure never carries key material, even in its message.
      expect(String(error.message)).not.toContain('sk-');
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
    });

    it('rejects a WITHDRAWN capability with UNSUPPORTED_CAPABILITY instead of env-falling-back', async () => {
      // The matrix is code, the row is data: a row saved under an older matrix must
      // not keep resolving — and must not silently hand the call to the env-configured
      // provider with a different key and model than the operator chose.
      prisma.aIProviderConfig.findFirst.mockResolvedValue(
        row({ provider: 'ANTHROPIC', capability: 'EMBEDDING' })
      );

      const error = await rejection(() => resolver.resolveEmbedding());

      expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
      // Refused before decrypting: no reason to touch the key for a dead row.
      expect(crypto.decrypt).not.toHaveBeenCalled();
    });

    it('rejects a POLICY-REJECTED endpoint with SECURITY_POLICY_REJECTED (§18)', async () => {
      // Runtime-effective baseUrl means the policy runs HERE too: a row written
      // before the policy existed cannot steer a call at the metadata service.
      prisma.aIProviderConfig.findFirst.mockResolvedValue(
        row({ baseUrl: 'http://169.254.169.254/latest/meta-data/' })
      );

      const error = await rejection(() => resolver.resolveEmbedding());

      expect(error.code).toBe('SECURITY_POLICY_REJECTED');
      expect(String(error.message)).not.toContain('sk-');
    });
  });

  describe('resolveStoredRow — the connection test path', () => {
    it('takes a SUBMITTED credential over the stored one and skips decryption', async () => {
      const resolved = resolver.resolveStoredRow(row(), 'sk-submitted');

      expect(resolved.executionOptions?.credential).toBe('sk-submitted');
      expect(crypto.decrypt).not.toHaveBeenCalled();
    });

    it('re-checks the capability matrix before handing back an adapter', () => {
      // LOCAL/EMBEDDING is unsupported; the defence-in-depth check throws rather
      // than returning an adapter whose call would fail confusingly later.
      expect(() => resolver.resolveStoredRow(row({ provider: 'LOCAL' }) as never)).toThrow(
        AIExecutionError
      );
    });
  });
});
