/**
 * Test-only provisioning for the HR reporting E2E suites (real HR writes through the HR API).
 *
 * WHY THIS FIXTURE EXISTS (ordering defect, not a guard defect)
 * -------------------------------------------------------------
 * These suites drive REAL HR writes through the HR HTTP API (`/hr/organization/units`,
 * `/hr/positions`, `/hr/employees`, `/hr/leave-types`, `/hr/leave-requests`,
 * `/hr/mission-requests`) and then read them back through the Reporting API. Two prerequisites
 * the guard chain needs are missing from a freshly migrated + seeded database:
 *
 *   1. The `hr.*` permission grants. The five grant migrations
 *      (`20260916100100_seed_hr_permission_grants`, `..._20260918130000_seed_hr_attendance_...`,
 *      `..._20260919120000_seed_hr_leave_...`, `..._20260922120000_seed_hr_leave_approve_...`,
 *      `..._20260923131000_seed_hr_mission_permission_grant`) grant them to SUPER_ADMIN and ADMIN
 *      ONLY WHEN those roles already exist at migration time. `db:seed` creates the roles AFTER
 *      the migrations ran, so on a fresh database the grants were never written and `RolesGuard`
 *      — which runs BEFORE the entitlement gate — answers every HR call with 403.
 *   2. The tenant entitlement for the tenant the fixtures WRITE with. The
 *      `20260921120300_seed_hr_module_tenant_membership`,
 *      `20260921120400_seed_hr_leave_feature_entitlement` and
 *      `20260923130000_seed_hr_mission_feature_entitlement` seeds enroll every tenant that
 *      exists AT MIGRATION TIME; the bootstrap tenant `tenant-test-1` is created by `db:seed`
 *      and therefore never enrolled, so `ModuleEntitlementGuard` would refuse an otherwise
 *      fully-permissioned caller with `403 { moduleId: 'hr', featureId: 'leave' }`.
 *
 * MEASURED ON THE ISOLATED CLUSTER BEFORE THIS FIX — this is the whole failure:
 *   * the seeded actor (`admin@localhost`) held 21 grants: BLOG 4, COMMERCE 7, FINANCIAL 7,
 *     INVENTORY 3 — and NONE in the HR domain, although the catalogue declares 15;
 *   * `ModuleRegistrationTenant` covered commerce, financial and inventory for `tenant-test-1`
 *     and covered `hr` for NO tenant at all;
 *   * every HR fixture write therefore answered `expected 201 "Created", got 403 "Forbidden"`.
 * Tenant B is NOT this fixture's business: each HR suite already enrolls its own run-scoped
 * tenant B module + feature in its `setupTenantB`. Only tenant A was unprovisioned.
 *
 * This is the same defect the Commerce, Financial and Inventory suites document and repair in
 * `commerce-provisioning.ts` / `financial-check-provisioning.ts` / `inventory-provisioning.ts`;
 * the HR reporting suites simply had no equivalent.
 *
 * WHAT IT WRITES (and nothing more)
 * ---------------------------------
 *   * the fifteen `hr.*` catalogue permissions to SUPER_ADMIN + ADMIN — the exact role set the
 *     five grant migrations declare (OPERATIONS_ADMIN, SECURITY_ADMIN and every other role stay
 *     ungranted, deliberately);
 *   * the `ModuleRegistrationTenant` membership row and the `ModuleFeatureGrant` rows for both
 *     HR features (`hr/leave`, `hr/mission`) for the tenants passed in — the module's own
 *     feature set, which is what the membership/entitlement seeds declare for every tenant
 *     registered at migration time.
 *
 * No guard, validator, decorator or production default is touched. No role gains a permission
 * its migration does not grant. Every statement is an upsert, so a re-run is a no-op and the
 * fixture never depends on an earlier run's leftovers.
 */
import { PrismaService as CorePrismaService } from '../../src/database/prisma.service';

/** The `hr.*` permissions the five grant migrations declare — the catalogue's own HR set. */
const HR_PERMISSIONS = [
  'hr.employees.read',
  'hr.employees.manage',
  'hr.organization.read',
  'hr.organization.manage',
  'hr.positions.read',
  'hr.positions.manage',
  'hr.attendance.read',
  'hr.attendance.manage',
  'hr.leave.read',
  'hr.leave.manage',
  'hr.leave.approve',
  'hr.mission.read',
  'hr.mission.manage',
  'hr.mission.approve',
  'hr.mission.policy',
] as const;

/** Roles the grant migrations grant HR access to — no more, no fewer. */
const HR_GRANT_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/** The HR module's declared features (`ModuleFeature` rows for `moduleId = 'hr'`). */
const HR_FEATURES = ['leave', 'mission'] as const;

/**
 * Ensures the suites' authorization + entitlement prerequisites AFTER the normal seed has
 * completed. Idempotent: safe to call on every run, including re-runs.
 */
export async function ensureHrReportingTestProvisioning(
  coreDb: CorePrismaService,
  tenantIds: string[],
): Promise<void> {
  // 1. Permission grants to SUPER_ADMIN + ADMIN (the migrations' exact shape).
  for (const roleName of HR_GRANT_ROLES) {
    const role = await coreDb.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new Error(`[E2E fixture] Seeded role ${roleName} not found`);
    }
    for (const permissionName of HR_PERMISSIONS) {
      const permission = await coreDb.permission.findUnique({ where: { name: permissionName } });
      if (!permission) {
        throw new Error(
          `[E2E fixture] Permission ${permissionName} not found (migrations must run first)`,
        );
      }
      await coreDb.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  // 2. Module membership + feature entitlement for the suites' tenants.
  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: 'hr' },
  });
  if (!registration) {
    throw new Error('[E2E fixture] hr module registration not found (migrations must run first)');
  }
  for (const featureId of HR_FEATURES) {
    const feature = await coreDb.moduleFeature.findUnique({
      where: { moduleId_featureId: { moduleId: 'hr', featureId } },
    });
    if (!feature) {
      throw new Error(
        `[E2E fixture] hr/${featureId} feature not found (migrations must run first)`,
      );
    }
    for (const tenantId of tenantIds) {
      await coreDb.moduleFeatureGrant.upsert({
        where: { featureRowId_tenantId: { featureRowId: feature.id, tenantId } },
        update: {},
        create: { featureRowId: feature.id, tenantId },
      });
    }
  }
  for (const tenantId of tenantIds) {
    await coreDb.moduleRegistrationTenant.upsert({
      where: { registrationId_tenantId: { registrationId: registration.id, tenantId } },
      update: {},
      create: { registrationId: registration.id, tenantId },
    });
  }
}