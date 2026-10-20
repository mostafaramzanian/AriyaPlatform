import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import {
  CreateSupplierDto,
  ListSuppliersQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';

/**
 * The supplier directory's wire boundary — every format rule the DTO names is
 * one test here, and the SERVICE-vs-DTO split is explicit: "LEGAL requires
 * companyName", the exact-identity duplicate rule and "an update must name a
 * field" are refused by the SERVICE (rules about values the boundary
 * deliberately lets through), so this suite asserts the boundary does NOT
 * pre-refuse them.
 */

/** Leaf paths of every validation error, nested children included, in dot notation. */
function errorPaths(errors: readonly ValidationError[], prefix = ''): string[] {
  const paths: string[] = [];
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const children = error.children ?? [];
    if (children.length > 0) paths.push(...errorPaths(children, path));
    else paths.push(path);
  }
  return paths;
}

async function failedFields<T extends object>(type: new () => T, payload: unknown) {
  // `whitelist` + `forbidNonWhitelisted` mirrors the global ValidationPipe the
  // routes actually run under — an unknown field (e.g. `tenantId`) is a refusal
  // there, and must be provable here.
  const errors = await validate(plainToInstance(type, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errorPaths(errors).sort();
}

describe('supplier CreateSupplierDto', () => {
  it('accepts a minimal INDIVIDUAL body and a full LEGAL body', async () => {
    expect(await failedFields(CreateSupplierDto, { entityType: 'INDIVIDUAL', name: 'علی رضایی' })).toEqual([]);

    expect(
      await failedFields(CreateSupplierDto, {
        entityType: 'LEGAL',
        name: 'پخش البرز',
        companyName: 'شرکت پخش البرز',
        nationalCode: '1086123456',
        shebaNumber: 'ir123456789012345678901234',
        cardNumber: '6037991234567890',
        bankName: 'بانک ملت',
        address: 'تهران، خیابان آزادی',
        phone: '021-55551234',
        email: 'info@alborz.example',
        notes: 'تأمین‌کننده رسمی',
        status: 'ACTIVE',
      })
    ).toEqual([]);
  });

  it('refuses an unknown entityType and a missing name', async () => {
    expect(await failedFields(CreateSupplierDto, { entityType: 'GOVERNMENT', name: 'x' })).toEqual(
      ['entityType']
    );
    expect(await failedFields(CreateSupplierDto, { entityType: 'INDIVIDUAL', name: '' })).toEqual([
      'name',
    ]);
  });

  it('refuses malformed identity fields at the edge', async () => {
    expect(
      await failedFields(CreateSupplierDto, {
        entityType: 'INDIVIDUAL',
        name: 'x',
        nationalCode: '12345', // not 10 digits
      })
    ).toEqual(['nationalCode']);

    expect(
      await failedFields(CreateSupplierDto, {
        entityType: 'INDIVIDUAL',
        name: 'x',
        shebaNumber: 'IR123', // not 24 digits
      })
    ).toEqual(['shebaNumber']);

    expect(
      await failedFields(CreateSupplierDto, {
        entityType: 'INDIVIDUAL',
        name: 'x',
        cardNumber: '60379912345', // not 16 digits
      })
    ).toEqual(['cardNumber']);
  });

  it('accepts the SHEBA with or without the IR prefix, any case', async () => {
    for (const sheba of ['IR123456789012345678901234', 'ir123456789012345678901234', '123456789012345678901234']) {
      expect(
        await failedFields(CreateSupplierDto, { entityType: 'INDIVIDUAL', name: 'x', shebaNumber: sheba })
      ).toEqual([]);
    }
  });

  it('refuses a client-supplied tenantId or actor (whitelist is on)', async () => {
    expect(
      await failedFields(CreateSupplierDto, {
        entityType: 'INDIVIDUAL',
        name: 'x',
        tenantId: 'someone-elses-tenant',
      })
    ).toEqual(['tenantId']);
  });
});

describe('supplier UpdateSupplierDto', () => {
  it('accepts a partial body and refuses a status outside the vocabulary', async () => {
    expect(await failedFields(UpdateSupplierDto, { notes: 'یادداشت' })).toEqual([]);
    expect(await failedFields(UpdateSupplierDto, { status: 'ARCHIVED' })).toEqual(['status']);
  });

  it('refuses an empty-string name (a trim-to-empty rename is a service rule, a raw empty is not)', async () => {
    expect(await failedFields(UpdateSupplierDto, { name: '' })).toEqual(['name']);
  });
});

describe('supplier ListSuppliersQueryDto', () => {
  it('accepts the page window up to the module ceiling and refuses above it', async () => {
    expect(await failedFields(ListSuppliersQueryDto, { page: 1, pageSize: COMMERCE_MAX_PAGE_SIZE })).toEqual([]);
    expect(
      await failedFields(ListSuppliersQueryDto, { pageSize: COMMERCE_MAX_PAGE_SIZE + 1 })
    ).toEqual(['pageSize']);
  });

  it('accepts exact-enum filters and refuses invented ones', async () => {
    expect(
      await failedFields(ListSuppliersQueryDto, { entityType: 'LEGAL', status: 'INACTIVE' })
    ).toEqual([]);
    expect(
      await failedFields(ListSuppliersQueryDto, { entityType: 'LEGAL', status: 'DELETED' })
    ).toEqual(['status']);
  });
});
