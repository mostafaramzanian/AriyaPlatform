import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_GATEWAY, type AIGatewayContract } from '../../platform/ai/ai-gateway.contract';
import { EMBEDDING_DIMENSIONS } from '../../search/search.constants';

/**
 * Phase P-SEARCH-SOURCE: THE embedding path for the search index.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this phase the embedding call lived inside `SearchIndexerService`, which
 * was the only writer of `SearchDocument`. The platform search source contract
 * added a SECOND writer (the ingestion boundary for external projections), and two
 * implementations of "embed this text, or honestly report that you could not"
 * would be two chances to disagree about the width check, the failure semantics or
 * the latch — on the one part of the pipeline that costs money per call. The
 * method is therefore MOVED, not copied: its body, its messages and its latch are
 * verbatim the ones Phase 49J shipped, and both writers now call it.
 *
 * The latch resets per WRITE PASS (`beginPass`), mirroring the indexer's old
 * `rebuildAll` reset: the first failure in a pass is proof the provider is
 * unavailable, so the rest of the pass runs lexical-only instead of retrying once
 * per row.
 *
 * PHASE AI-ARCH-HARDENING (§19): the dependency is the platform AI GATEWAY — not
 * `AIConfigService`, and never a provider class. This file cannot see which
 * provider runs, where a credential is stored or what the endpoint is; it states
 * what it wants and applies the one rule the STORE owns (the width check below).
 * It also carries the EFFECTIVE model of the vector back to the writer, so the
 * `embeddingModel` tag records the space the vector actually belongs to instead of
 * the environment's bootstrap guess.
 */

/** One vector plus the model that produced it — what the writer stamps rows with. */
export interface EmbeddedVector {
  vector: number[];
  /** Effective model id; stored as `SearchDocument.embeddingModel`. */
  model: string;
}

@Injectable()
export class SearchEmbeddingService {
  private readonly logger = new Logger(SearchEmbeddingService.name);

  /**
   * Latches OFF for the remainder of a pass once an embedding call fails.
   *
   * Without this, a missing credential would produce one failed HTTP attempt per
   * row — for a full rebuild, thousands of identical failures and thousands of log
   * lines. The first failure is enough evidence that the provider is unavailable.
   */
  private available = true;

  constructor(@Inject(AI_GATEWAY) private readonly ai: AIGatewayContract) {}

  /** Resets the latch. Called once at the start of a write pass. */
  beginPass(): void {
    this.available = true;
  }

  /**
   * One embedding, or `null` when the provider is unavailable.
   *
   * FAILURE IS NEVER FATAL AND NEVER FABRICATED. A missing credential, a network
   * error or a rate limit yields `null`, the row is written with a NULL embedding,
   * and it remains lexically searchable. The alternatives are both worse: aborting
   * would make the whole feature depend on a credential that is not configured, and
   * writing a zero vector would put a point in the vector space that is a defined
   * distance from every query and would surface as a confident semantic match.
   *
   * The width is asserted rather than trusted. A provider returning 3072 floats is a
   * misconfiguration, not a smaller problem to be truncated away: a resized vector
   * is not the same point in space.
   */
  async embed(text: string): Promise<EmbeddedVector | null> {
    if (!this.available) return null;

    try {
      const result = await this.ai.embed(text, { moduleId: 'search' });
      const vector = result.output;

      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        this.logger.error(
          `Embedding provider returned ${Array.isArray(vector) ? vector.length : 'a non-array'} ` +
            `instead of ${EMBEDDING_DIMENSIONS} dimensions - refusing to store it`
        );
        this.available = false;
        return null;
      }

      return { vector, model: result.model };
    } catch (error) {
      // Logged ONCE per pass, and without the provider's message reaching any client:
      // credential state is administrative information.
      this.logger.warn(
        `Embedding unavailable - indexing continues lexical-only: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      );
      this.available = false;
      return null;
    }
  }
}
