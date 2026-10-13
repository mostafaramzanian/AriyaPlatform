/**
 * KPI governance guards, part 1 (§29): architecture no-leakage.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * No runtime leakage: the governance layer imports nothing executable from any bounded
 * context. Non-spec files under `src/kpi/` may only `import type` from this folder's model,
 * the four domain-owned reporting seam contracts, and the pure domain vocabularies — everything
 * erased at compile time. No `@nestjs`, no Prisma, no repository, service, controller, DTO,
 * or database token is reachable; no decorator, no clock, no `eval`, no SQL string exists.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const KPI_DIR = __dirname;

/** Every TypeScript file in the KPI governance folder (specs included). */
function kpiFiles(): string[] {
  return readdirSync(KPI_DIR)
    .map((entry) => join(KPI_DIR, entry))
    .filter((full) => !statSync(full).isDirectory() && full.endsWith('.ts'));
}

/** Non-spec governance sources — the files the no-leakage rule applies to. */
function kpiSources(): string[] {
  return kpiFiles().filter((file) => !file.endsWith('.spec.ts'));
}

function codeOf(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

function importSpecifiers(file: string): string[] {
  const found: string[] = [];
  const pattern = /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const line of codeOf(file)) {
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (match && match[1]) found.push(match[1]);
  }
  return found;
}

function isTypeOnlyImport(file: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*import\\s+type\\s+[^'"]*?\\s+from\\s+['"]${escaped}['"]`);
  return codeOf(file).some((line) => pattern.test(line));
}

describe('KPI governance — no runtime leakage (§29)', () => {
  it('keeps every governance source free of executable domain imports', () => {
    const allowed = [
      './kpi-definition.model',
      '../modules/production/',
      '../modules/commerce/',
      '../modules/financial/',
      '../modules/hr/',
    ];
    const forbidden = ['prisma', 'generated', '@nestjs', 'repository', 'service', 'controller'];
    for (const file of kpiSources()) {
      for (const specifier of importSpecifiers(file)) {
        const ok = allowed.some((prefix) => specifier.startsWith(prefix));
        expect({ file, specifier, ok }).toEqual({ file, specifier, ok: true });
        for (const needle of forbidden) {
          expect({ file, specifier, needle, leaked: specifier.includes(needle) }).toEqual({
            file,
            specifier,
            needle,
            leaked: false,
          });
        }
      }
    }
  });

  it('imports across bounded contexts by type only (erased, never a runtime link)', () => {
    for (const file of kpiSources()) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier.startsWith('../modules/')) {
          expect({ file, specifier, typeOnly: isTypeOnlyImport(file, specifier) }).toEqual({
            file,
            specifier,
            typeOnly: true,
          });
        }
      }
    }
  });

  it('contains no surface of any kind: no decorator, no clock, no eval, no SQL', () => {
    const surface = ['@Injectable', '@Controller', '@Get(', '@Post(', '@Module('];
    const executable = ['eval(', 'new Function(', 'SELECT ', 'INSERT INTO', 'new Date('];
    for (const file of kpiSources()) {
      const text = readFileSync(file, 'utf8');
      for (const marker of surface.concat(executable)) {
        expect({ file, marker, present: text.includes(marker) }).toEqual({
          file,
          marker,
          present: false,
        });
      }
    }
  });

  it('ships no controller, module, service, or DTO file inside the governance folder', () => {
    for (const file of kpiFiles()) {
      const base = file.split(/[\\/]/).pop() ?? '';
      for (const suffix of ['.controller.ts', '.module.ts', '.service.ts', '.dto.ts']) {
        expect({ base, suffix, present: base.endsWith(suffix) }).toEqual({
          base,
          suffix,
          present: false,
        });
      }
    }
  });
});

/**
 * KPI governance guards, part 2 (§30): documentation guards.
 *
 * `docs/architecture/KPI-CATALOG.md` is the primary governance record, and this spec pins
 * it to the typed registry — same nine KPI IDs, same technical keys (unique on both sides),
 * same statuses. Blocked and draft KPI sections contain no runtime-implementation claims.
 */

import { KPI_CATALOG, getKpiById } from './kpi-catalog';

const CATALOG_DOC = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'architecture',
  'KPI-CATALOG.md'
);

describe('KPI governance — documentation guards (§30)', () => {
  it('finds the catalog document exactly where the governance contract says it lives', () => {
    expect(existsSync(CATALOG_DOC)).toBe(true);
  });

  it('keeps catalog identifiers unique and aligned with the typed registry', () => {
    const text = readFileSync(CATALOG_DOC, 'utf8');
    const headings = [...text.matchAll(/^##\s+(KPI-\d{3})\b/gm)].map((m) => m[1] as string);
    const keys = [...text.matchAll(/^- Technical key: `([a-z0-9-]+)`$/gm)].map(
      (m) => m[1] as string
    );
    expect(headings).toHaveLength(KPI_CATALOG.length);
    expect(new Set(headings).size).toBe(KPI_CATALOG.length);
    expect(new Set(keys).size).toBe(KPI_CATALOG.length);
    for (const entry of KPI_CATALOG) {
      expect(headings).toContain(entry.id);
      expect(keys).toContain(entry.technicalKey);
      expect(getKpiById(entry.id)?.status).toBe(entry.status);
    }
  });

  it('keeps catalog statuses aligned with the typed registry', () => {
    const text = readFileSync(CATALOG_DOC, 'utf8');
    const lines = text.split(/\r?\n/);
    const docById = new Map<string, string>();
    let current: string | null = null;
    for (const line of lines) {
      const heading = /^##\s+(KPI-\d{3})\b/.exec(line);
      if (heading?.[1]) {
        current = heading[1];
        continue;
      }
      const status = /^- Status: `(DRAFT|EVIDENCE_REVIEW|APPROVED|BLOCKED|DEPRECATED)`$/.exec(line);
      if (status?.[1] && current) {
        docById.set(current, status[1]);
        current = null;
      }
    }
    expect(docById.size).toBe(KPI_CATALOG.length);
    for (const entry of KPI_CATALOG) {
      expect(docById.get(entry.id)).toBe(entry.status);
    }
  });

  it('lets blocked and draft KPIs document only governance — no runtime claims', () => {
    const text = readFileSync(CATALOG_DOC, 'utf8');
    const forbidden = ['@Controller', '@Get(', 'GET /api', 'POST /api', 'prisma.', 'CREATE TABLE'];
    const lines = text.split(/\r?\n/);
    const sections = new Map<string, string[]>();
    let current: string | null = null;
    for (const line of lines) {
      const heading = /^##\s+(KPI-\d{3})\b/.exec(line);
      if (heading?.[1]) {
        current = heading[1];
        sections.set(current, []);
        continue;
      }
      if (current && /^##\s/.test(line)) current = null;
      if (current) sections.get(current)?.push(line);
    }
    expect(sections.size).toBe(KPI_CATALOG.length);
    for (const entry of KPI_CATALOG) {
      if (entry.status !== 'BLOCKED' && entry.status !== 'DRAFT') continue;
      const section = (sections.get(entry.id) ?? []).join('\n');
      for (const marker of forbidden) {
        expect(section.includes(marker)).toBe(false);
      }
    }
  });
});
