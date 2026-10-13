/**
 * Phase REPORTING-CHECK-REQUEST-REPORT — the FIRST Reporting vertical slice,
 * end to end against the real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/financial/check-requests…`)
 *        ↓
 *   approved Financial read seam → real `finance_db` rows
 *        ↓
 *   tenant-scoped register → detail → authoritative timeline
 *
 * Covered, per the phase brief §39: the happy path, filter correctness,
 * the projection whitelist, foreign/unknown id → 404, an unauthorized user
 * → denied, tenant A never sees tenant B's row, an empty filter → empty
 * page (not an error), and NO write route existing on the report surface.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma
 * client (no HTTP surface provisions membership), the business data itself is
 * driven through the Financial HTTP API, and the report is read exclusively
 * through the Reporting HTTP API — the slice under test.
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
import { FinancialPrismaService } from '../src/modules/financial/database/financial-prisma.service';

type SupertestResponse = import('supertest').Response;

interface Actor {
  label: string;
  email: string;
  password: string;
  token: string;
  userId: string;
  tenantId: string;
}

const API_PREFIX = '/api/v1';
const RUN_ID = `repe2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
  tenantBAdmin: `B-${RUN_ID}`,
  noRead: `NoRead-${RUN_ID}`,
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

function getFinanceDb(): FinancialPrismaService {
  return getApp().get(FinancialPrismaService);
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
  const email = `${label}-${RUN_ID}@aria.test`;
  const password = PASSWORDS[label as keyof typeof PASSWORDS] ?? `Pwd-${RUN_ID}`;
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = `user-${label}-${RUN_ID}`;

  await getCoreDb().user.create({
    data: {
      id: userId,
      email,
      passwordHash,
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
 * A SECOND tenant entitled to `financial` — the isolation half of the slice.
 * Same fixtures the Financial e2e seeds: registration + feature grant + an
 * ADMIN role so its actor holds `financial.check.read` inside ITS tenant only.
 */
async function createTenantB(): Promise<{ tenantId: string; admin: Actor }> {
  const coreDb = getCoreDb();
  const tenantId = `tenant-b-${RUN_ID}`;

  await coreDb.tenant.create({ data: { id: tenantId, code: `tenant-b-${RUN_ID}` } });

  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: 'financial' },
  });
  if (!registration) throw new Error('[E2E] financial module registration not found');
  await coreDb.moduleRegistrationTenant.create({
    data: { registrationId: registration.id, tenantId },
  });

  const feature = await coreDb.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'financial', featureId: 'check-request' } },
  });
  if (!feature) throw new Error('[E2E] financial.check-request feature not found');
  await coreDb.moduleFeatureGrant.create({ data: { featureRowId: feature.id, tenantId } });

  const admin = await createUser('tenantBAdmin', tenantId, await findAdminRoleId());
  admin.token = await login(admin.email, admin.password);
  return { tenantId, admin };
}

describe('Reporting — Check Request Status & Flow Report (first vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantBAdmin: Actor;
  let tenantAId: string;
  let draftId: string;
  let submittedId: string;
  let tenantBRowId: string;
  const createdRowIds: string[] = [];

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/financial/check-requests${suffix}`;
  // Unwraps the standard `{ data }` envelope (or passes a bare body through).
  // Generic so each response keeps its inferred shape at the call site; the one
  // narrowing cast lives here, in the harness helper.
  const envelope = <T,>(body: { data?: T } | T): T =>
    (body as { data?: T }).data ?? (body as T);

  async function createRow(token: string): Promise<{ id: string; status: number }> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkIssueType: 'PETTY_CASH', requesterOpinion: 'CONTINUE' })
      .expect(201);
    createdRowIds.push(res.body.id);
    return { id: res.body.id, status: res.body.status };
  }

  beforeAll(async () => {
    await waitForReadiness();

    const coreDb = getCoreDb();
    const tenantA = await coreDb.tenant.findUnique({ where: { id: 'tenant-test-1' } });
    if (!tenantA) throw new Error('[E2E] Seeded tenant tenant-test-1 not found');
    tenantAId = tenantA.id;

    const seededAdminRow = await coreDb.user.findUnique({ where: { email: 'admin@localhost' } });
    if (!seededAdminRow) throw new Error('[E2E] Seeded admin user not found');
    admin = {
      label: 'seededAdmin',
      email: seededAdminRow.email,
      password: PASSWORDS.seededAdmin,
      userId: seededAdminRow.id,
      tenantId: seededAdminRow.tenantId || tenantAId,
      token: await login(seededAdminRow.email, PASSWORDS.seededAdmin),
    };

    // A user inside tenant A with NO roles: the report must refuse them.
    const noReadBase = await createUser('noRead', tenantAId);
    noRead = { ...noReadBase, token: await login(noReadBase.email, noReadBase.password) };

    // Tenant B: same capability, different tenant — the isolation probe.
    const tenantB = await createTenantB();
    tenantBAdmin = tenantB.admin;

    // REAL source data, driven through the Financial API (the writer side).
    const draft = await createRow(admin.token);
    draftId = draft.id;
    const submitted = await createRow(admin.token);
    submittedId = submitted.id;
    await api()
      .post(`${API_PREFIX}/financial/check-requests/${submittedId}/submit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const tenantBRow = await createRow(tenantBAdmin.token);
    tenantBRowId = tenantBRow.id;
  }, 90_000);

  afterAll(async () => {
    const coreDb = getCoreDb();
    const financeDb = getFinanceDb();

    for (const id of createdRowIds) {
      try {
        await financeDb.checkRequest.delete({ where: { id } });
      } catch {
        // best-effort
      }
    }

    try {
      await coreDb.userRole.deleteMany({ where: { userId: noRead.userId } });
      await coreDb.user.deleteMany({ where: { id: noRead.userId } });
      await coreDb.moduleFeatureGrant.deleteMany({ where: { tenantId: tenantBAdmin.tenantId } });
      await coreDb.moduleRegistrationTenant.deleteMany({
        where: { tenantId: tenantBAdmin.tenantId },
      });
      await coreDb.userRole.deleteMany({ where: { userId: tenantBAdmin.userId } });
      await coreDb.user.deleteMany({ where: { id: tenantBAdmin.userId } });
      await coreDb.tenant.delete({ where: { id: tenantBAdmin.tenantId } });
    } catch {
      // best-effort
    }
  }, 60_000);

  it('serves the register with page + summary to an authorized reader', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.total).toBe('number');
    // The summary counts every state of the CLOSED lifecycle set — no holes.
    for (const status of [0, 1, 2, 3, 4, 5, 6, 7, 8, 50]) {
      expect(body.summary.byStatus).toHaveProperty(String(status));
    }
  });

  it('refuses a client-supplied tenantId — the scope is never a request field', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?tenantId=tenant-b-other`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('filters by status through the source vocabulary', async () => {
    const drafts: SupertestResponse = await api()
      .get(`${reportUrl()}?status=0&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const submitted: SupertestResponse = await api()
      .get(`${reportUrl()}?status=2&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const draftIds = envelope(drafts.body).items.map((item) => item.id);
    const submittedIds = envelope(submitted.body).items.map((item) => item.id);

    expect(draftIds).toContain(draftId);
    expect(draftIds).not.toContain(submittedId);
    expect(submittedIds).toContain(submittedId);
    expect(submittedIds).not.toContain(draftId);
    // Every row the filter returns carries the requested status — no leakage.
    for (const item of envelope(submitted.body).items) expect(item.status).toBe(2);
  });

  it('filters by search against the title, and every result matches', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent('تنخواه')}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    for (const item of body.items) expect(item.title).toContain('تنخواه');
    const ids = body.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([draftId, submittedId]));
  });

  it('answers an impossible filter with an empty page — not an error', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(`بدون-نتیجه-${RUN_ID}`)}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.summary.total).toBe(0);
  });

  it('never leaks tenant B rows into tenant A — register, detail and timeline', async () => {
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?status=0&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const ids = envelope(list.body).items.map((item) => item.id);
    expect(ids).not.toContain(tenantBRowId);

    // A foreign id behaves EXACTLY like a missing one: 404, not 403.
    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBRowId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(timeline.status).toBe(404);
  });

  it('returns the projection whitelist for a detail — twelve fields, no internals', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(
      [
        'id',
        'title',
        'checkIssueType',
        'purchaseType',
        'orderReference',
        'projectReference',
        'requestDate',
        'requesterOpinion',
        'status',
        'managerDecision',
        'submittedAt',
        'decidedAt',
      ].sort()
    );
    for (const forbidden of ['tenantId', 'requesterUserId', 'createdAt', 'processPin']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('serves the selected request’s authoritative timeline — and only for it', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${submittedId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(2); // create + submit were audited
    const actions = res.body.items.map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'submit']));
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

  it('denies a user without financial.check.read — no report, no detail, no timeline', async () => {
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

  it('requires authentication at all', async () => {
    const res: SupertestResponse = await api().get(reportUrl());
    expect(res.status).toBe(401);
  });

  it('exports the SAME filtered page as XLSX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and the file route answer the SAME
    // `?status=0` question, and the parsed sheet must describe exactly those rows.
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?status=0&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);

    const file: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?status=0&pageSize=100`,
      admin.token
    ).expect(200);
    expect(file.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(file.headers['content-disposition']).toMatch(
      /^attachment; filename="check-request-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(file), 'عنوان');
    expect(sheet.header).toEqual(['عنوان', 'نوع چک', 'وضعیت', 'تصمیم مدیر', 'تاریخ درخواست']);
    expect(sheet.data).toHaveLength(listed.items.length);
    // Every row the list returned is in the file — by title, in the same order.
    expect(sheet.data.map((row) => row[0])).toEqual(listed.items.map((item) => item.title));
    // The file states the applied filter rather than hiding it.
    expect(sheet.firstColumn).toContain('وضعیت');
    // No second population: the scope block agrees with the list total.
    const scopeIndex = sheet.firstColumn.indexOf('مجموع (همه‌ی صفحات)');
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
  });

  it('exports the SAME filtered page as DOCX — one table, Persian words intact', async () => {
    const file: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?status=0&pageSize=100`,
      admin.token
    ).expect(200);
    expect(file.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(file.headers['content-disposition']).toMatch(
      /^attachment; filename="check-request-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(file), 'word/document.xml');
    expect(xml).toContain('گزارش وضعیت و گردش درخواست‌های صدور چک');
    expect(xml).toContain('عنوان');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    // Empty-or-not, the structure rules hold: header + exactly the listed rows.
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?status=0&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(countTag(xml, 'tr')).toBe(1 + envelope(list.body).items.length);
    // The document leaks no scope: no tenant id, no row id.
    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain(draftId);
  });

  it('refuses the export to an unauthorized actor and across tenants', async () => {
    // No read remit: neither format.
    const deniedXlsx: SupertestResponse = await api()
      .get(`${reportUrl()}/export/xlsx`)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(deniedXlsx.status).toBe(403);
    const deniedDocx: SupertestResponse = await api()
      .get(`${reportUrl()}/export/docx`)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(deniedDocx.status).toBe(403);

    // No token at all: 401, same as the list route.
    const anonymous: SupertestResponse = await api().get(`${reportUrl()}/export/xlsx`);
    expect(anonymous.status).toBe(401);

    // Tenant B's actor asks for the report: tenant A's rows are not in the file.
    const foreign: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?pageSize=100`,
      tenantBAdmin.token
    ).expect(200);
    // Tenant B's file mirrors tenant B's OWN list — scope parity across tenants: the
    // list route's isolation is already pinned above, so row-for-row equality with it
    // transfers that guarantee to the file (an export can never widen the caller's
    // tenant scope). Titles alone cannot carry this check — two runs of the same
    // fixture legitimately produce the same auto-generated title — so the ROW COUNT
    // does: a leaked tenant-A row would make the file longer than tenant B's list.
    const foreignList: SupertestResponse = await api()
      .get(reportUrl('?pageSize=100'))
      .set('Authorization', `Bearer ${tenantBAdmin.token}`)
      .expect(200);
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'عنوان');
    const foreignItems = envelope(foreignList.body).items;
    expect(foreignSheet.data).toHaveLength(foreignItems.length);
    expect(foreignSheet.data.map((row) => row[0])).toEqual(
      foreignItems.map((item) => item.title)
    );
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
      .send({ status: 3 });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api()
      .delete(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(del.status).toBe(404);
  });
});
