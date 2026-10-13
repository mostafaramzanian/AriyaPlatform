import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreSettingsCenter } from '../CoreSettingsCenter';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { PreferenceProvider } from '@/components/providers/PreferenceProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchMyRbac } from '@/lib/rbac-api';
import { fetchPreferences, savePreferences, type UserPreferences } from '@/lib/preferences-api';
import { listAIProviderConfigs } from '@/lib/ai-api';
import { listIntegrations, listAutomationExecutions } from '@/lib/integrations-api';
import { listModules, getModulePlatform } from '@/lib/modules-api';
import {
  getObservabilityHealth,
  getObservabilityMetrics,
  getObservabilityVocabulary,
  listApplicationLogs,
  listAuditEvents,
  listLifecycleEvents,
  listRetentionRuns,
  listSecurityEvents,
} from '@/lib/observability-api';

/**
 * Phase 49C-2 coverage for the unified Settings Center.
 *
 * Mounted over the REAL providers with only the HTTP layer mocked, because the part
 * that breaks is the seam: which tabs a permission set may see, what a direct
 * unauthorized `?tab=` resolves to, and whether the ACTIVE panel is the EXISTING
 * feature component (proven by its own API call firing) — never a re-implementation.
 */

const replace = jest.fn();

/** Read at render time (never at factory time), so each test can seed `?tab=`. */
let mockTabParam: string | null = null;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => '/admin/settings',
  useSearchParams: () => new URLSearchParams(mockTabParam === null ? {} : { tab: mockTabParam }),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

jest.mock('@/lib/preferences-api', () => ({
  ...jest.requireActual('@/lib/preferences-api'),
  fetchPreferences: jest.fn(),
  savePreferences: jest.fn(),
}));

jest.mock('@/lib/ai-api', () => ({
  ...jest.requireActual('@/lib/ai-api'),
  listAIProviderConfigs: jest.fn(),
}));

jest.mock('@/lib/integrations-api', () => ({
  ...jest.requireActual('@/lib/integrations-api'),
  listIntegrations: jest.fn(),
  listAutomationExecutions: jest.fn(),
}));

jest.mock('@/lib/modules-api', () => ({
  ...jest.requireActual('@/lib/modules-api'),
  listModules: jest.fn(),
  getModulePlatform: jest.fn(),
}));

jest.mock('@/lib/observability-api', () => ({
  ...jest.requireActual('@/lib/observability-api'),
  getObservabilityVocabulary: jest.fn(),
  getObservabilityHealth: jest.fn(),
  getObservabilityMetrics: jest.fn(),
  listApplicationLogs: jest.fn(),
  listAuditEvents: jest.fn(),
  listSecurityEvents: jest.fn(),
  listLifecycleEvents: jest.fn(),
  listRetentionRuns: jest.fn(),
}));

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMyRbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;
const fetchPreferencesMock = fetchPreferences as jest.MockedFunction<typeof fetchPreferences>;
const savePreferencesMock = savePreferences as jest.MockedFunction<typeof savePreferences>;
const listAIProviderConfigsMock = listAIProviderConfigs as jest.MockedFunction<
  typeof listAIProviderConfigs
>;
const listIntegrationsMock = listIntegrations as jest.MockedFunction<typeof listIntegrations>;
const listAutomationExecutionsMock = listAutomationExecutions as jest.MockedFunction<
  typeof listAutomationExecutions
>;
const listModulesMock = listModules as jest.MockedFunction<typeof listModules>;
const getModulePlatformMock = getModulePlatform as jest.MockedFunction<typeof getModulePlatform>;
const getObservabilityVocabularyMock = getObservabilityVocabulary as jest.MockedFunction<
  typeof getObservabilityVocabulary
>;
const getObservabilityHealthMock = getObservabilityHealth as jest.MockedFunction<
  typeof getObservabilityHealth
>;
const getObservabilityMetricsMock = getObservabilityMetrics as jest.MockedFunction<
  typeof getObservabilityMetrics
>;
const listApplicationLogsMock = listApplicationLogs as jest.MockedFunction<typeof listApplicationLogs>;
const listAuditEventsMock = listAuditEvents as jest.MockedFunction<typeof listAuditEvents>;
const listSecurityEventsMock = listSecurityEvents as jest.MockedFunction<typeof listSecurityEvents>;
const listLifecycleEventsMock = listLifecycleEvents as jest.MockedFunction<typeof listLifecycleEvents>;
const listRetentionRunsMock = listRetentionRuns as jest.MockedFunction<typeof listRetentionRuns>;

const ALL_PLATFORM_PERMISSIONS = [
  'admin.ai.read',
  'admin.integrations.read',
  'admin.modules.read',
  'admin.observability.read',
];

/** PHASE UI-4: the Commerce configuration domain's own read gate. */
const COMMERCE_READ = 'commerce.read';

const role = {
  id: 'r1',
  name: 'SUPER_ADMIN',
  displayName: 'مدیر ارشد',
  description: null,
  hierarchy: 0,
};

function rbac(permissions: string[]) {
  return {
    userId: 'settings-user',
    roles: permissions.length > 0 ? [role] : [],
    permissions,
    highestRole: permissions.length > 0 ? role : null,
  };
}

const SERVER_PREFS: UserPreferences = {
  theme: 'DARK',
  density: 'COMFORTABLE',
  textScale: 100,
  motion: 'SYSTEM',
  sidebarCollapsed: false,
  navFavorites: [],
  navRecent: [],
  dashboardLayout: [],
  customized: false,
  updatedAt: '2026-09-10T10:00:00.000Z',
};

function renderCenter() {
  return render(
    <ThemeProvider>
      <PreferenceProvider>
        <CoreSettingsCenter />
      </PreferenceProvider>
    </ThemeProvider>,
  );
}

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

/** Waits for the permission-aware tablist to replace the loading skeleton. */
async function ready() {
  const tablist = await screen.findByRole('tablist', { name: 'بخش‌های تنظیمات' });
  return tablist;
}

describe('CoreSettingsCenter', () => {
  beforeEach(() => {
    mockTabParam = null;
    replace.mockClear();

    useAuthMock.mockReturnValue(authState());
    fetchMyRbacMock.mockResolvedValue(rbac(ALL_PLATFORM_PERMISSIONS));

    fetchPreferencesMock.mockResolvedValue(SERVER_PREFS);
    savePreferencesMock.mockImplementation(async (patch) => ({ ...SERVER_PREFS, ...patch }) as UserPreferences);

    listAIProviderConfigsMock.mockResolvedValue({ configs: [], providers: [] } as unknown as Awaited<
      ReturnType<typeof listAIProviderConfigs>
    >);
    listIntegrationsMock.mockResolvedValue({ configs: [], integrations: [] } as unknown as Awaited<
      ReturnType<typeof listIntegrations>
    >);
    listAutomationExecutionsMock.mockResolvedValue({ items: [] } as unknown as Awaited<
      ReturnType<typeof listAutomationExecutions>
    >);
    listModulesMock.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof listModules>>);
    getModulePlatformMock.mockResolvedValue({} as unknown as Awaited<ReturnType<typeof getModulePlatform>>);
    getObservabilityVocabularyMock.mockResolvedValue({ sources: [] } as unknown as Awaited<
      ReturnType<typeof getObservabilityVocabulary>
    >);
    getObservabilityHealthMock.mockResolvedValue({ status: 'OK' } as unknown as Awaited<
      ReturnType<typeof getObservabilityHealth>
    >);
    getObservabilityMetricsMock.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof getObservabilityMetrics>>);
    listApplicationLogsMock.mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof listApplicationLogs>>);
    listAuditEventsMock.mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof listAuditEvents>>);
    listSecurityEventsMock.mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof listSecurityEvents>>);
    listLifecycleEventsMock.mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof listLifecycleEvents>>);
    listRetentionRunsMock.mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof listRetentionRuns>>);
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    for (const attribute of ['data-theme', 'data-density', 'data-text-scale', 'data-motion']) {
      document.documentElement.removeAttribute(attribute);
    }
  });

  it('renders ONE tablist with the personal and platform groups for an authorized user', async () => {
    renderCenter();
    const tablist = await ready();

    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'هوش مصنوعی' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'اتوماسیون و یکپارچه‌سازی' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'ماژول‌ها و سرویس‌های متصل' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'لاگ‌ها و رخدادها' })).toBeInTheDocument();
    // Group captions are presentation-only, never tabs (excluded from the a11y tree
    // by `aria-hidden`, so queried here from the DOM, not the role tree).
    expect(within(tablist).getAllByRole('tab').length + tablist.querySelectorAll('[role="presentation"]').length).toBe(7);
  });

  it('selects the personal tab by default and mounts ONLY its panel', async () => {
    renderCenter();
    const tablist = await ready();

    const appearanceTab = within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' });
    expect(appearanceTab).toHaveAttribute('aria-selected', 'true');
    expect(appearanceTab).toHaveAttribute('aria-controls', 'settings-panel-appearance');
    expect(appearanceTab).toHaveAttribute('tabindex', '0');

    const panel = await screen.findByRole('tabpanel', { name: 'ظاهر و دسترس‌پذیری' });
    expect(panel.id).toBe('settings-panel-appearance');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    // The personal panel is the SAME 49K card, not a re-implementation.
    expect(await within(panel).findByText('ظاهر و دسترس‌پذیری')).toBeInTheDocument();
    // Platform views stay UNMOUNTED until their tab activates.
    expect(listAIProviderConfigsMock).not.toHaveBeenCalled();
    expect(listModulesMock).not.toHaveBeenCalled();
  });

  it('activates the AI tab on click, mounts the EXISTING view, and updates the URL', async () => {
    const user = userEvent.setup();
    renderCenter();
    const tablist = await ready();

    await user.click(within(tablist).getByRole('tab', { name: 'هوش مصنوعی' }));

    expect(within(tablist).getByRole('tab', { name: 'هوش مصنوعی' })).toHaveAttribute('aria-selected', 'true');
    expect(replace).toHaveBeenCalledWith('/admin/settings?tab=ai', { scroll: false });
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    // Reuse proof: the panel is the REAL AI administration view (its own read fired).
    await waitFor(() => expect(listAIProviderConfigsMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('tabpanel', { name: 'ظاهر و دسترس‌پذیری' })).not.toBeInTheDocument();
  });

  it('reuses the integrations, modules and observability views for their tabs', async () => {
    const user = userEvent.setup();
    renderCenter();
    const tablist = await ready();

    await user.click(within(tablist).getByRole('tab', { name: 'اتوماسیون و یکپارچه‌سازی' }));
    await waitFor(() => expect(listIntegrationsMock).toHaveBeenCalledTimes(1));

    await user.click(within(tablist).getByRole('tab', { name: 'ماژول‌ها و سرویس‌های متصل' }));
    await waitFor(() => expect(listModulesMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getModulePlatformMock).toHaveBeenCalledTimes(1));

    await user.click(within(tablist).getByRole('tab', { name: 'لاگ‌ها و رخدادها' }));
    await waitFor(() => expect(getObservabilityVocabularyMock).toHaveBeenCalledTimes(1));

    expect(replace).toHaveBeenLastCalledWith('/admin/settings?tab=observability', { scroll: false });
  });

  it('hides every platform tab from a user without platform permissions', async () => {
    fetchMyRbacMock.mockResolvedValue(rbac([]));

    renderCenter();
    const tablist = await ready();

    expect(within(tablist).getAllByRole('tab')).toHaveLength(1);
    expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tablist).queryByRole('tab', { name: 'هوش مصنوعی' })).not.toBeInTheDocument();
    expect(within(tablist).queryByRole('tab', { name: 'لاگ‌ها و رخدادها' })).not.toBeInTheDocument();
  });

  it('resolves an unauthorized ?tab=ai to the personal tab and mounts NO platform view', async () => {
    fetchMyRbacMock.mockResolvedValue(rbac([]));
    mockTabParam = 'ai';

    renderCenter();
    const tablist = await ready();

    expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.queryByRole('tabpanel', { name: 'هوش مصنوعی' })).not.toBeInTheDocument();
    // The unauthorized view's read never fires — nothing was mounted for it.
    expect(listAIProviderConfigsMock).not.toHaveBeenCalled();
  });

  it('falls back safely on an invalid tab param', async () => {
    mockTabParam = 'bogus';

    renderCenter();
    const tablist = await ready();

    expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute('aria-selected', 'true');
  });

  /*
   * Phase 49C-5 CORRECTION: support is a personal/service access action in the HEADER
   * user menu (CoreHeader.spec.tsx), NOT a Settings tab — the 49C-5 support tab was
   * removed and the Settings Center returned to its five-domain structure.
   */
  describe('49C-5 CORRECTION: support has no Settings tab', () => {
    it('does NOT render a پشتیبانی tab for an authorized user', async () => {
      renderCenter();
      const tablist = await ready();

      expect(within(tablist).queryByRole('tab', { name: 'پشتیبانی' })).not.toBeInTheDocument();
      expect(within(tablist).getAllByRole('tab')).toHaveLength(5);
    });

    it('cannot be selected through ?tab=support — the removed convention falls back safely', async () => {
      mockTabParam = 'support';

      renderCenter();
      const tablist = await ready();

      // The removed tab id resolves like any unknown id: first visible tab, panel mounted.
      expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(tablist).queryByRole('tab', { name: 'پشتیبانی' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
      expect(screen.queryByRole('tabpanel', { name: 'پشتیبانی' })).not.toBeInTheDocument();
    });

    it('is not surfaced for a user without platform permissions either', async () => {
      fetchMyRbacMock.mockResolvedValue(rbac([]));

      renderCenter();
      const tablist = await ready();

      expect(within(tablist).getAllByRole('tab')).toHaveLength(1);
      expect(within(tablist).queryByRole('tab', { name: 'پشتیبانی' })).not.toBeInTheDocument();
    });
  });

  it('restores the active tab from the URL on refresh', async () => {
    mockTabParam = 'modules';

    renderCenter();
    const tablist = await ready();

    expect(within(tablist).getByRole('tab', { name: 'ماژول‌ها و سرویس‌های متصل' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('tabpanel', { name: 'ماژول‌ها و سرویس‌های متصل' })).toBeInTheDocument();
  });

  it('moves between tabs with arrow keys and Home/End (RTL-aware, roving tabindex)', async () => {
    const user = userEvent.setup();
    renderCenter();
    const tablist = await ready();

    const root = document.documentElement;
    const prevDir = root.getAttribute('dir');
    root.setAttribute('dir', 'ltr'); // pin direction for the assertion (app is RTL)
    try {
      await user.click(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' }));
      await user.keyboard('{ArrowRight}');
      expect(within(tablist).getByRole('tab', { name: 'هوش مصنوعی' })).toHaveAttribute('aria-selected', 'true');
      expect(within(tablist).getByRole('tab', { name: 'هوش مصنوعی' })).toHaveFocus();
      expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute('tabindex', '-1');

      await user.keyboard('{End}');
      expect(within(tablist).getByRole('tab', { name: 'لاگ‌ها و رخدادها' })).toHaveAttribute('aria-selected', 'true');

      await user.keyboard('{Home}');
      expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      if (prevDir === null) root.removeAttribute('dir');
      else root.setAttribute('dir', prevDir);
    }
  });

  it('shows the permission skeleton while /rbac is in flight', async () => {
    fetchMyRbacMock.mockReturnValue(new Promise(() => undefined));

    renderCenter();

    expect(screen.getByTestId('settings-center-loading')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('keeps gated tabs visible when /rbac fails (transient-failure convention)', async () => {
    fetchMyRbacMock.mockRejectedValue(new Error('rbac down'));

    renderCenter();
    const tablist = await ready();

    // Five platform tabs since UI-4 — the four admin views plus the Commerce
    // configuration domain; a transient RBAC failure must hide none of them.
    expect(within(tablist).getAllByRole('tab')).toHaveLength(6);
  });

  /*
   * PHASE UI-4: the Commerce / procurement configuration domain is a TAB of this center —
   * never a second settings application, never a Commerce sidebar item. These tests pin
   * the two halves of that contract: the gate follows the same `.read` convention as the
   * other platform tabs, and selecting it mounts the domain's OWN panel (its sub-navigation
   * and landing content prove it — no second `/admin/settings` route exists).
   */
  it('surfaces «تدارکات و فرآیند خرید» for a commerce.read holder and mounts the domain panel', async () => {
    const user = userEvent.setup();
    fetchMyRbacMock.mockResolvedValue(rbac([...ALL_PLATFORM_PERMISSIONS, COMMERCE_READ]));

    renderCenter();
    const tablist = await ready();

    const commerceTab = within(tablist).getByRole('tab', { name: 'تدارکات و فرآیند خرید' });
    await user.click(commerceTab);

    expect(replace).toHaveBeenCalledWith('/admin/settings?tab=commerce', { scroll: false });
    const panel = await screen.findByRole('tabpanel', { name: 'تدارکات و فرآیند خرید' });
    expect(panel.id).toBe('settings-panel-commerce');
    // The panel is the REAL domain view: its sub-navigation and landing cards render.
    expect(await within(panel).findByTestId('commerce-settings-view')).toBeInTheDocument();
    expect(within(panel).getByTestId('commerce-settings-nav-overview')).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(within(panel).getByTestId('commerce-settings-card-workflows')).toBeInTheDocument();
    expect(within(panel).getByTestId('commerce-settings-card-commercial')).toBeInTheDocument();
    // There is deliberately NO line-routing branch (no HTTP configuration surface).
    expect(within(panel).queryByText(/مسیردهی اقلام/)).not.toBeInTheDocument();
  });

  it('hides the Commerce tab without commerce.read and falls back for a direct ?tab=commerce', async () => {
    mockTabParam = 'commerce';
    fetchMyRbacMock.mockResolvedValue(rbac(ALL_PLATFORM_PERMISSIONS));

    renderCenter();
    const tablist = await ready();

    expect(
      within(tablist).queryByRole('tab', { name: 'تدارکات و فرآیند خرید' })
    ).not.toBeInTheDocument();
    // The unauthorized value resolves like any unknown id: the first visible tab.
    expect(within(tablist).getByRole('tab', { name: 'ظاهر و دسترس‌پذیری' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByTestId('commerce-settings-view')).not.toBeInTheDocument();
  });
});
