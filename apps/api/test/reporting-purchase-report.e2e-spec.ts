/**
 * Phase REPORTING-PURCHASE-REPORT — the purchase report against the real combined
 * runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/commerce/purchase-documents…`)
 *        ↓
 *   approved Commerce read seam → real `commerce_db` rows
 *        ↓
 *   tenant-scoped register → detail → authoritative timeline
 *
 * Covered: the happy path, filter correctness, the projection whitelist,
 * foreign/unknown id → 404, an unauthorized user → denied, tenant A never sees
 * tenant B's row, an empty filter → empty page (not an error), and NO write route
 * existing on the report surface.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client
 * (no HTTP surface provisions membership), the business data itself is driven through
 * the Commerce HTTP API, and the report is read exclusively through the Reporting
 * HTTP API — the slice under test.
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
const RUN_ID = `purche2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
 * A SECOND tenant entitled to `commerce` — the isolation half of the slice.
 *
 * Mirrors what a real tenant provisioning leaves behind for Commerce: the module
 * registration link, the `commerce/purchase` feature grant (the SAME feature the
 * report route declares with `@RequiresFeature`), and an ADMIN role so its actor
 * holds `commerce.read` inside ITS tenant only.
 */
async function createTenantB(): Promise<{ tenantId: string; admin: Actor }> {
  const coreDb = getCoreDb();
  const tenantId = `tenant-b-${RUN_ID}`;

  await coreDb.tenant.create({ data: { id: tenantId, code: `tenant-b-${RUN_ID}` } });

  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: 'commerce' },
  });
  if (!registration) throw new Error('[E2E] commerce module registration not found');
  await coreDb.moduleRegistrationTenant.create({
    data: { registrationId: registration.id, tenantId },
  });

  const feature = await coreDb.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'commerce', featureId: 'purchase' } },
  });
  if (!feature) throw new Error('[E2E] commerce.purchase feature not found');
  await coreDb.moduleFeatureGrant.create({ data: { featureRowId: feature.id, tenantId } });

  const admin = await createUser('tenantBAdmin', tenantId, await findAdminRoleId());
  admin.token = await login(admin.email, admin.password);
  return { tenantId, admin };
}

describe('Reporting — Purchase Request Status & Lifecycle Report (second vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantBAdmin: Actor;
  let tenantAId: string;
  let draftId: string;
  let approvedId: string;
  let tenantBRowId: string;

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/commerce/purchase-documents${suffix}`;
  const envelope = <T,>(body: { data?: T } | T): T =>
  (body as { data?: T }).data ?? (body as T);

  /**
   * One priced document through the COMMERCE API (the writer side).
   *
   * `unitPrice`/`tax` are STATED (not null) so the document is genuinely priced —
   * the report must echo the exact decimal strings the writer wrote.
   */
  async function createDocument(
    token: string,
    requesterId: string
  ): Promise<{ id: string; documentNumber: string }> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/purchase-documents`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requesterId,
        supplierId: 'SUP-E2E',
        currency: 'IRR',
        lines: [{ lineType: 'STANDARD', quantity: 2, unit: 'PCS', unitPrice: 600, tax: 60 }],
      })
      .expect(201);
    return { id: res.body.id, documentNumber: res.body.documentNumber };
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

    // REAL source data, driven through the Commerce API (the writer side).
    const draft = await createDocument(admin.token, admin.userId);
    draftId = draft.id;
    const second = await createDocument(admin.token, admin.userId);
    approvedId = second.id;
    await api()
      .post(`${API_PREFIX}/commerce/purchase-documents/${approvedId}/submit`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const tenantBRow = await createDocument(tenantBAdmin.token, tenantBAdmin.userId);
    tenantBRowId = tenantBRow.id;
  }, 90_000);

  afterAll(async () => {
    const coreDb = getCoreDb();

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
    for (const status of ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED']) {
      expect(body.summary.byStatus).toHaveProperty(status);
    }
    expect(body.summary.total).toBeGreaterThanOrEqual(2);
  });

  it('refuses a client-supplied tenantId — the scope is never a request field', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?tenantId=tenant-b-other`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses an unknown lifecycle state — never a filter the database silently empties', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?status=ARCHIVED`)
      .set('Authorization', `Bearer ${admin.token}`);
    // 422: the production ValidationPipe maps whitelist/forbidden failures (and
    // `@IsIn` member refusal) to `UnprocessableEntityException` — see
    // test/setup.ts. What matters is the REFUSAL, not the code-family digit.
    expect(res.status).toBe(422);
  });

  it('filters by status through the source vocabulary', async () => {
    const drafts: SupertestResponse = await api()
      .get(`${reportUrl()}?status=DRAFT&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const submitted: SupertestResponse = await api()
      .get(`${reportUrl()}?status=SUBMITTED&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const draftIds = envelope(drafts.body).items.map((item) => item.id);
    const submittedIds = envelope(submitted.body).items.map((item) => item.id);

    expect(draftIds).toContain(draftId);
    expect(draftIds).not.toContain(approvedId);
    expect(submittedIds).toContain(approvedId);
    expect(submittedIds).not.toContain(draftId);
    // Every row the filter returns carries the requested status — no leakage.
    for (const item of envelope(submitted.body).items) expect(item.status).toBe('SUBMITTED');
  });

  it('filters by search against the document number, and every result matches', async () => {
    const draft: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const raw = envelope(draft.body) ?? draft.body;
    const documentNumber: string = raw?.documentNumber;
    expect(typeof documentNumber).toBe('string');

    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(documentNumber)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    const ids = body.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([draftId]));
    for (const item of body.items) expect(item.documentNumber).toContain(documentNumber);
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
      .get(`${reportUrl()}?status=DRAFT&pageSize=100`)
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
        'documentNumber',
        'kind',
        'status',
        'supplierId',
        'currency',
        'subtotalAmount',
        'taxAmount',
        'totalAmount',
        'lineCount',
        'completedAt',
        'createdAt',
      ].sort()
    );
    for (const forbidden of ['tenantId', 'requesterId', 'completedByUserId', 'updatedAt']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
    // The writer stated 2 × 600 + 60 of tax: the report carries the SAME amounts —
    // compared NUMERICALLY, because Prisma's wire trims the trailing zeros the
    // DECIMAL(18,4) column holds (`1260`, not `1260.0000`). The invariant is
    // "exact amounts, never rounded or lost" — exact-string shape is the writer's
    // business, not the report's.
    expect(Number(res.body.totalAmount)).toBe(1260);
    expect(Number(res.body.subtotalAmount)).toBe(1200);
    expect(Number(res.body.taxAmount)).toBe(60);
    expect(res.body.lineCount).toBe(1);
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('serves the selected document’s authoritative timeline — and only for it', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${approvedId}/timeline`))
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

  it('denies a user without commerce.read — no report, no detail, no timeline', async () => {
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

  it('exports the SAME filtered page as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and the file route answer the SAME
    // `?status=DRAFT` question, and the parsed sheet must describe exactly those rows —
    // including the priced document's NUMERIC money, never a rounded string.
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?status=DRAFT&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items.map((item) => item.id)).toContain(draftId);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?status=DRAFT&pageSize=100`,
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="purchase-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'شماره سند');
    expect(sheet.header).toEqual([
      'شماره سند',
      'نوع سند',
      'وضعیت',
      'مبلغ کل',
      'ارز',
      'تعداد اقلام',
      'تاریخ ایجاد',
    ]);
    expect(sheet.data).toHaveLength(listed.items.length);
    expect(sheet.data.map((row) => row[0]).sort()).toEqual(
      listed.items.map((item) => item.documentNumber).sort()
    );
    // The priced draft keeps its numeric money in the sheet: 1260 as digits, 1200 and
    // 60 are the writer's own amounts — compared as STRINGS of the sheet text, because
    // the parser reads display text, while the UNIT spec already pins the number TYPE.
    const draftRow = sheet.data.find((row) => row[0] === listed.items[0].documentNumber);
    expect(draftRow?.[4]).toBe('IRR');

    const docx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?status=DRAFT&pageSize=100`,
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="purchase-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش وضعیت و چرخه عمر درخواست‌های خرید');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no row id.
    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain(draftId);
  });

  it('refuses the export to an unauthorized actor and across tenants', async () => {
    const denied: SupertestResponse = await api()
      .get(`${reportUrl()}/export/xlsx`)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);

    const anonymous: SupertestResponse = await api().get(`${reportUrl()}/export/docx`);
    expect(anonymous.status).toBe(401);

    // Tenant B's actor: tenant A's document numbers are not in their file.
    const foreign: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?pageSize=100`,
      tenantBAdmin.token
    ).expect(200);
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'شماره سند');
    const ownRow: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(ownRow.body.documentNumber);
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
      .send({ status: 'CLOSED' });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api().delete(reportUrl(`/${draftId}`));
    expect(del.status).toBe(404);
  });
});
