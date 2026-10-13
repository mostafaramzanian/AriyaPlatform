import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  COMMERCE_PAYMENT_REPORTING_READER,
  type CommercePaymentReportPage,
  type CommercePaymentReportRow,
  type CommercePaymentReportSummary,
  type CommercePaymentReportingReader,
} from '../commerce/reporting/commerce-payment-reporting.contract';
import type { ListPaymentHistoryReportQueryDto } from './payment-history-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toPaymentHistoryReportExportDocument } from './presentation/payment-history-report.presentation';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Reporting APPLICATION — the use case
 * «گزارش تاریخچه پرداخت‌های بازرگانی» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM — the exact shape the seven sibling report
 * services established. Every read below is the contract read with the server-resolved
 * tenant scope; no filter is invented, no row is re-projected, no status is computed (the
 * four-member vocabulary is a per-DOCUMENT projection that this row-grain report never
 * renders), no timeline exists to map (the contract offers none — the payment audit trail
 * is document-bound and a per-row read would lie by grain), no KPI is derived.
 *
 * The two decisions this layer owns are both mappings, not facts:
 *  * a missing tenant is 403 (fail closed — «unscoped» is not an answer);
 *  * a `null` row (missing OR foreign-tenant) is 404, so existence never leaks across
 *    tenants — a 403 would confirm the id names a real payment row somewhere.
 */
@Injectable()
export class PaymentHistoryReportService {
  constructor(
    @Inject(COMMERCE_PAYMENT_REPORTING_READER)
    private readonly reader: CommercePaymentReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip. */
  async list(
    actor: ReportingActor,
    query: ListPaymentHistoryReportQueryDto
  ): Promise<CommercePaymentReportPage & { summary: CommercePaymentReportSummary }> {
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
   * (`commerce.read`) and the tenant comes from the request context.
   */
  async exportReport(
    actor: ReportingActor,
    query: ListPaymentHistoryReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toPaymentHistoryReportExportDocument(result, query), format);
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<CommercePaymentReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Payment history report row not found.');
    return row;
  }
}
