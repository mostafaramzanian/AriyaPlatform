import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { CommerceUnitOfWork } from '../database/commerce-transaction';
import { PaymentHistoryRepository } from '../payment/payment-history.repository';
import { addMoney, compareMoney, moneyFromNumber } from '../purchase/purchase-money';
import {
  PaymentPlanRepository,
  PaymentPlanSupersessionTakenError,
  PaymentPlanTransitionTakenError,
} from './payment-plan.repository';
import { PAYMENT_PLAN_CANCELLABLE } from './payment-plan-status';
import type {
  CancelPaymentPlanDto,
  CreatePaymentPlanDto,
  ExecuteInstallmentDto,
  SupersedePaymentPlanDto,
} from './payment-plan.dto';

/**
 * PAYMENT PLAN (دستور پرداخت و رژیم پرداخت): the payment-instruction slice's
 * application layer.
 *
 * THE RULES THE BUSINESS REQUIREMENTS NAME
 * ----------------------------------------
 *  - One purchase case, MANY stages: a plan is a list of installments against
 *    the SAME document — a payment stage never spawns a new purchase.
 *  - Each stage needs its OWN approval: plan approval and installment approval
 *    are two separate gates (`commerce.approve` on both), so paying stage two
 *    is never implied by having approved the purchase or the plan.
 *  - A plan that must change is SUPERSEDED, never edited: the approved version
 *    and its approval evidence stay readable (the quotation lifecycle rule).
 *  - Execution appends to the SAME append-only `PaymentRecord` history the
 *    direct payment route writes — one money history, and the installment's
 *    `executedPaymentId` is the immutable link between instruction and event.
 *  - The staged total may never pass the document's commitment: creation
 *    refuses a sum past the remaining payable, and execution re-checks it at
 *    the moment the money event is appended.
 *  - A partially paid case is never "closed" — this slice writes no document
 *    status and decides no lifecycle; payment state stays an independent
 *    dimension.
 *
 * REFUSALS ARE NAMED: unknown/foreign document or plan → 404 before any write;
 * a transition whose required status is gone → 409; a second successor → 409;
 * executing a stage that would pass the commitment → 409.
 */

export const PAYMENT_PLAN_AUDIT_ACTION = {
  CREATE: 'create',
  SUBMIT: 'submit',
  APPROVE: 'approve',
  SUPERSEDE: 'supersede',
  CANCEL: 'cancel',
  INSTALLMENT_APPROVE: 'installment_approve',
  INSTALLMENT_CANCEL: 'installment_cancel',
  INSTALLMENT_EXECUTE: 'installment_execute',
} as const;

type PlanRow = NonNullable<Awaited<ReturnType<PaymentPlanRepository['findPlan']>>>;

@Injectable()
export class PaymentPlanService {
  constructor(
    private readonly plans: PaymentPlanRepository,
    // Q's repository writes every `PaymentRecord` row — this slice states the
    // instruction and the link, the payment slice states the money event. Two
    // writes, one writer each, one unit of work.
    private readonly payments: PaymentHistoryRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  /** The 404 gate every act shares: the document in THIS tenant, or nothing. */
  private async requireDocument(actor: CommerceActor, documentId: string) {
    const document = await this.plans.findDocumentForPlan(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('purchase document not found');
    return document;
  }

  /** The plan in THIS tenant, hanging under THIS document — or 404, never 403. */
  private async requirePlan(actor: CommerceActor, documentId: string, planId: string) {
    const plan = await this.plans.findPlan(actor.tenantId, planId);
    if (!plan || plan.purchaseDocumentId !== documentId) {
      throw new NotFoundException('payment plan not found');
    }
    return plan;
  }

  /** Sum the stage amounts into one exact string — never float arithmetic. */
  private sumInstallments(installments: CreatePaymentPlanDto['installments']): string {
    return installments.reduce(
      (total, item) => addMoney(total, moneyFromNumber(item.amount)),
      '0'
    );
  }

  private wirePlan(plan: PlanRow) {
    const totalPlanned = plan.installments
      .filter((i) => i.status !== 'CANCELLED')
      .reduce((total, i) => addMoney(total, i.amount.toString()), '0');
    const totalExecuted = plan.installments
      .filter((i) => i.executedPaymentId !== null)
      .reduce((total, i) => addMoney(total, i.amount.toString()), '0');
    return {
      id: plan.id,
      status: plan.status,
      committedAmount: plan.committedAmount.toString(),
      currency: plan.currency,
      note: plan.note,
      supersedesPlanId: plan.supersedesPlanId,
      requestedByUserId: plan.requestedByUserId,
      submittedAt: plan.submittedAt,
      approvedByUserId: plan.approvedByUserId,
      approvedAt: plan.approvedAt,
      cancelledAt: plan.cancelledAt,
      cancelReason: plan.cancelReason,
      createdAt: plan.createdAt,
      totalPlanned,
      totalExecuted,
      installments: plan.installments.map((i) => ({
        seq: i.seq,
        amount: i.amount.toString(),
        dueDate: i.dueDate,
        method: i.method,
        status: i.status,
        note: i.note,
        approvedByUserId: i.approvedByUserId,
        approvedAt: i.approvedAt,
        executedPaymentId: i.executedPaymentId,
        executedAt: i.executedAt,
        createdAt: i.createdAt,
      })),
    };
  }

  /** `GET …/payment-plans` — the register plus the remaining-payable projection. */
  async list(actor: CommerceActor, documentId: string) {
    const document = await this.requireDocument(actor, documentId);
    const [plans, paidSum] = await Promise.all([
      this.plans.listPlans(actor.tenantId, documentId),
      this.plans.sumPayments(actor.tenantId, documentId),
    ]);
    const total = document.totalAmount?.toString() ?? null;
    const paid = (paidSum ?? '0').toString();
    const remaining = total === null ? null : addMoney(total, `-${paid}`);
    return {
      document: { totalAmount: total, currency: document.currency },
      paidAmount: paid,
      remainingPayable: remaining,
      plans: plans.map((plan) => this.wirePlan(plan)),
    };
  }

  /** `GET …/payment-plans/:planId`. */
  async get(actor: CommerceActor, documentId: string, planId: string) {
    await this.requireDocument(actor, documentId);
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /**
   * `POST …/payment-plans` — a DRAFT plan. The stage list's sum may not pass
   * the remaining payable (commitment minus recorded payments): a plan that
   * could never be executed is refused at the door.
   */
  async create(actor: CommerceActor, documentId: string, dto: CreatePaymentPlanDto) {
    const document = await this.requireDocument(actor, documentId);
    // No committed total, nothing to stage: a plan against an unpriced
    // document would approve money against a ceiling that does not exist.
    if (document.totalAmount === null) {
      throw new ConflictException('the document has no committed total yet');
    }
    const committed = document.totalAmount.toString();
    const paidSum = ((await this.plans.sumPayments(actor.tenantId, documentId)) ?? '0').toString();
    const staged = this.sumInstallments(dto.installments);
    if (compareMoney(staged, addMoney(committed, `-${paidSum}`)) > 0) {
      throw new ConflictException('installments exceed the document commitment');
    }
    const plan = await this.plans.createPlan(
      actor.tenantId,
      {
        purchaseDocumentId: documentId,
        committedAmount: committed,
        currency: document.currency,
        note: dto.note ?? null,
        requestedByUserId: actor.userId,
      },
      dto.installments.map((item, index) => ({
        seq: index + 1,
        amount: moneyFromNumber(item.amount),
        ...(item.dueDate ? { dueDate: new Date(item.dueDate) } : {}),
        method: item.method,
        note: item.note ?? null,
      }))
    );
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: plan.id,
      newValue: { purchaseDocumentId: documentId, installments: plan.installments.length },
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, plan.id));
  }

  /** `POST …/:planId/submit` — DRAFT → SUBMITTED (`commerce.manage`). */
  async submit(actor: CommerceActor, documentId: string, planId: string) {
    const plan = await this.requirePlan(actor, documentId, planId);
    if (plan.status !== 'DRAFT') {
      throw new ConflictException(`payment plan is ${plan.status}, not DRAFT`);
    }
    const moved = await this.plans.transitionPlan(actor.tenantId, planId, ['DRAFT'], {
      status: 'SUBMITTED',
      submittedAt: new Date(),
    });
    if (moved === 0) throw new ConflictException('payment plan no longer draft');
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.SUBMIT,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: planId,
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /** `POST …/:planId/approve` — SUBMITTED → APPROVED (`commerce.approve`). */
  async approve(actor: CommerceActor, documentId: string, planId: string) {
    const plan = await this.requirePlan(actor, documentId, planId);
    if (plan.status !== 'SUBMITTED') {
      throw new ConflictException(`payment plan is ${plan.status}, not SUBMITTED`);
    }
    const moved = await this.plans.transitionPlan(actor.tenantId, planId, ['SUBMITTED'], {
      status: 'APPROVED',
      approvedByUserId: actor.userId,
      approvedAt: new Date(),
    });
    if (moved === 0) throw new ConflictException('payment plan no longer submitted');
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.APPROVE,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: planId,
      newValue: { approvedByUserId: actor.userId },
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /**
   * `POST …/:planId/cancel` — refused once any stage is executed: recorded
   * money is compensated through the payment history, never erased by a plan
   * transition.
   */
  async cancel(actor: CommerceActor, documentId: string, planId: string, dto: CancelPaymentPlanDto) {
    const plan = await this.requirePlan(actor, documentId, planId);
    if (!PAYMENT_PLAN_CANCELLABLE.includes(plan.status)) {
      throw new ConflictException(`payment plan is ${plan.status} and cannot be cancelled`);
    }
    if (plan.installments.some((i) => i.executedPaymentId !== null)) {
      throw new ConflictException('an executed installment blocks cancellation');
    }
    const moved = await this.plans.transitionPlan(
      actor.tenantId,
      planId,
      [...PAYMENT_PLAN_CANCELLABLE],
      { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason ?? null }
    );
    if (moved === 0) throw new ConflictException('payment plan no longer cancellable');
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.CANCEL,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: planId,
      reason: dto.reason ?? null,
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /**
   * `POST …/:planId/supersede` — the revision act on an APPROVED plan: the old
   * plan becomes SUPERSEDED and a new DRAFT names it, atomically. Refused when
   * any stage is already executed — revising a partially executed plan is a
   * separate business decision this slice does not invent.
   */
  async supersede(actor: CommerceActor, documentId: string, planId: string, dto: SupersedePaymentPlanDto) {
    await this.requireDocument(actor, documentId);
    const plan = await this.requirePlan(actor, documentId, planId);
    if (plan.status !== 'APPROVED') {
      throw new ConflictException(`payment plan is ${plan.status}, not APPROVED`);
    }
    if (plan.installments.some((i) => i.executedPaymentId !== null)) {
      throw new ConflictException('an executed installment blocks supersession');
    }
    const paidSum = ((await this.plans.sumPayments(actor.tenantId, documentId)) ?? '0').toString();
    const staged = this.sumInstallments(dto.installments);
    if (compareMoney(staged, addMoney(plan.committedAmount.toString(), `-${paidSum}`)) > 0) {
      throw new ConflictException('installments exceed the plan commitment');
    }
    try {
      const successor = await this.plans.supersedePlan(
        actor.tenantId,
        planId,
        {
          purchaseDocumentId: documentId,
          committedAmount: plan.committedAmount.toString(),
          currency: plan.currency,
          note: dto.note ?? plan.note,
          requestedByUserId: actor.userId,
        },
        dto.installments.map((item, index) => ({
          seq: index + 1,
          amount: moneyFromNumber(item.amount),
          ...(item.dueDate ? { dueDate: new Date(item.dueDate) } : {}),
          method: item.method,
          note: item.note ?? null,
        }))
      );
      await this.audit.record(actor, {
        action: PAYMENT_PLAN_AUDIT_ACTION.SUPERSEDE,
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
        resourceId: successor.id,
        oldValue: { supersededPlanId: planId },
        newValue: { installments: successor.installments.length },
      });
      return this.wirePlan(await this.requirePlan(actor, documentId, successor.id));
    } catch (error) {
      if (error instanceof PaymentPlanTransitionTakenError || error instanceof PaymentPlanSupersessionTakenError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /** `POST …/installments/:seq/approve` — a stage's own decision gate. */
  async approveInstallment(actor: CommerceActor, documentId: string, planId: string, seq: number) {
    const plan = await this.requirePlan(actor, documentId, planId);
    if (plan.status !== 'APPROVED') {
      throw new ConflictException('the plan is not APPROVED');
    }
    const installment = plan.installments.find((i) => i.seq === seq);
    if (!installment) throw new NotFoundException('installment not found');
    if (installment.status !== 'PENDING') {
      throw new ConflictException(`installment is ${installment.status}, not PENDING`);
    }
    const moved = await this.plans.transitionInstallment(
      actor.tenantId,
      planId,
      seq,
      ['PENDING'],
      { status: 'APPROVED', approvedByUserId: actor.userId, approvedAt: new Date() }
    );
    if (moved === 0) throw new ConflictException('installment no longer pending');
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.INSTALLMENT_APPROVE,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: planId,
      newValue: { seq, approvedByUserId: actor.userId },
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /** `POST …/installments/:seq/cancel` — refuse an executed stage. */
  async cancelInstallment(actor: CommerceActor, documentId: string, planId: string, seq: number) {
    const plan = await this.requirePlan(actor, documentId, planId);
    const installment = plan.installments.find((i) => i.seq === seq);
    if (!installment) throw new NotFoundException('installment not found');
    if (installment.executedPaymentId !== null) {
      throw new ConflictException('an executed installment cannot be cancelled');
    }
    const moved = await this.plans.transitionInstallment(
      actor.tenantId,
      planId,
      seq,
      ['PENDING', 'APPROVED'],
      { status: 'CANCELLED' }
    );
    if (moved === 0) throw new ConflictException(`installment is ${installment.status}`);
    await this.audit.record(actor, {
      action: PAYMENT_PLAN_AUDIT_ACTION.INSTALLMENT_CANCEL,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
      resourceId: planId,
      newValue: { seq },
    });
    return this.wirePlan(await this.requirePlan(actor, documentId, planId));
  }

  /**
   * `POST …/installments/:seq/execute` — append the money event and mark the
   * stage executed in ONE unit of work. The remaining-payable ceiling is
   * re-checked inside the transaction so a concurrent execution cannot push
   * the recorded total past the commitment.
   */
  async executeInstallment(
    actor: CommerceActor,
    documentId: string,
    planId: string,
    seq: number,
    dto: ExecuteInstallmentDto
  ) {
    const plan = await this.requirePlan(actor, documentId, planId);
    if (plan.status !== 'APPROVED') {
      throw new ConflictException('the plan is not APPROVED');
    }
    const installment = plan.installments.find((i) => i.seq === seq);
    if (!installment) throw new NotFoundException('installment not found');
    if (installment.status !== 'APPROVED' || installment.executedPaymentId !== null) {
      throw new ConflictException('installment is not an approved, unexecuted stage');
    }
    try {
      const row = await this.unitOfWork.run(async (tx) => {
        const paidSum = (await this.plans.sumPayments(actor.tenantId, documentId, tx)) ?? '0';
        if (
          compareMoney(
            addMoney(paidSum.toString(), installment.amount.toString()),
            plan.committedAmount.toString()
          ) > 0
        ) {
          throw new ConflictException('the installment exceeds the plan commitment');
        }
        const row = await this.payments.append(
          actor.tenantId,
          {
            purchaseDocumentId: documentId,
            amount: installment.amount.toString(),
            currency: plan.currency,
            method: installment.method,
            ...(dto.paymentDate ? { paymentDate: new Date(dto.paymentDate) } : {}),
            payerRef: dto.payerRef ?? null,
            payeeRef: dto.payeeRef ?? null,
            invoiceRef: dto.invoiceRef ?? null,
            externalReference: dto.externalReference ?? null,
            recordedByUserId: actor.userId,
          },
          undefined,
          tx
        );
        await this.plans.markInstallmentExecuted(
          actor.tenantId,
          planId,
          seq,
          row.id,
          new Date(),
          tx
        );
        return row;
      });
      await this.audit.record(actor, {
        action: PAYMENT_PLAN_AUDIT_ACTION.INSTALLMENT_EXECUTE,
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
        resourceId: planId,
        newValue: { seq, paymentRecordId: row.id },
      });
      return this.wirePlan(await this.requirePlan(actor, documentId, planId));
    } catch (error) {
      if (error instanceof PaymentPlanTransitionTakenError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
