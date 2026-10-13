import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 49I: Calendar / Reminders client.
 *
 * Mirrors the backend contract exactly (`GET /calendar/today`,
 * `GET /calendar/month`, `GET /calendar/reminders`, `POST /calendar/reminders`,
 * `PATCH /calendar/reminders/:id`, `DELETE /calendar/reminders/:id`).
 *
 * No function here accepts a `userId` or a tenant identifier: the backend derives the
 * owner from the authenticated identity and the DTOs run under `forbidNonWhitelisted`,
 * so sending one would be rejected. The client is structurally incapable of asking for
 * someone else's reminders.
 *
 * THE DATE CONTRACT: a reminder is always sent as a Jalali day plus a wall-clock time
 * in LATIN digits (`1405/08/18`, `14:30`), never as a timestamp. The server applies
 * `Asia/Tehran`. Persian digits exist only for display, produced by `toPersianDigits`
 * at render time — they are never sent over the wire.
 */

/** A Jalali day as the server describes it. */
export interface CalendarDay {
  /** `YYYY/MM/DD`, Latin digits. The stable key sent back to the API. */
  date: string;
  jy: number;
  jm: number;
  jd: number;
  monthName: string;
  weekdayName: string;
  /** 0 = شنبه … 6 = جمعه. */
  weekday: number;
}

/** One official occasion/holiday returned by the backend (Phase 49I-1). */
export interface CalendarOccasion {
  /** `YYYY/MM/DD`, Latin digits — the same key a reminder `date` uses. */
  date: string;
  title: string;
  description: string | null;
  /** The DATA answer "is this a state holiday". Never derived from the weekday. */
  isHoliday: boolean;
  category: string;
  sourceYear: number;
}

export interface CalendarMonthDay extends CalendarDay {
  isToday: boolean;
  reminderCount: number;
  /** This day's official occasions/holidays, from `GET /calendar/month`. */
  occasions: CalendarOccasion[];
}

export interface CalendarMonth {
  jy: number;
  jm: number;
  monthName: string;
  /** Weekday index of the 1st, used to offset the grid. */
  startWeekday: number;
  dayCount: number;
  today: CalendarDay;
  days: CalendarMonthDay[];
  /** The whole month's official occasions/holidays (also attached per day). */
  occasions: CalendarOccasion[];
}

export interface ReminderItem {
  id: string;
  title: string;
  note: string | null;
  /** Canonical instant, as an ISO string. Display uses `date`/`time` instead. */
  dueAt: string;
  /** Jalali day, `YYYY/MM/DD`, Latin digits. */
  date: string;
  /** `HH:mm`, Latin digits. Null for an all-day reminder. */
  time: string | null;
  allDay: boolean;
  enabled: boolean;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderDayResult {
  day: CalendarDay;
  items: ReminderItem[];
}

export interface ReminderListResult {
  items: ReminderItem[];
  hasMore: boolean;
}

export interface CreateReminderInput {
  title: string;
  /** Jalali `YYYY/MM/DD`, Latin digits. */
  date: string;
  /** `HH:mm`. Omitted when `allDay` is true. */
  time?: string;
  note?: string;
  allDay?: boolean;
  enabled?: boolean;
}

export type UpdateReminderInput = Partial<CreateReminderInput>;

/** Backend default and cap; mirrored so the UI never asks for more. */
export const REMINDER_PAGE_SIZE = 20;
export const REMINDER_MAX_PAGE_SIZE = 100;

export const MAX_REMINDER_TITLE = 160;
export const MAX_REMINDER_NOTE = 1000;

/** Persian month names, in order. Used for the month/year selectors. */
export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;

/** Persian weekday names in calendar order, starting with شنبه. */
export const JALALI_WEEKDAYS = [
  'شنبه',
  'یکشنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
] as const;

/** Two-letter weekday headers for the compact grid. */
export const JALALI_WEEKDAYS_SHORT = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'] as const;

export async function getCalendarToday(): Promise<CalendarDay> {
  return coreGet<CalendarDay>('/calendar/today');
}

export async function getCalendarMonth(jy: number, jm: number): Promise<CalendarMonth> {
  return coreGet<CalendarMonth>(`/calendar/month?jy=${jy}&jm=${jm}`);
}

export async function listRemindersForDay(date: string): Promise<ReminderDayResult> {
  return coreGet<ReminderDayResult>(`/calendar/reminders?date=${encodeURIComponent(date)}`);
}

export async function listUpcomingReminders(limit?: number): Promise<ReminderListResult> {
  const capped = Math.min(limit ?? REMINDER_PAGE_SIZE, REMINDER_MAX_PAGE_SIZE);
  return coreGet<ReminderListResult>(`/calendar/reminders?limit=${capped}`);
}

export async function createReminder(input: CreateReminderInput): Promise<ReminderItem> {
  return corePost<ReminderItem>('/calendar/reminders', input);
}

export async function updateReminder(
  id: string,
  input: UpdateReminderInput,
): Promise<ReminderItem> {
  return corePatch<ReminderItem>(`/calendar/reminders/${encodeURIComponent(id)}`, input);
}

/**
 * Enable/disable shortcut. A thin wrapper over the same PATCH, so there is one write
 * path for every reminder mutation.
 */
export async function setReminderEnabled(id: string, enabled: boolean): Promise<ReminderItem> {
  return updateReminder(id, { enabled });
}

export async function deleteReminder(id: string): Promise<{ id: string; deleted: true }> {
  return coreDelete<{ id: string; deleted: true }>(
    `/calendar/reminders/${encodeURIComponent(id)}`,
  );
}

/* ------------------------------------------------------------------------- */
/* Presentation helpers. Display-only: nothing below is ever sent to the API. */
/* ------------------------------------------------------------------------- */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/**
 * Latin → Persian digits, for display.
 *
 * The API contract is Latin-only, so this is applied at render time and never to a
 * value on its way out. Keeping the two directions separate is what prevents a Persian
 * numeral ever reaching a query string.
 */
export function toPersianDigits(value: string | number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/** Persian → Latin digits, for normalising anything typed by a user. */
export function toLatinDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)));
}

/** Splits a `YYYY/MM/DD` key. Returns null for anything malformed. */
export function parseDateKey(date: string): { jy: number; jm: number; jd: number } | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(toLatinDigits(date).trim());
  if (!match) return null;

  return { jy: Number(match[1]), jm: Number(match[2]), jd: Number(match[3]) };
}

/** Builds the `YYYY/MM/DD` wire key. Always Latin digits. */
export function formatDateKey(jy: number, jm: number, jd: number): string {
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

/**
 * `۱۸ آبان ۱۴۰۵` — the compact label used by the date chip and the selected-day
 * heading. Falls back to the raw key rather than throwing, so a malformed value is
 * visible instead of crashing the view.
 */
export function formatJalaliLabel(date: Pick<CalendarDay, 'jd' | 'jm' | 'jy'>): string {
  return `${toPersianDigits(date.jd)} ${JALALI_MONTHS[date.jm - 1]} ${toPersianDigits(date.jy)}`;
}

/** `دوشنبه ۱۸ آبان ۱۴۰۵` — the full label for the selected day. */
export function formatJalaliLongLabel(date: CalendarDay): string {
  return `${date.weekdayName} ${formatJalaliLabel(date)}`;
}

/** `۱۴:۳۰` for display. Returns the all-day label when there is no clock time. */
export function formatReminderTime(reminder: Pick<ReminderItem, 'allDay' | 'time'>): string {
  if (reminder.allDay || !reminder.time) return 'تمام روز';
  return toPersianDigits(reminder.time);
}

/**
 * The year range the year selector offers.
 *
 * Bounded around the current year rather than spanning the API's full 1300–1500
 * window: a reminder is a near-term thing, and a 200-entry dropdown is not usable.
 */
export function yearOptions(currentYear: number, span = 5): number[] {
  return Array.from({ length: span * 2 + 1 }, (_, index) => currentYear - span + index);
}

/** Previous (jy, jm), rolling the year. */
export function previousMonth(jy: number, jm: number): { jy: number; jm: number } {
  return jm === 1 ? { jy: jy - 1, jm: 12 } : { jy, jm: jm - 1 };
}

/** Next (jy, jm), rolling the year. */
export function nextMonth(jy: number, jm: number): { jy: number; jm: number } {
  return jm === 12 ? { jy: jy + 1, jm: 1 } : { jy, jm: jm + 1 };
}
