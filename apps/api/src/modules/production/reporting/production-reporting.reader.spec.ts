import { ProductionReportingReaderService } from './production-reporting.reader';
import type { ProductionReportingScope } from './production-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Production-owned ADAPTER — the approved seam's
 * own contract. What this spec proves, one-for-one with the Financial and Commerce
 * reader specs because the properties belong to the seam, not to any one source:
 *
 *  1. PROJECTION — a raw `BomHeader` row (tenantId, actor ids, `comments`, `updatedAt`,
 *     `_count`) crosses the seam as EXACTLY the ten contract fields. The whitelist lives
 *     here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository/audit call:
 *     no method can ask for a row without one.
 *  3. FILTER PASS-THROUGH — only `status`/`search` + the page window reach the
 *     repository; a query the contract does not name never reaches it.
 *  4. SUMMARY HONESTY — counts come from the repository's bounded `groupBy`, zero-filled
 *     over the CLOSED four-member lifecycle set.
 *  5. NO WRITES — the adapter's surface is the four contract reads.
 *  6. TIMELINE HONESTY — existence is proven tenant-scoped first; a rejected audit read
 *     is re-thrown with its code, never an empty page.
 */
function scope(tenantId = 'tenant-a'): ProductionReportingScope {
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
  title: 'BOM for project 42',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: 'user-requester',
  approverUserId: 'user-approver',
  status: 'SUBMITTED',
  managerOpinion: null,
  comments: 'internal note',
  submittedAt: SUBMITTED,
  decidedAt: null,
  decidedByUserId: null,
  createdAt: CREATED,
  updatedAt: new Date('2026-01-11T00:00:00.000Z'),
  _count: { items: 3 },
};

function build() {
  const listWithItemCount = jest.fn().mockResolvedValue({ items: [RAW_ROW], total: 1 });
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

  const reader = new ProductionReportingReaderService(
    { listWithItemCount, countByStatus, findByIdWithItemCount } as never,
    { read: auditRead } as never
  );

  return { reader, listWithItemCount, countByStatus, findByIdWithItemCount, auditRead };
}

describe('ProductionReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the ten contract fields', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'id',
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
    // The internals that must never cross, by name.
    for (const forbidden of [
      'tenantId',
      'updatedAt',
      'requesterUserId',
      'approverUserId',
      'decidedByUserId',
      'comments',
    ]) {
      expect(row ?? {}).not.toHaveProperty(forbidden);
    }
    // Dates cross as ISO strings; the item count is flattened from the bounded `_count`.
    expect(row?.createdAt).toBe(CREATED.toISOString());
    expect(row?.submittedAt).toBe(SUBMITTED.toISOString());
    expect(row?.decidedAt).toBeNull();
    expect(row?.itemCount).toBe(3);
  });

  it('scopes the timeline projection onto EXACTLY the seven contract fields', async () => {
    const { reader } = build();

    const page = await reader.getReportTimeline(scope(), RAW_ROW.id, {});

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      ['id', 'action', 'actorId', 'success', 'reason', 'changedFields', 'createdAt'].sort()
    );
    expect(page.items[0]).not.toHaveProperty('tenantId');
    expect(page.items[0]).not.toHaveProperty('resourceId');
  });

  it('forwards the scope and ONLY the supported filters to every read', async () => {
    const { reader, listWithItemCount, countByStatus, findByIdWithItemCount, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {
      status: 'SUBMITTED',
      search: 'boiler',
      page: 2,
      pageSize: 10,
    });
    await reader.getReportSummary(scope('tenant-a'), { status: 'SUBMITTED', search: 'boiler' });
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(listWithItemCount).toHaveBeenCalledWith('tenant-a', {
      skip: 10,
      take: 10,
      status: 'SUBMITTED',
      search: 'boiler',
    });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      status: 'SUBMITTED',
      search: 'boiler',
    });
    expect(findByIdWithItemCount).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        resource: 'production.bom',
        resourceId: RAW_ROW.id,
      })
    );
  });

  it('clamps the window to the PRODUCTION ceiling for a caller that bypassed the DTO', async () => {
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

  it('forwards the KPI-RUNTIME date-window, and leaves an absent bound ABSENT', async () => {
    // Phase KPI-RUNTIME: the additive `[decidedFrom, decidedTo)` window the governance
    // catalog requires before a period-scoped value may be served. Two properties, both
    // asserted here rather than assumed:
    //   1. a stated bound reaches EVERY read that carries the filter (page and summary),
    //      so a KPI's cohort and its count can never describe different instants;
    //   2. a bound the caller did NOT state is absent from the object entirely — not
    //      `undefined` — which is what keeps every pre-extension caller byte-identical.
    const { reader, listWithItemCount, countByStatus } = build();

    await reader.listReportRows(scope('tenant-a'), {
      decidedFrom: '2026-02-01T00:00:00.000Z',
      decidedTo: '2026-03-01T00:00:00.000Z',
    });
    await reader.getReportSummary(scope('tenant-a'), { decidedTo: '2026-03-01T00:00:00.000Z' });

    expect(listWithItemCount).toHaveBeenCalledWith('tenant-a', {
      skip: 0,
      take: 20,
      decidedFrom: '2026-02-01T00:00:00.000Z',
      decidedTo: '2026-03-01T00:00:00.000Z',
    });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      decidedTo: '2026-03-01T00:00:00.000Z',
    });
    expect(Object.keys(countByStatus.mock.calls[0][1])).toEqual(['decidedTo']);
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

    expect(page).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
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
    const names = Object.getOwnPropertyNames(ProductionReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
