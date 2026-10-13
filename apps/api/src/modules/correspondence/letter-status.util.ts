/**
 * Phase 50: the correspondence state machines.
 *
 * TWO state machines govern a letter, and they are deliberately kept apart because
 * they answer different questions:
 *
 *  1. CANONICAL (`LetterStatus`) — DRAFT / READY_TO_SEND / SENT / CANCELLED. Owned by
 *     the sender's workflow. A sent letter's canonical status never changes for a
 *     recipient's benefit; there is no RECEIVED/VIEWED member, because a letter viewed
 *     by one recipient is not "viewed" for another.
 *  2. PER-SUBJECT (`LetterRecipientState`) — what THIS recipient has done with THIS
 *     letter: DELIVERED → VIEWED → READ → (ACTION_REQUIRED | REFERRED | ACTED).
 *
 * Both are PURE functions: no Prisma, no RequestContext, no I/O. The service calls
 * them inside its transaction guards, and the unit spec pins every legal and illegal
 * edge so an impossible transition cannot drift in unnoticed.
 */

import { LetterRecipientState, LetterStatus } from '../../generated/correspondence-client';

/** Legal canonical transitions. CANCELLED is terminal; SENT is terminal (archive is per-user). */
export const LETTER_STATUS_TRANSITIONS: Readonly<Record<LetterStatus, readonly LetterStatus[]>> = {
  DRAFT: ['READY_TO_SEND', 'SENT', 'CANCELLED', 'SCHEDULED'],
  READY_TO_SEND: ['SENT', 'SCHEDULED'],
  SCHEDULED: ['SENT', 'CANCELLED'],
  SENT: [],
  CANCELLED: [],
};

export function canTransitionLetterStatus(from: LetterStatus, to: LetterStatus): boolean {
  return LETTER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** True while the letter may still be edited by its sender. */
export function isLetterEditable(status: LetterStatus): boolean {
  return status === 'DRAFT' || status === 'READY_TO_SEND';
}

/** True while a status may still be changed (a cancelled draft is dead). */
export function isLetterStatusMutable(status: LetterStatus): boolean {
  return status === 'DRAFT' || status === 'READY_TO_SEND';
}

/** States the send operation may start from. */
export const SENDABLE_LETTER_STATUSES: readonly LetterStatus[] = ['DRAFT', 'READY_TO_SEND'];

export function isSendableLetterStatus(status: LetterStatus): boolean {
  return SENDABLE_LETTER_STATUSES.includes(status);
}

/**
 * Per-recipient state transitions. Progress on the reading axis is monotonic
 * (DELIVERED → VIEWED → READ) and idempotent backwards: marking VIEWED twice keeps
 * the first timestamp and is not an error. ACTED is terminal for the subject.
 */
export function canRecipientView(state: LetterRecipientState): boolean {
  return state === 'DELIVERED';
}

export function canRecipientRead(state: LetterRecipientState): boolean {
  return state === 'DELIVERED' || state === 'VIEWED';
}

export function canRecipientBeReferred(state: LetterRecipientState): boolean {
  return state !== 'ACTED';
}

/** Referral target statuses: PENDING → VIEWED → ACTED, monotonic. */
export function canReferralBeViewed(status: 'PENDING' | 'VIEWED' | 'ACTED'): boolean {
  return status === 'PENDING';
}

export function canReferralBeActed(status: 'PENDING' | 'VIEWED' | 'ACTED'): boolean {
  return status !== 'ACTED';
}

/** Referral levels that demand action from the target (vs. information only). */
export const ACTION_REFERRAL_LEVELS: ReadonlySet<string> = new Set([
  'REVIEW',
  'DECIDE',
  'EXECUTE',
  'FINAL_APPROVE',
]);

export function isActionReferralLevel(level: string): boolean {
  return ACTION_REFERRAL_LEVELS.has(level);
}
