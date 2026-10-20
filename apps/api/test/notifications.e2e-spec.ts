import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/core-client';
import { PrismaModule } from '../src/database/prisma.module';
import { NotificationModule } from '../src/notifications/notification.module';
import { NotificationService } from '../src/notifications/notification.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49E — Notification Center E2E against the real Core database.
 *
 * Modelled on users-directory.e2e-spec.ts: a minimal test guard stands in for
 * JwtAuthGuard so identity comes from a header, while the REAL global
 * TenantContextInterceptor resolves tenantId from the database. Ownership and
 * tenant scope are therefore exercised exactly as in production — nothing in the
 * request can influence either.
 *
 * The controller carries no `@Roles(...)` gate by design (notifications are
 * personal, not an administered resource), so RolesGuard is not part of this
 * module: the only authorization boundary under test is ownership.
 */

const FORBIDDEN_FIELDS = ['userId', 'tenantId', 'user'];

const ALLOWED_FIELDS = [
  'body',
  'createdAt',
  'id',
  'readAt',
  'sourceId',
  'sourceType',
  'title',
  'type',
];

/**
 * Stands in for JwtAuthGuard. Missing header → 401, exactly as an absent or
 * invalid bearer token behaves in production; a present header supplies the same
 * shape jwt.strategy.ts returns (`sub` + `userId`).
 */
class NotificationTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('Notification Center E2E (ownership, tenant isolation, privacy, pagination)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];

  // Tenant A: two users (the caller and a peer). Tenant B: one user.
  let userA1Id: string;
  let userA2Id: string;
  let userBId: string;

  // Notifications owned by userA1 (mixed read state), one owned by the peer and
  // one owned by the tenant B user — both must be invisible to userA1.
  let unreadA1Ids: string[] = [];
  let readA1Id: string;
  let foreignSameTenantId: string;
  let foreignOtherTenantId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `notif-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUsers.push(user.id);
    return user;
  };

  /**
   * Rows are inserted directly (not through createForUser) so `createdAt` is
   * explicit and the ordering assertions are reproducible.
   */
  const makeNotification = async (
    userId: string,
    tenantId: string | null,
    overrides: Record<string, unknown> = {},
  ) => {
    const row = await prisma.notification.create({
      data: {
        userId,
        tenantId,
        type: 'SYSTEM',
        title: 'اطلاع‌رسانی سیستم',
        body: 'یک رویداد در سامانه ثبت شد.',
        ...overrides,
      } as Prisma.NotificationUncheckedCreateInput,
    });
    return row.id;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [NotificationModule, PrismaModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: NotificationTestGuard },
      ],
    })
      // Passport's 'jwt' strategy is not registered in this trimmed test module,
      // so the route-level guard is replaced by a pass-through; authentication is
      // decided by NotificationTestGuard above. Nothing about ownership or
      // tenant scoping is stubbed.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Same pipe configuration as production, so `forbidNonWhitelisted`
    // rejection of an injected userId/tenantId parameter is genuinely exercised.
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
    await app.init();

    prisma = app.get(PrismaService);
    notifications = app.get(NotificationService);

    const tenantA = await prisma.tenant.create({ data: { code: `notif-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `notif-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    userA1Id = (await makeUser({ tenantId: tenantAId, firstName: 'بهار', lastName: 'نوری' })).id;
    userA2Id = (await makeUser({ tenantId: tenantAId, firstName: 'پویا', lastName: 'رستمی' })).id;
    userBId = (await makeUser({ tenantId: tenantBId, firstName: 'ثمین', lastName: 'حیدری' })).id;

    // Five unread rows for userA1, one second apart so `createdAt DESC` is
    // unambiguous, plus one already-read row.
    for (let i = 0; i < 5; i++) {
      unreadA1Ids.push(
        await makeNotification(userA1Id, tenantAId, {
          title: `اعلان ${i + 1}`,
          createdAt: new Date(now - (5 - i) * 1000),
        }),
      );
    }
    // Newest first, matching the API ordering.
    unreadA1Ids = [...unreadA1Ids].reverse();

    readA1Id = await makeNotification(userA1Id, tenantAId, {
      title: 'اعلان خوانده‌شده',
      readAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });

    foreignSameTenantId = await makeNotification(userA2Id, tenantAId, {
      title: 'اعلان همکار',
    });

    foreignOtherTenantId = await makeNotification(userBId, tenantBId, {
      title: 'اعلان مستأجر دیگر',
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });

  describe('authentication', () => {
    it.each([
      ['GET', '/notifications'],
      ['GET', '/notifications/unread-count'],
    ])('rejects an unauthenticated %s %s with 401', async (_method, path) => {
      const res = await get(path);
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated mark-all-read with 401', async () => {
      const res = await post('/notifications/read-all');
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated mark-read with 401', async () => {
      const res = await post(`/notifications/${unreadA1Ids[0]}/read`);
      expect(res.status).toBe(401);
    });

    it('allows an authenticated caller', async () => {
      const res = await get('/notifications', userA1Id);
      expect(res.status).toBe(200);
    });
  });

  describe('ownership visibility', () => {
    it('returns only the caller’s own notifications', async () => {
      const res = await get('/notifications?limit=100', userA1Id);
      expect(res.status).toBe(200);

      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(expect.arrayContaining([...unreadA1Ids, readA1Id]));
      expect(ids).not.toContain(foreignSameTenantId);
      expect(ids).not.toContain(foreignOtherTenantId);
    });

    it('gives a peer in the same tenant a disjoint list', async () => {
      const res = await get('/notifications?limit=100', userA2Id);
      expect(res.status).toBe(200);

      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual([foreignSameTenantId]);
      for (const id of unreadA1Ids) {
        expect(ids).not.toContain(id);
      }
    });

    it('isolates tenants: the tenant B user sees only their own row', async () => {
      const res = await get('/notifications?limit=100', userBId);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([foreignOtherTenantId]);
    });

    it('rejects an injected userId query parameter instead of honouring it', async () => {
      const res = await get(`/notifications?userId=${userA2Id}`, userA1Id);
      expect(res.status).toBe(422);
    });

    it('rejects an injected tenantId query parameter instead of honouring it', async () => {
      const res = await get(`/notifications?tenantId=${tenantBId}`, userA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('response shape', () => {
    it('exposes only the allowlisted fields', async () => {
      const res = await get('/notifications?limit=1', userA1Id);
      expect(res.status).toBe(200);

      const item = res.body.items[0];
      expect(Object.keys(item).sort()).toEqual(ALLOWED_FIELDS);
      for (const field of FORBIDDEN_FIELDS) {
        expect(item).not.toHaveProperty(field);
      }
    });

    it('does not expose total or nextCursor, matching the repository convention', async () => {
      const res = await get('/notifications?limit=2', userA1Id);
      expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items']);
    });
  });

  describe('unread count', () => {
    it('counts only the caller’s unread rows', async () => {
      const res = await get('/notifications/unread-count', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: unreadA1Ids.length });
    });

    it('is scoped per user', async () => {
      const res = await get('/notifications/unread-count', userA2Id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1 });
    });
  });

  describe('state filter', () => {
    it('returns only unread rows', async () => {
      const res = await get('/notifications?state=unread&limit=100', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [...unreadA1Ids].sort(),
      );
      expect(res.body.items.every((i: { readAt: string | null }) => i.readAt === null)).toBe(true);
    });

    it('returns only read rows', async () => {
      const res = await get('/notifications?state=read&limit=100', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([readA1Id]);
    });

    it('rejects an unsupported state', async () => {
      const res = await get('/notifications?state=archived', userA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('pagination and ordering', () => {
    it('orders newest first', async () => {
      const res = await get('/notifications?state=unread&limit=100', userA1Id);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(unreadA1Ids);
    });

    it('paginates with a cursor and reports hasMore', async () => {
      const first = await get('/notifications?limit=2', userA1Id);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const cursor = first.body.items[first.body.items.length - 1].id;
      const second = await get(`/notifications?limit=2&cursor=${cursor}`, userA1Id);
      expect(second.status).toBe(200);

      const firstIds = first.body.items.map((i: { id: string }) => i.id);
      const secondIds = second.body.items.map((i: { id: string }) => i.id);
      // The cursor row itself is skipped, so pages never overlap.
      expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
    });

    it('caps an oversized limit at 100 rather than failing', async () => {
      const res = await get('/notifications?limit=5000', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(100);
    });

    it('rejects a non-numeric limit', async () => {
      const res = await get('/notifications?limit=abc', userA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('mark read', () => {
    it('returns 404 for another user’s notification in the same tenant', async () => {
      const res = await post(`/notifications/${foreignSameTenantId}/read`, userA1Id);
      expect(res.status).toBe(404);

      const row = await prisma.notification.findUnique({
        where: { id: foreignSameTenantId },
        select: { readAt: true },
      });
      expect(row?.readAt).toBeNull();
    });

    it('returns 404 for a notification in another tenant', async () => {
      const res = await post(`/notifications/${foreignOtherTenantId}/read`, userA1Id);
      expect(res.status).toBe(404);
    });

    it('returns the same 404 for an unknown id, revealing nothing', async () => {
      const res = await post('/notifications/00000000-0000-0000-0000-000000000000/read', userA1Id);
      expect(res.status).toBe(404);
    });

    it('marks the caller’s own notification read and is idempotent', async () => {
      const target = unreadA1Ids[unreadA1Ids.length - 1];

      const first = await post(`/notifications/${target}/read`, userA1Id);
      expect(first.status).toBe(200);
      expect(first.body.id).toBe(target);
      expect(first.body.readAt).toBeTruthy();

      const second = await post(`/notifications/${target}/read`, userA1Id);
      expect(second.status).toBe(200);
      // The original timestamp is preserved on repeat.
      expect(second.body.readAt).toBe(first.body.readAt);

      const count = await get('/notifications/unread-count', userA1Id);
      expect(count.body.count).toBe(unreadA1Ids.length - 1);
    });
  });

  describe('mark all read', () => {
    it('clears only the caller’s unread rows', async () => {
      const res = await post('/notifications/read-all', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(unreadA1Ids.length - 1);

      const count = await get('/notifications/unread-count', userA1Id);
      expect(count.body).toEqual({ count: 0 });

      // The peer and the other tenant are untouched.
      const peer = await get('/notifications/unread-count', userA2Id);
      expect(peer.body).toEqual({ count: 1 });
      const other = await get('/notifications/unread-count', userBId);
      expect(other.body).toEqual({ count: 1 });
    });

    it('is safe to repeat', async () => {
      const res = await post('/notifications/read-all', userA1Id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 0 });
    });
  });

  describe('creation boundary', () => {
    it.each([
      ['post', '/notifications'],
      ['put', '/notifications'],
      ['patch', '/notifications'],
      ['delete', '/notifications'],
    ])('exposes no client %s %s route', async (method, path) => {
      const httpMethod = method as 'post' | 'put' | 'patch' | 'delete';
      const res = await request(app.getHttpServer())[httpMethod](path)
        .set('x-user-id', userA1Id)
        .send({ title: 'x', body: 'y', type: 'SYSTEM' });
      expect(res.status).toBe(404);
    });

    it('creates only through the server-side createForUser, snapshotting the recipient tenant', async () => {
      const created = await notifications.createForUser({
        userId: userA1Id,
        type: 'SECURITY',
        title: 'ورود جدید',
        body: 'ورود از یک دستگاه ناشناس ثبت شد.',
        sourceType: 'auth.login',
        sourceId: 'session-1',
      });

      expect(created.id).toBeTruthy();
      expect(created).not.toHaveProperty('userId');
      expect(created).not.toHaveProperty('tenantId');

      const row = await prisma.notification.findUnique({
        where: { id: created.id },
        select: { userId: true, tenantId: true, readAt: true },
      });
      expect(row).toEqual({ userId: userA1Id, tenantId: tenantAId, readAt: null });

      // It is immediately visible to its recipient and to nobody else.
      const mine = await get('/notifications?state=unread&limit=100', userA1Id);
      expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(created.id);
      const peer = await get('/notifications?limit=100', userA2Id);
      expect(peer.body.items.map((i: { id: string }) => i.id)).not.toContain(created.id);
    });

    it('refuses markup in the content', async () => {
      await expect(
        notifications.createForUser({
          userId: userA1Id,
          type: 'SYSTEM',
          title: '<script>alert(1)</script>',
          body: 'متن',
        }),
      ).rejects.toThrow();
    });
  });
});

