import { CommercialConfigurationRepository } from './commercial-configuration.repository';
import { CommercialConfigurationService } from './commercial-configuration.service';
import type { CommercePrismaService } from '../database/commerce-prisma.service';
import type { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import type { CommerceUnitOfWork } from '../database/commerce-transaction';
import type { CommercialLiaisonResolver } from './commercial-liaison';

/**
 * PHASE C8 (GAP-5): the two commercial lists' `search` parameter — the statements the
 * database would receive, and the orchestration that hands them ONE filter.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `GET /commerce/commercial-groups` and `GET /commerce/commercial-configurations` publish
 * the shared `search` parameter (`CommercePageQueryDto` is the module's one
 * page/pageSize/search base) and, until C8, SILENTLY IGNORED it: the DTO accepted the
 * parameter, the controller passed the query, and the repository took no filter. That is
 * the dishonest parameter this module's DTOs and C7's timeline rationale name by name —
 * so C8 makes it real, on the columns that identify each row, and this spec is what keeps
 * it honest:
 *
 *  * the FILTER is `contains` + `mode: 'insensitive'` on `code`/`name` (groups) and
 *    `versionLabel` (versions) — the same semantics every other Commerce list search
 *    uses, pinned here so no second matching convention can appear unnoticed;
 *  * the page and the `total` are built from ONE `where` object, asserted by REFERENCE
 *    (`toBe`): two equal-by-coincidence predicates would drift the first time one changes,
 *    and a page whose total counts a different set cannot be paged to its end;
 *  * the TENANT is always the actor's, always first, and never a field the filter can
 *    carry — a search narrows WITHIN a tenant and can never widen it;
 *  * the ORDERING and the window are unchanged from before the filter existed, so adding
 *    search moved no page boundary a pre-existing client depends on.
 *
 * A HAND-BUILT FAKE, for the reason `workflow-line-routing.repository.spec.ts` records: a
 * full Prisma fake would be machinery asserting itself, while a handful of `jest.fn()`s
 * state exactly which statements this repository may issue — and that every one of them
 * arrives with the tenant attached.
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const ACTOR: CommerceActor = {
  tenantId: TENANT_A,
  userId: 'u1',
  requestId: 'r1',
  correlationId: 'c1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

function makePrisma(partial: Record<string, unknown>): CommercePrismaService {
  return partial as unknown as CommercePrismaService;
}

/** The repository with recording fakes for exactly the two page statements it may issue. */
function makeRepository() {
  const groupFindMany = jest.fn().mockResolvedValue([]);
  const groupCount = jest.fn().mockResolvedValue(0);
  const versionFindMany = jest.fn().mockResolvedValue([]);
  const versionCount = jest.fn().mockResolvedValue(0);
  const $transaction = jest.fn(async (arg: unknown) => Promise.all(arg as Promise<unknown>[]));

  const prisma = makePrisma({
    commercialGroup: { findMany: groupFindMany, count: groupCount },
    commercialConfigurationVersion: { findMany: versionFindMany, count: versionCount },
    $transaction,
  });

  return {
    repository: new CommercialConfigurationRepository(prisma),
    groupFindMany,
    groupCount,
    versionFindMany,
    versionCount,
    $transaction,
  };
}

describe('CommercialConfigurationRepository — PHASE C8 (GAP-5) list search', () => {
  it('listGroupPage reads rows and their total in ONE snapshot, tenant-scoped, bounded, code-ordered', async () => {
    const { repository, groupFindMany, groupCount, $transaction } = makeRepository();

    const [rows, total] = await repository.listGroupPage(TENANT_A, {}, { skip: 20, take: 20 });

    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(groupFindMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A },
      orderBy: { code: 'asc' },
      skip: 20,
      take: 20,
    });
    expect(groupCount).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
  });

  it('listGroupPage narrows a search to code OR name, case-insensitively — one predicate, twice read', async () => {
    const { repository, groupFindMany, groupCount } = makeRepository();

    await repository.listGroupPage(TENANT_B, { search: 'Buying' }, { skip: 0, take: 20 });

    const expectedWhere = {
      tenantId: TENANT_B,
      OR: [
        { code: { contains: 'Buying', mode: 'insensitive' } },
        { name: { contains: 'Buying', mode: 'insensitive' } },
      ],
    };
    expect(groupFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(groupCount).toHaveBeenCalledWith({ where: expectedWhere });
    // The SAME object, not merely an equal one: the page and its total are cut by one
    // predicate, so a filtered read's `total` describes rows the caller can page to.
    expect(groupCount.mock.calls[0][0].where).toBe(groupFindMany.mock.calls[0][0].where);
  });

  it('listConfigurationPage narrows a search to the identifying versionLabel, case-insensitively', async () => {
    const { repository, versionFindMany, versionCount, $transaction } = makeRepository();

    await repository.listConfigurationPage(
      TENANT_A,
      { search: '1405-policy' },
      { skip: 40, take: 20 }
    );

    const expectedWhere = {
      tenantId: TENANT_A,
      versionLabel: { contains: '1405-policy', mode: 'insensitive' },
    };
    expect(versionFindMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      skip: 40,
      take: 20,
    });
    expect(versionCount).toHaveBeenCalledWith({ where: expectedWhere });
    expect(versionCount.mock.calls[0][0].where).toBe(versionFindMany.mock.calls[0][0].where);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('listConfigurationPage with no search is the unfiltered, tenant-scoped read it was before C8', async () => {
    const { repository, versionFindMany, versionCount } = makeRepository();

    await repository.listConfigurationPage(TENANT_B, {}, { skip: 0, take: 50 });

    expect(versionFindMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_B },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 50,
    });
    expect(versionCount).toHaveBeenCalledWith({ where: { tenantId: TENANT_B } });
  });
});

describe('CommercialConfigurationService — PHASE C8 (GAP-5) list search orchestration', () => {
  /** The service with fakes; only the repository is consulted by the two list reads. */
  function makeService() {
    const listGroupPage = jest.fn().mockResolvedValue([[], 0]);
    const listConfigurationPage = jest.fn().mockResolvedValue([[], 0]);
    const repository: Pick<
      CommercialConfigurationRepository,
      'listGroupPage' | 'listConfigurationPage'
    > = { listGroupPage, listConfigurationPage };

    const service = new CommercialConfigurationService(
      repository as unknown as CommercialConfigurationRepository,
      {} as unknown as CommercialLiaisonResolver, // untouched by a list read
      { record: jest.fn() } as unknown as CommerceAuditGateway, // a read records nothing
      {} as unknown as CommerceUnitOfWork // no write happens in a list read
    );

    return { service, listGroupPage, listConfigurationPage };
  }

  it('listGroups forwards the ACTOR tenant first, the shared search and the resolved window', async () => {
    const { service, listGroupPage } = makeService();
    listGroupPage.mockResolvedValue([[{ id: 'g1' }], 1]);

    const page = await service.listGroups(ACTOR, { page: 2, pageSize: 50, search: 'buy' });

    expect(listGroupPage).toHaveBeenCalledWith(TENANT_A, { search: 'buy' }, { skip: 50, take: 50 });
    expect(page).toEqual({
      items: [{ id: 'g1' }],
      page: 2,
      pageSize: 50,
      total: 1,
    });
  });

  it('listConfigurations forwards the ACTOR tenant first, the shared search and the resolved window', async () => {
    const { service, listConfigurationPage } = makeService();
    listConfigurationPage.mockResolvedValue([[{ id: 'cfg-1' }], 3]);

    const page = await service.listConfigurations(ACTOR, {
      page: 3,
      pageSize: 20,
      search: '1405',
    });

    expect(listConfigurationPage).toHaveBeenCalledWith(
      TENANT_A,
      { search: '1405' },
      { skip: 40, take: 20 }
    );
    expect(page).toEqual({
      items: [{ id: 'cfg-1' }],
      page: 3,
      pageSize: 20,
      total: 3,
    });
  });

  it('listGroups without a search issues no filter value and invents no parameter', async () => {
    const { service, listGroupPage } = makeService();

    await service.listGroups(ACTOR, {});

    const [tenantId, filter, window] = listGroupPage.mock.calls[0];
    expect(tenantId).toBe(TENANT_A);
    // The key exists and is undefined — the repository spreads on the value, so the built
    // `where` is the tenant-only predicate it has always been.
    expect(filter.search).toBeUndefined();
    expect(Object.keys(filter)).toEqual(['search']);
    // The shared page window, resolved exactly as before: default page 1 / default size.
    expect(window).toEqual({ skip: 0, take: 20 });
  });
});
