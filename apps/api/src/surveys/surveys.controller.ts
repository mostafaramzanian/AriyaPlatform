import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { SurveysService } from './surveys.service';
import { SurveyQueryDto } from './dto/survey-query.dto';
import {
  ChangeSurveyStatusDto,
  CreateSurveyDto,
  SubmitSurveyResponseDto,
  UpdateSurveyDto,
} from './dto/survey.dto';

/**
 * Phase 49H: Surveys / Participation HTTP surface.
 *
 * Every route is authenticated and the actor is always `req.user.sub`. There is no
 * respondent, author or tenant parameter anywhere in the contract, so no route can
 * be made to act on behalf of someone else.
 *
 * Authorization is split THREE ways, asymmetrically and on purpose:
 *
 *  - PARTICIPATION routes (`GET /`, `GET /:id`, `POST /:id/responses`) carry no
 *    `@Roles(...)` gate. Answering a survey published to your tenant is an ordinary
 *    authenticated-user capability, exactly as reading your own notifications (49E)
 *    or conversations (49F) is. The authorization edge is tenant + survey status +
 *    "one response each", all enforced in the service. Gating participation on a
 *    permission granted only to admins would make surveys answerable solely by
 *    admins, which is the opposite of the feature.
 *  - AUTHORING routes (`POST /`, `PATCH /:id`, `PATCH /:id/status`, `DELETE /:id`)
 *    carry `@Roles(admin.surveys.manage)`.
 *  - The RESULTS route carries `@Roles(admin.surveys.results)` — a DIFFERENT
 *    permission, so the ability to author a survey does not imply the ability to
 *    read its answers.
 *
 * In every gated case the service re-checks the same permission, because RolesGuard
 * can express "holds the permission" but not "and the survey is in your tenant".
 *
 * Route ORDER matters in Nest: no literal path here could be shadowed by `:id`, but
 * the collection routes are still declared before the parameterised ones to keep the
 * same reading order as SupportController (49G) and MessagingController (49F).
 *
 * Both new permissions ARE seeded in `core_db`
 * (`20260830130000_seed_survey_permission_grants`) and granted to SUPER_ADMIN and
 * ADMIN only — so, unlike 49G's `support.tickets`, gating on them is real and not
 * authorization theatre.
 */
@Controller('surveys')
@UseGuards(JwtAuthGuard)
export class SurveysController {
  constructor(private readonly surveys: SurveysService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * Participation-facing list. Ungated: the service decides what this caller may
   * see, and a non-manager's page is restricted to published, in-window surveys in
   * their own tenant regardless of the `scope`/`status` they ask for.
   */
  @Get()
  async list(@Request() req: ExRequest, @Query() query: SurveyQueryDto) {
    return this.surveys.listSurveys(this.subject(req), query);
  }

  /** Manager-only: authors a DRAFT with its whole questionnaire. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.ADMIN_SURVEYS_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateSurveyDto) {
    return this.surveys.createSurvey(this.subject(req), dto);
  }

  /**
   * Participation-facing detail, including the ordered questionnaire and the
   * per-caller `canRespond` / `hasResponded` flags. A draft 404s for a non-manager
   * and a survey in another tenant 404s for everyone, so ids cannot be probed.
   */
  @Get(':id')
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.surveys.getSurvey(this.subject(req), id);
  }

  /** Manager-only, DRAFT-only. `questions` replaces the whole questionnaire. */
  @Patch(':id')
  @Roles(Permissions.ADMIN_SURVEYS_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateSurveyDto,
  ) {
    return this.surveys.updateSurvey(this.subject(req), id, dto);
  }

  /**
   * Manager-only lifecycle transition. A separate route from PATCH because a
   * transition stamps `publishedAt`/`closedAt`, is irreversible, and is audited
   * under its own action name — folding it into the general patch would hide all
   * three.
   */
  @Patch(':id/status')
  @Roles(Permissions.ADMIN_SURVEYS_MANAGE)
  async changeStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeSurveyStatusDto,
  ) {
    return this.surveys.changeStatus(this.subject(req), id, dto);
  }

  /** Manager-only, DRAFT-only. A published survey is CLOSED, never deleted. */
  @Delete(':id')
  @Roles(Permissions.ADMIN_SURVEYS_MANAGE)
  async remove(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.surveys.deleteSurvey(this.subject(req), id);
  }

  /**
   * Submits the caller's one and only response. Ungated by design (see the class
   * comment). Returns 201 with a deliberately minimal body: the response id and
   * timestamp, never the stored answers, so nothing here can be replayed as a
   * per-respondent read endpoint.
   */
  @Post(':id/responses')
  @HttpCode(201)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SubmitSurveyResponseDto,
  ) {
    return this.surveys.submitResponse(this.subject(req), id, dto);
  }

  /**
   * Aggregated results. Gated on `admin.surveys.results`, NOT on
   * `admin.surveys.manage`. The payload carries counts, a rating average and free
   * text only — no user id, email, employee code or response id — and there is no
   * sibling route that returns individual responses.
   */
  @Get(':id/results')
  @Roles(Permissions.ADMIN_SURVEYS_RESULTS)
  async results(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.surveys.getResults(this.subject(req), id);
  }
}
