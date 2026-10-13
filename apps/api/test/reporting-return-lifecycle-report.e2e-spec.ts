/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE — the commerce return lifecycle report
 * against the real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/commerce/return-lifecycle…`)
 *        ↓
 *   approved THIRD Commerce read seam → real `commerce_db` ReturnDocument rows
 *        ↓
 *   tenant-scoped list → detail → timeline → exports → NO-WRITE STATE PROOF
 *
 * Covered: the happy path with an EXACT row grain (one row per ReturnDocument),
 * every supported source filter (`state` over the closed FIVE-member projected
 * vocabulary — the fixture drives REAL lifecycle transitions through the Commerce
 * API so all five states exist, `search` against the return's own reason + the
 * parent document number, `purchaseDocumentId`, the HALF-OPEN `[createdFrom,
 * createdTo)` window on `createdAt` incl. same-day and exclusive-edge cases), an
 * inverted window and an unknown state as refusals, empty results, the projection
 * whitelist, detail with lines, the audit-backed timeline bound to the RETURN id,
 * foreign/unknown id → 404, 401/403, cross-tenant list/detail/export in both
 * directions, NO write route, an explicit no-write STATE PROOF over the source
 * rows and the platform audit trail, and the XLSX/DOCX exports parsed back to
 * their rows — same population as the list, tenant-safe in both directions.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client;
 * the business data itself — purchase document, receipt, payment, five returns and
 * their four lifecycle transitions — is driven through the Commerce HTTP API (the
 * real write paths); the report is read exclusively through the Reporting HTTP API
 * — the slice under test. Population assertions scope by `purchaseDocumentId` (or
 * the run-scoped reason) so a previous run's leftovers can never enter this run.
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
const RUN_ID = `retrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
  tenantBAdmin: `B-${RUN_ID}`,
  noRead: `NoRead-${RUN_ID}`,
} as const;

/** The XLSX header row this report renders — the presentation's six columns, in order. */
const XLSX_HEADERS = [
  'شماره سند خرید',
  'وضعیت',
  'دلیل',
  'جایگزینی',
  'تعداد اقلام',
  'تاریخ درخواست',
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

/** One priced document through the COMMERCE API (the writer side) — with its lines. */
async function createDocument(
  token: string,
  requesterId: string,
  quantity: number,
  unitPrice: number
): Promise<{ id: string; documentNumber: string; lineId: string }> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      requesterId,
      supplierId: 'SUP-E2E-RET',
      currency: 'IRR',
      lines: [{ lineType: 'STANDARD', quantity, unit: 'PCS', unitPrice, tax: 0 }],
    })
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  return { id: body.id, documentNumber: body.documentNumber, lineId: body.lines[0].id };
}

/** One payment event through the COMMERCE API — the compensation target the refund needs. */
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

/** One receipt through the COMMERCE API — returns may only reverse RECEIVED quantities. */
async function receiveGoods(
  token: string,
  documentId: string,
  purchaseLineId: string,
  quantity: number
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents/${documentId}/receipts`)
    .set('Authorization', `Bearer ${token}`)
    .send({ lines: [{ purchaseLineId, quantity }] })
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.lines?.[0]?.id).toBe('string');
  return body.lines[0].id as string;
}

/** One return request through the COMMERCE API — starts the child lifecycle at REQUESTED. */
async function createReturn(
  token: string,
  documentId: string,
  payload: Record<string, unknown>
): Promise<{ id: string; createdAt: string }> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents/${documentId}/returns`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.id).toBe('string');
  expect(body.state).toBe('REQUESTED');
  return { id: body.id, createdAt: body.createdAt };
}

/** One of the four lifecycle commands — each APPENDS exactly one transition row. */
async function transition(
  token: string,
  documentId: string,
  returnId: string,
  command: 'approve' | 'reject' | 'receive-back' | 'refund',
  payload: Record<string, unknown> = {}
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents/${documentId}/returns/${returnId}/${command}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  return body.state as string;
}

describe('Reporting — Commerce Return Lifecycle Report (ninth vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantBAdmin: Actor;
  let tenantAId: string;
  let docAId: string;
  let docANumber: string;
  let lineAId: string;
  let receiptLineAId: string;
  let paymentId: string;

  /** The five returns — one per lifecycle STATE, driven through the real Commerce API. */
  let retRefunded: { id: string; createdAt: string };
  let retReceivedBack: { id: string; createdAt: string };
  let retApproved: { id: string; createdAt: string };
  let retRequested: { id: string; createdAt: string };
  let retRejected: { id: string; createdAt: string };

  /** Tenant B's own document + return — the cross-tenant probe. */
  let tenantBDocId: string;
  let tenantBReturnId: string;
  /** The live-transition test's sixth return, once created — joins the snapshot scope. */
  let liveReturnId: string | null = null;

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/commerce/return-lifecycle${suffix}`;
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

    // REAL source data through the Commerce API: one document, fully received, one
    // payment to refund against, and FIVE returns — one per state of the closed
    // five-member vocabulary, reached by the real lifecycle commands.
    const docA = await createDocument(admin.token, admin.userId, 100, 10);
    docAId = docA.id;
    docANumber = docA.documentNumber;
    lineAId = docA.lineId;
    receiptLineAId = await receiveGoods(admin.token, docAId, lineAId, 100);
    paymentId = await appendPayment(admin.token, docAId, {
      amount: 50,
      method: 'CASH',
      paymentDate: '2026-01-05T10:00:00.000Z',
      externalReference: `EXT-${RUN_ID}`,
    });

    const line = { purchaseLineId: lineAId, receiptLineId: receiptLineAId };
    // REQUESTED → APPROVED → RECEIVED_BACK → REFUNDED: the full forward chain.
    retRefunded = await createReturn(admin.token, docAId, {
      reason: `کالای معیوب ${RUN_ID}`,
      replacementRequired: false,
      lines: [{ ...line, quantity: 10 }],
    });
    expect(await transition(admin.token, docAId, retRefunded.id, 'approve')).toBe('APPROVED');
    expect(await transition(admin.token, docAId, retRefunded.id, 'receive-back')).toBe(
      'RECEIVED_BACK'
    );
    expect(
      await transition(admin.token, docAId, retRefunded.id, 'refund', {
        paymentId,
        reason: 'refund of the run-scoped payment',
      })
    ).toBe('REFUNDED');

    // One stop short of refund: RECEIVED_BACK.
    retReceivedBack = await createReturn(admin.token, docAId, {
      reason: 'آسیب دیده در حمل',
      replacementRequired: false,
      lines: [{ ...line, quantity: 10 }],
    });
    expect(await transition(admin.token, docAId, retReceivedBack.id, 'approve')).toBe('APPROVED');
    expect(await transition(admin.token, docAId, retReceivedBack.id, 'receive-back')).toBe(
      'RECEIVED_BACK'
    );

    // Approved but not yet received back.
    retApproved = await createReturn(admin.token, docAId, {
      reason: 'مغایرت با سفارش',
      replacementRequired: true,
      lines: [{ ...line, quantity: 10 }],
    });
    expect(await transition(admin.token, docAId, retApproved.id, 'approve')).toBe('APPROVED');

    // Requested only — untouched.
    retRequested = await createReturn(admin.token, docAId, {
      reason: 'مازاد نیاز',
      replacementRequired: false,
      lines: [{ ...line, quantity: 10 }],
    });

    // The terminal REJECTED branch of the matrix.
    retRejected = await createReturn(admin.token, docAId, {
      reason: 'انصراف خریدار',
      replacementRequired: false,
      lines: [{ ...line, quantity: 10 }],
    });
    expect(await transition(admin.token, docAId, retRejected.id, 'reject', { reason: 'no' })).toBe(
      'REJECTED'
    );

    // Tenant B's own return — the cross-tenant probe (stays REQUESTED).
    const docB = await createDocument(tenantBAdmin.token, tenantBAdmin.userId, 1, 10);
    tenantBDocId = docB.id;
    const receiptLineB = await receiveGoods(tenantBAdmin.token, tenantBDocId, docB.lineId, 1);
    const returnB = await createReturn(tenantBAdmin.token, tenantBDocId, {
      reason: 'tenant B goods',
      replacementRequired: false,
      lines: [{ purchaseLineId: docB.lineId, receiptLineId: receiptLineB, quantity: 1 }],
    });
    tenantBReturnId = returnB.id;
  }, 180_000);

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

  /** Every return id this run owns — the snapshot and the audit wait scope through it. */
  const allReturnIds = () => [
    retRefunded.id,
    retReceivedBack.id,
    retApproved.id,
    retRequested.id,
    retRejected.id,
    tenantBReturnId,
    ...(liveReturnId ? [liveReturnId] : []),
  ];

  /**
   * The SOURCE snapshot for the no-write proof: this run's return documents, lines
   * and lifecycle transitions (every column the schema stores) plus the platform
   * audit events whose `resourceType` is the return resource and whose `resourceId`
   * names this run's returns — return acts audit `resourceId = return document id`
   * (`return-history.service.ts`). A reporting read can change NEITHER; the
   * assertions re-read both after every report surface has been exercised.
   */
  async function snapshotSource() {
    const ids = allReturnIds();
    const documents = await getCommerceDb().returnDocument.findMany({
      where: { purchaseDocumentId: { in: [docAId, tenantBDocId] } },
      orderBy: { id: 'asc' },
    });
    const serializedDocuments = documents.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      purchaseDocumentId: row.purchaseDocumentId,
      requestedByUserId: row.requestedByUserId,
      reason: row.reason,
      replacementRequired: row.replacementRequired,
      createdAt: row.createdAt.toISOString(),
    }));
    const lines = await getCommerceDb().returnLine.findMany({
      where: { returnDocumentId: { in: ids } },
      orderBy: { id: 'asc' },
    });
    const serializedLines = lines.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      returnDocumentId: row.returnDocumentId,
      purchaseLineId: row.purchaseLineId,
      receiptLineId: row.receiptLineId,
      quantity: String(row.quantity),
      createdAt: row.createdAt.toISOString(),
    }));
    const transitions = await getCommerceDb().returnLifecycleTransition.findMany({
      where: { returnDocumentId: { in: ids } },
      orderBy: { id: 'asc' },
    });
    const serializedTransitions = transitions.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      returnDocumentId: row.returnDocumentId,
      state: row.state,
      actorUserId: row.actorUserId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
    const auditCount = await getCoreDb().auditLog.count({
      where: { resourceType: 'commerce.return_document', resourceId: { in: ids } },
    });
    return { serializedDocuments, serializedLines, serializedTransitions, auditCount };
  }

  /**
   * The outbox relay delivers asynchronously — wait for THIS run's thirteen events:
   * create+approve+receive_back+refund (4) + create+approve+receive_back (3) +
   * create+approve (2) + create (1) + create+reject (2) on tenant A, plus tenant B's
   * lone create. The no-write equality below must never pass vacuously mid-flight.
   */
  async function waitForReturnAuditDelivery(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { auditCount } = await snapshotSource();
      if (auditCount >= 13) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('[E2E] return audit events were not delivered within the timeout');
  }

  it('serves the register with page + summary to an authorized reader', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.summary.total).toBe('number');
    // The summary counts every state of the CLOSED five-member set — no holes.
    for (const state of ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED']) {
      expect(body.summary.byState).toHaveProperty(state);
    }
    expect(body.summary.total).toBeGreaterThanOrEqual(5);
  });

  it('keeps the row grain EXACTLY one row per return document', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.total).toBe(5);
    const ids = body.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids.sort()).toEqual(
      [retRefunded.id, retReceivedBack.id, retApproved.id, retRequested.id, retRejected.id].sort()
    );
    // Every row answers exactly the projection fields the contract whitelists.
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'purchaseDocumentId',
          'purchaseDocumentNumber',
          'state',
          'reason',
          'replacementRequired',
          'lineCount',
          'createdAt',
        ].sort()
      );
      expect(item.purchaseDocumentNumber).toBe(docANumber);
      expect(item.lineCount).toBe(1);
    }
  });

  it('orders newest createdAt first — the report’s PRIMARY date, non-increasing', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const items = envelope(res.body).items as Array<{ createdAt: string }>;
    for (let index = 1; index < items.length; index += 1) {
      expect(items[index - 1].createdAt >= items[index].createdAt).toBe(true);
    }
  });

  it('filters by state through the projected five-member vocabulary — every state answers its own row', async () => {
    // THE PREDICATE/PROJECTION EQUIVALENCE ON REAL DATA: the filter is built from
    // relation predicates over the transition history, while each row's displayed
    // state is `projectReturnState` — for all five states the two must agree.
    const byState: Record<string, string> = {
      REQUESTED: retRequested.id,
      APPROVED: retApproved.id,
      RECEIVED_BACK: retReceivedBack.id,
      REFUNDED: retRefunded.id,
      REJECTED: retRejected.id,
    };

    for (const [state, returnId] of Object.entries(byState)) {
      const res: SupertestResponse = await api()
        .get(scoped(`&state=${state}&pageSize=100`))
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      const body = envelope(res.body);
      expect({ state, ids: body.items.map((item) => item.id) }).toEqual({
        state,
        ids: [returnId],
      });
      expect(body.items[0].state).toBe(state);
      // The filtered summary reports THIS population honestly: one bucket, rest zero.
      expect(body.summary.byState[state]).toBe(1);
      expect(body.summary.total).toBe(1);
    }
  });

  it('keeps the summary and the list on ONE predicate — the five counts partition the population', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.summary.total).toBe(body.total);
    const sum = ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED'].reduce(
      (accumulator, state) => accumulator + body.summary.byState[state],
      0
    );
    // The closed five-member set PARTITIONS the population exactly — no hidden
    // bucket, no double count: one of each state in this run's fixture.
    expect(sum).toBe(body.total);
    expect(body.summary.byState).toEqual({
      REQUESTED: 1,
      APPROVED: 1,
      RECEIVED_BACK: 1,
      REFUNDED: 1,
      REJECTED: 1,
    });
  });

  it('windows on createdAt as HALF-OPEN [from, to) — inclusive start, exclusive edge, same-day', async () => {
    const first = new Date(retRefunded.createdAt).getTime();

    // The whole run: every return sits inside `[first - 1d, first + 1d)`.
    const whole: SupertestResponse = await api()
      .get(
        scoped(
          `&createdFrom=${new Date(first - 86_400_000).toISOString()}&createdTo=${new Date(
            first + 86_400_000
          ).toISOString()}&pageSize=100`
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(whole.body).items).toHaveLength(5);

    // The EXCLUSIVE end: an upper bound exactly at the FIRST row's instant excludes
    // that row and everything after it — an empty window, not an error.
    const edge: SupertestResponse = await api()
      .get(
        scoped(
          `&createdFrom=${new Date(first - 3_600_000).toISOString()}&createdTo=${retRefunded.createdAt}&pageSize=100`
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(edge.body).items).toEqual([]);

    // Same-day behaviour: the civil UTC day that CONTAINS the first row's instant.
    const dayStartMs = Math.floor(first / 86_400_000) * 86_400_000;
    const sameDay: SupertestResponse = await api()
      .get(
        scoped(
          `&createdFrom=${new Date(dayStartMs).toISOString()}&createdTo=${new Date(
            dayStartMs + 86_400_000
          ).toISOString()}&pageSize=100`
        )
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(sameDay.body).items.map((item) => item.id)).toEqual(
      expect.arrayContaining([retRefunded.id])
    );
  });

  it('refuses an inverted window with a 400 and a malformed instant with a 422', async () => {
    const inverted: SupertestResponse = await api()
      .get(scoped('&createdFrom=2026-03-16T00:00:00.000Z&createdTo=2026-03-15T00:00:00.000Z'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(inverted.status).toBe(400);

    const malformed: SupertestResponse = await api()
      .get(scoped('&createdFrom=not-a-date'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(malformed.status).toBe(422);
  });

  it('refuses an unknown state and an oversized page — never filters the database silently empties', async () => {
    const unknown: SupertestResponse = await api()
      .get(scoped('&state=DRAFT'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(unknown.status).toBe(422);

    const oversized: SupertestResponse = await api()
      .get(scoped('&pageSize=1000'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(oversized.status).toBe(422);
  });

  it('filters by search against the return reason AND the parent document number', async () => {
    // The run-scoped reason lives on ONE return's own row.
    const byReason: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(RUN_ID)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(byReason.body).items.map((item) => item.id)).toEqual([retRefunded.id]);
    expect(envelope(byReason.body).items[0].reason).toContain(RUN_ID);

    // A different reason phrase — the same OR branch, another row. SCOPED to this
    // run's document: previous runs left identical phrases behind under their own
    // documents, and an unscoped contains-match would honestly return those too.
    const byPhrase: SupertestResponse = await api()
      .get(scoped(`&search=${encodeURIComponent('آسیب دیده در حمل')}&pageSize=100`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(byPhrase.body).items.map((item) => item.id)).toEqual([retReceivedBack.id]);

    // The parent document's number — the same-owner join a tenant-wide register needs.
    const byNumber: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(docANumber)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = envelope(byNumber.body);
    expect(body.items.map((item) => item.id).sort()).toEqual(
      [retRefunded.id, retReceivedBack.id, retApproved.id, retRequested.id, retRejected.id].sort()
    );
    for (const item of body.items) expect(item.purchaseDocumentNumber).toBe(docANumber);
  });

  it('answers an impossible filter with an empty page — zero-filled, not an error', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?purchaseDocumentId=${randomUUID()}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.summary.total).toBe(0);
    for (const state of ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED']) {
      expect(body.summary.byState[state]).toBe(0);
    }
  });

  it('paginates through the COMMERCE window', async () => {
    const page1: SupertestResponse = await api()
      .get(scoped('&pageSize=2&page=1'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body1 = envelope(page1.body);
    expect(body1.items).toHaveLength(2);
    expect(body1.total).toBe(5);
    expect(body1.page).toBe(1);

    const page3: SupertestResponse = await api()
      .get(scoped('&pageSize=2&page=3'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(page3.body).items).toHaveLength(1);
  });

  it('denies a user without commerce.read — no report, no detail, no export, no timeline', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${retRefunded.id}`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(detail.status).toBe(403);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${retRefunded.id}/timeline`))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(timeline.status).toBe(403);

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

    const timelineAnonymous: SupertestResponse = await api().get(
      reportUrl(`/${retRefunded.id}/timeline`)
    );
    expect(timelineAnonymous.status).toBe(401);
  });

  it('never leaks tenant B rows into tenant A — register, detail and timeline', async () => {
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const ids = envelope(list.body).items.map((item) => item.id);
    expect(ids).not.toContain(tenantBReturnId);

    // A foreign id behaves EXACTLY like a missing one: 404, not 403.
    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBReturnId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBReturnId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(timeline.status).toBe(404);
  });

  it('returns the projection whitelist for a detail — the row eight + lines, no internals', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${retRefunded.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const row = envelope(res.body);

    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'state',
        'reason',
        'replacementRequired',
        'lineCount',
        'createdAt',
        'lines',
      ].sort()
    );
    // Sensitive/internal fields never cross: the tenant, the raw requester, the raw
    // transition actors, and a mutable status column that does not exist at all.
    for (const forbidden of [
      'tenantId',
      'requestedByUserId',
      'status',
      'updatedAt',
      'transitions',
      'state' + 'Column',
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    expect(row.purchaseDocumentNumber).toBe(docANumber);
    expect(row.state).toBe('REFUNDED');
    expect(row.reason).toContain(RUN_ID);
    expect(row.replacementRequired).toBe(false);
    expect(row.lineCount).toBe(1);

    // The line projection: exact stored quantities as strings, both opaque origins.
    expect(row.lines).toHaveLength(1);
    expect(Object.keys(row.lines[0]).sort()).toEqual(
      ['id', 'purchaseLineId', 'receiptLineId', 'quantity', 'createdAt'].sort()
    );
    expect(Number(row.lines[0].quantity)).toBe(10);
    expect(row.lines[0].purchaseLineId).toBe(lineAId);
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);

    const timeline: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(timeline.status).toBe(404);
  });

  it('reads the audit-backed timeline of THIS return — the four lifecycle acts, nothing else', async () => {
    // The fixture's OWN audit events must land first, or the assertion below could
    // pass vacuously while the relay is still in flight.
    await waitForReturnAuditDelivery();

    const res: SupertestResponse = await api()
      .get(reportUrl(`/${retRefunded.id}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const page = envelope(res.body);

    // resourceId = return document id, so this page holds EXACTLY this return's
    // history — four events for the full forward chain, never a sibling's.
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(4);
    expect(page.items.map((item) => item.action).sort()).toEqual(
      ['approve', 'create', 'receive_back', 'refund'].sort()
    );
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['id', 'action', 'actorId', 'success', 'reason', 'changedFields', 'createdAt'].sort()
      );
      expect(item.success).toBe(true);
    }

    // The REJECTED return's own two events — a different row, a different page.
    const rejected: SupertestResponse = await api()
      .get(reportUrl(`/${retRejected.id}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const rejectedPage = envelope(rejected.body);
    expect(rejectedPage.total).toBe(2);
    expect(rejectedPage.items.map((item) => item.action).sort()).toEqual(
      ['create', 'reject'].sort()
    );
  });

  it('pages the timeline through the COMMERCE window', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${retRefunded.id}/timeline?pageSize=2&page=1`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const page = envelope(res.body);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
    expect(page.pageSize).toBe(2);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${retRefunded.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ state: 'REFUNDED' });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api().delete(reportUrl(`/${retRefunded.id}`));
    expect(del.status).toBe(404);
  });

  it('exports the SAME filtered page as XLSX and DOCX — parsed, not eyeballed', async () => {
    // Scope equality, end to end: the list route and the file routes answer the SAME
    // `purchaseDocumentId` question, and the parsed sheet must describe exactly those
    // rows — five states, five Persian words, no collapsing.
    const list: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items).toHaveLength(5);

    const xlsx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-return-lifecycle-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'شماره سند خرید');
    expect(sheet.header).toEqual([...XLSX_HEADERS]);
    expect(sheet.data).toHaveLength(listed.items.length);
    // Every row is this run's parent document, one line count each.
    for (const row of sheet.data) {
      expect(row[0]).toBe(docANumber);
      // The shared sheet parser answers numeric cells as their exact STRING form
      // (the payment export asserts `-20` the same way) — never a rounded float.
      expect(row[4]).toBe('1');
    }
    // The FIVE state words, exactly once each — the vocabulary the web already shows.
    expect(sheet.data.map((row) => row[1]).sort()).toEqual(
      ['درخواست‌شده', 'تأییدشده', 'کالا برگشت خورد', 'بازپرداخت‌شده', 'ردشده'].sort()
    );
    // The run-scoped reason crosses verbatim; the replacement flag speaks «بله»/«خیر».
    expect(sheet.data.some((row) => String(row[2]).includes(RUN_ID))).toBe(true);
    expect(sheet.data.map((row) => row[3]).sort()).toEqual(
      ['خیر', 'خیر', 'خیر', 'خیر', 'بله'].sort()
    );
    // No scope or actor internals in the sheet text — and no row ids either (the
    // register's own id is deliberately not a column of this document).
    const sheetText = JSON.stringify(sheet.data);
    expect(sheetText).not.toContain(tenantAId);
    expect(sheetText).not.toContain(admin.userId);
    expect(sheetText).not.toContain(retRefunded.id);

    // The SAME list as Word: title, RTL, ONE table, header + five rows, no scope.
    const docx: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-return-lifecycle-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش چرخه حیات مرجوعی‌های بازرگانی');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    expect(xml).not.toContain(tenantAId);
    expect(xml).not.toContain(retRefunded.id);
    expect(xml).not.toContain(admin.userId);
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
    const foreignSheet = parseXlsxSheet(responseBuffer(foreign), 'شماره سند خرید');
    expect(foreignSheet.data.map((row) => row[0])).not.toContain(docANumber);
  });

  it('renders a state-filtered export from the SAME list path — one row, one state', async () => {
    const rejected: SupertestResponse = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?purchaseDocumentId=${docAId}&state=REJECTED&pageSize=100`,
      admin.token
    ).expect(200);
    const sheet = parseXlsxSheet(responseBuffer(rejected), 'شماره سند خرید');
    expect(sheet.data).toHaveLength(1);
    expect(sheet.data[0][1]).toBe('ردشده');
    expect(sheet.data[0][2]).toBe('انصراف خریدار');
  });

  it('reflects a LIVE lifecycle transition — the report is not a snapshot', async () => {
    // Create a SIXTH return (still REQUESTED), then reject it and watch the register
    // and the state filter move with the real Commerce API.
    const sixth = await createReturn(admin.token, docAId, {
      reason: `live transition ${RUN_ID}`,
      replacementRequired: false,
      lines: [{ purchaseLineId: lineAId, receiptLineId: receiptLineAId, quantity: 10 }],
    });
    liveReturnId = sixth.id;

    const beforeRes: SupertestResponse = await api()
      .get(scoped('&state=REQUESTED&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(beforeRes.body).items.map((item) => item.id)).toContain(sixth.id);

    expect(await transition(admin.token, docAId, sixth.id, 'reject', { reason: 'live' })).toBe(
      'REJECTED'
    );

    const afterRes: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const afterBody = envelope(afterRes.body);
    expect(afterBody.total).toBe(6);
    const row = afterBody.items.find((item) => item.id === sixth.id);
    expect(row.state).toBe('REJECTED');
    // The partition moved with the real command: REJECTED gained one, REQUESTED kept
    // its untouched one (the fixture's `retRequested` never moved).
    expect(afterBody.summary.byState.REJECTED).toBe(2);
    expect(afterBody.summary.byState.REQUESTED).toBe(1);

    // Its own audit events (resourceId = THIS return id) land before anything else
    // reads the trail — scoped to the sixth return, not the fixture-wide count.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const liveCount = await getCoreDb().auditLog.count({
        where: {
          resourceType: 'commerce.return_document',
          resourceId: sixth.id,
        },
      });
      if (liveCount >= 2) break;
      if (Date.now() > deadline) {
        throw new Error('[E2E] live-transition audit events were not delivered in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }, 120_000);

  it('NO-WRITE PROOF: every report surface leaves source rows and audit trail unchanged', async () => {
    // The fixture's OWN audit events (and the live test's) must have landed first,
    // or the equality below could pass vacuously while the relay is still in flight.
    await waitForReturnAuditDelivery();
    const before = await snapshotSource();
    // Non-vacuity: SEVEN return documents (five fixture states + tenant B's probe +
    // the live transition's sixth on doc A), seven lines, fifteen transitions, and
    // their thirteen-plus audit events all exist BEFORE any report surface runs.
    expect(before.serializedDocuments).toHaveLength(7);
    expect(before.serializedLines).toHaveLength(7);
    expect(before.serializedTransitions).toHaveLength(15);
    expect(before.auditCount).toBeGreaterThanOrEqual(13);

    // Exercise EVERY authorized read surface: unfiltered list, scoped list, every
    // state filter, search, window, summary (bundled), detail, timeline, both exports.
    await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    for (const state of ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED']) {
      await api()
        .get(scoped(`&state=${state}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
    }
    await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(RUN_ID)}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&createdFrom=2020-01-01T00:00:00.000Z&createdTo=2030-01-01T00:00:00.000Z'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${retRefunded.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${retRefunded.id}/timeline`))
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
    // Documents, lines, transitions — every column, byte-identical.
    expect(after.serializedDocuments).toEqual(before.serializedDocuments);
    expect(after.serializedLines).toEqual(before.serializedLines);
    expect(after.serializedTransitions).toEqual(before.serializedTransitions);
    // And NOT ONE audit event was generated by reading.
    expect(after.auditCount).toBe(before.auditCount);
  }, 120_000);
});
