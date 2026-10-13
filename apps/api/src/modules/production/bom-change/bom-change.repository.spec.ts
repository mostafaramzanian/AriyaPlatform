import { readFileSync } from 'fs';
import { join } from 'path';
import { BomChangeRequestRepository } from './bom-change.repository';
import type { BomChangeRequestItemRecord, BomChangeRequestRecord } from './bom-change.repository';

/**
 * Phase PRODUCTION-BOM-CHANGE: the persistence boundary of the change-request slice.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE TENANT IS IN EVERY `where`. Every method takes `tenantId` first and forwards it
 *     into the predicate, so a foreign id cannot be read or written. Checked on the
 *     ARGUMENTS the repository actually passes, not on a comment.
 *  2. `findUnique` IS NEVER USED. It cannot carry a tenant predicate, so a "find by id"
 *     written with it would read another tenant's row — asserted twice: on the fake, and on
 *     the SOURCE text, because the compiler would happily accept `findUnique({ where: { id }
 *     })` and the runtime would return a stranger's request.
 *  3. TRANSITIONS ARE CONDITIONAL. `submit` carries `items: { some: {} }` AND the expected
 *     `from` status in ONE UPDATE; `decide` carries the expected `from`. A read-then-write
 *     pair would have neither, and two concurrent acts could both win.
 *  4. SUBMIT WRITES NO DECISION COLUMN, so "nobody has decided" stays NULL and the decision
 *     columns keep exactly one writer.
 *  5. THE CHILD'S PARENT GUARD IS INSIDE THE TRANSACTION. `createItem` touches the request's
 *     DRAFT state before inserting; `updateItemDraft` / `deleteItemDraft` carry the parent's
 *     `status: 'DRAFT'` through the relation filter. Without any of the three, a detail could
 *     be written into a request that a concurrent submit had already frozen.
 *  6. THIS REPOSITORY NEVER WRITES `BomHeader` OR `BomItem`. The phase's central rule —
 *     approving a change request does not apply it — asserted on the SOURCE, because a
 *     Prisma fake cannot fail a write it is never asked to make.
 *
 * The Prisma double is structural: `ConstructorParameters` derives the fake's type from the
 * repository's own constructor, so the spec never imports the generated production client.
 */

const TENANT = 'tenant-a';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const BOM_ITEM_ID = '33333333-3333-4333-8333-333333333333';

const ROW: BomChangeRequestRecord = {
  id: REQUEST_ID,
  tenantId: TENANT,
  bomId: '44444444-4444-4444-8444-444444444444',
  title: 'تغییر اقلام پروژه الف',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: 'user-requester',
  approverUserId: 'user-approver',
  status: 'DRAFT',
  managerOpinion: null,
  notes: null,
  requestDate: new Date('2026-01-01T00:00:00.000Z'),
  submittedAt: null,
  decidedAt: null,
  decidedByUserId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

/** A detail row AS THE REPOSITORY RETURNS IT: stored columns plus the READ part name. */
const ITEM_ROW: BomChangeRequestItemRecord = {
  id: ITEM_ID,
  tenantId: TENANT,
  changeRequestId: REQUEST_ID,
  bomItemId: BOM_ITEM_ID,
  changeType: 'QUANTITY_CHANGE',
  originalDrawingCoefficient: 4,
  originalSpareCoefficient: 2,
  drawingCoefficientDelta: -1,
  spareCoefficientDelta: null,
  createdAt: new Date('2026-01-03T00:00:00.000Z'),
  updatedAt: new Date('2026-01-04T00:00:00.000Z'),
  partName: 'Bracket',
};

interface PrismaFake {
  bomChangeRequest: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
    updateMany: jest.Mock;
  };
  bomChangeRequestItem: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  auditOutbox: {
    create: jest.Mock;
  };
  $transaction: jest.Mock;
}

function build(
  updateCount = 1,
  itemDeleteCount = 1
): {
  repository: BomChangeRequestRepository;
  prisma: PrismaFake;
} {
  const prisma: PrismaFake = {
    bomChangeRequest: {
      create: jest.fn().mockResolvedValue(ROW),
      findFirst: jest.fn().mockResolvedValue(ROW),
      findMany: jest.fn().mockResolvedValue([ROW]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([{ status: 'SUBMITTED', _count: { _all: 2 } }]),
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
    },
    bomChangeRequestItem: {
      create: jest.fn().mockResolvedValue({ ...ITEM_ROW, bomItem: { partName: 'Bracket' } }),
      findFirst: jest.fn().mockResolvedValue({ ...ITEM_ROW, bomItem: { partName: 'Bracket' } }),
      findMany: jest.fn().mockResolvedValue([{ ...ITEM_ROW, bomItem: { partName: 'Bracket' } }]),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      deleteMany: jest.fn().mockResolvedValue({ count: itemDeleteCount }),
    },
    auditOutbox: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
  };

  // The transaction double simply runs the callback against the SAME fake client, so the
  // repository's two-statement shape (guard, then insert) is exercised for real rather than
  // asserted on a spy that never dispatched.
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback(prisma)
  );

  return {
    repository: new BomChangeRequestRepository(
      prisma as unknown as ConstructorParameters<typeof BomChangeRequestRepository>[0]
    ),
    prisma,
  };
}

describe('BomChangeRequestRepository — tenancy', () => {
  it('stamps the acting tenant on create and lets the schema default everything else', async () => {
    const { repository, prisma } = build();

    await repository.create(TENANT, {
      bomId: ROW.bomId,
      title: ROW.title,
      projectRef: ROW.projectRef,
      productTreeRef: ROW.productTreeRef,
      requesterUserId: 'user-requester',
      approverUserId: 'user-approver',
    });

    const data = prisma.bomChangeRequest.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(TENANT);
    // NO caller-supplied status, decision or date: a write path that could set APPROVED
    // would bypass every transition the routes own, and a caller-stated `requestDate` would
    // let a request claim it was raised before it existed.
    // `Array.prototype.sort` orders by UTF-16 code units, so `productTreeRef` precedes
    // `projectRef` ('d' < 'j' at index 3) — stated rather than "sorted" to avoid the
    // expectation silently reordering itself.
    expect(Object.keys(data).sort()).toEqual([
      'approverUserId',
      'bomId',
      'productTreeRef',
      'projectRef',
      'requesterUserId',
      'tenantId',
      'title',
    ]);
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('requestDate');
    expect(data).not.toHaveProperty('managerOpinion');
  });

  it('carries the tenant in EVERY single-row predicate, never an id alone', async () => {
    const { repository, prisma } = build();

    await repository.findById(TENANT, REQUEST_ID);
    await repository.findItemById(TENANT, REQUEST_ID, ITEM_ID);

    expect(prisma.bomChangeRequest.findFirst.mock.calls[0][0].where).toEqual({
      id: REQUEST_ID,
      tenantId: TENANT,
    });
    expect(prisma.bomChangeRequestItem.findFirst.mock.calls[0][0].where).toEqual({
      id: ITEM_ID,
      tenantId: TENANT,
      changeRequestId: REQUEST_ID,
    });
  });

  it('never uses findUnique — it cannot carry a tenant predicate', async () => {
    const { repository, prisma } = build();

    await repository.findById(TENANT, REQUEST_ID);
    await repository.findItemById(TENANT, REQUEST_ID, ITEM_ID);

    expect((prisma.bomChangeRequest as Record<string, unknown>).findUnique).toBeUndefined();
    expect((prisma.bomChangeRequestItem as Record<string, unknown>).findUnique).toBeUndefined();

    // The runtime double cannot fail a method it was never given; the SOURCE is what can
    // fail, so it is what carries this assertion.
    const source = readFileSync(join(__dirname, 'bom-change.repository.ts'), 'utf8');
    expect(source).not.toMatch(/findUnique\s*\(/);
  });

  it('scopes the list by tenant AND counts with the same predicate as the page', async () => {
    const { repository, prisma } = build();

    const result = await repository.list(TENANT, {
      skip: 10,
      take: 20,
      bomId: ROW.bomId,
      projectRef: '42',
      status: 'SUBMITTED',
      search: 'تغییر',
    });

    const pageArgs = prisma.bomChangeRequest.findMany.mock.calls[0][0];
    const countArgs = prisma.bomChangeRequest.count.mock.calls[0][0];

    expect(pageArgs.where).toEqual({
      tenantId: TENANT,
      bomId: ROW.bomId,
      projectRef: '42',
      status: 'SUBMITTED',
      title: { contains: 'تغییر' },
    });
    expect(pageArgs.skip).toBe(10);
    expect(pageArgs.take).toBe(20);
    expect(countArgs.where).toEqual(pageArgs.where);
    expect(result.total).toBe(1);
  });

  it('scopes every child statement by tenant AND by changeRequestId', async () => {
    const { repository, prisma } = build();

    await repository.listItems(TENANT, REQUEST_ID);
    await repository.countForRequest(TENANT, REQUEST_ID);

    expect(prisma.bomChangeRequestItem.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      changeRequestId: REQUEST_ID,
    });
    expect(prisma.bomChangeRequestItem.count.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      changeRequestId: REQUEST_ID,
    });
  });
});

describe('BomChangeRequestRepository — transitions are conditional, in ONE statement', () => {
  it('submits only from DRAFT and only when a detail row exists', async () => {
    const { repository, prisma } = build();

    await repository.submit(TENANT, REQUEST_ID, 'a note');

    const { where, data } = prisma.bomChangeRequest.updateMany.mock.calls[0][0];
    // BOTH gates travel with the write: an empty request cannot be submitted, and a second
    // submit cannot win. Neither property survives a read-then-write pair.
    expect(where).toEqual({
      id: REQUEST_ID,
      tenantId: TENANT,
      status: 'DRAFT',
      items: { some: {} },
    });
    expect(data.status).toBe('SUBMITTED');
    expect(data.submittedAt).toBeInstanceOf(Date);
    expect(data.notes).toBe('a note');
    // No decision column: "nobody has decided" stays NULL.
    expect(data).not.toHaveProperty('managerOpinion');
    expect(data).not.toHaveProperty('decidedAt');
    expect(data).not.toHaveProperty('decidedByUserId');
  });

  it('decides only from the status the caller named', async () => {
    const { repository, prisma } = build();

    await repository.decide(TENANT, REQUEST_ID, 'SUBMITTED', {
      status: 'APPROVED',
      managerOpinion: 'APPROVED',
      notes: 'ok',
      decidedByUserId: 'user-approver',
    });

    const { where, data } = prisma.bomChangeRequest.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: REQUEST_ID, tenantId: TENANT, status: 'SUBMITTED' });
    expect(data.status).toBe('APPROVED');
    expect(data.managerOpinion).toBe('APPROVED');
    expect(data.decidedAt).toBeInstanceOf(Date);
    expect(data.decidedByUserId).toBe('user-approver');
    // The transition itself is NOT part of the payload: it is the thing being guarded.
    expect(data).not.toHaveProperty('submittedAt');
  });

  it('patches a draft conditionally and reports a miss as null without re-reading', async () => {
    const { repository, prisma } = build(0);

    const missed = await repository.updateDraft(TENANT, REQUEST_ID, { title: 'new' });

    expect(missed).toBeNull();
    expect(prisma.bomChangeRequest.updateMany.mock.calls[0][0].where).toEqual({
      id: REQUEST_ID,
      tenantId: TENANT,
      status: 'DRAFT',
    });
    // A refused write must not fall through to a re-read that would report a STALE row as
    // though the update had happened.
    expect(prisma.bomChangeRequest.findFirst).not.toHaveBeenCalled();
  });
});

describe('BomChangeRequestRepository — the child\u2019s parent guard', () => {
  it('guards an INSERT with a conditional DRAFT touch before inserting anything', async () => {
    const { repository, prisma } = build();

    const created = await repository.createItem(TENANT, REQUEST_ID, {
      bomItemId: BOM_ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      originalDrawingCoefficient: 4,
      originalSpareCoefficient: 2,
      drawingCoefficientDelta: -1,
    });

    // The guard is the FIRST statement of the transaction, and it is conditional.
    expect(prisma.bomChangeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.bomChangeRequest.updateMany.mock.calls[0][0].where).toEqual({
      id: REQUEST_ID,
      tenantId: TENANT,
      status: 'DRAFT',
    });
    expect(prisma.bomChangeRequestItem.create.mock.calls[0][0].data).toMatchObject({
      tenantId: TENANT,
      changeRequestId: REQUEST_ID,
      bomItemId: BOM_ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      originalDrawingCoefficient: 4,
      originalSpareCoefficient: 2,
    });
    // The part name rides on the READ include, never on the payload: it is the item's fact.
    expect(prisma.bomChangeRequestItem.create.mock.calls[0][0].data).not.toHaveProperty('partName');
    expect(created).toMatchObject({ id: ITEM_ID, partName: 'Bracket' });
  });

  it('inserts NOTHING when the parent is no longer a DRAFT', async () => {
    const { repository, prisma } = build(0);
    // A guard of `count: 0` means a concurrent submit won; the callback must return before
    // it reaches the INSERT, which is what makes the two statements atomic.
    prisma.bomChangeRequest.updateMany.mockResolvedValue({ count: 0 });

    const created = await repository.createItem(TENANT, REQUEST_ID, {
      bomItemId: BOM_ITEM_ID,
      changeType: 'DEACTIVATE',
      originalDrawingCoefficient: 4,
      originalSpareCoefficient: 2,
    });

    expect(created).toBeNull();
    expect(prisma.bomChangeRequestItem.create).not.toHaveBeenCalled();
  });

  it('carries the parent DRAFT state through the relation filter on update and delete', async () => {
    const { repository, prisma } = build();

    await repository.updateItemDraft(TENANT, REQUEST_ID, ITEM_ID, {
      spareCoefficientDelta: 3,
    });
    await repository.deleteItemDraft(TENANT, REQUEST_ID, ITEM_ID);

    for (const [delegate, call] of [
      ['updateMany', prisma.bomChangeRequestItem.updateMany],
      ['deleteMany', prisma.bomChangeRequestItem.deleteMany],
    ] as const) {
      expect({ delegate, where: call.mock.calls[0][0].where }).toEqual({
        delegate,
        where: {
          id: ITEM_ID,
          tenantId: TENANT,
          changeRequestId: REQUEST_ID,
          changeRequest: { status: 'DRAFT' },
        },
      });
    }
  });

  it('reports a refused delete as false instead of throwing', async () => {
    const { repository } = build(1, 0);
    await expect(repository.deleteItemDraft(TENANT, REQUEST_ID, ITEM_ID)).resolves.toBe(false);
  });
});

describe('BomChangeRequestRepository — the phase\u2019s central rule, asserted on source', () => {
  it('NEVER writes BomHeader or BomItem — approving a request does not apply it', () => {
    // This is `DEFERRED / CONTRACT NOT ESTABLISHED` expressed as a gate rather than as a
    // promise: `Apply Change` has no contract, so the only writer of `BomItem` may remain
    // `bom-item.repository`, and no statement in this file may reach `bomHeader`'s
    // `updateMany`/`update`/`create`/`deleteMany` or `bomItem`'s at all.
    const source = readFileSync(join(__dirname, 'bom-change.repository.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');

    expect(code).not.toMatch(/\.\s*bomHeader\s*\./);
    expect(code).not.toMatch(/\.\s*bomItem\s*\./);
    // And nothing that could renumber, deactivate or otherwise rewrite the BOM itself.
    expect(code).not.toMatch(/BomItem(Update|Create|Delete)/);
    expect(code).not.toMatch(/BomHeader(Update|Create|Delete)/);
  });

  it('reads the part name through the relation with a narrow projection, not a copy', async () => {
    const { repository, prisma } = build();

    await repository.listItems(TENANT, REQUEST_ID);

    const { include, orderBy } = prisma.bomChangeRequestItem.findMany.mock.calls[0][0];
    expect(include).toEqual({ bomItem: { select: { partName: true } } });
    // The source grid's order, stable under appends (id breaks createdAt ties).
    expect(orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('BomChangeRequestRepository — the reporting reads (Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT)', () => {
  it('listWithItemCount pages with the SAME predicate as list, plus a row-bound _count', async () => {
    const { repository, prisma } = build();

    const result = await repository.listWithItemCount(TENANT, {
      skip: 20,
      take: 10,
      status: 'SUBMITTED',
      projectRef: '42',
    });

    const args = prisma.bomChangeRequest.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: TENANT, status: 'SUBMITTED', projectRef: '42' });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.include).toEqual({ _count: { select: { items: true } } });
    // The total is counted with the SAME where — a page and its count cannot disagree.
    expect(prisma.bomChangeRequest.count.mock.calls[0][0].where).toEqual(args.where);
    expect(result.total).toBe(1);
    expect(result.requests).toHaveLength(1);
  });

  it('keeps the tenant predicate even when NO filter is stated — the first key is always tenantId', async () => {
    const { repository, prisma } = build();

    await repository.listWithItemCount(TENANT, { skip: 0, take: 20 });

    expect(prisma.bomChangeRequest.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
    });
  });

  it('findByIdWithItemCount is a tenant-scoped findFirst — never a findUnique by id alone', async () => {
    const { repository, prisma } = build();

    const row = await repository.findByIdWithItemCount(TENANT, REQUEST_ID);

    expect(prisma.bomChangeRequest.findFirst).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, tenantId: TENANT },
      include: { _count: { select: { items: true } } },
    });
    expect(row).toEqual(ROW);
  });

  it('countByStatus groups by status over the SAME predicate, tenant-first', async () => {
    const { repository, prisma } = build();

    const counts = await repository.countByStatus(TENANT, { bomId: ROW.bomId });

    expect(prisma.bomChangeRequest.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { tenantId: TENANT, bomId: ROW.bomId },
      _count: { _all: true },
    });
    expect(counts).toBeInstanceOf(Map);
    expect(counts.get('SUBMITTED')).toBe(2);
  });
});
