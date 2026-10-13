import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HrTrafficReportView } from '../HrTrafficReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { fetchHrAttendance, fetchHrEmployees } from '@/lib/hr-api';
import { getCalendarMonth, getCalendarToday } from '@/lib/calendar-api';
import { attendance, employee, page } from './hr-fixtures';

/**
 * Phase 51-HR-2F-UI: the PERSONNEL TRAFFIC REPORT screen
 * (`/admin/hr/traffic-report`).
 *
 * WHAT THESE SPECS ARE FOR: this screen re-reads the SAME endpoint as the register, so the
 * interesting claims are the ones ONLY this screen can get wrong —
 *
 *   * that its window is ALWAYS BOUNDED. It opens on the SERVER's today (never the browser
 *     clock), in range mode it issues NOTHING until BOTH bounds exist, and it never sends
 *     `dateKey` together with `from`/`to`. The absence of a request is asserted, not just
 *     the shape of one;
 *   * that no number on it is invented. The only count is the server's `total`; the
 *     «کارکنان در این صفحه» tile is a fact about the PAYLOAD and is pinned as one, so it
 *     cannot drift into a headcount;
 *   * that the wire VALUES are shown as what they are: `workDate` is a DATE, `dateKey` is the
 *     server's Jalali day, and the punches are INSTANTS whose raw ISO stays in the DOM;
 *   * that it holds NO fallback dataset — a failed or empty read renders a STATE, never rows.
 *
 * The Jalali GRID is a server read (`GET /calendar/month`): it is stubbed here, and the stub
 * is deliberately left unresolved, so nothing on this screen can quietly depend on a
 * client-side calendar. The date-chip contract itself is pinned by its own specs.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrAttendance: jest.fn(),
  fetchHrEmployees: jest.fn(),
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  getCalendarToday: jest.fn(),
  getCalendarMonth: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const reportMock = fetchHrAttendance as jest.MockedFunction<typeof fetchHrAttendance>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;
const todayMock = getCalendarToday as jest.MockedFunction<typeof getCalendarToday>;
const monthMock = getCalendarMonth as jest.MockedFunction<typeof getCalendarMonth>;

const READ = 'hr.attendance.read';
const EMPLOYEES_READ = 'hr.employees.read';

/** 1405/06/27 — the SERVER's today, matching the register fixture's own Jalali day. */
const TODAY = {
  date: '1405/06/27',
  jy: 1405,
  jm: 6,
  jd: 27,
  monthName: 'شهریور',
  weekdayName: 'جمعه',
  weekday: 6,
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

/** Elements are reached by id where the labels alone would be ambiguous. */
const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

describe('HrTrafficReportView', () => {
  beforeEach(() => {
    grant([READ, EMPLOYEES_READ]);
    reportMock.mockResolvedValue(page([attendance()], 1));
    employeesMock.mockResolvedValue(page([employee()]));
    todayMock.mockResolvedValue(TODAY);
    // A grid that never answers: this screen must not need one, and a pending promise keeps
    // the stub from standing in for Jalali arithmetic the client never performs.
    monthMock.mockReturnValue(new Promise(() => {}) as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -- The route, its window and its read -----------------------------------------------------

  it('renders the report route with its filters', async () => {
    render(<HrTrafficReportView />);

    // `hr-traffic-report` is the SHELL: it is on screen while the read is still in flight.
    // The table only exists once the server has answered, so it is AWAITED rather than
    // assumed — and awaiting it here keeps the read inside this test instead of leaking a
    // late call into the next one.
    expect(await screen.findByTestId('hr-traffic-report')).toBeInTheDocument();
    expect(screen.getByTestId('hr-traffic-filters')).toBeInTheDocument();
    expect(await screen.findByTestId('hr-traffic-table')).toBeInTheDocument();
  });

  it('waits for the permission answer before it issues any read', async () => {
    grant([], true);

    render(<HrTrafficReportView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(reportMock).not.toHaveBeenCalled();

    // The calendar read still lands; awaiting it here keeps that resolution inside the test
    // instead of leaking a state update past its end — the same reason the register spec
    // awaits it. Nothing on this screen waits for the calendar to draw a report.
    await waitFor(() => expect(todayMock).toHaveBeenCalled());
  });

  it('refuses the report without hr.attendance.read and reads nothing', async () => {
    grant([]);

    render(<HrTrafficReportView />);

    // The message names the missing grant, so this spec does not depend on Persian wording.
    expect(screen.getByText(/hr\.attendance\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-table')).not.toBeInTheDocument();
    expect(reportMock).not.toHaveBeenCalled();
    // The directory read is a convenience OF the report, so it is not issued either.
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it("opens on the SERVER's today and sends exactly one date shape", async () => {
    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-table');

    expect(screen.getByTestId('hr-traffic-window-value')).toHaveTextContent('۱۴۰۵/۰۶/۲۷ (شمسی)');

    // `fetchHrAttendance` declares its input with a default (`input = {}`), so the parameter
    // it exposes through `Parameters<>` is OPTIONAL: the two `!`s assert the ONE awaited read
    // this spec is inspecting, not a shape the screen is allowed to send.
    const sent = reportMock.mock.calls[0]![0]!;
    expect(sent).toEqual(expect.objectContaining({ dateKey: '1405/06/27', page: 1, pageSize: 20 }));
    // The other shape is ABSENT, not empty: the API refuses the two together.
    expect(sent.from).toBeUndefined();
    expect(sent.to).toBeUndefined();
    // The actor is resolved server-side; a tenant in the request would be a bug the API
    // refuses outright, so it must not exist as a field this screen could fill.
    expect(sent).not.toHaveProperty('tenantId');
  });

  it('runs no query at all when the server cannot say what today is', async () => {
    todayMock.mockRejectedValue(new Error('offline'));

    render(<HrTrafficReportView />);

    // No window, no request — and no client clock standing in for the server's day.
    expect(await screen.findByTestId('hr-traffic-window-required')).toBeInTheDocument();
    expect(reportMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hr-traffic-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-summary')).not.toBeInTheDocument();
  });

  // -- The bounded-window rule ----------------------------------------------------------------

  it('offers exactly TWO date shapes, and no unbounded one', async () => {
    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    const options = within(byId<HTMLSelectElement>('hr-traffic-date-mode')).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('value'))).toEqual(['day', 'range']);
    // The register's third shape («همه روزها») is the unbounded request this screen exists
    // without, so it must not reappear here as an option.
    expect(options.map((option) => option.textContent)).not.toContain('همه روزها');
  });

  it('issues NO request in range mode until BOTH bounds are present', async () => {
    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    const callsBefore = reportMock.mock.calls.length;

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-date-mode'), 'range');

    // Switching the shape CLEARS the day: one bounded window is replaced by the other, and
    // the state says so instead of silently querying with a window nobody chose.
    expect(await screen.findByTestId('hr-traffic-window-required')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-range-filter')).toBeInTheDocument();

    await userEvent.type(byId<HTMLInputElement>('hr-traffic-from'), '2026-09-01');

    // ONE bound is not a window: no request is issued for a half-open range.
    expect(reportMock.mock.calls.length).toBe(callsBefore);

    await userEvent.type(byId<HTMLInputElement>('hr-traffic-to'), '2026-09-30');

    await waitFor(() =>
      expect(reportMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-09-01', to: '2026-09-30', page: 1 })
      )
    );
    // And the Jalali day is gone from the request, because the two shapes never coexist.
    expect(reportMock.mock.calls[reportMock.mock.calls.length - 1]![0]!.dateKey).toBeUndefined();
  });

  it('refuses an inverted range and does not ask the API to sort it out', async () => {
    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-date-mode'), 'range');
    const callsBefore = reportMock.mock.calls.length;

    await userEvent.type(byId<HTMLInputElement>('hr-traffic-from'), '2026-09-30');
    await userEvent.type(byId<HTMLInputElement>('hr-traffic-to'), '2026-09-01');

    expect(await screen.findByTestId('hr-traffic-window-required')).toBeInTheDocument();
    expect(reportMock.mock.calls.length).toBe(callsBefore);
  });

  it('sends the Gregorian bounds as `type="date"` values, unconverted', async () => {
    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-date-mode'), 'range');

    // The control's own value is the wire value, so no timezone can shift a bound by a day.
    expect(byId<HTMLInputElement>('hr-traffic-from')).toHaveAttribute('type', 'date');
    expect(byId<HTMLInputElement>('hr-traffic-to')).toHaveAttribute('type', 'date');
  });

  // -- What a row says, and what it must NOT say ----------------------------------------------

  it('renders the rows the API returned, with the wire values intact', async () => {
    reportMock.mockResolvedValue(
      page([attendance({ id: 'att-9', employee: { id: 'emp-9', employeeCode: 'E-9' } })], 1)
    );

    render(<HrTrafficReportView />);

    expect(await screen.findByTestId('hr-traffic-row-att-9')).toBeInTheDocument();
    expect(screen.getByTestId('hr-traffic-employee-E-9')).toHaveTextContent('E-9');
    expect(screen.getByTestId('hr-traffic-source-att-9')).toHaveTextContent('پانچ دستگاه');
  });

  it('renders workDate as a DATE, never as an ISO midnight timestamp', async () => {
    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-table');

    const cell = screen.getByTestId('hr-traffic-workdate-att-1');
    expect(cell).toHaveTextContent('2026-09-18');
    // The exact failure this guards: `new Date('2026-09-18')` re-rendered into a timestamp.
    expect(cell.textContent).not.toContain('T00:00');
    expect(cell.textContent).not.toContain('GMT');
    expect(cell.textContent).not.toContain('Z');
  });

  it("renders the SERVER's Jalali day and the weekday of that day", async () => {
    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-table');

    expect(screen.getByTestId('hr-traffic-day-att-1')).toHaveTextContent('۱۴۰۵/۰۶/۲۷');
    // 2026-09-18 is 1405/06/27 and a Friday — read off `workDate`, not off the clock.
    expect(screen.getByTestId('hr-traffic-weekday-att-1')).toHaveTextContent('جمعه');
  });

  it('renders the punches as instants, keeping the raw ISO auditable', async () => {
    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-table');

    const clockIn = screen.getByTestId('hr-traffic-in-att-1');
    const clockOut = screen.getByTestId('hr-traffic-out-att-1');

    // The moment is formatted for reading, in Persian digits — the API's instant, renumbered
    // for display, not a second computation of it.
    expect(clockIn).toHaveTextContent('۰۸:۰۰');
    expect(clockOut).toHaveTextContent('۱۷:۰۰');
    // …and the instant the API sent is still on the element, so the format is checkable.
    expect(clockIn).toHaveAttribute('title', '2026-09-18T08:00:00+03:30');
    expect(clockOut).toHaveAttribute('title', '2026-09-18T17:00:00+03:30');
  });

  it('renders a null clockOut as an OPEN day, not as a missing value', async () => {
    reportMock.mockResolvedValue(page([attendance({ id: 'att-open', clockOut: null })], 1));

    render(<HrTrafficReportView />);

    // `null` is a state — the day is still open — so it is a word rather than an em dash that
    // would read as «no data».
    expect(await screen.findByTestId('hr-traffic-open-att-open')).toHaveTextContent('باز');
    expect(screen.queryByTestId('hr-traffic-out-att-open')).not.toBeInTheDocument();
  });

  it('states a correction\u2019s reason, which is the row\u2019s own field', async () => {
    reportMock.mockResolvedValue(
      page(
        [
          attendance({
            id: 'att-manual',
            source: 'MANUAL',
            reason: 'ثبت ورود توسط سرپرست',
          }),
        ],
        1
      )
    );

    render(<HrTrafficReportView />);

    expect(await screen.findByTestId('hr-traffic-source-att-manual')).toHaveTextContent(
      'اصلاح دستی'
    );
    expect(screen.getByTestId('hr-traffic-reason-att-manual')).toHaveTextContent(
      'ثبت ورود توسط سرپرست'
    );
  });

  it('shows no derived verdict the schema cannot store', async () => {
    render(<HrTrafficReportView />);

    const table = await screen.findByTestId('hr-traffic-table');

    // There is no stored status, late minutes, overtime or leave in `Attendance`, so a column
    // claiming one would be the fabricated metric this phase exists to avoid.
    expect(table).not.toHaveTextContent('تأخیر');
    expect(table).not.toHaveTextContent('اضافه‌کار');
    expect(table).not.toHaveTextContent('مرخصی');
    expect(table).not.toHaveTextContent('غایب');
    expect(table).not.toHaveTextContent('حاضر');
  });

  // -- The tiles: server numbers and request facts, nothing derived ---------------------------

  it('counts with the SERVER total, and never with the rows it happens to hold', async () => {
    reportMock.mockResolvedValue(page([attendance({ id: 'att-1' })], 137));

    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-summary');

    // 137 matched the filter; ONE row came back. The tile must say 137, because a count of the
    // rows on screen would report «۱» for a tenant-wide window.
    expect(screen.getByTestId('hr-traffic-total-value')).toHaveTextContent('۱۳۷');
    expect(screen.getByTestId('hr-traffic-total-line')).toHaveTextContent('۱۳۷');

    // The page is derived from that same server total, not from `items.length`.
    expect(screen.getByTestId('hr-traffic-page-value')).toHaveTextContent('۱ از ۷');
  });

  it('labels the employee tile as a fact about THIS page, not a headcount', async () => {
    const one = { id: 'emp-1', employeeCode: 'E-1' };

    reportMock.mockResolvedValue(
      page(
        [
          attendance({ id: 'att-1', employeeId: 'emp-1', employee: one }),
          attendance({ id: 'att-2', employeeId: 'emp-1', employee: one }),
        ],
        2
      )
    );

    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-summary');

    // Two rows, one person: the tile counts DISTINCT employees in the payload…
    expect(screen.getByTestId('hr-traffic-employees-value')).toHaveTextContent('۱');
    // …and says so, so it cannot be read as a roster size.
    expect(screen.getByTestId('hr-traffic-employees')).toHaveTextContent('فقط رکوردهای همین صفحه');
  });

  it('names the window it actually sent to the server', async () => {
    render(<HrTrafficReportView />);

    await screen.findByTestId('hr-traffic-summary');

    // A fact about the REQUEST — the same bound the assertions above found on the wire.
    expect(screen.getByTestId('hr-traffic-window-value')).toHaveTextContent('۱۴۰۵/۰۶/۲۷ (شمسی)');
    expect(reportMock).toHaveBeenCalledWith(expect.objectContaining({ dateKey: '1405/06/27' }));
  });

  // -- The three states -----------------------------------------------------------------------

  it('renders the loading state before the report answers', async () => {
    reportMock.mockReturnValue(new Promise(() => {}) as never);

    render(<HrTrafficReportView />);

    await waitFor(() => expect(reportMock).toHaveBeenCalled());
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-table')).not.toBeInTheDocument();
  });

  it('renders the empty state for a window with no records, and invents no rows', async () => {
    reportMock.mockResolvedValue(page([], 0));

    render(<HrTrafficReportView />);

    expect(await screen.findByText('در این بازه رکوردی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-table')).not.toBeInTheDocument();
    // No fallback dataset: an empty answer renders NO row, not a placeholder one.
    expect(screen.queryAllByTestId(/^hr-traffic-row-/)).toHaveLength(0);
    // And no tile claims a number for it beyond the zero the server sent.
    expect(screen.getByTestId('hr-traffic-total-value')).toHaveTextContent('۰');
  });

  it('names the filters when an empty window is the result of them', async () => {
    reportMock.mockResolvedValue(page([], 0));

    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-report');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-source'), 'MANUAL');

    expect(
      await screen.findByText('در این بازه با این فیلترها رکوردی یافت نشد.')
    ).toBeInTheDocument();
  });

  it('renders the error state with a retry, and still no rows', async () => {
    reportMock.mockRejectedValueOnce(new CoreApiError('خواندن گزارش رفت‌وآمد ناموفق بود.', 500));

    render(<HrTrafficReportView />);

    expect(await screen.findByText('خواندن گزارش رفت‌وآمد ناموفق بود.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByTestId('hr-traffic-table')).not.toBeInTheDocument();
  });

  it('shows a 403 as a permission message rather than a retry that cannot work', async () => {
    reportMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<HrTrafficReportView />);

    // `CoreForbidden` is an alert; the retry affordance `CoreError` owns is deliberately absent.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  // -- Filters, pagination and the optional directory read -------------------------------------

  it('sends the source filter only when one is chosen', async () => {
    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    expect(reportMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: undefined, employeeId: undefined })
    );

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-source'), 'DEVICE');

    await waitFor(() =>
      expect(reportMock).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'DEVICE' }))
    );
  });

  it('resets to the first page when a filter changes', async () => {
    reportMock.mockResolvedValue(page([attendance()], 137));

    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    await userEvent.click(screen.getByTestId('hr-traffic-next'));
    await waitFor(() =>
      expect(reportMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );

    // A new filter is a NEW query: staying on page 2 would report a window the operator did
    // not ask for.
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-traffic-source'), 'MANUAL');
    await waitFor(() =>
      expect(reportMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, source: 'MANUAL' })
      )
    );
  });

  it('pages inside the SERVER total, and never past it', async () => {
    reportMock.mockResolvedValue(page([attendance()], 25));

    render(<HrTrafficReportView />);
    await screen.findByTestId('hr-traffic-table');

    // 25 records is two pages at `HR_DEFAULT_PAGE_SIZE`, and the first page cannot go back.
    expect(screen.getByTestId('hr-traffic-prev')).toBeDisabled();
    expect(screen.getByTestId('hr-traffic-next')).toBeEnabled();

    await userEvent.click(screen.getByTestId('hr-traffic-next'));
    await waitFor(() =>
      expect(reportMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );

    // The last page cannot go forward: the bound is the server's total, not a guess.
    await waitFor(() => expect(screen.getByTestId('hr-traffic-next')).toBeDisabled());
    expect(screen.getByTestId('hr-traffic-prev')).toBeEnabled();
  });

  it('links a row to the personnel file only with the read that page needs', async () => {
    const { unmount } = render(<HrTrafficReportView />);

    const link = await screen.findByTestId('hr-traffic-employee-E-1042');
    expect(link).toHaveAttribute('href', '/admin/hr/employees/emp-1');
    unmount();

    grant([READ]);
    render(<HrTrafficReportView />);

    const plain = await screen.findByTestId('hr-traffic-employee-E-1042');
    expect(plain).not.toHaveAttribute('href');
    expect(plain.tagName).toBe('SPAN');
    // The report is unaffected: the directory is a convenience, not a dependency.
    expect(screen.getByTestId('hr-traffic-table')).toBeInTheDocument();
  });

  it('degrades the optional directory read to a stated notice instead of breaking the report', async () => {
    employeesMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<HrTrafficReportView />);

    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('فهرست کارکنان');
    // The report is still fully rendered: the two reads are deliberately separate, so the
    // failed directory read cannot hold the report's own table back.
    expect(await screen.findByTestId('hr-traffic-table')).toBeInTheDocument();
  });
});

/**
 * Phase 51-HR-2F: the SHIPPED files, scanned as text.
 *
 * These specs cannot be written against the rendered DOM, because what they forbid is a
 * dependency or a fallback that would only appear on a code path a happy-path render never
 * reaches. They read the real files instead, and — like the register's own scan — they
 * EXCLUDE COMMENT LINES, because this view explains in prose what it refuses to do and a raw
 * line scan would fail on the explanation, the "fix" for which would be to delete the
 * reasoning. A line is dropped only when its trimmed form STARTS with `//`, `*` or `/*`.
 *
 * The four claims, all falsifiable:
 *   1. NO FABRICATED DATASET. A mock report has to be called something, and the names it is
 *      called are `mock`, `fake`, `dummy` and `fixture`. (`placeholder` is deliberately NOT
 *      scanned: it legitimately describes the filter fields.)
 *   2. NO DATABASE / NO PRISMA. The screen depends on the API contract only.
 *   3. NO SERVER CREDENTIAL, and no environment read of any kind.
 *   4. NO PARALLEL AUTHORIZATION MODEL: the screen gates on the permission STRINGS the
 *      backend's controllers declare (`useCorePermissions`, the Aria convention) and never
 *      decides for itself who holds them.
 *
 * A fifth claim belongs to THIS screen alone: NO CLIENT-SIDE JALALI ARITHMETIC. The register
 * may ask for «همه روزها»; the report may not — so its own source must not contain the
 * unbounded shape, and no request builder may put `dateKey` beside `from`/`to`.
 */
describe('HrTrafficReportView production surface', () => {
  /** The route, its screen, and the client contract the screen reads through. */
  const PRODUCTION_FILES = [
    join(__dirname, '..', 'HrTrafficReportView.tsx'),
    join(__dirname, '..', '..', '..', 'app', 'admin', 'hr', 'traffic-report', 'page.tsx'),
    join(__dirname, '..', '..', '..', 'lib', 'hr-api.ts'),
  ];

  /** The executable lines of a file, with their 1-based line numbers; comments dropped. */
  function codeLines(file: string): { text: string; line: number }[] {
    const out: { text: string; line: number }[] = [];
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        out.push({ text, line: index + 1 });
      });
    return out;
  }

  /** `file:line` for every code line matching `pattern`, so a failure says WHERE. */
  function offenders(pattern: RegExp): string[] {
    const found: string[] = [];
    for (const file of PRODUCTION_FILES) {
      for (const { text, line } of codeLines(file)) {
        if (pattern.test(text)) found.push(`${file}:${line}`);
      }
    }
    return found;
  }

  it('ships no fabricated attendance dataset for a failed read to fall back on', () => {
    expect(offenders(/\b(mock|fake|dummy|fixture)[A-Za-z_]*\b/i)).toEqual([]);
  });

  it('reaches no database and imports no Prisma client', () => {
    expect(offenders(/prisma|@prisma|PrismaClient|\$queryRaw|\$executeRaw/i)).toEqual([]);
  });

  it('holds no server credential and reads no environment variable', () => {
    expect(offenders(/process\.env|DATABASE_URL|JWT_[A-Z_]*|SECRET|PASSWORD/i)).toEqual([]);
  });

  it('gates on the backend permission strings, never on a role name of its own', () => {
    expect(offenders(/\b(roles?|isAdmin|isSuperAdmin)\s*(\.|\[|\?\?)/)).toEqual([]);
    expect(offenders(/SUPER_ADMIN|OPERATIONS_ADMIN|HR_ADMIN|TENANT_ADMIN/)).toEqual([]);

    // The positive half of the same claim: the screen DOES name the two grants the attendance
    // and employee controllers enforce, so the negative checks cannot pass vacuously.
    const view = readFileSync(join(__dirname, '..', 'HrTrafficReportView.tsx'), 'utf8');
    expect(view).toContain('hr.attendance.read');
    expect(view).toContain('hr.employees.read');
  });

  it('offers no unbounded window and no client-side Jalali conversion', () => {
    const view = join(__dirname, '..', 'HrTrafficReportView.tsx');

    // The third date shape is absent from the shipped CODE, not merely unselected — the view's
    // prose is allowed to say why it is absent, so only executable lines are scanned.
    expect(codeLines(view).filter(({ text }) => text.includes('همه روزها'))).toEqual([]);
    // A Jalali conversion in the browser is the second, drift-prone calendar this screen
    // refuses: the day comes from `GET /calendar/today` and the grid from `/calendar/month`.
    expect(offenders(/jalaliToGregorian|gregorianToJalali|new Date\(\s*\d{4}\s*,\s*\d/)).toEqual(
      []
    );
  });

  it('declares the route as a real page that is not indexable', () => {
    const page = readFileSync(
      join(__dirname, '..', '..', '..', 'app', 'admin', 'hr', 'traffic-report', 'page.tsx'),
      'utf8'
    );

    expect(page).toContain('HrTrafficReportView');
    expect(page).toContain('robots');
  });
});
