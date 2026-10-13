/**
 * PHASE C8 (GAP-5) — Commerce search, end to end over REAL HTTP and the REAL `commerce_db`.
 *
 * WHAT THIS SUITE PROVES — every assertion runs through the production boundary stack:
 * RequestContextMiddleware → global JwtAuthGuard → TenantContextGuard → RolesGuard →
 * controller ModuleEntitlementGuard + JwtAuthGuard → resolveCommerceActor → the real
 * repositories, exactly as `commerce-tenant.e2e-spec.ts` and `commerce-lifecycle.e2e-spec.ts`
 * run theirs (seams: the passport 'jwt' strategy is a probe header, and the platform ports
 * are in-memory; everything else is production code).
 *
 *   C8-A  purchase search by the CONFIRMED human-facing identifier (`documentNumber`),
 *         exact and case-insensitive
 *   C8-B  partial search (`contains`) returns exactly the tenant's matching rows and a
 *         tenant-scoped `total`
 *   C8-C  a valid query with no match is 200 / `items: []` / `total: 0` — never an error
 *   C8-D  tenant isolation: two tenants mint the SAME document number; each search returns
 *         only its own, and neither results nor `total` ever leak the other tenant
 *   C8-E  permission: 401 without a principal, 403 without `commerce.read`, 403 without a
 *         resolvable tenant, 200 for a read-only member
 *   C8-F  pagination: multiple pages over real records, no duplicate, no loss, identical
 *         order on a repeat read, `total` on every page, out-of-range page empty
 *   C8-G  query validation: over-long `search`, unknown parameters and an over-ceiling
 *         `pageSize` are refused with the established 422 `VALIDATION_FAILED` shape
 *   C8-H  regression: the unfiltered lists, the status filter and the document detail are
 *         unchanged by C8
 *   C8-N  the THREE surfaces C8 closes (commercial groups, commercial configuration
 *         versions, workflow definition versions): the search matches the identifying
 *         column, is case-insensitive, is tenant-isolated (same code/label/name in BOTH
 *         tenants), keeps `total` filtered, and honours `commerce.read`
 *
 * NO faked filters, no client-side assertions: every `search` predicate below is executed
 * by Postgres.
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
import { CommerceIdentityGateway } from '../src/modules/commerce/commerce-identity.gateway';
import { CommerceAuditGateway } from '../src/modules/commerce/commerce-audit.gateway';
import { CommerceNotificationGateway } from '../src/modules/commerce/commerce-notification.gateway';
import { CommerceSearchSourceService } from '../src/modules/commerce/search/commerce-search-source.service';

import { PurchaseController } from '../src/modules/commerce/purchase/purchase.controller';
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
const userA1 = randomUUID(); // tenant A, full catalogue
const userA2 = randomUUID(); // tenant A, member (liaison / approver fixture)
const userReadOnly = randomUUID(); // tenant A, ONLY commerce.read — search must work for it
const userNoGrants = randomUUID(); // tenant A, NO permissions — search must 403 for it
const userB1 = randomUUID(); // tenant B, full catalogue
const unresolvedUserId = randomUUID(); // deliberately absent from the registry (no tenant)

/** userId → tenantId. `unresolvedUserId` is deliberately absent. */
const tenantRegistry = new Map<string, string>([
  [userA1, tenantAId],
  [userA2, tenantAId],
  [userReadOnly, tenantAId],
  [userNoGrants, tenantAId],
  [userB1, tenantBId],
]);

const auditEvents: AuditEventInput[] = [];
const notifications: { eventType: string; payload: Record<string, unknown> }[] = [];

function profileOf(id: string): DirectoryUserProfile {
  return { id, firstName: 'Probe', lastName: 'User', avatarUrl: null, jobTitle: 'Tester', department: 'QA' };
}

const fakeTenantResolver: TenantResolver = {
  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const tenantId = input.userId ? tenantRegistry.get(input.userId) : undefined;
    return tenantId ? { tenantId, source: 'claim' } : { tenantId: null, source: 'none' };
  },
};

/**
 * Per-user grants, exactly as `commerce-lifecycle.e2e-spec.ts` does it: the read-only
 * member proves `commerce.read` is SUFFICIENT for every search in this suite, the
 * no-grant member proves it is NECESSARY (RolesGuard refuses before any query runs).
 */
const fakePermissionSource: PermissionSource = {
  async getEffectivePermissions(userId: string): Promise<string[]> {
    if (userId === userReadOnly) return [Permissions.COMMERCE_READ];
    if (userId === userNoGrants) return [];
    return Object.values(Permissions as Record<string, string>);
  },
};

const fakeEntitlementPort: EntitlementPort = {
  async decide(): Promise<{ ok: true }> {
    return { ok: true };
  },
};

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

/** Seam 1: passport 'jwt' reads the principal from `x-probe-user` (see the suites above). */
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
jest.setTimeout(180_000);

describe('PHASE C8 (GAP-5) — Commerce search over real HTTP', () => {
  let app: INestApplication;
  let db: CommercePrismaService;

  /** The five tenant-A documents, newest created LAST in the fixture. */
  const docsA: Array<{ id: string; documentNumber: string }> = [];
  const docsB: Array<{ id: string; documentNumber: string }> = [];
  let defA: string;
  let verA1: string;
  let verA2: string;

  const api = '/api/v1/commerce';
  const http = () => request(app.getHttpServer());
  const authed = (userId: string) => ({ 'x-probe-user': userId });

  const createDocument = async (as: string, supplierId: string) => {
    const res = await http()
      .post(`${api}/purchase-documents`)
      .set(authed(as))
      .send({
        requesterId: as,
        supplierId,
        currency: 'EUR',
        lines: [{ lineType: 'STANDARD', quantity: 1, unit: 'pcs', unitPrice: 1, tax: 0 }],
      })
      .expect(201);
    return res.body as { id: string; documentNumber: string };
  };

  beforeAll(async () => {
    // Replace whichever 'jwt' strategy the shared production boot registered.
    const passportAuthenticator = passport as unknown as { use: (strategy: unknown) => void };
    passportAuthenticator.use(new ProbeHeaderStrategy());

    const moduleRef = await Test.createTestingModule({
      imports: [CommerceSearchE2ECoreModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // The exact production pipe (main.ts contract: 422 on validation).
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

  // =========================================================================
  // Fixtures — created through their own production routes, never inserted
  // =========================================================================
  it('fixtures: creates five documents in tenant A and two in tenant B', async () => {
    for (let i = 0; i < 5; i += 1) {
      docsA.push(await createDocument(userA1, `C8-SUP-A-${i}`));
    }
    docsB.push(await createDocument(userB1, 'C8-SUP-B-0'));
    docsB.push(await createDocument(userB1, 'C8-SUP-B-1'));

    // The numbering key is (tenant, kind, Jalali year): both tenants mint their OWN series,
    // so the FIRST document of each tenant carries the SAME `documentNumber` — the exact
    // collision C8-D needs to prove search cannot cross it.
    expect(docsA[0].documentNumber).toMatch(/^PR-\d{4}-\d{5}$/);
    expect(docsB[0].documentNumber).toBe(docsA[0].documentNumber);
    expect(docsA.map((d) => d.documentNumber)).toHaveLength(new Set(docsA.map((d) => d.documentNumber)).size);
  });

  it('fixtures: creates the commercial and workflow configuration rows in both tenants', async () => {
    // Tenant A: two groups, one configuration version, one workflow with two versions.
    const groupA1 = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userA1))
      .send({ code: 'C8-ALPHA', name: 'Buying Team Alpha', liaisonUserId: userA2 })
      .expect(201);
    expect(groupA1.body.id).toEqual(expect.any(String));

    await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userA1))
      .send({ code: 'C8-BETA', name: 'Beta Procurement', liaisonUserId: userA2 })
      .expect(201);

    // Tenant B holds a group with the SAME code AND the SAME name — search as A must never
    // see it (C8-N).
    const groupB1 = await http()
      .post(`${api}/commercial-groups`)
      .set(authed(userB1))
      .send({ code: 'C8-ALPHA', name: 'Buying Team Alpha' })
      .expect(201);

    // The commercial configuration version — the proven body shape from
    // `commerce-lifecycle.e2e-spec.ts`, with this run's own group id.
    const configA = await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userA1))
      .send({
        versionLabel: 'C8-Policy-1405',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'C8-rule', priority: 1, condition: null, commercialGroupId: groupA1.body.id },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userA2,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);
    expect(configA.body.versionLabel).toBe('C8-Policy-1405');

    // Tenant B holds a version with the SAME label — labels are unique per tenant, never
    // globally, so this is legal and is exactly the isolation C8-N needs.
    await http()
      .post(`${api}/commercial-configurations`)
      .set(authed(userB1))
      .send({
        versionLabel: 'C8-Policy-1405',
        assignmentTrigger: 'PURCHASE_SUBMITTED',
        noAssignmentBehavior: 'LEAVE_UNASSIGNED',
        matchBehavior: 'HIGHEST_PRIORITY',
        assignmentRules: [
          { label: 'C8-rule', priority: 1, condition: null, commercialGroupId: groupB1.body.id },
        ],
        approvalActivation: 'PURCHASE_SUBMITTED',
        approvalApprover: 'CONFIGURED_USER',
        approverUserId: userB1,
        projectionPolicy: 'ALL_LINES_AND_COMMERCIAL',
      })
      .expect(201);

    // Workflow: tenant A gets a definition with TWO versions (the labels differ only in
    // their last segment, so a partial search must find exactly the matching one), tenant B
    // gets an identically-named definition and an identically-labelled version.
    const defARes = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(userA1))
      .send({ code: 'C8-WF', name: 'C8 Workflow' })
      .expect(201);
    defA = defARes.body.id;

    const verARes1 = await http()
      .post(`${api}/workflow-definitions/${defA}/versions`)
      .set(authed(userA1))
      .send({ versionLabel: 'c8-v-one', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    verA1 = verARes1.body.id;

    const verARes2 = await http()
      .post(`${api}/workflow-definitions/${defA}/versions`)
      .set(authed(userA1))
      .send({ versionLabel: 'c8-v-two', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);
    verA2 = verARes2.body.id;

    const defBRes = await http()
      .post(`${api}/workflow-definitions`)
      .set(authed(userB1))
      .send({ code: 'C8-WF', name: 'C8 Workflow' })
      .expect(201);
    await http()
      .post(`${api}/workflow-definitions/${defBRes.body.id}/versions`)
      .set(authed(userB1))
      .send({ versionLabel: 'c8-v-one', triggerEvent: 'PURCHASE_SUBMITTED' })
      .expect(201);

    expect(new Set([verA1, verA2]).size).toBe(2);
  });

  // =========================================================================
  // C8-A / B / C / D — the purchase register (the confirmed identifier)
  // =========================================================================
  it('C8-A: finds a document by its confirmed identifier — exactly and case-insensitively', async () => {
    const target = docsA[2];

    const exact = await http()
      .get(`${api}/purchase-documents?search=${encodeURIComponent(target.documentNumber)}`)
      .set(authed(userA1))
      .expect(200);
    expect(exact.body.items.map((row) => row.id)).toEqual([target.id]);
    expect(exact.body.total).toBe(1);

    // `mode: 'insensitive'` is the only transformation the shipped semantics guarantee, so
    // the lower-cased form of the SAME identifier matches the stored upper-case number.
    const lowered = await http()
      .get(
        `${api}/purchase-documents?search=${encodeURIComponent(target.documentNumber.toLowerCase())}`
      )
      .set(authed(userA1))
      .expect(200);
    expect(lowered.body.items.map((row) => row.id)).toEqual([target.id]);
    expect(lowered.body.total).toBe(1);
  });

  it('C8-B: a partial identifier returns exactly the tenant’s matching rows, and a matching total', async () => {
    const year = docsA[0].documentNumber.split('-')[1];

    const res = await http()
      .get(`${api}/purchase-documents?search=${encodeURIComponent(`PR-${year}-`)}`)
      .set(authed(userA1))
      .expect(200);

    expect(res.body.items).toHaveLength(docsA.length);
    expect(new Set(res.body.items.map((row) => row.id)).size).toBe(docsA.length);
    expect(res.body.total).toBe(docsA.length);

    // The total is the DATABASE's count under the same predicate — a server fact, not a
    // page-length echo.
    const expected = await db.purchaseDocument.count({
      where: {
        tenantId: tenantAId,
        documentNumber: { contains: `PR-${year}-`, mode: 'insensitive' },
      },
    });
    expect(res.body.total).toBe(expected);
  });

  it('C8-C: a valid query with no match is an empty page, never an error', async () => {
    const res = await http()
      .get(`${api}/purchase-documents?search=C8-NO-SUCH-DOCUMENT`)
      .set(authed(userA1))
      .expect(200);

    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });

  it('C8-D: the SAME document number in two tenants never crosses — neither items nor total', async () => {
    const shared = docsA[0].documentNumber;
    // The premise, asserted: two independent tenant series minted the same number.
    expect(shared).toBe(docsB[0].documentNumber);

    const asA = await http()
      .get(`${api}/purchase-documents?search=${encodeURIComponent(shared)}`)
      .set(authed(userA1))
      .expect(200);
    expect(asA.body.items.map((row) => row.id)).toEqual([docsA[0].id]);
    expect(asA.body.total).toBe(1);

    const asB = await http()
      .get(`${api}/purchase-documents?search=${encodeURIComponent(shared)}`)
      .set(authed(userB1))
      .expect(200);
    expect(asB.body.items.map((row) => row.id)).toEqual([docsB[0].id]);
    expect(asB.body.total).toBe(1);

    // Tenant B's SECOND number is ALSO minted inside tenant A's own series (A created five
    // documents, B two) — which makes the strongest form of the same claim available here:
    // the number matches rows in BOTH tenants, and A's answer is exactly ONE row — its own.
    const overlap = docsB[1].documentNumber;
    expect(overlap).toBe(docsA[1].documentNumber);

    // The database really holds two rows with that number — the leak, if it existed, would
    // be visible in the assertions that follow rather than absent from the fixture.
    expect(
      await db.purchaseDocument.count({
        where: { documentNumber: overlap, tenantId: { in: [tenantAId, tenantBId] } },
      })
    ).toBe(2);

    const overlapAsA = await http()
      .get(`${api}/purchase-documents?search=${encodeURIComponent(overlap)}`)
      .set(authed(userA1))
      .expect(200);
    expect(overlapAsA.body.items.map((row) => row.id)).toEqual([docsA[1].id]);
    expect(overlapAsA.body.items.map((row) => row.id)).not.toContain(docsB[1].id);
    // `total` is ONE, not two: the tenant predicate is part of the COUNT as well.
    expect(overlapAsA.body.total).toBe(1);
  });

  it('C8-E: 401 without a principal, 403 without commerce.read, 403 without a tenant, 200 for a reader', async () => {
    const q = `?search=${encodeURIComponent(docsA[0].documentNumber)}`;

    // 401 — no principal at all: authentication is the innermost guard.
    await http().get(`${api}/purchase-documents${q}`).expect(401);

    // 403 — an authenticated member holding NO grant (RolesGuard refuses before any query).
    await http().get(`${api}/purchase-documents${q}`).set(authed(userNoGrants)).expect(403);

    // 403 — an authenticated principal with no resolvable tenant, with Commerce's own
    // message: the request is refused rather than served unscoped.
    const noTenant = await http()
      .get(`${api}/purchase-documents${q}`)
      .set(authed(unresolvedUserId))
      .expect(403);
    expect(noTenant.body.message).toBe(
      'Commerce requires a tenant context; this request was not resolved to a tenant.'
    );

    // 200 — `commerce.read` ALONE is sufficient: the read-only member searches normally.
    const reader = await http()
      .get(`${api}/purchase-documents${q}`)
      .set(authed(userReadOnly))
      .expect(200);
    expect(reader.body.items.map((row) => row.id)).toEqual([docsA[0].id]);
  });

  it('C8-F: pages a filtered result set — no duplicate, no loss, stable order, bounded total', async () => {
    const year = docsA[0].documentNumber.split('-')[1];
    const filter = `search=${encodeURIComponent(`PR-${year}-`)}`;
    const pageOf = (page: number) =>
      http()
        .get(`${api}/purchase-documents?${filter}&pageSize=2&page=${page}`)
        .set(authed(userA1))
        .expect(200);

    const [one, two, three, four] = await Promise.all([pageOf(1), pageOf(2), pageOf(3), pageOf(4)]);

    const seen = [
      ...one.body.items,
      ...two.body.items,
      ...three.body.items,
    ].map((row) => row.id);

    // No duplicate, no loss: the three pages partition the five matching documents.
    expect(seen).toHaveLength(docsA.length);
    expect(new Set(seen).size).toBe(docsA.length);
    expect([...new Set(seen)].sort()).toEqual(docsA.map((d) => d.id).sort());

    // The window is echoed and the total is the FILTERED total on every page — including
    // the page past the end, which is empty rather than an error.
    for (const page of [one, two, three]) {
      expect(page.body.total).toBe(docsA.length);
      expect(page.body.pageSize).toBe(2);
    }
    expect(one.body.items).toHaveLength(2);
    expect(two.body.items).toHaveLength(2);
    expect(three.body.items).toHaveLength(1);
    expect(four.body.items).toEqual([]);
    expect(four.body.total).toBe(docsA.length);

    // Deterministic order: re-reading a page returns the identical sequence, and the order
    // itself is `createdAt desc` (ties broken by `id asc`, so pages cannot shuffle).
    const again = await pageOf(1);
    expect(again.body.items.map((row) => row.id)).toEqual(
      one.body.items.map((row) => row.id)
    );
    const times = one.body.items.map((row) => new Date(row.createdAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
  });

  it('C8-G: query validation keeps the established 422 semantics', async () => {
    const tooLong = 'x'.repeat(201);

    const over = await http()
      .get(`${api}/purchase-documents?search=${tooLong}`)
      .set(authed(userA1))
      .expect(422);
    expect(over.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // An undeclared parameter is REJECTED rather than ignored — which is what makes the
    // ABSENCE of a `tenantId` a boundary instead of an omission.
    const unknown = await http()
      .get(`${api}/purchase-documents?search=a&tenantId=x`)
      .set(authed(userA1))
      .expect(422);
    expect(unknown.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // The page ceiling is the DTO's, enforced at the edge (100 is `COMMERCE_MAX_PAGE_SIZE`).
    await http().get(`${api}/purchase-documents?pageSize=101`).set(authed(userA1)).expect(422);

    // The same rules answer on the three surfaces C8 closes.
    await http().get(`${api}/commercial-groups?search=${tooLong}`).set(authed(userA1)).expect(422);
    await http().get(`${api}/commercial-configurations?tenantId=x`).set(authed(userA1)).expect(422);
    await http()
      .get(`${api}/workflow-definitions/${defA}/versions?pageSize=101`)
      .set(authed(userA1))
      .expect(422);
  });

  it('C8-H: the unfiltered list, the status filter and the detail read are unchanged', async () => {
    const all = await http()
      .get(`${api}/purchase-documents?pageSize=100`)
      .set(authed(userA1))
      .expect(200);
    expect(all.body.total).toBe(docsA.length);
    expect(all.body.items).toHaveLength(docsA.length);

    // Every fixture document is a DRAFT, so the status filter selects them all — and a
    // status no fixture holds selects none, exactly as before C8.
    const drafts = await http()
      .get(`${api}/purchase-documents?status=DRAFT&pageSize=100`)
      .set(authed(userA1))
      .expect(200);
    expect(drafts.body.total).toBe(docsA.length);

    const approved = await http()
      .get(`${api}/purchase-documents?status=APPROVED`)
      .set(authed(userA1))
      .expect(200);
    expect(approved.body.items).toEqual([]);
    expect(approved.body.total).toBe(0);

    const detail = await http()
      .get(`${api}/purchase-documents/${docsA[0].id}`)
      .set(authed(userA1))
      .expect(200);
    expect(detail.body.documentNumber).toBe(docsA[0].documentNumber);
  });

  // =========================================================================
  // C8-N — the three surfaces C8 closes (the parameter that used to be ignored)
  // =========================================================================
  it('C8-N.1: commercial groups — code OR name, case-insensitively, tenant-isolated', async () => {
    const asA = (q: string) =>
      http().get(`${api}/commercial-groups?search=${encodeURIComponent(q)}`).set(authed(userA1));

    // NAME, partial and lower-cased: the stored label is «Buying Team Alpha».
    const byName = await asA('buying team').expect(200);
    expect(byName.body.total).toBe(1);
    expect(byName.body.items[0]).toMatchObject({ code: 'C8-ALPHA', name: 'Buying Team Alpha' });

    // CODE: the tenant's own stable handle.
    const byCode = await asA('C8-BETA').expect(200);
    expect(byCode.body.total).toBe(1);
    expect(byCode.body.items[0]).toMatchObject({ code: 'C8-BETA' });

    // A prefix shared by both of this tenant's groups, with the filtered total taken from
    // the database under the same predicate.
    const shared = await asA('c8-').expect(200);
    expect(shared.body.total).toBe(2);
    expect(shared.body.items.map((row) => row.code)).toEqual(['C8-ALPHA', 'C8-BETA']);
    const expected = await db.commercialGroup.count({
      where: {
        tenantId: tenantAId,
        OR: [
          { code: { contains: 'c8-', mode: 'insensitive' } },
          { name: { contains: 'c8-', mode: 'insensitive' } },
        ],
      },
    });
    expect(shared.body.total).toBe(expected);

    // No match is an empty page.
    const none = await asA('C8-NO-SUCH-GROUP').expect(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.total).toBe(0);

    // Tenant B holds a group with the SAME code and the SAME name: A's search never counts
    // it, and B's search never sees A's second group.
    const bAlpha = await http()
      .get(`${api}/commercial-groups?search=C8-ALPHA`)
      .set(authed(userB1))
      .expect(200);
    expect(bAlpha.body.total).toBe(1);

    const bBeta = await http()
      .get(`${api}/commercial-groups?search=C8-BETA`)
      .set(authed(userB1))
      .expect(200);
    expect(bBeta.body.items).toEqual([]);
    expect(bBeta.body.total).toBe(0);
  });

  it('C8-N.2: commercial configuration versions — versionLabel only, tenant-isolated', async () => {
    const label = 'c8-policy'; // the stored label is «C8-Policy-1405»

    const asA = await http()
      .get(`${api}/commercial-configurations?search=${encodeURIComponent(label)}`)
      .set(authed(userA1))
      .expect(200);
    expect(asA.body.total).toBe(1);
    expect(asA.body.items[0]).toMatchObject({ versionLabel: 'C8-Policy-1405' });

    // The filtered total is the database's count under the same predicate, scoped to A.
    const expected = await db.commercialConfigurationVersion.count({
      where: { tenantId: tenantAId, versionLabel: { contains: label, mode: 'insensitive' } },
    });
    expect(asA.body.total).toBe(expected);

    // Tenant B holds the same label in its OWN tenant series — each list reports exactly
    // its own row.
    const asB = await http()
      .get(`${api}/commercial-configurations?search=${encodeURIComponent(label)}`)
      .set(authed(userB1))
      .expect(200);
    expect(asB.body.total).toBe(1);
    expect(asB.body.items[0]).toMatchObject({ versionLabel: 'C8-Policy-1405' });
    expect(asB.body.items[0].id).not.toBe(asA.body.items[0].id);

    // A needle matching nothing: the entity's OTHER text (policy enums, rules) is not
    // searched, so a status word matches no row.
    const none = await http()
      .get(`${api}/commercial-configurations?search=${encodeURIComponent('HIGHEST_PRIORITY')}`)
      .set(authed(userA1))
      .expect(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.total).toBe(0);
  });

  it('C8-N.3: workflow definition versions — versionLabel, definition-scoped, tenant-isolated', async () => {
    const versionsOf = (definitionId: string, q: string, as: string) =>
      http()
        .get(
          `${api}/workflow-definitions/${definitionId}/versions?search=${encodeURIComponent(q)}`
        )
        .set(authed(as));

    // The version's own label, upper-cased in the query — the stored label is `c8-v-one`.
    const one = await versionsOf(defA, 'C8-V-ONE', userA1).expect(200);
    expect(one.body.total).toBe(1);
    expect(one.body.items.map((row) => row.id)).toEqual([verA1]);

    // A partial label shared by both of this definition's versions.
    const two = await versionsOf(defA, 'c8-v-', userA1).expect(200);
    expect(two.body.total).toBe(2);
    expect(new Set(two.body.items.map((row) => row.id))).toEqual(new Set([verA1, verA2]));

    // No match.
    const none = await versionsOf(defA, 'c8-v-nine', userA1).expect(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.total).toBe(0);

    // Tenant B holds an identically-labelled version, and it can never appear in A's read:
    // the query is scoped by DEFINITION and tenant.
    const bVersion = await db.workflowDefinitionVersion.findFirstOrThrow({
      where: { tenantId: tenantBId, versionLabel: 'c8-v-one' },
    });
    expect(one.body.items.map((row) => row.id)).not.toContain(bVersion.id);

    // And A's definition is not addressable from B at all — a foreign scope is a 404, never
    // a wider list.
    await versionsOf(defA, 'c8-v-one', userB1).expect(404);
  });

  it('C8-N.4: the C8 searches answer to commerce.read exactly like the lists they narrow', async () => {
    const groupSearch = (as: string) =>
      http().get(`${api}/commercial-groups?search=C8-ALPHA`).set(authed(as));

    // A read-only member holds enough.
    const reader = await groupSearch(userReadOnly).expect(200);
    expect(reader.body.total).toBe(1);

    // A member with no grant is refused before any query.
    await groupSearch(userNoGrants).expect(403);

    // A principal with no resolvable tenant is refused with Commerce's own message.
    const noTenant = await groupSearch(unresolvedUserId).expect(403);
    expect(noTenant.body.message).toBe(
      'Commerce requires a tenant context; this request was not resolved to a tenant.'
    );

    // 401 for an anonymous caller, on the search itself.
    await http().get(`${api}/commercial-configurations?search=C8`).expect(401);
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
    // AFTER the documents, deliberately: the commercial and routing PINs are foreign keys
    // ON the document row and are ON DELETE RESTRICT — a document keeps the versions it
    // pinned alive until the document itself is gone, and the groups wait for the versions
    // that name them.
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

    // The fixtures really existed: five documents in A and two in B, two definitions, two
    // configurations, three groups and two versions per tenant's workflow.
    expect(deleted.purchaseDocument).toBeGreaterThanOrEqual(7);
    expect(deleted.commercialGroup).toBeGreaterThanOrEqual(3);
    expect(deleted.workflowDefinition).toBeGreaterThanOrEqual(2);
    expect(await db.purchaseDocument.count({ where })).toBe(0);
    await app.close();
  });
});

@Module({
  imports: [CommercePrismaModule, PureRuleEngineModule],
  controllers: [
    PurchaseController,
    PurchaseCompletionPolicyController,
    PaymentHistoryController,
    ReceivingHistoryController,
    ReturnHistoryController,
    CommercialController,
    WorkflowConfigurationController,
  ],
  providers: [
    RequestContextService,
    // Production boundaries, in production order (see `commerce-tenant.e2e-spec.ts`).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    ModuleEntitlementGuard,
    // Real Commerce wiring for every controller above.
    CommerceIdentityGateway,
    CommerceAuditGateway,
    CommerceNotificationGateway,
    // PHASE C9 (GAP-5): the search source, wired exactly as production wires it — its
    // constructor registers it with the fake port below (this suite asserts Commerce
    // search semantics; `commerce-search-source.e2e-spec.ts` asserts the platform side).
    CommerceSearchSourceService,
    CommerceUnitOfWork,
    PurchaseRepository,
    PurchaseService,
    PurchaseTimelineService,
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
    // The in-memory ports (seam 2).
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
class CommerceSearchE2ECoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
