import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckRequestDetailView } from '../CheckRequestDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  decideFinancialCheckRequest,
  fetchFinancialCheckAttachments,
  fetchFinancialCheckAvailableActions,
  fetchFinancialCheckProcess,
  fetchFinancialCheckRequest,
  fetchFinancialCheckRequestTimeline,
  type FinancialCheckAvailableActions,
  type FinancialCheckProcessDefinition,
  type FinancialCheckRequest,
} from '@/lib/financial-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/financial-api', () => ({
  ...jest.requireActual('@/lib/financial-api'),
  fetchFinancialCheckRequest: jest.fn(),
  fetchFinancialCheckProcess: jest.fn(),
  fetchFinancialCheckAvailableActions: jest.fn(),
  decideFinancialCheckRequest: jest.fn(),
  fetchFinancialCheckAttachments: jest.fn(),
  fetchFinancialCheckRequestTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchOne = fetchFinancialCheckRequest as jest.MockedFunction<
  typeof fetchFinancialCheckRequest
>;
const processMock = fetchFinancialCheckProcess as jest.MockedFunction<
  typeof fetchFinancialCheckProcess
>;
const actionsMock = fetchFinancialCheckAvailableActions as jest.MockedFunction<
  typeof fetchFinancialCheckAvailableActions
>;
const decideMock = decideFinancialCheckRequest as jest.MockedFunction<
  typeof decideFinancialCheckRequest
>;
const attachmentsMock = fetchFinancialCheckAttachments as jest.MockedFunction<
  typeof fetchFinancialCheckAttachments
>;
const timelineMock = fetchFinancialCheckRequestTimeline as jest.MockedFunction<
  typeof fetchFinancialCheckRequestTimeline
>;

/**
 * Phase F1 → CHECK-ISSUANCE: the detail screen's STATE-AWARE behaviour, now rendered from
 * the PUBLISHED process definition + `available-actions`.
 *
 * WHAT THESE SPECS PIN:
 *  * state 0/1: the edit link exists, attachments are MANAGEABLE (upload control present).
 *  * state 2: the manager panel appears for an approver (بله / خیر / نیازمند اصلاح است) and
 *    each button calls ITS OWN route — a reject cannot be sent to `/approve`.
 *  * state 2 without `financial.check.approve`: a waiting note, NO decision buttons — even
 *    when the wire offered them (RBAC filters client-side, brief §15).
 *  * state 3: the ALLOCATION step the configuration declares (its form and inputs), NO
 *    manager panel and NO issuance/delivery control — the old F1 deferral message is gone
 *    BECAUSE this phase implemented what it deferred.
 *  * state 50: terminal and read-only.
 *  * attachments and the timeline come from their own endpoints.
 */

/** The published definition's SHAPE the wizard renders from (mirrors v1's structure). */
function definition(): FinancialCheckProcessDefinition {
  return {
    processKey: 'financial.check-issuance',
    version: 1,
    status: 'published',
    title: 'درخواست صدور چک',
    steps: [
      { key: 'request', order: 1, title: 'درخواست صدور چک', progressLabel: 'ثبت درخواست', states: [0, 1], active: true, visible: true, actions: ['submit'], fields: [{ field: 'checkIssueType', states: [0, 1], editableStates: [0, 1] }] },
      { key: 'manager-review', order: 2, title: 'تایید مدیر', progressLabel: 'تایید مدیر', states: [2], active: true, visible: true, actions: ['approve', 'reject', 'request-correction'], fields: [{ field: 'managerComment', states: [2], editableStates: [2] }] },
      { key: 'allocation', order: 3, title: 'صدور فرم تخصیص', progressLabel: 'تخصیص', states: [3], active: true, visible: true, actions: ['allocate'], fields: [{ field: 'allocationPlace', states: [3], editableStates: [3] }] },
      { key: 'document-review', order: 4, title: 'بررسی اسناد', progressLabel: 'بررسی اسناد', states: [4], active: true, visible: true, actions: ['document-review', 'document-review-correction'], fields: [] },
      { key: 'executive-approval', order: 5, title: 'تایید ریاست', progressLabel: 'تایید ریاست', states: [5], active: true, visible: true, actions: ['executive-approve', 'executive-reject'], fields: [] },
      { key: 'issue', order: 6, title: 'صدور چک', progressLabel: 'صدور چک', states: [6], active: true, visible: true, actions: ['issue'], fields: [] },
      { key: 'delivery', order: 7, title: 'تحویل چک', progressLabel: 'تحویل', states: [7], active: true, visible: true, actions: ['deliver'], fields: [] },
      { key: 'completed', order: 8, title: 'پایان گردش', progressLabel: 'پایان', states: [8], active: true, visible: true, actions: [], fields: [] },
      { key: 'terminated', order: 9, title: 'خاتمه یافته', progressLabel: 'خاتمه', states: [50], active: true, visible: false, actions: [], fields: [] },
    ],
    actions: [
      { key: 'submit', label: 'ارجاع برای تصمیم مدیر', permission: 'financial.check.manage', actorPolicy: 'requester' },
      { key: 'approve', label: 'بله', permission: 'financial.check.approve', actorPolicy: 'approver' },
      { key: 'reject', label: 'خیر', permission: 'financial.check.approve', actorPolicy: 'approver' },
      { key: 'request-correction', label: 'نیازمند اصلاح است', permission: 'financial.check.approve', actorPolicy: 'approver' },
      { key: 'allocate', label: 'ثبت فرم تخصیص', permission: 'financial.check.allocate', actorPolicy: 'allocator' },
      { key: 'document-review', label: 'تایید', permission: 'financial.check.review', actorPolicy: 'reviewer' },
      { key: 'document-review-correction', label: 'اصلاح', permission: 'financial.check.review', actorPolicy: 'reviewer' },
      { key: 'executive-approve', label: 'تایید', permission: 'financial.check.approve', actorPolicy: 'executive' },
      { key: 'executive-reject', label: 'رد', permission: 'financial.check.approve', actorPolicy: 'executive' },
      { key: 'issue', label: 'تایید چک صادر شده', permission: 'financial.check.issue', actorPolicy: 'issuer' },
      { key: 'deliver', label: 'خاتمه صدور چک', permission: 'financial.check.deliver', actorPolicy: 'deliverer' },
    ],
    documentSections: [
      { section: 2, key: 'request-documents', title: 'اسناد درخواست', states: [0, 1], allowedDocumentTypes: null, requiredForActions: [], permission: 'financial.check.manage' },
      { section: 6, key: 'cheque-image', title: 'تصویر چک', states: [6], allowedDocumentTypes: null, requiredForActions: ['issue'], permission: 'financial.check.issue' },
      { section: 7, key: 'delivery-receipt', title: 'رسید تحویل', states: [7], allowedDocumentTypes: null, requiredForActions: ['deliver'], permission: 'financial.check.deliver' },
    ],
    terminalStates: [8, 50],
  };
}

/** ALL of v1's actions as `available-actions` offers them (enabled, no refusal reason). */
function allActions(): FinancialCheckAvailableActions {
  return {
    processKey: 'financial.check-issuance',
    processVersion: 1,
    state: 0,
    terminal: false,
    step: null,
    actions: definition().actions.map((action) => ({
      action: action.key,
      label: action.label,
      permission: action.permission,
      enabled: true,
      reason: null,
    })),
  };
}

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

function authState() {
  return {
    user: { userId: 'u-1', email: 'u1@example.com' },
    isLoading: false,
    error: null,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as unknown as ReturnType<typeof useAuth>;
}

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function request(overrides: Partial<FinancialCheckRequest> = {}): FinancialCheckRequest {
  return {
    id: REQUEST_ID,
    title: 'صدور چک برای خرید غیر پروژه ای',
    checkIssueType: 'PURCHASE',
    purchaseType: 'NON_PROJECT',
    orderReference: 'ORDER-1',
    projectReference: null,
    projectManagerUserId: null,
    requesterUserId: 'u-requester',
    requestDate: '2026-10-03T08:00:00.000Z',
    requesterOpinion: 'CONTINUE',
    status: 0,
    managerDecision: null,
    managerComment: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant([
    'financial.check.read',
    'financial.check.manage',
    'financial.check.approve',
    'financial.check.allocate',
    'financial.check.review',
    'financial.check.issue',
    'financial.check.deliver',
  ]);
  processMock.mockResolvedValue(definition());
  actionsMock.mockResolvedValue(allActions());
  authMock.mockReturnValue(authState());
  fetchOne.mockResolvedValue(request());
  attachmentsMock.mockResolvedValue([]);
  timelineMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
});

describe('Phase F1 — CheckRequestDetailView (state-aware)', () => {
  it('state 0: shows the edit link and a MANAGEABLE attachments section', async () => {
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('financial-check-edit-link')).toBeInTheDocument();
    expect(await screen.findByTestId('financial-attachments-empty')).toBeInTheDocument();
    expect(screen.getByTestId('financial-attachment-upload')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-manager-panel')).not.toBeInTheDocument();
  });

  it('state 2: renders the three source decisions and posts each to ITS OWN route', async () => {
    fetchOne.mockResolvedValue(request({ status: 2 }));
    decideMock.mockResolvedValue(request({ status: 3, managerDecision: 'APPROVE' }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    const approve = await screen.findByTestId('financial-check-approve');
    expect(screen.getByTestId('financial-check-reject')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-request-correction')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-edit-link')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('financial-check-manager-comment-input'), 'ok');
    await userEvent.click(approve);

    await waitFor(() =>
      expect(decideMock).toHaveBeenCalledWith(REQUEST_ID, 'approve', { comment: 'ok' })
    );
  });

  it('state 2 without the approve permission: a waiting note and NO decision buttons', async () => {
    grant(['financial.check.read']);
    fetchOne.mockResolvedValue(request({ status: 2 }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('financial-check-manager-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-reject')).not.toBeInTheDocument();
  });

    it('state 3: opens the ALLOCATION step from configuration — no manager or issuance controls', async () => {
    fetchOne.mockResolvedValue(request({ status: 3, managerDecision: 'APPROVE' }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    // The definition maps state 3 → the `allocation` step: its panel, fields and action
    // button all render — and ONLY that action (the wire offered all, RBAC + state gate).
    expect(await screen.findByTestId('financial-check-allocation')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-allocation-place')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-allocation-amount')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-allocation-submit')).toBeInTheDocument();

    // The stepper renders from configuration with the current step marked.
    expect(screen.getByTestId('financial-check-stepper')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-step-allocation')).toHaveAttribute(
      'aria-current',
      'step'
    );

    // The OLD F1 deferral message no longer exists — this phase implemented the step.
    expect(screen.queryByTestId('financial-check-approved-message')).not.toBeInTheDocument();
    // Nothing downstream of the CURRENT step exists to click. These test ids are the ones
    // a later stage would introduce; none of them may appear here.
    for (const absent of [
      'financial-check-manager-panel',
      'financial-check-issuance',
      'financial-check-delivery',
      'financial-check-sayad',
    ]) {
      expect({ absent, found: screen.queryByTestId(absent) !== null }).toEqual({
        absent,
        found: false,
      });
    }
  });

it('state 50: terminal and read-only, with the decision that reached it', async () => {
    fetchOne.mockResolvedValue(
      request({ status: 50, managerDecision: 'REJECT', managerComment: 'خیر' })
    );
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('financial-check-terminated-message')).toHaveTextContent(
      'تصمیم مدیر: خیر'
    );
    expect(screen.queryByTestId('financial-check-edit-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-attachment-upload')).not.toBeInTheDocument();
  });

  it('surfaces the server’s SELF-APPROVAL refusal on the decision panel', async () => {
    fetchOne.mockResolvedValue(request({ status: 2 }));
    decideMock.mockRejectedValue(
      Object.assign(new Error('self'), {
        details: { code: 'CHECK_REQUEST_SELF_APPROVAL' },
      })
    );
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    await userEvent.click(await screen.findByTestId('financial-check-approve'));

    expect(await screen.findByTestId('financial-check-detail-error')).toHaveTextContent(
      'درخواست‌کننده نمی‌تواند درخواست خودش را تأیید کند'
    );
  });

  it('reads the attachments and the timeline from their OWN endpoints', async () => {
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);

    await waitFor(() => expect(attachmentsMock).toHaveBeenCalledWith(REQUEST_ID));
    await waitFor(() => expect(timelineMock).toHaveBeenCalled());
    expect(await screen.findByTestId('financial-timeline-empty')).toBeInTheDocument();
  });
});
