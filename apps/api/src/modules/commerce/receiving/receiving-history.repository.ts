import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import { sumMoney } from '../purchase/purchase-money';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';

/**
 * Phase C1 Step R (§5.16, contract §3-A, §3-H): the receiving history
 * persistence boundary — every statement this slice issues against
 * `commerce_db`, and nothing else.
 *
 * WHY THIS FILE IS AN EIGHTH REPOSITORY, NOT AN ANNEX OF THE PURCHASE ONE
 * ----------------------------------------------------------------------
 * `Receipt` / `ReceiptLine` are an append-only history whose rows are never
 * rewritten (R4), while `purchase.repository.ts` owns a lifecycle of
 * conditional UPDATEs. One file cannot both promise "no update exists here"
 * and maintain the document's transitions — so the promise is made here,
 * structurally: this file contains `append` and tenant-scoped reads, and NOT
 * A SINGLE `.update(` / `.delete(` / `.upsert(`, which is executable as a
 * guard (`workflow-configuration.repository.spec.ts` pins this file's name,
 * and `receiving.guards.spec.ts` pins its method list AND the absence).
 *
 * APPEND-ONLY IS ENFORCED HERE, NOT IN THE DATABASE (contract §3-A)
 * ----------------------------------------------------------------
 * `commerce_db` has no trigger precedent and R does not add the first one:
 * a trigger would be a rule invisible to this file's reviewers and untested
 * by the suite. The schema carries no `updated_at` on `Receipt` or
 * `ReceiptLine`, and the only correction mechanism — a compensating event —
 * arrives through the SAME `append` below. A caller therefore has no
 * statement it could issue through this repository to alter a settled row.
 *
 * THE OVER-RECEIPT RACE, AND WHERE IT IS ANSWERED (contract §3-H / §22)
 * --------------------------------------------------------------------
 * Two concurrent `+10` appends against ordered 100 / received 90 must not
 * produce 110, and no read-then-check in application code can promise that —
 * a concurrent append lands between the read and the write. So EVERY write
 * path first calls `lockDocumentForReceipt`: a `SELECT … FOR UPDATE` on the
 * document row, inside the caller's `CommerceUnitOfWork`. All receiving
 * writes on one document serialize on that lock; under READ COMMITTED the
 * loser's subsequent SUM sees the winner's committed rows and its
 * over-receipt check refuses. Compensation takes the same lock before
 * computing its cap (§3-D), so two concurrent compensations cannot both pass
 * the same "remaining" read. This is a database-native transactional
 * mechanism — no distributed lock, no advisory-lock namespace, no timeout
 * policy invented here. The lock is held until the unit of work commits or
 * rolls back; it protects the INVARIANT, not the rows (rows need no
 * protection: nothing in this file can rewrite one).
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every method and appears in every
 * `where`, as in every repository of this module. `findUnique` is never used:
 * it cannot carry a tenant predicate. The GET's document, lines and history
 * are read in ONE array-form `$transaction` (the payment page's precedent),
 * so the projection cannot describe a different moment than the events
 * rendered beside it.
 *
 * NO AUDIT, NO EVENT, NO IDENTITY, NO RULE ENGINE. The persistence layer
 * records nothing beyond its own rows (§I8, and the guard proves the
 * absence): the trail is the service's to write through
 * `CommerceAuditGateway`, one row per append. Over-receipt is not evaluated
 * here — this file stores and reads; the invariant lives in the service
 * against what these reads returned, under the lock this file took.
 */

/**
 * One `ReceiptLine` as it is written: the exact decimal STRING the column
 * stores (positive on a receipt, the negation on a compensation — the sign
 * is the service's decision, §3-D), and the compensation link the server
 * states, never a client.
 */
export interface ReceiptLineAppendWrite {
  purchaseLineId: string;
  quantity: string;
  reversesReceiptLineId?: string | null;
}

/** One receiving operation as it is written — header facts plus its lines. */
export interface ReceiptAppendWrite {
  purchaseDocumentId: string;
  /** The caller's stated instant; absent means the column default (now). */
  receivedAt?: Date;
  /** The acting session's user, OPAQUE, NULL for a machine context (§16). */
  receiverId: string | null;
  lines: ReceiptLineAppendWrite[];
}

@Injectable()
export class ReceivingHistoryRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * The GET snapshot: the document, its lines (the ordered quantities the
   * projection compares against) and its receipt history with nested lines —
   * THREE reads in ONE array-form `$transaction`, so the projection cannot
   * describe a different moment than the events rendered beside it (the
   * payment page's precedent). `null` document means absent OR another
   * tenant's — the service answers 404 for both, never distinguishing them.
   *
   * ORDER IS STATED, NEVER INHERITED: receipts by `receivedAt`, then
   * `createdAt`, then `id`; lines by `lineNumber` (contract §9's
   * deterministic technical ordering) — implicit database return order is
   * not an order anyone can rely on.
   */
  async readReceiptHistory(tenantId: string, purchaseDocumentId: string) {
    return this.prisma.$transaction([
      this.prisma.purchaseDocument.findFirst({
        where: { id: purchaseDocumentId, tenantId },
        select: { id: true },
      }),
      this.prisma.purchaseLine.findMany({
        where: { tenantId, purchaseDocumentId },
        orderBy: [{ lineNumber: 'asc' as const }],
        select: { id: true, lineNumber: true, quantity: true },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, purchaseDocumentId },
        orderBy: [
          { receivedAt: 'asc' as const },
          { createdAt: 'asc' as const },
          { id: 'asc' as const },
        ],
        include: {
          lines: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
        },
      }),
    ]);
  }

  /**
   * THE CONCURRENCY HINGE: the document row, LOCKED for the duration of the
   * caller's unit of work (`SELECT … FOR UPDATE`, contract §3-H/§22).
   *
   * Returns the locked row's id, or `null` when no row matched TENANT AND
   * document — so the same statement doubles as the tenant-scoped existence
   * gate of every write path, and a cross-tenant id stays indistinguishable
   * from an absent one (§3-E: 404, never 403, never a probe).
   *
   * Raw SQL stays in the persistence layer and names the `tenant_id` column,
   * as the module's raw-SQL gate requires; the lock is released on commit or
   * rollback — there is nothing a caller could hold.
   *
   * `::uuid` on the id is not decoration: a parameterised value arrives as
   * text, and PostgreSQL has no implicit `text` → `uuid` cast, so the
   * comparison without it fails as `operator does not exist: uuid = text`
   * (the same reason `allocateDocumentNumber` casts its enum parameter).
   */
  async lockDocumentForReceipt(
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
   * The document's lines — the ordered quantities the over-receipt check
   * compares against and the set a receipt line must belong to (contract
   * §10: line ownership is PROVEN against this read, never assumed from a
   * UUID that happens to exist somewhere in the tenant).
   *
   * Mid-transaction, under the lock taken first, so what this returns is the
   * state the append will commit against.
   */
  async listLines(tenantId: string, purchaseDocumentId: string, tx: CommerceTransactionHandle) {
    return unwrapCommerceTransaction(tx).purchaseLine.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [{ lineNumber: 'asc' as const }],
      select: { id: true, lineNumber: true, quantity: true },
    });
  }

  /**
   * The whole receipt history of THIS document in THIS tenant, mid-
   * transaction, with nested lines — the input to BOTH write-time
   * calculations: the per-line received SUM (over-receipt) and the
   * compensation CAP (Σ of the lines already pointing at a target). One
   * query answers both because both are facts about the SAME history, and
   * reading it twice under one lock would be two moments pretending to be
   * one. Order is stated exactly as in `readReceiptHistory` (§9).
   */
  async listByDocument(
    tenantId: string,
    purchaseDocumentId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).receipt.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: [
        { receivedAt: 'asc' as const },
        { createdAt: 'asc' as const },
        { id: 'asc' as const },
      ],
      include: {
        lines: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
      },
    });
  }

  /**
   * One receipt line of THIS document in THIS tenant, or `null` — the 404
   * gate of `POST …/:receiptLineId/compensate`. Scoping by BOTH the document
   * and the tenant (through the parent receipt) means a compensating event
   * can never be pointed at another document's — or another tenant's —
   * receipt line even if its UUID were guessed, and both cases stay
   * indistinguishable from absent (§3-E: 404, never 403).
   */
  async findReceiptLineForCompensation(
    tenantId: string,
    purchaseDocumentId: string,
    receiptLineId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).receiptLine.findFirst({
      where: {
        id: receiptLineId,
        tenantId,
        receipt: { tenantId, purchaseDocumentId },
      },
    });
  }

  /**
   * THE ONLY WRITE in the receiving slice: INSERT one `Receipt` with its
   * `ReceiptLine` children, or refuse.
   *
   * Both of R's writes — an ordinary receiving event and its compensating
   * event — arrive here, because they are the same act (append one event to
   * an append-only history) with different facts stated. Nothing in this
   * method interprets the row: validation lives at the DTO boundary, rules
   * live in the service (the lock, the SUM, the cap), and the projection
   * lives in `receiving-status.ts`. Nested `create` inside the caller's unit
   * of work is what makes header and lines ONE atomic act — a receipt with
   * no lines, or lines with no receipt, is not expressible.
   *
   * `id`s are system-generated (R3): there is no numbering, no counter and
   * no client-stated identity anywhere in this statement.
   */
  async append(tenantId: string, tx: CommerceTransactionHandle, data: ReceiptAppendWrite) {
    return unwrapCommerceTransaction(tx).receipt.create({
      data: {
        tenantId,
        purchaseDocumentId: data.purchaseDocumentId,
        // Absent means "column default (now)"; stated means the caller's instant.
        ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}),
        receiverId: data.receiverId,
        lines: {
          // NOTE: NO `tenantId` here — the relation to the parent receipt is
          // composite `(tenant_id, receipt_id)`, so Prisma INHERITS the shared
          // tenant field from the parent create. Stating it again is rejected
          // by the generated input (`Unknown argument 'tenantId'`), and that
          // inheritance is what makes a line under another tenant's receipt
          // not expressible even as a statement in this file.
          create: data.lines.map((line) => ({
            purchaseLineId: line.purchaseLineId,
            quantity: line.quantity,
            // NULL means none stated, never empty: the link is a fact the
            // server states from the path, never a field a payload carries.
            reversesReceiptLineId: line.reversesReceiptLineId ?? null,
          })),
        },
      },
      include: { lines: true },
    });
  }

  /**
   * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the ONE tenant-scoped read the
   * receiving report's seam answers with — the AGGREGATED FACTS of every purchase
   * line matching the pushable filters, each beside its parent document's number.
   *
   * WHY AN AGGREGATED READ AND NOT A PAGE (the projection's shape decides this):
   * the receiving status is Σ over the line's WHOLE receipt history compared with
   * the line's OWN stored quantity — an AGGREGATE Prisma cannot express in a
   * `where`, so neither the status filter nor a per-status count can be pushed
   * into SQL, and paging a predicate that lives in memory would page the WRONG
   * population. This method returns the source FACTS (ordered, Σ received, latest
   * receiving instant, compensation count) for the candidate set; the READER —
   * which owns the projection (`projectReceivingStatus`, by value), the
   * status/date narrowing, the deterministic order and the page slice — computes
   * the register through ONE pipeline shared by list and summary (see
   * `commerce-receiving-reporting.reader.ts`). Layering matches the return
   * register: repository = storage facts, reader = semantics.
   *
   * WHY NOT RAW SQL: the slice's guard pins `$queryRaw` to EXACTLY ONE statement —
   * the tenant-scoped `FOR UPDATE` lock (`receiving.guards.spec.ts` C) — so a
   * `GROUP BY` here would break this append-only slice's own concurrency record to
   * gain paging this projection cannot honestly honour anyway. The honest cost is
   * recorded instead: the candidate line set and its events are materialized per
   * read, bounded by the tenant's purchase-line population (a limitation of this
   * report, not of the domain).
   *
   * PUSHABLE FILTERS ONLY — document/line id and the document-number search (the
   * same-owner join the payment and return registers search with). Absent keys
   * stay ABSENT. `tenantId` is the first parameter and the first predicate, as
   * everywhere in this file; no `findUnique` appears (the module guard's rule).
   */
  async readReportSourceRows(
    tenantId: string,
    filter: ReceivingReportFilter
  ): Promise<ReceivingReportSourceRow[]> {
    const lines = await this.prisma.purchaseLine.findMany({
      where: ReceivingHistoryRepository.buildReportLineWhere(tenantId, filter),
      // Deterministic input order; the reader applies the register's own sort.
      orderBy: [{ id: 'asc' as const }],
      select: {
        id: true,
        purchaseDocumentId: true,
        quantity: true,
        purchaseDocument: { select: { documentNumber: true } },
      },
    });
    if (lines.length === 0) return [];

    // ONE events read scoped to exactly the candidate lines: Σ, the latest
    // instant and the compensation count are all facts of these rows.
    const events = await this.prisma.receiptLine.findMany({
      where: { tenantId, purchaseLineId: { in: lines.map((line) => line.id) } },
      select: {
        purchaseLineId: true,
        quantity: true,
        reversesReceiptLineId: true,
        receipt: { select: { receivedAt: true } },
      },
    });

    const quantities = new Map<string, string[]>();
    const latest = new Map<string, Date>();
    const compensations = new Map<string, number>();
    for (const event of events) {
      const own = quantities.get(event.purchaseLineId);
      if (own) own.push(String(event.quantity));
      else quantities.set(event.purchaseLineId, [String(event.quantity)]);

      const at = event.receipt.receivedAt;
      const previous = latest.get(event.purchaseLineId);
      if (!previous || at > previous) latest.set(event.purchaseLineId, at);

      if (event.reversesReceiptLineId !== null) {
        compensations.set(
          event.purchaseLineId,
          (compensations.get(event.purchaseLineId) ?? 0) + 1
        );
      }
    }

    return lines.map((line) => ({
      id: line.id,
      purchaseDocumentId: line.purchaseDocumentId,
      purchaseDocumentNumber: line.purchaseDocument.documentNumber,
      // Exact Decimal STRINGs throughout: `sumMoney` is BigInt-scaled (no float
      // ever touches a quantity), and an event-less line's Σ is exactly '0.0000' —
      // the projection's own "nothing received" input.
      orderedQuantity: String(line.quantity),
      receivedQuantity: sumMoney(quantities.get(line.id) ?? []),
      receivedAt: latest.get(line.id) ?? null,
      compensationCount: compensations.get(line.id) ?? 0,
    }));
  }

  /**
   * The report's ONE filter builder — document/line identity and the parent's
   * number, nothing else. Status and the receiving-date window are COMPUTED
   * (projection inputs, not columns) and therefore never appear here: the reader
   * narrows them over the facts this method returns.
   */
  private static buildReportLineWhere(tenantId: string, filter: ReceivingReportFilter) {
    return {
      tenantId,
      ...(filter.purchaseDocumentId ? { purchaseDocumentId: filter.purchaseDocumentId } : {}),
      ...(filter.purchaseLineId ? { id: filter.purchaseLineId } : {}),
      ...(filter.search
        ? {
            purchaseDocument: {
              documentNumber: { contains: filter.search, mode: 'insensitive' as const },
            },
          }
        : {}),
    };
  }
}

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the report's filter — ONLY the fields
 * `buildReportLineWhere` answers. Absent means "no narrowing", never a default.
 * (Status and the receiving-date window are reader-computed over the returned facts.)
 */
export interface ReceivingReportFilter {
  purchaseDocumentId?: string;
  purchaseLineId?: string;
  search?: string;
}

/**
 * The aggregated facts of ONE purchase line as the two reporting reads receive
 * them — stated STRUCTURALLY, never as a Prisma type: the line's identity, its
 * document's number, the line's OWN stored quantity, Σ over its whole receipt
 * history (exact strings), its latest receiving instant (NULL with no events) and
 * how many of its events are compensations. No status here — the reader projects
 * it through the domain's ONE projection.
 */
export interface ReceivingReportSourceRow {
  id: string;
  purchaseDocumentId: string;
  purchaseDocumentNumber: string;
  orderedQuantity: string;
  receivedQuantity: string;
  receivedAt: Date | null;
  compensationCount: number;
}
