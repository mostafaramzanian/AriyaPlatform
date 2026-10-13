import type {
  KpiAvailability,
  KpiComparison,
  KpiComparisonDirection,
  KpiComparisonUnavailableReason,
  KpiDataQualityClass,
  KpiDataReadiness,
  KpiDisplayUnitToken,
  KpiSemanticUnit,
  KpiUnavailableReason,
} from './kpi-api';

/**
 * Phase KPI-RUNTIME — the Persian rendering of every CLOSED code point the KPI runtime
 * serves.
 *
 * WHY THIS FILE IS SEPARATE FROM THE API CLIENT
 * ---------------------------------------------
 * `kpi-api.ts` mirrors the WIRE (English code points, exact field names); this file is the
 * Persian rendering of those code points — the same split `production-labels.ts` and
 * `commerce-labels.ts` state: the API returns the stored fact, and a screen renders the
 * Persian label, so no response ever carries a `displayLabel` and no component has to
 * re-derive one.
 *
 * EVERY MAP IS TOTAL OVER ITS UNION. Each `Record` is keyed by the full closed set, so a
 * new code point on the wire is a COMPILE error here rather than a `undefined` rendering as
 * raw English in front of a user. The `?? key` fallbacks in the functions exist for values
 * that arrive typed as plain `string` (a `cohortField` or an `ownerContext`, which the
 * contract states as `string`), never for a union member.
 */

/* ————— availability ————— */

/**
 * Whether a value EXISTS — never how good it is.
 *
 * `NOT_AVAILABLE` is a finding, not a failure: it means "this month has no such figure",
 * and the reason sentence below says WHICH nothing it was. It is never rendered as `۰`.
 */
export const KPI_AVAILABILITY_LABELS: Record<KpiAvailability, string> = {
  AVAILABLE: 'محاسبه شده',
  NOT_AVAILABLE: 'در دسترس نیست',
};

export function kpiAvailabilityLabel(availability: KpiAvailability): string {
  return KPI_AVAILABILITY_LABELS[availability] ?? availability;
}

/* ————— why a value is absent ————— */

/**
 * The four absences, in the distinction the contract insists on.
 *
 * `EMPTY_COHORT` and `EMPTY_DENOMINATOR` mean OPPOSITE things — "nothing happened" versus
 * "nothing of this kind happened" — so they get opposite sentences. Collapsing them to one
 * «داده‌ای موجود نیست» would erase the only finding the month produced.
 */
export const KPI_UNAVAILABLE_REASON_LABELS: Record<KpiUnavailableReason, string> = {
  EMPTY_COHORT:
    'در این ماه هیچ موردی از این شاخص ثبت نشده است؛ عددی برای نمایش وجود ندارد و صفر گزارش نمی‌شود.',
  EMPTY_DENOMINATOR:
    'در این ماه مواردی ثبت شده، اما هیچ‌کدام به جمع مخرج این نسبت تعلق ندارد؛ نسبتی وجود ندارد.',
  NO_VALID_ROWS:
    'موارد این ماه وجود دارند اما هیچ‌کدام با قواعد تعریف شاخص (ترتیب ثبت و تکمیل بودن) سازگار نیستند.',
  COHORT_EXCEEDS_LIMIT:
    'تعداد موارد این ماه از سقف مجاز خواندن بیشتر است؛ میانگین ناقص هرگز منتشر نمی‌شود.',
};

export function kpiUnavailableReasonLabel(reason: KpiUnavailableReason | null): string | null {
  if (!reason) return null;
  return KPI_UNAVAILABLE_REASON_LABELS[reason] ?? reason;
}

/* ————— data readiness ————— */

/**
 * DATA readiness — how complete the governed definition's EVIDENCE is.
 *
 * This is emphatically NOT a performance colour. The catalog's `GREEN`/`YELLOW` describe
 * the definition's data quality (the final-round limitation, say), and `KPI_PERFORMANCE_NOTE`
 * states in words that performance was never assessed.
 */
export const KPI_READINESS_LABELS: Record<KpiDataReadiness, string> = {
  READY: 'کامل',
  PARTIAL: 'ناقص',
  NOT_ASSESSED: 'ارزیابی نشده',
};

export function kpiReadinessLabel(readiness: KpiDataReadiness): string {
  return KPI_READINESS_LABELS[readiness] ?? readiness;
}

/** The catalog's own data-quality word — `GREEN`/`YELLOW` are NOT grades of the number. */
export const KPI_QUALITY_CLASSIFICATION_LABELS: Record<KpiDataQualityClass, string> = {
  GREEN: 'سبز',
  YELLOW: 'زرد',
  BLOCKED: 'مسدود',
};

export function kpiQualityClassificationLabel(classification: KpiDataQualityClass): string {
  return KPI_QUALITY_CLASSIFICATION_LABELS[classification] ?? classification;
}

/**
 * The one sentence that keeps a screen from turning a data-quality colour into a verdict.
 * Stated unconditionally: every approved KPI's target and thresholds are `NOT_DEFINED`, so
 * the sentence is true for all five and for as long as the catalogue says so.
 */
export const KPI_PERFORMANCE_NOTE =
  'کیفیت داده به معنای خوب یا بد بودن عملکرد نیست؛ هدف و آستانه برای این شاخص تعریف نشده و عملکرد ارزیابی نشده است.';

/* ————— units ————— */

/**
 * The display token's Persian word, as the screen renders it beside the number.
 * `PERCENT` is the symbol rather than a word, matching the `٪` the reports already print.
 */
export const KPI_DISPLAY_UNIT_LABELS: Record<KpiDisplayUnitToken, string> = {
  HOURS: 'ساعت',
  DAYS: 'روز',
  PERCENT: '٪',
};

export function kpiDisplayUnitLabel(unitToken: KpiDisplayUnitToken): string {
  return KPI_DISPLAY_UNIT_LABELS[unitToken] ?? unitToken;
}

/** The GOVERNED unit the value is stated in — shown when no display conversion exists. */
export const KPI_SEMANTIC_UNIT_LABELS: Record<KpiSemanticUnit, string> = {
  SECONDS: 'ثانیه',
  PERCENT: 'درصد',
};

export function kpiSemanticUnitLabel(unit: KpiSemanticUnit): string {
  return KPI_SEMANTIC_UNIT_LABELS[unit] ?? unit;
}

/* ————— supporting vocabulary (typed `string` on the wire) ————— */

/**
 * The field a period cohorted on — the answer to "which month does this row belong to?".
 * Stated in Persian because it is domain vocabulary a reader must understand to trust the
 * number, not a debug token.
 */
export const KPI_COHORT_FIELD_LABELS: Record<string, string> = {
  decidedAt: 'ماه تصمیم',
  completedAt: 'ماه تکمیل',
  createdAt: 'ماه ایجاد',
};

export function kpiCohortFieldLabel(field: string): string {
  return KPI_COHORT_FIELD_LABELS[field] ?? field;
}

/** The shape of the calculation — stated so a mean and a ratio are never confused. */
export const KPI_FORMULA_KIND_LABELS: Record<string, string> = {
  MEAN_ELAPSED: 'میانگین مدت',
  RATIO_PERCENT: 'نسبت درصدی',
};

export function kpiFormulaKindLabel(kind: string): string {
  return KPI_FORMULA_KIND_LABELS[kind] ?? kind;
}

/** Which domain owns the definition — the source module the value was read from. */
export const KPI_OWNER_CONTEXT_LABELS: Record<string, string> = {
  production: 'تولید',
  commerce: 'تجارت',
  financial: 'مالی',
};

export function kpiOwnerContextLabel(ownerContext: string): string {
  return KPI_OWNER_CONTEXT_LABELS[ownerContext] ?? ownerContext;
}

/* ———— Phase KPI-HISTORICAL-INTELLIGENCE: comparison rendering ———— */

/**
 * The mathematical direction word — NEVER a performance verdict. `INCREASE` is
 * «افزایش», not «بهبود»: every approved target/threshold is `NOT_DEFINED`, so no
 * sentence here may translate a movement into good or bad.
 */
export const KPI_DIRECTION_LABELS: Record<KpiComparisonDirection, string> = {
  INCREASE: 'افزایش',
  DECREASE: 'کاهش',
  UNCHANGED: 'بدون تغییر',
};

export function kpiDirectionLabel(direction: KpiComparisonDirection | null): string | null {
  if (!direction) return null;
  return KPI_DIRECTION_LABELS[direction] ?? direction;
}

/** WHY a comparison is absent — one honest sentence per closed reason. */
export const KPI_COMPARISON_UNAVAILABLE_LABELS: Record<KpiComparisonUnavailableReason, string> = {
  CURRENT_NOT_AVAILABLE: 'بازه فعلی عددی ندارد؛ مقایسه‌ای محاسبه نمی‌شود و صفر گزارش نمی‌شود.',
  PREVIOUS_NOT_AVAILABLE: 'بازه مقایسه عددی ندارد؛ تغییری محاسبه نمی‌شود و صفر گزارش نمی‌شود.',
  BOTH_NOT_AVAILABLE: 'هر دو بازه عددی ندارند؛ مقایسه‌ای وجود ندارد.',
  PREVIOUS_ZERO_RELATIVE_UNAVAILABLE:
    'مقدار بازه مقایسه صفر است؛ تغییر نسبی تعریف نشده و فقط تغییر مطلق نمایش داده می‌شود.',
};

export function kpiComparisonUnavailableLabel(
  reason: KpiComparisonUnavailableReason | null
): string | null {
  if (!reason) return null;
  return KPI_COMPARISON_UNAVAILABLE_LABELS[reason] ?? reason;
}

/** The permanent no-target sentence shown beside every comparison. */
export const KPI_COMPARISON_TARGET_NOTE =
  'این مقدار صرفاً تغییر عددی شاخص را نشان می‌دهد؛ هدف عملکردی برای این شاخص هنوز تعریف نشده است.';

/**
 * The human explanation of one comparison, built ONLY from its own fields.
 *
 * `70% → 80%` renders as «۱۰ واحد درصد افزایش» (percentage POINTS from the server's own
 * `percentagePointChange`) — never the relative `+۱۴٫۲۹٪` — because a rate's business
 * reading is the point delta. Elapsed KPIs render `changeDisplay`, the authorised
 * projection the server already converted; when no projection exists the governed
 * semantic unit is named instead. This function never rounds a governed value and
 * never re-derives a conversion — it only names the two periods and the direction.
 */
export function kpiComparisonSummary(
  comparison: KpiComparison,
  format: (value: number) => string,
  semanticUnitLabel: (semantic: KpiSemanticUnit) => string
): string | null {
  if (comparison.availability !== 'AVAILABLE') return null;

  const current = `${comparison.currentPeriod.monthName} ${format(comparison.currentPeriod.jy)}`;
  const previous = `${comparison.previousPeriod.monthName} ${format(comparison.previousPeriod.jy)}`;
  const word = kpiDirectionLabel(comparison.direction) ?? '';

  const isPercent = comparison.unitSemantic === 'PERCENT';
  const rawDelta = isPercent ? comparison.percentagePointChange : comparison.absoluteChange;
  if (rawDelta === null) return null;
  const magnitude = Math.abs(rawDelta);

  // Percentage POINTS get their own word; every other delta rides the server's
  // authorised display projection (or the governed semantic unit when none exists).
  const deltaText = isPercent
    ? `${format(magnitude)} واحد درصد`
    : comparison.changeDisplay
      ? `${format(comparison.changeDisplay.value)} ${comparison.changeDisplay.unitLabelFa}`
      : `${format(magnitude)} ${semanticUnitLabel(comparison.unitSemantic)}`;

  return `از ${previous} تا ${current}: ${deltaText} ${word}`;
}
