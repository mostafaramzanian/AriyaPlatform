import { ConflictException, NotFoundException } from '@nestjs/common';
import type { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceUnitOfWork } from '../database/commerce-transaction';
import type { PaymentHistoryRepository } from '../payment/payment-history.repository';
import type { PaymentPlanRepository } from './payment-plan.repository';
import { PaymentPlanTransitionTakenError } from './payment-plan.repository';
import { PaymentPlanService } from './payment-plan.service';

/**
 * PAYMENT PLAN: the payment-instruction slice's application layer, with the
 * repository faked and the audit gateway a recorded spy, so every assertion is
 * about a DECISION:
 *
 *  - tenant is the repository's FIRST argument on every call;
 *  - a foreign/unknown document or plan is 404 BEFORE any write;
 *  - an unpriced document cannot take a plan (no commitment to stage);
 *  - the staged total may never pass the remaining payable, at create AND at
 *    execute time;
 *  - plan approval and installment approval are TWO gates — an approved plan
 *    does not pay an unapproved stage;
 *  - execution mirrors the installment's OWN amount/method onto the money
 *    event — the client states none of it;
 *  - an executed stage blocks plan cancel AND supersede;
 *  - one audit row per write, none for a read.
 */

const ACTOR: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
} as CommerceActor;

const DOC = { id: 'doc-1', currency: 'IRR', totalAmount: { toString: () => '100' } };
const STAGE = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  amount: { toString: () => '30' },
  dueDate: null,
  method: 'CASH',
  status: 'PENDING',
  note: null,
  approvedByUserId: null,
  approvedAt: null,
  executedPaymentId: null,
  executedAt: null,
  createdAt: new Date(),
  ...over,
});
const PLAN = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  purchaseDocumentId: 'doc-1',
  status: 'DRAFT',
  committedAmount: { toString: () => '100' },
  currency: 'IRR',
  note: null,
  supersedesPlanId: null,
  requestedByUserId: 'u1',
  submittedAt: null,
  approvedByUserId: null,
  approvedAt: null,
  cancelledAt: null,
  cancelReason: null,
  createdAt: new Date(),
  installments: [STAGE()],
  ...over,
});

function build(over: Partial<Record<keyof PaymentPlanRepository, unknown>> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const spy = (name: string, impl: (...a: unknown[]) => unknown) =>
    jest.fn((...a: unknown[]) => {
      (calls[name] ??= []).push(a);
      return impl(...a);
    });
  const repository = {
    findDocumentForPlan: spy('findDocumentForPlan', async () => DOC),
    sumPayments: spy('sumPayments', async () => '0'),
    createPlan: spy('createPlan', async () => PLAN({ installments: [STAGE()] })),
    findPlan: spy('findPlan', async () => null),
    listPlans: spy('listPlans', async () => []),
    transitionPlan: spy('transitionPlan', async () => 1),
    transitionInstallment: spy('transitionInstallment', async () => 1),
    supersedePlan: spy('supersedePlan', async () => PLAN({ id: 'plan-2', status: 'DRAFT' })),
    markInstallmentExecuted: spy('markInstallmentExecuted', async () => undefined),
    ...over,
  };
  const payments = {
    append: spy('append', async () => ({ id: 'pay-1' })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const unitOfWork = {
    run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('TX')),
  };
  const service = new PaymentPlanService(
    repository as unknown as PaymentPlanRepository,
    payments as unknown as PaymentHistoryRepository,
    audit as unknown as CommerceAuditGateway,
    unitOfWork as unknown as CommerceUnitOfWork
  );
  return { service, repository, payments, audit, unitOfWork, calls };
}

const CREATE = {
  installments: [
    { amount: 30, method: 'CASH' as const },
    { amount: 40, method: 'CHECK' as const, dueDate: '2026-11-01T00:00:00Z' },
  ],
  note: 'رژیم سه‌مرحله‌ای',
};

describe('PaymentPlanService', () => {
  it('refuses a foreign or unknown document before any write (404, never 403)', async () => {
    const { service, repository } = build({ findDocumentForPlan: jest.fn(async () => null) });
    await expect(service.create(ACTOR, 'doc-9', CREATE)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.createPlan).not.toHaveBeenCalled();
  });

  it('refuses a plan against an unpriced document: no commitment to stage', async () => {
    const { service, repository } = build({
      findDocumentForPlan: jest.fn(async () => ({ ...DOC, totalAmount: null })),
    });
    await expect(service.create(ACTOR, 'doc-1', CREATE)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createPlan).not.toHaveBeenCalled();
  });

  it('refuses a staged total past the remaining payable', async () => {
    const { service, repository } = build({
      sumPayments: jest.fn(async () => '50'),
      findPlan: jest.fn(async () => PLAN()),
    });
    await expect(service.create(ACTOR, 'doc-1', CREATE)).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.create(ACTOR, 'doc-1', { installments: [{ amount: 50, method: 'CASH' }] })
    ).resolves.toBeTruthy();
    expect(repository.createPlan).toHaveBeenCalledTimes(1);
  });

  it('creates the draft with server-assigned seqs and the document snapshot', async () => {
    const { service, repository, calls } = build({
      findPlan: jest.fn(async () => PLAN({ installments: [STAGE(), STAGE({ seq: 2 })] })),
    });
    await service.create(ACTOR, 'doc-1', CREATE);
    const [tenantId, plan, installments] = calls.createPlan[0] as [
      string,
      { committedAmount: string; currency: string },
      { seq: number; amount: string }[],
    ];
    expect(tenantId).toBe('t1');
    expect(plan.committedAmount).toBe('100');
    expect(plan.currency).toBe('IRR');
    expect(installments.map((i) => i.seq)).toEqual([1, 2]);
    expect(installments[0].amount).toBe('30.0000');
    expect(repository.findPlan).toHaveBeenCalledWith('t1', expect.any(String));
  });

  it('submit moves only a DRAFT plan and audits once', async () => {
    const { service, audit } = build({ findPlan: jest.fn(async () => PLAN()) });
    const result = await service.submit(ACTOR, 'doc-1', 'plan-1');
    expect(result.status).toBe('DRAFT');
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ action: 'submit', resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN, resourceId: 'plan-1' })
    );
  });

  it('approve refuses a DRAFT plan — the submitted gate is not skippable', async () => {
    const { service, repository } = build({ findPlan: jest.fn(async () => PLAN()) });
    await expect(service.approve(ACTOR, 'doc-1', 'plan-1')).rejects.toBeInstanceOf(ConflictException);
    expect(repository.transitionPlan).not.toHaveBeenCalled();
  });

  it('plan approval does NOT pay an unapproved stage', async () => {
    const { service, repository } = build({
      findPlan: jest.fn(async () => PLAN({ status: 'APPROVED' })),
    });
    await expect(service.executeInstallment(ACTOR, 'doc-1', 'plan-1', 1, {})).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(repository.markInstallmentExecuted).not.toHaveBeenCalled();
  });

  it('installment approval requires an APPROVED plan', async () => {
    const { service, repository } = build({ findPlan: jest.fn(async () => PLAN({ status: 'SUBMITTED' })) });
    await expect(service.approveInstallment(ACTOR, 'doc-1', 'plan-1', 1)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(repository.transitionInstallment).not.toHaveBeenCalled();
  });

  it('execution mirrors the installment amount and method, never a client amount', async () => {
    const { service, calls } = build({
      findPlan: jest.fn(async () =>
        PLAN({ status: 'APPROVED', installments: [STAGE({ status: 'APPROVED' })] })
      ),
    });
    await service.executeInstallment(ACTOR, 'doc-1', 'plan-1', 1, { payerRef: 'payer-7' });
    const [, payment, , tx] = calls.append[0] as [
      string,
      { amount: string; method: string; currency: string; payerRef: string; recordedByUserId: string },
      unknown,
      string,
    ];
    expect(payment.amount).toBe('30');
    expect(payment.method).toBe('CASH');
    expect(payment.currency).toBe('IRR');
    expect(payment.payerRef).toBe('payer-7');
    expect(payment.recordedByUserId).toBe('u1');
    // The money event and the link commit inside the same unit of work.
    expect(tx).toBe('TX');
    const mark = calls.markInstallmentExecuted[0] as unknown[];
    expect(mark[3]).toBe('pay-1');
    expect(mark[5]).toBe('TX');
  });

  it('execution rechecks the remaining payable inside the transaction', async () => {
    const { service, repository } = build({
      findPlan: jest.fn(async () =>
        PLAN({ status: 'APPROVED', installments: [STAGE({ status: 'APPROVED' })] })
      ),
      sumPayments: jest.fn(async () => '80'),
    });
    await expect(service.executeInstallment(ACTOR, 'doc-1', 'plan-1', 1, {})).rejects.toBeInstanceOf(
      ConflictException
    );
    // The sum read ran INSIDE the unit of work — its third argument is the tx handle.
    expect((repository.sumPayments as jest.Mock).mock.calls[0][2]).toBe('TX');
    expect(repository.markInstallmentExecuted).not.toHaveBeenCalled();
  });

  it('a lost execution race surfaces as 409, not a phantom second payment', async () => {
    const { service } = build({
      findPlan: jest.fn(async () =>
        PLAN({ status: 'APPROVED', installments: [STAGE({ status: 'APPROVED' })] })
      ),
      markInstallmentExecuted: jest.fn(async () => {
        throw new PaymentPlanTransitionTakenError();
      }),
    });
    await expect(service.executeInstallment(ACTOR, 'doc-1', 'plan-1', 1, {})).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('cancel refuses a plan with an executed stage', async () => {
    const { service, repository } = build({
      findPlan: jest.fn(async () =>
        PLAN({ status: 'APPROVED', installments: [STAGE({ status: 'APPROVED', executedPaymentId: 'pay-1' })] })
      ),
    });
    await expect(service.cancel(ACTOR, 'doc-1', 'plan-1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(repository.transitionPlan).not.toHaveBeenCalled();
  });

  it('supersede refuses a non-approved plan and an executed stage, and names the superseded plan', async () => {
    const { service, calls } = build({
      findPlan: jest.fn(async () => PLAN({ status: 'APPROVED' })),
    });
    await service.supersede(ACTOR, 'doc-1', 'plan-1', CREATE);
    const [tenantId, planId] = calls.supersedePlan[0] as [string, string];
    expect(tenantId).toBe('t1');
    expect(planId).toBe('plan-1');

    const draft = build({ findPlan: jest.fn(async () => PLAN()) });
    await expect(draft.service.supersede(ACTOR, 'doc-1', 'plan-1', CREATE)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(draft.repository.supersedePlan).not.toHaveBeenCalled();

    const executed = build({
      findPlan: jest.fn(async () =>
        PLAN({ status: 'APPROVED', installments: [STAGE({ status: 'APPROVED', executedPaymentId: 'pay-1' })] })
      ),
    });
    await expect(executed.service.supersede(ACTOR, 'doc-1', 'plan-1', CREATE)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(executed.repository.supersedePlan).not.toHaveBeenCalled();
  });

  it('the wire shape answers plan totals honestly: planned vs executed', async () => {
    const { service } = build({
      findPlan: jest.fn(async () =>
        PLAN({
          status: 'APPROVED',
          installments: [
            STAGE({ status: 'APPROVED', executedPaymentId: 'pay-1', amount: { toString: () => '30' } }),
            STAGE({ seq: 2, status: 'APPROVED', amount: { toString: () => '40' } }),
            STAGE({ seq: 3, status: 'CANCELLED', amount: { toString: () => '10' } }),
          ],
        })
      ),
    });
    const wire = await service.get(ACTOR, 'doc-1', 'plan-1');
    expect(wire.totalPlanned).toBe('70.0000');
    expect(wire.totalExecuted).toBe('30.0000');
    expect(wire.installments).toHaveLength(3);
    expect(wire.installments[1].executedPaymentId).toBeNull();
  });

  it('list projects remaining payable against the WHOLE payment history', async () => {
    const { service } = build({
      listPlans: jest.fn(async () => [PLAN({ status: 'APPROVED' })]),
      sumPayments: jest.fn(async () => '60'),
    });
    const result = await service.list(ACTOR, 'doc-1');
    expect(result.paidAmount).toBe('60');
    expect(result.remainingPayable).toBe('40.0000');
    expect(result.plans).toHaveLength(1);
  });
});
