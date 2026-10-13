import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentHistoryReportService } from './payment-history-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  CommercePaymentReportingReader,
  CommercePaymentReportQuery,
  CommercePaymentReportRow,
  CommercePaymentReportingScope,
} from '../commerce/reporting/commerce-payment-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the report APPLICATION contract — tenant
 * isolation, the not-found mapping, the projection boundary, the no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never Commerce's storage. The mirror of the
 * sibling report service specs, minus the timeline: the contract offers NO timeline
 * (the payment audit trail is document-bound, so a per-row read would lie by grain),
 * and mapping a method that does not exist would be a lie by affordance.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, method = 'CASH'): CommercePaymentReportRow => ({
  id,
  purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
  purchaseDocumentNumber: `PR-1404-${id}`,
  amount: '30.0000',
  currency: 'IRR',
  method,
  paymentDate: new Date('2026-01-05T08:00:00.000Z').toISOString(),
  payerRef: null,
  payeeRef: null,
  invoiceRef: null,
  externalReference: null,
  reversesPaymentId: null,
});

function readerWith(rows: CommercePaymentReportRow[]): {
  reader: CommercePaymentReportingReader;
  calls: { scope: CommercePaymentReportingScope; query: CommercePaymentReportQuery }[];
} {
  const calls: { scope: CommercePaymentReportingScope; query: CommercePaymentReportQuery }[] = [];
  const reader: CommercePaymentReportingReader = {
    listReportRows: jest.fn(
      async (scope: CommercePaymentReportingScope, query: CommercePaymentReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byMethod: { CASH: rows.length, PETTY_CASH: 0, CHECK: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: CommercePaymentReportingScope, paymentId: string) =>
        rows.find((row) => row.id === paymentId && scope.tenantId === 'tenant-a') ?? null
    ),
  };
  return { reader, calls };
}

describe('PaymentHistoryReportService — the eighth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new PaymentHistoryReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<PaymentHistoryReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — method + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new PaymentHistoryReportService(reader);

    await service.list(actor('tenant-a'), {
      method: 'CHECK',
      search: 'INV-9',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      paymentFrom: '2026-01-01T00:00:00.000Z',
      paymentTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    } as Parameters<PaymentHistoryReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      method: 'CHECK',
      search: 'INV-9',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      paymentFrom: '2026-01-01T00:00:00.000Z',
      paymentTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    });
  });

  it('attaches the summary to the page — one answer, not two round trips the screen joins', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PaymentHistoryReportService(reader);

    const page = await service.list(actor('tenant-a'), {} as Parameters<PaymentHistoryReportService['list']>[1]);

    expect(page.summary).toEqual({ total: 1, byMethod: { CASH: 1, PETTY_CASH: 0, CHECK: 0 } });
    expect(page.items).toHaveLength(1);
  });

  it('maps a foreign-tenant row to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PaymentHistoryReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an unknown id to 404', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PaymentHistoryReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns the reader projection untouched — the contract twelve, and only those', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PaymentHistoryReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
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
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('recordedByUserId');
    expect(result).not.toHaveProperty('createdAt');
  });

  it('exposes no timeline and no write affordance', () => {
    const names = Object.getOwnPropertyNames(PaymentHistoryReportService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(['exportReport', 'getOne', 'list'].sort());
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same filters, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new PaymentHistoryReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {
          method: 'CASH',
          search: 'INV-9',
          paymentFrom: '2026-01-01T00:00:00.000Z',
          paymentTo: '2026-02-01T00:00:00.000Z',
          page: 2,
          pageSize: 10,
        } as Parameters<PaymentHistoryReportService['exportReport']>[1],
        'xlsx'
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({
        method: 'CASH',
        search: 'INV-9',
        paymentFrom: '2026-01-01T00:00:00.000Z',
        paymentTo: '2026-02-01T00:00:00.000Z',
        page: 2,
        pageSize: 10,
      });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^commerce-payment-history-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new PaymentHistoryReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<PaymentHistoryReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^commerce-payment-history-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new PaymentHistoryReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<PaymentHistoryReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });
});
