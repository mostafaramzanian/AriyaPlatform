import {
  formatDateKey,
  formatJalaliLabel,
  formatJalaliLongLabel,
  formatReminderTime,
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  nextMonth,
  parseDateKey,
  previousMonth,
  REMINDER_MAX_PAGE_SIZE,
  toLatinDigits,
  toPersianDigits,
  yearOptions,
} from '../calendar-api';
import { coreGet, corePatch, corePost, coreDelete } from '../core-http';

/**
 * Phase 49I coverage for the calendar client.
 *
 * The invariant being protected: PERSIAN DIGITS ARE DISPLAY-ONLY. Every request path is
 * asserted to carry Latin-digit `YYYY/MM/DD`, and the display helpers are asserted to
 * produce Persian — so the two directions cannot be confused.
 */

jest.mock('../core-http', () => ({
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
  coreDelete: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;
const deleteMock = coreDelete as jest.MockedFunction<typeof coreDelete>;

const DAY = {
  date: '1405/08/18',
  jy: 1405,
  jm: 8,
  jd: 18,
  monthName: 'آبان',
  weekdayName: 'یکشنبه',
  weekday: 1,
};

describe('calendar-api — digit direction', () => {
  it('converts Latin digits to Persian for display', () => {
    expect(toPersianDigits('1405/08/18')).toBe('۱۴۰۵/۰۸/۱۸');
    expect(toPersianDigits(1405)).toBe('۱۴۰۵');
    expect(toPersianDigits('14:30')).toBe('۱۴:۳۰');
  });

  it('converts Persian digits back to Latin for the wire', () => {
    expect(toLatinDigits('۱۴۰۵/۰۸/۱۸')).toBe('1405/08/18');
    expect(toLatinDigits('۱۴:۳۰')).toBe('14:30');
    // Already-Latin input is unchanged, so the helper is safe to apply twice.
    expect(toLatinDigits('14:30')).toBe('14:30');
  });

  it('leaves non-digit characters alone in both directions', () => {
    expect(toPersianDigits('آبان ۱۴۰۵')).toBe('آبان ۱۴۰۵');
    expect(toLatinDigits('آبان 1405')).toBe('آبان 1405');
  });
});

describe('calendar-api — date keys', () => {
  it('formats a zero-padded Latin key', () => {
    expect(formatDateKey(1405, 8, 18)).toBe('1405/08/18');
    expect(formatDateKey(1405, 1, 1)).toBe('1405/01/01');
  });

  it('parses a Latin key', () => {
    expect(parseDateKey('1405/08/18')).toEqual({ jy: 1405, jm: 8, jd: 18 });
  });

  it('tolerates a Persian-digit key from user input by normalising it', () => {
    expect(parseDateKey('۱۴۰۵/۰۸/۱۸')).toEqual({ jy: 1405, jm: 8, jd: 18 });
  });

  it('returns null for anything malformed rather than guessing', () => {
    for (const value of ['1405-08-18', '1405/8/18', '', 'today', '1405/08']) {
      expect(parseDateKey(value)).toBeNull();
    }
  });
});

describe('calendar-api — display labels', () => {
  it('builds the compact chip label', () => {
    expect(formatJalaliLabel(DAY)).toBe('۱۸ آبان ۱۴۰۵');
  });

  it('builds the full selected-day label', () => {
    expect(formatJalaliLongLabel(DAY)).toBe('یکشنبه ۱۸ آبان ۱۴۰۵');
  });

  it('renders a timed reminder in Persian digits', () => {
    expect(formatReminderTime({ allDay: false, time: '14:30' })).toBe('۱۴:۳۰');
  });

  it('labels an all-day reminder instead of inventing a clock time', () => {
    expect(formatReminderTime({ allDay: true, time: null })).toBe('تمام روز');
    // Defensive: a stray time on an all-day reminder is still not shown.
    expect(formatReminderTime({ allDay: true, time: '00:00' })).toBe('تمام روز');
  });

  it('exposes twelve months and seven weekdays, starting with شنبه', () => {
    expect(JALALI_MONTHS).toHaveLength(12);
    expect(JALALI_MONTHS[0]).toBe('فروردین');
    expect(JALALI_MONTHS[11]).toBe('اسفند');

    expect(JALALI_WEEKDAYS).toHaveLength(7);
    expect(JALALI_WEEKDAYS[0]).toBe('شنبه');
  });
});

describe('calendar-api — month arithmetic', () => {
  it('rolls the year backwards and forwards', () => {
    expect(previousMonth(1405, 1)).toEqual({ jy: 1404, jm: 12 });
    expect(previousMonth(1405, 8)).toEqual({ jy: 1405, jm: 7 });
    expect(nextMonth(1405, 12)).toEqual({ jy: 1406, jm: 1 });
    expect(nextMonth(1405, 8)).toEqual({ jy: 1405, jm: 9 });
  });

  it('offers a bounded, centred year list', () => {
    const years = yearOptions(1405);

    expect(years).toHaveLength(11);
    expect(years[0]).toBe(1400);
    expect(years[10]).toBe(1410);
  });
});

describe('calendar-api — request paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMock.mockResolvedValue({} as never);
    postMock.mockResolvedValue({} as never);
    patchMock.mockResolvedValue({} as never);
    deleteMock.mockResolvedValue({} as never);
  });

  it('reads today from the server', async () => {
    const { getCalendarToday } = await import('../calendar-api');
    await getCalendarToday();

    expect(getMock).toHaveBeenCalledWith('/calendar/today');
  });

  it('reads a month by Jalali year and month', async () => {
    const { getCalendarMonth } = await import('../calendar-api');
    await getCalendarMonth(1405, 8);

    expect(getMock).toHaveBeenCalledWith('/calendar/month?jy=1405&jm=8');
  });

  it('reads a day with an encoded Latin-digit key', async () => {
    const { listRemindersForDay } = await import('../calendar-api');
    await listRemindersForDay('1405/08/18');

    expect(getMock).toHaveBeenCalledWith('/calendar/reminders?date=1405%2F08%2F18');
  });

  it('caps the upcoming page size instead of forwarding an oversized limit', async () => {
    const { listUpcomingReminders } = await import('../calendar-api');
    await listUpcomingReminders(10_000);

    expect(getMock).toHaveBeenCalledWith(`/calendar/reminders?limit=${REMINDER_MAX_PAGE_SIZE}`);
  });

  it('sends the create payload untouched, with no userId or tenantId', async () => {
    const { createReminder } = await import('../calendar-api');
    await createReminder({ title: 'جلسه', date: '1405/08/18', time: '14:30' });

    const [path, payload] = postMock.mock.calls[0];

    expect(path).toBe('/calendar/reminders');
    expect(payload).toEqual({ title: 'جلسه', date: '1405/08/18', time: '14:30' });
    // Structurally incapable of impersonation: there is no field for either.
    expect(payload).not.toHaveProperty('userId');
    expect(payload).not.toHaveProperty('tenantId');
  });

  it('patches a reminder by id', async () => {
    const { updateReminder } = await import('../calendar-api');
    await updateReminder('r1', { title: 'عنوان جدید' });

    expect(patchMock).toHaveBeenCalledWith('/calendar/reminders/r1', { title: 'عنوان جدید' });
  });

  it('routes the enable/disable shortcut through the same PATCH', async () => {
    const { setReminderEnabled } = await import('../calendar-api');
    await setReminderEnabled('r1', false);

    expect(patchMock).toHaveBeenCalledWith('/calendar/reminders/r1', { enabled: false });
  });

  it('deletes a reminder by id with no body', async () => {
    const { deleteReminder } = await import('../calendar-api');
    await deleteReminder('r1');

    expect(deleteMock).toHaveBeenCalledWith('/calendar/reminders/r1');
  });

  it('encodes an id rather than interpolating it raw', async () => {
    const { deleteReminder } = await import('../calendar-api');
    await deleteReminder('a/b?c');

    expect(deleteMock).toHaveBeenCalledWith('/calendar/reminders/a%2Fb%3Fc');
  });
});
