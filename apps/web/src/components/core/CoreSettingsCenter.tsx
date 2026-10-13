'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';
import { useCorePermissions } from './useCorePermissions';
import { CoreLoading } from './CoreStates';
import { CoreAppearanceSettings } from './CoreAppearanceSettings';
import { CoreAIProvidersView } from './CoreAIProvidersView';
import { CoreIntegrationsView } from './CoreIntegrationsView';
import { CoreModulesView } from './CoreModulesView';
import { CoreObservabilityView } from './CoreObservabilityView';
import { CommerceSettingsView } from '@/components/commerce/settings/CommerceSettingsView';

/**
 * Phase 49C-2: the unified Settings Center — ONE surface for personal AND platform
 * settings, reached from the header user menu's «تنظیمات» entry.
 *
 * WHAT THIS COMPONENT IS: a tab shell over EXISTING views. Every panel is the real,
 * already-verified feature component — `CoreAppearanceSettings` (49K/49C-1 personal
 * preferences), the four platform administration views that used to be sidebar
 * destinations (49J-0/49L/49M/49M-2), and — since UI-4 — the Commerce/procurement
 * configuration panel (`CommerceSettingsView`), which is the ONE place the purchase
 * process, its workflows and the commercial configuration are administered. No settings
 * logic, fetch, form or permission is re-implemented here.
 *
 * PERMISSION MODEL (unchanged semantics): the personal tab is always visible to the
 * authenticated user; platform tabs reuse the SAME permission strings the platform
 * containers enforce (`admin.{ai,integrations,modules,observability}.read`) and follow
 * the shell's established convention — while `/rbac` is loading or failed, gated items
 * stay visible so a transient failure cannot hide an entry the backend still
 * authorizes. An unauthorized tab is never RENDERED: direct `?tab=…` access resolves
 * to the first visible tab. The embedded views re-check permissions themselves and
 * the backend APIs stay authoritative, so this is presentation gating on top of the
 * real authorization boundary, never instead of it.
 *
 * DATA (unchanged contracts): one active panel is MOUNTED at a time — switching tabs
 * mounts the corresponding view, whose own verified fetch lifecycle runs exactly as
 * on its old page. Nothing is prefetched, no polling, no shared cache. The appearance
 * tab mounts the SAME card the account page used to host, over the SAME single
 * `PreferenceProvider`.
 *
 * TAB STATE: URL-addressable (`/admin/settings?tab=modules`), same mechanism and
 * conventions as the account tabs from 49C-1: `replace` navigation, unknown or
 * unauthorized values fall back to the first visible tab, refresh restores it.
 */
type SettingsTabId =
  | 'appearance'
  | 'ai'
  | 'integrations'
  | 'modules'
  | 'observability'
  | 'commerce';

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  group: 'personal' | 'platform';
  /** The platform permission whose absence hides this tab (presentation gate only). */
  permission?: string;
}

const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  { id: 'appearance', label: 'ظاهر و دسترس‌پذیری', group: 'personal' },
  { id: 'ai', label: 'هوش مصنوعی', group: 'platform', permission: 'admin.ai.read' },
  {
    id: 'integrations',
    label: 'اتوماسیون و یکپارچه‌سازی',
    group: 'platform',
    permission: 'admin.integrations.read',
  },
  {
    id: 'modules',
    label: 'ماژول‌ها و سرویس‌های متصل',
    group: 'platform',
    permission: 'admin.modules.read',
  },
  {
    id: 'observability',
    label: 'لاگ‌ها و رخدادها',
    group: 'platform',
    permission: 'admin.observability.read',
  },
  /*
   * PHASE UI-4: the Commerce / procurement CONFIGURATION domain. It lives HERE — inside
   * the existing Settings Center — by product decision: the process configuration an
   * administrator edits is platform settings, reached from «تنظیمات», never a second
   * settings application and never a Commerce sidebar item. The gate is `commerce.read`,
   * the read every panel route in the domain demands (the same `.read` convention the
   * four tabs above follow); the panel re-checks the configuration permissions itself
   * and hides the actions a caller may not take. Presentation only — the backend stays
   * authoritative.
   */
  {
    id: 'commerce',
    label: 'تدارکات و فرآیند خرید',
    group: 'platform',
    permission: 'commerce.read',
  },
];

const GROUP_LABELS: Record<SettingsTab['group'], string> = {
  personal: 'شخصی',
  platform: 'پلتفرم',
};

/** Unknown or unauthorized tab params fall back to the first visible tab. */
function resolveSettingsTab(
  raw: string | null,
  visible: ReadonlyArray<SettingsTab>,
): SettingsTabId | null {
  return visible.find((tab) => tab.id === raw)?.id ?? visible[0]?.id ?? null;
}

export function CoreSettingsCenter() {
  const { isAuthenticated } = useAuth();
  const {
    permissions,
    isLoading: permissionsLoading,
    error: permissionsError,
  } = useCorePermissions(isAuthenticated);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /*
   * Permission-aware visibility. Gated tabs stay visible while `/rbac` is loading or
   * has failed — the same convention `CoreShell` uses for the rail — because a
   * transient RBAC failure must not hide an entry the backend still authorizes.
   */
  const enforcePermissions = !permissionsLoading && !permissionsError;
  const visibleTabs = React.useMemo(
    () =>
      SETTINGS_TABS.filter(
        (tab) => !tab.permission || !enforcePermissions || permissions.includes(tab.permission),
      ),
    [enforcePermissions, permissions],
  );

  /*
   * While `/rbac` is in flight the final tab set is unknown, so no tablist is
   * rendered yet — an unauthorized tab must never flash as selectable.
   */
  if (permissionsLoading) {
    return (
      <div className="core-card p-core-card" data-testid="settings-center-loading">
        <CoreLoading label="در حال بارگذاری تنظیمات..." />
      </div>
    );
  }

  return (
    <CoreSettingsCenterLoaded
      visibleTabs={visibleTabs}
      pathname={pathname}
      searchParams={searchParams}
      router={router}
    />
  );
}

interface LoadedProps {
  visibleTabs: ReadonlyArray<SettingsTab>;
  pathname: string | null;
  searchParams: ReturnType<typeof useSearchParams>;
  router: ReturnType<typeof useRouter>;
}

function CoreSettingsCenterLoaded({ visibleTabs, pathname, searchParams, router }: LoadedProps) {
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = React.useState<SettingsTabId | null>(() =>
    resolveSettingsTab(tabParam, visibleTabs),
  );

  /*
   * The URL param is the addressable source; re-apply on change (back/forward) and
   * whenever permission resolution changes the visible set. `replace`, not `push`:
   * a tab is presentation state, not a history entry (49C-1 convention).
   *
   * Applied during render, guarded by the RESOLVED value — never as an
   * effect-body setter (`react-hooks/set-state-in-effect`). Tracking the
   * resolved value (not the inputs) is what keeps this loop-free: clicks go
   * through `selectTab` below, which updates the URL first, so by the time the
   * param resolves it already matches.
   */
  const resolvedTab = resolveSettingsTab(tabParam, visibleTabs);
  const [appliedTab, setAppliedTab] = React.useState<SettingsTabId | null>(resolvedTab);
  if (resolvedTab !== null && resolvedTab !== appliedTab) {
    setAppliedTab(resolvedTab);
    setActiveTab(resolvedTab);
  }

  const selectTab = React.useCallback(
    (id: SettingsTabId) => {
      if (id === activeTab) return;
      setActiveTab(id);
      router.replace(`${pathname ?? '/admin/settings'}?tab=${id}`, { scroll: false });
    },
    [activeTab, pathname, router],
  );

  /*
   * Arrow-key movement between tabs on the FOCUSED tab (the container never takes
   * focus). Under <html dir="rtl"> "forward" is visually LEFT, so arrow directions
   * flip; Home/End jump to the ends of the VISIBLE tab set.
   */
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRtl ? 'ArrowRight' : 'ArrowLeft';
    const currentIndex = visibleTabs.findIndex((tab) => tab.id === activeTab);

    let nextIndex: number | null = null;
    if (event.key === forward) {
      nextIndex = (currentIndex + 1) % visibleTabs.length;
    } else if (event.key === backward) {
      nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = visibleTabs.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(visibleTabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  if (activeTab === null) {
    return <CoreLoading label="در حال بارگذاری تنظیمات..." />;
  }

  return (
    <div className="space-y-core-gap">
      {/*
        Settings Center header. The browser tab + shell header title come from the
        route metadata / the 49C-1 alias («تنظیمات»); this block is the in-page
        hierarchy: title, purpose line, then the tabs, then ONE active panel.
      */}
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">تنظیمات</h2>
        <p className="text-xs text-muted-foreground">مدیریت تنظیمات شخصی و پلتفرم</p>
      </div>

      {/*
        ONE tablist — no nested tab systems. Group captions are presentation-only
        (`role="presentation"` removes them from the tablist's children for assistive
        tech), and the tablist itself scrolls horizontally when the long Persian
        labels need it — the page never does.
      */}
      <div
        role="tablist"
        aria-label="بخش‌های تنظیمات"
        className="core-card flex items-center gap-1 overflow-x-auto p-2"
      >
        {visibleTabs.map((tab, index) => {
          const showGroupCaption =
            index === 0 || (index > 0 && visibleTabs[index - 1].group !== tab.group);
          return (
            <React.Fragment key={tab.id}>
              {showGroupCaption ? (
                <span
                  role="presentation"
                  aria-hidden="true"
                  className="shrink-0 select-none px-2 text-xs font-medium text-muted-foreground"
                >
                  {GROUP_LABELS[tab.group]}
                </span>
              ) : null}
              <button
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  activeTab === tab.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/*
        ONE mounted panel at a time. The personal panel keeps the 49C-1 max width so
        the preference card stays a comfortable settings column; the platform panels
        render the SAME full-width views that used to live behind the sidebar links.
      */}
      {activeTab === 'appearance' ? (
        <div
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          tabIndex={0}
          className="mx-auto w-full max-w-4xl"
        >
          <CoreAppearanceSettings />
        </div>
      ) : null}
      {activeTab === 'ai' ? (
        <div
          role="tabpanel"
          id="settings-panel-ai"
          aria-labelledby="settings-tab-ai"
          tabIndex={0}
        >
          <CoreAIProvidersView />
        </div>
      ) : null}
      {activeTab === 'integrations' ? (
        <div
          role="tabpanel"
          id="settings-panel-integrations"
          aria-labelledby="settings-tab-integrations"
          tabIndex={0}
        >
          <CoreIntegrationsView />
        </div>
      ) : null}
      {activeTab === 'modules' ? (
        <div
          role="tabpanel"
          id="settings-panel-modules"
          aria-labelledby="settings-tab-modules"
          tabIndex={0}
        >
          <CoreModulesView />
        </div>
      ) : null}
      {activeTab === 'observability' ? (
        <div
          role="tabpanel"
          id="settings-panel-observability"
          aria-labelledby="settings-tab-observability"
          tabIndex={0}
        >
          <CoreObservabilityView />
        </div>
      ) : null}
      {/*
        PHASE UI-4: the Commerce configuration panel. It is mounted like every other
        platform panel — one at a time, no prefetch — and it owns its own internal
        navigation (نمای کلی / فرآیندهای خرید / تنظیمات بازرگانی) behind a `?view=`
        param, which extends this center's established `?tab=` convention rather than
        introducing a second settings route.
      */}
      {activeTab === 'commerce' ? (
        <div
          role="tabpanel"
          id="settings-panel-commerce"
          aria-labelledby="settings-tab-commerce"
          tabIndex={0}
        >
          <CommerceSettingsView />
        </div>
      ) : null}
    </div>
  );
}
