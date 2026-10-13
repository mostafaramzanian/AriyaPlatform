import {
  MESSAGE_MAX_PAGE_SIZE,
  UNREAD_BADGE_CAP,
  conversationTitle,
  createConversation,
  formatMessageTime,
  formatUnreadBadge,
  getAttachmentDownload,
  getConversation,
  getPresence,
  getUnreadCount,
  listConversations,
  listMessages,
  markConversationRead,
  memberDisplayName,
  newClientMessageId,
  sendMessage,
  type Conversation,
  type MessagingUser,
} from '../messaging-api';
import { coreGet, corePost } from '../core-http';

/**
 * Phase 49F: Internal Messaging client contract.
 *
 * The central guarantee under test is that NO function here can be made to name
 * another user, sender or tenant: the query serialiser drops anything that is not
 * `cursor`/`limit`/`after`, and none of the call signatures accept an identity.
 */

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
}));

const coreGetMock = coreGet as jest.MockedFunction<typeof coreGet>;
const corePostMock = corePost as jest.MockedFunction<typeof corePost>;

function member(overrides: Partial<MessagingUser> = {}): MessagingUser {
  return {
    id: 'u1',
    firstName: 'بهار',
    lastName: 'نوری',
    avatarUrl: null,
    jobTitle: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    type: 'DIRECT',
    name: null,
    createdBy: 'u1',
    lastMessageAt: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    members: [member({ id: 'u1' }), member({ id: 'u2', firstName: 'پویا', lastName: 'رستمی' })],
    lastMessage: null,
    unreadCount: 0,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('query serialization', () => {
  it('sends no query string when nothing is requested', async () => {
    coreGetMock.mockResolvedValue({ items: [], hasMore: false });

    await listConversations();

    expect(coreGetMock).toHaveBeenCalledWith('/conversations');
  });

  it('caps limit at the backend maximum', async () => {
    coreGetMock.mockResolvedValue({ items: [], hasMore: false });

    await listMessages('c1', { limit: 5000 });

    expect(coreGetMock).toHaveBeenCalledWith(
      `/conversations/c1/messages?limit=${MESSAGE_MAX_PAGE_SIZE}`,
    );
  });

  it('serializes cursor, limit and after', async () => {
    coreGetMock.mockResolvedValue({ items: [], hasMore: false });

    await listMessages('c1', { cursor: 'm9', limit: 30, after: 'm3' });

    const path = coreGetMock.mock.calls[0][0];
    expect(path).toContain('cursor=m9');
    expect(path).toContain('limit=30');
    expect(path).toContain('after=m3');
  });

  it('never emits a userId or tenantId, even if one is smuggled in', async () => {
    coreGetMock.mockResolvedValue({ items: [], hasMore: false });

    await listConversations({ userId: 'someone-else', tenantId: 'other' } as never);

    expect(coreGetMock).toHaveBeenCalledWith('/conversations');
  });
});

describe('read calls', () => {
  it('hits the literal unread-count path, not the :id route', async () => {
    coreGetMock.mockResolvedValue({ count: 3 });

    await expect(getUnreadCount()).resolves.toEqual({ count: 3 });
    expect(coreGetMock).toHaveBeenCalledWith('/conversations/unread-count');
  });

  it('hits the literal attachments path', async () => {
    coreGetMock.mockResolvedValue({ url: 'u', fileName: 'f', mimeType: 'application/pdf' });

    await getAttachmentDownload('a1');

    expect(coreGetMock).toHaveBeenCalledWith('/conversations/attachments/a1');
  });

  it.each([
    ['getConversation', () => getConversation('a/../unread-count'), '/conversations/a%2F..%2Funread-count'],
    ['getPresence', () => getPresence('a/../x'), '/conversations/a%2F..%2Fx/presence'],
  ])('encodes the id in %s so a crafted value cannot alter the path', async (_label, call, expected) => {
    coreGetMock.mockResolvedValue({} as never);

    await call();

    expect(coreGetMock).toHaveBeenCalledWith(expected);
  });
});

describe('write calls', () => {
  it('creates a conversation with only type, participants and name', async () => {
    corePostMock.mockResolvedValue(conversation());

    await createConversation({ type: 'GROUP', participantIds: ['u2'], name: 'گروه' });

    expect(corePostMock).toHaveBeenCalledWith('/conversations', {
      type: 'GROUP',
      participantIds: ['u2'],
      name: 'گروه',
    });
  });

  it('sends a message with the idempotency key and no identity', async () => {
    corePostMock.mockResolvedValue({} as never);

    await sendMessage('c1', { body: 'سلام', clientMessageId: 'k1' });

    expect(corePostMock).toHaveBeenCalledWith('/conversations/c1/messages', {
      body: 'سلام',
      clientMessageId: 'k1',
    });
  });

  it('marks a conversation read via POST with no body', async () => {
    corePostMock.mockResolvedValue({ conversationId: 'c1', lastReadAt: 'x' });

    await markConversationRead('c1');

    expect(corePostMock).toHaveBeenCalledWith('/conversations/c1/read');
  });
});

describe('display helpers', () => {
  it('names a DIRECT conversation after the other participant', () => {
    expect(conversationTitle(conversation(), 'u1')).toBe('پویا رستمی');
  });

  it('uses the stored name for a GROUP', () => {
    expect(conversationTitle(conversation({ type: 'GROUP', name: 'گروه پروژه' }), 'u1')).toBe(
      'گروه پروژه',
    );
  });

  it('falls back to a neutral label rather than exposing an identifier', () => {
    expect(memberDisplayName(member({ firstName: null, lastName: null }))).toBe('کاربر');
  });

  it('hides the badge at zero and caps large counts', () => {
    expect(formatUnreadBadge(0)).toBe('');
    expect(formatUnreadBadge(-1)).toBe('');
    expect(formatUnreadBadge(5)).toBe('5');
    expect(formatUnreadBadge(UNREAD_BADGE_CAP)).toBe(String(UNREAD_BADGE_CAP));
    expect(formatUnreadBadge(UNREAD_BADGE_CAP + 1)).toBe(`${UNREAD_BADGE_CAP}+`);
  });

  it('formats a timestamp and returns an empty string for an invalid one', () => {
    expect(formatMessageTime('2026-08-28T10:00:00.000Z')).not.toBe('');
    expect(formatMessageTime('not-a-date')).toBe('');
  });

  it('generates distinct client message ids', () => {
    expect(newClientMessageId()).not.toBe(newClientMessageId());
  });
});
