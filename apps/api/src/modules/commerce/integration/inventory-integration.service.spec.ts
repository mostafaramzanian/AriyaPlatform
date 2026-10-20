import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DuplicatePostingError } from '../../inventory/stock/stock.service';
import { CommerceActor } from '../commerce-actor';
import type { CommerceTransactionHandle } from '../database/commerce-transaction';
import {
  InventoryIntegrationService,
  POSTING_KIND,
  type InventoryPostingRow,
} from './inventory-integration.service';
import type { InventoryPostingRepository } from './inventory-posting.repository';
import type { InventoryPostingPort } from './inventory-posting.port';

/**
 * Phase W2-B: the integration service, with the repository faked and the
 * Inventory port a recorded spy — every assertion is about a DECISION, not a
 * database: which lines plan a posting, what a plan inherits, how an attempt
 * maps each port outcome onto the durable row, and why a retry is safe.
 */

const TENANT = 'tenant-1';
const ACTOR: CommerceActor = {
  tenantId: TENANT,
  userId: 'u1',
  requestId: 'r1',
  ip: null,
  userAgent: null,
} as CommerceActor;
const TX = {} as CommerceTransactionHandle;

const RECEIPT_LINE_ID = '11111111-1111-4111-8111-111111111111';
const PURCHASE_LINE_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN_RECEIPT_LINE_ID = '33333333-3333-4333-8333-333333333333';
const RETURN_LINE_ID = '44444444-4444-4444-8444-444444444444';
const WAREHOUSE_ID = '55555555-5555-4555-8555-555555555555';
const ITEM_ID = '66666666-6666-4666-8666-666666666666';
const POSTING_ID = '77777777-7777-4777-8777-777777777777';
const MOVEMENT_ID = '88888888-8888-4888-8888-888888888888';

function build() {
  const postings = {
    plan: jest.fn().mockResolvedValue(POSTING_ID),
    findPostedForSourceLine: jest.fn(),
    findById: jest.fn(),
    listForSourceLines: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordResolvedItem: jest.fn().mockResolvedValue(undefined),
  };
  const port = {
    resolveItemBySku: jest.fn().mockResolvedValue({ id: ITEM_ID }),
    postReceiptPosting: jest.fn().mockResolvedValue({ id: MOVEMENT_ID }),
    postOutboundPosting: jest.fn().mockResolvedValue({ id: MOVEMENT_ID }),
  };
  const notification = { notifyUsers: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new InventoryIntegrationService(
      postings as unknown as InventoryPostingRepository,
      port as unknown as InventoryPostingPort,
      notification as never
    ),
    postings,
    port,
    notification,
  };
}

function posting(over: Partial<InventoryPostingRow> = {}): InventoryPostingRow & {
  status: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  movementId: string | null;
} {
  return {
    id: POSTING_ID,
    kind: POSTING_KIND.RECEIPT,
    sourceLineId: RECEIPT_LINE_ID,
    purchaseLineId: PURCHASE_LINE_ID,
    itemRef: 'SKU-1',
    itemId: null,
    warehouseId: WAREHOUSE_ID,
    locationId: '',
    quantity: '10.0000',
    unit: 'PCS',
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    movementId: null,
    ...over,
  };
}

describe('Phase W2-B — planning: which lines owe the ledger a posting', () => {
  it('plans one RECEIPT posting per stocked receipt line, with the stated cell', async () => {
    const { service, postings } = build();
    const ids = await service.planReceiptPostings(
      TX,
      TENANT,
      [{ id: RECEIPT_LINE_ID, purchaseLineId: PURCHASE_LINE_ID, quantity: '10.0000' }],
      [{ id: PURCHASE_LINE_ID, itemReference: 'SKU-1', unit: 'PCS' }],
      [{ purchaseLineId: PURCHASE_LINE_ID, warehouseId: WAREHOUSE_ID, locationId: 'loc-1' }]
    );
    expect(ids).toEqual([POSTING_ID]);
    expect(postings.plan).toHaveBeenCalledWith(TENANT, TX, {
      kind: 'RECEIPT',
      sourceLineId: RECEIPT_LINE_ID,
      purchaseLineId: PURCHASE_LINE_ID,
      itemRef: 'SKU-1',
      warehouseId: WAREHOUSE_ID,
      locationId: 'loc-1',
      quantity: '10.0000',
      unit: 'PCS',
    });
  });

  it('plans nothing for a non-stocked line (no itemReference)', async () => {
    const { service, postings } = build();
    const ids = await service.planReceiptPostings(
      TX,
      TENANT,
      [{ id: RECEIPT_LINE_ID, purchaseLineId: PURCHASE_LINE_ID, quantity: '10.0000' }],
      [{ id: PURCHASE_LINE_ID, itemReference: null, unit: 'DAY' }],
      [{ purchaseLineId: PURCHASE_LINE_ID }]
    );
    expect(ids).toEqual([]);
    expect(postings.plan).not.toHaveBeenCalled();
  });

  it('refuses a stocked line with no warehouseId — 400, atomically', async () => {
    const { service, postings } = build();
    await expect(
      service.planReceiptPostings(
        TX,
        TENANT,
        [{ id: RECEIPT_LINE_ID, purchaseLineId: PURCHASE_LINE_ID, quantity: '10.0000' }],
        [{ id: PURCHASE_LINE_ID, itemReference: 'SKU-1', unit: 'PCS' }],
        [{ purchaseLineId: PURCHASE_LINE_ID }]
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postings.plan).not.toHaveBeenCalled();
  });

  it('plans a RECEIPT_COMPENSATION only when the origin posting is POSTED — and inherits its cell', async () => {
    const { service, postings } = build();
    postings.findPostedForSourceLine.mockResolvedValue({
      itemRef: 'SKU-1',
      warehouseId: WAREHOUSE_ID,
      locationId: 'loc-9',
      unit: 'PCS',
    });
    const ids = await service.planCompensationPosting(
      TX,
      TENANT,
      { id: 'cmp-1', purchaseLineId: PURCHASE_LINE_ID, quantity: '-3.0000' },
      ORIGIN_RECEIPT_LINE_ID
    );
    expect(postings.findPostedForSourceLine).toHaveBeenCalledWith(
      TENANT,
      'RECEIPT',
      ORIGIN_RECEIPT_LINE_ID,
      TX
    );
    expect(postings.plan).toHaveBeenCalledWith(
      TENANT,
      TX,
      expect.objectContaining({
        kind: 'RECEIPT_COMPENSATION',
        sourceLineId: 'cmp-1',
        quantity: '3.0000', // magnitude, not the negative stored quantity
        warehouseId: WAREHOUSE_ID,
        locationId: 'loc-9',
      })
    );
    expect(ids).toEqual([POSTING_ID]);
  });

  it('plans no compensation posting when the origin never reached the ledger', async () => {
    const { service, postings } = build();
    postings.findPostedForSourceLine.mockResolvedValue(null);
    const ids = await service.planCompensationPosting(
      TX,
      TENANT,
      { id: 'cmp-1', purchaseLineId: PURCHASE_LINE_ID, quantity: '-3.0000' },
      ORIGIN_RECEIPT_LINE_ID
    );
    expect(ids).toEqual([]);
    expect(postings.plan).not.toHaveBeenCalled();
  });

  it('plans a RETURN_DISPATCH per line with a POSTED origin — cell inherited', async () => {
    const { service, postings } = build();
    postings.findPostedForSourceLine
      .mockResolvedValueOnce({
        itemRef: 'SKU-1',
        warehouseId: WAREHOUSE_ID,
        locationId: '',
        unit: 'KG',
      })
      .mockResolvedValueOnce(null); // second line's origin never posted
    const ids = await service.planReturnDispatchPostings(TX, TENANT, [
      {
        id: RETURN_LINE_ID,
        purchaseLineId: PURCHASE_LINE_ID,
        receiptLineId: ORIGIN_RECEIPT_LINE_ID,
        quantity: '2.0000',
      },
      {
        id: 'ret-2',
        purchaseLineId: PURCHASE_LINE_ID,
        receiptLineId: '55555555-5555-4555-8555-555555555556',
        quantity: '1.0000',
      },
    ]);
    expect(ids).toEqual([POSTING_ID]);
    expect(postings.plan).toHaveBeenCalledTimes(1);
    expect(postings.plan).toHaveBeenCalledWith(
      TENANT,
      TX,
      expect.objectContaining({
        kind: 'RETURN_DISPATCH',
        sourceLineId: RETURN_LINE_ID,
        quantity: '2.0000',
        unit: 'KG',
      })
    );
  });
});

describe('Phase W2-B — attempting: the port outcome lands on the durable row', () => {
  it('resolves the SKU, posts the receipt, marks POSTED with the movement id', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(posting());
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(port.resolveItemBySku).toHaveBeenCalledWith(TENANT, 'SKU-1');
    expect(postings.recordResolvedItem).toHaveBeenCalledWith(TENANT, POSTING_ID, ITEM_ID);
    expect(port.postReceiptPosting).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        userId: 'u1',
        itemId: ITEM_ID,
        warehouseId: WAREHOUSE_ID,
        quantity: 10,
        unit: 'PCS',
        sourceId: RECEIPT_LINE_ID,
      })
    );
    expect(postings.recordOutcome).toHaveBeenCalledWith(
      TENANT,
      POSTING_ID,
      expect.objectContaining({ result: 'POSTED', status: 'POSTED', movementId: MOVEMENT_ID })
    );
  });

  it('maps RETURN_DISPATCH to a SUPPLIER_RETURN outbound with the commerce source ref', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(
      posting({ kind: POSTING_KIND.RETURN_DISPATCH, sourceLineId: RETURN_LINE_ID })
    );
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(port.postOutboundPosting).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'SUPPLIER_RETURN',
        sourceType: 'commerce.return-line',
        sourceId: RETURN_LINE_ID,
      })
    );
  });

  it('marks FAILED with the verbatim reason when the SKU resolves to nothing', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(posting());
    port.resolveItemBySku.mockResolvedValue(null);
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(port.postReceiptPosting).not.toHaveBeenCalled();
    expect(postings.recordOutcome).toHaveBeenCalledWith(
      TENANT,
      POSTING_ID,
      expect.objectContaining({ result: 'FAILED', status: 'FAILED', error: expect.stringContaining('SKU-1') })
    );
  });

  it('reads a ledger duplicate as POSTED — never as a second movement', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(posting());
    port.postReceiptPosting.mockRejectedValue(
      new DuplicatePostingError('commerce.receipt', RECEIPT_LINE_ID, 'RECEIPT')
    );
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(postings.recordOutcome).toHaveBeenCalledWith(
      TENANT,
      POSTING_ID,
      expect.objectContaining({ result: 'POSTED_DUPLICATE', status: 'POSTED', movementId: null })
    );
  });

  it('marks FAILED verbatim on any other refusal — and never throws', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(posting());
    port.postReceiptPosting.mockRejectedValue(
      new ConflictException('Unit "PCS" is not declared for item SKU-1')
    );
    await expect(service.attemptPostings(ACTOR, [POSTING_ID])).resolves.toBeUndefined();
    expect(postings.recordOutcome).toHaveBeenCalledWith(
      TENANT,
      POSTING_ID,
      expect.objectContaining({ result: 'FAILED', status: 'FAILED', error: expect.stringContaining('not declared') })
    );
  });

  it('skips a row that is already POSTED — retry is a no-op, not a repost', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(posting({ status: 'POSTED' }));
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(port.resolveItemBySku).not.toHaveBeenCalled();
    expect(port.postReceiptPosting).not.toHaveBeenCalled();
  });
});

describe('Phase W2-B — the operational surface: queue read and retry', () => {
  it('lists the tenant queue, forwarding the status filter', async () => {
    const { service, postings } = build();
    postings.list.mockResolvedValue([posting()]);
    const view = await service.list(ACTOR, 'FAILED');
    expect(postings.list).toHaveBeenCalledWith(TENANT, { status: 'FAILED', limit: 500 });
    expect(view.postings).toHaveLength(1);
    expect(view.postings[0]).toMatchObject({ status: 'PENDING', kind: 'RECEIPT' });
  });

  it('retry is 404 for absent/foreign postings and idempotent on POSTED ones', async () => {
    const { service, postings, port } = build();
    postings.findById.mockResolvedValue(null);
    await expect(service.retry(ACTOR, POSTING_ID)).rejects.toBeInstanceOf(NotFoundException);

    const posted = posting({ status: 'POSTED' });
    postings.findById.mockResolvedValue(posted);
    const view = await service.retry(ACTOR, POSTING_ID);
    expect(port.postReceiptPosting).not.toHaveBeenCalled();
    expect(view.status).toBe('POSTED');
  });

  it('retry re-attempts a FAILED posting through the port', async () => {
    const { service, postings, port } = build();
    const failed = { ...posting({ status: 'FAILED' }), attempts: 1 };
    postings.findById
      .mockResolvedValueOnce(failed) // the retry read
      .mockResolvedValueOnce({ ...failed, status: 'POSTED' }); // the fresh view read
    const view = await service.retry(ACTOR, POSTING_ID);
    expect(port.postReceiptPosting).toHaveBeenCalledTimes(1);
    expect(view.status).toBe('POSTED');
  });
});

describe('Phase W2-C (GAP-H) — the first-failure operator notification', () => {
  it('notifies the acting user exactly once when a posting first fails', async () => {
    const { service, postings, port, notification } = build();
    port.resolveItemBySku.mockResolvedValue(null); // permanent mapping refusal
    postings.findById
      .mockResolvedValueOnce(posting()) // the attempt read
      .mockResolvedValueOnce({ ...posting({ status: 'FAILED' }), attempts: 1 }); // the post-attempt read

    await service.attemptPostings(ACTOR, [POSTING_ID]);

    expect(notification.notifyUsers).toHaveBeenCalledTimes(1);
    expect(notification.notifyUsers).toHaveBeenCalledWith(
      ACTOR,
      ['u1'],
      expect.objectContaining({
        sourceType: 'commerce.inventory-posting',
        sourceId: POSTING_ID,
      })
    );
  });

  it('stays silent on a posting that fails PAST its first attempt — retries are not noisy', async () => {
    const { service, postings, port, notification } = build();
    port.resolveItemBySku.mockResolvedValue(null);
    postings.findById
      .mockResolvedValueOnce({ ...posting({ status: 'FAILED' }), attempts: 2 })
      .mockResolvedValueOnce({ ...posting({ status: 'FAILED' }), attempts: 3 });

    await service.attemptPostings(ACTOR, [POSTING_ID]);

    expect(notification.notifyUsers).not.toHaveBeenCalled();
  });

  it('stays silent when the posting lands POSTED', async () => {
    const { service, postings, notification } = build();
    postings.findById.mockResolvedValue(posting()); // PENDING then PENDING→POSTED path
    await service.attemptPostings(ACTOR, [POSTING_ID]);
    expect(notification.notifyUsers).not.toHaveBeenCalled();
  });
});
