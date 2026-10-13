import {
  MISSION_REASON_MAX_LENGTH,
  validateMissionApprovalReason,
  validateMissionCorrectionReason,
  validateMissionRejectionReason,
} from './mission-reason';

describe('HR domain — mission reasons', () => {
  it('accepts a valid correction reason and trims it', () => {
    expect(validateMissionCorrectionReason('  corrected dates  ')).toEqual({
      ok: true,
      reason: 'corrected dates',
    });
  });

  it('rejects an empty correction reason', () => {
    expect(validateMissionCorrectionReason('')).toEqual({ ok: false, reason: 'reason-required' });
  });

  it('rejects a whitespace-only correction reason', () => {
    expect(validateMissionCorrectionReason('   ')).toEqual({
      ok: false,
      reason: 'reason-required',
    });
  });

  it('rejects a correction reason that is too long', () => {
    const tooLong = 'a'.repeat(MISSION_REASON_MAX_LENGTH + 1);
    expect(validateMissionCorrectionReason(tooLong)).toEqual({
      ok: false,
      reason: 'reason-too-long',
    });
  });

  it('accepts a valid rejection reason', () => {
    expect(validateMissionRejectionReason('missing documentation')).toEqual({
      ok: true,
      reason: 'missing documentation',
    });
  });

  it('rejects an empty rejection reason', () => {
    expect(validateMissionRejectionReason('')).toEqual({ ok: false, reason: 'reason-required' });
  });

  it('rejects a whitespace-only rejection reason', () => {
    expect(validateMissionRejectionReason('\t\n')).toEqual({
      ok: false,
      reason: 'reason-required',
    });
  });

  it('treats a missing approval reason as valid with no reason', () => {
    expect(validateMissionApprovalReason(undefined)).toEqual({ ok: true, reason: null });
  });

  it('treats an empty approval reason as valid with no reason', () => {
    expect(validateMissionApprovalReason('   ')).toEqual({ ok: true, reason: null });
  });

  it('accepts and trims a non-empty approval reason', () => {
    expect(validateMissionApprovalReason('  approved per policy  ')).toEqual({
      ok: true,
      reason: 'approved per policy',
    });
  });

  it('rejects an approval reason that is too long', () => {
    const tooLong = 'b'.repeat(MISSION_REASON_MAX_LENGTH + 1);
    expect(validateMissionApprovalReason(tooLong)).toEqual({
      ok: false,
      reason: 'reason-too-long',
    });
  });
});
