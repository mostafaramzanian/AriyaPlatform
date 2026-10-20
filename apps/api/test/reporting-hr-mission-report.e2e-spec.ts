/**
 * Phase REPORTING-HR-MISSION-REQUEST — the HR mission-request report against the
 * real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/hr/mission-requests…`)
 *        ↓
 *   approved HR read seam → real `hr_db` MissionRequest rows
 *        ↓
 *   tenant-scoped list → detail → authoritative audit timeline → exports
 *
 * Covered (22 scenarios): the happy path with an EXACT seven-state status
 * distribution, each supported source filter (`employeeId`, `status` over the
 * closed seven, `durationMode`, the `from`/`to` INTERSECTION window incl. the
 * HOURLY same-day case, pagination), the window's intersection semantics, empty
 * results, the projection whitelist, detail, the authoritative timeline, 401/403,
 * cross-tenant list/detail/timeline in both directions, NO write route, an
 * explicit no-write STATE PROOF, and the XLSX/DOCX exports parsed back to their
 * rows — same population as the list, and tenant-safe in both directions.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client
 * (no HTTP surface provisions membership); the mission catalogue, the employees
 * and the DRAFT/CANCELLED requests are driven through the HR HTTP API — the real
 * write paths; the five flow/decision states (SUBMITTED, IN_APPROVAL,
 * CORRECTION_REQUIRED, APPROVED, REJECTED) are written through the HR Prisma
 * client because driving them end to end requires a PUBLISHED Mission policy
 * version (submit is REFUSED with 409 without one — `MissionPolicyService.
 * resolveDecision`) plus a rule document and an approval definition:
 * configuration outside this report's scope. `MissionRequest` declares NO state
 * CHECK (prisma/hr/schema.prisma + migration 20260923120000), so those fixtures
 * are writable exactly as the lifecycle stores them; their READ path is fully
 * real, and their timelines are HONESTLY EMPTY — never fabricated.
 *
 * RUN SCOPING: every tenant-A assertion is scoped by `employeeId=<our person>` —
 * the employee codes embed this run's id, so a previous run's leftovers can never
 * enter this run's population (the same isolation reasoning the leave report
 * achieves with its run-scoped type code).
 */
import * as bcrypt from 'bcryptjs';
import { makeRequest, getTestApp } from './setup';
import {
  countTag,
  EXPORT_DOCX_MIME,
  EXPORT_XLSX_MIME,
  getExportFile,
  parseXlsxSheet,
  readZipEntry,
  responseBuffer,
} from './reporting-export.fixtures';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { ensureHrReportingTestProvisioning } from './fixtures/hr-provisioning';
import { HrPrismaService } from '../src/modules/hr/database/hr-prisma.service';

type SupertestResponse = import('supertest').Response;

interface Actor {
  label: string;
  email: string;
  password: string;
  token: string;
  userId: string;
  tenantId: string;
}

interface TenantB {
  tenantId: string;
  admin: Actor;
}

const API_PREFIX = '/api/v1';
const RUN_ID = `hmrrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
} as const;

function api() {
  return makeRequest();
}

function getApp() {
  // The harness accessor throws the same invariant the local check did.
  return getTestApp();
}

function getCoreDb(): CorePrismaService {
  return getApp().get(CorePrismaService);
}

function getHrDb(): HrPrismaService {
  return getApp().get(HrPrismaService);
}

async function login(email: string, password: string): Promise<string> {
  const res = await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(200);
  const token = res.body?.data?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error(`[E2E] Login for ${email} produced no access token`);
  }
  return token;
}

async function waitForReadiness(timeoutMs = 60_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';

  while (Date.now() < deadline) {
    try {
      const health = await api().get(`${API_PREFIX}/health`);
      if (health.status !== 200) {
        lastError = `health=${health.status}`;
      } else {
        const ready = await api().get(`${API_PREFIX}/ready`);
        if (ready.status === 200 && ready.body?.status === 'ready') return;
        lastError = `ready=${ready.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[E2E] Service did not become ready within ${timeoutMs}ms: ${lastError}`);
}

async function findAdminRoleId(): Promise<string> {
  const role = await getCoreDb().role.findUnique({ where: { name: 'ADMIN' } });
  if (!role) throw new Error('[E2E] Seeded ADMIN role not found');
  return role.id;
}

async function createUser(label: string, tenantId: string, roleId?: string): Promise<Actor> {
  const email = `${label.toLowerCase()}-${RUN_ID}@e2e.local`;
  const password = `${label}-${RUN_ID}-pw`;
  const userId = `user-${label}-${RUN_ID}`;

  await getCoreDb().user.create({
    data: {
      id: userId,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      firstName: label,
      lastName: 'e2e',
      status: 'EMPLOYEE',
      tenant: { connect: { id: tenantId } },
      ...(roleId
        ? {
            userRoles: {
              create: { roleId, assignedBy: userId },
            },
          }
        : {}),
    },
  });

  return { label, email, password, token: '', userId, tenantId };
}

/**
 * A SECOND tenant entitled to `hr` AND its `mission` feature — the isolation half
 * of the slice. This report declares the same module+feature chain HR's own
 * mission reads declare (`@RequiresModule('hr')` + `@RequiresFeature('hr',
 * 'mission')`), so tenant B must hold BOTH to reach it, and tenant A's rows must
 * stay invisible either way.
 */
async function setupTenantB(roleId: string): Promise<TenantB> {
  const db = getCoreDb();
  const tenantId = `tenant-b-${RUN_ID}`;

  const tenant = await db.tenant.create({ data: { id: tenantId, code: tenantId } });

  const registration = await db.moduleRegistration.findUnique({ where: { moduleId: 'hr' } });
  if (!registration) throw new Error('[E2E] HR module registration not found');

  await db.moduleRegistrationTenant.create({
    data: { registrationId: registration.id, tenantId: tenant.id },
  });

  const feature = await db.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'hr', featureId: 'mission' } },
  });
  if (!feature) throw new Error('[E2E] hr/mission feature not found');
  await db.moduleFeatureGrant.create({
    data: { featureRowId: feature.id, tenantId: tenant.id },
  });

  const admin = await createUser('HrmTenantBAdmin', tenant.id, roleId);
  admin.token = await login(admin.email, admin.password);
  return { tenantId: tenant.id, admin };
}

async function teardownTenantB(fixture: TenantB): Promise<void> {
  const db = getCoreDb();
  await db.moduleFeatureGrant.deleteMany({ where: { tenantId: fixture.tenantId } });
  await db.moduleRegistrationTenant.deleteMany({ where: { tenantId: fixture.tenantId } });
  await db.userRole.deleteMany({ where: { userId: fixture.admin.userId } });
  await db.user.deleteMany({ where: { id: fixture.admin.userId } });
  await db.tenant.deleteMany({ where: { id: fixture.tenantId } });
}


describe('Reporting - HR Mission Request Report (seventh vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantB: TenantB;

  // Tenant A register rows — every member of the SEVEN-state lifecycle, scoped by
  // this run's own employee so a previous run's leftovers can never enter.
  let draftId = ''; // DRAFT, DAILY, 2026-11-01..03 — through the real create path
  let hourlyDraftId = ''; // DRAFT, HOURLY, 2026-11-05 08:00-09:00 — real create path
  let cancelledId = ''; // CANCELLED — real create + real cancel path
  let submittedId = ''; // SUBMITTED — Prisma fixture (policy-gated flow)
  let inApprovalId = ''; // IN_APPROVAL — Prisma fixture
  let correctionId = ''; // CORRECTION_REQUIRED — Prisma fixture (+ its own reason)
  let approvedId = ''; // APPROVED — Prisma fixture (+ approvedAt)
  let rejectedId = ''; // REJECTED — Prisma fixture (+ rejectedAt + reason)
  let tenantBRowId = ''; // tenant B's lone DRAFT row

  let employeeIdA = '';
  let employeeIdA2 = '';
  let employeeIdB = '';
  let employeeCodeA = '';
  let employeeCodeB = '';

  // Catalogue furniture (fact groups the domain REQUIRES before any create), per tenant.
  const groupIdsA: string[] = [];
  const groupIdsB: string[] = [];

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/hr/mission-requests${suffix}`;
  const envelope = <T,>(body: { data?: T } | T): T =>
    (body as { data?: T }).data ?? (body as T);
  const idsOf = (body: unknown) => ((envelope(body as { items?: unknown }).items ?? []) as { id: string }[]).map((item) => item.id);

  /** The run's own tenant-A scope — the person embeds the run id. */
  const scopeQuery = () => `employeeId=${employeeIdA}`;

  /** Unit → position → employee, returned for requesting mission against. */
  async function hireEmployee(
    token: string,
    codePrefix: string
  ): Promise<{ employeeId: string; employeeCode: string }> {
    const codeRun = RUN_ID.toUpperCase();

    const unit: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/organization/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `MUNIT-${codePrefix}-${codeRun}`, name: `واحد مأموریت ${RUN_ID}` })
      .expect(201);

    const position: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/positions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: `MPOS-${codePrefix}-${codeRun}`,
        title: `سمت مأموریت ${RUN_ID}`,
        organizationUnitId: unit.body.id,
      })
      .expect(201);

    const employee: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/employees`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeCode: `MIS-${codePrefix}-${RUN_ID}`,
        employmentType: 'FULL_TIME',
        startDate: '2024-04-01',
        organizationUnitId: unit.body.id,
        positionId: position.body.id,
      })
      .expect(201);

    return { employeeId: employee.body.id, employeeCode: employee.body.employeeCode };
  }

  /**
   * The tenant's OWN mission fact catalogue — `validateMissionOptionSelections`
   * refuses any create that does not state all three facts, so the groups must
   * exist with exactly the domain's codes (DURATION / LOCATION / ENGAGEMENT).
   *
   * hrDb-first, POST through the register: the catalogue WRITES go through the
   * real HTTP surface; the (tenant, code) pair is UNIQUE, so an existing row
   * (this run's own retry, a crashed run's leftover, or any pre-seeded row in
   * the SHARED e2e database) is REUSED rather than collided with — and only
   * FRESHLY created groups are recorded for teardown. The register's
   * `createOptionGroup` does NOT translate its own P2002 into a 409 (it answers
   * a raw 500), so the UNIQUE lookup — not an error-status guess — is what
   * decides whether to create.
   *
   * NOTE (pre-existing register drift, phase-external). The static LIST route
   * `GET /hr/missions/option-groups` answers 400 here (observed in this run),
   * because `MissionController` declares `@Get(':id')` BEFORE the static GETs —
   * so Express matches `option-groups` as an `:id` and the `ParseUUIDPipe`
   * refuses it. The report never reads that route (POST catalogue paths work
   * and are what this helper proves), so this phase documents the drift in the
   * phase record instead of redesigning the register's routes.
   */
  async function ensureMissionCatalogue(
    token: string,
    tenantId: string,
    groupSink: string[]
  ): Promise<{
    groupIds: Map<string, string>;
    optionIds: Map<string, Map<string, string>>;
  }> {
    const groupIds = new Map<string, string>();
    const optionIds = new Map<string, Map<string, string>>();
    const wanted: [string, string, string[]][] = [
      ['DURATION', 'مدت مأموریت', ['DAILY', 'HOURLY']],
      ['LOCATION', 'محل مأموریت', ['OUT_OF_CITY', 'IN_CITY']],
      ['ENGAGEMENT', 'نوع همکاری', ['NON_PROJECT']],
    ];

    for (const [code, label, optionCodes] of wanted) {
      const preexisting = await getHrDb().missionOptionGroup.findFirst({
        where: { tenantId, code },
        include: { options: { select: { id: true, code: true } } },
      });
      const existingOptions = preexisting?.options ?? [];

      let groupId: string;
      if (preexisting) {
        groupId = preexisting.id;
      } else {
        const created: SupertestResponse = await api()
          .post(`${API_PREFIX}/hr/missions/option-groups`)
          .set('Authorization', `Bearer ${token}`)
          .send({ code, label, required: true })
          .expect(201);
        // PROVEN SHAPE: the catalogue CREATES answer the repository ROW itself
        // (`{ id, tenantId, optionGroupId, code, … }`) — no `data` envelope and no
        // `group` node — and `envelope` reads `body?.data ?? body`, so it must be
        // handed the BODY. (The register's LIST routes are the ones wrapped.)
        const createdBody = envelope(created.body);
        const createdId: unknown = createdBody?.id;
        if (typeof createdId !== 'string' || createdId.length === 0) {
          throw new Error(
            `[E2E] group create for ${code} returned no id: body=${JSON.stringify(created.body).slice(0, 600)}`
          );
        }
        groupId = createdId;
        groupSink.push(groupId);
      }
      groupIds.set(code, groupId);

      for (const optionCode of optionCodes) {
        let optionId = existingOptions.find((option) => option.code === optionCode)?.id;
        if (!optionId) {
          const preexistingOption = await getHrDb().missionOption.findFirst({
            where: { tenantId, optionGroupId: groupId, code: optionCode },
          });
          optionId = preexistingOption?.id;
        }
        if (!optionId) {
          // PROVEN SHAPES ONLY. The register stores the fact tokens VERBATIM —
          // `MISSION_FACT_OPTIONS` keys are exactly the UPPER codes the domain
          // reads, and the service trims them — so what is sent here is what is
          // selected: no CASE suffix, no run prefix, no per-run isolation on a
          // CLASSIFICATION vocabulary. Attempting `DAILY-hmrrep-…` would write an
          // `unmapped-option` refusal into a valid code instead.
          const created: SupertestResponse = await api()
            .post(`${API_PREFIX}/hr/missions/option-groups/${groupId}/options`)
            .set('Authorization', `Bearer ${token}`)
            .send({ code: optionCode, label: optionCode })
            .expect(201);
          // The option CREATE answers the repository ROW itself — the same
          // `envelope(created.body)` rule the group create above states.
          const createdBody = envelope(created.body);
          const createdId: unknown = createdBody?.id;
          if (typeof createdId !== 'string' || createdId.length === 0) {
            throw new Error(
              `[E2E] option create for ${code}/${optionCode} returned no id: body=${JSON.stringify(created.body).slice(0, 600)}`
            );
          }
          optionId = createdId;
        }
        if (!optionIds.has(code)) optionIds.set(code, new Map());
        optionIds.get(code)!.set(optionCode, optionId);
      }
    }

    return { groupIds, optionIds };
  }

  /** A DRAFT request through the ordinary register — the real write path. */
  async function createMission(
    token: string,
    employeeId: string,
    catalogue: { groupIds: Map<string, string>; optionIds: Map<string, Map<string, string>> },
    body: {
      duration: 'DAILY' | 'HOURLY';
      startDate: string;
      endDate: string;
      startTime?: string;
      endTime?: string;
      destination?: string;
    }
  ): Promise<string> {
    const optionOf = (group: string, option: string): string => {
      const id = catalogue.optionIds.get(group)?.get(option);
      if (!id) throw new Error(`[E2E] catalogue missing ${group}/${option}`);
      return id;
    };
    const groupIdOf = (group: string): string => {
      const id = catalogue.groupIds.get(group);
      if (!id) throw new Error(`[E2E] catalogue missing group ${group}`);
      return id;
    };

    const sentPayload = {
      employeeId,
      startDate: body.startDate,
      endDate: body.endDate,
      ...(body.startTime ? { startTime: body.startTime } : {}),
      ...(body.endTime ? { endTime: body.endTime } : {}),
      ...(body.destination ? { destination: body.destination } : {}),
      description: `درخواست e2e ${RUN_ID}`,
      selections: [
        {
          optionGroupId: groupIdOf('DURATION'),
          missionOptionId: optionOf('DURATION', body.duration),
        },
        {
          optionGroupId: groupIdOf('LOCATION'),
          missionOptionId: optionOf('LOCATION', 'OUT_OF_CITY'),
        },
        {
          optionGroupId: groupIdOf('ENGAGEMENT'),
          missionOptionId: optionOf('ENGAGEMENT', 'NON_PROJECT'),
        },
      ],
    };

    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/missions`)
      .set('Authorization', `Bearer ${token}`)
      .send(sentPayload)
      .then()
      .catch((error) => {
        throw new Error(
          `[E2E] mission create failed: ${JSON.stringify(error?.response?.body ?? error?.message)} raw=${JSON.stringify(error?.response?.text ?? '').slice(0, 600)}`
        );
      });
    const responseBody = envelope(res.body);
    if (responseBody?.status !== 'DRAFT') {
      // Diagnose the validator's inputs — which group/option the register cannot
      // see, with its stored flags.
      const probe: unknown[] = [];
      for (const byOption of catalogue.optionIds.values()) {
        for (const optionId of byOption.values()) {
          const option = await getHrDb().missionOption.findUnique({
            where: { id: optionId },
            select: { id: true, code: true, active: true, optionGroupId: true },
          });
          const group = option
            ? await getHrDb().missionOptionGroup.findUnique({
                where: { id: option.optionGroupId },
                select: { id: true, code: true, active: true, tenantId: true },
              })
            : null;
          probe.push({ option, group });
        }
      }
      const groupsInDb = await getHrDb().missionOptionGroup.findMany({
        where: { tenantId: admin.tenantId },
        select: { id: true, code: true, active: true, required: true },
      });
      throw new Error(
        `[E2E] mission create answered no DRAFT status: body=${JSON.stringify(responseBody).slice(0, 300)} SENT=${JSON.stringify(sentPayload).slice(0, 700)} groupsInDb=${JSON.stringify(groupsInDb)}`
      );
    }
    const createdId = responseBody?.id;
    if (typeof createdId !== 'string' || createdId.length === 0) {
      throw new Error(
        `[E2E] mission create returned no id: ${JSON.stringify(responseBody).slice(0, 600)}`
      );
    }
    return createdId;
  }


  beforeAll(async () => {
    await waitForReadiness();

    // Test-only provisioning for THIS tenant, and it MUST run BEFORE any login: login resolves
    // the caller's permission claim through the PermissionSource port (which caches its answer),
    // so a grant written after the first token is minted leaves every later request carrying a
    // permission-empty identity — and every HR write below would answer 403 instead of 201.
    // Shapes mirrored, nothing else touched: fixtures/hr-provisioning.ts.
    await ensureHrReportingTestProvisioning(getCoreDb(), ['tenant-test-1']);

    const roleId = await findAdminRoleId();

    const seeded = await login('admin@localhost', PASSWORDS.seededAdmin);
    admin = {
      label: 'SeededAdmin',
      email: 'admin@localhost',
      password: PASSWORDS.seededAdmin,
      token: seeded,
      userId: 'super-admin-user',
      tenantId: 'tenant-test-1',
    };

    noRead = await createUser('HrmNoRead', admin.tenantId);
    noRead.token = await login(noRead.email, noRead.password);
    tenantB = await setupTenantB(roleId);

    // Tenant A: the fact catalogue, two employees, then EIGHT requests covering
    // every member of the SEVEN-state lifecycle — three through the ordinary
    // register (two DRAFT incl. one HOURLY, one then CANCELLED) and five
    // flow/decision fixtures written directly, because reaching those states end
    // to end requires a PUBLISHED Mission policy (submit is refused without one).
    const catalogueA = await ensureMissionCatalogue(admin.token, admin.tenantId, groupIdsA);

    const empA = await hireEmployee(admin.token, 'A');
    employeeIdA = empA.employeeId;
    employeeCodeA = empA.employeeCode;

    const empA2 = await hireEmployee(admin.token, 'A2');
    employeeIdA2 = empA2.employeeId;

    draftId = await createMission(admin.token, employeeIdA, catalogueA, {
      duration: 'DAILY',
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      destination: 'شیراز',
    });
    hourlyDraftId = await createMission(admin.token, employeeIdA, catalogueA, {
      duration: 'HOURLY',
      startDate: '2026-11-05',
      endDate: '2026-11-05',
      startTime: '08:00',
      endTime: '09:00',
    });
    cancelledId = await createMission(admin.token, employeeIdA, catalogueA, {
      duration: 'DAILY',
      startDate: '2026-11-11',
      endDate: '2026-11-12',
    });
    await api()
      .post(`${API_PREFIX}/hr/missions/${cancelledId}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: `انصراف e2e ${RUN_ID}` })
      .expect(200);

    // The five states the policy-gated flow owns — written exactly as the
    // lifecycle stores them (`MissionRequest` declares NO state CHECK), with the
    // instants each state's own columns carry.
    const now = new Date();
    const hrDb = getHrDb();
    const d = (day: number) => new Date(Date.UTC(2026, 10, day));

    submittedId = (
      await hrDb.missionRequest.create({
        data: {
          tenantId: admin.tenantId,
          employeeId: employeeIdA,
          durationMode: 'DAILY',
          locationType: 'OUT_OF_CITY',
          engagementType: 'NON_PROJECT',
          startDate: d(14),
          endDate: d(14),
          status: 'SUBMITTED',
          submittedRevision: 1,
        },
      })
    ).id;

    inApprovalId = (
      await hrDb.missionRequest.create({
        data: {
          tenantId: admin.tenantId,
          employeeId: employeeIdA,
          durationMode: 'DAILY',
          locationType: 'OUT_OF_CITY',
          engagementType: 'NON_PROJECT',
          startDate: d(16),
          endDate: d(17),
          status: 'IN_APPROVAL',
          submittedRevision: 1,
        },
      })
    ).id;

    correctionId = (
      await hrDb.missionRequest.create({
        data: {
          tenantId: admin.tenantId,
          employeeId: employeeIdA,
          durationMode: 'DAILY',
          locationType: 'OUT_OF_CITY',
          engagementType: 'NON_PROJECT',
          startDate: d(18),
          endDate: d(19),
          status: 'CORRECTION_REQUIRED',
          submittedRevision: 1,
          correctionReason: 'مقصد را دقیق‌تر بنویسید.',
        },
      })
    ).id;

    approvedId = (
      await hrDb.missionRequest.create({
        data: {
          tenantId: admin.tenantId,
          employeeId: employeeIdA,
          durationMode: 'DAILY',
          locationType: 'OUT_OF_CITY',
          engagementType: 'NON_PROJECT',
          startDate: d(21),
          endDate: d(22),
          status: 'APPROVED',
          submittedRevision: 1,
          approvedAt: now,
        },
      })
    ).id;

    rejectedId = (
      await hrDb.missionRequest.create({
        data: {
          tenantId: admin.tenantId,
          employeeId: employeeIdA,
          durationMode: 'DAILY',
          locationType: 'OUT_OF_CITY',
          engagementType: 'NON_PROJECT',
          startDate: d(24),
          endDate: d(24),
          status: 'REJECTED',
          submittedRevision: 1,
          rejectedAt: now,
          rejectionReason: 'بازه با برنامهٔ تیم هم‌پوشانی دارد.',
        },
      })
    ).id;

    // Tenant B: its own catalogue and one DRAFT request — the isolation probe.
    const catalogueB = await ensureMissionCatalogue(
      tenantB.admin.token,
      tenantB.tenantId,
      groupIdsB
    );
    const empB = await hireEmployee(tenantB.admin.token, 'B');
    employeeIdB = empB.employeeId;
    employeeCodeB = empB.employeeCode;
    tenantBRowId = await createMission(tenantB.admin.token, employeeIdB, catalogueB, {
      duration: 'DAILY',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
    });
  }, 180_000);


  /**
   * THE REGISTER'S STATIC GETs — reachable, and deliberately so.
   *
   * This test used to assert 400 for all three static paths, documenting a real shadowing
   * defect: `@Get(':id')` was declared BEFORE the static family, Express matched
   * `approval-definitions` as `:id`, and `ParseUUIDPipe` refused it with 400. That defect is
   * FIXED in the register itself — `@Get(':id')` now sits LAST, with the reason written into the
   * controller (`mission.controller.ts:338-345`, "DECLARED LAST ON PURPOSE"), after
   * `option-groups` (185), `approval-definitions` (236) and `policy-versions` (283).
   *
   * Measured on the isolated cluster, once this suite's own tenant-A entitlement was
   * provisioned: every one of the three static paths answers 200. (Before that provisioning
   * every call here was a 403 from `RolesGuard`, so the assertion could not see the route order
   * at all — which is why the stale expectation survived.) The expectation below is therefore
   * updated to the product's CURRENT, intended behaviour; the drift this spec documented is
   * closed in the product, not waived here. The report itself still never reads the register's
   * static lists — this test remains report-external documentation of the register's surface.
   */
  it('reaches the register’s static GETs — the :id shadowing this spec documented is gone', async () => {
    for (const path of ['approval-definitions', 'option-groups', 'policy-versions']) {
      const res: SupertestResponse = await api()
        .get(`${API_PREFIX}/hr/missions/${path}`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });


  it('lists this tenant’s scoped register WITH its summary — the SEVEN states exact', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(Array.isArray(page.items)).toBe(true);
    expect(idsOf(res.body).sort()).toEqual(
      [
        draftId,
        hourlyDraftId,
        cancelledId,
        submittedId,
        inApprovalId,
        correctionId,
        approvedId,
        rejectedId,
      ].sort()
    );

    // The summary strip is over the SAME population — total matches, and every one
    // of the seven lifecycle members is present with its exact count.
    expect(page.summary.total).toBe(8);
    expect(page.summary.byStatus).toEqual({
      DRAFT: 2,
      SUBMITTED: 1,
      IN_APPROVAL: 1,
      CORRECTION_REQUIRED: 1,
      APPROVED: 1,
      REJECTED: 1,
      CANCELLED: 1,
    });
    // Exactly seven keys — no COMPLETED, no PENDING, no invented member.
    expect(Object.keys(page.summary.byStatus)).toHaveLength(7);
  });

  it('projects EXACTLY the contract whitelist — no tenant, no internal ids, no instants', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&status=APPROVED`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const [row] = envelope(res.body).items as Record<string, unknown>[];
    expect(row).toBeDefined();
    // Sorted by JS default `sort()` — UTF-16 code units, so `endDate` (D = 0x44)
    // precedes `endTime` (d = 0x64), and `description` (c) precedes `destination` (t).
    expect(Object.keys(row!).sort()).toEqual([
      'correctionReason',
      'createdAt',
      'description',
      'destination',
      'durationMode',
      'employeeCode',
      'endDate',
      'endTime',
      'engagementType',
      'id',
      'locationType',
      'rejectionReason',
      'startDate',
      'startTime',
      'status',
      'submittedRevision',
    ]);
    for (const forbidden of [
      'tenantId',
      'employeeId',
      'approvedAt',
      'rejectedAt',
      'cancelledAt',
      'updatedAt',
      'optionSelections',
    ]) {
      expect(Object.keys(row!)).not.toContain(forbidden);
    }
    expect(row!.durationMode).toBe('DAILY');
    expect(row!.locationType).toBe('OUT_OF_CITY');
    expect(row!.engagementType).toBe('NON_PROJECT');
    expect(row!.startDate).toBe('2026-11-21');
    expect(row!.endDate).toBe('2026-11-22');
    expect(row!.submittedRevision).toBe(1);
    expect(row!.correctionReason).toBeNull();
    expect(row!.rejectionReason).toBeNull();
  });

  it('filters by every member of the closed status vocabulary', async () => {
    const expectations: [string, string[]][] = [
      ['DRAFT', [draftId, hourlyDraftId]],
      ['SUBMITTED', [submittedId]],
      ['IN_APPROVAL', [inApprovalId]],
      ['CORRECTION_REQUIRED', [correctionId]],
      ['APPROVED', [approvedId]],
      ['REJECTED', [rejectedId]],
      ['CANCELLED', [cancelledId]],
    ];

    for (const [status, expected] of expectations) {
      const res: SupertestResponse = await api()
        .get(reportUrl(`?${scopeQuery()}&status=${status}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      expect(idsOf(res.body).sort()).toEqual([...expected].sort());
      // The summary zeroes the members the filter excludes — a closed vocabulary,
      // always fully present with exactly seven keys.
      const byStatus = envelope(res.body).summary.byStatus as Record<string, number>;
      expect(Object.keys(byStatus)).toHaveLength(7);
      for (const [member, count] of Object.entries(byStatus)) {
        const expectedCount = member === status ? expected.length : 0;
        expect({ status, member, count }).toEqual({ status, member, count: expectedCount });
      }
      for (const row of envelope(res.body).items as { status: string }[]) {
        expect(row.status).toBe(status);
      }
    }
  });

  it('filters by the mission duration classification — DAILY vs HOURLY', async () => {
    const daily: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&durationMode=DAILY`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(daily.body).sort()).toEqual(
      [
        draftId,
        cancelledId,
        submittedId,
        inApprovalId,
        correctionId,
        approvedId,
        rejectedId,
      ].sort()
    );
    expect(envelope(daily.body).summary.byStatus.DRAFT).toBe(1);

    const hourly: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&durationMode=HOURLY`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(hourly.body)).toEqual([hourlyDraftId]);
    expect(envelope(hourly.body).summary.byStatus).toEqual({
      DRAFT: 1,
      SUBMITTED: 0,
      IN_APPROVAL: 0,
      CORRECTION_REQUIRED: 0,
      APPROVED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    });
  });

  it('filters by the person the request is FOR — and an employee with none is empty', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?employeeId=${employeeIdA}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(res.body)).toHaveLength(8);

    const none: SupertestResponse = await api()
      .get(reportUrl(`?employeeId=${employeeIdA2}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(none.body).items).toEqual([]);
    expect(envelope(none.body).summary.total).toBe(0);
    expect(envelope(none.body).summary.byStatus).toEqual({
      DRAFT: 0,
      SUBMITTED: 0,
      IN_APPROVAL: 0,
      CORRECTION_REQUIRED: 0,
      APPROVED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    });
  });

  it('reads the window as INTERSECTION with the mission period — not containment', async () => {
    // The LONG DRAFT (2026-11-01…03) has only its LAST day inside this single-day
    // window: a containment filter would hide it, intersection keeps it.
    const lastDay: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-03&to=2026-11-03`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(lastDay.body)).toEqual([draftId]);

    // The HOURLY mission's start == end — a single-day window on that day catches
    // exactly it (times are never a query dimension).
    const hourlyDay: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-05&to=2026-11-05`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(hourlyDay.body)).toEqual([hourlyDraftId]);

    // Partial overlaps both ways: the CANCELLED record ENDS on the filter's first
    // day, the IN_APPROVAL record STARTS on the filter's last day, the SUBMITTED
    // record is fully contained — everything else lies outside.
    const overlap: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-11&to=2026-11-16`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(overlap.body).sort()).toEqual(
      [cancelledId, submittedId, inApprovalId].sort()
    );
  });

  it('answers an empty page with its summary — no rows is not an error', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2027-01-01&to=2027-01-02`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.summary.total).toBe(0);
    expect(page.summary.byStatus).toEqual({
      DRAFT: 0,
      SUBMITTED: 0,
      IN_APPROVAL: 0,
      CORRECTION_REQUIRED: 0,
      APPROVED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    });
  });

  it('paginates through the server — the page window is echoed back', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&pageSize=3&page=1`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(envelope(res.body).items).toHaveLength(3);
    expect(envelope(res.body).total).toBe(8);
    expect(envelope(res.body).pageSize).toBe(3);
    expect(envelope(res.body).page).toBe(1);
  });

  it('refuses filters the source does not have — never a silent no-op', async () => {
    // The mission register declares NO search parameter — a Reporting parameter
    // the source never answers would silently match everything.
    const search: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(RUN_ID)}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(search.status).toBe(422);

    const unknownStatus: SupertestResponse = await api()
      .get(reportUrl(`?status=ARCHIVED`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(unknownStatus.status).toBe(422);

    // The register STORES location/engagement but declares no filter for them.
    const location: SupertestResponse = await api()
      .get(reportUrl(`?locationType=IN_CITY`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(location.status).toBe(422);

    const engagement: SupertestResponse = await api()
      .get(reportUrl(`?engagementType=PROJECT`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(engagement.status).toBe(422);
  });

  it('refuses a client-supplied tenantId — the scope is server-side, not a field', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?tenantId=${admin.tenantId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses an inverted or impossible window — the register’s own 400', async () => {
    const inverted: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-05&to=2026-11-01`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(inverted.status).toBe(400);

    const impossible: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-02-31`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(impossible.status).toBe(400);
  });


  it('reads one request’s detail — same whitelist, tenant-scoped', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${cancelledId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      id: cancelledId,
      employeeCode: employeeCodeA,
      status: 'CANCELLED',
      durationMode: 'DAILY',
      locationType: 'OUT_OF_CITY',
      engagementType: 'NON_PROJECT',
      startDate: '2026-11-11',
      endDate: '2026-11-12',
      startTime: null,
      endTime: null,
      correctionReason: null,
      rejectionReason: null,
      submittedRevision: null,
    });
    expect(res.body.createdAt).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('tenantId');
    expect(res.body).not.toHaveProperty('employeeId');
    expect(res.body).not.toHaveProperty('cancelledAt');
    expect(res.body).not.toHaveProperty('approvedAt');
  });

  it('renders the flow-owned facts a fixture row carries — reasons and revision verbatim', async () => {
    const correction: SupertestResponse = await api()
      .get(reportUrl(`/${correctionId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(correction.body.status).toBe('CORRECTION_REQUIRED');
    expect(correction.body.correctionReason).toBe('مقصد را دقیق‌تر بنویسید.');
    expect(correction.body.submittedRevision).toBe(1);
    expect(correction.body.rejectionReason).toBeNull();

    const rejected: SupertestResponse = await api()
      .get(reportUrl(`/${rejectedId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(rejected.body.rejectionReason).toBe('بازه با برنامهٔ تیم هم‌پوشانی دارد.');
    expect(rejected.body.correctionReason).toBeNull();

    const hourly: SupertestResponse = await api()
      .get(reportUrl(`/${hourlyDraftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(hourly.body.durationMode).toBe('HOURLY');
    expect(hourly.body.startTime).toBe('08:00');
    expect(hourly.body.endTime).toBe('09:00');
    expect(hourly.body.startDate).toBe(hourly.body.endDate);
  });

  it('answers 404 for a foreign or unknown id — on detail AND timeline, both directions', async () => {
    const foreignDetail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(foreignDetail.status).toBe(404);

    const unknownDetail: SupertestResponse = await api()
      .get(reportUrl(`/00000000-0000-4000-8000-000000000000`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(unknownDetail.status).toBe(404);

    const foreignTimeline: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(foreignTimeline.status).toBe(404);

    // …and the mirror: tenant B cannot reach tenant A's row either.
    const reverseDetail: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`);
    expect(reverseDetail.status).toBe(404);

    const reverseTimeline: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}/timeline`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`);
    expect(reverseTimeline.status).toBe(404);
  });

  it('exposes the AUTHORITATIVE audit timeline — recorded actions, never inferred', async () => {
    // A request created through the register carries its own `create` act.
    const created: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(created.body.total).toBeGreaterThanOrEqual(1);
    expect(created.body.items.map((item: { action: string }) => item.action)).toEqual(
      expect.arrayContaining(['create'])
    );

    // The cancellation carries BOTH acts — creation and the cancel with its stated
    // reason — on the same resource, from the same trail.
    const cancelled: SupertestResponse = await api()
      .get(reportUrl(`/${cancelledId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const actions = cancelled.body.items.map((item: { action: string }) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'cancel']));

    // The policy-gated fixtures were written directly, so their timeline is an
    // HONEST empty page — nothing was routed through a service, so nothing was
    // audited — never a fabricated event.
    const fixtureTimeline: SupertestResponse = await api()
      .get(reportUrl(`/${approvedId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(fixtureTimeline.body.total).toBe(0);
    expect(fixtureTimeline.body.items).toEqual([]);
  });

  it('denies a user without hr.mission.read — no report, no detail, no timeline', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(detail.status).toBe(403);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}/timeline`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(timeline.status).toBe(403);
  });

  it('answers 401 for an anonymous caller on every read family', async () => {
    expect((await api().get(reportUrl())).status).toBe(401);
    expect((await api().get(reportUrl(`/${draftId}`))).status).toBe(401);
    expect((await api().get(reportUrl(`/${draftId}/timeline`))).status).toBe(401);
    expect((await api().get(reportUrl('/export/xlsx'))).status).toBe(401);
    expect((await api().get(reportUrl('/export/docx'))).status).toBe(401);
  });

  it('keeps the register tenant-scoped in BOTH directions', async () => {
    // Tenant B's own scope holds its own row only.
    const forB: SupertestResponse = await api()
      .get(reportUrl(`?employeeId=${employeeIdB}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);
    expect(idsOf(forB.body)).toEqual([tenantBRowId]);

    // Asking tenant B for tenant A's person answers an EMPTY page (the filter
    // matches nothing inside B's tenant) — never tenant A's rows.
    const crossProbe: SupertestResponse = await api()
      .get(reportUrl(`?employeeId=${employeeIdA}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);
    expect(envelope(crossProbe.body).items).toEqual([]);

    // And tenant A's scope never contains tenant B's row.
    const forA: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(forA.body)).not.toContain(tenantBRowId);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'APPROVED' });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api()
      .delete(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(del.status).toBe(404);

    // The register's own verbs do not exist under the reporting path either.
    for (const verb of ['submit', 'cancel', 'approve']) {
      const res: SupertestResponse = await api()
        .post(reportUrl(`/${draftId}/${verb}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .send({});
      expect({ verb, status: res.status }).toEqual({ verb, status: 404 });
    }
  });

  it('PROVES no write — the source rows are byte-identical after every read family', async () => {
    const hrDb = getHrDb();
    const snapshot = async () => {
      const count = await hrDb.missionRequest.count({
        where: { tenantId: admin.tenantId, employeeId: employeeIdA },
      });
      // `findUnique` refuses an empty uuid outright, so only a real id is read.
      const draft = draftId ? await hrDb.missionRequest.findUnique({ where: { id: draftId } }) : null;
      const cancelled = cancelledId
        ? await hrDb.missionRequest.findUnique({ where: { id: cancelledId } })
        : null;
      return { count, draft, cancelled };
    };

    const before = await snapshot();

    // Every read family, back to back, on the SAME rows.
    await api()
      .get(reportUrl(`?${scopeQuery()}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${draftId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await getExportFile(api(), reportUrl(`/export/xlsx?${scopeQuery()}`), admin.token).expect(
      200
    );
    await getExportFile(api(), reportUrl(`/export/docx?${scopeQuery()}`), admin.token).expect(
      200
    );

    const after = await snapshot();
    expect(after.count).toBe(before.count);
    // Full-row equality: status, instants, revision, reasons — nothing moved.
    expect(after.draft).toEqual(before.draft);
    expect(after.cancelled).toEqual(before.cancelled);
  }, 60_000);


  it('exports the SAME scope as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and both file routes answer the
    // SAME `?employeeId=…` question, and the parsed documents describe exactly
    // those eight rows.
    const scope = scopeQuery();
    const list: SupertestResponse = await api()
      .get(reportUrl(`?${scope}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items).toHaveLength(8);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      reportUrl(`/export/xlsx?${scope}`),
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="hr-mission-request-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'کد پرسنلی');
    expect(sheet.header).toEqual([
      'کد پرسنلی',
      'حالت مدت',
      'محل',
      'نوع همکاری',
      'از تاریخ',
      'تا تاریخ',
      'ساعت شروع',
      'ساعت پایان',
      'مقصد',
      'وضعیت',
      'دلیل اصلاح',
      'دلیل رد',
      'ثبت',
    ]);
    expect(sheet.data).toHaveLength(8);
    expect(sheet.data.map((row) => row[0]).sort()).toEqual(
      listed.items.map((item: { employeeCode: string }) => item.employeeCode).sort()
    );
    // Every state word the SEVEN-member lifecycle declares appears in the
    // exported status column (index 9) — the eight rows cover all seven.
    expect(sheet.data.map((row) => row[9])).toEqual(
      expect.arrayContaining([
        'پیش‌نویس',
        'ارسال‌شده',
        'در گردش تأیید',
        'نیازمند اصلاح',
        'تأییدشده',
        'ردشده',
        'لغوشده',
      ])
    );
    // The HOURLY row carries its clock times verbatim in the file.
    expect(sheet.data.map((row) => row[6])).toContain('08:00');
    // The metadata block above the table exists: «خلاصه» heads the summary counts.
    expect(sheet.firstColumn).toContain('خلاصه');

    const docx: SupertestResponse = await getExportFile(
      api(),
      reportUrl(`/export/docx?${scope}`),
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="hr-mission-request-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش وضعیت درخواست‌های مأموریت');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no register row id.
    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain(draftId);
  });

  it('refuses the export to an unauthorized actor, and keeps it tenant-safe', async () => {
    const denied: SupertestResponse = await api()
      .get(reportUrl(`/export/xlsx?${scopeQuery()}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);

    const anonymous: SupertestResponse = await api().get(reportUrl('/export/docx'));
    expect(anonymous.status).toBe(401);

    // Tenant B's export holds tenant B's rows only — tenant A's employee codes are
    // not in the file.
    const foreign: SupertestResponse = await getExportFile(
      api(),
      reportUrl('/export/xlsx'),
      tenantB.admin.token
    ).expect(200);
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'کد پرسنلی');
    expect(foreignSheet.data.map((row) => row[0])).toContain(employeeCodeB);
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(employeeCodeA);
  });


  afterAll(async () => {
    // beforeAll may have failed before the seeded admin resolved — nothing of
    // this run exists yet in that case, and `admin.tenantId` below would throw
    // over the REAL failure.
    if (!admin?.tenantId) return;

    const hrDb = getHrDb();
    const db = getCoreDb();

    // Guard: `findUnique` refuses an empty uuid outright (client-side validation),
    // while `deleteMany({ in: [] })` is a match-nothing no-op — so falsy person ids
    // are filtered for the column reads and the bulk deletes stay total.
    const personIdsA = [employeeIdA, employeeIdA2].filter((id) => id && id.length > 0);
    const personIdB = employeeIdB && employeeIdB.length > 0 ? employeeIdB : null;

    // Tenant B's HR rows FIRST — the catalogue and the person must go before the
    // tenant row they are tenant-scoped by, and the request RESTRICTs everything
    // beneath it: selections → requests → catalogue → person → org furniture.
    if (personIdB) {
      await hrDb.missionRequestOptionSelection
        .deleteMany({ where: { tenantId: tenantB.tenantId } })
        .catch(() => undefined);
      await hrDb.missionRequest
        .deleteMany({ where: { tenantId: tenantB.tenantId, employeeId: personIdB } })
        .catch(() => undefined);
    }
    for (const groupId of groupIdsB) {
      await hrDb.missionOption
        .deleteMany({ where: { optionGroupId: groupId } })
        .catch(() => undefined);
      await hrDb.missionOptionGroup.deleteMany({ where: { id: groupId } }).catch(() => undefined);
    }
    if (personIdB) {
      await hrDb.employmentRecord
        .deleteMany({ where: { employeeId: personIdB } })
        .catch(() => undefined);
      await hrDb.employee.deleteMany({ where: { id: personIdB } }).catch(() => undefined);
    }

    await teardownTenantB(tenantB).catch(() => undefined);

    // Tenant A: selections + requests first (they RESTRICT everything beneath),
    // then the run's own catalogue rows, then the two people. The selection table
    // has NO employee column, so the run's row ids are resolved first.
    const rowIdsA = personIdsA.length
      ? (
          await hrDb.missionRequest.findMany({
            where: { tenantId: admin.tenantId, employeeId: { in: personIdsA } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];
    await hrDb.missionRequestOptionSelection
      .deleteMany({ where: { missionRequestId: { in: rowIdsA } } })
      .catch(() => undefined);
    await hrDb.missionRequest
      .deleteMany({ where: { id: { in: rowIdsA } } })
      .catch(() => undefined);
    for (const groupId of groupIdsA) {
      await hrDb.missionOption
        .deleteMany({ where: { optionGroupId: groupId } })
        .catch(() => undefined);
      await hrDb.missionOptionGroup.deleteMany({ where: { id: groupId } }).catch(() => undefined);
    }

    await hrDb.employmentRecord
      .deleteMany({ where: { employeeId: { in: personIdsA } } })
      .catch(() => undefined);
    await hrDb.employee
      .deleteMany({ where: { id: { in: personIdsA } } })
      .catch(() => undefined);

    // Run-scoped catalogue rows: every code embeds the RUN_ID (upper-cased to match
    // `HR_CODE_PATTERN`), so this run's furniture is removed and no other fixture is
    // touched. `contains` is case-sensitive, hence the same upper-casing.
    const codeRun = RUN_ID.toUpperCase();
    await hrDb.position.deleteMany({ where: { code: { contains: codeRun } } }).catch(() => undefined);
    await hrDb.organizationUnit
      .deleteMany({ where: { code: { contains: codeRun } } })
      .catch(() => undefined);

    await db.user.deleteMany({ where: { id: noRead.userId } }).catch(() => undefined);
  }, 60_000);
});
