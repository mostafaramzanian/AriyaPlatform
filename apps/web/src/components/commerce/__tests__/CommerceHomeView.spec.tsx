import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceHomeView } from '../CommerceHomeView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchCommercePurchaseDocuments, type CommercePurchaseQuery } from '@/lib/commerce-api';
import { purchaseDocument, purchasePage } from './commerce-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommercePurchaseDocuments: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchCommercePurchaseDocuments as jest.MockedFunction<
  typeof fetchCommercePurchaseDocuments
>;

/**
 * PHASE UI-1: the module home (`/admin/commerce`).
 *
 * THE CLAIMS WORTH PINNING are the ones only this screen can get wrong: that every counter
 * is the SERVER's `total` (never arithmetic over the rows it received — the fixture returns
 * 2 rows and a total of 30 precisely so the difference is visible), that a missing grant
 * issues NO request at all, and that the task shortcut appears only with its own grant.
 */
const fa = (value: number) => value.toLocaleString('fa-IR');

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

/** The register read, answered per query — each branch carries its OWN server total. */
function answerRegister() {
  fetchMock.mockImplementation(async (query: CommercePurchaseQuery = {}) => {
    if (query.status === 'SUBMITTED') return purchasePage([], 4);
    if (query.status === 'DRAFT') return purchasePage([], 2);
    return purchasePage(
      [purchaseDocument(), purchaseDocument({ id: 'doc-2', documentNumber: 'PR-1405-0002' })],
      30
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['commerce.read']);
  authMock.mockReturnValue(authState());
  answerRegister();
});

describe('CommerceHomeView', () => {
  it('holds the screen in an accessible loading state until the grants are known', () => {
    grant(['commerce.read'], true);

    render(<CommerceHomeView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-home')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without commerce.read and issues NO request', async () => {
    grant([]);

    render(<CommerceHomeView />);

    expect(await screen.findByText(/commerce\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-home')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the SERVER totals, never arithmetic over the returned rows', async () => {
    render(<CommerceHomeView />);

    await screen.findByTestId('commerce-home');

    // 2 rows were returned; the counters must repeat the totals (30 / 4 / 2) instead.
    expect(screen.getByTestId('commerce-count-all')).toHaveTextContent(fa(30));
    expect(screen.getByTestId('commerce-count-submitted')).toHaveTextContent(fa(4));
    expect(screen.getByTestId('commerce-count-my-drafts')).toHaveTextContent(fa(2));
    expect(screen.getAllByTestId(/^commerce-home-latest-PR-/)).toHaveLength(2);
  });

  it('reads the latest five rows and the two attention totals from the register', async () => {
    render(<CommerceHomeView />);

    await screen.findByTestId('commerce-home');

    const queries = fetchMock.mock.calls.map(([query]) => query);
    expect(queries).toContainEqual({ page: 1, pageSize: 5 });
    expect(queries).toContainEqual({ page: 1, pageSize: 1, status: 'SUBMITTED' });
    expect(queries).toContainEqual({
      page: 1,
      pageSize: 1,
      status: 'DRAFT',
      requesterId: 'u-1',
    });
  });

  it('never claims a personal draft count for a session without a user id', async () => {
    authMock.mockReturnValue(authState(null));

    render(<CommerceHomeView />);

    // No session means no read at all — and certainly not a read scoped to somebody.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('commerce-count-my-drafts')).not.toBeInTheDocument();
  });

  it('states the register as the primary route, and keeps the create CTA behind commerce.manage', async () => {
    render(<CommerceHomeView />);

    await screen.findByTestId('commerce-home');

    expect(screen.getByTestId('commerce-home-cta-register')).toHaveAttribute(
      'href',
      '/admin/commerce/purchases'
    );
    expect(screen.getByTestId('commerce-area-purchases')).toHaveAttribute(
      'href',
      '/admin/commerce/purchases'
    );
    // The default grant set here has no commerce.manage: the create CTA stays hidden.
    expect(screen.queryByTestId('commerce-home-cta-create')).not.toBeInTheDocument();
  });

  it('shows the create CTA into the real route for a commerce.manage holder', async () => {
    grant(['commerce.read', 'commerce.manage']);

    render(<CommerceHomeView />);

    expect(await screen.findByTestId('commerce-home-cta-create')).toHaveAttribute(
      'href',
      '/admin/commerce/purchases/new'
    );
  });

  it('shows the task shortcut only with commerce.approve', async () => {
    render(<CommerceHomeView />);
    await screen.findByTestId('commerce-home');
    expect(screen.queryByTestId('commerce-area-tasks')).not.toBeInTheDocument();

    grant(['commerce.read', 'commerce.approve']);
    render(<CommerceHomeView />);
    const tasksLinks = await screen.findAllByTestId('commerce-area-tasks');
    // Only the second render carries the shortcut — the first one had no approval grant.
    expect(tasksLinks).toHaveLength(1);
    expect(tasksLinks[0]).toHaveAttribute('href', '/admin/commerce/tasks');
  });

  it('renders the shared empty state when the register has no rows', async () => {
    fetchMock.mockImplementation(async () => purchasePage([], 0));

    render(<CommerceHomeView />);

    expect(await screen.findByText('هنوز درخواست خریدی ثبت نشده است.')).toBeInTheDocument();
  });

  it('surfaces a read failure through CoreError and retries the same read', async () => {
    fetchMock.mockRejectedValueOnce(new Error('شبکه در دسترس نیست'));

    render(<CommerceHomeView />);

    expect(await screen.findByText('شبکه در دسترس نیست')).toBeInTheDocument();

    answerRegister();
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('commerce-home')).toBeInTheDocument();
  });
});
