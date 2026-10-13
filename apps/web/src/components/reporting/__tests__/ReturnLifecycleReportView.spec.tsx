import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReturnLifecycleReportView } from '../ReturnLifecycleReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchReturnLifecycleReport,
  type ReportingReturnLifecyclePage,
} from '@/lib/return-lifecycle-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/return-lifecycle-report-api', () => ({
  ...jest.requireActual('@/lib/return-lifecycle-report-api'),
  fetchReturnLifecycleReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchReturnLifecycleReport as jest.MockedFunction<
  typeof fetchReturnLifecycleReport
>;

/** The NINTH workspace's promises: identity, server-only filters, the read gate,
 *  summary honesty, distinct states, the source's five-word vocabulary, and a
 *  read-only scope (exports exist; no write affordance does). */
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

function row(
  overrides: Partial<ReportingReturnLifecyclePage['items'][number]> = {}
): ReportingReturnLifecyclePage['items'][number] {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
    purchaseDocumentNumber: 'PR-1404-000123',
    state: 'APPROVED' as const,
    reason: 'کالای معیوب',
    replacementRequired: false,
    lineCount: 1,
    createdAt: '2026-01-05T08:00:00.000Z',
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingReturnLifecyclePage {
  const count = (state: string) => items.filter((item) => item.state === state).length;
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: {
      total,
      byState: {
        REQUESTED: count('REQUESTED'),
        APPROVED: count('APPROVED'),
        RECEIVED_BACK: count('RECEIVED_BACK'),
        REFUNDED: count('REFUNDED'),
        REJECTED: count('REJECTED'),
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockReturnValue(authState());
  grant(['commerce.read']);
  fetchMock.mockResolvedValue(page());
});

describe('ReturnLifecycleReportView — the ninth Reporting workspace', () => {
  it('names the report under the page heading — no h1 of its own', async () => {
    render(<ReturnLifecycleReportView />);

    expect(await screen.findByText('گزارش چرخه حیات مرجوعی‌های بازرگانی')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('fetches with the report query — page, window, and no client-only filter', async () => {
    render(<ReturnLifecycleReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        state: undefined,
        search: '',
        createdFrom: undefined,
        createdTo: undefined,
      })
    );
  });

  it('issues NO request without commerce.read — the gate is a closed door', async () => {
    grant(['commerce.manage']);
    render(<ReturnLifecycleReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row(), row({ id: '44444444-4444-4444-8444-444444444444' })], 7),
      summary: {
        total: 7,
        byState: { REQUESTED: 3, APPROVED: 2, RECEIVED_BACK: 1, REFUNDED: 1, REJECTED: 0 },
      },
    });
    render(<ReturnLifecycleReportView />);

    expect(
      await screen.findByTestId('return-lifecycle-report-summary-all-count')
    ).toHaveTextContent('۷');
    expect(
      await screen.findByTestId('return-lifecycle-report-summary-count-REQUESTED')
    ).toHaveTextContent('۳');
    expect(screen.getByTestId('return-lifecycle-report-summary-count-REJECTED')).toHaveTextContent(
      '۰'
    );
  });

  it('renders a row with the source lifecycle vocabulary — one word per state', async () => {
    fetchMock.mockResolvedValue(
      page([row({ purchaseDocumentNumber: 'PR-1404-000456', state: 'RECEIVED_BACK' })])
    );
    render(<ReturnLifecycleReportView />);

    expect(
      await screen.findByTestId('return-lifecycle-report-state-RECEIVED_BACK')
    ).toHaveTextContent('کالا برگشت خورد');
    expect(screen.getByText('PR-1404-000456')).toBeInTheDocument();
    expect(screen.getByText('کالای معیوب')).toBeInTheDocument();
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<ReturnLifecycleReportView />);

    const link = await screen.findByTestId(
      'return-lifecycle-report-row-details-22222222-2222-4222-8222-222222222222'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/commerce/return-lifecycle/22222222-2222-4222-8222-222222222222'
    );
  });

  it('sends the picked days as the contract half-open window — next-day exclusive end', async () => {
    render(<ReturnLifecycleReportView />);

    await screen.findByTestId('return-lifecycle-report-table');

    const user = userEvent.setup();
    await user.type(screen.getByTestId('return-lifecycle-report-from-input'), '2026-01-05');
    await user.type(screen.getByTestId('return-lifecycle-report-to-input'), '2026-01-05');
    await user.click(screen.getByTestId('return-lifecycle-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          createdFrom: '2026-01-05T00:00:00.000Z',
          createdTo: '2026-01-06T00:00:00.000Z',
        })
      )
    );
  });

  it('sends the state select as a SERVER query — never a client-side sieve', async () => {
    render(<ReturnLifecycleReportView />);

    await screen.findByTestId('return-lifecycle-report-table');
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByTestId('return-lifecycle-report-state-filter'),
      'REJECTED'
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'REJECTED' }))
    );
  });

  it('renders an empty state for an empty population — never a zero axis', async () => {
    fetchMock.mockResolvedValue(page([], 0));
    render(<ReturnLifecycleReportView />);

    expect(await screen.findByTestId('return-lifecycle-report-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('return-lifecycle-report-table')).not.toBeInTheDocument();
  });
});
