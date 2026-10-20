import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { CommerceUnitOfWork } from '../database/commerce-transaction';
import { moneyFromNumber, multiplyMoney, sumMoney } from '../purchase/purchase-money';
import type { PurchaseDocumentStatus } from '../purchase/purchase-status';
import { SupplierRepository } from '../supplier/supplier.repository';
import type { IStorageProvider } from '../../../storage/i-storage.provider';
import {
  COMMERCE_MAX_ATTACHMENT_BYTES,
  QUOTATION_ATTACHMENT_KEY_PREFIX,
  QUOTATION_ATTACHMENT_MIME_TYPES,
  QUOTATION_FAILURE,
  QUOTATION_AUDIT_ACTION,
} from './quotation.constants';
import {
  QuotationVersionConflictError,
  QuotationRepository,
  type QuotationLineCreateData,
} from './quotation.repository';
import {
  canQuoteDocument,
  classifyPurchaseRouting,
  DEFAULT_PURCHASE_CASH_MAX_AMOUNT,
  QUOTATION_TARGET_OF,
  type PurchasePaymentRouting,
  type QuotationStatus,
} from './quotation';
import { CreatePriceQuotationDto, QuotationDecisionDto } from './quotation.dto';

/**
 * PHASE GAP-6: the price quotation's application layer — record a version, list
 * the trail, decide the pending one. The confirm/return LOOP is exactly this:
 * procurement records version N, the requester/group CONFIRMS it or RETURNS it
 * with a reason, and a correction is version N+1 — never an edit of a decided
 * row, so the evidence trail survives every round.
 *
 * REFUSALS, each a named 409 unless stated: the document must exist in this
 * tenant (404); it must still be in circulation (409 DOCUMENT_NOT_OPEN); exactly
 * ONE quotation may be PENDING per document (409 PENDING_EXISTS); a decision
 * addresses a PENDING quotation only (409 ALREADY_DECIDED); a RETURNED decision
 * carries the reason (400 RETURN_REASON_REQUIRED); races are answered by the
 * conditional write (409 VERSION_CONFLICT / WRITE_CONFLICT).
 *
 * WHAT THIS SERVICE MUST NEVER DO: write `PurchaseDocument.status`, read or
 * touch workflow / payment / receipt / return rows, or accept a tenant, actor,
 * version or status from a payload. A machine context (`userId: null`) is
 * refused outright: price evidence records a PERSON, and the columns are NOT
 * NULL for that reason. No segregation rule for quotation confirmation exists
 * in the source contracts — the deciding actor is RECORDED, not derived.
 *
 * MONEY: exact `Decimal(18,4)` text throughout — `multiplyMoney` per line,
 * `sumMoney` for the itemised total, `moneyFromNumber` for stated numbers —
 * never a float op, never a client-stated `lineTotal`.
 */
@Injectable()
export class QuotationService {
  constructor(
    private readonly repository: QuotationRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork,
    // GAP-6 follow-up: the GAP-9 user-notification surface. Injected as the GATEWAY
    // (never Core's NotificationService — gate I9), called strictly AFTER the unit of
    // work commits, failures swallowed by the gateway itself.
    private readonly notification: CommerceNotificationGateway,
    // GAP-6 follow-up (attachment upload, owner-authorized I19 boundary revision): the
    // platform's ONE storage seam, consumed here and nowhere else in Commerce. The
    // module header records the boundary; this constructor is its only injection.
    @Inject('IStorageProvider') private readonly storage: IStorageProvider,
    // SUPPLIER MASTER DATA: the optional `supplierId` on a quotation is checked
    // against the tenant's own directory rows through the OWNING slice's
    // repository — the application-layer cross-slice convention
    // `commercial-lifecycle.service.ts` establishes with `PurchaseRepository`.
    // No new persistence seam: the delegate read happens inside
    // `supplier.repository.ts` on its own model.
    private readonly suppliers: SupplierRepository
  ) {}

  /** The acting USER, or the one refusal a machine context cannot pass. */
  private static actingUserId(actor: CommerceActor): string {
    if (!actor.userId) {
      throw new ForbiddenException(
        'A quotation records the acting user; this request resolved to a machine context.'
      );
    }
    return actor.userId;
  }

  /**
   * The deployment's cash ceiling — `PURCHASE_CASH_MAX_AMOUNT`, falling back to
   * the provisional default. `env.validation.ts` validates the variable at boot;
   * this parse is defense-in-depth and never widens the cash band on garbage.
   */
  private static resolveCashMaxAmount(): number {
    const raw = process.env.PURCHASE_CASH_MAX_AMOUNT;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PURCHASE_CASH_MAX_AMOUNT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PURCHASE_CASH_MAX_AMOUNT;
  }

  private readonly cashMaxAmount = QuotationService.resolveCashMaxAmount();

  /**
   * `GET commerce/price-quotations?documentId=` — the document's whole
   * quotation trail, oldest version first, plus the document facts a client
   * needs to render the confirm/return affordances. A READ audits nothing.
   */
  async list(actor: CommerceActor, documentId: string) {
    const document = await this.repository.findDocument(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');

    const quotations = await this.repository.listByDocument(actor.tenantId, document.id);

    // CASH / NON-CASH ROUTING (§3.5): a read-time projection beside the trail,
    // computed from the LATEST CONFIRMED quotation's total — never from an
    // unpriced document total, never from an unconfirmed quote. A changed
    // threshold reclassifies FUTURE reads only; nothing stored is rewritten.
    const confirmed = [...quotations].reverse().find((row) => row.status === 'CONFIRMED') ?? null;
    const paymentRouting: PurchasePaymentRouting = {
      basis: 'confirmedQuotationTotal',
      cashMaxAmount: moneyFromNumber(this.cashMaxAmount),
      classification: classifyPurchaseRouting(
        confirmed?.totalAmount === null || confirmed?.totalAmount === undefined
          ? null
          : String(confirmed.totalAmount),
        this.cashMaxAmount
      ),
      sourceQuotationId: confirmed?.id ?? null,
    };

    return {
      document: { id: document.id, status: document.status },
      items: quotations.map(QuotationService.view),
      paymentRouting,
    };
  }

  /**
   * GAP-6 follow-up: the Notification Center row for a committed quotation act,
   * addressed to the authoritative owner resolved from the document/quote rows
   * and with the ACTOR excluded (the `support.service.ts` precedent: the person
   * who performed the act already knows they did). The gateway deduplicates,
   * asserts the tenant and swallows failures — a committed quotation is never
   * reported as failed over an absent alert.
   */
  private async notifyQuotationEvent(
    actor: CommerceActor,
    recipientUserIds: readonly string[],
    content: { title: string; body: string; quotationId: string }
  ): Promise<void> {
    await this.notification.notifyUsers(
      actor,
      recipientUserIds.filter((userId) => userId && userId !== actor.userId),
      {
        type: 'INFORMATION',
        title: content.title,
        body: content.body,
        sourceType: 'price-quotation',
        sourceId: content.quotationId,
      }
    );
  }

  /**
   * `POST commerce/price-quotations` — record ONE new version with its optional
   * itemisation, server-derived totals and its audit row, atomically.
   */
  async create(actor: CommerceActor, dto: CreatePriceQuotationDto) {
    const userId = QuotationService.actingUserId(actor);

    const document = await this.repository.findDocument(actor.tenantId, dto.purchaseDocumentId);
    if (!document) throw new NotFoundException('Purchase document not found');
    if (!canQuoteDocument(document.status as PurchaseDocumentStatus)) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.DOCUMENT_NOT_OPEN,
        message: `A purchase in status ${document.status} takes no new quotations.`,
      });
    }

    const pending = await this.repository.findPendingByDocument(actor.tenantId, document.id);
    if (pending) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.PENDING_EXISTS,
        message: `Quotation version ${pending.version} is still awaiting a decision.`,
      });
    }

    // The two entry modes are mutually exclusive by construction: itemised
    // lines DERIVE the total; a stated total is only the scan-only mode's
    // evidence. Refusing the combination beats silently preferring one.
    if (dto.lines && dto.lines.length > 0 && dto.totalAmount !== undefined) {
      throw new BadRequestException({
        code: QUOTATION_FAILURE.TOTAL_MODE_CONFLICT,
        message: 'State either itemised lines or a stated total, never both.',
      });
    }

    // SUPPLIER DIRECTORY: a stated `supplierId` must name a row of THIS
    // tenant's directory — the opaque column predates the directory, and this
    // write-time check is what keeps it honest without a cross-database join.
    if (dto.supplierId !== undefined) {
      const supplier = await this.suppliers.findSupplierById(actor.tenantId, dto.supplierId);
      if (!supplier) {
        throw new BadRequestException({
          code: QUOTATION_FAILURE.SUPPLIER_UNKNOWN,
          message: 'The stated supplierId names no supplier of this tenant.',
        });
      }
    }

    const lines: QuotationLineCreateData[] = (dto.lines ?? []).map((line, index) => ({
      lineNumber: index + 1,
      description: line.description,
      quantity: moneyFromNumber(line.quantity, 'quantity'),
      unitPrice: moneyFromNumber(line.unitPrice, 'unitPrice'),
      lineTotal: multiplyMoney(line.quantity, line.unitPrice),
    }));
    const totalAmount =
      lines.length > 0
        ? sumMoney(lines.map((line) => line.lineTotal))
        : dto.totalAmount !== undefined
          ? moneyFromNumber(dto.totalAmount, 'totalAmount')
          : null;

    const created = await this.unitOfWork
      .run((tx) =>
        this.repository.createQuotation(
          actor.tenantId,
          {
            purchaseDocumentId: document.id,
            supplierLabel: dto.supplierLabel ?? null,
            supplierId: dto.supplierId ?? null,
            quoteReference: dto.quoteReference ?? null,
            quoteDate: dto.quoteDate ? new Date(dto.quoteDate) : null,
            currency: dto.currency ?? null,
            totalAmount,
            attachmentRef: dto.attachmentRef ?? null,
            notes: dto.notes ?? null,
            createdByUserId: userId,
          },
          lines,
          (quotationId: string) =>
            this.audit.buildOutboxPayload(actor, {
              action: QUOTATION_AUDIT_ACTION.CREATED,
              resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
              resourceId: quotationId,
              newValue: {
                purchaseDocumentId: document.id,
                status: 'PENDING',
                totalAmount,
                lineCount: lines.length,
              },
            }),
          tx
        )
      )
      .catch((error: unknown) => {
        if (!(error instanceof QuotationVersionConflictError)) throw error;
        throw new ConflictException({
          code: QUOTATION_FAILURE.VERSION_CONFLICT,
          message: 'Another quotation version was recorded for this document at the same moment.',
        });
      });

    // AFTER the commit: the requester learns a new version awaits their decision
    // (or, for a corrected version, that the correction loop advanced). The actor
    // is excluded by the helper — a recorder recording their own quote gets no
    // self-alert.
    await this.notifyQuotationEvent(actor, [document.requesterId], {
      title: `استعلام جدید برای سند ${document.documentNumber}`,
      body: `نسخه ${created.version} استعلام برای سند خرید ${document.documentNumber} ثبت شد و منتظر تصمیم شماست.`,
      quotationId: created.id,
    });

    return QuotationService.view(created);
  }

  /**
   * `POST commerce/price-quotations/:id/decision` — CONFIRM or RETURN the
   * pending quotation. The write is the conditional PENDING move, so a racing
   * second decision is one winner and one 409; the audit outbox row travels
   * inside the same transaction.
   */
  async decide(actor: CommerceActor, id: string, dto: QuotationDecisionDto) {
    const userId = QuotationService.actingUserId(actor);

    const quotation = await this.repository.findQuotationById(actor.tenantId, id);
    if (!quotation) throw new NotFoundException('Price quotation not found');

    const documentStatus = quotation.purchaseDocument.status as PurchaseDocumentStatus;
    if (!canQuoteDocument(documentStatus)) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.DOCUMENT_NOT_OPEN,
        message: `A purchase in status ${quotation.purchaseDocument.status} takes no quotation decisions.`,
      });
    }

    if (quotation.status !== 'PENDING') {
      throw new ConflictException({
        code: QUOTATION_FAILURE.ALREADY_DECIDED,
        message: `This quotation was already decided (${quotation.status}).`,
      });
    }

    // SEPARATION OF DUTIES (3.2): the recorder never decides their own price.
    // Safe narrowing — it only ever refuses a subset of what the permission already
    // allowed, and no approver role is invented: any OTHER holder of
    // `commerce.commercial.manage` (requester side, liaison, manager) may decide.
    if (quotation.createdByUserId === userId) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.SELF_DECISION,
        message:
          'You recorded this quotation version; confirming or returning your own quotation is not allowed.',
      });
    }

    const target: QuotationStatus = QUOTATION_TARGET_OF[dto.decision];
    const comment = dto.comment?.trim() || null;
    if (target === 'RETURNED' && !comment) {
      throw new BadRequestException({
        code: QUOTATION_FAILURE.RETURN_REASON_REQUIRED,
        message: 'A RETURNED decision must state the reason for the correction.',
      });
    }

    // SCAN-BASED CONFIRMATION REQUIRES THE SCAN (3.2 requirement): a scan-only
    // quotation (a stated total, NO itemised lines) is its own evidence, so
    // confirming it without an attached document would accept a number nobody
    // can evidence. Itemised quotations confirm without a scan — their evidence
    // is the lines — and a RETURN is unaffected (correction must stay possible
    // while the missing scan is being produced).
    if (target === 'CONFIRMED' && quotation.lines.length === 0 && !quotation.attachmentRef) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.SCAN_ATTACHMENT_REQUIRED,
        message:
          'This quotation states a total without itemised lines; upload its scanned document before confirming.',
      });
    }

    const decidedAt = new Date();
    // ROUTING AUDIT (§3.5): a CONFIRMED decision is the moment the cash/non-cash
    // classification is decided — the confirmed total, the threshold it compared
    // against and the result travel INSIDE the audit payload, so a later config
    // change (a different PURCHASE_CASH_MAX_AMOUNT) can never rewrite the
    // historical explanation of why this document routed the way it did.
    const routing =
      target === 'CONFIRMED'
        ? {
            basis: 'confirmedQuotationTotal',
            cashMaxAmount: moneyFromNumber(this.cashMaxAmount),
            classification: classifyPurchaseRouting(
              quotation.totalAmount === null || quotation.totalAmount === undefined
                ? null
                : String(quotation.totalAmount),
              this.cashMaxAmount
            ),
          }
        : null;
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: QUOTATION_AUDIT_ACTION.DECIDED,
      resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
      resourceId: quotation.id,
      oldValue: { status: 'PENDING' },
      newValue: { status: target, paymentRouting: routing },
      reason: comment,
    });

    const decided = await this.unitOfWork.run((tx) =>
      this.repository.decideQuotationIn(
        actor.tenantId,
        quotation.id,
        {
          status: target,
          decidedByUserId: userId,
          decidedAt,
          decisionComment: comment,
        },
        outbox,
        tx
      )
    );

    if (!decided) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.WRITE_CONFLICT,
        message: 'This quotation was decided by another actor while this request was being applied.',
      });
    }

    // AFTER the commit: the recorder learns their price was confirmed or must be
    // corrected, and — for a confirmation — the requester learns the price side is
    // settled. The actor is excluded by the helper; a RETURN carries its reason.
    const documentNumber = quotation.purchaseDocument.documentNumber;
    if (target === 'CONFIRMED') {
      await this.notifyQuotationEvent(
        actor,
        [quotation.createdByUserId, quotation.purchaseDocument.requesterId],
        {
          title: `استعلام سند ${documentNumber} تأیید شد`,
          body: `نسخه ${quotation.version} استعلام سند خرید ${documentNumber} تأیید شد.`,
          quotationId: quotation.id,
        }
      );
    } else {
      await this.notifyQuotationEvent(actor, [quotation.createdByUserId], {
        title: `استعلام سند ${documentNumber} برای اصلاح برگشت داده شد`,
        body: `نسخه ${quotation.version} استعلام سند خرید ${documentNumber} برای اصلاح برگشت داده شد. دلیل: ${comment ?? ''}`.trim(),
        quotationId: quotation.id,
      });
    }

    return QuotationService.view(decided);
  }

  /**
   * `POST commerce/price-quotations/:id/attachment` (multipart) — attach the
   * scanned document to THIS PENDING version. GAP-6 follow-up 3.3, the one
   * place Commerce touches object storage.
   *
   * ORDER OF OPERATIONS (the 50 correspondence contract, financial F1's proof):
   * validate everything that can be validated BEFORE touching storage; write the
   * OBJECT; make the conditional ROW write; if the row write loses a race,
   * delete the object again (best-effort, logged) and answer the named 409. A
   * storage failure at step one is a typed 500 and no row exists. Replacing an
   * earlier upload deletes the previous object best-effort AFTER the row no
   * longer names it — an orphaned old object is inert; a row naming a deleted
   * object would be a dead download.
   *
   * WHAT IT MUST NEVER DO: accept a decided row (immutability — 409
   * ALREADY_DECIDED), accept a tenant/actor from the body (server-resolved),
   * or let the storage key reach the wire (the view projects booleans).
   */
  async uploadAttachment(
    actor: CommerceActor,
    id: string,
    file: {
      originalname?: string;
      mimetype?: string;
      size?: number;
      buffer?: Buffer;
    } | undefined
  ) {
    QuotationService.actingUserId(actor);

    const quotation = await this.repository.findQuotationById(actor.tenantId, id);
    if (!quotation) throw new NotFoundException('Price quotation not found');

    if (quotation.status !== 'PENDING') {
      throw new ConflictException({
        code: QUOTATION_FAILURE.ALREADY_DECIDED,
        message: `A decided quotation's evidence trail is immutable (${quotation.status}).`,
      });
    }

    if (!file || !file.buffer) {
      throw new BadRequestException({
        code: QUOTATION_FAILURE.FILE_REQUIRED,
        message: 'An upload requires a file part named "file".',
      });
    }
    if (typeof file.size === 'number' && file.size > COMMERCE_MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException({
        code: QUOTATION_FAILURE.FILE_TOO_LARGE,
        message: `An attachment may not exceed ${COMMERCE_MAX_ATTACHMENT_BYTES} bytes.`,
      });
    }
    const mimeType = file.mimetype ?? 'application/octet-stream';
    if (!QUOTATION_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException({
        code: QUOTATION_FAILURE.FILE_TYPE_NOT_ALLOWED,
        message: `The MIME type "${mimeType}" is not an allowed attachment type.`,
      });
    }
    // Captured once: the narrowing above must survive the transaction callback.
    const buffer: Buffer = file.buffer;
    const sizeBytes = file.size ?? buffer.length;

    const fileName = QuotationService.safeAttachmentFileName(file.originalname);
    const storageKey = `${QUOTATION_ATTACHMENT_KEY_PREFIX}${actor.tenantId}/price-quotations/${quotation.id}/${randomUUID()}-${fileName}`;
    const previousRef = quotation.attachmentRef;

    // OBJECT FIRST — a row that names a missing object would be a dead link the
    // moment anything listed it.
    try {
      await this.storage.upload(storageKey, buffer, mimeType);
    } catch (error) {
      throw new InternalServerErrorException({
        code: QUOTATION_FAILURE.STORAGE_UPLOAD_FAILED,
        message: 'The attachment could not be stored; please retry.',
        cause: error instanceof Error ? error.message : undefined,
      });
    }

    let attached: Awaited<ReturnType<typeof this.repository.attachAttachmentRefIn>>;
    try {
      attached = await this.unitOfWork.run((tx) =>
        this.repository.attachAttachmentRefIn(
          actor.tenantId,
          quotation.id,
          storageKey,
          this.audit.buildOutboxPayload(actor, {
            action: QUOTATION_AUDIT_ACTION.ATTACHMENT_UPLOADED,
            resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
            resourceId: quotation.id,
            newValue: {
              fileName,
              mimeType,
              size: sizeBytes,
              replaced: previousRef !== null,
            },
          }),
          tx
        )
      );
    } catch (error) {
      // ROW FAILED → remove the object. Best-effort: a leftover object with no
      // row is inert (no read can reach it); surfacing a second failure would
      // hide the FIRST one.
      await this.deleteAttachmentObjectBestEffort(storageKey, quotation.id);
      throw error;
    }

    if (!attached) {
      // The row left PENDING between the read and the write: a concurrent
      // decision won, and a decided row's evidence never changes. The object
      // we just wrote is removed so nothing dangles.
      await this.deleteAttachmentObjectBestEffort(storageKey, quotation.id);
      throw new ConflictException({
        code: QUOTATION_FAILURE.WRITE_CONFLICT,
        message: 'This quotation was decided while the file uploaded; re-read it before retrying.',
      });
    }

    // REPLACEMENT: the row no longer names the previous object — remove it now,
    // best-effort. Only objects THIS module wrote are ever deleted (a
    // client-stated external reference is not ours to touch).
    if (
      previousRef &&
      previousRef !== storageKey &&
      previousRef.startsWith(QUOTATION_ATTACHMENT_KEY_PREFIX)
    ) {
      await this.deleteAttachmentObjectBestEffort(previousRef, quotation.id);
    }

    return QuotationService.view(attached);
  }

  /**
   * `GET commerce/price-quotations/:id/attachment` — resolve this quotation's
   * uploaded object to a SHORT-LIVED SIGNED URL through the same storage seam
   * (`IStorageProvider.getUrl`), plus the file name for a label. A READ (the
   * evidence is reviewable in every state), tenant-scoped like every other read.
   *
   * WHAT NEVER LEAVES THE SERVER: the storage key itself, and any permanent URL.
   * A client-stated external reference (create DTO) is not resolvable here — it
   * is the org's own handle — and answers the named 409 rather than a signed
   * URL for an object that does not exist.
   */
  async attachmentDownload(actor: CommerceActor, id: string) {
    const quotation = await this.repository.findQuotationById(actor.tenantId, id);
    if (!quotation) throw new NotFoundException('Price quotation not found');

    const ref = quotation.attachmentRef;
    if (!ref) {
      throw new NotFoundException({
        code: QUOTATION_FAILURE.ATTACHMENT_NOT_RESOLVABLE,
        message: 'This quotation has no uploaded attachment.',
      });
    }
    if (!ref.startsWith(QUOTATION_ATTACHMENT_KEY_PREFIX)) {
      throw new ConflictException({
        code: QUOTATION_FAILURE.ATTACHMENT_NOT_RESOLVABLE,
        message:
          'This attachment is an external reference; it is not stored by this deployment and cannot be opened here.',
      });
    }

    const fileName = QuotationService.keyFileName(ref);
    const url = await this.storage.getUrl(ref, { fileName, expirySeconds: 300 });
    return { url, fileName };
  }

  /** Sanitized basename — path separators and control characters can never survive. */
  private static safeAttachmentFileName(original: string | undefined): string {
    const base = (original ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base
      .replace(/[^\w.\- ]+/g, '_')
      .trim()
      .slice(0, 120);
    return cleaned || 'attachment';
  }

  /** The last path segment of a key we wrote — its sanitized file name. */
  private static keyFileName(key: string): string {
    return key.split('/').pop() ?? 'attachment';
  }

  /**
   * Best-effort object cleanup: a failure here is LOGGED, never surfaced — the
   * first failure (or the act itself) is what the caller must hear, and an
   * orphaned object is inert (no row names it anymore). Keys are server-internal
   * and deliberately kept out of the log line.
   */
  private async deleteAttachmentObjectBestEffort(key: string, quotationId: string) {
    try {
      await this.storage.delete(key);
    } catch (error) {
      console.warn(
        `quotation attachment object cleanup failed for quotation ${quotationId}`,
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  /**
   * The wire projection — the row's own facts, stated explicitly so `tenantId`
   * and any server-only column can never reach a body by omission of thought
   * (the payment slice's own rule). Money is the exact stored `Decimal(18,4)`
   * STRING, never a number.
   */
  private static view(row: {
    id: string;
    purchaseDocumentId: string;
    version: number;
    supplierLabel: string | null;
    supplierId: string | null;
    quoteReference: string | null;
    quoteDate: Date | null;
    currency: string | null;
    totalAmount: unknown;
    attachmentRef: string | null;
    notes: string | null;
    status: string;
    createdByUserId: string;
    decidedByUserId: string | null;
    decidedAt: Date | null;
    decisionComment: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines: {
      id: string;
      lineNumber: number;
      description: string;
      quantity: unknown;
      unitPrice: unknown;
      lineTotal: unknown;
    }[];
  }) {
    return {
      id: row.id,
      purchaseDocumentId: row.purchaseDocumentId,
      version: row.version,
      supplierLabel: row.supplierLabel,
      supplierId: row.supplierId,
      quoteReference: row.quoteReference,
      quoteDate: row.quoteDate,
      currency: row.currency,
      totalAmount: row.totalAmount === null ? null : String(row.totalAmount),
      // ATTACHMENT, PROJECTED HONESTLY (3.3): the raw `attachmentRef` may be a
      // server-internal storage key — it NEVER reaches the wire. The booleans
      // state what a client can act on: an attachment exists, and whether THIS
      // deployment can resolve it to a signed URL (vs a client-stated external
      // reference the org manages itself).
      hasAttachment: row.attachmentRef !== null,
      attachmentDownloadable:
        row.attachmentRef !== null &&
        row.attachmentRef.startsWith(QUOTATION_ATTACHMENT_KEY_PREFIX),
      notes: row.notes,
      status: row.status,
      createdByUserId: row.createdByUserId,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      decisionComment: row.decisionComment,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lines: row.lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        description: line.description,
        quantity: String(line.quantity),
        unitPrice: String(line.unitPrice),
        lineTotal: String(line.lineTotal),
      })),
    };
  }
}
