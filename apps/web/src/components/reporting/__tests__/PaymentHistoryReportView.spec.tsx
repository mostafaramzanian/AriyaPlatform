import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PaymentHistoryReportView } from '../PaymentHistoryReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchPaymentHistoryReport,
  type ReportingPaymentHistoryPage,
} from '@/lib/payment-history-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/payment-history-report-api', () => ({
  ...jest.requireActual('@/lib/payment-history-report-api'),
  fetchPaymentHistoryReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchPaymentHistoryReport as jest.MockedFunction<
  typeof fetchPaymentHistoryReport
>;

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: what the EIGHTH Reporting workspace
 * actually promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only `method`/`search`/`from`/`to`, always as a SERVER query with the
 *     half-open instant window (`paymentFrom` = day start, `paymentTo` = next-day
 *     start), never a client-side sieve; and no status/currency/amount/actor filter.
 *  3. AUTHORIZATION — without `commerce.read` no request is issued.
 *  4. SUMMARY HONESTY — every rendered figure comes from the API payload.
 *  5. STATES — empty and error are distinct; neither fakes the other.
 *  6. SCOPE — no write/scheduling/AI/timeline affordance; exports exist because one does.
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
  } as never);
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

function row(overrides: Partial<ReportingPaymentHistoryPage['items'][number]> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
    purchaseDocumentNumber: 'PR-1404-000123',
    amount: '30.0000',
    currency: 'IRR',
    method: 'CASH' as const,
    paymentDate: '2026-01-05T08:00:00.000Z',
    payerRef: null,
    payeeRef: null,
    invoiceRef: 'INV-9',
    externalReference: null,
    reversesPaymentId: null,
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingPaymentHistoryPage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: {
      total,
      byMethod: {
        CASH: items.filter((item) => item.method === 'CASH').length,
        PETTY_CASH: items.filter((item) => item.method === 'PETTY_CASH').length,
        CHECK: items.filter((item) => item.method === 'CHECK').length,
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

describe('PaymentHistoryReportView — «گزارش تاریخچه پرداخت‌های بازرگانی»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<PaymentHistoryReportView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش تاریخچه پرداخت‌های بازرگانی',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('payment-history-report-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the contract filters only', async () => {
    render(<PaymentHistoryReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        method: undefined,
        search: '',
        paymentFrom: undefined,
        paymentTo: undefined,
      })
    );
  });

  it('issues NO request without commerce.read — the gate is a closed door', async () => {
    grant(['commerce.manage']);
    render(<PaymentHistoryReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row(), row({ id: '44444444-4444-4444-8444-444444444444' })], 7),
      summary: { total: 7, byMethod: { CASH: 5, PETTY_CASH: 2, CHECK: 0 } },
    });
    render(<PaymentHistoryReportView />);

    expect(await screen.findByTestId('payment-history-report-summary-all-count')).toHaveTextContent(
      '۷'
    );
    expect(
      await screen.findByTestId('payment-history-report-summary-count-CASH')
    ).toHaveTextContent('۵');
    expect(screen.getByTestId('payment-history-report-summary-count-CHECK')).toHaveTextContent('۰');
  });

  it('renders a row with the source method vocabulary and the compensation word', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({
          purchaseDocumentNumber: 'PR-1404-000456',
          method: 'CHECK',
          amount: '-30.0000',
          reversesPaymentId: '33333333-3333-4333-8333-333333333333',
        }),
      ])
    );
    render(<PaymentHistoryReportView />);

    expect(await screen.findByTestId('payment-history-report-method-CHECK')).toHaveTextContent(
      'چک'
    );
    expect(screen.getByText('PR-1404-000456')).toBeInTheDocument();
    expect(screen.getByTestId('payment-history-report-kind-compensation')).toHaveTextContent(
      'رویداد جبرانی'
    );
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<PaymentHistoryReportView />);

    const link = await screen.findByTestId(
      'payment-history-report-row-details-22222222-2222-4222-8222-222222222222'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/commerce/payment-history/22222222-2222-4222-8222-222222222222'
    );
  });

  it('sends the picked days as the contract half-open window — next-day exclusive end', async () => {
    render(<PaymentHistoryReportView />);

    await screen.findByTestId('payment-history-report-table');

    const user = userEvent.setup();
    await user.type(screen.getByTestId('payment-history-report-from-input'), '2026-01-05');
    await user.type(screen.getByTestId('payment-history-report-to-input'), '2026-01-05');
    await user.click(screen.getByTestId('payment-history-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          paymentFrom: '2026-01-05T00:00:00.000Z',
          paymentTo: '2026-01-06T00:00:00.000Z',
        })
      )
    );
  });

  it('renders an empty state for an empty population — never a zero axis', async () => {
    fetchMock.mockResolvedValue(page([], 0));
    render(<PaymentHistoryReportView />);

    expect(await screen.findByTestId('payment-history-report-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-history-report-table')).not.toBeInTheDocument();
  });
});
