import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PurchaseReportService } from './purchase-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  CommercePurchaseReportingReader,
  CommercePurchaseReportQuery,
  CommercePurchaseReportRow,
  CommercePurchaseReportTimelinePage,
  CommerceReportingScope,
} from '../commerce/reporting/commerce-purchase-reporting.contract';

/**
 * Phase REPORTING-PURCHASE-REPORT: the report APPLICATION contract — tenant isolation,
 * the not-found mapping, the outage mapping, the projection boundary and the no-write
 * surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never Commerce's storage. The mirror of
 * `check-request-report.service.spec.ts`, whose reasoning did not depend on Financial.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, status = 'SUBMITTED'): CommercePurchaseReportRow => ({
  id,
  documentNumber: `PR-1404-${id}`,
  kind: 'PURCHASE_REQUEST',
  status,
  supplierId: null,
  currency: 'IRR',
  subtotalAmount: '100.0000',
  taxAmount: null,
  totalAmount: null,
  lineCount: 2,
  completedAt: null,
  createdAt: new Date('2026-01-05T00:00:00.000Z').toISOString(),
});

function readerWith(
  rows: CommercePurchaseReportRow[],
  timeline: CommercePurchaseReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: CommercePurchaseReportingReader;
  calls: { scope: CommerceReportingScope; query: CommercePurchaseReportQuery }[];
} {
  const calls: { scope: CommerceReportingScope; query: CommercePurchaseReportQuery }[] = [];
  const reader: CommercePurchaseReportingReader = {
    listReportRows: jest.fn(
      async (scope: CommerceReportingScope, query: CommercePurchaseReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byStatus: { SUBMITTED: rows.length },
    })),
    getReportRow: jest.fn(
      async (scope: CommerceReportingScope, documentId: string) =>
        rows.find((row) => row.id === documentId && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

describe('PurchaseReportService — the second Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new PurchaseReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<PurchaseReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — status + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    await service.list(actor('tenant-a'), {
      status: 'APPROVED',
      search: 'PR-1404',
      page: 2,
      pageSize: 10,
    } as Parameters<PurchaseReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      status: 'APPROVED',
      search: 'PR-1404',
      page: 2,
      pageSize: 10,
    });
  });

  it('attaches the summary to the page — one answer, not two round trips the screen joins', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    const page = await service.list(
      actor('tenant-a'),
      {} as Parameters<PurchaseReportService['list']>[1]
    );

    expect(page.summary).toEqual({ total: 1, byStatus: { SUBMITTED: 1 } });
    expect(page.items).toHaveLength(1);
  });

  it('maps a foreign-tenant row to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getTimeline(actor('tenant-b'), 'a', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps an unknown id to 404', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns the reader projection untouched — the contract twelve, and only those', async () => {
    // The reader OWNS the whitelist projection (asserted against a raw row in the
    // reader's own spec); this asserts the service does not RE-WIDEN it — no field is
    // added, renamed or dropped between seam and response.
    const { reader } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'documentNumber',
        'kind',
        'status',
        'supplierId',
        'currency',
        'subtotalAmount',
        'taxAmount',
        'totalAmount',
        'lineCount',
        'completedAt',
        'createdAt',
      ].sort()
    );
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('requesterId');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('maps an audit outage to 503 — never an empty timeline', async () => {
    const failing: CommercePurchaseReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const service = new PurchaseReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same filters, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new PurchaseReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {
          status: 'APPROVED',
          search: 'PR-1404',
          page: 2,
          pageSize: 10,
        } as Parameters<PurchaseReportService['exportReport']>[1],
        'xlsx'
      );

      // ONE page read + ONE summary read — the same pair `list()` makes, carrying the
      // caller's query and the server-resolved tenant unchanged.
      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({
        status: 'APPROVED',
        search: 'PR-1404',
        page: 2,
        pageSize: 10,
      });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^purchase-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new PurchaseReportService(reader);

      const file = await service.exportReport(
      actor('tenant-a'),
      {} as Parameters<PurchaseReportService['exportReport']>[1],
      'docx'
    );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^purchase-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new PurchaseReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<PurchaseReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into Commerce — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(PurchaseReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new PurchaseReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<PurchaseReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
