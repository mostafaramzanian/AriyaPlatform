/**
 * Phase 55: Mission date/time validation.
 *
 * WHY NO IMPORTS
 * --------------
 * Date arithmetic is a rule. Keeping it dependency-free lets it be tested with
 * no database, no clock and no timezone configuration.
 *
 * DATE-ONLY SEMANTICS
 * -------------------
 * `startDate` and `endDate` are calendar days (`@db.Date`). Parsing them at
 * UTC midnight keeps the result independent of the caller's timezone.
 *
 * NO BUSINESS CALENDAR
 * --------------------
 * Working days, weekends, holidays and overtime are NOT computed here. Those
 * belong to policy/rate layers, not to the request shape.
 */

export type MissionDurationMode = 'HOURLY' | 'DAILY';

/** The two modes the schema stores. */
export const MISSION_DURATION_MODES = ['HOURLY', 'DAILY'] as const;

export type MissionDateTimeValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function parseIsoDate(iso: string): Date | null {
  if (!ISO_DATE_PATTERN.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timeToSeconds(raw: string): number | null {
  const match = TIME_PATTERN.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/** True when `value` is a supported duration mode. */
export function isMissionDurationMode(value: unknown): value is MissionDurationMode {
  return typeof value === 'string' && (MISSION_DURATION_MODES as readonly string[]).includes(value);
}

/**
 * Validate start/end for DAILY or HOURLY missions.
 *
 * DAILY: `startDate` and `endDate` are required and `startDate <= endDate`.
 * HOURLY: `startDate` and `endDate` must be the same day, `startTime` and
 * `endTime` are required, and `startTime < endTime` (no cross-midnight).
 */
export function validateMissionDateTime(input: {
  mode: MissionDurationMode;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
}): MissionDateTimeValidationResult {
  if (!isMissionDurationMode(input.mode)) {
    return { ok: false, reason: 'invalid-duration-mode' };
  }

  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);

  if (!start) {
    return { ok: false, reason: 'invalid-start-date' };
  }
  if (!end) {
    return { ok: false, reason: 'invalid-end-date' };
  }

  if (input.mode === 'DAILY') {
    if (start.getTime() > end.getTime()) {
      return { ok: false, reason: 'daily-start-after-end' };
    }
    return { ok: true };
  }

  // HOURLY
  if (start.getTime() !== end.getTime()) {
    return { ok: false, reason: 'hourly-start-end-same-day' };
  }

  if (input.startTime === undefined || input.endTime === undefined) {
    return { ok: false, reason: 'hourly-time-required' };
  }

  const startSeconds = timeToSeconds(input.startTime);
  const endSeconds = timeToSeconds(input.endTime);

  if (startSeconds === null) {
    return { ok: false, reason: 'invalid-start-time' };
  }
  if (endSeconds === null) {
    return { ok: false, reason: 'invalid-end-time' };
  }

  if (endSeconds <= startSeconds) {
    return { ok: false, reason: 'hourly-end-time-not-after-start' };
  }

  return { ok: true };
}
