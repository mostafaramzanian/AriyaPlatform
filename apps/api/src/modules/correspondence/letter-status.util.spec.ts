import {
  canTransitionLetterStatus,
  isLetterEditable,
  isSendableLetterStatus,
  canRecipientView,
  canRecipientRead,
  canRecipientBeReferred,
  canReferralBeViewed,
  canReferralBeActed,
  isActionReferralLevel,
  LETTER_STATUS_TRANSITIONS,
} from './letter-status.util';

/**
 * Phase 50: the two state machines, pinned as PURE decisions. The service calls
 * these inside its transaction guards; a drift here is a security-relevant drift.
 */
describe('canonical letter status machine', () => {
  it('allows exactly the legal edges out of DRAFT', () => {
    expect(canTransitionLetterStatus('DRAFT', 'READY_TO_SEND')).toBe(true);
    expect(canTransitionLetterStatus('DRAFT', 'SENT')).toBe(true);
    expect(canTransitionLetterStatus('DRAFT', 'CANCELLED')).toBe(true);
  });

  it('allows only READY_TO_SEND → SENT', () => {
    expect(canTransitionLetterStatus('READY_TO_SEND', 'SENT')).toBe(true);
    expect(canTransitionLetterStatus('READY_TO_SEND', 'DRAFT')).toBe(false);
    expect(canTransitionLetterStatus('READY_TO_SEND', 'CANCELLED')).toBe(false);
  });

  it('treats SENT and CANCELLED as terminal', () => {
    expect(canTransitionLetterStatus('SENT', 'DRAFT')).toBe(false);
    expect(canTransitionLetterStatus('SENT', 'CANCELLED')).toBe(false);
    expect(canTransitionLetterStatus('CANCELLED', 'DRAFT')).toBe(false);
    expect(canTransitionLetterStatus('CANCELLED', 'SENT')).toBe(false);
  });

  it('is total: every status has a transition row', () => {
    expect(Object.keys(LETTER_STATUS_TRANSITIONS).sort()).toEqual(
      ['CANCELLED', 'DRAFT', 'READY_TO_SEND', 'SCHEDULED', 'SENT'].sort(),
    );
  });

  it('edits are possible only before send', () => {
    expect(isLetterEditable('DRAFT')).toBe(true);
    expect(isLetterEditable('READY_TO_SEND')).toBe(true);
    expect(isLetterEditable('SENT')).toBe(false);
    expect(isLetterEditable('CANCELLED')).toBe(false);
  });

  it('send starts only from DRAFT or READY_TO_SEND', () => {
    expect(isSendableLetterStatus('DRAFT')).toBe(true);
    expect(isSendableLetterStatus('READY_TO_SEND')).toBe(true);
    expect(isSendableLetterStatus('SENT')).toBe(false);
    expect(isSendableLetterStatus('CANCELLED')).toBe(false);
  });
});

describe('per-recipient state rules', () => {
  it('VIEWED is allowed only from DELIVERED', () => {
    expect(canRecipientView('DELIVERED')).toBe(true);
    expect(canRecipientView('VIEWED')).toBe(false);
    expect(canRecipientView('READ')).toBe(false);
    expect(canRecipientView('ACTED')).toBe(false);
  });

  it('READ is allowed from DELIVERED or VIEWED, never backwards', () => {
    expect(canRecipientRead('DELIVERED')).toBe(true);
    expect(canRecipientRead('VIEWED')).toBe(true);
    expect(canRecipientRead('READ')).toBe(false);
    expect(canRecipientRead('ACTED')).toBe(false);
  });

  it('referral targets may not be ACTED subjects', () => {
    expect(canRecipientBeReferred('DELIVERED')).toBe(true);
    expect(canRecipientBeReferred('ACTION_REQUIRED')).toBe(true);
    expect(canRecipientBeReferred('ACTED')).toBe(false);
  });
});

describe('referral status + levels', () => {
  it('a referral can be VIEWED only while PENDING', () => {
    expect(canReferralBeViewed('PENDING')).toBe(true);
    expect(canReferralBeViewed('VIEWED')).toBe(false);
    expect(canReferralBeViewed('ACTED')).toBe(false);
  });

  it('a referral can be ACTED unless already ACTED', () => {
    expect(canReferralBeActed('PENDING')).toBe(true);
    expect(canReferralBeActed('VIEWED')).toBe(true);
    expect(canReferralBeActed('ACTED')).toBe(false);
  });

  it('distinguishes action levels from information levels', () => {
    expect(isActionReferralLevel('REVIEW')).toBe(true);
    expect(isActionReferralLevel('DECIDE')).toBe(true);
    expect(isActionReferralLevel('EXECUTE')).toBe(true);
    expect(isActionReferralLevel('FINAL_APPROVE')).toBe(true);
    expect(isActionReferralLevel('NORMAL')).toBe(false);
    expect(isActionReferralLevel('INFORM')).toBe(false);
  });
});