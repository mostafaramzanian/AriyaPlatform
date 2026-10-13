import {
  HR_ATTENDANCE_SOURCES,
  HR_LEAVE_REQUEST_STATUSES,
  HR_MAX_PAGE_SIZE,
  buildAttendanceQuery,
  buildLeaveRequestQuery,
  buildLeaveTypeQuery,
  buildEmployeeQuery,
  buildPositionQuery,
  buildUnitQuery,
  createHrEmployee,
  createHrPosition,
  createHrUnit,
  fetchHrAttendance,
  fetchHrEmployee,
  fetchHrEmployees,
  fetchHrEmploymentHistory,
  fetchHrOrganizationSummary,
  fetchHrOrganizationTree,
  fetchHrPositions,
  hrAttendanceDayLabel,
  hrAttendanceSourceLabel,
  hrAttendanceSourceTone,
  hrDateLabel,
  hrDisplayName,
  hrEmployeeStatusLabel,
  hrEmployeeStatusTone,
  hrEmploymentTypeLabel,
  hrInstantTimeLabel,
  hrIntervalStatusLabel,
  hrLeaveInstantLabel,
  hrLeavePeriodLabel,
  hrLeaveRequestStatusLabel,
  hrLeaveRequestStatusTone,
  cancelHrLeaveRequest,
  createHrLeaveRequest,
  createHrLeaveType,
  fetchHrLeaveRequests,
  fetchHrLeaveTypes,
  setHrLeaveTypeStatus,
  hrRecordStatusLabel,
  hrWeekdayLabel,
  openHrEmploymentInterval,
  rehireHrEmployee,
  setHrEmployeeStatus,
  setHrUnitStatus,
  terminateHrEmployee,
  updateHrEmployee,
} from '../hr-api';
import * as hrApi from '../hr-api';
import { coreGet, corePatch, corePost } from '../core-http';

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * Phase 51-HR-2: the HR client's contract.
 *
 * The rules asserted here are the ones a screen could otherwise break silently: a blank
 * filter must not be sent, a Persian filter must be encoded, page size must be capped at
 * the constant the API declares, and NO request may carry a tenant — the backend derives
 * it from the authenticated principal and refuses unknown fields outright.
 */
describe('HR query builders', () => {
  it('omits blank filters instead of sending them empty', () => {
    expect(buildEmployeeQuery({})).toBe('');
    expect(buildEmployeeQuery({ search: '   ', status: undefined })).toBe('');
    expect(buildPositionQuery({ search: '' })).toBe('');
    expect(buildUnitQuery({ search: '\t' })).toBe('');
  });

  it('trims a filter and encodes it, so a Persian term is a legal request', () => {
    expect(buildEmployeeQuery({ search: '  E-1042 ' })).toBe('?search=E-1042');
    expect(buildPositionQuery({ search: 'کارشناس ارشد' })).toBe(
      `?search=${encodeURIComponent('کارشناس ارشد')}`,
    );
  });

  it('caps pageSize at the API maximum', () => {
    expect(buildEmployeeQuery({ pageSize: 100000 })).toBe(`?pageSize=${HR_MAX_PAGE_SIZE}`);
    expect(buildPositionQuery({ pageSize: 5 })).toBe('?pageSize=5');
  });

  it('emits only the declared filters, in a stable order', () => {
    expect(
      buildEmployeeQuery({
        status: 'ACTIVE',
        organizationUnitId: 'unit-1',
        positionId: 'pos-1',
        page: 2,
        pageSize: 5,
      }),
    ).toBe('?status=ACTIVE&organizationUnitId=unit-1&positionId=pos-1&page=2&pageSize=5');

    expect(buildUnitQuery({ parentId: 'unit-1' })).toBe('?parentId=unit-1');
    // `parentId` is a unit filter and must never leak into the employee query.
    expect(buildEmployeeQuery({ parentId: 'unit-1' } as never)).toBe('');
  });

  it('never emits a tenant identifier, even if one is smuggled into a filter object', () => {
    expect(buildEmployeeQuery({ tenantId: 'other-tenant' } as never)).not.toContain('tenant');
  });
});

describe('HR read endpoints', () => {
  it('reads the tree, the summary, the positions and a page of employees', async () => {
    getMock.mockResolvedValue({} as never);

    await fetchHrOrganizationTree();
    expect(getMock).toHaveBeenLastCalledWith('/hr/organization');

    await fetchHrOrganizationSummary();
    expect(getMock).toHaveBeenLastCalledWith('/hr/organization/summary');

    await fetchHrPositions({ organizationUnitId: 'unit-1' });
    expect(getMock).toHaveBeenLastCalledWith('/hr/positions?organizationUnitId=unit-1');

    await fetchHrEmployees({ status: 'TERMINATED', page: 1 });
    expect(getMock).toHaveBeenLastCalledWith('/hr/employees?status=TERMINATED&page=1');

    await fetchHrEmployee('emp-1');
    expect(getMock).toHaveBeenLastCalledWith('/hr/employees/emp-1');

    // History is its own route: the list deliberately never carries it.
    await fetchHrEmploymentHistory('emp-1');
    expect(getMock).toHaveBeenLastCalledWith('/hr/employees/emp-1/employment-records');
  });
});

describe('HR write endpoints', () => {
  it('sends each mutation to the documented route, with no actor and no tenant', async () => {
    postMock.mockResolvedValue({} as never);
    patchMock.mockResolvedValue({} as never);

    const unitPayload = { code: 'FIN', name: 'امور مالی', parentId: 'unit-0' };
    await createHrUnit(unitPayload);
    expect(postMock).toHaveBeenLastCalledWith('/hr/organization/units', unitPayload);

    // Retiring a unit is a STATUS change — there is no delete function to call.
    await setHrUnitStatus('unit-1', 'INACTIVE');
    expect(patchMock).toHaveBeenLastCalledWith('/hr/organization/units/unit-1/status', {
      status: 'INACTIVE',
    });

    const positionPayload = {
      code: 'POS-1',
      title: 'کارشناس',
      organizationUnitId: 'unit-1',
    };
    await createHrPosition(positionPayload);
    expect(postMock).toHaveBeenLastCalledWith('/hr/positions', positionPayload);

    const createPayload = {
      employeeCode: 'E-1',
      employmentType: 'FULL_TIME' as const,
      startDate: '2026-01-01',
      organizationUnitId: 'unit-1',
      positionId: 'pos-1',
    };
    await createHrEmployee(createPayload);
    expect(postMock).toHaveBeenLastCalledWith('/hr/employees', createPayload);

    await updateHrEmployee('emp-1', { status: 'ACTIVE' });
    expect(patchMock).toHaveBeenLastCalledWith('/hr/employees/emp-1', { status: 'ACTIVE' });

    // A transfer APPENDS an interval; it never PATCHes the employee.
    const transfer = {
      employmentType: 'CONTRACT' as const,
      startDate: '2026-06-01',
      organizationUnitId: 'unit-2',
      positionId: 'pos-2',
    };
    await openHrEmploymentInterval('emp-1', transfer);
    expect(postMock).toHaveBeenLastCalledWith('/hr/employees/emp-1/employment-records', transfer);

    const termination = { endDate: '2026-09-30', reason: 'پایان قرارداد' };
    await terminateHrEmployee('emp-1', termination);
    expect(postMock).toHaveBeenLastCalledWith('/hr/employees/emp-1/terminate', termination);

    const rehire = {
      employmentType: 'PART_TIME' as const,
      startDate: '2026-11-01',
      organizationUnitId: 'unit-1',
      positionId: 'pos-1',
    };
    await rehireHrEmployee('emp-1', rehire);
    expect(postMock).toHaveBeenLastCalledWith('/hr/employees/emp-1/rehire', rehire);
  });

  it('exposes no way to type TERMINATED as an ordinary status edit', async () => {
    patchMock.mockResolvedValue({} as never);

    await setHrEmployeeStatus('emp-1', 'INACTIVE');
    expect(patchMock).toHaveBeenLastCalledWith('/hr/employees/emp-1/status', {
      status: 'INACTIVE',
    });
  });
});

describe('HR presentation helpers', () => {
  it('renders every status as a Persian word, never a raw enum', () => {
    expect(hrEmployeeStatusLabel('ACTIVE')).toBe('فعال');
    expect(hrEmployeeStatusLabel('INACTIVE')).toBe('غیرفعال');
    expect(hrEmployeeStatusLabel('TERMINATED')).toBe('خاتمه‌یافته');
    expect(hrRecordStatusLabel('INACTIVE')).toBe('غیرفعال');
    expect(hrIntervalStatusLabel('ENDED')).toBe('پایان‌یافته');
    expect(hrEmploymentTypeLabel('FULL_TIME')).toBe('تمام‌وقت');
    expect(hrEmploymentTypeLabel('INTERNSHIP')).toBe('کارآموزی');
  });

  it('keeps the tone an assistant to the label, never a replacement for it', () => {
    expect(hrEmployeeStatusTone('ACTIVE')).toBe('ok');
    expect(hrEmployeeStatusTone('INACTIVE')).toBe('muted');
    expect(hrEmployeeStatusTone('TERMINATED')).toBe('danger');
  });

  it('never invents a name: an unlinked identity falls back to the employee code', () => {
    expect(hrDisplayName(null, 'E-1')).toBe('E-1');
    expect(hrDisplayName({ id: 'u1', firstName: null, lastName: null } as never, 'E-1')).toBe('E-1');
    expect(hrDisplayName({ id: 'u1', firstName: 'بهار', lastName: 'نوری' } as never, 'E-1')).toBe(
      'بهار نوری',
    );
  });

  it('formats a date-only value without shifting the day, and shows a dash for null', () => {
    expect(hrDateLabel(null)).toBe('—');
    // 2026-03-01 is 1404/12/10; formatting it as UTC must not move it a day.
    expect(hrDateLabel('2026-03-01')).toBe('۱۴۰۴/۱۲/۱۰');
    expect(hrDateLabel('not-a-date')).toBe('not-a-date');
  });
});

/**
 * Phase 51-HR-2E: the attendance register's client contract.
 *
 * The rules pinned here are the ones the SCREEN relies on and cannot check for itself: the
 * register is read from `/hr/attendance`, the two date shapes travel as the API spells them
 * (`dateKey` Jalali, `from`/`to` Gregorian), no request carries a tenant, and NO punch
 * function exists on this client at all — the ABSENCE of a write is a contract, so it is
 * asserted rather than assumed.
 */
describe('HR attendance contract', () => {
  it('builds the register query from the declared filters, in a stable order', () => {
    expect(buildAttendanceQuery({})).toBe('');
    expect(buildAttendanceQuery({ search: '  E-1042 ' })).toBe('?search=E-1042');
    expect(buildAttendanceQuery({ employeeId: 'emp-1', source: 'DEVICE' })).toBe(
      '?employeeId=emp-1&source=DEVICE'
    );
    expect(buildAttendanceQuery({ from: '2026-09-01', to: '2026-09-30', page: 2 })).toBe(
      '?from=2026-09-01&to=2026-09-30&page=2'
    );
  });

  it('passes the Jalali day through untouched and encoded', () => {
    // `dateKey` is ONE Jalali day, `YYYY/MM/DD` Latin digits — the server converts it. The
    // client never rewrites it into a Gregorian date, because that conversion is the
    // server's single implementation of the calendar (§8).
    expect(buildAttendanceQuery({ dateKey: '1405/06/27' })).toBe(
      `?dateKey=${encodeURIComponent('1405/06/27')}`
    );
  });

  it('omits a blank filter and caps pageSize at the API maximum', () => {
    expect(buildAttendanceQuery({ search: '   ', dateKey: '' })).toBe('');
    expect(buildAttendanceQuery({ pageSize: 100000 })).toBe(`?pageSize=${HR_MAX_PAGE_SIZE}`);
  });

  it('never emits a tenant identifier, even if one is smuggled into a filter object', () => {
    expect(buildAttendanceQuery({ tenantId: 'other-tenant' } as never)).not.toContain('tenant');
  });

  it('reads the register from /hr/attendance', async () => {
    getMock.mockResolvedValue({} as never);

    await fetchHrAttendance({ dateKey: '1405/06/27', pageSize: 20 });
    expect(getMock).toHaveBeenLastCalledWith(
      `/hr/attendance?dateKey=${encodeURIComponent('1405/06/27')}&pageSize=20`
    );

    await fetchHrAttendance();
    expect(getMock).toHaveBeenLastCalledWith('/hr/attendance');
  });

  it('exposes no punch write and no self-service read', () => {
    // The routes exist; this client deliberately has no function for them, because no Aria
    // screen offers a punch yet and `/hr/attendance/me` does not exist server-side (the
    // controller states its absence as design). A helper for either would be a request that
    // 403s or 404s, so the absence is pinned.
    const exported = Object.keys(hrApi);
    expect(exported.filter((name) => /clockIn|clockOut|adjust/i.test(name))).toEqual([]);
    expect(exported.filter((name) => /Attendance/i.test(name))).toEqual([
      // The read, its query builder, the source vocabulary and the three presenters — and
      // nothing else.
      'HR_ATTENDANCE_SOURCES',
      'buildAttendanceQuery',
      'fetchHrAttendance',
      'hrAttendanceDayLabel',
      'hrAttendanceSourceLabel',
      'hrAttendanceSourceTone',
    ]);
  });

  it('words the row source as a Persian label with colour as a second channel', () => {
    expect(HR_ATTENDANCE_SOURCES).toEqual(['DEVICE', 'MANUAL']);
    expect(hrAttendanceSourceLabel('DEVICE')).toBe('پانچ دستگاه');
    expect(hrAttendanceSourceLabel('MANUAL')).toBe('اصلاح دستی');
    expect(hrAttendanceSourceTone('DEVICE')).toBe('ok');
    expect(hrAttendanceSourceTone('MANUAL')).toBe('muted');
  });

  it('renders the server Jalali day in Persian digits without converting it', () => {
    expect(hrAttendanceDayLabel('1405/06/27')).toBe('۱۴۰۵/۰۶/۲۷');
  });

  it('reads a weekday off a date-only day, in UTC', () => {
    // 2026-09-18 is a Friday. A local-zone reading could name the neighbouring day for a
    // reader behind UTC, so the day is named as the server stored it.
    expect(hrWeekdayLabel('2026-09-18')).toBe('جمعه');
    expect(hrWeekdayLabel('2026-09-19')).toBe('شنبه');
    expect(hrWeekdayLabel('not-a-date')).toBe('not-a-date');
  });

  it('formats a punch instant in the API time zone, leaving the value itself alone', () => {
    // The same moment spelled two ways — with an offset and in UTC — is the same reading.
    expect(hrInstantTimeLabel('2026-09-18T08:00:00+03:30')).toBe('۰۸:۰۰');
    expect(hrInstantTimeLabel('2026-09-18T04:30:00.000Z')).toBe('۰۸:۰۰');
    expect(hrInstantTimeLabel('2026-09-18T17:00:00+03:30')).toBe('۱۷:۰۰');
    // A missing punch is a dash, never midnight: the day is OPEN, not empty.
    expect(hrInstantTimeLabel(null)).toBe('—');
    expect(hrInstantTimeLabel('not-an-instant')).toBe('not-an-instant');
  });
});

/**
 * Phase 51-HR-3A: the leave register's client contract.
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE IS A CONTRACT RATHER THAN A DETAIL:
 *
 *   * the register is read from `/hr/leave-requests` with EXACTLY the five filters the API
 *     declares, and NO search term — that route accepts a `search` and the service
 *     deliberately ignores it, so a builder that sent one would change nothing while making a
 *     screen look like it narrowed a tenant-wide register;
 *   * the two days travel as the `YYYY-MM-DD` DAYS they are, never parsed into instants:
 *     `new Date('2026-09-20')` is midnight UTC, which renders as the PREVIOUS day for a reader
 *     in Tehran, and the whole point of the wire format is that no such shift exists;
 *   * a WRITE sends only what the API accepts. The initial `status` is a server-side domain
 *     constant, a withdrawal's reason is an INPUT rather than a column, and a catalogue code is
 *     an identity node no PATCH may rename;
 *   * there is NO approval, NO balance, NO duration and NO delete on this client. Those
 *     absences are asserted, because an export that "approves leave" is a promise the backend
 *     has no rule to keep.
 */
describe('HR leave contract', () => {
  it('builds the register query from the five declared filters, in a stable order', () => {
    expect(buildLeaveRequestQuery({})).toBe('');
    expect(
      buildLeaveRequestQuery({
        employeeId: 'emp-1',
        leaveTypeId: 'lt-1',
        status: 'PENDING',
        from: '2026-09-20',
        to: '2026-09-22',
        page: 2,
        pageSize: 5,
      })
    ).toBe(
      '?employeeId=emp-1&leaveTypeId=lt-1&status=PENDING&from=2026-09-20&to=2026-09-22&page=2&pageSize=5'
    );
    // A blank filter is omitted, never sent empty: `?status=` would be the DTO's own enum
    // refusal rather than "no filter".
    expect(buildLeaveRequestQuery({ leaveTypeId: '', from: '', to: '' })).toBe('');
  });

  it('never sends a search term to a register that has no search', () => {
    // The query DTO declares `search` and `LeaveService.list` ignores it: the register's own
    // filter is employee, type, state and window. A door here would let a screen claim a
    // narrowing that the server never performs.
    expect(buildLeaveRequestQuery({ search: 'E-1042' } as never)).toBe('');
  });

  it('builds the catalogue query and caps pageSize at the API maximum', () => {
    expect(buildLeaveTypeQuery({})).toBe('');
    expect(buildLeaveTypeQuery({ status: 'ACTIVE' })).toBe('?status=ACTIVE');
    expect(buildLeaveTypeQuery({ pageSize: 100000 })).toBe(`?pageSize=${HR_MAX_PAGE_SIZE}`);
  });

  it('never emits a tenant identifier, on either read', () => {
    expect(buildLeaveRequestQuery({ tenantId: 'other-tenant' } as never)).not.toContain('tenant');
    expect(buildLeaveTypeQuery({ tenantId: 'other-tenant' } as never)).not.toContain('tenant');
  });

  it('reads the register and the catalogue from their own routes', async () => {
    getMock.mockResolvedValue({} as never);

    await fetchHrLeaveRequests({ status: 'PENDING', pageSize: 20 });
    expect(getMock).toHaveBeenLastCalledWith('/hr/leave-requests?status=PENDING&pageSize=20');

    await fetchHrLeaveRequests();
    expect(getMock).toHaveBeenLastCalledWith('/hr/leave-requests');

    // The catalogue is a SEPARATE surface with its own lifecycle filter — never one page of the
    // register, and never seeded: an empty catalogue is a tenant that has not stated its own
    // leave policy yet, not an error.
    await fetchHrLeaveTypes({ status: 'ACTIVE' });
    expect(getMock).toHaveBeenLastCalledWith('/hr/leave-types?status=ACTIVE');
  });

  it('exposes no approval WRITE, no balance and no delete on the leave client', () => {
    // Every one of these is absent because it names an ACT, not a state: the decision
    // surface is `hr-leave-approval-api.ts` (approve/reject of a live flow), no day count
    // exists (which days of a range are WORKING days is a question for the shift calendar,
    // §13), and no delete exists on either register surface — a request is withdrawn and a
    // type is retired. A helper for any of them would let a screen promise something this
    // client cannot perform.
    const exported = Object.keys(hrApi);
    expect(exported.filter((name) => /approve|reject|balance|duration|entitlement/i.test(name))).toEqual(
      []
    );
    expect(exported.filter((name) => /deleteHrLeave|removeHrLeave/i.test(name))).toEqual([]);

    // What IS exported as a VALUE, named exhaustively — so a later addition has to be a
    // deliberate edit to this list rather than a quiet export that no phase declared. The
    // interfaces above are absent here because TypeScript erases them: this is the runtime
    // surface, which is what a screen can actually call.
    expect(
      exported
        .filter((name) =>
          /^HR_LEAVE|^HR_MAX_LEAVE|^buildLeave|^fetchHrLeave|^createHrLeave|^cancelHrLeave|^setHrLeave|^hrLeave/.test(
            name
          )
        )
        .sort()
    ).toEqual([
      'HR_LEAVE_REQUEST_STATUSES',
      'HR_MAX_LEAVE_REASON_LENGTH',
      'HR_MAX_LEAVE_TYPE_CODE_LENGTH',
      'HR_MAX_LEAVE_TYPE_NAME_LENGTH',
      'buildLeaveRequestQuery',
      'buildLeaveTypeQuery',
      'cancelHrLeaveRequest',
      'createHrLeaveRequest',
      'createHrLeaveType',
      'fetchHrLeaveRequests',
      'fetchHrLeaveTypes',
      'hrLeaveInstantLabel',
      'hrLeavePeriodLabel',
      'hrLeaveRequestStatusLabel',
      'hrLeaveRequestStatusTone',
      'setHrLeaveTypeStatus',
    ]);
  });

  it('words each state as a Persian label, with colour as the second channel only', () => {
    expect(HR_LEAVE_REQUEST_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
    // NOT «در انتظار تأیید»: pending APPROVAL is a state, so the label states the fact the
    // API states — recorded, and nothing further has happened to it.
    expect(hrLeaveRequestStatusLabel('PENDING')).toBe('ثبت‌شده');
    // The approval flow's own outcome words, since Phase 54-E widened the lifecycle.
    expect(hrLeaveRequestStatusLabel('APPROVED')).toBe('تأییدشده');
    expect(hrLeaveRequestStatusLabel('REJECTED')).toBe('ردشده');
    // The API's own word for the act: `POST :id/cancel` stamps `cancelledAt`.
    expect(hrLeaveRequestStatusLabel('CANCELLED')).toBe('لغوشده');
    // The WORD carries the meaning; tone is only the second channel. A withdrawal is a
    // legitimate terminal state, `REJECTED` is the one state that asks for a re-submission,
    // and `danger` stays for that.
    expect(hrLeaveRequestStatusTone('PENDING')).toBe('ok');
    expect(hrLeaveRequestStatusTone('APPROVED')).toBe('ok');
    expect(hrLeaveRequestStatusTone('REJECTED')).toBe('danger');
    expect(hrLeaveRequestStatusTone('CANCELLED')).toBe('muted');
  });

  it('labels a period in the reader\'s calendar and ONE day as a single label', () => {
    // 2026-09-20 → 1405/06/29 and 2026-09-22 → 1405/06/31, both rendered as the calendar days
    // they are (in UTC) so no reader is shown a neighbouring day.
    expect(hrLeavePeriodLabel('2026-09-20', '2026-09-22')).toBe('۱۴۰۵/۰۶/۲۹ – ۱۴۰۵/۰۶/۳۱');
    // A single-day request legitimately repeats its day: the range is INCLUSIVE at both ends,
    // and printing it twice would be the only visible sign of that contract.
    expect(hrLeavePeriodLabel('2026-09-20', '2026-09-20')).toBe('۱۴۰۵/۰۶/۲۹');
  });

  it('formats a withdrawal instant in the API zone, and a dash when nothing was withdrawn', () => {
    // The same moment spelled two ways is the same reading; the value itself is never rewritten.
    expect(hrLeaveInstantLabel('2026-09-18T08:00:00+03:30')).toBe('۱۴۰۵/۰۶/۲۷ ۰۸:۰۰');
    expect(hrLeaveInstantLabel('2026-09-18T04:30:00.000Z')).toBe('۱۴۰۵/۰۶/۲۷ ۰۸:۰۰');
    // `null` is a STATE — the request still stands — rather than a missing value.
    expect(hrLeaveInstantLabel(null)).toBe('—');
    expect(hrLeaveInstantLabel('not-an-instant')).toBe('not-an-instant');
  });

  it('submits a request with the four fields the API declares, and no state of its own', async () => {
    postMock.mockResolvedValue({} as never);

    const input = {
      employeeId: 'emp-1',
      leaveTypeId: 'lt-1',
      startDate: '2026-09-20',
      endDate: '2026-09-22',
      reason: 'سفر خانوادگی',
    };

    await createHrLeaveRequest(input);

    // The body is the payload EXACTLY: no `status`, no `cancelledAt`, no `tenantId`. The
    // initial state is `LEAVE_REQUEST_INITIAL_STATUS` on the server, so the only request this
    // call can produce is a PENDING one — and the global ValidationPipe rejects unknown fields
    // outright, so a smuggled field would be a 400 rather than a silent write.
    expect(postMock).toHaveBeenLastCalledWith('/hr/leave-requests', input);
    expect(Object.keys(input)).toEqual([
      'employeeId',
      'leaveTypeId',
      'startDate',
      'endDate',
      'reason',
    ]);
  });

  it('withdraws a pending request, carrying the reason the API requires', async () => {
    postMock.mockResolvedValue({} as never);

    // `POST`, not `DELETE`: nothing is removed and the stated reason is not a column — it
    // travels WITH the act into the platform audit trail. That is why the reason is an input
    // object here rather than a second positional argument.
    await cancelHrLeaveRequest('lr-1', { reason: 'تغییر برنامه سفر' });
    expect(postMock).toHaveBeenLastCalledWith('/hr/leave-requests/lr-1/cancel', {
      reason: 'تغییر برنامه سفر',
    });
  });

  it('adds a catalogue entry, then retires it by STATUS rather than deleting it', async () => {
    postMock.mockResolvedValue({} as never);
    patchMock.mockResolvedValue({} as never);

    await createHrLeaveType({ code: 'ANNUAL', name: 'مرخصی استحقاقی' });
    expect(postMock).toHaveBeenLastCalledWith('/hr/leave-types', {
      code: 'ANNUAL',
      name: 'مرخصی استحقاقی',
    });

    await setHrLeaveTypeStatus('lt-1', 'INACTIVE');

    // The body is the STATE alone. `code` is an identity node exactly as it is on
    // `OrganizationUnit`, and a type that has ever been requested cannot be removed from under
    // its own history (`ON DELETE RESTRICT`) — so retirement is a status and there is no delete
    // to call.
    expect(patchMock).toHaveBeenLastCalledWith('/hr/leave-types/lt-1', { status: 'INACTIVE' });
  });
});
