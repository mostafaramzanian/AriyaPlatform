'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  TICKET_PAGE_SIZE,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  formatTicketTime,
  getTicketByTrackingNumber,
  listTickets,
  ticketUserName,
  type Ticket,
  type TicketStatus,
  type TicketType,
} from '@/lib/support-api';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49G: Support ticket list.
 *
 * Read-only discovery over `GET /tickets`. What a caller sees is decided entirely
 * server-side: a requester gets their own tickets, an agent gets their tenant. This
 * view sends no requester or tenant identifier and has no "view as" control, so it
 * cannot ask for someone else's tickets.
 *
 * Pagination mirrors the convention used by the directory (49D-1) and notification
 * (49E) lists: a cursor stack over `{ items, hasMore }`, so the whole ticket history
 * is never loaded client-side.
 *
 * Subjects and bodies are rendered as text. No `dangerouslySetInnerHTML`.
 */

const STATUS_FILTERS: Array<{ value: TicketStatus | 'all'; label: string }> = [
  { value: 'all', label: 'همه' },
  { value: 'NEW', label: TICKET_STATUS_LABELS.NEW },
  { value: 'IN_PROGRESS', label: TICKET_STATUS_LABELS.IN_PROGRESS },
  { value: 'WAITING_FOR_REQUESTER', label: TICKET_STATUS_LABELS.WAITING_FOR_REQUESTER },
  { value: 'RESOLVED', label: TICKET_STATUS_LABELS.RESOLVED },
  { value: 'CLOSED', label: TICKET_STATUS_LABELS.CLOSED },
];

/** Terminal and near-terminal states are visually de-emphasised, never hidden. */
const STATUS_TONE: Record<TicketStatus, string> = {
  NEW: 'border-primary/40 bg-primary/10 text-primary',
  TRIAGED: 'border-primary/30 bg-primary/5 text-primary',
  ASSIGNED: 'border-primary/30 bg-primary/5 text-primary',
  IN_PROGRESS: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  WAITING_FOR_REQUESTER: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  RESOLVED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  CLOSED: 'border-border bg-muted text-muted-foreground',
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      data-testid="ticket-status"
      className={cn('rounded-full border px-2.5 py-0.5 text-[11px]', STATUS_TONE[status])}
    >
      {TICKET_STATUS_LABELS[status]}
    </span>
  );
}

export function CoreSupportView() {
  const [status, setStatus] = React.useState<TicketStatus | 'all'>('all');
  const [type, setType] = React.useState<TicketType | 'all'>('all');
  const [trackingInput, setTrackingInput] = React.useState('');
  const [trackingError, setTrackingError] = React.useState<string | null>(null);
  const [isTracking, setIsTracking] = React.useState(false);

  const [items, setItems] = React.useState<Ticket[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // Cursor stack: index i holds the cursor used to fetch page i (undefined = first).
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the pagination/retry handlers below (same commit
  // as the token bump), so the list effect needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [resolvedTicketId, setResolvedTicketId] = React.useState<string | null>(null);

  const currentCursor = cursors[cursors.length - 1];

  // A filter change invalidates the cursor stack: a cursor from a different
  // predicate would point into a different result set — and it re-arms the list
  // load. Applied during render, guarded by the previous filters: mount is a
  // no-op, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`.
  const [prevPred, setPrevPred] = React.useState({ status, type });
  if (prevPred.status !== status || prevPred.type !== type) {
    setPrevPred({ status, type });
    setCursors([undefined]);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    listTickets({
      cursor: currentCursor,
      limit: TICKET_PAGE_SIZE,
      ...(status === 'all' ? {} : { status }),
      ...(type === 'all' ? {} : { type }),
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
          message: err instanceof Error ? err.message : 'دریافت تیکت‌ها با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentCursor, status, type, reloadToken]);

  /**
   * Tracking-number lookup. A miss and a foreign-tenant hit are both 404 on the
   * backend, so exactly one message is shown for either — this box cannot be used to
   * probe whether a number belongs to someone else.
   */
  const handleTrackingLookup = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = trackingInput.trim();
    if (value.length === 0) return;

    setIsTracking(true);
    setTrackingError(null);
    setResolvedTicketId(null);

    try {
      const ticket = await getTicketByTrackingNumber(value);
      setResolvedTicketId(ticket.id);
    } catch {
      setTrackingError('تیکتی با این شماره پیگیری برای شما یافت نشد.');
    } finally {
      setIsTracking(false);
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
    return <CoreForbidden message="شما به بخش پشتیبانی دسترسی ندارید." />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">پشتیبانی</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            تیکت‌های پشتیبانی، پیشنهادها و شکایت‌ها
          </p>
        </div>

        <Link
          href="/admin/support/new"
          data-testid="ticket-new"
          className="inline-flex items-center gap-2 rounded-xl border border-primary bg-primary/10 px-4 py-2 text-sm text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          تیکت جدید
        </Link>
      </header>

      <form
        onSubmit={handleTrackingLookup}
        className="core-card flex flex-wrap items-end gap-3 p-4"
        data-testid="ticket-tracking-form"
      >
        <div className="min-w-[220px] flex-1">
          <label htmlFor="ticket-tracking" className="text-xs text-muted-foreground">
            پیگیری با شماره تیکت
          </label>
          <input
            id="ticket-tracking"
            type="text"
            value={trackingInput}
            onChange={(event) => setTrackingInput(event.target.value)}
            placeholder="TK-XXXXXXXXXX"
            dir="ltr"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={isTracking || trackingInput.trim().length === 0}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          جست‌وجو
        </button>

        {resolvedTicketId && (
          <Link
            href={`/admin/support/${resolvedTicketId}`}
            data-testid="ticket-tracking-hit"
            className="text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            مشاهده تیکت یافت‌شده
          </Link>
        )}
        {trackingError && (
          <p role="status" className="text-sm text-muted-foreground">
            {trackingError}
          </p>
        )}
      </form>

      <div className="flex flex-wrap gap-4">
        <div role="group" aria-label="فیلتر وضعیت تیکت" className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setStatus(option.value)}
              aria-pressed={status === option.value}
              className={cn(
                'rounded-xl border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                status === option.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="min-w-[180px]">
          <label htmlFor="ticket-type-filter" className="sr-only">
            فیلتر نوع تیکت
          </label>
          <select
            id="ticket-type-filter"
            value={type}
            onChange={(event) => setType(event.target.value as TicketType | 'all')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">همه انواع</option>
            {(Object.keys(TICKET_TYPE_LABELS) as TicketType[]).map((value) => (
              <option key={value} value={value}>
                {TICKET_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && (
        <div className="core-card p-4 sm:p-core-card" data-testid="tickets-skeleton">
          <CoreLoading label="در حال بارگذاری تیکت‌ها..." lines={6} />
        </div>
      )}

      {!isLoading && error && (
        <CoreError message={error.message} onRetry={reload} />
      )}

      {!isLoading && !error && items.length === 0 && (
        <CoreEmpty message="تیکتی برای نمایش وجود ندارد." />
      )}

      {!isLoading && !error && items.length > 0 && (
        <ul className="space-y-3" data-testid="tickets-list">
          {items.map((ticket) => (
            <li key={ticket.id} data-testid="ticket-row" className="core-card p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/support/${ticket.id}`}
                      /*
                       * 49G-2: `inline-flex` + `min-h-[2rem]` gives the row's primary
                       * link a 32px tap target at mobile widths. Previously it was a
                       * bare inline link and collapsed to its 20px line box. Typography
                       * and hierarchy are unchanged — only the interactive box grows,
                       * and `-my-1` absorbs the extra height so the row does not shift.
                       */
                      className="-my-1 inline-flex min-h-[2rem] items-center text-sm font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {ticket.subject}
                    </Link>
                    <TicketStatusBadge status={ticket.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span dir="ltr">{ticket.trackingNumber}</span>
                    {' · '}
                    {TICKET_TYPE_LABELS[ticket.type]}
                    {' · '}
                    {TICKET_PRIORITY_LABELS[ticket.priority]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ثبت‌کننده: {ticketUserName(ticket.requester)}
                    {' · '}
                    کارشناس: {ticketUserName(ticket.assignee)}
                  </p>
                </div>

                <p className="shrink-0 text-xs text-muted-foreground">
                  {formatTicketTime(ticket.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!error && (cursors.length > 1 || hasMore) && (
        <nav className="flex items-center justify-between gap-3" aria-label="صفحه‌بندی تیکت‌ها">
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

