import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { PrismaService } from '../database/prisma.service';
import { MessagingService } from './messaging.service';
import {
  MessagingGateway,
  WS_CLOSE_UNAUTHORIZED,
  WS_SEND_LIMIT,
  WS_SEND_WINDOW_MS,
} from './messaging.gateway';
import { type ConnectionRegistryPort } from './connection-registry';
import { TokenVerifier } from '../platform/auth/token-verifier';
import {
  TokenRejectedError,
  type TokenRejectionReason,
  type TrustedTokenClaims,
} from '../platform/auth/token-contract';

/**
 * Phase 49F unit coverage for the messaging WebSocket gateway.
 *
 * The gateway is transport only, so what is asserted here is exactly that: how a
 * handshake is authenticated, how a frame is validated, which identity is used for
 * the service call, and what is written back. Membership and tenant rules live in
 * MessagingService and are proven against a real database in
 * test/messaging.e2e-spec.ts — they are deliberately NOT re-asserted here, so this
 * spec cannot pass while the two layers disagree.
 *
 * MessagingService, TokenVerifier and PrismaService are doubles because they leave the
 * process (database, crypto); the gateway itself — state map, throttle, DTO
 * validation, error translation and registry wiring — is the real class.
 *
 * Phase 51-HR-ARCH-3A: the handshake no longer verifies tokens itself. `TokenVerifier`
 * is the same port the HTTP strategy uses, so this suite asserts the DELEGATION (the
 * raw token goes to one verifier and nothing else is trusted) and the two trust
 * branches: asymmetric trust resolves identity and tenant from the verified claims with
 * no Core read, legacy trust re-reads the user exactly as before the phase.
 */

/** A stand-in `ws` socket recording every frame and close call. */
interface FakeSocket {
  readyState: number;
  frames: string[];
  closes: { code: number; reason: string }[];
  send: jest.Mock<void, [string]>;
  close: jest.Mock<void, [number?, string?]>;
}

const makeSocket = (readyState: number = WebSocket.OPEN): FakeSocket => {
  const socket = {
    readyState,
    frames: [] as string[],
    closes: [] as { code: number; reason: string }[],
  } as FakeSocket;

  socket.send = jest.fn((frame: string) => {
    socket.frames.push(frame);
  });
  socket.close = jest.fn((code?: number, reason?: string) => {
    socket.closes.push({ code: code ?? 1000, reason: reason ?? '' });
    socket.readyState = WebSocket.CLOSED;
  });

  return socket;
};

/** The `ws` socket the gateway is typed against; the double supplies all it uses. */
const asClient = (socket: FakeSocket) => socket as unknown as WebSocket;

const makeRequest = (url: string | undefined): IncomingMessage =>
  ({ url, headers: {} }) as IncomingMessage;

const frames = (socket: FakeSocket) => socket.frames.map((frame) => JSON.parse(frame));

const lastFrame = (socket: FakeSocket) => frames(socket)[socket.frames.length - 1];

const framesNamed = (socket: FakeSocket, event: string) =>
  frames(socket).filter((frame) => frame.event === event);

/** Fields that must never leave the server on a socket frame. */
const FORBIDDEN_FRAME_FIELDS = ['tenantId', 'passwordHash', 'tokenVersion', 'email'];

describe('MessagingGateway', () => {
  let gateway: MessagingGateway;
  let messaging: jest.Mocked<Pick<
    MessagingService,
    'listMessages' | 'sendMessage' | 'markRead' | 'relayTyping' | 'announcePresence'
  >>;
  let verifier: { verify: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };
  let registry: jest.Mocked<ConnectionRegistryPort>;

  const userId = '11111111-1111-4111-8111-111111111111';
  const conversationId = '22222222-2222-4222-8222-222222222222';
  const tenantId = '33333333-3333-4333-8333-333333333333';

  /** The row prisma returns for a valid, current token. */
  const userRow = { id: userId, tenantId, tokenVersion: 1, status: 'ACTIVE' };

  /** A verifier double that returns the given claims for ANY token presented. */
  const stubVerifier = (claims: TrustedTokenClaims) => {
    verifier.verify.mockResolvedValue(claims);
  };

  /** A verifier double that refuses, the way the real one does. */
  const stubVerifierRejection = (reason: TokenRejectionReason) => {
    verifier.verify.mockRejectedValue(
      new TokenRejectedError(reason, `Refused: ${reason}.`),
    );
  };

  /**
   * Verified claims as the platform verifier hands them to a transport.
   *
   * `legacy-hmac` by default, because that is the trust level the combined runtime serves
   * TODAY: the tests below that assert a Core re-read are asserting the bridge's behaviour,
   * and they must keep passing while the bridge is open.
   */
  const verifiedClaims = (overrides: Partial<TrustedTokenClaims> = {}): TrustedTokenClaims => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      trust: 'legacy-hmac',
      sub: userId,
      tid: null,
      ver: 1,
      perm: [],
      email: null,
      iat,
      nbf: iat,
      exp: iat + 900,
      ttlSeconds: 900,
      kid: null,
      ...overrides,
    };
  };

  /** An asymmetric-trust token: identity and tenant are the claims, and Core is not read. */
  const asymmetricClaims = (claimsTenantId: string | null = tenantId) =>
    verifiedClaims({ trust: 'asymmetric', tid: claimsTenantId, kid: 'test-key' });

  const emptyPage = { items: [], hasMore: false, nextCursor: null };

  beforeEach(() => {
    messaging = {
      listMessages: jest.fn().mockResolvedValue(emptyPage),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      markRead: jest.fn().mockResolvedValue(undefined),
      relayTyping: jest.fn().mockResolvedValue(undefined),
      announcePresence: jest.fn().mockResolvedValue(undefined),
    } as unknown as typeof messaging;

    verifier = { verify: jest.fn().mockResolvedValue(verifiedClaims()) };
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(userRow) } };

    registry = {
      register: jest.fn(),
      unregister: jest.fn(),
      isOnline: jest.fn().mockReturnValue(false),
      onlineAmong: jest.fn().mockReturnValue([]),
      publishToUsers: jest.fn().mockReturnValue(0),
    };

    gateway = new MessagingGateway(
      messaging as unknown as MessagingService,
      verifier as unknown as TokenVerifier,
      prisma as unknown as PrismaService,
      registry as ConnectionRegistryPort,
    );

    // The gateway logs rejected handshakes and failed writes at debug level.
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Opens an authenticated socket the way a real handshake would. */
  const connect = async (url = `/ws/messaging?token=${'a'.repeat(20)}`) => {
    const socket = makeSocket();
    await gateway.handleConnection(asClient(socket), makeRequest(url));
    // Drop the handshake frames so each test asserts only on what it provoked.
    socket.frames.length = 0;
    socket.send.mockClear();
    return socket;
  };

  describe('handshake authentication', () => {
    it('accepts a valid token, registers the connection and announces readiness', async () => {
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=good'));

      // The raw token goes to THE verifier — the same port the HTTP strategy uses — and the
      // gateway trusts nothing else. Before this phase the gateway verified tokens itself
      // with its own copy of the secret, audience and issuer.
      expect(verifier.verify).toHaveBeenCalledWith('good');
      expect(socket.close).not.toHaveBeenCalled();
      expect(lastFrame(socket)).toEqual({ event: 'connection.ready', data: { userId } });
      expect(registry.register).toHaveBeenCalledTimes(1);
      expect(messaging.announcePresence).toHaveBeenCalledWith(userId, 'online');
    });

    /**
     * The property ADR-0006 §B1 is about, on the socket transport: at asymmetric trust the
     * verified claims are the authority, so the handshake performs NO Core read — which is
     * what makes this gateway usable by a runtime whose tenant is not in a database it can
     * reach.
     */
    it('resolves identity and tenant from verified claims without reading Core', async () => {
      stubVerifier(asymmetricClaims());
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      expect(lastFrame(socket)).toEqual({ event: 'connection.ready', data: { userId } });
      expect(registry.register).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();

      // The claim's tenant is what every subsequent service call is scoped by, so "no Core
      // read" must not mean "no tenant": the socket carries the verified `tid`.
      messaging.listMessages.mockResolvedValue(emptyPage as never);
      await gateway.onSubscribe(asClient(socket), { conversationId });
      expect(messaging.listMessages).toHaveBeenCalledWith(userId, conversationId, {}, tenantId);
    });

    it('registers under a distinct connectionId per socket', async () => {
      await gateway.handleConnection(asClient(makeSocket()), makeRequest('/ws/messaging?token=a'));
      await gateway.handleConnection(asClient(makeSocket()), makeRequest('/ws/messaging?token=a'));

      const [firstUser, firstConnectionId] = registry.register.mock.calls[0];
      const [secondUser, secondConnectionId] = registry.register.mock.calls[1];

      // Same user, two tabs: presence must be able to tell the sockets apart.
      expect(firstUser).toBe(userId);
      expect(secondUser).toBe(userId);
      expect(firstConnectionId).not.toBe(secondConnectionId);
    });

    it('announces presence only after the connection is registered', async () => {
      const order: string[] = [];
      registry.register.mockImplementation(() => {
        order.push('register');
      });
      messaging.announcePresence.mockImplementation(async () => {
        order.push('announce');
      });

      await gateway.handleConnection(asClient(makeSocket()), makeRequest('/ws/messaging?token=a'));

      // Otherwise a listener reacting to `online` could publish to a user the
      // registry does not yet know about.
      expect(order).toEqual(['register', 'announce']);
    });

    it('hands the registry an adapter bound to this socket', async () => {
      const socket = makeSocket();
      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      const connection = registry.register.mock.calls[0][2];

      connection.send('{"event":"x","data":null}');
      expect(socket.send).toHaveBeenCalledWith('{"event":"x","data":null}');

      expect(connection.isOpen()).toBe(true);
      socket.readyState = WebSocket.CLOSED;
      expect(connection.isOpen()).toBe(false);
    });

    it.each([
      ['no query string at all', '/ws/messaging'],
      ['an empty token', '/ws/messaging?token='],
      ['a whitespace-only token', '/ws/messaging?token=%20%20'],
    ])('closes a handshake with %s using 4401', async (_label, url) => {
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest(url));

      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Authentication token is required' },
      });
      expect(socket.closes).toEqual([
        { code: WS_CLOSE_UNAUTHORIZED, reason: 'Authentication token is required' },
      ]);
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(registry.register).not.toHaveBeenCalled();
      expect(messaging.announcePresence).not.toHaveBeenCalled();
    });

    it('trims the token before verifying it', async () => {
      await gateway.handleConnection(
        asClient(makeSocket()),
        makeRequest('/ws/messaging?token=%20abc%20'),
      );

      expect(verifier.verify).toHaveBeenCalledWith('abc');
    });

    it('reads the URL-decoded token, so a dotted JWT survives encoding', async () => {
      const token = 'header.payload.signature';

      await gateway.handleConnection(
        asClient(makeSocket()),
        makeRequest(`/ws/messaging?token=${encodeURIComponent(token)}`),
      );

      expect(verifier.verify).toHaveBeenCalledWith(token);
    });

    it('closes with 4401 when the token fails verification', async () => {
      stubVerifierRejection('signature-invalid');
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=bad'));

      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Authentication failed' },
      });
      expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(registry.register).not.toHaveBeenCalled();
    });

    /**
     * The verifier's REASON must not cross the socket.
     *
     * A client that learns "your token's lifetime exceeds the accepted maximum" versus
     * "unknown kid" has been handed an oracle for probing this deployment's configuration.
     * The operator gets the reason (in the log line the gateway already writes); the caller
     * gets one message for every rejection.
     */
    it('reports one generic message to the client whatever the rejection reason', async () => {
      const reasons = [
        'token-expired',
        'algorithm-not-accepted',
        'lifetime-exceeds-maximum',
        'token-revoked',
      ] as const;

      for (const reason of reasons) {
        stubVerifierRejection(reason);
        const socket = makeSocket();

        await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

        expect(socket.frames.join('\n')).not.toContain(reason);
        expect(lastFrame(socket).data.message).toBe('Authentication failed');
        expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
      }
    });

    it('re-reads the user and closes with 4401 when the account is gone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: { id: true, tenantId: true, tokenVersion: true, status: true },
      });
      expect(lastFrame(socket).data.message).toBe('Token is no longer valid');
      expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('closes with 4401 when the token version is stale', async () => {
      stubVerifier(verifiedClaims({ ver: 1 }));
      prisma.user.findUnique.mockResolvedValue({ ...userRow, tokenVersion: 2 });
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      // A revoked token cannot hold a socket open even though no HTTP request is
      // involved after the handshake. The re-read is the BRIDGE path: a legacy token's
      // version is only meaningful against Core's row, which is why the claim alone cannot
      // end this check.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(lastFrame(socket).data.message).toBe('Token is no longer valid');
      expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('closes with 4401 when the database read fails', async () => {
      prisma.user.findUnique.mockRejectedValue(new Error('connection refused'));
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      // Fail closed: an unverifiable socket is never left open in an anonymous state.
      expect(lastFrame(socket).data.message).toBe('Authentication failed');
      expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('never puts the tenant or any credential field in the ready frame', async () => {
      const socket = makeSocket();

      await gateway.handleConnection(asClient(socket), makeRequest('/ws/messaging?token=a'));

      const raw = socket.frames.join('\n');
      for (const field of FORBIDDEN_FRAME_FIELDS) {
        expect(raw).not.toContain(field);
      }
      expect(lastFrame(socket).data).toEqual({ userId });
    });
  });

  describe('disconnect', () => {
    it('unregisters the connection it registered', async () => {
      const socket = await connect();
      const connectionId = registry.register.mock.calls[0][1];

      await gateway.handleDisconnect(asClient(socket));

      expect(registry.unregister).toHaveBeenCalledWith(userId, connectionId);
    });

    it('announces offline once the user holds no further connection', async () => {
      const socket = await connect();
      registry.isOnline.mockReturnValue(false);
      messaging.announcePresence.mockClear();

      await gateway.handleDisconnect(asClient(socket));

      expect(messaging.announcePresence).toHaveBeenCalledWith(userId, 'offline');
    });

    it('stays silent while another connection of the same user is live', async () => {
      const socket = await connect();
      registry.isOnline.mockReturnValue(true);
      messaging.announcePresence.mockClear();

      await gateway.handleDisconnect(asClient(socket));

      // Closing one tab must not make the user look offline in another.
      expect(messaging.announcePresence).not.toHaveBeenCalled();
    });

    it('swallows a failure to announce offline', async () => {
      const socket = await connect();
      messaging.announcePresence.mockRejectedValue(new Error('db down'));

      await expect(gateway.handleDisconnect(asClient(socket))).resolves.toBeUndefined();
      expect(registry.unregister).toHaveBeenCalled();
    });

    it('does nothing for a socket that never authenticated', async () => {
      await gateway.handleDisconnect(asClient(makeSocket()));

      expect(registry.unregister).not.toHaveBeenCalled();
      expect(messaging.announcePresence).not.toHaveBeenCalled();
    });

    it('drops the socket state, so a later frame is treated as unauthenticated', async () => {
      const socket = await connect();
      await gateway.handleDisconnect(asClient(socket));

      socket.readyState = WebSocket.OPEN;
      await gateway.onMarkRead(asClient(socket), { conversationId });

      expect(messaging.markRead).not.toHaveBeenCalled();
      expect(lastFrame(socket).data.message).toBe('Socket is not authenticated');
    });
  });

  describe('frames from an unauthenticated socket', () => {
    /** Every inbound handler, so no new event can quietly skip the state check. */
    const handlers: [string, (client: WebSocket, payload: unknown) => Promise<void>][] = [
      ['conversation.subscribe', (c, p) => gateway.onSubscribe(c, p)],
      ['conversation.unsubscribe', (c, p) => gateway.onUnsubscribe(c, p)],
      ['message.send', (c, p) => gateway.onSendMessage(c, p)],
      ['message.read', (c, p) => gateway.onMarkRead(c, p)],
      ['typing.start', (c, p) => gateway.onTypingStart(c, p)],
      ['typing.stop', (c, p) => gateway.onTypingStop(c, p)],
    ];

    it.each(handlers)('rejects and closes %s', async (_event, invoke) => {
      const socket = makeSocket();

      await invoke(asClient(socket), { conversationId });

      // There is no anonymous mode: a frame on a socket whose handshake was
      // rejected is refused rather than served.
      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Socket is not authenticated' },
      });
      expect(socket.closes[0].code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(messaging.listMessages).not.toHaveBeenCalled();
      expect(messaging.sendMessage).not.toHaveBeenCalled();
      expect(messaging.markRead).not.toHaveBeenCalled();
      expect(messaging.relayTyping).not.toHaveBeenCalled();
    });
  });

  describe('payload validation', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'conversationId'],
      ['a number', 7],
      ['an array', [{ conversationId }]],
    ])('rejects %s as a malformed payload without closing the socket', async (_label, payload) => {
      const socket = await connect();

      await gateway.onSubscribe(asClient(socket), payload);

      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Malformed payload' },
      });
      expect(socket.close).not.toHaveBeenCalled();
      expect(messaging.listMessages).not.toHaveBeenCalled();
    });

    it('reports a validation failure with the offending property', async () => {
      const socket = await connect();

      await gateway.onSubscribe(asClient(socket), { conversationId: 'not-a-uuid' });

      const frame = lastFrame(socket);
      expect(frame.event).toBe('error');
      expect(frame.data.message).toBe('Validation failed');
      expect(frame.data.details).toEqual([
        expect.objectContaining({ property: 'conversationId' }),
      ]);
      expect(messaging.listMessages).not.toHaveBeenCalled();
    });

    it('refuses an unknown property rather than stripping it', async () => {
      const socket = await connect();

      // Same `forbidNonWhitelisted` posture as the global HTTP ValidationPipe, so a
      // client cannot smuggle a field the socket path happens to ignore.
      await gateway.onSendMessage(asClient(socket), {
        conversationId,
        body: 'سلام',
        senderId: 'someone-else',
      });

      expect(lastFrame(socket).data.message).toBe('Validation failed');
      expect(messaging.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps serving a good frame after a bad one', async () => {
      const socket = await connect();

      await gateway.onSubscribe(asClient(socket), { conversationId: 'nope' });
      await gateway.onSubscribe(asClient(socket), { conversationId });

      // One bad frame is not grounds for tearing down a working connection.
      expect(socket.close).not.toHaveBeenCalled();
      expect(framesNamed(socket, 'conversation.subscribed')).toHaveLength(1);
    });
  });
  describe('conversation.subscribe', () => {
    it('reads page one as the authorization probe and echoes the conversation id', async () => {
      const page = { items: [{ id: 'm1', body: 'سلام' }], hasMore: true, nextCursor: 'cursor-1' };
      messaging.listMessages.mockResolvedValue(page as never);
      const socket = await connect();

      await gateway.onSubscribe(asClient(socket), { conversationId });

      expect(messaging.listMessages).toHaveBeenCalledWith(userId, conversationId, {}, tenantId);
      expect(lastFrame(socket)).toEqual({
        event: 'conversation.subscribed',
        data: { conversationId, ...page },
      });
    });

    it('grants no subscription when the service refuses the conversation', async () => {
      messaging.listMessages.mockRejectedValue(new NotFoundException('Conversation not found'));
      const socket = await connect();

      await gateway.onSubscribe(asClient(socket), { conversationId });

      // Identical wording to the HTTP route: the socket is not a looser interface.
      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Conversation not found' },
      });
      expect(framesNamed(socket, 'conversation.subscribed')).toHaveLength(0);
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  describe('conversation.unsubscribe', () => {
    it('acknowledges without calling the service', async () => {
      const socket = await connect();

      await gateway.onUnsubscribe(asClient(socket), { conversationId });

      // There is no server-side room to leave — fan-out is by user id — so this is
      // purely a client-facing acknowledgement.
      expect(lastFrame(socket)).toEqual({
        event: 'conversation.unsubscribed',
        data: { conversationId },
      });
      expect(messaging.listMessages).not.toHaveBeenCalled();
    });

    it('validates the payload like every other frame', async () => {
      const socket = await connect();

      await gateway.onUnsubscribe(asClient(socket), { conversationId: 'nope' });

      expect(lastFrame(socket).data.message).toBe('Validation failed');
    });
  });

  describe('message.send', () => {
    it('takes the sender and tenant from the socket, and strips conversationId from the DTO', async () => {
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), {
        conversationId,
        body: 'سلام',
        clientMessageId: 'idem-1',
      });

      expect(messaging.sendMessage).toHaveBeenCalledWith(
        userId,
        conversationId,
        { body: 'سلام', clientMessageId: 'idem-1' },
        tenantId,
      );
    });

    it('emits nothing itself — the sender receives their copy through fan-out', async () => {
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'سلام' });

      // No separate echo that could disagree with what every other member receives.
      expect(socket.frames).toHaveLength(0);
    });

    it('trims the body before handing it to the service', async () => {
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), { conversationId, body: '  سلام  ' });

      expect(messaging.sendMessage).toHaveBeenCalledWith(
        userId,
        conversationId,
        expect.objectContaining({ body: 'سلام' }),
        tenantId,
      );
    });

    it.each([
      ['an empty body', { conversationId, body: '   ' }],
      ['an over-long clientMessageId', { conversationId, body: 'x', clientMessageId: 'c'.repeat(65) }],
      ['a non-uuid attachment id', { conversationId, body: 'x', attachmentIds: ['nope'] }],
    ])('rejects a send with %s', async (_label, payload) => {
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), payload);

      expect(lastFrame(socket).data.message).toBe('Validation failed');
      expect(messaging.sendMessage).not.toHaveBeenCalled();
    });

    it('translates a domain rejection into an error frame', async () => {
      messaging.sendMessage.mockRejectedValue(new ForbiddenException('Conversation not found'));
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'سلام' });

      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: { message: 'Conversation not found' },
      });
      expect(socket.close).not.toHaveBeenCalled();
    });

    it('reports a generic failure for a non-HTTP error, leaking no internals', async () => {
      messaging.sendMessage.mockRejectedValue(
        new Error('duplicate key value violates unique constraint'),
      );
      const socket = await connect();

      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'سلام' });

      expect(lastFrame(socket)).toEqual({ event: 'error', data: { message: 'Request failed' } });
      expect(socket.frames.join('')).not.toContain('unique constraint');
    });
  });

  describe('send throttle', () => {
    it(`allows ${WS_SEND_LIMIT} sends in one window and refuses the next`, async () => {
      const socket = await connect();

      for (let i = 0; i < WS_SEND_LIMIT; i++) {
        await gateway.onSendMessage(asClient(socket), { conversationId, body: `m${i}` });
      }
      expect(messaging.sendMessage).toHaveBeenCalledTimes(WS_SEND_LIMIT);
      expect(socket.frames).toHaveLength(0);

      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'one too many' });

      expect(messaging.sendMessage).toHaveBeenCalledTimes(WS_SEND_LIMIT);
      expect(lastFrame(socket)).toEqual({
        event: 'error',
        data: {
          message: `Rate limit exceeded: at most ${WS_SEND_LIMIT} messages per ${WS_SEND_WINDOW_MS / 1000} seconds`,
        },
      });
    });

    it('lets sends through again once the window has slid past', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-29T10:00:00Z'));
      const socket = await connect();

      for (let i = 0; i < WS_SEND_LIMIT; i++) {
        await gateway.onSendMessage(asClient(socket), { conversationId, body: `m${i}` });
      }
      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'blocked' });
      expect(messaging.sendMessage).toHaveBeenCalledTimes(WS_SEND_LIMIT);

      jest.setSystemTime(new Date(Date.now() + WS_SEND_WINDOW_MS + 1));
      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'allowed' });

      expect(messaging.sendMessage).toHaveBeenCalledTimes(WS_SEND_LIMIT + 1);
    });

    it('is not spent by a rejected frame', async () => {
      const socket = await connect();

      // Validation runs before the budget check, so a malformed frame cannot be used
      // to exhaust the connection's own quota.
      for (let i = 0; i < WS_SEND_LIMIT + 5; i++) {
        await gateway.onSendMessage(asClient(socket), { conversationId, body: '' });
      }
      socket.frames.length = 0;

      await gateway.onSendMessage(asClient(socket), { conversationId, body: 'سلام' });

      expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
      expect(socket.frames).toHaveLength(0);
    });

    it('budgets per connection, not per user', async () => {
      const first = await connect();
      const second = await connect();

      for (let i = 0; i < WS_SEND_LIMIT; i++) {
        await gateway.onSendMessage(asClient(first), { conversationId, body: `m${i}` });
      }
      await gateway.onSendMessage(asClient(second), { conversationId, body: 'from the other tab' });

      expect(messaging.sendMessage).toHaveBeenCalledTimes(WS_SEND_LIMIT + 1);
      expect(second.frames).toHaveLength(0);
    });

    it('does not throttle reads or typing', async () => {
      const socket = await connect();

      for (let i = 0; i < WS_SEND_LIMIT + 5; i++) {
        await gateway.onMarkRead(asClient(socket), { conversationId });
        await gateway.onTypingStart(asClient(socket), { conversationId });
      }

      expect(messaging.markRead).toHaveBeenCalledTimes(WS_SEND_LIMIT + 5);
      expect(messaging.relayTyping).toHaveBeenCalledTimes(WS_SEND_LIMIT + 5);
      expect(socket.frames).toHaveLength(0);
    });
  });

  describe('message.read', () => {
    it('advances the cursor for the socket identity', async () => {
      const socket = await connect();

      await gateway.onMarkRead(asClient(socket), { conversationId });

      expect(messaging.markRead).toHaveBeenCalledWith(userId, conversationId, tenantId);
      // The acknowledgement is published by the service through the registry, so the
      // gateway writes nothing directly.
      expect(socket.frames).toHaveLength(0);
    });

    it('translates a refusal into an error frame', async () => {
      messaging.markRead.mockRejectedValue(new NotFoundException('Conversation not found'));
      const socket = await connect();

      await gateway.onMarkRead(asClient(socket), { conversationId });

      expect(lastFrame(socket).data.message).toBe('Conversation not found');
    });
  });

  describe('typing', () => {
    it('relays true for typing.start', async () => {
      const socket = await connect();

      await gateway.onTypingStart(asClient(socket), { conversationId });

      expect(messaging.relayTyping).toHaveBeenCalledWith(userId, conversationId, true, tenantId);
    });

    it('relays false for typing.stop', async () => {
      const socket = await connect();

      await gateway.onTypingStop(asClient(socket), { conversationId });

      expect(messaging.relayTyping).toHaveBeenCalledWith(userId, conversationId, false, tenantId);
    });

    it('ignores a payload flag that contradicts typing.start', async () => {
      const socket = await connect();

      await gateway.onTypingStart(asClient(socket), { conversationId, isTyping: false });

      // The state comes from the event name, so the two cannot disagree.
      expect(messaging.relayTyping).toHaveBeenCalledWith(userId, conversationId, true, tenantId);
    });

    it('ignores a payload flag that contradicts typing.stop', async () => {
      const socket = await connect();

      await gateway.onTypingStop(asClient(socket), { conversationId, isTyping: true });

      expect(messaging.relayTyping).toHaveBeenCalledWith(userId, conversationId, false, tenantId);
    });

    it('translates a refusal into an error frame', async () => {
      messaging.relayTyping.mockRejectedValue(new NotFoundException('Conversation not found'));
      const socket = await connect();

      await gateway.onTypingStart(asClient(socket), { conversationId });

      expect(lastFrame(socket).data.message).toBe('Conversation not found');
    });
  });
  describe('writing to a socket that is no longer open', () => {
    it('skips the write instead of throwing', async () => {
      const socket = await connect();
      messaging.listMessages.mockRejectedValue(new NotFoundException('Conversation not found'));
      socket.readyState = WebSocket.CLOSING;

      await expect(
        gateway.onSubscribe(asClient(socket), { conversationId }),
      ).resolves.toBeUndefined();

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('survives a socket whose send throws', async () => {
      const socket = await connect();
      socket.send.mockImplementation(() => {
        throw new Error('not writable');
      });
      messaging.markRead.mockRejectedValue(new NotFoundException('Conversation not found'));

      await expect(
        gateway.onMarkRead(asClient(socket), { conversationId }),
      ).resolves.toBeUndefined();
    });
  });

  describe('tenant scope', () => {
    it('passes a null tenant through unchanged for a tenant-less account', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...userRow, tenantId: null });
      const socket = await connect();

      await gateway.onMarkRead(asClient(socket), { conversationId });

      // The tenant is a snapshot of the authenticated account, never client input, so
      // a null must stay null rather than becoming an unscoped wildcard downstream.
      expect(messaging.markRead).toHaveBeenCalledWith(userId, conversationId, null);
    });

    it('never accepts a tenantId from the payload', async () => {
      const socket = await connect();

      await gateway.onMarkRead(asClient(socket), { conversationId, tenantId: 'other-tenant' });

      expect(lastFrame(socket).data.message).toBe('Validation failed');
      expect(messaging.markRead).not.toHaveBeenCalled();
    });
  });







});
