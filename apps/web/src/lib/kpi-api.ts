import { coreGet } from './core-http';

/**
 * Phase KPI-RUNTIME â€” the read-only KPI client, mirroring `kpi-runtime.controller.ts`
 * exactly:
 *
 *   GET /kpis                 (every approved KPI this caller may read, one Jalali month)
 *   GET /kpis/:technicalKey   (exactly one)
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` â€” the server resolves it from the session; a client field would be
 *    refused by the global pipe's `whitelist` + `forbidNonWhitelisted`.
 *  * NO write method â€” a KPI value is COMPUTED, never stored, so there is nothing to
 *    POST/PATCH/DELETE and a client with no verb cannot offer the button.
 *  * NO `status`/`search`/`page` â€” this surface answers a SUMMARISED figure, not a
 *    register. A whitelisted filter that changes nothing about the number would be a
 *    dishonest parameter, which is exactly what `KpiPeriodQueryDto` refuses.
 *  * NO `target`/`threshold`/`grade` â€” none exist. All five approved definitions carry
 *    `target: NOT_DEFINED` and `thresholds: NOT_DEFINED`, so the runtime serves
 *    `performance: 'NOT_ASSESSED'` and a screen may not re-introduce a verdict.
 *
 * The period is `jy` + `jm` ONLY â€” a Jalali month, because all five definitions cohort on
 * one. Neither is required: omit both and the server fills the current month.
 */

/* â€”â€”â€”â€”â€” the frozen vocabulary, restated as CLOSED unions â€”â€”â€”â€”â€” */

export const KPI_AVAILABILITY = ['AVAILABLE', 'NOT_AVAILABLE'] as const;
export type KpiAvailability = (typeof KPI_AVAILABILITY)[number];

export const KPI_UNAVAILABLE_REASONS = [
  'EMPTY_COHORT',
  'EMPTY_DENOMINATOR',
  'NO_VALID_ROWS',
  'COHORT_EXCEEDS_LIMIT',
] as const;
export type KpiUnavailableReason = (typeof KPI_UNAVAILABLE_REASONS)[number];

export const KPI_DATA_READINESS = ['READY', 'PARTIAL', 'NOT_ASSESSED'] as const;
export type KpiDataReadiness = (typeof KPI_DATA_READINESS)[number];

export const KPI_DISPLAY_UNIT_TOKENS = ['HOURS', 'DAYS', 'PERCENT'] as const;
export type KpiDisplayUnitToken = (typeof KPI_DISPLAY_UNIT_TOKENS)[number];

export type KpiSemanticUnit = 'SECONDS' | 'PERCENT';
export type KpiDataQualityClass = 'GREEN' | 'YELLOW' | 'BLOCKED';

/** The period the value was computed for â€” always an explicit Jalali month. */
export interface KpiPeriod {
  jy: number;
  jm: number;
  /** Persian month name verbatim from the calendar module â€” NOT a formatted date. */
  monthName: string;
  /** Half-open `[start, end)` in ISO 8601 UTC â€” exactly what the seam filtered on. */
  start: string;
  end: string;
  timeZone: string;
  calendar: 'JALALI';
  /** True when the whole month elapsed before the server read it (absent on older payloads). */
  completed?: boolean;
}

/** The authorised display conversion, or `null` when no conversion was authorised. */
export interface KpiDisplay {
  value: number;
  unitToken: KpiDisplayUnitToken;
  unitLabelFa: string;
}

/** One KPI value for one tenant and one Jalali month â€” the contract's exact grouping. */
export interface KpiResult {
  id: string;
  technicalKey: string;
  nameFa: string;
  nameEn: string;
  businessQuestion: string;
  definition: string;
  ownerContext: string;

  availability: KpiAvailability;
  unavailableReason: KpiUnavailableReason | null;

  value: number | null;
  unit: { semantic: KpiSemanticUnit; presentation: string };
  display: KpiDisplay | null;

  period: KpiPeriod;

  /** DATA READINESS, NOT PERFORMANCE â€” `meaning` is what stops a screen reading it as a score. */
  quality: {
    classification: KpiDataQualityClass;
    readiness: KpiDataReadiness;
    meaning: 'DATA_READINESS';
    notes: readonly string[];
  };

  interpretation: {
    usage: 'DESCRIPTIVE_ONLY';
    performance: 'NOT_ASSESSED';
    performanceBasis: 'TARGET_AND_THRESHOLD_NOT_DEFINED';
    targetState: 'NOT_DEFINED';
    thresholdState: 'NOT_DEFINED';
  };

  supportingContext: {
    population: string;
    exclusions: string;
    cohortField: string;
    counts: { cohort: number; valid: number; excluded: number };
    readLimit: number;
    evidence: readonly string[];
    knownLimitations: readonly string[];
  };

  governance: {
    readRemit: string;
    moduleEntitlement: string;
    featureEntitlement: string;
    formulaKind: 'MEAN_ELAPSED' | 'RATIO_PERCENT';
    newPermissionRequired: false;
  };
}

/** `GET /kpis` â€” a page of results plus the single period they were all computed for. */
export interface KpiListResult {
  period: KpiPeriod;
  /** The month BEFORE `period` (server-resolved), or null at the calendar floor. */
  previousPeriod: KpiPeriod | null;
  items: KpiResult[];
  /** Server-computed period comparison per VISIBLE key; absent keys are unauthorized. */
  comparisons: Record<string, KpiComparison | null>;
  /** Approved definitions BEFORE authorization filtered them â€” the honest denominator. */
  total: number;
  /** How many of `total` this caller may read â€” `Û³ Ø§Ø² Ûµ`, never a shrunken catalogue. */
  visible: number;
}

/** The period query â€” only the two integers `KpiPeriodQueryDto` validates. */
export interface KpiPeriodQuery {
  jy?: number;
  jm?: number;
}

function periodQuery(query: KpiPeriodQuery): string {
  const search = new URLSearchParams();
  if (query.jy !== undefined) search.set('jy', String(query.jy));
  if (query.jm !== undefined) search.set('jm', String(query.jm));
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** Every approved KPI this caller may read, for one Jalali month (or the current one). */
export function fetchKpis(query: KpiPeriodQuery = {}): Promise<KpiListResult> {
  return coreGet<KpiListResult>(`/kpis${periodQuery(query)}`);
}

/** Exactly one approved KPI â€” 404 for an unknown key, 403 for one this caller may not read. */
export function fetchKpi(technicalKey: string, query: KpiPeriodQuery = {}): Promise<KpiResult> {
  return coreGet<KpiResult>(`/kpis/${encodeURIComponent(technicalKey)}${periodQuery(query)}`);
}

/* ———— Phase KPI-HISTORICAL-INTELLIGENCE: history, comparison, drill-down ———— */

export const KPI_COMPARISON_DIRECTIONS = ['INCREASE', 'DECREASE', 'UNCHANGED'] as const;
export type KpiComparisonDirection = (typeof KPI_COMPARISON_DIRECTIONS)[number];

export const KPI_COMPARISON_UNAVAILABLE_REASONS = [
  'CURRENT_NOT_AVAILABLE',
  'PREVIOUS_NOT_AVAILABLE',
  'BOTH_NOT_AVAILABLE',
  'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
] as const;
export type KpiComparisonUnavailableReason = (typeof KPI_COMPARISON_UNAVAILABLE_REASONS)[number];

/**
 * Period-over-period comparison — the server's arithmetic over two governed values.
 * `percentagePointChange` is the PRIMARY delta for PERCENT KPIs; `relativeChange` is
 * null when the previous value was zero or either side was unavailable.
 */
export interface KpiComparison {
  availability: 'AVAILABLE' | 'NOT_AVAILABLE';
  unavailableReason: KpiComparisonUnavailableReason | null;
  currentPeriod: KpiPeriod;
  previousPeriod: KpiPeriod;
  currentValue: number | null;
  previousValue: number | null;
  absoluteChange: number | null;
  percentagePointChange: number | null;
  relativeChange: number | null;
  direction: KpiComparisonDirection | null;
  unitSemantic: KpiSemanticUnit;
  /** The authorised delta projection (points for rates), or null — never a screen-side conversion. */
  changeDisplay: { value: number; unitToken: KpiDisplayUnitToken; unitLabelFa: string } | null;
}

/** `GET /kpis/:key/history` — chronological months plus one comparison. */
export interface KpiHistoryResult {
  id: string;
  technicalKey: string;
  nameFa: string;
  nameEn: string;
  periods: KpiPeriod[];
  items: KpiResult[];
  comparison: KpiComparison | null;
  /** The governed supporting-report route, or null when none is safely mappable. */
  supportingReport: { href: string; titleFa: string } | null;
}

/** The history query — bounded by the server's DTO (2..12 periods, or from/to). */
export interface KpiHistoryQuery {
  periodCount?: number;
  fromJy?: number;
  fromJm?: number;
  toJy?: number;
  toJm?: number;
}

function historyQuery(query: KpiHistoryQuery): string {
  const search = new URLSearchParams();
  if (query.periodCount !== undefined) search.set('periodCount', String(query.periodCount));
  if (query.fromJy !== undefined) search.set('fromJy', String(query.fromJy));
  if (query.fromJm !== undefined) search.set('fromJm', String(query.fromJm));
  if (query.toJy !== undefined) search.set('toJy', String(query.toJy));
  if (query.toJm !== undefined) search.set('toJm', String(query.toJm));
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/**
 * The bounded history of one KPI — 404 unknown, 403 unauthorized, 400
 * HISTORY_RANGE_EXCEEDS_LIMIT / HISTORY_INVALID_RANGE for a refused range.
 * An empty query asks the server for its own default (last 6 months).
 */
export function fetchKpiHistory(
  technicalKey: string,
  query: KpiHistoryQuery = {}
): Promise<KpiHistoryResult> {
  return coreGet<KpiHistoryResult>(
    `/kpis/${encodeURIComponent(technicalKey)}/history${historyQuery(query)}`
  );
}

/**
 * The union of the three SOURCE read remits the five approved KPIs answer to.
 *
 * This is a CLIENT-RESTATED copy of `KPI_READ_REMITS` in `kpi-runtime.controller.ts`, for
 * exactly the reason `nav-catalogue.ts` restates the nav tree: `apps/web` cannot import from
 * `apps/api`. It is presentation-only â€” it decides whether a request is worth ISSUING, never
 * whether one succeeds. The server re-asks the same question behind `@Roles(...)` plus a
 * per-definition permission and entitlement check, and its 403 stays decisive.
 *
 * All three are needed rather than one: the five KPIs span Production, Commerce and
 * Financial, so a caller may legitimately hold only one of them. `kpi-api.spec.ts` pins this
 * list back to the controller's own constant.
 */
export const KPI_READ_REMITS = [
  'production.bom.read',
  'commerce.read',
  'financial.check.read',
] as const;

/** True when `granted` holds AT LEAST ONE remit a served KPI reads under. */
export function canReadAnyKpi(granted: readonly string[]): boolean {
  return KPI_READ_REMITS.some((remit) => granted.includes(remit));
}
