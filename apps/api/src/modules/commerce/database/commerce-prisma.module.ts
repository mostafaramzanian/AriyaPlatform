import { Module } from '@nestjs/common';
import { CommercePrismaService } from './commerce-prisma.service';
import { COMMERCE_PRISMA_CLIENT } from '../../../health/health-tokens';

/**
 * Phase C1: the Commerce module's own database connection.
 *
 * Mirrors `HrPrismaModule` (51-HR-1), `CorrespondencePrismaModule` (50-MOD-CORR)
 * and `CmsPrismaModule` (33J) exactly. Commerce owns `commerce_db` through
 * `COMMERCE_DATABASE_URL` and its own generated client; Core's `PrismaModule` and
 * HR's `HrPrismaModule` are never imported by this module or by anything under
 * `src/modules/commerce/**`, which the architecture boundary spec and the
 * Commerce isolation suite assert.
 *
 * BINDING `COMMERCE_PRISMA_CLIENT` IS WHAT ACTIVATES THE COMMERCE PROBE. In
 * `datasource-probe.registry.ts` the Commerce datasource has been declared since
 * Phase C1 step A with a probe definition whose client token had no provider
 * anywhere, so the probe fails CLOSED — and every runtime marks Commerce
 * `not-used`, so no runtime even asks. This module is the first and only provider
 * of that token; composing it into the combined health graph (step F) is what makes
 * `commerce_db` reachable at all.
 */
@Module({
  providers: [
    CommercePrismaService,
    { provide: COMMERCE_PRISMA_CLIENT, useExisting: CommercePrismaService },
  ],
  exports: [CommercePrismaService, COMMERCE_PRISMA_CLIENT],
})
export class CommercePrismaModule {}
