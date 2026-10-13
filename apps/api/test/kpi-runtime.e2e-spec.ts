/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the KPI history/comparison surface against the
 * real combined runtime:
 *
 *   authenticated reader
 *        ↓
 *   KPI routes (`/api/v1/kpis…` incl. `/:key/history`)
 *        ↓
 *   approved Production read seam → real `production_db` rows
 *        ↓
 *   chronological history → comparison → supporting-report drill-down
 *
 * Covered (phase brief §39): historical results for an ELAPSED KPI (KPI-001) and a
 * PERCENTAGE KPI (KPI-002), an available period-over-period comparison, a zero
 * denominator (EMPTY_DENOMINATOR — rows exist, none terminal), an unavailable period
 * (EMPTY_COHORT — never zero-filled), oversized/inverted range rejection with closed
 * codes, tenant isolation in BOTH directions, 401, 403, candidate-KPI rejection, and
 * the supporting-report link resolving to a real entitled report route.
 *
 * SEAMS: identity/entitlement fixtures are created through the Core Prisma client;
 * the BOMs are driven through the Production HTTP API (the writer side); the KPI
 * history is read exclusively through the KPI HTTP API — the slice under test.
 *
 * BACKDATING IS A FIXTURE SEAM, AND AN EXPLICIT ONE: every decide route stamps
 * `decidedAt = new Date()`, so a row's INSTANT can only be moved by re-stamping the
 * column through the Production Prisma client after the HTTP act completed. The
 * lifecycle (create → item → submit → decide) is real; only the clock of past months
 * is authored. Nothing in the KPI read path touches Prisma directly — that is the
 * whole point of the seam this suite exercises.
 *
 * DETERMINISM: all assertions run inside FRESH tenants created per run, so rows from
 * other suites (or earlier runs) can never shift a mean, a rate, or a cohort count.
 */
import * as bcrypt from 'bcryptjs';
import { makeRequest, getTestApp } from './setup';
import { PrismaService as CorePrismaService } from '../src/database/prisma.service';
import { ProductionPrismaService } from '../src/modules/production/database/production-prisma.service';
import { KPI_CATALOG } from '../src/kpi/kpi-catalog';
import { currentJalaliMonth, kpiPeriodWindow } from '../src/modules/kpi-runtime/kpi-runtime.period';
import { previousJalaliMonth } from '../src/modules/kpi-runtime/kpi-runtime.history';

type SupertestResponse = import('supertest').Response;

const API_PREFIX = '/api/v1';
const RUN_ID = `kpihist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HOUR_MS = 3_600_000;

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

function getProductionDb(): ProductionPrismaService {
  return getApp().get(ProductionPrismaService);
}

/** The KPI/reporting controllers serve the payload directly — `data` only when enveloped. */
function envelope<T>(body: { data?: T } | T): T {
  return (body as { data?: T }).data ?? (body as T);
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

interface Actor {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  token: string;
}

async function createUser(
  label: string,
  tenantId: string,
  roleId?: string
): Promise<{ email: string; password: string; userId: string; tenantId: string }> {
  const email = `${label.toLowerCase()}-${RUN_ID}@kpi-e2e.local`;
  const password = `Pwd-${RUN_ID}`;
  const userId = `user-${label}-${RUN_ID}`;
  const passwordHash = await bcrypt.hash(password, 12);

  await getCoreDb().user.create({
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

  return { email, password, userId, tenantId };
}

async function login(email: string, password: string): Promise<string> {
  const res = await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(200);
  const token = res.body?.data?.accessToken ?? res.body?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error(`[E2E] Login for ${email} produced no access token`);
  }
  return token;
}

async function withToken(base: {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
}): Promise<Actor> {
  return { ...base, token: await login(base.email, base.password) };
}

/** A fresh tenant entitled to `production`/`bom` — the isolation boundary per run. */
async function setupProductionTenant(prefix: string): Promise<{ tenantId: string }> {
  const db = getCoreDb();
  const tenantId = `tenant-${prefix}-${RUN_ID}`;
  await db.tenant.create({ data: { id: tenantId, code: `tenant-${prefix}-${RUN_ID}` } });

  const registration = await db.moduleRegistration.findUnique({
    where: { moduleId: 'production' },
  });
  if (!registration) throw new Error('[E2E] production module registration not found');
  await db.moduleRegistrationTenant.create({ data: { registrationId: registration.id, tenantId } });

  const feature = await db.moduleFeature.findUnique({
    where: { moduleId_featureId: { moduleId: 'production', featureId: 'bom' } },
  });
  if (!feature) throw new Error('[E2E] production.bom feature not found');
  await db.moduleFeatureGrant.create({ data: { featureRowId: feature.id, tenantId } });

  return { tenantId };
}

async function teardownTenant(tenantId: string, userIds: string[]): Promise<void> {
  const db = getCoreDb();
  try {
    // The Production rows are run-scoped (this tenant id never existed before); best
    // effort, mirroring the reporting suites' convention for their own authored rows.
    const production = getProductionDb();
    await production.bomHeader.deleteMany({ where: { tenantId } }).catch(() => undefined);
  } catch {
    // production client unavailable — core cleanup below still runs
  }
  await db.moduleFeatureGrant.deleteMany({ where: { tenantId } }).catch(() => undefined);
  await db.moduleRegistrationTenant.deleteMany({ where: { tenantId } }).catch(() => undefined);
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
}

/** One BOM through the Production HTTP API — the writer side, exactly as a user drives it. */
async function createBom(
  token: string,
  input: {
    title: string;
    projectRef: string;
    productTreeRef: string;
    requesterUserId: string;
    approverUserId: string;
  }
): Promise<string> {
  const res: SupertestResponse = await api()
    .post(`${API_PREFIX}/production/boms`)
    .set('Authorization', `Bearer ${token}`)
    .send(input)
    .expect(201);
  const id = res.body?.data?.id ?? res.body?.id;
  if (!id || typeof id !== 'string') {
    throw new Error(`[E2E] BOM creation produced no id: ${JSON.stringify(res.body)}`);
  }
  return id;
}

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

async function submitBom(token: string, bomId: string): Promise<void> {
  await api()
    .post(`${API_PREFIX}/production/boms/${bomId}/submit`)
    .set('Authorization', `Bearer ${token}`)
    .send({})
    .expect(200);
}

async function decideBom(
  token: string,
  bomId: string,
  action: 'approve' | 'reject' | 'request-correction',
  opinion: 'APPROVED' | 'REJECTED' | 'NEEDS_CORRECTION'
): Promise<void> {
  await api()
    .post(`${API_PREFIX}/production/boms/${bomId}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ opinion })
    .expect(200);
}

/**
 * Full lifecycle (create → item → submit → decide) and the authored instants.
 *
 * The HTTP act decides the row; the two instants are then re-stamped INTO the named
 * month's window (`start + offset`) through the Production Prisma client — the only
 * way to place a decided row in a past month when every writer stamps `new Date()`.
 */
async function createDecidedBom(options: {
  admin: Actor;
  approver: Actor;
  title: string;
  action: 'approve' | 'reject' | 'request-correction';
  opinion: 'APPROVED' | 'REJECTED' | 'NEEDS_CORRECTION';
  windowStart: Date;
  submittedOffsetHours: number;
  decidedOffsetHours: number;
}): Promise<string> {
  const { admin, approver, title, action, opinion, windowStart } = options;
  const bomId = await createBom(admin.token, {
    title,
    projectRef: `proj-${RUN_ID}`,
    productTreeRef: `tree-${RUN_ID}`,
    requesterUserId: admin.userId,
    approverUserId: approver.userId,
  });
  await addBomItem(admin.token, bomId);
  await submitBom(admin.token, bomId);
  await decideBom(approver.token, bomId, action, opinion);

  const stamp = (hours: number) => new Date(windowStart.getTime() + hours * HOUR_MS);
  await getProductionDb().bomHeader.update({
    where: { id: bomId },
    data: {
      submittedAt: stamp(options.submittedOffsetHours),
      decidedAt: stamp(options.decidedOffsetHours),
    },
  });
  return bomId;
}

describe('KPI historical intelligence — history, comparison, drill-down (real runtime)', () => {
  let roleId: string;

  // Tenant K — the primary fixture tenant.
  let adminK: Actor;
  let approverK: Actor;
  let tenantKId: string;
  // Tenant K2 — the reverse isolation probe (its rows must not leak into K either).
  let adminK2: Actor;
  let approverK2: Actor;
  let tenantK2Id: string;
  // A user with NO roles: the union remit gate must refuse them.
  let noRead: Actor;
  let noReadUserId: string;

  // The four months of the fixture: W (correction-returned), X (empty), P (rejected),
  // C (two approved) — anchored on the server's own current month, never a guess.
  let W: { jy: number; jm: number };
  let X: { jy: number; jm: number };
  let P: { jy: number; jm: number };
  let C: { jy: number; jm: number };

  const kpiUrl = (key: string, suffix = '') => `${API_PREFIX}/kpis/${key}/history${suffix}`;
  const fullRange = () => `?fromJy=${W.jy}&fromJm=${W.jm}&toJy=${C.jy}&toJm=${C.jm}`;

  beforeAll(async () => {
    await waitForReadiness();
    roleId = await findAdminRoleId();

    const k = await setupProductionTenant('kpik');
    tenantKId = k.tenantId;
    adminK = await withToken(await createUser('KAdmin', tenantKId, roleId));
    approverK = await withToken(await createUser('KApprover', tenantKId, roleId));

    const k2 = await setupProductionTenant('kpik2');
    tenantK2Id = k2.tenantId;
    adminK2 = await withToken(await createUser('K2Admin', tenantK2Id, roleId));
    approverK2 = await withToken(await createUser('K2Approver', tenantK2Id, roleId));

    const noReadBase = await createUser('KpiNoRead', 'tenant-test-1');
    noReadUserId = noReadBase.userId;
    noRead = await withToken(noReadBase);

    const now = new Date();
    C = currentJalaliMonth(now);
    P = previousJalaliMonth(C.jy, C.jm);
    X = previousJalaliMonth(P.jy, P.jm);
    W = previousJalaliMonth(X.jy, X.jm);

    const window = (m: { jy: number; jm: number }) => kpiPeriodWindow(m.jy, m.jm).start;

    // Tenant K — every row authored through the HTTP lifecycle, then stamped INTO its month.
    await createDecidedBom({
      admin: adminK,
      approver: approverK,
      title: `KPIW-${RUN_ID}`,
      action: 'request-correction',
      opinion: 'NEEDS_CORRECTION',
      windowStart: window(W),
      submittedOffsetHours: 2,
      decidedOffsetHours: 6,
    });
    await createDecidedBom({
      admin: adminK,
      approver: approverK,
      title: `KPIP-${RUN_ID}`,
      action: 'reject',
      opinion: 'REJECTED',
      windowStart: window(P),
      submittedOffsetHours: 2,
      decidedOffsetHours: 8,
    });
    await createDecidedBom({
      admin: adminK,
      approver: approverK,
      title: `KPIC1-${RUN_ID}`,
      action: 'approve',
      opinion: 'APPROVED',
      windowStart: window(C),
      submittedOffsetHours: 2,
      decidedOffsetHours: 8,
    });
    await createDecidedBom({
      admin: adminK,
      approver: approverK,
      title: `KPIC2-${RUN_ID}`,
      action: 'approve',
      opinion: 'APPROVED',
      windowStart: window(C),
      submittedOffsetHours: 2,
      decidedOffsetHours: 14,
    });

    // Tenant K2 — one approved BOM in the current month: both isolation directions.
    await createDecidedBom({
      admin: adminK2,
      approver: approverK2,
      title: `K2C-${RUN_ID}`,
      action: 'approve',
      opinion: 'APPROVED',
      windowStart: window(C),
      submittedOffsetHours: 2,
      decidedOffsetHours: 6,
    });
  }, 240_000);

  afterAll(async () => {
    await teardownTenant(tenantKId, [adminK.userId, approverK.userId]).catch(() => undefined);
    await teardownTenant(tenantK2Id, [adminK2.userId, approverK2.userId]).catch(() => undefined);
    await getCoreDb()
      .userRole.deleteMany({ where: { userId: noReadUserId } })
      .catch(() => undefined);
    await getCoreDb()
      .user.deleteMany({ where: { id: noReadUserId } })
      .catch(() => undefined);
  }, 60_000);

  it('serves chronological history with honest gaps for the elapsed KPI', async () => {
    const res: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time', fullRange()))
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    const body = envelope(res.body);

    expect(body.periods.map((p) => `${p.jy}/${p.jm}`)).toEqual([
      `${W.jy}/${W.jm}`,
      `${X.jy}/${X.jm}`,
      `${P.jy}/${P.jm}`,
      `${C.jy}/${C.jm}`,
    ]);

    // An unavailable period is a FINDING — carried as NOT_AVAILABLE, never a zero.
    expect(body.items[0]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });
    expect(body.items[1]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });

    // The two real months: 6h rejected in P, mean of 6h+12h = 9h approved in C.
    expect(body.items[2]).toMatchObject({ availability: 'AVAILABLE', value: (6 * HOUR_MS) / 1000 });
    expect(body.items[3]).toMatchObject({ availability: 'AVAILABLE', value: (9 * HOUR_MS) / 1000 });
    expect(body.items[3].display).toMatchObject({ value: 9, unitToken: 'HOURS' });

    // Completed vs partial is explicit: past months ended, the current one has not.
    expect(body.items[2].period.completed).toBe(true);
    expect(body.items[3].period.completed).toBe(false);

    // Both sides through the SAME formula — 9h vs 6h is a comparable pair.
    expect(body.comparison).toMatchObject({
      availability: 'AVAILABLE',
      currentValue: (9 * HOUR_MS) / 1000,
      previousValue: (6 * HOUR_MS) / 1000,
      absoluteChange: (3 * HOUR_MS) / 1000,
      direction: 'INCREASE',
      changeDisplay: { value: 3, unitToken: 'HOURS' },
    });
    expect(body.comparison.relativeChange).toBeCloseTo(0.5, 10);
    expect(body.comparison.currentPeriod.jm).toBe(C.jm);
    expect(body.comparison.previousPeriod.jm).toBe(P.jm);

    // The drill-down names the SOURCE report — not another KPI.
    expect(body.supportingReport).toMatchObject({
      href: '/admin/reporting/production',
      titleFa: 'گزارش عملیات تولید',
    });
  });

  it('answers the percentage KPI per month: points delta, zero previous, no fake ratio', async () => {
    const res: SupertestResponse = await api()
      .get(kpiUrl('production-bom-approval-rate', fullRange()))
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    const body = envelope(res.body);

    // W holds ONLY a correction-returned row: rows exist, none terminal → the
    // governance distinction EMPTY_DENOMINATOR, not a 0% and not an empty month.
    expect(body.items[0]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_DENOMINATOR',
      value: null,
    });
    // X holds nothing at all → the other absence.
    expect(body.items[1]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });
    // P: 0 approvals of 1 decision → 0% is a REAL rate over a real denominator.
    expect(body.items[2]).toMatchObject({ availability: 'AVAILABLE', value: 0 });
    // C: 2 approvals of 2 decisions → 100%.
    expect(body.items[3]).toMatchObject({ availability: 'AVAILABLE', value: 100 });

    // The percentage KPI's primary delta is POINTS; the relative ratio against a zero
    // denominator does not exist — refused, never substituted.
    expect(body.comparison).toMatchObject({
      availability: 'AVAILABLE',
      percentagePointChange: 100,
      relativeChange: null,
      unavailableReason: 'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
      unitSemantic: 'PERCENT',
    });
  });

  it('defaults to the server-bounded six months ending at the current month', async () => {
    const res: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time'))
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    const body = envelope(res.body);

    expect(body.items).toHaveLength(6);
    expect(body.periods[body.periods.length - 1]).toMatchObject({ jy: C.jy, jm: C.jm });
  });

  it('keeps tenant isolation in BOTH directions — every cohort count is the tenant own', async () => {
    // K2 reads only K2: its single current-month row, and K's past month invisible.
    const k2Res: SupertestResponse = await api()
      .get(
        kpiUrl(
          'production-bom-decision-cycle-time',
          `?fromJy=${P.jy}&fromJm=${P.jm}&toJy=${C.jy}&toJm=${C.jm}`
        )
      )
      .set('Authorization', `Bearer ${adminK2.token}`)
      .expect(200);
    const k2Body = envelope(k2Res.body);
    expect(k2Body.items[0]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });
    expect(k2Body.items[1].value).toBe((4 * HOUR_MS) / 1000);
    expect(k2Body.items[1].supportingContext.counts.cohort).toBe(1);

    // K reads only K: exactly its two current-month rows (K2's row would make three).
    const kRes: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time', fullRange()))
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    expect(envelope(kRes.body).items[3].supportingContext.counts.cohort).toBe(2);
  });

  it('serves the list comparisons through the same formula, for the visible keys only', async () => {
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/kpis`)
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    const body = envelope(res.body);

    // Entitlement: this tenant is production-only, so exactly the two production KPIs.
    expect(body.visible).toBe(2);
    expect(body.items.map((item) => item.technicalKey)).toEqual([
      'production-bom-decision-cycle-time',
      'production-bom-approval-rate',
    ]);
    expect(body.previousPeriod).toMatchObject({ jy: P.jy, jm: P.jm });

    expect(body.comparisons['production-bom-decision-cycle-time']).toMatchObject({
      availability: 'AVAILABLE',
      absoluteChange: (3 * HOUR_MS) / 1000,
      direction: 'INCREASE',
    });
    expect(body.comparisons['production-bom-approval-rate']).toMatchObject({
      availability: 'AVAILABLE',
      percentagePointChange: 100,
      relativeChange: null,
      unavailableReason: 'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
    });
  });

  it('resolves the drill-down to a real report route this reader is entitled to', async () => {
    // The link is /admin/reporting/production → its API: same tenant, same remit.
    const res: SupertestResponse = await api()
      .get(`${API_PREFIX}/reporting/production/boms`)
      .set('Authorization', `Bearer ${adminK.token}`)
      .expect(200);
    expect(Array.isArray(envelope(res.body).items)).toBe(true);
  });

  it('refuses history with 401 for anonymous and 403 without a source remit', async () => {
    const anonymous: SupertestResponse = await api().get(
      kpiUrl('production-bom-decision-cycle-time', fullRange())
    );
    expect(anonymous.status).toBe(401);

    const denied: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time', fullRange()))
      .set('Authorization', `Bearer ${noRead.token}`);
    expect(denied.status).toBe(403);
  });

  it('rejects candidate and unknown keys — history is an APPROVED-only surface', async () => {
    const candidate = KPI_CATALOG.find((def) => def.status !== 'APPROVED');
    if (!candidate) throw new Error('[E2E] no candidate definition found');

    const candidateRes: SupertestResponse = await api()
      .get(kpiUrl(candidate.technicalKey))
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(candidateRes.status).toBe(404);
    expect(candidateRes.body?.code).toBe('KPI_NOT_FOUND');

    const unknownRes: SupertestResponse = await api()
      .get(kpiUrl('no-such-kpi'))
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body?.code).toBe('KPI_NOT_FOUND');
  });

  it('refuses oversized and inverted ranges with deterministic closed codes', async () => {
    const oversizedCount: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time', '?periodCount=13'))
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(oversizedCount.status).toBe(400);
    expect(oversizedCount.body?.code).toBe('HISTORY_RANGE_EXCEEDS_LIMIT');

    const undersized: SupertestResponse = await api()
      .get(kpiUrl('production-bom-decision-cycle-time', '?periodCount=1'))
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(undersized.status).toBe(400);
    expect(undersized.body?.code).toBe('HISTORY_INVALID_RANGE');

    const inverted: SupertestResponse = await api()
      .get(
        kpiUrl(
          'production-bom-decision-cycle-time',
          `?fromJy=${C.jy}&fromJm=${C.jm}&toJy=${P.jy}&toJm=${P.jm}`
        )
      )
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(inverted.status).toBe(400);
    expect(inverted.body?.code).toBe('HISTORY_INVALID_RANGE');

    const monthsSpanning: SupertestResponse = await api()
      .get(
        kpiUrl(
          'production-bom-decision-cycle-time',
          `?fromJy=1390&fromJm=1&toJy=${C.jy}&toJm=${C.jm}`
        )
      )
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(monthsSpanning.status).toBe(400);
    expect(monthsSpanning.body?.code).toBe('HISTORY_RANGE_EXCEEDS_LIMIT');
  });

  it('refuses a client-supplied tenantId — the scope is never a request field', async () => {
    const res: SupertestResponse = await api()
      .get(
        kpiUrl('production-bom-decision-cycle-time', `${fullRange()}&tenantId=${adminK.tenantId}`)
      )
      .set('Authorization', `Bearer ${adminK.token}`);
    expect(res.status).toBe(422);
  });
});
