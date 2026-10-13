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
import { BomHeaderController } from './bom.controller';
import { BomHeaderService } from './bom.service';

/**
 * Phase PRODUCTION-BOM-HEADER: the boundary statements on the BOM Header routes.
 *
 * WHAT IS CHECKED HERE, and deliberately nothing else — the orchestration lives in
 * `bom.service.spec.ts` and is not re-asserted through the controller:
 *
 *  1. NO ROUTE IS UNGATED. `RolesGuard` is a global APP_GUARD, so it is not exercised in a
 *     unit test; what CAN break silently is a route added without `@Roles(...)`, which
 *     would then be reachable by any authenticated caller. That regression is what the
 *     reflection checks below catch.
 *  2. EACH REMIT GETS ITS OWN PERMISSION. `manage` authorises create/edit/submit, and
 *     `approve` authorises the three decision acts — a decision route gated on `manage`
 *     would let an author approve their own BOM.
 *  3. THE REQUIREMENT IS DECLARED ONCE, ON THE CLASS. The module id and the feature pair
 *     come from `production.constants.ts`, never from a literal, so they cannot drift from
 *     the Core provisioning migration's SQL.
 *  4. THE CONTROLLER PASSES AN ACTOR, NOT A REQUEST. Every handler resolves the actor
 *     itself, which is why no service method can be reached with a client-supplied tenant.
 */

describe('BomHeaderController', () => {
  let controller: BomHeaderController;
  let boms: Record<string, jest.Mock>;

  beforeEach(async () => {
    boms = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      getOne: jest.fn().mockResolvedValue({}),
      getTimeline: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      submit: jest.fn().mockResolvedValue({}),
      decide: jest.fn().mockResolvedValue({}),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BomHeaderController],
      providers: [{ provide: BomHeaderService, useValue: boms }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ModuleEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(BomHeaderController);
  });

  const proto = BomHeaderController.prototype as unknown as Record<string, object>;

  /** Every route handler on the controller, discovered rather than hard-coded. */
  const handlers = (): string[] =>
    Object.getOwnPropertyNames(BomHeaderController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  describe('permission gates', () => {
    it('leaves NO route ungated', () => {
      const discovered = handlers();
      // Sanity-check the discovery itself: if the reflection helper silently returned an
      // empty list, every assertion below would vacuously pass.
      expect(discovered.length).toBeGreaterThanOrEqual(6);

      const ungated = discovered.filter((name) => {
        const roles = rolesOf(name);
        return !Array.isArray(roles) || roles.length === 0;
      });
      expect(ungated).toEqual([]);
    });

    it('gates every route on exactly one permission', () => {
      // One permission per route, because `RolesGuard` uses `.some(...)`: a second entry
      // can only WIDEN a route, never narrow it.
      for (const name of handlers()) {
        expect(rolesOf(name)).toHaveLength(1);
      }
    });

    it('splits AUTHORING from DECIDING exactly as the remits split', () => {
      // The reads — and the timeline is a READ, so it belongs to the read remit. Giving
      // it `manage` or `approve` would make a holder of a write permission able to read
      // the trail while a read-only holder could not, which is the remit split backwards.
      for (const name of ['list', 'getOne', 'getTimeline']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.PRODUCTION_BOM_READ],
        });
      }
      // The authorship remit: raise a BOM, edit it while draft, route it.
      for (const name of ['create', 'update', 'submit']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.PRODUCTION_BOM_MANAGE],
        });
      }
      // The deciding remit — deliberately NOT `manage`: an author must not be able to
      // reach a decision route through the permission they already hold.
      for (const name of ['approve', 'reject', 'requestCorrection']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.PRODUCTION_BOM_APPROVE],
        });
      }
    });

    it('draws every gate from the Permissions constants rather than a literal', () => {
      // A hand-typed `'production.bom.aprove'` would still be metadata, still look gated,
      // and match no role — failing closed but invisibly, as a 403 nobody can explain.
      const known = new Set<string>(Object.values(Permissions));
      for (const name of handlers()) {
        expect(known).toContain(rolesOf(name)![0]);
      }
    });
  });

  describe('entitlement declaration', () => {
    it('declares the module and the feature once, on the class, from the constants', () => {
      expect(Reflect.getMetadata(MODULE_REQUIREMENT_KEY, BomHeaderController)).toBe(
        PRODUCTION_MODULE_ID
      );
      expect(Reflect.getMetadata(FEATURE_REQUIREMENT_KEY, BomHeaderController)).toEqual({
        moduleId: PRODUCTION_MODULE_ID,
        featureId: PRODUCTION_FEATURE.BOM,
      });
    });

    it('declares no tenant scope of its own, which is the platform guard\'s job', () => {
      // Production DECLARES the requirement; the platform DECIDES it. A second mechanism
      // here would be a second answer to the same question.
      const source = readFileSync(join(__dirname, 'bom.controller.ts'), 'utf8');
      expect(source).not.toMatch(/tenantIds|tenantScope|RESTRICTED_MEMBERS/);
      expect(source).not.toMatch(/implements CanActivate/);
    });
  });

  describe('the actor is resolved, never trusted', () => {
    /**
     * Enters a TENANT context in the test's own async frame.
     *
     * `RequestContextService.set` uses `AsyncLocalStorage.enterWith`, which is scoped to
     * the current execution resource — the `beforeEach` frame belongs to jest's runner,
     * not to this `it`, so a store entered there is invisible here. That is the same
     * reason `production-actor.spec.ts` re-enters inside each case, and it is worth
     * stating rather than working around silently: the mechanism under test is a
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

    it('passes the resolved actor to the service on every route', async () => {
      enterTenant();
      const req = { ip: '10.0.0.7', headers: {} } as never;

      await controller.list(req, {} as never);
      await controller.getOne(req, BOM_ID as never);
      await controller.getTimeline(req, BOM_ID as never, {} as never);
      await controller.create(req, {} as never);
      await controller.update(req, BOM_ID as never, {} as never);
      await controller.submit(req, BOM_ID as never);
      await controller.approve(req, BOM_ID as never, { opinion: 'APPROVED' } as never);
      await controller.reject(req, BOM_ID as never, { opinion: 'REJECTED' } as never);
      await controller.requestCorrection(req, BOM_ID as never, {
        opinion: 'NEEDS_CORRECTION',
      } as never);

      // The three decision routes share ONE service method, and the other six routes map
      // one-to-one — that is the whole shape of the surface.
      expect(boms.decide).toHaveBeenCalledTimes(3);
      for (const name of ['list', 'getOne', 'getTimeline', 'create', 'update', 'submit']) {
        expect({ name, calls: boms[name].mock.calls.length }).toEqual({ name, calls: 1 });
      }
      // The actor is the FIRST argument everywhere, and its tenant is the RESOLVED one —
      // no route could have supplied another. The timeline is included deliberately: it
      // is the route whose SCOPE (`tenantId` on the audit query) depends entirely on that
      // actor, so a client-supplied tenant there would read another tenant's trail.
      for (const name of [
        'list',
        'getOne',
        'getTimeline',
        'create',
        'update',
        'submit',
        'decide',
      ]) {
        expect(boms[name].mock.calls[0][0]).toMatchObject({
          tenantId: 'tenant-a',
          userId: 'user-1',
        });
      }
    });

    it('maps each decision route onto its own opinion, and none onto another', async () => {
      enterTenant();
      const req = { ip: '10.0.0.7', headers: {} } as never;

      await controller.approve(req, BOM_ID as never, { opinion: 'APPROVED' } as never);
      await controller.reject(req, BOM_ID as never, { opinion: 'REJECTED' } as never);
      await controller.requestCorrection(req, BOM_ID as never, {
        opinion: 'NEEDS_CORRECTION',
      } as never);

      expect(boms.decide.mock.calls.map((call) => call[2])).toEqual([
        'APPROVED',
        'REJECTED',
        'NEEDS_CORRECTION',
      ]);
      // The expected outcome is a fixed argument of the call, not a value read off the
      // body — which is what stops the reject endpoint producing an APPROVED row.
      expect(boms.decide.mock.calls[0][3]).toEqual({ opinion: 'APPROVED' });
    });
  });

  describe('the route surface', () => {
    it('parses a BOM id as a UUID v4 on every route that takes one', () => {
      // The OPPOSITE of the rule for a platform user id. A BOM's own id is a UUID v4, so a
      // malformed one is a 400 at the edge rather than a database round-trip.
      const source = readFileSync(join(__dirname, 'bom.controller.ts'), 'utf8');
      const uuidPipes = source.match(/new ParseUUIDPipe\(\{ version: '4' \}\)/g) ?? [];
      // SEVEN routes take an id: GET/PATCH the header, the timeline read, and the four
      // transitions. The timeline counts because `:id` on it is the same aggregate id —
      // parsing it as a UUID v4 at the edge is what makes a malformed id a 400 rather
      // than a database round-trip, exactly as on `getOne`.
      expect(uuidPipes).toHaveLength(7);
    });

    it('exposes the four transitions as four POST routes and writes no status field', () => {
      const source = readFileSync(join(__dirname, 'bom.controller.ts'), 'utf8');
      for (const path of ['submit', 'approve', 'reject', 'request-correction']) {
        expect(source).toContain(`Post(':id/${path}')`);
      }
      // The lifecycle is walked by the routes that own each transition; nothing accepts a
      // status or a decision column from a caller.
      expect(source).not.toMatch(/status\?:\s*string|opinion:\s*BAD_REQUEST/);
      expect(source).toContain('@Controller(\'production/boms\')');
    });

    it('binds the timeline to one GET route whose SCOPE is never a request field', () => {
      const source = readFileSync(join(__dirname, 'bom.controller.ts'), 'utf8');
      // The path is a sibling of `:id`, declared once.
      expect(source).toContain("@Get(':id/timeline')");
      expect(source.match(/@Get\(':id\/timeline'\)/g)).toHaveLength(1);

      // The three scope inputs are bound SERVER-SIDE and never taken from the request:
      // the tenant from the actor, the resource from the closed constant, the id from the
      // path. A handler that read any of them off `req.query` would be a cross-tenant
      // read with a perfectly valid-looking signature.
      const handler = source.slice(source.indexOf('async getTimeline'));
      expect(handler).toContain('resolveProductionActor(req)');
      expect(handler).toContain('this.boms.getTimeline(');
      expect(handler).not.toMatch(/query\.(resource|resourceId|tenantId|action)\b/);
    });
  });
});
