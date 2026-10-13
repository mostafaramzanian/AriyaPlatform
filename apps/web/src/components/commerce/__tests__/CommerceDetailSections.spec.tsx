import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceCommercialSection } from '../purchase/CommerceCommercialSection';
import { CommercePaymentsSection } from '../purchase/CommercePaymentsSection';
import { CommerceReceiptsSection } from '../purchase/CommerceReceiptsSection';
import { CommerceReturnsSection } from '../purchase/CommerceReturnsSection';
import type { SectionState } from '../purchase/section-state';
import {
  appendCommercePayment,
  appendCommerceReceipt,
  approveCommerceReturn,
  assignCommerceLine,
  compensateCommercePayment,
  compensateCommerceReceiptLine,
  receiveBackCommerceReturn,
  refundCommerceReturn,
  rejectCommerceReturn,
  type CommercePaymentsRead,
  type CommerceReceiptsRead,
  type CommerceReturnsRead,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import {
  assignment,
  assignmentHistoryEntry,
  commercialApproval,
  commercialGroup,
  paymentRecord,
  paymentsRead,
  purchaseLine,
  receiptsRead,
  returnDocument,
  returnsRead,
} from './commerce-fixtures';

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  appendCommercePayment: jest.fn(),
  compensateCommercePayment: jest.fn(),
  appendCommerceReceipt: jest.fn(),
  compensateCommerceReceiptLine: jest.fn(),
  createCommerceReturn: jest.fn(),
  approveCommerceReturn: jest.fn(),
  rejectCommerceReturn: jest.fn(),
  receiveBackCommerceReturn: jest.fn(),
  refundCommerceReturn: jest.fn(),
  assignCommerceLine: jest.fn(),
}));

const appendPaymentMock = appendCommercePayment as jest.MockedFunction<typeof appendCommercePayment>;
const compensatePaymentMock = compensateCommercePayment as jest.MockedFunction<
  typeof compensateCommercePayment
>;
const appendReceiptMock = appendCommerceReceipt as jest.MockedFunction<typeof appendCommerceReceipt>;
const compensateReceiptMock = compensateCommerceReceiptLine as jest.MockedFunction<
  typeof compensateCommerceReceiptLine
>;
const approveReturnMock = approveCommerceReturn as jest.MockedFunction<typeof approveCommerceReturn>;
const rejectReturnMock = rejectCommerceReturn as jest.MockedFunction<typeof rejectCommerceReturn>;
const receiveBackMock = receiveBackCommerceReturn as jest.MockedFunction<
  typeof receiveBackCommerceReturn
>;
const refundMock = refundCommerceReturn as jest.MockedFunction<typeof refundCommerceReturn>;
const assignMock = assignCommerceLine as jest.MockedFunction<typeof assignCommerceLine>;

function ready<T>(data: T): SectionState<T> {
  return { status: 'ready', data, error: null };
}

const noop = () => undefined;

/** PHASE UI-2 — «پرداخت‌ها» (C1-Q): append-only history, explicit compensation. */
describe('CommercePaymentsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appendPaymentMock.mockResolvedValue(paymentRecord());
    compensatePaymentMock.mockResolvedValue(
      paymentRecord({ id: 'payment-2', amount: '-400.0000', reversesPaymentId: 'payment-1' })
    );
  });

  it('renders the SERVER projection and the stored history', () => {
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead())}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    expect(screen.getByTestId('commerce-payment-status-PARTIAL')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-payment-row-payment-1')).toBeInTheDocument();
  });

  it('appends with amount+method only, reports what happened and refetches', async () => {
    const onMutated = jest.fn();
    const user = userEvent.setup();
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead({ items: [] }))}
        canManage
        onRetry={noop}
        onMutated={onMutated}
      />
    );

    await user.type(screen.getByLabelText('مبلغ'), '150.5');
    await user.selectOptions(screen.getByLabelText('روش پرداخت'), 'PETTY_CASH');
    await user.click(screen.getByTestId('commerce-payment-submit'));

    await waitFor(() =>
      expect(appendPaymentMock).toHaveBeenCalledWith('doc-1', {
        amount: 150.5,
        method: 'PETTY_CASH',
      })
    );
    expect(screen.getByTestId('commerce-payments-message')).toHaveTextContent(/پرداخت ثبت شد/);
    expect(onMutated).toHaveBeenCalled();
  });

  it('refuses a non-positive amount before any request', async () => {
    const user = userEvent.setup();
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead())}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    await user.type(screen.getByLabelText('مبلغ'), '0');
    await user.click(screen.getByTestId('commerce-payment-submit'));

    expect(appendPaymentMock).not.toHaveBeenCalled();
    expect(screen.getByText(/بزرگ‌تر از صفر/)).toBeInTheDocument();
  });

  it('states the compensation consequence, then appends the reversal through the path', async () => {
    const onMutated = jest.fn();
    const user = userEvent.setup();
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead())}
        canManage
        onRetry={noop}
        onMutated={onMutated}
      />
    );

    await user.click(screen.getByTestId('commerce-payment-compensate-payment-1'));
    const dialog = await screen.findByRole('dialog');
    // The exact wording the contract asks for: nothing is deleted.
    expect(within(dialog).getByText(/حذف نمی‌شود؛ یک رویداد جبرانی/)).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-payment-compensate-dialog-confirm'));

    await waitFor(() =>
      expect(compensatePaymentMock).toHaveBeenCalledWith('doc-1', 'payment-1', {})
    );
    expect(onMutated).toHaveBeenCalled();
    // No optimistic row: the history is still the ONE server row it was given.
    expect(screen.getAllByTestId(/commerce-payment-row-/)).toHaveLength(1);
  });

  it('carries the optional compensation reason (follow-up C) when one is typed', async () => {
    const user = userEvent.setup();
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead())}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    await user.click(screen.getByTestId('commerce-payment-compensate-payment-1'));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('دلیل (اختیاری)'), 'خطا در ثبت فاکتور');
    await user.click(screen.getByTestId('commerce-payment-compensate-dialog-confirm'));

    await waitFor(() =>
      expect(compensatePaymentMock).toHaveBeenCalledWith('doc-1', 'payment-1', {
        reason: 'خطا در ثبت فاکتور',
      })
    );
  });

  it('keeps the history and maps a double-compensation refusal into Persian', async () => {
    compensatePaymentMock.mockRejectedValue(
      new CoreApiError('The payment already has a compensating row: abc', 409)
    );
    const user = userEvent.setup();
    render(
      <CommercePaymentsSection
        documentId="doc-1"
        state={ready<CommercePaymentsRead>(paymentsRead())}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    await user.click(screen.getByTestId('commerce-payment-compensate-payment-1'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-payment-compensate-dialog-confirm'));

    expect(await screen.findByTestId('commerce-payments-error')).toHaveTextContent(/جبران شده/);
    expect(screen.getByTestId('commerce-payment-row-payment-1')).toBeInTheDocument();
  });
});

/** PHASE UI-2 — «دریافت‌ها» (C1-R): events, not a ledger; the correction is an EVENT. */
describe('CommerceReceiptsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appendReceiptMock.mockResolvedValue({
      id: 'receipt-2',
      receivedAt: '2026-02-06T08:00:00.000Z',
      receiverId: 'u-1',
      createdAt: '2026-02-06T08:00:00.000Z',
      lines: [],
    });
    compensateReceiptMock.mockResolvedValue({
      id: 'receipt-3',
      receivedAt: '2026-02-07T08:00:00.000Z',
      receiverId: 'u-1',
      createdAt: '2026-02-07T08:00:00.000Z',
      lines: [],
    });
  });

  it('shows the per-line progress with an exact remaining hint', () => {
    render(
      <CommerceReceiptsSection
        documentId="doc-1"
        state={ready<CommerceReceiptsRead>(receiptsRead())}
        purchaseLines={[purchaseLine()]}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    expect(screen.getByText(/۴ از ۱۰/)).toBeInTheDocument();
    expect(screen.getByText(/باقی‌مانده: ۶/)).toBeInTheDocument();
    expect(screen.getByTestId('commerce-receiving-status-PARTIALLY_RECEIVED')).toBeInTheDocument();
  });

  it('warns (display-only) when a quantity exceeds the remaining hint, then lets the server decide', async () => {
    const onMutated = jest.fn();
    const user = userEvent.setup();
    render(
      <CommerceReceiptsSection
        documentId="doc-1"
        state={ready<CommerceReceiptsRead>(receiptsRead())}
        purchaseLines={[purchaseLine()]}
        canManage
        onRetry={noop}
        onMutated={onMutated}
      />
    );

    await user.type(screen.getByLabelText('مقدار'), '50');
    expect(screen.getByText(/بیشتر از باقی‌ماندهٔ نمایش‌داده‌شده/)).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-receipt-submit'));

    // The hint does NOT block: the invariant belongs to the backend, under its own lock.
    await waitFor(() =>
      expect(appendReceiptMock).toHaveBeenCalledWith('doc-1', {
        lines: [{ purchaseLineId: 'line-1', quantity: 50 }],
      })
    );
    expect(onMutated).toHaveBeenCalled();
  });

  it('maps an over-receipt 409 into the Persian sentence with the server quantities', async () => {
    appendReceiptMock.mockRejectedValue(
      new CoreApiError(
        'Receiving line 1 would exceed its ordered quantity: ordered 10.0000, already received 4.0000, requested 50.0000',
        409
      )
    );
    const user = userEvent.setup();
    render(
      <CommerceReceiptsSection
        documentId="doc-1"
        state={ready<CommerceReceiptsRead>(receiptsRead())}
        purchaseLines={[purchaseLine()]}
        canManage
        onRetry={noop}
        onMutated={noop}
      />
    );

    await user.type(screen.getByLabelText('مقدار'), '50');
    await user.click(screen.getByTestId('commerce-receipt-submit'));

    const error = await screen.findByTestId('commerce-receipts-error');
    expect(error).toHaveTextContent(/بیشتر است/);
    expect(error).toHaveTextContent(/۱۰/); // the server's own numbers, in Persian digits
    // The entered value is preserved for the correction.
    expect(screen.getByLabelText('مقدار')).toHaveValue('50');
  });

  it('states that a correction APPENDS an event, and posts a positive magnitude', async () => {
    const onMutated = jest.fn();
    const user = userEvent.setup();
    render(
      <CommerceReceiptsSection
        documentId="doc-1"
        state={ready<CommerceReceiptsRead>(receiptsRead())}
        purchaseLines={[purchaseLine()]}
        canManage
        onRetry={noop}
        onMutated={onMutated}
      />
    );

    await user.click(screen.getByTestId('commerce-receipt-compensate-receipt-line-1'));
    expect(screen.getByText(/رویداد اصلی حذف یا ویرایش نمی‌شود/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('مقدار جبران'), '1.5');
    await user.click(screen.getByTestId('commerce-receipt-correction-submit'));

    await waitFor(() =>
      expect(compensateReceiptMock).toHaveBeenCalledWith('doc-1', 'receipt-line-1', {
        quantity: 1.5,
      })
    );
    expect(onMutated).toHaveBeenCalled();
  });
});

/** PHASE UI-2 — «مرجوعی‌ها» (C1-S): a child lifecycle with EXACTLY its allowed commands. */
describe('CommerceReturnsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    approveReturnMock.mockResolvedValue(returnDocument({ state: 'APPROVED' }));
    rejectReturnMock.mockResolvedValue(returnDocument({ state: 'REJECTED' }));
    receiveBackMock.mockResolvedValue(returnDocument({ state: 'RECEIVED_BACK' }));
    refundMock.mockResolvedValue(returnDocument({ state: 'REFUNDED' }));
  });

  function renderReturns(state: CommerceReturnsRead, canManage = true) {
    return render(
      <CommerceReturnsSection
        documentId="doc-1"
        state={ready<CommerceReturnsRead>(state)}
        receiptsState={ready<CommerceReceiptsRead>(receiptsRead())}
        paymentsState={ready<CommercePaymentsRead>(paymentsRead())}
        purchaseLines={[purchaseLine()]}
        canManage={canManage}
        onRetry={noop}
        onMutated={noop}
        onPaymentsMutated={noop}
      />
    );
  }

  it('renders the state chain and shows a REQUESTED return the two decision commands only', () => {
    renderReturns(returnsRead());

    expect(screen.getByTestId('commerce-return-state-REQUESTED')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-return-approve-return-1')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-return-reject-return-1')).toBeInTheDocument();
    // Not yet receivable-back, not refundable.
    expect(screen.queryByTestId('commerce-return-receive-back-return-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-return-refund-open-return-1')).not.toBeInTheDocument();
  });

  it('runs approve through its own route after a consequence-first confirmation', async () => {
    const user = userEvent.setup();
    renderReturns(returnsRead());

    await user.click(screen.getByTestId('commerce-return-approve-return-1'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/سند درخواست خرید تغییری نمی‌کند/)).toBeInTheDocument();
    await user.click(screen.getByTestId('commerce-return-command-dialog-confirm'));

    await waitFor(() => expect(approveReturnMock).toHaveBeenCalledWith('doc-1', 'return-1'));
    expect(screen.getByTestId('commerce-returns-message')).toHaveTextContent(/تأیید شد/);
  });

  it('offers receive-back only for an APPROVED return, and sends no body', async () => {
    const user = userEvent.setup();
    renderReturns({ returns: [returnDocument({ state: 'APPROVED' })] });

    await user.click(screen.getByTestId('commerce-return-receive-back-return-1'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-return-command-dialog-confirm'));

    await waitFor(() => expect(receiveBackMock).toHaveBeenCalledWith('doc-1', 'return-1'));
  });

  it('offers refund only for RECEIVED_BACK, with the payments read as the real candidates', async () => {
    const user = userEvent.setup();
    renderReturns({ returns: [returnDocument({ state: 'RECEIVED_BACK' })] });

    await user.click(screen.getByTestId('commerce-return-refund-open-return-1'));
    const select = await screen.findByLabelText('پرداخت موردنظر');
    expect(within(select).getByText(/۴۰۰/)).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-refund-submit'));

    await waitFor(() =>
      expect(refundMock).toHaveBeenCalledWith('doc-1', 'return-1', { paymentId: 'payment-1' })
    );
  });

  it('renders a terminal return without any command button', () => {
    renderReturns({ returns: [returnDocument({ state: 'REFUNDED' })] });

    expect(screen.getByTestId('commerce-return-state-REFUNDED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تأیید' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'رد' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-return-refund-open-return-1')).not.toBeInTheDocument();
  });
});

/** PHASE UI-2 — «بازرگانی» (C1-P): the ONE manual mutation; approvals stay read-only. */
describe('CommerceCommercialSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assignMock.mockResolvedValue(assignment());
  });

  function renderCommercial(canManage = true) {
    return render(
      <CommerceCommercialSection
        assignmentsState={ready({
          documentId: 'doc-1',
          assignments: [assignment()],
          history: [assignmentHistoryEntry()],
        })}
        approvalsState={ready({
          documentId: 'doc-1',
          approvals: [commercialApproval({ status: 'PENDING' })],
        })}
        groupsState={ready([commercialGroup()])}
        purchaseLines={[purchaseLine()]}
        documentNumber="PR-1405-0001"
        currentUserId="u-1"
        canApprove={false}
        canManage={canManage}
        onRetry={noop}
        onMutated={noop}
        onDecisionRecorded={noop}
      />
    );
  }

  it('shows current ownership and the append-only history, with approvals READ-ONLY', () => {
    renderCommercial();

    expect(screen.getByTestId('commerce-assignment-status-ASSIGNED')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-assignment-history')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-approval-status-PENDING')).toBeInTheDocument();

    // UI-3 owns decisions: no approve/reject control may exist in UI-2.
    expect(screen.queryByRole('button', { name: 'تأیید' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'رد' })).not.toBeInTheDocument();
  });

  it('assigns ONE line through the line-first route with the group and the reason', async () => {
    const onMutated = jest.fn();
    const user = userEvent.setup();
    render(
      <CommerceCommercialSection
        assignmentsState={ready({ documentId: 'doc-1', assignments: [], history: [] })}
        approvalsState={ready({ documentId: 'doc-1', approvals: [] })}
        groupsState={ready([commercialGroup()])}
        purchaseLines={[purchaseLine()]}
        documentNumber="PR-1405-0001"
        currentUserId="u-1"
        canApprove={false}
        canManage
        onRetry={noop}
        onMutated={onMutated}
        onDecisionRecorded={noop}
      />
    );

    await user.click(screen.getByTestId('commerce-assign-open-1'));
    await user.selectOptions(screen.getByLabelText('گروه بازرگانی'), 'group-1');
    await user.type(screen.getByLabelText(/دلیل/), 'انتقال به گروه فناوری');
    await user.click(screen.getByTestId('commerce-assign-submit'));

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith({
        lineId: 'line-1',
        groupId: 'group-1',
        reason: 'انتقال به گروه فناوری',
      })
    );
    expect(onMutated).toHaveBeenCalled();
  });

  it('maps a non-assignable document refusal and keeps the selection', async () => {
    assignMock.mockRejectedValue(
      new CoreApiError(
        'A purchase document in status CLOSED can no longer be assigned (§3-H).',
        409
      )
    );
    const user = userEvent.setup();
    renderCommercial();

    await user.click(screen.getByTestId('commerce-assign-open-1'));
    await user.selectOptions(screen.getByLabelText('گروه بازرگانی'), 'group-1');
    await user.click(screen.getByTestId('commerce-assign-submit'));

    expect(await screen.findByTestId('commerce-commercial-error')).toHaveTextContent(
      /امکان واگذاری ردیف ندارد/
    );
    expect(screen.getByLabelText('گروه بازرگانی')).toHaveValue('group-1');
  });
});