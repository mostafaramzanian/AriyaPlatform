import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceRepository } from './attendance.repository';
import { HrActor } from '../hr-actor';

/**
 * Phase 51-HR-3: the attendance register's RULES, pinned without a database.
 *
 * WHAT THIS FILE IS FOR. The composite `Attendance_tenant_employee_fkey`, the unique key
 * `(tenant_id, employee_id, work_date, source)` and the three CHECKs are the real
 * guarantees and they live in `hr_db` — `hr-runtime.e2e-spec.ts` asserts each of them
 * exists, and `hr.e2e-spec.ts` exercises them through HTTP. This file pins what the
 * SERVICE decides, which is the part no constraint can express:
 *
 *   * the DAY of a punch is DERIVED in `APP_TIME_ZONE` (§8/§13), so 20:30Z belongs to the
 *     NEXT Jalali day — a fact about the zone, not about the client;
 *   * a second clock-in for the same employee-day is a 409 naming the adjustment route,
 *     and the loser of a concurrent insert (a raw `P2002`) gets the SAME 409 rather than
 *     a 500;
 *   * the employee is resolved FIRST (404/409 before any write), so a refusal never
 *     leaves a row behind;
 *   * a correction writes the `MANUAL` row through a statement whose key CONTAINS
 *     `source: 'MANUAL'`, which is why it cannot edit the `DEVICE` evidence (§13);
 *   * the day filter resolves a Jalali day and a Gregorian range to the SAME inclusive
 *     bounds, and refuses two answers to "which days?".
 *
 * A FAKE CLIENT AND THE REAL REPOSITORY, deliberately: the assertions below read the
 * `where`/`data` the database would receive, instead of a hand-rolled expectation about
 * some other query shape.
 */

const TENANT = 'tenant-a';
const EMPLOYEE_ID = '6f1c2f2a-0f0e-4a1c-9c1e-8f2b1d3a4c5e';

/** 08:00 in Tehran on 27 Shahrivar 1405 — the ordinary morning punch. */
const CLOCK_IN = '2026-09-18T04:30:00.000Z';
/** 17:00 in Tehran the same day. */
const CLOCK_OUT = '2026-09-18T13:30:00.000Z';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

/** A Prisma unique-constraint violation, as the driver raises it. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: 'Attendance_tenantId_employeeId_workDate_source_key' },
  });
}

interface FakeHrPrisma {
  attendance: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    upsert: jest.Mock;
  };
  $transaction: jest.Mock;
}

function makeService() {
  const prisma: FakeHrPrisma = {
    attendance: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (arg: unknown): Promise<unknown> =>
      Promise.all(arg as Promise<unknown>[])
    ),
  };

  const employees = { findById: jest.fn() };
  const audit = { record: jest.fn() };

  const service = new AttendanceService(
    new AttendanceRepository(prisma as never),
    employees as never,
    audit as never
  );

  return { service, prisma, employees, audit };
}

/** The row a successful write returns, as the repository would hand it back. */
const createdRow = {
  id: 'att-1',
  tenantId: TENANT,
  employeeId: EMPLOYEE_ID,
  workDate: new Date('2026-09-18T00:00:00.000Z'),
  dateKey: '1405/06/27',
  clockIn: new Date(CLOCK_IN),
  clockOut: null,
  source: 'DEVICE',
  reason: null,
  createdAt: new Date(CLOCK_IN),
  updatedAt: new Date(CLOCK_IN),
  employee: { id: EMPLOYEE_ID, employeeCode: 'E-1042' },
};

describe('AttendanceService.clockIn — the day is derived, and one day has one punch', () => {
  it('derives workDate and dateKey in APP_TIME_ZONE from the instant, and audits the act', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue(null);
    prisma.attendance.create.mockResolvedValue(createdRow);

    const row = await service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN });

    // The employee was checked in the ACTOR's tenant, by the one tenant-scoped read.
    expect(employees.findById).toHaveBeenCalledWith(TENANT, EMPLOYEE_ID);

    // The DERIVED day, not a field the caller sent: 04:30Z is 08:00 in Tehran on
    // 27 Shahrivar 1405, and `work_date` is that day as a UTC-midnight DATE.
    const call = prisma.attendance.create.mock.calls[0][0];
    expect(call.data.tenantId).toBe(TENANT);
    expect(call.data.source).toBe('DEVICE');
    expect(call.data.workDate.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(call.data.dateKey).toBe('1405/06/27');
    expect(call.data.clockOut).toBeNull();

    expect(row.id).toBe('att-1');
    // THE WIRE VIEW: the derived day leaves the service as a DAY, while the punch leaves as an
    // instant. `workDate` is a `@db.Date` column — "midnight UTC" is not the day a reader in
    // Tehran is in — and `clockIn` is a moment, which a stripped offset would change.
    expect(row.workDate).toBe('2026-09-18');
    expect(row.clockIn).toEqual(new Date(CLOCK_IN));
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'create',
      resource: 'hr.attendance',
      resourceId: 'att-1',
    });
  });

  it('attributes a late-evening instant to the NEXT Jalali day, because the zone is named', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue(null);
    prisma.attendance.create.mockResolvedValue(createdRow);

    // 2026-09-18T20:30Z is 2026-09-19T00:00 in Asia/Tehran — midnight of Shahrivar 28.
    // A server that trusted UTC (or an ambient TZ, which the api image leaves empty)
    // would file this punch on the previous day.
    await service.clockIn(ACTOR, {
      employeeId: EMPLOYEE_ID,
      clockIn: '2026-09-18T20:30:00.000Z',
    });

    expect(prisma.attendance.create.mock.calls[0][0].data.dateKey).toBe('1405/06/28');
    expect(prisma.attendance.create.mock.calls[0][0].data.workDate.toISOString()).toBe(
      '2026-09-19T00:00:00.000Z'
    );
    // …and the duplicate pre-check pressed on the SAME derived day.
    expect(prisma.attendance.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        employeeId: EMPLOYEE_ID,
        workDate: new Date('2026-09-19T00:00:00.000Z'),
        source: 'DEVICE',
      },
      select: { id: true, clockIn: true, clockOut: true },
    });
  });

  it('refuses a second punch for the same employee-day with a 409, writing nothing', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue({ id: 'att-existing', clockOut: null });

    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.attendance.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('translates the loser of a concurrent insert (P2002) into the same 409', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue(null);
    prisma.attendance.create.mockRejectedValue(uniqueViolation());

    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.attendance.create).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does NOT report an unrelated database failure as a conflict', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue(null);
    const outage = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    prisma.attendance.create.mockRejectedValue(outage);

    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).rejects.toBe(outage);
  });
});

describe('AttendanceService — who a punch may be recorded for', () => {
  it('answers 404 for an employee of ANOTHER tenant, from the tenant-scoped read alone', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue(null);

    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).rejects.toBeInstanceOf(NotFoundException);

    // The tenant went into the READ, so another tenant's employee is simply absent —
    // and nothing was written or audited on the way to the refusal.
    expect(employees.findById).toHaveBeenCalledWith(TENANT, EMPLOYEE_ID);
    expect(prisma.attendance.findFirst).not.toHaveBeenCalled();
    expect(prisma.attendance.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a TERMINATED employee with a 409, before any attendance row is touched', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'TERMINATED' });

    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.attendance.findFirst).not.toHaveBeenCalled();
  });

  it('accepts an INACTIVE employee: the label is administrative, not a bar to being at work', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'INACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue(null);
    prisma.attendance.create.mockResolvedValue(createdRow);

    // Accepted, and the row comes back as the WIRE VIEW — the same facts, with the stored day
    // rendered as the day it is (see `AttendanceService.serialize`).
    await expect(
      service.clockIn(ACTOR, { employeeId: EMPLOYEE_ID, clockIn: CLOCK_IN })
    ).resolves.toMatchObject({ id: 'att-1', source: 'DEVICE', workDate: '2026-09-18' });
  });
});

describe('AttendanceService.clockOut — only an open punch closes, and only forwards', () => {
  it('closes an open punch and audits the transition', async () => {
    const { service, prisma, audit } = makeService();
    prisma.attendance.findFirst.mockResolvedValue({
      ...createdRow,
      source: 'DEVICE',
      clockOut: null,
    });
    prisma.attendance.update.mockResolvedValue({
      ...createdRow,
      clockOut: new Date(CLOCK_OUT),
    });

    await service.clockOut(ACTOR, 'att-1', { clockOut: CLOCK_OUT });

    // The tenant-scoped read happened first, and the write is the id-only UPDATE whose
    // row that read established.
    expect(prisma.attendance.findFirst).toHaveBeenCalledWith({
      where: { id: 'att-1', tenantId: TENANT },
      include: { employee: { select: { id: true, employeeCode: true } } },
    });
    expect(prisma.attendance.update).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      data: { clockOut: new Date(CLOCK_OUT) },
      include: { employee: { select: { id: true, employeeCode: true } } },
    });
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'update',
      resource: 'hr.attendance',
      changedFields: ['clockOut'],
    });
  });

  it('refuses a day that is already closed', async () => {
    const { service, prisma, audit } = makeService();
    prisma.attendance.findFirst.mockResolvedValue({
      ...createdRow,
      clockOut: new Date(CLOCK_OUT),
    });

    await expect(service.clockOut(ACTOR, 'att-1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.attendance.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a clock-out that runs backwards', async () => {
    const { service, prisma } = makeService();
    prisma.attendance.findFirst.mockResolvedValue({ ...createdRow, clockOut: null });

    await expect(
      service.clockOut(ACTOR, 'att-1', { clockOut: '2026-09-18T04:00:00.000Z' })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.attendance.update).not.toHaveBeenCalled();
  });

  it('refuses to clock out a MANUAL correction, which states its own window', async () => {
    const { service, prisma } = makeService();
    prisma.attendance.findFirst.mockResolvedValue({
      ...createdRow,
      source: 'MANUAL',
      reason: 'دستگاه خراب بود',
      clockOut: null,
    });

    await expect(service.clockOut(ACTOR, 'att-1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.attendance.update).not.toHaveBeenCalled();
  });
});

describe('AttendanceService.adjust — a correction is a ROW, never an edit of the evidence', () => {
  it('creates the MANUAL row for the derived day and cannot address the DEVICE row', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    // No correction exists yet for this day…
    prisma.attendance.findFirst.mockResolvedValue(null);
    prisma.attendance.upsert.mockResolvedValue({
      ...createdRow,
      id: 'att-manual',
      source: 'MANUAL',
      reason: 'فراموش کرد ثبت کند',
    });

    const row = await service.adjust(ACTOR, {
      employeeId: EMPLOYEE_ID,
      clockIn: CLOCK_IN,
      clockOut: CLOCK_OUT,
      reason: 'فراموش کرد ثبت کند',
    });

    const call = prisma.attendance.upsert.mock.calls[0][0];
    // THE KEY IS THE GUARANTEE: it contains the tenant, the employee, the DERIVED day and
    // `source: 'MANUAL'` — so the DEVICE row for that day is not reachable from here,
    // whatever the payload says (§13).
    expect(call.where.tenantId_employeeId_workDate_source).toEqual({
      tenantId: TENANT,
      employeeId: EMPLOYEE_ID,
      workDate: new Date('2026-09-18T00:00:00.000Z'),
      source: 'MANUAL',
    });
    expect(call.create.source).toBe('MANUAL');
    expect(call.update.source).toBeUndefined();
    expect(call.create.dateKey).toBe('1405/06/27');

    expect(row.id).toBe('att-manual');
    // The reason is carried on the AUDIT event as well as the row (§13): it is stated once
    // by the caller and recorded in both places it is needed. (`TrimmedReason` on the DTO
    // is where "sanitized" starts; the service writes what it was given.)
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'adjust',
      resource: 'hr.attendance',
      reason: 'فراموش کرد ثبت کند',
    });
  });

  it('restates the ONE correction a day may carry, reporting the previous window', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.attendance.findFirst.mockResolvedValue({
      id: 'att-manual',
      clockIn: new Date(CLOCK_IN),
      clockOut: null,
    });
    prisma.attendance.upsert.mockResolvedValue({
      ...createdRow,
      id: 'att-manual',
      source: 'MANUAL',
      clockOut: new Date(CLOCK_OUT),
      reason: 'اصلاح بعد از بررسی',
    });

    await service.adjust(ACTOR, {
      employeeId: EMPLOYEE_ID,
      clockIn: CLOCK_IN,
      clockOut: CLOCK_OUT,
      reason: 'اصلاح بعد از بررسی',
    });

    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1].oldValue).toEqual({
      clockIn: CLOCK_IN,
      clockOut: null,
    });
  });

  it('refuses a correction whose window runs backwards, with a 400', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });

    await expect(
      service.adjust(ACTOR, {
        employeeId: EMPLOYEE_ID,
        clockIn: CLOCK_OUT,
        clockOut: CLOCK_IN,
        reason: 'غلط',
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it('answers 404 for a correction against ANOTHER tenant\u2019s employee', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue(null);

    await expect(
      service.adjust(ACTOR, {
        employeeId: EMPLOYEE_ID,
        clockIn: CLOCK_IN,
        reason: 'دستگاه خراب بود',
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });
});

describe('AttendanceService.list — one day filter, two spellings, no ambiguity', () => {
  it('resolves a Jalali dateKey to the SAME inclusive Gregorian bounds as from = to', async () => {
    const { service, prisma } = makeService();
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.attendance.count.mockResolvedValue(0);

    await service.list(ACTOR, { dateKey: '1405/06/27' });

    const where = prisma.attendance.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
    // 27 Shahrivar 1405 is 18 September 2026 — the SAME day the punch derives, so the day
    // view and the punch path cannot disagree about which day a row belongs to.
    expect(where.workDate.gte.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(where.workDate.lte.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('renders the day as a DAY on the wire, while the punches stay instants', async () => {
    const { service, prisma } = makeService();
    prisma.attendance.findMany.mockResolvedValue([createdRow]);
    prisma.attendance.count.mockResolvedValue(1);

    const page = await service.list(ACTOR, { dateKey: '1405/06/27' });

    // `work_date` is a `@db.Date` column: the DAY is what a register talks in, and a timestamp
    // for it would mean midnight UTC to a reader in Tehran — the ambiguity `dateKey` exists to
    // remove. The punches are moments, so they keep their instants.
    expect(page.items[0].workDate).toBe('2026-09-18');
    expect(page.items[0].clockIn).toEqual(new Date(CLOCK_IN));
    expect(page.items[0].dateKey).toBe('1405/06/27');
  });

  it('refuses dateKey combined with from/to rather than letting one silently win', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.list(ACTOR, { dateKey: '1405/06/27', from: '2026-09-01' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it('refuses a well-shaped dateKey that is not a real Jalali date', async () => {
    const { service } = makeService();

    // The DTO's pattern accepts 1405/13/45; only the calendar can say it is not a date,
    // which is why the service parses it instead of trusting the shape.
    await expect(service.list(ACTOR, { dateKey: '1405/13/45' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('refuses an inverted range, and passes a search through the TENANT-pinned relation', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.list(ACTOR, { from: '2026-09-30', to: '2026-09-01' })
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.attendance.count.mockResolvedValue(0);
    await service.list(ACTOR, { search: 'E-1042', source: 'MANUAL' });

    const where = prisma.attendance.findMany.mock.calls[0][0].where;
    // The employee-code search is a relation pinned to the SAME tenant, so the text the
    // filter reads can never come from another tenant's personnel file.
    expect(where.employee).toEqual({
      is: { tenantId: TENANT, employeeCode: { contains: 'E-1042', mode: 'insensitive' } },
    });
    expect(where.source).toBe('MANUAL');
  });

  it('answers 404 for a row of another tenant, from the tenant-scoped read alone', async () => {
    const { service, prisma } = makeService();
    prisma.attendance.findFirst.mockResolvedValue(null);

    await expect(service.getOne(ACTOR, 'att-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.attendance.findFirst).toHaveBeenCalledWith({
      where: { id: 'att-1', tenantId: TENANT },
      include: { employee: { select: { id: true, employeeCode: true } } },
    });
  });
});
