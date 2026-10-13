/**
 * Phase KPI-RUNTIME — the KPI computation service: turns five APPROVED definitions plus one
 * tenant-scoped seam read into five period-scoped results.
 *
 * THE FOUR RULES IT IS BUILT AROUND, EACH FROM THE CATALOG
 * --------------------------------------------------------
 *  1. ONE SOURCE OF TRUTH. Definitions — formula, unit, title, population, exclusions,
 *     remit, quality, evidence — are READ from `KPI_CATALOG` on every call. This file states
 *     no formula, no threshold, no title and no Persian sentence. What it does state is the
 *     three-field runtime plan (`kpi-runtime.plan.ts`), and every field of that plan is
 *     asserted back against the catalog by this module's spec.
 *  2. SEAM-ONLY READS. Every number comes from one of the three SOURCE-OWNED narrow readers,
 *     already tenant-scoped by construction. No Prisma client, no repository, no generated
 *     client, no `process.env` is reachable from here — the isolation spec re-reads the file
 *     system to prove it.
 *  3. A ZERO DENOMINATOR IS NOT A NUMBER. `availability` is a first-class field: an empty
 *     cohort, an empty denominator, an all-invalid cohort and a capped read all answer
 *     `NOT_AVAILABLE` with a reason. `value` stays `null` in every one of those cases, so no
 *     screen can render `۰٪` where the honest answer is "nothing existed".
 *  4. QUALITY IS ABOUT DATA, NEVER PERFORMANCE. `quality` carries the catalog's own
 *     `dataQuality.classification` and nothing else; `interpretation.performance` is a
 *     uniform `NOT_ASSESSED` because every approved target and threshold is `NOT_DEFINED`.
 *
 * WHAT THIS SERVICE DELIBERATELY DOES NOT DO
 * ------------------------------------------
 * It performs no authorization. Permission and entitlement are BOUNDARY concerns, and the
 * platform's own `ModuleEntitlementGuard` states the rule plainly: "declared at the boundary
 * and never called from a service". This service therefore receives the already-authorized
 * key set from the controller and computes nothing for a key outside it — an unauthorized
 * key is refused BEFORE it reaches a seam, and the controller's spec pins that.
 */

import { Inject, Injectable } from '@nestjs/common';
import { KPI_CATALOG } from '../../kpi/kpi-catalog';
import type { AnyKpiDefinition } from '../../kpi/kpi-catalog';
import {
  COMMERCE_PURCHASE_REPORTING_READER,
  type CommercePurchaseReportSummary,
  type CommercePurchaseReportingReader,
} from '../commerce/reporting/commerce-purchase-reporting.contract';
import {
  FINANCIAL_CHECK_REQUEST_REPORTING_READER,
  type FinancialCheckRequestReportSummary,
  type FinancialCheckRequestReportingReader,
} from '../financial/reporting/financial-check-request-reporting.contract';
import {
  PRODUCTION_REPORTING_READER,
  type ProductionReportSummary,
  type ProductionReportingReader,
} from '../production/reporting/production-reporting.contract';
import type {
  KpiAvailability,
  KpiDataReadiness,
  KpiHistoryResult,
  KpiListResult,
  KpiPeriod,
  KpiResult,
  KpiUnavailableReason,
} from './kpi-runtime.contract';
import { KPI_SERVED_STATUSES } from './kpi-runtime.contract';
import type { KpiDataQualityClass } from '../../kpi/kpi-definition.model';
import {
  KPI_PAGE_SIZE,
  KPI_READ_LIMIT,
  KPI_MODULE_ID_BY_SOURCE,
  KPI_RUNTIME_PLANS,
  type KpiCohortField,
  type KpiPlan,
} from './kpi-runtime.plan';
import {
  isValidKpiPeriod,
  resolveKpiPeriod,
  resolveKnownKpiPeriod,
  type KpiPeriodInput,
} from './kpi-runtime.period';
import { buildKpiComparison, type KpiComparison } from './kpi-runtime.comparison';
import {
  previousJalaliMonth,
  resolveHistoryMonths,
  supportingReportFor,
  type HistoryRangeInput,
} from './kpi-runtime.history';
import {
  evaluateMeanElapsed,
  evaluateRatioPercent,
  type KpiRow,
  type KpiStatusCounts,
} from './kpi-runtime.engine';
import { toDisplay } from './kpi-runtime.display';

/**
 * The definitions this runtime serves, IN CATALOG ORDER — exported because the CONTROLLER
 * needs the same set to authorize against and to tell "unknown key" (404) from "key this
 * caller may not read" (403). One function, two callers: the served set can never drift
 * between the authorization check and the computation.
 *
 * Derived from `KPI_CATALOG` by status rather than hard-coded, so a catalog edit is picked up
 * rather than shadowed by a second list. The status gate is the one that matters: the four
 * unapproved entries carry `formula: null` and open questions, and a number computed from
 * them would be a measurement nobody approved. `DEPRECATED` is excluded by the same check —
 * the governance rule is "must not be consumed", and this is where that rule bites.
 */
export function servedKpiDefinitions(): readonly AnyKpiDefinition[] {
  return KPI_CATALOG.filter((def) =>
    (KPI_SERVED_STATUSES as readonly string[]).includes(def.status)
  );
}

/** The plan for a served definition, or a refusal — a served KPI with no plan is a defect. */
function planFor(def: AnyKpiDefinition): KpiPlan {
  const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
  if (!plan) {
    throw new Error(
      `Approved KPI "${def.technicalKey}" has no runtime plan — the catalog and ` +
        `kpi-runtime.plan.ts have drifted apart.`
    );
  }
  return plan;
}

/**
 * The SUPERSET of the three seam windows, plus the shared page window.
 *
 * Each reader declares only its own fields and forwards only those it knows, so this superset
 * never widens what reaches a repository — it exists so one paging loop and one summary call
 * can serve three differently-named windows without a cast per branch. Every field is
 * optional, so the object is assignable to each reader's query type as-is.
 */
interface SeamQuery {
  decidedFrom?: string;
  decidedTo?: string;
  createdFrom?: string;
  createdTo?: string;
  completedFrom?: string;
  completedTo?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The catalog's `dataQuality.classification` projected onto the screen's readiness word.
 *
 * A 1:1 translation and nothing more: `GREEN → READY`, `YELLOW → PARTIAL`,
 * `BLOCKED → NOT_ASSESSED`. `BLOCKED` can never be served (the APPROVED gate excludes it),
 * so its branch is unreachable today — kept because the vocabulary is closed, not because a
 * path reaches it. NOTHING here reads the tenant's data: readiness describes how complete the
 * DEFINITION's evidence is, which is why two periods of the same KPI always agree.
 */
function dataReadinessOf(classification: KpiDataQualityClass): KpiDataReadiness {
  if (classification === 'GREEN') return 'READY';
  if (classification === 'YELLOW') return 'PARTIAL';
  return 'NOT_ASSESSED';
}

/**
 * The wire window a period becomes, for one seam field.
 *
 * THREE explicit returns rather than a generic `{ from, to }` spread: each seam names its own
 * window fields, and a generic spread would carry keys no seam declared. The half-open bounds
 * come from the period resolver, so the label a screen shows and the predicate the database
 * ran are the same two instants by construction.
 */
function windowQuery(field: KpiCohortField, period: KpiPeriod): SeamQuery {
  if (field === 'decidedAt') return { decidedFrom: period.start, decidedTo: period.end };
  if (field === 'completedAt') {
    return { completedFrom: period.start, completedTo: period.end };
  }
  return { createdFrom: period.start, createdTo: period.end };
}

@Injectable()
export class KpiRuntimeService {
  constructor(
    @Inject(PRODUCTION_REPORTING_READER)
    private readonly production: ProductionReportingReader,
    @Inject(COMMERCE_PURCHASE_REPORTING_READER)
    private readonly commerce: CommercePurchaseReportingReader,
    @Inject(FINANCIAL_CHECK_REQUEST_REPORTING_READER)
    private readonly financial: FinancialCheckRequestReportingReader
  ) {}

  /**
   * One page of results for the keys the caller is ALLOWED to read.
   *
   * `keys` arrives already authorized from the controller; a key outside it is skipped rather
   * than computed-and-hidden, so no seam is ever reached for a definition the caller may not
   * see. `total` is the pre-authorization count and `visible` the post-authorization one, so a
   * screen can say "۳ از ۵" honestly instead of implying the catalog shrank.
   */
  async list(
    scope: { tenantId: string },
    keys: readonly string[],
    periodInput: KpiPeriodInput
  ): Promise<KpiListResult> {
    const period = resolveKpiPeriod(periodInput);
    const served = servedKpiDefinitions();

    // Phase KPI-HISTORICAL-INTELLIGENCE — the card comparison. The month before the
    // served one is resolved HERE (server clock, server calendar), so the screen never
    // derives a "previous month" from a browser date. When nothing precedes the month
    // (the calendar floor), `previousPeriod` is null and every comparison follows —
    // an honest absence rather than a fabricated neighbour.
    const previousInput = previousJalaliMonth(period.jy, period.jm);
    const previousPeriod = isValidKpiPeriod(previousInput.jy, previousInput.jm)
      ? resolveKnownKpiPeriod(previousInput.jy, previousInput.jm)
      : null;

    const items: KpiResult[] = [];
    const comparisons: Record<string, KpiComparison | null> = {};
    for (const def of served) {
      if (!keys.includes(def.technicalKey)) continue;
      const current = await this.compute(def, scope, period);
      items.push(current);
      // The previous month runs through the SAME compute: one definition, one formula,
      // one seam — never a stored or re-derived figure on the comparison side.
      comparisons[def.technicalKey] = previousPeriod
        ? buildKpiComparison(current, await this.compute(def, scope, previousPeriod))
        : null;
    }

    return {
      period,
      previousPeriod,
      items,
      comparisons,
      total: served.length,
      visible: items.length,
    };
  }

  /**
   * Exactly one result.
   *
   * The KEY must already be authorized and present in the served set — the controller checks
   * both before calling — so this refuses rather than guessing: an unknown key, a key outside
   * the five, or a plan that does not match its own catalog entry is a defect, not a 404 to
   * be papered over with a plausible figure.
   */
  async getOne(
    scope: { tenantId: string },
    technicalKey: string,
    periodInput: KpiPeriodInput
  ): Promise<KpiResult> {
    const def = servedKpiDefinitions().find((entry) => entry.technicalKey === technicalKey);
    if (!def) {
      throw new Error(`"${technicalKey}" is not a served (APPROVED) KPI definition.`);
    }

    const period = resolveKpiPeriod(periodInput);
    return this.compute(def, scope, period);
  }

  /**
   * Phase KPI-HISTORICAL-INTELLIGENCE — one KPI over a bounded run of months.
   *
   * THE SAME PATH PER PERIOD: each month resolves through `resolveKnownKpiPeriod`
   * and computes through `compute` — the definition, the seam window and the
   * structural formula are identical to a single-period read. No second formula,
   * no rounded display value reused, no partial series: if any period throws, the
   * whole history throws rather than returning a shorter run wearing a full one's
   * clothes. Comparison covers the two youngest entries; a single-period history
   * is refused by the range resolver (minimum 2), so `comparison` is never null
   * for a served history.
   */
  async getHistory(
    scope: { tenantId: string },
    technicalKey: string,
    range: HistoryRangeInput,
    now: Date = new Date()
  ): Promise<KpiHistoryResult> {
    const def = servedKpiDefinitions().find((entry) => entry.technicalKey === technicalKey);
    if (!def) {
      throw new Error(`"${technicalKey}" is not a served (APPROVED) KPI definition.`);
    }
    const months = resolveHistoryMonths(range, now);
    const periods = months.map((month) => resolveKnownKpiPeriod(month.jy, month.jm, now));
    const items: KpiResult[] = [];
    for (const period of periods) {
      items.push(await this.compute(def, scope, period));
    }
    const current = items[items.length - 1];
    const previous = items[items.length - 2];
    if (!current || !previous) {
      throw new Error('KPI history produced no comparable pair.');
    }
    return {
      id: def.id,
      technicalKey: def.technicalKey,
      nameFa: def.nameFa,
      nameEn: def.nameEn,
      periods,
      items,
      comparison: buildKpiComparison(current, previous),
      supportingReport: supportingReportFor(def.technicalKey),
    };
  }

  /**
   * One definition → one result: read the cohort, evaluate the structural formula, assemble
   * the contract. The ONLY place the catalog and a seam meet.
   *
   * THREE REFUSALS SIT BEFORE ANY READ, because each would otherwise become a silently wrong
   * number rather than an error:
   *   * `formula: null` — served without a formula means the APPROVED gate failed;
   *   * a `cohortField` that disagrees with the plan — the period would be pushed into a
   *     different instant than the definition cohorts on, and every value would describe
   *     another month;
   *   * a `moduleEntitlement` that disagrees with the seam's own module id — the result would
   *     be served under a remit the catalog never attached to it.
   * All three are constant-vs-constant comparisons: O(1), and worth a 500 over a plausible
   * figure nobody could falsify.
   */
  private async compute(
    def: AnyKpiDefinition,
    scope: { tenantId: string },
    period: KpiPeriod
  ): Promise<KpiResult> {
    const plan = planFor(def);
    const formula = def.formula;

    if (!formula) {
      throw new Error(`KPI "${def.technicalKey}" is served without a structural formula.`);
    }
    if (def.timeSemantics?.cohortField !== plan.cohortField) {
      throw new Error(
        `KPI "${def.technicalKey}" cohorts on "${String(def.timeSemantics?.cohortField)}" ` +
          `but its plan pushes the period into "${plan.cohortField}".`
      );
    }
    if (def.authorization.moduleEntitlement !== KPI_MODULE_ID_BY_SOURCE[plan.source]) {
      throw new Error(
        `KPI "${def.technicalKey}" declares entitlement "${def.authorization.moduleEntitlement}" ` +
          `while its seam "${plan.source}" serves "${KPI_MODULE_ID_BY_SOURCE[plan.source]}".`
      );
    }

    let value: number | null;
    let availability: KpiAvailability;
    let unavailableReason: KpiUnavailableReason | null;
    let counts: { cohort: number; valid: number; excluded: number };

    if (formula.kind === 'MEAN_ELAPSED') {
      const { rows, truncated } = await this.readRows(plan, period, scope);
      const outcome = evaluateMeanElapsed(formula, plan.population ?? {}, rows);

      counts = {
        cohort: outcome.cohortRows,
        valid: outcome.validRows,
        excluded: outcome.excludedRows,
      };

      if (truncated) {
        // The evaluator still ran so the counts describe what was actually read, but the
        // VALUE is refused: the mean of the first `KPI_READ_LIMIT` rows is not the month's
        // mean, and publishing it would be the most plausible-looking lie this runtime could
        // tell — a real number, honestly computed, over half a cohort.
        availability = 'NOT_AVAILABLE';
        unavailableReason = 'COHORT_EXCEEDS_LIMIT';
        value = null;
      } else if (outcome.cohortRows === 0) {
        availability = 'NOT_AVAILABLE';
        unavailableReason = 'EMPTY_COHORT';
        value = null;
      } else if (outcome.meanSeconds === null) {
        availability = 'NOT_AVAILABLE';
        unavailableReason = 'NO_VALID_ROWS';
        value = null;
      } else {
        availability = 'AVAILABLE';
        unavailableReason = null;
        value = outcome.meanSeconds;
      }
    } else {
      const statusCounts = await this.readCounts(plan, period, scope);
      const outcome = evaluateRatioPercent(formula, statusCounts);

      counts = {
        cohort: statusCounts.total,
        valid: outcome.denominator,
        excluded: statusCounts.total - outcome.denominator,
      };

      if (statusCounts.total === 0) {
        availability = 'NOT_AVAILABLE';
        unavailableReason = 'EMPTY_COHORT';
        value = null;
      } else if (outcome.denominator === 0) {
        availability = 'NOT_AVAILABLE';
        unavailableReason = 'EMPTY_DENOMINATOR';
        value = null;
      } else {
        availability = 'AVAILABLE';
        unavailableReason = null;
        value = outcome.percent;
      }
    }

    return this.assemble(def, plan, period, {
      value,
      availability,
      unavailableReason,
      counts,
      formulaKind: formula.kind,
    });
  }

  /**
   * The COHORT rows a `MEAN_ELAPSED` needs, paged under a hard ceiling.
   *
   * Three distinct stopping reasons: the seam's own `total` was reached (complete), the seam
   * returned nothing beyond what it claimed (`total` disagrees with its page — stop rather
   * than spin), or `KPI_READ_LIMIT` was hit — which the caller turns into `NOT_AVAILABLE`
   * rather than a partial mean.
   */
  private async readRows(
    plan: KpiPlan,
    period: KpiPeriod,
    scope: { tenantId: string }
  ): Promise<{ rows: KpiRow[]; truncated: boolean }> {
    const window = windowQuery(plan.cohortField, period);
    const rows: KpiRow[] = [];
    let page = 1;

    for (;;) {
      const batch = await this.readPage(plan, window, page, scope);
      rows.push(...batch.items);

      if (batch.items.length === 0 || rows.length >= batch.total) {
        return { rows, truncated: false };
      }
      if (rows.length >= KPI_READ_LIMIT) {
        return { rows: rows.slice(0, KPI_READ_LIMIT), truncated: true };
      }
      page += 1;
    }
  }

  /**
   * ONE seam page — the sole place a source reader is reached from this module.
   *
   * `SeamQuery` is the SUPERSET of the three windows. Each reader's own `reportFilter` picks
   * out only the fields its seam declares, so a `createdFrom` that reaches Production is
   * dropped there rather than forwarded; the superset exists purely so one paging loop can
   * serve three differently-named windows without a cast per branch.
   */
  private async readPage(
    plan: KpiPlan,
    window: SeamQuery,
    page: number,
    scope: { tenantId: string }
  ): Promise<{ items: KpiRow[]; total: number }> {
    const query: SeamQuery = { ...window, page, pageSize: KPI_PAGE_SIZE };
    const actor = { tenantId: scope.tenantId };

    if (plan.source === 'production') {
      const result = await this.production.listReportRows(actor, query);
      return { items: result.items, total: result.total };
    }
    if (plan.source === 'commerce') {
      const result = await this.commerce.listReportRows(actor, query);
      return { items: result.items, total: result.total };
    }
    const result = await this.financial.listReportRows(actor, query);
    return { items: result.items, total: result.total };
  }

  /**
   * The bounded per-status COUNTS a `RATIO_PERCENT` needs — one `groupBy`, no rows loaded.
   *
   * This is why ratios never page: a denominator is a COUNT, and materialising a register in
   * order to count it would be exactly the inefficiency the seam's summary exists to avoid.
   */
  private async readCounts(
    plan: KpiPlan,
    period: KpiPeriod,
    scope: { tenantId: string }
  ): Promise<KpiStatusCounts> {
    const window = windowQuery(plan.cohortField, period);
    const actor = { tenantId: scope.tenantId };

    if (plan.source === 'production') {
      const summary: ProductionReportSummary = await this.production.getReportSummary(
        actor,
        window
      );
      return { total: summary.total, byStatus: summary.byStatus };
    }
    if (plan.source === 'commerce') {
      const summary: CommercePurchaseReportSummary = await this.commerce.getReportSummary(
        actor,
        window
      );
      return { total: summary.total, byStatus: summary.byStatus };
    }
    const summary: FinancialCheckRequestReportSummary = await this.financial.getReportSummary(
      actor,
      window
    );
    return { total: summary.total, byStatus: summary.byStatus };
  }

  /**
   * The contract: catalog facts + the computed outcome, assembled once.
   *
   * Note what is NOT here: no arithmetic, no formatting, no rounding, no Persian sentence.
   * `value` arrives already governed and unrounded; `display` is the ONE authorised
   * conversion, derived from the catalog's own `unit.presentation`; every word on the wire is
   * the catalog's. This function is deliberately boring — a second place that could reason
   * about a number is a second place a number could change.
   */
  private assemble(
    def: AnyKpiDefinition,
    plan: KpiPlan,
    period: KpiPeriod,
    outcome: {
      value: number | null;
      availability: KpiAvailability;
      unavailableReason: KpiUnavailableReason | null;
      counts: { cohort: number; valid: number; excluded: number };
      formulaKind: 'MEAN_ELAPSED' | 'RATIO_PERCENT';
    }
  ): KpiResult {
    const semantic = def.unit.semantic;

    return {
      id: def.id,
      technicalKey: def.technicalKey,
      nameFa: def.nameFa,
      nameEn: def.nameEn,
      businessQuestion: def.businessQuestion,
      definition: def.definition,
      ownerContext: def.ownerContext,

      availability: outcome.availability,
      unavailableReason: outcome.unavailableReason,

      value: outcome.value,
      unit: { semantic, presentation: def.unit.presentation },
      // No display projection for an unavailable value: there is nothing to convert, and a
      // converted `0` would be the placeholder `value` is refusing to be.
      display:
        outcome.value === null ? null : toDisplay(outcome.value, semantic, def.unit.presentation),

      period,

      quality: {
        classification: def.dataQuality.classification,
        readiness: dataReadinessOf(def.dataQuality.classification),
        meaning: 'DATA_READINESS',
        notes: def.dataQuality.notes,
      },

      interpretation: {
        usage: 'DESCRIPTIVE_ONLY',
        performance: 'NOT_ASSESSED',
        performanceBasis: 'TARGET_AND_THRESHOLD_NOT_DEFINED',
        targetState: 'NOT_DEFINED',
        thresholdState: 'NOT_DEFINED',
      },

      supportingContext: {
        population: def.population,
        exclusions: def.exclusions,
        cohortField: plan.cohortField,
        counts: outcome.counts,
        readLimit: KPI_READ_LIMIT,
        evidence: def.evidence,
        knownLimitations: def.knownLimitations,
      },

      governance: {
        readRemit: def.authorization.readRemit,
        moduleEntitlement: def.authorization.moduleEntitlement,
        featureEntitlement: plan.featureId,
        formulaKind: outcome.formulaKind,
        newPermissionRequired: false,
      },
    };
  }
}
