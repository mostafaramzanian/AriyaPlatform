import { Module } from '@nestjs/common';
import { HrPrismaService } from './hr-prisma.service';
import { HR_PRISMA_CLIENT } from '../../../health/health-tokens';

/**
 * Phase 51-HR-1: the HR module's own database connection.
 *
 * Mirrors `CorrespondencePrismaModule` (50-MOD-CORR) and `CmsPrismaModule` (33J)
 * exactly. HR owns `hr_db` through `HR_DATABASE_URL` and its own generated client;
 * Core's `PrismaModule` is never imported by this module or by anything under
 * `src/modules/hr/**`, which the architecture boundary spec asserts.
 *
 * BINDING `HR_PRISMA_CLIENT` IS WHAT ACTIVATES THE HR PROBE. In
 * `datasource-probe.registry.ts` the HR datasource has been declared since ARCH-2
 * with a probe definition whose client token had no provider anywhere, so the probe
 * failed CLOSED. This module is the first and only provider of that token, which is
 * why `future-hr` can now report itself ready.
 */
@Module({
  providers: [HrPrismaService, { provide: HR_PRISMA_CLIENT, useExisting: HrPrismaService }],
  exports: [HrPrismaService, HR_PRISMA_CLIENT],
})
export class HrPrismaModule {}
