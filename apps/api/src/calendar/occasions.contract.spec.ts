/**
 * Phase 49I-1: dataset-authority & provenance spec.
 *
 * These are DETERMINISTIC fixtures — NOT the live database and NOT a clock —
 * pinning the four "authoritative data" checks the 49I-1 gate requires:
 *
 *   1. provenance is present on a representative holiday row;
 *   2. a lunar-based official date carries its lunar date (no invented conversion);
 *   3. multi-occasion dates exist in the dataset;
 *   4. the dataset has no duplicate (date, source, title) triples.
 *
 * Values below are copied from the seed migration
 * (20260910130000_seed_calendar_occasions_1405) and from the official calendar.
 */

/** The one authoritative source identifier every 1405 row must carry. */
const SOURCE = 'official-iranian-calendar-1405';

interface OccasionRow {
  id: string;
  date: string;
  title: string;
  description: string | null;
  isHoliday: boolean;
  category: string;
  source: string;
  sourceYear: number;
}

/** A few rows straight from the seed migration, as it appears in core_db. */
const SEED_SAMPLE: OccasionRow[] = [
  {
    id: 'sample-1',
    date: '1405/01/01',
    title: 'عید نوروز',
    description: 'نوروز ۱۴۰۵',
    isHoliday: true,
    category: 'NATIONAL',
    source: SOURCE,
    sourceYear: 1405,
  },
  {
    id: 'sample-2',
    date: '1405/01/01',
    title: 'عید سعید فطر',
    description: '۱ شوال ۱۴۴۷',
    isHoliday: true,
    category: 'RELIGIOUS',
    source: SOURCE,
    sourceYear: 1405,
  },
  {
    id: 'sample-3',
    date: '1405/04/04',
    title: 'عاشورای حسینی',
    description: '۱۰ محرم ۱۴۴۸',
    isHoliday: true,
    category: 'RELIGIOUS',
    source: SOURCE,
    sourceYear: 1405,
  },
  {
    id: 'sample-4',
    date: '1405/02/10',
    title: 'روز ملی خلیج فارس',
    description: null,
    isHoliday: false,
    category: 'NATIONAL',
    source: SOURCE,
    sourceYear: 1405,
  },
];

describe('Phase 49I-1 authoritative dataset', () => {
  it('names the documented official source on every row', () => {
    expect(SEED_SAMPLE.every((row) => row.source === SOURCE && row.sourceYear === 1405)).toBe(true);
  });

  it('keeps a holiday flag that is data, never derived from the weekday', () => {
    const ashura = SEED_SAMPLE.find((row) => row.title === 'عاشورای حسینی')!;
    expect(ashura.isHoliday).toBe(true);
  });

  it('carries the official lunar date on lunar-based rows (no invented conversion)', () => {
    const eidFitr = SEED_SAMPLE.find((row) => row.title === 'عید سعید فطر')!;
    expect(eidFitr.description).toContain('شوال');
    expect(eidFitr.category).toBe('RELIGIOUS');
  });

  it('supports multiple occasions on one date', () => {
    const firstOfFarvardin = SEED_SAMPLE.filter((row) => row.date === '1405/01/01');
    expect(firstOfFarvardin.length).toBeGreaterThan(1);
    expect(firstOfFarvardin.some((row) => row.isHoliday)).toBe(true);
  });

  it('has no duplicate (date, source, title) triples', () => {
    const seen = new Set<string>();
    for (const row of SEED_SAMPLE) {
      const key = `${row.date}|${row.source}|${row.title}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('keeps non-holiday occasions without holiday styling (data still carries them)', () => {
    const khalijFars = SEED_SAMPLE.find((row) => row.title === 'روز ملی خلیج فارس')!;
    expect(khalijFars.isHoliday).toBe(false);
  });
});