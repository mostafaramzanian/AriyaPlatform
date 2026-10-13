import { BadRequestException } from '@nestjs/common';
import { CommercePaymentReportingReaderService } from './commerce-payment-reporting.reader';
import type {
  CommercePaymentReportingScope,
} from './commerce-payment-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Commerce-owned ADAPTER — the approved
 * seam's own contract. What this spec proves, one-for-one with the purchase reader's
 * spec because the properties belong to the seam, not to the aggregate:
 *
 *  1. PROJECTION — a raw `PaymentRecord` row (tenantId, recordedByUserId, createdAt,
 *     the parent document relation) crosses the seam as EXACTLY the twelve contract
 *     fields. The whitelist lives here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository call: no
 *     method can ask for a row without one.
 *  3. FILTER PASS-THROUGH — only method/search/documentId + the half-open `paymentDate`
 *     window + the page window reach the repository; unstated keys stay ABSENT.
 *  4. WINDOW HONESTY — an inverted window is a 400 before any statement is issued.
 *  5. SUMMARY HONESTY — counts come from the repository's bounded `groupBy`, zero-filled
 *     over the CLOSED three-member method set, and `total` comes from the count the
 *     SAME predicate produced.
 *  6. MONEY HONESTY — the exact stored string crosses; `currency: null` stays `null`,
 *     never `0`.
 *  7. NO WRITES, NO TIMELINE — the adapter's surface is the three contract reads.
 */
function scope(tenantId = 'tenant-a'): CommercePaymentReportingScope {
  return { tenantId };
}

const INSTANT = new Date('2026-01-05T08:00:00.000Z');

/** A raw row as `listReportPage` returns it — with everything the report must NOT leak. */
const RAW_ROW: {
  id: string;
  purchaseDocument: { documentNumber: string };
  amount: unknown;
  paymentDate: Date;
} & Record<string, unknown> = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: 'tenant-a',
  purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
  purchaseDocument: { documentNumber: 'PR-1404-000123' },
  amount: { toString: () => '30.0000' },
  currency: 'IRR',
  method: 'CASH',
  paymentDate: INSTANT,
  payerRef: null,
  payeeRef: 'SUP-77',
  invoiceRef: 'INV-9',
  externalReference: 'EXT-1',
  reversesPaymentId: null,
  recordedByUserId: 'user-9',
  createdAt: new Date('2026-01-05T08:00:01.000Z'),
};

function build() {
  const listReportPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countReportByMethod = jest.fn().mockResolvedValue(new Map([['CASH', 1]]));
  const findReportRow = jest.fn().mockResolvedValue(RAW_ROW);

  const reader = new CommercePaymentReportingReaderService({
    listReportPage,
    countReportByMethod,
    findReportRow,
  } as never);

  return { reader, listReportPage, countReportByMethod, findReportRow };
}

describe('CommercePaymentReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the twelve contract fields', async () => {
    const { reader } = build();

    const page = await reader.listReportRows(scope(), {});

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'amount',
        'currency',
        'method',
        'paymentDate',
        'payerRef',
        'payeeRef',
        'invoiceRef',
        'externalReference',
        'reversesPaymentId',
      ].sort()
    );
    expect(page.items[0]).not.toHaveProperty('tenantId');
    expect(page.items[0]).not.toHaveProperty('recordedByUserId');
    expect(page.items[0]).not.toHaveProperty('createdAt');
    expect(page.items[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      purchaseDocumentNumber: 'PR-1404-000123',
      amount: '30.0000',
      currency: 'IRR',
      method: 'CASH',
      paymentDate: '2026-01-05T08:00:00.000Z',
      payerRef: null,
      payeeRef: 'SUP-77',
      invoiceRef: 'INV-9',
      externalReference: 'EXT-1',
      reversesPaymentId: null,
    });
  });

  it('forwards the scope verbatim to every repository call — no method reads unscoped', async () => {
    const { reader, listReportPage, countReportByMethod, findReportRow } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id as string);

    expect(listReportPage.mock.calls[0][0]).toBe('tenant-a');
    expect(countReportByMethod).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(findReportRow).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
  });

  it('passes ONLY the source-supported filters through — as Dates, plus the page window', async () => {
    const { reader, listReportPage } = build();

    await reader.listReportRows(scope(), {
      method: 'CHECK',
      search: 'INV-9',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      paymentFrom: '2026-01-01T00:00:00.000Z',
      paymentTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    });

    expect(listReportPage).toHaveBeenCalledWith(
      'tenant-a',
      {
        method: 'CHECK',
        search: 'INV-9',
        purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
        paymentFrom: new Date('2026-01-01T00:00:00.000Z'),
        paymentTo: new Date('2026-02-01T00:00:00.000Z'),
      },
      { skip: 10, take: 10 }
    );
  });

  it('leaves every unstated filter ABSENT — not `undefined`, not a default', async () => {
    // The property that makes the additive extension safe: a caller that names no
    // filter reaches the repository with exactly the unfiltered object.
    const { reader, listReportPage, countReportByMethod } = build();

    await reader.listReportRows(scope(), {});
    await reader.getReportSummary(scope(), {});

    expect(listReportPage.mock.calls[0][1]).toEqual({});
    expect(countReportByMethod.mock.calls[0][1]).toEqual({});
  });

  it('refuses an inverted window with a 400 BEFORE any statement is issued', async () => {
    const { reader, listReportPage, countReportByMethod } = build();

    await expect(
      reader.listReportRows(scope(), {
        paymentFrom: '2026-02-01T00:00:00.000Z',
        paymentTo: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listReportPage).not.toHaveBeenCalled();

    await expect(
      reader.getReportSummary(scope(), {
        paymentFrom: '2026-02-01T00:00:00.000Z',
        paymentTo: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(countReportByMethod).not.toHaveBeenCalled();
  });

  it('clamps the window to the COMMERCE ceiling for a caller that bypassed the DTO', async () => {
    const { reader, listReportPage } = build();

    await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    expect(listReportPage.mock.calls[0][2]).toEqual({ skip: 0, take: 100 });
  });

  it('zero-fills the summary over the CLOSED three-member method set', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({ total: 1, byMethod: { CASH: 1, PETTY_CASH: 0, CHECK: 0 } });
  });

  it('keeps money exact and `currency: null` honest — never `0`', async () => {
    const { reader, findReportRow } = build();
    findReportRow.mockResolvedValueOnce({
      ...RAW_ROW,
      amount: { toString: () => '-30.0000' },
      currency: null,
    });

    const row = await reader.getReportRow(scope(), RAW_ROW.id as string);

    expect(row?.amount).toBe('-30.0000');
    expect(row?.currency).toBeNull();
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findReportRow } = build();
    findReportRow.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope('tenant-b'), RAW_ROW.id as string)).resolves.toBeNull();
  });

  it('exposes ONLY the three contract reads — no write, no append, no timeline', () => {
    const names = Object.getOwnPropertyNames(CommercePaymentReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(['getReportRow', 'getReportSummary', 'listReportRows'].sort());
  });
});
