import { BadRequestException, Injectable } from '@nestjs/common';
import { COMMERCE_DEFAULT_PAGE_SIZE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import {
  PaymentHistoryRepository,
  type PaymentReportFilter,
} from '../payment/payment-history.repository';
import { PAYMENT_METHODS, type PaymentMethod } from '../payment/payment-status';
import type {
  CommercePaymentReportPage,
  CommercePaymentReportQuery,
  CommercePaymentReportRow,
  CommercePaymentReportSummary,
  CommercePaymentReportingReader,
  CommercePaymentReportingScope,
} from './commerce-payment-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Commerce-owned IMPLEMENTATION of the
 * Reporting read contract — the approved seam Reporting reads through, the exact shape
 * the purchase and the six sibling readers established.
 *
 * The adapter exposes ONLY the three contract reads, each projected onto the contract's
 * explicit twelve-field whitelist, so the repository's write surface (append, compensate)
 * stays unreachable by construction. List and detail reuse the SAME tenant-scoped
 * repository statements this phase added beside the register's own reads
 * (`listReportPage`, `findReportRow`), and the summary counts per METHOD over the SAME
 * filter through ONE bounded `groupBy` on the ONE shared predicate builder — page,
 * counts and detail can never disagree about what a filter meant.
 *
 * Nothing is invented here: no status (a per-document projection, never a row fact), no
 * rate, no duration, no money total, no inferred event. The one decision this file owns
 * is the zero-fill of the summary over `PAYMENT_METHODS`, and even that completes counts
 * the database produced. The inverted window (`paymentTo` before `paymentFrom`) and a
 * malformed instant are refused here with the SAME 400 the DTO family answers — before
 * any statement is issued (the HR mission reader's refusal pattern).
 */

/** The row as the two reporting reads receive it — stated structurally, never as a Prisma type. */
interface PaymentReportRecord {
  id: string;
  purchaseDocumentId: string;
  purchaseDocument: { documentNumber: string };
  amount: unknown;
  currency: string | null;
  method: PaymentMethod | string;
  paymentDate: Date;
  payerRef: string | null;
  payeeRef: string | null;
  invoiceRef: string | null;
  externalReference: string | null;
  reversesPaymentId: string | null;
}

@Injectable()
export class CommercePaymentReportingReaderService implements CommercePaymentReportingReader {
  constructor(private readonly payments: PaymentHistoryRepository) {}

  /** One filtered page of the tenant's payment register, newest `paymentDate` first. */
  async listReportRows(
    scope: CommercePaymentReportingScope,
    query: CommercePaymentReportQuery
  ): Promise<CommercePaymentReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.payments.listReportPage(
      scope.tenantId,
      toRepositoryFilter(query),
      { skip: (window.page - 1) * window.pageSize, take: window.pageSize }
    );

    return {
      items: rows.map(toReportRow),
      total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /** Per-method counts over the SAME filter the list answers — one `groupBy`, zero-filled. */
  async getReportSummary(
    scope: CommercePaymentReportingScope,
    query: CommercePaymentReportQuery
  ): Promise<CommercePaymentReportSummary> {
    const filter = toRepositoryFilter(query);
    const [counts, page] = await Promise.all([
      this.payments.countReportByMethod(scope.tenantId, filter),
      this.payments.listReportPage(scope.tenantId, filter, { skip: 0, take: 1 }),
    ]);

    const byMethod: Record<string, number> = {};
    for (const method of PAYMENT_METHODS) {
      byMethod[method] = counts.get(method) ?? 0;
    }

    return { total: page[1], byMethod };
  }

  /** One report row, or `null` for another tenant's row — never a partial row or a throw. */
  async getReportRow(
    scope: CommercePaymentReportingScope,
    paymentId: string
  ): Promise<CommercePaymentReportRow | null> {
    const row = await this.payments.findReportRow(scope.tenantId, paymentId);
    return row ? toReportRow(row) : null;
  }
}

/** The Commerce page-size pair — one place the report resolves its window (DTO = contract, clamp = guarantee). */
function resolveReportWindow(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    COMMERCE_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/**
 * The wire query → the repository's OWN filter shape. Unstated keys stay ABSENT (every
 * key spread conditionally), so a caller that names no filter reaches the repository
 * with exactly the object an unfiltered read answers with — never a defaulted one.
 */
function toRepositoryFilter(query: CommercePaymentReportQuery): PaymentReportFilter {
  const paymentFrom = query.paymentFrom
    ? parseReportInstant(query.paymentFrom, 'paymentFrom')
    : undefined;
  const paymentTo = query.paymentTo ? parseReportInstant(query.paymentTo, 'paymentTo') : undefined;
  if (paymentFrom && paymentTo && paymentTo < paymentFrom) {
    throw new BadRequestException('paymentTo must not precede paymentFrom.');
  }

  return {
    ...(query.method !== undefined ? { method: query.method } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
    ...(query.purchaseDocumentId !== undefined
      ? { purchaseDocumentId: query.purchaseDocumentId }
      : {}),
    ...(paymentFrom !== undefined ? { paymentFrom } : {}),
    ...(paymentTo !== undefined ? { paymentTo } : {}),
  };
}

/** ISO 8601 → the instant Prisma stores — refusing what the JS parser would silently roll over. */
function parseReportInstant(value: string, field: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO 8601 instant`);
  }
  return instant;
}

/**
 * Projects a stored row onto the contract's twelve fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, `recordedByUserId` and `createdAt`,
 * and none of them is on this report — a spread-through would publish the next column
 * the schema gains without this file ever deciding it is safe for this surface. Money is
 * the exact stored `Decimal(18,4)` STRING; `paymentDate` stays ISO (a moment stripped of
 * its offset is a different moment).
 */
function toReportRow(row: PaymentReportRecord): CommercePaymentReportRow {
  return {
    id: row.id,
    purchaseDocumentId: row.purchaseDocumentId,
    purchaseDocumentNumber: row.purchaseDocument.documentNumber,
    amount: String(row.amount),
    currency: row.currency,
    method: row.method,
    paymentDate: row.paymentDate.toISOString(),
    payerRef: row.payerRef,
    payeeRef: row.payeeRef,
    invoiceRef: row.invoiceRef,
    externalReference: row.externalReference,
    reversesPaymentId: row.reversesPaymentId,
  };
}
