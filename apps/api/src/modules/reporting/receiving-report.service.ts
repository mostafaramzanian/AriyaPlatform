import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  COMMERCE_RECEIVING_REPORTING_READER,
  type CommerceReceivingReportPage,
  type CommerceReceivingReportRow,
  type CommerceReceivingReportSummary,
  type CommerceReceivingReportingReader,
} from '../commerce/reporting/commerce-receiving-reporting.contract';
import type { ListReceivingReportQueryDto } from './receiving-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toReceivingReportExportDocument } from './presentation/receiving-report.presentation';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Reporting APPLICATION — the use
 * case «گزارش وضعیت دریافت‌های بازرگانی» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM — the exact shape the eight sibling
 * report services established. Every read below is the contract read with the
 * server-resolved tenant scope; no filter is invented, no row is re-projected,
 * no status is computed (the three-state vocabulary is the DOMAIN's projection,
 * consumed through the seam), no timeline exists to map (the contract offers
 * none — the receiving audit trail is bound to the RECEIPT EVENT, so a timeline
 * keyed to a purchase line would return its siblings' events as this row's
 * history), no KPI is derived.
 *
 * The two decisions this layer owns are both mappings, not facts:
 *  * a missing tenant is 403 (fail closed — «unscoped» is not an answer);
 *  * a `null` row (missing OR foreign-tenant) is 404, so existence never leaks
 *    across tenants — a 403 would confirm the id names a real line somewhere.
 */
@Injectable()
export class ReceivingReportService {
  constructor(
    @Inject(COMMERCE_RECEIVING_REPORTING_READER)
    private readonly reader: CommerceReceivingReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip. */
  async list(
    actor: ReportingActor,
    query: ListReceivingReportQueryDto
  ): Promise<CommerceReceivingReportPage & { summary: CommerceReceivingReportSummary }> {
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
   * SCOPE EQUALITY IS STRUCTURAL: this method calls THIS class's own `list()`
   * with the SAME DTO the screen's list route validated, so the exported rows,
   * summary and filter lines are the identical answer the table and summary
   * strip render — one reader, one population, no second query. Authorization is
   * the controller's own `@Roles` (`commerce.read`) and the tenant comes from
   * the request context.
   */
  async exportReport(
    actor: ReportingActor,
    query: ListReceivingReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toReceivingReportExportDocument(result, query), format);
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<CommerceReceivingReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Receiving status report row not found.');
    return row;
  }
}
