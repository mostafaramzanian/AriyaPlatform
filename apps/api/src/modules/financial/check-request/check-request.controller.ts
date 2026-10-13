import { createRequire } from 'node:module';
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Same require pattern as CorrespondenceController/MediaController/MessagingController:
// `multer` ships no type declarations in this repo's dependency set, so a default ES
// import would be an implicit `any` (TS7016). The lazy load keeps that decision local
// and identical across the upload surfaces. The two disables below are the same
// ones that pattern needs everywhere — expressed here rather than in the shared config
// so one file's shim cannot change the rules for the whole repository.
// Kept lazy exactly as before: multer ships CommonJS with no installed type
// declarations, so a static import would change both resolution and typing.
// createRequire is the sanctioned CJS bridge for that case.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multer: any = createRequire(__filename)('multer');
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import {
  FINANCIAL_FEATURE,
  FINANCIAL_MAX_ATTACHMENT_BYTES,
  FINANCIAL_MODULE_ID,
} from '../financial.constants';
import { CHECK_ISSUANCE_SECTION } from '../process/check-issuance.definition';
import { resolveFinancialActor } from '../financial-actor';
import { CheckRequestService } from './check-request.service';
import { CheckAttachmentService } from './check-attachment.service';
import type { UploadedCheckAttachmentFile } from './check-attachment.service';
import {
  AllocateCheckRequestDto,
  CheckRequestTimelineQueryDto,
  ConfirmCheckDeliveryDto,
  ConfirmCheckIssueDto,
  CreateCheckRequestDto,
  DecideCheckRequestDto,
  DecideDocumentReviewDto,
  DecideExecutiveApprovalDto,
  ListCheckRequestsQueryDto,
  UpdateCheckAttachmentDto,
  UpdateCheckRequestDto,
} from './check-request.dto';

/**
 * The ONE multipart configuration every attachment upload route shares — same memory
 * storage, same 10 MiB ceiling, one file part. Declared once so a ceiling raised on one
 * section cannot stay lower on another (the service re-checks the size against the same
 * constant, two bounds, one contract — F1's rule). DECLARED AFTER THE IMPORTS, because
 * it EVALUATES `FINANCIAL_MAX_ATTACHMENT_BYTES` at module load — placing it among the
 * imports would run it before `financial.constants` had initialized.
 */
const CHECK_ATTACHMENT_UPLOAD_OPTIONS = {
  storage: multer.memoryStorage(),
  limits: { fileSize: FINANCIAL_MAX_ATTACHMENT_BYTES, files: 1 },
};

/**
 * Phase F1 — FINANCIAL FOUNDATION: the check-request routes.
 *
 * THE NAMESPACE. `financial/check-requests` under the application's global `api/v1`
 * prefix — exactly what the brief's §18 states and what `/api/v1/financial/**` means in
 * this repository (Production's `production/boms` and HR's `hr/missions` establish the
 * shape), so no module-specific prefix convention is invented here.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. That is all: no rule, no
 * status decision, no query, no audit call. Every ordering decision in this file is a
 * decorator, and every one of them is a boundary statement:
 *
 *   `@RequiresModule(FINANCIAL_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the
 *   requirement — they never decide it. The decision is the platform's
 *   `ModuleEntitlementGuard`, provided at the composition root, which is why the module
 *   id comes from `financial.constants.ts` rather than from a literal here: the value must
 *   agree with the Core provisioning migration's SQL, and neither file can import the
 *   other.
 *
 *   `@Roles(Permissions.FINANCIAL_CHECK_*)` DECLARES who may act. `financial.check.read`
 *   for every read (including the timeline and the attachment reads — a trail and a
 *   document list are the same remit as the record they hang off),
 *   `financial.check.manage` for create / edit / submit / attachments, and
 *   `financial.check.approve` for the three decision acts — because DECIDING is a
 *   different remit from AUTHORING, exactly as `commerce.approve` is separate from
 *   `commerce.manage`.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveFinancialActor(req)` is the only source
 * of `tenantId` and `userId`; no route accepts either. A request that never resolved to a
 * tenant is refused (403) instead of being served unscoped.
 *
 * `:id` IS PARSED AS A UUID v4 — a malformed id is a 400 here rather than a database
 * round-trip. The id alone is never an isolation key: the service resolves it tenant-scoped
 * and answers 404 for a foreign row, so a cross-tenant probe cannot distinguish
 * "exists elsewhere" from "does not exist" (the brief's §26).
 *
 * WHAT IS NOT ON THE WIRE (the brief's §17): `tenantId`, `requesterUserId`, `status`,
 * `nextState`, `managerDecision`, audit actor, `requestDate`, `title`, `createdAt`,
 * `updatedAt` — none is a route input. The global pipe's `whitelist` +
 * `forbidNonWhitelisted` turns any stated one into a typed refusal naming the field (the
 * `bom-change.dto.ts` pattern this brief asks for).
 */
@Controller('financial/check-requests')
@RequiresModule(FINANCIAL_MODULE_ID)
@RequiresFeature(FINANCIAL_MODULE_ID, FINANCIAL_FEATURE.CHECK_REQUEST)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class CheckRequestController {
  constructor(
    private readonly requests: CheckRequestService,
    private readonly attachments: CheckAttachmentService
  ) {}

  /** One page of the tenant's check requests, newest first. */
  @Get()
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async list(@Request() req: ExRequest, @Query() query: ListCheckRequestsQueryDto) {
    return this.requests.list(resolveFinancialActor(req), query);
  }

  /** One check request, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.requests.getOne(resolveFinancialActor(req), id);
  }

  /**
   * This request's audit history — read-only, scoped server-side to
   * `resource = financial.check-request` + this row, in the platform's authoritative
   * order (`createdAt ASC, id ASC`). An audit outage is a 503 — never a quiet empty
   * timeline.
   */
  @Get(':id/timeline')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: CheckRequestTimelineQueryDto
  ) {
    return this.requests.getTimeline(resolveFinancialActor(req), id, query);
  }

  /** Author a check request. It is created as a DRAFT (state 0); the requester is FORCED from the actor. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateCheckRequestDto) {
    return this.requests.create(resolveFinancialActor(req), dto);
  }

  /** Change a request while the requester owns it (states 0 and 1). 409 once the manager does. */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCheckRequestDto
  ) {
    return this.requests.update(resolveFinancialActor(req), id, dto);
  }

  /**
   * Submit / re-submit for manager review: {0, 1} → 2, once, in one unit of work.
   *
   * `200`, not `201`: nothing is created by this route — the row's state moves, and the
   * answer is the row. NO BODY: there is nothing for the caller to state.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.requests.submit(resolveFinancialActor(req), id);
  }

  /** The manager's «بله» — records the decision and lands state 3 (downstream deferred). */
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_APPROVE)
  async approve(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideCheckRequestDto
  ) {
    return this.requests.decide(resolveFinancialActor(req), id, 'APPROVE', dto);
  }

  /** The manager's «خیر» — records the decision and lands state 50 (terminal). */
  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_APPROVE)
  async reject(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideCheckRequestDto
  ) {
    return this.requests.decide(resolveFinancialActor(req), id, 'REJECT', dto);
  }

  /**
   * The manager's «نیازمند اصلاح است» — records the decision and RETURNS the row to
   * state 1, where the requester re-owns it (the source's correction flow, §7.4).
   */
  @Post(':id/request-correction')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_APPROVE)
  async requestCorrection(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideCheckRequestDto
  ) {
    return this.requests.decide(resolveFinancialActor(req), id, 'REQUEST_CORRECTION', dto);
  }

  // ==========================================================================
  // Phase CHECK-ISSUATION — the downstream stage routes (states 3 → 8).
  //
  // ONE ROUTE PER DECISION ACT, each with EXACTLY ONE permission (the F1 controller
  // spec's rule, kept): a route cannot widen to "any of several capabilities" without
  // the test saying so. All of them delegate to the SAME service pipeline, whose single
  // transition definition is the domain table — several routes, ONE meaning per
  // transition (brief §16).
  // ==========================================================================

  /** Stage 3 — «صدور فرم تخصیص»: records the allocation and lands state 4. */
  @Post(':id/allocate')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_ALLOCATE)
  async allocate(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AllocateCheckRequestDto
  ) {
    return this.requests.allocate(resolveFinancialActor(req), id, dto);
  }

  /** Stage 4 — «بررسی اسناد»: `تایید` → 5, `اصلاح` → 1. The decision is on the wire. */
  @Post(':id/document-review')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_REVIEW)
  async reviewDocuments(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideDocumentReviewDto
  ) {
    return this.requests.reviewDocuments(resolveFinancialActor(req), id, dto);
  }

  /**
   * Stage 5 — «تایید ریاست»: `تایید` → 6, `رد` → 50. The source's third value has no
   * route — DEFERRED / SOURCE-CONFLICT (brief §20), so there is nothing to call.
   */
  @Post(':id/executive-approval')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_APPROVE)
  async executiveApproval(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideExecutiveApprovalDto
  ) {
    return this.requests.executiveDecision(resolveFinancialActor(req), id, dto);
  }

  /** Stage 6 — «صدور چک»: cheque image + confirmation, lands state 7. */
  @Post(':id/issue')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_ISSUE)
  async issue(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ConfirmCheckIssueDto
  ) {
    return this.requests.issue(resolveFinancialActor(req), id, dto);
  }

  /** Stage 7 — «دریافت رسید تحویل»: receipt + completion, lands terminal state 8. */
  @Post(':id/delivery')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_DELIVER)
  async completeDelivery(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ConfirmCheckDeliveryDto
  ) {
    return this.requests.deliver(resolveFinancialActor(req), id, dto);
  }

  /**
   * The wizard's action source (brief §15): what the PINNED process offers from THIS
   * row's state, with capability + actor-policy results. A READ — it must work for a
   * viewer who may not act at all, so the route stays on `read`.
   */
  @Get(':id/available-actions')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async availableActions(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.requests.availableActions(resolveFinancialActor(req), id);
  }

  /** The documents on this request, oldest first. A read — no state guard. */
  @Get(':id/attachments')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async listAttachments(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.attachments.list(resolveFinancialActor(req), id);
  }

  /**
   * Uploads ONE request-stage document while the request is requester-owned (0/1).
   *
   * MULTIPART, exactly as the correspondence controller: `file` is a memory-stored part
   * capped by Multer at the same 10 MiB ceiling the service re-checks (two bounds, one
   * contract — Multer refuses the stream, the service refuses the metadata), and the
   * remaining fields arrive as a plain body whose metatype is `Object`, so the global
   * `ValidationPipe` skips it — the same reason correspondence's upload route declares a
   * raw type. Every field is read by the SERVICE, which validates `documentType` against
   * the closed eleven-value set and the MIME type against the allowlist; nothing in that
   * body carries server-owned authority, so a stray extra field has no effect rather than
   * a privilege.
   */
  @Post(':id/attachments')
  @HttpCode(201)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  @UseInterceptors(FileInterceptor('file', CHECK_ATTACHMENT_UPLOAD_OPTIONS))
  async uploadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() fields: { documentType?: string; description?: string },
    @UploadedFile() file: UploadedCheckAttachmentFile | undefined
  ) {
    return this.attachments.upload(
      resolveFinancialActor(req),
      id,
      CHECK_ISSUANCE_SECTION.REQUEST_DOCUMENTS,
      fields,
      file
    );
  }

  /** Edits ONE document's metadata (نوع سند / توضیحات) while the request is requester-owned. */
  @Patch(':id/attachments/:attachmentId')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  async updateAttachmentMetadata(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string,
    @Body() dto: UpdateCheckAttachmentDto
  ) {
    return this.attachments.updateMetadata(
      resolveFinancialActor(req),
      id,
      attachmentId,
      CHECK_ISSUANCE_SECTION.REQUEST_DOCUMENTS,
      dto
    );
  }

  /** Removes ONE document's row and its object while the request is requester-owned. */
  @Delete(':id/attachments/:attachmentId')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_MANAGE)
  async deleteAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string
  ) {
    return this.attachments.remove(
      resolveFinancialActor(req),
      id,
      attachmentId,
      CHECK_ISSUANCE_SECTION.REQUEST_DOCUMENTS
    );
  }

  /**
   * Resolves a short-lived download URL for ONE document. A read: no state guard, and
   * the `storageKey` itself never appears in the response.
   */
  @Get(':id/attachments/:attachmentId/url')
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getAttachmentUrl(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string
  ) {
    return this.attachments.resolveDownloadUrl(resolveFinancialActor(req), id, attachmentId);
  }

  // ==========================================================================
  // Phase CHECK-ISSUATION — the stage-section document routes (sections 6 and 7).
  //
  // ONE ROUTE PER SECTION, each with the section's OWN capability: the cheque image is
  // the issuer's evidence (`financial.check.issue`, state 6 only) and the receipt is the
  // deliverer's (`financial.check.deliver`, state 7 only). The STATE window and the type
  // policy come from the pinned process configuration inside the service, so a route can
  // never write a section its permission does not own or a state the section is not
  // managed in (brief §27). No metadata PATCH for these sections: the source's grids
  // carried nothing to edit.
  // ==========================================================================

  /** Stage 6 upload — the source's «تصویر چک صادر شده» grid, section 6. */
  @Post(':id/cheque-image')
  @HttpCode(201)
  @Roles(Permissions.FINANCIAL_CHECK_ISSUE)
  @UseInterceptors(FileInterceptor('file', CHECK_ATTACHMENT_UPLOAD_OPTIONS))
  async uploadChequeImage(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() fields: { description?: string },
    @UploadedFile() file: UploadedCheckAttachmentFile | undefined
  ) {
    return this.attachments.upload(
      resolveFinancialActor(req),
      id,
      CHECK_ISSUANCE_SECTION.CHEQUE_IMAGE,
      fields,
      file
    );
  }

  /** Removes ONE cheque image while the request sits in state 6 (the grid's delete). */
  @Delete(':id/cheque-image/:attachmentId')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_ISSUE)
  async deleteChequeImage(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string
  ) {
    return this.attachments.remove(
      resolveFinancialActor(req),
      id,
      attachmentId,
      CHECK_ISSUANCE_SECTION.CHEQUE_IMAGE
    );
  }

  /** Stage 7 upload — the source's «تصویر رسید تحویل» grid, section 7. */
  @Post(':id/delivery-receipt')
  @HttpCode(201)
  @Roles(Permissions.FINANCIAL_CHECK_DELIVER)
  @UseInterceptors(FileInterceptor('file', CHECK_ATTACHMENT_UPLOAD_OPTIONS))
  async uploadDeliveryReceipt(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() fields: { description?: string },
    @UploadedFile() file: UploadedCheckAttachmentFile | undefined
  ) {
    return this.attachments.upload(
      resolveFinancialActor(req),
      id,
      CHECK_ISSUANCE_SECTION.DELIVERY_RECEIPT,
      fields,
      file
    );
  }

  /** Removes ONE delivery receipt while the request sits in state 7. */
  @Delete(':id/delivery-receipt/:attachmentId')
  @HttpCode(200)
  @Roles(Permissions.FINANCIAL_CHECK_DELIVER)
  async deleteDeliveryReceipt(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string
  ) {
    return this.attachments.remove(
      resolveFinancialActor(req),
      id,
      attachmentId,
      CHECK_ISSUANCE_SECTION.DELIVERY_RECEIPT
    );
  }
}
