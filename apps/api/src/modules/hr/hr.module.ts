import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../platform/audit/platform-audit.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { UserDirectoryModule } from '../../platform/user-directory/user-directory.module';
import { NotificationModule } from '../../notifications/notification.module';
import { PureRuleEngineModule } from '../../rules/pure-rule-engine.module';
import { HrPrismaModule } from './database/hr-prisma.module';
import { HrIdentityGateway } from './hr-identity.gateway';
import { HrAuditGateway } from './hr-audit.gateway';
import { HrNotificationGateway } from './hr-notification.gateway';
import { OrganizationRepository } from './organization/organization.repository';
import { OrganizationService } from './organization/organization.service';
import { OrganizationController } from './organization/organization.controller';
import { PositionRepository } from './positions/positions.repository';
import { PositionsService } from './positions/positions.service';
import { PositionsController } from './positions/positions.controller';
import { EmploymentRepository } from './employment/employment.repository';
import { EmploymentService } from './employment/employment.service';
import { EmployeeRepository } from './employees/employees.repository';
import { EmployeesService } from './employees/employees.service';
import { EmployeesController } from './employees/employees.controller';
import { AttendanceRepository } from './attendance/attendance.repository';
import { AttendanceService } from './attendance/attendance.service';
import { AttendanceController } from './attendance/attendance.controller';
import { LeaveRepository } from './leave/leave.repository';
import { LeaveApprovalRepository } from './leave/leave-approval.repository';
import { LeaveService } from './leave/leave.service';
import { LeaveApprovalService } from './leave/leave-approval.service';
import { LeaveRequestsController } from './leave/leave-requests.controller';
import { LeaveTypesController } from './leave/leave-types.controller';
import { LeavePoliciesController } from './leave-policy/leave-policies.controller';
import { LeavePolicyRepository } from './leave-policy/leave-policy.repository';
import { LeavePolicyService } from './leave-policy/leave-policy.service';
import { MissionRepository } from './mission/mission.repository';
import { MissionApprovalRepository } from './mission/mission-approval.repository';
import { MissionPolicyRepository } from './mission/mission-policy.repository';
import { MissionService } from './mission/mission.service';
import { MissionApprovalService } from './mission/mission-approval.service';
import { MissionPolicyService } from './mission/mission-policy.service';
import { MissionController } from './mission/mission.controller';
import { LeavePolicySimulationService } from './leave-policy/leave-policy-simulation.service';
import { HrAuditOutboxRelayService } from './hr-audit-outbox-relay.service';

/**
 * Phase 51-HR-1: Human Resources — منبع انسانی — as an INDEPENDENT business module.
 *
 * WHAT "INDEPENDENT" MEANS HERE, CONCRETELY
 * ----------------------------------------
 * HR owns `hr_db` through `HR_DATABASE_URL`, its own Prisma project
 * (`prisma/hr/schema.prisma`), its own generated client (`src/generated/hr-client`), its
 * own migration history (`prisma/hr/migrations`, including raw SQL that Prisma cannot
 * express) and its own data-access layer. There is NO foreign key between `hr_db` and
 * `core_db`, and there cannot be: PostgreSQL does not express one across databases, which
 * is exactly why the employee lifecycle and the Core user lifecycle are independent.
 *
 * Precedent for every mechanism here: `src/modules/correspondence/**` (50-MOD-CORR) for
 * the module namespace, the owned client and the tenancy discipline, and
 * `src/modules/cms/**` (33J) for the module namespace itself.
 *
 * DEPENDENCIES, each for a concrete reason and none "for symmetry"
 * --------------------------------------------------------------
 *  - `HrPrismaModule`: the module's OWN database. Core's `PrismaModule` is deliberately
 *    ABSENT — the architecture boundary spec fails the build if it appears.
 *  - `UserDirectoryModule`: the platform PORT for identity. HR has exactly two real needs
 *    it cannot answer itself — "is this id a member of my tenant?" before linking an
 *    employee to a login, and "what is this person called?" when rendering a row. It
 *    receives an ALLOWLISTED person projection and never Core's client or Core's schema.
 *  - `PlatformAuditModule` (Phase ARCH-3B): supplies the `platform.audit@v1` port, through
 *    which every HR mutation is written to the ONE platform audit trail in
 *    `core_db."AuditLog"`. HR does not keep a second trail, because two trails make "who did
 *    what, when" unanswerable. Before this phase that dependency arrived as a side effect of
 *    importing `RbacModule` — the module whose real purpose is permission gating — which made
 *    HR depend on Core's authorization model in order to write one row (ARCH-3B §17).
 *  - `PlatformEntitlementModule` (Phase 54-C, §43.6): exports the `ENTITLEMENT_PORT` token that
 *    `ModuleEntitlementGuard` injects, and NOTHING else — `PlatformEntitlementService` stays
 *    private to the platform, so importing this module is not a way for HR to ask the
 *    entitlement question for itself. `ModuleEntitlementGuard` is provided HERE because Nest
 *    instantiates a guard in the module that declares it, and the token is what that
 *    instantiation resolves against. The HR controllers declare the REQUIREMENT
 *    (`@RequiresModule` / `@RequiresFeature`) and never the decision: no HR gateway, service,
 *    repository or table is added for entitlement, and `hr-isolation.spec.ts` fails the build
 *    if an entitlement import appears anywhere in this module except a controller or this file.
 *
 * `RbacModule` IS DELIBERATELY GONE FROM THIS LIST. HR's controllers declare `@Roles(...)` and
 * are enforced by the globally registered `RolesGuard`, which the ROOT modules install
 * (`AppModule`, `CoreAppModule`); importing `RbacModule` here was never what made the guard run,
 * and keeping it would keep the coupling §17 removes.
 *
 * ONE TIMER, NO QUEUE, NO STORAGE. Phase B2.5 adds `HrAuditOutboxRelayService`, which polls
 * the HR-local `AuditOutbox` every 10 s and delivers durable-required audit events through
 * `AUDIT_PORT`. This is the ONE scheduled mechanism the module contains, and it is
 * infrastructure — not business logic — so the timer is an explicit exception to the
 * "no asynchronous work" rule 51-HR-1 originally established. Nothing else here is
 * time-triggered and nothing uploads a file.
 *
 * PERSISTENCE IS ITS OWN LAYER (51-HR-ARCH-1). Exactly one `<aggregate>.repository.ts` file
 * per aggregate issues Prisma statements — `EmployeeRepository`, `EmploymentRepository`,
 * `OrganizationRepository`, `PositionRepository`, `AttendanceRepository`, `LeaveRepository`
 * (which covers the leave request AND its type catalogue, because the composite
 * `(tenant_id, leave_type_id)` foreign key makes the two one fact about one tenant) and, from
 * Phase 54-E, `LeaveApprovalRepository` (the flow CONFIGURATION and its RUNTIME — a different
 * aggregate from the request, with its own lifecycle, §18) — and no
 * service injects the client. The
 * repositories are PROVIDED and NOT EXPORTED, deliberately: nothing outside this module has
 * any business issuing a query against `hr_db`, and the services above them are the module's
 * published surface. The tenant is the first parameter of every repository method, so "which
 * rows can this call see?" is answered by a signature rather than inferred from an ambient
 * actor; `hr-isolation.spec.ts` fails the build if a `.service.ts` issues a statement again.
 *
 * INTRODUCES TWELVE PERMISSIONS, granted to SUPER_ADMIN and ADMIN, and seeded in `core_db`
 * by four companion Core migrations:
 *   hr.employees.read / hr.employees.manage
 *   hr.organization.read / hr.organization.manage
 *   hr.positions.read / hr.positions.manage
 *   hr.attendance.read / hr.attendance.manage   (Phase 51-HR-3)
 *   hr.leave.read / hr.leave.manage             (Phase 51-HR-3A)
 *   hr.leave.approve                            (Phase 54-E)
 *
 * `hr.leave.approve` IS THE ONE PERMISSION IN THIS MODULE THAT IS NOT A READ/MANAGE PAIR, and the
 * asymmetry is the point. It was previously absent here, with the note that it would claim
 * "approve/reject FOR THE REPORTING SUBTREE" — a traversal that did not exist — so granting it
 * would have been a lie. Phase 54-E supplies the rule that makes the authority answerable
 * (`LeaveApprovalStepInstance.resolvedApproverEmployeeId` says who was asked), so the permission now
 * means what it says. It is not granted with `hr.leave.manage` and does not imply it: a tenant may
 * grant an approver the decision authority WITHOUT also granting the ability to restate or withdraw
 * requests, which is exactly the separation §25 asks for. The
 * `PENDING → CANCELLED` transition continues to ride on `hr.leave.manage`, exactly as §13 requires,
 * because a withdrawal is not a decision.
 */
@Module({
  imports: [
    HrPrismaModule,
    UserDirectoryModule,
    PlatformAuditModule,
    NotificationModule,
    PureRuleEngineModule,
    PlatformEntitlementModule,
  ],
  controllers: [
    EmployeesController,
    OrganizationController,
    PositionsController,
    AttendanceController,
    LeaveRequestsController,
    LeaveTypesController,
    LeavePoliciesController,
    MissionController,
  ],
  providers: [
    ModuleEntitlementGuard,
    HrIdentityGateway,
    HrAuditGateway,
    HrNotificationGateway,
    OrganizationRepository,
    PositionRepository,
    EmploymentRepository,
    EmployeeRepository,
    AttendanceRepository,
    LeaveRepository,
    LeaveApprovalRepository,
    LeavePolicyRepository,
    MissionRepository,
    MissionApprovalRepository,
    MissionPolicyRepository,
    OrganizationService,
    PositionsService,
    EmploymentService,
    EmployeesService,
    AttendanceService,
    LeaveService,
    LeaveApprovalService,
    LeavePolicyService,
    LeavePolicySimulationService,
    MissionService,
    MissionApprovalService,
    MissionPolicyService,
    HrAuditOutboxRelayService,
  ],
  exports: [
    HrIdentityGateway,
    HrAuditGateway,
    OrganizationService,
    PositionsService,
    EmploymentService,
    EmployeesService,
    AttendanceService,
    LeaveService,
    LeaveApprovalService,
  ],
})
export class HrModule {}
