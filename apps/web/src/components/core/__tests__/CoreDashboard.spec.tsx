import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreDashboard } from '../CoreDashboard';
import { CoreWidgetBoundary } from '../CoreWidgetCard';
import { PreferenceProvider } from '@/components/providers/PreferenceProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchPreferences,
  savePreferences,
  type PreferenceLayoutEntry,
  type UserPreferences,
} from '@/lib/preferences-api';
import { fetchMyRbac, type CoreRbacSummary } from '@/lib/rbac-api';
import { listNotifications } from '@/lib/notifications-api';
import { listUpcomingReminders } from '@/lib/calendar-api';
import { WIDGET_IDS, WIDGET_LABELS } from '../core-widgets';

/**
 * Phase 49K coverage for the registry-driven dashboard.
 *
 * Mounted over the REAL `PreferenceProvider` with only the HTTP layer mocked, for the
 * same reason as `CoreAppearanceSettings.spec.tsx`: every risk worth asserting lives in
 * the seam between the stored layout and what the page renders. A mocked
 * `useOptionalPreferences` would assert that the JSX calls a function — not the part
 * that breaks.
 *
 * WHAT IS ACTUALLY AT RISK:
 *
 *  1. THE STORED ORDER MUST BE THE RENDERED ORDER. A page that renders registry order
 *     while the server holds the user's order silently discards a saved choice.
 *  2. A HIDDEN WIDGET MUST NOT RENDER AT ALL — not render-then-hide, which would still
 *     issue its request and still be reachable by a screen reader.
 *  3. HIDING EVERYTHING MUST STAY RECOVERABLE. Without an empty state that names the
 *     control, "hide the last widget" is a one-way door.
 *  4. ONE WIDGET'S FAILURE MUST NOT TAKE THE PAGE. This is the landing page; a single
 *     bad response cannot be allowed to blank it.
 *  5. A LINK THE CALLER CANNOT OPEN MUST NOT BE OFFERED. The pre-49K quick-link card
 *     pointed every user at `/admin/blog`, including users without `blog.read`.
 *  6. NO PROVIDER MUST STILL RENDER. The dashboard is mounted in trees (and tests) that
 *     have no session context.
 */

jest.mock('@/lib/preferences-api', () => ({
  ...jest.requireActual('@/lib/preferences-api'),
  fetchPreferences: jest.fn(),
  savePreferences: jest.fn(),
}));

jest.mock('@/lib/rbac-api', () => ({
  ...jest.requireActual('@/lib/rbac-api'),
  fetchMyRbac: jest.fn(),
}));

// Only the reads are mocked: `isUnread` / `formatNotificationTime` / `formatReminderTime`
// stay real, so the row markup is exercised rather than stubbed.
jest.mock('@/lib/notifications-api', () => ({
  ...jest.requireActual('@/lib/notifications-api'),
  listNotifications: jest.fn(),
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  listUpcomingReminders: jest.fn(),
}));

// The widgets skip their request without a local session, exactly as CoreDateChip does.
jest.mock('@/lib/core-http', () => ({
  ...jest.requireActual('@/lib/core-http'),
  hasLocalSession: jest.fn(() => true),
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked.
jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

const fetchMock = fetchPreferences as jest.MockedFunction<typeof fetchPreferences>;
const saveMock = savePreferences as jest.MockedFunction<typeof savePreferences>;
const rbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;
const notificationsMock = listNotifications as jest.MockedFunction<typeof listNotifications>;
const remindersMock = listUpcomingReminders as jest.MockedFunction<typeof listUpcomingReminders>;
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

const USER = { userId: 'u-1', email: 'ali@example.com' } as never;

const RBAC: CoreRbacSummary = {
  userId: 'u-1',
  roles: [{ id: 'r-1', name: 'EDITOR', displayName: 'ویراستار', hierarchy: 40 }],
  permissions: ['blog.read'],
  highestRole: { id: 'r-1', name: 'EDITOR', displayName: 'ویراستار', hierarchy: 40 },
};

const DEFAULT_LAYOUT: PreferenceLayoutEntry[] = WIDGET_IDS.map((id) => ({ id, visible: true }));

function preferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    theme: 'SYSTEM',
    density: 'COMFORTABLE',
    textScale: 100,
    motion: 'SYSTEM',
    sidebarCollapsed: false,
    navFavorites: [],
    navRecent: [],
    dashboardLayout: DEFAULT_LAYOUT,
    customized: true,
    updatedAt: '2026-09-04T08:00:00.000Z',
    ...overrides,
  };
}

const NOTIFICATIONS = {
  items: [
    {
      id: 'n-1',
      type: 'system',
      title: 'خوش آمدید',
      body: 'حساب شما ساخته شد.',
      readAt: null,
      sourceType: null,
      sourceId: null,
      createdAt: '2026-09-04T07:00:00.000Z',
    },
  ],
  hasMore: false,
};

const REMINDERS = {
  items: [
    {
      id: 'rm-1',
      title: 'جلسه هفتگی',
      note: null,
      dueAt: '2026-09-05T06:30:00.000Z',
      date: '1405/06/14',
      time: '10:00',
      allDay: false,
      enabled: true,
      deliveredAt: null,
      createdAt: '2026-09-01T06:30:00.000Z',
      updatedAt: '2026-09-01T06:30:00.000Z',
    },
  ],
  hasMore: false,
};

function renderDashboard() {
  return render(
    <ThemeProvider>
      <PreferenceProvider>
        <CoreDashboard />
      </PreferenceProvider>
    </ThemeProvider>,
  );
}

/** Renders and waits for the layout read to settle, i.e. for the editor toggle to exist. */
async function ready() {
  const user = userEvent.setup();
  renderDashboard();
  await waitFor(() => expect(screen.getByTestId('core-layout-toggle')).toBeInTheDocument());
  return user;
}

const widgetOrder = () =>
  screen.getAllByTestId('core-widget').map((node) => node.getAttribute('data-widget-id'));

/** The layout sent in the most recent PATCH that carried one. */
const lastLayoutPatch = () => {
  const patch = saveMock.mock.calls
    .map(([body]) => body)
    .reverse()
    .find((body) => Array.isArray(body.dashboardLayout));

  return (patch?.dashboardLayout ?? []) as PreferenceLayoutEntry[];
};

describe('CoreDashboard', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(authState({ isAuthenticated: true, user: USER }));
    fetchMock.mockResolvedValue(preferences());
    saveMock.mockImplementation(async (patch) => {
      if (patch.resetDashboardLayout) {
        return preferences({ dashboardLayout: DEFAULT_LAYOUT });
      }
      return preferences(patch as Partial<UserPreferences>);
    });
    rbacMock.mockResolvedValue(RBAC);
    notificationsMock.mockResolvedValue(NOTIFICATIONS);
    remindersMock.mockResolvedValue(REMINDERS as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  describe('rendering from the stored layout', () => {
    it('renders every widget in registry order by default', async () => {
      await ready();

      expect(widgetOrder()).toEqual([...WIDGET_IDS]);
    });

    it('renders the stored order, dropping ids the registry retired', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          dashboardLayout: [
            { id: 'reminders', visible: true },
            { id: 'identity', visible: true },
            { id: 'access', visible: true },
            { id: 'notifications', visible: true },
            // Legacy entries a layout saved before 49C-4 still carries. The registry
            // no longer knows them, so they are dropped rather than rendered as ghost
            // cards — the same ignore-on-read rule the server applies.
            { id: 'quick-actions', visible: true },
            { id: 'modules', visible: true },
          ],
        }),
      );

      await ready();

      expect(widgetOrder()).toEqual(['reminders', 'identity', 'access', 'notifications']);
    });

    /**
     * The hidden widget must never MOUNT: `listNotifications` firing here would mean the
     * page pays for a card the user removed, which is exactly what waiting for the stored
     * layout before the first widget render prevents.
     */
    it('does not render — or request for — a hidden widget', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          dashboardLayout: DEFAULT_LAYOUT.map((entry) =>
            entry.id === 'notifications' ? { ...entry, visible: false } : entry,
          ),
        }),
      );

      await ready();

      expect(widgetOrder()).not.toContain('notifications');
      // Precise on purpose: the label also appears as a NAV item in the modules card, so
      // a text query would pass for the wrong reason.
      expect(document.getElementById('core-widget-notifications-heading')).toBeNull();
      expect(notificationsMock).not.toHaveBeenCalled();
      // The neighbour on the same contract still loads, so this is isolation and not a
      // blanket "no requests" state.
      expect(remindersMock).toHaveBeenCalledTimes(1);
    });

    it('offers a way back when every widget is hidden', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          dashboardLayout: DEFAULT_LAYOUT.map((entry) => ({ ...entry, visible: false })),
        }),
      );

      await ready();

      expect(screen.queryAllByTestId('core-widget')).toHaveLength(0);
      expect(screen.getByText(/همه کارت‌ها پنهان شده‌اند/)).toBeInTheDocument();
      expect(screen.getByTestId('core-layout-toggle')).toBeInTheDocument();
    });

    it('reads RBAC once for the whole page', async () => {
      await ready();

      // Four widgets, one `GET /rbac`: the shared context, not per-widget fan-out.
      expect(rbacMock).toHaveBeenCalledTimes(1);
      expect(notificationsMock).toHaveBeenCalledTimes(1);
      expect(remindersMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('the layout editor', () => {
    async function openEditor() {
      const user = await ready();
      await user.click(screen.getByTestId('core-layout-toggle'));
      expect(screen.getByTestId('core-layout-editor')).toBeInTheDocument();
      return user;
    }

    const rowFor = (id: string) =>
      screen
        .getAllByTestId('core-layout-row')
        .find((row) => row.getAttribute('data-widget-id') === id)!;

    it('lists the full registry, hidden widgets included', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          dashboardLayout: DEFAULT_LAYOUT.map((entry) =>
            entry.id === 'access' ? { ...entry, visible: false } : entry,
          ),
        }),
      );

      await openEditor();

      // A control that only listed VISIBLE widgets would make hiding one irreversible.
      expect(screen.getAllByTestId('core-layout-row')).toHaveLength(WIDGET_IDS.length);
      expect(rowFor('access')).toHaveAttribute('data-visible', 'false');
    });

    it('moves a widget up, on the page and in the request', async () => {
      const user = await openEditor();

      await user.click(within(rowFor('notifications')).getByTestId('core-layout-up'));

      await waitFor(() =>
        expect(lastLayoutPatch().map((entry) => entry.id)).toEqual([
          'identity',
          'notifications',
          'access',
          'reminders',
        ]),
      );
      expect(widgetOrder()[1]).toBe('notifications');
    });

    it('disables the move that does not exist', async () => {
      await openEditor();

      // Clamping instead of disabling would report success for a move that never happened.
      expect(within(rowFor('identity')).getByTestId('core-layout-up')).toBeDisabled();
      expect(within(rowFor('reminders')).getByTestId('core-layout-down')).toBeDisabled();
    });

    it('hides a widget from the page and persists the choice', async () => {
      const user = await openEditor();

      await user.click(within(rowFor('reminders')).getByRole('checkbox'));

      await waitFor(() => expect(widgetOrder()).not.toContain('reminders'));
      expect(lastLayoutPatch()).toContainEqual({ id: 'reminders', visible: false });
    });

    it('resets with resetDashboardLayout, never a layout body', async () => {
      fetchMock.mockResolvedValue(
        preferences({
          dashboardLayout: [
            { id: 'reminders', visible: true },
            { id: 'identity', visible: false },
          ],
        }),
      );

      const user = await openEditor();
      expect(widgetOrder()[0]).toBe('reminders');

      await user.click(screen.getByTestId('core-layout-reset'));

      // Only SQL NULL is the server's "never customised" state, and the two fields are
      // mutually exclusive in one request.
      await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ resetDashboardLayout: true }));
      await waitFor(() => expect(widgetOrder()).toEqual([...WIDGET_IDS]));
    });

    it('stays usable but honest with no session to persist to', async () => {
      useAuthMock.mockReturnValue(authState({ isAuthenticated: false }));

      const user = await openEditor();
      expect(screen.getByText(/ذخیره نمی‌شود/)).toBeInTheDocument();

      await user.click(within(rowFor('notifications')).getByTestId('core-layout-up'));

      expect(widgetOrder()[1]).toBe('notifications');
      expect(saveMock).not.toHaveBeenCalled();
    });
  });

  describe('failure isolation', () => {
    it('keeps the neighbouring widgets alive when one request fails', async () => {
      notificationsMock.mockRejectedValue(new Error('اعلان‌ها در دسترس نیست'));

      await ready();

      // The failing card owns its own error state; a rejected fetch never reaches the
      // boundary, which is why both layers exist.
      expect(await screen.findByText('اعلان‌ها در دسترس نیست')).toBeInTheDocument();
      expect(screen.getByTestId('core-widget-reminder-list')).toBeInTheDocument();
      expect(widgetOrder()).toEqual([...WIDGET_IDS]);
    });

    it('isolates a widget that throws while rendering', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      function Boom(): never {
        throw new Error('این کارت شکست');
      }

      render(
        <div>
          <CoreWidgetBoundary widgetId="notifications" title={WIDGET_LABELS.notifications}>
            <Boom />
          </CoreWidgetBoundary>
          <CoreWidgetBoundary widgetId="identity" title={WIDGET_LABELS.identity}>
            <p>کارت سالم</p>
          </CoreWidgetBoundary>
        </div>,
      );

      const failed = screen.getByTestId('core-widget-error');
      expect(failed).toHaveAttribute('data-widget-id', 'notifications');
      // The fallback names the card, so a failure is identifiable rather than anonymous.
      expect(within(failed).getByText(WIDGET_LABELS.notifications)).toBeInTheDocument();
      expect(screen.getByText('کارت سالم')).toBeInTheDocument();

      consoleError.mockRestore();
    });
  });

  describe('phase 49C-4 dashboard cleanup', () => {
    it('no longer renders the quick-access or modules cards', async () => {
      await ready();

      // The registry itself shrank, so the default layout cannot contain them — but
      // assert the negative explicitly, because a ghost card would defeat the phase.
      expect(widgetOrder()).toEqual([...WIDGET_IDS]);
      expect(screen.queryByTestId('core-widget-quick-actions')).not.toBeInTheDocument();
      expect(screen.queryByTestId('core-widget-modules')).not.toBeInTheDocument();
      expect(screen.queryByText('دسترسی سریع')).not.toBeInTheDocument();
      expect(screen.queryByText('ماژول‌های در دسترس')).not.toBeInTheDocument();
    });

    it('still renders the remaining dashboard surfaces', async () => {
      await ready();

      // The identity and access cards by their headings; the two fetchers by their
      // single requests, so isolation is proven rather than assumed.
      expect(screen.getByText('حساب کاربری')).toBeInTheDocument();
      expect(screen.getByText('نقش‌ها و دسترسی‌ها')).toBeInTheDocument();
      expect(notificationsMock).toHaveBeenCalledTimes(1);
      expect(remindersMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('without a PreferenceProvider', () => {
    it('renders the default layout, read-only', async () => {
      render(<CoreDashboard />);

      await waitFor(() =>
        expect(screen.getAllByTestId('core-widget')).toHaveLength(WIDGET_IDS.length),
      );
      expect(widgetOrder()).toEqual([...WIDGET_IDS]);
      // Nothing could be persisted, so no control claims otherwise.
      expect(screen.queryByTestId('core-layout-toggle')).not.toBeInTheDocument();
    });
  });
});
