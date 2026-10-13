import { readFileSync } from 'fs';
import { join } from 'path';
import { BomItemRepository } from './bom-item.repository';

/**
 * Phase PRODUCTION-BOM-ITEM: the persistence boundary of the child slice.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE TENANT AND THE BOM ARE IN EVERY `where`. Both are arguments checked on what the
 *     repository actually passes — not on a comment — because an item predicate missing
 *     either one reads or writes a row it should not be able to see.
 *  2. `findUnique` IS NEVER USED: it cannot carry a tenant predicate, so "find by id"
 *     written with it would return another tenant's row. Checked on the SOURCE text too,
 *     because the compiler would happily accept it.
 *  3. THE MUTATIONS ARE CONDITIONAL on the PARENT's `status: 'DRAFT'`, carried inside the
 *     write through the relation filter. Update and delete therefore cannot land on an item
 *     whose BOM a concurrent request has already submitted.
 *  4. CREATE IS A TRANSACTION whose FIRST statement is the parent guard — a count of zero
 *     means a submit won, and nothing is inserted.
 *  5. NOTHING WRITES `standardPartCode`, and no statement reads a `legacyConsumption*`
 *     column: the deferred field has no writer and the derived fields have no formula.
 *
 * The Prisma double is structural: `ConstructorParameters` derives the dependency from the
 * repository's own constructor, so the fake satisfies the real signature without this spec
 * importing the generated production client.
 */

const TENANT = 'tenant-a';
const BOM_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

const ROW = {
  id: ITEM_ID,
  tenantId: TENANT,
  bomId: BOM_ID,
  partName: 'Bracket',
};

const CREATE_INPUT = {
  projectRef: '42',
  productTreeRef: '771',
  partName: 'Bracket',
  partType: 'STRUCTURAL',
  material: 'Steel',
  measurementUnit: 'pcs',
  drawingConsumptionCoefficient: 2,
  spareConsumptionCoefficient: 1,
};

function build() {
  const bomHeader = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
  const bomItem = {
    create: jest.fn().mockResolvedValue(ROW),
    findFirst: jest.fn().mockResolvedValue(ROW),
    findMany: jest.fn().mockResolvedValue([ROW]),
    count: jest.fn().mockResolvedValue(1),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };

  // Interactive transactions run against the SAME delegates, so the guard and the insert
  // see the double. Returning the callback's value keeps `null` distinguishable from a
  // failed write.
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ bomHeader, bomItem })
  );

  const prisma = { bomHeader, bomItem, $transaction } as unknown as ConstructorParameters<
    typeof BomItemRepository
  >[0];

  return { repository: new BomItemRepository(prisma), bomHeader, bomItem, $transaction };
}

describe('BomItemRepository.create', () => {
  it('guards the header INSIDE a transaction, stamps the tenant and the BOM', async () => {
    const { repository, bomHeader, bomItem, $transaction } = build();

    const row = await repository.create(
      TENANT,
      BOM_ID,
      CREATE_INPUT as Parameters<BomItemRepository['create']>[2]
    );

    expect($transaction).toHaveBeenCalledTimes(1);
    // The guard runs FIRST and carries the tenant, the BOM and the DRAFT predicate — so a
    // BOM that has already been submitted cannot gain an item, atomically.
    expect(bomHeader.updateMany).toHaveBeenCalledWith({
      where: { id: BOM_ID, tenantId: TENANT, status: 'DRAFT' },
      data: { updatedAt: expect.any(Date) },
    });
    const data = bomItem.create.mock.calls[0][0].data;
    expect({ tenantId: data.tenantId, bomId: data.bomId }).toEqual({
      tenantId: TENANT,
      bomId: BOM_ID,
    });
    expect(row).toBe(ROW);
  });

  it('inserts NOTHING when the guard matches no editable header', async () => {
    const { repository, bomHeader, bomItem } = build();
    bomHeader.updateMany.mockResolvedValue({ count: 0 });

    expect(
      await repository.create(
        TENANT,
        BOM_ID,
        CREATE_INPUT as Parameters<BomItemRepository['create']>[2]
      )
    ).toBeNull();
    expect(bomItem.create).not.toHaveBeenCalled();
  });

  it('writes no deferred standard code and no derived coefficient', async () => {
    const { repository, bomItem } = build();

    await repository.create(
      TENANT,
      BOM_ID,
      CREATE_INPUT as Parameters<BomItemRepository['create']>[2]
    );

    const data = bomItem.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      'bomId',
      'drawingConsumptionCoefficient',
      'material',
      'measurementUnit',
      'partName',
      'partType',
      'productTreeRef',
      'projectRef',
      'spareConsumptionCoefficient',
      'tenantId',
    ]);
  });
});

describe('BomItemRepository reads', () => {
  it('scopes a single row by tenant + bomId + id, never by id alone', async () => {
    const { repository, bomItem } = build();

    await repository.findById(TENANT, BOM_ID, ITEM_ID);

    expect(bomItem.findFirst).toHaveBeenCalledWith({
      where: { id: ITEM_ID, tenantId: TENANT, bomId: BOM_ID },
    });
    expect(bomItem.findFirst).toHaveBeenCalledTimes(1);
  });

  it('counts with the SAME predicate as the page, and orders by insertion', async () => {
    const { repository, bomItem } = build();

    const { items, total } = await repository.list(TENANT, BOM_ID, {
      skip: 10,
      take: 5,
      search: 'Brack',
    });

    const call = bomItem.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      tenantId: TENANT,
      bomId: BOM_ID,
      partName: { contains: 'Brack' },
    });
    expect(call.skip).toBe(10);
    expect(call.take).toBe(5);
    expect(call.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(bomItem.count).toHaveBeenCalledWith({ where: call.where });
    expect({ items: items.length, total }).toEqual({ items: 1, total: 1 });
  });

  it('drops the search clause entirely when none is stated', async () => {
    const { repository, bomItem } = build();

    await repository.list(TENANT, BOM_ID, { skip: 0, take: 20 });

    expect(bomItem.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      bomId: BOM_ID,
    });
  });
});

describe('BomItemRepository conditional writes', () => {
  it('puts tenant + BOM + the PARENT DRAFT predicate inside an update', async () => {
    const { repository, bomItem } = build();

    const row = await repository.updateDraft(TENANT, BOM_ID, ITEM_ID, { partName: 'v2' });

    expect(bomItem.updateMany).toHaveBeenCalledWith({
      where: { id: ITEM_ID, tenantId: TENANT, bomId: BOM_ID, bom: { status: 'DRAFT' } },
      data: { partName: 'v2' },
    });
    // It re-reads the row it just wrote, so the caller gets the stored value back.
    expect(bomItem.findFirst).toHaveBeenCalledWith({
      where: { id: ITEM_ID, tenantId: TENANT, bomId: BOM_ID },
    });
    expect(row).toBe(ROW);
  });

  it('returns null WITHOUT re-reading when the conditional update lost', async () => {
    const { repository, bomItem } = build();
    bomItem.updateMany.mockResolvedValue({ count: 0 });

    expect(await repository.updateDraft(TENANT, BOM_ID, ITEM_ID, { partName: 'v2' })).toBeNull();
    expect(bomItem.findFirst).not.toHaveBeenCalled();
  });

  it('carries the same predicate into a delete, and reports the match', async () => {
    const { repository, bomItem } = build();

    expect(await repository.deleteDraft(TENANT, BOM_ID, ITEM_ID)).toBe(true);
    expect(bomItem.deleteMany).toHaveBeenCalledWith({
      where: { id: ITEM_ID, tenantId: TENANT, bomId: BOM_ID, bom: { status: 'DRAFT' } },
    });

    bomItem.deleteMany.mockResolvedValue({ count: 0 });
    expect(await repository.deleteDraft(TENANT, BOM_ID, ITEM_ID)).toBe(false);
  });

  it("counts a BOM's items under the tenant + BOM scope only", async () => {
    const { repository, bomItem } = build();

    expect(await repository.countForBom(TENANT, BOM_ID)).toBe(1);
    expect(bomItem.count).toHaveBeenCalledWith({ where: { tenantId: TENANT, bomId: BOM_ID } });
  });
});

describe('BomItemRepository source: the invariants a type-checker cannot catch', () => {
  const source = readFileSync(join(__dirname, 'bom-item.repository.ts'), 'utf8');

  it('never uses findUnique — it cannot carry a tenant predicate', () => {
    expect(source).not.toMatch(/\.findUnique\s*\(/);
  });

  it('never writes the deferred standard code or a legacy derived column', () => {
    // `standardPartCode` may be MENTIONED in prose (to say why it is never written), so the
    // scan is over the same comment-stripped code the isolation suite uses.
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('*/')
        );
      })
      .join('\n');

    expect(code).not.toContain('standardPartCode');
    expect(code).not.toMatch(/legacyConsumption\w+\s*:/);
    expect(code).not.toMatch(/CREATE SEQUENCE|nextval\(/i);
  });

  it('issues no cross-database query and names no other owner', () => {
    for (const owner of ['commerce', 'core', 'hr', 'cms', 'correspondence']) {
      expect({ owner, named: source.includes(`generated/${owner}-client`) }).toEqual({
        owner,
        named: false,
      });
    }
    expect(source).not.toMatch(/\$queryRaw|\$executeRaw/);
  });
});

