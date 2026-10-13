/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the pure comparison contract.
 * Two governed values in, one closed comparison out. No seam, no clock.
 */
import { buildKpiComparison } from './kpi-runtime.comparison';
import type { KpiResult } from './kpi-runtime.contract';

function result(overrides: Partial<KpiResult> = {}): KpiResult {
  return {
    id: 'KPI-001',
    technicalKey: 'production-bom-decision-cycle-time',
    nameFa: 'x',
    nameEn: 'x',
    businessQuestion: 'x',
    definition: 'x',
    ownerContext: 'production',
    availability: 'AVAILABLE',
    unavailableReason: null,
    value: 100,
    unit: { semantic: 'SECONDS', presentation: 'Hours (…)' },
    display: null,
    period: {
      jy: 1405,
      jm: 8,
      monthName: 'آبان',
      start: '2026-10-22T20:30:00.000Z',
      end: '2026-11-21T20:30:00.000Z',
      timeZone: 'Asia/Tehran',
      calendar: 'JALALI',
    },
    quality: {
      classification: 'GREEN',
      readiness: 'READY',
      meaning: 'DATA_READINESS',
      notes: [],
    },
    interpretation: {
      usage: 'DESCRIPTIVE_ONLY',
      performance: 'NOT_ASSESSED',
      performanceBasis: 'TARGET_AND_THRESHOLD_NOT_DEFINED',
      targetState: 'NOT_DEFINED',
      thresholdState: 'NOT_DEFINED',
    },
    supportingContext: {
      population: 'x',
      exclusions: 'x',
      cohortField: 'decidedAt',
      counts: { cohort: 1, valid: 1, excluded: 0 },
      readLimit: 5000,
      evidence: [],
      knownLimitations: [],
    },
    governance: {
      readRemit: 'production.bom.read',
      moduleEntitlement: 'production',
      featureEntitlement: 'bom',
      formulaKind: 'MEAN_ELAPSED',
      newPermissionRequired: false,
    },
    ...overrides,
  } as KpiResult;
}

describe('KPI comparison — elapsed values use absolute and relative change', () => {
  it('answers absolute and relative change on exact governed values', () => {
    const out = buildKpiComparison(result({ value: 120 }), result({ value: 100 }));
    expect(out.availability).toBe('AVAILABLE');
    expect(out.absoluteChange).toBe(20);
    expect(out.relativeChange).toBeCloseTo(0.2, 12);
    expect(out.percentagePointChange).toBeNull();
    expect(out.direction).toBe('INCREASE');
    // The authorised delta projection: 20 seconds → the Hours presentation's own factor.
    expect(out.changeDisplay).toEqual({
      value: 20 / 3600,
      unitToken: 'HOURS',
      unitLabelFa: 'ساعت',
    });
  });

  it('refuses the ratio when previous is zero but keeps the absolute delta', () => {
    const out = buildKpiComparison(result({ value: 50 }), result({ value: 0 }));
    expect(out.availability).toBe('AVAILABLE');
    expect(out.absoluteChange).toBe(50);
    expect(out.relativeChange).toBeNull();
    expect(out.unavailableReason).toBe('PREVIOUS_ZERO_RELATIVE_UNAVAILABLE');
  });
});

describe('KPI comparison — percentage KPIs prefer point change', () => {
  const percent = (value: number | null) =>
    result({
      value,
      unit: { semantic: 'PERCENT', presentation: 'Percent 0–100' },
      availability: value === null ? 'NOT_AVAILABLE' : 'AVAILABLE',
      unavailableReason: value === null ? 'EMPTY_COHORT' : null,
    });
  it('states 70 to 80 as +10 points beside the relative ratio', () => {
    const out = buildKpiComparison(percent(80), percent(70));
    expect(out.percentagePointChange).toBeCloseTo(10, 12);
    expect(out.relativeChange).toBeCloseTo(10 / 70, 12);
    expect(out.direction).toBe('INCREASE');
  });
});

describe('KPI comparison — unavailable sides are never subtracted', () => {
  it('marks each absence with its own reason', () => {
    const gone = result({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });
    expect(buildKpiComparison(gone, result()).unavailableReason).toBe('CURRENT_NOT_AVAILABLE');
    expect(buildKpiComparison(result(), gone).unavailableReason).toBe('PREVIOUS_NOT_AVAILABLE');
    expect(buildKpiComparison(gone, gone).unavailableReason).toBe('BOTH_NOT_AVAILABLE');
  });
});
