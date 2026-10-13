import { Injectable, Logger } from '@nestjs/common';
import { CheckRequestRepository } from '../check-request/check-request.repository';
import type { CheckRequestFilter, CheckRequestRecord } from '../check-request/check-request.repository';
import { CHECK_REQUEST_STATUSES } from '../check-request/check-request-status';
import {
  FINANCIAL_AUDIT_RESOURCE,
  FINANCIAL_DEFAULT_PAGE_SIZE,
  FINANCIAL_MAX_PAGE_SIZE,
} from '../financial.constants';
import { FinancialAuditGateway } from '../financial-audit.gateway';
import type {
  FinancialCheckRequestReportPage,
  FinancialCheckRequestReportQuery,
  FinancialCheckRequestReportRow,
  FinancialCheckRequestReportSummary,
  FinancialCheckRequestReportTimelinePage,
  FinancialCheckRequestReportingReader,
  FinancialReportingScope,
} from './financial-check-request-reporting.contract';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Financial-owned IMPLEMENTATION of
 * the Reporting read contract — the approved seam Reporting reads through.
 *
 * The adapter exposes ONLY the four contract reads, each projected onto the
 * contract's explicit whitelist, so the repository's write surface stays
 * unreachable by construction. List/detail reuse the SAME tenant-scoped
 * repository statements the Financial routes read; the summary counts per
 * status over the SAME filter via bounded aggregation; the timeline proves
 * existence tenant-scoped first, then reads the SAME platform audit trail.
 */
@Injectable()
export class FinancialCheckRequestReportingReaderService implements FinancialCheckRequestReportingReader {
  private readonly logger = new Logger(FinancialCheckRequestReportingReaderService.name);

  constructor(
    private readonly requests: CheckRequestRepository,
    private readonly audit: FinancialAuditGateway
  ) {}

  async listReportRows(
    scope: FinancialReportingScope,
    query: FinancialCheckRequestReportQuery
  ): Promise<FinancialCheckRequestReportPage> {
    const window = resolveReportWindow(query);
    const result = await this.requests.list(scope.tenantId, {
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

  async getReportSummary(
    scope: FinancialReportingScope,
    query: FinancialCheckRequestReportQuery
  ): Promise<FinancialCheckRequestReportSummary> {
    const counts = await this.requests.countByStatus(scope.tenantId, reportFilter(query));
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const status of CHECK_REQUEST_STATUSES) {
      const count = counts.get(status) ?? 0;
      byStatus[String(status)] = count;
      total += count;
    }
    return { total, byStatus };
  }

  async getReportRow(
    scope: FinancialReportingScope,
    requestId: string
  ): Promise<FinancialCheckRequestReportRow | null> {
    const row = await this.requests.findWithStages(scope.tenantId, requestId);
    if (!row) return null;
    return toReportRow(row);
  }

  async getReportTimeline(
    scope: FinancialReportingScope,
    requestId: string,
    query: { page?: number; pageSize?: number }
  ): Promise<FinancialCheckRequestReportTimelinePage> {
    const row = await this.requests.findWithStages(scope.tenantId, requestId);
    if (!row) return { items: [], page: 1, pageSize: 20, total: 0 };
    const window = resolveReportWindow(query);
    const result = await this.audit.read({
      tenantId: scope.tenantId,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });
    if (result.status === 'rejected') {
      this.logger.error(
        `Reporting audit read rejected for check request ${row.id}: ${result.code}`
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

/** The Financial page-size pair — one place the report resolves its window. */
function resolveReportWindow(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    FINANCIAL_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? FINANCIAL_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/** Projects a stored row onto the twelve reporting fields. */
function toReportRow(row: CheckRequestRecord): FinancialCheckRequestReportRow {
  return {
    id: row.id,
    title: row.title,
    checkIssueType: row.checkIssueType,
    purchaseType: row.purchaseType,
    orderReference: row.orderReference,
    projectReference: row.projectReference,
    requestDate: row.requestDate.toISOString(),
    requesterOpinion: row.requesterOpinion,
    status: row.status,
    managerDecision: row.managerDecision,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
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
function reportFilter(query: FinancialCheckRequestReportQuery): CheckRequestFilter {
  return {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
    ...(query.decidedFrom !== undefined ? { decidedFrom: query.decidedFrom } : {}),
    ...(query.decidedTo !== undefined ? { decidedTo: query.decidedTo } : {}),
  };
}
