import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { createHealthProviders } from './health.providers';
import { PrismaModule } from '../database/prisma.module';
import { CmsPrismaModule } from '../database/cms-prisma.module';
import { ObservabilityPrismaModule } from '../database/observability-prisma.module';
import { CorrespondencePrismaModule } from '../modules/correspondence/database/correspondence-prisma.module';
import { HrPrismaModule } from '../modules/hr/database/hr-prisma.module';
import { CommercePrismaModule } from '../modules/commerce/database/commerce-prisma.module';
import { ProductionPrismaModule } from '../modules/production/database/production-prisma.module';
import { FinancialPrismaModule } from '../modules/financial/database/financial-prisma.module';
import { InventoryPrismaModule } from '../modules/inventory/database/inventory-prisma.module';
import { TokenAuthModule } from '../platform/auth/token-auth.module';

/**
 * Phase ARCH-1.3: the health graph of the COMBINED runtime — the class that used
 * to be called `HealthModule`.
 *
 * The rename is the fix. Previously `health/health.module.ts` exported a class
 * named `HealthModule` that carried the COMBINED runtime's policy, while
 * `CoreHealthModule` and `CmsHealthModule` existed next to it for the other two
 * runtimes. Nothing in the name said which runtime a `HealthModule` import meant,
 * so the answer lived only in a `{ provide: 'RUNTIME_ID', useValue: 'combined' }`
 * literal inside the file. The name is now the runtime.
 *
 * `imports` lists exactly the Prisma modules of the datasources this runtime
 * INSTANTIATES, i.e. the non-`not-used` entries of `RUNTIME_DATASOURCE_MATRIX.combined`:
 *
 *   CORE_DATABASE_URL           required → PrismaModule
 *   CMS_DATABASE_URL            required → CmsPrismaModule
 *   CORRESPONDENCE_DATABASE_URL required → CorrespondencePrismaModule
 *   OBSERVABILITY_DATABASE_URL  optional → ObservabilityPrismaModule
 *   HR_DATABASE_URL             required → HrPrismaModule
 *   COMMERCE_DATABASE_URL       required → CommercePrismaModule
 *   PRODUCTION_DATABASE_URL     required → ProductionPrismaModule
 *
 * HR became `required` here in Phase 51-HR-1, when `AppModule` started importing
 * `HrModule`: the combined process now opens a connection to `hr_db`, so readiness has
 * to depend on it. The Core-only and CMS-only runtimes still mark HR `not-used` and
 * still import nothing for it (see `core-health.module.ts`, `cms-health.module.ts`).
 *
 * Commerce became `required` here in Phase C1 step F, when this graph started importing
 * `CommercePrismaModule`: that module binds the Commerce client token, so the combined
 * process now opens a connection to `commerce_db`, and readiness has to depend on it —
 * exactly HR's move, in exactly the same place. The Core-only and CMS-only runtimes
 * still mark Commerce `not-used` and still import nothing for it.
 *
 * Compiled-in is not the same as required: the observability client is present and
 * probed, but the evaluator only blocks readiness on `required` failures, so an
 * unreachable observability database degrades observability without taking the
 * combined runtime out of rotation.
 */
@Module({
  imports: [
    PrismaModule,
    CmsPrismaModule,
    ObservabilityPrismaModule,
    CorrespondencePrismaModule,
    HrPrismaModule,
    CommercePrismaModule,
    // Phase PRODUCTION-BOM-HEADER: Production became `required` here when this graph
    // started importing `ProductionPrismaModule`: that module binds the Production client
    // token, so the combined process now opens a connection to `production_db` and
    // readiness has to depend on it — exactly Commerce's move, in exactly the same place.
    // The Core-only, CMS-only and future-hr runtimes still mark Production `not-used` and
    // still import nothing for it.
    ProductionPrismaModule,
    // Phase F1 — FINANCIAL FOUNDATION: Financial became `required` here when this graph
    // started importing `FinancialPrismaModule`: that module binds the Finance client
    // token, so the combined process now opens a connection to `finance_db` and readiness
    // has to depend on it — exactly Production's move, in exactly the same place. The
    // Core-only, CMS-only and future-hr runtimes still mark Financial `not-used` and
    // still import nothing for it.
    FinancialPrismaModule,
    // Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: the combined runtime hosts the
    // Inventory module, so this graph imports its Prisma module and `inventory_db`
    // joins the required set.
    InventoryPrismaModule,
    // PHASE W3 (P4): binds the token seam so `RevocationFeedProbe` can read the
    // REAL registry posture — without this the probe could only report
    // `not-configured` even while revocation is wired and healthy.
    TokenAuthModule,
  ],
  controllers: [HealthController],
  providers: createHealthProviders('combined'),
  exports: [HealthService],
})
export class CombinedHealthModule {}
