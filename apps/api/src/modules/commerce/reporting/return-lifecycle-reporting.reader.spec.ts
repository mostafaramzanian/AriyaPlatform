import { BadRequestException } from '@nestjs/common';
import { CommerceReturnLifecycleReportingReaderService } from './return-lifecycle-reporting.reader';
import type {
  CommerceReturnReportingScope,
} from './return-lifecycle-reporting.contract';

function scope(tenantId = 'tenant-a'): CommerceReturnReportingScope {
  return { tenantId };
}

const INSTANT = new Date('2026-01-05T08:00:00.000Z');

/** The ordered transition chain every raw row below carries: REQUESTED then APPROVED. */
const TRANSITIONS = [
  { id: '11111111-1111-4111-8111-111111111111', state: 'APPROVED' as const, createdAt: INSTANT },
  { id: '00000000-0000-4000-8000-000000000000', state: 'REQUESTED' as const, createdAt: INSTANT },
];

/** A raw row as `findReportRow` returns it — with everything the report must NOT leak. */
const RAW_ROW: {
  id: string;
  purchaseDocument: { documentNumber: string };
  _count: { lines: number };
  createdAt: Date;
} & Record<string, unknown> = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: 'tenant-a',
  purchaseDocumentId: '33333333-3333-4333-8333-333333333333',
  purchaseDocument: { documentNumber: 'PR-1404-000123' },
  reason: 'کالای معیوب',
  replacementRequired: false,
  requestedByUserId: 'user-9',
  _count: { lines: 2 },
  createdAt: INSTANT,
  transitions: TRANSITIONS,
  lines: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      purchaseLineId: '55555555-5555-4555-8555-555555555555',
      receiptLineId: '66666666-6666-4666-8666-666666666666',
      quantity: { toString: () => '3.0000' },
      createdAt: INSTANT,
    },
  ],
};

function build() {
  const listReportPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countReportByState = jest.fn().mockResolvedValue(new Map([['APPROVED', 1]]));
  const findReportRow = jest.fn().mockResolvedValue(RAW_ROW);
  const auditRead = jest.fn().mockResolvedValue({
    status: 'recorded',
    page: {
      items: [
        {
          id: 'evt-1',
          action: 'create',
          actorId: 'user-9',
          success: true,
          reason: null,
          changedFields: [],
          createdAt: '2026-01-05T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new CommerceReturnLifecycleReportingReaderService(
    { listReportPage, countReportByState, findReportRow } as never,
    { read: auditRead } as never
  );

  return { reader, listReportPage, countReportByState, findReportRow, auditRead };
}

describe('CommerceReturnLifecycleReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the eight contract fields', async () => {
    const { reader } = build();

    const page = await reader.listReportRows(scope(), {});

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
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
    expect(page.items[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      purchaseDocumentId: '33333333-3333-4333-8333-333333333333',
      purchaseDocumentNumber: 'PR-1404-000123',
      state: 'APPROVED',
      reason: 'کالای معیوب',
      replacementRequired: false,
      lineCount: 2,
      createdAt: INSTANT.toISOString(),
    });
  });

  it('refuses an impossible transition history rather than projecting a fabricated state', async () => {
    const { reader, listReportPage } = build();
    listReportPage.mockResolvedValueOnce([
      [{ ...RAW_ROW, transitions: [{ id: 'x', state: 'REFUNDED', createdAt: INSTANT }] }],
      1,
    ]);

    await expect(reader.listReportRows(scope(), {})).rejects.toThrow(/not REQUESTED/);
  });

  it('forwards the scope verbatim to every repository and audit call — no method reads unscoped', async () => {
    const { reader, listReportPage, countReportByState, findReportRow, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(listReportPage.mock.calls[0][0]).toBe('tenant-a');
    expect(countReportByState).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(findReportRow).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', resourceId: RAW_ROW.id })
    );
  });

  it('passes ONLY the source-supported filters through — as Dates, plus the page window', async () => {
    const { reader, listReportPage } = build();

    await reader.listReportRows(scope(), {
      state: 'REJECTED',
      search: 'معیوب',
      purchaseDocumentId: '33333333-3333-4333-8333-333333333333',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    });

    expect(listReportPage).toHaveBeenCalledWith(
      'tenant-a',
      {
        state: 'REJECTED',
        search: 'معیوب',
        purchaseDocumentId: '33333333-3333-4333-8333-333333333333',
        createdFrom: new Date('2026-01-01T00:00:00.000Z'),
        createdTo: new Date('2026-02-01T00:00:00.000Z'),
      },
      { skip: 10, take: 10 }
    );
  });

  it('leaves every unstated filter ABSENT — not `undefined`, not a default', async () => {
    const { reader, listReportPage, countReportByState } = build();

    await reader.listReportRows(scope(), {});
    await reader.getReportSummary(scope(), {});

    expect(listReportPage.mock.calls[0][1]).toEqual({});
    expect(countReportByState.mock.calls[0][1]).toEqual({});
  });

  it('refuses an inverted window with a 400 BEFORE any statement is issued', async () => {
    const { reader, listReportPage, countReportByState } = build();

    await expect(
      reader.listReportRows(scope(), {
        createdFrom: '2026-02-01T00:00:00.000Z',
        createdTo: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listReportPage).not.toHaveBeenCalled();

    await expect(
      reader.getReportSummary(scope(), {
        createdFrom: '2026-02-01T00:00:00.000Z',
        createdTo: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(countReportByState).not.toHaveBeenCalled();
  });

  it('clamps the window to the COMMERCE ceiling for a caller that bypassed the DTO', async () => {
    const { reader, listReportPage } = build();

    await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    expect(listReportPage.mock.calls[0][2]).toEqual({ skip: 0, take: 100 });
  });

  it('zero-fills the summary over the CLOSED five-member state set', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({
      total: 1,
      byState: { REQUESTED: 0, APPROVED: 1, RECEIVED_BACK: 0, REFUNDED: 0, REJECTED: 0 },
    });
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findReportRow } = build();
    findReportRow.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope('tenant-b'), RAW_ROW.id)).resolves.toBeNull();
  });

  it('reads the audit family bound to THIS return id — the state-chained order, oldest first', async () => {
    const { reader, auditRead } = build();

    const page = await reader.getReportTimeline(scope(), RAW_ROW.id, {});

    expect(auditRead).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      resource: 'commerce.return_document',
      resourceId: RAW_ROW.id,
      page: 1,
      pageSize: 20,
    });
    expect(page).toEqual({
      items: [
        {
          id: 'evt-1',
          action: 'create',
          actorId: 'user-9',
          success: true,
          reason: null,
          changedFields: [],
          createdAt: '2026-01-05T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });
  });

  it('returns an empty timeline for an unknown row without touching the audit port', async () => {
    const { reader, findReportRow, auditRead } = build();
    findReportRow.mockResolvedValueOnce(null);

    const page = await reader.getReportTimeline(scope(), RAW_ROW.id, {});

    expect(page).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(auditRead).not.toHaveBeenCalled();
  });

  it('never turns a rejected audit read into an empty timeline', async () => {
    const { reader, auditRead } = build();
    auditRead.mockResolvedValueOnce({ status: 'rejected', code: 'AUDIT_READ_FAILED' });

    await expect(reader.getReportTimeline(scope(), RAW_ROW.id, {})).rejects.toMatchObject({
      code: 'AUDIT_READ_FAILED',
    });
  });

  it('projects its detail lines with exact decimal-string quantities', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(row?.lines).toEqual([
      {
        id: '44444444-4444-4444-8444-444444444444',
        purchaseLineId: '55555555-5555-4555-8555-555555555555',
        receiptLineId: '66666666-6666-4666-8666-666666666666',
        quantity: '3.0000',
        createdAt: INSTANT.toISOString(),
      },
    ]);
  });

  it('exposes ONLY the four contract reads — no write, no lifecycle command', async () => {
    const names = Object.getOwnPropertyNames(
      CommerceReturnLifecycleReportingReaderService.prototype
    )
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
