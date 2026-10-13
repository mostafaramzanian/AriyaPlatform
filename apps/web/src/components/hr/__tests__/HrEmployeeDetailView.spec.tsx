import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrEmployeeDetailView } from '../HrEmployeeDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchHrEmployee,
  fetchHrPositions,
  fetchHrUnits,
  setHrEmployeeStatus,
  terminateHrEmployee,
  updateHrEmployee,
} from '@/lib/hr-api';
import { employee, employeeDetail, interval, page, position, unit } from './hr-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrEmployee: jest.fn(),
  fetchHrUnits: jest.fn(),
  fetchHrPositions: jest.fn(),
  updateHrEmployee: jest.fn(),
  setHrEmployeeStatus: jest.fn(),
  terminateHrEmployee: jest.fn(),
  openHrEmploymentInterval: jest.fn(),
  rehireHrEmployee: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const employeeMock = fetchHrEmployee as jest.MockedFunction<typeof fetchHrEmployee>;
const unitsMock = fetchHrUnits as jest.MockedFunction<typeof fetchHrUnits>;
const positionsMock = fetchHrPositions as jest.MockedFunction<typeof fetchHrPositions>;
const updateMock = updateHrEmployee as jest.MockedFunction<typeof updateHrEmployee>;
const statusMock = setHrEmployeeStatus as jest.MockedFunction<typeof setHrEmployeeStatus>;
const terminateMock = terminateHrEmployee as jest.MockedFunction<typeof terminateHrEmployee>;

const READ = 'hr.employees.read';
const MANAGE = 'hr.employees.manage';
const ORG_READ = 'hr.organization.read';
const POS_READ = 'hr.positions.read';

const FORBIDDEN = 'شما به پروندههای پرسنلی دسترسی ندارید.';

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

function renderDetail(id = 'emp-1') {
  return render(<HrEmployeeDetailView employeeId={id} />);
}

describe('HrEmployeeDetailView', () => {
  beforeEach(() => {
    grant([READ, MANAGE, ORG_READ, POS_READ]);
    employeeMock.mockResolvedValue(employeeDetail());
    unitsMock.mockResolvedValue(page([unit()]));
    positionsMock.mockResolvedValue(page([position()]));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('refuses the file without hr.employees.read and reads nothing', async () => {
    grant([]);

    renderDetail();

    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    expect(employeeMock).not.toHaveBeenCalled();
  });

  it('waits for the permission answer before it decides what to show', () => {
    grant([], true);

    renderDetail();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(employeeMock).not.toHaveBeenCalled();
  });

  it('reads the file by the id it was routed with', async () => {
    renderDetail('emp-42');

    await waitFor(() => expect(employeeMock).toHaveBeenCalledWith('emp-42'));
  });

  it('renders a retryable error and re-reads on retry', async () => {
    employeeMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));

    renderDetail();

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    expect(employeeMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(employeeMock).toHaveBeenCalledTimes(2));
  });

  it('renders the real employment history, separating the open interval from the ended one', async () => {
    employeeMock.mockResolvedValue(
      employeeDetail({
        employmentHistory: [
          interval({ id: 'rec-open', status: 'ACTIVE', endDate: null }),
          interval({ id: 'rec-ended', status: 'ENDED', endDate: '2025-12-31' }),
        ],
      }),
    );

    renderDetail();

    // Both rows come from the endpoint's own history, never from the current Employee columns.
    // Awaiting the table also asserts it rendered before its rows are read.
    expect(await screen.findByTestId('hr-history-table')).toBeInTheDocument();
    expect(screen.getByTestId('hr-history-rec-open')).toBeInTheDocument();
    expect(screen.getByTestId('hr-history-rec-ended')).toBeInTheDocument();

    // The two rows are separated by the SAME channels the screen uses, and each is asserted
    // inside its own row:
    //
    //  * the open interval has no end date, so its end-date cell reads "در جریان" — and its
    //    interval status badge reads the same words, because an open interval *is* active.
    //    Two occurrences in that row is the correct shape, not duplication;
    //  * the ended interval carries a real end date instead, so the word appears nowhere in it.
    const openRow = within(screen.getByTestId('hr-history-rec-open'));
    const endedRow = within(screen.getByTestId('hr-history-rec-ended'));

    expect(openRow.getAllByText('در جریان')).toHaveLength(2);
    expect(endedRow.queryByText('در جریان')).not.toBeInTheDocument();
    expect(endedRow.getByText('پایان‌یافته')).toBeInTheDocument();
  });

  it('shows the manager as the employee id the API stored, never a guessed name', async () => {
    const base = employeeDetail();

    employeeMock.mockResolvedValue(
      employeeDetail({
        currentAssignment: { ...base.currentAssignment!, managerEmployeeId: 'mgr-9' },
      }),
    );

    renderDetail();

    const assignment = within(await screen.findByTestId('hr-detail-assignment'));
    expect(assignment.getByText('mgr-9')).toBeInTheDocument();
  });

  it('states plainly when an employee has no open employment interval', async () => {
    employeeMock.mockResolvedValue(employeeDetail({ currentAssignment: null }));

    renderDetail();

    const assignment = within(await screen.findByTestId('hr-detail-assignment'));
    expect(
      assignment.getByText('برای این کارمند بازه استخدامی در جریان وجود ندارد.'),
    ).toBeInTheDocument();
  });

  it('hides every mutation control from a reader without the manage permission', async () => {
    grant([READ, ORG_READ, POS_READ]);

    renderDetail();

    await screen.findByTestId('hr-detail-history');
    expect(screen.queryByTestId('hr-detail-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-detail-interval-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-detail-settings-open')).not.toBeInTheDocument();
  });

  it('offers the lifecycle actions to a manager, and no rehire before a termination', async () => {
    renderDetail();

    await screen.findByTestId('hr-detail-actions');
    expect(screen.getByTestId('hr-detail-interval-open')).toBeInTheDocument();
    expect(screen.getByTestId('hr-detail-deactivate')).toBeInTheDocument();
    expect(screen.getByTestId('hr-detail-terminate-open')).toBeInTheDocument();
    // A terminated employee is rehired, not reactivated — so neither control is offered yet.
    expect(screen.queryByTestId('hr-detail-rehire-open')).not.toBeInTheDocument();
  });

  it('offers rehire, and no termination, once the employee is terminated', async () => {
    employeeMock.mockResolvedValue(
      employeeDetail({
        status: 'TERMINATED',
        currentAssignment: null,
        employmentHistory: [interval({ status: 'ENDED', endDate: '2026-02-01' })],
      }),
    );

    renderDetail();

    await screen.findByTestId('hr-detail-actions');
    expect(screen.getByTestId('hr-detail-rehire-open')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-detail-terminate-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-detail-interval-open')).not.toBeInTheDocument();
  });
it('sends ONLY the field that changed when the employee panel is saved', async () => {
    updateMock.mockResolvedValue(employeeDetail({ employeeCode: 'E-2' }));

    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-settings-open'));

    const code = screen.getByTestId('hr-settings-code') as HTMLInputElement;
    // The panel is seeded from the loaded record, so it starts at the server's value.
    expect(code.value).toBe('E-1042');

    await userEvent.clear(code);
    await userEvent.type(code, 'E-2');
    await userEvent.click(screen.getByTestId('hr-settings-submit'));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('emp-1', { employeeCode: 'E-2' }));
    // `userId` was never touched, so it must be ABSENT rather than null: sending null would
    // unlink a login the operator never looked at.
    expect(updateMock.mock.calls[0][1]).not.toHaveProperty('userId');
  });

  it('refuses to save a panel with nothing changed', async () => {
    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-settings-open'));

    await userEvent.click(screen.getByTestId('hr-settings-submit'));

    expect(await screen.findByText('تغییری برای ذخیره وجود ندارد.')).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed employee code before spending a request', async () => {
    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-settings-open'));

    const code = screen.getByTestId('hr-settings-code');
    await userEvent.clear(code);
    await userEvent.type(code, '!!bad!!');
    await userEvent.click(screen.getByTestId('hr-settings-submit'));

    expect(
      await screen.findByText(
        'کد کارمندی باید با حرف یا رقم شروع شود و فقط شامل A-Z، 0-9 و . _ / - باشد.',
      ),
    ).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('surfaces a rejected mutation as an alert instead of corrupting the screen', async () => {
    statusMock.mockRejectedValueOnce(new CoreApiError('تعارض با وضعیت فعلی داده', 409));

    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-deactivate'));

    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent(
      'تعارض با وضعیت فعلی داده',
    );
    expect(statusMock).toHaveBeenCalledWith('emp-1', 'INACTIVE');
  });

  it('refuses a termination date that is not YYYY-MM-DD before calling the API', async () => {
    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-terminate-open'));

    await userEvent.type(screen.getByTestId('hr-terminate-end-date'), '1405/01/01');
    await userEvent.click(screen.getByTestId('hr-terminate-submit'));

    expect(await screen.findByText('تاریخ پایان باید به شکل YYYY-MM-DD باشد.')).toBeInTheDocument();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  it('terminates on a valid date and reports success', async () => {
    // `POST /hr/employees/:id/terminate` answers with the TERMINATED employee AND the interval
    // it closed, exactly as `terminateHrEmployee` declares — a bare employee would not be the
    // shape this route can return.
    terminateMock.mockResolvedValue({
      employee: employee({ status: 'TERMINATED' }),
      closedRecord: interval({ status: 'ENDED', endDate: '2026-05-01' }),
    });

    renderDetail();
    await userEvent.click(await screen.findByTestId('hr-detail-terminate-open'));

    await userEvent.type(screen.getByTestId('hr-terminate-end-date'), '2026-05-01');
    await userEvent.click(screen.getByTestId('hr-terminate-submit'));

    await waitFor(() =>
      expect(terminateMock).toHaveBeenCalledWith('emp-1', { endDate: '2026-05-01' }),
    );
    expect(await screen.findByTestId('hr-notice-ok')).toBeInTheDocument();
  });
});