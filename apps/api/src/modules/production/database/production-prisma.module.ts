import { Module } from '@nestjs/common';
import { ProductionPrismaService } from './production-prisma.service';
import { PRODUCTION_PRISMA_CLIENT } from '../../../health/health-tokens';

/**
 * Phase PRODUCTION-BOM-HEADER: the Production module's own database connection.
 *
 * Mirrors `CommercePrismaModule` (Phase C1), `HrPrismaModule` (51-HR-1),
 * `CorrespondencePrismaModule` (50-MOD-CORR) and `CmsPrismaModule` (33J) exactly.
 * Production owns `production_db` through `PRODUCTION_DATABASE_URL` and its own generated
 * client; Core's `PrismaModule`, HR's `HrPrismaModule`, Commerce's `CommercePrismaModule`
 * and Correspondence's module are never imported by this module or by anything under
 * `src/modules/production/**`, which the architecture boundary spec and this module's
 * isolation suite assert.
 *
 * BINDING `PRODUCTION_PRISMA_CLIENT` IS WHAT ACTIVATES THE PRODUCTION PROBE. In
 * `datasource-probe.registry.ts` the Production datasource is declared with a probe
 * definition; this module is the first and only provider of that token, and composing it
 * into the combined health graph is what makes `production_db` reachable at all.
 */
@Module({
  providers: [
    ProductionPrismaService,
    { provide: PRODUCTION_PRISMA_CLIENT, useExisting: ProductionPrismaService },
  ],
  exports: [ProductionPrismaService, PRODUCTION_PRISMA_CLIENT],
})
export class ProductionPrismaModule {}