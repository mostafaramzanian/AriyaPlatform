import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ReturnLifecycleReportService } from './return-lifecycle-report.service';
import type {
  CommerceReturnLifecycleReportingReader,
  CommerceReturnReportDetail,
  CommerceReturnReportQuery,
  CommerceReturnReportRow,
  CommerceReturnReportingScope,
} from '../commerce/reporting/return-lifecycle-reporting.contract';

function actor(tenantId: string) {
  return { tenantId, userId: 'user-1', requestId: 'req-1', ip: null, userAgent: null };
}

const ROW = (id: string, state = 'APPROVED'): CommerceReturnReportRow => ({
  id,
  purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
  purchaseDocumentNumber: `PR-1404-${id}`,
  state,
  reason: 'کالای معیوب',
  replacementRequired: false,
  lineCount: 2,
  createdAt: new Date('2026-01-05T08:00:00.000Z').toISOString(),
});

function readerWith(rows: CommerceReturnReportRow[]): {
  reader: CommerceReturnLifecycleReportingReader;
  calls: { scope: CommerceReturnReportingScope; query: CommerceReturnReportQuery }[];
} {
  const calls: { scope: CommerceReturnReportingScope; query: CommerceReturnReportQuery }[] = [];
  const reader: CommerceReturnLifecycleReportingReader = {
    listReportRows: jest.fn(
      async (scope: CommerceReturnReportingScope, query: CommerceReturnReportQuery) => {
        calls.push({ scope, query });
        return { items: rows, total: rows.length, page: 1, pageSize: 20 };
      }
    ),
    getReportSummary: jest.fn(async () => ({
      total: rows.length,
      byState: { REQUESTED: 0, APPROVED: rows.length, RECEIVED_BACK: 0, REFUNDED: 0, REJECTED: 0 },
    })),
    // The fake returns the ROW projection only — no `lines` — because the
    // exact-keys assertion below proves the service adds nothing of its own;
    // the cast spans that deliberate under-shape, nothing else.
    getReportRow: jest.fn(
      async (scope: CommerceReturnReportingScope, returnId: string) =>
        (rows.find((row) => row.id === returnId && scope.tenantId === 'tenant-a') ??
          null) as unknown as CommerceReturnReportDetail | null
    ),
    getReportTimeline: jest.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0 })),
  };
  return { reader, calls };
}

describe('ReturnLifecycleReportService — the ninth Reporting business capability', () => {
  it('scopes every read by the server-resolved tenant — never a client field', async () => {
    const { reader, calls } = readerWith([ROW('a'), ROW('b')]);
    const service = new ReturnLifecycleReportService(reader);

    await service.list(
      actor('tenant-a'),
      {} as Parameters<ReturnLifecycleReportService['list']>[1],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].scope).toEqual({ tenantId: 'tenant-a' });
  });

  it('passes ONLY the source-supported filters through — state + search + window', async () => {
    const { reader, calls } = readerWith([ROW('a')]);
    const service = new ReturnLifecycleReportService(reader);

    await service.list(actor('tenant-a'), {
      state: 'REJECTED',
      search: 'معیوب',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    } as Parameters<ReturnLifecycleReportService['list']>[1]);

    expect(calls[0].query).toEqual({
      state: 'REJECTED',
      search: 'معیوب',
      purchaseDocumentId: '11111111-1111-4111-8111-111111111111',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    });
  });

  it('answers 404 for an unknown OR foreign id — existence never leaks', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReturnLifecycleReportService(reader);

    await expect(service.getOne(actor('tenant-a'), 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(service.getOne(actor('tenant-b'), 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('proves existence tenant-scoped BEFORE the timeline read', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReturnLifecycleReportService(reader);

    await expect(service.getTimeline(actor('tenant-a'), 'missing', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('maps AUDIT_READ_FAILED to 503 — never an empty page', async () => {
    const failing: CommerceReturnLifecycleReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(
        async () => ROW('a') as unknown as CommerceReturnReportDetail
      ),
      getReportTimeline: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'AUDIT_READ_FAILED' });
      }),
    };
    const failingService = new ReturnLifecycleReportService(failing);

    await expect(failingService.getTimeline(actor('tenant-a'), 'a', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('re-throws any OTHER timeline failure untouched', async () => {
    const failing: CommerceReturnLifecycleReportingReader = {
      listReportRows: jest.fn(),
      getReportSummary: jest.fn(),
      getReportRow: jest.fn(
        async () => ROW('a') as unknown as CommerceReturnReportDetail
      ),
      getReportTimeline: jest.fn(async () => {
        throw new Error('something else');
      }),
    };
    const service = new ReturnLifecycleReportService(failing);

    await expect(service.getTimeline(actor('tenant-a'), 'a', {})).rejects.toThrow('something else');
  });

  it('returns the reader projection untouched — the contract eight, and only those', async () => {
    const { reader } = readerWith([ROW('a')]);
    const service = new ReturnLifecycleReportService(reader);

    const result = await service.getOne(actor('tenant-a'), 'a');

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'purchaseDocumentId',
        'purchaseDocumentNumber',
        'state',
        'reason',
        'replacementRequired',
        'lineCount',
        'createdAt',
      ].sort()
    );
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('requestedByUserId');
  });

  it('exposes no write affordance', () => {
    const names = Object.getOwnPropertyNames(ReturnLifecycleReportService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(['exportReport', 'getOne', 'getTimeline', 'list'].sort());
  });
});
