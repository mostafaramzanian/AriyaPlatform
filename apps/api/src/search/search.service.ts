import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { SearchSourceType } from '../generated/core-client';
import { RequestContextService } from '../common/request-context.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { Permissions } from '../auth/rbac/constants/permissions';
import { AI_GATEWAY, type AIGatewayContract } from '../platform/ai/ai-gateway.contract';
import { SearchRepository } from './search.repository';
import { SearchAuthorizer } from './search-authorizer.service';
import { normalizeForQuery } from './persian-normalize';
import { buildBestSnippet } from './search-snippet';
import {
  candidateKey,
  hybridScore,
  mergeCandidates,
  weightCandidate,
  type RetrievedCandidate,
} from './search-ranking';
import {
  DEFAULT_SEARCH_LIMIT,
  EMBEDDING_DIMENSIONS,
  EXTERNAL_SEARCH_SOURCE_TYPE,
  MAX_MERGED_CANDIDATES,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  SEARCH_MODE,
  type PlatformSearchSourceType,
  type SearchMode,
} from './search.constants';
import {
  externalCandidateKey,
} from '../platform/search-source/search-source.contract';
import { SearchSourceService } from '../platform/search-source/search-source.service';
import type { SearchQueryDto } from './dto/search-query.dto';
import type {
  SearchResponseDto,
  SearchResultDto,
  SearchScope,
} from './search.types';

/**
 * Phase 49J: Global Search orchestration.
 *
 * THE ORDER OF THE PIPELINE IS THE DESIGN, and every step is here for a reason that
 * would be violated by reordering it:
 *
 *   1. NORMALIZE      — the same function the indexer used, so the query and the index
 *                       cannot disagree about what a word is.
 *   2. LEXICAL ARM    — always runs. It is the only arm that works with no credential.
 *   3. EMBED THE QUERY— ONE call, wrapped, and a failure DEGRADES rather than fails.
 *   4. SEMANTIC ARM   — only if step 3 produced a vector of the right width.
 *   5. MERGE + RANK   — pure functions, then truncate to MAX_MERGED_CANDIDATES.
 *   6. AUTHORIZE      — the security boundary. Runs AFTER retrieval, on a BOUNDED set,
 *                       because retrieval cannot express these rules. Platform
 *                       candidates go to `SearchAuthorizer` (Core re-read);
 *                       `EXTERNAL` candidates go to their OWNING source's adapter
 *                       through `SearchSourceService`, in one batched call per
 *                       source. Neither side trusts the index.
 *   7. SNIPPET        — from the AUTHORITATIVE row returned by step 6, never from the
 *                       projection, so a snippet cannot be stale and unauthorized text
 *                       is never read.
 *   8. PAGE           — slice the authorized, re-sorted list.
 *
 * WHY AUTHORIZATION IS LAST AND NOT A QUERY PREDICATE: the rules span eight tables and
 * include `ConversationMember` membership, ticket participation, survey publication
 * state and RBAC permissions. Expressing them in the retrieval SQL would mean joining
 * every business table into the ranking query — and would still be a second
 * implementation of rules that already exist in five services, free to drift from them.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly repository: SearchRepository,
    private readonly authorizer: SearchAuthorizer,
    private readonly permissions: PermissionService,
    // The platform AI GATEWAY contract (§19), not `AIConfigService` and never a
    // provider class: search states "embed this query" and cannot see which provider
    // runs, where a credential is stored, or what the endpoint is. The same seam the
    // eventual Reporting module will use.
    @Inject(AI_GATEWAY) private readonly ai: AIGatewayContract,
    private readonly searchSources: SearchSourceService
  ) {}

  /**
   * Resolves the caller's scope from the AUTHENTICATED REQUEST ONLY.
   *
   * `userId` is asserted against `RequestContextService`, `tenantId` is read from it,
   * and the two permission flags come from the RBAC catalogue. Nothing here can be
   * influenced by a query parameter, a header or a body — which is why `SearchQueryDto`
   * has no `tenantId`, `userId` or `asUser` field.
   *
   * The two permissions are resolved CONCURRENTLY, matching `SurveysService.scope`.
   */
  private async scope(userId: string): Promise<SearchScope> {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      // Mirrors SupportService/SurveysService: the subject is never trusted from an
      // argument, so no code path can search as another user.
      throw new ForbiddenException('Search context is required');
    }

    const [isSupportAgent, isSurveyManager] = await Promise.all([
      this.permissions.userHasPermission(userId, Permissions.ADMIN_SUPPORT_MANAGE),
      this.permissions.userHasPermission(userId, Permissions.ADMIN_SURVEYS_MANAGE),
    ]);

    return {
      userId,
      tenantId: context.tenantId ?? null,
      isSupportAgent,
      isSurveyManager,
    };
  }

  /** Capped, never rejected — matching DirectoryService and SupportService. */
  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  }

  /**
   * The one public entry point.
   *
   * Returns an EMPTY, well-formed response rather than throwing when the normalized
   * query is too short. A query of pure punctuation or ZWNJ normalizes to nothing
   * however long it looked, and a 400 for "…" would be a worse experience than an
   * empty result — the DTO's `MinLength` already rejects genuinely absent input.
   */
  async search(userId: string, query: SearchQueryDto): Promise<SearchResponseDto> {
    const scope = await this.scope(userId);
    const normalizedQuery = normalizeForQuery(query.q);
    const limit = this.clampLimit(query.limit);
    const offset = query.offset ?? 0;
    const sourceType = query.sourceType as SearchSourceType | undefined;

    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      return this.empty(query.q, normalizedQuery, SEARCH_MODE.LEXICAL, false);
    }

    // ---- Arm 1: lexical. Always runs. -------------------------------------------
    const lexical = await this.repository.lexicalCandidates(
      normalizedQuery,
      scope.tenantId,
      sourceType
    );

    // ---- Arm 2: semantic. Best-effort. ------------------------------------------
    const embedding = await this.embedQuery(normalizedQuery);
    const mode: SearchMode = embedding ? SEARCH_MODE.HYBRID : SEARCH_MODE.LEXICAL;
    const degraded = embedding === null;

    let semantic: RetrievedCandidate[] = [];
    if (embedding) {
      try {
        semantic = await this.repository.semanticCandidates(embedding, scope.tenantId, sourceType);
      } catch (error) {
        // A vector-store failure must not take the lexical results down with it. The
        // response reports LEXICAL/degraded, which is then accurate.
        this.logger.error(
          `Semantic retrieval failed - serving lexical results only: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
        return this.assemble(query.q, normalizedQuery, scope, lexical, [], SEARCH_MODE.LEXICAL, true, limit, offset);
      }
    }

    return this.assemble(
      query.q,
      normalizedQuery,
      scope,
      lexical,
      semantic,
      mode,
      degraded,
      limit,
      offset
    );
  }

  /**
   * Embeds the query, or returns `null` when semantic retrieval is unavailable.
   *
   * ONE CALL PER SEARCH, never one per candidate — the query is embedded, the documents
   * were embedded at index time.
   *
   * A MISSING CREDENTIAL IS A DEGRADED MODE, NOT AN ERROR. With no `AIProviderConfig`
   * row and no `OPENAI_API_KEY`, the gateway rejects the execution; that is caught
   * here, the search continues lexically, and the client is told `degraded: true`
   * WITHOUT being told why. Provider identity, model name and credential state are
   * administrative facts guarded by `admin.ai.read`; leaking them through a search
   * response would make every authenticated user a reader of AI configuration.
   *
   * The width is asserted before use: a wrong-width vector cannot be compared against
   * the `vector(1536)` column at all, and truncating or padding it would silently
   * compare a different point in space.
   */
  private async embedQuery(normalizedQuery: string): Promise<number[] | null> {
    try {
      const result = await this.ai.embed(normalizedQuery, { moduleId: 'search' });
      const vector = result.output;

      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        this.logger.error(
          `Query embedding width ${
            Array.isArray(vector) ? vector.length : 'n/a'
          } does not match the ${EMBEDDING_DIMENSIONS}-dimension column - degrading to lexical`
        );
        return null;
      }

      return vector;
    } catch (error) {
      this.logger.warn(
        `Query embedding unavailable - serving lexical results: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      );
      return null;
    }
  }

  /** A well-formed empty response. Shape-identical to a populated one. */
  private empty(
    query: string,
    normalizedQuery: string,
    mode: SearchMode,
    degraded: boolean
  ): SearchResponseDto {
    return {
      query,
      normalizedQuery,
      results: [],
      count: 0,
      hasMore: false,
      mode,
      degraded,
      sourceCounts: {},
    };
  }

  /**
   * Merge → truncate → AUTHORIZE → snippet → sort → page.
   *
   * TRUNCATION HAPPENS BEFORE AUTHORIZATION, and the order matters both ways: bounding
   * first keeps the authorization stage's cost bounded, and authorizing before paging is
   * what makes every returned row one the caller may actually see. Slicing first would
   * hand back a page whose size depended on how much the caller was not allowed to read.
   */
  private async assemble(
    query: string,
    normalizedQuery: string,
    scope: SearchScope,
    lexical: readonly RetrievedCandidate[],
    semantic: readonly RetrievedCandidate[],
    mode: SearchMode,
    degraded: boolean,
    limit: number,
    offset: number
  ): Promise<SearchResponseDto> {
    // The external weight resolver is created ONCE per search so the merge step and
    // the final scoring below read the same registry view.
    const externalWeights = (sourceKey: string) => this.searchSources.weightMultiplier(sourceKey);

    const merged = mergeCandidates(lexical, semantic, mode, externalWeights).slice(
      0,
      MAX_MERGED_CANDIDATES
    );

    if (merged.length === 0) {
      return this.empty(query, normalizedQuery, mode, degraded);
    }

    // Partition the candidates: the platform's own sources are re-read from Core
    // tables; EXTERNAL rows are authorized by their OWNING bounded context through
    // the search source contract. Two dispatches, both batched (one grouped query per
    // source type; one adapter call per source) — never one call per candidate.
    const platformCandidates: Array<{ sourceType: PlatformSearchSourceType; sourceId: string }> = [];
    const externalCandidates: Array<{ sourceKey: string; entityId: string }> = [];

    for (const candidate of merged) {
      if (candidate.sourceType === EXTERNAL_SEARCH_SOURCE_TYPE) {
        externalCandidates.push({ sourceKey: candidate.sourceKey, entityId: candidate.sourceId });
      } else {
        platformCandidates.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId });
      }
    }

    const [authorized, authorizedExternal] = await Promise.all([
      this.authorizer.authorize(scope, platformCandidates),
      this.searchSources.authorize(
        { userId: scope.userId, tenantId: scope.tenantId },
        externalCandidates
      ),
    ]);

    // Re-scored from the authoritative answers and re-sorted, because authorization
    // may have dropped rows and because the source weight is applied here for the
    // last time.
    const results: SearchResultDto[] = [];
    for (const candidate of merged) {
      const isExternal = candidate.sourceType === EXTERNAL_SEARCH_SOURCE_TYPE;

      const source = isExternal
        ? authorizedExternal.get(externalCandidateKey(candidate.sourceKey, candidate.sourceId))
        : authorized.get(candidateKey(candidate.sourceType, candidate.sourceId));

      if (!source) continue; // Unauthorized, the source refused it, or the row is gone.

      const score = weightCandidate(
        hybridScore(candidate.lexicalScore, candidate.semanticScore, mode),
        candidate,
        externalWeights
      );

      // Defensive: the merge step already excluded unresolvable external candidates,
      // so this can only fire if a source was unregistered mid-search. Drop, never guess.
      if (score === null) continue;

      // The snippet comes from `snippetFields` — text read from the authoritative row
      // (platform) or returned by the source's own authorization answer (external),
      // AFTER that row passed its rule — never from `SearchDocument`, which stores no
      // raw text.
      const snippet = buildBestSnippet(source.snippetFields, normalizedQuery);

      results.push({
        sourceType: candidate.sourceType,
        // Present ONLY on external results; platform results keep their byte-identical
        // wire shape (omitted, not `undefined` — see SearchResultDto).
        ...(isExternal ? { sourceKey: candidate.sourceKey } : {}),
        sourceId: candidate.sourceId,
        title: source.title,
        snippet: snippet.text,
        highlights: snippet.highlights,
        score,
        matchedBy: {
          lexical: candidate.lexicalScore !== null,
          // Honest in degraded mode: false for every result, because no semantic arm ran.
          semantic: mode !== SEARCH_MODE.LEXICAL && candidate.semanticScore !== null,
        },
        timestamp: source.timestamp,
        navigation: source.navigation,
      });
    }

    results.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));

    const page = results.slice(offset, offset + limit);

    return {
      query,
      normalizedQuery,
      results: page,
      count: page.length,
      // Derived from the AUTHORIZED set, so it never advertises rows the caller cannot
      // see. It is not a corpus total: a true total would require authorizing the whole
      // corpus, and reporting an unauthorized one would leak how much exists.
      hasMore: results.length > offset + page.length,
      mode,
      degraded,
      sourceCounts: this.countBySource(results),
    };
  }

  /**
   * Facet counts over the AUTHORIZED results, not over the candidate set.
   *
   * Counting candidates would tell the caller how many matching tickets, messages or
   * surveys exist that they are not allowed to open — a small but real information leak,
   * and the one that facet counters most often ship by accident.
   */
  private countBySource(
    results: readonly SearchResultDto[]
  ): Partial<Record<SearchSourceType, number>> {
    const counts: Partial<Record<SearchSourceType, number>> = {};

    for (const result of results) {
      counts[result.sourceType] = (counts[result.sourceType] ?? 0) + 1;
    }

    return counts;
  }
}
