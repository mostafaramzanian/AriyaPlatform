import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { ProductionAuditGateway } from '../production-audit.gateway';
import { ProductionPrismaModule } from '../database/production-prisma.module';
import { BomHeaderRepository } from '../bom/bom.repository';
import { ProductionReportingReaderService } from './production-reporting.reader';
import { PRODUCTION_REPORTING_READER } from './production-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Production-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole ProductionModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON ProductionModule
 * ------------------------------------------------------------
 * `ProductionModule` composes the FULL write surface: three controllers, the header /
 * item / change-request services, the identity gateway and the audit writer. Reporting
 * importing it would inherit that whole graph transitively — including
 * `UserDirectoryModule` — and every wiring spec would stub half the platform to boot a
 * read.
 *
 * This module composes ONLY the read seam: the Production Prisma handle, the audit port
 * binding, the header repository, the audit gateway, and the reader above them. The
 * write services, the controllers, the identity contract and the entitlement stay
 * unreachable: importing this module cannot mount a Production route or issue a
 * Production write, by construction rather than by review. This is exactly what
 * `commerce-purchase-reporting.module.ts` and
 * `financial-check-request-reporting.module.ts` do for their owners, and for the same
 * reason — the precedent's reasoning did not depend on which context it was applied to.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `BomHeaderRepository` and
 * `ProductionAuditGateway` are provided, not exported, so a consumer of this module
 * reaches Production persistence only through the four typed reads the contract declares.
 */
@Module({
  imports: [ProductionPrismaModule, PlatformAuditModule],
  providers: [
    ProductionAuditGateway,
    BomHeaderRepository,
    ProductionReportingReaderService,
    {
      provide: PRODUCTION_REPORTING_READER,
      useExisting: ProductionReportingReaderService,
    },
  ],
  exports: [PRODUCTION_REPORTING_READER],
})
export class ProductionReportingModule {}
