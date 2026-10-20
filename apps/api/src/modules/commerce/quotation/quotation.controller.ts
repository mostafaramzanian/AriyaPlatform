import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createRequire } from 'node:module';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { resolveCommerceActor } from '../commerce-actor';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { QuotationService } from './quotation.service';
import { COMMERCE_MAX_ATTACHMENT_BYTES } from './quotation.constants';
import {
  CreatePriceQuotationDto,
  ListQuotationsQueryDto,
  QuotationDecisionDto,
} from './quotation.dto';

/**
 * GAP-6 follow-up (3.3): the ONE multipart configuration the attachment upload
 * shares — memory storage, the same 10 MiB ceiling the service re-checks, one
 * file part (two bounds, one contract — financial F1's rule). DECLARED AFTER THE
 * IMPORTS because it EVALUATES `COMMERCE_MAX_ATTACHMENT_BYTES` at module load —
 * placing it among the imports would run it before `quotation.constants` had
 * initialized (the TDZ bug the financial controller records). The multer require
 * bridge is the messaging/media precedent: multer ships CommonJS with no
 * installed type declarations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multer: any = createRequire(__filename)('multer');
const QUOTATION_ATTACHMENT_UPLOAD_OPTIONS = {
  storage: multer.memoryStorage(),
  limits: { fileSize: COMMERCE_MAX_ATTACHMENT_BYTES, files: 1 },
};

/**
 * PHASE GAP-6 (GAP-6 closure): the THREE price-quotation routes — list a
 * document's quotation trail, record one version, decide the pending one.
 *
 * THE NAMESPACE. `commerce/price-quotations` under the application's global
 * `api/v1` prefix — the purchase slice's `commerce/purchase-documents` and the
 * commercial slice's `commerce/commercial-*` collections establish the shape,
 * and the path names the ROW the calls address.
 *
 * PERMISSIONS — THE SEED THAT FINALLY HAS ROUTES. `commerce.commercial.manage`
 * is the permission Core's own catalogue description assigned to "quotation
 * entry, confirmation, correction" since the commerce permission seed; C5
 * recorded that it was referenced by ZERO routes, and this controller is the
 * surface its description always named. The read answers `commerce.read` like
 * every other collection read in the module.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO: resolve the actor from the
 * request and delegate — no rule, no status decision, no validation, no audit
 * call. Every ordering decision is a decorator: the entitlement chain declares,
 * `ModuleEntitlementGuard` decides, `@Roles` declares the remit, and
 * `JwtAuthGuard` is innermost. `@HttpCode(200)` on the decision — it changes
 * state and creates nothing, the module's answer for every transition route.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class QuotationController {
  constructor(private readonly quotations: QuotationService) {}

  /** One document's whole quotation trail, oldest version first. A read. */
  @Get('price-quotations')
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListQuotationsQueryDto) {
    return this.quotations.list(resolveCommerceActor(req), query.documentId);
  }

  /**
   * Record ONE quotation version (`201`: a row is produced). `version` is
   * minted server-side; a racing duplicate version is the named 409, never a
   * silent second row.
   */
  @Post('price-quotations')
  @Roles(Permissions.COMMERCE_COMMERCIAL_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreatePriceQuotationDto) {
    return this.quotations.create(resolveCommerceActor(req), dto);
  }

  /** CONFIRM or RETURN the pending quotation — one conditional write, one 409 on a race. */
  @Post('price-quotations/:id/decision')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_COMMERCIAL_MANAGE)
  async decide(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: QuotationDecisionDto
  ) {
    return this.quotations.decide(resolveCommerceActor(req), id, dto);
  }

  /**
   * GAP-6 follow-up (3.3): attach the SCANNED document to a PENDING quotation
   * version — multipart `file`, 10 MiB + MIME allowlist, object-first with
   * cleanup on a failed row. `200` (not 201): no new row is produced; the
   * quotation's own evidence state changed.
   */
  @Post('price-quotations/:id/attachment')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_COMMERCIAL_MANAGE)
  @UseInterceptors(FileInterceptor('file', QUOTATION_ATTACHMENT_UPLOAD_OPTIONS))
  async uploadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file:
      | { originalname?: string; mimetype?: string; size?: number; buffer?: Buffer }
      | undefined
  ) {
    return this.quotations.uploadAttachment(resolveCommerceActor(req), id, file);
  }

  /**
   * GAP-6 follow-up (3.3): resolve the attached scan to a SHORT-LIVED SIGNED URL
   * (`commerce.read` — evidence is reviewable in every state; the storage key
   * itself never leaves the server).
   */
  @Get('price-quotations/:id/attachment')
  @Roles(Permissions.COMMERCE_READ)
  async downloadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.quotations.attachmentDownload(resolveCommerceActor(req), id);
  }
}
