import { Module } from '@nestjs/common';
import { FinancialPrismaModule } from '../database/financial-prisma.module';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { FinancialAuditGateway } from '../financial-audit.gateway';
import { CheckRequestRepository } from '../check-request/check-request.repository';
import { FinancialCheckRequestReportingReaderService } from './financial-check-request-reporting.reader';
import { FINANCIAL_CHECK_REQUEST_REPORTING_READER } from './financial-check-request-reporting.contract';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Financial-owned READ MODULE — the
 * narrow composition Reporting imports instead of the whole FinancialModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON FinancialModule
 * ------------------------------------------------------------
 * FinancialModule composes the FULL write surface: two controllers, two
 * services, attachment storage, entitlement, identity. Reporting importing it
 * would inherit that whole graph transitively — including `StorageModule`
 * (MinIO) and `UserDirectoryModule` (Core Prisma) — and every wiring spec
 * would stub half the platform to boot a read. This module composes ONLY the
 * read seam: the Financial Prisma handle, the audit port binding, the request
 * repository, the audit gateway, and the reader above them. The write
 * services, the controllers, storage, entitlement and identity stay
 * unreachable: importing this module cannot mount a Financial route or issue
 * a Financial write, by construction rather than by review.
 */
@Module({
  imports: [FinancialPrismaModule, PlatformAuditModule],
  providers: [
    FinancialAuditGateway,
    CheckRequestRepository,
    FinancialCheckRequestReportingReaderService,
    {
      provide: FINANCIAL_CHECK_REQUEST_REPORTING_READER,
      useExisting: FinancialCheckRequestReportingReaderService,
    },
  ],
  exports: [FINANCIAL_CHECK_REQUEST_REPORTING_READER],
})
export class FinancialCheckRequestReportingModule {}
