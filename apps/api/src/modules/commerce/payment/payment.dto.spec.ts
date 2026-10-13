import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { PURCHASE_MAX_MONEY_AMOUNT } from '../purchase/purchase-money';
import { CompensatePaymentDto, CreatePaymentDto, ListPaymentsQueryDto } from './payment.dto';
import { PAYMENT_METHODS } from './payment-status';

/**
 * Phase C1 Step Q (contract §3-C, §3-E, §6, §7): the wire boundary of the three payment
 * routes. Every refusal the contract names is one test here:
 *
 *  1. THE AMOUNT IS THE COLUMN'S DOMAIN AT THE EDGE — positive, at most four decimals,
 *     at most `Decimal(18,4)` can hold: a violation is a 400 naming the field, never a
 *     driver error (§3-E).
 *  2. THE METHOD IS THE CLOSED TUPLE — `CASH`/`PETTY_CASH`/`CHECK`; a fourth member
 *     arrives with its migration, never through a payload (Q3).
 *  3. REFERENCES ARE `VARCHAR(128)` AND NOTHING MORE — opaque strings with a column
 *     width, no entity behind them to validate against (§13).
 *  4. `tenantId`, `currency` AND `reversesPaymentId` ARE NOT DECLARED FIELDS — the
 *     tenant comes from the actor, the currency is snapshotted from the document (Q5),
 *     the reversal link is stated by the path and the server (Q4). Under the global
 *     pipe's `whitelist` + `forbidNonWhitelisted` each is a 400, not a silently ignored
 *     field.
 *  5. AN EMPTY COMPENSATE BODY IS COMPLETE (§3-D) — every field is optional because the
 *     row's defining facts are never client-stated.
 */

/** Runs the real global pipe behaviour: transform, then validate with whitelist. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const VALID_PAYMENT = { amount: 30.5, method: 'CASH' };

describe('Phase C1 Step Q — CreatePaymentDto', () => {
  it('accepts a payment of each closed method with only the two required fields', async () => {
    for (const method of PAYMENT_METHODS) {
      const { failed } = await check(CreatePaymentDto, { amount: 0.0001, method });
      expect(failed).toEqual([]);
    }
  });

  it('accepts every optional field a caller may state', async () => {
    const { failed } = await check(CreatePaymentDto, {
      amount: 1000000,
      method: 'PETTY_CASH',
      paymentDate: '2026-09-20T10:00:00.000Z',
      payerRef: 'payer-7',
      payeeRef: 'payee-9',
      invoiceRef: 'INV-42',
      externalReference: 'EXT-42',
    });
    expect(failed).toEqual([]);
  });

  it('refuses a non-positive amount — a payment of nothing is not a payment', async () => {
    expect((await check(CreatePaymentDto, { ...VALID_PAYMENT, amount: 0 })).failed).toContain(
      'amount'
    );
    expect((await check(CreatePaymentDto, { ...VALID_PAYMENT, amount: -1 })).failed).toContain(
      'amount'
    );
  });

  it('refuses a fifth decimal at the edge — the column holds four', async () => {
    const { failed } = await check(CreatePaymentDto, { ...VALID_PAYMENT, amount: 1.12345 });
    expect(failed).toContain('amount');
  });

  it('refuses an amount the Decimal(18,4) column cannot hold', async () => {
    const { failed } = await check(CreatePaymentDto, {
      ...VALID_PAYMENT,
      amount: PURCHASE_MAX_MONEY_AMOUNT + 1,
    });
    expect(failed).toContain('amount');
  });

  it('refuses a non-numeric amount rather than coercing it', async () => {
    const { failed } = await check(CreatePaymentDto, { ...VALID_PAYMENT, amount: 'thirty' });
    expect(failed).toContain('amount');
  });

  it('refuses an unknown method — WIRE is not a member of the closed tuple', async () => {
    const { failed } = await check(CreatePaymentDto, { ...VALID_PAYMENT, method: 'WIRE' });
    expect(failed).toContain('method');
  });

  it('refuses oversized references — each is a VARCHAR(128)', async () => {
    for (const field of ['payerRef', 'payeeRef', 'invoiceRef', 'externalReference']) {
      const { failed } = await check(CreatePaymentDto, {
        ...VALID_PAYMENT,
        [field]: 'x'.repeat(129),
      });
      expect(failed).toContain(field);
    }
  });

  it('refuses a malformed paymentDate — an instant, not prose', async () => {
    const { failed } = await check(CreatePaymentDto, {
      ...VALID_PAYMENT,
      paymentDate: 'yesterday-ish',
    });
    expect(failed).toContain('paymentDate');
  });

  it('refuses tenantId, currency and reversesPaymentId — none of the three is client-stated', async () => {
    // The tenant comes from the actor (§3-F); the pipe treats an undeclared field as a
    // 400 rather than a silently ignored one.
    expect((await check(CreatePaymentDto, { ...VALID_PAYMENT, tenantId: 't1' })).failed).toContain(
      'tenantId'
    );
    // The currency is snapshotted from the document (Q5) and the reversal link is the
    // route's own fact (Q4): both are deliberately ABSENT from the DTO, so both are
    // non-whitelisted.
    expect((await check(CreatePaymentDto, { ...VALID_PAYMENT, currency: 'EUR' })).failed).toContain(
      'currency'
    );
    expect(
      (await check(CreatePaymentDto, { ...VALID_PAYMENT, reversesPaymentId: 'p-1' })).failed
    ).toContain('reversesPaymentId');
  });
});

describe('Phase C1 Step Q — CompensatePaymentDto', () => {
  it('accepts an EMPTY body — the row’s defining facts are never client-stated (§3-D)', async () => {
    // An empty POST is a COMPLETE request: amount is the exact negation, method and
    // currency are mirrored, the link comes from the path.
    const { failed } = await check(CompensatePaymentDto, {});
    expect(failed).toEqual([]);
  });

  it('accepts its own evidence: a stated instant, its own reference and a reason', async () => {
    const { failed } = await check(CompensatePaymentDto, {
      paymentDate: '2026-09-20T10:00:00.000Z',
      externalReference: 'CORR-77',
      reason: 'recorded against the wrong invoice',
    });
    expect(failed).toEqual([]);
  });

  it('refuses a reason longer than 500 — it rides the audit event, not a column (§3-G)', async () => {
    const { failed } = await check(CompensatePaymentDto, { reason: 'x'.repeat(501) });
    expect(failed).toContain('reason');
  });

  it('refuses an amount — a compensation never states the negation itself (Q4)', async () => {
    const { failed } = await check(CompensatePaymentDto, { amount: -26.25 });
    expect(failed).toContain('amount');
  });

  it('refuses an oversized externalReference, like every reference (VARCHAR(128))', async () => {
    const { failed } = await check(CompensatePaymentDto, { externalReference: 'x'.repeat(129) });
    expect(failed).toContain('externalReference');
  });
});

describe('Phase C1 Step Q — ListPaymentsQueryDto', () => {
  it('accepts a method filter from the closed tuple, over the shared page envelope', async () => {
    for (const method of PAYMENT_METHODS) {
      const { failed } = await check(ListPaymentsQueryDto, { method, page: 2, pageSize: 10 });
      expect(failed).toEqual([]);
    }
  });

  it('refuses an unknown method and a page beyond the shared ceiling (Q9)', async () => {
    expect((await check(ListPaymentsQueryDto, { method: 'WIRE' })).failed).toContain('method');
    expect(
      (await check(ListPaymentsQueryDto, { pageSize: COMMERCE_MAX_PAGE_SIZE + 1 })).failed
    ).toContain('pageSize');
    expect((await check(ListPaymentsQueryDto, { page: 0 })).failed).toContain('page');
  });
});
