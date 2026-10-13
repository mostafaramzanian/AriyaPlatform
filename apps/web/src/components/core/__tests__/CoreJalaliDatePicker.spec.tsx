import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreJalaliDatePicker } from '../CoreJalaliDatePicker';
import { getCalendarMonth, type CalendarMonth } from '@/lib/calendar-api';

/**
 * Phase 49I coverage for the Jalali date picker.
 *
 * The grid is server-derived, so these tests supply the server's month payload and
 * assert the picker renders exactly it — including a 29-day Esfand and a 31-day
 * Farvardin, which is how "the client never does Jalali arithmetic" is actually
 * verified rather than asserted.
 */

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  getCalendarMonth: jest.fn(),
}));

const monthMock = getCalendarMonth as jest.MockedFunction<typeof getCalendarMonth>;

/** Builds a month payload the way the API would. */
function month(
  jy: number,
  jm: number,
  dayCount: number,
  options: {
    todayDay?: number;
    markedDay?: number;
    startWeekday?: number;
    /** Occasions keyed by day-of-month, attached to that day (Phase 49I-1). */
    occasionsByDay?: Record<number, CalendarMonth['occasions']>;
  } = {},
): CalendarMonth {
  const monthNames = [
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
  ];
  const weekdayNames = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
  const startWeekday = options.startWeekday ?? 0;

  const allOccasions: CalendarMonth['occasions'] = [];
  const days = Array.from({ length: dayCount }, (_, index) => {
    const weekday = (startWeekday + index) % 7;
    const occasions = options.occasionsByDay?.[index + 1] ?? [];
    allOccasions.push(...occasions);

    return {
      date: `${jy}/${String(jm).padStart(2, '0')}/${String(index + 1).padStart(2, '0')}`,
      jy,
      jm,
      jd: index + 1,
      monthName: monthNames[jm - 1],
      weekdayName: weekdayNames[weekday],
      weekday,
      isToday: index + 1 === options.todayDay,
      reminderCount: index + 1 === options.markedDay ? 2 : 0,
      occasions,
    };
  });

  return {
    jy,
    jm,
    monthName: monthNames[jm - 1],
    startWeekday,
    dayCount,
    today: { ...days[0], date: `${jy}/06/09` },
    days,
    occasions: allOccasions,
  };
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof CoreJalaliDatePicker>> = {}) {
  const onSelect = jest.fn();

  const props: React.ComponentProps<typeof CoreJalaliDatePicker> = {
    value: '1405/06/09',
    onSelect,
    initialMonth: { jy: 1405, jm: 6 },
    todayKey: '1405/06/09',
    ...overrides,
  };

  return { ...render(<CoreJalaliDatePicker {...props} />), onSelect };
}

describe('CoreJalaliDatePicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    monthMock.mockImplementation(async (jy, jm) =>
      month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, { todayDay: 9, markedDay: 18 }),
    );
  });

  it('requests the month it was opened on', async () => {
    renderPicker();

    await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
  });

  it('renders exactly the days the server reported', async () => {
    renderPicker();

    await waitFor(() => expect(screen.getAllByTestId('jalali-day')).toHaveLength(31));
    expect(screen.getAllByTestId('jalali-day')[0]).toHaveAttribute('data-date', '1405/06/01');
  });

  it('honours a 29-day Esfand rather than assuming a length', async () => {
    renderPicker({ initialMonth: { jy: 1405, jm: 12 }, value: null });

    await waitFor(() => expect(screen.getAllByTestId('jalali-day')).toHaveLength(29));
  });

  it('renders Persian digits in the grid', async () => {
    renderPicker();

    const day = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/09')!,
    );

    expect(day).toHaveTextContent('۹');
  });

  it('exposes the grid and its cells with calendar semantics', async () => {
    renderPicker();

    const grid = await screen.findByRole('grid', { name: 'تقویم' });
    expect(within(grid).getAllByRole('gridcell').length).toBe(31);
  });

  it('marks the selection with aria-selected, not colour alone', async () => {
    renderPicker({ value: '1405/06/18' });

    const selected = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.selected === 'true')!,
    );

    expect(selected).toHaveAttribute('data-date', '1405/06/18');
    expect(selected).toHaveAttribute('aria-selected', 'true');
  });

  it('marks today with a textual cue in its accessible name', async () => {
    renderPicker();

    const today = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.today === 'true')!,
    );

    expect(today).toHaveAttribute('data-date', '1405/06/09');
    expect(today.getAttribute('aria-label')).toContain('امروز');
  });

  it('announces a day that carries reminders', async () => {
    renderPicker();

    const marked = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/18')!,
    );

    expect(marked.getAttribute('aria-label')).toContain('یادآوری');
    expect(within(marked).getByTestId('jalali-day-marker')).toBeInTheDocument();
  });

  it('reports the selected day in the wire format when a day is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    const day = await waitFor(
      () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/20')!,
    );

    await user.click(day);

    // Latin digits, zero-padded: the API contract, not the display form.
    expect(onSelect).toHaveBeenCalledWith('1405/06/20');
  });

  it('surfaces a load failure with a retry instead of an empty grid', async () => {
    monthMock.mockRejectedValue(new Error('تقویم در دسترس نیست'));

    renderPicker();

    expect(await screen.findByText('تقویم در دسترس نیست')).toBeInTheDocument();
    expect(screen.queryAllByTestId('jalali-day')).toHaveLength(0);
  });

  describe('navigation', () => {
    it('moves to the previous month', async () => {
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
      await user.click(screen.getByTestId('jalali-prev-month'));

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 5));
    });

    it('moves to the next month', async () => {
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
      await user.click(screen.getByTestId('jalali-next-month'));

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 7));
    });

    it('rolls the year backwards from Farvardin', async () => {
      const user = userEvent.setup();
      renderPicker({ initialMonth: { jy: 1405, jm: 1 } });

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 1));
      await user.click(screen.getByTestId('jalali-prev-month'));

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1404, 12));
    });

    it('rolls the year forwards from Esfand', async () => {
      const user = userEvent.setup();
      renderPicker({ initialMonth: { jy: 1405, jm: 12 } });

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 12));
      await user.click(screen.getByTestId('jalali-next-month'));

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1406, 1));
    });

    it('changes the month through the month selector', async () => {
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
      await user.selectOptions(screen.getByTestId('jalali-month-select'), '8');

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 8));
    });

    it('changes the year through the year selector', async () => {
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
      await user.selectOptions(screen.getByTestId('jalali-year-select'), '1406');

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1406, 6));
    });

    it('offers a bounded year list rather than the API full range', async () => {
      renderPicker();

      const select = await screen.findByTestId('jalali-year-select');
      const options = within(select).getAllByRole('option');

      expect(options).toHaveLength(11);
      expect(options[0]).toHaveValue('1400');
      expect(options[10]).toHaveValue('1410');
    });

    it('returns to today and selects it', async () => {
      const user = userEvent.setup();
      const { onSelect } = renderPicker({ initialMonth: { jy: 1404, jm: 2 }, value: null });

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1404, 2));
      await user.click(screen.getByTestId('jalali-today-button'));

      await waitFor(() => expect(monthMock).toHaveBeenCalledWith(1405, 6));
      expect(onSelect).toHaveBeenCalledWith('1405/06/09');
    });
  });

  describe('keyboard', () => {
    const focusDay = async (date: string) => {
      const day = await waitFor(
        () => screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === date)!,
      );
      day.focus();
      return day;
    };

    it('moves one day per left/right arrow, mirrored for RTL', async () => {
      const user = userEvent.setup();
      const { onSelect } = renderPicker({ value: '1405/06/10' });

      await focusDay('1405/06/10');
      // ArrowLeft advances in RTL.
      await user.keyboard('{ArrowLeft}');
      await user.keyboard('{Enter}');

      expect(onSelect).toHaveBeenCalledWith('1405/06/11');
    });

    it('moves one week per up/down arrow', async () => {
      const user = userEvent.setup();
      const { onSelect } = renderPicker({ value: '1405/06/10' });

      await focusDay('1405/06/10');
      await user.keyboard('{ArrowDown}');
      await user.keyboard('{Enter}');

      expect(onSelect).toHaveBeenCalledWith('1405/06/17');
    });

    it('selects with Space as well as Enter', async () => {
      const user = userEvent.setup();
      const { onSelect } = renderPicker({ value: '1405/06/10' });

      await focusDay('1405/06/10');
      await user.keyboard(' ');

      expect(onSelect).toHaveBeenCalledWith('1405/06/10');
    });

    it('jumps to the first and last day with Home and End', async () => {
      const user = userEvent.setup();
      const { onSelect } = renderPicker({ value: '1405/06/10' });

      await focusDay('1405/06/10');
      await user.keyboard('{End}');
      await user.keyboard('{Enter}');

      expect(onSelect).toHaveBeenCalledWith('1405/06/31');
    });

    it('keeps exactly one day tabbable', async () => {
      renderPicker();

      await waitFor(() => expect(screen.getAllByTestId('jalali-day')).toHaveLength(31));

      const tabbable = screen
        .getAllByTestId('jalali-day')
        .filter((node) => node.getAttribute('tabindex') === '0');

      expect(tabbable).toHaveLength(1);
    });
  });
describe('official occasions & holidays (Phase 49I-1)', () => {
    const holidayOccasion = (title: string, isHoliday = true, category = 'RELIGIOUS') => ({
      date: '1405/06/22',
      title,
      description: null,
      isHoliday,
      category,
      sourceYear: 1405,
    });

    it('shows a non-Friday official holiday in red and the reason under the date', async () => {
      // 1405/06/22 is a Tuesday (weekday 2), an official holiday → special red.
      monthMock.mockImplementation(async (jy, jm) =>
        month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, {
          todayDay: 9,
          markedDay: 18,
          occasionsByDay: {
            22: [holidayOccasion('شهادت حضرت فاطمه زهرا (س)')],
          },
        }),
      );
      renderPicker();

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/22')!,
      );

      expect(day).toHaveAttribute('data-holiday', 'true');
      expect(within(day).getByTestId('jalali-day-number')).toHaveClass('text-red-600');
      expect(within(day).getByTestId('jalali-day-holiday')).toHaveTextContent(
        'شهادت حضرت فاطمه زهرا (س)',
      );
    });

    it('keeps Friday normal even when it is also an official holiday', async () => {
      // A Friday (weekday 6) that is an official holiday must NOT be special-red.
      // With startWeekday 0, day 7 (index 6) has weekday 6 = جمعه.
      const fridayDate = '1405/06/07';
      monthMock.mockImplementation(async (jy, jm) =>
        month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, {
          todayDay: 9,
          markedDay: 18,
          startWeekday: 0,
          occasionsByDay: { 7: [holidayOccasion('روز جمعه + تعطیل')] },
        }),
      );
      renderPicker();

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === fridayDate)!,
      );

      // The day really is a Friday in this fixture.
      const fridayNode = day;
      expect(fridayNode.dataset.date).toBe(fridayDate);

      // data-holiday is false: the Friday exclusion overrides the holiday record.
      expect(fridayNode).toHaveAttribute('data-holiday', 'false');
      expect(within(fridayNode).queryByTestId('jalali-day-holiday')).not.toBeInTheDocument();
    });

    it('renders a non-holiday occasion with the secondary treatment, not as a holiday', async () => {
      monthMock.mockImplementation(async (jy, jm) =>
        month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, {
          todayDay: 9,
          markedDay: 18,
          occasionsByDay: {
            10: [holidayOccasion('روز ملی خلیج فارس', false, 'NATIONAL')],
          },
        }),
      );
      renderPicker();

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/10')!,
      );

      expect(day).toHaveAttribute('data-holiday', 'false');
      expect(day).toHaveAttribute('data-has-occasion', 'true');
      expect(within(day).getByTestId('jalali-day-occasion')).toHaveTextContent('روز ملی خلیج فارس');
      // Not red: secondary text treatment carries the day.
      expect(within(day).getByTestId('jalali-day-occasion')).not.toHaveClass('text-red-600');
    });

    it('supports multiple occasions on one date with a compact +N', async () => {
      monthMock.mockImplementation(async (jy, jm) =>
        month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, {
          todayDay: 9,
          markedDay: 18,
          occasionsByDay: {
            1: [holidayOccasion('عید نوروز'), holidayOccasion('عید سعید فطر', true, 'RELIGIOUS')],
          },
        }),
      );
      renderPicker();

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/01')!,
      );

      // Show the highest-priority holiday + a "+N" for the other.
      expect(within(day).getByTestId('jalali-day-holiday')).toHaveTextContent('عید نوروز');
      expect(within(day).getByTestId('jalali-day-more')).toHaveTextContent('+۱');
      // Accessible label carries both titles, so colour is not the only indicator.
      expect(day.getAttribute('aria-label')).toContain('عید سعید فطر');
      expect(day.getAttribute('aria-label')).toContain('عید نوروز');
    });

    it('puts the holiday reason in the accessible label, not colour alone', async () => {
      monthMock.mockImplementation(async (jy, jm) =>
        month(jy, jm, jm <= 6 ? 31 : jm <= 11 ? 30 : 29, {
          todayDay: 9,
          markedDay: 18,
          occasionsByDay: {
            22: [holidayOccasion('شهادت حضرت فاطمه زهرا (س)')],
          },
        }),
      );
      renderPicker();

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/22')!,
      );

      expect(day.getAttribute('aria-label')).toContain('شهادت حضرت فاطمه زهرا (س)');
      expect(day.getAttribute('aria-label')).toContain('تعطیل رسمی');
    });

    // Phase 49I-2: the mini calendar must size from its CONTAINER (sidebar card,
    // popover surface, bottom sheet) and never from the viewport — the old
    // `w-[min(20rem,calc(100vw-2rem))]` pinned it flush against the sidebar edge.
    it('is container-driven: w-full, with no viewport math in its width', async () => {
      renderPicker();

      const picker = await screen.findByTestId('jalali-date-picker');

      expect(picker.className).toContain('w-full');
      expect(picker.className).not.toContain('100vw');
      expect(picker.className).not.toContain('calc(');
    });
  });
});
