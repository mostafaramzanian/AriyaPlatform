import { API_BASE_URL } from './constants';
import { getAccessToken, isTokenExpired, refreshAccessToken } from './auth-api';
import { listMessages, type Message, type Conversation, type PresenceEntry } from './messaging-api';

/**
 * Phase 49F: Internal Messaging WebSocket client.
 *
 * Raw `WebSocket` against `/ws/messaging`. Deliberately NOT Socket.IO: the server
 * runs `@nestjs/platform-ws`, so there is no client library to load and no extra
 * framing on top of RFC 6455.
 *
 * The socket is an OPTIMISATION, never the source of truth. Postgres is
 * authoritative and the server persists before it emits, so every gap is
 * recoverable: on reconnect this asks `listMessages({ after })` for everything
 * newer than the last message it holds. That is why a dropped frame, a failed
 * handshake or a long offline period degrades to a re-read instead of data loss.
 *
 * The token travels in the query string because the browser WebSocket API cannot
 * set an Authorization header. It is read once per connection attempt and refreshed
 * beforehand when stale, so a socket is never opened with a token the server will
 * reject.
 */

/** Server → client event names, frozen by the Phase 49F contract. */
export type ServerEvent =
  | 'connection.ready'
  | 'conversation.subscribed'
  | 'conversation.unsubscribed'
  | 'conversation.updated'
  | 'message.created'
  | 'message.read'
  | 'typing.changed'
  | 'presence.changed'
  | 'error';

export interface MessagingSocketHandlers {
  onReady?: (data: { userId: string }) => void;
  onMessage?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => void;
  onRead?: (data: { conversationId: string; userId: string; lastReadAt: string }) => void;
  onTyping?: (data: { conversationId: string; userId: string; isTyping: boolean }) => void;
  onPresence?: (data: PresenceEntry) => void;
  onError?: (data: { message: string }) => void;
  /**
   * Messages recovered from HTTP after a reconnect, oldest-first. Emitted instead
   * of silently dropping whatever arrived while the socket was down.
   */
  onRecovered?: (conversationId: string, messages: Message[]) => void;
  onStatusChange?: (status: SocketStatus) => void;
}

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed';

/** Close code the gateway uses for an unauthenticated handshake. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** Reconnect backoff: 1s doubling to 30s, so a dead server is not hammered. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Derives the socket URL from the configured API origin.
 *
 * The gateway path is NOT under the `/api/v1` global prefix (Nest does not apply
 * prefixes to WebSocket paths), so the origin is taken and the path appended.
 */
export function messagingSocketUrl(token: string, apiBase: string = API_BASE_URL): string {
  const origin = new URL(apiBase, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
  const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';

  return `${protocol}//${origin.host}/ws/messaging?token=${encodeURIComponent(token)}`;
}

/**
 * A single reconnecting messaging connection.
 *
 * Owns exactly one socket at a time. Subscriptions are remembered so a reconnect
 * can re-subscribe and recover, which is what makes the transport transparent to
 * the UI.
 */
export class MessagingSocket {
  private socket: WebSocket | null = null;
  private status: SocketStatus = 'idle';
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Explicitly closed by the caller — suppresses reconnect. */
  private disposed = false;

  /**
   * conversationId → id of the newest message this client has seen.
   *
   * The anchor is what recovery is built on: after a reconnect the client asks the
   * server for everything after it, so nothing missed while offline is lost.
   */
  private readonly anchors = new Map<string, string | null>();

  constructor(private readonly handlers: MessagingSocketHandlers = {}) {}

  getStatus(): SocketStatus {
    return this.status;
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatusChange?.(status);
  }

  /**
   * Opens the connection. Refreshes a stale token FIRST, so the handshake is not
   * spent on a token the server would close with 4401.
   */
  async connect(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (this.socket && (this.status === 'connecting' || this.status === 'open')) return;

    this.disposed = false;

    let token = getAccessToken();
    if (!token || isTokenExpired(token)) {
      token = (await refreshAccessToken()) ?? null;
    }
    if (!token) {
      // No usable session: the UI keeps working over HTTP, which is the whole
      // point of the socket being optional.
      this.setStatus('closed');
      return;
    }

    this.setStatus('connecting');
    const socket = new WebSocket(messagingSocketUrl(token));
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      // Re-subscribe and catch up on everything missed while the socket was down.
      for (const conversationId of this.anchors.keys()) {
        this.send('conversation.subscribe', { conversationId });
        void this.recover(conversationId);
      }
    };

    socket.onmessage = (event) => this.handleFrame(event.data);

    socket.onclose = (event) => {
      this.socket = null;
      this.setStatus('closed');

      // 4401 means the token was refused. Retrying with the same credentials would
      // loop, so this reconnects only after a successful refresh.
      if (this.disposed) return;

      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        void this.reconnectAfterRefresh();
        return;
      }

      this.scheduleReconnect();
    };

    // `onerror` is always followed by `onclose`, so reconnect is handled there
    // rather than in two places.
    socket.onerror = () => undefined;
  }

  /** Closes for good. No reconnect follows. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  /** True while frames can actually be written. */
  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Writes one frame. Returns false when there is no open socket, so a caller can
   * fall back to the HTTP route rather than assuming the send happened.
   */
  private send(event: string, data: unknown): boolean {
    if (!this.isOpen()) return false;

    try {
      this.socket!.send(JSON.stringify({ event, data }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts following a conversation.
   *
   * `latestMessageId` seeds the recovery anchor. Passing the newest message already
   * rendered means a later reconnect fetches exactly the gap.
   */
  subscribe(conversationId: string, latestMessageId: string | null = null): void {
    this.anchors.set(conversationId, latestMessageId);
    this.send('conversation.subscribe', { conversationId });
  }

  unsubscribe(conversationId: string): void {
    this.anchors.delete(conversationId);
    this.send('conversation.unsubscribe', { conversationId });
  }

  /**
   * Sends over the socket when possible.
   *
   * Returns false when the frame could not be written; the caller then uses
   * `sendMessage` from messaging-api, which reaches the same server-side method. The
   * two paths share `clientMessageId`, so a fallback after an ambiguous socket write
   * cannot produce a duplicate.
   */
  sendMessage(input: {
    conversationId: string;
    body: string;
    clientMessageId?: string;
    attachmentIds?: string[];
  }): boolean {
    return this.send('message.send', input);
  }

  markRead(conversationId: string): boolean {
    return this.send('message.read', { conversationId });
  }

  setTyping(conversationId: string, isTyping: boolean): boolean {
    // The event name carries the state; the server ignores any payload flag.
    return this.send(isTyping ? 'typing.start' : 'typing.stop', { conversationId });
  }

  /** Routes one inbound frame. An unparsable frame is dropped, never thrown. */
  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let frame: { event?: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    switch (frame.event as ServerEvent) {
      case 'connection.ready':
        this.handlers.onReady?.(frame.data as { userId: string });
        break;

      case 'message.created': {
        const message = frame.data as Message;
        // Advance the recovery anchor as messages arrive, so a later reconnect asks
        // only for what came after the last one actually received.
        if (this.anchors.has(message.conversationId)) {
          this.anchors.set(message.conversationId, message.id);
        }
        this.handlers.onMessage?.(message);
        break;
      }

      case 'conversation.subscribed': {
        // Page one arrives with the subscription; its newest item seeds the anchor.
        const page = frame.data as { conversationId: string; items: Message[] };
        const newest = page.items?.[0]?.id ?? null;
        if (newest) this.anchors.set(page.conversationId, newest);
        break;
      }

      case 'conversation.updated':
        this.handlers.onConversationUpdated?.(frame.data as Conversation);
        break;

      case 'message.read':
        this.handlers.onRead?.(
          frame.data as { conversationId: string; userId: string; lastReadAt: string },
        );
        break;

      case 'typing.changed':
        this.handlers.onTyping?.(
          frame.data as { conversationId: string; userId: string; isTyping: boolean },
        );
        break;

      case 'presence.changed':
        this.handlers.onPresence?.(frame.data as PresenceEntry);
        break;

      case 'error':
        this.handlers.onError?.(frame.data as { message: string });
        break;

      default:
        // Unknown events are ignored rather than treated as errors, so the server
        // can add one without breaking an older client.
        break;
    }
  }

  /**
   * Fills the gap after a reconnect by re-reading from Postgres.
   *
   * This is what makes the socket disposable: whatever was emitted while the client
   * was disconnected is still durable server-side, so it is fetched rather than
   * mourned. Without an anchor there is nothing to catch up to — the caller loads the
   * conversation normally.
   */
  private async recover(conversationId: string): Promise<void> {
    const anchor = this.anchors.get(conversationId);
    if (!anchor) return;

    try {
      const page = await listMessages(conversationId, { after: anchor, limit: 100 });
      if (page.items.length === 0) return;

      // The API returns newest-first; recovery is replayed oldest-first so the UI can
      // append in order.
      const ordered = [...page.items].reverse();
      this.anchors.set(conversationId, ordered[ordered.length - 1].id);
      this.handlers.onRecovered?.(conversationId, ordered);
    } catch {
      // A failed recovery is not fatal: the anchor is unchanged, so the next
      // reconnect tries the same gap again.
    }
  }

  /**
   * Reconnects after refreshing the token. Used for 4401 only, where retrying with
   * the same credentials could never succeed.
   */
  private async reconnectAfterRefresh(): Promise<void> {
    const token = await refreshAccessToken().catch(() => null);
    if (!token || this.disposed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;

    // Exponential backoff with a ceiling: a server that is down is retried
    // indefinitely but never flooded.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
