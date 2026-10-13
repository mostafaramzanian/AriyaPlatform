import { Test } from '@nestjs/testing';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { HrModule } from '../hr.module';
import { LeavePoliciesController } from './leave-policies.controller';
import { LeavePolicyService } from './leave-policy.service';
import { LeavePolicySimulationService } from './leave-policy-simulation.service';
import { LeavePolicyRepository } from './leave-policy.repository';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RequestContextService } from '../../../common/request-context.service';

/**
 * Phase 54-F — the RUNTIME REACHABILITY guard for the leave-policy surface.
 *
 * WHY THIS FILE EXISTS AND WHAT IT WOULD HAVE MISSED
 * --------------------------------------------------
 * `leave-policy-validation.spec.ts` proves the validator, the domain spec proves the lifecycle, and
 * the service was previously exercised only by DIRECT INSTANTIATION — `new LeavePolicyService(...)`.
 * That style is blind to exactly one class of defect, and it is the one this phase actually shipped
 * once: a service that is correct, fully tested, and UNREACHABLE, because nothing registered it in
 * `HrModule` and no controller ever called it. Every existing unit test stays green in that state,
 * because a directly-instantiated class needs no container to exist. The gap is not in the
 * implementation, it is in the WIRING, so the guard has to assert the wiring.
 *
 * WHAT IS THEREFORE ASSERTED, AND WHY EACH ONE IS FALSIFIABLE
 * ----------------------------------------------------------
 *  1. `HrModule` REGISTERS `LeavePolicyService`, resolved through the REAL module definition rather
 *     than a hand-built graph. Reading it with `moduleRef.get` fails the suite if the provider is
 *     dropped — which is the exact regression that would make the controller uninstantiable in
 *     production while every other spec passed.
 *  2. THE CONTROLLER IS BOUND IN THE MODULE'S `controllers` ARRAY, so its routes are actually
 *     mounted. A controller file that exists but is not listed is dead code, and nothing else in
 *     the repository would say so.
 *  3. THE ROUTES ARE THE ONES THE SPEC NAMES, read from `PATH_METADATA` off the prototype — so a
 *     route silently renamed, or a `/effective` declared AFTER `:policyId` (where the parameter
 *     route would swallow it), fails here rather than in production as a 400 on a valid question.
 *  4. A ROUTE ACTUALLY REACHES THE SERVICE with a SERVER-DERIVED actor: the service is replaced
 *     with a spy, the handler is invoked, and the actor is asserted to carry the resolved tenant
 *     rather than anything the caller sent. That is the tenancy rule proved at the boundary instead
 *     of asserted in a comment.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It does not re-test the validator, the lifecycle table, the effective-resolution semantics or the
 * database guards. Those have their own specs and their own fixtures; repeating them here would make
 * this file a second, disagreeing authority on rules it does not own. It asserts reachability, route
 * shape and actor derivation — nothing else.
 *
 * `HrModule` IS IMPORTED RATHER THAN REBUILT, and that is the whole value: a hand-written
 * `providers: [...]` list in a test would drift from the real module and would pass while the real
 * module was broken, which is the failure mode being guarded against. The module's data dependencies
 * are satisfied by `overrideProvider` rather than by importing a database, so this stays a unit test
 * with no Postgres connection.
 */
describe('LeavePoliciesController wiring (§15, §12)', () => {
  let controller: LeavePoliciesController;
  let service: { [key: string]: jest.Mock };

  /**
   * Seeds the request context the middleware would have established.
   *
   * THE CALL SHAPE FOLLOWS `calendar/reminder.service.spec.ts`, which already seeds a context this
   * way: only `tenantId`/`userId` vary between cases, and the two bookkeeping fields are filled
   * because the interface requires them rather than because this file reads them.
   *
   * `set` REPLACES THE STORE RATHER THAN MERGING, WHICH THIS FILE NEEDS FOR ITS NEGATIVE CASE. A
   * store that could only be patched would let the preceding case's tenant survive into the case that
   * asserts NO tenant exists — and that case would then pass while proving nothing, which is exactly
   * the failure this file was written to catch. `RequestContextService.patch` merges in place and
   * cannot express "there is no tenant", so it is deliberately not used here.
   */
  const setContext = (tenantId: string | null, userId: string) =>
    RequestContextService.set({
      requestId: 'req-1',
      correlationId: 'corr-1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  /**
   * Drops the store between cases.
   *
   * `AsyncLocalStorage` HAS NO `clear` AND `enterWith` CANNOT UN-ENTER, so a store seeded by one test
   * outlives it for the rest of the file (`runInBand` shares the process). Reseeding is therefore the
   * only available reset, and it has to happen for EVERY case rather than only the negative one:
   * a test that forgot would silently inherit whichever tenant ran before it and assert against the
   * wrong actor. `tenantId: null` is the authoritative "not resolved to a tenant" value — `''` would
   * be falsy and pass `resolveHrActor`'s guard for the wrong reason, exercising the wrong branch.
   */
  beforeEach(() => {
    setContext(null, 'unseeded');
  });

  /**
   * CLEARS EVERY MOCK'S RECORDED CALLS BETWEEN CASES, AND THAT IS NOT HOUSEKEEPING.
   *
   * Without this the suite is ORDER-DEPENDENT in the worst way: the negative case asserting
   * `resolveEffective` was NOT called fails against the PREVIOUS case's recorded call, so the test
   * reports a refusal that never happened while the handler's actual behaviour is never examined.
   * That was a real failure in this file, and the fix belongs on the mock rather than on the
   * assertion — a negative test whose falsifiability depends on which test ran before it is not
   * testing the guard at all.
   */
  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    service = {
      resolveEffective: jest.fn(),
      createPolicy: jest.fn(),
      getPolicy: jest.fn(),
      getPublishedVersion: jest.fn(),
      createVersion: jest.fn(),
      getVersion: jest.fn(),
      updateVersion: jest.fn(),
      validateVersion: jest.fn(),
      publishVersion: jest.fn(),
      archiveVersion: jest.fn(),
    };

    // THE REAL MODULE, with only its DATA dependencies stubbed. `overrideProvider` keeps
    // `HrModule`'s own `controllers`/`providers` wiring under test — which is the thing that broke.
    //
    // 54-H ADDED THE SECOND CONTROLLER DEPENDENCY (`LeavePolicySimulationService`), and it is stubbed
    // here for the same reason `LeavePolicyService` is: this file asserts ROUTE SHAPE and ACTOR
    // DERIVATION, and the simulation surface's own behaviour is proved in
    // `leave-limit-simulation.spec.ts`. Leaving it unstubbed would make `HrModule` uninstantiable in
    // this module graph and fail all nine cases for a reason unrelated to what any of them test.
    const testingModule = await Test.createTestingModule({ imports: [HrModule] })
      .overrideProvider(LeavePolicyService)
      .useValue(service)
      .overrideProvider(LeavePolicySimulationService)
      .useValue({ resolveAndSimulate: jest.fn() })
      .overrideProvider(LeavePolicyRepository)
      .useValue({})
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = testingModule.get<LeavePoliciesController>(LeavePoliciesController);
  });

  it('registers LeavePolicyService through the real HrModule definition', () => {
    // Resolved from the module's own `providers` array, so removing the registration fails here
    // rather than in production as an uninstantiable controller.
    expect(Reflect.getMetadata('providers', HrModule)).toContain(LeavePolicyService);
  });

  it('binds LeavePoliciesController in HrModule so its routes are mounted', () => {
    // Obtained FROM THE MODULE rather than constructed, which only succeeds if `HrModule` lists it.
    expect(controller).toBeInstanceOf(LeavePoliciesController);
    expect(Reflect.getMetadata('controllers', HrModule)).toContain(LeavePoliciesController);
  });

  it('declares one hr/leave-policies namespace', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LeavePoliciesController)).toBe('hr/leave-policies');
  });

  /**
   * THE ROUTE TABLE, read off the prototype's own metadata rather than from a hand-written list.
   *
   * WHY `PATH_METADATA` AND NOT A GUARD'S OPINION: the routes ARE the Nest metadata. Asserting them
   * here is what makes "a route silently renamed" fail — and it is also what makes the ORDER
   * assertion below expressible, since order is not observable from behaviour without an HTTP server.
   *
   * THE PROTOTYPE IS TYPED AS `Record<string, object>` FOR THE LOOKUP, because the decorators are
   * keyed by METHOD NAME while TypeScript knows the method LIST. Narrowing the lookup to the runtime
   * signature is what lets a table drive the assertions; the table's own handler names are `as const`,
   * so a typo in one is still a compile error rather than a silently absent route.
   */
  const prototype = LeavePoliciesController.prototype as unknown as Record<string, object>;

  /**
   * Reads ONE handler's route metadata, NORMALISED TO ARRAYS.
   *
   * NEST STORES A SINGLE PATH AS A BARE STRING AND A MISSING PATH AS `undefined`, NOT AS AN ARRAY.
   * `@Get('effective')` writes the string `'effective'`, `@Post()` writes `undefined`, and only a
   * decorator given several paths (e.g. `@Get(['a', 'b'])`) writes an array. Both facts were measured
   * against this controller's own metadata rather than assumed, and the table below says `[]` for
   * `createPolicy` because that is what the metadata actually holds — asserting a tidier fiction
   * would have forced a mapping layer into the assertion instead of into this one helper.
   *
   * THE NORMALISATION LIVES HERE SO THE TABLE CAN SPEAK NEST'S OWN VOCABULARY. A caller that had to
   * remember which handlers carry an argument would be restating the controller in the test.
   */
  const routesOf = (handler: string): { paths: string[]; methods: RequestMethod[] } => {
    const rawPath: unknown = Reflect.getMetadata(PATH_METADATA, prototype[handler]);
    const rawMethod: unknown = Reflect.getMetadata(METHOD_METADATA, prototype[handler]);

    return {
      paths:
        rawPath === undefined
          ? []
          : Array.isArray(rawPath)
            ? (rawPath as string[])
            : [String(rawPath)],
      methods:
        rawMethod === undefined
          ? []
          : Array.isArray(rawMethod)
            ? (rawMethod as RequestMethod[])
            : [rawMethod as RequestMethod],
    };
  };

  it('declares the authoring, lifecycle and effective routes the spec names (§15)', () => {
    // `path` IS `'/'` FOR A HANDLER WHOSE DECORATOR CARRIES NO ARGUMENT (`@Post()`), WHICH WAS
    // MEASURED RATHER THAN ASSUMED. `@Get('effective')` stores the bare string `'effective'`, and an
    // argument-less `@Post()` stores `'/'` — not `undefined`, and not `''`. The table below therefore
    // states `['/']` for `createPolicy`, because that is what the metadata holds and asserting the
    // tidier fiction would have forced a mapping layer into this helper. Nest mounts the bare handler
    // at the controller's own path, which is the behaviour `createPolicy` relies on.
    const table = [
      ['effective', ['effective'], RequestMethod.GET],
      ['createPolicy', ['/'], RequestMethod.POST],
      ['getPolicy', [':policyId'], RequestMethod.GET],
      ['getPublishedVersion', [':policyId/published'], RequestMethod.GET],
      ['createVersion', [':policyId/versions'], RequestMethod.POST],
      ['getVersion', [':policyId/versions/:versionId'], RequestMethod.GET],
      ['updateVersion', [':policyId/versions/:versionId'], RequestMethod.PATCH],
      ['validateVersion', [':policyId/versions/:versionId/validate'], RequestMethod.POST],
      ['publishVersion', [':policyId/versions/:versionId/publish'], RequestMethod.POST],
      ['archiveVersion', [':policyId/versions/:versionId/archive'], RequestMethod.POST],
    ] as const;

    for (const [handler, paths, method] of table) {
      const route = routesOf(handler);
      // `paths` and `methods` are arrays because a handler may declare several; each declares one.
      expect([handler, route.paths, route.methods]).toEqual([handler, paths, [method]]);
    }
  });

  it('declares the literal `effective` route BEFORE `:policyId` so it is not swallowed', () => {
    // READ FROM THE CLASS'S OWN METHOD ORDER, which is the order Nest registers handlers in. If
    // `/:policyId` came first, a request for `/hr/leave-policies/effective` would be handled by
    // `getPolicy` and fail as a malformed UUID — a 400 on a valid question, which no unit test of
    // `resolveEffective` would ever catch.
    const handlers = Object.getOwnPropertyNames(LeavePoliciesController.prototype);
    const effectiveAt = handlers.indexOf('effective');
    const policyAt = handlers.indexOf('getPolicy');

    expect(effectiveAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(effectiveAt).toBeLessThan(policyAt);
  });

  it('reaches the service with a SERVER-DERIVED actor, never a caller-supplied tenant', async () => {
    // THE TENANT ARRIVES IN THE REQUEST CONTEXT, NOT ON THE REQUEST BODY OR QUERY — that is the
    // tenancy rule, and `resolveHrActor` reads it from `RequestContextService` (established by the
    // middleware, per request). Seeding it here is what makes this assertion meaningful: the handler
    // is given NO tenant, and the actor still carries one.
    setContext('tenant-abc', 'user-1');

    const req = {
      user: { sub: 'user-1' },
    } as unknown as Parameters<LeavePoliciesController['effective']>[0];

    service.resolveEffective.mockResolvedValue({ policy: null, version: null, limits: [] });

    await controller.effective(req, { leaveTypeId: 'lt-1' });

    expect(service.resolveEffective).toHaveBeenCalledTimes(1);
    const [actor, query] = service.resolveEffective.mock.calls[0];
    expect(actor.tenantId).toBe('tenant-abc');
    expect(actor.userId).toBe('user-1');
    // The caller passed ONLY a leave type. The day defaults on the server, and there is no parameter
    // through which a caller could name a version or a tenant (§12).
    expect(query).toEqual({ leaveTypeId: 'lt-1' });
  });

  it('REFUSES when the request was not resolved to a tenant', async () => {
    // The fail-closed half, and the reason the assertion above is worth making: with no context there
    // is no tenant, and the handler refuses rather than guessing one. A controller that fell back to
    // `req.user.tenantId` would pass every other test in this file and be a tenancy hole.
    //
    // `beforeEach` ALREADY LEFT A TENANT-LESS STORE, SO THIS CASE RE-STATES IT rather than inheriting
    // it: the guard being exercised is `resolveHrActor`'s null check, and a case that relied on the
    // reset would stop testing the refusal the moment somebody reordered or removed it.
    setContext(null, 'user-1');

    const req = { user: { sub: 'user-1' } } as unknown as Parameters<
      LeavePoliciesController['effective']
    >[0];

    await expect(controller.effective(req, { leaveTypeId: 'lt-1' })).rejects.toThrow(
      ForbiddenException
    );
    expect(service.resolveEffective).not.toHaveBeenCalled();
  });

  it('derives the actor for a write route from the request context as well', async () => {
    setContext('tenant-xyz', 'user-2');

    const req = {
      user: { sub: 'user-2' },
    } as unknown as Parameters<LeavePoliciesController['createPolicy']>[0];

    service.createPolicy.mockResolvedValue({ id: 'policy-1' });

    await controller.createPolicy(req, { code: 'P', name: 'Policy' });

    expect(service.createPolicy).toHaveBeenCalledTimes(1);
    expect(service.createPolicy.mock.calls[0][0].tenantId).toBe('tenant-xyz');
  });

  it('gates every write on the authoring permission and every read on hr.leave.read (§25)', () => {
    // `@Roles` is written on the HANDLER, so this reads it there. The separation asserted is the
    // point of the phase: an approver applies the flow, and restating it is a different act.
    const rolesOf = (handler: string): string[] =>
      Reflect.getMetadata('roles', prototype[handler]) ?? [];

    for (const handler of [
      'createPolicy',
      'createVersion',
      'updateVersion',
      'validateVersion',
      'publishVersion',
      'archiveVersion',
    ]) {
      expect([handler, rolesOf(handler)]).toEqual([handler, ['hr.leave.policy']]);
    }

    for (const handler of ['effective', 'getPolicy', 'getPublishedVersion', 'getVersion']) {
      expect([handler, rolesOf(handler)]).toEqual([handler, ['hr.leave.read']]);
    }
  });
});
