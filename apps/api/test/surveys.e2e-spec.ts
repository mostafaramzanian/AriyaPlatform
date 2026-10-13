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
import { RoleName } from '../src/generated/core-client';
import { PrismaModule } from '../src/database/prisma.module';
import { SurveysModule } from '../src/surveys/surveys.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { PermissionService } from '../src/auth/rbac/services/permission.service';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 49H — Surveys / Participation E2E against the real Core database.
 *
 * Modelled on support.e2e-spec.ts (49G): a minimal test guard supplies identity in a
 * header, the REAL TenantContextInterceptor resolves tenant from the database, and the
 * REAL RolesGuard + PermissionService enforce `admin.surveys.manage` /
 * `admin.surveys.results` against genuinely seeded grants. Nothing about authorization
 * or tenant scope is stubbed.
 *
 * The three capabilities are given to three DIFFERENT users so their independence is
 * actually observable:
 *   participant  — no role at all. Proves participation needs no permission.
 *   manager      — SECURITY_ADMIN + a temporary `admin.surveys.manage` grant ONLY.
 *                  Deliberately without results, so "authoring does not confer sight
 *                  of the answers" is provable rather than asserted.
 *   viewer       — OPERATIONS_ADMIN + a temporary `admin.surveys.results` grant ONLY.
 *
 * Those two RolePermission rows are created in beforeAll and DELETED in afterAll: the
 * shipped 20260830130000 migration grants surveys to SUPER_ADMIN and ADMIN only, and
 * this spec must not leave a widened seeded role behind.
 */

/** Fields that must never appear on a projected survey. */
const FORBIDDEN_SURVEY_FIELDS = ['tenantId'];
const FORBIDDEN_PERSON_FIELDS = [
  'email',
  'passwordHash',
  'refreshTokenHash',
  'tokenVersion',
  'emailVerified',
  'status',
  'tenantId',
];

class SurveyTestGuard implements CanActivate {
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

describe('Surveys E2E (participation, tenant isolation, one-response, anonymity)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let permissions: PermissionService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];
  /** RolePermission rows this spec created and must remove again. */
  const createdGrants: string[] = [];

  let participantId: string;
  let peerId: string;
  let managerId: string;
  let viewerId: string;
  let foreignManagerId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `survey-${Math.random().toString(36).slice(2)}-${now}@example.com`,
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

  const del = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).delete(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /** Grants one permission to one role and records the row for teardown. */
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
    // Only record rows this spec actually created, so teardown cannot delete a
    // legitimately seeded grant.
    if (!existing) {
      const created = await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      createdGrants.push(created.id);
    }

    return role.id;
  };

  /** Authors a DRAFT survey through the real route and returns the body. */
  const createSurvey = async (callerId: string, overrides: Record<string, unknown> = {}) => {
    const res = await post('/surveys', callerId).send({
      title: 'نظرسنجی آزمایشی',
      questions: [
        {
          type: 'SINGLE_CHOICE',
          text: 'کدام گزینه؟',
          options: [{ label: 'الف' }, { label: 'ب' }],
        },
      ],
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  /** Authors and publishes in one step, returning the published detail body. */
  const publishedSurvey = async (callerId: string, overrides: Record<string, unknown> = {}) => {
    const draft = await createSurvey(callerId, overrides);
    const res = await patch(`/surveys/${draft.id}/status`, callerId).send({ status: 'PUBLISHED' });
    expect(res.status).toBe(200);
    return res.body;
  };


  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [SurveysModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: SurveyTestGuard },
        // The REAL RolesGuard, so the @Roles(...) gates on the authoring and results
        // routes are genuinely enforced against seeded grants.
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

    const tenantA = await prisma.tenant.create({ data: { code: `survey-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `survey-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    participantId = (await makeUser({ tenantId: tenantAId, firstName: 'بهار', lastName: 'نوری' }))
      .id;
    peerId = (await makeUser({ tenantId: tenantAId, firstName: 'پویا', lastName: 'رستمی' })).id;
    managerId = (await makeUser({ tenantId: tenantAId, firstName: 'سارا', lastName: 'کاظمی' })).id;
    viewerId = (await makeUser({ tenantId: tenantAId, firstName: 'مینا', lastName: 'اسدی' })).id;
    foreignManagerId = (
      await makeUser({ tenantId: tenantBId, firstName: 'ثمین', lastName: 'حیدری' })
    ).id;

    // Manage WITHOUT results, and results WITHOUT manage — the split is the point.
    const managerRoleId = await grantToRole('SECURITY_ADMIN', 'admin.surveys.manage');
    const viewerRoleId = await grantToRole('OPERATIONS_ADMIN', 'admin.surveys.results');

    for (const [userId, roleId] of [
      [managerId, managerRoleId],
      [foreignManagerId, managerRoleId],
      [viewerId, viewerRoleId],
    ] as const) {
      await prisma.userRole.create({ data: { userId, roleId } });
      await permissions.invalidateUserPermissions(userId);
    }
  });

  afterAll(async () => {
    // Answers and responses cascade from the surveys, but the order is explicit so a
    // RESTRICT foreign key cannot strand the teardown.
    await prisma.surveyResponse.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.survey.deleteMany({ where: { createdById: { in: createdUsers } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    // Restore the seeded grant set exactly: the shipped migration gives surveys to
    // SUPER_ADMIN and ADMIN only.
    await prisma.rolePermission.deleteMany({ where: { id: { in: createdGrants } } });
    await app.close();
  });


  describe('authorization split', () => {
    // 1
    it('lets a user with no role at all list surveys', async () => {
      const res = await get('/surveys', participantId);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    // 2
    it('refuses authoring to a caller without admin.surveys.manage', async () => {
      const res = await post('/surveys', participantId).send({
        title: 'ت',
        questions: [
          { type: 'SINGLE_CHOICE', text: 'ت', options: [{ label: 'الف' }, { label: 'ب' }] },
        ],
      });
      expect(res.status).toBe(403);
    });

    // 3
    it('refuses results to the manager who authored the survey', async () => {
      const survey = await publishedSurvey(managerId);

      const res = await get(`/surveys/${survey.id}/results`, managerId);
      // manage does NOT imply results — this is the whole reason they are two
      // permissions.
      expect(res.status).toBe(403);
    });

    // 4
    it('grants results on admin.surveys.results alone, without manage', async () => {
      const survey = await publishedSurvey(managerId);

      const results = await get(`/surveys/${survey.id}/results`, viewerId);
      expect(results.status).toBe(200);
      expect(results.body.surveyId).toBe(survey.id);

      // And that viewer cannot author.
      const authoring = await post('/surveys', viewerId).send({
        title: 'ت',
        questions: [
          { type: 'SINGLE_CHOICE', text: 'ت', options: [{ label: 'الف' }, { label: 'ب' }] },
        ],
      });
      expect(authoring.status).toBe(403);
    });

    // 5
    it('refuses an unauthenticated request', async () => {
      const res = await get('/surveys');
      expect(res.status).toBe(401);
    });
  });

  describe('tenant isolation and IDOR', () => {
    // 6
    it('hides a survey from another tenant behind a 404, not a 403', async () => {
      const foreign = await publishedSurvey(foreignManagerId);

      const detail = await get(`/surveys/${foreign.id}`, participantId);
      expect(detail.status).toBe(404);

      const list = await get('/surveys?limit=100', participantId);
      const ids = list.body.items.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(foreign.id);
    });

    // 7
    it('refuses to accept a response to a survey in another tenant', async () => {
      const foreign = await publishedSurvey(foreignManagerId);

      // The payload is well-formed (a syntactically valid answer), so validation
      // passes and the tenant check is genuinely the thing that rejects this. The
      // questionId is a stranger to the survey, which does not matter: visibility is
      // resolved BEFORE any question is looked up.
      const res = await post(`/surveys/${foreign.id}/responses`, participantId).send({
        answers: [
          {
            questionId: '11111111-1111-4111-8111-111111111111',
            optionIds: ['22222222-2222-4222-8222-222222222222'],
          },
        ],
      });
      // Unresolvable, not merely unauthorized — the cross-tenant IDOR case.
      expect(res.status).toBe(404);
    });

    // 8
    it('refuses a cross-tenant manager the authoring routes on a foreign survey', async () => {
      const mine = await createSurvey(managerId);

      const edit = await patch(`/surveys/${mine.id}`, foreignManagerId).send({ title: 'دیگر' });
      const remove = await del(`/surveys/${mine.id}`, foreignManagerId);
      expect(edit.status).toBe(404);
      expect(remove.status).toBe(404);
    });

    // 9
    it('hides a DRAFT from a non-manager in the same tenant', async () => {
      const draft = await createSurvey(managerId);

      const detail = await get(`/surveys/${draft.id}`, participantId);
      expect(detail.status).toBe(404);
    });

    // 10
    it('rejects an injected tenantId or createdById query parameter', async () => {
      const injectedTenant = await get(`/surveys?tenantId=${tenantBId}`, participantId);
      const injectedAuthor = await get(`/surveys?createdById=${managerId}`, participantId);
      expect(injectedTenant.status).toBe(422);
      expect(injectedAuthor.status).toBe(422);
    });
  });

  describe('participation and the one-response rule', () => {
    // 11
    it('accepts one response from an ordinary user and reflects it in canRespond', async () => {
      const survey = await publishedSurvey(managerId);
      const detail = await get(`/surveys/${survey.id}`, participantId);
      expect(detail.status).toBe(200);
      expect(detail.body.canRespond).toBe(true);

      const optionId = detail.body.questions[0].options[0].id;
      const submit = await post(`/surveys/${survey.id}/responses`, participantId).send({
        answers: [{ questionId: detail.body.questions[0].id, optionIds: [optionId] }],
      });
      expect(submit.status).toBe(201);
      expect(submit.body.responseId).toBeTruthy();

      const after = await get(`/surveys/${survey.id}`, participantId);
      expect(after.body.hasResponded).toBe(true);
      expect(after.body.canRespond).toBe(false);
    });

    // 12
    it('refuses a sequential second response with 409', async () => {
      const survey = await publishedSurvey(managerId);
      const detail = await get(`/surveys/${survey.id}`, participantId);
      const answers = [
        {
          questionId: detail.body.questions[0].id,
          optionIds: [detail.body.questions[0].options[0].id],
        },
      ];

      const first = await post(`/surveys/${survey.id}/responses`, participantId).send({ answers });
      const second = await post(`/surveys/${survey.id}/responses`, participantId).send({ answers });
      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
    });

    // 13
    it('admits exactly one of two CONCURRENT submissions and 409s the other', async () => {
      const survey = await publishedSurvey(managerId);
      const detail = await get(`/surveys/${survey.id}`, participantId);
      const answers = [
        {
          questionId: detail.body.questions[0].id,
          optionIds: [detail.body.questions[0].options[0].id],
        },
      ];

      // Fired without awaiting in between, so both pass the pre-check and race at the
      // UNIQUE index. Exactly one must win; neither may 500.
      const [a, b] = await Promise.all([
        post(`/surveys/${survey.id}/responses`, participantId).send({ answers }),
        post(`/surveys/${survey.id}/responses`, participantId).send({ answers }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const stored = await prisma.surveyResponse.count({
        where: { surveyId: survey.id, userId: participantId },
      });
      expect(stored).toBe(1);
    });

    // 14
    it('refuses a response to a DRAFT and to a CLOSED survey', async () => {
      const draft = await createSurvey(managerId);
      // A draft is invisible to a participant, so this is a 404 rather than a 409. The
      // body is well-formed so that validation cannot be what rejects it.
      const onDraft = await post(`/surveys/${draft.id}/responses`, participantId).send({
        answers: [
          {
            questionId: '11111111-1111-4111-8111-111111111111',
            optionIds: ['22222222-2222-4222-8222-222222222222'],
          },
        ],
      });
      expect(onDraft.status).toBe(404);

      const survey = await publishedSurvey(managerId);
      const closed = await patch(`/surveys/${survey.id}/status`, managerId).send({
        status: 'CLOSED',
      });
      expect(closed.status).toBe(200);

      const detail = await get(`/surveys/${survey.id}`, peerId);
      const onClosed = await post(`/surveys/${survey.id}/responses`, peerId).send({
        answers: [
          {
            questionId: detail.body.questions[0].id,
            optionIds: [detail.body.questions[0].options[0].id],
          },
        ],
      });
      expect(onClosed.status).toBe(409);
    });

    // 15
    it('rejects an option id borrowed from a different survey', async () => {
      const [target, other] = await Promise.all([
        publishedSurvey(managerId),
        publishedSurvey(managerId),
      ]);

      const targetDetail = await get(`/surveys/${target.id}`, participantId);
      const otherDetail = await get(`/surveys/${other.id}`, participantId);

      const res = await post(`/surveys/${target.id}/responses`, participantId).send({
        answers: [
          {
            questionId: targetDetail.body.questions[0].id,
            optionIds: [otherDetail.body.questions[0].options[0].id],
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    // 16
    it('rejects a question id borrowed from a different survey', async () => {
      const [target, other] = await Promise.all([
        publishedSurvey(managerId),
        publishedSurvey(managerId),
      ]);

      const otherDetail = await get(`/surveys/${other.id}`, participantId);

      const res = await post(`/surveys/${target.id}/responses`, participantId).send({
        answers: [
          {
            questionId: otherDetail.body.questions[0].id,
            optionIds: [otherDetail.body.questions[0].options[0].id],
          },
        ],
      });
      expect(res.status).toBe(400);
    });
  });


  describe('lifecycle and privacy', () => {
    // 17
    it('freezes the questionnaire once published and refuses the edit with 409', async () => {
      const survey = await publishedSurvey(managerId);

      const res = await patch(`/surveys/${survey.id}`, managerId).send({ title: 'عنوان تازه' });
      expect(res.status).toBe(409);
    });

    // 18
    it('refuses to delete a published survey but allows deleting a draft', async () => {
      const published = await publishedSurvey(managerId);
      const refused = await del(`/surveys/${published.id}`, managerId);
      expect(refused.status).toBe(409);

      const draft = await createSurvey(managerId);
      const removed = await del(`/surveys/${draft.id}`, managerId);
      expect(removed.status).toBe(200);
      expect(removed.body.deleted).toBe(true);

      const gone = await get(`/surveys/${draft.id}`, managerId);
      expect(gone.status).toBe(404);
    });

    // 19
    it('never projects tenantId or account fields on a survey', async () => {
      const survey = await publishedSurvey(managerId);
      const detail = await get(`/surveys/${survey.id}`, participantId);
      expect(detail.status).toBe(200);

      for (const field of FORBIDDEN_SURVEY_FIELDS) {
        expect(detail.body).not.toHaveProperty(field);
      }
      for (const field of FORBIDDEN_PERSON_FIELDS) {
        expect(detail.body.createdBy).not.toHaveProperty(field);
      }
    });

    // 20
    it('returns aggregates with no respondent identifier, even for a named survey', async () => {
      const survey = await publishedSurvey(managerId, { isAnonymous: false });
      const detail = await get(`/surveys/${survey.id}`, participantId);

      const submitted = await post(`/surveys/${survey.id}/responses`, participantId).send({
        answers: [
          {
            questionId: detail.body.questions[0].id,
            optionIds: [detail.body.questions[0].options[0].id],
          },
        ],
      });
      expect(submitted.status).toBe(201);

      const results = await get(`/surveys/${survey.id}/results`, viewerId);
      expect(results.status).toBe(200);
      expect(results.body.responseCount).toBe(1);

      const serialized = JSON.stringify(results.body);
      expect(serialized).not.toContain(participantId);
      expect(serialized).not.toContain(submitted.body.responseId);
      expect(serialized).not.toContain('userId');

      // The option the participant chose shows a count, and nothing more.
      const chosen = results.body.questions[0].options[0];
      expect(chosen.count).toBe(1);
      expect(chosen).not.toHaveProperty('userId');
    });
  });
});


