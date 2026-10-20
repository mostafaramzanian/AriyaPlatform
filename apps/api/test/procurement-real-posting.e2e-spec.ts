/**
 * Phase R-10 — PROCUREMENT, END TO END, OVER THE REAL PROVIDERS.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Every app-level Commerce suite in this repository REPLACES the posting port with a
 * test double — commerce-lifecycle, commerce-integration, commerce-tenant,
 * commerce-search, commerce-search-source, commerce-gap8-identity and
 * commerce-gap9-notifications all bind
 * `{ provide: INVENTORY_POSTING_PORT, useValue: createFakeInventoryPostingPort() }` —
 * so the composition root's REAL binding (`commerce.module.ts`:
 * `{ provide: INVENTORY_POSTING_PORT, useExisting: InventoryPostingFacade }`, over
 * `InventoryModule`'s exported facade) had no app-level proof of any kind, and
 * Financial's `PURCHASE_ORDER_REFERENCE_PORT` bridge
 * (`modules/purchase-order-reference/`, binding Financial's port to Commerce's
 * `CommerceOrderReferenceFacade`) had never been exercised against a real Commerce
 * document over HTTP. A validated procurement path therefore could not be claimed:
 * what was proven was the contract AT the seam, not that a receipt reaches the
 * Inventory ledger or that a check request resolves a real order.
 *
 * This file closes that gap WITHOUT a single override. It builds no testing module and
 * fakes no provider: `test/setup.ts` boots the production `AppModule`, and this suite
 * drives it through real HTTP, real JWT auth, real Postgres and the real ports the
 * application resolves at boot.
 *
 *     authenticated administrator
 *          ↓
 *     Commerce HTTP (purchase-documents, receipts, inventory-postings)
 *          ↓
 *     INVENTORY_POSTING_PORT → InventoryPostingFacade → StockService (real)
 *          ↓
 *     `inventory_db` ledger (`inventory_stock_movements`) + balance projection
 *          ↓
 *     Financial HTTP (check-requests) → PURCHASE_ORDER_REFERENCE_PORT
 *          ↓
 *     CommerceOrderReferenceFacade → real `commerce_db` purchase document
 *
 * WHAT IT PROVES (each as observed data, never as an assumption)
 * --------------------------------------------------------------
 *   A. the app resolves the REAL facade for `INVENTORY_POSTING_PORT`, and the REAL
 *      Commerce facade behind Financial's order-reference port (a fake could not
 *      answer with the document's own issued number);
 *   B. a stocked purchase line received over HTTP produces: one `InventoryPosting`
 *      (POSTED, with the resolved item id, the destination cell, the exact quantity
 *      and the movement it produced), one `InventoryPostingAttempt` (POSTED), one
 *      ledger movement in `inventory_db` (`commerce.receipt` / the receipt line id /
 *      kind RECEIPT) and the balance projection effect — all four, in one act;
 *   C. PARTIAL receipts post twice and accumulate; an over-receipt is refused with 409
 *      against the committed history (no cap, no silent truncation);
 *   D. retry is idempotent at three levels: the POSTED row answers itself with the
 *      same movement id and no new attempt, the ledger still holds exactly one
 *      movement for that source tuple, and the ledger's own composite unique refuses a
 *      second insert even when attempted directly;
 *   E. a compensating receipt line posts the OUTBOUND movement (`ISSUE`,
 *      `commerce.receipt-compensation`) and decrements the same cell;
 *   F. a Financial check request naming the real purchase document's issued number is
 *      accepted and stored (`finance_db`), while an unknown number, a missing number
 *      and ANOTHER TENANT's number are each refused by the port-backed rule;
 *   G. the authorization layer is real (401 anonymous, 403 without the permission) and
 *      the tenant boundary holds across all three owners: tenant B's traffic lands in
 *      tenant B's rows only, and tenant B can neither read nor retry tenant A's posting.
 *
 * SEAMS (test-only, and only these)
 * ---------------------------------
 *   * Identity/entitlement prerequisites are written through the Core Prisma client by
 *     the repository's own provisioning fixtures (`fixtures/*-provisioning.ts`) — no
 *     HTTP surface provisions roles, grants or module membership. They run BEFORE the
 *     first login of each identity, because the permission claim is cached at login
 *     (`user:permissions:<id>`, 15 min TTL), and the cache is invalidated explicitly
 *     through `PermissionService.invalidateUserPermissions` (the repository's own
 *     mutation idiom) so a claim minted by an earlier suite in the same run cannot
 *     decide this suite's answers.
 *   * The suite must run in band (`--runInBand`): like the Financial and Inventory
 *     suites it touches cluster-wide grant rows and the shared permission cache.
 *
 * CLEANUP is deliberately narrow, and the reason is a contract, not convenience: the
 * Inventory ledger is APPEND-ONLY by design (`prisma/inventory/schema.prisma`:
 * "THE LEDGER — append-only, never updated, never deleted") and the movement →
 * item/warehouse foreign keys are `onDelete: Restrict`, so deleting this run's
 * movements to make a catalogue row deletable would destroy the evidence this suite
 * exists to create. What `afterAll` removes is therefore exactly the identity data
 * this run created in Core — the run's second tenant, its users and their membership
 * rows — while the ledger, the balance projection and the Commerce/Financial rows stay
 * as the run's record. Audit rows are never deleted: the trail is append-only.
 */
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { makeRequest, getTestApp } from './setup';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';
import { InventoryPrismaService } from '../src/modules/inventory/database/inventory-prisma.service';
import { FinancialPrismaService } from '../src/modules/financial/database/financial-prisma.service';
import { INVENTORY_POSTING_PORT } from '../src/modules/commerce/integration/inventory-posting.port';
import { InventoryPostingFacade } from '../src/modules/inventory/integration/inventory-posting.facade';
import {
  PURCHASE_ORDER_REFERENCE_PORT,
  type PurchaseOrderReferencePort,
} from '../src/modules/financial/purchase-order-reference.port';
import { PermissionService } from '../src/auth/rbac/services/permission.service';
import { CHECK_REQUEST_STATUS } from '../src/modules/financial/check-request/check-request-status';
import { ensureCommerceProcurementTestProvisioning } from './fixtures/commerce-provisioning';
import { ensureInventoryTestProvisioning } from './fixtures/inventory-provisioning';
import { ensureFinancialCheckTestProvisioning } from './fixtures/financial-check-provisioning';
import {
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD,
  SEED_BOOTSTRAP_TENANT_ID,
} from './fixtures/seed-environment';

type SupertestResponse = import('supertest').Response;

const API_PREFIX = '/api/v1';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** The SKU / warehouse-code prefixes this run owns — never a bare `deleteMany`. */
const SKU_PREFIX = 'R10-E2E-';
const WAREHOUSE_CODE_PREFIX = 'R10WH-';

const RECEIPT_QTY_PARTIAL = 5;
const RECEIPT_QTY_REST = 7;
const ORDERED_QTY = RECEIPT_QTY_PARTIAL + RECEIPT_QTY_REST;
const COMPENSATION_QTY = 2;
const TENANT_B_RECEIPT_QTY = 3;
/** The item's declared unit vocabulary: the purchase line must state it VERBATIM. */
const BASE_UNIT = 'PCS';

interface Actor {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  token: string;
}

interface PurchaseLineView {
  id: string;
  lineNumber: number;
  quantity: string;
  unit: string | null;
  itemReference: string | null;
}

interface PurchaseDocumentView {
  id: string;
  documentNumber: string;
  status: string;
  lines: PurchaseLineView[];
}

interface ReceiptLineView {
  id: string;
  purchaseLineId: string;
  quantity: string;
}

interface ReceiptView {
  id: string;
  lines: ReceiptLineView[];
}

interface PostingView {
  id: string;
  kind: string;
  sourceLineId: string;
  purchaseLineId: string;
  itemRef: string;
  itemId: string | null;
  warehouseId: string;
  locationId: string;
  quantity: string;
  unit: string;
  status: string;
  movementId: string | null;
  attempts: number;
  lastError: string | null;
}

interface CheckRequestView {
  id: string;
  /** The state machine's ORDINAL on the wire (`check-request-status.ts`), not a label. */
  status: number;
  checkIssueType: string;
  orderReference: string | null;
}

interface IdView {
  id: string;
}

interface BalanceRowView {
  itemId: string;
  warehouseId: string;
  locationId: string;
  onHand: string | number;
}

interface MovementRowView {
  id: string;
  kind: string;
  sourceType: string;
  sourceId: string;
}

/** One line of the receiving projection (`GET …/receipts`). */
interface ReceivingLineView {
  purchaseLineId: string;
  orderedQuantity: string;
  receivedQuantity: string;
  receivingStatus: string;
}
function getApp() {
  return getTestApp();
}

function coreDb(): CorePrismaService {
  return getApp().get(CorePrismaService);
}

function commerceDb(): CommercePrismaService {
  return getApp().get(CommercePrismaService);
}

function inventoryDb(): InventoryPrismaService {
  return getApp().get(InventoryPrismaService);
}

function financeDb(): FinancialPrismaService {
  return getApp().get(FinancialPrismaService);
}

function api() {
  return makeRequest();
}

async function login(email: string, password: string): Promise<string> {
  const res = await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(200);
  const token = res.body?.data?.accessToken ?? res.body?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error(
      `[E2E] Login for ${email} produced no access token: ${JSON.stringify(res.body)}`
    );
  }
  return token;
}

/**
 * Drops the cached permission claim for one user, so the NEXT login resolves it from
 * the CURRENT grant state. `PermissionService.invalidateUserPermissions` is the
 * repository's own invalidation path (`role.service.ts` calls it after every grant
 * write) — not a test-only hack.
 */
async function invalidatePermissionClaim(userId: string, reason: string): Promise<void> {
  await getApp().get(PermissionService).invalidateUserPermissions(userId, reason);
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
        lastError = `ready=${ready.status} ${JSON.stringify(ready.body)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`[E2E] Service did not become ready within ${timeoutMs}ms: ${lastError}`);
}

/**
 * Envelope-tolerant page read: the platform's list routes return the repository shape
 * (`{ items, total }`) directly, and this tolerates a wrapper so a future envelope
 * change reports a real assertion failure instead of a TypeError.
 */
function itemsOf<T>(body: unknown): T[] {
  const b = body as { items?: unknown; data?: { items?: unknown } } | null;
  if (Array.isArray(b?.items)) return b.items as T[];
  if (Array.isArray(b?.data?.items)) return b.data.items as T[];
  return [];
}

async function findAdminRoleId(): Promise<string> {
  const role = await coreDb().role.findUnique({ where: { name: 'ADMIN' } });
  if (!role) throw new Error('[E2E] Seeded ADMIN role not found');
  return role.id;
}

async function createUser(label: string, tenantId: string, roleId?: string): Promise<Actor> {
  const email = `${label}-${RUN_ID}@aria.test`;
  const password = `Pwd-${label}-${RUN_ID}!`;
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = `user-${label}-${RUN_ID}`;

  await coreDb().user.create({
    data: {
      id: userId,
      email,
      passwordHash,
      firstName: label,
      lastName: 'e2e',
      status: 'EMPLOYEE',
      tenant: { connect: { id: tenantId } },
      ...(roleId ? { userRoles: { create: { roleId, assignedBy: userId } } } : {}),
    },
  });

  return { email, password, userId, tenantId, token: '' };
}

/** The seeded administrator, resolved the same way `prisma/seed.ts` writes it. */
async function readSeededAdmin(): Promise<Actor> {
  const row = await coreDb().user.findUnique({
    where: { email: SEED_ADMIN_EMAIL },
    select: { id: true, tenantId: true },
  });
  if (!row) throw new Error(`[E2E] Seeded administrator ${SEED_ADMIN_EMAIL} is absent from Core`);
  return {
    email: SEED_ADMIN_EMAIL,
    password: SEED_ADMIN_PASSWORD,
    userId: row.id,
    tenantId: row.tenantId ?? SEED_BOOTSTRAP_TENANT_ID,
    token: '',
  };
}

/**
 * A SECOND tenant, entitled to all three modules this flow crosses — the isolation half
 * of the slice. Mirrors what real tenant provisioning leaves behind: the module
 * registration links + feature grants (written by the repository's own fixtures) and an
 * ADMIN actor, so B holds the same permissions as A inside ITS tenant only.
 */
async function createTenantB(): Promise<{ tenantId: string; admin: Actor }> {
  const core = coreDb();
  const tenantId = `tenant-r10b-${RUN_ID}`;

  await core.tenant.create({ data: { id: tenantId, code: tenantId } });
  await ensureCommerceProcurementTestProvisioning(core, [tenantId]);
  await ensureInventoryTestProvisioning(core, [tenantId]);
  await ensureFinancialCheckTestProvisioning(core, [tenantId]);

  const base = await createUser('tenantBAdmin', tenantId, await findAdminRoleId());
  const tenantBAdmin: Actor = { ...base, token: await login(base.email, base.password) };
  return { tenantId, admin: tenantBAdmin };
}
describe('Procurement — Purchase → Inventory → Finance over the REAL providers (Phase R-10)', () => {
  let admin: Actor;
  let noRole: Actor;
  let tenantBAdmin: Actor;

  let warehouseIdA = '';
  let itemIdA = '';
  const skuA = `${SKU_PREFIX}A-${RUN_ID}`;
  let warehouseIdB = '';
  let itemIdB = '';
  const skuB = `${SKU_PREFIX}B-${RUN_ID}`;

  let docA: PurchaseDocumentView;
  let lineA: PurchaseLineView;
  let docB: PurchaseDocumentView;

  /** The two posting rows the two partial receipts produced, read back from Commerce. */
  let posting1: PostingView;
  let posting2: PostingView;
  let movementId1 = '';
  let receiptLineId1 = '';
  let receiptLineId2 = '';

  const receiptsUrl = (documentId: string) =>
    `${API_PREFIX}/commerce/purchase-documents/${documentId}/receipts`;
  const postingsUrl = (suffix = '') => `${API_PREFIX}/commerce/inventory-postings${suffix}`;
  const checkRequestsUrl = `${API_PREFIX}/financial/check-requests`;

  /** The persisted posting row for one source line — the durable evidence, from Commerce. */
  async function postingFor(sourceLineId: string): Promise<PostingView | null> {
    const row = await commerceDb().inventoryPosting.findFirst({
      where: { tenantId: admin.tenantId, sourceLineId },
    });
    return row ? (row as unknown as PostingView) : null;
  }

  /** The balance projection cell for one item/warehouse — `onHand` as a NUMBER. */
  async function onHandOf(
    tenantId: string,
    itemId: string,
    warehouseId: string,
    locationId = ''
  ): Promise<number> {
    const row = await inventoryDb().stockBalance.findFirst({
      where: { tenantId, itemId, warehouseId, locationId },
    });
    return row ? Number(String(row.onHand)) : Number.NaN;
  }

  /**
   * The receiving projection line for ONE purchase line (`GET …/receipts`).
   *
   * The QUANTITIES are compared as NUMBERS by the callers, deliberately: the wire
   * carries the exact `Decimal(18,4)` string the platform stores, and whether a given
   * total renders as `12` or `12.0000` is the decimal scaler's business (the receiving
   * unit suite owns that convention) — what THIS suite asserts is the quantity that
   * actually moved. The status is an exact string, and it is asserted as one.
   */
  async function receivingLineOf(
    documentId: string,
    purchaseLineId: string
  ): Promise<ReceivingLineView> {
    const res: SupertestResponse = await api()
      .get(receiptsUrl(documentId))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const lines = (res.body as { lines?: ReceivingLineView[] }).lines ?? [];
    const line = lines.find((row) => row.purchaseLineId === purchaseLineId);
    if (!line) throw new Error(`[E2E] no receiving projection line for ${purchaseLineId}`);
    return line;
  }

  /** Appends one receiving operation and returns the stored receipt view. */
  async function appendReceipt(
    documentId: string,
    purchaseLineId: string,
    quantity: number,
    warehouseId: string,
    actor: Actor
  ): Promise<ReceiptView> {
    const res: SupertestResponse = await api()
      .post(receiptsUrl(documentId))
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ lines: [{ purchaseLineId, quantity, warehouseId }] });
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 201 });
    return res.body as ReceiptView;
  }

  /** One purchase document with ONE stocked line, driven through the Commerce API. */
  async function createStockedDocument(
    actor: Actor,
    itemRef: string
  ): Promise<PurchaseDocumentView> {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/purchase-documents`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({
        requesterId: actor.userId,
        supplierId: `SUP-${RUN_ID}`,
        currency: 'IRR',
        lines: [
          {
            lineType: 'STANDARD',
            quantity: ORDERED_QTY,
            unit: BASE_UNIT,
            unitPrice: 250,
            tax: 0,
            itemReference: itemRef,
          },
        ],
      });
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 201 });
    return res.body as PurchaseDocumentView;
  }

  /** A warehouse + a stocked item in one tenant, through Inventory's own HTTP surface. */
  async function createCatalogue(
    actor: Actor,
    sku: string,
    code: string
  ): Promise<{ warehouseId: string; itemId: string }> {
    const warehouse: SupertestResponse = await api()
      .post(`${API_PREFIX}/inventory/warehouses`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ code, name: `R-10 warehouse ${code}` });
    expect({ status: warehouse.status, body: warehouse.body }).toMatchObject({ status: 201 });

    const item: SupertestResponse = await api()
      .post(`${API_PREFIX}/inventory/items`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({
        sku,
        name: `R-10 item ${sku}`,
        itemType: 'STOCKED',
        baseUnit: BASE_UNIT,
        trackingMode: 'NONE',
      });
    expect({ status: item.status, body: item.body }).toMatchObject({ status: 201 });

    return {
      warehouseId: (warehouse.body as IdView).id,
      itemId: (item.body as IdView).id,
    };
  }
  /** Identity rows THIS run created in Core — the only things `afterAll` removes. */
  const runOwnedUserIds: string[] = [];
  let tenantBId = '';

  beforeAll(async () => {
    await waitForReadiness();
    const core = coreDb();

    // Test-only identity/entitlement prerequisites for the bootstrap tenant, written
    // BEFORE the first login: the permission claim is resolved (and cached) at login, so
    // a grant written afterwards would leave every later request permission-empty.
    // Shapes mirrored, nothing else touched: fixtures/*-provisioning.ts.
    admin = await readSeededAdmin();
    expect(admin.tenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);
    await ensureCommerceProcurementTestProvisioning(core, [admin.tenantId]);
    await ensureInventoryTestProvisioning(core, [admin.tenantId]);
    await ensureFinancialCheckTestProvisioning(core, [admin.tenantId]);
    // A claim an earlier suite cached for this administrator may predate these grants.
    await invalidatePermissionClaim(admin.userId, 'e2e-r10-provisioned');
    admin.token = await login(admin.email, admin.password);

    // An actor INSIDE tenant A holding NO role: the 403 probe below.
    const noRoleBase = await createUser('noRole', admin.tenantId);
    noRole = { ...noRoleBase, token: await login(noRoleBase.email, noRoleBase.password) };
    runOwnedUserIds.push(noRole.userId);

    // The second tenant — entitled to the same three modules, with its own ADMIN actor.
    const tenantB = await createTenantB();
    tenantBAdmin = tenantB.admin;
    tenantBId = tenantB.tenantId;
    runOwnedUserIds.push(tenantBAdmin.userId);
  }, 180_000);

  afterAll(async () => {
    const core = coreDb();

    // Test-only and BEST-EFFORT: the identity rows this run created in Core. Each
    // statement is attempted independently, because a refusal of one (an append-only
    // audit row referencing a user is exactly that) must not skip the others. The
    // ledger, the balance projection and the Commerce/Financial rows are NOT touched —
    // see the header: append-only evidence is the deliverable, not garbage.
    const statements: Array<() => Promise<unknown>> = [
      // PHASE R-10 — THE RUN'S OWN QUEUE ROWS GO WITH THE RUN, BEFORE ITS ACTORS DO.
      //
      // Commerce writes audit events to `commerce_db."AuditOutbox"` inside the business
      // transaction and relays them to `AUDIT_PORT` on a timer. This suite binds the REAL
      // port, so the run's events for tenant A (whose actor is the seeded administrator,
      // still present) are delivered and deleted by the relay itself. Tenant B's rows are
      // different: this `afterAll` deletes B's administrator, so a row still pending at
      // that moment could never be written again — the real relay would answer P2003
      // `AuditLog_userId_fkey (index)` at every later app boot, forever
      // (`commerce-audit-outbox-relay.service.ts` keeps a failed row and backs off). The
      // sweep below removes exactly the rows of the tenant this run tears down: a QUEUE
      // deletion scoped to this run's own synthetic tenant, never a `AuditLog` deletion —
      // the trail Core already holds for this run stays untouched.
      () => commerceDb().auditOutbox.deleteMany({ where: { tenantId: tenantBId } }),
      () => core.userRole.deleteMany({ where: { userId: { in: runOwnedUserIds } } }),
      () => core.user.deleteMany({ where: { id: { in: runOwnedUserIds } } }),
      () => core.moduleFeatureGrant.deleteMany({ where: { tenantId: tenantBId } }),
      () => core.moduleRegistrationTenant.deleteMany({ where: { tenantId: tenantBId } }),
      () => core.tenant.deleteMany({ where: { id: tenantBId } }),
    ];
    for (const statement of statements) {
      try {
        await statement();
      } catch {
        // best-effort
      }
    }

    // Leave the cluster PROVISIONED for the bootstrap tenant: that is the state the
    // migrations intend, and re-applying is a no-op.
    try {
      await ensureCommerceProcurementTestProvisioning(core, [SEED_BOOTSTRAP_TENANT_ID]);
      await ensureInventoryTestProvisioning(core, [SEED_BOOTSTRAP_TENANT_ID]);
      await ensureFinancialCheckTestProvisioning(core, [SEED_BOOTSTRAP_TENANT_ID]);
    } catch {
      // best-effort
    }
  }, 60_000);
  it('A. resolves the REAL posting facade and the REAL order-reference bridge — no double in the graph', async () => {
    // The double every other Commerce suite binds is a plain object literal; the real
    // binding is the exported facade INSTANCE. This assertion IS the composition claim.
    const postingPort = getApp().get<unknown>(INVENTORY_POSTING_PORT);
    expect(postingPort).toBeInstanceOf(InventoryPostingFacade);

    const bridge = getApp().get<unknown>(
      PURCHASE_ORDER_REFERENCE_PORT
    ) as PurchaseOrderReferencePort;
    expect(typeof bridge.resolve).toBe('function');

    // The bridge resolves through Commerce's facade against the real `commerce_db`:
    // asked for a reference that cannot exist it answers `null` — never a fabricated row.
    expect(await bridge.resolve(admin.tenantId, `NO-SUCH-ORDER-${RUN_ID}`)).toBeNull();
  });

  it('B. creates the receiving catalogue over Inventory HTTP, persisted in `inventory_db`', async () => {
    const warehouseCode = `${WAREHOUSE_CODE_PREFIX}A-${RUN_ID}`;
    const catalogue = await createCatalogue(admin, skuA, warehouseCode);
    warehouseIdA = catalogue.warehouseId;
    itemIdA = catalogue.itemId;

    expect(await inventoryDb().warehouse.findFirst({ where: { id: warehouseIdA } })).toMatchObject({
      tenantId: admin.tenantId,
      code: warehouseCode,
      status: 'ACTIVE',
    });
    expect(await inventoryDb().inventoryItem.findFirst({ where: { id: itemIdA } })).toMatchObject({
      tenantId: admin.tenantId,
      sku: skuA,
      itemType: 'STOCKED',
      baseUnit: BASE_UNIT,
      trackingMode: 'NONE',
      status: 'ACTIVE',
    });
  });

  it('C. drives a real purchase document with a STOCKED line to SUBMITTED', async () => {
    docA = await createStockedDocument(admin, skuA);
    expect(docA.status).toBe('DRAFT');
    expect(docA.lines).toHaveLength(1);
    lineA = docA.lines[0];
    expect(lineA.itemReference).toBe(skuA);
    expect(lineA.unit).toBe(BASE_UNIT);
    expect(Number(lineA.quantity)).toBe(ORDERED_QTY);

    const submitted: SupertestResponse = await api()
      .post(`${API_PREFIX}/commerce/purchase-documents/${docA.id}/submit`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect({ status: submitted.status, body: submitted.body }).toMatchObject({ status: 200 });
    expect((submitted.body as PurchaseDocumentView).status).toBe('SUBMITTED');
  });
  it('D. one partial receipt → ONE posting, ONE attempt, ONE movement, ONE balance cell', async () => {
    const receipt = await appendReceipt(
      docA.id,
      lineA.id,
      RECEIPT_QTY_PARTIAL,
      warehouseIdA,
      admin
    );
    expect(receipt.lines).toHaveLength(1);
    receiptLineId1 = receipt.lines[0].id;
    expect(receipt.lines[0].purchaseLineId).toBe(lineA.id);

    const posting = await postingFor(receiptLineId1);
    if (!posting) {
      throw new Error('[E2E] no InventoryPosting row exists for the receipt line');
    }
    posting1 = posting;
    expect(posting).toMatchObject({
      kind: 'RECEIPT',
      sourceLineId: receiptLineId1,
      purchaseLineId: lineA.id,
      itemRef: skuA,
      itemId: itemIdA,
      warehouseId: warehouseIdA,
      locationId: '',
      unit: BASE_UNIT,
      status: 'POSTED',
      attempts: 1,
      lastError: null,
    });
    expect(Number(posting.quantity)).toBe(RECEIPT_QTY_PARTIAL);
    movementId1 = posting.movementId ?? '';
    expect(movementId1).not.toBe('');

    // The attempt history: ONE row, POSTED, attributed to this administrator.
    const attempts = await commerceDb().inventoryPostingAttempt.findMany({
      where: { tenantId: admin.tenantId, postingId: posting.id },
      orderBy: { attempt: 'asc' },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      result: 'POSTED',
      movementId: movementId1,
      actorUserId: admin.userId,
      error: null,
    });

    // The ledger row itself, in `inventory_db`: kind RECEIPT, sourced from the receipt
    // LINE, under `commerce.receipt` — the source type the real facade states.
    const movement = await inventoryDb().stockMovement.findFirst({ where: { id: movementId1 } });
    expect(movement).toMatchObject({
      tenantId: admin.tenantId,
      kind: 'RECEIPT',
      itemId: itemIdA,
      warehouseId: warehouseIdA,
      locationId: '',
      unit: BASE_UNIT,
      sourceType: 'commerce.receipt',
      sourceId: receiptLineId1,
      recordedByUserId: admin.userId,
    });
    expect(Number(String(movement?.quantity))).toBe(RECEIPT_QTY_PARTIAL);
    expect(Number(String(movement?.baseQuantity))).toBe(RECEIPT_QTY_PARTIAL);

    // The balance projection moved by exactly that quantity, in the destination cell.
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(RECEIPT_QTY_PARTIAL);

    // The same facts are readable over Inventory's own HTTP surface.
    const movements: SupertestResponse = await api()
      .get(
        `${API_PREFIX}/inventory/stock/movements?sourceType=commerce.receipt&sourceId=${receiptLineId1}`
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(itemsOf<MovementRowView>(movements.body).map((row) => row.id)).toEqual([movementId1]);

    const balances: SupertestResponse = await api()
      .get(`${API_PREFIX}/inventory/stock/balances?itemId=${itemIdA}&warehouseId=${warehouseIdA}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const balanceRows = itemsOf<BalanceRowView>(balances.body);
    expect(balanceRows).toHaveLength(1);
    expect(Number(balanceRows[0].onHand)).toBe(RECEIPT_QTY_PARTIAL);

    // The document's receiving projection reports the partial state for that line.
    const projection = await receivingLineOf(docA.id, lineA.id);
    expect(Number(projection.orderedQuantity)).toBe(ORDERED_QTY);
    expect(Number(projection.receivedQuantity)).toBe(RECEIPT_QTY_PARTIAL);
    expect(projection.receivingStatus).toBe('PARTIALLY_RECEIVED');
  });
  it('E. the REST of the line posts a SECOND movement; an over-receipt is refused 409', async () => {
    const receipt = await appendReceipt(docA.id, lineA.id, RECEIPT_QTY_REST, warehouseIdA, admin);
    expect(receipt.lines).toHaveLength(1);
    receiptLineId2 = receipt.lines[0].id;

    const posting = await postingFor(receiptLineId2);
    if (!posting) {
      throw new Error('[E2E] no InventoryPosting row exists for the second receipt line');
    }
    posting2 = posting;
    expect(posting).toMatchObject({
      kind: 'RECEIPT',
      sourceLineId: receiptLineId2,
      status: 'POSTED',
      itemId: itemIdA,
      attempts: 1,
      lastError: null,
    });
    expect(Number(posting.quantity)).toBe(RECEIPT_QTY_REST);
    expect(posting.movementId).not.toBeNull();
    expect(posting.movementId).not.toBe(movementId1);

    // TWO movements — one per receipt line — and the projection holds their SUM.
    expect(
      await inventoryDb().stockMovement.count({
        where: {
          tenantId: admin.tenantId,
          kind: 'RECEIPT',
          sourceType: 'commerce.receipt',
          sourceId: { in: [receiptLineId1, receiptLineId2] },
        },
      })
    ).toBe(2);
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(ORDERED_QTY);

    const fullyReceived = await receivingLineOf(docA.id, lineA.id);
    expect(Number(fullyReceived.orderedQuantity)).toBe(ORDERED_QTY);
    expect(Number(fullyReceived.receivedQuantity)).toBe(ORDERED_QTY);
    expect(fullyReceived.receivingStatus).toBe('FULLY_RECEIVED');

    // OVER-RECEIPT: refused against the committed history (409), never capped and never
    // accepted for later repair — and nothing posts for the refused operation.
    const over: SupertestResponse = await api()
      .post(receiptsUrl(docA.id))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ lines: [{ purchaseLineId: lineA.id, quantity: 1, warehouseId: warehouseIdA }] });
    expect({ status: over.status, body: over.body }).toMatchObject({ status: 409 });

    expect(
      await inventoryDb().stockMovement.count({
        where: { tenantId: admin.tenantId, itemId: itemIdA },
      })
    ).toBe(2);
    // Counted by THIS run's own purchase line, not by tenant: the bootstrap tenant is
    // shared with every other suite, so a tenant-wide count would measure their rows too.
    expect(
      await commerceDb().inventoryPosting.count({
        where: { tenantId: admin.tenantId, purchaseLineId: lineA.id },
      })
    ).toBe(2);
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(ORDERED_QTY);
  });

  it('F. retry is idempotent: one movement, one attempt, and the ledger refuses a second', async () => {
    expect(
      await inventoryDb().stockMovement.count({
        where: {
          tenantId: admin.tenantId,
          kind: 'RECEIPT',
          sourceType: 'commerce.receipt',
          sourceId: receiptLineId1,
        },
      })
    ).toBe(1);

    // 1. The operator surface: a POSTED row answers itself — same movement id, same
    //    attempt count, because the service never re-attempts a POSTED posting.
    const retried: SupertestResponse = await api()
      .post(postingsUrl(`/${posting1.id}/retry`))
      .set('Authorization', `Bearer ${admin.token}`);
    expect({ status: retried.status, body: retried.body }).toMatchObject({ status: 201 });
    expect(retried.body as PostingView).toMatchObject({
      id: posting1.id,
      status: 'POSTED',
      movementId: movementId1,
      attempts: 1,
      lastError: null,
    });

    // 2. The ledger still holds exactly one movement for that source tuple, and no second
    //    attempt row appeared.
    expect(
      await inventoryDb().stockMovement.count({
        where: {
          tenantId: admin.tenantId,
          kind: 'RECEIPT',
          sourceType: 'commerce.receipt',
          sourceId: receiptLineId1,
        },
      })
    ).toBe(1);
    expect(
      await commerceDb().inventoryPostingAttempt.count({
        where: { tenantId: admin.tenantId, postingId: posting1.id },
      })
    ).toBe(1);
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(ORDERED_QTY);

    // 3. The ledger's OWN last line of defence, read from the database rather than
    //    trusted: the `(tenantId, sourceType, sourceId, kind)` composite unique refuses
    //    the movement the first attempt already wrote.
    const source = await inventoryDb().stockMovement.findFirst({ where: { id: movementId1 } });
    if (!source) throw new Error('[E2E] the movement the first receipt posted is absent');
    const refused = await inventoryDb()
      .stockMovement.create({
        data: {
          id: randomUUID(),
          tenantId: source.tenantId,
          kind: source.kind,
          itemId: source.itemId,
          warehouseId: source.warehouseId,
          locationId: source.locationId,
          quantity: source.quantity,
          unit: source.unit,
          baseQuantity: source.baseQuantity,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          recordedByUserId: source.recordedByUserId,
        },
      })
      .then(
        () => null,
        (error: unknown) => error as { code?: string }
      );
    expect(refused?.code).toBe('P2002');
  });
  it('G. a compensating line posts the OUTBOUND movement and decrements the same cell', async () => {
    const compensation: SupertestResponse = await api()
      .post(`${receiptsUrl(docA.id)}/${receiptLineId2}/compensate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ quantity: COMPENSATION_QTY, reason: `R-10 e2e correction ${RUN_ID}` });
    expect({ status: compensation.status, body: compensation.body }).toMatchObject({ status: 201 });
    const compensatingLine = (compensation.body as ReceiptView).lines[0];
    expect(compensatingLine.purchaseLineId).toBe(lineA.id);
    // The stored compensation is the exact NEGATION of the stated magnitude.
    expect(Number(compensatingLine.quantity)).toBe(-COMPENSATION_QTY);

    const posting = await postingFor(compensatingLine.id);
    if (!posting) {
      throw new Error('[E2E] the compensating receipt line planned no inventory posting');
    }
    expect(posting).toMatchObject({
      kind: 'RECEIPT_COMPENSATION',
      sourceLineId: compensatingLine.id,
      status: 'POSTED',
      itemId: itemIdA,
      warehouseId: warehouseIdA,
      locationId: '',
      unit: BASE_UNIT,
      attempts: 1,
      lastError: null,
    });
    expect(Number(posting.quantity)).toBe(COMPENSATION_QTY);

    // The OUTBOUND ledger row: kind ISSUE, its own source family, the same cell.
    const movement = await inventoryDb().stockMovement.findFirst({
      where: { id: posting.movementId ?? '' },
    });
    expect(movement).toMatchObject({
      tenantId: admin.tenantId,
      kind: 'ISSUE',
      itemId: itemIdA,
      warehouseId: warehouseIdA,
      sourceType: 'commerce.receipt-compensation',
      sourceId: compensatingLine.id,
      recordedByUserId: admin.userId,
    });
    expect(Number(String(movement?.baseQuantity))).toBe(-COMPENSATION_QTY);
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(
      ORDERED_QTY - COMPENSATION_QTY
    );

    // The projection subtracts the correction, so the line is no longer fully received.
    const corrected = await receivingLineOf(docA.id, lineA.id);
    expect(Number(corrected.orderedQuantity)).toBe(ORDERED_QTY);
    expect(Number(corrected.receivedQuantity)).toBe(ORDERED_QTY - COMPENSATION_QTY);
    expect(corrected.receivingStatus).toBe('PARTIALLY_RECEIVED');
  });

  it('H. Finance accepts the check request naming the real order number, and stores it', async () => {
    const created: SupertestResponse = await api()
      .post(checkRequestsUrl)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: docA.documentNumber,
      });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 });

    expect(created.body as CheckRequestView).toMatchObject({
      // The wire's `status` is the state machine's ORDINAL (the column is an Int and the
      // closed set lives in `check-request-status.ts`), not a label — asserted through the
      // SAME constant the Financial service writes, never a re-typed literal.
      status: CHECK_REQUEST_STATUS.DRAFT,
      checkIssueType: 'PURCHASE',
      orderReference: docA.documentNumber,
    });

    // Stored in `finance_db`, in this tenant, against this requester.
    const stored = await financeDb().checkRequest.findFirst({
      where: { id: (created.body as CheckRequestView).id },
    });
    expect(stored).toMatchObject({
      tenantId: admin.tenantId,
      status: CHECK_REQUEST_STATUS.DRAFT,
      orderReference: docA.documentNumber,
      purchaseType: 'NON_PROJECT',
      checkIssueType: 'PURCHASE',
    });
    expect(String(stored?.requesterUserId)).toBe(admin.userId);
  });
  it('I. Finance refuses an unknown order number, a missing one, and another tenant’s', async () => {
    const unknown: SupertestResponse = await api()
      .post(checkRequestsUrl)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: `NO-SUCH-ORDER-${RUN_ID}`,
      });
    expect({ status: unknown.status, body: unknown.body }).toMatchObject({ status: 400 });
    expect((unknown.body as { code?: string }).code).toBe('CHECK_REQUEST_ORDER_REFERENCE_UNKNOWN');

    const missing: SupertestResponse = await api()
      .post(checkRequestsUrl)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ checkIssueType: 'PURCHASE', purchaseType: 'NON_PROJECT' });
    expect({ status: missing.status, body: missing.body }).toMatchObject({ status: 400 });
    expect((missing.body as { code?: string }).code).toBe('CHECK_REQUEST_ORDER_REFERENCE_REQUIRED');

    // Tenant B naming tenant A's REAL number: the port is tenant-scoped, so this is the
    // same refusal an absent order receives — never "you may not see it", and never a
    // stored pointer into another tenant's procurement.
    const foreign: SupertestResponse = await api()
      .post(checkRequestsUrl)
      .set('Authorization', `Bearer ${tenantBAdmin.token}`)
      .send({
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: docA.documentNumber,
      });
    expect({ status: foreign.status, body: foreign.body }).toMatchObject({ status: 400 });
    expect((foreign.body as { code?: string }).code).toBe('CHECK_REQUEST_ORDER_REFERENCE_UNKNOWN');

    // No refusal stored anything for the second tenant.
    expect(
      await financeDb().checkRequest.count({ where: { tenantId: tenantBAdmin.tenantId } })
    ).toBe(0);
  });

  it('J. the authorization layer is real: anonymous 401, role-less 403 on both write surfaces', async () => {
    const anonymous: SupertestResponse = await api()
      .post(receiptsUrl(docA.id))
      .send({ lines: [{ purchaseLineId: lineA.id, quantity: 1, warehouseId: warehouseIdA }] });
    expect(anonymous.status).toBe(401);

    const forbidden: SupertestResponse = await api()
      .post(receiptsUrl(docA.id))
      .set('Authorization', `Bearer ${noRole.token}`)
      .send({ lines: [{ purchaseLineId: lineA.id, quantity: 1, warehouseId: warehouseIdA }] });
    expect(forbidden.status).toBe(403);

    const forbiddenRetry: SupertestResponse = await api()
      .post(postingsUrl(`/${posting1.id}/retry`))
      .set('Authorization', `Bearer ${noRole.token}`);
    expect(forbiddenRetry.status).toBe(403);

    // The refusals changed nothing at all.
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(
      ORDERED_QTY - COMPENSATION_QTY
    );
  });
  it('K. tenant B runs the same flow into ITS OWN rows, and cannot reach tenant A’s', async () => {
    const catalogue = await createCatalogue(
      tenantBAdmin,
      skuB,
      `${WAREHOUSE_CODE_PREFIX}B-${RUN_ID}`
    );
    warehouseIdB = catalogue.warehouseId;
    itemIdB = catalogue.itemId;
    docB = await createStockedDocument(tenantBAdmin, skuB);

    const receipt = await appendReceipt(
      docB.id,
      docB.lines[0].id,
      TENANT_B_RECEIPT_QTY,
      warehouseIdB,
      tenantBAdmin
    );
    const postingB = await commerceDb().inventoryPosting.findFirst({
      where: { tenantId: tenantBAdmin.tenantId, sourceLineId: receipt.lines[0].id },
    });
    if (!postingB) throw new Error('[E2E] tenant B posted no inventory posting');
    expect(postingB).toMatchObject({
      tenantId: tenantBAdmin.tenantId,
      kind: 'RECEIPT',
      status: 'POSTED',
      itemId: itemIdB,
      warehouseId: warehouseIdB,
      unit: BASE_UNIT,
      attempts: 1,
    });

    const movementB = await inventoryDb().stockMovement.findFirst({
      where: { id: postingB.movementId ?? '' },
    });
    expect(movementB).toMatchObject({
      tenantId: tenantBAdmin.tenantId,
      kind: 'RECEIPT',
      itemId: itemIdB,
      warehouseId: warehouseIdB,
      sourceType: 'commerce.receipt',
      sourceId: receipt.lines[0].id,
    });
    expect(await onHandOf(tenantBAdmin.tenantId, itemIdB, warehouseIdB)).toBe(TENANT_B_RECEIPT_QTY);
    // A's stock is untouched by B's traffic.
    expect(await onHandOf(admin.tenantId, itemIdA, warehouseIdA)).toBe(
      ORDERED_QTY - COMPENSATION_QTY
    );

    // B cannot retry A's posting — 404, because absent and foreign are the same answer.
    const foreignRetry: SupertestResponse = await api()
      .post(postingsUrl(`/${posting1.id}/retry`))
      .set('Authorization', `Bearer ${tenantBAdmin.token}`);
    expect(foreignRetry.status).toBe(404);

    // ...and neither queue contains the other tenant's rows.
    const aQueue: SupertestResponse = await api()
      .get(postingsUrl('?status=POSTED'))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const aIds = ((aQueue.body as { postings: PostingView[] }).postings ?? []).map((row) => row.id);
    expect(aIds).toContain(posting1.id);
    expect(aIds).toContain(posting2.id);
    expect(aIds).not.toContain(postingB.id);

    const bQueue: SupertestResponse = await api()
      .get(postingsUrl('?status=POSTED'))
      .set('Authorization', `Bearer ${tenantBAdmin.token}`)
      .expect(200);
    const bIds = ((bQueue.body as { postings: PostingView[] }).postings ?? []).map((row) => row.id);
    expect(bIds).toContain(postingB.id);
    expect(bIds).not.toContain(posting1.id);

    // B's balance read never shows A's item, and A's never shows B's.
    const bBalances: SupertestResponse = await api()
      .get(`${API_PREFIX}/inventory/stock/balances?itemId=${itemIdA}`)
      .set('Authorization', `Bearer ${tenantBAdmin.token}`)
      .expect(200);
    expect(itemsOf<BalanceRowView>(bBalances.body)).toHaveLength(0);
    const aBalances: SupertestResponse = await api()
      .get(`${API_PREFIX}/inventory/stock/balances?itemId=${itemIdB}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(itemsOf<BalanceRowView>(aBalances.body)).toHaveLength(0);

    // The bridge agrees with the HTTP refusal — but the reference has to be one the
    // NUMBERING strategy can answer. `PurchaseDocumentCounter` is unique on
    // `(tenantId, kind, jalaliYear)` and starts at 1, so each tenant's FIRST request of a
    // kind and year is `PR-1405-00001` in ITS OWN series: this run's B minted exactly that
    // number above, and `findOrderReference` is tenant-FIRST, so B naming that string
    // resolves B's OWN row. "A's number never resolves for B" is false by design whenever
    // the two series overlap — what the port must never do is CROSS tenants, and that is
    // what this asserts: on A's row id, and on an A number B's series cannot hold.
    const bridge = getApp().get<unknown>(
      PURCHASE_ORDER_REFERENCE_PORT
    ) as PurchaseOrderReferencePort;

    // B's own number resolves to B's own document — the shared number is legal, not a leak.
    expect(await bridge.resolve(tenantBAdmin.tenantId, docB.documentNumber)).toMatchObject({
      orderReference: docB.documentNumber,
      displayName: docB.documentNumber,
    });

    // A's row id is invisible to B (the id branch is tenant-scoped like every read here)...
    expect(await bridge.resolve(tenantBAdmin.tenantId, docA.id)).toBeNull();
    // ...and so is an A number B never issued: A's SECOND request of this kind and year,
    // which cannot be B's first — `docA` already took number 1 of A's series in this run.
    const docA2 = await createStockedDocument(admin, skuA);
    expect(docA2.documentNumber).not.toBe(docB.documentNumber);
    expect(await bridge.resolve(tenantBAdmin.tenantId, docA2.documentNumber)).toBeNull();

    // A resolves its own two references — by id and by number — and the issued number is
    // what `displayName` renders (the id branch echoes the id back as `orderReference`).
    expect(await bridge.resolve(admin.tenantId, docA.id)).toMatchObject({
      orderReference: docA.id,
      displayName: docA.documentNumber,
    });
    expect(await bridge.resolve(admin.tenantId, docA2.documentNumber)).toMatchObject({
      orderReference: docA2.documentNumber,
      displayName: docA2.documentNumber,
    });
  });
});
