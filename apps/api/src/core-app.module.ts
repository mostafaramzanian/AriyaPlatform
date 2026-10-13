import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AUTHORIZATION_REDACT_PATHS } from './common/pino-config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './common/redis.module';
import { UsersModule } from './users/users.module';
import { TenantModule } from './tenant/tenant.module';
import { TenantContextInterceptor } from './tenant/tenant-context.interceptor';
import { TenantContextGuard } from './tenant/tenant-context.guard';
import { PrismaModule } from './database/prisma.module';
import { CoreHealthModule } from './health/core-health.module';
import { NotificationModule } from './notifications/notification.module';
import { StorageModule } from './storage/storage.module';
import { AIModule } from './ai/ai.module';
import { RulesModule } from './rules/rules.module';
import { MessagingModule } from './messaging/messaging.module';
import { SupportModule } from './support/support.module';
import { SurveysModule } from './surveys/surveys.module';
import { CalendarModule } from './calendar/calendar.module';
import { SearchModule } from './search/search.module';
import { PreferencesModule } from './preferences/preference.module';
import { IntegrationsModule } from './integrations/integration.module';
import { ModulePlatformModule } from './module-platform/module-platform.module';
import { PlatformAuditModule } from './platform/audit/platform-audit.module';
import { PlatformIdentityModule } from './platform/identity/platform-identity.module';
import { ObservabilityModule } from './observability/observability.module';
import { ObservabilityInterceptor } from './observability/observability.interceptor';

import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/rbac/guards/roles.guard';
import { AuditService } from './common/audit.service';
import { AuditDispatcherService } from './common/audit-dispatcher.service';
import { RequestContextService } from './common/request-context.service';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RateLimitMiddleware } from './common/rate-limit.middleware';

/**
 * Phase 33K: Core-only root module, used by core-main.ts.
 *
 * This is AppModule (see app.module.ts) minus BlogModule/CMS. It proves Core
 * has zero compile-time or runtime dependency on any CMS module, CMS Prisma
 * client, or CMS database — Core is fully independently bootable using only
 * CORE_DATABASE_URL.
 *
 * The combined single-process app (app.module.ts / main.ts) is unchanged and
 * remains the default deployable for now; this module is an additional,
 * independently bootable artifact, not a replacement.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env.local',
      validate: validateEnv,
    }),
    RedisModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        redact: AUTHORIZATION_REDACT_PATHS,
        timestamp: true,
        customProps: () => ({
          service: 'aria-erp-core',
          environment: process.env.NODE_ENV || 'development',
        }),
      },
    }),
    PrismaModule,
    CoreHealthModule,
    StorageModule,
    AIModule,
    RulesModule,
    NotificationModule,
    UsersModule,
    TenantModule,
    AuthModule,
    // Phase 49F: Internal Messaging. Registered after AuthModule because the
    // gateway verifies JWTs with the same secret and the controller relies on the
    // globally-registered JwtAuthGuard.
    MessagingModule,
    // Phase 49G: Core Support / Ticketing. Registered after AuthModule because the
    // controller relies on the globally-registered JwtAuthGuard and RolesGuard, and
    // the service resolves agent status through RBAC's PermissionService.
    SupportModule,
    // Phase 49H: Core Surveys / Participation. Registered after AuthModule for the
    // same reason as SupportModule: the controller relies on the globally-registered
    // JwtAuthGuard and RolesGuard, and the service resolves both survey permissions
    // through RBAC's PermissionService.
    SurveysModule,
    // Phase 49I: Calendar / Personal Reminders. Registered after NotificationModule
    // (imported transitively) because a fired reminder is delivered through the 49E
    // Notification Center, and after AuthModule because the controller relies on the
    // globally-registered JwtAuthGuard. It introduces no permission, so RolesGuard has
    // nothing to enforce here — ownership is the authorization edge.
    CalendarModule,
    // Phase 50-MOD-CORR: Official Correspondence USED to be registered here, as the
    // first business domain inside Core. It is now an independent module with its own
    // database (`correspondence_db`), its own Prisma client and its own scheduler, and
    // it is registered in AppModule — the composition root — instead. Core no longer
    // imports it, and `core-app.module.ts` must not import it again: the §25 isolation
    // spec asserts this file contains no reference to the module.
    // Phase 49J: Global Search. Registered LAST among the Core capabilities because it
    // reads every one of them: AIModule supplies the embedding path, RbacModule supplies
    // the two permission flags the authorization rules consult, and the eight indexed
    // sources belong to the modules above. It introduces no permission — every result is
    // filtered by its own source's authorization edge — so RolesGuard has nothing to
    // enforce here.
    SearchModule,
    // Phase 49K: Core Experience Platform — unified personalization. Registered LAST,
    // after SearchModule, because it is the only module every other Core surface reads
    // through: the shell resolves theme, density, text scale, motion and navigation
    // preferences before rendering any of them. It introduces no permission and gates no
    // route — RBAC is used here purely as an OUTPUT FILTER on stored navigation hrefs —
    // so RolesGuard has nothing to enforce, and ownership is the authorization edge.
    PreferencesModule,
    // Phase 49L: Core Automation & Integration Platform. Registered LAST because it is
    // the only module business capabilities EMIT into rather than read from: the
    // dependency runs inward (SupportModule imports IntegrationsModule, never the
    // reverse), so it must be resolvable before any emitter is constructed.
    //
    // It introduces two permissions (`admin.integrations.read` / `.manage`), both
    // seeded in core_db, and unlike 49J/49K it uses RBAC as a genuine ENTRY GATE on
    // every admin route — configuring a global outbound destination is not an ordinary
    // user capability. The inbound callback is the one non-JWT route in Core; it is
    // authenticated by HMAC instead, verified before any state is touched.
    //
    // Nothing here is mandatory for Core operation: with no integration configured, or
    // one disabled, unreachable or misconfigured, every emit returns SKIPPED/FAILED and
    // no business operation is affected.
    IntegrationsModule,
    // Phase 49M: Core Distributed Module Platform. Registered LAST, after IntegrationsModule,
    // because it is the outermost seam in Core: it is what other DEPLOYMENTS attach to, and it
    // depends on 49L's signature primitives and URL policy (as pure functions, not as a module
    // import — see module-platform.module.ts).
    //
    // It introduces two permissions (`admin.modules.read` / `.manage`), both seeded in core_db,
    // and like 49L it uses RBAC as a genuine ENTRY GATE on every admin route — admitting a module
    // to the platform is not an ordinary user capability. The three module-facing routes
    // (register / heartbeat / deregister) are the only non-JWT routes it adds; they are
    // authenticated by HMAC instead, verified before any state is touched.
    //
    // NOTHING HERE ASSUMES WHERE A MODULE RUNS. Every deployment topology in §MISSION — all
    // local, all remote, or any mixture — is a set of rows, not a code path. No business module
    // is created, referenced or implied.
    //
    // Nothing here is mandatory for Core operation: with no module registered, every resolution
    // returns MODULE_NOT_FOUND and no Core surface is affected.
    ModulePlatformModule,
    // Phase ARCH-3B: the `platform.audit@v1` seam — the port binding a business module injects
    // to reach the ONE audit trail, and the ingest consumer that writes the trail from the
    // `audit.#` binding on `domain_events`.
    //
    // IT IS REGISTERED HERE, IN CORE, because the trail is `core_db."AuditLog"`: a process with
    // no Core database can host neither the writer nor the consumer, and a process that HAS one
    // must not have to wait for a business module to be enabled before it starts ingesting.
    // That is also why `AppModule` (the combined runtime) registers it explicitly rather than
    // relying on `HrModule` to drag it in.
    //
    // WITH `RABBITMQ_URL` UNSET the consumer declines to start and says so; nothing here is
    // mandatory for Core operation, exactly like `ModulePlatformModule` above.
    PlatformAuditModule,
    // Phase ARCH-3B: the `platform.identity@v1` transport — the signed, Core-owned route group
    // `/platform/v1/identity` that answers A7's four approved operations for a business runtime
    // running as a SEPARATE PROCESS. An in-process consumer already injects `USER_DIRECTORY`
    // directly (`HrIdentityGateway`), so nothing here is for it and no second identity model is
    // introduced.
    //
    // IT IS REGISTERED HERE, IN CORE, for the same reason the audit seam above is: the answer comes
    // from `core_db` — A7 fixes tenant authority as Core's OWN membership check, not the signed
    // `tid` — so a process with no Core database can host neither the route group nor a truthful
    // answer to it.
    //
    // IT ADDS NO ADMIN ROUTE AND NO PERMISSION. Every route is `@Public()` in the JWT sense and
    // authenticated by the A8 capability credential for `platform.identity@v1` instead — a credential
    // issued for `platform.audit@v1` authenticates nothing here — so, exactly like the three
    // module-facing routes above, `RolesGuard` has nothing to enforce.
    //
    // WITH NO CREDENTIAL ISSUED the surface answers a uniform 401 and nothing else; nothing here is
    // mandatory for Core operation, like `ModulePlatformModule` and `PlatformAuditModule` above.
    PlatformIdentityModule,
    // Phase 49M-2: Core Observability / Logging / Audit platform. Registered LAST because it
    // is the only @Global() capability module here — the emit services must be injectable from
    // every module above without any of them adding an import, since a module that forgets the
    // import is a module that silently stops being observable.
    //
    // IT WRITES TO A SEPARATE DATABASE (observability_db, the third Prisma client), and reads
    // nothing from core_db. `AuditService` above keeps writing core_db."AuditLog" and
    // `/users/me/login-history` keeps reading it, unchanged (§51 KEEP): this is the forward
    // path, not a replacement, and the two coexist deliberately.
    //
    // It introduces ONE permission (`admin.observability.read`), seeded in core_db by
    // 20260905160000_seed_observability_permission_grants. There is nothing to `manage`: every
    // tunable is an environment variable and every row is written by the platform itself. The
    // read API has no POST and no DELETE — deletion happens only by retention policy, because
    // an administrator who could delete audit rows could erase evidence of their own actions.
    //
    // Nothing here is mandatory for Core operation: with OBSERVABILITY_ENABLED unset, or the
    // database unreachable, every emit is a no-op and no business operation is affected.
    ObservabilityModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AuditService,
    AuditDispatcherService,
    RequestContextService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Phase 54-C: the tenant context, established in the GUARD PHASE. Registered HERE for the
    // same reason the interceptor below is: the Core-only runtime must answer the same
    // questions as the combined one, and `ModuleEntitlementGuard` runs before interceptors in
    // both.
    {
      provide: APP_GUARD,
      useClass: TenantContextGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Phase 49D-1: the Organization Directory derives its tenant scope from
    // RequestContextService, which only the TenantContextInterceptor populates.
    // AppModule already registered it; the Core-only module did not, so every
    // directory read in the Core process would have failed the tenant check.
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    },
    // Phase 49M-2: the per-request observability line. Bound HERE rather than inside
    // ObservabilityModule, because a module-level interceptor applies only to that module's
    // own routes — it would have logged the observability endpoints and nothing else.
    //
    // ORDER MATTERS AND IS DELIBERATE: it is registered AFTER TenantContextInterceptor, so by
    // the time it reads RequestContextService the tenant is already populated. Nest runs
    // interceptors outside-in in registration order, so the later registration is the inner
    // one — which is also what makes its duration measurement closest to the handler.
    //
    // It records method, matched ROUTE PATTERN, status and duration. Never a body, never
    // headers, never a query string: `LogInput` has no field for them.
    {
      provide: APP_INTERCEPTOR,
      useClass: ObservabilityInterceptor,
    },
  ],
})
export class CoreAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware, RateLimitMiddleware).forRoutes('*');
  }
}
