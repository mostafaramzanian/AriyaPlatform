/**
 * Phase KPI-RUNTIME — the KPI RUNTIME PLAN: the per-definition wiring that says WHICH seam
 * reads a KPI, on WHICH instant its period cohorts, and WHICH rows of that window count.
 *
 * WHY THIS IS DATA AND NOT CODE
 * -----------------------------
 * A plan row carries exactly three things the catalog does NOT carry structurally, and only
 * three:
 *
 *  1. `source` — which approved seam answers. The catalog states it as prose
 *     (`sourceContract.seamToken` + `ownerContext`); this maps both to the injected reader,
 *     and `kpi-runtime.service.spec.ts` asserts the map agrees with `seamToken`.
 *  2. `cohortField` — the seam's date-window the period is pushed into. The catalog states
 *     it as `timeSemantics.cohortField`; it is restated here because a seam query needs a
 *     FIELD NAME rather than a governance sentence, and the same spec asserts they agree.
 *  3. `population` — the membership `MEAN_ELAPSED` cannot express (see `KpiPopulation`).
 *     Ratios carry none: their numerator/denominator selectors ARE their population.
 *
 * Everything else a result reports — formula, unit, target, threshold, remit, quality, the
 * Persian title — is read from `KPI_CATALOG` at call time. Nothing here may state a formula,
 * a threshold, a title or a number.
 */

import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce/commerce.constants';
import { FINANCIAL_FEATURE, FINANCIAL_MODULE_ID } from '../financial/financial.constants';
import { PRODUCTION_FEATURE, PRODUCTION_MODULE_ID } from '../production/production.constants';
import type { KpiPopulation } from './kpi-runtime.engine';

/** The seam a KPI is read through — one member per source-owned narrow read module. */
export type KpiSourceKind = 'production' | 'commerce' | 'financial';

/**
 * The instant a KPI's period cohorts on, restricted to the four fields the seams expose as
 * date windows. A closed set so a typo cannot compile — and the service asserts each plan's
 * member equals the catalog's `timeSemantics.cohortField` for the same key.
 */
export type KpiCohortField = 'decidedAt' | 'completedAt' | 'createdAt';

export interface KpiPlan {
  technicalKey: string;
  source: KpiSourceKind;
  cohortField: KpiCohortField;
  /**
   * Structural membership for a `MEAN_ELAPSED` cohort. ABSENT for `RATIO_PERCENT` definitions,
   * whose selectors already state their own population — duplicating it here would give a
   * rate two places to disagree with itself.
   */
  population?: KpiPopulation;
  /**
   * The FEATURE the source's OWN read route declares beside its module
   * (`@RequiresFeature`), so a KPI can never be a wider door than the report surface it is a
   * view of. The MODULE id deliberately is not here: it comes from the catalog's own
   * `authorization.moduleEntitlement`, and the service asserts the two agree.
   */
  featureId: string;
}

/**
 * The five approved definitions, in CATALOG order.
 *
 * A Map rather than an object so a lookup misses loudly (`undefined`) instead of inheriting
 * `Object.prototype`. The set is exactly the five the catalog lists as "First runtime
 * candidates"; `kpi-runtime.service.spec.ts` re-derives that list from the catalog itself, so
 * approving a sixth KPI without a plan fails the suite rather than being silently skipped.
 */
export const KPI_RUNTIME_PLANS: ReadonlyMap<string, KpiPlan> = new Map<string, KpiPlan>(
  (
    [
      {
        technicalKey: 'production-bom-decision-cycle-time',
        source: 'production' as KpiSourceKind,
        cohortField: 'decidedAt' as const,
        population: { statuses: ['APPROVED', 'REJECTED'] },
        featureId: PRODUCTION_FEATURE.BOM,
      },
      {
        technicalKey: 'production-bom-approval-rate',
        source: 'production' as KpiSourceKind,
        cohortField: 'decidedAt' as const,
        featureId: PRODUCTION_FEATURE.BOM,
      },
      {
        technicalKey: 'commerce-purchase-cycle-time',
        source: 'commerce' as KpiSourceKind,
        cohortField: 'completedAt' as const,
        population: { statuses: ['CLOSED'] },
        featureId: COMMERCE_FEATURE.PURCHASE,
      },
      {
        technicalKey: 'commerce-purchase-completion-rate',
        source: 'commerce' as KpiSourceKind,
        cohortField: 'createdAt' as const,
        featureId: COMMERCE_FEATURE.PURCHASE,
      },
      {
        technicalKey: 'financial-check-request-decision-time',
        source: 'financial' as KpiSourceKind,
        cohortField: 'decidedAt' as const,
        population: { nonNullFields: ['managerDecision'] },
        featureId: FINANCIAL_FEATURE.CHECK_REQUEST,
      },
    ] satisfies readonly KpiPlan[]
  ).map((plan) => [plan.technicalKey, plan] as const)
);

/** The MODULE id behind each seam, so the service can assert it matches the catalog's. */
export const KPI_MODULE_ID_BY_SOURCE: Readonly<Record<KpiSourceKind, string>> = {
  production: PRODUCTION_MODULE_ID,
  commerce: COMMERCE_MODULE_ID,
  financial: FINANCIAL_MODULE_ID,
};

/**
 * The bounded read ceiling for one KPI cohort.
 *
 * A `MEAN_ELAPSED` needs the ROWS, so it pages the seam; without a ceiling a pathological
 * month could stream a register into memory to average it. Reaching the ceiling does NOT
 * publish a partial mean — the result becomes `NOT_AVAILABLE / COHORT_EXCEEDS_LIMIT`, because
 * "the first 5000 were slow" is not the mean of the month. Ratios never page (they read the
 * seam's bounded `groupBy`), so this ceiling applies to means only.
 */
export const KPI_READ_LIMIT = 5000;

/** How many rows one seam page requests — bounded by each seam's own page ceiling. */
export const KPI_PAGE_SIZE = 100;

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the bounded history ceiling.
 *
 * WHY 12: one Jalali year of months. Evidence-based against the existing ceilings:
 * a MEAN month costs at most `ceil(5000/100) = 50` seam pages, so a 12-month history
 * costs at most 600 page reads per KPI — the same ORDER as twelve single-period reads
 * a screen could already issue, now stated once and refused loudly past it.
 */
export const KPI_HISTORY_MAX_PERIODS = 12;
