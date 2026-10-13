/**
 * Phase FINALIZE (CI hardening) — deterministic, test-only provisioning for the
 * Financial Check Issuance E2E suite.
 *
 * WHY THIS FIXTURE EXISTS (ordering defect, not a guard defect)
 * -------------------------------------------------------------
 * The suite drives the real Financial HTTP API against a FRESH database
 * (`prisma migrate deploy` + `db:seed`, exactly as CI does). Two prerequisites
 * the suite needs are missing from that fresh state:
 *
 *   1. The `financial.check.*` permission grants. The F1 / CHECK-ISSUATION seed
 *      migrations grant them to the SUPER_ADMIN and ADMIN roles ONLY when those
 *      roles already exist at migration time. `db:seed` creates the roles AFTER
 *      the migrations ran, so on a fresh database the grants were never written
 *      and `RolesGuard` answers every Financial call with 403.
 *   2. The tenant membership for the suite's tenants. The tenant-membership seed
 *      migrations enroll every tenant that exists AT MIGRATION TIME, but the
 *      bootstrap tenant (`tenant-test-1`, created by `db:seed`) and the
 *      run-scoped tenant B (created by this spec) do not exist yet — so
 *      `ModuleEntitlementGuard` would refuse even a fully-permissioned caller.
 *
 * WHAT IT WRITES (and nothing more)
 * ----------------------------------
 *   * the SEVEN `financial.check.*` permission grants to SUPER_ADMIN + ADMIN,
 *     mirroring the existing grant migrations' exact shape and narrowness;
 *   * the `ModuleRegistrationTenant` membership rows for the financial module
 *     for the suite's tenants (bootstrap + run-scoped tenant B);
 *   * the `ModuleFeatureGrant` for `financial/check-request` for the same tenants,
 *     mirroring the feature-entitlement migration's shape.
 *
 * No guard, validator, decorator, or production default is touched. No unrelated
 * tenant, module, role, or permission is granted. Every statement is an upsert,
 * so a re-run is a no-op and the fixture never depends on leftovers from an
 * earlier run. Cleanup of the run-scoped tenant is left to the spec's existing
 * afterAll, which already deletes that tenant's membership/feature rows.
 */
import { PrismaService as CorePrismaService } from '../../src/database/prisma.service';

/** The seven permission strings this suite's routes gate on. */
const FINANCIAL_CHECK_PERMISSIONS = [
  'financial.check.read',
  'financial.check.manage',
  'financial.check.approve',
  'financial.check.allocate',
  'financial.check.review',
  'financial.check.issue',
  'financial.check.deliver',
] as const;

/** Roles the existing grant migrations grant financial access to — no more. */
const FINANCIAL_GRANT_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * Ensures the suite's authorization + entitlement prerequisites AFTER the normal
 * seed has completed. Idempotent: safe to call on every run, including re-runs.
 */
export async function ensureFinancialCheckTestProvisioning(
  coreDb: CorePrismaService,
  tenantIds: string[],
): Promise<void> {
  // 1. Permission grants to SUPER_ADMIN + ADMIN (the migrations' exact shape).
  for (const roleName of FINANCIAL_GRANT_ROLES) {
    const role = await coreDb.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new Error(`[E2E fixture] Seeded role ${roleName} not found`);
    }
    for (const permissionName of FINANCIAL_CHECK_PERMISSIONS) {
      const permission = await coreDb.permission.findUnique({ where: { name: permissionName } });
      if (!permission) {
        throw new Error(`[E2E fixture] Permission ${permissionName} not found (migrations must run first)`);
      }
      await coreDb.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  // 2. Module membership for the suite tenants (the membership seed's shape).
  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: 'financial' },
  });
  if (!registration) {
    throw new Error('[E2E fixture] financial module registration not found (migrations must run first)');
  }
  const feature = await coreDb.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'financial', featureId: 'check-request' } },
  });
  if (!feature) {
    throw new Error('[E2E fixture] financial.check-request feature not found (migrations must run first)');
  }
  for (const tenantId of tenantIds) {
    await coreDb.moduleRegistrationTenant.upsert({
      where: { registrationId_tenantId: { registrationId: registration.id, tenantId } },
      update: {},
      create: { registrationId: registration.id, tenantId },
    });
    await coreDb.moduleFeatureGrant.upsert({
      where: { featureRowId_tenantId: { featureRowId: feature.id, tenantId } },
      update: {},
      create: { featureRowId: feature.id, tenantId },
    });
  }
}
