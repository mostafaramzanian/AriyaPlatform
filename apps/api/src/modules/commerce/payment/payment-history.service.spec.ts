import { ConflictException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle } from '../database/commerce-transaction';
import type { PaymentHistoryRepository } from './payment-history.repository';
import { PaymentCompensationTakenError } from './payment-history.repository';
import { PAYMENT_AUDIT_ACTION, PaymentHistoryService } from './payment-history.service';
import { projectPaymentStatus } from './payment-status';
import type { ListPaymentsQueryDto } from './payment.dto';

/**
 * Phase C1 Step Q (§24 matrix items 14–19, 21–23; contract §7): the payment history's
 * application layer, with the repository faked and the audit gateway a recorded spy, so
 * every assertion is about a DECISION rather than about SQL:
 *
 *  * the TENANT is the repository's FIRST argument on every call, and `tenantId` never
 *    reaches a response body (21);
 *  * a foreign or unknown document is 404 BEFORE any write — and 404, never 403, so an
 *    id cannot be probed (§3-E);
 *  * the currency is snapshotted from the document, never taken from a payload (Q5);
 *  * a compensation is the EXACT negation with method and currency mirrored, and a
 *    second compensation is 409 — from the early read AND from the unique index when
 *    the read's race was lost (16, Q4);
 *  * the status depends on the document's total and the rows only — never on workflow,
 *    commercial or receiving state, never on the page's filter (18, 19, Q9);
 *  * no identity lookup exists to make: every reference is opaque (22);
 *  * exactly ONE audit row per write, through `CommerceAuditGateway`, on the step-G
 *    resource — and none for a read (23, §I8).
 *
 * The `build()` helper constructs fresh fakes per test (the purchase spec's precedent):
 * what a fake RETURNS is the test's to decide, what was CALLED is `mock.calls`' to
 * remember, and no shared reset can empty a log an assertion still needs.
 */

const ACTOR: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';

/** One document as the repository returns it — the three facts Q reduced it to. */
function storedDocument(overrides: Record<string, unknown> = {}) {
  return { id: DOCUMENT_ID, currency: 'IRR', totalAmount: '100.0000', ...overrides };
}

/** One payment row as the repository returns it — strings, because money is exact. */
function storedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    tenantId: 't1',
    purchaseDocumentId: DOCUMENT_ID,
    amount: '30.0000',
    currency: 'IRR',
    method: 'CASH',
    paymentDate: new Date('2026-09-10T08:00:00.000Z'),
    payerRef: null,
    payeeRef: null,
    invoiceRef: null,
    externalReference: null,
    reversesPaymentId: null,
    recordedByUserId: 'u1',
    createdAt: new Date('2026-09-10T08:00:01.000Z'),
    ...overrides,
  };
}

/** The service with recording fakes — the repository's FULL surface, nothing more. */
function build() {
  type RepositoryMocks = {
    findDocumentForPayment: jest.Mock;
    readPaymentPage: jest.Mock;
    findPaymentForCompensation: jest.Mock;
    findCompensation: jest.Mock;
    append: jest.Mock;
  };
  const repository: RepositoryMocks = {
    findDocumentForPayment: jest.fn(),
    readPaymentPage: jest.fn(),
    findPaymentForCompensation: jest.fn(),
    findCompensation: jest.fn(),
    append: jest.fn(),
  };
  const audit = {
    record: jest.fn(),
    buildOutboxPayload: jest.fn().mockImplementation((_actor: CommerceActor, act: unknown) => ({
      tenantId: 't1',
      auditId: 'outbox-audit-id',
      payload: act,
    })),
  };

  return {
    service: new PaymentHistoryService(
      repository as unknown as PaymentHistoryRepository,
      audit as unknown as CommerceAuditGateway
    ),
    repository,
    audit,
  };
}

/** A list query — the shared DTO's defaults do the rest. */
const QUERY: ListPaymentsQueryDto = {};

describe('Phase C1 Step Q — the projection beside the page (14, 15, 19)', () => {
  it('14. projects PARTIAL: a partial payment against the stored total', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.readPaymentPage.mockResolvedValue([
      [storedPayment()],
      1,
      { _sum: { amount: '30.0000' } },
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID, QUERY);

    expect(page.paymentStatus).toEqual({
      status: 'PARTIAL',
      paidAmount: '30.0000',
      totalAmount: '100.0000',
      currency: 'IRR',
    });
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(20);
    expect(page.total).toBe(1);
  });

  it('15. projects PAID from 30 + 40 + 30 appended on the same document (§29)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.readPaymentPage.mockResolvedValue([
      [
        storedPayment({ id: 'p1', amount: '30.0000' }),
        storedPayment({ id: 'p2', amount: '40.0000' }),
        storedPayment({ id: 'p3', amount: '30.0000' }),
      ],
      3,
      { _sum: { amount: '100.0000' } },
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID, QUERY);

    expect(page.items).toHaveLength(3);
    expect(page.paymentStatus.status).toBe('PAID');
    expect(page.paymentStatus.paidAmount).toBe('100.0000');
  });

  it('19. the status depends on the document total and the rows only — never the page filter (Q9)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    // The PAGE was filtered down to one 10.0000 row while the whole history sums
    // 70.0000: the projection answers from the whole history, not from what the
    // filter left visible — a status must not change when a user types into a
    // search box.
    repository.readPaymentPage.mockResolvedValue([
      [storedPayment({ amount: '10.0000' })],
      1,
      { _sum: { amount: '70.0000' } },
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID, { ...QUERY, search: 'INV' });

    expect(page.items).toHaveLength(1);
    expect(page.paymentStatus.paidAmount).toBe('70.0000');
    expect(page.paymentStatus.status).toBe('PARTIAL');
    // The same answer the pure projection gives those two inputs — one rule, one home.
    expect(page.paymentStatus.status).toBe(
      projectPaymentStatus(page.paymentStatus.totalAmount, page.paymentStatus.paidAmount)
    );
  });

  it('projects null when no total is stated — never a fake UNPAID (§3-B rule 1)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument({ totalAmount: null }));
    repository.readPaymentPage.mockResolvedValue([
      [storedPayment()],
      1,
      { _sum: { amount: '30.0000' } },
    ]);

    const page = await service.list(ACTOR, DOCUMENT_ID, QUERY);

    expect(page.paymentStatus.status).toBeNull();
    // The rest of the block is still reported so a client can render "no total stated".
    expect(page.paymentStatus.paidAmount).toBe('30.0000');
    expect(page.paymentStatus.totalAmount).toBeNull();
  });
});

describe('Phase C1 Step Q — appending a payment', () => {
  it('appends one row and returns §6’s exact field list — nothing else', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.append.mockResolvedValue(storedPayment({ amount: '30.0000' }));

    const view = await service.append(ACTOR, DOCUMENT_ID, {
      amount: 30,
      method: 'CASH',
      payerRef: 'payer-1',
    });

    expect(repository.append).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        purchaseDocumentId: DOCUMENT_ID,
        amount: '30.0000',
        currency: 'IRR',
        method: 'CASH',
        payerRef: 'payer-1',
        // No `reversesPaymentId` key at all: an ordinary payment states no link, and
        // the repository defaults the column to NULL itself.
        recordedByUserId: 'u1',
      }),
      // Phase B2.3: durable outbox payload as third arg.
      expect.objectContaining({ tenantId: 't1' }),
    );
    expect(Object.keys(view).sort()).toEqual(
      [
        'amount',
        'createdAt',
        'currency',
        'externalReference',
        'id',
        'invoiceRef',
        'method',
        'payerRef',
        'payeeRef',
        'paymentDate',
        'recordedByUserId',
        'reversesPaymentId',
      ].sort()
    );
  });

  it('snapshots the currency from the document — never from the payload (Q5)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument({ currency: 'EUR' }));
    repository.append.mockResolvedValue(storedPayment({ currency: 'EUR' }));

    await service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' });

    expect(repository.findDocumentForPayment).toHaveBeenCalledWith('t1', DOCUMENT_ID);
    expect(repository.append).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ currency: 'EUR' }),
      expect.objectContaining({ tenantId: 't1' }),
    );
  });

  it('answers 404 — BEFORE any write — for a foreign or unknown document', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(null);

    await expect(
      service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list(ACTOR, DOCUMENT_ID, QUERY)).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.append).not.toHaveBeenCalled();
    expect(repository.readPaymentPage).not.toHaveBeenCalled();
    expect(repository.findPaymentForCompensation).not.toHaveBeenCalled();
  });
});

describe('Phase C1 Step Q — the compensating row (16, Q4)', () => {
  it('16. appends the EXACT negation with method and currency mirrored — never client-stated (§3-D)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(
      storedPayment({ amount: '26.2500', method: 'CHECK', currency: 'EUR' })
    );
    repository.findCompensation.mockResolvedValue(null);
    repository.append.mockResolvedValue(
      storedPayment({
        id: 'comp-1',
        amount: '-26.2500',
        method: 'CHECK',
        currency: 'EUR',
        reversesPaymentId: PAYMENT_ID,
        externalReference: 'CORR-1',
      })
    );

    const view = await service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {
      externalReference: 'CORR-1',
      reason: 'recorded against the wrong invoice',
    });

    expect(repository.append).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        purchaseDocumentId: DOCUMENT_ID,
        amount: '-26.2500', // negateMoney of the stored row — not a payload number
        method: 'CHECK', // mirrored from the target
        currency: 'EUR', // mirrored from the target
        reversesPaymentId: PAYMENT_ID, // the PATH's id, never a body's
        externalReference: 'CORR-1', // the correction's OWN reference
        payerRef: null, // each row states its own — none inherited
        payeeRef: null,
        invoiceRef: null,
        recordedByUserId: 'u1',
      }),
      // Phase B2.3: durable outbox payload.
      expect.objectContaining({ tenantId: 't1' }),
      undefined // …and no tx handle in the compensation test: the handle is optional
    );
    expect(view.amount).toBe('-26.2500');
    expect(view.reversesPaymentId).toBe(PAYMENT_ID);
  });

  it('forwards a supplied transaction handle to EVERY statement of a compensate (Step U)', async () => {
    // S's refund hands Q the handle its own unit of work minted, because the compensating
    // INSERT has to run on that connection: `PaymentRecord`'s foreign key takes `FOR KEY
    // SHARE` on the document row S already holds `FOR UPDATE`, and a second connection
    // would wait out the caller's transaction instead of writing with it. Forwarding IS the
    // fix, so it is pinned statement by statement rather than by one argument.
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(storedPayment());
    repository.findCompensation.mockResolvedValue(null);
    repository.append.mockResolvedValue(storedPayment({ id: 'comp-1' }));
    const handle = { mintedBy: 'unit-of-work' } as unknown as CommerceTransactionHandle;

    await service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {}, handle);

    const calls = [
      ...repository.findDocumentForPayment.mock.calls,
      ...repository.findPaymentForCompensation.mock.calls,
      ...repository.findCompensation.mock.calls,
      ...repository.append.mock.calls,
    ];
    // Non-vacuity: all four statements really ran, so "each one carries the handle" is a
    // claim about this act rather than about an empty array.
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call[call.length - 1]).toBe(handle);

    // The write happens ONCE, through the joined statement — never through a second one.
    expect(repository.append).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown payment of the document — indistinguishable from a foreign one', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(null);

    await expect(
      service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.append).not.toHaveBeenCalled();
  });

  it('409s a second compensation from the EARLY read, naming the existing reversal', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(storedPayment());
    repository.findCompensation.mockResolvedValue(storedPayment({ id: 'comp-already' }));

    await expect(service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})).rejects.toThrow(
      'comp-already'
    );
    await expect(
      service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('409s from the unique index when the early read LOST the race — and audits nothing', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(storedPayment());
    repository.findCompensation
      .mockResolvedValueOnce(null) // the optimistic read
      .mockResolvedValueOnce(storedPayment({ id: 'comp-winner' })); // the re-read
    repository.append.mockRejectedValue(new PaymentCompensationTakenError());

    await expect(service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})).rejects.toThrow(
      'comp-winner'
    );

    expect(repository.append).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled(); // a refused write leaves no audit row
  });

  it('lets a non-race failure surface untouched — no fallback, no silent success (§3-E)', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.findPaymentForCompensation.mockResolvedValue(storedPayment());
    repository.findCompensation.mockResolvedValue(null);
    repository.append.mockRejectedValue(new Error('database unreachable'));

    await expect(service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {})).rejects.toThrow(
      'database unreachable'
    );
  });
});

describe('Phase C1 Step Q — independence, tenancy, one trail (18, 21, 22, 23)', () => {
  /**
   * The CODE of the service, not its prose: the header explains every absence below,
   * and a guard moved by its own documentation would be a guard nobody could trust —
   * the `workflow-configuration.repository.spec.ts` premise, applied to this file.
   */
  function serviceCode(): string {
    return readFileSync(join(__dirname, 'payment-history.service.ts'), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed.length > 0 &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('*')
        );
      })
      .join('\n');
  }

  it('18/22. reads no workflow, commercial, receiving or identity state', () => {
    const code = serviceCode();

    // Not one import from another slice — payment state is an INDEPENDENT dimension
    // (§5.11–§5.13), and every reference being opaque (§13) is WHY there is no
    // identity gateway here to reach for.
    expect(code).not.toMatch(/from '[^']*(workflow|commercial|receiving|identity)[^']*'/i);
    expect(code).not.toMatch(
      /CommerceIdentityGateway|WorkflowLineRouting|CommercialLifecycle|profilesFor|assertMember/
    );
    // Exactly TWO constructor dependencies — repository and audit gateway — so the
    // absence is structural, not merely unexercised.
    expect(code).toMatch(
      /constructor\(\s*private readonly repository: PaymentHistoryRepository,\s*private readonly audit: CommerceAuditGateway\s*\)/
    );
    // The service touches exactly the repository's five methods — no string method
    // a typo invented, no other collaborator's surface.
    const touched = new Set(
      [...code.matchAll(/this\.repository\.(\w+)/g)].map((match) => match[1])
    );
    expect([...touched].sort()).toEqual(
      [
        'append',
        'findCompensation',
        'findDocumentForPayment',
        'findPaymentForCompensation',
        'readPaymentPage',
      ].sort()
    );
  });

  it('21. the actor’s tenant is the repository’s FIRST argument on every call', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.readPaymentPage.mockResolvedValue([
      [storedPayment()],
      1,
      { _sum: { amount: '30.0000' } },
    ]);
    repository.append.mockResolvedValue(storedPayment());
    repository.findPaymentForCompensation.mockResolvedValue(storedPayment());
    repository.findCompensation.mockResolvedValue(null);

    await service.list(ACTOR, DOCUMENT_ID, QUERY);
    await service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' });
    await service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {});

    const firstArguments = [
      ...repository.findDocumentForPayment.mock.calls,
      ...repository.readPaymentPage.mock.calls,
      ...repository.append.mock.calls,
      ...repository.findPaymentForCompensation.mock.calls,
      ...repository.findCompensation.mock.calls,
    ].map((call) => call[0]);

    expect(firstArguments.length).toBeGreaterThanOrEqual(8);
    for (const first of firstArguments) expect(first).toBe('t1');
  });

  it('21. no tenantId reaches a response body — the projection is §6’s field list, exactly', async () => {
    const { service, repository } = build();
    repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    repository.readPaymentPage.mockResolvedValue([
      [storedPayment()],
      1,
      { _sum: { amount: '30.0000' } },
    ]);
    repository.append.mockResolvedValue(storedPayment());

    const page = await service.list(ACTOR, DOCUMENT_ID, QUERY);
    const view = await service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' });

    expect(JSON.stringify(page)).not.toContain('tenantId');
    expect(JSON.stringify(view)).not.toContain('tenantId');
    // Nor the document id: the ROUTE names it, so a row restating it would be a
    // second place the pair is kept together.
    expect(JSON.stringify(view)).not.toContain('purchaseDocumentId');
    expect(JSON.stringify(page.paymentStatus)).not.toContain('tenantId');
  });

  it('23. exactly ONE audit row per write, on the step-G payment resource — and none for a read', async () => {
    // A read audits nothing: Q has no mutating read.
    const read = build();
    read.repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    read.repository.readPaymentPage.mockResolvedValue([
      [storedPayment()],
      1,
      { _sum: { amount: '30.0000' } },
    ]);
    await read.service.list(ACTOR, DOCUMENT_ID, QUERY);
    expect(read.audit.record).not.toHaveBeenCalled();

    // One append → one row: Phase B2.3 uses buildOutboxPayload for the durable path.
    const appended = build();
    appended.repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    appended.repository.append.mockResolvedValue(storedPayment({ id: 'p-new' }));
    await appended.service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' });
    expect(appended.audit.record).not.toHaveBeenCalled();
    expect(appended.audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(appended.audit.buildOutboxPayload).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: PAYMENT_AUDIT_ACTION.APPEND,
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD,
        resourceId: DOCUMENT_ID,
        newValue: expect.objectContaining({
          purchaseDocumentId: DOCUMENT_ID,
          amount: '30.0000',
          method: 'CASH',
        }),
      })
    );

    // One compensation → one row: Phase B2.3 uses buildOutboxPayload for the durable path.
    const compensated = build();
    compensated.repository.findDocumentForPayment.mockResolvedValue(storedDocument());
    compensated.repository.findPaymentForCompensation.mockResolvedValue(
      storedPayment({ amount: '26.2500', method: 'CHECK' })
    );
    compensated.repository.findCompensation.mockResolvedValue(null);
    compensated.repository.append.mockResolvedValue(
      storedPayment({
        id: 'comp-1',
        amount: '-26.2500',
        method: 'CHECK',
        reversesPaymentId: PAYMENT_ID,
      })
    );
    await compensated.service.compensate(ACTOR, DOCUMENT_ID, PAYMENT_ID, {
      reason: 'paid in error',
    });
    expect(compensated.audit.record).not.toHaveBeenCalled();
    expect(compensated.audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(compensated.audit.buildOutboxPayload).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: PAYMENT_AUDIT_ACTION.COMPENSATE,
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD,
        resourceId: DOCUMENT_ID,
        oldValue: { reversesPaymentId: PAYMENT_ID, amount: '26.2500' },
        newValue: { amount: '-26.2500' },
        reason: 'paid in error',
      })
    );
  });

  it('a refused write is not audited — the trail records what HAPPENED (23)', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentForPayment.mockResolvedValue(null);

    await expect(
      service.append(ACTOR, DOCUMENT_ID, { amount: 30, method: 'CASH' })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
