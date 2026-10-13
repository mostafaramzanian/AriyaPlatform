'use client';

import * as React from 'react';
import Link from 'next/link';

import { CORE_NAV, visibleNavGroups, type CoreNavItem, type CoreNavGroup } from './core-nav';
import { CoreEmpty } from './CoreStates';

/**
 * Phase 49C-4: the AUTHORISED-modules presentation, extracted from the dashboard's
 * `modules` widget so the Account Center can render the SAME surface.
 *
 * THIS IS PRESENTATION ONLY. The list is derived — never stored, never fetched — from
 * `visibleNavGroups(CORE_NAV)`: the exact permission-intersection the sidebar uses,
 * against the ONE `GET /rbac` result the page already owns. There is no second module
 * discovery path, no new endpoint and no client-side permission invention: every item
 * is a link whose target still enforces its own server-side authorization, so this
 * surface cannot outlive a route or offer one the caller cannot open.
 *
 * `enforcePermissions` follows the sidebar's rule (enforce only once RBAC has actually
 * answered): while RBAC is loading or after it failed, gated links stay visible rather
 * than vanishing, and the backend still answers 403 — a transient failure must not
 * blank the surface. With `enforce` TRUE and no matching permission, a gated module is
 * filtered out; groups whose every item is filtered disappear entirely.
 *
 * `source` exists for tests and mirrors the `railNavGroups`/`visibleNavGroups`
 * signature; production callers never pass it.
 */
export function CoreModulesList({
  permissions,
  enforcePermissions,
  emptyMessage = 'ماژول قابل دسترسی برای حساب شما وجود ندارد.',
  source = CORE_NAV,
}: {
  permissions: string[];
  enforcePermissions: boolean;
  emptyMessage?: string;
  source?: CoreNavGroup[];
}) {
  const groups = React.useMemo(
    () => visibleNavGroups(permissions, enforcePermissions, source),
    [permissions, enforcePermissions, source],
  );

  if (groups.length === 0) {
    return <CoreEmpty message={emptyMessage} />;
  }

  return (
    <div className="space-y-5" data-testid="core-modules-list">
      {groups.map((group) => (
        <div key={group.id}>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {group.label}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {group.items.map((item) => (
              <ModulePill key={item.href} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One pill link — the same `core-card-interactive` affordance the dashboard's
 * navigation-derived widgets used. The `core-widget-link` test id is kept so the
 * shared link affordance stays identifiable across surfaces.
 */
export function ModulePill({ item }: { item: CoreNavItem }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      data-testid="core-widget-link"
      className="core-card-interactive inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-foreground"
    >
      <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
      {item.label}
    </Link>
  );
}