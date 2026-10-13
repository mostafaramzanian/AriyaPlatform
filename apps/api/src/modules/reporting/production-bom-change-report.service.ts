import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  PRODUCTION_BOM_CHANGE_REPORTING_READER,
  type ProductionBomChangeReportPage,
  type ProductionBomChangeReportRow,
  type ProductionBomChangeReportSummary,
  type ProductionBomChangeReportTimelinePage,
  type ProductionBomChangeReportingReader,
} from '../production/reporting/production-bom-change-reporting.contract';
import type {
  ListProductionBomChangeReportQueryDto,
  ProductionBomChangeReportTimelineQueryDto,
} from './production-bom-change-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toProductionBomChangeReportExportDocument } from './presentation/production-bom-change-report.presentation';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Reporting APPLICATION — the use case
 * «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM, AND NOTHING ELSE — the exact shape the
 * four sibling report services established, because the reasoning behind it does not
 * change with the source context. Every read below is the contract read with the
 * server-resolved tenant scope; no filter is invented, no row is re-projected, no
 * timestamp is inferred into an event, no KPI is derived.
 *
 * The two decisions this layer owns are both mappings, not facts:
 *  * a missing tenant is 403 (fail closed — "unscoped" is not an answer);
 *  * a `null` row (missing OR foreign-tenant) is 404, so existence never leaks across
 *    tenants — a 403 would confirm the id names a real change request somewhere.
 * and one transport mapping: the platform's closed `AUDIT_READ_FAILED` becomes a 503
 * rather than a quiet empty timeline, because an outage and an empty history mean
 * opposite things.
 */
@Injectable()
export class ProductionBomChangeReportService {
  constructor(
    @Inject(PRODUCTION_BOM_CHANGE_REPORTING_READER)
    private readonly reader: ProductionBomChangeReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip — two reads, in parallel. */
  async list(
    actor: ReportingActor,
    query: ListProductionBomChangeReportQueryDto
  ): Promise<ProductionBomChangeReportPage & { summary: ProductionBomChangeReportSummary }> {
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
   * (`production.bom.read`) and the tenant comes from the request context, so an export
   * route can never read a scope its report screen refuses.
   */
  async exportReport(
    actor: ReportingActor,
    query: ListProductionBomChangeReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toProductionBomChangeReportExportDocument(result, query), format);
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<ProductionBomChangeReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Production change-request report row not found.');
    return row;
  }

  /**
   * This change request's report timeline.
   *
   * Existence is proved tenant-scoped FIRST (404 for a foreign id), then the audit read
   * is attempted. The reader's rejection carries the platform's closed code; only
   * `AUDIT_READ_FAILED` is translated to a 503 here, and any other code is re-thrown
   * untouched rather than being folded into a message it did not produce.
   */
  async getTimeline(
    actor: ReportingActor,
    id: string,
    query: ProductionBomChangeReportTimelineQueryDto
  ): Promise<ProductionBomChangeReportTimelinePage> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Production change-request report row not found.');
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
