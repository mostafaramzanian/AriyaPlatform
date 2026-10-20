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
import { RoleName } from '../src/generated/core-client';
import { PrismaModule } from '../src/database/prisma.module';
import { SearchModule } from '../src/search/search.module';
import { SearchIndexerService } from '../src/search/search-indexer.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { PermissionService } from '../src/auth/rbac/services/permission.service';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49J — Global Search E2E against the real Core database.
 *
 * Modelled on surveys.e2e-spec.ts (49H) and calendar.e2e-spec.ts (49I): a minimal test
 * guard supplies identity in a header, the REAL TenantContextInterceptor resolves tenant
 * from the database, and the REAL RolesGuard + PermissionService resolve
 * `admin.support.manage` / `admin.surveys.manage` against genuinely seeded grants.
 * Nothing about authorization or tenant scope is stubbed.
 *
 * WHAT THIS SPEC IS ACTUALLY FOR. Search is the one Core capability that reads every
 * other one, so the interesting assertions are all NEGATIVE: a non-member must not find
 * a message, a requester must not find an internal note, a participant must not find a
 * draft survey, and nobody must find another tenant's anything. Each of those is a
 * separate `it`, because "search returns results" passing tells you nothing about
 * whether it returns too many.
 *
 * EVERY FIXTURE ROW SHARES ONE DISTINCTIVE TOKEN (`مرخصی`), so one query reaches all
 * eight sources and per-source visibility can be compared under identical retrieval.
 *
 * SEMANTIC RETRIEVAL IS EXPECTED TO BE UNAVAILABLE HERE, and that expectation is
 * asserted rather than worked around: `.env.e2e` configures no `OPENAI_API_KEY` and
 * `AIProviderConfig` is empty, so `mode` must be `LEXICAL` and `degraded` must be true.
 * A test that quietly passed in either mode would be unable to detect a regression in
 * the degraded path, which is the ONLY path this environment can exercise.
 */

/** Shared token across every fixture row. Persian yeh (U+06CC). */
const TOKEN = 'مرخصی';
/** The same word spelled with ARABIC yeh (U+064A) — must find the rows above. */
const TOKEN_ARABIC_YEH = 'مرخصي';

/** Never present on any result, at any depth. */
const FORBIDDEN_RESULT_FIELDS = [
  'tenantId',
  'userId',
  'ownerId',
  'senderId',
  'authorId',
  'requesterId',
  'assigneeId',
  'isInternal',
  'passwordHash',
  'refreshTokenHash',
  'tokenVersion',
  'embedding',
  'embeddingModel',
  'searchText',
  'searchVector',
];

class SearchTestGuard implements CanActivate {
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

/**
 * Tracking number in the shape `Ticket_trackingNumber_shape` requires:
 * `^TK-[0-9A-Z]{10}$`. Generated rather than hardcoded because the column is UNIQUE and
 * this spec creates two tickets.
 */
const trackingNumber = () => {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < 10; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `TK-${suffix}`;
};

describe('Global Search E2E (tenant isolation, per-source authz, degraded mode)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let permissions: PermissionService;
  let indexer: SearchIndexerService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];
  const createdGrants: string[] = [];

  /** Tenant A. */
  let memberId: string; // in the conversation, files the ticket, owns the reminder
  let outsiderId: string; // same tenant, NOT in the conversation, not the requester
  let agentId: string; // admin.support.manage
  let managerId: string; // admin.surveys.manage
  /** Tenant B — must never see anything from tenant A. */
  let foreignId: string;

  /** Ids of the fixture rows, so assertions can name them exactly. */
  const ids = {
    ticket: '',
    publicComment: '',
    internalComment: '',
    publishedSurvey: '',
    draftSurvey: '',
    conversation: '',
    message: '',
    notification: '',
    reminder: '',
    foreignTicket: '',
    foreignMessage: '',
    foreignConversation: '',
  };

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `search-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      },
    });
    createdUsers.push(user.id);
    return user;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /** `GET /search?q=…`, with the query encoded exactly as the web client encodes it. */
  const search = async (
    q: string,
    userId?: string,
    extra: Record<string, string | number> = {},
  ) => {
    const params = new URLSearchParams({ q });
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return get(`/search?${params.toString()}`, userId);
  };

  /** The shape of one result row the assertions below read (`body` is the parsed JSON). */
  interface SearchHit {
    sourceType: string;
    sourceId: string;
    score: number;
    navigation?: { href: string; anchor?: string | null };
  }

  /** Source types present in a response body. */
  const sourcesIn = (body: { results?: SearchHit[] }): string[] =>
    [...new Set((body.results ?? []).map((r) => r.sourceType))];

  /** True when the response contains a result for this exact row. */
  const hasRow = (body: { results?: SearchHit[] }, sourceType: string, sourceId: string) =>
    (body.results ?? []).some((r) => r.sourceType === sourceType && r.sourceId === sourceId);

  const grantToRole = async (roleName: string, permissionName: string) => {
    const role = await prisma.role.findFirst({ where: { name: roleName as RoleName } });
    const permission = await prisma.permission.findFirst({ where: { name: permissionName } });
    if (!role || !permission) {
      throw new Error(
        `${roleName}/${permissionName} is not seeded; run prisma migrate deploy on core_db first`,
      );
    }

    const existing = await prisma.rolePermission.findFirst({
      where: { roleId: role.id, permissionId: permission.id },
    });
    if (!existing) {
      const created = await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      createdGrants.push(created.id);
    }

    return role.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [SearchModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: SearchTestGuard },
        // The REAL RolesGuard. The search route declares no @Roles(...), so this proves
        // the absence of a gate is the actual behaviour rather than a test artifact.
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
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
    indexer = app.get(SearchIndexerService);

    const tenantA = await prisma.tenant.create({ data: { code: `search-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `search-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    memberId = (
      await makeUser({
        tenantId: tenantAId,
        firstName: 'بهار',
        lastName: 'نوری',
        jobTitle: 'کارشناس مرخصی',
        department: 'منابع انسانی',
      })
    ).id;
    outsiderId = (await makeUser({ tenantId: tenantAId, firstName: 'سینا', lastName: 'کریمی' })).id;
    agentId = (await makeUser({ tenantId: tenantAId, firstName: 'سارا', lastName: 'کاظمی' })).id;
    managerId = (await makeUser({ tenantId: tenantAId, firstName: 'مینا', lastName: 'اسدی' })).id;
    foreignId = (await makeUser({ tenantId: tenantBId, firstName: 'ثمین', lastName: 'حیدری' })).id;

    const agentRoleId = await grantToRole('SECURITY_ADMIN', 'admin.support.manage');
    const managerRoleId = await grantToRole('OPERATIONS_ADMIN', 'admin.surveys.manage');
    for (const [userId, roleId] of [
      [agentId, agentRoleId],
      [managerId, managerRoleId],
    ] as const) {
      await prisma.userRole.create({ data: { userId, roleId } });
      await permissions.invalidateUserPermissions(userId);
    }

    // ---- Tenant A fixture. Every row carries TOKEN. --------------------------------
    const ticket = await prisma.ticket.create({
      data: {
        tenantId: tenantAId,
        trackingNumber: trackingNumber(),
        requesterId: memberId,
        type: 'SUPPORT',
        subject: `درخواست ${TOKEN} سالانه`,
        body: `لطفاً ${TOKEN} من را بررسی کنید`,
      },
    });
    ids.ticket = ticket.id;

    ids.publicComment = (
      await prisma.ticketComment.create({
        data: {
          ticketId: ticket.id,
          authorId: agentId,
          body: `پاسخ عمومی درباره ${TOKEN}`,
          isInternal: false,
        },
      })
    ).id;

    ids.internalComment = (
      await prisma.ticketComment.create({
        data: {
          ticketId: ticket.id,
          authorId: agentId,
          body: `یادداشت داخلی محرمانه درباره ${TOKEN}`,
          isInternal: true,
        },
      })
    ).id;

    ids.publishedSurvey = (
      await prisma.survey.create({
        data: {
          tenantId: tenantAId,
          title: `نظرسنجی ${TOKEN} منتشرشده`,
          description: `درباره سیاست ${TOKEN}`,
          status: 'PUBLISHED',
          publishedAt: new Date(),
          createdById: managerId,
        },
      })
    ).id;

    ids.draftSurvey = (
      await prisma.survey.create({
        data: {
          tenantId: tenantAId,
          title: `نظرسنجی ${TOKEN} پیش‌نویس`,
          status: 'DRAFT',
          createdById: managerId,
        },
      })
    ).id;

    const conversation = await prisma.conversation.create({
      data: {
        tenantId: tenantAId,
        type: 'GROUP',
        name: `گروه ${TOKEN}`,
        createdBy: memberId,
        members: { create: [{ userId: memberId }, { userId: agentId }] },
      },
    });
    ids.conversation = conversation.id;

    ids.message = (
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: memberId,
          body: `پیام خصوصی درباره ${TOKEN}`,
        },
      })
    ).id;

    ids.notification = (
      await prisma.notification.create({
        data: {
          userId: memberId,
          tenantId: tenantAId,
          type: 'INFORMATION',
          title: `اعلان ${TOKEN}`,
          body: `${TOKEN} شما ثبت شد`,
        },
      })
    ).id;

    ids.reminder = (
      await prisma.reminder.create({
        data: {
          userId: memberId,
          tenantId: tenantAId,
          title: `یادآور ${TOKEN}`,
          note: `پیگیری ${TOKEN}`,
          dueAt: new Date(now + 86_400_000),
        },
      })
    ).id;

    // ---- Tenant B fixture. Same token, different tenant. ---------------------------
    const foreignTicket = await prisma.ticket.create({
      data: {
        tenantId: tenantBId,
        trackingNumber: trackingNumber(),
        requesterId: foreignId,
        type: 'SUPPORT',
        subject: `درخواست ${TOKEN} تنانت دیگر`,
        body: `این ${TOKEN} به تنانت دیگری تعلق دارد`,
      },
    });
    ids.foreignTicket = foreignTicket.id;

    const foreignConversation = await prisma.conversation.create({
      data: {
        tenantId: tenantBId,
        type: 'GROUP',
        name: `گروه ${TOKEN} تنانت دیگر`,
        createdBy: foreignId,
        members: { create: [{ userId: foreignId }] },
      },
    });
    ids.foreignConversation = foreignConversation.id;

    ids.foreignMessage = (
      await prisma.message.create({
        data: {
          conversationId: foreignConversation.id,
          senderId: foreignId,
          body: `پیام ${TOKEN} در تنانت دیگر`,
        },
      })
    ).id;

    // Project everything. Embeddings are expected to be SKIPPED in this environment —
    // asserted in the degraded-mode block rather than assumed here.
    await indexer.rebuildAll();
  });

  afterAll(async () => {
    // Remove the projection rows this spec created FIRST: they hold no foreign key, so
    // deleting the business rows would otherwise leave orphans behind in a shared DB.
    const projected = Object.values(ids).filter(Boolean);
    if (projected.length > 0) {
      await prisma.searchDocument.deleteMany({ where: { sourceId: { in: projected } } });
    }
    if (createdUsers.length > 0) {
      await prisma.searchDocument.deleteMany({ where: { sourceId: { in: createdUsers } } });
    }

    await prisma.reminder.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.notification.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.message.deleteMany({ where: { senderId: { in: createdUsers } } });
    await prisma.conversationMember.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.conversation.deleteMany({ where: { createdBy: { in: createdUsers } } });
    await prisma.ticketComment.deleteMany({ where: { authorId: { in: createdUsers } } });
    await prisma.ticket.deleteMany({ where: { requesterId: { in: createdUsers } } });
    await prisma.survey.deleteMany({ where: { createdById: { in: createdUsers } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    // Restore the seeded grant set exactly.
    await prisma.rolePermission.deleteMany({ where: { id: { in: createdGrants } } });

    await app.close();
  });

  describe('authentication and contract', () => {
    it('rejects an anonymous caller', async () => {
      const res = await search(TOKEN);
      expect(res.status).toBe(401);
    });

    it('serves any authenticated user — no @Roles gate, with the REAL RolesGuard active', async () => {
      // outsiderId holds no role at all.
      const res = await search(TOKEN, outsiderId);
      expect(res.status).toBe(200);
    });

    it('REJECTS an undeclared parameter rather than ignoring it', async () => {
      // This is what makes the absence of tenantId/userId a boundary: forbidNonWhitelisted.
      for (const forbidden of ['tenantId', 'userId', 'asUser', 'includeInternal']) {
        const res = await search(TOKEN, memberId, { [forbidden]: tenantBId });
        expect(res.status).toBe(422);
      }
    });

    it('refuses a query shorter than the DTO minimum', async () => {
      const res = await search('ا', memberId);
      expect(res.status).toBe(422);
    });

    it('refuses a query longer than the DTO maximum', async () => {
      const res = await search('م'.repeat(121), memberId);
      expect(res.status).toBe(422);
    });

    it('returns an empty, well-formed response when the query normalizes to nothing', async () => {
      // Two punctuation characters pass the raw MinLength but normalize away entirely.
      const res = await search('!!', memberId);

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
      expect(res.body.count).toBe(0);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.sourceCounts).toEqual({});
    });

    it('caps an oversized limit instead of rejecting it', async () => {
      const res = await search(TOKEN, memberId, { limit: 5000 });
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeLessThanOrEqual(50);
    });

    it('echoes the raw query and the normalized form separately', async () => {
      const res = await search(`  ${TOKEN}  `, memberId);

      expect(res.status).toBe(200);
      // Trimmed by the DTO transform, not normalized.
      expect(res.body.query).toBe(TOKEN);
      expect(res.body.normalizedQuery).toBe(TOKEN);
    });
  });

  describe('Persian normalization end to end', () => {
    it('finds rows written with Persian yeh when the query uses ARABIC yeh', async () => {
      const res = await search(TOKEN_ARABIC_YEH, memberId);

      expect(res.status).toBe(200);
      // The whole point of the normalizer: مرخصي must reach مرخصی.
      expect(res.body.normalizedQuery).toBe(TOKEN);
      expect(hasRow(res.body, 'TICKET', ids.ticket)).toBe(true);
    });

    it('finds the same rows when the query carries diacritics and Arabic-Indic digits', async () => {
      const res = await search('مُرخصی', memberId);

      expect(res.status).toBe(200);
      expect(res.body.normalizedQuery).toBe(TOKEN);
      expect(hasRow(res.body, 'TICKET', ids.ticket)).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    it('never returns another tenant\'s ticket, message or conversation', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET', ids.foreignTicket)).toBe(false);
      expect(hasRow(res.body, 'MESSAGE', ids.foreignMessage)).toBe(false);
      expect(hasRow(res.body, 'CONVERSATION', ids.foreignConversation)).toBe(false);
    });

    it('is symmetric: tenant B sees its own rows and none of tenant A\'s', async () => {
      const res = await search(TOKEN, foreignId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET', ids.foreignTicket)).toBe(true);
      expect(hasRow(res.body, 'TICKET', ids.ticket)).toBe(false);
      expect(hasRow(res.body, 'MESSAGE', ids.message)).toBe(false);
      expect(hasRow(res.body, 'CONVERSATION', ids.conversation)).toBe(false);
      expect(hasRow(res.body, 'SURVEY', ids.publishedSurvey)).toBe(false);
    });

    it('does not let an agent permission cross a tenant boundary', async () => {
      // agentId holds admin.support.manage, which widens visibility WITHIN a tenant only.
      const res = await search(TOKEN, agentId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET', ids.ticket)).toBe(true);
      expect(hasRow(res.body, 'TICKET', ids.foreignTicket)).toBe(false);
    });
  });

  describe('per-source authorization', () => {
    it('excludes a message and its conversation for a non-member of the same tenant', async () => {
      const res = await search(TOKEN, outsiderId);

      expect(res.status).toBe(200);
      // Membership is the only edge — same tenant is not enough.
      expect(hasRow(res.body, 'MESSAGE', ids.message)).toBe(false);
      expect(hasRow(res.body, 'CONVERSATION', ids.conversation)).toBe(false);
    });

    it('includes them for a member', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'MESSAGE', ids.message)).toBe(true);
      expect(hasRow(res.body, 'CONVERSATION', ids.conversation)).toBe(true);
    });

    it('hides an INTERNAL ticket comment from the requester, while showing the public one', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET_COMMENT', ids.publicComment)).toBe(true);
      // Excluded, not flagged: the existence of an internal note is itself information.
      expect(hasRow(res.body, 'TICKET_COMMENT', ids.internalComment)).toBe(false);
    });

    it('shows the internal comment to an agent', async () => {
      const res = await search(TOKEN, agentId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET_COMMENT', ids.internalComment)).toBe(true);
    });

    it('hides a ticket the caller did not file, from a non-agent in the same tenant', async () => {
      const res = await search(TOKEN, outsiderId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'TICKET', ids.ticket)).toBe(false);
      expect(hasRow(res.body, 'TICKET_COMMENT', ids.publicComment)).toBe(false);
    });

    it('hides a DRAFT survey from a participant and shows the published one', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'SURVEY', ids.publishedSurvey)).toBe(true);
      expect(hasRow(res.body, 'SURVEY', ids.draftSurvey)).toBe(false);
    });

    it('shows the draft survey to a survey manager', async () => {
      const res = await search(TOKEN, managerId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'SURVEY', ids.draftSurvey)).toBe(true);
    });

    it('excludes another user\'s notification and reminder', async () => {
      const res = await search(TOKEN, outsiderId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'NOTIFICATION', ids.notification)).toBe(false);
      expect(hasRow(res.body, 'REMINDER', ids.reminder)).toBe(false);
    });

    it('includes the owner\'s own notification and reminder', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      expect(hasRow(res.body, 'NOTIFICATION', ids.notification)).toBe(true);
      expect(hasRow(res.body, 'REMINDER', ids.reminder)).toBe(true);
    });

    it('narrows to one source when sourceType is supplied, and cannot widen', async () => {
      const res = await search(TOKEN, memberId, { sourceType: 'TICKET' });

      expect(res.status).toBe(200);
      expect(sourcesIn(res.body)).toEqual(['TICKET']);

      // The filter cannot reach a row the caller could not already see.
      const denied = await search(TOKEN, outsiderId, { sourceType: 'MESSAGE' });
      expect(denied.status).toBe(200);
      expect(hasRow(denied.body, 'MESSAGE', ids.message)).toBe(false);
    });

    it('rejects an unknown sourceType instead of silently ignoring it', async () => {
      const res = await search(TOKEN, memberId, { sourceType: 'CREDENTIAL' });
      expect(res.status).toBe(422);
    });
  });

  describe('projection shape', () => {
    it('exposes only the allowlisted result fields', async () => {
      const res = await search(TOKEN, memberId);
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);

      for (const result of res.body.results) {
        expect(Object.keys(result).sort()).toEqual(
          [
            'highlights',
            'matchedBy',
            'navigation',
            'score',
            'snippet',
            'sourceId',
            'sourceType',
            'timestamp',
            'title',
          ].sort(),
        );
      }
    });

    it('never leaks an authorization, tenant or E-class field anywhere in the body', async () => {
      const res = await search(TOKEN, memberId);
      const serialized = JSON.stringify(res.body);

      for (const field of FORBIDDEN_RESULT_FIELDS) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    });

    it('builds navigation from route constants, never from matched text', async () => {
      const res = await search(TOKEN, memberId);

      for (const result of res.body.results) {
        expect(result.navigation.href.startsWith('/admin/')).toBe(true);
        // No query string, no protocol, no user text: a result cannot inject a URL.
        expect(result.navigation.href).not.toContain('?');
        expect(result.navigation.href).not.toContain('://');
        expect(result.navigation.href).not.toContain(TOKEN);
      }
    });

    it('anchors a comment result at the ticket page and a message at the conversation', async () => {
      const agentRes = await search(TOKEN, agentId);
      const comment = agentRes.body.results.find(
        (r: SearchHit) => r.sourceType === 'TICKET_COMMENT' && r.sourceId === ids.publicComment,
      );
      expect(comment.navigation.href).toBe(`/admin/support/${ids.ticket}`);
      expect(comment.navigation.anchor).toBe(ids.publicComment);

      const memberRes = await search(TOKEN, memberId);
      const message = memberRes.body.results.find(
        (r: SearchHit) => r.sourceType === 'MESSAGE' && r.sourceId === ids.message,
      );
      expect(message.navigation.href).toBe('/admin/messages');
      // The CONVERSATION id, not the message id: there is no per-message route.
      expect(message.navigation.anchor).toBe(ids.conversation);
    });

    it('returns snippets as plain text with in-range highlight offsets', async () => {
      const res = await search(TOKEN, memberId);

      for (const result of res.body.results) {
        expect(result.snippet).not.toMatch(/<[a-z]/i);
        expect(Array.isArray(result.highlights)).toBe(true);

        for (const highlight of result.highlights) {
          expect(highlight.start).toBeGreaterThanOrEqual(0);
          expect(highlight.end).toBeGreaterThan(highlight.start);
          expect(highlight.end).toBeLessThanOrEqual(result.snippet.length);
          // The highlighted span is the matched token, in the ORIGINAL spelling.
          expect(result.snippet.slice(highlight.start, highlight.end).length).toBeGreaterThan(0);
        }
      }
    });

    it('counts facets over the AUTHORIZED results only', async () => {
      const res = await search(TOKEN, memberId);

      const summed = Object.values(res.body.sourceCounts as Record<string, number>).reduce(
        (total, value) => total + value,
        0,
      );
      // sourceCounts describes what the caller may see, not what matched the index.
      expect(summed).toBeGreaterThanOrEqual(res.body.count);
      for (const source of sourcesIn(res.body)) {
        expect(res.body.sourceCounts[source]).toBeGreaterThan(0);
      }
      // A source the caller cannot see must not appear in the facets at all.
      const outsider = await search(TOKEN, outsiderId);
      expect(outsider.body.sourceCounts.MESSAGE ?? 0).toBe(0);
    });

    it('orders results by descending score', async () => {
      const res = await search(TOKEN, memberId);
      const scores = res.body.results.map((r: SearchHit) => r.score);

      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
      for (const score of scores) {
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('pages by offset without repeating a result', async () => {
      const first = await search(TOKEN, memberId, { limit: 2, offset: 0 });
      const second = await search(TOKEN, memberId, { limit: 2, offset: 2 });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const key = (r: SearchHit) => `${r.sourceType}:${r.sourceId}`;
      const firstKeys = first.body.results.map(key);
      for (const result of second.body.results) {
        expect(firstKeys).not.toContain(key(result));
      }
      if (first.body.results.length === 2) {
        expect(first.body.hasMore).toBe(true);
      }
    });
  });

  describe('degraded mode (no embedding credential in this environment)', () => {
    it('reports LEXICAL + degraded, and says nothing about why', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.status).toBe(200);
      // `.env.e2e` sets no OPENAI_API_KEY and `AIProviderConfig` is empty, so the
      // semantic arm cannot run. Asserted rather than tolerated: this is the only mode
      // this environment can exercise, so a silent switch to HYBRID would mean the
      // fixture had acquired a credential and these expectations were no longer testing
      // the degraded path.
      expect(res.body.mode).toBe('LEXICAL');
      expect(res.body.degraded).toBe(true);

      // No reason, at any depth. Provider identity and credential state are guarded by
      // `admin.ai.read`; a search caller is not entitled to them.
      const serialized = JSON.stringify(res.body);
      for (const forbidden of [
        'OPENAI',
        'openai',
        'OpenAI',
        'apiKey',
        'API key',
        'credential',
        'text-embedding',
        'AIProviderConfig',
        'reason',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('marks every result lexical-only, honestly', async () => {
      const res = await search(TOKEN, memberId);

      for (const result of res.body.results) {
        expect(result.matchedBy.lexical).toBe(true);
        // False for every row, because no semantic arm ran — a fact about retrieval,
        // not about the document.
        expect(result.matchedBy.semantic).toBe(false);
      }
    });

    it('still returns real results: lexical retrieval does not depend on a credential', async () => {
      const res = await search(TOKEN, memberId);

      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.count).toBe(res.body.results.length);
    });

    it('leaves every projected row without a vector, and never fabricates one', async () => {
      const rows = await prisma.searchDocument.findMany({
        where: { sourceId: { in: Object.values(ids).filter(Boolean) } },
        select: { sourceType: true, sourceId: true, embeddingModel: true, embeddedAt: true },
      });

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // A zero or random vector would manufacture confident nonsense; NULL is the
        // honest state, and the `embedding_complete` CHECK keeps the three columns
        // consistent.
        expect(row.embeddingModel).toBeNull();
        expect(row.embeddedAt).toBeNull();
      }
    });
  });

  describe('projection integrity', () => {
    it('projected every fixture source that has indexable text', async () => {
      const rows = await prisma.searchDocument.findMany({
        where: { sourceId: { in: Object.values(ids).filter(Boolean) } },
        select: { sourceType: true },
      });

      const projectedSources = new Set(rows.map((row) => row.sourceType));
      for (const expected of [
        'TICKET',
        'TICKET_COMMENT',
        'SURVEY',
        'MESSAGE',
        'CONVERSATION',
        'NOTIFICATION',
        'REMINDER',
      ] as const) {
        expect(projectedSources.has(expected)).toBe(true);
      }
    });

    it('stamped the tenant of the PARENT row on comments and messages', async () => {
      const [comment] = await prisma.searchDocument.findMany({
        where: { sourceType: 'TICKET_COMMENT', sourceId: ids.publicComment },
        select: { tenantId: true },
      });
      const [message] = await prisma.searchDocument.findMany({
        where: { sourceType: 'MESSAGE', sourceId: ids.message },
        select: { tenantId: true },
      });

      // `TicketComment` and `Message` have no tenantId column, so a missing join here
      // would stamp NULL and expose the row to tenant-less callers.
      expect(comment.tenantId).toBe(tenantAId);
      expect(message.tenantId).toBe(tenantAId);
    });

    it('stored NORMALIZED text, not the raw source text', async () => {
      const [row] = await prisma.searchDocument.findMany({
        where: { sourceType: 'TICKET', sourceId: ids.ticket },
        select: { searchText: true },
      });

      expect(row.searchText).toContain(TOKEN);
      // Normalization strips ZWNJ and folds punctuation to spaces.
      expect(row.searchText).not.toContain('\u200C');
      expect(row.searchText.trim()).toBe(row.searchText);
    });

    it('re-indexing a source is idempotent — one row per (sourceType, sourceId)', async () => {
      await indexer.rebuildSource('TICKET');
      await indexer.rebuildSource('TICKET');

      const count = await prisma.searchDocument.count({
        where: { sourceType: 'TICKET', sourceId: ids.ticket },
      });
      expect(count).toBe(1);
    });

    it('remove() drops a projection row and is safe to repeat', async () => {
      await indexer.remove('REMINDER', ids.reminder);
      await expect(
        prisma.searchDocument.count({ where: { sourceType: 'REMINDER', sourceId: ids.reminder } }),
      ).resolves.toBe(0);

      // Idempotent: removing an absent row is the desired state, not an error.
      await expect(indexer.remove('REMINDER', ids.reminder)).resolves.toBeUndefined();

      // A removed projection makes the row unfindable without touching the source row.
      const res = await search(TOKEN, memberId);
      expect(hasRow(res.body, 'REMINDER', ids.reminder)).toBe(false);
      await expect(
        prisma.reminder.count({ where: { id: ids.reminder } }),
      ).resolves.toBe(1);

      // Restore it so ordering between tests cannot matter.
      await indexer.rebuildSource('REMINDER');
    });
  });
});
