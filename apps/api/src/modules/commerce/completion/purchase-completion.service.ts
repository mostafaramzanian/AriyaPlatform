import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import {
  canCompletePurchaseDocument,
  type PurchaseDocumentStatus,
} from '../purchase/purchase-status';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { PurchaseService } from '../purchase/purchase.service';
import {
  PURCHASE_COMPLETION_AUDIT_ACTION,
  PURCHASE_COMPLETION_FAILURE,
} from './completion.constants';
import {
  describeAllowedFromStatuses,
  readAllowedFromStatuses,
} from './purchase-completion-policy';
import { PurchaseCompletionPolicyRepository } from './purchase-completion-policy.repository';
import { InventoryPostingRepository } from '../integration/inventory-posting.repository';
import { ReceivingHistoryRepository } from '../receiving/receiving-history.repository';
import { ReturnHistoryRepository } from '../returns/return-history.repository';
import { PaymentPlanRepository } from '../payment-plan/payment-plan.repository';
import { projectReturnState } from '../returns/return-lifecycle';
import { compareMoney, negateMoney, sumMoney } from '../purchase/purchase-money';
import {
  evaluatePurchaseClosure,
  type ClosureFacts,
} from './purchase-completion-eligibility';

/**
 * PHASE C4-R (GAP-3): THE COMPLETION ACT — the ONE service that may move a
 * `PurchaseDocument` to `CLOSED` (C1 §29).
 *
 * THE ARCHITECTURE THIS FILE IMPLEMENTS (brief §14), LITERALLY:
 *
 *   HTTP controller
 *     ↓ resolveCommerceActor (the controller's only act)
 *   PurchaseCompletionService            ← this file
 *     ↓ PurchaseCompletionPolicyRepository.findPublished  (the policy resolver)
 *     ↓ domain reads (PurchaseRepository, tenant-scoped)
 *     ↓ ONE conditional transition (PurchaseRepository.writeCompletedIn)
 *     ↓ the module's established wire projection (PurchaseService.getOne)
 *
 * THE CONTROLLER DECIDES NOTHING: it does not read a policy, does not inspect a status and
 * does not assemble a rule. Everything between "a request arrived" and "a row moved" is
 * here, and everything below here is a repository statement.
 *
 * THE ORDER OF THE FOUR REFUSALS IS THE CONTRACT:
 *   1. the document must exist IN THIS TENANT — else 404 (never 403: existence is not
 *      confirmed across tenants);
 *   2. the document must not already be `CLOSED` — else 409 `DOCUMENT_ALREADY_COMPLETED`
 *      (the stable "already completed" fact, checked before the policy so a repeat click is
 *      answered the same way in every tenant, configured or not);
 *   3. the tenant must have a PUBLISHED policy — else 409 `POLICY_NOT_CONFIGURED`. THIS IS
 *      THE FAIL-CLOSED RULE (brief §18): no policy means completion is unavailable, and the
 *      service NEVER falls back to a draft, to "latest", to a default, or to "no
 *      prerequisites". A stored policy that cannot be evaluated is refused the same way;
 *   4. the policy must NAME the document's current status — else 409 `STATUS_NOT_ALLOWED`,
 *      the configured business rule doing the work decisions D1 used to leave open.
 *
 * THEN THE WRITE, ONCE, CONDITIONALLY: `writeCompletedIn` carries the policy's whole source
 * set in its `where` AND `completedAt: null`, so a second completion — raced by another
 * actor, or by a commercial projection moving the document — matches nothing and answers
 * the established 409 `WRITE_CONFLICT`. One winner, one refusal, no double-recorded actor,
 * and no silent success.
 *
 * PHASE W3 AMENDS THE INDEPENDENCE NOTE: the product owner's confirmed closure rule makes
 * the document's own fulfilment and settlement facts prerequisites of CLOSED. This service
 * therefore READS receiving, return, payment and payment-plan state — inside the close
 * transaction, under `FOR UPDATE` on the document row — but still WRITES only the document's
 * own status (plus its status-event and audit-outbox rows, atomically). What this file must
 * never do remains: decide WHO may act (Core/RBAC's `commerce.manage` guard on the route),
 * or accept a tenant, an actor id or a completion timestamp from a request.
 */
@Injectable()
export class PurchaseCompletionService {
  constructor(
    private readonly documents: PurchaseRepository,
    private readonly policies: PurchaseCompletionPolicyRepository,
    private readonly purchases: PurchaseService,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork,
    private readonly notification: CommerceNotificationGateway,
    // PHASE W2-C: the integration ledger seam — close refuses a document whose
    // receipt/return postings are still unresolved (PENDING/FAILED), so CLOSED
    // can never coexist with stock evidence that has not reached inventory.
    private readonly postings: InventoryPostingRepository,
    // PHASE W3 (confirmed closure rule): the fact readers the eligibility
    // evaluator needs — receiving history (net received per line), returns
    // (unresolved lifecycle states), payments + plans (settlement). All are
    // read INSIDE the close transaction, under the document row lock.
    private readonly receiving: ReceivingHistoryRepository,
    private readonly returns: ReturnHistoryRepository,
    private readonly plans: PaymentPlanRepository
  ) {}

  /**
   * Complete ONE purchase document (`POST /commerce/purchase-documents/:id/close`).
   *
   * The answer is the document as the GET route projects it — the SAME projection, read
   * back through the same service after the write, so a client cannot receive a shape this
   * module's next read would not reproduce.
   */
  async close(actor: CommerceActor, id: string) {
    const document = await this.documents.findDocumentById(actor.tenantId, id);
    if (!document) throw new NotFoundException('Purchase document not found');

    if (document.status === 'CLOSED') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.DOCUMENT_ALREADY_COMPLETED,
        message: 'This purchase document is already completed.',
      });
    }

    const policy = await this.policies.findPublished(actor.tenantId);
    if (!policy) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED,
        message:
          'No purchase completion policy is published for this tenant, so purchases cannot be completed.',
      });
    }

    const allowedFromStatuses = readAllowedFromStatuses(policy.allowedFromStatuses);
    if (!allowedFromStatuses) {
      // A PUBLISHED row that cannot be evaluated — a shape that should be impossible
      // (publication runs the same checklist) and is nevertheless answered as NOT
      // CONFIGURED rather than guessed at: fail closed means fail closed here too.
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED,
        message:
          'The published purchase completion policy is not evaluable, so purchases cannot be completed.',
      });
    }

    if (!canCompletePurchaseDocument(document.status, allowedFromStatuses)) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.STATUS_NOT_ALLOWED,
        message: `A purchase document in status ${document.status} may not be completed under the published policy (allowed: ${describeAllowedFromStatuses(allowedFromStatuses)}).`,
      });
    }

    const completedAt = new Date();

    // Phase B2.3: build the durable outbox payload BEFORE the unit of work.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.DOCUMENT_CLOSED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: id,
      oldValue: { status: document.status },
      newValue: {
        status: 'CLOSED',
        completedAt: completedAt.toISOString(),
        completedByUserId: actor.userId,
        completionPolicyVersionId: policy.id,
      },
    });

    // PHASE W3 (confirmed closure rule + §29): EVERYTHING below runs inside ONE
    // transaction behind `SELECT … FOR UPDATE` on the document row — the same
    // lock the receipt and return writers take, and one that conflicts with the
    // `FOR KEY SHARE` every payment/installment insert takes on the row. Under
    // it, eligibility is evaluated against the committed state the lock froze:
    // a concurrent receipt, return, payment or close attempt either lands before
    // the lock (and is seen) or waits (and never produces a stale approval).
    const completed = await this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      const locked = await this.documents.lockDocumentIn(actor.tenantId, tx, id);
      if (!locked) throw new NotFoundException('Purchase document not found');

      const current = await this.documents.readDocumentStatusIn(actor.tenantId, tx, id);
      if (!current) throw new NotFoundException('Purchase document not found');
      if (current.status === 'CLOSED') {
        throw new ConflictException({
          code: PURCHASE_COMPLETION_FAILURE.DOCUMENT_ALREADY_COMPLETED,
          message: 'This purchase document is already completed.',
        });
      }
      if (!canCompletePurchaseDocument(current.status, allowedFromStatuses)) {
        throw new ConflictException({
          code: PURCHASE_COMPLETION_FAILURE.STATUS_NOT_ALLOWED,
          message: `A purchase document in status ${current.status} may not be completed under the published policy (allowed: ${describeAllowedFromStatuses(allowedFromStatuses)}).`,
        });
      }

      // The unresolved-posting gate, now read under the same lock: the posting
      // table is the authoritative record (not a guess from receipt state), and
      // a raced PENDING read can only refuse conservatively, never permit.
      const lines = await this.receiving.listLines(actor.tenantId, id, tx);
      const unresolved = await this.postings.listUnresolvedForLines(
        actor.tenantId,
        lines.map((line) => line.id),
        tx
      );
      if (unresolved.length > 0) {
        throw new ConflictException({
          code: PURCHASE_COMPLETION_FAILURE.INTEGRATION_UNRESOLVED,
          message:
            `${unresolved.length} inventory posting(s) from this document are still unresolved ` +
            `(PENDING or FAILED); retry them through commerce/inventory-postings before completing.`,
        });
      }

      // The confirmed closure rule — fulfilment + settlement facts, then the ONE
      // evaluator. All facts are read in this transaction under the lock.
      const receipts = await this.receiving.listByDocument(actor.tenantId, id, tx);
      const receivedByLine = new Map<string, string[]>();
      for (const receipt of receipts) {
        for (const line of receipt.lines) {
          const bucket = receivedByLine.get(line.purchaseLineId);
          if (bucket) bucket.push(String(line.quantity));
          else receivedByLine.set(line.purchaseLineId, [String(line.quantity)]);
        }
      }

      const returnDocuments = await this.returns.listReturnDocuments(actor.tenantId, id, tx);
      const paidSum = await this.plans.sumPayments(actor.tenantId, id, tx);
      // W4-B: resolve every REFUNDED transition to its EXACT compensation row.
      // Post-W4-B rows carry `refundCompensationPaymentId` — the refund's own
      // ledger row. Legacy rows carry only `refundedPaymentId` (the original
      // payment): resolvable when that payment carries exactly ONE
      // compensation, ambiguous when several share it — a count the evaluator
      // refuses on rather than guesses.
      const refundedTransitions = returnDocuments
        .flatMap((row) => row.transitions)
        .filter((tr) => tr.state === 'REFUNDED');
      const legacyPaymentIds = [
        ...new Set(
          refundedTransitions
            .filter(
              (tr) =>
                tr.refundCompensationPaymentId == null &&
                typeof tr.refundedPaymentId === 'string'
            )
            .map((tr) => tr.refundedPaymentId as string)
        ),
      ];
      const paymentRows =
        refundedTransitions.length > 0
          ? await this.plans.listPayments(actor.tenantId, id, tx)
          : [];
      const compensationRows = paymentRows.filter((row) => row.reversesPaymentId !== null);
      let refundAmbiguous = false;
      // W4-D: an explicit link is only as good as the row it resolves to.
      // The row must be a COMPENSATION (negative, reversing something) of this
      // document — the DB unique index stops double-claiming but cannot stop
      // a transition naming an unrelated row; that link is invalid, and an
      // invalid link makes the payable unknowable, never "zero refunded".
      // A `refundedPaymentId` that disagrees with the resolved row's reversal
      // target is inconsistent the same way.
      const explicitAmounts = refundedTransitions.flatMap((tr) => {
        const link = tr.refundCompensationPaymentId;
        if (link == null) return [];
        const row = compensationRows.find((candidate) => candidate.id === link);
        if (!row || compareMoney(String(row.amount), '0.0000') >= 0) {
          refundAmbiguous = true;
          return [];
        }
        if (
          typeof tr.refundedPaymentId === 'string' &&
          tr.refundedPaymentId !== row.reversesPaymentId
        ) {
          refundAmbiguous = true;
          return [];
        }
        return [negateMoney(String(row.amount))];
      });
      const refundedAmount = sumMoney([
        ...explicitAmounts,
        // Legacy links — only when the named payment has ONE compensation, so
        // the link can resolve to exactly one row; two or more stays unknown.
        ...legacyPaymentIds.flatMap((paymentId) => {
          const rows = compensationRows.filter((row) => row.reversesPaymentId === paymentId);
          if (rows.length === 1) return [negateMoney(String(rows[0].amount))];
          if (rows.length > 1) refundAmbiguous = true;
          return [];
        }),
      ]);
      const planRows = await this.plans.listPlans(actor.tenantId, id, tx);
      const openInstallments = planRows
        .filter((plan) => plan.status === 'APPROVED')
        .flatMap((plan) => plan.installments)
        .filter((item) => item.status !== 'CANCELLED' && item.executedPaymentId === null);

      const facts: ClosureFacts = {
        lines: lines.map((line) => ({
          lineId: line.id,
          lineNumber: line.lineNumber,
          orderedQuantity: String(line.quantity),
          receivedQuantity: sumMoney(receivedByLine.get(line.id) ?? []),
        })),
        returns: returnDocuments.map((row) => ({
          returnId: row.id,
          state: projectReturnState(row.transitions),
        })),
        payment: {
          totalAmount: current.totalAmount === null ? null : String(current.totalAmount),
          paidAmount: paidSum === null ? '0.0000' : String(paidSum),
          refundedAmount,
          refundAmbiguous,
          openInstallmentAmount: sumMoney(openInstallments.map((item) => String(item.amount))),
          openInstallmentCount: openInstallments.length,
        },
      };

      const eligibility = evaluatePurchaseClosure(facts);
      if (!eligibility.eligible) {
        const first = eligibility.reasons[0];
        throw new ConflictException({
          code: first.code,
          message: `This purchase document cannot be completed: ${first.detail}`,
          // EVERY refusal, not just the first — the UI explains them all.
          reasons: eligibility.reasons,
        });
      }

      return this.documents.writeCompletedIn(
        actor.tenantId,
        tx,
        id,
        {
          fromStatuses: allowedFromStatuses as readonly PurchaseDocumentStatus[],
          fromStatus: current.status,
          completedByUserId: actor.userId,
          completedAt,
          completionPolicyVersionId: policy.id,
        },
        outbox
      );
    });

    if (!completed) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.WRITE_CONFLICT,
        message:
          'The purchase document left the statuses this policy permits while this request was being applied.',
      });
    }

    // PHASE W2-C (GAP-H): the lifecycle notification — the requester is the one
    // recipient this transition can name from authoritative state (the document's
    // own stored requester), told strictly AFTER the commit so a rolled-back
    // close never notifies. Dedup/tenant-assertion/failure policy are the
    // gateway's; a notification outage never marks a committed close as failed.
    await this.notification.notifyUsers(actor, [document.requesterId].filter(Boolean), {
      type: 'INFORMATION',
      title: `سند ${document.documentNumber} تکمیل و بسته شد`,
      body: `سند خرید شماره ${document.documentNumber} با موفقیت تکمیل شد.`,
      sourceType: 'purchase-document',
      sourceId: document.id,
    });

    return this.purchases.getOne(actor, completed.id);
  }
}
