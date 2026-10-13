import { Injectable, Logger } from '@nestjs/common';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import {
  COMMERCE_AUDIT_RESOURCE,
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_MAX_PAGE_SIZE,
} from '../commerce.constants';
import { PurchaseRepository } from '../purchase/purchase.repository';
import type { PurchaseDocumentFilter } from '../purchase/purchase.repository';
import { PURCHASE_DOCUMENT_STATUSES } from '../purchase/purchase-status';
import type {
  CommercePurchaseReportPage,
  CommercePurchaseReportQuery,
  CommercePurchaseReportRow,
  CommercePurchaseReportSummary,
  CommercePurchaseReportTimelinePage,
  CommercePurchaseReportingReader,
  CommerceReportingScope,
} from './commerce-purchase-reporting.contract';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Commerce-owned IMPLEMENTATION of the Reporting
 * read contract — the approved seam Reporting reads through, the exact shape
 * `financial-check-request-reporting.reader.ts` established for Financial.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the contract's
 * explicit twelve-field whitelist, so the repository's write surface (create, update,
 * submit, close, the commercial and workflow transitions) stays unreachable by
 * construction rather than by review.
 *
 * List and detail reuse the SAME tenant-scoped repository statements Commerce's own
 * routes read — `listDocumentPage` and `findDocumentById` — so a document can never be
 * described two ways by the two surfaces. The summary counts per status over the SAME
 * filter via one bounded `groupBy`. The timeline proves existence tenant-scoped first,
 * then reads the SAME platform audit trail `PurchaseTimelineService` reads.
 *
 * NOTHING IS INVENTED HERE. No rate, no duration, no SLA, no growth, no derived money,
 * no inferred event, no status the lifecycle does not declare. The one decision this
 * file owns is the zero-fill of the summary over `PURCHASE_DOCUMENT_STATUSES`, and even
 * that completes a count the database produced — it never makes one up.
 */
@Injectable()
export class CommercePurchaseReportingReaderService implements CommercePurchaseReportingReader {
  private readonly logger = new Logger(CommercePurchaseReportingReaderService.name);

  constructor(
    private readonly documents: PurchaseRepository,
    private readonly audit: CommerceAuditGateway
  ) {}

  /**
   * One filtered page of the register, newest first.
   *
   * The page window is resolved HERE as well as in the Reporting DTO: an internal caller
   * that builds a query object without going through validation cannot exceed
   * `COMMERCE_MAX_PAGE_SIZE` either. The window is echoed back, so a caller that sent
   * nothing learns what it received rather than having to infer it.
   */
  async listReportRows(
    scope: CommerceReportingScope,
    query: CommercePurchaseReportQuery
  ): Promise<CommercePurchaseReportPage> {
    const window = resolveReportWindow(query);
    const [rows, total] = await this.documents.listDocumentPage(
      scope.tenantId,
      reportFilter(query),
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
   * Per-status counts over the SAME filter the list answers.
   *
   * EVERY one of the six lifecycle members is returned, even the ones the database did
   * not mention: an absent key would force each consumer to decide whether it means
   * "zero" or "unknown", and two screens answering that differently is how a summary
   * strip starts disagreeing with itself. The zero-fill is over the closed vocabulary
   * `purchase-status.ts` declares — the count is the database's, the shape is the
   * lifecycle's.
   */
  async getReportSummary(
    scope: CommerceReportingScope,
    query: CommercePurchaseReportQuery
  ): Promise<CommercePurchaseReportSummary> {
    const counts = await this.documents.countByStatus(scope.tenantId, reportFilter(query));

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const status of PURCHASE_DOCUMENT_STATUSES) {
      const count = counts.get(status) ?? 0;
      byStatus[status] = count;
      total += count;
    }
    return { total, byStatus };
  }

  /** One document tenant-scoped, or `null` — a foreign id is indistinguishable from an absent one. */
  async getReportRow(
    scope: CommerceReportingScope,
    documentId: string
  ): Promise<CommercePurchaseReportRow | null> {
    const document = await this.documents.findDocumentById(scope.tenantId, documentId);
    if (!document) return null;
    return toReportRow(document);
  }

  /**
   * This document's report timeline — the `commerce.purchase_document` family and
   * nothing else, exactly as `PurchaseTimelineService` constrains its own read.
   *
   * EXISTENCE IS PROVED FIRST, TENANT-SCOPED. Only a document this tenant owns reaches
   * the audit boundary, so the audit query can never become the thing that answers "does
   * this id exist somewhere?".
   *
   * EMPTY IS NOT FAILED: a successful read with zero events answers `items: []` with the
   * platform's `total`. A REJECTED read is a typed failure carrying the platform's closed
   * code — never a quiet empty page, because the two states mean opposite things.
   */
  async getReportTimeline(
    scope: CommerceReportingScope,
    documentId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<CommercePurchaseReportTimelinePage> {
    const document = await this.documents.findDocumentById(scope.tenantId, documentId);
    if (!document) return { items: [], page: 1, pageSize: 20, total: 0 };

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: document.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      // The diagnostic classification is preserved at this boundary: the CLOSED platform
      // code is logged and carried to the caller, never an internal error message and
      // never a fabricated `items: []`.
      this.logger.error(
        `Reporting audit read rejected for purchase document ${document.id}: ${result.code}`
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

/** What a read of one document returns — the document plus its lines, author-ordered. */
type PurchaseDocumentRecord = NonNullable<
  Awaited<ReturnType<PurchaseRepository['findDocumentById']>>
>;

/**
 * The Commerce page-size pair — one place the report resolves its window.
 *
 * Both bounds are the module's own constants (`COMMERCE_MAX_PAGE_SIZE` /
 * `COMMERCE_DEFAULT_PAGE_SIZE`), so a Commerce list and a report over Commerce answer
 * "how big may a page be?" identically. The clamp is the GUARANTEE for callers that
 * never went through the DTO; the DTO remains the CONTRACT that can tell a client it
 * asked for something wrong.
 */
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
 * A stored `Decimal(18,4)` as the wire STRING, or `null`.
 *
 * Passed through, never converted to a JavaScript number first: a total is the last
 * value that may lose a digit on the way out. NULL stays NULL — "not priced yet" is
 * not `0` and must not render as one. (Shape note, recorded honestly: the driver
 * trims the column's trailing zeros — `1260`, not `1260.0000` — exactly as it does
 * for Commerce's own wire; the invariant is exact amounts, not decimal shape.)
 */
function money(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Projects a stored row onto the twelve reporting fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, two actor ids, three version
 * pins and `updatedAt`, and none of them is on this report. A spread-through would
 * publish the next column the schema gains without this file ever deciding it is safe
 * for this surface.
 *
 * `lineCount` is derived from the lines the SAME read already loaded — no second
 * query, no N+1, and a number the register genuinely answers ("how big is this
 * request?"). It is a COUNT of rows that exist, not a figure computed from them.
 */
function toReportRow(document: PurchaseDocumentRecord): CommercePurchaseReportRow {
  return {
    id: document.id,
    documentNumber: document.documentNumber,
    kind: document.kind,
    status: document.status,
    supplierId: document.supplierId,
    currency: document.currency,
    subtotalAmount: money(document.subtotalAmount),
    taxAmount: money(document.taxAmount),
    totalAmount: money(document.totalAmount),
    lineCount: document.lines.length,
    completedAt: document.completedAt ? document.completedAt.toISOString() : null,
    createdAt: document.createdAt.toISOString(),
  };
}

/**
 * Phase KPI-RUNTIME: the FILTER half of a report query — ONE place the page read and the
 * summary read turn a contract query into the repository's filter shape.
 *
 * ABSENT KEYS STAY ABSENT (every key spread conditionally), so a caller that names no filter
 * reaches the repository with exactly the object it did before the date-window extension —
 * which keeps the register, its summary and the four report surfaces byte-identical.
 */
function reportFilter(query: CommercePurchaseReportQuery): PurchaseDocumentFilter {
  return {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
    ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
    ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
    ...(query.completedFrom !== undefined ? { completedFrom: query.completedFrom } : {}),
    ...(query.completedTo !== undefined ? { completedTo: query.completedTo } : {}),
  };
}
