import { render, screen, waitFor } from '@testing-library/react';

import { HrLeaveReportDetailView } from '../HrLeaveReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchHrLeaveReportRow, fetchHrLeaveReportTimeline } from '@/lib/hr-leave-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/hr-leave-report-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-report-api'),
  fetchHrLeaveReportRow: jest.fn(),
  fetchHrLeaveReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchHrLeaveReportRow as jest.MockedFunction<typeof fetchHrLeaveReportRow>;
const timelineMock = fetchHrLeaveReportTimeline as jest.MockedFunction<
  typeof fetchHrLeaveReportTimeline
>;

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the READ-ONLY detail —
 * `/admin/reporting/hr/leave-requests/[id]` — as executable behavior:
 * identity, status, period, instants, the authoritative timeline and the
 * forbidden/loading/error states. No mutation exists on this route.
 */
const ROW_ID = '11111111-1111-4111-8111-111111111111';

const ROW = {
  id: ROW_ID,
  employeeCode: 'E-1042',
  leaveTypeCode: 'ANNUAL',
  leaveTypeName: 'استحقاقی',
  startDate: '2026-09-18',
  endDate: '2026-09-20',
  reason: 'سفر خانوادگی',
  status: 'PENDING',
  createdAt: '2026-09-10T08:00:00.000Z',
  cancelledAt: null,
};

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
  } as unknown as ReturnType<typeof useAuth>;
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['hr.leave.read']);
  authMock.mockReturnValue(authState());
  rowMock.mockResolvedValue(ROW as never);
  timelineMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 } as never);
});

describe('HrLeaveReportDetailView — one register row, read-only', () => {
  it('renders the row identity, kind, period, status and instants', async () => {
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-detail')).toBeInTheDocument();
    expect(screen.getByText('درخواست E-1042')).toBeInTheDocument();
    expect(screen.getByTestId('hr-leave-report-detail-status-PENDING')).toHaveTextContent(
      'ثبت‌شده'
    );
    expect(screen.getByText('استحقاقی')).toBeInTheDocument();
    expect(screen.getByText('این درخواست لغو نشده است.')).toBeInTheDocument();
    // The only navigation is back to the report — no HR register link exists.
    expect(screen.getByText('بازگشت به گزارش درخواست‌های مرخصی')).toHaveAttribute(
      'href',
      '/admin/reporting/hr/leave-requests'
    );
    expect(rowMock).toHaveBeenCalledWith(ROW_ID);
  });

  it('renders the withdrawn instant for a cancelled row', async () => {
    rowMock.mockResolvedValueOnce({
      ...ROW,
      status: 'CANCELLED',
      cancelledAt: '2026-09-12T10:00:00.000Z',
    } as never);
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-detail-status-CANCELLED')).toHaveTextContent(
      'لغوشده'
    );
    expect(screen.queryByText('این درخواست لغو نشده است.')).not.toBeInTheDocument();
  });

  it('loads the authoritative timeline on demand', async () => {
    timelineMock.mockResolvedValueOnce({
      items: [
        {
          id: 'evt-1',
          action: 'create',
          actorId: null,
          success: true,
          reason: null,
          changedFields: [],
          createdAt: '2026-09-10T08:00:00.000Z',
        },
        {
          id: 'evt-2',
          action: 'approve',
          actorId: null,
          success: true,
          reason: null,
          changedFields: ['status'],
          createdAt: '2026-09-11T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    } as never);
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-timeline')).toBeInTheDocument();
    await waitFor(() => expect(timelineMock).toHaveBeenCalledWith(ROW_ID, { page: 1, pageSize: 20 }));
    expect(screen.getByText('ثبت درخواست')).toBeInTheDocument();
    expect(screen.getByText('تأیید')).toBeInTheDocument();
  });

  it('shows a loading state while the row is in flight', async () => {
    rowMock.mockReturnValue(new Promise(() => {}) as never);
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-detail')).toBeInTheDocument();
  });

  it('renders the error state with retry', async () => {
    rowMock.mockRejectedValueOnce(new Error('boom'));
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-detail-error')).toBeInTheDocument();
  });

  it('denies the detail without hr.leave.read — and reads nothing', async () => {
    grant([]);
    render(<HrLeaveReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-leave-report-detail')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });
});
