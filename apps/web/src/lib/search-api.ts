import { coreGet } from './core-http';

/**
 * Phase 49J: Global Search client.
 *
 * Mirrors `GET /search` exactly, and mirrors it NARROWLY: `q`, `limit`, `offset` and an
 * optional `sourceType`. The API runs `forbidNonWhitelisted`, so any other parameter is
 * REJECTED rather than ignored — which is why there is no `tenantId`, `userId` or
 * `includeInternal` argument anywhere in this file. Identity and tenant come from the
 * authenticated session server-side; the client is structurally unable to ask for
 * someone else's results.
 *
 * SNIPPETS ARE PLAIN TEXT WITH OFFSETS, never HTML. The server returns `snippet` plus
 * `highlights` (character ranges into that snippet) and the UI builds text nodes from
 * them, so a matched message body can never carry markup into the DOM. Any component
 * that renders a snippet must use the offsets — never `dangerouslySetInnerHTML`.
 */

/**
 * The eight indexed PLATFORM sources plus `EXTERNAL` — the marker a bounded context's
 * result carries (the server adds it exactly once, in `search.types.ts`). Kept in one
 * union because the wire sends both in the same `sourceType` field.
 */
export type SearchSourceType =
  | 'TICKET'
  | 'TICKET_COMMENT'
  | 'SURVEY'
  | 'MESSAGE'
  | 'CONVERSATION'
  | 'NOTIFICATION'
  | 'REMINDER'
  | 'USER'
  | 'EXTERNAL';

/**
 * The platform-owned members — exactly the eight the facet chips and the label record
 * cover. `EXTERNAL` is deliberately NOT a facet: `SearchQueryDto`'s allowlist does not
 * accept it as a filter (a product decision recorded in P-SEARCH-SOURCE §AA.4), so a
 * chip for it would be a control that 422s. External results still appear under "همه"
 * and are labelled individually by `searchSourceLabel`.
 */
export type PlatformSearchSourceType = Exclude<SearchSourceType, 'EXTERNAL'>;

/** Retrieval mode the server reports. `LEXICAL` means the semantic arm did not run. */
export type SearchMode = 'HYBRID' | 'LEXICAL';

/** A highlight range, as offsets into `SearchResult.snippet`. Half-open: [start, end). */
export interface SearchHighlight {
  start: number;
  end: number;
}

export interface SearchNavigation {
  /** In-app route. Built server-side from route constants, never from matched text. */
  href: string;
  /** Optional element id to scroll to inside the target page. */
  anchor?: string;
}

export interface SearchResult {
  sourceType: SearchSourceType;
  /**
   * Present ONLY when `sourceType` is `EXTERNAL`: the STABLE registered key of the
   * bounded context that contributed the row (e.g. `commerce.purchase-document`), so a
   * client can label it. Absent (omitted, not `undefined`) for platform results — the
   * server keeps their wire shape byte-identical.
   */
  sourceKey?: string;
  sourceId: string;
  title: string;
  /** Plain text. Render with `highlights`; never as HTML. */
  snippet: string;
  highlights: SearchHighlight[];
  score: number;
  matchedBy: { lexical: boolean; semantic: boolean };
  /** ISO string over the wire, even though the server types it as a Date. */
  timestamp: string;
  navigation: SearchNavigation;
}

export interface SearchResponse {
  query: string;
  /** The normalized form actually searched. Explains otherwise-surprising hits. */
  normalizedQuery: string;
  results: SearchResult[];
  count: number;
  hasMore: boolean;
  mode: SearchMode;
  /**
   * True when semantic retrieval was unavailable and recall is reduced.
   *
   * NO REASON IS PROVIDED, by design: provider identity and credential state are
   * administrative facts. The UI says results may be incomplete and says nothing about
   * why.
   */
  degraded: boolean;
  sourceCounts: Partial<Record<SearchSourceType, number>>;
}

/** Backend defaults and caps, mirrored so the UI never asks for more than it can get. */
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 50;
export const MIN_SEARCH_QUERY = 2;
export const MAX_SEARCH_QUERY = 120;

/**
 * Persian labels for the facet chips. Exhaustive over `PlatformSearchSourceType` —
 * the eight platform sources — and deliberately NOT over `EXTERNAL`, because an
 * external row's label belongs to its source KEY (below), not to one shared badge.
 */
export const SEARCH_SOURCE_LABELS: Record<PlatformSearchSourceType, string> = {
  TICKET: 'تیکت‌ها',
  TICKET_COMMENT: 'پاسخ‌های تیکت',
  SURVEY: 'نظرسنجی‌ها',
  MESSAGE: 'پیام‌ها',
  CONVERSATION: 'گفتگوها',
  NOTIFICATION: 'اطلاع‌رسانی‌ها',
  REMINDER: 'یادآورها',
  USER: 'همکاران',
};

/**
 * Labels for EXTERNAL results, keyed by the registered SOURCE KEY — the same place
 * the eight platform labels live, client-side, with the identifier the server echoes.
 * One entry today (C9, GAP-5): the Commerce purchase document, in the module's own
 * confirmed vocabulary (UI-0 §33 / UI-5-C: the document is «سند درخواست خرید»).
 */
export const SEARCH_EXTERNAL_SOURCE_LABELS: Record<string, string> = {
  'commerce.purchase-document': 'سند درخواست خرید',
};

/** Badge for an external source this client does not know yet — existing vocabulary. */
export const SEARCH_UNKNOWN_SOURCE_LABEL = 'سایر';

/**
 * The badge text for one result: a platform source's own label, or the external
 * source's key label — never an invented term, never a raw key when a known label
 * exists.
 */
export function searchSourceLabel(
  result: Pick<SearchResult, 'sourceType' | 'sourceKey'>
): string {
  if (result.sourceType !== 'EXTERNAL') {
    return SEARCH_SOURCE_LABELS[result.sourceType];
  }

  return SEARCH_EXTERNAL_SOURCE_LABELS[result.sourceKey ?? ''] ?? SEARCH_UNKNOWN_SOURCE_LABEL;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  sourceType?: SearchSourceType;
}

/**
 * Runs one search.
 *
 * `q` is encoded by `URLSearchParams` — the query is arbitrary user text including
 * Persian characters, `&`, `#` and `+`, every one of which would corrupt the query
 * string unencoded. `limit` is clamped client-side too, so an oversized request is never
 * even sent (the server caps it as well; this just avoids a pointless round trip that
 * silently returns fewer rows than asked for).
 */
export async function globalSearch(q: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });

  const limit = Math.min(options.limit ?? SEARCH_PAGE_SIZE, SEARCH_MAX_PAGE_SIZE);
  params.set('limit', String(limit));

  if (options.offset && options.offset > 0) {
    params.set('offset', String(options.offset));
  }

  if (options.sourceType) {
    params.set('sourceType', options.sourceType);
  }

  return coreGet<SearchResponse>(`/search?${params.toString()}`);
}

/**
 * Persian absolute date/time for a result.
 *
 * Absolute rather than relative, and duplicated from `notifications-api` rather than
 * imported from it: search results are not notifications, and reaching into another
 * feature's module for a formatter would couple the two. No date library is added —
 * `Intl` is already the project's formatter of record for wire timestamps.
 *
 * An unparseable value yields an empty string rather than `Invalid Date`.
 */
export function formatSearchTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Splits a snippet into plain-text segments, marking which are matches.
 *
 * This is the ONLY sanctioned way to render highlights: the component maps segments to
 * text nodes and wraps the marked ones, so no snippet ever becomes markup. Ranges
 * arrive sorted and merged from the server; out-of-range values are clamped here rather
 * than trusted, because a bad offset would silently drop text from the display.
 */
export function splitSnippet(
  snippet: string,
  highlights: readonly SearchHighlight[]
): Array<{ text: string; match: boolean }> {
  if (!snippet) return [];
  if (highlights.length === 0) return [{ text: snippet, match: false }];

  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  for (const range of highlights) {
    const start = Math.max(0, Math.min(range.start, snippet.length));
    const end = Math.max(start, Math.min(range.end, snippet.length));

    if (start > cursor) {
      segments.push({ text: snippet.slice(cursor, start), match: false });
    }

    if (end > start) {
      segments.push({ text: snippet.slice(start, end), match: true });
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), match: false });
  }

  return segments;
}
