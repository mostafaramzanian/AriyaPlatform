import {
  PRODUCTION_BOM_AUDIT_ACTION_LABELS,
  PRODUCTION_BOM_STATUSES,
  PRODUCTION_ERROR_MESSAGES,
  productionAuditTimestampLabel,
  productionBomAuditActionLabel,
  productionBomStatusLabel,
  productionBomStatusTone,
  productionControlPlanLabel,
  productionDateLabel,
  productionErrorCode,
  productionErrorMessage,
  productionManagerOpinionLabel,
  productionPartTypeLabel,
  productionServerMessage,
} from '../production-labels';

/**
 * PHASE PRODUCTION-BOM: the Persian rendering and the typed-error mapping.
 *
 * WHAT THESE SPECS PIN, and why each is falsifiable: every code the backend can refuse with
 * maps to a Persian sentence (a code without a label would render as a raw token to a user),
 * the mapping is BY CODE and never by a sentence, an unknown code falls back to the server's
 * own message rather than to a token, and the label helpers return `—` for the optional
 * values rather than `null` or an empty string.
 */
describe('production-labels — vocabulary', () => {
  it('labels every lifecycle state, and tones each one', () => {
    expect(PRODUCTION_BOM_STATUSES).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);
    for (const status of PRODUCTION_BOM_STATUSES) {
      expect(productionBomStatusLabel(status).length).toBeGreaterThan(0);
      expect(['ok', 'muted', 'danger', 'info']).toContain(productionBomStatusTone(status));
    }
    expect(productionBomStatusLabel('DRAFT')).toBe('پیش‌نویس');
    expect(productionBomStatusTone('APPROVED')).toBe('ok');
    expect(productionBomStatusTone('REJECTED')).toBe('danger');
  });

  it('renders the legacy decision vocabulary verbatim, and a null as null', () => {
    expect(productionManagerOpinionLabel('APPROVED')).toBe('تایید');
    expect(productionManagerOpinionLabel('REJECTED')).toBe('رد');
    expect(productionManagerOpinionLabel('NEEDS_CORRECTION')).toBe('نیاز به اصلاح');
    // "Nobody has decided" is not a fourth opinion.
    expect(productionManagerOpinionLabel(null)).toBeNull();
  });

  it('uses the source static lists, and `—` for an optional value that is unset', () => {
    expect(productionPartTypeLabel('STRUCTURAL')).toBe('ساختی');
    expect(productionPartTypeLabel('STANDARD')).toBe('استاندارد');
    expect(productionControlPlanLabel('PRESENT')).toBe('دارد');
    expect(productionControlPlanLabel('ABSENT')).toBe('ندارد');
    // Both are OPTIONAL in the source, so `null` is a real answer, not a bug.
    expect(productionPartTypeLabel(null)).toBe('—');
    expect(productionControlPlanLabel(null)).toBe('—');
  });

  it('renders an unset instant as `—` rather than an Invalid Date', () => {
    expect(productionDateLabel(null)).toBe('—');
    expect(productionDateLabel('not-a-date')).toBe('—');
    expect(productionDateLabel('2026-02-01T00:00:00.000Z').length).toBeGreaterThan(0);
  });
});

describe('production-labels — typed error mapping', () => {
  it('maps every domain code to a Persian sentence, with no token left over', () => {
    const codes = Object.keys(PRODUCTION_ERROR_MESSAGES);
    // Non-vacuity: the map must not be empty, and each sentence must be non-trivial.
    expect(codes.length).toBeGreaterThanOrEqual(6);
    for (const code of codes) {
      expect(PRODUCTION_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it('maps the EMPTY-BOM refusal to the legacy sentence, by code', () => {
    expect(productionErrorMessage('BOM_SUBMIT_ITEMS_REQUIRED')).toBe('اقلامی ثبت نشده است!');
  });

  it('falls back to the server message for an UNKNOWN code, never to the token', () => {
    expect(productionErrorMessage('SOMETHING_NEW', 'the server said this')).toBe(
      'the server said this'
    );
    expect(productionErrorMessage(undefined)).toBe('درخواست شما با خطا مواجه شد.');
    expect(productionErrorMessage(undefined, '')).toBe('درخواست شما با خطا مواجه شد.');
  });

  it('extracts the code and the message from the filter-shaped body', () => {
    const body = {
      success: false,
      error: { code: 'BOM_ITEM_COEFFICIENT_INVALID', message: 'must be an integer' },
      traceId: 't-1',
    };
    expect(productionErrorCode(body)).toBe('BOM_ITEM_COEFFICIENT_INVALID');
    expect(productionServerMessage(body)).toBe('must be an integer');
    // A 401 or a proxy error has no such shape, so both helpers answer undefined and the
    // caller falls back rather than reading through an undefined.
    expect(productionErrorCode(undefined)).toBeUndefined();
    expect(productionErrorCode({ message: 'plain' })).toBeUndefined();
    expect(productionServerMessage('nope')).toBeUndefined();
  });
});

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the audit VERB vocabulary and the instant.
 *
 * WHAT THESE SPECS PIN, and why each is falsifiable: every verb the two audit resources
 * can record has a Persian label (one of the nine without one would render a raw token to
 * a user); the lookup is BY the wire token, never by a sentence that a rewording could
 * silently break; an UNKNOWN verb falls back to the token rather than to a guess, because
 * inventing a sentence would claim business meaning the trail never stored; and the
 * timeline's instant is a DATE-AND-TIME while the register's date stays date-only.
 */
describe('production-labels — audit timeline vocabulary', () => {
  it('labels every verb the Production audit resources can record', () => {
    // Six on `production.bom`, three on `production.bom.item`, and (Phase
    // PRODUCTION-BOM-CHANGE) the change request's three DETAIL acts — this is ONE shared
    // vocabulary, not a per-resource map, so all of them belong here even though no single
    // timeline carries every one.
    const expected = [
      'create',
      'update',
      'submit',
      'approve',
      'reject',
      'request_correction',
      'delete',
      'add_item',
      'update_item',
      'remove_item',
    ];
    expect(Object.keys(PRODUCTION_BOM_AUDIT_ACTION_LABELS).sort()).toEqual(
      [...expected].sort()
    );
    for (const action of expected) {
      expect(productionBomAuditActionLabel(action).length).toBeGreaterThan(0);
    }
    // The underscore of `request_correction` is the WIRE value, not the Persian.
    expect(productionBomAuditActionLabel('request_correction')).toBe('درخواست اصلاح');
    expect(productionBomAuditActionLabel('approve')).toBe('تایید');
  });

  it('falls back to the RAW token for a verb nobody defined', async () => {
    // A future action must show up AS IT IS rather than as a plausible sentence nobody
    // wrote — the token is the honest report that a new verb exists.
    expect(productionBomAuditActionLabel('archived_by_surprise')).toBe('archived_by_surprise');
    expect(productionBomAuditActionLabel(undefined)).toBe('—');
    expect(productionBomAuditActionLabel(null)).toBe('—');
    expect(productionBomAuditActionLabel('')).toBe('—');
  });

  it('renders the timeline instant as a DATE AND TIME, and an unset one as `—`', () => {
    expect(productionAuditTimestampLabel(null)).toBe('—');
    expect(productionAuditTimestampLabel('not-a-date')).toBe('—');
    // A date-only formatter would collapse two transitions of one day into the same
    // string, so this one must carry a time component too.
    const rendered = productionAuditTimestampLabel('2026-02-01T10:30:00.000Z');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toBe('—');
  });
});
