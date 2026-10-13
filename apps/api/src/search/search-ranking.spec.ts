import {
  applySourceWeight,
  candidateKey,
  cosineDistanceToSimilarity,
  hybridScore,
  mergeCandidates,
  saturateLexicalRank,
  weightCandidate,
  type RetrievedCandidate,
} from './search-ranking';
import { externalCandidateKey } from '../platform/search-source/search-source.contract';
import {
  LEXICAL_WEIGHT,
  OPTIONAL_SOURCE_WEIGHT,
  PRIMARY_SOURCE_WEIGHT,
  SEARCH_MODE,
  SEMANTIC_WEIGHT,
  SOURCE_WEIGHTS,
} from './search.constants';
import type { SearchSourceType } from '../generated/core-client';

/**
 * Phase 49J: ranking-invariant tests.
 *
 * These assert PROPERTIES, not output snapshots. The distinction matters: a snapshot
 * of `0.7 * 0.5 + 0.3 * 0.2` would pass while the weights drifted to `0.8 / 0.3`, and
 * the thing that must not break is not any particular number but the guarantee that a
 * hybrid score and a degraded score are on the same [0,1] scale.
 *
 * No Postgres, no provider, no key: the ranking rules are pure functions over
 * already-retrieved candidates, which is precisely why the degraded branch is as
 * testable as the hybrid one.
 */

const candidate = (
  sourceType: SearchSourceType,
  sourceId: string,
  score: number,
  tenantId: string | null = 't1'
): RetrievedCandidate => ({ sourceType, sourceKey: '', sourceId, tenantId, score });

/**
 * An `EXTERNAL` candidate (Phase P-SEARCH-SOURCE): the same shape, with the
 * registered source key the ranking rules dispatch on.
 */
const externalCandidate = (
  sourceKey: string,
  sourceId: string,
  score: number,
  tenantId: string | null = 't1'
): RetrievedCandidate => ({
  sourceType: 'EXTERNAL',
  sourceKey,
  sourceId,
  tenantId,
  score,
});

describe('search-ranking', () => {
  describe('the weight contract', () => {
    it('sums the two arm weights to exactly 1', () => {
      // The single most important invariant in this file. If it breaks, a hybrid
      // score stops being comparable with a lexical-only score and the degraded UI
      // shows uniformly weaker relevance for reasons unrelated to the documents.
      expect(LEXICAL_WEIGHT + SEMANTIC_WEIGHT).toBe(1);
    });

    it('weights lexical above semantic', () => {
      // Lexical matching is exact and explainable; semantic is a recall aid.
      expect(LEXICAL_WEIGHT).toBeGreaterThan(SEMANTIC_WEIGHT);
    });

    it('declares a weight for every source type', () => {
      const declared = Object.keys(SOURCE_WEIGHTS).sort();
      expect(declared).toEqual(
        [
          'CONVERSATION',
          'MESSAGE',
          'NOTIFICATION',
          'REMINDER',
          'SURVEY',
          'TICKET',
          'TICKET_COMMENT',
          'USER',
        ].sort()
      );
    });

    it('keeps every source weight inside (0,1]', () => {
      // A zero weight would be a silent filter; a weight above 1 would push a source
      // out of the [0,1] score range the API documents.
      for (const weight of Object.values(SOURCE_WEIGHTS)) {
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(PRIMARY_SOURCE_WEIGHT);
      }
    });
  });

  describe('hybridScore', () => {
    it('combines both arms by their weights', () => {
      expect(hybridScore(1, 1, SEARCH_MODE.HYBRID)).toBeCloseTo(1, 10);
      expect(hybridScore(0.5, 0.2, SEARCH_MODE.HYBRID)).toBeCloseTo(
        LEXICAL_WEIGHT * 0.5 + SEMANTIC_WEIGHT * 0.2,
        10
      );
    });

    it('scores a single-arm hit as zero for the missing arm, without rescaling', () => {
      // Deliberate asymmetry: a row both arms found is stronger evidence, and
      // normalising the missing arm away would erase that.
      expect(hybridScore(1, null, SEARCH_MODE.HYBRID)).toBeCloseTo(LEXICAL_WEIGHT, 10);
      expect(hybridScore(null, 1, SEARCH_MODE.HYBRID)).toBeCloseTo(SEMANTIC_WEIGHT, 10);
    });

    it('collapses to the raw lexical score in degraded mode', () => {
      // THE degraded-mode equivalence: the same lexical evidence must produce the
      // same [0,1] score whether or not the semantic arm was available, so the two
      // result sets are directly comparable.
      for (const lexical of [0, 0.25, 0.5, 0.75, 1]) {
        expect(hybridScore(lexical, null, SEARCH_MODE.LEXICAL)).toBe(lexical);
      }
    });

    it('ignores a semantic score that arrives in degraded mode', () => {
      // Defensive: if a stale semantic candidate ever reached a degraded merge it
      // must not contribute, or `degraded: true` would be a lie.
      expect(hybridScore(0.4, 0.9, SEARCH_MODE.LEXICAL)).toBe(0.4);
    });

    it('treats a wholly unscored row as zero rather than NaN', () => {
      expect(hybridScore(null, null, SEARCH_MODE.HYBRID)).toBe(0);
      expect(hybridScore(null, null, SEARCH_MODE.LEXICAL)).toBe(0);
    });
  });

  describe('applySourceWeight', () => {
    it('leaves a primary source untouched', () => {
      expect(applySourceWeight(0.8, 'TICKET')).toBeCloseTo(0.8, 10);
    });

    it('demotes an optional source without excluding it', () => {
      const weighted = applySourceWeight(0.8, 'NOTIFICATION');
      expect(weighted).toBeCloseTo(0.8 * OPTIONAL_SOURCE_WEIGHT, 10);
      // NEVER zero: the source weight is a ranking nudge, not a filter.
      expect(weighted).toBeGreaterThan(0);
    });
  });

  describe('saturateLexicalRank', () => {
    it('maps into [0,1)', () => {
      for (const rank of [0.001, 0.1, 1, 10, 1000, 1e9]) {
        const score = saturateLexicalRank(rank);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
      }
    });

    it('is strictly monotonic, so it never reorders lexical results', () => {
      // The whole justification for x/(1+x) over a corpus-dependent divisor.
      const ranks = [0.01, 0.05, 0.2, 0.9, 3, 17, 400];
      const scores = ranks.map(saturateLexicalRank);

      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]).toBeGreaterThan(scores[i - 1]);
      }
    });

    it('maps zero and negatives to zero, and survives non-finite input', () => {
      expect(saturateLexicalRank(0)).toBe(0);
      expect(saturateLexicalRank(-1)).toBe(0);
      expect(saturateLexicalRank(Number.NaN)).toBe(0);
      expect(saturateLexicalRank(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe('cosineDistanceToSimilarity', () => {
    it('maps identical direction to 1 and orthogonal to 0', () => {
      expect(cosineDistanceToSimilarity(0)).toBe(1);
      expect(cosineDistanceToSimilarity(1)).toBe(0);
    });

    it('clamps anti-similarity to zero instead of going negative', () => {
      // A negative score would SUBTRACT from lexical evidence, which is not what
      // "unrelated" means.
      expect(cosineDistanceToSimilarity(1.5)).toBe(0);
      expect(cosineDistanceToSimilarity(2)).toBe(0);
    });

    it('is monotonically decreasing in distance', () => {
      const distances = [0, 0.2, 0.5, 0.8, 1];
      const scores = distances.map(cosineDistanceToSimilarity);

      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
    });

    it('survives non-finite input', () => {
      expect(cosineDistanceToSimilarity(Number.NaN)).toBe(0);
    });
  });

  describe('candidateKey', () => {
    it('is the composite source identity, matching the projection unique key', () => {
      expect(candidateKey('TICKET', 'abc')).toBe('TICKET:abc');
    });

    it('distinguishes the same id under different source types', () => {
      // A ticket and a comment could in principle share an id string; the key must
      // not collapse them into one result.
      expect(candidateKey('TICKET', 'x')).not.toBe(candidateKey('TICKET_COMMENT', 'x'));
    });
  });

  describe('mergeCandidates', () => {
    it('dedupes by sourceType+sourceId and keeps both arm scores on one row', () => {
      const merged = mergeCandidates(
        [candidate('TICKET', 'a', 0.5)],
        [candidate('TICKET', 'a', 0.9)],
        SEARCH_MODE.HYBRID
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].lexicalScore).toBe(0.5);
      expect(merged[0].semanticScore).toBe(0.9);
      expect(merged[0].score).toBeCloseTo(LEXICAL_WEIGHT * 0.5 + SEMANTIC_WEIGHT * 0.9, 10);
    });

    it('does not merge the same id across different source types', () => {
      const merged = mergeCandidates(
        [candidate('TICKET', 'shared', 0.5)],
        [candidate('TICKET_COMMENT', 'shared', 0.5)],
        SEARCH_MODE.HYBRID
      );

      expect(merged).toHaveLength(2);
    });

    it('keeps single-arm rows, marking the arm that missed as null', () => {
      const merged = mergeCandidates(
        [candidate('TICKET', 'lex', 0.6)],
        [candidate('SURVEY', 'sem', 0.6)],
        SEARCH_MODE.HYBRID
      );

      const lex = merged.find((row) => row.sourceId === 'lex');
      const sem = merged.find((row) => row.sourceId === 'sem');

      expect(lex?.semanticScore).toBeNull();
      expect(sem?.lexicalScore).toBeNull();
    });

    it('ranks a both-arm hit above equally-scored single-arm hits', () => {
      const merged = mergeCandidates(
        [candidate('TICKET', 'both', 0.6), candidate('TICKET', 'lexonly', 0.6)],
        [candidate('TICKET', 'both', 0.6), candidate('TICKET', 'semonly', 0.6)],
        SEARCH_MODE.HYBRID
      );

      expect(merged[0].sourceId).toBe('both');
    });

    it('keeps the stronger semantic score when a row appears twice in the vector arm', () => {
      const merged = mergeCandidates(
        [],
        [candidate('TICKET', 'a', 0.3), candidate('TICKET', 'a', 0.8)],
        SEARCH_MODE.HYBRID
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].semanticScore).toBe(0.8);
    });

    it('sorts by descending score', () => {
      const merged = mergeCandidates(
        [
          candidate('TICKET', 'low', 0.1),
          candidate('TICKET', 'high', 0.9),
          candidate('TICKET', 'mid', 0.5),
        ],
        [],
        SEARCH_MODE.LEXICAL
      );

      expect(merged.map((row) => row.sourceId)).toEqual(['high', 'mid', 'low']);
    });

    it('breaks ties deterministically by sourceId, so two identical runs agree', () => {
      const inputs = [
        candidate('TICKET', 'b', 0.5),
        candidate('TICKET', 'a', 0.5),
        candidate('TICKET', 'c', 0.5),
      ];

      const first = mergeCandidates(inputs, [], SEARCH_MODE.LEXICAL).map((r) => r.sourceId);
      const second = mergeCandidates([...inputs].reverse(), [], SEARCH_MODE.LEXICAL).map(
        (r) => r.sourceId
      );

      expect(first).toEqual(['a', 'b', 'c']);
      expect(second).toEqual(first);
    });

    it('applies the source weight, letting a primary source outrank a stronger optional one', () => {
      const merged = mergeCandidates(
        [candidate('NOTIFICATION', 'notif', 0.9), candidate('TICKET', 'ticket', 0.8)],
        [],
        SEARCH_MODE.LEXICAL
      );

      // 0.9 * 0.6 = 0.54 < 0.8 * 1 — the reason OPTIONAL_SOURCE_WEIGHT exists.
      expect(merged[0].sourceId).toBe('ticket');
    });

    it('produces identical ordering in degraded mode as with the lexical arm alone', () => {
      const lexical = [
        candidate('TICKET', 'a', 0.9),
        candidate('TICKET', 'b', 0.4),
        candidate('SURVEY', 'c', 0.6),
      ];

      const hybridWithNoVectors = mergeCandidates(lexical, [], SEARCH_MODE.HYBRID);
      const degraded = mergeCandidates(lexical, [], SEARCH_MODE.LEXICAL);

      // Same ORDER either way; degraded additionally reports the UNSCALED score, which
      // is what makes a degraded score comparable with a hybrid one.
      expect(degraded.map((r) => r.sourceId)).toEqual(hybridWithNoVectors.map((r) => r.sourceId));
      expect(degraded[0].score).toBeCloseTo(0.9, 10);
      expect(hybridWithNoVectors[0].score).toBeCloseTo(0.9 * LEXICAL_WEIGHT, 10);
    });

    it('ignores semantic candidates entirely in degraded mode', () => {
      const merged = mergeCandidates(
        [candidate('TICKET', 'a', 0.5)],
        [candidate('TICKET', 'a', 1)],
        SEARCH_MODE.LEXICAL
      );

      expect(merged[0].score).toBe(0.5);
    });

    it('preserves the tenant snapshot of each candidate', () => {
      // The service never trusts this for authorization, but it must not be lost or
      // silently coerced from null to a string.
      const merged = mergeCandidates(
        [candidate('TICKET', 'a', 0.5, null), candidate('TICKET', 'b', 0.4, 't9')],
        [],
        SEARCH_MODE.LEXICAL
      );

      expect(merged.find((r) => r.sourceId === 'a')?.tenantId).toBeNull();
      expect(merged.find((r) => r.sourceId === 'b')?.tenantId).toBe('t9');
    });

    it('returns an empty list when neither arm found anything', () => {
      expect(mergeCandidates([], [], SEARCH_MODE.HYBRID)).toEqual([]);
    });
  });

  describe('EXTERNAL source candidates (Phase P-SEARCH-SOURCE)', () => {
    /**
     * A stand-in for `SearchSourceService.weightMultiplier`: registered keys map to
     * their class factor, an unregistered key is `null` — the real registry's rule.
     */
    const weights = (key: string): number | null => {
      if (key === 'test.primary') return 1;
      if (key === 'test.supporting') return OPTIONAL_SOURCE_WEIGHT;
      return null;
    };

    it('resolves the multiplier from the registered weight class, never SOURCE_WEIGHTS', () => {
      expect(weightCandidate(0.8, externalCandidate('test.primary', 'a', 1), weights)).toBeCloseTo(
        0.8 * 1,
        10
      );
      expect(
        weightCandidate(0.8, externalCandidate('test.supporting', 'a', 1), weights)
      ).toBeCloseTo(0.8 * OPTIONAL_SOURCE_WEIGHT, 10);
    });

    it('resolves to null (exclude) when the source is unregistered or no resolver exists', () => {
      expect(weightCandidate(0.8, externalCandidate('test.gone', 'a', 1), weights)).toBeNull();
      expect(weightCandidate(0.8, externalCandidate('test.primary', 'a', 1))).toBeNull();
    });

    it('leaves platform candidates exactly as they were', () => {
      expect(weightCandidate(0.8, candidate('NOTIFICATION', 'n', 0.8), weights)).toBeCloseTo(
        0.8 * OPTIONAL_SOURCE_WEIGHT,
        10
      );
      expect(weightCandidate(0.8, candidate('TICKET', 't', 0.8), weights)).toBeCloseTo(0.8, 10);
      // Platform sources work even with NO resolver — existing behaviour is untouched.
      expect(weightCandidate(0.8, candidate('TICKET', 't', 0.8))).toBeCloseTo(0.8, 10);
    });

    it('keeps an unregistered external source OUT of the merged list — fail-closed', () => {
      const merged = mergeCandidates(
        [externalCandidate('test.gone', 'x', 0.9), candidate('TICKET', 't', 0.5)],
        [],
        SEARCH_MODE.LEXICAL,
        weights
      );

      expect(merged.map((row) => row.sourceId)).toEqual(['t']);
    });

    it('keeps registered external candidates and weights their order', () => {
      const merged = mergeCandidates(
        [
          externalCandidate('test.supporting', 'lower', 0.9),
          externalCandidate('test.primary', 'higher', 0.9),
        ],
        [],
        SEARCH_MODE.LEXICAL,
        weights
      );

      expect(merged.map((row) => row.sourceId)).toEqual(['higher', 'lower']);
      expect(merged[0].score).toBeCloseTo(0.9, 10);
      expect(merged[1].score).toBeCloseTo(0.9 * OPTIONAL_SOURCE_WEIGHT, 10);
    });

    it('dedupes one external row across BOTH arms under its source-keyed identity', () => {
      const merged = mergeCandidates(
        [externalCandidate('test.primary', 'same', 0.4)],
        [externalCandidate('test.primary', 'same', 0.7)],
        SEARCH_MODE.HYBRID,
        weights
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].lexicalScore).toBe(0.4);
      expect(merged[0].semanticScore).toBe(0.7);
    });

    it('never collapses two sources that project the SAME entity id', () => {
      const merged = mergeCandidates(
        [
          externalCandidate('test.primary', 'shared', 0.5),
          externalCandidate('test.supporting', 'shared', 0.5),
        ],
        [],
        SEARCH_MODE.LEXICAL,
        weights
      );

      expect(merged).toHaveLength(2);
      expect(new Set(merged.map((row) => row.sourceKey))).toEqual(
        new Set(['test.primary', 'test.supporting'])
      );
      expect(externalCandidateKey('test.primary', 'shared')).not.toBe(
        externalCandidateKey('test.supporting', 'shared')
      );
    });

    it('is deterministic for external rows: identical inputs, identical order', () => {
      const inputs = [
        externalCandidate('test.primary', 'b', 0.5),
        externalCandidate('test.primary', 'a', 0.5),
        externalCandidate('test.primary', 'c', 0.5),
      ];

      const first = mergeCandidates(inputs, [], SEARCH_MODE.LEXICAL, weights).map(
        (row) => row.sourceId
      );
      const second = mergeCandidates([...inputs].reverse(), [], SEARCH_MODE.LEXICAL, weights).map(
        (row) => row.sourceId
      );

      expect(first).toEqual(['a', 'b', 'c']);
      expect(second).toEqual(first);
    });

    it('preserves the tenant snapshot of an external candidate', () => {
      const merged = mergeCandidates(
        [externalCandidate('test.primary', 'a', 0.5, null)],
        [],
        SEARCH_MODE.LEXICAL,
        weights
      );

      expect(merged[0].tenantId).toBeNull();
    });
  });
});
