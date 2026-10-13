import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import {
  COMMERCE_AUDIT_RESOURCE,
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_MAX_PAGE_SIZE,
} from '../commerce.constants';
import {
  ReturnHistoryRepository,
  type ReturnReportFilter,
} from '../returns/return-history.repository';
import { projectReturnState, RETURN_STATES, type ReturnState } from '../returns/return-lifecycle';
import type {
  CommerceReturnReportDetail,
  CommerceReturnReportPage,
  CommerceReturnReportQuery,
  CommerceReturnReportRow,
  CommerceReturnReportSummary,
  CommerceReturnReportTimelinePage,
  CommerceReturnLifecycleReportingReader,
  CommerceReturnReportingScope,
} from './return-lifecycle-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Commerce-owned IMPLEMENTATION of the
 * Reporting read contract — the approved seam Reporting reads through, the exact
 * shape the purchase and payment readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the
 * contract's explicit whitelist, so the repository's write surface (appendReturn,
 * appendTransition — the locked quantity invariant and the four lifecycle commands)
 * stays unreachable by construction rather than by review.
 *
 * List, summary and detail reuse the SAME tenant-scoped repository statements this
 * phase added beside the slice's own reads (`listReportPage`, `countReportByState`,
 * `findReportRow`) on the ONE shared filter builder — page, counts and detail can
 * never disagree about what a filter meant.
 *
 * NOTHING IS INVENTED HERE. No money, no rate, no duration, no SLA, no aging, no
 * inferred event, no state the matrix does not declare. Two decisions this file
 * owns, and nothing more:
 *  * the zero-fill of the summary over `RETURN_STATES` (completing counts the
 *    database produced — it never makes one up);
 *  * projecting each row's `state` through `projectReturnState` — the SAME pure
 *    module the domain's commands use, imported BY VALUE, never re-typed here.
 *    An impossible history throws (as it does on Commerce's own screen): a bug that
 *    projects a fabricated state is worse than one that fails loudly.
 *
 * The inverted window (`createdTo` before `createdFrom`) and a malformed instant are
 * refused here with the SAME 400 the DTO family answers — before any statement is
 * issued (the payment reader's refusal pattern).
 */

/** The row as the two reporting reads receive it — stated structurally, never as a Prisma type. */
interface ReturnReportRecord {
  id: string;
  purchaseDocumentId: string;
  purchaseDocument: { documentNumber: string };
  reason: string;
  replacementRequired: boolean;
  createdAt: Date;
  _count: { lines: number };
  transitions: { id: string; state: ReturnState; createdAt: Date }[];
}

/** The detail read's row: the list row's fields plus the line contents. */
interface ReturnDetailRecord extends ReturnReportRecord {
  lines: {
    id: string;
    purchaseLineId: string;
    receiptLineId: string;
    quantity: unknown;
    createdAt: Date;
  }[];
}

@Injectable()
export class CommerceReturnLifecycleReportingReaderService implements CommerceReturnLifecycleReportingReader {
  private readonly logger = new Logger(CommerceReturnLifecycleReportingReaderService.name);

  constructor(
    private readonly returns: ReturnHistoryRepository,
    private readonly audit: CommerceAuditGateway
  ) {}

  /** One filtered page of the tenant's return register, newest `createdAt` first. */
  async listReportRows(
    scope: CommerceReturnReportingScope,
    query: CommerceReturnReportQuery
  ): Promise<CommerceReturnReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.returns.listReportPage(
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

  /**
   * Per-state counts over the SAME filter the list answers — five predicate counts
   * on the SAME shared builder, zero-filled over `RETURN_STATES`, `total` summed
   * from those same counts (never recounted from a page).
   */
  async getReportSummary(
    scope: CommerceReturnReportingScope,
    query: CommerceReturnReportQuery
  ): Promise<CommerceReturnReportSummary> {
    const counts = await this.returns.countReportByState(scope.tenantId, toRepositoryFilter(query));

    const byState: Record<string, number> = {};
    let total = 0;
    for (const state of RETURN_STATES) {
      const count = counts.get(state) ?? 0;
      byState[state] = count;
      total += count;
    }
    return { total, byState };
  }

  /** One report row with its lines, or `null` for another tenant's row — never a partial row or a throw. */
  async getReportRow(
    scope: CommerceReturnReportingScope,
    returnId: string
  ): Promise<CommerceReturnReportDetail | null> {
    const row = await this.returns.findReportRow(scope.tenantId, returnId);
    return row ? toReportDetail(row) : null;
  }

  /**
   * This return's report timeline — the `commerce.return_document` family and nothing
   * else, exactly as `return-history.service.ts` constrains its own writes (five
   * actions, `resourceId = return document id`, one row per successful command).
   *
   * EXISTENCE IS PROVED FIRST, TENANT-SCOPED. Only a return this tenant owns reaches
   * the audit boundary, so the audit query can never become the thing that answers
   * "does this id exist somewhere?".
   *
   * EMPTY IS NOT FAILED: a successful read with zero events answers `items: []` with
   * the platform's `total`. A REJECTED read is a typed failure carrying the platform's
   * closed code — never a quiet empty page, because the two states mean opposite things.
   */
  async getReportTimeline(
    scope: CommerceReturnReportingScope,
    returnId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<CommerceReturnReportTimelinePage> {
    const row = await this.returns.findReportRow(scope.tenantId, returnId);
    if (!row) return { items: [], page: 1, pageSize: 20, total: 0 };

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      // The diagnostic classification is preserved at this boundary: the CLOSED platform
      // code is logged and carried to the caller, never an internal error message and
      // never a fabricated `items: []`.
      this.logger.error(
        `Reporting audit read rejected for return document ${row.id}: ${result.code}`
      );
      throw Object.assign(new Error('Audit history is temporarily unavailable.'), {
        code: result.code,
      });
    }

    return {
      items: result.page.items.map((item) => ({
        id: item.id,
        action: item.action,
        actorId: item.actorId,
        success: item.success,
        reason: item.reason,
        changedFields: item.changedFields,
        createdAt: item.createdAt,
      })),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
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
function toRepositoryFilter(query: CommerceReturnReportQuery): ReturnReportFilter {
  const createdFrom = query.createdFrom
    ? parseReportInstant(query.createdFrom, 'createdFrom')
    : undefined;
  const createdTo = query.createdTo ? parseReportInstant(query.createdTo, 'createdTo') : undefined;
  if (createdFrom && createdTo && createdTo < createdFrom) {
    throw new BadRequestException('createdTo must not precede createdFrom.');
  }

  return {
    ...(query.state !== undefined ? { state: query.state } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
    ...(query.purchaseDocumentId !== undefined
      ? { purchaseDocumentId: query.purchaseDocumentId }
      : {}),
    ...(createdFrom !== undefined ? { createdFrom } : {}),
    ...(createdTo !== undefined ? { createdTo } : {}),
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
 * Projects a stored row onto the contract's eight fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId` (absent from the repository's
 * select), `requestedByUserId` (also unselected) and the raw transitions — and none
 * of them publishes itself. The `state` is NOT read off a column (there is none):
 * it is `projectReturnState` over this row's ordered transitions — the domain's own
 * projection, throwing on an impossible history exactly as Commerce's own routes do.
 */
function toReportRow(row: ReturnReportRecord): CommerceReturnReportRow {
  return {
    id: row.id,
    purchaseDocumentId: row.purchaseDocumentId,
    purchaseDocumentNumber: row.purchaseDocument.documentNumber,
    state: projectReturnState(row.transitions),
    reason: row.reason,
    replacementRequired: row.replacementRequired,
    lineCount: row._count.lines,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The detail projection: the row above plus its lines, quantities as the stored decimal STRINGS. */
function toReportDetail(row: ReturnDetailRecord): CommerceReturnReportDetail {
  return {
    ...toReportRow(row),
    lines: row.lines.map((line) => ({
      id: line.id,
      purchaseLineId: line.purchaseLineId,
      receiptLineId: line.receiptLineId,
      quantity: String(line.quantity),
      createdAt: line.createdAt.toISOString(),
    })),
  };
}
