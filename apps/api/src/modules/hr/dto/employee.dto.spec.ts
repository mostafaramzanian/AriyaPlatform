import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateEmployeeDto,
  HR_MANUAL_EMPLOYEE_STATUSES,
  MAX_EMPLOYEE_CODE_LENGTH,
  SetEmployeeStatusDto,
  UpdateEmployeeDto,
  normalizeEmployeeCode,
} from './employee.dto';

/**
 * Phase 51-HR-1: the employee DTO contract.
 *
 * These specs exist for one reason: the four rules below are shared by the database,
 * the service and the wire contract, and a drift between them is invisible until it
 * becomes a 500 (a constraint violation) or, worse, a silent second record.
 *
 *   1. an employee code is NORMALISED before it is validated and stored, because the
 *      unique index is on the normalised value;
 *   2. `TERMINATED` is not a settable status — it is the OUTCOME of terminating an
 *      employment, which closes an interval;
 *   3. a date field is a DATE (`YYYY-MM-DD`), never an instant;
 *   4. the DTO carries no tenant, no user identity and no audit field.
 */

/** Runs the real global pipe behaviour: transform, then validate. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return {
    instance,
    failed: errors.map((error) => error.property),
  };
}

const VALID_INTERVAL = {
  employmentType: 'FULL_TIME',
  startDate: '2026-03-01',
  organizationUnitId: '11111111-1111-4111-8111-111111111111',
  positionId: '22222222-2222-4222-8222-222222222222',
};

describe('normalizeEmployeeCode', () => {
  it('trims, uppercases and NFC-normalises so one code cannot exist twice', () => {
    expect(normalizeEmployeeCode('  e-1042  ')).toBe('E-1042');
    // The composed and decomposed forms below normalise to the same NFC string, which is
    // what stops two visually identical codes from both being stored.
    expect(normalizeEmployeeCode('e\u0301-100')).toBe(normalizeEmployeeCode('\u00e9-100'));
  });

  it('returns an interior-whitespace code unchanged, so the 400 names the pattern', () => {
    // Deliberately NOT stripped: silently joining "E 1042" into "E1042" would invent a
    // code the caller never sent.
    expect(normalizeEmployeeCode('E 1042')).toBe('E 1042');
  });
});

describe('CreateEmployeeDto', () => {
  it('accepts a well-formed payload and normalises the code through the pipe', async () => {
    const { instance, failed } = await check(CreateEmployeeDto, {
      employeeCode: 'e-1042',
      ...VALID_INTERVAL,
    });

    expect(failed).toEqual([]);
    expect((instance as CreateEmployeeDto).employeeCode).toBe('E-1042');
  });

  it('accepts a record created directly as INACTIVE but refuses TERMINATED', async () => {
    // §14: an archived personnel file and long-term leave are real states, so INACTIVE is
    // settable. TERMINATED always means "an interval was closed on a date", so declaring
    // it here would leave the employee TERMINATED with an OPEN interval — a file that
    // contradicts itself and that no endpoint can then resolve.
    const inactive = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      status: 'INACTIVE',
      ...VALID_INTERVAL,
    });
    expect(inactive.failed).toEqual([]);

    const terminated = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      status: 'TERMINATED',
      ...VALID_INTERVAL,
    });
    expect(terminated.failed).toEqual(['status']);
    expect(HR_MANUAL_EMPLOYEE_STATUSES).not.toContain('TERMINATED');
  });

  it('requires the first employment interval, because a record without one has no unit', async () => {
    const { failed } = await check(CreateEmployeeDto, { employeeCode: 'E-1' });

    expect(failed.sort()).toEqual([
      'employmentType',
      'organizationUnitId',
      'positionId',
      'startDate',
    ]);
  });

  it('rejects an instant where a calendar date belongs', async () => {
    // `@IsDateString()` alone would accept this and the stored day would then depend on
    // the caller's timezone — the exact defect the strict pattern exists to prevent.
    const { failed } = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      ...VALID_INTERVAL,
      startDate: '2026-03-01T00:00:00Z',
    });

    expect(failed).toEqual(['startDate']);
  });

  it('rejects a code longer than the column, and one with characters a URL cannot carry', async () => {
    const tooLong = await check(CreateEmployeeDto, {
      employeeCode: `E${'1'.repeat(MAX_EMPLOYEE_CODE_LENGTH)}`,
      ...VALID_INTERVAL,
    });
    expect(tooLong.failed).toContain('employeeCode');

    const badChar = await check(CreateEmployeeDto, {
      employeeCode: 'E 1042',
      ...VALID_INTERVAL,
    });
    expect(badChar.failed).toEqual(['employeeCode']);
  });

  it('refuses a client-supplied tenantId rather than ignoring it', async () => {
    // The global pipe runs with `forbidNonWhitelisted`, so an attempt to state a tenant
    // is a 400. It could never be honoured — `resolveHrActor` is the only source.
    const { failed } = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      tenantId: '33333333-3333-4333-8333-333333333333',
      ...VALID_INTERVAL,
    });

    expect(failed).toContain('tenantId');
  });

  it('requires the manager to be an EMPLOYEE id, never a Core user id (§13)', async () => {
    const notAUuid = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      ...VALID_INTERVAL,
      managerEmployeeId: 'user-1',
    });
    expect(notAUuid.failed).toEqual(['managerEmployeeId']);

    const ok = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      ...VALID_INTERVAL,
      managerEmployeeId: '44444444-4444-4444-8444-444444444444',
    });
    expect(ok.failed).toEqual([]);
  });
});

describe('UpdateEmployeeDto', () => {
  it('uses the SAME manual-status rule as create and the status route', async () => {
    // This is the assertion that catches the three endpoints drifting apart: all three
    // must refuse the same word.
    const patch = await check(UpdateEmployeeDto, { status: 'TERMINATED' });
    const statusRoute = await check(SetEmployeeStatusDto, { status: 'TERMINATED' });
    const created = await check(CreateEmployeeDto, {
      employeeCode: 'E-1',
      status: 'TERMINATED',
      ...VALID_INTERVAL,
    });

    expect([patch.failed, statusRoute.failed, created.failed]).toEqual([
      ['status'],
      ['status'],
      ['status'],
    ]);
  });

  it('accepts an explicit null userId to UNLINK identity, and omits it to leave it as-is', async () => {
    // The distinction matters: `undefined` means "not in this request" while `null`
    // means "remove the link", and the service writes the column only for the latter.
    const unlink = await check(UpdateEmployeeDto, { userId: null });
    expect(unlink.failed).toEqual([]);
    expect((unlink.instance as UpdateEmployeeDto).userId).toBeNull();

    const untouched = await check(UpdateEmployeeDto, { employeeCode: 'E-2' });
    expect((untouched.instance as UpdateEmployeeDto).userId).toBeUndefined();
  });

  it('carries no employment fact, so a transfer cannot be spelled as an edit', async () => {
    // Moving an employee is a NEW interval (POST /:id/employment-records). If `startDate`
    // or `organizationUnitId` were editable here, history would be overwritten instead.
    const { failed } = await check(UpdateEmployeeDto, {
      startDate: '2026-03-01',
      organizationUnitId: '11111111-1111-4111-8111-111111111111',
    });

    expect(failed.sort()).toEqual(['organizationUnitId', 'startDate']);
  });
});
