'use client';

import * as React from 'react';
import { Bell, CalendarClock, ShieldCheck, UserCircle } from 'lucide-react';

import { hasLocalSession } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  formatNotificationTime,
  isUnread,
  listNotifications,
  type NotificationItem,
} from '@/lib/notifications-api';
import {
  formatReminderTime,
  listUpcomingReminders,
  toPersianDigits,
  type ReminderItem,
} from '@/lib/calendar-api';
import { CoreEmpty, CoreError, CoreLoading } from './CoreStates';
import { CoreWidgetCard } from './CoreWidgetCard';
import { WIDGET_LABELS, isWideWidget, type WidgetId } from './core-widgets';
import type { CorePermissionsState } from './useCorePermissions';
import { cn } from '@/lib/utils';

/**
 * Phase 49K: the dashboard widgets (D6–D9).
 * Phase 49C-4: the two navigation-derived widgets left the page. `quick-actions`
 * duplicated the sidebar it sat beside, and `modules` moved to the Account Center
 * (`/admin/profile?tab=modules`) as the shared `CoreModulesList` presentation —
 * same `visibleNavGroups` derivation, new home. Four widgets remain.
 *
 * WHAT A WIDGET MAY SHOW: only data an existing contract already returns. There is no
 * KPI, no chart and no trend anywhere in this file, because no endpoint in this
 * codebase computes one — a "+12% this month" card would be a fabricated number, which
 * is the specific failure 48C set out to remove from this page.
 *
 * SHARED READS ARE PASSED IN, NOT RE-FETCHED (D10). The dashboard resolves the session
 * identity and ONE `GET /rbac` and hands both down as `CoreWidgetContext`. The
 * remaining widgets therefore issue NO request of their own beyond the two fetchers,
 * and the page's request count is a function of which capabilities are shown, never of
 * how many widgets or rows there are. There is deliberately no aggregated `/dashboard`
 * endpoint: notifications and reminders each enforce their own authorization edge on
 * their own route, and a composed read would have to re-implement both edges in a
 * third place.
 *
 * A WIDGET NEVER GRANTS ACCESS. Every widget's DATA comes from a route that enforces
 * its own permission server-side; a widget a user should not see renders empty rather
 * than leaking.
 */

/** Everything a widget may read without issuing a request of its own. */
export interface CoreWidgetContext {
  email: string | null;
  userId: string | null;
  /** The single shared `GET /rbac` result. */
  rbac: CorePermissionsState;
  /**
   * False while RBAC is loading or after it failed, matching the sidebar: a gated link
   * stays visible on a transient failure rather than vanishing, and the backend still
   * answers 403.
   */
  enforcePermissions: boolean;
  /** Favourite hrefs, already RBAC-filtered by the server. */
  favorites: string[];
}

export type CoreWidgetComponent = React.ComponentType<{ context: CoreWidgetContext }>;

/** Widget lists stay short on purpose: this is a landing page, not the full view. */
const WIDGET_LIST_SIZE = 5;

/* -------------------------------------------------------------------------- */
/* Shared list state                                                           */
/* -------------------------------------------------------------------------- */

interface WidgetListState<T> {
  items: T[];
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The loading/error/empty lifecycle shared by the two widgets that DO fetch.
 *
 * `load` must be module-level or memoised — it is an effect dependency, so a fresh
 * closure per render would re-request on every render.
 *
 * Skips the request entirely with no local session, exactly as `CoreDateChip` does: a
 * guaranteed 401 is noise that hides real failures.
 */
function useWidgetList<T>(
  load: () => Promise<{ items: T[] }>,
  errorMessage: string,
): WidgetListState<T> {
  const [items, setItems] = React.useState<T[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in each widget's retry handler (same commit as the
  // token bump), so the fetch effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token, reload } = useReloadToken(setIsLoading, setError);

  React.useEffect(() => {
    if (!hasLocalSession()) {
      // No session: settle to the EMPTY, error-free list through the same
      // async settle path as a fetch — no synchronous setters in the effect
      // body (`react-hooks/set-state-in-effect`). One microtask later is the
      // same post-commit timing the in-effect branch used to have.
      let cancelled = false;
      Promise.resolve()
        .then(() => {
          if (cancelled) return;
          setItems([]);
          setError(null);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    load()
      .then((result) => {
        if (cancelled) return;
        setItems(Array.isArray(result?.items) ? result.items : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : errorMessage);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [load, errorMessage, token]);

  return { items, isLoading, error, reload };
}

/* -------------------------------------------------------------------------- */
/* identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Session-only: the same two fields the pre-49K dashboard showed. No request. */
function IdentityWidget({ context }: { context: CoreWidgetContext }) {
  return (
    <CoreWidgetCard
      id="identity"
      title={WIDGET_LABELS.identity}
      icon={UserCircle}
      wide={isWideWidget('identity')}
      action={{ href: '/admin/profile', label: 'مشاهده حساب من' }}
    >
      <dl className="divide-y divide-border text-sm">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">ایمیل</dt>
          <dd className="min-w-0 truncate font-medium text-foreground">{context.email ?? '—'}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">شناسه کاربر</dt>
          <dd className="min-w-0 truncate font-mono text-xs text-foreground">
            {context.userId ?? '—'}
          </dd>
        </div>
      </dl>
    </CoreWidgetCard>
  );
}

/* -------------------------------------------------------------------------- */
/* access                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The RBAC summary, from the context's shared read.
 *
 * Counts and the highest role only — never the permission strings themselves, which
 * are an internal catalogue and would read as a security inventory on a landing page.
 */
function AccessWidget({ context }: { context: CoreWidgetContext }) {
  const { roles, permissions, highestRole, isLoading, error, reload } = context.rbac;

  return (
    <CoreWidgetCard
      id="access"
      title={WIDGET_LABELS.access}
      icon={ShieldCheck}
      wide={isWideWidget('access')}
    >
      {isLoading ? (
        <CoreLoading label="در حال بارگذاری دسترسی‌ها..." lines={2} />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : roles.length === 0 && permissions.length === 0 ? (
        <CoreEmpty message="نقشی برای این حساب ثبت نشده است." />
      ) : (
        <dl className="divide-y divide-border text-sm">
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">نقش اصلی</dt>
            <dd className="font-medium text-foreground">{highestRole?.displayName ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">تعداد نقش‌ها</dt>
            <dd className="font-medium text-foreground">{roles.length}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">تعداد دسترسی‌ها</dt>
            <dd className="font-medium text-foreground">{permissions.length}</dd>
          </div>
        </dl>
      )}
    </CoreWidgetCard>
  );
}

/* -------------------------------------------------------------------------- */
/* notifications                                                               */
/* -------------------------------------------------------------------------- */

// Module-level so the effect dependency is stable across renders.
const loadNotifications = () => listNotifications({ limit: WIDGET_LIST_SIZE });

/**
 * The newest few notifications over the existing 49E contract (D6).
 *
 * READ-ONLY ON PURPOSE. `GET /notifications` is the only call; marking read stays in
 * the bell and the notifications page. A dashboard card that mutated state on click
 * would make "glance at the dashboard" a destructive act.
 */
function NotificationsWidget() {
  const { items, isLoading, error, reload } = useWidgetList<NotificationItem>(
    loadNotifications,
    'دریافت اعلان‌ها با خطا مواجه شد.',
  );

  return (
    <CoreWidgetCard
      id="notifications"
      title={WIDGET_LABELS.notifications}
      icon={Bell}
      wide={isWideWidget('notifications')}
      action={{ href: '/admin/notifications', label: 'همه اعلان‌ها' }}
    >
      {isLoading ? (
        <CoreLoading label="در حال بارگذاری اعلان‌ها..." lines={3} />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : items.length === 0 ? (
        <CoreEmpty message="اعلان جدیدی ندارید." />
      ) : (
        <ul className="divide-y divide-border" data-testid="core-widget-notification-list">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-2.5 text-sm">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  isUnread(item) ? 'bg-primary' : 'bg-muted',
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate',
                    isUnread(item) ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {item.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {formatNotificationTime(item.createdAt)}
                </span>
              </span>
              {isUnread(item) && <span className="sr-only">خوانده‌نشده</span>}
            </li>
          ))}
        </ul>
      )}
    </CoreWidgetCard>
  );
}

/* -------------------------------------------------------------------------- */
/* reminders                                                                   */
/* -------------------------------------------------------------------------- */

const loadReminders = () => listUpcomingReminders(WIDGET_LIST_SIZE);

/**
 * Upcoming reminders over the existing 49I contract (D7).
 *
 * Presentation matches `UpcomingPanel` in `CoreCalendarView` — same Jalali day string,
 * same `formatReminderTime` pill — so the same reminder does not look like two
 * different things in two places.
 */
function RemindersWidget() {
  const { items, isLoading, error, reload } = useWidgetList<ReminderItem>(
    loadReminders,
    'دریافت یادآوری‌های پیش رو با خطا مواجه شد.',
  );

  return (
    <CoreWidgetCard
      id="reminders"
      title={WIDGET_LABELS.reminders}
      icon={CalendarClock}
      wide={isWideWidget('reminders')}
      action={{ href: '/admin/calendar', label: 'تقویم و یادآورها' }}
    >
      {isLoading ? (
        <CoreLoading label="در حال بارگذاری یادآورها..." lines={3} />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : items.length === 0 ? (
        <CoreEmpty message="یادآوری پیش رو ندارید." />
      ) : (
        <ul className="divide-y divide-border" data-testid="core-widget-reminder-list">
          {items.map((reminder) => (
            <li key={reminder.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {toPersianDigits(reminder.date)}
              </span>
              <span className="shrink-0 rounded-lg bg-secondary px-2 py-0.5 text-[11px]">
                {formatReminderTime(reminder)}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{reminder.title}</span>
            </li>
          ))}
        </ul>
      )}
    </CoreWidgetCard>
  );
}

/* -------------------------------------------------------------------------- */
/* registry binding                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Registry id → component. `Record<WidgetId, …>` on purpose: adding an id to
 * `WIDGET_IDS` without a component here is a COMPILE error, so the registry and the
 * renderable set cannot drift.
 */
export const WIDGET_COMPONENTS: Record<WidgetId, CoreWidgetComponent> = {
  identity: IdentityWidget,
  access: AccessWidget,
  notifications: NotificationsWidget,
  reminders: RemindersWidget,
};



