import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReceivingReportService } from './receiving-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  CommerceReceivingReportQuery,
  CommerceReceivingReportRow,
  CommerceReceivingReportSummary,
  CommerceReceivingReportingReader,
  CommerceReceivingReportingScope,
} from '../commerce/reporting/commerce-receiving-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the report APPLICATION contract —
 * tenant isolation, the not-found mapping, the projection boundary, the no-write
 * surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what
 * is asserted is THIS layer's decision — never Commerce's storage. The mirror of
 * the payment service spec, minus the timeline: the contract offers NO timeline
 * (the receiving audit trail is receipt-event-bound while the row is a purchase
 * line, so a per-row read would lie by grain), and mapping a method that does not
 * exist would be a lie by affordance.
 */
function actor(tenantId: string | null): ReportingActor {
  return { tenantId: tenantId ?? '', userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string): CommerceReceivingReportRow => ({
  id,
  purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
  purchaseDocumentNumber: `PR-1404-${id}`,
  orderedQuantity: '100.0000',
  receivedQuantity: '40.0000',
  receivingStatus: 'PARTIALLY_RECEIVED',
  receivedAt: new Date('2026-01-05T08:00:00.000Z').toISOString(),
  compensationCount: 1,
});

const SUMMARY: CommerceReceivingReportSummary = {
  total: 1,
  byStatus: { NOT_RECEIVED: 0, PARTIALLY_RECEIVED: 1, FULLY_RECEIVED: 0 },
};

function readerWith(rows: CommerceReceivingReportRow[]): {
  reader: CommerceReceivingReportingReader;
  calls: { scope: CommerceReceivingReportingScope; query: CommerceReceivingReportQuery }[];
} {
  const calls: { scope: CommerceReceivingReportingScope; query: CommerceReceivingReportQuery }[] =
    [];
  const reader: CommerceReceivingReportingReader = {
    listReportRows: jest.fn(
      async (scope: CommerceReceivingReportingScope, query: CommerceReceivingReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byStatus: { NOT_RECEIVED: 0, PARTIALLY_RECEIVED: rows.length, FULLY_RECEIVED: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: CommerceReceivingReportingScope, lineId: string) =>
        rows.find((row) => row.id === lineId && scope.tenantId === 'tenant-a') ?? null
    ),
  };
  return { reader, calls };
}

describe('ReceivingReportService — the tenth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new ReceivingReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<ReceivingReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('fails CLOSED when the request resolved no tenant — unscoped is not an answer', async () => {
    const { reader, calls } = readerWith([]);
    const service = new ReceivingReportService(reader);

    await expect(
      service.list(actor(null), {} as Parameters<ReceivingReportService['list']>[1])
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('passes ONLY the source-supported filters through — status + ids + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    await service.list(actor('tenant-a'), {
      status: 'PARTIALLY_RECEIVED',
      search: 'PR-14',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      receivedFrom: '2026-01-01T00:00:00.000Z',
      receivedTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    } as Parameters<ReceivingReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      status: 'PARTIALLY_RECEIVED',
      search: 'PR-14',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      receivedFrom: '2026-01-01T00:00:00.000Z',
      receivedTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    });
  });

  it('attaches the summary to the page — one answer, not two round trips the screen joins', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    const page = await service.list(actor('tenant-a'), {} as Parameters<ReceivingReportService['list']>[1]);

    expect(page.summary).toEqual(SUMMARY);
    expect(page.items).toHaveLength(1);
  });

  it('maps a foreign-tenant row to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps an unknown id to 404', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns the reader projection untouched — the contract eight, and only those', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
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
    expect(result.receivingStatus).toBe('PARTIALLY_RECEIVED');
  });

  it('renders BOTH exports from the SAME list result — one population, no second query', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new ReceivingReportService(reader);

    const xlsx = await service.exportReport(
      actor('tenant-a'),
      {} as Parameters<ReceivingReportService['exportReport']>[1],
      'xlsx'
    );
    const docx = await service.exportReport(
      actor('tenant-a'),
      {} as Parameters<ReceivingReportService['exportReport']>[1],
      'docx'
    );

    // The reader is reached ONLY through `list` — no export-specific query exists,
    // and both formats answered with the identical scope.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(xlsx.fileName).toContain('commerce-receiving-status-report');
    expect(docx.fileName).toContain('commerce-receiving-status-report');
    expect(xlsx.mimeType).not.toBe(docx.mimeType);
  });

  it('exposes exactly three application methods — list, export, one row; no write, no timeline', () => {
    const names = Object.getOwnPropertyNames(ReceivingReportService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(['exportReport', 'getOne', 'list'].sort());
  });
});

