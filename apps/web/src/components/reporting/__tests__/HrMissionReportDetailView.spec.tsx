import { render, screen, waitFor } from '@testing-library/react';

import { HrMissionReportDetailView } from '../HrMissionReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchHrMissionReportRow,
  fetchHrMissionReportTimeline,
} from '@/lib/hr-mission-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/hr-mission-report-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-report-api'),
  fetchHrMissionReportRow: jest.fn(),
  fetchHrMissionReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchHrMissionReportRow as jest.MockedFunction<typeof fetchHrMissionReportRow>;
const timelineMock = fetchHrMissionReportTimeline as jest.MockedFunction<
  typeof fetchHrMissionReportTimeline
>;

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the READ-ONLY detail —
 * `/admin/reporting/hr/mission-requests/[id]` — as executable behavior:
 * identity, classification, period with times, status, decision reasons, the
 * authoritative timeline and the forbidden/loading/error states. No mutation
 * exists on this route.
 */
const ROW_ID = '11111111-1111-4111-8111-111111111111';

const ROW = {
  id: ROW_ID,
  employeeCode: 'E-1042',
  durationMode: 'DAILY',
  locationType: 'OUT_OF_CITY',
  engagementType: 'NON_PROJECT',
  startDate: '2026-09-18',
  endDate: '2026-09-20',
  startTime: null,
  endTime: null,
  destination: 'شیراز',
  description: null,
  correctionReason: null,
  rejectionReason: null,
  submittedRevision: null,
  status: 'DRAFT',
  createdAt: '2026-09-10T08:00:00.000Z',
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
  grant(['hr.mission.read']);
  authMock.mockReturnValue(authState());
  rowMock.mockResolvedValue(ROW as never);
  timelineMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 } as never);
});

describe('HrMissionReportDetailView — one register row, read-only', () => {
  it('renders the row identity, classification, period, status and reasons', async () => {
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-detail')).toBeInTheDocument();
    expect(screen.getByText('مأموریت E-1042')).toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-report-detail-status-DRAFT')).toHaveTextContent(
      'پیش‌نویس'
    );
    expect(screen.getByText('روزانه')).toBeInTheDocument();
    expect(screen.getByText('غیرپروژه‌ای')).toBeInTheDocument();
    expect(screen.getByText('شیراز')).toBeInTheDocument();
    expect(
      screen.getByText('برای این درخواست دلیل اصلاحی ثبت نشده است.')
    ).toBeInTheDocument();
    expect(screen.getByText('برای این درخواست دلیل ردی ثبت نشده است.')).toBeInTheDocument();
    // The only navigation is back to the report — no HR register link exists.
    expect(screen.getByText('بازگشت به گزارش درخواست‌های مأموریت')).toHaveAttribute(
      'href',
      '/admin/reporting/hr/mission-requests'
    );
    expect(rowMock).toHaveBeenCalledWith(ROW_ID);
  });

  it('renders clock times for an HOURLY row', async () => {
    rowMock.mockResolvedValueOnce({
      ...ROW,
      durationMode: 'HOURLY',
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      startTime: '08:00',
      endTime: '12:00',
    } as never);
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-detail')).toBeInTheDocument();
    expect(screen.getByText('ساعتی')).toBeInTheDocument();
    expect(
      screen.queryByText('این مأموریت ساعت شروع و پایان ثبت‌شده ندارد.')
    ).not.toBeInTheDocument();
  });

  it('renders the decision reasons when recorded', async () => {
    rowMock.mockResolvedValueOnce({
      ...ROW,
      status: 'CORRECTION_REQUIRED',
      correctionReason: 'مقصد را دقیق بنویسید.',
      submittedRevision: 1,
    } as never);
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(
      await screen.findByTestId('hr-mission-report-detail-status-CORRECTION_REQUIRED')
    ).toHaveTextContent('نیازمند اصلاح');
    expect(screen.getByText('مقصد را دقیق بنویسید.')).toBeInTheDocument();
  });

  it('loads the authoritative timeline on demand', async () => {
    timelineMock.mockResolvedValueOnce({
      items: [
        {
          id: 'evt-1',
          action: 'submit',
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
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-timeline')).toBeInTheDocument();
    await waitFor(() =>
      expect(timelineMock).toHaveBeenCalledWith(ROW_ID, { page: 1, pageSize: 20 })
    );
    expect(screen.getByText('ارسال درخواست')).toBeInTheDocument();
    expect(screen.getByText('تأیید')).toBeInTheDocument();
  });

  it('shows a loading state while the row is in flight', async () => {
    rowMock.mockReturnValue(new Promise(() => {}) as never);
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-detail')).toBeInTheDocument();
  });

  it('renders the error state with retry', async () => {
    rowMock.mockRejectedValueOnce(new Error('boom'));
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-detail-error')).toBeInTheDocument();
  });

  it('denies the detail without hr.mission.read — and reads nothing', async () => {
    grant([]);
    render(<HrMissionReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-mission-report-detail')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });
});
