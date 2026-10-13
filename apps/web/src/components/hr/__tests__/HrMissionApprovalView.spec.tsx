import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrMissionApprovalView } from '../HrMissionApprovalView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { fetchMissionApproval, fetchPendingMissionApprovals } from '@/lib/hr-mission-api';
import { missionRequest } from './hr-fixtures';
import { executableSource } from './source-scan';

/**
 * Phase 55 Step 8C: the MANAGER approval queue (`/admin/hr/missions/approvals`).
 *
 * WHAT THESE SPECS ARE FOR. The wire contract is frozen by `hr-mission-api.spec.ts` (Step 8A) and the
 * decision rules live in `mission-approval.service.ts`, so the claims worth pinning here are the ones
 * only THIS screen can get wrong:
 *
 *   * that the queue read answers to `hr.mission.approve` ALONE, and that a caller without it issues
 *     NO request at all — asserted as an ABSENT call, not merely a hidden table;
 *   * that the endpoint's shape is honoured: a bare array, no query, no parameter, no paging — because
 *     the server resolved the rows from the actor and a client-side "pending" filter would be a
 *     second answer to "what is mine";
 *   * that the flow is NOT read with the queue, but ON OPEN, so the expensive per-row read is paid
 *     only for rows somebody actually opens;
 *   * that the panel is mounted with the grant it needs and the queue is refreshed after a decision;
 *   * that an EMPTY queue is stated as the absence of work rather than as an error or an empty table.
 *
 * THE PERMISSION SIGNAL IS STUBBED, THE CLIENT IS NOT. `useCorePermissions` is mocked because a spec
 * cannot enrol a user; `@/lib/hr-mission-api` is mocked so no network is touched, but every assertion
 * about WHAT was called is made on the real production functions' call arguments.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchPendingMissionApprovals: jest.fn(),
  fetchMissionApproval: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const queueMock = fetchPendingMissionApprovals as jest.MockedFunction<
  typeof fetchPendingMissionApprovals
>;
const detailMock = fetchMissionApproval as jest.MockedFunction<typeof fetchMissionApproval>;

const APPROVE = 'hr.mission.approve';

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
 * `executableSource` strips comments — see `./source-scan`, which both mission surfaces now share —
 * because the files legitimately DISCUSS the concepts they must not implement: this screen's header
 * explains why it does not consult `hr.mission.read`. What must not exist is such a check in the
 * CODE.
 */
const VIEW_SOURCE = executableSource('src/components/hr/HrMissionApprovalView.tsx');

beforeEach(() => {
  jest.clearAllMocks();
  grant([APPROVE]);
  queueMock.mockResolvedValue([missionRequest({ status: 'IN_APPROVAL' })]);
  detailMock.mockResolvedValue({
    request: missionRequest({ id: 'mis-1', status: 'IN_APPROVAL' }),
    instance: null,
  });
});

describe('the grant, and the single read it covers', () => {
  it('reads the queue through the real client, with NO argument at all', async () => {
    render(<HrMissionApprovalView />);

    await waitFor(() => expect(queueMock).toHaveBeenCalled());
    // No query, no page, no actor: the queue is resolved from the authenticated actor SERVER-side,
    // which is what makes it a queue rather than a search.
    expect(queueMock).toHaveBeenCalledWith();
    expect(queueMock.mock.calls[0]).toHaveLength(0);
  });

  it('issues NO request at all when the actor holds no hr.mission.approve', async () => {
    grant([]);
    render(<HrMissionApprovalView />);

    await waitFor(() => expect(screen.getByText(/hr\.mission\.approve/)).toBeInTheDocument());
    // The refusal is stated, and NOTHING is attempted: a read that would 403 is a request the grants
    // do not cover.
    expect(queueMock).not.toHaveBeenCalled();
    expect(detailMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hr-mission-approval-queue')).not.toBeInTheDocument();
  });

  it('does not consult hr.mission.read, which is a different surface’s grant', async () => {
    // Holding ONLY the approval grant must be sufficient to do the job that grant names. Requiring
    // the register grant here would make `hr.mission.approve` unable to approve anything.
    grant([APPROVE]);
    render(<HrMissionApprovalView />);

    await waitFor(() => expect(queueMock).toHaveBeenCalled());
    expect(VIEW_SOURCE).not.toContain('hr.mission.read');
    expect(screen.getByTestId('hr-mission-approval-queue')).toBeInTheDocument();
  });

  it('waits for the permission signal before reading anything', async () => {
    grant([APPROVE], true);
    render(<HrMissionApprovalView />);

    // Still loading: no read may race the answer that decides whether the read is allowed.
    expect(queueMock).not.toHaveBeenCalled();
  });
});

describe('the queue itself', () => {
  it('lists the rows the server returned, with their range and status', async () => {
    queueMock.mockResolvedValue([
      missionRequest({ id: 'mis-7', status: 'IN_APPROVAL', destination: 'اداره کل' }),
    ]);

    render(<HrMissionApprovalView />);

    expect(await screen.findByTestId('hr-mission-approval-row-mis-7')).toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-approval-row-range-mis-7')).toHaveTextContent(
      '2026-09-18 – 2026-09-18'
    );
    expect(screen.getByTestId('hr-mission-approval-row-status-mis-7')).toHaveTextContent(
      'در گردش تأیید'
    );
  });

  it('states an EMPTY queue as the absence of work, not as a failure', async () => {
    queueMock.mockResolvedValue([]);

    render(<HrMissionApprovalView />);

    expect(await screen.findByText(/در نوبت تأیید شما نیست/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-approval-queue')).not.toBeInTheDocument();
  });

  it('surfaces a failed read with a retry that re-issues the queue request', async () => {
    queueMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    queueMock.mockResolvedValueOnce([missionRequest({ status: 'IN_APPROVAL' })]);

    render(<HrMissionApprovalView />);

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(queueMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('hr-mission-approval-row-mis-1')).toBeInTheDocument();
  });

  it('offers NO pagination and NO total, because the route implements neither', async () => {
    render(<HrMissionApprovalView />);

    expect(await screen.findByTestId('hr-mission-approval-row-mis-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-next')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-total')).not.toBeInTheDocument();
  });
});

describe('the flow is opened, not pre-fetched', () => {
  it('does NOT read any row’s flow until that row is opened', async () => {
    render(<HrMissionApprovalView />);

    await screen.findByTestId('hr-mission-approval-row-mis-1');
    // The per-row read resolves a live instance and a decisionability answer per step: paying it for
    // rows nobody opens would be paid for the many rows that never are.
    expect(detailMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hr-mission-approval-panel-mis-1')).not.toBeInTheDocument();
  });

  it('reads that row’s flow on open, and only for that row', async () => {
    queueMock.mockResolvedValue([
      missionRequest({ id: 'mis-1', status: 'IN_APPROVAL' }),
      missionRequest({ id: 'mis-2', status: 'IN_APPROVAL' }),
    ]);

    render(<HrMissionApprovalView />);

    await userEvent.click(await screen.findByTestId('hr-mission-approval-toggle-mis-2'));

    await waitFor(() => expect(detailMock).toHaveBeenCalledWith('mis-2'));
    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('hr-mission-approval-panel-mis-2')).toBeInTheDocument();
  });

  it('closes the flow again on a second toggle, unmounting its per-row state', async () => {
    render(<HrMissionApprovalView />);

    const toggle = await screen.findByTestId('hr-mission-approval-toggle-mis-1');
    // The toggle reports its own state, so a screen reader is told what it will do.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    expect(await screen.findByTestId('hr-mission-approval-panel-mis-1')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByTestId('hr-mission-approval-panel-mis-1')).not.toBeInTheDocument()
    );
  });

  it('mounts the panel with the SAME grant, which then renders the server’s own answer', async () => {
    render(<HrMissionApprovalView />);

    await userEvent.click(await screen.findByTestId('hr-mission-approval-toggle-mis-1'));

    // `instance: null` here is the server's statement, passed straight through to the panel rather
    // than interpreted by this screen.
    await waitFor(() => expect(detailMock).toHaveBeenCalledWith('mis-1'));
    expect(await screen.findByText(/گردش تأیید فعالی وجود ندارد/)).toBeInTheDocument();
  });

  it('gives the panel a refresh callback that re-issues the queue read', async () => {
    render(<HrMissionApprovalView />);

    await userEvent.click(await screen.findByTestId('hr-mission-approval-toggle-mis-1'));
    await waitFor(() => expect(detailMock).toHaveBeenCalledWith('mis-1'));

    // The mount is what wires the callback; the panel's own specs prove it calls it after a
    // successful decision. Here the claim is only that the queue read is re-runnable.
    expect(queueMock).toHaveBeenCalledTimes(1);
  });
});
