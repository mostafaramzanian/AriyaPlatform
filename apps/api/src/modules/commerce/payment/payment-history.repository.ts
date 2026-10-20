import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
import type { PaymentMethod } from './payment-status';

/**
 * Phase C1 Step Q (§5.14, §I16, contract §3-A): the payment history persistence boundary —
 * every statement this slice issues against `commerce_db`, and nothing else.
 *
 * WHY THIS FILE IS A SEVENTH REPOSITORY, NOT AN ANNEX OF THE PURCHASE ONE
 * ----------------------------------------------------------------------
 * `PaymentRecord` is an append-only history whose rows are never rewritten (Q4), while
 * `purchase.repository.ts` owns a lifecycle of conditional UPDATEs. The two surfaces are
 * opposite rules over the same document, and one file cannot both promise "no update
 * exists here" and maintain the document's transitions — so the promise is made here,
 * structurally: this file contains `append` and tenant-scoped reads, and NOT A SINGLE
 * `.update(` / `.delete(` / upsert, which is executable as a guard
 * (`workflow-configuration.repository.spec.ts` pins this file's name AND its method list).
 *
 * APPEND-ONLY IS ENFORCED HERE, NOT IN THE DATABASE (contract §3-A)
 * ----------------------------------------------------------------
 * `commerce_db` has no trigger precedent and Q does not add the first one: a trigger
 * would be a rule invisible to this file's reviewers and untestable by the suite. The
 * schema carries no `updated_at` on `PaymentRecord` (a column that only ever changes once
 * is a lie about mutation), and the only correction mechanism — a compensating row —
 * arrives through the SAME `append` below. A caller therefore has no statement it could
 * issue through this repository to alter a settled row.
 *
 * THE ONE RACE, AND WHERE IT IS ANSWERED
 * --------------------------------------
 * "At most one compensation per row" is enforced by
 * `UNIQUE (tenant_id, reverses_payment_id)` — not by the service's early read, which a
 * concurrent append can beat. When the index refuses a second compensation, `append`
 * translates the driver's unique violation into this module's own
 * `PaymentCompensationTakenError`, so the service answers 409 without importing a driver
 * type. Driver knowledge stays in the persistence layer; the vocabulary of refusals stays
 * in the service (contract §3-E).
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every method and appears in every `where`, as in
 * every repository of this module. `findUnique` is never used: it cannot carry a tenant
 * predicate. The page, its count and the whole history's sum are read in ONE array-form
 * `$transaction` (contract Q9), so the projection cannot describe a different moment than
 * the rows rendered beside it.
 *
 * NO AUDIT, NO EVENT, NO IDENTITY. The persistence layer records nothing beyond its own
 * rows (§I8, and the guard proves the absence): the trail is the service's to write
 * through `CommerceAuditGateway`, one row per append.
 */

/**
 * The structural refusal of a lost compensation race: the target row already has its
 * compensating row, and the UNIQUE index said so before this INSERT landed.
 *
 * A domain error rather than a rethrown driver error, because the service answers 409
 * from it and the service must never name Prisma's error classes (contract §3-E).
 */
export class PaymentCompensationTakenError extends Error {
  constructor() {
    super('the payment already has a compensating row');
    this.name = 'PaymentCompensationTakenError';
  }
}

/** The window a page read takes — resolved (and clamped) by the service's shared DTO. */
export interface PaymentPageWindow {
  skip: number;
  take: number;
}

/** The optional filters `GET …/payments` accepts — they narrow the PAGE, never the sum. */
export interface PaymentPageFilter {
  method?: PaymentMethod | undefined;
  search?: string | undefined;
}

/** One row exactly as `append` writes it — no business rule decides anything here. */
export interface PaymentAppendWrite {
  purchaseDocumentId: string;
  amount: string;
  currency: string | null;
  method: PaymentMethod;
  paymentDate?: Date;
  payerRef?: string | null;
  payeeRef?: string | null;
  invoiceRef?: string | null;
  externalReference?: string | null;
  reversesPaymentId?: string | null;
  recordedByUserId?: string | null;
}

/**
 * The driver's unique-violation signal, read by SHAPE rather than by importing an error
 * class: `paymentRecord.create` can only trip the `reverses_payment_id` unique index (the
 * row id is a fresh UUID and the tenant is the acting one), so any `P2002` from this
 * INSERT is a concurrent compensation landing first.
 *
 * Written as a column-0 initialiser with no statement inside it: the repository guard's
 * signature scan reads every exactly-two-space `name(` line as a public method, and an
 * indented `return (` would appear as a method called `return` that takes no tenant.
 */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

@Injectable()
export class PaymentHistoryRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * The document the history belongs to, reduced to the three facts this slice needs:
   * its id (proof the tenant holds it), its currency (snapshotted onto each append, Q5)
   * and its stored total (the projection's one non-row input, §3-B).
   *
   * This read is the 404 GATE the service runs BEFORE every write: a foreign or unknown
   * id is refused here, indistinguishably (contract §3-E).
   */
  async findDocumentForPayment(
    tenantId: string,
    documentId: string,
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.purchaseDocument.findFirst({
      where: { id: documentId, tenantId },
      select: { id: true, currency: true, totalAmount: true },
    });
  }

  /**
   * One page of the document's history, OLDEST FIRST (§6), together with the count of
   * matching rows and the sum over ALL of the document's rows — three reads in ONE
   * array-form `$transaction` (contract Q9).
   *
   * TWO `where` BUILDS, DELIBERATELY: `where` carries the caller's filters (they narrow
   * the page and its count only), while `history` is unfiltered so the sum — and the
   * status derived from it — cannot change when a user types into a search box. The sum
   * comes back as the aggregate's `Decimal | null` (`null` = no rows at all) and the
   * service renders it as exact money.
   */
  async readPaymentPage(
    tenantId: string,
    purchaseDocumentId: string,
    filter: PaymentPageFilter,
    window: PaymentPageWindow
  ) {
    const where = {
      tenantId,
      purchaseDocumentId,
      ...(filter.method ? { method: filter.method } : {}),
      ...(filter.search
        ? {
            // The row's own references are the ONLY text a payment carries (§13): a
            // search that matched a description nobody stores would match nothing.
            OR: [
              { payerRef: { contains: filter.search, mode: 'insensitive' as const } },
              { payeeRef: { contains: filter.search, mode: 'insensitive' as const } },
              { invoiceRef: { contains: filter.search, mode: 'insensitive' as const } },
              { externalReference: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    // The whole history, unfiltered — Q9's `paymentStatus` input.
    const history = { tenantId, purchaseDocumentId };

    return this.prisma.$transaction([
      this.prisma.paymentRecord.findMany({
        where,
        // `createdAt` is the row's own clock; `id` breaks ties so a page window is
        // deterministic even for rows appended in the same instant.
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.paymentRecord.count({ where }),
      this.prisma.paymentRecord.aggregate({ where: history, _sum: { amount: true } }),
    ]);
  }

  /**
   * One payment row of THIS document in THIS tenant, or `null` — the 404 gate of
   * `POST …/:paymentId/compensate`. Scoping by both the document and the tenant means a
   * compensating row can never be pointed at another document's payment, and a cross-
   * tenant id stays indistinguishable from an absent one (§3-E: 404, never 403).
   */
  /**
   * Phase W4-C (lock-order unification): the DOCUMENT row, LOCKED `FOR UPDATE`
   * inside the caller's unit of work. Every path that mutates payment or
   * lifecycle state of one purchase serializes on the SAME first lock —
   * `PurchaseDocument` then `PaymentRecord` then the aggregates — so a
   * manual compensation (payment lock → doc `FOR KEY SHARE` at INSERT) and a
   * return refund (doc lock → payment lock) can never form a wait cycle.
   * The lock doubles as the tenant-scoped 404 gate.
   */
  async lockDocumentForPayment(
    tenantId: string,
    documentId: string,
    tx: CommerceTransactionHandle
  ): Promise<{ id: string } | null> {
    const rows = await unwrapCommerceTransaction(tx).$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PurchaseDocument"
      WHERE "tenant_id" = ${tenantId} AND "id" = ${documentId}::uuid
      FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Phase W4-B (repeated partial refunds): the ORIGINAL payment row, LOCKED
   * `FOR UPDATE` inside the caller's unit of work. This is the replacement
   * for the dropped one-compensation unique index: every compensation of a
   * payment — manual or return-driven — serializes on its row, so two raced
   * refunds cannot both observe the same remaining capacity. Scoping by
   * tenant AND id doubles the lock as the cross-tenant gate (absent is
   * indistinguishable from foreign).
   */
  async lockPaymentForCompensation(
    tenantId: string,
    paymentId: string,
    tx: CommerceTransactionHandle
  ): Promise<{ id: string } | null> {
    const rows = await unwrapCommerceTransaction(tx).$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PaymentRecord"
      WHERE "tenant_id" = ${tenantId} AND "id" = ${paymentId}::uuid
      FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Σ of the compensation rows a payment already carries — negative figures.
   * Read under `lockPaymentForCompensation`, so the capacity check
   * `amount + Σcompensations >= 0` cannot be raced by a concurrent refund.
   */
  async sumCompensations(
    tenantId: string,
    reversesPaymentId: string,
    tx: CommerceTransactionHandle
  ) {
    const aggregate = await unwrapCommerceTransaction(tx).paymentRecord.aggregate({
      where: { tenantId, reversesPaymentId },
      _sum: { amount: true },
    });
    return aggregate._sum.amount;
  }

  async findPaymentForCompensation(
    tenantId: string,
    purchaseDocumentId: string,
    paymentId: string,
    tx?: CommerceTransactionHandle
  ) {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.paymentRecord.findFirst({
      where: { id: paymentId, tenantId, purchaseDocumentId },
    });
  }

  /**
   * THE ONLY WRITE in the payment slice: INSERT one row, or refuse.
   *
   * Both of Q's writes — an ordinary payment and its compensating row — arrive here,
   * because they are the same act (append one event to an append-only history) with
   * different facts stated. Nothing in this method interprets the row: validation lives
   * at the DTO boundary, rules live in the service, and the projection lives in
   * `payment-status.ts`. The ONLY decision this method makes is the one only it can make:
   * translating a lost race on the compensation unique index into the domain error the
   * service answers 409 from.
   *
   * `tx`, AND WHY IT IS NOT DECORATION (Step U's finding, measured end to end). This table
   * declares `FOREIGN KEY (tenant_id, purchase_document_id) → PurchaseDocument`, so this
   * INSERT takes PostgreSQL's `FOR KEY SHARE` on the document row — and `FOR KEY SHARE`
   * CONFLICTS with the `FOR UPDATE` a caller's unit of work may already hold on that same
   * row. On a SECOND connection the INSERT then waits on the caller's own lock until
   * Prisma's interactive-transaction timeout (5 s) kills the caller: S's refund answered
   * 500 while its compensating row landed ALONE. Issued through the handle, the INSERT runs
   * on the CALLER's connection inside the CALLER's transaction, which already holds the row
   * — no second waiter, and the compensation commits or rolls back WITH the act that asked
   * for it. Absent the handle (Q's own route), the append is its own statement as before.
   */
  async append(
    tenantId: string,
    data: PaymentAppendWrite,
    outbox?: CommerceAuditOutboxPayload,
    tx?: CommerceTransactionHandle
  ) {
    const createData = {
      tenantId,
      purchaseDocumentId: data.purchaseDocumentId,
      amount: data.amount,
      currency: data.currency,
      method: data.method,
      // Absent means "row default (now)" — §3-D; stated means the caller's instant.
      ...(data.paymentDate ? { paymentDate: data.paymentDate } : {}),
      // NULL means none stated, never empty (§13): the row carries its OWN
      // references, and a compensation inherits none of the original's.
      payerRef: data.payerRef ?? null,
      payeeRef: data.payeeRef ?? null,
      invoiceRef: data.invoiceRef ?? null,
      externalReference: data.externalReference ?? null,
      reversesPaymentId: data.reversesPaymentId ?? null,
      recordedByUserId: data.recordedByUserId ?? null,
    };
    try {
      if (tx) {
        const client = unwrapCommerceTransaction(tx);
        const row = await client.paymentRecord.create({ data: createData });
        if (outbox) {
          await client.auditOutbox.create({ data: outbox });
        }
        return row;
      }
      if (outbox) {
        // Standalone payment append: wrap in a transaction for atomicity
        return await this.prisma.$transaction(async (txClient) => {
          const row = await txClient.paymentRecord.create({ data: createData });
          await txClient.auditOutbox.create({ data: outbox });
          return row;
        });
      }
      return await this.prisma.paymentRecord.create({ data: createData });
    } catch (error) {
      if (isUniqueViolation(error)) throw new PaymentCompensationTakenError();
      throw error;
    }
  }

  /**
   * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the ONE filter builder the report's THREE
   * reads share (the `PurchaseRepository.buildDocumentWhere` precedent), so the page, the
   * method counts and the detail read can never disagree about what a filter meant.
   *
   * `search` matches the row's OWN opaque references (`payerRef`/`payeeRef`/`invoiceRef`/
   * `externalReference`) OR the parent document's number through the same-owner relation —
   * «the row's own references are the only text a payment carries» (this file's header)
   * plus the one identifier a tenant-wide register must answer «which document» with.
   * `paymentFrom/paymentTo` are HALF-OPEN `[from, to)` ISO instants on `paymentDate` —
   * `gte` on the lower bound, `lt` on the upper, exactly as the purchase register's
   * KPI-RUNTIME windows state it. Absent keys stay ABSENT: a caller that names no filter
   * reaches Prisma with an unfiltered predicate — never a defaulted one.
   */
  private static buildReportWhere(filter: PaymentReportFilter) {
    return {
      ...(filter.method ? { method: filter.method } : {}),
      ...(filter.purchaseDocumentId ? { purchaseDocumentId: filter.purchaseDocumentId } : {}),
      ...(filter.search
        ? {
            OR: [
              { payerRef: { contains: filter.search, mode: 'insensitive' as const } },
              { payeeRef: { contains: filter.search, mode: 'insensitive' as const } },
              { invoiceRef: { contains: filter.search, mode: 'insensitive' as const } },
              { externalReference: { contains: filter.search, mode: 'insensitive' as const } },
              {
                purchaseDocument: {
                  documentNumber: { contains: filter.search, mode: 'insensitive' as const },
                },
              },
            ],
          }
        : {}),
      ...(filter.paymentFrom !== undefined || filter.paymentTo !== undefined
        ? {
            paymentDate: {
              ...(filter.paymentFrom !== undefined ? { gte: filter.paymentFrom } : {}),
              ...(filter.paymentTo !== undefined ? { lt: filter.paymentTo } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: ONE page of the tenant's payment history
   * plus its count, newest `paymentDate` first, with the parent document's number joined
   * for display.
   *
   * WHY A SECOND READ SURFACE EXISTS AT ALL: `readPaymentPage` above answers ONE document
   * at a time (and carries that document's whole-history status projection beside it),
   * while the report register spans every payment of the tenant. Same owner, same table,
   * same tenant-first predicate — the shared `buildReportWhere` above. The `[rows, count]`
   * pair is one array-form `$transaction`, so the total cannot describe a different
   * moment than the page rendered beside it. ORDER: `paymentDate` DESC (the report's
   * primary date), `id` ASC as the deterministic tie-break. The `purchaseDocument`
   * include is the SAME-DATABASE display join this file already owns (payment → document
   * is its declared cross-slice READ seam), never a second query per row, never an N+1.
   */
  async listReportPage(
    tenantId: string,
    filter: PaymentReportFilter,
    window: { skip: number; take: number }
  ) {
    const where = { tenantId, ...PaymentHistoryRepository.buildReportWhere(filter) };
    const include = { purchaseDocument: { select: { documentNumber: true } } } as const;

    return this.prisma.$transaction([
      this.prisma.paymentRecord.findMany({
        where,
        orderBy: [{ paymentDate: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
        include,
      }),
      this.prisma.paymentRecord.count({ where }),
    ]);
  }

  /**
   * Per-method counts over the SAME filter the page answers — ONE bounded `groupBy`, no
   * rows materialised (the `countByStatus` reasoning), and the SAME `buildReportWhere`.
   * `Map<PaymentMethod, number>` so a caller that forgets to zero-fill reads `undefined`
   * for an absent method rather than a plausible `0` it never asked for.
   */
  async countReportByMethod(
    tenantId: string,
    filter: PaymentReportFilter
  ): Promise<Map<PaymentMethod, number>> {
    const where = { tenantId, ...PaymentHistoryRepository.buildReportWhere(filter) };

    const rows = await this.prisma.paymentRecord.groupBy({
      by: ['method'],
      where,
      _count: { method: true },
    });

    return new Map(rows.map((row) => [row.method, row._count.method]));
  }

  /**
   * One payment row plus its parent document's number, or `null` for an id this tenant
   * does not hold — cross-tenant and absent are the SAME answer (the report service maps
   * either to a 404, so existence never leaks). `findFirst` with an explicit tenant
   * predicate, never `findUnique`: the module-wide guard's rule, stated here too.
   */
  async findReportRow(tenantId: string, paymentId: string) {
    return this.prisma.paymentRecord.findFirst({
      where: { tenantId, id: paymentId },
      include: { purchaseDocument: { select: { documentNumber: true } } },
    });
  }
}

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the report register's filter — ONLY the
 * fields `buildReportWhere` answers. Absent means "no narrowing", never a default.
 */
export interface PaymentReportFilter {
  method?: PaymentMethod;
  search?: string;
  purchaseDocumentId?: string;
  paymentFrom?: Date;
  paymentTo?: Date;
}
