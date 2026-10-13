import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { HrPrismaModule } from '../database/hr-prisma.module';
import { HrAuditGateway } from '../hr-audit.gateway';
import { LeaveRepository } from '../leave/leave.repository';
import { HrLeaveRequestReportingReaderService } from './hr-leave-reporting.reader';
import { HR_LEAVE_REQUEST_REPORTING_READER } from './hr-leave-reporting.contract';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the HR-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole HrModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON HrModule
 * -----------------------------------------------------
 * `HrModule` composes the FULL write surface: controllers, services, the identity
 * gateway, the notification gateway and the entitlement gate. Reporting importing it
 * would inherit that whole graph transitively — including `UserDirectoryModule` —
 * and every wiring spec would stub half the platform to boot a read.
 *
 * This module composes ONLY the read seam: the HR Prisma handle, the audit port
 * binding, the leave repository, the audit gateway, and the reader above them. The
 * write services, the controllers, the gateways' consumers and the entitlement stay
 * unreachable: importing this module cannot mount an HR route or issue a leave
 * request, by construction rather than by review. This is exactly what the
 * Financial, Commerce, Production and HR-attendance narrow reporting modules do for
 * their owners, and for the same reason.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `LeaveRepository` and `HrAuditGateway` are
 * provided, not exported, so a consumer of this module reaches HR persistence only
 * through the four typed reads the contract declares.
 */
@Module({
  imports: [HrPrismaModule, PlatformAuditModule],
  providers: [
    HrAuditGateway,
    LeaveRepository,
    HrLeaveRequestReportingReaderService,
    {
      provide: HR_LEAVE_REQUEST_REPORTING_READER,
      useExisting: HrLeaveRequestReportingReaderService,
    },
  ],
  exports: [HR_LEAVE_REQUEST_REPORTING_READER],
})
export class HrLeaveRequestReportingModule {}
