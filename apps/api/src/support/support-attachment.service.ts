import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { IStorageProvider } from '../storage/i-storage.provider';
import { SupportService } from './support.service';

/**
 * Phase 49G: ticket attachments.
 *
 * Reuses the existing MinIO IStorageProvider and the same store-then-cleanup
 * ordering MediaService and MessagingAttachmentService already use: the object is
 * written first, and if the database row cannot be created the object is deleted, so
 * storage never accumulates files no row references.
 *
 * An attachment is uploaded BEFORE the comment that carries it exists and is bound
 * when the comment commits. Until then it is inert — no read reaches it, because
 * every attachment read filters on a bound `commentId`.
 *
 * Authorization is delegated to SupportService.assertTicketVisible, so the
 * upload/download paths cannot drift from the visibility rule the read routes use.
 */

/** Hard ceiling. Enforced here, in the Multer limits, and as a database CHECK. */
export const MAX_TICKET_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist, not a denylist: anything not named here is refused. SVG is
 * deliberately excluded — it is an executable document that can carry script and it
 * would be served from our own origin. Identical set to messaging (49F).
 */
export const ALLOWED_TICKET_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface UploadedTicketFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

export interface TicketAttachmentRefDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface TicketAttachmentDownloadDto {
  url: string;
  fileName: string;
  mimeType: string;
}

@Injectable()
export class SupportAttachmentService {
  private readonly logger = new Logger(SupportAttachmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly support: SupportService,
    @Inject('IStorageProvider') private readonly storage: IStorageProvider,
  ) {}

  private assertContext(userId: string): void {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Support context is required');
    }
  }

  /**
   * Uploads one file for a ticket the caller may see.
   *
   * Visibility is checked before anything is stored, so a caller who cannot see the
   * ticket cannot use this endpoint as free object storage.
   */
  async upload(
    userId: string,
    ticketId: string,
    file: UploadedTicketFile | undefined,
  ): Promise<TicketAttachmentRefDto> {
    this.assertContext(userId);
    await this.support.assertTicketVisible(userId, ticketId);

    if (!file?.buffer) {
      throw new BadRequestException('Attachment file is required');
    }

    const size = file.size ?? file.buffer.length;
    if (size <= 0) {
      throw new BadRequestException('Attachment file is empty');
    }
    if (size > MAX_TICKET_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('Attachment exceeds the 10 MB limit');
    }

    const mimeType = (file.mimetype ?? '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_TICKET_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported attachment type: ${mimeType || 'unknown'}`);
    }

    const id = randomUUID();
    const fileName = this.safeFileName(file.originalname, id);
    // The key is built entirely from server-side values (ids + a sanitised name),
    // so a crafted filename cannot traverse or collide.
    const storageKey = `support/${ticketId}/${id}/${fileName}`;

    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (err) {
      this.logger.error({ err }, 'Ticket attachment storage upload failed');
      throw new InternalServerErrorException('Failed uploading attachment');
    }

    try {
      return await this.prisma.ticketAttachment.create({
        data: {
          id,
          ticketId,
          uploadedBy: userId,
          fileName,
          mimeType,
          size,
          storageKey,
        },
        select: { id: true, fileName: true, mimeType: true, size: true },
      });
    } catch (err) {
      // Same cleanup ordering as MediaService: never leave an orphan object.
      this.logger.error({ err }, 'Ticket attachment row insert failed — cleaning up storage');
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupErr) {
        this.logger.warn({ err: cleanupErr }, 'Failed cleaning up attachment after DB failure');
      }
      throw new InternalServerErrorException('Failed creating attachment record');
    }
  }

  /**
   * Resolves a download URL for an attachment the caller can actually see.
   *
   * The attachment's ticket is re-checked through the shared visibility rule, and an
   * attachment hanging off an INTERNAL comment is refused to a non-agent — otherwise
   * an internal note's files would leak even though the note itself is filtered out
   * of the thread. Every failure is 404, identical to a nonexistent id, so ids cannot
   * be probed. `storageKey` never leaves the server.
   */
  async resolveDownload(
    userId: string,
    attachmentId: string,
  ): Promise<TicketAttachmentDownloadDto> {
    this.assertContext(userId);

    const attachment = await this.prisma.ticketAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        storageKey: true,
        fileName: true,
        mimeType: true,
        ticketId: true,
        comment: { select: { isInternal: true } },
      },
    });

    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    let isAgent: boolean;
    try {
      ({ isAgent } = await this.support.assertTicketVisible(userId, attachment.ticketId));
    } catch {
      // Collapsed to 404 so an unauthorized caller cannot tell "exists but not
      // yours" from "does not exist".
      throw new NotFoundException('Attachment not found');
    }

    if (attachment.comment?.isInternal && !isAgent) {
      throw new NotFoundException('Attachment not found');
    }

    const url = await this.storage.getUrl(attachment.storageKey, {
      // Both come from the row written at upload time, never from this request — a
      // caller cannot influence the headers the signed URL will produce.
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });

    return { url, fileName: attachment.fileName, mimeType: attachment.mimeType };
  }

  /**
   * Reduces a client filename to a safe, bounded basename: directory components are
   * dropped outright and the character set is closed, so nothing that could be read
   * as a path or a shell token survives.
   */
  private safeFileName(original: string | undefined, fallbackId: string): string {
    const base = (original ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+/, '')
      .slice(-120);

    return cleaned.length > 0 ? cleaned : `attachment-${fallbackId.slice(0, 8)}`;
  }
}


