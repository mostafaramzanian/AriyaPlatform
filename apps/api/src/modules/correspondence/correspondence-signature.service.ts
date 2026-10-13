import {
  BadRequestException,
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
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  UploadedAttachmentFile,
} from './correspondence-attachment.service';

export interface SignatureRefDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url?: string;
}

@Injectable()
export class CorrespondenceSignatureService {
  private readonly logger = new Logger(CorrespondenceSignatureService.name);

  constructor(
    private prisma: CorrespondencePrismaService,
    @Inject('IStorageProvider') private storage: IStorageProvider,
  ) {}

  private scope(userId: string): { userId: string; tenantId: string | null } {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new NotFoundException('Correspondence context is required');
    }

    return { userId, tenantId: context.tenantId ?? null };
  }

  async upload(userId: string, file: UploadedAttachmentFile | undefined): Promise<SignatureRefDto> {
    const scope = this.scope(userId);

    if (!file?.buffer?.length) {
      throw new BadRequestException('Signature file is required');
    }

    const size = file.size ?? file.buffer.length;
    const mimeType = file.mimetype ?? '';

    if (size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('Signature exceeds the 10 MB limit');
    }

    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported signature type: ${mimeType || 'unknown'}`);
    }

    const id = randomUUID();
    const fileName = this.safeFileName(file.originalname, id);
    const storageKey = `correspondence/signatures/${scope.userId}/${id}/${fileName}`;

    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (err) {
      this.logger.error({ err }, 'Signature storage upload failed');
      throw new InternalServerErrorException('Failed uploading signature');
    }

    try {
      const row = await this.prisma.letterSignature.create({
        data: {
          id,
          tenantId: scope.tenantId,
          userId: scope.userId,
          fileName,
          mimeType,
          size,
          storageKey,
        },
        select: { id: true, fileName: true, mimeType: true, size: true },
      });

      const url = await this.storage.getUrl(storageKey, { fileName, mimeType });
      return { ...row, url };
    } catch (err) {
      this.logger.error({ err }, 'Signature row insert failed — cleaning up storage');
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupErr) {
        this.logger.warn({ err: cleanupErr }, 'Failed cleaning up signature after DB failure');
      }
      throw new InternalServerErrorException('Failed creating signature record');
    }
  }

  /** Resolves a short-lived download URL for a signature the caller owns. */
  async resolveDownloadFor(userId: string, signatureId: string): Promise<SignatureRefDto> {
    const scope = this.scope(userId);

    const signature = await this.prisma.letterSignature.findFirst({
      where: { id: signatureId, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, fileName: true, mimeType: true, size: true, storageKey: true },
    });

    if (!signature) {
      throw new NotFoundException('Signature not found');
    }

    const url = await this.storage.getUrl(signature.storageKey, {
      fileName: signature.fileName,
      mimeType: signature.mimeType,
    });

    return {
      id: signature.id,
      fileName: signature.fileName,
      mimeType: signature.mimeType,
      size: signature.size,
      url,
    };
  }

  /** Removes an unused signature owned by the caller. */
  async remove(userId: string, signatureId: string): Promise<{ deleted: true; id: string }> {
    const scope = this.scope(userId);

    const signature = await this.prisma.letterSignature.findFirst({
      where: { id: signatureId, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, storageKey: true },
    });

    if (!signature) {
      throw new NotFoundException('Signature not found');
    }

    await this.prisma.letterSignature.delete({ where: { id: signature.id } });

    try {
      await this.storage.delete(signature.storageKey);
    } catch (err) {
      this.logger.warn({ err }, 'Failed deleting signature object after row delete');
    }

    return { deleted: true, id: signature.id };
  }

  private safeFileName(original: string | undefined, fallbackId: string): string {
    const base = (original ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+/, '')
      .slice(-120);

    return cleaned.length > 0 ? cleaned : `signature-${fallbackId.slice(0, 8)}`;
  }
}
