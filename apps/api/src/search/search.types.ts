import type { SearchSourceType } from '../generated/core-client';
import type { SearchMode } from './search.constants';
import type { SnippetHighlight } from './search-snippet';

/**
 * Phase 49J: the shapes crossing the Global Search API boundary.
 *
 * ALLOWLISTED BY CONSTRUCTION. Every field a result can carry is declared here, so
 * adding one is a deliberate edit to this file rather than a side effect of widening
 * a Prisma `select`. That is the same discipline `DirectoryService`,
 * `MessagingService` and `SupportService` apply to their own projections, and it is
 * what keeps E-class data (credentials, password hashes, token versions, storage
 * keys, audit rows) structurally unable to appear in a search response.
 *
 * NOT PRESENT ANYWHERE BELOW, deliberately:
 *  - `tenantId` — internal isolation key, never projected, exactly as in 49E/49F/49G;
 *  - `userId` / `ownerId` / `senderId` / `authorId` — a result says WHAT was found,
 *    not who else can see it;
 *  - `isInternal` — an internal ticket comment is EXCLUDED for a non-agent rather
 *    than flagged, so the flag has nothing to communicate;
 *  - any raw storage key, attachment path or provider/model identifier.
 */

/** Where the client should navigate for a result. */
export interface SearchNavigation {
  /**
   * App route, e.g. `/admin/support/<id>`. Built from route constants, never from
   * user-supplied text, so a result can never inject a URL.
   */
  href: string;
  /**
   * Optional in-page anchor, e.g. the comment or message id. Lets the UI scroll to
   * the matched item inside a thread instead of dropping the user at the top.
   */
  anchor?: string;
}

/** One result. */
export interface SearchResultDto {
  sourceType: SearchSourceType;
  /**
   * The registered source key — PRESENT ONLY for `sourceType = 'EXTERNAL'`.
   *
   * The stable identifier of the bounded context that contributed the row, echoed
   * so a client can tell external results apart (and label them, in the same place
   * the web client already labels the eight platform sources: `SEARCH_SOURCE_LABELS`,
   * client-side, keyed by identifier). It is an identifier, never a translation:
   * labels stay where the architecture already puts them, and no Commerce (or HR,
   * or Finance) label exists anywhere on the server.
   *
   * ABSENT for platform results — omitted, not `undefined` — so the wire shape of
   * every existing source is byte-identical to before this phase.
   */
  sourceKey?: string;
  /** Id of the AUTHORITATIVE row, not of the projection row. */
  sourceId: string;
  /** Short human label: ticket subject, survey title, conversation name, person's name. */
  title: string;
  /** Plain-text excerpt with match offsets. No HTML — see search-snippet.ts. */
  snippet: string;
  highlights: SnippetHighlight[];
  /** Final hybrid score, [0,1] before the source multiplier, monotonic afterwards. */
  score: number;
  /**
   * Which arms found this row. Diagnostic, and honest: in degraded mode `semantic`
   * is `false` for every result, which is a fact about retrieval rather than about
   * the document.
   */
  matchedBy: { lexical: boolean; semantic: boolean };
  /** Source row timestamp, so the client can display or re-sort by recency. */
  timestamp: Date;
  navigation: SearchNavigation;
}

/** The response envelope. */
export interface SearchResponseDto {
  /** The query as SENT, echoed for the UI. Never the normalized form. */
  query: string;
  /** The normalized form actually searched. Exposed because it explains surprising hits. */
  normalizedQuery: string;
  results: SearchResultDto[];
  /**
   * Number of results returned in THIS page. Not a corpus total: a true total would
   * require authorizing every candidate in the corpus, and reporting an
   * unauthorized total would leak how much exists that the caller cannot see.
   */
  count: number;
  /** True when more authorized candidates existed beyond this page. */
  hasMore: boolean;
  /** `HYBRID` or `LEXICAL`. */
  mode: SearchMode;
  /**
   * True when semantic retrieval could not run and results are lexical only.
   *
   * NO REASON IS EXPOSED. Provider identity, model name and credential state are
   * administrative facts guarded by `admin.ai.read`; a search caller learns only
   * that recall is reduced. The server logs the cause.
   */
  degraded: boolean;
  /** Which sources contributed, for the UI's facet chips. */
  sourceCounts: Partial<Record<SearchSourceType, number>>;
}

/**
 * The caller's identity, resolved server-side.
 *
 * Constructed only from the authenticated request: `userId` from `req.user.sub`,
 * `tenantId` from `RequestContextService`, and the two permission flags from the
 * RBAC catalogue. No field is ever read from a query parameter, a header or a body.
 */
export interface SearchScope {
  userId: string;
  /** `null` is a real bucket, not "any tenant". */
  tenantId: string | null;
  /** `admin.support.manage` — a support agent sees their tenant's tickets and internal notes. */
  isSupportAgent: boolean;
  /** `admin.surveys.manage` — a survey manager sees drafts. */
  isSurveyManager: boolean;
}

/**
 * A candidate that survived authorization, carrying the fields the projection
 * deliberately does not store: the authoritative text for the snippet, the display
 * title, and the timestamp.
 */
export interface AuthorizedSource {
  sourceType: SearchSourceType;
  sourceId: string;
  title: string;
  /** Fields to snippet, in preference order. */
  snippetFields: Array<string | null>;
  timestamp: Date;
  navigation: SearchNavigation;
}
