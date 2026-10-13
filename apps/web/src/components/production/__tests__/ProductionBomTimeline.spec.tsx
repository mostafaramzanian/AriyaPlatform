import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomTimeline } from '../ProductionBomTimeline';
import { ProductionBomDetailView } from '../ProductionBomDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchProductionBom,
  fetchProductionBomItems,
  fetchProductionBomTimeline,
  type ProductionBomTimelineEntry,
  type ProductionBomTimelinePage,
} from '@/lib/production-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-api', () => ({
  ...jest.requireActual('@/lib/production-api'),
  fetchProductionBom: jest.fn(),
  fetchProductionBomItems: jest.fn(),
  fetchProductionBomTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const timelineMock = fetchProductionBomTimeline as jest.MockedFunction<
  typeof fetchProductionBomTimeline
>;
const bomMock = fetchProductionBom as jest.MockedFunction<typeof fetchProductionBom>;
const itemsMock = fetchProductionBomItems as jest.MockedFunction<typeof fetchProductionBomItems>;

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the read-only history section.
 *
 * WHAT THESE SPECS PIN, and why each is falsifiable:
 *  1. ALL FOUR STATES ARE DISTINCT — loading while the read is in flight, the populated
 *     list, a genuinely empty trail, and a FAILURE. A test that only checked the populated
 *     case would let a 503 render as «رویدادی ثبت نشده», which is the most misleading
 *     thing this screen could say.
 *  2. ORDER IS THE SERVER'S. Entries render in the order the API returned them
 *     (chronological `createdAt ASC, id ASC`); nothing here sorts, so a client-side sort
 *     added later fails an assertion rather than silently disagreeing with the trail.
 *  3. LABELS ARE THE MAPPED ONES, and an unknown verb shows the raw token rather than an
 *     invented sentence.
 *  4. NOTHING LEAVES THE CONTRACT: a row renders the verb, instant, actor id, reason and
 *     changed FIELD NAMES — never a payload, because the projection carries none.
 *  5. PAGING RE-FETCHES THE TIMELINE ONLY, and asks only for a page window.
 *  6. THE PARENT GATES IT on `production.bom.read`, and a reader without that grant issues
 *     NO timeline request at all.
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

function entry(overrides: Partial<ProductionBomTimelineEntry> = {}): ProductionBomTimelineEntry {
  return {
    id: 'e-1',
    action: 'create',
    actorId: 'user-requester',
    success: true,
    reason: null,
    changedFields: [],
    createdAt: '2026-02-01T10:30:00.000Z',
    ...overrides,
  };
}

function pageOf(
  items: ProductionBomTimelineEntry[],
  overrides: Partial<ProductionBomTimelinePage> = {}
): ProductionBomTimelinePage {
  return { items, total: items.length, page: 1, pageSize: 20, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read']);
  authMock.mockReturnValue(authState());
  timelineMock.mockResolvedValue(pageOf([]));
});

describe('ProductionBomTimeline — states', () => {
  it('shows a loading state while the read is in flight', () => {
    let resolveRead: (value: ProductionBomTimelinePage) => void = () => undefined;
    timelineMock.mockReturnValue(
      new Promise<ProductionBomTimelinePage>((resolve) => {
        resolveRead = resolve;
      })
    );

    render(<ProductionBomTimeline bomId="bom-1" />);
    // `CoreLoading` owns the accessible status role; asserting it rather than a class is
    // what makes this pass or fail on BEHAVIOUR instead of on styling.
    expect(screen.getByRole('status')).toBeInTheDocument();

    resolveRead(pageOf([]));
  });

  it('renders the populated list with the mapped Persian labels', async () => {
    timelineMock.mockResolvedValue(
      pageOf([
        entry({ id: 'e-1', action: 'create' }),
        entry({ id: 'e-2', action: 'submit' }),
        entry({ id: 'e-3', action: 'approve' }),
      ])
    );

    render(<ProductionBomTimeline bomId="bom-1" />);

    expect(await screen.findAllByTestId('production-timeline-entry')).toHaveLength(3);
    expect(screen.getByText('ایجاد')).toBeInTheDocument();
    expect(screen.getByText('ارسال برای تایید')).toBeInTheDocument();
    expect(screen.getByText('تایید')).toBeInTheDocument();
    // The actor is the platform id the contract exposes — not a display name this screen
    // would have had to look up (and could get wrong). `getAllBy...` because every row
    // carries one.
    expect(screen.getAllByTestId('production-timeline-actor')[0].textContent).toBe(
      'user-requester'
    );
    expect(screen.getByTestId('production-timeline-count').textContent).toContain('۳');
  });

  it('renders the empty state ONLY for a genuinely empty trail', async () => {
    timelineMock.mockResolvedValue(pageOf([]));

    render(<ProductionBomTimeline bomId="bom-1" />);

    expect(await screen.findByTestId('production-bom-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('production-timeline-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('production-bom-timeline-error')).not.toBeInTheDocument();
  });

  it('renders a rejected read as an error, never as the empty state', async () => {
    timelineMock.mockRejectedValue(
      new CoreApiError('Audit history is temporarily unavailable.', 503, {
        success: false,
        error: {
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        },
      })
    );

    render(<ProductionBomTimeline bomId="bom-1" />);

    const error = await screen.findByTestId('production-bom-timeline-error');
    expect(error).toBeInTheDocument();
    // The typed code's Persian sentence — which says UNAVAILABLE, not «no events».
    expect(screen.getByText('تاریخچه رویدادها موقتاً در دسترس نیست.')).toBeInTheDocument();
    expect(screen.queryByTestId('production-bom-timeline-empty')).not.toBeInTheDocument();
  });

  it('shows the refusal an act carried, the failed outcome and the changed FIELD NAMES', async () => {
    timelineMock.mockResolvedValue(
      pageOf([
        entry({ id: 'e-1', action: 'approve', success: false, reason: 'left draft too early' }),
        entry({ id: 'e-2', action: 'update', changedFields: ['title', 'comments'] }),
      ])
    );

    render(<ProductionBomTimeline bomId="bom-1" />);

    expect(await screen.findByTestId('production-timeline-reason')).toHaveTextContent(
      'left draft too early'
    );
    expect(screen.getByTestId('production-timeline-failed')).toHaveTextContent('ناموفق');
    expect(screen.getByTestId('production-timeline-changed-fields')).toHaveTextContent(
      'title، comments'
    );
  });
});

describe('ProductionBomTimeline — order, labels and pagination', () => {
  it('renders in the SERVER order and never re-sorts', async () => {
    // The contract's order is chronological; a client-side `sort` added later would fail
    // this assertion rather than silently disagreeing with the trail.
    const ordered = [
      entry({ id: 'e-1', action: 'create', createdAt: '2026-02-01T09:00:00.000Z' }),
      entry({ id: 'e-2', action: 'submit', createdAt: '2026-02-01T10:00:00.000Z' }),
      entry({ id: 'e-3', action: 'approve', createdAt: '2026-02-01T11:00:00.000Z' }),
    ];
    timelineMock.mockResolvedValue(pageOf(ordered));

    render(<ProductionBomTimeline bomId="bom-1" />);

    const rows = await screen.findAllByTestId('production-timeline-entry');
    expect(rows.map((row) => row.getAttribute('data-action'))).toEqual([
      'create',
      'submit',
      'approve',
    ]);
  });

  it('shows the RAW token for a verb no label defines', async () => {
    timelineMock.mockResolvedValue(
      pageOf([entry({ id: 'e-1', action: 'archived_by_surprise' })])
    );

    render(<ProductionBomTimeline bomId="bom-1" />);

    // The honesty test: the unknown verb appears AS IT IS, and no invented sentence may
    // stand in for it.
    expect(await screen.findByText('archived_by_surprise')).toBeInTheDocument();
    expect(screen.queryByText('رویداد دیگر')).not.toBeInTheDocument();
  });

  it('pages the timeline on its own, asking only for a page window', async () => {
    timelineMock.mockResolvedValue(pageOf([entry({ id: 'e-1' })], { total: 40, page: 1, pageSize: 20 }));

    render(<ProductionBomTimeline bomId="bom-1" />);
    expect(await screen.findByTestId('production-timeline-entry')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('production-page-next'));

    await waitFor(() => expect(timelineMock).toHaveBeenCalledTimes(2));
    // ONLY the window travels: no id, no resource, no tenant — the scope is the path plus
    // the session, so paging cannot widen what is read.
    expect(timelineMock.mock.calls[1][1]).toEqual({ page: 2, pageSize: 20 });
    expect(screen.getByTestId('production-pagination')).toBeInTheDocument();
  });
});

/**
 * The PARENT's half of the permission contract: `/admin/production/[id]` hides the section
 * without `production.bom.read`, and — the part that actually matters — issues NO timeline
 * request for a reader who may not have one. A hidden section that still fetched would be
 * a permission gate in the wrong place.
 */
describe('ProductionBomDetailView — the timeline read gate', () => {
  const BOM_ID = '11111111-1111-4111-8111-111111111111';

  function bom() {
    return {
      id: BOM_ID,
      title: 'اقلام پروژه الف',
      projectRef: '42',
      productTreeRef: '771',
      requesterUserId: 'u-1',
      approverUserId: 'u-2',
      status: 'DRAFT' as const,
      managerOpinion: null,
      comments: null,
      submittedAt: null,
      decidedAt: null,
      decidedByUserId: null,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
    };
  }

  it('hides the section and issues NO timeline read without production.bom.read', async () => {
    grant([]);
    bomMock.mockResolvedValue(bom());
    itemsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    render(<ProductionBomDetailView bomId={BOM_ID} />);

    // Without the grant the whole screen refuses — and, the decisive part, the history
    // endpoint is never asked at all: a hidden section that still fetched would put the
    // permission gate in the wrong place.
    expect(
      await screen.findByText(/production\.bom\.read/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId('production-bom-timeline')).not.toBeInTheDocument();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  it('renders the section for a reader who holds the grant', async () => {
    grant(['production.bom.read']);
    bomMock.mockResolvedValue(bom());
    itemsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    timelineMock.mockResolvedValue(pageOf([entry({ id: 'e-1', action: 'submit' })]));

    render(<ProductionBomDetailView bomId={BOM_ID} />);

    expect(await screen.findByTestId('production-bom-timeline')).toBeInTheDocument();
    await waitFor(() => expect(timelineMock).toHaveBeenCalledTimes(1));
    expect(timelineMock.mock.calls[0][1]).toEqual({
      page: 1,
      pageSize: 20,
    });
  });
});