import { render, screen } from '@testing-library/react';

import { ProductionBomChangeReportDetailView } from '../ProductionBomChangeReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchProductionBomChangeReportRow,
  fetchProductionBomChangeReportTimeline,
  type ReportingProductionBomChangeRow,
  type ReportingProductionBomChangeTimelinePage,
} from '@/lib/production-bom-change-report-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-bom-change-report-api', () => ({
  ...jest.requireActual('@/lib/production-bom-change-report-api'),
  fetchProductionBomChangeReportRow: jest.fn(),
  fetchProductionBomChangeReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchProductionBomChangeReportRow as jest.MockedFunction<
  typeof fetchProductionBomChangeReportRow
>;
const timelineMock = fetchProductionBomChangeReportTimeline as jest.MockedFunction<
  typeof fetchProductionBomChangeReportTimeline
>;

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: what the FIFTH report's detail
 * actually promises, as executable behavior:
 *
 *  1. IDENTITY — the row's own title and its source status vocabulary.
 *  2. FIELDS — the contract's stored facts only (identity, BOM reference, dates, the
 *     change-line count); no actor id and no coefficient renders anywhere.
 *  3. AUTHORIZATION — without `production.bom.read` no request is issued.
 *  4. TIMELINE — the authoritative flow fetches on demand: entries with the Production
 *     action vocabulary, empty vs error distinct, outage retryable.
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

function row(): ReportingProductionBomChangeRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    bomId: '22222222-2222-4222-8222-222222222222',
    title: 'تغییر اقلام موتور',
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

function emptyTimeline(): ReportingProductionBomChangeTimelinePage {
  return { items: [], page: 1, pageSize: 20, total: 0 };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read']);
  authMock.mockReturnValue(authState());
  rowMock.mockResolvedValue(row());
  timelineMock.mockResolvedValue(emptyTimeline());
});

describe('ProductionBomChangeReportDetailView — the contract row, nothing richer', () => {
  it('renders the request title, status and stored facts — no actor id anywhere', async () => {
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    const detail = await screen.findByTestId('production-bom-change-report-detail');
    expect(detail).toHaveTextContent('تغییر اقلام موتور');
    expect(detail).toHaveTextContent('proj-42');
    expect(detail).toHaveTextContent('tree-771');
    expect(detail).toHaveTextContent('۲');
    // The BOM reference renders as text (the row's own fact), never as a link into
    // Production's workspace — this surface navigates only inside the report.
    expect(detail).toHaveTextContent('22222222-2222-4222-8222-222222222222');
    expect(screen.queryByText('user-9')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /جزئیات درخواست/ })).not.toBeInTheDocument();
  });

  it('states honestly that no decision exists yet — never a fabricated verdict', async () => {
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    expect(await screen.findByTestId('production-bom-change-report-detail')).toHaveTextContent(
      'هنوز تصمیمی ثبت نشده است.'
    );
    expect(rowMock).toHaveBeenCalledWith(row().id);
    expect(rowMock).toHaveBeenCalledTimes(1);
  });

  it('issues NO request without production.bom.read — the gate is a closed door', async () => {
    grant(['production.bom.manage']);
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it('renders the ERROR state with retry — never a missing-row claim', async () => {
    rowMock.mockRejectedValueOnce(new Error('boom'));
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    const error = await screen.findByTestId('production-bom-change-report-detail-error');
    expect(error).toBeInTheDocument();
    expect(screen.queryByTestId('production-bom-change-report-detail')).not.toBeInTheDocument();
  });
});

describe('ProductionBomChangeReportDetailView — the authoritative timeline', () => {
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
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    expect(
      await screen.findByTestId('production-bom-change-report-timeline-list')
    ).toBeInTheDocument();
    // The Production audit vocabulary, rendered through the existing labels.
    expect(
      screen.getByTestId('production-bom-change-report-timeline-item-evt-1')
    ).toHaveTextContent('ارسال برای تایید');
    expect(
      screen.getByTestId('production-bom-change-report-timeline-item-evt-2')
    ).toHaveTextContent('تایید');
    // Correlation facts only: the opaque actor ids render nowhere.
    expect(screen.queryByText('user-9')).not.toBeInTheDocument();
    expect(screen.queryByText('user-4')).not.toBeInTheDocument();
  });

  it('renders an honest empty timeline — an outage renders an error instead', async () => {
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    expect(
      await screen.findByTestId('production-bom-change-report-timeline-empty')
    ).toBeInTheDocument();
    expect(screen.getByTestId('production-bom-change-report-timeline-empty')).toHaveTextContent(
      'برای این درخواست هنوز رویدادی ثبت نشده است.'
    );
    expect(
      screen.queryByTestId('production-bom-change-report-timeline-error')
    ).not.toBeInTheDocument();
  });

  it('renders a timeline outage with retry — never a quiet empty list', async () => {
    timelineMock.mockRejectedValueOnce(new Error('audit down'));
    render(<ProductionBomChangeReportDetailView changeId={row().id} />);

    const error = await screen.findByTestId('production-bom-change-report-timeline-error');
    expect(error).toBeInTheDocument();
    expect(
      screen.queryByTestId('production-bom-change-report-timeline-list')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('production-bom-change-report-timeline-empty')
    ).not.toBeInTheDocument();
  });
});
