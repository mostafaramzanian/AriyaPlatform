import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreSidebar } from '../CoreSidebar';
import { PreferenceProvider } from '@/components/providers/PreferenceProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  MAX_NAV_FAVORITES,
  fetchPreferences,
  savePreferences,
  type UserPreferences,
} from '@/lib/preferences-api';

/**
 * Phase 49K coverage for the rail's personalization (N2, N3).
 *
 * Mounted over the REAL `PreferenceProvider` with only the HTTP layer mocked, and over
 * the REAL `CORE_NAV` / `visibleNavGroups` — unlike `CoreSidebar.spec.tsx`, which mocks
 * the navigation to exercise the chevron rule. Here the navigation itself is the subject:
 * a favourite is a stored HREF, and the risk is whether that href still resolves to a
 * row the caller may open.
 *
 * WHAT IS ACTUALLY AT RISK:
 *
 *  1. A STORED HREF IS NOT AN ENTITLEMENT. `navFavorites` arrives RBAC-filtered, but the
 *     rail filters again — otherwise a revoked permission leaves a shortcut that lands on
 *     a 403 instead of disappearing.
 *  2. THE SHORTCUTS MUST BE ABOVE THE NAVIGATION. Below four groups they save no clicks,
 *     which was the entire point of N2.
 *  3. RECENT MUST NOT ECHO THE PRESENT. The current page is not a way back to anything,
 *     and a favourite is already pinned one group above.
 *  4. THE STAR MUST NOT NAVIGATE. It is nested inside the row's `<Link>`, so a missing
 *     `preventDefault` turns "pin this" into "leave the page".
 *  5. THE CAP MUST REFUSE VISIBLY. A star that silently does nothing at the twelfth
 *     favourite reads as a broken control.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin',
}));

// The rail renders CoreDateChip; it has its own suite, so its read never resolves here.
jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  getCalendarToday: jest.fn(() => new Promise(() => undefined)),
  getCalendarMonth: jest.fn(() => new Promise(() => undefined)),
}));

jest.mock('@/lib/preferences-api', () => ({
  ...jest.requireActual('@/lib/preferences-api'),
  fetchPreferences: jest.fn(),
  savePreferences: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

const fetchMock = fetchPreferences as jest.MockedFunction<typeof fetchPreferences>;
const saveMock = savePreferences as jest.MockedFunction<typeof savePreferences>;
const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;

/** Every permission the real navigation gates on, so the whole tree is visible. */
const ALL_PERMISSIONS = ['blog.read', 'admin.users.read', 'admin.ai.read'];

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: { userId: 'u-1', email: 'ali@example.com' },
    isLoading: false,
    error: null,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function preferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    theme: 'SYSTEM',
    density: 'COMFORTABLE',
    textScale: 100,
    motion: 'SYSTEM',
    sidebarCollapsed: false,
    navFavorites: [],
    navRecent: [],
    dashboardLayout: [],
    customized: true,
    updatedAt: '2026-09-04T08:00:00.000Z',
    ...overrides,
  };
}

function renderRail(overrides: Partial<React.ComponentProps<typeof CoreSidebar>> = {}) {
  const props: React.ComponentProps<typeof CoreSidebar> = {
    pathname: '/admin',
    permissions: ALL_PERMISSIONS,
    collapsed: false,
    onToggleCollapsed: jest.fn(),
    ...overrides,
  };

  return render(
    <ThemeProvider>
      <PreferenceProvider>
        <CoreSidebar {...props} />
      </PreferenceProvider>
    </ThemeProvider>,
  );
}

const groupIds = () =>
  screen.getAllByTestId('core-nav-group').map((node) => node.getAttribute('data-group-id'));

const group = (id: string) =>
  screen.getAllByTestId('core-nav-group').find((node) => node.getAttribute('data-group-id') === id);

const rowLabels = (id: string) =>
  within(group(id)!)
    .getAllByTestId('core-nav-item')
    .map((node) => node.textContent?.trim());

/** The star inside the FIRST row whose label matches, anywhere in the rail. */
function starFor(label: string) {
  const row = screen
    .getAllByTestId('core-nav-item')
    .find((node) => node.textContent?.includes(label))!;

  return within(row).getByTestId('core-nav-favorite');
}

/** Renders and waits for the preferences read to settle. */
async function ready(overrides: Partial<React.ComponentProps<typeof CoreSidebar>> = {}) {
  const user = userEvent.setup();
  renderRail(overrides);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return user;
}

describe('CoreSidebar personalization', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(authState());
    fetchMock.mockResolvedValue(preferences());
    saveMock.mockImplementation(async (patch) => preferences(patch as Partial<UserPreferences>));
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  describe('favourites (N2)', () => {
    it('renders no extra group when there are none', async () => {
      await ready();

      await waitFor(() => expect(groupIds()).not.toContain('favorites'));
      expect(groupIds()).not.toContain('recent');
      // The static navigation is untouched — EXCEPT the platform settings group,
      // which Phase 49C-2 moved into the Settings Center and dropped from the rail.
      // Phase 50 adds the correspondence group (ungated personal workflow).
      expect(groupIds()).toEqual(['overview', 'content', 'services', 'correspondence']);
    });

    it('pins favourites above the static navigation, in stored order', async () => {
      fetchMock.mockResolvedValue(
        preferences({ navFavorites: ['/admin/calendar', '/admin/notifications'] }),
      );

      await ready();

      await waitFor(() => expect(groupIds()[0]).toBe('favorites'));
      expect(rowLabels('favorites')).toEqual(['تقویم', 'اعلان‌ها']);
    });

    it('drops a favourite the caller may no longer open', async () => {
      // `blog.read` is absent, so `/admin/blog` is not a visible row — and a favourite
      // pointing at it must vanish rather than become a link to a 403.
      fetchMock.mockResolvedValue(preferences({ navFavorites: ['/admin/blog'] }));

      await ready({ permissions: [] });

      expect(groupIds()).not.toContain('favorites');
    });

    it('adds a favourite from the row star and persists just that field', async () => {
      // Phase 49C-3: the star test moved from the «تقویم» row (which left the static
      // rail for its date-chip entry point) to the still-rail-visible «پیام‌ها» row —
      // the row-star behaviour under test is unchanged.
      const user = await ready();

      await waitFor(() => expect(starFor('پیام‌ها')).toHaveAttribute('data-favorite', 'false'));
      await user.click(starFor('پیام‌ها'));

      expect(saveMock).toHaveBeenCalledWith({ navFavorites: ['/admin/messages'] });
      await waitFor(() => expect(groupIds()[0]).toBe('favorites'));
      expect(rowLabels('favorites')).toEqual(['پیام‌ها']);
    });

    it('removes a favourite from the pinned row star', async () => {
      fetchMock.mockResolvedValue(preferences({ navFavorites: ['/admin/calendar'] }));

      const user = await ready();
      await waitFor(() => expect(groupIds()[0]).toBe('favorites'));

      const pinned = within(group('favorites')!).getByTestId('core-nav-favorite');
      expect(pinned).toHaveAttribute('data-favorite', 'true');
      await user.click(pinned);

      expect(saveMock).toHaveBeenCalledWith({ navFavorites: [] });
      await waitFor(() => expect(groupIds()).not.toContain('favorites'));
    });

    it('refuses visibly at the cap instead of doing nothing', async () => {
      // Unresolvable entries still occupy a slot: the cap is about STORED favourites, which
      // is how the server and the provider count them too.
      const stored = ['/admin/calendar'].concat(
        Array.from({ length: MAX_NAV_FAVORITES - 1 }, (_, index) => `/admin/legacy-${index}`),
      );
      fetchMock.mockResolvedValue(preferences({ navFavorites: stored }));

      const user = await ready();

      await waitFor(() =>
        expect(starFor('پیام‌ها')).toHaveAttribute('aria-disabled', 'true'),
      );
      await user.click(starFor('پیام‌ها'));

      expect(saveMock).not.toHaveBeenCalled();
      expect(starFor('پیام‌ها')).toHaveAttribute('data-favorite', 'false');
    });

    it('renders no star on the collapsed rail', async () => {
      await ready({ collapsed: true });

      expect(screen.queryAllByTestId('core-nav-favorite')).toHaveLength(0);
    });

    /*
     * X4. The star is the second control 49K put in a nav row, and until this step both it
     * and the chevron lived INSIDE the row's `<Link>`. A nested interactive control is
     * invalid ARIA: the anchor and the star became one ambiguous target, and the only
     * reason the star worked at all was a hand-written Enter/Space handler.
     */
    it('exposes the star as a real button beside the link, not inside it', async () => {
      const user = await ready();

      // Phase 49C-3: vehicle moved from the «تقویم» row (left the static rail) to the
      // still-rail-visible «پیام‌ها» row; the structure under test is unchanged.
      const row = screen
        .getAllByTestId('core-nav-item')
        .find((node) => node.textContent?.includes('پیام‌ها'))!;
      const link = within(row).getByRole('link');
      const star = within(row).getByTestId('core-nav-favorite');

      expect(link.contains(star)).toBe(false);
      expect(link.querySelector('button')).toBeNull();
      expect(star.tagName).toBe('BUTTON');
      // `aria-pressed` is what makes the star a toggle rather than an action, and it is
      // only meaningful on a control the platform treats as a button.
      expect(star).toHaveAttribute('aria-pressed', 'false');

      // Keyboard activation now comes from the platform. Space, specifically: the removed
      // hand-written handler was the only reason Space used to work on a span.
      star.focus();
      await user.keyboard(' ');

      expect(saveMock).toHaveBeenCalledWith({ navFavorites: ['/admin/messages'] });
    });
  });

  describe('recent pages (N3)', () => {
    it('lists recents, excluding the current page and anything pinned', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          navFavorites: ['/admin/calendar'],
          navRecent: ['/admin', '/admin/calendar', '/admin/messages', '/admin/support'],
        }),
      );

      await ready();

      await waitFor(() => expect(groupIds()).toContain('recent'));
      expect(rowLabels('recent')).toEqual(['پیام‌ها', 'پشتیبانی']);
      // Favourites keep their own group, above.
      expect(groupIds().indexOf('favorites')).toBeLessThan(groupIds().indexOf('recent'));
    });

    it('keeps the list short even when the server stores more', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          navRecent: [
            '/admin/profile',
            '/admin/notifications',
            '/admin/messages',
            '/admin/calendar',
            '/admin/directory',
            '/admin/blog',
            '/admin/support',
          ],
        }),
      );

      await ready();

      await waitFor(() => expect(groupIds()).toContain('recent'));
      // Ten stored entries would push the static navigation off the first screen.
      expect(rowLabels('recent')).toHaveLength(5);
    });

    it('drops a recent entry the caller may no longer open', async () => {
      fetchMock.mockResolvedValue(preferences({ navRecent: ['/admin/blog'] }));

      await ready({ permissions: [] });

      expect(groupIds()).not.toContain('recent');
    });
  });

  /*
   * Phase 49C-3: the personal destinations with dedicated access paths elsewhere
   * (header user menu / header bell / date chip) leave the STATIC rail, but the
   * favourites/recent resolver keeps seeing them — hiding is never deleting.
   * Phase 49C-5: پشتیبانی joins them — its dedicated path is the header user menu's
   * «پشتیبانی» entry (between تنظیمات and خروج), not a Settings tab.
   */
  describe('Phase 49C-3/49C-5: deduplicated static rail', () => {
    it('drops the personal and service destinations that have dedicated access paths', async () => {
      fetchMock.mockResolvedValue(preferences());
      await ready();

      // Static rows are gone…
      expect(screen.queryByRole('link', { name: 'حساب من' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'اعلان‌ها' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'تقویم' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'پشتیبانی' })).toBeNull();
      // …with no empty group and no collateral removal.
      expect(groupIds()).toEqual(['overview', 'content', 'services', 'correspondence']);
      expect(rowLabels('overview')).toEqual(['خانه', 'پیام‌ها', 'دفترچه سازمانی']);
      expect(rowLabels('content')).toEqual(['وبلاگ']);
      // The services group survives with its remaining entry — never an empty header.
      expect(rowLabels('services')).toEqual(['نظرسنجی‌ها']);
    });

    it('still resolves the hidden destinations in favourites and recents', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          navFavorites: ['/admin/calendar'],
          navRecent: ['/admin/profile', '/admin/notifications', '/admin/messages'],
        }),
      );
      await ready();

      await waitFor(() => expect(groupIds()).toContain('recent'));
      expect(rowLabels('favorites')).toEqual(['تقویم']);
      expect(rowLabels('recent')).toEqual(['حساب من', 'اعلان‌ها', 'پیام‌ها']);
    });

    it('still resolves support in favourites and recents after leaving the rail', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          navFavorites: ['/admin/calendar'],
          navRecent: ['/admin/support', '/admin/messages'],
        }),
      );
      await ready();

      await waitFor(() => expect(groupIds()).toContain('recent'));
      expect(rowLabels('favorites')).toEqual(['تقویم']);
      // Support resolves as a recent row even though its static row is gone.
      expect(rowLabels('recent')).toEqual(['پشتیبانی', 'پیام‌ها']);
    });
  });

  describe('without a PreferenceProvider', () => {
    it('renders the pre-49K rail', () => {
      render(
        <CoreSidebar
          pathname="/admin"
          permissions={ALL_PERMISSIONS}
          collapsed={false}
          onToggleCollapsed={jest.fn()}
        />,
      );

      expect(screen.queryAllByTestId('core-nav-favorite')).toHaveLength(0);
      // Phase 49C-2: the platform settings group renders in the Settings Center, not
      // in the rail — the pre-49K fallback rail shows the primary groups, now including
      // the Phase 50 correspondence group.
      expect(groupIds()).toEqual(['overview', 'content', 'services', 'correspondence']);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
