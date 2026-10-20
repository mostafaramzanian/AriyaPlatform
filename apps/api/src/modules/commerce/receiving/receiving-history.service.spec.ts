import { ConflictException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle, CommerceUnitOfWork } from '../database/commerce-transaction';
import type { ReceivingHistoryRepository } from './receiving-history.repository';
import { RECEIVING_AUDIT_ACTION, ReceivingHistoryService } from './receiving-history.service';
import { projectReceivingStatus } from './receiving-status';

/**
 * Phase C1 Step R (§5.16, contract R1–R9; §3-B, §3-G, §3-H; §7): the receiving
 * history's application layer, with the repository faked and the audit gateway a
 * recorded spy, so every assertion is about a DECISION rather than about SQL:
 *
 *  * the TENANT is the repository's FIRST argument on every call, and `tenantId`
 *    never reaches a response body (§3-F);
 *  * the read is ONE snapshot — the document, its lines and its receipt history
 *    from a single `readReceiptHistory` — and a foreign or unknown document is
 *    404 BEFORE anything else happens, so an id cannot be probed (§3-E);
 *  * the projection is Σ over the WHOLE history (compensations subtract) and
 *    equals `projectReceivingStatus`'s own answer for the same two inputs — one
 *    rule, one home (§3-B);
 *  * every write runs in ONE unit of work whose FIRST statement is the row LOCK
 *    (`lockDocumentForReceipt`), taken before the SUM it judges (§3-H, §22);
 *  * the over-receipt invariant is `received + requested <= ordered`, exactly, no
 *    tolerance, no silent cap — a refusal is 409 naming all three numbers and
 *    leaves NO partial receipt (R1/R2);
 *  * a compensation appends the EXACT NEGATION of a STATED magnitude, links the
 *    target by the path's id, copies the purchase line from the target, and is
 *    capped by what the locked history says remains — with no chain (§3-D);
 *  * the receiver is taken OFF the actor, never from a payload (§16);
 *  * exactly ONE audit row per write, through `CommerceAuditGateway`, on the
 *    step-G resource — and none for a read, and none for a refused write (§I8).
 *
 * The `build()` helper constructs fresh fakes per test (the purchase and payment
 * specs' precedent): what a fake RETURNS is the test's to decide, what was CALLED
 * is `mock.calls`' to remember, and no shared reset can empty a log an assertion
 * still needs.
 */

const ACTOR: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_LINE_ID = '33333333-3333-4333-8333-333333333333';
const COMPENSATION_ID = '44444444-4444-4444-8444-444444444444';
const PURCHASE_LINE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_PURCHASE_LINE_ID = '66666666-6666-4666-8666-666666666666';

/** One receipt line row as the repository returns it — strings, because money is exact. */
function storedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_LINE_ID,
    tenantId: 't1',
    receiptId: RECEIPT_ID,
    purchaseLineId: PURCHASE_LINE_ID,
    quantity: '2.5000',
    reversesReceiptLineId: null,
    createdAt: new Date('2026-09-20T10:00:02.000Z'),
    ...overrides,
  };
}

/** One receipt row (header plus nested lines) as the repository returns it. */
function storedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    tenantId: 't1',
    purchaseDocumentId: DOCUMENT_ID,
    receivedAt: new Date('2026-09-20T10:00:00.000Z'),
    receiverId: 'u1',
    createdAt: new Date('2026-09-20T10:00:01.000Z'),
    lines: [storedLine()],
    ...overrides,
  };
}

/** One purchase line as the read snapshot and `listLines` return it. */
function documentLine(overrides: Record<string, unknown> = {}) {
  return { id: PURCHASE_LINE_ID, lineNumber: 1, quantity: '100.0000', ...overrides };
}

/** One receipt line as `findReceiptLineForCompensation` returns it. */
function compensableTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_LINE_ID,
    tenantId: 't1',
    receiptId: RECEIPT_ID,
    purchaseLineId: PURCHASE_LINE_ID,
    quantity: '50.0000',
    reversesReceiptLineId: null,
    createdAt: new Date('2026-09-20T10:00:02.000Z'),
    ...overrides,
  };
}

/** The service with recording fakes — the repository's FULL surface, nothing more. */
function build() {
  type RepositoryMocks = {
    readReceiptHistory: jest.Mock;
    lockDocumentForReceipt: jest.Mock;
    listLines: jest.Mock;
    listByDocument: jest.Mock;
    findReceiptLineForCompensation: jest.Mock;
    append: jest.Mock;
  };
  const repository: RepositoryMocks = {
    readReceiptHistory: jest.fn(),
    lockDocumentForReceipt: jest.fn(),
    listLines: jest.fn(),
    listByDocument: jest.fn(),
    findReceiptLineForCompensation: jest.fn(),
    append: jest.fn(),
  };
  const audit = {
    record: jest.fn(),
  };
  const unitOfWork = {
    run: jest.fn((work: (tx: CommerceTransactionHandle) => Promise<unknown>) =>
      work({} as CommerceTransactionHandle)
    ),
  };
  // Phase W2-B: the integration seam, faked — planning and post-commit
  // attempts are asserted as calls, never as inventory state.
  const inventoryIntegration = {
    planReceiptPostings: jest.fn().mockResolvedValue([]),
    planCompensationPosting: jest.fn().mockResolvedValue([]),
    attemptPostings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new ReceivingHistoryService(
      repository as unknown as ReceivingHistoryRepository,
      audit as unknown as CommerceAuditGateway,
      unitOfWork as unknown as CommerceUnitOfWork,
      inventoryIntegration as never
    ),
    repository,
    audit,
    unitOfWork,
    inventoryIntegration,
  };
}
describe('Phase C1 Step R — the read: one snapshot, the whole history, every line (§3-B, §6)', () => {
  it('projects all three statuses for every line of the document — including a line with no events', async () => {
    const { service, repository } = build();
    const UNTOUCHED_LINE_ID = '77777777-7777-4777-8777-777777777777';
    repository.readReceiptHistory.mockResolvedValue([
      { id: DOCUMENT_ID },
      [
        documentLine(), // ordered 100, received 30 → PARTIAL
        documentLine({ id: OTHER_PURCHASE_LINE_ID, lineNumber: 2, quantity: '50.0000' }),
        documentLine({ id: UNTOUCHED_LINE_ID, lineNumber: 3, quantity: '10.0000' }),
      ],
      [
        storedReceipt({
          lines: [
            storedLine({ quantity: '30.0000' }),
            storedLine({
              id: COMPENSATION_ID,
              purchaseLineId: OTHER_PURCHASE_LINE_ID,
              quantity: '50.0000',
            }),
          ],
        }),
      ],
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID);

    // `NOT_RECEIVED` is a fact about the document, not a missing row: every line
    // appears even when no event names it.
    expect(page.lines).toEqual([
      {
        purchaseLineId: PURCHASE_LINE_ID,
        orderedQuantity: '100.0000',
        receivedQuantity: '30.0000',
        receivingStatus: 'PARTIALLY_RECEIVED',
      },
      {
        purchaseLineId: OTHER_PURCHASE_LINE_ID,
        orderedQuantity: '50.0000',
        receivedQuantity: '50.0000',
        receivingStatus: 'FULLY_RECEIVED',
      },
      {
        purchaseLineId: UNTOUCHED_LINE_ID,
        orderedQuantity: '10.0000',
        receivedQuantity: '0.0000',
        receivingStatus: 'NOT_RECEIVED',
      },
    ]);

    // §6's receipt view: the row's own fields plus nested lines, and no
    // `tenantId` / `purchaseDocumentId` anywhere in it.
    expect(Object.keys(page.receipts[0]).sort()).toEqual(
      ['createdAt', 'id', 'lines', 'receivedAt', 'receiverId'].sort()
    );
    expect(Object.keys(page.receipts[0].lines[0]).sort()).toEqual(
      ['createdAt', 'id', 'purchaseLineId', 'quantity', 'reversesReceiptLineId'].sort()
    );
    // Quantity is the stored DECIMAL STRING, never a float.
    expect(page.receipts[0].lines[0].quantity).toBe('30.0000');

    expect(repository.readReceiptHistory).toHaveBeenCalledWith('t1', DOCUMENT_ID);
  });

  it('Σ is over the WHOLE history: a compensation subtracts and returns the line to NOT_RECEIVED', async () => {
    const { service, repository } = build();
    repository.readReceiptHistory.mockResolvedValue([
      { id: DOCUMENT_ID },
      [documentLine({ quantity: '30.0000' })],
      [
        storedReceipt({ lines: [storedLine({ quantity: '30.0000' })] }),
        storedReceipt({
          id: COMPENSATION_ID,
          lines: [
            storedLine({
              id: '88888888-8888-4888-8888-888888888888',
              receiptId: COMPENSATION_ID,
              quantity: '-30.0000',
              reversesReceiptLineId: RECEIPT_LINE_ID,
            }),
          ],
        }),
      ],
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID);

    expect(page.lines[0].receivedQuantity).toBe('0.0000');
    expect(page.lines[0].receivingStatus).toBe('NOT_RECEIVED');
    // The history is still BOTH rows: append-only evidence is not hidden by the net.
    expect(page.receipts).toHaveLength(2);
    expect(page.receipts[1].lines[0].reversesReceiptLineId).toBe(RECEIPT_LINE_ID);
  });

  it('reports the SAME status the pure projection answers for the same two quantities (one rule, one home)', async () => {
    const { service, repository } = build();
    repository.readReceiptHistory.mockResolvedValue([
      { id: DOCUMENT_ID },
      [
        documentLine({ quantity: '26.2500' }),
        documentLine({ id: OTHER_PURCHASE_LINE_ID, quantity: '0.0001' }),
      ],
      [
        storedReceipt({
          lines: [
            storedLine({ quantity: '26.2500' }),
            storedLine({
              id: COMPENSATION_ID,
              purchaseLineId: OTHER_PURCHASE_LINE_ID,
              quantity: '0.0001',
            }),
          ],
        }),
      ],
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID);

    for (const line of page.lines) {
      expect(line.receivingStatus).toBe(
        projectReceivingStatus(line.orderedQuantity, line.receivedQuantity)
      );
    }
    expect(page.lines.map((line) => line.receivingStatus)).toEqual([
      'FULLY_RECEIVED',
      'FULLY_RECEIVED',
    ]);
  });

  it('refuses an IMPOSSIBLE history with RangeError rather than inventing a fourth status (R2, R5)', async () => {
    const { service, repository } = build();
    repository.readReceiptHistory.mockResolvedValue([
      { id: DOCUMENT_ID },
      [documentLine({ quantity: '100.0000' })],
      [storedReceipt({ lines: [storedLine({ quantity: '100.0001' })] })],
    ]);

    await expect(service.list(ACTOR, DOCUMENT_ID)).rejects.toBeInstanceOf(RangeError);
  });

  it('404s a foreign or unknown document — indistinguishable from absent (§3-E)', async () => {
    const { service, repository, audit } = build();
    repository.readReceiptHistory.mockResolvedValue([null, [], []]);

    await expect(service.list(ACTOR, DOCUMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list(ACTOR, DOCUMENT_ID)).rejects.toThrow('Purchase document not found');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
describe('Phase C1 Step R — appending a receiving event (R1, R7, §3-H)', () => {
  /** The write path's fakes with the document and its two lines in place. */
  function appendContext(ordered: Record<string, string> = {}, history: unknown[] = []) {
    const context = build();
    context.repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    context.repository.listLines.mockResolvedValue([
      documentLine({ quantity: ordered[PURCHASE_LINE_ID] ?? '100.0000' }),
      documentLine({
        id: OTHER_PURCHASE_LINE_ID,
        lineNumber: 2,
        quantity: ordered[OTHER_PURCHASE_LINE_ID] ?? '10.0000',
      }),
    ]);
    context.repository.listByDocument.mockResolvedValue(history);
    context.repository.append.mockResolvedValue(storedReceipt());
    return context;
  }

  it('writes inside ONE unit of work, lock FIRST, and returns §6’s view with the stored quantity as STRING', async () => {
    const { service, repository, unitOfWork } = appendContext();

    const view = await service.append(ACTOR, DOCUMENT_ID, {
      lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 2.5 }],
    });

    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(repository.append).toHaveBeenCalledWith('t1', expect.anything(), {
      purchaseDocumentId: DOCUMENT_ID,
      receiverId: 'u1', // off the ACTOR, never a payload (§16)
      lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: '2.5000' }],
    });

    // One handle, five statements: the view a caller could hold never existed
    // outside the transaction that made it.
    const handle = repository.lockDocumentForReceipt.mock.calls[0][2];
    expect(repository.listLines.mock.calls[0][2]).toBe(handle);
    expect(repository.listByDocument.mock.calls[0][2]).toBe(handle);
    expect(repository.append.mock.calls[0][1]).toBe(handle);

    // The LOCK is the first statement, before the SUM it judges exists (§3-H).
    expect(repository.lockDocumentForReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      repository.listLines.mock.invocationCallOrder[0]
    );
    expect(repository.listLines.mock.invocationCallOrder[0]).toBeLessThan(
      repository.listByDocument.mock.invocationCallOrder[0]
    );
    expect(repository.listByDocument.mock.invocationCallOrder[0]).toBeLessThan(
      repository.append.mock.invocationCallOrder[0]
    );

    expect(Object.keys(view).sort()).toEqual(
      ['createdAt', 'id', 'lines', 'receivedAt', 'receiverId'].sort()
    );
    expect(view.lines[0]).toEqual({
      id: RECEIPT_LINE_ID,
      purchaseLineId: PURCHASE_LINE_ID,
      quantity: '2.5000',
      reversesReceiptLineId: null,
      createdAt: expect.any(Date),
    });
  });

  it('states receivedAt only when the caller does — the column default is not restated', async () => {
    const withInstant = appendContext();
    await withInstant.service.append(ACTOR, DOCUMENT_ID, {
      receivedAt: '2026-09-01T08:30:00.000Z',
      lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 2.5 }],
    });
    const stated = withInstant.repository.append.mock.calls[0][2];
    expect(stated.receivedAt).toBeInstanceOf(Date);
    expect(stated.receivedAt.toISOString()).toBe('2026-09-01T08:30:00.000Z');

    const withoutInstant = appendContext();
    await withoutInstant.service.append(ACTOR, DOCUMENT_ID, {
      lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 2.5 }],
    });
    const omitted = withoutInstant.repository.append.mock.calls[0][2];
    // The KEY is absent, not `undefined`: absent means "column default (now)".
    expect('receivedAt' in omitted).toBe(false);
  });

  it('404s a foreign or unknown document BEFORE any other read or write (§3-E)', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReceipt.mockResolvedValue(null);

    await expect(
      service.append(ACTOR, DOCUMENT_ID, {
        lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 1 }],
      })
    ).rejects.toThrow('Purchase document not found');

    expect(repository.lockDocumentForReceipt).toHaveBeenCalledWith(
      't1',
      DOCUMENT_ID,
      expect.anything()
    );
    expect(repository.listLines).not.toHaveBeenCalled();
    expect(repository.listByDocument).not.toHaveBeenCalled();
    expect(repository.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s a purchase line the document does not own — ownership is PROVEN before the SUM read (§10)', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    repository.listLines.mockResolvedValue([documentLine()]); // owns PURCHASE_LINE_ID only

    await expect(
      service.append(ACTOR, DOCUMENT_ID, {
        lines: [{ purchaseLineId: OTHER_PURCHASE_LINE_ID, quantity: 1 }],
      })
    ).rejects.toThrow('Purchase line not found');

    // Nothing was read to judge a quantity and nothing was written: the refusal
    // is a probe-resistant 404, not a 409 that would leak the line's existence.
    expect(repository.listByDocument).not.toHaveBeenCalled();
    expect(repository.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
describe('Phase C1 Step R — the over-receipt invariant: received + requested ≤ ordered, exactly (R1/R2, §3-E)', () => {
  function appendContext(ordered: Record<string, string> = {}, history: unknown[] = []) {
    const context = build();
    context.repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    context.repository.listLines.mockResolvedValue([
      documentLine({ quantity: ordered[PURCHASE_LINE_ID] ?? '100.0000' }),
      documentLine({
        id: OTHER_PURCHASE_LINE_ID,
        lineNumber: 2,
        quantity: ordered[OTHER_PURCHASE_LINE_ID] ?? '10.0000',
      }),
    ]);
    context.repository.listByDocument.mockResolvedValue(history);
    context.repository.append.mockResolvedValue(storedReceipt());
    return context;
  }

  const requested = (purchaseLineId: string, quantity: number) => ({ purchaseLineId, quantity });

  it('accepts the exact boundary — received 90 + requested 10 against ordered 100 (no tolerance needed)', async () => {
    const context = appendContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '90.0000' })] }),
    ]);

    await context.service.append(ACTOR, DOCUMENT_ID, {
      lines: [requested(PURCHASE_LINE_ID, 10)],
    });

    expect(context.repository.append).toHaveBeenCalledTimes(1);
    expect(context.audit.record).toHaveBeenCalledTimes(1);
  });

  it('409s ONE unit over, naming the line, ordered, received and requested — and writes nothing (§3-E)', async () => {
    const context = appendContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '90.0000' })] }),
    ]);

    await expect(
      context.service.append(ACTOR, DOCUMENT_ID, {
        lines: [requested(PURCHASE_LINE_ID, 10.0001)],
      })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      context.service.append(ACTOR, DOCUMENT_ID, {
        lines: [requested(PURCHASE_LINE_ID, 10.0001)],
      })
    ).rejects.toThrow(
      /Receiving line 1 would exceed its ordered quantity: ordered 100\.0000, already received 90\.0000, requested 10\.0001/i
    );

    // NO SILENT CAP and no clamp to the remainder: the refusal is total, and the
    // throw happens inside the unit of work, so nothing partial was committed.
    expect(context.repository.append).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('sums REPEATED entries of one line BEFORE the check — splitting cannot smuggle an over-receipt past it', async () => {
    // 4 + 5 = 9 against ordered 9: two arrivals inside one operation fit.
    const fits = appendContext({ [PURCHASE_LINE_ID]: '9.0000' });
    await fits.service.append(ACTOR, DOCUMENT_ID, {
      lines: [requested(PURCHASE_LINE_ID, 4), requested(PURCHASE_LINE_ID, 5)],
    });
    // Both entries are written as STATED — the SUM is the check's, not a merge's.
    expect(fits.repository.append.mock.calls[0][2].lines).toEqual([
      { purchaseLineId: PURCHASE_LINE_ID, quantity: '4.0000' },
      { purchaseLineId: PURCHASE_LINE_ID, quantity: '5.0000' },
    ]);

    // 5 + 5 = 10 against ordered 9: each entry alone fits, the operation does not.
    const overflows = appendContext({ [PURCHASE_LINE_ID]: '9.0000' });
    await expect(
      overflows.service.append(ACTOR, DOCUMENT_ID, {
        lines: [requested(PURCHASE_LINE_ID, 5), requested(PURCHASE_LINE_ID, 5)],
      })
    ).rejects.toThrow(/requested 10\.0000/i);
    expect(overflows.repository.append).not.toHaveBeenCalled();
    expect(overflows.audit.record).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE operation when ONE line is over — no partial receipt for the line that fits', async () => {
    const context = appendContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '90.0000' })] }),
    ]);

    await expect(
      context.service.append(ACTOR, DOCUMENT_ID, {
        lines: [
          requested(OTHER_PURCHASE_LINE_ID, 5), // fits: ordered 10, received 0
          requested(PURCHASE_LINE_ID, 20), // ordered 100, received 90 → 110
        ],
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(context.repository.append).not.toHaveBeenCalled();
  });

  it('judges against the LOCKED history read, never against the payload (R2, §22)', async () => {
    // The same request against a history of 0 is legal and against 90 is not:
    // the only input that changed is what `listByDocument` returned.
    const empty = appendContext();
    await empty.service.append(ACTOR, DOCUMENT_ID, {
      lines: [requested(PURCHASE_LINE_ID, 10)],
    });
    expect(empty.repository.append).toHaveBeenCalledTimes(1);

    const nearlyFull = appendContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '95.0000' })] }),
    ]);
    await expect(
      nearlyFull.service.append(ACTOR, DOCUMENT_ID, {
        lines: [requested(PURCHASE_LINE_ID, 10)],
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(nearlyFull.repository.listByDocument).toHaveBeenCalledWith(
      't1',
      DOCUMENT_ID,
      expect.anything()
    );
  });
});
describe('Phase C1 Step R — the compensating event: negation, link by path, capped by locked history (R4, §3-D)', () => {
  /** The correction path's fakes: the target received 50.0000, nothing compensated yet. */
  function compensateContext(targetOverrides: Record<string, unknown> = {}, history?: unknown[]) {
    const context = build();
    const target = compensableTarget(targetOverrides);
    context.repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    context.repository.findReceiptLineForCompensation.mockResolvedValue(target);
    context.repository.listByDocument.mockResolvedValue(
      history ?? [
        storedReceipt({
          lines: [storedLine({ purchaseLineId: target.purchaseLineId, quantity: target.quantity })],
        }),
      ]
    );
    context.repository.append.mockResolvedValue(
      storedReceipt({
        id: COMPENSATION_ID,
        lines: [
          storedLine({
            id: '99999999-9999-4999-8999-999999999999',
            receiptId: COMPENSATION_ID,
            quantity: '-20.0000',
            reversesReceiptLineId: RECEIPT_LINE_ID,
          }),
        ],
      })
    );
    return context;
  }

  it('appends a NEW event: the exact NEGATION of the stated magnitude, the PATH’s link, the target’s line (R4)', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    repository.findReceiptLineForCompensation.mockResolvedValue(
      compensableTarget({ quantity: '26.2500' })
    );
    repository.listByDocument.mockResolvedValue([
      storedReceipt({ lines: [storedLine({ quantity: '26.2500' })] }),
    ]);
    repository.append.mockResolvedValue(
      storedReceipt({
        id: COMPENSATION_ID,
        lines: [
          storedLine({
            id: '99999999-9999-4999-8999-999999999999',
            receiptId: COMPENSATION_ID,
            quantity: '-26.2500',
            reversesReceiptLineId: RECEIPT_LINE_ID,
          }),
        ],
      })
    );

    const view = await service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, {
      quantity: 26.25, // the whole remaining amount, stated in another spelling
      reason: 'returned to the supplier',
    });

    // The target is looked up by TENANT, DOCUMENT and the PATH's line id — three
    // scopes, so a cross-document or cross-tenant id is simply not found.
    expect(repository.findReceiptLineForCompensation).toHaveBeenCalledWith(
      't1',
      DOCUMENT_ID,
      RECEIPT_LINE_ID,
      expect.anything()
    );
    expect(repository.append).toHaveBeenCalledWith('t1', expect.anything(), {
      purchaseDocumentId: DOCUMENT_ID,
      receiverId: 'u1',
      lines: [
        {
          purchaseLineId: PURCHASE_LINE_ID, // copied from the TARGET
          quantity: '-26.2500', // the negation of what the caller stated
          reversesReceiptLineId: RECEIPT_LINE_ID, // the PATH's id, never a body's
        },
      ],
    });
    expect(view.lines[0].quantity).toBe('-26.2500');
    expect(view.lines[0].reversesReceiptLineId).toBe(RECEIPT_LINE_ID);
    // The original row is not read for update and not written: the append above
    // is the ONLY write of this operation.
    expect(repository.append).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('admits PARTIAL corrections: +50 then −10 leaves 40 compensable (R4, §3-D)', async () => {
    const context = compensateContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '50.0000' })] }),
      storedReceipt({
        id: COMPENSATION_ID,
        lines: [
          storedLine({
            id: '99999999-9999-4999-8999-999999999999',
            receiptId: COMPENSATION_ID,
            quantity: '-10.0000',
            reversesReceiptLineId: RECEIPT_LINE_ID,
          }),
        ],
      }),
    ]);

    await context.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 40 });

    expect(context.repository.append.mock.calls[0][2].lines).toEqual([
      {
        purchaseLineId: PURCHASE_LINE_ID,
        quantity: '-40.0000',
        reversesReceiptLineId: RECEIPT_LINE_ID,
      },
    ]);
  });
  it('409s one unit beyond what REMAINS — the cap is the target plus Σ prior compensations (§3-D)', async () => {
    const context = compensateContext({}, [
      storedReceipt({ lines: [storedLine({ quantity: '50.0000' })] }),
      storedReceipt({
        id: COMPENSATION_ID,
        lines: [
          storedLine({
            id: '99999999-9999-4999-8999-999999999999',
            receiptId: COMPENSATION_ID,
            quantity: '-10.0000',
            reversesReceiptLineId: RECEIPT_LINE_ID,
          }),
        ],
      }),
    ]);

    await expect(
      context.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 40.0001 })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      context.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 40.0001 })
    ).rejects.toThrow(
      // `already compensated` is the SIGNED Σ of the compensating lines, so a
      // single -10.0000 prints with its own sign — the arithmetic is the rows'.
      /received 50\.0000, already compensated -10\.0000, available 40\.0000, requested 40\.0001/i
    );

    expect(context.repository.append).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('409s a compensating line as the target — no chain, checked BEFORE the cap read (§3-D)', async () => {
    const context = compensateContext({
      quantity: '-10.0000',
      reversesReceiptLineId: RECEIPT_LINE_ID,
    });

    await expect(
      context.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 5 })
    ).rejects.toThrow(/compensate the original line/);

    // Nothing was summed and nothing was written: the refusal precedes both.
    expect(context.repository.listByDocument).not.toHaveBeenCalled();
    expect(context.repository.append).not.toHaveBeenCalled();
  });

  it('404s an unknown, cross-document or cross-tenant target — indistinguishable from absent (§3-E)', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    repository.findReceiptLineForCompensation.mockResolvedValue(null);

    await expect(
      service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 5 })
    ).rejects.toThrow('Receipt line not found');

    expect(repository.listByDocument).not.toHaveBeenCalled();
    expect(repository.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s a foreign or unknown document before the target is even looked up (§3-H)', async () => {
    const { service, repository } = build();
    repository.lockDocumentForReceipt.mockResolvedValue(null);

    await expect(
      service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 5 })
    ).rejects.toThrow('Purchase document not found');
    expect(repository.findReceiptLineForCompensation).not.toHaveBeenCalled();
  });

  it('copies the target’s purchase line — the correction lands where the original did', async () => {
    const context = compensateContext({ purchaseLineId: OTHER_PURCHASE_LINE_ID }, [
      storedReceipt({
        lines: [storedLine({ purchaseLineId: OTHER_PURCHASE_LINE_ID, quantity: '50.0000' })],
      }),
    ]);

    await context.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 5 });

    expect(context.repository.append.mock.calls[0][2].lines).toEqual([
      {
        purchaseLineId: OTHER_PURCHASE_LINE_ID,
        quantity: '-5.0000',
        reversesReceiptLineId: RECEIPT_LINE_ID,
      },
    ]);
  });

  it('states receivedAt only when the caller does, and the receiver comes off the actor (§16)', async () => {
    const stated = compensateContext();
    await stated.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, {
      quantity: 5,
      receivedAt: '2026-09-22T12:00:00.000Z',
    });
    const payload = stated.repository.append.mock.calls[0][2];
    expect(payload.receivedAt).toBeInstanceOf(Date);
    expect(payload.receivedAt.toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect(payload.receiverId).toBe('u1');

    const omitted = compensateContext();
    await omitted.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 5 });
    expect('receivedAt' in omitted.repository.append.mock.calls[0][2]).toBe(false);
  });
});
describe('Phase C1 Step R — one audit row per write, none for a read (§3-G, §I8)', () => {
  it('records the appended receipt: action APPEND on the step-G receipt resource, with the row’s own facts', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    repository.listLines.mockResolvedValue([documentLine()]);
    repository.listByDocument.mockResolvedValue([]);
    repository.append.mockResolvedValue(
      storedReceipt({ id: 'row-new', lines: [storedLine({ quantity: '2.5000' })] })
    );

    await service.append(ACTOR, DOCUMENT_ID, {
      lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 2.5 }],
    });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: RECEIVING_AUDIT_ACTION.APPEND,
        resource: COMMERCE_AUDIT_RESOURCE.RECEIPT,
        resourceId: 'row-new',
        newValue: expect.objectContaining({
          purchaseDocumentId: DOCUMENT_ID,
          receivedAt: expect.any(Date),
          lines: [
            {
              purchaseLineId: PURCHASE_LINE_ID,
              quantity: '2.5000',
              reversesReceiptLineId: null,
            },
          ],
        }),
      })
    );
  });

  it('records the compensation with the stated reason — the rationale has exactly ONE home (§3-G)', async () => {
    const withReason = build();
    withReason.repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    withReason.repository.findReceiptLineForCompensation.mockResolvedValue(compensableTarget());
    withReason.repository.listByDocument.mockResolvedValue([
      storedReceipt({ lines: [storedLine({ quantity: '50.0000' })] }),
    ]);
    withReason.repository.append.mockResolvedValue(
      storedReceipt({
        id: COMPENSATION_ID,
        lines: [
          storedLine({
            id: '99999999-9999-4999-8999-999999999999',
            receiptId: COMPENSATION_ID,
            quantity: '-20.0000',
            reversesReceiptLineId: RECEIPT_LINE_ID,
          }),
        ],
      })
    );

    await withReason.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, {
      quantity: 20,
      reason: 'wrong pallet',
    });

    expect(withReason.audit.record).toHaveBeenCalledTimes(1);
    expect(withReason.audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: RECEIVING_AUDIT_ACTION.COMPENSATE,
        resource: COMMERCE_AUDIT_RESOURCE.RECEIPT,
        resourceId: COMPENSATION_ID,
        reason: 'wrong pallet',
        newValue: expect.objectContaining({
          purchaseDocumentId: DOCUMENT_ID,
          lines: [
            {
              purchaseLineId: PURCHASE_LINE_ID,
              quantity: '-20.0000',
              reversesReceiptLineId: RECEIPT_LINE_ID,
            },
          ],
        }),
      })
    );

    // No reason stated → `null`, never invented prose: the column that does not
    // exist cannot disagree with the event that does.
    const withoutReason = build();
    withoutReason.repository.lockDocumentForReceipt.mockResolvedValue({ id: DOCUMENT_ID });
    withoutReason.repository.findReceiptLineForCompensation.mockResolvedValue(compensableTarget());
    withoutReason.repository.listByDocument.mockResolvedValue([
      storedReceipt({ lines: [storedLine({ quantity: '50.0000' })] }),
    ]);
    withoutReason.repository.append.mockResolvedValue(storedReceipt({ id: COMPENSATION_ID }));

    await withoutReason.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, {
      quantity: 20,
    });
    expect(withoutReason.audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ reason: null })
    );
  });

  it('audits NOTHING for a read, and NOTHING for a refused write (§I8)', async () => {
    const read = build();
    read.repository.readReceiptHistory.mockResolvedValue([
      { id: DOCUMENT_ID },
      [documentLine()],
      [storedReceipt()],
    ]);
    await read.service.list(ACTOR, DOCUMENT_ID);
    expect(read.audit.record).not.toHaveBeenCalled();

    // Both writes refuse at the document gate — the throw happens INSIDE the
    // unit of work, so no "success" trail row exists for an act that rolled back.
    const refused = build();
    refused.repository.lockDocumentForReceipt.mockResolvedValue(null);
    await expect(
      refused.service.append(ACTOR, DOCUMENT_ID, {
        lines: [{ purchaseLineId: PURCHASE_LINE_ID, quantity: 1 }],
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      refused.service.compensate(ACTOR, DOCUMENT_ID, RECEIPT_LINE_ID, { quantity: 1 })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(refused.audit.record).not.toHaveBeenCalled();
  });
});
describe('Phase C1 Step R — the shape of the slice, read back as text (§3-F, §3-H, R5, R6)', () => {
  /** The service's CODE: comment-only lines dropped, so prose cannot satisfy a scan. */
  const code = readFileSync(join(__dirname, 'receiving-history.service.ts'), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      );
    })
    .join('\n');

  it('has exactly FOUR constructor dependencies — repository, audit, unit of work, integration (§3-H + W2-B)', () => {
    expect(code).toMatch(
      /constructor\(\s*private readonly repository: ReceivingHistoryRepository,\s*private readonly audit: CommerceAuditGateway,\s*private readonly unitOfWork: CommerceUnitOfWork,\s*private readonly inventoryIntegration: InventoryIntegrationService\s*\)/
    );
    // The absence is STRUCTURAL: no identity gateway (the receiver is opaque,
    // §16), no workflow/commercial/payment dependency and no rule engine —
    // receiving is an independent lifecycle (R6).
    expect(code).not.toMatch(
      /CommerceIdentityGateway|WorkflowLineRouting|CommercialLifecycle|profilesFor|assertMember|RuleEngine|evaluateRule/
    );
  });

  it('touches exactly the repository’s six methods — no name a typo invented', () => {
    const touched = new Set(
      [...code.matchAll(/this\.repository\.(\w+)/g)].map((match) => match[1])
    );
    expect([...touched].sort()).toEqual(
      [
        'append',
        'findReceiptLineForCompensation',
        'listByDocument',
        'listLines',
        'lockDocumentForReceipt',
        'readReceiptHistory',
      ].sort()
    );
  });

  it('opens exactly TWO units of work — the two writes — and no other transaction mechanism', () => {
    expect(code.match(/this\.unitOfWork\.run\(/g) ?? []).toHaveLength(2);
    // The handle is opened by the unit of work and unwrapped by the repository:
    // a `$transaction` here would be a second boundary in the wrong layer.
    expect(code).not.toMatch(/\$transaction/);
  });

  it('takes the LOCK before the history read on BOTH write paths (§3-H, §22)', () => {
    const locks = [...code.matchAll(/this\.repository\.lockDocumentForReceipt\(/g)].map(
      (match) => match.index as number
    );
    const reads = [...code.matchAll(/this\.repository\.listByDocument\(/g)].map(
      (match) => match.index as number
    );
    expect(locks).toHaveLength(2);
    expect(reads).toHaveLength(2);
    // The SUM a refusal is judged on is read under the lock the INSERT commits
    // against, in `append` and in `compensate` alike.
    for (let index = 0; index < locks.length; index += 1) {
      expect(locks[index]).toBeLessThan(reads[index]);
    }
  });

  it('re-types no status literal and writes no document status — one home, one lifecycle (R5, R6)', () => {
    expect(code).not.toMatch(/'(?:NOT_RECEIVED|PARTIALLY_RECEIVED|FULLY_RECEIVED)'/);
    expect(code).not.toMatch(
      /PurchaseDocumentStatus|purchaseDocument\.(?:update|updateMany|delete|upsert|create)/
    );
  });

  it('records exactly the two receiving actions, both on the step-G receipt resource (§3-G)', () => {
    expect(
      [...code.matchAll(/RECEIVING_AUDIT_ACTION\.(\w+)/g)].map((match) => match[1]).sort()
    ).toEqual(['APPEND', 'COMPENSATE']);
    expect([...code.matchAll(/COMMERCE_AUDIT_RESOURCE\.(\w+)/g)].map((match) => match[1])).toEqual([
      'RECEIPT',
      'RECEIPT',
    ]);
  });

  it('imports nothing from another slice — receiving depends on purchase money and its own files', () => {
    expect(code).not.toMatch(/from '[^']*(?:workflow|commercial|payment|identity)[^']*'/i);
    expect([...code.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual([
      '@nestjs/common',
      '../commerce-actor',
      // Phase W2-B: the ONE new collaborator — the integration slice's service,
      // which owns the durable posting plan and the post-commit attempt.
      '../integration/inventory-integration.service',
      '../commerce-audit.gateway',
      '../commerce.constants',
      '../database/commerce-transaction',
      '../purchase/purchase-money',
      './receiving-history.repository',
      './receiving.dto',
      './receiving-status',
    ]);
  });
});
