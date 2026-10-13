import { Test } from '@nestjs/testing';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ObservabilityController } from './observability.controller';
import { ObservabilityReadService } from './observability-read.service';
import { ObservabilityHealthService } from './observability-health.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Permissions } from '../auth/rbac/constants/permissions';
import { RolePermissions } from '../auth/rbac/constants/roles';
import {
  LIFECYCLE_DOMAINS,
  LIFECYCLE_PHASES,
  LOG_LEVELS,
  LOG_MESSAGE_CODES,
  LOG_SOURCES,
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
} from './observability.contract';

/**
 * Phase 49M-2 §32: RBAC on the observability admin surface.
 *
 * WHAT IS CHECKED HERE, and deliberately nothing else — query semantics live in
 * `observability-read.service.spec.ts` and are not re-asserted through the controller:
 *
 *  1. NO ROUTE IS UNGATED. `RolesGuard` is global via APP_GUARD, so it is not exercised in a
 *     unit test; what CAN break silently is a route added or copied without `@Roles()`, which
 *     would be authenticated but not AUTHORIZED — every holder of a valid token could then read
 *     the audit trail. The handler list is DISCOVERED off the prototype, so a new route is
 *     covered the moment it is added rather than when someone remembers to extend this file.
 *  2. THE SECURITY ROUTE IS GATED ON `admin.security.read` INSTEAD OF, NOT IN ADDITION TO,
 *     `admin.observability.read`. `RolesGuard` resolves the list with `.some(...)`, so naming
 *     both would WIDEN the route to every observability reader — the opposite of the intent.
 *     The test asserts the narrower permission is alone on that route, and that the seeded
 *     audience really is narrower according to `RolePermissions`.
 *  3. THERE IS NO WRITE, DELETE OR EXPORT ROUTE. A POST that accepts log lines is a way to
 *     fill the database; a DELETE would let an administrator erase the evidence of their own
 *     actions, which makes the whole audit trail worthless. Both are asserted as absence.
 *  4. THE CONTROLLER FORWARDS THE DTO AND ADDS NO FILTER OF ITS OWN — in particular it never
 *     injects a tenant or an actor from the request into the query.
 */

describe('ObservabilityController', () => {
  let controller: ObservabilityController;
  let read: Record<string, jest.Mock>;
  let health: { check: jest.Mock; metrics: jest.Mock };

  beforeEach(async () => {
    read = {
      findApplicationLogs: jest.fn().mockResolvedValue({ items: [] }),
      findAuditEvents: jest.fn().mockResolvedValue({ items: [] }),
      findSecurityEvents: jest.fn().mockResolvedValue({ items: [] }),
      findLifecycleEvents: jest.fn().mockResolvedValue({ items: [] }),
      findRetentionRuns: jest.fn().mockResolvedValue([{ category: 'application_log' }]),
    };
    health = {
      check: jest.fn().mockResolvedValue({ status: 'ok' }),
      metrics: jest.fn().mockReturnValue([{ name: 'observability_queue_depth', value: 0 }]),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ObservabilityController],
      providers: [
        { provide: ObservabilityReadService, useValue: read },
        { provide: ObservabilityHealthService, useValue: health },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(ObservabilityController);
  });

  const proto = ObservabilityController.prototype as unknown as Record<string, object>;

  /** The controller as a plain method bag — the DTOs pass by identity, so structural is enough. */
  const loose = () =>
    controller as unknown as Record<string, (dto: Record<string, unknown>) => Promise<unknown>>;

  /** Every route handler on the controller, discovered rather than hard-coded. */
  const handlers = (): string[] =>
    Object.getOwnPropertyNames(ObservabilityController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name]),
    );

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Nothing is ungated
  // ───────────────────────────────────────────────────────────────────────────

  describe('permission gates', () => {
    it('leaves NO route ungated', () => {
      const discovered = handlers();

      // Sanity-check the discovery itself: if the reflection helper silently returned an empty
      // list, every assertion below would vacuously pass.
      expect(discovered.length).toBeGreaterThanOrEqual(8);

      const ungated = discovered.filter((name) => {
        const roles = rolesOf(name);
        return !Array.isArray(roles) || roles.length === 0;
      });
      expect(ungated).toEqual([]);
    });

    it('gates every route on exactly one permission', () => {
      // One permission per route, because `RolesGuard` uses `.some(...)`: a second entry can
      // only ever WIDEN a route, never narrow it, so a two-element list is a latent
      // over-grant rather than a stricter gate.
      for (const name of handlers()) {
        expect(rolesOf(name)).toHaveLength(1);
      }
    });

    it('gates the non-security routes on admin.observability.read', () => {
      for (const name of [
        'vocabulary',
        'healthCheck',
        'metrics',
        'logs',
        'auditEvents',
        'lifecycleEvents',
        'retentionRuns',
      ]) {
        expect(rolesOf(name)).toEqual([Permissions.ADMIN_OBSERVABILITY_READ]);
      }
    });

    it('draws every gate from the Permissions constants rather than a literal', () => {
      // A hand-typed `'admin.observabilty.read'` would still be metadata, still look gated,
      // and match no role — failing closed but invisibly, as a 403 nobody can explain.
      const known = new Set<string>(Object.values(Permissions));
      for (const name of handlers()) {
        expect(known).toContain(rolesOf(name)![0]);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. The security route has its OWN, NARROWER scope
  // ───────────────────────────────────────────────────────────────────────────

  describe('security-events gate', () => {
    it('requires admin.security.read and NOT admin.observability.read', () => {
      const roles = rolesOf('securityEvents');

      expect(roles).toEqual([Permissions.ADMIN_SECURITY_READ]);
      // The substitution IS the control: adding observability-read here would let
      // OPERATIONS_ADMIN enumerate failed logins and the IPs behind them.
      expect(roles).not.toContain(Permissions.ADMIN_OBSERVABILITY_READ);
    });

    it('is the only route with a different gate from the rest', () => {
      const distinct = new Set(handlers().map((name) => rolesOf(name)![0]));

      expect(distinct).toEqual(
        new Set([Permissions.ADMIN_OBSERVABILITY_READ, Permissions.ADMIN_SECURITY_READ]),
      );
    });

    it('resolves to a strictly narrower audience in RolePermissions', () => {
      const holders = (permission: string) =>
        Object.entries(RolePermissions)
          .filter(([, granted]) => (granted as readonly string[]).includes(permission))
          .map(([role]) => role)
          .sort();

      const observability = holders(Permissions.ADMIN_OBSERVABILITY_READ);
      const security = holders(Permissions.ADMIN_SECURITY_READ);

      // The gate only means something if the code-side audiences actually differ. These are
      // the same four/two role sets seeded by 20260905160000_seed_observability_permission_grants.
      expect(observability).toEqual(['ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN', 'SUPER_ADMIN']);
      expect(security).toEqual(['SECURITY_ADMIN', 'SUPER_ADMIN']);

      expect(security.length).toBeLessThan(observability.length);
      // Every security reader also reads observability, so the narrow route never becomes the
      // ONLY route a role can reach.
      for (const role of security) expect(observability).toContain(role);
      // And the two roles that must not see security events genuinely cannot.
      expect(security).not.toContain('ADMIN');
      expect(security).not.toContain('OPERATIONS_ADMIN');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. The surface is READ ONLY
  // ───────────────────────────────────────────────────────────────────────────

  describe('read-only surface', () => {
    it('exposes GET and nothing else — no write, delete or export route', () => {
      // An endpoint that ACCEPTS log lines is a way to fill the database; a DELETE would let an
      // administrator erase the evidence of their own actions, which makes the audit trail
      // worthless. Both properties are absences, so they can only be tested this way — by
      // enumerating what the controller actually declares.
      const methods = handlers().map((name) => Reflect.getMetadata(METHOD_METADATA, proto[name]));

      expect(methods).not.toHaveLength(0);
      for (const method of methods) expect(method).toBe(RequestMethod.GET);
    });

    it('declares literal paths only — nothing parameterised to shadow another route', () => {
      // Nest matches in declaration order; a `:id` route ahead of `vocabulary` would swallow it.
      const paths = handlers().map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]));

      expect(paths.sort()).toEqual([
        'audit-events',
        'health',
        'lifecycle-events',
        'logs',
        'metrics',
        'retention-runs',
        'security-events',
        'vocabulary',
      ]);
      for (const path of paths) expect(path).not.toContain(':');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Delegation adds no filter of its own
  // ───────────────────────────────────────────────────────────────────────────

  describe('delegation', () => {
    /**
     * The DTO reaches the service UNTOUCHED, and no second argument appears.
     *
     * This is the controller-side half of the per-tab isolation proven in
     * `observability-read.service.spec.ts`: if the controller injected a tenant, an actor or a
     * default filter of its own, the service's carefully scoped `where` would be built from
     * something the service's own tests never see.
     */
    const cases: Array<[string, string]> = [
      ['logs', 'findApplicationLogs'],
      ['auditEvents', 'findAuditEvents'],
      ['securityEvents', 'findSecurityEvents'],
      ['lifecycleEvents', 'findLifecycleEvents'],
    ];

    it.each(cases)('%s forwards the DTO to %s unchanged and alone', async (handler, method) => {
      const dto = { limit: 25, skip: 0 };

      await loose()[handler](dto);

      expect(read[method]).toHaveBeenCalledTimes(1);
      // `toBe`, not `toEqual`: proves the same object went through rather than a rebuilt copy
      // that could have gained or lost a predicate on the way.
      expect(read[method].mock.calls[0][0]).toBe(dto);
      expect(read[method].mock.calls[0]).toHaveLength(1);
    });

    it('never routes one tab to another tab\u2019s reader', async () => {
      await loose().securityEvents({});

      expect(read.findSecurityEvents).toHaveBeenCalledTimes(1);
      expect(read.findApplicationLogs).not.toHaveBeenCalled();
      expect(read.findAuditEvents).not.toHaveBeenCalled();
      expect(read.findLifecycleEvents).not.toHaveBeenCalled();
    });

    it('takes no query for retention runs and wraps the rows in { items }', async () => {
      const result = await controller.retentionRuns();

      expect(read.findRetentionRuns).toHaveBeenCalledTimes(1);
      expect(read.findRetentionRuns.mock.calls[0]).toHaveLength(0);
      expect(result).toEqual({ items: [{ category: 'application_log' }] });
    });

    it('serves the filter vocabulary from the contract, not a local copy', () => {
      // A client-side or controller-side copy is how a UI ends up offering a filter value the
      // backend stopped emitting; identity against the contract arrays makes that impossible.
      const vocabulary = controller.vocabulary();

      expect(vocabulary).toEqual({
        levels: LOG_LEVELS,
        sources: LOG_SOURCES,
        messageCodes: LOG_MESSAGE_CODES,
        securityEventTypes: SECURITY_EVENT_TYPES,
        securitySeverities: SECURITY_SEVERITIES,
        lifecycleDomains: LIFECYCLE_DOMAINS,
        lifecyclePhases: LIFECYCLE_PHASES,
      });
      // BUSINESS is deliberately absent from the lifecycle domains — asserted here so a stray
      // addition has to be a conscious edit to the contract and this expectation.
      expect(vocabulary.lifecycleDomains).toEqual(['INTEGRATION', 'MODULE', 'PROVISIONING']);
    });

    it('delegates health and metrics without reshaping the health service output', async () => {
      await expect(controller.healthCheck()).resolves.toEqual({ status: 'ok' });
      expect(controller.metrics()).toEqual({
        samples: [{ name: 'observability_queue_depth', value: 0 }],
      });
    });
  });
});
