/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the bounded history range resolver.
 * Pure: Jalali month arithmetic + the supporting-report map. No seam, no clock.
 */
import { KPI_HISTORY_MAX_PERIODS } from './kpi-runtime.plan';
import { currentJalaliMonth, isValidKpiPeriod } from './kpi-runtime.period';

export const HISTORY_RANGE_EXCEEDS_LIMIT = 'HISTORY_RANGE_EXCEEDS_LIMIT';
export const HISTORY_INVALID_RANGE = 'HISTORY_INVALID_RANGE';
export const KPI_HISTORY_DEFAULT_PERIODS = 6;

export interface HistoryRangeInput {
  periodCount?: number;
  fromJy?: number;
  fromJm?: number;
  toJy?: number;
  toJm?: number;
}

export function previousJalaliMonth(jy: number, jm: number): { jy: number; jm: number } {
  return jm === 1 ? { jy: jy - 1, jm: 12 } : { jy, jm: jm - 1 };
}

export function nextJalaliMonth(jy: number, jm: number): { jy: number; jm: number } {
  return jm === 12 ? { jy: jy + 1, jm: 1 } : { jy, jm: jm + 1 };
}

function compareMonths(a: { jy: number; jm: number }, b: { jy: number; jm: number }): number {
  if (a.jy !== b.jy) return a.jy < b.jy ? -1 : 1;
  if (a.jm !== b.jm) return a.jm < b.jm ? -1 : 1;
  return 0;
}

/** Months from `from` to `to` inclusive, oldest first. Throws on invalid input. */
export function resolveHistoryMonths(
  input: HistoryRangeInput,
  now: Date = new Date()
): { jy: number; jm: number }[] {
  const hasExplicitRange =
    input.fromJy !== undefined ||
    input.fromJm !== undefined ||
    input.toJy !== undefined ||
    input.toJm !== undefined;
  if (hasExplicitRange) {
    const current = currentJalaliMonth(now);
    const from = { jy: input.fromJy ?? current.jy, jm: input.fromJm ?? current.jm };
    const to = { jy: input.toJy ?? current.jy, jm: input.toJm ?? current.jm };
    if (!isValidKpiPeriod(from.jy, from.jm) || !isValidKpiPeriod(to.jy, to.jm)) {
      throw Object.assign(new Error('Invalid KPI history range.'), {
        code: HISTORY_INVALID_RANGE,
      });
    }
    if (compareMonths(from, to) > 0) {
      throw Object.assign(new Error('Invalid KPI history range.'), {
        code: HISTORY_INVALID_RANGE,
      });
    }
    const months: { jy: number; jm: number }[] = [];
    let cursor = { ...from };
    for (;;) {
      months.push({ ...cursor });
      if (months.length > KPI_HISTORY_MAX_PERIODS) {
        throw Object.assign(new Error('KPI history range exceeds limit.'), {
          code: HISTORY_RANGE_EXCEEDS_LIMIT,
        });
      }
      if (compareMonths(cursor, to) === 0) return months;
      cursor = nextJalaliMonth(cursor.jy, cursor.jm);
    }
  }
  const periodCount = input.periodCount ?? KPI_HISTORY_DEFAULT_PERIODS;
  if (!Number.isInteger(periodCount) || periodCount < 2) {
    throw Object.assign(new Error('Invalid KPI history period count.'), {
      code: HISTORY_INVALID_RANGE,
    });
  }
  if (periodCount > KPI_HISTORY_MAX_PERIODS) {
    throw Object.assign(new Error('KPI history range exceeds limit.'), {
      code: HISTORY_RANGE_EXCEEDS_LIMIT,
    });
  }
  const anchor = currentJalaliMonth(now);
  const months: { jy: number; jm: number }[] = [{ ...anchor }];
  let cursor = { ...anchor };
  for (let i = 1; i < periodCount; i += 1) {
    cursor = previousJalaliMonth(cursor.jy, cursor.jm);
    months.unshift({ ...cursor });
  }
  return months;
}

/** Supporting report route per KPI key, or null when none is safely mappable. */
export function supportingReportFor(technicalKey: string): {
  href: string;
  titleFa: string;
} | null {
  if (technicalKey.startsWith('production-bom-')) {
    return { href: '/admin/reporting/production', titleFa: 'گزارش عملیات تولید' };
  }
  if (technicalKey.startsWith('commerce-purchase-')) {
    return { href: '/admin/reporting/purchase-requests', titleFa: 'گزارش درخواست‌های خرید' };
  }
  if (technicalKey === 'financial-check-request-decision-time') {
    return { href: '/admin/reporting', titleFa: 'گزارش درخواست‌های صدور چک' };
  }
  return null;
}
