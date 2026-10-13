import { Injectable, Inject, InternalServerErrorException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { CmsPrismaService } from '../../../database/cms-prisma.service';
import { IStorageProvider } from '../../../storage/i-storage.provider';
import { Prisma } from '../../../generated/cms-client';
import { randomUUID } from 'crypto';
import { normalizeSlug } from '../common/sanitize.util';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  constructor(private readonly prisma: CmsPrismaService, @Inject('IStorageProvider') private readonly storage: IStorageProvider) {}

  private mimeToMediaType(mime: string) {
    const lower = (mime || '').toLowerCase();
    if (lower.startsWith('image/')) return 'IMAGE';
    if (lower.startsWith('video/')) return 'VIDEO';
    if (lower.startsWith('audio/')) return 'AUDIO';
    // treat common document types as DOCUMENT
    if (lower === 'application/pdf' || lower.startsWith('text/') || lower.includes('officedocument') || lower.includes('sheet') || lower.includes('msword')) return 'DOCUMENT';
    return null;
  }

  async uploadFile(file: any, uploadedBy?: string, extras?: { altText?: string; caption?: string; tags?: string[]; metadata?: any }) {
    if (!file || !file.buffer) throw new BadRequestException('No file provided');
    const mediaType = this.mimeToMediaType(file.mimetype);
    if (!mediaType) {
      // validation error - unsupported media
      throw new BadRequestException(`Unsupported MIME type: ${file.mimetype}`);
    }

    const id = randomUUID();
    const safeName = file.originalname ? file.originalname.replace(/[^a-zA-Z0-9.\- _]/g, '') : id;
    const slug = normalizeSlug((safeName || id).replace(/\.[^.]+$/, '')) + '-' + id.slice(0, 8);
    const key = `media/${slug}/${safeName}`;

    // Upload to storage
    let url: string;
    try {
      url = await this.storage.upload(key, file.buffer, file.mimetype);
    } catch (e) {
      this.logger.error({ err: e }, 'Storage upload failed');
      throw new InternalServerErrorException('Failed uploading file to storage');
    }

    // Create DB row
    const data: Prisma.MediaCreateInput = {
      id,
      name: file.originalname,
      slug,
      type: mediaType as any,
      mimeType: file.mimetype,
      size: file.size,
      path: key,
      url,
      altText: extras?.altText,
      caption: extras?.caption,
      tags: extras?.tags ?? [],
      metadata: extras?.metadata ?? undefined,
      uploadedBy: uploadedBy ?? 'unknown',
    } as any;

    try {
      const created = await this.prisma.media.create({ data });
      return created;
    } catch (err) {
      this.logger.error({ err }, 'DB insert failed after storage upload - attempting cleanup');
      // attempt cleanup
      try {
        await this.storage.delete(key);
      } catch (cleanupErr) {
        this.logger.warn({ err: cleanupErr }, 'Failed to cleanup storage after DB failure');
      }
      throw new InternalServerErrorException('Failed creating media record');
    }
  }

  async getById(id: string) {
    if (!id) throw new NotFoundException('Media not found');
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.deletedAt) throw new NotFoundException('Media not found');
    return row;
  }

  async softDelete(id: string) {
    const existing = await this.prisma.media.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Media not found');
    if (existing.deletedAt) throw new NotFoundException('Media already deleted');
    const updated = await this.prisma.media.update({ where: { id }, data: { deletedAt: new Date() } });
    return updated;
  }
}
