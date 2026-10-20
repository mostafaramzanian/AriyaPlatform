import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/commerce-client';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type { QuotationStatus } from './quotation';

/**
 * PHASE GAP-6: the price-quotation persistence boundary — every statement this
 * slice issues against `commerce_db`, and nothing else.
 *
 * WHY ITS OWN REPOSITORY (the Q/R/S reasoning, one more time): `PriceQuotation`
 * is a child lifecycle with its OWN conditional write (the PENDING decision) and
 * its own version race; the purchase repository owns the document's transitions
 * and must not grow a second family of them.
 *
 * THE VERSION RACE IS ANSWERED HERE, NOT BY A READ: `createQuotation` computes
 * `max(version)+1` inside the caller's transaction and lets the
 * `(tenantId, purchaseDocumentId, version)` unique index refuse a concurrent
 * duplicate — the driver's P2002 is translated into this module's
 * `QuotationVersionConflictError` so the service answers 409 without importing a
 * driver type (the `PaymentCompensationTakenError` precedent).
 *
 * THE DECISION IS ONE CONDITIONAL `updateMany` carrying `status: 'PENDING'` in
 * its WHERE: a second decision — raced by another actor — matches nothing and
 * the service answers 409 `WRITE_CONFLICT`. One winner, one refusal, no silent
 * success.
 *
 * TENANCY: `tenantId` is the first parameter of every method and appears in every
 * `where`. `findUnique` is never used (it cannot carry a tenant predicate — the
 * module-wide D5 rule). The parent DOCUMENT is READ here (`reads:
 * ['purchaseDocument']`) — the same cross-slice seam payment and receiving use —
 * and never written: quotations never move `PurchaseDocument.status`.
 */
export class QuotationVersionConflictError extends Error {
  constructor() {
    super('A quotation with this version already exists for the document');
    this.name = 'QuotationVersionConflictError';
  }
}

/** Prisma's unique-violation code, answered structurally rather than by message text. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** The document facts a quotation act needs — status is the guard, the number and
 *  requester address the notifications this slice emits after its commits. */
export interface QuotationDocumentFacts {
  readonly id: string;
  readonly status: string;
  readonly documentNumber: string;
  readonly requesterId: string;
}

/** One line as `createQuotation` stores it — money already rendered exact. */
export interface QuotationLineCreateData {
  readonly lineNumber: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

/** The row facts `createQuotation` stores — every money value an exact string. */
export interface QuotationCreateData {
  readonly purchaseDocumentId: string;
  readonly supplierLabel: string | null;
  /** The supplier directory id the service VALIDATED, or NULL — never an
   *  unverified string (the C1 opaque-column convention predates the directory;
   *  this column is service-checked at write time). */
  readonly supplierId: string | null;
  readonly quoteReference: string | null;
  readonly quoteDate: Date | null;
  readonly currency: string | null;
  readonly totalAmount: string | null;
  readonly attachmentRef: string | null;
  readonly notes: string | null;
  readonly createdByUserId: string;
}

/** The decision facts the conditional write records, server-resolved. */
export interface QuotationDecisionData {
  readonly status: QuotationStatus;
  readonly decidedByUserId: string;
  readonly decidedAt: Date;
  readonly decisionComment: string | null;
}

/** The line include every quotation read returns, ordered by position. */
const LINES_INCLUDE = { lines: { orderBy: [{ lineNumber: 'asc' as const }] } };

@Injectable()
export class QuotationRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /** The document's `{id, status, documentNumber, requesterId}` or `null` —
   *  cross-tenant and absent are one answer. */
  async findDocument(tenantId: string, documentId: string): Promise<QuotationDocumentFacts | null> {
    return this.prisma.purchaseDocument.findFirst({
      where: { tenantId, id: documentId },
      select: { id: true, status: true, documentNumber: true, requesterId: true },
    });
  }

  /** One document's quotations, oldest version first — the whole evidence trail. */
  async listByDocument(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.priceQuotation.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ version: 'asc' }, { id: 'asc' }],
      include: LINES_INCLUDE,
    });
  }

  /** The document's PENDING quotation, if one exists — the "one live price" guard. */
  async findPendingByDocument(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.priceQuotation.findFirst({
      where: { tenantId, purchaseDocumentId, status: 'PENDING' },
      select: { id: true, version: true },
    });
  }

  /** One quotation with its lines and its document's status/number/requester, or `null`. */
  async findQuotationById(tenantId: string, id: string) {
    return this.prisma.priceQuotation.findFirst({
      where: { tenantId, id },
      include: {
        ...LINES_INCLUDE,
        purchaseDocument: {
          select: { id: true, status: true, documentNumber: true, requesterId: true },
        },
      },
    });
  }

  /**
   * Insert ONE version (with its lines) and its audit outbox row, in the
   * CALLER's transaction — the module's `unwrapCommerceTransaction` convention,
   * so the unit of work the service opened carries the whole act. The outbox is
   * built by a BUILDER because the audit `resourceId` is the row's own id, which
   * only exists after the insert (the HR employment `buildOutbox(created.id)`
   * precedent). A version collision surfaces as `QuotationVersionConflictError`;
   * anything else is rethrown untouched.
   */
  async createQuotation(
    tenantId: string,
    data: QuotationCreateData,
    lines: readonly QuotationLineCreateData[],
    buildOutbox: (quotationId: string) => CommerceAuditOutboxPayload,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);

    const aggregate = await client.priceQuotation.aggregate({
      where: { tenantId, purchaseDocumentId: data.purchaseDocumentId },
      _max: { version: true },
    });
    const version = (aggregate._max.version ?? 0) + 1;

    try {
      const row = await client.priceQuotation.create({
        data: {
          tenantId,
          ...data,
          version,
          lines: {
            // NOTE: NO `tenantId` here — the relation to the parent quotation is
            // composite `(tenant_id, quotation_id)`, so Prisma INHERITS the shared
            // tenant field from the parent create. Stating it again is rejected by
            // the generated input (`Unknown argument 'tenantId'`) — the same
            // inheritance `receiving-history.repository.ts` documents for receipt
            // lines, and what makes a line under another tenant's quotation not
            // expressible even as a statement in this file.
            create: lines.map((line) => ({ ...line })),
          },
        },
        include: LINES_INCLUDE,
      });
      await client.auditOutbox.create({ data: buildOutbox(row.id) });
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new QuotationVersionConflictError();
      throw error;
    }
  }

  /**
   * The ONE decision write: move THIS quotation from PENDING, record the
   * server-resolved actor/timestamp/comment, and append the audit outbox row —
   * all inside the caller's transaction. `null` means the conditional write
   * matched nothing (a concurrent decision won); the row is read back through
   * the same client so the answer describes the moment the write landed.
   */
  async decideQuotationIn(
    tenantId: string,
    id: string,
    decision: QuotationDecisionData,
    outbox: CommerceAuditOutboxPayload,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);

    const result = await client.priceQuotation.updateMany({
      where: { tenantId, id, status: 'PENDING' },
      data: {
        status: decision.status,
        decidedByUserId: decision.decidedByUserId,
        decidedAt: decision.decidedAt,
        decisionComment: decision.decisionComment,
      },
    });
    if (result.count === 0) return null;

    await client.auditOutbox.create({ data: outbox });
    return client.priceQuotation.findFirst({
      where: { tenantId, id },
      include: LINES_INCLUDE,
    });
  }

  /**
   * GAP-6 follow-up (attachment upload): bind the uploaded object's key to THIS
   * PENDING quotation — one conditional write (same predicate family as the
   * decision: a decided row is immutable), its audit outbox row in the caller's
   * transaction, and the row read back through the same client. `null` means the
   * row left PENDING between the read and the write (a concurrent decision won);
   * the caller deletes the already-written object and answers the named 409.
   */
  async attachAttachmentRefIn(
    tenantId: string,
    id: string,
    attachmentRef: string,
    outbox: CommerceAuditOutboxPayload,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);

    const result = await client.priceQuotation.updateMany({
      where: { tenantId, id, status: 'PENDING' },
      data: { attachmentRef },
    });
    if (result.count === 0) return null;

    await client.auditOutbox.create({ data: outbox });
    return client.priceQuotation.findFirst({
      where: { tenantId, id },
      include: LINES_INCLUDE,
    });
  }
}
