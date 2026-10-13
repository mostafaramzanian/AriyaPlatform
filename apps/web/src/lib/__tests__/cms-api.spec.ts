import {
  BLOG_STATUSES,
  BlogStatus,
  CmsApiError,
  canArchive,
  canPublish,
  canSchedule,
  canSendToReview,
  isValidBlogTransition,
  listAdminPosts,
  listTrashedPosts,
} from '../cms-api';
import { API_ENDPOINT } from '../constants';
import { authenticatedFetch } from '../auth-api';

jest.mock('../auth-api', () => ({
  authenticatedFetch: jest.fn(),
}));

const authenticatedFetchMock = authenticatedFetch as jest.MockedFunction<typeof authenticatedFetch>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function requestedUrl(callIndex = 0): string {
  return String(authenticatedFetchMock.mock.calls[callIndex][0]);
}

/**
 * These helpers are a client-side mirror of BlogService.isValidTransition()
 * (apps/api/src/modules/cms/blog/blog.service.ts). The matrix below is the
 * backend's own rule set, so any drift between the two fails here.
 */
const ALLOWED: ReadonlyArray<readonly [BlogStatus, BlogStatus]> = [
  ['DRAFT', 'REVIEW'],
  ['REVIEW', 'SCHEDULED'],
  ['REVIEW', 'PUBLISHED'],
  ['SCHEDULED', 'PUBLISHED'],
  ['PUBLISHED', 'ARCHIVED'],
];

function isAllowed(from: BlogStatus, to: BlogStatus): boolean {
  if (from === to) return true;
  return ALLOWED.some(([f, t]) => f === from && t === to);
}

describe('isValidBlogTransition', () => {
  it('allows only DRAFT as the initial status', () => {
    expect(isValidBlogTransition(null, 'DRAFT')).toBe(true);
    expect(isValidBlogTransition(undefined, 'DRAFT')).toBe(true);
    expect(isValidBlogTransition('', 'DRAFT')).toBe(true);
    for (const to of BLOG_STATUSES.filter((s) => s !== 'DRAFT')) {
      expect(isValidBlogTransition(null, to)).toBe(false);
    }
  });

  it('matches the backend matrix for every status pair', () => {
    for (const from of BLOG_STATUSES) {
      for (const to of BLOG_STATUSES) {
        expect([from, to, isValidBlogTransition(from, to)]).toEqual([from, to, isAllowed(from, to)]);
      }
    }
  });

  it('treats a same-status transition as a valid no-op', () => {
    for (const status of BLOG_STATUSES) {
      expect(isValidBlogTransition(status, status)).toBe(true);
    }
  });

  it('rejects the shortcuts the API answers with 400', () => {
    expect(isValidBlogTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(isValidBlogTransition('DRAFT', 'SCHEDULED')).toBe(false);
    expect(isValidBlogTransition('DRAFT', 'ARCHIVED')).toBe(false);
    expect(isValidBlogTransition('REVIEW', 'ARCHIVED')).toBe(false);
    expect(isValidBlogTransition('SCHEDULED', 'ARCHIVED')).toBe(false);
  });

  it('never allows moving backwards or out of ARCHIVED', () => {
    expect(isValidBlogTransition('REVIEW', 'DRAFT')).toBe(false);
    expect(isValidBlogTransition('SCHEDULED', 'REVIEW')).toBe(false);
    expect(isValidBlogTransition('PUBLISHED', 'SCHEDULED')).toBe(false);
    expect(isValidBlogTransition('ARCHIVED', 'DRAFT')).toBe(false);
    expect(isValidBlogTransition('ARCHIVED', 'PUBLISHED')).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(isValidBlogTransition('UNKNOWN', 'PUBLISHED')).toBe(false);
    expect(isValidBlogTransition('DRAFT', 'UNKNOWN')).toBe(false);
  });
});

describe('workflow action guards', () => {
  const cases: ReadonlyArray<{
    status: BlogStatus;
    publish: boolean;
    schedule: boolean;
    archive: boolean;
    review: boolean;
  }> = [
    { status: 'DRAFT', publish: false, schedule: false, archive: false, review: true },
    { status: 'REVIEW', publish: true, schedule: true, archive: false, review: false },
    { status: 'SCHEDULED', publish: true, schedule: true, archive: false, review: false },
    { status: 'PUBLISHED', publish: false, schedule: false, archive: true, review: false },
    { status: 'ARCHIVED', publish: false, schedule: false, archive: false, review: false },
  ];

  it.each(cases)('gates actions correctly for $status', ({ status, publish, schedule, archive, review }) => {
    expect(canPublish(status)).toBe(publish);
    expect(canSchedule(status)).toBe(schedule);
    expect(canArchive(status)).toBe(archive);
    expect(canSendToReview(status)).toBe(review);
  });

  it('offers no action for a missing status', () => {
    for (const status of [null, undefined, '']) {
      expect(canPublish(status)).toBe(false);
      expect(canSchedule(status)).toBe(false);
      expect(canArchive(status)).toBe(false);
      expect(canSendToReview(status)).toBe(false);
    }
  });

  it('only exposes publish/schedule where the transition itself is valid', () => {
    for (const status of BLOG_STATUSES) {
      if (canPublish(status)) expect(isValidBlogTransition(status, 'PUBLISHED')).toBe(true);
      if (canSchedule(status)) expect(isValidBlogTransition(status, 'SCHEDULED')).toBe(true);
      if (canArchive(status)) expect(isValidBlogTransition(status, 'ARCHIVED')).toBe(true);
      if (canSendToReview(status)) expect(isValidBlogTransition(status, 'REVIEW')).toBe(true);
    }
  });
});

/**
 * Phase 34H: GET /blog/admin/trash is the only listing that returns rows with
 * `deletedAt != null` (archived and soft-deleted posts), so it is what makes
 * POST /blog/:id/restore reachable after a page reload.
 */
describe('listTrashedPosts', () => {
  const emptyResult = { items: [], hasMore: false };

  beforeEach(() => {
    authenticatedFetchMock.mockReset();
  });

  it('calls GET /blog/admin/trash with the default limit and no status param', async () => {
    authenticatedFetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: emptyResult }),
    );

    await listTrashedPosts();

    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl();
    expect(url).toBe(`${API_ENDPOINT}/blog/admin/trash?limit=20`);
    // A soft-deleted post keeps its original status, so the endpoint takes no
    // status filter — passing one would hide deleted drafts.
    expect(url).not.toContain('status=');
  });

  it('forwards cursor and limit', async () => {
    authenticatedFetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: emptyResult }),
    );

    await listTrashedPosts({ cursor: 'post-1', limit: 5 });

    const query = new URL(requestedUrl()).searchParams;
    expect(query.get('cursor')).toBe('post-1');
    expect(query.get('limit')).toBe('5');
  });

  it('omits an empty cursor instead of sending a blank value', async () => {
    authenticatedFetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: emptyResult }),
    );

    await listTrashedPosts({ cursor: '' });

    expect(new URL(requestedUrl()).searchParams.has('cursor')).toBe(false);
  });

  it('unwraps the success envelope', async () => {
    const result = {
      items: [
        {
          id: 'post-1',
          title: 'مطلب بایگانی‌شده',
          slug: 'archived-post',
          excerpt: null,
          publishedAt: null,
          status: 'ARCHIVED',
          readingTimeMin: 2,
          featuredImageId: null,
          authorId: 'user-1',
        },
      ],
      hasMore: true,
    };
    authenticatedFetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: result }));

    await expect(listTrashedPosts()).resolves.toEqual(result);
  });

  it.each([
    [401, 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.'],
    [403, 'شما اجازه دسترسی به این بخش را ندارید.'],
    [500, 'خطای سرور. لطفاً بعداً دوباره تلاش کنید.'],
  ])('maps a bare %s response to a CmsApiError', async (status, message) => {
    authenticatedFetchMock.mockResolvedValue(jsonResponse(status as number, {}));

    await expect(listTrashedPosts()).rejects.toMatchObject({
      status,
      message,
    });
  });

  it('preserves the backend error code and message when present', async () => {
    authenticatedFetchMock.mockResolvedValue(
      jsonResponse(403, {
        success: false,
        error: { code: 'FORBIDDEN', message: 'دسترسی blog.write لازم است.' },
      }),
    );

    await expect(listTrashedPosts()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'دسترسی blog.write لازم است.',
    });
  });

  it('maps a missing local token to a 401 rather than a network error', async () => {
    authenticatedFetchMock.mockRejectedValue(new Error('Unauthorized'));

    await expect(listTrashedPosts()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('maps a transport failure to a network error', async () => {
    authenticatedFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(listTrashedPosts()).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('rejects a 200 response without a data envelope', async () => {
    authenticatedFetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    await expect(listTrashedPosts()).rejects.toBeInstanceOf(CmsApiError);
  });

  // Guard against regressions: the active admin listing must keep using the
  // status-based route, which never returns soft-deleted rows.
  it('does not change the active admin listing route', async () => {
    authenticatedFetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: emptyResult }),
    );

    await listAdminPosts({ status: 'ARCHIVED' });

    expect(requestedUrl()).toBe(`${API_ENDPOINT}/blog/admin?status=ARCHIVED&limit=20`);
  });
});
