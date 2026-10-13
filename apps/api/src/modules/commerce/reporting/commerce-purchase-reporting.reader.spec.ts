import { CommercePurchaseReportingReaderService } from './commerce-purchase-reporting.reader';
import type {
  CommercePurchaseReportQuery,
  CommerceReportingScope,
} from './commerce-purchase-reporting.contract';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Commerce-owned ADAPTER — the approved seam's own
 * contract. What this spec proves, one-for-one with the Financial reader's spec because
 * the properties belong to the seam, not to Financial:
 *
 *  1. PROJECTION — a raw `PurchaseDocument` row (tenantId, actor ids, version pins,
 *     `updatedAt`, the lines themselves) crosses the seam as EXACTLY the twelve contract
 *     fields. The whitelist lives here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository/audit call:
 *     no method can ask for a row without one.
 *  3. FILTER PASS-THROUGH — only `status`/`search` + the page window reach the
 *     repository; a query the contract does not name never reaches it.
 *  4. SUMMARY HONESTY — counts come from the repository's bounded `groupBy`, zero-filled
 *     over the CLOSED six-member lifecycle set.
 *  5. MONEY HONESTY — `null` totals stay `null`, never `0`.
 *  6. NO WRITES — the adapter's surface is the four contract reads.
 */
function scope(tenantId = 'tenant-a'): CommerceReportingScope {
  return { tenantId };
}

const INSTANT = new Date('2026-01-05T00:00:00.000Z');
const COMPLETED = new Date('2026-01-20T09:30:00.000Z');

/** A raw row as `findDocumentById` returns it — with everything the report must NOT leak. */
const RAW_ROW: {
  id: string;
  completedAt: Date | null;
  createdAt: Date;
  lines: unknown[];
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  documentNumber: 'PR-1404-000123',
  kind: 'PURCHASE_REQUEST',
  status: 'APPROVED',
  requesterId: 'user-9',
  completedByUserId: 'user-4',
  supplierId: 'SUP-77',
  currency: 'IRR',
  subtotalAmount: { toString: () => '1200.0000' },
  taxAmount: { toString: () => '120.0000' },
  totalAmount: { toString: () => '1320.0000' },
  completionPolicyVersionId: 'cpv-1',
  commercialConfigurationVersionId: 'ccv-1',
  lineRoutingVersionId: 'lrv-1',
  createdAt: INSTANT,
  updatedAt: new Date('2026-01-07T00:00:00.000Z'),
  completedAt: COMPLETED,
  lines: [{ id: 'ln-1' }, { id: 'ln-2' }, { id: 'ln-3' }],
};

function build() {
  const listDocumentPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countByStatus = jest.fn().mockResolvedValue(new Map<string, number>([['APPROVED', 1]]));
  const findDocumentById = jest.fn().mockResolvedValue(RAW_ROW);
  const auditRead = jest.fn().mockResolvedValue({
    status: 'recorded',
    page: {
      items: [
        {
          id: 'evt-1',
          action: 'submit',
          actorId: 'user-9',
          success: true,
          reason: null,
          changedFields: [],
          createdAt: '2026-01-06T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new CommercePurchaseReportingReaderService(
    { listDocumentPage, countByStatus, findDocumentById } as never,
    { read: auditRead } as never
  );

  return { reader, listDocumentPage, countByStatus, findDocumentById, auditRead };
}

describe('CommercePurchaseReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the twelve contract fields', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(row).toEqual({
      id: RAW_ROW.id,
      documentNumber: 'PR-1404-000123',
      kind: 'PURCHASE_REQUEST',
      status: 'APPROVED',
      supplierId: 'SUP-77',
      currency: 'IRR',
      subtotalAmount: '1200.0000',
      taxAmount: '120.0000',
      totalAmount: '1320.0000',
      lineCount: 3,
      completedAt: COMPLETED.toISOString(),
      createdAt: INSTANT.toISOString(),
    });
    expect(Object.keys(row as object)).toHaveLength(12);
  });

  it('keeps every omitted column off the wire — scope, actors, pins, updatedAt, lines', async () => {
    const { reader } = build();
    const row = (await reader.getReportRow(scope(), RAW_ROW.id)) as unknown as Record<
      string,
      unknown
    >;

    for (const leaked of [
      'tenantId',
      'requesterId',
      'completedByUserId',
      'updatedAt',
      'completionPolicyVersionId',
      'commercialConfigurationVersionId',
      'lineRoutingVersionId',
      'lines',
    ]) {
      expect({ leaked, present: leaked in row }).toEqual({ leaked, present: false });
    }
  });

  it('keeps an unpriced document NULL — never a zero that claims free items', async () => {
    const { reader, findDocumentById } = build();
    findDocumentById.mockResolvedValueOnce({
      ...RAW_ROW,
      subtotalAmount: null,
      taxAmount: null,
      totalAmount: null,
      completedAt: null,
      lines: [],
    });

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(row).toMatchObject({
      subtotalAmount: null,
      taxAmount: null,
      totalAmount: null,
      completedAt: null,
      lineCount: 0,
    });
  });

  it('forwards the tenant scope to every repository and audit call', async () => {
    const { reader, listDocumentPage, countByStatus, findDocumentById, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(listDocumentPage).toHaveBeenCalledWith('tenant-a', expect.anything(), expect.anything());
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(findDocumentById).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        resource: 'commerce.purchase_document',
        resourceId: RAW_ROW.id,
      })
    );
  });

  it('passes status, search and the KPI date-window through — the contract filter vocabulary', async () => {
    const { reader, listDocumentPage, countByStatus } = build();
    const query: CommercePurchaseReportQuery = {
      status: 'SUBMITTED',
      search: 'PR-1404',
      completedFrom: '2026-02-01T00:00:00.000Z',
      completedTo: '2026-03-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    };

    await reader.listReportRows(scope(), query);
    await reader.getReportSummary(scope(), query);

    expect(listDocumentPage).toHaveBeenCalledWith(
      'tenant-a',
      {
        status: 'SUBMITTED',
        search: 'PR-1404',
        completedFrom: '2026-02-01T00:00:00.000Z',
        completedTo: '2026-03-01T00:00:00.000Z',
      },
      { skip: 10, take: 10 }
    );
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      status: 'SUBMITTED',
      search: 'PR-1404',
      completedFrom: '2026-02-01T00:00:00.000Z',
      completedTo: '2026-03-01T00:00:00.000Z',
    });
  });

  it('leaves every unstated KPI window bound ABSENT — not `undefined`', async () => {
    // Phase KPI-RUNTIME: the extension is additive, and this is the property that makes it
    // so. A caller that names no window must reach the repository with exactly the object
    // it did before the date-window existed, so the register, its summary and the four
    // report surfaces cannot shift behaviour because a new optional field appeared.
    const { reader, listDocumentPage, countByStatus } = build();

    await reader.listReportRows(scope(), { createdFrom: '2026-02-01T00:00:00.000Z' });
    await reader.getReportSummary(scope(), {});

    expect(listDocumentPage).toHaveBeenCalledWith(
      'tenant-a',
      { createdFrom: '2026-02-01T00:00:00.000Z' },
      { skip: 0, take: 20 }
    );
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {});
  });

  it('clamps the window to the COMMERCE ceiling for a caller that bypassed the DTO', async () => {
    const { reader, listDocumentPage } = build();

    await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    const window = listDocumentPage.mock.calls[0][2];
    expect(window).toEqual({ skip: 0, take: 100 });
  });

  it('zero-fills the summary over the CLOSED six-member lifecycle set', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({
      total: 1,
      byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 1, REJECTED: 0, CANCELLED: 0, CLOSED: 0 },
    });
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findDocumentById } = build();
    findDocumentById.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope(), RAW_ROW.id)).resolves.toBeNull();
  });

  it('returns an empty timeline for an unknown row without touching the audit port', async () => {
    const { reader, findDocumentById, auditRead } = build();
    findDocumentById.mockResolvedValueOnce(null);

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

  it('exposes ONLY the four contract reads — no write, no lifecycle command', () => {
    const names = Object.getOwnPropertyNames(CommercePurchaseReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
