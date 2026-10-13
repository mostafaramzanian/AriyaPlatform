import { readFileSync } from 'fs';
import { join } from 'path';
import { RECEIVING_STATUSES, projectReceivingStatus } from './receiving-status';

/**
 * Phase C1 Step R (§5.16, contract R1–R9, §3-B, §7): the receiving status
 * projection — the closed vocabulary, the FOUR rules proved over a grid that
 * reaches every one of them, and the TEXT join to the schema that keeps
 * receiving state a projection for real.
 *
 * WHY THE SCHEMA JOIN LIVES HERE. `receiving-status.ts` states three statuses
 * in TypeScript while `schema.prisma` states the two receiving TABLES — two
 * artifacts neither of which imports the other, exactly as
 * `payment-status.spec.ts` reads its own mirror. The schema's prose says (in
 * sentences this file strips before reading) that neither table carries a
 * receiving-status column (R5): a guard satisfied by prose would be a guard
 * nobody could trust, so the schema is read back as CODE and the absence is
 * asserted there — a `receivingStatus` column added "for speed", a fourth
 * status member, or an enum named after this vocabulary fails HERE rather than
 * in production, where the two homes would disagree about the same line.
 */

/** `src/modules/commerce/receiving` → `apps/api` → the commerce Prisma project. */
const SCHEMA_FILE = join(__dirname, '..', '..', '..', '..', 'prisma', 'commerce', 'schema.prisma');

/** The schema without comment lines or block comments — CODE only. */
function schemaCode(): string {
  return readFileSync(SCHEMA_FILE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** The body of `model <name> { … }` as code, or `''` when the model is absent. */
function modelBody(code: string, name: string): string {
  return new RegExp(`model ${name} \\{([^}]*)\\}`).exec(code)?.[1] ?? '';
}

/** The status a pair projects, or `'<RangeError>'` when the impossible state is refused. */
function statusOrThrow(orderedQuantity: string, receivedQuantity: string): string {
  try {
    return projectReceivingStatus(orderedQuantity, receivedQuantity);
  } catch (error) {
    return error instanceof RangeError ? '<RangeError>' : String(error);
  }
}
describe('Phase C1 Step R — the receiving vocabulary (R5, R9)', () => {
  it('declares exactly §5.16’s three statuses, in the section’s order', () => {
    expect(RECEIVING_STATUSES).toEqual(['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']);
  });

  it('is CLOSED at three: no fourth member describes a state the rules can produce', () => {
    // The refusal R2 states. A vocabulary that admitted OVER_RECEIVED would be a
    // vocabulary describing rows the write path cannot commit, so the projection
    // throws for that input (rule 4) instead of answering it.
    expect(RECEIVING_STATUSES).toHaveLength(3);
    expect(RECEIVING_STATUSES).not.toContain('OVER_RECEIVED');
  });
});

describe('Phase C1 Step R — the projection’s four rules (§3-B)', () => {
  it('rule 1: nothing received is NOT_RECEIVED — no events, or arrivals fully withdrawn', () => {
    expect(projectReceivingStatus('100.0000', '0.0000')).toBe('NOT_RECEIVED');
    // A compensated-to-zero line received nothing AGAIN: the zero test runs
    // before the comparison with ordered, so it never reads as a sliver.
    expect(projectReceivingStatus('100.0000', '-30.0000')).toBe('NOT_RECEIVED');
    // A hypothetical net below zero is answered by the same branch, never by a
    // negative quantity reaching a comparison.
    expect(projectReceivingStatus('100.0000', '-0.0001')).toBe('NOT_RECEIVED');
  });

  it('rule 2: between zero and ordered is PARTIALLY_RECEIVED — a hair below is still partial', () => {
    expect(projectReceivingStatus('100.0000', '0.0001')).toBe('PARTIALLY_RECEIVED');
    expect(projectReceivingStatus('100.0000', '30.0000')).toBe('PARTIALLY_RECEIVED');
    expect(projectReceivingStatus('100.0000', '99.9999')).toBe('PARTIALLY_RECEIVED');
  });

  it('rule 3: exact equality is FULLY_RECEIVED — scale-blind, never a tolerance', () => {
    expect(projectReceivingStatus('26.2500', '26.2500')).toBe('FULLY_RECEIVED');
    // The same stored value in another spelling is the same number: equality is
    // integer equality on the scaled representation, never a float judgement.
    expect(projectReceivingStatus('26.2500', '26.25')).toBe('FULLY_RECEIVED');
    expect(projectReceivingStatus('100', '100.0000')).toBe('FULLY_RECEIVED');
    // And a hair either way is a DIFFERENT status, in both directions.
    expect(projectReceivingStatus('0.3000', '0.2999')).toBe('PARTIALLY_RECEIVED');
    expect(() => projectReceivingStatus('0.3000', '0.3001')).toThrow(RangeError);
  });

  it('rule 4: more than ordered is REFUSED — the impossible state has no vocabulary member', () => {
    expect(() => projectReceivingStatus('100.0000', '100.0001')).toThrow(RangeError);
    expect(() => projectReceivingStatus('100.0000', '100.0001')).toThrow(
      /over-receipt cannot exist in valid persisted history/
    );
    // The refusal NAMES both inputs, so the failure is diagnosable from a log.
    expect(() => projectReceivingStatus('100.0000', '110.0000')).toThrow(
      /ordered 100\.0000, received 110\.0000/
    );
  });

  it('answers every status the vocabulary declares, and refuses only the fourth state', () => {
    const answers = new Set<string>();
    for (const ordered of ['0.0001', '10.0000', '26.2500']) {
      for (const received of [
        '-5.0000',
        '0.0000',
        '0.0001',
        '5.0000',
        '10.0000',
        '26.2500',
        '26.2501',
      ]) {
        answers.add(statusOrThrow(ordered, received));
      }
    }

    for (const status of RECEIVING_STATUSES) expect(answers.has(status)).toBe(true);
    // Non-vacuity for rule 4: the grid REACHED the refusal, so the block above
    // is not proving three statuses on a projection that never refuses one.
    expect(answers.has('<RangeError>')).toBe(true);
    expect(answers.size).toBe(RECEIVING_STATUSES.length + 1);
  });
});
describe('Phase C1 Step R — the vocabulary ↔ schema TEXT join (R5)', () => {
  it('no ReceivingStatus enum and no receiving-status column exists anywhere (R5)', () => {
    const code = schemaCode();
    expect(code).not.toMatch(/ReceivingStatus/);
    expect(code).not.toMatch(/\breceiving_status\b/);
    expect(code).not.toMatch(/\breceivingStatus\b/);
  });

  it('declares none of the three members: the schema has no copy of this vocabulary (R5)', () => {
    // Falsifiable: the cheapest way to "add receiving state" is to reuse the
    // projection's own words as an enum member. The projection must stay the ONE
    // source of truth, so its members are declared in no schema artifact.
    const code = schemaCode();
    for (const status of RECEIVING_STATUSES) {
      expect({ status, declared: new RegExp(`\\b${status}\\b`).test(code) }).toEqual({
        status,
        declared: false,
      });
    }
  });

  it('the Receipt and ReceiptLine models carry no status column and no updatedAt (§3-A, R5)', () => {
    const code = schemaCode();
    const receipt = modelBody(code, 'Receipt');
    const line = modelBody(code, 'ReceiptLine');

    // Non-vacuity: both blocks were actually found and are the receiving tables.
    expect(receipt).toContain('purchase_document_id');
    expect(receipt).toContain('received_at');
    expect(line).toContain('reverses_receipt_line_id');
    expect(line).toContain('quantity');

    for (const [name, body] of [
      ['Receipt', receipt],
      ['ReceiptLine', line],
    ] as const) {
      expect({ name, hasStatus: /\bstatus\b/.test(body) }).toEqual({ name, hasStatus: false });
      expect({ name, hasUpdatedAt: /\bupdatedAt\b/.test(body) }).toEqual({
        name,
        hasUpdatedAt: false,
      });
    }
  });

  it('PurchaseDocument and PurchaseLine store no receiving state — the relation IS the history (R5, R6)', () => {
    const code = schemaCode();
    const document = modelBody(code, 'PurchaseDocument');
    const purchaseLine = modelBody(code, 'PurchaseLine');

    // Non-vacuity: R3 added the two relations, and the projection reads these,
    // never a denormalised column beside them.
    expect(document).toContain('receipts Receipt[] @relation("ReceiptDocument")');
    expect(purchaseLine).toContain(
      'receiptLines ReceiptLine[] @relation("ReceiptLinePurchaseLine")'
    );

    for (const [name, body] of [
      ['PurchaseDocument', document],
      ['PurchaseLine', purchaseLine],
    ] as const) {
      expect({ name, hasStatus: /\breceivingStatus\b|\breceiving_status\b/.test(body) }).toEqual({
        name,
        hasStatus: false,
      });
      expect({
        name,
        hasReceived: /\breceivedQuantity\b|\breceived_quantity\b/.test(body),
      }).toEqual({
        name,
        hasReceived: false,
      });
    }
  });

  it('even the JOIN is tenant-bearing: the relation keys on (tenantId, id) on both sides (R3, §3-F)', () => {
    const receipt = modelBody(schemaCode(), 'Receipt');
    expect(receipt).toContain('fields: [tenantId, purchaseDocumentId], references: [tenantId, id]');
  });
});
