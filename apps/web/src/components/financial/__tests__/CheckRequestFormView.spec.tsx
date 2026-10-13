import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckRequestFormView } from '../CheckRequestFormView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  createFinancialCheckRequest,
  fetchFinancialCheckRequest,
  submitFinancialCheckRequest,
  type FinancialCheckRequest,
} from '@/lib/financial-api';

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/financial-api', () => ({
  ...jest.requireActual('@/lib/financial-api'),
  createFinancialCheckRequest: jest.fn(),
  fetchFinancialCheckRequest: jest.fn(),
  submitFinancialCheckRequest: jest.fn(),
  updateFinancialCheckRequest: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const createMock = createFinancialCheckRequest as jest.MockedFunction<
  typeof createFinancialCheckRequest
>;
const fetchOne = fetchFinancialCheckRequest as jest.MockedFunction<
  typeof fetchFinancialCheckRequest
>;
const submitMock = submitFinancialCheckRequest as jest.MockedFunction<
  typeof submitFinancialCheckRequest
>;

/**
 * Phase F1 — FINANCIAL FOUNDATION: the state-0/1 form.
 *
 * WHAT THESE SPECS PIN: the source's CONDITIONAL FIELDS (purchase type hidden for حقوق,
 * the order reference visible only for خرید, the project pair visible only for «پروژه ای»),
 * the SERVER-GENERATED facts rendered read-only (requester, date), the create call
 * carrying only writable fields, the typed server refusal rendered as the SOURCE'S OWN
 * sentence («شناسه شماره سفارش ثبت گردد!»), and the route act saving before submitting.
 */

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
    id: '11111111-1111-4111-8111-111111111111',
    title: 'صدور چک برای خرید پروژه ای',
    checkIssueType: 'PURCHASE',
    purchaseType: 'PROJECT',
    orderReference: 'ORDER-1',
    projectReference: 'P-1',
    projectManagerUserId: 'u-mgr',
    requesterUserId: 'u-1',
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
  grant(['financial.check.read', 'financial.check.manage']);
  authMock.mockReturnValue(authState());
  createMock.mockResolvedValue(request());
  fetchOne.mockResolvedValue(request());
  submitMock.mockResolvedValue(request({ status: 2 }));
});

describe('Phase F1 — CheckRequestFormView (conditional fields, create, route)', () => {
  it('shows purchase type + order + project fields for a project purchase', async () => {
    render(<CheckRequestFormView />);

    expect(screen.getByTestId('financial-check-issue-type')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-purchase-type')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-order-reference')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-project-reference')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-project-manager')).toBeInTheDocument();
  });

  it('HIDES for حقوق: purchase type, order reference and the project pair', async () => {
    render(<CheckRequestFormView />);

    await userEvent.selectOptions(screen.getByTestId('financial-check-issue-type'), 'SALARY');

    expect(screen.queryByTestId('financial-check-purchase-type')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-order-reference')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-project-reference')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-check-project-manager')).not.toBeInTheDocument();
  });

  it('HIDES the order reference for تنخواه (the source hides it there too)', async () => {
    render(<CheckRequestFormView />);

    await userEvent.selectOptions(screen.getByTestId('financial-check-issue-type'), 'PETTY_CASH');

    expect(screen.queryByTestId('financial-check-order-reference')).not.toBeInTheDocument();
    expect(screen.getByTestId('financial-check-purchase-type')).toBeInTheDocument();
  });

  it('creates with ONLY writable fields — no requester, no date, no title', async () => {
    render(<CheckRequestFormView />);

    await userEvent.selectOptions(
      screen.getByTestId('financial-check-purchase-type'),
      'NON_PROJECT'
    );
    await userEvent.type(screen.getByTestId('financial-check-order-reference'), 'ORDER-9');
    await userEvent.click(screen.getByTestId('financial-check-save'));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: 'ORDER-9',
        requesterOpinion: 'CONTINUE',
      })
    );
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        '/admin/financial/check-requests/11111111-1111-4111-8111-111111111111'
      )
    );
  });

  it('renders the SERVER’S source sentence for a typed refusal (V4)', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('v4'), {
        details: { code: 'CHECK_REQUEST_ORDER_REFERENCE_REQUIRED' },
      })
    );
    render(<CheckRequestFormView />);

    await userEvent.click(screen.getByTestId('financial-check-save'));

    const errorBox = await screen.findByTestId('financial-check-form-error');
    expect(errorBox.textContent).toContain('شناسه شماره سفارش ثبت گردد!');
  });

  it('routes by SAVING first and submitting second — two acts, two calls', async () => {
    render(<CheckRequestFormView />);

    await userEvent.click(screen.getByTestId('financial-check-route'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(submitMock).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
    );
    expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(
      submitMock.mock.invocationCallOrder[0]
    );
  });

  it('renders the frozen notice at state 2 and keeps the requester read-only', async () => {
    fetchOne.mockResolvedValue(request({ status: 2 }));
    render(<CheckRequestFormView editId="11111111-1111-4111-8111-111111111111" />);

    expect(await screen.findByTestId('financial-check-frozen')).toBeInTheDocument();
    expect(screen.getByTestId('financial-check-save')).toBeDisabled();
    expect(screen.queryByTestId('financial-check-route')).not.toBeInTheDocument();
    // The requester is the SERVER's fact, displayed — never an input.
    expect(screen.getByTestId('financial-check-requester')).toHaveAttribute('readonly');
  });
});
