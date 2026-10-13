import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommercePrismaModule } from '../database/commerce-prisma.module';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { CommercePurchaseReportingReaderService } from './commerce-purchase-reporting.reader';
import { COMMERCE_PURCHASE_REPORTING_READER } from './commerce-purchase-reporting.contract';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Commerce-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole CommerceModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON CommerceModule
 * ----------------------------------------------------------
 * `CommerceModule` composes the FULL write surface: ten controllers, eighteen services,
 * the workflow executor, the commercial lifecycle, notifications, the search projection
 * and the identity gateway. Reporting importing it would inherit that whole graph
 * transitively — including `UserDirectoryModule` and `PlatformSearchSourceModule` — and
 * every wiring spec would stub half the platform to boot a read.
 *
 * This module composes ONLY the read seam: the Commerce Prisma handle, the audit port
 * binding, the document repository, the audit gateway, and the reader above them. The
 * write services, the controllers, the gateways' consumers, notification, search and
 * entitlement stay unreachable: importing this module cannot mount a Commerce route or
 * issue a Commerce write, by construction rather than by review. This is exactly what
 * `financial-check-request-reporting.module.ts` does for Financial, and for the same
 * reason — the precedent's reasoning did not depend on which context it was applied to.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `PurchaseRepository` and `CommerceAuditGateway`
 * are provided, not exported, so a consumer of this module reaches Commerce persistence
 * only through the four typed reads the contract declares.
 */
@Module({
  imports: [CommercePrismaModule, PlatformAuditModule],
  providers: [
    CommerceAuditGateway,
    PurchaseRepository,
    CommercePurchaseReportingReaderService,
    {
      provide: COMMERCE_PURCHASE_REPORTING_READER,
      useExisting: CommercePurchaseReportingReaderService,
    },
  ],
  exports: [COMMERCE_PURCHASE_REPORTING_READER],
})
export class CommercePurchaseReportingModule {}
