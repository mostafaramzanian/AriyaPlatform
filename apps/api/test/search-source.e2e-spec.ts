import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';

import { PrismaService } from '../src/database/prisma.service';
import { PrismaModule } from '../src/database/prisma.module';
import { SearchModule } from '../src/search/search.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

import {
  SEARCH_SOURCE_PORT,
  SearchSourceRegistrationError,
  type RegisteredSearchSource,
  type SearchSourceAdapter,
  type SearchSourceDescriptor,
  type SearchSourcePort,
} from '../src/platform/search-source/search-source.contract';
import {
  createFakeSearchSourcePort,
  type FakeSearchSourceEntity,
} from './fixtures/fake-search-source';

/**
 * PHASE P-SEARCH-SOURCE — the platform search source contract, end to end over REAL
 * HTTP and the REAL `core_db` `SearchDocument` table.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * A source registers through the platform port, submits projections, and its rows
 * appear in `GET /search` — authorized by ITS OWN adapter, weighted by ITS declared
 * class, tenant-isolated by the platform's exact-equality predicate, removed by
 * `remove(...)`, and dropped (never leaked) when the source refuses, throws or
 * answers out of contract. The platform's eight existing sources are not exercised
 * here — that regression is search.e2e-spec.ts, which this phase leaves untouched.
 *
 * THE TEST SOURCE IS NOT COMMERCE. There is no Commerce code anywhere in this
 * phase: the adapter is the reusable contract fake
 * (`test/fixtures/fake-search-source.ts`), whose authorization truth is a seeded
 * entity set — a stand-in for any bounded context's own rules.
 *
 * SEMANTIC RETRIEVAL IS EXPECTED TO BE UNAVAILABLE (no credential in `.env.e2e`),
 * so every result below is found lexically; the degraded mode is asserted rather
 * than assumed, exactly as 49J's suite does.
 */

class SearchTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('Platform Search Source E2E (registration, projection, authorization, tenancy)', () => {
  const runId = Date.now().toString(36);
  const TOKEN = `ps${runId}`;

  const KEYS = {
    purchase: 'test.purchase-documents',
    primary: 'test.primary-source',
    supporting: 'test.supporting-source',
    broken: 'test.broken-source',
  } as const;

  let app: INestApplication;
  let prisma: PrismaService;
  let port: SearchSourcePort;

  /** Registered handles, one per scenario source. */
  let purchase: RegisteredSearchSource;
  let seedPurchase: (entities: readonly FakeSearchSourceEntity[]) => void;
  let primary: RegisteredSearchSource;
  let seedPrimary: (entities: readonly FakeSearchSourceEntity[]) => void;
  let supporting: RegisteredSearchSource;
  let seedSupporting: (entities: readonly FakeSearchSourceEntity[]) => void;
  let broken: RegisteredSearchSource;

  const createdUsers: string[] = [];
  const createdTenants: string[] = [];

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

  const makeUser = async (tenantId: string, firstName: string) => {
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: `p-s-${Math.random().toString(36).slice(2)}-${runId}@example.com`,
        passwordHash: 'not-a-real-hash',
        firstName,
        lastName: 'آزمون',
      },
    });
    createdUsers.push(user.id);
    return user.id;
  };

  const search = (q: string, userId?: string, extra: Record<string, string | number> = {}) => {
    const params = new URLSearchParams({ q });
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    const req = request(app.getHttpServer()).get(`/search?${params.toString()}`);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const descriptor = (over: Partial<SearchSourceDescriptor> = {}): SearchSourceDescriptor => ({
    key: KEYS.purchase,
    ownerModuleId: 'test',
    weightClass: 'PRIMARY',
    routeTemplate: '/admin/test/purchase-documents/:id',
    ...over,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SearchModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: SearchTestGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.length,
          }),
      })
    );
    await app.init();

    prisma = app.get(PrismaService);
    port = app.get<SearchSourcePort>(SEARCH_SOURCE_PORT);

    // Idempotence against the live database: a previous failed run must not leave
    // rows this run would then find. Deleting by sourceKey is exact — platform rows
    // carry '' and can never be touched by this cleanup.
    await prisma.searchDocument.deleteMany({
      where: { sourceKey: { in: Object.values(KEYS) } },
    });

    const tenantA = await prisma.tenant.create({ data: { code: `ps-a-${runId}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `ps-b-${runId}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    createdTenants.push(tenantAId, tenantBId);

    userAId = await makeUser(tenantAId, 'الف');
    userBId = await makeUser(tenantBId, 'ب');

    // Registration is composition: it happens once, up front, through the REAL port.
    const purchaseSource = adapterFor();
    purchase = port.register(purchaseSource.adapter);
    seedPurchase = purchaseSource.seed;

    const primarySource = adapterFor({
      key: KEYS.primary,
      weightClass: 'PRIMARY',
      routeTemplate: '/admin/test/primary/:id',
    });
    primary = port.register(primarySource.adapter);
    seedPrimary = primarySource.seed;

    const supportingSource = adapterFor({
      key: KEYS.supporting,
      weightClass: 'SUPPORTING',
      routeTemplate: '/admin/test/supporting/:id',
    });
    supporting = port.register(supportingSource.adapter);
    seedSupporting = supportingSource.seed;

    const brokenAdapter: SearchSourceAdapter = {
      descriptor: descriptor({ key: KEYS.broken, routeTemplate: '/admin/test/broken/:id' }),
      authorize: async () => {
        throw new Error('test source is unavailable');
      },
    };
    broken = port.register(brokenAdapter);
  });

  afterAll(async () => {
    // Rows first, then identities, then tenants — and only this suite's own rows:
    // the delete is by sourceKey, so no platform projection can be affected.
    await prisma.searchDocument.deleteMany({
      where: { sourceKey: { in: Object.values(KEYS) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenants } } });
    await app.close();
  });

  /**
   * A fresh fake-backed adapter per scenario, so authority is seeded per test and
   * one scenario's refusals cannot leak into another's expectations. The adapter is
   * registered with the REAL port: projections go to the real `SearchDocument`,
   * only the source's own authorization truth is in memory.
   */
  const adapterFor = (over: Partial<SearchSourceDescriptor> = {}) => {
    const fake = createFakeSearchSourcePort();
    const adapter = fake.adapter(descriptor(over));
    return { adapter, seed: adapter.seed.bind(adapter) };
  };

  const projection = (entityId: string, tenantId: string | null, extra: string[] = []) => ({
    entityId,
    tenantId,
    searchContent: [TOKEN, ...extra],
    sourceUpdatedAt: new Date(),
  });

  /** One search hit as this suite reads it: the score is numeric, the rest is per-source. */
  interface SearchResultRow {
    score: number;
    [field: string]: unknown;
  }

  const resultsFor = (body: { results?: SearchResultRow[] }) =>
    (body.results ?? []) as SearchResultRow[];
  const keyed = (body: { results?: SearchResultRow[] }, key: string) =>
    resultsFor(body).filter((row) => row.sourceKey === key);

  describe('registration rules at the REAL port', () => {
    it('refuses a duplicate key', () => {
      expect(() =>
        port.register({ descriptor: descriptor(), authorize: async () => ({ entries: [] }) })
      ).toThrow(SearchSourceRegistrationError);

      try {
        port.register({ descriptor: descriptor(), authorize: async () => ({ entries: [] }) });
      } catch (error) {
        expect((error as SearchSourceRegistrationError).code).toBe('SOURCE_DUPLICATE');
      }
    });

    it('refuses a malformed descriptor', () => {
      try {
        port.register({
          descriptor: { ...descriptor(), key: 'Not A Key' },
          authorize: async () => ({ entries: [] }),
        });
      } catch (error) {
        expect((error as SearchSourceRegistrationError).code).toBe('SOURCE_KEY_INVALID');
      }
    });
  });

  describe('P-S-A — a registered source’s projection appears in GET /search', () => {
    it('returns the row with its title, snippet, highlights, route and score', async () => {
      seedPurchase([
        {
          entityId: 'doc-a',
          tenantId: tenantAId,
          title: `سند خرید ${TOKEN}`,
          snippetFields: [`متن کامل سند ${TOKEN}`, 'توضیح تکمیلی'],
        },
        {
          entityId: 'doc-b',
          tenantId: tenantAId,
          title: `سند دوم ${TOKEN}`,
          snippetFields: [`جزئیات ${TOKEN}`],
        },
      ]);

      const projected = await purchase.project([
        projection('doc-a', tenantAId),
        projection('doc-b', tenantAId),
      ]);
      expect(projected).toEqual({ status: 'indexed', indexed: 2, embedded: 0, skipped: [] });

      const res = await search(TOKEN, userAId);
      expect(res.status).toBe(200);

      const mine = keyed(res.body, KEYS.purchase);
      expect(mine.map((row) => row.sourceId).sort()).toEqual(['doc-a', 'doc-b']);

      const docA = mine.find((row) => row.sourceId === 'doc-a');
      expect(docA).toBeDefined();
      if (!docA) return;
      expect(docA.sourceType).toBe('EXTERNAL');
      expect(docA.sourceKey).toBe(KEYS.purchase);
      expect(docA.title).toBe(`سند خرید ${TOKEN}`);
      expect(docA.snippet).toContain(TOKEN);
      const docAHighlights = docA.highlights as { start: number; end: number }[];
      expect(docAHighlights.length).toBeGreaterThan(0);
      expect(docAHighlights[0].end).toBeGreaterThan(docAHighlights[0].start);
      expect(docA.navigation).toEqual({ href: '/admin/test/purchase-documents/doc-a' });
      expect(docA.score).toBeGreaterThan(0);
      expect(docA.score).toBeLessThanOrEqual(1);
      // This environment has no embedding credential: both arms report honestly.
      expect(docA.matchedBy).toEqual({ lexical: true, semantic: false });
      expect(res.body.mode).toBe('LEXICAL');
      expect(res.body.degraded).toBe(true);

      // The projection really is a row in the platform's own index.
      const rows = await prisma.searchDocument.count({
        where: { sourceKey: KEYS.purchase, sourceId: 'doc-a', sourceType: 'EXTERNAL' },
      });
      expect(rows).toBe(1);
    });
  });

  describe('P-S-B — the source’s own authorization decides', () => {
    it('drops a row the source refuses, keeping the source’s other rows', async () => {
      // Projected but NEVER seeded: the adapter will not authorize it.
      await purchase.project([projection('doc-hidden', tenantAId)]);

      const res = await search(TOKEN, userAId);
      const mine = keyed(res.body, KEYS.purchase);

      expect(mine.some((row) => row.sourceId === 'doc-hidden')).toBe(false);
      expect(mine.some((row) => row.sourceId === 'doc-a')).toBe(true);

      // Facets count AUTHORIZED rows — never the index size.
      expect(res.body.sourceCounts.EXTERNAL).toBe(mine.length);
    });
  });

  describe('P-S-C — tenant isolation', () => {
    it('never returns another tenant’s external rows, and the row IS in the index', async () => {
      seedPurchase([
        {
          entityId: 'doc-b1',
          tenantId: tenantBId,
          title: `سند تنانت ب ${TOKEN}`,
          snippetFields: [`متن ب ${TOKEN}`],
        },
      ]);
      await purchase.project([projection('doc-b1', tenantBId)]);

      const count = await prisma.searchDocument.count({
        where: { sourceKey: KEYS.purchase, sourceId: 'doc-b1' },
      });
      expect(count).toBe(1);

      const asA = await search(TOKEN, userAId);
      expect(keyed(asA.body, KEYS.purchase).some((row) => row.sourceId === 'doc-b1')).toBe(false);

      const asB = await search(TOKEN, userBId);
      const seenByB = keyed(asB.body, KEYS.purchase).map((row) => row.sourceId);
      expect(seenByB).toEqual(['doc-b1']);
      expect(
        (asB.body.results as SearchResultRow[]).map((row) => row.sourceId)
      ).toEqual(['doc-b1']);
    });
  });

  describe('P-S-D — pagination over external results', () => {
    it('partitions pages with no duplicate and no lost result', async () => {
      seedPurchase(
        ['doc-p1', 'doc-p2', 'doc-p3'].map((entityId) => ({
          entityId,
          tenantId: tenantAId,
          title: `سند صفحه ${entityId} ${TOKEN}`,
          snippetFields: [`متن ${TOKEN}`],
        }))
      );
      await purchase.project([
        projection('doc-p1', tenantAId),
        projection('doc-p2', tenantAId),
        projection('doc-p3', tenantAId),
      ]);

      const pages = [];
      for (const offset of [0, 2, 4, 6]) {
        pages.push(await search(TOKEN, userAId, { limit: 2, offset }));
      }

      const seen = pages.flatMap((page) =>
        keyed(page.body, KEYS.purchase).map((row) => row.sourceId)
      );

      // Every tenant-A purchase row appears EXACTLY once across the pages. (The
      // secret row from P-S-H does not exist yet; it is rejected when it is tried.)
      expect(seen.sort()).toEqual(['doc-a', 'doc-b', 'doc-p1', 'doc-p2', 'doc-p3']);
      expect(new Set(seen).size).toBe(seen.length);

      expect(pages[0].body.hasMore).toBe(true);
      expect(keyed(pages[3].body, KEYS.purchase)).toEqual([]);
    });
  });

  describe('P-S-E — source weight classes', () => {
    it('ranks a PRIMARY source above a SUPPORTING one over identical text, at the existing ratio', async () => {
      seedPrimary([
        {
          entityId: 'w-primary',
          tenantId: tenantAId,
          title: `وزن اصلی ${TOKEN}`,
          snippetFields: [`متن ${TOKEN}`],
        },
      ]);
      seedSupporting([
        {
          entityId: 'w-supporting',
          tenantId: tenantAId,
          title: `وزن کمکی ${TOKEN}`,
          snippetFields: [`متن ${TOKEN}`],
        },
      ]);

      // IDENTICAL searchable content: identical normalized text, hence identical
      // lexical rank. The ONLY thing that can separate them is the weight class.
      await primary.project([projection('w-primary', tenantAId)]);
      await supporting.project([projection('w-supporting', tenantAId)]);

      const res = await search(TOKEN, userAId);
      const primaryRow = keyed(res.body, KEYS.primary)[0];
      const supportingRow = keyed(res.body, KEYS.supporting)[0];

      expect(primaryRow).toBeDefined();
      expect(supportingRow).toBeDefined();

      // SUPPORTING = OPTIONAL_SOURCE_WEIGHT (0.6) × the same base; no new number
      // exists anywhere in this contract.
      expect(supportingRow.score).toBeCloseTo(primaryRow.score * 0.6, 5);
      expect(res.body.results.indexOf(primaryRow)).toBeLessThan(
        res.body.results.indexOf(supportingRow)
      );
    });
  });

  describe('P-S-O — removal', () => {
    it('removes a projection idempotently: the row stops being findable', async () => {
      expect(await purchase.remove(['doc-p3'])).toEqual({ status: 'removed', removed: 1 });

      const res = await search(TOKEN, userAId);
      expect(keyed(res.body, KEYS.purchase).some((row) => row.sourceId === 'doc-p3')).toBe(false);

      // A retry is a no-op, not an error.
      expect(await purchase.remove(['doc-p3'])).toEqual({ status: 'removed', removed: 0 });
    });
  });

  describe('P-S-F — a malformed projection is refused whole, and nothing is written', () => {
    it('rejects the batch and leaves no row behind', async () => {
      const marker = `badc${runId}`;
      const rejected = await purchase.project([
        { entityId: 'doc-ok', tenantId: tenantAId, searchContent: [marker], sourceUpdatedAt: new Date() },
        { entityId: 'bad id!', tenantId: tenantAId, searchContent: [marker], sourceUpdatedAt: new Date() },
      ]);

      expect(rejected).toEqual({ status: 'rejected', code: 'PROJECTION_ENTITY_ID_INVALID' });

      // Not even the VALID record of the batch was written.
      const rows = await prisma.searchDocument.count({
        where: { sourceKey: KEYS.purchase, sourceId: 'doc-ok' },
      });
      expect(rows).toBe(0);

      const res = await search(marker, userAId);
      expect(res.body.results).toEqual([]);
    });
  });

  describe('P-S-G — an injected route is refused at registration', () => {
    it('refuses protocol, protocol-relative, query and traversal routes', () => {
      const routes = [
        'https://evil.example/x',
        '//evil.example/x',
        '/admin/../etc/passwd',
        '/admin/x?q=1',
      ];

      routes.forEach((routeTemplate, index) => {
        let code: string | null = null;
        try {
          port.register({
            descriptor: descriptor({ key: `test.invalid-route-${index}`, routeTemplate }),
            authorize: async () => ({ entries: [] }),
          });
        } catch (error) {
          code = (error as SearchSourceRegistrationError).code;
        }
        expect(code).toBe('SOURCE_ROUTE_TEMPLATE_INVALID');
      });
    });
  });

  describe('P-S-H — a projection carrying an unknown/sensitive field is refused', () => {
    it('rejects the record and never indexes its content', async () => {
      const marker = `scrt${runId}`;
      const rejected = await purchase.project([
        {
          ...projection('doc-secret', tenantAId, [marker]),
          credential: 'must-never-be-indexed',
        } as never,
      ]);

      expect(rejected).toEqual({ status: 'rejected', code: 'PROJECTION_SHAPE_INVALID' });

      const rows = await prisma.searchDocument.count({ where: { sourceId: 'doc-secret' } });
      expect(rows).toBe(0);

      const res = await search(marker, userAId);
      expect(res.body.results).toEqual([]);
    });
  });

  describe('P-S-J — a source that fails contributes nothing, and nothing else breaks', () => {
    it('returns 200 without that source’s rows, while its row IS in the index', async () => {
      const marker = `brk${runId}`;
      await broken.project([
        {
          entityId: 'broken-1',
          tenantId: tenantAId,
          searchContent: [marker, TOKEN],
          sourceUpdatedAt: new Date(),
        },
      ]);

      // The projection landed (the WRITE path never consults the adapter)…
      const rows = await prisma.searchDocument.count({
        where: { sourceKey: KEYS.broken, sourceId: 'broken-1' },
      });
      expect(rows).toBe(1);

      // …and it is dropped at AUTHORIZATION, not at retrieval.
      const res = await search(marker, userAId);
      expect(res.status).toBe(200);
      expect(keyed(res.body, KEYS.broken)).toEqual([]);

      // The same request still serves the healthy source.
      const healthy = await search(TOKEN, userAId);
      expect(keyed(healthy.body, KEYS.purchase).length).toBeGreaterThan(0);
    });
  });

  describe('security — the external result shape', () => {
    it('carries the source key and nothing from the index or another tenant', async () => {
      const res = await search(TOKEN, userAId);
      const serialized = JSON.stringify(res.body);

      for (const forbidden of [
        'tenantId',
        'userId',
        'ownerId',
        'passwordHash',
        'tokenVersion',
        'searchText',
        'searchVector',
        'embedding',
        'embeddingModel',
        'sourceUpdatedAt',
      ]) {
        expect(serialized).not.toContain(`"${forbidden}"`);
      }

      for (const row of res.body.results) {
        expect(row.sourceType).toBe('EXTERNAL');
        expect(typeof row.sourceKey).toBe('string');
        expect(Object.keys(row).sort()).toEqual(
          [
            'highlights',
            'matchedBy',
            'navigation',
            'score',
            'snippet',
            'sourceId',
            'sourceKey',
            'sourceType',
            'timestamp',
            'title',
          ].sort()
        );
      }
    });
  });
});

