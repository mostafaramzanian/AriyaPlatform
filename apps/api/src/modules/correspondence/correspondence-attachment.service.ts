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
import { CorrespondencePrismaService } from './database/correspondence-prisma.service';
import { RequestContextService } from '../../common/request-context.service';
import { IStorageProvider } from '../../storage/i-storage.provider';
import { CorrespondenceService } from './correspondence.service';

/**
 * Phase 50: letter attachments — EXACTLY the 49F contract re-bound to letters.
 *
 * Reuses the existing MinIO `IStorageProvider` and the store-then-cleanup-on-failure
 * ordering: the object is written first, and if the database row cannot be created
 * the object is deleted, so storage never accumulates files no row references.
 *
 * An attachment is uploaded to a DRAFT the caller OWNS. There is no upload-then-bind
 * step here (49F's message does not exist yet at upload time; a letter always does),
 * which makes the authorization edge STRONGER: the letter id is resolved and checked
 * before anything is stored, so this endpoint can never be used as free object
 * storage.
 */

/** Hard ceiling. Enforced here, in the Multer limits, and as a database CHECK. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist, not a denylist: anything not named here is refused. SVG is
 * deliberately excluded — it is an executable document that can carry script, and
 * it would be served from our own origin. Identical to the 49F list.
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

export interface TempAttachmentRefDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class CorrespondenceAttachmentService {
  private readonly logger = new Logger(CorrespondenceAttachmentService.name);

  constructor(
    private prisma: CorrespondencePrismaService,
    @Inject('IStorageProvider') private storage: IStorageProvider,
    private readonly correspondence: CorrespondenceService,
  ) {}

  private scope(userId: string): { userId: string; tenantId: string | null } {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Correspondence context is required');
    }

    return { userId, tenantId: context.tenantId ?? null };
  }

  /**
   * Uploads one file as a temporary attachment BEFORE a draft exists.
   * The caller must own the temp row; it is linked to a real letter at create/update.
   */
  async uploadTemp(
    userId: string,
    file: UploadedAttachmentFile | undefined,
  ): Promise<TempAttachmentRefDto> {
    const scope = this.scope(userId);

    if (!file?.buffer?.length) {
      throw new BadRequestException('Attachment file is required');
    }

    const size = file.size ?? file.buffer.length;
    const mimeType = file.mimetype ?? '';

    if (size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('Attachment exceeds the 10 MB limit');
    }

    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported attachment type: ${mimeType || 'unknown'}`);
    }

    const id = randomUUID();
    const fileName = this.safeFileName(file.originalname, id);
    const storageKey = `correspondence/temp/${scope.userId}/${id}/${fileName}`;

    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (err) {
      this.logger.error({ err }, 'Temp attachment storage upload failed');
      throw new InternalServerErrorException('Failed uploading temp attachment');
    }

    try {
      return await this.prisma.letterTempAttachment.create({
        data: {
          id,
          tenantId: scope.tenantId,
          uploadedBy: scope.userId,
          fileName,
          mimeType,
          size,
          storageKey,
        },
        select: { id: true, fileName: true, mimeType: true, size: true },
      });
    } catch (err) {
      this.logger.error({ err }, 'Temp attachment row insert failed — cleaning up storage');
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupErr) {
        this.logger.warn({ err: cleanupErr }, 'Failed cleaning up temp attachment after DB failure');
      }
      throw new InternalServerErrorException('Failed creating temp attachment record');
    }
  }

  /**
   * Uploads one file to a letter the caller OWNS and that is still editable.
   * Attachment upload is a sender workflow; recipients download, never upload.
   */
  async upload(
    userId: string,
    letterId: string,
    file: UploadedAttachmentFile | undefined,
  ): Promise<AttachmentRefDto> {
    const scope = this.scope(userId);

    const letter = await this.prisma.letter.findFirst({
      where: {
        id: letterId,
        senderId: scope.userId,
        tenantId: scope.tenantId,
        status: { in: ['DRAFT', 'READY_TO_SEND'] },
      },
      select: { id: true },
    });

    if (!letter) {
      throw new NotFoundException('Letter draft not found');
    }

    if (!file?.buffer?.length) {
      throw new BadRequestException('Attachment file is required');
    }

    const size = file.size ?? file.buffer.length;
    const mimeType = file.mimetype ?? '';

    if (size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('Attachment exceeds the 10 MB limit');
    }

    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported attachment type: ${mimeType || 'unknown'}`);
    }

    const id = randomUUID();
    const fileName = this.safeFileName(file.originalname, id);
    // The key is built entirely from server-side values (ids + a sanitised name),
    // so a crafted filename cannot traverse or collide.
    const storageKey = `correspondence/${letterId}/${id}/${fileName}`;

    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (err) {
      this.logger.error({ err }, 'Attachment storage upload failed');
      throw new InternalServerErrorException('Failed uploading attachment');
    }

    try {
      return await this.prisma.letterAttachment.create({
        data: {
          id,
          letterId,
          uploadedBy: scope.userId,
          fileName,
          mimeType,
          size,
          storageKey,
        },
        select: { id: true, fileName: true, mimeType: true, size: true },
      });
    } catch (err) {
      // Same cleanup ordering as MediaService and MessagingAttachmentService:
      // never leave an orphan object.
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
   * Lists a letter's attachment METADATA for a caller who can actually SEE the
   * letter. Uses the SAME letter visibility predicate as the download path
   * (`visiblePredicateFor`), so listing can never expose an attachment of a letter
   * the caller cannot open — and an unseeable letter is indistinguishable from a
   * nonexistent one (404), so ids cannot be probed. Only metadata is projected;
   * `storageKey` never leaves the server.
   */
  async listForLetter(userId: string, letterId: string): Promise<AttachmentRefDto[]> {
    this.scope(userId);
    const { tenantId, where } = await this.correspondence.visiblePredicateFor(userId);

    // Same 404 contract as the letter detail and download paths: a letter the
    // caller cannot see (or one that does not exist) is indistinguishable — both
    // resolve to NotFoundException, so this endpoint cannot be used to probe
    // letter existence either.
    const letter = await this.prisma.letter.findFirst({
      where: { AND: [{ id: letterId, tenantId }, where] },
      select: { id: true },
    });

    if (!letter) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const rows = await this.prisma.letterAttachment.findMany({
      where: { letterId },
      select: { id: true, fileName: true, mimeType: true, size: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
    }));
  }

  /** Removes an attachment from a draft the caller owns. The object is deleted too. */
  async remove(userId: string, attachmentId: string): Promise<{ deleted: true; id: string }> {
    const scope = this.scope(userId);

    const attachment = await this.prisma.letterAttachment.findFirst({
      where: {
        id: attachmentId,
        uploadedBy: scope.userId,
        letter: {
          senderId: scope.userId,
          tenantId: scope.tenantId,
          status: { in: ['DRAFT', 'READY_TO_SEND'] },
        },
      },
      select: { id: true, storageKey: true },
    });

    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    await this.prisma.letterAttachment.delete({ where: { id: attachment.id } });

    try {
      await this.storage.delete(attachment.storageKey);
    } catch (err) {
      // The row is gone; a stale object without a row is inert (no read can reach
      // it) and gets cleaned by retention. Surface nothing to the caller.
      this.logger.warn({ err }, 'Failed deleting attachment object after row delete');
    }

    return { deleted: true, id: attachment.id };
  }

  /**
   * Resolves a download URL for an attachment the caller can actually SEE, using
   * the letter access predicate from CorrespondenceService — download authorization
   * is NEVER weaker than letter authorization. The predicate requires the caller's
   * tenant too, so an attachment id belonging to another letter or tenant is a 404
   * — identical to a nonexistent one, which is why ids cannot be probed.
   * `storageKey` never leaves the server.
   */
  async resolveDownloadFor(userId: string, attachmentId: string): Promise<AttachmentDownloadDto> {
    // Request-context guard first (mismatched subject → refuse), then the shared
    // letter predicate for the actual visibility check.
    this.scope(userId);
    const { tenantId, where } = await this.correspondence.visiblePredicateFor(userId);

    const attachment = await this.prisma.letterAttachment.findFirst({
      where: {
        id: attachmentId,
        letter: { AND: [{ tenantId }, where] },
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

  /** Reduces a client filename to a safe, bounded basename (same contract as 49F). */
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