/**
 * Step U — Commerce tenant isolation, end to end (risks G3–G9).
 *
 * WHAT THIS SUITE PROVES — every assertion runs through the real boundary stack:
 * RequestContextMiddleware (fresh per-request context) → global JwtAuthGuard →
 * TenantContextGuard → RolesGuard → controller ModuleEntitlementGuard + JwtAuthGuard →
 * resolveCommerceActor → the real commerce_db repositories.
 *
 *   G3  cross-tenant identifiers in DTOs, path params and probe bodies are refused,
 *       or resolve to the ACTOR's tenant, never the payload's.
 *   G4  PurchaseDocumentCounter sequences are per (tenant, kind, Jalali year).
 *   G5  commercial groups/configurations/assignments/approvals never cross tenants.
 *   G6  DTO-supplied tenant scope (group ids, approver users, workflow actors) is refused.
 *   G7  an authenticated principal with no resolvable tenant is refused by Commerce
 *       itself (403, exact message) before any write.
 *   G8  workflow definition/version/step/publish and line routing are tenant-scoped;
 *       submit pins each tenant's lines to that tenant's own published version.
 *   G9  list endpoints never widen their read; filters cannot reach across tenants.
 *
 * SEAMS (everything else is production code):
 *   1. Passport 'jwt' strategy — signature verification is not the subject of this
 *      suite, so a strategy derives the principal from `x-probe-user`. The real
 *      JwtAuthGuard (global and per-controller) still runs exactly as in production.
 *   2. In-memory ports — TenantResolver, PermissionSource, ENTITLEMENT_PORT,
 *      AUDIT_PORT, USER_DIRECTORY, NotificationPublisher — bound to an in-memory
 *      two-tenant registry; all fakes keep the production port shapes and record
 *      every call for the seam assertions below.
 *   3. Line-routing configuration has no production HTTP route, so a test-only probe
 *      controller exposes it; the tenant still comes from resolveCommerceActor(req),
 *      never from the body.
 * Cleanup is test-only tenant-scoped deleteMany with explicit tenant predicates — no TRUNCATE.
 */
import passport from 'passport';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  Param,
  Post,
  Request,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Request as ExRequest } from 'express';
import { ValidationError } from 'class-validator';

import { RequestContextService } from '../src/common/request-context.service';
import { RequestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { Permissions } from '../src/auth/rbac/constants/permissions';
import { TenantContextGuard } from '../src/tenant/tenant-context.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { ModuleEntitlementGuard } from '../src/platform/entitlement/module-entitlement.guard';

import {
  ENTITLEMENT_PORT,
  type EntitlementPort,
} from '../src/platform/entitlement/entitlement.contract';
import { PermissionSource } from '../src/platform/auth/permission-source.contract';
import {
  TenantResolver,
  type TenantResolution,
  type TenantResolutionInput,
} from '../src/platform/auth/tenant-resolver.contract';
import { AUDIT_PORT, type AuditEventInput } from '../src/platform/audit/audit.contract';
import { createFakeAuditPort } from './fixtures/fake-audit-port';
// PHASE C9 (GAP-5): the Commerce search source registers into a CONTRACT-DRIVEN in-memory
// port here — the same `register/project/authorize` shapes the real binding enforces — so
// this suite keeps proving Commerce's own behaviour; the participation itself is exercised
// end to end (real port, real `GET /search`) in `commerce-search-source.e2e-spec.ts`.
import { SEARCH_SOURCE_PORT } from '../src/platform/search-source/search-source.contract';
import { createFakeSearchSourcePort } from './fixtures/fake-search-source';
import {
  USER_DIRECTORY,
  type DirectoryUserProfile,
  type UserDirectoryContract,
} from '../src/platform/user-directory/user-directory.contract';
import { NotificationPublisher } from '../src/notifications/notification.publisher';
// GAP-9: the user-addressed Core contract, bound here to a contract-driven double over
// the same in-memory tenant registry (see fixtures/fake-notification-service.ts).
import { NotificationService } from '../src/notifications/notification.service';
import { createFakeNotificationService } from './fixtures/fake-notification-service';
import { PureRuleEngineModule } from '../src/rules/pure-rule-engine.module';

import { CommercePrismaModule } from '../src/modules/commerce/database/commerce-prisma.module';
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';
import { CommerceUnitOfWork } from '../src/modules/commerce/database/commerce-transaction';
import { resolveCommerceActor } from '../src/modules/commerce/commerce-actor';
import { CommerceIdentityGateway } from '../src/modules/commerce/commerce-identity.gateway';
import { CommerceAuditGateway } from '../src/modules/commerce/commerce-audit.gateway';
import { CommerceNotificationGateway } from '../src/modules/commerce/commerce-notification.gateway';
import { CommerceSearchSourceService } from '../src/modules/commerce/search/commerce-search-source.service';
import { WORKFLOW_TRIGGER_EVENTS } from '../src/modules/commerce/workflow/workflow-configuration';

import { PurchaseController } from '../src/modules/commerce/purchase/purchase.controller';
// PHASE C4-R (GAP-3): the completion slice wired exactly as commerce.module.ts wires it —
// the close route on `PurchaseController` needs its service, and the policy routes their
// own controller, repository and service.
import { PurchaseCompletionPolicyController } from '../src/modules/commerce/completion/purchase-completion-policy.controller';
import { PurchaseCompletionPolicyRepository } from '../src/modules/commerce/completion/purchase-completion-policy.repository';
import { PurchaseCompletionPolicyService } from '../src/modules/commerce/completion/purchase-completion-policy.service';
import { PurchaseCompletionService } from '../src/modules/commerce/completion/purchase-completion.service';
import { PurchaseService } from '../src/modules/commerce/purchase/purchase.service';
import { PurchaseTimelineService } from '../src/modules/commerce/purchase/purchase-timeline.service';
import { PurchaseRepository } from '../src/modules/commerce/purchase/purchase.repository';
import { PaymentHistoryController } from '../src/modules/commerce/payment/payment-history.controller';
import { PaymentHistoryService } from '../src/modules/commerce/payment/payment-history.service';
import { PaymentHistoryRepository } from '../src/modules/commerce/payment/payment-history.repository';
import { ReceivingHistoryController } from '../src/modules/commerce/receiving/receiving-history.controller';
import { ReceivingHistoryService } from '../src/modules/commerce/receiving/receiving-history.service';
import { ReceivingHistoryRepository } from '../src/modules/commerce/receiving/receiving-history.repository';
import { ReturnHistoryController } from '../src/modules/commerce/returns/return-history.controller';
import { ReturnHistoryService } from '../src/modules/commerce/returns/return-history.service';
import { ReturnHistoryRepository } from '../src/modules/commerce/returns/return-history.repository';
import { CommercialController } from '../src/modules/commerce/commercial/commercial.controller';
import { CommercialConfigurationService } from '../src/modules/commerce/commercial/commercial-configuration.service';
import { CommercialConfigurationRepository } from '../src/modules/commerce/commercial/commercial-configuration.repository';
import { CommercialLifecycleService } from '../src/modules/commerce/commercial/commercial-lifecycle.service';
import { CommercialLifecycleRepository } from '../src/modules/commerce/commercial/commercial-lifecycle.repository';
import { CommercialLiaisonResolver } from '../src/modules/commerce/commercial/commercial-liaison';
import { WorkflowConfigurationController } from '../src/modules/commerce/workflow/workflow-configuration.controller';
import { WorkflowConfigurationService } from '../src/modules/commerce/workflow/workflow-configuration.service';
import { WorkflowConfigurationRepository } from '../src/modules/commerce/workflow/workflow-configuration.repository';
import { WorkflowExecutionService } from '../src/modules/commerce/workflow/workflow-execution.service';
import { WorkflowExecutionRepository } from '../src/modules/commerce/workflow/workflow-execution.repository';
import { WorkflowLineRoutingService } from '../src/modules/commerce/workflow/workflow-line-routing.service';
import { WorkflowLineRoutingConfigurationService } from '../src/modules/commerce/workflow/workflow-line-routing-configuration.service';
import { WorkflowLineRoutingRepository } from '../src/modules/commerce/workflow/workflow-line-routing.repository';

// ---------------------------------------------------------------------------
// The two-tenant registry and the in-memory port fakes (seam 2)
// ---------------------------------------------------------------------------
const runId = Date.now();
const tenantAId = `tenant-A-${runId}`;
const tenantBId = `tenant-B-${runId}`;
const userA1 = randomUUID();
const userA2 = randomUUID();
const userB1 = randomUUID();
const unresolvedUserId = randomUUID();

/** userId → tenantId. `unresolvedUserId` is deliberately absent (G7). */
const tenantRegistry = new Map<string, string>([
  [userA1, tenantAId],
  [userA2, tenantAId],
  [userB1, tenantBId],
]);

const auditEvents: AuditEventInput[] = [];
const notifications: { eventType: string; payload: Record<string, unknown> }[] = [];

function profileOf(id: string): DirectoryUserProfile {
  return {
    id,
    firstName: 'Probe',
    lastName: 'User',
    avatarUrl: null,
    jobTitle: 'Tester',
    department: 'QA',
  };
}

const fakeTenantResolver: TenantResolver = {
  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const tenantId = input.userId ? tenantRegistry.get(input.userId) : undefined;
    return tenantId ? { tenantId, source: 'claim' } : { tenantId: null, source: 'none' };
  },
};

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

// PHASE P-AUDIT-READ: the fake is contract-driven for BOTH port methods — `read` validates
// through the same `validateAuditReadQuery` the Core binding uses (test/fixtures/fake-audit-port).
const fakeAuditPort = createFakeAuditPort(auditEvents);

const fakeDirectory: UserDirectoryContract = {
  async findProfiles(userIds: readonly string[]): Promise<DirectoryUserProfile[]> {
    return [...new Set(userIds)].map(profileOf);
  },
  async filterTenantMembers(tenantId: string, userIds: readonly string[]): Promise<string[]> {
    return [...new Set(userIds)].filter((id) => tenantRegistry.get(id) === tenantId);
  },
  async findTenantMember(tenantId: string, userId: string): Promise<DirectoryUserProfile | null> {
    return tenantRegistry.get(userId) === tenantId ? profileOf(userId) : null;
  },
  async findTenantId(userId: string): Promise<string | null> {
    return tenantRegistry.get(userId) ?? null;
  },
};

const fakeNotificationPublisher = {
  async publish(eventType: string, payload: unknown): Promise<void> {
    notifications.push({ eventType, payload: payload as Record<string, unknown> });
  },
} as unknown as NotificationPublisher;

/**
 * GAP-9: the Notification Center double, bound to the SAME `tenantRegistry` the tenant
 * resolver and the directory port use. Contract-driven: see
 * `test/fixtures/fake-notification-service.ts`.
 */
const fakeNotificationService = createFakeNotificationService(tenantRegistry);

/**
 * Seam 1: passport 'jwt' reads the principal from `x-probe-user`. Passport's own
 * framework replaces `success`/`fail` on the instance before `authenticate` runs.
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
  private success(): void {
    throw new Error('passport replaces this method before authenticate() runs');
  }
  private fail(): void {
    throw new Error('passport replaces this method before authenticate() runs');
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
jest.setTimeout(120_000);

describe('Commerce tenant isolation e2e (Step U / G3-G9)', () => {
  let app: INestApplication;
  let db: CommercePrismaService;

  /**
   * The Step-U document shape: the created row echoes the id, its generated
   * number, its status, and its lines (each with at least an id).
   */
  interface TenantPurchaseDocument {
    id: string;
    documentNumber: string;
    status: string;
    lines: Array<{ id: string }>;
  }

  let docA: TenantPurchaseDocument;
  let lineA: string;
  let docB: TenantPurchaseDocument;
  let lineB: string;
  let payA: string;
  let receiptLineA: string;
  let retA: string;
  let grA: string;
  let grB: string;
  let cfgA: string;
  let wfA: { defId: string; verId: string; stepId: string };
  let wfB: { defId: string; verId: string; stepId: string };
  let routeA: string;
  let routeBDraft: string;
  let routeB: string;
  let approvalA: string;

  const api = '/api/v1/commerce';
  const probe = '/api/v1/commerce-tenant-probe';
  const http = () => request(app.getHttpServer());
  const authed = (userId: string) => ({ 'x-probe-user': userId });
  const msgOf = (body: { message?: unknown } | null | undefined): string => {
    const m = body?.message;
    return typeof m === 'string' ? m : JSON.stringify(m ?? body);
  };
  const idOr = async (
    body: { id?: unknown },
    fallback: () => Promise<{ id: string } | null>
  ): Promise<string> => {
    if (body && typeof body.id === 'string') return body.id;
    const row = await fallback();
    if (!row) throw new Error('expected a persisted row to read the id from');
    return row.id;
  };

  beforeAll(async () => {
    // Replace whichever 'jwt' strategy the shared production boot registered.
    // (`import * as passport` copies only own properties under ts-jest's CJS
    // interop, losing the prototype's `use`; require the authenticator directly.)
    const passportAuthenticator = passport as unknown as { use: (strategy: unknown) => void };
    passportAuthenticator.use(new ProbeHeaderStrategy());

    const moduleRef = await Test.createTestingModule({
      imports: [CommerceTenantE2ECoreModule],
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
  });

  // -------------------------------------------------------------------------
  // Context (the substrate every test below depends on)
  // -------------------------------------------------------------------------
  it('resolves each principal to its own tenant through the real chain', async () => {
    const a = await http().get(`${probe}/actor`).set(authed(userA1)).expect(200);
    expect(a.body.tenantId).toBe(tenantAId);
    expect(a.body.userId).toBe(userA1);
    expect(a.body.requestId).toEqual(expect.any(String));

    const b = await http().get(`${probe}/actor`).set(authed(userB1)).expect(200);
    expect(b.body.tenantId).toBe(tenantBId);
    expect(b.body.tenantId).not.toBe(a.body.tenantId);
  });

  // ---------------------------------------------------------------------------
  // Seam 3 — the test-only probe controller (line routing has no production route)
  // ---------------------------------------------------------------------------
  interface ProbeRouteRule {
    priority: number;
    targetWorkflowDefinitionVersionId: string;
    condition: unknown;
  }

  interface ProbeRoutingBody {
    versionLabel?: unknown;
    trigger?: unknown;
    noRouteBehavior?: unknown;
    multipleMatchBehavior?: unknown;
    aggregationPolicy?: unknown;
    routeRules?: unknown;
  }

  function parseRoutingBody(body: ProbeRoutingBody) {
    const routes = Array.isArray(body.routeRules) ? body.routeRules : [];
    const valid =
      typeof body.versionLabel === 'string' &&
      body.versionLabel.length > 0 &&
      body.versionLabel.length <= 64 &&
      typeof body.trigger === 'string' &&
      (WORKFLOW_TRIGGER_EVENTS as readonly string[]).includes(body.trigger) &&
      typeof body.noRouteBehavior === 'string' &&
      ['LEAVE_UNROUTED', 'REJECT_OPERATION'].includes(body.noRouteBehavior) &&
      typeof body.multipleMatchBehavior === 'string' &&
      ['HIGHEST_PRIORITY', 'AMBIGUOUS_ERROR'].includes(body.multipleMatchBehavior) &&
      typeof body.aggregationPolicy === 'string' &&
      ['ALL_APPROVED', 'INDEPENDENT'].includes(body.aggregationPolicy) &&
      routes.length > 0 &&
      routes.every(
        (route: ProbeRouteRule) =>
          route &&
          typeof route === 'object' &&
          Number.isSafeInteger(route.priority) &&
          typeof route.targetWorkflowDefinitionVersionId === 'string'
      );
    if (!valid) {
      throw new BadRequestException(
        'probe routing body is not a valid WorkflowLineRoutingVersionWrite'
      );
    }
    return {
      status: 'DRAFT' as const,
      versionLabel: body.versionLabel as string,
      trigger: body.trigger as (typeof WORKFLOW_TRIGGER_EVENTS)[number],
      noRouteBehavior: body.noRouteBehavior as 'LEAVE_UNROUTED' | 'REJECT_OPERATION',
      multipleMatchBehavior: body.multipleMatchBehavior as 'HIGHEST_PRIORITY' | 'AMBIGUOUS_ERROR',
      aggregationPolicy: body.aggregationPolicy as 'ALL_APPROVED' | 'INDEPENDENT',
      routeRules: routes as ProbeRouteRule[],
    };
  }

  @Controller('commerce-tenant-probe')
  class CommerceTenantProbeController {
    constructor(
      private readonly routingRepository: WorkflowLineRoutingRepository,
      private readonly routingConfiguration: WorkflowLineRoutingConfigurationService
    ) {}

    /** The same actor resolution every commerce route performs — never from the body. */
    @Get('actor')
    actor(@Request() req: ExRequest) {
      return resolveCommerceActor(req);
    }

    @Post('routing-versions')
    createRoutingVersion(@Request() req: ExRequest, @Body() body: ProbeRoutingBody) {
      const actor = resolveCommerceActor(req);
      return this.routingRepository.create(actor.tenantId, parseRoutingBody(body));
    }

    @Post('routing-versions/:id/publish')
    publishRoutingVersion(@Request() req: ExRequest, @Param('id') id: string) {
      const actor = resolveCommerceActor(req);
      return this.routingConfiguration.publish(actor.tenantId, id);
    }
  }

  @Module({
    imports: [CommercePrismaModule, PureRuleEngineModule],
    controllers: [
      PurchaseController,
      // PHASE C4-R (GAP-3): the completion-policy configuration routes; the close route
      // itself rides on `PurchaseController` above.
      PurchaseCompletionPolicyController,
      PaymentHistoryController,
      ReceivingHistoryController,
      ReturnHistoryController,
      CommercialController,
      WorkflowConfigurationController,
      CommerceTenantProbeController,
    ],
    providers: [
      RequestContextService,
      // production boundaries: middleware, guards, interceptor (production order)
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: TenantContextGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ModuleEntitlementGuard,
      // real commerce wiring
      CommerceIdentityGateway,
      CommerceAuditGateway,
      CommerceNotificationGateway,
    // PHASE C9 (GAP-5): the search source, wired exactly as production wires it — its
    // constructor registers it with the port provided below.
    CommerceSearchSourceService,
      CommerceUnitOfWork,
      PurchaseRepository,
      PurchaseService,
      // PHASE C7 (GAP-7): the timeline route on `PurchaseController` needs its service —
      // wired exactly as commerce.module.ts wires it (repository + audit gateway above).
      PurchaseTimelineService,
      // PHASE C4-R (GAP-3): the completion slice — the policy row's owner, its
      // configuration surface, and the one service that may move a document to CLOSED.
      PurchaseCompletionPolicyRepository,
      PurchaseCompletionPolicyService,
      PurchaseCompletionService,
      PaymentHistoryRepository,
      PaymentHistoryService,
      ReceivingHistoryRepository,
      ReceivingHistoryService,
      ReturnHistoryRepository,
      ReturnHistoryService,
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
      // the in-memory ports (seam 2)
      { provide: TenantResolver, useValue: fakeTenantResolver },
      { provide: PermissionSource, useValue: fakePermissionSource },
      { provide: ENTITLEMENT_PORT, useValue: fakeEntitlementPort },
      { provide: AUDIT_PORT, useValue: fakeAuditPort },
      { provide: SEARCH_SOURCE_PORT, useValue: createFakeSearchSourcePort() },
      { provide: USER_DIRECTORY, useValue: fakeDirectory },
      { provide: NotificationPublisher, useValue: fakeNotificationPublisher },
      // GAP-9: the gateway's second dependency — the same double (see the integration suite).
      { provide: NotificationService, useValue: fakeNotificationService },
    ],
  })
  class CommerceTenantE2ECoreModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(RequestContextMiddleware).forRoutes('*');
    }
  }

  const TENANT_CONTEXT_MESSAGE =
    'Commerce requires a tenant context; this request was not resolved to a tenant.';

  // -------------------------------------------------------------------------
  // Purchase documents (G3 path/DTO scope + G9 lists + 404 non-disclosure)
  // -------------------------------------------------------------------------
  it('creates one document per tenant through the real contract', async () => {
    const aRes = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(userA1))
      .send({
        requesterId: userA1,
        supplierId: 'SUP-A',
        currency: 'EUR',
        lines: [{ lineType: 'STANDARD', quantity: 5, unit: 'pcs', unitPrice: 10, tax: 1 }],
      })
      .expect(201);
    docA = aRes.body as TenantPurchaseDocument;
    expect(docA.id).toEqual(expect.any(String));
    expect(docA.documentNumber).toMatch(/^PR-\d{4}-\d{5}$/);
    expect(docA.status).toBe('DRAFT');
    expect(docA.lines).toHaveLength(1);
    lineA = docA.lines[0].id;

    const bRes = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(userB1))
      .send({
        requesterId: userB1,
        supplierId: 'SUP-B',
        currency: 'EUR',
        lines: [{ lineType: 'STANDARD', quantity: 3, unit: 'pcs', unitPrice: 4 }],
      })
      .expect(201);
    docB = bRes.body as TenantPurchaseDocument;
    expect(docB.id).not.toBe(docA.id);
    lineB = docB.lines[0].id;

    const storedA = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docA.id } });
    expect(storedA.tenantId).toBe(tenantAId);
    const storedB = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docB.id } });
    expect(storedB.tenantId).toBe(tenantBId);
  });

  it('G9: owner read succeeds; foreign read is 404 and indistinguishable from unknown', async () => {
    await http().get(`${api}/purchase-documents/${docA.id}`).set(authed(userA1)).expect(200);

    const foreign = await http()
      .get(`${api}/purchase-documents/${docA.id}`)
      .set(authed(userB1))
      .expect(404);
    const unknown = await http()
      .get(`${api}/purchase-documents/${randomUUID()}`)
      .set(authed(userB1))
      .expect(404);
    expect(msgOf(foreign.body)).toBe('Purchase document not found');
    expect(foreign.body).toEqual(unknown.body);
  });

  it('G3: foreign PATCH is 404 and the owner row is untouched', async () => {
    await http()
      .patch(`${api}/purchase-documents/${docA.id}`)
      .set(authed(userB1))
      .send({ supplierId: 'EVIL' })
      .expect(404);

    const after = await http()
      .get(`${api}/purchase-documents/${docA.id}`)
      .set(authed(userA1))
      .expect(200);
    expect(after.body.supplierId).toBe('SUP-A');
    const stored = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docA.id } });
    expect(stored.supplierId).toBe('SUP-A');
  });

  it('G9: lists are tenant-scoped and the requesterId filter cannot cross tenants', async () => {
    const aList = await http().get(`${api}/purchase-documents`).set(authed(userA1)).expect(200);
    expect(aList.body.items.map((item) => item.id)).toEqual([docA.id]);
    const aCount = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });
    expect(aList.body.total).toBe(aCount);

    const bList = await http().get(`${api}/purchase-documents`).set(authed(userB1)).expect(200);
    const bIds = bList.body.items.map((item) => item.id);
    expect(bIds).toContain(docB.id);
    expect(bIds).not.toContain(docA.id);
    const bCount = await db.purchaseDocument.count({ where: { tenantId: tenantBId } });
    expect(bList.body.total).toBe(bCount);

    const cross = await http()
      .get(`${api}/purchase-documents?requesterId=${userA1}`)
      .set(authed(userB1))
      .expect(200);
    expect(cross.body.items).toHaveLength(0);
    expect(cross.body.total).toBe(0);
  });

  it("G3: an update cannot adopt another tenant's requester (membership is actor-scoped)", async () => {
    const res = await http()
      .patch(`${api}/purchase-documents/${docA.id}`)
      .set(authed(userA1))
      .send({ requesterId: userB1 })
      .expect(400);
    expect(msgOf(res.body)).toContain('userId is not a member of this tenant');
    const stored = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docA.id } });
    expect(stored.requesterId).toBe(userA1);
  });

  // -------------------------------------------------------------------------
  // Payments / receipts (G3 + G9 on the sub-resource surfaces)
  // -------------------------------------------------------------------------
  it('G3/G9: payment history is scoped — foreign list/append/compensate are 404 with no writes', async () => {
    const created = await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 25, method: 'CASH' })
      .expect(201);
    payA =
      created.body.id ??
      (await db.paymentRecord.findFirstOrThrow({ where: { tenantId: tenantAId } })).id;
    expect(payA).toEqual(expect.any(String));

    await http()
      .get(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userB1))
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userB1))
      .send({ amount: 5, method: 'CASH' })
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/payments/${payA}/compensate`)
      .set(authed(userB1))
      .send({ reason: 'not mine' })
      .expect(404);

    expect(await db.paymentRecord.count({ where: { tenantId: tenantBId } })).toBe(0);
    expect(await db.paymentRecord.count({ where: { tenantId: tenantAId } })).toBe(1);

    const aList = await http()
      .get(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .expect(200);
    expect(JSON.stringify(aList.body)).toContain(payA);
  });

  it('G3/G9: receipts are scoped — foreign list/append/compensate are 404 with no writes', async () => {
    await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 2 }] })
      .expect(201);
    receiptLineA = (await db.receiptLine.findFirstOrThrow({ where: { tenantId: tenantAId } })).id;

    await http()
      .get(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userB1))
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userB1))
      .send({ lines: [{ purchaseLineId: lineB, quantity: 1 }] })
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts/${receiptLineA}/compensate`)
      .set(authed(userB1))
      .send({ quantity: 1, reason: 'not mine' })
      .expect(404);

    expect(await db.receipt.count({ where: { tenantId: tenantBId } })).toBe(0);
    expect(await db.receiptLine.count({ where: { tenantId: tenantBId } })).toBe(0);
    expect(await db.receiptLine.count({ where: { tenantId: tenantAId } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Returns (G3)
  // -------------------------------------------------------------------------
  it('G3/G9: returns are scoped — foreign create/list/approve/refund are 404 with no writes', async () => {
    const created = await http()
      .post(`${api}/purchase-documents/${docA.id}/returns`)
      .set(authed(userA1))
      .send({
        reason: 'damaged carton',
        replacementRequired: false,
        lines: [{ purchaseLineId: lineA, receiptLineId: receiptLineA, quantity: 1 }],
      })
      .expect(201);
    retA =
      created.body?.id ??
      (await db.returnDocument.findFirstOrThrow({ where: { tenantId: tenantAId } })).id;

    await http()
      .get(`${api}/purchase-documents/${docA.id}/returns`)
      .set(authed(userB1))
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/approve`)
      .set(authed(userB1))
      .send({})
      .expect(404);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/refund`)
      .set(authed(userB1))
      .send({ paymentId: payA })
      .expect(404);

    expect(await db.returnDocument.count({ where: { tenantId: tenantBId } })).toBe(0);
    expect(await db.returnLifecycleTransition.count({ where: { tenantId: tenantBId } })).toBe(0);
  });

  it("G3: a return line cannot reference another tenant's purchase/receipt lines", async () => {
    const docB2Res = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(userB1))
      .send({
        requesterId: userB1,
        lines: [{ lineType: 'STANDARD', quantity: 3, unit: 'pcs', unitPrice: 4 }],
      })
      .expect(201);
    expect(docB2Res.body.id).toEqual(expect.any(String));

    const res = await http()
      .post(`${api}/purchase-documents/${docB2Res.body.id}/returns`)
      .set(authed(userB1))
      .send({
        reason: 'cross-tenant attempt',
        replacementRequired: false,
        lines: [{ purchaseLineId: lineA, receiptLineId: receiptLineA, quantity: 1 }],
      })
      .expect(404);
    expect(msgOf(res.body)).toBe('Purchase line not found');
    expect(await db.returnLine.count({ where: { tenantId: tenantBId } })).toBe(0);
  });

  it('G9: owner completes approve → receive-back → refund (the 404s above were scoped, not vacuous)', async () => {
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/approve`)
      .set(authed(userA1))
      .send({ reason: 'approved' })
      .expect(201);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/receive-back`)
      .set(authed(userA1))
      .expect(201);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/refund`)
      .set(authed(userA1))
      .send({ paymentId: payA, reason: 'refunded' })
      .expect(201);

    const transitions = await db.returnLifecycleTransition.findMany({
      where: { returnDocumentId: retA },
    });
    const states = new Set(transitions.map((t) => t.state));
    expect(states.has('APPROVED')).toBe(true);
    expect(states.has('RECEIVED_BACK')).toBe(true);
    expect(states.has('REFUNDED')).toBe(true);
    expect(await db.returnLifecycleTransition.count({ where: { tenantId: tenantBId } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Commercial configuration (G5 reads/writes + G6 DTO-supplied scope)
  // -------------------------------------------------------------------------
  it('G5: commercial groups are per tenant; foreign get/patch 404 like unknown; lists disjoint', async () => {
    const codeA = `grp-a-${runId}`;
    const aRes = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userA1))
      .send({
        code: codeA,
        name: 'Group A',
        // §3-K's liaison: the identity an assignment to this group resolves. Without one
        // the submit that matches this group rolls back (COMMERCIAL_LIAISON_NOT_CONFIGURED)
        // rather than assigning the line to nobody — so a usable group states it.
        liaisonUserId: userA2,
      })
      .expect(201);
    grA = await idOr(aRes.body, () =>
      db.commercialGroup.findFirst({ where: { tenantId: tenantAId, code: codeA } })
    );

    const bRes = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userB1))
      .send({ code: `grp-b-${runId}`, name: 'Group B' })
      .expect(201);
    grB = await idOr(bRes.body, () =>
      db.commercialGroup.findFirst({ where: { tenantId: tenantBId } })
    );
    expect(grA).not.toBe(grB);

    const aList = await http().get(`${api}/commercial-groups`).set(authed(userA1)).expect(200);
    const aText = JSON.stringify(aList.body);
    expect(aText).toContain(grA);
    expect(aText).not.toContain(grB);
    const bList = await http().get(`${api}/commercial-groups`).set(authed(userB1)).expect(200);
    const bText = JSON.stringify(bList.body);
    expect(bText).toContain(grB);
    expect(bText).not.toContain(grA);

    const foreign = await http()
      .get(`${api}/commercial-groups/${grA}`)
      .set(authed(userB1))
      .expect(404);
    const unknown = await http()
      .get(`${api}/commercial-groups/${randomUUID()}`)
      .set(authed(userB1))
      .expect(404);
    expect(foreign.body).toEqual(unknown.body);

    await http()
      .patch(`${api}/commercial-groups/${grA}`)
      .set(authed(userB1))
      .send({ name: 'hijacked' })
      .expect(404);
    const stored = await db.commercialGroup.findUniqueOrThrow({ where: { id: grA } });
    expect(stored.name).toBe('Group A');
  });

  it('G5: A creates, validates and publishes a configuration; B cannot read it', async () => {
    const cfgLabel = `cfg-a-${runId}`;
    const created = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userA1))
      .send({
        versionLabel: cfgLabel,
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [{ label: 'rule-a', priority: 1, commercialGroupId: grA }],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userA2,
        projectionPolicy: 'ALL_LINES',
      })
      .expect(201);
    cfgA = await idOr(created.body, () =>
      db.commercialConfigurationVersion.findFirst({
        where: { tenantId: tenantAId, versionLabel: cfgLabel },
      })
    );

    // 200, not 201: validate and publish change the state of a row the caller already
    // named — no new addressable row appears, which is the contract's own distinction.
    await http()
      .post(`${api}/commercial-configurations/${cfgA}/validate`)
      .set(authed(userA1))
      .expect(200);
    const published = await http()
      .post(`${api}/commercial-configurations/${cfgA}/publish`)
      .set(authed(userA1))
      .expect(200);
    expect(JSON.stringify(published.body)).toContain('PUBLISHED');
    const stored = await db.commercialConfigurationVersion.findUniqueOrThrow({
      where: { id: cfgA },
    });
    expect(stored.status).toBe('PUBLISHED');
    expect(stored.tenantId).toBe(tenantAId);

    const bList = await http()
      .get(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .expect(200);
    expect(JSON.stringify(bList.body)).not.toContain(cfgA);
    const foreign = await http()
      .get(`${api}/commercial-configurations/${cfgA}`)
      .set(authed(userB1))
      .expect(404);
    expect(foreign.status).toBe(404);
  });

  it("G6: B's configuration cannot put A's group in force — §7.3 refuses it at the checklist", async () => {
    // A DRAFT is permissive by design (§7's structural checks run at validate/publish), so
    // B may WRITE a foreign id into a draft and still never make it mean anything: the
    // refusal is asserted where the contract puts it, and nothing of B's reaches force.
    const labelB = `cfg-b1-${runId}`;
    const created = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .send({
        versionLabel: labelB,
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [{ label: 'rule-b', priority: 1, commercialGroupId: grA }],
        approvalActivation: 'NOT_REQUIRED',
        projectionPolicy: 'ALL_LINES',
      })
      .expect(201);
    const draftB = await idOr(created.body, () =>
      db.commercialConfigurationVersion.findFirst({
        where: { tenantId: tenantBId, versionLabel: labelB },
      })
    );

    const refused = await http()
      .post(`${api}/commercial-configurations/${draftB}/validate`)
      .set(authed(userB1))
      .expect(409);
    expect(msgOf(refused.body)).toContain('commercialGroupId does not exist in this tenant');
    // Publish runs the same checklist, so it refuses identically rather than validating the
    // draft as a side effect.
    await http()
      .post(`${api}/commercial-configurations/${draftB}/publish`)
      .set(authed(userB1))
      .expect(409);

    expect(
      await db.commercialConfigurationVersion.count({
        where: { tenantId: tenantBId, status: 'PUBLISHED' },
      })
    ).toBe(0);
    expect(
      (await db.commercialConfigurationVersion.findUniqueOrThrow({ where: { id: draftB } })).status
    ).toBe('DRAFT');
    expect(
      await db.commercialConfigurationVersion.count({
        where: { tenantId: tenantAId, status: 'PUBLISHED' },
      })
    ).toBe(1);
  });

  it("G6: B's configuration cannot name A's approver — §7.5, where the checklist runs", async () => {
    const labelB = `cfg-b2-${runId}`;
    const created = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .send({
        versionLabel: labelB,
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [{ label: 'rule-b2', priority: 1, commercialGroupId: grB }],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userA1,
        projectionPolicy: 'ALL_LINES',
      })
      .expect(201);
    const draftB = await idOr(created.body, () =>
      db.commercialConfigurationVersion.findFirst({
        where: { tenantId: tenantBId, versionLabel: labelB },
      })
    );

    const refused = await http()
      .post(`${api}/commercial-configurations/${draftB}/validate`)
      .set(authed(userB1))
      .expect(409);
    expect(msgOf(refused.body)).toContain('approverUserId is not a member of this tenant');
    expect(
      (await db.commercialConfigurationVersion.findUniqueOrThrow({ where: { id: draftB } })).status
    ).toBe('DRAFT');
    expect(
      await db.commercialConfigurationVersion.count({
        where: { tenantId: tenantBId, status: 'PUBLISHED' },
      })
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Workflow configuration + line routing (G8, plus G3/G6 on the surface)
  // -------------------------------------------------------------------------
  async function seedPublishedWorkflow(
    user: string,
    tenant: string,
    tag: string,
    approver: string
  ) {
    const code = `wf-${tag}-${runId}`;
    const defRes = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(user))
      .send({ code, name: `Workflow ${tag}` })
      .expect(201);
    const defId = await idOr(defRes.body, () =>
      db.workflowDefinition.findFirst({ where: { tenantId: tenant, code } })
    );

    const verRes = await http()
      .post(`${api}/workflow-definitions/${defId}/versions`)
      .set(authed(user))
      .send({ versionLabel: `v1-${tag}-${runId}`, triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    const verId = await idOr(verRes.body, () =>
      db.workflowDefinitionVersion.findFirst({
        where: { tenantId: tenant, workflowDefinitionId: defId },
      })
    );

    const stepRes = await http()
      .post(`${api}/workflow-versions/${verId}/steps`)
      .set(authed(user))
      .send({
        stepKey: 'approve',
        displayName: 'Approve',
        ordering: 1,
        actorSource: 'CONFIGURED_USER',
        actorUserId: approver,
      })
      .expect(201);
    const stepId = await idOr(stepRes.body, () =>
      db.workflowStep.findFirst({ where: { tenantId: tenant, stepKey: 'approve' } })
    );

    // 200, not 201: the version already exists; these edges walk its state
    // (DRAFT → VALIDATED → PUBLISHED) and create no new addressable row.
    await http().post(`${api}/workflow-versions/${verId}/validate`).set(authed(user)).expect(200);
    await http().post(`${api}/workflow-versions/${verId}/publish`).set(authed(user)).expect(200);
    const stored = await db.workflowDefinitionVersion.findUniqueOrThrow({ where: { id: verId } });
    expect(stored.status).toBe('PUBLISHED');
    expect(stored.tenantId).toBe(tenant);
    return { defId, verId, stepId };
  }

  it('G8: each tenant creates and publishes its own definition/version/steps', async () => {
    wfA = await seedPublishedWorkflow(userA1, tenantAId, 'a', userA2);
    wfB = await seedPublishedWorkflow(userB1, tenantBId, 'b', userB1);
    expect(wfA.verId).not.toBe(wfB.verId);
    expect(wfA.stepId).not.toBe(wfB.stepId);
  });

  it('G3/G9: workflow configuration is tenant-scoped (404s, disjoint lists, no cross writes)', async () => {
    const bDefs = await http().get(`${api}/workflow-definitions`).set(authed(userB1)).expect(200);
    const bText = JSON.stringify(bDefs.body);
    expect(bText).toContain(wfB.defId);
    expect(bText).not.toContain(wfA.defId);

    const foreign = await http()
      .get(`${api}/workflow-definitions/${wfA.defId}`)
      .set(authed(userB1))
      .expect(404);
    const unknown = await http()
      .get(`${api}/workflow-definitions/${randomUUID()}`)
      .set(authed(userB1))
      .expect(404);
    expect(foreign.body).toEqual(unknown.body);

    await http()
      .post(`${api}/workflow-definitions/${wfA.defId}/versions`)
      .set(authed(userB1))
      .send({ versionLabel: `evil-${runId}` })
      .expect(404);
    await http()
      .post(`${api}/workflow-versions/${wfA.verId}/steps`)
      .set(authed(userB1))
      .send({
        stepKey: 'evil',
        displayName: 'Evil',
        ordering: 9,
        actorSource: 'CONFIGURED_USER',
        actorUserId: userB1,
      })
      .expect(404);
    await http()
      .post(`${api}/workflow-versions/${wfA.verId}/publish`)
      .set(authed(userB1))
      .expect(404);
    await http()
      .post(`${api}/workflow-versions/${wfA.verId}/validate`)
      .set(authed(userB1))
      .expect(404);

    expect(await db.workflowStep.count({ where: { workflowDefinitionVersionId: wfA.verId } })).toBe(
      1
    );
    expect(await db.workflowStep.count({ where: { tenantId: tenantBId } })).toBe(1);
    expect(
      await db.workflowDefinitionVersion.count({
        where: { tenantId: tenantBId, status: 'PUBLISHED' },
      })
    ).toBe(1);
  });

  it("G6: B cannot configure A's user as a workflow actor on B's own version", async () => {
    // A FRESH draft, because a PUBLISHED version refuses every content edit (409) BEFORE any
    // actor is judged — the membership refusal is only observable where content may still
    // change, and the published version is asserted untouched below.
    const draftLabel = `g6-draft-${runId}`;
    const draftRes = await http()
      .post(`${api}/workflow-definitions/${wfB.defId}/versions`)
      .set(authed(userB1))
      .send({ versionLabel: draftLabel, triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    const draftVerId = await idOr(draftRes.body, () =>
      db.workflowDefinitionVersion.findFirst({
        where: { tenantId: tenantBId, versionLabel: draftLabel },
      })
    );

    const res = await http()
      .post(`${api}/workflow-versions/${draftVerId}/steps`)
      .set(authed(userB1))
      .send({
        stepKey: 'approve-2',
        displayName: 'Approve 2',
        ordering: 1,
        actorSource: 'CONFIGURED_USER',
        actorUserId: userA1,
      })
      .expect(400);
    expect(msgOf(res.body)).toContain('userId is not a member of this tenant');
    // A's user entered NO version: the draft took no step, and B's published one is intact.
    expect(
      await db.workflowStep.count({ where: { workflowDefinitionVersionId: draftVerId } })
    ).toBe(0);
    expect(await db.workflowStep.count({ where: { workflowDefinitionVersionId: wfB.verId } })).toBe(
      1
    );
  });

  it('G3/G8: line routing publishes per tenant; a foreign target is refused (409) and stays DRAFT', async () => {
    const routingBody = (tag: string, targetId: string) => ({
      versionLabel: `rt-${tag}-${runId}`,
      trigger: 'PURCHASE_SUBMITTED',
      noRouteBehavior: 'LEAVE_UNROUTED',
      multipleMatchBehavior: 'HIGHEST_PRIORITY',
      aggregationPolicy: 'ALL_APPROVED',
      routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: targetId, condition: null }],
    });

    const aRes = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userA1))
      .send(routingBody('a', wfA.verId))
      .expect(201);
    routeA = aRes.body.id;
    expect(routeA).toEqual(expect.any(String));
    await http()
      .post(`${probe}/routing-versions/${routeA}/publish`)
      .set(authed(userA1))
      .expect(201);
    const aStored = await db.workflowLineRoutingVersion.findUniqueOrThrow({
      where: { id: routeA },
    });
    expect(aStored.status).toBe('PUBLISHED');
    expect(aStored.tenantId).toBe(tenantAId);

    // B's draft points at A's published version — refused by the tenant-scoped target check.
    const badRes = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userB1))
      .send(routingBody('bad', wfA.verId))
      .expect(201);
    routeBDraft = badRes.body.id;
    const refused = await http()
      .post(`${probe}/routing-versions/${routeBDraft}/publish`)
      .set(authed(userB1))
      .expect(409);
    expect(msgOf(refused.body)).toContain('belongs to another tenant');
    const badStored = await db.workflowLineRoutingVersion.findUniqueOrThrow({
      where: { id: routeBDraft },
    });
    expect(badStored.status).toBe('DRAFT');

    // B's own routing to B's own version publishes fine.
    const bRes = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userB1))
      .send(routingBody('b', wfB.verId))
      .expect(201);
    routeB = bRes.body.id;
    await http()
      .post(`${probe}/routing-versions/${routeB}/publish`)
      .set(authed(userB1))
      .expect(201);
    const bStored = await db.workflowLineRoutingVersion.findUniqueOrThrow({
      where: { id: routeB },
    });
    expect(bStored.status).toBe('PUBLISHED');
    expect(bStored.tenantId).toBe(tenantBId);
  });

  it("G8: submit routes each tenant's lines to its own published version and its own approver", async () => {
    // 200, not 201: submit moves a state the caller already named. The workflow instances
    // the routing writes are the route's effect, not its subject (the controller's note).
    const aSubmit = await http()
      .post(`${api}/purchase-documents/${docA.id}/submit`)
      .set(authed(userA1))
      .expect(200);
    expect(aSubmit.body.status).toBe('SUBMITTED');
    const bSubmit = await http()
      .post(`${api}/purchase-documents/${docB.id}/submit`)
      .set(authed(userB1))
      .expect(200);
    expect(bSubmit.body.status).toBe('SUBMITTED');

    const instA = await db.workflowInstance.findMany({ where: { tenantId: tenantAId } });
    expect(instA).toHaveLength(1);
    expect(instA[0].subjectId).toBe(lineA);
    expect(instA[0].subjectType).toBe('PURCHASE_LINE');
    expect(instA[0].workflowDefinitionVersionId).toBe(wfA.verId);

    const instB = await db.workflowInstance.findMany({ where: { tenantId: tenantBId } });
    expect(instB).toHaveLength(1);
    expect(instB[0].subjectId).toBe(lineB);
    expect(instB[0].workflowDefinitionVersionId).toBe(wfB.verId);
    expect(instB[0].id).not.toBe(instA[0].id);

    const stepInstA = await db.workflowStepInstance.findMany({ where: { tenantId: tenantAId } });
    expect(stepInstA).toHaveLength(1);
    expect(stepInstA[0].resolvedApproverId).toBe(userA2);
    const stepInstB = await db.workflowStepInstance.findMany({ where: { tenantId: tenantBId } });
    expect(stepInstB).toHaveLength(1);
    expect(stepInstB[0].resolvedApproverId).toBe(userB1);
  });

  it("G5: A's submit pins assignment/approval rows to A; B cannot list or decide them", async () => {
    const assignCountA = await db.commercialAssignment.count({ where: { tenantId: tenantAId } });
    expect(assignCountA).toBeGreaterThan(0);
    expect(
      await db.commercialAssignment.count({
        where: { tenantId: tenantAId, purchaseDocumentId: docA.id },
      })
    ).toBe(assignCountA);

    const bAssign = await http()
      .get(`${api}/commercial-assignments?documentId=${docA.id}`)
      .set(authed(userB1))
      .expect(404);
    expect(msgOf(bAssign.body)).toBe('Purchase document not found');
    expect(await db.commercialAssignment.count({ where: { tenantId: tenantBId } })).toBe(0);

    const aAssign = await http()
      .get(`${api}/commercial-assignments?documentId=${docA.id}`)
      .set(authed(userA1))
      .expect(200);
    expect(aAssign.body).toBeTruthy();

    const bApprovals = await http()
      .get(`${api}/commercial-approvals?documentId=${docA.id}`)
      .set(authed(userB1))
      .expect(404);
    expect(msgOf(bApprovals.body)).toBe('Purchase document not found');

    approvalA = (
      await db.commercialApproval.findFirstOrThrow({
        where: { tenantId: tenantAId, purchaseDocumentId: docA.id },
      })
    ).id;
    expect(await db.commercialApproval.count({ where: { tenantId: tenantBId } })).toBe(0);

    await http()
      .post(`${api}/commercial-approvals/${approvalA}/decision`)
      .set(authed(userB1))
      .send({ decision: 'APPROVED', comment: 'cross-tenant' })
      .expect(404);
    expect(
      (await db.commercialApproval.findUniqueOrThrow({ where: { id: approvalA } })).status
    ).toBe('PENDING');
  });

  it('G5: the configured approver of A decides (200) — the foreign 404 above was scoped, not vacuous', async () => {
    const decided = await http()
      .post(`${api}/commercial-approvals/${approvalA}/decision`)
      .set(authed(userA2))
      .send({ decision: 'APPROVED', comment: 'ok' })
      .expect(200);
    expect(decided.body).toBeTruthy();
    const stored = await db.commercialApproval.findUniqueOrThrow({ where: { id: approvalA } });
    expect(stored.status).toBe('APPROVED');
    expect(stored.decidedByUserId).toBe(userA2);
    expect(stored.tenantId).toBe(tenantAId);
  });

  // -------------------------------------------------------------------------
  // G4 — the number counter, G7 — missing tenant context, seam assertions
  // -------------------------------------------------------------------------
  it('G4: document-number sequences are per (tenant, kind, year), never global', async () => {
    const aRes = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(userA1))
      .send({ requesterId: userA1, lines: [{ lineType: 'SERVICE', quantity: 1, unitPrice: 1 }] })
      .expect(201);
    const bRes = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(userB1))
      .send({ requesterId: userB1, lines: [{ lineType: 'SERVICE', quantity: 1, unitPrice: 1 }] })
      .expect(201);

    const seqOf = (number: string) => parseInt(number.split('-')[2], 10);
    const docsA = await db.purchaseDocument.count({ where: { tenantId: tenantAId } });
    const docsB = await db.purchaseDocument.count({ where: { tenantId: tenantBId } });
    // Unequal totals with equal per-tenant sequences: a shared counter cannot satisfy both.
    expect(docsA).toBe(2);
    expect(docsB).toBe(3);
    expect(seqOf(aRes.body.documentNumber)).toBe(docsA);
    expect(seqOf(bRes.body.documentNumber)).toBe(docsB);
    expect(seqOf(docA.documentNumber)).toBe(1);
    expect(seqOf(docB.documentNumber)).toBe(1);

    const cA = await db.purchaseDocumentCounter.findMany({ where: { tenantId: tenantAId } });
    const cB = await db.purchaseDocumentCounter.findMany({ where: { tenantId: tenantBId } });
    expect(cA).toHaveLength(1);
    expect(cB).toHaveLength(1);
    expect(cA[0].counter).toBe(docsA);
    expect(cB[0].counter).toBe(docsB);
    expect(cA[0].id).not.toBe(cB[0].id);
    expect(cA[0].kind).toBe('PURCHASE_REQUEST');
    expect(cA[0].jalaliYear).toBe(cB[0].jalaliYear);
  });

  it('G7: an authenticated principal with no resolvable tenant is refused by Commerce itself', async () => {
    const before = await db.purchaseDocument.count();

    const actor = await http().get(`${probe}/actor`).set(authed(unresolvedUserId)).expect(403);
    expect(msgOf(actor.body)).toBe(TENANT_CONTEXT_MESSAGE);

    const create = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(unresolvedUserId))
      .send({ requesterId: userA1, lines: [{ lineType: 'STANDARD', quantity: 1, unitPrice: 1 }] })
      .expect(403);
    expect(msgOf(create.body)).toBe(TENANT_CONTEXT_MESSAGE);

    const list = await http()
      .get(`${api}/purchase-documents`)
      .set(authed(unresolvedUserId))
      .expect(403);
    expect(msgOf(list.body)).toBe(TENANT_CONTEXT_MESSAGE);

    expect(await db.purchaseDocument.count()).toBe(before);
  });

  it('without a principal the JWT layer answers first (401), before any tenant logic', async () => {
    const res = await http().get(`${api}/purchase-documents`).expect(401);
    expect(msgOf(res.body)).toContain('Invalid or expired token');
  });

  it('seam: every audit event and notification carries a known tenant; B writes are tagged B', async () => {
    for (const event of auditEvents) {
      expect([tenantAId, tenantBId]).toContain(event.tenantId);
    }
    const aEvents = auditEvents.filter((event) => event.resourceId === docA.id);
    const bEvents = auditEvents.filter((event) => event.resourceId === docB.id);
    expect(aEvents.length).toBeGreaterThan(0);
    expect(bEvents.length).toBeGreaterThan(0);
    for (const event of aEvents) expect(event.tenantId).toBe(tenantAId);
    for (const event of bEvents) expect(event.tenantId).toBe(tenantBId);

    const noteA = notifications.find((n) => n.payload.documentId === docA.id);
    const noteB = notifications.find((n) => n.payload.documentId === docB.id);
    expect(noteA).toBeDefined();
    expect(noteB).toBeDefined();
    expect(noteA!.payload.tenantId).toBe(tenantAId);
    expect(noteB!.payload.tenantId).toBe(tenantBId);
    for (const note of notifications) {
      expect([tenantAId, tenantBId]).toContain(note.payload.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // Cleanup — test-only, tenant-scoped, explicit predicates; no TRUNCATE
  // -------------------------------------------------------------------------
  afterAll(async () => {
    if (!db) {
      if (app) await app.close();
      return;
    }
    const where = { tenantId: { in: [tenantAId, tenantBId] } };
    const deleted: Record<string, number> = {};
    deleted.returnLine = (await db.returnLine.deleteMany({ where })).count;
    deleted.returnLifecycleTransition = (
      await db.returnLifecycleTransition.deleteMany({ where })
    ).count;
    deleted.returnDocument = (await db.returnDocument.deleteMany({ where })).count;
    deleted.receiptLine = (await db.receiptLine.deleteMany({ where })).count;
    deleted.receipt = (await db.receipt.deleteMany({ where })).count;
    deleted.paymentRecord = (await db.paymentRecord.deleteMany({ where })).count;
    deleted.commercialApproval = (await db.commercialApproval.deleteMany({ where })).count;
    deleted.commercialAssignmentHistory = (
      await db.commercialAssignmentHistory.deleteMany({ where })
    ).count;
    deleted.commercialAssignment = (await db.commercialAssignment.deleteMany({ where })).count;
    deleted.workflowStepInstance = (await db.workflowStepInstance.deleteMany({ where })).count;
    deleted.workflowInstance = (await db.workflowInstance.deleteMany({ where })).count;
    // AFTER the documents, deliberately: §3-B's commercial PIN and O4's routing PIN are foreign
    // keys ON the document row (`PurchaseDocument.commercial_configuration_version_id` and
    // `PurchaseDocument.line_routing_version_id`, both ON DELETE RESTRICT), so a submitted
    // document keeps the versions it pinned alive until the document itself is gone — and the
    // groups wait for the versions that name them.
    deleted.purchaseLine = (await db.purchaseLine.deleteMany({ where })).count;
    deleted.purchaseDocument = (await db.purchaseDocument.deleteMany({ where })).count;
    deleted.workflowLineRoutingVersion = (
      await db.workflowLineRoutingVersion.deleteMany({ where })
    ).count;
    deleted.workflowStep = (await db.workflowStep.deleteMany({ where })).count;
    deleted.workflowDefinitionVersion = (
      await db.workflowDefinitionVersion.deleteMany({ where })
    ).count;
    deleted.workflowDefinition = (await db.workflowDefinition.deleteMany({ where })).count;
    deleted.commercialConfigurationVersion = (
      await db.commercialConfigurationVersion.deleteMany({ where })
    ).count;
    deleted.commercialGroup = (await db.commercialGroup.deleteMany({ where })).count;
    deleted.purchaseDocumentCounter = (
      await db.purchaseDocumentCounter.deleteMany({ where })
    ).count;

    expect(deleted.purchaseDocument).toBeGreaterThanOrEqual(5);
    expect(deleted.workflowInstance).toBeGreaterThanOrEqual(2);
    expect(await db.purchaseDocument.count({ where })).toBe(0);
    expect(await db.workflowInstance.count({ where })).toBe(0);
    await app.close();
  });
});
