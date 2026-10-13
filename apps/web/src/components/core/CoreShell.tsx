'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { useOptionalPreferences } from '@/components/providers/PreferenceProvider';
import { Alert } from '@/components/ui/alert';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { CoreHeader } from './CoreHeader';
import { CoreSidebar } from './CoreSidebar';
import { CoreLoading } from './CoreStates';
import { isRecordableVisit, pageTitleFor } from './core-nav';

import { useCorePermissions } from './useCorePermissions';

/**
 * Phase 49B: authenticated Core layout — header, permission-aware sidebar,
 * main content slot, loading/unauthenticated handling, responsive behaviour.
 *
 * Session handling delegates entirely to AuthProvider (which wraps auth-api's
 * single token store). Permissions from GET /rbac gate navigation visibility
 * only; the backend remains the authorization authority.
 *
 * Breakpoints: the persistent rail is shown by Tailwind's `lg:` utilities, which
 * are 1024px. The drawer therefore has to use the SAME threshold — `useIsDesktop`
 * is `min-width: 1025px`, which left exactly 1024px activating both the rail and
 * the drawer at once. `useMediaQuery('(min-width: 1024px)')` closes that seam.
 *
 * Phase 49K (N1): the collapse state moved OUT of this component. It was
 * `React.useState(false)` here, so it reset on every reload and on any route change
 * that remounted the shell — the collapse worked but the preference did not exist.
 * It now comes from `PreferenceProvider` and is persisted server-side.
 *
 * The drawer state stays local on purpose: an overlay that is open is a momentary
 * interaction, and restoring it on the next page load would be a bug, not a
 * preference.
 *
 * Phase 49K (X6): the drawer now manages focus — focus in on open, focus restored to the
 * opener on close, Escape to close, and Tab confined to the panel while it is up. Before
 * this it opened with focus still on the hamburger behind the overlay.
 */

export interface CoreShellProps {
  children: React.ReactNode;
  /** Overrides the route-derived page title. */
  title?: string;
}

/**
 * Phase 49K (X6): what counts as focusable inside the mobile drawer.
 *
 * Deliberately NOT filtered by visibility: `offsetParent`/`getClientRects()` are
 * unreliable in jsdom, so a visibility filter would make the trap untestable while
 * adding nothing — the drawer is only queried while it is open, and everything inside
 * it is visible then.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => node.getAttribute('aria-hidden') !== 'true',
  );
}

export function CoreShell({ children, title }: CoreShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  // Matches Tailwind's `lg:` breakpoint exactly, so the rail and the drawer can
  // never both be active at 1024px.
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  /*
   * Optional so the shell still renders in isolation (existing unit tests mount it
   * without the provider). Without a provider the rail falls back to expanded and
   * uncontrolled local state — the pre-49K behaviour — rather than throwing.
   */
  const preferences = useOptionalPreferences();
  const [localCollapsed, setLocalCollapsed] = React.useState(false);

  const collapsed = preferences?.preferences.sidebarCollapsed ?? localCollapsed;
  const toggleCollapsed = React.useCallback(() => {
    if (preferences) {
      preferences.toggleSidebar();
      return;
    }
    setLocalCollapsed((value) => !value);
  }, [preferences]);

  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  /* ------------------------- X6: drawer focus management ------------------------- */

  const drawerPanelRef = React.useRef<HTMLDivElement | null>(null);
  /** The control that opened the drawer, so focus can return exactly where it was. */
  const drawerOpenerRef = React.useRef<HTMLElement | null>(null);
  /** Distinguishes a real close from the initial render, which must not steal focus. */
  const drawerWasOpenRef = React.useRef(false);

  const openMobileNav = React.useCallback(() => {
    drawerOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileNavOpen(true);
  }, []);

  const closeMobileNav = React.useCallback(() => setMobileNavOpen(false), []);

  /*
   * Move focus INTO the drawer on open. Before this, opening the drawer left focus on the
   * hamburger behind an overlay, so a keyboard user had to tab through the whole page to
   * reach the navigation they had just opened.
   *
   * The target is the panel's FIRST focusable element (its header link), not the close
   * button: landing on the first element means the next Tab walks the navigation in
   * reading order, which is what a user who just opened a menu is trying to do. Escape
   * and the close control are both one step away either way.
   *
   * The panel itself is the fallback, so a drawer that somehow rendered with nothing
   * focusable still takes focus off the page behind the overlay.
   */
  React.useEffect(() => {
    if (!mobileNavOpen) return;
    const panel = drawerPanelRef.current;
    if (!panel) return;
    (focusableIn(panel)[0] ?? panel).focus();
  }, [mobileNavOpen]);

  /*
   * Restore focus on close. The drawer stays MOUNTED (it has to, to slide), so without
   * this the focused element would keep focus inside a `visibility: hidden` subtree and
   * the next Tab would start from nowhere.
   */
  React.useEffect(() => {
    if (mobileNavOpen) {
      drawerWasOpenRef.current = true;
      return;
    }
    if (!drawerWasOpenRef.current) return;
    drawerWasOpenRef.current = false;

    const opener = drawerOpenerRef.current;
    drawerOpenerRef.current = null;
    // `isConnected`: the opener is the header hamburger, which is `lg:hidden` — if the
    // viewport grew into the desktop layout it may be gone by now.
    if (opener?.isConnected) opener.focus();
  }, [mobileNavOpen]);

  /*
   * Escape closes; Tab cycles inside the panel.
   *
   * Bound on the drawer WRAPPER rather than on `document`: focus is forced into the panel
   * on open, so a bubbling handler sees every key the drawer should react to without
   * adding a global listener that would also fire for the desktop rail.
   */
  const handleDrawerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!mobileNavOpen) return;

      if (event.key === 'Escape') {
        // Stopped here so one Escape does not also close an unrelated ancestor menu.
        event.stopPropagation();
        closeMobileNav();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = drawerPanelRef.current;
      if (!panel) return;

      const items = focusableIn(panel);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.contains(active);

      // Wrapping both ways keeps the tab ring closed while the overlay is up. It is a
      // trap by design — the overlay makes the page behind it unusable anyway — and
      // Escape plus the close button are always inside the ring, so it is escapable.
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    },
    [mobileNavOpen, closeMobileNav],
  );

  const {
    permissions,
    isLoading: permissionsLoading,
    error: permissionsError,
  } = useCorePermissions(isAuthenticated);

  // Gated items stay visible until a successful /rbac read, so a transient
  // failure cannot hide the existing CMS entry.
  const enforcePermissions = !permissionsLoading && !permissionsError;

  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  // Close the drawer when the viewport grows into the desktop layout — applied
  // during render, guarded by the previous breakpoint value (never as an
  // effect-body setter — `react-hooks/set-state-in-effect`). Mount is a no-op
  // (identity equal); an initial desktop render leaves the closed drawer alone.
  const [prevIsDesktop, setPrevIsDesktop] = React.useState(isDesktop);
  if (prevIsDesktop !== isDesktop) {
    setPrevIsDesktop(isDesktop);
    if (isDesktop) setMobileNavOpen(false);
  }

  /*
   * Phase 49K (N3): record the visit so the rail can offer a way back.
   *
   * `recordVisit` is a stable callback and fire-and-forget by contract, so this effect
   * cannot fail a navigation or re-run on unrelated preference changes. Only EXACT nav
   * targets are recorded: the server drops anything else from `navRecent`, so sending a
   * detail-page URL would be a request with no possible effect.
   */
  const recordVisit = preferences?.recordVisit;

  React.useEffect(() => {
    if (!isAuthenticated || !recordVisit || !pathname) return;
    // Phase 49M-2: `isRecordableVisit` rather than `isNavTarget`, so an audit surface such as
    // `/admin/observability` is never recorded even though it IS a declared nav target and can
    // be favourited deliberately. The server enforces the same exclusion; this avoids the write.
    if (!isRecordableVisit(pathname)) return;
    recordVisit(pathname);
  }, [isAuthenticated, recordVisit, pathname]);

  const handleLogout = React.useCallback(() => {
    logout()
      .catch(() => undefined)
      .finally(() => router.replace('/login'));
  }, [logout, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <CoreLoading label="در حال بارگذاری پنل مدیریت..." className="w-full max-w-sm" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="core-card w-full max-w-sm p-8 text-center">
          <Alert type="warning" message="برای دسترسی به پنل مدیریت باید وارد شوید." />
          <Link href="/login" className="btn-primary mt-6 inline-flex">
            رفتن به صفحه ورود
          </Link>
        </div>
      </div>
    );
  }

  const resolvedTitle = title ?? pageTitleFor(pathname ?? '');

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop / tablet-wide: persistent, full-height sidebar rail. */}
      <div className="sticky top-0 hidden h-screen shrink-0 lg:block">
        <CoreSidebar
          pathname={pathname ?? ''}
          permissions={permissions}
          enforcePermissions={enforcePermissions}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </div>

      {/*
        Tablet / mobile: sidebar as an overlay drawer anchored to the RIGHT.

        The drawer stays mounted so it can slide, and the whole layer is inert
        while closed: `invisible` + `pointer-events-none` on the wrapper means it
        cannot intercept clicks on the page content. `translate-x-full` moves the
        panel a full width to the right (CSS transforms are not direction-aware,
        so this is the correct off-screen direction for a right-anchored panel),
        and `start-0` is the right edge under <html dir="rtl">.
      */}
      <div
        data-testid="core-mobile-drawer"
        data-state={mobileNavOpen ? 'open' : 'closed'}
        // Hidden from the a11y tree while closed so the duplicated navigation is
        // not announced or focusable behind the page content.
        aria-hidden={!mobileNavOpen}
        onKeyDown={handleDrawerKeyDown}
        className={cn(
          // overflow-hidden: the parked panel (translate-x-full) must never
          // contribute to the document's scrollable overflow on mobile RTL —
          // a transformed child of a fixed wrapper extends the scroll region
          // of the page itself, which produced horizontal scroll on some pages.
          'fixed inset-0 z-50 overflow-hidden lg:hidden',
          mobileNavOpen ? 'visible' : 'invisible pointer-events-none',
        )}
      >
        <button
          type="button"
          aria-label="بستن پنل ناوبری"
          aria-hidden={!mobileNavOpen}
          tabIndex={mobileNavOpen ? 0 : -1}
          data-testid="core-mobile-overlay"
          onClick={closeMobileNav}
          className={cn(
            'absolute inset-0 h-full w-full bg-foreground/50 backdrop-blur-sm transition-opacity duration-300',
            mobileNavOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
        <div
          ref={drawerPanelRef}
          data-testid="core-mobile-drawer-panel"
          className={cn(
            'absolute inset-y-0 start-0 h-full shadow-elevated transition-transform duration-300 ease-out',
            mobileNavOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          <CoreSidebar
            pathname={pathname ?? ''}
            permissions={permissions}
            enforcePermissions={enforcePermissions}
            collapsed={false}
            variant="drawer"
            onToggleCollapsed={() => undefined}
            onNavigate={closeMobileNav}
            onClose={closeMobileNav}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <CoreHeader
          title={resolvedTitle}
          email={user?.email}
          onLogout={handleLogout}
          onOpenMobileNav={openMobileNav}
        />

        <main
          id="content"
          // Phase 49K: the page gutter uses the same density tokens as the cards it
          // contains (`p-core-card` = 1.5rem, `p-core-card-lg` = 2rem at COMFORTABLE),
          // so the previous `py-6 lg:py-8` rendering is unchanged at the default
          // density while COMPACT tightens the page and its contents together.
          className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-core-card sm:px-6 lg:px-8 lg:py-core-card-lg"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
