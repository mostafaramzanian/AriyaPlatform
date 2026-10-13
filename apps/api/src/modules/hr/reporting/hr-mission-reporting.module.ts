import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../../platform/audit/platform-audit.module';
import { HrPrismaModule } from '../database/hr-prisma.module';
import { HrAuditGateway } from '../hr-audit.gateway';
import { MissionRepository } from '../mission/mission.repository';
import { HrMissionRequestReportingReaderService } from './hr-mission-reporting.reader';
import { HR_MISSION_REQUEST_REPORTING_READER } from './hr-mission-reporting.contract';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the HR-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole HrModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON HrModule
 * -----------------------------------------------------
 * `HrModule` composes the FULL write surface: controllers, services, the identity and
 * notification gateways and the entitlement gate. Reporting importing it would inherit
 * that whole graph transitively, and every wiring spec would stub half the platform to
 * boot a read. This module composes ONLY the read seam: the HR Prisma handle, the
 * audit port binding, the mission repository, the audit gateway, and the reader above
 * them. The write services and the controllers stay unreachable: importing this module
 * cannot mount an HR route or submit a mission request, by construction rather than by
 * review — the same reasoning the six sibling narrow reporting modules state.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `MissionRepository` and `HrAuditGateway` are
 * provided, not exported, so a consumer of this module reaches HR persistence only
 * through the four typed reads the contract declares.
 */
@Module({
  imports: [HrPrismaModule, PlatformAuditModule],
  providers: [
    HrAuditGateway,
    MissionRepository,
    HrMissionRequestReportingReaderService,
    {
      provide: HR_MISSION_REQUEST_REPORTING_READER,
      useExisting: HrMissionRequestReportingReaderService,
    },
  ],
  exports: [HR_MISSION_REQUEST_REPORTING_READER],
})
export class HrMissionRequestReportingModule {}
