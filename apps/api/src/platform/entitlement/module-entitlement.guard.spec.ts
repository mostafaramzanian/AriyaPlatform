import { Controller, ExecutionContext, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  RequiresFeature,
  RequiresModule,
  combineEntitlementRequirement,
  type EntitlementDecision,
  type EntitlementFailureCode,
  type EntitlementPort,
} from './entitlement.contract';
import { ModuleEntitlementGuard } from './module-entitlement.guard';

/**
 * Phase 54-C (§43.10 gate 2): THE GATE SPEC.
 *
 * The failure it exists for is the one that opens a door silently. `RolesGuard` in this codebase
 * was bypassed on every `@Roles()` route for two phases because its spec mocked
 * `reflector.getAllAndOverride` positionally (see `roles.guard.spec.ts`, Phase 33N) — the mock
 * agreed with the guard while the guard agreed with nothing the decorators wrote. This spec
 * therefore uses the REAL `Reflector`, the REAL decorators and REAL controller classes:
 * `getAllAndOverride` is a real metadata read, so a guard that asked for the wrong key would fail
 * here instead of passing by construction.
 *
 * The four claims §43.10 gate 2 names, each with a test that can fail:
 *
 *  1. DECORATED WITHOUT METADATA ⇒ `403 ENTITLEMENT_NOT_DECLARED`, and the port is NOT asked.
 *     A surface whose decorator was forgotten must close, and consulting the registry first would
 *     make "the declaration is missing" indistinguishable from a real entitlement decision.
 *  2. THE REQUEST CANNOT INFLUENCE THE DECISION. No query parameter, body field or header can
 *     name a tenant: the context below THROWS if the guard touches the request at all, and the
 *     port's only argument is asserted to be the module/feature pair with nothing else in it.
 *  3. THE REFUSAL SHAPE. `403`, a stable body, a frozen §43.2 code, and `featureId` present only
 *     when the surface asked the feature-level question.
 *  4. THE MERGE. A feature-only declaration STILL asks the module question (with the feature's own
 *     module id), and two declarations that name different modules are refused rather than
 *     resolved — a guard does not pick a winner between contradictory wiring.
 */

const MODULE_ID = 'hr';
const OTHER_MODULE_ID = 'cms';
const FEATURE_ID = 'leave';

@Controller('undeclared')
class UndeclaredController {
  @Get()
  handler(): void {}
}

@Controller('declared')
@RequiresModule(MODULE_ID)
class DeclaredController {
  @Get()
  handler(): void {}

  /** A handler-level declaration OVERRIDES the class's, which is the `getAllAndOverride` order. */
  @Get('overriding')
  @RequiresModule(OTHER_MODULE_ID)
  overridingHandler(): void {}

  /** A feature declared for a DIFFERENT module than the class declares: a wiring contradiction. */
  @Get('conflicting')
  @RequiresFeature(OTHER_MODULE_ID, FEATURE_ID)
  conflictingHandler(): void {}
}

@Controller('feature-declared')
@RequiresFeature(MODULE_ID, FEATURE_ID)
class FeatureDeclaredController {
  @Get()
  handler(): void {}
}

describe('ModuleEntitlementGuard (§43.5, §43.10 gate 2)', () => {
  let decide: jest.Mock;
  let guard: ModuleEntitlementGuard;

  beforeEach(() => {
    decide = jest.fn();
    const port = { decide } as unknown as EntitlementPort;
    // A REAL Reflector, deliberately: the guard reads metadata through it, and a mocked
    // `getAllAndOverride` would be a second copy of the contract rather than a test of it.
    guard = new ModuleEntitlementGuard(port, new Reflector());
  });

  /**
   * The context of a request that TRIES to name a tenant, in every place a caller controls.
   *
   * `switchToHttp` throws instead of returning a request: the guard must not reach for the
   * request at all, so a future edit that starts reading `?tenantId=`, a body field or a header
   * fails here with "the guard must not touch the request" rather than passing quietly. The
   * request object below is carried only so the shapes a caller CAN send are visible in the test.
   */
  function contextFor(
    klass: new () => unknown,
    handler: (...args: unknown[]) => unknown
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => klass,
      switchToHttp: () => {
        throw new Error('the guard must not touch the request');
      },
    } as unknown as ExecutionContext;
  }

  /** The body of a `ForbiddenException`, for shape assertions. */
  function refusalBody(error: unknown): Record<string, unknown> {
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    return (error as ForbiddenException).getResponse() as Record<string, unknown>;
  }

  const allow = (): EntitlementDecision => ({ ok: true });
  const refuse = (failure: EntitlementFailureCode): EntitlementDecision => ({ ok: false, failure });

  describe('a surface with no declaration', () => {
    it('is REFUSED with ENTITLEMENT_NOT_DECLARED, and the port is not asked', async () => {
      const context = contextFor(UndeclaredController, UndeclaredController.prototype.handler);

      const error = await guard.canActivate(context).catch((thrown: unknown) => thrown);

      expect(refusalBody(error)).toEqual({ statusCode: 403, code: 'ENTITLEMENT_NOT_DECLARED' });
      // The distinction this preserves: a missing declaration is WIRING, not entitlement, so it is
      // not answered by asking the registry — and consulting it first would make "the decorator was
      // forgotten" look exactly like a real decision in the log.
      expect(decide).not.toHaveBeenCalled();
    });
  });

  describe("the decision is the port's, and the request is not consulted", () => {
    it('asks ONCE, with the module id and NOTHING else — no tenant, no header, no body', async () => {
      decide.mockResolvedValue(allow());

      await expect(
        guard.canActivate(contextFor(DeclaredController, DeclaredController.prototype.handler))
      ).resolves.toBe(true);

      expect(decide).toHaveBeenCalledTimes(1);
      // EXACT object equality: anything else on the question — a `tenantId` most of all — would
      // have to appear here. This is what turns "a caller cannot claim a tenant" from a sentence in
      // a doc comment into a test.
      expect(decide).toHaveBeenCalledWith({ moduleId: MODULE_ID });
    });

    it("refuses with the port's own code and echoes what was asked", async () => {
      decide.mockResolvedValue(refuse('MODULE_FORBIDDEN'));

      const error = await guard
        .canActivate(contextFor(DeclaredController, DeclaredController.prototype.handler))
        .catch((thrown: unknown) => thrown);

      expect(refusalBody(error)).toEqual({
        statusCode: 403,
        code: 'MODULE_FORBIDDEN',
        moduleId: MODULE_ID,
      });
    });

    it('a feature-level refusal names the feature, a module-level one does not', async () => {
      decide.mockResolvedValue(refuse('FEATURE_NOT_GRANTED'));

      const error = await guard
        .canActivate(
          contextFor(FeatureDeclaredController, FeatureDeclaredController.prototype.handler)
        )
        .catch((thrown: unknown) => thrown);

      // `featureId` is echoed only when the surface declared one: its presence states what was
      // asked, so its absence means "the module level was the question", never "unknown".
      expect(refusalBody(error)).toEqual({
        statusCode: 403,
        code: 'FEATURE_NOT_GRANTED',
        moduleId: MODULE_ID,
        featureId: FEATURE_ID,
      });
    });
  });

  describe('the merge of the two declaration sites', () => {
    it("a feature-only declaration STILL asks the module question, with the feature's own module", async () => {
      decide.mockResolvedValue(allow());

      await expect(
        guard.canActivate(
          contextFor(FeatureDeclaredController, FeatureDeclaredController.prototype.handler)
        )
      ).resolves.toBe(true);

      // Nothing is skipped at the module level: a feature is only ever reachable behind its module.
      expect(decide).toHaveBeenCalledWith({ moduleId: MODULE_ID, featureId: FEATURE_ID });
    });

    it('declarations naming DIFFERENT modules are refused rather than resolved', async () => {
      const error = await guard
        .canActivate(
          contextFor(DeclaredController, DeclaredController.prototype.conflictingHandler)
        )
        .catch((thrown: unknown) => thrown);

      // Two declarations that disagree are a wiring contradiction; picking one of them would be a
      // silent decision made by a guard, and asking the registry would answer the wrong question
      // very well.
      expect(refusalBody(error)).toEqual({ statusCode: 403, code: 'ENTITLEMENT_NOT_DECLARED' });
      expect(decide).not.toHaveBeenCalled();
    });

    it('a handler-level declaration OVERRIDES the class-level one', async () => {
      decide.mockResolvedValue(allow());

      await guard.canActivate(
        contextFor(DeclaredController, DeclaredController.prototype.overridingHandler)
      );

      // The `getAllAndOverride` order `JwtAuthGuard` and `RolesGuard` both use: handler first,
      // class second — so a single route can be narrowed without touching its controller.
      expect(decide).toHaveBeenCalledWith({ moduleId: OTHER_MODULE_ID });
    });

    it('the merge function itself agrees on all five combinations', () => {
      // The guard's behaviour above is the MERGED requirement; this pins the function, so a change
      // to it cannot hide behind a controller that happens to carry both declarations.
      expect(combineEntitlementRequirement(undefined, undefined)).toBeNull();
      expect(combineEntitlementRequirement(MODULE_ID, undefined)).toEqual({ moduleId: MODULE_ID });
      expect(
        combineEntitlementRequirement(undefined, { moduleId: MODULE_ID, featureId: FEATURE_ID })
      ).toEqual({ moduleId: MODULE_ID, featureId: FEATURE_ID });
      expect(
        combineEntitlementRequirement(MODULE_ID, { moduleId: MODULE_ID, featureId: FEATURE_ID })
      ).toEqual({ moduleId: MODULE_ID, featureId: FEATURE_ID });
      expect(
        combineEntitlementRequirement(MODULE_ID, {
          moduleId: OTHER_MODULE_ID,
          featureId: FEATURE_ID,
        })
      ).toBeNull();
    });
  });

  describe('the guard has NO code path that could read the request', () => {
    it('never calls switchToHttp and never injects a request part (§43.5)', () => {
      // Read as TEXT because the property is STRUCTURAL: the tests above prove the request is not
      // consulted for the calls this guard makes, and this one proves there is no other call to
      // make. A `?tenantId=`-reading branch would have to appear in the source first.
      const source = readFileSync(join(__dirname, 'module-entitlement.guard.ts'), 'utf8');

      expect(source).not.toContain('switchToHttp');
      expect(source).not.toMatch(/\breq\.(body|query|headers|params)\b/);
      expect(source).not.toMatch(/@(Req|Body|Query|Headers|Param)\(/);
    });
  });
});
