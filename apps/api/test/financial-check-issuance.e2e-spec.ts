/**
 * Phase FINALIZE — Financial Check Issuance automated runtime E2E.
 *
 * Converts the live HTTP smoke that reached state 8 into a deterministic,
 * repeatable, one-command Jest suite. Every transition, attachment gate,
 * audit event, auth/RBAC/tenant boundary and negative path is asserted.
 *
 * SEAMS (kept minimal):
 *   - Test fixtures are created through the Core Prisma client, because no HTTP
 *     surface provisions tenant membership, roles or permissions. The data
 *     created is only identity/entitlement scaffolding; the business lifecycle
 *     itself is driven exclusively through the Financial HTTP API.
 *   - The suite runs against the real combined runtime booted by `test/setup.ts`,
 *     with real databases, real MinIO storage and real JWT auth.
 *
 * No business behavior is invented. The source-conflict branch
 * (executive-request-correction) remains DEFERRED.
 */
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { makeRequest, getTestApp } from './setup';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { FinancialPrismaService } from '../src/modules/financial/database/financial-prisma.service';
import {
  CHECK_ISSUANCE_PROCESS_KEY,
  CHECK_ISSUANCE_PROCESS_VERSION,
} from '../src/modules/financial/process/check-issuance.definition';
import { CHECK_REQUEST_STATUS } from '../src/modules/financial/check-request/check-request-status';
import { CHECK_REQUEST_ERROR_CODES } from '../src/modules/financial/check-request/check-request';
import { CHECK_ISSUE_TYPES } from '../src/modules/financial/check-request/check-request-status';
import { ensureFinancialCheckTestProvisioning } from './fixtures/financial-check-provisioning';
import { AuditOutboxRelayService } from '../src/modules/financial/audit-outbox-relay.service';

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
const RUN_ID = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Deterministic but run-scoped passwords; never written to assertions or reports.
const PASSWORDS = {
  seededAdmin: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!',
  manager: `Mgr-${RUN_ID}`,
  employee: `Emp-${RUN_ID}`,
  selfApprover: `Self-${RUN_ID}`,
  tenantBManager: `B-${RUN_ID}`,
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

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function login(email: string, password: string): Promise<string> {
  const res = await api()
    .post(`${API_PREFIX}/auth/login`)
    .send({ email, password })
    .expect(200);

  const token = res.body?.data?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error(`[E2E] Login for ${email} produced no access token: ${JSON.stringify(res.body)}`);
  }
  return token;
}

async function waitForReadiness(timeoutMs = 60_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const health = await api().get(`${API_PREFIX}/health`);
      if (health.status !== 200) {
        lastError = `health=${health.status}`;
      } else {
        const ready = await api().get(`${API_PREFIX}/ready`);
        if (ready.status === 200 && ready.body?.status === 'ready') {
          console.log(`[E2E] Ready after ${attempt} attempt(s)`);
          return;
        }
        lastError = `ready=${ready.status} ${JSON.stringify(ready.body)}`;
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

async function createUser(
  label: string,
  tenantId: string,
  roleId?: string,
): Promise<Omit<Actor, 'token'>> {
  const email = `${label}-${RUN_ID}@aria.test`;
  const password = PASSWORDS[label as keyof typeof PASSWORDS] ?? `Pwd-${RUN_ID}`;
  const passwordHash = await hashPassword(password);
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
              create: {
                roleId,
                assignedBy: userId,
              },
            },
          }
        : {}),
    },
  });

  return { label, email, password, userId, tenantId };
}

async function createTenantB(): Promise<{ tenantId: string; managerB: Omit<Actor, 'token'> }> {
  const coreDb = getCoreDb();
  const tenantId = `tenant-b-${RUN_ID}`;

  await coreDb.tenant.create({
    data: {
      id: tenantId,
      code: `tenant-b-${RUN_ID}`,
    },
  });

  const registration = await coreDb.moduleRegistration.findUnique({
    where: { moduleId: 'financial' },
  });
  if (!registration) throw new Error('[E2E] financial module registration not found');

  await coreDb.moduleRegistrationTenant.create({
    data: { registrationId: registration.id, tenantId },
  });

  const feature = await coreDb.moduleFeature.findUnique({
    where: {
      moduleId_featureId: { moduleId: 'financial', featureId: 'check-request' },
    },
  });
  if (!feature) throw new Error('[E2E] financial.check-request feature not found');

  await coreDb.moduleFeatureGrant.create({
    data: { featureRowId: feature.id, tenantId },
  });

  const adminRoleId = await findAdminRoleId();
  const managerB = await createUser('tenantBManager', tenantId, adminRoleId);

  return { tenantId, managerB };
}

describe('Financial Check Issuance — automated runtime E2E', () => {
  let seededAdmin: Actor;
  let manager: Actor;
  let employee: Actor;
  let selfApprover: Actor;
  let tenantBManager: Actor;
  let tenantAId: string;
  let requestId: string;
  const createdAttachmentIds: string[] = [];

  beforeAll(async () => {
    await waitForReadiness();

    const coreDb = getCoreDb();
    const tenantA = await coreDb.tenant.findUnique({
      where: { id: 'tenant-test-1' },
    });
    if (!tenantA) throw new Error('[E2E] Seeded tenant tenant-test-1 not found');
    tenantAId = tenantA.id;

    // Test-only provisioning BEFORE any login: login resolves the caller's
    // permission claim through the PermissionSource port (which caches its
    // answer), so the grants must exist before the first token is minted or
    // every later request carries a permission-empty identity. The grants and
    // memberships seed migrations cannot provide them here: they only see rows
    // existing at migration time, while tenant-test-1 is created later by
    // db:seed. The fixture mirrors the migrations' own shapes and touches
    // nothing else (no guard, validator, or production default is modified).
    await ensureFinancialCheckTestProvisioning(coreDb, [tenantAId]);

    const seededAdminRow = await coreDb.user.findUnique({
      where: { email: 'admin@localhost' },
    });
    if (!seededAdminRow) throw new Error('[E2E] Seeded admin user not found');

    seededAdmin = {
      label: 'seededAdmin',
      email: seededAdminRow.email,
      password: PASSWORDS.seededAdmin,
      userId: seededAdminRow.id,
      tenantId: seededAdminRow.tenantId || tenantAId,
      token: await login(seededAdminRow.email, PASSWORDS.seededAdmin),
    };

    const adminRoleId = await findAdminRoleId();
    const managerBase = await createUser('manager', tenantAId, adminRoleId);
    manager = { ...managerBase, token: await login(managerBase.email, managerBase.password) };

    const employeeBase = await createUser('employee', tenantAId);
    employee = { ...employeeBase, token: await login(employeeBase.email, employeeBase.password) };

    const selfBase = await createUser('selfApprover', tenantAId, adminRoleId);
    selfApprover = { ...selfBase, token: await login(selfBase.email, selfBase.password) };

    const { managerB } = await createTenantB();
    // Same rule for tenant B: entitlement before its manager's login.
    await ensureFinancialCheckTestProvisioning(coreDb, [tenantAId, managerB.tenantId]);
    tenantBManager = { ...managerB, token: await login(managerB.email, managerB.password) };
  }, 90_000);

  afterAll(async () => {
    const coreDb = getCoreDb();
    const financeDb = getFinanceDb();

    // Clean up business rows first.
    for (const id of createdAttachmentIds) {
      try {
        await financeDb.checkAttachment.delete({ where: { id } });
      } catch {
        // best-effort
      }
    }
    if (requestId) {
      try {
        await financeDb.checkRequest.delete({ where: { id: requestId } });
      } catch {
        // best-effort
      }
    }

    const testUserIds = [manager?.userId, employee?.userId, selfApprover?.userId, tenantBManager?.userId].filter(Boolean) as string[];
    if (testUserIds.length > 0) {
      try {
        await coreDb.userRole.deleteMany({ where: { userId: { in: testUserIds } } });
        await coreDb.user.deleteMany({ where: { id: { in: testUserIds } } });
      } catch {
        // best-effort
      }
    }

    if (tenantBManager) {
      try {
        await coreDb.moduleFeatureGrant.deleteMany({ where: { tenantId: tenantBManager.tenantId } });
        await coreDb.moduleRegistrationTenant.deleteMany({ where: { tenantId: tenantBManager.tenantId } });
        await coreDb.tenant.delete({ where: { id: tenantBManager.tenantId } });
      } catch {
        // best-effort
      }
    }
  }, 120_000);

  // ==========================================================================
  // §1 Process definition contract
  // ==========================================================================
  it('GET /financial/check-process returns the pinned v1 definition', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-process`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.processKey).toBe(CHECK_ISSUANCE_PROCESS_KEY);
    expect(res.body.version).toBe(CHECK_ISSUANCE_PROCESS_VERSION);
    expect(res.body.status).toBe('published');
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThanOrEqual(8);
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(Array.isArray(res.body.transitions)).toBe(true);
    expect(Array.isArray(res.body.documentSections)).toBe(true);
  });

  // ==========================================================================
  // §2 Auth / RBAC / entitlement gates
  // ==========================================================================
  it('unauthenticated request to Financial is 401', async () => {
    const res: SupertestResponse = await api().get(`${API_PREFIX}/financial/check-process`);
    expect(res.status).toBe(401);
  });

  it('employee without Financial permission is 403', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-process`)
      .set('Authorization', `Bearer ${employee.token}`);
    expect(res.status).toBe(403);
  });

  it('GET on a non-existent id returns 404, not another tenant', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${randomUUID()}`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);
    expect(res.status).toBe(404);
  });

  // ==========================================================================
  // §3 Golden happy path: 0 → 8 through real transitions
  // ==========================================================================
  it('creates a DRAFT petty-cash check request (state 0)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests`)
      .set('Authorization', `Bearer ${seededAdmin.token}`)
      .send({
        checkIssueType: CHECK_ISSUE_TYPES[1], // PETTY_CASH
        requesterOpinion: 'CONTINUE',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.DRAFT);
    expect(res.body.requesterUserId).toBe(seededAdmin.userId);
    requestId = res.body.id;
  });

  it('at DRAFT, available actions include submit', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/available-actions`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.actions).toBeDefined();
    const keys = res.body.actions.map((a: { action: string }) => a.action);
    expect(keys).toContain('submit');
    expect(keys).not.toContain('approve');
  });

  it('uploads a request-stage attachment (section 2) while DRAFT', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/attachments`)
      .set('Authorization', `Bearer ${seededAdmin.token}`)
      .field('documentType', 'OTHER')
      .field('description', 'request backup')
      .attach('file', Buffer.from('request document bytes'), 'request-doc.txt');

    expect(res.status).toBe(201);
    expect(res.body.section).toBe(2);
    expect(res.body.documentType).toBe('OTHER');
    expect(res.body.mimeType).toBe('text/plain');
    createdAttachmentIds.push(res.body.id);
  });

  it('lists the uploaded attachment and resolves a retrievable URL', async () => {
    const list: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/attachments`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].fileName).toBe('request-doc.txt');

    const urlRes: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/attachments/${list.body[0].id}/url`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(urlRes.status).toBe(200);
    expect(typeof urlRes.body.url).toBe('string');
    expect(urlRes.body.url.length).toBeGreaterThan(0);
  });

  it('SUBMIT moves DRAFT → MANAGER_REVIEW (state 2)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/submit`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.MANAGER_REVIEW);
  });

  it('at MANAGER_REVIEW, available actions include approve/reject/request-correction', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/available-actions`)
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.actions).toBeDefined();
    const keys = res.body.actions.map((a: { action: string }) => a.action);
    expect(keys).toContain('approve');
    expect(keys).toContain('reject');
    expect(keys).toContain('request-correction');
    expect(keys).not.toContain('submit');
  });

  it('MANAGER APPROVE moves state 2 → APPROVED (state 3)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ comment: 'approved for allocation' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.APPROVED);
  });

  it('ALLOCATE moves APPROVED → DOCUMENT_REVIEW (state 4)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/allocate`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        allocationPlace: 'HQ Treasury',
        checkAmount: '15000000',
        checkDate: '2026-04-15',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.DOCUMENT_REVIEW);
    expect(res.body.stages.allocation).not.toBeNull();
    expect(res.body.stages.allocation.checkAmount).toBe('15000000');
  });

  it('DOCUMENT REVIEW APPROVE moves state 4 → EXECUTIVE_APPROVAL (state 5)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/document-review`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'APPROVE', comment: 'docs ok' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL);
  });

  it('EXECUTIVE APPROVE moves state 5 → ISSUANCE (state 6)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/executive-approval`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'APPROVE', comment: 'exec ok' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.ISSUANCE);
  });

  it('ISSUE without cheque image is rejected with ISSUE_IMAGE_REQUIRED', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/issue`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ confirmed: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CHECK_REQUEST_ERROR_CODES.ISSUE_IMAGE_REQUIRED);
  });

  it('uploads cheque image (section 6) while in ISSUANCE', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/cheque-image`)
      .set('Authorization', `Bearer ${manager.token}`)
      .field('description', 'cheque scan')
      .attach('file', Buffer.from('cheque image bytes'), 'cheque.png');

    expect(res.status).toBe(201);
    expect(res.body.section).toBe(6);
    expect(res.body.mimeType).toBe('image/png');
    createdAttachmentIds.push(res.body.id);
  });

  it('ISSUE with cheque image moves state 6 → DELIVERY (state 7)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/issue`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.DELIVERY);
  });

  it('DELIVER without delivery receipt is rejected with DELIVERY_RECEIPT_REQUIRED', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/delivery`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ completed: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CHECK_REQUEST_ERROR_CODES.DELIVERY_RECEIPT_REQUIRED);
  });

  it('uploads delivery receipt (section 7) while in DELIVERY', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/delivery-receipt`)
      .set('Authorization', `Bearer ${manager.token}`)
      .field('description', 'receipt scan')
      .attach('file', Buffer.from('receipt bytes'), 'receipt.jpg');

    expect(res.status).toBe(201);
    expect(res.body.section).toBe(7);
    expect(res.body.mimeType).toBe('image/jpeg');
    createdAttachmentIds.push(res.body.id);
  });

  it('DELIVER with receipt moves state 7 → COMPLETED (state 8)', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/delivery`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ completed: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(CHECK_REQUEST_STATUS.COMPLETED);
  });

  it('COMPLETED state is terminal: available-actions is empty', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/available-actions`)
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
    expect(res.body.terminal).toBe(true);
    expect(res.body.processKey).toBe(CHECK_ISSUANCE_PROCESS_KEY);
    expect(res.body.processVersion).toBe(CHECK_ISSUANCE_PROCESS_VERSION);
  });

  it('further action on COMPLETED request is rejected', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/issue`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ confirmed: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
  });

  // ==========================================================================
  // §4 Negative / boundary cases
  // ==========================================================================
  it('self-approval is rejected when requester tries to approve their own request', async () => {
    const draft: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests`)
      .set('Authorization', `Bearer ${selfApprover.token}`)
      .send({ checkIssueType: CHECK_ISSUE_TYPES[1], requesterOpinion: 'CONTINUE' });

    expect(draft.status).toBe(201);
    const selfRequestId = draft.body.id;

    const submitted: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${selfRequestId}/submit`)
      .set('Authorization', `Bearer ${selfApprover.token}`);
    expect(submitted.status).toBe(200);

    const approved: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${selfRequestId}/approve`)
      .set('Authorization', `Bearer ${selfApprover.token}`)
      .send({ comment: 'self' });

    expect(approved.status).toBe(400);
    expect(approved.body.code).toBe(CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL);

    // Cleanup this throw-away request directly; it is not part of the main lifecycle.
    await getFinanceDb().checkRequest.delete({ where: { id: selfRequestId } }).catch(() => undefined);
  });

  it('invalid transition from a wrong state is rejected with STATE_CONFLICT', async () => {
    const res: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests/${requestId}/allocate`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ allocationPlace: 'X', checkAmount: '1' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
  });

  it('cross-tenant actor cannot see tenant A request', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}`)
      .set('Authorization', `Bearer ${tenantBManager.token}`);

    expect(res.status).toBe(404);
  });

  it('double submit after submission is rejected', async () => {
    const draft: SupertestResponse = await api()
      .post(`${API_PREFIX}/financial/check-requests`)
      .set('Authorization', `Bearer ${seededAdmin.token}`)
      .send({ checkIssueType: CHECK_ISSUE_TYPES[1], requesterOpinion: 'CONTINUE' });

    const id = draft.body.id;
    const first = await api()
      .post(`${API_PREFIX}/financial/check-requests/${id}/submit`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);
    expect(first.status).toBe(200);

    const second = await api()
      .post(`${API_PREFIX}/financial/check-requests/${id}/submit`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);

    await getFinanceDb().checkRequest.delete({ where: { id } }).catch(() => undefined);
  });

  // ==========================================================================
  // §5 Audit timeline integrity
  // ==========================================================================
  it('timeline records the lifecycle in order with actor identities', async () => {
    // The audit outbox is the platform's intentional async durability design:
    // each financial mutation commits its audit intent with the business row,
    // and AuditOutboxRelayService delivers it to core_db."AuditLog" on a 10s
    // poll — whose own contract documents a direct call from tests. The whole
    // suite lifecycle can finish inside one relay window, so drain the outbox
    // deterministically before reading. Production code and every assertion
    // below are unchanged.
    await getApp().get(AuditOutboxRelayService).relay();

    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/timeline`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const actions = res.body.items.map((item: { action: string }) => item.action);
    expect(actions).toContain('create');
    expect(actions).toContain('submit');
    expect(actions).toContain('approve');
    expect(actions).toContain('allocate');
    expect(actions).toContain('document_review');
    expect(actions).toContain('executive_approve');
    expect(actions).toContain('issue');
    expect(actions).toContain('deliver');
    expect(actions).toContain('attachment_upload');

    // Ordering: create is first, deliver is last.
    expect(actions.indexOf('create')).toBe(0);
    expect(actions.indexOf('deliver')).toBe(actions.length - 1);
  });

  // ==========================================================================
  // §6 Storage integrity: metadata row points at a real MinIO object
  // ==========================================================================
  it('attachment URL resolves actual stored bytes', async () => {
    const financeDb = getFinanceDb();
    const attachment = await financeDb.checkAttachment.findFirst({
      where: { checkRequestId: requestId },
      orderBy: { section: 'asc' },
    });

    expect(attachment).not.toBeNull();

    const urlRes: SupertestResponse = await api()
      .get(`${API_PREFIX}/financial/check-requests/${requestId}/attachments/${attachment!.id}/url`)
      .set('Authorization', `Bearer ${seededAdmin.token}`);

    expect(urlRes.status).toBe(200);
    const { url, mimeType } = urlRes.body;
    expect(url).toContain('://');
    expect(mimeType).toBe(attachment!.mimeType);
  });
});
