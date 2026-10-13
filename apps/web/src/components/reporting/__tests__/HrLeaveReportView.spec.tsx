import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrLeaveReportView } from '../HrLeaveReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchHrLeaveReport,
  type ReportingLeavePage,
} from '@/lib/hr-leave-report-api';
import { fetchHrLeaveTypes } from '@/lib/hr-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/hr-leave-report-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-report-api'),
  fetchHrLeaveReport: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrLeaveTypes: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchHrLeaveReport as jest.MockedFunction<typeof fetchHrLeaveReport>;
const typesMock = fetchHrLeaveTypes as jest.MockedFunction<typeof fetchHrLeaveTypes>;

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

function row(overrides: Partial<ReportingLeavePage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    employeeCode: 'E-1042',
    leaveTypeCode: 'ANNUAL',
    leaveTypeName: 'استحقاقی',
    startDate: '2026-09-18',
    endDate: '2026-09-20',
    reason: 'سفر خانوادگی',
    status: 'PENDING',
    createdAt: '2026-09-10T08:00:00.000Z',
    cancelledAt: null,
    ...overrides,
  } as ReportingLeavePage['items'][number];
}

function page(
  items = [row()],
  total = items.length,
  summary = { total, byStatus: { PENDING: items.length, APPROVED: 0, REJECTED: 0, CANCELLED: 0 } }
): ReportingLeavePage {
  return { items, total, page: 1, pageSize: 20, summary };
}

const LEAVE_TYPES = {
  items: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tenant-a',
      code: 'ANNUAL',
      name: 'استحقاقی',
      status: 'ACTIVE',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 100,
};

describe('HrLeaveReportView - report identity and server filters', () => {
  it('names the report under the page heading - and never as an h1', async () => {
    const { container } = render(<HrLeaveReportView />);

    expect(await screen.findByTestId('hr-leave-report')).toBeInTheDocument();
    expect(screen.getByText('گزارش وضعیت درخواست‌های مرخصی')).toBeInTheDocument();
    expect(container.querySelector('h1')).toBeNull();
  });

  it('sends only the register-supported filters as the server query', async () => {
    const user = userEvent.setup();
    render(<HrLeaveReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'PENDING');
    await user.type(screen.getByLabelText('از تاریخ (میلادی)'), '2026-09-18');
    await user.type(screen.getByLabelText('تا تاریخ (میلادی)'), '2026-09-19');
    await user.selectOptions(
      screen.getByLabelText('نوع مرخصی'),
      '33333333-3333-4333-8333-333333333333'
    );

    // One initial read + one per filter change (status, from, to, leave type).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const query = fetchMock.mock.calls[4][0];
    expect(query).toEqual({
      page: 1,
      pageSize: 20,
      status: 'PENDING',
      from: '2026-09-18',
      to: '2026-09-19',
      leaveTypeId: '33333333-3333-4333-8333-333333333333',
    });
    expect(query).not.toHaveProperty('dateKey');
    expect(query).not.toHaveProperty('employeeId');
    expect(query).not.toHaveProperty('search');
  });

  it('resets the filters to an unfiltered server query', async () => {
    const user = userEvent.setup();
    render(<HrLeaveReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'CANCELLED');
    await user.click(screen.getByTestId('hr-leave-report-filters-reset'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 }));
  });

  it('renders the register row vocabulary - code, kind, period, state', async () => {
    render(<HrLeaveReportView />);

    const link = await screen.findByTestId(
      'hr-leave-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveTextContent('E-1042');
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/hr/leave-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(screen.getByTestId('hr-leave-report-status-PENDING')).toHaveTextContent('ثبت‌شده');
    expect(screen.getByTestId('hr-leave-report-summary-total')).toHaveTextContent('۱');
    expect(screen.getByTestId('hr-leave-report-summary-PENDING')).toHaveTextContent('۱');
    expect(screen.getByTestId('hr-leave-report-summary-APPROVED')).toHaveTextContent('۰');
  });
});


beforeEach(() => {
  jest.clearAllMocks();
  grant(['hr.leave.read']);
  authMock.mockReturnValue(authState());
  typesMock.mockResolvedValue(LEAVE_TYPES as never);
  fetchMock.mockResolvedValue(page());
});


describe('HrLeaveReportView - states', () => {
  it('renders the EMPTY state for a filter with no rows - never a fake row', async () => {
    fetchMock.mockResolvedValueOnce(
      page([], 0, { total: 0, byStatus: { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 } })
    );
    render(<HrLeaveReportView />);

    const empty = await screen.findByTestId('hr-leave-report-empty');
    expect(empty).toHaveTextContent('برای این فیلترها درخواست مرخصی‌ای یافت نشد.');
    expect(screen.queryByTestId('hr-leave-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry - never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<HrLeaveReportView />);

    const error = await screen.findByTestId('hr-leave-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('boom');
    expect(screen.queryByTestId('hr-leave-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight - no fake figures', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<HrLeaveReportView />);

    expect(await screen.findByTestId('hr-leave-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-leave-report-summary-total')).not.toBeInTheDocument();
  });

  it('denies the screen without hr.leave.read - and reads nothing', async () => {
    grant([]);
    render(<HrLeaveReportView />);

    expect(await screen.findByTestId('hr-leave-report')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates the filtered register through the server', async () => {
    const user = userEvent.setup();
    const secondRow = row({ id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1043' });
    fetchMock.mockResolvedValue(page([row(), secondRow], 21));
    render(<HrLeaveReportView />);

    const status = await screen.findByTestId('hr-leave-report-pagination-status');
    expect(status).toHaveTextContent('صفحه ۱ از ۲');

    fetchMock.mockResolvedValue(page([], 21));
    await user.click(screen.getByTestId('hr-leave-report-pagination-next'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );
  });
});

describe('HrLeaveReportView - scope protection (no speculative surface)', () => {
  /** Comment lines removed: prose that EXPLAINS a rule must not violate it. */
  const codeOf = (file: string): string => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    return fs
      .readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('{/*')
        );
      })
      .join('\n');
  };

  it('renders the export actions for the CURRENT scope - the contract now exists', async () => {
    render(<HrLeaveReportView />);
    await screen.findByTestId('hr-leave-report-table');

    expect(screen.getByTestId('hr-leave-report-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('hr-leave-report-export-docx')).toHaveTextContent('خروجی Word');
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    render(<HrLeaveReportView />);
    await screen.findByTestId('hr-leave-report-table');

    expect(screen.getByTestId('hr-leave-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت درخواست‌ها'
    );
    expect(screen.getByTestId('hr-leave-report-chart-count-PENDING')).toHaveTextContent('۱');
  });

  it('owns no write, scheduling or AI affordance - the backend has none', () => {
    const source = codeOf('HrLeaveReportView.tsx');
    for (const needle of [
      'زمان‌بندی',
      'اشتراک',
      'ارسال خودکار',
      'هوش مصنوعی',
      'csv',
      'pdf',
    ]) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
  });

  it('renders no leave metric the schema cannot carry', () => {
    const source = codeOf('HrLeaveReportView.tsx');
    for (const needle of ['duration', 'balance', 'نرخ', 'اضافه‌کار']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
    expect(source.toLowerCase()).not.toContain('employeeid');
    expect(source.toLowerCase()).not.toContain('search');
  });

  it('offers no HR mutation - never submits, restates, withdraws or decides', () => {
    const source = codeOf('HrLeaveReportView.tsx');
    const tokens = source.toLowerCase().split(/[^a-z\u0600-\u06ff/]+/);
    for (const needle of ['/admin/hr/', 'cancelhrleaverequest', 'createhrleaverequest']) {
      expect({ needle, present: tokens.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
