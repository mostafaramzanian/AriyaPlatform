/**
 * PHASE W2-C e2e — the routes added by the aging / cost / reconciliation / posting-queue
 * workstream, exercised on the REAL booted application against the REAL databases.
 *
 *   GET  /api/v1/reporting/commerce/purchase-documents/aging   commerce.read
 *   GET  /api/v1/reporting/commerce/purchase-documents/cost    commerce.read
 *   GET  /api/v1/commerce/suppliers/reconciliation             commerce.read
 *   GET  /api/v1/commerce/inventory-postings                   commerce.read
 *   POST /api/v1/commerce/inventory-postings/:id/retry         commerce.manage
 *
 * Source rows are written through the Commerce HTTP API; a real Warehouse +
 * stocked InventoryItem are seeded in inventory_db so the receipt's posting
 * actually POSTs — no inventory effect is faked.
 */
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { makeRequest, getTestApp } from './setup';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { InventoryPrismaService } from '../src/modules/inventory/database/inventory-prisma.service';
import { ensureCommerceProcurementTestProvisioning } from './fixtures/commerce-provisioning';

const API_PREFIX = '/api/v1';
const RUN_ID = `agco-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORDS = { seededAdmin: 'ChangeMe123!', noRead: `NoRead-${RUN_ID}` };

type SupertestResponse = import('supertest').Response;

interface Actor {
  email: string;
  password: string;
  token: string;
  userId: string;
  tenantId: string;
}

function api() {
  return makeRequest();
}
function getApp() {
  return getTestApp();
}
function getCoreDb(): CorePrismaService {
  return getApp().get(CorePrismaService);
}
function getInventoryDb(): InventoryPrismaService {
  return getApp().get(InventoryPrismaService);
}

async function login(email: string, password: string): Promise<string> {
  const res = await api()
    .post(`${API_PREFIX}/auth/login`)
    .send({ email, password })
    .expect(200);
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
      const res = await api().get(`${API_PREFIX}/ready`);
      if (res.status === 200) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[E2E] Service did not become ready within ${timeoutMs}ms: ${lastError}`);
}

async function createUser(label: string, tenantId: string): Promise<Actor> {
  const email = `${label}-${RUN_ID}@aria.test`;
  const password = PASSWORDS[label as keyof typeof PASSWORDS] ?? `Pwd-${RUN_ID}`;
  const userId = `user-${label}-${RUN_ID}`;
  await getCoreDb().user.create({
    data: {
      id: userId,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      firstName: label,
      lastName: 'e2e',
      status: 'EMPLOYEE',
      tenant: { connect: { id: tenantId } },
    },
  });
  return { email, password, token: '', userId, tenantId };
}

describe('W2-C routes — aging, cost-by-center, supplier reconciliation, posting queue', () => {
  let admin: Actor;
  let noRead: Actor;
  let tenantAId: string;
  let docId: string;
  let purchaseLineId: string;
  let postingId: string;

  const COST_CENTER = `CC-${RUN_ID}`.slice(0, 128);
  const SUPPLIER_REF = `SUP-AG-${RUN_ID}`;

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
      email: seededAdminRow.email,
      password: PASSWORDS.seededAdmin,
      userId: seededAdminRow.id,
      tenantId: seededAdminRow.tenantId || tenantAId,
      token: await login(seededAdminRow.email, PASSWORDS.seededAdmin),
    };
    noRead = await createUser('noRead', tenantAId);
    noRead.token = await login(noRead.email, noRead.password);

    // A stocked document: real warehouse + item so the receipt's posting POSTs.
    const sku = `AG-${RUN_ID}-L0`.slice(0, 64);
    const inventoryDb = getInventoryDb();
    const warehouse = await inventoryDb.warehouse.create({
      data: {
        tenantId: tenantAId,
        code: `WH-AG-${RUN_ID}`.slice(0, 32),
        name: `e2e aging/cost warehouse ${RUN_ID}`,
        createdByUserId: admin.userId,
      },
    });
    await inventoryDb.inventoryItem.create({
      data: {
        tenantId: tenantAId,
        sku,
        name: `e2e item ${sku}`,
        itemType: 'STOCKED',
        baseUnit: 'PCS',
        createdByUserId: admin.userId,
      },
    });

    const docRes: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/purchase-documents`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        requesterId: admin.userId,
        supplierId: SUPPLIER_REF,
        currency: 'IRR',
        costCenter: COST_CENTER,
        lines: [
          {
            lineType: 'STANDARD',
            quantity: 10,
            unit: 'PCS',
            unitPrice: 500,
            tax: 0,
            itemReference: sku,
          },
        ],
      })
      .expect(201);
    docId = docRes.body.id;
    expect(typeof docRes.body.documentNumber).toBe('string');
    purchaseLineId = docRes.body.lines[0].id;

    await api()
      .post(`${API_PREFIX}/commerce/purchase-documents/${docId}/receipts`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ lines: [{ purchaseLineId, quantity: 4, warehouseId: warehouse.id }] })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    const coreDb = getCoreDb();
    try {
      await coreDb.user.deleteMany({ where: { id: noRead.userId } });
      const inventoryDb = getInventoryDb();
      await inventoryDb.inventoryItem.deleteMany({ where: { sku: `AG-${RUN_ID}-L0`.slice(0, 64) } });
      await inventoryDb.warehouse.deleteMany({ where: { code: `WH-AG-${RUN_ID}`.slice(0, 32) } });
    } catch {
      // best-effort
    }
  }, 60_000);

  it('aging: answers the run document inside DAYS_0_7 with one generatedAt', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/reporting/commerce/purchase-documents/aging?pageSize=100`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(typeof res.body.generatedAt).toBe('string');
    expect(res.body.byBucket).toMatchObject({
      DAYS_0_7: expect.any(Number),
      DAYS_8_30: expect.any(Number),
      DAYS_31_90: expect.any(Number),
      OVER_90: expect.any(Number),
    });
    const row = (res.body.items as Array<{
      id: string;
      status: string;
      agingBucket: string;
      ageDays: number;
      statusEnteredAt: string;
      createdAt: string;
    }>).find((item) => item.id === docId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('DRAFT');
    expect(row!.agingBucket).toBe('DAYS_0_7');
    expect(row!.ageDays).toBeGreaterThanOrEqual(0);
    // statusEnteredAt is the CURRENT-status entry instant (here: creation) —
    // a valid timestamp, not necessarily >= createdAt at millisecond grain.
    expect(Number.isNaN(new Date(row!.statusEnteredAt).getTime())).toBe(false);
    expect(row!.ageDays).toBe(
      Math.max(
        0,
        Math.floor(
          (new Date(res.body.generatedAt).getTime() -
            new Date(row!.statusEnteredAt).getTime()) /
            86_400_000
        )
      )
    );
  });

  it('aging: requires authentication and commerce.read', async () => {
    const url = `${API_PREFIX}/reporting/commerce/purchase-documents/aging`;
    const anon: SupertestResponse = await api().get(url);
    expect(anon.status).toBe(401);
    const denied: SupertestResponse = await api()
      .get(url)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);
  });

  it('cost: reports the document under its own costCenter — committed, paid, outstanding', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/reporting/commerce/purchase-documents/cost`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(typeof res.body.generatedAt).toBe('string');
    const row = (res.body.items as Array<{
      costCenter: string;
      documentCount: number;
      committedAmount: string;
      paidAmount: string;
      outstandingAmount: string;
    }>).find((item) => item.costCenter === COST_CENTER);
    expect(row).toBeDefined();
    expect(row!.documentCount).toBe(1);
    // 10 × 500 + 0 tax = 5000 committed; nothing paid.
    expect(Number(row!.committedAmount)).toBe(5000);
    expect(Number(row!.paidAmount)).toBe(0);
    expect(Number(row!.outstandingAmount)).toBe(5000);
  });

  it('reconciliation: the un-resolvable reference is UNRESOLVED, never rewritten', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/commerce/suppliers/reconciliation`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const items = res.body.items ?? res.body;
    const row = (items as Array<{
      reference: string;
      documentCount: number;
      resolution: string;
      matches: unknown[];
    }>).find((item) => item.reference === SUPPLIER_REF);
    expect(row).toBeDefined();
    expect(row!.resolution).toBe('UNRESOLVED');
    expect(row!.documentCount).toBe(1);
    // The historical reference is still on the document — the report never writes.
    const detail: SupertestResponse = await api()
      .get(`${API_PREFIX}/commerce/purchase-documents/${docId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(detail.body.supplierId).toBe(SUPPLIER_REF);
  });

  it('reconciliation: requires authentication and commerce.read', async () => {
    const url = `${API_PREFIX}/commerce/suppliers/reconciliation`;
    expect((await api().get(url)).status).toBe(401);
    const denied: SupertestResponse = await api()
      .get(url)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);
  });

  it('posting queue: the receipt’s posting is visible and POSTED; retry is a safe no-op', async () => {
    const list: SupertestResponse = await api()
      .get(`${API_PREFIX}/commerce/inventory-postings?status=POSTED`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const posting = (list.body.postings as Array<{
      id: string;
      status: string;
      purchaseLineId: string;
      movementId: string | null;
    }>).find((row) => row.purchaseLineId === purchaseLineId);
    expect(posting).toBeDefined();
    expect(posting!.status).toBe('POSTED');
    expect(typeof posting!.movementId).toBe('string');
    postingId = posting!.id;

    const retried: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/inventory-postings/${postingId}/retry`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);
    expect(retried.body.status).toBe('POSTED');
    // Idempotent: a second movement is NOT created for an already-posted row.
    expect(retried.body.movementId).toBe(posting!.movementId);
  });

  it('recovery: unresolvable SKU posts FAILED with a diagnostic, then ONE concurrent-safe retry pair posts exactly ONE movement', async () => {
    const failSku = `AG-${RUN_ID}-FAIL`.slice(0, 64);
    const inventoryDb = getInventoryDb();

    // A document whose SKU Inventory cannot resolve — the posting must FAIL,
    // visibly and retryably, not vanish or fake success.
    const docRes: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/purchase-documents`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        requesterId: admin.userId,
        supplierId: SUPPLIER_REF,
        currency: 'IRR',
        costCenter: COST_CENTER,
        lines: [
          {
            lineType: 'STANDARD',
            quantity: 5,
            unit: 'PCS',
            unitPrice: 100,
            tax: 0,
            itemReference: failSku,
          },
        ],
      })
      .expect(201);
    const failLineId: string = docRes.body.lines[0].id;

    const warehouse = await inventoryDb.warehouse.findFirst({
      where: { tenantId: tenantAId, code: `WH-AG-${RUN_ID}`.slice(0, 32) },
    });
    expect(warehouse).toBeDefined();

    await api()
      .post(`${API_PREFIX}/commerce/purchase-documents/${docRes.body.id}/receipts`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ lines: [{ purchaseLineId: failLineId, quantity: 2, warehouseId: warehouse!.id }] })
      .expect(201);

    const failedList: SupertestResponse = await api()
      .get(`${API_PREFIX}/commerce/inventory-postings?status=FAILED`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const failedPosting = (failedList.body.postings as Array<{
      id: string;
      status: string;
      purchaseLineId: string;
      sourceLineId: string;
      lastError: string | null;
      attempts: number;
    }>).find((row) => row.purchaseLineId === failLineId);
    expect(failedPosting).toBeDefined();
    expect(failedPosting!.status).toBe('FAILED');
    // The failure is diagnosable: the row carries WHY it failed.
    expect(failedPosting!.lastError).toBeTruthy();

    // The defect is repaired (the item now exists) — the durable intent makes
    // recovery possible AFTER the fact, which is the restart-recovery contract:
    // nothing was lost between "receipt committed" and "posting attempted".
    await inventoryDb.inventoryItem.create({
      data: {
        tenantId: tenantAId,
        sku: failSku,
        name: `e2e late item ${failSku}`,
        itemType: 'STOCKED',
        baseUnit: 'PCS',
        createdByUserId: admin.userId,
      },
    });

    // TWO retries fired concurrently for the same posting — a safe no-op or a
    // single successful post are both valid; a second ledger movement is not.
    const [r1, r2] = await Promise.all([
      api()
        .post(`${API_PREFIX}/commerce/inventory-postings/${failedPosting!.id}/retry`)
        .set('Authorization', `Bearer ${admin.token}`),
      api()
        .post(`${API_PREFIX}/commerce/inventory-postings/${failedPosting!.id}/retry`)
        .set('Authorization', `Bearer ${admin.token}`),
    ]);
    const posted = [r1, r2].find((r) => r.status === 201 && r.body?.status === 'POSTED');
    expect(posted).toBeDefined();
    // movementId is nullable BY CONTRACT: the attempt that won posts the
    // movement id; the loser gets the ledger's own "duplicate" answer and the
    // row joins the evidence through `sourceLineId` instead. Both responses
    // reporting POSTED is the safe-concurrency shape — two ids would be a bug,
    // two POSTED rows is the design.
    const winner = [r1, r2].find(
      (r) => r.status === 201 && typeof r.body?.movementId === 'string'
    );

    // The ledger-level proof: one source business event produced exactly ONE
    // movement — never two, even under concurrent retries.
    const movements = await inventoryDb.stockMovement.findMany({
      where: {
        tenantId: tenantAId,
        sourceType: 'commerce.receipt',
        sourceId: failedPosting!.sourceLineId,
      },
    });
    expect(movements).toHaveLength(1);
    expect(winner?.body.movementId ?? movements[0].id).toBe(movements[0].id);
    expect(Number(movements[0].quantity)).toBe(2);
    // The late-seeded item is left in place: the ledger row FK-restricts its
    // deletion, and the RUN_ID-unique SKU cannot collide with another run.
  }, 60_000);

  it('posting queue: 401 anonymous, 403 without commerce.read, foreign id is 404', async () => {
    const url = `${API_PREFIX}/commerce/inventory-postings`;
    expect((await api().get(url)).status).toBe(401);
    const denied: SupertestResponse = await api()
      .get(url)
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);
    const foreign: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/inventory-postings/${randomUUID()}/retry`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(foreign.status).toBe(404);
  });
});
