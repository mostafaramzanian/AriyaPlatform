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
import { PurchaseReportService } from './purchase-report.service';
import { ListPurchaseReportQueryDto, PurchaseReportTimelineQueryDto } from './purchase-report.dto';
import { reportExportDisposition } from './presentation/report-export.model';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Reporting READ surface for
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید» — three GETs, no writes.
 *
 * AUTHORIZATION (explicit, §12). The minimum read authority for this report is the
 * EXISTING Commerce read remit — `commerce.read` — because the report reads EXACTLY the
 * rows, fields and trail that remit already covers (the register, one document, its
 * timeline). No `reporting.*` permission is invented: a new string would be a second
 * answer to «may this actor see these rows» with no seeder, no grant and no role behind
 * it — authorization theatre. A tenant that may not read purchase documents may not read
 * their report either; least privilege is preserved, not widened.
 *
 * This is the same decision `check-request-report.controller.ts` made for Financial, and
 * it is made here for the identical reason rather than by symmetry: each report answers
 * to the remit of the source it reads.
 *
 * ENTITLEMENT. The surface declares the SAME module/feature requirement Commerce's own
 * reads declare (`commerce` / `purchase`): the report is a view over that capability, not
 * a capability of its own, so an unentitled tenancy is refused identically on both
 * surfaces.
 *
 * No `RbacModule` import: `@Roles` is metadata the global `RolesGuard` resolves — the
 * Financial/HR/Commerce precedent, and the isolation suite fails the build on any import
 * of it from this context.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED: `resolveReportingActor(req)` takes the tenant
 * from `RequestContextService` only and 403s when there is none. No query, body or param
 * field can restate a tenant, so there is no shape of these three routes that reads
 * another tenant's document.
 */
@Controller('reporting/commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PurchaseReportController {
  constructor(private readonly report: PurchaseReportService) {}

  /** One filtered page of the report register, with its summary strip. */
  @Get()
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListPurchaseReportQueryDto) {
    return this.report.list(resolveReportingActor(req), query);
  }

  /**
   * The SAME filtered page as a spreadsheet — read-only, synchronous, server-generated.
   *
   * Same guards, same `@Roles` remit (`commerce.read`) and the very same DTO class the
   * screen's list route validates: an actor who may not see these documents may not
   * download them, and the file's filter state cannot differ from the table's by
   * construction. Bytes + exact OpenXML MIME + an ASCII `attachment` name.
   */
  @Get('export/xlsx')
  @Roles(Permissions.COMMERCE_READ)
  async exportXlsx(@Request() req: ExRequest, @Query() query: ListPurchaseReportQueryDto) {
    const file = await this.report.exportReport(resolveReportingActor(req), query, 'xlsx');
    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: reportExportDisposition(file.fileName),
    });
  }

  /** The SAME filtered page as a Word document — identical scope, identical remit. */
  @Get('export/docx')
  @Roles(Permissions.COMMERCE_READ)
  async exportDocx(@Request() req: ExRequest, @Query() query: ListPurchaseReportQueryDto) {
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

  /** This document's report timeline — read-only, 503 on audit outage. */
  @Get(':id/timeline')
  @Roles(Permissions.COMMERCE_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: PurchaseReportTimelineQueryDto
  ) {
    return this.report.getTimeline(resolveReportingActor(req), id, query);
  }
}
