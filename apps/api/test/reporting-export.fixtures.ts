import { inflateRawSync } from 'node:zlib';
import type { Response as SuperagentResponse } from 'superagent';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT — binary export assertions, shared by the four
 * reporting E2E suites. ONE helper, no spec changes to what these files assert about
 * their own slices.
 *
 * BOTH formats are parsed, never eyeballed:
 *  * XLSX is an OOXML zip: the sheet XML is read from `xl/worksheets/sheet1.xml` and
 *    SHARED strings are resolved through `xl/sharedStrings.xml`, so «the table has N
 *    rows and the first header is X» is a statement about the DOCUMENT, not the bytes.
 *  * DOCX is an OOXML zip too: `word/document.xml` is read as text and the assertions
 *    run on WORDS and on the single-table structure (header + N data rows).
 *
 * The unzipper is local (~30 lines, `zlib` deflate + central-directory walking) because
 * no zip library lives in the workspace, and admitting one merely to read test output
 * back would be a document dependency for no product reason.
 */

export const EXPORT_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const EXPORT_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Reads one entry of a ZIP archive (xlsx/docx) by name, as UTF-8 text. */
export function readZipEntry(archive: Buffer, entryName: string): string {
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

/** Supertest parses a binary body into `{}` — the RAW bytes live on the response. */
export function responseBuffer(res: {
  body: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Buffer {
  const rawBody = res.body as unknown;
  // The forced binary parser (getExportFile) delivers the exact bytes as the body —
  // preferred over any text form, which cannot round-trip OOXML bytes safely.
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody && Array.isArray((rawBody as { data?: unknown }).data)) {
    return Buffer.from((rawBody as { data: number[] }).data);
  }
  if (typeof res.text === 'string' && res.text.length > 0) {
    return Buffer.from(res.text, 'binary');
  }
  throw new Error('no binary body on this export response');
}

/**
 * GETs an export path with binary buffering FORCED, so the bytes survive supertest
 * untouched: superagent's default handling would decode the OOXML body as UTF-8 text
 * and corrupt it (multi-byte sequences do not round-trip), which is exactly how a
 * «corrupt central directory» appears in a test that never saw a corrupted FILE.
 *
 * Returns the supertest request — status, `content-type` and `content-disposition`
 * assertions work as usual — with the raw bytes readable through `responseBuffer`.
 */
/**
 * The agent the e2e harness passes in (supertest over the booted app), whose
 * `get` chained with the binary-forcing `buffer`/`parse` keeps the OOXML
 * bytes intact through `responseBuffer` below.
 */
/**
 * supertest's `Test` (what `makeRequest()` returns) narrows superagent's `get`
 * signature, so `Pick<SuperagentClient, 'get'>` does not accept it. A structural
 * shape of exactly what `getExportFile` chains is assignable from both agents.
 */
interface ExportFileRequestLike {
  set(field: string, value: string): this;
  buffer(flag: boolean): this;
  parse(
    parser: (
      res: SuperagentResponse,
      callback: (error: Error | null, body?: Buffer) => void
    ) => void
  ): this;
}

export type ExportFileAgent = {
  get(url: string): ExportFileRequestLike;
};

export function getExportFile<R extends ExportFileRequestLike>(
  request: { get(url: string): R },
  url: string,
  token: string
): R {
  return request
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res: SuperagentResponse, callback: (error: Error | null, body?: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | Uint8Array) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      res.on('end', () => callback(null, Buffer.concat(chunks)));
      res.on('error', (error: unknown) => callback(error as Error));
    });
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface XlsxSheet {
  /** First-column string per physical row, in order — metadata, headers, data alike. */
  firstColumn: string[];
  /** The exact header row (the row whose first cell is the expected first header). */
  header: string[];
  /** Data rows strictly below the header. */
  data: string[][];
}

function sheetTextOfCell(
  cell: string,
  shared: string[] | null,
  inlineTexts: Map<string, string>
): string {
  const typeMatch = /<c\b[^>]*\bt="([^"]+)"/.exec(cell.slice(0, 200));
  const type = typeMatch?.[1];
  if (type === 'inlineStr') {
    const cached = inlineTexts.get(cell);
    if (cached !== undefined) return cached;
    const texts = [...cell.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1]));
    const joined = texts.join('');
    inlineTexts.set(cell, joined);
    return joined;
  }
  const value = (/<v>([^<]*)<\/v>/.exec(cell) ?? [])[1];
  if (value === undefined) return '';
  if (type === 's') {
    const index = Number(value);
    if (shared && Number.isInteger(index) && shared[index] !== undefined) return shared[index];
    return '';
  }
  return unescapeXml(value);
}

/**
 * Parses sheet 1 of an XLSX buffer into rows of DISPLAY text — shared-string aware, so a
 * Persian header is found by VALUE rather than by row number: «metadata above, data
 * below» is a contract the test locates, never assumes.
 */
export function parseXlsxSheet(buffer: Buffer, expectedFirstHeader: string): XlsxSheet {
  const sheetXml = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');

  let shared: string[] | null = null;
  try {
    const sharedXml = readZipEntry(buffer, 'xl/sharedStrings.xml');
    shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
      [...item[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1])).join('')
    );
  } catch {
    shared = null;
  }

  const inlineTexts = new Map<string, string>();
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [...rowMatch[1].matchAll(/<c\b[\s\S]*?(?:\/>|<\/c>)/g)].map((m) =>
      sheetTextOfCell(m[0], shared, inlineTexts)
    );
    rows.push(cells);
  }

  const headerIndex = rows.findIndex((row) => row[0] === expectedFirstHeader);
  if (headerIndex < 0) {
    throw new Error(`header row starting with ${expectedFirstHeader} not found in this sheet`);
  }

  return {
    firstColumn: rows.map((row) => row[0] ?? ''),
    header: rows[headerIndex],
    data: rows.slice(headerIndex + 1),
  };
}

/** Counts XML open-tags of an exact element name (`tr`, `tbl` — never `trPr`). */
export function countTag(xml: string, name: string): number {
  return (xml.match(new RegExp(`<w:${name}(?:\\s|>)`, 'g')) ?? []).length;
}
