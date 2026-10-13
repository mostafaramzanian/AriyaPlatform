import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceCommercialSection } from '../purchase/CommerceCommercialSection';
import type { SectionState } from '../purchase/section-state';
import {
  submitCommerceCommercialDecision,
  type CommerceApprovalsRead,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import { assignment, commercialApproval, commercialGroup, purchaseLine } from './commerce-fixtures';

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  submitCommerceCommercialDecision: jest.fn(),
}));

const decideMock = submitCommerceCommercialDecision as jest.MockedFunction<
  typeof submitCommerceCommercialDecision
>;

const noop = () => undefined;

function ready<T>(data: T): SectionState<T> {
  return { status: 'ready', data, error: null };
}

function approvalsWith(status: 'PENDING' | 'APPROVED', approverUserId = 'u-1'): CommerceApprovalsRead {
  return {
    documentId: 'doc-1',
    approvals: [commercialApproval({ status, approverUserId })],
  };
}

function renderSection(options: {
  approvals?: CommerceApprovalsRead;
  canApprove?: boolean;
  currentUserId?: string | null;
  initialDecisionId?: string | null;
  onDecisionRecorded?: () => void;
}) {
  return render(
    <CommerceCommercialSection
      assignmentsState={ready({ documentId: 'doc-1', assignments: [assignment()], history: [] })}
      approvalsState={ready(options.approvals ?? approvalsWith('PENDING'))}
      groupsState={ready([commercialGroup()])}
      purchaseLines={[purchaseLine()]}
      documentNumber="PR-1405-0001"
      currentUserId={options.currentUserId === undefined ? 'u-1' : options.currentUserId}
      canApprove={options.canApprove ?? true}
      canManage={false}
      initialDecisionId={options.initialDecisionId ?? null}
      onRetry={noop}
      onMutated={noop}
      onDecisionRecorded={options.onDecisionRecorded ?? noop}
    />
  );
}

/**
 * PHASE UI-3 — the Commercial Decision workspace. The list below is the phase's §34:
 * eligibility gating, the real decision values, comment semantics, confirmation,
 * double-submit prevention, and the two refusal classes (validation and stale state) —
 * each asserted semantically, never by snapshot.
 */
describe('CommerceCommercialDecision — eligibility & entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('offers the decision entry for a PENDING approval whose stored approver is this user', () => {
    renderSection({});

    expect(screen.getByTestId('commerce-decision-entry')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-decision-open-approval-1')).toHaveTextContent(
      'بررسی و تصمیم‌گیری'
    );
    expect(screen.getByText('این مورد در انتظار تصمیم شماست.')).toBeInTheDocument();
  });

  it('shows NO decision entry for a non-pending approval', () => {
    renderSection({ approvals: approvalsWith('APPROVED') });

    expect(screen.queryByTestId('commerce-decision-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-decision-open-approval-1')).not.toBeInTheDocument();
  });

  it('shows NO decision entry when the stored approver is somebody else', () => {
    renderSection({ approvals: approvalsWith('PENDING', 'u-2') });

    expect(screen.queryByTestId('commerce-decision-entry')).not.toBeInTheDocument();
  });

  it('shows NO decision entry without commerce.approve', () => {
    renderSection({ canApprove: false });

    expect(screen.queryByTestId('commerce-decision-entry')).not.toBeInTheDocument();
  });

  it('opens the panel from the deep link (?decision=) once the read has landed', () => {
    renderSection({ initialDecisionId: 'approval-1' });

    expect(screen.getByTestId('commerce-decision-panel')).toBeInTheDocument();
    // The trigger stays mounted as the toggle that owns the panel, in its expanded state.
    expect(screen.getByTestId('commerce-decision-open-approval-1')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('restores focus to the trigger when a DEEP-LINKED panel closes with Escape', async () => {
    const user = userEvent.setup();
    renderSection({ initialDecisionId: 'approval-1' });

    const panel = await screen.findByTestId('commerce-decision-panel');
    expect(panel).toHaveFocus();

    await user.keyboard('{Escape}');

    // Browser QA run4 found focus landing on <body> here: the deep link never goes
    // through the click handler that used to arm the restore ref.
    expect(screen.queryByTestId('commerce-decision-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('commerce-decision-open-approval-1')).toHaveFocus();
  });

  it('does NOT open the panel for a deep link that is no longer actionable', () => {
    renderSection({ approvals: approvalsWith('APPROVED'), initialDecisionId: 'approval-1' });

    expect(screen.queryByTestId('commerce-decision-panel')).not.toBeInTheDocument();
  });
});

describe('CommerceCommercialDecision — the panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    decideMock.mockResolvedValue(
      commercialApproval({ status: 'APPROVED', decidedByUserId: 'u-1', decidedAt: '2026-02-09T08:00:00.000Z' })
    );
  });

  async function openPanel() {
    const user = userEvent.setup();
    renderSection({});
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    return { user, panel: await screen.findByTestId('commerce-decision-panel') };
  }

  it('renders exactly the two real decision values as explicitly labelled controls', async () => {
    const { panel } = await openPanel();

    const approved = within(panel).getByLabelText('تأیید بازرگانی');
    const rejected = within(panel).getByLabelText('رد بازرگانی');
    expect(approved).toHaveAttribute('type', 'radio');
    expect(rejected).toHaveAttribute('type', 'radio');
    expect(approved).toHaveAttribute('name', 'commerce-decision');
    expect(rejected).toHaveAttribute('name', 'commerce-decision');
    // No «بله/خیر» anywhere — the labels are the actions themselves.
    expect(within(panel).queryByLabelText('بله')).not.toBeInTheDocument();
  });

  it('keeps submit unavailable until a decision is chosen, then submits the exact body', async () => {
    const onDecisionRecorded = jest.fn();
    const user = userEvent.setup();
    renderSection({ onDecisionRecorded });
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');

    expect(screen.getByTestId('commerce-decision-submit')).toBeDisabled();

    await user.click(screen.getByLabelText('تأیید بازرگانی'));
    await user.type(screen.getByLabelText(/نظر \/ توضیح/), 'با فاکتور هم‌خوان است.');
    await user.click(screen.getByTestId('commerce-decision-submit'));

    // Consequence-first confirmation names the chosen decision.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/تصمیم انتخابی: تأیید بازرگانی/)).toBeInTheDocument();
    expect(within(dialog).getByText(/وضعیت سند درخواست خرید تغییر نمی‌کند/)).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));

    await waitFor(() =>
      expect(decideMock).toHaveBeenCalledWith('approval-1', {
        decision: 'APPROVED',
        comment: 'با فاکتور هم‌خوان است.',
      })
    );
    expect(onDecisionRecorded).toHaveBeenCalled();
    // Success announces WHAT happened, and the authoritative status is shown.
    expect(await screen.findByTestId('commerce-decision-success')).toHaveTextContent(
      /تصمیم «تأیید بازرگانی»/
    );
    expect(screen.getByTestId('commerce-approval-status-APPROVED')).toBeInTheDocument();
  });

  it('omits the comment key entirely when the comment is blank', async () => {
    const user = userEvent.setup();
    renderSection({});
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');

    await user.click(screen.getByLabelText('رد بازرگانی'));
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));

    await waitFor(() => expect(decideMock).toHaveBeenCalledTimes(1));
    const [, payload] = decideMock.mock.calls[0];
    expect(Object.keys(payload)).toEqual(['decision']);
  });

  it('counts the comment against the DTO ceiling without becoming the validation authority', async () => {
    const { user } = await openPanel();

    const textarea = screen.getByLabelText(/نظر \/ توضیح/);
    expect(textarea).toHaveAttribute('maxlength', '1000');

    await user.type(textarea, 'یادداشت');
    expect(screen.getByText(/۷ \/ ۱۰۰۰/)).toBeInTheDocument();
  });

  it('fails safe against a double confirm: one request while the first is in flight', async () => {
    let resolveDecide: (value: ReturnType<typeof commercialApproval>) => void = noop;
    decideMock.mockImplementation(
      () => new Promise((resolve) => (resolveDecide = resolve as never))
    );

    const user = userEvent.setup();
    renderSection({});
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');
    await user.click(screen.getByLabelText('تأیید بازرگانی'));
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));

    expect(screen.getByTestId('commerce-decision-submit')).toBeDisabled();
    expect(screen.getByTestId('commerce-decision-submit')).toHaveTextContent('در حال ثبت…');
    expect(decideMock).toHaveBeenCalledTimes(1);

    resolveDecide(commercialApproval({ status: 'APPROVED' }));
    await waitFor(() => expect(screen.getByTestId('commerce-decision-close')).toBeInTheDocument());
  });
});

describe('CommerceCommercialDecision — refusals, focus and keyboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function openWithDecision() {
    const user = userEvent.setup();
    renderSection({});
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');
    await user.click(screen.getByLabelText('تأیید بازرگانی'));
    await user.type(screen.getByLabelText(/نظر \/ توضیح/), 'یادداشت من');
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));
    return user;
  }

  it('preserves the comment, the selection and the surface when the server refuses (400)', async () => {
    decideMock.mockRejectedValue(
      new CoreApiError('Only the approver resolved at activation may decide this record (§3-G).', 400)
    );

    await openWithDecision();

    expect(await screen.findByTestId('commerce-decision-error')).toHaveTextContent(
      /تصمیم‌گیرندهٔ تعیین‌شده/
    );
    // Nothing was reset: still the form, same comment, same selection.
    expect(screen.getByLabelText(/نظر \/ توضیح/)).toHaveValue('یادداشت من');
    expect(screen.getByLabelText('تأیید بازرگانی')).toBeChecked();
    expect(screen.getByTestId('commerce-decision-submit')).toBeEnabled();
  });

  it('on 409 asks for an authoritative refresh, explains the change, and keeps the comment', async () => {
    const onDecisionRecorded = jest.fn();
    decideMock.mockRejectedValue(
      new CoreApiError('This commercial approval is already APPROVED.', 409)
    );

    const user = userEvent.setup();
    renderSection({ onDecisionRecorded });
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');
    await user.click(screen.getByLabelText('رد بازرگانی'));
    await user.type(screen.getByLabelText(/نظر \/ توضیح/), 'دلیل من');
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));

    // The stale signal fires the refetch; no blind retry, no second POST.
    await waitFor(() => expect(onDecisionRecorded).toHaveBeenCalledTimes(1));
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('commerce-decision-error')).toHaveTextContent(
      /دیگر در انتظار تصمیم نیست/
    );
  });

  it('after a stale refresh the action disappears and the typed comment stays readable', async () => {
    decideMock.mockRejectedValue(
      new CoreApiError('This commercial approval is already APPROVED.', 409)
    );
    const onDecisionRecorded = jest.fn();

    const user = userEvent.setup();
    const view = renderSection({ onDecisionRecorded });
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');
    await user.click(screen.getByLabelText('رد بازرگانی'));
    await user.type(screen.getByLabelText(/نظر \/ توضیح/), 'دلیل من');
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));
    await screen.findByTestId('commerce-decision-error');

    // The parent refetch lands: the record is no longer pending.
    view.rerender(
      <CommerceCommercialSection
        assignmentsState={ready({ documentId: 'doc-1', assignments: [], history: [] })}
        approvalsState={ready(approvalsWith('APPROVED'))}
        groupsState={ready([commercialGroup()])}
        purchaseLines={[purchaseLine()]}
        documentNumber="PR-1405-0001"
        currentUserId="u-1"
        canApprove
        canManage={false}
        initialDecisionId={null}
        onRetry={noop}
        onMutated={noop}
        onDecisionRecorded={onDecisionRecorded}
      />
    );

    // The decision controls are gone; the outcome and the unsaved note are explained.
    expect(screen.queryByTestId('commerce-decision-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-decision-open-approval-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('commerce-decision-preserved-comment')).toHaveTextContent(
      'دلیل من'
    );
    expect(screen.getByTestId('commerce-decision-close')).toBeInTheDocument();
  });

  it('focuses the panel on open and restores focus to the trigger on close', async () => {
    const user = userEvent.setup();
    renderSection({});

    const trigger = screen.getByTestId('commerce-decision-open-approval-1');
    await user.click(trigger);

    const panel = await screen.findByTestId('commerce-decision-panel');
    expect(panel).toHaveFocus();

    await user.click(screen.getByTestId('commerce-decision-cancel'));
    expect(trigger).toHaveFocus();
    expect(screen.queryByTestId('commerce-decision-panel')).not.toBeInTheDocument();
  });

  it('closes the panel with Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderSection({});

    const trigger = screen.getByTestId('commerce-decision-open-approval-1');
    await user.click(trigger);
    await screen.findByTestId('commerce-decision-panel');

    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('commerce-decision-panel')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('hands focus to the section when the trigger unmounted before the close (post-decision)', async () => {
    const user = userEvent.setup();
    const view = renderSection({});
    await user.click(screen.getByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');

    // The refetch lands with the decision recorded: the entry card (and its trigger)
    // unmounts while the panel stays open on the success view.
    view.rerender(
      <CommerceCommercialSection
        assignmentsState={ready({ documentId: 'doc-1', assignments: [], history: [] })}
        approvalsState={ready(approvalsWith('APPROVED'))}
        groupsState={ready([commercialGroup()])}
        purchaseLines={[purchaseLine()]}
        documentNumber="PR-1405-0001"
        currentUserId="u-1"
        canApprove
        canManage={false}
        initialDecisionId={null}
        onRetry={noop}
        onMutated={noop}
        onDecisionRecorded={noop}
      />
    );
    expect(screen.queryByTestId('commerce-decision-open-approval-1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-decision-close'));

    // The detached trigger cannot take focus; the section itself does (browser QA run5).
    expect(screen.queryByTestId('commerce-decision-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('commerce-commercial-section')).toHaveFocus();
  });
});