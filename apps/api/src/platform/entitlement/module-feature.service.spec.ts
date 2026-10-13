import { ModuleTenantScope } from '../../generated/core-client';
import type { PrismaService } from '../../database/prisma.service';
import type {
  EntitlementDecision,
  EntitlementFailureCode,
  EntitlementRequest,
} from './entitlement.contract';
import { ModuleFeatureService } from './module-feature.service';
import type { PlatformEntitlementService } from './platform-entitlement.service';

/**
 * Phase 54-C closure fix (§43.8): the ADMIN EFFECTIVE-STATE READ.
 *
 * WHAT THIS FILE PROVES, AND WHY EACH ONE IS HERE RATHER THAN ASSUMED
 * ------------------------------------------------------------------
 * The console's misreading was not a rendering bug: it was a SECOND implementation of a decision the
 * server already owns. The web derived "is this tenant entitled?" from `tenantScope`/`tenantIds`, and
 * after D16 that derivation was structurally impossible to get right — HR's membership is a child-table
 * row no browser can read — so an entitled tenancy rendered as `BLOCKED_BY_MODULE`.
 *
 * So the assertions below are about ONE thing: the answer comes from the platform's own evaluator, and
 * the projection is a FORMATTING of that answer rather than a second opinion about it.
 *
 *  - EACH SCOPE HAS EXACTLY ONE ENUMERATION SOURCE, in this read as well as in the decision:
 *    `RESTRICTED_MEMBERS` reads `ModuleRegistrationTenant` and NEVER `tenantIds`; `RESTRICTED` reads
 *    `tenantIds` and never the child table. The `RESTRICTED_MEMBERS` row here carries a NON-EMPTY
 *    legacy array on purpose — the read that used it would answer about a tenant the decision refuses,
 *    and that divergence is exactly the defect being fixed.
 *  - EVERY TENANT'S STATE IS THE EVALUATOR'S, called once per row. A row whose decision refuses is
 *    reported as refusing even when its grant exists, because a grant cannot rescue a forbidden tenant
 *    (§43.9's order, applied through the same code the request path uses).
 *  - CONFIGURED AND EFFECTIVE ARE SEPARATE FIELDS. `moduleEnabled`/`featureEnabled` are reported from
 *    the registration and feature rows even when they block, so the console can say "configured on,
 *    effective off" instead of erasing the operator's setting.
 *  - THE ROWS ARE THE UNION of the module's enumeration and the tenants holding a grant, deduplicated,
 *    paged by tenant id with the SAME bounded cursor contract the granted-tenant read uses — and the
 *    cursor is applied to BOTH streams, so a page boundary can neither repeat nor skip a row.
 *  - `tenantCount` IS `null` FOR `ALL`, not `0`: an `ALL` module enumerates nobody, and a zero would
 *    be a claim about a scope that has no membership list to count.
 */

const REGISTRATION_ID = '11111111-1111-4111-8111-111111111111';
const FEATURE_ROW_ID = '22222222-2222-4222-8222-222222222222';
const MODULE_ID = 'hr';
const FEATURE_ID = 'leave';

const allowed: EntitlementDecision = { ok: true };
const refused = (failure: EntitlementFailureCode): EntitlementDecision => ({ ok: false, failure });

/** The feature row `loadFeatureOrThrow` selects, including the `_count` its include requires. */
const featureRow = (enabled = true) => ({
  id: FEATURE_ROW_ID,
  moduleId: MODULE_ID,
  featureId: FEATURE_ID,
  displayName: 'مرخصی',
  enabled,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  _count: { grants: 0 },
});

const registrationRow = (overrides: Record<string, unknown> = {}) => ({
  id: REGISTRATION_ID,
  enabled: true,
  tenantScope: ModuleTenantScope.RESTRICTED_MEMBERS as string,
  tenantIds: [] as string[],
  ...overrides,
});

/**
 * The Prisma surface this read uses, emulated faithfully enough that the QUERIES are exercised
 * rather than stubbed away: the membership stream, the grant stream, the page-sized grant lookup and
 * the enumeration count each answer from their own list, honouring `tenantId > cursor`, `orderBy`
 * and `take`. A mock that returned one fixed array would hide a paging bug — the very thing the
 * union cursor exists to prevent.
 */
interface PrismaFixture {
  registration?: Record<string, unknown> | null;
  feature?: Record<string, unknown> | null;
  members?: string[];
  grants?: { tenantId: string; grantedAt?: Date }[];
}

function createPrismaMock(fixture: PrismaFixture = {}) {
  const members = [...(fixture.members ?? [])].sort();
  const grants = fixture.grants ?? [];
  const grantedIds = grants.map((grant) => grant.tenantId).sort();
  const grantedAt = new Map(
    grants.map((grant) => [grant.tenantId, grant.grantedAt ?? new Date('2026-02-01T00:00:00.000Z')])
  );

  /** The `tenantId > cursor` + `take` slice both streams share, mirroring `enumerationPage`. */
  const paged = (
    ids: string[],
    args?: { where?: { tenantId?: { gt?: string } }; take?: number },
  ): string[] => {
    const after: string | undefined = args?.where?.tenantId?.gt;
    const take: number | undefined = args?.take;
    const start = after === undefined ? 0 : ids.findIndex((id) => id > after);
    if (start === -1) return [];

    return ids.slice(start, start + (take ?? ids.length));
  };

  return {
    moduleFeature: {
      findUnique: jest.fn(async () =>
        fixture.feature === undefined ? featureRow() : fixture.feature
      ),
    },
    moduleRegistration: {
      findUnique: jest.fn(async () =>
        fixture.registration === undefined ? registrationRow() : fixture.registration
      ),
    },
    moduleRegistrationTenant: {
      findMany: jest.fn(async (args?: { where?: { tenantId?: { gt?: string } }; take?: number }) =>
        paged(members, args).map((tenantId) => ({ tenantId })),
      ),
      count: jest.fn(async () => members.length),
    },
    moduleFeatureGrant: {
      // Both shapes the service sends live on ONE method: the keyset stream
      // (gt + take) and the "which of THESE tenants" page (in).
      findMany: jest.fn(
        async (args?: {
          where?: { tenantId?: { in?: string[]; gt?: string } };
          take?: number;
        }) => {
          const inPage: string[] | undefined = args?.where?.tenantId?.in;

          // The second shape: "which of THESE tenants hold a grant", answered with the timestamps the
          // console prints. The first shape is the keyset stream and carries ids only.
          if (inPage !== undefined) {
            return inPage
              .filter((tenantId) => grantedAt.has(tenantId))
              .map((tenantId) => ({ tenantId, grantedAt: grantedAt.get(tenantId) as Date }));
          }

          return paged(grantedIds, args).map((tenantId) => ({ tenantId }));
        },
      ),
    },
  };
}

/** The platform evaluator, answering from a per-tenant table. An unmapped tenant is forbidden. */
function createEntitlementMock(byTenant: Record<string, EntitlementDecision> = {}) {
  return {
    decideForTenant: jest.fn(
      async (_input: EntitlementRequest, tenantId: string | null): Promise<EntitlementDecision> =>
        (tenantId === null ? undefined : byTenant[tenantId]) ?? {
          ok: false,
          failure: 'MODULE_FORBIDDEN',
        }
    ),
  };
}

function serviceWith(fixture: PrismaFixture, byTenant: Record<string, EntitlementDecision> = {}) {
  const prisma = createPrismaMock(fixture);
  const entitlement = createEntitlementMock(byTenant);

  return {
    prisma,
    entitlement,
    service: new ModuleFeatureService(
      prisma as unknown as PrismaService,
      entitlement as unknown as PlatformEntitlementService
    ),
  };
}

describe('Phase 54-C closure fix — the authoritative effective-state read (§43.8)', () => {
  const query = (overrides: { limit?: number; cursor?: string } = {}) => overrides;

  // -------------------------------------------------------------------------
  // The four states, each produced by the EVALUATOR rather than by this layer.
  // -------------------------------------------------------------------------

  it('reports ENTITLED for a RESTRICTED_MEMBERS tenant whose membership row exists (A, E)', async () => {
    const { service, entitlement } = serviceWith(
      { members: ['t-1', 't-2'] },
      { 't-1': allowed, 't-2': allowed }
    );

    const page = await service.listTenantStates(MODULE_ID, FEATURE_ID, query({ limit: 10 }));

    expect(page.moduleEnabled).toBe(true);
    expect(page.featureEnabled).toBe(true);
    expect(page.tenantScope).toBe(ModuleTenantScope.RESTRICTED_MEMBERS);
    expect(page.tenantCount).toBe(2);
    expect(page.rows.map((row) => row.tenantId)).toEqual(['t-1', 't-2']);
    expect(page.rows.map((row) => row.effective)).toEqual(['ENTITLED', 'ENTITLED']);
    expect(page.rows.map((row) => row.reasonCode)).toEqual(['ALLOWED', 'ALLOWED']);
    // The decision was ASKED, once per row: ENTITLED is the evaluator's answer, not the read's
    // inference from the membership row's presence.
    expect(entitlement.decideForTenant).toHaveBeenCalledTimes(2);
  });

  it('reports NOT_GRANTED when the tenancy is a member but holds no grant (B)', async () => {
    const { service } = serviceWith(
      { members: ['t-1'] },
      { 't-1': refused('FEATURE_NOT_GRANTED') }
    );

    const page = await service.listTenantStates(MODULE_ID, FEATURE_ID, query());

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      tenantId: 't-1',
      granted: false,
      grantedAt: null,
      effective: 'NOT_GRANTED',
      reasonCode: 'FEATURE_NOT_GRANTED',
    });
  });

  it('reports BLOCKED_BY_MODULE while the module is off, and keeps the CONFIGURED flags (C, F)', async () => {
    const { service } = serviceWith(
      {
        registration: registrationRow({ enabled: false }),
        members: ['t-1'],
        grants: [{ tenantId: 't-1' }],
      },
      { 't-1': refused('MODULE_DISABLED') }
    );

    const page = await service.listTenantStates(MODULE_ID, FEATURE_ID, query());

    expect(page.rows[0].effective).toBe('BLOCKED_BY_MODULE');
    expect(page.rows[0].reasonCode).toBe('MODULE_DISABLED');
    // The grant still EXISTS while the module is off: `granted` states work that was done, and the
    // operator must be able to see that turning the module back on restores it.
    expect(page.rows[0].granted).toBe(true);
    // CONFIGURED vs EFFECTIVE: the module's flag is reported as it IS (off) while the FEATURE's own
    // offer is reported as the operator left it (on) — a disabled module does not rewrite it.
    expect(page.moduleEnabled).toBe(false);
    expect(page.featureEnabled).toBe(true);
  });

  it('reports BLOCKED_BY_FEATURE when the platform withholds the offer (D)', async () => {
    const { service } = serviceWith(
      {
        feature: featureRow(false),
        members: ['t-1'],
        grants: [{ tenantId: 't-1' }],
      },
      { 't-1': refused('FEATURE_DISABLED') }
    );

    const page = await service.listTenantStates(MODULE_ID, FEATURE_ID, query());

    expect(page.rows[0].effective).toBe('BLOCKED_BY_FEATURE');
    expect(page.rows[0].reasonCode).toBe('FEATURE_DISABLED');
    expect(page.moduleEnabled).toBe(true);
    expect(page.featureEnabled).toBe(false);
  });

  it('refuses a granted tenant outside the module scope: a grant cannot rescue it (E, §43.9 order)', async () => {
    const { service } = serviceWith(
      {
        members: ['t-1'],
        grants: [{ tenantId: 'outsider', grantedAt: new Date('2026-03-01T00:00:00Z') }],
      },
      { 't-1': allowed, outsider: refused('MODULE_FORBIDDEN') }
    );

    const page = await service.listTenantStates(MODULE_ID, FEATURE_ID, query());

    // The union makes this row visible at all: a granted tenant the module does not admit is REAL and
    // must be shown — refused, with its reason — rather than silently omitted.
    expect(page.rows.map((row) => row.tenantId)).toEqual(['outsider', 't-1']);
    const outsider = page.rows.find((row) => row.tenantId === 'outsider');
    expect(outsider).toMatchObject({
      granted: true,
      effective: 'BLOCKED_BY_MODULE',
      reasonCode: 'MODULE_FORBIDDEN',
    });
    expect(outsider?.grantedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('follows the evaluator alone: the same tenancy flips back to ENTITLED when the module is re-enabled (G)', async () => {
    const members = ['t-1'];
    const entitled = { 't-1': allowed };

    const off = await serviceWith(
      { registration: registrationRow({ enabled: false }), members },
      // The evaluator's own order is what changes the answer; the tenancy is IDENTICAL in both calls,
      // so the only difference between the two assertions is the module's flag.
      { 't-1': refused('MODULE_DISABLED') }
    ).service.listTenantStates(MODULE_ID, FEATURE_ID, query());
    const on = await serviceWith({ members }, entitled).service.listTenantStates(
      MODULE_ID,
      FEATURE_ID,
      query()
    );

    expect(off.rows[0].effective).toBe('BLOCKED_BY_MODULE');
    expect(off.rows[0].reasonCode).toBe('MODULE_DISABLED');
    expect(off.moduleEnabled).toBe(false);
    expect(on.rows[0].effective).toBe('ENTITLED');
    expect(on.rows[0].reasonCode).toBe('ALLOWED');
    expect(on.moduleEnabled).toBe(true);
    // The configured offer was never touched by the module's flag: only the decision moved.
    expect(off.featureEnabled).toBe(on.featureEnabled);
    expect(off.rows[0].granted).toBe(on.rows[0].granted);
  });
});
