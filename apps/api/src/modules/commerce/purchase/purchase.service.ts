import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceIdentityGateway, type DirectoryUserProfile } from '../commerce-identity.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { CommerceSearchSourceService } from '../search/commerce-search-source.service';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { addMoney, moneyFromNumber, multiplyMoney, sumMoney } from './purchase-money';
import {
  PURCHASE_DOCUMENT_KINDS,
  canTransitionPurchaseDocument,
  isPurchaseDocumentEditable,
} from './purchase-status';
import type { PurchaseDocumentStatus } from './purchase-status';
import { PurchaseRepository } from './purchase.repository';
import type { PurchaseDocumentTotals, PurchaseLineWrite } from './purchase.repository';
import { CommerceUnitOfWork } from '../database/commerce-transaction';
import { CommercialLifecycleService } from '../commercial/commercial-lifecycle.service';
import { WorkflowLineRoutingService } from '../workflow/workflow-line-routing.service';
import type {
  CreatePurchaseDocumentDto,
  ListPurchaseDocumentsQueryDto,
  PurchaseLineInputDto,
  UpdatePurchaseDocumentDto,
} from './purchase.dto';

/**
 * Phase C1 Step L (§5.1, §5.2, §8, §5.11): the purchase document slice's application
 * surface — create, read, list, update-while-editable and submit.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * ----------------------------------------
 * It owns ORCHESTRATION: it translates a DTO into domain facts (positions, derived line
 * totals, the document's priced-or-not totals), asks the pure modules whether an act is
 * allowed, resolves the identities a caller may reference and the names a page renders,
 * and records the ONE platform trail and the ONE event stream. It issues NO raw Prisma
 * queries and holds no client — persistence is `PurchaseRepository`'s, which is what
 * keeps the tenant predicate, the atomic numbering and the conditional status writes in
 * a single reviewable file.
 *
 * THE TENANT COMES FROM THE ACTOR, ALWAYS. Every method takes `CommerceActor` and
 * passes `actor.tenantId` as the repository's first argument. No DTO carries a tenant
 * field, no method accepts one, and no lookup is by id alone — so there is no shape of
 * these routes that reads another tenant's document.
 *
 * IDENTITY IS REACHED THROUGH THE GATEWAY, NEVER DIRECTLY (§I7). Two needs: "is this a
 * member of my tenant?" before a requester id is STORED (`assertMember`, on create and
 * on an edit that moves the requester), and "what is this person called?" when a
 * document is RENDERED (`profilesFor`, batched once per page). Both are the gateway's,
 * and gate I7's scan is what keeps a second path from appearing here.
 *
 * THE ACTOR'S `userId` IS DELIBERATELY NOT THE REQUESTER. "Who asked for this" is a
 * field of the request — a delegate may raise a request for somebody else, and a script
 * may raise one for a person — so the requester is STATED by the caller and VERIFIED
 * against the tenant, never inferred from the session. The session's identity is what
 * the audit trail and the event stream attribute the act to — so a request records WHO
 * acted and WHO it was raised for, and the two are separate fields on purpose.
 *
 * ONE TRAIL AND ONE STREAM, AND ONLY AFTER A WRITE SUCCEEDED. Both gateways are handed
 * the document the repository RETURNED, never the intent that produced it: a trail
 * recording what a caller meant to write would disagree with `commerce_db` the first
 * time a conditional write refused one. Neither call decides anything — the write is
 * already committed by then — and neither can turn a completed mutation into a failure:
 * `CommerceAuditGateway` logs and swallows, and the platform's publisher treats delivery
 * as best-effort.
 */

/**
 * The Commerce purchase event vocabulary, declared HERE because this is the step that
 * emits the first one.
 *
 * `commerce-notification.gateway.ts` records why it carries no union of its own: the
 * event vocabulary belongs next to the rule that produces each event, so a literal can
 * be read with the reason it exists. Today exactly one event is emitted — a document
 * entering the workflow — and the steps that decide, cancel or complete documents add
 * theirs beside the code that emits them.
 *
 * The name is `commerce.` + the aggregate + the act, spelled like the audit resource
 * for the same aggregate (`commerce.purchase_document`), so one search answers
 * "everything that happened to this document" across both streams.
 */
export const COMMERCE_PURCHASE_EVENT = {
  SUBMITTED: 'commerce.purchase_document.submitted',
} as const;

/**
 * The audit `action` values this slice records.
 *
 * Lowercase verbs, like `HR_AUDIT_ACTION` — the platform trail is queried by
 * `(resource, action)`, and a Commerce slice spelling the same act `SUBMIT` while HR
 * spells it `submit` would make the trail answer differently depending on which module
 * wrote the row.
 */
export const PURCHASE_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  SUBMIT: 'submit',
} as const;

/** One document as the repository returns it, labels included. */
type PurchaseDocumentRecord = NonNullable<
  Awaited<ReturnType<PurchaseRepository['findDocumentById']>>
>;

/** One line as the repository returns it. */
type PurchaseLineRecord = PurchaseDocumentRecord['lines'][number];

/**
 * The document's totals, derived from its lines — the rule, in one place.
 *
 * PRICED OR NOT PRICED, WITH NOTHING IN BETWEEN. §5.1 says the totals are Σ `lineTotal`
 * and subtotal + tax, and that NULL means "not stated yet", never zero. A line whose
 * `unitPrice` was not stated has no `lineTotal`, and a sum that skipped it would be a
 * number claiming "these are the totals" while omitting a line somebody asked for. So
 * the document states its totals only when EVERY line is priced (both `lineTotal` and
 * `tax`); otherwise all three stay NULL, which is the honest reading of "not priced
 * yet". ZERO IS NOT THE FALLBACK: a document of free items totals `0.0000` because its
 * lines say so, and a document nobody has priced totals nothing at all.
 *
 * NO CURRENCY IS REQUIRED. The schema allows `currency` to be NULL beside non-null
 * amounts and states that it has no default on purpose — so this function does not
 * invent a currency-required rule the storage contract deliberately does not have.
 *
 * ZERO LINES IS NOT "FREE": an empty line set prices nothing, so it yields NULL totals
 * rather than `0.0000`. The DTO refuses an empty array anyway, and this guard is what
 * keeps an internal caller from reaching the other answer by bypassing the DTO.
 */
export function computeDocumentTotals(lines: readonly PurchaseLineWrite[]): PurchaseDocumentTotals {
  if (lines.length === 0) {
    return { subtotalAmount: null, taxAmount: null, totalAmount: null };
  }

  const priced = lines.every((line) => line.lineTotal !== null && line.tax !== null);
  if (!priced) {
    return { subtotalAmount: null, taxAmount: null, totalAmount: null };
  }

  const subtotalAmount = sumMoney(lines.map((line) => line.lineTotal as string));
  const taxAmount = sumMoney(lines.map((line) => line.tax as string));

  return { subtotalAmount, taxAmount, totalAmount: addMoney(subtotalAmount, taxAmount) };
}

@Injectable()
export class PurchaseService {
  constructor(
    private readonly repository: PurchaseRepository,
    private readonly identity: CommerceIdentityGateway,
    private readonly audit: CommerceAuditGateway,
    private readonly notification: CommerceNotificationGateway,
    // PHASE C9 (GAP-5): the search projection push. It sits beside the audit gateway and
    // the notification gateway because it is the same kind of dependency — a platform
    // surface this module feeds AFTER a write commits, whose failure must never change
    // the answer (the adapter swallows and logs; see its own file).
    private readonly search: CommerceSearchSourceService,
    private readonly unitOfWork: CommerceUnitOfWork,
    private readonly lineRouting: WorkflowLineRoutingService,
    private readonly commercial: CommercialLifecycleService
  ) {}

  /**
   * Create a purchase request (§8's "create").
   *
   * THE REQUESTER IS VERIFIED BEFORE IT IS STORED. `assertMember` is the only check that
   * a Core identity belongs to the ACTING tenant, and it has to happen before the write:
   * once an id is in `commerce_db`, nothing inside this database can tell whose tenant
   * it came from — the column is an opaque string with no referential constraint at all
   * (there is no FK across databases, by design).
   *
   * ONE write, ONE audit row, and the created document as the answer — including the
   * `documentNumber` the database minted inside the same transaction. The number is
   * never accepted from the caller; see `PurchaseRepository`.
   */
  async create(actor: CommerceActor, dto: CreatePurchaseDocumentDto) {
    await this.identity.assertMember(actor, dto.requesterId);

    const lines = this.toLineWrites(dto.lines);
    const totals = computeDocumentTotals(lines);

    const document = await this.repository.createDocument(actor.tenantId, {
      // The only member of the closed vocabulary. A second kind arrives as a migration
      // plus the surface that mints it, never as a client field that silently starts a
      // second counter series.
      kind: PURCHASE_DOCUMENT_KINDS[0],
      requesterId: dto.requesterId,
      supplierId: dto.supplierId ?? null,
      currency: dto.currency ?? null,
      totals,
      lines,
    });

    await this.audit.record(actor, {
      action: PURCHASE_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: document.id,
      newValue: {
        documentNumber: document.documentNumber,
        kind: document.kind,
        status: document.status,
        requesterId: document.requesterId,
        currency: document.currency,
        subtotalAmount: PurchaseService.money(document.subtotalAmount),
        taxAmount: PurchaseService.money(document.taxAmount),
        totalAmount: PurchaseService.money(document.totalAmount),
        lineCount: document.lines.length,
      },
    });

    // PHASE C9 (GAP-5): the ONE act that can change what Global Search must know about a
    // purchase document — the create that MINTS its number. Title, timestamp and route
    // are read/composed at query time and updates cannot rewrite the number, so no other
    // write in this module pushes a projection. Best-effort by contract: the adapter
    // logs a refusal or a failure and returns, and the created document is still the
    // answer this method already committed to.
    await this.search.projectDocument(document);

    return this.serialize(document, await this.identity.profilesFor([document.requesterId]));
  }

  /**
   * Read one document (§8's "read").
   *
   * NOT FOUND, NOT FORBIDDEN, FOR ANOTHER TENANT'S ID: the read is tenant-scoped in the
   * repository's `where`, so an id from another tenant is indistinguishable from an id
   * that does not exist — which is the point. A 403 here would confirm the id names a
   * real document somewhere, and that is a fact this module does not hand out.
   */
  async getOne(actor: CommerceActor, id: string) {
    const document = await this.repository.findDocumentById(actor.tenantId, id);
    if (!document) throw new NotFoundException('Purchase document not found');

    return this.serialize(document, await this.identity.profilesFor([document.requesterId]));
  }

  /**
   * List the tenant's documents (§8's "list").
   *
   * THE PAGE WINDOW IS CLAMPED HERE AS WELL AS IN THE DTO: an internal caller that
   * builds a query object without going through validation cannot exceed
   * `COMMERCE_MAX_PAGE_SIZE` either. The window is resolved ONCE and its own `page` and
   * `pageSize` are echoed back, so a caller that sent nothing learns what it received
   * rather than having to infer it.
   *
   * Identity is resolved in ONE batch for the whole page (`profilesFor` dedupes the ids
   * first), never per row: fifty documents would otherwise be fifty round trips into
   * another module's database for one HTTP request.
   */
  async list(actor: CommerceActor, query: ListPurchaseDocumentsQueryDto) {
    const window = resolveCommercePageWindow(query);

    const [rows, total] = await this.repository.listDocumentPage(
      actor.tenantId,
      { status: query.status, requesterId: query.requesterId, search: query.search },
      window
    );

    const profiles = await this.identity.profilesFor(rows.map((row) => row.requesterId));

    return {
      items: rows.map((row) => this.serialize(row, profiles)),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /**
   * Update a document while it is editable (§8's "update while editable").
   *
   * TWO GUARDS, AND BOTH ARE NEEDED. This method READS the document and refuses a
   * non-editable one with a message naming the status — that is the honest answer a
   * caller can act on ("this is SUBMITTED; you cannot edit it"). But a read is a
   * snapshot: between it and the write, a concurrent submit could land, and the edit
   * would then rewrite lines an approver is already looking at. So the repository's
   * write carries `status: 'DRAFT'` in its own `where`, and a `null` result means the
   * document moved on — answered as 409, never as a silent success.
   *
   * `undefined` MEANS "NOT STATED IN THIS EDIT" and `null` means "CLEAR IT"; the DTO
   * keeps the two apart and so does the repository's `where`-building. Only fields the
   * caller stated become part of the UPDATE, so two concurrent editors of different
   * fields do not overwrite each other's work with values they never sent.
   *
   * TOTALS FOLLOW THE LINES, and only the lines: they are derived, so an edit that
   * changes a price without restating the lines cannot leave a stored total describing
   * the previous content. An edit that touches only the supplier leaves the totals
   * exactly as they were.
   */
  async update(actor: CommerceActor, id: string, dto: UpdatePurchaseDocumentDto) {
    const existing = await this.repository.findDocumentById(actor.tenantId, id);
    if (!existing) throw new NotFoundException('Purchase document not found');
    this.assertEditable(existing.status);

    if (dto.requesterId !== undefined) {
      await this.identity.assertMember(actor, dto.requesterId);
    }

    const lines = dto.lines ? this.toLineWrites(dto.lines) : undefined;
    const totals = lines ? computeDocumentTotals(lines) : undefined;

    const updated = await this.repository.updateEditableDocument(actor.tenantId, id, {
      scalars: {
        ...(dto.requesterId !== undefined ? { requesterId: dto.requesterId } : {}),
        ...(dto.supplierId !== undefined ? { supplierId: dto.supplierId } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      },
      ...(totals ? { totals } : {}),
      ...(lines ? { lines } : {}),
    });

    if (!updated) {
      throw new ConflictException(
        'The purchase document left the editable state while this change was being applied'
      );
    }

    await this.audit.record(actor, {
      action: PURCHASE_AUDIT_ACTION.UPDATE,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: updated.id,
      // What the caller actually changed — not a diff of the row, which would list
      // columns the edit never mentioned.
      changedFields: PurchaseService.statedFields(dto),
      newValue: {
        status: updated.status,
        supplierId: updated.supplierId,
        currency: updated.currency,
        subtotalAmount: PurchaseService.money(updated.subtotalAmount),
        taxAmount: PurchaseService.money(updated.taxAmount),
        totalAmount: PurchaseService.money(updated.totalAmount),
        lineCount: updated.lines.length,
      },
    });

    return this.serialize(updated, await this.identity.profilesFor([updated.requesterId]));
  }

  /**
   * Submit a document for decision (§8's "submit"): DRAFT → SUBMITTED, once.
   *
   * THE TRANSITION IS ASKED OF `purchase-status.ts`, not decided here: the table is
   * where "which moves are legal" is written down, and it currently permits exactly this
   * one move — so a document that is already SUBMITTED, APPROVED or CANCELLED is refused
   * with 409 and a message naming the status it is actually in.
   *
   * SUBMITTING IS THE FIRST ACT IN THIS SLICE WITH CONSEQUENCES OUTSIDE IT, so it writes
   * both streams and in this order: the audit row records what happened to the document,
   * and the event tells the rest of the system that it happened. Neither is allowed to
   * change the answer — the audit gateway never throws by contract, and the notification
   * publisher treats delivery as best-effort — because a document that WAS submitted
   * must not be reported as a failure to the caller who submitted it.
   *
   * NOTHING IS ROUTED YET. Step L owns the commercial lifecycle only; the workflow that
   * decides the document arrives with step N, and until then SUBMITTED is exactly what
   * it says — in the workflow's hands, with no instance created and no approver named.
   */
  async submit(actor: CommerceActor, id: string) {
    const existing = await this.repository.findDocumentById(actor.tenantId, id);
    if (!existing) throw new NotFoundException('Purchase document not found');

    if (!canTransitionPurchaseDocument(existing.status, 'SUBMITTED')) {
      throw new ConflictException(
        `A purchase document in status ${existing.status} cannot be submitted`
      );
    }

    // GAP-9: the authoritative decision owners THIS submit activates — captured inside
    // the unit of work so a rollback discards them with it, and notified only after the
    // commit below. Both sources are rows this transition itself created: the PENDING
    // workflow steps' stored approvers (line routing) and the commercial approvals'
    // stored approver (dispatch point 1). An empty list stays empty — a submit that
    // activates nobody notifies nobody, rather than guessing an audience.
    let pendingDecisionUserIds: readonly string[] = [];

    // Phase B2.3: build the durable outbox payload BEFORE the unit of work.
    // The auditId is stable regardless of whether the tx commits or rolls back.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PURCHASE_AUDIT_ACTION.SUBMIT,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: id,
      oldValue: { status: existing.status },
      newValue: { status: 'SUBMITTED' },
    });

    const submitted = await this.unitOfWork.run(async (tx) => {
      const marked = await this.repository.markDocumentSubmittedIn(
        actor.tenantId,
        tx,
        id,
        outbox
      );
      if (!marked) {
        throw new ConflictException(
          'The purchase document was already submitted while this request was being applied'
        );
      }

      const routingResult = await this.lineRouting.routeLinesForDocument(
        actor,
        marked,
        'PURCHASE_SUBMITTED',
        tx
      );

      // Step O4: pin the routing version that actually governed this routing execution.
      // The pin is conditional on `lineRoutingVersionId` being NULL, so concurrent first
      // routing calls are lose-safe and a later published version cannot drift the pin.
      const pinned = routingResult.routingVersionId
        ? await this.repository.pinLineRoutingVersionIn(
            actor.tenantId,
            tx,
            marked.id,
            routingResult.routingVersionId
          )
        : marked;

      // Step P, dispatch point 1 (§4): the configured commercial activation runs in
      // the SAME unit of work, so a refused assignment rolls the submit back with it
      // (§3-K) rather than leaving a submitted document nobody is responsible for.
      // With no published configuration this is §3-A's no-op and changes nothing.
      const commercialResult = await this.commercial.onPurchaseSubmitted(
        actor,
        pinned,
        tx,
        routingResult.aggregationPolicy
      );

      pendingDecisionUserIds = [
        ...(routingResult.pendingApproverUserIds ?? []),
        ...(commercialResult?.activatedApprovalUserIds ?? []),
      ];

      return pinned;
    });

    await this.notification.publish(actor, COMMERCE_PURCHASE_EVENT.SUBMITTED, {
      documentId: submitted.id,
      documentNumber: submitted.documentNumber,
      requesterId: submitted.requesterId,
      status: submitted.status,
      lineCount: submitted.lines.length,
    });

    // GAP-9: the user-facing Notification Center row for the owners this submit put in
    // PENDING — strictly AFTER the unit of work committed (a rolled-back submit never
    // reaches this line) and addressed only to ids the transition itself stored as the
    // decision owner. Deduplication, the tenant assertion and the failure policy are the
    // gateway's (see commerce-notification.gateway.ts).
    await this.notification.notifyUsers(actor, pendingDecisionUserIds, {
      type: 'INFORMATION',
      title: `سند ${submitted.documentNumber} منتظر تأیید شماست`,
      body: `سند خرید شماره ${submitted.documentNumber} اکنون منتظر تصمیم شماست.`,
      sourceType: 'purchase-document',
      sourceId: submitted.id,
    });

    return this.serialize(submitted, await this.identity.profilesFor([submitted.requesterId]));
  }

  // ---------------------------------------------------------------------------
  // Translation, projection and the two guards
  // ---------------------------------------------------------------------------

  /** §5.11's editability, asked in ONE place and answered with the status named. */
  private assertEditable(status: PurchaseDocumentStatus): void {
    if (isPurchaseDocumentEditable(status)) return;

    throw new ConflictException(
      `A purchase document in status ${status} is no longer editable; only DRAFT documents may be changed`
    );
  }

  /**
   * The DTO's lines as the repository writes them.
   *
   * POSITIONS ARE ASSIGNED HERE, from array order, 1…n — they are the author's intent
   * and the schema makes them unique per document, so a gap or a duplicate is not
   * expressible. This is also why the update path replaces lines wholesale rather than
   * patching them: positions belong to the set, not to a row.
   *
   * `lineTotal` IS DERIVED, never accepted: `quantity × unitPrice`, exactly, four
   * decimals — so a stored line can never disagree with its own two numbers. It stays
   * NULL when no unit price was stated, because "not priced yet" and "free" are
   * different statements (§5.1) and only the caller can say which one it means.
   */
  private toLineWrites(lines: readonly PurchaseLineInputDto[]): PurchaseLineWrite[] {
    return lines.map((line, index) => ({
      lineNumber: index + 1,
      lineType: line.lineType,
      quantity: moneyFromNumber(line.quantity, 'quantity'),
      unit: line.unit ?? null,
      unitPrice: line.unitPrice === undefined ? null : moneyFromNumber(line.unitPrice, 'unitPrice'),
      tax: line.tax === undefined ? null : moneyFromNumber(line.tax, 'tax'),
      lineTotal: line.unitPrice === undefined ? null : multiplyMoney(line.quantity, line.unitPrice),
      externalRef: line.externalRef ?? null,
      itemReference: line.itemReference ?? null,
      technicalDescription: line.technicalDescription ?? null,
    }));
  }

  /**
   * A stored `Decimal(18,4)` as the exact decimal STRING, or `null`.
   *
   * `String(decimal)` is exact; converting to a JavaScript number first would not be,
   * and a total is the last value that may lose a digit on the way out. NULL stays NULL
   * — "not priced yet" is not `0` and must not render as one.
   */
  private static money(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  /** Which fields this edit actually stated — the audit's `changedFields`. */
  private static statedFields(dto: UpdatePurchaseDocumentDto): string[] {
    return [
      ...(dto.requesterId !== undefined ? ['requesterId'] : []),
      ...(dto.supplierId !== undefined ? ['supplierId'] : []),
      ...(dto.currency !== undefined ? ['currency'] : []),
      ...(dto.lines ? ['lines'] : []),
    ];
  }

  /**
   * The wire projection (§8: "do not expose Prisma models directly").
   *
   * WHY IT IS WRITTEN OUT RATHER THAN RETURNED: the row carries `tenantId`, and the
   * tenant is the one thing that must never reach a response body — a client that
   * received it could put it in the next request and would then be entitled to nothing
   * (the actor resolves the tenant) while having learned which tenant it was scoped to.
   * Writing the shape explicitly also makes the money convention visible: every
   * `Decimal(18,4)` crosses the wire as its exact decimal STRING, `null` when it was
   * never stated.
   *
   * `requester` CARRIES THE ID ALWAYS AND THE PROFILE WHEN ONE RESOLVES. The id is the
   * stored fact; the profile is a rendering aid whose absence is data — a person who has
   * left, or an id from another tenant's directory — and the caller decides how to show
   * that rather than receiving a plausible-looking empty name.
   *
   * `editable` IS DERIVED FROM THE SAME FUNCTION THE GUARD USES, so the flag a client
   * renders and the refusal its next PATCH receives cannot disagree.
   *
   * THE COMPLETION FACTS (C4-R) ARE THE ONLY ADDITION, and C1 §29 names exactly these two:
   * the recorded completion ACTOR and TIMESTAMP, `null` until the document is completed.
   * They are projected here so a reader can answer "who completed this, and when" from the
   * document itself — the same read that answers every other question about it. The pinned
   * `completionPolicyVersionId` is deliberately NOT on the wire, exactly like the
   * commercial and line-routing pins: it is an internal reference the settings surface
   * reads from the policy resource, not a document field.
   */
  private serialize(document: PurchaseDocumentRecord, profiles: Map<string, DirectoryUserProfile>) {
    return {
      id: document.id,
      documentNumber: document.documentNumber,
      kind: document.kind,
      status: document.status,
      editable: isPurchaseDocumentEditable(document.status),
      completedByUserId: document.completedByUserId ?? null,
      completedAt: document.completedAt ? document.completedAt.toISOString() : null,
      requester: {
        id: document.requesterId,
        profile: profiles.get(document.requesterId) ?? null,
      },
      supplierId: document.supplierId,
      currency: document.currency,
      subtotalAmount: PurchaseService.money(document.subtotalAmount),
      taxAmount: PurchaseService.money(document.taxAmount),
      totalAmount: PurchaseService.money(document.totalAmount),
      lines: document.lines.map((line) => PurchaseService.serializeLine(line)),
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  }

  /** One line on the wire — same money convention, same explicit field list. */
  private static serializeLine(line: PurchaseLineRecord) {
    return {
      id: line.id,
      lineNumber: line.lineNumber,
      lineType: line.lineType,
      quantity: String(line.quantity),
      unit: line.unit,
      unitPrice: PurchaseService.money(line.unitPrice),
      tax: PurchaseService.money(line.tax),
      lineTotal: PurchaseService.money(line.lineTotal),
      externalRef: line.externalRef,
      itemReference: line.itemReference,
      technicalDescription: line.technicalDescription,
    };
  }
}
