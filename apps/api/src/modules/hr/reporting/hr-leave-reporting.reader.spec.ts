import { BadRequestException } from '@nestjs/common';
import { HrLeaveRequestReportingReaderService } from './hr-leave-reporting.reader';
import type { HrLeaveRequestReportingScope } from './hr-leave-reporting.contract';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the HR-owned ADAPTER — the approved seam's own
 * contract. One-for-one with the sibling reader specs: projection, tenant scope,
 * filter pass-through (intersection window + employee + type + status), summary
 * honesty (zero-filled over the closed four-member set), no writes, timeline
 * honesty (existence first, rejection re-thrown, never an empty page).
 */
function scope(tenantId = 'tenant-a'): HrLeaveRequestReportingScope {
  return { tenantId };
}

const START_DATE = new Date('2026-09-18T00:00:00.000Z');
const END_DATE = new Date('2026-09-20T00:00:00.000Z');

/** A raw row as the two reporting reads return it — with everything NOT to leak. */
const RAW_ROW: {
  id: string;
  startDate: Date;
  endDate: Date;
  reason: string;
  status: 'PENDING';
  createdAt: Date;
  cancelledAt: Date | null;
  employee: { id: string; employeeCode: string };
  leaveType: { id: string; code: string; name: string; status: string };
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  employeeId: '22222222-2222-4222-8222-222222222222',
  leaveTypeId: '33333333-3333-4333-8333-333333333333',
  startDate: START_DATE,
  endDate: END_DATE,
  reason: 'reason-a',
  status: 'PENDING',
  approvedAt: null,
  rejectedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-09-10T08:00:00.000Z'),
  updatedAt: new Date('2026-09-10T08:00:00.000Z'),
  employee: { id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1042' },
  leaveType: { id: '33333333-3333-4333-8333-333333333333', code: 'ANNUAL', name: 'name-a', status: 'ACTIVE' },
};

function build() {
  const listRequestPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countByStatus = jest.fn().mockResolvedValue(new Map<string, number>([['PENDING', 1]]));
  const findRequestById = jest.fn().mockResolvedValue(RAW_ROW);
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
          createdAt: '2026-09-10T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new HrLeaveRequestReportingReaderService(
    { listRequestPage, countByStatus, findRequestById } as never,
    { read: auditRead } as never
  );

  return { reader, listRequestPage, countByStatus, findRequestById, auditRead };
}
describe('HrLeaveRequestReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the contract fields', async () => {
    const { reader } = build();
    const row = await reader.getReportRow(scope(), RAW_ROW.id);
    expect(row).toEqual({
      id: RAW_ROW.id,
      employeeCode: 'E-1042',
      leaveTypeCode: 'ANNUAL',
      leaveTypeName: 'name-a',
      startDate: '2026-09-18',
      endDate: '2026-09-20',
      reason: 'reason-a',
      status: 'PENDING',
      createdAt: '2026-09-10T08:00:00.000Z',
      cancelledAt: null,
    });
    expect(row).not.toHaveProperty('tenantId');
    expect(row).not.toHaveProperty('approvedAt');
    expect(row).not.toHaveProperty('updatedAt');
  });

  it('forwards the tenant scope to every repository and audit call', async () => {
    const { reader, listRequestPage, countByStatus, findRequestById, auditRead } = build();
    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});
    expect(listRequestPage).toHaveBeenCalledWith('tenant-a', {}, { skip: 0, take: 20 });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {});
    expect(findRequestById).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', resource: 'hr.leave', resourceId: RAW_ROW.id })
    );
  });

  it('passes employee, type, status and the window through', async () => {
    const { reader, listRequestPage, countByStatus } = build();
    const query = {
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'PENDING' as const,
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    };
    await reader.listReportRows(scope('tenant-a'), query);
    await reader.getReportSummary(scope('tenant-a'), query);
    expect(listRequestPage).toHaveBeenCalledWith(
      'tenant-a',
      {
        employeeId: '22222222-2222-4222-8222-222222222222',
        status: 'PENDING',
        from: new Date('2026-09-18T00:00:00.000Z'),
        to: new Date('2026-09-19T00:00:00.000Z'),
      },
      { skip: 10, take: 10 }
    );
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'PENDING',
      from: new Date('2026-09-18T00:00:00.000Z'),
      to: new Date('2026-09-19T00:00:00.000Z'),
    });
  });

  it('refuses an inverted window and an impossible day with a 400', async () => {
    const { reader } = build();
    await expect(
      reader.listReportRows(scope(), { from: '2026-09-19', to: '2026-09-18' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(reader.listReportRows(scope(), { from: '2026-02-31' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('zero-fills the summary over the CLOSED four-member set', async () => {
    const { reader } = build();
    const summary = await reader.getReportSummary(scope(), {});
    expect(summary).toEqual({
      total: 1,
      byStatus: { PENDING: 1, APPROVED: 0, REJECTED: 0, CANCELLED: 0 },
    });
  });

  it('returns null for a foreign row and empty timeline without audit', async () => {
    const { reader, findRequestById, auditRead } = build();
    findRequestById.mockResolvedValueOnce(null);
    await expect(reader.getReportRow(scope(), RAW_ROW.id)).resolves.toBeNull();
    findRequestById.mockResolvedValueOnce(null);
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

  it('exposes ONLY the four contract reads', () => {
    const names = Object.getOwnPropertyNames(HrLeaveRequestReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
