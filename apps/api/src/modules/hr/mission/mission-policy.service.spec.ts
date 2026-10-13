import { MissionPolicyService } from './mission-policy.service';
import type { HrActor } from '../hr-actor';

/**
 * CONTRACT CLOSURE (pre-Step-8A): THE POLICY-VERSION LIST ANSWERS THE SHARED ENVELOPE.
 *
 * WHY THIS EXISTS. `listVersions` passed the repository's POSITIONAL TUPLE `[rows, count]` straight
 * to the wire, while every other Mission list — `MissionService.list`, `listOptionGroups`,
 * `listApprovalDefinitions` — answers `{ items, total, page, pageSize }`. That left exactly one
 * list a Web client could not type with a single envelope rule, and it carried no page facts at
 * all, so the effective page size was unknowable to the caller.
 *
 * WHY THE PAGE NUMBER IS DERIVED RATHER THAN ECHOED. This service never sees `page`/`pageSize`: the
 * CONTROLLER computes the window and passes `{ skip, take }`. So the envelope is reconstructed from
 * the window that was actually used — `take` IS the effective page size, and `skip / take + 1`
 * inverts the controller's own `(page - 1) * pageSize`.
 *
 * WHY THE STUBS ARE HAND-BUILT. Only `listVersionPage` is exercised here. The other three
 * collaborators (approval repository, rule engine, audit gateway) are not on this path, so they are
 * minimal objects that would FAIL LOUDLY if the method ever reached for them — a fake large enough
 * to satisfy them would be machinery asserting itself.
 */

const TENANT = 'tenant-a';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'login-of-actor',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

/** One row in the shape `MissionPolicyVersion` actually has, trimmed to what a list renders. */
function versionRow(id: string, version: number) {
  return {
    id,
    tenantId: TENANT,
    version,
    status: 'DRAFT' as const,
    ruleSetId: MissionPolicyService.RULE_SET_ID,
    configuration: {},
    publishedAt: null,
    createdAt: new Date('2026-09-23T00:00:00.000Z'),
    updatedAt: new Date('2026-09-23T00:00:00.000Z'),
  };
}

/**
 * The same row AS THE WIRE SEES IT.
 *
 * The list now projects each row instead of forwarding it, so the expected items are the projected
 * shape: ISO strings instead of `Date`s, no `tenantId`, and the server's own lifecycle flags. Writing
 * the expectation out (rather than importing the projection) is deliberate — a spec that reused the
 * production projection could not detect the projection being wrong.
 */
function projectedRow(id: string, version: number) {
  return {
    id,
    version,
    status: 'DRAFT' as const,
    ruleSetId: MissionPolicyService.RULE_SET_ID,
    configuration: {},
    publishedAt: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    actions: { canValidate: true, canPublish: false, canArchive: false },
  };
}

/** The service under test, with the repository tuple it will be answered with. */
function build(tuple: readonly [unknown[], number]) {
  const policyRepo = { listVersionPage: jest.fn().mockResolvedValue(tuple) };
  const service = new MissionPolicyService(
    policyRepo as never,
    // Not on this path: a call to either would be a real finding, and a thrown TypeError is how
    // this file reports one rather than silently tolerating it.
    {} as never,
    {} as never,
    {} as never
  );
  return { service, policyRepo };
}

describe('55 — MissionPolicyService.listVersions envelope (contract closure)', () => {
  it('derives page 1 and the effective page size from a first-page window', async () => {
    const rows = [versionRow('v1', 2), versionRow('v2', 1)];
    const { service, policyRepo } = build([rows, 2]);

    const result = await service.listVersions(ACTOR, {}, { skip: 0, take: 20 });

    // THE ITEMS ARE PROJECTED, NOT FORWARDED: `tenantId` is gone and the instants are ISO strings.
    expect(result.items).toEqual([projectedRow('v1', 2), projectedRow('v2', 1)]);
    expect(result.items[0]).not.toHaveProperty('tenantId');
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    // The repository contract is UNCHANGED — same tenant, same rule-set filter, same window.
    expect(policyRepo.listVersionPage).toHaveBeenCalledWith(
      TENANT,
      { ruleSetId: MissionPolicyService.RULE_SET_ID },
      { skip: 0, take: 20 }
    );
  });

  it('recovers page 3 from a mid-list window', async () => {
    const { service } = build([[], 0]);

    const result = await service.listVersions(ACTOR, {}, { skip: 40, take: 20 });

    // `(3 - 1) * 20 === 40` — the inverse of the controller's own arithmetic.
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(20);
  });

  it('reports the page size that was REALLY used, not a default', async () => {
    const { service } = build([[], 0]);

    const result = await service.listVersions(ACTOR, {}, { skip: 20, take: 10 });

    // A non-default page size: 20/10 + 1 = 3. Echoing a hardcoded 20 here would be a lie about
    // both the page and the size, which is the defect this closure exists to prevent.
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
  });

  it('normalizes the tuple itself, leaking no positional keys', async () => {
    const rows = [versionRow('v1', 1)];
    const { service } = build([rows, 7]);

    const result = await service.listVersions(ACTOR, {}, { skip: 0, take: 5 });

    // A tuple SPREAD would satisfy `items`/`total` while also adding `0`/`1` — and would leave
    // `page`/`pageSize` undefined. The exact key set is what catches that silently-passing shape.
    expect(Object.keys(result).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(result.items).toEqual([projectedRow('v1', 1)]);
    expect(result.total).toBe(7);
  });

  it('reports a row that carries no column the wire does not declare', async () => {
    // The projection is the ONLY place the tenant id or a raw `Date` could escape, so the claim is
    // made on the shipped key set rather than on one field at a time.
    const { service } = build([[versionRow('v1', 1)], 1]);

    const result = await service.listVersions(ACTOR, {}, { skip: 0, take: 20 });

    expect(Object.keys(result.items[0]).sort()).toEqual([
      'actions',
      'configuration',
      'createdAt',
      'id',
      'publishedAt',
      'ruleSetId',
      'status',
      'updatedAt',
      'version',
    ]);
  });

  it('passes the status filter through without altering the rule-set scope', async () => {
    const { service, policyRepo } = build([[], 0]);

    await service.listVersions(ACTOR, { status: 'PUBLISHED' }, { skip: 0, take: 20 });

    // Filtering semantics are untouched by the envelope change — and the rule set is still forced.
    expect(policyRepo.listVersionPage).toHaveBeenCalledWith(
      TENANT,
      { status: 'PUBLISHED', ruleSetId: MissionPolicyService.RULE_SET_ID },
      { skip: 0, take: 20 }
    );
  });

  it('answers page 1 for a non-positive window instead of 0, Infinity or NaN', async () => {
    // No route produces this, but the method's own signature permits it: the guard is what keeps
    // the arithmetic from escaping the response as a nonsense page number.
    const { service } = build([[], 0]);

    const zero = await service.listVersions(ACTOR, {}, { skip: 0, take: 0 });
    expect(zero.page).toBe(1);
    expect(zero.pageSize).toBe(0);

    const negative = await service.listVersions(ACTOR, {}, { skip: 40, take: -1 });
    expect(negative.page).toBe(1);
    expect(negative.pageSize).toBe(-1);
    expect(Number.isFinite(negative.page)).toBe(true);
  });
});
