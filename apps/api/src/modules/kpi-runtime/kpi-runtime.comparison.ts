/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — pure period-over-period comparison.
 * Arithmetic over two governed values; never a re-read, never rounded.
 */
import type { KpiResult } from './kpi-runtime.contract';
import { toDisplay } from './kpi-runtime.display';

export const KPI_COMPARISON_AVAILABILITY = ['AVAILABLE', 'NOT_AVAILABLE'] as const;
export type KpiComparisonAvailability = (typeof KPI_COMPARISON_AVAILABILITY)[number];

export const KPI_COMPARISON_UNAVAILABLE_REASONS = [
  'CURRENT_NOT_AVAILABLE',
  'PREVIOUS_NOT_AVAILABLE',
  'BOTH_NOT_AVAILABLE',
  'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
] as const;
export type KpiComparisonUnavailableReason = (typeof KPI_COMPARISON_UNAVAILABLE_REASONS)[number];

export const KPI_COMPARISON_DIRECTIONS = ['INCREASE', 'DECREASE', 'UNCHANGED'] as const;
export type KpiComparisonDirection = (typeof KPI_COMPARISON_DIRECTIONS)[number];

export interface KpiComparison {
  availability: KpiComparisonAvailability;
  unavailableReason: KpiComparisonUnavailableReason | null;
  currentPeriod: KpiResult['period'];
  previousPeriod: KpiResult['period'];
  currentValue: number | null;
  previousValue: number | null;
  absoluteChange: number | null;
  percentagePointChange: number | null;
  relativeChange: number | null;
  direction: KpiComparisonDirection | null;
  unitSemantic: KpiResult['unit']['semantic'];
  /**
   * The authorised display projection of the PRIMARY delta — points for `PERCENT`
   * KPIs, the absolute change otherwise — through the SAME `toDisplay` the current
   * value uses. `null` when no projection is authorised (or not comparable), so a
   * screen renders the governed semantic unit instead of converting anything itself.
   */
  changeDisplay: {
    value: number;
    unitToken: NonNullable<KpiResult['display']>['unitToken'];
    unitLabelFa: string;
  } | null;
}

export function buildKpiComparison(current: KpiResult, previous: KpiResult): KpiComparison {
  const currentValue = current.availability === 'AVAILABLE' ? current.value : null;
  const previousValue = previous.availability === 'AVAILABLE' ? previous.value : null;
  const base = {
    currentPeriod: current.period,
    previousPeriod: previous.period,
    currentValue,
    previousValue,
    unitSemantic: current.unit.semantic,
  } as const;

  /**
   * The ONE authorised delta projection: percentage POINTS for a rate, the absolute
   * change otherwise — through the same `toDisplay` the current value uses, on the
   * SAME governed presentation. `null` when no conversion is authorised or when the
   * comparison itself is unavailable (there is no delta to convert).
   */
  const changeDisplayOf = (
    delta: number | null,
    presentation: string,
    semantic: KpiResult['unit']['semantic']
  ): KpiComparison['changeDisplay'] => {
    if (delta === null) return null;
    const projected = toDisplay(Math.abs(delta), semantic, presentation);
    return projected
      ? {
          value: projected.value,
          unitToken: projected.unitToken,
          unitLabelFa: projected.unitLabelFa,
        }
      : null;
  };

  const absent = (reason: KpiComparisonUnavailableReason): KpiComparison => ({
    ...base,
    availability: 'NOT_AVAILABLE',
    unavailableReason: reason,
    absoluteChange: null,
    percentagePointChange: null,
    relativeChange: null,
    direction: null,
    changeDisplay: null,
  });
  if (currentValue === null && previousValue === null) return absent('BOTH_NOT_AVAILABLE');
  if (currentValue === null) return absent('CURRENT_NOT_AVAILABLE');
  if (previousValue === null) return absent('PREVIOUS_NOT_AVAILABLE');
  const absoluteChange = currentValue - previousValue;
  const direction: KpiComparisonDirection =
    absoluteChange > 0 ? 'INCREASE' : absoluteChange < 0 ? 'DECREASE' : 'UNCHANGED';
  const isPercent = current.unit.semantic === 'PERCENT';
  const changeDisplay = changeDisplayOf(
    absoluteChange,
    current.unit.presentation,
    current.unit.semantic
  );
  if (previousValue === 0) {
    return {
      ...base,
      availability: 'AVAILABLE',
      unavailableReason: 'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
      absoluteChange,
      percentagePointChange: isPercent ? absoluteChange : null,
      relativeChange: null,
      direction,
      changeDisplay,
    };
  }
  return {
    ...base,
    availability: 'AVAILABLE',
    unavailableReason: null,
    absoluteChange,
    percentagePointChange: isPercent ? absoluteChange : null,
    relativeChange: absoluteChange / previousValue,
    direction,
    changeDisplay,
  };
}
