import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  EmploymentService,
  addDays,
  parseIsoDate,
  serializeEmploymentRecord,
  toIsoDate,
} from './employment.service';
import { EmploymentRepository } from './employment.repository';
import { HrActor } from '../hr-actor';

/**
 * Phase 51-HR-1: the effective-dated employment history.
 *
 * WHY A FAKE PRISMA RATHER THAN A REAL DATABASE
 * --------------------------------------------
 * The exclusion constraint, the composite foreign keys and the cycle trigger are the
 * REAL guarantees and live in the schema's own SQL. This file pins the decisions the
 * SERVICE makes before and around them: the date arithmetic that decides which day an
 * interval closes on, the tenant predicate that decides what is visible, and the refusal
 * of a second open interval. Those are the rules a change to this service can break
 * silently, so each one is asserted on the exact arguments the service passed — not
 * merely on the fact that a call happened.
 */

const TENANT = 'tenant-a';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

/** A stored `EmploymentRecord` row, as Prisma returns it. */
function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record-1',
    employeeId: 'emp-1',
    tenantId: TENANT,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: null as Date | null,
    organizationUnitId: 'unit-1',
    positionId: 'pos-1',
    managerEmployeeId: null as string | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const employeeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  tenantId: TENANT,
  status: 'ACTIVE',
  ...overrides,
});

/**
 * The Prisma surface `EmploymentRepository` actually uses — the two delegates plus
 * `$transaction`.
 *
 * The service under test is built on the REAL repository over this fake, so every
 * expectation below still reads the arguments that reach the driver: a mocked repository
 * would let the layers disagree about a predicate while the assertions stayed green.
 *
 * The type is written out rather than inferred because the fake's `$transaction` takes
 * the fake itself as its callback argument: an inferred type would be self-referential
 * (`TS7022`/`TS7024`), which is a compile error rather than a test failure.
 */
interface FakeHrPrisma {
  employee: { findFirst: jest.Mock; update: jest.Mock };
  employmentRecord: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  auditOutbox: { create: jest.Mock };
  $transaction: jest.Mock;
}

function makeService() {
  const prisma: FakeHrPrisma = {
    employee: { findFirst: jest.fn(), update: jest.fn() },
    employmentRecord: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    auditOutbox: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  // `terminate` and `rehire` use the ARRAY form of `$transaction`; `openInterval` uses
  // the CALLBACK form. Both are supported so a test can tell which one was used, and the
  // callback receives this fake as `tx` so a transactional write is observable.
  prisma.$transaction.mockImplementation(async (arg: unknown): Promise<unknown> =>
    typeof arg === 'function'
      ? (arg as (tx: FakeHrPrisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[])
  );

  const organization = { assertUnitIsUsable: jest.fn() };
  const positions = { assertPositionIsUsable: jest.fn() };
  const audit = {
    record: jest.fn(),
    buildOutboxPayload: jest.fn().mockReturnValue({
      tenantId: TENANT,
      auditId: 'mock-audit-id',
      payload: {},
    }),
  };

  const service = new EmploymentService(
    new EmploymentRepository(prisma as never),
    organization as never,
    positions as never,
    audit as never
  );

  return { service, prisma, organization, positions, audit };
}

describe('employment date arithmetic', () => {
  it('pins an ISO date to UTC midnight, the day Postgres will store', () => {
    // The defect this prevents: `new Date('2026-03-01')` is UTC midnight, but a local
    // `setDate(getDate() - 1)` is not — the pair drifts by a day east of UTC.
    const parsed = parseIsoDate('2026-03-01');
    expect(parsed.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('refuses an unparseable or implausibly old date instead of storing one', () => {
    expect(() => parseIsoDate('not-a-date')).toThrow(ConflictException);
    expect(() => parseIsoDate('1899-12-31')).toThrow(ConflictException);
    expect(parseIsoDate('1900-01-01').getUTCFullYear()).toBe(1900);
  });

  it('reads a stored date back as a date key, and an absent end as null', () => {
    expect(toIsoDate(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03-01');
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });

  it('closes an interval the day BEFORE its successor, across month and year ends', () => {
    // The one arithmetic this service performs, and the reason it is UTC-based: the
    // closure must not overlap the successor (the exclusion constraint would reject it)
    // nor leave a one-day gap (which would make the history non-contiguous).
    expect(toIsoDate(addDays(parseIsoDate('2026-03-01'), -1))).toBe('2026-02-28');
    expect(toIsoDate(addDays(parseIsoDate('2024-03-01'), -1))).toBe('2024-02-29');
    expect(toIsoDate(addDays(parseIsoDate('2027-01-01'), -1))).toBe('2026-12-31');
  });
});

describe('serializeEmploymentRecord', () => {
  it('emits dates as YYYY-MM-DD and never as instants', () => {
    const view = serializeEmploymentRecord(recordRow());

    expect(view.startDate).toBe('2026-01-01');
    expect(view.endDate).toBeNull();
    // The exact key set is asserted because this is the wire contract the web layer
    // reads; a renamed key would be a silent `undefined` in the UI, not a type error.
    expect(Object.keys(view)).toEqual([
      'id',
      'employeeId',
      'tenantId',
      'employmentType',
      'status',
      'startDate',
      'endDate',
      'organizationUnitId',
      'positionId',
      'managerEmployeeId',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('reports a closed interval as a date pair rather than a duration', () => {
    const view = serializeEmploymentRecord(
      recordRow({ status: 'ENDED', endDate: new Date('2026-06-30T00:00:00.000Z') })
    );

    expect({
      startDate: view.startDate,
      endDate: view.endDate,
      status: view.status,
    }).toEqual({ startDate: '2026-01-01', endDate: '2026-06-30', status: 'ENDED' });
  });
});

describe('EmploymentService tenancy', () => {
  it('does not see another tenant employee — 404, not another tenant row', async () => {
    const { service, prisma } = makeService();
    // The fake returns null for a foreign id BECAUSE the service's predicate carried
    // `tenantId`; the assertion on that predicate is what proves it did.
    prisma.employee.findFirst.mockResolvedValue(null);

    await expect(service.history(ACTOR, 'emp-other')).rejects.toThrow(NotFoundException);
    expect(prisma.employee.findFirst).toHaveBeenCalledWith({
      where: { id: 'emp-other', tenantId: TENANT },
    });
  });

  it('scopes the interval read by the actor tenant and filters to the open one', async () => {
    const { service, prisma } = makeService();
    prisma.employee.findFirst.mockResolvedValue(employeeRow());
    prisma.employmentRecord.findFirst.mockResolvedValue(recordRow());

    const current = await service.currentRecord(ACTOR, 'emp-1');

    expect(prisma.employmentRecord.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, employeeId: 'emp-1', endDate: null },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
    expect(current?.startDate).toBe('2026-01-01');
  });

  it('returns every interval, newest first, with nothing filtered out', async () => {
    // §10's "terminating employment does not erase history" must be observable through
    // the API, not merely true in storage.
    const { service, prisma } = makeService();
    prisma.employee.findFirst.mockResolvedValue(employeeRow());
    prisma.employmentRecord.findMany.mockResolvedValue([
      recordRow({ id: 'r-2', startDate: new Date('2026-03-01T00:00:00.000Z') }),
      recordRow({ id: 'r-1', status: 'ENDED', endDate: new Date('2026-02-28T00:00:00.000Z') }),
    ]);

    const history = await service.history(ACTOR, 'emp-1');

    expect(prisma.employmentRecord.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, employeeId: 'emp-1' },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
    expect(history.map((row) => row.id)).toEqual(['r-2', 'r-1']);
  });

  it('returns null rather than throwing when there is no open interval', async () => {
    // "No current assignment" is a state the employee list renders, not an error.
    const { service, prisma } = makeService();
    prisma.employee.findFirst.mockResolvedValue(employeeRow());
    prisma.employmentRecord.findFirst.mockResolvedValue(null);

    await expect(service.currentRecord(ACTOR, 'emp-1')).resolves.toBeNull();
  });

  it('batches the current assignment for a list in ONE query, keyed by employee', async () => {
    // The N+1 this prevents: the employee list renders «واحد / سمت» per row, so a
    // per-row read would turn a 20-row page into 21 round trips.
    const { service, prisma } = makeService();
    prisma.employmentRecord.findMany.mockResolvedValue([
      recordRow({ id: 'r-2', employeeId: 'emp-2' }),
      recordRow({ id: 'r-1', employeeId: 'emp-1' }),
    ]);

    const map = await service.currentRecordsByEmployee(ACTOR, ['emp-1', 'emp-2', 'emp-1', '']);

    expect(prisma.employmentRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.employmentRecord.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, employeeId: { in: ['emp-1', 'emp-2'] }, endDate: null },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
    expect([...map.keys()].sort()).toEqual(['emp-1', 'emp-2']);
  });

  it('does not query at all for an empty page', async () => {
    const { service, prisma } = makeService();

    await expect(service.currentRecordsByEmployee(ACTOR, [])).resolves.toEqual(new Map());
    expect(prisma.employmentRecord.findMany).not.toHaveBeenCalled();
  });
});

/**
 * The interval TRANSITIONS — the half of this service the tenancy tests above do not reach.
 *
 * These assertions keep the transaction shape honest now that the transaction itself lives in
 * `EmploymentRepository`: what this service still decides is WHICH interval is closed, on
 * WHICH day, and in WHAT order. The order is load-bearing — the exclusion constraint is
 * non-deferrable, so an insert before the close is rejected as an overlap — and it is asserted
 * here rather than left to the database to refuse at runtime.
 */
describe('EmploymentService interval transitions', () => {
  /** A transfer in its plainest form: no manager, one unit, one position. */
  const DTO = {
    employmentType: 'FULL_TIME' as const,
    startDate: '2026-03-01',
    organizationUnitId: 'unit-1',
    positionId: 'pos-1',
  };

  it('closes the open interval the day BEFORE the successor, and opens it after — in that order', async () => {
    const { service, prisma } = makeService();
    prisma.employee.findFirst.mockResolvedValue(employeeRow());
    // Two reads of the same delegate: the precondition read finds the interval being
    // replaced, the overlap probe must find nothing.
    prisma.employmentRecord.findFirst
      .mockResolvedValueOnce(recordRow())
      .mockResolvedValueOnce(null);
    prisma.employmentRecord.update.mockResolvedValue(recordRow({ status: 'ENDED' }));
    prisma.employmentRecord.create.mockResolvedValue(recordRow({ id: 'record-2' }));

    await service.openInterval(ACTOR, 'emp-1', DTO);

    expect(prisma.employmentRecord.update).toHaveBeenCalledWith({
      where: { id: 'record-1' },
      data: { endDate: new Date('2026-02-28T00:00:00.000Z'), status: 'ENDED' },
    });
    // The successor is the whole payload `buildIntervalData` produced: the tenant is the
    // actor's, `status` is ACTIVE and `endDate` is open, because an interval that exists is an
    // interval that is current until something closes it.
    expect(prisma.employmentRecord.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        employeeId: 'emp-1',
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        startDate: new Date('2026-03-01T00:00:00.000Z'),
        endDate: null,
        organizationUnitId: 'unit-1',
        positionId: 'pos-1',
        managerEmployeeId: null,
      },
    });
    expect(prisma.employmentRecord.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.employmentRecord.create.mock.invocationCallOrder[0]
    );
  });

  it('refuses a successor that does not start AFTER the open interval began', async () => {
    const { service, prisma } = makeService();
    prisma.employee.findFirst.mockResolvedValue(employeeRow());
    prisma.employmentRecord.findFirst.mockResolvedValueOnce(recordRow());

    await expect(
      service.openInterval(ACTOR, 'emp-1', { ...DTO, startDate: '2026-01-01' })
    ).rejects.toThrow(ConflictException);
    expect(prisma.employmentRecord.update).not.toHaveBeenCalled();
    expect(prisma.employmentRecord.create).not.toHaveBeenCalled();
  });

  it('answers whether an open interval exists, with the tenant in the predicate', async () => {
    // The one caller is `EmployeesService.setStatus`, which refuses to ACTIVATE a person who
    // has no assignment; a tenant-blind answer would let it activate a foreign employee.
    const { service, prisma } = makeService();
    prisma.employmentRecord.findFirst.mockResolvedValue(recordRow());

    await expect(service.hasOpenInterval(ACTOR, 'emp-1')).resolves.toBe(true);
    expect(prisma.employmentRecord.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, employeeId: 'emp-1', endDate: null },
      select: { id: true },
    });
  });

  it('reports "no open interval" as false rather than raising', async () => {
    const { service, prisma } = makeService();
    prisma.employmentRecord.findFirst.mockResolvedValue(null);

    await expect(service.hasOpenInterval(ACTOR, 'emp-1')).resolves.toBe(false);
  });
});
