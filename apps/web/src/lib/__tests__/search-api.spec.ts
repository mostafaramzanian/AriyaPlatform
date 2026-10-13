import {
  MAX_SEARCH_QUERY,
  MIN_SEARCH_QUERY,
  SEARCH_EXTERNAL_SOURCE_LABELS,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  SEARCH_SOURCE_LABELS,
  SEARCH_UNKNOWN_SOURCE_LABEL,
  formatSearchTime,
  globalSearch,
  searchSourceLabel,
  splitSnippet,
  type PlatformSearchSourceType,
} from '../search-api';
import { coreGet } from '../core-http';

/**
 * Phase 49J coverage for the Global Search client.
 *
 * TWO INVARIANTS ARE UNDER TEST, and they are the two that carry security weight:
 *
 *  1. THE REQUEST CANNOT BE SHAPED TO ASK FOR SOMEBODY ELSE'S RESULTS. The API runs
 *     `forbidNonWhitelisted`, so an unknown parameter is a 422, not an ignored extra —
 *     which means the absence of `tenantId`/`userId` from the query string is the
 *     boundary. Every assertion below inspects the EXACT path that is sent.
 *
 *  2. `splitSnippet` NEVER LOSES OR INVENTS TEXT. It is the only sanctioned render path
 *     for a snippet, so a dropped range would silently hide matched content and an
 *     unclamped one would throw or slice wrongly. Concatenating the segments must always
 *     reproduce the input exactly.
 */

jest.mock('../core-http', () => ({
  coreGet: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;

const EMPTY = {
  query: '',
  normalizedQuery: '',
  results: [],
  count: 0,
  hasMore: false,
  mode: 'LEXICAL' as const,
  degraded: true,
  sourceCounts: {},
};

/** The path passed to `coreGet` for the most recent call. */
const lastPath = () => getMock.mock.calls[getMock.mock.calls.length - 1][0];

/** Parsed query string of the most recent call. */
const lastParams = () => new URLSearchParams(lastPath().split('?')[1] ?? '');

describe('search-api — request shape', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue(EMPTY);
  });

  it('sends q and the default limit, and nothing else', async () => {
    await globalSearch('ورود');

    const params = lastParams();
    expect(lastPath().startsWith('/search?')).toBe(true);
    expect(params.get('q')).toBe('ورود');
    expect(params.get('limit')).toBe(String(SEARCH_PAGE_SIZE));
    expect([...params.keys()].sort()).toEqual(['limit', 'q']);
  });

  it('percent-encodes a query that would otherwise corrupt the query string', async () => {
    await globalSearch('a&b=c#d+e');

    // The raw path must not contain the bare separators…
    const raw = lastPath();
    expect(raw).not.toContain('&b=c');
    expect(raw).not.toContain('#d');
    // …and the value must survive the round trip intact, `+` included.
    expect(lastParams().get('q')).toBe('a&b=c#d+e');
  });

  it('preserves Persian characters and ZWNJ through encoding', async () => {
    await globalSearch('نظرسنجی‌ها');

    expect(lastParams().get('q')).toBe('نظرسنجی‌ها');
  });

  it('clamps an oversized limit instead of sending it', async () => {
    await globalSearch('ورود', { limit: 5000 });

    expect(lastParams().get('limit')).toBe(String(SEARCH_MAX_PAGE_SIZE));
  });

  it('omits offset when it is zero, so the default page carries no noise', async () => {
    await globalSearch('ورود', { offset: 0 });

    expect(lastParams().has('offset')).toBe(false);
  });

  it('sends a real offset when one is asked for', async () => {
    await globalSearch('ورود', { offset: 40 });

    expect(lastParams().get('offset')).toBe('40');
  });

  it('sends sourceType only when a filter is chosen', async () => {
    await globalSearch('ورود');
    expect(lastParams().has('sourceType')).toBe(false);

    await globalSearch('ورود', { sourceType: 'TICKET' });
    expect(lastParams().get('sourceType')).toBe('TICKET');
  });

  it('has no parameter through which another tenant or user could be requested', async () => {
    // The client is structurally unable to express these: they are not in `SearchOptions`,
    // and the DTO would reject them anyway. This asserts the absence rather than trusting it.
    await globalSearch('ورود', { limit: 10, offset: 10, sourceType: 'MESSAGE' });

    const keys = [...lastParams().keys()];
    for (const forbidden of ['tenantId', 'userId', 'asUser', 'includeInternal', 'includeDrafts']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('returns the server response unchanged', async () => {
    const payload = { ...EMPTY, query: 'ورود', count: 0 };
    getMock.mockResolvedValue(payload);

    await expect(globalSearch('ورود')).resolves.toBe(payload);
  });

  it('propagates a failure rather than masking it as an empty result', async () => {
    getMock.mockRejectedValue(new Error('boom'));

    await expect(globalSearch('ورود')).rejects.toThrow('boom');
  });
});

describe('search-api — splitSnippet', () => {
  /** The property that matters: segments concatenate back to the input, always. */
  const roundTrip = (text: string, ranges: Array<{ start: number; end: number }>) =>
    splitSnippet(text, ranges)
      .map((segment) => segment.text)
      .join('');

  it('returns nothing for an empty snippet', () => {
    expect(splitSnippet('', [{ start: 0, end: 1 }])).toEqual([]);
  });

  it('returns one unmatched segment when there are no highlights', () => {
    expect(splitSnippet('سلام دنیا', [])).toEqual([{ text: 'سلام دنیا', match: false }]);
  });

  it('splits around a single interior match', () => {
    expect(splitSnippet('abcdef', [{ start: 2, end: 4 }])).toEqual([
      { text: 'ab', match: false },
      { text: 'cd', match: true },
      { text: 'ef', match: false },
    ]);
  });

  it('handles a match at the very start and at the very end', () => {
    expect(splitSnippet('abcd', [{ start: 0, end: 2 }])).toEqual([
      { text: 'ab', match: true },
      { text: 'cd', match: false },
    ]);

    expect(splitSnippet('abcd', [{ start: 2, end: 4 }])).toEqual([
      { text: 'ab', match: false },
      { text: 'cd', match: true },
    ]);
  });

  it('handles several disjoint matches', () => {
    expect(
      splitSnippet('abcdefgh', [
        { start: 1, end: 2 },
        { start: 5, end: 7 },
      ]),
    ).toEqual([
      { text: 'a', match: false },
      { text: 'b', match: true },
      { text: 'cde', match: false },
      { text: 'fg', match: true },
      { text: 'h', match: false },
    ]);
  });

  it('clamps a range that runs past the end of the snippet', () => {
    expect(splitSnippet('abc', [{ start: 1, end: 99 }])).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
    ]);
    expect(roundTrip('abc', [{ start: 1, end: 99 }])).toBe('abc');
  });

  it('clamps a negative start rather than producing a reversed slice', () => {
    expect(splitSnippet('abc', [{ start: -5, end: 2 }])).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: false },
    ]);
  });

  it('drops a zero-width or inverted range without losing text', () => {
    expect(splitSnippet('abc', [{ start: 2, end: 2 }])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: false },
    ]);
    expect(roundTrip('abc', [{ start: 2, end: 1 }])).toBe('abc');
  });

  it('never loses or duplicates text, for any range set', () => {
    const text = 'سلام این یک متن آزمایشی است';
    const cases: Array<Array<{ start: number; end: number }>> = [
      [],
      [{ start: 0, end: text.length }],
      [{ start: 0, end: 0 }],
      [{ start: 5, end: 8 }],
      [
        { start: 0, end: 4 },
        { start: 9, end: 12 },
        { start: 20, end: 99 },
      ],
      [{ start: -3, end: 2 }],
      [
        { start: 3, end: 3 },
        { start: 3, end: 6 },
      ],
    ];

    for (const ranges of cases) {
      expect(roundTrip(text, ranges)).toBe(text);
    }
  });
});

describe('search-api — constants and labels', () => {
  it('mirrors the backend bounds', () => {
    // These four mirror `search.constants.ts`: DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT,
    // MIN_QUERY_LENGTH and MAX_QUERY_LENGTH. A drift here would make the UI ask for
    // something the API caps or rejects.
    expect(SEARCH_PAGE_SIZE).toBe(20);
    expect(SEARCH_MAX_PAGE_SIZE).toBe(50);
    expect(MIN_SEARCH_QUERY).toBe(2);
    expect(MAX_SEARCH_QUERY).toBe(120);
  });

  it('labels every one of the eight platform sources', () => {
    const sources: PlatformSearchSourceType[] = [
      'TICKET',
      'TICKET_COMMENT',
      'SURVEY',
      'MESSAGE',
      'CONVERSATION',
      'NOTIFICATION',
      'REMINDER',
      'USER',
    ];

    expect(Object.keys(SEARCH_SOURCE_LABELS).sort()).toEqual([...sources].sort());
    for (const source of sources) {
      expect(SEARCH_SOURCE_LABELS[source]).toEqual(expect.any(String));
      expect(SEARCH_SOURCE_LABELS[source].length).toBeGreaterThan(0);
    }
    // The EXTERNAL marker is deliberately NOT a member: its label belongs to the source
    // KEY, so one shared badge could not exist even if a chip wanted it.
    expect('EXTERNAL' in SEARCH_SOURCE_LABELS).toBe(false);
  });

  it('labels the Commerce source by its source key, in the module’s confirmed vocabulary (C9)', () => {
    // The key is the identifier the server echoes (`commerce.purchase-document`) and the
    // label is UI-0 §33 / UI-5-C's canonical document term — never «سند خرید».
    expect(SEARCH_EXTERNAL_SOURCE_LABELS['commerce.purchase-document']).toBe('سند درخواست خرید');
    expect(Object.keys(SEARCH_EXTERNAL_SOURCE_LABELS)).toEqual(['commerce.purchase-document']);
  });

  it('resolves a badge for every result shape: platform, known external, unknown external', () => {
    expect(searchSourceLabel({ sourceType: 'TICKET' })).toBe(SEARCH_SOURCE_LABELS.TICKET);
    expect(searchSourceLabel({ sourceType: 'USER' })).toBe(SEARCH_SOURCE_LABELS.USER);
    expect(
      searchSourceLabel({ sourceType: 'EXTERNAL', sourceKey: 'commerce.purchase-document' })
    ).toBe('سند درخواست خرید');
    // An external source this client has never seen must still badge something — the
    // existing vocabulary for "the rest", never a raw key and never an empty badge.
    expect(searchSourceLabel({ sourceType: 'EXTERNAL', sourceKey: 'future.source' })).toBe(
      SEARCH_UNKNOWN_SOURCE_LABEL
    );
    expect(searchSourceLabel({ sourceType: 'EXTERNAL' })).toBe(SEARCH_UNKNOWN_SOURCE_LABEL);
  });
});

describe('search-api — formatSearchTime', () => {
  it('formats a valid ISO timestamp', () => {
    expect(formatSearchTime('2026-08-28T10:00:00.000Z')).not.toBe('');
  });

  it('returns an empty string for an unparseable value instead of Invalid Date', () => {
    expect(formatSearchTime('not-a-date')).toBe('');
    expect(formatSearchTime('')).toBe('');
  });
});
