import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { HrPrismaModule } from '../database/hr-prisma.module';
import { HrAuditGateway } from '../hr-audit.gateway';
import { AttendanceRepository } from '../attendance/attendance.repository';
import { HrPersonnelTrafficReportingReaderService } from './hr-personnel-traffic-reporting.reader';
import { HR_PERSONNEL_TRAFFIC_REPORTING_READER } from './hr-personnel-traffic-reporting.contract';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the HR-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole HrModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON HrModule
 * -----------------------------------------------------
 * `HrModule` composes the FULL write surface: eight controllers, twelve services, the
 * identity gateway, the notification gateway and the entitlement gate. Reporting
 * importing it would inherit that whole graph transitively — including
 * `UserDirectoryModule` — and every wiring spec would stub half the platform to boot a
 * read.
 *
 * This module composes ONLY the read seam: the HR Prisma handle, the audit port
 * binding, the attendance repository, the audit gateway, and the reader above them. The
 * write services, the controllers, the gateways' consumers and the entitlement stay
 * unreachable: importing this module cannot mount an HR route or issue an HR punch, by
 * construction rather than by review. This is exactly what the Financial, Commerce and
 * Production narrow reporting modules do for their owners, and for the same reason — the
 * precedent's reasoning did not depend on which context it was applied to.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `AttendanceRepository` and `HrAuditGateway` are
 * provided, not exported, so a consumer of this module reaches HR persistence only
 * through the four typed reads the contract declares.
 */
@Module({
  imports: [HrPrismaModule, PlatformAuditModule],
  providers: [
    HrAuditGateway,
    AttendanceRepository,
    HrPersonnelTrafficReportingReaderService,
    {
      provide: HR_PERSONNEL_TRAFFIC_REPORTING_READER,
      useExisting: HrPersonnelTrafficReportingReaderService,
    },
  ],
  exports: [HR_PERSONNEL_TRAFFIC_REPORTING_READER],
})
export class HrPersonnelTrafficReportingModule {}
