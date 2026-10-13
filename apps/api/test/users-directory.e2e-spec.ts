import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe, UnprocessableEntityException } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
import { UsersModule } from '../src/users/users.module';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { PermissionSource } from '../src/platform/auth/permission-source.contract';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49D-1 — Organization Directory E2E against the real Core database.
 *
 * Modelled on lead-tenant.e2e-spec.ts: a minimal test guard stands in for
 * JwtAuthGuard so identity comes from a header, while the REAL global
 * TenantContextInterceptor resolves tenantId from the database. Tenant scope is
 * therefore exercised exactly as in production — nothing in the request can
 * influence it.
 *
 * The real RolesGuard is registered so the `admin.users.read` gate on the
 * directory routes is enforced here too; the `PermissionSource` the guard now asks
 * (51-HR-ARCH-3A) is stubbed per-test so this suite never mutates shared
 * Role/Permission data.
 */

const FORBIDDEN_FIELDS = [
  'passwordHash',
  'tokenVersion',
  'tenantId',
  'emailVerified',
  'createdAt',
  'updatedAt',
  'refreshTokens',
  'auditLogs',
];

class DirectoryTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (userId) {
      // jwt.strategy.ts returns both `sub` and `userId`; RolesGuard reads `sub`
      // and TenantContextInterceptor reads `userId`.
      (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    }
    return true;
  }
}

describe('Users Directory E2E (tenant isolation, privacy, pagination)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let permissions: { getEffectivePermissions: jest.Mock };

  /**
   * The `PermissionSource` the REAL `RolesGuard` in this module is constructed with.
   * Held by reference (and handed to the module as a `useValue` provider below) rather
   * than looked up with `app.get(PermissionSource)`: RbacModule ALSO binds that token —
   * to the Core-backed `CorePermissionSource` — so a container lookup returns an
   * implementation whose `getEffectivePermissions` is not a spy.
   */
  const permissionSource = { getEffectivePermissions: jest.fn() };

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const created: string[] = [];

  // Tenant A: manager + two reports. Tenant B: one member, plus a user whose
  // managerId points into tenant A (the cross-tenant manager case).
  let managerAId: string;
  let memberA1Id: string;
  let memberA2Id: string;
  let memberBId: string;
  let crossTenantChildId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `dir-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    created.push(user.id);
    return user;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // RbacModule is imported explicitly because the directory routes and the
      // RolesGuard this suite mounts live under it, and because it binds the
      // `PermissionSource` port that RolesGuard injects (51-HR-ARCH-3A).
      // TenantModule binds the `TenantResolver` port the interceptor injects.
      imports: [UsersModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: DirectoryTestGuard },
        // The port the REAL RolesGuard asks, stubbed at the root so the guard
        // mounted below resolves THIS instance and not RbacModule's Core-backed one.
        { provide: PermissionSource, useValue: permissionSource },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector, permissionSource: PermissionSource) =>
            new RolesGuard(reflector, permissionSource),
          inject: [Reflector, PermissionSource],
        },
      ],
    })
      // The directory routes and PATCH /users/me carry `@UseGuards(JwtAuthGuard)`.
      // Passport's 'jwt' strategy is not registered in this trimmed test module, so
      // the guard is replaced by a pass-through; identity still comes from
      // DirectoryTestGuard and authorization is still decided by the REAL
      // RolesGuard below. Nothing about tenant scoping is stubbed.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Same pipe configuration as production, so `forbidNonWhitelisted` rejection
    // of an injected tenantId parameter is genuinely exercised.
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
    permissions = permissionSource;

    const tenantA = await prisma.tenant.create({ data: { code: `dir-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `dir-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const manager = await makeUser({
      tenantId: tenantAId,
      firstName: 'آرش',
      lastName: 'کریمی',
      jobTitle: 'مدیر مالی',
      department: 'مالی',
      extension: '100',
      phone: '021-1000',
    });
    managerAId = manager.id;

    const a1 = await makeUser({
      tenantId: tenantAId,
      firstName: 'بهار',
      lastName: 'نوری',
      jobTitle: 'حسابدار',
      department: 'مالی',
      extension: '201',
      phone: '021-2001',
      managerId: managerAId,
    });
    memberA1Id = a1.id;

    const a2 = await makeUser({
      tenantId: tenantAId,
      firstName: 'پویا',
      lastName: 'رستمی',
      jobTitle: 'کارشناس فروش',
      department: 'فروش',
      extension: '301',
      managerId: managerAId,
    });
    memberA2Id = a2.id;

    const b1 = await makeUser({
      tenantId: tenantBId,
      firstName: 'ثمین',
      lastName: 'حیدری',
      jobTitle: 'حسابدار',
      department: 'مالی',
      extension: '401',
    });
    memberBId = b1.id;

    // Tenant B user pointing at a tenant A manager. The relation is only ever
    // resolved inside the caller's tenant, so this must surface as manager: null.
    const cross = await makeUser({
      tenantId: tenantBId,
      firstName: 'جواد',
      lastName: 'اسدی',
      department: 'فروش',
      managerId: managerAId,
    });
    crossTenantChildId = cross.id;
  });

  beforeEach(() => {
    permissions.getEffectivePermissions.mockResolvedValue(['admin.users.read']);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });

  describe('authorization', () => {
    it('denies an unauthenticated caller', async () => {
      // No x-user-id header → no request.user → RolesGuard rejects.
      const res = await get('/users/directory');
      expect(res.status).toBe(403);
    });

    it('denies a caller without admin.users.read', async () => {
      permissions.getEffectivePermissions.mockResolvedValue(['blog.read']);
      const res = await get('/users/directory', memberA1Id);
      expect(res.status).toBe(403);
    });

    it('allows a caller with admin.users.read', async () => {
      const res = await get('/users/directory', memberA1Id);
      expect(res.status).toBe(200);
    });

    it('rejects an injected tenantId query parameter instead of honouring it', async () => {
      const res = await get(`/users/directory?tenantId=${tenantBId}`, memberA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('tenant isolation', () => {
    it('returns only same-tenant members', async () => {
      const res = await get('/users/directory', memberA1Id);
      expect(res.status).toBe(200);

      const ids = res.body.items.map((item: { id: string }) => item.id);
      expect(ids).toEqual(expect.arrayContaining([managerAId, memberA1Id, memberA2Id]));
      expect(ids).not.toContain(memberBId);
      expect(ids).not.toContain(crossTenantChildId);
    });

    it('does not leak tenant A rows to a tenant B caller', async () => {
      const res = await get('/users/directory', memberBId);
      expect(res.status).toBe(200);

      const ids = res.body.items.map((item: { id: string }) => item.id);
      expect(ids).toEqual(expect.arrayContaining([memberBId, crossTenantChildId]));
      expect(ids).not.toContain(managerAId);
      expect(ids).not.toContain(memberA1Id);
    });

    it('denies cross-tenant detail with 404, not 403, so existence is not revealed', async () => {
      const res = await get(`/users/directory/${memberBId}`, memberA1Id);
      expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown id, identical to the cross-tenant response', async () => {
      const res = await get('/users/directory/00000000-0000-0000-0000-000000000000', memberA1Id);
      expect(res.status).toBe(404);
    });
  });

  describe('privacy / projection', () => {
    it('omits every sensitive field from list rows', async () => {
      const res = await get('/users/directory', memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);

      for (const item of res.body.items) {
        for (const field of FORBIDDEN_FIELDS) {
          expect(item).not.toHaveProperty(field);
        }
      }
    });

    it('omits every sensitive field from the detail payload', async () => {
      const res = await get(`/users/directory/${memberA1Id}`, memberA1Id);
      expect(res.status).toBe(200);

      for (const field of FORBIDDEN_FIELDS) {
        expect(res.body).not.toHaveProperty(field);
      }
    });

    it('returns exactly the approved directory keys', async () => {
      const res = await get(`/users/directory/${memberA1Id}`, memberA1Id);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'avatarUrl',
          'department',
          'email',
          'extension',
          'firstName',
          'id',
          'jobTitle',
          'lastName',
          'manager',
          'managerId',
          'phone',
          'status',
        ].sort(),
      );
    });

    it('exposes only display fields on the nested manager', async () => {
      const res = await get(`/users/directory/${memberA1Id}`, memberA1Id);
      expect(res.body.manager).not.toBeNull();
      expect(Object.keys(res.body.manager).sort()).toEqual(
        ['avatarUrl', 'firstName', 'id', 'jobTitle', 'lastName'].sort(),
      );
    });
  });

  describe('manager relationship', () => {
    it('resolves a same-tenant manager', async () => {
      const res = await get(`/users/directory/${memberA1Id}`, memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.managerId).toBe(managerAId);
      expect(res.body.manager.id).toBe(managerAId);
      expect(res.body.manager.jobTitle).toBe('مدیر مالی');
    });

    it('never resolves a cross-tenant manager, even though managerId is set', async () => {
      const res = await get(`/users/directory/${crossTenantChildId}`, memberBId);
      expect(res.status).toBe(200);
      expect(res.body.managerId).toBe(managerAId);
      // The pointer exists but the row is in another tenant, so nothing about it
      // is disclosed.
      expect(res.body.manager).toBeNull();
    });

    it('rejects a self-referencing manager at the database level', async () => {
      await expect(
        prisma.user.update({ where: { id: memberA2Id }, data: { managerId: memberA2Id } }),
      ).rejects.toThrow();

      const unchanged = await prisma.user.findUnique({
        where: { id: memberA2Id },
        select: { managerId: true },
      });
      expect(unchanged?.managerId).toBe(managerAId);
    });

    it('clears managerId on reports instead of cascading when a manager row is deleted', async () => {
      const doomed = await makeUser({ tenantId: tenantAId, firstName: 'مدیرِ موقت' });
      const child = await makeUser({
        tenantId: tenantAId,
        firstName: 'زیرمجموعه',
        managerId: doomed.id,
      });

      await prisma.user.delete({ where: { id: doomed.id } });

      const survivor = await prisma.user.findUnique({
        where: { id: child.id },
        select: { id: true, managerId: true },
      });
      expect(survivor).not.toBeNull();
      expect(survivor?.managerId).toBeNull();
    });
  });

  describe('search and filters', () => {
    it('finds a member by partial first name', async () => {
      const res = await get(`/users/directory?q=${encodeURIComponent('بهار')}`, memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([memberA1Id]);
    });

    it('finds a member by extension', async () => {
      const res = await get('/users/directory?q=301', memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([memberA2Id]);
    });

    it('finds a member by email fragment', async () => {
      const target = await prisma.user.findUnique({
        where: { id: memberA1Id },
        select: { email: true },
      });
      const res = await get(
        `/users/directory?q=${encodeURIComponent(target!.email.slice(0, 12))}`,
        memberA1Id,
      );
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toContain(memberA1Id);
    });

    it('search never crosses the tenant boundary', async () => {
      // 'حیدری' only exists in tenant B.
      const res = await get(`/users/directory?q=${encodeURIComponent('حیدری')}`, memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.hasMore).toBe(false);
    });

    it('filters by department', async () => {
      const res = await get(
        `/users/directory?department=${encodeURIComponent('فروش')}`,
        memberA1Id,
      );
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([memberA2Id]);
    });

    it('filters by jobTitle', async () => {
      const res = await get(
        `/users/directory?jobTitle=${encodeURIComponent('حسابدار')}`,
        memberA1Id,
      );
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([memberA1Id]);
    });

    it('filters by managerId, returning direct reports of that manager', async () => {
      const res = await get(`/users/directory?managerId=${managerAId}`, memberA1Id);
      expect(res.status).toBe(200);
      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(expect.arrayContaining([memberA1Id, memberA2Id]));
      expect(ids).not.toContain(crossTenantChildId);
    });

    it('rejects an unsupported filter', async () => {
      const res = await get('/users/directory?salary=100', memberA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('pagination', () => {
    it('paginates with a cursor and reports hasMore', async () => {
      const first = await get('/users/directory?limit=2', memberA1Id);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const cursor = first.body.items[first.body.items.length - 1].id;
      const second = await get(`/users/directory?limit=2&cursor=${cursor}`, memberA1Id);
      expect(second.status).toBe(200);

      const firstIds = first.body.items.map((i: { id: string }) => i.id);
      const secondIds = second.body.items.map((i: { id: string }) => i.id);
      // The cursor row itself is skipped, so pages never overlap.
      expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
    });

    it('does not expose total or nextCursor, matching the repository convention', async () => {
      const res = await get('/users/directory?limit=2', memberA1Id);
      expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items']);
    });

    it('caps an oversized limit at 100 rather than failing', async () => {
      const res = await get('/users/directory?limit=5000', memberA1Id);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(100);
    });

    it('rejects a non-numeric limit', async () => {
      const res = await get('/users/directory?limit=abc', memberA1Id);
      expect(res.status).toBe(422);
    });
  });

  describe('self-edit boundary (PATCH /users/me)', () => {
    const patchMe = (userId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer()).patch('/users/me').set('x-user-id', userId).send(body);

    it.each(['department', 'jobTitle', 'extension', 'managerId'])(
      'refuses to let a user set %s on themselves',
      async (field) => {
        const res = await patchMe(memberA1Id, { [field]: 'hijacked' });
        expect(res.status).toBe(422);
      },
    );

    it('leaves the organization attributes unchanged after a rejected attempt', async () => {
      await patchMe(memberA1Id, { department: 'hijacked', jobTitle: 'hijacked' });

      const row = await prisma.user.findUnique({
        where: { id: memberA1Id },
        select: { department: true, jobTitle: true, extension: true, managerId: true },
      });
      expect(row).toEqual({
        department: 'مالی',
        jobTitle: 'حسابدار',
        extension: '201',
        managerId: managerAId,
      });
    });

    it('still allows the approved self-edit fields', async () => {
      const res = await patchMe(memberA1Id, { phone: '021-2002' });
      expect(res.status).toBe(200);

      // Restore, so the directory search assertions above stay reproducible.
      await prisma.user.update({ where: { id: memberA1Id }, data: { phone: '021-2001' } });
    });
  });
});
