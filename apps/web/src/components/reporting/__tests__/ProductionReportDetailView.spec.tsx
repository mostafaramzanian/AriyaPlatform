import { render, screen, waitFor } from '@testing-library/react';

import { ProductionReportDetailView } from '../ProductionReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchProductionReportRow,
  fetchProductionReportTimeline,
  type ReportingProductionRow,
  type ReportingProductionTimelinePage,
} from '@/lib/production-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-report-api', () => ({
  ...jest.requireActual('@/lib/production-report-api'),
  fetchProductionReportRow: jest.fn(),
  fetchProductionReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchProductionReportRow as jest.MockedFunction<typeof fetchProductionReportRow>;
const timelineMock = fetchProductionReportTimeline as jest.MockedFunction<
  typeof fetchProductionReportTimeline
>;

/**
 * Phase REPORTING-PRODUCTION-REPORT: what the THIRD report's detail actually
 * promises, as executable behavior:
 *
 *  1. IDENTITY — the row's own title and its source status vocabulary.
 *  2. FIELDS — the contract's stored facts only (identity, classification, dates,
 *     the item count); no actor id renders anywhere.
 *  3. AUTHORIZATION — without `production.bom.read` no request is issued.
 *  4. TIMELINE — the authoritative flow fetches on demand: loading → entries with
 *     the Production action vocabulary, empty vs error distinct, outage retryable.
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

function row(): ReportingProductionRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'فهرست موتور',
    projectRef: 'proj-42',
    productTreeRef: 'tree-771',
    status: 'SUBMITTED',
    managerOpinion: null,
    itemCount: 2,
    submittedAt: '2026-01-10T08:00:00.000Z',
    decidedAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
  };
}

function emptyTimeline(): ReportingProductionTimelinePage {
  return { items: [], page: 1, pageSize: 20, total: 0 };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read']);
  authMock.mockReturnValue(authState());
  rowMock.mockResolvedValue(row());
  timelineMock.mockResolvedValue(emptyTimeline());
});

describe('ProductionReportDetailView — the contract row, nothing richer', () => {
  it('renders the BOM title, status and stored facts — no actor id anywhere', async () => {
    render(<ProductionReportDetailView bomId={row().id} />);

    const detail = await screen.findByTestId('production-report-detail');
    expect(detail).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'فهرست موتور' })).toBeInTheDocument();
    expect(screen.getByTestId('production-report-detail-status-SUBMITTED')).toHaveTextContent(
      'ارجاع برای تایید'
    );
    expect(screen.getByTestId('production-report-detail-card')).toBeInTheDocument();
    // The stored facts render; raw actor ids never do.
    expect(detail.textContent ?? '').not.toContain('user-');
    expect(detail.textContent ?? '').not.toContain('tenant-');
  });

  it('fetches exactly ONE row by route id — and renders undecided states honestly', async () => {
    render(<ProductionReportDetailView bomId={row().id} />);

    await waitFor(() => expect(rowMock).toHaveBeenCalledWith(row().id));
    expect(rowMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('production-report-detail')).toHaveTextContent(
      'هنوز تصمیمی ثبت نشده است.'
    );
  });

  it('issues NO request without production.bom.read — the gate is a closed door', async () => {
    grant(['production.bom.manage']);
    render(<ProductionReportDetailView bomId={row().id} />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it('renders the ERROR state with retry — never a missing-row claim', async () => {
    rowMock.mockRejectedValueOnce(new Error('boom'));
    render(<ProductionReportDetailView bomId={row().id} />);

    const error = await screen.findByTestId('production-report-detail-error');
    expect(error).toBeInTheDocument();
    expect(screen.queryByTestId('production-report-detail')).not.toBeInTheDocument();
  });
});

describe('ProductionReportDetailView — the authoritative timeline', () => {
  it('fetches the timeline on demand and renders each action in Production words', async () => {
    timelineMock.mockResolvedValueOnce({
      items: [
        {
          id: 'evt-1',
          action: 'submit',
          actorId: 'user-9',
          success: true,
          reason: null,
          changedFields: ['status'],
          createdAt: '2026-01-10T08:00:00.000Z',
        },
        {
          id: 'evt-2',
          action: 'approve',
          actorId: 'user-4',
          success: true,
          reason: null,
          changedFields: ['status', 'managerOpinion'],
          createdAt: '2026-01-12T09:30:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    });
    render(<ProductionReportDetailView bomId={row().id} />);

    expect(await screen.findByTestId('production-report-timeline-list')).toBeInTheDocument();
    // The Production audit vocabulary, rendered through the existing labels.
    expect(screen.getByTestId('production-report-timeline-item-evt-1')).toHaveTextContent(
      'ارسال برای تایید'
    );
    expect(screen.getByTestId('production-report-timeline-item-evt-2')).toHaveTextContent('تایید');
    // Correlation facts only: the opaque actor ids render nowhere.
    expect(screen.queryByText('user-9')).not.toBeInTheDocument();
    expect(screen.queryByText('user-4')).not.toBeInTheDocument();
  });

  it('renders an honest empty timeline — an outage renders an error instead', async () => {
    render(<ProductionReportDetailView bomId={row().id} />);

    expect(await screen.findByTestId('production-report-timeline-empty')).toBeInTheDocument();
    expect(screen.getByTestId('production-report-timeline-empty')).toHaveTextContent(
      'برای این فهرست هنوز رویدادی ثبت نشده است.'
    );
    expect(screen.queryByTestId('production-report-timeline-error')).not.toBeInTheDocument();
  });

  it('renders a timeline outage with retry — never a quiet empty list', async () => {
    timelineMock.mockRejectedValueOnce(new Error('audit down'));
    render(<ProductionReportDetailView bomId={row().id} />);

    const error = await screen.findByTestId('production-report-timeline-error');
    expect(error).toBeInTheDocument();
    expect(screen.queryByTestId('production-report-timeline-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('production-report-timeline-empty')).not.toBeInTheDocument();
  });
});
