import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MAX_PURCHASE_LINES } from '../purchase/purchase.dto';
import { PURCHASE_MAX_MONEY_AMOUNT } from '../purchase/purchase-money';
import {
  CreateReturnDto,
  ReceiveBackReturnDto,
  RefundReturnDto,
  ReturnDecisionDto,
} from './return.dto';

/**
 * Phase C1 Step S (contract §7, §10): the wire boundary of the SIX return
 * routes. Every refusal §10 names at the DTO is one test here:
 *
 *  1. THE QUANTITY IS THE COLUMN'S DOMAIN AT THE EDGE — strictly positive
 *     (`0.0001` is the floor), at most four decimals, at most
 *     `Decimal(18,4)` can hold; one precision model, the same one PurchaseLine
 *     and Receiving use.
 *  2. `reason` IS `1…500` AND NON-EMPTY AFTER TRIM — required on create,
 *     optional-but-honest on the decision commands: an ABSENT reason is
 *     complete, a stated-but-empty one is a 400 (§4-B/§10).
 *  3. `replacementRequired` AND `lines` ARE REQUIRED — `false` is a stated
 *     fact, never an omission, and a return with no lines is not a return.
 *  4. THE §7 FORBIDDEN FIELD LIST IS NOT DECLARABLE — `tenantId`,
 *     `requestedByUserId`, `state`, `purchaseDocumentId`, … under the global
 *     pipe's `whitelist` + `forbidNonWhitelisted` each is a 400 on the
 *     offending field, not a silently ignored one. The SAME list is run
 *     against ALL FOUR DTOs, because a field that is forgotten on one payload
 *     is an injection on that one route.
 *
 * Runs the real global-pipe behaviour: `plainToInstance`, then `validate`
 * with `whitelist` + `forbidNonWhitelisted` — the same two options the
 * application's ValidationPipe is configured with.
 */

/**
 * Runs the real global pipe behaviour: `plainToInstance`, then `validate`
 * with the EXACT options `main.ts` configures the application's
 * ValidationPipe with — `whitelist` + `forbidNonWhitelisted` +
 * `forbidUnknownValues`. The third option is why this spec passes it while
 * Q's and R's do not: their DTOs all carry metadata, so the option's
 * metadata-less short-circuit is unobservable there, while the slice's
 * empty-bodied receive-back route makes it the difference between a route
 * that works and a route that 400s every correct call.
 */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return { instance, failed: errors.map((error) => error.property) };
}

const PURCHASE_LINE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PURCHASE_LINE_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_LINE_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';

const VALID_LINE = {
  purchaseLineId: PURCHASE_LINE_ID,
  receiptLineId: RECEIPT_LINE_ID,
  quantity: 2.5,
};
const VALID_CREATE = {
  reason: 'damaged on arrival',
  replacementRequired: false,
  lines: [VALID_LINE],
};

/** The §7 forbidden list, verbatim — every payload of the slice, every time. */
const FORBIDDEN_FIELDS = [
  'tenantId',
  'requesterId',
  'requestedByUserId',
  'actorId',
  'receiverId',
  'id',
  'state',
  'status',
  'purchaseDocumentId',
  'createdAt',
  'transitions',
  'reversesReturnLineId',
  'replacementPurchaseId',
  'currency',
];

describe('Phase C1 Step S — CreateReturnDto (route 2)', () => {
  it('accepts a one-line return with only the required fields', async () => {
    expect((await check(CreateReturnDto, VALID_CREATE)).failed).toEqual([]);
  });

  it('accepts a multi-line return and a STATED replacementRequired true (no default, §4-B)', async () => {
    const { instance, failed } = await check(CreateReturnDto, {
      ...VALID_CREATE,
      replacementRequired: true,
      lines: [
        VALID_LINE,
        {
          purchaseLineId: OTHER_PURCHASE_LINE_ID,
          receiptLineId: RECEIPT_LINE_ID,
          quantity: 0.0001,
        },
      ],
    });
    expect(failed).toEqual([]);
    expect((instance as CreateReturnDto).replacementRequired).toBe(true);
  });

  it('refuses a missing or empty reason — and a reason that is empty AFTER trim', async () => {
    expect((await check(CreateReturnDto, { ...VALID_CREATE, reason: undefined })).failed).toContain(
      'reason'
    );
    expect((await check(CreateReturnDto, { ...VALID_CREATE, reason: '' })).failed).toContain(
      'reason'
    );
    expect((await check(CreateReturnDto, { ...VALID_CREATE, reason: '   ' })).failed).toContain(
      'reason'
    );
  });

  it('accepts exactly 500 characters and refuses 501 (the stated bound, §4-B)', async () => {
    expect(
      (await check(CreateReturnDto, { ...VALID_CREATE, reason: 'x'.repeat(500) })).failed
    ).toEqual([]);
    expect(
      (await check(CreateReturnDto, { ...VALID_CREATE, reason: 'x'.repeat(501) })).failed
    ).toContain('reason');
  });

  it('refuses a non-string reason — free text or nothing, never a number', async () => {
    expect((await check(CreateReturnDto, { ...VALID_CREATE, reason: 42 })).failed).toContain(
      'reason'
    );
  });

  it('refuses a missing replacementRequired — `false` is a stated fact, not an omission (§4-B)', async () => {
    const { reason, lines } = VALID_CREATE;
    expect((await check(CreateReturnDto, { reason, lines })).failed).toContain(
      'replacementRequired'
    );
    // …and the STATED false is accepted, so the refusal is about ABSENCE.
    expect(
      (await check(CreateReturnDto, { reason, replacementRequired: false, lines })).failed
    ).toEqual([]);
    expect(
      (await check(CreateReturnDto, { reason, replacementRequired: 'false', lines })).failed
    ).toContain('replacementRequired');
  });

  it('refuses empty or missing lines — a return that returns nothing is not a return', async () => {
    expect((await check(CreateReturnDto, { ...VALID_CREATE, lines: [] })).failed).toContain(
      'lines'
    );
    const { reason, replacementRequired } = VALID_CREATE;
    expect((await check(CreateReturnDto, { reason, replacementRequired })).failed).toContain(
      'lines'
    );
  });

  it('refuses more lines than a document can hold, and accepts exactly the ceiling', async () => {
    const line = (index: number) => ({
      purchaseLineId: `1111111${index % 10}-1111-4111-8111-11111111111${index % 10}`,
      receiptLineId: `3333333${index % 10}-3333-4333-8333-33333333333${index % 10}`,
      quantity: 1,
    });
    const atCeiling = await check(CreateReturnDto, {
      ...VALID_CREATE,
      lines: Array.from({ length: MAX_PURCHASE_LINES }, (_, index) => line(index)),
    });
    expect(atCeiling.failed).toEqual([]);
    const overCeiling = await check(CreateReturnDto, {
      ...VALID_CREATE,
      lines: Array.from({ length: MAX_PURCHASE_LINES + 1 }, (_, index) => line(index)),
    });
    expect(overCeiling.failed).toContain('lines');
  });

  it('refuses a non-UUID purchaseLineId or receiptLineId — the boundary never trusts an id shape', async () => {
    for (const field of ['purchaseLineId', 'receiptLineId'] as const) {
      const { failed } = await check(CreateReturnDto, {
        ...VALID_CREATE,
        lines: [{ ...VALID_LINE, [field]: 'line-1' }],
      });
      expect({ field, rejected: failed.includes('lines') }).toEqual({ field, rejected: true });
    }
  });

  it('refuses a zero, a negative, a fifth-decimal or an oversized quantity (§10 bounds)', async () => {
    for (const quantity of [0, -1, 1.12345, PURCHASE_MAX_MONEY_AMOUNT + 1]) {
      const { failed } = await check(CreateReturnDto, {
        ...VALID_CREATE,
        lines: [{ ...VALID_LINE, quantity }],
      });
      expect({ quantity, rejected: failed.includes('lines') }).toEqual({
        quantity,
        rejected: true,
      });
    }
    // The floor and the ceiling themselves are legal — the bound is the column's.
    expect(
      (
        await check(CreateReturnDto, {
          ...VALID_CREATE,
          lines: [{ ...VALID_LINE, quantity: 0.0001 }],
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(CreateReturnDto, {
          ...VALID_CREATE,
          lines: [{ ...VALID_LINE, quantity: PURCHASE_MAX_MONEY_AMOUNT }],
        })
      ).failed
    ).toEqual([]);
  });
});

describe('Phase C1 Step S — ReturnDecisionDto (routes 3 approve, 4 reject)', () => {
  it('accepts the EMPTY body — a decision states no reason by default (§7)', async () => {
    expect((await check(ReturnDecisionDto, {})).failed).toEqual([]);
  });

  it('accepts an optional stated reason, within the same 1…500 rule', async () => {
    expect(
      (await check(ReturnDecisionDto, { reason: 'supplier confirmed the defect' })).failed
    ).toEqual([]);
    expect((await check(ReturnDecisionDto, { reason: 'x'.repeat(500) })).failed).toEqual([]);
  });

  it('refuses an empty-after-trim, over-long or non-string stated reason', async () => {
    for (const reason of ['', '   ', 'x'.repeat(501), 42]) {
      const { failed } = await check(ReturnDecisionDto, { reason });
      expect({ reason: String(reason).slice(0, 12), rejected: failed.includes('reason') }).toEqual({
        reason: String(reason).slice(0, 12),
        rejected: true,
      });
    }
  });
});

describe('Phase C1 Step S — ReceiveBackReturnDto (route 5)', () => {
  it('accepts the empty body — receive-back states nothing at all (§7)', async () => {
    expect((await check(ReceiveBackReturnDto, {})).failed).toEqual([]);
  });

  it('refuses the anchor property with ANY value — no value of it is statable', async () => {
    // The metadata anchor that keeps whitelist enforcement alive on this
    // route (see the DTO's own note) must be unreachable: MinLength(1) ∧
    // MaxLength(0) admits no string, and a non-string fails IsString.
    for (const value of ['', 'x', 42, { nested: true }]) {
      const { failed } = await check(ReceiveBackReturnDto, { _acceptsNoField: value });
      expect({ value: String(value), rejected: failed.includes('_acceptsNoField') }).toEqual({
        value: String(value),
        rejected: true,
      });
    }
    // …and null rides `@IsOptional`'s skip — but is still unread by any code.
    expect((await check(ReceiveBackReturnDto, { _acceptsNoField: null })).failed).toEqual([]);
  });

  it('refuses EVERY stated field, including the §7 list — an empty DTO is a closed door', async () => {
    for (const field of FORBIDDEN_FIELDS) {
      const { failed } = await check(ReceiveBackReturnDto, { [field]: 'x' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase C1 Step S — RefundReturnDto (route 6)', () => {
  it('REQUIRES paymentId as a UUID — the Q-side target is the only stated fact (§4-E)', async () => {
    expect((await check(RefundReturnDto, {})).failed).toContain('paymentId');
    expect((await check(RefundReturnDto, { paymentId: 'not-a-uuid' })).failed).toContain(
      'paymentId'
    );
    expect((await check(RefundReturnDto, { paymentId: PAYMENT_ID })).failed).toEqual([]);
  });

  it('accepts the optional reason under the same rule, and never a stated amount or currency', async () => {
    expect(
      (await check(RefundReturnDto, { paymentId: PAYMENT_ID, reason: 'goods returned' })).failed
    ).toEqual([]);
    // Q computes the exact negation of the target row; a payload that could
    // state money would be a second owner of payment amounts (§4-E, §5).
    for (const field of ['amount', 'currency', 'method']) {
      const { failed } = await check(RefundReturnDto, {
        paymentId: PAYMENT_ID,
        [field]: 'x',
      });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase C1 Step S — the §7 forbidden field list, across ALL FOUR payloads', () => {
  it('refuses every forbidden field on create, approve, receive-back and refund', async () => {
    expect(FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(14); // non-vacuity: the list is the §7 list
    const payloads: [new () => object, Record<string, unknown>][] = [
      [CreateReturnDto, VALID_CREATE],
      [ReturnDecisionDto, { reason: 'checked twice' }],
      [ReceiveBackReturnDto, {}],
      [RefundReturnDto, { paymentId: PAYMENT_ID }],
    ];
    for (const [cls, payload] of payloads) {
      for (const field of FORBIDDEN_FIELDS) {
        const { failed } = await check(cls, { ...payload, [field]: 'x' });
        expect({ dto: cls.name, field, rejected: failed.includes(field) }).toEqual({
          dto: cls.name,
          field,
          rejected: true,
        });
      }
    }
  });
});
