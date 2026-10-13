/**
 * Phase 55: the Mission REQUEST lifecycle.
 *
 * WHY THIS FILE HAS NO IMPORTS
 * ----------------------------
 * A request's next state is decided by two strings. Keeping that rule in a
 * file with zero dependencies makes it testable without Nest, Prisma, a
 * database, or a request, and `hr-application-boundaries.spec.ts` asserts the
 * absence of imports mechanically.
 *
 * WHY SEVEN MEMBERS, NOT EIGHT
 * ----------------------------
 * `MissionRequestStatus` declares the states the schema stores. There is no
 * `COMPLETED` member because completion is not a separate request state: a
 * mission is approved, rejected, or cancelled, and any post-approval report is
 * its own table (`MissionReport`).
 */

export type MissionRequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_APPROVAL'
  | 'CORRECTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

/** The wire vocabulary, in schema order. */
export const MISSION_REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_APPROVAL',
  'CORRECTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

/** Every create begins in DRAFT. Never accepted from a caller. */
export const MISSION_REQUEST_INITIAL_STATUS: MissionRequestStatus = 'DRAFT';

/**
 * The transition table. Terminal states are present with empty lists so that
 * "no way out" is a deliberate statement rather than an omission.
 */
export const MISSION_REQUEST_STATUS_TRANSITIONS: Readonly<
  Record<MissionRequestStatus, readonly MissionRequestStatus[]>
> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['IN_APPROVAL', 'CANCELLED'],
  IN_APPROVAL: ['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'CANCELLED'],
  CORRECTION_REQUIRED: ['SUBMITTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** True when `value` is one of the seven members. */
export function isMissionRequestStatus(value: unknown): value is MissionRequestStatus {
  return (
    typeof value === 'string' && (MISSION_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** True when `from` may become `to`. A no-op (`from === to`) is refused. */
export function canTransitionMissionRequest(
  from: MissionRequestStatus,
  to: MissionRequestStatus
): boolean {
  return MISSION_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

/** True when a state has no outgoing transition. */
export function isTerminalMissionRequestStatus(status: MissionRequestStatus): boolean {
  return MISSION_REQUEST_STATUS_TRANSITIONS[status].length === 0;
}

/** True when the request's content may still be restated (not terminal). */
export function isMissionRequestRestatable(status: MissionRequestStatus): boolean {
  return !isTerminalMissionRequestStatus(status);
}
