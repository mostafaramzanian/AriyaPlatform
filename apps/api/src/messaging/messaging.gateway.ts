import { HttpException, Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { PrismaService } from '../database/prisma.service';
import { TokenVerifier } from '../platform/auth/token-verifier';
import { MessagingService } from './messaging.service';
import { CONNECTION_REGISTRY, ConnectionRegistryPort } from './connection-registry';
import { WsConversationRefDto, WsSendMessageDto } from './dto/conversation.dto';
import { WsTypingDto } from './dto/ws-typing.dto';

/**
 * Phase 49F: raw-`ws` messaging gateway.
 *
 * Transport only. It authenticates the socket, translates frames into calls on
 * MessagingService, and hands fan-out to ConnectionRegistry. It contains no
 * authorization logic of its own — membership and tenant checks live in the
 * service, so the HTTP and WebSocket paths cannot drift apart.
 *
 * Uses `ws` via @nestjs/platform-ws. Deliberately NOT Socket.IO: no fallback
 * transports, no room abstraction, no extra protocol layered on WebSocket.
 *
 * Authentication happens at handshake time from `?token=`, because the browser
 * WebSocket API cannot set an Authorization header. The token is verified by the
 * platform `TokenVerifier` — the same class the HTTP guard chain uses — so this
 * process has ONE definition of an acceptable token rather than a second, weaker
 * copy. For a legacy (shared-secret) token `tokenVersion` is still re-checked
 * against the database, so a revoked token cannot hold a socket open even though no
 * HTTP request is involved; for an asymmetric token the verified `tid`/`ver` claims
 * are the authority and no database is consulted.
 */

/** Close code for an unauthenticated or unauthorizable handshake. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** In-gateway send throttle: 30 messages per 10 seconds, per connection. */
export const WS_SEND_LIMIT = 30;
export const WS_SEND_WINDOW_MS = 10_000;

interface SocketState {
  connectionId: string;
  userId: string;
  tenantId: string | null;
  /** Timestamps of recent sends, for the sliding-window throttle. */
  sendTimestamps: number[];
}

@WebSocketGateway({ path: '/ws/messaging' })
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagingGateway.name);

  /**
   * Per-socket state, keyed by the socket itself. A WeakMap means a closed
   * socket's state becomes collectable without an explicit cleanup step.
   */
  private readonly state = new WeakMap<WebSocket, SocketState>();

  constructor(
    private readonly messaging: MessagingService,
    /**
     * Phase 51-HR-ARCH-3A: the SAME verifier the HTTP path uses. This gateway used to
     * verify tokens itself with `JwtService` and its own copy of the secret, audience and
     * issuer — a second verification path that the migration to asymmetric keys would have
     * left behind as an unpinned HMAC verifier. It now delegates, so there is exactly one
     * answer in this process to "what is an acceptable token?".
     */
    private readonly tokenVerifier: TokenVerifier,
    private readonly prisma: PrismaService,
    @Inject(CONNECTION_REGISTRY) private readonly registry: ConnectionRegistryPort,
  ) {}

  /**
   * Token comes from the query string because the browser WebSocket API cannot set
   * headers. It is read from the URL only — never from a frame — so an already-open
   * socket cannot re-authenticate as someone else.
   */
  private extractToken(request: IncomingMessage): string | null {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');
      return token && token.trim().length > 0 ? token.trim() : null;
    } catch {
      return null;
    }
  }

  private reject(client: WebSocket, reason: string): void {
    try {
      this.emit(client, 'error', { message: reason });
      client.close(WS_CLOSE_UNAUTHORIZED, reason);
    } catch {
      // The socket may already be gone; nothing to do.
    }
  }

  /**
   * Authenticates the handshake and registers the connection.
   *
   * Anything unverifiable closes the socket with 4401 rather than leaving it open
   * in an anonymous state — an unauthenticated socket is never usable, so there is
   * no reason to keep it around.
   */
  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const token = this.extractToken(request);

      if (!token) {
        this.reject(client, 'Authentication token is required');
        return;
      }

      const claims = await this.tokenVerifier.verify(token);

      // Asymmetric trust: the verified claims are the authority, so the handshake performs
      // NO Core read — the same rule the HTTP path applies, from the same verifier. `tid`
      // comes from the token, which is what makes this gateway usable by a runtime whose
      // tenant is not in a database it can reach.
      if (claims.trust === 'asymmetric') {
        await this.accept(client, claims.sub, claims.tid);
        return;
      }

      // Legacy bridge: re-read the user so a deleted, suspended or re-versioned account
      // cannot keep a socket. Mirrors JwtStrategy.validate exactly.
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, tenantId: true, tokenVersion: true, status: true },
      });

      if (!user || user.tokenVersion !== claims.ver) {
        this.reject(client, 'Token is no longer valid');
        return;
      }

      await this.accept(client, user.id, user.tenantId);
    } catch (err) {
      this.logger.debug({ err }, 'Rejected messaging socket handshake');
      this.reject(client, 'Authentication failed');
    }
  }

  /**
   * Registers the connection and announces readiness — for BOTH trust levels.
   *
   * Shared deliberately: the ordering (register, then announce) is the part that matters, and
   * having one copy means a future change cannot apply it to one trust level only.
   */
  private async accept(
    client: WebSocket,
    userId: string,
    tenantId: string | null,
  ): Promise<void> {
    const connectionId = randomUUID();
    this.state.set(client, { connectionId, userId, tenantId, sendTimestamps: [] });

    this.registry.register(userId, connectionId, {
      send: (frame: string) => client.send(frame),
      isOpen: () => client.readyState === WebSocket.OPEN,
    });

    this.emit(client, 'connection.ready', { userId });

    // Presence is announced only after the socket is registered, so a listener that reacts
    // by sending immediately finds a live connection.
    await this.messaging.announcePresence(userId, 'online');
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const state = this.state.get(client);
    if (!state) return;

    this.state.delete(client);
    this.registry.unregister(state.userId, state.connectionId);

    // Only announce offline once the user's LAST socket is gone: closing one tab
    // must not make someone look offline in another.
    if (!this.registry.isOnline(state.userId)) {
      await this.messaging.announcePresence(state.userId, 'offline').catch(() => undefined);
    }
  }

  private emit(client: WebSocket, event: string, data: unknown): void {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify({ event, data }));
    } catch (err) {
      this.logger.debug({ err, event }, 'Failed writing messaging frame');
    }
  }

  /**
   * Resolves the identity of an already-authenticated socket.
   *
   * Returns null for a socket with no state, which can only happen if a frame
   * arrives after the handshake was rejected. Such frames are dropped rather than
   * treated as anonymous — there is no anonymous mode.
   */
  private requireState(client: WebSocket): SocketState | null {
    const state = this.state.get(client);
    if (!state) {
      this.reject(client, 'Socket is not authenticated');
      return null;
    }
    return state;
  }

  /**
   * Sliding-window send throttle, per connection.
   *
   * Applies only to `message.send` — reads and typing are cheap, but a send writes
   * to Postgres and fans out to every member, so it is the one path worth bounding.
   * This is the gateway's own limit and is independent of the HTTP RateLimitGuard,
   * which never sees socket frames.
   */
  private withinSendBudget(state: SocketState): boolean {
    const now = Date.now();
    state.sendTimestamps = state.sendTimestamps.filter((ts) => now - ts < WS_SEND_WINDOW_MS);

    if (state.sendTimestamps.length >= WS_SEND_LIMIT) return false;

    state.sendTimestamps.push(now);
    return true;
  }

  /**
   * Coerces one inbound payload into a validated DTO.
   *
   * Frames arrive as untyped JSON, so every payload goes through class-validator
   * with the same `whitelist`/`forbidNonWhitelisted` posture as the global HTTP
   * ValidationPipe. A malformed frame produces an `error` event and is dropped —
   * it never reaches the service and never closes the socket, because one bad
   * frame is not grounds for tearing down a working connection.
   */
  private async parse<T extends object>(
    client: WebSocket,
    cls: new () => T,
    payload: unknown,
  ): Promise<T | null> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.emit(client, 'error', { message: 'Malformed payload' });
      return null;
    }

    const instance = plainToInstance(cls, payload, { enableImplicitConversion: true });
    const errors = await validate(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });

    if (errors.length > 0) {
      this.emit(client, 'error', {
        message: 'Validation failed',
        details: errors.map((error) => ({ property: error.property, constraints: error.constraints })),
      });
      return null;
    }

    return instance;
  }

  /**
   * Runs a service call for a socket, translating a thrown domain error into an
   * `error` event.
   *
   * The message is taken from the exception the service already threw, so an
   * unauthorized subscribe or send reports exactly what the HTTP route would —
   * the socket is not a second, looser interface.
   */
  private async guard(client: WebSocket, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      const message =
        err instanceof HttpException
          ? ((err.getResponse() as { message?: string })?.message ?? err.message)
          : 'Request failed';
      this.emit(client, 'error', { message });
    }
  }

  /**
   * Confirms the caller may see a conversation.
   *
   * There is no server-side room to join: fan-out is by user id, and the service
   * re-checks membership on every read and write. So this event is an explicit
   * authorization probe — the client learns immediately whether it is allowed,
   * rather than discovering it on the first send. An unauthorized id yields an
   * `error` event and no subscription.
   */
  @SubscribeMessage('conversation.subscribe')
  async onSubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const state = this.requireState(client);
    if (!state) return;

    const dto = await this.parse(client, WsConversationRefDto, payload);
    if (!dto) return;

    await this.guard(client, async () => {
      // Reading page 1 both proves membership and gives the client something
      // useful, so authorization and the initial load are a single round trip.
      const page = await this.messaging.listMessages(
        state.userId,
        dto.conversationId,
        {},
        state.tenantId,
      );

      this.emit(client, 'conversation.subscribed', {
        conversationId: dto.conversationId,
        ...page,
      });
    });
  }

  /**
   * Acknowledges that the client has stopped viewing a conversation.
   *
   * Fan-out is by user id, not by room, so there is nothing server-side to tear
   * down — every member keeps receiving events for every conversation they belong
   * to regardless of what they are looking at. The event exists so the contract is
   * symmetric and the client can mark its own view state; the acknowledgement is
   * deliberately honest about that rather than implying delivery has stopped.
   *
   * Membership is NOT checked: refusing to unsubscribe from a conversation you
   * cannot see would confirm the id exists.
   */
  @SubscribeMessage('conversation.unsubscribe')
  async onUnsubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const state = this.requireState(client);
    if (!state) return;

    const dto = await this.parse(client, WsConversationRefDto, payload);
    if (!dto) return;

    this.emit(client, 'conversation.unsubscribed', { conversationId: dto.conversationId });
  }

  /**
   * Sends a message over the socket.
   *
   * Delegates to the same MessagingService.sendMessage the HTTP route uses, so
   * validation, membership, idempotency and fan-out are identical. The sender is
   * taken from the socket's authenticated state, never from the payload.
   *
   * The sender's own copy arrives through normal fan-out (they are a member), so
   * there is no separate echo that could disagree with what everyone else receives.
   */
  @SubscribeMessage('message.send')
  async onSendMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const state = this.requireState(client);
    if (!state) return;

    const dto = await this.parse(client, WsSendMessageDto, payload);
    if (!dto) return;

    if (!this.withinSendBudget(state)) {
      this.emit(client, 'error', {
        message: `Rate limit exceeded: at most ${WS_SEND_LIMIT} messages per ${WS_SEND_WINDOW_MS / 1000} seconds`,
      });
      return;
    }

    await this.guard(client, async () => {
      const { conversationId, ...rest } = dto;
      await this.messaging.sendMessage(state.userId, conversationId, rest, state.tenantId);
    });
  }

  /**
   * Advances the caller's read cursor. Idempotent and monotonic in the service.
   *
   * Named `message.read` to match the frozen contract. The server→client
   * acknowledgement uses the same name in the opposite direction; the two never
   * collide because a client never receives its own inbound event names.
   */
  @SubscribeMessage('message.read')
  async onMarkRead(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const state = this.requireState(client);
    if (!state) return;

    const dto = await this.parse(client, WsConversationRefDto, payload);
    if (!dto) return;

    await this.guard(client, async () => {
      await this.messaging.markRead(state.userId, dto.conversationId, state.tenantId);
    });
  }

  @SubscribeMessage('typing.start')
  async onTypingStart(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    await this.relayTyping(client, payload, true);
  }

  @SubscribeMessage('typing.stop')
  async onTypingStop(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    await this.relayTyping(client, payload, false);
  }

  /**
   * Shared typing path. The state comes from the EVENT NAME, not the payload, so a
   * `typing.stop` carrying `isTyping: true` still stops — the two cannot contradict
   * each other.
   */
  private async relayTyping(client: WebSocket, payload: unknown, isTyping: boolean): Promise<void> {
    const state = this.requireState(client);
    if (!state) return;

    const dto = await this.parse(client, WsTypingDto, payload);
    if (!dto) return;

    await this.guard(client, async () => {
      await this.messaging.relayTyping(state.userId, dto.conversationId, isTyping, state.tenantId);
    });
  }
}
