import {
  NOTIFICATION_MAX_PAGE_SIZE,
  UNREAD_BADGE_CAP,
  buildNotificationQuery,
  formatNotificationTime,
  formatUnreadBadge,
  getUnreadCount,
  isUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '../notifications-api';
import { coreGet, corePost } from '../core-http';

/**
 * Phase 49E: Notification Center client contract.
 *
 * The central guarantee under test is that NO function here can be made to name
 * another user or another tenant: the query builder drops anything that is not
 * `cursor`/`limit`/`state`, and none of the call signatures accept an identity.
 */

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
}));

const coreGetMock = coreGet as jest.MockedFunction<typeof coreGet>;
const corePostMock = corePost as jest.MockedFunction<typeof corePost>;

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    type: 'SYSTEM',
    title: 'اعلان آزمایشی',
    body: 'متن اعلان',
    readAt: null,
    sourceType: null,
    sourceId: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('buildNotificationQuery', () => {
  it('returns an empty string when nothing is requested', () => {
    expect(buildNotificationQuery({})).toBe('');
  });

  it('caps limit at the backend maximum', () => {
    expect(buildNotificationQuery({ limit: 5000 })).toBe(`?limit=${NOTIFICATION_MAX_PAGE_SIZE}`);
  });

  it('serializes every supported parameter', () => {
    const query = buildNotificationQuery({ cursor: 'c1', limit: 20, state: 'unread' });
    expect(query).toContain('cursor=c1');
    expect(query).toContain('limit=20');
    expect(query).toContain('state=unread');
  });

  it('never emits a userId, even if one is smuggled in', () => {
    expect(buildNotificationQuery({ userId: 'someone-else' } as never)).toBe('');
  });

  it('never emits a tenantId, even if one is smuggled in', () => {
    expect(buildNotificationQuery({ tenantId: 'other-tenant' } as never)).toBe('');
  });
});

describe('read calls', () => {
  it('lists notifications with the serialized query', async () => {
    coreGetMock.mockResolvedValue({ items: [item()], hasMore: false });

    const result = await listNotifications({ limit: 20, state: 'unread' });

    expect(coreGetMock).toHaveBeenCalledWith('/notifications?limit=20&state=unread');
    expect(result.items).toHaveLength(1);
  });

  it('requests the unread count without any parameter', async () => {
    coreGetMock.mockResolvedValue({ count: 3 });

    await expect(getUnreadCount()).resolves.toEqual({ count: 3 });
    expect(coreGetMock).toHaveBeenCalledWith('/notifications/unread-count');
  });
});

describe('write calls', () => {
  it('marks a single notification read via POST', async () => {
    corePostMock.mockResolvedValue({ id: 'n1', readAt: '2026-08-28T11:00:00.000Z' });

    await markNotificationRead('n1');

    expect(corePostMock).toHaveBeenCalledWith('/notifications/n1/read');
  });

  it('encodes the id so a crafted value cannot alter the path', async () => {
    corePostMock.mockResolvedValue({ id: 'x', readAt: '2026-08-28T11:00:00.000Z' });

    await markNotificationRead('a/../read-all');

    expect(corePostMock).toHaveBeenCalledWith('/notifications/a%2F..%2Fread-all/read');
  });

  it('marks all read via POST with no body', async () => {
    corePostMock.mockResolvedValue({ updated: 4 });

    await expect(markAllNotificationsRead()).resolves.toEqual({ updated: 4 });
    expect(corePostMock).toHaveBeenCalledWith('/notifications/read-all');
  });
});

describe('display helpers', () => {
  it('treats a null readAt as unread', () => {
    expect(isUnread(item({ readAt: null }))).toBe(true);
    expect(isUnread(item({ readAt: '2026-08-28T11:00:00.000Z' }))).toBe(false);
  });

  it('hides the badge at zero and caps large counts', () => {
    expect(formatUnreadBadge(0)).toBe('');
    expect(formatUnreadBadge(-1)).toBe('');
    expect(formatUnreadBadge(5)).toBe('5');
    expect(formatUnreadBadge(UNREAD_BADGE_CAP)).toBe(String(UNREAD_BADGE_CAP));
    expect(formatUnreadBadge(UNREAD_BADGE_CAP + 1)).toBe(`${UNREAD_BADGE_CAP}+`);
  });

  it('formats a timestamp and returns an empty string for an invalid one', () => {
    expect(formatNotificationTime('2026-08-28T10:00:00.000Z')).not.toBe('');
    expect(formatNotificationTime('not-a-date')).toBe('');
  });
});
