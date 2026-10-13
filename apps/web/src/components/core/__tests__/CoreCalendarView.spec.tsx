import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreCalendarView } from '../CoreCalendarView';
import {
  createReminder,
  deleteReminder,
  getCalendarMonth,
  getCalendarToday,
  listRemindersForDay,
  listUpcomingReminders,
  setReminderEnabled,
  type CalendarMonth,
  type CalendarOccasion,
  type ReminderItem,
} from '@/lib/calendar-api';

/**
 * Phase 49I coverage for the calendar surface and the reminder form.
 *
 * What is being proven: the selected day drives the reads, the create form inherits that
 * day (and cannot set its own), the wire payload is always Latin-digit `YYYY/MM/DD` +
 * `HH:mm`, all-day and a time are mutually exclusive on the wire, and every state —
 * loading, empty, error, disabled, delivered — is rendered rather than swallowed.
 */

const replaceMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: replaceMock }),
  usePathname: () => '/admin/calendar',
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  getCalendarToday: jest.fn(),
  getCalendarMonth: jest.fn(),
  listRemindersForDay: jest.fn(),
  listUpcomingReminders: jest.fn(),
  createReminder: jest.fn(),
  // `setReminderEnabled` is mocked directly rather than through `updateReminder`: the
  // wrapper calls its sibling through the module's own binding, so mocking only
  // `updateReminder` would not intercept it.
  setReminderEnabled: jest.fn(),
  deleteReminder: jest.fn(),
}));

/** Mutable `?date=` for the mocked `useSearchParams`. */
let mockSearch = '';

const todayMock = getCalendarToday as jest.MockedFunction<typeof getCalendarToday>;
const monthMock = getCalendarMonth as jest.MockedFunction<typeof getCalendarMonth>;
const dayMock = listRemindersForDay as jest.MockedFunction<typeof listRemindersForDay>;
const upcomingMock = listUpcomingReminders as jest.MockedFunction<typeof listUpcomingReminders>;
const createMock = createReminder as jest.MockedFunction<typeof createReminder>;
const enableMock = setReminderEnabled as jest.MockedFunction<typeof setReminderEnabled>;
const deleteMock = deleteReminder as jest.MockedFunction<typeof deleteReminder>;

const TODAY = {
  date: '1405/06/09',
  jy: 1405,
  jm: 6,
  jd: 9,
  monthName: 'شهریور',
  weekdayName: 'دوشنبه',
  weekday: 2,
};

const SELECTED = {
  date: '1405/08/18',
  jy: 1405,
  jm: 8,
  jd: 18,
  monthName: 'آبان',
  weekdayName: 'یکشنبه',
  weekday: 1,
};

function month(jy = 1405, jm = 8, dayCount = 30): CalendarMonth {
  const days = Array.from({ length: dayCount }, (_, index) => ({
    date: `${jy}/${String(jm).padStart(2, '0')}/${String(index + 1).padStart(2, '0')}`,
    jy,
    jm,
    jd: index + 1,
    monthName: 'آبان',
    weekdayName: 'یکشنبه',
    weekday: index % 7,
    isToday: false,
    reminderCount: 0,
    occasions: [],
  }));

  return {
    jy,
    jm,
    monthName: 'آبان',
    startWeekday: 0,
    dayCount,
    today: TODAY,
    days,
    occasions: [],
  };
}

function reminder(overrides: Partial<ReminderItem> = {}): ReminderItem {
  return {
    id: 'r1',
    title: 'جلسه تیم فناوری',
    note: null,
    dueAt: '2026-11-09T11:00:00.000Z',
    date: '1405/08/18',
    time: '14:30',
    allDay: false,
    enabled: true,
    deliveredAt: null,
    createdAt: '2026-08-31T20:00:00.000Z',
    updatedAt: '2026-08-31T20:00:00.000Z',
    ...overrides,
  };
}

/** Builds an official occasion the way `GET /calendar/month` attaches one to a day. */
function occasion(
  title: string,
  isHoliday = true,
  category = 'NATIONAL',
): CalendarOccasion {
  return {
    date: '1405/08/18',
    title,
    description: null,
    isHoliday,
    category,
    sourceYear: 1405,
  };
}

/** The default month payload, with 49I-2 occasions attached to the selected day. */
function monthWithOccasions(occasions: CalendarOccasion[]): CalendarMonth {
  const base = month();
  return {
    ...base,
    days: base.days.map((day) => (day.jd === 18 ? { ...day, occasions } : day)),
  };
}

describe('CoreCalendarView', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockSearch = 'date=1405/08/18';
    todayMock.mockResolvedValue(TODAY);
    monthMock.mockResolvedValue(month());
    dayMock.mockResolvedValue({ day: SELECTED, items: [] });
    upcomingMock.mockResolvedValue({ items: [], hasMore: false });
  });

  it('reads the selected day from the query string', async () => {
    render(<CoreCalendarView />);

    await waitFor(() => expect(dayMock).toHaveBeenCalledWith('1405/08/18'));
    expect(await screen.findByTestId('selected-day')).toHaveTextContent(
      'یادآوری‌های یکشنبه ۱۸ آبان ۱۴۰۵',
    );
  });

  it('falls back to today when no day is requested', async () => {
    mockSearch = '';

    render(<CoreCalendarView />);

    await waitFor(() => expect(dayMock).toHaveBeenCalledWith('1405/06/09'));
  });

  it('ignores a malformed query date instead of erroring', async () => {
    mockSearch = 'date=not-a-date';

    render(<CoreCalendarView />);

    await waitFor(() => expect(dayMock).toHaveBeenCalledWith('1405/06/09'));
  });

  it('navigates by replacing the URL when another day is picked', async () => {
    const user = userEvent.setup();
    render(<CoreCalendarView />);

    const day = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/08/20')!,
    );

    await user.click(day);

    expect(replaceMock).toHaveBeenCalledWith('/admin/calendar?date=1405%2F08%2F20');
  });

  describe('day list states', () => {
    it('renders the empty state when the day has no reminders', async () => {
      render(<CoreCalendarView />);

      expect(
        await screen.findByText('برای این روز یادآوری‌ای ثبت نشده است.'),
      ).toBeInTheDocument();
    });

    it('renders a reminder with its Persian time', async () => {
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder()] });

      render(<CoreCalendarView />);

      const item = await screen.findByTestId('reminder-item');

      expect(item).toHaveTextContent('جلسه تیم فناوری');
      expect(within(item).getByTestId('reminder-time')).toHaveTextContent('۱۴:۳۰');
    });

    it('labels an all-day reminder instead of showing 00:00', async () => {
      dayMock.mockResolvedValue({
        day: SELECTED,
        items: [reminder({ allDay: true, time: null })],
      });

      render(<CoreCalendarView />);

      expect(await screen.findByTestId('reminder-time')).toHaveTextContent('تمام روز');
    });

    it('marks a disabled reminder in text, not colour alone', async () => {
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder({ enabled: false })] });

      render(<CoreCalendarView />);

      const item = await screen.findByTestId('reminder-item');

      expect(item).toHaveAttribute('data-enabled', 'false');
      expect(within(item).getByTestId('reminder-disabled-label')).toHaveTextContent('غیرفعال');
    });

    it('marks a delivered reminder', async () => {
      dayMock.mockResolvedValue({
        day: SELECTED,
        items: [reminder({ deliveredAt: '2026-11-09T11:00:05.000Z' })],
      });

      render(<CoreCalendarView />);

      const item = await screen.findByTestId('reminder-item');

      expect(item).toHaveAttribute('data-delivered', 'true');
      expect(within(item).getByTestId('reminder-delivered-label')).toBeInTheDocument();
    });

    it('surfaces a failed day read with a retry', async () => {
      dayMock.mockRejectedValue(new Error('روز در دسترس نیست'));

      render(<CoreCalendarView />);

      expect(await screen.findByText('روز در دسترس نیست')).toBeInTheDocument();
    });
  });

  describe('reminder management', () => {
    it('disables a reminder through the API and reflects the result', async () => {
      const user = userEvent.setup();
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder()] });
      enableMock.mockResolvedValue(reminder({ enabled: false }));

      render(<CoreCalendarView />);

      await user.click(await screen.findByTestId('reminder-toggle'));

      expect(enableMock).toHaveBeenCalledWith('r1', false);
      await waitFor(() =>
        expect(screen.getByTestId('reminder-item')).toHaveAttribute('data-enabled', 'false'),
      );
    });

    it('deletes a reminder and removes it from the list', async () => {
      const user = userEvent.setup();
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder()] });
      deleteMock.mockResolvedValue({ id: 'r1', deleted: true });

      render(<CoreCalendarView />);

      await user.click(await screen.findByTestId('reminder-delete'));

      expect(deleteMock).toHaveBeenCalledWith('r1');
      await waitFor(() => expect(screen.queryByTestId('reminder-item')).not.toBeInTheDocument());
    });

    it('reports a failed delete instead of removing the row optimistically', async () => {
      const user = userEvent.setup();
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder()] });
      deleteMock.mockRejectedValue(new Error('حذف ممکن نیست'));

      render(<CoreCalendarView />);

      await user.click(await screen.findByTestId('reminder-delete'));

      // The mutation error is non-blocking: the row that could not be deleted is still
      // rendered, rather than the whole list being replaced by an error state.
      expect(await screen.findByTestId('reminder-action-error')).toHaveTextContent(
        'حذف ممکن نیست',
      );
      expect(screen.getByTestId('reminder-item')).toBeInTheDocument();
    });
  });

  describe('reminder creation', () => {
    const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
      render(<CoreCalendarView />);
      await user.click(await screen.findByTestId('reminder-create-toggle'));
      return screen.findByTestId('reminder-form');
    };

    it('inherits the selected day and does not let the form choose one', async () => {
      const user = userEvent.setup();
      await openForm(user);

      const dateField = screen.getByTestId('reminder-form-date');

      expect(dateField).toHaveAttribute('data-date', '1405/08/18');
      expect(dateField).toHaveTextContent('یکشنبه ۱۸ آبان ۱۴۰۵');
      // Read-only: there is no date input to disagree with the selection.
      expect(dateField.tagName).not.toBe('INPUT');
    });

    it('sends the Latin-digit wire payload for a timed reminder', async () => {
      const user = userEvent.setup();
      createMock.mockResolvedValue(reminder());

      await openForm(user);

      await user.type(screen.getByTestId('reminder-title-input'), 'جلسه با واحد فناوری');
      await user.type(screen.getByTestId('reminder-time-input'), '14:30');
      await user.type(screen.getByTestId('reminder-note-input'), 'پیگیری گزارش');
      await user.click(screen.getByTestId('reminder-submit'));

      expect(createMock).toHaveBeenCalledWith({
        title: 'جلسه با واحد فناوری',
        date: '1405/08/18',
        time: '14:30',
        note: 'پیگیری گزارش',
      });
    });

    it('omits the time entirely for an all-day reminder', async () => {
      const user = userEvent.setup();
      createMock.mockResolvedValue(reminder({ allDay: true, time: null }));

      await openForm(user);

      await user.type(screen.getByTestId('reminder-title-input'), 'مرخصی');
      await user.click(screen.getByTestId('reminder-allday-input'));
      await user.click(screen.getByTestId('reminder-submit'));

      // `allDay: true` and NO `time` key: the server refuses the combination, so the
      // client must never send both.
      expect(createMock).toHaveBeenCalledWith({
        title: 'مرخصی',
        date: '1405/08/18',
        allDay: true,
      });
    });

    it('disables the time field once all-day is chosen', async () => {
      const user = userEvent.setup();
      await openForm(user);

      await user.type(screen.getByTestId('reminder-time-input'), '09:00');
      await user.click(screen.getByTestId('reminder-allday-input'));

      const time = screen.getByTestId('reminder-time-input');

      expect(time).toBeDisabled();
      expect(time).toHaveValue('');
    });

    it('refuses to submit without a title', async () => {
      const user = userEvent.setup();
      await openForm(user);

      await user.type(screen.getByTestId('reminder-time-input'), '10:00');
      await user.click(screen.getByTestId('reminder-submit'));

      expect(await screen.findByTestId('reminder-form-error')).toHaveTextContent(
        'عنوان یادآوری الزامی است.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    it('refuses to submit a timed reminder without a time', async () => {
      const user = userEvent.setup();
      await openForm(user);

      await user.type(screen.getByTestId('reminder-title-input'), 'بدون ساعت');
      await user.click(screen.getByTestId('reminder-submit'));

      expect(await screen.findByTestId('reminder-form-error')).toHaveTextContent(
        'برای یادآوری زمان‌دار، وارد کردن ساعت الزامی است.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    it("shows the server's rejection message verbatim", async () => {
      const user = userEvent.setup();
      createMock.mockRejectedValue(new Error('A reminder cannot be created for a past moment'));

      await openForm(user);

      await user.type(screen.getByTestId('reminder-title-input'), 'گذشته');
      await user.type(screen.getByTestId('reminder-time-input'), '08:00');
      await user.click(screen.getByTestId('reminder-submit'));

      expect(await screen.findByTestId('reminder-form-error')).toHaveTextContent(
        'A reminder cannot be created for a past moment',
      );
    });

    it('confirms the save and keeps the selected day visible', async () => {
      const user = userEvent.setup();
      createMock.mockResolvedValue(reminder());

      await openForm(user);

      await user.type(screen.getByTestId('reminder-title-input'), 'جلسه');
      await user.type(screen.getByTestId('reminder-time-input'), '14:30');
      await user.click(screen.getByTestId('reminder-submit'));

      expect(await screen.findByTestId('reminder-notice')).toHaveTextContent(
        'یادآوری با موفقیت ثبت شد.',
      );
      expect(screen.getByTestId('selected-day')).toHaveTextContent('۱۸ آبان ۱۴۰۵');
      expect(screen.queryByTestId('reminder-form')).not.toBeInTheDocument();
    });
  });

  describe('upcoming list', () => {
    it('asks for a bounded page and renders the empty state', async () => {
      render(<CoreCalendarView />);

      await waitFor(() => expect(upcomingMock).toHaveBeenCalled());
      expect(await screen.findByText('یادآوری‌ای پیش رو ندارید.')).toBeInTheDocument();
    });

    it('renders upcoming items with their Persian date and time', async () => {
      upcomingMock.mockResolvedValue({ items: [reminder()], hasMore: false });

      render(<CoreCalendarView />);

      const list = await screen.findByTestId('upcoming-list');

      expect(list).toHaveTextContent('۱۴۰۵/۰۸/۱۸');
      expect(list).toHaveTextContent('۱۴:۳۰');
    });

    it('says the list is bounded when more exist, rather than loading everything', async () => {
      upcomingMock.mockResolvedValue({ items: [reminder()], hasMore: true });

      render(<CoreCalendarView />);

      expect(await screen.findByText(/فهرست محدود است/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 49I-2: the «مناسبت‌های روز» section and the sidebar breathing-room fix.
  // -------------------------------------------------------------------------
  describe('selected-day occasions section (49I-2)', () => {
    it('reads the selected day occasions from the existing month payload', async () => {
      render(<CoreCalendarView />);

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 8));
      expect(await screen.findByTestId('day-occasions')).toBeInTheDocument();
    });

    it('shows the subtle empty state when the selected day has no occasions', async () => {
      render(<CoreCalendarView />);

      expect(await screen.findByTestId('day-occasions-empty')).toHaveTextContent(
        'مناسبتی برای این روز ثبت نشده است.',
      );
      expect(screen.queryByTestId('day-occasions-list')).not.toBeInTheDocument();
    });

    it('lists the official holiday FIRST with a textual «تعطیل رسمی» badge, not colour alone', async () => {
      monthMock.mockResolvedValue(
        monthWithOccasions([
          occasion('روز ملی خلیج فارس', false),
          occasion('عید نوروز', true, 'NATIONAL_HOLIDAY'),
        ]),
      );

      render(<CoreCalendarView />);

      const list = await screen.findByTestId('day-occasions-list');
      const items = within(list).getAllByTestId('day-occasion-item');

      // Order contract: holidays before ordinary occasions, regardless of payload order.
      expect(items[0]).toHaveTextContent('عید نوروز');
      expect(items[0]).toHaveAttribute('data-holiday', 'true');
      expect(within(items[0]).getByTestId('day-occasion-holiday')).toHaveTextContent(
        'تعطیل رسمی',
      );
      expect(items[1]).toHaveTextContent('روز ملی خلیج فارس');
      expect(items[1]).toHaveAttribute('data-holiday', 'false');
      expect(within(items[1]).queryByTestId('day-occasion-holiday')).not.toBeInTheDocument();
    });

    it('surfaces a month-read failure in the occasions section with a retry', async () => {
      monthMock.mockRejectedValue(new Error('تقویم در دسترس نیست'));

      render(<CoreCalendarView />);

      // Scoped to the occasions card: the mini calendar shows its own instance of the
      // same error, and each surface must own its failure state independently.
      const occasions = await screen.findByTestId('day-occasions');
      expect(await within(occasions).findByText('تقویم در دسترس نیست')).toBeInTheDocument();
    });

    it('keeps personal reminders in their own separate section below the occasions', async () => {
      dayMock.mockResolvedValue({ day: SELECTED, items: [reminder()] });

      render(<CoreCalendarView />);

      const occasions = await screen.findByTestId('day-occasions');
      expect(await screen.findByTestId('reminder-list')).toBeInTheDocument();

      // No reminder content inside the occasions card: two sections, never one list.
      expect(within(occasions).queryByTestId('reminder-list')).not.toBeInTheDocument();
      expect(within(occasions).queryByTestId('reminder-delete')).not.toBeInTheDocument();
    });
  });

  describe('sidebar mini-calendar spacing fix (49I-2)', () => {
    it('sizes the picker from its container, never from the viewport', async () => {
      render(<CoreCalendarView />);

      const picker = await screen.findByTestId('jalali-date-picker');

      // The regression this pins: the old `w-[min(20rem,calc(100vw-2rem))]` ignored the
      // sidebar card and pinned the mini calendar flush against the viewport edge.
      expect(picker.className).toContain('w-full');
      expect(picker.className).not.toContain('100vw');
      expect(picker.className).not.toContain('calc(');
    });

    it('gives the calendar card the density-token padding, so the grid has breathing room', async () => {
      render(<CoreCalendarView />);

      const card = await screen.findByTestId('calendar-card');

      expect(card.className).toContain('p-core-card');
      expect(card.className).not.toContain('p-4');
    });
  });
});
