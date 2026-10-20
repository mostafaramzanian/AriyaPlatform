import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';

/**
 * PHASE W3.2 — the traceability read set: the Commerce-owned rows the
 * aggregated purchase history correlates. READ-ONLY — this file never writes;
 * writers live in their own slice repositories.
 *
 * WHY A SEPARATE REPOSITORY: these reads cut across the receipt, return,
 * payment and posting tables for ONE purpose — assembling the document's
 * history — and none of them belongs to a single slice's contract. Keeping
 * them here keeps the slices' repositories honest about their own invariants
 * while this read answers "what is attached to this document?".
 */
@Injectable()
export class PurchaseHistoryRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /** The document's purchase line ids — the join key for its postings. */
  async listLineIds(tenantId: string, purchaseDocumentId: string) {
    const rows = await this.prisma.purchaseLine.findMany({
      where: { tenantId, purchaseDocumentId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** The document's receipts — ids correlate `commerce.receipt` audit events. */
  async listReceipts(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.receipt.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true, receivedAt: true, createdAt: true, receiverId: true },
    });
  }

  /**
   * The document's returns with their transition histories — ids correlate
   * `commerce.return_document` audit events, and the `REFUNDED` rows carry
   * `refundedPaymentId`, the persisted return→settlement link.
   */
  async listReturns(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.returnDocument.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      include: {
        transitions: {
          orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        },
      },
    });
  }

  /** The document's payment rows — ids, amounts and the reversal link. */
  async listPayments(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.paymentRecord.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: {
        id: true,
        amount: true,
        reversesPaymentId: true,
        method: true,
        recordedByUserId: true,
        paymentDate: true,
        createdAt: true,
      },
    });
  }

  /** The document's payment plans — ids correlate `commerce.payment_plan` audit events. */
  async listPlans(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.paymentPlan.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true, status: true, createdAt: true, requestedByUserId: true },
    });
  }

  /**
   * The document's inventory postings — the integration diagnostic stream:
   * status, attempt count, last error and the produced movement id. Scoped by
   * the document's own purchase lines (the posting's `purchaseLineId`).
   */
  async listPostings(tenantId: string, purchaseLineIds: readonly string[]) {
    if (purchaseLineIds.length === 0) return [];
    return this.prisma.inventoryPosting.findMany({
      where: { tenantId, purchaseLineId: { in: [...purchaseLineIds] } },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    });
  }

  /**
   * The append-only attempt rows of a set of postings — attempt granularity
   * the posting row's `attempts` counter only summarizes. The service
   * projects each row into the merged stream so every failure, retry and
   * duplicate answer is a named event, not a collapsed count.
   */
  async listAttempts(tenantId: string, postingIds: readonly string[]) {
    if (postingIds.length === 0) return [];
    return this.prisma.inventoryPostingAttempt.findMany({
      where: { tenantId, postingId: { in: [...postingIds] } },
      orderBy: [{ postingId: 'asc' }, { attempt: 'asc' }],
    });
  }

  /** The document's commercial assignments — ids correlate `commerce.commercial_assignment` audit events. */
  async listAssignments(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.commercialAssignment.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true },
    });
  }

  /** The document's commercial approvals — ids correlate `commerce.commercial_approval` audit events. */
  async listApprovals(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.commercialApproval.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true },
    });
  }

  /** The document's price quotations — ids correlate `commerce.price_quotation` audit events. */
  async listQuotations(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.priceQuotation.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true, version: true, status: true },
    });
  }
}
