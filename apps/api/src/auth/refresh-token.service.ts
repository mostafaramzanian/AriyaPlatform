import { Injectable } from '@nestjs/common';
import { add } from 'date-fns';
import { PrismaService } from '../database/prisma.service';
import { TokenHashService } from './services/token-hash.service';

@Injectable()
export class RefreshTokenService {
  constructor(
    private prisma: PrismaService,
    private tokenHashService: TokenHashService,
  ) {}

  async createToken(userId: string, expiresInSeconds = 60 * 60 * 24 * 7) {
    const token = this.tokenHashService.generateToken();
    const tokenHash = this.tokenHashService.hashToken(token);
    const expiresAt = add(new Date(), { seconds: expiresInSeconds });
    const record = await this.prisma.refreshToken.create({
      data: {
        token: tokenHash,
        userId,
        expiresAt,
      },
    });
    return { id: record.id, token };
  }

  async findByToken(token: string) {
    const tokenHash = this.tokenHashService.hashToken(token);
    return this.prisma.refreshToken.findUnique({ where: { token: tokenHash } });
  }

  async revoke(tokenId: string) {
    return this.prisma.refreshToken.update({ where: { id: tokenId }, data: { revoked: true } });
  }

  async revokeAllForUser(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId }, data: { revoked: true } });
  }
}
