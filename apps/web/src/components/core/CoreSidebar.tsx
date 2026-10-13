'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  Clock,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  Star,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOptionalPreferences } from '@/components/providers/PreferenceProvider';
import { MAX_NAV_FAVORITES } from '@/lib/preferences-api';
import { CoreDateChip } from './CoreDateChip';
import {
  activeNavHref,
  flattenNavItems,
  isExpandable,
  isNavItemActive,
  toRailGroups,
  visibleNavGroups,
  type CoreNavGroup,
  type CoreNavItem,
} from './core-nav';

/**
 * Phase 49B: Core sidebar.
 * Phase 48C: visual convergence with the approved design reference — the rail is
 * a dark gradient surface in both themes, items use a pill treatment with an
 * inline active marker, and the brand block lives at the top of the rail.
 *
 * Phase 48C.1 (bug closure, no redesign):
 *  - The active marker sits on the RIGHT edge of the item. The rail is a
 *    right-side rail under <html dir="rtl">, so `start-*` is the right edge and
 *    `end-*` is the left edge; the marker previously used `end-0`, which RTL
 *    resolved to the left edge.
 *  - An expandable parent renders as a single toggle row (Phase 50-LOVABLE-PARITY):
 *    clicking the row opens/closes its sub-tree and the chevron is a decorative icon
 *    inside that one button. Only items that actually declare children get the toggle
 *    at all — leaf items render icon + label, nothing that implies expandability.
 *  - The collapse control uses Panel*Right* icons (the rail is on the right) and
 *    describes the ACTION rather than the current position.
 *
 * Visual language (colours, radii, spacing, typography) is unchanged.
 *
 * Phase 49K (N2, N3): the rail also renders the caller's FAVOURITES and RECENT pages
 * above the static navigation, and every expanded row carries a star toggle.
 *
 * BOTH LISTS ARE PRESENTATION OVER SERVER-FILTERED DATA. `navFavorites` / `navRecent`
 * arrive from `GET /me/preferences` already re-filtered against live RBAC, and are
 * intersected AGAIN here with the locally visible items — so neither list can offer a
 * link the sidebar itself would hide, and a favourite whose permission was revoked
 * disappears instead of becoming a 403 on click.
 *
 * WITHOUT A PROVIDER, NEITHER EXISTS. `useOptionalPreferences` returns null outside
 * `PreferenceProvider`, and the rail then renders exactly the pre-49K navigation — no
 * star, no extra groups. Personalization is additive, never a precondition.
 *
 * HIDDEN WHEN COLLAPSED, like sub-trees: the 78px rail has no room for a second copy of
 * an icon the static navigation already shows, and two identical icons in one rail is
 * worse than no shortcut at all.
 */

/**
 * How many recent pages the rail shows.
 *
 * Smaller than the stored `MAX_NAV_RECENT` (10) on purpose: the rail's job is "get me
 * back to what I just had open", which the last few entries answer, while ten rows of
 * history would push the static navigation off the first screen.
 */
const RECENT_RAIL_LIMIT = 5;

interface CoreSidebarProps {
  pathname: string;
  permissions: string[];
  /** False while permissions are loading or unavailable; gated items stay visible. */
  enforcePermissions?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Set on mobile so selecting a link can close the drawer. */
  onNavigate?: () => void;
  /** Mobile drawer renders always-expanded, with a close control instead of collapse. */
  variant?: 'desktop' | 'drawer';
  /** Drawer-only: closes the overlay drawer. */
  onClose?: () => void;
}

export function CoreSidebar({
  pathname,
  permissions,
  enforcePermissions = true,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  variant = 'desktop',
  onClose,
}: CoreSidebarProps) {
  const isDrawer = variant === 'drawer';
  // The drawer is always fully expanded; collapsing only applies to the rail.
  const isCollapsed = isDrawer ? false : collapsed;

  const groups: CoreNavGroup[] = React.useMemo(
    () => visibleNavGroups(permissions, enforcePermissions),
    [permissions, enforcePermissions],
  );

  /*
   * Phase 49C-3: the STATIC navigation list is the deduplicated rail — personal
   * destinations with a dedicated access path elsewhere (حساب من / اعلان‌ها / تقویم)
   * no longer render as primary rows. The `groups` above intentionally stays the
   * FULL visible set: `itemsByHref`/`resolve` feed the favourites and recent lists,
   * and a pinned «تقویم» must keep resolving to a real row even though the static
   * row is gone (hiding is never deleting the user's personalization). The strip
   * runs over the SAME `visibleNavGroups` result, so the navigation keeps a single
   * source and seam.
   */
  const railGroups: CoreNavGroup[] = React.useMemo(() => toRailGroups(groups), [groups]);

  // Expanded groups are keyed by href. A parent containing the active route
  // starts open; explicit user toggles then take precedence.
  //
  // Phase 50-LOVABLE-PARITY: items that declare `defaultOpen` (the مکاتبات
  // submenu, mirroring Lovable's `open: { mail: true }`) seed OPEN on first
  // render — no active child required — matching the reference sidebar exactly.
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const item of flattenNavItems(groups.flatMap((group) => group.items))) {
      if (item.defaultOpen) seed[item.href] = true;
    }
    return seed;
  });

  const toggleExpanded = React.useCallback((href: string) => {
    setExpanded((current) => ({ ...current, [href]: !current[href] }));
  }, []);

  const containsActive = React.useCallback(
    (item: CoreNavItem) =>
      flattenNavItems(item.children ?? []).some((child) => isNavItemActive(pathname, child.href)),
    [pathname],
  );

  /* ------------------------- Phase 49K: personalization ------------------------- */

  const preferences = useOptionalPreferences();
  // The two interest sets are tenant payloads the server returns (and re-sends on
  // every read), so identity-changing literals are NOT a re-render hazard — but
  // `react-hooks/exhaustive-deps` traces the `?? []` fallback as a dependency
  // that changes on every render. Memoizing on the preferences identity gives
  // the downstream memos a stable array without changing what they compute.
  const favoriteHrefs = React.useMemo(
    () => preferences?.preferences.navFavorites ?? [],
    [preferences],
  );
  const recentHrefs = React.useMemo(
    () => preferences?.preferences.navRecent ?? [],
    [preferences],
  );

  /** Every locally visible nav target, so a stored href can be resolved to a real item. */
  const itemsByHref = React.useMemo(() => {
    const flat = flattenNavItems(groups.flatMap((group) => group.items));
    return new Map(flat.map((item) => [item.href, item] as const));
  }, [groups]);

  const resolve = React.useCallback(
    (hrefs: string[]) =>
      hrefs
        .map((href) => itemsByHref.get(href))
        .filter(
          (item): item is CoreNavItem =>
            // Phase 50-LOVABLE-PARITY: an item declared `favoriteable: false`
            // (the correspondence tree) is not shown in the favourites/recent
            // personalization surfaces — its rail rows render no star at all,
            // mirroring the Lovable reference. The stored preference is left
            // untouched on the server; only the rail stops volunteering it.
            item !== undefined && item.favoriteable !== false,
        ),
    [itemsByHref],
  );

  const favoriteItems = React.useMemo(() => resolve(favoriteHrefs), [resolve, favoriteHrefs]);

  /**
   * Recents exclude the page the user is already on (it is not a way BACK to anything)
   * and anything already pinned as a favourite (which is one row above, permanently).
   */
  const recentItems = React.useMemo(
    () =>
      resolve(recentHrefs)
        .filter((item) => item.href !== pathname && !favoriteHrefs.includes(item.href))
        .slice(0, RECENT_RAIL_LIMIT),
    [resolve, recentHrefs, pathname, favoriteHrefs],
  );

  /*
   * Phase 51-HR-2: the row that lights up is the MOST SPECIFIC declared target for the
   * path, so a module row such as `/admin/hr` does not stay selected while one of its own
   * pages (`/admin/hr/employees`) has a row of its own. The rule, and why it is the same
   * defect Phase 50 fixed for a parent and its selected child, is documented on
   * `activeNavHref`.
   *
   * THE CANDIDATE SET IS WHAT CAN RENDER, not the whole catalogue. A sub-tree renders no
   * rows at all on the collapsed rail, so the row that stands in for it there must keep
   * the highlight — otherwise collapsing the rail would make a module the user is inside
   * look unselected. Favourites and recents are drawn from the FULL visible set (a hidden
   * personal destination can still be a favourite) and only render on the expanded rail,
   * so they join the candidates exactly when they can appear.
   */
  const activeHref = React.useMemo(() => {
    const railItems = isCollapsed
      ? railGroups.flatMap((group) => group.items)
      : flattenNavItems(railGroups.flatMap((group) => group.items));
    const pinned = isCollapsed ? [] : [...favoriteItems, ...recentItems];

    return activeNavHref(pathname, [...railItems, ...pinned]);
  }, [isCollapsed, railGroups, favoriteItems, recentItems, pathname]);

  const atFavoriteCap = favoriteHrefs.length >= MAX_NAV_FAVORITES;
  const toggleFavorite = preferences?.toggleFavorite;
  // The star is an affordance of the expanded rail only, and only where a provider can
  // actually persist the choice.
  const showStars = Boolean(toggleFavorite) && !isCollapsed;

  return (
    <nav
      aria-label="ناوبری اصلی"
      data-testid={isDrawer ? 'core-sidebar-drawer' : 'core-sidebar'}
      data-variant={variant}
      data-collapsed={isCollapsed ? 'true' : 'false'}
      className={cn(
        'gradient-sidebar relative flex h-full flex-col border-e border-sidebar-border text-sidebar-foreground transition-[width] duration-300 ease-out',
        isCollapsed ? 'w-[78px]' : 'w-[280px]',
      )}
    >
      <div className="pointer-events-none absolute inset-0 hero-glow opacity-60" aria-hidden="true" />

      <div className="relative flex h-full min-h-0 flex-col">
        {/* Brand + collapse/close control */}
        <div
          className={cn(
            // `h-core-header` keeps the brand block exactly as tall as the header
            // bar at every density — the two are visually one continuous strip, so
            // they must resolve from the same token rather than two literals.
            'flex h-core-header shrink-0 items-center gap-2 border-b border-sidebar-border px-4',
            isCollapsed ? 'justify-center px-2' : 'justify-between',
          )}
        >
          <Link
            href="/admin"
            onClick={onNavigate}
            className="flex min-w-0 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
          >
            <span className="gradient-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl shadow-glow">
              <Sparkles className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
            </span>
            {!isCollapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block text-lg font-bold text-sidebar-foreground">آریا سیستم</span>
                <span className="block text-[11px] text-sidebar-foreground/50">
                  Aria ERP Platform
                </span>
              </span>
            )}
          </Link>

          {isDrawer ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن منوی ناوبری"
              title="بستن منوی ناوبری"
              data-testid="core-drawer-close"
              className="shrink-0 rounded-lg p-1.5 text-sidebar-foreground/60 transition hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            !isCollapsed && (
              <CollapseToggle collapsed={false} onToggle={onToggleCollapsed} className="shrink-0" />
            )
          )}
        </div>

        {!isDrawer && isCollapsed && (
          <CollapseToggle collapsed onToggle={onToggleCollapsed} className="mt-3 self-center" />
        )}

        <div
          id={isDrawer ? undefined : 'core-sidebar-nav'}
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-core-gap overflow-y-auto py-5',
            isCollapsed ? 'px-2' : 'px-3',
          )}
        >
          {/*
            N2/N3 sit ABOVE the static navigation on purpose: a shortcut that lives below
            four groups saves no clicks. Both are hidden on the collapsed rail.
          */}
          {!isCollapsed && favoriteItems.length > 0 && (
            <PinnedGroup
              groupId="favorites"
              label="پیوندهای دلخواه"
              icon={Star}
              items={favoriteItems}
              pathname={pathname}
              activeHref={activeHref}
              onNavigate={onNavigate}
              showStars={showStars}
              favorite
              atFavoriteCap={atFavoriteCap}
              onToggleFavorite={toggleFavorite}
            />
          )}

          {!isCollapsed && recentItems.length > 0 && (
            <PinnedGroup
              groupId="recent"
              label="بازدیدهای اخیر"
              icon={Clock}
              items={recentItems}
              pathname={pathname}
              activeHref={activeHref}
              onNavigate={onNavigate}
              showStars={showStars}
              favorite={false}
              atFavoriteCap={atFavoriteCap}
              onToggleFavorite={toggleFavorite}
            />
          )}

          {railGroups.map((group) => (
            <div
              key={group.id}
              className="space-y-1.5"
              data-testid="core-nav-group"
              data-group-id={group.id}
            >
              {!isCollapsed && (
                <div className="px-3 text-[11px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/40">
                  {group.label}
                </div>
              )}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  // The collapsed rail has no room for a sub-tree, so groups
                  // behave as plain links there (existing rail design).
                  const showChildren = isExpandable(item) && !isCollapsed;
                  const open = showChildren && (expanded[item.href] ?? containsActive(item));

                  return (
                    <li key={item.href}>
                      <NavRow
                        item={item}
                        pathname={pathname}
                        activeHref={activeHref}
                        collapsed={isCollapsed}
                        expandable={showChildren}
                        open={open}
                        onNavigate={onNavigate}
                        onToggleExpanded={() => toggleExpanded(item.href)}
                        favorite={favoriteHrefs.includes(item.href)}
                        atFavoriteCap={atFavoriteCap}
                        onToggleFavorite={
                          showStars && toggleFavorite
                            ? () => toggleFavorite(item.href)
                            : undefined
                        }
                      />

                      {showChildren && open && (
                        <ul className="mt-1 me-4 origin-top animate-dropdown-in space-y-0.5 border-e border-sidebar-foreground/10 pe-3">
                          {item.children!.map((child) => (
                            <li key={child.href}>
                              <NavRow
                                item={child}
                                pathname={pathname}
                                activeHref={activeHref}
                                collapsed={false}
                                expandable={false}
                                open={false}
                                onNavigate={onNavigate}
                                onToggleExpanded={() => undefined}
                                nested
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/*
          Phase 49I: the date chip lives at the BOTTOM of the rail, below the scrolling
          navigation list and outside it — so it stays visible while the nav scrolls and
          is never mistaken for a nav item. `mt-auto` is unnecessary because the nav
          region above already takes `flex-1`.
        */}
        <div
          className={cn(
            'shrink-0 border-t border-sidebar-border py-3',
            isCollapsed ? 'px-2' : 'px-3',
          )}
        >
          <CoreDateChip
            collapsed={isCollapsed}
            variant={variant}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </nav>
  );
}

/**
 * The collapse control describes the ACTION, not the current position:
 * expanded rail → "collapse", collapsed rail → "expand". Panel*Right* icons are
 * used because the rail is anchored to the right in RTL.
 */
function CollapseToggle({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = collapsed ? PanelRightOpen : PanelRightClose;
  const label = collapsed ? 'باز کردن منو' : 'بستن منو';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls="core-sidebar-nav"
      aria-label={label}
      title={label}
      data-testid="core-collapse-toggle"
      data-action={collapsed ? 'expand' : 'collapse'}
      className={cn(
        'rounded-lg p-1.5 text-sidebar-foreground/60 transition hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow',
        className,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

interface NavRowProps {
  item: CoreNavItem;
  pathname: string;
  /**
   * Phase 51-HR-2: the href of the ONE row that lights up for `pathname`, computed by
   * `CoreSidebar` over everything that can render a row. `null` when no declared target
   * covers the path at all.
   */
  activeHref: string | null;
  collapsed: boolean;
  expandable: boolean;
  open: boolean;
  onNavigate?: () => void;
  onToggleExpanded: () => void;
  nested?: boolean;
  /** Phase 49K: current star state. Absent `onToggleFavorite`, no star renders at all. */
  favorite?: boolean;
  onToggleFavorite?: () => void;
  /** True when `MAX_NAV_FAVORITES` is reached; only blocks ADDING. */
  atFavoriteCap?: boolean;
}

/**
 * Phase 49K: a favourites / recent group.
 *
 * Same markup as a static group so a shortcut row is visually identical to the row it
 * shortcuts — one nav vocabulary, not two. The group icon is the only difference, and it
 * is what tells the two personalized groups apart from the static ones.
 */
function PinnedGroup({
  groupId,
  label,
  icon: Icon,
  items,
  pathname,
  activeHref,
  onNavigate,
  showStars,
  favorite,
  atFavoriteCap,
  onToggleFavorite,
}: {
  groupId: string;
  label: string;
  icon: LucideIcon;
  items: CoreNavItem[];
  pathname: string;
  /** Phase 51-HR-2: forwarded to every row, so a shortcut lights up like the row it points at. */
  activeHref: string | null;
  onNavigate?: () => void;
  showStars: boolean;
  /** Uniform across the group: every favourite row is starred, every recent row is not. */
  favorite: boolean;
  atFavoriteCap: boolean;
  onToggleFavorite?: (href: string) => void;
}) {
  return (
    <div className="space-y-1.5" data-testid="core-nav-group" data-group-id={groupId}>
      <div className="flex items-center gap-2 px-3 text-[11px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/40">
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <NavRow
              item={item}
              pathname={pathname}
              activeHref={activeHref}
              collapsed={false}
              expandable={false}
              open={false}
              onNavigate={onNavigate}
              onToggleExpanded={() => undefined}
              favorite={favorite}
              atFavoriteCap={atFavoriteCap}
              onToggleFavorite={
                showStars && onToggleFavorite ? () => onToggleFavorite(item.href) : undefined
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavRow({
  item,
  pathname,
  activeHref,
  collapsed,
  expandable,
  open,
  onNavigate,
  onToggleExpanded,
  nested = false,
  favorite = false,
  onToggleFavorite,
  atFavoriteCap = false,
}: NavRowProps) {
  /*
   * Phase 50-LOVABLE-PARITY + Phase 51-HR-2: exactly one row is ever selected.
   *
   * The row is selected when it is the one `activeNavHref` chose for the path — the most
   * specific declared target, computed by `CoreSidebar` over everything that can render a
   * row. That keeps the earlier rules intact: a detail page with no row of its own still
   * lights its parent (`/admin/blog/42` still highlights وبلاگ), an expandable parent is a
   * SECTION TOGGLE and stays active only on its OWN href rather than inheriting the state
   * from a selected child, and a module row goes dark once one of its own pages has a row
   * of its own (`/admin/hr` vs `/admin/hr/employees`).
   */
  const active = activeHref === item.href && (!expandable || pathname === item.href);
  const Icon = item.icon;

  return (
    /*
     * X4 (49K) / Phase 50-LOVABLE-PARITY: the row is a PLAIN CONTAINER holding ONE
     * clickable control per action.
     *
     * - An EXPANDABLE parent renders a single toggle `<button>` spanning the row:
     *   clicking the button (anywhere) opens/closes the sub-tree, and the chevron is a
     *   decorative icon INSIDE it. This matches the Lovable reference, where the
     *   مکاتبات row itself toggles — there is no separate chevron control to chase.
     * - A leaf renders a plain `<Link>`.
     * - The favourite star, when present, sits BESIDE whichever control the row uses.
     *
     * Before X4 the star and the chevron were `role="button"` spans nested INSIDE the
     * `<Link>` — an interactive control inside another interactive control, which is
     * invalid ARIA and makes a screen reader announce one ambiguous target for three
     * different actions. The row keeps every attribute tests and CSS hang off
     * (`core-nav-item`, `data-active`, `data-expandable`) and the whole
     * background/hover treatment, so the visual language is unchanged — only the DOM
     * nesting is fixed. Every control is now a real `<button>`, so activation, focus
     * and announcement come from the platform instead of hand-written key handlers.
     */
    <div
      data-testid="core-nav-item"
      data-active={active ? 'true' : 'false'}
      data-expandable={expandable ? 'true' : 'false'}
      className={cn(
        'group relative flex items-center rounded-xl text-sm font-medium transition-all',
        // Row heights are density tokens (`--core-row-h` / `--core-row-sm-h`), so a
        // COMPACT rail fits more items without a `data-density` variant here.
        nested ? 'h-core-row-sm gap-2.5 rounded-lg px-3 text-[13px]' : 'h-core-row gap-3 px-3',
        collapsed && 'justify-center px-0',
        active
          ? cn('bg-sidebar-foreground/10 text-sidebar-foreground', !nested && 'shadow-inner')
          : cn(
              'hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground',
              nested ? 'text-sidebar-foreground/55' : 'text-sidebar-foreground/70',
            ),
      )}
    >
      {/* RTL: `start-0` is the RIGHT edge of the item. `rounded-e-full` rounds the
          inner (left) corners so the marker reads as a tab on the rail edge. */}
      {active && !nested && (
        <span
          aria-hidden="true"
          data-testid="core-nav-active-indicator"
          className="gradient-primary absolute start-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-e-full"
        />
      )}

      {/* The expandable parent is ONE toggle button spanning the row (Lovable parity):
          clicking anywhere on it opens/closes the sub-tree, and the chevron is a
          decorative icon INSIDE the button — no sibling chevron control that doubles
          the toggle target or confuses the screen reader. A leaf keeps rendering as a
          plain link. `h-full` keeps the hit area the full row height — no dead strips
          above or below the label. */}
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'بستن' : 'نمایش'} زیرمنوی ${item.label}`}
          title={`${open ? 'بستن' : 'نمایش'} زیرمنوی ${item.label}`}
          data-testid="core-nav-toggle"
          data-open={open ? 'true' : 'false'}
          onClick={onToggleExpanded}
          // `text-start` is REQUIRED here, not cosmetic: a `<button>` inherits the
          // UA sheet's `text-align: center`, and the label is a flex-greedy span, so
          // without it the parent's text floats mid-row while every leaf `<Link>`
          // (text-align default `start`) hugs the icon. `text-start` aligns the label
          // like all other rows in RTL — text right after the icon, whitespace after.
          className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-xl text-start text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
        >
          <Icon
            className={cn('shrink-0 h-[18px] w-[18px]', active && 'text-primary-glow')}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-sidebar-foreground/40 transition-transform duration-200',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      ) : (
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          title={collapsed ? item.label : undefined}
          data-testid="core-nav-link"
          className={cn(
            'flex h-full min-w-0 flex-1 items-center rounded-xl text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow',
            nested ? 'gap-2.5' : 'gap-3',
            collapsed && 'justify-center',
          )}
        >
          <Icon
            className={cn(
              'shrink-0',
              nested ? 'h-3.5 w-3.5 opacity-80' : 'h-[18px] w-[18px]',
              active && !nested && 'text-primary-glow',
            )}
            aria-hidden="true"
          />

          {collapsed ? (
            <span className="sr-only">{item.label}</span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          )}
        </Link>
      )}

      {!collapsed && (
        <>
          {/*
            N2: the star sits BESIDE the link, not inside it (X4). It is always visible
            rather than hover-only, because a hover-only control is unreachable on touch
            and easy to miss with a keyboard.

            `aria-disabled` instead of `disabled` at the cap: a disabled button is skipped
            by keyboard navigation and announces nothing, so the user would never hear why
            the star stopped working. This one stays focusable and says so.
          */}
          {onToggleFavorite && item.favoriteable !== false && (
            <button
              type="button"
              aria-pressed={favorite}
              aria-disabled={!favorite && atFavoriteCap ? true : undefined}
              aria-label={
                favorite
                  ? `حذف «${item.label}» از پیوندهای دلخواه`
                  : atFavoriteCap
                    ? `سقف پیوندهای دلخواه تکمیل شده است`
                    : `افزودن «${item.label}» به پیوندهای دلخواه`
              }
              data-testid="core-nav-favorite"
              data-favorite={favorite ? 'true' : 'false'}
              onClick={() => {
                // Refusing at the cap is explicit here as well as in the provider, so the
                // control's `aria-disabled` and its behaviour cannot disagree.
                if (!favorite && atFavoriteCap) return;
                onToggleFavorite();
              }}
              className={cn(
                'grid h-6 w-6 shrink-0 place-items-center rounded-md transition hover:bg-sidebar-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow',
                favorite
                  ? 'text-primary-glow'
                  : atFavoriteCap
                    ? 'cursor-not-allowed text-sidebar-foreground/20'
                    : 'text-sidebar-foreground/35 hover:text-sidebar-foreground/80',
              )}
            >
              <Star className={cn('h-3.5 w-3.5', favorite && 'fill-current')} aria-hidden="true" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

