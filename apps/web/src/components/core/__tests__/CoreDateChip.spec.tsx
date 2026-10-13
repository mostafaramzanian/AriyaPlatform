import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreDateChip } from '../CoreDateChip';
import { hasLocalSession } from '@/lib/core-http';
import { getCalendarMonth, getCalendarToday, type CalendarMonth } from '@/lib/calendar-api';

/**
 * Phase 49I coverage for the sidebar date chip.
 *
 * The point being proven throughout: the displayed date comes from the SERVER, not from
 * the browser clock. Every test supplies the server answer and asserts the chip renders
 * exactly that, in Persian digits, in both rail states.
 */

const pushMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn() }),
  usePathname: () => '/admin',
}));

jest.mock('@/lib/core-http', () => ({
  ...jest.requireActual('@/lib/core-http'),
  hasLocalSession: jest.fn(() => true),
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  getCalendarToday: jest.fn(),
  getCalendarMonth: jest.fn(),
}));

const sessionMock = hasLocalSession as jest.MockedFunction<typeof hasLocalSession>;
const todayMock = getCalendarToday as jest.MockedFunction<typeof getCalendarToday>;
const monthMock = getCalendarMonth as jest.MockedFunction<typeof getCalendarMonth>;

/** 1405/06/09 — دوشنبه ۹ شهریور ۱۴۰۵. */
const TODAY = {
  date: '1405/06/09',
  jy: 1405,
  jm: 6,
  jd: 9,
  monthName: 'شهریور',
  weekdayName: 'دوشنبه',
  weekday: 2,
};

function month(overrides: Partial<CalendarMonth> = {}): CalendarMonth {
  const days = Array.from({ length: 31 }, (_, index) => ({
    date: `1405/06/${String(index + 1).padStart(2, '0')}`,
    jy: 1405,
    jm: 6,
    jd: index + 1,
    monthName: 'شهریور',
    weekdayName: 'دوشنبه',
    weekday: (index + 3) % 7,
    isToday: index + 1 === 9,
    reminderCount: index + 1 === 18 ? 2 : 0,
    occasions: [],
  }));

  return {
    jy: 1405,
    jm: 6,
    monthName: 'شهریور',
    startWeekday: 3,
    dayCount: 31,
    today: TODAY,
    days,
    occasions: [],
    ...overrides,
  };
}

describe('CoreDateChip', () => {
  beforeEach(() => {
    // Clear CALL history only: `clearAllMocks` leaves the resolved values below intact,
    // and without it the "no session" test would see calls made by earlier tests.
    jest.clearAllMocks();

    sessionMock.mockReturnValue(true);
    todayMock.mockResolvedValue(TODAY);
    monthMock.mockResolvedValue(month());
  });

  it('renders the server-supplied Persian date', async () => {
    render(<CoreDateChip collapsed={false} />);

    const chip = await screen.findByTestId('core-date-chip');

    expect(chip).toHaveAttribute('data-date', '1405/06/09');
    expect(screen.getByTestId('core-date-chip-label')).toHaveTextContent('۹ شهریور ۱۴۰۵');
    expect(chip).toHaveTextContent('دوشنبه');
  });

  it('never computes the date locally', async () => {
    // A server answer that disagrees with any plausible local computation must still be
    // what is rendered — that is the whole contract.
    todayMock.mockResolvedValue({ ...TODAY, date: '1399/01/01', jy: 1399, jm: 1, jd: 1, monthName: 'فروردین', weekdayName: 'شنبه', weekday: 0 });

    render(<CoreDateChip collapsed={false} />);

    expect(await screen.findByTestId('core-date-chip')).toHaveAttribute('data-date', '1399/01/01');
    expect(screen.getByTestId('core-date-chip-label')).toHaveTextContent('۱ فروردین ۱۳۹۹');
  });

  it('is a real button with an accessible name', async () => {
    render(<CoreDateChip collapsed={false} />);

    const chip = await screen.findByRole('button', { name: /تقویم/ });

    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the full date accessible when the rail is collapsed', async () => {
    render(<CoreDateChip collapsed />);

    const chip = await screen.findByTestId('core-date-chip');

    // Not hidden: the day number is still painted and the name carries everything.
    expect(chip).toBeVisible();
    expect(chip).toHaveAttribute('data-collapsed', 'true');
    expect(chip).toHaveAccessibleName('تقویم — دوشنبه ۹ شهریور ۱۴۰۵');
    // The label block is dropped, so the chip cannot widen the collapsed rail.
    expect(screen.queryByTestId('core-date-chip-label')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no session, instead of calling the API', () => {
    sessionMock.mockReturnValue(false);

    render(<CoreDateChip collapsed={false} />);

    expect(todayMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('core-date-chip')).not.toBeInTheDocument();
  });

  it('renders nothing when the request fails, rather than breaking the rail', async () => {
    todayMock.mockRejectedValue(new Error('boom'));

    render(<CoreDateChip collapsed={false} />);

    await waitFor(() => expect(todayMock).toHaveBeenCalled());
    expect(screen.queryByTestId('core-date-chip')).not.toBeInTheDocument();
  });

  describe('date picker surface', () => {
    it('opens the picker on click and closes it on a second click', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} />);

      const chip = await screen.findByTestId('core-date-chip');

      expect(screen.queryByTestId('core-date-chip-surface')).not.toBeInTheDocument();

      await user.click(chip);
      expect(await screen.findByTestId('core-date-chip-surface')).toBeInTheDocument();
      expect(chip).toHaveAttribute('aria-expanded', 'true');

      await user.click(chip);
      await waitFor(() =>
        expect(screen.queryByTestId('core-date-chip-surface')).not.toBeInTheDocument(),
      );
    });

    it('exposes the surface as a labelled dialog', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} />);

      await user.click(await screen.findByTestId('core-date-chip'));

      const surface = await screen.findByRole('dialog', { name: 'انتخاب تاریخ' });
      expect(surface).toBeInTheDocument();
    });

    it('closes on Escape and returns focus to the chip', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} />);

      const chip = await screen.findByTestId('core-date-chip');
      await user.click(chip);
      await screen.findByTestId('core-date-chip-surface');

      await user.keyboard('{Escape}');

      await waitFor(() =>
        expect(screen.queryByTestId('core-date-chip-surface')).not.toBeInTheDocument(),
      );
      expect(chip).toHaveFocus();
    });

    it('closes when the click lands outside the surface', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <CoreDateChip collapsed={false} />
          <button type="button">جای دیگر</button>
        </div>,
      );

      await user.click(await screen.findByTestId('core-date-chip'));
      await screen.findByTestId('core-date-chip-surface');

      await user.click(screen.getByRole('button', { name: 'جای دیگر' }));

      await waitFor(() =>
        expect(screen.queryByTestId('core-date-chip-surface')).not.toBeInTheDocument(),
      );
    });

    it('opens the picker on the month containing today', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} />);

      await user.click(await screen.findByTestId('core-date-chip'));
      await screen.findByTestId('jalali-date-picker');

      expect(monthMock).toHaveBeenCalledWith(1405, 6);
    });

    it('navigates to the calendar for the selected day and closes', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} />);

      await user.click(await screen.findByTestId('core-date-chip'));

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/18')!,
      );

      await user.click(day);

      // Latin digits and the URL-encoded slash: the wire format, not the display one.
      expect(pushMock).toHaveBeenCalledWith('/admin/calendar?date=1405%2F06%2F18');
      await waitFor(() =>
        expect(screen.queryByTestId('core-date-chip-surface')).not.toBeInTheDocument(),
      );
    });

    it('renders as a bottom sheet in the mobile drawer so it cannot overflow', async () => {
      const user = userEvent.setup();
      render(<CoreDateChip collapsed={false} variant="drawer" />);

      await user.click(await screen.findByTestId('core-date-chip'));

      const surface = await screen.findByTestId('core-date-chip-surface');

      expect(surface).toHaveAttribute('data-variant', 'drawer');
      // Pinned to the viewport horizontally: no width can exceed the screen.
      expect(surface.className).toContain('fixed');
      expect(surface.className).toContain('inset-x-0');
    });

    it('closes the mobile drawer after a day is chosen', async () => {
      const user = userEvent.setup();
      const onNavigate = jest.fn();

      render(<CoreDateChip collapsed={false} variant="drawer" onNavigate={onNavigate} />);

      await user.click(await screen.findByTestId('core-date-chip'));

      const day = await waitFor(() =>
        screen.getAllByTestId('jalali-day').find((node) => node.dataset.date === '1405/06/11')!,
      );

      await user.click(day);

      expect(onNavigate).toHaveBeenCalledTimes(1);
    });
  });
});
