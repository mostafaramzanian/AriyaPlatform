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
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce/commerce.constants';
import { resolveReportingActor } from './reporting-actor';
import { ReturnLifecycleReportService } from './return-lifecycle-report.service';
import {
  ListReturnLifecycleReportQueryDto,
  ReturnLifecycleReportTimelineQueryDto,
} from './return-lifecycle-report.dto';
import { reportExportDisposition } from './presentation/report-export.model';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Reporting READ surface for
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی» — FIVE GETs, no writes.
 *
 * AUTHORIZATION. The minimum read authority is the EXISTING Commerce read remit —
 * `commerce.read` — because the report reads EXACTLY the rows and fields that remit
 * already covers (the return child's own `GET :id/returns` route answers to it). No
 * `reporting.*` permission is invented. ENTITLEMENT. The surface declares the SAME
 * module/feature requirement Commerce's own return reads declare (`commerce` /
 * `purchase`): the report is a view over that capability, so an unentitled tenancy
 * is refused identically on both surfaces.
 *
 * FIVE, NOT FOUR: there IS an `:id/timeline` route, unlike the payment register.
 * The return audit trail is bound to the RETURN (`resourceId = return document id`),
 * so a timeline keyed to a report row answers exactly this row's five lifecycle acts —
 * the contract's documented grain ruling, honored as a route rather than an absence.
 */
@Controller('reporting/commerce/return-lifecycle')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class ReturnLifecycleReportController {
  constructor(private readonly report: ReturnLifecycleReportService) {}

  /** One filtered page of the report register, with its summary strip. */
  @Get()
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListReturnLifecycleReportQueryDto) {
    return this.report.list(resolveReportingActor(req), query);
  }

  /** The SAME filtered page as a spreadsheet — same guards, same DTO, same remit. */
  @Get('export/xlsx')
  @Roles(Permissions.COMMERCE_READ)
  async exportXlsx(@Request() req: ExRequest, @Query() query: ListReturnLifecycleReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'xlsx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** The SAME filtered page as a Word document — identical scope, identical remit. */
  @Get('export/docx')
  @Roles(Permissions.COMMERCE_READ)
  async exportDocx(@Request() req: ExRequest, @Query() query: ListReturnLifecycleReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'docx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** One report row, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.COMMERCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.report.getOne(resolveReportingActor(req), id);
  }

  /** This return's lifecycle timeline — the return-bound audit trail, paged. */
  @Get(':id/timeline')
  @Roles(Permissions.COMMERCE_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ReturnLifecycleReportTimelineQueryDto
  ) {
    return this.report.getTimeline(resolveReportingActor(req), id, query);
  }
}
