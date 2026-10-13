'use client';

import * as React from 'react';
import { Check, CheckCheck } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  NOTIFICATION_PAGE_SIZE,
  formatNotificationTime,
  getUnreadCount,
  isUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
  type NotificationState,
} from '@/lib/notifications-api';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49E: full Notification Center page.
 *
 * Read + mark-read only over the caller's own notifications. There is no
 * recipient selector, no compose form and no delivery channel: the client cannot
 * author a notification, and no request from here carries a user or tenant
 * identifier — scope comes exclusively from the authenticated identity.
 *
 * Pagination mirrors the repository convention used by the directory list: a
 * cursor stack over `{ items, hasMore }`, so the whole history is never loaded
 * client-side.
 *
 * Titles and bodies are rendered as text. No `dangerouslySetInnerHTML`.
 */

type StateFilter = 'all' | NotificationState;

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: 'all', label: 'همه' },
  { value: 'unread', label: 'خوانده‌نشده' },
  { value: 'read', label: 'خوانده‌شده' },
];

export function CoreNotificationsView() {
  const [filter, setFilter] = React.useState<StateFilter>('all');
  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // Cursor stack: index i holds the cursor used to fetch page i (undefined = first page).
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  const [unreadCount, setUnreadCount] = React.useState<number | null>(null);
  const [isMutating, setIsMutating] = React.useState(false);
  // Re-arms loading/cleared in the retry handler and mark-all (same commit as
  // the token bump), so the list effect needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const currentCursor = cursors[cursors.length - 1];

  // A filter change invalidates the cursor stack: a cursor from a different
  // predicate would point into a different result set — and it re-arms the list
  // load. Applied during render, guarded by the previous filter: mount is a
  // no-op, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`.
  const [prevFilter, setPrevFilter] = React.useState(filter);
  if (prevFilter !== filter) {
    setPrevFilter(filter);
    setCursors([undefined]);
    setIsLoading(true);
    setError(null);
  }

  const refreshCount = React.useCallback(() => {
    // Promise form: the setters live only in settle callbacks, so calling this
    // from the mount/reload effect holds no synchronously reachable setState
    // (`react-hooks/set-state-in-effect` — a `catch` block can run
    // synchronously if the call throws).
    return getUnreadCount()
      .then((result) => {
        setUnreadCount(Math.max(0, result?.count ?? 0));
      })
      .catch(() => {
        // The header owns the authoritative badge; a failed count here is not an
        // error state for the page.
        setUnreadCount(null);
      });
  }, []);

  React.useEffect(() => {
    void refreshCount();
  }, [refreshCount, reloadToken]);

  React.useEffect(() => {
    let cancelled = false;

    listNotifications({
      cursor: currentCursor,
      limit: NOTIFICATION_PAGE_SIZE,
      ...(filter === 'all' ? {} : { state: filter }),
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items ?? []);
        setHasMore(Boolean(result.hasMore));
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setHasMore(false);
        setError({
          message: err instanceof Error ? err.message : 'دریافت اعلان‌ها با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentCursor, filter, reloadToken]);

  const handleMarkRead = async (id: string) => {
    setIsMutating(true);
    try {
      const result = await markNotificationRead(id);
      setItems((prev) =>
        // On the `unread` tab a read row no longer belongs to the result set, so
        // it is dropped instead of being shown in a contradictory state.
        filter === 'unread'
          ? prev.filter((item) => item.id !== id)
          : prev.map((item) => (item.id === id ? { ...item, readAt: result.readAt } : item)),
      );
      await refreshCount();
    } catch (err: unknown) {
      setError({
        message: err instanceof Error ? err.message : 'ثبت خوانده‌شدن اعلان با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    } finally {
      setIsMutating(false);
    }
  };

  const handleMarkAllRead = async () => {
    setIsMutating(true);
    try {
      await markAllNotificationsRead();
      // A full reload rather than a local patch: mark-all affects rows beyond the
      // current page, so the page is re-read from the server.
      setCursors([undefined]);
      reload();
    } catch (err: unknown) {
      setError({
        message: err instanceof Error ? err.message : 'ثبت خوانده‌شدن اعلان‌ها با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    } finally {
      setIsMutating(false);
    }
  };

  const goNext = () => {
    const last = items[items.length - 1];
    if (!hasMore || !last) return;
    // Re-arm in the same handler commit (the removed in-effect setters used to
    // arm one render later).
    setIsLoading(true);
    setError(null);
    setCursors((prev) => [...prev, last.id]);
  };

  const goPrevious = () => {
    if (cursors.length <= 1) return;
    setIsLoading(true);
    setError(null);
    setCursors((prev) => prev.slice(0, -1));
  };

  if (error?.status === 403) {
    return <CoreForbidden message="شما به مرکز اعلان‌ها دسترسی ندارید." />;
  }

  const hasUnreadOnPage = items.some(isUnread);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">مرکز اعلان‌ها</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            اعلان‌های شخصی شما
            {unreadCount !== null && unreadCount > 0
              ? ` — ${unreadCount.toLocaleString('fa-IR')} خوانده‌نشده`
              : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleMarkAllRead()}
          disabled={isMutating || isLoading || !hasUnreadOnPage}
          data-testid="notifications-mark-all"
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
          خواندن همه
        </button>
      </header>

      <div
        role="group"
        aria-label="فیلتر وضعیت اعلان"
        className="flex flex-wrap gap-2"
        data-testid="notifications-filters"
      >
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            aria-pressed={filter === option.value}
            className={cn(
              'rounded-xl border px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              filter === option.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="core-card p-4 sm:p-core-card" data-testid="notifications-skeleton">
          <CoreLoading label="در حال بارگذاری اعلان‌ها..." lines={6} />
        </div>
      )}

      {!isLoading && error && (
        <CoreError message={error.message} onRetry={reload} />
      )}

      {!isLoading && !error && items.length === 0 && (
        <CoreEmpty
          message={
            filter === 'unread'
              ? 'اعلان خوانده‌نشده‌ای ندارید.'
              : filter === 'read'
                ? 'اعلان خوانده‌شده‌ای ندارید.'
                : 'اعلانی برای نمایش وجود ندارد.'
          }
        />
      )}

      {!isLoading && !error && items.length > 0 && (
        <ul className="space-y-3" data-testid="notifications-list">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="notification-row"
              data-unread={isUnread(item) ? 'true' : 'false'}
              className={cn(
                'core-card flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:p-5',
                isUnread(item) && 'border-primary/40 bg-primary/5',
              )}
            >
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{item.title}</h2>
                  {isUnread(item) && (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                      جدید
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-line break-words text-sm text-muted-foreground">
                  {item.body}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatNotificationTime(item.createdAt)}
                </p>
              </div>

              {isUnread(item) && (
                <button
                  type="button"
                  onClick={() => void handleMarkRead(item.id)}
                  disabled={isMutating}
                  className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  خوانده شد
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!error && (cursors.length > 1 || hasMore) && (
        <nav className="flex items-center justify-between gap-3" aria-label="صفحه‌بندی اعلان‌ها">
          <button
            type="button"
            onClick={goPrevious}
            disabled={cursors.length === 1 || isLoading}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            صفحه قبل
          </button>
          <span className="text-xs text-muted-foreground">
            صفحه {cursors.length.toLocaleString('fa-IR')}
          </span>
          <button
            type="button"
            onClick={goNext}
            disabled={!hasMore || isLoading}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            صفحه بعد
          </button>
        </nav>
      )}
    </div>
  );
}

