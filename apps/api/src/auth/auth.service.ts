import { Injectable, UnauthorizedException, BadRequestException, Logger, ForbiddenException, Optional } from '@nestjs/common';
import { TokenIssuer } from '../platform/auth/token-issuer';
import { REVOCATION_EVENT_CONTRACT } from '../platform/auth/token-revocation';
import { REVOCATION_ROUTING_KEY } from '../platform/auth/token-revocation-feed';
import { PermissionSource } from '../platform/auth/permission-source.contract';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcryptjs';
import { RefreshTokenService } from './refresh-token.service';
import { NotificationPublisher } from '../notifications/notification.publisher';
import { EmailService } from '../notifications/email/email.service';
import { passwordResetCodeEmail } from '../notifications/email/password-reset-code.email';
import { PrismaService } from '../database/prisma.service';
import { TokenHashService } from './services/token-hash.service';
import { SessionService } from './services/session.service';
import { AuditService } from '../common/audit.service';
import { RequestContextService } from '../common/request-context.service';
import type { PassportLoginUser } from './auth.types';
import type { RegisterDto } from './dto/register.dto';

/**
 * How long a password-reset CODE stays valid.
 *
 * TEN MINUTES, not the two hours the previous link-token flow allowed: a six-digit secret is
 * transcribed from a mailbox, so the window only has to be long enough for a person to open
 * their mail and type it. A shorter window is the cheapest defence there is against a code
 * that leaked (a shared screenshot, a forwarding rule), and the cost of an expired code is one
 * more request — which stays rate-limited.
 */
export const PASSWORD_RESET_CODE_TTL_MINUTES = 10;

/**
 * How many WRONG codes one row tolerates before it is burned.
 *
 * FIVE against a million possible values means an online guesser's odds are ~1 in 200,000 per
 * issued code, and the row dies at the cap so the attack must start over — against a request
 * path that is limited per IP and cooled down per account. This is the number that makes a
 * six-digit code defensible without making a typo lock a legitimate user out for long.
 */
export const MAX_PASSWORD_RESET_ATTEMPTS = 5;

/**
 * How long an account must wait before a SECOND code is issued.
 *
 * There is at most one live code per account, so without a cooldown a caller could invalidate
 * their own code by pressing the button twice — and an attacker could keep the mailbox busy.
 * Sixty seconds is measured from the last ISSUE, so the very first request is never delayed.
 */
export const PASSWORD_RESET_REQUEST_COOLDOWN_SECONDS = 60;

/**
 * The one sentence every refusal on the reset path uses.
 *
 * Deliberately identical for "no such account", "wrong code", "expired" and "burned": the
 * reset path is ANONYMOUS, so a message that distinguished them would turn it into an oracle
 * for which addresses exist and which codes are close. The operator-facing detail lives in the
 * audit trail (`reason`) instead, where only an administrator reads it.
 */
const PASSWORD_RESET_REFUSAL = 'Invalid or expired reset code';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');
  // Product decision: the session lifetime (the refresh token's validity) is NINE
  // HOURS. When it expires the user is fully signed out — the frontend drops the
  // session on the next 401 and returns to the login page.
  private readonly refreshTokenExpiration = 9 * 60; // 9 hours in minutes

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
    /**
     * PHASE PASSWORD-RESET-CODE: the ONE way this process sends mail.
     *
     * WHY THE MAIL IS SENT HERE AND NOT THROUGH THE EVENT BROKER. The reset path used to
     * publish `auth.password.reset.requested` and hope a consumer would send it — no consumer
     * exists, so no code ever reached a mailbox and the flow was a dead end. A credential that
     * must arrive for the feature to work is not an integration point: it is the request's own
     * side effect, so it is awaited here (and its failure is recorded, never thrown — see
     * `sendPasswordResetCode`).
     */
    private readonly emailService: EmailService,
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

  /**
   * Request a password-reset CODE for an email address.
   *
   * THE ANSWER IS ALWAYS THE SAME — `true`, in a 200 — whether or not the address exists,
   * whether or not a code was issued, and whether or not the mail could be delivered. That is
   * the whole contract of an anonymous endpoint that touches a mailbox: nothing it returns may
   * tell the caller which addresses are registered.
   *
   * WHAT ACTUALLY HAPPENS, in order:
   *  1. the account is resolved quietly (an unknown address stops here);
   *  2. a code issued less than `PASSWORD_RESET_REQUEST_COOLDOWN_SECONDS` ago is NOT replaced —
   *     the first code stays the valid one, so a double click cannot invalidate it;
   *  3. every other live code for the account is retired, so at most ONE code can ever work;
   *  4. a fresh six-digit code is hashed (account id + process pepper) and stored with its
   *     expiry; the plaintext exists only in this method's scope and in the email;
   *  5. the email is sent, and a delivery failure is recorded rather than thrown.
   *
   * NOTE ON THE BROKER EVENT: it still fires, but the payload no longer carries the credential.
   * A one-time secret must not sit in a broker queue where no consumer exists to use it.
   */
  async requestPasswordReset(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return true; // don't reveal existence

    const now = new Date();
    const live = await this.prisma.passwordReset.findFirst({
      where: { userId: user.id, used: false, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });

    if (
      live &&
      now.getTime() - live.createdAt.getTime() < PASSWORD_RESET_REQUEST_COOLDOWN_SECONDS * 1000
    ) {
      // A code was issued moments ago and is still valid: return the same neutral answer and
      // leave it alone. Replacing it here is what would make a double submit fail.
      this.logger.log(`Password reset code re-requested within the cooldown for: ${email}`);
      return true;
    }

    // At most one live code per account: the previous one is retired with the new one issued.
    await this.prisma.passwordReset.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    const code = this.tokenHashService.generateNumericCode();
    const expiresAt = this.tokenHashService.getExpirationTime(PASSWORD_RESET_CODE_TTL_MINUTES);

    await this.prisma.passwordReset.create({
      data: {
        codeHash: this.tokenHashService.hashPasswordResetCode(code, user.id),
        userId: user.id,
        expiresAt,
        used: false,
        attempts: 0,
      },
    });

    await this.sendPasswordResetCode(user.id, user.email, code, expiresAt);

    await this.notificationPublisher.publish('auth.password.reset.requested', {
      userId: user.id,
      email: user.email,
      expiresAt: expiresAt.toISOString(),
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    });

    await this.emitAuthAudit({
      action: 'password_reset_requested',
      userId: user.id,
      resourceId: user.id,
      success: true,
      reason: 'code_issued',
    });

    this.logger.log(`Password reset code issued for: ${email}`);
    return true;
  }

  /**
   * Deliver the code, and say so in the audit trail if it could not be delivered.
   *
   * WHY A FAILURE IS NOT THROWN. The code is already STORED, so a delivery failure is not a
   * dead end: the user may request another one (cooled down, then rate-limited). Throwing would
   * instead turn an infrastructure problem into a 500, and — worse — into an oracle that tells
   * an anonymous caller whether their address exists and whether this process can reach SMTP.
   * It is recorded with `reason`, and `EmailService` already logs the message it could not send
   * when no transport is configured, so a developer sees the code in the log exactly as before.
   */
  private async sendPasswordResetCode(
    userId: string,
    email: string,
    code: string,
    expiresAt: Date
  ) {
    const content = passwordResetCodeEmail({
      code,
      expiresInMinutes: PASSWORD_RESET_CODE_TTL_MINUTES,
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    });

    try {
      await this.emailService.sendMail(email, content.subject, content.html, content.text);
    } catch (err: unknown) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId,
        resourceId: userId,
        success: false,
        reason: 'reset_email_dispatch_failed',
      });
      this.logger.error(
        `Password reset email dispatch failed for user ${userId} (expires ${expiresAt.toISOString()}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Consume a password-reset CODE and set the new password.
   *
   * THE ORDER OF THE CHECKS IS THE SECURITY STORY:
   *  1. the account is resolved; an unknown address is refused with the SAME sentence as a
   *     wrong code, so this endpoint never confirms that an address exists;
   *  2. the account's live row is loaded — the user id is the key, never the code, so two
   *     accounts that received the same six digits cannot be confused;
   *  3. an expired row is refused (reported distinctly to the operator, never to the caller);
   *  4. a row at the attempt cap is refused: `attempts` is only incremented on WRONG codes
   *     below, so reaching the cap means five misses, and the row was burned at that point;
   *  5. the digest is compared against the stored one — a miss increments `attempts` and burns
   *     the row on the fifth, then refuses;
   *  6. only then: rehash (bcrypt, cost 12), mark the row used, revoke every refresh token and
   *     bump `tokenVersion` — which is what makes a reset end every existing session, including
   *     the one an attacker may be holding.
   */
  async resetPassword(email: string, code: string, newPassword: string) {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: undefined,
        resourceId: 'password-reset',
        success: false,
        reason: 'unknown_account',
      });
      throw new BadRequestException(PASSWORD_RESET_REFUSAL);
    }

    const pending = await this.prisma.passwordReset.findFirst({
      where: { userId: user.id, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: user.id,
        resourceId: user.id,
        success: false,
        reason: 'no_live_code',
      });
      throw new BadRequestException(PASSWORD_RESET_REFUSAL);
    }

    if (pending.expiresAt < new Date()) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: user.id,
        resourceId: user.id,
        success: false,
        reason: 'code_expired',
      });
      throw new BadRequestException(PASSWORD_RESET_REFUSAL);
    }

    if (pending.attempts >= MAX_PASSWORD_RESET_ATTEMPTS) {
      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: user.id,
        resourceId: user.id,
        success: false,
        reason: 'code_attempt_cap_reached',
      });
      throw new BadRequestException(PASSWORD_RESET_REFUSAL);
    }

    const submitted = this.tokenHashService.hashPasswordResetCode(code, user.id);
    if (submitted !== pending.codeHash) {
      const attempts = pending.attempts + 1;
      const burned = attempts >= MAX_PASSWORD_RESET_ATTEMPTS;

      await this.prisma.passwordReset.update({
        where: { id: pending.id },
        data: { attempts, used: burned },
      });

      await this.emitAuthAudit({
        action: 'password_reset_failed',
        userId: user.id,
        resourceId: user.id,
        success: false,
        reason: burned ? 'code_burned_after_attempt_cap' : 'invalid_code',
      });
      throw new BadRequestException(PASSWORD_RESET_REFUSAL);
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    await this.prisma.passwordReset.update({
      where: { id: pending.id },
      data: { used: true },
    });

    // Invalidate existing refresh tokens and active access tokens after a password reset
    await this.refreshService.revokeAllForUser(user.id);
    await this.incrementTokenVersion(user.id);

    await this.emitAuthAudit({
      action: 'password_reset_success',
      userId: user.id,
      resourceId: user.id,
      success: true,
      reason: 'password_reset_success',
    });

    this.logger.log(`Password reset for: ${user.email}`);
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
    *
    * TARGETED-REMEDIATION (P2, ADR-0006 §C1(2)): the increment is the REVOCATION act,
    * and it now also emits `platform.revocation@v1` on `domain_events` so the
    * verifier's deny-set hears about it within the TTL window instead of only at
    * refresh. The publish carries the contract's exact vocabulary —
    * `{userId, ver, tid, revokedAt}` plus the `contract` descriptor — and it is
    * emitted AFTER the write commits, so the event can never name a version the
    * database has not yet reached.
    */
   async incrementTokenVersion(userId: string): Promise<number> {
     const updated = await this.prisma.user.update({
       where: { id: userId },
       data: { tokenVersion: { increment: 1 } },
       select: { tokenVersion: true, tenantId: true },
     });

     this.logger.log(
       `Token version incremented for user ${userId}, new version: ${updated.tokenVersion}`,
     );

     if (updated.tenantId === null) {
       // `tid` is a required, non-empty contract field; a tenant-less user cannot be
       // named by a valid `platform.revocation@v1` event. Skipping is reported, never
       // silent — the TTL bound and the cold refresh path still cover the revocation.
       this.logger.warn(
         `No platform.revocation@v1 event emitted for ${userId}: the user row carries no tenantId`,
       );
     } else {
       await this.notificationPublisher.publish(REVOCATION_ROUTING_KEY, {
         contract: REVOCATION_EVENT_CONTRACT,
         userId,
         ver: updated.tokenVersion,
         tid: updated.tenantId,
         revokedAt: new Date().toISOString(),
       });
     }

     return updated.tokenVersion;
   }
 }
