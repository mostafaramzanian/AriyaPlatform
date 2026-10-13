import {
  PURCHASE_COMPLETION_SOURCE_STATUSES,
  PURCHASE_DOCUMENT_STATUSES,
} from '../purchase/purchase-status';
import {
  PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH,
  completionPolicyIssues,
  describeAllowedFromStatuses,
  readAllowedFromStatuses,
} from './purchase-completion-policy';

/**
 * PHASE C4-R (GAP-3): the completion policy's MEANING, as a pure rule.
 *
 * WHAT THESE SPECS EXIST FOR
 * --------------------------
 *  1. THE ONLY VALUES THAT COUNT ARE THE DOCUMENT'S OWN STATUSES. A foreign lifecycle's
 *     state (`PAID`, `FULLY_RECEIVED`, `APPROVED` from another vocabulary) or the
 *     destination itself (`CLOSED`) must never be a policy input — the allowlist is the
 *     whole safety of the model, and it is stated from both ends because a tuple check
 *     that only tries valid members proves nothing about what it refuses.
 *  2. A POLICY IS A NON-EMPTY SET. Empty (completes nothing) and duplicated (a set that is
 *     not one) are refused with a reason, never normalised into silence: publication must
 *     not be able to launder an incoherent row.
 *  3. THE CHECKLIST IS DETERMINISTIC AND TOTAL. It returns a LIST, not a throw, so a stored
 *     row written by any path is judged by the same function a test can exercise directly.
 *  4. NOTHING ELSE IS EVALUATED. There is no payment, receiving, workflow or return input
 *     anywhere in this file, and a member added to these rules would be the guessed
 *     prerequisite the C4 contract forbids.
 */

describe('Phase C4-R GAP-3 — the completion policy vocabulary', () => {
  it('offers exactly the document lifecycle minus its destination, in the vocabulary order', () => {
    // The join that matters: the allowlist is the six-member vocabulary minus `CLOSED`,
    // stated from BOTH artifacts — so a status added to the lifecycle without a decision
    // about completion, or a `CLOSED` smuggled into the allowlist, fails here.
    expect([...PURCHASE_COMPLETION_SOURCE_STATUSES]).toEqual(
      PURCHASE_DOCUMENT_STATUSES.filter((status) => status !== 'CLOSED')
    );
    expect(PURCHASE_COMPLETION_SOURCE_STATUSES).toHaveLength(5);
    expect(PURCHASE_COMPLETION_SOURCE_STATUSES).not.toContain('CLOSED');

    // The label bound is the `VARCHAR(64)` the row stores — one number, asked from both
    // sides by the service and the DTO rather than restated in each.
    expect(PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH).toBe(64);
  });

  it('accepts the whole allowlist as a policy, which is what makes D1 configurable', () => {
    expect(completionPolicyIssues([...PURCHASE_COMPLETION_SOURCE_STATUSES])).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — completionPolicyIssues (the publication checklist)', () => {
  it('accepts every non-empty subset of the five source statuses', () => {
    const single = [['DRAFT'], ['SUBMITTED'], ['APPROVED'], ['REJECTED'], ['CANCELLED']];
    for (const allowedFromStatuses of single) {
      expect({ allowedFromStatuses, issues: completionPolicyIssues(allowedFromStatuses) }).toEqual({
        allowedFromStatuses,
        issues: [],
      });
    }

    expect(completionPolicyIssues(['APPROVED', 'REJECTED'])).toEqual([]);
    expect(completionPolicyIssues(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'])).toEqual(
      []
    );
  });

  it('refuses a value that is not an array at all', () => {
    for (const value of [null, undefined, 'APPROVED', { statuses: ['APPROVED'] }, 7]) {
      expect(completionPolicyIssues(value)).toEqual([
        'allowedFromStatuses must be an array of purchase document statuses.',
      ]);
    }
  });

  it('refuses an empty set — a policy that could complete nothing is a contradiction', () => {
    expect(completionPolicyIssues([])).toEqual([
      'allowedFromStatuses names no status, so no purchase document could ever be completed under this policy.',
    ]);
  });

  it('refuses CLOSED, foreign lifecycle states and invented strings, by name', () => {
    // `CLOSED` is the destination, never a source; `PAID`/`FULLY_RECEIVED` belong to the
    // payment and receiving lifecycles, which C1 §29 keeps OUT of completion; `MANAGER`
    // is not even a status. Each is refused with the member in the reason, so a client
    // learns which value to remove.
    for (const member of ['CLOSED', 'PAID', 'FULLY_RECEIVED', 'MANAGER', 'approved']) {
      expect(completionPolicyIssues([member])).toEqual([
        `${member} is not a status a purchase document may be completed from.`,
      ]);
    }
  });

  it('refuses a duplicate member — the value claims to be a set and is not one', () => {
    expect(completionPolicyIssues(['APPROVED', 'APPROVED'])).toEqual([
      'APPROVED is stated more than once; allowedFromStatuses is a set.',
    ]);
  });

  it('reports every reason at once rather than the first', () => {
    expect(completionPolicyIssues(['APPROVED', 'CLOSED', 'APPROVED'])).toEqual([
      'CLOSED is not a status a purchase document may be completed from.',
      'APPROVED is stated more than once; allowedFromStatuses is a set.',
    ]);
  });
});

describe('Phase C4-R GAP-3 — readAllowedFromStatuses (the completion act’s only read)', () => {
  it('returns the set exactly as stored when it is a valid policy', () => {
    expect(readAllowedFromStatuses(['APPROVED', 'REJECTED'])).toEqual(['APPROVED', 'REJECTED']);
  });

  it('returns null for anything the checklist would refuse — fail closed, never guess', () => {
    for (const value of [[], ['CLOSED'], 'APPROVED', null, ['APPROVED', 'APPROVED']]) {
      expect({ value, allowed: readAllowedFromStatuses(value) }).toEqual({ value, allowed: null });
    }
  });

  it('never authorises a status outside the vocabulary, even from a malformed set', () => {
    // The evaluator's other half lives in `purchase-status.ts`; this pins the composition:
    // a set that named a foreign state survives `readAllowedFromStatuses` as `null`, so no
    // document status can ever match it.
    expect(readAllowedFromStatuses(['PAID'])).toBeNull();
  });

  it('describes the set with one spelling — the refusal message and the screen agree', () => {
    expect(describeAllowedFromStatuses(['APPROVED', 'REJECTED'])).toBe('APPROVED, REJECTED');
  });
});
