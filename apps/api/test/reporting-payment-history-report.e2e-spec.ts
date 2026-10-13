/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY — the commerce payment history report
 * against the real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/commerce/payment-history…`)
 *        ↓
 *   approved SECOND Commerce read seam → real `commerce_db` PaymentRecord rows
 *        ↓
 *   tenant-scoped list → detail → exports → NO-WRITE STATE PROOF
 *
 * Covered: the happy path with an EXACT row grain (one row per PaymentRecord,
 * compensating rows included), every supported source filter (`method` over the closed
 * three, `search` against references + the parent document number, `purchaseDocumentId`,
 * the HALF-OPEN `[paymentFrom, paymentTo)` window on `paymentDate` incl. a same-day
 * case), an inverted window and an unknown method as refusals, empty results, the
 * projection whitelist, detail, foreign/unknown id → 404, 401/403, cross-tenant
 * list/detail/export in both directions, NO timeline route, NO write route, an
 * explicit no-write STATE PROOF over both the source rows and the platform audit
 * trail, and the XLSX/DOCX exports parsed back to their rows — same population as
 * the list, tenant-safe in both directions.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client;
 * the business data itself — purchase documents, payments, the compensating row — is
 * driven through the Commerce HTTP API (the real write paths); the report is read
 * exclusively through the Reporting HTTP API — the slice under test. Population
 * assertions scope by `purchaseDocumentId` so a previous run's leftovers can never
 * enter this run (the isolation reasoning every sibling report achieves with its own
 * run-scoped code).
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
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';

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
const RUN_ID = `payrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
  tenantBAdmin: `B-${RUN_ID}`,
  noRead: `NoRead-${RUN_ID}`,
} as const;

/** The payment dates this run states — the report's PRIMARY date, exactly as written. */
const PAYMENT_DATES = {
  cash: '2026-01-05T10:00:00.000Z',
  check: '2026-03-15T10:00:00.000Z',
  compensation: '2026-03-16T10:00:00.000Z',
  tenantB: '2026-02-01T10:00:00.000Z',
} as const;

const XLSX_HEADERS = [
  'شماره سند',
  'نوع رویداد',
  'روش پرداخت',
  'مبلغ',
  'ارز',
  'تاریخ پرداخت',
  'مرجع صورتحساب',
  'مرجع خارجی',
] as const;

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

function getCommerceDb(): CommercePrismaService {
  return getApp().get(CommercePrismaService);
}

// Unwraps the standard `{ data }` envelope (or passes a bare body through).
// Generic so each response keeps its inferred shape at the call site; the one
// narrowing cast lives here, in the harness helper.
const envelope = <T,>(body: { data?: T } | T): T =>
  (body as { data?: T }).data ?? (body as T);

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
 * A SECOND tenant entitled to `commerce` — the isolation half of the slice, mirroring
 * what a real tenant provisioning leaves behind (module registration link,
 * `commerce/purchase` feature grant, an ADMIN role inside ITS tenant only).
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

/** One priced document through the COMMERCE API (the writer side). */
async function createDocument(
  token: string,
  requesterId: string
): Promise<{ id: string; documentNumber: string }> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      requesterId,
      supplierId: 'SUP-E2E-PAY',
      currency: 'IRR',
      lines: [{ lineType: 'STANDARD', quantity: 1, unit: 'PCS', unitPrice: 100, tax: 10 }],
    })
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  return { id: body.id, documentNumber: body.documentNumber };
}

/** One payment event through the COMMERCE API (the real append path, `commerce.manage`). */
async function appendPayment(
  token: string,
  documentId: string,
  payload: Record<string, unknown>
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents/${documentId}/payments`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

/** The compensating row through the COMMERCE API — the ONLY correction mechanism. */
async function compensatePayment(
  token: string,
  documentId: string,
  paymentId: string,
  payload: Record<string, unknown>
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(
      `${API_PREFIX}/commerce/purchase-documents/${documentId}/payments/${paymentId}/compensate`
    )
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.id).toBe('string');
  return body.id as string;
}
describe('Reporting — Commerce Payment History Report (eighth vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantBAdmin: Actor;
  let tenantAId: string;
  let docAId: string;
  let docANumber: string;
  let cashPaymentId: string;
  let checkPaymentId: string;
  let compensationPaymentId: string;
  let tenantBDocId: string;
  let tenantBPaymentId: string;

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/commerce/payment-history${suffix}`;
  /** The run's own population — every list assertion scopes through this one filter. */
  const scoped = (extra = '') =>
    `${reportUrl()}?purchaseDocumentId=${docAId}${extra ? `&${extra}` : ''}`;

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

    // REAL source data, driven through the Commerce API (the writer side): one
    // document with a CASH payment, a CHECK payment and the CHECK payment's
    // compensating row — the append-only grain this report must preserve.
    const docA = await createDocument(admin.token, admin.userId);
    docAId = docA.id;
    docANumber = docA.documentNumber;

    cashPaymentId = await appendPayment(admin.token, docAId, {
      amount: 30,
      method: 'CASH',
      paymentDate: PAYMENT_DATES.cash,
      invoiceRef: `INV-${RUN_ID}`,
    });
    checkPaymentId = await appendPayment(admin.token, docAId, {
      amount: 20,
      method: 'CHECK',
      paymentDate: PAYMENT_DATES.check,
      externalReference: `EXT-${RUN_ID}`,
    });
    compensationPaymentId = await compensatePayment(admin.token, docAId, checkPaymentId, {
      paymentDate: PAYMENT_DATES.compensation,
      reason: `run-scoped compensation ${RUN_ID}`,
    });

    // Tenant B's own payment — the cross-tenant probe.
    const docB = await createDocument(tenantBAdmin.token, tenantBAdmin.userId);
    tenantBDocId = docB.id;
    tenantBPaymentId = await appendPayment(tenantBAdmin.token, tenantBDocId, {
      amount: 10,
      method: 'CASH',
      paymentDate: PAYMENT_DATES.tenantB,
    });
  }, 120_000);

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

  /**
   * The SOURCE snapshot for the no-write proof: this run's payment rows (every column
   * the schema stores) plus the platform audit events whose `resourceType` is the
   * payment resource and whose `resourceId` names this run's documents — payment acts
   * audit `resourceId = documentId` (`payment-history.service.ts`). A reporting read
   * can change NEITHER; the assertions re-read both after every report surface has
   * been exercised.
   */
  async function snapshotSource() {
    const rows = await getCommerceDb().paymentRecord.findMany({
      where: { purchaseDocumentId: { in: [docAId, tenantBDocId] } },
      orderBy: { id: 'asc' },
    });
    const serialized = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      purchaseDocumentId: row.purchaseDocumentId,
      amount: String(row.amount),
      currency: row.currency,
      method: row.method,
      paymentDate: row.paymentDate.toISOString(),
      payerRef: row.payerRef,
      payeeRef: row.payeeRef,
      invoiceRef: row.invoiceRef,
      externalReference: row.externalReference,
      reversesPaymentId: row.reversesPaymentId,
      recordedByUserId: row.recordedByUserId,
      createdAt: row.createdAt.toISOString(),
    }));
    const auditCount = await getCoreDb().auditLog.count({
      where: {
        resourceType: 'commerce.payment_record',
        resourceId: { in: [docAId, tenantBDocId] },
      },
    });
    return { serialized, auditCount };
  }

  /** The outbox relay delivers asynchronously — wait for THIS run's four events. */
  async function waitForPaymentAuditDelivery(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { auditCount } = await snapshotSource();
      // append + append + compensate on docA, append on docB.
      if (auditCount >= 4) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('[E2E] payment audit events were not delivered within the timeout');
  }

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
    // The summary counts every state of the CLOSED method set — no holes.
    for (const method of ['CASH', 'PETTY_CASH', 'CHECK']) {
      expect(body.summary.byMethod).toHaveProperty(method);
    }
    expect(body.summary.total).toBeGreaterThanOrEqual(3);
  });

  it('keeps the row grain EXACTLY one row per payment — compensating rows included', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    // Three appends against this run's document: CASH, CHECK, and the CHECK's
    // compensation. The report must NOT collapse them into one document row.
    expect(body.total).toBe(3);
    const ids = body.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(
      expect.arrayContaining([cashPaymentId, checkPaymentId, compensationPaymentId])
    );

    // Newest `paymentDate` first — the report's PRIMARY date, stated by this run.
    expect(ids[0]).toBe(compensationPaymentId);
    expect(ids[1]).toBe(checkPaymentId);
    expect(ids[2]).toBe(cashPaymentId);

    // The compensation points at the row it reverses; ordinary payments do not.
    const byId = new Map<string, Record<string, unknown>>(body.items.map((item) => [item.id, item]));
    expect(byId.get(compensationPaymentId).reversesPaymentId).toBe(checkPaymentId);
    expect(byId.get(checkPaymentId).reversesPaymentId).toBeNull();
    expect(byId.get(cashPaymentId).reversesPaymentId).toBeNull();

    // Row-grain honesty: a compensating amount is NEGATIVE, never a rewritten row.
    expect(Number(byId.get(compensationPaymentId).amount)).toBe(-20);
    expect(Number(byId.get(cashPaymentId).amount)).toBe(30);
  });

  it('filters by method through the source vocabulary — every result matches', async () => {
    const cash: SupertestResponse = await api()
      .get(scoped('&method=CASH&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const check: SupertestResponse = await api()
      .get(scoped('&method=CHECK&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const cashBody = envelope(cash.body);
    const checkBody = envelope(check.body);
    expect(cashBody.items.map((item) => item.id)).toEqual([cashPaymentId]);
    expect(checkBody.items.map((item) => item.id).sort()).toEqual(
      [checkPaymentId, compensationPaymentId].sort()
    );
    for (const item of cashBody.items) expect(item.method).toBe('CASH');
    for (const item of checkBody.items) expect(item.method).toBe('CHECK');
    // The method filter is the summary's own dimension: CHECK rows = CHECK count.
    expect(checkBody.summary.byMethod.CHECK).toBe(2);
    expect(checkBody.summary.total).toBe(2);
  });

  it('refuses an unknown method — never a filter the database silently empties', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&method=WIRE'))
      .set('Authorization', `Bearer ${admin.token}`);
    // 422: the production ValidationPipe maps `@IsIn` membership refusal to
    // `UnprocessableEntityException` — what matters is the REFUSAL itself.
    expect(res.status).toBe(422);
  });

  it('windows on paymentDate as a HALF-OPEN [from, to) — same-day inclusive, day after excluded', async () => {
    // The CHECK payment's own day: `[2026-03-15T00:00Z, 2026-03-16T00:00Z)` contains
    // its 10:00 instant and neither neighbour payment.
    const window: SupertestResponse = await api()
      .get(
        scoped(
          '&paymentFrom=2026-03-15T00:00:00.000Z&paymentTo=2026-03-16T00:00:00.000Z&pageSize=100'
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(window.body).items.map((item) => item.id)).toEqual([checkPaymentId]);

    // Same-day behaviour: the compensation's day alone.
    const sameDay: SupertestResponse = await api()
      .get(
        scoped(
          '&paymentFrom=2026-03-16T00:00:00.000Z&paymentTo=2026-03-17T00:00:00.000Z&pageSize=100'
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(sameDay.body).items.map((item) => item.id)).toEqual([
      compensationPaymentId,
    ]);

    // The EXCLUSIVE end: an instant exactly at `paymentTo` is OUT of the window.
    const edge: SupertestResponse = await api()
      .get(
        scoped(
          '&paymentFrom=2026-03-15T00:00:00.000Z&paymentTo=2026-03-15T10:00:00.000Z&pageSize=100'
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(edge.body).items).toEqual([]);
  });

  it('refuses an inverted window with a 400 and a malformed instant with a 422', async () => {
    const inverted: SupertestResponse = await api()
      .get(scoped('&paymentFrom=2026-03-16T00:00:00.000Z&paymentTo=2026-03-15T00:00:00.000Z'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(inverted.status).toBe(400);

    const malformed: SupertestResponse = await api()
      .get(scoped('&paymentFrom=not-a-date'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(malformed.status).toBe(422);
  });

  it('filters by search against the row references AND the parent document number', async () => {
    // The CASH payment's invoice ref lives on the row itself.
    const byRef: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(`INV-${RUN_ID}`)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(byRef.body).items.map((item) => item.id)).toEqual([cashPaymentId]);
    expect(envelope(byRef.body).items[0].invoiceRef).toBe(`INV-${RUN_ID}`);

    // The CHECK payment's external reference — a different column of the same OR.
    const byExt: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(`EXT-${RUN_ID}`)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(byExt.body).items.map((item) => item.id)).toEqual([checkPaymentId]);
    expect(envelope(byExt.body).items[0].externalReference).toBe(`EXT-${RUN_ID}`);

    // The parent document's number — the same-owner join a tenant-wide register needs.
    const byNumber: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(docANumber)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = envelope(byNumber.body);
    const ids = body.items.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([cashPaymentId, checkPaymentId, compensationPaymentId])
    );
    for (const item of body.items) expect(item.purchaseDocumentNumber).toBe(docANumber);
  });

  it('answers an impossible filter with an empty page — not an error', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?purchaseDocumentId=${randomUUID()}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.summary.total).toBe(0);
    for (const method of ['CASH', 'PETTY_CASH', 'CHECK']) {
      expect(body.summary.byMethod[method]).toBe(0);
    }
  });

  it('keeps the summary and the list on the SAME population — one predicate, two reads', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.summary.total).toBe(body.total);
    const sum = ['CASH', 'PETTY_CASH', 'CHECK'].reduce(
      (accumulator, method) => accumulator + body.summary.byMethod[method],
      0
    );
    // The closed three-member set PARTITIONS the population: the counts add up to
    // the total exactly — no hidden bucket, no double count.
    expect(sum).toBe(body.total);
    expect(body.summary.byMethod.CHECK).toBe(2);
    expect(body.summary.byMethod.CASH).toBe(1);
  });

  it('never leaks tenant B rows into tenant A — register and detail', async () => {
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const ids = envelope(list.body).items.map((item) => item.id);
    expect(ids).not.toContain(tenantBPaymentId);

    // A foreign id behaves EXACTLY like a missing one: 404, not 403.
    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBPaymentId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);
  });

  it('returns the projection whitelist for a detail — twelve fields, no internals', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${cashPaymentId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const row = envelope(res.body);

    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'amount',
        'currency',
        'method',
        'paymentDate',
        'payerRef',
        'payeeRef',
        'invoiceRef',
        'externalReference',
        'reversesPaymentId',
      ].sort()
    );
    // Sensitive/internal fields never cross: the tenant, the raw actor, the insert
    // clock, and a per-row status that does not exist in the schema at all.
    for (const forbidden of [
      'tenantId',
      'recordedByUserId',
      'createdAt',
      'status',
      'paymentStatus',
      'updatedAt',
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    expect(row.purchaseDocumentNumber).toBe(docANumber);
    expect(Number(row.amount)).toBe(30);
    expect(row.paymentDate).toBe(PAYMENT_DATES.cash);
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('offers NO timeline route — the document-bound audit trail is not row history', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${cashPaymentId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('denies a user without commerce.read — no report, no detail, no export', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${cashPaymentId}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(detail.status).toBe(403);

    const exportDenied: SupertestResponse = await api()
      .get(`${reportUrl()}/export/xlsx`)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(exportDenied.status).toBe(403);
  });

  it('requires authentication at all', async () => {
    const list: SupertestResponse = await api().get(reportUrl());
    expect(list.status).toBe(401);

    const exportAnonymous: SupertestResponse = await api().get(`${reportUrl()}/export/docx`);
    expect(exportAnonymous.status).toBe(401);
  });

  it('exports the SAME filtered page as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and the file routes answer the SAME
    // `purchaseDocumentId` question, and the parsed sheet must describe exactly those
    // rows — the compensation's NEGATIVE amount included, never collapsed.
    const list: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items.map((item) => item.id).sort()).toEqual(
      [cashPaymentId, checkPaymentId, compensationPaymentId].sort()
    );

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-payment-history-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'شماره سند');
    expect(sheet.header).toEqual([...XLSX_HEADERS]);
    expect(sheet.data).toHaveLength(listed.items.length);
    expect(sheet.data.map((row) => row[0])).toEqual([docANumber, docANumber, docANumber].sort());
    // The exact same compensation row the list shows: document, kind word, method,
    // NEGATIVE amount — the export cannot soften the row grain.
    const compensationRow = sheet.data.find((row) => row[1] === 'رویداد جبرانی');
    expect(compensationRow).toBeDefined();
    expect(compensationRow?.[3]).toBe('-20');
    // No scope or actor internals in the sheet text.
    const sheetText = JSON.stringify(sheet.data);
    expect(sheetText).not.toContain(tenantAId);
    expect(sheetText).not.toContain(admin.userId);
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
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(docANumber);
  });

  it('renders the Word document from the SAME list — title, RTL, one table, no scope', async () => {
    const list: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);

    const docx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-payment-history-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش تاریخچه پرداخت‌های بازرگانی');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no payment row id — the filter
    // echo carries the DOCUMENT id the caller itself supplied, never the row's.
    expect(xml).not.toContain(tenantAId);
    expect(xml).not.toContain(cashPaymentId);
    expect(xml).not.toContain(admin.userId);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${cashPaymentId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 999 });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api().delete(reportUrl(`/${cashPaymentId}`));
    expect(del.status).toBe(404);
  });

  it('NO-WRITE PROOF: every report surface leaves source rows and audit trail unchanged', async () => {
    // The fixture's OWN audit events must have landed first, or the equality below
    // could pass vacuously while the relay is still in flight.
    await waitForPaymentAuditDelivery();
    const before = await snapshotSource();
    expect(before.serialized).toHaveLength(4); // non-vacuity: this run's four payments
    expect(before.auditCount).toBeGreaterThanOrEqual(4);

    // Exercise EVERY authorized read surface: unfiltered list, scoped list, summary,
    // detail, both exports.
    await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&method=CHECK'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${cashPaymentId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?purchaseDocumentId=${docAId}`,
      admin.token
    ).expect(200);
    await getExportFile(
      api(),
      `${reportUrl()}/export/docx?purchaseDocumentId=${docAId}`,
      admin.token
    ).expect(200);

    const after = await snapshotSource();
    // Row count, status-free amounts, dates, references, actors — byte-identical.
    expect(after.serialized).toEqual(before.serialized);
    // And NOT ONE audit event was generated by reading: a write would have arrived
    // as a `commerce.payment_record` row (or a write of any other resource).
    expect(after.auditCount).toBe(before.auditCount);
  }, 120_000);
});
