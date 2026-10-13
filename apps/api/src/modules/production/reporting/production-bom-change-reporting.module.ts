import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { ProductionAuditGateway } from '../production-audit.gateway';
import { ProductionPrismaModule } from '../database/production-prisma.module';
import { BomChangeRequestRepository } from '../bom-change/bom-change.repository';
import { ProductionBomChangeReportingReaderService } from './production-bom-change-reporting.reader';
import { PRODUCTION_BOM_CHANGE_REPORTING_READER } from './production-bom-change-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Production-owned READ MODULE for the
 * change-request report — the narrow composition Reporting imports INSTEAD of extending
 * `production-reporting.module.ts`.
 *
 * WHY A SECOND NARROW MODULE RATHER THAN A SECOND TOKEN ON THE FIRST
 * ------------------------------------------------------------------
 * The header module composes the header's OWN readers over `BomHeaderRepository` and is
 * consumed today by TWO surfaces — the production report controller/service and the KPI
 * runtime cohort reads. Widening its exports with a change-request token would hand one
 * module two aggregates, two query vocabularies and two audit resources, and would put a
 * KPI-facing module on the import path of a report it does not answer. Each narrow module
 * in this repository composes ONE aggregate's reads for ONE report — that is what
 * `commerce-purchase-reporting.module.ts`, `financial-check-request-reporting.module.ts`
 * and `hr-personnel-traffic-reporting.module.ts` each do — and this file applies the same
 * rule to the second Production aggregate. The existing module's surface is untouched,
 * and no isolation or boundary guard is weakened.
 *
 * WHAT IT COMPOSES, AND WHAT STAYS UNREACHABLE
 * --------------------------------------------
 * Exactly what the header module composes, for the same reason: the Production Prisma
 * handle, the audit port binding, the change-request repository, the audit gateway, and
 * the reader above them. The write services, the controllers, the identity contract and
 * the entitlement stay unreachable: importing this module cannot mount a Production
 * route or issue a Production write, by construction rather than by review.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `BomChangeRequestRepository` and
 * `ProductionAuditGateway` are provided, not exported, so a consumer of this module
 * reaches Production persistence only through the four typed reads the contract declares.
 */
@Module({
  imports: [ProductionPrismaModule, PlatformAuditModule],
  providers: [
    ProductionAuditGateway,
    BomChangeRequestRepository,
    ProductionBomChangeReportingReaderService,
    {
      provide: PRODUCTION_BOM_CHANGE_REPORTING_READER,
      useExisting: ProductionBomChangeReportingReaderService,
    },
  ],
  exports: [PRODUCTION_BOM_CHANGE_REPORTING_READER],
})
export class ProductionBomChangeReportingModule {}
