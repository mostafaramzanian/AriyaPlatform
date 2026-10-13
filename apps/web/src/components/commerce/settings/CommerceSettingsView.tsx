'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CommerceWorkflowSettings } from './CommerceWorkflowSettings';
import { CommerceCommercialSettings } from './CommerceCommercialSettings';
import { CommerceCompletionSettings } from './CommerceCompletionSettings';
import { CommerceSettingsOverview } from './CommerceSettingsOverview';
import {
  CommerceSettingsGuardProvider,
  useCommerceSettingsGuard,
} from './CommerceSettingsGuard';

/**
 * PHASE UI-4: the Commerce / procurement CONFIGURATION domain, mounted inside the
 * existing Settings Center (`/admin/settings?tab=commerce`) — never a second settings
 * architecture, never a Commerce sidebar item.
 *
 * THE MENTAL MODEL THIS PANEL PRESENTS (the brief's own sequence):
 *   تنظیمات → تدارکات و فرآیند خرید → فرآیند → نسخه → مرحله → جزئیات
 * The backend's entities (WorkflowDefinition, WorkflowDefinitionVersion, WorkflowStep,
 * CommercialConfigurationVersion) are NEVER the primary vocabulary: the sections speak
 * «فرآیندهای خرید» and «تنظیمات بازرگانی», and the technical identifiers appear only as
 * secondary detail inside the editors.
 *
 * THE SUB-NAVIGATION extends the center's established `?tab=` convention one level down:
 * `?tab=commerce&view=…` with `view` ∈ {overview, workflows, commercial} —
 * `replace` navigation like the settings tabs themselves, refresh-restorable, and an
 * unknown value falls back to both the domain's landing panel. «مسیردهی اقلام» is NOT a
 * branch: the backend exposes no HTTP configuration surface for it (UI-0 GAP-2), and a
 * hidden branch beats a fake screen.
 *
 * PERMISSIONS (presentation only; the backend stays authoritative):
 *   commerce.read              → the tab's own gate; the panel's reads.
 *   commerce.configure         → definitions (create/rename), commercial groups and the
 *                                commercial configuration lifecycle.
 *   commerce.workflow.manage   → versions, steps and the validate/publish/archive walk.
 *   admin.users.read           → the member pickers (liaison / configured user), because
 *                                the only id-producing read is the Core directory.
 */

type CommerceSettingsViewKey = 'overview' | 'workflows' | 'commercial' | 'completion';

const VIEW_KEYS: readonly CommerceSettingsViewKey[] = [
  'overview',
  'workflows',
  'commercial',
  'completion',
];

function resolveView(raw: string | null): CommerceSettingsViewKey {
  return VIEW_KEYS.find((view) => view === raw) ?? 'overview';
}

const SUB_NAV: ReadonlyArray<{ key: CommerceSettingsViewKey; label: string }> = [
  { key: 'overview', label: 'نمای کلی' },
  { key: 'workflows', label: 'فرآیندهای خرید' },
  { key: 'commercial', label: 'تنظیمات بازرگانی' },
  // PHASE C4-R (GAP-3): the completion rule joined the domain as its own section rather
  // than as another block of «تنظیمات بازرگانی» — it governs the DOCUMENT's completion,
  // which is neither a workflow nor a commercial assignment.
  { key: 'completion', label: 'تکمیل خرید' },
];

export function CommerceSettingsView() {
  /*
   * The guard wraps the whole domain: every editor registers its dirty flag here, and
   * every navigation inside the domain asks before discarding. See
   * `CommerceSettingsGuard` for the contract.
   */
  return (
    <CommerceSettingsGuardProvider>
      <CommerceSettingsViewInner />
    </CommerceSettingsGuardProvider>
  );
}

function CommerceSettingsViewInner() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);
  const { requestGuard } = useCommerceSettingsGuard();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const viewParam = resolveView(searchParams.get('view'));
  /*
   * Same pattern as the center's own tabs: the URL param is the addressable SOURCE, but
   * the active section is also component state — `replace` updates the address while the
   * state drives the render (a tab that only re-read the URL would render nothing until
   * navigation was observed, and back/forward must still win when the param changes).
   */
  const [view, setView] = React.useState<CommerceSettingsViewKey>(viewParam);

  // URL param changes (back/forward, external navigation) re-point the section
  // during render, guarded by the previous value — never as an effect-body
  // setter (`react-hooks/set-state-in-effect`). Clicks inside the surface go
  // through `selectView` (guard + address), which is unchanged.
  const [prevViewParam, setPrevViewParam] = React.useState(viewParam);
  if (prevViewParam !== viewParam) {
    setPrevViewParam(viewParam);
    setView(viewParam);
  }

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');
  const canConfigure = rbac.permissions.includes('commerce.configure');
  const canWorkflowManage = rbac.permissions.includes('commerce.workflow.manage');
  const canReadDirectory = rbac.permissions.includes('admin.users.read');

  const selectView = React.useCallback(
    (next: CommerceSettingsViewKey) => {
      if (next === view) return;
      // Leaving the current section may discard unsaved edits: the guard decides.
      requestGuard(() => {
        setView(next);
        router.replace(`${pathname ?? '/admin/settings'}?tab=commerce&view=${next}`, {
          scroll: false,
        });
      });
    },
    [pathname, requestGuard, router, view]
  );

  if (rbac.isLoading) {
    return <CoreLoading lines={4} />;
  }

  if (!canRead) {
    return <CoreForbidden message="برای مشاهدهٔ تنظیمات تدارکات به مجوز commerce.read نیاز دارید." />;
  }

  return (
    <div className="space-y-core-gap" data-testid="commerce-settings-view">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">تدارکات و فرآیند خرید</h2>
        <p className="text-xs text-muted-foreground">
          پیکربندی فرآیند خرید، مراحل بررسی و تنظیمات بازرگانی
        </p>
      </div>

      {/*
        Sub-navigation within the domain. It is a `nav` of buttons with `aria-current` —
        NOT a nested tablist: the Settings Center owns the page's single tab system, and
        a second one inside it would give assistive technology two competing tab models
        on one screen.
      */}
      <nav
        aria-label="بخش‌های تنظیمات تدارکات"
        className="core-card flex items-center gap-1 overflow-x-auto p-2"
        data-testid="commerce-settings-subnav"
      >
        {SUB_NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={view === item.key ? 'true' : undefined}
            onClick={() => selectView(item.key)}
            data-testid={`commerce-settings-nav-${item.key}`}
            className={
              view === item.key
                ? 'shrink-0 whitespace-nowrap rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground'
                : 'shrink-0 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground'
            }
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view === 'overview' && <CommerceSettingsOverview onNavigate={selectView} />}

      {view === 'workflows' && (
        <CommerceWorkflowSettings
          canConfigure={canConfigure}
          canWorkflowManage={canWorkflowManage}
          canReadDirectory={canReadDirectory}
        />
      )}

      {view === 'commercial' && (
        <CommerceCommercialSettings
          canConfigure={canConfigure}
          canReadDirectory={canReadDirectory}
        />
      )}

      {view === 'completion' && <CommerceCompletionSettings canConfigure={canConfigure} />}
    </div>
  );
}
