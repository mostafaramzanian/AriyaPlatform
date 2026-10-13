/**
 * Phase 49J: every tunable number in Global Search, in one place.
 *
 * NO NUMERIC LITERAL APPEARS IN THE QUERY OR RANKING CODE. A bare `0.6` in a
 * scoring expression is unreviewable — nobody can tell whether it is a weight, a
 * threshold or a typo — and two such literals that must sum to 1 will eventually
 * drift apart. Every value here carries the reason it has that magnitude.
 */

import type { SearchSourceType } from '../generated/core-client';

/**
 * Phase P-SEARCH-SOURCE: the marker `SearchSourceType` member for rows
 * contributed by an INDEPENDENT bounded context through the Platform Search
 * Source contract (`src/platform/search-source/`).
 *
 * ONE member, not one per module, deliberately. A per-module member would make
 * every future participant a Core schema migration AND a platform switch case
 * AND a hand-decided ranking weight; the contract instead carries the source's
 * own identity in `SearchDocument.sourceKey`. `EXTERNAL` therefore appears in
 * this file — the search capability's vocabulary — and nowhere as a business
 * concept.
 */
export const EXTERNAL_SEARCH_SOURCE_TYPE = 'EXTERNAL' as const;

/**
 * Every source type the PLATFORM itself owns and indexes (the eight 49J sources).
 *
 * `Exclude`, not a second list: the platform sources are whatever the enum
 * declares MINUS the one marker, so adding a platform source still means adding a
 * schema member, an indexer projection, an authorization rule and a weight — all
 * compile errors until done — while `EXTERNAL` rows are never processed by the
 * platform's own indexer or authorizer at all.
 */
export type PlatformSearchSourceType = Exclude<SearchSourceType, typeof EXTERNAL_SEARCH_SOURCE_TYPE>;

/**
 * Weight of the LEXICAL signal in the hybrid score.
 *
 * Higher than the semantic weight, deliberately. Lexical matching is EXACT and
 * EXPLAINABLE: a hit means the user's own words are in the document, which is what
 * someone typing a ticket number, a colleague's surname or a project name actually
 * wants. Semantic similarity is a recall aid for paraphrase, not a precision tool.
 *
 * LEXICAL_WEIGHT + SEMANTIC_WEIGHT = 1, asserted by the unit tests, so a hybrid
 * score is always comparable with a lexical-only score on the same [0,1] scale —
 * which is what lets the degraded branch fall back without rescaling anything.
 */
export const LEXICAL_WEIGHT = 0.7;

/** Weight of the SEMANTIC signal. See `LEXICAL_WEIGHT` for why it is the smaller. */
export const SEMANTIC_WEIGHT = 0.3;

/**
 * Multiplier applied to a source the caller did not explicitly ask for.
 *
 * A "global" search is dominated by whichever source happens to be largest, which
 * in this corpus is messaging. This keeps low-signal, high-volume sources
 * (notifications, reminders — B-class, lexical-only, machine-generated text) from
 * burying a matching ticket or survey. It is a RANKING nudge and never a filter:
 * an optional-source row still appears, just lower.
 */
export const OPTIONAL_SOURCE_WEIGHT = 0.6;

/** Full weight, for a primary source. Named so the ranking code has no `1` in it. */
export const PRIMARY_SOURCE_WEIGHT = 1;

/**
 * Per-source multipliers, applied after the hybrid score.
 *
 * Rationale, source by source:
 *  - TICKET / SURVEY / TICKET_COMMENT / MESSAGE — authored, intentional content.
 *    Primary weight.
 *  - CONVERSATION — a group title is a label, not content; it matches on very few
 *    tokens, so `ts_rank_cd` flatters it. Optional weight keeps a two-word group
 *    name from outranking a ticket that discusses the same subject at length.
 *  - NOTIFICATION / REMINDER — largely machine-generated, and the user has already
 *    seen them in their own inboxes. Optional weight.
 *  - USER — a directory hit is high-value when it matches (a name is unambiguous),
 *    so it keeps primary weight.
 */
export const SOURCE_WEIGHTS = {
  TICKET: PRIMARY_SOURCE_WEIGHT,
  TICKET_COMMENT: PRIMARY_SOURCE_WEIGHT,
  SURVEY: PRIMARY_SOURCE_WEIGHT,
  MESSAGE: PRIMARY_SOURCE_WEIGHT,
  CONVERSATION: OPTIONAL_SOURCE_WEIGHT,
  NOTIFICATION: OPTIONAL_SOURCE_WEIGHT,
  REMINDER: OPTIONAL_SOURCE_WEIGHT,
  USER: PRIMARY_SOURCE_WEIGHT,
} as const;

/**
 * Phase P-SEARCH-SOURCE: the two ranking classes an EXTERNAL source may declare.
 *
 * WHY A CLASS AND NOT A NUMBER: a new source's ranking priority is a platform
 * decision with a written rationale per source (see above), and a contributing
 * module may not choose a multiplier — that would let it promote itself above
 * platform content by editing its own descriptor. The platform therefore exposes
 * exactly the classes it already implements, each mapped to the multiplier it
 * already uses:
 *
 *   PRIMARY    → `PRIMARY_SOURCE_WEIGHT`    (authored, intentional content)
 *   SUPPORTING → `OPTIONAL_SOURCE_WEIGHT`   (a nudge down, never a filter)
 *
 * NO NEW NUMERIC VALUE IS INTRODUCED BY THIS MECHANISM, and adding a third class
 * would require a platform decision — not a module declaration. Which class a
 * GIVEN future source declares is that source's own phase decision, recorded in
 * its registration; the contract cannot pre-empt it and does not guess it.
 */
export const SEARCH_WEIGHT_CLASSES = ['PRIMARY', 'SUPPORTING'] as const;

export type SearchWeightClass = (typeof SEARCH_WEIGHT_CLASSES)[number];

/**
 * Class → multiplier. The values are the EXISTING constants above, referenced —
 * not re-typed — so the two cannot drift and no new magnitude enters the system.
 */
export const SEARCH_WEIGHT_CLASS_FACTORS = {
  PRIMARY: PRIMARY_SOURCE_WEIGHT,
  SUPPORTING: OPTIONAL_SOURCE_WEIGHT,
} as const;

/**
 * How many candidates each retrieval arm may return from Postgres.
 *
 * OVER-FETCH IS MANDATORY, not an optimization: authorization runs AFTER retrieval
 * (the index is not an authorization boundary), so an arbitrary fraction of
 * candidates will be discarded. Fetching only `limit` rows would return a
 * half-empty page whenever the caller cannot see the top hits.
 *
 * Bounded, and that matters more than the exact value: without a bound, a common
 * token would drag the entire table through the authorization loop.
 */
export const LEXICAL_CANDIDATE_LIMIT = 120;

/** Same bound for the vector arm. HNSW cost grows with the requested neighbour count. */
export const SEMANTIC_CANDIDATE_LIMIT = 60;

/**
 * Hard cap on candidates entering the authorization stage, after merge and dedupe.
 *
 * The authorization stage issues a bounded number of grouped queries (one per source
 * type, never one per row — see SearchService), but every candidate still costs
 * work, so the merged set is truncated by score before that stage runs.
 */
export const MAX_MERGED_CANDIDATES = 150;

/** Default page size when the caller does not ask for one. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Maximum page size. CAPPED, NOT REJECTED, matching `DirectoryService` and
 * `SupportService`: an oversized request is bounded rather than turned into a 400.
 */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Maximum accepted query length, mirroring `DirectoryQueryDto.q`.
 *
 * Also the embedding cost bound: the query is sent to the embedding provider, so an
 * unbounded string would be an unbounded API call.
 */
export const MAX_QUERY_LENGTH = 120;

/**
 * Minimum normalized query length. One character matches nearly every document and
 * produces a ranking that is pure noise, so it is refused before any query runs.
 */
export const MIN_QUERY_LENGTH = 2;

/** Characters of context in a snippet. Long enough to read, short enough not to be an export. */
export const SNIPPET_LENGTH = 160;

/** Characters kept before the first matched token, so a match is never flush against the edge. */
export const SNIPPET_LEAD = 40;

/** Ellipsis marker for a truncated snippet. */
export const SNIPPET_ELLIPSIS = '…';

/**
 * Embedding width. Must match the provider contract (`text-embedding-3-small`) AND
 * the `vector(1536)` column; a mismatch is refused rather than truncated or padded,
 * because a resized vector is not the same point in space.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * How many rows one indexer batch projects.
 *
 * Bounded so a full rebuild streams instead of loading a table into memory, and so
 * one batch is a reasonable transaction.
 */
export const INDEX_BATCH_SIZE = 200;

/**
 * The retrieval mode reported to the client.
 *
 * `HYBRID` — lexical + semantic, both arms ran.
 * `LEXICAL` — semantic retrieval was unavailable and results are lexical only.
 *
 * The client is told WHICH mode produced the results and never WHY: the reason
 * involves provider identity and credential state, which no search caller is
 * entitled to. `degraded` is the flag the UI actually branches on.
 */
export const SEARCH_MODE = {
  HYBRID: 'HYBRID',
  LEXICAL: 'LEXICAL',
} as const;

export type SearchMode = (typeof SEARCH_MODE)[keyof typeof SEARCH_MODE];
