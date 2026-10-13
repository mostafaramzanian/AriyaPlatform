import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommercePurchaseDetailView } from '../CommercePurchaseDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchCommerceAssignments,
  fetchCommerceCommercialApprovals,
  fetchCommerceCommercialGroups,
  fetchCommercePayments,
  fetchCommercePurchaseDocument,
  fetchCommerceReceipts,
  fetchCommerceReturns,
  submitCommerceCommercialDecision,
  submitCommercePurchaseDocument,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import {
  assignment,
  commercialApproval,
  paymentsRead,
  purchaseDocument,
  receiptsRead,
  returnsRead,
} from './commerce-fixtures';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/commerce/purchases/doc-1',
}));

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommercePurchaseDocument: jest.fn(),
  fetchCommercePayments: jest.fn(),
  fetchCommerceReceipts: jest.fn(),
  fetchCommerceReturns: jest.fn(),
  fetchCommerceAssignments: jest.fn(),
  fetchCommerceCommercialApprovals: jest.fn(),
  fetchCommerceCommercialGroups: jest.fn(),
  submitCommercePurchaseDocument: jest.fn(),
  submitCommerceCommercialDecision: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const docMock = fetchCommercePurchaseDocument as jest.MockedFunction<
  typeof fetchCommercePurchaseDocument
>;
const paymentsMock = fetchCommercePayments as jest.MockedFunction<typeof fetchCommercePayments>;
const receiptsMock = fetchCommerceReceipts as jest.MockedFunction<typeof fetchCommerceReceipts>;
const returnsMock = fetchCommerceReturns as jest.MockedFunction<typeof fetchCommerceReturns>;
const assignmentsMock = fetchCommerceAssignments as jest.MockedFunction<
  typeof fetchCommerceAssignments
>;
const approvalsMock = fetchCommerceCommercialApprovals as jest.MockedFunction<
  typeof fetchCommerceCommercialApprovals
>;
const groupsMock = fetchCommerceCommercialGroups as jest.MockedFunction<
  typeof fetchCommerceCommercialGroups
>;
const submitMock = submitCommercePurchaseDocument as jest.MockedFunction<
  typeof submitCommercePurchaseDocument
>;
const decideMock = submitCommerceCommercialDecision as jest.MockedFunction<
  typeof submitCommerceCommercialDecision
>;

function grant(permissions: string[]) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading: false,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

/** Every independent section read resolves with its real fixture shape. */
function sectionsResolve() {
  paymentsMock.mockResolvedValue(paymentsRead());
  receiptsMock.mockResolvedValue(receiptsRead());
  returnsMock.mockResolvedValue(returnsRead());
  assignmentsMock.mockResolvedValue({ documentId: 'doc-1', assignments: [assignment()], history: [] });
  approvalsMock.mockResolvedValue({ documentId: 'doc-1', approvals: [commercialApproval()] });
  groupsMock.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });
}

/**
 * PHASE UI-2: Purchase Detail — the central workspace. These specs pin the three
 * properties the phase is graded on: the document is understandable at a glance, every
 * section fails on its own, and NO workflow-execution UI exists anywhere (GAP-1).
 */
describe('CommercePurchaseDetailView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    grant(['commerce.read']);
    authMock.mockReturnValue({
      user: { userId: 'u-1' },
      isLoading: false,
      error: null,
      isAuthenticated: true,
      login: jest.fn(),
      logout: jest.fn(),
      clearError: jest.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    docMock.mockResolvedValue(purchaseDocument());
    sectionsResolve();
  });

  it('refuses without commerce.read and issues no request', () => {
    grant([]);

    render(<CommercePurchaseDetailView documentId="doc-1" />);

    expect(screen.getByText(/commerce\.read/)).toBeInTheDocument();
    expect(docMock).not.toHaveBeenCalled();
  });

  it('shows the identity, the document status and the independent lifecycle cells', async () => {
    render(<CommercePurchaseDetailView documentId="doc-1" />);

    const number = await screen.findByTestId('commerce-detail-number');
    expect(number).toHaveTextContent('PR-1405-0001');
    expect(number).toHaveAttribute('dir', 'ltr');
    // The status badge renders in the identity card AND in its own lifecycle cell.
    expect(
      within(screen.getByTestId('commerce-detail-identity')).getByTestId(
        'commerce-document-status-DRAFT'
      )
    ).toBeInTheDocument();

    // Lifecycle dimensions stay separate — five cells, never one global status.
    expect(await screen.findByTestId('commerce-lifecycle-document')).toBeInTheDocument();
    expect(await screen.findByTestId('commerce-lifecycle-payment')).toBeInTheDocument();
    expect(await screen.findByTestId('commerce-lifecycle-receiving')).toBeInTheDocument();
    expect(await screen.findByTestId('commerce-lifecycle-returns')).toBeInTheDocument();
    expect(await screen.findByTestId('commerce-lifecycle-commercial')).toBeInTheDocument();

    // The payment cell shows the SERVER projection (PARTIAL here), never a recomputed one.
    expect(await screen.findByTestId('commerce-payment-status-PARTIAL')).toBeInTheDocument();
  });

  it('renders NO workflow execution UI: no workflow tab, no approver, no stepper', async () => {
    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');

    expect(screen.queryByRole('tab', { name: 'گردش کار' })).not.toBeInTheDocument();
    expect(screen.queryByText(/تأیید گردش کار/)).not.toBeInTheDocument();
    // No fabricated next step or workflow actor vocabulary either (UI-3 §27).
    expect(screen.queryByText(/تصمیم گردش کار/)).not.toBeInTheDocument();
    expect(screen.queryByText(/مرحلهٔ بعد/)).not.toBeInTheDocument();
    expect(screen.queryByText(/تأییدکنندهٔ گردش کار/)).not.toBeInTheDocument();
    // The honest note is a statement of ABSENCE, not a progress bar.
    expect(screen.getByText(/جزئیات گردش کار.*در دسترس نیست/)).toBeInTheDocument();
  });

  it('keeps one section failure inside that section: the document and the rest survive', async () => {
    paymentsMock.mockRejectedValue(new CoreApiError('boom', 500));

    render(<CommercePurchaseDetailView documentId="doc-1" />);

    // The primary read succeeded → the workspace is fully usable.
    expect(await screen.findByTestId('commerce-detail-identity')).toBeInTheDocument();

    // The receiving READ still succeeded: its own lifecycle cell shows the server value.
    expect(
      await within(screen.getByTestId('commerce-lifecycle-receiving')).findByTestId(
        'commerce-receiving-status-PARTIALLY_RECEIVED'
      )
    ).toBeInTheDocument();

    const user = userEvent.setup();
    // Its own tab renders the full section.
    await user.click(screen.getByTestId('commerce-detail-tab-receipts'));
    expect(await screen.findByTestId('commerce-receiving-progress')).toBeInTheDocument();

    // The failing tab carries its OWN retry, and the document stays on screen.
    await user.click(screen.getByTestId('commerce-detail-tab-payments'));
    expect(await screen.findByRole('button', { name: /تلاش/ })).toBeInTheDocument();
    expect(screen.getByTestId('commerce-detail-identity')).toBeInTheDocument();
  });

  it('lets the reader switch tabs and keeps aria-selected honest', async () => {
    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('commerce-detail-tab-returns'));

    const returnsTab = screen.getByTestId('commerce-detail-tab-returns');
    expect(returnsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('commerce-detail-tab-overview')).toHaveAttribute(
      'aria-selected',
      'false'
    );
    expect(await screen.findByTestId('commerce-returns-history')).toBeInTheDocument();
  });

  it('moves the active tab with ArrowLeft under RTL (the shell convention)', async () => {
    const root = window.document.documentElement;
    const previousDir = root.getAttribute('dir');
    root.setAttribute('dir', 'rtl');

    try {
      render(<CommercePurchaseDetailView documentId="doc-1" />);
      const overviewTab = await screen.findByTestId('commerce-detail-tab-overview');
      overviewTab.focus();

      await userEvent.setup().keyboard('{ArrowLeft}');

      expect(screen.getByTestId('commerce-detail-tab-lines')).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.getByTestId('commerce-detail-tab-lines')).toHaveFocus();
    } finally {
      if (previousDir === null) root.removeAttribute('dir');
      else root.setAttribute('dir', previousDir);
    }
  });

  it('offers submit only for a DRAFT with commerce.manage, and runs the real command', async () => {
    grant(['commerce.read', 'commerce.manage']);
    submitMock.mockResolvedValue(purchaseDocument({ status: 'SUBMITTED' }));

    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-submit');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('commerce-detail-submit'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/قابل ویرایش نیست/)).toBeInTheDocument();
    await user.click(within(dialog).getByTestId('commerce-detail-confirm-submit-confirm'));

    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('doc-1'));
    expect(await screen.findByTestId('commerce-detail-feedback')).toHaveTextContent(
      /درخواست خرید ارسال شد/
    );
    // The response IS the new state: the badge flips without a second document read.
    expect(
      await screen.findAllByTestId('commerce-document-status-SUBMITTED')
    ).not.toHaveLength(0);
    // UI-5 §7/§29: submit creates the routing and the approvals, so exactly those two
    // sections are re-read — while the unrelated ones are left alone.
    await waitFor(() => expect(assignmentsMock).toHaveBeenCalledTimes(2));
    expect(approvalsMock).toHaveBeenCalledTimes(2);
    expect(paymentsMock).toHaveBeenCalledTimes(1);
    expect(receiptsMock).toHaveBeenCalledTimes(1);
    expect(returnsMock).toHaveBeenCalledTimes(1);
  });

  it('hides submit and edit without commerce.manage', async () => {
    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');

    expect(screen.queryByTestId('commerce-detail-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-detail-edit')).not.toBeInTheDocument();
  });

  it('shows the document-level error only when the PRIMARY read fails', async () => {
    docMock.mockRejectedValue(new CoreApiError('nope', 404));

    render(<CommercePurchaseDetailView documentId="doc-1" />);

    expect(await screen.findByTestId('commerce-purchase-detail-error')).toBeInTheDocument();
    expect(screen.getByText(/یافت نشد/)).toBeInTheDocument();
    expect(paymentsMock).not.toHaveBeenCalled();
  });

  it('shows read-derived events, explicitly labelled — never as an audit log', async () => {
    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('commerce-detail-tab-events'));

    expect(await screen.findByTestId('commerce-events-list')).toBeInTheDocument();
    expect(screen.getByText(/تاریخچهٔ کامل ممیزی/)).toBeInTheDocument();
    expect(screen.getByText('ساخت سند')).toBeInTheDocument();
  });
});

/**
 * PHASE UI-3 — the decision entry point INSIDE the Purchase. The page must expose it
 * only when the read says the current user is the stored approver of a PENDING record
 * and the session holds `commerce.approve`, must open the panel from the `?decision=`
 * deep link, and must take the new authoritative state from the server response.
 */
describe('CommercePurchaseDetailView — commercial decision integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockReturnValue({
      user: { userId: 'u-1' },
      isLoading: false,
      error: null,
      isAuthenticated: true,
      login: jest.fn(),
      logout: jest.fn(),
      clearError: jest.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    docMock.mockResolvedValue(purchaseDocument());
    sectionsResolve();
  });

  it('shows the decision entry in the commercial tab only for an approver with the grant', async () => {
    grant(['commerce.read', 'commerce.approve']);
    const user = userEvent.setup();

    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');
    await user.click(screen.getByTestId('commerce-detail-tab-commercial'));

    expect(await screen.findByTestId('commerce-decision-entry')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-decision-open-approval-1')).toBeInTheDocument();
  });

  it('shows NO decision entry for a reader without commerce.approve', async () => {
    grant(['commerce.read']);
    const user = userEvent.setup();

    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');
    await user.click(screen.getByTestId('commerce-detail-tab-commercial'));

    expect(await screen.findByTestId('commerce-detail-commercial')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-decision-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-decision-open-approval-1')).not.toBeInTheDocument();
  });

  it('opens the panel straight away when the page is opened with ?decision=', async () => {
    grant(['commerce.read', 'commerce.approve']);

    // NO tab click on purpose: the deep link must activate the Commercial tab itself —
    // browser QA run3 caught the panel never mounting while 'overview' was active.
    render(<CommercePurchaseDetailView documentId="doc-1" decisionId="approval-1" />);
    await screen.findByTestId('commerce-detail-identity');

    expect(await screen.findByTestId('commerce-decision-panel')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-detail-tab-commercial')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('records the decision, adopts the server response and refetches approvals only', async () => {
    grant(['commerce.read', 'commerce.approve']);
    decideMock.mockResolvedValue(
      commercialApproval({
        status: 'APPROVED',
        decidedByUserId: 'u-1',
        decidedAt: '2026-02-09T08:00:00.000Z',
      })
    );
    const user = userEvent.setup();

    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');
    await user.click(screen.getByTestId('commerce-detail-tab-commercial'));
    await user.click(await screen.findByTestId('commerce-decision-open-approval-1'));
    await screen.findByTestId('commerce-decision-panel');
    await user.click(screen.getByLabelText('تأیید بازرگانی'));
    await user.click(screen.getByTestId('commerce-decision-submit'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('commerce-decision-confirm-confirm'));

    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('approval-1', { decision: 'APPROVED' }));
    // Targeted invalidation: approvals are refetched, the other sections are not.
    await waitFor(() => expect(approvalsMock).toHaveBeenCalledTimes(2));
    expect(paymentsMock).toHaveBeenCalledTimes(1);
    expect(receiptsMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('commerce-decision-success')).toBeInTheDocument();
  });

  /**
   * PHASE UI-5 (§9/§11): the header states the ONE thing this reader can act on — a pending
   * commercial decision the backend assigned to them — and the button opens the very tab
   * where the decision panel lives. Same data, same filter, no extra request.
   */
  it('states the pending decision for THIS user in the header and opens the Commercial tab', async () => {
    grant(['commerce.read', 'commerce.approve']);
    const user = userEvent.setup();

    render(<CommercePurchaseDetailView documentId="doc-1" />);
    const callout = await screen.findByTestId('commerce-detail-pending-decision');
    expect(callout).toHaveTextContent('تصمیم بازرگانی در انتظار شماست');

    await user.click(screen.getByTestId('commerce-detail-pending-decision-open'));

    expect(screen.getByTestId('commerce-detail-tab-commercial')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await screen.findByTestId('commerce-decision-open-approval-1')).toBeInTheDocument();
  });

  it('shows NO callout when the pending decision belongs to someone else or the grant is missing', async () => {
    // Someone else's decision: the same filter the decision route enforces, applied for display.
    approvalsMock.mockResolvedValue({
      documentId: 'doc-1',
      approvals: [commercialApproval({ approverUserId: 'u-2' })],
    });
    grant(['commerce.read', 'commerce.approve']);
    let before = approvalsMock.mock.calls.length;
    const view = render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');
    await waitFor(() => expect(approvalsMock.mock.calls.length).toBe(before + 1));
    expect(screen.queryByTestId('commerce-detail-pending-decision')).not.toBeInTheDocument();
    view.unmount();

    // A reader without commerce.approve is told nothing they could act on.
    approvalsMock.mockResolvedValue({ documentId: 'doc-1', approvals: [commercialApproval()] });
    grant(['commerce.read']);
    before = approvalsMock.mock.calls.length;
    render(<CommercePurchaseDetailView documentId="doc-1" />);
    await screen.findByTestId('commerce-detail-identity');
    await waitFor(() => expect(approvalsMock.mock.calls.length).toBe(before + 1));
    expect(screen.queryByTestId('commerce-detail-pending-decision')).not.toBeInTheDocument();
  });
});