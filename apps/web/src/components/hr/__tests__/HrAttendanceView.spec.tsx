import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HrAttendanceView } from '../HrAttendanceView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { fetchHrAttendance, fetchHrEmployees } from '@/lib/hr-api';
import { getCalendarToday } from '@/lib/calendar-api';
import { attendance, employee, page } from './hr-fixtures';

/**
 * Phase 51-HR-2E-UI: the attendance REGISTER screen.
 *
 * WHAT THESE SPECS ARE FOR: the screen is a rendering of one API read, so what is pinned
 * here is the CONTRACT with that read and the three things a renderer could get wrong on
 * its own —
 *
 *   * that the wire VALUES are shown as what they are, not reinterpreted: `workDate` is a
 *     DATE (`2026-09-18`, never an ISO midnight stamp) and `clockIn`/`clockOut` are INSTANTS
 *     (formatted, with the raw ISO kept in the DOM);
 *   * that the screen never offers a number or a verdict the backend does not provide
 *     (no status, no late minutes, no overtime, no leave) — the absence is asserted, because
 *     an invented column is exactly the failure this phase exists to avoid;
 *   * that it holds NO fallback dataset: a failed or empty read renders a STATE, never rows.
 *
 * The Jalali grid is stubbed because its own contract (`GET /calendar/today`) is pinned by
 * the date-chip and calendar specs; a client clock must never stand in for it here.
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
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const registerMock = fetchHrAttendance as jest.MockedFunction<typeof fetchHrAttendance>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;
const todayMock = getCalendarToday as jest.MockedFunction<typeof getCalendarToday>;

const READ = 'hr.attendance.read';
const EMPLOYEES_READ = 'hr.employees.read';

/** 1405/06/27 — the server's today, matching the register fixture's own Jalali day. */
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

describe('HrAttendanceView', () => {
  beforeEach(() => {
    grant([READ, EMPLOYEES_READ]);
    registerMock.mockResolvedValue(page([attendance()], 1));
    employeesMock.mockResolvedValue(page([employee()]));
    todayMock.mockResolvedValue(TODAY);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -- The route and its read --------------------------------------------------------------

  it('renders the attendance register route', async () => {
    render(<HrAttendanceView />);

    expect(await screen.findByTestId('hr-attendance')).toBeInTheDocument();
    expect(screen.getByTestId('hr-attendance-table')).toBeInTheDocument();
  });

  it('waits for the permission answer before it issues any read', () => {
    grant([], true);

    render(<HrAttendanceView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('refuses the register without hr.attendance.read and reads nothing', () => {
    grant([]);

    render(<HrAttendanceView />);

    // The message names the missing grant, so this spec does not depend on Persian wording.
    expect(screen.getByText(/hr\.attendance\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-attendance-table')).not.toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('reads the real register through the API client, with no tenant of its own', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20, search: '' })
    );
    // The actor is resolved server-side; a tenant in the request would be a bug the API
    // refuses outright, so it must not exist as a field this screen could fill.
    expect(registerMock.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });

  // -- The three states -------------------------------------------------------------------

  it('renders the loading state before the register answers', async () => {
    registerMock.mockReturnValue(new Promise(() => {}) as never);

    render(<HrAttendanceView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-attendance-table')).not.toBeInTheDocument();

    // The calendar read the day picker waits for still lands; awaiting it here keeps that
    // resolution inside the test instead of leaking an update past its end.
    await waitFor(() => expect(todayMock).toHaveBeenCalled());
  });

  it('renders the empty state for a register with no punches, and invents no rows', async () => {
    registerMock.mockResolvedValue(page([], 0));

    render(<HrAttendanceView />);

    expect(await screen.findByText('هنوز پانچی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-attendance-table')).not.toBeInTheDocument();
    // No fallback dataset: an empty answer renders NO row, not a placeholder one.
    expect(screen.queryAllByTestId(/^hr-attendance-row-/)).toHaveLength(0);
  });

  it('names the filters when an empty register is the result of them', async () => {
    registerMock.mockResolvedValue(page([], 0));

    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-attendance-source'), 'MANUAL');

    expect(await screen.findByText('پانچی با این فیلترها یافت نشد.')).toBeInTheDocument();
  });

  it('renders the error state with a retry, and still no rows', async () => {
    registerMock.mockRejectedValueOnce(
      new CoreApiError('دریافت دفتر حضور و غیاب با خطا مواجه شد.', 500)
    );

    render(<HrAttendanceView />);

    expect(await screen.findByText('دریافت دفتر حضور و غیاب با خطا مواجه شد.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByTestId('hr-attendance-table')).not.toBeInTheDocument();
  });

  it('shows a 403 as a permission message rather than an error with a retry that cannot work', async () => {
    registerMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<HrAttendanceView />);

    // `CoreForbidden` is an alert; the retry affordance `CoreError` owns is deliberately absent.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  // -- What a row says, and what it must NOT say --------------------------------------------

  it('renders the real register rows the API returned', async () => {
    registerMock.mockResolvedValue(
      page([attendance({ id: 'att-9', employee: { id: 'emp-9', employeeCode: 'E-9' } })], 1)
    );

    render(<HrAttendanceView />);

    expect(await screen.findByTestId('hr-attendance-row-att-9')).toBeInTheDocument();
    expect(screen.getByTestId('hr-attendance-employee-E-9')).toBeInTheDocument();
    expect(screen.getByTestId('hr-attendance-source-att-9')).toHaveTextContent('پانچ دستگاه');
    expect(screen.getByTestId('hr-attendance-total')).toHaveTextContent('۱');
  });

  it('renders workDate as a DATE, never as an ISO midnight timestamp', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    const cell = screen.getByTestId('hr-attendance-workdate-att-1');
    expect(cell).toHaveTextContent('2026-09-18');
    // The exact failure this guards: `new Date('2026-09-18')` re-rendered into a timestamp.
    expect(cell.textContent).not.toContain('T00:00');
    expect(cell.textContent).not.toContain('GMT');
    expect(cell.textContent).not.toContain('Z');
  });

  it('renders the SERVER\u2019s Jalali day, and the weekday of that day', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    expect(screen.getByTestId('hr-attendance-day-att-1')).toHaveTextContent('۱۴۰۵/۰۶/۲۷');
    // 2026-09-18 is 1405/06/27 and a Friday — read off `workDate`, not off the clock.
    expect(screen.getByTestId('hr-attendance-weekday-att-1')).toHaveTextContent('جمعه');
  });

  it('renders clockIn and clockOut as instants, keeping the raw ISO auditable', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    const checkIn = screen.getByTestId('hr-attendance-in-att-1');
    const checkOut = screen.getByTestId('hr-attendance-out-att-1');

    expect(checkIn).toHaveTextContent('۰۸:۰۰');
    expect(checkOut).toHaveTextContent('۱۷:۰۰');
    // The value the device recorded is in the DOM, so the display is not the only evidence.
    expect(checkIn).toHaveAttribute('title', '2026-09-18T08:00:00+03:30');
    expect(checkOut).toHaveAttribute('title', '2026-09-18T17:00:00+03:30');
  });

  it('states an open day as a word, because null is a state and not missing data', async () => {
    registerMock.mockResolvedValue(page([attendance({ clockOut: null })], 1));

    render(<HrAttendanceView />);

    expect(await screen.findByTestId('hr-attendance-open-att-1')).toHaveTextContent('باز');
  });

  it('shows a MANUAL correction with its stated reason, and never tones it as a device punch', async () => {
    registerMock.mockResolvedValue(
      page([attendance({ id: 'att-2', source: 'MANUAL', reason: 'دستگاه خراب بود' })], 1)
    );

    render(<HrAttendanceView />);

    expect(await screen.findByTestId('hr-attendance-source-att-2')).toHaveTextContent('اصلاح دستی');
    expect(screen.getByTestId('hr-attendance-reason-att-2')).toHaveTextContent('دستگاه خراب بود');
  });

  it('renders no status, no late minutes, no overtime and no leave \u2014 none of which the API returns', async () => {
    render(<HrAttendanceView />);

    const view = await screen.findByTestId('hr-attendance');

    // The register stores a punch WINDOW; a verdict needs the shift and the calendar (§13).
    // An invented column here would put a claim on somebody's record that no server made.
    for (const invented of ['تاخیر', 'اضافه‌کار', 'مرخصی', 'غیبت', 'درصد']) {
      expect(view.textContent).not.toContain(invented);
    }

    // And the screen SAYS why the verdict is missing instead of leaving a column blank.
    expect(screen.getByTestId('hr-attendance-scope').textContent).toContain('تقویم شیفت');
    // No column header claims a status either.
    expect(screen.queryByText('وضعیت')).not.toBeInTheDocument();
  });

  // -- Permission-shaped controls, per the existing Aria conventions -------------------------

  it('offers no write control at all, because the screen holds only the read grant', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    // `hr.attendance.manage` gates clock-in / clock-out / adjustments on the backend. This
    // screen never issues a write, so no punch control may exist even for a manager — the
    // register is evidence, and it is corrected through the API, not by editing it here.
    expect(
      screen.queryByRole('button', { name: /پانچ|ثبت ورود|ثبت خروج|اصلاح/ })
    ).not.toBeInTheDocument();
  });

  it('omits the employee filter, and the read behind it, without hr.employees.read', async () => {
    grant([READ]);

    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    expect(document.getElementById('hr-attendance-employee')).toBeNull();
    // The screen does not issue a read it knows would be a 403.
    expect(employeesMock).not.toHaveBeenCalled();
    // The register itself is unaffected: its own read carries the employee code.
    expect(screen.getByTestId('hr-attendance-employee-E-1042')).toBeInTheDocument();
  });

  it('turns an employee code into a link only when the personnel read is held', async () => {
    grant([READ, EMPLOYEES_READ]);

    const { unmount } = render(<HrAttendanceView />);
    const link = await screen.findByTestId('hr-attendance-employee-E-1042');

    expect(link).toHaveAttribute('href', '/admin/hr/employees/emp-1');
    unmount();

    grant([READ]);
    render(<HrAttendanceView />);

    const plain = await screen.findByTestId('hr-attendance-employee-E-1042');
    expect(plain).not.toHaveAttribute('href');
    expect(plain.tagName).toBe('SPAN');
  });

  it('degrades the optional directory read to a stated notice instead of breaking the register', async () => {
    employeesMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<HrAttendanceView />);

    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('فهرست کارکنان');
    // The register is still fully rendered: the two reads are deliberately separate.
    expect(screen.getByTestId('hr-attendance-table')).toBeInTheDocument();
  });

  // -- The date filter, in the CONTRACT's language -------------------------------------------

  it('asks for one Jalali day with dateKey, and never together with a Gregorian range', async () => {
    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance-table');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-attendance-date-mode'), 'day');

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateKey: undefined, from: undefined, to: undefined })
      )
    );
    // The day control is offered, and the picker itself is not fetched until it is opened.
    expect(screen.getByTestId('hr-attendance-day-filter')).toBeInTheDocument();
    expect(screen.getByTestId('hr-attendance-day-open')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('hr-attendance-range-filter')).not.toBeInTheDocument();
  });

  it('sends a Gregorian range as from/to without converting it to a timestamp', async () => {
    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance-table');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-attendance-date-mode'), 'range');

    const from = byId<HTMLInputElement>('hr-attendance-from');
    const to = byId<HTMLInputElement>('hr-attendance-to');

    // `type="date"` is the `YYYY-MM-DD` control: the value the operator picks is the wire
    // value, so nothing here can shift a day through a timezone.
    expect(from).toHaveAttribute('type', 'date');
    expect(to).toHaveAttribute('type', 'date');

    await userEvent.type(from, '2026-09-01');
    await userEvent.type(to, '2026-09-30');

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-09-01', to: '2026-09-30', dateKey: undefined })
      )
    );
  });

  it('sends the source filter only when one is chosen', async () => {
    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance-table');

    expect(registerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: undefined, employeeId: undefined })
    );

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-attendance-source'), 'DEVICE');

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'DEVICE' }))
    );
  });

  it('drives the server search after the debounce rather than per keystroke', async () => {
    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance-table');
    registerMock.mockClear();

    await userEvent.type(byId<HTMLInputElement>('hr-attendance-search'), 'E-1042');

    await waitFor(
      () =>
        expect(registerMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'E-1042' })
        ),
      { timeout: 5000 }
    );
    // Six characters never become six requests.
    expect(registerMock.mock.calls.length).toBeLessThan(3);
  });

  // -- Paging and the server's total ---------------------------------------------------------

  it('pages on the server, and disables the arrows at the ends of the range', async () => {
    registerMock.mockResolvedValue(page([attendance()], 45));

    render(<HrAttendanceView />);
    await screen.findByTestId('hr-attendance-table');

    // `total` is the server's, so the page count is derived from it — not from the one row
    // on screen, which would report a single page.
    expect(screen.getByText(/صفحه ۱ از ۳/)).toBeInTheDocument();
    expect(screen.getByTestId('hr-attendance-prev')).toBeDisabled();
    expect(screen.getByTestId('hr-attendance-next')).toBeEnabled();

    await userEvent.click(screen.getByTestId('hr-attendance-next'));

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );
  });

  it('sends no tenant of its own, because the backend resolves the actor', async () => {
    render(<HrAttendanceView />);

    await screen.findByTestId('hr-attendance-table');

    // Every call carries query semantics only: tenant resolution, the tenancy guards and the
    // authorization decision all stay on the server.
    for (const [args] of registerMock.mock.calls) {
      expect(Object.keys(args ?? {})).not.toContain('tenantId');
    }
    // The directory read is bounded by the page size the client clamps.
    expect(employeesMock).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 100 }));
  });
});

/**
 * Phase 51-HR-2E-UI: the ATTENDANCE UI's production surface, guarded at the source.
 *
 * WHY A SOURCE SCAN AND NOT ANOTHER RENDER. The behavioural specs above prove the screen
 * renders a STATE — never rows — for an empty or failed read. That pins the OBSERVABLE
 * behaviour, but not the claim this phase is actually built on: that there is no
 * attendance dataset in the production code for a render to fall back to at all. A
 * fallback fleet of plausible-looking rows would still satisfy "the empty state renders"
 * while being exactly the mock data the phase forbids, so the absence is asserted here.
 *
 * THIS IS THE SAME TECHNIQUE `apps/api/src/modules/hr/hr-isolation.spec.ts` uses, and it
 * excludes COMMENT LINES for the same reason it does: the view explains in prose that it
 * invents no rows, and a raw line scan would fail on that explanation — the "fix" for
 * which would be to delete the reasoning. The filter is conservative: it drops a line only
 * when its trimmed form STARTS with `//`, `*` or `/*`.
 *
 * The four claims, all falsifiable:
 *   1. NO FABRICATED DATASET. A mock register has to be called something, and the names it
 *      is called are `mock`, `fake`, `dummy` and `fixture`. (`placeholder` is deliberately
 *      NOT scanned: it legitimately describes the FORM fields and the picker's empty label.)
 *   2. NO DATABASE / NO PRISMA. The screen depends on the API contract only.
 *   3. NO SERVER CREDENTIAL, and no environment read of any kind — the browser has no
 *      business holding one, and a `process.env` reference here would be the shape of a
 *      leak that also silently differs between server and client render.
 *   4. NO PARALLEL AUTHORIZATION MODEL. The screen gates on the permission STRINGS the
 *      backend's controllers declare (`useCorePermissions`, the Aria convention). It must
 *      not decide who holds them: a role-name check would be a second, drift-prone
 *      authorization model — and never the security boundary, which stays on the server.
 */
describe('HrAttendanceView production surface', () => {
  /** The route, its screen, and the client contract the screen reads through. */
  const PRODUCTION_FILES = [
    join(__dirname, '..', 'HrAttendanceView.tsx'),
    join(__dirname, '..', '..', '..', 'app', 'admin', 'hr', 'attendance', 'page.tsx'),
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

    // The positive half of the same claim: the screen DOES name the two grants the
    // attendance and employee controllers enforce, so the negative checks above cannot
    // pass by the screen simply having no permission model at all.
    const view = readFileSync(join(__dirname, '..', 'HrAttendanceView.tsx'), 'utf8');
    expect(view).toContain('hr.attendance.read');
    expect(view).toContain('hr.employees.read');
  });
});
