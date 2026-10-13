import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreGlobalSearch } from '../CoreGlobalSearch';
import { CoreApiError, hasLocalSession } from '@/lib/core-http';
import { globalSearch, type SearchResponse, type SearchResult } from '@/lib/search-api';

/**
 * Phase 49J: CoreGlobalSearch unit tests.
 *
 * Modelled on `CoreNotificationBell.spec.tsx` — the same mocking shape for
 * `core-http`/`next/navigation`, so a reader can diff the two.
 *
 * WHAT THESE TESTS ARE FOR, beyond rendering: the two properties that carry security
 * weight in this component are (1) a snippet becomes TEXT NODES and never markup, and
 * (2) the degraded banner never states a reason. Both are asserted directly.
 */

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin',
}));

jest.mock('@/lib/core-http', () => ({
  ...jest.requireActual('@/lib/core-http'),
  hasLocalSession: jest.fn(() => true),
}));

jest.mock('@/lib/search-api', () => ({
  ...jest.requireActual('@/lib/search-api'),
  globalSearch: jest.fn(),
}));

const sessionMock = hasLocalSession as jest.MockedFunction<typeof hasLocalSession>;
const searchMock = globalSearch as jest.MockedFunction<typeof globalSearch>;

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    sourceType: 'TICKET',
    sourceId: 't1',
    title: 'TCK-1001 — خطا در ورود',
    snippet: 'کاربر نمی‌تواند وارد شود',
    highlights: [],
    score: 0.9,
    matchedBy: { lexical: true, semantic: false },
    timestamp: '2026-08-28T10:00:00.000Z',
    navigation: { href: '/admin/support/t1' },
    ...overrides,
  };
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: 'ورود',
    normalizedQuery: 'ورود',
    results: [result()],
    count: 1,
    hasMore: false,
    mode: 'LEXICAL',
    degraded: true,
    sourceCounts: { TICKET: 1 },
    ...overrides,
  };
}

/** Types into the desktop field. Real timers: the 350ms debounce is awaited via findBy*. */
async function type(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByTestId('global-search-input'), text);
  return user;
}

describe('CoreGlobalSearch', () => {
  beforeEach(() => {
    sessionMock.mockReturnValue(true);
    searchMock.mockResolvedValue(response());
  });

  afterEach(() => {
    jest.clearAllMocks();
    push.mockReset();
  });

  it('renders the search field with no request until something is typed', () => {
    render(<CoreGlobalSearch />);

    expect(screen.getByTestId('global-search-input')).toBeInTheDocument();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('debounces typing into a single request', async () => {
    render(<CoreGlobalSearch />);
    await type('ورود');

    // One request for the settled value, not one per keystroke.
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(searchMock).toHaveBeenLastCalledWith('ورود', expect.objectContaining({ limit: 8 }));
  });

  it('never sends a query shorter than the minimum', async () => {
    render(<CoreGlobalSearch />);
    await type('و');

    expect(
      await screen.findByText(/دست‌کم 2 نویسه/, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('skips the request entirely when there is no local session', async () => {
    sessionMock.mockReturnValue(false);

    render(<CoreGlobalSearch />);
    await type('ورود');

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('renders a result with its source label', async () => {
    render(<CoreGlobalSearch />);
    await type('ورود');

    const item = await screen.findByTestId('global-search-result', undefined, { timeout: 5000 });
    expect(item).toHaveAttribute('data-source', 'TICKET');
    expect(item).toHaveTextContent('TCK-1001 — خطا در ورود');
    expect(item).toHaveTextContent('تیکت‌ها');
  });

  it('renders an EXTERNAL result with its source-key label and opens the composed href (C9)', async () => {
    // The Commerce source (GAP-5): the badge comes from the source KEY, the href is the
    // platform-composed route to the existing Purchase Detail page — no new destination.
    searchMock.mockResolvedValue(
      response({
        results: [
          result({
            sourceType: 'EXTERNAL',
            sourceKey: 'commerce.purchase-document',
            sourceId: 'c9-doc',
            title: 'PR-1405-00001',
            snippet: 'PR-1405-00001',
            navigation: { href: '/admin/commerce/purchases/c9-doc' },
          }),
        ],
        sourceCounts: { EXTERNAL: 1 },
      }),
    );

    render(<CoreGlobalSearch />);
    await type('PR-1405');

    const item = await screen.findByTestId('global-search-result', undefined, { timeout: 5000 });
    expect(item).toHaveAttribute('data-source', 'EXTERNAL');
    expect(item).toHaveTextContent('سند درخواست خرید');
    // The facet row stays platform-only: no EXTERNAL chip is offered, because the server
    // would refuse `sourceType=EXTERNAL` as a filter.
    expect(screen.queryAllByTestId('global-search-facet')).toHaveLength(0);

    await userEvent.click(item);
    expect(push).toHaveBeenCalledWith('/admin/commerce/purchases/c9-doc');
  });

  it('renders highlights as text nodes, never as markup', async () => {
    // A snippet carrying a script tag AND a highlight range over it. If any HTML path
    // existed, this would become an element; it must stay literal text.
    const hostile = '<img src=x onerror=alert(1)> ورود';
    // Offsets are DERIVED, not hardcoded: a literal index here would silently drift the
    // moment the fixture text changed, and the assertion below would then be testing
    // nothing.
    const start = hostile.indexOf('ورود');
    searchMock.mockResolvedValue(
      response({
        results: [
          result({ snippet: hostile, highlights: [{ start, end: start + 'ورود'.length }] }),
        ],
      }),
    );

    const { container } = render(<CoreGlobalSearch />);
    await type('ورود');

    const item = await screen.findByTestId('global-search-result', undefined, { timeout: 5000 });
    // The tag is displayed verbatim…
    expect(item).toHaveTextContent('<img src=x onerror=alert(1)>');
    // …and no element was created from it.
    expect(container.querySelector('img')).toBeNull();

    // The highlighted range is wrapped in <mark>, with the matched text inside it.
    const marks = screen.getAllByTestId('search-highlight');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('ورود');
  });

  it('clamps an out-of-range highlight instead of dropping snippet text', async () => {
    searchMock.mockResolvedValue(
      response({
        results: [result({ snippet: 'ورود', highlights: [{ start: 0, end: 999 }] })],
      }),
    );

    render(<CoreGlobalSearch />);
    await type('ورود');

    const item = await screen.findByTestId('global-search-result', undefined, { timeout: 5000 });
    expect(item).toHaveTextContent('ورود');
  });

  it('shows the degraded banner WITHOUT naming a provider, model or credential', async () => {
    render(<CoreGlobalSearch />);
    await type('ورود');

    const banner = await screen.findByTestId('global-search-degraded', undefined, {
      timeout: 5000,
    });
    expect(banner).toHaveTextContent('نتایج ممکن است کامل نباشد.');
    // The reason is administrative information; the UI must not invent or echo one.
    for (const forbidden of ['OpenAI', 'openai', 'کلید', 'API', 'embedding', 'مدل']) {
      expect(banner.textContent).not.toContain(forbidden);
    }
  });

  it('hides the degraded banner when retrieval was not degraded', async () => {
    searchMock.mockResolvedValue(response({ degraded: false, mode: 'HYBRID' }));

    render(<CoreGlobalSearch />);
    await type('ورود');

    await screen.findByTestId('global-search-result', undefined, { timeout: 5000 });
    expect(screen.queryByTestId('global-search-degraded')).not.toBeInTheDocument();
  });

  it('navigates to the server-built href, appending the anchor when present', async () => {
    searchMock.mockResolvedValue(
      response({
        results: [
          result({
            sourceType: 'MESSAGE',
            sourceId: 'm1',
            navigation: { href: '/admin/messages', anchor: 'c1' },
          }),
        ],
        sourceCounts: { MESSAGE: 1 },
      }),
    );

    render(<CoreGlobalSearch />);
    const user = await type('ورود');

    await user.click(
      await screen.findByTestId('global-search-result', undefined, { timeout: 5000 }),
    );

    expect(push).toHaveBeenCalledWith('/admin/messages#c1');
  });

  it('navigates without a hash when the result carries no anchor', async () => {
    render(<CoreGlobalSearch />);
    const user = await type('ورود');

    await user.click(
      await screen.findByTestId('global-search-result', undefined, { timeout: 5000 }),
    );

    expect(push).toHaveBeenCalledWith('/admin/support/t1');
  });

  it('narrows by source when a facet chip is chosen', async () => {
    searchMock.mockResolvedValue(
      response({
        results: [result(), result({ sourceType: 'MESSAGE', sourceId: 'm1' })],
        count: 2,
        sourceCounts: { TICKET: 1, MESSAGE: 1 },
      }),
    );

    render(<CoreGlobalSearch />);
    const user = await type('ورود');

    const chips = await screen.findAllByTestId('global-search-facet', undefined, { timeout: 5000 });
    const messageChip = chips.find((chip) => chip.getAttribute('data-source') === 'MESSAGE');
    expect(messageChip).toBeDefined();

    await user.click(messageChip as HTMLElement);

    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith(
        'ورود',
        expect.objectContaining({ sourceType: 'MESSAGE' }),
      ),
    );
  });

  it('surfaces a failed search inside the panel and can retry', async () => {
    searchMock.mockRejectedValueOnce(new CoreApiError('جست‌وجو ناموفق بود.', 500));

    render(<CoreGlobalSearch />);
    const user = await type('ورود');

    expect(
      await screen.findByText('جست‌وجو ناموفق بود.', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();

    searchMock.mockResolvedValue(response());
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(
      await screen.findByTestId('global-search-result', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('reports an empty result set without inventing rows', async () => {
    searchMock.mockResolvedValue(
      response({ results: [], count: 0, sourceCounts: {}, degraded: false }),
    );

    render(<CoreGlobalSearch />);
    await type('ورود');

    expect(
      await screen.findByText('نتیجه‌ای یافت نشد.', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('global-search-result')).not.toBeInTheDocument();
  });

  it('says more results exist rather than linking to a page that does not exist', async () => {
    searchMock.mockResolvedValue(response({ hasMore: true }));

    render(<CoreGlobalSearch />);
    await type('ورود');

    expect(
      await screen.findByTestId('global-search-has-more', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    // No /admin/search route exists in this phase, so there must be no link to one.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('exposes the combobox wiring assistive technology needs', () => {
    render(<CoreGlobalSearch />);

    const input = screen.getByTestId('global-search-input');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-controls', 'global-search-panel');
    expect(input).toHaveAttribute('aria-label', 'جست‌وجوی سراسری');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the panel on Escape', async () => {
    render(<CoreGlobalSearch />);
    const user = await type('ورود');

    await screen.findByTestId('global-search-panel', undefined, { timeout: 5000 });
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByTestId('global-search-panel')).not.toBeInTheDocument(),
    );
  });
});
