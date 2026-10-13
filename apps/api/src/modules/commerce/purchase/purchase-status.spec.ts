import {
  PURCHASE_COMPLETION_SOURCE_STATUSES,
  PURCHASE_COMPLETION_TARGET_STATUS,
  PURCHASE_DOCUMENT_EDITABLE_STATUSES,
  PURCHASE_DOCUMENT_KINDS,
  PURCHASE_DOCUMENT_STATUSES,
  PURCHASE_DOCUMENT_TRANSITIONS,
  PURCHASE_LINE_TYPES,
  canCompletePurchaseDocument,
  canTransitionPurchaseDocument,
  isPurchaseCompletionSourceStatus,
  isPurchaseDocumentEditable,
} from './purchase-status';
import type { PurchaseDocumentStatus } from './purchase-status';

/**
 * Phase C1 Step L (§5.2, §5.11, §8): the purchase vocabulary and the two questions the
 * service asks of it — "may this document still be changed?" and "may it move there?".
 *
 * WHY THESE ARE PINNED AS LITERALS RATHER THAN DERIVED FROM THE MODULE
 * -------------------------------------------------------------------
 * A test that asserts `PURCHASE_DOCUMENT_STATUSES` equals itself proves nothing. What
 * these specs state is the SPECIFICATION's list (§5.11's six statuses, §5.2's three line
 * types, §5.1's one kind), so a member added or removed in code alone fails here — which
 * is the only way a closed vocabulary stays closed, because the database enum, the
 * schema comment and the DTO's `@IsIn` are three other copies of the same list and none
 * of them imports this file.
 *
 * The matrix tests are EXHAUSTIVE over the six statuses (36 pairs) for the same reason:
 * a transition table is exactly the kind of artifact where "the edge somebody forgot to
 * delete" hides, and `canTransitionPurchaseDocument` is what the submit route asks before
 * it writes.
 */

describe('Phase C1 Step L — the purchase vocabulary', () => {
  it('declares exactly §5.11’s six statuses, in the section’s order', () => {
    expect(PURCHASE_DOCUMENT_STATUSES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'CLOSED',
    ]);
  });

  it('declares exactly one kind, because C1 mints no second counter series', () => {
    // Falsifiable: adding 'PURCHASE_ORDER' here without a numbering prefix (and without
    // the migration that adds the enum member) is the drift this pins.
    expect(PURCHASE_DOCUMENT_KINDS).toEqual(['PURCHASE_REQUEST']);
  });

  it('declares exactly §5.2’s three line types, and no EXPENSE', () => {
    expect(PURCHASE_LINE_TYPES).toEqual(['STANDARD', 'NON_STANDARD', 'SERVICE']);
    expect(PURCHASE_LINE_TYPES).not.toContain('EXPENSE');
  });

  it('states one editable status, and the guard agrees for EVERY member of the vocabulary', () => {
    expect(PURCHASE_DOCUMENT_EDITABLE_STATUSES).toEqual(['DRAFT']);

    // Non-vacuity: the guard is exercised over the whole vocabulary rather than once.
    const editable = PURCHASE_DOCUMENT_STATUSES.filter((status) =>
      isPurchaseDocumentEditable(status)
    );
    expect(editable).toEqual(['DRAFT']);
  });
});

describe('Phase C1 Step L — the commercial transition table', () => {
  it('is TOTAL over the vocabulary, so a new status cannot be silently unreachable', () => {
    // The `Record<PurchaseDocumentStatus, …>` type makes this a compile error; the
    // assertion is what keeps the compile-time claim honest at runtime as well.
    expect(Object.keys(PURCHASE_DOCUMENT_TRANSITIONS).sort()).toEqual(
      [...PURCHASE_DOCUMENT_STATUSES].sort()
    );
  });

  it('permits exactly §3-F’s three edges and refuses the other 33 pairs', () => {
    const legal = PURCHASE_DOCUMENT_STATUSES.flatMap((from) =>
      PURCHASE_DOCUMENT_STATUSES.filter((to) => canTransitionPurchaseDocument(from, to)).map(
        (to) => `${from}->${to}`
      )
    );

    // `DRAFT → SUBMITTED` is step L's, the two `SUBMITTED → …` edges are step P's
    // (§3-F) and are written ONLY by the commercial projection writer. Sorted, because
    // the assertion is about the SET of edges and flatMap order is an implementation
    // detail of the table's declaration.
    expect([...legal].sort()).toEqual(
      ['DRAFT->SUBMITTED', 'SUBMITTED->APPROVED', 'SUBMITTED->REJECTED'].sort()
    );
  });

  it('refuses EVERY route to CLOSED in the STATIC table — completion is policy-driven, not an edge', () => {
    // PHASE C4-R kept this assertion deliberately. Completion (C1 §29) is not an
    // unconditional edge the table may declare: it is permitted only when the tenant's
    // PUBLISHED completion policy names the document's status, so the static table still
    // has no `→ CLOSED` row and no projection reaches CLOSED through it. What changed is
    // where the answer lives — `canCompletePurchaseDocument` below, exercised next — so
    // the temptation this test always refused (adding `→ CLOSED` to a row "to finish the
    // lifecycle") is still refused here, and would silently claim a purchase had run its
    // course without a policy ever being consulted.
    const toClosed = PURCHASE_DOCUMENT_STATUSES.filter((from) =>
      canTransitionPurchaseDocument(from, 'CLOSED')
    );
    expect(toClosed).toEqual([]);
  });

  it('refuses a status moving to itself, which is what makes submit idempotent-hostile', () => {
    for (const status of PURCHASE_DOCUMENT_STATUSES) {
      expect({ status, allowed: canTransitionPurchaseDocument(status, status) }).toEqual({
        status,
        allowed: false,
      });
    }
  });

  it('is frozen, so a caller cannot widen the lifecycle at runtime', () => {
    // `Object.freeze` is the difference between a table and a variable: an accidental
    // `PURCHASE_DOCUMENT_TRANSITIONS.DRAFT.push('CLOSED')` must throw rather than quietly
    // make §29's completion reachable from a route that does not implement it.
    const transitions: Record<PurchaseDocumentStatus, readonly PurchaseDocumentStatus[]> =
      PURCHASE_DOCUMENT_TRANSITIONS;

    expect(Object.isFrozen(PURCHASE_DOCUMENT_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(transitions.DRAFT)).toBe(true);
  });
});

/**
 * PHASE C4-R (GAP-3): the completion vocabulary — the configuration dimension D1 was
 * blocked on, stated as data rather than as a decision this module made.
 */
describe('Phase C4-R GAP-3 — the completion vocabulary and its evaluator', () => {
  it('completes into §5.11’s own CLOSED member, which no policy may move', () => {
    expect(PURCHASE_COMPLETION_TARGET_STATUS).toBe('CLOSED');
    expect(PURCHASE_DOCUMENT_STATUSES).toContain(PURCHASE_COMPLETION_TARGET_STATUS);
  });

  it('offers every status EXCEPT the destination as a policy candidate — and no others', () => {
    // Structural, not business: a document already completed cannot be completed twice
    // (the static table refuses every self-transition), so `CLOSED` is the one member no
    // policy can name. WHICH of the five a tenant allows is the configuration's own
    // answer, which is precisely why this tuple does not pick one.
    expect([...PURCHASE_COMPLETION_SOURCE_STATUSES]).toEqual([
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ]);
    expect(PURCHASE_COMPLETION_SOURCE_STATUSES).toHaveLength(
      PURCHASE_DOCUMENT_STATUSES.length - 1
    );
  });

  it('guards the allowlist from both ends — every member accepted, CLOSED and foreign states refused', () => {
    for (const status of PURCHASE_COMPLETION_SOURCE_STATUSES) {
      expect({ status, allowed: isPurchaseCompletionSourceStatus(status) }).toEqual({
        status,
        allowed: true,
      });
    }
    for (const status of ['CLOSED', 'PAID', 'FULLY_RECEIVED', 'PENDING', '', 'approved']) {
      expect({ status, allowed: isPurchaseCompletionSourceStatus(status) }).toEqual({
        status,
        allowed: false,
      });
    }
  });

  it('permits completion only when BOTH the status is a legal source AND the policy names it', () => {
    const cases: readonly {
      from: PurchaseDocumentStatus;
      allowed: readonly string[];
      expected: boolean;
      why: string;
    }[] = [
      { from: 'APPROVED', allowed: ['APPROVED'], expected: true, why: 'the configured source' },
      { from: 'REJECTED', allowed: ['APPROVED'], expected: false, why: 'not named by the policy' },
      { from: 'APPROVED', allowed: ['REJECTED'], expected: false, why: 'another set' },
      { from: 'DRAFT', allowed: [], expected: false, why: 'an empty policy names nothing' },
      {
        from: 'CLOSED',
        allowed: ['CLOSED', 'APPROVED'],
        expected: false,
        why: 'CLOSED can never be a source, even in a malformed stored set',
      },
      {
        from: 'SUBMITTED',
        allowed: ['PAID'],
        expected: false,
        why: 'a foreign lifecycle state never matches a document status',
      },
      {
        from: 'CANCELLED',
        allowed: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'],
        expected: true,
        why: 'the whole allowlist, as a product that allows completion from anywhere would set it',
      },
    ];

    for (const { from, allowed, expected, why } of cases) {
      expect({ from, allowed, expected, why, actual: canCompletePurchaseDocument(from, allowed) }).toEqual({
        from,
        allowed,
        expected,
        why,
        actual: expected,
      });
    }
  });

  it('is exhaustive over the vocabulary × the five singleton policies — no pair goes unasked', () => {
    const pairs = PURCHASE_DOCUMENT_STATUSES.flatMap((from) =>
      PURCHASE_COMPLETION_SOURCE_STATUSES.map((source) => ({
        pair: `${from}->${source}`,
        allowed: canCompletePurchaseDocument(from, [source]),
      }))
    );

    // Exactly the pairs whose status EQUALS the singleton's source — and never `CLOSED`,
    // because `canCompletePurchaseDocument` refuses it before it reads the set.
    const permitted = pairs.filter(({ allowed }) => allowed).map(({ pair }) => pair);
    expect(permitted.sort()).toEqual(
      PURCHASE_COMPLETION_SOURCE_STATUSES.map((source) => `${source}->${source}`).sort()
    );
  });
});
