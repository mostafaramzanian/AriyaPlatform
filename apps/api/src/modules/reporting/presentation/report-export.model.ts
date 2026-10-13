import { APP_TIME_ZONE } from '../../../calendar/jalali.util';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the Reporting-owned PRESENTATION model — the ONE
 * document shape both export formats consume, and the Persian-first display helpers every
 * report's export builder shares.
 *
 * WHY THIS IS THE ONLY SHARED ABSTRACTION THIS PHASE EXTRACTS
 * -----------------------------------------------------------
 * The evidence review of the four real reports (docs/reports/
 * PHASE-REPORTING-VISUALIZATION-EXPORT.md) found exactly one shape all four can honestly
 * share for EXPORT: «a titled document with a generation instant, an applied-filter
 * block, a scope block, a count summary, and one table of columns + rows». Every report
 * already produces that content through its OWN `list()` read — this file only names how
 * it is carried to the two renderers. It is deliberately NOT:
 *
 *  * a report definition DSL — columns and labels are built by each report's own
 *    `*.presentation.ts` in TypeScript, so no filter, metric or chart can be "declared"
 *    against a report whose source cannot answer it;
 *  * a filter model — the DTOs stay per-report and are reused VERBATIM by the export
 *    routes, so screen and export validate one vocabulary, not two;
 *  * a metric layer — `summary` counts arrive from the same server aggregation the table
 *    answers with; nothing here derives a figure.
 *
 * CELLS ARE TYPED, NOT STRINGIFIED. `kind: 'number'` keeps counts and money numeric in
 * the spreadsheet, every other cell is the report's own text form. Dates are rendered
 * through the fa-IR Persian calendar in a NAMED zone — the api container declares none
 * (TZ is empty), which is why `jalali.util.ts` names its zone explicitly too.
 */

/** The two document formats this phase renders. No others are claimed. */
export type ReportExportFormat = 'xlsx' | 'docx';

/** A generated file: bytes + a safe ASCII name + the exact MIME a download needs. */
export interface ReportExportFile {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

/** One table cell: a NUMBER stays a number (spreadsheet semantics), `null` is «—». */
export type ReportExportCell = string | number | null;

/** One column: the localized header the table carries, and how its cells are typed. */
export interface ReportExportColumn {
  header: string;
  kind: 'text' | 'number';
}

/** One label/value metadata line — a filter, a scope fact or a summary count. */
export interface ReportExportLine {
  label: string;
  value: ReportExportCell;
}

/**
 * The whole document. Built by each report's presentation module from the report's OWN
 * `list()` result; rendered byte-for-byte by the two writers. `rows` mirrors the exact
 * row set the screen's table shows for the same query — never a second population.
 */
export interface ReportExportDocument {
  /** The report's Persian title — the same string its screen identity block shows. */
  title: string;
  /** ASCII base for the file name (`purchase-report`), never user input. */
  fileNameBase: string;
  /** When this document was rendered — the export's own honest timestamp. */
  generatedAt: Date;
  /** Pagination facts about the exported window (page, rows, filtered total). */
  scope: ReportExportLine[];
  /** The filters actually applied to this export — the screen's active filter state. */
  filters: ReportExportLine[];
  /** The report's summary counts, over the SAME filtered population as the rows. */
  summary: ReportExportLine[];
  columns: ReportExportColumn[];
  rows: ReportExportCell[][];
}

/** The exact OpenXML MIME types — spelled out, never guessed at runtime. */
export const REPORT_EXPORT_MIME: Record<ReportExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const REPORT_EXPORT_EXTENSION: Record<ReportExportFormat, string> = {
  xlsx: 'xlsx',
  docx: 'docx',
};

/**
 * `<base>-<YYYY-MM-DD>.<ext>` — report identity + the UTC day it was generated.
 *
 * Deliberately ASCII and constant-shaped: no tenant id, no row id, no request id, no raw
 * search text, no client-supplied string of any kind can reach the name, so it can never
 * leak scope or need sanitising. The date is the DOCUMENT's date, not a filter's — a
 * range in the name would be a second, easily-stale statement of what the file holds.
 */
export function reportExportFileName(
  base: string,
  format: ReportExportFormat,
  generatedAt: Date = new Date()
): string {
  const day = generatedAt.toISOString().slice(0, 10);
  return `${base}-${day}.${REPORT_EXPORT_EXTENSION[format]}`;
}

/**
 * Latin digits → Persian digits. DISPLAY ONLY: the wire, the contract and every filter
 * keep Latin digits (the API boundary refuses Persian ones — the calendar module's own
 * rule); this is the same renumbering `toPersianDigits` performs on the screens.
 */
export function reportPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

/** A stored ISO instant as the Persian calendar DATE the rest of Aria shows. */
export function reportDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: APP_TIME_ZONE,
  }).format(instant);
}

/** A stored ISO instant as Jalali date + 24h time (Tehran reading) — metadata lines. */
export function reportDateTimeLabel(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: APP_TIME_ZONE,
  }).format(instant);
  return `${reportDateLabel(iso)} — ${reportPersianDigits(time)}`;
}

/**
 * A stored ISO instant as the punch TIME the register's screen shows (`HH:mm`, Tehran,
 * Persian digits) — the exact shape `hrInstantTimeLabel` renders.
 */
export function reportTimeLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: APP_TIME_ZONE,
  }).format(instant);
  return reportPersianDigits(time);
}

/** A stored Gregorian `YYYY-MM-DD` DAY as Persian digits — no conversion, no zone. */
export function reportDayLabel(dateKey: string): string {
  return reportPersianDigits(dateKey);
}

/**
 * The Persian weekday of a stored `YYYY-MM-DD` day — UTC NAMED, because a date-only
 * value has no zone (the same reading `hrWeekdayLabel` performs on the screen).
 */
export function reportWeekdayLabel(dateKey: string): string {
  const day = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'UTC' }).format(day);
}

/**
 * The scope block every export carries — how many rows this file holds and how they sit
 * inside the filtered total. All four reports page identically (one window, one filtered
 * population), so this is a second shared shape the evidence justifies.
 *
 * `rows` is the count of the exported page itself: the file states its own window instead
 * of implying it contains the whole filtered set, which is what makes «the file and the
 * table show the same rows» checkable from the file alone.
 */
export function reportPageScopeLines(
  rows: number,
  total: number,
  page: number,
  pageSize: number
): ReportExportLine[] {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return [
    { label: 'صفحه', value: `${reportPersianDigits(page)} از ${reportPersianDigits(pages)}` },
    { label: 'ردیف‌های این خروجی', value: rows },
    { label: 'مجموع (همه‌ی صفحات)', value: total },
  ];
}

/**
 * The `Content-Disposition` for a generated file. The name is always the ASCII shape
 * `reportExportFileName` produces, so a plain `filename="…"` is sufficient — there is no
 * non-ASCII name to percent-encode, and nothing a client controls to escape the quotes.
 */
export function reportExportDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}
