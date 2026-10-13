import { render, screen, waitFor } from '@testing-library/react';

import { CheckRequestReportDetailView } from '../CheckRequestReportDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchCheckRequestReportRow,
  fetchCheckRequestReportTimeline,
  type ReportingCheckRequestRow,
} from '@/lib/reporting-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/reporting-api', () => ({
  ...jest.requireActual('@/lib/reporting-api'),
  fetchCheckRequestReportRow: jest.fn(),
  fetchCheckRequestReportTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const rowMock = fetchCheckRequestReportRow as jest.MockedFunction<
  typeof fetchCheckRequestReportRow
>;
const timelineMock = fetchCheckRequestReportTimeline as jest.MockedFunction<
  typeof fetchCheckRequestReportTimeline
>;

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the READ-ONLY detail.
 *
 * What these specs pin: the detail renders the contract projection (identity,
 * classification, dates, status, decision), it fetches ONLY the selected
 * request's timeline (on demand), it shows the not-found state for a 404,
 * the permission gate issues no request, and the source carries no mutation
 * affordance — this page is for understanding, not for operating.
 */
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<ReportingCheckRequestRow> = {}): ReportingCheckRequestRow {
  return {
    id: REQUEST_ID,
    title: 'صدور چک برای حقوق',
    checkIssueType: 'SALARY',
    purchaseType: null,
    orderReference: null,
    projectReference: null,
    requestDate: '2026-10-03T08:00:00.000Z',
    requesterOpinion: 'CONTINUE',
    status: 3,
    managerDecision: 'APPROVE',
    submittedAt: '2026-10-04T08:00:00.000Z',
    decidedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  permissionsMock.mockReturnValue({
    permissions: ['financial.check.read'],
    roles: [],
    highestRole: null,
    isLoading: false,
    error: null,
    status: null,
    reload: jest.fn(),
  });
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
  timelineMock.mockResolvedValue({
    items: [
      {
        id: 'evt-1',
        action: 'submit',
        actorId: 'user-9',
        success: true,
        reason: null,
        changedFields: [],
        createdAt: '2026-10-04T08:00:00.000Z',
      },
      {
        id: 'evt-2',
        action: 'approve',
        actorId: null,
        success: true,
        reason: null,
        changedFields: [],
        createdAt: '2026-10-05T08:00:00.000Z',
      },
    ],
    page: 1,
    pageSize: 20,
    total: 2,
  });
});

describe('CheckRequestReportDetailView — read-only detail', () => {
  it('renders identity, classification, dates, status and decision from the API row', async () => {
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('reporting-detail-title')).toHaveTextContent(
      'صدور چک برای حقوق'
    );
    // Classification in the source's own Persian vocabulary.
    expect(screen.getByText('حقوق')).toBeInTheDocument();
    expect(screen.getByText('تایید و ادامه')).toBeInTheDocument();
    // Status badge: the source ordinal, its label, and the decision word.
    expect(screen.getByTestId('reporting-detail-status-badge')).toHaveTextContent(
      'صدور فرم تخصیص'
    );
    expect(screen.getByTestId('reporting-detail-decision')).toHaveTextContent('بله');
    // Dates render as Persian dates, from the payload only.
    expect(screen.getByText('تاریخ درخواست')).toBeInTheDocument();
    expect(screen.getByText('ثبت / ارسال')).toBeInTheDocument();
    expect(screen.getByText('تصمیم')).toBeInTheDocument();
  });

  it('offers the back link as its only navigation — no Financial workflow link', async () => {
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('reporting-detail');

    const back = screen.getByTestId('reporting-detail-back');
    expect(back).toHaveAttribute('href', '/admin/reporting');
    const links = screen.getAllByRole('link');
    for (const link of links) {
      expect(link.getAttribute('href')).not.toContain('/admin/financial/');
    }
  });

  it('fetches the row once and the timeline only for THIS request', async () => {
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);

    await waitFor(() => expect(rowMock).toHaveBeenCalledTimes(1));
    expect(rowMock).toHaveBeenCalledWith(REQUEST_ID);
    await waitFor(() => expect(timelineMock).toHaveBeenCalledWith(REQUEST_ID, { page: 1, pageSize: 20 }));
  });

  it('renders the authoritative timeline events — and never a raw actor id', async () => {
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('reporting-timeline-row-submit')).toHaveTextContent(
      'ارجاع برای تصمیم مدیر'
    );
    expect(screen.getByTestId('reporting-timeline-row-approve')).toHaveTextContent(
      'تأیید مدیر (بله)'
    );
    // The contract's `actorId` is deliberately not rendered: an opaque uuid
    // with no display contract is noise (phase brief §31).
    expect(screen.queryByText('user-9')).not.toBeInTheDocument();
  });

  it('maps a 404 to the not-found sentence — never a stack or a raw error', async () => {
    rowMock.mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404, details: undefined })
    );
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('reporting-detail-error')).toHaveTextContent(
      'این درخواست یافت نشد.'
    );
    expect(screen.queryByTestId('reporting-timeline')).not.toBeInTheDocument();
  });

  it('issues no request without financial.check.read', async () => {
    permissionsMock.mockReturnValue({
      permissions: [],
      roles: [],
      highestRole: null,
      isLoading: false,
      error: null,
      status: null,
      reload: jest.fn(),
    });
    render(<CheckRequestReportDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(rowMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it('contains no mutation affordance — the source never approves, rejects or edits', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    // Comment lines removed: prose that EXPLAINS the read-only rule may name
    // the verbs; the CODE may not carry them.
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'CheckRequestReportDetailView.tsx'), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*')
        );
      })
      .join('\n');
    for (const needle of ['/admin/financial/', 'approve', 'reject']) {
      expect({ needle, present: source.includes(needle) }).toEqual({
        needle,
        present: false,
      });
    }
  });
});

