import {
  BOM_MANAGER_OPINION_LABELS,
  BOM_STATUSES,
  type BomManagerOpinion,
} from '../../production/bom/bom-status';
import type {
  ProductionBomChangeReportPage,
  ProductionBomChangeReportQuery,
  ProductionBomChangeReportSummary,
} from '../../production/reporting/production-bom-change-reporting.contract';
import {
  PRODUCTION_REPORT_STATUS_LABELS,
  productionReportStatusExportLabel,
} from './production-report.presentation';
import {
  reportDateLabel,
  reportPageScopeLines,
  type ReportExportDocument,
} from './report-export.model';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the change-request report's EXPORT
 * presentation — «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)» as a document.
 *
 * Same discipline as the four siblings: the document is built from the EXACT `list()`
 * result the screen rendered for the same query, through the shared
 * `ReportExportDocument` shape, by THIS function and no registry. Columns mirror the
 * register table — BOM/title, project, status, manager opinion, change-line count,
 * creation day.
 *
 * `itemCount` is the request's bounded `_count` (detail rows that exist) and stays a
 * NUMBER; a `null` manager opinion is «—», never a verdict nobody gave. Status words are
 * type-sealed over `BomStatus` and pinned to the web's `production-labels.ts` wording by
 * the drift spec; the opinion words come from the SOURCE's own
 * `BOM_MANAGER_OPINION_LABELS`, so that vocabulary has one owner, not two.
 */
export const PRODUCTION_BOM_CHANGE_REPORT_TITLE = 'گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)';

export const PRODUCTION_BOM_CHANGE_REPORT_FILE_BASE = 'production-bom-change-report';

/**
 * The lifecycle words are NOT re-declared here: one Production lifecycle, one set of
 * Persian words, and `report-export-labels.spec.ts` already pins that set to the web's
 * `PRODUCTION_BOM_STATUS_LABELS`. Aliasing the SAME map is what makes a future wording
 * change land in BOTH Production reports at once, instead of letting the change-request
 * report quietly disagree with the BOM report about what `SUBMITTED` is called.
 */
export const PRODUCTION_BOM_CHANGE_REPORT_STATUS_LABELS = PRODUCTION_REPORT_STATUS_LABELS;

export const productionBomChangeReportStatusExportLabel = productionReportStatusExportLabel;

export type ProductionBomChangeReportExportResult = ProductionBomChangeReportPage & {
  summary: ProductionBomChangeReportSummary;
};

export function toProductionBomChangeReportExportDocument(
  result: ProductionBomChangeReportExportResult,
  query: ProductionBomChangeReportQuery,
  generatedAt: Date = new Date()
): ReportExportDocument {
  return {
    title: PRODUCTION_BOM_CHANGE_REPORT_TITLE,
    fileNameBase: PRODUCTION_BOM_CHANGE_REPORT_FILE_BASE,
    generatedAt,
    scope: reportPageScopeLines(
      result.items.length,
      result.summary.total,
      result.page,
      result.pageSize
    ),
    filters: [
      ...(query.bomId !== undefined ? [{ label: 'فهرست مواد (BOM)', value: query.bomId }] : []),
      ...(query.projectRef !== undefined ? [{ label: 'پروژه', value: query.projectRef }] : []),
      ...(query.status !== undefined
        ? [{ label: 'وضعیت', value: productionBomChangeReportStatusExportLabel(query.status) }]
        : []),
      ...(query.search ? [{ label: 'جستجو (عنوان)', value: query.search }] : []),
    ],
    summary: [
      ...BOM_STATUSES.map((status) => ({
        label: productionBomChangeReportStatusExportLabel(status),
        value: result.summary.byStatus[status] ?? 0,
      })),
      { label: 'جمع کل', value: result.summary.total },
    ],
    columns: [
      { header: 'فهرست مواد (BOM)', kind: 'text' },
      { header: 'عنوان', kind: 'text' },
      { header: 'پروژه', kind: 'text' },
      { header: 'وضعیت', kind: 'text' },
      { header: 'نظر مدیر', kind: 'text' },
      { header: 'تعداد اقلام تغییر', kind: 'number' },
      { header: 'تاریخ ایجاد', kind: 'text' },
    ],
    rows: result.items.map((row) => [
      row.bomId,
      row.title,
      row.projectRef,
      productionBomChangeReportStatusExportLabel(row.status),
      row.managerOpinion
        ? (BOM_MANAGER_OPINION_LABELS[row.managerOpinion as BomManagerOpinion] ??
          row.managerOpinion)
        : '—',
      row.itemCount,
      reportDateLabel(row.createdAt),
    ]),
  };
}
