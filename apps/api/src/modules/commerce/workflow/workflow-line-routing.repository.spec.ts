import { readFileSync } from 'fs';
import { join } from 'path';
import { WorkflowLineRoutingRepository } from './workflow-line-routing.repository';
import type { CommercePrismaService } from '../database/commerce-prisma.service';

/**
 * PHASE C3 (GAP-2): the line-routing CONFIGURATION repository — tenant scoping and the
 * exact statements the database would receive, tested without a database.
 *
 * WHY A HAND-BUILT FAKE
 * ---------------------
 * The assertions pin the `where`, the `data`, the ordering and the window each method
 * builds. A full Prisma fake would be machinery asserting itself (HR's
 * `mission-repositories.spec.ts` states the same reasoning); a handful of `jest.fn()`s
 * state exactly which calls this repository may issue — and, more importantly, that every
 * one of them is qualified by the ACTOR'S tenant before it ever reaches a connection.
 *
 * WHAT IS PINS BEYOND THAT:
 *  * `tenantId` is the FIRST argument of every method (§11) — the module's text guard
 *    re-reads that rule, and these tests prove the arguments are actually FORWARDED;
 *  * the list is BOUNDED (skip/take come from the caller's window) and DETERMINISTIC
 *    (`createdAt desc, id asc`), so a page can be walked without seeing a row twice;
 *  * `publish` is a CONDITIONAL write (`updateMany` with the tenant AND the id in the
 *    predicate) rather than an update of a unique key, which is what makes two concurrent
 *    publishes impossible rather than unlikely;
 *  * `findUnique` — the one read that cannot carry a tenant predicate — appears NOWHERE.
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makePrisma(partial: Record<string, unknown>): CommercePrismaService {
  return partial as unknown as CommercePrismaService;
}

const write = {
  status: 'DRAFT' as const,
  versionLabel: '1404-01',
  trigger: 'PURCHASE_SUBMITTED' as const,
  noRouteBehavior: 'LEAVE_UNROUTED' as const,
  multipleMatchBehavior: 'HIGHEST_PRIORITY' as const,
  aggregationPolicy: 'INDEPENDENT' as const,
  routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: 'v-standard' }],
};

describe('WorkflowLineRoutingRepository — the C3 configuration persistence boundary', () => {
  it('create writes the ACTING tenant with the whole write, and never a caller-stated one', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'rv-1' });
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { create } })
    );

    await repo.create(TENANT_A, write);

    expect(create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_A,
        status: 'DRAFT',
        versionLabel: '1404-01',
        trigger: 'PURCHASE_SUBMITTED',
        noRouteBehavior: 'LEAVE_UNROUTED',
        multipleMatchBehavior: 'HIGHEST_PRIORITY',
        aggregationPolicy: 'INDEPENDENT',
        routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: 'v-standard' }],
      },
    });
  });

  it('findById is a tenant-qualified findFirst — tenant A can never address tenant B by id', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { findFirst } })
    );

    await repo.findById(TENANT_A, 'rv-1');

    expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: TENANT_A, id: 'rv-1' } });
  });

  it('findByLabel narrows the collision read to one tenant', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { findFirst } })
    );

    await repo.findByLabel(TENANT_A, '1404-01');

    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, versionLabel: '1404-01' },
    });

    // The same label under another tenant is a DIFFERENT question, and it is asked
    // with that tenant's predicate — two tenants may hold the same label.
    await repo.findByLabel(TENANT_B, '1404-01');
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { tenantId: TENANT_B, versionLabel: '1404-01' },
    });
  });

  it('findPublishedForTrigger selects only this tenant’s PUBLISHED version', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { findFirst } })
    );

    await repo.findPublishedForTrigger(TENANT_A, 'PURCHASE_SUBMITTED');

    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, trigger: 'PURCHASE_SUBMITTED', status: 'PUBLISHED' },
    });
  });

  it('publish is a conditional write on (tenant, id), then reads the row back in that scope', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue({ id: 'rv-1', status: 'PUBLISHED' });
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { updateMany, findFirst } })
    );

    const row = await repo.publish(TENANT_A, 'rv-1');

    expect(updateMany).toHaveBeenCalledWith({
      data: { status: 'PUBLISHED' },
      where: { id: 'rv-1', tenantId: TENANT_A },
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'rv-1', tenantId: TENANT_A } });
    expect(row.status).toBe('PUBLISHED');
  });

  it('listPage reads rows and their total in ONE snapshot, tenant-scoped, bounded and ordered', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const $transaction = jest.fn(async (arg: unknown) => Promise.all(arg as Promise<unknown>[]));
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { findMany, count }, $transaction })
    );

    await repo.listPage(TENANT_A, {}, { skip: 20, take: 20 });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: 20,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
  });

  it('listPage narrows the search to the identifying column, case-insensitively', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const $transaction = jest.fn(async (arg: unknown) => Promise.all(arg as Promise<unknown>[]));
    const repo = new WorkflowLineRoutingRepository(
      makePrisma({ workflowLineRoutingVersion: { findMany, count }, $transaction })
    );

    await repo.listPage(TENANT_B, { search: '1404' }, { skip: 0, take: 20 });

    const expectedWhere = {
      tenantId: TENANT_B,
      versionLabel: { contains: '1404', mode: 'insensitive' },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('never reaches for findUnique — the one read that cannot carry a tenant predicate', () => {
    const source = readFileSync(
      join(__dirname, 'workflow-line-routing.repository.ts'),
      'utf8'
    ).replace(/^\s*\/\/.*$/gm, '');

    expect(source).not.toContain('.findUnique(');
    expect(source).not.toContain('.findUniqueOrThrow(');
    expect(source).not.toMatch(/\n\s*\.delete\(/);
    // And the whole file really is the statements this spec just pinned: four reads plus the
    // two writes, so a seventh method added without a test does not go unnoticed.
    expect([...source.matchAll(/\n {2}async (\w+)\(/g)].map((match) => match[1])).toEqual([
      'create',
      'findById',
      'findByLabel',
      'listPage',
      'findPublishedForTrigger',
      'publish',
    ]);
  });
});
