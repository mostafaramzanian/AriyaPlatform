'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import {
  deleteReminder,
  formatJalaliLongLabel,
  formatReminderTime,
  getCalendarMonth,
  getCalendarToday,
  listRemindersForDay,
  listUpcomingReminders,
  parseDateKey,
  setReminderEnabled,
  toPersianDigits,
  type CalendarDay,
  type CalendarOccasion,
  type ReminderItem,
} from '@/lib/calendar-api';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreJalaliDatePicker } from './CoreJalaliDatePicker';
import { CoreEmpty, CoreError, CoreLoading } from './CoreStates';
import { CoreReminderForm } from './CoreReminderForm';

/**
 * Phase 49I: the calendar surface at `/admin/calendar`.
 *
 * Regions: the Jalali month grid (sidebar), the selected day's official occasions
 * («مناسبت‌های روز», Phase 49I-2) and reminder list, and a bounded "upcoming" list.
 * The selected day comes from `?date=…` so the sidebar chip can deep link into it and
 * a reload preserves the selection.
 *
 * Everything Jalali is server-derived (see CoreJalaliDatePicker): the client never does
 * calendar arithmetic, so it cannot disagree with the server about what day it is or how
 * long a month is.
 *
 * Phase 49I-2 (presentation-only): the sidebar card uses the density tokens
 * (`p-core-card`) and the picker is container-driven, so the mini calendar no longer
 * sits flush against the viewport edge; the occasions of the selected day get their
 * own section BELOW the grid — official holidays («تعطیل رسمی») first, then the other
 * official occasions — while personal reminders remain a SEPARATE section. No API
 * contract changed: occasions come from the existing `GET /calendar/month` payload.
 *
 * This is deliberately NOT a full enterprise agenda: there is no week view, no drag to
 * reschedule and no organization events.
 */

export function CoreCalendarView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const [todayError, setTodayError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  const requestedDate = searchParams?.get('date') ?? null;
  // A malformed `?date=` is ignored rather than shown as an error: the URL is not a
  // form, and today is always a safe fallback.
  const selectedDate =
    requestedDate && parseDateKey(requestedDate) ? requestedDate : (today?.date ?? null);

  React.useEffect(() => {
    let cancelled = false;

    getCalendarToday()
      .then((result) => {
        if (!cancelled) setToday(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTodayError(err instanceof Error ? err.message : 'دریافت تاریخ امروز با خطا مواجه شد.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectDate = (date: string) => {
    // Replace, not push: moving around the calendar should not fill the back stack.
    router.replace(`/admin/calendar?date=${encodeURIComponent(date)}`);
  };

  if (todayError) {
    return <CoreError message={todayError} onRetry={() => setReloadToken((token) => token + 1)} />;
  }

  if (!today || !selectedDate) {
    return <CoreLoading label="در حال بارگذاری تقویم..." lines={5} />;
  }

  const selectedParts = parseDateKey(selectedDate)!;

  return (
    <div className="space-y-6">
      {/* Phase 49I-2: `min-w-0` on the grid track lets the sidebar shrink instead of
          pushing the mini calendar against the viewport edge. */}
      <div className="grid min-w-0 gap-core-gap lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section
          aria-labelledby="calendar-heading"
          data-testid="calendar-card"
          // Token padding (not `p-4`): the same density-aware breathing room the rest
          // of the Core cards use, so the mini calendar never touches the card edge.
          className="core-card min-w-0 p-core-card"
        >
          <h2 id="calendar-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
            تقویم
          </h2>

          <CoreJalaliDatePicker
            value={selectedDate}
            initialMonth={{ jy: selectedParts.jy, jm: selectedParts.jm }}
            todayKey={today.date}
            onSelect={selectDate}
            className="w-full"
          />
        </section>

        {/* The right column stacks the selected day's occasions BELOW the grid (that
            is exactly where they land on mobile too, when the columns collapse) and
            keeps personal reminders in their own separate section. */}
        <div className="min-w-0 space-y-core-gap">
          {/* Keys must be unique per sibling: both sections reset on the selected
              date, so each carries its own prefix. Two siblings sharing the same
              key made React duplicate the occasions section on day change. */}
          <SelectedDayOccasions key={`occasions-${selectedDate}`} date={selectedDate} />

          <SelectedDayPanel
            key={`reminders-${selectedDate}`}
            date={selectedDate}
            onChanged={() => setReloadToken((token) => token + 1)}
          />
        </div>
      </div>

      <UpcomingPanel reloadToken={reloadToken} />
    </div>
  );
}

/**
 * The selected day's official occasions («مناسبت‌های روز») — Phase 49I-2.
 *
 * Read from the EXISTING `GET /calendar/month` payload (no new endpoint, no contract
 * change): the month that contains the selected date is fetched once per selected day
 * and only that day's occasions are shown. This is deliberately keyed to the SELECTED
 * date rather than the picker's currently browsed month, so the section stays truthful
 * when the user navigates the mini calendar away and back.
 *
 * ORDER (the 49I-2 contract): official holidays («تعطیل رسمی») first, then the other
 * official occasions. A stable sort keeps the server's `sortOrder` inside each group.
 * Personal reminders are NOT listed here — they stay in their own section below, so
 * state-issued calendar data and the user's own plans never blur into one list.
 *
 * Colour is never the only holiday signal: the holiday row carries the literal text
 * «تعطیل رسمی» and a `data-holiday` marker, alongside the red accent.
 */
function SelectedDayOccasions({ date }: { date: string }) {
  const parts = parseDateKey(date)!;
  const [occasions, setOccasions] = React.useState<CalendarOccasion[] | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the month effect needs no in-effect setter resets. First mount
  // (and every remount, since the parent keys this section on `date`) is
  // covered by the initial `isLoading: true`.
  const { token, reload } = useReloadToken(setIsLoading, setError);

  React.useEffect(() => {
    let cancelled = false;

    getCalendarMonth(parts.jy, parts.jm)
      .then((month) => {
        if (cancelled) return;
        setOccasions(month.days.find((day) => day.date === date)?.occasions ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'دریافت مناسبت‌های روز با خطا مواجه شد.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [date, parts.jy, parts.jm, token]);

  const ordered = React.useMemo(
    () => [...(occasions ?? [])].sort((a, b) => Number(b.isHoliday) - Number(a.isHoliday)),
    [occasions],
  );

  return (
    <section
      aria-labelledby="day-occasions-heading"
      data-testid="day-occasions"
      className="core-card min-w-0 p-core-card"
    >
      <h2 id="day-occasions-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
        مناسبت‌های روز
      </h2>

      <div className="mt-3">
        {isLoading && <CoreLoading label="در حال بارگذاری مناسبت‌ها..." lines={2} />}

        {!isLoading && error && (
          <CoreError message={error} onRetry={reload} />
        )}

        {!isLoading && !error && ordered.length === 0 && (
          <div data-testid="day-occasions-empty">
            {/* Subtle empty state: quieter than the reminder empty state, because a day
                without occasions is the common case, not a problem to solve. */}
            <CoreEmpty message="مناسبتی برای این روز ثبت نشده است." className="px-4 py-6" />
          </div>
        )}

        {!isLoading && !error && ordered.length > 0 && (
          <ul className="space-y-2" data-testid="day-occasions-list">
            {ordered.map((occasion) => (
              <li
                key={`${occasion.date}-${occasion.title}`}
                data-testid="day-occasion-item"
                data-holiday={occasion.isHoliday ? 'true' : 'false'}
                className={cn(
                  'flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5',
                  occasion.isHoliday
                    ? 'border-red-600/20 bg-red-600/5'
                    : 'border-border/60 bg-surface-muted/40',
                )}
              >
                <div className="min-w-0">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      occasion.isHoliday && 'text-red-600',
                    )}
                  >
                    {occasion.title}
                  </p>
                  {occasion.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {occasion.description}
                    </p>
                  )}
                </div>

                {occasion.isHoliday ? (
                  // The literal label — not colour — is the accessible holiday signal.
                  <span
                    data-testid="day-occasion-holiday"
                    className="shrink-0 rounded-lg bg-red-600/10 px-2 py-0.5 text-[11px] font-semibold text-red-600"
                  >
                    تعطیل رسمی
                  </span>
                ) : (
                  <span className="shrink-0 rounded-lg bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                    مناسبت
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The selected day: its reminders plus the create form.
 *
 * Keyed on the date in the parent, so switching days remounts and refetches instead of
 * reconciling stale state.
 */
function SelectedDayPanel({ date, onChanged }: { date: string; onChanged: () => void }) {
  const [day, setDay] = React.useState<CalendarDay | null>(null);
  const [items, setItems] = React.useState<ReminderItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  /** Blocking: the day could not be read at all, so there is no list to show. */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  /**
   * Non-blocking: a mutation failed. Kept separate from `loadError` on purpose — a
   * failed delete must not hide the rows that are still there, which is exactly what a
   * single error state would do.
   */
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [mutatingId, setMutatingId] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the day effect needs no in-effect setter resets. First mount
  // (and every remount — the parent keys this panel on `date`) is covered by
  // the initial `isLoading: true`.
  const { token, reload } = useReloadToken(setIsLoading, setLoadError);

  React.useEffect(() => {
    let cancelled = false;

    listRemindersForDay(date)
      .then((result) => {
        if (cancelled) return;
        setDay(result.day);
        setItems(result.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'دریافت یادآوری‌ها با خطا مواجه شد.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [date, token]);

  const handleToggle = async (reminder: ReminderItem) => {
    setMutatingId(reminder.id);
    setActionError(null);

    try {
      const updated = await setReminderEnabled(reminder.id, !reminder.enabled);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'تغییر وضعیت یادآوری با خطا مواجه شد.');
    } finally {
      setMutatingId(null);
    }
  };

  const handleDelete = async (reminder: ReminderItem) => {
    setMutatingId(reminder.id);
    setActionError(null);

    try {
      await deleteReminder(reminder.id);
      setItems((current) => current.filter((item) => item.id !== reminder.id));
      setNotice('یادآوری حذف شد.');
      onChanged();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'حذف یادآوری با خطا مواجه شد.');
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <section aria-labelledby="selected-day-heading" className="core-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="selected-day-heading" className="text-sm font-semibold" data-testid="selected-day">
          {day ? `یادآوری‌های ${formatJalaliLongLabel(day)}` : 'یادآوری‌ها'}
        </h2>

        <button
          type="button"
          onClick={() => {
            setFormOpen((value) => !value);
            setNotice(null);
          }}
          aria-expanded={formOpen}
          data-testid="reminder-create-toggle"
          className="btn-primary inline-flex min-h-[36px] items-center gap-1.5 px-3 text-xs"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          ایجاد یادآوری
        </button>
      </div>

      {formOpen && (
        <CoreReminderForm
          date={date}
          dayLabel={day ? formatJalaliLongLabel(day) : date}
          onCancel={() => setFormOpen(false)}
          onCreated={() => {
            setFormOpen(false);
            setNotice('یادآوری با موفقیت ثبت شد.');
            // Re-arm + bump in this handler's commit (the removed in-effect
            // setters used to arm one render later).
            reload();
            onChanged();
          }}
          className="mt-4"
        />
      )}

      {notice && (
        <p
          role="status"
          data-testid="reminder-notice"
          className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground"
        >
          {notice}
        </p>
      )}

      {/* A mutation failure is shown ABOVE the list and leaves it intact. */}
      {actionError && (
        <div className="mt-4" data-testid="reminder-action-error">
          <Alert type="error" message={actionError} />
        </div>
      )}

      <div className="mt-4">
        {isLoading && <CoreLoading label="در حال بارگذاری یادآوری‌ها..." lines={3} />}

        {!isLoading && loadError && (
          <CoreError message={loadError} onRetry={reload} />
        )}

        {!isLoading && !loadError && items.length === 0 && (
          <CoreEmpty message="برای این روز یادآوری‌ای ثبت نشده است." />
        )}

        {!isLoading && !loadError && items.length > 0 && (
          <ul className="divide-y divide-border" data-testid="reminder-list">
            {items.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                isMutating={mutatingId === reminder.id}
                onToggle={() => void handleToggle(reminder)}
                onDelete={() => void handleDelete(reminder)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One reminder row: time, title, state, and the two owner controls.
 *
 * State is never colour-only — a disabled reminder is labelled «غیرفعال» in text and
 * carries `data-enabled`, so the distinction survives greyscale and screen readers.
 */
function ReminderRow({
  reminder,
  isMutating,
  onToggle,
  onDelete,
}: {
  reminder: ReminderItem;
  isMutating: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid="reminder-item"
      data-reminder-id={reminder.id}
      data-enabled={reminder.enabled ? 'true' : 'false'}
      data-delivered={reminder.deliveredAt ? 'true' : 'false'}
      className="flex flex-wrap items-start gap-3 py-3"
    >
      <span
        data-testid="reminder-time"
        className="shrink-0 rounded-lg bg-secondary px-2 py-1 text-[11px] font-semibold text-foreground"
      >
        {formatReminderTime(reminder)}
      </span>

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', !reminder.enabled && 'text-muted-foreground')}>
          {reminder.title}
        </p>

        {reminder.note && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{reminder.note}</p>
        )}

        <p className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {!reminder.enabled && <span data-testid="reminder-disabled-label">غیرفعال</span>}
          {reminder.deliveredAt && <span data-testid="reminder-delivered-label">اعلان ارسال شد</span>}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          disabled={isMutating}
          data-testid="reminder-toggle"
          aria-label={`${reminder.enabled ? 'غیرفعال کردن' : 'فعال کردن'} یادآوری ${reminder.title}`}
          className="min-h-[32px] rounded-lg border border-border px-2 text-[11px] text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {reminder.enabled ? 'غیرفعال' : 'فعال'}
        </button>

        <button
          type="button"
          onClick={onDelete}
          disabled={isMutating}
          data-testid="reminder-delete"
          aria-label={`حذف یادآوری ${reminder.title}`}
          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/**
 * The bounded "upcoming" list.
 *
 * Explicitly capped by the API's page size: there is no unbounded history read in the
 * contract, so there is none here either.
 */
function UpcomingPanel({ reloadToken }: { reloadToken: number }) {
  const [items, setItems] = React.useState<ReminderItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump) and for parent-driven invalidations (the prop adjustment below).
  const { token, reload } = useReloadToken(setIsLoading, setError);
  // The parent bumps `reloadToken` after a day-list mutation; re-arm in the
  // same render the new prop arrives — never in the effect body
  // (`react-hooks/set-state-in-effect`). Mount is covered by the initial
  // `isLoading: true`.
  const [prevReloadToken, setPrevReloadToken] = React.useState(reloadToken);
  if (prevReloadToken !== reloadToken) {
    setPrevReloadToken(reloadToken);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    listUpcomingReminders()
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setHasMore(result.hasMore);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'دریافت یادآوری‌های پیش رو با خطا مواجه شد.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken, token]);

  return (
    <section aria-labelledby="upcoming-heading" className="core-card p-4">
      <h2 id="upcoming-heading" className="text-sm font-semibold">
        یادآوری‌های پیش رو
      </h2>

      <div className="mt-4">
        {isLoading && <CoreLoading label="در حال بارگذاری یادآوری‌های پیش رو..." lines={3} />}

        {!isLoading && error && (
          <CoreError message={error} onRetry={reload} />
        )}

        {!isLoading && !error && items.length === 0 && (
          <CoreEmpty message="یادآوری‌ای پیش رو ندارید." />
        )}

        {!isLoading && !error && items.length > 0 && (
          <ul className="divide-y divide-border" data-testid="upcoming-list">
            {items.map((reminder) => (
              <li key={reminder.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {toPersianDigits(reminder.date)}
                </span>
                <span className="shrink-0 rounded-lg bg-secondary px-2 py-0.5 text-[11px]">
                  {formatReminderTime(reminder)}
                </span>
                <span className="min-w-0 flex-1 truncate">{reminder.title}</span>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            فهرست محدود است؛ برای دیدن بقیه، روز مورد نظر را در تقویم انتخاب کنید.
          </p>
        )}
      </div>
    </section>
  );
}
