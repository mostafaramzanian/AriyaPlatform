'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  getCalendarMonth,
  JALALI_MONTHS,
  JALALI_WEEKDAYS_SHORT,
  nextMonth,
  parseDateKey,
  previousMonth,
  toPersianDigits,
  yearOptions,
  type CalendarMonth,
} from '@/lib/calendar-api';
import { CoreError, CoreLoading } from './CoreStates';
import { hasOfficialHoliday, isSpecialRedHoliday, primaryOccasion } from '@/lib/calendar-occasions';

/**
 * Phase 49I: Jalali date picker.
 *
 * Built on the existing Core design language rather than a third-party calendar. The
 * repository has no date-picker dependency (audited: no react-day-picker, no
 * moment-jalaali, no date-fns-jalali; `@radix-ui/react-popover` is installed but
 * unused anywhere in apps/web), and every existing overlay in the Core UI — the
 * notification panel — is a plain `role="dialog"` div. This follows that precedent
 * instead of introducing a new UI dependency for one surface.
 *
 * The GRID IS SERVER-DERIVED. `GET /calendar/month` supplies the day count, the
 * weekday of the 1st, which day is today and the per-day reminder count, so the client
 * never does Jalali arithmetic and can never disagree with the server about what day
 * it is. That is the same reason the date chip does not read the browser clock.
 *
 * Accessibility: `role="grid"` with `gridcell` buttons, arrow-key navigation, Enter or
 * Space to select, Escape to close, `aria-selected` on the selection and a text marker
 * (not colour alone) for today.
 */

export interface CoreJalaliDatePickerProps {
  /** Currently selected day, `YYYY/MM/DD` Latin digits, or null. */
  value: string | null;
  onSelect: (date: string) => void;
  /** The month to open on, so the picker can start on the selection. */
  initialMonth: { jy: number; jm: number };
  /** Today's key, used for the "برو به امروز" control. */
  todayKey: string;
  className?: string;
}

export function CoreJalaliDatePicker({
  value,
  onSelect,
  initialMonth,
  todayKey,
  className,
}: CoreJalaliDatePickerProps) {
  const [view, setView] = React.useState(initialMonth);
  const [month, setMonth] = React.useState<CalendarMonth | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the month-nav/today/retry handlers (same
  // commit), so the month effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  /** The day that owns keyboard focus. Roving tabindex over the grid. */
  const [focusedDay, setFocusedDay] = React.useState<number | null>(null);

  const gridRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;

    getCalendarMonth(view.jy, view.jm)
      .then((result) => {
        if (!cancelled) setMonth(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'دریافت تقویم با خطا مواجه شد.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [view.jy, view.jm, reloadToken]);

  // Keep the roving focus inside the rendered month: a month change must not
  // leave focus pointing at a day that no longer exists (31 → Esfand's 29).
  // The clamp/seeding runs during render, guarded by comparing the derived
  // value against the state it writes — never as an effect-body setter
  // (`react-hooks/set-state-in-effect`).
  const selectedForFocus = parseDateKey(value ?? '');
  const desiredFocus =
    focusedDay !== null
      ? month
        ? Math.min(focusedDay, month.dayCount)
        : focusedDay
      : month
        ? Math.min(
            selectedForFocus &&
            selectedForFocus.jy === month.jy &&
            selectedForFocus.jm === month.jm
              ? selectedForFocus.jd
              : (month.days.find((day) => day.isToday)?.jd ?? 1),
            month.dayCount,
          )
        : null;
  if (desiredFocus !== focusedDay) {
    setFocusedDay(desiredFocus);
  }

  const goToToday = () => {
    const today = parseDateKey(todayKey);
    if (!today) return;

    // Re-arm the month fetch in the same handler commit (the removed in-effect
    // setters used to arm one render later).
    setIsLoading(true);
    setError(null);
    setView({ jy: today.jy, jm: today.jm });
    setFocusedDay(today.jd);
    onSelect(todayKey);
  };

  /** Month navigation re-arms in the same handler commit. */
  const changeMonth = (next: { jy: number; jm: number }) => {
    setIsLoading(true);
    setError(null);
    setView(next);
  };

  return (
    <div
      data-testid="jalali-date-picker"
      // Phase 49I-2: the width is CONTAINER-DRIVEN (`w-full`), never viewport-based.
      // The previous `w-[min(20rem,calc(100vw-2rem))]` ignored the enclosing card and
      // pinned the mini calendar flush against the sidebar's right edge; sizing from
      // the parent (sidebar card, popover surface, or bottom sheet) gives every host
      // breathing room without absolute positioning or negative margins.
      className={cn('w-full p-3', className)}
    >
      <PickerHeader view={view} onChange={changeMonth} />

      <button
        type="button"
        onClick={goToToday}
        data-testid="jalali-today-button"
        className="mt-2 w-full rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        برو به امروز
      </button>

      {isLoading && <CoreLoading label="در حال بارگذاری تقویم..." lines={4} className="mt-3" />}

      {!isLoading && error && (
        <div className="mt-3">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {!isLoading && !error && month && (
        <MonthGrid
          gridRef={gridRef}
          month={month}
          value={value}
          focusedDay={focusedDay}
          onFocusDay={setFocusedDay}
          onSelect={onSelect}
          onChangeView={changeMonth}
        />
      )}
    </div>
  );
}

/**
 * Month/year selectors plus prev/next.
 *
 * RTL note: `ChevronRight` moves BACK and `ChevronLeft` moves FORWARD, because the
 * reading direction is right-to-left. The `aria-label`s state the action in words, so
 * the meaning does not depend on the glyph.
 */
function PickerHeader({
  view,
  onChange,
}: {
  view: { jy: number; jm: number };
  onChange: (next: { jy: number; jm: number }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(previousMonth(view.jy, view.jm))}
        aria-label="ماه قبل"
        data-testid="jalali-prev-month"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>

      <select
        value={view.jm}
        onChange={(event) => onChange({ ...view, jm: Number(event.target.value) })}
        aria-label="انتخاب ماه"
        data-testid="jalali-month-select"
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {JALALI_MONTHS.map((name, index) => (
          <option key={name} value={index + 1}>
            {name}
          </option>
        ))}
      </select>

      <select
        value={view.jy}
        onChange={(event) => onChange({ ...view, jy: Number(event.target.value) })}
        aria-label="انتخاب سال"
        data-testid="jalali-year-select"
        className="w-[5.5rem] shrink-0 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {yearOptions(view.jy).map((year) => (
          <option key={year} value={year}>
            {toPersianDigits(year)}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => onChange(nextMonth(view.jy, view.jm))}
        aria-label="ماه بعد"
        data-testid="jalali-next-month"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The day grid.
 *
 * `role="grid"` with one `gridcell` button per day. Arrow keys move by one day or one
 * week and roll into the adjacent month, matching what a user expects from a calendar;
 * Home/End jump to the first/last day of the month.
 */
function MonthGrid({
  gridRef,
  month,
  value,
  focusedDay,
  onFocusDay,
  onSelect,
  onChangeView,
}: {
  gridRef: React.RefObject<HTMLDivElement>;
  month: CalendarMonth;
  value: string | null;
  focusedDay: number | null;
  onFocusDay: (day: number) => void;
  onSelect: (date: string) => void;
  onChangeView: (next: { jy: number; jm: number }) => void;
}) {
  // Moves focus by `delta` days, rolling into the neighbouring month when the target
  // falls outside the current one.
  const move = (day: number, delta: number) => {
    const target = day + delta;

    if (target < 1) {
      const previous = previousMonth(month.jy, month.jm);
      onChangeView(previous);
      // The new month's length is unknown until it loads, so focus resets to its last
      // day via the clamp in the parent effect.
      onFocusDay(31);
      return;
    }

    if (target > month.dayCount) {
      onChangeView(nextMonth(month.jy, month.jm));
      onFocusDay(1);
      return;
    }

    onFocusDay(target);
  };

  const handleKeyDown = (event: React.KeyboardEvent, day: number) => {
    // RTL: ArrowLeft advances and ArrowRight goes back, mirroring the visual order.
    const deltas: Record<string, number> = {
      ArrowLeft: 1,
      ArrowRight: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };

    if (event.key in deltas) {
      event.preventDefault();
      move(day, deltas[event.key]);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      onFocusDay(1);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      onFocusDay(month.dayCount);
    }
  };

  return (
    // Phase 49I-2: `mt-4` gives the grid its own visual block below the header, and
    // the weekday row is separated from the dates by a hairline (`border-b`) rather
    // than a heavy border — subtle separation, in line with the reference layout.
    <div className="mt-4">
      <div
        role="row"
        className="mb-2 grid grid-cols-7 gap-1.5 border-b border-border/60 pb-2 text-center text-[11px] font-medium text-muted-foreground"
      >
        {JALALI_WEEKDAYS_SHORT.map((label, index) => (
          <span key={label} role="columnheader" aria-label={`روز ${index + 1} هفته`}>
            {label}
          </span>
        ))}
      </div>

      <div ref={gridRef} role="grid" aria-label="تقویم" className="grid grid-cols-7 gap-1.5">
        {/* Leading blanks so the 1st lands on its real weekday column. */}
        {Array.from({ length: month.startWeekday }).map((_, index) => (
          <span key={`blank-${index}`} aria-hidden="true" />
        ))}

        {month.days.map((day) => {
          const isSelected = value === day.date;
          const isFocused = focusedDay === day.jd;
          const holidayToday = hasOfficialHoliday(day.occasions);
          // Phase 49I-1 §FRIDAY LOGIC: special red applies ONLY to a real official
          // holiday that is NOT Friday. Friday keeps its normal styling.
          const isSpecialHoliday = isSpecialRedHoliday(day.weekday, holidayToday);
          const top = primaryOccasion(day.occasions);
          const extraCount = day.occasions.length - 1;

          // Accessible label must carry the holiday reason, never rely on colour.
          const occasionLabel =
            day.occasions.length > 0
              ? `، ${day.occasions.map((o) => o.title).join('، ')}`
              : '';
          const holidayLabel = isSpecialHoliday ? '، تعطیل رسمی' : '';

          return (
            <button
              key={day.date}
              type="button"
              role="gridcell"
              // Roving tabindex: exactly one day is tabbable, so Tab does not walk 31
              // controls.
              tabIndex={isFocused ? 0 : -1}
              aria-selected={isSelected}
              aria-label={`${day.weekdayName} ${day.jd} ${day.monthName} ${day.jy}${
                day.reminderCount > 0 ? `، ${day.reminderCount} یادآوری` : ''
              }${occasionLabel}${holidayLabel}${day.isToday ? '، امروز' : ''}`}
              data-testid="jalali-day"
              data-date={day.date}
              data-today={day.isToday ? 'true' : 'false'}
              data-selected={isSelected ? 'true' : 'false'}
              data-holiday={isSpecialHoliday ? 'true' : 'false'}
              data-has-occasion={day.occasions.length > 0 ? 'true' : 'false'}
              onClick={() => {
                onFocusDay(day.jd);
                onSelect(day.date);
              }}
              onKeyDown={(event) => handleKeyDown(event, day.jd)}
              ref={(node) => {
                // Focus follows the roving index, but only once the grid already owns
                // focus — otherwise opening the picker would steal it from the trigger.
                if (isFocused && node && gridRef.current?.contains(document.activeElement)) {
                  node.focus();
                }
              }}
              className={cn(
                // Phase 49I-2: taller, airier cells (`min-h-10 py-1.5`) so a day with
                // an occasion title under it still breathes; the selected day is a
                // prominent rounded highlight (filled + subtle shadow) that remains
                // clearly distinct from today's ring + dotted-underline treatment.
                'relative flex min-h-10 w-full min-w-[2rem] flex-col items-center justify-center rounded-lg px-0.5 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                  : 'text-foreground hover:bg-secondary',
                // Today is marked by a ring AND by the underline+dot below, so the
                // state never depends on colour alone.
                day.isToday && !isSelected && 'ring-1 ring-primary',
              )}
            >
              <span
                className={cn(
                  'leading-none',
                  // Red holiday number for a non-Friday official holiday. A small
                  // dot below (not colour) also marks the special state for greyscale.
                  isSpecialHoliday && !isSelected && 'font-semibold text-red-600',
                  day.isToday && !isSelected && 'underline decoration-dotted',
                )}
                data-testid="jalali-day-number"
              >
                {toPersianDigits(day.jd)}
              </span>

              {/* Holiday reason directly under the date (non-Friday only). */}
              {isSpecialHoliday && top ? (
                <span
                  data-testid="jalali-day-holiday"
                  className={cn(
                    'mt-0.5 block max-w-full truncate text-[9px] leading-tight',
                    isSelected ? 'text-primary-foreground' : 'text-red-600',
                  )}
                >
                  {top.title}
                </span>
              ) : (
                // Non-holiday occasions use the calendar's secondary text treatment.
                day.occasions.length > 0 &&
                !isSpecialHoliday && (
                  <span
                    data-testid="jalali-day-occasion"
                    className={cn(
                      'mt-0.5 block max-w-full truncate text-[9px] leading-tight',
                      isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {top?.title}
                  </span>
                )
              )}

              {/* "+N" for the occasions that will not fit — compact, accessible. */}
              {extraCount > 0 && (
                <span
                  data-testid="jalali-day-more"
                  className={cn(
                    'text-[8px] leading-none',
                    isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                  )}
                >
                  {`+${toPersianDigits(extraCount)}`}
                </span>
              )}

              {day.reminderCount > 0 && (
                <span
                  aria-hidden="true"
                  data-testid="jalali-day-marker"
                  className={cn(
                    'absolute bottom-0.5 h-1 w-1 rounded-full',
                    isSelected ? 'bg-primary-foreground' : 'bg-primary',
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
