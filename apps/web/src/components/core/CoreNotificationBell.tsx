'use client';

import * as React from 'react';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import Link from 'next/link';
import { Bell, Check, CheckCheck } from 'lucide-react';

import { CoreApiError, hasLocalSession } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  formatNotificationTime,
  formatUnreadBadge,
  getUnreadCount,
  isUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/notifications-api';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreLoading } from './CoreStates';

/**
 * Phase 49E: header notification bell + unread badge + panel.
 *
 * Reads `GET /notifications/unread-count` for the badge and lazily loads the
 * first page of `GET /notifications` only when the panel is opened, so the
 * header never pulls a list it might not display.
 *
 * Failure policy: a failed unread-count read must NEVER break the header. The
 * count silently falls back to zero (no badge, no error surface) — the bell stays
 * usable and the error is only ever shown inside the opened panel, where the user
 * actually asked for the data.
 *
 * All content is rendered as text. There is no `dangerouslySetInnerHTML`
 * anywhere: notification titles/bodies are plain text by contract (the backend
 * rejects markup) and are treated as untrusted here regardless.
 */

/** Small page for the panel; the full list lives at /admin/notifications. */
const PANEL_PAGE_SIZE = 8;

/** Badge refresh cadence while the panel is closed. */
const POLL_INTERVAL_MS = 60_000;

export function CoreNotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [unreadCount, setUnreadCount] = React.useState(0);

  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [isMutating, setIsMutating] = React.useState(false);
  // Re-arms loading/cleared in the panel-open handler and the retry button
  // (same commit as the token bump), so the panel effect needs no in-effect
  // setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const panelRef = React.useRef<HTMLDivElement>(null);

  /**
   * Badge refresh. Deliberately swallows every error: an unreachable or
   * unauthorized count endpoint leaves the header intact with no badge.
   *
   * Promise form (no `try/catch`): the setters live only in settle callbacks,
   * so calling this from the mount/poll effect holds no synchronously
   * reachable setState (`react-hooks/set-state-in-effect` — a `catch` block
   * can run synchronously if the call throws).
   */
  const refreshCount = React.useCallback(() => {
    if (!hasLocalSession()) return Promise.resolve();
    return getUnreadCount()
      .then((result) => {
        setUnreadCount(Math.max(0, result?.count ?? 0));
      })
      .catch(() => {
        setUnreadCount(0);
      });
  }, []);

  React.useEffect(() => {
    void refreshCount();

    const handle = setInterval(() => {
      void refreshCount();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refreshCount]);

  // The list is fetched only while the panel is open. Arming happens in the
  // open handler below (same commit), so this effect only settles.
  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;

    listNotifications({ limit: PANEL_PAGE_SIZE })
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
        setError(
          err instanceof CoreApiError || err instanceof Error
            ? err.message
            : 'دریافت اعلان‌ها با خطا مواجه شد.',
        );
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, reloadToken]);

  // Outside click / Escape close, matching the user menu behaviour.
  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleMarkRead = async (id: string) => {
    setIsMutating(true);
    try {
      const result = await markNotificationRead(id);
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, readAt: result.readAt } : item)),
      );
      await refreshCount();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ثبت خوانده‌شدن اعلان با خطا مواجه شد.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleMarkAllRead = async () => {
    setIsMutating(true);
    try {
      await markAllNotificationsRead();
      const stamp = new Date().toISOString();
      setItems((prev) => prev.map((item) => (item.readAt ? item : { ...item, readAt: stamp })));
      await refreshCount();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ثبت خوانده‌شدن اعلان‌ها با خطا مواجه شد.');
    } finally {
      setIsMutating(false);
    }
  };

  const badge = formatUnreadBadge(unreadCount);
  const hasUnreadInPanel = items.some(isUnread);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          // Opening re-arms the panel fetch in the same commit (the removed
          // in-effect setters used to arm one render later); closing needs no
          // arm — the effect early-returns.
          if (!open) {
            setIsLoading(true);
            setError(null);
          }
          setOpen((value) => !value);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `اعلان‌ها، ${unreadCount} اعلان خوانده‌نشده` : 'اعلان‌ها'}
        data-testid="notification-bell"
        className="relative flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {badge && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 end-0.5 min-w-[18px] rounded-full bg-destructive px-1 text-[10px] font-bold leading-[18px] text-destructive-foreground"
          >
            {badge}
          </span>
        )}
      </button>

      <DropdownPanel
        open={open}
        role="dialog"
          aria-label="اعلان‌ها"
          data-testid="notification-panel"
        className="absolute end-0 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-elevated"
      >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-foreground">اعلان‌ها</span>
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              disabled={isMutating || !hasUnreadInPanel}
              data-testid="notification-mark-all"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-primary transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              خواندن همه
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {isLoading && (
              <div className="px-4 py-4">
                <CoreLoading label="در حال بارگذاری اعلان‌ها..." lines={3} />
              </div>
            )}

            {!isLoading && error && (
              <div className="px-4 py-4">
                <CoreError message={error} onRetry={reload} />
              </div>
            )}

            {!isLoading && !error && items.length === 0 && (
              <div className="px-4 py-4">
                <CoreEmpty message="اعلانی برای نمایش وجود ندارد." />
              </div>
            )}

            {!isLoading && !error && items.length > 0 && (
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li
                    key={item.id}
                    data-testid="notification-item"
                    data-unread={isUnread(item) ? 'true' : 'false'}
                    className={cn('px-4 py-3', isUnread(item) && 'bg-primary/5')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {item.body}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {formatNotificationTime(item.createdAt)}
                        </p>
                      </div>
                      {isUnread(item) && (
                        <button
                          type="button"
                          onClick={() => void handleMarkRead(item.id)}
                          disabled={isMutating}
                          aria-label={`خوانده شد: ${item.title}`}
                          className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border px-4 py-3 text-center">
            <Link
              href="/admin/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {hasMore ? 'مشاهده همه اعلان‌ها' : 'مرکز اعلان‌ها'}
            </Link>
          </div>
      </DropdownPanel>
    </div>
  );
}

