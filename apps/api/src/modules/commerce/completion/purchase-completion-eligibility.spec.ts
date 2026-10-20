import {
  CLOSURE_REFUSAL,
  evaluatePurchaseClosure,
  type ClosureFacts,
} from './purchase-completion-eligibility';

/**
 * PHASE W3: the ONE closure evaluator, exercised as a pure function — the facts
 * the service assembles under the document lock, the refusals the client maps.
 */

function facts(overrides: Partial<ClosureFacts> = {}): ClosureFacts {
  return {
    lines: [
      { lineId: 'l1', lineNumber: 1, orderedQuantity: '10.0000', receivedQuantity: '10.0000' },
    ],
    returns: [],
    payment: {
      totalAmount: '100.0000',
      paidAmount: '100.0000',
      refundedAmount: '0.0000',
      refundAmbiguous: false,
      openInstallmentAmount: '0.0000',
      openInstallmentCount: 0,
    },
    ...overrides,
  };
}

describe('evaluatePurchaseClosure', () => {
  it('permits exactly one shape: fully received lines AND PAID settlement', () => {
    expect(evaluatePurchaseClosure(facts())).toEqual({ eligible: true, reasons: [] });
  });

  it('refuses a partially received line with its number and quantities', () => {
    const result = evaluatePurchaseClosure(
      facts({
        lines: [
          { lineId: 'l1', lineNumber: 3, orderedQuantity: '10.0000', receivedQuantity: '4.0000' },
        ],
      })
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons[0].code).toBe(CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE);
    expect(result.reasons[0].detail).toContain('3');
  });

  it('refuses a never-received line and every other short line — all at once', () => {
    const result = evaluatePurchaseClosure(
      facts({
        lines: [
          { lineId: 'l1', lineNumber: 1, orderedQuantity: '10.0000', receivedQuantity: '0.0000' },
          { lineId: 'l2', lineNumber: 2, orderedQuantity: '2.0000', receivedQuantity: '2.0000' },
          { lineId: 'l3', lineNumber: 5, orderedQuantity: '7.5000', receivedQuantity: '1.0000' },
        ],
      })
    );
    expect(result.reasons.map((r) => r.code)).toEqual([
      CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE,
      CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE,
    ]);
  });

  it('counts net-zero (fully compensated) receipt history as NOT fulfilled', () => {
    const result = evaluatePurchaseClosure(
      facts({
        lines: [
          { lineId: 'l1', lineNumber: 1, orderedQuantity: '10.0000', receivedQuantity: '0.0000' },
        ],
      })
    );
    expect(result.reasons[0].code).toBe(CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE);
  });

  it.each(['REQUESTED', 'APPROVED', 'RECEIVED_BACK'] as const)(
    'refuses while a return is %s — non-terminal means unresolved',
    (state) => {
      const result = evaluatePurchaseClosure(
        facts({ returns: [{ returnId: 'r1', state }] })
      );
      expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.RETURN_UNRESOLVED);
    }
  );

  it.each(['REFUNDED', 'REJECTED'] as const)(
    'treats a %s return as resolved',
    (state) => {
      const result = evaluatePurchaseClosure(
        facts({ returns: [{ returnId: 'r1', state }] })
      );
      expect(result.eligible).toBe(true);
    }
  );

  it.each([
    ['UNPAID', '0.0000'],
    ['PARTIAL', '50.0000'],
  ] as const)('refuses a %s projection — settlement incomplete', (_status, paid) => {
    const result = evaluatePurchaseClosure(
      facts({ payment: { ...facts().payment, paidAmount: paid } })
    );
    expect(result.reasons.map((r) => r.code)).toContain(
      CLOSURE_REFUSAL.PAYMENT_SETTLEMENT_INCOMPLETE
    );
  });

  it('refuses an OVERPAID projection as inconsistent, never as settled', () => {
    const result = evaluatePurchaseClosure(
      facts({ payment: { ...facts().payment, paidAmount: '120.0000' } })
    );
    expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.PAYMENT_INCONSISTENT);
  });

  it('refuses when the document total is not stated — settlement unevaluable', () => {
    const result = evaluatePurchaseClosure(
      facts({ payment: { ...facts().payment, totalAmount: null } })
    );
    expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.PAYMENT_INCONSISTENT);
  });

  it('refuses a PAID sum beside open approved-plan installments', () => {
    const result = evaluatePurchaseClosure(
      facts({
        payment: {
          ...facts().payment,
          openInstallmentAmount: '40.0000',
          openInstallmentCount: 1,
        },
      })
    );
    expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.PAYMENT_INCONSISTENT);
  });

  it('permits closure after a fully refunded return — the resolved-return decision', () => {
    // Ordered 10, received 10, returned 2, return REFUNDED and the refund
    // settled (compensation recorded): net payable is total − refunded, and
    // the reduced paid sum is exactly PAID against it.
    const result = evaluatePurchaseClosure(
      facts({
        returns: [{ returnId: 'r1', state: 'REFUNDED' }],
        payment: { ...facts().payment, paidAmount: '80.0000', refundedAmount: '20.0000' },
      })
    );
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it('permits closure when EVERY line was returned and refunded — payable zero', () => {
    const result = evaluatePurchaseClosure(
      facts({
        returns: [{ returnId: 'r1', state: 'REFUNDED' }],
        payment: { ...facts().payment, paidAmount: '0.0000', refundedAmount: '100.0000' },
      })
    );
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it('refuses a refunded return whose refund left an unpaid remainder', () => {
    const result = evaluatePurchaseClosure(
      facts({
        returns: [{ returnId: 'r1', state: 'REFUNDED' }],
        payment: { ...facts().payment, paidAmount: '60.0000', refundedAmount: '20.0000' },
      })
    );
    expect(result.reasons.map((r) => r.code)).toContain(
      CLOSURE_REFUSAL.PAYMENT_SETTLEMENT_INCOMPLETE
    );
  });

  it('a manual compensation is NOT a refund — it lowers paid, never payable', () => {
    // Reversed 20 without any REFUNDED return naming it: paid 80 of payable
    // 100 — the money went back without a resolved return, so the obligation
    // stands and closure refuses as incomplete.
    const result = evaluatePurchaseClosure(
      facts({
        payment: { ...facts().payment, paidAmount: '80.0000', refundedAmount: '0.0000' },
      })
    );
    expect(result.reasons.map((r) => r.code)).toContain(
      CLOSURE_REFUSAL.PAYMENT_SETTLEMENT_INCOMPLETE
    );
  });

  it('overpayment against the NET payable is still an inconsistency', () => {
    const result = evaluatePurchaseClosure(
      facts({
        returns: [{ returnId: 'r1', state: 'REFUNDED' }],
        payment: { ...facts().payment, paidAmount: '90.0000', refundedAmount: '20.0000' },
      })
    );
    expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.PAYMENT_INCONSISTENT);
  });

  it('a REFUNDED return still blocks when ANOTHER return is unresolved', () => {
    const result = evaluatePurchaseClosure(
      facts({
        returns: [
          { returnId: 'r1', state: 'REFUNDED' },
          { returnId: 'r2', state: 'RECEIVED_BACK' },
        ],
        payment: { ...facts().payment, paidAmount: '80.0000', refundedAmount: '20.0000' },
      })
    );
    expect(result.reasons.map((r) => r.code)).toEqual([CLOSURE_REFUSAL.RETURN_UNRESOLVED]);
  });

  it('refuses an unresolvable refund link — ambiguous money is never guessed', () => {
    const result = evaluatePurchaseClosure(
      facts({
        payment: {
          ...facts().payment,
          refundAmbiguous: true,
          refundedAmount: '20.0000', // partial — covers only the known rows
        },
      })
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain(CLOSURE_REFUSAL.REFUND_AMBIGUOUS);
  });

  it('returns EVERY reason — fulfilment, return and settlement all at once', () => {
    const result = evaluatePurchaseClosure(
      facts({
        lines: [
          { lineId: 'l1', lineNumber: 1, orderedQuantity: '10.0000', receivedQuantity: '1.0000' },
        ],
        returns: [{ returnId: 'r1', state: 'REQUESTED' }],
        payment: { ...facts().payment, paidAmount: '0.0000' },
      })
    );
    expect(result.reasons.map((r) => r.code)).toEqual([
      CLOSURE_REFUSAL.FULFILLMENT_INCOMPLETE,
      CLOSURE_REFUSAL.RETURN_UNRESOLVED,
      CLOSURE_REFUSAL.PAYMENT_SETTLEMENT_INCOMPLETE,
    ]);
  });
});
