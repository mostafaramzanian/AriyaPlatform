/**
 * Phase KPI-RUNTIME — the KPI bounded context's composition root.
 *
 * WHAT THIS CONTEXT OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------
 * It owns the read-only KPI routes, the runtime service, the structural evaluator and the
 * result contract. It owns NO datasource, NO Prisma client, NO schema, NO migration, NO
 * write, NO permission and NO scheduler: there is no `prisma/kpi-runtime` and no
 * `KPI_RUNTIME_DATABASE_URL`, and `architecture-boundaries.spec.ts` discovers independent
 * modules from a `prisma/<name>/schema.prisma` pairing — which this directory deliberately
 * does not have.
 *
 * THE THREE IMPORTS ARE THE WHOLE SURFACE, AND EACH IS THE APPROVED ONE:
 *
 *  * `ProductionReportingModule` / `CommercePurchaseReportingModule` /
 *    `FinancialCheckRequestReportingModule` — the SOURCE-OWNED narrow read modules, the same
 *    three `ReportingModule` composes. Each exports exactly ONE reader token and nothing
 *    else, so reaching a repository, a service, a controller or a Prisma client through this
 *    module is impossible by construction rather than by review. They are named HERE for the
 *    same reason Reporting names them: the seam is where the dependency is declared.
 *  * `PlatformEntitlementModule` — the `ENTITLEMENT_PORT`, a Core-owned question this context
 *    must not answer itself.
 *  * `RbacModule` — exports `PermissionSource`, the same port the global `RolesGuard`
 *    consults, so there is one permission authority for `production.bom.read` and no second
 *    implementation of the catalogue. This is exactly what `CommerceModule` does for its own
 *    search-source authorization and what `HrModule` does for its `hr.*` gates.
 *
 * REGISTERED IN THE COMBINED ROOT ONLY. It reads Production, Commerce and Financial tables
 * through their seams, so the Core-only and CMS-only runtimes must not name it — the same
 * rule Correspondence, HR, Commerce, Production, Financial and Reporting already follow.
 */

import { Module } from '@nestjs/common';
import { RbacModule } from '../../auth/rbac/rbac.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { CommercePurchaseReportingModule } from '../commerce/reporting/commerce-purchase-reporting.module';
import { FinancialCheckRequestReportingModule } from '../financial/reporting/financial-check-request-reporting.module';
import { ProductionReportingModule } from '../production/reporting/production-reporting.module';
import { KpiRuntimeController } from './kpi-runtime.controller';
import { KpiRuntimeService } from './kpi-runtime.service';

@Module({
  imports: [
    ProductionReportingModule,
    CommercePurchaseReportingModule,
    FinancialCheckRequestReportingModule,
    PlatformEntitlementModule,
    RbacModule,
  ],
  controllers: [KpiRuntimeController],
  providers: [KpiRuntimeService],
})
export class KpiRuntimeModule {}
