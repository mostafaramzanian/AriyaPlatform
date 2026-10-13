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
import { Request as ExRequest } from 'express';
// Same require pattern as MediaController/MessagingController: `multer` types are
// not in the Express namespace on this Node version, and memoryStorage is the
// existing platform behaviour (buffer → service → MinIO).
// Kept lazy exactly as before: multer ships CommonJS with no installed type
// declarations, so a static import would change both resolution and typing.
// createRequire is the sanctioned CJS bridge for that case. The `any` here is
// the require'd CJS module itself (multer ships no installed type
// declarations) — same one-line scope as CheckRequestController's bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multer: any = createRequire(__filename)('multer');
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipalRequest } from '../../auth/auth.types';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { CorrespondenceService, scheduledAtToInstant } from './correspondence.service';
import {
  CorrespondenceAttachmentService,
  UploadedAttachmentFile as CorrespondenceUploadedFile,
} from './correspondence-attachment.service';
import { MAX_ATTACHMENT_BYTES } from './correspondence-attachment.service';
import { CorrespondenceSignatureService } from './correspondence-signature.service';
import {
  ArchiveFolderQueryDto,
  ArchiveLetterDto,
  ChangeClassificationDto,
  ChangeLetterStatusDto,
  CorrSearchQueryDto,
  CorrespondenceQueryDto,
  CreateArchiveFolderDto,
  CreateLetterDraftDto,
  CreateReferralDto,
  MarkLetterDto,
  ReferralStatusDto,
  SendLetterDto,
  UpdateArchiveFolderDto,
  UpdateLetterDraftDto,
} from './dto/letter.dto';

/**
 * Phase 50: Official Correspondence HTTP surface.
 *
 * Every route is authenticated and the actor is ALWAYS `req.user.sub`. There is no
 * sender, tenant or status parameter anywhere in the contract, so no route can be
 * made to act on behalf of someone else or to skip a lifecycle gate.
 *
 * Authorization is split asymmetrically, on purpose:
 *
 *  - PERSONAL WORKFLOW routes (drafts, send, inbox, marks, referrals you may see,
 *    personal archive) carry NO `@Roles(...)` gate. These are ordinary
 *    authenticated-user capabilities; the authorization edges (ownership,
 *    recipient row, referral target, tenant scope) are enforced inside
 *    CorrespondenceService on every call. Gating them on a manager permission
 *    would make correspondence admin-only — the opposite of the feature.
 *  - ADMIN routes carry `@Roles(...)` gates that are seeded in core_db:
 *      PATCH /:id/classification → correspondence.manage
 *    A 403 from RolesGuard and a 403 from the service re-check mean the same thing.
 *
 * Route ORDER matters in Nest: literal paths (`search`, `inbox`, `archive/folders`,
 * `archive`) are declared before parameterised `:id` routes so they can never be
 * shadowed, matching SupportController (49G) and SurveysController (49H).
 */
@Controller('correspondence')
@UseGuards(JwtAuthGuard)
export class CorrespondenceController {
  constructor(
    private readonly correspondence: CorrespondenceService,
    private readonly attachments: CorrespondenceAttachmentService,
    private readonly signatures: CorrespondenceSignatureService,
  ) {}

  private subject(req: ExRequest): string {
    // JwtAuthGuard has always resolved the principal before any route runs;
    // single assertion, the same shape `RolesGuard` uses (auth/rbac/guards).
    return (req as AuthenticatedPrincipalRequest).user.sub;
  }

  // -- Search (declared before :id routes) ----------------------------------

  @Get('search')
  async search(@Request() req: ExRequest, @Query() query: CorrSearchQueryDto) {
    return this.correspondence.searchLetters(this.subject(req), query);
  }

  // -- Drafts / outgoing ----------------------------------------------------

  @Get('drafts')
  async listDrafts(@Request() req: ExRequest, @Query() query: CorrespondenceQueryDto) {
    return this.correspondence.listDrafts(this.subject(req), query);
  }

  @Post('drafts')
  @HttpCode(201)
  async createDraft(@Request() req: ExRequest, @Body() dto: CreateLetterDraftDto) {
    return this.correspondence.createDraft(this.subject(req), dto);
  }

  @Patch('drafts/:id')
  async updateDraft(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateLetterDraftDto,
  ) {
    return this.correspondence.updateDraft(this.subject(req), id, dto);
  }

  @Post('drafts/:id/send')
  @HttpCode(200)
  async send(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SendLetterDto,
  ) {
    return this.correspondence.sendDraft(
      this.subject(req),
      id,
      dto.sendKey ?? null,
      scheduledAtToInstant(dto.scheduledAtDate, dto.scheduledAtTime),
    );
  }

  @Patch('drafts/:id/status')
  async changeStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeLetterStatusDto,
  ) {
    return this.correspondence.changeStatus(this.subject(req), id, dto.status);
  }

  @Delete('drafts/:id')
  async deleteDraft(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.deleteDraft(this.subject(req), id);
  }

  @Get('sent')
  async listSent(@Request() req: ExRequest, @Query() query: CorrespondenceQueryDto) {
    return this.correspondence.listSent(this.subject(req), query);
  }

  /** "حذف از لیست" for MY outgoing view — soft, per-sender, never the letter. */
  @Patch('sent/:id/remove')
  async removeSent(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.removeSentFromList(this.subject(req), id);
  }

  // -- Inbox / cartable -----------------------------------------------------

  @Get('inbox')
  async listInbox(@Request() req: ExRequest, @Query() query: CorrespondenceQueryDto) {
    return this.correspondence.listInbox(this.subject(req), query);
  }

  @Get('inbox/unread-count')
  async inboxUnread(@Request() req: ExRequest) {
    return this.correspondence.countInboxUnread(this.subject(req));
  }

  @Get('inbox/referrals')
  async listReferralInbox(@Request() req: ExRequest, @Query() query: CorrespondenceQueryDto) {
    return this.correspondence.listReferralInbox(this.subject(req), query);
  }

  /** Remove from MY inbox (soft, per-subject). */
  @Patch('inbox/:letterId/remove')
  async removeInbox(
    @Request() req: ExRequest,
    @Param('letterId', new ParseUUIDPipe({ version: '4' })) letterId: string,
  ) {
    return this.correspondence.removeInboxItem(this.subject(req), letterId, true);
  }

  /** Explicit VIEWED / READ mark — real tracking timestamps, real edges. */
  @Patch(':id/mark')
  async mark(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: MarkLetterDto,
  ) {
    return this.correspondence.markLetter(this.subject(req), id, dto.mark);
  }

  // -- Referrals ------------------------------------------------------------

  @Post(':id/referrals')
  @HttpCode(201)
  async createReferral(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateReferralDto,
  ) {
    return this.correspondence.createReferral(this.subject(req), id, dto);
  }

  @Get(':id/referrals')
  async listReferrals(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.listReferrals(this.subject(req), id);
  }

  @Patch('referrals/:id/status')
  async referralStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReferralStatusDto,
  ) {
    return this.correspondence.updateReferralStatus(this.subject(req), id, dto.status);
  }

  // -- Archive (personal) ---------------------------------------------------

  @Get('archive/folders')
  async listFolders(@Request() req: ExRequest) {
    return this.correspondence.listArchiveFolders(this.subject(req));
  }

  @Post('archive/folders')
  @HttpCode(201)
  async createFolder(@Request() req: ExRequest, @Body() dto: CreateArchiveFolderDto) {
    return this.correspondence.createArchiveFolder(this.subject(req), dto);
  }

  @Patch('archive/folders/:id')
  async renameFolder(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateArchiveFolderDto,
  ) {
    return this.correspondence.renameArchiveFolder(this.subject(req), id, dto.name ?? '');
  }

  @Delete('archive/folders/:id')
  async deleteFolder(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.deleteArchiveFolder(this.subject(req), id);
  }

  @Get('archive')
  async listArchive(
    @Request() req: ExRequest,
    @Query('folderId') folderId: string | undefined,
    @Query() query: ArchiveFolderQueryDto,
  ) {
    return this.correspondence.listArchive(
      this.subject(req),
      folderId && folderId.length > 0 ? folderId : null,
      query,
    );
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ArchiveLetterDto,
  ) {
    return this.correspondence.archiveLetter(this.subject(req), id, dto.folderId ?? null);
  }

  @Delete(':id/archive')
  async unarchive(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.unarchiveLetter(this.subject(req), id);
  }

  // -- Tracking / detail ----------------------------------------------------

  @Get(':id/tracking')
  async tracking(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.getTracking(this.subject(req), id);
  }

  /** Full content projection (body + action surface). Same edge check as detail. */
  @Get(':id/content')
  async content(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.getLetterContent(this.subject(req), id);
  }

  @Get(':id')
  async detail(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.correspondence.getLetter(this.subject(req), id);
  }

  // -- Manager routes (seeded permissions) ----------------------------------

  /** Manager-only: classification change on a SENT letter, audited. */
  @Patch(':id/classification')
  @Roles(Permissions.CORRESPONDENCE_MANAGE)
  async classification(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeClassificationDto,
  ) {
    return this.correspondence.changeClassification(this.subject(req), id, dto.classification);
  }

  // -- Attachments ----------------------------------------------------------

  /**
   * Metadata listing for one letter's attachments. The SAME visibility predicate
   * as the letter itself decides who may call this — never weaker than the read
   * edge. A letter the caller cannot see (or one that does not exist) is a 404,
   * identical to the detail and download paths. Metadata only; storageKey never
   * leaves the server.
   */
  @Get(':id/attachments')
  async listAttachments(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.attachments.listForLetter(this.subject(req), id);
  }

  /** Sender-only upload to an editable draft; Multer enforces the same 10 MB cap. */
  @Post('attachments')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  async uploadAttachment(
    @Request() req: ExRequest,
    @Body() dto: { letterId: string },
    @UploadedFile() file: CorrespondenceUploadedFile,
  ) {
    return this.attachments.upload(this.subject(req), dto.letterId, file);
  }

  /** Uploads a temporary attachment BEFORE a draft exists. */
  @Post('attachments/temp')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  async uploadTempAttachment(
    @Request() req: ExRequest,
    @UploadedFile() file: CorrespondenceUploadedFile,
  ) {
    return this.attachments.uploadTemp(this.subject(req), file);
  }

  /** Uploads a signature image (drawn or uploaded PNG/JPEG). */
  @Post('signatures')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  async uploadSignature(
    @Request() req: ExRequest,
    @UploadedFile() file: CorrespondenceUploadedFile,
  ) {
    return this.signatures.upload(this.subject(req), file);
  }

  /** Resolves a short-lived download URL for the caller's own signature. */
  @Get('signatures/:id/download')
  async downloadSignature(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.signatures.resolveDownloadFor(this.subject(req), id);
  }

  /** Removes an unused signature owned by the caller. */
  @Delete('signatures/:id')
  async deleteSignature(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.signatures.remove(this.subject(req), id);
  }

  /**
   * Download through the SAME access predicate as the letter itself: the service
   * resolves the caller's letter edge first, then the signed URL. storageKey never
   * leaves the server.
   */
  @Get('attachments/:id/download')
  async downloadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.attachments.resolveDownloadFor(this.subject(req), id);
  }

  @Delete('attachments/:id')
  async deleteAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.attachments.remove(this.subject(req), id);
  }
}