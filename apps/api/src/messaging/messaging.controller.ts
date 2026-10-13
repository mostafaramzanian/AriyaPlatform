import { createRequire } from 'node:module';
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
// Same require-style import as MediaController: the package ships CommonJS and is
// not in the TS path mapping, so an ESM import would not type-resolve.
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
import { MessagingService } from './messaging.service';
import {
  MAX_ATTACHMENT_BYTES,
  MessagingAttachmentService,
  UploadedAttachmentFile,
} from './messaging-attachment.service';
import { ConversationQueryDto, MessageQueryDto } from './dto/conversation-query.dto';
import { CreateConversationDto, SendMessageDto } from './dto/conversation.dto';

/**
 * Phase 49F: Internal Messaging HTTP surface.
 *
 * Every route is authenticated and implicitly scoped to the caller: the actor is
 * always `req.user.sub`, and there is no recipient, sender or tenant parameter
 * anywhere in the contract.
 *
 * There is deliberately no `@Roles(...)` gate — a conversation is personal, not an
 * administered resource, so an admin has no more access to someone else's thread
 * than anyone else. The only authorization boundary is membership, enforced in the
 * service (same reasoning as NotificationController in 49E).
 *
 * These routes are a complete alternative to the WebSocket: the socket is a
 * delivery optimisation, so a client with no working socket remains fully
 * functional over HTTP alone.
 *
 * Route ORDER matters in Nest: the literal `unread-count` and `attachments` paths
 * are declared before any parameterised path so they can never be shadowed by
 * `:id` — the same trap documented on UsersController in 49D-1.
 */
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly attachments: MessagingAttachmentService,
  ) {}

  private subject(req: ExRequest): string {
    // JwtAuthGuard has always resolved the principal before any route runs;
    // single assertion, the same shape `RolesGuard` uses (auth/rbac/guards).
    return (req as AuthenticatedPrincipalRequest).user.sub;
  }

  @Get()
  async list(@Request() req: ExRequest, @Query() query: ConversationQueryDto) {
    return this.messaging.listConversations(this.subject(req), query);
  }

  /** Literal path — must precede `:id`. */
  @Get('unread-count')
  async unreadCount(@Request() req: ExRequest) {
    return this.messaging.unreadCount(this.subject(req));
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

  /**
   * Creates a GROUP, or returns the caller's existing DIRECT conversation.
   *
   * 200, not 201: DIRECT create is idempotent and frequently returns something
   * that already existed, so a blanket 201 would misreport what happened.
   */
  @Post()
  @HttpCode(200)
  async create(@Request() req: ExRequest, @Body() dto: CreateConversationDto) {
    return this.messaging.createConversation(this.subject(req), dto);
  }

  @Get(':id')
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.messaging.getConversation(this.subject(req), id);
  }

  @Get(':id/messages')
  async listMessages(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: MessageQueryDto,
  ) {
    return this.messaging.listMessages(this.subject(req), id, query);
  }

  /**
   * HTTP send. Goes through exactly the same service method as `message.send` over
   * the socket, so the two paths cannot diverge in validation, authorization,
   * idempotency or fan-out.
   */
  @Post(':id/messages')
  @HttpCode(201)
  async sendMessage(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messaging.sendMessage(this.subject(req), id, dto);
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.messaging.markRead(this.subject(req), id);
  }

  @Get(':id/presence')
  async presence(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.messaging.presenceFor(this.subject(req), id);
  }

  /**
   * Uploads one attachment for later binding to a message.
   *
   * The Multer `limits` reject an oversized body before it is buffered, so the
   * 10 MB cap is enforced at the transport edge as well as in the service and the
   * database — a large upload cannot be used to exhaust memory first.
   */
  @Post(':id/attachments')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  async uploadAttachment(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: UploadedAttachmentFile,
  ) {
    return this.attachments.upload(this.subject(req), id, file);
  }
}
