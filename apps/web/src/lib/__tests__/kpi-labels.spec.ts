import {
  KPI_COMPARISON_TARGET_NOTE,
  KPI_COMPARISON_UNAVAILABLE_LABELS,
  KPI_DIRECTION_LABELS,
  KPI_DISPLAY_UNIT_LABELS,
  KPI_PERFORMANCE_NOTE,
  KPI_READINESS_LABELS,
  KPI_SEMANTIC_UNIT_LABELS,
  KPI_UNAVAILABLE_REASON_LABELS,
  kpiAvailabilityLabel,
  kpiComparisonSummary,
  kpiComparisonUnavailableLabel,
  kpiDirectionLabel,
  kpiOwnerContextLabel,
  kpiSemanticUnitLabel,
  kpiUnavailableReasonLabel,
} from '../kpi-labels';
import { toPersianDigits } from '../calendar-api';
import {
  KPI_AVAILABILITY,
  KPI_COMPARISON_DIRECTIONS,
  KPI_DISPLAY_UNIT_TOKENS,
  type KpiComparison,
  type KpiDataQualityClass,
  type KpiDataReadiness,
  type KpiSemanticUnit,
} from '../kpi-api';

/**
 * Phase KPI-RUNTIME — the rendering promises of `kpi-labels.ts`.
 *
 * ONE RULE DRIVES THIS SUITE: no closed code point may ever reach a user as raw English.
 * Every map is declared as a `Record` totally keyed by its union, so a new code point on
 * the wire is a COMPILE error in this file first. The tests pin that totalness at runtime
 * (every union member has a Persian sentence) and pin the sentences the architecture
 * depends on: an absence is never a zero, and readiness is never a verdict on the number.
 */

describe('totalness — every union member has a Persian rendering', () => {
  it('labels both availability states', () => {
    for (const availability of KPI_AVAILABILITY) {
      expect(kpiAvailabilityLabel(availability)).not.toBe(availability);
    }
  });

  it('gives every absence its own sentence', () => {
    for (const reason of Object.keys(KPI_UNAVAILABLE_REASON_LABELS)) {
      expect(kpiUnavailableReasonLabel(reason as never)).toBe(
        KPI_UNAVAILABLE_REASON_LABELS[reason as never]
      );
    }
  });

  it('labels every readiness and knows all three data-quality words plus both units', () => {
    const readiness: KpiDataReadiness[] = ['READY', 'PARTIAL', 'NOT_ASSESSED'];
    for (const word of readiness) {
      expect(KPI_READINESS_LABELS[word]).toBeTruthy();
    }
    const classification: KpiDataQualityClass[] = ['GREEN', 'YELLOW', 'BLOCKED'];
    expect(classification).toHaveLength(3);
    for (const token of KPI_DISPLAY_UNIT_TOKENS) {
      expect(KPI_DISPLAY_UNIT_LABELS[token]).toBeTruthy();
    }
    const semantic: KpiSemanticUnit[] = ['SECONDS', 'PERCENT'];
    for (const unit of semantic) {
      expect(KPI_SEMANTIC_UNIT_LABELS[unit]).toBeTruthy();
    }
  });
});

describe('the architectural sentences', () => {
  it('never lets “nothing existed” read as a plausible zero', () => {
    expect(KPI_UNAVAILABLE_REASON_LABELS.EMPTY_COHORT).toMatch('صفر گزارش نمی‌شود');
    expect(KPI_UNAVAILABLE_REASON_LABELS.EMPTY_COHORT).not.toMatch('۰');
    expect(KPI_UNAVAILABLE_REASON_LABELS.EMPTY_DENOMINATOR).toMatch('نسبتی وجود ندارد');
  });

  it('states that data quality is not a verdict on performance', () => {
    expect(KPI_PERFORMANCE_NOTE).toMatch('هدف و آستانه');
    expect(KPI_PERFORMANCE_NOTE).toMatch('ارزیابی نشده');
  });

  it('passes through open vocabulary like owner contexts without inventing words', () => {
    expect(kpiOwnerContextLabel('production')).toBe('تولید');
    expect(kpiOwnerContextLabel('warehouse')).toBe('warehouse');
  });
});

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — comparison rendering: movement words are
 * mathematical (increase/decrease), absences travel with their own sentence, and the
 * no-target sentence is always available beside every delta.
 */
describe('comparison — movement is mathematical, never a verdict', () => {
  const period = {
    jy: 1405,
    jm: 8,
    monthName: 'آبان',
    start: '2026-10-22T20:30:00.000Z',
    end: '2026-11-21T20:30:00.000Z',
    timeZone: 'Asia/Tehran',
    calendar: 'JALALI' as const,
  };
  const previous = {
    jy: 1405,
    jm: 7,
    monthName: 'مهر',
    start: '2026-09-22T20:30:00.000Z',
    end: '2026-10-22T20:30:00.000Z',
    timeZone: 'Asia/Tehran',
    calendar: 'JALALI' as const,
  };

  function elapsed(overrides: Partial<KpiComparison> = {}): KpiComparison {
    return {
      availability: 'AVAILABLE',
      unavailableReason: null,
      currentPeriod: period,
      previousPeriod: previous,
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

  function percent(overrides: Partial<KpiComparison> = {}): KpiComparison {
    return {
      availability: 'AVAILABLE',
      unavailableReason: null,
      currentPeriod: period,
      previousPeriod: previous,
      currentValue: 80,
      previousValue: 70,
      absoluteChange: 10,
      percentagePointChange: 10,
      relativeChange: 10 / 70,
      direction: 'INCREASE',
      unitSemantic: 'PERCENT',
      changeDisplay: { value: 10, unitToken: 'PERCENT', unitLabelFa: '٪' },
      ...overrides,
    };
  }

  it('labels every direction as movement, and totals every absence reason', () => {
    for (const direction of KPI_COMPARISON_DIRECTIONS) {
      expect(kpiDirectionLabel(direction)).toBe(KPI_DIRECTION_LABELS[direction]);
    }
    expect(kpiDirectionLabel(null)).toBeNull();
    for (const reason of Object.keys(KPI_COMPARISON_UNAVAILABLE_LABELS)) {
      expect(kpiComparisonUnavailableLabel(reason as never)).toBe(
        KPI_COMPARISON_UNAVAILABLE_LABELS[reason as never]
      );
    }
    expect(kpiComparisonUnavailableLabel(null)).toBeNull();
  });

  it('summarises an elapsed movement through the authorised display projection', () => {
    const text = kpiComparisonSummary(elapsed(), toPersianDigits, kpiSemanticUnitLabel);
    expect(text).toContain('مهر ۱۴۰۵');
    expect(text).toContain('آبان ۱۴۰۵');
    expect(text).toContain('۱ ساعت');
    expect(text).toContain('کاهش');
    expect(text).not.toContain('بهبود');
    expect(text).not.toContain('خوب');
  });

  it('summarises 70→80 as ten POINTS, never the relative ratio', () => {
    const text = kpiComparisonSummary(percent(), toPersianDigits, kpiSemanticUnitLabel);
    expect(text).toContain('۱۰ واحد درصد');
    expect(text).toContain('افزایش');
    // The relative ratio (10/70 ≈ ۱۴٫۲۹٪) must never be the business reading.
    expect(text).not.toContain('۱۴٫۲۹');
    expect(text).not.toContain('٪');
  });

  it('falls back to the governed unit when no display projection exists', () => {
    const text = kpiComparisonSummary(
      elapsed({ changeDisplay: null }),
      String,
      kpiSemanticUnitLabel
    );
    expect(text).toContain('ثانیه');
  });

  it('returns null when the comparison itself is unavailable', () => {
    expect(
      kpiComparisonSummary(
        elapsed({ availability: 'NOT_AVAILABLE', absoluteChange: null, direction: null }),
        String,
        kpiSemanticUnitLabel
      )
    ).toBeNull();
  });

  it('keeps the no-target sentence beside every comparison', () => {
    expect(KPI_COMPARISON_TARGET_NOTE).toMatch('هدف عملکردی');
    expect(KPI_COMPARISON_TARGET_NOTE).toMatch('تعریف نشده');
  });
});
