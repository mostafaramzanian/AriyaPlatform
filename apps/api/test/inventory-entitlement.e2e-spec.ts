/**
 * Phase W1 — INVENTORY: catalog + entitlement over the REAL HTTP surface.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Inventory was the one shipped business module with NO e2e suite of its own, so
 * the defect this suite now pins was invisible: the three W1 seed migrations are
 * ENUMERATION migrations (`CROSS JOIN "Role"` / `CROSS JOIN "Tenant"`) whose
 * inputs are created LATER by `db:seed`. The harness runs `db:migrate` and then
 * `db:seed` (`test/global-setup.ts`), so on a fresh database the migrations write
 * nothing, their `count <> count` stop-guards compare `0 <> 0` and stay silent,
 * and every Inventory route answers 403. The guards are correct; the ORDER is not.
 *
 * WHAT IT PROVES (all through real HTTP, real Postgres, real JWT auth)
 * --------------------------------------------------------------------
 *   A. the defect is REAL and reproducible: with the enumerated prerequisites
 *      removed the way a fresh database has them (grants / membership / feature
 *      grant absent), `GET /api/v1/inventory/items` is REFUSED with 403;
 *   B. the documented remedy CLOSES it: after `ensureInventoryTestProvisioning`
 *      (the repository's third provisioning fixture, mirroring the migrations'
 *      own shapes) the SAME route answers 200 for the seeded administrator, and
 *      the database shows exactly the migration-intended rows (grants 0 -> 6,
 *      membership 0 -> 1, feature grant 0 -> 1);
 *   C. the AUTHORIZATION layer is real, not just the entitlement layer: a write
 *      (`POST /api/v1/inventory/items`, `inventory.manage`) succeeds and is read
 *      back by id, and the read routes of all three Inventory controllers (items,
 *      warehouses, stock balances) answer for the same provisioned identity.
 *
 * SEAMS (kept minimal, and test-only)
 * -----------------------------------
 *   * Prerequisites are written through the Core Prisma client because no HTTP
 *     surface provisions roles, grants or tenant membership — the same seam the
 *     Commerce and Financial suites use, through the same shared fixture idiom.
 *   * The permission CLAIM is CACHED, and both phases invalidate it explicitly:
 *     `login` resolves the caller's permissions through the `PermissionSource`
 *     port, and its Core binding reads `PermissionService`'s cache
 *     (`user:permissions:<id>`, TTL 15 minutes). Phase A authenticates while the
 *     grants are absent, which caches an inventory-less claim - so without the
 *     invalidation Phase B's write would stay invisible to a fresh token for 15
 *     minutes. This is the repository's own idiom, not a test hack: the RBAC
 *     services invalidate after every grant write (`role.service.ts` assign /
 *     remove), and the `app`, `search`, `support` and `surveys` e2e suites
 *     invalidate after a direct grant write.
 *   * Phase A removes exactly the three enumerated rows this fixture owns (scoped
 *     to SUPER_ADMIN/ADMIN and to the bootstrap tenant) so the fresh-database
 *     state is reproduced DETERMINISTICALLY on every run, including re-runs
 *     against a cluster that a previous run already provisioned. Phase B restores
 *     them idempotently; `afterAll` re-asserts the provisioned state so the
 *     cluster is left usable for the live HTTP campaign.
 *   * The suite must be run in band (`--runInBand`): it mutates cluster-wide
 *     grant rows for the two administrative roles.
 *
 * CLEANUP is test-only and id-scoped: the items this run created (SKU prefix
 * `W1-E2E-`) are deleted from `inventory_db`. Audit rows are NOT deleted — the
 * audit trail is append-only by design.
 */
import { makeRequest, getTestApp } from './setup';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { InventoryPrismaService } from '../src/modules/inventory/database/inventory-prisma.service';
import {
  INVENTORY_FEATURE,
  INVENTORY_MODULE_ID,
} from '../src/modules/inventory/inventory.constants';
import { Permissions } from '../src/auth/rbac/constants/permissions';
import { PermissionService } from '../src/auth/rbac/services/permission.service';
import { ensureInventoryTestProvisioning } from './fixtures/inventory-provisioning';
import {
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD,
  SEED_BOOTSTRAP_TENANT_ID,
} from './fixtures/seed-environment';

const API_PREFIX = '/api/v1';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** The SKU prefix this suite owns, so cleanup can never touch another run's rows. */
const SKU_PREFIX = 'W1-E2E-';

/** The two roles the W1 grant migration grants `inventory.*` to. */
const GRANT_ROLE_NAMES = ['SUPER_ADMIN', 'ADMIN'] as const;
/** The three permission strings Inventory's controllers gate on. */
const INVENTORY_PERMISSION_NAMES: string[] = [
  Permissions.INVENTORY_READ,
  Permissions.INVENTORY_MANAGE,
  Permissions.INVENTORY_APPROVE,
];

function getApp() {
  return getTestApp();
}

function getCoreDb(): CorePrismaService {
  return getApp().get(CorePrismaService);
}

function getInventoryDb(): InventoryPrismaService {
  return getApp().get(InventoryPrismaService);
}

function api() {
  return makeRequest();
}

async function login(email: string, password: string): Promise<string> {
  const res = await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(200);
  const token = res.body?.data?.accessToken ?? res.body?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error(`[E2E] Login for ${email} produced no access token: ${JSON.stringify(res.body)}`);
  }
  return token;
}

/**
 * Envelope-tolerant read of a page body: the platform's list routes return the
 * repository shape (`{ items, total }`) directly, and this tolerates a wrapper
 * so a future envelope change reports a real assertion failure, not a TypeError.
 */
function itemsOf(body: unknown): unknown[] {
  const b = body as { items?: unknown; data?: { items?: unknown } } | null;
  if (Array.isArray(b?.items)) return b.items;
  if (Array.isArray(b?.data?.items)) return b.data.items as unknown[];
  return [];
}

async function waitForReadiness(timeoutMs = 60_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const health = await api().get(`${API_PREFIX}/health`);
      if (health.status !== 200) {
        lastError = `health=${health.status}`;
      } else {
        const ready = await api().get(`${API_PREFIX}/ready`);
        if (ready.status === 200 && ready.body?.status === 'ready') {
          console.log(`[E2E] Ready after ${attempt} attempt(s)`);
          return;
        }
        lastError = `ready=${ready.status} ${JSON.stringify(ready.body)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`[E2E] Service did not become ready within ${timeoutMs}ms: ${lastError}`);
}

interface InventoryScope {
  roleIds: string[];
  permissionIds: string[];
  registrationId: string | null;
  featureRowId: string | null;
}

interface InventoryEnumeration {
  /** `RolePermission` rows for `inventory.*` held by SUPER_ADMIN + ADMIN. */
  grants: number;
  /** `ModuleRegistrationTenant` rows for the `inventory` module. */
  memberships: number;
  /** `ModuleFeatureGrant` rows for `inventory/stock`. */
  featureGrants: number;
}

/** Resolves ids with SCALAR fields only — no relation names are assumed. */
async function inventoryScope(coreDb: CorePrismaService): Promise<InventoryScope> {
  const [roles, permissions, registration, feature] = await Promise.all([
    coreDb.role.findMany({ where: { name: { in: [...GRANT_ROLE_NAMES] } }, select: { id: true } }),
    coreDb.permission.findMany({
      where: { name: { in: INVENTORY_PERMISSION_NAMES } },
      select: { id: true },
    }),
    coreDb.moduleRegistration.findUnique({
      where: { moduleId: INVENTORY_MODULE_ID },
      select: { id: true },
    }),
    coreDb.moduleFeature.findUnique({
      where: {
        moduleId_featureId: { moduleId: INVENTORY_MODULE_ID, featureId: INVENTORY_FEATURE.STOCK },
      },
      select: { id: true },
    }),
  ]);
  return {
    roleIds: roles.map((r) => r.id),
    permissionIds: permissions.map((p) => p.id),
    registrationId: registration?.id ?? null,
    featureRowId: feature?.id ?? null,
  };
}

/** The measured enumeration state for ONE tenant (plus the cluster-wide grants). */
async function readEnumeration(
  coreDb: CorePrismaService,
  tenantId: string,
): Promise<InventoryEnumeration> {
  const scope = await inventoryScope(coreDb);
  const [grants, memberships, featureGrants] = await Promise.all([
    coreDb.rolePermission.count({
      where: { roleId: { in: scope.roleIds }, permissionId: { in: scope.permissionIds } },
    }),
    scope.registrationId
      ? coreDb.moduleRegistrationTenant.count({
          where: { registrationId: scope.registrationId, tenantId },
        })
      : Promise.resolve(0),
    scope.featureRowId
      ? coreDb.moduleFeatureGrant.count({ where: { featureRowId: scope.featureRowId, tenantId } })
      : Promise.resolve(0),
  ]);
  return { grants, memberships, featureGrants };
}

/**
 * Reproduces the FRESH-DATABASE state deterministically: removes exactly the
 * enumerated rows the W1 migrations would have written, and nothing else.
 */
async function clearEnumeration(coreDb: CorePrismaService, tenantId: string): Promise<void> {
  const scope = await inventoryScope(coreDb);
  await coreDb.rolePermission.deleteMany({
    where: { roleId: { in: scope.roleIds }, permissionId: { in: scope.permissionIds } },
  });
  if (scope.registrationId) {
    await coreDb.moduleRegistrationTenant.deleteMany({
      where: { registrationId: scope.registrationId, tenantId },
    });
  }
  if (scope.featureRowId) {
    await coreDb.moduleFeatureGrant.deleteMany({
      where: { featureRowId: scope.featureRowId, tenantId },
    });
  }
}

/** The seeded administrator's Core user id, resolved by email (scalar only). */
async function seededAdminUserId(coreDb: CorePrismaService): Promise<string> {
  const admin = await coreDb.user.findUnique({
    where: { email: SEED_ADMIN_EMAIL },
    select: { id: true },
  });
  if (!admin) {
    throw new Error(`[E2E] Seeded administrator ${SEED_ADMIN_EMAIL} is absent from Core`);
  }
  return admin.id;
}

/**
 * Drops the cached permission claim for one user, so the NEXT login resolves the
 * claim from the CURRENT database state instead of a 15-minute-old cache entry.
 * The mutation idiom is `role.service.ts`'s after every grant write, and the same
 * call appears in `app`, `search`, `support` and `surveys` e2e suites.
 */
async function invalidatePermissionClaim(userId: string, reason: string): Promise<void> {
  await getApp().get(PermissionService).invalidateUserPermissions(userId, reason);
}

describe('Inventory — catalog + entitlement over real HTTP (Phase W1)', () => {
  /** Measured BEFORE the fixture: the fresh-database enumeration state. */
  let before: InventoryEnumeration;
  /** Measured AFTER the fixture: the migrated shape. */
  let after: InventoryEnumeration;
  /** The HTTP answer the un-provisioned identity actually received. */
  let unprovisionedStatus = 0;
  /** Minted AFTER provisioning — the permission claim is resolved at login. */
  let adminToken = '';
  let createdItemId: string | null = null;
  let createdSku = '';

  beforeAll(async () => {
    await waitForReadiness();
    const coreDb = getCoreDb();

    // ---- Phase A: the fresh-database state, reproduced deterministically ----
    await clearEnumeration(coreDb, SEED_BOOTSTRAP_TENANT_ID);
    before = await readEnumeration(coreDb, SEED_BOOTSTRAP_TENANT_ID);

    const adminUserId = await seededAdminUserId(coreDb);
    // The 403 below must be READ FROM the de-provisioned database, never from a
    // claim an earlier run left in the cache.
    await invalidatePermissionClaim(adminUserId, 'e2e-inventory-phase-a');

    const preToken = await login(SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD);
    const preRes = await api()
      .get(`${API_PREFIX}/inventory/items`)
      .set('Authorization', `Bearer ${preToken}`);
    unprovisionedStatus = preRes.status;
    console.log(
      `[E2E] BEFORE provisioning: ${JSON.stringify(before)} -> GET /inventory/items = ${unprovisionedStatus}`,
    );

    // ---- Phase B: the repository's documented remedy, then a FRESH login -----
    await ensureInventoryTestProvisioning(coreDb, [SEED_BOOTSTRAP_TENANT_ID]);
    after = await readEnumeration(coreDb, SEED_BOOTSTRAP_TENANT_ID);
    console.log(`[E2E] AFTER provisioning: ${JSON.stringify(after)}`);
    // The remedy is observable only through a claim resolved AFTER the write.
    await invalidatePermissionClaim(adminUserId, 'e2e-inventory-phase-b');
    adminToken = await login(SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD);
  }, 90_000);

  afterAll(async () => {
    // Test-only, id-scoped cleanup: only this suite's own SKU prefix is swept, so
    // a leftover row from an interrupted run is removed and nothing else is.
    try {
      await getInventoryDb().inventoryItem.deleteMany({
        where: { sku: { startsWith: SKU_PREFIX } },
      });
    } catch {
      // best-effort
    }
    // Leave the cluster PROVISIONED: that is the state the migrations intend and
    // the state the campaign's live HTTP probe needs. Re-applying is a no-op.
    try {
      await ensureInventoryTestProvisioning(getCoreDb(), [SEED_BOOTSTRAP_TENANT_ID]);
    } catch {
      // best-effort
    }
  });

  it('A. reproduces the gap: no enumerated prerequisites -> every Inventory read is refused', () => {
    // The premise is MEASURED, never assumed.
    expect(before.grants).toBe(0);
    expect(before.memberships).toBe(0);
    expect(before.featureGrants).toBe(0);
    // ...and the observed consequence over real HTTP, for a REAL authenticated
    // administrator. (403 is observed data: the guards ran and denied.)
    expect(unprovisionedStatus).toBe(403);
  });

  it('B. the provisioning fixture writes exactly the migrated shape', () => {
    // 3 `inventory.*` permissions x 2 roles (SUPER_ADMIN, ADMIN) = 6 grants.
    expect(after.grants).toBe(6);
    expect(after.memberships).toBe(1);
    expect(after.featureGrants).toBe(1);
  });

  it('C. answers GET /api/v1/inventory/items for the provisioned administrator', async () => {
    const res = await api()
      .get(`${API_PREFIX}/inventory/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 200 });
    expect(Array.isArray(itemsOf(res.body))).toBe(true);
  });

  it('D. accepts a real write (inventory.manage) and reads it back by id', async () => {
    createdSku = `${SKU_PREFIX}${RUN_ID}`;

    const created = await api()
      .post(`${API_PREFIX}/inventory/items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: createdSku,
        name: `W1 e2e item ${RUN_ID}`,
        itemType: 'STOCKED',
        baseUnit: 'pcs',
        trackingMode: 'NONE',
      });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 });

    const payload = (created.body?.data ?? created.body) as { id?: string; sku?: string };
    expect(payload.sku).toBe(createdSku);
    expect(typeof payload.id).toBe('string');
    createdItemId = payload.id ?? null;
    expect(createdItemId).toBeTruthy();

    // Persisted, in the tenant the token resolved to — checked in `inventory_db`.
    const row = await getInventoryDb().inventoryItem.findFirst({
      where: { id: createdItemId as string },
    });
    expect(row?.sku).toBe(createdSku);
    expect(row?.tenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);

    // Read back through the API, by id.
    const fetched = await api()
      .get(`${API_PREFIX}/inventory/items/${createdItemId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect({ status: fetched.status }).toMatchObject({ status: 200 });
    expect((fetched.body?.data ?? fetched.body).sku).toBe(createdSku);

    // Real negative path from the service: a duplicate SKU inside the tenant.
    const duplicate = await api()
      .post(`${API_PREFIX}/inventory/items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: createdSku,
        name: `duplicate ${RUN_ID}`,
        itemType: 'STOCKED',
        baseUnit: 'pcs',
      });
    expect({ status: duplicate.status }).toMatchObject({ status: 409 });
  });

  it('E. answers the read routes of the other two Inventory controllers', async () => {
    for (const path of ['/inventory/warehouses', '/inventory/stock/balances']) {
      const res = await api()
        .get(`${API_PREFIX}${path}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect({ path, status: res.status }).toMatchObject({ path, status: 200 });
    }
  });

  it('F. the fixture provisions authorization only — no token is still refused', async () => {
    const res = await api().get(`${API_PREFIX}/inventory/items`);
    // 401 from `JwtAuthGuard`, or 403 if the entitlement guard answers first:
    // either way an anonymous caller is refused, so the fixture cannot be read as
    // "everything is allowed now".
    expect([401, 403]).toContain(res.status);
  });
});