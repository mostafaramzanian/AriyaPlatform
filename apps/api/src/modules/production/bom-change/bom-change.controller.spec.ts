import { readFileSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import {
  FEATURE_REQUIREMENT_KEY,
  MODULE_REQUIREMENT_KEY,
} from '../../../platform/entitlement/entitlement.contract';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import { PRODUCTION_FEATURE, PRODUCTION_MODULE_ID } from '../production.constants';
import { RequestContextService } from '../../../common/request-context.service';
import { BomChangeRequestController } from './bom-change.controller';
import { BomChangeRequestService } from './bom-change.service';

/**
 * Phase PRODUCTION-BOM-CHANGE: the boundary statements on the change-request routes.
 *
 * WHAT IS CHECKED HERE, and deliberately nothing else — the orchestration lives in
 * `bom-change.service.spec.ts` and is not re-asserted through the controller:
 *
 *  1. NO ROUTE IS UNGATED. `RolesGuard` is a global APP_GUARD, so it is not exercised in a
 *     unit test; what CAN break silently is a route added without `@Roles(...)`, which would
 *     then be reachable by any authenticated caller.
 *  2. THE SLICE REUSES THE HEADER'S THREE PERMISSIONS. No `production.bom.change.*` string
 *     is invented: the Core seed migration provisioned exactly three Production
 *     permissions, and a fourth would be a permission nobody holds — a guaranteed 403,
 *     including for SUPER_ADMIN.
 *  3. THE REQUIREMENT IS DECLARED ONCE, ON THE CLASS, from `production.constants.ts`, and
 *     the FEATURE is `bom` — the same feature the BOM itself declares.
 *  4. THE TABLE OF ROUTES IS EXACTLY THE CONTRACT — twelve routes, each with its verb, its
 *     path and its permission. This is what stops "the brief asked for `approve`, the code
 *     shipped `decision`" from being invisible.
 *  5. THE CONTROLLER PASSES AN ACTOR, NOT A REQUEST, and BOTH path params are parsed as
 *     UUID v4 — an opaque id here would be the mistake that later refuses a legitimate
 *     legacy value, while an un-parsed one costs a database round-trip.
 */

describe('BomChangeRequestController', () => {
  let controller: BomChangeRequestController;
  let requests: Record<string, jest.Mock>;

  beforeEach(async () => {
    requests = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      getOne: jest.fn().mockResolvedValue({}),
      getTimeline: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      addItem: jest.fn().mockResolvedValue({}),
      updateItem: jest.fn().mockResolvedValue({}),
      deleteItem: jest.fn().mockResolvedValue({ id: 'x' }),
      submit: jest.fn().mockResolvedValue({}),
      decide: jest.fn().mockResolvedValue({}),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BomChangeRequestController],
      providers: [{ provide: BomChangeRequestService, useValue: requests }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ModuleEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(BomChangeRequestController);
  });

  const proto = BomChangeRequestController.prototype as unknown as Record<string, object>;

  /** Every route handler on the controller, discovered rather than hard-coded. */
  const handlers = (): string[] =>
    Object.getOwnPropertyNames(BomChangeRequestController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);
  const methodOf = (handler: string): number =>
    Reflect.getMetadata(METHOD_METADATA, proto[handler]) as number;
  const pathOf = (handler: string): string =>
    (Reflect.getMetadata(PATH_METADATA, proto[handler]) as string) ?? '';

  describe('permission gates', () => {
    it('leaves NO route ungated, and gives each exactly one role', () => {
      const discovered = handlers();
      // Sanity-check the discovery itself: an empty list would pass every assertion below.
      expect(discovered.length).toBe(12);

      for (const name of discovered) {
        expect({ name, roles: rolesOf(name) }).toEqual({ name, roles: expect.any(Array) });
        expect({ name, count: rolesOf(name)?.length }).toEqual({ name, count: 1 });
      }
    });

    it('uses EXACTLY the header\u2019s three permission strings, and no fourth', () => {
      const used = handlers().map((name) => rolesOf(name)![0]);

      // Literal strings, not the constants: a rename in `permissions.ts` has to be noticed
      // HERE rather than by a 403 in an environment nobody rebuilt. Three reads (list,
      // detail, timeline), six manages (create, header patch, three detail mutations,
      // submit), three approves (the decisions).
      expect([
        used.filter((role) => role === 'production.bom.read').length,
        used.filter((role) => role === 'production.bom.manage').length,
        used.filter((role) => role === 'production.bom.approve').length,
      ]).toEqual([3, 6, 3]);
      expect(new Set(used).size).toBe(3);
      // And they ARE the constants, so the two cannot drift apart silently.
      expect(new Set(used)).toEqual(
        new Set([
          Permissions.PRODUCTION_BOM_READ,
          Permissions.PRODUCTION_BOM_MANAGE,
          Permissions.PRODUCTION_BOM_APPROVE,
        ])
      );
    });

    it('draws every gate from the Permissions constants rather than a literal', () => {
      // A hand-typed `'production.bom.mange'` would still be metadata, still look gated, and
      // match no role — failing closed but invisibly, as a 403 nobody can explain.
      const known = new Set<string>(Object.values(Permissions));
      for (const name of handlers()) {
        expect(known).toContain(rolesOf(name)![0]);
      }
    });
  });

  describe('entitlement declaration', () => {
    it('declares the module and the SAME feature as the BOM, once, from the constants', () => {
      expect(Reflect.getMetadata(MODULE_REQUIREMENT_KEY, BomChangeRequestController)).toBe(
        PRODUCTION_MODULE_ID
      );
      expect(Reflect.getMetadata(FEATURE_REQUIREMENT_KEY, BomChangeRequestController)).toEqual({
        moduleId: PRODUCTION_MODULE_ID,
        featureId: PRODUCTION_FEATURE.BOM,
      });
      expect(PRODUCTION_FEATURE.BOM).toBe('bom');
    });

    it('declares no tenant scope and no guard of its own', () => {
      // Production DECLARES the requirement; the platform DECIDES it. A second mechanism
      // here would be a second answer to the same question.
      const source = readFileSync(join(__dirname, 'bom-change.controller.ts'), 'utf8');
      expect(source).not.toMatch(/tenantIds|tenantScope|RESTRICTED_MEMBERS/);
      expect(source).not.toMatch(/implements CanActivate/);
      expect(source).not.toMatch(/@Public\(/);
    });
  });


  describe('the route surface', () => {
    /**
     * verb, path and permission of every route, AS THE BRIEF STATES THEM.
     *
     * The order below is the order `handlers()` discovers, which follows declaration order in
     * the controller — so the comparison is a SET of tuples and a missing or renamed route
     * fails rather than silently moving.
     */
    const EXPECTED: Array<[string, number, string, string]> = [
      ['list', RequestMethod.GET, '', 'production.bom.read'],
      ['getOne', RequestMethod.GET, ':id', 'production.bom.read'],
      ['getTimeline', RequestMethod.GET, ':id/timeline', 'production.bom.read'],
      ['create', RequestMethod.POST, '', 'production.bom.manage'],
      ['update', RequestMethod.PATCH, ':id', 'production.bom.manage'],
      ['addItem', RequestMethod.POST, ':id/items', 'production.bom.manage'],
      ['updateItem', RequestMethod.PATCH, ':id/items/:itemId', 'production.bom.manage'],
      ['deleteItem', RequestMethod.DELETE, ':id/items/:itemId', 'production.bom.manage'],
      ['submit', RequestMethod.POST, ':id/submit', 'production.bom.manage'],
      ['approve', RequestMethod.POST, ':id/approve', 'production.bom.approve'],
      ['reject', RequestMethod.POST, ':id/reject', 'production.bom.approve'],
      ['requestCorrection', RequestMethod.POST, ':id/request-correction', 'production.bom.approve'],
    ];

    it('publishes exactly the contract\u2019s verbs, paths and permissions', () => {
      expect(EXPECTED).toHaveLength(12); // non-vacuity: the brief's own minimum, named.

      // Nest normalises a path-less route to `'/'`, so both sides are trimmed to their
      // SEGMENTS rather than the comparison depending on that default.
      const segments = (path: string) => path.replace(/^\/+|\/+$/g, '');
      const actual = handlers().map(
        (name) => [name, methodOf(name), segments(pathOf(name)), rolesOf(name)![0]] as const
      );
      const normalise = (rows: readonly (readonly unknown[])[]) =>
        rows.map((row) => row.join(' ')).sort();

      expect(normalise(actual)).toEqual(
        normalise(EXPECTED.map(([n, m, p, r]) => [n, m, segments(p), r] as const))
      );
    });

    it('owns `production/bom-change-requests` and claims none of the header\u2019s paths', () => {
      expect(Reflect.getMetadata(PATH_METADATA, BomChangeRequestController)).toBe(
        'production/bom-change-requests'
      );

      const source = readFileSync(join(__dirname, 'bom-change.controller.ts'), 'utf8');
      expect(source).toContain("@Controller('production/bom-change-requests')");
      expect(source).not.toContain("@Controller('production/boms')");
      expect(source).not.toContain("@Controller('production/boms/:bomId/items')");
      // The item SEARCH is deliberately NOT a route here: it is served by the EXISTING
      // `/production/boms/:bomId/items?search=`, which is already server-side, tenant-
      // scoped and gated by `production.bom.read`. Duplicating it would be a second place
      // for its filters to drift.
      expect(source).not.toMatch(/@Get\('[^']*search[^']*'\)/);
    });

    it('parses BOTH path params as UUID v4 and accepts no user-id parameter', () => {
      const source = readFileSync(join(__dirname, 'bom-change.controller.ts'), 'utf8');
      const uuidPipes = source.match(/new ParseUUIDPipe\(\{ version: '4' \}\)/g) ?? [];
      // `id` on the eight id-addressed routes (getOne, timeline, update, addItem, submit and
      // the three decisions), `itemId` on the two detail routes — twelve in total.
      expect(uuidPipes).toHaveLength(12);
      expect(source).toContain("@Param('id', new ParseUUIDPipe({ version: '4' }))");
      expect(source).toContain("@Param('itemId', new ParseUUIDPipe({ version: '4' }))");
      // A platform user id is OPAQUE and never a UUID, which is why the approver travels in
      // the BODY as a bounded string and never as a path parameter.
      expect(source).not.toMatch(/@Param\('[^']*[Uu]ser/);
    });

    it('accepts no tenant and no identity field on the wire', () => {
      const source = readFileSync(join(__dirname, 'bom-change.controller.ts'), 'utf8');
      expect(source).not.toMatch(/tenantId\s*[:=]/);
      expect(source).not.toMatch(/userId\s*[:=]/);
      expect(source).not.toContain('standardPartCode');
    });
  });


  describe('the actor is resolved, never trusted', () => {
    /**
     * `RequestContextService.set` uses `AsyncLocalStorage.enterWith`, which is scoped to the
     * current execution resource — the `beforeEach` frame belongs to jest's runner, not to
     * this `it`, so a store entered there is invisible here. The mechanism under test is a
     * per-request store, and this test is a request.
     */
    function enterTenant(): void {
      RequestContextService.set({
        tenantId: 'tenant-a',
        userId: 'user-1',
        requestId: 'req-1',
        correlationId: undefined as unknown as string,
        startTime: Date.now(),
      } as never);
    }

    const ID = '11111111-1111-4111-8111-111111111111';
    const DETAIL_ID = '22222222-2222-4222-8222-222222222222';

    it('passes the resolved actor to the service on every route', async () => {
      enterTenant();
      const req = { ip: '10.0.0.7', headers: {} } as never;

      await controller.list(req, {} as never);
      await controller.getOne(req, ID as never);
      await controller.getTimeline(req, ID as never, {} as never);
      await controller.create(req, {} as never);
      await controller.update(req, ID as never, {} as never);
      await controller.addItem(req, ID as never, {} as never);
      await controller.updateItem(req, ID as never, DETAIL_ID as never, {} as never);
      await controller.deleteItem(req, ID as never, DETAIL_ID as never);
      await controller.submit(req, ID as never);
      await controller.approve(req, ID as never, {} as never);
      await controller.reject(req, ID as never, {} as never);
      await controller.requestCorrection(req, ID as never, {} as never);

      for (const [name, calls] of [
        ['list', 1],
        ['getOne', 1],
        ['getTimeline', 1],
        ['create', 1],
        ['update', 1],
        ['addItem', 1],
        ['updateItem', 1],
        ['deleteItem', 1],
        ['submit', 1],
        // THREE decision routes share ONE service method: the path is what states which
        // opinion is being recorded, so one call per decision route is the correct count.
        ['decide', 3],
      ] as const) {
        expect({ name, calls: requests[name].mock.calls.length }).toEqual({ name, calls });
      }
      // The actor is the FIRST argument everywhere, and its tenant is the RESOLVED one — no
      // route could have supplied another, because no DTO carries a tenant.
      for (const name of ['list', 'getOne', 'create', 'submit']) {
        expect(requests[name].mock.calls[0][0]).toMatchObject({
          tenantId: 'tenant-a',
          userId: 'user-1',
        });
      }
    });

    it('routes each decision act to its OWN opinion, so the path cannot be rewritten', async () => {
      enterTenant();
      const req = { ip: '10.0.0.7', headers: {} } as never;

      await controller.approve(req, ID as never, {} as never);
      await controller.reject(req, ID as never, {} as never);
      await controller.requestCorrection(req, ID as never, {} as never);

      expect(requests.decide.mock.calls.map((call) => call[2])).toEqual([
        'APPROVED',
        'REJECTED',
        'NEEDS_CORRECTION',
      ]);
    });
  });
});

