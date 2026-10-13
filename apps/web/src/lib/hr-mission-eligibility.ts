import type { HrMissionRequestStatus } from './hr-mission-api';

/**
 * Phase 55 Step 8B: WHEN THE EMPLOYEE MAY ACT — and the exact backend rule each answer mirrors.
 *
 * WHY THIS FILE EXISTS AT ALL
 * --------------------------
 * The brief for this step is explicit that the frontend must NOT invent an eligibility matrix, and
 * equally that it must not offer a control whose call is a guaranteed refusal. Both risks are real,
 * so the answer is neither "duplicate the service" nor "guess": it is to name, for each predicate,
 * the ONE server check it mirrors — and to keep them in a file whose header can be read against the
 * service. A predicate with no provable server rule does not exist here.
 *
 * THE FOUR PROVABLE RULES, each read from `mission.service.ts`:
 *
 *   EDIT / UPDATE — `update()` refuses when `!isMissionRequestRestatable(status)`
 *     (`mission.service.ts:282`). Restatable is the exact inverse of terminality
 *     (`mission-status.ts:79`), and terminal means "no outgoing transition"
 *     (`mission-status.ts:74`), which the transition table fixes as APPROVED / REJECTED / CANCELLED.
 *     So EDITABLE is the complement of those three.
 *
 *   SUBMIT — `submit()` requires `status === 'DRAFT'` via `requireRequestForSubmission`
 *     (`mission.service.ts:381`, `:410`).
 *
 *   RESUBMIT — `resubmit()` requires `status === 'CORRECTION_REQUIRED'` through the same guard
 *     (`mission.service.ts:386`).
 *
 *   CANCEL — `cancel()` refuses when `isTerminalMissionRequestStatus(status)`
 *     (`mission.service.ts:358`). The same three terminal states, so the complement again.
 *
 * WHY EDIT AND CANCEL SHARE THE TERMINAL COMPLEMENT: the server derives both from the same
 * transition table, so expressing them separately would be two spellings of one rule — and two
 * places for it to drift. They are separate PREDICATES (they answer different questions and a
 * future phase may separate them) but they read one shared constant, so a change to terminality
 * moves both.
 *
 * WHAT IS DELIBERATELY ABSENT: nothing here computes an approver, a route, a step, self-approval
 * legality or decisionability. Those are the SERVER's answers, arrive on the approval read, and are
 * never reproduced on this side.
 */

/**
 * The three states with NO outgoing transition — `MISSION_REQUEST_STATUS_TRANSITIONS` filtered to
 * the empty lists. Spelled once, and read by both predicates below.
 */
const TERMINAL_STATUSES: readonly HrMissionRequestStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

/** True when the request's content may still be restated — mirrors `isMissionRequestRestatable`. */
export function canEditMission(status: HrMissionRequestStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/** True when the request may be withdrawn — mirrors the `cancel()` refusal's inverse. */
export function canCancelMission(status: HrMissionRequestStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/** True when the request may be sent — mirrors the `DRAFT` guard on `submit()`. */
export function canSubmitMission(status: HrMissionRequestStatus): boolean {
  return status === 'DRAFT';
}

/** True when a corrected request may be sent again — mirrors the guard on `resubmit()`. */
export function canResubmitMission(status: HrMissionRequestStatus): boolean {
  return status === 'CORRECTION_REQUIRED';
}

/**
 * True when a mission report may be filed — mirrors `submitReport()` (`mission.service.ts:583`),
 * which refuses anything that is not `APPROVED`.
 *
 * The report is INDEPENDENT of the approval flow: it is filed after the mission has been approved,
 * and there is no separate report lifecycle in the backend, so nothing here implies a report status,
 * a report history or a completion state.
 */
export function canSubmitMissionReport(status: HrMissionRequestStatus): boolean {
  return status === 'APPROVED';
}

/**
 * The correction reason a `CORRECTION_REQUIRED` request must display, or `null`.
 *
 * IT NEVER FABRICATES. A `null` column stays `null` — no fallback sentence, no reuse of
 * `rejectionReason`, and no reaching for `decisionReason` from the approval endpoint (which needs a
 * grant the employee does not hold). The screen states the absence only if the server states it too.
 *
 * The guard on `status` is a NARROWING, not a second rule: the reason column is written by the
 * correction flow, so a value on a request in any other state would be stale data this screen should
 * not present as current.
 */
export function correctionReasonFor(request: {
  status: HrMissionRequestStatus;
  correctionReason: string | null;
}): string | null {
  if (request.status !== 'CORRECTION_REQUIRED') return null;
  return request.correctionReason;
}

/**
 * The rejection reason a `REJECTED` request displays, or `null` — the mirror of the above, with the
 * same refusal to substitute one reason for the other.
 */
export function rejectionReasonFor(request: {
  status: HrMissionRequestStatus;
  rejectionReason: string | null;
}): string | null {
  if (request.status !== 'REJECTED') return null;
  return request.rejectionReason;
}
