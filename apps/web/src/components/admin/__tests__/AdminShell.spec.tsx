import { render, screen, waitFor } from '@testing-library/react';
import { AdminShell } from '../AdminShell';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchMyRbac } from '@/lib/rbac-api';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => '/admin/blog',
}));

// SWC-compiled ES module exports are non-configurable, so the modules are
// mocked instead of spied on.
jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMyRbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    login: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

/**
 * Phase 49B: AdminShell is now a thin wrapper over CoreShell. These tests cover
 * the CMS regression surface only; shell behaviour is covered in
 * components/core/__tests__/CoreShell.spec.tsx.
 */
describe('AdminShell', () => {
  beforeEach(() => {
    fetchMyRbacMock.mockResolvedValue({
      userId: 'user-1',
      roles: [],
      permissions: ['blog.read'],
      highestRole: null,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows a loading state while the session is resolving', () => {
    useAuthMock.mockReturnValue(authState({ isLoading: true }));

    render(
      <AdminShell>
        <p>محتوا</p>
      </AdminShell>,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated users to /login', async () => {
    useAuthMock.mockReturnValue(authState());

    render(
      <AdminShell>
        <p>محتوا</p>
      </AdminShell>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('محتوا')).not.toBeInTheDocument();
  });

  it('keeps rendering the CMS route, the email and the children', async () => {
    useAuthMock.mockReturnValue(
      authState({
        isAuthenticated: true,
        user: {
          sub: 'user-1',
          userId: 'user-1',
          email: 'admin@test.local',
          tokenVersion: 1,
          iat: 0,
          exp: 0,
        },
      }),
    );

    render(
      <AdminShell>
        <p>محتوا</p>
      </AdminShell>,
    );

    expect(await screen.findByText('admin@test.local')).toBeInTheDocument();
    expect(screen.getByText('محتوا')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /وبلاگ/ })).toHaveAttribute('href', '/admin/blog');
    expect(replace).not.toHaveBeenCalled();
  });
});
