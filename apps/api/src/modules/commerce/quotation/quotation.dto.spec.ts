import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  CreatePriceQuotationDto,
  ListQuotationsQueryDto,
  QuotationDecisionDto,
} from './quotation.dto';

/**
 * PHASE GAP-6: the wire boundary of the three quotation routes — every refusal
 * the DTO names is one test here, and the SERVICE-vs-DTO split is explicit:
 * the "lines AND stated total" mix is refused by the SERVICE (a rule about two
 * fields the boundary deliberately lets through), so this suite asserts the
 * boundary does NOT pre-refuse it.
 */
const UUID_ID = '11111111-1111-4111-8111-111111111111';

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
  // `whitelist` + `forbidNonWhitelisted` mirrors the global ValidationPipe the routes
  // actually run under — an unknown field is a refusal there, and must be provable here.
  const errors = await validate(plainToInstance(type, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errorPaths(errors).sort();
}

describe('GAP-6 CreatePriceQuotationDto', () => {
  it('accepts the minimal scan-only body and the full itemised body', async () => {
    expect(await failedFields(CreatePriceQuotationDto, { purchaseDocumentId: UUID_ID })).toEqual([]);

    expect(
      await failedFields(CreatePriceQuotationDto, {
        purchaseDocumentId: UUID_ID,
        supplierLabel: 'فروشنده',
        quoteReference: 'PF-77',
        quoteDate: '2026-10-01',
        currency: 'IRR',
        attachmentRef: 'scans/pf-77.pdf',
        notes: 'تحویل ظرف دو هفته',
        lines: [{ description: 'سنسور', quantity: 2, unitPrice: 12.5 }],
      })
    ).toEqual([]);
  });

  it('refuses a non-UUID document id', async () => {
    expect(
      await failedFields(CreatePriceQuotationDto, { purchaseDocumentId: 'not-a-uuid' })
    ).toEqual(['purchaseDocumentId']);
  });

  it('refuses the seller/date/reference bound violations at the edge', async () => {
    expect(
      await failedFields(CreatePriceQuotationDto, {
        purchaseDocumentId: UUID_ID,
        supplierLabel: 'x'.repeat(256),
      })
    ).toEqual(['supplierLabel']);
    expect(
      await failedFields(CreatePriceQuotationDto, {
        purchaseDocumentId: UUID_ID,
        quoteDate: 'yesterday',
      })
    ).toEqual(['quoteDate']);
  });

  it('validates a line with the purchase line’s own money rules', async () => {
    const base = { purchaseDocumentId: UUID_ID, lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] };

    expect(await failedFields(CreatePriceQuotationDto, base)).toEqual([]);

    // A zero quantity is not a line; a fifth decimal is a different precision model;
    // a negative unit price is unstorable. The leaf (not the container) must be the
    // field class-validator reports, at whatever nesting depth it uses.
    const leaves = async (payload: unknown) => {
      const paths = await failedFields(CreatePriceQuotationDto, payload);
      expect(paths.length).toBeGreaterThan(0);
      return paths;
    };

    expect(
      (await leaves({ ...base, lines: [{ description: 'x', quantity: 0, unitPrice: 1 }] })).some((p) =>
        p.endsWith('quantity')
      )
    ).toBe(true);
    expect(
      (await leaves({ ...base, lines: [{ description: 'x', quantity: 1.00001, unitPrice: 1 }] })).some(
        (p) => p.endsWith('quantity')
      )
    ).toBe(true);
    expect(
      (await leaves({ ...base, lines: [{ description: 'x', quantity: 1, unitPrice: -1 }] })).some((p) =>
        p.endsWith('unitPrice')
      )
    ).toBe(true);

    // Present-but-empty and over-ceiling arrays are refused by the boundary itself.
    expect(await failedFields(CreatePriceQuotationDto, { ...base, lines: [] })).toEqual(['lines']);
    expect(
      await failedFields(CreatePriceQuotationDto, {
        ...base,
        lines: Array.from({ length: 201 }, () => ({ description: 'x', quantity: 1, unitPrice: 1 })),
      })
    ).toEqual(['lines']);
  });

  it('lets the lines+total mix through the BOUNDARY — the service owns that rule', async () => {
    expect(
      await failedFields(CreatePriceQuotationDto, {
        purchaseDocumentId: UUID_ID,
        totalAmount: 100,
        lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
      })
    ).toEqual([]);
  });
});

describe('GAP-6 QuotationDecisionDto', () => {
  it('accepts only the two wire decisions', async () => {
    expect(await failedFields(QuotationDecisionDto, { decision: 'CONFIRM' })).toEqual([]);
    expect(await failedFields(QuotationDecisionDto, { decision: 'RETURN', comment: 'مدل اشتباه' })).toEqual([]);
    expect(await failedFields(QuotationDecisionDto, { decision: 'APPROVE' })).toEqual(['decision']);
  });

  it('bounds the comment, and never accepts a tenant or actor', async () => {
    expect(await failedFields(QuotationDecisionDto, { decision: 'CONFIRM', comment: 'x'.repeat(1001) })).toEqual([
      'comment',
    ]);
    expect(await failedFields(QuotationDecisionDto, { decision: 'CONFIRM', tenantId: 't1' })).toEqual([
      'tenantId',
    ]);
    expect(await failedFields(QuotationDecisionDto, { decision: 'CONFIRM', userId: 'u1' })).toEqual([
      'userId',
    ]);
  });
});

describe('GAP-6 ListQuotationsQueryDto', () => {
  it('requires exactly one UUID document id', async () => {
    expect(await failedFields(ListQuotationsQueryDto, { documentId: UUID_ID })).toEqual([]);
    expect(await failedFields(ListQuotationsQueryDto, {})).toEqual(['documentId']);
    expect(await failedFields(ListQuotationsQueryDto, { documentId: 'x' })).toEqual(['documentId']);
  });
});
