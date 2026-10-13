import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  BomItemService,
  PRODUCTION_BOM_ITEM_AUDIT_ACTION,
  toBomItemView,
} from './bom-item.service';
import type { BomItemRecord, BomItemRepository } from './bom-item.repository';
import type { BomHeaderRecord, BomHeaderRepository } from './bom.repository';
import type { ProductionAuditGateway } from '../production-audit.gateway';
import type { ProductionActor } from '../production-actor';
import { PRODUCTION_BOM_ERROR_CODES, isValidConsumptionCoefficient } from './bom-item';
import * as BomItemVocabulary from './bom-item';
import type { CreateBomItemDto, UpdateBomItemDto } from './bom-item.dto';

/**
 * Phase PRODUCTION-BOM-ITEM: the child slice's application surface.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. TENANT AND BOM SCOPE TOGETHER. Every call reaches the repositories with the ACTOR's
 *     tenant as the first argument and the PATH's `bomId` as the second; a BOM that is not
 *     this tenant's is a 404 indistinguishable from one that does not exist, and an item
 *     that belongs to a different BOM is a 404 too — checked on the ARGUMENTS actually
 *     passed, not on a comment.
 *  2. THE SCOPE SNAPSHOT COMES FROM THE HEADER, NEVER FROM THE BODY. `projectRef` and
 *     `productTreeRef` are copied off the header this request already resolved, so no
 *     payload can place an item under another project.
 *  3. THE STATE GUARD IS THE HEADER'S OWN PREDICATE. create / update / delete all refuse a
 *     non-DRAFT BOM with `BOM_HEADER_NOT_EDITABLE`, and none of them reaches a write.
 *  4. THE TWO COEFFICIENTS ARE THE ONLY COEFFICIENT RULE: integer, `>= 0`. A fraction, a
 *     negative or a non-number is a 400 carrying `BOM_ITEM_COEFFICIENT_INVALID`, and no
 *     total is ever computed.
 *  5. `standardPartCode` IS DEFERRED. It never appears in a write, and the view returns the
 *     stored value rather than minting one.
 *  6. THE TRAIL RECORDS WHAT WAS WRITTEN, and every item act carries `production.bom.item`
 *     plus the parent `bomId`, so an item's history can be joined to its header's.
 *
 * The doubles are structural: repository, header repository and audit gateway are plain
 * objects, so these specs exercise orchestration without a database, a Nest container, or
 * another owner's client.
 */

const TENANT = 'tenant-a';
const BOM_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

const ACTOR: ProductionActor = {
  tenantId: TENANT,
  userId: 'user-a',
  requestId: 'req-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

function headerRow(overrides: Partial<BomHeaderRecord> = {}): BomHeaderRecord {
  return {
    id: BOM_ID,
    tenantId: TENANT,
    title: 'BOM for project 42',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'user-requester',
    approverUserId: 'user-approver',
    status: 'DRAFT',
    managerOpinion: null,
    comments: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

/** A decimal-like stand-in: the view converts through `toString()`, never a binary float. */
const PRICE = { toString: () => '1250.50' } as unknown as BomItemRecord['suggestedSupplierPrice'];

function itemRow(overrides: Partial<BomItemRecord> = {}): BomItemRecord {
  return {
    id: ITEM_ID,
    tenantId: TENANT,
    bomId: BOM_ID,
    projectRef: '42',
    productTreeRef: '771',
    partName: 'Bracket',
    industryPartName: null,
    standardPartCode: null,
    partType: 'STRUCTURAL',
    specifications: null,
    manufacturer: null,
    material: 'Steel',
    measurementUnit: 'pcs',
    drawingConsumptionCoefficient: 2,
    spareConsumptionCoefficient: 1,
    suggestedSupplier: null,
    suggestedSupplierPrice: null,
    controlPlan: null,
    notes: null,
    legacyPartCode: null,
    legacyItemState: null,
    legacyManagerOpinion: null,
    legacyConsumptionTotalCoefficient: null,
    legacyConsumptionInDrawingOnOrder: null,
    legacyConsumptionSpareTestOnOrder: null,
    legacyConsumptionInDrawingPurchased: null,
    legacyConsumptionSpareTestPurchased: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-02T00:00:00.000Z'),
    ...overrides,
  } as BomItemRecord;
}

const CREATE_DTO: CreateBomItemDto = {
  partName: '  Bracket  ',
  partType: 'STRUCTURAL',
  material: 'Steel',
  measurementUnit: 'pcs',
  drawingConsumptionCoefficient: 2,
  spareConsumptionCoefficient: 1,
};

function build() {
  type ItemMocks = {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    updateDraft: jest.Mock;
    deleteDraft: jest.Mock;
    countForBom: jest.Mock;
  };
  const items: ItemMocks = {
    create: jest.fn().mockResolvedValue(itemRow()),
    findById: jest.fn().mockResolvedValue(itemRow()),
    list: jest.fn().mockResolvedValue({ items: [itemRow()], total: 1 }),
    updateDraft: jest.fn().mockResolvedValue(itemRow({ partName: 'Bracket v2' })),
    deleteDraft: jest.fn().mockResolvedValue(true),
    countForBom: jest.fn().mockResolvedValue(1),
  };
  const headers: { findById: jest.Mock } = {
    findById: jest.fn().mockResolvedValue(headerRow()),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined), read: jest.fn() };

  const service = new BomItemService(
    items as unknown as BomItemRepository,
    headers as unknown as BomHeaderRepository,
    audit as unknown as ProductionAuditGateway
  );
  return { service, items, headers, audit };
}

describe('BomItemService scope: the tenant AND the BOM travel with every call', () => {
  it('resolves the header by the ACTOR tenant, never by a body-supplied tenant', async () => {
    const { service, headers } = build();

    await service.list({ ...ACTOR }, BOM_ID, {});

    expect(headers.findById).toHaveBeenCalledWith(TENANT, BOM_ID);
  });

  it('404s a BOM this tenant does not hold, and reaches no item read', async () => {
    const { service, headers, items } = build();
    headers.findById.mockResolvedValue(null);

    await expect(service.list({ ...ACTOR }, BOM_ID, {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    // Fail closed: without a header there is no scope to read a child of, so an unscoped
    // item query would be a cross-tenant leak rather than an empty page.
    expect(items.list).not.toHaveBeenCalled();
  });

  it('scopes an item read by tenant + bomId + itemId, so another BOM is indistinguishable', async () => {
    const { service, items } = build();

    await service.getOne({ ...ACTOR }, BOM_ID, ITEM_ID);

    expect(items.findById).toHaveBeenCalledWith(TENANT, BOM_ID, ITEM_ID);
  });

  it('404s an item id that is not in this BOM, and audits nothing', async () => {
    const { service, items, audit } = build();
    items.findById.mockResolvedValue(null);

    await expect(
      service.getOne({ ...ACTOR }, BOM_ID, ITEM_ID)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BomItemService.create', () => {
  it('copies the project / product-tree scope from the HEADER, not from the payload', async () => {
    const { service, items, headers } = build();
    headers.findById.mockResolvedValue(headerRow({ projectRef: '42', productTreeRef: '771' }));

    const view = await service.create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO });

    const [tenant, bomId, data] = items.create.mock.calls[0];
    expect({ tenant, bomId }).toEqual({ tenant: TENANT, bomId: BOM_ID });
    expect({ projectRef: data.projectRef, productTreeRef: data.productTreeRef }).toEqual({
      projectRef: '42',
      productTreeRef: '771',
    });
    expect(view.projectRef).toBe('42');
  });

  it('trims the required text fields rather than storing the spaces the source refused', async () => {
    const { service, items } = build();

    await service.create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO });

    const data = items.create.mock.calls[0][2];
    expect(data.partName).toBe('Bracket');
    expect(data.material).toBe('Steel');
    expect(data.measurementUnit).toBe('pcs');
  });

  it('never writes standardPartCode — the Product Tree code source is BLOCKED (RB-1-P)', async () => {
    const { service, items } = build();

    await service.create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO });

    // The DTO would already refuse it (whitelist + forbidNonWhitelisted), but the assertion
    // here is on what the DOMAIN actually writes: no key, no value, no generation.
    expect(Object.keys(items.create.mock.calls[0][2])).not.toContain('standardPartCode');
  });

  it('turns a guard that lost a race into a 409 naming the CURRENT status', async () => {
    const { service, headers, items } = build();
    items.create.mockResolvedValue(null);
    headers.findById
      .mockResolvedValueOnce(headerRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(headerRow({ status: 'SUBMITTED' }));

    const error = await service
      .create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
      message: expect.stringContaining('SUBMITTED'),
    });
  });

  it('audits what was stored, on the ITEM resource, correlated to the parent BOM', async () => {
    const { service, audit } = build();

    await service.create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO });

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, act] = audit.record.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.CREATE,
      resource: 'production.bom.item',
      resourceId: ITEM_ID,
      newValue: { bomId: BOM_ID, partName: 'Bracket' },
    });
  });
});

describe('BomItemService state guard: submit freezes every item, correction thaws them', () => {
  const FROZEN: Array<'SUBMITTED' | 'APPROVED' | 'REJECTED'> = [
    'SUBMITTED',
    'APPROVED',
    'REJECTED',
  ];

  it.each(FROZEN)('refuses create / update / delete while the BOM is %s', async (status) => {
    const { items } = build();
    const headers = { findById: jest.fn().mockResolvedValue(headerRow({ status })) };
    const frozen = new BomItemService(
      items as unknown as BomItemRepository,
      headers as unknown as BomHeaderRepository,
      { record: jest.fn(), read: jest.fn() } as unknown as ProductionAuditGateway
    );

    const attempt = async (fn: () => Promise<unknown>) => {
      const error = await fn().catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
      });
    };

    await attempt(() => frozen.create({ ...ACTOR }, BOM_ID, { ...CREATE_DTO }));
    await attempt(() =>
      frozen.update({ ...ACTOR }, BOM_ID, ITEM_ID, { partName: 'x' })
    );
    await attempt(() => frozen.delete({ ...ACTOR }, BOM_ID, ITEM_ID));

    // NONE of the three may reach a write: the refusal is decided before any statement is
    // issued, which is what makes "mutation after submit denied" a property of the domain
    // rather than of the repository's WHERE clause alone.
    expect(items.create).not.toHaveBeenCalled();
    expect(items.updateDraft).not.toHaveBeenCalled();
    expect(items.deleteDraft).not.toHaveBeenCalled();
  });

  it('lets items change again once a correction returns the header to DRAFT', async () => {
    const { items } = build();
    const headers = {
      findById: jest.fn().mockResolvedValue(headerRow({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION' })),
    };
    const corrected = new BomItemService(
      items as unknown as BomItemRepository,
      headers as unknown as BomHeaderRepository,
      { record: jest.fn(), read: jest.fn() } as unknown as ProductionAuditGateway
    );

    await corrected.update({ ...ACTOR }, BOM_ID, ITEM_ID, { partName: 'Corrected' });

    expect(items.updateDraft).toHaveBeenCalledWith(TENANT, BOM_ID, ITEM_ID, {
      partName: 'Corrected',
    });
  });

  it('refuses an update that states no field, and writes nothing', async () => {
    const { service, items, audit } = build();

    const error = await service
      .update({ ...ACTOR }, BOM_ID, ITEM_ID, {} as UpdateBomItemDto)
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: PRODUCTION_BOM_ERROR_CODES.PATCH_EMPTY,
    });
    expect(items.updateDraft).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BomItemService coefficient validation — the one rule, and only the one', () => {
  const INVALID = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number];

  it.each(INVALID.map((value) => [value]))(
    'refuses %p with a typed code and writes nothing',
    async (value) => {
      const { service, items } = build();

      const error = await service
        .create({ ...ACTOR }, BOM_ID, {
          ...CREATE_DTO,
          drawingConsumptionCoefficient: value as number,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: PRODUCTION_BOM_ERROR_CODES.COEFFICIENT_INVALID,
      });
      expect(items.create).not.toHaveBeenCalled();
    }
  );

  it('accepts 0 — the only floor the source ever states is 0, and no max exists', () => {
    expect(isValidConsumptionCoefficient(0)).toBe(true);
    expect(isValidConsumptionCoefficient(2)).toBe(true);
    expect(isValidConsumptionCoefficient(-0)).toBe(true);
    // No ceiling: a large coefficient is a real number the source would have stored, and
    // inventing one would be a contract nobody signed off.
    expect(isValidConsumptionCoefficient(1_000_000)).toBe(true);
    expect(isValidConsumptionCoefficient(1.5)).toBe(false);
    expect(isValidConsumptionCoefficient(-1)).toBe(false);
    expect(isValidConsumptionCoefficient('2')).toBe(false);
  });

  it('exports no total, no sum, no counter and no code generator', () => {
    // The exact export list, so a helper named `computeTotal` (or a code counter) would
    // fail here rather than pass unnoticed: the source never derives a total, and §14
    // leaves that formula open — as it leaves the Product Tree prefix BLOCKED.
    expect(Object.keys(BomItemVocabulary).sort()).toEqual([
      'BOM_CONTROL_PLANS',
      'BOM_CONTROL_PLAN_LABELS',
      'BOM_PART_TYPES',
      'BOM_PART_TYPE_LABELS',
      'PRODUCTION_BOM_ERROR_CODES',
      'isValidConsumptionCoefficient',
    ]);
    // `Total`/`Sum` in CamelCase, not a bare substring: "Consumption" legitimately contains
    // "sum", and a rule that flagged it would be asserting on the wrong thing.
    expect(
      Object.keys(BomItemVocabulary).filter((k) => /Total|Sum|Counter|Sequence|Generate/.test(k))
    ).toEqual([]);
    const view = toBomItemView(itemRow());
    expect(Object.keys(view).filter((k) => /Total|Sum/.test(k))).toEqual([]);
  });
});

describe('BomItemService.update / .delete', () => {
  it('audits an update with the before/after pair and the fields that moved', async () => {
    const { service, items, audit } = build();
    items.findById.mockResolvedValue(itemRow({ partName: 'Bracket' }));
    items.updateDraft.mockResolvedValue(itemRow({ partName: 'Bracket v2' }));

    const view = await service.update({ ...ACTOR }, BOM_ID, ITEM_ID, {
      partName: 'Bracket v2',
      spareConsumptionCoefficient: 4,
    });

    expect(view.partName).toBe('Bracket v2');
    const [, act] = audit.record.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.UPDATE,
      resource: 'production.bom.item',
      resourceId: ITEM_ID,
      oldValue: { bomId: BOM_ID, partName: 'Bracket' },
      newValue: { bomId: BOM_ID, partName: 'Bracket v2' },
      changedFields: ['partName', 'spareConsumptionCoefficient'],
    });
  });

  it('never lets a patch carry the frozen scope or the deferred standard code', async () => {
    const { service, items } = build();
    items.findById.mockResolvedValue(itemRow());

    await service.update({ ...ACTOR }, BOM_ID, ITEM_ID, {
      partName: 'Renamed',
      projectRef: '999',
      productTreeRef: '999',
      standardPartCode: 'FORGED-001',
    } as UpdateBomItemDto);

    const patch = items.updateDraft.mock.calls[0][3];
    expect(Object.keys(patch)).toEqual(['partName']);
    expect(patch.projectRef).toBeUndefined();
    expect(patch.productTreeRef).toBeUndefined();
    expect(patch.standardPartCode).toBeUndefined();
  });

  it('reads the item BEFORE deleting it, so the trail records what existed', async () => {
    const { service, items, audit } = build();
    items.findById.mockResolvedValue(itemRow({ partName: 'Bracket' }));

    const result = await service.delete({ ...ACTOR }, BOM_ID, ITEM_ID);

    expect(result).toEqual({ id: ITEM_ID });
    expect(items.deleteDraft).toHaveBeenCalledWith(TENANT, BOM_ID, ITEM_ID);
    const [, act] = audit.record.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.DELETE,
      resource: 'production.bom.item',
      resourceId: ITEM_ID,
      oldValue: { bomId: BOM_ID, partName: 'Bracket' },
    });
  });

  it('turns a conditional delete that matched nothing into an accurate 409', async () => {
    const { service, items, audit } = build();
    items.findById.mockResolvedValue(itemRow());
    items.deleteDraft.mockResolvedValue(false);
    // Re-read still shows DRAFT: the item was gone, not the BOM — the race cannot be told
    // apart from a double delete, and neither deserves a success.
    const error = await service
      .delete({ ...ACTOR }, BOM_ID, ITEM_ID)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BomItemService.list', () => {
  it('clamps the page window and forwards tenant + BOM scope with the search filter', async () => {
    const { service, items } = build();

    const page = await service.list({ ...ACTOR }, BOM_ID, {
      page: 3,
      pageSize: 10_000,
      search: ' Bracket',
    });

    // The DTO bound refuses an absurd size at the wire; the service clamps again so an
    // internal caller building its own query object cannot exceed the ceiling either.
    expect(page.pageSize).toBe(100);
    expect(page.page).toBe(3);
    expect(items.list).toHaveBeenCalledWith(TENANT, BOM_ID, {
      skip: 200,
      take: 100,
      search: ' Bracket',
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });
});

describe('toBomItemView', () => {
  it('projects the DOMAIN half and no legacy column — no derived field, no label, no total', () => {
    const view = toBomItemView(itemRow({ suggestedSupplierPrice: PRICE }));

    expect(Object.keys(view).sort()).toEqual([
      'bomId',
      'controlPlan',
      'createdAt',
      'drawingConsumptionCoefficient',
      'id',
      'industryPartName',
      'manufacturer',
      'material',
      'measurementUnit',
      'notes',
      'partName',
      'partType',
      'productTreeRef',
      'projectRef',
      'spareConsumptionCoefficient',
      'specifications',
      'standardPartCode',
      'suggestedSupplier',
      'suggestedSupplierPrice',
      'updatedAt',
    ]);
    // The five derived coefficients, `Code_Ghatae`, the legacy `state` and the legacy
    // `NazarModir` are migration artefacts: they are stored, and deliberately not shown.
    for (const legacy of [
      'legacyPartCode',
      'legacyItemState',
      'legacyManagerOpinion',
      'legacyConsumptionTotalCoefficient',
    ]) {
      expect(view).not.toHaveProperty(legacy);
    }
    expect(view.suggestedSupplierPrice).toBe('1250.50');
    expect(view.standardPartCode).toBeNull();
  });

  it('reports the instants as ISO strings and never fabricates one', () => {
    const view = toBomItemView(itemRow());

    expect(view.createdAt).toBe('2026-02-01T00:00:00.000Z');
    expect(view.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(view.standardPartCode).toBeNull();
    expect(view.controlPlan).toBeNull();
  });
});



