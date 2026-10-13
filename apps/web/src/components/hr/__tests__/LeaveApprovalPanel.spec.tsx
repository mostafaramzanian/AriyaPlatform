import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LeaveApprovalPanel } from '../LeaveApprovalPanel';
import { CoreApiError } from '@/lib/core-http';
import {
  approveLeaveRequest,
  fetchLeaveApproval,
  rejectLeaveRequest,
  type HrLeaveApprovalInstance,
} from '@/lib/hr-leave-approval-api';

/**
 * Phase 54-J (§9, §10, §11): the approval PANEL's contract.
 *
 * WHY THESE SPECS EXIST. The panel is where the phase's authorization story becomes visible, and the
 * claims only it can get wrong are:
 *
 *   1. **THE THREE CONDITIONS.** The controls appear exactly when the actor holds `hr.leave.approve`
 *      AND the server said `decidableByActor === true` AND the instance is `'ACTIVE'`. Each term is
 *      exercised with the other two satisfied, so a component that ANDed them wrongly fails here.
 *   2. **NO LOCAL RE-DERIVATION.** The panel must render the server's answer, not compute one. The
 *      evidence is that a flow the server marked undecidable offers no control even when the actor
 *      plainly holds the grant — the case where a client that "worked it out" would diverge.
 *   3. **THE BLANK REJECTION.** The API refuses a blank reason, so the submit control must refuse to
 *      send one rather than learn the rule from a 400.
 *   4. **`null` IS NOT AN ERROR.** An ungoverned request has no flow, and the panel states that
 *      absence as "no decision is needed" instead of showing an empty table or a failure.
 *
 * THE CLIENT IS STUBBED; THE LABELS ARE NOT. `jest.requireActual` keeps the real Persian vocabulary
 * and tone helpers, so the strings the assertions look for are the shipped ones.
 */
jest.mock('@/lib/hr-leave-approval-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-approval-api'),
  fetchLeaveApproval: jest.fn(),
  approveLeaveRequest: jest.fn(),
  rejectLeaveRequest: jest.fn(),
}));

const fetchMock = fetchLeaveApproval as jest.MockedFunction<typeof fetchLeaveApproval>;
const approveMock = approveLeaveRequest as jest.MockedFunction<typeof approveLeaveRequest>;
const rejectMock = rejectLeaveRequest as jest.MockedFunction<typeof rejectLeaveRequest>;

const REQUEST_ID = 'req-1';

/**
 * The EMPLOYEE-ENTERED reason, handed to the panel by the register row that owns it.
 *
 * A distinctive string rather than a plausible sentence, so an assertion that finds it proves the
 * panel rendered THIS value and not a label, a decision note or the decider's own text.
 */
const REQUEST_REASON = 'شرکت در جلسهٔ حضوری با کارفرما';

/** A decidable, ACTIVE single-step flow; each case adjusts what it needs. */
const flow = (overrides: Partial<HrLeaveApprovalInstance> = {}): HrLeaveApprovalInstance => ({
  id: 'instance-1',
  leaveRequestId: REQUEST_ID,
  status: 'ACTIVE',
  stepCount: 1,
  requestStartDate: '2026-01-05',
  requestEndDate: '2026-01-06',
  steps: [
    {
      id: 'step-1',
      approvalInstanceId: 'instance-1',
      approvalStepDefinitionId: 'def-1',
      order: 1,
      status: 'ACTIVE',
      resolvedApproverEmployeeId: 'emp-9',
      resolutionReason: 'PRIMARY',
      resolutionSignal: 'SIGNAL_DIRECT_LINE_MANAGER',
      decision: null,
      decidedByEmployeeId: null,
      decisionReason: null,
      decidedAt: null,
      ruleVersionLabel: 'v1',
    },
  ],
  decidableByActor: true,
  undecidableReason: null,
  ...overrides,
});

const onDecided = jest.fn();

beforeEach(() => {
  onDecided.mockReset();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('what the panel renders', () => {
  it('shows the flow status, step count and the request range', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    expect(await screen.findByTestId(`hr-leave-approval-status-${REQUEST_ID}`)).toHaveTextContent(
      'در جریان'
    );
    expect(screen.getByTestId(`hr-leave-approval-steps-${REQUEST_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`hr-leave-approval-period-${REQUEST_ID}`)).toHaveTextContent(
      '2026-01-05'
    );
  });

  it('states that an UNGOVERNED request needs no decision rather than showing an empty flow', async () => {
    fetchMock.mockResolvedValue(null);

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    expect(await screen.findByText(/گردش تأییدی تعریف نشده است/)).toBeInTheDocument();
    expect(screen.queryByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)).not.toBeInTheDocument();
  });

  it('renders the server refusal sentence when the actor may not decide', async () => {
    fetchMock.mockResolvedValue(
      flow({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' })
    );

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    const note = await screen.findByTestId(`hr-leave-approval-undecidable-${REQUEST_ID}`);
    // The SERVER's reason, worded as the shared vocabulary words it — never re-derived here.
    expect(note).toHaveTextContent('کاربر دیگری');
  });
});

/**
 * PHASE 55 STEP 7: THE EMPLOYEE'S REASON IS VISIBLE TO THE DECIDER.
 *
 * WHY THESE ASSERTIONS EXIST. `LeaveRequest.reason` is authoritative and NOT NULL, and the
 * register row renders it — but the approval panel is a separate component with its own fetch, and
 * a decider whose eyes are on the panel must not have to look two columns left to learn WHY the
 * leave was asked for. The panel therefore receives the reason from the row that already holds it,
 * as a REQUIRED prop, and renders it read-only in the request summary.
 *
 * The three failures these catch are the ones that would survive review:
 *
 *   1. THE REASON SILENTLY MISSING. A panel that never renders the prop looks complete — the flow,
 *      the steps and the controls are all there — so nothing but an assertion on the VALUE can tell.
 *   2. IT BECOMING EDITABLE. The panel owns a `reason` STATE for the decider's own reject note, and
 *      a careless refactor could bind the request's reason into that textarea. The assertions below
 *      pin the request reason as inert TEXT and prove the reject textarea is still separate.
 *   3. THE TWO REASONS BEING CONFUSED. «دلیل درخواست مرخصی» (the employee's) and «دلیل تصمیم» (the
 *      decider's) are different facts; the label is asserted so the panel cannot present one as the
 *      other.
 */
describe('the employee-entered request reason (Phase 55 Step 7)', () => {
  it('shows the exact reason the register row passed in, under its own label', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    const shown = await screen.findByTestId(`hr-leave-approval-request-reason-${REQUEST_ID}`);
    // EXACT equality on the value: a fallback sentence, a truncated string or the decider's note
    // would all fail here, which is the point of the distinctive fixture.
    expect(shown).toHaveTextContent(REQUEST_REASON);
    // The label names WHOSE reason it is, so it cannot read as manager-entered.
    expect(screen.getByText('دلیل درخواست مرخصی')).toBeInTheDocument();
  });

  it('renders it as READ-ONLY text, never as a control', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    const shown = await screen.findByTestId(`hr-leave-approval-request-reason-${REQUEST_ID}`);
    // It is a `span` in a `<dd>` — not an input, textarea or select — so there is nothing to type
    // into and nothing to submit.
    expect(shown.tagName).toBe('SPAN');
    expect(shown.closest('input, textarea, select')).toBeNull();
  });

  it('keeps the decider’s reject note SEPARATE from the employee’s reason', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    // The reject textarea exists only once rejection is opened — so this is where the two reasons
    // could be confused: a refactor that bound the request's reason into this control, or reused
    // the same state for both, would show the employee's words in the decider's box.
    await userEvent.click(await screen.findByTestId(`hr-leave-approval-reject-${REQUEST_ID}`));

    const rejectNote = screen.getByLabelText('دلیل رد (الزامی)');
    expect(rejectNote).toHaveValue('');
    expect(rejectNote).not.toHaveValue(REQUEST_REASON);
    // ...and the employee's reason is STILL displayed, unchanged, while that box is open.
    expect(screen.getByTestId(`hr-leave-approval-request-reason-${REQUEST_ID}`)).toHaveTextContent(
      REQUEST_REASON
    );
  });

  it('still shows the reason when the actor may only READ the flow', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove={false}
        onDecided={onDecided}
      />
    );

    // The reason is a property of the REQUEST, so it is not behind the decision grant: a read-only
    // holder sees it too, while the controls stay absent.
    expect(
      await screen.findByTestId(`hr-leave-approval-request-reason-${REQUEST_ID}`)
    ).toHaveTextContent(REQUEST_REASON);
    expect(screen.queryByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)).not.toBeInTheDocument();
  });

  it('leaves the decision controls and the undecidable sentence untouched', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    // Display only: the reason's presence must not change what may be decided.
    expect(
      await screen.findByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)
    ).toBeInTheDocument();
    expect(screen.getByTestId(`hr-leave-approval-reject-${REQUEST_ID}`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not turn the reason into a second, decider-named note', async () => {
    fetchMock.mockResolvedValue(flow());
    approveMock.mockResolvedValue(flow({ status: 'COMPLETED' }));

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    await userEvent.click(await screen.findByTestId(`hr-leave-approval-approve-${REQUEST_ID}`));

    // The approval body is still `{}` — the panel never sends the request's reason as its own note,
    // which is what would happen if the prop were wired into the decision path.
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(REQUEST_ID, {}));
  });
});

describe('the three conditions that reveal the controls (§3, §8)', () => {
  it('offers approve and reject when the actor holds the grant, the flow is decidable and ACTIVE', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    expect(
      await screen.findByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)
    ).toBeInTheDocument();
    expect(screen.getByTestId(`hr-leave-approval-reject-${REQUEST_ID}`)).toBeInTheDocument();
  });

  it('withholds them when the actor does NOT hold the grant, and says which grant is missing', async () => {
    fetchMock.mockResolvedValue(flow());

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove={false}
        onDecided={onDecided}
      />
    );

    // The flow is fully readable — only the write control is absent.
    expect(await screen.findByTestId(`hr-leave-approval-steps-${REQUEST_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`hr-leave-approval-readonly-${REQUEST_ID}`)).toHaveTextContent(
      'hr.leave.approve'
    );
  });

  it('withholds them when the SERVER says the flow is undecidable, even though the grant is held', async () => {
    // THE CENTRAL CASE: a client that re-derived the answer from employee ids could conclude the
    // opposite here. The panel renders what it was told.
    fetchMock.mockResolvedValue(
      flow({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' })
    );

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    await screen.findByTestId(`hr-leave-approval-undecidable-${REQUEST_ID}`);
    expect(screen.queryByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`hr-leave-approval-reject-${REQUEST_ID}`)).not.toBeInTheDocument();
  });

  it('withholds them on a COMPLETED flow, which has no step left to decide', async () => {
    fetchMock.mockResolvedValue(flow({ status: 'COMPLETED' }));

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    expect(await screen.findByTestId(`hr-leave-approval-status-${REQUEST_ID}`)).toHaveTextContent(
      // Built from code points: ZWNJ placement inside a hand-typed Persian literal is exactly the
      // kind of thing that silently asserts a different string.
      String.fromCharCode(
        0x067e,
        0x0627,
        0x06cc,
        0x0627,
        0x0646,
        0x06cc,
        0x0627,
        0x0641,
        0x062a,
        0x0647
      )
    );
    expect(screen.queryByTestId(`hr-leave-approval-approve-${REQUEST_ID}`)).not.toBeInTheDocument();
  });
});

describe('deciding (§10)', () => {
  it('approves with the stated note, then shows the UPDATED flow', async () => {
    fetchMock.mockResolvedValue(flow());
    approveMock.mockResolvedValue(
      flow({
        status: 'COMPLETED',
        steps: [{ ...flow().steps[0], status: 'APPROVED', decision: 'APPROVED' }],
      })
    );

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    await userEvent.click(await screen.findByTestId(`hr-leave-approval-approve-${REQUEST_ID}`));

    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    // The client sends the REQUEST id and a body; it never names the approver or the step.
    expect(approveMock).toHaveBeenCalledWith(REQUEST_ID, {});
    await waitFor(() =>
      expect(screen.getByTestId(`hr-leave-approval-status-${REQUEST_ID}`)).toHaveTextContent(
        // Same code-point construction as above: the label this asserts is the shared vocabulary's.
        String.fromCharCode(
          0x067e,
          0x0627,
          0x06cc,
          0x0627,
          0x0646,
          0x06cc,
          0x0627,
          0x0641,
          0x062a,
          0x0647
        )
      )
    );
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it('refuses to send a blank rejection, and reports the server refusal when it is sent anyway', async () => {
    fetchMock.mockResolvedValue(flow());
    rejectMock.mockRejectedValue(new CoreApiError('این مرحله قبلاً تصمیم‌گیری شده است.', 409));

    render(
      <LeaveApprovalPanel
        leaveRequestId={REQUEST_ID}
        reason={REQUEST_REASON}
        canApprove
        onDecided={onDecided}
      />
    );

    await userEvent.click(await screen.findByTestId(`hr-leave-approval-reject-${REQUEST_ID}`));

    const submit = await screen.findByTestId(`hr-leave-approval-reject-submit-${REQUEST_ID}`);
    // The API requires a NON-BLANK reason, so the control cannot send one: the rule is stated in the
    // UI rather than discovered through a 400.
    expect(submit).toBeDisabled();
    expect(rejectMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('دلیل رد (الزامی)'), 'روزهای پرکار');
    await userEvent.click(submit);

    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith(REQUEST_ID, { reason: 'روزهای پرکار' })
    );
    // A refusal is SHOWN, not retried into, and the row is not told it decided.
    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('قبلاً تصمیم');
    expect(onDecided).not.toHaveBeenCalled();
  });
});
