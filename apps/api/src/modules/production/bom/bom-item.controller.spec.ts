import { readFileSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA } from '@nestjs/common/constants';
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
import { BomItemController } from './bom-item.controller';
import { BomItemService } from './bom-item.service';

/**
 * Phase PRODUCTION-BOM-ITEM: the boundary statements on the child routes.
 *
 * WHAT IS CHECKED HERE, and deliberately nothing else — the orchestration lives in
 * `bom-item.service.spec.ts` and is not re-asserted through the controller:
 *
 *  1. NO ROUTE IS UNGATED. `RolesGuard` is a global APP_GUARD, so it is not exercised in a
 *     unit test; what CAN break silently is a route added without `@Roles(...)`, which would
 *     then be reachable by any authenticated caller.
 *  2. THE CHILD REUSES THE HEADER'S TWO PERMISSIONS. No `production.bom.item.*` string is
 *     invented: the Core seed migration provisioned exactly three Production permissions,
 *     and a fourth would be a permission nobody holds — a guaranteed 403, including for
 *     SUPER_ADMIN.
 *  3. THE REQUIREMENT IS DECLARED ONCE, ON THE CLASS, from `production.constants.ts`.
 *  4. THE CONTROLLER PASSES AN ACTOR, NOT A REQUEST, and BOTH path params are parsed as
 *     UUID v4 — an opaque id here would be the mistake that later refuses a legitimate
 *     legacy value, while an un-parsed one costs a database round-trip.
 */

describe('BomItemController', () => {
  let controller: BomItemController;
  let items: Record<string, jest.Mock>;

  beforeEach(async () => {
    items = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      getOne: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BomItemController],
      providers: [{ provide: BomItemService, useValue: items }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ModuleEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(BomItemController);
  });

  const proto = BomItemController.prototype as unknown as Record<string, object>;

  /** Every route handler on the controller, discovered rather than hard-coded. */
  const handlers = (): string[] =>
    Object.getOwnPropertyNames(BomItemController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  describe('permission gates', () => {
    it('leaves NO route ungated', () => {
      const discovered = handlers();
      // Sanity-check the discovery itself: an empty list would pass every assertion below.
      expect(discovered.length).toBeGreaterThanOrEqual(5);

      const ungated = discovered.filter(
        (name) => !Array.isArray(rolesOf(name)) || rolesOf(name)!.length === 0
      );
      expect(ungated).toEqual([]);
    });

    it('gates every route on exactly one permission', () => {
      // One permission per route, because `RolesGuard` uses `.some(...)`: a second entry
      // can only WIDEN a route, never narrow it.
      for (const name of handlers()) {
        expect(rolesOf(name)).toHaveLength(1);
      }
    });

    it('splits the two reads from the three mutations, using the header\'s own remits', () => {
      for (const name of ['list', 'getOne']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.PRODUCTION_BOM_READ],
        });
      }
      for (const name of ['create', 'update', 'remove']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.PRODUCTION_BOM_MANAGE],
        });
      }
      // NO third permission is invented for items: the seed granted exactly these three.
      expect(
        handlers()
          .map((name) => rolesOf(name)![0])
          .sort()
      ).toEqual(
        [
          Permissions.PRODUCTION_BOM_MANAGE,
          Permissions.PRODUCTION_BOM_MANAGE,
          Permissions.PRODUCTION_BOM_MANAGE,
          Permissions.PRODUCTION_BOM_READ,
          Permissions.PRODUCTION_BOM_READ,
        ].sort()
      );
    });

    it('draws every gate from the Permissions constants rather than a literal', () => {
      // A hand-typed `'production.bom.mange'` would still be metadata, still look gated,
      // and match no role — failing closed but invisibly, as a 403 nobody can explain.
      const known = new Set<string>(Object.values(Permissions));
      for (const name of handlers()) {
        expect(known).toContain(rolesOf(name)![0]);
      }
    });
  });

  describe('entitlement declaration', () => {
    it('declares the module and the SAME feature as its header, once, from the constants', () => {
      expect(Reflect.getMetadata(MODULE_REQUIREMENT_KEY, BomItemController)).toBe(
        PRODUCTION_MODULE_ID
      );
      expect(Reflect.getMetadata(FEATURE_REQUIREMENT_KEY, BomItemController)).toEqual({
        moduleId: PRODUCTION_MODULE_ID,
        featureId: PRODUCTION_FEATURE.BOM,
      });
    });

    it('declares no tenant scope and no guard of its own', () => {
      // Production DECLARES the requirement; the platform DECIDES it. A second mechanism
      // here would be a second answer to the same question.
      const source = readFileSync(join(__dirname, 'bom-item.controller.ts'), 'utf8');
      expect(source).not.toMatch(/tenantIds|tenantScope|RESTRICTED_MEMBERS/);
      expect(source).not.toMatch(/implements CanActivate/);
      expect(source).not.toMatch(/@Public\(/);
    });
  });

  describe('the actor is resolved, never trusted', () => {
    /**
     * Enters a TENANT context in the test's own async frame.
     *
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

    const BOM_ID = '11111111-1111-4111-8111-111111111111';
    const ITEM_ID = '22222222-2222-4222-8222-222222222222';

    it('passes the resolved actor to the service on every route', async () => {
      enterTenant();
      const req = { ip: '10.0.0.7', headers: {} } as never;

      await controller.list(req, BOM_ID as never, {} as never);
      await controller.getOne(req, BOM_ID as never, ITEM_ID as never);
      await controller.create(req, BOM_ID as never, {} as never);
      await controller.update(req, BOM_ID as never, ITEM_ID as never, {} as never);
      await controller.remove(req, BOM_ID as never, ITEM_ID as never);

      for (const name of ['list', 'getOne', 'create', 'update', 'delete']) {
        expect({ name, calls: items[name].mock.calls.length }).toEqual({ name, calls: 1 });
        // The actor is the FIRST argument everywhere, and its tenant is the RESOLVED one —
        // no route could have supplied another, because no DTO carries a tenant.
        expect(items[name].mock.calls[0][0]).toMatchObject({
          tenantId: 'tenant-a',
          userId: 'user-1',
        });
      }
    });
  });

  describe('the route surface', () => {
    it('nests the child under the header\'s path so the two controllers cannot collide', () => {
      const source = readFileSync(join(__dirname, 'bom-item.controller.ts'), 'utf8');
      expect(source).toContain("@Controller('production/boms/:bomId/items')");
      // It never claims the parent's path — `bom.controller.ts` owns `/production/boms`.
      expect(source).not.toContain("@Controller('production/boms')");
    });

    it('parses BOTH path params as UUID v4', () => {
      // Owned row ids are UUID v4; a malformed one is a 400 at the edge rather than a
      // database round-trip. This is the OPPOSITE of the rule for a platform user id,
      // which is opaque and never a UUID.
      const source = readFileSync(join(__dirname, 'bom-item.controller.ts'), 'utf8');
      const uuidPipes = source.match(/new ParseUUIDPipe\(\{ version: '4' \}\)/g) ?? [];
      // `bomId` on all five routes, `itemId` on getOne/update/remove.
      expect(uuidPipes).toHaveLength(8);
      expect(source).toContain("@Param('bomId', new ParseUUIDPipe({ version: '4' }))");
      expect(source).toContain("@Param('itemId', new ParseUUIDPipe({ version: '4' }))");
    });

    it('accepts no deferred standard code and no identity field on the wire', () => {
      // The DTO's whitelist refuses them at the transport; the controller must not try to
      // accept them either, or a handler would have to decide what to do with the value.
      const source = readFileSync(join(__dirname, 'bom-item.controller.ts'), 'utf8');
      expect(source).not.toContain('standardPartCode');
      expect(source).not.toContain('CodeStandardDarSanat');
      expect(source).not.toMatch(/tenantId\s*[:=]/);
      expect(source).not.toMatch(/userId\s*[:=]/);
    });
  });
});
