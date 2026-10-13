import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceTasksView } from '../CommerceTasksView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchCommerceCommercialApprovals,
  fetchCommercePurchaseDocuments,
  type CommercePurchaseQuery,
} from '@/lib/commerce-api';
import {
  commercialApproval,
  purchaseDocument,
  purchaseLine,
  purchasePage,
} from './commerce-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommercePurchaseDocuments: jest.fn(),
  fetchCommerceCommercialApprovals: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const registerMock = fetchCommercePurchaseDocuments as jest.MockedFunction<
  typeof fetchCommercePurchaseDocuments
>;
const approvalsMock = fetchCommerceCommercialApprovals as jest.MockedFunction<
  typeof fetchCommerceCommercialApprovals
>;

/**
 * PHASE UI-1: the task workspace (`/admin/commerce/tasks`), Option A.
 *
 * WHAT THESE SPECS ARE FOR. This screen's failure mode is a PLEASANT LIE — a polished inbox
 * that claims more than the backend can answer. So the claims pinned here are the honest
 * ones: the limitation note exists, «همه کارهای شما» exists NOWHERE, only rows whose stored
 * approver is this user are shown, the scan's 20-document bound is stated when it bites, and
 * the workflow tab is absent because no read could ever back it (UI-0 GAP-1).
 */

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

function authState(user: { userId?: string } | null = { userId: 'u-1' }) {
  return {
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

/** The two-line document the composition reads, with stable line ids. */
function twoLineDocument() {
  return purchaseDocument({
    status: 'SUBMITTED',
    editable: false,
    lines: [
      purchaseLine({ id: 'line-1', lineNumber: 1, lineType: 'STANDARD' }),
      purchaseLine({ id: 'line-2', lineNumber: 2, lineType: 'SERVICE' }),
    ],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['commerce.read', 'commerce.approve']);
  authMock.mockReturnValue(authState());
  registerMock.mockImplementation(async (query: CommercePurchaseQuery = {}) => {
    if (query.status === 'SUBMITTED') return purchasePage([twoLineDocument()], 1);
    if (query.status === 'DRAFT') return purchasePage([purchaseDocument()], 1);
    return purchasePage([], 0);
  });
  approvalsMock.mockResolvedValue({
    documentId: 'doc-1',
    approvals: [
      commercialApproval({ id: 'mine', purchaseLineId: 'line-1', approverUserId: 'u-1' }),
      commercialApproval({ id: 'other', purchaseLineId: 'line-2', approverUserId: 'u-2' }),
      commercialApproval({
        id: 'decided',
        purchaseLineId: 'line-1',
        approverUserId: 'u-1',
        status: 'APPROVED',
      }),
    ],
  });
});

describe('CommerceTasksView — the approvals tab (Option A)', () => {
  it('holds an accessible loading state while the composition is being built', () => {
    registerMock.mockReturnValue(new Promise(() => undefined));
    approvalsMock.mockReturnValue(new Promise(() => undefined));

    render(<CommerceTasksView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-tasks-approval-rows')).not.toBeInTheDocument();
    // The honest framing is on screen from the first moment — the note is not "after load".
    expect(screen.getByTestId('commerce-tasks-limitation-note')).toBeInTheDocument();
  });

  it('refuses without a usable grant and issues NO request', async () => {
    grant([]);

    render(<CommerceTasksView />);

    expect(await screen.findByText(/commerce\.(approve|manage)/)).toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
    expect(approvalsMock).not.toHaveBeenCalled();
  });

  it('refuses an approve-only grant: the composition reads the register, which needs the read', async () => {
    grant(['commerce.approve']);

    render(<CommerceTasksView />);

    expect(await screen.findByText(/commerce\.(approve|manage)/)).toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('scans one register page and shows ONLY the PENDING rows whose approver is this user', async () => {
    render(<CommerceTasksView />);

    expect(await screen.findByTestId('commerce-tasks-approval-rows')).toBeInTheDocument();

    // One register read (the SUBMITTED page) and one approvals read for its document.
    expect(registerMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      status: 'SUBMITTED',
    });
    expect(approvalsMock).toHaveBeenCalledWith('doc-1');

    // Exactly the one row that is PENDING and assigned to u-1 — not the other approver's
    // row and not the already-decided one.
    expect(screen.getByTestId('commerce-task-approval-mine')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-task-approval-other')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-task-approval-decided')).not.toBeInTheDocument();

    // The row states the document, the line it concerns, and both lifecycles verbatim.
    expect(screen.getByText('PR-1405-0001')).toBeInTheDocument();
    expect(screen.getByText('ردیف ۱ — استاندارد')).toBeInTheDocument();
    expect(screen.getByText('در انتظار تصمیم')).toBeInTheDocument();
    expect(screen.getByText('در حال بررسی')).toBeInTheDocument();
  });

  it('states the scan limitation and NEVER claims a complete inbox', async () => {
    render(<CommerceTasksView />);

    await screen.findByTestId('commerce-tasks-approval-rows');

    expect(screen.getByTestId('commerce-tasks-limitation-note')).toBeInTheDocument();
    // The one sentence this phase must never print, because the backend cannot back it.
    expect(screen.queryByText(/همه کارهای شما/)).not.toBeInTheDocument();
    // And no fabricated SLA vocabulary either.
    expect(screen.queryByText(/تأخیر|دیرکرد/)).not.toBeInTheDocument();
  });

  it('states the 20-document bound when the server holds more SUBMITTED documents', async () => {
    registerMock.mockImplementation(async (query: CommercePurchaseQuery = {}) => {
      if (query.status === 'SUBMITTED') return purchasePage([twoLineDocument()], 25);
      return purchasePage([], 0);
    });

    render(<CommerceTasksView />);

    const capNote = await screen.findByTestId('commerce-tasks-cap-note');
    expect(capNote).toHaveTextContent('۲۵');
  });

  it('renders the honest empty state when nothing waits on this user', async () => {
    registerMock.mockImplementation(async (query: CommercePurchaseQuery = {}) =>
      query.status === 'SUBMITTED' ? purchasePage([], 0) : purchasePage([], 0)
    );

    render(<CommerceTasksView />);

    expect(
      await screen.findByText('در حال حاضر موردی در انتظار تصمیم بازرگانی شما نیست.')
    ).toBeInTheDocument();
  });

  it('surfaces a register failure through CoreError and does not read approvals', async () => {
    registerMock.mockRejectedValueOnce(new Error('شبکه در دسترس نیست'));

    render(<CommerceTasksView />);

    expect(await screen.findByText('شبکه در دسترس نیست')).toBeInTheDocument();
    expect(approvalsMock).not.toHaveBeenCalled();
  });
});

describe('CommerceTasksView — the drafts tab and the tablist', () => {
  it('opens the drafts tab for commerce.manage + read, scoped to the session user', async () => {
    grant(['commerce.read', 'commerce.manage']);

    render(<CommerceTasksView />);

    // Only one tab exists for this grant, so it is selected without a click.
    expect(screen.queryByRole('tab', { name: 'تصمیم‌های بازرگانی من' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'پیش‌نویس‌های من' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    expect(await screen.findByTestId('commerce-tasks-draft-rows')).toBeInTheDocument();
    expect(registerMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      status: 'DRAFT',
      requesterId: 'u-1',
    });
    expect(screen.getByText('PR-1405-0001')).toBeInTheDocument();
    expect(screen.getByText('۱ ردیف')).toBeInTheDocument();
  });

  it('switches to drafts by keyboard: ArrowLeft advances in RTL and moves focus with it', async () => {
    grant(['commerce.read', 'commerce.approve', 'commerce.manage']);

    render(<CommerceTasksView />);

    const approvalsTab = await screen.findByRole('tab', { name: 'تصمیم‌های بازرگانی من' });
    approvalsTab.focus();
    fireEvent.keyDown(approvalsTab, { key: 'ArrowLeft' });

    const draftsTab = screen.getByRole('tab', { name: 'پیش‌نویس‌های من' });
    expect(draftsTab).toHaveAttribute('aria-selected', 'true');
    expect(draftsTab).toHaveFocus();
    expect(await screen.findByTestId('commerce-tasks-draft-rows')).toBeInTheDocument();

    // ArrowRight goes back.
    fireEvent.keyDown(draftsTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'تصمیم‌های بازرگانی من' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Returning to the approvals tab re-runs its scan; settle it before the test ends.
    expect(await screen.findByTestId('commerce-tasks-approval-rows')).toBeInTheDocument();
  });

  it('switches to drafts by click and renders the honest empty state for it', async () => {
    grant(['commerce.read', 'commerce.approve', 'commerce.manage']);
    registerMock.mockImplementation(async (query: CommercePurchaseQuery = {}) => {
      if (query.status === 'SUBMITTED') return purchasePage([], 0);
      return purchasePage([], 0);
    });

    render(<CommerceTasksView />);

    await screen.findByTestId('commerce-tasks-approvals-empty');
    await userEvent.click(screen.getByRole('tab', { name: 'پیش‌نویس‌های من' }));

    expect(await screen.findByText('پیش‌نویس فعالی برای شما وجود ندارد.')).toBeInTheDocument();
  });
});

/**
 * PHASE UI-3 — the task rows now carry ONE primary action into the real decision
 * surface (§16/§17), and the drafts rows open their document. The list is still the
 * bounded Option A composition: everything here asserts links and copy, never a claim of
 * global coverage.
 */
describe('CommerceTasksView — the UI-3 action path', () => {
  it('gives each actionable row a link into its document’s decision panel', async () => {
    render(<CommerceTasksView />);

    const action = await screen.findByTestId('commerce-task-action-mine');
    expect(action).toHaveAttribute('href', '/admin/commerce/purchases/doc-1?decision=mine');
    expect(action).toHaveTextContent('مشاهده و تصمیم‌گیری');

    // Exactly ONE action per actionable row — the other approver's row has none.
    expect(screen.queryByTestId('commerce-task-action-other')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-task-action-decided')).not.toBeInTheDocument();
  });

  it('states the decision path in the limitation note instead of promising a future step', async () => {
    render(<CommerceTasksView />);
    await screen.findByTestId('commerce-tasks-approval-rows');

    const note = screen.getByTestId('commerce-tasks-limitation-note');
    expect(note).toHaveTextContent('مشاهده و تصمیم‌گیری');
    expect(note).toHaveTextContent('بخش بازرگانی');
    // The bounded-scan honesty sentence stays.
    expect(note).toHaveTextContent('درخواست‌های ارسال‌شدهٔ اخیر');
  });

  it('opens a draft’s document from its number chip', async () => {
    grant(['commerce.read', 'commerce.manage']);

    render(<CommerceTasksView />);

    const link = await screen.findByRole('link', { name: 'مشاهدهٔ سند PR-1405-0001' });
    expect(link).toHaveAttribute('href', '/admin/commerce/purchases/doc-1');
  });
});

