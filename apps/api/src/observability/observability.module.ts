import { Global, Module } from '@nestjs/common';
import { ObservabilityPrismaModule } from '../database/observability-prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { ObservabilityConfigService } from './observability.config';
import { ObservabilityWriter } from './observability.writer';
import { ObservabilityService } from './observability.service';
import { ObservabilityAuditService } from './observability-audit.service';
import { ObservabilityLifecycleService } from './observability-lifecycle.service';
import { ObservabilityRetentionService } from './observability-retention.service';

import { ObservabilityHealthService } from './observability-health.service';
import { ObservabilityReadService } from './observability-read.service';
import { ObservabilityController } from './observability.controller';

/**
 * Phase 49M-2: Core Observability / Logging / Audit platform.
 *
 * `@Global()`, AND IT IS THE ONLY MODULE IN THIS PHASE THAT IS. The reasoning is the inverse
 * of `ObservabilityPrismaModule`, which is deliberately NOT global: the narrow emit services
 * are meant to be injectable from anywhere — 49L integrations, 49M module platform, 49M-1
 * provisioning, auth, any future capability — and requiring every one of those modules to add
 * an import is how emission silently stops happening in the module that forgot. The Prisma
 * client stays non-global precisely so that ubiquitous availability applies to the SAFE
 * surface (redaction, message-code allowlist, drop policy) and never to raw table access.
 *
 * WHY EACH IMPORT IS HERE
 * -----------------------
 * ObservabilityPrismaModule — the third Prisma client, against observability_db. Not the Core
 *                             client: these tables live in a separate database, which is the
 *                             central decision of this phase (see the migration header).
 *
 * RbacModule                — supplies `RolesGuard`, which enforces the `@Roles(...)` gates on
 *                             `ObservabilityController`. Without it the read API would be
 *                             authenticated but not authorized, and these tables span every
 *                             tenant.
 *
 * NO PrismaModule IMPORT, and that absence is load-bearing: nothing in this phase reads or
 * writes core_db. `AuditService` keeps writing core_db."AuditLog" and
 * `/users/me/login-history` keeps reading it (§51 KEEP). If this module imported the Core
 * client, the two audit trails would become one thing that a future change could accidentally
 * couple — and the no-cross-database-FK rule in the schema would stop being self-evident.
 *
 * NO NotificationModule: a dropped DEBUG line notifies nobody. Alerting on log volume belongs
 * to whatever scrapes `/admin/observability/metrics`, not to the in-app notification centre,
 * which 49E built for human-addressed events.
 *
 * THE INTERCEPTOR IS NOT PROVIDED HERE. `ObservabilityInterceptor` is bound in
 * `core-app.module.ts` as an `APP_INTERCEPTOR`, because binding it here would make it apply
 * only to this module's own routes — the observability endpoints — which is the exact inverse
 * of the intent.
 */
@Global()
@Module({
  imports: [ObservabilityPrismaModule, RbacModule],
  controllers: [ObservabilityController],
  providers: [
    ObservabilityConfigService,
    ObservabilityWriter,
    ObservabilityService,
    ObservabilityAuditService,
    ObservabilityLifecycleService,
    ObservabilityRetentionService,
    ObservabilityHealthService,
    ObservabilityReadService,
  ],
  // The writer is exported for tests and for the shutdown path; the retention and read
  // services are not, because nothing outside this module has any business pruning or
  // querying the tables directly.
  exports: [
    ObservabilityService,
    ObservabilityAuditService,
    ObservabilityLifecycleService,
    ObservabilityHealthService,
    ObservabilityConfigService,
    ObservabilityWriter,
  ],
})
export class ObservabilityModule {}
