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
import { CombinedHealthModule } from './health/combined-health.module';
import { NotificationModule } from './notifications/notification.module';
import { StorageModule } from './storage/storage.module';
import { AIModule } from './ai/ai.module';
import { RulesModule } from './rules/rules.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/rbac/guards/roles.guard';
import { BlogModule } from './modules/cms/blog/blog.module';
import { MediaModule } from './modules/cms/media/media.module';
import { SurveysModule } from './surveys/surveys.module';
import { CalendarModule } from './calendar/calendar.module';
import { MessagingModule } from './messaging/messaging.module';
import { SupportModule } from './support/support.module';
import { SearchModule } from './search/search.module';
import { PreferencesModule } from './preferences/preference.module';
import { IntegrationsModule } from './integrations/integration.module';
import { ModulePlatformModule } from './module-platform/module-platform.module';
import { PlatformAuditModule } from './platform/audit/platform-audit.module';
import { PlatformIdentityModule } from './platform/identity/platform-identity.module';
import { ObservabilityModule } from './observability/observability.module';
import { ObservabilityInterceptor } from './observability/observability.interceptor';
import { CorrespondenceModule } from './modules/correspondence/correspondence.module';
// Phase 51-HR-1: Human Resources (منبع انسانی) — an INDEPENDENT module with its own
// database (`hr_db`), its own Prisma project/client/migrations and its own RBAC domain.
// Registered HERE, in the composition root, and deliberately NOT in `CoreAppModule`,
// exactly like Correspondence: the Core-only deployable boots with zero HR knowledge and
// reaches none of HR's tables. HR's only view of Core is the platform user-directory port
// plus RBAC (audit) — never Core's Prisma client.
import { HrModule } from './modules/hr/hr.module';
// Phase C1: Commerce — the procurement bounded context — an INDEPENDENT module with
// its own database (`commerce_db`), its own Prisma project/client/migrations. This is
// its composition root (gate G5): registered HERE, and deliberately NOT in
// `CoreAppModule`, exactly like Correspondence and HR — the Core-only deployable
// boots with zero Commerce knowledge and reaches none of Commerce's tables. Commerce's
// only view of Core is the platform ports it must not own (identity, audit,
// entitlement) — never Core's Prisma client.
import { CommerceModule } from './modules/commerce/commerce.module';
// Phase PRODUCTION-BOM-HEADER: Production — the BOM bounded context — an INDEPENDENT
// module with its own database (`production_db`), its own Prisma project/client/
// migrations. This is its composition root: registered HERE, and deliberately NOT in
// `CoreAppModule`, exactly like Correspondence, HR and Commerce — the Core-only deployable
// boots with zero Production knowledge and reaches none of Production's tables. Production's
// only view of Core is the platform ports it must not own (identity, audit, entitlement)
// — never Core's Prisma client, and never Commerce's, HR's or Correspondence's.
import { ProductionModule } from './modules/production/production.module';
// Phase F1 — FINANCIAL FOUNDATION: Financial — the check-request bounded context — an
// INDEPENDENT module with its own database (`finance_db`, reached through
// `FINANCE_DATABASE_URL`), its own Prisma project/client/migrations. This is its
// composition root: registered HERE, and deliberately NOT in `CoreAppModule`, exactly
// like Correspondence, HR, Commerce and Production — the Core-only deployable boots with
// zero Financial knowledge and reaches none of Financial's tables. Financial's only view
// of Core is the platform ports it must not own (identity, audit, entitlement) — never
// Core's Prisma client, and never another business module's.
import { FinancialModule } from './modules/financial/financial.module';
import { InventoryModule } from './modules/inventory/inventory.module';
// Phase REPORTING-CONTEXT: Reporting — the reporting bounded context — composed HERE
// exactly like Correspondence, HR, Commerce, Production and Financial, and deliberately
// NOT in `CoreAppModule` (enforced by `reporting-isolation.spec.ts`): the Core-only
// deployable boots with zero Reporting knowledge. The context's ownership is explicit
// and deliberately narrow — it owns NO datasource, NO client, NO routes and NO
// permissions, because the repository establishes no Reporting business contract yet
// (evidence: docs/reports/PHASE-REPORTING-BOUNDED-CONTEXT.md). Its single dependency
// is `PlatformAIModule` -> `AI_GATEWAY` (embed-only); `src/ai/ai-boundaries.spec.ts`
// and `src/modules/reporting/reporting-isolation.spec.ts` make both halves of that
// boundary executable.
import { ReportingModule } from './modules/reporting/reporting.module';
// Phase KPI-RUNTIME: the KPI bounded context — composed HERE exactly like Reporting above,
// and deliberately NOT in `CoreAppModule` (enforced by `kpi-runtime-isolation.spec.ts`): the
// Core-only and CMS-only runtimes must not name it, because reading a KPI means reading a
// Production, a Commerce or a Financial row through that context's own seam. It owns NO
// datasource, NO client, NO permission and NO write — the first KPI phase established the
// definitions, this phase computes them for the current tenant under the source's own remit
// (docs/architecture/KPI-CATALOG.md, "Future KPI runtime contract").
import { KpiRuntimeModule } from './modules/kpi-runtime/kpi-runtime.module';
import { AuditService } from './common/audit.service';
import { AuditDispatcherService } from './common/audit-dispatcher.service';
import { RequestContextService } from './common/request-context.service';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RateLimitMiddleware } from './common/rate-limit.middleware';

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
          service: 'aria-erp-api',
          environment: process.env.NODE_ENV || 'development',
        }),
      },
    }),
    PrismaModule,
    CombinedHealthModule,
    StorageModule,
    AIModule,
    RulesModule,
    NotificationModule,
    UsersModule,
    TenantModule,
    AuthModule,
    // CMS modules
    BlogModule,
    // Media module: Phase 34J - minimal server-side media ingestion & management
    MediaModule,
    // Phase 49I: Calendar / Reminders (required by the Jalali date picker used across the platform)
    CalendarModule,
    MessagingModule,
    SupportModule,
    SurveysModule,
    SearchModule,
    PreferencesModule,
    IntegrationsModule,
    ModulePlatformModule,
    // Phase ARCH-3B: the platform audit seam. Registered explicitly here as well as in
    // `CoreAppModule`, even though `HrModule` imports it too, because the COMBINED runtime's
    // audit ingest must not depend on HR being enabled — a module import is a wiring detail,
    // not a precondition for a platform capability.
    PlatformAuditModule,
    // Phase ARCH-3B: the `platform.identity@v1` transport — the signed, Core-owned route group
    // `/platform/v1/identity` that answers A7's four approved `UserDirectoryContract` operations for
    // a business runtime running as a SEPARATE PROCESS. An in-process consumer already holds
    // `USER_DIRECTORY` directly, so nothing here is for it.
    //
    // IT IS REGISTERED IN THE COMBINED RUNTIME TOO, not only in `CoreAppModule` (which carries the
    // full reasoning), because a business runtime cannot be asked to care WHICH deployable answered
    // it: the same route group and the same credential must work in both topologies. Relying on
    // `HrModule` to import it would make a platform capability conditional on HR being enabled.
    //
    // It adds no admin route and no permission: every route is `@Public()` in the JWT sense and
    // authenticated by the A8 capability credential for `platform.identity@v1` — a credential issued
    // for `platform.audit@v1` authenticates nothing here — so `RolesGuard` has nothing to enforce.
    PlatformIdentityModule,
    ObservabilityModule,
    // Phase 50 / 50-MOD-CORR: Official Correspondence (مکاتبات اداری) — extracted out of
    // Core into an INDEPENDENT module with its own database, its own Prisma client, its
    // own migrations and its own scheduler. It is registered HERE, in the composition
    // root, and deliberately NOT in CoreAppModule: Core no longer lists it, imports it
    // or reaches into its tables. Its only view of Core is the platform user-directory
    // port (identity it must never own) plus RBAC, notifications and object storage —
    // all of which it imports itself.
    CorrespondenceModule,
    // Phase 51-HR-1: Human Resources (منبع انسانی) — the same composition-root rule as
    // Correspondence above: the HR module owns `hr_db`, its own client and its own
    // migrations, so registering it HERE (and not in CoreAppModule) is what keeps the
    // Core-only runtime free of HR tables, clients and routes.
    HrModule,
    // Phase C1: Commerce joins the COMBINED composition root under the same rule as
    // Correspondence and HR above — it owns `commerce_db`, its own client and its own
    // migrations, so registering it HERE (and not in CoreAppModule) is what keeps the
    // Core-only runtime free of Commerce tables, clients and routes. `architecture-
    // boundaries.spec.ts` derives the roots that may name it from the datasource
    // policy, so this line and the matrix cannot drift apart silently.
    CommerceModule,
    // Phase PRODUCTION-BOM-HEADER: Production joins the COMBINED composition root under the
    // same rule as Correspondence, HR and Commerce above — it owns `production_db`, its own
    // client and its own migrations, so registering it HERE (and not in CoreAppModule) is
    // what keeps the Core-only runtime free of Production tables, clients and routes.
    // `architecture-boundaries.spec.ts` derives the roots that may name it from the
    // datasource policy, so this line and the matrix cannot drift apart silently.
    ProductionModule,
    // Phase F1 — FINANCIAL FOUNDATION: Financial joins the COMBINED composition root
    // under the same rule as Correspondence, HR, Commerce and Production above — it owns
    // `finance_db`, its own client and its own migrations, so registering it HERE (and
    // not in CoreAppModule) is what keeps the Core-only runtime free of Financial tables,
    // clients and routes. `architecture-boundaries.spec.ts` derives the roots that may
    // name it from the datasource policy, so this line and the matrix cannot drift apart
    // silently.
    FinancialModule,
    InventoryModule,
    // Phase REPORTING-AI-CONSUMER: Reporting joins the COMBINED composition root under
    // the same rule as the bounded contexts above — and one of its own: it declares no
    // providers, controllers or datasource yet, because no Reporting domain contract
    // exists. What is registered here is the consumer seam (`PlatformAIModule` →
    // `AI_GATEWAY`), so the consumer module is a real part of the deployed graph rather
    // than a file no root imports. It never names a provider, a credential or a
    // configuration row — the AI platform runs those as it does for Search today.
    ReportingModule,
    // Phase KPI-RUNTIME: the five APPROVED KPIs, read through the three source-owned narrow
    // seams under each definition's own `readRemit`. Read-only, tenant-scoped, period-scoped
    // to a Jalali month — and composed only in the combined runtime, for the reason stated
    // where it is imported.
    KpiRuntimeModule,
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
    // Phase 54-C: the tenant context, established in the GUARD PHASE — between authentication
    // and authorization, so that every later guard-phase consumer (today:
    // `ModuleEntitlementGuard`, a controller guard) reads an answer instead of `undefined`.
    // Registered AFTER `JwtAuthGuard` because there is no verified principal to resolve from
    // before it, and BEFORE `RolesGuard` because the tenant is ambient request state, like the
    // principal itself, rather than a step in authorization.
    {
      provide: APP_GUARD,
      useClass: TenantContextGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ObservabilityInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware, RateLimitMiddleware).forRoutes('*');
  }
}
