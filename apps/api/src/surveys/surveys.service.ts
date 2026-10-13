import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, SurveyQuestionType, SurveyStatus } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { AuditService } from '../common/audit.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { Permissions } from '../auth/rbac/constants/permissions';
import { SurveyQueryDto } from './dto/survey-query.dto';
import {
  ChangeSurveyStatusDto,
  CreateSurveyDto,
  MAX_OPTIONS_PER_QUESTION,
  SubmitSurveyResponseDto,
  SurveyQuestionInputDto,
  UpdateSurveyDto,
} from './dto/survey.dto';
import {
  allowedSurveyTransitions,
  canTransitionSurvey,
  isSurveyOpen,
} from './survey-status.util';

/**
 * Phase 49H: Core Surveys / Participation domain service.
 *
 * Authorization has exactly three edges and no fourth:
 *
 *  - PARTICIPANT — any authenticated user. May list and read surveys that are open
 *    to them in their own tenant, and may submit exactly one response to each.
 *    Participation is NOT gated on a permission (see the seed migration): it is an
 *    authenticated-user capability bounded by tenant and survey status.
 *  - MANAGER — a caller holding `admin.surveys.manage`. Authors, edits, publishes
 *    and closes surveys inside their own tenant, and nothing outside it.
 *  - RESULTS VIEWER — a caller holding `admin.surveys.results`. Reads aggregates.
 *    This is a SEPARATE permission from manage, so authoring a survey does not by
 *    itself confer sight of the answers.
 *
 * Identity NEVER comes from a body field, query parameter or path segment: it is
 * resolved from RequestContextService, exactly as DirectoryService (49D-1),
 * NotificationService (49E), MessagingService (49F) and SupportService (49G) do.
 * Tenant is likewise a server-derived snapshot and is never projected to the client.
 *
 * ANONYMITY IS A PROJECTION RULE, NOT A STORAGE RULE. `SurveyResponse.userId` is
 * always written, because the (surveyId, userId) UNIQUE constraint is what prevents
 * double participation. For an anonymous survey this service simply never selects
 * or returns it. Nothing here can honestly claim a respondent is unidentifiable to
 * someone with database access, and no comment or message pretends otherwise.
 *
 * Reads are never audited. Only privileged mutations (create, edit, publish, close,
 * delete) are, matching the existing AuditService usage in RoleService and
 * SupportService.
 */

export const DEFAULT_SURVEY_LIMIT = 20;
export const MAX_SURVEY_LIMIT = 100;

/**
 * Allowlisted person projection, identical in spirit to SupportService's
 * TICKET_USER_SELECT: never passwordHash, tokenVersion, email verification state,
 * employee code or tenantId. A denylist would leak every future column.
 */
const SURVEY_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  jobTitle: true,
} satisfies Prisma.UserSelect;

const OPTION_SELECT = {
  id: true,
  label: true,
  order: true,
} satisfies Prisma.SurveyOptionSelect;

const QUESTION_SELECT = {
  id: true,
  type: true,
  text: true,
  isRequired: true,
  order: true,
  maxSelections: true,
  options: { select: OPTION_SELECT, orderBy: { order: 'asc' } },
} satisfies Prisma.SurveyQuestionSelect;

/** `tenantId` is intentionally absent: it is internal isolation metadata. */
const SURVEY_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  isAnonymous: true,
  startsAt: true,
  endsAt: true,
  publishedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  createdBy: { select: SURVEY_USER_SELECT },
} satisfies Prisma.SurveySelect;

export interface SurveyUserDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

export interface SurveyOptionDto {
  id: string;
  label: string;
  order: number;
}

export interface SurveyQuestionDto {
  id: string;
  type: SurveyQuestionType;
  text: string;
  isRequired: boolean;
  order: number;
  maxSelections: number | null;
  options: SurveyOptionDto[];
}

export interface SurveyDto {
  id: string;
  title: string;
  description: string | null;
  status: SurveyStatus;
  isAnonymous: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: SurveyUserDto;
  questionCount: number;
  /** True when the caller may author/edit this survey. */
  canManage: boolean;
  /** True when the caller may read this survey's aggregated results. */
  canViewResults: boolean;
  /** True when the survey is open AND the caller has not already responded. */
  canRespond: boolean;
  /** True when the caller has already submitted a response. */
  hasResponded: boolean;
  /** Transitions the caller can actually perform right now. */
  availableTransitions: SurveyStatus[];
}

export interface SurveyDetailDto extends SurveyDto {
  questions: SurveyQuestionDto[];
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

interface Scope {
  userId: string;
  tenantId: string | null;
  canManage: boolean;
  canViewResults: boolean;
}

/**
 * Aggregated results.
 *
 * AGGREGATION THRESHOLD POLICY: NOT DEFINED. No repo evidence establishes a minimum
 * respondent count below which aggregates are withheld, and none is invented here.
 * A consequence follows and is stated rather than hidden: on an anonymous survey
 * with a single respondent, the aggregate IS that person's answer set. Anonymity in
 * this module means identity is not projected, not that answers are
 * unattributable-by-inference.
 */
export interface SurveyOptionResultDto {
  optionId: string;
  label: string;
  order: number;
  count: number;
}

export interface SurveyQuestionResultDto {
  questionId: string;
  type: SurveyQuestionType;
  text: string;
  order: number;
  /** Number of responses that answered THIS question (not the survey total). */
  answeredCount: number;
  /** Populated for the two choice types; empty otherwise. */
  options: SurveyOptionResultDto[];
  /** Populated for RATING only. */
  ratingAverage: number | null;
  ratingDistribution: { value: number; count: number }[];
  /**
   * Free-text answers, for TEXT questions only. Never accompanied by an author on
   * an anonymous survey — and on a non-anonymous one, still not accompanied by one,
   * because this module has no per-answer attribution endpoint at all.
   */
  textAnswers: string[];
}

export interface SurveyResultsDto {
  surveyId: string;
  title: string;
  status: SurveyStatus;
  isAnonymous: boolean;
  responseCount: number;
  questions: SurveyQuestionResultDto[];
}

/** What a participant gets back after submitting. Deliberately minimal. */
export interface SurveySubmissionResultDto {
  responseId: string;
  surveyId: string;
  submittedAt: Date;
}

@Injectable()
export class SurveysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    // Optional for the same reason RoleService and SupportService make it optional:
    // a trimmed test module must be able to exercise the domain rules without
    // wiring the audit pipeline, and a missing audit sink must never break business
    // logic.
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Resolves the caller's own scope and asserts it matches the subject the
   * controller passed in. A mismatch is refused rather than trusting the argument,
   * so no code path can act as another user.
   *
   * Both capabilities are resolved from the RBAC permission service — never from a
   * role name string, a header, or anything the client controls.
   */
  private async scope(userId: string): Promise<Scope> {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Survey context is required');
    }

    const [canManage, canViewResults] = await Promise.all([
      this.permissions.userHasPermission(userId, Permissions.ADMIN_SURVEYS_MANAGE),
      this.permissions.userHasPermission(userId, Permissions.ADMIN_SURVEYS_RESULTS),
    ]);

    return { userId, tenantId: context.tenantId ?? null, canManage, canViewResults };
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? DEFAULT_SURVEY_LIMIT, 1), MAX_SURVEY_LIMIT);
  }

  /**
   * The single visibility predicate, used by every read.
   *
   * A manager sees every survey in their tenant, including drafts. Everyone else
   * sees only surveys in their tenant that have been published — a draft is not
   * merely un-answerable, it is invisible, so an unfinished questionnaire cannot be
   * read early.
   *
   * Tenant is always part of the predicate, including when it is null — dropping a
   * null tenant would silently widen the query to every tenant-less survey in the
   * database.
   */
  private visibility(scope: Scope): Prisma.SurveyWhereInput {
    if (scope.canManage) {
      return { tenantId: scope.tenantId };
    }

    return { tenantId: scope.tenantId, status: { in: ['PUBLISHED', 'CLOSED'] } };
  }

  /**
   * Loads one survey the caller is allowed to see, or throws 404.
   *
   * A survey in another tenant, or a draft seen by a non-manager, is
   * indistinguishable from a non-existent one — both 404 — which is why survey ids
   * cannot be probed.
   */
  private async requireVisible(scope: Scope, id: string) {
    const survey = await this.prisma.survey.findFirst({
      where: { id, ...this.visibility(scope) },
      select: { ...SURVEY_SELECT, tenantId: true },
    });

    if (!survey) {
      throw new NotFoundException('Survey not found');
    }

    return survey;
  }

  /** Manager-only gate for the authoring routes. */
  private requireManager(scope: Scope): void {
    if (!scope.canManage) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  private projectUser(user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    jobTitle: string | null;
  }): SurveyUserDto {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      jobTitle: user.jobTitle,
    };
  }

  /**
   * Projects one survey row for one caller.
   *
   * `canRespond` is computed, not stored: it is the conjunction of "the survey is
   * open right now" (see `isSurveyOpen` — an expired window closes a survey even
   * though no CLOSED transition has run) and "this caller has not already
   * responded". Because it is derived per caller, the same row projects differently
   * for two people, which is exactly what the UI needs to decide between an
   * answer form and a "you already participated" state.
   */
  private projectSurvey(
    scope: Scope,
    row: {
      id: string;
      title: string;
      description: string | null;
      status: SurveyStatus;
      isAnonymous: boolean;
      startsAt: Date | null;
      endsAt: Date | null;
      publishedAt: Date | null;
      closedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      createdById: string;
      createdBy: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        avatarUrl: string | null;
        jobTitle: string | null;
      };
    },
    extras: { questionCount: number; hasResponded: boolean },
  ): SurveyDto {
    const open = isSurveyOpen(row);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      isAnonymous: row.isAnonymous,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      publishedAt: row.publishedAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: this.projectUser(row.createdBy),
      questionCount: extras.questionCount,
      canManage: scope.canManage,
      canViewResults: scope.canViewResults,
      canRespond: open && !extras.hasResponded,
      hasResponded: extras.hasResponded,
      // A non-manager is shown no transitions at all: they cannot move the
      // lifecycle, so offering them would misrepresent what the API allows.
      availableTransitions: scope.canManage ? allowedSurveyTransitions(row.status) : [],
    };
  }

  /**
   * Cursor page of surveys the caller may see, newest first.
   *
   * `scope=all` is honoured only for a manager; for anyone else it collapses to
   * `available`, because the visibility predicate is applied unconditionally and the
   * scope filter is additive. A participant therefore cannot widen their result set
   * by choosing a scope, nor by asking for `status=DRAFT`.
   */
  async listSurveys(userId: string, query: SurveyQueryDto): Promise<PageResult<SurveyDto>> {
    const scope = await this.scope(userId);
    const limit = this.clampLimit(query.limit);
    const now = new Date();

    const effectiveScope = query.scope ?? (scope.canManage ? 'all' : 'available');
    const wantsAvailable = !scope.canManage || effectiveScope === 'available';

    const where: Prisma.SurveyWhereInput = {
      ...this.visibility(scope),
      ...(effectiveScope === 'mine' ? { createdById: scope.userId } : {}),
      ...(query.status ? { status: query.status as SurveyStatus } : {}),
      // The availability window, expressed in SQL so an expired survey never
      // reaches the "available" page even though its status is still PUBLISHED.
      ...(wantsAvailable
        ? {
            status: 'PUBLISHED' as SurveyStatus,
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
            ],
          }
        : {}),
    };

    // Over-fetch by one to decide `hasMore` without a second COUNT.
    const rows = await this.prisma.survey.findMany({
      where,
      select: { ...SURVEY_SELECT, _count: { select: { questions: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const responded = await this.respondedSurveyIds(
      scope.userId,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) =>
        this.projectSurvey(scope, row, {
          questionCount: row._count.questions,
          hasResponded: responded.has(row.id),
        }),
      ),
      hasMore,
    };
  }

  /**
   * Which of these surveys the caller has already answered.
   *
   * One query for the whole page rather than one per row. Only the caller's OWN
   * response rows are read, so this cannot be used to learn who else participated —
   * `userId` is pinned to the caller, not accepted as a parameter.
   */
  private async respondedSurveyIds(userId: string, surveyIds: string[]): Promise<Set<string>> {
    if (surveyIds.length === 0) return new Set();

    const rows = await this.prisma.surveyResponse.findMany({
      where: { userId, surveyId: { in: surveyIds } },
      select: { surveyId: true },
    });

    return new Set(rows.map((row) => row.surveyId));
  }

  /** One survey with its full questionnaire, ordered. */
  async getSurvey(userId: string, id: string): Promise<SurveyDetailDto> {
    const scope = await this.scope(userId);
    const survey = await this.requireVisible(scope, id);

    const [questions, existing] = await Promise.all([
      this.prisma.surveyQuestion.findMany({
        where: { surveyId: id },
        select: QUESTION_SELECT,
        orderBy: { order: 'asc' },
      }),
      this.prisma.surveyResponse.findUnique({
        where: { surveyId_userId: { surveyId: id, userId: scope.userId } },
        select: { id: true },
      }),
    ]);

    return {
      ...this.projectSurvey(scope, survey, {
        questionCount: questions.length,
        hasResponded: Boolean(existing),
      }),
      questions,
    };
  }

  /**
   * Validates a questionnaire payload against its own declared types.
   *
   * This is the one place that decides what a well-formed question is, so the
   * create path, the draft-edit path and the submission path cannot drift:
   *
   *  - SINGLE_CHOICE / MULTIPLE_CHOICE MUST carry at least two options. One option
   *    is not a choice, it is a forced answer, and it would produce an aggregate
   *    with a single 100% bar that says nothing.
   *  - TEXT / RATING MUST NOT carry options at all. Accepting and discarding them
   *    would let an author believe they had configured something that is never read.
   *  - `maxSelections` is MULTIPLE_CHOICE-only and cannot exceed the option count —
   *    a maximum above the number of options is unreachable and therefore a
   *    mistake, not a permissive setting. The `SurveyQuestion_max_selections_scope`
   *    CHECK enforces the type half of this at the database level too.
   */
  private assertQuestionShape(question: SurveyQuestionInputDto, index: number): void {
    const at = `questions[${index}]`;
    const isChoice = question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE';
    const options = question.options ?? [];

    if (isChoice) {
      if (options.length < 2) {
        throw new BadRequestException(`${at}: a choice question requires at least two options`);
      }
      if (options.length > MAX_OPTIONS_PER_QUESTION) {
        throw new BadRequestException(
          `${at}: at most ${MAX_OPTIONS_PER_QUESTION} options are allowed`,
        );
      }
      // Duplicate labels would render as two indistinguishable bars in the result
      // view, so they are refused at authoring time rather than deduplicated.
      const labels = new Set(options.map((option) => option.label));
      if (labels.size !== options.length) {
        throw new BadRequestException(`${at}: option labels must be distinct`);
      }
    } else if (options.length > 0) {
      throw new BadRequestException(`${at}: a ${question.type} question cannot carry options`);
    }

    if (question.maxSelections !== undefined && question.maxSelections !== null) {
      if (question.type !== 'MULTIPLE_CHOICE') {
        throw new BadRequestException(
          `${at}: maxSelections applies only to a MULTIPLE_CHOICE question`,
        );
      }
      if (question.maxSelections > options.length) {
        throw new BadRequestException(`${at}: maxSelections cannot exceed the option count`);
      }
    }
  }

  /**
   * Validates and normalises the availability window.
   *
   * Returns Date objects (or null) so the caller never passes raw strings to Prisma.
   * An inverted window is refused here with a clear 400 rather than reaching the
   * `Survey_window_order` CHECK, which would surface as an opaque 500.
   */
  private resolveWindow(input: { startsAt?: string; endsAt?: string }): {
    startsAt: Date | null;
    endsAt: Date | null;
  } {
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;

    if (startsAt && Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('startsAt is not a valid date');
    }
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('endsAt is not a valid date');
    }
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    return { startsAt, endsAt };
  }

  /**
   * Builds the nested create payload for a questionnaire.
   *
   * `order` is assigned from the array index (1-based), never taken from the client:
   * that is what makes `SurveyQuestion_surveyId_order_key` and
   * `SurveyOption_questionId_order_key` unviolatable by a malformed payload.
   */
  private buildQuestionCreates(
    questions: SurveyQuestionInputDto[],
  ): Prisma.SurveyQuestionCreateWithoutSurveyInput[] {
    return questions.map((question, index) => {
      this.assertQuestionShape(question, index);

      return {
        type: question.type as SurveyQuestionType,
        text: question.text,
        isRequired: question.isRequired ?? true,
        order: index + 1,
        maxSelections:
          question.type === 'MULTIPLE_CHOICE' ? question.maxSelections ?? null : null,
        options: question.options?.length
          ? {
              create: question.options.map((option, optionIndex) => ({
                label: option.label,
                order: optionIndex + 1,
              })),
            }
          : undefined,
      };
    });
  }

  /**
   * Creates a survey as a DRAFT, with its whole questionnaire, in one nested write.
   *
   * A survey is ALWAYS created as a draft: `status`, `publishedAt` and `closedAt` are
   * not accepted from the client, so nothing can be created already-published and
   * thereby skip review. The questionnaire is part of the same write, so a survey can
   * never exist with zero questions.
   */
  async createSurvey(userId: string, dto: CreateSurveyDto): Promise<SurveyDetailDto> {
    const scope = await this.scope(userId);
    this.requireManager(scope);

    const { startsAt, endsAt } = this.resolveWindow(dto);
    const questions = this.buildQuestionCreates(dto.questions);

    const created = await this.prisma.survey.create({
      data: {
        tenantId: scope.tenantId,
        title: dto.title,
        description: dto.description ?? null,
        status: 'DRAFT',
        isAnonymous: dto.isAnonymous ?? false,
        startsAt,
        endsAt,
        createdById: scope.userId,
        questions: { create: questions },
      },
      select: { id: true, title: true, isAnonymous: true },
    });

    await this.emitAudit({
      action: 'survey.create',
      actorId: scope.userId,
      resourceId: created.id,
      newValue: {
        title: created.title,
        isAnonymous: created.isAnonymous,
        questionCount: questions.length,
      },
    });

    return this.getSurvey(userId, created.id);
  }

  /**
   * Edits a DRAFT survey.
   *
   * DRAFT-ONLY, and that is the central rule of this method. Once a survey is
   * published its questionnaire is frozen: people may already have answered, and
   * editing a question's text or replacing its options would silently re-interpret
   * answers that were given to a different question. The `SurveyAnswer.optionId`
   * foreign key is `ON DELETE RESTRICT` for the same reason — the database refuses
   * to let an answered option disappear even if this check were bypassed.
   *
   * `isAnonymous` is likewise frozen after DRAFT, because flipping it would
   * retroactively change the privacy terms participants answered under.
   *
   * When `questions` is present the whole questionnaire is REPLACED inside a
   * transaction: old rows are deleted and new ones created with fresh 1-based
   * ordering. A draft has no responses, so nothing can be orphaned by the delete.
   */
  async updateSurvey(
    userId: string,
    id: string,
    dto: UpdateSurveyDto,
  ): Promise<SurveyDetailDto> {
    const scope = await this.scope(userId);
    this.requireManager(scope);

    const survey = await this.requireVisible(scope, id);

    if (survey.status !== 'DRAFT') {
      throw new ConflictException('Only a draft survey can be edited');
    }

    // Window validation uses the incoming value when supplied and the stored one
    // otherwise, so patching only `endsAt` still cannot invert an existing window.
    const { startsAt, endsAt } = this.resolveWindow({
      startsAt: dto.startsAt ?? survey.startsAt?.toISOString(),
      endsAt: dto.endsAt ?? survey.endsAt?.toISOString(),
    });

    const questionCreates =
      dto.questions !== undefined ? this.buildQuestionCreates(dto.questions) : null;

    await this.prisma.$transaction(async (tx) => {
      if (questionCreates) {
        // Options and answers cascade from the question rows; a draft has no
        // answers, so this deletes questions and their options only.
        await tx.surveyQuestion.deleteMany({ where: { surveyId: id } });
      }

      await tx.survey.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.isAnonymous !== undefined ? { isAnonymous: dto.isAnonymous } : {}),
          startsAt,
          endsAt,
          ...(questionCreates ? { questions: { create: questionCreates } } : {}),
        },
      });
    });

    await this.emitAudit({
      action: 'survey.update',
      actorId: scope.userId,
      resourceId: id,
      changedFields: Object.keys(dto),
      oldValue: {
        title: survey.title,
        description: survey.description,
        isAnonymous: survey.isAnonymous,
        startsAt: survey.startsAt,
        endsAt: survey.endsAt,
      },
      newValue: {
        title: dto.title ?? survey.title,
        description: dto.description ?? survey.description,
        isAnonymous: dto.isAnonymous ?? survey.isAnonymous,
        startsAt,
        endsAt,
        ...(questionCreates ? { questionCount: questionCreates.length } : {}),
      },
    });

    return this.getSurvey(userId, id);
  }

  /**
   * Moves a survey along its lifecycle: DRAFT → PUBLISHED → CLOSED.
   *
   * Every guard here exists because of something that would otherwise be
   * unrecoverable:
   *
   *  - The transition must be an explicitly allowed edge (`canTransitionSurvey`).
   *    There is no reverse edge, so publishing is a one-way door.
   *  - Publishing requires at least one question. A published survey with nothing to
   *    answer would be visible to the whole tenant and answerable by no one.
   *  - `publishedAt` / `closedAt` are stamped here, server-side, and never accepted
   *    from a client. The `Survey_status_timestamps` CHECK refuses any row where the
   *    status and the timestamps disagree, so a bug here fails loudly at the database
   *    rather than producing a survey that is closed but never published.
   */
  async changeStatus(
    userId: string,
    id: string,
    dto: ChangeSurveyStatusDto,
  ): Promise<SurveyDetailDto> {
    const scope = await this.scope(userId);
    this.requireManager(scope);

    const survey = await this.requireVisible(scope, id);
    const to = dto.status as SurveyStatus;

    if (!canTransitionSurvey(survey.status, to)) {
      throw new ConflictException(
        `Cannot move a ${survey.status} survey to ${to}`,
      );
    }

    if (to === 'PUBLISHED') {
      const questionCount = await this.prisma.surveyQuestion.count({ where: { surveyId: id } });
      if (questionCount === 0) {
        throw new BadRequestException('A survey must have at least one question to be published');
      }
    }

    const now = new Date();

    await this.prisma.survey.update({
      where: { id },
      data: {
        status: to,
        ...(to === 'PUBLISHED' ? { publishedAt: survey.publishedAt ?? now } : {}),
        ...(to === 'CLOSED' ? { closedAt: now } : {}),
      },
    });

    await this.emitAudit({
      action: to === 'PUBLISHED' ? 'survey.publish' : 'survey.close',
      actorId: scope.userId,
      resourceId: id,
      changedFields: ['status'],
      oldValue: { status: survey.status },
      newValue: { status: to },
    });

    return this.getSurvey(userId, id);
  }

  /**
   * Deletes a survey.
   *
   * Allowed for a DRAFT only. Deleting a published or closed survey would destroy
   * the responses people submitted, and this module has no way to return them — so
   * abandoning a live survey is CLOSE, not delete. That asymmetry is deliberate:
   * the destructive operation is restricted to the state in which nothing can be
   * lost.
   */
  async deleteSurvey(userId: string, id: string): Promise<{ deleted: true; id: string }> {
    const scope = await this.scope(userId);
    this.requireManager(scope);

    const survey = await this.requireVisible(scope, id);

    if (survey.status !== 'DRAFT') {
      throw new ConflictException('Only a draft survey can be deleted; close it instead');
    }

    // Defence in depth: a draft cannot have responses, but if one somehow existed
    // the delete would silently cascade them away, so it is refused instead.
    const responseCount = await this.prisma.surveyResponse.count({ where: { surveyId: id } });
    if (responseCount > 0) {
      throw new ConflictException('A survey with responses cannot be deleted');
    }

    await this.prisma.survey.delete({ where: { id } });

    await this.emitAudit({
      action: 'survey.delete',
      actorId: scope.userId,
      resourceId: id,
      oldValue: { title: survey.title, status: survey.status },
    });

    return { deleted: true, id };
  }

  /**
   * Submits the caller's ONE response to a survey.
   *
   * Ordering of the guards matters, and each one closes a specific hole:
   *
   *  1. `requireVisible` — a survey in another tenant 404s, so a leaked id from
   *     another tenant is not answerable (the cross-tenant IDOR case).
   *  2. `isSurveyOpen` — a draft, a closed survey, an unopened window and an EXPIRED
   *     window are all refused. Expiry is checked against the clock, not the status
   *     column, because nothing flips an expired survey to CLOSED.
   *  3. Every submitted `questionId` is resolved against THIS survey's questions, and
   *     every `optionId` against the resolved question's own options. A question or
   *     option id belonging to a different survey is therefore not merely
   *     unauthorized, it is unresolvable — which is the structural reason answers
   *     cannot be smuggled across surveys.
   *  4. Cardinality and required-ness are enforced per question type.
   *
   * The write is a single transaction: response and answers land together or not at
   * all, so no half-populated response can exist.
   *
   * DOUBLE SUBMISSION is stopped by the `SurveyResponse_surveyId_userId_key` UNIQUE
   * index, not by a preceding read. A check-then-insert would leave a race window
   * between the two statements; two concurrent requests would both pass the check.
   * Instead both attempt the insert, the database rejects the loser, and P2002 is
   * translated to 409. The pre-check below exists only to produce a friendlier error
   * in the common sequential case — it is not the enforcement mechanism.
   */
  async submitResponse(
    userId: string,
    surveyId: string,
    dto: SubmitSurveyResponseDto,
  ): Promise<SurveySubmissionResultDto> {
    const scope = await this.scope(userId);
    const survey = await this.requireVisible(scope, surveyId);

    if (!isSurveyOpen(survey)) {
      throw new ConflictException('This survey is not open for participation');
    }

    const questions = await this.prisma.surveyQuestion.findMany({
      where: { surveyId },
      select: {
        id: true,
        type: true,
        isRequired: true,
        maxSelections: true,
        options: { select: { id: true } },
      },
      orderBy: { order: 'asc' },
    });

    const answerRows = this.buildAnswerRows(questions, dto);

    const existing = await this.prisma.surveyResponse.findUnique({
      where: { surveyId_userId: { surveyId, userId: scope.userId } },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('You have already responded to this survey');
    }

    try {
      const response = await this.prisma.$transaction(async (tx) => {
        const created = await tx.surveyResponse.create({
          data: {
            surveyId,
            // Always stored — it is the duplicate-prevention key. Never projected
            // back on an anonymous survey.
            userId: scope.userId,
            tenantId: scope.tenantId,
          },
          select: { id: true, createdAt: true },
        });

        await tx.surveyAnswer.createMany({
          data: answerRows.map((row) => ({ ...row, responseId: created.id })),
        });

        return created;
      });

      return { responseId: response.id, surveyId, submittedAt: response.createdAt };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // The concurrent loser lands here. Reported as a conflict, not a 500,
        // because the outcome is correct: exactly one response now exists.
        throw new ConflictException('You have already responded to this survey');
      }
      throw error;
    }
  }

  /**
   * Turns a submission into `SurveyAnswer` rows, or throws.
   *
   * Pure and synchronous on purpose: every rule is decided before the transaction
   * opens, so a rejected submission never starts a write it cannot finish.
   *
   * Per type:
   *   SINGLE_CHOICE   → exactly one optionId, one row
   *   MULTIPLE_CHOICE → 1..maxSelections optionIds, one row EACH
   *   TEXT            → one row with textValue
   *   RATING          → one row with ratingValue
   *
   * Duplicate `optionIds` within one answer are rejected rather than deduplicated:
   * silently collapsing them would report success for a payload that was not what
   * the client sent, and the `SurveyAnswer_choice_unique` partial index would reject
   * them anyway.
   */
  private buildAnswerRows(
    questions: {
      id: string;
      type: SurveyQuestionType;
      isRequired: boolean;
      maxSelections: number | null;
      options: { id: string }[];
    }[],
    dto: SubmitSurveyResponseDto,
  ): { questionId: string; optionId: string | null; textValue: string | null; ratingValue: number | null }[] {
    const byId = new Map(questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    const rows: {
      questionId: string;
      optionId: string | null;
      textValue: string | null;
      ratingValue: number | null;
    }[] = [];

    for (const answer of dto.answers) {
      const question = byId.get(answer.questionId);

      // Not "forbidden": from this survey's perspective the question does not
      // exist. This is the check that defeats cross-survey question ids.
      if (!question) {
        throw new BadRequestException(`Unknown question for this survey: ${answer.questionId}`);
      }

      // One answer per question per response; the `SurveyAnswer_scalar_unique`
      // partial index enforces the same thing for non-choice answers.
      if (seen.has(question.id)) {
        throw new BadRequestException(`Duplicate answer for question ${question.id}`);
      }
      seen.add(question.id);

      const optionIds = answer.optionIds ?? [];

      switch (question.type) {
        case 'SINGLE_CHOICE':
        case 'MULTIPLE_CHOICE': {
          if (answer.textValue !== undefined || answer.ratingValue !== undefined) {
            throw new BadRequestException(
              `Question ${question.id} expects option selections, not a text or rating value`,
            );
          }
          if (optionIds.length === 0) {
            throw new BadRequestException(`Question ${question.id} requires an option selection`);
          }
          if (question.type === 'SINGLE_CHOICE' && optionIds.length !== 1) {
            throw new BadRequestException(
              `Question ${question.id} accepts exactly one option`,
            );
          }
          if (new Set(optionIds).size !== optionIds.length) {
            throw new BadRequestException(`Question ${question.id} has duplicate option selections`);
          }

          const limit = question.maxSelections ?? question.options.length;
          if (optionIds.length > limit) {
            throw new BadRequestException(
              `Question ${question.id} accepts at most ${limit} option(s)`,
            );
          }

          // Every option is resolved through the question that owns it, so an
          // option belonging to another question — in this survey or any other —
          // cannot be attached here.
          const allowed = new Set(question.options.map((option) => option.id));
          for (const optionId of optionIds) {
            if (!allowed.has(optionId)) {
              throw new BadRequestException(
                `Option ${optionId} does not belong to question ${question.id}`,
              );
            }
            rows.push({ questionId: question.id, optionId, textValue: null, ratingValue: null });
          }
          break;
        }

        case 'TEXT': {
          if (optionIds.length > 0 || answer.ratingValue !== undefined) {
            throw new BadRequestException(`Question ${question.id} expects a text value`);
          }
          if (!answer.textValue) {
            throw new BadRequestException(`Question ${question.id} requires a text value`);
          }
          rows.push({
            questionId: question.id,
            optionId: null,
            textValue: answer.textValue,
            ratingValue: null,
          });
          break;
        }

        case 'RATING': {
          if (optionIds.length > 0 || answer.textValue !== undefined) {
            throw new BadRequestException(`Question ${question.id} expects a rating value`);
          }
          if (answer.ratingValue === undefined) {
            throw new BadRequestException(`Question ${question.id} requires a rating value`);
          }
          rows.push({
            questionId: question.id,
            optionId: null,
            textValue: null,
            ratingValue: answer.ratingValue,
          });
          break;
        }
      }
    }

    // Required questions are checked LAST, against what was actually resolved, so
    // an omitted required question is reported even when every supplied answer was
    // individually valid.
    const missing = questions.filter((question) => question.isRequired && !seen.has(question.id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing answers for required question(s): ${missing.map((q) => q.id).join(', ')}`,
      );
    }

    return rows;
  }

  /**
   * Aggregated results for one survey.
   *
   * Gated on `admin.surveys.results`, which is a SEPARATE permission from
   * `admin.surveys.manage`: authoring a survey does not by itself grant sight of the
   * answers, so the two capabilities can be given to different people.
   *
   * WHAT THIS RETURNS AND WHAT IT DOES NOT:
   *  - Counts per option, a rating average with its distribution, and the raw text of
   *    free-text answers.
   *  - NO `userId`, email, employee code, tenant id, or response id — not for an
   *    anonymous survey and not for a named one. This module has no per-respondent
   *    result view at all, so there is no endpoint that maps an answer to a person.
   *
   * AGGREGATION THRESHOLD POLICY: NOT DEFINED. No minimum respondent count is
   * enforced, because no repo evidence establishes one and inventing a threshold
   * would be a policy decision this phase has no mandate to make. The honest
   * consequence: with a single respondent, an anonymous aggregate IS that person's
   * answer set, and a viewer who knows who participated can read it as such.
   */
  async getResults(userId: string, surveyId: string): Promise<SurveyResultsDto> {
    const scope = await this.scope(userId);

    if (!scope.canViewResults) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const survey = await this.requireVisible(scope, surveyId);

    const questions = await this.prisma.surveyQuestion.findMany({
      where: { surveyId },
      select: QUESTION_SELECT,
      orderBy: { order: 'asc' },
    });

    const questionIds = questions.map((question) => question.id);
    const textQuestionIds = questions
      .filter((question) => question.type === 'TEXT')
      .map((question) => question.id);

    // Set-based aggregates for the whole survey rather than per-question loops.
    // `responseId` is only ever COUNTED, never selected, so no aggregate row carries
    // an identifier that could be joined back to a respondent.
    const [responseCount, optionCounts, scalarAnswered, choiceAnswered, ratingRows, textRows] =
      await Promise.all([
        this.prisma.surveyResponse.count({ where: { surveyId } }),
        questionIds.length
          ? this.prisma.surveyAnswer.groupBy({
              by: ['questionId', 'optionId'],
              where: { questionId: { in: questionIds }, optionId: { not: null } },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        questionIds.length
          ? this.prisma.surveyAnswer.groupBy({
              by: ['questionId'],
              where: { questionId: { in: questionIds }, optionId: null },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        // For a MULTIPLE_CHOICE question one respondent produces several rows, so a
        // raw row count would overstate participation. Counting `responseId` gives
        // the number of responses that touched the question.
        questionIds.length
          ? this.prisma.surveyAnswer.groupBy({
              by: ['questionId'],
              where: { questionId: { in: questionIds }, optionId: { not: null } },
              _count: { responseId: true },
            })
          : Promise.resolve([]),
        questionIds.length
          ? this.prisma.surveyAnswer.groupBy({
              by: ['questionId', 'ratingValue'],
              where: { questionId: { in: questionIds }, ratingValue: { not: null } },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        textQuestionIds.length
          ? this.prisma.surveyAnswer.findMany({
              where: { questionId: { in: textQuestionIds }, textValue: { not: null } },
              select: { questionId: true, textValue: true },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);

    const optionCountBy = new Map<string, number>();
    for (const row of optionCounts) {
      if (row.optionId) optionCountBy.set(`${row.questionId}:${row.optionId}`, row._count._all);
    }

    const scalarAnsweredBy = new Map<string, number>();
    for (const row of scalarAnswered) scalarAnsweredBy.set(row.questionId, row._count._all);

    const choiceAnsweredBy = new Map<string, number>();
    for (const row of choiceAnswered) {
      choiceAnsweredBy.set(row.questionId, row._count.responseId);
    }

    const ratingBy = new Map<string, { value: number; count: number }[]>();
    for (const row of ratingRows) {
      if (row.ratingValue === null) continue;
      const list = ratingBy.get(row.questionId) ?? [];
      list.push({ value: row.ratingValue, count: row._count._all });
      ratingBy.set(row.questionId, list);
    }

    const textBy = new Map<string, string[]>();
    for (const row of textRows) {
      if (!row.textValue) continue;
      const list = textBy.get(row.questionId) ?? [];
      list.push(row.textValue);
      textBy.set(row.questionId, list);
    }

    return {
      surveyId: survey.id,
      title: survey.title,
      status: survey.status,
      isAnonymous: survey.isAnonymous,
      responseCount,
      questions: questions.map((question) => {
        const isChoice = question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE';

        const distribution = (ratingBy.get(question.id) ?? []).sort((a, b) => a.value - b.value);
        const ratingTotal = distribution.reduce((sum, row) => sum + row.count, 0);
        const ratingSum = distribution.reduce((sum, row) => sum + row.value * row.count, 0);

        return {
          questionId: question.id,
          type: question.type,
          text: question.text,
          order: question.order,
          answeredCount: isChoice
            ? choiceAnsweredBy.get(question.id) ?? 0
            : scalarAnsweredBy.get(question.id) ?? 0,
          options: isChoice
            ? question.options.map((option) => ({
                optionId: option.id,
                label: option.label,
                order: option.order,
                count: optionCountBy.get(`${question.id}:${option.id}`) ?? 0,
              }))
            : [],
          // Rounded to two decimals so the UI never formats a long float. Null, not
          // 0, when nobody has rated: 0 is not a valid rating and would read as a
          // real result.
          ratingAverage:
            question.type === 'RATING' && ratingTotal > 0
              ? Math.round((ratingSum / ratingTotal) * 100) / 100
              : null,
          ratingDistribution: question.type === 'RATING' ? distribution : [],
          textAnswers: question.type === 'TEXT' ? textBy.get(question.id) ?? [] : [],
        };
      }),
    };
  }

  /**
   * Writes one audit entry, degrading silently when no AuditService is wired — the
   * same contract as SupportService#emitAudit and RoleService#emitAudit.
   *
   * READS ARE NEVER AUDITED. Only create, edit, publish, close and delete reach this
   * method. Participation is not audited either: an audit row naming the respondent
   * of an anonymous survey would defeat the projection rule the rest of this service
   * maintains.
   */
  private async emitAudit(opts: {
    action: string;
    actorId: string;
    resourceId: string;
    changedFields?: string[];
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
  }): Promise<void> {
    if (!this.audit) return;

    const ctx = RequestContextService.get();

    await this.audit.log({
      requestId: ctx?.requestId ?? `survey-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: opts.actorId,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      action: opts.action,
      resource: 'survey',
      resourceId: opts.resourceId,
      changedFields: opts.changedFields,
      oldValue: opts.oldValue,
      newValue: opts.newValue,
      success: true,
      reason: opts.reason ?? null,
      durationMs: ctx ? Date.now() - ctx.startTime : undefined,
    });
  }
}










