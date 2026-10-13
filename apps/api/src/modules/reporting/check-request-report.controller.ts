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
import { FINANCIAL_FEATURE, FINANCIAL_MODULE_ID } from '../financial/financial.constants';
import { resolveReportingActor } from './reporting-actor';
import { CheckRequestReportService } from './check-request-report.service';
import {
  CheckRequestReportTimelineQueryDto,
  ListCheckRequestReportQueryDto,
} from './check-request-report.dto';
import { reportExportDisposition } from './presentation/report-export.model';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Reporting READ surface for
 * «گزارش وضعیت و گردش درخواست‌های صدور چک» — three GETs, no writes.
 *
 * AUTHORIZATION (explicit, §12). The minimum read authority for this report
 * is the EXISTING Financial read remit — `financial.check.read` — because the
 * report reads EXACTLY the rows, fields and trail that remit already covers
 * (register, one request, its timeline). No `reporting.*` permission is
 * invented: a new string would be a second answer to «may this actor see
 * these rows» with no seeder, no grant and no role behind it — authorization
 * theatre. A tenant that may not read Financial check requests may not read
 * their report either; least privilege is preserved, not widened.
 *
 * ENTITLEMENT. The surface declares the SAME module/feature requirement
 * Financial's own reads declare (`financial` / `check-request`): the report
 * is a view over that capability, not a capability of its own, so an
 * unentitled tenancy is refused identically on both surfaces.
 *
 * No `RbacModule` import: `@Roles` is metadata the global `RolesGuard`
 * resolves — the Financial/HR/Commerce precedent.
 */
@Controller('reporting/financial/check-requests')
@RequiresModule(FINANCIAL_MODULE_ID)
@RequiresFeature(FINANCIAL_MODULE_ID, FINANCIAL_FEATURE.CHECK_REQUEST)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class CheckRequestReportController {
  constructor(private readonly report: CheckRequestReportService) {}

  /** One filtered page of the report register, with its summary strip. */
  @Get()
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async list(@Request() req: ExRequest, @Query() query: ListCheckRequestReportQueryDto) {
    return this.report.list(resolveReportingActor(req), query);
  }

  /**
   * The SAME filtered page as a spreadsheet — read-only, synchronous, server-generated.
   *
   * THE EXPORT IS A VIEW OF THIS REPORT, NOT A SECOND SURFACE: same guards (the class's
   * entitlement + JWT chain), same `@Roles` remit (`financial.check.read`), same DTO — so
   * a caller who may not SEE these rows through `GET …` may not download them either, and
   * the file's filters are validated by the very class the screen uses. The response is
   * bytes with the exact OpenXML MIME and an ASCII `attachment` name; nothing about the
   * report's projection changes on the way out.
   */
  @Get('export/xlsx')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async exportXlsx(@Request() req: ExRequest, @Query() query: ListCheckRequestReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'xlsx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** The SAME filtered page as a Word document — identical scope, identical remit. */
  @Get('export/docx')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async exportDocx(@Request() req: ExRequest, @Query() query: ListCheckRequestReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'docx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** One report row, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.report.getOne(resolveReportingActor(req), id);
  }

  /** This request's report timeline — read-only, 503 on audit outage. */
  @Get(':id/timeline')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: CheckRequestReportTimelineQueryDto
  ) {
    return this.report.getTimeline(resolveReportingActor(req), id, query);
  }
}
