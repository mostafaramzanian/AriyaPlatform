import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
// The calendar module is the repository's ONE Jalali boundary, and it is pure date
// arithmetic (no database, no Prisma, no Core client) — the same reasoning
// `letter-number.service.ts` records for reaching it from an independent module. The
// ALTERNATIVE is a second Jalali implementation here, and the year a counter is keyed
// by is exactly the kind of value that must not have two answers.
import { instantToJalaliDate } from '../../../calendar/jalali.util';
import { formatPurchaseDocumentNumber } from './purchase-number';
import type {
  PurchaseDocumentKind,
  PurchaseDocumentStatus,
  PurchaseLineType,
} from './purchase-status';
import type { Prisma } from '../../../generated/commerce-client';

/**
 * Phase C1 Step L: the purchase document persistence boundary — every statement this
 * slice issues against `commerce_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * This file owns INSERTs, UPDATEs and tenant-scoped SELECTs. It does not decide whether
 * a document is editable, whether a transition is legal, whether a line is priced or
 * what an amount is worth — those decisions live in `purchase-status.ts`,
 * `purchase-money.ts` and `PurchaseService`. A repository that refused a status change
 * would be a second place the lifecycle is written down, and the two would disagree the
 * first time one of them changed.
 *
 * THE ONE THING IT DOES DECIDE, BECAUSE ONLY IT CAN
 * ------------------------------------------------
 * The document NUMBER. Allocation is a single atomic `INSERT … ON CONFLICT … RETURNING`
 * statement that must run INSIDE the creating transaction (see the schema's note on
 * `PurchaseDocumentCounter`), and a service cannot hold a transaction without holding a
 * Prisma client — which is precisely what the service layer must not do. So the
 * allocation is a private statement here, the pure format lives in `purchase-number.ts`,
 * and `createDocument` is the only method that mints a number or inserts a document.
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every method and appears in every `where`.
 * `findUnique` is never used: it cannot carry a tenant predicate, so a "find by id"
 * written with it would read another tenant's document for an id that happened to
 * collide. `updateMany`/`deleteMany` are used where a conditional write is needed,
 * because `update` cannot express "only if it still matches an extra predicate" — and
 * that predicate is what makes two concurrent submits impossible rather than unlikely.
 *
 * The INTERACTIVE transaction form (`$transaction(async (tx) => …)`) is used wherever a
 * later statement depends on an earlier one's result — the number allocation, the line
 * write and the reload are one unit of work. The ARRAY form is used for the page read,
 * where the count and the page are two independent reads of one snapshot.
 */

/** One line as the service states it, with money already in the `Decimal(18,4)` domain. */
export interface PurchaseLineWrite {
  /** Position in the document, 1…n, assigned by the service from array order. */
  lineNumber: number;
  lineType: PurchaseLineType;
  quantity: string;
  unit?: string | null;
  unitPrice?: string | null;
  tax?: string | null;
  lineTotal?: string | null;
  externalRef?: string | null;
  itemReference?: string | null;
  technicalDescription?: string | null;
}

/**
 * The document's stored totals — all three, or none.
 *
 * A partial set is not expressible: the schema says `subtotalAmount` is Σ `lineTotal`
 * and `totalAmount` is subtotal + tax, so a document that stated one without the others
 * would be three columns disagreeing about one fact. All three NULL means "not priced
 * yet", which §5.1 distinguishes from zero.
 */
export interface PurchaseDocumentTotals {
  subtotalAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
}

/** The document's own scalar columns, as an edit states them. */
export interface PurchaseDocumentScalars {
  requesterId?: string;
  supplierId?: string | null;
  currency?: string | null;
}

/** The filter one list read applies, always inside the acting tenant. */
export interface PurchaseDocumentFilter {
  status?: PurchaseDocumentStatus;
  requesterId?: string;
  search?: string;
  /**
   * Phase KPI-RUNTIME: half-open instant windows on `createdAt` and `completedAt` — ISO 8601
   * strings, the SAME filters the report contract declares (`createdFrom/createdTo`,
   * `completedFrom/completedTo`). Two pairs because Commerce's two approved KPIs cohort on
   * different instants (KPI-003 on completion, KPI-004 on creation).
   */
  createdFrom?: string;
  createdTo?: string;
  completedFrom?: string;
  completedTo?: string;
}

@Injectable()
export class PurchaseRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * What a read of one document returns: the document and its lines, in the author's
   * own order. `lineNumber` is the order — NOT `createdAt`, which is a clock and would
   * let a rewritten line jump to the end of the document.
   */
  private static readonly DOCUMENT_LABEL = {
    lines: { orderBy: { lineNumber: 'asc' as const } },
  } as const;

  /**
   * One page of the tenant's purchase documents as `[rows, total]`, newest first.
   *
   * The `[rows, count]` pair is one array-form transaction, so the total cannot
   * describe a different moment than the page it is rendered with. `id` is the second
   * sort key: two documents created in the same millisecond would otherwise be ordered
   * differently on two reads, and a paging client would see one of them twice.
   */
  /**
   * The tenant predicate of EVERY document read in this file — ONE builder, so the
   * page read and the status counts can never disagree about what a filter meant.
   *
   * `search` quotes `documentNumber` and nothing else: there is no title or
   * description on a purchase document, so a search that matched anything else would
   * match nothing.
   */
  private static buildDocumentWhere(filter: PurchaseDocumentFilter) {
    return {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.requesterId ? { requesterId: filter.requesterId } : {}),
      ...(filter.search
        ? { documentNumber: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
      // Phase KPI-RUNTIME: the two half-open `[from, to)` windows the report contract
      // declares — `gte` on the lower bound, `lt` on the upper, exactly as Production's
      // `buildListWhere` states it. A window is set only when a bound is stated, so a
      // caller that names none keeps the object shape it had before this extension.
      ...(filter.createdFrom !== undefined || filter.createdTo !== undefined
        ? {
            createdAt: {
              ...(filter.createdFrom !== undefined ? { gte: new Date(filter.createdFrom) } : {}),
              ...(filter.createdTo !== undefined ? { lt: new Date(filter.createdTo) } : {}),
            },
          }
        : {}),
      ...(filter.completedFrom !== undefined || filter.completedTo !== undefined
        ? {
            completedAt: {
              ...(filter.completedFrom !== undefined
                ? { gte: new Date(filter.completedFrom) }
                : {}),
              ...(filter.completedTo !== undefined ? { lt: new Date(filter.completedTo) } : {}),
            },
          }
        : {}),
    };
  }

  async listDocumentPage(
    tenantId: string,
    filter: PurchaseDocumentFilter,
    window: { skip: number; take: number }
  ) {
    const where = { tenantId, ...PurchaseRepository.buildDocumentWhere(filter) };

    return this.prisma.$transaction([
      this.prisma.purchaseDocument.findMany({
        where,
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        include: PurchaseRepository.DOCUMENT_LABEL,
      }),
      this.prisma.purchaseDocument.count({ where }),
    ]);
  }

  /**
   * Phase REPORTING-PURCHASE-REPORT: bounded per-status counts over the SAME filter
   * the page read above answers — the report summary's database aggregation.
   *
   * WHY A `groupBy` AND NOT A LOOP OVER `listDocumentPage`. The summary strip renders
   * six numbers; answering them by loading the register into application memory would
   * make a report that is supposed to describe a tenant's whole purchase history read
   * that history to describe it. ONE `groupBy`, no rows materialised, and the SAME
   * `where` builder as the page read above — so the counts and the page can never
   * disagree about what the filter meant, because there is one place that builds it.
   *
   * `Map<PurchaseDocumentStatus, number>` (NOT a plain record) so a caller that forgets
   * to zero-fill gets `undefined` for an absent status rather than a plausible `0` it
   * did not ask for; the reader decides the fill, over the closed vocabulary.
   *
   * Read-only, tenant-scoped first like every other method here, and it writes nothing
   * — which is why it belongs beside the reads rather than behind a second client.
   */
  async countByStatus(
    tenantId: string,
    filter: PurchaseDocumentFilter
  ): Promise<Map<PurchaseDocumentStatus, number>> {
    const where = { tenantId, ...PurchaseRepository.buildDocumentWhere(filter) };

    const rows = await this.prisma.purchaseDocument.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });

    return new Map(rows.map((row) => [row.status as PurchaseDocumentStatus, row._count.status]));
  }

  /**
   * One document plus its lines, or `null` for an id this tenant does not hold.
   *
   * The optional handle is step P's: every commercial act runs INSIDE a unit of work
   * and must see that unit's own writes — the status flip it is about to project from
   * and the configuration pin it just wrote. An API read passes nothing and opens no
   * transaction (the array-form page read above is the only `$transaction` this file
   * starts for a read).
   */
  async findDocumentById(tenantId: string, id: string, tx?: CommerceTransactionHandle) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.purchaseDocument.findFirst({
      where: { id, tenantId },
      include: PurchaseRepository.DOCUMENT_LABEL,
    });
  }

  /**
   * The document a LINE belongs to — the address a line-settle dispatch needs.
   *
   * A line workflow instance's `subjectId` is a `PurchaseLine` id, and §3-F requires
   * the projection to recompute on "line workflow settle". Nothing in the instance row
   * names the document, so this is the one statement that carries the dispatch from a
   * line to the document whose status it may move. Returns `null` for a line this
   * tenant does not hold, so a cross-tenant id is indistinguishable from an absent one.
   */
  async findDocumentIdByLineId(
    tenantId: string,
    lineId: string,
    tx?: CommerceTransactionHandle
  ): Promise<string | null> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    const line = await client.purchaseLine.findFirst({
      where: { tenantId, id: lineId },
      select: { purchaseDocumentId: true },
    });
    return line?.purchaseDocumentId ?? null;
  }

  /**
   * PHASE C2: the numbers of MANY documents in ONE statement — the inbox's display join.
   *
   * Both halves of the inbox hold opaque document ids (a step's `subjectId`, an approval's
   * `purchaseDocumentId`) with no relation to `PurchaseDocument`, so rendering a row's
   * number from them would be one lookup per task row — the N+1 the C2 contract forbids.
   * A Map (the `profilesFor` shape) keeps the lookup O(1) and an id this tenant does not
   * hold simply absent, so a cross-tenant id is indistinguishable from a broken reference
   * and never leaks which of the two it is.
   */
  async findDocumentNumbersByIds(
    tenantId: string,
    documentIds: readonly string[]
  ): Promise<Map<string, string>> {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.purchaseDocument.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true, documentNumber: true },
    });
    return new Map(rows.map((row) => [row.id, row.documentNumber]));
  }

  /**
   * PHASE C9 (GAP-5): the rows the PLATFORM SEARCH SOURCE's authoritative re-read needs,
   * in ONE tenant-scoped statement.
   *
   * The platform's Global Search re-reads every candidate from its owning source before
   * returning it (`SearchAuthorizer` for Core's own sources; the registered source's
   * adapter for an independent bounded context). That re-read is a BATCH question about
   * ids retrieval already produced, so answering it per id would be the N+1 the platform
   * contract forbids: one call, one `id: { in: … }` query, tenant FIRST like every read in
   * this file. A Map (the `findDocumentNumbersByIds` shape) keeps membership O(1) and an
   * id this tenant does not hold simply absent — so a stale projection, a cross-tenant id
   * and an id that never existed are all indistinguishable from one another, which is
   * exactly what the search source must return (nothing).
   *
   * ONLY the fields the search projection and its authorized result carry: the document
   * NUMBER (the one searchable text) and the row's own `updatedAt` (the timestamp the
   * result displays). No supplier, requester, money column, status or line is read — the
   * projection may not carry them and the adapter may not return them.
   */
  async findDocumentSearchRowsByIds(
    tenantId: string,
    documentIds: readonly string[]
  ): Promise<Map<string, { documentNumber: string; updatedAt: Date }>> {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.purchaseDocument.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true, documentNumber: true, updatedAt: true },
    });

    return new Map(rows.map((row) => [row.id, { documentNumber: row.documentNumber, updatedAt: row.updatedAt }]));
  }

  /**
   * PHASE C2: the document behind MANY lines in ONE statement — the same dispatch a single
   * `findDocumentIdByLineId` performs, batched for the inbox.
   *
   * A LINE-scoped workflow run's `subjectId` is a `PurchaseLine` id, so an inbox row for
   * that run can only name the purchase document through its line. Same posture as the
   * single-id version: a line this tenant does not hold is simply absent from the map.
   */
  async findDocumentIdsByLineIds(
    tenantId: string,
    lineIds: readonly string[]
  ): Promise<Map<string, string>> {
    const unique = [...new Set(lineIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.purchaseLine.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true, purchaseDocumentId: true },
    });
    return new Map(rows.map((row) => [row.id, row.purchaseDocumentId]));
  }

  /**
   * The CREATE: mint the number and write the document with its lines, in ONE
   * transaction.
   *
   * The order is the contract. The counter is advanced first, inside the same
   * transaction as the insert, so a create that fails leaves no burned number behind —
   * and because a number is never allocated outside a create, the sequence has no gaps a
   * reader would have to explain. The lines are written with `createMany` (one
   * statement, not one per line) and the document is then re-read through the same label
   * a GET uses, so the write path and the read path cannot return different shapes.
   */
  async createDocument(
    tenantId: string,
    data: {
      kind: PurchaseDocumentKind;
      requesterId: string;
      supplierId?: string | null;
      currency?: string | null;
      totals: PurchaseDocumentTotals;
      lines: PurchaseLineWrite[];
    },
    now: Date = new Date()
  ) {
    return this.prisma.$transaction(async (tx) => {
      const documentNumber = await this.allocateDocumentNumber(tx, tenantId, data.kind, now);

      const created = await tx.purchaseDocument.create({
        data: {
          tenantId,
          documentNumber,
          kind: data.kind,
          requesterId: data.requesterId,
          supplierId: data.supplierId ?? null,
          currency: data.currency ?? null,
          subtotalAmount: data.totals.subtotalAmount,
          taxAmount: data.totals.taxAmount,
          totalAmount: data.totals.totalAmount,
        },
      });

      await PurchaseRepository.writeLines(tx, tenantId, created.id, data.lines);
      return PurchaseRepository.readDocument(tx, tenantId, created.id);
    });
  }

  /**
   * The UPDATE, in one transaction, and only while the document is still editable.
   *
   * THE STATUS PREDICATE IS PART OF THE WHERE CLAUSE, not just of the caller's earlier
   * check. The service reads the document and refuses a non-editable one with a message
   * naming its status — that is the honest answer. But between that read and this write
   * a concurrent submit could land, and then this update would rewrite lines an approver
   * is already looking at. `updateMany` with `status: 'DRAFT'` closes that window in the
   * database: `count === 0` means the document moved on, and the caller answers 409
   * rather than guessing. A plain `update` could not express the condition at all.
   *
   * Returns the reloaded document, or `null` when the predicate no longer held.
   */
  async updateEditableDocument(
    tenantId: string,
    id: string,
    edit: {
      scalars: PurchaseDocumentScalars;
      totals?: PurchaseDocumentTotals;
      lines?: PurchaseLineWrite[];
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.purchaseDocument.updateMany({
        where: { id, tenantId, status: 'DRAFT' },
        data: {
          ...(edit.scalars.requesterId !== undefined
            ? { requesterId: edit.scalars.requesterId }
            : {}),
          ...(edit.scalars.supplierId !== undefined ? { supplierId: edit.scalars.supplierId } : {}),
          ...(edit.scalars.currency !== undefined ? { currency: edit.scalars.currency } : {}),
          ...(edit.totals
            ? {
                subtotalAmount: edit.totals.subtotalAmount,
                taxAmount: edit.totals.taxAmount,
                totalAmount: edit.totals.totalAmount,
              }
            : {}),
        },
      });

      if (count === 0) return null;

      if (edit.lines) {
        // Wholesale replacement, inside the same transaction as the guard: a DRAFT has
        // been routed to nobody, so there is no line history a replacement could erase
        // (see the DTO note). The delete is scoped by tenant AND document, so it cannot
        // reach another document's lines even with a forged id.
        await tx.purchaseLine.deleteMany({ where: { tenantId, purchaseDocumentId: id } });
        await PurchaseRepository.writeLines(tx, tenantId, id, edit.lines);
      }

      return PurchaseRepository.readDocument(tx, tenantId, id);
    });
  }

  /**
   * The SUBMIT transition: DRAFT → SUBMITTED, conditionally, returning the reloaded
   * document — or `null` when the document was no longer a DRAFT.
   *
   * The same discipline as the update, for the same reason and with more at stake: two
   * concurrent submits must not both be told they were the one that routed the document,
   * because whichever step N hangs off that fact would run twice. The conditional
   * `updateMany` makes the second one return `0` — the document is already in the
   * workflow's hands — and the caller answers 409 rather than reporting a success it did
   * not cause.
   */
  async markDocumentSubmitted(tenantId: string, id: string) {
    return this.prisma.$transaction((tx) => PurchaseRepository.writeSubmitted(tx, tenantId, id));
  }

  /**
   * §8.1's SUBMIT, for a transaction SOMEBODY ELSE opened — the same conditional
   * DRAFT → SUBMITTED, the same reload, but inside the caller's unit of work.
   *
   * WHY THIS FORM HAD TO EXIST. §8.1 makes the status flip and the run's creation ONE
   * atomic act: a purchase document must never be `SUBMITTED` with no `WorkflowInstance`
   * behind it (the forbidden state `commerce-transaction.ts` names). Two calls to two
   * repositories, each opening its own transaction, cannot express that — the first could
   * commit and the second fail. So the CALLER owns the transaction (`CommerceUnitOfWork`)
   * and hands this repository a HANDLE, which is the only thing a repository may accept in
   * place of its own `$transaction`.
   *
   * WHY THE HANDLE IS UNWRAPPED HERE AND NOWHERE ELSE. `unwrapCommerceTransaction` is the
   * one function that turns the handle into a client, and it is called from repositories
   * only — a service that unwrapped one would be holding a `Prisma.TransactionClient`, the
   * boundary erosion the isolation suite exists to prevent. A handle that this runtime did
   * not mint makes that call throw rather than silently opening a fresh transaction, which
   * is precisely the non-atomic write the caller was trying to avoid.
   *
   * The statement itself lives in `writeSubmitted`, SHARED with the self-transacting form
   * above, so the lifecycle is written down exactly once: this method and
   * `markDocumentSubmitted` cannot drift into two different definitions of "submitted".
   */
  async markDocumentSubmittedIn(
    tenantId: string,
    handle: CommerceTransactionHandle,
    id: string,
    outbox?: CommerceAuditOutboxPayload
  ) {
    const tx = unwrapCommerceTransaction(handle);
    const result = await PurchaseRepository.writeSubmitted(tx, tenantId, id);
    if (result && outbox) {
      await tx.auditOutbox.create({ data: outbox });
    }
    return result;
  }

  /**
   * STEP P (§3-B): the conditional `null → versionId` PIN — the first commercial
   * operation on a document freezes the tenant's currently published
   * `CommercialConfigurationVersion` onto the row, and every later commercial
   * operation for that document reads only the pinned version.
   *
   * The `commercialConfigurationVersionId: null` predicate is what makes two
   * concurrent first-operations lose-safe: exactly one `updateMany` matches, the
   * other writes nothing and reloads the winner's pin — a second pin would
   * silently change the document's commercial meaning, which §3-B exists to
   * forbid. Returns the reloaded document (pin included).
   */
  async pinCommercialConfigurationVersionIn(
    tenantId: string,
    handle: CommerceTransactionHandle,
    id: string,
    versionId: string
  ) {
    const tx = unwrapCommerceTransaction(handle);
    await tx.purchaseDocument.updateMany({
      where: { id, tenantId, commercialConfigurationVersionId: null },
      data: { commercialConfigurationVersionId: versionId },
    });
    return PurchaseRepository.readDocument(tx, tenantId, id);
  }

  /**
   * STEP O4: the conditional `null → versionId` PIN for the routing version that
   * governs line-routing aggregation semantics. The first applicable routing
   * trigger freezes the version; later routing uses the pinned version.
   *
   * The `lineRoutingVersionId: null` predicate makes concurrent first-routing
   * calls lose-safe: exactly one `updateMany` matches, the other reloads the
   * winner's pin. A second pin would silently change aggregation semantics.
   */
  async pinLineRoutingVersionIn(
    tenantId: string,
    handle: CommerceTransactionHandle,
    id: string,
    versionId: string
  ) {
    const tx = unwrapCommerceTransaction(handle);
    await tx.purchaseDocument.updateMany({
      where: { id, tenantId, lineRoutingVersionId: null },
      data: { lineRoutingVersionId: versionId },
    });
    return PurchaseRepository.readDocument(tx, tenantId, id);
  }

  /**
   * STEP P (§3-F): the projection writer's ONLY document-status statement —
   * the conditional `SUBMITTED → APPROVED` and `SUBMITTED → REJECTED` edges,
   * asked of the table rather than decided by the caller. `null` means the
   * document was no longer SUBMITTED, so the caller reports no transition it
   * did not cause (the same discipline as `writeSubmitted`).
   *
   * No other service writes these edges (§3-F), and `→ CLOSED` is still NOT
   * expressible here: no projection closes a document. The one completion
   * writer is `writeCompletedIn` below, reached only by the completion act.
   */
  async applyCommercialTransitionIn(
    tenantId: string,
    handle: CommerceTransactionHandle,
    id: string,
    to: 'APPROVED' | 'REJECTED'
  ) {
    const tx = unwrapCommerceTransaction(handle);
    const { count } = await tx.purchaseDocument.updateMany({
      where: { id, tenantId, status: 'SUBMITTED' },
      data: { status: to },
    });
    if (count === 0) return null;
    return PurchaseRepository.readDocument(tx, tenantId, id);
  }

  /**
   * PHASE C4-R (C1 §29): THE COMPLETION WRITER — the ONE statement that moves a
   * purchase document to `CLOSED`, and the third conditional document-status
   * statement in this file (after `writeSubmitted` and `applyCommercialTransitionIn`).
   *
   * WHY THE SOURCE SET IS A PARAMETER AND NOT A LITERAL. The statuses completion is
   * permitted FROM are the tenant's PUBLISHED Purchase Completion Policy — configuration,
   * not a constant — so the caller passes the policy's own set and this statement carries
   * the WHOLE set in its `where`. That is what makes the write optimistic in exactly the
   * right way: if another actor completed the document, or a commercial projection moved
   * it out of the set between the service's read and this update, `count === 0` and the
   * caller answers the established 409 instead of reporting a transition it did not cause.
   *
   * `completedAt: null` IS THE SECOND HALF OF THE PREDICATE, deliberately: a row may only
   * receive a completion ONCE, so even a set that somehow named the same status twice (or a
   * retry racing itself) cannot overwrite the recorded actor and timestamp. §29 requires
   * that actor and timestamp be RECORDED — recording means writing them here, once,
   * together with the status, in the same statement, so a reader can never find a CLOSED
   * document without them.
   *
   * The completion POLICY VERSION is pinned in the same write (never a second statement):
   * the fact "this completion was authorised by THAT policy" is part of the same historical
   * event as the actor and the timestamp, and splitting it would allow a completion that
   * recorded one and not the other.
   *
   * NO OTHER LIFECYCLE IS TOUCHED: no payment row, no receipt, no return, no workflow step
   * instance is written or read here (C1 §29 — those lifecycles stay independent).
   */
  async writeCompletedIn(
    tenantId: string,
    handle: CommerceTransactionHandle,
    id: string,
    completion: {
      fromStatuses: readonly PurchaseDocumentStatus[];
      completedByUserId: string | null;
      completedAt: Date;
      completionPolicyVersionId: string;
    },
    outbox?: CommerceAuditOutboxPayload
  ) {
    const tx = unwrapCommerceTransaction(handle);
    const { count } = await tx.purchaseDocument.updateMany({
      where: {
        id,
        tenantId,
        status: { in: [...completion.fromStatuses] },
        completedAt: null,
      },
      data: {
        status: 'CLOSED',
        completedByUserId: completion.completedByUserId,
        completedAt: completion.completedAt,
        completionPolicyVersionId: completion.completionPolicyVersionId,
      },
    });
    if (count === 0) return null;
    if (outbox) {
      await tx.auditOutbox.create({ data: outbox });
    }
    return PurchaseRepository.readDocument(tx, tenantId, id);
  }

  /**
   * The ONE write behind both submit forms: the conditional status flip and the reload.
   *
   * Private and static on purpose: it is not a unit of work's boundary, it is a statement,
   * and a public spelling of it would be a third path to a submitted document that no
   * caller asked for. `count === 0` means the document was no longer a DRAFT — the caller
   * answers 409 and creates no run, which is why the return type is `| null` rather than a
   * thrown error nobody can attribute.
   */
  private static async writeSubmitted(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const { count } = await tx.purchaseDocument.updateMany({
      where: { id, tenantId, status: 'DRAFT' },
      data: { status: 'SUBMITTED' },
    });

    if (count === 0) return null;
    return PurchaseRepository.readDocument(tx, tenantId, id);
  }

  // ---------------------------------------------------------------------------
  // Statements only this file may issue
  // ---------------------------------------------------------------------------

  /**
   * Allocates the next `documentNumber` for `(tenantId, kind, Jalali year of "now")`.
   *
   * ONE statement, deliberately: `SELECT … then UPDATE` would let two concurrent
   * creates read the same counter and mint the same number, and the tenant-first unique
   * on `PurchaseDocument` would then refuse a legitimate insert. `ON CONFLICT` moves the
   * arbitration into Postgres, where a conflicting insert is serialised against this
   * one. `$queryRaw` is required because Prisma's typed API cannot express an upsert
   * with `RETURNING` atomically — the same reason `letter-number.service.ts` reaches
   * for raw SQL.
   *
   * `gen_random_uuid()` fills the counter row's own id (core since PostgreSQL 13, so no
   * extension and no `CREATE EXTENSION` in the migration). `::"PurchaseDocumentKind"`
   * makes the enum cast explicit: a parameterised value arrives as text, and text does
   * not implicitly cast to an enum type.
   */
  private async allocateDocumentNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kind: PurchaseDocumentKind,
    now: Date
  ): Promise<string> {
    const { jy } = instantToJalaliDate(now);

    const rows = await tx.$queryRaw<Array<{ counter: number }>>`
      INSERT INTO "PurchaseDocumentCounter" ("id", "tenant_id", "kind", "jalali_year", "counter")
      VALUES (gen_random_uuid(), ${tenantId}, ${kind}::"PurchaseDocumentKind", ${jy}, 1)
      ON CONFLICT ("tenant_id", "kind", "jalali_year")
      DO UPDATE SET "counter" = "PurchaseDocumentCounter"."counter" + 1
      RETURNING "counter"
    `;

    const counter = rows[0]?.counter;
    if (!Number.isInteger(counter) || counter < 1) {
      // Fails CLOSED. The alternative — formatting whatever came back — is how a
      // document acquires the number `PR-1405-00000` and nobody notices for a year.
      throw new Error('Purchase document number allocation failed');
    }

    return formatPurchaseDocumentNumber(kind, jy, counter);
  }

  /** Writes a document's lines in one statement, with the tenant stated explicitly. */
  private static async writeLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchaseDocumentId: string,
    lines: readonly PurchaseLineWrite[]
  ): Promise<void> {
    if (lines.length === 0) return;

    await tx.purchaseLine.createMany({
      data: lines.map((line) => ({
        tenantId,
        purchaseDocumentId,
        lineNumber: line.lineNumber,
        lineType: line.lineType,
        quantity: line.quantity,
        unit: line.unit ?? null,
        unitPrice: line.unitPrice ?? null,
        tax: line.tax ?? null,
        lineTotal: line.lineTotal ?? null,
        externalRef: line.externalRef ?? null,
        itemReference: line.itemReference ?? null,
        technicalDescription: line.technicalDescription ?? null,
      })),
    });
  }

  /** Re-reads a just-written document through the SAME label the GET route uses. */
  private static async readDocument(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const document = await tx.purchaseDocument.findFirst({
      where: { id, tenantId },
      include: PurchaseRepository.DOCUMENT_LABEL,
    });

    if (!document) {
      // Unreachable in a healthy transaction: it would mean the insert or update this
      // transaction just performed is not visible to its own reader, which is an
      // infrastructure fault rather than a business answer — so it is NOT reported to
      // the caller as a 404.
      throw new Error('Purchase document write could not be read back inside its transaction');
    }

    return document;
  }
}
