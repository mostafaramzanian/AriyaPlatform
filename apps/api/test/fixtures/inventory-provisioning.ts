/**
 * Phase W1 (E2E hardening) — deterministic, test-only provisioning for the
 * Inventory entitlement/authz E2E suite.
 *
 * WHY THIS FIXTURE EXISTS (ordering defect, not a guard defect)
 * -------------------------------------------------------------
 * The Inventory HTTP surface is gated by TWO independent decisions:
 *
 *   1. `RolesGuard` — `inventory.read` / `inventory.manage` / `inventory.approve`
 *      must be GRANTED to the caller's role. The W1 grant migration
 *      (`20261018140100_seed_inventory_permission_grants`) grants them to
 *      SUPER_ADMIN and ADMIN with `CROSS JOIN "Role"` — so it writes rows only
 *      for roles that ALREADY EXIST when the migration runs.
 *   2. `ModuleEntitlementGuard` — the CALLER'S TENANT must be a member of the
 *      `inventory` module registration and hold the `inventory/stock` feature
 *      grant. Both W1 seed migrations
 *      (`20261018140200_..._module_tenant_membership`,
 *      `20261018140300_..._stock_feature_entitlement`) enumerate
 *      `CROSS JOIN "Tenant"` with `ON CONFLICT DO NOTHING` and are protected by a
 *      stop-guard of the shape `membership_count <> tenant_count`.
 *
 * The e2e harness runs `npm run db:migrate` and THEN `npm run db:seed`
 * (`test/global-setup.ts`), and `prisma/seed.ts` is what creates the roles and
 * `tenant-test-1`. So on a fresh database the three migrations run FIRST, see an
 * EMPTY `Role` and an EMPTY `Tenant`, and silently write nothing; their
 * stop-guards compare `0 <> 0` and therefore do not fire. Verified on the
 * isolated cluster: the 3 `Permission` rows and the `ModuleRegistration` /
 * `ModuleFeature` rows DO exist (those inserts are unconditional), while
 * `RolePermission` for `inventory.*` = 0, `ModuleRegistrationTenant` for
 * `inventory` = 0 and `ModuleFeatureGrant` for `inventory/stock` = 0.
 *
 * Consequence on a fresh database: every Inventory route answers 403 — the
 * read routes because `RolesGuard` denies a permission-less identity, the write
 * routes for the same reason. Nothing about the guards is wrong; the ORDER is.
 *
 * WHAT IT WRITES (and nothing more)
 * ---------------------------------
 *   * the THREE `inventory.*` permission grants to SUPER_ADMIN + ADMIN, mirroring
 *     the grant migration's exact two-role shape;
 *   * the `ModuleRegistrationTenant` membership for the `inventory` module for
 *     the suite's tenants;
 *   * the `ModuleFeatureGrant` for `inventory/stock` for the same tenants.
 *
 * It does NOT create the `Permission`, `ModuleRegistration` or `ModuleFeature`
 * rows — the migrations create those unconditionally, and their absence is
 * reported as a real failure ("migrations must run first") rather than papered
 * over. No guard, validator, decorator, or production default is touched. No
 * unrelated tenant, module, role, or permission is granted. Every statement is
 * an upsert, so a re-run is a no-op and the fixture never depends on leftovers
 * from an earlier run.
 *
 * This is the third sibling of `commerce-provisioning.ts` and
 * `financial-check-provisioning.ts`, and it closes the same class of gap for the
 * last module that had no e2e suite of its own.
 */
import { PrismaService as CorePrismaService } from '../../src/database/prisma.service';
import {
  INVENTORY_FEATURE,
  INVENTORY_MODULE_ID,
} from '../../src/modules/inventory/inventory.constants';
import { Permissions } from '../../src/auth/rbac/constants/permissions';

/** The three permission strings Inventory's controllers gate on. */
const INVENTORY_PERMISSIONS = [
  Permissions.INVENTORY_READ,
  Permissions.INVENTORY_MANAGE,
  Permissions.INVENTORY_APPROVE,
] as const;

/** The roles the W1 grant migration grants inventory access to — no more. */
const INVENTORY_GRANT_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * Ensures the suite's authorization + entitlement prerequisites AFTER the normal
 * seed has completed. Idempotent: safe to call on every run, including re-runs.
 */
export async function ensureInventoryTestProvisioning(
  coreDb: CorePrismaService,
  tenantIds: string[],
): Promise<void> {
  // 1. Permission grants to SUPER_ADMIN + ADMIN (the migration's exact shape).
  for (const roleName of INVENTORY_GRANT_ROLES) {
    const role = await coreDb.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new Error(`[E2E fixture] Seeded role ${roleName} not found`);
    }
    for (const permissionName of INVENTORY_PERMISSIONS) {
      const permission = await coreDb.permission.findUnique({
        where: { name: permissionName },
      });
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

  // 2. Module membership + feature grant for the suite tenants (the seed
  //    migrations' shape). The registration and feature rows are asserted, not
  //    created: they are unconditional migration output.
  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: INVENTORY_MODULE_ID },
  });
  if (!registration) {
    throw new Error(
      '[E2E fixture] inventory module registration not found (migrations must run first)',
    );
  }
  const feature = await coreDb.moduleFeature.findUnique({
    where: {
      moduleId_featureId: { moduleId: INVENTORY_MODULE_ID, featureId: INVENTORY_FEATURE.STOCK },
    },
  });
  if (!feature) {
    throw new Error('[E2E fixture] inventory.stock feature not found (migrations must run first)');
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