import * as fs from 'fs';
import * as path from 'path';

/** `__dirname` is `<api>/src/platform/entitlement`, so the API root is three levels up. */
const API_DIR = path.resolve(__dirname, '..', '..', '..');
const src = path.join(API_DIR, 'src');
const read = (file: string) => fs.readFileSync(file, 'utf8');

const ENTITLEMENT = path.join(src, 'platform', 'entitlement');
const controllerPath = path.join(ENTITLEMENT, 'module-feature.controller.ts');
const servicePath = path.join(ENTITLEMENT, 'module-feature.service.ts');
const modulePath = path.join(ENTITLEMENT, 'platform-entitlement.module.ts');

/**
 * Phase 54-C (D14, §43.8/§43.10 gate 6): the ADMIN CONTROLLER GATE.
 *
 * WHAT IT REFUSES TO TAKE ON FAITH, and the failure each check would catch:
 *  * an `admin/modules/**` route anyone can call — a handler that lost, or never had, its `@Roles`
 *  * an unrecorded grant or revocation — a mutation that writes the table and not the trail
 *  * a route that lets a caller choose the tenancy of a request — the §25-rule-7 collapse that would
 *    turn "which tenant does this request run as?" into a body field
 *
 * It reads the two files AS TEXT, the technique the HR isolation specs already use for facts that live
 * across a boundary: importing the controller would drag Nest, Express and the whole platform into a
 * spec whose subject is the shape of the source.
 */

/**
 * The SIX FROZEN routes of §43.8, in order, with the permission each one must carry.
 *
 * The seventh entry is the Phase 54-C closure fix: a READ-ONLY per-tenant effective-state route. It is
 * listed here rather than left out of the walk so the gate keeps its meaning — every route in the file
 * is enumerated, ORDERED and permission-checked — while the frozen six keep their own count below. §43.8
 * requires the console to show each tenant's effective state (line-by-line: "what the platform will
 * decide for THIS tenant") and forbids the browser from deriving it; after D16 that derivation was
 * impossible to get right, because `RESTRICTED_MEMBERS` membership lives in a child table the browser
 * cannot read. One read under the EXISTING `admin.modules.read` code is the minimum the frozen spec
 * allows, and no new permission code, body field or tenancy argument comes with it.
 */
const FROZEN_ROUTES: { decorator: string; path: string; role: string; frozen: boolean }[] = [
  {
    decorator: "@Get(':moduleId/features')",
    path: 'GET admin/modules/:moduleId/features',
    role: 'ADMIN_MODULES_READ',
    frozen: true,
  },
  {
    decorator: "@Post(':moduleId/features')",
    path: 'POST admin/modules/:moduleId/features',
    role: 'ADMIN_MODULES_MANAGE',
    frozen: true,
  },
  {
    decorator: "@Patch(':moduleId/features/:featureId')",
    path: 'PATCH admin/modules/:moduleId/features/:featureId',
    role: 'ADMIN_MODULES_MANAGE',
    frozen: true,
  },
  {
    decorator: "@Get(':moduleId/features/:featureId/tenants')",
    path: 'GET admin/modules/:moduleId/features/:featureId/tenants',
    role: 'ADMIN_MODULES_READ',
    frozen: true,
  },
  {
    decorator: "@Get(':moduleId/features/:featureId/effective-state')",
    path: 'GET admin/modules/:moduleId/features/:featureId/effective-state',
    role: 'ADMIN_MODULES_READ',
    frozen: false,
  },
  {
    decorator: "@Post(':moduleId/features/:featureId/tenants')",
    path: 'POST admin/modules/:moduleId/features/:featureId/tenants',
    role: 'ADMIN_MODULES_MANAGE',
    frozen: true,
  },
  {
    decorator: "@Delete(':moduleId/features/:featureId/tenants/:tenantId')",
    path: 'DELETE admin/modules/:moduleId/features/:featureId/tenants/:tenantId',
    role: 'ADMIN_MODULES_MANAGE',
    frozen: true,
  },
];

/** The four mutating handlers, as they call the service: each must reach the audit boundary. */
const MUTATIONS = [
  'this.features.declare(',
  'this.features.update(',
  'this.features.grant(',
  'this.features.revoke(',
];

describe('Phase 54-C §43.8 — the feature-entitlement admin controller', () => {
  const controller = read(controllerPath);
  const service = read(servicePath);

  it('exposes every enumerated route and nothing beyond them: the six frozen, plus the sanctioned read', () => {
    const declarations = controller.match(/@(?:Get|Post|Patch|Delete)\([^)]*\)/g) ?? [];

    expect(declarations).toHaveLength(FROZEN_ROUTES.length);
    expect(declarations).toEqual(FROZEN_ROUTES.map((route) => route.decorator));

    // The gate's original claim, kept as its own assertion so a future addition cannot quietly
    // dilute it: SIX routes are the frozen surface, and exactly one more is the closure fix.
    expect(FROZEN_ROUTES.filter((route) => route.frozen)).toHaveLength(6);
    expect(FROZEN_ROUTES.filter((route) => !route.frozen)).toHaveLength(1);
  });

  it('adds no MUTATION beyond the frozen four — the extension is a read', () => {
    const frozenMutations = FROZEN_ROUTES.filter((route) => route.frozen).filter(
      (route) => !route.decorator.startsWith('@Get(')
    );
    const extension = FROZEN_ROUTES.filter((route) => !route.frozen);

    // A read-only extension cannot widen the admin plane's write surface: the frozen four writes are
    // still the only writes, and the closure fix is a `@Get`.
    expect(frozenMutations).toHaveLength(4);
    expect(extension.every((route) => route.decorator.startsWith('@Get('))).toBe(true);
    // And it must NOT introduce a second permission code for reads: the console already had read.
    expect(extension.every((route) => route.role === 'ADMIN_MODULES_READ')).toBe(true);
  });

  it('lets no route name the tenancy of its request — not even the effective-state read', () => {
    // §25 rule 7, re-asserted over the whole file AFTER the extension: the read answers about tenants
    // the SERVER enumerates, so it takes `?limit=&cursor=` and never a tenant the caller names.
    const routePattern = /@(?:Get|Post|Patch|Delete)\(/g;
    const starts = [...controller.matchAll(routePattern)].map((match) => match.index ?? 0);

    starts.forEach((start, index) => {
      const chunk = controller.slice(start, starts[index + 1] ?? controller.length);
      expect(chunk).not.toMatch(/@Query\('tenantId'\)/);
      expect(chunk).not.toMatch(/@Body\(\).*tenantId\?:/);
    });

    // The one query DTO the extension does accept is the SAME bounded, cursor-continued one the
    // granted-tenant read uses — not a new shape with a tenant in it.
    const extensionStart = controller.indexOf(
      "@Get(':moduleId/features/:featureId/effective-state')"
    );
    const extensionChunk = controller.slice(extensionStart, controller.indexOf('@Post(', extensionStart));
    expect(extensionChunk).toContain('ListFeatureTenantsQueryDto');
    expect(extensionChunk).toContain('this.features.listTenantStates(');
  });

  it('hangs every route off the registry prefix and authenticates the controller', () => {
    expect(controller).toMatch(/@Controller\('admin\/modules'\)/);
    expect(controller).toMatch(/@UseGuards\(JwtAuthGuard\)/);
  });

  it('carries @Roles on EVERY route, with the read/manage split §43.8 freezes', () => {
    const routePattern = /@(?:Get|Post|Patch|Delete)\(/g;
    const starts = [...controller.matchAll(routePattern)].map((match) => match.index ?? 0);
    expect(starts).toHaveLength(FROZEN_ROUTES.length);

    starts.forEach((start, index) => {
      const chunk = controller.slice(start, starts[index + 1] ?? controller.length);
      expect(chunk).toMatch(new RegExp(`@Roles\\(Permissions\\.${FROZEN_ROUTES[index].role}\\)`));
    });
  });

  it('audits every mutation through the service, with §43.8s frozen action vocabulary', () => {
    for (const call of MUTATIONS) expect(controller).toContain(call);

    for (const action of ['declared', 'updated', 'enabled', 'disabled', 'granted', 'revoked']) {
      expect(service).toContain(`module.feature.${action}`);
    }

    // The boundary itself, and the resource §43.8 names for it.
    expect(service).toMatch(/this\.audit\.log\(\{/);
    expect(service).toContain("MODULE_FEATURE_AUDIT_RESOURCE = 'ModuleFeature'");
    expect(service).toMatch(/resourceId: `\$\{moduleId\}:\$\{featureId\}`/);
  });

  it('lets no caller choose the TENANCY of a request', () => {
    // No route reads a tenant from a query, a header or the request context.
    expect(controller).not.toMatch(/@Query\('tenantId'\)/);
    expect(controller).not.toMatch(/@Headers?\(/);
    expect(controller).not.toMatch(/RequestContextService/);
    expect(controller).not.toMatch(/dto\.tenantId\b/);

    // The ONLY tenantId the controller reads is the revoke path segment.
    expect([...controller.matchAll(/@Param\('tenantId'\)/g)]).toHaveLength(1);

    // And the body DTOs cannot name a module: those are path segments.
    const dtoSource = read(path.join(ENTITLEMENT, 'dto', 'module-feature.dto.ts'));
    expect(dtoSource).not.toMatch(/^\s+moduleId[?!]?:/m);
  });

  it('is a controller of the ENTITLEMENT module, never a second writer in the registry module', () => {
    const moduleSource = read(modulePath);
    const registryModule = read(path.join(src, 'module-platform', 'module-platform.module.ts'));

    expect(moduleSource).toMatch(/controllers:\s*\[ModuleFeatureController\]/);
    expect(registryModule).not.toContain('ModuleFeatureController');
    expect(registryModule).not.toContain('ModuleFeatureService');
  });
});
