import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionReportView } from '../ProductionReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchProductionReport, type ReportingProductionPage } from '@/lib/production-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-report-api', () => ({
  ...jest.requireActual('@/lib/production-report-api'),
  fetchProductionReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchProductionReport as jest.MockedFunction<typeof fetchProductionReport>;

/**
 * Phase REPORTING-PRODUCTION-REPORT: what the THIRD Reporting workspace actually
 * promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only `status`/`search`, always as a SERVER query, never a
 *     client-side sieve; and no `requesterUserId` field, because the report refuses
 *     an actor-id filter it could not label honestly.
 *  3. AUTHORIZATION — without `production.bom.read` no request is issued.
 *  4. SUMMARY HONESTY — every rendered figure comes from the API payload;
 *     the component owns no counting code.
 *  5. STATES — empty and error are distinct; neither fakes the other.
 *  6. SCOPE — no write/scheduling/AI affordance exists, because no backend contract
 *     does; the EXPORT actions exist because one does (VISUALIZATION-EXPORT).
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

function row(overrides: Partial<ReportingProductionPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'فهرست پروژه ۴۲',
    projectRef: 'proj-42',
    productTreeRef: 'tree-771',
    status: 'SUBMITTED',
    managerOpinion: null,
    itemCount: 2,
    submittedAt: '2026-01-10T08:00:00.000Z',
    decidedAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingProductionPage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: {
      total,
      byStatus: {
        DRAFT: 0,
        SUBMITTED: items.length,
        APPROVED: 0,
        REJECTED: 0,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ProductionReportView — «گزارش خلاصه و وضعیت عملیات تولید»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<ProductionReportView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش خلاصه و وضعیت عملیات تولید',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('production-report-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the contract filters only', async () => {
    render(<ProductionReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: undefined,
        search: '',
      })
    );
  });

  it('issues NO request without production.bom.read — the gate is a closed door', async () => {
    grant(['production.bom.manage']);
    render(<ProductionReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row()], 7),
      summary: {
        total: 7,
        byStatus: { DRAFT: 2, SUBMITTED: 5, APPROVED: 0, REJECTED: 0 },
      },
    });
    render(<ProductionReportView />);

    expect(await screen.findByTestId('production-report-summary-all-count')).toHaveTextContent('۷');
    // The API-reported state counts, in Persian digits; states the API left at zero
    // render a real zero — no placeholder, no invented number.
    expect(
      await screen.findByTestId('production-report-summary-count-SUBMITTED')
    ).toHaveTextContent('۵');
    expect(await screen.findByTestId('production-report-summary-count-DRAFT')).toHaveTextContent(
      '۲'
    );
    expect(screen.getByTestId('production-report-summary-count-REJECTED')).toHaveTextContent('۰');
  });

  it('renders a row with the source status and decision vocabulary', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({
          title: 'فهرست موتور',
          status: 'APPROVED',
          managerOpinion: 'APPROVED',
          itemCount: 3,
        }),
      ])
    );
    render(<ProductionReportView />);

    expect(await screen.findByTestId('production-report-status-APPROVED')).toBeInTheDocument();
    expect(screen.getByTestId('production-report-status-APPROVED')).toHaveTextContent('تایید شده');
    expect(screen.getByText('فهرست موتور')).toBeInTheDocument();
  });

  it('renders a dash for a row with no decision yet — never a fabricated opinion', async () => {
    fetchMock.mockResolvedValue(page([row({ managerOpinion: null })]));
    render(<ProductionReportView />);

    const table = await screen.findByTestId('production-report-table');
    expect(table).toHaveTextContent('—');
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<ProductionReportView />);

    const link = await screen.findByTestId(
      'production-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/production/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getByTestId('production-report-row-details-11111111-1111-4111-8111-111111111111')
    ).toHaveTextContent('جزئیات');
  });
});

describe('ProductionReportView — server filters', () => {
  it('applies the status filter through the SERVER query', async () => {
    render(<ProductionReportView />);
    await screen.findByTestId('production-report-table');

    await userEvent.selectOptions(
      screen.getByTestId('production-report-status-filter'),
      'APPROVED'
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'APPROVED', page: 1 })
      )
    );
  });

  it('applies the search through the SERVER query on submit', async () => {
    render(<ProductionReportView />);
    await screen.findByTestId('production-report-table');

    await userEvent.type(screen.getByTestId('production-report-search-input'), ' موتور ');
    await userEvent.click(screen.getByTestId('production-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'موتور', page: 1 })
      )
    );
  });

  it('sets the status filter from a summary chip and clears it via «همه»', async () => {
    render(<ProductionReportView />);
    await screen.findByTestId('production-report-table');

    await userEvent.click(screen.getByTestId('production-report-summary-status-DRAFT'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DRAFT' }))
    );

    await userEvent.click(screen.getByTestId('production-report-summary-all'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
    );
  });
});

describe('ProductionReportView — states', () => {
  it('renders the NO-RECORDS state with the filter-scoped message — not an error', async () => {
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: {
        total: 0,
        byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0 },
      },
    });
    render(<ProductionReportView />);

    expect(await screen.findByTestId('production-report-empty')).toBeInTheDocument();
    expect(screen.getByText('برای این فیلترها فهرستی پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByTestId('production-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry — never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<ProductionReportView />);

    const error = await screen.findByTestId('production-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('دریافت گزارش با خطا مواجه شد.');
    expect(screen.queryByTestId('production-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight — no fake figures', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ProductionReportView />);

    expect(screen.getByTestId('production-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The summary strip renders placeholders (aria-hidden bars), never a digit.
    expect(screen.queryByTestId('production-report-summary-all-count')).not.toBeInTheDocument();
  });
});

describe('ProductionReportView — scope protection (no speculative surface)', () => {
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
    // REPORTING-VISUALIZATION-EXPORT legitimised exactly this pair over the report's
    // OWN export routes. Anything beyond them still fails this suite.
    render(<ProductionReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByTestId('production-report-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('production-report-export-docx')).toHaveTextContent('خروجی Word');
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    render(<ProductionReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('production-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت اقلام'
    );
    expect(screen.getByTestId('production-report-chart-count-SUBMITTED')).toHaveTextContent('۱');
  });

  it('owns no write, scheduling or AI affordance — the backend has none', () => {
    const source = codeOf('ProductionReportView.tsx');
    // Export words are HONEST now — the legitimised pair names them.
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

  it('offers no requester-id filter — an actor id has no display contract', () => {
    const source = codeOf('ProductionReportView.tsx');
    expect(source.toLowerCase()).not.toContain('requesteruserid');
  });

  it('offers no Production mutation — the report never approves, rejects, edits or submits', () => {
    const source = codeOf('ProductionReportView.tsx');
    // The register's only navigation is the detail link; the workflow lives in
    // Production's own screens and must not be reachable from here. (`submit`
    // is deliberately NOT a needle: the filter bar's submit button is a form,
    // not a Production transition.)
    for (const needle of ['/admin/production/', 'approve', 'reject']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
