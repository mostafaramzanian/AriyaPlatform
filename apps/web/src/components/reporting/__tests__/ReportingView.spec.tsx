import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReportingView } from '../ReportingView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchCheckRequestReport, type ReportingCheckRequestPage } from '@/lib/reporting-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/reporting-api', () => ({
  ...jest.requireActual('@/lib/reporting-api'),
  fetchCheckRequestReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchCheckRequestReport as jest.MockedFunction<typeof fetchCheckRequestReport>;

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: what the FIRST Reporting workspace
 * actually promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only `status`/`search`, always as a SERVER query, never a
 *     client-side sieve.
 *  3. AUTHORIZATION — without `financial.check.read` no request is issued.
 *  4. SUMMARY HONESTY — every rendered figure comes from the API payload;
 *     the component owns no counting code.
 *  5. STATES — empty and error are distinct; neither fakes the other.
 *  6. SCOPE — no export / scheduling / AI affordance exists, because no
 *     backend contract does.
 */
function grant(permissions: string[], isLoading = false) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

function authState(user: { userId?: string } | null = { userId: 'u-1' }) {
  return {
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

function row(overrides: Partial<ReportingCheckRequestPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'صدور چک برای خرید غیر پروژه ای',
    checkIssueType: 'PURCHASE' as const,
    purchaseType: 'NON_PROJECT' as const,
    orderReference: 'ORDER-1',
    projectReference: null,
    requestDate: '2026-10-03T08:00:00.000Z',
    requesterOpinion: 'CONTINUE' as const,
    status: 2,
    managerDecision: null,
    submittedAt: '2026-10-04T08:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingCheckRequestPage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: { total, byStatus: { '2': items.length } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['financial.check.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ReportingView — «گزارش وضعیت و گردش درخواست‌های صدور چک»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<ReportingView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش وضعیت و گردش درخواست‌های صدور چک',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('reporting-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the contract filters only', async () => {
    render(<ReportingView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: undefined,
        search: '',
      })
    );
  });

  it('issues NO request without financial.check.read — the gate is a closed door', async () => {
    grant(['financial.check.manage']);
    render(<ReportingView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row()], 7),
      summary: { total: 7, byStatus: { '2': 5, '0': 2 } },
    });
    render(<ReportingView />);

    expect(await screen.findByTestId('reporting-summary-all-count')).toHaveTextContent('۷');
    // The API-reported state-2 count, in Persian digits; states the API left at
    // zero render a real zero — no placeholder, no invented number.
    expect(await screen.findByTestId('reporting-summary-count-2')).toHaveTextContent('۵');
    expect(await screen.findByTestId('reporting-summary-count-0')).toHaveTextContent('۲');
    expect(screen.getByTestId('reporting-summary-count-50')).toHaveTextContent('۰');
  });

  it('renders a row with the source status, type and decision vocabulary', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({
          status: 3,
          managerDecision: 'APPROVE',
          submittedAt: '2026-10-04T08:00:00.000Z',
          decidedAt: '2026-10-05T08:00:00.000Z',
        }),
      ])
    );
    render(<ReportingView />);

    expect(await screen.findByTestId('reporting-status-3')).toBeInTheDocument();
    expect(screen.getByTestId('reporting-status-3')).toHaveTextContent('صدور فرم تخصیص');
    expect(screen.getByText('خرید')).toBeInTheDocument();
    expect(screen.getByText('بله')).toBeInTheDocument();
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<ReportingView />);

    const link = await screen.findByTestId(
      'reporting-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/check-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getByTestId('reporting-row-details-11111111-1111-4111-8111-111111111111')
    ).toHaveTextContent('جزئیات');
  });

  it('applies the status filter through the SERVER query', async () => {
    render(<ReportingView />);
    await screen.findByTestId('reporting-table');

    await userEvent.selectOptions(screen.getByTestId('reporting-status-filter'), '2');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 2, page: 1 }))
    );
  });

  it('applies the search through the SERVER query on submit', async () => {
    render(<ReportingView />);
    await screen.findByTestId('reporting-table');

    await userEvent.type(screen.getByTestId('reporting-search-input'), ' gearbox ');
    await userEvent.click(screen.getByTestId('reporting-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'gearbox', page: 1 })
      )
    );
  });

  it('sets the status filter from a summary chip and clears it via «همه»', async () => {
    render(<ReportingView />);
    await screen.findByTestId('reporting-table');

    await userEvent.click(screen.getByTestId('reporting-summary-status-0'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 0 }))
    );

    await userEvent.click(screen.getByTestId('reporting-summary-all'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
    );
  });
});

describe('ReportingView — states', () => {
  it('renders the NO-RECORDS state with the filter-scoped message — not an error', async () => {
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: { total: 0, byStatus: {} },
    });
    render(<ReportingView />);

    expect(await screen.findByTestId('reporting-empty')).toBeInTheDocument();
    expect(screen.getByText('برای این فیلترها درخواستی پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByTestId('reporting-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry — never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<ReportingView />);

    const error = await screen.findByTestId('reporting-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('دریافت گزارش با خطا مواجه شد.');
    expect(screen.queryByTestId('reporting-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight — no fake figures', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ReportingView />);

    expect(screen.getByTestId('reporting-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The summary strip renders placeholders (aria-hidden bars), never a digit.
    expect(screen.queryByTestId('reporting-summary-all-count')).not.toBeInTheDocument();
  });
});

describe('ReportingView — scope protection (no speculative surface)', () => {
  /** Comment lines removed: prose that EXPLAINS a rule must not violate it. */
  const codeOf = (file: string): string => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    return fs
      .readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('{/*')
        );
      })
      .join('\n');
  };

  it('renders the export actions for the CURRENT scope — the contract now exists', async () => {
    // REPORTING-VISUALIZATION-EXPORT legitimised exactly this pair: two labeled,
    // scope-carrying actions over the report's OWN export routes. Anything beyond them
    // (scheduling, mail-out, AI) still fails this suite.
    grant(['financial.check.read']);
    authState();
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: { total: 5, byStatus: { '0': 2, '1': 3 } },
    });

    render(<ReportingView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('reporting-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('reporting-export-docx')).toHaveTextContent('خروجی Word');
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    grant(['financial.check.read']);
    authState();
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: { total: 5, byStatus: { '0': 2, '1': 3 } },
    });

    render(<ReportingView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('reporting-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت درخواست‌ها'
    );
    expect(screen.getByTestId('reporting-chart-count-0')).toHaveTextContent('۲');
  });

  it('owns no scheduling or AI affordance — the backend has none', () => {
    const source = codeOf('ReportingView.tsx');
    // `خروجی` / `download` / `excel` are now HONEST: the two legitimised export actions
    // (the buttons and their server routes) name them, so they no longer pin absence.
    // `csv` / `pdf` / scheduling / AI vocabulary must still never appear here.
    for (const needle of [
      'زمان‌بندی',
      'اشتراک',
      'ارسال خودکار',
      'هوش مصنوعی',
      'تحلیل هوشمند',
      'csv',
      'pdf',
    ]) {
      expect({ needle, present: source.toLowerCase().includes(needle.toLowerCase()) }).toEqual({
        needle,
        present: false,
      });
    }
  });

  it('offers no Financial mutation — the report never approves, rejects or edits', () => {
    const source = codeOf('ReportingView.tsx');
    // The register's only navigation is the detail link; the workflow lives in
    // Financial's own screens and must not be reachable from here. (`submit`
    // is deliberately NOT a needle: the filter bar's submit button is a form,
    // not a Financial transition.)
    for (const needle of ['/admin/financial/', 'approve', 'reject']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
