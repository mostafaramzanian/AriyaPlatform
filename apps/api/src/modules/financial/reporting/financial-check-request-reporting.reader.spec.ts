import { FinancialCheckRequestReportingReaderService } from './financial-check-request-reporting.reader';
import type {
  FinancialCheckRequestReportQuery,
  FinancialReportingScope,
} from './financial-check-request-reporting.contract';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Financial-owned ADAPTER — the
 * approved seam's own contract. What this spec proves:
 *
 *  1. PROJECTION — a raw Financial row (tenantId, actor ids, createdAt,
 *     updatedAt, process pin) crosses the seam as EXACTLY the twelve
 *     contract fields. The whitelist lives here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every
 *     repository/audit call: no method can ask for a row without one.
 *  3. FILTER PASS-THROUGH — only `status`/`search` + the page window reach
 *     the repository; a query the contract does not name never reaches it.
 *  4. SUMMARY HONESTY — counts come from the repository's bounded
 *     `groupBy`, zero-filled over the CLOSED lifecycle set.
 *  5. NO WRITES — the adapter's surface is the four contract reads.
 */
function scope(tenantId = 'tenant-a'): FinancialReportingScope {
  return { tenantId };
}

const RAW_ROW: {
  id: string;
  requestDate: Date;
  submittedAt: Date;
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  title: 'صدور چک برای خرید پروژه ای',
  checkIssueType: 'PURCHASE',
  purchaseType: 'PROJECT',
  orderReference: 'PO-1',
  projectReference: 'PRJ-1',
  projectManagerUserId: 'pm-1',
  requesterUserId: 'user-9',
  requesterOpinion: 'CONTINUE',
  processPin: 'pin',
  status: 2,
  managerDecision: null,
  managerComment: null,
  decidedByUserId: null,
  decidedAt: null,
  submittedAt: new Date('2026-01-06T08:00:00.000Z'),
  requestDate: new Date('2026-01-05T00:00:00.000Z'),
  createdAt: new Date('2026-01-05T00:00:00.000Z'),
  updatedAt: new Date('2026-01-07T00:00:00.000Z'),
};

function build() {
  const list = jest.fn().mockResolvedValue({ items: [RAW_ROW], total: 1 });
  const countByStatus = jest.fn().mockResolvedValue(new Map<number, number>([[2, 1]]));
  const findWithStages = jest.fn().mockResolvedValue(RAW_ROW);
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

  const reader = new FinancialCheckRequestReportingReaderService(
    { list, countByStatus, findWithStages } as never,
    { read: auditRead } as never
  );

  return { reader, list, countByStatus, findWithStages, auditRead };
}

describe('FinancialCheckRequestReportingReaderService — the approved read seam', () => {
  it('projects a raw Financial row onto EXACTLY the twelve contract fields', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(row).toEqual({
      id: RAW_ROW.id,
      title: RAW_ROW.title,
      checkIssueType: 'PURCHASE',
      purchaseType: 'PROJECT',
      orderReference: 'PO-1',
      projectReference: 'PRJ-1',
      requestDate: RAW_ROW.requestDate.toISOString(),
      requesterOpinion: 'CONTINUE',
      status: 2,
      managerDecision: null,
      submittedAt: RAW_ROW.submittedAt.toISOString(),
      decidedAt: null,
    });
    for (const forbidden of [
      'tenantId',
      'requesterUserId',
      'decidedByUserId',
      'projectManagerUserId',
      'createdAt',
      'updatedAt',
      'managerComment',
      'processPin',
    ]) {
      expect(row ?? {}).not.toHaveProperty(forbidden);
    }
  });

  it('scopes every source call by the supplied tenant — never by id alone', async () => {
    const { reader, list, countByStatus, findWithStages, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(list).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(findWithStages).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        resource: 'financial.check-request',
      })
    );
  });

  it('passes status, search and the KPI date-window through — the contract filter vocabulary', async () => {
    const { reader, list, countByStatus } = build();
    const query: FinancialCheckRequestReportQuery = {
      status: 2,
      search: 'gearbox',
      decidedFrom: '2026-02-01T00:00:00.000Z',
      decidedTo: '2026-03-01T00:00:00.000Z',
      page: 2,
      pageSize: 10,
    };

    await reader.listReportRows(scope(), query);
    await reader.getReportSummary(scope(), query);

    expect(list).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        skip: 10,
        take: 10,
        status: 2,
        search: 'gearbox',
        decidedFrom: '2026-02-01T00:00:00.000Z',
        decidedTo: '2026-03-01T00:00:00.000Z',
      })
    );
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      status: 2,
      search: 'gearbox',
      decidedFrom: '2026-02-01T00:00:00.000Z',
      decidedTo: '2026-03-01T00:00:00.000Z',
    });
  });

  it('leaves an unstated KPI window bound ABSENT — the extension is additive', async () => {
    // Phase KPI-RUNTIME: a caller that names no window must reach the repository with
    // exactly the key set it did before the extension, so the register, its summary and
    // the four report surfaces are byte-identical (this is the assertion that proves it,
    // key by key, rather than the comment above the contract claiming it).
    const { reader, list, countByStatus } = build();

    await reader.listReportRows(scope(), { status: 2 });
    await reader.getReportSummary(scope(), { status: 2 });

    const listKeys = Object.keys((list as jest.Mock).mock.calls[0][1]).sort();
    expect(listKeys).toEqual(['skip', 'status', 'take']);
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', { status: 2 });
  });

  it('zero-fills the summary over the CLOSED lifecycle set — 0, never undefined', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary.total).toBe(1);
    expect(summary.byStatus).toEqual({
      '0': 0,
      '1': 0,
      '2': 1,
      '3': 0,
      '4': 0,
      '5': 0,
      '6': 0,
      '7': 0,
      '8': 0,
      '50': 0,
    });
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findWithStages } = build();
    findWithStages.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope(), RAW_ROW.id)).resolves.toBeNull();
  });

  it('returns an empty timeline for an unknown row without touching the audit port', async () => {
    const { reader, findWithStages, auditRead } = build();
    findWithStages.mockResolvedValueOnce(null);

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
    const names = Object.getOwnPropertyNames(FinancialCheckRequestReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
