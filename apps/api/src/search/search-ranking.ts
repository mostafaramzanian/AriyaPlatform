import {
  EXTERNAL_SEARCH_SOURCE_TYPE,
  LEXICAL_WEIGHT,
  SEARCH_MODE,
  SEMANTIC_WEIGHT,
  SOURCE_WEIGHTS,
  type PlatformSearchSourceType,
  type SearchMode,
} from './search.constants';
import type { SearchSourceType } from '../generated/core-client';
import { externalCandidateKey } from '../platform/search-source/search-source.contract';

/**
 * Phase 49J: candidate merge, dedupe and hybrid ranking.
 *
 * Pure functions over already-retrieved candidates. This module talks to no
 * database, performs no authorization and knows nothing about provider credentials —
 * which is what makes the ranking rules testable without either Postgres or an API
 * key, and is why the degraded branch can be verified exactly as thoroughly as the
 * hybrid one.
 *
 * Phase P-SEARCH-SOURCE added ONE concept: an `EXTERNAL` candidate carries a
 * `sourceKey`, its multiplier is resolved through the registered source's declared
 * weight CLASS (never through `SOURCE_WEIGHTS`, which stays exactly the eight
 * platform sources), and a candidate whose source cannot be resolved is EXCLUDED —
 * the fail-closed reading of an index row whose owning source is no longer
 * registered.
 */

/** A candidate as returned by one retrieval arm. */
export interface RetrievedCandidate {
  sourceType: SearchSourceType;
  /**
   * Which registered source contributed the row. `''` for every platform source
   * (`TICKET`, `MESSAGE`, …); a registered key (e.g. `commerce.purchase-document`)
   * for `EXTERNAL` rows — see `SearchDocument.sourceKey`.
   */
  sourceKey: string;
  sourceId: string;
  tenantId: string | null;
  /**
   * Arm-native relevance, already normalized to [0,1] by the arm:
   *  - lexical: `ts_rank_cd(...)` mapped through its own saturation function;
   *  - semantic: `1 - cosine_distance`.
   */
  score: number;
}

/** A candidate after merge: both arm scores, one row. */
export interface MergedCandidate {
  sourceType: SearchSourceType;
  sourceKey: string;
  sourceId: string;
  tenantId: string | null;
  /** Lexical score, or null when this row was found only by the semantic arm. */
  lexicalScore: number | null;
  /** Semantic score, or null when this row was found only by the lexical arm. */
  semanticScore: number | null;
  /** Final, weighted, source-adjusted score. */
  score: number;
}

/** Composite identity of a candidate. The dedupe key, and the `SearchDocument` unique key. */
export function candidateKey(sourceType: SearchSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/**
 * Combines the two arm scores into one.
 *
 * A row found by only ONE arm keeps that arm's contribution and scores ZERO for the
 * other — it is NOT rescaled to pretend both arms agreed. That asymmetry is the
 * point: a row both arms found is genuinely stronger evidence than a row only one
 * found, and normalising the missing arm away would erase that distinction.
 *
 * In `LEXICAL` mode the semantic term is not merely absent — the whole weighting
 * collapses to the lexical score, so a degraded result set is scored on the SAME
 * [0,1] scale as a hybrid one and the two are directly comparable. Without that
 * collapse every degraded score would be multiplied by `LEXICAL_WEIGHT` and the UI
 * would show uniformly weaker relevance for reasons that have nothing to do with the
 * documents.
 */
export function hybridScore(
  lexicalScore: number | null,
  semanticScore: number | null,
  mode: SearchMode
): number {
  if (mode === SEARCH_MODE.LEXICAL) {
    return lexicalScore ?? 0;
  }

  return LEXICAL_WEIGHT * (lexicalScore ?? 0) + SEMANTIC_WEIGHT * (semanticScore ?? 0);
}

/**
 * Applies the per-source multiplier for a PLATFORM source.
 *
 * `SOURCE_WEIGHTS` is exhaustive over the eight platform types, so a new platform
 * source is a compile error here rather than a silently unweighted source.
 * `EXTERNAL` is absent BY TYPE — its multiplier comes from the registered
 * source's weight class (`weightCandidate` below) — which is what keeps this
 * constant exactly the eight values every existing source was ranked by.
 */
export function applySourceWeight(score: number, sourceType: PlatformSearchSourceType): number {
  return score * SOURCE_WEIGHTS[sourceType];
}

/**
 * Resolves the multiplier of an EXTERNAL source by its registered key, or `null`
 * when no such source is registered. Supplied by the platform search source
 * registry; the ranking module never knows where registrations live.
 */
export type ExternalSourceWeightResolver = (sourceKey: string) => number | null;

/**
 * Applies the correct multiplier to one candidate.
 *
 * Platform candidates multiply by `SOURCE_WEIGHTS[type]`; EXTERNAL candidates
 * multiply by their registered CLASS factor — and a candidate whose source is not
 * registered resolves to `null`, which `mergeCandidates` treats as "exclude".
 * THAT is the fail-closed rule: an index row whose owning source is gone (or was
 * never registered in this runtime) must not surface, must not consume a page
 * slot, and must not be ranked by a guessed default.
 */
export function weightCandidate(
  score: number,
  candidate: Pick<RetrievedCandidate, 'sourceType' | 'sourceKey'>,
  externalWeights?: ExternalSourceWeightResolver
): number | null {
  if (candidate.sourceType === EXTERNAL_SEARCH_SOURCE_TYPE) {
    const multiplier = externalWeights ? externalWeights(candidate.sourceKey) : null;
    return multiplier === null ? null : score * multiplier;
  }

  return applySourceWeight(score, candidate.sourceType);
}

/**
 * Merges the two arms into one deduped, descending-score list.
 *
 * Dedupe is by the SAME key the projection is unique on — (`sourceType`,
 * `sourceId`) for a platform row, (`sourceType`, `sourceKey`, `sourceId`) for an
 * `EXTERNAL` row — so a row both arms found appears ONCE, carrying both scores.
 * Deduping by `id` would be wrong: two `SearchDocument` rows can never share a
 * source key, but the same source row can legitimately arrive from both arms.
 *
 * The tie-break is `sourceId`: deterministic but arbitrary, and it exists so two runs
 * of the same query return the same order rather than whatever order the hash
 * iteration produced. There is no recency tie-break — mixing a timestamp into a
 * relevance ordering makes neither signal legible, and every result already carries
 * its own timestamp for the client to sort by if it wants to.
 *
 * `externalWeights` resolves an `EXTERNAL` candidate's multiplier through its
 * registered source. When it is absent (or returns null) such a candidate is
 * EXCLUDED rather than defaulted: without a registered source there is no
 * authorization rule to consult either, so it could never become a result — and
 * excluding it here keeps it from consuming one of the bounded candidate slots.
 */
export function mergeCandidates(
  lexical: readonly RetrievedCandidate[],
  semantic: readonly RetrievedCandidate[],
  mode: SearchMode,
  externalWeights?: ExternalSourceWeightResolver
): MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>();

  for (const candidate of lexical) {
    merged.set(mergeKey(candidate), {
      sourceType: candidate.sourceType,
      sourceKey: candidate.sourceKey,
      sourceId: candidate.sourceId,
      tenantId: candidate.tenantId,
      lexicalScore: candidate.score,
      semanticScore: null,
      score: 0,
    });
  }

  for (const candidate of semantic) {
    const key = mergeKey(candidate);
    const existing = merged.get(key);

    if (existing) {
      // Both arms found it. Keep the recorded lexical score, and the better semantic
      // one if a row somehow appears twice in the vector arm.
      existing.semanticScore = Math.max(existing.semanticScore ?? 0, candidate.score);
      continue;
    }

    merged.set(key, {
      sourceType: candidate.sourceType,
      sourceKey: candidate.sourceKey,
      sourceId: candidate.sourceId,
      tenantId: candidate.tenantId,
      lexicalScore: null,
      semanticScore: candidate.score,
      score: 0,
    });
  }

  const scored: MergedCandidate[] = [];
  for (const candidate of merged.values()) {
    const weighted = weightCandidate(
      hybridScore(candidate.lexicalScore, candidate.semanticScore, mode),
      candidate,
      externalWeights
    );

    // An unregistered external source is dropped here, before truncation and before
    // authorization. It is logged by the registry, not silently re-weighted.
    if (weighted === null) continue;

    candidate.score = weighted;
    scored.push(candidate);
  }

  return scored.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
}

/** The dedupe key: the projection's unique key, spelled per source kind. */
function mergeKey(candidate: { sourceType: SearchSourceType; sourceKey: string; sourceId: string }): string {
  return candidate.sourceType === EXTERNAL_SEARCH_SOURCE_TYPE
    ? externalCandidateKey(candidate.sourceKey, candidate.sourceId)
    : candidateKey(candidate.sourceType, candidate.sourceId);
}

/**
 * Maps a raw `ts_rank_cd` value into [0,1].
 *
 * `ts_rank_cd` is unbounded above and its magnitude depends on document length and
 * term frequency, so it cannot be mixed with a cosine similarity directly — a long
 * document could otherwise out-score any semantic match purely by being long.
 *
 * `x / (1 + x)` is used because it is monotonic (it never reorders lexical results
 * among themselves), maps 0 to 0, approaches 1 asymptotically, and needs no
 * corpus-dependent constant — a `/ MAX_EXPECTED_RANK` divisor would be exactly the
 * kind of unjustifiable magic number this feature avoids.
 */
export function saturateLexicalRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return rank / (1 + rank);
}

/**
 * Maps a pgvector cosine DISTANCE (`<=>`, in [0,2]) to a similarity in [0,1].
 *
 * Distance 0 (identical direction) → 1. Distance 1 (orthogonal) → 0. Distance > 1
 * means the vectors point away from each other, which for text embeddings is
 * anti-similarity, and it clamps to 0 rather than going negative — a negative score
 * would SUBTRACT from the lexical evidence, which is not what "unrelated" means.
 */
export function cosineDistanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(0, 1 - distance));
}
