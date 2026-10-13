import { BadRequestException } from '@nestjs/common';
import { CommerceReceivingReportingReaderService } from './commerce-receiving-reporting.reader';
import type {
  CommerceReceivingReportingScope,
} from './commerce-receiving-reporting.contract';
import type { ReceivingReportSourceRow } from '../receiving/receiving-history.repository';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Commerce-owned ADAPTER — the
 * approved seam's own contract. What this spec proves, one-for-one with the
 * payment reader's spec because the properties belong to the seam:
 *
 *  1. PROJECTION — a source fact row crosses the seam as EXACTLY the eight
 *     contract fields, with `receivingStatus` produced by the domain's
 *     `projectReceivingStatus` (never by a rule re-typed here).
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository call.
 *  3. FILTER PASS-THROUGH — ONLY the pushable keys (document/line id, document
 *     number search) reach the repository; `status` and the date window narrow
 *     the computed register IN the pipeline and never become storage predicates.
 *  4. WINDOW HONESTY — an inverted or malformed window is a 400 before any
 *     statement is issued.
 *  5. SUMMARY HONESTY — counts come from the SAME pipeline, zero-filled over the
 *     CLOSED three-member status set, and `total` is the same population.
 *  6. ORDER HONESTY — latest receiving instant DESC, event-less rows last, id
 *     ASC tie-break (the deterministic page boundary).
 *  7. NO WRITES, NO TIMELINE — the adapter's surface is the three contract reads.
 */
function scope(tenantId = 'tenant-a'): CommerceReceivingReportingScope {
  return { tenantId };
}

/** A raw fact as `readReportSourceRows` returns it — with everything status-shaped computed by the projection. */
const SOURCE_ROW: ReceivingReportSourceRow = {
  id: '33333333-3333-4333-8333-333333333333',
  purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
  purchaseDocumentNumber: 'PR-1404-000123',
  orderedQuantity: '100.0000',
  receivedQuantity: '40.0000',
  receivedAt: new Date('2026-01-05T08:00:00.000Z'),
  compensationCount: 1,
};

function build(rows: ReceivingReportSourceRow[] = [SOURCE_ROW]) {
  const readReportSourceRows = jest.fn().mockResolvedValue(rows);
  const reader = new CommerceReceivingReportingReaderService({
    readReportSourceRows,
  } as never);
  return { reader, readReportSourceRows };
}

describe('CommerceReceivingReportingReaderService — the approved read seam', () => {
  it('projects a source fact onto EXACTLY the eight contract fields, status by value', async () => {
    const { reader } = build();

    const page = await reader.listReportRows(scope(), {});

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'orderedQuantity',
        'receivedQuantity',
        'receivingStatus',
        'receivedAt',
        'compensationCount',
      ].sort()
    );
    // 40 of 100 → the domain's PARTIALLY_RECEIVED; exact strings cross untouched.
    expect(page.items[0].receivingStatus).toBe('PARTIALLY_RECEIVED');
    expect(page.items[0].orderedQuantity).toBe('100.0000');
    expect(page.items[0].receivedQuantity).toBe('40.0000');
    expect(page.items[0].compensationCount).toBe(1);
    expect(page.items[0].receivedAt).toBe('2026-01-05T08:00:00.000Z');
  });

  it('forwards the scope verbatim to every repository call — no method reads unscoped', async () => {
    const { reader, readReportSourceRows } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), SOURCE_ROW.id);

    expect(readReportSourceRows).toHaveBeenCalledTimes(3);
    for (const call of readReportSourceRows.mock.calls) expect(call[0]).toBe('tenant-a');
  });

  it('pushes ONLY the storage filters — status and the date window never reach the repository', async () => {
    const { reader, readReportSourceRows } = build();

    await reader.listReportRows(scope(), {
      status: 'FULLY_RECEIVED',
      receivedFrom: '2026-01-01T00:00:00.000Z',
      receivedTo: '2026-02-01T00:00:00.000Z',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      purchaseLineId: SOURCE_ROW.id,
      search: 'PR-14',
      page: 2,
      pageSize: 10,
    });

    expect(readReportSourceRows).toHaveBeenCalledWith('tenant-a', {
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      purchaseLineId: SOURCE_ROW.id,
      search: 'PR-14',
    });
  });

  it('leaves every unstated filter ABSENT — not `undefined`, not a default', async () => {
    const { reader, readReportSourceRows } = build();

    await reader.listReportRows(scope(), {});
    await reader.getReportSummary(scope(), {});

    expect(readReportSourceRows.mock.calls[0][1]).toEqual({});
    expect(readReportSourceRows.mock.calls[1][1]).toEqual({});
  });

  it('refuses an inverted or malformed window with a 400 BEFORE any statement is issued', async () => {
    const { reader, readReportSourceRows } = build();

    await expect(
      reader.listReportRows(scope(), {
        receivedFrom: '2026-02-01T00:00:00.000Z',
        receivedTo: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      reader.getReportSummary(scope(), { receivedFrom: 'not-an-instant' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(readReportSourceRows).not.toHaveBeenCalled();
  });

  it('clamps the window to the COMMERCE ceiling for a caller that bypassed the DTO', async () => {
    const { reader } = build();

    const page = await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    expect(page).toMatchObject({ page: 1, pageSize: 100 });
  });

  it('zero-fills the summary over the CLOSED three-member status set, from the SAME pipeline', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({
      total: 1,
      byStatus: { NOT_RECEIVED: 0, PARTIALLY_RECEIVED: 1, FULLY_RECEIVED: 0 },
    });
  });

  it('narrows by computed STATUS in the pipeline — a bucket the facts do not reach reports zero', async () => {
    const { reader } = build();

    const page = await reader.listReportRows(scope(), { status: 'FULLY_RECEIVED' });
    expect(page).toMatchObject({ items: [], total: 0 });

    const summary = await reader.getReportSummary(scope(), { status: 'FULLY_RECEIVED' });
    expect(summary).toEqual({
      total: 0,
      byStatus: { NOT_RECEIVED: 0, PARTIALLY_RECEIVED: 0, FULLY_RECEIVED: 0 },
    });
  });

  it('narrows by the HALF-OPEN [from, to) window on the latest instant — NULL instants excluded', async () => {
    const eventless: ReceivingReportSourceRow = {
      ...SOURCE_ROW,
      id: '44444444-4444-4444-8444-444444444444',
      receivedAt: null,
      receivedQuantity: '0.0000',
    };
    const { reader } = build([SOURCE_ROW, eventless]);

    const inside = await reader.listReportRows(scope(), {
      receivedFrom: '2026-01-01T00:00:00.000Z',
      receivedTo: '2026-02-01T00:00:00.000Z',
    });
    expect(inside.total).toBe(1);
    expect(inside.items[0].id).toBe(SOURCE_ROW.id);

    // Upper bound is EXCLUSIVE: an instant equal to `receivedTo` is outside.
    const excluded = await reader.listReportRows(scope(), {
      receivedTo: SOURCE_ROW.receivedAt!.toISOString(),
    });
    expect(excluded.total).toBe(0);

    // Unbounded query keeps the event-less row (its NULL matches no bound only
    // when a bound exists).
    const unbounded = await reader.listReportRows(scope(), {});
    expect(unbounded.total).toBe(2);
  });

  it('orders latest-first with event-less rows LAST and id ASC as the tie-break', async () => {
    const newer: ReceivingReportSourceRow = {
      ...SOURCE_ROW,
      id: '99999999-9999-4999-8999-999999999999',
      receivedAt: new Date('2026-03-01T00:00:00.000Z'),
    };
    const eventless: ReceivingReportSourceRow = {
      ...SOURCE_ROW,
      id: '44444444-4444-4444-8444-444444444444',
      receivedAt: null,
      receivedQuantity: '0.0000',
    };
    const { reader } = build([eventless, SOURCE_ROW, newer]);

    const page = await reader.listReportRows(scope(), {});

    expect(page.items.map((row) => row.id)).toEqual([
      newer.id,
      SOURCE_ROW.id,
      eventless.id,
    ]);
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, readReportSourceRows } = build();
    readReportSourceRows.mockResolvedValueOnce([]);

    await expect(reader.getReportRow(scope('tenant-b'), SOURCE_ROW.id)).resolves.toBeNull();
  });

  it('exposes ONLY the three contract reads — no write, no append, no timeline', () => {
    const names = Object.getOwnPropertyNames(CommerceReceivingReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(['getReportRow', 'getReportSummary', 'listReportRows'].sort());
  });
});

