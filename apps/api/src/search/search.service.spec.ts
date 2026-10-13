import { Logger } from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { type AIGatewayContract } from '../platform/ai/ai-gateway.contract';
import { SearchAuthorizer } from './search-authorizer.service';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import { SearchSourceService } from '../platform/search-source/search-source.service';
import { EMBEDDING_DIMENSIONS, SEARCH_MODE } from './search.constants';

/**
 * Phase 49J/AI-ARCH-HARDENING (§19/§28): the SEMANTIC ARM of Global Search —
 * what it asks of the AI gateway and what it does with the answers.
 *
 *  - a correct-width vector runs the semantic arm (HYBRID, not degraded);
 *  - a wrong-width vector or a failed execution DEGRADES to lexical — the lexical
 *    arm still ran, the response never throws, and the client is told `degraded`
 *    without being told why;
 *  - the gateway receives `{ moduleId: 'search' }` and nothing provider-shaped:
 *    this class has no import from `src/ai` at all (asserted by ai-boundaries).
 *
 * The repository is empty-result mocked, so `assemble` short-circuits before the
 * authorization stage: this file pins the AI wiring, not retrieval or RBAC rules.
 */
describe('SearchService — the embedding arm', () => {
  let service: SearchService;
  let repository: { lexicalCandidates: jest.Mock; semanticCandidates: jest.Mock };
  let gateway: { embed: jest.Mock };
  let permissions: { userHasPermission: jest.Mock };
  let authorizer: { authorize: jest.Mock };
  let sources: { weightMultiplier: jest.Mock; authorize: jest.Mock };

  const embeddingResult = (output: number[]) => ({
    capability: 'EMBEDDING' as const,
    provider: 'OPENAI',
    model: 'text-embedding-3-small',
    output,
    metadata: { latencyMs: 1, configurationSource: 'DATABASE' as const },
  });

  beforeEach(() => {
    repository = {
      lexicalCandidates: jest.fn().mockResolvedValue([]),
      semanticCandidates: jest.fn().mockResolvedValue([]),
    };
    gateway = {
      embed: jest.fn().mockResolvedValue(embeddingResult(new Array(EMBEDDING_DIMENSIONS).fill(0.1))),
    };
    permissions = { userHasPermission: jest.fn().mockResolvedValue(false) };
    authorizer = { authorize: jest.fn() };
    sources = { weightMultiplier: jest.fn(() => 1), authorize: jest.fn().mockResolvedValue(new Map()) };

    service = new SearchService(
      repository as unknown as SearchRepository,
      authorizer as unknown as SearchAuthorizer,
      permissions as unknown as PermissionService,
      gateway as unknown as AIGatewayContract,
      sources as unknown as SearchSourceService
    );

    RequestContextService.set({
      requestId: 'req-1',
      correlationId: 'corr-1',
      startTime: Date.now(),
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    // Spied rather than relying on `AsyncLocalStorage.enterWith` surviving the
    // beforeEach→it async boundary — `scope()` reads the context once, here.
    jest.spyOn(RequestContextService, 'get').mockReturnValue({
      requestId: 'req-1',
      correlationId: 'corr-1',
      startTime: Date.now(),
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // The request store is re-`set` in every beforeEach, and each jest file runs
    // in its own worker — no cross-test leakage to clean up by hand.
    jest.restoreAllMocks();
  });

  const query = { q: 'مرخصی' } as { q: string };

  it('embeds the query through the AI GATEWAY and runs the semantic arm (HYBRID)', async () => {
    const response = await service.search('user-1', query);

    expect(gateway.embed).toHaveBeenCalledWith(expect.any(String), { moduleId: 'search' });
    expect(repository.lexicalCandidates).toHaveBeenCalledTimes(1);
    expect(repository.semanticCandidates).toHaveBeenCalledWith(
      new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      'tenant-1',
      undefined
    );
    expect(response.mode).toBe(SEARCH_MODE.HYBRID);
    expect(response.degraded).toBe(false);
  });

  it('refuses a wrong-width vector: LEXICAL/degraded, semantic arm never runs (§20)', async () => {
    gateway.embed.mockResolvedValue(
      embeddingResult(new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1))
    );

    const response = await service.search('user-1', query);

    expect(repository.semanticCandidates).not.toHaveBeenCalled();
    expect(response.mode).toBe(SEARCH_MODE.LEXICAL);
    expect(response.degraded).toBe(true);
  });

  it('serves LEXICAL/degraded when the AI execution FAILS — search never throws', async () => {
    // The gateway's classified errors (CONFIGURATION_ERROR, UNSUPPORTED_CAPABILITY,
    // upstream failures) all arrive here as rejections; the response degrades and
    // the reason never reaches the client.
    gateway.embed.mockRejectedValue(new Error('CONFIGURATION_ERROR'));

    const response = await service.search('user-1', query);

    expect(repository.lexicalCandidates).toHaveBeenCalledTimes(1);
    expect(repository.semanticCandidates).not.toHaveBeenCalled();
    expect(response.mode).toBe(SEARCH_MODE.LEXICAL);
    expect(response.degraded).toBe(true);
  });
});
