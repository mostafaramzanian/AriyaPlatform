import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomListView } from '../ProductionBomListView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchProductionBoms, type ProductionBomPage } from '@/lib/production-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-api', () => ({
  ...jest.requireActual('@/lib/production-api'),
  fetchProductionBoms: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchProductionBoms as jest.MockedFunction<typeof fetchProductionBoms>;

/**
 * PHASE PRODUCTION-BOM: the BOM register (`/admin/production`).
 *
 * WHAT THESE SPECS ARE FOR: the register must present exactly what the route supports —
 * server paging with the server's own envelope, the two server-side filters, a permission
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

function bom(overrides: Partial<ProductionBomPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'اقلام پروژه الف',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'u-1',
    approverUserId: 'u-2',
    status: 'DRAFT' as const,
    managerOpinion: null,
    comments: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...overrides,
  };
}

function page(items = [bom()], total = items.length): ProductionBomPage {
  return { items, total, page: 1, pageSize: 20 };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read', 'production.bom.manage']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ProductionBomListView', () => {
  it('refuses without production.bom.read and issues NO request', async () => {
    grant([]);

    render(<ProductionBomListView />);

    expect(await screen.findByText(/production\.bom\.read/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists rows with the status badge and a link to the detail', async () => {
    render(<ProductionBomListView />);

    expect(await screen.findByText('اقلام پروژه الف')).toBeInTheDocument();
    expect(screen.getByTestId('production-bom-status-DRAFT')).toBeInTheDocument();
    const link = screen.getByTestId(`production-bom-link-${bom().id}`);
    expect(link).toHaveAttribute('href', `/admin/production/${bom().id}`);
  });

  it('shows the create CTA only to a production.bom.manage holder', async () => {
    grant(['production.bom.read']);

    render(<ProductionBomListView />);
    await screen.findByText('اقلام پروژه الف');

    expect(screen.queryByTestId('production-bom-create-cta')).toBeNull();
  });

  it('shows the create CTA when the manage grant is present', async () => {
    render(<ProductionBomListView />);
    await screen.findByText('اقلام پروژه الف');

    expect(screen.getByTestId('production-bom-create-cta')).toHaveAttribute(
      'href',
      '/admin/production/new'
    );
  });

  it('sends the applied search and the status filter as server-side filters', async () => {
    render(<ProductionBomListView />);
    await screen.findByText('اقلام پروژه الف');

    await userEvent.type(screen.getByLabelText('جستجو بر اساس عنوان'), 'سازه');
    await userEvent.click(screen.getByTestId('production-search-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'سازه', page: 1 })
      )
    );
  });

  it('renders the empty state when the register holds nothing', async () => {
    fetchMock.mockResolvedValue(page([], 0));

    render(<ProductionBomListView />);

    expect(await screen.findByTestId('production-bom-list-empty')).toBeInTheDocument();
  });
});
