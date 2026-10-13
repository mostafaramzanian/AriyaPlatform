import { Test } from '@nestjs/testing';
import { Controller, Get, ExecutionContext, CanActivate, INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { CoreTenantResolver } from './core-tenant-resolver';
import { TenantResolver } from '../platform/auth/tenant-resolver.contract';
import { RequestContextService } from '../common/request-context.service';
import { PrismaService } from '../database/prisma.service';
import type { TrustedTokenClaims } from '../platform/auth/token-contract';

@Controller('test-context')
class TestContextController {
  @Get('tenant')
  getTenantId() {
    const ctx = RequestContextService.get();
    return { tenantId: ctx ? ctx.tenantId : 'unset' };
  }

  @Get('tenant-async')
  async getTenantIdAsync() {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ctx = RequestContextService.get();
    return { tenantId: ctx ? ctx.tenantId : 'unset' };
  }
}

class MockAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string | undefined;
    if (userId) {
      // Phase 51-HR-ARCH-3A: a real guard chain attaches the VERIFIER's claims to the
      // principal. This double reproduces that shape, so the interceptor's resolver sees the
      // same input it sees in production.
      const claimsHeader = req.headers['x-claims'] as string | undefined;
      (req as unknown as { user: Record<string, unknown> }).user = {
        userId,
        email: `${userId}@test.local`,
        role: 'USER',
        claims: claimsHeader ? (JSON.parse(claimsHeader) as TrustedTokenClaims) : null,
      };
    }
    return true;
  }
}

describe('TenantContextInterceptor (integration)', () => {
  let app: INestApplication;

  const userTenantMap: Record<string, string | null> = {
    'user-a': 'tenant-a',
    'user-b': 'tenant-b',
    'global-user': null,
  };

  const mockPrisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const tenantId = userTenantMap[where.id];
        return tenantId !== undefined ? { tenantId } : null;
      }),
    },
  };

  beforeEach(async () => {
    // The Prisma double is shared by every test in this file, so its call history is reset
    // here: "Core was not read" is a per-test claim, and a count that carried over from an
    // earlier test could not support it.
    mockPrisma.user.findUnique.mockClear();

    const moduleRef = await Test.createTestingModule({
      controllers: [TestContextController],
      providers: [
        // Phase 51-HR-ARCH-3A: the interceptor depends on the TenantResolver PORT, and the
        // combined runtime binds Core's implementation — which is what this module doubles.
        { provide: TenantResolver, useClass: CoreTenantResolver },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: MockAuthGuard },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('resolves tenantId for an authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(res.body.tenantId).toBe('tenant-a');
  });

  it('resolves null for a global user', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant')
      .set('x-user-id', 'global-user')
      .expect(200);
    expect(res.body.tenantId).toBeNull();
  });

  it('leaves tenantId unset for unauthenticated requests', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant')
      .expect(200);
    expect(res.body.tenantId).toBe('unset');
  });

  it('preserves tenantId across async boundaries', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant-async')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(res.body.tenantId).toBe('tenant-a');
  });

  it('isolates concurrent requests with different tenants', async () => {
    const [resA, resB] = await Promise.all([
      request(app.getHttpServer()).get('/test-context/tenant-async').set('x-user-id', 'user-a'),
      request(app.getHttpServer()).get('/test-context/tenant-async').set('x-user-id', 'user-b'),
    ]);

    expect(resA.body.tenantId).toBe('tenant-a');
    expect(resB.body.tenantId).toBe('tenant-b');
  });

  /**
   * The property ADR-0006 §B1 is about: at asymmetric trust the tenant comes from the
   * verified `tid` claim and CORE IS NOT READ. The assertion is on the Prisma double, so
   * this test cannot pass if resolution quietly falls back to a query — and the tenant it
   * resolves is one that no row in `userTenantMap` could produce, so a fallback would also
   * have to invent the right answer to pass.
   */
  it('resolves the tenant from verified claims without reading Core', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant')
      .set('x-user-id', 'user-a')
      .set('x-claims', JSON.stringify(asymmetricClaims('claim-tenant')))
      .expect(200);

    expect(res.body.tenantId).toBe('claim-tenant');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  /**
   * The bridge half. A shared-secret token is NOT claim-authoritative: a `tid` on it is
   * ignored and Core answers, exactly as before this phase. Without this test, "the claim
   * wins" could be implemented as "any claim wins", which would let the holder of the shared
   * secret choose their own tenant.
   */
  it('ignores a tid claim on a legacy token and still asks Core', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-context/tenant')
      .set('x-user-id', 'user-a')
      .set('x-claims', JSON.stringify({ ...asymmetricClaims('attacker-tenant'), trust: 'legacy-hmac' }))
      .expect(200);

    expect(res.body.tenantId).toBe('tenant-a');
    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

/** Verified claims as the platform verifier would hand them to a transport. */
function asymmetricClaims(tid: string | null): TrustedTokenClaims {
  const iat = Math.floor(Date.now() / 1000);
  return {
    trust: 'asymmetric',
    sub: 'user-a',
    tid,
    ver: 1,
    perm: [],
    email: null,
    iat,
    nbf: iat,
    exp: iat + 900,
    ttlSeconds: 900,
    kid: 'test-key',
  };
}
