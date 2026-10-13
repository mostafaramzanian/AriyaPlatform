import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomChangeListView } from '../ProductionBomChangeListView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchProductionBomChangeRequests,
  type ProductionBomChangePage,
} from '@/lib/production-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-api', () => ({
  ...jest.requireActual('@/lib/production-api'),
  fetchProductionBomChangeRequests: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchProductionBomChangeRequests as jest.MockedFunction<
  typeof fetchProductionBomChangeRequests
>;

/**
 * PHASE PRODUCTION-BOM-CHANGE: the change-request register (`/admin/production/changes`).
 *
 * WHAT THESE SPECS ARE FOR: the register must present exactly what the route supports —
 * server paging with the server's own envelope, the four server-side filters, a permission
 * gate that issues NO request without `production.bom.read`, a create CTA shown only to a
 * `production.bom.manage` holder, and a row that links to its detail. A regression on any of
 * those is a screen that lies about what it can do.
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

function change(overrides: Partial<ProductionBomChangePage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    bomId: '44444444-4444-4444-8444-444444444444',
    title: 'تغییر اقلام پروژه الف',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'u-1',
    approverUserId: 'u-2',
    status: 'DRAFT' as const,
    managerOpinion: null,
    notes: null,
    requestDate: '2026-02-01T00:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...overrides,
  };
}

function page(items = [change()], total = items.length): ProductionBomChangePage {
  return { items, total, page: 1, pageSize: 20 };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read', 'production.bom.manage']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ProductionBomChangeListView', () => {
  it('refuses without production.bom.read and issues NO request', async () => {
    grant([]);

    render(<ProductionBomChangeListView />);

    expect(await screen.findByText(/production\.bom\.read/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists rows with the status badge and a link to the detail', async () => {
    render(<ProductionBomChangeListView />);

    expect(await screen.findByText('تغییر اقلام پروژه الف')).toBeInTheDocument();
    expect(screen.getByTestId('production-bom-status-DRAFT')).toBeInTheDocument();
    const link = screen.getByTestId(`production-change-link-${change().id}`);
    expect(link).toHaveAttribute('href', `/admin/production/changes/${change().id}`);
  });

  it('shows the create CTA only to a production.bom.manage holder', async () => {
    grant(['production.bom.read']);

    render(<ProductionBomChangeListView />);
    await screen.findByText('تغییر اقلام پروژه الف');

    expect(screen.queryByTestId('production-change-create-cta')).toBeNull();
  });

  it('shows the create CTA when the manage grant is present', async () => {
    render(<ProductionBomChangeListView />);
    await screen.findByText('تغییر اقلام پروژه الف');

    expect(screen.getByTestId('production-change-create-cta')).toHaveAttribute(
      'href',
      '/admin/production/changes/new'
    );
  });

  it('sends the applied filters as SERVER-side query inputs', async () => {
    render(<ProductionBomChangeListView />);
    await screen.findByText('تغییر اقلام پروژه الف');

    await userEvent.type(screen.getByLabelText('جستجو بر اساس عنوان'), 'سازه');
    await userEvent.type(screen.getByLabelText('پروژه'), '42');
    await userEvent.click(screen.getByTestId('production-change-search-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'سازه', projectRef: '42', page: 1 })
      )
    );
  });

  it('sends the status filter as soon as it changes', async () => {
    render(<ProductionBomChangeListView />);
    await screen.findByText('تغییر اقلام پروژه الف');

    await userEvent.selectOptions(screen.getByLabelText('وضعیت'), 'SUBMITTED');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'SUBMITTED', page: 1 })
      )
    );
  });

  it('renders the empty state when the register holds nothing', async () => {
    fetchMock.mockResolvedValue(page([], 0));

    render(<ProductionBomChangeListView />);

    expect(await screen.findByTestId('production-change-list-empty')).toBeInTheDocument();
  });

  // Regression pin for the retry wiring: `useReloadToken` re-arms loading/cleared in
  // the click handler (the fetch effect no longer resets state in-effect), so a failed
  // load must still be recoverable through the CoreError retry button.
  it('recovers from a failed load through retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    fetchMock.mockResolvedValueOnce(page());

    render(<ProductionBomChangeListView />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId(`production-change-link-${change().id}`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
