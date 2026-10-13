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
import { AUDIT_PORT, type AuditEventInput, type AuditPort } from '../src/platform/audit/audit.contract';
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
import { WorkflowLineRoutingController } from '../src/modules/commerce/workflow/workflow-line-routing.controller';
import { WorkflowExecutionController } from '../src/modules/commerce/workflow/workflow-execution.controller';
import { PendingDecisionsController } from '../src/modules/commerce/pending/pending-decisions.controller';
import { PendingDecisionsService } from '../src/modules/commerce/pending/pending-decisions.service';

// ---------------------------------------------------------------------------
// The two-tenant registry and the in-memory port fakes (seam 2)
// ---------------------------------------------------------------------------
const runId = Date.now();
const tenantAId = `tenant-A-${runId}`;
const tenantBId = `tenant-B-${runId}`;
const userA1 = randomUUID();
const userA2 = randomUUID();
/**
 * PHASE C2: tenant A's READ-ONLY member. It exists so the C2 suite can prove `commerce.read`
 * and `commerce.approve` are different doors on the same routes: it may list runs and the
 * inbox, and it may not decide or cancel (the permission fake below is the only thing that
 * knows it is read-only — every other user still holds the full catalogue).
 */
const userA3 = randomUUID();
/**
 * PHASE C7: tenant A's member holding NO permissions at all. It exists so the timeline
 * suite can prove `commerce.read` is a real gate on `GET …/timeline` — userA3 proves
 * the permission is SUFFICIENT (a read-only member may read the trail), this principal
 * proves it is NECESSARY (a member with no permission is refused 403 by RolesGuard
 * before any audit query is attempted).
 */
const userA4 = randomUUID();
const userB1 = randomUUID();
const unresolvedUserId = randomUUID();

/** userId → tenantId. `unresolvedUserId` is deliberately absent (G7). */
const tenantRegistry = new Map<string, string>([
  [userA1, tenantAId],
  [userA2, tenantAId],
  [userA3, tenantAId],
  [userA4, tenantAId],
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
  async getEffectivePermissions(userId: string): Promise<string[]> {
    // PHASE C2: the read-only member sees ONLY `commerce.read`, so a decide/cancel refusal
    // on the new routes can be attributed to the permission rather than to the tenant or the
    // actor. Every other principal keeps the full catalogue, exactly as before C2.
    if (userId === userA3) return [Permissions.COMMERCE_READ];
    // PHASE C7: the no-permission member — an EMPTY grant, so RolesGuard itself is the
    // thing that refuses. Read routes (e.g. the timeline) must 403 for it too.
    if (userId === userA4) return [];
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
const contractAuditPort = createFakeAuditPort(auditEvents);

/**
 * PHASE C7 (GAP-7): the SAME contract-driven fake, behind one test-only SWITCH.
 *
 * `record` and the default `read` are pure delegations to `contractAuditPort`, so every
 * pre-existing assertion keeps its meaning byte-for-byte. The switch exists for C7-G
 * alone: it answers `{ status: 'rejected', code: 'AUDIT_READ_FAILED' }` — the platform's
 * closed storage-failure code — without touching the recorded trail, so the endpoint can
 * be observed distinguishing "audit unavailable" (503) from "nothing recorded"
 * (200 + empty). This is NOT a second fake with weaker semantics: while the switch is
 * off, every read still runs through the shared fixture's own validation, filtering,
 * ordering and projection.
 */
let auditReadFailure = false;
const fakeAuditPort: AuditPort = {
  record: (event) => contractAuditPort.record(event),
  read: (query) =>
    auditReadFailure
      ? Promise.resolve({ status: 'rejected', code: 'AUDIT_READ_FAILED' })
      : contractAuditPort.read(query),
};

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

/**
 * Response shapes the five Step-V surfaces project (document, payments,
 * receiving, returns, commercial approvals). The HTTP body is `any` at the
 * supertest boundary; these interfaces pin, per SURFACE, the fields a test
 * below actually reads — nothing more.
 */
interface PurchaseDocumentLine {
  id: string;
}

interface CreatedPurchaseDocument {
  id: string;
  status: string;
  editable: boolean;
  totalAmount: string | number;
  lines: PurchaseDocumentLine[];
  requester: { id: string; profile?: { id: string } | null };
  completedByUserId?: string | null;
  completedAt?: string | null;
}

interface PaymentStatusProjection {
  status: string;
  paidAmount: string | number;
}

interface PaymentProjection {
  paymentStatus: PaymentStatusProjection;
  paymentRecords?: unknown;
  items?: unknown;
  returns?: unknown;
}

interface ReceivingLineProjection {
  id: string;
  receivingStatus: string;
  receivedQuantity: string | number;
}

interface ReceivingProjection {
  lines: ReceivingLineProjection[];
}

interface ReturnProjection {
  returns: Array<{ id: string; state: string }>;
}

interface CommercialApprovalProjection {
  id: string;
  status: string;
}

interface ApprovalListing {
  approvals: CommercialApprovalProjection[];
}

interface PendingDecisionItem {
  id: string;
  kind: string;
  status?: string;
  createdAt: string;
  purchaseDocumentId: string;
  purchaseLineId?: string | null;
  workflowInstanceId?: string | null;
  stepKey?: string | null;
  stepName?: string | null;
  documentNumber?: string;
}

interface PendingDecisionPage {
  items: PendingDecisionItem[];
  total: number;
}

interface RoutingVersionItem {
  id: string;
  versionLabel: string;
  status: string;
  routeRules: unknown;
}

interface RoutingVersionPage {
  items: RoutingVersionItem[];
}

interface CompletionPolicyItem {
  id: string;
  status: string;
}

interface CompletionPolicyPage {
  items: CompletionPolicyItem[];
}

interface TimelineEntry {
  id: string;
  action: string;
  createdAt: string;
  changedFields?: unknown;
}

interface TimelinePage {
  items: TimelineEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
jest.setTimeout(120_000);

describe('Commerce lifecycle independence e2e (Step V): the five dimensions of a purchase document move on their own surfaces.', () => {
  let app: INestApplication;
  let db: CommercePrismaService;

  let docA: CreatedPurchaseDocument;
  let lineA: string;
  let docB: CreatedPurchaseDocument;
  let lineB: string;
  let payA: string;
  let receiptLineA: string;
  let retA: string;
  let grA: string;
  let grB: string;
  let cfgA: string;
  let wfA: { defId: string; verId: string; stepId: string };
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
      // PHASE C2 (GAP-1, GAP-1b): the production execution + inbox routes under test.
      WorkflowExecutionController,
      PendingDecisionsController,
      // PHASE C3 (GAP-2): the production line-routing CONFIGURATION routes under test.
      WorkflowLineRoutingController,
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
      PendingDecisionsService, // PHASE C2 (GAP-1b): composes both repositories' pending reads.
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

  // =========================================================================
  // Step V -- lifecycle independence (section 24 items 17-20, section 26 CASE A-D)
  //
  // A purchase document has FIVE dimensions, and each one moves on its own surface:
  //
  //   1. its own status        PurchaseDocument.status
  //   2. its workflow          WorkflowInstance / WorkflowStepInstance
  //   3. its commercial rules  CommercialApproval + the APPROVED projection
  //   4. its payments          PaymentRecord + the paid projection
  //   5. its receiving         Receipt / ReceiptLine + the received projection
  //
  // Section 26 declares combinations that LOOK impossible to be legal and routine: a
  // REFUNDED return under a still-DRAFT document, a fully received document that was never
  // submitted, an APPROVED line workflow under a SUBMITTED document. Nothing below reads
  // one surface to predict another. Every case drives the real contract, then asks the API
  // that OWNS a dimension what that dimension says -- and asks the other four what they
  // still say.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Read helpers -- each one asks the surface that owns the dimension
  // -------------------------------------------------------------------------
  const getDoc = async (
    documentId: string,
    as: string = userA1
  ): Promise<CreatedPurchaseDocument> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}`)
        .set(authed(as))
        .expect(200)
    ).body as CreatedPurchaseDocument;

  const getPayments = async (documentId: string): Promise<PaymentProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/payments`)
        .set(authed(userA1))
        .expect(200)
    ).body as PaymentProjection;

  const getReceipts = async (documentId: string): Promise<ReceivingProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/receipts`)
        .set(authed(userA1))
        .expect(200)
    ).body as ReceivingProjection;

  const getReturns = async (documentId: string): Promise<ReturnProjection> =>
    (
      await http()
        .get(`${api}/purchase-documents/${documentId}/returns`)
        .set(authed(userA1))
        .expect(200)
    ).body as ReturnProjection;

  const getApprovals = async (
    documentId: string,
    as: string = userA1
  ): Promise<ApprovalListing> =>
    (
      await http()
        .get(`${api}/commercial-approvals?documentId=${documentId}`)
        .set(authed(as))
        .expect(200)
    ).body as ApprovalListing;

  /** The one LINE-level instance `submit` created for this line (only lines are routed). */
  const lineInstance = async (lineId: string) =>
    db.workflowInstance.findFirstOrThrow({
      where: { tenantId: tenantAId, subjectType: 'PURCHASE_LINE', subjectId: lineId },
    });

  const approveStep = (instanceId: string, stepKey: string, asUser: string) =>
    http()
      .post(`${probe}/workflow-instances/${instanceId}/steps/${stepKey}/approve`)
      .set(authed(asUser))
      .send({ comment: null });

  const createDoc = async (
    lines: unknown[],
    currency = 'EUR'
  ): Promise<CreatedPurchaseDocument> =>
    (
      await http()
        .post(`${api}/purchase-documents`)
        .set(authed(userA1))
        .send({ requesterId: userA1, supplierId: 'SUP-V', currency, lines })
        .expect(201)
    ).body as CreatedPurchaseDocument;

  /** One line, stated unit price and stated zero tax, so the totals are a known number. */
  const oneLine = (quantity: number, unitPrice: number) => [
    { lineType: 'STANDARD', quantity, unit: 'pcs', unitPrice, tax: 0 },
  ];

  // =========================================================================
  // Fixtures -- published through their own production routes, never inserted
  // =========================================================================
  it('fixtures: publishes a workflow, a routing version and a commercial configuration', async () => {
    const def = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(userA1))
      .send({ code: 'V-SINGLE', name: 'Step V single-step approval' })
      .expect(201);

    const version = await http()
      .post(`${api}/workflow-definitions/${def.body.id}/versions`)
      .set(authed(userA1))
      .send({ versionLabel: 'v1', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);

    const step = await http()
      .post(`${api}/workflow-versions/${version.body.id}/steps`)
      .set(authed(userA1))
      .send({
        stepKey: 'manager',
        displayName: 'Manager',
        ordering: 1,
        actorSource: 'CONFIGURED_USER',
        actorUserId: userA2,
      })
      .expect(201);

    // Asserted on the BODY, not only on the status: a refusal carries the report naming
    // exactly which requisite failed, and that report is what a failing run must show.
    const validated = await http()
      .post(`${api}/workflow-versions/${version.body.id}/validate`)
      .set(authed(userA1));
    expect(validated.body).toMatchObject({ id: version.body.id, status: 'VALIDATED' });

    const published = await http()
      .post(`${api}/workflow-versions/${version.body.id}/publish`)
      .set(authed(userA1));
    expect(published.body).toMatchObject({ id: version.body.id, status: 'PUBLISHED' });

    wfA = {
      defId: def.body.id,
      verId: version.body.id,
      stepId: step.body.id ?? step.body.stepId,
    };

    // The class the configuration names, then the configuration itself.
    const klass = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userA1))
      .send({ code: 'V-GROUP', name: 'Step V liaison group', liaisonUserId: userA2 })
      .expect(201);
    grA = await idOr(klass.body, () =>
      db.commercialGroup.findFirst({ where: { tenantId: tenantAId, code: 'V-GROUP' } })
    );

    const config = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userA1))
      .send({
        versionLabel: 'V-CONFIG-1',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'V-rule', priority: 1, condition: null, commercialGroupId: grA },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userA2,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);
    cfgA = await idOr(config.body, () =>
      db.commercialConfigurationVersion.findFirst({
        where: { tenantId: tenantAId, status: 'DRAFT' },
      })
    );

    await http()
      .post(`${api}/commercial-configurations/${cfgA}/validate`)
      .set(authed(userA1))
      .expect(200);
    await http()
      .post(`${api}/commercial-configurations/${cfgA}/publish`)
      .set(authed(userA1))
      .expect(200);

    // Routing version A: a submitted line routes to the single-step workflow, and the
    // document may only move when ALL of its lines are approved.
    const routing = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userA1))
      .send({
        versionLabel: 'V-ALL-APPROVED',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'ALL_APPROVED',
        routeRules: [
          { priority: 1, targetWorkflowDefinitionVersionId: wfA.verId, condition: null },
        ],
      })
      .expect(201);
    routeA = await idOr(routing.body, () =>
      db.workflowLineRoutingVersion.findFirst({
        where: { tenantId: tenantAId, versionLabel: 'V-ALL-APPROVED' },
      })
    );
    await http()
      .post(`${probe}/routing-versions/${routeA}/publish`)
      .set(authed(userA1))
      .expect(201);
  });

  // -------------------------------------------------------------------------
  // CASE A -- the DRAFT surface: payments, receiving and returns each move
  // while the document's own status does not
  // -------------------------------------------------------------------------
  it('V-A: payments move the paid projection and leave the document DRAFT and editable', async () => {
    docA = await createDoc(oneLine(10, 7));
    expect(docA.status).toBe('DRAFT');
    expect(Number(docA.totalAmount)).toBe(70);
    lineA = docA.lines[0].id;

    const before = await getPayments(docA.id);
    expect(before.paymentStatus.status).toBe('UNPAID');
    expect(Number(before.paymentStatus.paidAmount)).toBe(0);

    const partial = await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 40, method: 'CASH', externalReference: 'V-A-1' })
      .expect(201);
    payA = partial.body.id;

    const afterPartial = await getPayments(docA.id);
    expect(afterPartial.paymentStatus.status).toBe('PARTIAL');
    expect(Number(afterPartial.paymentStatus.paidAmount)).toBe(40);
    expect(Number(afterPartial.paymentStatus.totalAmount)).toBe(70);

    // The dimension above moved; the document's OWN status did not.
    const stillDraft = await getDoc(docA.id);
    expect(stillDraft.status).toBe('DRAFT');
    expect(stillDraft.editable).toBe(true);

    await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 30, method: 'CASH', externalReference: 'V-A-2' })
      .expect(201);
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('PAID');

    // Overpayment is a payment-surface fact, not a refusal: the document is still DRAFT.
    await http()
      .post(`${api}/purchase-documents/${docA.id}/payments`)
      .set(authed(userA1))
      .send({ amount: 1, method: 'CASH', externalReference: 'V-A-3' })
      .expect(201);
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('OVERPAID');
    expect((await getDoc(docA.id)).status).toBe('DRAFT');
  });

  it('V-B: receiving moves the received projection; over-receipt is refused and written nowhere', async () => {
    const received = await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 4 }] })
      .expect(201);
    expect(received.body.id).toEqual(expect.any(String));

    // The receipt LINE id must come from the receipt the POST returned: the projection the
    // GET answers with is keyed by purchase line, and a return names the receipt line it
    // reverses.
    receiptLineA = received.body.lines[0].id;
    const partial = await getReceipts(docA.id);
    expect(partial.lines[0].receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(Number(partial.lines[0].receivedQuantity)).toBe(4);

    // Over-receipt is refused BEFORE anything is written: no short receipt survives.
    const over = await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 11 }] })
      .expect(409);
    expect(msgOf(over.body)).toMatch(/exceed|remain/i);
    const untouched = await getReceipts(docA.id);
    expect(Number(untouched.lines[0].receivedQuantity)).toBe(4);
    expect(untouched.lines[0].receivingStatus).toBe('PARTIALLY_RECEIVED');

    await http()
      .post(`${api}/purchase-documents/${docA.id}/receipts`)
      .set(authed(userA1))
      .send({ lines: [{ purchaseLineId: lineA, quantity: 6 }] })
      .expect(201);
    const full = await getReceipts(docA.id);
    expect(Number(full.lines[0].receivedQuantity)).toBe(10);
    expect(full.lines[0].receivingStatus).toBe('FULLY_RECEIVED');

    // Fully received and never submitted, at the same time. Both are true.
    const doc = await getDoc(docA.id);
    expect(doc.status).toBe('DRAFT');
    expect((await getPayments(docA.id)).paymentStatus.status).toBe('OVERPAID');
  });

  it('V-C: a return lives its whole life (request, approve, receive back, refund) under a DRAFT document', async () => {
    const requested = await http()
      .post(`${api}/purchase-documents/${docA.id}/returns`)
      .set(authed(userA1))
      .send({
        reason: 'DAMAGED',
        replacementRequired: false,
        lines: [{ purchaseLineId: lineA, receiptLineId: receiptLineA, quantity: 2 }],
      })
      .expect(201);
    retA = requested.body.id;
    // A return names its own field `state` (RETURN_STATES), not `status`.
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

    // Four facts on four surfaces, all true at once: the return is finished, the receipt is
    // still fully received (a return is not a receiving compensation), the money is still
    // over-paid (a refund links a payment, it does not restate a balance), and the document
    // is still a DRAFT that nobody has submitted.
    const returns = await getReturns(docA.id);
    expect(returns.returns).toHaveLength(1);
    expect(returns.returns[0].state).toBe('REFUNDED');
    const receipts = await getReceipts(docA.id);
    expect(Number(receipts.lines[0].receivedQuantity)).toBe(10);
    expect(receipts.lines[0].receivingStatus).toBe('FULLY_RECEIVED');
    // A refund IS a move on the payment surface: it compensates the payment it NAMES, so the
    // paid projection falls from the over-paid 71 by that payment's own 40 (to 31). That is the
    // return surface moving the payment surface -- and the ONLY surface it moves: the receipt
    // above is still fully received, and the document below is still a DRAFT.
    const paidAfterRefund = (await getPayments(docA.id)).paymentStatus;
    expect(paidAfterRefund.status).toBe('PARTIAL');
    expect(Number(paidAfterRefund.paidAmount)).toBe(31);
    expect((await getDoc(docA.id)).status).toBe('DRAFT');
  });

  // -------------------------------------------------------------------------
  // CASE B -- the workflow surface: submit routes the LINES, the step has one
  // resolved approver, and the line's settle is not the document's
  // -------------------------------------------------------------------------
  it('V-D: submit routes each line; only the resolved approver may decide the step', async () => {
    docB = await createDoc(oneLine(10, 7));
    lineB = docB.lines[0].id;

    // Nothing is routed before the submit: a DRAFT has no workflow at all.
    expect(
      await db.workflowInstance.count({ where: { tenantId: tenantAId, subjectId: lineB } })
    ).toBe(0);

    await http()
      .post(`${api}/purchase-documents/${docB.id}/submit`)
      .set(authed(userA1))
      .expect(200);
    expect((await getDoc(docB.id)).status).toBe('SUBMITTED');
    expect((await getDoc(docB.id)).editable).toBe(false);

    const instance = await lineInstance(lineB);
    expect(instance.status).not.toBe('APPROVED');

    // The requester is not the approver. The configured approver is userA2, so the
    // requester's own token cannot decide the step -- identity comes from the request.
    const asRequester = await approveStep(instance.id, 'manager', userA1);
    expect(asRequester.status).toBe(400);
    expect(asRequester.body.code).toBe('WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR');
    expect(
      (await db.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } })).status
    ).not.toBe('APPROVED');

    const asApprover = await approveStep(instance.id, 'manager', userA2);
    expect(asApprover.status).toBe(201);
    expect(asApprover.body.status).toBe('APPROVED');

    // The line's workflow is APPROVED and the document is NOT: the commercial rule this
    // configuration activates at submit has not been decided yet, so the projection has
    // no reason to move.
    const doc = await getDoc(docB.id);
    expect(doc.status).toBe('SUBMITTED');
    const approvals = await getApprovals(docB.id);
    expect(approvals.approvals).toHaveLength(1);
    expect(approvals.approvals[0].status).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // CASE C -- the commercial surface: the decision is the document's, and a
  // commercial rejection is never a document rejection
  // -------------------------------------------------------------------------
  it('V-E: the commercial decision is what moves the document to APPROVED', async () => {
    const approvals = await getApprovals(docB.id);
    const approval = approvals.approvals[0];

    // The record belongs to the approver stored at activation: the requester's own principal
    // cannot decide it, and the approver's can. The same identity rule as the workflow step,
    // on the commercial surface, with the same actor resolution.
    const notMine = await http()
      .post(`${api}/commercial-approvals/${approval.id}/decision`)
      .set(authed(userA1))
      .send({ decision: 'APPROVED', comment: 'V-E-0' });
    expect(notMine.status).toBeGreaterThanOrEqual(400);
    expect((await getApprovals(docB.id)).approvals[0].status).toBe('PENDING');

    await http()
      .post(`${api}/commercial-approvals/${approval.id}/decision`)
      .set(authed(userA2))
      .send({ decision: 'APPROVED', comment: 'V-E' })
      .expect(200);

    const doc = await getDoc(docB.id);
    expect(doc.status).toBe('APPROVED');
    expect(doc.editable).toBe(false);

    // The document moved; the surfaces that were never touched still say nothing happened.
    expect((await getPayments(docB.id)).paymentStatus.status).toBe('UNPAID');
    expect((await getReceipts(docB.id)).lines[0].receivingStatus).toBe('NOT_RECEIVED');
    expect((await getReturns(docB.id)).returns).toHaveLength(0);

    // APPROVED is terminal for the document surface: a second decision is refused.
    const again = await http()
      .post(`${api}/commercial-approvals/${approval.id}/decision`)
      .set(authed(userA2))
      .send({ decision: 'REJECTED', comment: 'V-E-2' });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it('V-F: a REJECTED commercial decision never writes the document REJECTED', async () => {
    const docC = await createDoc(oneLine(2, 5));
    const lineC = docC.lines[0].id;
    await http()
      .post(`${api}/purchase-documents/${docC.id}/submit`)
      .set(authed(userA1))
      .expect(200);

    // Every OTHER dimension is satisfied: the line workflow is approved and nothing else
    // is outstanding. Only the commercial rule is refused.
    const instance = await lineInstance(lineC);
    expect((await approveStep(instance.id, 'manager', userA2)).status).toBe(201);

    const approval = (await getApprovals(docC.id)).approvals[0];
    await http()
      .post(`${api}/commercial-approvals/${approval.id}/decision`)
      .set(authed(userA2))
      .send({ decision: 'REJECTED', comment: 'V-F' })
      .expect(200);
    expect((await getApprovals(docC.id)).approvals[0].status).toBe('REJECTED');

    // A commercial refusal is a commercial fact. The document stays where it was -- it is
    // not moved to REJECTED by a projection, and the workflow that WAS approved keeps its
    // own outcome.
    expect((await getDoc(docC.id)).status).toBe('SUBMITTED');
    expect((await getDoc(docC.id)).editable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CASE D -- INDEPENDENT aggregation: the same two decisions, a different
  // routing policy, and the document deliberately stays put
  // -------------------------------------------------------------------------
  it('V-G: ALL_APPROVED aggregation waits for EVERY line before the document moves', async () => {
    // Two lines, one document, tenant A's ALL_APPROVED routing: approving one line is not the
    // document's approval. The projection asks every line instance, so the document waits.
    const docE = await createDoc([
      ...oneLine(3, 3),
      { lineType: 'STANDARD', quantity: 2, unit: 'pcs', unitPrice: 5, tax: 0 },
    ]);
    const firstLine = docE.lines[0].id;
    const secondLine = docE.lines[1].id;
    await http()
      .post(`${api}/purchase-documents/${docE.id}/submit`)
      .set(authed(userA1))
      .expect(200);

    const one = await lineInstance(firstLine);
    const two = await lineInstance(secondLine);
    expect(one.id).not.toBe(two.id);

    expect((await approveStep(one.id, 'manager', userA2)).status).toBe(201);

    // The commercial approvals are PER LINE: a two-line document is asked twice. Deciding the
    // first one is not the document's approval, and the projection says so.
    const approvals = (await getApprovals(docE.id)).approvals;
    expect(approvals).toHaveLength(2);
    await http()
      .post(`${api}/commercial-approvals/${approvals[0].id}/decision`)
      .set(authed(userA2))
      .send({ decision: 'APPROVED', comment: 'V-G-1' })
      .expect(200);

    // One line approved, one commercial rule approved, and the document has STILL not moved:
    // ALL_APPROVED is a statement about the whole set of lines, not about any one of them.
    expect(
      (await db.workflowInstance.findUniqueOrThrow({ where: { id: two.id } })).status
    ).not.toBe('APPROVED');
    expect((await getDoc(docE.id)).status).toBe('SUBMITTED');

    // The last line settles -- and the document still waits, because the last commercial rule
    // has not been decided. Two independent gates, neither of which the other can open.
    expect((await approveStep(two.id, 'manager', userA2)).status).toBe(201);
    expect((await getDoc(docE.id)).status).toBe('SUBMITTED');

    // The last decision is made, every input the projection reads is finally satisfied, and
    // only now does the document follow.
    await http()
      .post(`${api}/commercial-approvals/${approvals[1].id}/decision`)
      .set(authed(userA2))
      .send({ decision: 'APPROVED', comment: 'V-G-2' })
      .expect(200);
    expect((await getDoc(docE.id)).status).toBe('APPROVED');
  });

  it('V-H: INDEPENDENT aggregation never lets the lines carry the document, where ALL_APPROVED does', async () => {
    // Tenant B publishes the SAME shape with ONE setting changed: its routing version declares
    // line results INDEPENDENT of the document. It is tenant B's own configuration, published
    // through the same routes -- and exactly ONE routing version per tenant and trigger is ever
    // published, deliberately: `findPublishedForTrigger` has no tie-break, so a second published
    // version would leave the choice of policy to the database rather than to configuration.
    const def = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(userB1))
      .send({ code: 'V-B-SINGLE', name: 'Step V tenant B single-step approval' })
      .expect(201);
    const version = await http()
      .post(`${api}/workflow-definitions/${def.body.id}/versions`)
      .set(authed(userB1))
      .send({ versionLabel: 'v1', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    const step = await http()
      .post(`${api}/workflow-versions/${version.body.id}/steps`)
      .set(authed(userB1))
      .send({
        stepKey: 'manager',
        displayName: 'Manager',
        ordering: 1,
        actorSource: 'CONFIGURED_USER',
        actorUserId: userB1,
      })
      .expect(201);
    expect(step.body.id ?? step.body.stepId).toBeDefined();

    const vValidated = await http()
      .post(`${api}/workflow-versions/${version.body.id}/validate`)
      .set(authed(userB1));
    expect(vValidated.body).toMatchObject({ status: 'VALIDATED' });
    const vPublished = await http()
      .post(`${api}/workflow-versions/${version.body.id}/publish`)
      .set(authed(userB1));
    expect(vPublished.body).toMatchObject({ status: 'PUBLISHED' });

    const klass = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userB1))
      .send({ code: 'V-B-GROUP', name: 'Step V tenant B group', liaisonUserId: userB1 })
      .expect(201);
    grB = klass.body.id;

    const config = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .send({
        versionLabel: 'V-B-CONFIG-1',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'V-B-rule', priority: 1, condition: null, commercialGroupId: grB },
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

    const routing = await http()
      .post(`${probe}/routing-versions`)
      .set(authed(userB1))
      .send({
        versionLabel: 'V-B-INDEPENDENT',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'INDEPENDENT',
        routeRules: [
          { priority: 1, targetWorkflowDefinitionVersionId: version.body.id, condition: null },
        ],
      })
      .expect(201);
    routeB = await idOr(routing.body, () =>
      db.workflowLineRoutingVersion.findFirst({
        where: { tenantId: tenantBId, versionLabel: 'V-B-INDEPENDENT' },
      })
    );
    const routed = await http()
      .post(`${probe}/routing-versions/${routeB}/publish`)
      .set(authed(userB1));
    expect(routed.body).toMatchObject({ status: 'PUBLISHED' });

    // Tenant B's own document -- TWO lines -- under tenant B's own INDEPENDENT policy.
    const docD = (
      await http()
        .post(`${api}/purchase-documents`)
        .set(authed(userB1))
        .send({
          requesterId: userB1,
          supplierId: 'SUP-B',
          currency: 'EUR',
          lines: [
            ...oneLine(3, 3),
            { lineType: 'STANDARD', quantity: 2, unit: 'pcs', unitPrice: 5, tax: 0 },
          ],
        })
        .expect(201)
    ).body as CreatedPurchaseDocument;
    await http()
      .post(`${api}/purchase-documents/${docD.id}/submit`)
      .set(authed(userB1))
      .expect(200);

    const pinned = await db.purchaseDocument.findUniqueOrThrow({ where: { id: docD.id } });
    expect(pinned.lineRoutingVersionId).toBe(routeB);

    const bInstanceFor = (subjectId: string) =>
      db.workflowInstance.findFirstOrThrow({
        where: { tenantId: tenantBId, subjectType: 'PURCHASE_LINE', subjectId },
      });
    const bOne = await bInstanceFor(docD.lines[0].id);
    const bTwo = await bInstanceFor(docD.lines[1].id);

    // Every commercial rule is approved as well, and the first line is approved. Every input
    // the projection would read under a line-driven policy says yes -- and the document has not
    // moved, because INDEPENDENT tells the projection not to read the lines at all.
    const approvals = (await getApprovals(docD.id, userB1)).approvals;
    expect(approvals).toHaveLength(2);
    expect((await approveStep(bOne.id, 'manager', userB1)).status).toBe(201);
    for (const approval of approvals) {
      await http()
        .post(`${api}/commercial-approvals/${approval.id}/decision`)
        .set(authed(userB1))
        .send({ decision: 'APPROVED', comment: 'V-H' })
        .expect(200);
    }
    expect(approvals[0].id).toBeDefined();
    expect((await getDoc(docD.id, userB1)).status).toBe('SUBMITTED');

    // Now the SECOND line settles too, so that every decision V-G needed has been made here as
    // well. The two documents are the same shape, decided the same way, with one setting
    // different -- and the outcomes differ:
    //   docE, ALL_APPROVED  -> APPROVED   (V-G)
    //   docD, INDEPENDENT   -> SUBMITTED  (here)
    // That is the whole of the aggregation policy. Under INDEPENDENT the lines are declared not
    // to carry the document: it moves on a DOCUMENT-level decision, and nothing in this bounded
    // context ever creates a document-level workflow instance.
    expect((await approveStep(bTwo.id, 'manager', userB1)).status).toBe(201);
    expect((await db.workflowInstance.findUniqueOrThrow({ where: { id: bTwo.id } })).status).toBe(
      'APPROVED'
    );
    expect(
      (await getApprovals(docD.id, userB1)).approvals.every(
        (approval) => approval.status === 'APPROVED'
      )
    ).toBe(true);
    expect((await getDoc(docD.id, userB1)).status).toBe('SUBMITTED');
  });

  // -------------------------------------------------------------------------
  // The seam: every one of those moves was audited and announced, and each
  // notification carries the document it is about
  // -------------------------------------------------------------------------
  it('V-seam: every lifecycle move travelled through the audit and notification ports', async () => {
    for (const documentId of [docA.id, docB.id]) {
      expect(auditEvents.some((event) => event.resourceId === documentId)).toBe(true);
    }
    expect(notifications.some((note) => note.payload.documentId === docB.id)).toBe(true);
    for (const note of notifications) {
      expect([tenantAId, tenantBId]).toContain(note.payload.tenantId);
    }
  });

  // =========================================================================
  // PHASE C2 (GAP-1, GAP-1b) — the production workflow-execution routes and the
  // server-side pending-decisions inbox, through the same boundary stack.
  //
  // What is asserted, in the order the C2 contract states it:
  //   A  the §11 reads (list + detail) over real data, with pagination and no tenant scope
  //   B  the inbox lists BOTH kinds for their owner, newest-first, batch-joined, and
  //      NEVER for another actor or another tenant
  //   C  authentication (401), entitlement (403 with the exact tenant message) and the
  //      `commerce.read` vs `commerce.approve` permission split
  //   D  decide: actor rule (400 + code), unknown step instance (404 + code), the
  //      decision itself (200 + server status), the stale repeat (409 + code), and the
  //      inbox's decided-row exclusion afterwards
  //   E  the commercial half: a decided CommercialApproval leaves the inbox too
  //   F  cancel: `commerce.approve`-guarded per N's contract ("no cancellation roles"),
  //      RUNNING → CANCELLED + PENDING → SKIPPED atomically, repeat → 409, and the
  //      document status untouched (cancellation moves nothing else)
  // =========================================================================
  describe('PHASE C2 — workflow-execution HTTP surface and the pending-decisions inbox', () => {
    const TENANT_CONTEXT_MESSAGE =
      'Commerce requires a tenant context; this request was not resolved to a tenant.';

    let c2Doc: CreatedPurchaseDocument;
    let c2Line: string;
    let c2Run: { id: string; status: string };
    let c2StepInstanceId: string;
    let c2ApprovalId: string;
    let cancelDoc: CreatedPurchaseDocument;
    let cancelRun: { id: string; status: string };

    const listRuns = (as: string, query = '?page=1&pageSize=50') =>
      http().get(`${api}/workflow-instances${query}`).set(authed(as));
    const getRun = (instanceId: string, as: string) =>
      http().get(`${api}/workflow-instances/${instanceId}`).set(authed(as));
    const decide = (instanceId: string, stepInstanceId: string, as: string, body: object) =>
      http()
        .post(`${api}/workflow-instances/${instanceId}/steps/${stepInstanceId}/decision`)
        .set(authed(as))
        .send(body);
    const cancelRunRoute = (instanceId: string, as: string) =>
      http().post(`${api}/workflow-instances/${instanceId}/cancel`).set(authed(as));
    const inbox = (as: string, query = '?page=1&pageSize=50') =>
      http().get(`${api}/pending-decisions${query}`).set(authed(as));
    const runFor = (lineId: string) =>
      db.workflowInstance.findFirstOrThrow({
        where: { tenantId: tenantAId, subjectType: 'PURCHASE_LINE', subjectId: lineId },
      });

    it('C2-A: lists and reads its runs through §11 with pagination and no tenant scope', async () => {
      c2Doc = await createDoc(oneLine(4, 6));
      c2Line = c2Doc.lines[0].id;
      await http()
        .post(`${api}/purchase-documents/${c2Doc.id}/submit`)
        .set(authed(userA1))
        .expect(200);
      c2Run = await runFor(c2Line);

      // The approver's own paged list: our run is there, the window echoes back, and the
      // body carries no tenant scope anywhere (a client derives scope from its session).
      const page1 = await listRuns(userA2, '?page=1&pageSize=3').expect(200);
      expect(page1.body.page).toBe(1);
      expect(page1.body.pageSize).toBe(3);
      expect(page1.body.items.length).toBeLessThanOrEqual(3);
      expect(page1.body.total).toBeGreaterThanOrEqual(1);
      const ours = page1.body.items.find((item) => item.id === c2Run.id);
      expect(ours).toBeDefined();
      expect(ours).not.toHaveProperty('tenantId');
      expect(JSON.stringify(page1.body)).not.toContain('"tenantId"');

      // A status filter is server-validated: a vocabulary the runtime does not know is a
      // validation refusal (this harness's exact production pipe answers 422).
      await listRuns(userA2, '?status=NOT_A_STATUS').expect(422);
      // A scope the caller tries to state is refused by the whitelist, never believed.
      await listRuns(userA2, '?tenantId=someone-elses-tenant').expect(422);

      // The detail: persisted outcomes only — the decision fields exist and are null,
      // the step's authored name is readable, and §5.7's raw input snapshot never ships.
      const detail = await getRun(c2Run.id, userA3).expect(200); // commerce.read, read-only member
      expect(detail.body.status).toBe('RUNNING');
      expect(detail.body.version.definition.code).toBe('V-SINGLE');
      expect(detail.body.steps).toHaveLength(1);
      expect(detail.body.steps[0]).toMatchObject({
        stepKey: 'manager',
        stepName: 'Manager',
        status: 'PENDING',
        decision: null,
        decidedAt: null,
      });
      expect(JSON.stringify(detail.body)).not.toContain('tenantId');
      expect(JSON.stringify(detail.body)).not.toContain('conditionInputSnapshot');

      // Another tenant cannot see it: B's list holds only B's runs.
      const forB = await listRuns(userB1).expect(200);
      expect(forB.body.items.some((item) => item.id === c2Run.id)).toBe(false);
      // …and the id itself is indistinguishable from an absent one across tenants.
      await getRun(c2Run.id, userB1).expect(404);
    });
    it('C2-B: the inbox lists BOTH kinds for their owner, newest-first and batch-joined', async () => {
      const page = await inbox(userA2).expect(200);
      expect(page.body).toMatchObject({ page: 1, pageSize: 50 });
      expect(page.body.total).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(page.body)).not.toContain('"tenantId"');

      // Deterministic order: createdAt descending across BOTH kinds.
      const items = (page.body as PendingDecisionPage).items;
      for (let i = 1; i < items.length; i += 1) {
        expect(items[i - 1].createdAt >= items[i].createdAt).toBe(true);
      }

      // The workflow half: a WORKFLOW_STEP row for OUR run — LINE-scoped, so its document
      // was resolved through the line (one batched statement) and its number rendered.
      const stepItem = items.find(
        (item) => item.kind === 'WORKFLOW_STEP' && item.workflowInstanceId === c2Run.id
      );
      expect(stepItem).toBeDefined();
      expect(stepItem).toMatchObject({
        id: expect.any(String),
        status: 'PENDING',
        purchaseDocumentId: c2Doc.id,
        purchaseLineId: c2Line,
        stepKey: 'manager',
        stepName: 'Manager',
      });
      expect(typeof stepItem.documentNumber).toBe('string');
      c2StepInstanceId = stepItem.id;

      // The commercial half: a COMMERCIAL_APPROVAL row for the same document — its own id,
      // its own line, no workflow fields (the kinds are never merged into one model).
      const approvalItem = items.find(
        (item) => item.kind === 'COMMERCIAL_APPROVAL' && item.purchaseDocumentId === c2Doc.id
      );
      expect(approvalItem).toBeDefined();
      expect(approvalItem).toMatchObject({
        id: expect.any(String),
        status: 'PENDING',
        purchaseDocumentId: c2Doc.id,
        purchaseLineId: expect.any(String),
        workflowInstanceId: null,
        stepKey: null,
        stepName: null,
      });
      expect(typeof approvalItem.documentNumber).toBe('string');
      c2ApprovalId = approvalItem.id;

      // ACTOR scope: the requester is not the approver — neither of OUR rows is his to act on.
      const asRequester = await inbox(userA1).expect(200);
      expect(
        asRequester.body.items.filter(
          (item) => item.purchaseDocumentId === c2Doc.id
        )
      ).toHaveLength(0);
      expect(asRequester.body.total).toBe(0);

      // TENANT scope: B's inbox never contains A's actionable rows.
      const asB = await inbox(userB1).expect(200);
      expect(
        asB.body.items.filter(
          (item) =>
            item.purchaseDocumentId === c2Doc.id || item.workflowInstanceId === c2Run.id
        )
      ).toHaveLength(0);
    });

    it('C2-C: authenticates, entitles and checks the permission before any act', async () => {
      // No principal at all — the JWT layer answers first, before any tenant logic (401).
      await http().get(`${api}/pending-decisions`).expect(401);
      await http().post(`${api}/workflow-instances/${c2Run.id}/cancel`).expect(401);
      await http()
        .post(`${api}/workflow-instances/${c2Run.id}/steps/${c2StepInstanceId}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(401);

      // Authenticated but unresolvable to a tenant — Commerce itself refuses, exact message,
      // before any read or write (the G7 rule, on the new routes).
      const noTenant = await inbox(unresolvedUserId);
      expect(noTenant.status).toBe(403);
      expect(msgOf(noTenant.body)).toBe(TENANT_CONTEXT_MESSAGE);
      const cancelNoTenant = await cancelRunRoute(c2Run.id, unresolvedUserId);
      expect(cancelNoTenant.status).toBe(403);
      expect(msgOf(cancelNoTenant.body)).toBe(TENANT_CONTEXT_MESSAGE);

      // The permission split: `commerce.read` may READ the surface…
      await inbox(userA3).expect(200);
      await getRun(c2Run.id, userA3).expect(200);
      // …and may not WRITE it — neither decision nor cancellation.
      const readOnlyDecide = await decide(c2Run.id, c2StepInstanceId, userA3, {
        decision: 'APPROVED',
      });
      expect(readOnlyDecide.status).toBe(403);
      const readOnlyCancel = await cancelRunRoute(c2Run.id, userA3);
      expect(readOnlyCancel.status).toBe(403);

      // A body-shaped scope is never believed: the DTO knows only decision + comment
      // (422 — this harness's exact production pipe).
      const smuggledTenant = await decide(c2Run.id, c2StepInstanceId, userA2, {
        decision: 'APPROVED',
        tenantId: 'someone-elses-tenant',
      });
      expect(smuggledTenant.status).toBe(422);
      // And an unknown decision is a validation refusal, not a planner one.
      await decide(c2Run.id, c2StepInstanceId, userA2, { decision: 'MAYBE' }).expect(422);
    });
    it('C2-D: decides through the production route — actor rule, once-only, inbox exclusion', async () => {
      // The actor rule, on the new shape with the same code the probe always answered:
      // the requester is not the resolved approver.
      const notMine = await decide(c2Run.id, c2StepInstanceId, userA1, { decision: 'APPROVED' });
      expect(notMine.status).toBe(400);
      expect(notMine.body.code).toBe('WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR');

      // An id that is not a step of THIS run — 404, the N code, and no write either way.
      const wrongStep = await decide(c2Run.id, randomUUID(), userA2, { decision: 'APPROVED' });
      expect(wrongStep.status).toBe(404);
      expect(wrongStep.body.code).toBe('WORKFLOW_STEP_NOT_FOUND');

      // Another tenant's id is indistinguishable from an absent one (tenant-scoped load).
      const crossTenant = await decide(c2Run.id, c2StepInstanceId, userB1, {
        decision: 'APPROVED',
      });
      expect(crossTenant.status).toBe(404);

      // The decision itself: APPROVED, by the resolved approver, answered with the run's
      // SERVER-authoritative resulting status — never an echo of the request body.
      const decided = await decide(c2Run.id, c2StepInstanceId, userA2, {
        decision: 'APPROVED',
        comment: 'C2-D',
      }).expect(200);
      expect(decided.body).toEqual({ instanceId: c2Run.id, status: 'APPROVED' });

      // The persisted outcome is what a later read returns, comment included.
      const detail = await getRun(c2Run.id, userA2).expect(200);
      expect(detail.body.status).toBe('APPROVED');
      expect(detail.body.steps[0]).toMatchObject({
        id: c2StepInstanceId,
        decision: 'APPROVED',
        decisionComment: 'C2-D',
      });
      expect(detail.body.steps[0].decidedAt).toEqual(expect.any(String));

      // STALE: the same decision again — the step is history now — is the module's 409. This
      // single-step run SETTLED on the first decision, so the planner's precedence answers with
      // the RUN-level code (`WORKFLOW_INSTANCE_NOT_RUNNING`); a repeat whose run is still RUNNING
      // (a sequential workflow, still mid-flight) answers the STEP-level
      // `WORKFLOW_STEP_NOT_ACTIONABLE` instead — the unit suite pins that second shape.
      const again = await decide(c2Run.id, c2StepInstanceId, userA2, { decision: 'REJECTED' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WORKFLOW_INSTANCE_NOT_RUNNING');

      // The workflow half left the inbox the moment it stopped being actionable…
      const after = await inbox(userA2).expect(200);
      expect(
        after.body.items.some((item) => item.workflowInstanceId === c2Run.id)
      ).toBe(false);
      // …while the commercial half of the SAME document is still what it was: one system's
      // decision never decided the other's row.
      expect(
        after.body.items.some(
          (item) =>
            item.kind === 'COMMERCIAL_APPROVAL' && item.purchaseDocumentId === c2Doc.id
        )
      ).toBe(true);
      // And no document status moved under any of it.
      expect((await getDoc(c2Doc.id)).status).toBe('SUBMITTED');
    });

    it('C2-E: a decided commercial approval leaves the inbox too', async () => {
      await http()
        .post(`${api}/commercial-approvals/${c2ApprovalId}/decision`)
        .set(authed(userA2))
        .send({ decision: 'APPROVED', comment: 'C2-E' })
        .expect(200);

      const after = await inbox(userA2).expect(200);
      expect(after.body.items.some((item) => item.id === c2ApprovalId)).toBe(false);

      // The stale decision on THAT system is refused as well (the module's conflict, the
      // rule step P already shipped) — the regression the C2 contract asks to keep green.
      const again = await http()
        .post(`${api}/commercial-approvals/${c2ApprovalId}/decision`)
        .set(authed(userA2))
        .send({ decision: 'REJECTED', comment: 'C2-E-again' });
      expect(again.status).toBeGreaterThanOrEqual(400);

      // Line approved + approval approved is what moves THIS document, exactly as V-E proved.
      expect((await getDoc(c2Doc.id)).status).toBe('APPROVED');
    });
    it('C2-F: cancels atomically under `commerce.approve` and moves nothing else', async () => {
      cancelDoc = await createDoc(oneLine(5, 9));
      await http()
        .post(`${api}/purchase-documents/${cancelDoc.id}/submit`)
        .set(authed(userA1))
        .expect(200);
      cancelRun = await runFor(cancelDoc.lines[0].id);

      // The inbox shows the run's step before the cancel (it is actionable right now).
      const before = await inbox(userA2).expect(200);
      expect(
        before.body.items.some((item) => item.workflowInstanceId === cancelRun.id)
      ).toBe(true);

      // N's contract: a `commerce.approve`-guarded route, and "no cancellation roles" — the
      // requester's own approve-permission is authority enough; there is no per-user
      // cancellation actor to satisfy because none is modelled.
      const cancelled = await cancelRunRoute(cancelRun.id, userA1).expect(200);
      expect(cancelled.body).toEqual({ instanceId: cancelRun.id, status: 'CANCELLED' });

      // The TWO writes, atomically: the run settled and its PENDING step became SKIPPED.
      const detail = await getRun(cancelRun.id, userA2).expect(200);
      expect(detail.body.status).toBe('CANCELLED');
      expect(detail.body.steps[0].status).toBe('SKIPPED');
      expect(detail.body.steps[0].decision).toBeNull();

      // The cancelled run left the inbox — a CANCELLED run's steps are not tasks.
      const after = await inbox(userA2).expect(200);
      expect(
        (after.body as PendingDecisionPage).items.some(
          (item) => item.workflowInstanceId === cancelRun.id
        )
      ).toBe(false);

      // STALE: a second cancel is the state refusal, with the planner's code.
      const again = await cancelRunRoute(cancelRun.id, userA1);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WORKFLOW_INSTANCE_NOT_RUNNING');

      // Cancellation moved NOTHING else: the document is where the submit left it, and its
      // commercial approval is untouched (no dispatch on this path, by contract).
      expect((await getDoc(cancelDoc.id)).status).toBe('SUBMITTED');
      const approvals = await getApprovals(cancelDoc.id);
      expect(approvals.approvals[0].status).toBe('PENDING');
    });
  });

  // =========================================================================
  // PHASE C3 (GAP-2) — the production line-routing CONFIGURATION routes.
  //
  // What is asserted, in the order the C3 contract states it:
  //   A  an authorized reader pages the collection and reads one row (no tenant on the wire)
  //   B  authentication (401) and the `commerce.read` vs `commerce.workflow.manage` split
  //   C  tenant isolation: neither tenant can read or publish the other's version, the
  //      lists never cross, a shared LABEL is legal across tenants, and a client-stated
  //      tenantId is refused (422) rather than believed
  //   D  the exact supported schema: create → DRAFT (201) → read back → publish (200) →
  //      PUBLISHED → republish (409); and NO update route exists on this surface
  //   E  invalid criteria: refused at the edge by the DTO (422), refused by the DOMAIN
  //      gate at publish with its own named codes (409)
  //   F  a duplicate label within one tenant is the established 409
  //   G  the runtime is untouched: a submitted document still routes its lines through the
  //      PREVIOUSLY published PURCHASE_SUBMITTED version and pins THAT version
  //   H  cleanup leaves the file's "exactly one published version per tenant and trigger"
  //      invariant exactly as it found it
  // =========================================================================
  describe('PHASE C3 — the line-routing configuration HTTP surface', () => {
    const list = (as: string, query = '?page=1&pageSize=50') =>
      http().get(`${api}/routing-versions${query}`).set(authed(as));
    const getOne = (id: string, as: string) =>
      http().get(`${api}/routing-versions/${id}`).set(authed(as));
    const create = (body: object, as: string) =>
      http().post(`${api}/routing-versions`).set(authed(as)).send(body);
    const publish = (id: string, as: string) =>
      http().post(`${api}/routing-versions/${id}/publish`).set(authed(as));

    /** The one complete, valid payload the O contract describes (O1..O7). */
    const routingBody = (versionLabel: string, trigger = 'PURCHASE_SUBMITTED') => ({
      versionLabel,
      trigger,
      noRouteBehavior: 'LEAVE_UNROUTED',
      multipleMatchBehavior: 'HIGHEST_PRIORITY',
      aggregationPolicy: 'INDEPENDENT',
      routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: wfA.verId, condition: null }],
    });

    let c3PublishedId: string | null = null;

    it('C3-A: an authorized reader pages the tenant’s configuration, with no tenant on the wire', async () => {
      const page = await list(userA1).expect(200);
      expect(page.body).toEqual({
        items: expect.any(Array),
        page: 1,
        pageSize: 50,
        total: expect.any(Number),
      });

      // The C1 fixture's published routing version is in the collection, read back in
      // full — the configuration itself (`routeRules`) is part of a read by contract.
      const fixture = (page.body as RoutingVersionPage).items.find(
        (v) => v.versionLabel === 'V-ALL-APPROVED'
      );
      expect(fixture).toBeDefined();
      expect(fixture).not.toHaveProperty('tenantId');
      expect(fixture).toMatchObject({
        status: 'PUBLISHED',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'ALL_APPROVED',
      });
      expect(fixture.routeRules).toEqual(expect.any(Array));
      expect(fixture.routeRules.length).toBeGreaterThan(0);

      const detail = await getOne(fixture.id, userA1).expect(200);
      expect(detail.body).toEqual(fixture);
      expect(detail.body).not.toHaveProperty('tenantId');
    });

    it('C3-B: no principal → 401 on every route, and `commerce.read` is not `commerce.workflow.manage`', async () => {
      const anyId = randomUUID();
      await http().get(`${api}/routing-versions`).expect(401);
      await http().get(`${api}/routing-versions/${anyId}`).expect(401);
      await http().post(`${api}/routing-versions`).send(routingBody('C3-NO-PRINCIPAL')).expect(401);
      await http().post(`${api}/routing-versions/${anyId}/publish`).expect(401);

      // The read-only member (commerce.read only) may read the collection...
      const asReader = await list(userA3).expect(200);
      expect(Array.isArray(asReader.body.items)).toBe(true);

      // ...and may NOT write: the two mutations answer to commerce.workflow.manage.
      const deniedCreate = await create(routingBody('C3-DENIED'), userA3);
      expect(deniedCreate.status).toBe(403);
      const deniedPublish = await publish(anyId, userA3);
      expect(deniedPublish.status).toBe(403);
    });

    it('C3-C: tenant B cannot read or publish tenant A’s version, and the lists never cross', async () => {
      // The SAME label in both tenants — uniqueness is per tenant, so both are created.
      const mine = await create(routingBody('C3-SHARED-LABEL'), userA1).expect(201);
      const theirs = await create(routingBody('C3-SHARED-LABEL'), userB1).expect(201);
      expect(mine.body.id).not.toBe(theirs.body.id);

      // Cross-tenant access answers 404, not 403: the row is simply not in scope, and a
      // 403 would confirm its existence to a tenant that must not learn it exists.
      await getOne(mine.body.id, userB1).expect(404);
      await publish(mine.body.id, userB1).expect(404);
      await getOne(theirs.body.id, userA1).expect(404);

      const listA = await list(userA1).expect(200);
      expect(
        (listA.body as RoutingVersionPage).items.some((v) => v.id === theirs.body.id)
      ).toBe(false);
      const listB = await list(userB1).expect(200);
      expect(
        (listB.body as RoutingVersionPage).items.some((v) => v.id === mine.body.id)
      ).toBe(false);

      // A client-stated tenant is refused by the whitelist, never believed — neither as a
      // query parameter that could widen the read nor as a body field that could widen the write.
      const smuggledQuery = await http()
        .get(`${api}/routing-versions?tenantId=${tenantBId}`)
        .set(authed(userA1));
      expect(smuggledQuery.status).toBe(422);
      const smuggledBody = await create(
        { ...routingBody('C3-SMUGGLED'), tenantId: tenantBId },
        userA1
      );
      expect(smuggledBody.status).toBe(422);
    });

    it('C3-D: the exact supported schema — DRAFT → PUBLISHED — and no update route exists', async () => {
      // The trigger whose published slot this file has NEVER used, so this test cannot
      // disturb the runtime's PURCHASE_SUBMITTED resolution (C3-G proves that directly).
      const body = routingBody('C3-ROUTE-AFTER-APPROVED', 'AFTER_DOCUMENT_WORKFLOW_APPROVED');

      const created = await create(body, userA1).expect(201);
      expect(created.body).toMatchObject({
        versionLabel: 'C3-ROUTE-AFTER-APPROVED',
        status: 'DRAFT',
        trigger: 'AFTER_DOCUMENT_WORKFLOW_APPROVED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'INDEPENDENT',
      });
      expect(created.body).not.toHaveProperty('tenantId');
      expect(created.body.routeRules).toEqual([
        { priority: 1, targetWorkflowDefinitionVersionId: wfA.verId, condition: null },
      ]);

      // Read back exactly what was written.
      const read = await getOne(created.body.id, userA1).expect(200);
      expect(read.body).toEqual(created.body);

      // Deterministic newest-first ordering: a second draft created now comes first.
      const second = await create(routingBody('C3-ROUTE-SECOND'), userA1).expect(201);
      const page = await list(userA1).expect(200);
      const ids = (page.body as RoutingVersionPage).items.map((v) => v.id);
      expect(ids.indexOf(second.body.id)).toBeLessThan(ids.indexOf(created.body.id));

      // NO UPDATE SURFACE. C3 exposes create/read/list/publish only — a draft-edit route
      // would need an operation the configuration service does not have, so the path does
      // not exist at all (404 from the framework, not a 405 that promises one might).
      await http()
        .patch(`${api}/routing-versions/${created.body.id}`)
        .set(authed(userA1))
        .send({ versionLabel: 'renamed' })
        .expect(404);

      // Publish: the EXISTING gate runs the whole checklist (the target is a real
      // published workflow version) and answers with the server's resulting state.
      const published = await publish(created.body.id, userA1).expect(200);
      expect(published.body).toMatchObject({ id: created.body.id, status: 'PUBLISHED' });
      expect(published.body).not.toHaveProperty('tenantId');
      c3PublishedId = created.body.id;

      // Republish is the established 409 with the service's own code — immutability is
      // the contract's, and the walk states it.
      const again = await publish(created.body.id, userA1);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED');

      const after = await getOne(created.body.id, userA1).expect(200);
      expect(after.body.status).toBe('PUBLISHED');
      expect(after.body).not.toHaveProperty('tenantId');
    });

    it('C3-E: invalid routing criteria are refused at the edge, and by the DOMAIN gate at publish', async () => {
      const base = () => routingBody(`C3-INVALID-${randomUUID()}`);

      // 422 at the edge — the production pipe names the field rather than storing a row
      // no publication could ever accept.
      expect((await create({ ...base(), trigger: 'WHENEVER' }, userA1)).status).toBe(422);
      expect((await create({ ...base(), noRouteBehavior: 'FIRST' }, userA1)).status).toBe(422);
      expect((await create({ ...base(), routeRules: [] }, userA1)).status).toBe(422);
      expect(
        (
          await create(
            {
              ...base(),
              routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: 'not-a-uuid' }],
            },
            userA1
          )
        ).status
      ).toBe(422);
      expect((await create({ versionLabel: 'x' }, userA1)).status).toBe(422);

      // The DOMAIN gate the DTO deliberately does not duplicate: a DRAFT whose target is
      // not a published workflow version is refused AT PUBLISH with the named code — the
      // row exists (creation was legal) and NOTHING was published.
      const orphan = await create(
        {
          ...base(),
          routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: randomUUID() }],
        },
        userA1
      ).expect(201);
      const refused = await publish(orphan.body.id, userA1);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('WORKFLOW_LINE_ROUTING_TARGET_INVALID');
      expect((await getOne(orphan.body.id, userA1)).body.status).toBe('DRAFT');

      // The frozen LINE fact allowlist is checked by the SAME walk: a condition naming a
      // fact outside the catalogue is accepted as an object (shape only) and refused here.
      const rogue = await create(
        {
          ...base(),
          routeRules: [
            {
              priority: 1,
              targetWorkflowDefinitionVersionId: wfA.verId,
              condition: { field: 'rogueFact', op: 'equals', value: 'x' },
            },
          ],
        },
        userA1
      ).expect(201);
      const rogueRefused = await publish(rogue.body.id, userA1);
      expect(rogueRefused.status).toBe(409);
      expect(rogueRefused.body.code).toBe('WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED');
    });

    it('C3-F: a second version with a label this tenant already uses is the established 409', async () => {
      await create(routingBody('C3-LABEL-DUP'), userA1).expect(201);

      const duplicate = await create(routingBody('C3-LABEL-DUP'), userA1);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN');

      // Exactly ONE row with that label exists in this tenant — the refusal wrote nothing.
      const page = await list(userA1, '?page=1&pageSize=100').expect(200);
      expect(
        (page.body as RoutingVersionPage).items.filter(
          (v) => v.versionLabel === 'C3-LABEL-DUP'
        )
      ).toHaveLength(1);
    });

    it('C3-G: a submitted document still routes through the PREVIOUSLY published version and pins IT', async () => {
      // The version C1's fixture published, read straight from the tenant's own rows.
      const previouslyPublished = await db.workflowLineRoutingVersion.findFirstOrThrow({
        where: { tenantId: tenantAId, status: 'PUBLISHED', trigger: 'PURCHASE_SUBMITTED' },
      });

      const doc = await createDoc(oneLine(2, 10));
      await http()
        .post(`${api}/purchase-documents/${doc.id}/submit`)
        .set(authed(userA1))
        .expect(200);

      // Routing happened — the line got its OWN run — and the document PINNED the version
      // that resolution produced BEFORE this phase existed, not the C3-authored one (which
      // answers a different trigger, and therefore a different question entirely).
      const instance = await lineInstance(doc.lines[0].id);
      expect(instance.subjectType).toBe('PURCHASE_LINE');
      const stored = await db.purchaseDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(stored.lineRoutingVersionId).toBe(previouslyPublished.id);
      expect(stored.lineRoutingVersionId).not.toBe(c3PublishedId);

      // The file's own invariant is untouched: exactly ONE PURCHASE_SUBMITTED version is
      // published for this tenant, so the runtime's tie-break-free resolution stays
      // deterministic even after C3 created and published through the production routes.
      const published = await db.workflowLineRoutingVersion.findMany({
        where: { tenantId: tenantAId, status: 'PUBLISHED' },
      });
      expect(published.filter((row) => row.trigger === 'PURCHASE_SUBMITTED')).toHaveLength(1);
    });

    it('C3-H: cleanup — the C3-authored versions go, and the fixture’s published slot stays', async () => {
      // Test-only, tenant-scoped, explicit predicate: the same cleanup discipline the
      // file's afterAll uses (no TRUNCATE, no cross-tenant statement).
      const removedA = await db.workflowLineRoutingVersion.deleteMany({
        where: { tenantId: tenantAId, versionLabel: { startsWith: 'C3-' } },
      });
      const removedB = await db.workflowLineRoutingVersion.deleteMany({
        where: { tenantId: tenantBId, versionLabel: { startsWith: 'C3-' } },
      });
      expect(removedA.count).toBeGreaterThan(0);
      expect(removedB.count).toBeGreaterThan(0);

      // Back to the state the rest of the file expects: no C3 row remains, the fixture's
      // published version is still there, and it is still the ONLY published row for A.
      const remaining = await db.workflowLineRoutingVersion.findMany({
        where: { tenantId: tenantAId },
      });
      expect(remaining.map((row) => row.versionLabel)).toContain('V-ALL-APPROVED');
      expect(remaining.some((row) => row.versionLabel.startsWith('C3-'))).toBe(false);
      expect(
        await db.workflowLineRoutingVersion.count({
          where: { tenantId: tenantAId, status: 'PUBLISHED' },
        })
      ).toBe(1);
    });
  });

  // =========================================================================
  // PHASE C4-R (GAP-3) — the PURCHASE COMPLETION POLICY and the CLOSED transition,
  // through the same boundary stack.
  //
  // What is asserted, in the order the C4-R contract states it:
  //   A  configure: auth (401/403), edge validation (422), create → validate → publish,
  //      read-back, and PUBLISHED immutability — with no tenant ever on the wire
  //   B  close under the published policy: 200, server-recorded actor and timestamp, the
  //      pinned policy version, the audit act, and a repeat → 409
  //   C  the policy BLOCKS: a status it does not name is refused, and the document is
  //      left exactly as it was (the rule is configuration, not a constant)
  //   F  concurrency: two closes race — exactly one transition, one established 409
  //   D  change policy: publishing V2 archives V1, the NEXT close follows V2, and the
  //      document completed under V1 still explains itself with V1 (historical safety)
  //   E  tenant isolation: B sees only B, cannot read or modify A's policy, cannot close
  //      A's document, and with no policy of its own FAILS CLOSED
  //   G  lifecycle regression: payments, receipts, returns and the workflow keep their
  //      own state on a CLOSED document; later payments remain possible (C1 §29)
  //
  // NOTHING HERE IS A PRODUCT DEFAULT. The fixture policies state what a tenant would
  // configure; the code contains no preference for APPROVED, DRAFT or anything else —
  // which is exactly what C4 (the previous attempt) refused to invent.
  // =========================================================================
  describe('PHASE C4-R — the purchase completion policy and the CLOSED transition', () => {
    const policiesList = (as: string) =>
      http().get(`${api}/completion-policies?page=1&pageSize=50`).set(authed(as));
    const policyGet = (id: string, as: string) =>
      http().get(`${api}/completion-policies/${id}`).set(authed(as));
    const policyCreate = (body: object, as: string) =>
      http().post(`${api}/completion-policies`).set(authed(as)).send(body);
    const policyPatch = (id: string, body: object, as: string) =>
      http().patch(`${api}/completion-policies/${id}`).set(authed(as)).send(body);
    const policyValidate = (id: string, as: string) =>
      http().post(`${api}/completion-policies/${id}/validate`).set(authed(as));
    const policyPublish = (id: string, as: string) =>
      http().post(`${api}/completion-policies/${id}/publish`).set(authed(as));
    const closeDoc = (id: string, as: string) =>
      http().post(`${api}/purchase-documents/${id}/close`).set(authed(as));

    const completionBody = (versionLabel: string, allowedFromStatuses: string[]) => ({
      versionLabel,
      allowedFromStatuses,
    });

    let v1: string; // the first published policy (['APPROVED'])
    let v2: string; // the second published policy (['DRAFT'])
    /** The document completed under V1 — kept for the historical-safety assertion. */
    let closedUnderV1 = '';

    /** Drive a fresh document all the way to APPROVED through its own production routes. */
    const approveDocument = async () => {
      const doc = await createDoc(oneLine(1, 10));
      await http()
        .post(`${api}/purchase-documents/${doc.id}/submit`)
        .set(authed(userA1))
        .expect(200);
      const instance = await lineInstance(doc.lines[0].id);
      expect((await approveStep(instance.id, 'manager', userA2)).status).toBe(201);
      const approvals = await getApprovals(doc.id);
      await http()
        .post(`${api}/commercial-approvals/${approvals.approvals[0].id}/decision`)
        .set(authed(userA2))
        .send({ decision: 'APPROVED', comment: 'C4R' })
        .expect(200);
      const approved = await getDoc(doc.id);
      expect(approved.status).toBe('APPROVED');
      return approved;
    };

    it('C4-A: configures and publishes a completion policy — auth, edge validation, immutability', async () => {
      // No principal → 401 on every route of the surface, before anything is asked.
      await http().get(`${api}/completion-policies`).expect(401);
      await http().post(`${api}/completion-policies`).send({}).expect(401);
      await http().post(`${api}/completion-policies/${randomUUID()}/publish`).expect(401);
      await http().post(`${api}/purchase-documents/${randomUUID()}/close`).expect(401);

      // The read-only member (commerce.read only) may read the collection…
      const asReader = await policiesList(userA3).expect(200);
      expect(Array.isArray(asReader.body.items)).toBe(true);
      expect(asReader.body).not.toHaveProperty('tenantId');

      // …and may NOT configure: the five writes answer to commerce.configure, and the
      // close route to commerce.manage — both refused for this principal.
      expect((await policyCreate(completionBody('C4R-DENIED', ['APPROVED']), userA3)).status).toBe(
        403
      );
      expect((await closeDoc(randomUUID(), userA3)).status).toBe(403);
    });

    it('C4-A2: the edge refuses every set the model cannot hold, and publication walks the lifecycle', async () => {
      // 422 at the boundary: unknown, empty, out-of-vocabulary and client-supplied fields.
      for (const defect of [
        { allowedFromStatuses: [] },
        { allowedFromStatuses: ['CLOSED'] },
        { allowedFromStatuses: ['PAID'] },
        { allowedFromStatuses: ['MANAGER'] },
        { versionLabel: '' },
        { tenantId: 't1' },
      ]) {
        const refused = await policyCreate(
          { ...completionBody('C4R-EDGE', ['APPROVED']), ...defect },
          userA1
        );
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }

      // A valid policy walks the established lifecycle: DRAFT → validate → PUBLISHED.
      const created = await policyCreate(completionBody('C4R-01', ['APPROVED']), userA1).expect(
        201
      );
      expect(created.body).toMatchObject({
        status: 'DRAFT',
        versionLabel: 'C4R-01',
        allowedFromStatuses: ['APPROVED'],
      });
      // The tenant is the one thing a response body must never carry.
      expect(created.body).not.toHaveProperty('tenantId');
      v1 = created.body.id;

      // A draft may be edited — the status set only — before it is validated.
      const edited = await policyPatch(
        v1,
        { allowedFromStatuses: ['APPROVED'] },
        userA1
      ).expect(200);
      expect(edited.body.allowedFromStatuses).toEqual(['APPROVED']);

      expect((await policyValidate(v1, userA1)).body).toMatchObject({ status: 'VALIDATED' });
      const published = await policyPublish(v1, userA1).expect(200);
      expect(published.body).toMatchObject({ id: v1, status: 'PUBLISHED' });

      // PUBLISHED is immutable: both an edit and a republication are the service's own
      // 409, and the row is unchanged afterwards.
      const editPublished = await policyPatch(v1, { allowedFromStatuses: ['DRAFT'] }, userA1);
      expect(editPublished.status).toBe(409);
      expect(editPublished.body.code).toBe('PURCHASE_COMPLETION_POLICY_INVALID');
      const republish = await policyPublish(v1, userA1);
      expect(republish.status).toBe(409);
      expect(republish.body.code).toBe('PURCHASE_COMPLETION_POLICY_INVALID');
      expect((await policyGet(v1, userA1)).body).toMatchObject({
        status: 'PUBLISHED',
        allowedFromStatuses: ['APPROVED'],
      });

      // A duplicate label is the tenant-scoped 409 the schema's unique index backs.
      const duplicate = await policyCreate(completionBody('C4R-01', ['APPROVED']), userA1);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('PURCHASE_COMPLETION_POLICY_LABEL_TAKEN');

      // The trail carries the configuration acts on their own resource.
      expect(
        auditEvents.some(
          (event) =>
            event.resource === 'commerce.purchase_completion_policy_version' &&
            event.resourceId === v1
        )
      ).toBe(true);
    });

    it('C4-B: closes an APPROVED document under the published policy, recording actor, clock and pin', async () => {
      const doc = await approveDocument();

      const closed = await closeDoc(doc.id, userA1).expect(200);
      expect(closed.body).toMatchObject({ id: doc.id, status: 'CLOSED', editable: false });
      // §29's two records are in the projection the GET route shares — never in the request.
      expect(closed.body.completedByUserId).toBe(userA1);
      expect(closed.body.completedAt).toEqual(expect.any(String));
      expect(closed.body).not.toHaveProperty('tenantId');

      // Re-read through the ordinary read: the state is persisted, not a response artefact.
      const reloaded = await getDoc(doc.id);
      expect(reloaded.status).toBe('CLOSED');
      expect(reloaded.completedByUserId).toBe(userA1);
      expect(reloaded.completedAt).toEqual(expect.any(String));

      // The row remembers WHICH policy authorised the completion — the historical anchor
      // that makes "why was this closed?" answerable after the policy changes.
      const stored = await db.purchaseDocument.findFirstOrThrow({
        where: { id: doc.id, tenantId: tenantAId },
      });
      expect(stored.status).toBe('CLOSED');
      expect(stored.completedByUserId).toBe(userA1);
      expect(stored.completedAt).toBeInstanceOf(Date);
      expect(stored.completionPolicyVersionId).toBe(v1);

      // The document's own audit resource records the act, with both states.
      expect(
        auditEvents.some(
          (event) =>
            event.resource === 'commerce.purchase_document' &&
            event.resourceId === doc.id &&
            event.action === 'close'
        )
      ).toBe(true);

      // A repeat click is the stable "already completed" 409, in every configuration.
      const again = await closeDoc(doc.id, userA1);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('PURCHASE_DOCUMENT_ALREADY_COMPLETED');

      // Nothing else moved: the completion wrote one column set and no other lifecycle.
      expect((await getPayments(doc.id)).paymentStatus.status).toBe('UNPAID');
      expect((await getReturns(doc.id)).returns).toHaveLength(0);

      // Keep the id for the historical-safety assertion after the policy changes.
      closedUnderV1 = doc.id;
    });

    it('C4-C: the policy BLOCKS a status it does not name, and leaves the document untouched', async () => {
      // V1 allows only APPROVED, so a SUBMITTED document — however far its workflow has
      // come — may not be completed. The refusal names both sides of the rule.
      const doc = await createDoc(oneLine(1, 10));
      await http()
        .post(`${api}/purchase-documents/${doc.id}/submit`)
        .set(authed(userA1))
        .expect(200);
      expect((await getDoc(doc.id)).status).toBe('SUBMITTED');

      const refused = await closeDoc(doc.id, userA1);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PURCHASE_COMPLETION_STATUS_NOT_ALLOWED');
      expect(String(refused.body.message)).toContain('SUBMITTED');
      expect(String(refused.body.message)).toContain('APPROVED');

      // The document is exactly as it was: no status change, no completion record, no
      // partial write — the refusal precedes the ONLY write this act performs.
      const reloaded = await getDoc(doc.id);
      expect(reloaded).toMatchObject({
        status: 'SUBMITTED',
        completedAt: null,
        completedByUserId: null,
      });
      const stored = await db.purchaseDocument.findFirstOrThrow({
        where: { id: doc.id, tenantId: tenantAId },
      });
      expect(stored.completionPolicyVersionId).toBeNull();

      // And a DRAFT document is refused for the same reason — the rule is the POLICY's
      // set, not a status the code happens to prefer.
      const draft = await createDoc(oneLine(1, 10));
      const refusedDraft = await closeDoc(draft.id, userA1);
      expect(refusedDraft.status).toBe(409);
      expect(refusedDraft.body.code).toBe('PURCHASE_COMPLETION_STATUS_NOT_ALLOWED');
      expect((await getDoc(draft.id)).status).toBe('DRAFT');
    });

    it('C4-F: two concurrent closes produce exactly one transition and one established 409', async () => {
      const doc = await approveDocument();

      const [first, second] = await Promise.all([closeDoc(doc.id, userA1), closeDoc(doc.id, userA1)]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      // The loser answered the module's conflict semantics with a NAMED code — never a
      // second success, never a 500 from a lost race.
      const loser = first.status === 409 ? first : second;
      expect([
        'PURCHASE_DOCUMENT_ALREADY_COMPLETED',
        'PURCHASE_COMPLETION_WRITE_CONFLICT',
      ]).toContain(loser.body.code);

      // One completion, recorded once: the actor and the timestamp are not duplicated or
      // overwritten by the losing request.
      const stored = await db.purchaseDocument.findFirstOrThrow({
        where: { id: doc.id, tenantId: tenantAId },
      });
      expect(stored.status).toBe('CLOSED');
      expect(stored.completedByUserId).toBe(userA1);
      expect(stored.completedAt).toBeInstanceOf(Date);
      expect(stored.completionPolicyVersionId).toBe(v1);

      const reloaded = await getDoc(doc.id);
      expect(reloaded.status).toBe('CLOSED');
      expect(reloaded.completedAt).toEqual(expect.any(String));
    });

    it('C4-D: publishing V2 changes the NEXT close, and never re-explains a completed one', async () => {
      // The single-published invariant: publishing V2 archives V1 in the same act, so the
      // tenant has exactly ONE published policy — the one the close route reads.
      const created = await policyCreate(completionBody('C4R-02', ['DRAFT']), userA1).expect(201);
      v2 = created.body.id;
      const published = await policyPublish(v2, userA1).expect(200);
      expect(published.body).toMatchObject({ id: v2, status: 'PUBLISHED' });

      expect((await policyGet(v1, userA1)).body.status).toBe('ARCHIVED');
      const tenantAPolicies = await policiesList(userA1).expect(200);
      expect(
        (tenantAPolicies.body as CompletionPolicyPage).items.filter(
          (row) => row.status === 'PUBLISHED'
        )
      ).toHaveLength(1);

      // EFFECTIVE: a DRAFT document closes now, under V2, where V1 refused exactly that —
      // the product's configured rule, not a constant in the code.
      const draft = await createDoc(oneLine(1, 10));
      expect((await closeDoc(draft.id, userA1)).body).toMatchObject({
        id: draft.id,
        status: 'CLOSED',
      });
      const draftStored = await db.purchaseDocument.findFirstOrThrow({
        where: { id: draft.id, tenantId: tenantAId },
      });
      expect(draftStored.completionPolicyVersionId).toBe(v2);

      // HISTORICAL: the document completed under V1 still explains itself with V1 — a
      // later publication never rewrites which policy authorised an earlier completion.
      const underV1 = await db.purchaseDocument.findFirstOrThrow({
        where: { id: closedUnderV1, tenantId: tenantAId },
      });
      expect(underV1.status).toBe('CLOSED');
      expect(underV1.completionPolicyVersionId).toBe(v1);
    });

    it('C4-E: tenant isolation — B sees only B, cannot touch A’s policy, and fails closed alone', async () => {
      const createDocAs = async (as: string): Promise<CreatedPurchaseDocument> =>
        (
          await http()
            .post(`${api}/purchase-documents`)
            .set(authed(as))
            .send({ requesterId: as, supplierId: 'SUP-V', currency: 'EUR', lines: oneLine(1, 10) })
            .expect(201)
        ).body as CreatedPurchaseDocument;

      // B's list never contains A's rows — the read is scoped by construction.
      const bList = await policiesList(userB1).expect(200);
      expect(
        (bList.body as CompletionPolicyPage).items.some((row) => row.id === v1 || row.id === v2)
      ).toBe(false);

      // Reading or CHANGING A's policy by id is a 404: existence is never confirmed
      // across tenants, and no write reaches a foreign row.
      expect((await policyGet(v1, userB1)).status).toBe(404);
      expect((await policyPatch(v1, { allowedFromStatuses: ['DRAFT'] }, userB1)).status).toBe(404);
      expect((await policyPublish(v1, userB1)).status).toBe(404);
      expect((await policyValidate(v2, userB1)).status).toBe(404);

      // The same LABEL exists in both tenants — uniqueness is per tenant, by design.
      await policyCreate(completionBody('C4R-01', ['DRAFT']), userB1).expect(201);

      // B holds a DRAFT policy and no published one: the close act FAILS CLOSED with the
      // configuration failure — it never falls back to the draft, to "latest", or to
      // "no prerequisites" (brief §18).
      const bDoc = await createDocAs(userB1);
      const bClose = await closeDoc(bDoc.id, userB1);
      expect(bClose.status).toBe(409);
      expect(bClose.body.code).toBe('PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED');
      const bStored = await db.purchaseDocument.findFirstOrThrow({
        where: { id: bDoc.id, tenantId: tenantBId },
      });
      expect(bStored).toMatchObject({
        status: 'DRAFT',
        completedAt: null,
        completionPolicyVersionId: null,
      });

      // B closing A's document: 404 — the id is simply not B's — and A's row is untouched.
      const aDoc = await createDocAs(userA1);
      expect((await closeDoc(aDoc.id, userB1)).status).toBe(404);
      expect((await getDoc(aDoc.id)).status).toBe('DRAFT');
    });

    it('C4-G: on a CLOSED document every other lifecycle keeps its own behaviour (§29)', async () => {
      // Later payments continue on the same purchase — completion is not payment, and the
      // payment surface was never gated on the document's status.
      await http()
        .post(`${api}/purchase-documents/${closedUnderV1}/payments`)
        .set(authed(userA1))
        .send({ amount: 10, method: 'CASH', externalReference: 'C4R-AFTER' })
        .expect(201);

      const payments = await getPayments(closedUnderV1);
      expect(payments.paymentStatus.status).toBe('PAID');
      expect(payments.items).toHaveLength(1);

      // …and paying a completed purchase does not move its completion anywhere.
      const reloaded = await getDoc(closedUnderV1);
      expect(reloaded.status).toBe('CLOSED');
      expect(reloaded.completedByUserId).toBe(userA1);

      // Receiving and returns remain their own read-time projections, untouched: the
      // receipt surface still answers NOT_RECEIVED and there are still no returns.
      expect((await getReceipts(closedUnderV1)).lines[0].receivingStatus).toBe('NOT_RECEIVED');
      expect((await getReturns(closedUnderV1)).returns).toHaveLength(0);

      // The document's line workflow keeps ITS outcome: completion moved the document's
      // own status and nothing else — no workflow step instance was settled by it.
      const storedDoc = await db.purchaseDocument.findFirstOrThrow({
        where: { id: closedUnderV1, tenantId: tenantAId },
        include: { lines: true },
      });
      const run = await db.workflowInstance.findFirst({
        where: {
          tenantId: tenantAId,
          subjectType: 'PURCHASE_LINE',
          subjectId: storedDoc.lines[0].id,
        },
      });
      expect(run?.status).toBe('APPROVED');

      // A payment never rewrote the completion record.
      const finalRow = await db.purchaseDocument.findFirstOrThrow({
        where: { id: closedUnderV1, tenantId: tenantAId },
      });
      expect(finalRow).toMatchObject({
        status: 'CLOSED',
        completedByUserId: userA1,
        completionPolicyVersionId: v1,
      });
    });
  });

  // =========================================================================
  // PHASE C7 (GAP-7) — the purchase document audit timeline, over real HTTP
  //
  // The endpoint under test is GET /commerce/purchase-documents/:id/timeline, served
  // Controller → resolveCommerceActor → PurchaseTimelineService → PurchaseRepository →
  // CommerceAuditGateway → AUDIT_PORT.read → the contract-driven fake (the same
  // `validateAuditReadQuery` production binding uses). Every correspondence assertion
  // maps a response item id (`fake-audit-<n>`) back to `auditEvents[n-1]` — the seam
  // shared with the V-suite's audit assertions — so "resourceType/resourceId were
  // bound server-side" is PROVEN against the recorded trail, not assumed.
  // =========================================================================
  describe('PHASE C7 — the purchase document audit timeline (GAP-7)', () => {
    const timeline = (id: string) => `${api}/purchase-documents/${id}/timeline`;

    /** The recorded event behind one response item — the fake's id is its array index. */
    const recordedEventOf = (itemId: string) => {
      const index = Number(itemId.split('-')[2]);
      expect(Number.isInteger(index)).toBe(true);
      return auditEvents[index - 1];
    };

    /** The seven fields the Commerce projection whitelists — and nothing else. */
    const SAFE_ITEM_KEYS = [
      'action',
      'actorId',
      'changedFields',
      'createdAt',
      'id',
      'reason',
      'success',
    ];

    it('C7-A: a fresh document’s timeline is exactly its own recorded event — nothing fabricated', async () => {
      const doc = await createDoc(oneLine(1, 10));
      const res = await http().get(timeline(doc.id)).set(authed(userA1)).expect(200);

      // The page shape is the PLATFORM contract's — Commerce adds no envelope of its own.
      expect(Object.keys(res.body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
      // Creation itself is audited, so the honest answer for a brand-new document is
      // ONE event — never zero (that would mean the writer is missing) and never more
      // (that would mean fabricated history).
      expect(res.body.total).toBe(1);
      expect(res.body).toMatchObject({ page: 1, pageSize: 20 });
      expect(res.body.items).toHaveLength(1);

      const [item] = res.body.items;
      expect(Object.keys(item).sort()).toEqual(SAFE_ITEM_KEYS);
      expect(item).toMatchObject({ action: 'create', actorId: userA1, success: true });
      expect(item.createdAt).toEqual(expect.any(String));

      // Correspondence: the item maps back to a recorded event bound, server-side, to
      // THIS document, THIS resource type and THIS tenant.
      expect(recordedEventOf(item.id)).toMatchObject({
        resource: 'commerce.purchase_document',
        resourceId: doc.id,
        tenantId: tenantAId,
        action: 'create',
      });

      // No invented actions: every entry is one the module's writers actually record
      // on this resource (create/update/submit/close/line_routing_*).
      for (const entry of res.body.items) {
        expect(entry.action).toMatch(/^(create|update|submit|close|line_routing_)/);
      }

      // A page beyond the end is an HONEST empty page: zero items, total intact —
      // "nothing at this offset", not "nothing happened" and not "audit failed".
      const beyond = await http()
        .get(`${timeline(doc.id)}?page=99`)
        .set(authed(userA1))
        .expect(200);
      expect(beyond.body.items).toEqual([]);
      expect(beyond.body).toMatchObject({ page: 99, pageSize: 20, total: 1 });
    });

    it('C7-B: create → update → submit appear in platform chronology, bound to this document', async () => {
      const doc = await createDoc(oneLine(1, 10));
      await http()
        .patch(`${api}/purchase-documents/${doc.id}`)
        .set(authed(userA1))
        .send({ supplierId: 'C7-SUPPLIER' })
        .expect(200);
      await http()
        .post(`${api}/purchase-documents/${doc.id}/submit`)
        .set(authed(userA1))
        .expect(200);

      const res = await http().get(timeline(doc.id)).set(authed(userA1)).expect(200);
      const actions = (res.body as TimelinePage).items.map((entry) => entry.action);

      // The three acts are present AND in chronology (`createdAt ASC, id ASC`), never
      // re-ordered because "timelines usually show newest first".
      const created = actions.indexOf('create');
      const updated = actions.indexOf('update');
      const submitted = actions.indexOf('submit');
      expect(created).toBeGreaterThanOrEqual(0);
      expect(updated).toBeGreaterThan(created);
      expect(submitted).toBeGreaterThan(updated);
      const instants = (res.body as TimelinePage).items.map((entry) => entry.createdAt);
      expect([...instants].sort()).toEqual(instants);

      // EVERY item — including any line-routing events submit produced — maps back to
      // a recorded event on THIS document only.
      for (const entry of (res.body as TimelinePage).items) {
        expect(recordedEventOf(entry.id)).toMatchObject({
          resource: 'commerce.purchase_document',
          resourceId: doc.id,
          tenantId: tenantAId,
        });
      }

      // The edit is reported factually: which fields changed, not a business story.
      const update = (res.body as TimelinePage).items.find(
        (entry) => entry.action === 'update'
      );
      expect(update.changedFields).toEqual(['supplierId']);
    });
    it('C7-C: closing a document puts the completion event on its timeline, with actor and clock', async () => {
      // Self-contained policy: publish one allowing DRAFT so this test does not depend on
      // the exact state C4-R left behind (publishing archives the previous version, so
      // the single-published invariant holds either way).
      const policy = await http()
        .post(`${api}/completion-policies`)
        .set(authed(userA1))
        .send({ versionLabel: 'C7-C-POLICY', allowedFromStatuses: ['DRAFT'] })
        .expect(201);
      await http()
        .post(`${api}/completion-policies/${policy.body.id}/validate`)
        .set(authed(userA1))
        .expect(200);
      await http()
        .post(`${api}/completion-policies/${policy.body.id}/publish`)
        .set(authed(userA1))
        .expect(200);

      const doc = await createDoc(oneLine(1, 10));
      await http()
        .post(`${api}/purchase-documents/${doc.id}/close`)
        .set(authed(userA1))
        .expect(200);

      const res = await http().get(timeline(doc.id)).set(authed(userA1)).expect(200);
      const close = (res.body as TimelinePage).items.find(
        (entry) => entry.action === 'close'
      );
      expect(close).toBeDefined();
      expect(close).toMatchObject({ actorId: userA1, success: true });
      expect(close.createdAt).toEqual(expect.any(String));
      // The completion audit writer records the act ON THE DOCUMENT — so it arrives
      // through the same resource correlation, with no second query and no invention.
      expect(recordedEventOf(close.id)).toMatchObject({
        resource: 'commerce.purchase_document',
        resourceId: doc.id,
        tenantId: tenantAId,
        action: 'close',
      });
    });

    it('C7-D: tenant A’s and tenant B’s timelines never cross, in either direction', async () => {
      const aDoc = await createDoc(oneLine(1, 10));
      const bDoc = (
        await http()
          .post(`${api}/purchase-documents`)
          .set(authed(userB1))
          .send({
            requesterId: userB1,
            supplierId: 'C7-B-SUP',
            currency: 'EUR',
            lines: oneLine(2, 5),
          })
          .expect(201)
      ).body as CreatedPurchaseDocument;

      const aTimeline = await http().get(timeline(aDoc.id)).set(authed(userA1)).expect(200);
      const bTimeline = await http().get(timeline(bDoc.id)).set(authed(userB1)).expect(200);

      const aIds = new Set<string>(
        (aTimeline.body as TimelinePage).items.map((entry) => entry.id)
      );
      const bIds = new Set<string>(
        (bTimeline.body as TimelinePage).items.map((entry) => entry.id)
      );
      expect(aIds.size).toBeGreaterThanOrEqual(1);
      expect(bIds.size).toBeGreaterThanOrEqual(1);
      for (const id of bIds) expect(aIds.has(id)).toBe(false);

      // And behind every id: the recorded event's tenant and resourceId are the
      // answering tenant's own — no count, no event and no id leaks across.
      for (const entry of (aTimeline.body as TimelinePage).items) {
        expect(recordedEventOf(entry.id)).toMatchObject({
          tenantId: tenantAId,
          resourceId: aDoc.id,
        });
      }
      for (const entry of (bTimeline.body as TimelinePage).items) {
        expect(recordedEventOf(entry.id)).toMatchObject({
          tenantId: tenantBId,
          resourceId: bDoc.id,
        });
      }
    });

    it('C7-E: 401 without a principal, 403 without commerce.read, 200 for a reader', async () => {
      const doc = await createDoc(oneLine(1, 10));

      // 401 — no principal, before anything is asked.
      await http().get(timeline(doc.id)).expect(401);

      // 403 — a tenant member holding NO permission: RolesGuard refuses before the
      // service ever reaches the repository or the audit port.
      await http().get(timeline(doc.id)).set(authed(userA4)).expect(403);

      // 403 — an authenticated principal with no resolvable tenant fails closed with
      // the module's own message, never an unscoped read.
      const noTenant = await http().get(timeline(doc.id)).set(authed(unresolvedUserId)).expect(403);
      expect(msgOf(noTenant.body)).toBe(TENANT_CONTEXT_MESSAGE);

      // 200 — `commerce.read` alone is SUFFICIENT: the read-only member may read the
      // trail exactly as it may read the document (no narrower "own history" rule).
      const reader = await http().get(timeline(doc.id)).set(authed(userA3)).expect(200);
      expect(reader.body.total).toBeGreaterThanOrEqual(1);

      // 422 — the edge refuses out-of-range pagination, and REFUSES any scope parameter
      // a client tries to state: the audit query's tenant/resource/resourceId are
      // server-bound, so they are not even expressible on the wire.
      expect(
        (await http().get(`${timeline(doc.id)}?pageSize=101`).set(authed(userA1))).status
      ).toBe(422);
      expect(
        (await http().get(`${timeline(doc.id)}?tenantId=not-mine`).set(authed(userA1))).status
      ).toBe(422);
      expect(
        (await http().get(`${timeline(doc.id)}?resource=commerce.receipt`).set(authed(userA1)))
          .status
      ).toBe(422);
      expect(
        (await http().get(`${timeline(doc.id)}?resourceId=${randomUUID()}`).set(authed(userA1)))
          .status
      ).toBe(422);

      // And a non-UUID path segment never reaches the service at all.
      expect(
        (await http().get(`${api}/purchase-documents/not-a-uuid/timeline`).set(authed(userA1)))
          .status
      ).toBe(400);
    });
    it('C7-F: pages are deterministic, duplicate-free and lossless under the platform contract', async () => {
      const doc = await createDoc(oneLine(1, 10));
      // Creation plus three auditable edits = exactly four events on this document.
      for (const supplier of ['C7-F-1', 'C7-F-2', 'C7-F-3']) {
        await http()
          .patch(`${api}/purchase-documents/${doc.id}`)
          .set(authed(userA1))
          .send({ supplierId: supplier })
          .expect(200);
      }
      const recorded = auditEvents.filter(
        (event) =>
          event.resource === 'commerce.purchase_document' && event.resourceId === doc.id
      );
      expect(recorded).toHaveLength(4);

      const first = await http()
        .get(`${timeline(doc.id)}?page=1&pageSize=2`)
        .set(authed(userA1))
        .expect(200);
      const second = await http()
        .get(`${timeline(doc.id)}?page=2&pageSize=2`)
        .set(authed(userA1))
        .expect(200);

      expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 4 });
      expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 4 });
      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(2);

      // NO DUPLICATES and NO LOSS: the two pages partition the recorded set exactly,
      // in the platform's one deterministic order.
      const ids = [...(first.body as TimelinePage).items, ...(second.body as TimelinePage).items].map(
        (entry) => entry.id
      );
      expect(new Set(ids).size).toBe(4);
      expect(ids.map(recordedEventOf)).toEqual(recorded);
      expect(
        [...(first.body as TimelinePage).items, ...(second.body as TimelinePage).items].map(
          (entry) => entry.action
        )
      ).toEqual(['create', 'update', 'update', 'update']);
    });

    it('C7-G: an audit outage answers 503 AUDIT_READ_FAILED — never a quiet empty history', async () => {
      const doc = await createDoc(oneLine(1, 10));
      const healthy = await http().get(timeline(doc.id)).set(authed(userA1)).expect(200);
      expect(healthy.body.total).toBeGreaterThanOrEqual(1);

      auditReadFailure = true;
      try {
        const failed = await http().get(timeline(doc.id)).set(authed(userA1));
        // The status IS the distinction: 503 with the closed platform code, so a client
        // can tell "audit unavailable" from "nothing recorded" — a 200 with total 0
        // would falsely claim the document has no history.
        expect(failed.status).toBe(503);
        expect(failed.body).toMatchObject({ code: 'AUDIT_READ_FAILED' });
        expect(failed.body).not.toHaveProperty('items');
        expect(failed.body).not.toHaveProperty('total');
      } finally {
        auditReadFailure = false;
      }

      // Recovery: the same request succeeds again with the SAME total as before —
      // the outage changed nothing about what is recorded.
      const recovered = await http().get(timeline(doc.id)).set(authed(userA1)).expect(200);
      expect(recovered.body.total).toBe(healthy.body.total);
      expect(recovered.body.items).toEqual(healthy.body.items);
    });

    it('C7-H: a foreign purchase id is a 404 with no audit count or event leakage', async () => {
      const bDoc = (
        await http()
          .post(`${api}/purchase-documents`)
          .set(authed(userB1))
          .send({
            requesterId: userB1,
            supplierId: 'C7-H-SUP',
            currency: 'EUR',
            lines: oneLine(1, 7),
          })
          .expect(201)
      ).body as CreatedPurchaseDocument;

      const foreign = await http().get(timeline(bDoc.id)).set(authed(userA1));
      expect(foreign.status).toBe(404);
      expect(msgOf(foreign.body)).toBe('Purchase document not found');
      // The refusal body carries NO timeline fields — no items, no total, no count of
      // another tenant's events, and no id from another tenant's trail.
      expect(foreign.body).not.toHaveProperty('items');
      expect(foreign.body).not.toHaveProperty('total');
      expect(JSON.stringify(foreign.body)).not.toContain(bDoc.id);

      // And it is INDISTINGUISHABLE from an id that never existed: the same message,
      // so the endpoint is not an existence oracle for other tenants.
      const unknown = await http().get(timeline(randomUUID())).set(authed(userA1)).expect(404);
      expect(msgOf(unknown.body)).toBe(msgOf(foreign.body));
    });
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
    // PHASE C4-R: AFTER the documents, deliberately — a completed purchase pins the
    // completion policy that authorised it (ON DELETE RESTRICT), so the policy rows can
    // only go once the documents that name them are gone.
    deleted.purchaseCompletionPolicyVersion = (
      await db.purchaseCompletionPolicyVersion.deleteMany({ where })
    ).count;
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
    expect(deleted.workflowInstance).toBeGreaterThanOrEqual(6);
    expect(deleted.paymentRecord).toBeGreaterThanOrEqual(3);
    expect(deleted.returnDocument).toBeGreaterThanOrEqual(1);
    expect(await db.purchaseDocument.count({ where })).toBe(0);
    expect(await db.workflowInstance.count({ where })).toBe(0);
    await app.close();
  });

  const TENANT_CONTEXT_MESSAGE =
    'Commerce requires a tenant context; this request was not resolved to a tenant.';
});
