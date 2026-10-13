import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReportingActor } from './reporting-actor';
import {
  HR_MISSION_REQUEST_REPORTING_READER,
  type HrMissionRequestReportPage,
  type HrMissionRequestReportRow,
  type HrMissionRequestReportSummary,
  type HrMissionRequestReportTimelinePage,
  type HrMissionRequestReportingReader,
} from '../hr/reporting/hr-mission-reporting.contract';
import type {
  HrMissionReportTimelineQueryDto,
  ListHrMissionReportQueryDto,
} from './hr-mission-report.dto';
import {
  renderReportExport,
  type ReportExportFormat,
  type ReportExportFile,
} from './export/report-export';
import { toHrMissionReportExportDocument } from './presentation/hr-mission-report.presentation';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the Reporting APPLICATION — the use case
 * «گزارش وضعیت درخواست‌های مأموریت» answers.
 *
 * A THIN ORCHESTRATION OVER THE APPROVED SEAM — the exact shape the sibling report
 * services established. Every read below is the contract read with the
 * server-resolved tenant scope; no filter is invented, no row is re-projected, no
 * timestamp is inferred into an event, no KPI is derived, no duration is computed.
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
export class HrMissionReportService {
  constructor(
    @Inject(HR_MISSION_REQUEST_REPORTING_READER)
    private readonly reader: HrMissionRequestReportingReader
  ) {}

  /** One filtered page of the register, WITH its summary strip. */
  async list(
    actor: ReportingActor,
    query: ListHrMissionReportQueryDto
  ): Promise<HrMissionRequestReportPage & { summary: HrMissionRequestReportSummary }> {
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
    query: ListHrMissionReportQueryDto,
    format: ReportExportFormat
  ): Promise<ReportExportFile> {
    const result = await this.list(actor, query);
    return renderReportExport(toHrMissionReportExportDocument(result, query), format);
  }

  /** One report row, or 404 when the id is unknown OR belongs to another tenant. */
  async getOne(actor: ReportingActor, id: string): Promise<HrMissionRequestReportRow> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Mission request report row not found.');
    return row;
  }

  /** This register row's report timeline — 404 first, 503 on audit outage. */
  async getTimeline(
    actor: ReportingActor,
    id: string,
    query: HrMissionReportTimelineQueryDto
  ): Promise<HrMissionRequestReportTimelinePage> {
    const row = await this.reader.getReportRow({ tenantId: actor.tenantId }, id);
    if (!row) throw new NotFoundException('Mission request report row not found.');
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
