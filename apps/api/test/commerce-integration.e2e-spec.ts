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
// GAP-9: the user-addressed Core contract (the gateway holds it; the harness binds a
// contract-driven double over the SAME in-memory tenant registry).
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
const userA3 = randomUUID();
const userB1 = randomUUID();

/**
 * An authenticated principal deliberately absent from `tenantRegistry` (G7):
 * every consumer in this suite sends it, so it stays read (never assigned-never-used).
 */
function unresolvedUserId(): string {
  return randomUUID();
}

const tenantRegistry = new Map<string, string>([
  [userA1, tenantAId],
  [userA2, tenantAId],
  [userA3, tenantAId],
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
 * resolver and the directory port use — so a recipient this harness knows is a recipient
 * the double accepts, and a cross-tenant recipient is refused exactly as Core refuses
 * one. Contract-driven: see `test/fixtures/fake-notification-service.ts`.
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

/**
 * Response shapes the Step-W surfaces project (document, payments,
 * receiving, returns, commercial approvals, workflow versions). The HTTP
 * body is `any` at the supertest boundary; these interfaces pin, per
 * SURFACE, the fields a test below actually reads — nothing more.
 */
interface IntegrationDocumentLine {
  id: string;
}

interface IntegrationPurchaseDocument {
  id: string;
  status: string;
  totalAmount: string | number;
  editable?: boolean;
  lines: IntegrationDocumentLine[];
  requester: { id: string; profile?: { id: string } | null };
}

interface IntegrationPaymentProjection {
  paymentStatus: { status: string; paidAmount: string | number };
  items?: unknown;
}

interface IntegrationReceivingLine {
  id: string;
  purchaseLineId: string;
  receivingStatus: string;
  receivedQuantity: string | number;
}

interface IntegrationReceivingProjection {
  lines: IntegrationReceivingLine[];
}

interface IntegrationApprovalProjection {
  id: string;
  status: string;
}

interface IntegrationApprovalListing {
  approvals: IntegrationApprovalProjection[];
  items?: unknown;
}

interface IntegrationReturnProjection {
  returns: Array<{ id: string; state: string }>;
}

interface WorkflowVersionProjection {
  status: string;
  steps: Array<{ stepKey: string }>;
}

describe('Commerce procurement integration e2e (Step W): the required domain tests driven end to end.', () => {
  let app: INestApplication;
  let db: CommercePrismaService;

  let docA: IntegrationPurchaseDocument;
  let lineA: string;
  let payA: string;
  let receiptLineA: string;
  let retA: string;
  let grA: string;
  let grB: string;
  let cfgA: string;
  let verSingle: string;
  let verGateA: string;
  let verGateB: string;
  let gateADefId: string;
  let routeA: string;
  let routeB: string;

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

  it('G7: an authenticated principal with no resolvable tenant is refused by Commerce itself', async () => {
    const guestId = unresolvedUserId();
    const actor = await http().get(`${probe}/actor`).set(authed(guestId)).expect(403);
    expect(msgOf(actor.body)).toBe(TENANT_CONTEXT_MESSAGE);
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

  /**
   * Seam 3 — the test-only probe controller.
   *
   * TWO surfaces C1 has no production route for are reached here through the SAME services
   * the production module wires: line-routing CONFIGURATION (authored by an admin UI that does
   * not exist yet) and a step DECISION (made from an approver inbox that does not exist yet).
   * Both resolve the actor exactly as every commerce route does — from the request, never from
   * the body — so a probe call writes what the future route will write and nothing it would not.
   */
  @Controller('commerce-tenant-probe')
  class CommerceTenantProbeController {
    constructor(
      private readonly routingRepository: WorkflowLineRoutingRepository,
      private readonly routingConfiguration: WorkflowLineRoutingConfigurationService,
      private readonly execution: WorkflowExecutionService
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

    /**
     * Decide one step of a running instance: the approver's own act, with the approver's own
     * principal. `approveStep` refuses when the acting user is not the step's RESOLVED
     * approver, so this route cannot be used to approve on somebody else's behalf.
     */
    @Post('workflow-instances/:id/steps/:stepKey/approve')
    approveStep(
      @Request() req: ExRequest,
      @Param('id') id: string,
      @Param('stepKey') stepKey: string,
      @Body() body: { comment?: string | null }
    ) {
      const actor = resolveCommerceActor(req);
      return this.execution.approveStep(actor, id, stepKey, body?.comment ?? null);
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
      // GAP-9: the gateway's second dependency — the same double, so a submit/decision in
      // this suite exercises the real recipient resolution and the real gateway path.
      { provide: NotificationService, useValue: fakeNotificationService },
    ],
  })
  class CommerceTenantE2ECoreModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(RequestContextMiddleware).forRoutes('*');
    }
  }

  // =========================================================================
  // Step W -- the real procurement process, end to end (sections 24, 25, 27, 28)
  //
  // WHAT THIS SUITE PROVES, and what each section asks for:
  //
  //   S28  ONE purchase document whose lines go to DIFFERENT commercial actors, without
  //        becoming three purchase documents. The route condition is evaluated per line
  //        against that line's own facts, so the aggregate stays the aggregate.
  //   S27  The ORDER of the steps is configuration, not code: the same release walks
  //        Requester -> Planning -> Commercial and Requester -> Commercial -> Planning,
  //        chosen by the routing configuration alone.
  //   S25  A published version does not change when another version is authored and
  //        published -- and a document already running stays on the version it pinned.
  //   S24  A mixed STANDARD / NON_STANDARD / SERVICE request, sequential steps, different
  //        actors per line, partial receipt, over-receipt refusal, partial and repeated and
  //        compensating payments, and a return child lifecycle -- all on that ONE document.
  //
  // The harness is Step U's (and Step V's): the real boundary stack, the real commerce_db,
  // in-memory platform ports, and the test-only probe for the two surfaces C1 has no HTTP
  // route for (routing configuration, and a step decision).
  // =========================================================================

  let verSingle: string;
  let verGateA: string;
  let verGateB: string;
  let gateADefId: string;
  let verGateB1: string;
  let verGateA1: string;

  // -------------------------------------------------------------------------
  // Read helpers -- each asks the surface that owns the dimension
  // -------------------------------------------------------------------------
  const getDoc = async (
    documentId: string,
    as: string = userA1
  ): Promise<IntegrationPurchaseDocument> =>
    (
      await http().get(`${api}/purchase-documents/${documentId}`).set(authed(as)).expect(200)
    ).body as IntegrationPurchaseDocument;

  const getApprovals = async (
    documentId: string,
    as: string = userA1
  ): Promise<IntegrationApprovalListing> =>
    (
      await http()
        .get(`${api}/commercial-approvals?documentId=${documentId}`)
        .set(authed(as))
        .expect(200)
    ).body as IntegrationApprovalListing;

  const getReceipts = async (documentId: string): Promise<IntegrationReceivingProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/receipts`)
        .set(authed(userA1))
        .expect(200)
    ).body as IntegrationReceivingProjection;

  const getPayments = async (documentId: string): Promise<IntegrationPaymentProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/payments`)
        .set(authed(userA1))
        .expect(200)
    ).body as IntegrationPaymentProjection;

  const getReturns = async (documentId: string): Promise<IntegrationReturnProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/returns`)
        .set(authed(userA1))
        .expect(200)
    ).body as IntegrationReturnProjection;

  /** The LINE-level instance a submit created for this line (only lines are routed). */
  const instanceFor = (lineId: string, tenantId: string = tenantAId) =>
    db.workflowInstance.findFirstOrThrow({
      where: { tenantId, subjectType: 'PURCHASE_LINE', subjectId: lineId },
    });

  const approveStep = (instanceId: string, stepKey: string, asUser: string) =>
    http()
      .post(`${probe}/workflow-instances/${instanceId}/steps/${stepKey}/approve`)
      .set(authed(asUser))
      .send({ comment: null });

  const submitDoc = (documentId: string, as: string = userA1) =>
    http().post(`${api}/purchase-documents/${documentId}/submit`).set(authed(as));

  /**
   * A definition, one version, and its steps IN ORDER, walked through the version's own
   * lifecycle routes -- created, validated and published by the tenant that will use it.
   */
  const publishWorkflow = async (
    as: string,
    code: string,
    steps: readonly { stepKey: string; actorUserId: string }[]
  ) => {
    const def = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(as))
      .send({ code, name: `W ${code}` })
      .expect(201);
    const version = await http()
      .post(`${api}/workflow-definitions/${def.body.id}/versions`)
      .set(authed(as))
      .send({ versionLabel: 'v1', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    for (const [index, step] of steps.entries()) {
      await http()
        .post(`${api}/workflow-versions/${version.body.id}/steps`)
        .set(authed(as))
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
      .post(`${api}/workflow-versions/${version.body.id}/validate`)
      .set(authed(as));
    expect(validated.body).toMatchObject({ status: 'VALIDATED' });
    const published = await http()
      .post(`${api}/workflow-versions/${version.body.id}/publish`)
      .set(authed(as));
    expect(published.body).toMatchObject({ status: 'PUBLISHED' });
    return { defId: def.body.id, verId: version.body.id };
  };

  // =========================================================================
  // Fixtures -- three workflow versions, ONE routing version that chooses
  // between them per LINE, and the commercial configuration
  // =========================================================================
  it('W-fixtures: publishes three workflow versions and one routing version that routes by line', async () => {
    verSingle = (
      await publishWorkflow(userA1, 'W-SINGLE', [{ stepKey: 'commercial', actorUserId: userA2 }])
    ).verId;

    const gateA = await publishWorkflow(userA1, 'W-GATE-A', [
      { stepKey: 'planning', actorUserId: userA2 },
      { stepKey: 'commercial', actorUserId: userA3 },
    ]);
    verGateA = gateA.verId;
    gateADefId = gateA.defId;

    verGateB = (
      await publishWorkflow(userA1, 'W-GATE-B', [
        { stepKey: 'commercial', actorUserId: userA3 },
        { stepKey: 'planning', actorUserId: userA2 },
      ])
    ).verId;

    // ONE routing version, three rules, and no code: SERVICE lines go to the single-step
    // workflow, STANDARD lines to the planning-first gate, NON_STANDARD lines to the
    // commercial-first gate. The condition is evaluated for EACH LINE against its own facts.
    const routing = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userA1))
      .send({
        versionLabel: 'W-ROUTING-1',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'ALL_APPROVED',
        routeRules: [
          {
            priority: 1,
            targetWorkflowDefinitionVersionId: verSingle,
            condition: { field: 'lineType', op: 'equals', value: 'SERVICE' },
          },
          {
            priority: 2,
            targetWorkflowDefinitionVersionId: verGateA,
            condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
          },
          {
            priority: 3,
            targetWorkflowDefinitionVersionId: verGateB,
            condition: { field: 'lineType', op: 'equals', value: 'NON_STANDARD' },
          },
        ],
      })
      .expect(201);
    routeA = await idOr(routing.body, () =>
      db.workflowLineRoutingVersion.findFirst({
        where: { tenantId: tenantAId, versionLabel: 'W-ROUTING-1' },
      })
    );
    const routed = await http()
      .post(`${probe}/routing-versions/${routeA}/publish`)
      .set(authed(userA1));
    expect(routed.body).toMatchObject({ status: 'PUBLISHED' });

    // The commercial side: one class the rules assign to, the approver configured (so the
    // records exist from the moment the document is submitted), and the policy that needs
    // BOTH every line's workflow and every commercial record.
    const klass = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userA1))
      .send({ code: 'W-GROUP', name: 'Step W group', liaisonUserId: userA2 })
      .expect(201);
    grA = await idOr(klass.body, () =>
      db.commercialGroup.findFirst({ where: { tenantId: tenantAId, code: 'W-GROUP' } })
    );

    const config = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userA1))
      .send({
        versionLabel: 'W-CONFIG-1',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'W-rule', priority: 1, condition: null, commercialGroupId: grA },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userA2,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);
    cfgA = config.body.id;

    const cValidated = await http()
      .post(`${api}/commercial-configurations/${cfgA}/validate`)
      .set(authed(userA1));
    expect(cValidated.body).toMatchObject({ status: 'VALIDATED' });
    const cPublished = await http()
      .post(`${api}/commercial-configurations/${cfgA}/publish`)
      .set(authed(userA1));
    expect(cPublished.body).toMatchObject({ status: 'PUBLISHED' });
  });

  // =========================================================================
  // Section 28 + section 24 (1-4): ONE request, lines on different routes,
  // different commercial actors, walked in the order the configuration sets
  // =========================================================================
  it('W-S28: one document, three lines, three routes and two commercial actors', async () => {
    docA = (
      await http()
        .post(`${api}/purchase-documents`)
        .set(authed(userA1))
        .send({
          requesterId: userA1,
          supplierId: 'SUP-W',
          currency: 'EUR',
          lines: [
            { lineType: 'STANDARD', quantity: 4, unit: 'pcs', unitPrice: 10, tax: 0 },
            { lineType: 'NON_STANDARD', quantity: 2, unit: 'pcs', unitPrice: 25, tax: 0 },
            { lineType: 'SERVICE', quantity: 1, unit: 'lot', unitPrice: 30, tax: 0 },
          ],
        })
        .expect(201)
    ).body as IntegrationPurchaseDocument;
    expect(docA.lines).toHaveLength(3);
    expect(Number(docA.totalAmount)).toBe(120);
    lineA = docA.lines[0].id;
    expect(docA.lines[1].id).toBeDefined();

    await submitDoc(docA.id).expect(200);
    expect((await getDoc(docA.id)).status).toBe('SUBMITTED');

    // THREE instances, ONE document. Lines that follow different routes are still lines of the
    // same request, and the version each one pinned is the routing version's own decision.
    const standard = await instanceFor(docA.lines[0].id);
    const nonStandard = await instanceFor(docA.lines[1].id);
    const service = await instanceFor(docA.lines[2].id);
    expect(standard.workflowDefinitionVersionId).toBe(verGateA);
    expect(nonStandard.workflowDefinitionVersionId).toBe(verGateB);
    expect(service.workflowDefinitionVersionId).toBe(verSingle);
    expect(await db.purchaseDocument.count({ where: { tenantId: tenantAId } })).toBe(1);

    // The STANDARD line runs planning -> commercial. Its SECOND step has no instance yet, so it
    // cannot be decided: the configured order decides what is actionable, not the caller.
    // PHASE C2: this is a STATE refusal, so it answers the module's 409 conflict convention
    // (with the planner's own code, unchanged) — the actor refusal below stays 400.
    const tooEarly = await approveStep(standard.id, 'commercial', userA3);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.code).toBe('WORKFLOW_STEP_NOT_ACTIONABLE');

    // The FIRST step belongs to userA2. A different actor of the same tenant cannot take it.
    const wrongActor = await approveStep(standard.id, 'planning', userA3);
    expect(wrongActor.status).toBe(400);
    expect(wrongActor.body.code).toBe('WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR');

    // The configured order, walked: planning (userA2), then commercial (userA3).
    expect((await approveStep(standard.id, 'planning', userA2)).status).toBe(201);
    const commercialStep = await approveStep(standard.id, 'commercial', userA3);
    expect(commercialStep.status).toBe(201);
    expect(commercialStep.body.status).toBe('APPROVED');

    // The NON_STANDARD line of the SAME document runs the OPPOSITE order: commercial first, by
    // userA3. Same release, same code -- the order came from the routing configuration.
    // (PHASE C2: the state refusal answers 409 — the same class as the mirror case above.)
    const bTooEarly = await approveStep(nonStandard.id, 'planning', userA2);
    expect(bTooEarly.status).toBe(409);
    expect(bTooEarly.body.code).toBe('WORKFLOW_STEP_NOT_ACTIONABLE');
    expect((await approveStep(nonStandard.id, 'commercial', userA3)).status).toBe(201);
    const settledB = await approveStep(nonStandard.id, 'planning', userA2);
    expect(settledB.status).toBe(201);
    expect(settledB.body.status).toBe('APPROVED');

    // A third line, a third route: the SERVICE line went to the single-step workflow, whose one
    // step belongs to userA2.
    const serviceWrong = await approveStep(service.id, 'commercial', userA3);
    expect(serviceWrong.status).toBe(400);
    expect(serviceWrong.body.code).toBe('WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR');
    const serviceSettled = await approveStep(service.id, 'commercial', userA2);
    expect(serviceSettled.status).toBe(201);
    expect(serviceSettled.body.status).toBe('APPROVED');

    // Every line's workflow is APPROVED and the document has STILL not moved: its commercial
    // records are pending, and there is one record per line -- three, not one.
    expect((await getDoc(docA.id)).status).toBe('SUBMITTED');
    const approvals = await getApprovals(docA.id);
    expect(approvals.approvals).toHaveLength(3);
    for (const approval of approvals.approvals) expect(approval.status).toBe('PENDING');
  });

  // =========================================================================
  // Section 27: the ORDER is configuration -- the same release walks the
  // reversed pairing, chosen by tenant B's routing so tenant A is untouched
  // =========================================================================
  it('W-S27: the reversed step order runs for tenant B with no code change', async () => {
    // Tenant B configures the OPPOSITE pairing: NON_STANDARD lines planning-first, STANDARD
    // lines commercial-first. Nothing in the code names an order.
    verGateA1 = (
      await publishWorkflow(userB1, 'W-B-PLANNING-FIRST', [
        { stepKey: 'planning', actorUserId: userB1 },
        { stepKey: 'commercial', actorUserId: userB1 },
      ])
    ).verId;
    verGateB1 = (
      await publishWorkflow(userB1, 'W-B-COMMERCIAL-FIRST', [
        { stepKey: 'commercial', actorUserId: userB1 },
        { stepKey: 'planning', actorUserId: userB1 },
      ])
    ).verId;

    const routing = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userB1))
      .send({
        versionLabel: 'W-B-ROUTING-1',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'ALL_APPROVED',
        routeRules: [
          {
            priority: 1,
            targetWorkflowDefinitionVersionId: verGateA1,
            condition: { field: 'lineType', op: 'equals', value: 'NON_STANDARD' },
          },
          {
            priority: 2,
            targetWorkflowDefinitionVersionId: verGateB1,
            condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
          },
        ],
      })
      .expect(201);
    routeB = await idOr(routing.body, () =>
      db.workflowLineRoutingVersion.findFirst({
        where: { tenantId: tenantBId, versionLabel: 'W-B-ROUTING-1' },
      })
    );
    const routed = await http()
      .post(`${probe}/routing-versions/${routeB}/publish`)
      .set(authed(userB1));
    expect(routed.body).toMatchObject({ status: 'PUBLISHED' });

    const klass = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userB1))
      .send({ code: 'W-B-GROUP', name: 'W B group', liaisonUserId: userB1 })
      .expect(201);
    grB = klass.body.id;
    const config = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .send({
        versionLabel: 'W-B-CONFIG-1',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'W-B-rule', priority: 1, condition: null, commercialGroupId: grB },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userB1,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);
    const cValidated = await http()
      .post(`${api}/commercial-configurations/${config.body.id}/validate`)
      .set(authed(userB1));
    expect(cValidated.body).toMatchObject({ status: 'VALIDATED' });
    const cPublished = await http()
      .post(`${api}/commercial-configurations/${config.body.id}/publish`)
      .set(authed(userB1));
    expect(cPublished.body).toMatchObject({ status: 'PUBLISHED' });

    // Two lines, and each one's order is the OPPOSITE of what tenant A configured.
    const docB = (
      await http()
        .post(`${api}/purchase-documents`)
        .set(authed(userB1))
        .send({
          requesterId: userB1,
          supplierId: 'SUP-B',
          currency: 'EUR',
          lines: [
            { lineType: 'STANDARD', quantity: 1, unit: 'pcs', unitPrice: 5, tax: 0 },
            { lineType: 'NON_STANDARD', quantity: 1, unit: 'pcs', unitPrice: 5, tax: 0 },
          ],
        })
        .expect(201)
    ).body as IntegrationPurchaseDocument;
    await submitDoc(docB.id, userB1).expect(200);

    const bStandard = await instanceFor(docB.lines[0].id, tenantBId);
    const bNonStandard = await instanceFor(docB.lines[1].id, tenantBId);
    expect(bStandard.workflowDefinitionVersionId).toBe(verGateB1);
    expect(bNonStandard.workflowDefinitionVersionId).toBe(verGateA1);

    // STANDARD here starts at 'commercial'; in tenant A it starts at 'planning'.
    const bStandardEarly = await approveStep(bStandard.id, 'planning', userB1);
    expect(bStandardEarly.body.code).toBe('WORKFLOW_STEP_NOT_ACTIONABLE');
    expect((await approveStep(bStandard.id, 'commercial', userB1)).status).toBe(201);
    expect((await approveStep(bStandard.id, 'planning', userB1)).body.status).toBe('APPROVED');

    // NON_STANDARD here starts at 'planning'; in tenant A it starts at 'commercial'.
    const bNonStandardEarly = await approveStep(bNonStandard.id, 'commercial', userB1);
    expect(bNonStandardEarly.body.code).toBe('WORKFLOW_STEP_NOT_ACTIONABLE');
    expect((await approveStep(bNonStandard.id, 'planning', userB1)).status).toBe(201);
    expect((await approveStep(bNonStandard.id, 'commercial', userB1)).body.status).toBe('APPROVED');

    // Tenant A's own routing decision is untouched by tenant B's version.
    const pinnedA = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docA.id } });
    expect(pinnedA.lineRoutingVersionId).toBe(routeA);
  });

  // =========================================================================
  // Section 25: a published version does not change when another version is
  // authored and published, and a document already running stays on its pin
  // =========================================================================
  it('W-S25: version B is published, and version A keeps governing what it governs', async () => {
    const before = (
      await http().get(`${api}/workflow-versions/${verGateA}`).set(authed(userA1)).expect(200)
    ).body as WorkflowVersionProjection;
    const beforeSteps = before.steps.map((step) => step.stepKey);
    expect(beforeSteps).toEqual(['planning', 'commercial']);

    // Version 2 of the SAME definition: the same two steps plus a third.
    const version2 = await http()
      .post(`${api}/workflow-definitions/${gateADefId}/versions`)
      .set(authed(userA1))
      .send({ versionLabel: 'v2', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    for (const [index, stepKey] of ['planning', 'commercial', 'finance'].entries()) {
      await http()
        .post(`${api}/workflow-versions/${version2.body.id}/steps`)
        .set(authed(userA1))
        .send({
          stepKey,
          displayName: stepKey,
          ordering: index + 1,
          actorSource: 'CONFIGURED_USER',
          actorUserId: userA2,
        })
        .expect(201);
    }
    const v2Validated = await http()
      .post(`${api}/workflow-versions/${version2.body.id}/validate`)
      .set(authed(userA1));
    expect(v2Validated.body).toMatchObject({ status: 'VALIDATED' });
    const v2Published = await http()
      .post(`${api}/workflow-versions/${version2.body.id}/publish`)
      .set(authed(userA1));
    expect(v2Published.body).toMatchObject({ status: 'PUBLISHED' });

    // Version A did not change: the same steps, in the same order, still published.
    const after = (
      await http().get(`${api}/workflow-versions/${verGateA}`).set(authed(userA1)).expect(200)
    ).body as WorkflowVersionProjection;
    expect(after.steps.map((step) => step.stepKey)).toEqual(beforeSteps);
    expect(after.status).toBe('PUBLISHED');

    // The run that was already going kept version A: it COMPLETED on A's own two steps, and
    // version B's third step was never part of its run.
    const running = await instanceFor(lineA);
    expect(running.workflowDefinitionVersionId).toBe(verGateA);
    expect(running.status).toBe('APPROVED');

    // A document submitted AFTER version 2 was published also still pins version A: the routing
    // configuration names the version it routes to, so publishing alone re-points nobody's work
    // -- re-pointing is an authored change to the routing configuration.
    const fresh = (
      await http()
        .post(`${api}/purchase-documents`)
        .set(authed(userA1))
        .send({
          requesterId: userA1,
          supplierId: 'SUP-W',
          currency: 'EUR',
          lines: [{ lineType: 'STANDARD', quantity: 1, unit: 'pcs', unitPrice: 1, tax: 0 }],
        })
        .expect(201)
    ).body as IntegrationPurchaseDocument;
    await submitDoc(fresh.id).expect(200);
    const freshInstance = await instanceFor(fresh.lines[0].id);
    expect(freshInstance.workflowDefinitionVersionId).toBe(verGateA);

    // It is a run of version A: version B's third step does not exist in it, and asking for it
    // by name is answered against the PINNED version -- never against the newest published one.
    const finance = await approveStep(freshInstance.id, 'finance', userA2);
    expect(finance.status).toBe(400);
    expect(finance.body.code).toBe('WORKFLOW_STEP_UNKNOWN');
  });

  // =========================================================================
  // Section 24 (11-17, 18-20): partial receipt, over-receipt, three money
  // movements and a return -- all of them on the one aggregate, and none of
  // them moving the document's own status
  // =========================================================================
  it('W-S24: receipts, over-receipt, money movements and a return, all on the aggregate', async () => {
    const lineOf = (collection: IntegrationReceivingLine[], lineId: string) =>
      collection.find((row) => row.purchaseLineId === lineId);

    // (12) A PARTIAL receipt, of ONE line out of the three.
    const received = await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 2 }] })
      .expect(201);
    receiptLineA = received.body.lines[0].id;

    const partial = await getReceipts(docA.id);
    expect(lineOf(partial.lines, lineA).receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(Number(lineOf(partial.lines, lineA).receivedQuantity)).toBe(2);
    // The other two lines were not touched by a receipt about the first one.
    expect(
      partial.lines.filter((row) => row.receivingStatus === 'NOT_RECEIVED')
    ).toHaveLength(2);

    // (13) Over-receipt of that line is refused, and the refusal wrote nothing.
    const over = await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 3 }] })
      .expect(409);
    expect(msgOf(over.body)).toMatch(/exceed|remain/i);
    expect(Number(lineOf((await getReceipts(docA.id)).lines, lineA).receivedQuantity)).toBe(2);

    // (14) A PARTIAL payment against the document's own stated total of 120.
    const first = await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 50, method: 'CASH', externalReference: 'W-1' })
      .expect(201);
    payA = first.body.id;
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('PARTIAL');

    // (15) A SECOND payment on the same request, which settles it.
    const second = await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 70, method: 'CASH', externalReference: 'W-2' })
      .expect(201);
    const paid = await getPayments(docA.id);
    expect(Number(paid.paymentStatus.paidAmount)).toBe(120);
    expect(paid.paymentStatus.status).toBe('PAID');
    expect(paid.items).toHaveLength(2);

    // (16) A compensating record reverses the payment it names, and only that one.
    await http()
      .post(`${api}/purchase-documents/${docA.id}/payments/${second.body.id}/compensate`)
      .set(authed(userA1))
      .send({ reason: 'STATED_IN_ERROR' })
      .expect(201);
    const compensated = await getPayments(docA.id);
    expect(Number(compensated.paymentStatus.paidAmount)).toBe(50);
    expect(compensated.paymentStatus.status).toBe('PARTIAL');

    // (17) The return child lifecycle, on the line that was received.
    const requested = await http()
      .post(`${api}/purchase-documents/${docA.id}/returns`)
      .set(authed(userA1))
      .send({
        reason: 'DAMAGED',
        replacementRequired: false,
        lines: [{ purchaseLineId: lineA, receiptLineId: receiptLineA, quantity: 1 }],
      })
      .expect(201);
    retA = requested.body.id;
    expect(requested.body.state).toBe('REQUESTED');

    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/approve`)
      .set(authed(userA1))
      .expect(201);
    await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/receive-back`)
      .set(authed(userA1))
      .expect(201);
    const refunded = await http()
      .post(`${api}/purchase-documents/${docA.id}/returns/${retA}/refund`)
      .set(authed(userA1))
      .send({ paymentId: payA, reason: 'DAMAGED' })
      .expect(201);
    expect(refunded.body.state).toBe('REFUNDED');
    // The refund compensates the 50 it names, so the paid projection is back to zero -- an
    // UNPAID document whose receipt is still recorded.
    expect(Number((await getPayments(docA.id)).paymentStatus.paidAmount)).toBe(0);
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('UNPAID');

    // NOT ONE of those operations moved the document's own status: its three lines are worked,
    // its money and its goods have been and come back, and it is still SUBMITTED.
    expect((await getDoc(docA.id)).status).toBe('SUBMITTED');

    // (18-20) The commercial decisions are then made, and the document follows -- while the
    // receiving and payment surfaces still say exactly what they said.
    const approvals = (await getApprovals(docA.id)).approvals;
    expect(approvals).toHaveLength(3);
    for (const approval of approvals) {
      await http()
        .post(`${api}/commercial-approvals/${approval.id}/decision`)
        .set(authed(userA2))
        .send({ decision: 'APPROVED', comment: 'W' })
        .expect(200);
    }

    const document = await getDoc(docA.id);
    expect(document.status).toBe('APPROVED');
    expect(document.editable).toBe(false);
    const finalReceipts = await getReceipts(docA.id);
    expect(
      finalReceipts.lines.filter((row) => row.receivingStatus === 'PARTIALLY_RECEIVED')
    ).toHaveLength(1);
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('UNPAID');
    expect((await getReturns(docA.id)).returns[0].state).toBe('REFUNDED');
  });

  // -------------------------------------------------------------------------
  // The seam (section 24 items 22-23): identity resolved through the gateway,
  // and every one of those moves audited and announced through the ports
  // -------------------------------------------------------------------------
  it('W-seam: the whole process was audited and announced, tagged with its own tenant', async () => {
    // (22) The requester's profile came from the directory port, not from a local copy: the
    // document carries the id it stored AND the profile the gateway resolved.
    const document = await getDoc(docA.id);
    expect(document.requester.id).toBe(userA1);
    expect(document.requester.profile?.id).toBe(userA1);

    // (23) Every move travelled through the audit port, and every notification names both the
    // document it is about and the tenant that owns it.
    expect(auditEvents.some((event) => event.resourceId === docA.id)).toBe(true);
    // Tenant B ran its own process, and its events carry tenant B's id -- never tenant A's.
    expect(auditEvents.some((event) => event.tenantId === tenantBId)).toBe(true);
    expect(auditEvents.some((event) => event.resourceId === retA)).toBe(true);
    expect(auditEvents.some((event) => event.resourceId === payA)).toBe(true);
    expect(notifications.some((note) => note.payload.documentId === docA.id)).toBe(true);
    for (const note of notifications) {
      expect([tenantAId, tenantBId]).toContain(note.payload.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // Cleanup -- test-only, tenant-scoped, explicit predicates; no TRUNCATE
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
    // AFTER the documents, deliberately: the commercial PIN and the routing PIN are foreign
    // keys ON the document row (both ON DELETE RESTRICT), so a submitted document keeps the
    // versions it pinned alive until the document itself is gone -- and the groups wait for
    // the versions that name them.
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

    expect(deleted.purchaseDocument).toBeGreaterThanOrEqual(3);
    expect(deleted.workflowInstance).toBeGreaterThanOrEqual(6);
    expect(deleted.paymentRecord).toBeGreaterThanOrEqual(4);
    expect(deleted.receipt).toBeGreaterThanOrEqual(1);
    expect(deleted.returnDocument).toBeGreaterThanOrEqual(1);
    expect(await db.purchaseDocument.count({ where })).toBe(0);
    expect(await db.workflowInstance.count({ where })).toBe(0);
    await app.close();
  });

  const TENANT_CONTEXT_MESSAGE =
    'Commerce requires a tenant context; this request was not resolved to a tenant.';
});
