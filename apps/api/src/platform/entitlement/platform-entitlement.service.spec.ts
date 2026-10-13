import { ModuleTenantScope } from '../../generated/core-client';
import { RequestContextService } from '../../common/request-context.service';
import { PrismaService } from '../../database/prisma.service';
import { ENTITLEMENT_FAILURE_LABELS, type EntitlementFailureCode } from './entitlement.contract';
import { PlatformEntitlementService } from './platform-entitlement.service';

/**
 * Phase 54-C (D14, §43.10 gate 1) and its D16 extension (§45.8, service spec).
 *
 * WHAT THIS FILE PROVES, AND WHY EACH ONE IS HERE RATHER THAN ASSUMED
 * -------------------------------------------------------------------
 *  - THE SEVEN-ROW TRUTH TABLE OF §43.9, row by row: absent, disabled, out-of-scope, feature
 *    absent, feature disabled, grant absent, allowed. A branch that allows by default fails here.
 *  - THE ORDER IS FROZEN, each step able only to make the outcome more restrictive: a disabled
 *    module cannot be rescued by a feature, and a forbidden tenant never reaches the feature
 *    tables at all.
 *  - A TENANT-LESS CALLER IS REFUSED AT BOTH LEVELS, and at the feature level the grant table is
 *    not even queried: "no tenant" is not a member of any enumeration.
 *  - EACH SCOPE HAS EXACTLY ONE MEMBERSHIP SOURCE (D16, §45.4). `RESTRICTED` reads the legacy
 *    array and never the child table; `RESTRICTED_MEMBERS` reads the child table and never the
 *    array — a row whose array lists the tenant but whose membership row is missing is FORBIDDEN,
 *    which is the assertion that makes "authoritative" a fact rather than a description.
 *  - AN UNRECOGNISED SCOPE REFUSES. The branch is unreachable while the enum has three members;
 *    it exists because the failure mode it prevents (a fourth member admitted by a missing case)
 *    is exactly the silent widening §45.4 was written to make impossible.
 *  - THE TENANT COMES FROM THE REQUEST CONTEXT, and from nowhere else: every test sets it there
 *    and no test passes one to `decide()` — there is no parameter to pass.
 */

const REGISTRATION_ID = '11111111-1111-4111-8111-111111111111';
const FEATURE_ROW_ID = '22222222-2222-4222-8222-222222222222';
const TENANT = 'tenant-alpha';
const OTHER_TENANT = 'tenant-beta';

/** The narrow row the service selects; the mock returns exactly these columns. */
const registrationRow = (overrides: Record<string, unknown> = {}) => ({
  id: REGISTRATION_ID,
  enabled: true,
  tenantScope: ModuleTenantScope.ALL as string,
  tenantIds: [] as string[],
  ...overrides,
});

const prismaMock = () => ({
  moduleRegistration: { findUnique: jest.fn() },
  moduleRegistrationTenant: { findUnique: jest.fn() },
  moduleFeature: { findUnique: jest.fn() },
  moduleFeatureGrant: { findUnique: jest.fn() },
});

describe('PlatformEntitlementService — the frozen §43.2 decision order', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let service: PlatformEntitlementService;

  /**
   * The ONLY way a tenant enters this service — the same source `resolve()` uses. Setting it
   * per test (including to `null`) keeps the tests independent of each other's async context.
   */
  const withTenant = (tenantId: string | null) => {
    RequestContextService.set({
      requestId: 'req-1',
      correlationId: 'corr-1',
      startTime: Date.now(),
      tenantId,
    });
  };

  beforeEach(() => {
    prisma = prismaMock();
    service = new PlatformEntitlementService(prisma as unknown as PrismaService);
  });

  // WHY THE TENANT IS SET INSIDE EACH TEST AND NOT IN THE HOOK ABOVE. `RequestContextService.set`
  // is `AsyncLocalStorage.enterWith`, and a store entered from a Jest hook is NOT visible from the
  // test body's own async context: a hook-set tenant reads back as `undefined`, which is
  // indistinguishable from the `null` that several of these tests assert AGAINST. The symptom is
  // instructive — every refusal passed and only row 3's ADMISSION failed — and it is exactly how a
  // spec silently ends up testing a tenant-less caller. `withTenant` therefore stays a helper, and
  // it is called as the first statement of each test whose outcome depends on the tenant.

  describe('the module level — rows 1-3', () => {
    it('row 1: no registration refuses MODULE_NOT_FOUND and reads no other table', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_NOT_FOUND',
      });

      expect(prisma.moduleFeature.findUnique).not.toHaveBeenCalled();
      expect(prisma.moduleFeatureGrant.findUnique).not.toHaveBeenCalled();
      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });

    it('row 2: a disabled registration refuses MODULE_DISABLED even when a feature is asked for', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ enabled: false }));

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_DISABLED',
      });

      // The frozen order, asserted directly: a feature cannot rescue a disabled module.
      expect(prisma.moduleFeature.findUnique).not.toHaveBeenCalled();
    });

    it('row 3: RESTRICTED refuses a tenant outside the array, and admits one inside it — from the array alone', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: ModuleTenantScope.RESTRICTED, tenantIds: [OTHER_TENANT] })
      );

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: ModuleTenantScope.RESTRICTED, tenantIds: [TENANT] })
      );

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({ ok: true });

      // Byte-identical to `resolve()`: the legacy array is the whole membership source here, and
      // the child table is never consulted for a RESTRICTED row.
      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });

    it('row 3, null tenant: RESTRICTED refuses a caller with no tenant', async () => {
      withTenant(null);
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: ModuleTenantScope.RESTRICTED, tenantIds: [TENANT] })
      );

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // §45.4 item 3 (D16) — RESTRICTED_MEMBERS at the module level
    // ───────────────────────────────────────────────────────────────────────────
    //
    // The member exists because a `RESTRICTED` row's array is bounded (1-64 ids, enforced by
    // `ModuleRegistration_tenantScope_consistent`) while the platform already has more tenants
    // than that, so the set cannot be enumerated in the row. Its claim is the one-membership-
    // source rule: the child table decides, and the array is INERT for this scope.
    const membershipScoped = () =>
      registrationRow({ tenantScope: ModuleTenantScope.RESTRICTED_MEMBERS, tenantIds: [] });

    it('row 3, RESTRICTED_MEMBERS: admits on a membership row and refuses without one — from the child table alone', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(membershipScoped());

      prisma.moduleRegistrationTenant.findUnique.mockResolvedValue({ id: 'membership-1' });

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({ ok: true });

      // The lookup is by the child table's own composite unique key, so it is index-covered and
      // cannot match a membership belonging to another registration.
      expect(prisma.moduleRegistrationTenant.findUnique).toHaveBeenCalledWith({
        where: { registrationId_tenantId: { registrationId: REGISTRATION_ID, tenantId: TENANT } },
        select: { id: true },
      });

      prisma.moduleRegistrationTenant.findUnique.mockResolvedValue(null);

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });
    });

    it('row 3, RESTRICTED_MEMBERS: a populated legacy array still does not admit', async () => {
      // The replacement CHECK requires the array to be EMPTY for this scope, so this state
      // cannot occur in the database — and the test exists because "the array is not a second
      // membership source" is the whole of D16. If it ever were populated, the ABSENT membership
      // row must still refuse: one scope, one source.
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({
          tenantScope: ModuleTenantScope.RESTRICTED_MEMBERS,
          tenantIds: [TENANT],
        })
      );
      prisma.moduleRegistrationTenant.findUnique.mockResolvedValue(null);

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });
    });

    it('row 3, RESTRICTED_MEMBERS, null tenant: refused WITHOUT a membership lookup', async () => {
      withTenant(null);
      prisma.moduleRegistration.findUnique.mockResolvedValue(membershipScoped());

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      // No key to look up: a membership is a per-tenant row and there is no tenant to match, so
      // the query is skipped rather than issued with a null tenant.
      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });

    it('an UNRECOGNISED scope refuses instead of admitting — why the switch has a refusing default', async () => {
      // Unreachable while the enum has three members, and here for the reason §45.4 was written:
      // the check it replaced — "refuse when the scope is RESTRICTED and the tenant is not
      // listed" — ADMITTED every scope it did not recognise, so a fourth enum member would have
      // widened access silently. An unknown scope has no membership rule, so the only safe answer
      // is the door.
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: 'FUTURE_SCOPE', tenantIds: [TENANT] })
      );

      await expect(service.decide({ moduleId: 'hr' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // The feature level — §43.9 rows 4-7
  // ─────────────────────────────────────────────────────────────────────────────
  describe('the feature level — rows 4-7', () => {
    /** An ALL-scoped, enabled registration: every test below is about the feature logic. */
    const moduleAllowed = () => registrationRow();

    const featureRow = (overrides: Record<string, unknown> = {}) => ({
      id: FEATURE_ROW_ID,
      enabled: true,
      ...overrides,
    });

    it('row 4: an undeclared feature refuses FEATURE_NOT_FOUND and never reads a grant', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(moduleAllowed());
      prisma.moduleFeature.findUnique.mockResolvedValue(null);

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'FEATURE_NOT_FOUND',
      });

      // Declared-vs-granted is the distinction this code exists for: a feature the platform does
      // not offer has no grants to consult.
      expect(prisma.moduleFeatureGrant.findUnique).not.toHaveBeenCalled();
    });

    it('row 5: a platform-disabled feature refuses FEATURE_DISABLED and never reads a grant', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(moduleAllowed());
      prisma.moduleFeature.findUnique.mockResolvedValue(featureRow({ enabled: false }));

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'FEATURE_DISABLED',
      });

      expect(prisma.moduleFeatureGrant.findUnique).not.toHaveBeenCalled();
    });

    it('row 6: an absent grant refuses FEATURE_NOT_GRANTED — presence is the grant (§43.3)', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(moduleAllowed());
      prisma.moduleFeature.findUnique.mockResolvedValue(featureRow());
      prisma.moduleFeatureGrant.findUnique.mockResolvedValue(null);

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'FEATURE_NOT_GRANTED',
      });

      expect(prisma.moduleFeatureGrant.findUnique).toHaveBeenCalledWith({
        where: { featureRowId_tenantId: { featureRowId: FEATURE_ROW_ID, tenantId: TENANT } },
        select: { id: true },
      });
    });

    it('row 7: a grant held by this tenant allows, and the decision carries nothing else', async () => {
      withTenant(TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(moduleAllowed());
      prisma.moduleFeature.findUnique.mockResolvedValue(featureRow());
      prisma.moduleFeatureGrant.findUnique.mockResolvedValue({ id: 'grant-1' });

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: true,
      });
    });

    it('a tenant-less caller is refused at the feature level without querying the grant table', async () => {
      // Asserted at the level where the mistake would be invisible: the module is ALL-scoped and
      // the feature IS declared and enabled, so only the tenant clause can refuse — and it refuses
      // BEFORE the read, because a grant keyed by tenant has no key to look up.
      withTenant(null);
      prisma.moduleRegistration.findUnique.mockResolvedValue(moduleAllowed());
      prisma.moduleFeature.findUnique.mockResolvedValue(featureRow());

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'FEATURE_NOT_GRANTED',
      });

      expect(prisma.moduleFeatureGrant.findUnique).not.toHaveBeenCalled();
    });

    it('the module level is FROZEN ABOVE the feature level: a forbidden tenant never reaches the feature tables', async () => {
      withTenant(OTHER_TENANT);
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: ModuleTenantScope.RESTRICTED, tenantIds: [TENANT] })
      );

      await expect(service.decide({ moduleId: 'hr', featureId: 'leave' })).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      // THE ORDER OF §43.2 IS THE PROPERTY BEING TESTED: each step can only make the outcome more
      // restrictive, so a forbidden tenant cannot be rescued by a granted feature.
      expect(prisma.moduleFeature.findUnique).not.toHaveBeenCalled();
      expect(prisma.moduleFeatureGrant.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // The vocabulary a refusal is rendered from
  // ─────────────────────────────────────────────────────────────────────────────
  describe('the refusal vocabulary', () => {
    it('every code a DECISION can return has a label — no refusal reaches an operator unlabelled', () => {
      // EXHAUSTIVE BY TYPE: the record below is keyed by `EntitlementFailureCode`, so a seventh
      // decision code cannot be added to the contract without appearing here and failing until it
      // is labelled. `ENTITLEMENT_NOT_DECLARED` is the GUARD's code (§43.5) and is deliberately not
      // listed: it is wiring rather than entitlement, and it is asserted where it is raised — in
      // the guard's own spec.
      const decisionCodes: Record<EntitlementFailureCode, true> = {
        MODULE_NOT_FOUND: true,
        MODULE_DISABLED: true,
        MODULE_FORBIDDEN: true,
        FEATURE_NOT_FOUND: true,
        FEATURE_DISABLED: true,
        FEATURE_NOT_GRANTED: true,
      };

      for (const code of Object.keys(decisionCodes) as EntitlementFailureCode[]) {
        expect(ENTITLEMENT_FAILURE_LABELS[code]).toBeTruthy();
      }
    });
  });
});
