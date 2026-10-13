import { jalaliMonthLength, jalaliToGregorian } from '../../calendar/jalali.util';
import type { LeaveLimitPeriodKind } from './domain/leave-policy';

/**
 * Phase 54-D (§16.2, D7, D12): a limit's PERIOD is resolved into an explicit inclusive window —
 * HERE, at configuration time, and never at evaluation time.
 *
 * WHY THIS FILE IS NOT IN `domain/`
 * ---------------------------------
 * It imports `calendar/jalali.util`, and `hr-application-boundaries.spec.ts` rule 3 asserts that
 * every file under `domain/` has ZERO import specifiers. That rule is not an obstacle to work
 * around: it is the reason `domain/leave-policy.ts` states the VOCABULARY and this file does the
 * ARITHMETIC. Stating a period kind is a rule; converting a Jalali year into two Gregorian days
 * is a computation that depends on another module, so it belongs one tier out, beside
 * `hr-actor.ts` and `hr-audit.gateway.ts`.
 *
 * WHY THE RESOLUTION IS SEPARATED FROM THE ENGINE
 * ----------------------------------------------
 * The engine is forbidden from reading a clock and from performing calendar arithmetic (§34.3,
 * D12): it answers "given this window and these facts, what is decided", and it cannot answer
 * "when does the tenant's year start". That is a Jalali question, and this repository already
 * owns ONE answer to it — the same `calendar/jalali.util` the attendance and leave surfaces use.
 *
 * SO THE WINDOW IS RESOLVED ONCE AND STORED. Two inclusive calendar days are written onto the
 * policy version when it is authored, and the engine compares stored days forever after:
 *
 *   * a policy authored for 1404 keeps counting the 1404 window in 1405 unless a NEW version is
 *     published — which is what "effective dating is configuration, not evaluation time" means
 *     (§11), and it is why a historical explanation never re-derives a window from a calendar
 *     that may since have been corrected;
 *   * the engine's window is inspectable data, so "why did this refuse?" is answerable from the
 *     stored version rather than from an arithmetic routine.
 *
 * WHY ESFAND'S LENGTH IS DERIVED RATHER THAN ASSUMED
 * -------------------------------------------------
 * `jalaliMonthLength` derives leapness by round-tripping 12/30 through both conversions, so
 * there is no second leap rule here to disagree with it. Assuming Esfand is always 30 days would
 * put `windowEnd` one day past the year in a common year — a window that silently counts the
 * following Nowruz, which is exactly the kind of off-by-one a leave limit must not have.
 *
 * WHAT THIS FILE DOES NOT DO. It does not count days, does not know a working day from a
 * holiday, and does not consult `CalendarOccasion`. `DAY_COUNT` is inclusive CALENDAR days,
 * computed by the evaluator from stored request ranges (§16.3); which of those days were WORKED
 * is a different question this phase is not authorized to answer.
 */

/** An inclusive window of calendar days, `YYYY-MM-DD` — the shape the engine compares as text. */
export interface LeaveLimitWindow {
  /** Inclusive first day. */
  readonly start: string;
  /** Inclusive last day. */
  readonly end: string;
}

/**
 * The window a Jalali year spans, as two inclusive Gregorian calendar days.
 *
 * The year runs 1/1 to 12/(29|30). Both ends are formatted `YYYY-MM-DD` with zero padding, which
 * is the same shape `LeaveRequest.startDate` is stored in, so the engine's comparison is a
 * string comparison and needs no parsing.
 */
export function resolveLeaveLimitYearWindow(jalaliYear: number): LeaveLimitWindow {
  const start = jalaliToGregorian(jalaliYear, 1, 1);
  const end = jalaliToGregorian(jalaliYear, 12, jalaliMonthLength(jalaliYear, 12));

  return {
    start: formatGregorianDay(start.gy, start.gm, start.gd),
    end: formatGregorianDay(end.gy, end.gm, end.gd),
  };
}

/**
 * The window for a declared period kind, resolved at **configuration** time.
 *
 * A `switch` with no `default` rather than a lookup table, so that adding a second
 * `LeaveLimitPeriodKind` becomes a COMPILE error here: the phase that adds `MONTH` must decide
 * what a month window means, rather than inheriting whatever a record lookup happened to return.
 */
export function resolveLeaveLimitWindow(
  period: LeaveLimitPeriodKind,
  jalaliYear: number
): LeaveLimitWindow {
  switch (period) {
    case 'YEAR':
      return resolveLeaveLimitYearWindow(jalaliYear);
  }
}

/** `YYYY-MM-DD`, zero-padded — the stored calendar-day format, spelled once. */
function formatGregorianDay(gy: number, gm: number, gd: number): string {
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}
