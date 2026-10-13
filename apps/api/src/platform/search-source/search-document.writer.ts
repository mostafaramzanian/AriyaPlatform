import { Injectable } from '@nestjs/common';
import { Prisma, type SearchSourceType } from '../../generated/core-client';
import { PrismaService } from '../../database/prisma.service';
import { EMBEDDING_DIMENSIONS } from '../../search/search.constants';
import { SearchEmbeddingService, type EmbeddedVector } from './search-embedding.service';

/**
 * Phase P-SEARCH-SOURCE: THE write path into `SearchDocument`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The upsert statement moved out of `SearchIndexerService`, because the platform
 * search source contract added a SECOND writer of the same table — the ingestion
 * boundary that stores external projections. Two copies of this statement would
 * be two places to keep the conflict target, the embedding COALESCE and the
 * generated-column rule correct; one writer is the only arrangement in which
 * "the platform owns the persistence details" is a fact rather than a convention.
 * The platform's own indexer and the external ingestion service both come here.
 *
 * WHAT THE STATEMENT ENFORCES (unchanged from 49J, one column richer)
 * ------------------------------------------------------------------
 *  - ONE ROW PER (`sourceType`, `sourceKey`, `sourceId`) — the unique key the
 *    upsert targets, so a re-index or a re-projection never opens a window in
 *    which the document is unfindable;
 *  - `searchVector` is GENERATED ALWAYS (no write path may supply it) and
 *    `embedding` is `Unsupported("vector(1536)")`, which is why this is raw SQL
 *    and not `prisma.searchDocument.upsert()`;
 *  - the three embedding columns move TOGETHER, always; a NULL embedding
 *    PRESERVES an existing vector (`COALESCE`) rather than clearing it, because a
 *    pass that ran without a credential must not destroy a vector computed
 *    correctly earlier — staleness is visible through `embeddedAt` and fixable by
 *    a backfill, deletion would be silent and unrecoverable;
 *  - a row whose normalized text is EMPTY is SKIPPED, not written: the
 *    `searchText_nonblank` CHECK would reject it and it could never match
 *    anything. Skipping is reported by the caller, never silent.
 */
@Injectable()
export class SearchDocumentWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: SearchEmbeddingService
  ) {}

  /**
   * Resets the embedding latch for a new write pass. The indexer calls it once per
   * rebuild; the external ingestion calls it once per `project(...)` batch.
   */
  beginPass(): void {
    this.embeddings.beginPass();
  }

  /**
   * Writes one batch: skips blank rows, embeds the rest, upserts each.
   *
   * SEQUENTIAL on purpose — a batch is a bounded, background-sized unit
   * (`INDEX_BATCH_SIZE`), and the embedding provider is the shared rate-limited
   * resource the latch exists to protect.
   */
  async write(documents: readonly IndexableSearchDocument[]): Promise<SearchWriteResult> {
    let written = 0;
    let embedded = 0;

    for (const document of documents) {
      if (document.searchText.length === 0) continue;

      const embedding = await this.embeddings.embed(document.searchText);
      await this.upsert(document, embedding);

      written += 1;
      if (embedding) embedded += 1;
    }

    return { written, embedded };
  }

  /**
   * Removes the projection rows of specific source rows.
   *
   * Idempotent, and never an error when a row is absent — a cache entry that is
   * already gone is the desired state. Not strictly required for correctness (the
   * authorizer drops candidates whose authoritative row has vanished), but it
   * keeps the index from growing without bound.
   */
  async remove(
    sourceType: SearchSourceType,
    sourceKey: string,
    sourceIds: readonly string[]
  ): Promise<number> {
    if (sourceIds.length === 0) return 0;

    const { count } = await this.prisma.searchDocument.deleteMany({
      where: { sourceType, sourceKey, sourceId: { in: [...sourceIds] } },
    });

    return count;
  }

  /**
   * Upserts one projection row.
   *
   * RAW SQL IS FORCED, once: `searchVector` is generated and `embedding` is
   * `Unsupported`, so no Prisma delegate can express this statement.
   *
   * `sourceKey` is written EXPLICITLY by every caller — `''` for the platform's own
   * sources, the registered key for external rows — so the column is never left to
   * its default and a mis-wired caller cannot silently stamp a platform row as
   * external or vice versa.
   */
  private async upsert(
    document: IndexableSearchDocument,
    embedding: EmbeddedVector | null
  ): Promise<void> {
    if (embedding !== null && embedding.vector.length !== EMBEDDING_DIMENSIONS) {
      // Defence in depth: the embedding service already refuses a wrong-width
      // vector. A wrong width must never reach Postgres, where it would surface as
      // an opaque type error rather than a clear application-level refusal.
      throw new Error(
        `Embedding width ${embedding.vector.length} does not match the ${EMBEDDING_DIMENSIONS}-dimension column`
      );
    }

    const literal = embedding ? `[${embedding.vector.join(',')}]` : null;
    // The EFFECTIVE model the gateway reported for THIS vector (§13) — the DB
    // row's `modelName` when a configured row applied, the env-bootstrap model
    // otherwise. Previously a module-level env constant, which stamped the tag of
    // the bootstrap model onto vectors a different configured model had produced.
    const model = embedding ? embedding.model : null;

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "SearchDocument" (
        "id", "sourceType", "sourceKey", "sourceId", "tenantId", "searchText",
        "embedding", "embeddingModel", "embeddedAt", "sourceUpdatedAt",
        "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        ${document.sourceType}::"SearchSourceType",
        ${document.sourceKey},
        ${document.sourceId},
        ${document.tenantId},
        ${document.searchText},
        ${literal}::vector,
        ${model},
        CASE WHEN ${literal}::vector IS NULL THEN NULL ELSE now() END,
        ${document.sourceUpdatedAt},
        now(),
        now()
      )
      ON CONFLICT ("sourceType", "sourceKey", "sourceId") DO UPDATE SET
        "tenantId"        = EXCLUDED."tenantId",
        "searchText"      = EXCLUDED."searchText",
        "embedding"       = COALESCE(EXCLUDED."embedding", "SearchDocument"."embedding"),
        "embeddingModel"  = CASE
                              WHEN EXCLUDED."embedding" IS NOT NULL THEN EXCLUDED."embeddingModel"
                              ELSE "SearchDocument"."embeddingModel"
                            END,
        "embeddedAt"      = CASE
                              WHEN EXCLUDED."embedding" IS NOT NULL THEN EXCLUDED."embeddedAt"
                              ELSE "SearchDocument"."embeddedAt"
                            END,
        "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
        "updatedAt"       = now()
    `);
  }
}

/**
 * One row ready to be written. Deliberately carries no owner/member field — the
 * index is not an authorization boundary.
 */
export interface IndexableSearchDocument {
  sourceType: SearchSourceType;
  /**
   * `''` for a platform source (identity is `sourceType` alone); the registered
   * source key for an `EXTERNAL` row.
   */
  sourceKey: string;
  /** The authoritative row's id — the entity id, for an external row. */
  sourceId: string;
  tenantId: string | null;
  /** ALREADY normalized by `buildSearchText`; never re-normalized here. */
  searchText: string;
  sourceUpdatedAt: Date;
}

/** What one `write(...)` did. `embedded` counts rows that got a vector. */
export interface SearchWriteResult {
  written: number;
  embedded: number;
}

/**
 * The model tag stored alongside a vector now comes from the AI gateway's
 * structured result (the EFFECTIVE model of that execution, §13) instead of a
 * module-level `process.env` constant evaluated at boot — see
 * `SearchEmbeddingService.EmbeddedVector.model` and the `embeddingModel` column
 * comments in the schema. A tag that no longer matches reality is what makes a
 * re-index concern visible rather than silent.
 */

