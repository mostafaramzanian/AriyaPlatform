import { Injectable, UnauthorizedException, BadRequestException, Logger, ForbiddenException, Optional } from '@nestjs/common';
import { TokenIssuer } from '../platform/auth/token-issuer';
import { PermissionSource } from '../platform/auth/permission-source.contract';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcryptjs';
import { RefreshTokenService } from './refresh-token.service';
import { NotificationPublisher } from '../notifications/notification.publisher';
import { PrismaService } from '../database/prisma.service';
import { TokenHashService } from './services/token-hash.service';
import { SessionService } from './services/session.service';
import { AuditService } from '../common/audit.service';
import { RequestContextService } from '../common/request-context.service';
import type { PassportLoginUser } from './auth.types';
import type { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');
  private readonly refreshTokenExpiration = 30 * 24 * 60; // 30 days in minutes

  constructor(
    private usersService: UsersService,
    /**
     * Phase 51-HR-ARCH-3A: this service no longer mints tokens itself. The claim set, the
     * algorithm and the lifetime are the platform's token contract, so issuance moved to
     * `TokenIssuer` — one issuer for the login path, the refresh path and every future
     * runtime, instead of a payload literal repeated at each call site.
     */
    private readonly tokenIssuer: TokenIssuer,
    /**
     * The same port `RolesGuard` uses. Passing `null` claims means "Core's catalogue is the
     * authority", which is the correct answer on the issuance path: the permissions are
     * being assembled HERE, so there is nothing to read them from yet.
     */
    private readonly permissionSource: PermissionSource,
    private refreshService: RefreshTokenService,
    private notificationPublisher: NotificationPublisher,
    private tokenHashService: TokenHashService,
    private sessionService: SessionService,
    private prisma: PrismaService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private async emitAuthAudit(opts: {
    action: string;
    userId?: string | null;
    resourceId?: string;
    success: boolean;
    reason?: string;
    sessionId?: string;
    ip?: string | null;
  }) {
    if (!this.auditService) return;
    const ctx = RequestContextService.get();
    await this.auditService.log({
      requestId: ctx?.requestId ?? `auth-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: opts.userId ?? undefined,
      ip: opts.ip ?? ctx?.ip ?? undefined,
      sessionId: opts.sessionId,
      action: opts.action,
      resource: 'auth',
      resourceId: opts.resourceId ?? 'auth',
      success: opts.success,
      reason: opts.reason,
      durationMs: ctx ? Date.now() - ctx.startTime : undefined,
    });
  }

  async validateUser(email: string, pass: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return null;
    const match = await bcrypt.compare(pass, user.passwordHash);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: PassportLoginUser, ipAddress?: string) {
    // Fetch user with tokenVersion
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, tokenVersion: true, tenantId: true },
    });

    if (!dbUser) {
      await this.emitAuthAudit({
        action: 'login_failed',
        userId: user?.id,
        resourceId: user?.id ?? 'auth-login',
        success: false,
        reason: 'user_not_found',
        ip: ipAddress,
      });
      throw new UnauthorizedException('User not found');
    }

    // Phase 51-HR-ARCH-3A: the token is minted by the platform issuer, which builds the
    // claim set (`tid`, `ver`, `perm` in the target model; `tokenVersion` on the bridge) and
    // enforces the lifetime bound. `tid` comes from the user row Core owns, because
    // ISSUANCE is Core's job — verification is the part that must not read Core.
    const permissions = await this.permissionSource.getEffectivePermissions(dbUser.id, null);

    const issued = await this.tokenIssuer.issueAccessToken({
      sub: dbUser.id,
      email: dbUser.email,
      tid: dbUser.tenantId,
      ver: dbUser.tokenVersion,
      perm: permissions,
    });

    const refresh = await this.refreshService.createToken(user.id);

    // Create session if Remember Me
    let sessionId: string | undefined;
    if (user.rememberMe) {
      sessionId = await this.sessionService.createSession(user.id, {
        ipAddress,
        userAgent: user.userAgent || 'unknown',
      });
    }

    // Publish login event
    await this.notificationPublisher.publish('auth.user.logged_in', {
      userId: user.id,
      email: user.email,
      timestamp: new Date().toISOString(),
      ipAddress: ipAddress || 'unknown',
    });

    await this.emitAuthAudit({
      action: 'login',
      userId: user.id,
      resourceId: user.id,
      success: true,
      reason: 'login_success',
      sessionId,
      ip: ipAddress,
    });

    this.logger.log(`User logged in: ${user.email}`);

    return {
      accessToken: issued.token,
      refreshToken: refresh.token,
      refreshTokenId: refresh.id,
      // Reported from the token that was actually minted (exp - iat), so the client's
      // expectation cannot disagree with the token it received.
      expiresIn: issued.expiresIn,
      sessionId,
    };
  }

  async register(_createUserDto: RegisterDto) {
    // Stage 2.20: a self-registered account has no tenant, and login cannot mint a token
    // without a `tid` (`TokenIssuanceError: Cannot mint a token without a tid`, observed as
    // HTTP 500). This snapshot has no invitation or membership path that could supply a
    // tenant, so a public signup is refused BEFORE any row is written. No default tenant is
    // assigned, and a caller-supplied `tenantId` is never trusted.
    void _createUserDto; // body already validated by the global ValidationPipe; the refusal reads nothing from it.
    throw new ForbiddenException(
      'Self-registration is disabled: an account needs a tenant membership, and no invitation flow is configured.',
    );
  }

  async refreshTokens(refreshToken: string) {
    // Find record (non-atomic read for fast failure)
    const record = await this.refreshService.findByToken(refreshToken);
    if (!record || record.revoked) {
      await this.emitAuthAudit({
        action: 'refresh_token_misuse',
        userId: record?.userId,
        resourceId: record?.userId ?? 'refresh-token',
        success: false,
        reason: record ? 'revoked_refresh_token' : 'invalid_refresh_token',
      });
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (record.expiresAt < new Date()) {
      await this.emitAuthAudit({
        action: 'refresh_token_misuse',
        userId: record.userId,
        resourceId: record.userId,
        success: false,
        reason: 'expired_refresh_token',
      });
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, email: true, tokenVersion: true, tenantId: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    // Atomic rotate: attempt to claim (revoke) the existing token only if not already revoked.
    // Use conditional update in a transaction to ensure at most one successful rotation.
    const now = new Date();
    const txResult = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.refreshToken.updateMany({
        where: { id: record.id, revoked: false, expiresAt: { gte: now } },
        data: { revoked: true },
      });
      if (updated.count !== 1) {
        return { success: false };
      }

      // Create successor token within same transaction
      const newPlain = this.tokenHashService.generateToken();
      const newHash = this.tokenHashService.hashToken(newPlain);
      const expiresAt = this.tokenHashService.getExpirationTime(this.refreshTokenExpiration);
      await tx.refreshToken.create({
        data: { token: newHash, userId: user.id, expiresAt },
      });
      return { success: true, newPlain };
    });

    if (!txResult.success) {
      // Another concurrent request claimed the token
      await this.emitAuthAudit({
        action: 'refresh_token_misuse',
        userId: user.id,
        resourceId: user.id,
        success: false,
        reason: 'concurrent_refresh_claim',
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const newRefreshTokenPlain = txResult.newPlain;
    // Phase 51-HR-ARCH-3A: the refresh path issues through the SAME issuer as login, so a
    // rotated access token carries the same claim set and the same lifetime bound. It used
    // to build its own payload and read its own TTL, which is how two issuance paths drift.
    const permissions = await this.permissionSource.getEffectivePermissions(user.id, null);

    const issued = await this.tokenIssuer.issueAccessToken({
      sub: user.id,
      email: user.email,
      tid: user.tenantId,
      ver: user.tokenVersion,
      perm: permissions,
    });

    // `expiresIn` is reported here for the same reason login reports it: it is read from the
    // token that was actually minted, so a client cannot be told a lifetime its token does not
    // have. Additive to the response, so an existing caller is unaffected.
    return {
      accessToken: issued.token,
      refreshToken: newRefreshTokenPlain,
      expiresIn: issued.expiresIn,
    };
  }

  async logout(userId: string) {
    await this.refreshService.revokeAllForUser(userId);

    // Get user for email in event
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // Publish logout event
    await this.notificationPublisher.publish('auth.user.logged_out', {
      userId,
      email: user?.email,
      timestamp: new Date().toISOString(),
    });

    await this.emitAuthAudit({
      action: 'logout',
      userId,
      resourceId: userId,
      success: true,
      reason: 'logout_success',
    });

    this.logger.log(`User logged out: ${user?.email}`);
    return true;
  }

  async logoutAll(userId: string) {
    await this.refreshService.revokeAllForUser(userId);
    await this.sessionService.invalidateAllSessions(userId);
    await this.incrementTokenVersion(userId);
    await this.emitAuthAudit({
      action: 'logout_all',
      userId,
      resourceId: userId,
      success: true,
      reason: 'logout_all_success',
    });
    return { revokedAll: true };
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
      throw new UnauthorizedException('Session not found or not owned by this user');
    }

    await this.emitAuthAudit({
      action: 'session_revoked',
      userId,
      resourceId: sessionId,
      success: true,
      reason: 'session_revoked_by_user',
    });

    return { revoked: true, sessionId };
  }

  async requestPasswordReset(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return true; // don't reveal existence

    const token = this.tokenHashService.generateToken();
    const expiresAt = this.tokenHashService.getExpirationTime(2 * 60); // 2 hours
    const hashedToken = this.tokenHashService.hashToken(token);

    await this.prisma.passwordReset.create({
      data: {
        token: hashedToken,
        userId: user.id,
        expiresAt,
        used: false,
      },
    });

    // Publish password reset requested event
    await this.notificationPublisher.publish('auth.password.reset.requested', {
      userId: user.id,
      email: user.email,
      token, // Send plain token; consumer includes in email link
      expiresAt: expiresAt.toISOString(),
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    });

    this.logger.log(`Password reset requested for: ${email}`);
    return true;
  }

  async resetPassword(token: string, newPassword: string) {
    // Find password reset token by deterministic hash. The column is already
    // unique because tokens are single-use random values.
    const tokenHash = this.tokenHashService.hashToken(token);
    const matching = await this.prisma.passwordReset.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });

    if (!matching || matching.used) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: undefined,
        resourceId: 'password-reset',
        success: false,
        reason: 'invalid_or_used_token',
      });
      throw new BadRequestException('Invalid or used token');
    }
    if (matching.expiresAt < new Date()) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: matching.userId,
        resourceId: matching.userId,
        success: false,
        reason: 'token_expired',
      });
      throw new BadRequestException('Token expired');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: matching.userId },
      data: { passwordHash },
    });

    await this.prisma.passwordReset.update({
      where: { id: matching.id },
      data: { used: true },
    });

    // Invalidate existing refresh tokens and active access tokens after a password reset
    await this.refreshService.revokeAllForUser(matching.userId);
    await this.incrementTokenVersion(matching.userId);

    await this.emitAuthAudit({
      action: 'password_reset_success',
      userId: matching.userId,
      resourceId: matching.userId,
      success: true,
      reason: 'password_reset_success',
    });

    // Publish audit log or notification for security
    this.logger.log(`Password reset for: ${matching.user.email}`);
    return true;
  }

  async resendVerificationEmail(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return true; // don't reveal existence

    if (user.emailVerified) {
      return true; // email already verified
    }

    // Create new verification token
    const token = this.tokenHashService.generateToken();
    const expiresAt = this.tokenHashService.getExpirationTime(24 * 60); // 24 hours
    const hashedToken = this.tokenHashService.hashToken(token);

    // Revoke old tokens for this user
    await this.prisma.emailVerification.deleteMany({
      where: { userId: user.id, used: false },
    });

    // Create new token
    await this.prisma.emailVerification.create({
      data: {
        token: hashedToken,
        userId: user.id,
        expiresAt,
        used: false,
      },
    });

    // Publish event
    await this.notificationPublisher.publish('auth.email.verification.requested', {
      userId: user.id,
      email: user.email,
      token, // Plain token for email
      expiresAt: expiresAt.toISOString(),
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    });

    this.logger.log(`Verification email resent for: ${email}`);
    return true;
  }

   async verifyEmail(token: string) {
     // Find email verification token by deterministic hash. The column is
     // already unique because tokens are single-use random values.
     const tokenHash = this.tokenHashService.hashToken(token);
     const matching = await this.prisma.emailVerification.findUnique({
       where: { token: tokenHash },
       include: { user: true },
     });

     if (!matching || matching.used) throw new BadRequestException('Invalid or used token');
     if (matching.expiresAt < new Date()) throw new BadRequestException('Token expired');
 
     await this.prisma.user.update({
       where: { id: matching.userId },
       data: { emailVerified: true },
     });
 
     await this.prisma.emailVerification.update({
       where: { id: matching.id },
       data: { used: true },
     });
 
     this.logger.log(`Email verified for: ${matching.user.email}`);
     return { verified: true, email: matching.user.email };
   }

   /**
    * Increment user's tokenVersion to invalidate all active JWTs
    * Called when permissions change (role assignment, role removal, permission updates)
    */
   async incrementTokenVersion(userId: string): Promise<number> {
     const updated = await this.prisma.user.update({
       where: { id: userId },
       data: { tokenVersion: { increment: 1 } },
       select: { tokenVersion: true },
     });

     this.logger.log(
       `Token version incremented for user ${userId}, new version: ${updated.tokenVersion}`,
     );

     return updated.tokenVersion;
   }
 }
