'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  formatJalaliLabel,
  getCalendarToday,
  toPersianDigits,
  type CalendarDay,
} from '@/lib/calendar-api';
import { hasLocalSession } from '@/lib/core-http';
import { CoreJalaliDatePicker } from './CoreJalaliDatePicker';
import { DropdownPanel } from '@/components/ui/dropdown-panel';

/**
 * Phase 49I: the persistent Sidebar date chip.
 *
 * Shows today's Jalali date and opens the Jalali date picker. Selecting a day sends the
 * user to `/admin/calendar?date=…`, so the chip is the entry point to the calendar
 * surface rather than a second, parallel implementation of it.
 *
 * THE DATE COMES FROM THE SERVER (`GET /calendar/today`). It is deliberately not
 * computed in the browser: a client clock in a different timezone would disagree with
 * the instant a reminder is actually stored against, and the chip is what the user
 * schedules from. `Asia/Tehran` is applied server-side and the client cannot override
 * it. The value also refreshes across midnight — a timer re-fetches when the local day
 * would roll — so a tab left open overnight does not keep showing yesterday.
 *
 * Collapsed rail: the chip degrades to the day NUMBER with an accessible name carrying
 * the full date, rather than being hidden. Mobile: the surface is a bottom sheet, so it
 * cannot render outside the viewport.
 */

export interface CoreDateChipProps {
  collapsed: boolean;
  /** Drawer variant renders the sheet full-width, like the mobile surface. */
  variant?: 'desktop' | 'drawer';
  /** Called after navigation so the mobile drawer can close itself. */
  onNavigate?: () => void;
  className?: string;
}

export function CoreDateChip({
  collapsed,
  variant = 'desktop',
  onNavigate,
  className,
}: CoreDateChipProps) {
  const router = useRouter();
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const [open, setOpen] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Skip the request entirely when there is no local session: the rail renders
    // before/while auth resolves, and a pointless 401 would be logged as an error.
    if (!hasLocalSession()) return;

    let cancelled = false;

    getCalendarToday()
      .then((result) => {
        if (!cancelled) setToday(result);
      })
      // A failed chip must never break the rail. It simply renders nothing.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Midnight rollover: re-fetch shortly after the local day changes. The server stays
  // authoritative — this only decides WHEN to ask again.
  React.useEffect(() => {
    if (!today) return;

    const now = new Date();
    const nextLocalMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      5,
    );

    const timer = setTimeout(
      () => setReloadToken((token) => token + 1),
      Math.max(nextLocalMidnight.getTime() - now.getTime(), 1000),
    );

    return () => clearTimeout(timer);
  }, [today]);

  // Escape closes and focus returns to the chip; a click outside closes too.
  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  if (!today) return null;

  const label = formatJalaliLabel(today);

  const handleSelect = (date: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    router.push(`/admin/calendar?date=${encodeURIComponent(date)}`);
    onNavigate?.();
  };

  return (
    <div className={cn('relative', className)}>
      <ChipTrigger
        ref={triggerRef}
        today={today}
        label={label}
        collapsed={collapsed}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />

      <DateChipSurface open={open} ref={surfaceRef} variant={variant}>
        <CoreJalaliDatePicker
          value={today.date}
          initialMonth={{ jy: today.jy, jm: today.jm }}
          todayKey={today.date}
          onSelect={handleSelect}
        />
      </DateChipSurface>
    </div>
  );
}

/**
 * The chip itself: a real `<button>`, so it is keyboard-operable and announced as a
 * control without any ARIA patching.
 */
const ChipTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    today: CalendarDay;
    label: string;
    collapsed: boolean;
    open: boolean;
    onToggle: () => void;
  }
>(function ChipTrigger({ today, label, collapsed, open, onToggle }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      // The accessible name always carries the full date, including when the rail is
      // collapsed and only the day number is painted.
      aria-label={`تقویم — ${today.weekdayName} ${label}`}
      title={`${today.weekdayName} ${label}`}
      data-testid="core-date-chip"
      data-date={today.date}
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl border border-sidebar-foreground/10 bg-sidebar-foreground/5 text-start transition hover:bg-sidebar-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow',
        // ≥32px touch target in both states.
        collapsed ? 'h-11 w-11 justify-center p-0' : 'min-h-[44px] px-2.5 py-2',
      )}
    >
      <span
        aria-hidden="true"
        className="gradient-primary grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold text-primary-foreground"
      >
        {toPersianDigits(today.jd)}
      </span>

      {!collapsed && (
        <span className="min-w-0 leading-tight">
          <span
            data-testid="core-date-chip-label"
            className="block truncate text-[13px] font-semibold text-sidebar-foreground"
          >
            {label}
          </span>
          <span className="block text-[11px] text-sidebar-foreground/50">
            {today.weekdayName}
          </span>
        </span>
      )}
    </button>
  );
});

/**
 * The overlay surface.
 *
 * Two presentations, chosen by viewport rather than by a media-query hook so there is
 * no hydration flash:
 *  - `lg:` and up → a popover anchored above the chip, opening toward the content area
 *    (`end-0` is the LEFT edge under `dir="rtl"`, i.e. away from the rail edge);
 *  - below `lg:` → a fixed bottom sheet pinned to the viewport, which is what keeps the
 *    calendar inside the screen on a 390px device and inside the mobile drawer.
 *
 * `role="dialog"` + `aria-modal={false}`: it is a non-modal surface, matching the
 * existing notification panel. Escape and outside-click closing, plus focus return, are
 * handled by the parent.
 */
const DateChipSurface = React.forwardRef<
  HTMLDivElement,
  { open: boolean; variant: 'desktop' | 'drawer'; children: React.ReactNode }
>(function DateChipSurface({ open, variant, children }, ref) {
  return (
    <DropdownPanel
      open={open}
      ref={ref}
      role="dialog"
      aria-modal={false}
      aria-label="انتخاب تاریخ"
      data-testid="core-date-chip-surface"
      data-variant={variant}
      className={cn(
        'z-50 overflow-hidden border border-border bg-popover text-popover-foreground shadow-elevated',
        // Mobile / drawer: bottom sheet. `inset-x-0` guarantees it never exceeds the
        // viewport width, so there is no horizontal overflow at 390px.
        'fixed inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl',
        // Desktop rail: popover above the chip. Phase 49I-2 (visual QA fix): `start-0`
        // — under `dir="rtl"` that is `right: 0`, so the surface is anchored at its
        // RIGHT edge and opens toward the content area. The previous `end-0`
        // (`left: 0`) made the popover grow toward the rail and overflow the
        // viewport's right edge by its full width (~53px beyond 1440px in QA).
        'lg:absolute lg:inset-x-auto lg:bottom-full lg:start-0 lg:mb-2 lg:max-h-none lg:w-80 lg:rounded-xl',
      )}
    >
      {children}
    </DropdownPanel>
  );
});
