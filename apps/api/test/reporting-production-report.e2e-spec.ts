/**
 * Phase REPORTING-PRODUCTION-REPORT — the production report against the real combined
 * runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/production/boms…`)
 *        ↓
 *   approved Production read seam → real `production_db` rows
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
 * the Production HTTP API, and the report is read exclusively through the Reporting
 * HTTP API — the slice under test.
 *
 * DATA SHAPE (Production-native): the register is built from real BOM headers — one
 * DRAFT (no items), one SUBMITTED (one item + submit), one APPROVED (item + submit +
 * decide by the snapshotted approver) and one REJECTED (item + submit + decide with a
 * negative opinion). The tenant-B BOM is a DRAFT. Every header's title is run-scoped so
 * the search and isolation assertions cannot match rows from other runs.
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
import { ensureProductionReportingTestProvisioning } from './fixtures/production-provisioning';
import { ProductionAuditOutboxRelayService } from '../src/modules/production/production-audit-outbox-relay.service';

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
const RUN_ID = `prode2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  const token = await login(email, password);
  return { label, email, password, token, userId, tenantId };
}

interface TenantB {
  tenantId: string;
  admin: Actor;
  approver: Actor;
}

// Tenant B needs its own production module membership and bom feature grant,
// because provisioning a tenant is an admin act with no HTTP surface. Mirrors the
// purchase-report slice: the module registration link, the `production/bom` feature
// grant (the SAME feature the report route declares with `@RequiresFeature`), and
// ADMIN-role actors so they hold `production.bom.read` inside THEIR tenant only.
async function setupTenantB(roleId: string): Promise<TenantB> {
  const db = getCoreDb();
  const tenantId = `tenant-b-${RUN_ID}`;

  await db.tenant.create({ data: { id: tenantId, code: `tenant-b-${RUN_ID}` } });

  const registration = await db.moduleRegistration.findUnique({
    where: { moduleId: 'production' },
  });
  if (!registration) throw new Error('[E2E] production module registration not found');

  await db.moduleRegistrationTenant.create({
    data: { registrationId: registration.id, tenantId },
  });

  const feature = await db.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'production', featureId: 'bom' } },
  });
  if (!feature) throw new Error('[E2E] production.bom feature not found');

  await db.moduleFeatureGrant.create({
    data: { featureRowId: feature.id, tenantId },
  });

  const admin = await createUser('TenantBAdmin', tenantId, roleId);
  const approver = await createUser('TenantBApprover', tenantId, roleId);
  return { tenantId, admin, approver };
}

async function teardownTenantB(tenant: TenantB): Promise<void> {
  const db = getCoreDb();
  await db.moduleFeatureGrant
    .deleteMany({ where: { tenantId: tenant.tenantId } })
    .catch(() => undefined);
  await db.moduleRegistrationTenant
    .deleteMany({ where: { tenantId: tenant.tenantId } })
    .catch(() => undefined);
  await db.user.deleteMany({ where: { id: tenant.admin.userId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: tenant.approver.userId } }).catch(() => undefined);
  await db.tenant.deleteMany({ where: { id: tenant.tenantId } }).catch(() => undefined);
}

// One BOM header through the Production HTTP API — the data-driving seam this slice
// reads back through the Reporting HTTP API.
async function createBom(
  token: string,
  input: {
    title: string;
    projectRef: string;
    productTreeRef: string;
    requesterUserId: string;
    approverUserId: string;
  }
): Promise<{ id: string }> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/production/boms`)
    .set('Authorization', `Bearer ${token}`)
    .send(input)
    .expect(201);
  const id = res.body?.data?.id ?? res.body?.id;
  if (!id || typeof id !== 'string') {
    throw new Error(`[E2E] BOM creation produced no id: ${JSON.stringify(res.body)}`);
  }
  return { id };
}

// The item a BOM needs before it may be submitted (the atomic empty-BOM submit gate).
async function addBomItem(token: string, bomId: string): Promise<void> {
  await api()
    .post(`${API_PREFIX}/production/boms/${bomId}/items`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      partName: `Part-${RUN_ID}`,
      partType: 'STRUCTURAL',
      material: 'steel',
      measurementUnit: 'pcs',
      drawingConsumptionCoefficient: 1,
      spareConsumptionCoefficient: 0,
    })
    .expect(201);
}

async function moveBom(
  token: string,
  bomId: string,
  action: 'submit' | 'approve' | 'reject',
  opinion?: 'APPROVED' | 'REJECTED'
): Promise<void> {
  const path = action === 'submit' ? 'submit' : action === 'approve' ? 'approve' : 'reject';
  const request = api()
    .post(`${API_PREFIX}/production/boms/${bomId}/${path}`)
    .set('Authorization', `Bearer ${token}`);
  if (action === 'submit') {
    await request.send({}).expect(200);
  } else {
    await request.send({ opinion }).expect(200);
  }
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

function reportUrl(suffix = ''): string {
  return `${API_PREFIX}/reporting/production/boms${suffix}`;
}

// Generic so each response keeps its inferred shape at the call site; the one
// narrowing cast lives here, in the harness helpers.
function envelope<T>(body: { data?: T } | T): T {
  return (body as { data?: T }).data ?? (body as T);
}

function idsOf(body: unknown): string[] {
  const page = envelope(body as { items?: unknown });
  return ((page.items ?? []) as { id: string }[]).map((item) => item.id);
}

function statusesOf(body: unknown): (string | null)[] {
  const page = envelope(body as { items?: unknown });
  return ((page.items ?? []) as { status: string }[]).map((item) => item.status);
}

describe('Reporting — Production operational status report (real runtime)', () => {
  let admin: Actor;
  let approver: Actor;
  let noRead: Actor;
  let tenantB: TenantB;

  let draftId = '';
  let submittedId = '';
  let approvedId = '';
  let rejectedId = '';
  let tenantBRowId = '';
  let titlePrefix = '';

  beforeAll(async () => {
    await waitForReadiness();

    // Test-only provisioning for THIS tenant, and it MUST run BEFORE any login: login resolves
    // the caller's permission claim through the PermissionSource port (which caches its answer),
    // so a grant written after the first token is minted leaves every later request carrying a
    // permission-empty identity — and every Production write below would answer 403 instead of
    // 201. Shapes mirrored, nothing else touched: fixtures/production-provisioning.ts.
    await ensureProductionReportingTestProvisioning(getCoreDb(), ['tenant-test-1']);

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
    approver = await createUser('Approver', admin.tenantId, roleId);
    tenantB = await setupTenantB(roleId);

    // The four states of the Production lifecycle, all authored this run and titled
    // run-scoped so search and isolation assertions cannot collide with other runs.
    titlePrefix = `BOM-E2E-${RUN_ID}`;
    const projectRef = `proj-${RUN_ID}`;
    const productTreeRef = `tree-${RUN_ID}`;

    const draft = await createBom(admin.token, {
      title: `${titlePrefix}-draft`,
      projectRef,
      productTreeRef,
      requesterUserId: admin.userId,
      approverUserId: approver.userId,
    });
    draftId = draft.id;

    const submitted = await createBom(admin.token, {
      title: `${titlePrefix}-submitted`,
      projectRef,
      productTreeRef,
      requesterUserId: admin.userId,
      approverUserId: approver.userId,
    });
    submittedId = submitted.id;
    await addBomItem(admin.token, submittedId);
    await moveBom(admin.token, submittedId, 'submit');

    const approved = await createBom(admin.token, {
      title: `${titlePrefix}-approved`,
      projectRef,
      productTreeRef,
      requesterUserId: admin.userId,
      approverUserId: approver.userId,
    });
    approvedId = approved.id;
    await addBomItem(admin.token, approvedId);
    await moveBom(admin.token, approvedId, 'submit');
    // Decide is the snapshotted APPROVER's act — and only theirs. The admin authors
    // and submits, but the approval that completes this BOM belongs to `approver`.
    await moveBom(approver.token, approvedId, 'approve', 'APPROVED');

    const rejected = await createBom(admin.token, {
      title: `${titlePrefix}-rejected`,
      projectRef,
      productTreeRef,
      requesterUserId: admin.userId,
      approverUserId: approver.userId,
    });
    rejectedId = rejected.id;
    await addBomItem(admin.token, rejectedId);
    await moveBom(admin.token, rejectedId, 'submit');
    await moveBom(approver.token, rejectedId, 'reject', 'REJECTED');

    const tenantBRow = await createBom(tenantB.admin.token, {
      title: `${titlePrefix}-tenant-b`,
      projectRef: `proj-b-${RUN_ID}`,
      productTreeRef: `tree-b-${RUN_ID}`,
      requesterUserId: tenantB.admin.userId,
      approverUserId: tenantB.approver.userId,
    });
    tenantBRowId = tenantBRow.id;
  }, 120_000);

  it('lists this tenant’s filtered register WITH its summary — statuses zero-filled', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(titlePrefix)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const page = envelope(res.body);
    expect(Array.isArray(page.items)).toBe(true);
    // The strictly filtered page holds exactly the four rows this run authored.
    expect(idsOf(res.body).sort()).toEqual([approvedId, draftId, rejectedId, submittedId].sort());

    // The summary strip is over the SAME population: total = the filtered total, every
    // one of the four lifecycle members present, one row each. Rows from OTHER runs can
    // exist in this tenant, but the run-scoped search excludes them from both halves.
    expect(page.summary.total).toBe(4);
    expect(page.summary.byStatus).toEqual({
      DRAFT: 1,
      SUBMITTED: 1,
      APPROVED: 1,
      REJECTED: 1,
    });
  });

  it('refuses a client-supplied tenantId — the scope is server-side, not a field', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?tenantId=${admin.tenantId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('refuses an unknown status — never a filter the database silently matches nothing with', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?status=DRAFTY&search=${encodeURIComponent(titlePrefix)}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(422);
  });

  it('filters by the source lifecycle status — every row matches, nothing else does', async () => {
    const search = encodeURIComponent(titlePrefix);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['DRAFT', draftId],
      ['SUBMITTED', submittedId],
      ['APPROVED', approvedId],
      ['REJECTED', rejectedId],
    ];
    for (const [status, expectedId] of cases) {
      const res: SupertestResponse = await api()
        .get(reportUrl(`?search=${search}&status=${status}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      expect(idsOf(res.body)).toContain(expectedId);
      for (const rowStatus of statusesOf(res.body)) {
        expect(rowStatus).toBe(status);
      }
    }
  });

  it('searches the header title — the report’s one text column', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`?search=${encodeURIComponent(`${titlePrefix}-approved`)}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(idsOf(res.body)).toEqual([approvedId]);
    const page = envelope(res.body);
    for (const row of page.items as { title: string }[]) {
      expect(row.title).toContain(`${titlePrefix}-approved`);
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
  });

  it('keeps tenant B’s row out of tenant A’s register, detail and timeline', async () => {
    const scoped = await api()
      .get(reportUrl(`?search=${encodeURIComponent(titlePrefix)}`))
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
      .get(reportUrl(`?search=${encodeURIComponent(titlePrefix)}`))
      .set('Authorization', `Bearer ${tenantB.admin.token}`)
      .expect(200);

    expect(idsOf(res.body)).toEqual([tenantBRowId]);
  });

  it('serves exactly the ten-field projection — actor ids, comments and bookkeeping stay behind', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${submittedId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(
      [
        'id',
        'title',
        'projectRef',
        'productTreeRef',
        'status',
        'managerOpinion',
        'itemCount',
        'submittedAt',
        'decidedAt',
        'createdAt',
      ].sort()
    );
    for (const forbidden of [
      'tenantId',
      'requesterUserId',
      'approverUserId',
      'decidedByUserId',
      'comments',
      'updatedAt',
    ]) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
    // The factual claims the register makes: this BOM was submitted with one item and
    // no decision recorded yet.
    expect(res.body.id).toBe(submittedId);
    expect(res.body.title).toBe(`${titlePrefix}-submitted`);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.itemCount).toBe(1);
    expect(res.body.managerOpinion).toBeNull();
    expect(res.body.submittedAt).not.toBeNull();
    expect(res.body.decidedAt).toBeNull();
  });

  it('shows a decided BOM’s opinion and decision instant — the row the approver’s act wrote', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${approvedId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.status).toBe('APPROVED');
    expect(res.body.managerOpinion).toBe('APPROVED');
    expect(res.body.decidedAt).not.toBeNull();
    expect(res.body.itemCount).toBe(1);
  });

  it('counts an item-less draft as zero items — the state that cannot be submitted', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${draftId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.status).toBe('DRAFT');
    expect(res.body.itemCount).toBe(0);
    expect(res.body.submittedAt).toBeNull();
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('serves the selected BOM’s authoritative timeline — and only for it', async () => {
    // The audit outbox is the platform's intentional async durability design: each Production
    // mutation commits its audit intent with the business row, and
    // ProductionAuditOutboxRelayService delivers it to core_db."AuditLog" on a poll — whose own
    // contract documents a direct call from tests (financial-check-issuance.e2e-spec.ts reads its
    // timeline the same way). The whole suite lifecycle fits inside one relay window, and the
    // events this test asserts are NOT symmetric: some are written synchronously through
    // AUDIT_PORT while the others are still unclaimed outbox rows. So drain the outbox
    // deterministically before reading. Production code and every assertion below are unchanged.
    await getApp().get(ProductionAuditOutboxRelayService).relay();

    const res: SupertestResponse = await api()
      .get(reportUrl(`/${submittedId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(2); // create + item create + submit were audited
    const actions = res.body.items.map((item: { action: string }) => item.action);
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

  it('denies a user without production.bom.read — no report, no detail, no timeline', async () => {
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

  it('exports the SAME BOM page as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: list and file answer `?status=DRAFT`, and the parsed
    // sheet must describe exactly those BOMs.
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?status=DRAFT&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?status=DRAFT&pageSize=100`,
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="production-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'عنوان');
    expect(sheet.header).toEqual([
      'عنوان',
      'پروژه',
      'وضعیت',
      'نظر مدیر',
      'تعداد اقلام',
      'تاریخ ایجاد',
    ]);
    expect(sheet.data).toHaveLength(listed.items.length);
    expect(sheet.data.map((row) => row[0])).toEqual(listed.items.map((item: { title: string }) => item.title));
    expect(sheet.firstColumn).toContain('وضعیت');

    const docx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?status=DRAFT&pageSize=100`,
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="production-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش خلاصه و وضعیت عملیات تولید');
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

    // Tenant B's actor: tenant A's DRAFT title is not in their file.
    const foreign: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?pageSize=100`,
      tenantB.admin.token
    ).expect(200);
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'عنوان');
    const ownRow: SupertestResponse = await api()
      .get(`${reportUrl()}/${draftId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(envelope(ownRow.body).title);
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

    const del: SupertestResponse = await api().delete(reportUrl(`/${draftId}`));
    expect(del.status).toBe(404);
  });

  afterAll(async () => {
    await teardownTenantB(tenantB).catch(() => undefined);
    for (const uid of [approver?.userId, noRead?.userId].filter(Boolean) as string[]) {
      await getCoreDb()
        .user.deleteMany({ where: { id: uid } })
        .catch(() => undefined);
    }
  });
});
