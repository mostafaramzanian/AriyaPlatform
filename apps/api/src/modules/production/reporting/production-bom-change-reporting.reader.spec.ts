import { ProductionBomChangeReportingReaderService } from './production-bom-change-reporting.reader';
import type { ProductionBomChangeReportingScope } from './production-bom-change-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Production-owned ADAPTER — the
 * approved seam's own contract. What this spec proves, one-for-one with the three sibling
 * reader specs because the properties belong to the seam, not to any one source:
 *
 *  1. PROJECTION — a raw `BomChangeRequest` row (tenantId, three actor ids, `notes`,
 *     `requestDate`, `updatedAt`, `_count`) crosses the seam as EXACTLY the eleven
 *     contract fields, and NO detail-row field (original coefficients, deltas) exists on
 *     the projection at all. The whitelist lives here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository/audit call:
 *     no method can ask for a row without one.
 *  3. FILTER PASS-THROUGH — only `bomId`/`projectRef`/`status`/`search` + the page window
 *     reach the repository; a query the contract does not name never reaches it.
 *  4. SUMMARY HONESTY — counts come from the repository's bounded `groupBy`, zero-filled
 *     over the CLOSED four-member lifecycle set.
 *  5. NO WRITES — the adapter's surface is the four contract reads.
 *  6. TIMELINE HONESTY — existence is proven tenant-scoped first, against the change
 *     request's OWN audit resource; a rejected audit read is re-thrown with its code,
 *     never an empty page.
 */
function scope(tenantId = 'tenant-a'): ProductionBomChangeReportingScope {
  return { tenantId };
}

const CREATED = new Date('2026-01-05T00:00:00.000Z');
const SUBMITTED = new Date('2026-01-10T08:00:00.000Z');

/** A raw row as the two reporting reads return it — with everything the report must NOT leak. */
const RAW_ROW: {
  id: string;
  createdAt: Date;
  submittedAt: Date | null;
  decidedAt: Date | null;
  _count: { items: number };
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  bomId: '22222222-2222-4222-8222-222222222222',
  title: 'تغییر اقلام پروژه ۴۲',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: 'user-requester',
  approverUserId: 'user-approver',
  status: 'SUBMITTED',
  managerOpinion: null,
  notes: 'internal remark',
  requestDate: CREATED,
  submittedAt: SUBMITTED,
  decidedAt: null,
  decidedByUserId: null,
  createdAt: CREATED,
  updatedAt: new Date('2026-01-11T00:00:00.000Z'),
  _count: { items: 3 },
};

function build() {
  const listWithItemCount = jest.fn().mockResolvedValue({ requests: [RAW_ROW], total: 1 });
  const countByStatus = jest.fn().mockResolvedValue(new Map<string, number>([['SUBMITTED', 1]]));
  const findByIdWithItemCount = jest.fn().mockResolvedValue(RAW_ROW);
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
          createdAt: '2026-01-10T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new ProductionBomChangeReportingReaderService(
    { listWithItemCount, countByStatus, findByIdWithItemCount } as never,
    { read: auditRead } as never
  );

  return { reader, listWithItemCount, countByStatus, findByIdWithItemCount, auditRead };
}

describe('ProductionBomChangeReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the eleven contract fields', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'id',
        'bomId',
        'title',
        'projectRef',
        'productTreeRef',
        'status',
        'managerOpinion',
        'itemCount',
        'submittedAt',
        'decidedAt',
        'createdAt',
      ].sort()
    );
  });

  it('leaks NOTHING else — no tenant, no actor ids, no notes, no bookkeeping, no raw Date', async () => {
    const { reader } = build();
    const row = (await reader.getReportRow(scope(), RAW_ROW.id)) as unknown as Record<
      string,
      unknown
    >;

    for (const key of [
      'tenantId',
      'requesterUserId',
      'approverUserId',
      'decidedByUserId',
      'notes',
      'requestDate',
      'updatedAt',
    ]) {
      expect({ key, present: key in row }).toEqual({ key, present: false });
    }
    // The detail rows' coefficient snapshots are not part of this projection AT ALL —
    // not flattened, not nested, not reachable by any spelling.
    for (const key of ['items', 'originalDrawingCoefficient', 'drawingCoefficientDelta']) {
      expect({ key, present: key in row }).toEqual({ key, present: false });
    }
    // Instants cross as ISO strings, never as `Date` (the wire form every sibling uses).
    expect(typeof row.createdAt).toBe('string');
    expect(row.createdAt).toBe(CREATED.toISOString());
  });

  it('forwards the tenant scope to every repository and audit call', async () => {
    const { reader, listWithItemCount, countByStatus, findByIdWithItemCount, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(listWithItemCount).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(findByIdWithItemCount).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', resourceId: RAW_ROW.id })
    );
  });

  it("passes ONLY the register's four filters + the window through — the contract vocabulary", async () => {
    const { reader, listWithItemCount, countByStatus } = build();
    const query = {
      bomId: '22222222-2222-4222-8222-222222222222',
      projectRef: '42',
      status: 'APPROVED' as const,
      search: 'تغییر',
      page: 2,
      pageSize: 10,
    };

    await reader.listReportRows(scope('tenant-a'), query);
    await reader.getReportSummary(scope('tenant-a'), query);

    expect(listWithItemCount).toHaveBeenCalledWith('tenant-a', {
      skip: 10,
      take: 10,
      bomId: '22222222-2222-4222-8222-222222222222',
      projectRef: '42',
      status: 'APPROVED',
      search: 'تغییر',
    });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      bomId: '22222222-2222-4222-8222-222222222222',
      projectRef: '42',
      status: 'APPROVED',
      search: 'تغییر',
    });
  });

  it('clamps the page window to the Production ceiling — for a caller that bypassed the DTO', async () => {
    const { reader, listWithItemCount } = build();

    await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    const window = listWithItemCount.mock.calls[0][1];
    expect(window).toEqual({ skip: 0, take: 100 });
  });

  it('zero-fills the summary over the CLOSED four-member lifecycle set', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({
      total: 1,
      byStatus: { DRAFT: 0, SUBMITTED: 1, APPROVED: 0, REJECTED: 0 },
    });
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findByIdWithItemCount } = build();
    findByIdWithItemCount.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope(), RAW_ROW.id)).resolves.toBeNull();
  });

  it('returns an empty timeline for an unknown row without touching the audit port', async () => {
    const { reader, findByIdWithItemCount, auditRead } = build();
    findByIdWithItemCount.mockResolvedValueOnce(null);

    const page = await reader.getReportTimeline(scope(), RAW_ROW.id, {});

    expect(page).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(auditRead).not.toHaveBeenCalled();
  });

  it('binds the timeline to the CHANGE REQUEST audit resource — not the header one', async () => {
    const { reader, auditRead } = build();

    await reader.getReportTimeline(scope(), RAW_ROW.id, {});

    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'production.bom.change' })
    );
  });

  it('never turns a rejected audit read into an empty timeline', async () => {
    const { reader, auditRead } = build();
    auditRead.mockResolvedValueOnce({ status: 'rejected', code: 'AUDIT_READ_FAILED' });

    await expect(reader.getReportTimeline(scope(), RAW_ROW.id, {})).rejects.toMatchObject({
      code: 'AUDIT_READ_FAILED',
    });
  });

  it('exposes ONLY the four contract reads — no write, no lifecycle command', () => {
    const names = Object.getOwnPropertyNames(ProductionBomChangeReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
  it('drops an EMPTY search — an empty string is "no search", not "search for nothing"', async () => {
    const { reader, listWithItemCount } = build();

    await reader.listReportRows(scope('tenant-a'), { search: '' });

    expect(Object.keys(listWithItemCount.mock.calls[0][1])).toEqual(['skip', 'take']);
  });
});
