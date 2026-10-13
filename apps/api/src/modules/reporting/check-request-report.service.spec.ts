import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CheckRequestReportService } from './check-request-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  FinancialCheckRequestReportingReader,
  FinancialCheckRequestReportRow,
  FinancialCheckRequestReportTimelinePage,
  FinancialReportingScope,
  FinancialCheckRequestReportQuery,
} from '../financial/reporting/financial-check-request-reporting.contract';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the report APPLICATION contract —
 * tenant isolation, the not-found mapping, the outage mapping, the
 * projection boundary and the no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so
 * what is asserted is THIS layer's decision — never Financial's storage.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

function readerWith(
  rows: FinancialCheckRequestReportRow[],
  timeline: FinancialCheckRequestReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: FinancialCheckRequestReportingReader;
  calls: { scope: FinancialReportingScope; query: FinancialCheckRequestReportQuery }[];
} {
  const calls: { scope: FinancialReportingScope; query: FinancialCheckRequestReportQuery }[] = [];
  const reader: FinancialCheckRequestReportingReader = {
    listReportRows: jest.fn(
      async (scope: FinancialReportingScope, query: FinancialCheckRequestReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({ total: rows.length, byStatus: { '0': rows.length } })),
    getReportRow: jest.fn(
      async (scope: FinancialReportingScope, requestId: string) =>
        rows.find((row) => row.id === requestId && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

const ROW = (id: string, status = 2): FinancialCheckRequestReportRow => ({
  id,
  title: `row ${id}`,
  checkIssueType: 'PURCHASE',
  purchaseType: 'PROJECT',
  orderReference: null,
  projectReference: null,
  requestDate: new Date('2026-01-05T00:00:00.000Z').toISOString(),
  requesterOpinion: 'CONTINUE',
  status,
  managerDecision: null,
  submittedAt: null,
  decidedAt: null,
});

describe('CheckRequestReportService — the first Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new CheckRequestReportService(reader);

    await service.list(actor('tenant-a'), {});

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — status + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new CheckRequestReportService(reader);

    await service.list(actor('tenant-a'), { status: 2, search: 'gearbox', page: 2, pageSize: 10 });

    expect(calls[0].query).toEqual({ status: 2, search: 'gearbox', page: 2, pageSize: 10 });
  });

  it('maps a foreign-tenant row to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new CheckRequestReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getTimeline(actor('tenant-b'), 'a', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps an unknown id to 404', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new CheckRequestReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns the reader projection untouched — the contract twelve, and only those', async () => {
    // The reader OWNS the whitelist projection (asserted against a raw row in
    // the reader's own spec); this asserts the service does not RE-WIDEN it —
    // no field is added, renamed or dropped between seam and response.
    const projected = { ...ROW('a') };
    const { reader } = readerWith([projected]);
    const service = new CheckRequestReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'title',
        'checkIssueType',
        'purchaseType',
        'orderReference',
        'projectReference',
        'requestDate',
        'requesterOpinion',
        'status',
        'managerDecision',
        'submittedAt',
        'decidedAt',
      ].sort()
    );
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('requesterUserId');
  });

  it('maps an audit outage to 503 — never an empty timeline', async () => {
    const failing: FinancialCheckRequestReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const service = new CheckRequestReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same filters, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new CheckRequestReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        { status: 2, page: 2, pageSize: 10 } as Parameters<CheckRequestReportService['exportReport']>[1],
        'xlsx'
      );

      // ONE page read + ONE summary read — the same pair `list()` makes, carrying the
      // caller's query and the server-resolved tenant unchanged.
      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({ status: 2, page: 2, pageSize: 10 });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^check-request-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new CheckRequestReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<CheckRequestReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^check-request-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new CheckRequestReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<CheckRequestReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into Financial — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(CheckRequestReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new CheckRequestReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<CheckRequestReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
