/**
 * GAP-8 (WS6.D/E) — PLATFORM IDENTITY IS OPAQUE, END TO END: the REAL Core directory
 * stands behind Commerce, against the REAL seeded administrator.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Every Commerce e2e before this one bound an IN-MEMORY `USER_DIRECTORY`, so the one
 * seam the platform's identity contract lives on was never executed together with
 * Commerce: the real `CoreUserDirectoryAdapter`, the real `CoreTenantResolver` reading
 * `User.tenantId` from `core_db`, and the ids the database actually stores. A regression
 * that re-imposed a UUID shape, re-keyed an id, or broke membership could pass every
 * other suite. This one cannot: it runs the real platform modules
 * (`UserDirectoryModule`, `TenantModule`, `PrismaModule`) under the real Commerce
 * controller stack, with fakes ONLY for ports that are not the subject (audit, search,
 * notification, permission, entitlement).
 *
 * WHAT IT PROVES (GAP-8 requirements D and E)
 * -------------------------------------------
 *   D  directory -> Commerce, verbatim: the real directory returns the seeded opaque
 *      id; Commerce accepts THAT EXACT id; Commerce PERSISTS that exact id; no UUID
 *      transformation occurs anywhere on the path.
 *   E  real member path, positive and negative: the seeded `super-admin-user` (a real
 *      row in `tenant-test-1`, established by `prisma/seed.ts`) creates a purchase
 *      request through the real controller; a real member of ANOTHER tenant, a real
 *      tenant-less user, a deleted user and a never-created id are each refused with
 *      the exact membership message; malformed and over-long identities never reach
 *      the service (422 at the pipe).
 *
 * WHAT IS DELIBERATELY A FAKE (and why that does not weaken the claim)
 * -------------------------------------------------------------------
 *   1. Passport 'jwt' derives the principal from `x-probe-user` (the same seam every
 *      Commerce e2e uses): token SIGNATURE verification is not the subject, and the
 *      real `JwtAuthGuard` still runs. The TENANT is NOT faked — it is resolved from
 *      `core_db` by the real `CoreTenantResolver`.
 *   2. Audit/search/notification ports are in-memory: their failures must never change
 *      a write's answer, and the real Core-backed bindings would add unrelated rows to
 *      the shared database. Membership, persistence and serialization are all real.
 *
 * CLEANUP is test-only and id-scoped: documents created here (lines first — the FK is
 * RESTRICT), the disposable tenants' commerce rows, then the disposable core rows. The
 * seeded tenant's counter is deliberately left alone (monotonic numbering is not state
 * this suite owns); nothing else about `tenant-test-1` is touched.
 */
import passport from 'passport';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ValidationError } from 'class-validator';

import { RequestContextService } from '../src/common/request-context.service';
import { RequestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { Permissions } from '../src/auth/rbac/constants/permissions';
import { TenantContextGuard } from '../src/tenant/tenant-context.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';
import { PrismaModule } from '../src/database/prisma.module';
import { PrismaService } from '../src/database/prisma.service';
import { ModuleEntitlementGuard } from '../src/platform/entitlement/module-entitlement.guard';
import {
  ENTITLEMENT_PORT,
  type EntitlementPort,
} from '../src/platform/entitlement/entitlement.contract';
import { PermissionSource } from '../src/platform/auth/permission-source.contract';
import { AUDIT_PORT, type AuditEventInput } from '../src/platform/audit/audit.contract';
import { createFakeAuditPort } from './fixtures/fake-audit-port';
import { SEARCH_SOURCE_PORT } from '../src/platform/search-source/search-source.contract';
import { createFakeSearchSourcePort } from './fixtures/fake-search-source';
import {
  USER_DIRECTORY,
  type UserDirectoryContract,
} from '../src/platform/user-directory/user-directory.contract';
import { NotificationPublisher } from '../src/notifications/notification.publisher';
// GAP-9: the user-addressed Core contract, bound here to a contract-driven double over
// the ids this suite really seeds (see fixtures/fake-notification-service.ts).
import { NotificationService } from '../src/notifications/notification.service';
import { createFakeNotificationService } from './fixtures/fake-notification-service';
import { PureRuleEngineModule } from '../src/rules/pure-rule-engine.module';

import { CommercePrismaModule } from '../src/modules/commerce/database/commerce-prisma.module';
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';
import { CommerceUnitOfWork } from '../src/modules/commerce/database/commerce-transaction';
import { CommerceIdentityGateway } from '../src/modules/commerce/commerce-identity.gateway';
import { CommerceAuditGateway } from '../src/modules/commerce/commerce-audit.gateway';
import { CommerceNotificationGateway } from '../src/modules/commerce/commerce-notification.gateway';
import { CommerceSearchSourceService } from '../src/modules/commerce/search/commerce-search-source.service';
import { PurchaseController } from '../src/modules/commerce/purchase/purchase.controller';
import { PurchaseRepository } from '../src/modules/commerce/purchase/purchase.repository';
import { PurchaseService } from '../src/modules/commerce/purchase/purchase.service';
import { PurchaseTimelineService } from '../src/modules/commerce/purchase/purchase-timeline.service';
import { PurchaseHistoryService } from '../src/modules/commerce/purchase/purchase-history.service';
import { PurchaseHistoryRepository } from '../src/modules/commerce/purchase/purchase-history.repository';
import { PaymentPlanRepository } from '../src/modules/commerce/payment-plan/payment-plan.repository';
import { ReceivingHistoryRepository } from '../src/modules/commerce/receiving/receiving-history.repository';
import { ReturnHistoryRepository } from '../src/modules/commerce/returns/return-history.repository';
import { PurchaseCompletionPolicyRepository } from '../src/modules/commerce/completion/purchase-completion-policy.repository';
import { PurchaseCompletionService } from '../src/modules/commerce/completion/purchase-completion.service';
import { InventoryPostingRepository } from '../src/modules/commerce/integration/inventory-posting.repository';
import { InventoryIntegrationService } from '../src/modules/commerce/integration/inventory-integration.service';
import { INVENTORY_POSTING_PORT } from '../src/modules/commerce/integration/inventory-posting.port';
import { createFakeInventoryPostingPort } from './fixtures/fake-inventory-posting-port';
import { CommercialConfigurationRepository } from '../src/modules/commerce/commercial/commercial-configuration.repository';
import { CommercialLifecycleRepository } from '../src/modules/commerce/commercial/commercial-lifecycle.repository';
import { CommercialLifecycleService } from '../src/modules/commerce/commercial/commercial-lifecycle.service';
import { CommercialLiaisonResolver } from '../src/modules/commerce/commercial/commercial-liaison';
import { WorkflowExecutionRepository } from '../src/modules/commerce/workflow/workflow-execution.repository';
import { WorkflowLineRoutingRepository } from '../src/modules/commerce/workflow/workflow-line-routing.repository';
import { WorkflowLineRoutingService } from '../src/modules/commerce/workflow/workflow-line-routing.service';

import {
  runDbSeed,
  SEED_ADMIN_USER_ID,
  SEED_BOOTSTRAP_TENANT_ID,
} from './fixtures/seed-environment';

import { UserDirectoryModule } from '../src/platform/user-directory/user-directory.module';

// ---------------------------------------------------------------------------
// Disposable real rows: tenants, members (opaque AND uuid-shaped) in `core_db`
// ---------------------------------------------------------------------------
const runId = Date.now();
const tenantAId = `gap8-tenant-a-${runId}`;
const tenantBId = `gap8-tenant-b-${runId}`;
/** A NON-UUID opaque id — the shape the seeded environment uses. */
const opaqueMemberAId = `gap8-opaque-member-${runId}`;
/** A canonical UUID-v4 id — accepted as ONE opaque string, not as a special shape. */
const uuidMemberAId = randomUUID();
const memberBId = `gap8-member-b-${runId}`;
const tenantlessId = `gap8-tenantless-${runId}`;
const doomedId = `gap8-doomed-${runId}`;
const ghostId = `gap8-ghost-${runId}`;

const auditEvents: AuditEventInput[] = [];
const notifications: { eventType: string; payload: Record<string, unknown> }[] = [];

const fakePermissionSource: PermissionSource = {
  async getEffectivePermissions(): Promise<string[]> {
    return Object.values(Permissions as Record<string, string>);
  },
};

const fakeEntitlementPort: EntitlementPort = {
  async decide(): Promise<{ ok: true }> {
    return { ok: true };
  },
};

const fakeNotificationPublisher = {
  async publish(eventType: string, payload: unknown): Promise<void> {
    notifications.push({ eventType, payload: payload as Record<string, unknown> });
  },
} as unknown as NotificationPublisher;

/**
 * GAP-9: the Notification Center double. This suite's recipients are REAL `core_db` rows
 * (the membership matrix), so the registry below mirrors the ids the suite seeds: the two
 * Tenant-A members and the Tenant-B member. Contract-driven like the suites above — see
 * `test/fixtures/fake-notification-service.ts`.
 */
const fakeNotificationRegistry = new Map<string, string>([
  [opaqueMemberAId, tenantAId],
  [uuidMemberAId, tenantAId],
  [memberBId, tenantBId],
]);
const fakeNotificationService = createFakeNotificationService(fakeNotificationRegistry);

/**
 * Seam 1: passport 'jwt' reads the principal from `x-probe-user`. Passport's own
 * framework replaces `success`/`fail` on the instance before `authenticate` runs.
 * `claims: null` is what makes `CoreTenantResolver` read `User.tenantId` from the
 * REAL database instead of trusting a token claim.
 */
class ProbeHeaderStrategy {
  readonly name = 'jwt';
  authenticate(req: { headers: Record<string, unknown> }): void {
    const raw = req.headers['x-probe-user'];
    const userId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (!userId) {
      this.fail({ message: 'missing x-probe-user principal' });
      return;
    }
    this.success({
      sub: userId,
      userId,
      email: `${userId}@probe.test`,
      role: 'SUPER_ADMIN',
      tokenVersion: 0,
      claims: null,
    });
  }
  private success(_arg?: unknown): void {
      void _arg;
    throw new Error('passport replaces this method before authenticate() runs');
  }
  private fail(_arg?: unknown): void {
      void _arg;
    throw new Error('passport replaces this method before authenticate() runs');
  }
}


/**
 * The trimmed Commerce composition: REAL platform identity seams (`TenantModule`,
 * `UserDirectoryModule`, `PrismaModule`), REAL commerce wiring for the purchase
 * controller's graph, in-memory ports for everything that is not identity.
 */
@Module({
  imports: [
    PrismaModule,
    CommercePrismaModule,
    PureRuleEngineModule,
    TenantModule,
    UserDirectoryModule,
  ],
  controllers: [PurchaseController],
  providers: [
    RequestContextService,
    // production boundaries: middleware, guards, interceptor (production order)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    ModuleEntitlementGuard,
    // real commerce wiring — the same list commerce.module.ts composes
    CommerceIdentityGateway,
    CommerceAuditGateway,
    CommerceNotificationGateway,
    CommerceSearchSourceService,
    CommerceUnitOfWork,
    PurchaseRepository,
    PurchaseService,
    PurchaseTimelineService,
    // PHASE W3.2: the aggregated-history route on `PurchaseController` — its
    // service and read-only repository, plus the plan repository the completion
    // service consults for outstanding installments.
    PurchaseHistoryService,
    PurchaseHistoryRepository,
    PaymentPlanRepository,
    ReceivingHistoryRepository,
    ReturnHistoryRepository,
    PurchaseCompletionPolicyRepository,
    PurchaseCompletionService,
    InventoryPostingRepository,
    InventoryIntegrationService,
    { provide: INVENTORY_POSTING_PORT, useValue: createFakeInventoryPostingPort() },
    WorkflowLineRoutingRepository,
    WorkflowExecutionRepository,
    WorkflowLineRoutingService,
    CommercialConfigurationRepository,
    CommercialLifecycleRepository,
    CommercialLifecycleService,
    CommercialLiaisonResolver,
    // The identity seam is NOT bound here: TenantModule exports the real
    // TenantResolver (CoreTenantResolver) and UserDirectoryModule exports the real
    // USER_DIRECTORY (CoreUserDirectoryAdapter). Only non-identity ports are faked.
    { provide: PermissionSource, useValue: fakePermissionSource },
    { provide: ENTITLEMENT_PORT, useValue: fakeEntitlementPort },
    { provide: AUDIT_PORT, useValue: createFakeAuditPort(auditEvents) },
    { provide: SEARCH_SOURCE_PORT, useValue: createFakeSearchSourcePort() },
    { provide: NotificationPublisher, useValue: fakeNotificationPublisher },
    // GAP-9: the gateway's second dependency — the same double (see the integration suite).
    { provide: NotificationService, useValue: fakeNotificationService },
  ],
})
class CommerceIdentityE2ECoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}


jest.setTimeout(120_000);

describe('GAP-8 identity e2e — opaque ids through the REAL directory (requirements D and E)', () => {
  let app: INestApplication;
  let db: CommercePrismaService;
  let core: PrismaService;

  const api = '/api/v1/commerce';
  const http = () => request(app.getHttpServer());
  const authed = (userId: string) => ({ 'x-probe-user': userId });
  const msgOf = (body: { message?: unknown } | null | undefined): string => {
    const m = body?.message;
    return typeof m === 'string' ? m : JSON.stringify(m ?? body);
  };

  /** Every document this suite persists, so cleanup can be exact. */
  const createdDocumentIds: string[] = [];
  const createdCoreUserIds: string[] = [];
  const createdCoreTenantIds: string[] = [];

  const createBody = (requesterId: unknown) => ({
    requesterId,
    supplierId: 'SUP-GAP8',
    currency: 'EUR',
    lines: [{ lineType: 'STANDARD', quantity: 2, unit: 'pcs', unitPrice: 10 }],
  });

  const post = (actorId: string, requesterId: unknown) =>
    http()
      .post(`${api}/purchase-documents`)
      .set(authed(actorId))
      .send(createBody(requesterId));

  beforeAll(async () => {
    // Replace whichever 'jwt' strategy the shared production boot registered.
    // (`import * as passport` copies only own properties under ts-jest's CJS
    // interop, losing the prototype's `use`; require the authenticator directly.)
    const passportAuthenticator = passport as unknown as { use: (strategy: unknown) => void };
    passportAuthenticator.use(new ProbeHeaderStrategy());

    const moduleRef = await Test.createTestingModule({
      imports: [CommerceIdentityE2ECoreModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // The exact production pipe (test/setup.ts + main.ts contract: 422 on validation).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        stopAtFirstError: false,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) => {
          const details = errors.map((error) => ({
            property: error.property,
            constraints: error.constraints,
            children: error.children?.map((child) => child.property),
          }));
          return new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details,
          });
        },
      })
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    db = app.get(CommercePrismaService);
    core = app.get(PrismaService);

    // Requirement E depends on the AUTHORITATIVE bootstrap environment: the seeded
    // administrator in the seeded tenant. If this database has never been seeded
    // (fresh environment), run the real seed entrypoint once; otherwise leave the
    // rows exactly as they are.
    const seeded = await core.user.findUnique({
      where: { id: SEED_ADMIN_USER_ID },
      select: { tenantId: true },
    });
    if (!seeded?.tenantId) {
      await runDbSeed();
    }

    // Disposable real rows for the membership matrix.
    for (const tenantId of [tenantAId, tenantBId]) {
      await core.tenant.create({ data: { id: tenantId, code: tenantId } });
      createdCoreTenantIds.push(tenantId);
    }

    const makeUser = async (id: string, tenantId: string | null) => {
      await core.user.create({
        data: {
          id,
          email: `${id}@gap8.test`,
          passwordHash: 'gap8-not-a-real-hash',
          tenantId,
        },
      });
      createdCoreUserIds.push(id);
    };

    await makeUser(opaqueMemberAId, tenantAId);
    await makeUser(uuidMemberAId, tenantAId);
    await makeUser(memberBId, tenantBId);
    await makeUser(tenantlessId, null);
    // A user that is DELETED before it is ever referenced: a real reference that
    // resolves to nothing must be refused exactly like an unknown one.
    await makeUser(doomedId, tenantAId);
    await core.user.delete({ where: { id: doomedId } });
  });

  afterAll(async () => {
    if (db) {
      // Exact ids first (covers the seeded tenant), then the disposable tenants whole.
      if (createdDocumentIds.length > 0) {
        // PHASE W3: append-only status events RESTRICT their document — they go first.
        await db.purchaseStatusEvent.deleteMany({
          where: { purchaseDocumentId: { in: createdDocumentIds } },
        });
        await db.purchaseLine.deleteMany({
          where: { purchaseDocumentId: { in: createdDocumentIds } },
        });
        await db.purchaseDocument.deleteMany({ where: { id: { in: createdDocumentIds } } });
      }
      const disposable = [tenantAId, tenantBId];
      await db.purchaseStatusEvent.deleteMany({ where: { tenantId: { in: disposable } } });
      await db.purchaseLine.deleteMany({ where: { tenantId: { in: disposable } } });
      await db.purchaseDocument.deleteMany({ where: { tenantId: { in: disposable } } });
      await db.purchaseDocumentCounter.deleteMany({ where: { tenantId: { in: disposable } } });
    }
    if (core) {
      await core.user.deleteMany({ where: { id: { in: createdCoreUserIds } } });
      await core.tenant.deleteMany({ where: { id: { in: createdCoreTenantIds } } });
    }
    if (app) await app.close();
  });


  // ---------------------------------------------------------------------------
  // D — the directory returns the opaque id; Commerce accepts and persists it
  // ---------------------------------------------------------------------------
  it('the REAL directory returns the seeded opaque id verbatim and confirms its membership', async () => {
    const directory = app.get<UserDirectoryContract>(USER_DIRECTORY);

    const profiles = await directory.findProfiles([SEED_ADMIN_USER_ID]);
    expect(profiles.map((profile) => profile.id)).toEqual([SEED_ADMIN_USER_ID]);

    const members = await directory.filterTenantMembers(SEED_BOOTSTRAP_TENANT_ID, [
      SEED_ADMIN_USER_ID,
    ]);
    expect(members).toEqual([SEED_ADMIN_USER_ID]);

    // The same call the gateway makes must NOT return a real member of another tenant.
    const foreign = await directory.filterTenantMembers(SEED_BOOTSTRAP_TENANT_ID, [memberBId]);
    expect(foreign).toEqual([]);
  });

  it('the seeded administrator (requirement E) creates with its own opaque id: accepted, persisted, never re-keyed', async () => {
    const res = await post(SEED_ADMIN_USER_ID, SEED_ADMIN_USER_ID).expect(201);
    createdDocumentIds.push(res.body.id);

    // The wire echoes the EXACT id, and the profile hydrated through the REAL
    // directory carries the same id — no UUID normalization on either side.
    expect(res.body.requester.id).toBe(SEED_ADMIN_USER_ID);
    expect(res.body.requester.profile).not.toBeNull();
    expect(res.body.requester.profile.id).toBe(SEED_ADMIN_USER_ID);

    const row = await db.purchaseDocument.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.requesterId).toBe(SEED_ADMIN_USER_ID);
    expect(row.tenantId).toBe(SEED_BOOTSTRAP_TENANT_ID);
  });

  it('accepts an opaque non-UUID member of a real tenant and persists that exact string', async () => {
    const res = await post(opaqueMemberAId, opaqueMemberAId).expect(201);
    createdDocumentIds.push(res.body.id);

    expect(res.body.requester.id).toBe(opaqueMemberAId);
    expect(res.body.requester.profile.id).toBe(opaqueMemberAId);

    const row = await db.purchaseDocument.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.requesterId).toBe(opaqueMemberAId);
    expect(row.tenantId).toBe(tenantAId);
  });

  it('accepts a UUID-shaped member id as ONE opaque string — the shape is not special-cased', async () => {
    const res = await post(uuidMemberAId, uuidMemberAId).expect(201);
    createdDocumentIds.push(res.body.id);

    expect(res.body.requester.id).toBe(uuidMemberAId);
    expect(res.body.requester.profile.id).toBe(uuidMemberAId);

    const row = await db.purchaseDocument.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.requesterId).toBe(uuidMemberAId);
  });


  // ---------------------------------------------------------------------------
  // E — real membership failures: cross-tenant, tenant-less, deleted, unknown
  // ---------------------------------------------------------------------------
  it('refuses a real member of ANOTHER tenant with the exact membership message (cross-tenant)', async () => {
    const before = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });

    const res = await post(opaqueMemberAId, memberBId).expect(400);
    expect(msgOf(res.body)).toBe('userId is not a member of this tenant');
    expect(res.body.error ?? res.body.code ?? '').not.toContain(memberBId);

    // Nothing was written, and the id was not echoed back in the refusal.
    expect(await db.purchaseDocument.count({ where: { tenantId: tenantAId } })).toBe(before);
    expect(JSON.stringify(res.body)).not.toContain(memberBId);
  });

  it('refuses a real user with NO tenant (tenant membership is not implied by existence)', async () => {
    const res = await post(opaqueMemberAId, tenantlessId).expect(400);
    expect(msgOf(res.body)).toBe('userId is not a member of this tenant');
    expect(JSON.stringify(res.body)).not.toContain(tenantlessId);
  });

  it('refuses a DELETED user id exactly like an unknown one (no resurrection, no disclosure)', async () => {
    const deleted = await post(opaqueMemberAId, doomedId).expect(400);
    expect(msgOf(deleted.body)).toBe('userId is not a member of this tenant');
    expect(JSON.stringify(deleted.body)).not.toContain(doomedId);

    const unknown = await post(opaqueMemberAId, ghostId).expect(400);
    expect(msgOf(unknown.body)).toBe('userId is not a member of this tenant');
    expect(JSON.stringify(unknown.body)).not.toContain(ghostId);
  });

  it('refuses a cross-tenant requester from the SEEDED tenant too (requirement E, negative half)', async () => {
    const before = await db.purchaseDocument.count({
      where: { tenantId: SEED_BOOTSTRAP_TENANT_ID },
    });

    const res = await post(SEED_ADMIN_USER_ID, memberBId).expect(400);
    expect(msgOf(res.body)).toBe('userId is not a member of this tenant');

    expect(
      await db.purchaseDocument.count({ where: { tenantId: SEED_BOOTSTRAP_TENANT_ID } })
    ).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // Wire refusals — malformed and over-long identities never reach the gateway
  // ---------------------------------------------------------------------------
  it('refuses a >64-character identity at the pipe (422) before any membership call', async () => {
    const before = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });

    const res = await post(opaqueMemberAId, 'i'.repeat(65)).expect(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const details = res.body.details as { property: string }[];
    expect(details.map((d) => d.property)).toContain('requesterId');

    expect(await db.purchaseDocument.count({ where: { tenantId: tenantAId } })).toBe(before);
  });

  it('refuses malformed non-string identities at the pipe (422): arrays and null', async () => {
    const before = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });

    const array = await post(opaqueMemberAId, ['gap8', 'array']).expect(422);
    expect(array.body.code).toBe('VALIDATION_FAILED');
    const arrayProps = (array.body.details as { property: string }[]).map((d) => d.property);
    expect(arrayProps).toContain('requesterId');

    const nulled = await post(opaqueMemberAId, null).expect(422);
    expect(nulled.body.code).toBe('VALIDATION_FAILED');
    const nullProps = (nulled.body.details as { property: string }[]).map((d) => d.property);
    expect(nullProps).toContain('requesterId');

    expect(await db.purchaseDocument.count({ where: { tenantId: tenantAId } })).toBe(before);
  });

  it('refuses an EMPTY requesterId at the pipe (422): create always names a requester', async () => {
    const before = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });

    const res = await post(opaqueMemberAId, '').expect(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const details = res.body.details as { property: string }[];
    expect(details.map((d) => d.property)).toContain('requesterId');

    expect(await db.purchaseDocument.count({ where: { tenantId: tenantAId } })).toBe(before);
  });
});

