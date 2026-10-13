import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateOrganizationUnitDto,
  CreatePositionDto,
  HR_CODE_PATTERN,
  MAX_UNIT_NAME_LENGTH,
  SetRecordStatusDto,
  UpdateOrganizationUnitDto,
} from './organization.dto';

/**
 * Phase 51-HR-1: the organization-unit and position DTO contract.
 *
 * WHAT THESE SPECS PIN, AND WHAT THEY DELIBERATELY DO NOT
 * ------------------------------------------------------
 * The DTO can only assert shape. "Is this parent MINE?" and "does this position belong to
 * the unit I am recording?" are TENANCY questions that a DTO has no business answering,
 * and they are covered against real Postgres by the service/DB guard instead. What is
 * asserted here is the part a DTO really owns:
 *
 *   * a `code` is a bounded machine key (`A-Z 0-9 . _ / -`), while Persian `name`/`title`
 *     text is unrestricted — the catalogue is meant to be written in Persian;
 *   * `null parentId` means "detach to the root" and must stay expressible, distinct from
 *     "not in this request";
 *   * no `tenantId` field exists anywhere, and sending one is a 400.
 */

async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

describe('HR_CODE_PATTERN', () => {
  it('accepts a machine key and rejects one that needs escaping in a URL or a log', () => {
    expect(HR_CODE_PATTERN.test('FIN-01')).toBe(true);
    expect(HR_CODE_PATTERN.test('FIN/SUB_01.D')).toBe(true);
    expect(HR_CODE_PATTERN.test('FIN 01')).toBe(false);
    expect(HR_CODE_PATTERN.test('-FIN')).toBe(false);
    expect(HR_CODE_PATTERN.test('fin')).toBe(false);
  });
});

describe('CreateOrganizationUnitDto', () => {
  it('allows Persian names and requires a machine key for the code', async () => {
    const ok = await check(CreateOrganizationUnitDto, {
      code: 'FIN',
      name: 'واحد مالی',
    });
    expect(ok.failed).toEqual([]);

    // The code is a stable key, so a Persian value is not accepted THERE even though the
    // name is. A code that needs URL-encoding would break every export and route.
    const persianCode = await check(CreateOrganizationUnitDto, { code: 'مالی', name: 'واحد مالی' });
    expect(persianCode.failed).toEqual(['code']);
  });

  it('treats an absent parentId as a root unit and accepts an explicit UUID', async () => {
    expect(await check(CreateOrganizationUnitDto, { code: 'FIN', name: 'مالی' })).toMatchObject({
      failed: [],
    });

    const withParent = await check(CreateOrganizationUnitDto, {
      code: 'FIN',
      name: 'مالی',
      parentId: '11111111-1111-4111-8111-111111111111',
    });
    expect(withParent.failed).toEqual([]);
  });

  it('bounds the name so a 400 precedes the varchar overflow', async () => {
    const { failed } = await check(CreateOrganizationUnitDto, {
      code: 'FIN',
      name: 'x'.repeat(MAX_UNIT_NAME_LENGTH + 1),
    });

    expect(failed).toEqual(['name']);
  });
});

describe('UpdateOrganizationUnitDto', () => {
  it('distinguishes null (detach to root) from undefined (leave as-is)', async () => {
    // A PATCH whose `parentId` is `null` must reach the service as `null`, because the
    // service writes the column only when it is not `undefined`.
    const detach = await check(UpdateOrganizationUnitDto, { parentId: null });
    expect(detach.failed).toEqual([]);
    expect((detach.instance as UpdateOrganizationUnitDto).parentId).toBeNull();

    const rename = await check(UpdateOrganizationUnitDto, { name: 'واحد مالی و اداری' });
    expect((rename.instance as UpdateOrganizationUnitDto).parentId).toBeUndefined();
  });

  it('does not accept a code change, because the code is the stable key', async () => {
    const { failed } = await check(UpdateOrganizationUnitDto, { code: 'NEW' });

    expect(failed).toEqual(['code']);
  });
});

describe('CreatePositionDto', () => {
  it('requires a unit, and accepts a Persian title', async () => {
    const ok = await check(CreatePositionDto, {
      code: 'ACC-1',
      title: 'کارشناس ارشد حسابداری',
      organizationUnitId: '11111111-1111-4111-8111-111111111111',
    });
    expect(ok.failed).toEqual([]);

    const noUnit = await check(CreatePositionDto, { code: 'ACC-1', title: 'کارشناس' });
    expect(noUnit.failed).toEqual(['organizationUnitId']);
  });

  it('refuses a tenantId planted on the body', async () => {
    const { failed } = await check(CreatePositionDto, {
      code: 'ACC-1',
      title: 'کارشناس',
      organizationUnitId: '11111111-1111-4111-8111-111111111111',
      tenantId: '33333333-3333-4333-8333-333333333333',
    });

    expect(failed).toEqual(['tenantId']);
  });
});

describe('SetRecordStatusDto', () => {
  it('is the only lifecycle end for a unit or a position — there is no delete', async () => {
    expect(await check(SetRecordStatusDto, { status: 'INACTIVE' })).toMatchObject({ failed: [] });
    expect((await check(SetRecordStatusDto, { status: 'DELETED' })).failed).toEqual(['status']);
  });
});
