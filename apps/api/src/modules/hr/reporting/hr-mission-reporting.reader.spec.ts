import { BadRequestException } from '@nestjs/common';
import { HrMissionRequestReportingReaderService } from './hr-mission-reporting.reader';
import type { HrMissionRequestReportingScope } from './hr-mission-reporting.contract';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the HR-owned ADAPTER — the approved seam's own
 * contract. One-for-one with the sibling reader specs: projection, tenant scope,
 * filter pass-through (intersection window + employee + duration mode + status),
 * summary honesty (zero-filled over the closed SEVEN-member set), no writes, timeline
 * honesty (existence first, rejection re-thrown, never an empty page).
 */
function scope(tenantId = 'tenant-a'): HrMissionRequestReportingScope {
  return { tenantId };
}

const START_DATE = new Date('2026-09-18T00:00:00.000Z');
const END_DATE = new Date('2026-09-20T00:00:00.000Z');

/** A raw row as the two reporting reads return it — with everything NOT to leak. */
const RAW_ROW: {
  id: string;
  durationMode: 'DAILY';
  locationType: 'OUT_OF_CITY';
  engagementType: 'NON_PROJECT';
  startDate: Date;
  endDate: Date;
  startTime: string | null;
  endTime: string | null;
  destination: string | null;
  description: string | null;
  correctionReason: string | null;
  rejectionReason: string | null;
  submittedRevision: number | null;
  status: 'DRAFT';
  createdAt: Date;
  employee: { id: string; employeeCode: string };
} & Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  employeeId: '22222222-2222-4222-8222-222222222222',
  durationMode: 'DAILY',
  locationType: 'OUT_OF_CITY',
  engagementType: 'NON_PROJECT',
  startDate: START_DATE,
  endDate: END_DATE,
  startTime: null,
  endTime: null,
  destination: 'شیراز',
  description: 'بازدید کارخانه',
  correctionReason: null,
  rejectionReason: null,
  submittedRevision: null,
  status: 'DRAFT',
  approvedAt: null,
  rejectedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-09-10T08:00:00.000Z'),
  updatedAt: new Date('2026-09-10T08:00:00.000Z'),
  employee: { id: '22222222-2222-4222-8222-222222222222', employeeCode: 'E-1042' },
  optionSelections: [{ optionGroupId: 'g', missionOptionId: 'o' }],
};

function build() {
  const listRequestPage = jest.fn().mockResolvedValue([[RAW_ROW], 1]);
  const countByStatus = jest.fn().mockResolvedValue(new Map<string, number>([['DRAFT', 1]]));
  const findRequestById = jest.fn().mockResolvedValue(RAW_ROW);
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
          createdAt: '2026-09-10T08:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  });

  const reader = new HrMissionRequestReportingReaderService(
    { listRequestPage, countByStatus, findRequestById } as never,
    { read: auditRead } as never
  );

  return { reader, listRequestPage, countByStatus, findRequestById, auditRead };
}

describe('HrMissionRequestReportingReaderService — the approved read seam', () => {
  it('projects a raw row onto EXACTLY the contract fields', async () => {
    const { reader } = build();
    const row = await reader.getReportRow(scope(), RAW_ROW.id);
    expect(row).toEqual({
      id: RAW_ROW.id,
      employeeCode: 'E-1042',
      durationMode: 'DAILY',
      locationType: 'OUT_OF_CITY',
      engagementType: 'NON_PROJECT',
      startDate: '2026-09-18',
      endDate: '2026-09-20',
      startTime: null,
      endTime: null,
      destination: 'شیراز',
      description: 'بازدید کارخانه',
      correctionReason: null,
      rejectionReason: null,
      submittedRevision: null,
      status: 'DRAFT',
      createdAt: '2026-09-10T08:00:00.000Z',
    });
    // The whitelist's exclusions are load-bearing, not decoration.
    expect(row).not.toHaveProperty('tenantId');
    expect(row).not.toHaveProperty('employeeId');
    expect(row).not.toHaveProperty('approvedAt');
    expect(row).not.toHaveProperty('rejectedAt');
    expect(row).not.toHaveProperty('cancelledAt');
    expect(row).not.toHaveProperty('updatedAt');
  });

  it('threads the server tenant into EVERY repository and audit call', async () => {
    const { reader, listRequestPage, countByStatus, findRequestById, auditRead } = build();
    await reader.listReportRows(scope('tenant-a'), {});
    await reader.getReportSummary(scope('tenant-a'), {});
    await reader.getReportRow(scope('tenant-a'), RAW_ROW.id);
    await reader.getReportTimeline(scope('tenant-a'), RAW_ROW.id, {});
    expect(listRequestPage).toHaveBeenCalledWith('tenant-a', {}, { skip: 0, take: 20 });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', {});
    expect(findRequestById).toHaveBeenCalledWith('tenant-a', RAW_ROW.id);
    expect(auditRead).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', resource: 'hr.mission', resourceId: RAW_ROW.id })
    );
  });

  it('passes employee, status, duration mode and the window through', async () => {
    const { reader, listRequestPage, countByStatus } = build();
    const query = {
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'IN_APPROVAL' as const,
      durationMode: 'HOURLY' as const,
      from: '2026-09-18',
      to: '2026-09-19',
      page: 2,
      pageSize: 10,
    };
    await reader.listReportRows(scope('tenant-a'), query);
    await reader.getReportSummary(scope('tenant-a'), query);
    const expectedFilter = {
      employeeId: '22222222-2222-4222-8222-222222222222',
      status: 'IN_APPROVAL',
      durationMode: 'HOURLY',
      from: new Date('2026-09-18T00:00:00.000Z'),
      to: new Date('2026-09-19T00:00:00.000Z'),
    };
    expect(listRequestPage).toHaveBeenCalledWith('tenant-a', expectedFilter, {
      skip: 10,
      take: 10,
    });
    expect(countByStatus).toHaveBeenCalledWith('tenant-a', expectedFilter);
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

  it('zero-fills the summary over the CLOSED seven-member set', async () => {
    const { reader } = build();
    const summary = await reader.getReportSummary(scope(), {});
    expect(summary).toEqual({
      total: 1,
      byStatus: {
        DRAFT: 1,
        SUBMITTED: 0,
        IN_APPROVAL: 0,
        CORRECTION_REQUIRED: 0,
        APPROVED: 0,
        REJECTED: 0,
        CANCELLED: 0,
      },
    });
    // Exactly seven keys — no COMPLETED, no PENDING, no invented member.
    expect(Object.keys(summary.byStatus)).toHaveLength(7);
  });

  it('returns null for a foreign row and an empty timeline without audit', async () => {
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
    const names = Object.getOwnPropertyNames(HrMissionRequestReportingReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(names).toEqual(
      ['getReportRow', 'getReportSummary', 'getReportTimeline', 'listReportRows'].sort()
    );
  });
});
