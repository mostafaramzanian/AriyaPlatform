import { Injectable } from '@nestjs/common';
import { Prisma, type SearchSourceType } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import {
  cosineDistanceToSimilarity,
  saturateLexicalRank,
  type RetrievedCandidate,
} from './search-ranking';
import {
  EMBEDDING_DIMENSIONS,
  LEXICAL_CANDIDATE_LIMIT,
  SEMANTIC_CANDIDATE_LIMIT,
} from './search.constants';

/**
 * Phase 49J: the raw-SQL retrieval arms.
 *
 * RAW SQL IS UNAVOIDABLE HERE, not a shortcut. Prisma has no representation for
 * `tsvector`, `plainto_tsquery`, `ts_rank_cd`, `@@` or pgvector's `<=>`, and the
 * columns are declared `Unsupported(...)` for exactly that reason. Every value is
 * still parameterised through `Prisma.sql` — no user input is ever concatenated into
 * a statement, and neither arm interpolates an identifier.
 *
 * NEITHER ARM IS AN AUTHORIZATION BOUNDARY. Both return candidates only; the caller
 * re-reads each one from its authoritative table and applies that source's rule. The
 * only predicate applied here that has security weight is the tenant filter, and it
 * is applied redundantly rather than relied upon.
 */

/** Row shape returned by the lexical statement. */
interface LexicalRow {
  sourceType: SearchSourceType;
  sourceKey: string;
  sourceId: string;
  tenantId: string | null;
  rank: number;
}

/** Row shape returned by the semantic statement. */
interface SemanticRow {
  sourceType: SearchSourceType;
  sourceKey: string;
  sourceId: string;
  tenantId: string | null;
  distance: number;
}

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * EXACT-EQUALITY tenant predicate.
   *
   * `IS NULL` for a null-tenant caller and `= $tenant` otherwise. NEVER
   * `("tenantId" IS NULL OR "tenantId" = $tenant)`: that reads like leniency and is
   * in fact a cross-tenant leak, because it would show every tenant-less row —
   * including rows belonging to users who simply have no tenant assigned — to a
   * caller inside a tenant.
   */
  private tenantPredicate(tenantId: string | null): Prisma.Sql {
    return tenantId === null
      ? Prisma.sql`d."tenantId" IS NULL`
      : Prisma.sql`d."tenantId" = ${tenantId}`;
  }

  /** Optional single-source narrowing. Cannot widen anything. */
  private sourcePredicate(sourceType?: SearchSourceType): Prisma.Sql {
    return sourceType
      ? Prisma.sql`AND d."sourceType" = ${sourceType}::"SearchSourceType"`
      : Prisma.empty;
  }

  /**
   * LEXICAL arm: GIN-indexed full-text match, ranked by `ts_rank_cd`.
   *
   * `plainto_tsquery`, not `to_tsquery` or `websearch_to_tsquery`:
   *  - `to_tsquery` requires the caller to supply valid operator syntax and RAISES on
   *    malformed input, so a user typing `a & ` would produce a 500;
   *  - `websearch_to_tsquery` invents a mini-language (quotes, `or`, `-`) that this UI
   *    does not document and that behaves oddly on Persian text;
   *  - `plainto_tsquery` ANDs the terms and cannot fail on any input, which is the
   *    right contract for a single search box.
   *
   * The query text is the ALREADY-NORMALIZED string, and `'simple'` matches the
   * configuration the stored generated column used. Both halves of that sentence are
   * load-bearing: a different configuration, or un-normalized input, silently stops
   * matching.
   *
   * `ts_rank_cd` rather than `ts_rank`: cover density rewards documents where the
   * query terms appear CLOSE TOGETHER, which is what relevance means for a phrase
   * typed into one box.
   */
  async lexicalCandidates(
    normalizedQuery: string,
    tenantId: string | null,
    sourceType?: SearchSourceType
  ): Promise<RetrievedCandidate[]> {
    const rows = await this.prisma.$queryRaw<LexicalRow[]>(Prisma.sql`
      SELECT d."sourceType" AS "sourceType",
             d."sourceKey"  AS "sourceKey",
             d."sourceId"   AS "sourceId",
             d."tenantId"   AS "tenantId",
             ts_rank_cd(d."searchVector", q.query) AS rank
      FROM "SearchDocument" d,
           plainto_tsquery('simple', ${normalizedQuery}) AS q(query)
      WHERE d."searchVector" @@ q.query
        AND ${this.tenantPredicate(tenantId)}
        ${this.sourcePredicate(sourceType)}
      ORDER BY rank DESC, d."sourceId" ASC
      LIMIT ${LEXICAL_CANDIDATE_LIMIT}
    `);

    return rows.map((row) => ({
      sourceType: row.sourceType,
      sourceKey: row.sourceKey,
      sourceId: row.sourceId,
      tenantId: row.tenantId,
      score: saturateLexicalRank(Number(row.rank)),
    }));
  }

  /**
   * SEMANTIC arm: HNSW nearest neighbours by cosine distance.
   *
   * `<=>` is pgvector's cosine-distance operator and it MUST match the operator class
   * the index was built with (`vector_cosine_ops`); `<->` here would silently fall
   * back to a sequential scan.
   *
   * `WHERE "embedding" IS NOT NULL` is not merely an optimization — with no embedding
   * credential configured every row has a NULL embedding, and a NULL would otherwise
   * sort as an unknown distance rather than being excluded.
   *
   * The vector is passed as a PARAMETER and cast, never interpolated into the
   * statement text: 1536 numbers concatenated into SQL would be both an injection
   * surface and a plan-cache catastrophe. The width is asserted before the call.
   */
  async semanticCandidates(
    embedding: readonly number[],
    tenantId: string | null,
    sourceType?: SearchSourceType
  ): Promise<RetrievedCandidate[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      // Defence in depth: SearchService checks this too. A wrong-width vector must
      // never reach Postgres, where it would surface as an opaque type error rather
      // than a clear application-level refusal.
      throw new Error(
        `Embedding width ${embedding.length} does not match the ${EMBEDDING_DIMENSIONS}-dimension column`
      );
    }

    const literal = `[${embedding.join(',')}]`;

    const rows = await this.prisma.$queryRaw<SemanticRow[]>(Prisma.sql`
      SELECT d."sourceType" AS "sourceType",
             d."sourceKey"  AS "sourceKey",
             d."sourceId"   AS "sourceId",
             d."tenantId"   AS "tenantId",
             (d."embedding" <=> ${literal}::vector) AS distance
      FROM "SearchDocument" d
      WHERE d."embedding" IS NOT NULL
        AND ${this.tenantPredicate(tenantId)}
        ${this.sourcePredicate(sourceType)}
      ORDER BY d."embedding" <=> ${literal}::vector
      LIMIT ${SEMANTIC_CANDIDATE_LIMIT}
    `);

    return rows.map((row) => ({
      sourceType: row.sourceType,
      sourceKey: row.sourceKey,
      sourceId: row.sourceId,
      tenantId: row.tenantId,
      score: cosineDistanceToSimilarity(Number(row.distance)),
    }));
  }
}
