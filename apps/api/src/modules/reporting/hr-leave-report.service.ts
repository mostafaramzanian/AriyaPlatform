import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  HR_LEAVE_REQUEST_REPORTING_READER,
  type HrLeaveRequestReportPage,
  type HrLeaveRequestReportRow,
  type HrLeaveRequestReportSummary,
  type HrLeaveRequestReportTimelinePage,
  type HrLeaveRequestReportingReader,
} from '../hr/reporting/hr-leave-reporting.contract';
import type {
  HrLeaveReportTimelineQueryDto,
  ListHrLeaveReportQueryDto,
} from './hr-leave-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toHrLeaveReportExportDocument } from './presentation/hr-leave-report.presentation';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the Reporting APPLICATION — the use case
 * «گزارش وضعیت درخواست‌های مرخصی» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM — the exact shape the sibling report
 * services established. Every read below is the contract read with the
 * server-resolved tenant scope; no filter is invented, no row is re-projected, no
 * timestamp is inferred into an event, no KPI is derived, no balance is computed.
 *
 * The two decisions this layer owns are both mappings, not facts:
 *  * a missing tenant is 403 (fail closed — «unscoped» is not an answer);
 *  * a `null` row (missing OR foreign-tenant) is 404, so existence never leaks
 *    across tenants — a 403 would confirm the id names a real register row somewhere.
 * and one transport mapping: the platform's closed `AUDIT_READ_FAILED` becomes a 503
 * rather than a quiet empty timeline, because an outage and an empty history mean
 * opposite things.
 */
@Injectable()
export class HrLeaveReportService {
  constructor(
    @Inject(HR_LEAVE_REQUEST_REPORTING_READER)
    private readonly reader: HrLeaveRequestReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip. */
  async list(
    actor: ReportingActor,
    query: ListHrLeaveReportQueryDto
  ): Promise<HrLeaveRequestReportPage & { summary: HrLeaveRequestReportSummary }> {
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

  /** The SAME list, rendered as a file — scope equality is structural. */
  async exportReport(
    actor: ReportingActor,
    query: ListHrLeaveReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toHrLeaveReportExportDocument(result, query), format);
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<HrLeaveRequestReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Leave request report row not found.');
    return row;
  }

  /** This register row's report timeline — 404 first, 503 on audit outage. */
  async getTimeline(
    actor: ReportingActor,
    id: string,
    query: HrLeaveReportTimelineQueryDto
  ): Promise<HrLeaveRequestReportTimelinePage> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Leave request report row not found.');
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
