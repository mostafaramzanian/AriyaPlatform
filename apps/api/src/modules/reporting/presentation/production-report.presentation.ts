import {
  BOM_MANAGER_OPINION_LABELS,
  BOM_STATUSES,
  type BomManagerOpinion,
  type BomStatus,
} from '../../production/bom/bom-status';
import type {
  ProductionReportPage,
  ProductionReportQuery,
  ProductionReportSummary,
} from '../../production/reporting/production-reporting.contract';
import {
  reportDateLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the Production report's EXPORT presentation —
 * «گزارش خلاصه و وضعیت عملیات تولید» as a document.
 *
 * Same discipline as the two siblings: the document is built from the EXACT `list()`
 * result the screen rendered for the same query, through the shared
 * `ReportExportDocument` shape, by THIS function and no registry. Columns mirror the
 * register table — title, project, status, manager opinion, item count, creation day.
 *
 * `itemCount` is the header's bounded `_count` (rows that exist) and stays a NUMBER; a
 * `null` manager opinion is «—», never a verdict nobody gave. Status words are
 * type-sealed over `BomStatus` and pinned to the web's `production-labels.ts` wording by
 * the drift spec; the opinion words come from the SOURCE's own
 * `BOM_MANAGER_OPINION_LABELS`, so that vocabulary has one owner, not two.
 */
export const PRODUCTION_REPORT_TITLE = 'گزارش خلاصه و وضعیت عملیات تولید';

export const PRODUCTION_REPORT_FILE_BASE = 'production-report';

/** The lifecycle word per member — the web's `PRODUCTION_BOM_STATUS_LABELS` wording. */
export const PRODUCTION_REPORT_STATUS_LABELS: Record<BomStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارجاع برای تایید',
  APPROVED: 'تایید شده',
  REJECTED: 'رد شده',
};

export function productionReportStatusExportLabel(status: string): string {
  return PRODUCTION_REPORT_STATUS_LABELS[status as BomStatus] ?? status;
}

export type ProductionReportExportResult = ProductionReportPage & {
  summary: ProductionReportSummary;
};

export function toProductionReportExportDocument(
  result: ProductionReportExportResult,
  query: ProductionReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: PRODUCTION_REPORT_TITLE,
    fileNameBase: PRODUCTION_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.status !== undefined
        ? [{ label: 'وضعیت', value: productionReportStatusExportLabel(query.status) }]
        : []),
      ...(query.search ? [{ label: 'جستجو (عنوان)', value: query.search }] : []),
    ],
    summary: [
      ...BOM_STATUSES.map((status) => ({
        label: productionReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'عنوان', kind: 'text' },
      { header: 'پروژه', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'نظر مدیر', kind: 'text' },
      { header: 'تعداد اقلام', kind: 'number' },
      { header: 'تاریخ ایجاد', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.title,
      row.projectRef,
      productionReportStatusExportLabel(row.status),
      row.managerOpinion
        ? (BOM_MANAGER_OPINION_LABELS[row.managerOpinion as BomManagerOpinion] ??
          row.managerOpinion)
        : '—',
      row.itemCount,
      reportDateLabel(row.createdAt),
    ]),
  };
}
