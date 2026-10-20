/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC — the HR personnel-traffic report against the
 * real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/hr/personnel-traffic…`)
 *        ↓
 *   approved HR read seam → real `hr_db` attendance rows
 *        ↓
 *   tenant-scoped register → detail → authoritative audit timeline
 *
 * Covered: the happy path, filter correctness (day window, Jalali day, source,
 * employee-code search), the window-exclusivity 400, the projection whitelist,
 * foreign/unknown id → 404, an unauthorized user → denied, tenant A never sees
 * tenant B's row (and B never sees A's), an empty filter → empty page (not an error),
 * and NO write route existing on the report surface.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client
 * (no HTTP surface provisions membership), the business data itself is driven through
 * the HR HTTP API (unit → position → employee → clock-in/clock-out/adjustment), and the
 * report is read exclusively through the Reporting HTTP API — the slice under test.
 *
 * DATA SHAPE (HR-native): one employee punches two days (one closed, one still open so
 * `clockOut` stays `null`); a second employee punches one day and receives a MANUAL
 * correction for it — two rows for that day, one per source. The tenant-B employee
 * punches a single day. Every employee code is run-scoped so the search and isolation
 * assertions cannot match rows from other runs.
 */
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
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
const RUN_ID = `hrtrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
 * A SECOND tenant entitled to `hr` — the isolation half of the slice.
 *
 * Unlike the Financial/Production tenant-B fixtures, ONLY the module registration is
 * granted: the personnel-traffic surface declares the SAME `@RequiresModule('hr')`-only
 * contract HR's own attendance reads declare (HR declares no attendance FEATURE), so
 * the report must be reachable on the registration alone — and must be refused where
 * the registration is absent.
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

  const admin = await createUser('HRTenantBAdmin', tenant.id, roleId);
  admin.token = await login(admin.email, admin.password);
  return { tenantId: tenant.id, admin };
}

async function teardownTenantB(fixture: TenantB): Promise<void> {
  const db = getCoreDb();
  await db.moduleRegistrationTenant.deleteMany({ where: { tenantId: fixture.tenantId } });
  await db.userRole.deleteMany({ where: { userId: fixture.admin.userId } });
  await db.user.deleteMany({ where: { id: fixture.admin.userId } });
  await db.tenant.deleteMany({ where: { id: fixture.tenantId } });
}

describe('Reporting — Personnel Traffic Report (fourth vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantB: TenantB;

  // Tenant A register rows, each naming its day and source in the fixture.
  let deviceClosedId = '';
  let deviceOpenId = '';
  let deviceCorrectedId = '';
  let manualCorrectionId = '';
  let tenantBRowId = '';
  let employeeCodeA = '';
  let employeeCodeA2 = '';
  let employeeCodeB = '';
  let dateKeyDayOne = '';

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/hr/personnel-traffic${suffix}`;
  const envelope = <T,>(body: { data?: T } | T): T =>
    (body as { data?: T }).data ?? (body as T);
  const idsOf = (body: unknown) => ((envelope(body as { items?: unknown }).items ?? []) as { id: string }[]).map((item) => item.id);

  /** Unit → position → employee, returned for punching against. */
  async function hireEmployee(
    token: string,
    codePrefix: string
  ): Promise<{
    employeeId: string;
    unitId: string;
    positionId: string;
    employeeCode: string;
  }> {
    // Catalogue codes are machine keys validated against `HR_CODE_PATTERN` — the
    // UPPERCASE alphabet, with no normalisation step — while employee codes are
    // normalised to upper case on the way in. Both fixtures are therefore built from
    // the RUN_ID upper-cased, so a run-scoped code is a valid code on both paths.
    const codeRun = RUN_ID.toUpperCase();

    const unit: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/organization/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `PUNIT-${codePrefix}-${codeRun}`, name: `واحد گزارش ${RUN_ID}` })
      .expect(201);

    const position: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/positions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: `PPOS-${codePrefix}-${codeRun}`,
        title: `سمت گزارش ${RUN_ID}`,
        organizationUnitId: unit.body.id,
      })
      .expect(201);

    const employee: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/employees`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeCode: `PTR-${codePrefix}-${RUN_ID}`,
        employmentType: 'FULL_TIME',
        startDate: '2024-04-01',
        organizationUnitId: unit.body.id,
        positionId: position.body.id,
      })
      .expect(201);

    return {
      employeeId: employee.body.id,
      unitId: unit.body.id,
      positionId: position.body.id,
      employeeCode: employee.body.employeeCode,
    };
  }

  async function punch(token: string, employeeId: string, instant: string): Promise<string> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/attendance/clock-in`)
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId, clockIn: instant })
      .expect(201);
    return res.body.id as string;
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

    noRead = await createUser('NoRead', admin.tenantId);
    noRead.token = await login(noRead.email, noRead.password);
    tenantB = await setupTenantB(roleId);

    // Tenant A: two employees — the first with two punched days (one closed, one still
    // open), the second with one punched day that is then corrected: the day's evidence
    // plus the correction, one row per source.
    const empA = await hireEmployee(admin.token, 'A');
    employeeCodeA = empA.employeeCode;
    deviceClosedId = await punch(admin.token, empA.employeeId, '2026-09-18T08:00:00+03:30');
    await api()
      .post(`${API_PREFIX}/hr/attendance/${deviceClosedId}/clock-out`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ clockOut: '2026-09-18T16:30:00+03:30' })
      .expect(200);
    deviceOpenId = await punch(admin.token, empA.employeeId, '2026-09-19T08:05:00+03:30');

    const empA2 = await hireEmployee(admin.token, 'A2');
    employeeCodeA2 = empA2.employeeCode;
    deviceCorrectedId = await punch(admin.token, empA2.employeeId, '2026-09-20T08:10:00+03:30');
    const adjust: SupertestResponse = await api()
      .post(`${API_PREFIX}/hr/attendance/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        employeeId: empA2.employeeId,
        clockIn: '2026-09-20T08:00:00+03:30',
        clockOut: '2026-09-20T17:00:00+03:30',
        reason: `اصلاح گزارش e2e ${RUN_ID}`,
      })
      .expect(200);
    manualCorrectionId = adjust.body.id as string;
    expect(manualCorrectionId).not.toBe(deviceCorrectedId);

    // The report's own wire names one Jalali day — read it from the source wire, never
    // from a second client-side conversion that could disagree with the server.
    const dayOne: SupertestResponse = await api()
      .get(
        `${API_PREFIX}/hr/attendance?employeeId=${empA.employeeId}&from=2026-09-18&to=2026-09-18`
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    dateKeyDayOne = dayOne.body.items.find((row: { id: string; dateKey: string }) => row.id === deviceClosedId)?.dateKey ?? '';
    if (!dateKeyDayOne) throw new Error('[E2E] HR register did not return the day-key for day one');

    // Tenant B: one employee, one punch — the isolation probe.
    const empB = await hireEmployee(tenantB.admin.token, 'B');
    employeeCodeB = empB.employeeCode;
    tenantBRowId = await punch(tenantB.admin.token, empB.employeeId, '2026-09-18T09:00:00+03:30');
  }, 180_000);

  it('lists this tenant’s filtered register WITH its summary — sources zero-filled', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(RUN_ID)}&from=2026-09-18&to=2026-09-20`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(Array.isArray(page.items)).toBe(true);
    // The strictly filtered page holds exactly the four rows this run authored.
    expect(idsOf(res.body).sort()).toEqual(
      [deviceClosedId, deviceOpenId, deviceCorrectedId, manualCorrectionId].sort()
    );

    // The summary strip is over the SAME population: total = the filtered total, both
    // members of the closed source set present. Rows from OTHER runs exist in this
    // tenant, but the run-scoped search + day window exclude them from both halves.
    expect(page.summary.total).toBe(4);
    expect(page.summary.bySource).toEqual({ DEVICE: 3, MANUAL: 1 });
  });

  it('refuses a client-supplied tenantId — the scope is server-side, not a field', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?tenantId=${admin.tenantId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses an unknown source — never a filter the database silently matches nothing with', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?source=DEVICEY&from=2026-09-18&to=2026-09-20`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses a dateKey combined with from/to — exactly as the register does', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?dateKey=${encodeURIComponent(dateKeyDayOne)}&from=2026-09-18`))
      .set('Authorization', `Bearer ${admin.token}`);
    // The exclusivity rule lives in the shared day-window implementation, so the report
    // refuses the same window with the same 400 the register answers.
    expect(res.status).toBe(400);
  });

  it('reads one Jalali day through dateKey — the day the register itself names', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?dateKey=${encodeURIComponent(dateKeyDayOne)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(idsOf(res.body)).toContain(deviceClosedId);
    for (const row of page.items as { dateKey: string }[]) {
      expect(row.dateKey).toBe(dateKeyDayOne);
    }
  });

  it('filters by the source vocabulary — every row matches, nothing else does', async () => {
    const manual: SupertestResponse = await api()
      .get(reportUrl(`?source=MANUAL&search=${encodeURIComponent(RUN_ID)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // Only the one MANUAL correction this run authored.
    expect(idsOf(manual.body)).toContain(manualCorrectionId);
    for (const row of envelope(manual.body).items as { source: string }[]) {
      expect(row).toMatchObject({ source: 'MANUAL' });
    }
    expect(envelope(manual.body).summary.bySource).toEqual({ DEVICE: 0, MANUAL: 1 });

    const device: SupertestResponse = await api()
      .get(reportUrl(`?source=DEVICE&search=${encodeURIComponent(employeeCodeA2)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(idsOf(device.body)).toContain(deviceCorrectedId);
    expect(idsOf(device.body)).not.toContain(manualCorrectionId);
  });

  it('searches the employee code — the report’s one text column', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(employeeCodeA2)}&from=2026-09-18&to=2026-09-20`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(idsOf(res.body).sort()).toEqual([deviceCorrectedId, manualCorrectionId].sort());
    for (const row of envelope(res.body).items as { employeeCode: string }[]) {
      expect(row.employeeCode).toBe(employeeCodeA2);
    }
  });

  it('answers an empty page with its summary — no rows is not an error', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(`no-match-${RUN_ID}`)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.summary.total).toBe(0);
    expect(page.summary.bySource).toEqual({ DEVICE: 0, MANUAL: 0 });
  });

  it('keeps tenant B’s row out of tenant A’s register, detail and timeline', async () => {
    const scoped: SupertestResponse = await api()
      .get(reportUrl(`?from=2026-09-18&to=2026-09-20&search=${encodeURIComponent(RUN_ID)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(idsOf(scoped.body)).not.toContain(tenantBRowId);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(timeline.status).toBe(404);
  });

  it('lets tenant B read only its own register — positive isolation, both directions', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?from=2026-09-18&to=2026-09-20`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);

    expect(idsOf(res.body)).toEqual([tenantBRowId]);
    expect(envelope(res.body).summary).toEqual({
      total: 1,
      bySource: { DEVICE: 1, MANUAL: 0 },
    });
  });

  it('serves exactly the eight-field projection — tenant, keys and bookkeeping stay behind', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${deviceClosedId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(
      [
        'id',
        'employeeCode',
        'workDate',
        'dateKey',
        'clockIn',
        'clockOut',
        'source',
        'reason',
      ].sort()
    );
    for (const forbidden of ['tenantId', 'employeeId', 'createdAt', 'updatedAt', 'duration']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
    // The factual claims the register makes: this day is closed, recorded by a device,
    // with the day states it derived — Gregorian AND Jalali, verbatim. The sent instants
    // carried a `+03:30` offset, so the wire states the same MOMENTS in UTC (08:00+03:30
    // IS 04:30Z) — a moment stripped of that would be a different moment.
    expect(res.body.id).toBe(deviceClosedId);
    expect(res.body.employeeCode).toBe(employeeCodeA);
    expect(res.body.workDate).toBe('2026-09-18');
    expect(res.body.dateKey).toBe(dateKeyDayOne);
    expect(res.body.source).toBe('DEVICE');
    expect(res.body.reason).toBeNull();
    expect(res.body.clockIn).toBe('2026-09-18T04:30:00.000Z');
    expect(res.body.clockOut).toBe('2026-09-18T13:00:00.000Z');
  });

  it('shows an open day with clockOut null — a fact, not a missing value', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${deviceOpenId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.workDate).toBe('2026-09-19');
    expect(res.body.clockOut).toBeNull();
    expect(res.body.source).toBe('DEVICE');
    expect(res.body).not.toHaveProperty('status');
    expect(res.body).not.toHaveProperty('duration');
  });

  it('shows a correction’s stored reason — the MANUAL row’s own evidence', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${manualCorrectionId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.source).toBe('MANUAL');
    expect(res.body.reason).toBe(`اصلاح گزارش e2e ${RUN_ID}`);
    expect(res.body.workDate).toBe('2026-09-20');
    // 17:00+03:30 IS 13:30Z — the same moment, stated in UTC.
    expect(res.body.clockOut).toBe('2026-09-20T13:30:00.000Z');
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('serves the closed row’s authoritative timeline — create AND clock-out', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${deviceClosedId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    // The punch (create) and the clock-out (update) were both audited by HR.
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const actions = res.body.items.map((item: { action: string }) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'update']));
    // The timeline projection never carries raw envelope internals.
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['id', 'action', 'actorId', 'success', 'reason', 'changedFields', 'createdAt'].sort()
      );
      expect(item).not.toHaveProperty('tenantId');
      expect(item).not.toHaveProperty('ip');
      expect(item).not.toHaveProperty('userAgent');
    }
  });

  it('serves the correction row’s timeline — the adjust act alone', async () => {
    // The clock-in `create` belongs to the DEVICE row's id; the correction's own
    // `adjust` is audited against the MANUAL row's id. The timeline of the correction
    // therefore states exactly the one correction act — bound to the tenant-scoped
    // row, never inferred.
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${manualCorrectionId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const actions = res.body.items.map((item: { action: string }) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['adjust']));
    expect(actions).not.toContain('create');
  });

  it('denies a user without hr.attendance.read — no report, no detail, no timeline', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${deviceClosedId}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(detail.status).toBe(403);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${deviceClosedId}/timeline`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(timeline.status).toBe(403);
  });

  it('requires authentication at all', async () => {
    const res: SupertestResponse = await api().get(reportUrl());
    expect(res.status).toBe(401);
  });

  it('exports the SAME window as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and the file route answer the SAME
    // `?search=<run>&from=…&to=…` question, and the parsed sheet must describe exactly
    // those four run-authored rows.
    const scope = `search=${encodeURIComponent(RUN_ID)}&from=2026-09-18&to=2026-09-20`;
    const list: SupertestResponse = await api()
      .get(reportUrl(`?${scope}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items).toHaveLength(4);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      reportUrl(`/export/xlsx?${scope}`),
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="personnel-traffic-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'کد پرسنل');
    expect(sheet.header).toEqual(['کد پرسنل', 'تاریخ', 'روز هفته', 'ورود', 'خروج', 'منبع']);
    expect(sheet.data).toHaveLength(4);
    expect(sheet.data.map((row) => row[0]).sort()).toEqual(
      listed.items.map((item: { employeeCode: string }) => item.employeeCode).sort()
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
      /^attachment; filename="personnel-traffic-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش تردد پرسنل');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no register row id.
    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain(deviceClosedId);
  });

  it('refuses the export to an unauthorized actor and across tenants', async () => {
    const scope = `search=${encodeURIComponent(RUN_ID)}&from=2026-09-18&to=2026-09-20`;
    const denied: SupertestResponse = await api()
      .get(reportUrl(`/export/xlsx?${scope}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);

    const anonymous: SupertestResponse = await api().get(reportUrl('/export/docx'));
    expect(anonymous.status).toBe(401);

    // Tenant B's actor: tenant A's employee codes are not in their file.
    const foreign: SupertestResponse = await getExportFile(
      api(),
      reportUrl('/export/xlsx?from=2026-09-18&to=2026-09-20'),
      tenantB.admin.token
    ).expect(200);
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'کد پرسنل');
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(employeeCodeA);
    expect(foreignSheet.data.map((row) => row[0])).toContain(employeeCodeB);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${deviceClosedId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ source: 'MANUAL' });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api().delete(reportUrl(`/${deviceClosedId}`));
    expect(del.status).toBe(404);
  });

  afterAll(async () => {
    await teardownTenantB(tenantB).catch(() => undefined);

    const hrDb = getHrDb();
    // Attendance rows first (employees Restrict from below them), then the persons and
    // their org furniture — all run-scoped to this run's fixtures.
    await hrDb.attendance
      .deleteMany({
        where: {
          id: { in: [deviceClosedId, deviceOpenId, deviceCorrectedId, manualCorrectionId] },
        },
      })
      .catch(() => undefined);
    await hrDb.attendance.deleteMany({ where: { id: tenantBRowId } }).catch(() => undefined);

    const employeeRows = await hrDb.employee
      .findMany({
        where: { employeeCode: { in: [employeeCodeA, employeeCodeA2, employeeCodeB] } },
        select: { id: true },
      })
      .catch(() => [] as { id: string }[]);
    const employeeIds = employeeRows.map((row) => row.id);
    if (employeeIds.length > 0) {
      await hrDb.employmentRecord
        .deleteMany({ where: { employeeId: { in: employeeIds } } })
        .catch(() => undefined);
      await hrDb.employee.deleteMany({ where: { id: { in: employeeIds } } }).catch(() => undefined);
    }
    // Run-scoped catalogue rows: both codes embed the RUN_ID (upper-cased to match
    // `HR_CODE_PATTERN`), so this run's furniture is removed and no other fixture is
    // touched. `contains` is case-sensitive, hence the same upper-casing.
    const codeRun = RUN_ID.toUpperCase();
    await hrDb.position
      .deleteMany({ where: { code: { contains: codeRun } } })
      .catch(() => undefined);
    await hrDb.organizationUnit
      .deleteMany({ where: { code: { contains: codeRun } } })
      .catch(() => undefined);

    await getCoreDb()
      .user.deleteMany({ where: { id: noRead.userId } })
      .catch(() => undefined);
  }, 60_000);
});
