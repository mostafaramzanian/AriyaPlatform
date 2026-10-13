import {
  Body,
  Controller,
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
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { HR_FEATURE, HR_MODULE_ID } from '../hr.constants';
import { resolveHrActor } from '../hr-actor';
import { MissionService } from './mission.service';
import { MissionApprovalService } from './mission-approval.service';
import { MissionPolicyService } from './mission-policy.service';
import {
  ApproveMissionRequestDto,
  CorrectMissionRequestDto,
  RejectMissionRequestDto,
} from '../dto/mission-approval.dto';
import {
  CancelMissionRequestDto,
  CreateMissionApprovalDefinitionDto,
  CreateMissionOptionDto,
  CreateMissionOptionGroupDto,
  CreateMissionPolicyVersionDto,
  CreateMissionReportDto,
  CreateMissionRequestDto,
  ListMissionRequestsQueryDto,
  UpdateMissionApprovalDefinitionDto,
  UpdateMissionOptionDto,
  UpdateMissionOptionGroupDto,
  UpdateMissionRequestDto,
} from '../dto/mission.dto';

@Controller('hr/missions')
@RequiresModule(HR_MODULE_ID)
@RequiresFeature(HR_MODULE_ID, HR_FEATURE.MISSION)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class MissionController {
  constructor(
    private readonly mission: MissionService,
    private readonly approvals: MissionApprovalService,
    private readonly policy: MissionPolicyService
  ) {}

  // -- Reads ----------------------------------------------------------------

  @Get()
  @Roles(Permissions.HR_MISSION_READ)
  async list(@Request() req: ExRequest, @Query() query: ListMissionRequestsQueryDto) {
    return this.mission.list(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_MISSION_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.mission.getById(resolveHrActor(req), id);
  }

  // -- Writes ---------------------------------------------------------------

  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateMissionRequestDto) {
    return this.mission.create(resolveHrActor(req), dto);
  }

  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMissionRequestDto
  ) {
    return this.mission.update(resolveHrActor(req), id, dto);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.mission.submit(resolveHrActor(req), id);
  }

  @Post(':id/resubmit')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async resubmit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMissionRequestDto
  ) {
    return this.mission.resubmit(resolveHrActor(req), id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async cancel(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelMissionRequestDto
  ) {
    return this.mission.cancel(resolveHrActor(req), id, dto);
  }

  // -- Reports --------------------------------------------------------------

  @Post(':id/reports')
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_MANAGE)
  async createReport(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() dto: CreateMissionReportDto
  ) {
    return this.mission.submitReport(resolveHrActor(req), requestId, dto);
  }

  // -- Approvals ------------------------------------------------------------

  @Get('approvals/pending')
  @Roles(Permissions.HR_MISSION_APPROVE)
  async listPendingApprovals(@Request() req: ExRequest) {
    return this.approvals.listPendingApprovals(resolveHrActor(req));
  }

  @Get(':id/approval')
  @Roles(Permissions.HR_MISSION_APPROVE)
  async approvalDetail(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.approvals.getApprovalDetail(resolveHrActor(req), id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_APPROVE)
  async approve(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ApproveMissionRequestDto
  ) {
    return this.approvals.approve(resolveHrActor(req), id, dto.reason ?? null);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_APPROVE)
  async reject(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectMissionRequestDto
  ) {
    return this.approvals.reject(resolveHrActor(req), id, dto.reason);
  }

  @Post(':id/correction')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_APPROVE)
  async correction(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CorrectMissionRequestDto
  ) {
    return this.approvals.requestCorrection(resolveHrActor(req), id, dto.reason);
  }

  // -- Option catalogue -----------------------------------------------------

  @Get('option-groups')
  @Roles(Permissions.HR_MISSION_POLICY)
  async listOptionGroups(
    @Request() req: ExRequest,
    @Query() query: { active?: boolean; page?: number; pageSize?: number }
  ) {
    return this.mission.listOptionGroups(resolveHrActor(req), query);
  }

  @Post('option-groups')
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_POLICY)
  async createOptionGroup(@Request() req: ExRequest, @Body() dto: CreateMissionOptionGroupDto) {
    return this.mission.createOptionGroup(resolveHrActor(req), dto);
  }

  @Patch('option-groups/:groupId')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async updateOptionGroup(
    @Request() req: ExRequest,
    @Param('groupId', new ParseUUIDPipe({ version: '4' })) groupId: string,
    @Body() dto: UpdateMissionOptionGroupDto
  ) {
    return this.mission.updateOptionGroup(resolveHrActor(req), groupId, dto);
  }

  @Post('option-groups/:groupId/options')
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_POLICY)
  async createOption(
    @Request() req: ExRequest,
    @Param('groupId', new ParseUUIDPipe({ version: '4' })) groupId: string,
    @Body() dto: CreateMissionOptionDto
  ) {
    return this.mission.createOption(resolveHrActor(req), groupId, dto);
  }

  @Patch('option-groups/:groupId/options/:optionId')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async updateOption(
    @Request() req: ExRequest,
    @Param('optionId', new ParseUUIDPipe({ version: '4' })) optionId: string,
    @Body() dto: UpdateMissionOptionDto
  ) {
    return this.mission.updateOption(resolveHrActor(req), optionId, dto);
  }

  // -- Approval definitions -------------------------------------------------

  @Get('approval-definitions')
  @Roles(Permissions.HR_MISSION_POLICY)
  async listApprovalDefinitions(
    @Request() req: ExRequest,
    @Query() query: { status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT'; page?: number; pageSize?: number }
  ) {
    return this.mission.listApprovalDefinitions(resolveHrActor(req), query);
  }

  @Post('approval-definitions')
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_POLICY)
  async createApprovalDefinition(
    @Request() req: ExRequest,
    @Body() dto: CreateMissionApprovalDefinitionDto
  ) {
    return this.mission.createApprovalDefinition(resolveHrActor(req), dto);
  }

  @Patch('approval-definitions/:definitionId')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async updateApprovalDefinition(
    @Request() req: ExRequest,
    @Param('definitionId', new ParseUUIDPipe({ version: '4' })) definitionId: string,
    @Body() dto: UpdateMissionApprovalDefinitionDto
  ) {
    return this.mission.updateApprovalDefinition(resolveHrActor(req), definitionId, dto);
  }

  @Post('approval-definitions/:definitionId/steps')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async replaceApprovalDefinitionSteps(
    @Request() req: ExRequest,
    @Param('definitionId', new ParseUUIDPipe({ version: '4' })) definitionId: string,
    @Body() dto: CreateMissionApprovalDefinitionDto
  ) {
    return this.mission.replaceApprovalDefinitionSteps(
      resolveHrActor(req),
      definitionId,
      dto.steps
    );
  }

  // -- Policy versions ------------------------------------------------------

  @Get('policy-versions')
  @Roles(Permissions.HR_MISSION_POLICY)
  async listPolicyVersions(
    @Request() req: ExRequest,
    @Query()
    query: {
      status?: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';
      page?: number;
      pageSize?: number;
    }
  ) {
    return this.policy.listVersions(resolveHrActor(req), query, {
      skip: query.page ? (query.page - 1) * (query.pageSize ?? 20) : 0,
      take: query.pageSize ?? 20,
    });
  }

  @Post('policy-versions')
  @HttpCode(201)
  @Roles(Permissions.HR_MISSION_POLICY)
  async createPolicyVersion(@Request() req: ExRequest, @Body() dto: CreateMissionPolicyVersionDto) {
    return this.policy.createVersion(resolveHrActor(req), dto);
  }

  @Post('policy-versions/:versionId/validate')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async validatePolicyVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policy.validateVersion(resolveHrActor(req), versionId);
  }

  @Post('policy-versions/:versionId/publish')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async publishPolicyVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policy.publishVersion(resolveHrActor(req), versionId);
  }

  @Post('policy-versions/:versionId/archive')
  @HttpCode(200)
  @Roles(Permissions.HR_MISSION_POLICY)
  async archivePolicyVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policy.archiveVersion(resolveHrActor(req), versionId);
  }
}
