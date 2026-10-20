import { PrismaClient } from '../src/generated/core-client';
import bcrypt from 'bcryptjs';
import {
  assertSeedProvisioningComplete,
  replaySeedOwnedMigrationProvisioning,
} from './seed-migration-replay';

const prisma = new PrismaClient();

async function main() {
  // GAP-ENV-1: this seed creates a super-admin with a documented default
  // password and is a DEVELOPMENT/TEST bootstrap only. There is no supported
  // production seeding path in this repository, so a production-invoked run is
  // refused outright — never a silent write, never a destructive fallback.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the development seed with NODE_ENV=production. ' +
        'This seed creates a super-admin with a default credential and is not a ' +
        'production bootstrap path. Provision production administrators through ' +
        'the platform instead.',
    );
  }

  // Stage 5.1 (seed contract guard): NODE_ENV alone cannot distinguish a live
  // deployment from a dev-shaped one, so two explicit, harness-only opt-ins are
  // required as well - both are set ONLY by the CI workflow and the jest e2e
  // global-setup, never by the application. The destination identity is then
  // checked against the harness's own allowlists (host AND database). Every
  // check runs BEFORE the first write below; there is no default, guessed, or
  // self-approving fallback: an unknown, ambiguous, or non-allowlisted target
  // (including a live database that happens to share a name) is refused.
  if (process.env.E2E_SEED_OPT_IN !== '1') {
    throw new Error(
      'Refusing to seed: E2E_SEED_OPT_IN is not "1". Seeding is only permitted ' +
        'from the CI workflow or the jest e2e global-setup, which set this flag ' +
        'explicitly for the E2E harness.',
    );
  }

  const allowedHosts = (process.env.E2E_SEED_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedDbs = (process.env.E2E_SEED_ALLOWED_DBS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const coreUrl = process.env.CORE_DATABASE_URL || '';
  let targetHost = '';
  let targetDb = '';
  try {
    const parsed = new URL(coreUrl);
    targetHost = parsed.hostname;
    targetDb = (parsed.pathname || '').split('/').filter(Boolean).pop() || '';
  } catch {
    targetHost = '';
    targetDb = '';
  }

  if (!targetHost || !allowedHosts.includes(targetHost)) {
    throw new Error(
      'Refusing to seed: target host "' +
        (targetHost || '<unparsed>') +
        '" is not in the E2E host allowlist (' +
        (allowedHosts.join(', ') || 'unset') +
        ').',
    );
  }
  if (!targetDb || !allowedDbs.includes(targetDb)) {
    throw new Error(
      'Refusing to seed: target database "' +
        (targetDb || '<unparsed>') +
        '" is not in the E2E database allowlist (' +
        (allowedDbs.join(', ') || 'unset') +
        '). No default or guessed database is used.',
    );
  }

  const now = new Date();

  const roles = [
    { id: 'super-admin-role', name: 'SUPER_ADMIN', displayName: 'Super Admin', hierarchy: 0 },
    { id: 'admin-role', name: 'ADMIN', displayName: 'Admin', hierarchy: 1 },
    { id: 'security-admin-role', name: 'SECURITY_ADMIN', displayName: 'Security Administrator', hierarchy: 2 },
    { id: 'ops-admin-role', name: 'OPERATIONS_ADMIN', displayName: 'Operations Administrator', hierarchy: 3 },
    { id: 'partner-role', name: 'PARTNER', displayName: 'Partner', hierarchy: 10 },
    { id: 'customer-role', name: 'CUSTOMER', displayName: 'Customer', hierarchy: 11 },
    { id: 'employee-role', name: 'EMPLOYEE', displayName: 'Employee', hierarchy: 12 },
    { id: 'visitor-role', name: 'VISITOR', displayName: 'Visitor', hierarchy: 100 },
  ];

  for (const r of roles) {
    await prisma.role.upsert({
      where: { name: r.name as any },
      update: {},
      create: {
        id: r.id,
        name: r.name as any,
        displayName: r.displayName,
        description: r.displayName,
        hierarchy: r.hierarchy,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  // Create blog permissions
  const blogPermissions = [
    { id: 'blog-read', name: 'blog.read', displayName: 'Read Blog', domain: 'BLOG' as const },
    { id: 'blog-write', name: 'blog.write', displayName: 'Write Blog', domain: 'BLOG' as const },
    { id: 'blog-publish', name: 'blog.publish', displayName: 'Publish Blog', domain: 'BLOG' as const },
    { id: 'blog-delete', name: 'blog.delete', displayName: 'Delete Blog', domain: 'BLOG' as const },
  ];

  for (const p of blogPermissions) {
    await prisma.permission.upsert({
      where: { name: p.name },
      update: {},
      create: {
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        domain: p.domain,
        createdAt: now,
      },
    });
  }

  // Assign blog permissions to ADMIN role
  const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' as any } });
  if (adminRole) {
    for (const p of blogPermissions) {
      const perm = await prisma.permission.findUnique({ where: { name: p.name } });
      if (perm) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
          update: {},
          create: {
            id: `admin-${p.id}`,
            roleId: adminRole.id,
            permissionId: perm.id,
            createdAt: now,
          },
        });
      }
    }
  }

  // Assign all blog permissions to SUPER_ADMIN role
  const superRole = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' as any } });
  if (superRole) {
    for (const p of blogPermissions) {
      const perm = await prisma.permission.findUnique({ where: { name: p.name } });
      if (perm) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: superRole.id, permissionId: perm.id } },
          update: {},
          create: {
            id: `super-admin-${p.id}`,
            roleId: superRole.id,
            permissionId: perm.id,
            createdAt: now,
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GAP-8: THE BOOTSTRAP TENANT, AND THE ADMIN'S MEMBERSHIP.
  //
  // WHY THIS EXISTS: the seed used to create the administrator with NO `tenantId` at
  // all, so a freshly seeded database produced an account that could log in but could
  // not act anywhere — every tenant-scoped surface (Commerce included) resolves the
  // tenant from `User.tenantId` and refuses a tenant-less caller. The documented
  // development environment (the administrator in `tenant-test-1`) was a live-database
  // fact maintained by hand, not something this repository could reproduce.
  //
  // `tenant-test-1` is TEXT on purpose: the platform's tenant identifier is an opaque
  // string (HR and correspondence store it as TEXT for the same reason), and every
  // document and test that names the seeded environment already names this value.
  //
  // IDEMPOTENT like the rest of this seed: `upsert` on the tenant's own id, so a re-run
  // changes nothing and an environment that already holds the row is left as it is.
  // ---------------------------------------------------------------------------
  const bootstrapTenant = await prisma.tenant.upsert({
    where: { id: 'tenant-test-1' },
    update: {},
    create: {
      id: 'tenant-test-1',
      code: 'tenant-test-1',
      createdAt: now,
      updatedAt: now,
    },
  });

  // ---------------------------------------------------------------------------
  // Q1: THE PROVISIONING THE MIGRATIONS COULD NOT MAKE.
  //
  // WHY IT IS HERE AND NOT IN A MIGRATION. Every `*_seed_*` Core migration grants what it
  // grants by ENUMERATING rows it does not own: 43 statements read `"Role"` / `"Permission"`
  // and 11 enumerate `"Tenant"`. Nothing in this repository creates a `"Role"` or a
  // `"Tenant"` row except this file, and `db:migrate` runs BEFORE `db:seed` on every
  // documented path — so on a database that has never been seeded, every one of those
  // `CROSS JOIN`s matched zero rows and the whole family of seed migrations applied as a
  // NO-OP. A "successful" bootstrap then held 8 grants in total (this file's own BLOG four
  // for ADMIN and SUPER_ADMIN), no bootstrap-tenant module membership and no feature
  // entitlement: every gated route answered 403 for the administrator this seed had just
  // created. The seed is the only actor that runs AFTER the roles and the tenant exist, so
  // the seed is where the enumeration is completed — with the MIGRATIONS' OWN SQL, read out
  // of their `migration.sql` files and executed verbatim (`seed-migration-replay.ts`). The
  // grant set is therefore not duplicated here and cannot drift, and an installation whose
  // migrations already enumerated its tenants is left exactly as it was: every replayed
  // statement is `ON CONFLICT ... DO NOTHING`, and the tenant-scoped ones read only the
  // bootstrap tenant.
  // ---------------------------------------------------------------------------
  const provisioning = await replaySeedOwnedMigrationProvisioning(prisma, bootstrapTenant.id);
  console.log(
    `Seed provisioning: replayed ${provisioning.statements} migration statement(s) from ` +
      `${provisioning.migrations.length} migration(s) for tenant "${provisioning.bootstrapTenantId}" ` +
      `(role grants +${provisioning.grants}, module memberships +${provisioning.memberships}, ` +
      `feature grants +${provisioning.featureGrants}).`,
  );

  // Ensure a super-admin user exists
  const adminEmail = process.env.E2E_SUPERADMIN_EMAIL || 'admin@localhost';
  const adminPass = process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = bcrypt.hashSync(adminPass, 10);

  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    // `tenantId` is re-stated on every run: the bootstrap account's membership in the
    // bootstrap tenant is part of the environment this seed promises, and a database
    // seeded before GAP-8 carries the same account with NO membership.
    update: { passwordHash, updatedAt: new Date(), tenantId: bootstrapTenant.id },
    create: {
      id: 'super-admin-user', // GAP-8: an OPAQUE platform identity — it is not re-keyed.
      email: adminEmail,
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      status: 'EMPLOYEE',
      emailVerified: true,
      tokenVersion: 1,
      tenantId: bootstrapTenant.id,
      createdAt: now,
      updatedAt: now,
    },
  });

  // Assign SUPER_ADMIN role
  const assignSuperRole = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' as any } });
  if (assignSuperRole) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: assignSuperRole.id } },
      update: {},
      create: {
        id: 'super-admin-user-role',
        userId: user.id,
        roleId: assignSuperRole.id,
        assignedBy: null,
        assignedAt: now,
        updatedAt: now,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Q1, SECOND HALF: THE SEED CERTIFIES WHAT IT JUST PROMISED.
  //
  // The replay above is the correction; this is the proof that it took. The expected sets
  // are re-derived from that same migration SQL (never re-typed, so they cannot drift), and
  // a missing grant, membership or feature grant FAILS the bootstrap: a fresh install must
  // not be able to report success while its own administrator cannot authorise anything.
  // Extra rows are deliberately not this check's business — a live database may carry
  // permissions an operator granted by hand, and a seed that refuses to run over them would
  // be wrong. `test/seed-conformance.e2e-spec.ts` asserts both directions.
  // ---------------------------------------------------------------------------
  const snapshot = await assertSeedProvisioningComplete(prisma, bootstrapTenant.id);
  console.log(
    'Seed provisioning verified: catalogue=' +
      `${snapshot.catalogue.length}, roles with grants=[${Object.keys(snapshot.grantsByRole).sort().join(', ')}], ` +
      `bootstrap memberships=[${snapshot.memberships.join(', ')}], ` +
      `feature grants=[${snapshot.features.join(', ')}].`,
  );

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
