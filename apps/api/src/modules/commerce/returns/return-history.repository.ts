import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
import { RETURN_STATES, type ReturnState } from './return-lifecycle';

/**
 * Phase C1 Step S (contract §13 "Append-only / repository", §9, §11): the
 * return slice's persistence boundary — every statement this slice issues
 * against `commerce_db`, and nothing else.
 *
 * WHY A NINTH REPOSITORY, NOT AN ANNEX OF R's OR Q's
 * --------------------------------------------------
 * `ReturnDocument` / `ReturnLine` / `ReturnLifecycleTransition` are an
 * append-only history whose rows are never rewritten (S-D4), while R's
 * repository serves receiving's own writes and Q's repository owns
 * `PaymentRecord`. One file
 * cannot both promise "no update exists here" and serve another lifecycle's
 * writes — so the promise is made here, structurally: this file contains
 * APPENDS and tenant-scoped reads, and NOT A SINGLE
 * `.update(` / `.updateMany(` / `.delete(` / `.deleteMany(` / `.upsert(`,
 * which is executable as a guard (`workflow-configuration.repository.spec.ts`
 * pins this file's NAME as the ninth repository, and `returns.guards.spec.ts`
 * pins its method list AND the absence).
 *
 * THE CONCURRENCY HINGE IS THE SAME ONE R TOOK (contract §9, R §3-H)
 * ------------------------------------------------------------------
 * S-D1's cap compares TWO histories (receipt lines, return lines), and no
 * read-then-check in application code can hold them still: two concurrent
 * creates against the same receipt line would both pass the same "remaining"
 * read. So EVERY write path first calls `lockDocumentForReturn` — a
 * `SELECT … FOR UPDATE` on the `PurchaseDocument` row, INSIDE the caller's
 * `CommerceUnitOfWork` — which serialises S against R's own writes (R locks
 * the same row) and against other S writes on the same document. The loser of
 * a race re-reads under the lock and its invariant check refuses with the
 * same `over_return` 409. The lock doubles as the tenant-scoped existence
 * gate (404 for absent AND foreign, indistinguishable — §10), and it is
 * released on commit or rollback: there is nothing a caller could hold. Raw
 * SQL stays in this file and names the `tenant_id` column, as the module's
 * raw-SQL gate requires.
 *
 * TENANCY. `tenantId` is the FIRST parameter of every public method and
 * appears in EVERY `where`. `findUnique` is never used — it cannot carry a
 * tenant predicate. The GET's document check and return history are read in
 * ONE array-form `$transaction` (the payment/receiving pages' precedent), so
 * a projection cannot describe a different moment than the rows beside it.
 *
 * NO AUDIT, NO EVENT, NO IDENTITY, NO RULE ENGINE, NO PAYMENT. The
 * persistence layer records nothing beyond its own rows (§I8, proven by the
 * guard): the trail is the service's to write through `CommerceAuditGateway`.
 * `PaymentRecord` is never named here — the refund's Q-side call happens in
 * the SERVICE through `PaymentHistoryService`'s public surface (§4-E), and
 * this repository would be the wrong layer to even see it.
 */

/** One returned quantity as it is written — both origin references, exact decimal text. */
export interface ReturnLineAppendWrite {
  purchaseLineId: string;
  receiptLineId: string;
  quantity: string;
}

/** One return document as it is written: header facts, lines, and the initial REQUESTED row. */
export interface ReturnAppendWrite {
  purchaseDocumentId: string;
  /** The acting session's user, OPAQUE, NULL for a machine context (§4-G). */
  requestedByUserId: string | null;
  reason: string;
  replacementRequired: boolean;
  lines: ReturnLineAppendWrite[];
  /** The first transition, written in the SAME create — never separately. */
  requestedTransition: { actorUserId: string | null };
}

/** One lifecycle transition as it is written — state, actor, optional reason. */
export interface TransitionAppendWrite {
  returnDocumentId: string;
  state: ReturnState;
  actorUserId: string | null;
  reason: string | null;
}

/** The ordering every read in this file states explicitly — never inherited. */
const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** The nested `include` both the GET and the write paths return: lines + history, ordered. */
const WITH_HISTORY = {
  lines: { orderBy: OLDEST_FIRST },
  transitions: { orderBy: OLDEST_FIRST },
} as const;

@Injectable()
export class ReturnHistoryRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * The GET snapshot: the document (the 404 gate) and its WHOLE return
   * history with nested lines and transitions — TWO reads in ONE array-form
   * `$transaction`, so the projected states cannot describe a different
   * moment than the rows rendered beside them. `null` document means absent
   * OR another tenant's; the service answers 404 for both (§10).
   *
   * ORDER IS STATED: returns by `createdAt` then `id` — §4-F's deterministic
   * oldest-first, the same total order the projection itself uses.
   */
  async readReturnHistory(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.$transaction([
      this.prisma.purchaseDocument.findFirst({
        where: { id: purchaseDocumentId, tenantId },
        select: { id: true },
      }),
      this.prisma.returnDocument.findMany({
        where: { tenantId, purchaseDocumentId },
        orderBy: OLDEST_FIRST,
        include: WITH_HISTORY,
      }),
    ]);
  }

  /**
   * THE CONCURRENCY HINGE: the document row, LOCKED for the duration of the
   * caller's unit of work (`SELECT … FOR UPDATE`, contract §9 / R §3-H).
   *
   * Returns the locked row's id, or `null` when no row matched TENANT AND
   * document — so the same statement doubles as the tenant-scoped existence
   * gate of every write path, and a cross-tenant id stays indistinguishable
   * from an absent one (404, never 403, never a probe).
   */
  async lockDocumentForReturn(
    tenantId: string,
    purchaseDocumentId: string,
    tx: CommerceTransactionHandle
  ): Promise<{ id: string } | null> {
    const rows = await unwrapCommerceTransaction(tx).$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PurchaseDocument"
      WHERE "tenant_id" = ${tenantId} AND "id" = ${purchaseDocumentId}::uuid
      FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * The document's own purchase lines — the set a return line's
   * `purchaseLineId` must belong to. Ownership is PROVEN against this read,
   * never assumed from a UUID (§10: a line the document does not own is 404
   * `Purchase line not found`). Mid-transaction, under the lock taken first.
   */
  async listPurchaseLines(
    tenantId: string,
    purchaseDocumentId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).purchaseLine.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ lineNumber: 'asc' as const }],
      select: { id: true, lineNumber: true },
    });
  }

  /**
   * EVERY receipt line of this document — originals AND compensating lines,
   * because `netReceived(R)` is R's own signed sum: `R.quantity` plus the
   * negatives that point at it (§4-C, R contract §3-D's `available` rule).
   * One read answers both halves of S-D1: the reference checks (does this
   * receipt line exist in scope, does it belong to the stated purchase line)
   * and the cap. Scoped by document AND tenant, so a receipt line of another
   * document is 404 — R's rule, §10's table. READ-ONLY: S appends nothing
   * here.
   */
  async listReceiptLines(
    tenantId: string,
    purchaseDocumentId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).receiptLine.findMany({
      where: { tenantId, receipt: { tenantId, purchaseDocumentId } },
      orderBy: OLDEST_FIRST,
      select: {
        id: true,
        purchaseLineId: true,
        quantity: true,
        reversesReceiptLineId: true,
        createdAt: true,
      },
    });
  }

  /**
   * The document's WHOLE return history with lines and transitions,
   * mid-transaction under the lock — the `alreadyReturned(R)` input of §4-C:
   * each document's state is projected from ITS transitions, `REJECTED`
   * documents are excluded from the sum, every other state counts (including
   * `REQUESTED`, which is what reserves quantity while a request is pending).
   * Reading it twice under one lock would be two moments pretending to be
   * one, so it is read once.
   */
  async listReturnDocuments(
    tenantId: string,
    purchaseDocumentId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).returnDocument.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: OLDEST_FIRST,
      include: WITH_HISTORY,
    });
  }

  /**
   * ONE return of THIS document in THIS tenant, with its lines and
   * transitions, or `null` — the 404 gate of the four lifecycle commands.
   * Scoped by (tenantId, purchaseDocumentId, returnId): a return of another
   * tenant, of another document, or an unknown id are the SAME 404,
   * indistinguishable by design (§7's path-parameter rule, no probe).
   */
  async findReturnDocument(
    tenantId: string,
    purchaseDocumentId: string,
    returnDocumentId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).returnDocument.findFirst({
      where: { id: returnDocumentId, tenantId, purchaseDocumentId },
      include: WITH_HISTORY,
    });
  }

  /**
   * THE ONLY HEADER WRITE in the slice: INSERT one `ReturnDocument` with its
   * `ReturnLine` children AND its initial `REQUESTED` transition, or refuse.
   *
   * One nested `create` is what makes document, lines and the first
   * transition ONE atomic act (§8: creation writes REQUESTED in the SAME
   * transaction — a return with no history, lines with no document, or a
   * document without its REQUESTED row are not expressible). Nothing here
   * interprets the row: DTO validation lives at the boundary, the invariant
   * lives in the service (the lock, the histories, the cap), and the
   * projection lives in `return-lifecycle.ts`.
   *
   * `id`s are system-generated; there is no numbering, no counter and no
   * client-stated identity anywhere in this statement (§15's RMA refusal).
   * This is an INSERT of rows that never change — no update path exists for
   * any of them to reach later (S-D4).
   */
  async appendReturn(tenantId: string, tx: CommerceTransactionHandle, data: ReturnAppendWrite) {
    return unwrapCommerceTransaction(tx).returnDocument.create({
      data: {
        tenantId,
        purchaseDocumentId: data.purchaseDocumentId,
        requestedByUserId: data.requestedByUserId,
        reason: data.reason,
        replacementRequired: data.replacementRequired,
        lines: {
          // NOTE: NO `tenantId` here — the relation to the parent document is
          // composite `(tenant_id, return_document_id)`, so Prisma inherits the
          // shared tenant field from the parent create. Stating it again is
          // rejected by the generated input (`Unknown argument 'tenantId'`),
          // and that inheritance is what makes a line under another tenant's
          // return not expressible even as a statement in this file.
          create: data.lines.map((line) => ({
            purchaseLineId: line.purchaseLineId,
            receiptLineId: line.receiptLineId,
            quantity: line.quantity,
          })),
        },
        transitions: {
          // NOTE: NO `tenantId` here — the relation to the parent document is
          // composite `(tenant_id, return_document_id)`, so Prisma inherits the
          // shared tenant field from the parent create. Stating it again is
          // rejected by the generated input, and the inheritance is what makes
          // a transition under another tenant's document not expressible even
          // as a statement in this file.
          create: [
            {
              state: 'REQUESTED',
              actorUserId: data.requestedTransition.actorUserId,
              reason: null,
            },
          ],
        },
      },
      include: WITH_HISTORY,
    });
  }

  /**
   * The slice's ONLY other write: INSERT ONE `ReturnLifecycleTransition` row.
   *
   * The matrix (`return-lifecycle.ts`) has already approved this exact edge
   * inside the same locked unit of work before this statement runs; the
   * repository does not re-judge it — one place decides legality, one place
   * stores the fact. The row is immutable: a transition is never edited and
   * never deleted, so the history the projection reads is the history that
   * happened (S-D2/S-D4).
   */
  async appendTransition(
    tenantId: string,
    tx: CommerceTransactionHandle,
    data: TransitionAppendWrite,
    outbox?: CommerceAuditOutboxPayload
  ) {
    const client = unwrapCommerceTransaction(tx);
    const row = await client.returnLifecycleTransition.create({
      data: {
        tenantId,
        returnDocumentId: data.returnDocumentId,
        state: data.state,
        actorUserId: data.actorUserId,
        reason: data.reason,
      },
    });
    if (outbox) {
      await client.auditOutbox.create({ data: outbox });
    }
    return row;
  }

  /**
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the STATE half of the report's ONE
   * shared filter — `state -> the relation predicate that means «this return's
   * PROJECTED state is exactly this»`.
   *
   * WHY A RELATION PREDICATE AND NOT A COLUMN. `ReturnDocument` has no state column
   * (S-D2): the current state is the LAST row of the append-only history ordered by
   * `(createdAt, id)` — `projectReturnState`'s projection, the ONE rule engine. SQL
   * cannot compare a row against its own maximum with Prisma's relation filters, so
   * each bucket is stated as the SHAPE of the history whose last row is that state —
   * and over every history the frozen matrix permits the two answers are provably
   * equal, because each valid path visits each state AT MOST ONCE:
   *
   *     {REQUESTED}                          -> REQUESTED
   *     {REQUESTED, APPROVED}                -> APPROVED
   *     {REQUESTED, APPROVED, RECEIVED_BACK} -> RECEIVED_BACK
   *     {REQUESTED, ..., REFUNDED}           -> REFUNDED
   *     {REQUESTED, REJECTED}                -> REJECTED
   *
   * «has X, and has NONE of the states that only come after X on X's path» names the
   * last row without inventing a second projection: these predicates never DECIDE a
   * state (the reader still projects every row through `projectReturnState`), they
   * only narrow a population to one that projection answers with X. The `none
   * REJECTED` guards state the matrix's branch exclusivity — harmless on valid
   * histories, present so a bucket can never absorb a mixed branch a bug alone could
   * write. `tenantId` is restated inside EVERY nested clause: the composite FK
   * already guarantees the join shares the tenant, and this repository restates it
   * anyway — the same tenant-first discipline every read here answers with.
   */
  private static buildStateWhere(tenantId: string, state: ReturnState) {
    const reached = (member: ReturnState) => ({
      transitions: { some: { tenantId, state: member } },
    });
    const notReached = (members: readonly ReturnState[]) =>
      members.map((member) => ({ transitions: { none: { tenantId, state: member } } }));

    switch (state) {
      case 'REQUESTED':
        return { AND: notReached(['APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED']) };
      case 'APPROVED':
        return {
          AND: [reached('APPROVED'), ...notReached(['RECEIVED_BACK', 'REFUNDED', 'REJECTED'])],
        };
      case 'RECEIVED_BACK':
        return { AND: [reached('RECEIVED_BACK'), ...notReached(['REFUNDED', 'REJECTED'])] };
      case 'REFUNDED':
        return { AND: [reached('REFUNDED'), ...notReached(['REJECTED'])] };
      case 'REJECTED':
        return reached('REJECTED');
    }
  }

  /**
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the ONE filter builder the report's
   * THREE reads share (the purchase register's `buildDocumentWhere` precedent), so
   * the page, the per-state counts and the detail read can never disagree about what
   * a filter meant.
   *
   * `state` narrows through `buildStateWhere` above; `search` matches the return's
   * OWN `reason` (the bounded free text the requester stated) OR the parent
   * document's number through the same-owner relation — «which return, against which
   * document» are the two questions a tenant-wide register answers.
   * `createdFrom`/`createdTo` are a HALF-OPEN `[from, to)` window on the row's own
   * `createdAt` — `gte` lower, `lt` upper — exactly the purchase and payment
   * registers' shape. Absent keys stay ABSENT: a caller that names no filter reaches
   * Prisma with an unfiltered predicate, never a defaulted one.
   */
  private static buildReportWhere(tenantId: string, filter: ReturnReportFilter) {
    return {
      ...(filter.state ? ReturnHistoryRepository.buildStateWhere(tenantId, filter.state) : {}),
      ...(filter.purchaseDocumentId ? { purchaseDocumentId: filter.purchaseDocumentId } : {}),
      ...(filter.search
        ? {
            OR: [
              { reason: { contains: filter.search, mode: 'insensitive' as const } },
              {
                purchaseDocument: {
                  documentNumber: { contains: filter.search, mode: 'insensitive' as const },
                },
              },
            ],
          }
        : {}),
      ...(filter.createdFrom !== undefined || filter.createdTo !== undefined
        ? {
            createdAt: {
              ...(filter.createdFrom !== undefined ? { gte: filter.createdFrom } : {}),
              ...(filter.createdTo !== undefined ? { lt: filter.createdTo } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: ONE page of the tenant's return
   * register plus its count, newest `createdAt` first, with the parent document's
   * number, the line COUNT and the ordered transition rows joined for display.
   *
   * WHY A SECOND READ SURFACE: `readReturnHistory` above answers ONE document at a
   * time (the commerce screen's own route), while the report register spans every
   * return of the tenant. Same owner, same table, same tenant-first predicate — the
   * shared `buildReportWhere`. The `[rows, count]` pair is one array-form
   * `$transaction`, so the total cannot describe a different moment than the page
   * beside it. ORDER: `createdAt` DESC (the report's primary date), `id` ASC as the
   * deterministic tie-break.
   *
   * WHAT THE SELECT CARRIES: the transition rows (id/state/createdAt — exactly
   * `projectReturnState`'s three-field input, so the reader projects each row's state
   * through the SAME pure module the domain uses, never a second rule) and the line
   * COUNT via `_count` (a count of rows that exist — no line contents, no N+1).
   * `tenantId` and `requestedByUserId` are selected NOWHERE: the scope is the
   * predicate, never a payload, and the whitelist is stated WHERE the row is read.
   */
  async listReportPage(
    tenantId: string,
    filter: ReturnReportFilter,
    window: { skip: number; take: number }
  ) {
    const where = { tenantId, ...ReturnHistoryRepository.buildReportWhere(tenantId, filter) };

    return this.prisma.$transaction([
      this.prisma.returnDocument.findMany({
        where,
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        select: REPORT_ROW_SELECT,
      }),
      this.prisma.returnDocument.count({ where }),
    ]);
  }

  /**
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: per-STATE counts over the SAME filter
   * the page answers — ONE bounded `$transaction` of five counts on the SAME
   * `buildReportWhere` + `buildStateWhere`, no rows materialised (the payment
   * register's `countReportByMethod` reasoning, applied where the grouped COLUMN
   * does not exist because the state is a projection).
   *
   * `Map<ReturnState, number>` so a caller that forgets to zero-fill reads
   * `undefined` for an absent state rather than a plausible `0` it never asked for.
   * A `filter.state` narrows the base first, so a filtered summary honestly reports
   * the other buckets as zero — the population the list answers.
   */
  async countReportByState(
    tenantId: string,
    filter: ReturnReportFilter
  ): Promise<Map<ReturnState, number>> {
    const base = { tenantId, ...ReturnHistoryRepository.buildReportWhere(tenantId, filter) };
    const counts = await this.prisma.$transaction(
      RETURN_STATES.map((state) =>
        this.prisma.returnDocument.count({
          where: { AND: [base, ReturnHistoryRepository.buildStateWhere(tenantId, state)] },
        })
      )
    );
    return new Map(RETURN_STATES.map((state, index) => [state, counts[index]]));
  }

  /**
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: one return plus its parent document's
   * number, its lines and its ordered transitions — or `null` for an id this tenant
   * does not hold (the report service maps either to a 404, so existence never leaks
   * across tenants). `findFirst` with an explicit tenant predicate, never
   * `findUnique`: the module-wide guard's rule, stated here too.
   */
  async findReportRow(tenantId: string, returnId: string) {
    return this.prisma.returnDocument.findFirst({
      where: { tenantId, id: returnId },
      select: {
        ...REPORT_ROW_SELECT,
        lines: {
          orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
          select: {
            id: true,
            purchaseLineId: true,
            receiptLineId: true,
            quantity: true,
            createdAt: true,
          },
        },
      },
    });
  }
}

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the report register's filter — ONLY the
 * fields `buildReportWhere` answers. Absent means "no narrowing", never a default.
 */
export interface ReturnReportFilter {
  state?: ReturnState;
  search?: string;
  purchaseDocumentId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * The shared projection of the two report reads — a `select`, never an `include`, so
 * the whitelist is stated WHERE the row is read rather than subtracted afterwards.
 * NO outer `as const`: Prisma's orderBy input refuses a READ-ONLY tuple, so the two
 * sort literals carry their own `as const` and the object stays mutable-typed.
 */
const REPORT_ROW_SELECT = {
  id: true,
  purchaseDocumentId: true,
  reason: true,
  replacementRequired: true,
  createdAt: true,
  purchaseDocument: { select: { documentNumber: true } },
  _count: { select: { lines: true } },
  transitions: {
    select: { id: true, state: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
};
