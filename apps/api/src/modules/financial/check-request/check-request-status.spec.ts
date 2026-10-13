/**
 * Phase F1 — FINANCIAL FOUNDATION: the check-request lifecycle as an executable table.
 *
 * WHAT THIS SUITE PINS, AND WHY EACH ONE MATTERS
 * ----------------------------------------------
 *  1. THE CLOSED SET {0,1,2,3,4,5,6,7,8,50} — every stage the source proved, no member
 *     between 8 and 50, and nothing outside the set has a name (Phase CHECK-ISSUATION
 *     completed what F1 pinned as {0,1,2,3,50}).
 *  2. THE EDITABLE PREDICATE — {0,1}: correction lands on 1 (the source's `StateNext := 1`
 *     from the manager's «نیازمند اصلاح است»), and §7.4 says the requester re-owns the row
 *     there; a {0}-only predicate would strand every corrected request.
 *  3. THE TRANSITION TABLE — the ELEVEN source transitions with their exact landings, and
 *     `null` for every other pair; the executive's contested correction is ABSENT by
 *     design (brief §20, no guess).
 *  4. THE SOURCE VOCABULARIES — the manager's three words, the reviewer's two, the
 *     presidency's RESOLVED two, and the requester's two, with the source's Persian
 *     labels preserved verbatim (Preflight §8.2).
 *  5. THE TERMINAL PAIR {8, 50} — no action ever leaves either (E11: the task button is
 *     disabled at `cr_status >= 8`).
 */

import {
  CHECK_ISSUE_TYPES,
  CHECK_ISSUE_TYPE_LABELS,
  CHECK_PURCHASE_TYPES,
  CHECK_PURCHASE_TYPE_LABELS,
  CHECK_REQUEST_STATUS,
  CHECK_REQUEST_STATUSES,
  CHECK_REQUEST_TERMINAL_STATUSES,
  CHECK_REQUEST_TRANSITIONS,
  DOCUMENT_REVIEW_DECISION_LABELS,
  DOCUMENT_REVIEW_DECISIONS,
  EXECUTIVE_DECISION_LABELS,
  EXECUTIVE_DECISIONS,
  MANAGER_DECISION_LABELS,
  MANAGER_DECISIONS,
  REQUESTER_OPINION_LABELS,
  REQUESTER_OPINIONS,
  checkRequestStatusAfter,
  checkRequestStatusName,
  isCheckRequestEditable,
  isCheckRequestTerminal,
} from './check-request-status';

describe('Phase CHECK-ISSUATION — the check-request lifecycle', () => {
  describe('the closed status set', () => {
    it('is exactly {0,1,2,3,4,5,6,7,8,50} — every source stage plus the two terminals', () => {
      expect([...CHECK_REQUEST_STATUSES].sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 50,
      ]);
      expect(CHECK_REQUEST_STATUS.DRAFT).toBe(0);
      expect(CHECK_REQUEST_STATUS.SUBMITTED).toBe(1);
      expect(CHECK_REQUEST_STATUS.MANAGER_REVIEW).toBe(2);
      expect(CHECK_REQUEST_STATUS.APPROVED).toBe(3);
      expect(CHECK_REQUEST_STATUS.DOCUMENT_REVIEW).toBe(4);
      expect(CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL).toBe(5);
      expect(CHECK_REQUEST_STATUS.ISSUANCE).toBe(6);
      expect(CHECK_REQUEST_STATUS.DELIVERY).toBe(7);
      expect(CHECK_REQUEST_STATUS.COMPLETED).toBe(8);
      expect(CHECK_REQUEST_STATUS.TERMINATED).toBe(50);
    });

    it('has NO member outside the source stages — 9 and 100 are unknown and unnamed', () => {
      for (const outside of [9, 100, -1]) {
        expect(CHECK_REQUEST_STATUSES).not.toContain(outside);
        expect(checkRequestStatusName(outside)).toBe(`UNKNOWN(${outside})`);
      }
    });

    it('names every implemented status for logs and tests', () => {
      expect(checkRequestStatusName(0)).toBe('DRAFT');
      expect(checkRequestStatusName(1)).toBe('SUBMITTED');
      expect(checkRequestStatusName(2)).toBe('MANAGER_REVIEW');
      expect(checkRequestStatusName(3)).toBe('APPROVED');
      expect(checkRequestStatusName(4)).toBe('DOCUMENT_REVIEW');
      expect(checkRequestStatusName(5)).toBe('EXECUTIVE_APPROVAL');
      expect(checkRequestStatusName(6)).toBe('ISSUANCE');
      expect(checkRequestStatusName(7)).toBe('DELIVERY');
      expect(checkRequestStatusName(8)).toBe('COMPLETED');
      expect(checkRequestStatusName(50)).toBe('TERMINATED');
    });

    it('declares exactly TWO terminal states — 8 (button disabled ≥ 8) and 50', () => {
      expect([...CHECK_REQUEST_TERMINAL_STATUSES].sort((a, b) => a - b)).toEqual([8, 50]);
      expect(isCheckRequestTerminal(8)).toBe(true);
      expect(isCheckRequestTerminal(50)).toBe(true);
      for (const open of [0, 1, 2, 3, 4, 5, 6, 7]) {
        expect(isCheckRequestTerminal(open)).toBe(false);
      }
    });
  });

  describe('the editable predicate', () => {
    it('opens states 0 AND 1 — the requester re-owns a returned request (§7.4)', () => {
      expect(isCheckRequestEditable(0)).toBe(true);
      expect(isCheckRequestEditable(1)).toBe(true);
    });

    it('closes the manager-owned and terminal states', () => {
      expect(isCheckRequestEditable(2)).toBe(false);
      expect(isCheckRequestEditable(3)).toBe(false);
      expect(isCheckRequestEditable(50)).toBe(false);
      for (const deferred of [4, 5, 6, 7]) {
        expect(isCheckRequestEditable(deferred)).toBe(false);
      }
    });
  });

  describe('the transition table', () => {
    it('submits from DRAFT and from the returned state, landing in MANAGER_REVIEW', () => {
      expect(checkRequestStatusAfter(0, 'SUBMIT')).toBe(2);
      expect(checkRequestStatusAfter(1, 'SUBMIT')).toBe(2);
    });

    it('decides only from MANAGER_REVIEW: approve→3, reject→50, correction→1', () => {
      expect(checkRequestStatusAfter(2, 'APPROVE')).toBe(3);
      expect(checkRequestStatusAfter(2, 'REJECT')).toBe(50);
      expect(checkRequestStatusAfter(2, 'REQUEST_CORRECTION')).toBe(1);
    });

    it('refuses every other pair — no silent no-op, no skipping a stage', () => {
      const actions = [
        'SUBMIT',
        'APPROVE',
        'REJECT',
        'REQUEST_CORRECTION',
        'ALLOCATE',
        'DOCUMENT_REVIEW_APPROVE',
        'DOCUMENT_REVIEW_CORRECTION',
        'EXECUTIVE_APPROVE',
        'EXECUTIVE_REJECT',
        'ISSUE',
        'DELIVER',
      ] as const;
      // The full landing table — every source transition in ONE map, so a pair that is
      // NOT in this list must answer `null`, and a pair in it must land exactly here.
      const landing: Record<(typeof actions)[number], { from: number[]; to: number }> = {
        SUBMIT: { from: [0, 1], to: 2 },
        APPROVE: { from: [2], to: 3 },
        REJECT: { from: [2], to: 50 },
        REQUEST_CORRECTION: { from: [2], to: 1 },
        ALLOCATE: { from: [3], to: 4 },
        DOCUMENT_REVIEW_APPROVE: { from: [4], to: 5 },
        DOCUMENT_REVIEW_CORRECTION: { from: [4], to: 1 },
        EXECUTIVE_APPROVE: { from: [5], to: 6 },
        EXECUTIVE_REJECT: { from: [5], to: 50 },
        ISSUE: { from: [6], to: 7 },
        DELIVER: { from: [7], to: 8 },
      };
      for (const action of actions) {
        for (const status of [...CHECK_REQUEST_STATUSES]) {
          const legal = landing[action].from.includes(status);
          expect({ action, status, result: checkRequestStatusAfter(status, action) }).toEqual({
            action,
            status,
            result: legal ? landing[action].to : null,
          });
        }
      }
    });

    it('leaves the terminal states terminal — no action ever leaves 8 or 50', () => {
      expect(checkRequestStatusAfter(50, 'APPROVE')).toBeNull();
      expect(checkRequestStatusAfter(8, 'DELIVER')).toBeNull();
      expect(checkRequestStatusAfter(8, 'SUBMIT')).toBeNull();
      expect(checkRequestStatusAfter(3, 'APPROVE')).toBeNull();
      expect(checkRequestStatusAfter(3, 'REQUEST_CORRECTION')).toBeNull();
    });

    it('has exactly the eleven declared actions — and NO executive-correction row', () => {
      expect(Object.keys(CHECK_REQUEST_TRANSITIONS).sort()).toEqual([
        'ALLOCATE',
        'APPROVE',
        'DELIVER',
        'DOCUMENT_REVIEW_APPROVE',
        'DOCUMENT_REVIEW_CORRECTION',
        'EXECUTIVE_APPROVE',
        'EXECUTIVE_REJECT',
        'ISSUE',
        'REJECT',
        'REQUEST_CORRECTION',
        'SUBMIT',
      ]);
      // The brief §20 "No guess" ruling, executable: the source's contested
      // «نیازمند اصلاح» branch at state 5 has no key, no row and no landing —
      // a caller cannot express it, so it cannot become a guessed transition.
      expect('EXECUTIVE_REQUEST_CORRECTION' in CHECK_REQUEST_TRANSITIONS).toBe(false);
      expect([...EXECUTIVE_DECISIONS]).toEqual(['APPROVE', 'REJECT']);
    });
  });

  describe('the source vocabularies, preserved verbatim', () => {
    it('carries the manager decision values with the source Persian words', () => {
      expect([...MANAGER_DECISIONS]).toEqual(['APPROVE', 'REJECT', 'REQUEST_CORRECTION']);
      expect(MANAGER_DECISION_LABELS).toEqual({
        APPROVE: 'بله',
        REJECT: 'خیر',
        REQUEST_CORRECTION: 'نیازمند اصلاح است',
      });
    });

    it('carries the requester opinion values with the source Persian words', () => {
      expect([...REQUESTER_OPINIONS]).toEqual(['CONTINUE', 'CANCEL']);
      expect(REQUESTER_OPINION_LABELS).toEqual({
        CONTINUE: 'تایید و ادامه',
        CANCEL: 'لغو کامل گردش درخواست',
      });
    });

    it('carries the document-review decision values — the source\'s تایید;اصلاح, no reject', () => {
      expect([...DOCUMENT_REVIEW_DECISIONS]).toEqual(['APPROVE', 'CORRECTION']);
      expect(DOCUMENT_REVIEW_DECISION_LABELS).toEqual({ APPROVE: 'تایید', CORRECTION: 'اصلاح' });
    });

    it('carries the presidency decision values — and NOT its contested third value', () => {
      // The source's control offered `تایید;رد;نیازمند اصلاح`, but the third value is
      // DEFERRED / SOURCE-CONFLICT (script StateNext=6 vs display state 3 — brief §20).
      // The enum refusing to contain it is the executable form of "no guess".
      expect([...EXECUTIVE_DECISIONS]).toEqual(['APPROVE', 'REJECT']);
      expect(EXECUTIVE_DECISION_LABELS).toEqual({ APPROVE: 'تایید', REJECT: 'رد' });
      expect([...EXECUTIVE_DECISIONS]).not.toContain('REQUEST_CORRECTION' as never);
    });

    it('carries the issue types and purchase types with their source labels', () => {
      expect([...CHECK_ISSUE_TYPES]).toEqual(['PURCHASE', 'PETTY_CASH', 'SALARY']);
      expect(CHECK_ISSUE_TYPE_LABELS).toEqual({
        PURCHASE: 'خرید',
        PETTY_CASH: 'تنخواه',
        SALARY: 'حقوق',
      });
      expect([...CHECK_PURCHASE_TYPES]).toEqual(['PROJECT', 'NON_PROJECT']);
      expect(CHECK_PURCHASE_TYPE_LABELS).toEqual({
        PROJECT: 'پروژه ای',
        NON_PROJECT: 'غیر پروژه ای',
      });
    });
  });
});
