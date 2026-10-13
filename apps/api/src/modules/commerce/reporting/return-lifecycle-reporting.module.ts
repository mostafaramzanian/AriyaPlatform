import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommercePrismaModule } from '../database/commerce-prisma.module';
import { ReturnHistoryRepository } from '../returns/return-history.repository';
import { CommerceReturnLifecycleReportingReaderService } from './return-lifecycle-reporting.reader';
import { COMMERCE_RETURN_LIFECYCLE_REPORTING_READER } from './return-lifecycle-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Commerce-owned READ MODULE — the
 * narrow composition Reporting imports instead of the whole CommerceModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON CommerceModule: `CommerceModule`
 * composes the FULL write surface (the return's four lifecycle commands, the locked
 * quantity invariant, the payment compensation call, ten controllers, the workflow
 * executor); Reporting importing it would inherit that whole graph transitively.
 * This module composes ONLY the read seam: the Commerce Prisma handle, the audit port
 * binding (the timeline read), the return repository, the audit gateway, and the
 * reader above them — the exact composition `commerce-purchase-reporting.module.ts`
 * states, for the same reason: this report HAS a timeline, because return audit is
 * bound to the return row by grain.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `ReturnHistoryRepository` and
 * `CommerceAuditGateway` are provided, not exported, so a consumer of this module
 * reaches Commerce persistence only through the four typed reads the contract
 * declares: no controllers, no write services, no entitlement gate — importing this
 * module cannot mount a Commerce route or append a return, by construction rather
 * than by review.
 */
@Module({
  imports: [CommercePrismaModule, PlatformAuditModule],
  providers: [
    CommerceAuditGateway,
    ReturnHistoryRepository,
    CommerceReturnLifecycleReportingReaderService,
    {
      provide: COMMERCE_RETURN_LIFECYCLE_REPORTING_READER,
      useExisting: CommerceReturnLifecycleReportingReaderService,
    },
  ],
  exports: [COMMERCE_RETURN_LIFECYCLE_REPORTING_READER],
})
export class CommerceReturnLifecycleReportingModule {}
