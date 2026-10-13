import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  FINANCIAL_CHECK_REQUEST_REPORTING_READER,
  type FinancialCheckRequestReportPage,
  type FinancialCheckRequestReportRow,
  type FinancialCheckRequestReportSummary,
  type FinancialCheckRequestReportTimelinePage,
  type FinancialCheckRequestReportingReader,
} from '../financial/reporting/financial-check-request-reporting.contract';
import type {
  CheckRequestReportTimelineQueryDto,
  ListCheckRequestReportQueryDto,
} from './check-request-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toCheckRequestReportExportDocument } from './presentation/check-request-report.presentation';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Reporting APPLICATION — the use
 * case «گزارش وضعیت و گردش درخواست‌های صدور چک» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM, AND NOTHING ELSE. Every read
 * below is the contract read with the server-resolved tenant scope; no filter
 * is invented, no row is re-projected, no timestamp is inferred into an
 * event, no KPI is derived. The one decision this layer owns is the
 * not-found mapping: a `null` row (missing OR foreign-tenant) is 404, so
 * existence never leaks across tenants.
 */
@Injectable()
export class CheckRequestReportService {
  constructor(
    @Inject(FINANCIAL_CHECK_REQUEST_REPORTING_READER)
    private readonly reader: FinancialCheckRequestReportingReader
  ) {}

  async list(
    actor: ReportingActor,
    query: ListCheckRequestReportQueryDto
  ): Promise<FinancialCheckRequestReportPage & { summary: FinancialCheckRequestReportSummary }> {
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
   * SCOPE EQUALITY IS STRUCTURAL, NOT A CONVENTION: this method calls THIS class's own
   * `list()` with the SAME DTO the screen's list route validated, so the exported rows,
   * the exported summary and the exported filter lines are the identical answer the
   * table, the summary strip and the charts derive from — one reader, one population, no
   * second query and no re-interpretation of the filters. A tenant without the read remit
   * never reaches this method (the controller's `@Roles` is the report's own), and a
   * request without a tenant fails here exactly as `list()` fails: 403, fail closed.
   */
  async exportReport(
    actor: ReportingActor,
    query: ListCheckRequestReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toCheckRequestReportExportDocument(result, query), format);
  }

  async getOne(actor: ReportingActor, id: string): Promise<FinancialCheckRequestReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Check request report row not found.');
    return row;
  }

  async getTimeline(
    actor: ReportingActor,
    id: string,
    query: CheckRequestReportTimelineQueryDto
  ): Promise<FinancialCheckRequestReportTimelinePage> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Check request report row not found.');
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
