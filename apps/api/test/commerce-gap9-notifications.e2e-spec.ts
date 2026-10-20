/**
 * GAP-9 — Commerce user notifications, end to end against the REAL Notification Center.
 *
 * WHAT THIS SUITE PROVES, AND WHY THE REAL SERVICE IS THE POINT
 * ------------------------------------------------------------
 * The other Commerce suites bind a contract-driven DOUBLE for `NotificationService` (they
 * are about Commerce, and the Center owns `core_db`). This one does the opposite: it boots
 * the REAL Core `NotificationService` over the REAL `Notification` table, so every claim of
 * the GAP-9 closure is checked against a persisted row rather than a mock:
 *
 *   1. a real Purchase submission persists ONE notification for the workflow approver the
 *      submit put in PENDING (the routing pass's stored `resolvedApproverId`) — with the
 *      `INFORMATION` category and the `purchase-document` back-reference;
 *   2. a real step DECISION persists one for the NEXT group's approver, and NOT for the
 *      deciding approver (no actor-as-recipient assumption);
 *   3. tenant isolation stays CORE-ENFORCED: `Notification.tenantId` is snapshotted from
 *      the recipient, a peer tenant's user sees nothing, and another tenant's user cannot
 *      mark a foreign notification read (404, Core's own ownership rule);
 *   4. the notification is READ through Core's OWN routes (`GET /api/v1/notifications`,
 *      `…/unread-count`, `POST …/:id/read`) — Commerce exposes no notification route;
 *   5. the negatives: a failed submit writes nothing, and a submission that activates no
 *      decision notifies nobody.
 *
 * SEAMS (everything else is production code)
 * ------------------------------------------
 *   * passport 'jwt' derives the principal from `x-probe-user` (signature verification is
 *     not this suite's subject), while the REAL `JwtAuthGuard`, `TenantContextGuard`,
 *     `RolesGuard`, `ModuleEntitlementGuard` and `TenantContextInterceptor` run exactly as
 *     in production — so the tenant really comes from `core_db` through the platform's own
 *     resolver, and the notified recipients are real tenant members.
 *   * The platform identity seams are REAL (`TenantModule`, `UserDirectoryModule`,
 *     `PrismaModule`), so `assertMember` and the approver validation are Core membership
 *     checks rather than a registry lookup.
 *   * Only the three ports that need infrastructure are in-memory: entitlement, audit and
 *     the search source. `NotificationPublisher` (the AMQP transport) is replaced with a
 *     recording fake so the suite needs no broker — the transport is not under test here.
 *
 * Cleanup is test-only, tenant-scoped: commerce rows by tenant, Core notifications by
 * recipient, then the disposable users and tenants.
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
import { ValidationError } from 'class-validator';

import { RequestContextService } from '../src/common/request-context.service';
import { RequestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { Permissions } from '../src/auth/rbac/constants/permissions';
import { TenantContextGuard } from '../src/tenant/tenant-context.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';
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
import { UserDirectoryModule } from '../src/platform/user-directory/user-directory.module';
import { PrismaModule } from '../src/database/prisma.module';
import { PrismaService } from '../src/database/prisma.service';
import { NotificationModule } from '../src/notifications/notification.module';
import { NotificationPublisher } from '../src/notifications/notification.publisher';
import { PureRuleEngineModule } from '../src/rules/pure-rule-engine.module';

import { CommercePrismaModule } from '../src/modules/commerce/database/commerce-prisma.module';
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';
import { CommerceUnitOfWork } from '../src/modules/commerce/database/commerce-transaction';
import { CommerceIdentityGateway } from '../src/modules/commerce/commerce-identity.gateway';
import { CommerceAuditGateway } from '../src/modules/commerce/commerce-audit.gateway';
import { CommerceNotificationGateway } from '../src/modules/commerce/commerce-notification.gateway';
import { CommerceSearchSourceService } from '../src/modules/commerce/search/commerce-search-source.service';

import { PurchaseController } from '../src/modules/commerce/purchase/purchase.controller';
import { PurchaseService } from '../src/modules/commerce/purchase/purchase.service';
import { PurchaseTimelineService } from '../src/modules/commerce/purchase/purchase-timeline.service';
import { PurchaseHistoryService } from '../src/modules/commerce/purchase/purchase-history.service';
import { PurchaseHistoryRepository } from '../src/modules/commerce/purchase/purchase-history.repository';
import { PaymentPlanRepository } from '../src/modules/commerce/payment-plan/payment-plan.repository';
import { ReceivingHistoryRepository } from '../src/modules/commerce/receiving/receiving-history.repository';
import { ReturnHistoryRepository } from '../src/modules/commerce/returns/return-history.repository';
import { PurchaseRepository } from '../src/modules/commerce/purchase/purchase.repository';
import { PurchaseCompletionPolicyRepository } from '../src/modules/commerce/completion/purchase-completion-policy.repository';
import { PurchaseCompletionPolicyService } from '../src/modules/commerce/completion/purchase-completion-policy.service';
import { PurchaseCompletionService } from '../src/modules/commerce/completion/purchase-completion.service';
import { InventoryPostingRepository } from '../src/modules/commerce/integration/inventory-posting.repository';
import { InventoryIntegrationService } from '../src/modules/commerce/integration/inventory-integration.service';
import { INVENTORY_POSTING_PORT } from '../src/modules/commerce/integration/inventory-posting.port';
import { createFakeInventoryPostingPort } from './fixtures/fake-inventory-posting-port';
import { CommercialController } from '../src/modules/commerce/commercial/commercial.controller';
import { CommercialConfigurationRepository } from '../src/modules/commerce/commercial/commercial-configuration.repository';
import { CommercialConfigurationService } from '../src/modules/commerce/commercial/commercial-configuration.service';
import { CommercialLifecycleRepository } from '../src/modules/commerce/commercial/commercial-lifecycle.repository';
import { CommercialLifecycleService } from '../src/modules/commerce/commercial/commercial-lifecycle.service';
import { CommercialLiaisonResolver } from '../src/modules/commerce/commercial/commercial-liaison';
import { WorkflowConfigurationController } from '../src/modules/commerce/workflow/workflow-configuration.controller';
import { WorkflowConfigurationRepository } from '../src/modules/commerce/workflow/workflow-configuration.repository';
import { WorkflowConfigurationService } from '../src/modules/commerce/workflow/workflow-configuration.service';
import { WorkflowExecutionController } from '../src/modules/commerce/workflow/workflow-execution.controller';
import { WorkflowExecutionRepository } from '../src/modules/commerce/workflow/workflow-execution.repository';
import { WorkflowExecutionService } from '../src/modules/commerce/workflow/workflow-execution.service';
import { WorkflowLineRoutingController } from '../src/modules/commerce/workflow/workflow-line-routing.controller';
import { WorkflowLineRoutingRepository } from '../src/modules/commerce/workflow/workflow-line-routing.repository';
import { WorkflowLineRoutingService } from '../src/modules/commerce/workflow/workflow-line-routing.service';
import { WorkflowLineRoutingConfigurationService } from '../src/modules/commerce/workflow/workflow-line-routing-configuration.service';

jest.setTimeout(120_000);

// ---------------------------------------------------------------------------
// Disposable real rows: two tenants and their members, in `core_db`
// ---------------------------------------------------------------------------
const runId = Date.now();
const tenantAId = `gap9-tenant-a-${runId}`;
const tenantBId = `gap9-tenant-b-${runId}`;

/** Tenant A: the requester/submitter, two sequential approvers, one uninvolved peer. */
const actorAId = `gap9-actor-a-${runId}`;
const approverA1Id = `gap9-approver-a1-${runId}`;
const approverA2Id = `gap9-approver-a2-${runId}`;
const peerAId = `gap9-peer-a-${runId}`;
/** Tenant B: an actor and the commercial approver its configuration names. */
const actorBId = `gap9-actor-b-${runId}`;
const commercialApproverBId = `gap9-commercial-b-${runId}`;

const auditEvents: AuditEventInput[] = [];
const publishedEvents: { eventType: string; payload: Record<string, unknown> }[] = [];

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

const fakeAuditPort = createFakeAuditPort(auditEvents);

const fakeNotificationPublisher = {
  async publish(eventType: string, payload: unknown): Promise<void> {
    publishedEvents.push({ eventType, payload: payload as Record<string, unknown> });
  },
} as unknown as NotificationPublisher;

/**
 * Seam 1: passport 'jwt' reads the principal from `x-probe-user`. `claims: null` is what
 * makes the REAL `CoreTenantResolver` read `User.tenantId` from `core_db` rather than
 * trusting a token claim.
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
 * The trimmed composition under test.
 *
 * REAL: the platform identity seams (`PrismaModule`, `TenantModule`, `UserDirectoryModule`),
 * the Core Notification Center (`NotificationModule` — the real service AND its read
 * routes), the rule engine, the commerce database and every commerce service the routes
 * below reach.
 *
 * IN-MEMORY: the three infrastructure ports (entitlement, audit, search source) and the
 * AMQP transport, exactly as the sibling commerce suites bind them.
 */
@Module({
  imports: [
    PrismaModule,
    CommercePrismaModule,
    PureRuleEngineModule,
    TenantModule,
    UserDirectoryModule,
    // GAP-9: the Core Notification Center. The REAL `NotificationService` is what the
    // gateway calls, and its 4 read routes are what this suite asserts compatibility with.
    NotificationModule,
  ],
  controllers: [
    PurchaseController,
    CommercialController,
    WorkflowConfigurationController,
    WorkflowLineRoutingController,
    // PHASE C2 (GAP-1): the decision route the GAP-9 workflow path is driven through.
    WorkflowExecutionController,
  ],
  providers: [
    RequestContextService,
    // Production boundaries, in production order.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    ModuleEntitlementGuard,
    // Real commerce wiring, for the controllers above.
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
    PurchaseCompletionPolicyService,
    PurchaseCompletionService,
    InventoryPostingRepository,
    InventoryIntegrationService,
    { provide: INVENTORY_POSTING_PORT, useValue: createFakeInventoryPostingPort() },
    CommercialConfigurationRepository,
    CommercialConfigurationService,
    CommercialLifecycleRepository,
    CommercialLifecycleService,
    CommercialLiaisonResolver,
    WorkflowConfigurationRepository,
    WorkflowConfigurationService,
    WorkflowExecutionRepository,
    WorkflowExecutionService,
    WorkflowLineRoutingRepository,
    WorkflowLineRoutingService,
    WorkflowLineRoutingConfigurationService,
    // The in-memory ports. NOTE what is NOT here: `TenantResolver` and `USER_DIRECTORY`
    // come from `TenantModule` / `UserDirectoryModule` above, so the tenant context and
    // every membership/approver check are the REAL Core ones.
    { provide: PermissionSource, useValue: fakePermissionSource },
    { provide: ENTITLEMENT_PORT, useValue: fakeEntitlementPort },
    { provide: AUDIT_PORT, useValue: fakeAuditPort },
    { provide: SEARCH_SOURCE_PORT, useValue: createFakeSearchSourcePort() },
    { provide: NotificationPublisher, useValue: fakeNotificationPublisher },
  ],
})
class CommerceGap9NotificationsE2ECoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

describe('GAP-9 — Commerce notifications, end to end (real Core Notification Center)', () => {
  let app: INestApplication;
  let db: CommercePrismaService;
  let core: PrismaService;

  const api = '/api/v1/commerce';
  const notices = '/api/v1/notifications';
  const http = () => request(app.getHttpServer());
  const authed = (userId: string) => ({ 'x-probe-user': userId });

  const createdDocumentIds: string[] = [];
  const createdCoreUserIds: string[] = [];

  /** The recipient's own notifications, through Core's OWN route. */
  const inbox = async (userId: string) => {
    const res = await http().get(`${notices}?limit=50`).set(authed(userId)).expect(200);
    return res.body.items as {
      id: string;
      type: string;
      title: string;
      body: string;
      readAt: string | null;
      sourceType: string | null;
      sourceId: string | null;
    }[];
  };

  const unreadCount = async (userId: string) => {
    const res = await http().get(`${notices}/unread-count`).set(authed(userId)).expect(200);
    return res.body.count as number;
  };

  /** The PERSISTED rows for one recipient, read from the real Core table. */
  const storedFor = (userId: string) =>
    core.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  const createDocument = async (actorUserId: string, lines: Record<string, unknown>[]) => {
    const res = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(actorUserId))
      .send({ requesterId: actorUserId, supplierId: 'SUP-GAP9', currency: 'EUR', lines })
      .expect(201);
    createdDocumentIds.push(res.body.id);
    return res.body as { id: string; documentNumber: string; lines: { id: string }[] };
  };

  const submit = (documentId: string, as: string) =>
    http().post(`${api}/purchase-documents/${documentId}/submit`).set(authed(as));

  /** The LINE workflow instance a submit created for one line. */
  const instanceForLine = (lineId: string) =>
    db.workflowInstance.findFirstOrThrow({
      where: { tenantId: tenantAId, subjectType: 'PURCHASE_LINE', subjectId: lineId },
    });

  const decide = (instanceId: string, stepInstanceId: string, as: string) =>
    http()
      .post(`${api}/workflow-instances/${instanceId}/steps/${stepInstanceId}/decision`)
      .set(authed(as))
      .send({ decision: 'APPROVED', comment: null });

  /** The created row's id, or the id read back when a create answers a projection. */
  const idOr = async (
    body: { id?: string } | undefined,
    fallback: () => Promise<{ id: string } | null>
  ): Promise<string> => {
    if (body && typeof body.id === 'string') return body.id;
    const row = await fallback();
    if (!row) throw new Error('expected a persisted row to read the id from');
    return row.id;
  };

  let versionId: string;
  let docId: string;
  let targetLineId: string;

  beforeAll(async () => {
    // Replace whichever 'jwt' strategy the shared production boot registered.
    const passportAuthenticator = passport as unknown as { use: (strategy: unknown) => void };
    passportAuthenticator.use(new ProbeHeaderStrategy());

    const moduleRef = await Test.createTestingModule({
      imports: [CommerceGap9NotificationsE2ECoreModule],
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
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.length,
          }),
      })
    );
    app.setGlobalPrefix('api/v1');
    await app.init();

    db = app.get(CommercePrismaService);
    core = app.get(PrismaService);

    // Disposable REAL rows: two tenants and their members.
    for (const tenantId of [tenantAId, tenantBId]) {
      await core.tenant.create({ data: { id: tenantId, code: tenantId } });
    }
    for (const [userId, tenantId] of [
      [actorAId, tenantAId],
      [approverA1Id, tenantAId],
      [approverA2Id, tenantAId],
      [peerAId, tenantAId],
      [actorBId, tenantBId],
      [commercialApproverBId, tenantBId],
    ] as const) {
      await core.user.create({
        data: {
          id: userId,
          email: `${userId}@gap9.test`,
          passwordHash: 'gap9-not-a-real-hash',
          tenantId,
        },
      });
      createdCoreUserIds.push(userId);
    }
  });

  afterAll(async () => {
    if (db) {
      /*
       * Test-only, tenant-scoped cleanup with explicit predicates — no TRUNCATE. The ORDER is
       * the schema's: decisions before their runs, rows a document PINNED (commercial and
       * routing versions are RESTRICT-referenced by the document) after the documents, and the
       * configured steps/versions/definitions last.
       */
      const where = { tenantId: { in: [tenantAId, tenantBId] } };
      await db.commercialApproval.deleteMany({ where });
      await db.commercialAssignmentHistory.deleteMany({ where });
      await db.commercialAssignment.deleteMany({ where });
      await db.workflowStepInstance.deleteMany({ where });
      await db.workflowInstance.deleteMany({ where });
      // PHASE W3: append-only status events RESTRICT their document — they go first.
      await db.purchaseStatusEvent.deleteMany({ where });
      await db.purchaseLine.deleteMany({ where });
      await db.purchaseDocument.deleteMany({ where });
      await db.purchaseDocumentCounter.deleteMany({ where });
      await db.workflowLineRoutingVersion.deleteMany({ where });
      await db.workflowStep.deleteMany({ where });
      await db.workflowDefinitionVersion.deleteMany({ where });
      await db.workflowDefinition.deleteMany({ where });
      await db.commercialConfigurationVersion.deleteMany({ where });
      await db.commercialGroup.deleteMany({ where });
    }
    if (core) {
      // The Core rows: the notifications this suite caused, then the disposable identities.
      await core.notification.deleteMany({ where: { userId: { in: createdCoreUserIds } } });
      await core.user.deleteMany({ where: { id: { in: createdCoreUserIds } } });
      await core.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    }
    await app?.close();
  });

  // =========================================================================
  // Fixtures — a two-step SEQUENTIAL workflow version, and a routing version
  // that routes a STANDARD line to it (tenant A).
  // =========================================================================
  it('GAP-9 fixtures: publish a two-step workflow version, then a routing version that uses it', async () => {
    const def = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(actorAId))
      .send({ code: `GAP9-WF-${runId}`, name: 'GAP-9 workflow' })
      .expect(201);

    const version = await http()
      .post(`${api}/workflow-definitions/${def.body.id}/versions`)
      .set(authed(actorAId))
      .send({ versionLabel: 'v1', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    versionId = version.body.id;

    // TWO SEQUENTIAL STEPS, each with its own configured approver: step 2 is not activated
    // until step 1 is decided, which is what makes the decision's recipient provable.
    for (const [index, step] of [
      { stepKey: 'first_approval', actorUserId: approverA1Id },
      { stepKey: 'second_approval', actorUserId: approverA2Id },
    ].entries()) {
      await http()
        .post(`${api}/workflow-versions/${versionId}/steps`)
        .set(authed(actorAId))
        .send({
          stepKey: step.stepKey,
          displayName: step.stepKey,
          ordering: index + 1,
          actorSource: 'CONFIGURED_USER',
          actorUserId: step.actorUserId,
        })
        .expect(201);
    }

    const validated = await http()
      .post(`${api}/workflow-versions/${versionId}/validate`)
      .set(authed(actorAId));
    expect(validated.body).toMatchObject({ status: 'VALIDATED' });
    const published = await http()
      .post(`${api}/workflow-versions/${versionId}/publish`)
      .set(authed(actorAId));
    expect(published.body).toMatchObject({ status: 'PUBLISHED' });

    const routing = await http()
      .post(`${api}/routing-versions`)
      .set(authed(actorAId))
      .send({
        versionLabel: `GAP9-ROUTING-${runId}`,
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'INDEPENDENT',
        routeRules: [
          {
            priority: 1,
            targetWorkflowDefinitionVersionId: versionId,
            condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
          },
        ],
      })
      .expect(201);
    const routingId = await idOr(routing.body, () =>
      db.workflowLineRoutingVersion.findFirst({
        where: { tenantId: tenantAId, versionLabel: `GAP9-ROUTING-${runId}` },
      })
    );

    const routedPublished = await http()
      .post(`${api}/routing-versions/${routingId}/publish`)
      .set(authed(actorAId));
    expect(routedPublished.body).toMatchObject({ status: 'PUBLISHED' });
  });

  // =========================================================================
  // WORKSTREAM 3 — the submission notification
  // =========================================================================
  it('the submit tells the workflow approver it put in PENDING — and nobody else', async () => {
    const doc = await createDocument(actorAId, [
      { lineType: 'STANDARD', quantity: 2, unit: 'pcs', unitPrice: 10, tax: 0 },
    ]);
    docId = doc.id;
    targetLineId = doc.lines[0].id;

    await submit(docId, actorAId).expect(200);

    // ONE persisted row, addressed to the approver of the step the routing activated.
    const rows = await storedFor(approverA1Id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Snapshotted from the RECIPIENT by Core — Commerce passes the assertion, not a placement.
      tenantId: tenantAId,
      type: 'INFORMATION',
      sourceType: 'purchase-document',
      sourceId: docId,
      readAt: null,
    });
    expect(rows[0].title).toContain(doc.documentNumber);
    expect(rows[0].body).toContain(doc.documentNumber);

    // NOBODY else: not the second step's approver (its step does not exist yet), not the
    // requester, not the ACTOR (who also submitted), and not an uninvolved peer.
    expect(await storedFor(approverA2Id)).toEqual([]);
    expect(await storedFor(actorAId)).toEqual([]);
    expect(await storedFor(peerAId)).toEqual([]);

    // And the recipient sees it through CORE's own route, unread.
    const items = await inbox(approverA1Id);
    expect(items.map((item: { id: string }) => item.id)).toEqual([rows[0].id]);
    expect(await unreadCount(approverA1Id)).toBe(1);
  });

  // =========================================================================
  // WORKSTREAM 4 — the decision notification
  // =========================================================================
  it('a decision tells the NEXT approver, never the approver who decided', async () => {
    const instance = await instanceForLine(targetLineId);
    const pending = await db.workflowStepInstance.findFirstOrThrow({
      where: { tenantId: tenantAId, workflowInstanceId: instance.id, status: 'PENDING' },
    });
    expect(pending.resolvedApproverId).toBe(approverA1Id);

    await decide(instance.id, pending.id, approverA1Id).expect(200);

    // The advance put step 2 in PENDING, and its stored approver is told.
    const rows = await storedFor(approverA2Id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenantAId,
      type: 'INFORMATION',
      sourceType: 'purchase-document',
      // A LINE run's notification points at the DOCUMENT the line belongs to.
      sourceId: docId,
    });

    // The deciding approver received nothing for their own act: their step is no longer
    // pending, so they are not an owner of any decision that now exists.
    expect(await storedFor(approverA1Id)).toHaveLength(1);
    expect(await storedFor(actorAId)).toEqual([]);
  });

  // =========================================================================
  // Core ownership of read/unread — and no Commerce notification surface
  // =========================================================================
  it('keeps read/unread ownership in Core, and exposes no Commerce notification route', async () => {
    const [row] = await storedFor(approverA2Id);

    // The RECIPIENT marks it read through the Center's own route, and the unread count
    // follows — Commerce never owns that state.
    await http().post(`${notices}/${row.id}/read`).set(authed(approverA2Id)).expect(200);
    expect(await unreadCount(approverA2Id)).toBe(0);
    const [read] = await inbox(approverA2Id);
    expect(read.readAt).not.toBeNull();

    // GAP-9 added no notification surface to Commerce: the canonical URL is Core's, and a
    // Commerce-side one does not exist.
    await http().get(`${api}/notifications`).set(authed(actorAId)).expect(404);
  });

  // =========================================================================
  // Tenant isolation — Core-enforced, proven
  // =========================================================================
  it('keeps tenant isolation Core-enforced: another tenant sees nothing and cannot touch the row', async () => {
    const [row] = await storedFor(approverA1Id);
    expect(row.tenantId).toBe(tenantAId);

    // Tenant B's user lists nothing — the row is neither visible nor countable.
    expect(await inbox(actorBId)).toEqual([]);
    expect(await unreadCount(actorBId)).toBe(0);

    // And cannot mark tenant A's row read: Core's ownership predicate answers 404, which is
    // also what an absent row answers — no existence leak, no cross-tenant write.
    await http().post(`${notices}/${row.id}/read`).set(authed(actorBId)).expect(404);
    const unchanged = await core.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.readAt).toBeNull();
    expect(unchanged.tenantId).toBe(tenantAId);
  });

  // =========================================================================
  // NEGATIVE CASES
  // =========================================================================
  it('creates no notification for a submission that fails', async () => {
    const before = await core.notification.count();

    // The same document, submitted again: DRAFT → SUBMITTED is the only edge, so this is a
    // 409 and no transition (and therefore no notification) happens.
    await submit(docId, actorAId).expect(409);

    expect(await core.notification.count()).toBe(before);
    expect(await unreadCount(approverA1Id)).toBe(1);
  });

  it('creates no notification when the submission activates no decision', async () => {
    // A SERVICE line: tenant A's routing version matches only STANDARD lines (so this one is
    // left unrouted), and tenant A publishes no commercial configuration — so nothing and
    // nobody is put in PENDING. No authoritative recipient exists, so no row is invented.
    const doc = await createDocument(actorAId, [
      { lineType: 'SERVICE', quantity: 1, unit: 'lot', unitPrice: 30, tax: 0 },
    ]);

    await submit(doc.id, actorAId).expect(200);

    expect(await core.notification.count({ where: { sourceId: doc.id } })).toBe(0);
    expect(await unreadCount(peerAId)).toBe(0);
    expect(await storedFor(approverA1Id)).toHaveLength(1);
    expect(await storedFor(approverA2Id)).toHaveLength(1);
  });

  // =========================================================================
  // The COMMERCIAL approver recipient, in a tenant with no workflow routing
  // =========================================================================
  it('tells the commercial approver when the configuration activates one', async () => {
    const group = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(actorBId))
      .send({ code: `GAP9-GROUP-${runId}`, name: 'GAP-9 group', liaisonUserId: actorBId })
      .expect(201);
    const groupId = await idOr(group.body, () =>
      db.commercialGroup.findFirst({ where: { tenantId: tenantBId, code: `GAP9-GROUP-${runId}` } })
    );

    const config = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(actorBId))
      .send({
        versionLabel: `GAP9-CFG-${runId}`,
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          // The label becomes the rule's own bounded id at publication, so it follows the
          // same identifier shape the integration suite's `W-rule` uses.
          { label: 'gap9_rule', priority: 1, condition: null, commercialGroupId: groupId },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: commercialApproverBId,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);

    const validated = await http()
      .post(`${api}/commercial-configurations/${config.body.id}/validate`)
      .set(authed(actorBId));
    expect(validated.body).toMatchObject({ status: 'VALIDATED' });
    const published = await http()
      .post(`${api}/commercial-configurations/${config.body.id}/publish`)
      .set(authed(actorBId));
    expect(published.body).toMatchObject({ status: 'PUBLISHED' });

    const doc = await createDocument(actorBId, [
      { lineType: 'STANDARD', quantity: 1, unit: 'pcs', unitPrice: 5, tax: 0 },
    ]);
    await submit(doc.id, actorBId).expect(200);

    // The activation's stored approver is told — the SECOND authoritative recipient source,
    // in a tenant with no routing version at all.
    const rows = await storedFor(commercialApproverBId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenantBId,
      type: 'INFORMATION',
      sourceType: 'purchase-document',
      sourceId: doc.id,
    });
    // Never the actor who submitted.
    expect(await storedFor(actorBId)).toEqual([]);
  });
});
