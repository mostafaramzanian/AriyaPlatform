'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  createReminder,
  MAX_REMINDER_NOTE,
  MAX_REMINDER_TITLE,
  toLatinDigits,
} from '@/lib/calendar-api';
import { Alert } from '@/components/ui/alert';

/**
 * Phase 49I: create-reminder form for the selected day.
 *
 * The DATE IS NOT EDITABLE HERE. It is inherited from the day the user selected in the
 * calendar, exactly as the contract specifies, so there is no second place to pick a
 * date and no way for the form to disagree with the selection.
 *
 * The time input is a native `<input type="time">`: it is keyboard-accessible, gives
 * mobile a real time wheel, and — importantly — always yields a Latin `HH:mm` value,
 * which is exactly the wire format. Anything typed is additionally normalised through
 * `toLatinDigits` before being sent, so a Persian numeral can never reach the API.
 *
 * Client-side validation mirrors the server's rules but never replaces them: the server
 * re-validates the title length, the note length, the Jalali date and the past-instant
 * rule, and its message is what the user sees when it refuses.
 */

export interface CoreReminderFormProps {
  /** Jalali `YYYY/MM/DD`, inherited from the selected day. */
  date: string;
  /** Human label for the inherited date, e.g. «دوشنبه ۱۸ آبان ۱۴۰۵». */
  dayLabel: string;
  onCreated: () => void;
  onCancel: () => void;
  className?: string;
}

export function CoreReminderForm({
  date,
  dayLabel,
  onCreated,
  onCancel,
  className,
}: CoreReminderFormProps) {
  const [title, setTitle] = React.useState('');
  const [time, setTime] = React.useState('');
  const [note, setNote] = React.useState('');
  const [allDay, setAllDay] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const titleRef = React.useRef<HTMLInputElement>(null);

  // Focus the first field when the form appears, so keyboard users are not left at the
  // toggle they just activated.
  React.useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedTitle = title.trim();

    if (trimmedTitle.length === 0) {
      setError('عنوان یادآوری الزامی است.');
      return;
    }

    if (!allDay && time.trim().length === 0) {
      setError('برای یادآوری زمان‌دار، وارد کردن ساعت الزامی است.');
      return;
    }

    setIsSubmitting(true);

    try {
      await createReminder({
        title: trimmedTitle,
        date,
        // Omitted entirely for an all-day reminder: the server refuses the combination
        // rather than ignoring one of the two.
        ...(allDay ? { allDay: true } : { time: toLatinDigits(time.trim()) }),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });

      onCreated();
    } catch (err: unknown) {
      // The server's message is shown as-is: it is the authority on why a reminder was
      // refused (past moment, invalid date, bounds).
      setError(err instanceof Error ? err.message : 'ثبت یادآوری با خطا مواجه شد.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      // Native constraint validation is turned OFF deliberately: the browser's bubble is
      // English, unstyled and RTL-unaware, whereas the checks below produce the same
      // Persian messages as every other Core form. `required` is kept on the fields for
      // assistive technology, but this component owns the refusal.
      noValidate
      data-testid="reminder-form"
      aria-label="ایجاد یادآوری"
      className={cn('space-y-3 rounded-xl border border-border bg-muted/30 p-3', className)}
    >
      <div>
        <label htmlFor="reminder-title" className="mb-1 block text-xs text-muted-foreground">
          عنوان
        </label>
        <input
          ref={titleRef}
          id="reminder-title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_REMINDER_TITLE}
          required
          data-testid="reminder-title-input"
          className="min-h-[36px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-xs text-muted-foreground">تاریخ</span>
          {/* Read-only by design: the date is the day selected in the calendar. */}
          <p
            data-testid="reminder-form-date"
            data-date={date}
            className="min-h-[36px] rounded-lg border border-dashed border-border px-3 py-2 text-sm text-foreground"
          >
            {dayLabel}
          </p>
        </div>

        <div>
          <label htmlFor="reminder-time" className="mb-1 block text-xs text-muted-foreground">
            زمان
          </label>
          <input
            id="reminder-time"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            disabled={allDay}
            required={!allDay}
            data-testid="reminder-time-input"
            className="min-h-[36px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        </div>
      </div>

      <label className="flex min-h-[32px] items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(event) => {
            setAllDay(event.target.checked);
            // Clearing the time is what makes the two mutually exclusive on the wire.
            if (event.target.checked) setTime('');
          }}
          data-testid="reminder-allday-input"
          className="h-4 w-4 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        تمام روز
      </label>

      <div>
        <label htmlFor="reminder-note" className="mb-1 block text-xs text-muted-foreground">
          یادداشت (اختیاری)
        </label>
        <textarea
          id="reminder-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={MAX_REMINDER_NOTE}
          rows={2}
          data-testid="reminder-note-input"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {error && (
        <div data-testid="reminder-form-error">
          <Alert type="error" message={error} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="reminder-submit"
          className="btn-primary min-h-[36px] px-4 text-xs disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? 'در حال ذخیره...' : 'ذخیره یادآوری'}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="reminder-cancel"
          className="min-h-[36px] rounded-lg border border-border px-4 text-xs text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          انصراف
        </button>
      </div>
    </form>
  );
}
