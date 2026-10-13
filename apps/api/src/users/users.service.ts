import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type { User } from '../generated/core-client';
import { escapeHtml } from '../common/sanitize.util';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { IStorageProvider } from '../storage/i-storage.provider';

/**
 * The in-memory upload multer's `memoryStorage` produces for avatars — the
 * four fields this service actually reads. Structural on purpose: multer has
 * no installed type declarations in this repo, so this is the contract both
 * the controller parameter and this method bind to.
 */
export interface UploadedAvatarFile {
  readonly mimetype: string;
  readonly size: number;
  readonly originalname: string;
  readonly buffer: Buffer;
}

/** What `AuthService.register` sanitizes before handing to `create`. */
export interface CreateUserInput {
  readonly email: string;
  readonly password: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    @Inject('IStorageProvider') private readonly storageProvider: IStorageProvider,
  ) {}

  /**
   * The public projection of a Core user row: everything except the two
   * security-version fields. `delete` on a spread copy (rather than a
   * destructuring discard) so no binding is declared without being read.
   */
  private safeUser(user: User | null): Omit<User, 'passwordHash' | 'tokenVersion'> | null {
    if (!user) return null;
    const safe: Partial<User> = { ...user };
    delete safe.passwordHash;
    delete safe.tokenVersion;
    return safe as Omit<User, 'passwordHash' | 'tokenVersion'>;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(data: CreateUserInput) {
    const passwordHash = await bcrypt.hash(data.password, 12);
    const firstName = data.firstName ? escapeHtml(data.firstName) : '';
    const lastName = data.lastName ? escapeHtml(data.lastName) : '';
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        firstName,
        lastName,
      },
    });
    return user;
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByIdSafe(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return this.safeUser(user);
  }

  async updateSelfProfile(userId: string, dto: UpdateUserProfileDto) {
    // Phase 49D-1 self-edit boundary: only firstName/lastName/phone are ever
    // written here. The organization attributes added in 49D-1 (department,
    // jobTitle, extension, managerId) are organization-controlled and must never
    // be self-settable. Two independent layers enforce that: UpdateUserProfileDto
    // does not declare them (the global ValidationPipe runs with `whitelist` +
    // `forbidNonWhitelisted`, so sending them is rejected outright), and this
    // method builds `data` from an explicit field list rather than spreading dto.
    const data: Record<string, string | null> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName?.trim() ? escapeHtml(dto.firstName.trim()) : null;
    if (dto.lastName !== undefined) data.lastName = dto.lastName?.trim() ? escapeHtml(dto.lastName.trim()) : null;
    if (dto.phone !== undefined) data.phone = dto.phone?.trim() ? dto.phone.trim() : null;

    if (Object.keys(data).length === 0) {
      return this.findByIdSafe(userId);
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.safeUser(updated);
  }

  async getLoginHistory(userId: string) {
    return this.prisma.auditLog.findMany({
      where: {
        userId,
        action: { in: ['login', 'login_failed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        action: true,
        success: true,
        reason: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
      },
    });
  }

  async listSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        revoked: true,
      },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId },
      data: { revoked: true },
    });

    if (result.count !== 1) {
      throw new BadRequestException('Session not found or not owned by this user');
    }

    return { revoked: true, sessionId };
  }

  async logoutAllForUser(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { revoked: true },
    });
    return { revokedAll: true };
  }

  private getStorageKeyFromUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const pathname = decodeURIComponent(parsed.pathname);
      return pathname.replace(/^\/[^/]+\//, '');
    } catch {
      return url.split('/').slice(-2).join('/');
    }
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile) {
    if (!file) throw new BadRequestException('Avatar file is required');
    const validMime = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!validMime.has(file.mimetype)) {
      throw new BadRequestException('Only PNG, JPG, WEBP, and GIF images are allowed');
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('Avatar must be 10 MB or less');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'png';
    const storageKey = `avatars/${userId}-${Date.now()}.${ext}`;
    const uploadedUrl = await this.storageProvider.upload(storageKey, file.buffer, file.mimetype);

    const previousKey = this.getStorageKeyFromUrl(user.avatarUrl);
    if (previousKey) {
      try {
        await this.storageProvider.delete(previousKey);
      } catch {
        // ignore stale delete failure
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: uploadedUrl },
    });

    return this.safeUser(updated);
  }

  async removeAvatar(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const previousKey = this.getStorageKeyFromUrl(user.avatarUrl);
    if (previousKey) {
      try {
        await this.storageProvider.delete(previousKey);
      } catch {
        // ignore stale delete failure
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
    });

    return this.safeUser(updated);
  }
}
