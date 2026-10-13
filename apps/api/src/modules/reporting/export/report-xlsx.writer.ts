import ExcelJS from 'exceljs';
import {
  reportDateTimeLabel,
  type ReportExportDocument,
} from '../presentation/report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the XLSX renderer — the report's OWN document
 * model written as a real spreadsheet, server-side, from the authoritative Reporting
 * result. No browser table is read, no HTML is scraped, no client-side generation exists.
 *
 * SHEET LAYOUT (one sheet, Persian, right-to-left view):
 *
 *   گزارش … (title, bold)
 *   زمان تولید | <Jalali date — time>
 *   صفحه | ۱ از ۳            ← scope lines
 *   ردیف‌های این خروجی | ۲۰
 *   مجموع (همه‌ی صفحات) | ۵۷
 *   فیلترها | وضعیت: تأییدشده … (or «—» when the report is unfiltered)
 *   خلاصه | <label> | <count> …
 *   (blank)
 *   <localized headers>       ← the table starts here, bold header row
 *   <typed rows>              ← numbers stay numbers, «—» for absent text
 *
 * The header row is what the integrity tests locate, so «metadata above, data below» is a
 * contract rather than a layout accident: row count is measurable against the same
 * `list()` result the screen rendered.
 *
 * WHY A WRITER AND NOT A TEMPLATE. There is no template file to drift from the report
 * contract, no macro and no executable content — only cells the model states.
 */
export async function renderReportXlsx(doc: ReportExportDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Aria ERP';
  workbook.created = doc.generatedAt;
  workbook.modified = doc.generatedAt;

  const sheet = workbook.addWorksheet(safeSheetName(doc.title), {
    // Persian-first: columns read right-to-left like the product does.
    views: [{ rightToLeft: true }],
  });

  // Widths are a function of the document alone, so they are set before the first cell —
  // assigning `columns` after rows exist would be a second statement about the same data.
  sheet.columns = doc.columns.map((column) => ({
    width: columnWidth(column.header, doc.rows, doc.columns.indexOf(column)),
  }));

  let index = 1;

  const titleCell = sheet.getCell(index, 1);
  titleCell.value = doc.title;
  titleCell.font = { bold: true, size: 13 };
  index += 1;

  sheet.getCell(index, 1).value = 'زمان تولید';
  sheet.getCell(index, 2).value = reportDateTimeLabel(doc.generatedAt.toISOString());
  index += 1;

  for (const line of [...doc.scope, ...doc.filters]) {
    sheet.getCell(index, 1).value = line.label;
    sheet.getCell(index, 2).value = line.value ?? '—';
    index += 1;
  }
  if (doc.filters.length === 0) {
    sheet.getCell(index, 1).value = 'فیلترها';
    sheet.getCell(index, 2).value = '—';
    index += 1;
  }

  sheet.getCell(index, 1).value = 'خلاصه';
  sheet.getCell(index, 1).font = { bold: true };
  index += 1;
  for (const line of doc.summary) {
    sheet.getCell(index, 1).value = line.label;
    sheet.getCell(index, 2).value = line.value ?? '—';
    index += 1;
  }
  if (doc.summary.length === 0) {
    sheet.getCell(index, 1).value = '—';
    index += 1;
  }

  index += 1; // one blank row between metadata and the table

  const headerRow = sheet.getRow(index);
  doc.columns.forEach((column, columnIndex) => {
    const cell = headerRow.getCell(columnIndex + 1);
    cell.value = column.header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  });
  headerRow.commit();
  index += 1;

  for (const row of doc.rows) {
    const sheetRow = sheet.getRow(index);
    doc.columns.forEach((column, columnIndex) => {
      const cell = sheetRow.getCell(columnIndex + 1);
      const value = row[columnIndex] ?? null;
      if (value === null) {
        cell.value = column.kind === 'text' ? '—' : null;
        return;
      }
      if (column.kind === 'number') {
        // Numeric semantics survive: a count or an amount is a NUMBER Excel can sum.
        cell.value = typeof value === 'number' ? value : Number(value);
        cell.numFmt = '#,##0.####';
        return;
      }
      cell.value = String(value);
    });
    sheetRow.commit();
    index += 1;
  }

  sheet.columns = doc.columns.map((column) => ({
    width: columnWidth(column.header, doc.rows, doc.columns.indexOf(column)),
  }));

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Excel refuses `:*?/[\]` in a sheet name and caps it at 31 chars — the title is both. */
function safeSheetName(title: string): string {
  const withoutForbidden = title.replace(/[:*?/[\]]/g, ' ').trim();
  return withoutForbidden.slice(0, 31) || 'گزارش';
}

/**
 * A readable width: the header, the longest rendered cell, and sane floors/ceilings so a
 * long Persian sentence does not stretch the sheet to the horizon.
 */
function columnWidth(
  header: string,
  rows: ReadonlyArray<readonly (string | number | null)[]>,
  columnIndex: number
): number {
  let longest = header.length;
  for (const row of rows) {
    const value = row[columnIndex];
    if (value !== null && value !== undefined) {
      longest = Math.max(longest, String(value).length);
    }
  }
  return Math.min(40, Math.max(12, longest + 4));
}
