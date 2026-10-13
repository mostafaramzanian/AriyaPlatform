import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LeaveService } from './leave.service';
import { LeaveRepository } from './leave.repository';
import { HrActor } from '../hr-actor';

/**
 * Phase 51-HR-3A: the leave rules, pinned without a database.
 *
 * WHAT THIS FILE IS FOR. `LeaveRequest_tenant_employee_fkey`, `LeaveRequest_tenant_leave_type_fkey`
 * and the three CHECKs (`LeaveRequest_period_check`, `LeaveRequest_reason_check`,
 * `LeaveRequest_cancelled_state_check`) are the REAL guarantees, and they live in `hr_db` — the
 * migrations that declare them are asserted by `hr-isolation.spec.ts`. This file pins what the
 * SERVICE decides, which is the part no constraint can express:
 *
 *   * the ORDER of the refusals — the employee, then the type, then the period — so a refusal
 *     never leaves a row behind, and the caller is told the FIRST thing that is wrong;
 *   * a period is a PAIR: either bound may be sent alone on a restatement, and the effective pair
 *     is completed from the STORED row before it is checked, so an inverted result is this
 *     service's 400 rather than a 500 from `LeaveRequest_period_check`;
 *   * `status` is never a caller's value: a create writes PENDING, and a withdrawal writes the
 *     status and its instant TOGETHER, in one statement;
 *   * `CANCELLED` is terminal, so a second withdrawal is a 409 that says so rather than a second
 *     instant written over the first;
 *   * the catalogue's uniqueness pre-check runs on the NORMALISED code — `LeaveType_tenantId_code_key`
 *     is unique on that spelling — and the loser of a genuine race (a raw `P2002`) becomes the
 *     SAME 409 instead of a 500 for a caller who did nothing wrong.
 *
 * A FAKE CLIENT AND THE REAL REPOSITORY, deliberately — the same shape
 * `attendance.service.spec.ts` uses: the assertions below read the `where`/`data` the database
 * would receive, rather than a hand-rolled expectation about some other query shape.
 */

const TENANT = 'tenant-a';
const EMPLOYEE_ID = '6f1c2f2a-0f0e-4a1c-9c1e-8f2b1d3a4c5e';
const TYPE_ID = '7c3d4e5f-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
/** A second catalogue entry, for the "the type was CHANGED" path. */
const OTHER_TYPE_ID = '8d4e5f60-2b3c-4d5e-9f0a-1b2c3d4e5f60';

/** The three days the ordinary request covers: 18–20 September 2026, INCLUSIVE. */
const START_DAY = '2026-09-18';
const END_DAY = '2026-09-20';
/** The instant a withdrawal stamps — minted by the service, never sent by a caller. */
const CANCELLED_AT = '2026-09-11T09:00:00.000Z';

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
    meta: { target: 'LeaveType_tenantId_code_key' },
  });
}

interface FakeHrPrisma {
  leaveRequest: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  leaveType: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
}

function makeService() {
  const prisma: FakeHrPrisma = {
    leaveRequest: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    leaveType: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (arg: unknown): Promise<unknown> =>
      Promise.all(arg as Promise<unknown>[])
    ),
  };

  const employees = { findById: jest.fn() };
  const audit = { record: jest.fn() };
  // Phase 54-G: `create` now runs limit enforcement BEFORE the insert. These two collaborators are
  // the enforcement path's own, and they are stubbed to the UNGOVERNED answer so the pre-existing
  // tests (period, reason, status, tenancy) are unaffected by a policy none of them set up:
  //   * `findIntervalCoveringRange` → `null` (no employment interval can be stated for the range),
  //     which is §16.6's insufficient-context signal — but it only matters once a scoped limit
  //     exists, and none does here.
  //   * `resolveEffective` → `version: null` → `governed: false` → enforcement returns without a
  //     verdict (§16.7/§21.7: an ungoverned request proceeds with no entitlement decision).
  const employment = { findIntervalCoveringRange: jest.fn().mockResolvedValue(null) };
  const policies = {
    resolveEffective: jest.fn().mockResolvedValue({
      version: null,
      limits: [],
      undecidableLimits: [],
    }),
  };

  const service = new LeaveService(
    new LeaveRepository(prisma as never),
    employees as never,
    employment as never,
    audit as never,
    policies as never
  );

  return { service, prisma, employees, employment, policies, audit };
}

/** The labels every register read carries — pinned, so a row renders without a second query. */
const REQUEST_LABEL = {
  employee: { select: { id: true, employeeCode: true } },
  leaveType: { select: { id: true, code: true, name: true, status: true } },
};

/** The row a write returns, as the repository would hand it back. */
const pendingRow = {
  id: 'leave-1',
  tenantId: TENANT,
  employeeId: EMPLOYEE_ID,
  leaveTypeId: TYPE_ID,
  startDate: new Date(`${START_DAY}T00:00:00.000Z`),
  endDate: new Date(`${END_DAY}T00:00:00.000Z`),
  reason: 'Family trip',
  status: 'PENDING',
  cancelledAt: null,
  createdAt: new Date('2026-09-10T08:00:00.000Z'),
  updatedAt: new Date('2026-09-10T08:00:00.000Z'),
  employee: { id: EMPLOYEE_ID, employeeCode: 'E-1042' },
  leaveType: { id: TYPE_ID, code: 'ANNUAL', name: 'Annual leave', status: 'ACTIVE' },
};

const withdrawnRow = {
  ...pendingRow,
  status: 'CANCELLED',
  cancelledAt: new Date(CANCELLED_AT),
};

const activeType = {
  id: TYPE_ID,
  tenantId: TENANT,
  code: 'ANNUAL',
  name: 'Annual leave',
  status: 'ACTIVE',
};

describe('LeaveService.create — the period is a real period, and the state is not the caller’s', () => {
  it('resolves the employee, then the type, then writes PENDING with the days as stored', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(activeType);
    prisma.leaveRequest.create.mockResolvedValue(pendingRow);

    const row = await service.create(ACTOR, {
      employeeId: EMPLOYEE_ID,
      leaveTypeId: TYPE_ID,
      startDate: START_DAY,
      endDate: END_DAY,
      reason: 'Family trip',
    });

    // BOTH reads are TENANT-scoped: another tenant's person and another tenant's type are simply
    // ABSENT rather than forbidden — the service-side counterpart of the two composite
    // `(tenant_id, …)` foreign keys.
    expect(employees.findById).toHaveBeenCalledWith(TENANT, EMPLOYEE_ID);
    expect(prisma.leaveType.findFirst).toHaveBeenCalledWith({
      where: { id: TYPE_ID, tenantId: TENANT },
    });

    const call = prisma.leaveRequest.create.mock.calls[0][0];
    expect(call.data.tenantId).toBe(TENANT);
    // `status` is the DOMAIN's initial state, not a field the caller sent; `cancelledAt` is not in
    // the write at all, because `LeaveRequest_cancelled_state_check` ties it to CANCELLED.
    expect(call.data.status).toBe('PENDING');
    expect(call.data.cancelledAt).toBeUndefined();
    // A `@db.Date` column holds a DAY, so the bounds are the UTC-midnight instants Prisma stores.
    expect(call.data.startDate.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(call.data.endDate.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(call.include).toEqual(REQUEST_LABEL);

    // THE WIRE VIEW: the days leave as DAYS — "midnight UTC" is not the day a reader in Tehran is
    // in — and the withdrawal instant, when there is one, stays an instant.
    expect(row.startDate).toBe(START_DAY);
    expect(row.endDate).toBe(END_DAY);
    expect(row.cancelledAt).toBeNull();
    expect(row.status).toBe('PENDING');

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'create',
      resource: 'hr.leave',
      resourceId: 'leave-1',
      newValue: { startDate: START_DAY, endDate: END_DAY, status: 'PENDING' },
    });
  });

  it('accepts startDate = endDate: one day is the ordinary case, not a special one', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(activeType);
    prisma.leaveRequest.create.mockResolvedValue({
      ...pendingRow,
      endDate: new Date(`${START_DAY}T00:00:00.000Z`),
    });

    const row = await service.create(ACTOR, {
      employeeId: EMPLOYEE_ID,
      leaveTypeId: TYPE_ID,
      startDate: START_DAY,
      endDate: START_DAY,
      reason: 'Family trip',
    });

    const data = prisma.leaveRequest.create.mock.calls[0][0].data;
    expect(data.startDate.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(data.endDate.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(row.startDate).toBe(START_DAY);
    expect(row.endDate).toBe(START_DAY);
  });

  it('refuses an inverted period with a 400, writing nothing and auditing nothing', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(activeType);

    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: END_DAY,
        endDate: START_DAY,
        reason: 'Family trip',
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    // The two bounds describe ONE range, and there is no range in which the later day precedes
    // the earlier one — so the pair is refused HERE, where the message names the field, rather
    // than by `LeaveRequest_period_check`, where it would arrive as a 500.
    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a well-shaped day that is not a real date', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(activeType);

    // The DTO's pattern accepts 2026-02-31. Only the calendar can say it is not a day, which is
    // why the service parses it instead of trusting the shape.
    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: '2026-02-31',
        endDate: '2026-03-02',
        reason: 'Family trip',
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('LeaveService — who a request may be written for, and of what kind', () => {
  it('answers 404 for an employee of ANOTHER tenant, before the type is even read', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue(null);

    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: START_DAY,
        endDate: END_DAY,
        reason: 'Family trip',
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    // The tenant went into the READ, so another tenant's employee is simply absent. The ORDER
    // matters: the type is never looked up, and nothing was written or audited on the way out.
    expect(employees.findById).toHaveBeenCalledWith(TENANT, EMPLOYEE_ID);
    expect(prisma.leaveType.findFirst).not.toHaveBeenCalled();
    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a TERMINATED employee with a 409: their employment has ended', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'TERMINATED' });

    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: START_DAY,
        endDate: END_DAY,
        reason: 'Family trip',
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('accepts an INACTIVE employee: the label is administrative, not a bar to taking leave', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'INACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(activeType);
    prisma.leaveRequest.create.mockResolvedValue(pendingRow);

    // Somebody on long-term leave is exactly an INACTIVE record, which is why the status is not
    // treated as a bar — the same reading `AttendanceService.resolveEmployee` gives it.
    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: START_DAY,
        endDate: END_DAY,
        reason: 'Family trip',
      })
    ).resolves.toMatchObject({ id: 'leave-1', startDate: START_DAY, status: 'PENDING' });
  });

  it('refuses a RETIRED type with a 409 naming it, rather than pretending it is missing', async () => {
    const { service, prisma, employees, audit } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue({ ...activeType, status: 'INACTIVE' });

    // The row still exists and is still addressable — every request recorded against it must keep
    // rendering its name — so a 404 would be a lie about the catalogue. What INACTIVE withholds is
    // its use for a NEW request, which is exactly what the 409 says.
    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: START_DAY,
        endDate: END_DAY,
        reason: 'Family trip',
      })
    ).rejects.toThrow('Leave type ANNUAL is INACTIVE and cannot be chosen for a request.');

    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 for a type of ANOTHER tenant, because the lookup carries the tenant', async () => {
    const { service, prisma, employees } = makeService();
    employees.findById.mockResolvedValue({ id: EMPLOYEE_ID, status: 'ACTIVE' });
    prisma.leaveType.findFirst.mockResolvedValue(null);

    await expect(
      service.create(ACTOR, {
        employeeId: EMPLOYEE_ID,
        leaveTypeId: TYPE_ID,
        startDate: START_DAY,
        endDate: END_DAY,
        reason: 'Family trip',
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.leaveType.findFirst).toHaveBeenCalledWith({
      where: { id: TYPE_ID, tenantId: TENANT },
    });
    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
  });
});

describe('LeaveService.update — only a pending request restates, and only what changed', () => {
  it('refuses a WITHDRAWN request with a 409, writing nothing', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(withdrawnRow);

    await expect(service.update(ACTOR, 'leave-1', { reason: 'A correction' })).rejects.toThrow(
      'A CANCELLED request cannot be restated; submit a new request instead.'
    );

    // Restatable is a fact about the STORED row, read from the row and answered by the domain rule:
    // a correction to a withdrawn request is a NEW request, which is what keeps the trail of the
    // withdrawal intact.
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('completes a half-sent period from the stored row, and refuses an inverted result', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);

    // Only the END moved, and it moved before the start the row already states: the pair is
    // completed FIRST and checked as a pair SECOND, so this is a 400 from the service rather than
    // a 500 from `LeaveRequest_period_check`.
    await expect(
      service.update(ACTOR, 'leave-1', { endDate: '2026-09-01' })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('moves one end of the period and writes only the day that moved, through the compound key', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);
    prisma.leaveRequest.update.mockResolvedValue({
      ...pendingRow,
      endDate: new Date('2026-09-25T00:00:00.000Z'),
    });

    const row = await service.update(ACTOR, 'leave-1', { endDate: '2026-09-25' });

    const call = prisma.leaveRequest.update.mock.calls[0][0];
    // `tenantId_id` is the same-tenant guarantee rather than a convenience: the write cannot
    // address another tenant's request even if it were handed the id.
    expect(call.where).toEqual({ tenantId_id: { tenantId: TENANT, id: 'leave-1' } });
    expect(call.data).toEqual({ endDate: new Date('2026-09-25T00:00:00.000Z') });
    expect(row.endDate).toBe('2026-09-25');
    expect(row.startDate).toBe(START_DAY);

    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'update',
      resource: 'hr.leave',
      changedFields: ['endDate'],
      oldValue: { endDate: END_DAY, startDate: START_DAY },
      newValue: { endDate: '2026-09-25', startDate: START_DAY },
    });
  });

  it('reports nothing when a PUT-shaped body restates what is already stored', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);

    const row = await service.update(ACTOR, 'leave-1', {
      leaveTypeId: TYPE_ID,
      startDate: START_DAY,
      endDate: END_DAY,
      reason: 'Family trip',
    });

    // NOTHING CHANGED, SO THERE IS NO ACT: no statement and no audit event — the same early return
    // `PositionsService.setStatus` makes when the state asked for is the state already stored. An
    // audit row describing an act that did not happen is the failure this avoids, and the stored row
    // is the truthful answer to a restatement that restated nothing.
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      id: 'leave-1',
      startDate: START_DAY,
      endDate: END_DAY,
      reason: 'Family trip',
      status: 'PENDING',
    });
  });

  it('re-validates a NEW type, and refuses a RETIRED one with a 409 before writing', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);
    prisma.leaveType.findFirst.mockResolvedValue({
      ...activeType,
      id: OTHER_TYPE_ID,
      code: 'SICK',
      status: 'INACTIVE',
    });

    // A restatement may name another type, and the type it names must still be one that may be
    // CHOSEN — the same rule a create states, asked of the same tenant-scoped lookup.
    await expect(service.update(ACTOR, 'leave-1', { leaveTypeId: OTHER_TYPE_ID })).rejects.toThrow(
      'Leave type SICK is INACTIVE and cannot be chosen for a request.'
    );

    expect(prisma.leaveType.findFirst).toHaveBeenCalledWith({
      where: { id: OTHER_TYPE_ID, tenantId: TENANT },
    });
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not re-resolve a type the row already names', async () => {
    const { service, prisma } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);
    prisma.leaveRequest.update.mockResolvedValue({ ...pendingRow, reason: 'Family matters' });

    const row = await service.update(ACTOR, 'leave-1', {
      leaveTypeId: TYPE_ID,
      reason: 'Family matters',
    });

    // The row already names that type, so nothing is looked up and nothing is written for it: the
    // statement carries the reason alone.
    expect(prisma.leaveType.findFirst).not.toHaveBeenCalled();
    expect(prisma.leaveRequest.update.mock.calls[0][0].data).toEqual({ reason: 'Family matters' });
    expect(row.reason).toBe('Family matters');
  });

  it('answers 404 for another tenant’s request, from the tenant-scoped read alone', async () => {
    const { service, prisma } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);

    await expect(
      service.update(ACTOR, 'leave-1', { reason: 'A correction' })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'leave-1', tenantId: TENANT },
      include: REQUEST_LABEL,
    });
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
  });

  it('refuses a body with no fields, rather than auditing an act that did not happen', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);

    await expect(service.update(ACTOR, 'leave-1', {})).rejects.toThrow(
      'Nothing to update: send at least one field.'
    );

    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('LeaveService.cancel — PENDING becomes CANCELLED, once', () => {
  it('writes the status and its instant TOGETHER, and audits the reason the row has no column for', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingRow);
    prisma.leaveRequest.update.mockResolvedValue(withdrawnRow);

    const row = await service.cancel(ACTOR, 'leave-1', { reason: 'Recorded twice' });

    // ONE statement, both halves of the state change: `LeaveRequest_cancelled_state_check` ties
    // `status` and `cancelled_at` in BOTH directions, so a write that set one and not the other is
    // not a partial success — and there is no second call to reconcile them afterwards. The
    // instant is minted here rather than sent, which is why it is asserted as a `Date`.
    expect(prisma.leaveRequest.update.mock.calls[0][0].where).toEqual({
      tenantId_id: { tenantId: TENANT, id: 'leave-1' },
    });
    expect(prisma.leaveRequest.update.mock.calls[0][0].data).toEqual({
      status: 'CANCELLED',
      cancelledAt: expect.any(Date),
    });

    // THE WIRE VIEW: the withdrawal moment stays an instant while the period stays a pair of DAYS.
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledAt).toEqual(new Date(CANCELLED_AT));
    expect(row.startDate).toBe(START_DAY);

    // The reason travels with the ACT, not with the row: `LeaveRequest` has no
    // `cancellation_reason` column by design, and the platform trail is where it belongs.
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'cancel',
      resource: 'hr.leave',
      resourceId: 'leave-1',
      reason: 'Recorded twice',
      changedFields: ['status', 'cancelledAt'],
      oldValue: { status: 'PENDING', cancelledAt: null },
      newValue: { status: 'CANCELLED', cancelledAt: CANCELLED_AT },
    });
  });

  it('refuses a second withdrawal with a 409, and never overwrites the first instant', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(withdrawnRow);

    // CANCELLED has an EMPTY transition list rather than no entry, so this is a statement the
    // domain makes rather than one it fails to make: a second withdrawal would write a second
    // instant over the first, and the row would no longer say when it was withdrawn.
    await expect(service.cancel(ACTOR, 'leave-1', { reason: 'Again' })).rejects.toThrow(
      'A CANCELLED request cannot be withdrawn; a withdrawn request is terminal.'
    );

    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 for another tenant’s request, before any legality is assumed', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);

    await expect(
      service.cancel(ACTOR, 'leave-1', { reason: 'Withdrawn in error' })
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('LeaveService.list — one window, resolved once', () => {
  it('pins the tenant, resolves the bounds as DAYS, and renders the page back as days', async () => {
    const { service, prisma } = makeService();
    prisma.leaveRequest.findMany.mockResolvedValue([pendingRow]);
    prisma.leaveRequest.count.mockResolvedValue(1);

    const page = await service.list(ACTOR, {
      page: 2,
      pageSize: 10,
      employeeId: EMPLOYEE_ID,
      leaveTypeId: TYPE_ID,
      status: 'PENDING',
      from: START_DAY,
      to: END_DAY,
    });

    const call = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(TENANT);
    expect(call.where.employeeId).toBe(EMPLOYEE_ID);
    expect(call.where.leaveTypeId).toBe(TYPE_ID);
    expect(call.where.status).toBe('PENDING');
    // INTERSECTION, not containment: `from` keeps requests whose LAST day is on or after it, and
    // `to` keeps those whose FIRST day is on or before it. A containment filter would hide a long
    // request that swallows the window whole — the very rows the question is about.
    expect(call.where.endDate.gte.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(call.where.startDate.lte.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    // The order is TOTAL — three keys — so two rows sharing a start date and a creation instant
    // still have one stable order and paging can neither repeat nor skip one of them.
    expect(call.orderBy).toEqual([{ startDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]);
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
    expect(call.include).toEqual(REQUEST_LABEL);

    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.items[0].startDate).toBe(START_DAY);
  });

  it('refuses an inverted window, and a well-shaped day that is not a real date', async () => {
    const { service, prisma } = makeService();

    // The two bounds describe ONE range, and there is no range in which the later day precedes the
    // earlier one — so an inverted window is refused rather than quietly matching nothing.
    await expect(
      service.list(ACTOR, { from: '2026-09-30', to: '2026-09-01' })
    ).rejects.toBeInstanceOf(BadRequestException);

    // The DTO's pattern accepts 2026-02-31; only the calendar can say it is not a day, which is
    // why the service parses each bound instead of trusting the shape.
    await expect(service.list(ACTOR, { from: '2026-02-31' })).rejects.toBeInstanceOf(
      BadRequestException
    );

    expect(prisma.leaveRequest.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 for a request of another tenant, from the tenant-scoped read alone', async () => {
    const { service, prisma } = makeService();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);

    await expect(service.getOne(ACTOR, 'leave-1')).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'leave-1', tenantId: TENANT },
      include: REQUEST_LABEL,
    });
  });
});

describe('LeaveService — the tenant’s own catalogue, where retirement is a status', () => {
  it('normalises the code BEFORE the uniqueness pre-check, and stores the normalised spelling', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveType.findFirst.mockResolvedValue(null);
    prisma.leaveType.create.mockResolvedValue(activeType);

    const row = await service.createType(ACTOR, { code: ' annual ', name: 'Annual leave' });

    // The pre-check presses on the NORMALISED code, because `LeaveType_tenantId_code_key` is unique
    // on that spelling: checking the raw value would let `annual` pass the check and then collide
    // with a stored `ANNUAL` at the index — a 500 for a caller who did nothing wrong.
    expect(prisma.leaveType.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      code: 'ANNUAL',
    });
    expect(prisma.leaveType.create.mock.calls[0][0].data).toEqual({
      tenantId: TENANT,
      code: 'ANNUAL',
      name: 'Annual leave',
      status: 'ACTIVE',
    });
    expect(row.code).toBe('ANNUAL');
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'create',
      resource: 'hr.leave_type',
      newValue: { code: 'ANNUAL', name: 'Annual leave', status: 'ACTIVE' },
    });
  });

  it('refuses a duplicate code with a 409, and translates the loser of a race into the same 409', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveType.findFirst.mockResolvedValue(activeType);

    await expect(
      service.createType(ACTOR, { code: 'annual', name: 'Annual leave' })
    ).rejects.toThrow('This organization already has a leave type coded ANNUAL.');

    expect(prisma.leaveType.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    // …and the loser of a GENUINE race — two creates that both found nothing — gets the SAME 409
    // rather than a 500: the unique index stays the arbiter, and the pre-check is only the courtesy
    // that makes the ordinary duplicate comprehensible.
    prisma.leaveType.findFirst.mockResolvedValue(null);
    prisma.leaveType.create.mockRejectedValue(uniqueViolation());

    await expect(
      service.createType(ACTOR, { code: 'annual', name: 'Annual leave' })
    ).rejects.toThrow('This organization already has a leave type coded ANNUAL.');

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('retires an entry with a status and never a delete, and reports only what changed', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveType.findFirst.mockResolvedValue(activeType);
    prisma.leaveType.update.mockResolvedValue({ ...activeType, status: 'INACTIVE' });

    await service.updateType(ACTOR, TYPE_ID, { status: 'INACTIVE' });

    // `LeaveRequest_tenant_leave_type_fkey` is ON DELETE RESTRICT, so a type that has ever been
    // requested cannot be removed from under its own history: retirement is a STATUS, which is what
    // lets a historical request keep rendering the name of the leave it was recorded under while
    // the entry is unavailable for anything new. The write addresses the compound key, so it cannot
    // reach another tenant's catalogue even if it were handed the id.
    expect(prisma.leaveType.update.mock.calls[0][0]).toEqual({
      where: { tenantId_id: { tenantId: TENANT, id: TYPE_ID } },
      data: { status: 'INACTIVE' },
    });
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'update',
      resource: 'hr.leave_type',
      changedFields: ['status'],
      oldValue: { name: 'Annual leave', status: 'ACTIVE' },
      newValue: { name: 'Annual leave', status: 'INACTIVE' },
    });
  });

  it('answers 404 for another tenant’s entry, and refuses a body that changes nothing', async () => {
    const { service, prisma, audit } = makeService();
    prisma.leaveType.findFirst.mockResolvedValue(null);

    // Another tenant's entry is ABSENT rather than forbidden, exactly as in the leave register.
    await expect(service.getType(ACTOR, TYPE_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateType(ACTOR, TYPE_ID, { status: 'INACTIVE' })).rejects.toBeInstanceOf(
      NotFoundException
    );

    prisma.leaveType.findFirst.mockResolvedValue(activeType);
    await expect(service.updateType(ACTOR, TYPE_ID, {})).rejects.toThrow(
      'Nothing to update: send name or status.'
    );

    expect(prisma.leaveType.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lists the catalogue through the tenant-pinned read, ordered by its own stable key', async () => {
    const { service, prisma } = makeService();
    prisma.leaveType.findMany.mockResolvedValue([activeType]);
    prisma.leaveType.count.mockResolvedValue(1);

    const page = await service.listTypes(ACTOR, { status: 'ACTIVE', search: 'ANNU' });

    const call = prisma.leaveType.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(TENANT);
    expect(call.where.status).toBe('ACTIVE');
    // The free-text match reads HR's OWN columns and nothing else: the type's `name` belongs to the
    // tenant, so searching the catalogue needs no identity lookup and no Core round trip.
    expect(call.where.OR).toEqual([
      { code: { contains: 'ANNU', mode: 'insensitive' } },
      { name: { contains: 'ANNU', mode: 'insensitive' } },
    ]);
    // `code` is the catalogue's stable key — the same key `LeaveRequest_tenant_leave_type_fkey`
    // resolves — so the order does not move when an entry is renamed.
    expect(call.orderBy).toEqual([{ code: 'asc' }, { id: 'asc' }]);
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });
});
