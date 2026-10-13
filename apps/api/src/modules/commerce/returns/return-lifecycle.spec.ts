import { readFileSync } from 'fs';
import { join } from 'path';
import {
  RETURN_STATES,
  canTransition,
  legalTransitionSources,
  projectReturnState,
  type ReturnState,
} from './return-lifecycle';

/**
 * Phase C1 Step S (contract §13, "Domain / projection"): the return lifecycle
 * read BACK as code — the executable form of S-D2 and §4-A, with the schema
 * joined in as TEXT (the two artifacts cannot import each other, exactly like
 * `purchase-status.spec.ts` and Q2's guard).
 *
 * WHAT IS PINNED, AND WHY EACH PIN IS FALSIFIABLE
 * ------------------------------------------------
 *  A. the MATRIX, EXHAUSTIVELY: all 5×5 = 25 ordered pairs — the four legal
 *     paths accepted, the other twenty-one refused. Sampling four pairs would
 *     let a wildcard (`from !== 'REJECTED'`) pass; the full cross product is
 *     the only shape that cannot.
 *  B. TERMINAL RULES: `REJECTED` and `REFUNDED` accept NOTHING out — not
 *     even "back to REQUESTED" (S-D4: no reverse path, no correction).
 *  C. `legalTransitionSources` — the `<sources>` half of §10's exact 409
 *     message, derived from the matrix rather than restated beside it.
 *  D. PROJECTION: first row `REQUESTED`, last row wins, `(createdAt, id)`
 *     determinism INCLUDING the tie-break, shuffled input normalised.
 *  E. IMPOSSIBLE HISTORIES are refused deterministically: empty, a first row
 *     that is not `REQUESTED`, a pair the matrix forbids, a row after a
 *     terminal state. A projection that defaulted instead of refusing would
 *     hand out a state no row ever stated.
 *  F. VOCABULARY ↔ SCHEMA: `ReturnState` is exactly the five §5.17 states in
 *     order, IN BOTH ARTIFACTS — and NO `ReturnDocument.status`/`state`
 *     column and NO `updatedAt` on any of the three S tables exists anywhere
 *     in the schema (S-D2's falsifiable half: state lives once, on the
 *     history rows).
 *
 * NON-VACUITY. The schema scans read the REAL file and assert the blocks they
 * scanned were non-empty; a walk that matched nothing fails instead of
 * passing quietly.
 */

const SCHEMA_FILE = join(__dirname, '..', '..', '..', '..', 'prisma', 'commerce', 'schema.prisma');
const schemaText = readFileSync(SCHEMA_FILE, 'utf8');

/** The body of `enum <name> { … }` or `model <name> { … }`, or '' when absent. */
function schemaBlock(kind: 'enum' | 'model', name: string): string {
  const start = schemaText.indexOf(`${kind} ${name} {`);
  if (start < 0) return '';
  const end = schemaText.indexOf('\n}', start);
  return end < 0 ? '' : schemaText.slice(start, end);
}

/** The declared members of an enum block, in order. */
function enumMembers(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z_]*$/.test(line));
}

/** The FULL cross product — every ordered pair of the five states. */
const ALL_PAIRS: [ReturnState, ReturnState][] = RETURN_STATES.flatMap((from) =>
  RETURN_STATES.map((to) => [from, to] as [ReturnState, ReturnState])
);

/** S-D2's four allowed paths, as the closed table this suite judges against. */
const ALLOWED: [ReturnState, ReturnState][] = [
  ['REQUESTED', 'APPROVED'],
  ['REQUESTED', 'REJECTED'],
  ['APPROVED', 'RECEIVED_BACK'],
  ['RECEIVED_BACK', 'REFUNDED'],
];

const isAllowed = (from: ReturnState, to: ReturnState) =>
  ALLOWED.some(([a, b]) => a === from && b === to);

/** One transition row for the projection fixtures — explicit clocks, explicit ids. */
function row(id: string, state: ReturnState, createdAt: string) {
  return { id, state, createdAt: new Date(createdAt) };
}

const T0 = '2026-09-29T10:00:00.000Z';
const T1 = '2026-09-29T10:00:01.000Z';
const T2 = '2026-09-29T10:00:02.000Z';

describe('C1 step S: the return transition matrix (S-D2, §4-A)', () => {
  it('A. accepts exactly the four legal paths and refuses every other one of the 5×5 pairs', () => {
    expect(ALL_PAIRS).toHaveLength(25); // non-vacuity: the cross product is complete
    const accepted: string[] = [];
    for (const [from, to] of ALL_PAIRS) {
      const allowed = isAllowed(from, to);
      if (allowed) accepted.push(`${from} -> ${to}`);
      expect({ from, to, actual: canTransition(from, to) }).toEqual({ from, to, actual: allowed });
    }
    // …and the accepted set is EXACTLY S-D2's four, not merely a subset of them.
    expect(accepted.sort()).toEqual(
      [
        'APPROVED -> RECEIVED_BACK',
        'RECEIVED_BACK -> REFUNDED',
        'REQUESTED -> APPROVED',
        'REQUESTED -> REJECTED',
      ].sort()
    );
  });

  it('B. treats REJECTED and REFUNDED as terminal — nothing comes out, not even backwards', () => {
    for (const terminal of ['REJECTED', 'REFUNDED'] as const) {
      for (const to of RETURN_STATES) {
        expect({ terminal, to, allowed: canTransition(terminal, to) }).toEqual({
          terminal,
          to,
          allowed: false,
        });
      }
    }
    // The reverse paths a "cancel the rejection" feature would need, named.
    expect(canTransition('REJECTED', 'REQUESTED')).toBe(false);
    expect(canTransition('REFUNDED', 'RECEIVED_BACK')).toBe(false);
    expect(canTransition('REFUNDED', 'REQUESTED')).toBe(false);
  });

  it("C. derives each target's legal sources — the <sources> of §10's 409 message", () => {
    expect(legalTransitionSources('APPROVED')).toEqual(['REQUESTED']);
    expect(legalTransitionSources('REJECTED')).toEqual(['REQUESTED']);
    expect(legalTransitionSources('RECEIVED_BACK')).toEqual(['APPROVED']);
    expect(legalTransitionSources('REFUNDED')).toEqual(['RECEIVED_BACK']);
    // REQUESTED is creation's own row: no command may produce it, so the set
    // of sources is empty — no command "to REQUESTED" exists to refuse from.
    expect(legalTransitionSources('REQUESTED')).toEqual([]);
  });
});

describe('C1 step S: the read-time projection (§4-A)', () => {
  it('D. answers the FIRST row when it is the only one — creation wrote REQUESTED', () => {
    expect(projectReturnState([row('a', 'REQUESTED', T0)])).toBe('REQUESTED');
  });

  it('D. answers the LAST row of a complete legal history', () => {
    const path = [
      row('a', 'REQUESTED', T0),
      row('b', 'APPROVED', T1),
      row('c', 'RECEIVED_BACK', T2),
      row('d', 'REFUNDED', '2026-09-29T10:00:03.000Z'),
    ];
    expect(projectReturnState(path)).toBe('REFUNDED');
    // The rejection branch's own end.
    expect(projectReturnState([row('a', 'REQUESTED', T0), row('b', 'REJECTED', T1)])).toBe(
      'REJECTED'
    );
  });

  it('D. orders by (createdAt, id) — shuffled input normalises, and a shared millisecond breaks on the id', () => {
    // Shuffled: the projection owns the order, not the storage. The legal
    // chain is REQUESTED -> APPROVED -> RECEIVED_BACK, presented backwards.
    const shuffled = [
      row('c', 'RECEIVED_BACK', T2),
      row('b', 'APPROVED', T1),
      row('a', 'REQUESTED', T0),
    ];
    expect(projectReturnState(shuffled)).toBe('RECEIVED_BACK');
    // Same instant, two rows: `id` decides — '1' before '2' — so the answer
    // does not depend on how the database happened to return them. With the
    // id order swapped the storage order would put APPROVED first, which the
    // chain would then refuse: only the (createdAt, id) sort makes it legal.
    const tied = [row('2', 'APPROVED', T0), row('1', 'REQUESTED', T0)];
    expect(projectReturnState(tied)).toBe('APPROVED');
    const tiedReversed = [row('1', 'REQUESTED', T0), row('2', 'APPROVED', T0)];
    expect(projectReturnState(tiedReversed)).toBe('APPROVED');
  });

  it('E. refuses an empty history rather than defaulting a state no row stated', () => {
    expect(() => projectReturnState([])).toThrow(/empty history has no state/);
  });

  it('E. refuses a first row that is not REQUESTED — creation always writes it', () => {
    expect(() => projectReturnState([row('a', 'APPROVED', T0)])).toThrow(/not REQUESTED/);
    expect(() => projectReturnState([row('a', 'REJECTED', T0)])).toThrow(/not REQUESTED/);
  });

  it('E. refuses a pair the matrix forbids, and anything after a terminal state', () => {
    expect(() =>
      projectReturnState([row('a', 'REQUESTED', T0), row('b', 'RECEIVED_BACK', T1)])
    ).toThrow(/REQUESTED -> RECEIVED_BACK is not an allowed transition/);
    expect(() =>
      projectReturnState([
        row('a', 'REQUESTED', T0),
        row('b', 'REJECTED', T1),
        row('c', 'APPROVED', T2),
      ])
    ).toThrow(/REJECTED -> APPROVED is not an allowed transition/);
    expect(() =>
      projectReturnState([
        row('a', 'REQUESTED', T0),
        row('b', 'APPROVED', T1),
        row('c', 'RECEIVED_BACK', T2),
        row('d', 'REFUNDED', '2026-09-29T10:00:03.000Z'),
        row('e', 'REJECTED', '2026-09-29T10:00:04.000Z'),
      ])
    ).toThrow(/REFUNDED -> REJECTED is not an allowed transition/);
  });

  it('E. judges the SORTED order — an impossible pair hidden behind shuffled timestamps is still refused', () => {
    // Out of storage order, and the illegal edge is only visible AFTER the
    // sort: RECEIVED_BACK (t2) followed by nothing legal from REQUESTED(t0).
    expect(() =>
      projectReturnState([row('b', 'RECEIVED_BACK', T2), row('a', 'REQUESTED', T0)])
    ).toThrow(/REQUESTED -> RECEIVED_BACK is not an allowed transition/);
  });
});

describe('C1 step S: vocabulary ↔ schema (S-D2, §5.17, contract §6)', () => {
  it("F. the TS vocabulary is exactly the five §5.17 states, in the specification's order", () => {
    expect([...RETURN_STATES]).toEqual([
      'REQUESTED',
      'APPROVED',
      'RECEIVED_BACK',
      'REFUNDED',
      'REJECTED',
    ]);
  });

  it('F. the schema enum declares the SAME five members, in the SAME order (a sixth fails both directions)', () => {
    const body = schemaBlock('enum', 'ReturnState');
    expect(body.length).toBeGreaterThan(0); // non-vacuity: the block was really found
    expect(enumMembers(body)).toEqual([...RETURN_STATES]);
  });

  it('F. ReturnDocument has NO status/state column and NO updatedAt — state lives on the history rows only', () => {
    const document = schemaBlock('model', 'ReturnDocument');
    expect(document.length).toBeGreaterThan(0); // non-vacuity
    // A column, not a comment: the scan drops comment lines first, so the
    // model's own prose explaining the ABSENCE cannot mask a real field.
    const fields = document
      .split('\n')
      .filter((line) => !line.trim().startsWith('///'))
      .join('\n');
    expect(fields).not.toMatch(/^\s+status\s/m);
    expect(fields).not.toMatch(/^\s+state\s/m);
    expect(fields).not.toMatch(/^\s+updatedAt\s/m);
    // The history tables carry the state and the clock, and nothing carries
    // a mutable timestamp: append-only means there is nothing to update.
    expect(schemaBlock('model', 'ReturnLifecycleTransition')).toMatch(
      /^\s+state\s+ReturnState\s*$/m
    );
    for (const model of ['ReturnDocument', 'ReturnLine', 'ReturnLifecycleTransition']) {
      const block = schemaBlock('model', model);
      expect(block.length).toBeGreaterThan(0); // non-vacuity
      expect({ model, hasUpdatedAt: /\bupdatedAt\b/.test(block) }).toEqual({
        model,
        hasUpdatedAt: false,
      });
      expect(block).toMatch(/^\s+createdAt\s+DateTime/m);
    }
  });

  it('F. no numbering, no RMA, no correction link anywhere in the three models (contract §6 refusals)', () => {
    const whole = ['ReturnDocument', 'ReturnLine', 'ReturnLifecycleTransition']
      .map((model) => schemaBlock('model', model))
      .join('\n');
    for (const forbidden of ['documentNumber', 'reversesReturnLineId', 'counter', 'rmaNumber']) {
      expect({ forbidden, present: whole.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});
