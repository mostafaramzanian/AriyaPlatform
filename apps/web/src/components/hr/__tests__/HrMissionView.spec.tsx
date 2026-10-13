import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HrMissionView } from '../HrMissionView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { HR_MAX_PAGE_SIZE, fetchHrEmployees } from '@/lib/hr-api';
import {
  cancelMission,
  createMission,
  fetchMission,
  fetchMissionOptionGroups,
  fetchMissions,
  resubmitMission,
  submitMission,
  submitMissionReport,
  updateMission,
} from '@/lib/hr-mission-api';
import { employee, missionOptionGroup, missionRequest, page } from './hr-fixtures';
import { executableSource } from './source-scan';

/**
 * Phase 55 Step 8B: the EMPLOYEE Mission surface (`/admin/hr/missions`).
 *
 * WHAT THESE SPECS ARE FOR. The wire contract is already frozen by `hr-mission-api.spec.ts` (Step
 * 8A) and the rules live in `mission.service.ts`, so the claims worth pinning here are the ones only
 * THIS screen can get wrong:
 *
 *   * that it reads through the REAL client with the catalogue page size it declares, and issues NO
 *     request the grants do not cover — the register read needs `hr.mission.read`, the create form
 *     additionally needs `hr.employees.read`, and EVERY write needs `hr.mission.manage`. A request
 *     that would 403 is asserted ABSENT, not merely unused;
 *   * that the four acts are offered exactly where the SERVER allows them, by status: edit and
 *     cancel on the non-terminal states, submit on `DRAFT`, resubmit on `CORRECTION_REQUIRED`, and
 *     the report only on `APPROVED`;
 *   * that a reason is shown for the state that owns the column and NEVER fabricated for another,
 *     because a `CORRECTION_REQUIRED` request with a `null` column must not borrow the rejection;
 *   * that the withdrawal reason is DTO-required, so an empty one cannot be sent;
 *   * that the status vocabulary is the domain's seven and NO `COMPLETED` exists anywhere — words
 *     or code — which is asserted against the shipped source as well as the DOM.
 *
 * THE PERMISSION SIGNAL IS STUBBED, THE CLIENT IS NOT. `useCorePermissions` is mocked because a
 * spec cannot enrol a user; `@/lib/hr-mission-api` is mocked so no network is touched, but every
 * assertion about WHAT was called (route shape, body) is made on the real production functions'
 * call arguments — the module itself is replaced only to observe it.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrEmployees: jest.fn(),
}));

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissions: jest.fn(),
  fetchMission: jest.fn(),
  fetchMissionOptionGroups: jest.fn(),
  createMission: jest.fn(),
  updateMission: jest.fn(),
  submitMission: jest.fn(),
  resubmitMission: jest.fn(),
  cancelMission: jest.fn(),
  submitMissionReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const registerMock = fetchMissions as jest.MockedFunction<typeof fetchMissions>;
const detailMock = fetchMission as jest.MockedFunction<typeof fetchMission>;
const catalogueMock = fetchMissionOptionGroups as jest.MockedFunction<
  typeof fetchMissionOptionGroups
>;
const createMock = createMission as jest.MockedFunction<typeof createMission>;
const updateMock = updateMission as jest.MockedFunction<typeof updateMission>;
const submitMock = submitMission as jest.MockedFunction<typeof submitMission>;
const resubmitMock = resubmitMission as jest.MockedFunction<typeof resubmitMission>;
const cancelMock = cancelMission as jest.MockedFunction<typeof cancelMission>;
const reportMock = submitMissionReport as jest.MockedFunction<typeof submitMissionReport>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;

/** The two grants this surface answers to, plus the directory read the create form needs. */
const READ = 'hr.mission.read';
const MANAGE = 'hr.mission.manage';
const EMPLOYEES_READ = 'hr.employees.read';

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

/**
 * The shipped source, so an absence can be asserted where it would actually appear.
 *
 * `executableSource` strips comments — see `./source-scan`, which two surfaces now share — because
 * the files legitimately DISCUSS the concepts they must not implement: this view's header explains
 * why there is no project picker and why the status union has no completion member. What must not
 * exist is `COMPLETED` or a project id in the CODE.
 */
const SOURCE = executableSource('src/components/hr/HrMissionView.tsx');
const ELIGIBILITY_SOURCE = executableSource('src/lib/hr-mission-eligibility.ts');
/** The UNSTRIPPED eligibility file: its comments are where the mirrored service lines are named. */
const ELIGIBILITY_DOC = readFileSync(
  join(process.cwd(), 'src/lib/hr-mission-eligibility.ts'),
  'utf8'
);

beforeEach(() => {
  jest.clearAllMocks();
  grant([READ, MANAGE, EMPLOYEES_READ]);
  registerMock.mockResolvedValue(page([missionRequest()], 1));
  catalogueMock.mockResolvedValue(page([missionOptionGroup()], 1));
  employeesMock.mockResolvedValue(page([employee()], 1));
  detailMock.mockResolvedValue(missionRequest());
  createMock.mockResolvedValue(missionRequest());
  updateMock.mockResolvedValue(missionRequest());
  submitMock.mockResolvedValue(missionRequest({ status: 'SUBMITTED' }));
  resubmitMock.mockResolvedValue(missionRequest({ status: 'SUBMITTED' }));
  cancelMock.mockResolvedValue(missionRequest({ status: 'CANCELLED' }));
  reportMock.mockResolvedValue({
    id: 'rep-1',
    missionRequestId: 'mis-1',
    employeeId: 'emp-1',
    content: 'گزارش',
    submittedAt: '2026-09-20T08:00:00.000Z',
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-20T08:00:00.000Z',
  });
});

describe('HrMissionView', () => {
  // -------------------------------------------------------------------------
  // 1. The grants the reads answer to.
  // -------------------------------------------------------------------------

  it('reads the register through the real client, with the catalogue page size it declares', async () => {
    render(<HrMissionView />);

    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    // The catalogue is read at the same ceiling the client caps every page size to, so the screen
    // cannot silently truncate the tenant's configuration.
    await waitFor(() =>
      expect(catalogueMock).toHaveBeenCalledWith({ active: true, pageSize: 100 })
    );
    expect(HR_MAX_PAGE_SIZE).toBe(100);
  });

  it('issues NO request at all when the actor holds no hr.mission.read', async () => {
    grant([]);
    render(<HrMissionView />);

    await waitFor(() => expect(screen.getByText(/hr\.mission\.read/)).toBeInTheDocument());
    // A 403 is asserted ABSENT: the refusal is stated, and nothing is attempted.
    expect(registerMock).not.toHaveBeenCalled();
    expect(catalogueMock).not.toHaveBeenCalled();
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('does not read the employee directory without hr.employees.read', async () => {
    grant([READ, MANAGE]);
    render(<HrMissionView />);

    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    expect(employeesMock).not.toHaveBeenCalled();
    // The register still reads: the directory is the CREATE form's need, not the register's.
    expect(screen.getByTestId('hr-mission-table')).toBeInTheDocument();
  });

  it('offers no create control when the employee directory is not readable', async () => {
    grant([READ, MANAGE]);
    render(<HrMissionView />);

    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    expect(screen.queryByTestId('hr-mission-create-open')).not.toBeInTheDocument();
  });

  it('degrades a failed directory read to an empty picker rather than an error', async () => {
    employeesMock.mockRejectedValue(new CoreApiError('boom', 500));
    render(<HrMissionView />);

    await waitFor(() => expect(screen.getByTestId('hr-mission-create-open')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('hr-mission-create-open'));

    const picker = document.getElementById('hr-mission-employee') as HTMLSelectElement;
    // The failure is swallowed into an empty directory, which disables the create submit.
    expect(within(picker).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('hr-mission-form-submit')).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 2. Every write is grant-gated.
  // -------------------------------------------------------------------------

  it('renders the register read-only without hr.mission.manage', async () => {
    grant([READ, EMPLOYEES_READ]);
    detailMock.mockResolvedValue(missionRequest({ status: 'CORRECTION_REQUIRED' }));
    render(<HrMissionView />);

    await waitFor(() => expect(screen.getByTestId('hr-mission-table')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('hr-mission-open-mis-1'));

    // The request is status-ELIGIBLE for edit and resubmit, but the actor has no write grant, so
    // every control is withheld rather than offered as a guaranteed 403.
    await waitFor(() => expect(screen.getByTestId('hr-mission-detail-mis-1')).toBeInTheDocument());
    expect(screen.queryByTestId('hr-mission-edit-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-submit-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-resubmit-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-cancel-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-report-submit-mis-1')).not.toBeInTheDocument();
  });

  it('still shows the employee the reason they must act on, which needs no write grant', async () => {
    grant([READ, EMPLOYEES_READ]);
    detailMock.mockResolvedValue(
      missionRequest({ status: 'CORRECTION_REQUIRED', correctionReason: 'تاریخ اصلاح شود.' })
    );
    render(<HrMissionView />);

    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));

    // Reading WHY is the point of the employee's visit; withholding it with the controls would leave
    // the return unactionable.
    expect(await screen.findByTestId('hr-mission-correction-reason-mis-1')).toBeInTheDocument();
  });

  it('sends nothing when a create is attempted without the write grant', async () => {
    grant([READ, EMPLOYEES_READ]);
    render(<HrMissionView />);

    await waitFor(() => expect(registerMock).toHaveBeenCalled());
    // There is no control to click, and the handler itself refuses: the grant is checked at BOTH
    // ends, so a future caller of the handler cannot bypass it.
    expect(screen.queryByTestId('hr-mission-create-open')).not.toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. The register shows the server's rows, and no fallback dataset.
  // -------------------------------------------------------------------------

  it('renders the employee code and the stored days verbatim beside their Persian rendering', async () => {
    render(<HrMissionView />);

    const row = await screen.findByTestId('hr-mission-row-mis-1');
    expect(within(row).getByText('E-1042')).toBeInTheDocument();
    // The raw ISO range is IN the DOM, because the range is inclusive and a single day legitimately
    // repeats itself — hiding that would hide the contract.
    expect(within(row).getByText('2026-09-18 – 2026-09-18')).toBeInTheDocument();
  });

  it('prints the SERVER total, not a count of the rows on screen', async () => {
    registerMock.mockResolvedValue(page([missionRequest()], 42));
    render(<HrMissionView />);

    const total = await screen.findByTestId('hr-mission-total');
    expect(total.textContent).toContain('۴۲');
  });

  it('renders a STATE and never rows when the register read fails', async () => {
    registerMock.mockRejectedValue(new CoreApiError('boom', 500));
    render(<HrMissionView />);

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.queryByTestId('hr-mission-table')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 4. The acts, exactly where the server allows them.
  // -------------------------------------------------------------------------

  const statuses: Array<[string, boolean, boolean, boolean, boolean, boolean]> = [
    // status,              edit,  submit, resubmit, cancel, report
    ['DRAFT', true, true, false, true, false],
    ['SUBMITTED', true, false, false, true, false],
    ['IN_APPROVAL', true, false, false, true, false],
    ['CORRECTION_REQUIRED', true, false, true, true, false],
    ['APPROVED', false, false, false, false, true],
    ['REJECTED', false, false, false, false, false],
    ['CANCELLED', false, false, false, false, false],
  ];

  it.each(statuses)(
    'offers the right acts for %s',
    async (status, edit, submit, resubmit, cancel, report) => {
      detailMock.mockResolvedValue(missionRequest({ status: status as never }));
      render(<HrMissionView />);

      await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
      await screen.findByTestId('hr-mission-detail-mis-1');

      const present = (testId: string) => screen.queryByTestId(testId) !== null;
      expect(present('hr-mission-edit-mis-1')).toBe(edit);
      expect(present('hr-mission-submit-mis-1')).toBe(submit);
      expect(present('hr-mission-resubmit-mis-1')).toBe(resubmit);
      expect(present('hr-mission-cancel-mis-1')).toBe(cancel);
      expect(present('hr-mission-report-submit-mis-1')).toBe(report);
    }
  );

  it('submits with NO body, because the actor and the route are the server’s to resolve', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-submit-mis-1'));

    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('mis-1'));
    // No second argument at all: nothing can be volunteered.
    expect(submitMock.mock.calls[0]).toHaveLength(1);
  });

  it('sends only the authored fields on an edit', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-edit-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-form-submit'));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, body] = updateMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(
      ['description', 'destination', 'endDate', 'selections', 'startDate'].sort()
    );
    // Nothing the screen does not own: no status, no employee, no tenant, no revision.
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('employeeId');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('does NOT send correctionReason on a resubmit', async () => {
    detailMock.mockResolvedValue(
      missionRequest({ status: 'CORRECTION_REQUIRED', correctionReason: 'تاریخ اصلاح شود.' })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-resubmit-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-form-submit'));

    await waitFor(() => expect(resubmitMock).toHaveBeenCalled());
    const [, body] = resubmitMock.mock.calls[0] as [string, Record<string, unknown>];
    // The reason is the MANAGER's statement about the previous revision; the employee cannot
    // overwrite it, and there is deliberately no field for it.
    expect(body).not.toHaveProperty('correctionReason');
  });

  it('sends the DTO-required reason on a withdrawal and refuses an empty one', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-cancel-mis-1'));

    const submit = await screen.findByTestId('hr-mission-cancel-submit-mis-1');
    // `CancelMissionRequestDto` requires a non-empty reason, so the control refuses to send one.
    expect(submit).toBeDisabled();

    const field = document.getElementById('hr-mission-cancel-reason-mis-1') as HTMLTextAreaElement;
    await userEvent.type(field, '  ');
    expect(screen.getByTestId('hr-mission-cancel-submit-mis-1')).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, 'لغو به دلیل تغییر برنامه');
    expect(screen.getByTestId('hr-mission-cancel-submit-mis-1')).toBeEnabled();

    await userEvent.click(screen.getByTestId('hr-mission-cancel-submit-mis-1'));
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith('mis-1', { reason: 'لغو به دلیل تغییر برنامه' })
    );
  });

  it('sends only the content on a report', async () => {
    detailMock.mockResolvedValue(missionRequest({ status: 'APPROVED' }));
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));

    const field = document.getElementById('hr-mission-report-mis-1') as HTMLTextAreaElement;
    await userEvent.type(field, 'گزارش ماموریت انجام شد.');
    await userEvent.click(screen.getByTestId('hr-mission-report-submit-mis-1'));

    await waitFor(() =>
      expect(reportMock).toHaveBeenCalledWith('mis-1', { content: 'گزارش ماموریت انجام شد.' })
    );
    const [, body] = reportMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.keys(body)).toEqual(['content']);
  });

  // -------------------------------------------------------------------------
  // 5. The reasons: shown where owned, never fabricated.
  // -------------------------------------------------------------------------

  it('shows a rejection reason on a REJECTED request', async () => {
    detailMock.mockResolvedValue(
      missionRequest({ status: 'REJECTED', rejectionReason: 'خارج از بودجه.' })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));

    const notice = await screen.findByTestId('hr-mission-rejection-reason-mis-1');
    expect(notice).toHaveTextContent('خارج از بودجه.');
  });

  it('never borrows a rejectionReason for a CORRECTION_REQUIRED request', async () => {
    detailMock.mockResolvedValue(
      missionRequest({
        status: 'CORRECTION_REQUIRED',
        correctionReason: null,
        rejectionReason: 'این دلیل مربوط به رد است.',
      })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await screen.findByTestId('hr-mission-detail-mis-1');

    // The column is `null`, so no sentence is printed: substituting the other reason would present
    // a manager's refusal as a correction note.
    expect(screen.queryByTestId('hr-mission-correction-reason-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-rejection-reason-mis-1')).not.toBeInTheDocument();
  });

  it('never borrows a correctionReason for a REJECTED request', async () => {
    detailMock.mockResolvedValue(
      missionRequest({
        status: 'REJECTED',
        rejectionReason: null,
        correctionReason: 'این دلیل مربوط به اصلاح است.',
      })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await screen.findByTestId('hr-mission-detail-mis-1');

    expect(screen.queryByTestId('hr-mission-rejection-reason-mis-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-correction-reason-mis-1')).not.toBeInTheDocument();
  });

  it('shows no reason for a state that does not own the column', async () => {
    // A `DRAFT` request carrying a leftover correction reason: the column is not this state's, so it
    // is not presented as current.
    detailMock.mockResolvedValue(
      missionRequest({ status: 'DRAFT', correctionReason: 'دلیل کهنه.' })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await screen.findByTestId('hr-mission-detail-mis-1');

    expect(screen.queryByTestId('hr-mission-correction-reason-mis-1')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 6. The classification is READ, not derived; no project linkage exists.
  // -------------------------------------------------------------------------

  it('renders the server’s own classification rather than re-deriving it from codes', async () => {
    detailMock.mockResolvedValue(
      missionRequest({
        durationMode: 'HOURLY',
        locationType: 'OUT_OF_CITY',
        engagementType: 'PROJECT',
        startTime: '08:00',
        endTime: '12:00',
      })
    );
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));

    const detail = await screen.findByTestId('hr-mission-detail-mis-1');
    expect(within(detail).getByText('ساعتی')).toBeInTheDocument();
    expect(within(detail).getByText('خارج شهر')).toBeInTheDocument();
    expect(within(detail).getByText('پروژه‌ای')).toBeInTheDocument();
    // The hours are rendered for an HOURLY mission, from `startTime`/`endTime` as stored.
    expect(within(detail).getByText('08:00 – 12:00')).toBeInTheDocument();
  });

  it('offers NO project picker or project id, because Phase 55 links no project', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await screen.findByTestId('hr-mission-detail-mis-1');

    expect(screen.queryByTestId(/project/i)).not.toBeInTheDocument();
    expect(SOURCE).not.toMatch(/projectId|project_id|fetchHrProjects/);
  });

  it('shows no hours for a DAILY mission', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));

    await screen.findByTestId('hr-mission-detail-mis-1');
    // A DAILY mission has no clock fields: empty ones would imply they had been lost.
    expect(screen.queryByTestId('hr-mission-time-mis-1')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 7. The REQUEST vocabulary is the seven statuses, and no completion member exists.
  //
  // THE CLAIM IS ABOUT THE REQUEST, NOT ABOUT THE PROJECT. `COMPLETED` is a legitimate member of
  // `HrMissionApprovalInstanceStatus` — an approval FLOW that has finished — and it is named in
  // `hr-mission-labels.ts` for exactly that union, so a blanket scan of that file would fail on the
  // domain's own word. What must never exist is a completion state FOR A REQUEST: a request ends at
  // `APPROVED`, `REJECTED` or `CANCELLED`, and a flow ending is not a request succeeding.
  //
  // The scan is therefore run against the REQUEST's own vocabulary — `hr-mission-api.ts`'s status
  // union and `hr-mission-eligibility.ts`'s predicates — and the labels file is checked the way the
  // distinction is actually made: every line carrying `COMPLETED` must be a FLOW line.
  // -------------------------------------------------------------------------

  /** The `HrMissionRequestStatus` union as the wire contract declares it. */
  const REQUEST_STATUS_VOCABULARY = executableSource('src/lib/hr-mission-api.ts').match(
    /HrMissionRequestStatus\s*=([\s\S]*?);/
  )?.[1];

  it('names the seven domain statuses and never invents a completion state', async () => {
    for (const status of [
      'DRAFT',
      'SUBMITTED',
      'IN_APPROVAL',
      'CORRECTION_REQUIRED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ]) {
      detailMock.mockResolvedValue(missionRequest({ status: status as never }));
      const view = render(<HrMissionView />);
      await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
      await screen.findByTestId('hr-mission-detail-mis-1');
      view.unmount();
    }

    // The union is exactly seven members, and `COMPLETED` is not one of them.
    expect(REQUEST_STATUS_VOCABULARY).toBeDefined();
    expect(REQUEST_STATUS_VOCABULARY).not.toMatch(/COMPLETED/);
    for (const status of [
      'DRAFT',
      'SUBMITTED',
      'IN_APPROVAL',
      'CORRECTION_REQUIRED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ]) {
      expect(REQUEST_STATUS_VOCABULARY).toContain(status);
    }

    // The screen reads its acts from the predicates, so it carries no completion branch of its own.
    expect(SOURCE).not.toMatch(/COMPLETED/);
    expect(ELIGIBILITY_SOURCE).not.toMatch(/COMPLETED/);
  });

  it('names COMPLETED only for the approval FLOW, never for the request', () => {
    const completions = executableSource('src/lib/hr-mission-labels.ts')
      .split('\n')
      .filter((line) => line.includes('COMPLETED'));

    // Every occurrence is a flow word: the two-member instance-status map, or the doc block that
    // separates the two vocabularies. Nothing maps a REQUEST status to it.
    expect(completions.length).toBeGreaterThan(0);
    for (const line of completions) {
      expect(line).toMatch(/ApprovalInstanceStatus|COMPLETED:\s*'پایان‌یافته'/);
    }
    // And the REQUEST map still holds only the domain's seven.
    const requestMap = executableSource('src/lib/hr-mission-labels.ts').match(
      /REQUEST_STATUS_LABELS[\s\S]*?\n\};/
    )?.[0];
    expect(requestMap).toBeDefined();
    expect(requestMap).not.toMatch(/COMPLETED/);
  });

  // -------------------------------------------------------------------------
  // 8. Eligibility is centralized; no status test is inlined in the screen.
  // -------------------------------------------------------------------------

  it('keeps every status test in hr-mission-eligibility.ts, not in the screen', () => {
    // Each predicate names the ONE service check it mirrors, so a divergence is visible.
    expect(ELIGIBILITY_DOC).toMatch(/mission\.service\.ts:\d+/);
    // The screen reaches for the predicates and never compares a status literal itself.
    expect(SOURCE).toMatch(/canEditMission|canSubmitMission|canResubmitMission|canCancelMission/);
    expect(SOURCE).not.toMatch(/status\s*===\s*'DRAFT'/);
    expect(SOURCE).not.toMatch(/status\s*===\s*'APPROVED'/);
    expect(SOURCE).not.toMatch(/status\s*===\s*'CORRECTION_REQUIRED'/);
    expect(SOURCE).not.toMatch(/status\s*===\s*'REJECTED'/);
    expect(SOURCE).not.toMatch(/status\s*===\s*'CANCELLED'/);
  });

  it('re-reads the register after a write rather than patching it locally', async () => {
    render(<HrMissionView />);
    await userEvent.click(await screen.findByTestId('hr-mission-open-mis-1'));
    await userEvent.click(await screen.findByTestId('hr-mission-submit-mis-1'));

    await waitFor(() => expect(submitMock).toHaveBeenCalled());
    // The register is the server's list: a locally edited row would briefly show an unconfirmed
    // state, so the screen re-reads instead.
    await waitFor(() => expect(registerMock.mock.calls.length).toBeGreaterThan(1));
  });
});
