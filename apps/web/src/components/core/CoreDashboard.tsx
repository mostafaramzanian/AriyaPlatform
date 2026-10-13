'use client';

import * as React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useOptionalPreferences } from '@/components/providers/PreferenceProvider';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreLoading } from '@/components/core/CoreStates';
import { CoreWidgetBoundary } from '@/components/core/CoreWidgetCard';
import { WIDGET_COMPONENTS, type CoreWidgetContext } from '@/components/core/CoreDashboardWidgets';
import { CoreDashboardLayoutEditor } from '@/components/core/CoreDashboardLayoutEditor';
import {
  defaultWidgetLayout,
  isKnownWidget,
  isWideWidget,
  widgetLabel,
} from '@/components/core/core-widgets';

/**
 * Phase 49B: minimal Core dashboard.
 * Phase 48C: visual convergence — hero panel with a glow wash, token-driven `core-card`
 * panels, gradient icon chips.
 * Phase 49K: the three hardcoded sections are gone. The page is now RENDERED FROM THE
 * WIDGET REGISTRY, in the order and visibility the user chose (D1–D5).
 *
 * WHAT CHANGED AND WHY: the previous version hardcoded which panels existed, in which
 * order, in JSX — so "add a widget" meant editing this file, and the user's own opinion
 * about the page could not be expressed at all. Order and visibility are now DATA
 * (`dashboardLayout`, owned by `PreferenceProvider` and persisted per user), while which
 * widgets exist stays CODE (`core-widgets.ts` + `WIDGET_COMPONENTS`).
 *
 * NO NEW DATA. Every widget reads a contract that already existed before this phase.
 * There is still no KPI, chart or trend on this page, because nothing in the backend
 * computes one.
 *
 * ONE SHARED `GET /rbac` (D10). This component owns the single RBAC read and passes the
 * result down, so a navigation-derived widget adds no request. The two widgets that do
 * fetch (notifications, reminders) each own one call to their own capability's route —
 * deliberately not a composed `/dashboard` endpoint, which would have to re-implement
 * both routes' authorization edges in a third place.
 *
 * DEGRADES WITHOUT THE PROVIDER. `useOptionalPreferences` rather than `usePreferences`:
 * with no `PreferenceProvider` above it (an older test, or a tree rendered outside the
 * app layout) the dashboard renders the DEFAULT layout read-only instead of throwing.
 * Personalization is an enhancement of this page, not a precondition for it.
 */

export function CoreDashboard() {
  const { user, isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);
  const preferences = useOptionalPreferences();

  const [editorOpen, setEditorOpen] = React.useState(false);

  /**
   * Gated links follow the sidebar's rule: enforce only once RBAC has actually
   * answered, so a transient failure hides nothing.
   */
  const enforcePermissions = !rbac.isLoading && !rbac.error;

  const favorites = preferences?.preferences.navFavorites ?? [];
  // `favorites` is a fresh array on every render, so the CONTENT is what the memo below
  // may depend on — the identity would invalidate it constantly.
  const favoritesKey = favorites.join('|');

  const context: CoreWidgetContext = React.useMemo(
    () => ({
      email: user?.email ?? null,
      userId: user?.userId ?? user?.sub ?? null,
      rbac,
      enforcePermissions,
      favorites: favoritesKey ? favoritesKey.split('|') : [],
    }),
    [user?.email, user?.userId, user?.sub, rbac, enforcePermissions, favoritesKey],
  );

  // The provider always returns the full, resolved registry; the default is only for a
  // tree that has no provider at all.
  const layout = preferences?.widgetLayout ?? defaultWidgetLayout();
  const visible = layout.filter((entry) => entry.visible && isKnownWidget(entry.id));

  /**
   * Nothing widget-shaped renders until the stored layout is known.
   *
   * Not cosmetic: rendering the default layout first would MOUNT widgets the user has
   * hidden, so their requests would go out before the layout that hides them arrived —
   * and the page would then visibly reorder itself under the reader.
   */
  const layoutPending = preferences?.loading ?? false;

  return (
    <div className="space-y-core-gap">
      <section
        className="core-card hero-glow relative overflow-hidden p-core-card md:p-core-card-lg"
      >
        <p className="text-xs font-medium uppercase tracking-[0.24em] text-primary">پلتفرم آریا</p>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-foreground md:text-3xl">
          {user?.email ? `${user.email} خوش آمدید` : 'خوش آمدید'}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          این صفحه نقطه ورود پلتفرم است. ماژول‌های سازمانی در فازهای بعدی اضافه می‌شوند.
        </p>
      </section>

      {/* The editor only exists where a layout can actually be changed. */}
      {!layoutPending && preferences && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setEditorOpen((open) => !open)}
            aria-expanded={editorOpen}
            aria-controls="core-dashboard-layout-editor"
            data-testid="core-layout-toggle"
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            شخصی‌سازی چیدمان
          </button>
        </div>
      )}

      {preferences && editorOpen && (
        <div id="core-dashboard-layout-editor">
          <CoreDashboardLayoutEditor
            layout={layout}
            onMove={preferences.moveWidget}
            onToggle={preferences.toggleWidget}
            onReset={preferences.resetWidgetLayout}
            persisted={preferences.persisted}
            onClose={() => setEditorOpen(false)}
          />
        </div>
      )}

      {layoutPending ? (
        <CoreLoading label="در حال بارگذاری چیدمان صفحه..." lines={4} />
      ) : visible.length === 0 ? (
        <CoreEmpty
          message={
            preferences
              ? 'همه کارت‌ها پنهان شده‌اند. از «شخصی‌سازی چیدمان» می‌توانید آن‌ها را بازگردانید.'
              : 'کارتی برای نمایش وجود ندارد.'
          }
        />
      ) : (
        <div
          className="grid auto-rows-min gap-core-gap md:grid-cols-2"
          data-testid="core-widget-grid"
        >
          {visible.map((entry) => {
            // Safe cast: `visible` is filtered by `isKnownWidget`, so the id is a WidgetId.
            const Widget = WIDGET_COMPONENTS[entry.id as keyof typeof WIDGET_COMPONENTS];

            return (
              <CoreWidgetBoundary
                key={entry.id}
                widgetId={entry.id}
                title={widgetLabel(entry.id)}
                wide={isWideWidget(entry.id)}
              >
                <Widget context={context} />
              </CoreWidgetBoundary>
            );
          })}
        </div>
      )}
    </div>
  );
}
