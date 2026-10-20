import * as bcrypt from 'bcryptjs';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService, MAX_PASSWORD_RESET_ATTEMPTS } from './auth.service';
import { UsersService } from '../users/users.service';
import { RefreshTokenService } from './refresh-token.service';
import { NotificationPublisher } from '../notifications/notification.publisher';
import { TokenHashService } from './services/token-hash.service';
import { SessionService } from './services/session.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../notifications/email/email.service';
import { AuditService } from '../common/audit.service';
import { TokenIssuer } from '../platform/auth/token-issuer';
import { TokenPolicy } from '../platform/auth/token-policy';
import { TokenPermissionSource } from '../platform/auth/token-permission-source';
import { PermissionSource } from '../platform/auth/permission-source.contract';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../platform/auth/token-contract';

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxycQNpKfxvNflYl9ZLp/abc123',
  tokenVersion: 1,
  tenantId: 'tenant-1',
};

/** The shared secret this suite configures. Never the real one: this is a unit test. */
const TEST_JWT_SECRET = 'unit-test-shared-secret';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: UsersService;
  let refreshService: RefreshTokenService;
  let prisma: PrismaService;
  let auditService: AuditService;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    // Phase 51-HR-ARCH-3A: issuance is the platform's job now, so this suite wires the REAL
    // `TokenIssuer` and its `TokenPolicy` instead of a `JwtService` double. Assertions are
    // then about tokens that were actually signed and can be decoded — which is what makes
    // "the login path and the refresh path mint the same claims" testable rather than a
    // claim about two call sites agreeing by inspection.
    const policy = new TokenPolicy({ JWT_SECRET: TEST_JWT_SECRET });
    const jwt = new JwtService({});

    moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            create: jest.fn(),
          },
        },
        { provide: JwtService, useValue: jwt },
        { provide: TokenPolicy, useValue: policy },
        {
          provide: TokenIssuer,
          useFactory: (jwtService: JwtService, tokenPolicy: TokenPolicy) =>
            new TokenIssuer(jwtService, tokenPolicy),
          inject: [JwtService, TokenPolicy],
        },
        {
          // A `null` claims argument means "Core's catalogue is the authority", which this
          // claim-only source cannot answer — so it returns the empty set, exactly as it does
          // for a runtime with no database. Issuance does not depend on that answer: a legacy
          // token carries no `perm` claim at all.
          provide: PermissionSource,
          useClass: TokenPermissionSource,
        },
        {
          provide: RefreshTokenService,
          useValue: {
            createToken: jest.fn().mockResolvedValue({ id: 'refresh-id', token: 'refresh-token' }),
            findByToken: jest.fn(),
            revoke: jest.fn().mockResolvedValue({}),
            revokeAllForUser: jest.fn().mockResolvedValue({ count: 0 }),
          },
        },
        {
          provide: NotificationPublisher,
          useValue: {
            publish: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TokenHashService,
          useValue: {
            generateToken: jest.fn().mockReturnValue('plain-token'),
            hashToken: jest.fn().mockReturnValue('hashed-token'),
            getExpirationTime: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
            validateToken: jest.fn().mockReturnValue(true),
            // PHASE PASSWORD-RESET-CODE: the code the flow hands to the user, and the digest
            // it stores. Both doubles are deterministic so assertions can name them.
            generateNumericCode: jest.fn().mockReturnValue('123456'),
            hashPasswordResetCode: jest.fn(
              (code: string, userId: string) => `code-hash:${code}:${userId}`,
            ),
          },
        },
        {
          /**
           * PHASE PASSWORD-RESET-CODE: the mail seam. It is injected (never read from the
           * environment here) so a test can assert exactly what the user would receive —
           * including that the CODE is in the body.
           */
          provide: EmailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: SessionService,
          useValue: {
            createSession: jest.fn().mockResolvedValue('session-id'),
            invalidateAllSessions: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn(async (fn) => {
              const tx = {
                refreshToken: {
                  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                  create: jest.fn().mockResolvedValue({ id: 'new-refresh-id' }),
                },
              };
              return await fn(tx);
            }),
            user: {
              findUnique: jest.fn(),
              update: jest.fn(),
              create: jest.fn(),
            },
            role: {
              findUnique: jest.fn(),
            },
            userRole: {
              create: jest.fn(),
            },
            refreshToken: {
              create: jest.fn(),
              updateMany: jest.fn(),
            },
            emailVerification: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
              deleteMany: jest.fn(),
            },
            passwordReset: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: AuditService,
          useValue: {
            log: jest.fn().mockResolvedValue({ id: 'audit-1' }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get<AuthService>(AuthService);
    usersService = moduleRef.get<UsersService>(UsersService);
    refreshService = moduleRef.get<RefreshTokenService>(RefreshTokenService);
    prisma = moduleRef.get<PrismaService>(PrismaService);
    auditService = moduleRef.get<AuditService>(AuditService);
  });

  describe('validateUser', () => {
    it('should return user without passwordHash when credentials match', async () => {
      const password = 'ValidPass123';
      (usersService.findByEmail as jest.Mock).mockResolvedValue({
        ...mockUser,
        passwordHash: bcrypt.hashSync(password, 10),
      });

      const result = await service.validateUser(mockUser.email, password);

      expect(result).toBeDefined();
      expect(result!.email).toBe(mockUser.email);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('should return null when user not found', async () => {
      (usersService.findByEmail as jest.Mock).mockResolvedValue(null);

      const result = await service.validateUser('missing@example.com', 'any');

      expect(result).toBeNull();
    });

    it('should return null when password does not match', async () => {
      (usersService.findByEmail as jest.Mock).mockResolvedValue({
        ...mockUser,
        passwordHash: bcrypt.hashSync('other', 10),
      });

      const result = await service.validateUser(mockUser.email, 'WrongPass1');

      expect(result).toBeNull();
    });
  });

  describe('login', () => {
    it('should issue access and refresh tokens', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.login({ id: mockUser.id, email: mockUser.email });

      expect(typeof result.accessToken).toBe('string');
      expect(result.refreshToken).toBe('refresh-token');
      expect(result.refreshTokenId).toBe('refresh-id');
      expect(result.expiresIn).toBe(900);
      expect(refreshService.createToken).toHaveBeenCalledWith(mockUser.id);
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'login', resource: 'auth', success: true }));
    });

    /**
     * The claim set of a minted token, ASSERTED RATHER THAN DESCRIBED.
     *
     * `sub`, `email`, `tokenVersion`, `aud`, `iss` and a 15-minute lifetime are exactly what
     * this platform minted before the phase — this test is the regression guard for "the
     * bridge does not move the deployment". It is also the guard against the phase's own
     * temptation: `tid` and `perm` must NOT appear on a legacy token, because nothing
     * resolves them at legacy trust and their presence would suggest a capability the
     * bridge does not have.
     */
    it('mints the legacy claim set, and only that claim set', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.login({ id: mockUser.id, email: mockUser.email });
      const decoder = new JwtService({});
      const payload = decoder.decode<Record<string, unknown>>(result.accessToken)!;
      const { header } = decoder.decode<{ header: { alg: string; kid?: string } }>(
        result.accessToken,
        { complete: true },
      );

      expect(Object.keys(payload).sort()).toEqual(
        ['aud', 'email', 'exp', 'iat', 'iss', 'sub', 'tokenVersion'].sort(),
      );
      expect(payload.sub).toBe(mockUser.id);
      expect(payload.email).toBe(mockUser.email);
      expect(payload.tokenVersion).toBe(mockUser.tokenVersion);
      expect(payload.aud).toBe(TOKEN_AUDIENCE);
      expect(payload.iss).toBe(TOKEN_ISSUER);
      expect((payload.exp as number) - (payload.iat as number)).toBe(result.expiresIn);

      // The shared-secret bridge: HS256 and no `kid`, because there is no key set to name.
      expect(header.alg).toBe('HS256');
      expect(header.kid).toBeUndefined();
    });

    it('should create a session when rememberMe is true', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.login({
        id: mockUser.id,
        email: mockUser.email,
        rememberMe: true,
        userAgent: 'jest',
      });

      expect(result.sessionId).toBe('session-id');
    });

    it('should throw when user not found in database', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.login({ id: mockUser.id, email: mockUser.email })).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refreshTokens', () => {
    it('should rotate refresh token and return new access token', async () => {
      (refreshService.findByToken as jest.Mock).mockResolvedValue({
        id: 'old-refresh',
        userId: mockUser.id,
        revoked: false,
        expiresAt: new Date(Date.now() + 10000),
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.refreshTokens('old-token');

      expect(typeof result.accessToken).toBe('string');
      expect(result.refreshToken).toBe('plain-token');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    /**
     * The rotation path must not be a second, weaker issuer.
     *
     * Before this phase the refresh path built its own payload and read its own TTL
     * (`process.env.JWT_EXPIRES_IN || '15m'`) while login hard-coded `15m`. Both go through
     * `TokenIssuer` now, and this asserts the result: the rotated token carries the same
     * claims and the same lifetime as a freshly logged-in one.
     */
    it('rotates through the same issuer, so the new token carries the identical claim set', async () => {
      (refreshService.findByToken as jest.Mock).mockResolvedValue({
        id: 'old-refresh',
        userId: mockUser.id,
        revoked: false,
        expiresAt: new Date(Date.now() + 10000),
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.refreshTokens('old-token');
      const payload = new JwtService({}).decode<Record<string, unknown>>(result.accessToken)!;

      expect(Object.keys(payload).sort()).toEqual(
        ['aud', 'email', 'exp', 'iat', 'iss', 'sub', 'tokenVersion'].sort(),
      );
      expect(payload.sub).toBe(mockUser.id);
      expect(payload.tokenVersion).toBe(mockUser.tokenVersion);
      expect(result.expiresIn).toBe((payload.exp as number) - (payload.iat as number));
    });

    it('should reject a revoked refresh token', async () => {
      (refreshService.findByToken as jest.Mock).mockResolvedValue({
        id: 'revoked',
        userId: mockUser.id,
        revoked: true,
        expiresAt: new Date(Date.now() + 10000),
      });

      await expect(service.refreshTokens('revoked-token')).rejects.toThrow(UnauthorizedException);
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refresh_token_misuse', success: false }));
    });

    it('should reject an expired refresh token', async () => {
      (refreshService.findByToken as jest.Mock).mockResolvedValue({
        id: 'expired',
        userId: mockUser.id,
        revoked: false,
        expiresAt: new Date(Date.now() - 10000),
      });

      await expect(service.refreshTokens('expired-token')).rejects.toThrow(UnauthorizedException);
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refresh_token_misuse', success: false }));
    });
  });

  describe('register (Stage 2.20: no tenant, no account)', () => {
    const signup = {
      email: 'new-user@example.com',
      password: 'a-long-password',
      firstName: 'New',
      lastName: 'User',
    };

    it('refuses a public signup with 403 and writes nothing', async () => {
      await expect(service.register(signup)).rejects.toBeInstanceOf(ForbiddenException);

      // No user row, no VISITOR grant, no verification token and no event: a refused
      // signup must leave no half-built account behind.
      expect(usersService.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    });

    it('never trusts a caller-supplied tenantId or role to make the signup succeed', async () => {
      await expect(
        service.register({ ...signup, role: 'ADMIN', tenantId: 'tenant-1' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(usersService.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('should revoke all refresh tokens for user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.logout(mockUser.id);

      expect(result).toBe(true);
      expect(refreshService.revokeAllForUser).toHaveBeenCalledWith(mockUser.id);
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'logout', resource: 'auth', success: true }));
    });
  });

  describe('logoutAll', () => {
    it('should revoke refresh tokens, invalidate Redis sessions, and bump tokenVersion', async () => {
      const sessionServiceMock = moduleRef.get(SessionService) as jest.Mocked<SessionService>;
      (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, tokenVersion: 2 });

      const result = await service.logoutAll(mockUser.id);

      expect(result.revokedAll).toBe(true);
      expect(refreshService.revokeAllForUser).toHaveBeenCalledWith(mockUser.id);
      expect(sessionServiceMock.invalidateAllSessions).toHaveBeenCalledWith(mockUser.id);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockUser.id },
          data: { tokenVersion: { increment: 1 } },
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'logout_all', resource: 'auth', success: true }));
    });
  });

  describe('requestPasswordReset', () => {
    let emailService: EmailService;

    beforeEach(() => {
      emailService = moduleRef.get<EmailService>(EmailService);
      (usersService.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.passwordReset.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.passwordReset.create as jest.Mock).mockResolvedValue({ id: 'reset-new' });
    });

    it('stores a SALTED HASH of a six-digit code and emails that code in subject AND body', async () => {
      const result = await service.requestPasswordReset(mockUser.email);

      expect(result).toBe(true);
      const created = (prisma.passwordReset.create as jest.Mock).mock.calls[0][0].data;
      expect(created.codeHash).toBe(`code-hash:123456:${mockUser.id}`);
      expect(created.codeHash).not.toBe('123456');
      expect(created.attempts).toBe(0);
      expect(created.used).toBe(false);
      expect((created.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());

      const [to, subject, html, text] = (emailService.sendMail as jest.Mock).mock.calls[0];
      expect(to).toBe(mockUser.email);
      expect(subject).toContain('123456');
      expect(html).toContain('1 2 3 4 5 6');
      expect(text).toContain('123456');
      // The message states the lifetime and the "ignore it if it wasn't you" rule.
      expect(text).toContain('10');
      expect(text).toContain('نادیده');
    });

    it('never puts the code on the event broker, and audits the issue', async () => {
      const publisher = moduleRef.get(NotificationPublisher);

      await service.requestPasswordReset(mockUser.email);

      const [eventType, payload] = (publisher.publish as jest.Mock).mock.calls[0];
      expect(eventType).toBe('auth.password.reset.requested');
      expect(JSON.stringify(payload)).not.toContain('123456');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'password_reset_requested', success: true }),
      );
    });

    it('retires the previous live code, so only ONE code can ever work', async () => {
      await service.requestPasswordReset(mockUser.email);

      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, used: false },
        data: { used: true },
      });
    });

    it('does NOT replace a code issued inside the cooldown (a double click cannot void it)', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue({
        id: 'reset-live',
        userId: mockUser.id,
        createdAt: new Date(Date.now() - 5 * 1000),
        expiresAt: new Date(Date.now() + 9 * 60 * 1000),
        used: false,
      });

      const result = await service.requestPasswordReset(mockUser.email);

      expect(result).toBe(true);
      expect(prisma.passwordReset.create).not.toHaveBeenCalled();
      expect(prisma.passwordReset.updateMany).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('issues a NEW code once the cooldown has passed', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue({
        id: 'reset-live',
        userId: mockUser.id,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        used: false,
      });

      await service.requestPasswordReset(mockUser.email);

      expect(prisma.passwordReset.create).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it('answers the same for an unknown address, and sends nothing', async () => {
      (usersService.findByEmail as jest.Mock).mockResolvedValue(null);

      await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBe(true);
      expect(prisma.passwordReset.create).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('does not fail the request when SMTP is down, and records the dispatch failure', async () => {
      (emailService.sendMail as jest.Mock).mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(service.requestPasswordReset(mockUser.email)).resolves.toBe(true);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'password_reset_failed',
          success: false,
          reason: 'reset_email_dispatch_failed',
        }),
      );
    });
  });

  describe('resetPassword', () => {
    /** The one live row the reset path reads, with the digest the mocked service produces. */
    const pendingRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'reset-1',
      userId: mockUser.id,
      codeHash: `code-hash:123456:${mockUser.id}`,
      attempts: 0,
      used: false,
      createdAt: new Date(Date.now() - 60 * 1000),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      ...overrides,
    });

    beforeEach(() => {
      (usersService.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(pendingRow());
      (prisma.passwordReset.update as jest.Mock).mockResolvedValue({});
      (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, tokenVersion: 3 });
    });

    it('accepts the emailed code: updates the password, burns the row and ends every session', async () => {
      const result = await service.resetPassword(mockUser.email, '123456', 'NewPass123!');

      expect(result).toBe(true);
      const stored = (prisma.user.update as jest.Mock).mock.calls[0][0].data.passwordHash;
      expect(stored).not.toContain('NewPass123!');
      expect(stored.startsWith('$2')).toBe(true);

      expect(prisma.passwordReset.update).toHaveBeenCalledWith({
        where: { id: 'reset-1' },
        data: { used: true },
      });
      expect(refreshService.revokeAllForUser).toHaveBeenCalledWith(mockUser.id);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockUser.id },
          data: { tokenVersion: { increment: 1 } },
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'password_reset_success', success: true }),
      );
    });

    it('refuses a WRONG code with the generic sentence and counts the attempt', async () => {
      await expect(
        service.resetPassword(mockUser.email, '000000', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.passwordReset.update).toHaveBeenCalledWith({
        where: { id: 'reset-1' },
        data: { attempts: 1, used: false },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'password_reset_failed',
          reason: 'invalid_code',
          success: false,
        }),
      );
    });

    it('BURNS the row on the last allowed wrong attempt, so guessing must start over', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(
        pendingRow({ attempts: MAX_PASSWORD_RESET_ATTEMPTS - 1 }),
      );

      await expect(
        service.resetPassword(mockUser.email, '000000', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.passwordReset.update).toHaveBeenCalledWith({
        where: { id: 'reset-1' },
        data: { attempts: MAX_PASSWORD_RESET_ATTEMPTS, used: true },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'code_burned_after_attempt_cap', success: false }),
      );
    });

    it('refuses a row already at the cap, without comparing anything', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(
        pendingRow({ attempts: MAX_PASSWORD_RESET_ATTEMPTS }),
      );

      await expect(
        service.resetPassword(mockUser.email, '123456', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.passwordReset.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'code_attempt_cap_reached', success: false }),
      );
    });

    it('refuses an EXPIRED code and tells the operator why', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(
        pendingRow({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.resetPassword(mockUser.email, '123456', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'code_expired', success: false }),
      );
    });

    it('refuses when no live code exists — a used or never-issued row', async () => {
      (prisma.passwordReset.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resetPassword(mockUser.email, '123456', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no_live_code', success: false }),
      );
    });

    it('answers an unknown address exactly like a wrong code — no account oracle', async () => {
      (usersService.findByEmail as jest.Mock).mockResolvedValue(null);
      const unknown = await service
        .resetPassword('nobody@example.com', '123456', 'NewPass123!')
        .catch((err: Error) => err.message);

      (usersService.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      const wrongCode = await service
        .resetPassword(mockUser.email, '000000', 'NewPass123!')
        .catch((err: Error) => err.message);

      expect(unknown).toBe(wrongCode);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unknown_account', success: false }),
      );
    });
  });

  describe('verifyEmail', () => {
    it('should verify email with valid token', async () => {
      (prisma.emailVerification.findUnique as jest.Mock).mockResolvedValue({
        id: 'verify-1',
        userId: mockUser.id,
        token: 'hashed-token',
        used: false,
        expiresAt: new Date(Date.now() + 10000),
        user: mockUser,
      });

      const result = await service.verifyEmail('plain-token');

      expect(result.verified).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockUser.id },
          data: { emailVerified: true },
        }),
      );
      expect(prisma.emailVerification.update).toHaveBeenCalledWith({
        where: { id: 'verify-1' },
        data: { used: true },
      });
    });

    it('should throw BadRequestException for invalid or used token', async () => {
      (prisma.emailVerification.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.verifyEmail('bad-token')).rejects.toThrow(BadRequestException);
    });
  });
/**
 * TARGETED-REMEDIATION (P2): `incrementTokenVersion` is the revocation act, and it must
 * ALSO publish `platform.revocation@v1` so the deny-set hears within the TTL window.
 * The publish is asserted on the publisher double — what the contract demands is
 * "the exact vocabulary on the right routing key", not a broker.
 */
describe('incrementTokenVersion — the platform.revocation@v1 emission', () => {
  it('publishes the revocation event AFTER the version bump, with the committed ver', async () => {
    const publisher = moduleRef.get(NotificationPublisher);
    (prisma.user.update as jest.Mock).mockResolvedValue({
      tokenVersion: 8,
      tenantId: 'tenant-1',
    });

    const result = await service.incrementTokenVersion('user-1');

    expect(result).toBe(8);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true, tenantId: true },
    });
    expect(publisher.publish).toHaveBeenCalledWith(
      'platform.revocation',
      expect.objectContaining({
        contract: 'platform.revocation@v1',
        userId: 'user-1',
        ver: 8,
        tid: 'tenant-1',
      })
    );
  });

  it('emits NO event for a tenant-less user — the contract cannot name it', async () => {
    const publisher = moduleRef.get(NotificationPublisher);
    (prisma.user.update as jest.Mock).mockResolvedValue({
      tokenVersion: 3,
      tenantId: null,
    });

    await service.incrementTokenVersion('user-orphan');

    expect(publisher.publish).not.toHaveBeenCalledWith(
      'platform.revocation',
      expect.anything()
    );
  });
});
});
