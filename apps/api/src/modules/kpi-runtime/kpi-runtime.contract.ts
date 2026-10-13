/**
 * Phase KPI-RUNTIME — the KPI RESULT contract: the ONE shape a KPI value crosses the seam in,
 * plus the frozen vocabulary a Persian screen renders from.
 *
 * WHY THIS LIVES IN `src/modules/kpi-runtime` AND NOT IN `src/kpi`
 * ----------------------------------------------------------------
 * `src/kpi` is PINNED TYPE-ONLY by `kpi-governance.spec.ts`: a non-spec file there may only
 * `import type` from the model and the four seam contracts — no NestJS, no decorator, no
 * provider, no clock, no repository. That is what makes the governance layer a declaration
 * rather than a program. The governance layer owns WHAT a KPI means; THIS context owns
 * COMPUTING one for a tenant and SERVING it. So the runtime sits beside `reporting`, reads
 * `src/kpi/kpi-catalog.ts` as the single source of truth, and never writes a formula itself.
 *
 * WHY THE SCREEN MUST NOT DECIDE ANYTHING
 * ---------------------------------------
 * Every code point below is a server answer; the Persian sentences are rendered from
 * `kpi-labels.ts` on the web side. `quality` and `interpretation` exist precisely so that
 * "GREEN" can never be read as "good performance": the performance judgement is a CLOSED,
 * uniform `NOT_ASSESSED`, because all five approved KPIs carry `target: NOT_DEFINED` and
 * `thresholds: NOT_DEFINED`. A screen that wanted a traffic light would have to invent one,
 * and there is nothing in the repository to invent it from.
 */

import type { KpiDataQualityClass } from '../../kpi/kpi-definition.model';
import type { KpiComparison } from './kpi-runtime.comparison';

/**
 * The ONLY lifecycle status this runtime serves.
 *
 * The catalog holds nine definitions: five `APPROVED`, the rest `DRAFT` / `EVIDENCE_REVIEW` /
 * `BLOCKED`. `DEPRECATED` must never be consumed (the governance rule), and the three
 * non-approved states carry open questions or a blocked reason — a number computed from them
 * would be a measurement nobody approved. The service refuses any definition outside this
 * tuple rather than trusting `KPI_CATALOG` to stay sorted, and a governance test re-derives
 * the same five from the catalog.
 */
export const KPI_SERVED_STATUSES = ['APPROVED'] as const;
export type KpiServedStatus = (typeof KPI_SERVED_STATUSES)[number];

/** Availability — the honest binary a period-scoped value needs. Never a number stand-in. */
export const KPI_AVAILABILITY = ['AVAILABLE', 'NOT_AVAILABLE'] as const;
export type KpiAvailability = (typeof KPI_AVAILABILITY)[number];

/**
 * WHY a value is absent. Frozen so a screen can never render "۰٪" for "nothing existed" —
 * the two mean opposite things, and the catalog rules the second `NOT_AVAILABLE` outright
 * (`zeroDenominator: 'NOT_AVAILABLE'`).
 */
export const KPI_UNAVAILABLE_REASONS = [
  /** The cohort window holds no row of this KPI's population at all. */
  'EMPTY_COHORT',
  /**
   * Rows exist in the window, but none belongs to the denominator population — e.g. a month
   * whose decisions were all returned for correction. Distinct from `EMPTY_COHORT` because
   * "nothing happened" and "nothing of THIS KIND happened" are different findings.
   */
  'EMPTY_DENOMINATOR',
  /** Rows exist, but every one failed the definition's valid-row / ordering rule. */
  'NO_VALID_ROWS',
  /** The cohort exceeded the bounded read ceiling — a PARTIAL mean is never published. */
  'COHORT_EXCEEDS_LIMIT',
] as const;
export type KpiUnavailableReason = (typeof KPI_UNAVAILABLE_REASONS)[number];

/**
 * DATA readiness — how much of the governed definition's evidence this period actually
 * reached. Translated 1:1 from the catalog's `dataQuality.classification`, because that
 * classification is a property of the DEFINITION, not of a tenant's data: inventing a
 * per-period substitute would let two periods disagree about the same definition.
 */
export const KPI_DATA_READINESS = ['READY', 'PARTIAL', 'NOT_ASSESSED'] as const;
export type KpiDataReadiness = (typeof KPI_DATA_READINESS)[number];

/**
 * Performance judgement. ONE member, deliberately: every approved KPI's target and
 * thresholds are `NOT_DEFINED` WITH evidence of absence, so this runtime has no basis on
 * which to call any number good, bad or on-target. It is `NOT_ASSESSED` for all five, for as
 * long as the catalog says so — never a value this file computes.
 */
export const KPI_PERFORMANCE_JUDGEMENT = ['NOT_ASSESSED'] as const;
export type KpiPerformanceJudgement = (typeof KPI_PERFORMANCE_JUDGEMENT)[number];

/** The closure unit the governed value is stated in. Read from the catalog, never chosen here. */
export type KpiSemanticUnit = 'SECONDS' | 'PERCENT';

/**
 * The display unit the catalog's `unit.presentation` authorizes — a CLOSED set, because
 * "presentation conversion only" must still fail safe.
 *
 * `unit.presentation` is governed PROSE whose LEADING WORD names the display unit
 * (`Hours (…)` / `Days (…)` / `Percent 0–100; …`). This runtime reads that leading word
 * through `displayUnitFromPresentation` and nothing else: if a future definition words its
 * presentation differently the matcher returns `null`, `display` stays `null`, and the screen
 * falls back to the governed value in its semantic unit. An unknown prose form can therefore
 * never become a plausible-looking conversion nobody approved.
 */
export const KPI_DISPLAY_UNIT_TOKENS = ['HOURS', 'DAYS', 'PERCENT'] as const;
export type KpiDisplayUnitToken = (typeof KPI_DISPLAY_UNIT_TOKENS)[number];

/**
 * The period a value was computed for — ALWAYS an explicit Jalali month, half-open in UTC.
 *
 * Every one of the five approved definitions cohorts on a Jalali calendar month in
 * `Asia/Tehran` (their `timeSemantics.window` says so in the same words), so the runtime
 * never accepts "everything", never buckets twice and never reports a period it did not
 * actually read. The bounds are the instants the seam filtered on, echoed back so a screen
 * can state the window honestly instead of re-deriving it from the label.
 */
export interface KpiPeriod {
  /** Jalali year, e.g. 1405. */
  jy: number;
  /** Jalali month, 1–12. */
  jm: number;
  /**
   * Persian month name from `JALALI_MONTHS` — the calendar module's OWN list, returned
   * verbatim exactly as `describeJalaliDay` on `/calendar/*` already returns it. A month
   * NAME is domain vocabulary, not a rendering of a code point, which is why it may cross
   * the wire while a formatted `آبان ۱۴۰۵` may not: the screen owns the digit conversion and
   * the ordering of month and year, so no response can pin a display format for two screens.
   */
  monthName: string;
  /** Half-open `[start, end)` in ISO 8601 UTC — exactly what the seam filtered on. */
  start: string;
  end: string;
  timeZone: string;
  calendar: 'JALALI';
  /**
   * Phase KPI-HISTORICAL-INTELLIGENCE — whether this month had ENDED when read.
   *
   * OPTIONAL so every existing `KpiPeriod` literal (specs, fixtures, web mocks) keeps
   * compiling: single-period reads resolve the current month without asking the clock
   * twice, while history marks completed months explicitly. `true` = the whole month
   * elapsed before `now`; `false` = partial current month, never silently comparable
   * to a full one.
   */
  completed?: boolean;
}

/** Display-only projection of the governed value. `null` whenever no conversion is authorised. */
export interface KpiDisplay {
  value: number;
  unitToken: KpiDisplayUnitToken;
  /** Persian symbol for `unitToken` — a hint the screen may use or replace. */
  unitLabelFa: string;
}

/**
 * One KPI value for one tenant and one period — grouped into exactly the things a result
 * must carry: identity, value, availability, period, quality, interpretation and supporting
 * context. The grouping is deliberate: a screen renders each group without reaching into
 * another and without re-deriving a fact, so two views cannot disagree about one result.
 */
export interface KpiResult {
  /* — identity — */
  id: string;
  technicalKey: string;
  nameFa: string;
  nameEn: string;
  businessQuestion: string;
  definition: string;
  ownerContext: string;

  /* — availability — */
  availability: KpiAvailability;
  /** Present exactly when `availability === 'NOT_AVAILABLE'`; `null` otherwise. */
  unavailableReason: KpiUnavailableReason | null;

  /**
   * — value — the GOVERNED number in `unit.semantic`, or `null` when not available.
   * Never rounded, never clamped, never a placeholder for "unknown".
   */
  value: number | null;
  unit: {
    semantic: KpiSemanticUnit;
    /** The catalog's own `unit.presentation`, verbatim — a governance statement, not a unit. */
    presentation: string;
  };
  /** The authorised display conversion, or `null` when the presentation prose names none. */
  display: KpiDisplay | null;

  /* — period — */
  period: KpiPeriod;

  /**
   * — quality: DATA READINESS, NOT PERFORMANCE. `classification` is the catalog's own
   * `dataQuality.classification`; `meaning` is what stops a screen rendering it as a score.
   */
  quality: {
    classification: KpiDataQualityClass;
    readiness: KpiDataReadiness;
    meaning: 'DATA_READINESS';
    notes: readonly string[];
  };

  /**
   * — interpretation — what a reader may and may not conclude. Every field is closed so the
   * screen cannot assemble a claim the catalog does not support.
   */
  interpretation: {
    usage: 'DESCRIPTIVE_ONLY';
    performance: KpiPerformanceJudgement;
    performanceBasis: 'TARGET_AND_THRESHOLD_NOT_DEFINED';
    targetState: 'NOT_DEFINED';
    thresholdState: 'NOT_DEFINED';
  };

  /* — supporting context: where the number came from, in the catalog's own words. */
  supportingContext: {
    population: string;
    exclusions: string;
    /** The field the period cohorted on — echoed from `timeSemantics.cohortField`. */
    cohortField: string;
    counts: {
      /** Rows the seam returned inside the window, before the definition's own rules. */
      cohort: number;
      /** Rows that entered the value (valid pairs, or the ratio's denominator). */
      valid: number;
      /** Rows the definition's rules excluded — excluded, never zero-filled. */
      excluded: number;
    };
    /** The bounded read ceiling actually applied, so a small `cohort` is visibly complete. */
    readLimit: number;
    evidence: readonly string[];
    knownLimitations: readonly string[];
  };

  /* — governance: the authorization this value was served under, and the formula shape. */
  governance: {
    readRemit: string;
    moduleEntitlement: string;
    featureEntitlement: string;
    formulaKind: 'MEAN_ELAPSED' | 'RATIO_PERCENT';
    newPermissionRequired: false;
  };
}

/** `GET /kpis` — a page of results plus the single period they were all computed for. */
export interface KpiListResult {
  period: KpiPeriod;
  /**
   * The month BEFORE `period`, resolved by the server — or `null` when the requested
   * period sits at the calendar's own floor (nothing precedes it to compare against).
   * The cards read this rather than re-deriving a month from a browser clock.
   */
  previousPeriod: KpiPeriod | null;
  /** Results in CATALOG order, one per definition this caller may read. Never a partial figure. */
  items: KpiResult[];
  /**
   * Period-over-period comparison per VISIBLE key, computed by the server through the
   * same formula on both sides. `null` only when `previousPeriod` is `null`. A key the
   * caller may not read is absent entirely — no seam is reached for it.
   */
  comparisons: Record<string, KpiComparison | null>;
  /** How many approved definitions exist, BEFORE authorization filtered them. */
  total: number;
  /** How many of `total` this caller may read — `0` can never be returned (the route 403s). */
  visible: number;
}

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — one KPI over a bounded run of Jalali months.
 * Chronological, oldest first; every entry is a full `KpiResult` through the SAME
 * formula — never rounded, never zero-filled, unavailable months carried honestly.
 */
export interface KpiHistoryResult {
  id: string;
  technicalKey: string;
  nameFa: string;
  nameEn: string;
  /** The bounded run actually computed, oldest first. Never partial. */
  periods: KpiPeriod[];
  /** One result per period, same order as `periods`. */
  items: KpiResult[];
  /** The period-over-period comparison of the two youngest entries, or null. */
  comparison: KpiComparison | null;
  /** The supporting report route when safely mappable, else null. */
  supportingReport: { href: string; titleFa: string } | null;
}
