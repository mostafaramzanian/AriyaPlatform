import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreShell } from '../CoreShell';
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

jest.mock('@/lib/rbac-api', () => ({
  fetchMyRbac: jest.fn(),
}));

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMyRbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;

const logout = jest.fn().mockResolvedValue(undefined);

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    login: jest.fn(),
    logout,
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function authenticated(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return authState({
    isAuthenticated: true,
    user: {
      sub: 'user-1',
      userId: 'user-1',
      email: 'admin@test.local',
      tokenVersion: 1,
      iat: 0,
      exp: 0,
    },
    ...overrides,
  });
}

const role = {
  id: 'r1',
  name: 'SUPER_ADMIN',
  displayName: 'مدیر ارشد',
  description: null,
  hierarchy: 0,
};

function rbac(permissions: string[]) {
  return { userId: 'user-1', roles: [role], permissions, highestRole: role };
}

function renderShell() {
  return render(
    <CoreShell>
      <p>محتوا</p>
    </CoreShell>,
  );
}

describe('CoreShell', () => {
  beforeEach(() => {
    fetchMyRbacMock.mockResolvedValue(rbac(['blog.read']));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state while the session resolves', () => {
    useAuthMock.mockReturnValue(authState({ isLoading: true }));
    renderShell();

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText('محتوا')).not.toBeInTheDocument();
  });

  it('redirects unauthenticated users to /login and hides content', async () => {
    useAuthMock.mockReturnValue(authState());
    renderShell();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('محتوا')).not.toBeInTheDocument();
  });

  it('renders header, sidebar, identity and children when authenticated', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    expect(await screen.findByTestId('core-sidebar')).toBeInTheDocument();
    expect(screen.getByText('محتوا')).toBeInTheDocument();
    expect(screen.getByText('admin@test.local')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('derives the page title from the active route', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('وبلاگ');
  });

  it('marks the active route with aria-current', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    const blogLink = await screen.findByRole('link', { name: 'وبلاگ' });
    expect(blogLink).toHaveAttribute('href', '/admin/blog');
    expect(blogLink).toHaveAttribute('aria-current', 'page');
  });

  it('hides permission-gated navigation when the permission is absent', async () => {
    useAuthMock.mockReturnValue(authenticated());
    fetchMyRbacMock.mockResolvedValue(rbac([]));
    renderShell();

    // Always-visible Core entries remain.
    expect(await screen.findByRole('link', { name: 'خانه' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'وبلاگ' })).not.toBeInTheDocument(),
    );
  });

  it('keeps gated navigation visible when the permission read fails', async () => {
    useAuthMock.mockReturnValue(authenticated());
    fetchMyRbacMock.mockRejectedValue(new Error('boom'));
    renderShell();

    expect(await screen.findByRole('link', { name: 'وبلاگ' })).toBeInTheDocument();
  });

  it('logs out through AuthProvider and returns to /login', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole('button', { name: /admin@test.local/ }));
    await user.click(await screen.findByRole('menuitem', { name: /خروج/ }));

    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });

  it('keeps the mobile drawer mounted but inert until it is opened', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const drawer = await screen.findByTestId('core-mobile-drawer');
    const overlay = screen.getByTestId('core-mobile-overlay');
    const panel = screen.getByTestId('core-mobile-drawer-panel');

    // Closed: hidden, non-interactive, parked fully off-screen to the right.
    expect(drawer).toHaveAttribute('data-state', 'closed');
    expect(drawer).toHaveClass('invisible', 'pointer-events-none');
    expect(overlay).toHaveClass('opacity-0', 'pointer-events-none');
    expect(panel).toHaveClass('translate-x-full');
    // Content behind the closed drawer stays reachable.
    expect(screen.getByText('محتوا')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'نمایش منو' }));

    // Open: visible, overlay opaque and clickable, panel slid in from the right.
    expect(drawer).toHaveAttribute('data-state', 'open');
    expect(drawer).toHaveClass('visible');
    expect(drawer).not.toHaveClass('invisible');
    expect(overlay).toHaveClass('opacity-100');
    expect(overlay).not.toHaveClass('opacity-0');
    expect(panel).toHaveClass('translate-x-0');
    expect(panel).not.toHaveClass('translate-x-full');
    expect(screen.getByTestId('core-sidebar-drawer')).toBeInTheDocument();

    await user.click(overlay);

    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'));
    expect(drawer).toHaveClass('invisible', 'pointer-events-none');
    expect(panel).toHaveClass('translate-x-full');
    // Content is interactive again once the layer is inert.
    expect(screen.getByText('محتوا')).toBeInTheDocument();
  });

  it('closes the mobile drawer from its own close control', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const drawer = await screen.findByTestId('core-mobile-drawer');
    await user.click(screen.getByRole('button', { name: 'نمایش منو' }));
    expect(drawer).toHaveAttribute('data-state', 'open');

    await user.click(screen.getByTestId('core-drawer-close'));
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'));
  });

  /*
   * The browser run caught this: `h-10 w-10` is a rem box, so at a 140% text scale the
   * trigger grew to 56px tall but was squeezed to 28px wide as a shrinkable flex item
   * beside the page title — under the 44px WCAG 2.5.8 minimum in exactly the large-text,
   * narrow-viewport case that needs it most. jsdom cannot measure it, so the class that
   * guarantees it is asserted instead.
   */
  it('never lets the mobile nav trigger be squeezed below its touch target', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    const opener = await screen.findByRole('button', { name: 'نمایش منو' });
    expect(opener).toHaveClass('h-10', 'w-10', 'shrink-0');
  });

  /*
   * X6. The drawer stays MOUNTED so it can slide, which is exactly why focus has to be
   * managed by hand: nothing about mounting or unmounting tells the browser that a layer
   * covering the page just appeared.
   */
  it('moves focus into the drawer on open, and Escape closes it and restores focus', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const opener = await screen.findByRole('button', { name: 'نمایش منو' });
    await user.click(opener);

    const drawer = screen.getByTestId('core-mobile-drawer');
    const panel = screen.getByTestId('core-mobile-drawer-panel');

    // Focus is inside the panel, on its first focusable element — not left behind on the
    // hamburger, which is now underneath an overlay.
    const firstFocusable = panel.querySelector<HTMLElement>('a[href], button:not([disabled])');
    expect(firstFocusable).not.toBeNull();
    expect(firstFocusable).toHaveFocus();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'));
    // Restored, so the next Tab continues from where the user was rather than from the top
    // of the document — and no element keeps focus inside a hidden subtree.
    expect(opener).toHaveFocus();
  });

  it('confines Tab to the drawer panel while it is open', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole('button', { name: 'نمایش منو' }));

    const panel = screen.getByTestId('core-mobile-drawer-panel');
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    expect(focusables.length).toBeGreaterThan(1);

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    await user.tab();
    // Wrapped back to the top of the panel instead of walking into the page behind the
    // overlay, which is unusable while the drawer is up.
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });



  it('renders the mobile drawer sidebar always expanded', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole('button', { name: 'نمایش منو' }));

    const drawerSidebar = screen.getByTestId('core-sidebar-drawer');
    expect(drawerSidebar).toHaveAttribute('data-variant', 'drawer');
    expect(drawerSidebar).toHaveAttribute('data-collapsed', 'false');
  });

  it('collapses and expands the persistent sidebar without state drift', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const rail = () => screen.getByTestId('core-sidebar');

    await screen.findByTestId('core-sidebar');
    expect(rail()).toHaveAttribute('data-collapsed', 'false');

    // Expanded rail: the control offers the collapse ACTION.
    const collapseButton = within(rail()).getByTestId('core-collapse-toggle');
    expect(collapseButton).toHaveAttribute('data-action', 'collapse');
    expect(collapseButton).toHaveAttribute('aria-label', 'بستن منو');
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapseButton);
    expect(rail()).toHaveAttribute('data-collapsed', 'true');

    // Collapsed rail: the control now offers the expand ACTION.
    const expandButton = within(rail()).getByTestId('core-collapse-toggle');
    expect(expandButton).toHaveAttribute('data-action', 'expand');
    expect(expandButton).toHaveAttribute('aria-label', 'باز کردن منو');
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(expandButton);
    expect(rail()).toHaveAttribute('data-collapsed', 'false');

    // Repeated toggling returns to the exact original state.
    await user.click(within(rail()).getByTestId('core-collapse-toggle'));
    await user.click(within(rail()).getByTestId('core-collapse-toggle'));
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
    expect(within(rail()).getByTestId('core-collapse-toggle')).toHaveAttribute(
      'data-action',
      'collapse',
    );
  });

  it('toggles the persistent sidebar with Enter and Space', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const rail = () => screen.getByTestId('core-sidebar');

    await screen.findByTestId('core-sidebar');

    within(rail()).getByTestId('core-collapse-toggle').focus();
    await user.keyboard('{Enter}');
    expect(rail()).toHaveAttribute('data-collapsed', 'true');

    within(rail()).getByTestId('core-collapse-toggle').focus();
    await user.keyboard(' ');
    expect(rail()).toHaveAttribute('data-collapsed', 'false');
  });

  it('anchors the active indicator to the right edge of the item', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    const blogLink = await screen.findByRole('link', { name: 'وبلاگ' });
    // X4: the indicator is a child of the ROW, not of the link — the link no longer wraps
    // the whole row, so that the star and the chevron are not nested inside an anchor.
    const row = blogLink.closest('[data-testid="core-nav-item"]');
    expect(row).not.toBeNull();
    const indicator = row!.querySelector('[data-testid="core-nav-active-indicator"]');
    expect(blogLink.querySelector('[data-testid="core-nav-active-indicator"]')).toBeNull();

    expect(indicator).not.toBeNull();
    // `start-0` is the right edge under dir="rtl"; `end-0` would be the left one.
    expect(indicator).toHaveClass('start-0');
    expect(indicator).not.toHaveClass('end-0');
  });

  it('keeps the active indicator on the right edge while collapsed', async () => {
    useAuthMock.mockReturnValue(authenticated());
    const user = userEvent.setup();
    renderShell();

    const rail = () => screen.getByTestId('core-sidebar');

    await screen.findByTestId('core-sidebar');
    await user.click(within(rail()).getByTestId('core-collapse-toggle'));
    expect(rail()).toHaveAttribute('data-collapsed', 'true');

    const indicator = within(rail()).getByTestId('core-nav-active-indicator');
    expect(indicator).toHaveClass('start-0');
    expect(indicator).not.toHaveClass('end-0');
  });

  it('never renders an expand affordance on leaf navigation items', async () => {
    useAuthMock.mockReturnValue(authenticated());
    renderShell();

    // Leaf entries (data-expandable="false") must never carry a toggle button or an
    // aria-expanded; entries that declare children (data-expandable="true") must
    // carry a real BUTTON toggle that owns aria-expanded (Phase 50-LOVABLE-PARITY /
    // 50-CORRECTION: مکاتبات is the first intentional expandable group in the rail).
    await screen.findByRole('link', { name: 'وبلاگ' });

    const items = screen.getAllByTestId('core-nav-item');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const expandable = item.getAttribute('data-expandable') === 'true';
      const toggles = within(item).queryAllByTestId('core-nav-toggle');
      if (!expandable) {
        expect(item).not.toHaveAttribute('aria-expanded');
        expect(toggles).toHaveLength(0);
      } else {
        expect(toggles.length).toBeGreaterThan(0);
        expect(toggles[0].tagName).toBe('BUTTON');
        expect(toggles[0]).toHaveAttribute('aria-expanded');
      }
    }

    // Exactly the expandable groups own toggle buttons — no leaf ever does.
    const expandableCount = items.filter(
      (item) => item.getAttribute('data-expandable') === 'true',
    ).length;
    expect(screen.queryAllByTestId('core-nav-toggle')).toHaveLength(expandableCount);
  });
});

