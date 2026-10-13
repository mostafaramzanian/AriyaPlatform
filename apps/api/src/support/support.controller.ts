import { createRequire } from 'node:module';
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Same require-style import as MediaController/MessagingController: the package
// ships CommonJS and is not in the TS path mapping, so an ESM import would not
// type-resolve.
// Kept lazy exactly as before: multer ships CommonJS with no installed type
// declarations, so a static import would change both resolution and typing.
// createRequire is the sanctioned CJS bridge for that case. The `any` here is
// the require'd CJS module itself (multer ships no installed type
// declarations) — same one-line scope as CheckRequestController's bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multer: any = createRequire(__filename)('multer');
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipalRequest } from '../auth/auth.types';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { SupportService } from './support.service';
import {
  MAX_TICKET_ATTACHMENT_BYTES,
  SupportAttachmentService,
  UploadedTicketFile,
} from './support-attachment.service';
import { TicketCommentQueryDto, TicketQueryDto } from './dto/ticket-query.dto';
import {
  ChangeTicketStatusDto,
  CreateTicketCommentDto,
  CreateTicketDto,
  CreateTicketSatisfactionDto,
  UpdateTicketDto,
} from './dto/ticket.dto';

/**
 * Phase 49G: Support / Ticketing HTTP surface.
 *
 * Every route is authenticated and the actor is always `req.user.sub`. There is no
 * requester, assignee or tenant parameter anywhere in the contract.
 *
 * Authorization is deliberately split in two, and NOT symmetrically:
 *
 *  - REQUESTER-FACING routes carry no `@Roles(...)` gate. A ticket you filed is
 *    personal, exactly like a notification (49E) or a conversation (49F): the
 *    authorization edge is ownership, enforced in the service on every read and
 *    write. `support.tickets` exists in the permission catalogue but is NOT seeded
 *    in `core_db` (only `admin.support.manage` is), so gating on it would 403 every
 *    requester — and gating on a permission nobody holds would be authorization
 *    theatre rather than authorization.
 *  - ADMINISTRATIVE routes (patch, status change) carry
 *    `@Roles(admin.support.manage)`, which IS seeded and granted to SUPER_ADMIN,
 *    ADMIN and OPERATIONS_ADMIN. The service re-checks the same permission, because
 *    RolesGuard alone cannot express "and the ticket must be in your tenant".
 *
 * Phase 49G therefore introduces NO new permission.
 *
 * Route ORDER matters in Nest: the literal `attachments` and `tracking` paths are
 * declared before any parameterised path so they can never be shadowed by `:id` —
 * the trap documented on UsersController (49D-1) and MessagingController (49F).
 */
@Controller('tickets')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  private subject(req: ExRequest): string {
    // JwtAuthGuard has always resolved the principal before any route runs;
    // single assertion, the same shape `RolesGuard` uses (auth/rbac/guards).
    return (req as AuthenticatedPrincipalRequest).user.sub;
  }

  @Get()
  async list(@Request() req: ExRequest, @Query() query: TicketQueryDto) {
    return this.support.listTickets(this.subject(req), query);
  }

  /**
   * Literal path — must precede `:id`. Lookup by the quotable tracking number, still
   * subject to the same tenant + ownership visibility rule, so knowing a number is
   * never sufficient on its own.
   */
  @Get('tracking/:trackingNumber')
  async getByTrackingNumber(
    @Request() req: ExRequest,
    @Param('trackingNumber') trackingNumber: string,
  ) {
    return this.support.getTicketByTrackingNumber(this.subject(req), trackingNumber);
  }

  /**
   * Literal path — must precede `:id`. Returns a URL rather than streaming bytes,
   * matching how storage-backed media is already served; authorization happens
   * before the URL is minted, so an unauthorized caller never learns it.
   */
  @Get('attachments/:attachmentId')
  async downloadAttachment(
    @Request() req: ExRequest,
    @Param('attachmentId', new ParseUUIDPipe({ version: '4' })) attachmentId: string,
  ) {
    return this.attachments.resolveDownload(this.subject(req), attachmentId);
  }

  @Post()
  @HttpCode(201)
  async create(@Request() req: ExRequest, @Body() dto: CreateTicketDto) {
    return this.support.createTicket(this.subject(req), dto);
  }

  @Get(':id')
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.support.getTicket(this.subject(req), id);
  }

  /** Agent-only: assignment, priority, category. */
  @Patch(':id')
  @Roles(Permissions.ADMIN_SUPPORT_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.support.updateTicket(this.subject(req), id, dto);
  }

  /**
   * Agent-only lifecycle transition. A separate route from PATCH because a
   * transition has its own validation, writes a history row and notifies — folding
   * it into the general patch would hide all three.
   */
  @Patch(':id/status')
  @Roles(Permissions.ADMIN_SUPPORT_MANAGE)
  async changeStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeTicketStatusDto,
  ) {
    return this.support.changeStatus(this.subject(req), id, dto);
  }

  @Get(':id/comments')
  async listComments(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: TicketCommentQueryDto,
  ) {
    return this.support.listComments(this.subject(req), id, query);
  }

  @Post(':id/comments')
  @HttpCode(201)
  async addComment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateTicketCommentDto,
  ) {
    return this.support.addComment(this.subject(req), id, dto);
  }

  /**
   * Uploads one attachment for later binding to a comment.
   *
   * The Multer `limits` reject an oversized body before it is buffered, so the 10 MB
   * cap is enforced at the transport edge as well as in the service and the
   * database — a large upload cannot be used to exhaust memory first.
   */
  @Post(':id/attachments')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_TICKET_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  async uploadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: UploadedTicketFile,
  ) {
    return this.attachments.upload(this.subject(req), id, file);
  }

  /** Requester-only, once per ticket, resolved/closed tickets only. */
  @Post(':id/satisfaction')
  @HttpCode(201)
  async submitSatisfaction(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateTicketSatisfactionDto,
  ) {
    return this.support.submitSatisfaction(this.subject(req), id, dto);
  }
}

