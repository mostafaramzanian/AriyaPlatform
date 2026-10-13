import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle } from '../database/commerce-transaction';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import { moneyFromNumber, negateMoney } from '../purchase/purchase-money';
import {
  PaymentCompensationTakenError,
  PaymentHistoryRepository,
} from './payment-history.repository';
import { CompensatePaymentDto, CreatePaymentDto, ListPaymentsQueryDto } from './payment.dto';
import { projectPaymentStatus } from './payment-status';

/**
 * Phase C1 Step Q (§5.13, §5.14, contract §2-Q1…Q9 and §3): the payment history's
 * application layer — append-only writes, the read-time payment status projection, and
 * the ONE audit trail's payment vocabulary.
 *
 * THE SHAPE OF THIS SERVICE, AND WHAT IS DELIBERATELY MISSING
 * -----------------------------------------------------------
 * Two dependencies: the repository (every statement) and the audit gateway (§I8). There
 * is NO identity gateway — every reference a payment states is opaque (§13), so nothing
 * here resolves a person — NO workflow, NO commercial and NO receiving read, and NO unit
 * of work OPENED HERE: an append is a single INSERT, and the projection is computed from
 * what a single transaction already returned. (A caller that already HAS a unit of work
 * may hand Q its handle — `compensate`'s last parameter — and Q JOINS it rather than
 * opening a second connection, which is what keeps a foreign-key lock from waiting on the
 * caller's own row lock; see that method's note. Q still opens none.)
 * Payment state is an INDEPENDENT dimension
 * (§5.11–§5.13, tests 18 and 19): nothing in this file may gate a payment on a document
 * status, and nothing may let a payment move one.
 *
 * THE PROJECTION HAS ONE HOME. `projectPaymentStatus(totalAmount, paidAmount)` in
 * `payment-status.ts` owns all five rules; this service only gathers the two inputs —
 * the document's OWN stored total and Σ over ALL of its rows (never the filtered page,
 * contract Q9) — and reports them beside the page. A rule re-typed here is how `PAID`
 * and `PARTIAL` both end up true for the same amounts.
 *
 * REFUSALS ARE NAMED, NEVER SILENT (contract §3-E): unknown/foreign document → 404
 * before any write; unknown payment → 404; a second compensation → 409 naming the
 * existing reversal (the early read, and again from the unique index if the read's race
 * was lost); DTO violations are 400 at the boundary. No fallback, no default method, no
 * silent clamp — and no status transition, because no route here decides anything.
 */

/**
 * The payment slice's two audit actions, declared beside the code that records them
 * (contract §3-G). Resource is `COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD` — step G
 * declared it for exactly this row. One trail, one row per write; reads audit nothing.
 */
export const PAYMENT_AUDIT_ACTION = {
  APPEND: 'append',
  COMPENSATE: 'compensate',
} as const;

/** One row as the repository returns it. */
type PaymentRecordRow = Awaited<ReturnType<PaymentHistoryRepository['append']>>;

@Injectable()
export class PaymentHistoryService {
  constructor(
    private readonly repository: PaymentHistoryRepository,
    private readonly audit: CommerceAuditGateway
  ) {}

  /**
   * `GET …/payments` — a page of the history, OLDEST FIRST, beside the payment status
   * of the WHOLE history (§6, contract Q9).
   *
   * The page and its count answer "what was recorded, in order"; the `paymentStatus`
   * block answers "where does this document stand" — and the two are read in one
   * repository transaction, so the status cannot describe a different moment than the
   * rows rendered with it. `totalAmount IS NULL` projects `null` (§3-B rule 1: an
   * unstated total is not zero), reported with `paidAmount`/`currency` still present so
   * a client can render "no total stated" honestly.
   */
  async list(actor: CommerceActor, documentId: string, query: ListPaymentsQueryDto) {
    const window = resolveCommercePageWindow(query);

    const document = await this.repository.findDocumentForPayment(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');

    const [rows, total, aggregate] = await this.repository.readPaymentPage(
      actor.tenantId,
      documentId,
      { method: query.method, search: query.search },
      window
    );

    // The WHOLE history's sum, unfiltered — `null` means no rows at all, which is
    // exactly `0.0000` for the projection (no rows, no money moved).
    const paidAmount = aggregate._sum.amount !== null ? String(aggregate._sum.amount) : '0.0000';
    const totalAmount = document.totalAmount !== null ? String(document.totalAmount) : null;

    return {
      items: rows.map((row) => PaymentHistoryService.view(row)),
      page: window.page,
      pageSize: window.pageSize,
      total,
      paymentStatus: {
        status: projectPaymentStatus(totalAmount, paidAmount),
        paidAmount,
        totalAmount,
        currency: document.currency,
      },
    };
  }

  /**
   * `POST …/payments` — append one payment event (201: the stored row).
   *
   * Q6's ONLY refusal is existence: the document is read first (404 BEFORE any write)
   * and nothing else is consulted — not its status, not its workflow, not its commercial
   * state. A payment may be appended on any lifecycle state, because "some status must
   * refuse payments" is a business rule no contract in C1 states.
   *
   * The currency is SNAPSHOT-TAKEN from the document (Q5): `CreatePaymentDto` has no
   * such field, so a payload can never decide the unit a row was recorded in, and every
   * later row of the same document states the same one.
   */
  async append(actor: CommerceActor, documentId: string, dto: CreatePaymentDto) {
    const document = await this.repository.findDocumentForPayment(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');

    const appendData = {
      purchaseDocumentId: documentId,
      amount: moneyFromNumber(dto.amount),
      currency: document.currency,
      method: dto.method,
      ...(dto.paymentDate ? { paymentDate: new Date(dto.paymentDate) } : {}),
      payerRef: dto.payerRef ?? null,
      payeeRef: dto.payeeRef ?? null,
      invoiceRef: dto.invoiceRef ?? null,
      externalReference: dto.externalReference ?? null,
      recordedByUserId: actor.userId,
    };

    // Phase B2.3: build the durable outbox payload BEFORE the write.
    // The row id is not yet known — it will be a UUID assigned by the DB.
    // We use the documentId as resourceId since that is the parent resource.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PAYMENT_AUDIT_ACTION.APPEND,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD,
      resourceId: documentId,
      newValue: {
        purchaseDocumentId: documentId,
        amount: appendData.amount,
        currency: appendData.currency,
        method: appendData.method,
        payerRef: appendData.payerRef,
        payeeRef: appendData.payeeRef,
        invoiceRef: appendData.invoiceRef,
        externalReference: appendData.externalReference,
      },
    });

    const row = await this.repository.append(
      actor.tenantId,
      appendData,
      outbox,
    );

    return PaymentHistoryService.view(row);
  }

  /**
   * `POST …/payments/:paymentId/compensate` — append the compensating row (201: the
   * stored row). The ONLY correction mechanism that exists for payment history (Q4):
   * no PATCH, no PUT, no DELETE, ever.
   *
   * FIELD BY FIELD (contract §3-D), because none of the row's defining facts are
   * client-stated: `amount` is `negateMoney` of the target — bit-for-bit its magnitude,
   * never a payload's number; `method` and `currency` are MIRRORED from the target;
   * `reversesPaymentId` is the path's own id; the three business references are NULL —
   * each row states its OWN — while `externalReference` is the caller's own reference
   * for the correction, and `paymentDate` its stated instant else the row default.
   * `reason` is not a column: it rides to the ONE trail's audit event (§3-G), so the
   * rationale has exactly one home.
   *
   * TWICE-ANSWERED 409, BOTH HONEST (§3-E): the early read names the existing
   * reversal for the common case, and a lost race surfaces from the unique index as
   * `PaymentCompensationTakenError`, which re-reads to name the winner. The index is
   * the authority; the reads are the names.
   *
   * `tx`, AND WHY THE HANDLE MUST BE FORWARDED (Step U's finding). `PaymentRecord` declares a
   * foreign key to `PurchaseDocument`, so this act's INSERT takes `FOR KEY SHARE` on the
   * document row — while a caller's unit of work may hold `FOR UPDATE` on that same row, and
   * the two locks CONFLICT. On a second connection the append waited on the caller's own lock
   * until Prisma's 5 s transaction timeout killed the caller: S's refund answered 500 with the
   * compensation committed ALONE. Given the handle, every statement below is issued on the
   * CALLER's connection and transaction — nothing waits, and the two writes are one act.
   */
  async compensate(
    actor: CommerceActor,
    documentId: string,
    paymentId: string,
    dto: CompensatePaymentDto,
    tx?: CommerceTransactionHandle
  ) {
    const document = await this.repository.findDocumentForPayment(actor.tenantId, documentId, tx);
    if (!document) throw new NotFoundException('Purchase document not found');

    const target = await this.repository.findPaymentForCompensation(
      actor.tenantId,
      documentId,
      paymentId,
      tx
    );
    if (!target) throw new NotFoundException('Payment record not found');

    const existing = await this.repository.findCompensation(actor.tenantId, target.id, tx);
    if (existing) {
      throw new ConflictException(`The payment already has a compensating row: ${existing.id}`);
    }

    // Phase B2.3: build the durable outbox payload BEFORE the write.
    const compensateOutbox = this.audit.buildOutboxPayload(actor, {
      action: PAYMENT_AUDIT_ACTION.COMPENSATE,
      resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD,
      resourceId: documentId,
      oldValue: { reversesPaymentId: target.id, amount: String(target.amount) },
      newValue: { amount: negateMoney(String(target.amount)) },
      reason: dto.reason ?? null,
    });

    let row: PaymentRecordRow;
    try {
      row = await this.repository.append(
        actor.tenantId,
        {
          purchaseDocumentId: documentId,
          amount: negateMoney(String(target.amount)),
          currency: target.currency,
          method: target.method,
          ...(dto.paymentDate ? { paymentDate: new Date(dto.paymentDate) } : {}),
          payerRef: null,
          payeeRef: null,
          invoiceRef: null,
          externalReference: dto.externalReference ?? null,
          reversesPaymentId: target.id,
          recordedByUserId: actor.userId,
        },
        compensateOutbox,
        tx,
      );
    } catch (error) {
      if (!(error instanceof PaymentCompensationTakenError)) throw error;
      const winner = await this.repository.findCompensation(actor.tenantId, target.id);
      throw new ConflictException(
        winner
          ? `The payment already has a compensating row: ${winner.id}`
          : 'The payment already has a compensating row'
      );
    }

    return PaymentHistoryService.view(row);
  }

  /**
   * The wire projection of one row — §6's OWN field list, stated explicitly so that
   * `tenantId` can never reach a body by omission of thought (test 21). The document id
   * is absent for the same reason: the route already names the document, and a row
   * restating it would be a second place the pair is kept together.
   *
   * Money is the exact stored `Decimal(18,4)` STRING (§3-C) — never a number, never a
   * re-formatting of what the column holds.
   */
  private static view(row: PaymentRecordRow) {
    return {
      id: row.id,
      amount: String(row.amount),
      currency: row.currency,
      method: row.method,
      paymentDate: row.paymentDate,
      payerRef: row.payerRef,
      payeeRef: row.payeeRef,
      invoiceRef: row.invoiceRef,
      externalReference: row.externalReference,
      reversesPaymentId: row.reversesPaymentId,
      recordedByUserId: row.recordedByUserId,
      createdAt: row.createdAt,
    };
  }
}
