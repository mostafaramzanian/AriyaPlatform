import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ProductionBomChangeReportService } from './production-bom-change-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  ProductionBomChangeReportingReader,
  ProductionBomChangeReportQuery,
  ProductionBomChangeReportRow,
  ProductionBomChangeReportTimelinePage,
  ProductionBomChangeReportingScope,
} from '../production/reporting/production-bom-change-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the report APPLICATION contract — tenant
 * isolation, the not-found mapping, the outage mapping, the projection boundary and the
 * no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never Production's storage. The mirror of
 * `production-report.service.spec.ts`, whose reasoning did not depend on which aggregate
 * the reader sat behind.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, status = 'SUBMITTED'): ProductionBomChangeReportRow => ({
  id,
  bomId: '22222222-2222-4222-8222-222222222222',
  title: `CHANGE-${id}`,
  projectRef: '42',
  productTreeRef: '771',
  status,
  managerOpinion: null,
  itemCount: 1,
  submittedAt: null,
  decidedAt: null,
  createdAt: new Date('2026-01-05T00:00:00.000Z').toISOString(),
});

function readerWith(
  rows: ProductionBomChangeReportRow[],
  timeline: ProductionBomChangeReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: ProductionBomChangeReportingReader;
  calls: { scope: ProductionBomChangeReportingScope; query: ProductionBomChangeReportQuery }[];
} {
  const calls: {
    scope: ProductionBomChangeReportingScope;
    query: ProductionBomChangeReportQuery;
  }[] = [];
  const reader: ProductionBomChangeReportingReader = {
    listReportRows: jest.fn(
      async (scope: ProductionBomChangeReportingScope, query: ProductionBomChangeReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byStatus: { DRAFT: 0, SUBMITTED: rows.length, APPROVED: 0, REJECTED: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: ProductionBomChangeReportingScope, id: string) =>
        rows.find((row) => row.id === id && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

describe('ProductionBomChangeReportService — the fifth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new ProductionBomChangeReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<ProductionBomChangeReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — bomId + projectRef + status + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new ProductionBomChangeReportService(reader);

    await service.list(actor('tenant-a'), {
      bomId: '22222222-2222-4222-8222-222222222222',
      projectRef: '42',
      status: 'APPROVED',
      search: 'CHANGE',
      page: 2,
      pageSize: 10,
    } as Parameters<ProductionBomChangeReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      bomId: '22222222-2222-4222-8222-222222222222',
      projectRef: '42',
      status: 'APPROVED',
      search: 'CHANGE',
      page: 2,
      pageSize: 10,
    });
  });

  it('attaches the summary to the page — one answer, not two round trips the screen joins', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ProductionBomChangeReportService(reader);

    const result = await service.list(actor('tenant-a'), {} as Parameters<ProductionBomChangeReportService['list']>[1]);

    expect(result.summary).toEqual({
      total: 1,
      byStatus: { DRAFT: 0, SUBMITTED: 1, APPROVED: 0, REJECTED: 0 },
    });
    expect(result.items).toHaveLength(1);
  });

  it('maps a foreign-tenant id to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ProductionBomChangeReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getTimeline(actor('tenant-b'), 'a', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("returns the row untouched on detail — the projection is the seam's, not this layer's", async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ProductionBomChangeReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(result).toEqual(ROW('a'));
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('requesterUserId');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result).not.toHaveProperty('notes');
  });

  it('maps an audit outage to 503 — never an empty timeline', async () => {
    const failing: ProductionBomChangeReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const service = new ProductionBomChangeReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same filters, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new ProductionBomChangeReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        { status: 'APPROVED', page: 2, pageSize: 10 } as Parameters<ProductionBomChangeReportService['exportReport']>[1],
        'xlsx'
      );

      // ONE page read + ONE summary read — the same pair `list()` makes, carrying the
      // caller's query and the server-resolved tenant unchanged.
      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({ status: 'APPROVED', page: 2, pageSize: 10 });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^production-bom-change-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new ProductionBomChangeReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<ProductionBomChangeReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^production-bom-change-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new ProductionBomChangeReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<ProductionBomChangeReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into Production — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(ProductionBomChangeReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ProductionBomChangeReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<ProductionBomChangeReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
