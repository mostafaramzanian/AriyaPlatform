import { normalizedTokens, normalizeSearchText } from './persian-normalize';
import { SNIPPET_ELLIPSIS, SNIPPET_LEAD, SNIPPET_LENGTH } from './search.constants';

/**
 * Phase 49J: safe snippet construction.
 *
 * A snippet is cut from the AUTHORITATIVE row, and only after that row has passed
 * its source's authorization check. It is never cut from `SearchDocument`, which
 * stores no raw text — so a snippet cannot be stale, and the projection never
 * becomes a second, less-guarded copy of private content.
 *
 * WHY NOT `ts_headline`
 * --------------------
 * `ts_headline` would re-tokenize the ORIGINAL text with a text-search
 * configuration, while what actually matched was the NORMALIZED projection. The two
 * tokenizations disagree exactly where this feature is interesting (ZWNJ, folded
 * yeh/kaf, attached clitics), so its offsets can land in the wrong place or find
 * nothing to highlight at all. It would also mean a second round-trip per result.
 *
 * WHAT THIS RETURNS
 * -----------------
 * A plain-text excerpt plus the match offsets INTO THAT EXCERPT. No HTML, no
 * `<mark>`, no markup of any kind: the web client renders text nodes and applies its
 * own highlighting from the offsets, so a snippet can never carry injected markup
 * into the DOM. That is the same rule messaging and ticketing already follow for
 * bodies.
 */

/** One highlight range, as offsets into `SnippetResult.text`. Half-open: [start, end). */
export interface SnippetHighlight {
  start: number;
  end: number;
}

export interface SnippetResult {
  /** The excerpt. Plain text, possibly ellipsised at either end. */
  text: string;
  /** Ranges of `text` that matched the query. May be empty. */
  highlights: SnippetHighlight[];
}

/**
 * Maps every character of `source` to its position in the normalized form, by
 * running the same normalization one character at a time.
 *
 * This is what makes highlighting correct in the presence of folding: the match is
 * found in normalized space, the offsets are reported in ORIGINAL space, and the two
 * are related by this map rather than by an assumption that normalization preserves
 * length (it does not — ZWNJ and diacritics are deleted, ligatures expand).
 *
 * Cost is linear in the field length, and it runs only for the bounded page of
 * results the caller actually receives.
 */
function buildOffsetMap(source: string): { normalized: string; originalIndex: number[] } {
  let normalized = '';
  const originalIndex: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const piece = normalizeSearchText(source[i]);
    for (let k = 0; k < piece.length; k += 1) {
      normalized += piece[k];
      originalIndex.push(i);
    }
  }

  return { normalized, originalIndex };
}

/**
 * Finds the first occurrence of any query token in the normalized text, preferring
 * the LONGEST token — a longer token is the more specific match, so anchoring the
 * window on it produces a more informative excerpt than anchoring on a stray
 * two-letter word. (`normalizedTokens` already returns longest-first.)
 */
function findAnchor(
  normalized: string,
  tokens: readonly string[]
): { token: string; at: number } | null {
  for (const token of tokens) {
    const at = normalized.indexOf(token);
    if (at !== -1) return { token, at };
  }
  return null;
}

/**
 * Cuts a snippet of `SNIPPET_LENGTH` characters from `source`, centred on the first
 * match of `query`, with match offsets.
 *
 * With no match — possible when the hit came from the semantic arm, or from a
 * different field of the same row — the leading `SNIPPET_LENGTH` characters are
 * returned with no highlights, which is honest: something matched this row, but not
 * this field.
 *
 * Word boundaries are respected when trimming, so a snippet never begins mid-word,
 * which in Persian would render as a broken ligature chain.
 */
export function buildSnippet(source: string | null | undefined, query: string): SnippetResult {
  if (!source || !source.trim()) {
    return { text: '', highlights: [] };
  }

  const tokens = normalizedTokens(query);
  const { normalized, originalIndex } = buildOffsetMap(source);
  const anchor = tokens.length > 0 ? findAnchor(normalized, tokens) : null;

  // No match in this field: return the head of it, unhighlighted.
  if (!anchor) {
    const end = Math.min(source.length, SNIPPET_LENGTH);
    return { text: clip(source, 0, end, false, end < source.length), highlights: [] };
  }

  const anchorOriginal = originalIndex[anchor.at] ?? 0;
  const rawStart = Math.max(0, anchorOriginal - SNIPPET_LEAD);
  const start = rawStart === 0 ? 0 : advanceToWordBoundary(source, rawStart, anchorOriginal);
  const end = Math.min(source.length, start + SNIPPET_LENGTH);

  const text = clip(source, start, end, start > 0, end < source.length);
  // `clip` trims and may prepend an ellipsis; both shift every offset in the excerpt.
  const leading = source.slice(start, end);
  const trimmedBy = leading.length - leading.trimStart().length;
  const shift = (start > 0 ? SNIPPET_ELLIPSIS.length : 0) - start - trimmedBy;

  return {
    text,
    highlights: collectHighlights(normalized, originalIndex, tokens, start, end, shift),
  };
}

/**
 * First index at or after `from` that begins a word, so a snippet never starts
 * mid-token. Never advances past `limit` (the anchor), which would cut off the very
 * match the window exists to show.
 */
function advanceToWordBoundary(source: string, from: number, limit: number): number {
  for (let i = from; i < limit; i += 1) {
    if (/\s/.test(source[i])) return i + 1;
  }
  return from;
}

/** Extracts [start,end), trims it, and adds the ellipses the caller asked for. */
function clip(
  source: string,
  start: number,
  end: number,
  ellipsisBefore: boolean,
  ellipsisAfter: boolean
): string {
  const body = source.slice(start, end).trim();
  return `${ellipsisBefore ? SNIPPET_ELLIPSIS : ''}${body}${ellipsisAfter ? SNIPPET_ELLIPSIS : ''}`;
}

/**
 * Every occurrence of every token that falls inside the window, translated back to
 * offsets in the emitted snippet.
 *
 * Overlaps are merged: two tokens matching at the same place must produce one range,
 * or the client would nest two highlight spans.
 */
function collectHighlights(
  normalized: string,
  originalIndex: readonly number[],
  tokens: readonly string[],
  windowStart: number,
  windowEnd: number,
  shift: number
): SnippetHighlight[] {
  const ranges: SnippetHighlight[] = [];

  for (const token of tokens) {
    let at = normalized.indexOf(token);
    while (at !== -1) {
      const originalStart = originalIndex[at];
      const originalEnd = (originalIndex[at + token.length - 1] ?? originalStart) + 1;

      if (originalStart >= windowStart && originalEnd <= windowEnd) {
        ranges.push({ start: originalStart + shift, end: originalEnd + shift });
      }

      at = normalized.indexOf(token, at + 1);
    }
  }

  return mergeRanges(ranges);
}

/** Sorts and merges overlapping or touching ranges. */
function mergeRanges(ranges: SnippetHighlight[]): SnippetHighlight[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SnippetHighlight[] = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Picks the field that best represents a row and snippets it.
 *
 * Fields are tried in order and the first one containing a match wins, so a hit in a
 * ticket's body produces a body snippet rather than a subject snippet that shows
 * nothing relevant. With no match anywhere, the first non-empty field is used.
 */
export function buildBestSnippet(
  fields: ReadonlyArray<string | null | undefined>,
  query: string
): SnippetResult {
  const present = fields.filter((field): field is string => Boolean(field && field.trim()));
  if (present.length === 0) return { text: '', highlights: [] };

  for (const field of present) {
    const snippet = buildSnippet(field, query);
    if (snippet.highlights.length > 0) return snippet;
  }

  return buildSnippet(present[0], query);
}
