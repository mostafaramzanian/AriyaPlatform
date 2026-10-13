/**
 * Phase KPI-RUNTIME — the DISPLAY projection: the ONE authorised conversion of a governed
 * value into the unit the catalog's `unit.presentation` names.
 *
 * WHY IT IS A CLOSED SET RATHER THAN A PARSE
 * ------------------------------------------
 * `unit.presentation` is governed PROSE, and the leading word of that prose is what says
 * which display unit the definition authorizes (`Hours (…)` / `Days (…)` / `Percent 0–100; …`).
 * This file reads exactly that one word against a THREE-member closed set. Anything it does
 * not recognise yields `null`, the screen falls back to the governed value in its semantic
 * unit, and nothing is invented — so a reworded presentation can degrade a label, but can
 * never silently change a number's meaning.
 *
 * IT NEVER MUTATES `value`. `value` stays the governed seconds/percent; `display` is an
 * additional, clearly separate projection. `changing presentation never changes the governed
 * value` (§7) is enforced structurally here rather than by convention: there is no code path
 * that writes back to `value`.
 */

import type { KpiDisplay, KpiDisplayUnitToken, KpiSemanticUnit } from './kpi-runtime.contract';

/** Persian symbol per token — a HINT the screen may use or replace with its own label. */
const UNIT_LABELS_FA: Record<KpiDisplayUnitToken, string> = {
  HOURS: 'ساعت',
  DAYS: 'روز',
  PERCENT: '٪',
};

/**
 * The display unit a presentation paragraph authorizes, or `null` when it names none of the
 * closed set.
 *
 * The comparison is on the LEADING WORD, case-sensitively against the catalog's own spelling,
 * so `Hours (display conversion only; …)` reads `HOURS` and a hypothetical `Percentile` would
 * NOT read `PERCENT`.
 */
export function displayUnitFromPresentation(presentation: string): KpiDisplayUnitToken | null {
  const lead = presentation.trimStart();

  if (lead.startsWith('Hours')) return 'HOURS';
  if (lead.startsWith('Days')) return 'DAYS';
  if (lead.startsWith('Percent')) return 'PERCENT';
  return null;
}

/**
 * The authorised display projection of a governed value, or `null` when no conversion is
 * authorised for this (semantic unit, presentation) pair.
 *
 * The pairs are explicit rather than computed, because the conversion is a DECLARED FACT of
 * the catalog — `Hours` applies to `SECONDS`, not to `PERCENT`. An unrecognised pair returning
 * `null` is the fail-safe half of the closed set above.
 */
export function toDisplay(
  value: number,
  semantic: KpiSemanticUnit,
  presentation: string
): KpiDisplay | null {
  const unitToken = displayUnitFromPresentation(presentation);
  if (unitToken === null) return null;

  const SECONDS_PER_HOUR = 3600;
  const SECONDS_PER_DAY = 86400;

  if (semantic === 'SECONDS' && unitToken === 'HOURS') {
    return { value: value / SECONDS_PER_HOUR, unitToken, unitLabelFa: UNIT_LABELS_FA[unitToken] };
  }
  if (semantic === 'SECONDS' && unitToken === 'DAYS') {
    return { value: value / SECONDS_PER_DAY, unitToken, unitLabelFa: UNIT_LABELS_FA[unitToken] };
  }
  if (semantic === 'PERCENT' && unitToken === 'PERCENT') {
    return { value, unitToken, unitLabelFa: UNIT_LABELS_FA[unitToken] };
  }

  // A display unit the semantic unit cannot support (e.g. `Hours` beside `PERCENT`) is a
  // catalog contradiction, not a rounding question — refuse the projection rather than guess
  // a factor the definition never stated.
  return null;
}