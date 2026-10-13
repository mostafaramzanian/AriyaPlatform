import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrPersonnelTrafficReportView } from '../HrPersonnelTrafficReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { getCalendarToday } from '@/lib/calendar-api';
import {
  fetchHrPersonnelTrafficReport,
  type ReportingPersonnelTrafficPage,
} from '@/lib/hr-personnel-traffic-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/hr-personnel-traffic-report-api', () => ({
  ...jest.requireActual('@/lib/hr-personnel-traffic-report-api'),
  fetchHrPersonnelTrafficReport: jest.fn(),
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  // The month grid calls `/calendar/month` per opened month: a test that never opens
  // the picker still fetches the SERVER's today for the default window, and nothing
  // else calendar-related may run.
  getCalendarToday: jest.fn(),
  getCalendarMonth: jest.fn(() => new Promise(() => {})),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchHrPersonnelTrafficReport as jest.MockedFunction<
  typeof fetchHrPersonnelTrafficReport
>;
const todayMock = getCalendarToday as jest.MockedFunction<typeof getCalendarToday>;

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: what the FOURTH Reporting workspace actually
 * promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. WINDOW-FIRST — no complete day window means NO request and the window prompt —
 *     never a fake «۰ رکورد» — with the server's own today seating the default day.
 *  3. FILTERS — only the register-supported day shape (one Jalali day OR one Gregorian
 *     range), `source` and `search`, always as a SERVER query, never a client-side
 *     sieve; no `employeeId` field, because the report refuses an id it cannot label.
 *  4. AUTHORIZATION — without `hr.attendance.read` no request is issued.
 *  5. SUMMARY HONESTY — every rendered figure comes from the API payload; the
 *     component owns no counting code, and the chips ARE the source filter.
 */

/** 1405/06/27 — the SERVER's today for every test on this screen. */
const TODAY = {
  date: '1405/06/27',
  jy: 1405,
  jm: 6,
  jd: 27,
  monthName: 'شهریور',
  weekdayName: 'پنجشنبه',
  weekday: 4,
};

function grant(permissions: string[], isLoading = false) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

function authState(user: { userId?: string } | null = { userId: 'u-1' }) {
  return {
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

function row(overrides: Partial<ReportingPersonnelTrafficPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    employeeCode: 'E-1042',
    workDate: '2026-09-18',
    dateKey: '1405/06/27',
    clockIn: '2026-09-18T04:30:00.000Z',
    clockOut: '2026-09-18T13:00:00.000Z',
    source: 'DEVICE',
    reason: null,
    ...overrides,
  } as ReportingPersonnelTrafficPage['items'][number];
}

function page(items = [row()], total = items.length): ReportingPersonnelTrafficPage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: {
      total,
      bySource: { DEVICE: items.length, MANUAL: 0 },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['hr.attendance.read']);
  authMock.mockReturnValue(authState());
  todayMock.mockResolvedValue(TODAY);
  fetchMock.mockResolvedValue(page());
});

async function rendered() {
  render(<HrPersonnelTrafficReportView />);
  // The server's today seeds the default day window; awaiting it pins «which day did
  // this screen actually ask for» inside the test rather than leaking past its end.
  await waitFor(() => expect(todayMock).toHaveBeenCalled());
}

describe('HrPersonnelTrafficReportView — «گزارش تردد پرسنل»', () => {
  it('names the report under the page heading — and never as an h1', async () => {
    const { container } = render(<HrPersonnelTrafficReportView />);

    expect(await screen.findByTestId('hr-personnel-traffic-report-view')).toBeInTheDocument();
    expect(screen.getByText('گزارش تردد پرسنل')).toBeInTheDocument();
    expect(container.querySelector('h1')).toBeNull();
    expect(screen.getByText('گزارش‌گیری')).toBeInTheDocument();
  });

  it('seeds the default window from the server’s own today — and asks with it', async () => {
    await rendered();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ dateKey: '1405/06/27', page: 1, pageSize: 20 })
    );
    expect(await screen.findByTestId('hr-personnel-traffic-report-day-raw')).toHaveTextContent(
      '1405/06/27'
    );
  });

  it('issues no request before the window resolves — the prompt, not a fake zero', async () => {
    todayMock.mockReturnValue(new Promise(() => {}));
    render(<HrPersonnelTrafficReportView />);

    expect(
      await screen.findByTestId('hr-personnel-traffic-report-summary-prompt')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('hr-personnel-traffic-report-table')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the register-supported filters as the server query', async () => {
    const user = userEvent.setup();
    await rendered();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The Gregorian range replaces the Jalali day — two shapes, never one request.
    await user.selectOptions(screen.getByTestId('hr-personnel-traffic-report-date-mode'), 'range');
    await user.type(screen.getByTestId('hr-personnel-traffic-report-from'), '2026-09-18');
    await user.type(screen.getByTestId('hr-personnel-traffic-report-to'), '2026-09-19');
    await user.selectOptions(
      screen.getByTestId('hr-personnel-traffic-report-source-filter'),
      'MANUAL'
    );
    await user.type(screen.getByTestId('hr-personnel-traffic-report-search-input'), 'E-1042');
    await user.click(screen.getByTestId('hr-personnel-traffic-report-apply-filters'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const query = fetchMock.mock.calls[1][0];
    expect(query).toEqual({
      page: 1,
      pageSize: 20,
      from: '2026-09-18',
      to: '2026-09-19',
      source: 'MANUAL',
      search: 'E-1042',
    });
    expect(query).not.toHaveProperty('dateKey');
    expect(query).not.toHaveProperty('employeeId');
    expect(query).not.toHaveProperty('status');
  });

  it('renders the register row vocabulary — code, day, times, source — with detail links', async () => {
    await rendered();

    const link = await screen.findByTestId(
      'hr-personnel-traffic-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveTextContent('E-1042');
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/hr/personnel-traffic/11111111-1111-4111-8111-111111111111'
    );
    // The source word — the register's own vocabulary, never colour alone.
    expect(screen.getByTestId('hr-personnel-traffic-report-source-DEVICE')).toHaveTextContent(
      'پانچ دستگاه'
    );
    expect(
      screen.getByTestId(
        'hr-personnel-traffic-report-row-details-11111111-1111-4111-8111-111111111111'
      )
    ).toHaveTextContent('جزئیات');
  });

  it('reads the summary strip from the API — the component owns no counting code', async () => {
    await rendered();

    const count = await screen.findByTestId('hr-personnel-traffic-report-summary-count-DEVICE');
    expect(count).toHaveTextContent('۱');
    const manual = screen.getByTestId('hr-personnel-traffic-report-summary-count-MANUAL');
    expect(manual).toHaveTextContent('۰');
    expect(screen.getByTestId('hr-personnel-traffic-report-summary-all-count')).toHaveTextContent(
      '۱'
    );
    expect(
      screen.getByTestId('hr-personnel-traffic-report-summary-source-DEVICE')
    ).toHaveTextContent('پانچ دستگاه');
  });

  it('drives the source filter from the summary chips — one query, not a sieve', async () => {
    const user = userEvent.setup();
    await rendered();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('hr-personnel-traffic-report-summary-source-MANUAL'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ source: 'MANUAL', dateKey: '1405/06/27' })
    );
  });

  it('renders the EMPTY state with filtered-copy — never an error', async () => {
    fetchMock.mockResolvedValue(page([], 0));
    await rendered();

    // Re-query inside `waitFor`: the empty section mounts asynchronously after the
    // fetch chain settles, and a single-shot assertion can catch the intermediate
    // commit instead of the settled DOM (the state the user actually sees).
    let empty: HTMLElement | null = null;
    await waitFor(async () => {
      empty = await screen.findByTestId('hr-personnel-traffic-report-empty');
      expect(empty).toBeInTheDocument();
    });
    expect(empty).toHaveTextContent('برای این فیلترها رکوردی پیدا نشد.');
    expect(screen.queryByTestId('hr-personnel-traffic-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry — never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await rendered();

    const error = await screen.findByTestId('hr-personnel-traffic-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('دریافت گزارش با خطا مواجه شد.');
    expect(screen.queryByTestId('hr-personnel-traffic-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight — no fake figures', async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<HrPersonnelTrafficReportView />);
    await waitFor(() => expect(todayMock).toHaveBeenCalled());

    // An INTERACTION applies the seeded window and starts the first request: from
    // then on the skeleton owns the table area until the API speaks.
    await user.click(screen.getByTestId('hr-personnel-traffic-report-apply-filters'));

    expect(screen.getByTestId('hr-personnel-traffic-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The summary strip renders placeholders (aria-hidden bars), never a digit.
    expect(
      screen.queryByTestId('hr-personnel-traffic-report-summary-all-count')
    ).not.toBeInTheDocument();
  });

  it('denies the screen without hr.attendance.read — and reads nothing', async () => {
    grant([]);
    render(<HrPersonnelTrafficReportView />);

    expect(await screen.findByTestId('hr-personnel-traffic-report-view')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates the filtered register through the server — a second page, a real query', async () => {
    const user = userEvent.setup();
    const secondRow = row({ id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1043' });
    fetchMock.mockResolvedValue(page([row(), secondRow], 21));
    await rendered();

    const status = await screen.findByTestId('hr-personnel-traffic-report-pagination-status');
    expect(status).toHaveTextContent('صفحه ۱ از ۲');

    fetchMock.mockResolvedValue(page([], 21));
    await user.click(screen.getByTestId('hr-personnel-traffic-report-pagination-next'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );
  });
});

describe('HrPersonnelTrafficReportView — scope protection (no speculative surface)', () => {
  /** Comment lines removed: prose that EXPLAINS a rule must not violate it. */
  const codeOf = (file: string): string => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    return fs
      .readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('{/*')
        );
      })
      .join('\n');
  };

  it('renders the export actions for the CURRENT scope — the contract now exists', async () => {
    // REPORTING-VISUALIZATION-EXPORT legitimised exactly this pair over the report's
    // OWN export routes. Anything beyond them still fails this suite.
    await rendered();
    await screen.findByTestId('hr-personnel-traffic-report-table');

    expect(screen.getByTestId('hr-personnel-traffic-report-export-xlsx')).toHaveTextContent(
      'خروجی Excel'
    );
    expect(screen.getByTestId('hr-personnel-traffic-report-export-docx')).toHaveTextContent(
      'خروجی Word'
    );
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    await rendered();
    await screen.findByTestId('hr-personnel-traffic-report-table');

    expect(screen.getByTestId('hr-personnel-traffic-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع منبع ثبت'
    );
    expect(screen.getByTestId('hr-personnel-traffic-report-chart-count-DEVICE')).toHaveTextContent(
      '۱'
    );
  });

  it('owns no write, scheduling or AI affordance — the backend has none', () => {
    const source = codeOf('HrPersonnelTrafficReportView.tsx');
    // Export words are HONEST now — the legitimised pair names them.
    for (const needle of [
      'زمان‌بندی',
      'اشتراک',
      'ارسال خودکار',
      'هوش مصنوعی',
      'تحلیل هوشمند',
      'csv',
      'pdf',
    ]) {
      expect({ needle, present: source.toLowerCase().includes(needle.toLowerCase()) }).toEqual({
        needle,
        present: false,
      });
    }
  });

  it('renders no attendance metric the schema cannot carry — no duration, no rate, no status', () => {
    const source = codeOf('HrPersonnelTrafficReportView.tsx');
    // `employeeId` and `status` as identifiers or query keys would be an actor-id
    // filter or an invented attendance state — the contract refuses both.
    for (const needle of ['duration', 'attendanceRate', 'نرخ حضور', 'حاضر', 'غایب', 'تأخیر']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
    expect(source.toLowerCase()).not.toContain('employeeid');
  });

  it('offers no HR mutation — the report never punches, corrects, edits or clocks out', () => {
    const source = codeOf('HrPersonnelTrafficReportView.tsx');
    // The register's only navigation is the detail link; the attendance workflow
    // lives in HR's own screens and must not be reachable from here. Checked as
    // ROUTE shapes and API affordances — not bare words, because `row.clockIn` is
    // the contract's own field name and a word scan cannot tell the two apart.
    const tokens = source.toLowerCase().split(/[^a-z\u0600-\u06ff/]+/);
    for (const needle of ['/admin/hr/', 'clock-in', 'clock-out', 'adjust', 'fetchHrAttendance']) {
      expect({ needle, present: tokens.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
