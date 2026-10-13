/**
 * Phase REPORTING-HR-LEAVE-REQUEST — the HR leave-request report against the
 * real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/hr/leave-requests…`)
 *        ↓
 *   approved HR read seam → real `hr_db` LeaveRequest rows
 *        ↓
 *   tenant-scoped list → detail → authoritative audit timeline
 *
 * Covered: the happy path with an EXACT four-state status distribution, each
 * supported source filter (`employeeId`, `leaveTypeId`, `status`, the `from`/`to`
 * INTERSECTION window, pagination), the window's intersection semantics, empty
 * results, the projection whitelist, detail, the authoritative timeline, 401/403,
 * cross-tenant list/detail/timeline in both directions, NO write route, and the
 * XLSX/DOCX exports parsed back to their rows — same population as the list, and
 * tenant-safe in both directions.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client
 * (no HTTP surface provisions membership), the business data itself is driven
 * through the HR HTTP API — unit → position → employee → leave type → leave
 * requests → withdrawal — and the report is read exclusively through the
 * Reporting HTTP API — the slice under test.
 *
 * DECISION-STATE FIXTURES: `APPROVED`/`REJECTED` rows are written through the HR
 * Prisma client (the same fixture mechanism `hr.e2e-spec.ts` §12.6 uses), honoring
 * `LeaveRequest_state_check` (`approved_at`/`rejected_at` set exactly as the
 * state requires), because driving a real approval flow end to end requires a
 * published policy version with an approval definition — configuration outside
 * this report's scope. The READ path for those rows is still fully real.
 *
 * RUN SCOPING: the leave type code embeds this run's id, and every tenant-A
 * assertion is scoped by `leaveTypeId=<our type>` — the report has no `search`
 * filter (the register ignores one), so the run's rows are isolated by the type
 * and employee, never by a filter the source does not have.
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
const RUN_ID = `hlrrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
 * A SECOND tenant entitled to `hr` AND its `leave` feature — the isolation half
 * of the slice. This report declares the same module+feature chain HR's own
 * leave reads declare (`@RequiresModule('hr')` + `@RequiresFeature('hr',
 * 'leave')`), so tenant B must hold BOTH to reach it, and tenant A's rows must
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
    where: { moduleId_featureId: { moduleId: 'hr', featureId: 'leave' } },
  });
  if (!feature) throw new Error('[E2E] hr/leave feature not found');
  await db.moduleFeatureGrant.create({
    data: { featureRowId: feature.id, tenantId: tenant.id },
  });

  const admin = await createUser('HlTenantBAdmin', tenant.id, roleId);
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


describe('Reporting - HR Leave Request Report (sixth vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantB: TenantB;

  // Tenant A register rows, each naming its period and state in the fixture.
  let pendingLongId = '';
  let pendingSingleId = '';
  let cancelledId = '';
  let approvedId = '';
  let rejectedId = '';
  let tenantBRowId = '';
  let employeeIdA = '';
  let employeeIdA2 = '';
  let employeeIdB = '';
  let employeeCodeA = '';
  let employeeCodeB = '';
  let leaveTypeId = '';
  let leaveTypeCode = '';
  let leaveTypeIdB = '';

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/hr/leave-requests${suffix}`;
  const envelope = <T,>(body: { data?: T } | T): T =>
    (body as { data?: T }).data ?? (body as T);
  const idsOf = (body) => envelope(body).items.map((item) => item.id);

  /** The run's own tenant-A scope — the type embeds the run id, so only this run's rows. */
  const scopeQuery = () => `leaveTypeId=${leaveTypeId}`;

  /** Unit → position → employee, returned for requesting leave against. */
  async function hireEmployee(
    token: string,
    codePrefix: string
  ): Promise<{ employeeId: string; employeeCode: string }> {
    const codeRun = RUN_ID.toUpperCase();

    const unit: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/organization/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `LUNIT-${codePrefix}-${codeRun}`, name: `واحد مرخصی ${RUN_ID}` })
      .expect(201);

    const position: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/positions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: `LPOS-${codePrefix}-${codeRun}`,
        title: `سمت مرخصی ${RUN_ID}`,
        organizationUnitId: unit.body.id,
      })
      .expect(201);

    const employee: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/employees`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeCode: `LEA-${codePrefix}-${RUN_ID}`,
        employmentType: 'FULL_TIME',
        startDate: '2024-04-01',
        organizationUnitId: unit.body.id,
        positionId: position.body.id,
      })
      .expect(201);

    return { employeeId: employee.body.id, employeeCode: employee.body.employeeCode };
  }

  /** The tenant's own run-scoped leave catalogue entry. */
  async function createLeaveType(token: string): Promise<string> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/leave-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `LRV-${RUN_ID}`, name: `نوع مرخصی ${RUN_ID}` })
      .expect(201);
    return res.body.id as string;
  }

  /** A PENDING request through the ordinary register — the real write path. */
  async function submitLeave(
    token: string,
    employeeId: string,
    typeId: string,
    startDate: string,
    endDate: string
  ): Promise<string> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/leave-requests`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeId,
        leaveTypeId: typeId,
        startDate,
        endDate,
        reason: `درخواست e2e ${RUN_ID}`,
      })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    return res.body.id as string;
  }


  beforeAll(async () => {
    await waitForReadiness();
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

    noRead = await createUser('HlNoRead', admin.tenantId);
    noRead.token = await login(noRead.email, noRead.password);
    tenantB = await setupTenantB(roleId);

    // Tenant A: one run-scoped leave type, two employees and FIVE requests covering
    // every state of the four-member lifecycle — three through the ordinary register
    // (two PENDING, one then WITHDRAWN) and two decision-state fixtures written
    // directly with their `approved_at`/`rejected_at` set, exactly as
    // `LeaveRequest_state_check` demands.
    leaveTypeCode = `LRV-${RUN_ID}`.toUpperCase();
    leaveTypeId = await createLeaveType(admin.token);

    const empA = await hireEmployee(admin.token, 'A');
    employeeIdA = empA.employeeId;
    employeeCodeA = empA.employeeCode;

    const empA2 = await hireEmployee(admin.token, 'A2');
    employeeIdA2 = empA2.employeeId;
    employeeIdA2 = empA2.employeeId;

    pendingLongId = await submitLeave(
      admin.token,
      employeeIdA,
      leaveTypeId,
      '2026-11-01',
      '2026-11-03'
    );
    pendingSingleId = await submitLeave(
      admin.token,
      employeeIdA,
      leaveTypeId,
      '2026-11-05',
      '2026-11-05'
    );
    cancelledId = await submitLeave(
      admin.token,
      employeeIdA,
      leaveTypeId,
      '2026-11-11',
      '2026-11-12'
    );
    await api()
      .post(`${API_PREFIX}/hr/leave-requests/${cancelledId}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: `انصراف e2e ${RUN_ID}` })
      .expect(200);

    const now = new Date();
    const approved = await getHrDb().leaveRequest.create({
      data: {
        tenantId: admin.tenantId,
        employeeId: employeeIdA,
        leaveTypeId,
        startDate: new Date(Date.UTC(2026, 10, 7)),
        endDate: new Date(Date.UTC(2026, 10, 8)),
        reason: `تأییدشده در e2e ${RUN_ID}`,
        status: 'APPROVED',
        approvedAt: now,
      },
    });
    approvedId = approved.id;

    const rejected = await getHrDb().leaveRequest.create({
      data: {
        tenantId: admin.tenantId,
        employeeId: employeeIdA,
        leaveTypeId,
        startDate: new Date(Date.UTC(2026, 10, 9)),
        endDate: new Date(Date.UTC(2026, 10, 9)),
        reason: `ردشده در e2e ${RUN_ID}`,
        status: 'REJECTED',
        rejectedAt: now,
      },
    });
    rejectedId = rejected.id;

    // Tenant B: its own type and one PENDING request — the isolation probe.
    leaveTypeIdB = await createLeaveType(tenantB.admin.token);
    const empB = await hireEmployee(tenantB.admin.token, 'B');
    employeeIdB = empB.employeeId;
    employeeCodeB = empB.employeeCode;
    tenantBRowId = await submitLeave(
      tenantB.admin.token,
      empB.employeeId,
      leaveTypeIdB,
      '2026-11-01',
      '2026-11-02'
    );
  }, 180_000);


  it('lists this tenant’s scoped register WITH its summary — the four states exact', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(Array.isArray(page.items)).toBe(true);
    expect(idsOf(res.body).sort()).toEqual(
      [pendingLongId, pendingSingleId, cancelledId, approvedId, rejectedId].sort()
    );

    // The summary strip is over the SAME population — total matches, and every one of
    // the four lifecycle members is present with its exact count.
    expect(page.summary.total).toBe(5);
    expect(page.summary.byStatus).toEqual({
      PENDING: 2,
      APPROVED: 1,
      REJECTED: 1,
      CANCELLED: 1,
    });
  });

  it('projects EXACTLY the contract whitelist — no tenant, no internal ids, no bookkeeping', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&status=APPROVED`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const [row] = envelope(res.body).items as Record<string, unknown>[];
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual([
      'cancelledAt',
      'createdAt',
      'employeeCode',
      'endDate',
      'id',
      'leaveTypeCode',
      'leaveTypeName',
      'reason',
      'startDate',
      'status',
    ]);
    for (const forbidden of [
      'tenantId',
      'employeeId',
      'leaveTypeId',
      'approvedAt',
      'rejectedAt',
      'updatedAt',
    ]) {
      expect(Object.keys(row!)).not.toContain(forbidden);
    }
    expect(row!.leaveTypeCode).toBe(leaveTypeCode);
    expect(row!.startDate).toBe('2026-11-07');
    expect(row!.endDate).toBe('2026-11-08');
    expect(row!.cancelledAt).toBeNull();
  });

  it('filters by every member of the closed status vocabulary', async () => {
    for (const [status, expected] of [
      ['PENDING', [pendingLongId, pendingSingleId]],
      ['APPROVED', [approvedId]],
      ['REJECTED', [rejectedId]],
      ['CANCELLED', [cancelledId]],
    ] as const) {
      const res: SupertestResponse = await api()
        .get(reportUrl(`?${scopeQuery()}&status=${status}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      expect(idsOf(res.body).sort()).toEqual([...expected].sort());
      // The summary zeroes the members the filter excludes — a closed vocabulary,
      // always fully present.
      expect(envelope(res.body).summary.byStatus).toEqual({
        PENDING: status === 'PENDING' ? 2 : 0,
        APPROVED: status === 'APPROVED' ? 1 : 0,
        REJECTED: status === 'REJECTED' ? 1 : 0,
        CANCELLED: status === 'CANCELLED' ? 1 : 0,
      });
      for (const row of envelope(res.body).items as { status: string }[]) {
        expect(row.status).toBe(status);
      }
    }
  });

  it('filters by the person the request is FOR — and an employee with none is empty', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&employeeId=${employeeIdA}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(res.body).sort()).toEqual(
      [pendingLongId, pendingSingleId, cancelledId, approvedId, rejectedId].sort()
    );

    const none: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&employeeId=${employeeIdA2}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(none.body).items).toEqual([]);
    expect(envelope(none.body).summary.total).toBe(0);
  });


  it('reads the window as INTERSECTION with the requested period — not containment', async () => {
    // The LONG request (2026-11-01…03) has only its LAST day inside this single-day
    // window: a containment filter would hide it, intersection keeps it — the
    // register's own semantics, restated by the report.
    const lastDay: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-03&to=2026-11-03`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(lastDay.body)).toEqual([pendingLongId]);

    // A later window catches only the approved pair of days: the single-day 11-05
    // request and the 11-09 rejection stay out.
    const window: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&from=2026-11-06&to=2026-11-08`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(window.body)).toEqual([approvedId]);
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
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    });
  });

  it('paginates through the server — the page window is echoed back', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?${scopeQuery()}&pageSize=2&page=1`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(envelope(res.body).items).toHaveLength(2);
    expect(envelope(res.body).total).toBe(5);
    expect(envelope(res.body).pageSize).toBe(2);
  });

  it('refuses a client-supplied tenantId — the scope is server-side, not a field', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?tenantId=${admin.tenantId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses filters the source does not have — never a silent no-op', async () => {
    // `search` is declared by the register's own DTO but deliberately IGNORED by
    // `LeaveService.list`, so the report refuses it rather than claiming a
    // narrowing the server never performs.
    const search: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(RUN_ID)}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(search.status).toBe(422);

    const unknownStatus: SupertestResponse = await api()
      .get(reportUrl(`?status=ARCHIVED`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(unknownStatus.status).toBe(422);
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
      leaveTypeCode,
      status: 'CANCELLED',
      startDate: '2026-11-11',
      endDate: '2026-11-12',
    });
    expect(res.body.cancelledAt).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('tenantId');
    expect(res.body).not.toHaveProperty('employeeId');
  });

  it('answers 404 for a foreign or unknown id — on detail AND timeline', async () => {
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
  });

  it('exposes the AUTHORITATIVE audit timeline — recorded actions, never inferred', async () => {
    // A request created through the register carries its own `create` act.
    const created: SupertestResponse = await api()
      .get(reportUrl(`/${pendingLongId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(created.body.total).toBeGreaterThanOrEqual(1);
    expect(created.body.items.map((item) => item.action)).toEqual(
      expect.arrayContaining(['create'])
    );

    // The withdrawal carries BOTH acts — the submission and the cancellation with
    // its stated reason — on the same resource, from the same trail.
    const withdrawn: SupertestResponse = await api()
      .get(reportUrl(`/${cancelledId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const actions = withdrawn.body.items.map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'cancel']));

    // The decision-state fixtures were written directly, so their timeline is an
    // HONEST empty page — nothing was routed through a service, so nothing was
    // audited — never a fabricated event.
    const fixtureTimeline: SupertestResponse = await api()
      .get(reportUrl(`/${approvedId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(fixtureTimeline.body.total).toBe(0);
    expect(fixtureTimeline.body.items).toEqual([]);
  });

  it('denies a user without hr.leave.read — no report, no detail, no timeline, no export', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${pendingLongId}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(detail.status).toBe(403);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${pendingLongId}/timeline`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(timeline.status).toBe(403);

    const xlsx: SupertestResponse = await api()
      .get(reportUrl(`/export/xlsx?${scopeQuery()}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(xlsx.status).toBe(403);

    const docx: SupertestResponse = await api()
      .get(reportUrl(`/export/docx?${scopeQuery()}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(docx.status).toBe(403);
  });

  it('requires authentication at all', async () => {
    const res: SupertestResponse = await api().get(reportUrl());
    expect(res.status).toBe(401);
  });


  it('keeps tenant A’s requests out of tenant B’s report — positive isolation both ways', async () => {
    const forB: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);
    expect(idsOf(forB.body)).not.toContain(pendingLongId);
    expect(idsOf(forB.body)).not.toContain(cancelledId);
    expect(idsOf(forB.body)).toContain(tenantBRowId);

    const forA: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(forA.body)).not.toContain(tenantBRowId);

    // Tenant B reads only its own detail and timeline; A’s ids are absent, not
    // forbidden — 404, existence never leaks.
    const ownDetail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);
    expect(ownDetail.body.leaveTypeCode).toBe(leaveTypeCode.toUpperCase());

    const foreignDetail: SupertestResponse = await api()
      .get(reportUrl(`/${pendingLongId}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`);
    expect(foreignDetail.status).toBe(404);

    const foreignTimeline: SupertestResponse = await api()
      .get(reportUrl(`/${pendingLongId}/timeline`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`);
    expect(foreignTimeline.status).toBe(404);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${pendingLongId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'APPROVED' });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api()
      .delete(reportUrl(`/${pendingLongId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(del.status).toBe(404);

    // And the register itself still refuses its own writes through this surface:
    // no approval/withdrawal verb exists under the reporting path either.
    const approve: SupertestResponse = await api()
      .post(reportUrl(`/${pendingLongId}/approve`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(approve.status).toBe(404);
  });

  it('exports the SAME scope as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and both file routes answer the
    // SAME `?leaveTypeId=…` question, and the parsed documents describe exactly
    // those five rows.
    const scope = scopeQuery();
    const list: SupertestResponse = await api()
      .get(reportUrl(`?${scope}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items).toHaveLength(5);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      reportUrl(`/export/xlsx?${scope}`),
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="hr-leave-request-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'کد پرسنلی');
    expect(sheet.header).toEqual([
      'کد پرسنلی',
      'نوع مرخصی',
      'از تاریخ',
      'تا تاریخ',
      'وضعیت',
      'دلیل',
      'ثبت',
      'لغو',
    ]);
    expect(sheet.data).toHaveLength(5);
    expect(sheet.data.map((row) => row[0]).sort()).toEqual(
      listed.items.map((item) => item.employeeCode).sort()
    );
    // Every state word the lifecycle declares appears in the exported status column.
    expect(sheet.data.map((row) => row[4])).toEqual(
      expect.arrayContaining(['ثبت‌شده', 'تأییدشده', 'ردشده', 'لغوشده'])
    );
    // The metadata block above the table exists: «خلاصه» heads the summary counts.
    expect(sheet.firstColumn).toContain('خلاصه');

    const docx: SupertestResponse = await getExportFile(
      api(),
      reportUrl(`/export/docx?${scope}`),
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="hr-leave-request-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش وضعیت درخواست‌های مرخصی');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no register row id.
    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain(pendingLongId);
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
    await teardownTenantB(tenantB).catch(() => undefined);

    const hrDb = getHrDb();
    const db = getCoreDb();

    // Tenant B's HR rows first: leave requests (they RESTRICT the type and the
    // employee from below them), then the type, the person and their org furniture —
    // the person's own id, so no code-shape assumption is involved.
    await hrDb.leaveRequest
      .deleteMany({ where: { leaveTypeId: leaveTypeIdB } })
      .catch(() => undefined);
    await hrDb.leaveType.deleteMany({ where: { id: leaveTypeIdB } }).catch(() => undefined);

    await hrDb.employmentRecord
      .deleteMany({ where: { employeeId: employeeIdB } })
      .catch(() => undefined);
    await hrDb.employee.deleteMany({ where: { id: employeeIdB } }).catch(() => undefined);

    // Tenant A: requests first, then the type, then the two people.
    await hrDb.leaveRequest.deleteMany({ where: { leaveTypeId } }).catch(() => undefined);
    await hrDb.leaveType.deleteMany({ where: { id: leaveTypeId } }).catch(() => undefined);

    await hrDb.employmentRecord
      .deleteMany({ where: { employeeId: { in: [employeeIdA, employeeIdA2] } } })
      .catch(() => undefined);
    await hrDb.employee
      .deleteMany({ where: { id: { in: [employeeIdA, employeeIdA2] } } })
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
