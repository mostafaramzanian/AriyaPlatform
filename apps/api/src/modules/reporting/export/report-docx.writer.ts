import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  reportDateTimeLabel,
  reportPersianDigits,
  type ReportExportCell,
  type ReportExportDocument,
} from '../presentation/report-export.model';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the DOCX renderer — the report's OWN document
 * model written as a Word document, server-side, from the authoritative Reporting result.
 *
 * DOCUMENT COMPOSITION (only sections the report actually has):
 *
 *   <title>                         Persian, bold, right-aligned
 *   زمان تولید: <Jalali — time>
 *   صفحه: ۱ از ۳ / ردیف‌های این خروجی / مجموع
 *   فیلترها: وضعیت: تأییدشده …     (or «—» when unfiltered)
 *   خلاصه: <label> …               (label/value paragraphs, not a second table)
 *   جدول داده‌ها:
 *   ┌ localized headers ┐
 *   │ typed rows        │         the ONE table in the document
 *   └───────────────────┘
 *   (when empty) برای این فیلترها ردیفی وجود ندارد.
 *
 * RTL AND PERSIAN. Every paragraph carries `bidirectional: true` and right alignment — the
 * Persian-first product text is the document's own language, not a decoration. Numbers
 * inside cells are rendered in Persian digits (display form), while the stored instant or
 * day behind each cell is never altered: this file only re-renders what `list()` returned.
 *
 * NO NARRATIVE IS INVENTED. The document states facts the report already holds — title,
 * time, filters, counts, rows. No conclusion, no interpretation, no commentary.
 *
 * NO EMBEDDED VISUALIZATION IN THIS PHASE. A drawing would require a second chart
 * implementation for Word; the approved charts live on the screens where the report table
 * already serves as their accessible counterpart (recorded as a deferred capability).
 */
export async function renderReportDocx(doc: ReportExportDocument): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: doc.title, bold: true, size: 30 })],
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      spacing: { after: 200 },
    })
  );

  children.push(metaLine('زمان تولید', reportDateTimeLabel(doc.generatedAt.toISOString())));
  for (const line of [...doc.scope, ...doc.filters]) {
    children.push(metaLine(line.label, line.value));
  }
  if (doc.filters.length === 0) {
    children.push(metaLine('فیلترها', '—'));
  }

  children.push(sectionHeading('خلاصه'));
  if (doc.summary.length === 0) {
    children.push(bodyLine('—'));
  } else {
    for (const line of doc.summary) {
      children.push(metaLine(line.label, line.value));
    }
  }

  children.push(sectionHeading('جدول داده‌ها'));

  const headerRow = new TableRow({
    children: doc.columns.map((column) => headerCell(column.header)),
    tableHeader: true,
  });
  const dataRows = doc.rows.map(
    (row) =>
      new TableRow({
        children: doc.columns.map((column, columnIndex) => dataCell(row[columnIndex] ?? null)),
      })
  );
  children.push(
    new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
    })
  );

  if (doc.rows.length === 0) {
    children.push(bodyLine('برای این فیلترها ردیفی وجود ندارد.'));
  }

  const document = new Document({
    creator: 'Aria ERP',
    description: doc.title,
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 21 } },
      },
    },
    sections: [{ children }],
  });

  return Buffer.from(await Packer.toBuffer(document));
}

/** A `label: value` metadata paragraph — RTL, right-aligned, label bold. */
function metaLine(label: string, value: ReportExportCell): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: renderCell(value) }),
    ],
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { after: 60 },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 24 })],
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { before: 200, after: 100 },
  });
}

function bodyLine(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text })],
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { after: 60 },
  });
}

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: true })],
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
      }),
    ],
  });
}

function dataCell(value: ReportExportCell): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [new TextRun({ text: renderCell(value) })],
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
      }),
    ],
  });
}

/**
 * One rendering rule for a cell, shared by metadata lines and table cells: a NUMBER is a
 * Persian-digit display form (the digits the screens show), a string is the report's own
 * text untouched, and `null` is the honest dash the screens render for an absent value.
 * The `kind` still travels on the column because the SPREADSHEET needs it for typing; in
 * a Word document every cell is text, so the value itself decides the digits.
 */
function renderCell(value: ReportExportCell): string {
  if (value === null) return '—';
  if (typeof value === 'number') return reportPersianDigits(value);
  return value;
}
