import { readFileSync } from 'fs';
import { join } from 'path';
import { PAYMENT_METHODS, PAYMENT_STATUSES, projectPaymentStatus } from './payment-status';

/**
 * Phase C1 Step Q (§5.13, contract §2-Q2, §3-B and §7): the payment status projection —
 * the closed vocabulary, the five rules proved exhaustively over it, and the TEXT join
 * to the schema that keeps the vocabulary closed for real.
 *
 * WHY THE SCHEMA JOIN LIVES HERE. `payment-status.ts` states four statuses and three
 * methods in TypeScript while `schema.prisma` states the `PaymentMethod` enum — two
 * copies of one list, and neither imports the other (the mirror of
 * `purchase-status.spec.ts`). This file reads the schema back as TEXT so the drift is
 * falsifiable: a fourth method added to the tuple without the enum member, or the
 * `PaymentStatus` column Q2 forbids appearing anywhere, fails here rather than in
 * production. The schema's comments are stripped first: its own documentation says
 * "there is deliberately NO PaymentStatus column", and a guard satisfied by prose would
 * be a guard nobody could trust.
 */

/** `src/modules/commerce/payment` → `apps/api` → the commerce Prisma project. */
const SCHEMA_FILE = join(__dirname, '..', '..', '..', '..', 'prisma', 'commerce', 'schema.prisma');

/** The schema without comment lines or block comments — CODE only. */
function schemaCode(): string {
  return readFileSync(SCHEMA_FILE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** The members of `enum <name> { … }`, in declaration order, from code text. */
function enumMembers(code: string, name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(code)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('Phase C1 Step Q — the payment vocabulary', () => {
  it('declares exactly §5.13’s four statuses, in the section’s order', () => {
    expect(PAYMENT_STATUSES).toEqual(['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID']);
  });

  it('declares exactly contract Q3’s three methods — CHECK is a label, not a finance entity', () => {
    expect(PAYMENT_METHODS).toEqual(['CASH', 'PETTY_CASH', 'CHECK']);
  });
});

describe('Phase C1 Step Q — the projection’s five rules (§3-B)', () => {
  it('rule 1: an unstated total projects null — never UNPAID, never zero-on-its-behalf', () => {
    expect(projectPaymentStatus(null, '0.0000')).toBeNull();
    expect(projectPaymentStatus(null, '70.0000')).toBeNull();
  });

  it('rule 2: nothing paid is UNPAID — no rows, only reversals, or a zero-priced document', () => {
    expect(projectPaymentStatus('100.0000', '0.0000')).toBe('UNPAID');
    // Compensating rows are negative: a document whose payments were all reversed owes
    // nothing again (test 16's projection half).
    expect(projectPaymentStatus('100.0000', '-30.0000')).toBe('UNPAID');
    // Free lines total 0.0000; with nothing paid rule 2 answers UNPAID, not PAID.
    expect(projectPaymentStatus('0.0000', '0.0000')).toBe('UNPAID');
  });

  it('rule 3: exact equality is PAID — scale-blind, never a tolerance', () => {
    expect(projectPaymentStatus('26.2500', '26.2500')).toBe('PAID');
    expect(projectPaymentStatus('26.2500', '26.25')).toBe('PAID');
    // A hair either way is a different status: equality is integer equality on the
    // stored representation, never float judgement.
    expect(projectPaymentStatus('0.3000', '0.2999')).toBe('PARTIAL');
    expect(projectPaymentStatus('0.3000', '0.3001')).toBe('OVERPAID');
  });

  it('rule 4: more than the total is OVERPAID — including money against a zero total', () => {
    expect(projectPaymentStatus('100.0000', '100.0001')).toBe('OVERPAID');
    // The document asked for nothing and money arrived anyway: correct, not a glitch.
    expect(projectPaymentStatus('0.0000', '0.0001')).toBe('OVERPAID');
  });

  it('rule 5: between zero and the total is PARTIAL', () => {
    expect(projectPaymentStatus('100.0000', '30.0000')).toBe('PARTIAL');
    expect(projectPaymentStatus('100.0000', '70.0000')).toBe('PARTIAL');
    expect(projectPaymentStatus('100.0000', '99.9999')).toBe('PARTIAL');
  });

  it('answers every status the vocabulary declares, so no member is unreachable', () => {
    const answers = new Set<string | null>();
    // `null` is sampled too: rule 1 must be reachable, and a grid without an unstated
    // total would never exercise it.
    for (const total of [null, '0.0000', '10.0000', '26.2500']) {
      for (const paid of [
        '-5.0000',
        '0.0000',
        '0.0001',
        '5.0000',
        '10.0000',
        '26.2500',
        '26.2501',
      ]) {
        answers.add(projectPaymentStatus(total, paid));
      }
    }

    for (const status of PAYMENT_STATUSES) expect(answers.has(status)).toBe(true);
    expect(answers.has(null)).toBe(true);
  });
});

describe('Phase C1 Step Q — the vocabulary ↔ schema TEXT join', () => {
  it('PAYMENT_METHODS equals the schema’s PaymentMethod members, in order', () => {
    expect(enumMembers(schemaCode(), 'PaymentMethod')).toEqual([...PAYMENT_METHODS]);
  });

  it('no PaymentStatus enum or column exists anywhere — the projection has ONE source of truth (Q2)', () => {
    const code = schemaCode();
    expect(code).not.toMatch(/PaymentStatus/);
    expect(code).not.toMatch(/\bpayment_status\b/);
  });

  it('the PaymentRecord model carries no status column and no updatedAt (§3-A, Q2)', () => {
    const model = /model PaymentRecord \{([^}]*)\}/.exec(schemaCode())?.[1] ?? '';
    // Non-vacuity: the block was actually found.
    expect(model).toContain('purchase_document_id');
    expect(model).not.toMatch(/\bstatus\b/);
    expect(model).not.toMatch(/\bupdatedAt\b/);
  });
});
