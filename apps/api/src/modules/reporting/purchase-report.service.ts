import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  COMMERCE_PURCHASE_REPORTING_READER,
  type CommercePurchaseReportPage,
  type CommercePurchaseReportRow,
  type CommercePurchaseReportSummary,
  type CommercePurchaseReportTimelinePage,
  type CommercePurchaseReportingReader,
} from '../commerce/reporting/commerce-purchase-reporting.contract';
import type {
  ListPurchaseReportQueryDto,
  PurchaseReportTimelineQueryDto,
} from './purchase-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toPurchaseReportExportDocument } from './presentation/purchase-report.presentation';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Reporting APPLICATION — the use case
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM, AND NOTHING ELSE — the exact shape
 * `check-request-report.service.ts` established, because the reasoning behind it does
 * not change with the source context. Every read below is the contract read with the
 * server-resolved tenant scope; no filter is invented, no row is re-projected, no
 * timestamp is inferred into an event, no KPI is derived.
 *
 * The two decisions this layer owns are both mappings, not facts:
 *  * a missing tenant is 403 (fail closed — "unscoped" is not an answer);
 *  * a `null` row (missing OR foreign-tenant) is 404, so existence never leaks across
 *    tenants — a 403 would confirm the id names a real document somewhere.
 * and one transport mapping: the platform's closed `AUDIT_READ_FAILED` becomes a 503
 * rather than a quiet empty timeline, because an outage and an empty history mean
 * opposite things.
 */
@Injectable()
export class PurchaseReportService {
  constructor(
    @Inject(COMMERCE_PURCHASE_REPORTING_READER)
    private readonly reader: CommercePurchaseReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip — two reads, in parallel. */
  async list(
    actor: ReportingActor,
    query: ListPurchaseReportQueryDto
  ): Promise<CommercePurchaseReportPage & { summary: CommercePurchaseReportSummary }> {
    if (!actor.tenantId) {
      throw new ForbiddenException(
        'Reporting requires a tenant context; this request was not resolved to a tenant.'
      );
    }
    const scope = { tenantId: actor.tenantId };
    const [page, summary] = await Promise.all([
      this.reader.listReportRows(scope, query),
      this.reader.getReportSummary(scope, query),
    ]);
    return { ...page, summary };
  }

  /**
   * The export use case — «the SAME list, rendered as a file».
   *
   * SCOPE EQUALITY IS STRUCTURAL: this method calls THIS class's own `list()` with the
   * SAME DTO the screen's list route validated, so the exported rows, summary and filter
   * lines are the identical answer the table and summary strip render — one reader, one
   * population, no second query. Authorization is the controller's own `@Roles`
   * (`commerce.read`) and the tenant comes from the request context, so an export route
   * can never read a scope its report screen refuses.
   */
  async exportReport(
    actor: ReportingActor,
    query: ListPurchaseReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toPurchaseReportExportDocument(result, query), format);
  }

  /**
   * PHASE W2-C — the pending-aging report («گزارش تأخیر درخواست‌های خرید در
   * جریان»): one delegated read over the tenant's in-circulation documents.
   * The aging origin, buckets and `generatedAt` are computed READER-SIDE on
   * Commerce's own rows; this layer adds only the tenant scope and the page
   * window, exactly as `list` does.
   */
  async listPendingAging(
    actor: ReportingActor,
    query: PurchaseReportTimelineQueryDto
  ) {
    if (!actor.tenantId) {
      throw new ForbiddenException(
        'Reporting requires a tenant context; this request was not resolved to a tenant.'
      );
    }
    return this.reader.listPendingAging({ tenantId: actor.tenantId }, query);
  }

  /**
   * PHASE W2-C — the committed-cost report («بهای تمام‌شده بر اساس مرکز
   * هزینه»): committed vs paid vs outstanding per cost center and currency, all
   * computed reader-side on Commerce's own rows — the append-only payment
   * ledger supplies paid, never a derived column on the document. One delegated
   * read plus the tenant scope, exactly as `list` does.
   */
  async listCostByCenter(actor: ReportingActor) {
    if (!actor.tenantId) {
      throw new ForbiddenException(
        'Reporting requires a tenant context; this request was not resolved to a tenant.'
      );
    }
    return this.reader.listCostByCenter({ tenantId: actor.tenantId });
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<CommercePurchaseReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Purchase request report row not found.');
    return row;
  }

  /**
   * This document's report timeline.
   *
   * Existence is proved tenant-scoped FIRST (404 for a foreign id), then the audit read
   * is attempted. The reader's rejection carries the platform's closed code; only
   * `AUDIT_READ_FAILED` is translated to a 503 here, and any other code is re-thrown
   * untouched rather than being folded into a message it did not produce.
   */
  async getTimeline(
    actor: ReportingActor,
    id: string,
    query: PurchaseReportTimelineQueryDto
  ): Promise<CommercePurchaseReportTimelinePage> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Purchase request report row not found.');
    try {
      return await this.reader.getReportTimeline({ tenantId: actor.tenantId }, id, query);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as Error & { code?: string }).code === 'AUDIT_READ_FAILED'
      ) {
        throw new ServiceUnavailableException({
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        });
      }
      throw error;
    }
  }
}
