/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS — the commerce receiving status
 * report against the real combined runtime:
 *
 *   authenticated user
 *        ↓
 *   Reporting routes (`/api/v1/reporting/commerce/receiving…`)
 *        ↓
 *   approved FOURTH Commerce read seam → real `commerce_db` purchase lines +
 *   their append-only `Receipt` / `ReceiptLine` events
 *        ↓
 *   tenant-scoped list → detail → exports → NO-WRITE STATE PROOF
 *
 * Covered: the happy path with an EXACT row grain (ONE row per purchase line —
 * scope gate A, never per receipt event, never per document), the three
 * projected statuses INCLUDING an event-less line (which the register must
 * answer NOT_RECEIVED — the Commerce screen's own rule), every supported source
 * filter (`status` over the closed three, `search` against ONLY the parent
 * document number, `purchaseDocumentId`, `purchaseLineId`, the HALF-OPEN
 * `[receivedFrom, receivedTo)` window on the LATEST receiving instant incl. a
 * same-day case and the event-less exclusion), an inverted window and an unknown
 * status as refusals, empty results, the projection whitelist, detail,
 * foreign/unknown id → 404, 401/403, cross-tenant list/detail/export in both
 * directions, NO timeline route, NO write route, an explicit no-write STATE
 * PROOF over both the source rows and the platform audit trail, and the
 * XLSX/DOCX exports parsed back to their rows — same population as the list,
 * tenant-safe in both directions.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma
 * client; the business data itself — purchase documents, receipts, the
 * compensating line — is driven through the Commerce HTTP API (the real write
 * paths); the report is read exclusively through the Reporting HTTP API — the
 * slice under test. Population assertions scope by `purchaseDocumentId` so a
 * previous run's leftovers can never enter this run (the isolation reasoning
 * every sibling report achieves with its own run-scoped code).
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
import { InventoryPrismaService } from '../src/modules/inventory/database/inventory-prisma.service';
import { ensureCommerceProcurementTestProvisioning } from './fixtures/commerce-provisioning';

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
const RUN_ID = `recvrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
  tenantBAdmin: `B-${RUN_ID}`,
  noRead: `NoRead-${RUN_ID}`,
} as const;

/** The receiving dates this run states — the line's LATEST instant, exactly as written. */
const RECEIVED_DATES = {
  partialLine: '2026-01-05T10:00:00.000Z',
  fullLine: '2026-03-15T10:00:00.000Z',
  compensation: '2026-03-16T10:00:00.000Z',
  tenantB: '2026-02-01T10:00:00.000Z',
} as const;

const XLSX_HEADERS = [
  'شماره سند',
  'وضعیت دریافت',
  'مقدار سفارش',
  'مقدار دریافتی',
  'آخرین تاریخ دریافت',
  'رویدادهای جبرانی',
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

function getInventoryDb(): InventoryPrismaService {
  return getApp().get(InventoryPrismaService);
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
 * A SECOND tenant entitled to `commerce` — the isolation half of the slice,
 * mirroring what a real tenant provisioning leaves behind (module registration
 * link, `commerce/purchase` feature grant, an ADMIN role inside ITS tenant only).
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

/**
 * One THREE-LINE document through the COMMERCE API (the writer side) — three rows
 * this register must answer separately (partial, full, untouched). Lines are
 * asserted by `itemReference` because line ids are server-minted.
 */
async function createDocument(
  token: string,
  requesterId: string,
  lineCount: number
): Promise<{ id: string; documentNumber: string; lines: { id: string; quantity: string }[] }> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      requesterId,
      supplierId: 'SUP-E2E-RECV',
      currency: 'IRR',
      lines: Array.from({ length: lineCount }, (_, index) => ({
        lineType: 'STANDARD',
        quantity: 100,
        unit: 'PCS',
        unitPrice: 100,
        tax: 10,
        itemReference: `RECV-${RUN_ID}-L${index}`,
      })),
    })
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  return {
    id: body.id,
    documentNumber: body.documentNumber,
    lines: (body.lines ?? []).map((line: { id: string; quantity: unknown }) => ({
      id: line.id,
      quantity: String(line.quantity),
    })),
  };
}

/** One receiving event through the COMMERCE API (the real append path, `commerce.manage`). */
async function appendReceipt(
  token: string,
  documentId: string,
  payload: Record<string, unknown>
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/commerce/purchase-documents/${documentId}/receipts`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

/** The compensating row through the COMMERCE API — the ONLY correction mechanism. */
async function compensateReceiptLine(
  token: string,
  documentId: string,
  receiptLineId: string,
  payload: Record<string, unknown>
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(
      `${API_PREFIX}/commerce/purchase-documents/${documentId}/receipts/${receiptLineId}/compensate`
    )
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  const body = envelope(res.body) ?? res.body;
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

describe('Reporting — Commerce Receiving Status Report (tenth vertical slice)', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantBAdmin: Actor;
  let tenantAId: string;
  let docAId: string;
  let docANumber: string;
  let partialLineId: string;
  let fullLineId: string;
  let untouchedLineId: string;
  let tenantBDocId: string;
  let tenantBLineId: string;
  let warehouseAId: string;
  let warehouseBId: string;

  const reportUrl = (suffix = '') => `${API_PREFIX}/reporting/commerce/receiving${suffix}`;
  /** The run's own population — every list assertion scopes through this one filter. */
  const scoped = (extra = '') =>
    `${reportUrl()}?purchaseDocumentId=${docAId}${extra ? `&${extra}` : ''}`;

  beforeAll(async () => {
    await waitForReadiness();

    const coreDb = getCoreDb();
    const tenantA = await coreDb.tenant.findUnique({ where: { id: 'tenant-test-1' } });
    if (!tenantA) throw new Error('[E2E] Seeded tenant tenant-test-1 not found');
    tenantAId = tenantA.id;

    // Test-only provisioning, and it MUST run BEFORE any login: login resolves the
    // caller's permission claim through the PermissionSource port (which caches its
    // answer), so a grant written after the first token is minted leaves every later
    // request carrying a permission-empty identity. The grant/enrolment migrations
    // cannot supply these rows themselves — they only see what existed at migration
    // time, while the roles and `tenant-test-1` are created afterwards by `db:seed`.
    // Shapes mirrored, nothing else touched: fixtures/commerce-provisioning.ts.
    await ensureCommerceProcurementTestProvisioning(coreDb, [tenantAId]);

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
    // THREE-LINE document — line 0 receives 40 of 100 (PARTIAL), line 1 receives
    // its full 100 then suffers a 20 compensation (+80 net — still PARTIAL, and
    // the compensation is where the register's count comes from), and line 2
    // receives nothing at all (the NOT_RECEIVED row this register must not drop).
    const docA = await createDocument(admin.token, admin.userId, 3);
    docAId = docA.id;
    docANumber = docA.documentNumber;
    if (docA.lines.length !== 3) throw new Error('[E2E] expected three purchase lines');
    [partialLineId, fullLineId, untouchedLineId] = docA.lines.map((line) => line.id);
    expect(new Set([partialLineId, fullLineId, untouchedLineId]).size).toBe(3);

    // Phase W2-B contract: a receipt line on a STOCKED purchase line must name
    // the destination warehouse — the posting the receipt plans into
    // `InventoryPosting` resolves the line's `itemReference` against tenant A's
    // real inventory items, so the run seeds a real warehouse + item per SKU
    // (tenant-scoped, deleted in afterAll) instead of faking stock effects.
    const inventoryDb = getInventoryDb();
    warehouseAId = (
      await inventoryDb.warehouse.create({
        data: {
          tenantId: tenantAId,
          code: `WH-A-${RUN_ID}`.slice(0, 32),
          name: `e2e warehouse A ${RUN_ID}`,
          createdByUserId: admin.userId,
        },
      })
    ).id;
    warehouseBId = (
      await inventoryDb.warehouse.create({
        data: {
          tenantId: tenantBAdmin.tenantId,
          code: `WH-B-${RUN_ID}`.slice(0, 32),
          name: `e2e warehouse B ${RUN_ID}`,
          createdByUserId: tenantBAdmin.userId,
        },
      })
    ).id;
    for (const [tenantId, sku, actorId] of [
      ...Array.from({ length: 3 }, (_, i) => [tenantAId, `RECV-${RUN_ID}-L${i}`, admin.userId] as const),
      [tenantBAdmin.tenantId, `RECV-${RUN_ID}-L0`, tenantBAdmin.userId] as const,
    ]) {
      await inventoryDb.inventoryItem.create({
        data: {
          tenantId,
          sku,
          name: `e2e item ${sku}`,
          itemType: 'STOCKED',
          baseUnit: 'PCS',
          createdByUserId: actorId,
        },
      });
    }

    await appendReceipt(admin.token, docAId, {
      receivedAt: RECEIVED_DATES.partialLine,
      lines: [{ purchaseLineId: partialLineId, quantity: 40, warehouseId: warehouseAId }],
    });

    const fullReceipt = await appendReceipt(admin.token, docAId, {
      receivedAt: RECEIVED_DATES.fullLine,
      lines: [{ purchaseLineId: fullLineId, quantity: 100, warehouseId: warehouseAId }],
    });
    void fullReceipt;
    // The append response only carries the RECEIPT id (`receiptView`); the
    // receipt-LINE ids needed for the compensate path arrive with the read
    // route's own lines — read them from the owning surface, never from a guess.
    const receiptBody = envelope(
      (
        await api()
          .get(`${API_PREFIX}/commerce/purchase-documents/${docAId}/receipts`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(200)
      ).body
    );
    const fullReceiptLine = (
      receiptBody.receipts as Array<{
        lines: Array<{
          id: string;
          purchaseLineId: string;
          reversesReceiptLineId: string | null;
        }>;
      }>
    )
      .flatMap((receipt) => receipt.lines)
      .find(
        (line) =>
          line.purchaseLineId === fullLineId && line.reversesReceiptLineId === null
      );
    if (!fullReceiptLine) {
      throw new Error('[E2E] expected the appended full receipt line in the read route');
    }
    const fullReceiptLineId = fullReceiptLine.id;


    await compensateReceiptLine(admin.token, docAId, fullReceiptLineId, {
      quantity: 20,
      receivedAt: RECEIVED_DATES.compensation,
      reason: `run-scoped compensation ${RUN_ID}`,
    });

    // Tenant B's own line — the cross-tenant probe.
    const docB = await createDocument(tenantBAdmin.token, tenantBAdmin.userId, 1);
    tenantBDocId = docB.id;
    tenantBLineId = docB.lines[0].id;
    await appendReceipt(tenantBAdmin.token, tenantBDocId, {
      receivedAt: RECEIVED_DATES.tenantB,
      lines: [{ purchaseLineId: tenantBLineId, quantity: 10, warehouseId: warehouseBId }],
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
      const inventoryDb = getInventoryDb();
      await inventoryDb.inventoryItem.deleteMany({
        where: { sku: { startsWith: `RECV-${RUN_ID}` } },
      });
      await inventoryDb.warehouse.deleteMany({
        where: { code: { in: [`WH-A-${RUN_ID}`.slice(0, 32), `WH-B-${RUN_ID}`.slice(0, 32)] } },
      });
    } catch {
      // best-effort
    }
  }, 60_000);

  /**
   * The SOURCE snapshot for the no-write proof: this run's purchase lines (the
   * row grain) and its receipt lines (the projection inputs), plus the platform
   * audit events whose `resourceType` is the receipt resource — receiving acts
   * audit `resourceId = receipt id` (`receiving-history.service.ts`). A reporting
   * read can change NONE of them; the assertions re-read all three after every
   * report surface has been exercised.
   */
  async function snapshotSource() {
    const commerceDb = getCommerceDb();
    const lines = await commerceDb.purchaseLine.findMany({
      where: { purchaseDocumentId: { in: [docAId, tenantBDocId] } },
      orderBy: { id: 'asc' },
    });
    const events = await commerceDb.receiptLine.findMany({
      where: { purchaseLineId: { in: lines.map((line) => line.id) } },
      orderBy: { id: 'asc' },
    });
    const serialized = {
      lines: lines.map((line) => ({
        id: line.id,
        tenantId: line.tenantId,
        purchaseDocumentId: line.purchaseDocumentId,
        quantity: String(line.quantity),
      })),
      events: events.map((event) => ({
        id: event.id,
        tenantId: event.tenantId,
        receiptId: event.receiptId,
        purchaseLineId: event.purchaseLineId,
        quantity: String(event.quantity),
        reversesReceiptLineId: event.reversesReceiptLineId,
      })),
    };
    const auditCount = await getCoreDb().auditLog.count({
      where: {
        resourceType: 'commerce.receipt',
        resourceId: {
          in: (await commerceDb.receipt.findMany({
            where: { purchaseDocumentId: { in: [docAId, tenantBDocId] } },
            select: { id: true },
          })).map((receipt) => receipt.id),
        },
      },
    });
    return { serialized, auditCount };
  }

  it('answers the contract shape — list, summary keys, and the closed three-state set', async () => {
    const res: SupertestResponse = await api()
      .get(`${reportUrl()}?pageSize=5`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.total).toBe('number');
    // The summary counts every state of the CLOSED three-member set — no holes.
    for (const status of ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']) {
      expect(body.summary.byStatus).toHaveProperty(status);
    }
  });

  it('keeps the row grain EXACTLY one row per purchase line — events included, nothing collapsed', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    // Three purchase lines, three rows: the +40 arrival, the netted +80 line and
    // the untouched one. The report must NOT collapse them into one document row
    // and must NOT render the five receipt events as five rows.
    expect(body.total).toBe(3);
    const ids = body.items.map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(
      expect.arrayContaining([partialLineId, fullLineId, untouchedLineId])
    );

    const byId = new Map<string, Record<string, unknown>>((body.items as Record<string, unknown> & { id: string }[]).map((item) => [item.id, item] as const));
    const partial = byId.get(partialLineId)!;
    if (!partial) throw new Error('partial line missing from register');
    expect(partial.receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(partial.receivedQuantity).toBe('40.0000');
    expect(partial.compensationCount).toBe(0);
    expect(partial.receivedAt).toBe(RECEIVED_DATES.partialLine);

    // 100 − 20 compensation = 80: still PARTIAL, and the compensation is where
    // the register's compensation count comes from.
    const full = byId.get(fullLineId)!;
    if (!full) throw new Error('full line missing from register');
    expect(full.receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(full.receivedQuantity).toBe('80.0000');
    expect(full.compensationCount).toBe(1);
    expect(full.receivedAt).toBe(RECEIVED_DATES.compensation);

    // No events at all: NOT_RECEIVED (the Commerce screen's own rule), NULL
    // instant — the row the register must not drop.
    const untouched = byId.get(untouchedLineId)!;
    if (!untouched) throw new Error('untouched line missing from register');
    expect(untouched.receivingStatus).toBe('NOT_RECEIVED');
    expect(untouched.receivedQuantity).toBe('0.0000');
    expect(untouched.compensationCount).toBe(0);
    expect(untouched.receivedAt).toBeNull();

    // Register order: latest receiving instant DESC, the event-less line LAST.
    expect(ids[0]).toBe(fullLineId);
    expect(ids[1]).toBe(partialLineId);
    expect(ids[2]).toBe(untouchedLineId);

    for (const row of body.items) expect(row.purchaseDocumentNumber).toBe(docANumber);
  });

  it('filters by status through the source vocabulary — every result matches', async () => {
    const partial: SupertestResponse = await api()
      .get(scoped('&status=PARTIALLY_RECEIVED&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const notReceived: SupertestResponse = await api()
      .get(scoped('&status=NOT_RECEIVED&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const partialBody = envelope(partial.body);
    const notReceivedBody = envelope(notReceived.body);
    // Two lines carry arrivals (40 and netted 80), one line carries none.
    expect(partialBody.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [partialLineId, fullLineId].sort()
    );
    expect(notReceivedBody.items.map((item: { id: string }) => item.id)).toEqual([untouchedLineId]);
    for (const item of partialBody.items) expect(item.receivingStatus).toBe('PARTIALLY_RECEIVED');
    for (const item of notReceivedBody.items) expect(item.receivingStatus).toBe('NOT_RECEIVED');
    // The status filter is the summary's own dimension: PARTIAL rows = PARTIAL count.
    expect(partialBody.summary.byStatus.PARTIALLY_RECEIVED).toBe(2);
    expect(partialBody.summary.total).toBe(2);
  });

  it('refuses an unknown status — never a filter the pipeline silently empties', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&status=RECEIVED'))
      .set('Authorization', `Bearer ${admin.token}`);
    // 422: the production ValidationPipe maps `@IsIn` membership refusal to
    // `UnprocessableEntityException` — what matters is the REFUSAL itself.
    expect(res.status).toBe(422);
  });

  it('windows on the latest receiving instant as a HALF-OPEN [from, to) — NULL excluded', async () => {
    // The +40 line's own day: contains its 10:00 instant, neither neighbour case.
    const window: SupertestResponse = await api()
      .get(scoped('&receivedFrom=2026-01-05T00:00:00.000Z&receivedTo=2026-01-06T00:00:00.000Z&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(window.body).items.map((item: { id: string }) => item.id)).toEqual([partialLineId]);

    // The compensating write's instant is the line's latest: day 2026-03-16
    // alone answers the netted line, and the untouched line is EXCLUDED because
    // a NULL instant matches no bound.
    const netted: SupertestResponse = await api()
      .get(scoped('&receivedFrom=2026-03-16T00:00:00.000Z&receivedTo=2026-03-17T00:00:00.000Z&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(netted.body).items.map((item: { id: string }) => item.id)).toEqual([fullLineId]);

    // The EXCLUSIVE end: an instant exactly at `receivedTo` is OUT of the window.
    const edge: SupertestResponse = await api()
      .get(
        scoped('&receivedFrom=2026-01-05T00:00:00.000Z&receivedTo=2026-01-05T10:00:00.000Z&pageSize=100')
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(envelope(edge.body).items).toEqual([]);
  });

  it('refuses an inverted window with a 400 and a malformed instant with a 422', async () => {
    const inverted: SupertestResponse = await api()
      .get(scoped('&receivedFrom=2026-03-16T00:00:00.000Z&receivedTo=2026-03-15T00:00:00.000Z'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(inverted.status).toBe(400);

    const malformed: SupertestResponse = await api()
      .get(scoped('&receivedFrom=not-a-date'))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(malformed.status).toBe(422);
  });

  it('filters by search against ONLY the parent document number — receipt rows carry no text', async () => {
    // The parent document's number — the same-owner join a tenant-wide register needs.
    const byNumber: SupertestResponse = await api()
      .get(`${reportUrl()}?search=${encodeURIComponent(docANumber)}&pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = envelope(byNumber.body);
    const ids = body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([partialLineId, fullLineId, untouchedLineId]));
    for (const item of body.items) expect(item.purchaseDocumentNumber).toBe(docANumber);
  });

  it('scopes by purchaseLineId — exact line lookup, grain of one', async () => {
    const res: SupertestResponse = await api()
      .get(scoped(`&purchaseLineId=${partialLineId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = envelope(res.body);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([partialLineId]);
    expect(body.total).toBe(1);
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
    for (const status of ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']) {
      expect(body.summary.byStatus[status]).toBe(0);
    }
  });

  it('keeps the summary and the list on the SAME population — one pipeline, two reads', async () => {
    const res: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const body = envelope(res.body);
    expect(body.summary.total).toBe(body.total);
    const sum = ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].reduce(
      (accumulator, status) => accumulator + body.summary.byStatus[status],
      0
    );
    // The closed three-member set PARTITIONS the population: the counts add up to
    // the total exactly — no hidden bucket, no double count.
    expect(sum).toBe(body.total);
    expect(body.summary.byStatus.PARTIALLY_RECEIVED).toBe(2);
    expect(body.summary.byStatus.NOT_RECEIVED).toBe(1);
    expect(body.summary.byStatus.FULLY_RECEIVED).toBe(0);
  });

  it('never leaks tenant B rows into tenant A — register and detail', async () => {
    const list: SupertestResponse = await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const ids = envelope(list.body).items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(tenantBLineId);

    // A foreign id behaves EXACTLY like a missing one: 404, not 403.
    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${tenantBLineId}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(404);
  });

  it('returns the projection whitelist for a detail — eight fields, no internals', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${partialLineId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const row = envelope(res.body);

    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'orderedQuantity',
        'receivedQuantity',
        'receivingStatus',
        'receivedAt',
        'compensationCount',
      ].sort()
    );
    // Sensitive/internal fields never cross: the tenant, the raw actor, the
    // insert clock, and a document-level status that does not exist at all.
    for (const forbidden of [
      'tenantId',
      'receiverId',
      'createdAt',
      'status',
      'documentStatus',
      'updatedAt',
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    expect(row.purchaseDocumentNumber).toBe(docANumber);
    expect(row.receivedQuantity).toBe('40.0000');
    expect(row.receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(row.receivedAt).toBe(RECEIVED_DATES.partialLine);
    expect(row.compensationCount).toBe(0);
  });

  it('maps an unknown id to 404 — indistinguishable from a foreign one', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${randomUUID()}`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('offers NO timeline route — the receipt-event audit trail is not line history', async () => {
    const res: SupertestResponse = await api()
      .get(reportUrl(`/${partialLineId}/timeline`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('denies a user without commerce.read — no report, no detail, no export', async () => {
    const list: SupertestResponse = await api()
      .get(reportUrl())
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(list.status).toBe(403);

    const detail: SupertestResponse = await api()
      .get(reportUrl(`/${partialLineId}`))
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
    // Scope equality, end to end: the list route and the file routes answer the
    // SAME `purchaseDocumentId` question, and the parsed sheet must describe
    // exactly those rows — the netted quantities included, never collapsed.
    const list: SupertestResponse = await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listed = envelope(list.body);
    expect(listed.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [partialLineId, fullLineId, untouchedLineId].sort()
    );

    const xlsx = await getExportFile(
      api(),
      `${reportUrl()}/export/xlsx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(xlsx.headers['content-type']).toContain(EXPORT_XLSX_MIME);
    expect(xlsx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-receiving-status-report-\d{4}-\d{2}-\d{2}\.xlsx"$/
    );

    const sheet = parseXlsxSheet(responseBuffer(xlsx), 'شماره سند');
    expect(sheet.header).toEqual([...XLSX_HEADERS]);
    expect(sheet.data).toHaveLength(listed.items.length);
    expect(sheet.data.map((row) => row[0])).toEqual(
      [docANumber, docANumber, docANumber].sort()
    );
    // The exact same netted row the list shows: document, status word, ordered,
    // NET received — the export cannot soften the row grain.
    const nettedRow = sheet.data.find((row) => Number(row[3]) === 80);
    expect(nettedRow).toBeDefined();
    expect(nettedRow?.[1]).toBe('دریافت جزئی');
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
    const foreign = await getExportFile(
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

    const docx = await getExportFile(
      api(),
      `${reportUrl()}/export/docx?purchaseDocumentId=${docAId}&pageSize=100`,
      admin.token
    ).expect(200);
    expect(docx.headers['content-type']).toContain(EXPORT_DOCX_MIME);
    expect(docx.headers['content-disposition']).toMatch(
      /^attachment; filename="commerce-receiving-status-report-\d{4}-\d{2}-\d{2}\.docx"$/
    );

    const xml = readZipEntry(responseBuffer(docx), 'word/document.xml');
    expect(xml).toContain('گزارش وضعیت دریافت‌های بازرگانی');
    expect(xml).toContain('<w:bidi/>');
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + listed.items.length);
    // The document leaks no scope: no tenant id, no purchase line id — the
    // filter echo carries the DOCUMENT id the caller itself supplied, never the
    // row's.
    expect(xml).not.toContain(tenantAId);
    expect(xml).not.toContain(partialLineId);
    expect(xml).not.toContain(admin.userId);
  });

  it('exposes NO write path — the report surface is read-only', async () => {
    const post: SupertestResponse = await api()
      .post(reportUrl())
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(post.status).toBe(404);

    const patch: SupertestResponse = await api()
      .patch(reportUrl(`/${partialLineId}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ quantity: 999 });
    expect(patch.status).toBe(404);

    const del: SupertestResponse = await api().delete(reportUrl(`/${partialLineId}`));
    expect(del.status).toBe(404);
  });

  it('NO-WRITE PROOF: every report surface leaves source rows and audit trail unchanged', async () => {
    const before = await snapshotSource();
    // Non-vacuity: this run's lines and events — three lines plus tenant B's
    // one; two receipt events plus one compensation on docA, one on docB.
    expect(before.serialized.lines).toHaveLength(4);
    expect(before.serialized.events).toHaveLength(4);
    expect(before.auditCount).toBeGreaterThanOrEqual(4);

    // Exercise EVERY authorized read surface: unfiltered list, scoped list,
    // filtered lists, detail, both exports.
    await api()
      .get(`${reportUrl()}?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&pageSize=100'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(scoped('&status=PARTIALLY_RECEIVED'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await api()
      .get(reportUrl(`/${partialLineId}`))
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
    // Line quantities and event rows — byte-identical.
    expect(after.serialized).toEqual(before.serialized);
    // And NOT ONE audit event was generated by reading: a write would have
    // arrived as a `commerce.receipt` row (or a write of any other resource).
    expect(after.auditCount).toBe(before.auditCount);
  }, 120_000);
});







