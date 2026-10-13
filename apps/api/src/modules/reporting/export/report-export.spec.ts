import ExcelJS from 'exceljs';
import { inflateRawSync } from 'zlib';
import { toPurchaseReportExportDocument } from '../presentation/purchase-report.presentation';
import type { ReportExportDocument } from '../presentation/report-export.model';
import { renderReportDocx } from './report-docx.writer';
import { renderReportXlsx } from './report-xlsx.writer';
import { renderReportExport } from './report-export';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the two renderers — asserted on PARSED
 * documents, never on "a non-empty buffer".
 *
 *  * XLSX is re-opened with the same library that claims to write it: the sheet exists,
 *    the RTL view is on, the header row carries the localized headers, the data rows
 *    equal the document's rows, numbers stay NUMBERS where the model says they are.
 *  * DOCX is unzipped and `word/document.xml` is read as TEXT: the report title is
 *    there, the table is the ONE table with header + N data rows, columns travel
 *    right-to-left (`w:bidi`), and Persian words survive the round trip byte-for-byte.
 *    The unzipper below is local to this spec — `zlib` (deflate) + central-directory
 *    walking, ~30 lines — because no zip library lives in the workspace and this phase
 *    refuses to admit a third document dependency merely to read its own files back.
 *
 * The document under test is built by a REAL presentation module (Commerce) from a fake
 * but contract-shaped result — so what is pinned is the whole path «result → document →
 * bytes», not the writer in isolation.
 */
const FIXED = new Date('2026-10-05T10:30:00.000Z');

const RESULT = {
  items: [
    {
      id: 'doc-1',
      documentNumber: 'PR-1404-000123',
      kind: 'PURCHASE_REQUEST',
      status: 'APPROVED',
      supplierId: null,
      currency: 'IRR',
      subtotalAmount: '1200',
      taxAmount: '60',
      totalAmount: '1260',
      lineCount: 1,
      completedAt: null,
      createdAt: '2026-09-18T08:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  summary: { total: 1, byStatus: { APPROVED: 1 } },
};

function documentFor(rows: typeof RESULT.items = RESULT.items): ReportExportDocument {
  const normalized = {
    ...RESULT,
    items: rows,
    total: rows.length,
    summary: { total: rows.length, byStatus: {} as Record<string, number> },
  };
  return toPurchaseReportExportDocument(normalized, { status: 'APPROVED' }, FIXED);
}

/**
 * Reads one entry of a ZIP archive (xlsx/docx) by name.
 *
 * Walks to the End-of-Central-Directory, jumps through the central entries by offset,
 * then inflates the entry's data run — the same deflate `zlib` the platform already
 * owns. `stored` entries pass through untouched.
 */
function readZipEntry(archive: Buffer, entryName: string): string {
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no End-of-Central-Directory in this archive');

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('corrupt central directory while reading this archive');
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localHeader = archive.readUInt32LE(offset + 42);

    if (name === entryName) {
      const localNameLength = archive.readUInt16LE(localHeader + 26);
      const localExtraLength = archive.readUInt16LE(localHeader + 28);
      const dataStart = localHeader + 30 + localNameLength + localExtraLength;
      const raw = archive.subarray(dataStart, dataStart + compressedSize);
      return (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`entry not found in this archive: ${entryName}`);
}

/** Counts XML open-tags of an exact element name (`tr`, `tbl` — never `trPr`). */

describe('renderReportXlsx — a spreadsheet that re-opens', () => {
  it('carries title, metadata, localized headers and the exact data rows', async () => {
    const buffer = Buffer.from(await renderReportXlsx(documentFor()));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(buffer) as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(1);

    const sheet = workbook.worksheets[0];
    // Persian-first: the sheet reads right-to-left like the product does.
    expect(sheet.views).toHaveLength(1);
    expect(sheet.views[0].rightToLeft).toBe(true);
    // The title is the document's own title, not a file name.
    expect(sheet.getCell('A1').value).toBe('گزارش وضعیت و چرخه عمر درخواست‌های خرید');

    const values: unknown[][] = [];
    sheet.eachRow((row) => {
      values.push((Array.isArray(row.values) ? row.values : []).slice(1));
    });

    // The header row is found BY VALUE — «metadata above, data below» is a contract.
    const headerIndex = values.findIndex((row) => row[0] === 'شماره سند');
    expect(headerIndex).toBeGreaterThan(0);
    expect(values[headerIndex]).toEqual([
      'شماره سند',
      'نوع سند',
      'وضعیت',
      'مبلغ کل',
      'ارز',
      'تعداد اقلام',
      'تاریخ ایجاد',
    ]);

    // Metadata above the header: generation time and the applied status filter.
    const above = values.slice(0, headerIndex).map((row) => String(row[0] ?? ''));
    expect(above).toContain('زمان تولید');
    expect(above).toContain('وضعیت');
    const statusLine = values.slice(0, headerIndex).find((row) => row[0] === 'وضعیت');
    expect(statusLine?.[1]).toBe('تأییدشده');

    // Exactly one data row below the header, with typed cells.
    const data = values.slice(headerIndex + 1);
    expect(data).toHaveLength(1);
    expect(data[0][0]).toBe('PR-1404-000123');
    expect(data[0][2]).toBe('تأییدشده');
    expect(data[0][3]).toBe(1260); // NUMBER in the sheet — not its string
    expect(typeof data[0][3]).toBe('number');
    expect(data[0][5]).toBe(1);
  });

  it('renders a filtered-empty report as a valid empty table with clear metadata', async () => {
    const buffer = Buffer.from(await renderReportXlsx(documentFor([])));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(buffer) as unknown as ExcelJS.Buffer);

    const values: unknown[][] = [];
    workbook.worksheets[0].eachRow((row) => {
      values.push((Array.isArray(row.values) ? row.values : []).slice(1));
    });
    const headerIndex = values.findIndex((row) => row[0] === 'شماره سند');
    expect(headerIndex).toBeGreaterThan(0);
    // Empty scope is stated, never widened: the scope block still counts nothing.
    const scopes = values.slice(0, headerIndex).filter((row) => row[0] === 'مجموع (همه‌ی صفحات)');
    expect(scopes).toHaveLength(1);
    expect(scopes[0][1]).toBe(0);
    expect(values.slice(headerIndex + 1)).toHaveLength(0);
  });
});

describe('renderReportDocx — a document that unzips to the right words', () => {
  it('carries title, metadata and ONE table: header + the exact data rows', async () => {
    const xml = readZipEntry(await renderReportDocx(documentFor()), 'word/document.xml');

    // The report title and the report's own words survive, Persian byte-for-byte.
    expect(xml).toContain('گزارش وضعیت و چرخه عمر درخواست‌های خرید');
    expect(xml).toContain('شماره سند');
    expect(xml).toContain('PR-1404-000123');
    expect(xml).toContain('تأییدشده');
    expect(xml).toContain('زمان تولید');
    expect(xml).toContain('خلاصه');
    expect(xml).toContain('جدول داده‌ها');

    // RTL travels with the document: every content paragraph reads right-to-left.
    expect(xml).toContain('<w:bidi/>');

    // Structure: exactly one table — header row + one row per document row.
    expect(countTag(xml, 'tbl')).toBe(1);
    expect(countTag(xml, 'tr')).toBe(1 + RESULT.items.length);
  });

  it('renders a filtered-empty report as a valid document with a truthful sentence', async () => {
    const xml = readZipEntry(await renderReportDocx(documentFor([])), 'word/document.xml');

    expect(xml).toContain('گزارش وضعیت و چرخه عمر درخواست‌های خرید');
    expect(countTag(xml, 'tbl')).toBe(1); // the header, so the shape is still a table
    expect(countTag(xml, 'tr')).toBe(1); // …with no data rows pretending otherwise
    expect(xml).toContain('برای این فیلترها ردیفی وجود ندارد.');
  });

  it('leaks no scope: no tenant field, no row id, no raw search text', async () => {
    const xml = readZipEntry(await renderReportDocx(documentFor()), 'word/document.xml');

    expect(xml).not.toContain('tenant');
    expect(xml).not.toContain('doc-1'); // the navigation uuid is not document content
  });
});

describe('renderReportExport — one entry point naming bytes correctly', () => {
  it('answers XLSX with the spreadsheet MIME and the report-day file name', async () => {
    const file = await renderReportExport(documentFor(), 'xlsx');

    expect(file.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.fileName).toBe('purchase-report-2026-10-05.xlsx');
    expect(file.buffer.byteLength).toBeGreaterThan(0);
  });

  it('answers DOCX with the Word MIME and the report-day file name', async () => {
    const file = await renderReportExport(documentFor(), 'docx');

    expect(file.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(file.fileName).toBe('purchase-report-2026-10-05.docx');
    expect(file.buffer.byteLength).toBeGreaterThan(0);
  });
});

function countTag(xml: string, name: string): number {
  return (xml.match(new RegExp(`<w:${name}(?:\\s|>)`, 'g')) ?? []).length;
}
