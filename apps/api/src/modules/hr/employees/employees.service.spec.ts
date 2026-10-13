import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import type { EmployeeRepository } from './employees.repository';
import type { OrganizationRepository } from '../organization/organization.repository';
import type { PositionRepository } from '../positions/positions.repository';
import type { EmploymentService } from '../employment/employment.service';
import type { HrAuditGateway } from '../hr-audit.gateway';
import type { HrIdentityGateway } from '../hr-identity.gateway';
import type { HrActor } from '../hr-actor';
import type { CreateEmployeeDto, UpdateEmployeeDto } from '../dto/employee.dto';
import { normalizeEmployeeCode } from '../dto/employee.dto';
import { HR_EMPLOYEE_CODE_PATTERN } from '../hr.constants';
import type { ListEmployeesQueryDto } from '../dto/hr-query.dto';
import { resolvePageWindow } from '../dto/hr-query.dto';

/**
 * Phase 51-HR-ARCH-1B: `EmployeesService` as an APPLICATION layer.
 *
 * WHY THIS FILE USES FAKES INSTEAD OF A FAKE PRISMA DRIVER
 * -------------------------------------------------------
 * The other HR service specs build the REAL repository over a fake Prisma driver, because
 * their subject is a rule that must hold against the database (overlap, cycle, tenant
 * predicate). This file's subject is different: the ORDER of the orchestration steps, the
 * arguments they carry, and the HTTP status a failure becomes. Those are properties of this
 * class alone; asserting them through a driver would couple the test to `where` clauses that
 * are not what is under test.
 *
 * The database-backed rules stay in the repository-backed specs, and the pure rules moved to
 * `domain/*.spec.ts` in this phase. Nothing here replaces either.
 *
 * The helpers the production code itself uses (`normalizeEmployeeCode`,
 * `HR_EMPLOYEE_CODE_PATTERN`, `resolvePageWindow`) are IMPORTED rather than re-typed, so an
 * expectation can never drift from the rule it is checking.
 */
const actor: HrActor = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

function harness() {
  const employees = {
    findById: jest.fn(),
    findIdByCode: jest.fn(),
    findIdByCodeExcludingId: jest.fn(),
    listPage: jest.fn(),
    createWithFirstInterval: jest.fn(),
    updateFields: jest.fn(),
    setStatus: jest.fn(),
  };
  const units = { listLabels: jest.fn() };
  const positions = { listLabels: jest.fn() };
  const employment = {
    validateIntervalReferences: jest.fn(),
    buildIntervalData: jest.fn(),
    currentRecordsByEmployee: jest.fn(),
    hasOpenInterval: jest.fn(),
    currentRecord: jest.fn(),
    history: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const identity = { assertMember: jest.fn(), profilesFor: jest.fn() };

  const service = new EmployeesService(
    employees as unknown as EmployeeRepository,
    units as unknown as OrganizationRepository,
    positions as unknown as PositionRepository,
    employment as unknown as EmploymentService,
    audit as unknown as HrAuditGateway,
    identity as unknown as HrIdentityGateway
  );

  employees.findById.mockResolvedValue(null);
  employees.findIdByCode.mockResolvedValue(null);
  employees.listPage.mockResolvedValue([[], 0]);
  employment.validateIntervalReferences.mockResolvedValue(undefined);
  employment.buildIntervalData.mockResolvedValue({});
  employment.currentRecordsByEmployee.mockResolvedValue(new Map());
  identity.assertMember.mockResolvedValue(undefined);
  identity.profilesFor.mockResolvedValue([]);

  return { service, employees, units, positions, employment, audit, identity };
}

const createDto = (over: Partial<CreateEmployeeDto> = {}): CreateEmployeeDto =>
  ({
    employeeCode: 'e-1042',
    startDate: '2026-01-01',
    employmentType: 'FULL_TIME',
    organizationUnitId: 'unit-1',
    positionId: 'pos-1',
    ...over,
  }) as unknown as CreateEmployeeDto;

describe('EmployeesService — create orchestration (51-HR-ARCH-1B)', () => {
  it('refuses a code the shared pattern rejects, before any read and before identity', async () => {
    const { service, employees, employment, identity } = harness();
    const invalid = '#not-a-code';
    // The precondition is asserted through the REAL helper, so this test cannot pass for the
    // wrong reason if the pattern is ever relaxed.
    expect(HR_EMPLOYEE_CODE_PATTERN.test(normalizeEmployeeCode(invalid))).toBe(false);

    await expect(service.create(actor, createDto({ employeeCode: invalid }))).rejects.toThrow(
      BadRequestException
    );

    expect(employees.findIdByCode).not.toHaveBeenCalled();
    expect(employment.validateIntervalReferences).not.toHaveBeenCalled();
    expect(identity.assertMember).not.toHaveBeenCalled();
  });

  it('normalises the code with the shared helper before the uniqueness pre-check', async () => {
    const { service, employees } = harness();

    await expect(service.create(actor, createDto())).rejects.toThrow();

    // Normalising AFTER the read would let `e-1042` pass and then collide with `E-1042` at
    // the unique index — a 500 where a 409 belongs.
    expect(employees.findIdByCode).toHaveBeenCalledWith(
      actor.tenantId,
      normalizeEmployeeCode('e-1042')
    );
  });

  it('checks identity membership through the gateway BEFORE the assignment references', async () => {
    const { service, identity, employment } = harness();
    const order: string[] = [];
    identity.assertMember.mockImplementation(async () => {
      order.push('identity');
    });
    employment.validateIntervalReferences.mockImplementation(async () => {
      order.push('references');
    });

    await expect(service.create(actor, createDto({ userId: 'user-9' }))).rejects.toThrow();
    expect(order).toEqual(['identity', 'references']);
    expect(identity.assertMember).toHaveBeenCalledWith(actor, 'user-9');

    // With no `userId` the delegation is still made and the argument is simply absent:
    // "is a missing identity link legal?" is the identity boundary's decision, not this
    // service's, which is why the call is unconditional here.
    const withoutUser = harness();
    await expect(withoutUser.service.create(actor, createDto())).rejects.toThrow();
    expect(withoutUser.identity.assertMember).toHaveBeenCalledWith(actor, undefined);
  });

  it('answers 409 when the code already exists, and never opens a transaction', async () => {
    const { service, employees } = harness();
    employees.findIdByCode.mockResolvedValue({ id: 'employee-9' });

    await expect(service.create(actor, createDto())).rejects.toThrow(
      new ConflictException('An employee with this code already exists in this tenant')
    );

    expect(employees.createWithFirstInterval).not.toHaveBeenCalled();
  });

  it('hands the transactional insert the actor tenant, the normalised code and the interval callback', async () => {
    const { service, employees, employment, audit } = harness();
    const dto = createDto();
    let captured: unknown = null;
    employees.createWithFirstInterval.mockImplementation(
      async (data: unknown, build: (employeeId: string) => unknown) => {
        captured = data;
        await build('employee-1');
        // Stopping here keeps the assertion on the WRITE contract. What `create` renders
        // afterwards is `getOne`'s business, and that path is covered by the read tests.
        throw new Error('stop-after-insert');
      }
    );

    await expect(service.create(actor, dto)).rejects.toThrow('stop-after-insert');

    expect(captured).toEqual({
      tenantId: actor.tenantId,
      userId: null,
      employeeCode: normalizeEmployeeCode(dto.employeeCode),
      status: null,
    });
    expect(employment.buildIntervalData).toHaveBeenCalledWith(actor, 'employee-1', dto);
    // An audit entry describes a write that happened; this one did not.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('translates a unique-constraint violation from the insert into 409, without auditing', async () => {
    const { service, employees, audit } = harness();
    employees.createWithFirstInterval.mockRejectedValue({ code: 'P2002' });

    await expect(service.create(actor, createDto())).rejects.toThrow(
      new ConflictException('An employee with this code already exists in this tenant')
    );

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets a non-unique failure through unchanged', async () => {
    const { service, employees } = harness();
    employees.createWithFirstInterval.mockRejectedValue(new Error('connection reset'));

    // A translation rule that swallowed every error would report an outage as a duplicate
    // code, so the pass-through is part of the contract too.
    await expect(service.create(actor, createDto())).rejects.toThrow('connection reset');
  });
});

describe('EmployeesService — reads and status transitions (51-HR-ARCH-1B)', () => {
  it('scopes the page to the actor tenant, uses the shared window and batches the assignments', async () => {
    const { service, employees, employment, units, positions, identity } = harness();
    const query = { page: 3, pageSize: 5 } as unknown as ListEmployeesQueryDto;
    const window = resolvePageWindow(query);

    const result = await service.list(actor, query);

    expect(employees.listPage).toHaveBeenCalledWith(
      actor.tenantId,
      {
        status: undefined,
        search: undefined,
        organizationUnitId: undefined,
        positionId: undefined,
      },
      { skip: window.skip, take: window.take }
    );
    // ONE read for the whole page: an N+1 loop would call this once per row.
    expect(employment.currentRecordsByEmployee).toHaveBeenCalledTimes(1);
    expect(employment.currentRecordsByEmployee).toHaveBeenCalledWith(actor, []);
    // An empty page skips the label batches entirely rather than querying them with `[]`.
    expect(units.listLabels).not.toHaveBeenCalled();
    expect(positions.listLabels).not.toHaveBeenCalled();
    // Whether the empty batch short-circuits here or inside the gateway is the gateway's
    // business; that it is never once-per-row is not.
    expect(identity.profilesFor.mock.calls.length).toBeLessThanOrEqual(1);
    expect(result).toEqual({
      items: [],
      total: 0,
      page: window.page,
      pageSize: window.pageSize,
    });
  });

  it('answers 404 for an employee outside the tenant, and writes nothing', async () => {
    const { service, employees, audit } = harness();

    await expect(
      service.update(actor, 'employee-9', {} as unknown as UpdateEmployeeDto)
    ).rejects.toThrow(new NotFoundException('Employee not found'));

    expect(employees.findById).toHaveBeenCalledWith(actor.tenantId, 'employee-9');
    expect(employees.updateFields).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('checks a CHANGED code for a clash scoped to the tenant and excluding the employee itself', async () => {
    const { service, employees } = harness();
    employees.findById.mockResolvedValue({
      id: 'employee-1',
      employeeCode: 'E-1042',
      status: 'ACTIVE',
      userId: null,
    });
    employees.findIdByCodeExcludingId.mockResolvedValue({ id: 'employee-2' });

    await expect(
      service.update(actor, 'employee-1', {
        employeeCode: 'e-2000',
      } as unknown as UpdateEmployeeDto)
    ).rejects.toThrow(
      new ConflictException('An employee with this code already exists in this tenant')
    );

    expect(employees.findIdByCodeExcludingId).toHaveBeenCalledWith(
      actor.tenantId,
      normalizeEmployeeCode('e-2000'),
      'employee-1'
    );
    expect(employees.updateFields).not.toHaveBeenCalled();
  });

  it('refuses to reactivate a TERMINATED employee, before reading any interval', async () => {
    const { service, employees, employment } = harness();
    employees.findById.mockResolvedValue({
      id: 'employee-1',
      employeeCode: 'E-1042',
      status: 'TERMINATED',
      userId: null,
    });

    await expect(service.setStatus(actor, 'employee-1', 'ACTIVE')).rejects.toThrow(
      new ConflictException(
        'A terminated employee is rehired, not reactivated: use the rehire endpoint'
      )
    );

    expect(employment.hasOpenInterval).not.toHaveBeenCalled();
    expect(employees.setStatus).not.toHaveBeenCalled();
  });

  it('refuses ACTIVE when no interval is open, without writing or auditing', async () => {
    const { service, employees, employment, audit } = harness();
    employees.findById.mockResolvedValue({
      id: 'employee-1',
      employeeCode: 'E-1042',
      status: 'INACTIVE',
      userId: null,
    });
    employment.hasOpenInterval.mockResolvedValue(false);

    await expect(service.setStatus(actor, 'employee-1', 'ACTIVE')).rejects.toThrow(
      new ConflictException('Cannot activate an employee with no open employment record')
    );

    expect(employment.hasOpenInterval).toHaveBeenCalledWith(actor, 'employee-1');
    expect(employees.setStatus).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('delegates the history read to the employment service, not to the personnel repository', async () => {
    const { service, employees, employment } = harness();
    employment.history.mockResolvedValue([{ id: 'record-1' }]);

    await expect(service.history(actor, 'employee-1')).resolves.toEqual([{ id: 'record-1' }]);

    expect(employment.history).toHaveBeenCalledWith(actor, 'employee-1');
    expect(employees.findById).not.toHaveBeenCalled();
  });
});
