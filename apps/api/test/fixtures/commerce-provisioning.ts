/**
 * Test-only provisioning for the Commerce reporting E2E suites (procurement writes).
 *
 * WHY THIS FIXTURE EXISTS (ordering defect, not a guard defect)
 * -------------------------------------------------------------
 * These suites drive REAL Commerce writes through the Commerce HTTP API
 * (`POST /commerce/purchase-documents`, payments, receipts, returns) and then read
 * them back through the Reporting API. Two prerequisites the guard chain needs are
 * missing from a freshly migrated + seeded database:
 *
 *   1. The `commerce.*` permission grants. The grant migrations
 *      (`…_seed_commerce_permission_grants`, `…_seed_commerce_supplier_permission`)
 *      grant them to SUPER_ADMIN and ADMIN ONLY WHEN those roles already exist at
 *      migration time. `db:seed` creates the roles AFTER the migrations ran, so on a
 *      fresh database the grants were never written and `RolesGuard` — which runs
 *      BEFORE the entitlement gate — answers every Commerce call with 403.
 *   2. The tenant entitlement for the tenant the fixtures WRITE with. The
 *      `ModuleRegistrationTenant` / `ModuleFeatureGrant` seeds enroll every tenant
 *      that exists AT MIGRATION TIME; the bootstrap tenant `tenant-test-1` is created
 *      by `db:seed` and therefore never enrolled, so `ModuleEntitlementGuard` would
 *      refuse an otherwise fully-permissioned caller with
 *      `403 { code, moduleId: 'commerce', featureId: 'purchase' }`.
 *
 * This is the same defect the Financial suite documents and repairs in
 * `financial-check-provisioning.ts`; Commerce simply had no equivalent, which is why
 * the Commerce reporting suites failed while their Financial sibling passed on a
 * leftover grant.
 *
 * WHAT IT WRITES (and nothing more)
 * ---------------------------------
 *   * the seven `commerce.*` catalogue permissions to SUPER_ADMIN + ADMIN — the exact
 *     role set the two grant migrations declare (OPERATIONS_ADMIN, SECURITY_ADMIN and
 *     every other role stay ungranted, deliberately);
 *   * the `ModuleRegistrationTenant` membership row and the `ModuleFeatureGrant` for
 *     `commerce/purchase` for the tenants passed in.
 *
 * No guard, validator, decorator or production default is touched. No role gains a
 * permission its migration does not grant. Every statement is an upsert, so a re-run
 * is a no-op and the fixture never depends on an earlier run's leftovers.
 */
import { PrismaService as CorePrismaService } from '../../src/database/prisma.service';

/** The `commerce.*` permissions the grant migrations declare — the catalogue's own set. */
const COMMERCE_PERMISSIONS = [
  'commerce.read',
  'commerce.manage',
  'commerce.approve',
  'commerce.configure',
  'commerce.workflow.manage',
  'commerce.commercial.manage',
  'commerce.supplier.manage',
] as const;

/** Roles the grant migrations grant Commerce access to — no more, no fewer. */
const COMMERCE_GRANT_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * Ensures the suites' authorization + entitlement prerequisites AFTER the normal seed
 * has completed. Idempotent: safe to call on every run, including re-runs.
 */
export async function ensureCommerceProcurementTestProvisioning(
  coreDb: CorePrismaService,
  tenantIds: string[],
): Promise<void> {
  // 1. Permission grants to SUPER_ADMIN + ADMIN (the migrations' exact shape).
  for (const roleName of COMMERCE_GRANT_ROLES) {
    const role = await coreDb.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new Error(`[E2E fixture] Seeded role ${roleName} not found`);
    }
    for (const permissionName of COMMERCE_PERMISSIONS) {
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
    where: { moduleId: 'commerce' },
  });
  if (!registration) {
    throw new Error('[E2E fixture] commerce module registration not found (migrations must run first)');
  }
  const feature = await coreDb.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'commerce', featureId: 'purchase' } },
  });
  if (!feature) {
    throw new Error('[E2E fixture] commerce.purchase feature not found (migrations must run first)');
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