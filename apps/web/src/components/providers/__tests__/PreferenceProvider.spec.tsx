import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreferenceProvider, usePreferences } from '../PreferenceProvider';
import { ThemeProvider } from '../ThemeProvider';
import { useAuth } from '../AuthProvider';
import { fetchPreferences, savePreferences, type UserPreferences } from '@/lib/preferences-api';

/**
 * Phase 49K coverage for `PreferenceProvider`.
 *
 * WHAT IS ACTUALLY AT RISK, and therefore what is asserted:
 *
 *  1. NO CROSS-USER LEAK. An in-flight read that resolves after the session ends must be
 *     discarded, otherwise the previous user's preferences land in the next session.
 *  2. NO WRITE WITHOUT A SESSION. `/me/preferences` has no caller to attribute a row to
 *     while anonymous, so controls must work locally and send nothing.
 *  3. NO SILENT DIVERGENCE. A rejected PATCH must roll the UI back, because a control
 *     that keeps a value the server refused lies until the next reload.
 *  4. THE SERVER RESPONSE WINS. It is re-filtered against live RBAC, so a shrinking
 *     favourites list must be adopted rather than merged with the optimistic one.
 *  5. A PATCH CONTAINS ONLY WHAT CHANGED, since an omitted field is left untouched and a
 *     helpfully-completed body would clobber a concurrent edit from another tab.
 */

jest.mock('@/lib/preferences-api', () => ({
  ...jest.requireActual('@/lib/preferences-api'),
  fetchPreferences: jest.fn(),
  savePreferences: jest.fn(),
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked.
jest.mock('../AuthProvider', () => ({
  ...jest.requireActual('../AuthProvider'),
  useAuth: jest.fn(),
}));

const fetchMock = fetchPreferences as jest.MockedFunction<typeof fetchPreferences>;
const saveMock = savePreferences as jest.MockedFunction<typeof savePreferences>;
const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

const SERVER: UserPreferences = {
  theme: 'DARK',
  density: 'COMPACT',
  textScale: 125,
  motion: 'REDUCED',
  sidebarCollapsed: true,
  navFavorites: ['/admin/blog'],
  navRecent: ['/admin'],
  dashboardLayout: [
    { id: 'identity', visible: true },
    { id: 'access', visible: false },
  ],
  customized: true,
  updatedAt: '2026-09-03T10:00:00.000Z',
};

/** Surfaces the pieces of context under test, plus buttons to drive each mutation. */
function Probe() {
  const {
    preferences,
    loading,
    error,
    persisted,
    setDensity,
    toggleSidebar,
    toggleFavorite,
    widgetLayout,
    moveWidget,
    resetWidgetLayout,
  } = usePreferences();

  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? 'none'}</span>
      <span data-testid="persisted">{String(persisted)}</span>
      <span data-testid="density">{preferences.density}</span>
      <span data-testid="collapsed">{String(preferences.sidebarCollapsed)}</span>
      <span data-testid="favorites">{preferences.navFavorites.join(',') || 'empty'}</span>
      <span data-testid="layout">
        {widgetLayout.map((entry) => `${entry.id}:${entry.visible}`).join('|')}
      </span>
      <button type="button" onClick={() => setDensity('COMPACT')}>
        density:compact
      </button>
      <button type="button" onClick={() => setDensity('COMFORTABLE')}>
        density:comfortable
      </button>
      <button type="button" onClick={toggleSidebar}>
        collapse
      </button>
      <button type="button" onClick={() => toggleFavorite('/admin/blog')}>
        favorite
      </button>
      <button type="button" onClick={() => moveWidget('access', -1)}>
        move
      </button>
      <button type="button" onClick={resetWidgetLayout}>
        reset
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <PreferenceProvider>
        <Probe />
      </PreferenceProvider>
    </ThemeProvider>,
  );
}

const root = () => document.documentElement;

describe('PreferenceProvider', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(SERVER);
    saveMock.mockImplementation(async (patch) => ({ ...SERVER, ...patch }) as UserPreferences);
    useAuthMock.mockReturnValue(authState({ isAuthenticated: true }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    for (const attribute of ['data-theme', 'data-density', 'data-text-scale', 'data-motion']) {
      root().removeAttribute(attribute);
    }
  });

  describe('server read', () => {
    it('adopts the server snapshot and paints it onto <html>', async () => {
      renderProvider();

      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('density')).toHaveTextContent('COMPACT');
      expect(screen.getByTestId('collapsed')).toHaveTextContent('true');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(root()).toHaveAttribute('data-text-scale', '125');
      expect(root()).toHaveAttribute('data-motion', 'reduced');
      expect(root()).toHaveAttribute('data-theme', 'dark');
    });

    it('never PATCHes back the theme it just read', async () => {
      renderProvider();

      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

      // `syncThemeChoice` is silent, so reading DARK must not look like a user action.
      // If it emitted, this would be a PATCH that clobbers another tab's change.
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('keeps the pre-paint appearance when the read fails', async () => {
      // Pre-paint cache state, as ThemeScript would have left it.
      root().setAttribute('data-density', 'compact');
      root().setAttribute('data-text-scale', '140');
      fetchMock.mockRejectedValue(new Error('boom'));

      renderProvider();

      await waitFor(() => expect(screen.getByTestId('error')).not.toHaveTextContent('none'));

      // State falls back to defaults, but the DOM is untouched: a failed read must not
      // visibly reset an appearance that was already correct.
      expect(screen.getByTestId('density')).toHaveTextContent('COMFORTABLE');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(root()).toHaveAttribute('data-text-scale', '140');
    });

    it('waits for the session to settle before reading', async () => {
      useAuthMock.mockReturnValue(authState({ isLoading: true }));
      renderProvider();

      // Fetching mid-hydration would 401 a user who is in fact signed in.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('loading')).toHaveTextContent('true');
    });
  });

  describe('anonymous', () => {
    beforeEach(() => {
      useAuthMock.mockReturnValue(authState({ isAuthenticated: false }));
    });

    it('serves defaults without reading or writing', async () => {
      renderProvider();

      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('persisted')).toHaveTextContent('false');
      expect(screen.getByTestId('error')).toHaveTextContent('none');
      expect(screen.getByTestId('density')).toHaveTextContent('COMFORTABLE');
    });

    it('still applies a change locally but sends nothing', async () => {
      const user = userEvent.setup();
      renderProvider();

      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      await user.click(screen.getByRole('button', { name: 'density:compact' }));

      // The control must not be dead — it just has no row to attribute the write to.
      expect(screen.getByTestId('density')).toHaveTextContent('COMPACT');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(saveMock).not.toHaveBeenCalled();
    });
  });

  /*
   * USER ISOLATION.
   *
   * The pre-paint cache is a single shared browser slot: whatever is in it gets painted
   * before anyone knows who is signing in. The owner marker is the only thing standing
   * between one account's appearance and the next account's session, so these assertions
   * are the reason it exists.
   */
  describe('user isolation', () => {
    const OWNER_KEY = 'aria-pref-owner';

    function session(userId: string) {
      return {
        sub: userId,
        userId,
        email: `${userId}@test.local`,
        tokenVersion: 1,
        iat: 0,
        exp: 0,
      };
    }

    function signedInAs(userId: string) {
      useAuthMock.mockReturnValue(
        authState({ isAuthenticated: true, user: session(userId) as never }),
      );
    }

    /** The cache and the document as `ThemeScript` would have left them for `owner`. */
    function cacheOwnedBy(owner: string) {
      window.localStorage.setItem(OWNER_KEY, owner);
      window.localStorage.setItem('aria-theme', 'dark');
      window.localStorage.setItem('aria-density', 'compact');
      window.localStorage.setItem('aria-text-scale', '140');
      window.localStorage.setItem('aria-motion', 'reduced');
      root().setAttribute('data-theme', 'dark');
      root().setAttribute('data-density', 'compact');
      root().setAttribute('data-text-scale', '140');
      root().setAttribute('data-motion', 'reduced');
    }

    it('discards a cached appearance that belongs to another account', async () => {
      cacheOwnedBy('user-a');
      // Never resolves on purpose: what matters is what the ARRIVING user sees BEFORE
      // their own read lands, which is exactly the window the old cache would otherwise
      // still be on screen for — and it lasts forever if the request fails.
      fetchMock.mockReturnValue(new Promise<UserPreferences>(() => {}));
      signedInAs('user-b');

      renderProvider();

      await waitFor(() => expect(root()).toHaveAttribute('data-density', 'comfortable'));
      expect(root()).toHaveAttribute('data-text-scale', '100');
      expect(root()).toHaveAttribute('data-motion', 'system');
      expect(window.localStorage.getItem('aria-theme')).toBe('system');
      // Claimed immediately, not only once the read settles.
      expect(window.localStorage.getItem(OWNER_KEY)).toBe('user-b');
    });

    it('keeps a cached appearance that belongs to the arriving account', async () => {
      cacheOwnedBy('user-a');
      fetchMock.mockReturnValue(new Promise<UserPreferences>(() => {}));
      signedInAs('user-a');

      renderProvider();

      // Same owner, so nothing is reset while the read is in flight. Resetting here would
      // defeat the entire purpose of the pre-paint cache: a visible flash on every reload.
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(root()).toHaveAttribute('data-text-scale', '140');
    });

    it('wipes the cache and repaints defaults on sign-out', async () => {
      signedInAs('user-a');
      const view = renderProvider();

      await waitFor(() => expect(root()).toHaveAttribute('data-density', 'compact'));
      expect(window.localStorage.getItem(OWNER_KEY)).toBe('user-a');

      // Sign out in place, which is what AuthProvider does — the tree is not remounted.
      useAuthMock.mockReturnValue(authState({ isAuthenticated: false }));
      view.rerender(
        <ThemeProvider>
          <PreferenceProvider>
            <Probe />
          </PreferenceProvider>
        </ThemeProvider>,
      );

      // Leaving one account's dark/compact/140% on the login screen of a shared machine is
      // the leak this closes.
      await waitFor(() => expect(root()).toHaveAttribute('data-density', 'comfortable'));
      expect(root()).toHaveAttribute('data-text-scale', '100');
      expect(root()).toHaveAttribute('data-motion', 'system');
      expect(window.localStorage.getItem(OWNER_KEY)).toBeNull();
      expect(window.localStorage.getItem('aria-theme')).toBe('system');
    });

    it('leaves an appearance nobody owns alone', async () => {
      // No owner marker: nothing was ever signed in here, so these values are this
      // browser's own local choice and wiping them would be destroying the user's setting.
      window.localStorage.setItem('aria-density', 'compact');
      root().setAttribute('data-density', 'compact');
      useAuthMock.mockReturnValue(authState({ isAuthenticated: false }));

      renderProvider();

      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      expect(root()).toHaveAttribute('data-density', 'compact');
    });
  });


  describe('optimistic writes', () => {
    async function ready() {
      const user = userEvent.setup();
      renderProvider();
      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      return user;
    }

    /**
     * A PATCH the test settles by hand.
     *
     * `userEvent.click` flushes microtasks, so an already-rejected mock rolls back before
     * control returns — the optimistic phase would be unobservable and the assertion
     * would silently test the post-rollback state instead.
     */
    function gate() {
      let settle!: (value: UserPreferences) => void;
      let fail!: (reason: unknown) => void;
      const promise = new Promise<UserPreferences>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      saveMock.mockReturnValue(promise);
      return { settle, fail };
    }

    it('sends only the changed field', async () => {
      const user = await ready();

      await user.click(screen.getByRole('button', { name: 'collapse' }));

      // An omitted field is left untouched server-side, so a helpfully-completed body
      // would overwrite a concurrent edit from another tab with stale values.
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
      expect(saveMock).toHaveBeenCalledWith({ sidebarCollapsed: false });
    });

    it('adopts the server response over the optimistic value', async () => {
      const user = await ready();
      // RBAC re-filtering dropped the favourite the user just added.
      saveMock.mockResolvedValue({ ...SERVER, navFavorites: [] });

      await user.click(screen.getByRole('button', { name: 'favorite' }));

      // The response is authoritative: a shrinking list must become visible rather than
      // leaving a stale entry that 403s when clicked.
      await waitFor(() => expect(screen.getByTestId('favorites')).toHaveTextContent('empty'));
    });

    it('rolls the value and the document back when the write fails', async () => {
      const user = await ready();
      const patch = gate();

      await user.click(screen.getByRole('button', { name: 'density:comfortable' }));

      // Optimistic phase: applied to state AND the document before the request settles.
      expect(screen.getByTestId('density')).toHaveTextContent('COMFORTABLE');
      expect(root()).toHaveAttribute('data-density', 'comfortable');

      await act(async () => {
        patch.fail(new Error('boom'));
      });

      // Rolled back to the last server-confirmed snapshot, DOM included: a control that
      // keeps a value the server refused lies until the next reload.
      expect(screen.getByTestId('density')).toHaveTextContent('COMPACT');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(screen.getByTestId('error')).not.toHaveTextContent('none');
    });

    it('rolls a failed collapse back without an error banner', async () => {
      const user = await ready();
      const patch = gate();

      await user.click(screen.getByRole('button', { name: 'collapse' }));
      expect(screen.getByTestId('collapsed')).toHaveTextContent('false');

      await act(async () => {
        patch.fail(new Error('boom'));
      });

      // Silent: the rail snapping back IS the feedback. A banner for a layout gesture
      // would be noise on a screen that is otherwise working.
      expect(screen.getByTestId('collapsed')).toHaveTextContent('true');
      expect(screen.getByTestId('error')).toHaveTextContent('none');
    });
  });

  describe('widget layout', () => {
    async function ready() {
      const user = userEvent.setup();
      renderProvider();
      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      return user;
    }

    it('resolves a partial stored layout to the full registry', async () => {
      await ready();

      // The server stored two entries; the other two widgets are appended as visible,
      // so a layout saved before this release still renders everything. (Since 49C-4
      // the registry itself has four ids; layouts that still mention the retired
      // quick-actions/modules ids are DROPPED by the same resolve.)
      expect(screen.getByTestId('layout')).toHaveTextContent(
        'identity:true|access:false|notifications:true|reminders:true',
      );
    });

    it('sends the full resolved layout when a widget moves', async () => {
      const user = await ready();

      await user.click(screen.getByRole('button', { name: 'move' }));

      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
      const patch = saveMock.mock.calls[0][0];
      expect(patch.dashboardLayout?.map((entry) => entry.id)).toEqual([
        'access',
        'identity',
        'notifications',
        'reminders',
      ]);
    });

    it('resets with resetDashboardLayout, never a null layout', async () => {
      const user = await ready();

      await user.click(screen.getByRole('button', { name: 'reset' }));

      // Only SQL NULL is the "never customised" state the server's resolveLayout
      // recognises, and the two fields are mutually exclusive in one request.
      await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ resetDashboardLayout: true }));
      expect(saveMock.mock.calls[0][0]).not.toHaveProperty('dashboardLayout');
    });
  });

  describe('usePreferences outside the provider', () => {
    it('throws instead of silently forgetting', () => {
      // A silent fallback would be a second, unpersisted copy of the state — exactly
      // the N1 bug this provider exists to remove.
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(() => render(<Probe />)).toThrow(/usePreferences must be used inside/);

      consoleError.mockRestore();
    });
  });
});
