/**
 * Phase KPI-RUNTIME — the STRUCTURAL FORMULA EVALUATOR: the only place a governed `KpiFormula`
 * becomes arithmetic.
 *
 * WHY A GENERIC EVALUATOR AND NOT FIVE HAND-WRITTEN FUNCTIONS
 * -----------------------------------------------------------
 * The governance layer states formulas as a CLOSED UNION of two shapes (`MEAN_ELAPSED`,
 * `RATIO_PERCENT`) precisely so a runtime "may translate" them rather than re-authoring them
 * (`kpi-definition.model.ts`: "no expression string, no eval, no SQL"). Five hand-written
 * functions would put five independent readings of that union in the tree — each one able to
 * drift from the catalog silently. This file has exactly one reading of each shape, so the
 * only thing a new KPI can change is its DATA, not a second copy of its formula.
 *
 * WHAT THIS FILE REFUSES, ON PURPOSE
 * ----------------------------------
 *  * an unknown formula kind, a `{ dimension: 'source' }` selector (no served KPI has a
 *    source dimension, and `byStatus` cannot answer one) and a `to` field that is not a row
 *    field (`'EVALUATION_INSTANT'`, the snapshot-metric marker) all THROW rather than
 *    produce a plausible number. Every one of those is a defect in the CALLER's wiring, not a
 *    data condition, and a 500 naming the defect beats a KPI that quietly means something
 *    else. The service pre-validates each served definition, so none is reachable today —
 *    which is exactly why the refusal can be unconditional here;
 *  * rounding. "Percent 0–100; no presentation rounding governed" and "the governed value is
 *    exact elapsed seconds" both say the GOVERNED number is unrounded. Formatting is the
 *    screen's job and never happens between the database and `value`.
 */

import type { KpiCountSelector } from '../../kpi/kpi-definition.model';

/**
 * A seam row as the evaluator sees it.
 *
 * Typed `object` rather than `Record<string, unknown>` deliberately: the four seam rows are
 * INTERFACES, and TypeScript refuses an interface for an index-signature target even when
 * every property it has is a value. `object` is what every one of them satisfies, and the
 * single property read happens in ONE place (`readField`) with one documented cast — so the
 * cast is an implementation detail of the boundary rather than a cast per call site.
 */
export type KpiRow = object;

/**
 * Reads one property off a row. The ONE cast in this file, and the reason `KpiRow` is
 * `object`: see the type's comment.
 */
function readField(row: KpiRow, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

/**
 * The POPULATION of a mean, stated structurally in the same spirit as `KpiCountSelector`.
 *
 * `KpiMeanElapsedFormula` carries the row VALIDITY rules (`validRowRule`, `orderingRule`) but
 * deliberately carries no membership selector — the definition states its population in the
 * `population` / `exclusions` prose instead. Transcribing that prose once, as data, next to
 * the seam plan, is unavoidable; what makes it safe is that it is transcribed ONCE, applied
 * by this shared function, and pinned back to the catalog by `kpi-runtime.service.spec.ts`
 * (every status it names must appear in the catalog's own `population` + `exclusions` text,
 * and must be a member of the domain's closed vocabulary). The alternative — filtering
 * inside each KPI's handler — would be five transcriptions that could disagree.
 */
export interface KpiPopulation {
  /** Lifecycle members that count. Absent = every row in the window counts. */
  statuses?: readonly string[];
  /** Fields that must be non-null before a row is even a candidate. Absent = none. */
  nonNullFields?: readonly string[];
}

/**
 * The seam's SUMMARY read — one bounded `groupBy`, zero-filled over the closed lifecycle by
 * the reader. This is the input `RATIO_PERCENT` needs, which is why ratios never load rows:
 * a denominator is a COUNT, and reading 10 000 rows to count them would be the exact
 * inefficiency the seam's `groupBy` exists to avoid.
 */
export interface KpiStatusCounts {
  total: number;
  byStatus: Record<string, number>;
}

export interface KpiMeanElapsedOutcome {
  /** Rows handed to the evaluator, AFTER the population filter. */
  cohortRows: number;
  validRows: number;
  /** Rows dropped by `validRowRule` / `orderingRule` — excluded, never zero-filled. */
  excludedRows: number;
  /** Arithmetic mean of the valid pairs in exact elapsed SECONDS, or `null` when none. */
  meanSeconds: number | null;
}

export interface KpiRatioPercentOutcome {
  numerator: number;
  denominator: number;
  /** `0–100`, unrounded; `null` when the denominator is zero (`zeroDenominator`). */
  percent: number | null;
}

/** Applies the structural population: membership first, then required non-null fields. */
export function applyPopulation(population: KpiPopulation, rows: readonly KpiRow[]): KpiRow[] {
  return rows.filter((row) => {
    if (population.statuses && !population.statuses.includes(String(readField(row, 'status')))) {
      return false;
    }
    for (const field of population.nonNullFields ?? []) {
      const value = readField(row, field);
      if (value === null || value === undefined) return false;
    }
    return true;
  });
}

/**
 * Reads one instant field off a row.
 *
 * `null`/`undefined` is the governed "absent" the `validRowRule` excludes. A value that is
 * present but NOT a parseable instant is a different thing entirely — a corrupt projection —
 * and is refused rather than quietly demoted to "absent", because "half the cohort lost its
 * timestamps" and "half the cohort was never decided" are two different facts that must not
 * produce the same number.
 */
function readInstant(row: KpiRow, field: string): Date | null {
  const raw = readField(row, field);
  if (raw === null || raw === undefined) return null;

  const parsed = raw instanceof Date ? raw : new Date(raw as string | number);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`KPI row field "${field}" is not a parseable instant.`);
  }
  return parsed;
}

/**
 * The two fields a `MEAN_ELAPSED` formula names, stated structurally.
 *
 * Declared as `string` rather than `KpiRowField<Row>` so the function can be called with any
 * of the four seam row types at once — the CATALOG already proved each field exists on its
 * row at compile time through `satisfies`, and re-proving it here would just restate a fact
 * the compiler has already accepted.
 */
export interface MeanElapsedShape {
  readonly from: string;
  readonly to: string;
}

/**
 * The arithmetic mean of per-row elapsed seconds between `from` and `to`.
 *
 * BOTH EXCLUSION RULES ARE APPLIED, and in the order the catalog states them:
 *   1. `validRowRule: BOTH_TIMESTAMP_FIELDS_NON_NULL` — a row missing either instant never
 *      reaches the sum;
 *   2. `orderingRule: TO_NOT_BEFORE_FROM` — a row whose `to` precedes its `from` is STALE
 *      (the resubmission case KPI-001 and KPI-005 both document), and is excluded rather
 *      than floored at zero. Flooring would turn a data anomaly into a confident `0s` that
 *      drags the mean down and reads as "fast", which is the opposite of what it means.
 *
 * An EMPTY population yields `meanSeconds: null`, never `0` — there is no such thing as a
 * zero-second average of nothing.
 */
export function evaluateMeanElapsed(
  formula: MeanElapsedShape,
  population: KpiPopulation,
  rows: readonly KpiRow[]
): KpiMeanElapsedOutcome {
  const cohort = applyPopulation(population, rows);

  let totalMs = 0;
  let validRows = 0;

  for (const row of cohort) {
    const from = readInstant(row, formula.from);
    const to = readInstant(row, formula.to);

    if (from === null || to === null) continue;
    if (to.getTime() < from.getTime()) continue;

    totalMs += to.getTime() - from.getTime();
    validRows += 1;
  }

  return {
    cohortRows: cohort.length,
    validRows,
    excludedRows: cohort.length - validRows,
    meanSeconds: validRows === 0 ? null : totalMs / validRows / 1000,
  };
}

/**
 * `numerator / denominator × 100` over the seam's bounded `groupBy`.
 *
 * A `{ all: true }` denominator is the summary's `total` — which is itself the sum of the
 * zero-filled counts, so it and the per-status sum cannot disagree about how many rows exist.
 *
 * THE ZERO CASE IS NOT ZERO PERCENT. `zeroDenominator: 'NOT_AVAILABLE'` is a governance rule,
 * not a formatting choice: "no decision existed this month" and "none of the decisions were
 * approvals" are opposite findings, and only the second one is a rate. So an empty
 * denominator yields `percent: null`, and the service turns that into
 * `availability: NOT_AVAILABLE`.
 */
export function evaluateRatioPercent(
  formula: { readonly numerator: KpiCountSelector; readonly denominator: KpiCountSelector },
  counts: KpiStatusCounts
): KpiRatioPercentOutcome {
  const countOf = (selector: KpiCountSelector): number => {
    if (selector.dimension !== 'status') {
      // No served KPI declares a `source` selector — and `byStatus` structurally cannot
      // answer one. Refusing keeps "this selector needs a different read" from becoming a
      // silent `0` that reads as a real count.
      throw new Error(
        `KPI count selector dimension "${selector.dimension}" cannot be answered from status counts.`
      );
    }
    // `in`-narrowing: after this branch the union leaves only the `oneOf` member, so the
    // line below is checked by the compiler rather than trusted.
    if ('all' in selector) return counts.total;

    return selector.oneOf.reduce<number>(
      (sum, status) => sum + (counts.byStatus[status] ?? 0),
      0
    );
  };

  const numerator = countOf(formula.numerator);
  const denominator = countOf(formula.denominator);

  return {
    numerator,
    denominator,
    percent: denominator === 0 ? null : (numerator / denominator) * 100,
  };
}

