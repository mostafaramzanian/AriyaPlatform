import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TokenJwksController } from './token-jwks.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { PrismaModule } from '../database/prisma.module';
import { RefreshTokenService } from './refresh-token.service';
import { NotificationModule } from '../notifications/notification.module';
import { TokenHashService } from './services/token-hash.service';
import { SessionService } from './services/session.service';
import { RbacModule } from './rbac/rbac.module';
import { AuditService } from '../common/audit.service';
import { TokenAuthModule } from '../platform/auth/token-auth.module';

/**
 * Phase 51-HR-ARCH-3A: `JwtModule.registerAsync` used to live here, giving this module its
 * own copy of the shared secret so `AuthService` could sign and `JwtStrategy` could verify.
 * Both now go through `TokenAuthModule` (the platform issuer and verifier), so this module
 * holds no signing material of its own — the secret exists in exactly one place, and a
 * deployment on RS256 never places a signing key in a verifier.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule,
    CacheModule.register(),
    TokenAuthModule,
    UsersModule,
    PrismaModule,
    NotificationModule,
    RbacModule,
  ],
  providers: [
    AuthService,
    AuditService,
    JwtStrategy,
    LocalStrategy,
    RefreshTokenService,
    TokenHashService,
    SessionService,
  ],
  controllers: [AuthController, TokenJwksController],
  exports: [AuthService, AuditService, TokenHashService, SessionService, RbacModule],
})
export class AuthModule {}
