import { BadRequestException, ConflictException } from '@nestjs/common';
import { StockService, DuplicatePostingError, InsufficientStockError } from './stock.service';
import type { InventoryActor } from '../inventory-actor';

/**
 * Phase W1: the stock rules, proven against the service's REAL orchestration —
 * a faked repository and audit spy, the house pattern. The important answers:
 * idempotency translates P2002 to 409, the guarded decrement refuses over-issue,
 * a transfer never touches the destination before dispatch, and tracking
 * policies are enforced.
 */

const actor: InventoryActor = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const ITEM = {
  id: 'item-1',
  tenantId: 'tenant-1',
  sku: 'SKU-1',
  name: 'Bolt M8',
  description: null,
  itemType: 'STOCKED' as const,
  baseUnit: 'عدد',
  trackingMode: 'NONE' as const,
  expiryTracked: false,
  status: 'ACTIVE' as const,
  createdByUserId: 'u',
  updatedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  units: [],
};

const WAREHOUSE = {
  id: 'wh-1',
  tenantId: 'tenant-1',
  code: 'WH-01',
  name: 'Main',
  description: null,
  address: null,
  status: 'ACTIVE' as const,
  createdByUserId: 'u',
  updatedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  locations: [],
  movements: [],
  balances: [],
  outboundTransfers: [],
  inboundTransfers: [],
  issues: [],
  adjustments: [],
  counts: [],
};

function p2002(): Error {
  return Object.assign(new Error('unique violation'), { code: 'P2002' });
}

function makeDeps() {
  const stock = {
    findMovement: jest.fn(),
    listMovements: jest.fn(),
    listBalances: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    findBalance: jest.fn().mockResolvedValue(null),
    ledgerSums: jest.fn().mockResolvedValue([]),
    listAllBalances: jest.fn().mockResolvedValue([]),
    appendMovement: jest.fn().mockImplementation((_tx, data) =>
      Promise.resolve({ id: `mov-${data.kind}`, ...data, postedAt: new Date(), createdAt: new Date() })
    ),
    addToBalance: jest.fn().mockResolvedValue({}),
    subtractFromBalance: jest.fn().mockResolvedValue({ count: 1 }),
    subtractBlockedFromBalance: jest.fn(),
    createTransfer: jest.fn().mockImplementation((_t, data) =>
      Promise.resolve({ id: 'transfer-1', tenantId: 'tenant-1', status: 'DRAFT', ...data, createdAt: new Date(), updatedAt: new Date() })
    ),
    findTransfer: jest.fn(),
    listTransfers: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    setTransferStatus: jest.fn().mockResolvedValue({ count: 1 }),
    createIssue: jest.fn().mockImplementation((_t, data) => Promise.resolve({ id: 'issue-1', ...data, createdAt: new Date() })),
    listIssues: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    createAdjustment: jest.fn().mockImplementation((_t, data) => Promise.resolve({ id: 'adj-1', ...data, createdAt: new Date() })),
    listAdjustments: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    createCount: jest.fn(),
    findCount: jest.fn(),
    listCounts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    enterCounted: jest.fn().mockResolvedValue({ count: 1 }),
    markCountLinePosted: jest.fn().mockResolvedValue({ count: 1 }),
    setCountStatus: jest.fn().mockResolvedValue({ count: 1 }),
    linkIssueMovement: jest.fn().mockResolvedValue({ count: 1 }),
    linkAdjustmentMovement: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const items = {
    findById: jest.fn().mockResolvedValue(ITEM),
    findBySku: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    setStatus: jest.fn(),
    addUnit: jest.fn(),
    findUnit: jest.fn().mockResolvedValue(null),
  };
  const warehouses = {
    findById: jest.fn().mockResolvedValue(WAREHOUSE),
    findByCode: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    setStatus: jest.fn(),
    hasStock: jest.fn().mockResolvedValue(false),
    hasOpenTransfer: jest.fn().mockResolvedValue(false),
    listLocations: jest.fn(),
    findLocation: jest.fn(),
    findLocationByCode: jest.fn(),
    findLocationInWarehouse: jest.fn(),
    createLocation: jest.fn(),
    updateLocation: jest.fn(),
    locationHasStock: jest.fn().mockResolvedValue(false),
  };
  const uow = {
    run: jest.fn().mockImplementation(async (work: (tx: object) => Promise<unknown>) => work({})),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new StockService(
    stock as never,
    items as never,
    warehouses as never,
    uow as never,
    audit as never
  );
  return { service, stock, items, warehouses, uow, audit };
}

describe('StockService — receipts', () => {
  it('posts a receipt as a ledger row plus a balance increment inside one unit of work', async () => {
    const { service, stock, audit } = makeDeps();
    const movement = await service.postReceipt(actor, {
      itemId: 'item-1',
      warehouseId: 'wh-1',
      quantity: 10,
      unit: 'عدد',
      sourceType: 'commerce.receipt',
      sourceId: 'receipt-9',
    });
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'RECEIPT',
        sourceType: 'commerce.receipt',
        sourceId: 'receipt-9',
        baseQuantity: '10.0000',
      })
    );
    expect(stock.addToBalance).toHaveBeenCalledWith(expect.anything(), expect.anything(), '10.0000');
    expect(audit.record).toHaveBeenCalled();
    expect(movement.kind).toBe('RECEIPT');
  });

  it('translates a duplicate posting attempt into a 409, never a second movement', async () => {
    const { service, stock } = makeDeps();
    stock.appendMovement.mockRejectedValueOnce(p2002());
    await expect(
      service.postReceipt(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 10,
        unit: 'عدد',
        sourceType: 'commerce.receipt',
        sourceId: 'receipt-9',
      })
    ).rejects.toBeInstanceOf(DuplicatePostingError);
  });

  it('refuses an undeclared unit — never silently reinterprets it', async () => {
    const { service, items } = makeDeps();
    items.findUnit.mockResolvedValueOnce(null);
    await expect(
      service.postReceipt(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 2,
        unit: 'کارتن',
        sourceType: 'commerce.receipt',
        sourceId: 'receipt-1',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(items.findUnit).toHaveBeenCalledWith('tenant-1', 'item-1', 'کارتن');
  });

  it('converts through the declared ratio into base quantity', async () => {
    const { service, stock, items } = makeDeps();
    items.findUnit.mockResolvedValueOnce({ ratioToBase: '12' });
    await service.postReceipt(actor, {
      itemId: 'item-1',
      warehouseId: 'wh-1',
      quantity: 2,
      unit: 'کارتن',
      sourceType: 'commerce.receipt',
      sourceId: 'receipt-2',
    });
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseQuantity: '24.0000' })
    );
  });

  it('refuses a NON_STOCKED item outright', async () => {
    const { service, items } = makeDeps();
    items.findById.mockResolvedValueOnce({ ...ITEM, itemType: 'NON_STOCKED' });
    await expect(
      service.postReceipt(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 1,
        unit: 'عدد',
        sourceType: 'x',
        sourceId: 'y',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces lot tracking', async () => {
    const { service, items } = makeDeps();
    items.findById.mockResolvedValueOnce({ ...ITEM, trackingMode: 'LOT' });
    await expect(
      service.postReceipt(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 1,
        unit: 'عدد',
        sourceType: 'x',
        sourceId: 'y',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces serial tracking with quantity exactly one', async () => {
    const { service, items } = makeDeps();
    items.findById.mockResolvedValueOnce({ ...ITEM, trackingMode: 'SERIAL' });
    await expect(
      service.postReceipt(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 5,
        unit: 'عدد',
        serialNumber: 'SN-1',
        sourceType: 'x',
        sourceId: 'y',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StockService — issues', () => {
  it('refuses an over-issue when the guarded decrement finds no stock', async () => {
    const { service, stock } = makeDeps();
    stock.subtractFromBalance.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.createIssue(actor, {
        itemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: 100,
        unit: 'عدد',
        issuedTo: 'تولید',
      })
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('posts a NEGATIVE quantity ledger row and links the issue to it', async () => {
    const { service, stock } = makeDeps();
    await service.createIssue(actor, {
      itemId: 'item-1',
      warehouseId: 'wh-1',
      quantity: 3,
      unit: 'عدد',
      issuedTo: 'تولید',
    });
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'ISSUE', quantity: '-3.0000', sourceType: 'inventory.issue' })
    );
    expect(stock.linkIssueMovement).toHaveBeenCalled();
  });
});

describe('StockService — transfers', () => {
  it('does not touch destination stock at creation', async () => {
    const { service, stock } = makeDeps();
    await service.createTransfer(actor, {
      itemId: 'item-1',
      fromWarehouseId: 'wh-1',
      toWarehouseId: 'wh-2',
      quantity: 5,
      unit: 'عدد',
    });
    expect(stock.addToBalance).not.toHaveBeenCalled();
    expect(stock.appendMovement).not.toHaveBeenCalled();
  });

  it('dispatch decrements the source, posts TRANSFER_OUT and flips status in one tx', async () => {
    const { service, stock } = makeDeps();
    stock.findTransfer.mockResolvedValueOnce({
      id: 'transfer-1',
      status: 'DRAFT',
      itemId: 'item-1',
      quantity: '5',
      baseQuantity: '5',
      unit: 'عدد',
      fromWarehouseId: 'wh-1',
      fromLocationId: '',
      toWarehouseId: 'wh-2',
      toLocationId: '',
      lotNumber: null,
      serialNumber: null,
      note: null,
    });
    const result = await service.dispatchTransfer(actor, 'transfer-1');
    expect(stock.subtractFromBalance).toHaveBeenCalled();
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'TRANSFER_OUT', sourceId: 'transfer-1' })
    );
    expect(stock.setTransferStatus).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'transfer-1',
      'DRAFT',
      expect.objectContaining({ status: 'DISPATCHED' })
    );
    expect(result.status).toBe('DISPATCHED');
  });

  it('receive posts TRANSFER_IN and increments the destination', async () => {
    const { service, stock } = makeDeps();
    stock.findTransfer.mockResolvedValueOnce({
      id: 'transfer-1',
      status: 'DISPATCHED',
      itemId: 'item-1',
      quantity: '5',
      baseQuantity: '5',
      unit: 'عدد',
      fromWarehouseId: 'wh-1',
      fromLocationId: '',
      toWarehouseId: 'wh-2',
      toLocationId: '',
      lotNumber: null,
      serialNumber: null,
      note: null,
    });
    const result = await service.receiveTransfer(actor, 'transfer-1');
    expect(stock.addToBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouseId: 'wh-2' }),
      '5'
    );
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'TRANSFER_IN' })
    );
    expect(result.status).toBe('RECEIVED');
  });

  it('refuses to cancel an in-transit transfer — the stock is physically moving', async () => {
    const { service, stock } = makeDeps();
    stock.findTransfer.mockResolvedValueOnce({ id: 't1', status: 'DISPATCHED' });
    await expect(service.cancelTransfer(actor, 't1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('StockService — reversals and counts', () => {
  it('a reversal posts a compensating row, never edits the original', async () => {
    const { service, stock } = makeDeps();
    stock.findMovement.mockResolvedValueOnce({
      id: 'mov-1',
      kind: 'RECEIPT',
      itemId: 'item-1',
      warehouseId: 'wh-1',
      locationId: '',
      quantity: '10',
      baseQuantity: '10',
      unit: 'عدد',
      lotNumber: null,
      serialNumber: null,
      expiryDate: null,
    });
    await service.reverseMovement(actor, 'mov-1');
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'REVERSAL',
        reversesMovementId: 'mov-1',
        quantity: '-10.0000',
      })
    );
    expect(stock.subtractFromBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouseId: 'wh-1' }),
      '10.0000'
    );
  });

  it('a REVERSAL row is not itself reversible', async () => {
    const { service, stock } = makeDeps();
    stock.findMovement.mockResolvedValueOnce({ id: 'm2', kind: 'REVERSAL' });
    await expect(service.reverseMovement(actor, 'm2')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('posts only non-zero variances and flips the count OPEN→POSTED guarded', async () => {
    const { service, stock } = makeDeps();
    stock.findCount.mockResolvedValue({
      id: 'count-1',
      tenantId: 'tenant-1',
      warehouseId: 'wh-1',
      status: 'OPEN',
      lines: [
        { id: 'l1', itemId: 'item-1', locationId: '', expectedQty: '10', countedQty: '8', variance: '-2.0000', movementId: null, item: ITEM },
        { id: 'l2', itemId: 'item-2', locationId: '', expectedQty: '5', countedQty: '5', variance: '0', movementId: null, item: ITEM },
      ],
    });
    await service.postCount(actor, 'count-1');
    expect(stock.appendMovement).toHaveBeenCalledTimes(1);
    expect(stock.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'COUNT_VARIANCE', quantity: '-2.0000' })
    );
    expect(stock.setCountStatus).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'count-1',
      'OPEN',
      expect.objectContaining({ status: 'POSTED' })
    );
  });

  it('refuses to post a count with uncounted lines', async () => {
    const { service, stock } = makeDeps();
    stock.findCount.mockResolvedValueOnce({
      id: 'count-1',
      status: 'OPEN',
      warehouseId: 'wh-1',
      lines: [{ id: 'l1', countedQty: null }],
    });
    await expect(service.postCount(actor, 'count-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StockService — reconciliation and availability', () => {
  it('available = onHand - reserved - blocked, computed server-side', async () => {
    const { service, stock } = makeDeps();
    stock.listBalances.mockResolvedValueOnce({
      items: [
        {
          tenantId: 'tenant-1',
          itemId: 'item-1',
          warehouseId: 'wh-1',
          locationId: '',
          onHand: '10',
          reserved: '2',
          blocked: '1',
          updatedAt: new Date(),
        },
      ],
      total: 1,
    });
    const result = await service.listBalances(actor, {}, 1, 50);
    expect(result.items[0].available).toBe('7.0000');
  });

  it('reconciliation reports drift honestly', async () => {
    const { service, stock } = makeDeps();
    stock.ledgerSums.mockResolvedValueOnce([
      { itemId: 'item-1', warehouseId: 'wh-1', locationId: '', sum: '10' },
    ]);
    stock.listAllBalances.mockResolvedValueOnce([
      {
        tenantId: 'tenant-1',
        itemId: 'item-1',
        warehouseId: 'wh-1',
        locationId: '',
        onHand: '9',
        reserved: '0',
        blocked: '0',
        updatedAt: new Date(),
      },
    ]);
    const result = await service.reconcile(actor);
    expect(result.balanced).toBe(0);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].drift).toBe('-1.0000');
  });
});
