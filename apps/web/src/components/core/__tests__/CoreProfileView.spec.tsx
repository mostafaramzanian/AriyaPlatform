import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProfileView } from '../CoreProfileView';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchMyProfile } from '@/lib/users-api';
import { fetchMyRbac } from '@/lib/rbac-api';
import { CoreApiError } from '@/lib/core-http';

const replace = jest.fn();

/** Read at render time (never at factory time), so each test can seed `?tab=`. */
let mockTabParam: string | null = null;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => '/admin/profile',
  useSearchParams: () => new URLSearchParams(mockTabParam === null ? {} : { tab: mockTabParam }),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/users-api', () => ({
  fetchMyProfile: jest.fn(),
  fetchSessions: jest.fn(),
  fetchLoginHistory: jest.fn(),
  updateMyProfile: jest.fn(),
  uploadAvatar: jest.fn(),
  removeAvatar: jest.fn(),
  revokeSession: jest.fn(),
}));
jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMyProfileMock = fetchMyProfile as jest.MockedFunction<typeof fetchMyProfile>;
const fetchMyRbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;

beforeEach(() => {
  mockTabParam = null;
  replace.mockClear();
  (require('@/lib/users-api').fetchSessions as jest.Mock).mockResolvedValue([]);
  (require('@/lib/users-api').fetchLoginHistory as jest.Mock).mockResolvedValue([]);
});

const role = {
  id: 'r1',
  name: 'SUPER_ADMIN',
  displayName: 'مدیر ارشد',
  description: null,
  hierarchy: 0,
};

// Mirrors the verified GET /users/me response shape.
const profile = {
  id: 'super-admin-user',
  email: 'admin@localhost',
  firstName: 'Super',
  lastName: 'Admin',
  status: 'EMPLOYEE',
  emailVerified: true,
  createdAt: '2026-08-25T13:17:37.200Z',
  updatedAt: '2026-08-25T13:17:37.200Z',
  tenantId: null,
};

describe('CoreProfileView', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      error: null,
      isAuthenticated: true,
      login: jest.fn(),
      logout: jest.fn(),
      clearError: jest.fn(),
    } as ReturnType<typeof useAuth>);

    fetchMyRbacMock.mockResolvedValue({
      userId: 'super-admin-user',
      roles: [role],
      permissions: ['blog.read'],
      highestRole: role,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state first', () => {
    fetchMyProfileMock.mockReturnValue(new Promise(() => undefined));
    // Keep /rbac pending too so no state settles outside act().
    fetchMyRbacMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreProfileView />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('reads GET /users/me and renders only returned fields', async () => {
    fetchMyProfileMock.mockResolvedValue(profile);

    render(<CoreProfileView />);

    expect(await screen.findByText('admin@localhost')).toBeInTheDocument();
    expect(fetchMyProfileMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
    expect(screen.getByText('کارمند')).toBeInTheDocument();
    expect(screen.getByText('مدیر ارشد')).toBeInTheDocument();
    // No mutation affordances in a read-only profile.
    expect(screen.queryByRole('button', { name: /ذخیره/ })).not.toBeInTheDocument();
  });

  it('omits fields the contract does not return', async () => {
    fetchMyProfileMock.mockResolvedValue({ id: 'u1', email: 'x@y.z' });

    render(<CoreProfileView />);

    expect(await screen.findByText('x@y.z')).toBeInTheDocument();
    expect(screen.queryByText('نام')).not.toBeInTheDocument();
    expect(screen.queryByText('وضعیت حساب')).not.toBeInTheDocument();
  });

  it('renders an error state with retry', async () => {
    fetchMyProfileMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    fetchMyProfileMock.mockResolvedValueOnce(profile);

    render(<CoreProfileView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    await waitFor(() => expect(screen.getByText('admin@localhost')).toBeInTheDocument());
  });

  it('renders a forbidden state on 403', async () => {
    fetchMyProfileMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreProfileView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
  });
});

/**
 * Phase 49C-1: the former vertical sections are now an accessible tablist.
 * These tests pin the tab semantics, URL-addressable state, panel exclusivity,
 * keyboard interaction and the preserved sessions behaviour.
 */
describe('CoreProfileView account tabs', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      error: null,
      isAuthenticated: true,
      login: jest.fn(),
      logout: jest.fn(),
      clearError: jest.fn(),
    } as ReturnType<typeof useAuth>);

    fetchMyRbacMock.mockResolvedValue({
      userId: 'super-admin-user',
      roles: [role],
      permissions: ['blog.read'],
      highestRole: role,
    });

    fetchMyProfileMock.mockResolvedValue(profile);
  });

  it('renders a tablist with the four real sections, profile selected by default', async () => {
    render(<CoreProfileView />);

    const tablist = await screen.findByRole('tablist', { name: 'بخش‌های حساب' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(within(tablist).getByRole('tab', { name: 'مشخصات حساب' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tablist).getByRole('tab', { name: 'نشست‌های فعال' })).toHaveAttribute('aria-selected', 'false');
    expect(within(tablist).getByRole('tab', { name: 'تاریخچه ورود' })).toHaveAttribute('aria-selected', 'false');
    expect(within(tablist).getByRole('tab', { name: 'ماژول‌های در دسترس' })).toHaveAttribute('aria-selected', 'false');

    // Default panel is the profile one, wired through aria-controls.
    const profileTab = within(tablist).getByRole('tab', { name: 'مشخصات حساب' });
    expect(profileTab).toHaveAttribute('aria-controls', 'account-panel-profile');
    expect(screen.getByRole('tabpanel', { name: /اطلاعات حساب|مشخصات/ })).toBeInTheDocument();
    expect(screen.getByText('admin@localhost')).toBeInTheDocument();
  });

  it('activates the sessions panel on click and updates the URL', async () => {
    const user = userEvent.setup();
    render(<CoreProfileView />);

    await user.click(await screen.findByRole('tab', { name: 'نشست‌های فعال' }));

    expect(screen.getByRole('tab', { name: 'نشست‌های فعال' })).toHaveAttribute('aria-selected', 'true');
    expect(replace).toHaveBeenCalledWith('/admin/profile?tab=sessions', { scroll: false });
    // Only the active panel is mounted.
    expect(screen.queryByText('admin@localhost')).not.toBeInTheDocument();
    expect(screen.getByText('هیچ نشست فعالی ثبت نشده است.')).toBeInTheDocument();
  });

  it('restores the active tab from the URL on refresh', async () => {
    mockTabParam = 'login-history';

    render(<CoreProfileView />);

    expect(await screen.findByRole('tab', { name: 'تاریخچه ورود' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('admin@localhost')).not.toBeInTheDocument();
  });

  it('falls back to the profile tab for an unknown tab param', async () => {
    mockTabParam = 'bogus';

    render(<CoreProfileView />);

    expect(await screen.findByRole('tab', { name: 'مشخصات حساب' })).toHaveAttribute('aria-selected', 'true');
  });

  describe('phase 49C-4: the modules tab', () => {
    it('exists as a semantic tab wired to its panel', async () => {
      render(<CoreProfileView />);

      const tab = await screen.findByRole('tab', { name: 'ماژول‌های در دسترس' });
      expect(tab).toHaveAttribute('aria-controls', 'account-panel-modules');
      expect(tab).toHaveAttribute('aria-selected', 'false');

      await userEvent.setup().click(tab);

      expect(screen.getByRole('tab', { name: 'ماژول‌های در دسترس' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel', { name: 'ماژول‌های در دسترس' })).toHaveAttribute(
        'id',
        'account-panel-modules',
      );
      expect(screen.getByTestId('core-modules-list')).toBeInTheDocument();
    });

    it('is URL-addressable via ?tab=modules', async () => {
      mockTabParam = 'modules';

      render(<CoreProfileView />);

      expect(await screen.findByRole('tab', { name: 'ماژول‌های در دسترس' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByText('admin@localhost')).not.toBeInTheDocument();
      // The moved surface renders through the SAME shared presentation, with the
      // authorised module visible because the mocked RBAC grants blog.read.
      await screen.findByTestId('core-modules-list');
      expect(screen.getByText('وبلاگ')).toBeInTheDocument();
    });

    it('does not offer a module the caller cannot open', async () => {
      fetchMyRbacMock.mockResolvedValue({
        userId: 'super-admin-user',
        roles: [role],
        permissions: [],
        highestRole: role,
      });

      render(<CoreProfileView />);

      const tab = await screen.findByRole('tab', { name: 'ماژول‌های در دسترس' });
      await userEvent.setup().click(tab);

      await screen.findByTestId('core-modules-list');
      await waitFor(() => expect(screen.queryByText('وبلاگ')).not.toBeInTheDocument());
      // Ungated modules are still there, so this is a filter and not an empty card.
      expect(screen.getByText('حساب من')).toBeInTheDocument();
    });

    it('renders the list shell even while RBAC has not answered yet', async () => {
      // While /rbac is pending, enforce=false — the sidebar's own transient-failure
      // rule — so the tab must still render a sane surface, never a crash or a blank
      // card. (The literal empty state is pinned in CoreModulesList.spec.tsx, since
      // the production nav always keeps ungated personal rows.)
      fetchMyRbacMock.mockReturnValue(new Promise(() => undefined));

      render(<CoreProfileView />);

      const tab = await screen.findByRole('tab', { name: 'ماژول‌های در دسترس' });
      await userEvent.setup().click(tab);

      expect(await screen.findByTestId('core-modules-list')).toBeInTheDocument();
    });

    it('keeps keyboard navigation working across all four tabs', async () => {
      const user = userEvent.setup();
      render(<CoreProfileView />);

      const root = document.documentElement;
      const prevDir = root.getAttribute('dir');
      root.setAttribute('dir', 'ltr');
      try {
        await user.click(await screen.findByRole('tab', { name: 'تاریخچه ورود' }));
        await user.keyboard('{ArrowRight}');

        // Forward from the third tab lands on the NEW fourth tab.
        expect(screen.getByRole('tab', { name: 'ماژول‌های در دسترس' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'ماژول‌های در دسترس' })).toHaveFocus();
        expect(screen.getByTestId('core-modules-list')).toBeInTheDocument();
      } finally {
        if (prevDir === null) {
          root.removeAttribute('dir');
        } else {
          root.setAttribute('dir', prevDir);
        }
      }
    });
  });

  it('moves between tabs with arrow keys and visible roving tabindex', async () => {
    const user = userEvent.setup();
    render(<CoreProfileView />);

    const root = document.documentElement;
    const prevDir = root.getAttribute('dir');
    // Pin the direction: the real app is RTL (ArrowLeft moves forward there); jsdom's
    // unset attribute is read as LTR, so ArrowRight is forward here.
    root.setAttribute('dir', 'ltr');
    try {
      // Focus the ACTIVE tab: arrows are handled on the focused tab, and the active
      // one is the only tabbable member of the roving tabindex.
      await user.click(await screen.findByRole('tab', { name: 'مشخصات حساب' }));
      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('tab', { name: 'نشست‌های فعال' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'نشست‌های فعال' })).toHaveFocus();
      expect(screen.getByRole('tab', { name: 'مشخصات حساب' })).toHaveAttribute('tabindex', '-1');
    } finally {
      if (prevDir === null) {
        root.removeAttribute('dir');
      } else {
        root.setAttribute('dir', prevDir);
      }
    }
  });

  it('keeps sessions and revoke inside the sessions tab', async () => {
    const revokeSession = require('@/lib/users-api').revokeSession as jest.Mock;
    revokeSession.mockResolvedValue({ revoked: true, sessionId: 's1' });
    (require('@/lib/users-api').fetchSessions as jest.Mock).mockResolvedValue([
      { id: 's1', createdAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-02T10:00:00.000Z', revoked: false },
    ]);

    const user = userEvent.setup();
    render(<CoreProfileView />);

    await user.click(await screen.findByRole('tab', { name: 'نشست‌های فعال' }));

    expect(screen.getByText(/ایجاد:/)).toBeInTheDocument();
    const revokeButton = screen.getByRole('button', { name: 'لغو نشست' });
    await user.click(revokeButton);

    expect(revokeSession).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.getByText('لغو شده')).toBeInTheDocument());
  });
});
