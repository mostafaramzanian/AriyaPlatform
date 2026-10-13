/**
 * Phase F1 — FINANCIAL FOUNDATION: the title builder, the typed refusal codes and the
 * document-type list — the shared vocabulary `check-request.ts` owns.
 *
 * THE TITLE TESTS ARE THE F1 §10 RECORD, MADE EXECUTABLE
 * -----------------------------------------------------
 * Two of the source's three title shapes are reproduced EXACTLY
 * (`صدور چک برای حقوق`, `صدور چک برای {نوع} غیر پروژه ای`), and the third — the project
 * branch — is PARTIAL by decision: the source appended ` - {project name}`, and no
 * Project contract exists in Ariya, so the suffix is omitted rather than faked. The test
 * below asserts the partial shape ON PURPOSE, so the day a Project contract lands, the
 * expected string fails and this test is the checklist item that re-adds the suffix.
 */

import {
  CHECK_DOCUMENT_TYPE_LABELS,
  CHECK_DOCUMENT_TYPES,
  CHECK_REQUEST_AUDIT_ACTION,
  CHECK_REQUEST_ERROR_CODES,
  buildCheckRequestTitle,
} from './check-request';

describe('Phase F1 — the check-request shared vocabulary', () => {
  describe('buildCheckRequestTitle (server-generated; the client cannot state one)', () => {
    it('renders the salary title exactly as the source does', () => {
      expect(buildCheckRequestTitle('SALARY', null)).toBe('صدور چک برای حقوق');
    });

    it('renders the non-project shapes exactly as the source does', () => {
      expect(buildCheckRequestTitle('PURCHASE', 'NON_PROJECT')).toBe(
        'صدور چک برای خرید غیر پروژه ای'
      );
      expect(buildCheckRequestTitle('PETTY_CASH', 'NON_PROJECT')).toBe(
        'صدور چک برای تنخواه غیر پروژه ای'
      );
    });

    it('renders the project shape WITHOUT the source name suffix — the documented partial', () => {
      // Source: `صدور چک برای خرید پروژه ای - {project name}`. The name needs a Project
      // contract that does not exist (Preflight §18), so the suffix is omitted rather
      // than invented. If this expectation ever changes, the contract arrived.
      expect(buildCheckRequestTitle('PURCHASE', 'PROJECT')).toBe('صدور چک برای خرید پروژه ای');
      expect(buildCheckRequestTitle('PETTY_CASH', 'PROJECT')).toBe('صدور چک برای تنخواه پروژه ای');
    });

    it('states only what is known when a تنخواه has no purchase type yet', () => {
      expect(buildCheckRequestTitle('PETTY_CASH', null)).toBe('صدور چک برای تنخواه');
    });
  });

  describe('the document-type list', () => {
    it('is the source’s eleven values, in the source’s order, all labelled', () => {
      expect(CHECK_DOCUMENT_TYPES).toHaveLength(11);
      expect([...CHECK_DOCUMENT_TYPES].slice(0, 3)).toEqual([
        'DASTOOR_PARDAKHT',
        'PISH_FACTOR',
        'GOVAHI_EZAFAT',
      ]);
      expect(CHECK_DOCUMENT_TYPES[CHECK_DOCUMENT_TYPES.length - 1]).toBe('OTHER');
      for (const type of CHECK_DOCUMENT_TYPES) {
        expect(CHECK_DOCUMENT_TYPE_LABELS[type]).toBeTruthy();
      }
      // The source's own words for the first and last entries.
      expect(CHECK_DOCUMENT_TYPE_LABELS.DASTOOR_PARDAKHT).toBe('دستور پرداخت');
      expect(CHECK_DOCUMENT_TYPE_LABELS.OTHER).toBe('سایر');
    });

    it('has no duplicate label and no label the source did not state', () => {
      const labels = Object.values(CHECK_DOCUMENT_TYPE_LABELS);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels).toContain('ترجمه فاکتور انگلیسی');
      expect(labels).toContain('صورتجلسه کمیسیون معاملات');
    });
  });

  describe('the audit actions and refusal codes', () => {
    it('records the lifecycle acts plus the attachment acts, lowercase', () => {
      expect(Object.values(CHECK_REQUEST_AUDIT_ACTION).sort()).toEqual([
        'allocate',
        'approve',
        'attachment_delete',
        'attachment_update',
        'attachment_upload',
        'create',
        'deliver',
        'document_review',
        'document_review_correction',
        'executive_approve',
        'executive_reject',
        'issue',
        'reject',
        'request_correction',
        'submit',
        'update',
      ]);
    });

    it('names every refusal with a stable CHECK_REQUEST_* code and no duplicates', () => {
      const codes = Object.values(CHECK_REQUEST_ERROR_CODES);
      expect(codes.length).toBeGreaterThanOrEqual(15);
      for (const code of codes) {
        expect(code).toMatch(/^CHECK_REQUEST_[A-Z_]+$/);
      }
      expect(new Set(codes).size).toBe(codes.length);
      // The self-approval and state-conflict codes are the two the brief names; their
      // presence is what makes those refusals machine-readable on the wire.
      expect(codes).toContain('CHECK_REQUEST_SELF_APPROVAL');
      expect(codes).toContain('CHECK_REQUEST_STATE_CONFLICT');
    });
  });
});
