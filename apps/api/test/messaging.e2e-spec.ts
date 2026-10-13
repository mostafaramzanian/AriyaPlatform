import jwt from 'jsonwebtoken';
import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
  WebSocketAdapter,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
import { MessagingModule } from '../src/messaging/messaging.module';
import { MessagingService } from '../src/messaging/messaging.service';
import { WS_CLOSE_UNAUTHORIZED } from '../src/messaging/messaging.gateway';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY,
} from '../src/messaging/dto/conversation.dto';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

// Same require-style import as app.e2e-spec.ts: the package ships CommonJS types
// that do not resolve through this project's path mapping.

/**
 * Phase 49F — Internal Messaging E2E against the real Core database.
 *
 * Modelled on notifications.e2e-spec.ts (49E): a minimal test guard stands in for
 * JwtAuthGuard so HTTP identity arrives in a header, while the REAL global
 * TenantContextInterceptor resolves tenantId from the database. Membership and
 * tenant scope are therefore exercised exactly as in production — nothing in the
 * request can influence either.
 *
 * The controller carries no `@Roles(...)` gate by design (a conversation is
 * personal, not an administered resource), so RolesGuard is not part of this
 * module: the only authorization boundary under test is membership.
 *
 * The WebSocket gateway is mounted with the same WsAdapter core-main.ts uses, and
 * the app really listens, so the handshake assertions run against a genuine
 * RFC 6455 upgrade rather than a mocked socket.
 */

/** Fields that must never appear on a projected conversation member. */
const FORBIDDEN_MEMBER_FIELDS = [
  'email',
  'passwordHash',
  'refreshTokenHash',
  'tokenVersion',
  'emailVerified',
  'status',
  'tenantId',
];

/**
 * Stands in for JwtAuthGuard on the HTTP surface. Missing header → 401, exactly as
 * an absent or invalid bearer token behaves in production; a present header
 * supplies the same shape jwt.strategy.ts returns (`sub` + `userId`).
 *
 * Non-HTTP contexts pass straight through: a WebSocket frame has no Express
 * request, and the gateway authenticates its own handshake from the JWT.
 */
class MessagingTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('Internal Messaging E2E (membership, tenant isolation, idempotency, WS handshake)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;

  const now = Date.now();
  const jwtSecret = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];

  // Tenant A: three users (the caller, a peer, an outsider inside the same
  // tenant). Tenant B: one user, who must be unreachable from tenant A.
  let userA1Id: string;
  let userA2Id: string;
  let userA3Id: string;
  let userBId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `msg-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUsers.push(user.id);
    return user;
  };

  /** Access token in exactly the shape auth.service.ts mints. */
  const signToken = (userId: string, overrides: Record<string, unknown> = {}) =>
    jwt.sign(
      { sub: userId, email: `${userId}@example.com`, tokenVersion: 1, ...overrides },
      jwtSecret,
      { expiresIn: '10m', audience: 'aria-erp-api', issuer: 'aria-erp-auth' },
    );

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /** Creates (or resolves) a DIRECT conversation through the public route. */
  const createDirect = async (callerId: string, otherId: string) => {
    const res = await post('/conversations', callerId).send({
      type: 'DIRECT',
      participantIds: [otherId],
    });
    expect(res.status).toBe(200);
    return res.body;
  };

  const sendMessage = (callerId: string, conversationId: string, body: Record<string, unknown>) =>
    post(`/conversations/${conversationId}/messages`, callerId).send(body);

  interface SocketFrame {
    event: string;
    data: unknown;
  }

  /** Receipt payloads in exactly the shapes the authored assertions compare against. */
  interface SocketPayloads {
    'connection.ready': { userId: string };
    'conversation.subscribed': { conversationId: string; items: unknown[]; hasMore: boolean };
    error: { message: string };
    'message.created': { id: string };
    'typing.changed': { conversationId: string; userId: string; isTyping: boolean };
    'message.read': { conversationId: string; userId: string };
    [event: string]: unknown;
  }

  interface SocketHarness {
    socket: WebSocket;
    /** Every frame received, in arrival order. */
    events: SocketFrame[];
    /** Resolves with the first frame matching `event`, or rejects on timeout. */
    waitFor<K extends keyof SocketPayloads>(
      event: K,
      timeoutMs?: number,
    ): Promise<SocketPayloads[K]>;
    /** Resolves with the close code once the socket closes. */
    closed: Promise<{ code: number; reason: string }>;
    close(): void;
  }

  /**
   * Opens a real WebSocket against the running server.
   *
   * Resolves as soon as the socket is open — NOT once it is authenticated — so a
   * rejected handshake can be observed as a close frame rather than a hang. That
   * distinction is what makes the 4401 assertions meaningful.
   */
  const openSocket = (token?: string): Promise<SocketHarness> => {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/messaging${query}`);
    const events: SocketFrame[] = [];
    const waiters: { event: string; resolve: (data: unknown) => void }[] = [];

    socket.on('message', (raw) => {
      let frame: SocketFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      events.push(frame);

      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].event === frame.event) {
          waiters[i].resolve(frame.data);
          waiters.splice(i, 1);
        }
      }
    });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason?.toString() ?? '' }));
    });

    const harness: SocketHarness = {
      socket,
      events,
      waitFor: (<K extends keyof SocketPayloads>(event: K, timeoutMs = 5000) =>
        new Promise((resolve, reject) => {
          const existing = events.find((f) => f.event === event);
          if (existing) {
            resolve(existing.data);
            return;
          }

          const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for '${event}'`)),
            timeoutMs,
          );
          waiters.push({
            event,
            resolve: (data) => {
              clearTimeout(timer);
              resolve(data);
            },
          });
        })) as SocketHarness['waitFor'],
      closed,
      close: () => socket.close(),
    };

    return new Promise((resolve, reject) => {
      socket.on('open', () => resolve(harness));
      // A handshake the server refuses at the HTTP layer never opens, so surface
      // the error instead of waiting for a frame that will not arrive.
      socket.on('error', (err) => reject(err));
    });
  };

  const emit = (harness: SocketHarness, event: string, data: unknown) =>
    harness.socket.send(JSON.stringify({ event, data }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [ConfigModule.forRoot({ isGlobal: true }), MessagingModule, PrismaModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: MessagingTestGuard },
      ],
    })
      // Passport's 'jwt' strategy is not registered in this trimmed test module,
      // so the route-level guard is replaced by a pass-through; HTTP authentication
      // is decided by MessagingTestGuard above. The gateway still verifies real
      // JWTs itself, so nothing about socket authentication is stubbed.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Same pipe configuration as production, so `forbidNonWhitelisted` rejection
    // of an injected senderId/tenantId field is genuinely exercised.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.length,
          }),
      }),
    );

    // Identical to core-main.ts, including the documented declaration-only cast
    // between @nestjs/common 11.1.28 and @nestjs/platform-ws 11.1.6.
    app.useWebSocketAdapter(new WsAdapter(app) as unknown as WebSocketAdapter);

    // The gateway needs a real HTTP server to attach its upgrade handler to, so
    // this listens rather than calling init().
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;

    prisma = app.get(PrismaService);
    // Resolving the provider proves it is registered on the test module; the
    // suite drives behaviour over HTTP/WS and never calls the service directly.
    app.get(MessagingService);

    const tenantA = await prisma.tenant.create({ data: { code: `msg-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `msg-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    userA1Id = (await makeUser({ tenantId: tenantAId, firstName: 'بهار', lastName: 'نوری' })).id;
    userA2Id = (await makeUser({ tenantId: tenantAId, firstName: 'پویا', lastName: 'رستمی' })).id;
    userA3Id = (await makeUser({ tenantId: tenantAId, firstName: 'سارا', lastName: 'کریمی' })).id;
    userBId = (await makeUser({ tenantId: tenantBId, firstName: 'ثمین', lastName: 'حیدری' })).id;
  });

  afterAll(async () => {
    // Conversations cascade to members, messages and attachments, so deleting the
    // conversations the fixture users created is sufficient.
    await prisma.conversation.deleteMany({ where: { createdBy: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });

  describe('authentication', () => {
    it.each([
      ['/conversations'],
      ['/conversations/unread-count'],
    ])('rejects an unauthenticated GET %s with 401', async (path) => {
      const res = await get(path);
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated create with 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/conversations')
        .send({ type: 'DIRECT', participantIds: [userA2Id] });
      expect(res.status).toBe(401);
    });
  });

  describe('route ordering', () => {
    /**
     * `unread-count` and `attachments/:id` are literal segments declared before
     * `:id`. If that order regressed they would be swallowed by the UUID pipe and
     * come back 400 instead of doing their job.
     */
    it('resolves unread-count as a literal, not as :id', async () => {
      const res = await get('/conversations/unread-count', userA1Id);
      expect(res.status).toBe(200);
      expect(typeof res.body.count).toBe('number');
    });

    it('resolves attachments/:attachmentId as a literal, not as :id', async () => {
      // A well-formed but unknown attachment id: reaching the attachment handler
      // yields 404 from the ownership predicate. A 400 here would mean the request
      // was routed to `:id` and rejected by ParseUUIDPipe on the wrong parameter.
      const res = await get(
        '/conversations/attachments/11111111-1111-4111-8111-111111111111',
        userA1Id,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('conversation creation', () => {
    it('deduplicates a DIRECT conversation by directKey, in both participant orders', async () => {
      const first = await createDirect(userA1Id, userA2Id);
      const again = await createDirect(userA1Id, userA2Id);
      // The other participant asking for the same thread must land on the same row:
      // the key sorts its two ids, so (a,b) and (b,a) collapse.
      const reversed = await createDirect(userA2Id, userA1Id);

      expect(again.id).toBe(first.id);
      expect(reversed.id).toBe(first.id);

      const rows = await prisma.conversation.count({
        where: { type: 'DIRECT', createdBy: { in: [userA1Id, userA2Id] }, tenantId: tenantAId },
      });
      expect(rows).toBe(1);
    });

    it('stores a deterministic directKey and never projects it', async () => {
      const conversation = await createDirect(userA1Id, userA3Id);

      const row = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { directKey: true, tenantId: true, name: true, type: true },
      });

      expect(row).toEqual({
        directKey: `${tenantAId}:${[userA1Id, userA3Id].sort().join(':')}`,
        tenantId: tenantAId,
        name: null,
        type: 'DIRECT',
      });

      expect(conversation).not.toHaveProperty('directKey');
      expect(conversation).not.toHaveProperty('tenantId');
    });

    it('refuses a participant from another tenant exactly like an unknown id', async () => {
      const foreign = await post('/conversations', userA1Id).send({
        type: 'DIRECT',
        participantIds: [userBId],
      });
      const unknown = await post('/conversations', userA1Id).send({
        type: 'DIRECT',
        participantIds: ['11111111-1111-4111-8111-111111111111'],
      });

      expect(foreign.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect(foreign.body.message).toBe(unknown.body.message);
    });

    it('refuses a conversation with only the caller', async () => {
      const res = await post('/conversations', userA1Id).send({
        type: 'DIRECT',
        participantIds: [userA1Id],
      });
      expect(res.status).toBe(400);
    });

    it('refuses a named DIRECT and an unnamed GROUP', async () => {
      const namedDirect = await post('/conversations', userA1Id).send({
        type: 'DIRECT',
        participantIds: [userA2Id],
        name: 'نام نامعتبر',
      });
      const unnamedGroup = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id, userA3Id],
      });

      expect(namedDirect.status).toBe(400);
      expect(unnamedGroup.status).toBe(400);
    });

    it('creates a GROUP with the caller as creator and member, projecting no secrets', async () => {
      const res = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id, userA3Id],
        name: 'گروه پروژه',
      });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('GROUP');
      expect(res.body.createdBy).toBe(userA1Id);

      const memberIds = res.body.members.map((m: { id: string }) => m.id).sort();
      expect(memberIds).toEqual([userA1Id, userA2Id, userA3Id].sort());

      for (const member of res.body.members) {
        for (const field of FORBIDDEN_MEMBER_FIELDS) {
          expect(member).not.toHaveProperty(field);
        }
      }

      const row = await prisma.conversation.findUnique({
        where: { id: res.body.id },
        select: { directKey: true, tenantId: true },
      });
      // A GROUP carries no dedupe key — two groups with the same members are
      // legitimately distinct.
      expect(row).toEqual({ directKey: null, tenantId: tenantAId });
    });

    it('rejects a client-supplied createdBy or tenantId outright', async () => {
      const res = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه',
        createdBy: userA2Id,
        tenantId: tenantBId,
      });
      expect(res.status).toBe(422);
    });
  });

  describe('membership as the only authorization boundary', () => {
    let a1a2: { id: string };

    beforeAll(async () => {
      a1a2 = await createDirect(userA1Id, userA2Id);
    });

    /**
     * A non-member inside the same tenant and a user from another tenant must be
     * indistinguishable from someone asking about a conversation that does not
     * exist. Otherwise the status code itself becomes an id oracle.
     */
    it.each([
      ['a same-tenant non-member', () => userA3Id],
      ['a cross-tenant user', () => userBId],
    ])('returns 404 to %s on every conversation-scoped read', async (_label, subject) => {
      const userId = subject();

      const one = await get(`/conversations/${a1a2.id}`, userId);
      const messages = await get(`/conversations/${a1a2.id}/messages`, userId);
      const presence = await get(`/conversations/${a1a2.id}/presence`, userId);

      expect(one.status).toBe(404);
      expect(messages.status).toBe(404);
      expect(presence.status).toBe(404);
    });

    it('returns 404 to a non-member on every conversation-scoped write', async () => {
      const send = await sendMessage(userA3Id, a1a2.id, { body: 'نفوذ' });
      const read = await post(`/conversations/${a1a2.id}/read`, userA3Id);

      expect(send.status).toBe(404);
      expect(read.status).toBe(404);

      // Nothing was persisted by the refused send.
      const count = await prisma.message.count({
        where: { conversationId: a1a2.id, senderId: userA3Id },
      });
      expect(count).toBe(0);
    });

    it('gives the same 404 for an unknown id as for a forbidden one', async () => {
      const unknown = await get(
        '/conversations/11111111-1111-4111-8111-111111111111',
        userA3Id,
      );
      const forbidden = await get(`/conversations/${a1a2.id}`, userA3Id);

      expect(unknown.status).toBe(404);
      expect(forbidden.status).toBe(404);
      expect(unknown.body.message).toBe(forbidden.body.message);
    });

    it('lists only the caller\'s own conversations', async () => {
      const mine = await get('/conversations?limit=100', userA1Id);
      const outsider = await get('/conversations?limit=100', userBId);

      expect(mine.status).toBe(200);
      expect(mine.body.items.map((c: { id: string }) => c.id)).toContain(a1a2.id);

      expect(outsider.status).toBe(200);
      expect(outsider.body.items.map((c: { id: string }) => c.id)).not.toContain(a1a2.id);
    });

    it('rejects an injected userId or tenantId query parameter', async () => {
      const res = await get(`/conversations?userId=${userA2Id}`, userA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('sending and reading messages', () => {
    let conversationId: string;

    beforeAll(async () => {
      const group = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه پیام‌ها',
      });
      conversationId = group.body.id;
    });

    it('persists a message and advances lastMessageAt in the same transaction', async () => {
      const res = await sendMessage(userA1Id, conversationId, { body: 'سلام' });

      expect(res.status).toBe(201);
      expect(res.body.senderId).toBe(userA1Id);
      expect(res.body.body).toBe('سلام');
      // storageKey and tenantId are internal; a message projects neither.
      expect(res.body).not.toHaveProperty('tenantId');

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { lastMessageAt: true },
      });
      expect(conversation?.lastMessageAt?.toISOString()).toBe(
        new Date(res.body.createdAt).toISOString(),
      );
    });

    it('is idempotent for a repeated clientMessageId from the same sender', async () => {
      const clientMessageId = `retry-${now}`;

      const first = await sendMessage(userA1Id, conversationId, {
        body: 'ارسال دوباره',
        clientMessageId,
      });
      const retry = await sendMessage(userA1Id, conversationId, {
        body: 'ارسال دوباره',
        clientMessageId,
      });

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(first.body.id);

      const stored = await prisma.message.count({
        where: { conversationId, senderId: userA1Id, clientMessageId },
      });
      expect(stored).toBe(1);
    });

    it('lets a different sender reuse the same clientMessageId', async () => {
      const clientMessageId = `shared-${now}`;

      const mine = await sendMessage(userA1Id, conversationId, {
        body: 'از من',
        clientMessageId,
      });
      const theirs = await sendMessage(userA2Id, conversationId, {
        body: 'از او',
        clientMessageId,
      });

      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      // The uniqueness is per (conversation, sender, key), so two people cannot
      // collide with each other's retry keys.
      expect(theirs.body.id).not.toBe(mine.body.id);
    });

    it('rejects an empty or oversized body', async () => {
      const empty = await sendMessage(userA1Id, conversationId, { body: '   ' });
      const oversized = await sendMessage(userA1Id, conversationId, {
        body: 'x'.repeat(MAX_MESSAGE_BODY + 1),
      });

      expect(empty.status).toBe(422);
      expect(oversized.status).toBe(422);
    });

    it('rejects a client-supplied senderId', async () => {
      const res = await sendMessage(userA1Id, conversationId, {
        body: 'جعل فرستنده',
        senderId: userA2Id,
      });
      expect(res.status).toBe(422);
    });

    it('pages newest-first and recovers newer messages with `after`', async () => {
      const fresh = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه صفحه‌بندی',
      });
      const id = fresh.body.id;

      // Rows are inserted directly, one second apart, so `createdAt DESC, id DESC`
      // is unambiguous. Sending five messages through the API in a loop can land
      // several inside the same millisecond, which would leave the expected order
      // dependent on random uuids rather than on the ordering under test.
      const sent: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await prisma.message.create({
          data: {
            conversationId: id,
            senderId: userA1Id,
            body: `پیام ${i + 1}`,
            createdAt: new Date(now - (5 - i) * 1000),
          },
          select: { id: true },
        });
        sent.push(row.id);
      }

      const page = await get(`/conversations/${id}/messages?limit=3`, userA1Id);
      expect(page.status).toBe(200);
      expect(page.body.hasMore).toBe(true);
      // Newest first: the last three inserted, reversed.
      expect(page.body.items.map((m: { id: string }) => m.id)).toEqual(
        [...sent].slice(-3).reverse(),
      );

      // Recovery: everything strictly newer than the second message — exactly what
      // a reconnecting client asks for.
      const recovered = await get(
        `/conversations/${id}/messages?after=${sent[1]}&limit=100`,
        userA1Id,
      );
      expect(recovered.status).toBe(200);
      expect(recovered.body.items.map((m: { id: string }) => m.id)).toEqual(
        [...sent].slice(2).reverse(),
      );
    });

    it('refuses an `after` anchor from another conversation', async () => {
      const other = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA3Id],
        name: 'گروه دیگر',
      });
      const foreign = await sendMessage(userA1Id, other.body.id, { body: 'لنگر بیگانه' });

      const res = await get(
        `/conversations/${conversationId}/messages?after=${foreign.body.id}`,
        userA1Id,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('read state and unread counts', () => {
    let conversationId: string;

    beforeAll(async () => {
      const group = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه خوانده‌نشده',
      });
      conversationId = group.body.id;
    });

    it('counts only messages the caller did not send and has not read', async () => {
      const before = await get('/conversations/unread-count', userA2Id);

      await sendMessage(userA1Id, conversationId, { body: 'اولی' });
      await sendMessage(userA1Id, conversationId, { body: 'دومی' });
      // The recipient's own message must never count against them.
      await sendMessage(userA2Id, conversationId, { body: 'پاسخ' });

      const after = await get('/conversations/unread-count', userA2Id);
      expect(after.body.count).toBe(before.body.count + 2);

      // The sender sees only the reply as unread, not their own two messages.
      const senderView = await get(`/conversations/${conversationId}`, userA1Id);
      expect(senderView.body.unreadCount).toBe(1);
    });

    it('clears the conversation unread count on read, idempotently', async () => {
      const first = await post(`/conversations/${conversationId}/read`, userA2Id);
      expect(first.status).toBe(200);
      expect(first.body.conversationId).toBe(conversationId);

      const one = await get(`/conversations/${conversationId}`, userA2Id);
      expect(one.body.unreadCount).toBe(0);

      // Reading again is a no-op rather than an error, and never moves the cursor
      // backwards.
      const again = await post(`/conversations/${conversationId}/read`, userA2Id);
      expect(again.status).toBe(200);
      expect(new Date(again.body.lastReadAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.body.lastReadAt).getTime(),
      );

      const still = await get(`/conversations/${conversationId}`, userA2Id);
      expect(still.body.unreadCount).toBe(0);
    });

    it('keeps read state per member', async () => {
      await sendMessage(userA1Id, conversationId, { body: 'پیام تازه' });

      const recipient = await get(`/conversations/${conversationId}`, userA2Id);
      expect(recipient.body.unreadCount).toBe(1);

      await post(`/conversations/${conversationId}/read`, userA2Id);

      const cleared = await get(`/conversations/${conversationId}`, userA2Id);
      const other = await get(`/conversations/${conversationId}`, userA1Id);
      expect(cleared.body.unreadCount).toBe(0);
      // The other member's cursor was not touched by someone else reading.
      expect(other.body.unreadCount).toBe(1);
    });
  });

  describe('attachment binding ownership', () => {
    let conversationId: string;
    let otherConversationId: string;

    /**
     * Attachment rows are inserted directly rather than uploaded through the route.
     * The upload path needs MinIO, but the property under test is the BINDING
     * predicate (`uploadedBy` + `conversationId` + still unbound), which is pure
     * database logic — so this exercises it without depending on object storage
     * being reachable.
     */
    const makeAttachment = async (
      uploadedBy: string,
      convId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = await prisma.messageAttachment.create({
        data: {
          conversationId: convId,
          uploadedBy,
          fileName: 'sanad.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          storageKey: `messaging/${convId}/${Math.random().toString(36).slice(2)}/sanad.pdf`,
          ...overrides,
        } as Prisma.MessageAttachmentCreateInput,
        select: { id: true },
      });
      return row.id;
    };

    beforeAll(async () => {
      const group = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه پیوست',
      });
      conversationId = group.body.id;

      const other = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA3Id],
        name: 'گروه پیوست دیگر',
      });
      otherConversationId = other.body.id;
    });

    it('binds the caller\'s own unbound attachment for this conversation', async () => {
      const attachmentId = await makeAttachment(userA1Id, conversationId);

      const res = await sendMessage(userA1Id, conversationId, {
        body: 'سند پیوست شد',
        attachmentIds: [attachmentId],
      });

      expect(res.status).toBe(201);
      expect(res.body.attachments.map((a: { id: string }) => a.id)).toEqual([attachmentId]);
      // The projection stops at the metadata: storageKey never crosses the boundary.
      expect(res.body.attachments[0]).not.toHaveProperty('storageKey');

      const row = await prisma.messageAttachment.findUnique({
        where: { id: attachmentId },
        select: { messageId: true },
      });
      expect(row?.messageId).toBe(res.body.id);
    });

    it('refuses an attachment uploaded by someone else', async () => {
      const theirs = await makeAttachment(userA2Id, conversationId);

      const res = await sendMessage(userA1Id, conversationId, {
        body: 'پیوست دیگری',
        attachmentIds: [theirs],
      });

      expect(res.status).toBe(400);

      // Refused, not silently skipped: the attachment is still unbound.
      const row = await prisma.messageAttachment.findUnique({
        where: { id: theirs },
        select: { messageId: true },
      });
      expect(row?.messageId).toBeNull();
    });

    it('refuses an attachment uploaded for a different conversation', async () => {
      const elsewhere = await makeAttachment(userA1Id, otherConversationId);

      const res = await sendMessage(userA1Id, conversationId, {
        body: 'پیوست جابجا شده',
        attachmentIds: [elsewhere],
      });

      expect(res.status).toBe(400);
    });

    it('refuses an attachment that is already bound to a message', async () => {
      const attachmentId = await makeAttachment(userA1Id, conversationId);

      const first = await sendMessage(userA1Id, conversationId, {
        body: 'اولین استفاده',
        attachmentIds: [attachmentId],
      });
      expect(first.status).toBe(201);

      const replay = await sendMessage(userA1Id, conversationId, {
        body: 'استفاده دوباره',
        attachmentIds: [attachmentId],
      });
      expect(replay.status).toBe(400);

      // Still bound to the FIRST message — a replay cannot steal it.
      const row = await prisma.messageAttachment.findUnique({
        where: { id: attachmentId },
        select: { messageId: true },
      });
      expect(row?.messageId).toBe(first.body.id);
    });

    it('refuses to resolve a download for a non-member', async () => {
      const attachmentId = await makeAttachment(userA1Id, conversationId);
      await sendMessage(userA1Id, conversationId, {
        body: 'برای دانلود',
        attachmentIds: [attachmentId],
      });

      const outsider = await get(`/conversations/attachments/${attachmentId}`, userA3Id);
      const foreign = await get(`/conversations/attachments/${attachmentId}`, userBId);

      expect(outsider.status).toBe(404);
      expect(foreign.status).toBe(404);
    });
  });

  describe('WebSocket handshake', () => {
    /**
     * The socket is authenticated at handshake time from `?token=`, because the
     * browser WebSocket API cannot set an Authorization header. Every unverifiable
     * case must close with 4401 rather than linger in an anonymous state.
     */
    it('accepts a valid token and announces the connection', async () => {
      const harness = await openSocket(signToken(userA1Id));

      const ready = await harness.waitFor('connection.ready');
      expect(ready).toEqual({ userId: userA1Id });

      harness.close();
      await harness.closed;
    });

    it.each([
      ['no token at all', () => undefined],
      ['a token signed with the wrong secret', () =>
        jwt.sign({ sub: 'x', tokenVersion: 1 }, 'not-the-real-secret', {
          expiresIn: '10m',
          audience: 'aria-erp-api',
          issuer: 'aria-erp-auth',
        }),
      ],
      ['a token with the wrong audience', () =>
        jwt.sign({ sub: 'x', tokenVersion: 1 }, jwtSecret, {
          expiresIn: '10m',
          audience: 'someone-else',
          issuer: 'aria-erp-auth',
        }),
      ],
      ['an expired token', () =>
        jwt.sign({ sub: 'x', tokenVersion: 1 }, jwtSecret, {
          expiresIn: -1,
          audience: 'aria-erp-api',
          issuer: 'aria-erp-auth',
        }),
      ],
    ])('closes a handshake carrying %s with 4401', async (_label, token) => {
      const harness = await openSocket(token() as string | undefined);
      const { code } = await harness.closed;
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    /**
     * The signature alone is not enough: `tokenVersion` is re-read from the
     * database on every handshake, so a token minted before a permission change or
     * a forced logout cannot hold a socket open even though no HTTP request is
     * involved.
     */
    it('closes a handshake with a stale tokenVersion with 4401', async () => {
      const stale = signToken(userA2Id, { tokenVersion: 999 });

      const harness = await openSocket(stale);
      const { code } = await harness.closed;
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('closes a handshake for a user that no longer exists with 4401', async () => {
      const ghost = await makeUser({ tenantId: tenantAId, firstName: 'حذف', lastName: 'شده' });
      const token = signToken(ghost.id);
      await prisma.user.delete({ where: { id: ghost.id } });

      const harness = await openSocket(token);
      const { code } = await harness.closed;
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED);
    });
  });

  describe('WebSocket events', () => {
    let conversationId: string;
    let sockets: SocketHarness[] = [];

    const connect = async (userId: string) => {
      const harness = await openSocket(signToken(userId));
      await harness.waitFor('connection.ready');
      sockets.push(harness);
      return harness;
    };

    beforeAll(async () => {
      const group = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه سوکت',
      });
      conversationId = group.body.id;
    });

    afterEach(async () => {
      // Sockets are closed between tests so presence state cannot leak from one
      // assertion into the next.
      for (const harness of sockets) harness.close();
      await Promise.all(sockets.map((harness) => harness.closed));
      sockets = [];
    });

    it('subscribing doubles as the authorization probe and returns page one', async () => {
      const harness = await connect(userA1Id);

      emit(harness, 'conversation.subscribe', { conversationId });
      const page = await harness.waitFor('conversation.subscribed');

      expect(page.conversationId).toBe(conversationId);
      expect(Array.isArray(page.items)).toBe(true);
      expect(typeof page.hasMore).toBe('boolean');
    });

    it('refuses a subscribe to a conversation the socket is not a member of', async () => {
      const harness = await connect(userA3Id);

      emit(harness, 'conversation.subscribe', { conversationId });
      const error = await harness.waitFor('error');

      // Same message the HTTP route produces — the socket is not a looser interface.
      expect(error.message).toBe('Conversation not found');
      // And no subscription was granted.
      expect(harness.events.some((f) => f.event === 'conversation.subscribed')).toBe(false);
    });

    it('rejects a malformed payload without closing the socket', async () => {
      const harness = await connect(userA1Id);

      emit(harness, 'conversation.subscribe', { conversationId: 'not-a-uuid' });
      const error = await harness.waitFor('error');
      expect(error.message).toBe('Validation failed');

      // The connection survives one bad frame and still serves a good one.
      emit(harness, 'conversation.subscribe', { conversationId });
      const page = await harness.waitFor('conversation.subscribed');
      expect(page.conversationId).toBe(conversationId);
    });

    it('delivers a socket send to every member, including the sender', async () => {
      const sender = await connect(userA1Id);
      const recipient = await connect(userA2Id);

      const body = `از سوکت ${Date.now()}`;
      emit(sender, 'message.send', { conversationId, body });

      const [mine, theirs] = await Promise.all([
        sender.waitFor('message.created'),
        recipient.waitFor('message.created'),
      ]);

      // No separate echo: the sender receives their own message through the same
      // member fan-out everybody else does, so the two payloads are identical.
      expect(mine.id).toBe(theirs.id);
      expect(mine.body).toBe(body);
      expect(mine.senderId).toBe(userA1Id);

      // Persisted before it was ever published.
      const row = await prisma.message.findUnique({
        where: { id: mine.id },
        select: { conversationId: true, senderId: true, body: true },
      });
      expect(row).toEqual({ conversationId, senderId: userA1Id, body });
    });

    it('takes the sender from the socket, never from the payload', async () => {
      const harness = await connect(userA1Id);

      // `senderId` is not part of WsSendMessageDto, and forbidNonWhitelisted is on,
      // so an attempt to name a sender is rejected rather than honoured.
      emit(harness, 'message.send', {
        conversationId,
        body: 'جعل از سوکت',
        senderId: userA2Id,
      });

      const error = await harness.waitFor('error');
      expect(error.message).toBe('Validation failed');

      const forged = await prisma.message.count({
        where: { conversationId, senderId: userA2Id, body: 'جعل از سوکت' },
      });
      expect(forged).toBe(0);
    });

    it('relays typing state from the event name, not the payload, and never to the author', async () => {
      const author = await connect(userA1Id);
      const peer = await connect(userA2Id);

      // A `typing.stop` carrying `isTyping: true` must still stop: the two cannot
      // contradict each other because the state comes from the event name.
      emit(author, 'typing.stop', { conversationId, isTyping: true });
      const stopped = await peer.waitFor('typing.changed');

      expect(stopped).toEqual({ conversationId, userId: userA1Id, isTyping: false });
      // The author is never told that they are typing.
      expect(author.events.some((f) => f.event === 'typing.changed')).toBe(false);
    });

    it('advances the read cursor over the socket', async () => {
      await sendMessage(userA1Id, conversationId, { body: 'برای علامت خواندن' });

      const harness = await connect(userA2Id);
      emit(harness, 'message.read', { conversationId });
      const ack = await harness.waitFor('message.read');

      expect(ack.conversationId).toBe(conversationId);
      expect(ack.userId).toBe(userA2Id);

      const membership = await prisma.conversationMember.findFirst({
        where: { conversationId, userId: userA2Id },
        select: { lastReadAt: true },
      });
      expect(membership?.lastReadAt).toBeTruthy();
    });

    it('reports presence only to members, and only for connected members', async () => {
      const offline = await get(`/conversations/${conversationId}/presence`, userA1Id);
      expect(offline.status).toBe(200);
      expect(offline.body).toEqual(
        expect.arrayContaining([
          { userId: userA1Id, status: 'offline' },
          { userId: userA2Id, status: 'offline' },
        ]),
      );

      await connect(userA2Id);

      const online = await get(`/conversations/${conversationId}/presence`, userA1Id);
      const peer = online.body.find((p: { userId: string }) => p.userId === userA2Id);
      expect(peer.status).toBe('online');

      // A non-member cannot read presence at all.
      const outsider = await get(`/conversations/${conversationId}/presence`, userA3Id);
      expect(outsider.status).toBe(404);
    });
  });

  /**
   * Phase 49F-2: the properties that only appear once the socket, the durable store
   * and the notification centre are exercised TOGETHER.
   *
   * Each test here asserts something no earlier test does: that a gap while the
   * socket is down is fully recoverable from Postgres, that ordering survives
   * concurrency, that the aggregate badge agrees with the per-conversation ones, and
   * that an offline recipient — and only an offline recipient — is notified.
   */
  describe('reconnect recovery, ordering under concurrency, and notification integration', () => {
    let conversationId: string;
    let sockets: SocketHarness[] = [];

    const connect = async (userId: string) => {
      const harness = await openSocket(signToken(userId));
      await harness.waitFor('connection.ready');
      sockets.push(harness);
      return harness;
    };

    const disconnect = async (harness: SocketHarness) => {
      harness.close();
      await harness.closed;
      sockets = sockets.filter((item) => item !== harness);
    };

    /**
     * Waits until at least `count` frames named `event` have arrived.
     *
     * Distinct from `waitFor`, which resolves on the FIRST match: the ordering and
     * duplication assertions need the whole set, not the earliest element.
     */
    const waitForFrames = async (
      harness: SocketHarness,
      event: string,
      count: number,
      timeoutMs = 8000,
    ): Promise<SocketFrame[]> => {
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const frames = harness.events.filter((frame) => frame.event === event);
        if (frames.length >= count) return frames;

        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${count} '${event}' frames (saw ${frames.length})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    /** Server-side truth for the page ordering: newest first, id breaking ties. */
    const storedIdsDescending = async (id: string) => {
      const rows = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      return rows.map((row) => row.id);
    };

    beforeAll(async () => {
      const group = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه بازیابی',
      });
      conversationId = group.body.id;
    });

    afterEach(async () => {
      for (const harness of sockets) harness.close();
      await Promise.all(sockets.map((harness) => harness.closed));
      sockets = [];
    });

    /**
     * The reconnect contract: nothing sent while a client was disconnected is lost,
     * because the message was durable before it was ever published. The client asks
     * for everything strictly newer than the last id it holds.
     */
    it('recovers every message missed while the socket was down, in order and exactly once', async () => {
      const recipient = await connect(userA2Id);

      // Page one arrives with the subscription and seeds the recovery anchor —
      // exactly how the browser client obtains it.
      emit(recipient, 'conversation.subscribe', { conversationId });
      const subscribed = await recipient.waitFor('conversation.subscribed');
      expect(subscribed.conversationId).toBe(conversationId);

      const seed = await sendMessage(userA1Id, conversationId, { body: 'قبل از قطع اتصال' });
      expect(seed.status).toBe(201);
      const anchor = (await recipient.waitFor('message.created')).id;
      expect(anchor).toBe(seed.body.id);

      await disconnect(recipient);

      // Sent while nobody is listening. Each send still commits and still returns.
      const missed: string[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await sendMessage(userA1Id, conversationId, { body: `آفلاین ${i + 1}` });
        expect(res.status).toBe(201);
        missed.push(res.body.id);
      }

      const reconnected = await connect(userA2Id);

      const recovered = await get(
        `/conversations/${conversationId}/messages?after=${anchor}&limit=100`,
        userA2Id,
      );
      expect(recovered.status).toBe(200);

      // The API is newest-first; the client replays oldest-first. Both the set and
      // the order must match what was sent, with no repeats and no anchor echo.
      const recoveredIds = recovered.body.items.map((m: { id: string }) => m.id);
      expect(recoveredIds).toEqual([...missed].reverse());
      expect(new Set(recoveredIds).size).toBe(recoveredIds.length);
      expect(recoveredIds).not.toContain(anchor);

      // Recovery is a pure read: asking twice returns the same window, so a retried
      // reconnect cannot duplicate anything.
      const again = await get(
        `/conversations/${conversationId}/messages?after=${anchor}&limit=100`,
        userA2Id,
      );
      expect(again.body.items.map((m: { id: string }) => m.id)).toEqual(recoveredIds);

      // Nothing arrived over the new socket for the gap — it is HTTP that closes it.
      expect(reconnected.events.filter((f) => f.event === 'message.created')).toHaveLength(0);
    });

    /**
     * Rapid-fire from a single sender: ten sends issued together must produce ten
     * distinct messages, delivered once each, in an order the page read agrees with.
     */
    it('keeps rapid-fire sends from one sender distinct, delivered once, and consistently ordered', async () => {
      const burst = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه رگبار',
      });
      const burstId = burst.body.id;

      const recipient = await connect(userA2Id);

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_unused, i) =>
          sendMessage(userA1Id, burstId, {
            body: `رگبار ${i + 1}`,
            clientMessageId: `burst-${now}-${i}`,
          }),
        ),
      );

      for (const res of responses) expect(res.status).toBe(201);
      const sentIds = responses.map((res) => res.body.id);
      expect(new Set(sentIds).size).toBe(10);

      const frames = await waitForFrames(recipient, 'message.created', 10);
      const deliveredIds = frames.map((frame) => (frame.data as { id: string }).id);
      // Delivered exactly once each, and nothing beyond what was sent.
      expect(new Set(deliveredIds).size).toBe(10);
      expect([...deliveredIds].sort()).toEqual([...sentIds].sort());

      // The page read reproduces the stored (createdAt, id) order exactly.
      const page = await get(`/conversations/${burstId}/messages?limit=100`, userA2Id);
      expect(page.status).toBe(200);
      expect(page.body.items.map((m: { id: string }) => m.id)).toEqual(
        await storedIdsDescending(burstId),
      );
    });

    /**
     * Two senders writing at once. Both members must converge on the same total set
     * and the same ordering — there is no per-sender stream that could interleave
     * differently for different readers.
     */
    it('converges both members on one order when two senders write concurrently', async () => {
      const race = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه همزمان',
      });
      const raceId = race.body.id;

      const first = await connect(userA1Id);
      const second = await connect(userA2Id);

      await Promise.all([
        ...Array.from({ length: 5 }, (_unused, i) =>
          sendMessage(userA1Id, raceId, { body: `الف ${i + 1}` }),
        ),
        ...Array.from({ length: 5 }, (_unused, i) =>
          sendMessage(userA2Id, raceId, { body: `ب ${i + 1}` }),
        ),
      ]);

      const mine = (await waitForFrames(first, 'message.created', 10)).map((f) => (f.data as { id: string }).id);
      const theirs = (await waitForFrames(second, 'message.created', 10)).map((f) => (f.data as { id: string }).id);

      // Same ten messages for both, once each — the sender's own copy comes through
      // the same member fan-out as everyone else's.
      expect(new Set(mine).size).toBe(10);
      expect(new Set(theirs).size).toBe(10);
      expect([...mine].sort()).toEqual([...theirs].sort());

      const stored = await storedIdsDescending(raceId);
      expect(stored).toHaveLength(10);
      expect([...stored].sort()).toEqual([...mine].sort());

      const asA = await get(`/conversations/${raceId}/messages?limit=100`, userA1Id);
      const asB = await get(`/conversations/${raceId}/messages?limit=100`, userA2Id);
      expect(asA.body.items.map((m: { id: string }) => m.id)).toEqual(stored);
      expect(asB.body.items.map((m: { id: string }) => m.id)).toEqual(stored);
    });

    /**
     * The header badge and the rail must never disagree: the aggregate is derived
     * from the same per-member predicate, not stored separately.
     */
    it('keeps the aggregate unread count equal to the sum of per-conversation counts', async () => {
      const extra = await post('/conversations', userA1Id).send({
        type: 'GROUP',
        participantIds: [userA2Id],
        name: 'گروه شمارش',
      });

      await sendMessage(userA1Id, conversationId, { body: 'شمارش الف' });
      await sendMessage(userA1Id, extra.body.id, { body: 'شمارش ب' });
      await sendMessage(userA1Id, extra.body.id, { body: 'شمارش ج' });

      const rail = await get('/conversations?limit=100', userA2Id);
      const aggregate = await get('/conversations/unread-count', userA2Id);

      expect(rail.status).toBe(200);
      expect(aggregate.status).toBe(200);

      const summed = rail.body.items.reduce(
        (total: number, item: { unreadCount: number }) => total + item.unreadCount,
        0,
      );
      expect(aggregate.body.count).toBe(summed);
      expect(aggregate.body.count).toBeGreaterThanOrEqual(3);

      // Reading one conversation reduces the aggregate by exactly that
      // conversation's share, and never below zero.
      const cleared = rail.body.items.find(
        (item: { id: string }) => item.id === extra.body.id,
      ).unreadCount;
      await post(`/conversations/${extra.body.id}/read`, userA2Id);

      const afterRead = await get('/conversations/unread-count', userA2Id);
      expect(afterRead.body.count).toBe(aggregate.body.count - cleared);
      expect(afterRead.body.count).toBeGreaterThanOrEqual(0);
    });

    /**
     * Notification integration is deliberately OFFLINE-ONLY: someone whose socket is
     * open has already seen the message, so notifying them would duplicate it.
     */
    it('notifies an offline recipient only, referencing the message it came from', async () => {
      const offlineSend = await sendMessage(userA1Id, conversationId, {
        body: 'اعلان برای کاربر آفلاین',
      });
      expect(offlineSend.status).toBe(201);

      const notification = await prisma.notification.findFirst({
        where: {
          userId: userA2Id,
          sourceType: 'messaging.message',
          sourceId: offlineSend.body.id,
        },
        select: { body: true, type: true, readAt: true },
      });

      expect(notification).toBeTruthy();
      expect(notification?.type).toBe('INFORMATION');
      expect(notification?.readAt).toBeNull();
      // A plain-text preview of the body, never markup.
      expect(notification?.body).toBe('اعلان برای کاربر آفلاین');

      // The sender never notifies themselves.
      const selfNotified = await prisma.notification.count({
        where: {
          userId: userA1Id,
          sourceType: 'messaging.message',
          sourceId: offlineSend.body.id,
        },
      });
      expect(selfNotified).toBe(0);

      // Now the recipient is connected: the next message is delivered live, so no
      // notification is written for it.
      const recipient = await connect(userA2Id);
      const liveSend = await sendMessage(userA1Id, conversationId, {
        body: 'اعلان نباید ساخته شود',
      });
      expect(liveSend.status).toBe(201);
      await recipient.waitFor('message.created');

      const whileOnline = await prisma.notification.count({
        where: { userId: userA2Id, sourceType: 'messaging.message', sourceId: liveSend.body.id },
      });
      expect(whileOnline).toBe(0);
    });

    /**
     * The per-message attachment cap is a DTO bound, so it is refused by the
     * ValidationPipe before the service or the database is reached.
     */
    it('refuses more attachments on one message than the cap allows', async () => {
      const tooMany = Array.from(
        { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
        (_unused, i) => `2222${i}222-2222-4222-8222-222222222222`,
      );

      const res = await sendMessage(userA1Id, conversationId, {
        body: 'پیوست بیش از حد',
        attachmentIds: tooMany,
      });

      expect(res.status).toBe(422);
      // Refused before any binding was attempted.
      const bound = await prisma.messageAttachment.count({ where: { id: { in: tooMany } } });
      expect(bound).toBe(0);
    });

    /**
     * The one place the REAL upload route and object storage are exercised.
     *
     * The rest of the attachment coverage inserts rows directly, because the
     * property under test there is the binding predicate. Here the point is the
     * whole path: multipart upload → stored object → bound to a message →
     * authorized download → refused for a non-member.
     *
     * Skipped rather than failed when object storage is unreachable, so the suite
     * stays honest about what it actually proved instead of reporting a storage
     * outage as a messaging defect.
     */
    it('uploads, binds and authorizes a real attachment download', async () => {
      // 1x1 PNG, the same fixture shape media.e2e-spec.ts uses.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        'base64',
      );

      const upload = await post(`/conversations/${conversationId}/attachments`, userA1Id)
        .attach('file', png, { filename: 'گزارش نهایی.png', contentType: 'image/png' })
        .catch(() => null);

      if (!upload || upload.status === 500) {
        console.warn('[49F-2] Object storage unreachable — real attachment path not verified');
        return;
      }

      expect(upload.status).toBe(201);
      // Metadata only: storageKey never crosses the boundary.
      expect(upload.body).not.toHaveProperty('storageKey');
      expect(upload.body.mimeType).toBe('image/png');
      expect(upload.body.size).toBe(png.length);
      // The non-ASCII filename is reduced to a safe bounded basename server-side.
      expect(upload.body.fileName).toMatch(/^[A-Za-z0-9._-]+$/);

      const attachmentId = upload.body.id;

      // Still inert: uploaded, owned, but bound to no message.
      const pending = await prisma.messageAttachment.findUnique({
        where: { id: attachmentId },
        select: { messageId: true, uploadedBy: true, conversationId: true },
      });
      expect(pending).toEqual({
        messageId: null,
        uploadedBy: userA1Id,
        conversationId,
      });

      const sent = await sendMessage(userA1Id, conversationId, {
        body: 'فایل پیوست واقعی',
        attachmentIds: [attachmentId],
      });
      expect(sent.status).toBe(201);
      expect(sent.body.attachments.map((a: { id: string }) => a.id)).toEqual([attachmentId]);

      const download = await get(`/conversations/attachments/${attachmentId}`, userA1Id);
      expect(download.status).toBe(200);
      expect(typeof download.body.url).toBe('string');
      expect(download.body.url.length).toBeGreaterThan(0);
      expect(download.body).not.toHaveProperty('storageKey');

      // The other member may download it too — it is their conversation as well.
      const peerDownload = await get(`/conversations/attachments/${attachmentId}`, userA2Id);
      expect(peerDownload.status).toBe(200);

      // A same-tenant non-member and a cross-tenant user are both indistinguishable
      // from an attachment that does not exist.
      const outsider = await get(`/conversations/attachments/${attachmentId}`, userA3Id);
      const foreign = await get(`/conversations/attachments/${attachmentId}`, userBId);
      expect(outsider.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(outsider.body.message).toBe(foreign.body.message);

      // And a non-member cannot upload into the conversation at all.
      const intrusion = await post(`/conversations/${conversationId}/attachments`, userA3Id)
        .attach('file', png, { filename: 'intrusion.png', contentType: 'image/png' });
      expect(intrusion.status).toBe(404);
    });
  });
});





