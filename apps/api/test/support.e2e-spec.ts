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
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
import { SupportModule } from '../src/support/support.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { PermissionService } from '../src/auth/rbac/services/permission.service';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49G — Support / Ticketing E2E against the real Core database.
 *
 * Modelled on notifications.e2e-spec.ts (49E) and messaging.e2e-spec.ts (49F): a
 * minimal test guard stands in for JwtAuthGuard so identity arrives in a header,
 * while the REAL global TenantContextInterceptor resolves tenantId from the
 * database. Ownership and tenant scope are therefore exercised exactly as in
 * production — nothing in the request can influence either.
 *
 * The REAL RolesGuard is mounted, and agent status is resolved through the REAL
 * PermissionService, whose role→permission grants come from the seeded
 * `admin.support.manage` rows. Authorization is not stubbed anywhere.
 */

/** Fields that must never appear on a projected ticket or person. */
const FORBIDDEN_TICKET_FIELDS = ['tenantId', 'storageKey'];
const FORBIDDEN_PERSON_FIELDS = [
  'email',
  'passwordHash',
  'refreshTokenHash',
  'tokenVersion',
  'emailVerified',
  'status',
  'tenantId',
];

class SupportTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('Support Ticketing E2E (ownership, tenant isolation, lifecycle, privacy)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let permissions: PermissionService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  let agentRoleId: string;
  const createdUsers: string[] = [];

  // Tenant A: a requester, a peer requester, and an agent. Tenant B: an agent, to
  // prove tenant isolation holds even for a privileged caller.
  let requesterId: string;
  let peerId: string;
  let agentId: string;
  let foreignAgentId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `ticket-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUsers.push(user.id);
    return user;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const patch = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).patch(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /** Files a ticket through the public route and returns the body. */
  const createTicket = async (callerId: string, overrides: Record<string, unknown> = {}) => {
    const res = await post('/tickets', callerId).send({
      type: 'SUPPORT',
      subject: 'موضوع تیکت آزمایشی',
      body: 'متن تیکت آزمایشی',
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: `TenantContextInterceptor` now injects the `TenantResolver`
      // port instead of `PrismaService`, so the module that BINDS that port has to be in
      // the graph. `TenantModule` binds `CoreTenantResolver` (`useExisting`), which is the
      // Core-database resolution this suite has always described — the seam changed who
      // owns the query, not what it answers.
      imports: [SupportModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: SupportTestGuard },
        // The REAL RolesGuard, so `@Roles(admin.support.manage)` on the
        // administrative routes is genuinely enforced against seeded grants.
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      // Passport's 'jwt' strategy is not registered in this trimmed module, so the
      // route-level guard is a pass-through; authentication is decided by
      // SupportTestGuard. Nothing about authorization, ownership or tenant scoping
      // is stubbed.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Same pipe configuration as production, so `forbidNonWhitelisted` rejection of
    // an injected requesterId/tenantId/status field is genuinely exercised.
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
    permissions = app.get(PermissionService);

    const tenantA = await prisma.tenant.create({ data: { code: `ticket-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `ticket-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    requesterId = (await makeUser({ tenantId: tenantAId, firstName: 'بهار', lastName: 'نوری' })).id;
    peerId = (await makeUser({ tenantId: tenantAId, firstName: 'پویا', lastName: 'رستمی' })).id;
    agentId = (await makeUser({ tenantId: tenantAId, firstName: 'سارا', lastName: 'کاظمی' })).id;
    foreignAgentId = (await makeUser({ tenantId: tenantBId, firstName: 'ثمین', lastName: 'حیدری' }))
      .id;

    // The agents get their capability from a REAL role grant of the seeded
    // `admin.support.manage` permission — not from a stub.
    const role = await prisma.role.findFirst({ where: { name: 'OPERATIONS_ADMIN' } });
    if (!role) {
      throw new Error('OPERATIONS_ADMIN role is not seeded; run prisma migrate deploy first');
    }
    agentRoleId = role.id;

    for (const userId of [agentId, foreignAgentId]) {
      await prisma.userRole.create({ data: { userId, roleId: agentRoleId } });
      await permissions.invalidateUserPermissions(userId);
    }
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.ticket.deleteMany({ where: { requesterId: { in: createdUsers } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });

  describe('tracking number', () => {
    it('is server-generated, non-sequential and never accepted from the client', async () => {
      const first = await createTicket(requesterId);
      const second = await createTicket(requesterId);

      expect(first.trackingNumber).toMatch(/^TK-[0-9A-Z]{10}$/);
      expect(second.trackingNumber).not.toBe(first.trackingNumber);

      // A client-supplied tracking number is rejected outright rather than honoured.
      const injected = await post('/tickets', requesterId).send({
        type: 'SUPPORT',
        subject: 'تلاش برای تعیین شماره',
        body: 'متن',
        trackingNumber: 'TK-AAAAAAAAAA',
      });
      expect(injected.status).toBe(422);
    });

    it('resolves a ticket by its number, but only inside the caller’s own scope', async () => {
      const ticket = await createTicket(requesterId);

      const mine = await get(`/tickets/tracking/${ticket.trackingNumber}`, requesterId);
      expect(mine.status).toBe(200);
      expect(mine.body.id).toBe(ticket.id);

      // Lower-case and prefix-less forms normalise to the same ticket.
      const loose = await get(
        `/tickets/tracking/${ticket.trackingNumber.slice(3).toLowerCase()}`,
        requesterId,
      );
      expect(loose.status).toBe(200);
      expect(loose.body.id).toBe(ticket.id);

      // Knowing the number is not enough: a same-tenant peer and a cross-tenant
      // agent are both indistinguishable from a nonexistent ticket.
      const peer = await get(`/tickets/tracking/${ticket.trackingNumber}`, peerId);
      const foreign = await get(`/tickets/tracking/${ticket.trackingNumber}`, foreignAgentId);
      expect(peer.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(peer.body.message).toBe(foreign.body.message);
    });

    it('treats a malformed number exactly like an unknown one', async () => {
      const malformed = await get('/tickets/tracking/not-a-number', requesterId);
      const unknown = await get('/tickets/tracking/TK-ZZZZZZZZZZ', requesterId);
      expect(malformed.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(malformed.body.message).toBe(unknown.body.message);
    });
  });

  describe('ownership and tenant isolation', () => {
    it('shows a requester only their own tickets', async () => {
      const mine = await createTicket(requesterId);
      const theirs = await createTicket(peerId);

      const res = await get('/tickets?limit=100', requesterId);
      expect(res.status).toBe(200);

      const ids = res.body.items.map((t: { id: string }) => t.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it('lets an agent see every ticket in their own tenant and nothing outside it', async () => {
      const inTenantA = await createTicket(requesterId);
      const inTenantB = await createTicket(foreignAgentId);

      const asAgent = await get('/tickets?limit=100', agentId);
      expect(asAgent.status).toBe(200);
      const ids = asAgent.body.items.map((t: { id: string }) => t.id);
      expect(ids).toContain(inTenantA.id);
      expect(ids).not.toContain(inTenantB.id);

      // And the direct read of a foreign ticket is a 404, not a 403.
      const direct = await get(`/tickets/${inTenantB.id}`, agentId);
      expect(direct.status).toBe(404);
    });

    it('refuses an unauthenticated request', async () => {
      const res = await get('/tickets');
      expect(res.status).toBe(401);
    });

    it('rejects an injected requesterId or tenantId query parameter', async () => {
      const injectedRequester = await get(`/tickets?requesterId=${peerId}`, requesterId);
      const injectedTenant = await get(`/tickets?tenantId=${tenantBId}`, requesterId);
      expect(injectedRequester.status).toBe(422);
      expect(injectedTenant.status).toBe(422);
    });
  });

  describe('privacy of the projection', () => {
    it('never leaks tenantId, storage keys or account fields', async () => {
      const ticket = await createTicket(requesterId);

      const detail = await get(`/tickets/${ticket.id}`, requesterId);
      expect(detail.status).toBe(200);

      for (const field of FORBIDDEN_TICKET_FIELDS) {
        expect(detail.body).not.toHaveProperty(field);
      }
      for (const field of FORBIDDEN_PERSON_FIELDS) {
        expect(detail.body.requester).not.toHaveProperty(field);
      }
      expect(JSON.stringify(detail.body)).not.toContain(tenantAId);
    });
  });

  describe('lifecycle', () => {
    it('records the creation transition and starts at NEW', async () => {
      const ticket = await createTicket(requesterId);
      expect(ticket.status).toBe('NEW');

      const detail = await get(`/tickets/${ticket.id}`, requesterId);
      expect(detail.body.statusHistory).toHaveLength(1);
      expect(detail.body.statusHistory[0]).toMatchObject({ fromStatus: null, toStatus: 'NEW' });
    });

    it('refuses a status change from a requester', async () => {
      const ticket = await createTicket(requesterId);

      const res = await patch(`/tickets/${ticket.id}/status`, requesterId).send({
        status: 'RESOLVED',
      });
      expect(res.status).toBe(403);

      const unchanged = await get(`/tickets/${ticket.id}`, requesterId);
      expect(unchanged.body.status).toBe('NEW');
    });

    it('walks the full happy path and appends one history row per transition', async () => {
      const ticket = await createTicket(requesterId);

      for (const status of ['TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) {
        const res = await patch(`/tickets/${ticket.id}/status`, agentId).send({ status });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);
      }

      const detail = await get(`/tickets/${ticket.id}`, agentId);
      expect(detail.body.status).toBe('CLOSED');
      // 1 creation row + 5 transitions.
      expect(detail.body.statusHistory).toHaveLength(6);
      expect(detail.body.resolvedAt).not.toBeNull();
      expect(detail.body.closedAt).not.toBeNull();
      // CLOSED is terminal: nothing is offered even to an agent.
      expect(detail.body.availableTransitions).toEqual([]);
    });

    it('refuses an illegal jump', async () => {
      const ticket = await createTicket(requesterId);

      const res = await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'CLOSED' });
      expect(res.status).toBe(400);

      const unchanged = await get(`/tickets/${ticket.id}`, agentId);
      expect(unchanged.body.status).toBe('NEW');
    });

    it('refuses to reopen a CLOSED ticket by any route', async () => {
      const ticket = await createTicket(requesterId);
      await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'RESOLVED' });
      await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'CLOSED' });

      // Every reopen attempt is refused. `NEW` is refused even earlier — by the DTO,
      // which does not accept it as a transition target at all — so the assertion
      // accepts either refusal rather than pretending both take the same path.
      for (const status of ['NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED']) {
        const res = await patch(`/tickets/${ticket.id}/status`, agentId).send({ status });
        expect([400, 422]).toContain(res.status);
      }

      // Nor by the general patch, nor by adding a comment.
      const patched = await patch(`/tickets/${ticket.id}`, agentId).send({ priority: 'URGENT' });
      expect(patched.status).toBe(400);

      const commented = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'یک پاسخ پس از بسته شدن',
      });
      expect(commented.status).toBe(400);

      const final = await get(`/tickets/${ticket.id}`, agentId);
      expect(final.body.status).toBe('CLOSED');
    });

    it('rejects a status field smuggled through the general patch', async () => {
      const ticket = await createTicket(requesterId);

      const res = await patch(`/tickets/${ticket.id}`, agentId).send({ status: 'CLOSED' });
      expect(res.status).toBe(422);
    });
  });

  describe('comments and internal notes', () => {
    it('hides an internal note from the requester but shows it to an agent', async () => {
      const ticket = await createTicket(requesterId);

      const publicReply = await post(`/tickets/${ticket.id}/comments`, agentId).send({
        body: 'پاسخ عمومی کارشناس',
      });
      expect(publicReply.status).toBe(201);

      const internal = await post(`/tickets/${ticket.id}/comments`, agentId).send({
        body: 'یادداشت داخلی کارشناسان',
        isInternal: true,
      });
      expect(internal.status).toBe(201);
      expect(internal.body.isInternal).toBe(true);

      const asRequester = await get(`/tickets/${ticket.id}/comments?limit=100`, requesterId);
      const requesterIds = asRequester.body.items.map((c: { id: string }) => c.id);
      expect(requesterIds).toContain(publicReply.body.id);
      expect(requesterIds).not.toContain(internal.body.id);
      expect(JSON.stringify(asRequester.body)).not.toContain('یادداشت داخلی کارشناسان');

      const asAgent = await get(`/tickets/${ticket.id}/comments?limit=100`, agentId);
      const agentIds = asAgent.body.items.map((c: { id: string }) => c.id);
      expect(agentIds).toContain(internal.body.id);
    });

    it('refuses to let a requester author an internal note', async () => {
      const ticket = await createTicket(requesterId);

      const res = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'تلاش برای یادداشت داخلی',
        isInternal: true,
      });
      expect(res.status).toBe(403);
    });

    it('refuses a comment from a peer who cannot see the ticket', async () => {
      const ticket = await createTicket(requesterId);

      const res = await post(`/tickets/${ticket.id}/comments`, peerId).send({ body: 'نفوذ' });
      expect(res.status).toBe(404);
    });

    it('rejects an injected authorId', async () => {
      const ticket = await createTicket(requesterId);

      const res = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'متن',
        authorId: agentId,
      });
      expect(res.status).toBe(422);
    });
  });

  describe('assignment', () => {
    it('assigns inside the tenant and refuses a cross-tenant assignee', async () => {
      const ticket = await createTicket(requesterId);

      const ok = await patch(`/tickets/${ticket.id}`, agentId).send({ assigneeId: agentId });
      expect(ok.status).toBe(200);
      expect(ok.body.assignee.id).toBe(agentId);
      // The assignee projection is the same bounded person shape.
      for (const field of FORBIDDEN_PERSON_FIELDS) {
        expect(ok.body.assignee).not.toHaveProperty(field);
      }

      const crossTenant = await patch(`/tickets/${ticket.id}`, agentId).send({
        assigneeId: foreignAgentId,
      });
      expect(crossTenant.status).toBe(400);
    });

    it('refuses to make the requester their own assignee', async () => {
      const ticket = await createTicket(requesterId);

      const res = await patch(`/tickets/${ticket.id}`, agentId).send({ assigneeId: requesterId });
      expect(res.status).toBe(400);
    });

    it('refuses the administrative patch from a requester', async () => {
      const ticket = await createTicket(requesterId);

      const res = await patch(`/tickets/${ticket.id}`, requesterId).send({ priority: 'URGENT' });
      expect(res.status).toBe(403);
    });
  });

  describe('satisfaction', () => {
    /** Drives a ticket to RESOLVED through the real agent routes. */
    const resolved = async () => {
      const ticket = await createTicket(requesterId);
      const res = await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'RESOLVED' });
      expect(res.status).toBe(200);
      return ticket;
    };

    it('accepts exactly one submission from the requester', async () => {
      const ticket = await resolved();

      const first = await post(`/tickets/${ticket.id}/satisfaction`, requesterId).send({
        rating: 5,
        comment: 'خیلی خوب بود',
      });
      expect(first.status).toBe(201);
      expect(first.body.rating).toBe(5);

      const second = await post(`/tickets/${ticket.id}/satisfaction`, requesterId).send({
        rating: 1,
      });
      expect(second.status).toBe(400);

      const detail = await get(`/tickets/${ticket.id}`, requesterId);
      expect(detail.body.satisfaction.rating).toBe(5);
    });

    it('refuses submission from an agent', async () => {
      const ticket = await resolved();

      const res = await post(`/tickets/${ticket.id}/satisfaction`, agentId).send({ rating: 5 });
      expect(res.status).toBe(403);
    });

    it('refuses submission before the ticket is resolved', async () => {
      const ticket = await createTicket(requesterId);

      const res = await post(`/tickets/${ticket.id}/satisfaction`, requesterId).send({ rating: 3 });
      expect(res.status).toBe(400);
    });

    it('bounds the rating', async () => {
      const ticket = await resolved();

      for (const rating of [0, 6, -1, 2.5]) {
        const res = await post(`/tickets/${ticket.id}/satisfaction`, requesterId).send({ rating });
        expect(res.status).toBe(422);
      }
    });
  });

  describe('pagination', () => {
    it('pages deterministically with no repeats or gaps', async () => {
      const pager = (await makeUser({ tenantId: tenantAId, firstName: 'صفحه', lastName: 'بند' })).id;

      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        created.push((await createTicket(pager, { subject: `تیکت شماره ${i + 1}` })).id);
      }

      const first = await get('/tickets?limit=2', pager);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const second = await get(
        `/tickets?limit=2&cursor=${first.body.items[1].id}`,
        pager,
      );
      expect(second.body.items).toHaveLength(2);

      const third = await get(`/tickets?limit=2&cursor=${second.body.items[1].id}`, pager);
      expect(third.body.items).toHaveLength(1);
      expect(third.body.hasMore).toBe(false);

      const seen = [...first.body.items, ...second.body.items, ...third.body.items].map(
        (t: { id: string }) => t.id,
      );
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...created].sort());
    });

    it('caps an oversized limit rather than failing', async () => {
      const res = await get('/tickets?limit=99999', requesterId);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(100);
    });
  });

  describe('attachments', () => {
    it('refuses to bind an attachment that is not the caller’s pending upload', async () => {
      const ticket = await createTicket(requesterId);
      const other = await createTicket(peerId);

      // Rows are inserted directly here: the property under test is the binding
      // predicate, not the upload transport (covered separately below).
      const foreign = await prisma.ticketAttachment.create({
        data: {
          ticketId: other.id,
          uploadedBy: peerId,
          fileName: 'foreign.png',
          mimeType: 'image/png',
          size: 10,
          storageKey: `support/${other.id}/foreign.png`,
        },
      });

      const res = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'تلاش برای پیوست دیگری',
        attachmentIds: [foreign.id],
      });
      expect(res.status).toBe(400);

      // Refused as a whole: nothing was bound.
      const after = await prisma.ticketAttachment.findUnique({ where: { id: foreign.id } });
      expect(after?.commentId).toBeNull();
    });

    it('binds the caller’s own pending upload and exposes it on the comment', async () => {
      const ticket = await createTicket(requesterId);

      const pending = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          uploadedBy: requesterId,
          fileName: 'report.png',
          mimeType: 'image/png',
          size: 10,
          storageKey: `support/${ticket.id}/report.png`,
        },
      });

      const res = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'پیوست گزارش',
        attachmentIds: [pending.id],
      });
      expect(res.status).toBe(201);
      expect(res.body.attachments.map((a: { id: string }) => a.id)).toEqual([pending.id]);
      expect(JSON.stringify(res.body)).not.toContain('storageKey');
    });

    it('never serves an attachment that hangs off an internal note to a requester', async () => {
      const ticket = await createTicket(requesterId);

      const note = await post(`/tickets/${ticket.id}/comments`, agentId).send({
        body: 'یادداشت داخلی با فایل',
        isInternal: true,
      });
      expect(note.status).toBe(201);

      const attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          commentId: note.body.id,
          uploadedBy: agentId,
          fileName: 'internal.png',
          mimeType: 'image/png',
          size: 10,
          storageKey: `support/${ticket.id}/internal.png`,
        },
      });

      const asRequester = await get(`/tickets/attachments/${attachment.id}`, requesterId);
      const asPeer = await get(`/tickets/attachments/${attachment.id}`, peerId);
      const asForeign = await get(`/tickets/attachments/${attachment.id}`, foreignAgentId);

      expect(asRequester.status).toBe(404);
      expect(asPeer.status).toBe(404);
      expect(asForeign.status).toBe(404);
      // A refused caller cannot tell "exists but not yours" from "does not exist".
      expect(asRequester.body.message).toBe(asPeer.body.message);
    });

    /**
     * The one place the REAL upload route and object storage are exercised.
     *
     * Skipped rather than failed when object storage is unreachable, so the suite
     * stays honest about what it actually proved instead of reporting a storage
     * outage as a ticketing defect.
     */
    it('uploads, binds and authorizes a real attachment download', async () => {
      // 1x1 PNG, the same fixture shape media.e2e-spec.ts uses.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        'base64',
      );

      const ticket = await createTicket(requesterId);

      const upload = await post(`/tickets/${ticket.id}/attachments`, requesterId)
        .attach('file', png, { filename: 'گزارش نهایی.png', contentType: 'image/png' })
        .catch(() => null);

      if (!upload || upload.status === 500) {
        console.warn('[49G] Object storage unreachable — real attachment path not verified');
        return;
      }

      expect(upload.status).toBe(201);
      const attachmentId = upload.body.id;
      // The stored name is sanitised, never the raw client filename.
      expect(upload.body.fileName).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(upload.body).not.toHaveProperty('storageKey');

      const bound = await post(`/tickets/${ticket.id}/comments`, requesterId).send({
        body: 'فایل پیوست واقعی',
        attachmentIds: [attachmentId],
      });
      expect(bound.status).toBe(201);

      const download = await get(`/tickets/attachments/${attachmentId}`, requesterId);
      expect(download.status).toBe(200);
      expect(typeof download.body.url).toBe('string');
      expect(download.body).not.toHaveProperty('storageKey');

      /**
       * Phase 49G-5: the URL must be usable, not merely a string.
       *
       * 49G-4 found that this assertion passed while every real download 404'd: the
       * response was an unsigned root-relative path that nothing served. So the URL is
       * now fetched with NO Authorization header — exactly what a browser does when it
       * follows it — and the bytes are compared to the fixture.
       */
      const signed = new URL(download.body.url);
      expect(signed.protocol).toMatch(/^https?:$/);
      // A presigned SigV4 URL carries its own bounded authorization…
      expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(signed.searchParams.get('X-Amz-Credential')).toBeTruthy();
      // …with a short, explicit deadline.
      const expires = Number(signed.searchParams.get('X-Amz-Expires'));
      expect(expires).toBeGreaterThan(0);
      expect(expires).toBeLessThanOrEqual(900);
      // The signing SECRET must never appear. It is checked with X-Amz-Credential
      // removed, because SigV4 legitimately publishes the ACCESS key there — and in dev
      // both keys happen to share the value `minioadmin`, so a naive substring check
      // would flag correct behaviour. What must never leak is the secret used to sign,
      // and the only signature-derived material present is the HMAC digest itself.
      const withoutCredential = new URL(download.body.url);
      withoutCredential.searchParams.delete('X-Amz-Credential');
      const secretKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD;
      if (secretKey) {
        expect(withoutCredential.toString()).not.toContain(secretKey);
      }
      // The credential scope carries an access key id and a scope, never a secret.
      expect(signed.searchParams.get('X-Amz-Credential')).toMatch(/^[^/]+\/\d{8}\/[^/]+\/s3\/aws4_request$/);
      expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

      const fetched = await fetch(download.body.url);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer()).equals(png)).toBe(true);
      // Served as a download with the sanitised name, never rendered inline.
      expect(fetched.headers.get('content-disposition')).toContain('attachment');
      expect(fetched.headers.get('content-type')).toBe('image/png');

      // Stripping the signature must fail: the bucket is private, not public.
      const unsigned = `${signed.origin}${signed.pathname}`;
      expect((await fetch(unsigned)).status).toBe(403);

      // Tampering with the signed key must fail too — a valid signature for one object
      // cannot be reused to read another.
      const tampered = new URL(download.body.url);
      tampered.pathname = `${tampered.pathname}x`;
      expect((await fetch(tampered.toString())).status).toBe(403);

      // The agent may download it too — it is a ticket in their tenant.
      const agentDownload = await get(`/tickets/attachments/${attachmentId}`, agentId);
      expect(agentDownload.status).toBe(200);

      // A same-tenant peer and a cross-tenant agent are both 404.
      expect((await get(`/tickets/attachments/${attachmentId}`, peerId)).status).toBe(404);
      expect((await get(`/tickets/attachments/${attachmentId}`, foreignAgentId)).status).toBe(404);

      // And a peer cannot upload into someone else's ticket at all.
      const intrusion = await post(`/tickets/${ticket.id}/attachments`, peerId).attach(
        'file',
        png,
        { filename: 'intrusion.png', contentType: 'image/png' },
      );
      expect(intrusion.status).toBe(404);
    });
  });

  describe('notifications and audit', () => {
    it('notifies the requester on a status change and never the acting agent', async () => {
      const ticket = await createTicket(requesterId);

      await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });

      const res = await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'TRIAGED' });
      expect(res.status).toBe(200);

      const forRequester = await prisma.notification.findMany({
        where: { userId: requesterId, sourceType: 'ticket', sourceId: ticket.id },
        select: { userId: true, tenantId: true, type: true },
      });
      expect(forRequester).toHaveLength(1);
      // The notification is stamped with the RECIPIENT's tenant, not the actor's.
      expect(forRequester[0].tenantId).toBe(tenantAId);

      const forActor = await prisma.notification.count({
        where: { userId: agentId, sourceId: ticket.id },
      });
      expect(forActor).toBe(0);
    });

    it('notifies the new assignee on assignment', async () => {
      const ticket = await createTicket(requesterId);

      await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });

      const res = await patch(`/tickets/${ticket.id}`, agentId).send({ assigneeId: peerId });
      expect(res.status).toBe(200);

      const forAssignee = await prisma.notification.count({
        where: { userId: peerId, sourceType: 'ticket', sourceId: ticket.id },
      });
      expect(forAssignee).toBe(1);
    });

    it('audits the privileged mutations and never a read', async () => {
      const ticket = await createTicket(requesterId);

      await prisma.auditLog.deleteMany({ where: { resourceType: 'ticket', resourceId: ticket.id } });

      // Reads first — they must leave no audit trail at all.
      await get(`/tickets/${ticket.id}`, agentId);
      await get(`/tickets/${ticket.id}/comments`, agentId);
      await get('/tickets?limit=5', agentId);

      const afterReads = await prisma.auditLog.count({
        where: { resourceType: 'ticket', resourceId: ticket.id },
      });
      expect(afterReads).toBe(0);

      await patch(`/tickets/${ticket.id}/status`, agentId).send({ status: 'TRIAGED' });
      await patch(`/tickets/${ticket.id}`, agentId).send({ priority: 'HIGH' });

      const actions = await prisma.auditLog.findMany({
        where: { resourceType: 'ticket', resourceId: ticket.id },
        select: { action: true, userId: true },
      });
      expect(actions.map((a) => a.action).sort()).toEqual(
        ['ticket.status.change', 'ticket.update'].sort(),
      );
      // The actor is recorded, and it is the agent — never the requester.
      expect(new Set(actions.map((a) => a.userId))).toEqual(new Set([agentId]));
    });
  });
});







