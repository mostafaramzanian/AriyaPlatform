import { Module } from '@nestjs/common';
import { FinancialPrismaService } from './financial-prisma.service';
import { FINANCE_PRISMA_CLIENT } from '../../../health/health-tokens';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial module's own database connection.
 *
 * Mirrors `ProductionPrismaModule`, `CommercePrismaModule` (Phase C1), `HrPrismaModule`
 * (51-HR-1), `CorrespondencePrismaModule` (50-MOD-CORR) and `CmsPrismaModule` (33J)
 * exactly. Financial owns `finance_db` through `FINANCE_DATABASE_URL` and its own
 * generated client; Core's `PrismaModule`, HR's, Commerce's, Correspondence's and
 * Production's modules are never imported by this module or by anything under
 * `src/modules/financial/**`, which the architecture boundary spec and this module's
 * isolation suite assert.
 *
 * BINDING `FINANCE_PRISMA_CLIENT` IS WHAT ACTIVATES THE FINANCE PROBE. In
 * `datasource-probe.registry.ts` the Finance datasource is declared with a probe
 * definition; this module is the first and only provider of that token, and composing it
 * into the combined health graph is what makes `finance_db` reachable at all.
 */
@Module({
  providers: [
    FinancialPrismaService,
    { provide: FINANCE_PRISMA_CLIENT, useExisting: FinancialPrismaService },
  ],
  exports: [FinancialPrismaService, FINANCE_PRISMA_CLIENT],
})
export class FinancialPrismaModule {}
