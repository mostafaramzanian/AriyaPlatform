import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HrMissionReportService } from './hr-mission-report.service';
import type { ReportingActor } from './reporting-actor';
import type {
  HrMissionRequestReportingReader,
  HrMissionRequestReportQuery,
  HrMissionRequestReportRow,
  HrMissionRequestReportTimelinePage,
  HrMissionRequestReportingScope,
} from '../hr/reporting/hr-mission-reporting.contract';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the report APPLICATION contract — tenant
 * isolation, the not-found mapping, the outage mapping, the projection boundary and
 * the no-write surface.
 *
 * Every test below injects a FAKE reader (the contract shape, in-memory), so what is
 * asserted is THIS layer's decision — never HR's storage. The mirror of
 * `hr-leave-report.service.spec.ts`.
 */
function actor(tenantId: string): ReportingActor {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, status: 'DRAFT' | 'APPROVED' = 'DRAFT'): HrMissionRequestReportRow => ({
  id,
  employeeCode: `E-${id}`,
  durationMode: 'DAILY',
  locationType: 'OUT_OF_CITY',
  engagementType: 'NON_PROJECT',
  startDate: '2026-09-18',
  endDate: '2026-09-20',
  startTime: null,
  endTime: null,
  destination: 'شیراز',
  description: null,
  correctionReason: null,
  rejectionReason: null,
  submittedRevision: null,
  status,
  createdAt: '2026-09-10T08:00:00.000Z',
});

function readerWith(
  rows: HrMissionRequestReportRow[],
  timeline: HrMissionRequestReportTimelinePage = { items: [], page: 1, pageSize: 20, total: 0 }
): {
  reader: HrMissionRequestReportingReader;
  calls: { scope: HrMissionRequestReportingScope; query: HrMissionRequestReportQuery }[];
} {
  const calls: { scope: HrMissionRequestReportingScope; query: HrMissionRequestReportQuery }[] = [];
  const reader: HrMissionRequestReportingReader = {
    listReportRows: jest.fn(
      async (scope: HrMissionRequestReportingScope, query: HrMissionRequestReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byStatus: { DRAFT: rows.length, APPROVED: 0 },
    })),
    getReportRow: jest.fn(
      async (scope: HrMissionRequestReportingScope, missionRequestId: string) =>
        rows.find((row) => row.id === missionRequestId && scope.tenantId === 'tenant-a') ?? null
    ),
    getReportTimeline: jest.fn(async () => timeline),
  };
  return { reader, calls };
}

describe('HrMissionReportService — the seventh Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new HrMissionReportService(reader);

    await service.list(actor('tenant-a'), {} as Parameters<HrMissionReportService['list']>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — window + status + duration mode', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new HrMissionReportService(reader);

    await service.list(actor('tenant-a'), {
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'IN_APPROVAL',
      durationMode: 'HOURLY',
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    } as Parameters<HrMissionReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'IN_APPROVAL',
      durationMode: 'HOURLY',
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    });
  });

  it('answers 404 for a missing OR foreign-tenant row — existence never leaks', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrMissionReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
    // tenant-b asking for tenant-a's row: the fake reader scopes by tenant, and the
    // service maps its `null` to the SAME 404 — a 403 would confirm the id exists.
    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(service.getTimeline(actor('tenant-b'), 'a', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps AUDIT_READ_FAILED to 503 and re-throws everything else untouched', async () => {
    const failing: HrMissionRequestReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        const error = new Error('Audit history is temporarily unavailable.') as Error & {
          code?: string;
        };
        error.code = 'AUDIT_READ_FAILED';
        throw error;
      }),
    };
    const failingService = new HrMissionReportService(failing);
    await expect(failingService.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );

    const other: HrMissionRequestReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(async () => ROW('a')),
      getReportTimeline: jest.fn(async () => {
        throw new Error('something else');
      }),
    };
    await expect(
      new HrMissionReportService(other).getTimeline(actor('tenant-a'), 'a', {})
    ).rejects.toThrow('something else');
  });

  describe('exportReport — the SAME list, rendered as a file', () => {
    it('reads through the same list path with the same window, then answers an XLSX', async () => {
      const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
      const service = new HrMissionReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        { status: 'DRAFT', from: '2026-09-18', page: 2, pageSize: 10 } as Parameters<HrMissionReportService['exportReport']>[1],
        'xlsx'
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
      expect(calls[0].query).toEqual({
        status: 'DRAFT',
        from: '2026-09-18',
        page: 2,
        pageSize: 10,
      });
      expect(reader.getReportSummary).toHaveBeenCalledTimes(1);
      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(file.fileName).toMatch(/^hr-mission-request-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('answers DOCX with the exact Word MIME and the same ASCII name shape', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrMissionReportService(reader);

      const file = await service.exportReport(
        actor('tenant-a'),
        {} as Parameters<HrMissionReportService['exportReport']>[1],
        'docx'
      );

      expect(file.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(file.fileName).toMatch(/^hr-mission-request-report-\d{4}-\d{2}-\d{2}\.docx$/);
      expect(file.buffer.byteLength).toBeGreaterThan(0);
    });

    it('fails closed without a tenant — export can never widen the scope', async () => {
      const { reader } = readerWith([ROW('a')]);
      const service = new HrMissionReportService(reader);

      await expect(
        service.exportReport(
          { tenantId: '' } as ReportingActor,
          {} as Parameters<HrMissionReportService['exportReport']>[1],
          'xlsx'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reader.listReportRows).not.toHaveBeenCalled();
    });
  });

  it('exposes no write path into HR — the service surface is read-only', () => {
    const names = Object.getOwnPropertyNames(HrMissionReportService.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(names.sort()).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });

  it('fails closed without a tenant — the actor, never a default', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new HrMissionReportService(reader);

    await expect(
      service.list(
        { tenantId: '' } as ReportingActor,
        {} as Parameters<HrMissionReportService['list']>[1]
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
