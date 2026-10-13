import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrMissionReportView } from '../HrMissionReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchHrMissionReport,
  type ReportingMissionPage,
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
  fetchHrMissionReport: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchHrMissionReport as jest.MockedFunction<typeof fetchHrMissionReport>;

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

function row(overrides: Partial<ReportingMissionPage['items'][number]> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
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
    ...overrides,
  } as ReportingMissionPage['items'][number];
}

const SEVEN = {
  DRAFT: 1,
  SUBMITTED: 0,
  IN_APPROVAL: 0,
  CORRECTION_REQUIRED: 0,
  APPROVED: 0,
  REJECTED: 0,
  CANCELLED: 0,
};

function page(
  items = [row()],
  total = items.length,
  summary = { total, byStatus: { ...SEVEN, DRAFT: items.length } }
): ReportingMissionPage {
  return { items, total, page: 1, pageSize: 20, summary };
}

describe('HrMissionReportView - report identity and server filters', () => {
  it('names the report under the page heading - and never as an h1', async () => {
    const { container } = render(<HrMissionReportView />);

    expect(await screen.findByTestId('hr-mission-report')).toBeInTheDocument();
    expect(screen.getByText('گزارش وضعیت درخواست‌های مأموریت')).toBeInTheDocument();
    expect(container.querySelector('h1')).toBeNull();
  });

  it('sends only the register-supported filters as the server query', async () => {
    const user = userEvent.setup();
    render(<HrMissionReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'IN_APPROVAL');
    await user.selectOptions(screen.getByLabelText('حالت مدت'), 'HOURLY');
    await user.type(screen.getByLabelText('از تاریخ (میلادی)'), '2026-09-18');
    await user.type(screen.getByLabelText('تا تاریخ (میلادی)'), '2026-09-19');

    // One initial read + one per filter change (status, duration, from, to).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const query = fetchMock.mock.calls[4][0];
    expect(query).toEqual({
      page: 1,
      pageSize: 20,
      status: 'IN_APPROVAL',
      durationMode: 'HOURLY',
      from: '2026-09-18',
      to: '2026-09-19',
    });
    expect(query).not.toHaveProperty('leaveTypeId');
    expect(query).not.toHaveProperty('employeeId');
    expect(query).not.toHaveProperty('search');
    expect(query).not.toHaveProperty('locationType');
    expect(query).not.toHaveProperty('engagementType');
  });

  it('resets the filters to an unfiltered server query', async () => {
    const user = userEvent.setup();
    render(<HrMissionReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'CANCELLED');
    await user.click(screen.getByTestId('hr-mission-report-filters-reset'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 }));
  });

  it('renders the register row vocabulary - code, mode, period, state', async () => {
    render(<HrMissionReportView />);

    const link = await screen.findByTestId(
      'hr-mission-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveTextContent('E-1042');
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/hr/mission-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(screen.getByTestId('hr-mission-report-status-DRAFT')).toHaveTextContent('پیش‌نویس');
    expect(screen.getByTestId('hr-mission-report-summary-total')).toHaveTextContent('۱');
    expect(screen.getByTestId('hr-mission-report-summary-DRAFT')).toHaveTextContent('۱');
    expect(screen.getByTestId('hr-mission-report-summary-SUBMITTED')).toHaveTextContent('۰');
    expect(screen.getByTestId('hr-mission-report-summary-CORRECTION_REQUIRED')).toHaveTextContent(
      '۰'
    );
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  grant(['hr.mission.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('HrMissionReportView - states', () => {
  it('renders the EMPTY state for a filter with no rows - never a fake row', async () => {
    fetchMock.mockResolvedValueOnce(
      page(
        [],
        0,
        {
          total: 0,
          byStatus: {
            DRAFT: 0,
            SUBMITTED: 0,
            IN_APPROVAL: 0,
            CORRECTION_REQUIRED: 0,
            APPROVED: 0,
            REJECTED: 0,
            CANCELLED: 0,
          },
        }
      )
    );
    render(<HrMissionReportView />);

    const empty = await screen.findByTestId('hr-mission-report-empty');
    expect(empty).toHaveTextContent('برای این فیلترها درخواست مأموریتی یافت نشد.');
    expect(screen.queryByTestId('hr-mission-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry - never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<HrMissionReportView />);

    const error = await screen.findByTestId('hr-mission-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('boom');
    expect(screen.queryByTestId('hr-mission-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight - no fake figures', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<HrMissionReportView />);

    expect(await screen.findByTestId('hr-mission-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-report-summary-total')).not.toBeInTheDocument();
  });

  it('denies the screen without hr.mission.read - and reads nothing', async () => {
    grant([]);
    render(<HrMissionReportView />);

    expect(await screen.findByTestId('hr-mission-report')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates the filtered register through the server', async () => {
    const user = userEvent.setup();
    const secondRow = row({ id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1043' });
    fetchMock.mockResolvedValue(page([row(), secondRow], 21));
    render(<HrMissionReportView />);

    const status = await screen.findByTestId('hr-mission-report-pagination-status');
    expect(status).toHaveTextContent('صفحه ۱ از ۲');

    fetchMock.mockResolvedValue(page([], 21));
    await user.click(screen.getByTestId('hr-mission-report-pagination-next'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    );
  });
});

describe('HrMissionReportView - scope protection (no speculative surface)', () => {
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
    render(<HrMissionReportView />);
    await screen.findByTestId('hr-mission-report-table');

    expect(screen.getByTestId('hr-mission-report-export-xlsx')).toHaveTextContent('خروجی Excel');
    expect(screen.getByTestId('hr-mission-report-export-docx')).toHaveTextContent('خروجی Word');
  });

  it('shows the truthful distribution bars over the server summary', async () => {
    render(<HrMissionReportView />);
    await screen.findByTestId('hr-mission-report-table');

    expect(screen.getByTestId('hr-mission-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت درخواست‌ها'
    );
    expect(screen.getByTestId('hr-mission-report-chart-count-DRAFT')).toHaveTextContent('۱');
  });

  it('owns no write, scheduling or AI affordance - the backend has none', () => {
    const source = codeOf('HrMissionReportView.tsx');
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

  it('renders no mission metric the schema cannot carry', () => {
    const source = codeOf('HrMissionReportView.tsx');
    for (const needle of ['durationDays', 'balance', 'cost', 'نرخ', 'اضافه‌کار']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
    expect(source.toLowerCase()).not.toContain('employeeid');
    expect(source.toLowerCase()).not.toContain('search');
  });

  it('offers no HR mutation - never submits, resubmits, cancels or decides', () => {
    const source = codeOf('HrMissionReportView.tsx');
    const tokens = source.toLowerCase().split(/[^a-z\u0600-\u06ff/]+/);
    for (const needle of ['/admin/hr/', 'cancelmissionrequest', 'createmissionrequest']) {
      expect({ needle, present: tokens.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
