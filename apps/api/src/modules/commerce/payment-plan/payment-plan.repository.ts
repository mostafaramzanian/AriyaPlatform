import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type { PaymentMethod } from '../payment/payment-status';
import type { PaymentInstallmentStatus, PaymentPlanStatus } from './payment-plan-status';

/**
 * PAYMENT PLAN: the payment-instruction persistence boundary — every statement
 * this slice issues against `commerce_db`.
 *
 * LIFECYCLE TABLES ARE MUTABLE — AND THE MUTATION IS ONLY THE LIFECYCLE
 * -------------------------------------------------------------------
 * Unlike `PaymentRecord` (append-only), a plan and its installments do
 * transition. Every transition here is a `updateMany` whose `where` states the
 * REQUIRED CURRENT STATUS beside `tenantId`, so a stale or concurrent caller
 * cannot resurrect a cancelled plan or re-approve an executed stage — the
 * statement either lands on a row in the expected state or reports `count: 0`,
 * which the service translates into its named 409. There is no `update` on any
 * field a client could name, and no `.delete(` anywhere in this file.
 *
 * TENANCY: `tenantId` is the first parameter of every method and appears in
 * every `where`. `findUnique` is never used — it cannot carry a tenant
 * predicate.
 */

/** A lost transition race: the row's status was no longer the required one. */
export class PaymentPlanTransitionTakenError extends Error {
  constructor() {
    super('the transition raced another write and lost');
    this.name = 'PaymentPlanTransitionTakenError';
  }
}

/** A lost supersession race: the approved plan already has a successor. */
export class PaymentPlanSupersessionTakenError extends Error {
  constructor() {
    super('the plan already has a superseding draft');
    this.name = 'PaymentPlanSupersessionTakenError';
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** One installment as the DTO boundary delivers it — seq assigned by the caller's order. */
export interface PaymentInstallmentWrite {
  seq: number;
  amount: string;
  dueDate?: Date;
  method: PaymentMethod;
  note?: string | null;
}

export interface PaymentPlanWrite {
  purchaseDocumentId: string;
  committedAmount: string;
  currency: string | null;
  note?: string | null;
  supersedesPlanId?: string | null;
  requestedByUserId?: string | null;
}

@Injectable()
export class PaymentPlanRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /** The document the plan orders payment for — the 404 gate of every write. */
  async findDocumentForPlan(tenantId: string, documentId: string) {
    return this.prisma.purchaseDocument.findFirst({
      where: { id: documentId, tenantId },
      select: { id: true, currency: true, totalAmount: true },
    });
  }

  /** Sum over ALL of the document's recorded payments — the remaining-payable input. */
  async sumPayments(
    tenantId: string,
    purchaseDocumentId: string,
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    const aggregate = await client.paymentRecord.aggregate({
      where: { tenantId, purchaseDocumentId },
      _sum: { amount: true },
    });
    return aggregate._sum.amount;
  }

  /**
   * PHASE W3.1 / W4: the document's payment rows as `{id, amount,
   * reversesPaymentId}` triples — the read the closure evaluator's
   * refund-settlement link needs. A REFUNDED transition names the `PaymentRecord`
   * its refund reversed, and the REFUNDED AMOUNT is the magnitude of that
   * payment's COMPENSATION row — which may be a stated partial figure, never
   * the target's full amount by proxy. The evaluator never trusts a sum it
   * cannot decompose.
   */
  async listPayments(
    tenantId: string,
    purchaseDocumentId: string,
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.paymentRecord.findMany({
      where: { tenantId, purchaseDocumentId },
      select: { id: true, amount: true, reversesPaymentId: true },
    });
  }

  /** Insert the plan and its stages atomically — a plan without stages is a bug, not a row. */
  async createPlan(
    tenantId: string,
    plan: PaymentPlanWrite,
    installments: readonly PaymentInstallmentWrite[]
  ) {
    const data = {
      tenantId,
      purchaseDocumentId: plan.purchaseDocumentId,
      committedAmount: plan.committedAmount,
      currency: plan.currency,
      note: plan.note ?? null,
      supersedesPlanId: plan.supersedesPlanId ?? null,
      requestedByUserId: plan.requestedByUserId ?? null,
      installments: {
        create: installments.map((item) => ({
          seq: item.seq,
          amount: item.amount,
          dueDate: item.dueDate ?? null,
          method: item.method,
          note: item.note ?? null,
        })),
      },
    };
    try {
      return await this.prisma.paymentPlan.create({ data, include: { installments: true } });
    } catch (error) {
      // The only unique index a create can trip is the supersession link — the
      // new row's own id is a fresh UUID and (tenantId, planId, seq) is fresh.
      if (isUniqueViolation(error)) throw new PaymentPlanSupersessionTakenError();
      throw error;
    }
  }

  /** One plan with its stages, tenant-gated — the 404 gate of every plan-scoped act. */
  async findPlan(tenantId: string, planId: string, tx?: CommerceTransactionHandle) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.paymentPlan.findFirst({
      where: { id: planId, tenantId },
      include: { installments: { orderBy: { seq: 'asc' as const } } },
    });
  }

  /** The document's whole plan register, oldest first, each with ordered stages. */
  async listPlans(
    tenantId: string,
    purchaseDocumentId: string,
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.paymentPlan.findMany({
      where: { tenantId, purchaseDocumentId },
      include: { installments: { orderBy: { seq: 'asc' as const } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * A lifecycle transition expressed as `updateMany` gated on the REQUIRED
   * current status: `count: 1` means the row moved, `count: 0` means it was
   * already somewhere else (stale view or a lost race) and the service names
   * that a 409.
   */
  async transitionPlan(
    tenantId: string,
    planId: string,
    from: readonly PaymentPlanStatus[],
    patch: {
      status: PaymentPlanStatus;
      submittedAt?: Date;
      approvedByUserId?: string | null;
      approvedAt?: Date;
      cancelledAt?: Date;
      cancelReason?: string | null;
    },
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    const result = await client.paymentPlan.updateMany({
      where: { id: planId, tenantId, status: { in: [...from] } },
      data: patch,
    });
    return result.count;
  }

  /** The same gated transition for one stage of the plan. */
  async transitionInstallment(
    tenantId: string,
    planId: string,
    seq: number,
    from: readonly PaymentInstallmentStatus[],
    patch: {
      status: PaymentInstallmentStatus;
      approvedByUserId?: string | null;
      approvedAt?: Date;
    },
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    const result = await client.paymentInstallment.updateMany({
      where: { tenantId, planId, seq, status: { in: [...from] } },
      data: patch,
    });
    return result.count;
  }

  /**
   * Mark the approved plan SUPERSEDED and insert its successor draft in ONE
   * interactive transaction: the old plan either moved out of APPROVED and the
   * draft landed, or nothing happened. The unique index on
   * `(tenantId, supersedesPlanId)` is the structural backstop against two
   * concurrent revisions.
   */
  async supersedePlan(
    tenantId: string,
    planId: string,
    successor: PaymentPlanWrite,
    installments: readonly PaymentInstallmentWrite[]
  ) {
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.paymentPlan.updateMany({
        where: { id: planId, tenantId, status: 'APPROVED' },
        data: { status: 'SUPERSEDED' },
      });
      if (moved.count === 0) throw new PaymentPlanTransitionTakenError();
      try {
        return await tx.paymentPlan.create({
          data: {
            tenantId,
            purchaseDocumentId: successor.purchaseDocumentId,
            committedAmount: successor.committedAmount,
            currency: successor.currency,
            note: successor.note ?? null,
            supersedesPlanId: planId,
            requestedByUserId: successor.requestedByUserId ?? null,
            installments: {
              create: installments.map((item) => ({
                seq: item.seq,
                amount: item.amount,
                dueDate: item.dueDate ?? null,
                method: item.method,
                note: item.note ?? null,
              })),
            },
          },
          include: { installments: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new PaymentPlanSupersessionTakenError();
        throw error;
      }
    });
  }

  /**
   * Link one approved stage to the money event its execution appended. The
   * `PaymentRecord` row itself is written by the PAYMENT slice's own
   * repository — that history has exactly one writer, and this file only
   * states the link — inside the CALLER's unit of work so the two can never
   * commit apart. The `executedPaymentId IS NULL` predicate is the
   * idempotency gate — `count: 0` means a concurrent execution already
   * landed; the unique index on `(tenantId, executed_payment_id)` is the
   * structural backstop should both somehow race past the predicate.
   */
  async markInstallmentExecuted(
    tenantId: string,
    planId: string,
    seq: number,
    executedPaymentId: string,
    executedAt: Date,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);
    const marked = await client.paymentInstallment.updateMany({
      where: { tenantId, planId, seq, status: 'APPROVED', executedPaymentId: null },
      data: { executedPaymentId, executedAt },
    });
    if (marked.count === 0) throw new PaymentPlanTransitionTakenError();
  }
}
