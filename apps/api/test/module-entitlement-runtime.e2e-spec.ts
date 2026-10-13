import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../src/database/prisma.service';
import { HrPrismaService } from '../src/modules/hr/database/hr-prisma.service';
import {
  ENTITLEMENT_PORT,
  type EntitlementPort,
} from '../src/platform/entitlement/entitlement.contract';
import { MODULE_FEATURE_ACTIONS, MODULE_FEATURE_AUDIT_RESOURCE } from '../src/platform/entitlement/module-feature.service';
import { HR_FEATURE, HR_MODULE_ID } from '../src/modules/hr/hr.constants';
import { MAX_TENANT_IDS } from '../src/module-platform/dto/module.dto';
import { FEATURE_TENANT_PAGE_SIZE } from '../src/platform/entitlement/dto/module-feature.dto';
import { ModuleFeatureController } from '../src/platform/entitlement/module-feature.controller';
import { RequestContextService } from '../src/common/request-context.service';
import { makeRequest, getTestApp } from './setup';
import {
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD,
  SEED_ADMIN_USER_ID,
  SEED_BOOTSTRAP_TENANT_ID,
} from './fixtures/seed-environment';

/**
 * Phase 54-C — RUNTIME CLOSURE: the entitlement layer against the REAL core_db.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `module-entitlement-migrations.spec.ts` reads the migration FILES (text), and
 * `module-feature.controller.spec.ts` / `module-entitlement.guard.spec.ts` build unit graphs
 * with fake ports. Between them the phase proved its SOURCES and its DECISIONS. What none of
 * them can prove is the question an operator asked at closure time:
 *
 *   "In the database this installation is running on, is the HR module reachable by exactly
 *    the tenants the D16 seed put in the child table, does the feature gate refuse with the
 *    §43.2 code on a real route, do the six admin routes move real rows, and does deleting a
 *    tenant really leave nothing behind?"
 *
 * That is a question about a POPULATED database, so it is answered here, against the live
 * `core_db` this repository's `docker-compose.yml` provides, through the REAL composition
 * root (`AppModule`, booted by `test/setup.ts`) and the REAL HTTP surface.
 *
 * THE FACTS THIS RUN WAS CLOSED AGAINST (measured, not assumed)
 * ------------------------------------------------------------
 *   * `ModuleRegistration` holds TWO modules: `hr` (`RESTRICTED_MEMBERS`, array empty, 162
 *     membership rows) and `gate-finance` (`ALL`, no rows needed).
 *   * `Tenant` holds 162 rows; `ModuleRegistrationTenant` holds 162 for `hr` — the D16 seed
 *     enumerated the POPULATION, where the legacy 64-entry array could not (D15-G1).
 *   * `ModuleFeature` holds `hr/leave` with `enabled = true`; `ModuleFeatureGrant` holds 162
 *     rows — one per tenant.
 *   * The seeded administrator is `admin@localhost` / `ChangeMe123!` (`prisma/seed.ts`
 *     defaults; no `E2E_SUPERADMIN_*` override is present in `.env.e2e`), id
 *     `super-admin-user`, tenant `tenant-test-1`, role `SUPER_ADMIN` (43 permissions, which
 *     includes every `hr.*` code and `admin.modules.read` / `admin.modules.manage`).
 *
 * WHAT MAKES EACH SECTION NON-COSMETIC
 * ------------------------------------
 *   §1  The registration and the feature row are read from the live database — the two
 *       tables the whole layer resolves against — not from the spec's own constants.
 *   §2  The arithmetic of the D15-G1 failure is asserted (population > 64), so the reason a
 *       64-entry array was never a possible home for HR membership cannot become unreadable.
 *   §3  The D16 seed is a BIJECTION between `Tenant` and `ModuleRegistrationTenant`: no
 *       truncation, no duplicate, no orphan, nobody missing.
 *   §4  The legacy array is empty for HR and the CHECK that keeps it that way exists.
 *   §5  The module gate answers over HTTP: a real member answers 200, a real NON-member is
 *       refused 403 `MODULE_FORBIDDEN`, and the membership row is then shown to be the
 *       DECIDING fact by inserting it and watching the same request succeed.
 *   §6  The feature gate answers over HTTP in the frozen §43.5 ORDER: module first, then
 *       offer, then grant. `FEATURE_NOT_GRANTED` is produced by revoking through the ADMIN
 *       ROUTE, and `FEATURE_DISABLED` by the platform's own `PATCH .../features/:featureId`.
 *   §7  Grant is idempotent, an unknown tenant id is a `400` from the foreign key, and a
 *       revoke that removes nothing is a `404` — the three answers the console is typed
 *       against.
 *   §8  Grant and revoke leave an audit trail attributed to the authenticated administrator,
 *       on the feature ROW (`ModuleFeature` / `hr:leave`).
 *   §9  Deleting the tenant removes BOTH facts about it (CASCADE), and the re-created tenant
 *       starts UNENTITLED — the fail-closed direction the schema documents.
 *   §10 Revoking and disabling entitlement does NOT touch `hr_db`: the leave catalogue and
 *       the personnel file are data, and entitlement is a decision about access to them.
 *
 * THE PROBE IS DISPOSABLE BY CONSTRUCTION
 * ---------------------------------------
 * §5–§9 need a tenant that is NOT a member. Creating one is the only honest way to ask the
 * question (every existing tenant IS a member after D16 — asserted in §3), so the suite
 * creates one tenant, one user and one role binding, drives the whole lifecycle, and removes
 * them in `afterAll`. Probe ids carry a random suffix so a crashed run cannot collide with
 * the next one.
 */
describe('Phase 54-C runtime closure: entitlement is a database fact (live core_db)', () => {
  const HR_FEATURE_ID = HR_FEATURE.LEAVE;
  /** The legacy array's own bound, from the DTO that enforces it (`MAX_TENANT_IDS = 64`). */
  const MAX_LEGACY_ARRAY_ENTRIES = MAX_TENANT_IDS;
  /** The tenant the seeded administrator belongs to — and therefore the tenant of every 200 below. */
  const ADMIN_TENANT_ID = SEED_BOOTSTRAP_TENANT_ID;
  /** The seeded administrator: `prisma/seed.ts` defaults, re-hashed on every E2E global setup. */
  const ADMIN_EMAIL = SEED_ADMIN_EMAIL;
  const ADMIN_PASSWORD = SEED_ADMIN_PASSWORD;
  /**
   * `User.id` of the seeded administrator (`prisma/seed.ts`), and therefore the actor §8 expects
   * in the trail: `subject(req)` reads `sub`, which both the legacy and asymmetric issuers set to
   * the user's own id — no request body can name an actor.
   *
   * GAP-8: taken FROM the shared seed fixture rather than re-typed, so the next seed change
   * cannot silently pass or fail here (the fixture's own suite asserts the live database
   * against these values).
   */
  const ADMIN_USER_ID = SEED_ADMIN_USER_ID;
  /** `Role.id` is seeded by `prisma/seed.ts` with this fixed value; `ADMIN` carries every `hr.*` code. */
  const ADMIN_ROLE_ID = 'admin-role';

  let core: PrismaService;
  let hrDb: HrPrismaService;
  let port: EntitlementPort;

  /** The `hr` registration row's id — the membership table's parent. */
  let hrRegistrationId: string;
  /** The `hr/leave` feature row's id — the grant table's parent. */
  let leaveFeatureRowId: string;

  /**
   * When the D16 seed finished, read from `_prisma_migrations`.
   *
   * THIS IS THE ANCHOR §2/§3 MEASURE AGAINST, and it is the reason those sections are not
   * phrased as "the current tenant count". A tenant created AFTER this instant has no
   * membership row by construction — that is the documented consequence of enumerating a
   * population at migration time, and the resolver refuses such a tenant (fail-closed).
   * Scoping the claim to the tenants that existed AT THE SEED is therefore the only
   * formulation that is both precise and not broken by another suite's disposable tenant.
   */
  let seedFinishedAt: Date;
  /** The population D16 enumerated: tenants that existed at `seedFinishedAt`. */
  let preSeedTenantCount: number;

  let adminToken: string;
  /** The probe user's own token — used to show the same request flipping as facts change. */
  let probeToken: string;
  /** The id of the throwaway tenant §9 cascades, and the `LeaveType` §10 writes to `hr_db`. */
  let cascadeTenantId = '';
  /**
   * §9's RE-CREATED tenant — the one that proves a tenant which reappears under a new id does
   * not inherit anything. Held separately from `cascadeTenantId` so a failure between the
   * delete and the second delete still leaves nothing behind for the next run.
   */
  let cascadeRecreatedTenantId = '';
  let probeLeaveTypeId: string | null = null;

  /**
   * The disposable tenant whose NON-membership is the subject of §5, and whose subsequent
   * membership drives §6–§9.
   */
  const suffix = randomUUID().slice(0, 8);
  /**
   * The CODE §9's two tenants share: the second is the first, RE-CREATED under a new id.
   *
   * The same code deliberately, because that is the question — a tenant is identified by its id,
   * and a re-creation reuses the label an operator typed. If entitlement were keyed on anything
   * an operator can re-type, this is the test that would catch it.
   */
  const cascadeTenantCode = `CASCADE-54C-${suffix}`;
  const probe = {
    tenantId: `probe-54c-${suffix}`,
    userId: `probe-54c-user-${suffix}`,
    email: `probe-54c-${suffix}@probe.local`,
    password: 'Probe54cPass!',
    userRoleId: `probe-54c-userrole-${suffix}`,
    membershipId: `probe-54c-membership-${suffix}`,
    created: false,
  };

  /** The app under test is the REAL combined process booted by `test/setup.ts`. */
  const app = () => getTestApp();
  const request = () => makeRequest();

  beforeAll(async () => {
    core = app().get(PrismaService);
    hrDb = app().get(HrPrismaService);
    port = app().get<EntitlementPort>(ENTITLEMENT_PORT);

    const registration = await core.moduleRegistration.findUnique({
      where: { moduleId: HR_MODULE_ID },
      select: { id: true },
    });
    if (!registration) throw new Error('The hr module is not registered in core_db.');
    hrRegistrationId = registration.id;

    const feature = await core.moduleFeature.findUnique({
      where: { moduleId_featureId: { moduleId: HR_MODULE_ID, featureId: HR_FEATURE_ID } },
      select: { id: true },
    });
    if (!feature) throw new Error('The hr/leave feature is not declared in core_db.');
    leaveFeatureRowId = feature.id;

    // §2/§3 measure against the D16 seed's own finishing instant, read from the table Prisma
    // writes when a migration is applied. Nothing here is hardcoded: the population and the
    // anchor both come from the database this run is closing against.
    const seedRow = await core.$queryRawUnsafe<{ finished_at: Date }[]>(
      `SELECT finished_at FROM _prisma_migrations
        WHERE migration_name LIKE '20260921120300%' AND finished_at IS NOT NULL`
    );
    if (seedRow.length !== 1) throw new Error('The D16 membership seed is not applied in core_db.');
    seedFinishedAt = seedRow[0].finished_at;

    const preSeed = await core.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "Tenant" WHERE "createdAt" <= $1`,
      seedFinishedAt
    );
    preSeedTenantCount = Number(preSeed[0].n);

    // The fixture is created LAZILY, by §5 — see `ensureProbeFixture`. Creating it here would
    // put a tenant in the table before §2/§3 assert on the population, and the whole point of
    // those sections is to describe the installation D16 enumerated.
    adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    // `hr_db` first: §10 writes a leave type for the probe tenant, and HR's own foreign keys
    // are RESTRICT — a tenant reference left in `hr_db` would be a leak this suite created and
    // did not clean, so it is removed by tenant id rather than by the id captured in §10.
    await hrDb.leaveType.deleteMany({ where: { tenantId: probe.tenantId } });
    if (probeLeaveTypeId) {
      await hrDb.leaveType.deleteMany({ where: { id: probeLeaveTypeId } });
      probeLeaveTypeId = null;
    }

    // §9's throwaway tenants, if a failure left either behind. The CASCADE would remove the
    // two fact rows with the tenant; they are deleted explicitly so cleanup works even when the
    // assertion that FAILED was the one about the cascade.
    for (const tenantId of [cascadeTenantId, cascadeRecreatedTenantId]) {
      if (!tenantId) continue;
      await core.moduleRegistrationTenant.deleteMany({ where: { tenantId } });
      await core.moduleFeatureGrant.deleteMany({ where: { tenantId } });
      await core.tenant.deleteMany({ where: { id: tenantId } });
    }

    // Reverse dependency order. `AuditLog.userId` is `onDelete: SetNull`, so the trail the
    // probe's own requests produced survives without keeping the probe alive — which is the
    // point of §8 asserting on it by `resourceId` and time rather than by user row.
    await core.userRole.deleteMany({ where: { userId: probe.userId } });
    await core.user.deleteMany({ where: { id: probe.userId } });
    await core.tenant.deleteMany({ where: { id: probe.tenantId } });

    // The tenant is the parent of BOTH fact tables (CASCADE), so the probe leaves nothing
    // behind — asserted rather than assumed, because a leaked probe would change the
    // population §2/§3 measure and would inflate the grant count §7 pages through.
    const leftovers =
      (await core.moduleRegistrationTenant.count({ where: { tenantId: probe.tenantId } })) +
      (await core.moduleFeatureGrant.count({ where: { tenantId: probe.tenantId } })) +
      (await core.tenant.count({ where: { id: probe.tenantId } })) +
      (await hrDb.leaveType.count({ where: { tenantId: probe.tenantId } }));
    expect(leftovers).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Logs in through the real route and returns the access token it minted.
   *
   * THE `data` ENVELOPE IS PART OF THE CONTRACT, not a testing convenience: `AuthController`
   * carries `@UseInterceptors(BlogResponseInterceptor)` at class level, so every `/auth/*`
   * response is `{ success, data, meta, timestamp, traceId }` and the token is one level down.
   * Reading `body.accessToken` here would make this suite assert against a shape the running
   * process does not produce. The platform routes this suite exercises afterwards
   * (`/hr/*`, `/admin/modules/*`) carry no such interceptor and are read raw.
   */
  async function login(email: string, password: string): Promise<string> {
    const res = await request()
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const token = res.body?.data?.accessToken;
    expect(typeof token).toBe('string');
    return token as string;
  }

  const asAdmin = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    request()[method](url).set('Authorization', `Bearer ${adminToken}`);

  /** An HR read behind the MODULE gate only — the first step of §43.5's order. */
  const EMPLOYEES_URL = '/api/v1/hr/employees';
  /** The leave catalogue: a read behind BOTH the module gate and the feature gate. */
  const LEAVE_TYPES_URL = '/api/v1/hr/leave-types';

  /** Inserts the membership row that makes the probe tenant a member. */
  async function addProbeMembership(): Promise<void> {
    await core.moduleRegistrationTenant.create({
      data: { id: probe.membershipId, registrationId: hrRegistrationId, tenantId: probe.tenantId },
    });
  }

  /** Grants `hr/leave` to the probe tenant directly — used only to build a precondition. */
  async function addProbeGrant(): Promise<void> {
    await core.moduleFeatureGrant.create({
      data: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
    });
  }

  /**
   * How many audit rows the feature-level decisions have produced for `hr:leave`.
   *
   * A COUNT rather than a captured id, because `AuditLog.userId` is `onDelete: SetNull`: the
   * trail a probe's requests left behind must survive the probe's deletion, and a count is the
   * shape that stays readable after that.
   */
  async function auditCount(): Promise<number> {
    return core.auditLog.count({
      where: {
        resourceType: MODULE_FEATURE_AUDIT_RESOURCE,
        resourceId: `${HR_MODULE_ID}:${HR_FEATURE_ID}`,
      },
    });
  }

  /**
   * The platform's own decision for the probe tenant, taken from the LIVE graph's port.
   *
   * The tenant comes from `RequestContextService`, which is where the port reads it — the
   * same ambient source a real request feeds through `TenantContextInterceptor`. No query
   * parameter can be passed here because the port has no such input, which is the property
   * §25-rule-7 depends on.
   */
  async function decideForTenant(tenantId: string): Promise<{ ok: boolean; failure?: string }> {
    RequestContextService.set({
      requestId: `probe-${suffix}`,
      correlationId: `probe-${suffix}`,
      startTime: Date.now(),
      tenantId,
    });

    // The FEATURE-level question: this is what the leave surfaces declare, and it is the
    // narrower of the two. §43.5's order means a module-level refusal is reported first even
    // when a feature was asked about, so this one call also covers the module cases.
    return port.decide({ moduleId: HR_MODULE_ID, featureId: HR_FEATURE_ID });
  }

  /**
   * The same question, asked about the probe tenant — the tenant whose membership and grant the
   * sections below turn on and off. Delegates rather than re-implements, so the two observers
   * cannot drift apart.
   */
  async function decideForProbeTenant(): Promise<{ ok: boolean; failure?: string }> {
    return decideForTenant(probe.tenantId);
  }

  /**
   * The MODULE-level question, asked about the probe tenant.
   *
   * WHY BOTH QUESTIONS EXIST. §5 turns on MEMBERSHIP, and the surface it compares against —
   * `GET /hr/employees` — declares `@RequiresModule` alone. Asking the feature-level question
   * there would be a different question with a different answer: a member that holds no grant is
   * `FEATURE_NOT_GRANTED` at the feature level and admitted at the module level. §6, which turns
   * on the GRANT, asks the feature-level question. The two helpers are the two declarations, so
   * each comparison is made at the same level as the surface it observes.
   */
  async function decideModuleForProbeTenant(): Promise<{ ok: boolean; failure?: string }> {
    RequestContextService.set({
      requestId: `probe-module-${suffix}`,
      correlationId: `probe-module-${suffix}`,
      startTime: Date.now(),
      tenantId: probe.tenantId,
    });

    return port.decide({ moduleId: HR_MODULE_ID });
  }

  /** Clears the ambient tenant so a later HTTP request cannot inherit the probe's. */
  function clearRequestContext(): void {
    RequestContextService.set({
      requestId: 'e2e',
      correlationId: 'e2e',
      startTime: Date.now(),
      tenantId: null,
    });
  }

  /** An authenticated request made as the probe user. */
  const asProbe = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    request()[method](url).set('Authorization', `Bearer ${probeToken}`);

  /** The six §43.8 admin routes, addressed exactly as the console addresses them. */
  const FEATURES_URL = `/api/v1/admin/modules/${HR_MODULE_ID}/features`;
  const LEAVE_FEATURE_URL = `${FEATURES_URL}/${HR_FEATURE_ID}`;
  const LEAVE_TENANTS_URL = `${LEAVE_FEATURE_URL}/tenants`;

  /** `POST .../tenants` — grant to named tenants, as the operator's console does it. */
  const grantViaAdminRoute = (tenantIds: string[]) =>
    asAdmin('post', LEAVE_TENANTS_URL).send({ tenantIds });

  /** `DELETE .../tenants/:tenantId` — revoke one grant. */
  const revokeViaAdminRoute = (tenantId: string) =>
    asAdmin('delete', `${LEAVE_TENANTS_URL}/${tenantId}`);

  /** `PATCH .../features/:featureId` — the PLATFORM's offer, not a tenant's grant. */
  const setOffer = (enabled: boolean) =>
    asAdmin('patch', LEAVE_FEATURE_URL).send({ enabled });

  /**
   * Walks the granted-tenant read to exhaustion, following the route's own `X-Next-Cursor`.
   *
   * A LOOP RATHER THAN ONE REQUEST. The read is bounded by `FEATURE_TENANT_PAGE_SIZE` while the
   * population is larger than one page, so a single request would describe a PREFIX and call it a
   * list — the silent truncation the header exists to prevent. The header name is the controller's
   * own constant, so this helper cannot drift from the route it reads.
   *
   * THE PAGE CEILING IS A GUARD, NOT AN EXPECTATION: a server that echoed a cursor forever would
   * otherwise hang the suite instead of failing it.
   */
  async function readAllGrantedTenants(): Promise<{
    ids: string[];
    rows: { tenantId: string; grantedAt: string }[];
    pages: number;
  }> {
    const MAX_PAGES = 100;
    const ids: string[] = [];
    const rows: { tenantId: string; grantedAt: string }[] = [];
    let pages = 0;
    let cursor: string | undefined;

    for (;;) {
      const url = cursor
        ? `${LEAVE_TENANTS_URL}?cursor=${encodeURIComponent(cursor)}`
        : LEAVE_TENANTS_URL;
      const res = await asAdmin('get', url).expect(200);

      rows.push(...res.body);
      ids.push(...res.body.map((row: { tenantId: string }) => row.tenantId));
      pages += 1;

      const next = res.headers[ModuleFeatureController.NEXT_CURSOR_HEADER.toLowerCase()];
      if (!next) return { ids, rows, pages };
      if (pages >= MAX_PAGES) throw new Error('The granted-tenant read never reached a last page.');

      cursor = next as string;
    }
  }

  /**
   * The DATABASE's own clock — the instant every `AuditLog` row is timestamped with.
   *
   * §8 needs a boundary between "rows earlier tests wrote" and "rows this test writes", and an
   * app-side `new Date()` would be a boundary from a different clock than the one the rows carry.
   * Reading `now()` from `core_db` makes both sides of the comparison the same authority.
   */
  async function dbNow(): Promise<Date> {
    const rows = await core.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now');
    return rows[0].now;
  }

  /** The feature-level audit rows written strictly AFTER a database-instant. */
  async function auditRowsSince(since: Date) {
    return core.auditLog.findMany({
      where: {
        resourceType: MODULE_FEATURE_AUDIT_RESOURCE,
        resourceId: `${HR_MODULE_ID}:${HR_FEATURE_ID}`,
        createdAt: { gt: since },
      },
      select: { action: true, userId: true, resourceId: true, newValue: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Creates the disposable fixture ONCE, on first use (§5), and logs the probe in.
   *
   * LAZY ON PURPOSE — see `beforeAll`: §2/§3 must observe the population D16 seeded, and a
   * tenant created before them would make those measurements describe something else.
   */
  async function ensureProbeFixture(): Promise<void> {
    if (probe.created) return;

    await core.tenant.create({
      data: { id: probe.tenantId, code: `PROBE-54C-${suffix}`, status: 'ACTIVE' },
    });
    await core.user.create({
      data: {
        id: probe.userId,
        email: probe.email,
        passwordHash: bcrypt.hashSync(probe.password, 10),
        firstName: 'Probe',
        lastName: '54C',
        status: 'EMPLOYEE',
        emailVerified: true,
        tokenVersion: 1,
        tenantId: probe.tenantId,
      },
    });
    await core.userRole.create({
      data: { id: probe.userRoleId, userId: probe.userId, roleId: ADMIN_ROLE_ID },
    });
    probe.created = true;

    // The real login route, so the token the probe carries is the one the platform mints —
    // including the `tid` the tenant port uses.
    probeToken = await login(probe.email, probe.password);
  }

  /**
   * The idempotent form of the two facts §5–§9 turn on and off. Each section states the
   * precondition it needs instead of inheriting one from the test above it, so a single
   * failure does not cascade into a wall of unrelated failures.
   */
  async function ensureProbeMembership(): Promise<void> {
    const existing = await core.moduleRegistrationTenant.count({
      where: { registrationId: hrRegistrationId, tenantId: probe.tenantId },
    });
    if (existing === 0) await addProbeMembership();
  }

  async function dropProbeMembership(): Promise<void> {
    await core.moduleRegistrationTenant.deleteMany({
      where: { registrationId: hrRegistrationId, tenantId: probe.tenantId },
    });
  }

  async function ensureProbeGrant(): Promise<void> {
    const existing = await core.moduleFeatureGrant.count({
      where: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
    });
    if (existing === 0) await addProbeGrant();
  }

  async function dropProbeGrant(): Promise<void> {
    await core.moduleFeatureGrant.deleteMany({
      where: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
    });
  }

  /**
   * The two §43.3 fact rows a tenant can hold, counted for ANY tenant id.
   *
   * ONE HELPER FOR ONE QUESTION — "what does this tenant hold?" — because §9 asks it about
   * tenants that are not the probe (a throwaway and its re-creation), and a second, slightly
   * different pair of counts is exactly how a cascade assertion stops meaning what it says.
   */
  async function factRows(tenantId: string): Promise<{ memberships: number; grants: number }> {
    return {
      memberships: await core.moduleRegistrationTenant.count({ where: { tenantId } }),
      grants: await core.moduleFeatureGrant.count({ where: { tenantId } }),
    };
  }

  // ---------------------------------------------------------------------------
  // §1. The live schema facts the whole layer resolves against.
  // ---------------------------------------------------------------------------

  it('§1 finds hr registered as RESTRICTED_MEMBERS with an EMPTY legacy array, and hr/leave offered', async () => {
    const registration = await core.moduleRegistration.findUnique({
      where: { moduleId: HR_MODULE_ID },
      select: { enabled: true, tenantScope: true, tenantIds: true },
    });

    expect(registration).not.toBeNull();
    // The D16 scope: membership is a CHILD TABLE, not an array — that is what makes 162
    // tenants representable at all.
    expect(registration!.tenantScope).toBe('RESTRICTED_MEMBERS');
    // The legacy column still exists and is EMPTY: §7's "not the source of truth" is a
    // storage fact, and the table CHECK forbids a writer putting anything here.
    expect(registration!.tenantIds).toEqual([]);
    expect(registration!.enabled).toBe(true);

    const feature = await core.moduleFeature.findUnique({
      where: { moduleId_featureId: { moduleId: HR_MODULE_ID, featureId: HR_FEATURE_ID } },
      select: { displayName: true, enabled: true },
    });

    expect(feature).not.toBeNull();
    // `enabled` is the PLATFORM's offer; the D14 seed turned it on, which is what leaves the
    // GRANT as the only remaining question for a member tenant.
    expect(feature!.enabled).toBe(true);
    expect(feature!.displayName.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // §2. The D15-G1 arithmetic, asserted so the historical failure stays readable.
  // ---------------------------------------------------------------------------

  it('§2 records why the legacy array could never hold HR membership: the population exceeds the 64-entry bound', async () => {
    // The population the D16 seed had to enumerate: the tenants that existed when it ran.
    expect(preSeedTenantCount).toBeGreaterThan(64);
    expect(preSeedTenantCount).toBe(162);

    // The same bound the legacy array DTO enforces, so the arithmetic that failed D15-G1 is
    // asserted on both operands rather than described: 162 tenants cannot fit 64 slots.
    expect(preSeedTenantCount).toBeGreaterThan(MAX_LEGACY_ARRAY_ENTRIES);
  });

  // ---------------------------------------------------------------------------
  // §3. The D16 seed is a bijection between Tenant and ModuleRegistrationTenant.
  // ---------------------------------------------------------------------------

  it('§3 seeds exactly one membership per tenant that existed at the seed — no truncation, no duplicate, no orphan, nobody missing', async () => {
    const membershipCount = await core.moduleRegistrationTenant.count({
      where: { registrationId: hrRegistrationId },
    });
    const distinctTenants = await core.moduleRegistrationTenant
      .findMany({ where: { registrationId: hrRegistrationId }, select: { tenantId: true } })
      .then((rows) => new Set(rows.map((row) => row.tenantId)).size);

    // THE COUNT IS THE POPULATION. Not a page, not a prefix, not the 64 the array could hold.
    // Scoped to the tenants that existed when the seed ran (`preSeedTenantCount`), because a
    // tenant created afterwards has no membership BY CONSTRUCTION — that is the documented
    // consequence of enumerating a population at migration time, and §5's probe is such a
    // tenant.
    expect(membershipCount).toBe(preSeedTenantCount);
    // The closure fact for THIS installation, stated so a different run's number is visible.
    expect(membershipCount).toBe(162);
    expect(membershipCount).toBeGreaterThan(64);
    // One row per tenant, or "presence is a grant" would be ambiguous for that tenant.
    expect(distinctTenants).toBe(membershipCount);

    // Direction one: every membership row points at a tenant that exists.
    const orphans = await core.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "ModuleRegistrationTenant" m
        WHERE m."registrationId" = $1
          AND NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t.id = m."tenantId")`,
      hrRegistrationId
    );
    expect(Number(orphans[0].n)).toBe(0);

    // Direction two: no tenant that existed at the seed was skipped. This is the assertion a
    // PARTIAL enumeration — the failure mode D15-G1 predicted — would break.
    const missing = await core.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "Tenant" t
        WHERE t."createdAt" <= $1
          AND NOT EXISTS (
            SELECT 1 FROM "ModuleRegistrationTenant" m
             WHERE m."registrationId" = $2 AND m."tenantId" = t.id)`,
      seedFinishedAt,
      hrRegistrationId
    );
    expect(Number(missing[0].n)).toBe(0);
  });

  it('§3 includes the seeded administrators tenant, which is why the live HTTP assertions can reach HR at all', async () => {
    const admin = await core.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true, tenantId: true },
    });

    expect(admin).not.toBeNull();
    // The administrator is not tenant-less: a tenant-less caller could never match a
    // membership or a grant, so every scoped module would refuse it.
    expect(admin!.tenantId).toBe(ADMIN_TENANT_ID);

    const membership = await core.moduleRegistrationTenant.count({
      where: { registrationId: hrRegistrationId, tenantId: ADMIN_TENANT_ID },
    });
    expect(membership).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // §4. The legacy array is preserved and inert; the D16 table is the only source.
  // ---------------------------------------------------------------------------

  it('§4 keeps every legacy array empty and the scope/array CHECK in place, so RESTRICTED_MEMBERS leads', async () => {
    // The column is NOT dropped (a legacy reader still finds it) and it is NOT populated:
    // the D16 seed delegated membership to the child table for HR, and the CHECK refuses a
    // row that tries to use both.
    const populated = await core.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "ModuleRegistration"
        WHERE "moduleId" = $1 AND coalesce(array_length("tenantIds", 1), 0) >= 1`,
      HR_MODULE_ID
    );
    expect(Number(populated[0].n)).toBe(0);

    const check = await core.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_constraint
        WHERE conname = 'ModuleRegistration_tenantScope_consistent'`
    );
    expect(Number(check[0].n)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // §5. The MODULE gate, answered over real HTTP by the real controller guard.
  // ---------------------------------------------------------------------------

  it('§5 refuses a NON-member with the frozen §43.2 code and admits a member — and administration is not gated by what it administers', async () => {
    // The probe tenant/user/binding are created HERE, not in `beforeAll`, so §2/§3 measured the
    // population D16 enumerated and nothing else.
    await ensureProbeFixture();

    // The probe holds ADMIN, which was MEASURED to carry every `hr.*` code as well as
    // `admin.modules.read` / `admin.modules.manage`. Permission is therefore not a variable in
    // this suite: the only layer that can refuse the probe is entitlement.
    probeToken = await login(probe.email, probe.password);

    const refused = await request()
      .get(EMPLOYEES_URL)
      .set('Authorization', `Bearer ${probeToken}`)
      .expect(403);

    // THE BODY IS THE ASSERTION, NOT THE STATUS. `RolesGuard` answers 403 with a bare message
    // and no `code` field; this layer answers 403 with a frozen §43.2 `code`. A test that only
    // asserted 403 could not tell the two apart — which is exactly the ambiguity §43.2 exists
    // to remove for the operator reading a log line.
    expect(refused.body).toMatchObject({
      statusCode: 403,
      code: 'MODULE_FORBIDDEN',
      moduleId: HR_MODULE_ID,
    });
    // The route declares the module only, so no `featureId` is echoed: absent means "the
    // module level was the question", never "unknown".
    expect(refused.body.featureId).toBeUndefined();

    // The member's identical request is admitted: the gate is a decision, not a wall.
    await asAdmin('get', EMPLOYEES_URL).expect(200);

    // THE ADMIN SURFACE IS NOT BEHIND THE ENTITLEMENT IT ADMINISTERS — otherwise a module
    // could never be re-scoped, because the caller would be refused by the very scope it is
    // trying to repair. Asserted while the probe is still a NON-member: it reads the registry
    // through the same real HTTP surface, under `admin.modules.read`.
    const registry = await request()
      .get('/api/v1/admin/modules')
      .set('Authorization', `Bearer ${probeToken}`)
      .expect(200);
    expect(JSON.stringify(registry.body)).toContain(`"moduleId":"${HR_MODULE_ID}"`);
  });

  it('§5 flips the SAME request from 403 to 200 by inserting the membership row — membership is the deciding fact', async () => {
    // Precondition, re-asserted here so this test stands on its own: refused while not a member.
    const before = await request()
      .get(EMPLOYEES_URL)
      .set('Authorization', `Bearer ${probeToken}`)
      .expect(403);
    expect(before.body.code).toBe('MODULE_FORBIDDEN');

    await addProbeMembership();

    // The ONLY change is one row in `ModuleRegistrationTenant`. No restart, no cache flush, no
    // token re-issue: the decision is read from the database on every request, so the next
    // request sees it. That is what "entitlement is a database fact" means operationally.
    await request()
      .get(EMPLOYEES_URL)
      .set('Authorization', `Bearer ${probeToken}`)
      .expect(200);

    // The platform's own port agrees with the HTTP surface — one implementation, two observers.
    // If these ever disagreed, the gate would be deciding by a path the resolver does not share.
    // THE MODULE-LEVEL QUESTION, because that is the level this request was decided at:
    // `GET /hr/employees` declares `@RequiresModule` alone. The probe is a member holding NO
    // leave grant, so the feature-level question would answer `FEATURE_NOT_GRANTED` — a true
    // statement about a question nobody asked here, and exactly the drift the helper pair
    // exists to prevent.
    const decision = await decideModuleForProbeTenant();
    expect(decision.ok).toBe(true);
    clearRequestContext();
  });

  // ---------------------------------------------------------------------------
  // §6. The FEATURE gate, in §43.5's frozen order: module, then offer, then grant.
  // ---------------------------------------------------------------------------

  it('§6 refuses a member with NO grant as FEATURE_NOT_GRANTED — and the code names the FEATURE level', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    const refused = await asProbe('get', LEAVE_TYPES_URL).expect(403);

    // A MEMBER that holds `hr.leave.read` is refused, and the code says WHICH level decided.
    // This is the distinction the operator needs: "your tenancy is not entitled to HR" and
    // "your tenancy has HR but not the leave catalogue" are different support conversations.
    expect(refused.body).toMatchObject({
      statusCode: 403,
      code: 'FEATURE_NOT_GRANTED',
      moduleId: HR_MODULE_ID,
      featureId: HR_FEATURE_ID,
    });

    // The SAME token on a module-gated-only surface answers 200: the refusal above is the
    // feature level, not the module level, proven by the surface that declares no feature.
    await asProbe('get', EMPLOYEES_URL).expect(200);
  });

  it('§6 turns the same request into 200 by GRANTING through the admin route — the console writes the deciding row', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    await asProbe('get', LEAVE_TYPES_URL).expect(403);

    const granted = await grantViaAdminRoute([probe.tenantId]).expect(201);
    expect(granted.body).toEqual({ granted: 1 });

    await asProbe('get', LEAVE_TYPES_URL).expect(200);

    // And the port agrees, so the HTTP answer and the platform decision come from one source.
    const decision = await decideForProbeTenant();
    expect(decision).toEqual({ ok: true });
    clearRequestContext();
  });

  it('§6 lets the MODULE level win over everything: a non-member is refused even while granted and offered', async () => {
    await ensureProbeFixture();
    await ensureProbeGrant();
    await dropProbeMembership();

    const refused = await asProbe('get', LEAVE_TYPES_URL).expect(403);

    // The FIRST refusal in §43.5's order. The tenant HAS the grant and the feature IS offered,
    // so nothing below the module could have produced this answer.
    expect(refused.body).toMatchObject({
      statusCode: 403,
      code: 'MODULE_FORBIDDEN',
      moduleId: HR_MODULE_ID,
    });
    // THE ECHO REPORTS WHAT WAS ASKED, NOT WHAT DECIDED. `/hr/leave-types` declares BOTH
    // levels (`@RequiresModule` and `@RequiresFeature`), so the feature id IS echoed even
    // though the module level is what refused — the deciding level is named by `code`, and
    // the two facts answer different questions: "what did this surface require?" and "which
    // check refused?". A surface declaring no feature would echo none, which is why the
    // field is present here rather than absent.
    expect(refused.body.featureId).toBe(HR_FEATURE_ID);

    await ensureProbeMembership();
  });

  it('§6 produces FEATURE_DISABLED from the platform offer alone, with the grant still in place', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await ensureProbeGrant();

    // Precondition: entitled.
    await asProbe('get', LEAVE_TYPES_URL).expect(200);

    await setOffer(false).expect(200);

    try {
      const refused = await asProbe('get', LEAVE_TYPES_URL).expect(403);

      // THE OFFER OUTRANKS THE GRANT: the tenant still holds a grant row, and it is refused —
      // a per-tenant grant cannot rescue a feature the platform no longer offers. Asserted
      // against the row, not assumed, so the ordering claim is measured rather than described.
      expect(
        await core.moduleFeatureGrant.count({
          where: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
        })
      ).toBe(1);

      expect(refused.body).toMatchObject({
        statusCode: 403,
        code: 'FEATURE_DISABLED',
        moduleId: HR_MODULE_ID,
        featureId: HR_FEATURE_ID,
      });
    } finally {
      // The platform's offer is restored whatever happens: leaving `hr/leave` disabled would
      // change the installation for every other reader of this database.
      await setOffer(true).expect(200);
    }

    // The restore is verified rather than assumed — same reason as the `finally` above.
    await asProbe('get', LEAVE_TYPES_URL).expect(200);
  });

  // ---------------------------------------------------------------------------
  // §7. The three answers the console is typed against: idempotent grant, foreign-key
  //      refusal, honest revoke — plus the granted-tenant read the operator actually sees.
  // ---------------------------------------------------------------------------

  it('§7 makes a repeated grant a 201 with granted: 0 — re-stating a desired state is not an error', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    const first = await grantViaAdminRoute([probe.tenantId]).expect(201);
    expect(first.body).toEqual({ granted: 1 });

    // The console's own retry after a dropped response, or a second operator doing the same
    // thing. `skipDuplicates` makes it a no-op, and the count reports what was ADDED — which is
    // what lets an operator tell "already granted" from "granted just now".
    const second = await grantViaAdminRoute([probe.tenantId]).expect(201);
    expect(second.body).toEqual({ granted: 0 });

    // The idempotence is a storage fact, not a response convention: exactly one row, ever.
    expect(
      await core.moduleFeatureGrant.count({
        where: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
      })
    ).toBe(1);

    // And the request is still admitted afterwards — a no-op grant did not disturb the grant.
    await asProbe('get', LEAVE_TYPES_URL).expect(200);
  });

  it('§7 answers 400 for a tenant id that does not exist — the foreign key is the authority', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();

    const unknown = `no-such-tenant-${suffix}`;
    const refused = await grantViaAdminRoute([unknown]).expect(400);

    // The refusal is the DATABASE refusing a grant about a tenant that does not exist, and the
    // service translates it into an operator sentence rather than leaking a Prisma code.
    expect(JSON.stringify(refused.body)).not.toContain('P2003');
    expect(await core.moduleFeatureGrant.count({ where: { tenantId: unknown } })).toBe(0);
  });

  it('§7 answers 404 for a revoke that removes nothing, because presence IS the grant', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    // There is no flag to flip and nothing to quietly succeed at: the operator's list was
    // stale, and a 404 says so instead of reporting a revocation that did not happen.
    await revokeViaAdminRoute(probe.tenantId).expect(404);
    expect(
      await core.moduleFeatureGrant.count({
        where: { featureRowId: leaveFeatureRowId, tenantId: probe.tenantId },
      })
    ).toBe(0);
  });

  it('§7 walks the granted-tenant read across pages, and the grant appears then disappears', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    // The read is BOUNDED, and the population is larger than one page — so the continuation
    // cursor is not a nicety, it is the difference between a complete list and a truncation the
    // operator cannot see. The population is measured from the row count, not assumed.
    const grantTotal = await core.moduleFeatureGrant.count({
      where: { featureRowId: leaveFeatureRowId },
    });
    expect(grantTotal).toBeGreaterThan(FEATURE_TENANT_PAGE_SIZE);

    const before = await readAllGrantedTenants();
    expect(before.pages).toBeGreaterThan(1);
    expect(before.ids.length).toBe(grantTotal);
    expect(before.ids).not.toContain(probe.tenantId);

    await grantViaAdminRoute([probe.tenantId]).expect(201);

    const after = await readAllGrantedTenants();
    expect(after.ids).toContain(probe.tenantId);
    expect(after.ids.length).toBe(grantTotal + 1);

    const row = after.rows.find((entry) => entry.tenantId === probe.tenantId);
    expect(row).toBeDefined();
    expect(typeof row!.grantedAt).toBe('string');

    // Revoke is a DELETE, so the tenant leaves the list rather than staying with a flag unset.
    await revokeViaAdminRoute(probe.tenantId).expect(200);

    const revoked = await readAllGrantedTenants();
    expect(revoked.ids).not.toContain(probe.tenantId);
    expect(revoked.ids.length).toBe(grantTotal);
  });

  // ---------------------------------------------------------------------------
  // §8. The trail: an administrative act on a feature is attributed to its actor.
  // ---------------------------------------------------------------------------

  it('§8 records grant and revoke on the feature ROW, attributed to the authenticated administrator', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await dropProbeGrant();

    // The boundary is the DATABASE's clock — the same authority the audit rows are timestamped
    // with — so "after" cannot be off by the skew between two clocks.
    const since = await dbNow();

    await grantViaAdminRoute([probe.tenantId]).expect(201);
    await revokeViaAdminRoute(probe.tenantId).expect(200);

    const rows = await auditRowsSince(since);

    // The PAIR, in order. Both acts happened, and a revision that recorded one without the other
    // would break this before it broke an operator's answer to "who granted this, and who took it
    // away?".
    expect(rows.map((row) => row.action)).toEqual([
      MODULE_FEATURE_ACTIONS.GRANTED,
      MODULE_FEATURE_ACTIONS.REVOKED,
    ]);

    // ATTRIBUTION IS THE ASSERTION, not a decoration. `subject(req)` reads `sub` from the
    // verified principal, so the actor is the administrator the token belongs to; no body field,
    // query parameter or header can name one — which is what makes the trail evidence.
    for (const row of rows) {
      expect(row.userId).toBe(ADMIN_USER_ID);
      // The SUBJECT of the act is the feature ROW (`moduleId:featureId`), so "who turned Leave
      // off?" is a search in the trail rather than a join through a surrogate id.
      expect(row.resourceId).toBe(`${HR_MODULE_ID}:${HR_FEATURE_ID}`);
    }

    // The tenant the act was ABOUT is on the row, so the trail answers "granted to whom?"
    // without consulting the grant table — which is the point of recording a configuration fact.
    expect(rows[0].newValue).toMatchObject({ tenantIds: [probe.tenantId], granted: 1 });
    expect(rows[1].newValue).toMatchObject({ tenantId: probe.tenantId });

    // The trail is a record of acts, so it is never shorter than the acts this test performed.
    expect(await auditCount()).toBeGreaterThanOrEqual(rows.length);
  });

  it('§8 writes NOTHING for a refusal — a trail records events, and a refused request changed nothing', async () => {
    await ensureProbeFixture();
    // Non-member, but granted and offered: every OTHER fact needed for a 200 is in place, so the
    // refusal is real and the only variable is membership.
    await dropProbeMembership();
    await ensureProbeGrant();

    const since = await dbNow();

    const refused = await asProbe('get', LEAVE_TYPES_URL).expect(403);
    expect(refused.body.code).toBe('MODULE_FORBIDDEN');

    // A denial is an ACCESS-LOG fact, not an event that happened to the system: no row is
    // written. Asserted because "we also audit denials" is the kind of plausible-sounding
    // addition that would quietly turn a refusal into a write path.
    expect(await auditRowsSince(since)).toHaveLength(0);

    await ensureProbeMembership();
  });

  // ---------------------------------------------------------------------------
  // §9. Deleting a tenant removes the statements ABOUT it — and a re-creation inherits nothing.
  // ---------------------------------------------------------------------------

  it('§9 takes the membership and the grant down WITH the tenant, and a tenant re-created under the same code starts UNENTITLED', async () => {
    // Two throwaway tenants are used here: the one that gets deleted, and its RE-CREATION under
    // a new id with the same operator-typed code (`cascadeTenantCode`). Neither is the probe, so
    // the sections above keep observing their own fixture.
    cascadeTenantId = `cascade-54c-${suffix}`;

    await core.tenant.create({
      data: { id: cascadeTenantId, code: cascadeTenantCode, status: 'ACTIVE' },
    });
    await core.moduleRegistrationTenant.create({
      data: {
        id: `cascade-54c-membership-${suffix}`,
        registrationId: hrRegistrationId,
        tenantId: cascadeTenantId,
      },
    });
    await core.moduleFeatureGrant.create({
      data: { featureRowId: leaveFeatureRowId, tenantId: cascadeTenantId },
    });

    // BEFORE: the two fact rows exist, and the platform's own decision says the tenant is
    // entitled — the state an operator granted deliberately.
    expect(await factRows(cascadeTenantId)).toEqual({ memberships: 1, grants: 1 });
    expect(await decideForTenant(cascadeTenantId)).toEqual({ ok: true });
    clearRequestContext();

    // THE ONLY ACT: the tenant row is deleted. Nothing cleans the two child tables — no service
    // hook, no timer, no sweep.
    await core.tenant.delete({ where: { id: cascadeTenantId } });

    // ...and both statements are gone, because the DATABASE owns that rule: a grant and a
    // membership are `ON DELETE CASCADE` references to `Tenant` (asserted structurally below),
    // so a statement about a thing that no longer exists cannot outlive it.
    expect(await factRows(cascadeTenantId)).toEqual({ memberships: 0, grants: 0 });

    // The decision for the SAME tenant id flips to the module-level refusal: membership was the
    // fact that admitted it, and there is now no fact at all.
    expect(await decideForTenant(cascadeTenantId)).toEqual({
      ok: false,
      failure: 'MODULE_FORBIDDEN',
    });
    clearRequestContext();

    // RE-CREATION UNDER THE SAME CODE, a new id — the case a tenancy-keyed-on-a-label would get
    // wrong. A tenant is identified by its id, so this is a NEW tenant: it inherits no
    // membership, no grant and no decision from the one that was deleted.
    cascadeRecreatedTenantId = `cascade-54c-recreated-${suffix}`;
    await core.tenant.create({
      data: { id: cascadeRecreatedTenantId, code: cascadeTenantCode, status: 'ACTIVE' },
    });

    expect(await factRows(cascadeRecreatedTenantId)).toEqual({ memberships: 0, grants: 0 });
    expect(await decideForTenant(cascadeRecreatedTenantId)).toEqual({
      ok: false,
      failure: 'MODULE_FORBIDDEN',
    });
    clearRequestContext();

    // The codes really are the same value: the test above is about the ID, not about two
    // differently-spelled labels standing in for each other.
    const codes = await core.tenant.findMany({
      where: { id: cascadeRecreatedTenantId },
      select: { code: true },
    });
    expect(codes[0].code).toBe(cascadeTenantCode);

    // THE RULE IS THE SCHEMA'S, not the outcome of one deletion: both FKs into `Tenant` are
    // `ON DELETE CASCADE` (`confdeltype = 'c'`), read from the live catalog. If a future
    // migration weakened either to `RESTRICT`/`SET NULL`, the deletions above would start
    // failing or leaving rows behind, and this assertion states where the rule lives.
    const fks = await core.$queryRawUnsafe<{ child: string; del: string }[]>(
      `SELECT c.conrelid::regclass::text AS child, c.confdeltype::text AS del
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = to_regclass('public."Tenant"')
          AND c.conrelid IN (
            to_regclass('public."ModuleRegistrationTenant"'),
            to_regclass('public."ModuleFeatureGrant"'))
        ORDER BY child`
    );
    expect(fks.map((row) => row.child)).toEqual([
      '"ModuleFeatureGrant"',
      '"ModuleRegistrationTenant"',
    ]);
    for (const row of fks) expect(row.del).toBe('c');
  });

  // ---------------------------------------------------------------------------
  // §10. Withholding entitlement is a decision about ACCESS — never a deletion of data.
  // ---------------------------------------------------------------------------

  it('§10 withdraws entitlement at all three levels and leaves `hr_db` untouched — access is not data', async () => {
    await ensureProbeFixture();
    await ensureProbeMembership();
    await ensureProbeGrant();
    await setOffer(true).expect(200);

    // Precondition: the probe can reach the catalogue at all — otherwise the writes below would
    // be refused for a reason this test does not own.
    await asProbe('get', LEAVE_TYPES_URL).expect(200);

    // THE DATA. One catalogue entry, written through the REAL HR route into `hr_db`, owned by the
    // PROBE tenant: HR takes the tenant from the request context (`tid` → the port →
    // `resolveHrActor`), never from the body, so this row belongs to the tenancy under test and
    // not to the administrator running the suite.
    const code = `ANNUAL-54C-${suffix.toUpperCase()}`;
    const created = await asProbe('post', LEAVE_TYPES_URL)
      .send({ code, name: 'مرخصی سالانه ۵۴-سی' })
      .expect(201);

    const leaveTypeId: string = created.body.id;
    probeLeaveTypeId = leaveTypeId;
    expect(created.body.tenantId).toBe(probe.tenantId);

    const before = await hrDb.leaveType.findUnique({ where: { id: leaveTypeId } });
    expect(before).not.toBeNull();
    expect(before!.code).toBe(code);

    /**
     * Re-reads the row from HR's OWN database and demands it is byte-for-byte the row that was
     * written.
     *
     * `updatedAt` IS PART OF THE ASSERTION, and it is not decoration: a withdrawal implemented as
     * a "soft delete", a status rewrite or a bulk `updateMany` behind the refusal would leave the
     * row present while moving this column — which is exactly the difference between "access was
     * withdrawn" and "data was changed". HR's `status` column is the lifecycle an OPERATOR
     * controls; entitlement must not reach for it.
     */
    const stillThere = async (): Promise<void> => {
      const row = await hrDb.leaveType.findUnique({ where: { id: leaveTypeId } });

      expect(row).not.toBeNull();
      expect(row!.id).toBe(before!.id);
      expect(row!.tenantId).toBe(probe.tenantId);
      expect(row!.code).toBe(before!.code);
      expect(row!.name).toBe(before!.name);
      expect(row!.status).toBe(before!.status);
      expect(row!.createdAt.getTime()).toBe(before!.createdAt.getTime());
      expect(row!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());

      // And it is still ONE row: nothing wrote a shadow copy while access was refused.
      expect(await hrDb.leaveType.count({ where: { tenantId: probe.tenantId } })).toBe(1);
    };

    // ── Level three: the GRANT (the last refusal in §43.5's order) ─────────────
    await revokeViaAdminRoute(probe.tenantId).expect(200);

    const withoutGrant = await asProbe('get', LEAVE_TYPES_URL).expect(403);
    expect(withoutGrant.body).toMatchObject({
      statusCode: 403,
      code: 'FEATURE_NOT_GRANTED',
      moduleId: HR_MODULE_ID,
      featureId: HR_FEATURE_ID,
    });
    await stillThere();

    // ── Level two: the OFFER (the platform stops offering the feature) ─────────
    await setOffer(false).expect(200);
    try {
      const withoutOffer = await asProbe('get', LEAVE_TYPES_URL).expect(403);
      expect(withoutOffer.body.code).toBe('FEATURE_DISABLED');
      await stillThere();
    } finally {
      // Restored whatever happens, exactly as §6 does: a suite that left `hr/leave` disabled
      // would change the installation for every other reader of this database.
      await setOffer(true).expect(200);
    }

    // ── Level one: the MEMBERSHIP (the tenancy is not a member of HR at all) ───
    await dropProbeMembership();

    const withoutModule = await asProbe('get', LEAVE_TYPES_URL).expect(403);
    expect(withoutModule.body.code).toBe('MODULE_FORBIDDEN');

    // The module-gated-only surface is refused for the SAME reason, so the refusal above is the
    // module level and not a feature coincidence.
    const employeesWithoutModule = await asProbe('get', EMPLOYEES_URL).expect(403);
    expect(employeesWithoutModule.body.code).toBe('MODULE_FORBIDDEN');

    await stillThere();

    // ── Restoration: entitlement is a SWITCH, not a migration ────────────────
    await ensureProbeMembership();
    await ensureProbeGrant();
    await asProbe('get', LEAVE_TYPES_URL).expect(200);

    // THE SAME ROW, BY ID, OVER HTTP. No repair step, no re-import, no reconciliation: the
    // withdrawal never touched the data, so access alone brings it back into view. That is the
    // operator-facing sentence this section exists to make MEASURED — HR can be withheld from a
    // tenancy and restored without losing a single record.
    const readBack = await asProbe('get', `${LEAVE_TYPES_URL}/${leaveTypeId}`).expect(200);
    expect(readBack.body.id).toBe(leaveTypeId);
    expect(readBack.body.code).toBe(code);
    expect(readBack.body.status).toBe(before!.status);

    // The withdrawals left no entitlement behind them either: the facts are exactly the two rows
    // the restoration re-created.
    expect(await factRows(probe.tenantId)).toEqual({ memberships: 1, grants: 1 });
    expect(await decideForProbeTenant()).toEqual({ ok: true });
    clearRequestContext();
  });
})
