import { Injectable, Logger } from '@nestjs/common';
import { ProductionAuditGateway } from '../production-audit.gateway';
import {
  PRODUCTION_AUDIT_RESOURCE,
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
} from '../production.constants';
import {
  BomChangeRequestRepository,
  type BomChangeRequestWithItemCount,
} from '../bom-change/bom-change.repository';
import { BOM_STATUSES } from '../bom/bom-status';
import type {
  ProductionBomChangeReportPage,
  ProductionBomChangeReportQuery,
  ProductionBomChangeReportRow,
  ProductionBomChangeReportSummary,
  ProductionBomChangeReportTimelinePage,
  ProductionBomChangeReportingReader,
  ProductionBomChangeReportingScope,
} from './production-bom-change-reporting.contract';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Production-owned IMPLEMENTATION of
 * the change-request Reporting read contract — the approved seam Reporting reads through,
 * the exact shape the three sibling readers established.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the contract's
 * explicit ELEVEN-field whitelist, so the repository's write surface (create, patch, the
 * detail-row writes, submit, the three decision acts) stays unreachable by construction
 * rather than by review. The detail rows' coefficient snapshots NEVER leave the row: the
 * count of them (`itemCount`) is the only thing this projection carries about them.
 *
 * List and detail reuse the SAME tenant-scoped repository statements built from the ONE
 * predicate builder the register itself uses — `listWithItemCount` and
 * `findByIdWithItemCount` over `buildListWhere` — so a change request can never be
 * described two ways by the two surfaces. The summary counts per status over the SAME
 * filter via one bounded `groupBy`. The timeline proves existence tenant-scoped first,
 * then reads the SAME platform audit trail Production's own change-request timeline reads
 * (`production.bom.change` — the resource ALL nine audited families write with
 * `resourceId = <change request id>`).
 *
 * NOTHING IS INVENTED HERE. No rate, no cycle time, no aging, no inferred event, no
 * status the lifecycle does not declare. The one decision this file owns is the zero-fill
 * of the summary over `BOM_STATUSES`, and even that completes a count the database
 * produced — it never makes one up.
 */
@Injectable()
export class ProductionBomChangeReportingReaderService implements ProductionBomChangeReportingReader {
  private readonly logger = new Logger(ProductionBomChangeReportingReaderService.name);

  constructor(
    private readonly requests: BomChangeRequestRepository,
    private readonly audit: ProductionAuditGateway
  ) {}

  /**
   * One filtered page of the register, newest first (createdAt desc, id asc — the
   * register's deterministic ordering, so two pages can never overlap or skip a row).
   *
   * The page window is resolved HERE as well as in the Reporting DTO: an internal caller
   * that builds a query object without going through validation cannot exceed
   * `PRODUCTION_MAX_PAGE_SIZE` either. The window is echoed back, so a caller that sent
   * nothing learns what it received rather than having to infer it.
   */
  async listReportRows(
    scope: ProductionBomChangeReportingScope,
    query: ProductionBomChangeReportQuery
  ): Promise<ProductionBomChangeReportPage> {
    const window = resolveReportWindow(query);
    const result = await this.requests.listWithItemCount(scope.tenantId, {
      skip: (window.page - 1) * window.pageSize,
      take: window.pageSize,
      ...reportFilter(query),
    });

    return {
      items: result.requests.map(toReportRow),
      total: result.total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /**
   * Per-status counts over the SAME filter the list answers.
   *
   * EVERY one of the four lifecycle members is present — zero-filled over the closed set
   * `BOM_STATUSES` declares — so the strip never has a hole, and the counts come from one
   * bounded `groupBy` over the identical predicate (`buildListWhere`) the page used. A
   * status the lifecycle does not declare can never appear here: the zero-fill loop
   * iterates the pure vocabulary, not the database's keys.
   */
  async getReportSummary(
    scope: ProductionBomChangeReportingScope,
    query: ProductionBomChangeReportQuery
  ): Promise<ProductionBomChangeReportSummary> {
    const counts = await this.requests.countByStatus(scope.tenantId, reportFilter(query));

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
    scope: ProductionBomChangeReportingScope,
    id: string
  ): Promise<ProductionBomChangeReportRow | null> {
    const row = await this.requests.findByIdWithItemCount(scope.tenantId, id);
    if (!row) return null;
    return toReportRow(row);
  }

  /**
   * This request's report timeline — the SAME platform audit trail Production's own
   * `/production/bom-change-requests/:id/timeline` route reads, bound to
   * `production.bom.change` + a row this tenant has already been proven to hold.
   *
   * EMPTY IS NOT FAILED: an unknown (or foreign) id answers an empty page WITHOUT
   * touching the audit port — the port is only ever reached for a row this tenant owns.
   * A REJECTED read is re-thrown with the platform's CLOSED code attached, never
   * converted into a quiet empty timeline; the Reporting service maps it to a 503.
   */
  async getReportTimeline(
    scope: ProductionBomChangeReportingScope,
    id: string,
    query: { page?: number; pageSize?: number }
  ): Promise<ProductionBomChangeReportTimelinePage> {
    const row = await this.requests.findByIdWithItemCount(scope.tenantId, id);
    if (!row) {
      return { items: [], page: 1, pageSize: PRODUCTION_DEFAULT_PAGE_SIZE, total: 0 };
    }

    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      this.logger.error(
        `Reporting audit read rejected for change request ${row.id}: ${result.code}`
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

/** The row as the two reporting reads receive it — a request plus its bounded line count. */
type BomChangeRequestReportRecord = BomChangeRequestWithItemCount;

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
 * Projects a stored row onto the contract's ELEVEN reporting fields.
 *
 * WHITELIST, NOT SPREAD: the row carries `tenantId`, three actor ids, `notes`,
 * `requestDate` and `updatedAt`, and none of them is on this report. A spread-through
 * would publish the next column the schema gains without this file ever deciding it is
 * safe for this surface. `_count.items` is flattened to `itemCount` — the only field
 * whose wire name differs from its storage shape, and the only derived-looking value
 * here (a bounded count of rows that exist, read with the row).
 */
function toReportRow(row: BomChangeRequestReportRecord): ProductionBomChangeReportRow {
  return {
    id: row.id,
    bomId: row.bomId,
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
 * The FILTER half of a report query — ONE place the list read and the summary read turn
 * a contract query into the repository's filter shape.
 *
 * ABSENT KEYS STAY ABSENT. Every key is spread conditionally, so a caller that names no
 * filter reaches the repository with exactly the object the register's own `list` builds,
 * which is what keeps the register, the summary and the report surfaces byte-identical.
 * An empty `search` is dropped for the same reason it always was: `''` is "no search",
 * not "search for nothing".
 */
function reportFilter(query: ProductionBomChangeReportQuery) {
  return {
    ...(query.bomId !== undefined && query.bomId !== '' ? { bomId: query.bomId } : {}),
    ...(query.projectRef !== undefined && query.projectRef !== ''
      ? { projectRef: query.projectRef }
      : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
  };
}
