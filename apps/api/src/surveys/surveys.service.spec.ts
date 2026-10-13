import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MAX_SURVEY_LIMIT, SurveysService } from './surveys.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { AuditService } from '../common/audit.service';
import { Permissions } from '../auth/rbac/constants/permissions';
import { Prisma } from '../generated/core-client';

/**
 * Phase 49H unit coverage for the Surveys / Participation service.
 *
 * What this file is responsible for proving:
 *  - the three-way authorization split (participant / manager / results viewer) is
 *    resolved from RBAC and never from an argument;
 *  - the visibility predicate always carries tenant, and a draft is invisible to a
 *    non-manager rather than merely unanswerable;
 *  - `scope` and `status` can narrow but never widen a page;
 *  - the questionnaire shape rules, the availability window and the forward-only
 *    lifecycle;
 *  - participation is one-per-user and enforced by the UNIQUE index, with P2002
 *    translated to 409 rather than escaping as a 500;
 *  - anonymity is a projection rule: results carry no respondent identifier;
 *  - reads are never audited.
 *
 * Cross-tenant and concurrent behaviour is additionally proven against a real
 * database in test/surveys.e2e-spec.ts.
 */

describe('SurveysService', () => {
  let service: SurveysService;
  let prisma: {
    survey: Record<string, jest.Mock>;
    surveyQuestion: Record<string, jest.Mock>;
    surveyResponse: Record<string, jest.Mock>;
    surveyAnswer: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let permissions: { userHasPermission: jest.Mock };
  let audit: { log: jest.Mock };

  const participant = 'user-participant';
  const manager = 'user-manager';
  const viewer = 'user-viewer';
  const tenantA = 'tenant-a';

  const setContext = (userId: string | undefined, tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  const person = (id: string) => ({
    id,
    firstName: 'نام',
    lastName: 'خانوادگی',
    avatarUrl: null,
    jobTitle: null,
  });

  const surveyRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'survey-1',
    tenantId: tenantA,
    title: 'نظرسنجی رضایت',
    description: null,
    status: 'PUBLISHED',
    isAnonymous: true,
    startsAt: null,
    endsAt: null,
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    closedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    createdById: manager,
    createdBy: person(manager),
    _count: { questions: 2 },
    ...overrides,
  });

  /** Grants only the permissions named, so a viewer is never implicitly a manager. */
  const grant = (...granted: string[]) => {
    permissions.userHasPermission.mockImplementation(async (_userId: string, perm: string) =>
      granted.includes(perm),
    );
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SurveysService,
        {
          provide: PrismaService,
          useValue: {
            survey: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            surveyQuestion: { findMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
            surveyResponse: {
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest.fn().mockResolvedValue(null),
              count: jest.fn().mockResolvedValue(0),
            },
            surveyAnswer: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        { provide: PermissionService, useValue: { userHasPermission: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(SurveysService);
    prisma = moduleRef.get(PrismaService);
    permissions = moduleRef.get(PermissionService);
    audit = moduleRef.get(AuditService);

    grant();
  });

  describe('scope', () => {
    // 1
    it('refuses a request with no identity in the context', async () => {
      setContext(undefined, tenantA);
      await expect(service.listSurveys(participant, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.survey.findMany).not.toHaveBeenCalled();
    });

    // 2
    it('refuses when the context identity differs from the requested subject', async () => {
      setContext('someone-else', tenantA);
      await expect(service.listSurveys(participant, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.survey.findMany).not.toHaveBeenCalled();
    });

    // 3
    it('resolves manage and results as two independent RBAC checks', async () => {
      setContext(viewer, tenantA);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(viewer, {});

      expect(permissions.userHasPermission).toHaveBeenCalledWith(
        viewer,
        Permissions.ADMIN_SURVEYS_MANAGE,
      );
      expect(permissions.userHasPermission).toHaveBeenCalledWith(
        viewer,
        Permissions.ADMIN_SURVEYS_RESULTS,
      );
    });
  });

  describe('visibility', () => {
    // 4
    it('hides drafts from a participant instead of merely blocking answers', async () => {
      setContext(participant, tenantA);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(participant, { scope: 'all' });

      const args = prisma.survey.findMany.mock.calls[0][0];
      // `scope=all` from a non-manager collapses to the availability filter, and the
      // published-only predicate is applied regardless of what was asked for.
      expect(args.where.tenantId).toBe(tenantA);
      expect(args.where.status).toBe('PUBLISHED');
    });

    // 5
    it('lets a manager see drafts inside their own tenant and nothing beyond it', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(manager, { scope: 'all' });

      const args = prisma.survey.findMany.mock.calls[0][0];
      expect(args.where.tenantId).toBe(tenantA);
      expect(args.where.status).toBeUndefined();
    });

    // 6
    it('keeps a null tenant as an explicit predicate rather than dropping it', async () => {
      setContext(participant, null);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(participant, {});

      const args = prisma.survey.findMany.mock.calls[0][0];
      expect(args.where).toHaveProperty('tenantId', null);
    });

    // 7
    it('reports a survey outside the caller\u2019s visibility as absent, not forbidden', async () => {
      setContext(participant, tenantA);
      prisma.survey.findFirst.mockResolvedValue(null);

      await expect(service.getSurvey(participant, 'survey-elsewhere')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('pagination', () => {
    // 8
    it('caps an oversized limit instead of failing, and over-fetches by one', async () => {
      setContext(participant, tenantA);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(participant, { limit: 10_000 });

      const args = prisma.survey.findMany.mock.calls[0][0];
      expect(args.take).toBe(MAX_SURVEY_LIMIT + 1);
    });

    // 9
    it('reports hasMore and drops the probe row from the page', async () => {
      setContext(participant, tenantA);
      prisma.survey.findMany.mockResolvedValue([
        surveyRow({ id: 's1' }),
        surveyRow({ id: 's2' }),
      ]);

      const page = await service.listSurveys(participant, { limit: 1 });

      expect(page.hasMore).toBe(true);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe('s1');
    });

    // 10
    it('orders deterministically and skips the cursor row itself', async () => {
      setContext(participant, tenantA);
      prisma.survey.findMany.mockResolvedValue([]);

      await service.listSurveys(participant, { cursor: 'survey-9' });

      const args = prisma.survey.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.cursor).toEqual({ id: 'survey-9' });
      expect(args.skip).toBe(1);
    });
  });


  describe('projection', () => {
    const detailMocks = (row: Record<string, unknown> = {}) => {
      prisma.survey.findFirst.mockResolvedValue(surveyRow(row));
      prisma.surveyQuestion.findMany.mockResolvedValue([
        {
          id: 'q1',
          type: 'TEXT',
          text: 'نظر شما',
          isRequired: true,
          order: 1,
          maxSelections: null,
          options: [],
        },
      ]);
    };

    // 11
    it('never projects tenantId to the client', async () => {
      setContext(participant, tenantA);
      detailMocks();

      const detail = await service.getSurvey(participant, 'survey-1');

      expect(detail).not.toHaveProperty('tenantId');
      expect(detail.createdBy).not.toHaveProperty('tenantId');
      expect(detail.createdBy).not.toHaveProperty('email');
    });

    // 12
    it('withholds canRespond once the caller has already responded', async () => {
      setContext(participant, tenantA);
      detailMocks();
      prisma.surveyResponse.findUnique.mockResolvedValue({ id: 'resp-1' });

      const detail = await service.getSurvey(participant, 'survey-1');

      expect(detail.hasResponded).toBe(true);
      expect(detail.canRespond).toBe(false);
    });

    // 13
    it('treats an expired window as closed even while the status is still PUBLISHED', async () => {
      setContext(participant, tenantA);
      detailMocks({ endsAt: new Date(Date.now() - 60_000) });

      const detail = await service.getSurvey(participant, 'survey-1');

      expect(detail.status).toBe('PUBLISHED');
      expect(detail.canRespond).toBe(false);
    });

    // 14
    it('offers no lifecycle transitions to a non-manager', async () => {
      setContext(participant, tenantA);
      detailMocks({ status: 'PUBLISHED' });

      const detail = await service.getSurvey(participant, 'survey-1');

      expect(detail.availableTransitions).toEqual([]);
      expect(detail.canManage).toBe(false);
    });

    // 15
    it('offers only the forward edge to a manager, and none out of CLOSED', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);
      detailMocks({ status: 'CLOSED', closedAt: new Date() });

      const closed = await service.getSurvey(manager, 'survey-1');
      expect(closed.availableTransitions).toEqual([]);

      detailMocks({ status: 'DRAFT', publishedAt: null });
      const draft = await service.getSurvey(manager, 'survey-1');
      expect(draft.availableTransitions).toEqual(['PUBLISHED']);
    });
  });


  describe('authoring', () => {
    const validQuestions = [
      {
        type: 'SINGLE_CHOICE' as const,
        text: 'کدام؟',
        options: [{ label: 'الف' }, { label: 'ب' }],
      },
    ];

    // 16
    it('refuses authoring without admin.surveys.manage', async () => {
      setContext(participant, tenantA);

      await expect(
        service.createSurvey(participant, { title: 'ت', questions: validQuestions }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.survey.create).not.toHaveBeenCalled();
    });

    // 17
    it('always creates a DRAFT and stamps tenant and author from the context', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);
      prisma.survey.create.mockResolvedValue({ id: 'survey-new', title: 'ت', isAnonymous: false });
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ id: 'survey-new', status: 'DRAFT' }));
      prisma.surveyQuestion.findMany.mockResolvedValue([]);

      await service.createSurvey(manager, { title: 'ت', questions: validQuestions });

      const data = prisma.survey.create.mock.calls[0][0].data;
      expect(data.status).toBe('DRAFT');
      expect(data.tenantId).toBe(tenantA);
      expect(data.createdById).toBe(manager);
      // Order is assigned server-side from the array index, never from the client.
      expect(data.questions.create[0].order).toBe(1);
      expect(data.questions.create[0].options.create.map((o: { order: number }) => o.order)).toEqual([1, 2]);
    });

    // 18
    it('rejects a choice question with fewer than two options', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [{ type: 'SINGLE_CHOICE', text: 'ت', options: [{ label: 'الف' }] }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.survey.create).not.toHaveBeenCalled();
    });

    // 19
    it('rejects options on a TEXT question rather than silently discarding them', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [{ type: 'TEXT', text: 'ت', options: [{ label: 'الف' }] }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('questionnaire rules', () => {
    // `setContext` uses AsyncLocalStorage.enterWith, which does not propagate from a
    // beforeEach into the test body — so identity is established inside each test,
    // exactly as support.service.spec.ts does.
    beforeEach(() => {
      grant(Permissions.ADMIN_SURVEYS_MANAGE);
    });

    // 20
    it('rejects a maxSelections above the option count', async () => {
      setContext(manager, tenantA);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [
            {
              type: 'MULTIPLE_CHOICE',
              text: 'ت',
              maxSelections: 5,
              options: [{ label: 'الف' }, { label: 'ب' }],
            },
          ],
        }),
      ).rejects.toThrow(/cannot exceed the option count/);
    });

    // 21
    it('rejects maxSelections on a question type that has no selections', async () => {
      setContext(manager, tenantA);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [{ type: 'RATING', text: 'ت', maxSelections: 1 }],
        }),
      ).rejects.toThrow(/MULTIPLE_CHOICE/);
    });

    // 22
    it('rejects duplicate option labels within one question', async () => {
      setContext(manager, tenantA);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [
            { type: 'SINGLE_CHOICE', text: 'ت', options: [{ label: 'الف' }, { label: 'الف' }] },
          ],
        }),
      ).rejects.toThrow(/distinct/);
    });

    // 23
    it('rejects an inverted availability window with a 400, not a database error', async () => {
      setContext(manager, tenantA);

      await expect(
        service.createSurvey(manager, {
          title: 'ت',
          questions: [
            { type: 'SINGLE_CHOICE', text: 'ت', options: [{ label: 'الف' }, { label: 'ب' }] },
          ],
          startsAt: '2026-09-10T00:00:00.000Z',
          endsAt: '2026-09-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/endsAt must be after startsAt/);
    });

    // 24
    it('refuses to edit a survey that has left DRAFT', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'PUBLISHED' }));

      await expect(service.updateSurvey(manager, 'survey-1', { title: 'دیگر' })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });


  describe('lifecycle', () => {
    beforeEach(() => {
      grant(Permissions.ADMIN_SURVEYS_MANAGE);
      prisma.surveyQuestion.count.mockResolvedValue(2);
      prisma.surveyQuestion.findMany.mockResolvedValue([]);
    });

    // 25
    it('refuses a no-op re-publish, so publishedAt cannot be silently moved', async () => {
      setContext(manager, tenantA);
      // `DRAFT` is not even expressible as a transition target — ChangeSurveyStatusDto
      // types `status` as 'PUBLISHED' | 'CLOSED', so un-publishing is impossible at the
      // type level. What remains reachable is a no-op, and that is refused too.
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'PUBLISHED' }));

      await expect(
        service.changeStatus(manager, 'survey-1', { status: 'PUBLISHED' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.survey.update).not.toHaveBeenCalled();
    });

    // 26
    it('treats CLOSED as terminal — there is no reopen path', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(
        surveyRow({ status: 'CLOSED', closedAt: new Date() }),
      );

      await expect(
        service.changeStatus(manager, 'survey-1', { status: 'PUBLISHED' }),
      ).rejects.toThrow(ConflictException);
    });

    // 27
    it('refuses to publish a survey with no questions', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'DRAFT', publishedAt: null }));
      prisma.surveyQuestion.count.mockResolvedValue(0);

      await expect(
        service.changeStatus(manager, 'survey-1', { status: 'PUBLISHED' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.survey.update).not.toHaveBeenCalled();
    });

    // 28
    it('stamps publishedAt server-side and audits the publish', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'DRAFT', publishedAt: null }));

      await service.changeStatus(manager, 'survey-1', { status: 'PUBLISHED' });

      const data = prisma.survey.update.mock.calls[0][0].data;
      expect(data.status).toBe('PUBLISHED');
      expect(data.publishedAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'survey.publish', resource: 'survey' }),
      );
    });

    // 29
    it('deletes only a DRAFT, directing a live survey to CLOSE instead', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'PUBLISHED' }));

      await expect(service.deleteSurvey(manager, 'survey-1')).rejects.toThrow(ConflictException);
      expect(prisma.survey.delete).not.toHaveBeenCalled();
    });

    // 30
    it('refuses to delete even a DRAFT once any response exists', async () => {
      setContext(manager, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'DRAFT', publishedAt: null }));
      prisma.surveyResponse.count.mockResolvedValue(1);

      await expect(service.deleteSurvey(manager, 'survey-1')).rejects.toThrow(
        /responses cannot be deleted/,
      );
      expect(prisma.survey.delete).not.toHaveBeenCalled();
    });
  });


  describe('participation', () => {
    const openSurvey = () => prisma.survey.findFirst.mockResolvedValue(surveyRow());

    const questions = (rows: Array<Record<string, unknown>>) =>
      prisma.surveyQuestion.findMany.mockResolvedValue(rows);

    const singleChoice = {
      id: 'q1',
      type: 'SINGLE_CHOICE',
      isRequired: true,
      maxSelections: null,
      options: [{ id: 'o1' }, { id: 'o2' }],
    };

    beforeEach(() => {
      prisma.$transaction.mockImplementation(
        async (fn: (tx: Record<string, Record<string, jest.Mock>>) => unknown) =>
          fn({
            surveyResponse: {
              create: jest
                .fn()
                .mockResolvedValue({ id: 'resp-1', createdAt: new Date('2026-08-30T09:00:00Z') }),
            },
            surveyAnswer: { createMany: jest.fn() },
          }),
      );
    });

    // 31
    it('accepts a valid response without requiring any permission', async () => {
      setContext(participant, tenantA);
      openSurvey();
      questions([singleChoice]);

      const result = await service.submitResponse(participant, 'survey-1', {
        answers: [{ questionId: 'q1', optionIds: ['o1'] }],
      });

      expect(result.responseId).toBe('resp-1');
      expect(result.surveyId).toBe('survey-1');
    });

    // 32
    it('stores the respondent id even on an anonymous survey — it is the dedupe key', async () => {
      setContext(participant, tenantA);
      openSurvey();
      questions([singleChoice]);

      let captured: Record<string, unknown> = {};
      prisma.$transaction.mockImplementation(
        async (fn: (tx: Record<string, Record<string, jest.Mock>>) => unknown) =>
          fn({
            surveyResponse: {
              create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
                captured = args.data;
                return { id: 'resp-1', createdAt: new Date() };
              }),
            },
            surveyAnswer: { createMany: jest.fn() },
          }),
      );

      await service.submitResponse(participant, 'survey-1', {
        answers: [{ questionId: 'q1', optionIds: ['o1'] }],
      });

      expect(captured.userId).toBe(participant);
      expect(captured.tenantId).toBe(tenantA);
    });

    // 33
    it('refuses participation in a survey that is not open', async () => {
      setContext(participant, tenantA);
      prisma.survey.findFirst.mockResolvedValue(surveyRow({ status: 'CLOSED' }));

      await expect(
        service.submitResponse(participant, 'survey-1', { answers: [] }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 34
    it('rejects a question id that does not belong to this survey', async () => {
      setContext(participant, tenantA);
      openSurvey();
      questions([singleChoice]);

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q-from-elsewhere', optionIds: ['o1'] }],
        }),
      ).rejects.toThrow(/Unknown question for this survey/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 35
    it('rejects an option id that belongs to a different question', async () => {
      setContext(participant, tenantA);
      openSurvey();
      questions([singleChoice]);

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q1', optionIds: ['o-other'] }],
        }),
      ).rejects.toThrow(/does not belong to question/);
    });
  });


  describe('one response per user', () => {
    const singleChoice = {
      id: 'q1',
      type: 'SINGLE_CHOICE',
      isRequired: true,
      maxSelections: null,
      options: [{ id: 'o1' }, { id: 'o2' }],
    };

    beforeEach(() => {
      prisma.survey.findFirst.mockResolvedValue(surveyRow());
      prisma.surveyQuestion.findMany.mockResolvedValue([singleChoice]);
    });

    // 36
    it('reports an already-submitted response as a conflict', async () => {
      setContext(participant, tenantA);
      prisma.surveyResponse.findUnique.mockResolvedValue({ id: 'resp-existing' });

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q1', optionIds: ['o1'] }],
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // 37
    it('translates the UNIQUE violation of a concurrent double-submit into 409', async () => {
      setContext(participant, tenantA);
      // The pre-check passes — this is the race the index, not the read, closes.
      prisma.surveyResponse.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q1', optionIds: ['o1'] }],
        }),
      ).rejects.toThrow(ConflictException);
    });

    // 38
    it('does not disguise an unrelated database failure as a conflict', async () => {
      setContext(participant, tenantA);
      prisma.surveyResponse.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q1', optionIds: ['o1'] }],
        }),
      ).rejects.toThrow(/connection reset/);
    });

    // 39
    it('rejects a second answer to the same question in one submission', async () => {
      setContext(participant, tenantA);
      prisma.surveyResponse.findUnique.mockResolvedValue(null);

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [
            { questionId: 'q1', optionIds: ['o1'] },
            { questionId: 'q1', optionIds: ['o2'] },
          ],
        }),
      ).rejects.toThrow(/Duplicate answer/);
    });

    // 40
    it('reports an omitted required question after validating the supplied ones', async () => {
      setContext(participant, tenantA);
      prisma.surveyResponse.findUnique.mockResolvedValue(null);
      prisma.surveyQuestion.findMany.mockResolvedValue([
        singleChoice,
        { id: 'q2', type: 'TEXT', isRequired: true, maxSelections: null, options: [] },
      ]);

      await expect(
        service.submitResponse(participant, 'survey-1', {
          answers: [{ questionId: 'q1', optionIds: ['o1'] }],
        }),
      ).rejects.toThrow(/Missing answers for required question/);
    });
  });


  describe('results and anonymity', () => {
    const resultsMocks = () => {
      prisma.survey.findFirst.mockResolvedValue(surveyRow());
      prisma.surveyQuestion.findMany.mockResolvedValue([
        {
          id: 'q1',
          type: 'SINGLE_CHOICE',
          text: 'کدام؟',
          isRequired: true,
          order: 1,
          maxSelections: null,
          options: [
            { id: 'o1', label: 'الف', order: 1 },
            { id: 'o2', label: 'ب', order: 2 },
          ],
        },
        {
          id: 'q2',
          type: 'TEXT',
          text: 'نظر شما',
          isRequired: false,
          order: 2,
          maxSelections: null,
          options: [],
        },
      ]);
      prisma.surveyResponse.count.mockResolvedValue(3);
      prisma.surveyAnswer.findMany.mockResolvedValue([
        { questionId: 'q2', textValue: 'خوب بود' },
      ]);
    };

    // 41
    it('refuses results to a manager who lacks admin.surveys.results', async () => {
      setContext(manager, tenantA);
      grant(Permissions.ADMIN_SURVEYS_MANAGE);

      await expect(service.getResults(manager, 'survey-1')).rejects.toThrow(ForbiddenException);
      expect(prisma.surveyAnswer.groupBy).not.toHaveBeenCalled();
    });

    // 42
    it('grants results on admin.surveys.results alone, without manage', async () => {
      setContext(viewer, tenantA);
      grant(Permissions.ADMIN_SURVEYS_RESULTS);
      resultsMocks();

      const results = await service.getResults(viewer, 'survey-1');

      expect(results.surveyId).toBe('survey-1');
      expect(results.responseCount).toBe(3);
    });

    // 43
    it('returns no respondent identifier anywhere in the aggregate', async () => {
      setContext(viewer, tenantA);
      grant(Permissions.ADMIN_SURVEYS_RESULTS);
      resultsMocks();

      const results = await service.getResults(viewer, 'survey-1');
      const serialized = JSON.stringify(results);

      expect(serialized).not.toContain(participant);
      expect(serialized).not.toContain('userId');
      expect(serialized).not.toContain('responseId');
      expect(results).not.toHaveProperty('tenantId');
    });

    // 44
    it('reports a null rating average when nobody has rated, never zero', async () => {
      setContext(viewer, tenantA);
      grant(Permissions.ADMIN_SURVEYS_RESULTS);
      prisma.survey.findFirst.mockResolvedValue(surveyRow());
      prisma.surveyQuestion.findMany.mockResolvedValue([
        {
          id: 'q3',
          type: 'RATING',
          text: 'امتیاز',
          isRequired: true,
          order: 1,
          maxSelections: null,
          options: [],
        },
      ]);
      prisma.surveyResponse.count.mockResolvedValue(0);

      const results = await service.getResults(viewer, 'survey-1');

      expect(results.questions[0].ratingAverage).toBeNull();
      expect(results.questions[0].ratingDistribution).toEqual([]);
    });

    // 45
    it('never audits a read', async () => {
      setContext(viewer, tenantA);
      grant(Permissions.ADMIN_SURVEYS_RESULTS);
      resultsMocks();

      await service.getResults(viewer, 'survey-1');
      await service.getSurvey(viewer, 'survey-1');
      prisma.survey.findMany.mockResolvedValue([]);
      await service.listSurveys(viewer, {});

      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});


