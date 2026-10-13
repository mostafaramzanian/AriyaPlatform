import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import type { KpiComparison, KpiHistoryResult, KpiListResult, KpiResult } from '@/lib/kpi-api';

/**
 * Phase KPI-RUNTIME — the shared fixture both KPI screen specs read from.
 *
 * WHY A FILE RATHER THAN A HELPER PER SPEC: the `KpiResult` shape has thirty-odd fields in
 * six groups, and two specs each hand-rolling it is two places for one of them to drift from
 * `kpi-runtime.contract.ts`. One builder means a contract change shows up as a type error in
 * exactly one place — the same reason `hr-fixtures.ts` exists.
 *
 * The `grant`/`authState` helpers INSTALL the value into the module mocks rather than merely
 * building it. Both specs `jest.mock` the two hooks, so an uninstalled state leaves the
 * component destructuring `undefined` — a failure that reads like a component bug and is
 * really a test bug. Installing here is what makes that class of mistake impossible.
 */

/** Aban 1405 — the month every fixture KPI is cohorted on. */
export const PERIOD: KpiResult['period'] = {
  jy: 1405,
  jm: 8,
  monthName: 'آبان',
  start: '2026-10-22T20:30:00.000Z',
  end: '2026-11-21T20:30:00.000Z',
  timeZone: 'Asia/Tehran',
  calendar: 'JALALI',
};

/** One APPROVED-shaped result; every field the contract requires, overridable per test. */
export function kpi(overrides: Partial<KpiResult> = {}): KpiResult {
  return {
    id: 'KPI-001',
    technicalKey: 'production-bom-decision-cycle-time',
    nameFa: 'زمان چرخه تصمیم فهرست مواد',
    nameEn: 'BOM decision cycle time',
    businessQuestion: 'چقدر طول می‌کشد تا یک فهرست مواد تصمیم بگیرد؟',
    definition: 'میانگین فاصله میان ارجاع و تصمیم نهایی در ماه شمسی.',
    ownerContext: 'production',
    availability: 'AVAILABLE',
    unavailableReason: null,
    value: 32_400,
    unit: { semantic: 'SECONDS', presentation: 'Hours (…)' },
    display: { value: 9, unitToken: 'HOURS', unitLabelFa: 'ساعت' },
    period: PERIOD,
    quality: {
      classification: 'YELLOW',
      readiness: 'PARTIAL',
      meaning: 'DATA_READINESS',
      notes: ['تصمیم نهایی در دور دوم ثبت می‌شود.'],
    },
    interpretation: {
      usage: 'DESCRIPTIVE_ONLY',
      performance: 'NOT_ASSESSED',
      performanceBasis: 'TARGET_AND_THRESHOLD_NOT_DEFINED',
      targetState: 'NOT_DEFINED',
      thresholdState: 'NOT_DEFINED',
    },
    supportingContext: {
      population: 'فهرست‌های مواد ارجاع‌شده در ماه.',
      exclusions: 'فهرست‌های بدون تصمیم.',
      cohortField: 'decidedAt',
      counts: { cohort: 4, valid: 3, excluded: 1 },
      readLimit: 5000,
      evidence: ['لاگ تصمیمات سامانه'],
      knownLimitations: ['تصمیم نهایی در دور دوم ثبت می‌شود.'],
    },
    governance: {
      readRemit: 'production.bom.read',
      moduleEntitlement: 'production',
      featureEntitlement: 'reporting',
      formulaKind: 'MEAN_ELAPSED',
      newPermissionRequired: false,
    },
    ...overrides,
  };
}

/** The `GET /kpis` envelope around a set of results. */
export function list(
  items: KpiResult[],
  total = 5,
  overrides: Partial<Omit<KpiListResult, 'items' | 'total' | 'visible'>> = {}
): KpiListResult {
  const comparisons: Record<string, KpiComparison | null> = {};
  for (const item of items) {
    if (item.availability !== 'AVAILABLE' || item.value === null) {
      comparisons[item.technicalKey] = comparison({
        availability: 'NOT_AVAILABLE',
        unavailableReason: 'CURRENT_NOT_AVAILABLE',
        currentValue: null,
        previousValue: null,
        absoluteChange: null,
        relativeChange: null,
        direction: null,
        changeDisplay: null,
      });
      continue;
    }
    const previous = item.value + 3600;
    const delta = item.value - previous;
    comparisons[item.technicalKey] = comparison({
      currentValue: item.value,
      previousValue: previous,
      absoluteChange: delta,
      relativeChange: delta / previous,
      direction: delta < 0 ? 'DECREASE' : delta > 0 ? 'INCREASE' : 'UNCHANGED',
      unitSemantic: item.unit.semantic,
      // The fixture mirrors the server contract: the display delta is the MAGNITUDE,
      // already converted — never a signed raw number. The summary reads the direction
      // word, not the sign of this field.
      changeDisplay: item.display
        ? { value: Math.abs(delta) / 3600, unitToken: 'HOURS', unitLabelFa: 'ساعت' }
        : null,
    });
  }
  return {
    period: PERIOD,
    previousPeriod: PREVIOUS_PERIOD,
    items,
    comparisons,
    total,
    visible: items.length,
    ...overrides,
  };
}

/** Mehr 1405 — the month every fixture comparison measures against. */
export const PREVIOUS_PERIOD: KpiResult['period'] = {
  jy: 1405,
  jm: 7,
  monthName: 'مهر',
  start: '2026-09-23T20:30:00.000Z',
  end: '2026-10-22T20:30:00.000Z',
  timeZone: 'Asia/Tehran',
  calendar: 'JALALI',
  completed: true,
};

/** One server-computed period comparison; overridable per test. */
export function comparison(overrides: Partial<KpiComparison> = {}): KpiComparison {
  return {
    availability: 'AVAILABLE',
    unavailableReason: null,
    currentPeriod: PERIOD,
    previousPeriod: PREVIOUS_PERIOD,
    currentValue: 32_400,
    previousValue: 36_000,
    absoluteChange: -3_600,
    percentagePointChange: null,
    relativeChange: -0.1,
    direction: 'DECREASE',
    unitSemantic: 'SECONDS',
    changeDisplay: { value: 1, unitToken: 'HOURS', unitLabelFa: 'ساعت' },
    ...overrides,
  };
}

/** The `GET /kpis/:key/history` envelope: the three most recent months, oldest first. */
export function history(
  overrides: Partial<KpiHistoryResult> = {},
  buildItem: (jy: number, jm: number, value: number | null) => KpiResult = (jy, jm, value) =>
    kpi({
      value,
      availability: value === null ? 'NOT_AVAILABLE' : 'AVAILABLE',
      unavailableReason: value === null ? 'EMPTY_COHORT' : null,
      display:
        value === null ? null : { value: value / 3600, unitToken: 'HOURS', unitLabelFa: 'ساعت' },
      period: {
        jy,
        jm,
        monthName: jm === 8 ? 'آبان' : jm === 7 ? 'مهر' : 'شهریور',
        start: '',
        end: '',
        timeZone: 'Asia/Tehran',
        calendar: 'JALALI',
        completed: true,
      },
    })
): KpiHistoryResult {
  const items = [
    buildItem(1405, 6, 36_000),
    buildItem(1405, 7, 39_600),
    buildItem(1405, 8, 32_400),
  ];
  return {
    id: 'KPI-001',
    technicalKey: 'production-bom-decision-cycle-time',
    nameFa: 'زمان چرخه تصمیم فهرست مواد',
    nameEn: 'BOM decision cycle time',
    periods: items.map((item) => item.period),
    items,
    comparison: comparison(),
    supportingReport: { href: '/admin/reporting/production', titleFa: 'گزارش عملیات تولید' },
    ...overrides,
  };
}

/**
 * Install a permission set into the mocked `useCorePermissions`.
 *
 * Presentation-only by contract: the backend re-asks the same question behind
 * `@Roles(...KPI_READ_REMITS)` and its 403 stays decisive, so these strings decide only
 * whether a request is ISSUED.
 */
export function grant(permissions: string[], isLoading = false): void {
  (useCorePermissions as unknown as jest.Mock).mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

/**
 * Install an authenticated (or anonymous) state into the mocked `useAuth`.
 *
 * It INSTALLS rather than merely returning: a state nobody puts in the mock leaves the
 * component destructuring `undefined`, which fails as a component error and misdirects the
 * reader. Every spec calls this before `render`.
 */
export function authState(user: { userId?: string } | null = { userId: 'u-1' }): void {
  (useAuth as unknown as jest.Mock).mockReturnValue({
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  });
}
