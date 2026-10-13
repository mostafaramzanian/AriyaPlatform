import {
  REPORT_EXPORT_MIME,
  reportExportFileName,
  type ReportExportDocument,
  type ReportExportFile,
  type ReportExportFormat,
} from '../presentation/report-export.model';
import { renderReportDocx } from './report-docx.writer';
import { renderReportXlsx } from './report-xlsx.writer';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the export dispatcher — one entry point that
 * turns a report's OWN presentation document into a downloadable file.
 *
 * THE FLOW THIS FILE COMPLETES (and the only one that exists):
 *
 *   report filters (the SAME DTO the screen validated)
 *          ↓
 *   report service `list()`  →  rows + summary  (one authoritative read pair)
 *          ↓
 *   report presentation      →  ReportExportDocument  (title/filters/summary/columns)
 *          ↓
 *   here                     →  xlsx | docx bytes + safe name + exact MIME
 *
 * Nothing above this line may reach a source context's persistence — the writers see only
 * the document model, and the model only sees what `list()` returned. Synchronous
 * generation is deliberate: every report page is bounded by its DTO's page ceiling, so a
 * request-response export is complete, small and needs no job queue (documented in the
 * phase record, §Export Size).
 */
export async function renderReportExport(
  document: ReportExportDocument,
  format: ReportExportFormat
): Promise<ReportExportFile> {
  const buffer =
    format === 'xlsx' ? await renderReportXlsx(document) : await renderReportDocx(document);

  return {
    buffer,
    fileName: reportExportFileName(document.fileNameBase, format, document.generatedAt),
    mimeType: REPORT_EXPORT_MIME[format],
  };
}

export type { ReportExportDocument, ReportExportFile, ReportExportFormat };
