import {
  BOM_MANAGER_OPINION_LABELS,
  BOM_MANAGER_OPINIONS,
  BOM_STATUSES,
  BOM_TRANSITIONS,
  bomStatusAfter,
  canTransitionBomHeader,
  isBomHeaderEditable,
} from './bom-status';

/**
 * Phase PRODUCTION-BOM-HEADER: the BOM header's lifecycle, pinned as a GRAPH.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The status vocabulary is written down in four places that cannot import each other —
 * this module, `prisma/production/schema.prisma` (the enums), `bom.dto.ts` (the read
 * filter) and the routes. This suite is the executable form of the DESIGN: the legal
 * moves, the illegal ones, and the freeze point. A rule re-typed in the service is how
 * "DRAFT is editable" and "DRAFT may not be submitted twice" both end up true.
 *
 * WHAT IS DELIBERATELY NOT TESTED, AND WHY
 * ----------------------------------------
 * "A BOM must have items before it can be submitted" is NOT here, because it is not
 * implemented: the item aggregate does not exist in this phase and the status module
 * does not fake a `hasItems` flag. Its absence is a recorded scope decision, not an
 * omission — a placeholder predicate here would be the fake this phase refuses.
 */

describe('the BOM status vocabulary', () => {
  it('declares exactly the four states the schema enum declares', () => {
    // Pinned in order: DRAFT is where a document starts and the enum's own order is the
    // order the migration wrote. A fifth state would be a vocabulary change, not a
    // lifecycle change, and it must be visible here.
    expect(BOM_STATUSES).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);
  });

  it('declares exactly the three decision values the legacy control offered', () => {
    expect(BOM_MANAGER_OPINIONS).toEqual(['APPROVED', 'REJECTED', 'NEEDS_CORRECTION']);
    // The Persian labels are the wire's presentation of those three facts — the same
    // three the legacy `RadioButtons` offered.
    expect(BOM_MANAGER_OPINION_LABELS.APPROVED).toBe('تایید');
    expect(BOM_MANAGER_OPINION_LABELS.REJECTED).toBe('رد');
    expect(BOM_MANAGER_OPINION_LABELS.NEEDS_CORRECTION).toBe('نیاز به اصلاح');
    // Every declared opinion has a label: a missing one renders `undefined` on screen.
    for (const opinion of BOM_MANAGER_OPINIONS) {
      expect(typeof BOM_MANAGER_OPINION_LABELS[opinion]).toBe('string');
      expect(BOM_MANAGER_OPINION_LABELS[opinion].length).toBeGreaterThan(0);
    }
  });
});

describe('isBomHeaderEditable', () => {
  it('is true for a DRAFT and false for every state that has left it', () => {
    expect(isBomHeaderEditable('DRAFT')).toBe(true);
    // SUBMIT is the freeze point (M-5): the approver has been asked, so the requester
    // may no longer rewrite the document underneath the decision.
    expect(isBomHeaderEditable('SUBMITTED')).toBe(false);
    // APPROVED and REJECTED are terminal in this phase; nothing in the source re-opens a
    // decided BOM and no route accepts a status field.
    expect(isBomHeaderEditable('APPROVED')).toBe(false);
    expect(isBomHeaderEditable('REJECTED')).toBe(false);
  });

describe('canTransitionBomHeader', () => {
  it('permits exactly the declared moves', () => {
    expect(canTransitionBomHeader('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionBomHeader('SUBMITTED', 'APPROVED')).toBe(true);
    expect(canTransitionBomHeader('SUBMITTED', 'REJECTED')).toBe(true);
    // A correction returns the row to the EDITABLE state — the legacy approval task's
    // `نیاز به اصلاح` branch wrote `State = 0` on the same row.
    expect(canTransitionBomHeader('SUBMITTED', 'DRAFT')).toBe(true);
  });

  it('refuses every other move, including the plausible-looking ones', () => {
    // The whole graph, enumerated: a generalised rule ("any to any but one") would let a
    // future reader conclude that APPROVED → DRAFT is legal because nothing says no.
    const illegal: Array<[string, string]> = [
      ['DRAFT', 'DRAFT'],
      ['DRAFT', 'APPROVED'],
      ['DRAFT', 'REJECTED'],
      ['SUBMITTED', 'SUBMITTED'],
      ['APPROVED', 'DRAFT'],
      ['APPROVED', 'SUBMITTED'],
      ['APPROVED', 'APPROVED'],
      ['APPROVED', 'REJECTED'],
      ['REJECTED', 'DRAFT'],
      ['REJECTED', 'SUBMITTED'],
      ['REJECTED', 'APPROVED'],
      ['REJECTED', 'REJECTED'],
    ];

    for (const [from, to] of illegal) {
      expect({
        from,
        to,
        allowed: canTransitionBomHeader(from as never, to as never),
      }).toEqual({ from, to, allowed: false });
    }
  });
});

describe('bomStatusAfter', () => {
  it('maps each action onto the state it lands on, from the state it requires', () => {
    expect(bomStatusAfter('DRAFT', 'SUBMIT')).toBe('SUBMITTED');
    expect(bomStatusAfter('SUBMITTED', 'APPROVE')).toBe('APPROVED');
    expect(bomStatusAfter('SUBMITTED', 'REJECT')).toBe('REJECTED');
    expect(bomStatusAfter('SUBMITTED', 'REQUEST_CORRECTION')).toBe('DRAFT');
  });

  it('returns null — not an exception — when the current state refuses the action', () => {
    // Returning null keeps this a predicate: the SERVICE is where the refusal becomes a
    // 409 carrying the current status, so HTTP vocabulary stays out of a pure module.
    expect(bomStatusAfter('SUBMITTED', 'SUBMIT')).toBeNull();
    expect(bomStatusAfter('APPROVED', 'APPROVE')).toBeNull();
    expect(bomStatusAfter('REJECTED', 'REJECT')).toBeNull();
    expect(bomStatusAfter('DRAFT', 'APPROVE')).toBeNull();
    expect(bomStatusAfter('DRAFT', 'REQUEST_CORRECTION')).toBeNull();
  });

  it('agrees with the declared transition table, action for action', () => {
    // The two representations of the same rule cannot drift: BOM_TRANSITIONS is what the
    // routes read, bomStatusAfter is what they call.
    expect(bomStatusAfter(BOM_TRANSITIONS.SUBMIT, 'SUBMIT')).toBe('SUBMITTED');
    expect(bomStatusAfter(BOM_TRANSITIONS.APPROVE, 'APPROVE')).toBe('APPROVED');
    expect(bomStatusAfter(BOM_TRANSITIONS.REJECT, 'REJECT')).toBe('REJECTED');
    expect(bomStatusAfter(BOM_TRANSITIONS.REQUEST_CORRECTION, 'REQUEST_CORRECTION')).toBe('DRAFT');
  });
});


  it('covers every declared status, so a new state cannot be silently editable', () => {
    // Falsifiable: adding a fifth member to BOM_STATUSES without deciding its
    // editability fails here rather than defaulting to "editable" by accident.
    const editable = BOM_STATUSES.filter(isBomHeaderEditable);
    expect(editable).toEqual(['DRAFT']);
  });
});
