import { Injectable, Logger } from '@nestjs/common';
import { ProductionAuditGateway } from '../production-audit.gateway';
import {
  PRODUCTION_AUDIT_RESOURCE,
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
} from '../production.constants';
import { BomHeaderRepository } from '../bom/bom.repository';
import type { BomHeaderFilter, BomHeaderWithItemCount } from '../bom/bom.repository';
import { BOM_STATUSES } from '../bom/bom-status';
import type {
  ProductionReportPage,
  ProductionReportQuery,
  ProductionReportRow,
  ProductionReportSummary,
  ProductionReportTimelinePage,
  ProductionReportingReader,
  ProductionReportingScope,
} from './production-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Production-owned IMPLEMENTATION of the
 * Reporting read contract — the approved seam Reporting reads through, the exact shape
 * the Financial and Commerce readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the contract's
 * explicit ten-field whitelist, so the repository's write surface (create, update,
 * submit, the three decision acts) stays unreachable by construction rather than by
 * review.
 *
 * List and detail reuse the SAME tenant-scoped repository statements built from the ONE
 * predicate builder Production's own list reads — `listWithItemCount` and
 * `findByIdWithItemCount` — so a BOM can never be described two ways by the two
 * surfaces. The summary counts per status over the SAME filter via one bounded
 * `groupBy`. The timeline proves existence tenant-scoped first, then reads the SAME
 * platform audit trail Production's own BOM timeline route reads (`production.bom`).
 *
 * NOTHING IS INVENTED HERE. No rate, no duration, no yield, no downtime, no cost, no
 * inferred event, no status the lifecycle does not declare. The one decision this file
 * owns is the zero-fill of the summary over `BOM_STATUSES`, and even that completes a
 * count the database produced — it never makes one up.
 */
@Injectable()
export class ProductionReportingReaderService implements ProductionReportingReader {
  private readonly logger = new Logger(ProductionReportingReaderService.name);

  constructor(
    private readonly headers: BomHeaderRepository,
    private readonly audit: ProductionAuditGateway
  ) {}

  /**
   * One filtered page of the register, newest first.
   *
   * The page window is resolved HERE as well as in the Reporting DTO: an internal caller
   * that builds a query object without going through validation cannot exceed
   * `PRODUCTION_MAX_PAGE_SIZE` either. The window is echoed back, so a caller that sent
   * nothing learns what it received rather than having to infer it.
   */
  async listReportRows(
    scope: ProductionReportingScope,
    query: ProductionReportQuery
  ): Promise<ProductionReportPage> {
    const window = resolveReportWindow(query);
    const result = await this.headers.listWithItemCount(scope.tenantId, {
      skip: (window.page - 1) * window.pageSize,
      take: window.pageSize,
      ...reportFilter(query),
    });

    return {
      items: result.items.map(toReportRow),
      total: result.total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /**
   * Per-status counts over the SAME filter the list answers.
   *
   * EVERY one of the four lifecycle members is present — zero-filled over the closed set
   * `BOM_STATUSES` declares — so the strip never has a hole, and the counts come from
   * one bounded `groupBy` over the identical predicate (`buildListWhere`) the page used.
   * A status the lifecycle does not declare can never appear here: the zero-fill loop
   * iterates the pure vocabulary, not the database's keys.
   */
  async getReportSummary(
    scope: ProductionReportingScope,
    query: ProductionReportQuery
  ): Promise<ProductionReportSummary> {
    const counts = await this.headers.countByStatus(scope.tenantId, reportFilter(query));

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const status of BOM_STATUSES) {
      const count = counts.get(status) ?? 0;
      byStatus[status] = count;
      total += count;
    }
    return { total, byStatus };
  }

  /** One report row, or `null` when the id is unknown OR belongs to another tenant. */
  async getReportRow(
    scope: ProductionReportingScope,
    bomId: string
  ): Promise<ProductionReportRow | null> {
    const row = await this.headers.findByIdWithItemCount(scope.tenantId, bomId);
    if (!row) return null;
    return toReportRow(row);
  }

  /**
   * This BOM's report timeline — the SAME platform audit trail Production's own
   * `/production/boms/:id/timeline` route reads, bound to `production.bom` + a row this
   * tenant has already been proven to hold.
   *
   * EMPTY IS NOT FAILED: an unknown (or foreign) id answers an empty page WITHOUT
   * touching the audit port — the port is only ever reached for a row this tenant owns.
   * A REJECTED read is re-thrown with the platform's CLOSED code attached, never
   * converted into a quiet empty timeline; the Reporting service maps it to a 503.
   */
  async getReportTimeline(
    scope: ProductionReportingScope,
    bomId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<ProductionReportTimelinePage> {
    const row = await this.headers.findByIdWithItemCount(scope.tenantId, bomId);
    if (!row) {
      return { items: [], page: 1, pageSize: PRODUCTION_DEFAULT_PAGE_SIZE, total: 0 };
    }

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      this.logger.error(`Reporting audit read rejected for BOM ${row.id}: ${result.code}`);
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

/** The row as the two reporting reads receive it — a header plus its bounded item count. */
type BomHeaderReportRecord = BomHeaderWithItemCount;

/**
 * The Production page-size pair — one place the report resolves its window.
 *
 * Both bounds are the module's own constants (`PRODUCTION_MAX_PAGE_SIZE` /
 * `PRODUCTION_DEFAULT_PAGE_SIZE`), so a Production list and a report over Production
 * answer "how big may a page be?" identically. The clamp is the GUARANTEE for callers
 * that never went through the DTO; the DTO remains the CONTRACT that can tell a client
 * it asked for something wrong.
 */
function resolveReportWindow(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    PRODUCTION_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? PRODUCTION_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/**
 * Projects a stored row onto the contract's TEN reporting fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, three actor ids, `comments` and
 * `updatedAt`, and none of them is on this report. A spread-through would publish the
 * next column the schema gains without this file ever deciding it is safe for this
 * surface. `_count.items` is flattened to `itemCount` — the only field whose wire name
 * differs from its storage shape, and the only derived-looking value here (a bounded
 * count of rows that exist, read with the row).
 */
function toReportRow(row: BomHeaderReportRecord): ProductionReportRow {
  return {
    id: row.id,
    title: row.title,
    projectRef: row.projectRef,
    productTreeRef: row.productTreeRef,
    status: row.status,
    managerOpinion: row.managerOpinion,
    itemCount: row._count.items,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Phase KPI-RUNTIME: the FILTER half of a report query — ONE place the list read and the
 * summary read turn a contract query into the repository's filter shape.
 *
 * ABSENT KEYS STAY ABSENT. Every key is spread conditionally, so a caller that names no
 * filter reaches the repository with exactly the object it did before the date-window
 * extension — which is what keeps the register, the summary and the four report surfaces
 * byte-identical (and the reader spec's `toHaveBeenCalledWith` assertions exact). An empty
 * `search` is dropped for the same reason it always was: `''` is "no search", not "search
 * for nothing".
 */
function reportFilter(query: ProductionReportQuery): BomHeaderFilter {
  return {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
    ...(query.decidedFrom !== undefined ? { decidedFrom: query.decidedFrom } : {}),
    ...(query.decidedTo !== undefined ? { decidedTo: query.decidedTo } : {}),
  };
}
