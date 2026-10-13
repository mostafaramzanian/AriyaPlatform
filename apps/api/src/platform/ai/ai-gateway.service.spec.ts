import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AIExecutionError, AI_ERROR_CODES } from '../../ai/ai-errors';
import { AIRuntimeResolver, type ResolvedAIExecution } from '../../ai/ai-runtime.resolver';
import { AIGateway } from './ai-gateway.service';

/**
 * Phase AI-ARCH-HARDENING (§6/§11/§33/§34): the AI gateway.
 *
 *  - STRUCTURED RESULT: capability/provider/model/output/metadata, and the
 *    credential absent at every depth (a leak assertion over the serialised form).
 *  - CONCURRENCY (§28, mandatory): two executions with different credentials run
 *    through an interleave — the exact schedule that made the old env-scoped
 *    runner hand one call the other's key — and each sees only its own.
 *  - ERROR TAXONOMY: classified errors pass through unchanged, bare errors are
 *    wrapped UPSTREAM_UNAVAILABLE with a safe message, caller errors stay callers'.
 *  - LOGGING: failures log once with closed safe fields; nothing contains the
 *    credential or the caller's input text.
 */
describe('AIGateway', () => {
  let gateway: AIGateway;
  let resolver: { resolveEmbedding: jest.Mock };
  let adapter: { generateEmbedding: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const originalEnv = { ...process.env };

  const execution = (overrides: Partial<ResolvedAIExecution> = {}): ResolvedAIExecution => ({
    providerKey: 'OPENAI',
    adapter: adapter as unknown as ResolvedAIExecution['adapter'],
    model: 'text-embedding-3-small',
    baseUrl: null,
    configurationSource: 'DATABASE',
    executionOptions: { model: 'text-embedding-3-small', credential: 'sk-stored' },
    ...overrides,
  });

  beforeEach(async () => {
    adapter = { generateEmbedding: jest.fn() };
    resolver = { resolveEmbedding: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [AIGateway, { provide: AIRuntimeResolver, useValue: resolver }],
    }).compile();

    gateway = moduleRef.get(AIGateway);

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.OPENAI_API_KEY = 'sk-from-env';
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe('structured result (§11)', () => {
    it('returns capability, provider, effective model, output and metadata', async () => {
      adapter.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      resolver.resolveEmbedding.mockResolvedValue(execution());

      const result = await gateway.embed('متن نمونه', {
        moduleId: 'search',
        correlationId: 'corr-1',
      });

      expect(result).toEqual({
        capability: 'EMBEDDING',
        provider: 'OPENAI',
        model: 'text-embedding-3-small',
        output: [0.1, 0.2, 0.3],
        metadata: {
          latencyMs: expect.any(Number),
          configurationSource: 'DATABASE',
          correlationId: 'corr-1',
        },
      });
      expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('hands the EFFECTIVE options — model and credential — to the adapter', async () => {
      adapter.generateEmbedding.mockResolvedValue([1]);
      resolver.resolveEmbedding.mockResolvedValue(
        execution({
          model: 'text-embedding-3-large',
          baseUrl: 'http://ollama:11434/v1',
          executionOptions: {
            model: 'text-embedding-3-large',
            baseUrl: 'http://ollama:11434/v1',
            credential: 'sk-stored',
          },
        })
      );

      await gateway.embed('x');

      expect(adapter.generateEmbedding).toHaveBeenCalledWith('x', {
        model: 'text-embedding-3-large',
        baseUrl: 'http://ollama:11434/v1',
        credential: 'sk-stored',
      });
    });

    it('surfaces the ENVIRONMENT bootstrap as configuration provenance', async () => {
      adapter.generateEmbedding.mockResolvedValue([1]);
      resolver.resolveEmbedding.mockResolvedValue(
        execution({ model: 'env-bootstrap-model', configurationSource: 'ENVIRONMENT', executionOptions: undefined })
      );

      const result = await gateway.embed('x');

      expect(result.model).toBe('env-bootstrap-model');
      expect(result.metadata.configurationSource).toBe('ENVIRONMENT');
    });

    it('the credential NEVER appears in the result at any depth', async () => {
      adapter.generateEmbedding.mockResolvedValue([0.1]);
      resolver.resolveEmbedding.mockResolvedValue(execution());

      const result = await gateway.embed('x', { correlationId: 'c' });

      expect(JSON.stringify(result)).not.toContain('sk-stored');
      expect(JSON.stringify(result)).not.toContain('credential');
    });
  });

  describe('CONCURRENCY (§28 — two executions, two credentials, one process)', () => {
    it('each execution sees ONLY its own credential, with no env mutation', async () => {
      // The interleave below is precisely the schedule the old `process.env`
      // scoped runner could not survive: call A resolves its credential, yields
      // mid-call, and call B — with a DIFFERENT credential — runs before A
      // resumes. With explicit parameters each call carries its own key.
      resolver.resolveEmbedding
        .mockResolvedValueOnce(
          execution({ executionOptions: { model: 'm', credential: 'sk-A' } })
        )
        .mockResolvedValueOnce(
          execution({ executionOptions: { model: 'm', credential: 'sk-B' } })
        );

      const seenCredentials: (string | undefined)[] = [];
      adapter.generateEmbedding.mockImplementation(
        async (_input: string, options: { credential?: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seenCredentials.push(options?.credential);
          return [1];
        }
      );

      const [first, second] = await Promise.all([
        gateway.embed('first'),
        gateway.embed('second'),
      ]);

      expect(seenCredentials).toEqual(['sk-A', 'sk-B']);
      expect(first.output).toEqual([1]);
      expect(second.output).toEqual([1]);
      // Neither credential ever reached the environment.
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-env');
      expect(JSON.stringify({ first, second })).not.toContain('sk-A');
      expect(JSON.stringify({ first, second })).not.toContain('sk-B');
    });
  });

  describe('error classification (§33)', () => {
    it('passes a classified AIExecutionError through UNCHANGED', async () => {
      const failure = new AIExecutionError(
        AI_ERROR_CODES.UPSTREAM_TIMEOUT,
        'Embedding request timed out after 15000ms'
      );
      adapter.generateEmbedding.mockRejectedValue(failure);
      resolver.resolveEmbedding.mockResolvedValue(execution());

      const error = await gateway.embed('x').catch((err) => err);

      expect(error).toBe(failure);
      expect(error.code).toBe('UPSTREAM_TIMEOUT');
    });

    it('wraps a bare adapter Error as UPSTREAM_UNAVAILABLE with a SAFE message', async () => {
      adapter.generateEmbedding.mockRejectedValue(new Error('socket hang up sk-leaked'));
      resolver.resolveEmbedding.mockResolvedValue(execution());

      const error = await gateway.embed('x').catch((err) => err);

      expect(error).toBeInstanceOf(AIExecutionError);
      expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      // The adapter's raw message (which could carry anything upstream said) is
      // attached as `cause`, never presented as the failure message.
      expect(error.message).toBe('AI provider call failed');
      expect(error.message).not.toContain('sk-leaked');
    });

    it('propagates a resolution failure without ever calling an adapter', async () => {
      const failure = new AIExecutionError(
        AI_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        'Provider ANTHROPIC does not support EMBEDDING'
      );
      resolver.resolveEmbedding.mockRejectedValue(failure);

      const error = await gateway.embed('x').catch((err) => err);

      expect(error).toBe(failure);
      expect(adapter.generateEmbedding).not.toHaveBeenCalled();
    });

    it('keeps a caller-shaped BadRequestException as-is (it is not an execution failure)', async () => {
      const failure = new BadRequestException('Embedding texts[0] is required');
      adapter.generateEmbedding.mockRejectedValue(failure);
      resolver.resolveEmbedding.mockResolvedValue(execution());

      const error = await gateway.embed('x').catch((err) => err);

      expect(error).toBe(failure);
    });
  });

  describe('logging (§34)', () => {
    it('logs ONE structured failure line with safe fields only', async () => {
      adapter.generateEmbedding.mockRejectedValue(
        new AIExecutionError(AI_ERROR_CODES.UPSTREAM_UNAVAILABLE, 'Embedding request failed')
      );
      resolver.resolveEmbedding.mockResolvedValue(execution());

      await gateway.embed('محتوای محرمانه', { moduleId: 'search', correlationId: 'corr-9' }).catch(() => undefined);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context] = warnSpy.mock.calls[0];

      expect(context).toMatchObject({
        provider: 'OPENAI',
        capability: 'EMBEDDING',
        model: 'text-embedding-3-small',
        code: 'UPSTREAM_UNAVAILABLE',
        status: 'FAILURE',
        latencyMs: expect.any(Number),
        moduleId: 'search',
        correlationId: 'corr-9',
      });

      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('sk-stored');
      expect(logged).not.toContain('محتوای محرمانه');
    });

    it('does NOT log per successful execution — bulk indexing would drown the log', async () => {
      adapter.generateEmbedding.mockResolvedValue([1]);
      resolver.resolveEmbedding.mockResolvedValue(execution());

      await gateway.embed('x');

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
