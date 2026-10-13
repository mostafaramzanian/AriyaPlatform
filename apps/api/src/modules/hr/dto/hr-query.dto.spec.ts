import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';
import { HR_EMPLOYEE_STATUSES, ListEmployeesQueryDto, resolvePageWindow } from './hr-query.dto';

/**
 * Phase 51-HR-1: the shared pagination envelope.
 *
 * THE ONE RULE: a list endpoint is BOUNDED. `HR_MAX_PAGE_SIZE` is enforced twice — a 400
 * from the DTO for a client, and `Math.min` in `resolvePageWindow` for an internal caller
 * that constructs a query object directly. These specs pin both, because a bound that only
 * exists at the edge is not a bound.
 */

describe('resolvePageWindow', () => {
  it('defaults to the declared page size rather than to an unbounded read', () => {
    expect(resolvePageWindow(new ListEmployeesQueryDto())).toEqual({
      page: 1,
      pageSize: HR_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: HR_DEFAULT_PAGE_SIZE,
    });
  });

  it('clamps an oversized pageSize that bypassed validation', () => {
    // The failure mode this prevents: a caller asking for 100000 rows and getting a full
    // scan of hr_db, which is a denial of service rather than a paging bug.
    const window = resolvePageWindow({ pageSize: 100000 });

    expect(window.pageSize).toBe(HR_MAX_PAGE_SIZE);
    expect(window.take).toBe(HR_MAX_PAGE_SIZE);
  });

  it('normalises a zero or negative page and pageSize to 1 rather than producing a negative skip', () => {
    // A negative `skip` is a Prisma error; a zero `take` is a silently empty page.
    expect(resolvePageWindow({ page: 0, pageSize: 0 })).toEqual({
      page: 1,
      pageSize: 1,
      skip: 0,
      take: 1,
    });
    expect(resolvePageWindow({ page: -5 })).toEqual({
      page: 1,
      pageSize: HR_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: HR_DEFAULT_PAGE_SIZE,
    });
  });

  it('derives skip from (page - 1) * pageSize so paging is contiguous', () => {
    expect(resolvePageWindow({ page: 3, pageSize: 20 })).toEqual({
      page: 3,
      pageSize: 20,
      skip: 40,
      take: 20,
    });
  });
});

describe('ListEmployeesQueryDto', () => {
  async function failedProperties(payload: Record<string, unknown>) {
    const errors = await validate(plainToInstance(ListEmployeesQueryDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property);
  }

  it('rejects a pageSize above the ceiling at the edge as well', async () => {
    expect(await failedProperties({ pageSize: HR_MAX_PAGE_SIZE + 1 })).toEqual(['pageSize']);
    expect(await failedProperties({ pageSize: HR_MAX_PAGE_SIZE })).toEqual([]);
  });

  it('coerces query-string numbers, because every query value arrives as a string', async () => {
    const instance = plainToInstance(ListEmployeesQueryDto, { page: '2', pageSize: '50' });

    expect([instance.page, instance.pageSize]).toEqual([2, 50]);
    expect(await failedProperties({ page: 'two' })).toEqual(['page']);
  });

  it('FILTERS on TERMINATED even though no endpoint may SET it', async () => {
    // The asymmetry is the domain: a filter asks "which records are in this state", which
    // includes the state produced by terminating. Setting it directly is refused, because
    // that would contradict an open interval.
    expect(HR_EMPLOYEE_STATUSES).toContain('TERMINATED');
    expect(await failedProperties({ status: 'TERMINATED' })).toEqual([]);
    expect(await failedProperties({ status: 'RETIRED' })).toEqual(['status']);
  });

  it('refuses a client-supplied tenantId in the query string', async () => {
    expect(await failedProperties({ tenantId: '33333333-3333-4333-8333-333333333333' })).toEqual([
      'tenantId',
    ]);
  });
});
