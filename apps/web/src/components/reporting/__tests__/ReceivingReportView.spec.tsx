import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReceivingReportView } from '../ReceivingReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchReceivingReport,
  type ReportingReceivingPage,
} from '@/lib/receiving-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/receiving-report-api', () => ({
  ...jest.requireActual('@/lib/receiving-report-api'),
  fetchReceivingReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchReceivingReport as jest.MockedFunction<typeof fetchReceivingReport>;

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: what the TENTH Reporting workspace
 * actually promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only `status`/`search`/`from`/`to`, always as a SERVER query with
 *     the half-open instant window (`receivedFrom` = day start, `receivedTo` =
 *     next-day start), never a client-side sieve; and no supplier/warehouse/unit/
 *     quantity filter, no document-level status.
 *  3. AUTHORIZATION — without `commerce.read` no request is issued.
 *  4. SUMMARY HONESTY — every rendered figure comes from the API payload.
 *  5. GRAIN — ONE row = ONE purchase line (the scope gate A ruling), rendered with
 *     the per-line projected status; quantities render as exact decimals.
 *  6. STATES — empty and error are distinct; neither fakes the other.
 *  7. SCOPE — no write/scheduling/AI/timeline affordance; exports exist because one does.
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

function row(overrides: Partial<ReportingReceivingPage['items'][number]> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
    purchaseDocumentNumber: 'PR-1404-000123',
    orderedQuantity: '100.0000',
    receivedQuantity: '40.0000',
    receivingStatus: 'PARTIALLY_RECEIVED' as const,
    receivedAt: '2026-01-05T08:00:00.000Z',
    compensationCount: 1,
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingReceivingPage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: { total, byStatus: {} },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['commerce.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ReceivingReportView — «گزارش وضعیت دریافت‌های بازرگانی»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<ReceivingReportView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش وضعیت دریافت‌های بازرگانی',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('receiving-report-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the contract filters only', async () => {
    render(<ReceivingReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: undefined,
        search: '',
        receivedFrom: undefined,
        receivedTo: undefined,
      })
    );
  });

  it('issues NO request without commerce.read — the gate is a closed door', async () => {
    grant(['commerce.manage']);
    render(<ReceivingReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row(), row({ id: '44444444-4444-4444-8444-444444444444' })], 7),
      summary: {
        total: 7,
        byStatus: { NOT_RECEIVED: 5, PARTIALLY_RECEIVED: 2, FULLY_RECEIVED: 0 },
      },
    });
    render(<ReceivingReportView />);

    expect(await screen.findByTestId('receiving-report-summary-all-count')).toHaveTextContent(
      '۷'
    );
    expect(
      await screen.findByTestId('receiving-report-summary-count-NOT_RECEIVED')
    ).toHaveTextContent('۵');
    expect(screen.getByTestId('receiving-report-summary-count-FULLY_RECEIVED')).toHaveTextContent(
      '۰'
    );
  });

  it('renders one row per purchase line with the projected status and exact quantities', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({
          purchaseDocumentNumber: 'PR-1404-000456',
          receivingStatus: 'FULLY_RECEIVED',
          orderedQuantity: '100.0000',
          receivedQuantity: '100.0000',
          compensationCount: 2,
        }),
      ])
    );
    render(<ReceivingReportView />);

    expect(await screen.findByTestId('receiving-report-status-FULLY_RECEIVED')).toHaveTextContent(
      'دریافت کامل'
    );
    expect(screen.getByText('PR-1404-000456')).toBeInTheDocument();
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<ReceivingReportView />);

    const link = await screen.findByTestId(
      'receiving-report-row-details-33333333-3333-4333-8333-333333333333'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/commerce/receiving/33333333-3333-4333-8333-333333333333'
    );
  });

  it('sends the picked days as the contract half-open window — next-day exclusive end', async () => {
    render(<ReceivingReportView />);

    await screen.findByTestId('receiving-report-table');

    const user = userEvent.setup();
    await user.type(screen.getByTestId('receiving-report-from-input'), '2026-01-05');
    await user.type(screen.getByTestId('receiving-report-to-input'), '2026-01-05');
    await user.click(screen.getByTestId('receiving-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          receivedFrom: '2026-01-05T00:00:00.000Z',
          receivedTo: '2026-01-06T00:00:00.000Z',
        })
      )
    );
  });

  it('renders an empty state for an empty population — never a zero axis', async () => {
    fetchMock.mockResolvedValue(page([], 0));
    render(<ReceivingReportView />);

    expect(await screen.findByTestId('receiving-report-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('receiving-report-table')).not.toBeInTheDocument();
  });
});

