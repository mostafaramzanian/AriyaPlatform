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
import { RequiresModule } from '../../platform/entitlement/entitlement.contract';
import { HR_MODULE_ID } from '../hr/hr.constants';
import { resolveReportingActor } from './reporting-actor';
import { HrPersonnelTrafficReportService } from './hr-personnel-traffic-report.service';
import {
  HrPersonnelTrafficReportTimelineQueryDto,
  ListHrPersonnelTrafficReportQueryDto,
} from './hr-personnel-traffic-report.dto';
import { reportExportDisposition } from './presentation/report-export.model';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the Reporting READ surface for
 * «گزارش تردد پرسنل» — three GETs, no writes.
 *
 * AUTHORIZATION (explicit, §12). The minimum read authority for this report is the
 * EXISTING HR read remit — `hr.attendance.read` — because the report reads EXACTLY the
 * rows and trail that remit already covers (the register, one register row, its audit
 * history). No `reporting.*` permission is invented: a new string would be a second
 * answer to «may this actor see these rows» with no seeder, no grant and no role behind
 * it — authorization theatre. A tenant that may not read the attendance register may
 * not read its report either; least privilege is preserved, not widened. This is the
 * same decision the Financial, Commerce and Production report controllers made, for the
 * identical reason rather than by symmetry.
 *
 * ENTITLEMENT. The surface declares the SAME module requirement HR's own attendance
 * reads declare — `@RequiresModule(HR_MODULE_ID)` and nothing more. HR declares NO
 * feature for attendance (`HR_FEATURE` carries only `leave` and `mission`), so there is
 * deliberately NO `@RequiresFeature` decorator here: the report is a view over the
 * register, and an unentitled tenancy is refused identically on both surfaces by the
 * module gate alone. Copying the siblings' feature decorator without a feature behind it
 * would make every report route 403 for a tenancy HR itself serves.
 *
 * No `RbacModule` import: `@Roles` is metadata the global `RolesGuard` resolves — the
 * Financial/HR/Commerce/Production precedent.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED: `resolveReportingActor(req)` takes the tenant
 * from `RequestContextService` only and 403s when there is none. No query, body or param
 * field can restate a tenant, so there is no shape of these three routes that reads
 * another tenant's register row.
 */
@Controller('reporting/hr/personnel-traffic')
@RequiresModule(HR_MODULE_ID)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class HrPersonnelTrafficReportController {
  constructor(private readonly report: HrPersonnelTrafficReportService) {}

  /** One filtered page of the report register, with its summary strip. */
  @Get()
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListHrPersonnelTrafficReportQueryDto) {
    return this.report.list(resolveReportingActor(req), query);
  }

  /**
   * The SAME filtered page as a spreadsheet — read-only, synchronous, server-generated.
   *
   * Same guards, same `@Roles` remit (`hr.attendance.read`) and the very same DTO class
   * the screen's list route validates — day window, source and code search alike — so an
   * actor who may not see the register may not download it, and the file's filter state
   * cannot differ from the table's by construction. Bytes + exact OpenXML MIME + an
   * ASCII `attachment` name.
   */
  @Get('export/xlsx')
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async exportXlsx(
    @Request() req: ExRequest,
    @Query() query: ListHrPersonnelTrafficReportQueryDto
  ) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'xlsx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** The SAME filtered page as a Word document — identical scope, identical remit. */
  @Get('export/docx')
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async exportDocx(
    @Request() req: ExRequest,
    @Query() query: ListHrPersonnelTrafficReportQueryDto
  ) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'docx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** One report row, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.report.getOne(resolveReportingActor(req), id);
  }

  /** This register row's report timeline — read-only, 503 on audit outage. */
  @Get(':id/timeline')
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: HrPersonnelTrafficReportTimelineQueryDto
  ) {
    return this.report.getTimeline(resolveReportingActor(req), id, query);
  }
}
