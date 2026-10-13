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

/**
 * Phase 49F: message attachments.
 *
 * Reuses the existing MinIO IStorageProvider and MediaService's
 * store-then-cleanup-on-failure ordering: the object is written first, and if the
 * database row cannot be created the object is deleted, so storage never
 * accumulates files that no row references.
 *
 * An attachment is uploaded BEFORE the message exists and bound when the send
 * commits. Until then it is inert — no read reaches it, because every read starts
 * from a message.
 */

/** Hard ceiling. Enforced here, in the Multer limits, and as a database CHECK. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist, not a denylist: anything not named here is refused. SVG is
 * deliberately excluded — it is an executable document that can carry script, and
 * it would be served from our own origin.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
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

export interface UploadedAttachmentFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

export interface AttachmentRefDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface AttachmentDownloadDto {
  url: string;
  fileName: string;
  mimeType: string;
}

@Injectable()
export class MessagingAttachmentService {
  private readonly logger = new Logger(MessagingAttachmentService.name);

  constructor(
    private prisma: PrismaService,
    @Inject('IStorageProvider') private storage: IStorageProvider,
  ) {}

  private scope(userId: string): { userId: string; tenantId: string | null } {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Messaging context is required');
    }

    return { userId, tenantId: context.tenantId ?? null };
  }

  /**
   * Uploads one file for a conversation the caller belongs to.
   *
   * Membership is checked before anything is stored, so a non-member cannot use
   * this endpoint as free object storage.
   */
  async upload(
    userId: string,
    conversationId: string,
    file: UploadedAttachmentFile | undefined,
  ): Promise<AttachmentRefDto> {
    const scope = this.scope(userId);

    const membership = await this.prisma.conversationMember.findFirst({
      where: { conversationId, userId: scope.userId, conversation: { tenantId: scope.tenantId } },
      select: { id: true },
    });

    if (!membership) {
      throw new NotFoundException('Conversation not found');
    }

    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No file provided');
    }

    // Trust the buffer length, not the reported size: a client-supplied `size`
    // could understate the payload.
    const size = file.buffer.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('Attachment exceeds the 10 MB limit');
    }

    const mimeType = (file.mimetype ?? '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported attachment type: ${mimeType || 'unknown'}`);
    }

    const id = randomUUID();
    const fileName = this.safeFileName(file.originalname, id);
    // The key is built entirely from server-side values (ids + a sanitised name),
    // so a crafted filename cannot traverse or collide.
    const storageKey = `messaging/${conversationId}/${id}/${fileName}`;

    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (err) {
      this.logger.error({ err }, 'Attachment storage upload failed');
      throw new InternalServerErrorException('Failed uploading attachment');
    }

    try {
      return await this.prisma.messageAttachment.create({
        data: {
          id,
          conversationId,
          uploadedBy: scope.userId,
          fileName,
          mimeType,
          size,
          storageKey,
        },
        select: { id: true, fileName: true, mimeType: true, size: true },
      });
    } catch (err) {
      // Same cleanup ordering as MediaService: never leave an orphan object.
      this.logger.error({ err }, 'Attachment row insert failed — cleaning up storage');
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
   * The predicate requires membership of the attachment's conversation AND the
   * caller's tenant, so an attachment id belonging to another thread or tenant is
   * a 404 — identical to a nonexistent one, which is why ids cannot be probed.
   * `storageKey` never leaves the server.
   */
  async resolveDownload(userId: string, attachmentId: string): Promise<AttachmentDownloadDto> {
    const scope = this.scope(userId);

    const attachment = await this.prisma.messageAttachment.findFirst({
      where: {
        id: attachmentId,
        conversation: {
          tenantId: scope.tenantId,
          members: { some: { userId: scope.userId } },
        },
      },
      select: { storageKey: true, fileName: true, mimeType: true },
    });

    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    const url = await this.storage.getUrl(attachment.storageKey, {
      // Phase 49G-5: server-held values from the upload row, so the signed URL's
      // response headers can never be steered by the requester.
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });

    return { url, fileName: attachment.fileName, mimeType: attachment.mimeType };
  }

  /**
   * Reduces a client filename to a safe, bounded basename: directory components
   * are dropped outright and the character set is closed, so nothing that could be
   * read as a path or a shell token survives.
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
