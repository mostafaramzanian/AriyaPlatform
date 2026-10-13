import * as bcrypt from 'bcryptjs';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { RefreshTokenService } from './refresh-token.service';
import { NotificationPublisher } from '../notifications/notification.publisher';
import { TokenHashService } from './services/token-hash.service';
import { SessionService } from './services/session.service';
import { PrismaService } from '../database/prisma.service';
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
              findMany: jest.fn(),
              update: jest.fn(),
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

  describe('resetPassword', () => {
    it('should update password, mark token used, revoke refresh tokens and invalidate JWTs', async () => {
      const user = { ...mockUser, tokenVersion: 2 };
      (prisma.passwordReset.findUnique as jest.Mock).mockResolvedValue({
        id: 'reset-1',
        userId: user.id,
        token: 'hashed-token',
        used: false,
        expiresAt: new Date(Date.now() + 10000),
        user,
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({ ...user, tokenVersion: 3 });

      const result = await service.resetPassword('plain-token', 'NewPass123!');

      expect(result).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: user.id },
          data: expect.objectContaining({ passwordHash: expect.any(String) }),
        }),
      );
      expect(prisma.passwordReset.update).toHaveBeenCalledWith({
        where: { id: 'reset-1' },
        data: { used: true },
      });
      expect(refreshService.revokeAllForUser).toHaveBeenCalledWith(user.id);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: user.id },
          data: { tokenVersion: { increment: 1 } },
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'password_reset_success', success: true }));
    });

    it('should throw BadRequestException for invalid token', async () => {
      (prisma.passwordReset.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resetPassword('bad-token', 'NewPass123!')).rejects.toThrow(
        BadRequestException,
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'password_reset_failed', success: false }));
    });

    it('should throw BadRequestException for used token', async () => {
      (prisma.passwordReset.findUnique as jest.Mock).mockResolvedValue({
        id: 'reset-used',
        userId: mockUser.id,
        token: 'hashed-token',
        used: true,
        expiresAt: new Date(Date.now() + 10000),
        user: mockUser,
      });

      await expect(service.resetPassword('plain-token', 'NewPass123!')).rejects.toThrow(
        BadRequestException,
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
});
