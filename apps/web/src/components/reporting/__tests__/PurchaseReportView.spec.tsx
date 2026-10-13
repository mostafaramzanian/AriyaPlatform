import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PurchaseReportView } from '../PurchaseReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchPurchaseReport, type ReportingPurchasePage } from '@/lib/purchase-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/purchase-report-api', () => ({
  ...jest.requireActual('@/lib/purchase-report-api'),
  fetchPurchaseReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchPurchaseReport as jest.MockedFunction<typeof fetchPurchaseReport>;

/**
 * Phase REPORTING-PURCHASE-REPORT: what the SECOND Reporting workspace actually
 * promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only `status`/`search`, always as a SERVER query, never a
 *     client-side sieve; and no `requesterId` field, because the report refuses
 *     an actor-id filter it could not label honestly.
 *  3. AUTHORIZATION — without `commerce.read` no request is issued.
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

function row(overrides: Partial<ReportingPurchasePage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    documentNumber: 'PR-1404-000123',
    kind: 'PURCHASE_REQUEST',
    status: 'SUBMITTED',
    supplierId: null,
    currency: 'IRR',
    subtotalAmount: null,
    taxAmount: null,
    totalAmount: null,
    lineCount: 2,
    completedAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingPurchasePage {
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
        CANCELLED: 0,
        CLOSED: 0,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['commerce.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('PurchaseReportView — «گزارش وضعیت و چرخه عمر درخواست‌های خرید»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<PurchaseReportView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش وضعیت و چرخه عمر درخواست‌های خرید',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('purchase-report-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the contract filters only', async () => {
    render(<PurchaseReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: undefined,
        search: '',
      })
    );
  });

  it('issues NO request without commerce.read — the gate is a closed door', async () => {
    grant(['commerce.manage']);
    render(<PurchaseReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row()], 7),
      summary: {
        total: 7,
        byStatus: { DRAFT: 2, SUBMITTED: 5, APPROVED: 0, REJECTED: 0, CANCELLED: 0, CLOSED: 0 },
      },
    });
    render(<PurchaseReportView />);

    expect(await screen.findByTestId('purchase-report-summary-all-count')).toHaveTextContent('۷');
    // The API-reported state counts, in Persian digits; states the API left at zero
    // render a real zero — no placeholder, no invented number.
    expect(await screen.findByTestId('purchase-report-summary-count-SUBMITTED')).toHaveTextContent(
      '۵'
    );
    expect(await screen.findByTestId('purchase-report-summary-count-DRAFT')).toHaveTextContent('۲');
    expect(screen.getByTestId('purchase-report-summary-count-CLOSED')).toHaveTextContent('۰');
  });

  it('renders a row with the source status and kind vocabulary', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({
          documentNumber: 'PR-1404-000456',
          status: 'APPROVED',
          totalAmount: '1320.0000',
          lineCount: 3,
        }),
      ])
    );
    render(<PurchaseReportView />);

    expect(await screen.findByTestId('purchase-report-status-APPROVED')).toBeInTheDocument();
    expect(screen.getByTestId('purchase-report-status-APPROVED')).toHaveTextContent('تأییدشده');
    expect(screen.getByText('درخواست خرید')).toBeInTheDocument();
    expect(screen.getByText('PR-1404-000456')).toBeInTheDocument();
  });

  it('renders a dash for an unpriced document — never a zero that claims free items', async () => {
    fetchMock.mockResolvedValue(page([row({ totalAmount: null })]));
    render(<PurchaseReportView />);

    const table = await screen.findByTestId('purchase-report-table');
    expect(table).toHaveTextContent('—');
    expect(table).not.toHaveTextContent('۰٫۰۰۰۰');
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<PurchaseReportView />);

    const link = await screen.findByTestId(
      'purchase-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/purchase-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getByTestId('purchase-report-row-details-11111111-1111-4111-8111-111111111111')
    ).toHaveTextContent('جزئیات');
  });

  it('applies the status filter through the SERVER query', async () => {
    render(<PurchaseReportView />);
    await screen.findByTestId('purchase-report-table');

    await userEvent.selectOptions(screen.getByTestId('purchase-report-status-filter'), 'APPROVED');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'APPROVED', page: 1 })
      )
    );
  });

  it('applies the search through the SERVER query on submit', async () => {
    render(<PurchaseReportView />);
    await screen.findByTestId('purchase-report-table');

    await userEvent.type(screen.getByTestId('purchase-report-search-input'), ' PR-1404 ');
    await userEvent.click(screen.getByTestId('purchase-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'PR-1404', page: 1 })
      )
    );
  });

  it('sets the status filter from a summary chip and clears it via «همه»', async () => {
    render(<PurchaseReportView />);
    await screen.findByTestId('purchase-report-table');

    await userEvent.click(screen.getByTestId('purchase-report-summary-status-DRAFT'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DRAFT' }))
    );

    await userEvent.click(screen.getByTestId('purchase-report-summary-all'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
    );
  });
});

describe('PurchaseReportView — states', () => {
  it('renders the NO-RECORDS state with the filter-scoped message — not an error', async () => {
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: {
        total: 0,
        byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, CLOSED: 0 },
      },
    });
    render(<PurchaseReportView />);

    expect(await screen.findByTestId('purchase-report-empty')).toBeInTheDocument();
    expect(screen.getByText('برای این فیلترها درخواستی پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByTestId('purchase-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry — never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<PurchaseReportView />);

    const error = await screen.findByTestId('purchase-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('دریافت گزارش با خطا مواجه شد.');
    expect(screen.queryByTestId('purchase-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight — no fake figures', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<PurchaseReportView />);

    expect(screen.getByTestId('purchase-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The summary strip renders placeholders (aria-hidden bars), never a digit.
    expect(screen.queryByTestId('purchase-report-summary-all-count')).not.toBeInTheDocument();
  });
});

describe('PurchaseReportView — scope protection (no speculative surface)', () => {
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
    render(<PurchaseReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByTestId('purchase-report-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('purchase-report-export-docx')).toHaveTextContent('خروجی Word');
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    render(<PurchaseReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByTestId('purchase-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت اسناد'
    );
    expect(screen.getByTestId('purchase-report-chart-count-SUBMITTED')).toHaveTextContent('۱');
  });

  it('owns no write, scheduling or AI affordance — the backend has none', () => {
    const source = codeOf('PurchaseReportView.tsx');
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
    const source = codeOf('PurchaseReportView.tsx');
    expect(source.toLowerCase()).not.toContain('requesterid');
  });

  it('offers no Commerce mutation — the report never approves, rejects, edits or closes', () => {
    const source = codeOf('PurchaseReportView.tsx');
    // The register's only navigation is the detail link; the workflow lives in
    // Commerce's own screens and must not be reachable from here. (`submit`
    // is deliberately NOT a needle: the filter bar's submit button is a form,
    // not a Commerce transition.)
    for (const needle of ['/admin/commerce/', 'approve', 'reject']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
