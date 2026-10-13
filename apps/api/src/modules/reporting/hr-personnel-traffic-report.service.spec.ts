import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HrPersonnelTrafficReportService } from './hr-personnel-traffic-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  HrPersonnelTrafficReportingReader,
  HrPersonnelTrafficReportQuery,
  HrPersonnelTrafficReportRow,
  HrPersonnelTrafficReportTimelinePage,
  HrPersonnelTrafficReportingScope,
} from '../hr/reporting/hr-personnel-traffic-reporting.contract';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the report APPLICATION contract — tenant
 * isolation, the not-found mapping, the outage mapping, the projection boundary and the
 * no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never HR's storage. The mirror of
 * `production-report.service.spec.ts`, whose reasoning did not depend on Production.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, source = 'DEVICE' as const): HrPersonnelTrafficReportRow => ({
  id,
  employeeCode: `E-${id}`,
  workDate: '2026-09-18',
  dateKey: '1405/06/27',
  clockIn: '2026-09-18T08:00:00.000Z',
  clockOut: '2026-09-18T16:30:00.000Z',
  source,
  reason: null,
});

function readerWith(
  rows: HrPersonnelTrafficReportRow[],
  timeline: HrPersonnelTrafficReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: HrPersonnelTrafficReportingReader;
  calls: { scope: HrPersonnelTrafficReportingScope; query: HrPersonnelTrafficReportQuery }[];
} {
  const calls: { scope: HrPersonnelTrafficReportingScope; query: HrPersonnelTrafficReportQuery }[] =
    [];
  const reader: HrPersonnelTrafficReportingReader = {
    listReportRows: jest.fn(
      async (scope: HrPersonnelTrafficReportingScope, query: HrPersonnelTrafficReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      bySource: { DEVICE: rows.length, MANUAL: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: HrPersonnelTrafficReportingScope, attendanceId: string) =>
        rows.find((row) => row.id === attendanceId && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

describe('HrPersonnelTrafficReportService — the fourth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new HrPersonnelTrafficReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<HrPersonnelTrafficReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — day window + source + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    await service.list(actor('tenant-a'), {
      from: '2026-09-18',
      to: '2026-09-19',
      source: 'MANUAL',
      search: 'E-10',
      page: 2,
      pageSize: 10,
    } as Parameters<HrPersonnelTrafficReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      from: '2026-09-18',
      to: '2026-09-19',
      source: 'MANUAL',
      search: 'E-10',
      page: 2,
      pageSize: 10,
    });
  });

  it('attaches the summary to the page — one answer, not two round trips the screen joins', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    const page = await service.list(actor('tenant-a'), {} as Parameters<HrPersonnelTrafficReportService['list']>[1]);

    expect(page.summary).toEqual({ total: 1, bySource: { DEVICE: 1, MANUAL: 0 } });
    expect(page.items).toHaveLength(1);
  });

  it('maps a foreign-tenant row to 404 — existence never leaks across tenants', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getTimeline(actor('tenant-b'), 'a', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps an unknown id to 404', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns the reader projection untouched — the contract eight, and only those', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'employeeCode',
        'workDate',
        'dateKey',
        'clockIn',
        'clockOut',
        'source',
        'reason',
      ].sort()
    );
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('employeeId');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('maps an audit outage to 503 — never an empty timeline', async () => {
    const failing: HrPersonnelTrafficReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const service = new HrPersonnelTrafficReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same day window, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new HrPersonnelTrafficReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        { from: '2026-09-18', to: '2026-09-19', source: 'MANUAL', page: 2, pageSize: 10 } as Parameters<HrPersonnelTrafficReportService['exportReport']>[1],
        'xlsx'
      );

      // ONE page read + ONE summary read — the same pair `list()` makes, carrying the
      // caller's query (resolved by the register's own window rules) unchanged.
      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({
        from: '2026-09-18',
        to: '2026-09-19',
        source: 'MANUAL',
        page: 2,
        pageSize: 10,
      });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^personnel-traffic-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrPersonnelTrafficReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<HrPersonnelTrafficReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^personnel-traffic-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrPersonnelTrafficReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<HrPersonnelTrafficReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into HR — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(HrPersonnelTrafficReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrPersonnelTrafficReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<HrPersonnelTrafficReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
