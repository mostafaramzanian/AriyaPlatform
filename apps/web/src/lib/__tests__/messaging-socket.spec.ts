import {
  MessagingSocket,
  WS_CLOSE_UNAUTHORIZED,
  messagingSocketUrl,
  type MessagingSocketHandlers,
  type SocketStatus,
} from '../messaging-socket';
import { getAccessToken, isTokenExpired, refreshAccessToken } from '../auth-api';
import { listMessages, type Message } from '../messaging-api';

/**
 * Phase 49F-1: Internal Messaging transport client.
 *
 * These tests drive the REAL MessagingSocket against a fake `WebSocket` global.
 * Only the two collaborators that leave the process are replaced — the session
 * token source and the HTTP recovery read — so every lifecycle decision,
 * frame-routing branch and anchor update under test is production code.
 *
 * The central guarantees asserted here:
 *  - a socket is never opened with a token the server would refuse;
 *  - no frame this client writes can name a user, sender or tenant;
 *  - the socket is disposable: a gap is recovered from Postgres over HTTP,
 *    never reconstructed client-side.
 */

jest.mock('../auth-api', () => ({
  getAccessToken: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

jest.mock('../messaging-api', () => ({
  ...jest.requireActual('../messaging-api'),
  listMessages: jest.fn(),
}));

const getAccessTokenMock = getAccessToken as jest.MockedFunction<typeof getAccessToken>;
const isTokenExpiredMock = isTokenExpired as jest.MockedFunction<typeof isTokenExpired>;
const refreshAccessTokenMock = refreshAccessToken as jest.MockedFunction<typeof refreshAccessToken>;
const listMessagesMock = listMessages as jest.MockedFunction<typeof listMessages>;

/** Frames written by the client, decoded. */
interface SentFrame {
  event: string;
  data: unknown;
}

/**
 * Minimal RFC 6455 surface: exactly the members MessagingSocket touches. Kept
 * deliberately dumb — it never auto-opens, so each test decides when (and
 * whether) a handshake succeeds.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly sent: string[] = [];
  /** Set when `send` should throw, to prove a failed write is reported. */
  throwOnSend = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(frame: string): void {
    if (this.throwOnSend) throw new Error('socket write failed');
    this.sent.push(frame);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Completes the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Delivers one raw inbound frame. */
  receive(raw: unknown): void {
    this.onmessage?.({ data: raw });
  }

  /** Delivers one well-formed server event. */
  emit(event: string, data: unknown): void {
    this.receive(JSON.stringify({ event, data }));
  }

  frames(): SentFrame[] {
    return this.sent.map((frame) => JSON.parse(frame) as SentFrame);
  }
}

function latest(): FakeWebSocket {
  const instance = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!instance) throw new Error('no socket was constructed');
  return instance;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    body: 'سلام',
    createdAt: '2026-08-29T10:00:00.000Z',
    clientMessageId: null,
    sender: { id: 'u2', firstName: 'پویا', lastName: 'رستمی', avatarUrl: null, jobTitle: null },
    attachments: [],
    ...overrides,
  } as Message;
}

/** Lets queued microtasks (token refresh, recovery) settle under fake timers. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Opens a connected socket with a valid token, returning the client and handlers. */
async function connected(handlers: MessagingSocketHandlers = {}) {
  const client = new MessagingSocket(handlers);
  await client.connect();
  const socket = latest();
  socket.open();
  await flush();
  return { client, socket };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  getAccessTokenMock.mockReturnValue('valid-token');
  isTokenExpiredMock.mockReturnValue(false);
  refreshAccessTokenMock.mockResolvedValue('refreshed-token');
  listMessagesMock.mockResolvedValue({ items: [], hasMore: false });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('socket URL', () => {
  it('derives a ws:// URL for an http API origin and keeps the gateway path outside /api/v1', () => {
    const url = messagingSocketUrl('t', 'http://localhost:3001/api');

    expect(url.startsWith('ws://localhost:3001/ws/messaging?token=')).toBe(true);
    expect(url).not.toContain('/api/v1');
  });

  it('upgrades to wss:// for an https API origin', () => {
    expect(messagingSocketUrl('t', 'https://erp.example.com/api')).toBe(
      'wss://erp.example.com/ws/messaging?token=t',
    );
  });

  it('encodes the token so a crafted value cannot inject query parameters', () => {
    const url = messagingSocketUrl('a&admin=1 b', 'http://localhost:3001/api');

    expect(url).toContain('token=a%26admin%3D1%20b');
    expect(url).not.toContain('&admin=1');
  });

  it('carries no userId, senderId or tenantId in the handshake URL', () => {
    const url = messagingSocketUrl('t', 'http://localhost:3001/api');

    expect(url).not.toMatch(/userId|senderId|tenantId/i);
  });
});

describe('connect and authentication', () => {
  it('opens with the stored token when it is still valid', async () => {
    const client = new MessagingSocket();

    await client.connect();

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(latest().url).toContain('token=valid-token');
    expect(client.getStatus()).toBe('connecting');
  });

  it('refreshes an expired token BEFORE the handshake instead of spending it on a 4401', async () => {
    getAccessTokenMock.mockReturnValue('stale-token');
    isTokenExpiredMock.mockReturnValue(true);

    await new MessagingSocket().connect();

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(latest().url).toContain('token=refreshed-token');
  });

  it('refreshes when there is no stored token at all', async () => {
    getAccessTokenMock.mockReturnValue(null);

    await new MessagingSocket().connect();

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(latest().url).toContain('token=refreshed-token');
  });

  it('constructs no socket and reports closed when no session can be obtained', async () => {
    getAccessTokenMock.mockReturnValue(null);
    refreshAccessTokenMock.mockResolvedValue(null);
    const statuses: SocketStatus[] = [];

    const client = new MessagingSocket({ onStatusChange: (s) => statuses.push(s) });
    await client.connect();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.getStatus()).toBe('closed');
    expect(statuses).toEqual(['closed']);
  });

  it('reports connection.ready with the server-resolved identity', async () => {
    const onReady = jest.fn();
    const { socket } = await connected({ onReady });

    socket.emit('connection.ready', { userId: 'u1' });

    expect(onReady).toHaveBeenCalledWith({ userId: 'u1' });
  });

  it('is idempotent: a second connect while connecting or open reuses the socket', async () => {
    const client = new MessagingSocket();

    await client.connect();
    await client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    latest().open();
    await client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('emits idle → connecting → open exactly once per transition', async () => {
    const statuses: SocketStatus[] = [];
    const client = new MessagingSocket({ onStatusChange: (s) => statuses.push(s) });

    await client.connect();
    latest().open();
    latest().open();

    expect(statuses).toEqual(['connecting', 'open']);
    expect(client.getStatus()).toBe('open');
  });
});

describe('sending frames', () => {
  it('writes nothing and reports false while the socket is not open', async () => {
    const client = new MessagingSocket();
    await client.connect();

    expect(client.sendMessage({ conversationId: 'c1', body: 'سلام' })).toBe(false);
    expect(client.markRead('c1')).toBe(false);
    expect(client.setTyping('c1', true)).toBe(false);
    expect(latest().sent).toHaveLength(0);
  });

  it('sends a message frame carrying only the conversation, body and idempotency key', async () => {
    const { client, socket } = await connected();

    expect(
      client.sendMessage({ conversationId: 'c1', body: 'سلام', clientMessageId: 'k1' }),
    ).toBe(true);

    expect(socket.frames()).toEqual([
      { event: 'message.send', data: { conversationId: 'c1', body: 'سلام', clientMessageId: 'k1' } },
    ]);
  });

  it('never puts userId, senderId or tenantId in any outgoing frame', async () => {
    const { client, socket } = await connected();

    client.subscribe('c1', 'm9');
    client.sendMessage({ conversationId: 'c1', body: 'سلام', clientMessageId: 'k1' });
    client.markRead('c1');
    client.setTyping('c1', true);
    client.unsubscribe('c1');

    expect(socket.sent.join('|')).not.toMatch(/userId|senderId|tenantId/i);
  });

  it('derives typing state from the event name rather than a payload flag', async () => {
    const { client, socket } = await connected();

    client.setTyping('c1', true);
    client.setTyping('c1', false);

    expect(socket.frames().map((f) => f.event)).toEqual(['typing.start', 'typing.stop']);
    expect(socket.frames()[0].data).toEqual({ conversationId: 'c1' });
    expect(socket.frames()[1].data).toEqual({ conversationId: 'c1' });
  });

  it('reports false when the underlying write throws, so the caller can fall back to HTTP', async () => {
    const { client, socket } = await connected();
    socket.throwOnSend = true;

    expect(client.sendMessage({ conversationId: 'c1', body: 'سلام' })).toBe(false);
  });

  it('subscribes and unsubscribes with the conversation id alone', async () => {
    const { client, socket } = await connected();

    client.subscribe('c1', 'm9');
    client.unsubscribe('c1');

    expect(socket.frames()).toEqual([
      { event: 'conversation.subscribe', data: { conversationId: 'c1' } },
      { event: 'conversation.unsubscribe', data: { conversationId: 'c1' } },
    ]);
  });
});

describe('inbound frame routing', () => {
  it('routes message.created to the message handler', async () => {
    const onMessage = jest.fn();
    const { socket } = await connected({ onMessage });

    socket.emit('message.created', message({ id: 'm5' }));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'm5' }));
  });

  it('routes read, typing, presence, conversation and error events to their handlers', async () => {
    const handlers = {
      onRead: jest.fn(),
      onTyping: jest.fn(),
      onPresence: jest.fn(),
      onConversationUpdated: jest.fn(),
      onError: jest.fn(),
    };
    const { socket } = await connected(handlers);

    socket.emit('message.read', { conversationId: 'c1', userId: 'u2', lastReadAt: 'now' });
    socket.emit('typing.changed', { conversationId: 'c1', userId: 'u2', isTyping: true });
    socket.emit('presence.changed', { userId: 'u2', status: 'online' });
    socket.emit('conversation.updated', { id: 'c1' });
    socket.emit('error', { message: 'Conversation not found' });

    expect(handlers.onRead).toHaveBeenCalledWith({
      conversationId: 'c1',
      userId: 'u2',
      lastReadAt: 'now',
    });
    expect(handlers.onTyping).toHaveBeenCalledWith({
      conversationId: 'c1',
      userId: 'u2',
      isTyping: true,
    });
    expect(handlers.onPresence).toHaveBeenCalledWith({ userId: 'u2', status: 'online' });
    expect(handlers.onConversationUpdated).toHaveBeenCalledWith({ id: 'c1' });
    expect(handlers.onError).toHaveBeenCalledWith({ message: 'Conversation not found' });
  });

  it('drops malformed and non-string frames without throwing or notifying', async () => {
    const onMessage = jest.fn();
    const onError = jest.fn();
    const { socket } = await connected({ onMessage, onError });

    expect(() => {
      socket.receive('not json at all');
      socket.receive('{"event":');
      socket.receive(new ArrayBuffer(4));
      socket.receive(null);
    }).not.toThrow();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores an unknown event so a newer server cannot break an older client', async () => {
    const onMessage = jest.fn();
    const onError = jest.fn();
    const { socket } = await connected({ onMessage, onError });

    expect(() => socket.emit('message.reacted', { id: 'x' })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('tolerates a client that registered no handlers at all', async () => {
    const { socket } = await connected();

    expect(() => {
      socket.emit('connection.ready', { userId: 'u1' });
      socket.emit('message.created', message());
      socket.emit('presence.changed', { userId: 'u2', status: 'offline' });
      socket.emit('error', { message: 'x' });
    }).not.toThrow();
  });
});

describe('reconnect', () => {
  it('reconnects with exponential backoff after an unexpected close', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();

    latest().close(1006);
    expect(client.getStatus()).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);

    // First attempt waits 1s, not immediately.
    jest.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second attempt doubles to 2s.
    latest().close(1006);
    jest.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('caps the backoff so a long outage never exceeds 30s between attempts', async () => {
    const client = new MessagingSocket();
    await client.connect();

    for (let i = 0; i < 12; i += 1) {
      latest().close(1006);
      jest.advanceTimersByTime(30_000);
      await flush();
    }

    const before = FakeWebSocket.instances.length;
    latest().close(1006);
    jest.advanceTimersByTime(30_000);
    await flush();

    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('resets the backoff after a successful open, so a later drop retries quickly again', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('refreshes the token before retrying a 4401, since the same credentials could only loop', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    refreshAccessTokenMock.mockClear();

    latest().close(WS_CLOSE_UNAUTHORIZED);
    await flush();

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting when the refresh after a 4401 fails', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    refreshAccessTokenMock.mockResolvedValue(null);

    latest().close(WS_CLOSE_UNAUTHORIZED);
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toBe('closed');
  });

  it('re-subscribes to every followed conversation on reconnect', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm1');
    client.subscribe('c2', 'm2');

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    const subscribed = latest()
      .frames()
      .filter((f) => f.event === 'conversation.subscribe')
      .map((f) => (f.data as { conversationId: string }).conversationId);
    expect(subscribed.sort()).toEqual(['c1', 'c2']);
  });

  it('does not re-subscribe to a conversation that was explicitly unsubscribed', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm1');
    client.subscribe('c2', 'm2');
    client.unsubscribe('c2');

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    const subscribed = latest()
      .frames()
      .filter((f) => f.event === 'conversation.subscribe')
      .map((f) => (f.data as { conversationId: string }).conversationId);
    expect(subscribed).toEqual(['c1']);
  });

  it('schedules only one reconnect even if close fires repeatedly', async () => {
    const client = new MessagingSocket();
    await client.connect();
    const socket = latest();
    socket.open();

    socket.onclose?.({ code: 1006 });
    socket.onclose?.({ code: 1006 });
    socket.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(1000);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});


describe('offline recovery', () => {
  it('re-reads only the gap after the anchor, from the durable HTTP history', async () => {
    const onRecovered = jest.fn();
    const client = new MessagingSocket({ onRecovered });
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    listMessagesMock.mockResolvedValue({
      // API returns newest-first.
      items: [message({ id: 'm12' }), message({ id: 'm11' })],
      hasMore: false,
    });

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledWith('c1', { after: 'm10', limit: 100 });
    // Replayed oldest-first so the view can append in order.
    expect(onRecovered).toHaveBeenCalledWith('c1', [
      expect.objectContaining({ id: 'm11' }),
      expect.objectContaining({ id: 'm12' }),
    ]);
  });

  it('does not recover for a conversation with no anchor yet', async () => {
    const onRecovered = jest.fn();
    const client = new MessagingSocket({ onRecovered });
    await client.connect();
    latest().open();
    client.subscribe('c1');

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('stays silent when the gap is empty', async () => {
    const onRecovered = jest.fn();
    const client = new MessagingSocket({ onRecovered });
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('advances the anchor as live messages arrive, so the next gap starts at the last one seen', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    latest().emit('message.created', message({ id: 'm11' }));
    latest().emit('message.created', message({ id: 'm12' }));

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledWith('c1', { after: 'm12', limit: 100 });
  });

  it('ignores a live message for a conversation it is not following when seeding anchors', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    latest().emit('message.created', message({ id: 'z9', conversationId: 'c9' }));

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    expect(listMessagesMock).toHaveBeenCalledWith('c1', { after: 'm10', limit: 100 });
  });
});

describe('recovery anchor seeding', () => {
  it('seeds the anchor from page one delivered with conversation.subscribed', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1');

    latest().emit('conversation.subscribed', {
      conversationId: 'c1',
      items: [message({ id: 'm20' }), message({ id: 'm19' })],
      hasMore: false,
    });

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledWith('c1', { after: 'm20', limit: 100 });
  });

  it('leaves the anchor untouched when a subscribed page is empty', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    latest().emit('conversation.subscribed', { conversationId: 'c1', items: [], hasMore: false });

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenCalledWith('c1', { after: 'm10', limit: 100 });
  });

  it('keeps the anchor when recovery fails, so the same gap is retried next time', async () => {
    const onRecovered = jest.fn();
    const client = new MessagingSocket({ onRecovered });
    await client.connect();
    latest().open();
    client.subscribe('c1', 'm10');

    listMessagesMock.mockRejectedValueOnce(new Error('network down'));

    latest().close(1006);
    jest.advanceTimersByTime(1000);
    await flush();
    latest().open();
    await flush();

    expect(onRecovered).not.toHaveBeenCalled();

    listMessagesMock.mockResolvedValue({ items: [message({ id: 'm11' })], hasMore: false });
    latest().close(1006);
    jest.advanceTimersByTime(2000);
    await flush();
    latest().open();
    await flush();

    expect(listMessagesMock).toHaveBeenLastCalledWith('c1', { after: 'm10', limit: 100 });
    expect(onRecovered).toHaveBeenCalledWith('c1', [expect.objectContaining({ id: 'm11' })]);
  });
});


describe('dispose', () => {
  it('closes the socket, reports closed and never reconnects', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();

    client.dispose();

    expect(client.getStatus()).toBe('closed');
    expect(client.isOpen()).toBe(false);
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('cancels a reconnect already scheduled', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    latest().close(1006);

    client.dispose();
    jest.advanceTimersByTime(60_000);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('is safe to call repeatedly and while never connected', async () => {
    const client = new MessagingSocket();

    expect(() => {
      client.dispose();
      client.dispose();
    }).not.toThrow();

    await client.connect();
    latest().open();
    client.dispose();
    client.dispose();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('allows an explicit reconnect after dispose without leaking the old socket', async () => {
    const client = new MessagingSocket();
    await client.connect();
    const first = latest();
    first.open();
    client.dispose();

    await client.connect();
    latest().open();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(client.isOpen()).toBe(true);
  });

  it('drops no frames on the floor silently: writes after dispose report false', async () => {
    const client = new MessagingSocket();
    await client.connect();
    latest().open();
    client.dispose();

    expect(client.sendMessage({ conversationId: 'c1', body: 'سلام' })).toBe(false);
    expect(client.markRead('c1')).toBe(false);
  });
});


