import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreSurveysView } from '../CoreSurveysView';
import { CoreApiError } from '@/lib/core-http';
import { fetchMyRbac } from '@/lib/rbac-api';
import { listSurveys, type Survey } from '@/lib/surveys-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/surveys',
}));

jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Every pure helper (labels, formatting) stays real.
jest.mock('@/lib/surveys-api', () => ({
  ...jest.requireActual('@/lib/surveys-api'),
  listSurveys: jest.fn(),
}));

const listMock = listSurveys as jest.MockedFunction<typeof listSurveys>;
const rbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;

const MANAGE = 'admin.surveys.manage';
const RESULTS = 'admin.surveys.results';

/** `GET /rbac` reply carrying exactly the given permission strings. */
function rbac(permissions: string[]) {
  return { userId: 'u1', roles: [], permissions, highestRole: null };
}

function author(id: string) {
  return { id, firstName: 'بهار', lastName: 'نوری', avatarUrl: null, jobTitle: null };
}

function survey(overrides: Partial<Survey> = {}): Survey {
  return {
    id: 's1',
    title: 'نظرسنجی رضایت',
    description: null,
    status: 'PUBLISHED',
    isAnonymous: false,
    startsAt: null,
    endsAt: null,
    publishedAt: '2026-08-29T10:00:00.000Z',
    closedAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    createdBy: author('u1'),
    questionCount: 3,
    canManage: false,
    canViewResults: false,
    canRespond: true,
    hasResponded: false,
    availableTransitions: [],
    ...overrides,
  };
}

describe('CoreSurveysView', () => {
  beforeEach(() => {
    // Default: a participant with no survey permissions at all.
    rbacMock.mockResolvedValue(rbac([]));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state before the first page resolves', () => {
    listMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreSurveysView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری نظرسنجی‌ها...')).toBeInTheDocument();
  });

  it('requests the first page with the default scope, default limit and no status', async () => {
    listMock.mockResolvedValue({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    // `status` is omitted entirely rather than sent as 'all' — the DTO runs under
    // forbidNonWhitelisted and 'all' is not a member of the status enum.
    expect(listMock).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 20,
      scope: 'available',
    });
  });

  /**
   * The backend derives both the actor and the tenant from the authenticated identity.
   * Sending either would be rejected outright, so the client must be structurally
   * incapable of asking on someone else's behalf.
   */
  it('never sends a creator, user or tenant identifier', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreSurveysView />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const args = listMock.mock.calls[0][0] ?? {};
    expect(args).not.toHaveProperty('createdById');
    expect(args).not.toHaveProperty('userId');
    expect(args).not.toHaveProperty('tenantId');
  });

  it('renders the survey row with its status, author and question count', async () => {
    listMock.mockResolvedValue({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);

    expect(await screen.findByText('نظرسنجی رضایت')).toBeInTheDocument();
    expect(screen.getByTestId('survey-status')).toHaveTextContent('منتشرشده');
    expect(screen.getByText('بهار نوری')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /نظرسنجی رضایت/ })).toHaveAttribute(
      'href',
      '/admin/surveys/s1',
    );
  });

  it('marks a survey the caller has already answered', async () => {
    listMock.mockResolvedValue({
      items: [survey({ hasResponded: true, canRespond: false })],
      hasMore: false,
    });

    render(<CoreSurveysView />);

    expect(await screen.findByTestId('survey-responded')).toHaveTextContent('پاسخ داده‌اید');
  });

  it('renders an empty state rather than placeholder rows', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreSurveysView />);

    expect(await screen.findByText('نظرسنجی‌ای برای نمایش وجود ندارد.')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-list')).not.toBeInTheDocument();
  });

  /**
   * Authoring affordance. Two independent signals may reveal it: `canManage` on a listed
   * row (the server's own per-survey verdict) or the `admin.surveys.manage` grant from
   * `/rbac`. Neither is authorization — `POST /surveys` enforces the permission itself.
   */
  it('hides the create link from a caller with neither signal', async () => {
    listMock.mockResolvedValue({ items: [survey({ canManage: false })], hasMore: false });

    render(<CoreSurveysView />);

    await screen.findByTestId('survey-list');
    await waitFor(() => expect(rbacMock).toHaveBeenCalled());
    expect(screen.queryByTestId('survey-create-link')).not.toBeInTheDocument();
  });

  it('shows the create link once the server marks any survey manageable', async () => {
    listMock.mockResolvedValue({ items: [survey({ canManage: true })], hasMore: false });

    render(<CoreSurveysView />);

    expect(await screen.findByTestId('survey-create-link')).toHaveAttribute(
      'href',
      '/admin/surveys/new',
    );
  });

  /**
   * The fallback matters for the bootstrap case: a manager whose tenant has no surveys
   * yet sees an empty list, so there is no `canManage` row to derive the link from.
   */
  it('shows the create link to a manager whose list is empty', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });
    rbacMock.mockResolvedValue(rbac([MANAGE]));

    render(<CoreSurveysView />);

    expect(await screen.findByTestId('survey-create-link')).toBeInTheDocument();
  });

  /**
   * `admin.surveys.results` is a SEPARATE permission from `admin.surveys.manage`.
   * Holding results alone grants reading aggregates, never authoring.
   */
  it('does not offer authoring to a caller who may only read results', async () => {
    listMock.mockResolvedValue({
      items: [survey({ canManage: false, canViewResults: true })],
      hasMore: false,
    });
    rbacMock.mockResolvedValue(rbac([RESULTS]));

    render(<CoreSurveysView />);

    await screen.findByTestId('survey-list');
    await waitFor(() => expect(rbacMock).toHaveBeenCalled());
    expect(screen.queryByTestId('survey-create-link')).not.toBeInTheDocument();
  });

  /** A failed `/rbac` read must degrade to "no permissions", never fall open. */
  it('hides the create link when the permission read fails', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });
    rbacMock.mockRejectedValue(new CoreApiError('boom', 500));

    render(<CoreSurveysView />);

    await waitFor(() => expect(rbacMock).toHaveBeenCalled());
    expect(screen.queryByTestId('survey-create-link')).not.toBeInTheDocument();
  });

  it('renders a forbidden state on 403 instead of an error with retry', async () => {
    listMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreSurveysView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('renders an error state with retry on a server failure', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    listMock.mockResolvedValueOnce({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByText('نظرسنجی رضایت')).toBeInTheDocument();
  });

  it('re-requests with the status filter and drops the cursor stack', async () => {
    listMock.mockResolvedValue({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(screen.getByLabelText('وضعیت'), 'DRAFT');

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 20,
        scope: 'available',
        status: 'DRAFT',
      }),
    );
  });

  /**
   * A non-manager who selects `scope=all` is silently narrowed back to `available`
   * by the backend. The client still sends the choice verbatim — it does not
   * pre-filter, because deciding visibility client-side would be a second, weaker
   * authority.
   */
  it('sends the chosen scope verbatim', async () => {
    listMock.mockResolvedValue({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(screen.getByLabelText('نمایش'), 'all');

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 20,
        scope: 'all',
      }),
    );
  });

  /** Cursor pagination: the next cursor is the last row's id, never an offset. */
  it('pages forward using the last row id as the cursor', async () => {
    listMock.mockResolvedValueOnce({
      items: [survey({ id: 's1' }), survey({ id: 's2', title: 'نظرسنجی دوم' })],
      hasMore: true,
    });
    listMock.mockResolvedValueOnce({
      items: [survey({ id: 's3', title: 'نظرسنجی سوم' })],
      hasMore: false,
    });

    render(<CoreSurveysView />);
    await screen.findByText('نظرسنجی دوم');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: 's2',
        limit: 20,
        scope: 'available',
      }),
    );
    expect(await screen.findByText('نظرسنجی سوم')).toBeInTheDocument();
  });

  it('pages back by popping the cursor stack rather than re-deriving a cursor', async () => {
    listMock.mockResolvedValueOnce({ items: [survey({ id: 's1' })], hasMore: true });
    listMock.mockResolvedValueOnce({
      items: [survey({ id: 's2', title: 'نظرسنجی دوم' })],
      hasMore: false,
    });
    listMock.mockResolvedValueOnce({ items: [survey({ id: 's1' })], hasMore: true });

    render(<CoreSurveysView />);
    await screen.findByText('نظرسنجی رضایت');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));
    await screen.findByText('نظرسنجی دوم');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه قبل' }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 20,
        scope: 'available',
      }),
    );
  });

  it('disables forward paging when the server reports no further page', async () => {
    listMock.mockResolvedValue({ items: [survey()], hasMore: false });

    render(<CoreSurveysView />);
    await screen.findByTestId('survey-list');

    // With a single page and no more rows the pager is not rendered at all.
    expect(screen.queryByRole('navigation', { name: 'صفحه‌بندی' })).not.toBeInTheDocument();
  });
});
