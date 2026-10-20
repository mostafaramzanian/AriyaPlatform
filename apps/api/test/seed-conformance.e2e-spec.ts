/**
 * GAP-8 (WS6.C) — SEED CONFORMANCE: `prisma/seed.ts` is the ONE authoritative
 * bootstrap path, and the environment it promises is the environment this repository
 * tests against.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 *   C1  The authoritative entrypoint (`npm run db:seed` → `ts-node prisma/seed.ts`,
 *       the script `prisma.seed` in package.json names) runs to completion and
 *       reaches its own `Seed complete` marker — a bootstrap failure is reported as
 *       the seed's own failure, never as a mystery timeout.
 *   C2  It creates the bootstrap tenant (`tenant-test-1`) — the opaque, TEXT
 *       identifier every fixture in this repository names.
 *   C3  It creates the bootstrap administrator (`super-admin-user`) ATTACHED to that
 *       tenant: `User.tenantId` is non-null and resolves to an existing Tenant row.
 *       This is the row whose absence made a freshly-seeded database unable to act
 *       anywhere (the original GAP-8 symptom at the environment level).
 *   C4  It binds that administrator to `SUPER_ADMIN` — membership is a database fact,
 *       not a convention.
 *   C5  The seeded identity satisfies BOTH wire contracts: the platform identity
 *       contract (`IdentityUserRequestDto`: string, 1..64) and the Commerce contract
 *       (`CreatePurchaseDocumentDto.requesterId` accepts it). No UUID shape is
 *       required, which is the whole point of Fork A.
 *   C6  A SECOND run is idempotent: same rows, same membership, no duplicates. Row
 *       counts and identity facts are compared BEFORE and AFTER the second run.
 *   C7  THE MIGRATION-DEFINED PROVISIONING IS PRESENT, AND ONLY IT (Q1). Every grant,
 *       module membership and feature grant the Core migrations declare — read by running
 *       each migration statement's OWN enumeration (`prisma/seed-migration-replay.ts`),
 *       never by re-typing the set here — exists for the bootstrap tenant, and nothing
 *       exists that no migration declares (the one exception, the seed's own BLOG
 *       catalogue, is named rather than excused). This is the regression gate for the
 *       defect measured on a real fresh install: migrations run BEFORE the seed, so every
 *       `*_seed_*` statement that enumerates `"Role"` / `"Permission"` / `"Tenant"` was a
 *       no-op, leaving 8 role-permission rows in total (the seed's own BLOG four for ADMIN
 *       and SUPER_ADMIN), zero module memberships and zero feature grants — a database whose
 *       administrator could log in and do nothing.
 *
 * WHAT IDEMPOTENCY DOES AND DOES NOT MEAN HERE
 * --------------------------------------------
 * The seed deliberately re-hashes the admin password and stamps `updatedAt` on every
 * run (see the `update:` branch in seed.ts) — that is a REFRESH, not a duplicate.
 * Idempotency therefore asserts ROW IDENTITY: counts and membership are unchanged,
 * never that the password hash bytes are identical.
 *
 * THE SPAWN IS THE POINT. This suite runs the repository's own npm script rather than
 * re-implementing the seed's steps in-process: a test that re-typed the seed's upserts
 * would keep passing after the seed itself broke.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import 'reflect-metadata';

import { getTestApp } from './setup';

import { PrismaService } from '../src/database/prisma.service';
import { CreatePurchaseDocumentDto } from '../src/modules/commerce/purchase/purchase.dto';
import {
  IdentityUserRequestDto,
  MAX_IDENTITY_USER_ID,
} from '../src/platform/identity/identity.contract';
import {
  runDbSeed,
  SEED_ADMIN_USER_ID,
  SEED_BOOTSTRAP_TENANT_ID,
} from './fixtures/seed-environment';
import {
  compareSeedProvisioningExactly,
  measureSeedProvisioning,
  type SeedProvisioningSnapshot,
} from '../prisma/seed-migration-replay';

jest.setTimeout(240_000);


/** What "the seed's promised environment" means, measured between two runs. */
interface SeedSnapshot {
  tenants: number;
  tenantId: string | null;
  admins: number;
  adminTenantId: string | null;
  seedRoles: number;
  blogPermissions: number;
  superAdminRoleRows: number;
  /** Q1: the whole provisioned environment, measured by the replay module's own reader. */
  provisioning: SeedProvisioningSnapshot;
}

describe('GAP-8 seed conformance — the authoritative bootstrap, run twice (live core_db)', () => {
  const app = () => getTestApp();
  let core: PrismaService;
  let firstRunOutput = '';

  /**
   * ONLY seed-owned rows are counted. Other suites running in the same jest run add
   * their own bindings (media grants ADMIN to the admin, module-entitlement probes
   * with its own tenant) — a global count would turn their activity into a false
   * idempotency failure here. Every id below is created by `prisma/seed.ts` itself.
   */
  const SEED_ROLE_IDS = [
    'super-admin-role',
    'admin-role',
    'security-admin-role',
    'ops-admin-role',
    'partner-role',
    'customer-role',
    'employee-role',
    'visitor-role',
  ];
  const BLOG_PERMISSION_IDS = ['blog-read', 'blog-write', 'blog-publish', 'blog-delete'];

  /**
   * Q1: the ONE grant set the seed owns outside the migration graph — the BLOG catalogue it
   * creates and grants itself. Written as names (the migration side compares names) and
   * named in `compareSeedProvisioningExactly` as an allowed extra rather than excused by a
   * loose comparison: if the seed ever gains a fifth BLOG permission, C6's count assertion
   * fails first and this list has to be revisited on purpose.
   */
  const SEED_OWNED_BLOG_PERMISSIONS = ['blog.read', 'blog.write', 'blog.publish', 'blog.delete'];

  const snapshot = async (): Promise<SeedSnapshot> => {
    const admin = await core.user.findUnique({
      where: { id: SEED_ADMIN_USER_ID },
      select: { tenantId: true },
    });
    return {
      tenants: await core.tenant.count({ where: { id: SEED_BOOTSTRAP_TENANT_ID } }),
      tenantId: (
        await core.tenant.findUnique({
          where: { id: SEED_BOOTSTRAP_TENANT_ID },
          select: { id: true },
        })
      )?.id ?? null,
      admins: await core.user.count({ where: { id: SEED_ADMIN_USER_ID } }),
      adminTenantId: admin?.tenantId ?? null,
      seedRoles: await core.role.count({ where: { id: { in: SEED_ROLE_IDS } } }),
      blogPermissions: await core.permission.count({ where: { id: { in: BLOG_PERMISSION_IDS } } }),
      superAdminRoleRows: await core.userRole.count({
        where: { userId: SEED_ADMIN_USER_ID, roleId: 'super-admin-role' },
      }),
      provisioning: await measureSeedProvisioning(core, SEED_BOOTSTRAP_TENANT_ID),
    };
  };

  beforeAll(async () => {
    core = app().get(PrismaService);
    // C1 + the FIRST run: establish (or refresh) the documented environment.
    firstRunOutput = await runDbSeed();
  });

  it('C1: the authoritative entrypoint exits 0 and reaches its own completion marker', () => {
    expect(firstRunOutput).toContain('Seed complete');
  });

  it('C2: the bootstrap tenant exists exactly once', async () => {
    const snap = await snapshot();
    expect(snap.tenants).toBe(1);
    expect(snap.tenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);
  });

  it('C3: the bootstrap administrator exists exactly once, ATTACHED to the tenant', async () => {
    const snap = await snapshot();
    expect(snap.admins).toBe(1);
    expect(snap.adminTenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);

    // The membership must resolve: the tenant the FK points at is a real row.
    const tenant = await core.tenant.findUnique({ where: { id: snap.adminTenantId as string } });
    expect(tenant).not.toBeNull();
  });

  it('C4: the administrator is bound to SUPER_ADMIN by a database row', async () => {
    const snap = await snapshot();
    expect(snap.superAdminRoleRows).toBe(1);
  });

  it('C5: the seeded identity satisfies the platform AND the Commerce wire contracts', async () => {
    const admin = await core.user.findUniqueOrThrow({ where: { id: SEED_ADMIN_USER_ID } });

    // The platform identity contract: string, 1..64 — no UUID shape anywhere.
    expect(typeof admin.id).toBe('string');
    expect(admin.id.length).toBeGreaterThanOrEqual(1);
    expect(admin.id.length).toBeLessThanOrEqual(MAX_IDENTITY_USER_ID);

    const identity = plainToInstance(IdentityUserRequestDto, { userId: admin.id });
    expect(await validate(identity, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);

    // The Commerce contract: the same id as a requesterId, validated by the exact
    // DTO class the purchase routes use, with the pipe's whitelist semantics.
    const purchase = plainToInstance(CreatePurchaseDocumentDto, {
      requesterId: admin.id,
      lines: [{ lineType: 'STANDARD', quantity: 1, unit: 'pcs', unitPrice: 10 }],
    });
    const errors = await validate(purchase, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property)).toEqual([]);
  });

  it('C6: a SECOND run is idempotent — same seed-owned rows, same membership, no duplicates', async () => {
    const before = await snapshot();

    const secondRunOutput = await runDbSeed();
    expect(secondRunOutput).toContain('Seed complete');

    const after = await snapshot();
    expect(after).toEqual(before);

    // And the promised shape specifically, not just "unchanged".
    expect(after.tenants).toBe(1);
    expect(after.admins).toBe(1);
    expect(after.adminTenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);
    expect(after.seedRoles).toBe(8);
    expect(after.blogPermissions).toBe(4);
    expect(after.superAdminRoleRows).toBe(1);
  });

  it('C7: the migration-defined provisioning is present for the bootstrap tenant — and only it (Q1)', async () => {
    // The expected sets are DERIVED from `prisma/core/migrations` by running each
    // statement's own enumeration — never re-typed here. A re-typed copy would keep passing
    // after a migration changed what it declares, which is the exact failure mode Q1 was
    // made of; the derivation is the authority, and the lists at the end of this test are
    // the human-readable pin of the environment this repository promises.
    const { snapshot: provisioning, difference } = await compareSeedProvisioningExactly(core, {
      bootstrapTenantId: SEED_BOOTSTRAP_TENANT_ID,
      allowedExtraGrants: {
        ADMIN: SEED_OWNED_BLOG_PERMISSIONS,
        SUPER_ADMIN: SEED_OWNED_BLOG_PERMISSIONS,
      },
    });

    // The Q1 regression proper: nothing a migration declares may be missing. Before the fix
    // this list held every module-domain grant in the catalogue (68 of them in the live
    // harness database), because `db:migrate` runs before `db:seed` and every `*_seed_*`
    // statement that enumerates `"Role"` / `"Tenant"` matched no rows at all.
    expect(difference.missing).toEqual([]);
    // And nothing may be granted that no migration declares.
    expect(difference.unexpected).toEqual([]);

    // The Q1 SYMPTOM, stated positively: the seeded administrator holds the WHOLE catalogue
    // through SUPER_ADMIN. On a fresh install before the fix it held 4 of 68 (the seed's own
    // BLOG grants), so every gated route answered 403 for the account the seed had just
    // created.
    expect(provisioning.catalogue.length).toBeGreaterThan(0);
    expect(provisioning.grantsByRole.SUPER_ADMIN).toHaveLength(provisioning.catalogue.length);

    // The two failures a fresh install also produced, one level down: no module membership
    // (403 MODULE_FORBIDDEN everywhere) and no feature grant (403 FEATURE_NOT_FOUND).
    expect(provisioning.memberships).toEqual([
      'commerce',
      'financial',
      'hr',
      'inventory',
      'production',
    ]);
    expect(provisioning.features).toEqual([
      'commerce/purchase',
      'financial/check-request',
      'hr/leave',
      'hr/mission',
      'inventory/stock',
      'production/bom',
    ]);
  });
});

