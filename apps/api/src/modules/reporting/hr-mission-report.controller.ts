import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { RequiresFeature, RequiresModule } from '../../platform/entitlement/entitlement.contract';
import { HR_FEATURE, HR_MODULE_ID } from '../hr/hr.constants';
import { resolveReportingActor } from './reporting-actor';
import { HrMissionReportService } from './hr-mission-report.service';
import {
  HrMissionReportTimelineQueryDto,
  ListHrMissionReportQueryDto,
} from './hr-mission-report.dto';
import { reportExportDisposition } from './presentation/report-export.model';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the Reporting READ surface for
 * «گزارش وضعیت درخواست‌های مأموریت» — five GETs, no writes.
 *
 * AUTHORIZATION. The minimum read authority is the EXISTING HR mission read remit —
 * `hr.mission.read` — because the report reads EXACTLY the rows and trail that remit
 * already covers. No `reporting.*` permission is invented. ENTITLEMENT. The surface
 * declares the SAME module/feature requirement HR's own mission reads declare
 * (`hr` / `mission`): the report is a view over that capability, so an unentitled
 * tenancy is refused identically on both surfaces.
 */
@Controller('reporting/hr/mission-requests')
@RequiresModule(HR_MODULE_ID)
@RequiresFeature(HR_MODULE_ID, HR_FEATURE.MISSION)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class HrMissionReportController {
  constructor(private readonly report: HrMissionReportService) {}

  /** One filtered page of the report register, with its summary strip. */
  @Get()
  @Roles(Permissions.HR_MISSION_READ)
  async list(@Request() req: ExRequest, @Query() query: ListHrMissionReportQueryDto) {
    return this.report.list(resolveReportingActor(req), query);
  }

  /** The SAME filtered page as a spreadsheet — same guards, same DTO, same remit. */
  @Get('export/xlsx')
  @Roles(Permissions.HR_MISSION_READ)
  async exportXlsx(@Request() req: ExRequest, @Query() query: ListHrMissionReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'xlsx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** The SAME filtered page as a Word document — identical scope, identical remit. */
  @Get('export/docx')
  @Roles(Permissions.HR_MISSION_READ)
  async exportDocx(@Request() req: ExRequest, @Query() query: ListHrMissionReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'docx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** One report row, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.HR_MISSION_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.report.getOne(resolveReportingActor(req), id);
  }

  /** This register row's report timeline — read-only, 503 on audit outage. */
  @Get(':id/timeline')
  @Roles(Permissions.HR_MISSION_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: HrMissionReportTimelineQueryDto
  ) {
    return this.report.getTimeline(resolveReportingActor(req), id, query);
  }
}
