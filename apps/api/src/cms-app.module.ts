import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AUTHORIZATION_REDACT_PATHS } from './common/pino-config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/rbac/guards/roles.guard';
import { RedisModule } from './common/redis.module';
import { validateEnv } from './config/env.validation';
import { CmsHealthModule } from './health/cms-health.module';
import { CmsOnlyBlogModule } from './modules/cms/blog/blog-cms-only.module';
import { RequestContextService } from './common/request-context.service';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RateLimitMiddleware } from './common/rate-limit.middleware';

/**
 * Phase 33K: CMS-only root module, used by cms-main.ts.
 *
 * CMS's OWN business data and logic (BlogModule -> CmsOnlyBlogModule) has NO
 * dependency on Core's database: it uses CmsPrismaModule exclusively, and
 * Audit/NotificationPublisher's Core dependency is @Optional() and unused
 * here (see blog-cms-only.module.ts).
 *
 * HOWEVER: this module still imports AuthModule and registers the same
 * global JwtAuthGuard/RolesGuard as Core, because CMS's protected endpoints
 * (create/update/delete/publish/... in BlogController) must not run without
 * authentication/authorization. AuthModule -> RbacModule -> PrismaModule
 * (Core) is required for:
 *   - JwtStrategy.validate(): looks up Core `User.tokenVersion` on every
 *     authenticated request (token revocation check);
 *   - PermissionService.getUserPermissions(): reads Core `Role`/`Permission`
 *     tables for every @Roles()-guarded request.
 *
 * This is a REAL, PRE-EXISTING Identity/RBAC dependency, NOT the Audit
 * dependency this phase was scoped to resolve, and redesigning it (e.g.
 * stateless JWT verification, a token-introspection endpoint, or a
 * replicated read-only identity cache) is explicitly out of scope for this
 * phase ("do NOT redesign Identity/RBAC"). It is reported, not hidden, in
 * the Phase 33K report as a new, larger blocker to full CMS process
 * independence than Audit was.
 *
 * Only CMS's 2 @Public() routes (GET /blog, GET /blog/:slug) are reachable
 * without Core database connectivity, because JwtAuthGuard/RolesGuard both
 * short-circuit to `true` for @Public() routes before touching JwtStrategy
 * or PermissionService.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env.local',
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        redact: AUTHORIZATION_REDACT_PATHS,
        timestamp: true,
        customProps: () => ({
          service: 'aria-erp-cms',
          environment: process.env.NODE_ENV || 'development',
        }),
      },
    }),
    RedisModule,
    CmsHealthModule,
    AuthModule,
    CmsOnlyBlogModule,
  ],
  providers: [
    RequestContextService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class CmsAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware, RateLimitMiddleware).forRoutes('*');
  }
}
