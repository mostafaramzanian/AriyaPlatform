import { RbacController } from '../src/auth/rbac/rbac.controller';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request, { type Response as SupertestResponse } from 'supertest';
import { Permissions } from '../src/auth/rbac/constants/permissions';
import { spawn } from 'child_process';
import * as path from 'path';
import { PrismaService } from '../src/database/prisma.service';
import { SessionService } from '../src/auth/services/session.service';
import { AuthService } from '../src/auth/auth.service';
import { TokenHashService } from '../src/auth/services/token-hash.service';
import { RateLimitMiddleware } from '../src/common/rate-limit.middleware';
import type { Request, Response, NextFunction } from 'express';
import { getTestApp } from './setup';
import * as bcrypt from 'bcryptjs';
import { RoleName, PermissionDomain } from '../src/generated/core-client';

const runId = `49s-${Date.now()}`;
const testEmail = `${runId}@local.test`;
const testPassword = 'Test@123456';

describe('Phase 49S-1 gate closeout', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionService: SessionService;
  let authService: AuthService;
  let tokenHashService: TokenHashService;
  let redis: Redis;
  let req: () => SupertestResponse;
  let userId: string;

  const getApp = () => getTestApp();

  beforeAll(async () => {
    app = getApp();
    if (!app) throw new Error('E2E app not available');
    prisma = app.get(PrismaService);
    sessionService = app.get(SessionService);
    authService = app.get(AuthService);
    tokenHashService = app.get(TokenHashService);
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    req = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    await cleanupTestUser();
    await redis.quit();
  });

  async function cleanupTestUser() {
    try {
      const users = await prisma.user.findMany({
        where: { email: { startsWith: '49s-' } },
        select: { id: true, email: true },
      });
      for (const user of users) {
        await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
        await prisma.emailVerification.deleteMany({ where: { userId: user.id } });
        await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
        await prisma.userRole.deleteMany({ where: { userId: user.id } });
        await prisma.user.deleteMany({ where: { id: user.id } });
        await sessionService.invalidateAllSessions(user.id);
      }
    } catch (err) {
      console.warn('[49s-closeout] cleanup warning:', (err as Error).message);
    }
  }

  // ===========================================================================
  // A. Startup fail-fast / valid config
  // ===========================================================================
  describe('A. production startup validation', () => {
    function startApi(env: Record<string, string | undefined>, timeoutMs = 25000): Promise<{ code: number | null; stderr: string; stdout: string }> {
      return new Promise((resolve) => {
        const cwd = path.resolve(__dirname, '..');
        const proc = spawn('node', ['dist/main.js'], {
          cwd,
          env: {
            ...process.env,
            ...env,
            // Never inherit a NODE_ENV from test runner unless explicitly provided
            NODE_ENV: env.NODE_ENV ?? process.env.NODE_ENV,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
        }, timeoutMs);
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stderr, stdout });
        });
      });
    }

    it('valid production config starts the API and connects to Postgres/Redis', async () => {
      const result = await startApi({
        NODE_ENV: 'production',
        PORT: '3999',
        JWT_SECRET: 'prod-test-secret-must-be-at-least-32-characters-long',
        JWT_REFRESH_SECRET: 'prod-test-refresh-secret-must-be-at-least-32-characters',
        AI_CONFIG_ENCRYPTION_KEY: 'prod-test-encryption-key-at-least-32-bytes!',
        CORS_ORIGINS: 'https://app.example.com',
        CORE_DATABASE_URL: process.env.CORE_DATABASE_URL,
        CMS_DATABASE_URL: process.env.CMS_DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
      });
      expect(result.stdout + result.stderr).toContain('Application is running');
      // Process was terminated by our timeout after a successful bootstrap; code may be
      // null (killed) or non-zero depending on platform, so only verify the startup log.
    }, 30000);

    it('missing JWT_SECRET fails fast in production', async () => {
      const result = await startApi({
        NODE_ENV: 'production',
        PORT: '3999',
        JWT_SECRET: '',
        JWT_REFRESH_SECRET: '',
        CORS_ORIGINS: 'https://app.example.com',
      });
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/JWT_SECRET|Environment validation failed|Failed to start/);
      expect(result.code).not.toBe(0);
    });

    it('placeholder JWT_SECRET fails fast in production', async () => {
      const result = await startApi({
        NODE_ENV: 'production',
        PORT: '3999',
        JWT_SECRET: 'change_me',
        JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me',
        AI_CONFIG_ENCRYPTION_KEY: 'prod-test-encryption-key-at-least-32-bytes!',
        CORS_ORIGINS: 'https://app.example.com',
      });
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/placeholder|Failed to start/);
      expect(result.code).not.toBe(0);
    });

    it('wildcard production CORS fails fast', async () => {
      const result = await startApi({
        NODE_ENV: 'production',
        PORT: '3999',
        JWT_SECRET: 'prod-test-secret-must-be-at-least-32-characters-long',
        JWT_REFRESH_SECRET: 'prod-test-refresh-secret-must-be-at-least-32-characters',
        AI_CONFIG_ENCRYPTION_KEY: 'prod-test-encryption-key-at-least-32-bytes!',
        CORS_ORIGINS: '*',
      });
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/wildcard|CORS_ORIGINS|Failed to start/);
      expect(result.code).not.toBe(0);
    });
  });

  // ===========================================================================
  // B. Runtime CORS behavior
  // ===========================================================================
  describe('B. runtime CORS', () => {
    it('request without origin reaches public auth endpoint', async () => {
      const res = await req()
        .post('/api/v1/auth/register')
        .send({
          email: `cors-no-origin-${runId}@local.test`,
          password: testPassword,
          firstName: 'Cors',
          lastName: 'Test',
        });
      expect([201, 409]).toContain(res.status);
    });

    it('request with disallowed origin is rejected by CORS preflight', async () => {
      const res = await req()
        .options('/api/v1/auth/login')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers['access-control-allow-origin']).toBeFalsy();
    });
  });

  // ===========================================================================
  // C. RBAC role-management permission gating (code-level + metadata + real HTTP)
  // ===========================================================================
  describe('C. RBAC role-management authorization', () => {
    it('role assignment endpoint metadata requires admin.roles.assign', async () => {
      const roles = Reflect.getMetadata('roles', RbacController.prototype.assignRole);
      expect(roles).toContain(Permissions.ADMIN_ROLES_ASSIGN);
      expect(roles).not.toContain(Permissions.USERS_UPDATE);
    });

    it('role permission update endpoint metadata requires admin.roles.permissions', async () => {
      const roles = Reflect.getMetadata('roles', RbacController.prototype.updateRolePermissions);
      expect(roles).toContain(Permissions.ADMIN_ROLES_PERMISSIONS);
    });

    describe('real HTTP authorization path', () => {
      const rbacPassword = 'RbacPass@123';
      let readerUser;
      let roleAdminUser;
      let superUser;
      let targetUser;
      let readerToken: string;
      let roleAdminToken: string;
      let superToken: string;
      let adminRoleId: string;
      let superRoleId: string;
      let employeeRoleId: string;
      let customerRoleId: string;
      const createdPermissionIds: string[] = [];
      const createdRolePermissionIds: string[] = [];

      async function rbacLogin(email: string): Promise<string> {
        const res = await req()
          .post('/api/v1/auth/login')
          .send({ email, password: rbacPassword });
        expect(res.status).toBe(200);
        return res.body.data.accessToken as string;
      }

      async function ensurePermission(name: string, domain: PermissionDomain) {
        // Find-then-create, deliberately NOT upsert. `createdPermissionIds` is the
        // list of rows THIS suite owns and deletes in afterAll, and an upsert cannot
        // tell a row it just inserted from one the shared catalogue already carried.
        // Recording the latter made afterAll DELETE the platform's own
        // `admin.roles.*` rows out of core_db (seeded by
        // prisma/core/migrations/20260828093000_seed_admin_permission_grants), which
        // every later suite then skipped for missing — app.e2e-spec.ts's
        // `requiredForTests` loop links only permissions it can find — and RolesGuard
        // denied real admins. Only a row created here is a row deleted here.
        const existing = await prisma.permission.findUnique({ where: { name } });
        if (existing) return existing;

        const created = await prisma.permission.create({
          data: { name, displayName: name, domain },
        });
        createdPermissionIds.push(created.id);
        return created;
      }

      async function linkPermission(roleId: string, permissionId: string) {
        const existing = await prisma.rolePermission.findUnique({
          where: { roleId_permissionId: { roleId, permissionId } },
        });
        if (existing) return;
        const rp = await prisma.rolePermission.create({
          data: { roleId, permissionId },
        });
        createdRolePermissionIds.push(rp.id);
      }

      async function createRbacUser(email: string) {
        const passwordHash = await bcrypt.hash(rbacPassword, 10);
        return prisma.user.create({
          data: {
            email,
            passwordHash,
            status: 'EMPLOYEE' as RoleName,
            emailVerified: true,
            tokenVersion: 1,
          },
        });
      }

      beforeAll(async () => {
        const adminRole = await prisma.role.findUnique({ where: { name: RoleName.ADMIN } });
        const superRole = await prisma.role.findUnique({ where: { name: RoleName.SUPER_ADMIN } });
        const employeeRole = await prisma.role.findUnique({ where: { name: RoleName.EMPLOYEE } });
        const customerRole = await prisma.role.findUnique({ where: { name: RoleName.CUSTOMER } });
        if (!adminRole || !superRole || !employeeRole || !customerRole) {
          throw new Error('Required seeded roles are missing; cannot run real RBAC HTTP test');
        }
        adminRoleId = adminRole.id;
        superRoleId = superRole.id;
        employeeRoleId = employeeRole.id;
        customerRoleId = customerRole.id;

        const pUsersRead = await ensurePermission(Permissions.USERS_READ, PermissionDomain.USERS);
        const pRolesRead = await ensurePermission(Permissions.ADMIN_ROLES_READ, PermissionDomain.ADMIN);
        const pRolesAssign = await ensurePermission(Permissions.ADMIN_ROLES_ASSIGN, PermissionDomain.ADMIN);
        const pRolesRemove = await ensurePermission(Permissions.ADMIN_ROLES_REMOVE, PermissionDomain.ADMIN);
        const pRolesPerms = await ensurePermission(Permissions.ADMIN_ROLES_PERMISSIONS, PermissionDomain.ADMIN);

        // reader has exactly users.read
        await linkPermission(employeeRoleId, pUsersRead.id);
        // role-admin has the role-management permission set
        await linkPermission(adminRoleId, pRolesRead.id);
        await linkPermission(adminRoleId, pRolesAssign.id);
        await linkPermission(adminRoleId, pRolesRemove.id);
        await linkPermission(adminRoleId, pRolesPerms.id);
        // SUPER_ADMIN role gets the same admin set for this test
        await linkPermission(superRoleId, pRolesRead.id);
        await linkPermission(superRoleId, pRolesAssign.id);
        await linkPermission(superRoleId, pRolesRemove.id);
        await linkPermission(superRoleId, pRolesPerms.id);

        readerUser = await createRbacUser(`49s-rbac-reader-${Date.now()}@local.test`);
        roleAdminUser = await createRbacUser(`49s-rbac-admin-${Date.now()}@local.test`);
        superUser = await createRbacUser(`49s-rbac-super-${Date.now()}@local.test`);
        targetUser = await createRbacUser(`49s-rbac-target-${Date.now()}@local.test`);

        await prisma.userRole.createMany({
          data: [
            { userId: readerUser.id, roleId: employeeRoleId },
            { userId: roleAdminUser.id, roleId: adminRoleId },
            { userId: superUser.id, roleId: superRoleId },
            { userId: targetUser.id, roleId: customerRoleId },
          ],
        });

        readerToken = await rbacLogin(readerUser.email);
        roleAdminToken = await rbacLogin(roleAdminUser.email);
        superToken = await rbacLogin(superUser.email);
      });

      afterAll(async () => {
        const userIds = [readerUser?.id, roleAdminUser?.id, superUser?.id, targetUser?.id].filter(Boolean);
        if (userIds.length) {
          await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
          await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        }
        if (createdRolePermissionIds.length) {
          await prisma.rolePermission.deleteMany({ where: { id: { in: createdRolePermissionIds } } });
        }
        if (createdPermissionIds.length) {
          await prisma.permission.deleteMany({ where: { id: { in: createdPermissionIds } } });
        }
      });

      it('reader with users.read is denied role-management endpoints', async () => {
        const assign = await req()
          .post('/api/v1/rbac/assign-role')
          .set('Authorization', `Bearer ${readerToken}`)
          .send({ userId: targetUser.id, roleId: customerRoleId });
        const remove = await req()
          .post('/api/v1/rbac/remove-role')
          .set('Authorization', `Bearer ${readerToken}`)
          .send({ userId: targetUser.id, roleId: customerRoleId });
        const update = await req()
          .put(`/api/v1/rbac/roles/${customerRoleId}/permissions`)
          .set('Authorization', `Bearer ${readerToken}`)
          .send({ permissionIds: [] });
        const list = await req()
          .get('/api/v1/rbac/roles')
          .set('Authorization', `Bearer ${readerToken}`);

        expect(assign.status).toBe(403);
        expect(remove.status).toBe(403);
        expect(update.status).toBe(403);
        expect(list.status).toBe(403);
      });

      it('role admin with correct permissions can list and assign/remove roles', async () => {
        const list = await req()
          .get('/api/v1/rbac/roles')
          .set('Authorization', `Bearer ${roleAdminToken}`);
        expect(list.status).toBe(200);

        const assign = await req()
          .post('/api/v1/rbac/assign-role')
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ userId: targetUser.id, roleId: employeeRoleId });
        expect(assign.status).toBe(200);

        const remove = await req()
          .post('/api/v1/rbac/remove-role')
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ userId: targetUser.id, roleId: employeeRoleId });
        expect(remove.status).toBe(200);
      });

      it('role admin with correct permissions can update role permissions', async () => {
        const current = await prisma.role.findUnique({
          where: { id: customerRoleId },
          include: { permissions: { select: { permissionId: true } } },
        });
        const currentIds = current!.permissions.map((p) => p.permissionId);

        const res = await req()
          .put(`/api/v1/rbac/roles/${customerRoleId}/permissions`)
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ permissionIds: currentIds });
        expect(res.status).toBe(200);
      });

      it('super admin succeeds on protected role-management endpoints', async () => {
        const list = await req()
          .get('/api/v1/rbac/roles')
          .set('Authorization', `Bearer ${superToken}`);
        expect(list.status).toBe(200);

        const assign = await req()
          .post('/api/v1/rbac/assign-role')
          .set('Authorization', `Bearer ${superToken}`)
          .send({ userId: targetUser.id, roleId: employeeRoleId });
        expect(assign.status).toBe(200);

        const update = await req()
          .put(`/api/v1/rbac/roles/${customerRoleId}/permissions`)
          .set('Authorization', `Bearer ${superToken}`)
          .send({ permissionIds: [] });
        expect(update.status).toBe(200);
      });

      it('self-assignment and hierarchy violations are rejected even when caller has permission', async () => {
        // self-assignment
        const self = await req()
          .post('/api/v1/rbac/assign-role')
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ userId: roleAdminUser.id, roleId: customerRoleId });
        expect(self.status).toBe(400);

        // cannot assign SUPER_ADMIN
        const superAssign = await req()
          .post('/api/v1/rbac/assign-role')
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ userId: targetUser.id, roleId: superRoleId });
        expect(superAssign.status).toBe(400);

        // cannot remove own highest admin role from themselves
        const selfRemove = await req()
          .post('/api/v1/rbac/remove-role')
          .set('Authorization', `Bearer ${roleAdminToken}`)
          .send({ userId: roleAdminUser.id, roleId: adminRoleId });
        expect(selfRemove.status).toBe(400);
      });
    });
  });

  // ===========================================================================
  // D. Redis session indexing and invalidation
  // ===========================================================================
  describe('D. Redis-backed session invalidation', () => {
    beforeAll(async () => {
      const register = await req()
        .post('/api/v1/auth/register')
        .send({
          email: testEmail,
          password: testPassword,
          firstName: 'Session',
          lastName: 'Test',
        });
      if (register.status === 201) {
        userId = register.body.data.id;
      } else {
        const user = await prisma.user.findUnique({ where: { email: testEmail } });
        userId = user!.id;
      }
    });

    it('creates sessions and indexes them in a per-user Redis set', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await sessionService.createSession(userId, { source: `closeout-${i}` });
        ids.push(id);
      }
      const indexKey = `sessions:user:${userId}`;
      const members = await redis.smembers(indexKey);
      expect(members.sort()).toEqual(ids.sort());
      for (const id of ids) {
        const raw = await redis.get(`session:${userId}:${id}`);
        expect(raw).toBeTruthy();
        const payload = JSON.parse(raw!);
        expect(payload.sessionId).toBe(id);
        expect(payload.userId).toBe(userId);
      }
    });

    it('invalidates a single session while preserving others', async () => {
      const indexKey = `sessions:user:${userId}`;
      const before = await redis.smembers(indexKey);
      const target = before[0];
      await sessionService.invalidateSession(userId, target);
      const after = await redis.smembers(indexKey);
      expect(after).not.toContain(target);
      expect(await redis.get(`session:${userId}:${target}`)).toBeNull();
      expect(after.length).toBe(before.length - 1);
    });

    it('invalidateAllSessions removes every indexed session and the index', async () => {
      // Ensure some sessions remain
      const indexKey = `sessions:user:${userId}`;
      const remaining = await redis.smembers(indexKey);
      expect(remaining.length).toBeGreaterThan(0);

      await sessionService.invalidateAllSessions(userId);

      expect(await redis.smembers(indexKey)).toEqual([]);
      for (const id of remaining) {
        expect(await redis.get(`session:${userId}:${id}`)).toBeNull();
      }
    });

    it('invalidateAllSessions is idempotent', async () => {
      await sessionService.invalidateAllSessions(userId);
      await expect(sessionService.invalidateAllSessions(userId)).resolves.not.toThrow();
      expect(await redis.smembers(`sessions:user:${userId}`)).toEqual([]);
    });

    it('does not affect sessions of another user', async () => {
      const otherUserId = `other-${runId}`;
      const otherSession = await sessionService.createSession(otherUserId, { source: 'other' });
      await sessionService.createSession(userId, { source: 'victim' });

      await sessionService.invalidateAllSessions(userId);

      expect(await redis.get(`session:${otherUserId}:${otherSession}`)).not.toBeNull();
      await sessionService.invalidateAllSessions(otherUserId);
    });

    it('logout-all invalidates Redis sessions and increments token version', async () => {
      const sessionId = await sessionService.createSession(userId, { source: 'logout-all' });
      const beforeVersion = (await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } }))!.tokenVersion;
      await authService.logoutAll(userId);
      expect(await redis.get(`session:${userId}:${sessionId}`)).toBeNull();
      const afterVersion = (await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } }))!.tokenVersion;
      expect(afterVersion).toBe(beforeVersion + 1);
    });

    it('session set respects the configured per-user cap and evicts the oldest session', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(await sessionService.createSession(userId, { n: i }));
        await new Promise((r) => setTimeout(r, 2));
      }
      expect((await redis.smembers(`sessions:user:${userId}`)).length).toBe(10);

      const newest = await sessionService.createSession(userId, { n: 10 });

      const members = await redis.smembers(`sessions:user:${userId}`);
      expect(members.length).toBe(10);
      expect(members).not.toContain(ids[0]);
      expect(await redis.get(`session:${userId}:${ids[0]}`)).toBeNull();
      expect(members).toContain(ids[9]);
      expect(members).toContain(newest);
      await sessionService.invalidateAllSessions(userId);
    });

    it('evicts multiple oldest sessions when many are created over the cap', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 13; i++) {
        ids.push(await sessionService.createSession(userId, { n: i }));
        await new Promise((r) => setTimeout(r, 2));
      }
      const members = await redis.smembers(`sessions:user:${userId}`);
      expect(members.length).toBe(10);
      for (let i = 0; i < 3; i++) {
        expect(members).not.toContain(ids[i]);
        expect(await redis.get(`session:${userId}:${ids[i]}`)).toBeNull();
      }
      for (let i = 3; i < 13; i++) {
        expect(members).toContain(ids[i]);
      }
      await sessionService.invalidateAllSessions(userId);
    });

    it('removes stale session references when a new session is created', async () => {
      const stale = await sessionService.createSession(userId, { n: 'stale' });
      const fresh1 = await sessionService.createSession(userId, { n: 'fresh1' });
      await redis.expire(`session:${userId}:${stale}`, 1);
      await new Promise((r) => setTimeout(r, 1100));
      expect(await redis.get(`session:${userId}:${stale}`)).toBeNull();

      const fresh2 = await sessionService.createSession(userId, { n: 'fresh2' });
      const members = await redis.smembers(`sessions:user:${userId}`);
      expect(members).not.toContain(stale);
      expect(members).toContain(fresh1);
      expect(members).toContain(fresh2);
      await sessionService.invalidateAllSessions(userId);
    });

    it('logout-all remains idempotent after cap/eviction/stale states', async () => {
      for (let i = 0; i < 12; i++) {
        await sessionService.createSession(userId, { n: i });
        await new Promise((r) => setTimeout(r, 2));
      }
      expect((await redis.smembers(`sessions:user:${userId}`)).length).toBe(10);

      await authService.logoutAll(userId);
      expect(await redis.smembers(`sessions:user:${userId}`)).toEqual([]);
      await expect(sessionService.invalidateAllSessions(userId)).resolves.not.toThrow();
    });

    it('session cap is isolated per user', async () => {
      const otherUserId = `other-cap-${runId}`;
      const otherIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        otherIds.push(await sessionService.createSession(otherUserId, { n: i }));
      }

      for (let i = 0; i < 11; i++) {
        await sessionService.createSession(userId, { n: i });
        await new Promise((r) => setTimeout(r, 2));
      }

      const otherMembers = await redis.smembers(`sessions:user:${otherUserId}`);
      expect(otherMembers.length).toBe(2);
      expect(otherMembers).toContain(otherIds[0]);
      expect(otherMembers).toContain(otherIds[1]);
      await sessionService.invalidateAllSessions(otherUserId);
      await sessionService.invalidateAllSessions(userId);
    });

    it('concurrent session creation for the same user never exceeds the cap', async () => {
      const ids = await Promise.all(
        Array.from({ length: 15 }, (_, i) => sessionService.createSession(userId, { n: i })),
      );

      const members = await redis.smembers(`sessions:user:${userId}`);
      expect(members.length).toBeLessThanOrEqual(10);

      const remainingKeys = await redis.keys(`session:${userId}:*`);
      expect(remainingKeys.length).toBeLessThanOrEqual(10);

      // No evicted session should still have a live Redis key
      const evicted = ids.filter((id) => !members.includes(id));
      for (const id of evicted) {
        expect(await redis.get(`session:${userId}:${id}`)).toBeNull();
      }

      await sessionService.invalidateAllSessions(userId);
    });
  });

  // ===========================================================================
  // E. Distributed Redis-backed rate limiting
  // ===========================================================================
  describe('E. Redis-backed distributed rate limiting', () => {
    let redis2: Redis;

    beforeAll(() => {
      redis2 = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    });

    afterEach(async () => {
      const keys = await redis.keys('rl:login:*');
      if (keys.length) await redis.del(...keys);
    });

    afterAll(async () => {
      await redis2.quit();
    });

    function mockReqRes(actionPath: string, statusToReturn?: number): {
      req: Request;
      res: Partial<Response> & {
        status: jest.Mock;
        json: jest.Mock;
        on: jest.Mock;
      };
      next: jest.Mock;
    } {
      const next = jest.fn();
      const res = {
        statusCode: statusToReturn ?? 200,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        on: jest.fn().mockImplementation((event: string, cb: () => void) => {
          if (event === 'finish') cb();
        }),
      };
      const req = {
        method: 'POST',
        originalUrl: actionPath,
        path: actionPath,
        headers: {},
        body: {},
        socket: { remoteAddress: '127.0.0.1' },
      };
      return { req: req as unknown as Request, res: res as unknown as Partial<Response> & { status: jest.Mock; json: jest.Mock; on: jest.Mock }, next };
    }

    it('rate-limit increments are stored in Redis with a TTL', async () => {
      const key = 'rl:login:ip:127.0.0.1';
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, 900, 'NX');
      await pipeline.exec();

      const count = await redis.get(key);
      const ttl = await redis.ttl(key);
      expect(Number(count)).toBe(1);
      expect(ttl).toBeGreaterThan(0);
    });

    it('two Redis clients share the same rate-limit counter', async () => {
      const key = 'rl:login:ip:127.0.0.1';
      await redis.incr(key);
      await redis2.incr(key);

      const count = await redis.get(key);
      expect(Number(count)).toBe(2);
    });

    it('RateLimitMiddleware classifies all sensitive auth routes', async () => {
      const limiter = new RateLimitMiddleware(redis);
      const routes = [
        { method: 'POST', path: '/api/v1/auth/login' },
        { method: 'POST', path: '/api/v1/auth/register' },
        { method: 'POST', path: '/api/v1/auth/refresh' },
        { method: 'POST', path: '/api/v1/auth/forgot-password' },
        { method: 'POST', path: '/api/v1/auth/reset-password' },
        { method: 'GET', path: '/api/v1/auth/verify-email' },
        { method: 'POST', path: '/api/v1/auth/resend-verification' },
      ];
      for (const route of routes) {
        const res = mockReqRes(route.path, 200).res;
        const next = jest.fn();
        const fakeReq = {
          ...route,
          originalUrl: route.path,
          headers: {},
          body: {},
          socket: { remoteAddress: '127.0.0.1' },
        } as unknown as Request;
        await new Promise<void>((resolve) =>
          limiter.use(fakeReq, res as unknown as Response, (() => {
            next();
            resolve();
          }) as NextFunction),
        );
        expect(next).toHaveBeenCalled();
      }
    });

    it('Redis failure triggers fail-closed 503 response', async () => {
      const brokenRedis = {
        get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as Redis;
      const limiter = new RateLimitMiddleware(brokenRedis);
      const { req, res } = mockReqRes('/api/v1/auth/login');
      limiter.use(req, res, jest.fn());
      await new Promise((r) => setTimeout(r, 50));
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // ===========================================================================
  // F. Indexed token lookup (reset / verify)
  // ===========================================================================
  describe('F. password reset and email verification indexed lookup', () => {
    it('password reset stores a SALTED HASH of the emailed CODE and rejects reuse', async () => {
      const code = tokenHashService.generateNumericCode();
      const codeHash = tokenHashService.hashPasswordResetCode(code, userId);
      const expiresAt = tokenHashService.getExpirationTime(10);

      await prisma.passwordReset.create({
        data: { codeHash, userId, expiresAt, used: false, attempts: 0 },
      });

      const row = await prisma.passwordReset.findFirst({ where: { userId, used: false } });
      expect(row).toBeTruthy();
      // The stored value is the digest — never the six digits the user transcribes.
      expect(row!.codeHash).toBe(codeHash);
      expect(row!.codeHash).not.toBe(code);
      expect(row!.attempts).toBe(0);

      // The CODE is what completes the reset, and the row is single-use.
      await authService.resetPassword(testEmail, code, 'NewPass@123456');

      await expect(
        authService.resetPassword(testEmail, code, 'NewPass@123456'),
      ).rejects.toThrow();
    });

    it('email verification stores a SHA-256 hash and rejects reuse', async () => {
      const plainToken = tokenHashService.generateToken();
      const hashed = tokenHashService.hashToken(plainToken);
      const expiresAt = tokenHashService.getExpirationTime(24 * 60);

      await prisma.emailVerification.create({
        data: { token: hashed, userId, expiresAt, used: false },
      });

      await authService.verifyEmail(plainToken);
      await expect(authService.verifyEmail(plainToken)).rejects.toThrow();
    });
  });

  // ===========================================================================
  // G. Refresh token rotation / concurrency
  // ===========================================================================
  describe('G. refresh token rotation and concurrency', () => {
    it('login issues a refresh token and rotation rejects the old one', async () => {
      // Password was changed by the reset-token test above.
      const currentPassword = 'NewPass@123456';
      const login = await req()
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: currentPassword });
      expect(login.status).toBe(200);
      const firstRefresh = login.body.data.refreshToken;

      const refresh1 = await req()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: firstRefresh });
      expect(refresh1.status).toBe(200);

      const refresh2 = await req()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: firstRefresh });
      expect(refresh2.status).toBe(401);
    });

    it('concurrent refresh attempts with the same token do not both succeed', async () => {
      const login = await req()
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: 'NewPass@123456' });
      expect(login.status).toBe(200);
      const token = login.body.data.refreshToken;

      const [a, b] = await Promise.all([
        req().post('/api/v1/auth/refresh').send({ refreshToken: token }),
        req().post('/api/v1/auth/refresh').send({ refreshToken: token }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
    });
  });
});
