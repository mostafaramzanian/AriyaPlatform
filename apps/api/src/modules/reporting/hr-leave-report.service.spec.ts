import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HrLeaveReportService } from './hr-leave-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  HrLeaveRequestReportingReader,
  HrLeaveRequestReportQuery,
  HrLeaveRequestReportRow,
  HrLeaveRequestReportTimelinePage,
  HrLeaveRequestReportingScope,
} from '../hr/reporting/hr-leave-reporting.contract';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the report APPLICATION contract — tenant
 * isolation, the not-found mapping, the outage mapping, the projection boundary and
 * the no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never HR's storage. The mirror of
 * `hr-personnel-traffic-report.service.spec.ts`, whose reasoning did not depend on
 * the attendance register.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, status: 'PENDING' | 'APPROVED' = 'PENDING'): HrLeaveRequestReportRow => ({
  id,
  employeeCode: `E-${id}`,
  leaveTypeCode: 'ANNUAL',
  leaveTypeName: 'name-a',
  startDate: '2026-09-18',
  endDate: '2026-09-20',
  reason: 'reason-a',
  status,
  createdAt: '2026-09-10T08:00:00.000Z',
  cancelledAt: null,
});

function readerWith(
  rows: HrLeaveRequestReportRow[],
  timeline: HrLeaveRequestReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: HrLeaveRequestReportingReader;
  calls: { scope: HrLeaveRequestReportingScope; query: HrLeaveRequestReportQuery }[];
} {
  const calls: { scope: HrLeaveRequestReportingScope; query: HrLeaveRequestReportQuery }[] = [];
  const reader: HrLeaveRequestReportingReader = {
    listReportRows: jest.fn(
      async (scope: HrLeaveRequestReportingScope, query: HrLeaveRequestReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byStatus: { PENDING: 1, APPROVED: 0, REJECTED: 0, CANCELLED: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: HrLeaveRequestReportingScope, leaveRequestId: string) =>
        rows.find((row) => row.id === leaveRequestId && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

describe('HrLeaveReportService — the sixth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new HrLeaveReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<HrLeaveReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — window + employee + type + status', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new HrLeaveReportService(reader);

    await service.list(actor('tenant-a'), {
      employeeId: '22222222-2222-4222-8222-222222222222',
      leaveTypeId: '33333333-3333-4333-8333-333333333333',
      status: 'PENDING',
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    } as Parameters<HrLeaveReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      employeeId: '22222222-2222-4222-8222-222222222222',
      leaveTypeId: '33333333-3333-4333-8333-333333333333',
      status: 'PENDING',
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    });
  });

  it('answers 404 for an unknown OR foreign id — existence never leaks', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrLeaveReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
    // The fake reader answers `null` for a scope mismatch too — the same 404 path.
    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('proves existence tenant-scoped BEFORE the timeline read, then maps AUDIT_READ_FAILED to 503', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrLeaveReportService(reader);

    await expect(service.getTimeline(actor('tenant-a'), 'missing', {})).rejects.toBeInstanceOf(
      NotFoundException
    );

    const failing: HrLeaveRequestReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const failingService = new HrLeaveReportService(failing);

    await expect(failingService.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('re-throws any OTHER timeline failure untouched — only AUDIT_READ_FAILED is translated', async () => {
    const failing: HrLeaveRequestReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw new Error('something else');
      }),
    };
    const service = new HrLeaveReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toThrow('something else');
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same window, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new HrLeaveReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        { status: 'PENDING', from: '2026-09-18', page: 2, pageSize: 10 } as Parameters<HrLeaveReportService['exportReport']>[1],
        'xlsx'
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({
        status: 'PENDING',
        from: '2026-09-18',
        page: 2,
        pageSize: 10,
      });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^hr-leave-request-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrLeaveReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<HrLeaveReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^hr-leave-request-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrLeaveReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<HrLeaveReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into HR — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(HrLeaveReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrLeaveReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<HrLeaveReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
