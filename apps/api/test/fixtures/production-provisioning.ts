/**
 * Test-only provisioning for the Production reporting E2E suites (real BOM writes through the
 * Production API).
 *
 * WHY THIS FIXTURE EXISTS (ordering defect, not a guard defect)
 * -------------------------------------------------------------
 * These suites drive REAL Production writes through the Production HTTP API (`/production/boms`,
 * `/production/bom-change-requests` and their submit/approve transitions) and then read them
 * back through the Reporting API. Two prerequisites the guard chain needs are missing from a
 * freshly migrated + seeded database:
 *
 *   1. The `production.*` permission grants. `20261002100100_seed_production_permission_grants`
 *      grants them to SUPER_ADMIN and ADMIN ONLY WHEN those roles already exist at migration
 *      time. `db:seed` creates the roles AFTER the migrations ran, so on a fresh database the
 *      grants were never written and `RolesGuard` — which runs BEFORE the entitlement gate —
 *      answers every Production call with 403.
 *   2. The tenant entitlement for the tenant the fixtures WRITE with. The
 *      `20261002100200_seed_production_module_tenant_membership` and
 *      `20261002100300_seed_production_bom_feature_entitlement` seeds enroll every tenant that
 *      exists AT MIGRATION TIME; the bootstrap tenant `tenant-test-1` is created by `db:seed`
 *      and therefore never enrolled, so `ModuleEntitlementGuard` would refuse an otherwise
 *      fully-permissioned caller with `403 { moduleId: 'production', featureId: 'bom' }`.
 *
 * MEASURED ON THE ISOLATED CLUSTER BEFORE THIS FIX — this is the whole failure:
 *   * the seeded actor (`admin@localhost`) held 21 grants: BLOG 4, COMMERCE 7, FINANCIAL 7,
 *     INVENTORY 3 — and NONE in the PRODUCTION domain, although the catalogue declares 3;
 *   * `ModuleRegistrationTenant` covered commerce, financial and inventory for `tenant-test-1`
 *     and covered `production` for NO tenant at all;
 *   * every Production fixture write therefore answered `expected 201 "Created", got 403`.
 * Tenant B is NOT this fixture's business: each Production suite already enrolls its own
 * run-scoped tenant B module + `production/bom` feature in its `setupTenantB`. Only tenant A was
 * unprovisioned.
 *
 * This is the same defect the Commerce, Financial and Inventory suites document and repair in
 * `commerce-provisioning.ts` / `financial-check-provisioning.ts` / `inventory-provisioning.ts`;
 * the Production reporting suites simply had no equivalent.
 *
 * WHAT IT WRITES (and nothing more)
 * ---------------------------------
 *   * the three `production.*` catalogue permissions to SUPER_ADMIN + ADMIN — the exact role set
 *     `20261002100100_seed_production_permission_grants` declares (every other role stays
 *     ungranted, deliberately);
 *   * the `ModuleRegistrationTenant` membership row and the `ModuleFeatureGrant` for
 *     `production/bom` for the tenants passed in.
 *
 * No guard, validator, decorator or production default is touched. No role gains a permission
 * its migration does not grant. Every statement is an upsert, so a re-run is a no-op and the
 * fixture never depends on an earlier run's leftovers.
 */
import { PrismaService as CorePrismaService } from '../../src/database/prisma.service';

/** The `production.*` permissions the grant migration declares — the catalogue's own set. */
const PRODUCTION_PERMISSIONS = [
  'production.bom.read',
  'production.bom.manage',
  'production.bom.approve',
] as const;

/** Roles the grant migration grants Production access to — no more, no fewer. */
const PRODUCTION_GRANT_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * Ensures the suites' authorization + entitlement prerequisites AFTER the normal seed has
 * completed. Idempotent: safe to call on every run, including re-runs.
 */
export async function ensureProductionReportingTestProvisioning(
  coreDb: CorePrismaService,
  tenantIds: string[],
): Promise<void> {
  // 1. Permission grants to SUPER_ADMIN + ADMIN (the migration's exact shape).
  for (const roleName of PRODUCTION_GRANT_ROLES) {
    const role = await coreDb.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new Error(`[E2E fixture] Seeded role ${roleName} not found`);
    }
    for (const permissionName of PRODUCTION_PERMISSIONS) {
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
    where: { moduleId: 'production' },
  });
  if (!registration) {
    throw new Error(
      '[E2E fixture] production module registration not found (migrations must run first)',
    );
  }
  const feature = await coreDb.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'production', featureId: 'bom' } },
  });
  if (!feature) {
    throw new Error('[E2E fixture] production.bom feature not found (migrations must run first)');
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