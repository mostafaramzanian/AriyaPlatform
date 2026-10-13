import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckRequestListView } from '../CheckRequestListView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchFinancialCheckRequests, type FinancialCheckRequestPage } from '@/lib/financial-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/financial-api', () => ({
  ...jest.requireActual('@/lib/financial-api'),
  fetchFinancialCheckRequests: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchFinancialCheckRequests as jest.MockedFunction<
  typeof fetchFinancialCheckRequests
>;

/**
 * Phase F1 — FINANCIAL FOUNDATION: the register (`/admin/financial/check-requests`).
 *
 * WHAT THESE SPECS PIN: the register presents exactly what the route supports (server
 * paging with the server's envelope, the two server-side filters), the permission gate
 * issues NO request without `financial.check.read`, the create CTA exists only for a
 * `financial.check.manage` holder, the empty and error states are distinct, and a row
 * links to its detail. A regression on any of those is a screen that lies about itself.
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

function request(overrides: Partial<FinancialCheckRequestPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'صدور چک برای خرید غیر پروژه ای',
    checkIssueType: 'PURCHASE' as const,
    purchaseType: 'NON_PROJECT' as const,
    orderReference: 'ORDER-1',
    projectReference: null,
    projectManagerUserId: null,
    requesterUserId: 'u-1',
    requestDate: '2026-10-03T08:00:00.000Z',
    requesterOpinion: 'CONTINUE' as const,
    status: 0,
    managerDecision: null,
    managerComment: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  };
}

function page(items = [request()], total = items.length): FinancialCheckRequestPage {
  return { items, total, page: 1, pageSize: 20 };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['financial.check.read', 'financial.check.manage']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('Phase F1 — CheckRequestListView', () => {
  it('fetches with the page window and renders a row linking to the detail', async () => {
    render(<CheckRequestListView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        search: '',
        status: undefined,
      })
    );

    const link = await screen.findByTestId(
      'financial-check-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/financial/check-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(screen.getByTestId('financial-check-status-0')).toBeInTheDocument();
  });

  it('issues NO request without financial.check.read — the gate is a closed door', async () => {
    grant(['financial.check.manage']);
    render(<CheckRequestListView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the create CTA only to a manage holder', async () => {
    grant(['financial.check.read']);
    const { unmount } = render(<CheckRequestListView />);
    await screen.findByTestId('financial-check-list-table');
    expect(screen.queryByTestId('financial-check-new')).not.toBeInTheDocument();
    unmount();

    grant(['financial.check.read', 'financial.check.manage']);
    render(<CheckRequestListView />);
    expect(await screen.findByTestId('financial-check-new')).toBeInTheDocument();
  });

  it('renders the EMPTY state with no rows — and not the error state', async () => {
    fetchMock.mockResolvedValue(page([], 0));
    render(<CheckRequestListView />);

    expect(await screen.findByTestId('financial-check-list-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-list-error')).not.toBeInTheDocument();
  });

  it('renders the error state with retry, keeping the filters intact', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<CheckRequestListView />);

    const error = await screen.findByTestId('financial-check-list-error');
    expect(error).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies the status filter through the SERVER query, not a client-side sieve', async () => {
    render(<CheckRequestListView />);
    await screen.findByTestId('financial-check-list-table');

    await userEvent.selectOptions(screen.getByTestId('financial-check-status-filter'), '2');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 2, page: 1 }))
    );
  });
});
