import { Module } from '@nestjs/common';
import { CommercePrismaModule } from '../database/commerce-prisma.module';
import { ReceivingHistoryRepository } from '../receiving/receiving-history.repository';
import { CommerceReceivingReportingReaderService } from './commerce-receiving-reporting.reader';
import { COMMERCE_RECEIVING_REPORTING_READER } from './commerce-receiving-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Commerce-owned READ MODULE — the
 * narrow composition Reporting imports instead of the whole CommerceModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON CommerceModule: `CommerceModule`
 * composes the FULL write surface (the receiving append/compensate pair included);
 * Reporting importing it would inherit that whole graph transitively. This module
 * composes ONLY the read seam: the Commerce Prisma handle, the receiving repository,
 * and the reader above them. No audit binding (this report has NO timeline — the
 * contract's grain ruling), no write services, no controllers, no entitlement gate:
 * importing this module cannot mount a Commerce route or append a receipt, by
 * construction rather than by review — the exact reasoning the purchase, payment
 * and return narrow reporting modules state.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `ReceivingHistoryRepository` is provided,
 * not exported, so a consumer of this module reaches Commerce persistence only
 * through the three typed reads the contract declares.
 */
@Module({
  imports: [CommercePrismaModule],
  providers: [
    ReceivingHistoryRepository,
    CommerceReceivingReportingReaderService,
    {
      provide: COMMERCE_RECEIVING_REPORTING_READER,
      useExisting: CommerceReceivingReportingReaderService,
    },
  ],
  exports: [COMMERCE_RECEIVING_REPORTING_READER],
})
export class CommerceReceivingReportingModule {}
