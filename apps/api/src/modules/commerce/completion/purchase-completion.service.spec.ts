import { ConflictException, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle, CommerceUnitOfWork } from '../database/commerce-transaction';
import type { PurchaseRepository } from '../purchase/purchase.repository';
import type { PurchaseCompletionPolicyRepository } from './purchase-completion-policy.repository';
import { PURCHASE_COMPLETION_AUDIT_ACTION, PURCHASE_COMPLETION_FAILURE } from './completion.constants';
import { PurchaseCompletionService } from './purchase-completion.service';
import type { PurchaseService } from '../purchase/purchase.service';

/**
 * PHASE C4-R (GAP-3): the completion act, at the seam where it decides.
 *
 * THE REPOSITORIES ARE FAKED AND THE AUDIT GATEWAY IS A RECORDED SPY, so every assertion
 * here is about a DECISION rather than SQL: which reads happen, in what order, and what is
 * refused before anything is written. What is pinned:
 *
 *  * FAIL-CLOSED (brief §18): with no PUBLISHED policy — or with a published row that
 *    cannot be evaluated — nothing is written and the answer is the configuration failure,
 *    never a draft, never "latest", never "no prerequisites";
 *  * THE POLICY IS THE RULE (D1): the document's status must be named by the policy's own
 *    set, and the refusal names BOTH the actual status and the configured set;
 *  * ONE WRITE, ONCE: `writeCompletedIn` carries the policy's set, the server-resolved
 *    actor, the server clock and the policy's id together — §29's actor, timestamp and
 *    explainability recorded in one statement, and its `null` is a 409 rather than a
 *    silent success;
 *  * TENANT FIRST: every read and the write take `actor.tenantId` as their first argument;
 *  * NOTHING ELSE IS TOUCHED: the service's whole surface is document read → policy read →
 *    conditional write → projection, so payment, receiving, workflow and return state are
 *    read by nothing here (C1 §29's independence, from this side).
 */

const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'u-actor',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

/** One document as `PurchaseRepository.findDocumentById` returns it. */
function storedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    tenantId: 't1',
    documentNumber: 'PR-1405-00001',
    kind: 'PURCHASE_REQUEST',
    status: 'APPROVED',
    requesterId: 'u1',
    supplierId: null,
    currency: null,
    subtotalAmount: null,
    taxAmount: null,
    totalAmount: null,
    completedByUserId: null,
    completedAt: null,
    completionPolicyVersionId: null,
    lines: [],
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The same document as the conditional write returns it: completed, pinned, recorded. */
function completedDocument(overrides: Record<string, unknown> = {}) {
  return {
    status: 'CLOSED',
    completedByUserId: 'u-actor',
    completedAt: new Date('2026-10-01T00:00:00.000Z'),
    completionPolicyVersionId: 'p1',
    ...overrides,
  };
}

/** One policy version as `PurchaseCompletionPolicyRepository.findPublished` returns it. */
function publishedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    tenantId: 't1',
    status: 'PUBLISHED',
    versionLabel: '1404-completion-01',
    allowedFromStatuses: ['APPROVED'],
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * The service under test with recording fakes for the two repositories, the projection
 * service and the two gateways. The mock's own `.mock.calls` is the call log (see
 * `purchase.service.spec.ts` for why a `push` inside an implementation is not one), and
 * there is no `jest.clearAllMocks()`: `build()` makes everything fresh per test.
 */
function build() {
  type DocumentMocks = {
    findDocumentById: jest.Mock;
    writeCompletedIn: jest.Mock;
    lockDocumentIn: jest.Mock;
    readDocumentStatusIn: jest.Mock;
  };
  const documents: DocumentMocks = {
    findDocumentById: jest.fn(),
    writeCompletedIn: jest.fn(),
    lockDocumentIn: jest.fn().mockResolvedValue({ id: 'd1' }),
    // The row the close transaction's lock froze: APPROVED, total stated.
    readDocumentStatusIn: jest
      .fn()
      .mockResolvedValue({ id: 'd1', status: 'APPROVED', totalAmount: '100.0000' }),
  };
  const policies: { findPublished: jest.Mock } = {
    findPublished: jest.fn(),
  };
  const purchases: { getOne: jest.Mock } = {
    getOne: jest.fn(),
  };
  const audit = {
    record: jest.fn(),
    buildOutboxPayload: jest.fn().mockImplementation((_actor: CommerceActor, act: unknown) => ({
      tenantId: 't1',
      auditId: 'outbox-audit-id',
      payload: act,
    })),
  };
  const unitOfWork = {
    run: jest.fn((work: (tx: CommerceTransactionHandle) => Promise<unknown>) =>
      work({} as CommerceTransactionHandle)
    ),
  };
  // W2-C: the integration gate — no unresolved postings by default; a test
  // overrides this to exercise the INTEGRATION_UNRESOLVED refusal.
  const postings: { listUnresolvedForLines: jest.Mock } = {
    listUnresolvedForLines: jest.fn().mockResolvedValue([]),
  };
  // PHASE W3 (confirmed closure rule): the fact readers the eligibility
  // evaluator consumes — all under the document lock inside the close tx.
  // DEFAULTS: one line ordered 10, fully received 10; no returns; paid sum
  // equals the stated total (PAID); no plans.
  const receiving: { listLines: jest.Mock; listByDocument: jest.Mock } = {
    listLines: jest
      .fn()
      .mockResolvedValue([{ id: 'line-1', lineNumber: 1, quantity: '10.0000' }]),
    listByDocument: jest.fn().mockResolvedValue([
      { id: 'r1', lines: [{ id: 'rl1', purchaseLineId: 'line-1', quantity: '10.0000', reversesReceiptLineId: null }] },
    ]),
  };
  const returns: { listReturnDocuments: jest.Mock } = {
    listReturnDocuments: jest.fn().mockResolvedValue([]),
  };
  const plans: { sumPayments: jest.Mock; listPlans: jest.Mock; listPayments: jest.Mock } = {
    sumPayments: jest.fn().mockResolvedValue('100.0000'),
    listPlans: jest.fn().mockResolvedValue([]),
    listPayments: jest.fn().mockResolvedValue([]),
  };

  // DEFAULTS: a document that exists and is APPROVED, a policy that allows exactly that,
  // a write that succeeded (and therefore answers the row as it now stands — the
  // repository re-reads what it wrote), and a projection that answers the document.
  // A test overrides the one it cares about.
  documents.findDocumentById.mockResolvedValue(storedDocument());
  documents.writeCompletedIn.mockResolvedValue(storedDocument(completedDocument()));
  policies.findPublished.mockResolvedValue(publishedPolicy());
  purchases.getOne.mockResolvedValue({ id: 'd1', status: 'CLOSED' });

  const notification = { notifyUsers: jest.fn().mockResolvedValue(undefined) };

  const service = new PurchaseCompletionService(
    documents as unknown as PurchaseRepository,
    policies as unknown as PurchaseCompletionPolicyRepository,
    purchases as unknown as PurchaseService,
    audit as unknown as CommerceAuditGateway,
    unitOfWork as unknown as CommerceUnitOfWork,
    notification as never,
    postings as never,
    receiving as never,
    returns as never,
    plans as never
  );

  return {
    service,
    documents,
    policies,
    purchases,
    audit,
    unitOfWork,
    postings,
    receiving,
    returns,
    plans,
    notification,
    calls: {
      findDocumentById: documents.findDocumentById.mock.calls,
      writeCompletedIn: documents.writeCompletedIn.mock.calls,
      findPublished: policies.findPublished.mock.calls,
      getOne: purchases.getOne.mock.calls,
      audit: audit.record.mock.calls,
      auditOutbox: audit.buildOutboxPayload.mock.calls,
      run: unitOfWork.run.mock.calls,
    },
  };
}

/** Await a refusal and return its named code; fails the test when nothing was thrown. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    const response = (error as ConflictException).getResponse() as { code?: string };
    return response.code ?? '';
  }
  throw new Error('expected a 409 refusal, but the call succeeded');
}

describe('Phase C4-R GAP-3 — PurchaseCompletionService.close: the refusals', () => {
  it('answers 404 for an unknown or foreign id, tenant-scoped, and reads nothing else', async () => {
    const { service, documents, policies, calls } = build();
    documents.findDocumentById.mockResolvedValue(null);

    await expect(service.close(actor, 'nope')).rejects.toBeInstanceOf(NotFoundException);

    // NOT 403 FOR ANOTHER TENANT'S ID: the predicate is in the repository's `where`, so an
    // id from elsewhere is indistinguishable from one that does not exist — a 403 would
    // confirm the id names a real document somewhere.
    expect(calls.findDocumentById).toEqual([['t1', 'nope']]);
    expect(calls.findPublished).toEqual([]);
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.audit).toEqual([]);
    expect(policies.findPublished).not.toHaveBeenCalled();
  });

  it('answers an already-completed document BEFORE it asks the policy — in every tenant', async () => {
    const { service, documents, policies, calls } = build();
    documents.findDocumentById.mockResolvedValue(storedDocument({ status: 'CLOSED' }));

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.DOCUMENT_ALREADY_COMPLETED
    );

    // Checked before the policy so a repeat click is answered identically whether or not
    // the tenant is configured — and so the second request never re-reads configuration
    // it cannot change: no write, no audit, no policy read at all.
    expect(calls.findPublished).toEqual([]);
    expect(policies.findPublished).not.toHaveBeenCalled();
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('FAILS CLOSED with no published policy: no write, no draft, no default, no silent fallback', async () => {
    const { service, policies, calls } = build();
    policies.findPublished.mockResolvedValue(null);

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED
    );

    // The whole point of §18: nothing is read or written that could stand in for a
    // policy — not a draft, not "latest", not "no prerequisites".
    expect(calls.findPublished).toEqual([['t1']]);
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.getOne).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('fails closed on a PUBLISHED row whose stored set cannot be evaluated', async () => {
    const { service, policies, calls } = build();
    // A shape publication refuses, so it should be unreachable — and is still answered as
    // NOT CONFIGURED rather than guessed at.
    policies.findPublished.mockResolvedValue(publishedPolicy({ allowedFromStatuses: ['CLOSED'] }));

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED
    );
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('lets the CONFIGURED policy refuse a status it does not name, naming both sides', async () => {
    const { service, documents, policies, calls } = build();
    documents.findDocumentById.mockResolvedValue(storedDocument({ status: 'REJECTED' }));
    policies.findPublished.mockResolvedValue(publishedPolicy({ allowedFromStatuses: ['APPROVED'] }));

    const refusal = await service.close(actor, 'd1').then(
      () => null,
      (error: ConflictException) => error.getResponse() as { code: string; message: string }
    );

    expect(refusal?.code).toBe(PURCHASE_COMPLETION_FAILURE.STATUS_NOT_ALLOWED);
    // The message states the document's ACTUAL status and the configured set, so an
    // operator learns what to change rather than "not allowed".
    expect(refusal?.message).toContain('REJECTED');
    expect(refusal?.message).toContain('APPROVED');
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses while inventory postings are unresolved — INTEGRATION_UNRESOLVED, no write, no trail (W2-C)', async () => {
    const { service, documents, postings, calls } = build();
    documents.findDocumentById.mockResolvedValue(
      storedDocument({ lines: [{ id: 'line-1' }] as never })
    );
    postings.listUnresolvedForLines.mockResolvedValue([
      { id: 'p1', kind: 'RECEIPT', status: 'FAILED', purchaseLineId: 'line-1', lastError: 'unknown SKU' },
    ]);

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.INTEGRATION_UNRESOLVED
    );

    // Read under the lock, inside the close transaction, on the locked line set.
    expect(postings.listUnresolvedForLines).toHaveBeenCalledWith(
      't1',
      ['line-1'],
      expect.anything()
    );
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.audit).toEqual([]);
    expect(calls.getOne).toEqual([]);
  });

  it('refuses when the conditional write loses the race, and records NOTHING', async () => {
    const { service, documents, calls } = build();
    documents.writeCompletedIn.mockResolvedValue(null);

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.WRITE_CONFLICT
    );

    // The document moved under the service (another close, or a commercial projection):
    // the caller is told, and no actor, timestamp or trail is invented for a write that
    // did not happen.
    expect(calls.writeCompletedIn).toHaveLength(1);
    expect(calls.getOne).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — PurchaseCompletionService.close: a permitted completion', () => {
  it('writes ONE conditional transition carrying the policy’s set, the actor, the clock and the pin', async () => {
    const { service, calls } = build();

    const answered = await service.close(actor, 'd1');

    expect(calls.run).toHaveLength(1);
    expect(calls.writeCompletedIn).toHaveLength(1);
    const [tenantId, , id, completion] = calls.writeCompletedIn[0];

    // TENANT FIRST, on every statement: the write is scoped exactly like the reads were.
    expect(tenantId).toBe('t1');
    expect(id).toBe('d1');

    // The SOURCE SET is the policy's own — configuration, not a literal in this file —
    // and it travels with the status predicate, so a document that left the set between
    // the read and the write matches nothing.
    expect(completion.fromStatuses).toEqual(['APPROVED']);
    expect(completion.completionPolicyVersionId).toBe('p1');

    // §29's two records: the SERVER-resolved actor (never the document's requester, never
    // a request field) and a timestamp the act's own clock produced.
    expect(completion.completedByUserId).toBe('u-actor');
    expect(completion.completedAt).toBeInstanceOf(Date);

    expect(answered).toEqual({ id: 'd1', status: 'CLOSED' });
  });

  it('records the completion on the document’s own audit resource, once', async () => {
    const { service, calls } = build();

    await service.close(actor, 'd1');

    // Phase B2.3: close uses durable outbox, not best-effort record.
    expect(calls.audit).toEqual([]);
    expect(calls.auditOutbox).toHaveLength(1);
    const [auditActor, act] = calls.auditOutbox[0];
    expect(auditActor).toBe(actor);
    expect(act).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.DOCUMENT_CLOSED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: 'd1',
      oldValue: { status: 'APPROVED' },
      newValue: { status: 'CLOSED' },
    });
    // The trail names which policy authorised the act — the same id the row is pinned to.
    expect(act.newValue.completionPolicyVersionId).toBe('p1');
    expect(act.newValue.completedByUserId).toBe('u-actor');
  });

  it('answers with the projection the GET route uses — the write’s own row, read back', async () => {
    const { service, purchases, calls } = build();

    const answered = await service.close(actor, 'd1');

    expect(calls.getOne).toEqual([[actor, 'd1']]);
    expect(answered).toEqual({ id: 'd1', status: 'CLOSED' });
    expect(purchases.getOne).toHaveBeenCalledWith(actor, 'd1');
  });

  it('records a machine completion with a NULL actor rather than inventing one', async () => {
    const { service, documents, calls } = build();
    const machine: CommerceActor = { ...actor, userId: null };
    documents.writeCompletedIn.mockResolvedValue(
      storedDocument(completedDocument({ completedByUserId: null }))
    );

    await service.close(machine, 'd1');

    const [, , , completion] = calls.writeCompletedIn[0];
    expect(completion.completedByUserId).toBeNull();
    expect(calls.auditOutbox[0][1].newValue.completedByUserId).toBeNull();
  });

  it('reads the policy and the document ONLY through the actor’s tenant', async () => {
    const { service, calls } = build();
    const other: CommerceActor = { ...actor, tenantId: 't2' };

    await service.close(other, 'd1');

    expect(calls.findDocumentById).toEqual([['t2', 'd1']]);
    expect(calls.findPublished).toEqual([['t2']]);
    expect(calls.writeCompletedIn[0][0]).toBe('t2');
    expect(calls.getOne).toEqual([[other, 'd1']]);
  });

  it('orders its phases — document, policy, then facts UNDER THE LOCK, then write — in that order', async () => {
    // PHASE W3 changed the middle: between "policy" and "write" the service now
    // locks the row and reads the eligibility facts inside the transaction. The
    // order below is the measured contract: nothing is evaluated before the lock.
    const traced = build();
    const order: string[] = [];
    traced.documents.findDocumentById.mockImplementation(async () => {
      order.push('document');
      return storedDocument();
    });
    traced.policies.findPublished.mockImplementation(async () => {
      order.push('policy');
      return publishedPolicy();
    });
    traced.documents.lockDocumentIn.mockImplementation(async () => {
      order.push('lock');
      return { id: 'd1' };
    });
    traced.receiving.listByDocument.mockImplementation(async () => {
      order.push('facts');
      return [
        { id: 'r1', lines: [{ id: 'rl1', purchaseLineId: 'line-1', quantity: '10.0000', reversesReceiptLineId: null }] },
      ];
    });
    traced.documents.writeCompletedIn.mockImplementation(async () => {
      order.push('write');
      return storedDocument({ status: 'CLOSED' });
    });
    traced.purchases.getOne.mockImplementation(async () => {
      order.push('projection');
      return { id: 'd1', status: 'CLOSED' };
    });

    await traced.service.close(actor, 'd1');

    expect(order).toEqual(['document', 'policy', 'lock', 'facts', 'write', 'projection']);
  });
});

describe('Phase W3 — the confirmed closure rule (fulfilment AND settlement)', () => {
  it('refuses when a line is not fully received — FULFILLMENT_INCOMPLETE with the line named', async () => {
    const { service, receiving, calls } = build();
    // 6 of 10 net received — PARTIALLY_RECEIVED, never a sliver of tolerance.
    receiving.listByDocument.mockResolvedValue([
      { id: 'r1', lines: [{ id: 'rl1', purchaseLineId: 'line-1', quantity: '6.0000', reversesReceiptLineId: null }] },
    ]);

    const refusal = await service.close(actor, 'd1').then(
      () => null,
      (error: ConflictException) => error.getResponse() as { code: string; reasons: unknown[] }
    );

    expect(refusal?.code).toBe('PURCHASE_FULFILLMENT_INCOMPLETE');
    expect(refusal?.reasons).toHaveLength(1);
    expect(calls.writeCompletedIn).toEqual([]);
    expect(calls.auditOutbox).toHaveLength(1); // built but never committed — the tx refused
    expect(calls.getOne).toEqual([]);
  });

  it('does not count a compensated receipt toward fulfilment', async () => {
    const { service, receiving, calls } = build();
    // +10 received, −10 compensated: the append-only history nets to zero.
    receiving.listByDocument.mockResolvedValue([
      {
        id: 'r1',
        lines: [
          { id: 'rl1', purchaseLineId: 'line-1', quantity: '10.0000', reversesReceiptLineId: null },
          { id: 'rl2', purchaseLineId: 'line-1', quantity: '-10.0000', reversesReceiptLineId: 'rl1' },
        ],
      },
    ]);

    expect(await codeOf(service.close(actor, 'd1'))).toBe('PURCHASE_FULFILLMENT_INCOMPLETE');
    expect(calls.writeCompletedIn).toEqual([]);
  });

  it('refuses complete fulfilment with an outstanding payment — SETTLEMENT_INCOMPLETE', async () => {
    const { service, plans, calls } = build();
    plans.sumPayments.mockResolvedValue('40.0000'); // PARTIAL against 100.0000

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      'PURCHASE_PAYMENT_SETTLEMENT_INCOMPLETE'
    );
    expect(calls.writeCompletedIn).toEqual([]);
  });

  it('refuses an OVERPAID document as PAYMENT_INCONSISTENT, not success', async () => {
    const { service, plans, calls } = build();
    plans.sumPayments.mockResolvedValue('150.0000');

    expect(await codeOf(service.close(actor, 'd1'))).toBe('PURCHASE_PAYMENT_INCONSISTENT');
    expect(calls.writeCompletedIn).toEqual([]);
  });

  it('refuses an unresolved return even with fulfilment and payment complete', async () => {
    const { service, returns, calls } = build();
    returns.listReturnDocuments.mockResolvedValue([
      { id: 'ret-1', transitions: [{ state: 'REQUESTED', createdAt: new Date() }] },
    ]);

    expect(await codeOf(service.close(actor, 'd1'))).toBe('PURCHASE_RETURN_UNRESOLVED');
    expect(calls.writeCompletedIn).toEqual([]);
  });

  it('treats a terminal return as resolved — REFUNDED does not block', async () => {
    const { service, returns } = build();
    returns.listReturnDocuments.mockResolvedValue([
      {
        id: 'ret-1',
        transitions: [
          { state: 'REQUESTED', createdAt: new Date('2026-01-01') },
          { state: 'APPROVED', createdAt: new Date('2026-01-02') },
          { state: 'RECEIVED_BACK', createdAt: new Date('2026-01-03') },
          { state: 'REFUNDED', createdAt: new Date('2026-01-04') },
        ],
      },
    ]);

    await expect(service.close(actor, 'd1')).resolves.toEqual({ id: 'd1', status: 'CLOSED' });
  });

  it('refuses open APPROVED-plan installments beside a PAID sum — PAYMENT_INCONSISTENT', async () => {
    const { service, plans, calls } = build();
    plans.listPlans.mockResolvedValue([
      {
        id: 'plan-1',
        status: 'APPROVED',
        installments: [
          { seq: 1, amount: '60.0000', status: 'PENDING', executedPaymentId: null },
          { seq: 2, amount: '40.0000', status: 'APPROVED', executedPaymentId: 'pay-2' },
        ],
      },
    ]);

    expect(await codeOf(service.close(actor, 'd1'))).toBe('PURCHASE_PAYMENT_INCONSISTENT');
    expect(calls.writeCompletedIn).toEqual([]);
  });

  it('re-reads status under the lock — a document closed mid-race answers ALREADY_COMPLETED', async () => {
    const { service, documents, calls } = build();
    documents.readDocumentStatusIn.mockResolvedValue({
      id: 'd1',
      status: 'CLOSED',
      totalAmount: '100.0000',
    });

    expect(await codeOf(service.close(actor, 'd1'))).toBe(
      PURCHASE_COMPLETION_FAILURE.DOCUMENT_ALREADY_COMPLETED
    );
    expect(calls.writeCompletedIn).toEqual([]);
  });
});
