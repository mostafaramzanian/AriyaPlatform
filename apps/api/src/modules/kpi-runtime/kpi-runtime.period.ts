import {
  APP_TIME_ZONE,
  JALALI_MONTHS,
  MAX_JALALI_YEAR,
  MIN_JALALI_YEAR,
  instantToJalaliDate,
  jalaliWallTimeToInstant,
} from '../../calendar/jalali.util';
import type { KpiPeriod } from './kpi-runtime.contract';

/**
 * Phase KPI-RUNTIME — the ONE place a Jalali month becomes the half-open instant window a
 * KPI cohorts on.
 *
 * WHY A MONTH IS THE ONLY PERIOD THIS SURFACE ACCEPTS
 * --------------------------------------------------
 * All five approved definitions state the same sentence in their `timeSemantics.window`:
 * the cohort is "the Jalali calendar month of <field> in Asia/Tehran". A period-less read
 * would therefore not be a broader view of a governed KPI — it would be a DIFFERENT KPI,
 * one nobody defined. So `jy`/`jm` are the whole period vocabulary, and "everything since
 * the beginning of time" is not expressible rather than expressible-with-a-flag.
 *
 * WHY THE WINDOW IS HALF-OPEN `[start, end)`
 * ------------------------------------------
 * `start` is midnight of the 1st and `end` is midnight of the 1st of the NEXT month, both
 * resolved in `Asia/Tehran`. Half-open means a row decided exactly at the month's last
 * millisecond counts once — and a row decided at the next month's first instant does not
 * count twice, or at all. The catalog's own `jalaliDayRange` established this shape for the
 * calendar module, and reusing its conversion function keeps ONE implementation of the
 * Jalali ⇄ instant boundary rather than a second algorithm that could drift from it.
 *
 * THE OFFSET IS NEVER HARDCODED. `jalaliWallTimeToInstant` asks the platform tz database
 * for the offset at that instant, so this file never writes `3.5`, `210` or `+03:30` —
 * Iran abolished DST in 2022, which is a fact about today's tz database, not an invariant.
 */

/** The request's period fields — both optional; the service fills them from "now". */
export interface KpiPeriodInput {
  jy?: number;
  jm?: number;
}

/**
 * The current Jalali month, in `APP_TIME_ZONE`.
 *
 * Read from the clock ONCE per request by the service, so every KPI in one response shares
 * one "now" and a month rollover mid-request cannot split the list across two cohorts.
 */
export function currentJalaliMonth(now: Date = new Date()): { jy: number; jm: number } {
  const { jy, jm } = instantToJalaliDate(now, APP_TIME_ZONE);
  return { jy, jm };
}

/**
 * The bounds a period must fall in, echoed for a rejection the DTO can state precisely.
 */
export const KPI_PERIOD_BOUNDS = {
  minYear: MIN_JALALI_YEAR,
  maxYear: MAX_JALALI_YEAR,
  minMonth: 1,
  maxMonth: 12,
} as const;

/** True when `(jy, jm)` names a month the catalog's own date window admits. */
export function isValidKpiPeriod(jy: number, jm: number): boolean {
  if (!Number.isInteger(jy) || !Number.isInteger(jm)) return false;
  if (jy < KPI_PERIOD_BOUNDS.minYear || jy > KPI_PERIOD_BOUNDS.maxYear) return false;
  return jm >= KPI_PERIOD_BOUNDS.minMonth && jm <= KPI_PERIOD_BOUNDS.maxMonth;
}

/**
 * The half-open `[start, end)` instant window of one Jalali month.
 *
 * `end` is computed from the FIRST INSTANT OF THE NEXT MONTH rather than by adding a number
 * of days: months are 29/30/31 days and Esfand is 29 or 30 depending on leapness, so any
 * "+30 days" shortcut would be wrong twice a year — and wrong by a whole day's worth of
 * cohort rows, silently, in exactly the months a finance or production review cares about.
 */
export function kpiPeriodWindow(jy: number, jm: number): { start: Date; end: Date } {
  const startJy = jy;
  const startJm = jm;
  const start = jalaliWallTimeToInstant(startJy, startJm, 1, 0, 0, APP_TIME_ZONE);

  const nextJm = startJm === 12 ? 1 : startJm + 1;
  const nextJy = startJm === 12 ? startJy + 1 : startJy;
  const end = jalaliWallTimeToInstant(nextJy, nextJm, 1, 0, 0, APP_TIME_ZONE);

  return { start, end };
}

/**
 * The full period descriptor a result echoes back: the month it named AND the exact window
 * the seam filtered on, so a screen can state "آبان ۱۴۰۵ (از … تا …)" from ONE source
 * instead of re-deriving bounds from a label and drifting from the query that produced the
 * number.
 */
export function resolveKpiPeriod(input: KpiPeriodInput, now: Date = new Date()): KpiPeriod {
  const current = currentJalaliMonth(now);
  const jy = input.jy ?? current.jy;
  const jm = input.jm ?? current.jm;

  if (!isValidKpiPeriod(jy, jm)) {
    throw new Error(`Invalid KPI period: ${jy}-${jm}`);
  }

  const { start, end } = kpiPeriodWindow(jy, jm);

  return {
    jy,
    jm,
    monthName: JALALI_MONTHS[jm - 1],
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone: APP_TIME_ZONE,
    calendar: 'JALALI',
    // Phase KPI-HISTORICAL-INTELLIGENCE: a month is completed once its exclusive
    // end instant has passed. The current (partial) month resolves `false` so a
    // screen never compares it silently against a full month.
    completed: end.getTime() <= now.getTime(),
  };
}

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — resolve an already-known month to its exact
 * window, marking completion against `now`. The history path walks months itself,
 * so it needs this without re-deriving "current" per entry.
 */
export function resolveKnownKpiPeriod(jy: number, jm: number, now: Date = new Date()): KpiPeriod {
  return resolveKpiPeriod({ jy, jm }, now);
}
