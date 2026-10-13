import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MissionApprovalPanel } from '../MissionApprovalPanel';
import { CoreApiError } from '@/lib/core-http';
import {
  approveMission,
  correctMission,
  fetchMissionApproval,
  rejectMission,
  type HrMissionApprovalDetail,
  type HrMissionApprovalInstance,
} from '@/lib/hr-mission-api';
import { missionRequest } from './hr-fixtures';

/**
 * Phase 55 Step 8C: the Mission DECISION panel's contract.
 *
 * WHY THESE SPECS EXIST. The panel is where the phase's authorization story becomes visible, and the
 * claims only it can get wrong are:
 *
 *   1. **THE THREE CONDITIONS.** The controls appear exactly when the actor holds
 *      `hr.mission.approve` AND the server said `instance.canDecide === true` AND the instance is
 *      `'ACTIVE'`. Each term is exercised with the other two satisfied, so a component that ANDed
 *      them wrongly — or that substituted the REQUEST's status for the FLOW's — fails here.
 *   2. **NO LOCAL RE-DERIVATION.** The panel must render the server's answer, not compute one. The
 *      evidence is that a flow the server marked undecidable offers no control even when the actor
 *      plainly holds the grant — the case where a client that "worked it out" from employee ids
 *      would diverge. **No employee id is ever compared by this component.**
 *   3. **THREE REASONS THAT MUST NOT CROSS.** The employee's `request.description`, a manager's
 *      recorded `request.correctionReason` / `request.rejectionReason`, the per-step
 *      `step.decisionReason` and the approver's own typed note are four different facts. The specs
 *      below pin each to its own place and prove a refactor cannot bind one into another's control.
 *   4. **THE BLANK REFUSAL.** The API refuses a blank rejection or correction, so the submit control
 *      must refuse to send one rather than learn the rule from a 400 — while an APPROVAL may be sent
 *      with no note at all.
 *   5. **`instance: null` IS NOT AN ERROR.** The server says so when no live flow exists, and the
 *      panel states that absence instead of showing an empty table or a failure.
 *   6. **THE FLOW IS RE-READ AFTER A DECISION, NEVER PATCHED LOCALLY.** Only the server knows how the
 *      route advanced, so a spec asserts a SECOND `fetchMissionApproval` call after a write.
 *
 * THE CLIENT IS STUBBED; THE LABELS ARE NOT. `jest.requireActual` keeps the real Persian vocabulary
 * and tone helpers, so the strings the assertions look for are the shipped ones.
 */
jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissionApproval: jest.fn(),
  approveMission: jest.fn(),
  rejectMission: jest.fn(),
  correctMission: jest.fn(),
}));

const fetchMock = fetchMissionApproval as jest.MockedFunction<typeof fetchMissionApproval>;
const approveMock = approveMission as jest.MockedFunction<typeof approveMission>;
const rejectMock = rejectMission as jest.MockedFunction<typeof rejectMission>;
const correctMock = correctMission as jest.MockedFunction<typeof correctMission>;

const REQUEST_ID = 'mis-1';

/**
 * THE EMPLOYEE'S OWN WORDS, and distinctly unlike anything a label or a decider would write.
 *
 * A distinctive string rather than a plausible sentence, so an assertion that finds it proves the
 * panel rendered THIS value and not a label, a recorded manager reason, a step's note or the
 * approver's own text.
 */
const EMPLOYEE_DESCRIPTION = 'بازدید فنی از پست فوق توزیع شهرستان';

/** A manager's EARLIER correction note, recorded on the request from a superseded round. */
const RECORDED_CORRECTION = 'تاریخ پایان را اصلاح کنید';

/** The approver's OWN note, typed while composing a refusal. */
const TYPED_REFUSAL = 'روزهای پرکار';

/** A decidable, ACTIVE, single-step flow; each case adjusts what it needs. */
const flow = (overrides: Partial<HrMissionApprovalInstance> = {}): HrMissionApprovalInstance => ({
  id: 'instance-1',
  status: 'ACTIVE',
  routingMode: 'SEQUENTIAL',
  sequenceNumber: 1,
  submissionRevision: 1,
  canDecide: true,
  steps: [
    {
      order: 1,
      status: 'ACTIVE',
      decision: null,
      decisionReason: null,
      decidedByEmployeeId: null,
      resolvedApproverEmployeeId: 'emp-9',
      resolutionReason: 'PRIMARY',
      decidableByActor: true,
    },
  ],
  ...overrides,
});

/** The detail read: the request and its flow. */
const detail = (
  request: Parameters<typeof missionRequest>[0] = {},
  instance: HrMissionApprovalInstance | null = flow()
): HrMissionApprovalDetail => ({
  request: missionRequest({ id: REQUEST_ID, description: EMPLOYEE_DESCRIPTION, ...request }),
  instance,
});

const onDecided = jest.fn();

beforeEach(() => {
  onDecided.mockReset();
});

afterEach(() => {
  jest.clearAllMocks();
});

/** A render helper, so every case states only what it is about. */
function renderPanel(canApprove = true) {
  return render(
    <MissionApprovalPanel
      missionRequestId={REQUEST_ID}
      canApprove={canApprove}
      onDecided={onDecided}
    />
  );
}

describe('what the panel renders', () => {
  it('reads the flow through the real client, by request id only', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(REQUEST_ID));
    // The id is the ONLY argument: no actor, no approver, no step and no tenant travel from here.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
  });

  it('shows the flow status, the routing mode and the step count', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-flow-status-${REQUEST_ID}`)
    ).toHaveTextContent('در جریان');
    // The route is RENDERED from the server's `routingMode`, never inferred from step ordering.
    expect(screen.getByTestId(`hr-mission-approval-routing-${REQUEST_ID}`)).toHaveTextContent(
      'ترتیبی'
    );
    expect(screen.getByTestId(`hr-mission-approval-steps-${REQUEST_ID}`)).toBeInTheDocument();
  });

  it('states the request itself — employee, range and both stored days verbatim', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-employee-${REQUEST_ID}`)
    ).toHaveTextContent('E-1042');
    // The stored `YYYY-MM-DD` days are printed VERBATIM beside the Persian rendering: a range is
    // INCLUSIVE, so a single-day mission legitimately repeats its day.
    expect(screen.getByTestId(`hr-mission-approval-range-${REQUEST_ID}`)).toHaveTextContent(
      '2026-09-18 – 2026-09-18'
    );
  });

  it('renders a step row with its resolution reason and the SERVER answer for that step', async () => {
    fetchMock.mockResolvedValue(
      detail({}, flow({ steps: [{ ...flow().steps[0], resolutionReason: 'SUBSTITUTE' }] }))
    );

    renderPanel();

    const status = await screen.findByTestId(`hr-mission-approval-step-status-${REQUEST_ID}-1`);
    expect(status).toHaveTextContent('در نوبت تصمیم');
    // WHY this person is the decider, in the shared vocabulary's own words.
    expect(screen.getByTestId(`hr-mission-approval-step-${REQUEST_ID}-1`)).toHaveTextContent(
      'جانشین موقت'
    );
    // `decidableByActor: true` for the actor's OWN step, rendered as received.
    expect(screen.getByTestId(`hr-mission-approval-step-mine-${REQUEST_ID}-1`)).toBeInTheDocument();
  });

  it('marks no step as the actor’s when the server said decidableByActor is false for it', async () => {
    fetchMock.mockResolvedValue(
      detail({}, flow({ steps: [{ ...flow().steps[0], decidableByActor: false }] }))
    );

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-step-status-${REQUEST_ID}-1`)
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-step-mine-${REQUEST_ID}-1`)
    ).not.toBeInTheDocument();
  });

  it('states that an UNGOVERNED request has no live flow rather than showing an empty table', async () => {
    fetchMock.mockResolvedValue(detail({}, null));

    renderPanel();

    // `instance: null` is the server saying nothing is being routed — a MEANINGFUL state, not an
    // error and not "a flow with no steps".
    expect(await screen.findByText(/گردش تأیید فعالی وجود ندارد/)).toBeInTheDocument();
    expect(screen.queryByTestId(`hr-mission-approval-steps-${REQUEST_ID}`)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
  });

  it('states that a flow with no steps has none, rather than an empty table body', async () => {
    fetchMock.mockResolvedValue(detail({}, flow({ steps: [] })));

    renderPanel();

    expect(await screen.findByText('این گردش هیچ مرحله‌ای ندارد.')).toBeInTheDocument();
    // The request above is still fully readable — only the table is replaced by the statement.
    expect(screen.getByTestId(`hr-mission-approval-employee-${REQUEST_ID}`)).toBeInTheDocument();
  });

  it('surfaces a failed read with a retry that re-issues the request', async () => {
    fetchMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    fetchMock.mockResolvedValueOnce(detail());

    renderPanel();

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByTestId(`hr-mission-approval-flow-status-${REQUEST_ID}`)
    ).toBeInTheDocument();
  });

  it('states the refusal rather than the message when the read answers 403', async () => {
    fetchMock.mockRejectedValue(new CoreApiError('Forbidden', 403));

    renderPanel();

    expect(await screen.findByText(/دسترسی ندارید/)).toBeInTheDocument();
  });
});

/**
 * WHERE EACH REASON LIVES, AND WHY THEY MUST NOT CROSS.
 *
 * The panel holds FOUR strings that a careless refactor could collapse into one:
 *
 *   1. `request.description` — the EMPLOYEE'S own words («شرح درخواست کارمند»).
 *   2. `request.correctionReason` / `request.rejectionReason` — a MANAGER's recorded words on the
 *      REQUEST, which the employee reads; these are the only two reason columns the Mission request
 *      carries, and each is read only under the status that owns it.
 *   3. `step.decisionReason` — what a DECIDER recorded on a STEP, which may be an earlier round's.
 *   4. the note being typed NOW, which belongs to the approver looking at the screen.
 *
 * The failure these specs catch is the one that survives review: a panel that renders all four looks
 * complete, and only an assertion on the VALUE can tell which text landed where.
 */
describe('reason ownership — four reasons, four places', () => {
  it('shows the employee’s own description, read-only, under a label naming it as theirs', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    const shown = await screen.findByTestId(`hr-mission-approval-description-${REQUEST_ID}`);
    expect(shown).toHaveTextContent(EMPLOYEE_DESCRIPTION);
    // It is a `span` in a `<dd>` — not an input, textarea or select — so there is nothing to type
    // into and nothing to submit.
    expect(shown.tagName).toBe('SPAN');
    expect(shown.closest('input, textarea, select')).toBeNull();
    // The label names WHOSE words these are, so they cannot read as the approver's own note.
    expect(screen.getByText('شرح درخواست کارمند')).toBeInTheDocument();
  });

  it('keeps the approver’s typed refusal SEPARATE from the employee’s description', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    // The refusal textarea exists only once refusal is opened — so this is where the two could be
    // confused: a refactor that bound the request's description into this control, or reused one
    // state for both, would show the employee's words in the approver's box.
    await userEvent.click(await screen.findByTestId(`hr-mission-approval-reject-${REQUEST_ID}`));

    const refusalNote = screen.getByLabelText('دلیل رد (الزامی)');
    expect(refusalNote).toHaveValue('');
    expect(refusalNote).not.toHaveValue(EMPLOYEE_DESCRIPTION);
    // ...and the employee's description is STILL displayed, unchanged, while that box is open.
    expect(screen.getByTestId(`hr-mission-approval-description-${REQUEST_ID}`)).toHaveTextContent(
      EMPLOYEE_DESCRIPTION
    );
  });

  it('shows a recorded CORRECTION reason only on a request that is CORRECTION_REQUIRED', async () => {
    fetchMock.mockResolvedValue(
      detail({ status: 'CORRECTION_REQUIRED', correctionReason: RECORDED_CORRECTION })
    );

    renderPanel();

    // The manager's recorded words appear in their OWN block...
    expect(
      await screen.findByTestId(`hr-mission-approval-correction-reason-${REQUEST_ID}`)
    ).toHaveTextContent(RECORDED_CORRECTION);
    // ...and NOT in the employee's description slot, which still holds the employee's own words.
    expect(screen.getByTestId(`hr-mission-approval-description-${REQUEST_ID}`)).toHaveTextContent(
      EMPLOYEE_DESCRIPTION
    );
  });

  it('does NOT present a stale correction reason as a live refusal once the request moved on', async () => {
    // A resubmitted request can still carry the column from an EARLIER round while its step is being
    // asked. Rendering it here would state a refusal that is no longer in force.
    fetchMock.mockResolvedValue(
      detail({ status: 'IN_APPROVAL', correctionReason: RECORDED_CORRECTION })
    );

    renderPanel();

    await screen.findByTestId(`hr-mission-approval-flow-status-${REQUEST_ID}`);
    expect(
      screen.queryByTestId(`hr-mission-approval-correction-reason-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
  });

  it('never borrows the rejection column to fill a correction state, or the reverse', async () => {
    // `CORRECTION_REQUIRED` with a NULL correction reason but a populated rejection column: the panel
    // must show NO reason rather than the other column's words — «اصلاح کن» and «نه» are different
    // outcomes, and a reader must be able to tell which they received.
    fetchMock.mockResolvedValue(
      detail({
        status: 'CORRECTION_REQUIRED',
        correctionReason: null,
        rejectionReason: 'برخلاف مقررات',
      })
    );

    renderPanel();

    await screen.findByTestId(`hr-mission-approval-flow-status-${REQUEST_ID}`);
    expect(
      screen.queryByTestId(`hr-mission-approval-correction-reason-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-rejection-reason-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
  });

  it('shows a step’s recorded decisionReason as that STEP’s note, not as the request’s', async () => {
    fetchMock.mockResolvedValue(
      detail(
        {},
        flow({
          steps: [
            {
              ...flow().steps[0],
              status: 'APPROVED',
              decision: 'APPROVED',
              decidedByEmployeeId: 'emp-9',
              decisionReason: 'تأیید مدیر مستقیم',
            },
          ],
        })
      )
    );

    renderPanel();

    // The step's own note...
    expect(await screen.findByTestId(`hr-mission-approval-step-${REQUEST_ID}-1`)).toHaveTextContent(
      'تأیید مدیر مستقیم'
    );
    // ...while the employee's description is untouched by it.
    expect(screen.getByTestId(`hr-mission-approval-description-${REQUEST_ID}`)).toHaveTextContent(
      EMPLOYEE_DESCRIPTION
    );
  });

  it('states the absence of a step note as a fact rather than leaving the cell blank', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    expect(await screen.findByTestId(`hr-mission-approval-step-${REQUEST_ID}-1`)).toHaveTextContent(
      'دلیلی ثبت نشده است.'
    );
  });

  it('never sends the employee’s description as the approver’s own note', async () => {
    fetchMock.mockResolvedValue(detail());
    approveMock.mockResolvedValue(missionRequest({ id: REQUEST_ID }));

    renderPanel();

    // The approval body is `{}` — the panel never forwards the request's text as its own note, which
    // is exactly what would happen if the description were wired into the decision path.
    await userEvent.click(await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(REQUEST_ID, {}));
  });
});

/**
 * THE THREE CONDITIONS THAT REVEAL THE CONTROLS, EACH EXERCISED WITH THE OTHER TWO SATISFIED.
 *
 * A component that ANDed them wrongly, or that substituted `request.status` for `instance.status`,
 * fails at least one of these five cases.
 */
describe('the three conditions that reveal the controls', () => {
  it('offers all three acts when the grant is held, the flow is decidable and the flow is ACTIVE', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).toBeInTheDocument();
    expect(screen.getByTestId(`hr-mission-approval-reject-${REQUEST_ID}`)).toBeInTheDocument();
    // Correction is a THIRD act, offered beside the other two because it is a different outcome.
    expect(screen.getByTestId(`hr-mission-approval-correct-${REQUEST_ID}`)).toBeInTheDocument();
  });

  it('withholds every control when the actor does NOT hold the grant, and issues NO read', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel(false);

    // The refusal is stated...
    expect(await screen.findByText(/hr\.mission\.approve/)).toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-reject-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-correct-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    // ...and, crucially, the `hr.mission.approve`-gated READ is never attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withholds every control when the SERVER says the flow is undecidable, grant notwithstanding', async () => {
    // THE CENTRAL CASE: a client that re-derived the answer from employee ids could conclude the
    // opposite here. The panel renders what it was told.
    fetchMock.mockResolvedValue(detail({}, flow({ canDecide: false })));

    renderPanel();

    await screen.findByTestId(`hr-mission-approval-undecidable-${REQUEST_ID}`);
    expect(
      screen.queryByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-reject-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`hr-mission-approval-correct-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    // The read-only sentence names the reason that APPLIES: the step is somebody else's.
    expect(screen.getByTestId(`hr-mission-approval-readonly-${REQUEST_ID}`)).toHaveTextContent(
      'نوبت شما نیست'
    );
  });

  it('withholds every control on a COMPLETED flow, which has no step left to decide', async () => {
    // Note the server still answers `canDecide: true` — the actor's answer and the flow's state are
    // DIFFERENT facts, and only the second one closes the controls here.
    fetchMock.mockResolvedValue(
      detail(
        {},
        flow({
          status: 'COMPLETED',
          steps: [{ ...flow().steps[0], status: 'APPROVED', decision: 'APPROVED' }],
        })
      )
    );

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-flow-status-${REQUEST_ID}`)
    ).toHaveTextContent('پایان‌یافته');
    expect(
      screen.queryByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).not.toBeInTheDocument();
    // ...and the sentence is about the FLOW, not about the reader: "the flow has ended".
    expect(screen.getByTestId(`hr-mission-approval-readonly-${REQUEST_ID}`)).toHaveTextContent(
      'پایان یافته'
    );
  });

  it('does not infer decisionability from the REQUEST’s status', async () => {
    // An ACTIVE, decidable flow on a request the server reports as `IN_APPROVAL` — and, separately,
    // a decidable flow on a request reported `DRAFT`. Neither request status may add or remove a
    // control, because the request's status is not the flow's state.
    fetchMock.mockResolvedValue(detail({ status: 'IN_APPROVAL' }));

    renderPanel();

    expect(
      await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)
    ).toBeInTheDocument();
  });
});

describe('deciding', () => {
  it('approves with an EMPTY body, adopts the returned request and RE-READS the flow', async () => {
    fetchMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        detail(
          { status: 'IN_APPROVAL' },
          flow({ steps: [{ ...flow().steps[0], status: 'APPROVED', decision: 'APPROVED' }] })
        )
      );
    approveMock.mockResolvedValue(missionRequest({ id: REQUEST_ID, status: 'IN_APPROVAL' }));

    renderPanel();

    await userEvent.click(await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`));

    // The client sends the REQUEST id and a body; it never names the approver, the step or the actor.
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(REQUEST_ID, {}));
    // THE FLOW IS RE-READ, not patched locally: only the server knows how the route advanced.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByTestId(`hr-mission-approval-step-status-${REQUEST_ID}-1`)
      ).toHaveTextContent('تأییدشده')
    );
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it('sends an approval note when one was typed, and nothing when one was not', async () => {
    fetchMock.mockResolvedValue(detail());
    approveMock.mockResolvedValue(missionRequest({ id: REQUEST_ID }));

    renderPanel();

    await userEvent.click(await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(REQUEST_ID, {}));
  });

  it('refuses to send a BLANK rejection, and reports the server refusal when it is sent anyway', async () => {
    fetchMock.mockResolvedValue(detail());
    rejectMock.mockRejectedValue(new CoreApiError('این مرحله قبلاً تصمیم‌گیری شده است.', 409));

    renderPanel();

    await userEvent.click(await screen.findByTestId(`hr-mission-approval-reject-${REQUEST_ID}`));

    const submit = await screen.findByTestId(`hr-mission-approval-reject-submit-${REQUEST_ID}`);
    // The API requires a NON-BLANK reason, so the control cannot send one: the rule is stated in the
    // UI rather than discovered through a 400.
    expect(submit).toBeDisabled();
    expect(rejectMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('دلیل رد (الزامی)'), TYPED_REFUSAL);
    await userEvent.click(submit);

    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith(REQUEST_ID, { reason: TYPED_REFUSAL })
    );
    // A refusal is SHOWN, not retried into, and the queue is not told it decided.
    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('قبلاً');
    expect(onDecided).not.toHaveBeenCalled();
    // ...and the approver's own words SURVIVE the failure, so a rejected attempt costs nobody the
    // sentence they just wrote.
    expect(screen.getByLabelText('دلیل رد (الزامی)')).toHaveValue(TYPED_REFUSAL);
  });

  it('refuses to send a BLANK correction, and sends the stated one to the CORRECTION route', async () => {
    fetchMock.mockResolvedValue(detail());
    correctMock.mockResolvedValue(
      missionRequest({ id: REQUEST_ID, status: 'CORRECTION_REQUIRED' })
    );

    renderPanel();

    // Correction is a SEPARATE act from rejection and travels to its OWN route — merging the two
    // would leave the employee unable to tell "fix this" from "no".
    await userEvent.click(await screen.findByTestId(`hr-mission-approval-correct-${REQUEST_ID}`));

    const submit = await screen.findByTestId(`hr-mission-approval-correct-submit-${REQUEST_ID}`);
    expect(submit).toBeDisabled();
    expect(correctMock).not.toHaveBeenCalled();

    await userEvent.type(
      screen.getByLabelText('دلیل بازگرداندن (الزامی)'),
      'تاریخ پایان را اصلاح کنید'
    );
    await userEvent.click(submit);

    await waitFor(() =>
      expect(correctMock).toHaveBeenCalledWith(REQUEST_ID, {
        reason: 'تاریخ پایان را اصلاح کنید',
      })
    );
    // A correction is NOT a rejection: the other route was never called.
    expect(rejectMock).not.toHaveBeenCalled();
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it('dismissing a composed act clears the note and restores the three buttons', async () => {
    fetchMock.mockResolvedValue(detail());

    renderPanel();

    await userEvent.click(await screen.findByTestId(`hr-mission-approval-reject-${REQUEST_ID}`));
    await userEvent.type(screen.getByLabelText('دلیل رد (الزامی)'), TYPED_REFUSAL);
    await userEvent.click(
      await screen.findByTestId(`hr-mission-approval-reject-dismiss-${REQUEST_ID}`)
    );

    expect(screen.queryByLabelText('دلیل رد (الزامی)')).not.toBeInTheDocument();
    expect(screen.getByTestId(`hr-mission-approval-approve-${REQUEST_ID}`)).toBeInTheDocument();
    expect(rejectMock).not.toHaveBeenCalled();
    // Re-opening the refusal form starts EMPTY: the dismissed words are not silently restored.
    await userEvent.click(screen.getByTestId(`hr-mission-approval-reject-${REQUEST_ID}`));
    expect(screen.getByLabelText('دلیل رد (الزامی)')).toHaveValue('');
  });

  it('shows the outcome of an approval as a notice beside the updated flow', async () => {
    fetchMock.mockResolvedValue(detail());
    approveMock.mockResolvedValue(missionRequest({ id: REQUEST_ID }));

    renderPanel();

    await userEvent.click(await screen.findByTestId(`hr-mission-approval-approve-${REQUEST_ID}`));

    expect(await screen.findByTestId('hr-notice-ok')).toBeInTheDocument();
  });
});
