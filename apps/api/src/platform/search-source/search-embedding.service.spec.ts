import { Logger } from '@nestjs/common';
import { type AIGatewayContract, type AIEmbeddingExecutionResult } from '../ai/ai-gateway.contract';
import { SearchEmbeddingService } from './search-embedding.service';
import { EMBEDDING_DIMENSIONS } from '../../search/search.constants';

/**
 * Phase AI-ARCH-HARDENING (§19/§28): the search embedding path against the AI
 * GATEWAY contract.
 *
 * Pinned here: the configured path returns vector + EFFECTIVE model, a gateway
 * failure or a wrong-width vector degrades to lexical (never throws, never
 * fabricates), the latch holds for the rest of a pass, and `beginPass` resets it.
 * The ENV-fallback half of §28 lives in ai-runtime.resolver.spec.ts — from this
 * layer's point of view both provenances are just gateway results.
 */
describe('SearchEmbeddingService', () => {
  let gateway: { embed: jest.Mock };
  let service: SearchEmbeddingService;

  const gatewayResult = (overrides: Partial<AIEmbeddingExecutionResult> = {}) => ({
    capability: 'EMBEDDING' as const,
    provider: 'OPENAI',
    model: 'text-embedding-3-small',
    output: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
    metadata: { latencyMs: 1, configurationSource: 'DATABASE' as const },
    ...overrides,
  });

  beforeEach(() => {
    gateway = { embed: jest.fn().mockResolvedValue(gatewayResult()) };
    service = new SearchEmbeddingService(gateway as unknown as AIGatewayContract);

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the vector with the EFFECTIVE model, through the gateway with moduleId', async () => {
    gateway.embed.mockResolvedValue(gatewayResult({ model: 'text-embedding-3-large' }));

    const embedded = await service.embed('سلام دنیا');

    expect(embedded).toEqual({
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      model: 'text-embedding-3-large',
    });
    expect(gateway.embed).toHaveBeenCalledWith('سلام دنیا', { moduleId: 'search' });
  });

  it('returns null (lexical-only row) when the gateway fails — never throws', async () => {
    gateway.embed.mockRejectedValue(new Error('CONFIGURATION_ERROR'));

    await expect(service.embed('x')).resolves.toBeNull();
  });

  it('refuses a wrong-width vector and latches the pass OFF (§20)', async () => {
    gateway.embed.mockResolvedValue(gatewayResult({ output: new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1) }));

    await expect(service.embed('x')).resolves.toBeNull();

    // The first failure is proof the provider is unavailable: the rest of the pass
    // must not retry once per row.
    await expect(service.embed('y')).resolves.toBeNull();
    expect(gateway.embed).toHaveBeenCalledTimes(1);
  });

  it('latches after a gateway failure too, and beginPass resets it', async () => {
    gateway.embed.mockRejectedValue(new Error('nope'));

    await service.embed('x');
    await service.embed('y');
    expect(gateway.embed).toHaveBeenCalledTimes(1);

    service.beginPass();
    gateway.embed.mockResolvedValue(gatewayResult());
    await service.embed('z');

    expect(gateway.embed).toHaveBeenCalledTimes(2);
  });

  it('returns null without calling the gateway when already latched', async () => {
    gateway.embed.mockRejectedValueOnce(new Error('nope'));

    await service.embed('x');
    await service.embed('y');

    expect(gateway.embed).toHaveBeenCalledTimes(1);
  });
});
