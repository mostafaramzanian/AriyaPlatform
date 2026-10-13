import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HrLeaveView } from '../HrLeaveView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  HR_DEFAULT_PAGE_SIZE,
  HR_MAX_PAGE_SIZE,
  cancelHrLeaveRequest,
  createHrLeaveRequest,
  createHrLeaveType,
  fetchHrEmployees,
  fetchHrLeaveRequests,
  fetchHrLeaveTypes,
  setHrLeaveTypeStatus,
} from '@/lib/hr-api';
import { employee, leaveRequest, leaveType, page } from './hr-fixtures';
import { approveLeaveRequest, fetchLeaveApproval } from '@/lib/hr-leave-approval-api';

/**
 * Phase 51-HR-3A-UI: the LEAVE REGISTER screen (`/admin/hr/leave`).
 *
 * WHAT THESE SPECS ARE FOR. The register re-reads an endpoint whose contract is already pinned
 * (`hr-api.spec.ts`) and whose rules are held in PostgreSQL and `LeaveService` (the API's own
 * `hr.e2e-spec.ts`). So the interesting claims are the ones only THIS screen can get wrong:
 *
 *   * that it reads through the REAL client, with the page size it declares, and issues NO
 *     request the grants do not cover — the register read needs `hr.leave.read`, the filters,
 *     the row links and the person picker additionally need `hr.employees.read`, and the two
 *     write surfaces need `hr.leave.manage`. A request that would 403 is asserted ABSENT,
 *     not merely unused;
 *   * that every cell is backend truth: the employee CODE the register carries, the type's own
 *     name and state, the two `YYYY-MM-DD` days printed verbatim beside their Jalali
 *     rendering, and a withdrawal shown as the INSTANT it is with the raw ISO kept in the DOM;
 *   * that the ONE transition the platform has (`PENDING → CANCELLED`) is offered only while it
 *     is legal — `CANCELLED` is terminal, so a second attempt is a guaranteed 409 and the
 *     control is withdrawn rather than left to fail;
 *   * that no concept the backend cannot produce appears anywhere: no approval, no decision
 *     state, no balance and no duration. A screen that rendered «مانده» would be inventing a
 *     policy, and that absence is pinned here in the DOM and in the shipped source;
 *   * that it holds NO fallback dataset: a failed or empty read renders a STATE, never rows.
 *
 * THE PERMISSION SIGNAL IS STUBBED, THE CLIENT IS NOT. `useCorePermissions` is mocked because a
 * spec cannot enrol a user; everything else is the production module (`jest.requireActual`), so
 * a change to a query builder or a label is a real failure here rather than a mock that agrees
 * with whatever the screen does.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrLeaveRequests: jest.fn(),
  fetchHrLeaveTypes: jest.fn(),
  fetchHrEmployees: jest.fn(),
  createHrLeaveRequest: jest.fn(),
  cancelHrLeaveRequest: jest.fn(),
  createHrLeaveType: jest.fn(),
  setHrLeaveTypeStatus: jest.fn(),
}));

// Phase 54-J: the approval READ is stubbed so the register spec can drive the panel's toggle without
// a second network contract. The real panel and its real Persian vocabulary are still mounted.
jest.mock('@/lib/hr-leave-approval-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-approval-api'),
  fetchLeaveApproval: jest.fn(),
  approveLeaveRequest: jest.fn(),
  rejectLeaveRequest: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const registerMock = fetchHrLeaveRequests as jest.MockedFunction<typeof fetchHrLeaveRequests>;
const catalogueMock = fetchHrLeaveTypes as jest.MockedFunction<typeof fetchHrLeaveTypes>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;
const createRequestMock = createHrLeaveRequest as jest.MockedFunction<typeof createHrLeaveRequest>;
const withdrawMock = cancelHrLeaveRequest as jest.MockedFunction<typeof cancelHrLeaveRequest>;
const createTypeMock = createHrLeaveType as jest.MockedFunction<typeof createHrLeaveType>;
const toggleTypeMock = setHrLeaveTypeStatus as jest.MockedFunction<typeof setHrLeaveTypeStatus>;
const approvalMock = fetchLeaveApproval as jest.MockedFunction<typeof fetchLeaveApproval>;

/** The three grants the two leave controllers and the employee controller enforce. */
const READ = 'hr.leave.read';
const MANAGE = 'hr.leave.manage';
const EMPLOYEES_READ = 'hr.employees.read';
/** Phase 54-J: the DECISION grant, separate from the register's own write grant. */
const APPROVE = 'hr.leave.approve';

/** `1405/06/29 – 1405/06/31`: the fixture's period, rendered in the reader's calendar. */
const PERIOD = '۱۴۰۵/۰۶/۲۹ – ۱۴۰۵/۰۶/۳۱';
/** The same instant the API stamps a withdrawal with, as Tehran reads it. */
const WITHDRAWN_LABEL = '۱۴۰۵/۰۶/۲۱ ۰۹:۳۰';

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

describe('HrLeaveView', () => {
  beforeEach(() => {
    grant([READ, MANAGE, EMPLOYEES_READ]);
    registerMock.mockResolvedValue(page([leaveRequest()], 1));
    catalogueMock.mockResolvedValue(page([leaveType()]));
    employeesMock.mockResolvedValue(page([employee()]));
    createRequestMock.mockResolvedValue(leaveRequest());
    withdrawMock.mockResolvedValue(
      leaveRequest({ status: 'CANCELLED', cancelledAt: '2026-09-12T06:00:00.000Z' })
    );
    createTypeMock.mockResolvedValue(
      leaveType({ id: 'lt-2', code: 'SICK', name: 'مرخصی استعلاجی' })
    );
    toggleTypeMock.mockResolvedValue(leaveType({ status: 'INACTIVE' }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -- The route, its grants and its reads -----------------------------------------------------

  it('renders the leave route with its filters and the real register', async () => {
    render(<HrLeaveView />);

    // `hr-leave` is the SHELL: it is on screen while the read is still in flight. The table only
    // exists once the server has answered, so it is AWAITED rather than assumed — which also keeps
    // the read inside this test instead of leaking a late call into the next one.
    expect(await screen.findByTestId('hr-leave')).toBeInTheDocument();
    expect(screen.getByTestId('hr-leave-filters')).toBeInTheDocument();
    expect(await screen.findByTestId('hr-leave-table')).toBeInTheDocument();
  });

  it('waits for the permission answer before it issues any read', async () => {
    grant([READ, MANAGE, EMPLOYEES_READ], true);
    render(<HrLeaveView />);

    // A loading permission state is not an empty one: nothing is requested, and nothing is
    // refused, until the answer is known.
    expect(screen.queryByTestId('hr-leave')).not.toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
    expect(catalogueMock).not.toHaveBeenCalled();
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('refuses the route without hr.leave.read, and reads nothing at all', async () => {
    grant([EMPLOYEES_READ]);
    render(<HrLeaveView />);

    expect(await screen.findByText(/hr\.leave\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave')).not.toBeInTheDocument();
    // The register read would be a 403, so it is never issued — and neither is the catalogue,
    // which answers to the SAME read.
    expect(registerMock).not.toHaveBeenCalled();
    expect(catalogueMock).not.toHaveBeenCalled();
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('reads the register through the real client, at the declared page size', async () => {
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    expect(registerMock).toHaveBeenCalledWith({
      employeeId: undefined,
      leaveTypeId: undefined,
      status: undefined,
      from: undefined,
      to: undefined,
      page: 1,
      pageSize: HR_DEFAULT_PAGE_SIZE,
    });
  });

  it('reads the whole catalogue with the register grant, and the directory only with its own', async () => {
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // The catalogue is read with `hr.leave.read` — the same read the register answers to — and it
    // is read at the cap, because it is the vocabulary of the request form as well as a list.
    expect(catalogueMock).toHaveBeenCalledWith({ pageSize: HR_MAX_PAGE_SIZE });
    expect(employeesMock).toHaveBeenCalledWith({ pageSize: HR_MAX_PAGE_SIZE });
  });

  it('issues no directory read without hr.employees.read, and degrades instead of failing', async () => {
    grant([READ, MANAGE]);
    render(<HrLeaveView />);

    // The register renders IN FULL: it carries the employee's own code, so the directory is a
    // convenience. What disappears is the filter, the name beside the code, the row link — and the
    // request that would have 403'd.
    expect(await screen.findByTestId('hr-leave-table')).toBeInTheDocument();
    expect(employeesMock).not.toHaveBeenCalled();
    expect(document.getElementById('hr-leave-employee')).toBeNull();
    expect(screen.getByTestId('hr-leave-employee-E-1042')).not.toHaveAttribute('href');
  });

  // -- Every cell is backend truth --------------------------------------------------------------

  it('prints the stored record: the code, the type as it was recorded, both calendars', async () => {
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    const row = within(screen.getByTestId('hr-leave-row-lr-1'));

    // The employee's OWN code, which the register's read carries — not a name this screen would
    // have had to join from a second endpoint and could then render wrongly.
    expect(row.getByTestId('hr-leave-employee-E-1042')).toHaveTextContent('E-1042');
    // The type's own name, from the row's own copy of the catalogue entry.
    expect(row.getByTestId('hr-leave-type-lr-1')).toHaveTextContent('مرخصی استحقاقی');
    // The same days twice: once in the reader's calendar, once EXACTLY as stored. `2026-09-22` is
    // the last day the leave covers, not the day it ends before — the range is inclusive.
    expect(row.getByTestId('hr-leave-period-lr-1')).toHaveTextContent(PERIOD);
    expect(row.getByTestId('hr-leave-days-lr-1')).toHaveTextContent('2026-09-20 – 2026-09-22');
    expect(row.getByTestId('hr-leave-reason-lr-1')).toHaveTextContent('سفر خانوادگی');
    // The state is a WORD, and it is the API's own word for recorded-and-untouched.
    expect(row.getByTestId('hr-leave-status-lr-1')).toHaveTextContent('ثبت‌شده');
    // A request that still stands carries no withdrawal stamp at all.
    expect(row.queryByTestId('hr-leave-withdrawn-lr-1')).not.toBeInTheDocument();
  });

  it('shows a withdrawal as the instant it is, and offers no second withdrawal', async () => {
    registerMock.mockResolvedValue(
      page([leaveRequest({ status: 'CANCELLED', cancelledAt: '2026-09-12T06:00:00.000Z' })], 1)
    );
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    const stamp = screen.getByTestId('hr-leave-withdrawn-lr-1');
    // The reader sees the instant on their own clock; the DOM keeps the raw ISO the API stamped,
    // so what was rendered stays inspectable instead of being a value nothing can check.
    expect(stamp).toHaveTextContent(WITHDRAWN_LABEL);
    expect(stamp).toHaveAttribute('title', '2026-09-12T06:00:00.000Z');
    expect(screen.getByTestId('hr-leave-status-lr-1')).toHaveTextContent('لغوشده');

    // `CANCELLED` is terminal, so a second attempt is a guaranteed 409: the control is WITHDRAWN
    // rather than left on screen to fail.
    expect(screen.queryByTestId('hr-leave-withdraw-lr-1')).not.toBeInTheDocument();
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  // -- The two write surfaces, and the grant they answer to -------------------------------------

  it('offers every write control only with hr.leave.manage, and never as a disabled tease', async () => {
    grant([READ, EMPLOYEES_READ]);
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // The register renders IN FULL for a holder of the read alone — the read is what the page is
    // for — and no control appears that would answer 403.
    expect(screen.getByTestId('hr-leave-row-lr-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-withdraw-lr-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-request')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-type-toggle-lt-1')).not.toBeInTheDocument();
    expect(withdrawMock).not.toHaveBeenCalled();
    expect(createRequestMock).not.toHaveBeenCalled();
    expect(toggleTypeMock).not.toHaveBeenCalled();
  });

  it('withdraws a standing request with the operator’s own stated reason', async () => {
    const user = userEvent.setup();
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    await user.click(screen.getByTestId('hr-leave-withdraw-lr-1'));

    // The reason is REQUIRED by the API and travels to the audit trail, so the control refuses to
    // send an empty one rather than letting the server refuse it.
    const submit = screen.getByTestId('hr-leave-withdraw-submit-lr-1');
    expect(submit).toBeDisabled();

    await user.type(byId('hr-leave-withdraw-reason-lr-1'), 'درخواست خود کارمند');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(withdrawMock).toHaveBeenCalledWith('lr-1', { reason: 'درخواست خود کارمند' })
    );
    // The register is RE-READ from the server rather than patched in place: one row edited
    // locally would briefly show a state the server had not confirmed.
    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('درخواست E-1042 لغو شد.')).toBeInTheDocument();
  });

  // -- Recording a request ----------------------------------------------------------------------

  it('refuses to offer the request form without hr.employees.read, and says why', async () => {
    grant([READ, MANAGE]);
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-request');

    // No person picker means no honest way to say WHO the leave is for, so there is no form at
    // all — stated in the card rather than left as an unusable empty select.
    expect(screen.getByTestId('hr-leave-request-blocked')).toHaveTextContent('hr.employees.read');
    expect(document.getElementById('hr-leave-form-employee')).toBeNull();
    expect(screen.queryByTestId('hr-leave-request-submit')).not.toBeInTheDocument();
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it('states that nothing can be requested while the catalogue is empty, and seeds nothing', async () => {
    catalogueMock.mockResolvedValue(page([], 0));
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-request');

    // An empty catalogue is a POLICY that has not been stated yet, not a broken control: the
    // screen says so, offers no form, and carries no default taxonomy to hide the gap.
    expect(
      await screen.findByText(
        'هنوز نوع مرخصی فعالی ثبت نشده است؛ تا زمانی که یک نوع مرخصی ثبت نشود، درخواستی قابل ثبت نیست.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-request-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-form-type')).not.toBeInTheDocument();
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it('submits the API’s own wire shape, and only once every one of its five values exists', async () => {
    const user = userEvent.setup();
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    const submit = screen.getByTestId('hr-leave-request-submit');
    expect(submit).toBeDisabled();

    await user.selectOptions(byId('hr-leave-form-employee'), 'emp-1');
    await user.selectOptions(byId('hr-leave-form-type'), 'lt-1');
    fireEvent.change(byId('hr-leave-form-start'), { target: { value: '2026-09-20' } });
    fireEvent.change(byId('hr-leave-form-end'), { target: { value: '2026-09-22' } });
    expect(submit).toBeDisabled(); // the reason is still missing

    await user.type(byId('hr-leave-form-reason'), 'سفر خانوادگی');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(createRequestMock).toHaveBeenCalledWith({
        employeeId: 'emp-1',
        leaveTypeId: 'lt-1',
        startDate: '2026-09-20',
        endDate: '2026-09-22',
        reason: 'سفر خانوادگی',
      })
    );
    // NO `status` travels: the initial state is a DOMAIN constant on the server, so the only body
    // this form can produce is a PENDING one.
    expect(createRequestMock.mock.calls[0][0]).not.toHaveProperty('status');
    expect(await screen.findByText('درخواست مرخصی برای E-1042 ثبت شد.')).toBeInTheDocument();
  });

  // -- The tenant's own catalogue ---------------------------------------------------------------

  it('adds a kind of leave to the tenant’s own catalogue, and only when both fields are stated', async () => {
    const user = userEvent.setup();
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-type-table');

    const submit = screen.getByTestId('hr-leave-type-submit');
    expect(submit).toBeDisabled();

    await user.type(byId('hr-leave-type-code'), 'SICK');
    expect(submit).toBeDisabled(); // the name is still missing
    await user.type(byId('hr-leave-type-name'), 'مرخصی استعلاجی');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(createTypeMock).toHaveBeenCalledWith({ code: 'SICK', name: 'مرخصی استعلاجی' })
    );
    // The catalogue is re-read, so the entry the screen now names is the SERVER's row.
    await waitFor(() => expect(catalogueMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('نوع مرخصی «مرخصی استعلاجی» ثبت شد.')).toBeInTheDocument();
  });

  it('retires a kind rather than deleting it, choosing the next state from the server’s own', async () => {
    const user = userEvent.setup();
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-type-table');

    // The button asks for the state OPPOSITE to the one the server sent — a type that has ever
    // been requested cannot be deleted from under its own history (`ON DELETE RESTRICT`).
    expect(screen.getByTestId('hr-leave-type-toggle-lt-1')).toHaveTextContent('بازنشستگی');
    await user.click(screen.getByTestId('hr-leave-type-toggle-lt-1'));

    await waitFor(() => expect(toggleTypeMock).toHaveBeenCalledWith('lt-1', 'INACTIVE'));
    // The `code` is an identity node, exactly as it is on `OrganizationUnit`: never sent as an
    // edit, so a report that cites it keeps citing the same entry.
    expect(toggleTypeMock.mock.calls[0]).toHaveLength(2);
    expect(toggleTypeMock).toHaveBeenLastCalledWith('lt-1', 'INACTIVE');
    expect(await screen.findByText('نوع مرخصی «مرخصی استحقاقی» بازنشسته شد.')).toBeInTheDocument();
  });

  // -- Filters and pages are the server's query, never a client-side slice -----------------------

  it('turns every filter into a query parameter and returns to the first page', async () => {
    const user = userEvent.setup();
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');
    expect(registerMock).toHaveBeenCalledTimes(1);

    await user.selectOptions(byId('hr-leave-status'), 'PENDING');

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith({
        employeeId: undefined,
        leaveTypeId: undefined,
        status: 'PENDING',
        from: undefined,
        to: undefined,
        page: 1,
        pageSize: HR_DEFAULT_PAGE_SIZE,
      })
    );

    // Nothing is filtered IN THE BROWSER: the row on screen is still whatever the server returned
    // for the query, and the «clear» control exists only once a filter does.
    expect(screen.getByTestId('hr-leave-row-lr-1')).toBeInTheDocument();
    const clear = await screen.findByTestId('hr-leave-filters-clear');
    await user.click(clear);

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith({
        employeeId: undefined,
        leaveTypeId: undefined,
        status: undefined,
        from: undefined,
        to: undefined,
        page: 1,
        pageSize: HR_DEFAULT_PAGE_SIZE,
      })
    );
    expect(screen.queryByTestId('hr-leave-filters-clear')).not.toBeInTheDocument();
  });

  it('pages by the server’s own total, not by the rows it happens to be showing', async () => {
    const user = userEvent.setup();
    registerMock.mockResolvedValue(page([leaveRequest()], 41));
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // ONE row on screen, forty-one in the tenant: the total is the SERVER's, and at the page size
    // this screen declares that is three pages.
    expect(screen.getByTestId('hr-leave-total')).toHaveTextContent('۴۱ درخواست');
    expect(screen.getByTestId('hr-leave-prev')).toBeDisabled();
    expect(screen.getByTestId('hr-leave-next')).toBeEnabled();

    await user.click(screen.getByTestId('hr-leave-next'));

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, pageSize: HR_DEFAULT_PAGE_SIZE })
      )
    );
  });

  // -- No fallback dataset, and no concept the backend cannot state ------------------------------

  it('renders the API’s own message when the read fails, and invents no rows to fill the gap', async () => {
    registerMock.mockRejectedValue(new CoreApiError('درخواست مرخصی با این شناسه یافت نشد.', 404));
    render(<HrLeaveView />);

    // The server's own sentence reaches the operator verbatim — and a retry is offered, because a
    // failed read is a failure the server can answer differently the second time.
    expect(await screen.findByText('درخواست مرخصی با این شناسه یافت نشد.')).toBeInTheDocument();
    expect(screen.getByText('تلاش دوباره')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-row-lr-1')).not.toBeInTheDocument();
  });

  it('answers a refused register read with a refusal, and no retry that could never succeed', async () => {
    registerMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));
    render(<HrLeaveView />);

    // A 403 is a missing grant, so there is nothing to retry: the state says so and offers no
    // button that would fail identically.
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByText('تلاش دوباره')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-table')).not.toBeInTheDocument();
  });

  it('holds no fallback dataset: an empty register renders a state, never a row', async () => {
    registerMock.mockResolvedValue(page([], 0));
    render(<HrLeaveView />);

    expect(await screen.findByText('هنوز درخواست مرخصی‌ای ثبت نشده است.')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-row-lr-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('hr-leave-total')).toHaveTextContent('۰ درخواست');
    // The catalogue is read with the register's OWN grant and is what the filtering vocabulary
    // comes from, so it is still there to name what a future request could be recorded under.
    expect(await screen.findByTestId('hr-leave-type-table')).toBeInTheDocument();
  });

  it('renders no balance, no duration and no decision — in the columns or in the source', async () => {
    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // The API has no balance column, no working-day count and no approval state. The screen may
    // SAY they are not computed — it does, once, above the register — but it must never render one
    // as though it were a value, and the column set is the proof: seven headers, none of them a
    // number nobody computed.
    const table = screen.getByTestId('hr-leave-table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers.join(' ')).not.toMatch(/مانده|مدت|تأیید|تایید|تصویب|روز کاری/);
    expect(headers).toEqual([
      'کارمند',
      'نوع مرخصی',
      'بازه (شمسی)',
      'روزها (میلادی)',
      'دلیل',
      'وضعیت',
      'اقدام',
    ]);

    // PHASE 54-J NARROWED THIS GUARD, AND THIS IS THE NARROWING. Before 54-J there WAS no decision
    // surface, so "no decision word anywhere in the table" was the right claim. Now there is one —
    // an explicitly labelled affordance that opens the approval flow — so what survives is what the
    // guard was really protecting: the register's own VALUES state no decision, and the STATUS
    // column still carries only the request's two members (§4). A decision word may appear solely
    // inside that affordance, never as a cell or as a status badge.
    const statusCell = within(table).getByTestId('hr-leave-status-lr-1');
    expect(statusCell).not.toHaveTextContent(/تأیید|تایید|تصویب|رد/);

    for (const cell of within(table).getByTestId('hr-leave-row-lr-1').querySelectorAll('td')) {
      // The action cell holds the approval toggle, which is named and is not a register value; every
      // other cell is a recorded fact and must state no decision.
      if (cell.querySelector('[data-testid^="hr-leave-approval-toggle-"]') !== null) continue;
      expect(cell.textContent ?? '').not.toMatch(/تأیید|تایید|تصویب/);
    }

    // The same claim in the shipped source, where no comment can excuse it: there is no helper and
    // no constant that would compute an entitlement, a remainder or a duration.
    const source = readFileSync(join(__dirname, '..', 'HrLeaveView.tsx'), 'utf8');
    expect(source).not.toMatch(
      /leaveBalance|remainingDays|workingDays|dayCount|approvalStatus|entitlementDays/
    );
    // And no default taxonomy: a tenant's leave kinds are its own rows, so no code is baked in.
    expect(source).not.toMatch(/'ANNUAL'|'SICK'|DEFAULT_LEAVE_TYPES/);
    expect(source).toContain('hr.leave.manage');
    // 54-J's grant, held SEPARATELY from the register's write grant: being allowed to record a
    // request is not being allowed to decide one.
    expect(source).toContain('hr.leave.approve');
  });

  // -- Phase 54-J: the decision surface, reached from the register's own action cell ---------------

  it('offers the approval flow to a reader, and reads it only once the row asks for it', async () => {
    // An ACTIVE, decidable flow: the case where a grant-less reader must see everything and be
    // offered nothing, which is the claim this test is for.
    approvalMock.mockResolvedValue({
      id: 'instance-1',
      leaveRequestId: 'lr-1',
      status: 'ACTIVE',
      stepCount: 1,
      requestStartDate: '2026-09-20',
      requestEndDate: '2026-09-22',
      steps: [],
      decidableByActor: true,
      undecidableReason: null,
    });
    grant([READ, EMPLOYEES_READ]);

    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // The toggle is offered by the READ alone: the flow is a read, so a holder of `hr.leave.read`
    // without the decision grant still gets to see it.
    const toggle = screen.getByTestId('hr-leave-approval-toggle-lr-1');
    expect(toggle).toHaveTextContent('گردش تأیید');
    // Nothing is fetched speculatively for rows nobody opened (§10).
    expect(approvalMock).not.toHaveBeenCalled();

    await userEvent.click(toggle);

    await waitFor(() => expect(approvalMock).toHaveBeenCalledWith('lr-1'));
    // With no grant the panel shows the flow but offers no control, and names the missing grant.
    expect(await screen.findByTestId('hr-leave-approval-readonly-lr-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-approval-approve-lr-1')).not.toBeInTheDocument();
  });

  it('passes the row’s own reason through to the approval panel (Phase 55 Step 7)', async () => {
    approvalMock.mockResolvedValue({
      id: 'instance-1',
      leaveRequestId: 'lr-1',
      status: 'ACTIVE',
      stepCount: 1,
      requestStartDate: '2026-09-20',
      requestEndDate: '2026-09-22',
      steps: [],
      decidableByActor: true,
      undecidableReason: null,
    });
    grant([READ, APPROVE, EMPLOYEES_READ]);

    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    // The row's own cell renders the reason, as it always has — the register's contract is not
    // this step's to change.
    expect(screen.getByTestId('hr-leave-reason-lr-1')).toHaveTextContent('سفر خانوادگی');

    await userEvent.click(screen.getByTestId('hr-leave-approval-toggle-lr-1'));

    // ...and the PANEL shows the SAME string, taken from `row.reason` rather than fetched again.
    expect(await screen.findByTestId('hr-leave-approval-request-reason-lr-1')).toHaveTextContent(
      'سفر خانوادگی'
    );
    // Exactly ONE approval fetch: the reason arrives with the row, not through a second read.
    expect(approvalMock).toHaveBeenCalledTimes(1);
  });

  it('shows a decidable flow and refreshes the register after a decision', async () => {
    grant([READ, MANAGE, EMPLOYEES_READ, APPROVE]);
    approvalMock.mockResolvedValue({
      id: 'instance-1',
      leaveRequestId: 'lr-1',
      status: 'ACTIVE',
      stepCount: 1,
      requestStartDate: '2026-09-20',
      requestEndDate: '2026-09-22',
      steps: [],
      decidableByActor: true,
      undecidableReason: null,
    });
    (approveLeaveRequest as jest.MockedFunction<typeof approveLeaveRequest>).mockResolvedValue({
      id: 'instance-1',
      leaveRequestId: 'lr-1',
      status: 'COMPLETED',
      stepCount: 1,
      requestStartDate: '2026-09-20',
      requestEndDate: '2026-09-22',
      steps: [],
      decidableByActor: false,
      undecidableReason: null,
    });

    render(<HrLeaveView />);
    await screen.findByTestId('hr-leave-table');

    await userEvent.click(screen.getByTestId('hr-leave-approval-toggle-lr-1'));

    const approve = await screen.findByTestId('hr-leave-approval-approve-lr-1');
    expect(registerMock).toHaveBeenCalledTimes(1);

    await userEvent.click(approve);

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(2));
  });
});
