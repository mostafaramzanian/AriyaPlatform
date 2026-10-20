/**
 * PHASE C9 (GAP-5) — Commerce participation in PLATFORM GLOBAL SEARCH, end to end over
 * REAL HTTP and BOTH real databases (`commerce_db` + `core_db`).
 *
 * WHAT THIS SUITE PROVES. The Commerce Search Source Adapter registers with the REAL
 * `SEARCH_SOURCE_PORT`, pushes real projections when a purchase is created through the
 * production HTTP surface, and answers the platform's authoritative re-read — while
 * `GET /search` runs the production pipeline (normalization, retrieval, ranking,
 * pagination, envelope) exactly as `search.e2e-spec.ts` runs it.
 *
 *   C9-A  a created purchase appears in `GET /search`: source identity, title, snippet,
 *         composed route target, timestamp, score, index evidence — and no forbidden
 *         field anywhere on the wire
 *   C9-B  tenant isolation: two tenants mint the SAME document number; each actor sees
 *         only its own, and no count ever leaks the other tenant's row
 *   C9-C  authorization re-read: revoking `commerce.read` removes an already-indexed
 *         result — the index is not an authorization boundary
 *   C9-D  update: an edit to a non-identity field changes nothing about matching, keeps
 *         exactly ONE projection, and the supplier id is not searchable
 *   C9-E  stale: deleting the authoritative row makes the stale projection disappear
 *   C9-F  regression: an existing PLATFORM source still returns its results unchanged,
 *         beside Commerce results, in one response
 *   C9-G  source class: the registered source participates under PRIMARY (the platform's
 *         own multiplier), with scores on the platform's scale
 *   C9-H  permission: `commerce.read` alone is sufficient; no grant is empty of Commerce
 *         results; no principal is 401
 *   C9-I  documented platform boundary: `sourceType=EXTERNAL` is NOT an accepted filter
 *
 * SEAMS (the same two the C1–C8 suites use): the passport 'jwt' strategy is a probe
 * header, and the Commerce-side platform ports (entitlement, audit, directory,
 * notifications, tenant, permissions) are in-memory. Everything else is production —
 * including `SearchModule`, `PlatformSearchSourceModule`, Core `PrismaModule` and the
 * adapter itself.
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
import { PrismaService } from '../src/database/prisma.service';
import { PrismaModule } from '../src/database/prisma.module';
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

import { SearchModule } from '../src/search/search.module';
import { SearchIndexerService } from '../src/search/search-indexer.service';
import { SearchSourceService } from '../src/platform/search-source/search-source.service';
import { PlatformSearchSourceModule } from '../src/platform/search-source/platform-search-source.module';
import { COMMERCE_SEARCH_SOURCE_KEY } from '../src/modules/commerce/search/commerce-search-source.service';
import { CommercePrismaModule } from '../src/modules/commerce/database/commerce-prisma.module';
import { CommercePrismaService } from '../src/modules/commerce/database/commerce-prisma.service';
import { CommerceUnitOfWork } from '../src/modules/commerce/database/commerce-transaction';
import { CommerceIdentityGateway } from '../src/modules/commerce/commerce-identity.gateway';
import { CommerceAuditGateway } from '../src/modules/commerce/commerce-audit.gateway';
import { CommerceNotificationGateway } from '../src/modules/commerce/commerce-notification.gateway';
import { CommerceSearchSourceService } from '../src/modules/commerce/search/commerce-search-source.service';

import { PurchaseController } from '../src/modules/commerce/purchase/purchase.controller';
import { PurchaseCompletionPolicyRepository } from '../src/modules/commerce/completion/purchase-completion-policy.repository';
import { PurchaseCompletionPolicyService } from '../src/modules/commerce/completion/purchase-completion-policy.service';
import { PurchaseCompletionService } from '../src/modules/commerce/completion/purchase-completion.service';
import { InventoryPostingRepository } from '../src/modules/commerce/integration/inventory-posting.repository';
import { InventoryIntegrationService } from '../src/modules/commerce/integration/inventory-integration.service';
import { INVENTORY_POSTING_PORT } from '../src/modules/commerce/integration/inventory-posting.port';
import { createFakeInventoryPostingPort } from './fixtures/fake-inventory-posting-port';
import { PurchaseService } from '../src/modules/commerce/purchase/purchase.service';
import { PurchaseTimelineService } from '../src/modules/commerce/purchase/purchase-timeline.service';
import { PurchaseHistoryService } from '../src/modules/commerce/purchase/purchase-history.service';
import { PurchaseHistoryRepository } from '../src/modules/commerce/purchase/purchase-history.repository';
import { PaymentPlanRepository } from '../src/modules/commerce/payment-plan/payment-plan.repository';
import { PurchaseRepository } from '../src/modules/commerce/purchase/purchase.repository';
import { PaymentHistoryService } from '../src/modules/commerce/payment/payment-history.service';
import { PaymentHistoryRepository } from '../src/modules/commerce/payment/payment-history.repository';
import { ReceivingHistoryService } from '../src/modules/commerce/receiving/receiving-history.service';
import { ReceivingHistoryRepository } from '../src/modules/commerce/receiving/receiving-history.repository';
import { ReturnHistoryService } from '../src/modules/commerce/returns/return-history.service';
import { ReturnHistoryRepository } from '../src/modules/commerce/returns/return-history.repository';
import { CommercialConfigurationService } from '../src/modules/commerce/commercial/commercial-configuration.service';
import { CommercialConfigurationRepository } from '../src/modules/commerce/commercial/commercial-configuration.repository';
import { CommercialLifecycleService } from '../src/modules/commerce/commercial/commercial-lifecycle.service';
import { CommercialLifecycleRepository } from '../src/modules/commerce/commercial/commercial-lifecycle.repository';
import { CommercialLiaisonResolver } from '../src/modules/commerce/commercial/commercial-liaison';
import { WorkflowConfigurationService } from '../src/modules/commerce/workflow/workflow-configuration.service';
import { WorkflowConfigurationRepository } from '../src/modules/commerce/workflow/workflow-configuration.repository';
import { WorkflowExecutionService } from '../src/modules/commerce/workflow/workflow-execution.service';
import { WorkflowExecutionRepository } from '../src/modules/commerce/workflow/workflow-execution.repository';
import { WorkflowLineRoutingService } from '../src/modules/commerce/workflow/workflow-line-routing.service';
import { WorkflowLineRoutingRepository } from '../src/modules/commerce/workflow/workflow-line-routing.repository';
import { WorkflowLineRoutingConfigurationService } from '../src/modules/commerce/workflow/workflow-line-routing-configuration.service';


// ---------------------------------------------------------------------------
// Fixtures — two run-scoped tenants, four principals, in-memory platform ports
// ---------------------------------------------------------------------------
const runId = randomUUID().slice(0, 8);
const tenantAId = `c9-tenant-A-${runId}`;
const tenantBId = `c9-tenant-B-${runId}`;
const userA1 = randomUUID(); // tenant A, full catalogue
const userReadOnly = randomUUID(); // tenant A, ONLY `commerce.read`
const userNoGrants = randomUUID(); // tenant A, NO permissions
const userB1 = randomUUID(); // tenant B, full catalogue

/** userId → tenantId. */
const tenantRegistry = new Map<string, string>([
  [userA1, tenantAId],
  [userReadOnly, tenantAId],
  [userNoGrants, tenantAId],
  [userB1, tenantBId],
]);

/**
 * Per-user grants, MUTABLE on purpose: C9-C revokes `commerce.read` from `userA1`
 * mid-suite and the search must go dark without any row changing — the seam the real
 * `RolesGuard` asks is the same one the adapter asks, so a change here is the change a
 * real role edit makes.
 */
const grants = new Map<string, readonly string[]>([
  [userA1, Object.values(Permissions as Record<string, string>)],
  [userReadOnly, [Permissions.COMMERCE_READ]],
  [userNoGrants, []],
  [userB1, Object.values(Permissions as Record<string, string>)],
]);

const auditEvents: AuditEventInput[] = [];
const notifications: { eventType: string; payload: Record<string, unknown> }[] = [];

const fakeTenantResolver: TenantResolver = {
  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const tenantId = input.userId ? tenantRegistry.get(input.userId) : undefined;
    return tenantId ? { tenantId, source: 'claim' } : { tenantId: null, source: 'none' };
  },
};

const fakePermissionSource: PermissionSource = {
  async getEffectivePermissions(userId: string): Promise<string[]> {
    return [...(grants.get(userId) ?? [])];
  },
};

const fakeEntitlementPort: EntitlementPort = {
  async decide(): Promise<{ ok: true }> {
    return { ok: true };
  },
};

const fakeAuditPort = createFakeAuditPort(auditEvents);

function profileOf(id: string): DirectoryUserProfile {
  return { id, firstName: 'Probe', lastName: 'User', avatarUrl: null, jobTitle: 'Tester', department: 'QA' };
}

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

/** Seam 1: passport 'jwt' reads the principal from `x-probe-user` (as every C1–C8 suite). */
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


// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
jest.setTimeout(180_000);

describe('PHASE C9 (GAP-5) — Commerce in Platform Global Search over real HTTP', () => {
  let app: INestApplication;
  let db: CommercePrismaService;
  let core: PrismaService;
  let indexer: SearchIndexerService;

  /** Tenant A: the main document, the update document, the stale document. */
  let docA: { id: string; documentNumber: string };
  let docA2: { id: string; documentNumber: string };
  let docA3: { id: string; documentNumber: string };
  /** Tenant B: minted FIRST in its own tenant, so it shares `docA`'s number. */
  let docB: { id: string; documentNumber: string };
  let reminderId: string;

  const commerceApi = '/api/v1/commerce';
  const searchApi = '/api/v1/search';
  const http = () => request(app.getHttpServer());
  const authed = (userId: string) => ({ 'x-probe-user': userId });

  /** Fields the result envelope may never carry — asserted over the raw wire text. */
  const FORBIDDEN_RESULT_TEXT = [
    'tenantId',
    'requesterId',
    'supplierId',
    'passwordHash',
    'embedding',
    'searchText',
    'documentNumber"', // the FIELD name never crosses; the VALUE is the title
  ] as const;

  const createDocument = async (as: string, supplierId: string) => {
    const res = await http()
      .post(`${commerceApi}/purchase-documents`)
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

  const search = async (q: string, as: string) => {
    const res = await http().get(searchApi).set(authed(as)).query({ q, limit: 10 });
    expect(res.status).toBe(200);
    return res.body as {
      query: string;
      normalizedQuery: string;
      results: Array<{
        sourceType: string;
        sourceKey?: string;
        sourceId: string;
        title: string;
        snippet: string;
        score: number;
        timestamp: string;
        navigation: { href: string };
      }>;
      count: number;
      hasMore: boolean;
      mode: string;
      degraded: boolean;
      sourceCounts: Record<string, number>;
    };
  };

  const externalOf = (body: Awaited<ReturnType<typeof search>>) =>
    body.results.filter((result) => result.sourceType === 'EXTERNAL');

  beforeAll(async () => {
    // Replace whichever 'jwt' strategy the shared production boot registered.
    const passportAuthenticator = passport as unknown as { use: (strategy: unknown) => void };
    passportAuthenticator.use(new ProbeHeaderStrategy());

    const moduleRef = await Test.createTestingModule({
      imports: [CommerceSearchSourceE2ECoreModule],
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
    core = app.get(PrismaService);
    indexer = app.get(SearchIndexerService);
  });

  // ==========================================================================
  // Fixtures — created through the production routes, never inserted
  // ==========================================================================
  it('fixtures: creates three documents in tenant A, one in tenant B, and a platform reminder', async () => {
    docA = await createDocument(userA1, 'C9-SUP-A-0');
    docA2 = await createDocument(userA1, 'C9-SUP-A-1');
    docA3 = await createDocument(userA1, 'C9-SUP-A-2');
    docB = await createDocument(userB1, 'C9-SUP-B-0');

    // The numbering key is (tenant, kind, Jalali year): each tenant mints its OWN series,
    // so the FIRST document of each tenant carries the SAME number — the exact collision
    // C9-B needs to prove Global Search cannot cross it.
    expect(docA.documentNumber).toMatch(/^PR-\d{4}-\d{5}$/);
    expect(docB.documentNumber).toBe(docA.documentNumber);
    expect(new Set([docA.documentNumber, docA2.documentNumber, docA3.documentNumber]).size).toBe(3);

    // C9-F's platform fixture: a Core-owned row — `Reminder.userId` is a real FK into
    // `User`, so the OWNER is created first (tenant-less by design: the reminder's own
    // `tenantId` is the snapshot column the search authorizer reads). Indexed by the
    // EXISTING platform path, nothing Commerce-owned about it.
    await core.user.create({
      data: {
        id: userA1,
        email: `c9-${runId}@probe.test`,
        passwordHash: 'e2e-only-not-a-real-hash',
        firstName: 'C9',
        lastName: 'Probe',
      },
    });
    const reminder = await core.reminder.create({
      data: {
        userId: userA1,
        tenantId: tenantAId,
        title: `C9-PLATFORM-${runId}`,
        note: 'platform source regression fixture',
        dueAt: new Date('2026-12-01T08:00:00.000Z'),
      },
    });
    reminderId = reminder.id;
    await indexer.rebuildSource('REMINDER');
  });


  // ==========================================================================
  // C9-A — a created purchase appears in `GET /search`
  // ==========================================================================
  it('C9-A: the created purchase appears with source identity, composed route and no forbidden field', async () => {
    const body = await search(docA.documentNumber, userA1);
    const commerce = externalOf(body);

    expect(commerce).toHaveLength(1);
    const hit = commerce[0];

    // Source identity: the EXTERNAL marker plus the STABLE registered key — the two
    // fields that tell a client which bounded context answered.
    expect(hit.sourceType).toBe('EXTERNAL');
    expect(hit.sourceKey).toBe('commerce.purchase-document');
    expect(hit.sourceId).toBe(docA.id);

    // Presentation, read from the AUTHORITATIVE row at authorization time.
    expect(hit.title).toBe(docA.documentNumber);
    expect(typeof hit.snippet).toBe('string');
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(hit.timestamp))).toBe(false);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.score).toBeLessThanOrEqual(1);

    // Navigation: the platform composed it from the registered TEMPLATE plus the
    // URL-encoded id — the existing Purchase Detail route, no new page.
    expect(hit.navigation.href).toBe(`/admin/commerce/purchases/${encodeURIComponent(docA.id)}`);

    // The envelope, unchanged by C9.
    expect(body.query).toBe(docA.documentNumber);
    expect(body.count).toBe(body.results.length);
    expect(typeof body.hasMore).toBe('boolean');
    expect(['HYBRID', 'LEXICAL']).toContain(body.mode);
    expect(typeof body.degraded).toBe('boolean');
    expect(body.sourceCounts.EXTERNAL).toBe(1);

    // No forbidden field, no tenant id and no opaque identity anywhere on the wire.
    const raw = JSON.stringify(body);
    for (const forbidden of FORBIDDEN_RESULT_TEXT) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toContain(tenantAId);
    expect(raw).not.toContain(userA1);

    // Index evidence: the projection exists, is TENANT-STAMPED, and holds only the
    // normalized number — never the tenant id, the supplier or any identity.
    const rows = await core.searchDocument.findMany({
      where: { sourceType: 'EXTERNAL', sourceKey: 'commerce.purchase-document', sourceId: docA.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantAId);
    expect(rows[0].searchText).toContain('1405');
    expect(rows[0].searchText).not.toContain(tenantAId);
    expect(rows[0].searchText).not.toContain('C9-SUP');
  });

  // ==========================================================================
  // C9-B — tenant isolation under an identical document number
  // ==========================================================================
  it('C9-B: two tenants share a document number; each actor sees only its own, in results and counts', async () => {
    expect(docB.documentNumber).toBe(docA.documentNumber);

    const asA = await search(docA.documentNumber, userA1);
    const asAHits = externalOf(asA);
    expect(asAHits).toHaveLength(1);
    expect(asAHits[0].sourceId).toBe(docA.id);
    // The count is derived from the AUTHORIZED set: tenant B's identical row is neither
    // returned nor counted.
    expect(asA.sourceCounts.EXTERNAL).toBe(1);
    expect(asA.count).toBe(asAHits.length);
    expect(JSON.stringify(asA)).not.toContain(docB.id);
    expect(JSON.stringify(asA)).not.toContain(tenantBId);

    const asB = await search(docB.documentNumber, userB1);
    const asBHits = externalOf(asB);
    expect(asBHits).toHaveLength(1);
    expect(asBHits[0].sourceId).toBe(docB.id);
    expect(asB.sourceCounts.EXTERNAL).toBe(1);
    expect(JSON.stringify(asB)).not.toContain(docA.id);
    expect(JSON.stringify(asB)).not.toContain(tenantAId);
  });

  // ==========================================================================
  // C9-C — authorization re-read: the index is not an authorization boundary
  // ==========================================================================
  it('C9-C: revoking `commerce.read` darkens an already-indexed result; restoring it brings it back', async () => {
    // The index row is untouched below — only the actor's grant changes. If search
    // trusted the index (or its own cache), the result would survive.
    const before = await core.searchDocument.count({
      where: { sourceType: 'EXTERNAL', sourceId: docA.id },
    });
    expect(before).toBe(1);

    grants.set(userA1, []);
    try {
      const dark = await search(docA.documentNumber, userA1);
      expect(externalOf(dark)).toHaveLength(0);
      expect(dark.sourceCounts.EXTERNAL).toBeUndefined();
      // The row still EXISTS — absence is authorization, not deletion.
      expect(
        await core.searchDocument.count({ where: { sourceType: 'EXTERNAL', sourceId: docA.id } })
      ).toBe(1);
    } finally {
      grants.set(userA1, Object.values(Permissions as Record<string, string>));
    }

    const light = await search(docA.documentNumber, userA1);
    expect(externalOf(light)).toHaveLength(1);
    expect(externalOf(light)[0].sourceId).toBe(docA.id);
  });


  // ==========================================================================
  // C9-D — update: matching is driven by the identity text, and only by it
  // ==========================================================================
  it('C9-D: an edit to a non-identity field keeps matching, keeps ONE projection, and the supplier is not searchable', async () => {
    // The document NUMBER is the ONE searchable field, and no method in Commerce can
    // rewrite it — so "update a searchable field" is not a state this module has. What
    // an update MUST not do is disturb the projection or leak a non-projected field
    // into matching; both halves are asserted here.
    await http()
      .patch(`${commerceApi}/purchase-documents/${docA2.id}`)
      .set(authed(userA1))
      .send({ supplierId: 'C9-SUPPLIER-SECRET' })
      .expect(200);

    const still = await search(docA2.documentNumber, userA1);
    expect(externalOf(still)).toHaveLength(1);
    expect(externalOf(still)[0].sourceId).toBe(docA2.id);

    // Exactly ONE projection — an update pushed no second row and deleted nothing.
    expect(
      await core.searchDocument.count({ where: { sourceType: 'EXTERNAL', sourceId: docA2.id } })
    ).toBe(1);

    // The supplier was never projected: searching its exact value finds no Commerce row.
    const leaked = await search('C9-SUPPLIER-SECRET', userA1);
    expect(externalOf(leaked)).toHaveLength(0);
  });

  // ==========================================================================
  // C9-E — stale: the authoritative row is gone, the index row is not
  // ==========================================================================
  it('C9-E: a deleted authoritative row makes its stale projection disappear from results', async () => {
    // Purchase documents have no deletion PATH (the schema says so) — this exercises the
    // platform's stale-projection rule against direct drift, which is the removal
    // semantics Commerce actually has: the re-read is the truth.
    // PHASE W3: append-only status events RESTRICT their document — they go first.
    await db.purchaseStatusEvent.deleteMany({
      where: { tenantId: tenantAId, purchaseDocumentId: docA3.id },
    });
    await db.purchaseLine.deleteMany({
      where: { tenantId: tenantAId, purchaseDocumentId: docA3.id },
    });
    await db.purchaseDocument.deleteMany({ where: { tenantId: tenantAId, id: docA3.id } });

    // The stale index row is STILL THERE (nothing in Commerce calls `remove`)…
    expect(
      await core.searchDocument.count({ where: { sourceType: 'EXTERNAL', sourceId: docA3.id } })
    ).toBe(1);

    // …and the result is gone, because authorization re-reads the authoritative row.
    const body = await search(docA3.documentNumber, userA1);
    expect(externalOf(body)).toHaveLength(0);
    expect(body.sourceCounts.EXTERNAL).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(docA3.id);
  });


  // ==========================================================================
  // C9-F — regression: an existing PLATFORM source, unchanged, beside Commerce
  // ==========================================================================
  it('C9-F: an existing platform source still returns its result with its previous wire shape', async () => {
    const body = await search(`C9-PLATFORM-${runId}`, userA1);

    const platform = body.results.filter((result) => result.sourceType === 'REMINDER');
    expect(platform).toHaveLength(1);
    expect(platform[0].sourceId).toBe(reminderId);
    expect(platform[0].title).toBe(`C9-PLATFORM-${runId}`);
    // Platform results keep their byte-identical shape: the external-only `sourceKey`
    // field is ABSENT, not `undefined`.
    expect('sourceKey' in platform[0]).toBe(false);
    expect(platform[0].navigation.href.startsWith('/')).toBe(true);

    // The two sources coexist under their own identities in ONE response.
    expect(
      body.results.every((result) => ['REMINDER', 'EXTERNAL'].includes(result.sourceType))
    ).toBe(true);
    expect(body.count).toBe(body.results.length);
  });

  // ==========================================================================
  // C9-G — source class: PRIMARY, on the platform's scale
  // ==========================================================================
  it('C9-G: the source participates under PRIMARY — the platform multiplier, never a number of ours', async () => {
    // The class is a DESCRIPTOR value; the magnitude belongs to `SEARCH_WEIGHT_CLASS_FACTORS`.
    const sources = app.get(SearchSourceService);
    expect(sources.weightMultiplier(COMMERCE_SEARCH_SOURCE_KEY)).toBe(1);

    const body = await search(docA.documentNumber, userA1);
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });


  // ==========================================================================
  // C9-H — permission: `commerce.read` is the gate, and the only gate
  // ==========================================================================
  it('C9-H: `commerce.read` alone is sufficient, no grant is empty of Commerce results, no principal is 401', async () => {
    // Read-only member: the module's READ permission is enough for Global Search too.
    const readOnly = await search(docA.documentNumber, userReadOnly);
    expect(externalOf(readOnly)).toHaveLength(1);
    expect(externalOf(readOnly)[0].sourceId).toBe(docA.id);

    // No grants at all: 200 (Global Search has no gate of its own), but the source
    // answers NOTHING — `commerce.read` is necessary.
    const noGrants = await search(docA.documentNumber, userNoGrants);
    expect(noGrants.sourceCounts.EXTERNAL).toBeUndefined();
    expect(externalOf(noGrants)).toHaveLength(0);

    // No principal: refused before any query runs.
    await http().get(searchApi).query({ q: docA.documentNumber }).expect(401);
  });

  // ==========================================================================
  // C9-I — documented platform boundary: `sourceType=EXTERNAL` is not a filter
  // ==========================================================================
  it('C9-I: `sourceType=EXTERNAL` is refused — the filter allowlist is a platform decision (§AA.4)', async () => {
    const res = await http()
      .get(searchApi)
      .set(authed(userA1))
      .query({ q: docA.documentNumber, sourceType: 'EXTERNAL' });

    // Refused by the DTO's explicit allowlist rather than silently accepted without
    // rules — exactly the state P-SEARCH-SOURCE left it in.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  // ==========================================================================
  // Teardown — this suite's rows only, then the app
  // ==========================================================================
  afterAll(async () => {
    // Commerce: lines first (RESTRICT), then the documents this suite minted.
    const where = { tenantId: { in: [tenantAId, tenantBId] } };
    await db.purchaseStatusEvent.deleteMany({ where });
    await db.purchaseLine.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    const deleted = await db.purchaseDocument.deleteMany({ where });

    // Core: the external projections this suite pushed (tenants are run-scoped, so the
    // predicate is exact), the reminder row and its projection.
    await core.searchDocument.deleteMany({
      where: { sourceType: 'EXTERNAL', tenantId: { in: [tenantAId, tenantBId] } },
    });
    await core.searchDocument.deleteMany({ where: { sourceType: 'REMINDER', sourceId: reminderId } });
    await core.reminder.deleteMany({ where: { id: reminderId } });
    await core.user.deleteMany({ where: { id: userA1 } });

    // docA, docA2 and docB remain (docA3 was deleted by C9-E itself).
    expect(deleted.count).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});


// ---------------------------------------------------------------------------
// The harness: production boundaries + real Global Search + in-memory ports
// ---------------------------------------------------------------------------
@Module({
  imports: [
    CommercePrismaModule,
    PureRuleEngineModule,
    // The platform's Global Search, REAL: `SearchController`/`SearchService`,
    // `PlatformSearchSourceModule` — which binds the REAL `SEARCH_SOURCE_PORT` the
    // Commerce adapter registers into — plus the Core `PrismaModule` the index lives
    // behind. Nothing about search is stubbed in this suite.
    PrismaModule,
    SearchModule,
    PlatformSearchSourceModule,
  ],
  controllers: [PurchaseController],
  providers: [
    RequestContextService,
    // Production boundaries, in production order (see `commerce-tenant.e2e-spec.ts`).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    ModuleEntitlementGuard,
    // Real Commerce wiring — the proven C1 provider graph, plus the C9 search source
    // (whose constructor registers it with the REAL port imported above).
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
    PurchaseCompletionPolicyRepository,
    PurchaseCompletionPolicyService,
    PurchaseCompletionService,
    InventoryPostingRepository,
    InventoryIntegrationService,
    { provide: INVENTORY_POSTING_PORT, useValue: createFakeInventoryPostingPort() },
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
    // The in-memory ports (seam 2). `PermissionSource` is the seam BOTH the
    // `RolesGuard` and the Commerce search source ask — one mutable grant table drives
    // the HTTP gate and the authorization re-read alike.
    { provide: TenantResolver, useValue: fakeTenantResolver },
    { provide: PermissionSource, useValue: fakePermissionSource },
    { provide: ENTITLEMENT_PORT, useValue: fakeEntitlementPort },
    { provide: AUDIT_PORT, useValue: fakeAuditPort },
    { provide: USER_DIRECTORY, useValue: fakeDirectory },
    { provide: NotificationPublisher, useValue: fakeNotificationPublisher },
    // GAP-9: the gateway's second dependency — the same double (see the integration suite).
    { provide: NotificationService, useValue: fakeNotificationService },
  ],
})
class CommerceSearchSourceE2ECoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

