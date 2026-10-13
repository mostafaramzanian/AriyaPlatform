import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckRequestDetailView } from '../CheckRequestDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  allocateFinancialCheckRequest,
  completeFinancialCheckDelivery,
  decideFinancialCheckRequest,
  decideFinancialExecutiveApproval,
  fetchFinancialCheckAttachments,
  fetchFinancialCheckAvailableActions,
  fetchFinancialCheckProcess,
  fetchFinancialCheckRequest,
  fetchFinancialCheckRequestTimeline,
  issueFinancialCheck,
  reviewFinancialCheckDocuments,
  submitFinancialCheckRequest,
  type FinancialCheckAvailableActions,
  type FinancialCheckProcessDefinition,
  type FinancialCheckRequest,
} from '@/lib/financial-api';

jest.mock('@/components/core/useCorePermissions', () => ({ useCorePermissions: jest.fn() }));
jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));
jest.mock('@/lib/financial-api', () => ({
  ...jest.requireActual('@/lib/financial-api'),
  fetchFinancialCheckRequest: jest.fn(),
  fetchFinancialCheckProcess: jest.fn(),
  fetchFinancialCheckAvailableActions: jest.fn(),
  fetchFinancialCheckAttachments: jest.fn(),
  fetchFinancialCheckRequestTimeline: jest.fn(),
  submitFinancialCheckRequest: jest.fn(),
  decideFinancialCheckRequest: jest.fn(),
  allocateFinancialCheckRequest: jest.fn(),
  reviewFinancialCheckDocuments: jest.fn(),
  decideFinancialExecutiveApproval: jest.fn(),
  issueFinancialCheck: jest.fn(),
  completeFinancialCheckDelivery: jest.fn(),
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
const attachmentsMock = fetchFinancialCheckAttachments as jest.MockedFunction<
  typeof fetchFinancialCheckAttachments
>;
const timelineMock = fetchFinancialCheckRequestTimeline as jest.MockedFunction<
  typeof fetchFinancialCheckRequestTimeline
>;
const allocateMock = allocateFinancialCheckRequest as jest.MockedFunction<
  typeof allocateFinancialCheckRequest
>;
const reviewMock = reviewFinancialCheckDocuments as jest.MockedFunction<
  typeof reviewFinancialCheckDocuments
>;
const executiveMock = decideFinancialExecutiveApproval as jest.MockedFunction<
  typeof decideFinancialExecutiveApproval
>;
const issueMock = issueFinancialCheck as jest.MockedFunction<typeof issueFinancialCheck>;
const deliverMock = completeFinancialCheckDelivery as jest.MockedFunction<
  typeof completeFinancialCheckDelivery
>;
const submitMock = submitFinancialCheckRequest as jest.MockedFunction<
  typeof submitFinancialCheckRequest
>;
const decideMock = decideFinancialCheckRequest as jest.MockedFunction<
  typeof decideFinancialCheckRequest
>;

/**
 * Phase CHECK-ISSUANCE — the CONFIGURATION-DRIVEN wizard:
 *
 *  * the stepper and step panels come from `GET /financial/check-process`; the current
 *    step is what the DEFINITION maps the row's state to (no `status` literals exist in
 *    the component to assert against);
 *  * the buttons come from `available-actions` filtered by RBAC;
 *  * every stage act calls ITS OWN route with its own payload;
 *  * the executive stage offers EXACTLY the two resolved decisions (the source's third
 *    «نیازمند اصلاح» is DEFERRED / SOURCE-CONFLICT and renders NOTHING);
 *  * a completed step opens READ-ONLY; its live form exists only while current;
 *  * sections 6/7 upload through their STAGE routes, never the section-2 route.
 */

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

function available(
  overrides: Partial<FinancialCheckAvailableActions> = {}
): FinancialCheckAvailableActions {
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
    ...overrides,
  };
}

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

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
    status: 3,
    managerDecision: 'APPROVE',
    managerComment: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
    process: {
      processKey: 'financial.check-issuance',
      processVersion: 1,
      terminal: false,
      step: { key: 'allocation', title: 'صدور فرم تخصیص', progressLabel: 'تخصیص', order: 3 },
    },
    stages: {
      allocation: null,
      documentReview: null,
      executiveApproval: null,
      issue: null,
      delivery: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockReturnValue(authState());
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
  actionsMock.mockResolvedValue(available());
  fetchOne.mockResolvedValue(request());
  attachmentsMock.mockResolvedValue([]);
  timelineMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  allocateMock.mockResolvedValue(request());
  reviewMock.mockResolvedValue(request());
  executiveMock.mockResolvedValue(request());
  issueMock.mockResolvedValue(request());
  deliverMock.mockResolvedValue(request());
  submitMock.mockResolvedValue(request());
});

describe('CheckRequestWizard — configuration-driven stages', () => {
  it('allocates through ITS route with digit strings, after the V9/V10 client pre-checks', async () => {
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-allocation');

    // V9 — empty place refuses with the SOURCE sentence and never reaches the wire.
    await userEvent.click(screen.getByTestId('financial-check-allocation-submit'));
    expect(await screen.findByTestId('financial-check-detail-error')).toHaveTextContent(
      'محل تخصیص نمی تواند خالی باشد.'
    );
    expect(allocateMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('financial-check-allocation-place'), 'بانک سامان');
    // V10 — empty amount refuses with its own source sentence.
    await userEvent.click(screen.getByTestId('financial-check-allocation-submit'));
    expect(await screen.findByTestId('financial-check-detail-error')).toHaveTextContent(
      'مبلغ چک نمی تواند خالی باشد.'
    );
    expect(allocateMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('financial-check-allocation-amount'), '50000000');
    await userEvent.click(screen.getByTestId('financial-check-allocation-submit'));
    await waitFor(() =>
      expect(allocateMock).toHaveBeenCalledWith(REQUEST_ID, {
        allocationPlace: 'بانک سامان',
        checkAmount: '50000000',
      })
    );
  });

  it('reviews documents through ITS route: تایید vs اصلاح — two buttons, own payloads', async () => {
    fetchOne.mockResolvedValue(request({ status: 4 }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-document-review');

    await userEvent.click(screen.getByTestId('financial-check-review-approve'));
    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith(REQUEST_ID, { decision: 'APPROVE' })
    );

    await userEvent.type(screen.getByTestId('financial-check-review-comment'), 'ok');
    await userEvent.click(screen.getByTestId('financial-check-review-correction'));
    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith(REQUEST_ID, {
        decision: 'CORRECTION',
        comment: 'ok',
      })
    );
  });

  it('executive stage: EXACTLY two resolved decisions — the deferred «نیازمند اصلاح» renders nothing', async () => {
    fetchOne.mockResolvedValue(request({ status: 5, managerDecision: null }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-executive');

    expect(screen.getByTestId('financial-check-executive-approve')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-executive-reject')).toBeInTheDocument();
    // The source control's third value has no enum, no transition and no route — so the
    // wizard offers no control spelling it. Assert on the panel's whole button set.
    const panel = screen.getByTestId('financial-check-executive');
    expect(panel.querySelectorAll('button')).toHaveLength(2);
    expect(panel).not.toHaveTextContent('نیازمند اصلاح است');

    await userEvent.click(screen.getByTestId('financial-check-executive-approve'));
    await waitFor(() =>
      expect(executiveMock).toHaveBeenCalledWith(REQUEST_ID, { decision: 'APPROVE' })
    );
  });

  it('issue gate: the confirm checkbox is required with the SOURCE sentence, then routes to /issue', async () => {
    fetchOne.mockResolvedValue(request({ status: 6, managerDecision: null }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-issuance');

    await userEvent.click(screen.getByTestId('financial-check-issuance-submit'));
    expect(await screen.findByTestId('financial-check-detail-error')).toHaveTextContent(
      'گزینه تایید چک صادر شده انتخاب نشده است!'
    );
    expect(issueMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('financial-check-issue-confirm'));
    await userEvent.click(screen.getByTestId('financial-check-issuance-submit'));
    await waitFor(() => expect(issueMock).toHaveBeenCalledWith(REQUEST_ID, { confirmed: true }));
  });

  it('delivery gate: receipt checkbox required, then routes to /delivery (terminal 8)', async () => {
    fetchOne.mockResolvedValue(request({ status: 7, managerDecision: null }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-delivery');

    await userEvent.click(screen.getByTestId('financial-check-delivery-submit'));
    expect(await screen.findByTestId('financial-check-detail-error')).toHaveTextContent(
      'گزینه خاتمه صدور چک انتخاب نشده است!'
    );
    expect(deliverMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('financial-check-delivery-confirm'));
    await userEvent.click(screen.getByTestId('financial-check-delivery-submit'));
    await waitFor(() => expect(deliverMock).toHaveBeenCalledWith(REQUEST_ID, { completed: true }));
  });

  it('a completed step opens READ-ONLY with its recorded data — the live form exists only while current', async () => {
    fetchOne.mockResolvedValue(
      request({
        status: 4,
        stages: {
          allocation: {
            allocationPlace: 'بانک سامان',
            balance: '120000000',
            checkDate: null,
            checkDescription: null,
            checkAmount: '50000000',
            payableTo: null,
            recordedByUserId: 'u-2',
            createdAt: '2026-10-03T09:00:00.000Z',
            updatedAt: '2026-10-03T09:00:00.000Z',
          },
          documentReview: null,
          executiveApproval: null,
          issue: null,
          delivery: null,
        },
      })
    );
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('financial-check-document-review');

    // Open the COMPLETED allocation step from the stepper.
    await userEvent.click(screen.getByTestId('financial-check-step-allocation'));
    const summary = await screen.findByTestId('financial-check-step-summary');
    expect(summary).toHaveTextContent('بانک سامان');
    expect(summary).toHaveTextContent('فقط‌خواندنی');
    // The current step's live form is NOT rendered while a previous step is on screen.
    expect(screen.queryByTestId('financial-check-document-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-review-approve')).not.toBeInTheDocument();

    // Back to the current step: the live form returns.
    await userEvent.click(screen.getByTestId('financial-check-step-back'));
    expect(await screen.findByTestId('financial-check-document-review')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-step-summary')).not.toBeInTheDocument();
  });

  it('honours the actor-policy `enabled:false` from available-actions: the button is disabled with its reason', async () => {
    fetchOne.mockResolvedValue(request({ status: 2, managerDecision: null }));
    actionsMock.mockResolvedValue(
      available({
        actions: available().actions.map((action) =>
          action.action === 'approve'
            ? { ...action, enabled: false, reason: 'CHECK_REQUEST_SELF_APPROVAL' }
            : action
        ),
      })
    );
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    const approve = await screen.findByTestId('financial-check-approve');
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'CHECK_REQUEST_SELF_APPROVAL');
    await userEvent.click(approve);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('renders section 6 at issue through the STAGE upload route — never the section-2 route', async () => {
    fetchOne.mockResolvedValue(request({ status: 6, managerDecision: null }));
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    const section = await screen.findByTestId('financial-attachments-section');
    expect(section).toHaveTextContent('تصویر چک');
    // The typed «نوع سند» picker belongs to section 2 ONLY — absent here.
    expect(screen.queryByTestId('financial-attachment-document-type')).not.toBeInTheDocument();
    expect(screen.getByTestId('financial-attachment-upload')).toBeInTheDocument();
  });

  it('refuses to render the wizard when the process configuration cannot be read', async () => {
    processMock.mockRejectedValue(
      Object.assign(new Error('config'), { details: { code: 'FORBIDDEN' } })
    );
    render(<CheckRequestDetailView requestId={REQUEST_ID} />);
    expect(await screen.findByTestId('financial-check-detail-error')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-stepper')).not.toBeInTheDocument();
  });
});




