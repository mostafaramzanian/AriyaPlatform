import { readFileSync } from 'fs';
import { join } from 'path';
import { QUOTATION_DECISIONS } from './quotation.constants';
import {
  classifyPurchaseRouting,
  DEFAULT_PURCHASE_CASH_MAX_AMOUNT,
  QUOTATION_DOCUMENT_STATUSES,
  QUOTATION_STATUSES,
  QUOTATION_TARGET_OF,
  QUOTATION_TRANSITIONS,
  canQuoteDocument,
  canTransitionQuotation,
} from './quotation';

/**
 * PHASE GAP-6: the quotation vocabulary's contract, at the seam where it decides.
 *
 * THE SCHEMA IS READ AS TEXT (the `purchase-status.spec.ts` precedent): the
 * enum this module's pure tuple claims exists is the SAME string the database
 * holds, and no import can prove that — the schema is not a module. A drift
 * between `QUOTATION_STATUSES` and `enum QuotationStatus` therefore fails here
 * rather than at a runtime cast.
 */
const SCHEMA_PATH = join(__dirname, '..', '..', '..', '..', 'prisma', 'commerce', 'schema.prisma');
const schemaCode = (): string => readFileSync(SCHEMA_PATH, 'utf8');

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'commerce',
  'migrations',
  '20261017000000_price_quotation',
  'migration.sql'
);
const migrationCode = (): string => readFileSync(MIGRATION_PATH, 'utf8');

describe('GAP-6 quotation vocabulary — pure, total, and joined to both artifacts', () => {
  it('the tuple is exactly the schema enum, in order, and the migration created the same members', () => {
    const block = /enum QuotationStatus \{([^}]*)\}/.exec(schemaCode())?.[1] ?? '';
    // Non-vacuity: the enum was actually found.
    expect(block).toContain('PENDING');
    const members = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('@'));
    expect(members).toEqual([...QUOTATION_STATUSES]);

    // And the history says the same thing — the enum type the database holds.
    const created = /CREATE TYPE "QuotationStatus" AS ENUM \(([^)]*)\)/.exec(migrationCode())?.[1] ?? '';
    expect(
      created
        .split(',')
        .map((value) => value.trim().replace(/^'|'$/g, ''))
        .filter((value) => value.length > 0)
    ).toEqual([...QUOTATION_STATUSES]);
  });

  it('the transition table is TOTAL and refuses every route out of a decided state', () => {
    expect(Object.keys(QUOTATION_TRANSITIONS).sort()).toEqual([...QUOTATION_STATUSES].sort());
    expect(QUOTATION_TRANSITIONS.PENDING).toEqual(['CONFIRMED', 'RETURNED']);
    expect(QUOTATION_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(QUOTATION_TRANSITIONS.RETURNED).toEqual([]);
    // Frozen: a caller cannot grow the table at runtime.
    expect(Object.isFrozen(QUOTATION_TRANSITIONS)).toBe(true);
  });

  it('answers each legal transition and refuses each illegal one', () => {
    expect(canTransitionQuotation('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransitionQuotation('PENDING', 'RETURNED')).toBe(true);
    expect(canTransitionQuotation('PENDING', 'PENDING')).toBe(false);
    expect(canTransitionQuotation('CONFIRMED', 'RETURNED')).toBe(false);
    expect(canTransitionQuotation('RETURNED', 'CONFIRMED')).toBe(false);
    expect(canTransitionQuotation('CONFIRMED', 'PENDING')).toBe(false);
  });

  it('lands every wire decision on a LEGAL transition — the map cannot invent an edge', () => {
    expect(Object.keys(QUOTATION_TARGET_OF).sort()).toEqual([...QUOTATION_DECISIONS].sort());
    for (const decision of QUOTATION_DECISIONS) {
      expect(canTransitionQuotation('PENDING', QUOTATION_TARGET_OF[decision])).toBe(true);
    }
  });

  it('admits exactly the in-circulation document statuses — CLOSED and CANCELLED refuse', () => {
    expect([...QUOTATION_DOCUMENT_STATUSES]).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
    expect(canQuoteDocument('DRAFT')).toBe(true);
    expect(canQuoteDocument('SUBMITTED')).toBe(true);
    expect(canQuoteDocument('APPROVED')).toBe(true);
    expect(canQuoteDocument('CLOSED')).toBe(false);
    expect(canQuoteDocument('CANCELLED')).toBe(false);
  });
});

describe('GAP-6 follow-up — cash / non-cash routing over the confirmed quotation total', () => {
  const THRESHOLD = DEFAULT_PURCHASE_CASH_MAX_AMOUNT;

  it('defaults to the documented provisional ceiling (30,000,000)', () => {
    expect(THRESHOLD).toBe(30_000_000);
  });

  it('classifies below-threshold as CASH and above-threshold as NON_CASH', () => {
    expect(classifyPurchaseRouting('29999999.9999', THRESHOLD)).toBe('CASH');
    expect(classifyPurchaseRouting('30000001.0000', THRESHOLD)).toBe('NON_CASH');
  });

  it('treats the threshold itself as CASH — the boundary is inclusive, stated once', () => {
    expect(classifyPurchaseRouting('30000000.0000', THRESHOLD)).toBe('CASH');
  });

  it('classifies nothing without a confirmed total, and nothing with an unusable threshold', () => {
    expect(classifyPurchaseRouting(null, THRESHOLD)).toBeNull();
    expect(classifyPurchaseRouting('100.0000', Number.NaN)).toBeNull();
    expect(classifyPurchaseRouting('100.0000', -1)).toBeNull();
  });
});
