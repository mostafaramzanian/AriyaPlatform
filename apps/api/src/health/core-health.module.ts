import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { createHealthProviders } from './health.providers';
import { PrismaModule } from '../database/prisma.module';
import { ObservabilityPrismaModule } from '../database/observability-prisma.module';

/**
 * Phase ARCH-1.3: the health graph of the CORE runtime.
 *
 * `imports` lists exactly the Prisma modules of the datasources this runtime
 * INSTANTIATES, i.e. the non-`not-used` entries of `RUNTIME_DATASOURCE_MATRIX.core`:
 *
 *   CORE_DATABASE_URL           required → PrismaModule
 *   OBSERVABILITY_DATABASE_URL  optional → ObservabilityPrismaModule
 *   CMS_DATABASE_URL            not-used → not imported
 *   CORRESPONDENCE_DATABASE_URL not-used → not imported
 *   HR_DATABASE_URL             not-used → not imported (Phase 51-HR-1: HR exists, but it
 *                               is served by the COMBINED runtime; the Core-only process
 *                               never opens `hr_db`)
 *
 * `architecture-boundaries.spec.ts` recomputes that list from the policy and fails
 * if this module's `imports` disagrees, so a "not-used" datasource cannot creep
 * back into the Core health graph.
 *
 * The class name is not decoration: this is the Core runtime's health module, and
 * there is no other module named `HealthModule` (see `runtime-datasources.ts`,
 * `RUNTIME_HEALTH_COMPOSITION`).
 */
@Module({
  imports: [PrismaModule, ObservabilityPrismaModule],
  controllers: [HealthController],
  providers: createHealthProviders('core'),
  exports: [HealthService],
})
export class CoreHealthModule {}
