import { BadRequestException } from '@nestjs/common';
import { HrPersonnelTrafficReportingReaderService } from './hr-personnel-traffic-reporting.reader';
import type { HrPersonnelTrafficReportingScope } from './hr-personnel-traffic-reporting.contract';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the HR-owned ADAPTER — the approved seam's own
 * contract. One-for-one with the Financial, Commerce and Production reader specs,
 * because the properties belong to the seam, not to any one source:
 *
 *  1. PROJECTION — a raw `Attendance` row (tenantId, employeeId, updatedAt, the employee
 *     relation) crosses the seam as EXACTLY the eight contract fields. The whitelist lives
 *     here, so it is asserted here.
 *  2. TENANT SCOPE — the scope is forwarded verbatim to every repository/audit call.
 *  3. FILTER PASS-THROUGH — the day window (resolved through the REGISTER's own
 *     `attendance-window.ts`), `source` and `search` reach the repository; nothing else.
 *  4. SUMMARY HONESTY — counts come from the repository's bounded `groupBy`, zero-filled
 *     over the CLOSED two-member source set.
 *  5. NO WRITES — the adapter's surface is the four contract reads.
 *  6. TIMELINE HONESTY — existence is proven tenant-scoped first; a rejected audit read
 *     is re-thrown with its code, never an empty page.
 */
function scope(tenantId = 'tenant-a'): HrPersonnelTrafficReportingScope {
  return { tenantId };
}

const WORK_DATE = new Date('2026-09-18T00:00:00.000Z');
const CLOCK_IN = new Date('2026-09-18T08:00:00.000Z');

/** A raw row as the two reporting reads return it — with everything the report must NOT leak. */
const RAW_ROW: {
  id: string;
  workDate: Date;
  dateKey: string;
  clockIn: Date;
  clockOut: Date | null;
  source: 'DEVICE' | 'MANUAL';
  reason: string | null;
  employee: { id: string; employeeCode: string };
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  employeeId: '22222222-2222-4222-8222-222222222222',
  workDate: WORK_DATE,
  dateKey: '1405/06/27',
  clockIn: CLOCK_IN,
  clockOut: new Date('2026-09-18T16:30:00.000Z'),
  source: 'DEVICE',
  reason: null,
  createdAt: new Date('2026-09-18T08:00:02.000Z'),
  updatedAt: new Date('2026-09-18T16:30:05.000Z'),
  employee: { id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1042' },
};

function build() {
  const listPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countBySource = jest.fn().mockResolvedValue(new Map<string, number>([['DEVICE', 1]]));
  const findById = jest.fn().mockResolvedValue(RAW_ROW);
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
          createdAt: '2026-09-18T08:00:02.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new HrPersonnelTrafficReportingReaderService(
    { listPage, countBySource, findById } as never,
    { read: auditRead } as never
  );

  return { reader, listPage, countBySource, findById, auditRead };
}

describe('HrPersonnelTrafficReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the eight contract fields', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(Object.keys(row ?? {}).sort()).toEqual(
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
    expect(row).not.toHaveProperty('tenantId');
    expect(row).not.toHaveProperty('employeeId');
    expect(row).not.toHaveProperty('updatedAt');
    expect(row).not.toHaveProperty('createdAt');
    expect(row).not.toHaveProperty('employee');
  });

  it('renders workDate as a DAY and the punches as ISO INSTANTS — the register’s own wire rules', async () => {
    const { reader } = build();

    const row = await reader.getReportRow(scope(), RAW_ROW.id);

    expect(row).toMatchObject({
      workDate: '2026-09-18',
      dateKey: '1405/06/27',
      clockIn: '2026-09-18T08:00:00.000Z',
      clockOut: '2026-09-18T16:30:00.000Z',
      employeeCode: 'E-1042',
      source: 'DEVICE',
    });
  });

  it('keeps an open day’s clockOut as null — a fact, not a missing value', async () => {
    const open = { ...RAW_ROW, clockOut: null };

    const findById = jest.fn().mockResolvedValue(open);
    const openReader = new HrPersonnelTrafficReportingReaderService(
      { findById } as never,
      {} as never
    );

    const row = await openReader.getReportRow(scope(), RAW_ROW.id);

    expect(row?.clockOut).toBeNull();
    expect(row).not.toHaveProperty('duration');
  });

  it('forwards the scope and ONLY the supported filters to every read', async () => {
    const { reader, listPage, countBySource, findById, auditRead } = build();

    await reader.listReportRows(scope('tenant-a'), {
      from: '2026-09-18',
      to: '2026-09-19',
      source: 'DEVICE',
      search: 'E-10',
      page: 2,
      pageSize: 10,
    });
    await reader.getReportSummary(scope('tenant-a'), { source: 'DEVICE' });
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});

    expect(listPage).toHaveBeenCalledWith(
      'tenant-a',
      {
        from: new Date('2026-09-18T00:00:00.000Z'),
        to: new Date('2026-09-19T00:00:00.000Z'),
        source: 'DEVICE',
        search: 'E-10',
      },
      { skip: 10, take: 10 }
    );
    expect(countBySource).toHaveBeenCalledWith('tenant-a', { source: 'DEVICE' });
    expect(findById).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        resource: 'hr.attendance',
        resourceId: RAW_ROW.id,
      })
    );
  });

  it('resolves the Jalali dateKey into one inclusive day — through the REGISTER’s window', async () => {
    const { reader, listPage } = build();

    await reader.listReportRows(scope(), { dateKey: '1405/06/27' });

    expect(listPage.mock.calls[0][1]).toEqual({
      from: new Date('2026-09-18T00:00:00.000Z'),
      to: new Date('2026-09-18T00:00:00.000Z'),
    });

    // The register refuses a contradictory window with a 400 — the SAME 400 here,
    // because both surfaces call the one implementation in attendance-window.ts.
    await expect(
      reader.listReportRows(scope(), { dateKey: '1405/06/27', from: '2026-09-18' })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clamps the window to the HR ceiling for a caller that bypassed the DTO', async () => {
    const { reader, listPage } = build();

    await reader.listReportRows(scope(), { page: 0, pageSize: 100_000 });

    expect(listPage.mock.calls[0][2]).toEqual({ skip: 0, take: 100 });
  });

  it('zero-fills the summary over the CLOSED two-member source set', async () => {
    const { reader } = build();

    const summary = await reader.getReportSummary(scope(), {});

    expect(summary).toEqual({ total: 1, bySource: { DEVICE: 1, MANUAL: 0 } });
  });

  it('returns null for a row the tenant does not hold — never a partial row or a throw', async () => {
    const { reader, findById } = build();
    findById.mockResolvedValueOnce(null);

    await expect(reader.getReportRow(scope(), RAW_ROW.id)).resolves.toBeNull();
  });

  it('returns an empty timeline for an unknown row without touching the audit port', async () => {
    const { reader, findById, auditRead } = build();
    findById.mockResolvedValueOnce(null);

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

  it('exposes ONLY the four contract reads — no write, no punch, no correction', () => {
    const names = Object.getOwnPropertyNames(HrPersonnelTrafficReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
