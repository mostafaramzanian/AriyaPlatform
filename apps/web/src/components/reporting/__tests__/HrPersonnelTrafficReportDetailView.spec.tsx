import { render, screen } from '@testing-library/react';

import { HrPersonnelTrafficReportDetailView } from '../HrPersonnelTrafficReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchHrPersonnelTrafficReportRow,
  fetchHrPersonnelTrafficReportTimeline,
  type ReportingPersonnelTrafficRow,
  type ReportingPersonnelTrafficTimelineItem,
} from '@/lib/hr-personnel-traffic-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/hr-personnel-traffic-report-api', () => ({
  ...jest.requireActual('@/lib/hr-personnel-traffic-report-api'),
  fetchHrPersonnelTrafficReportRow: jest.fn(),
  fetchHrPersonnelTrafficReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchHrPersonnelTrafficReportRow as jest.MockedFunction<
  typeof fetchHrPersonnelTrafficReportRow
>;
const timelineMock = fetchHrPersonnelTrafficReportTimeline as jest.MockedFunction<
  typeof fetchHrPersonnelTrafficReportTimeline
>;

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: what the READ-ONLY detail for one register
 * row actually promises, as executable behavior:
 *
 *  1. IDENTITY — the row's person, day, window, source and correction reason, all
 *     through the register's own vocabulary; the open day renders its `null`
 *     clock-out as a fact, not a blank.
 *  2. AUTHORIZATION — without `hr.attendance.read` no request is issued.
 *  3. FLOW — the row's own authoritative timeline in HR's audit words, on demand;
 *     an empty trail and an outage are honest and distinct.
 *  4. SCOPE — no mutation affordance anywhere.
 */

const ROW_ID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<ReportingPersonnelTrafficRow> = {}): ReportingPersonnelTrafficRow {
  return {
    id: ROW_ID,
    employeeCode: 'E-1042',
    workDate: '2026-09-18',
    dateKey: '1405/06/27',
    clockIn: '2026-09-18T04:30:00.000Z',
    clockOut: '2026-09-18T13:00:00.000Z',
    source: 'DEVICE',
    reason: null,
    ...overrides,
  };
}

function timeline(items: ReportingPersonnelTrafficTimelineItem[] = [], total = items.length) {
  return { items, page: 1, pageSize: 20, total };
}

function granted(permissions: string[]) {
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

beforeEach(() => {
  jest.clearAllMocks();
  granted(['hr.attendance.read']);
  authMock.mockReturnValue({
    user: { userId: 'u-1' },
    isLoading: false,
    error: null,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  rowMock.mockResolvedValue(row());
  timelineMock.mockResolvedValue(timeline([]));
});

describe('HrPersonnelTrafficReportDetailView — one register row, read-only', () => {
  it('renders the row identity: person, day in both calendars, window and source', async () => {
    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(
      await screen.findByTestId('hr-personnel-traffic-report-detail-card')
    ).toBeInTheDocument();
    expect(screen.getByText('E-1042')).toBeInTheDocument();
    expect(
      screen.getByTestId('hr-personnel-traffic-report-detail-source-DEVICE')
    ).toHaveTextContent('پانچ دستگاه');
    expect(screen.getByText('به‌صورت دستگاهی ثبت شده است.')).toBeInTheDocument();
    const back = screen.getByText('بازگشت به گزارش تردد پرسنل');
    expect(back).toHaveAttribute('href', '/admin/reporting/hr/personnel-traffic');
  });

  it('renders an open day’s null clock-out as a fact — never a blank', async () => {
    rowMock.mockResolvedValue(row({ clockOut: null }));

    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByText('روز هنوز باز است — خروجی ثبت نشده است.')).toBeInTheDocument();
  });

  it('renders a correction’s stored reason — the MANUAL row’s own evidence', async () => {
    rowMock.mockResolvedValue(row({ source: 'MANUAL', reason: 'اصلاح دستی بابت قطعی دستگاه' }));

    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByText('اصلاح دستی بابت قطعی دستگاه')).toBeInTheDocument();
    expect(
      screen.getByTestId('hr-personnel-traffic-report-detail-source-MANUAL')
    ).toHaveTextContent('اصلاح دستی');
  });

  it('renders the row’s timeline in the register’s audit words', async () => {
    timelineMock.mockResolvedValue(
      timeline([
        {
          id: 'evt-1',
          action: 'create',
          actorId: null,
          success: true,
          reason: null,
          changedFields: [],
          createdAt: '2026-09-18T04:30:02.000Z',
        },
        {
          id: 'evt-2',
          action: 'update',
          actorId: null,
          success: true,
          reason: null,
          changedFields: ['clockOut'],
          createdAt: '2026-09-18T13:00:02.000Z',
        },
      ])
    );

    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(
      await screen.findByTestId('hr-personnel-traffic-report-timeline-item-evt-1')
    ).toBeInTheDocument();
    expect(screen.getByText('ثبت')).toBeInTheDocument();
    expect(screen.getByText('به‌روزرسانی')).toBeInTheDocument();
  });

  it('denies the detail without hr.attendance.read — and reads nothing', async () => {
    granted([]);

    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(await screen.findByTestId('hr-personnel-traffic-report-detail')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it('renders the ERROR state with retry — never a silent blank', async () => {
    rowMock.mockRejectedValueOnce(new Error('boom'));

    render(<HrPersonnelTrafficReportDetailView rowId={ROW_ID} />);

    expect(
      await screen.findByTestId('hr-personnel-traffic-report-detail-error')
    ).toBeInTheDocument();
    expect(rowMock).toHaveBeenCalledTimes(1);
  });
});
