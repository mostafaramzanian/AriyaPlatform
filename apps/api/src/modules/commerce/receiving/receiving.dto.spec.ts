import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MAX_PURCHASE_LINES } from '../purchase/purchase.dto';
import { PURCHASE_MAX_MONEY_AMOUNT } from '../purchase/purchase-money';
import { CompensateReceiptLineDto, CreateReceiptDto } from './receiving.dto';

/**
 * Phase C1 Step R (contract R7, §3-C, §3-E, §6, §7): the wire boundary of the
 * three receiving routes. Every refusal the contract names is one test here:
 *
 *  1. THE QUANTITY IS THE COLUMN'S DOMAIN AT THE EDGE — strictly positive
 *     (`0.0001` is the floor: a zero receiving is not a receiving), at most four
 *     decimals, at most `Decimal(18,4)` can hold, and NEVER negative: the sign of
 *     a compensating line is the SERVER's decision (§3-D), so a negative
 *     quantity is not expressible at all.
 *  2. `lines` IS REQUIRED, NON-EMPTY AND BOUNDED — one operation cannot touch
 *     more lines than a document can hold, and an operation that receives
 *     nothing is not a receiving operation.
 *  3. `tenantId`, `receiverId`, `reversesReceiptLineId` AND ANY `status` ARE NOT
 *     DECLARED FIELDS — the tenant comes from the actor (§3-F), the receiver is
 *     the acting session's user (§16), the compensation link is stated by the
 *     PATH and the server (§3-D), and receiving status is a read-time
 *     projection (R5) with nothing to state. Under the global pipe's
 *     `whitelist` + `forbidNonWhitelisted` each is a 400, not a silently
 *     ignored field.
 *  4. THE COMPENSATE BODY REQUIRES `quantity` — unlike Q's full negation, a
 *     correction may be PARTIAL, so the magnitude is a decision the caller must
 *     state; the DTO refuses to guess it.
 */

/** Runs the real global pipe behaviour: transform, then validate with whitelist. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const LINE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_LINE_ID = '22222222-2222-4222-8222-222222222222';

const VALID_LINE = { purchaseLineId: LINE_ID, quantity: 2.5 };
const VALID_RECEIPT = { lines: [VALID_LINE] };
describe('Phase C1 Step R — CreateReceiptDto', () => {
  it('accepts a one-line receipt with only the required fields', async () => {
    const { failed } = await check(CreateReceiptDto, VALID_RECEIPT);
    expect(failed).toEqual([]);
  });

  it('accepts receivedAt and several lines — including the SAME purchase line twice (§3-C)', async () => {
    const { failed } = await check(CreateReceiptDto, {
      receivedAt: '2026-09-20T10:00:00.000Z',
      lines: [
        VALID_LINE,
        { purchaseLineId: LINE_ID, quantity: 3.5 }, // a second arrival, same line
        { purchaseLineId: OTHER_LINE_ID, quantity: 0.0001 },
      ],
    });
    expect(failed).toEqual([]);
  });

  it('accepts the column’s exact bounds: 0.0001 and the largest Decimal(18,4) value (§3-C)', async () => {
    const floor = await check(CreateReceiptDto, {
      lines: [{ purchaseLineId: LINE_ID, quantity: 0.0001 }],
    });
    expect(floor.failed).toEqual([]);

    const ceiling = await check(CreateReceiptDto, {
      lines: [{ purchaseLineId: LINE_ID, quantity: PURCHASE_MAX_MONEY_AMOUNT }],
    });
    expect(ceiling.failed).toEqual([]);
  });

  it('refuses an empty lines array — a receipt that receives nothing is not a receiving operation', async () => {
    expect((await check(CreateReceiptDto, { lines: [] })).failed).toContain('lines');
  });

  it('refuses a missing lines field entirely', async () => {
    expect((await check(CreateReceiptDto, {})).failed).toContain('lines');
    expect(
      (await check(CreateReceiptDto, { receivedAt: '2026-09-20T10:00:00.000Z' })).failed
    ).toContain('lines');
  });

  it('refuses more lines than a document can hold, and accepts exactly the ceiling (§3-C)', async () => {
    const line = (index: number) => ({
      purchaseLineId: `1111111${index % 10}-1111-4111-8111-11111111111${index % 10}`,
      quantity: 1,
    });
    // The ceiling itself is legal: one operation touching every line of the
    // largest document MAX_PURCHASE_LINES describes.
    const atCeiling = await check(CreateReceiptDto, {
      lines: Array.from({ length: MAX_PURCHASE_LINES }, (_, index) => line(index)),
    });
    expect(atCeiling.failed).toEqual([]);

    const overCeiling = await check(CreateReceiptDto, {
      lines: Array.from({ length: MAX_PURCHASE_LINES + 1 }, (_, index) => line(index)),
    });
    expect(overCeiling.failed).toContain('lines');
  });

  it('refuses a purchaseLineId that is not a UUID — the boundary never trusts an id shape', async () => {
    const { failed } = await check(CreateReceiptDto, {
      lines: [{ purchaseLineId: 'line-1', quantity: 1 }],
    });
    expect(failed).toContain('lines');
  });

  it('refuses a zero, a negative or a fifth-decimal quantity — the column holds four, positive (§3-C)', async () => {
    for (const quantity of [0, -1, 1.12345]) {
      const { failed } = await check(CreateReceiptDto, {
        lines: [{ purchaseLineId: LINE_ID, quantity }],
      });
      expect({ quantity, rejected: failed.includes('lines') }).toEqual({
        quantity,
        rejected: true,
      });
    }
  });

  it('refuses a quantity the Decimal(18,4) column cannot hold', async () => {
    const { failed } = await check(CreateReceiptDto, {
      lines: [{ purchaseLineId: LINE_ID, quantity: PURCHASE_MAX_MONEY_AMOUNT + 1 }],
    });
    expect(failed).toContain('lines');
  });

  it('refuses a malformed receivedAt — an instant, not prose', async () => {
    const { failed } = await check(CreateReceiptDto, {
      ...VALID_RECEIPT,
      receivedAt: 'yesterday-ish',
    });
    expect(failed).toContain('receivedAt');
  });
  it('refuses tenantId, receiverId, reversesReceiptLineId and status — none of them is client-stated', async () => {
    // The tenant comes from the actor (§3-F); the receiver is the session's user
    // (§16); the compensation link is the compensation ROUTE's fact (§3-D); and
    // receiving status is a projection with nothing to state (R5). The pipe
    // treats each undeclared field as a 400 rather than a silently ignored one.
    for (const field of ['tenantId', 'receiverId', 'reversesReceiptLineId', 'status']) {
      const { failed } = await check(CreateReceiptDto, { ...VALID_RECEIPT, [field]: 'x' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase C1 Step R — CompensateReceiptLineDto', () => {
  it('REQUIRES quantity — a partial correction states its own magnitude (R4, §3-D)', async () => {
    // The deliberate contrast with `CompensatePaymentDto`: that reversal is the
    // exact negation of a known row, while this one may be PARTIAL, so the
    // amount is a caller's decision and an empty body is INCOMPLETE.
    expect((await check(CompensateReceiptLineDto, {})).failed).toContain('quantity');
  });

  it('accepts a stated magnitude with its own evidence: an instant and a reason', async () => {
    expect((await check(CompensateReceiptLineDto, { quantity: 20 })).failed).toEqual([]);
    const { failed } = await check(CompensateReceiptLineDto, {
      quantity: 0.0001,
      receivedAt: '2026-09-20T10:00:00.000Z',
      reason: 'the delivery was returned to the supplier',
    });
    expect(failed).toEqual([]);
  });

  it('refuses a zero, a negative, a fifth-decimal or an oversized magnitude (§3-C, §3-D)', async () => {
    for (const quantity of [0, -20, 1.12345, PURCHASE_MAX_MONEY_AMOUNT + 1]) {
      const { failed } = await check(CompensateReceiptLineDto, { quantity });
      expect({ quantity, rejected: failed.includes('quantity') }).toEqual({
        quantity,
        rejected: true,
      });
    }
  });

  it('refuses a reason longer than 500 — it rides the audit event, not a column (§3-G)', async () => {
    const { failed } = await check(CompensateReceiptLineDto, {
      quantity: 10,
      reason: 'x'.repeat(501),
    });
    expect(failed).toContain('reason');
  });

  it('refuses a non-string reason — the event’s field is text or nothing', async () => {
    expect((await check(CompensateReceiptLineDto, { quantity: 10, reason: 42 })).failed).toContain(
      'reason'
    );
  });

  it('refuses a malformed receivedAt', async () => {
    const { failed } = await check(CompensateReceiptLineDto, {
      quantity: 10,
      receivedAt: 'yesterday-ish',
    });
    expect(failed).toContain('receivedAt');
  });

  it('refuses tenantId, receiverId, reversesReceiptLineId and status here too', async () => {
    for (const field of ['tenantId', 'receiverId', 'reversesReceiptLineId', 'status']) {
      const { failed } = await check(CompensateReceiptLineDto, { quantity: 10, [field]: 'x' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});
