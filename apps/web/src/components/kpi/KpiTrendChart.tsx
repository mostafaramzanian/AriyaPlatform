'use client';

import { toPersianDigits } from '@/lib/calendar-api';
import type { KpiResult } from '@/lib/kpi-api';
import { kpiSemanticUnitLabel } from '@/lib/kpi-labels';

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the KPI trend chart: a dependency-free SVG line
 * over the GOVERNED history the server computed, one point per month.
 *
 * THE FOUR TRUTHFULNESS RULES, EACH ENFORCED BY TEST:
 *  * exact values only — every plotted point is a `KpiResult.value` (its authorised
 *    display projection when the catalogue named one), never a rounded re-derivation,
 *    never an interpolated figure;
 *  * unavailable months BREAK the line — a gap with its own marker and a table row
 *    saying «در دسترس نیست». No zero, no smoothing, no fabricated segment;
 *  * chronological order is preserved in the RTL reading direction: the OLDEST period
 *    sits at the right edge and the newest at the left, so the eye travels forward
 *    through time the way it travels forward through the page;
 *  * the chart is never the only representation — the table below carries every
 *    period, its exact value and its availability as real text, and the figcaption
 *    summarises the whole series for a screen reader.
 *
 * NO COLOUR MEANS PERFORMANCE. The line uses the brand/foreground palette; there is no
 * green-for-good or red-for-bad anywhere, because every approved target and threshold
 * is `NOT_DEFINED` and a performance colour would be an invented verdict.
 */

const WIDTH = 640;
const HEIGHT = 260;
const PAD_RIGHT = 76;
const PAD_LEFT = 72;
const PAD_TOP = 28;
const PAD_BOTTOM = 52;

/** Display rounding is the SCREEN's job; the governed value stays untouched server-side. */
function roundForDisplay(value: number): number {
  return Math.round(value * 100) / 100;
}

interface TrendPoint {
  period: KpiResult['period'];
  /** The exact plotted number, or null when this month has no value. */
  value: number | null;
  /** The unit word shown beside the value. */
  unitLabel: string;
}

function trendPoints(items: readonly KpiResult[]): TrendPoint[] {
  return items.map((item) => {
    const label = item.display
      ? item.display.unitLabelFa
      : kpiSemanticUnitLabel(item.unit.semantic);
    return {
      period: item.period,
      value: item.display ? item.display.value : item.value,
      unitLabel: label,
    };
  });
}

export function KpiTrendChart({
  title,
  testId,
  items,
}: {
  /** The figure heading, e.g. «روند ماهانه شاخص». */
  title: string;
  testId: string;
  /** Chronological `KpiResult[]` (oldest first), straight from the history endpoint. */
  items: readonly KpiResult[];
}) {
  const points = trendPoints(items);
  if (points.length === 0) return null;

  const values = points.filter(
    (point): point is TrendPoint & { value: number } => point.value !== null
  );
  const unitLabel = points.find((point) => point.value !== null)?.unitLabel ?? '';
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;

  const rangeLabel = `${first.period.monthName} ${toPersianDigits(first.period.jy)} تا ${last.period.monthName} ${toPersianDigits(last.period.jy)}`;
  const summary =
    values.length === 0
      ? `روند ${title} از ${rangeLabel}: در هیچ ماهی مقداری در دسترس نیست.`
      : `روند ${title} از ${rangeLabel}: ${toPersianDigits(values.length)} ماه دارای مقدار از ${toPersianDigits(points.length)} ماه.`;

  // Geometry: index 0 (oldest) maps to the RIGHT edge — RTL time flows right-to-left.
  const plotWidth = WIDTH - PAD_RIGHT - PAD_LEFT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const xOf = (index: number) => WIDTH - PAD_RIGHT - index * step;

  let yMin = 0;
  let yMax = 1;
  if (values.length > 0) {
    const raw = values.map((point) => point.value);
    const min = Math.min(...raw);
    const max = Math.max(...raw);
    const pad = min === max ? (Math.abs(min) || 1) * 0.1 : (max - min) * 0.15;
    yMin = min - pad;
    yMax = max + pad;
  }
  const yOf = (value: number) => PAD_TOP + ((yMax - value) / (yMax - yMin)) * plotHeight;

  // Line segments: runs of CONSECUTIVE available points, broken by every gap.
  const segments: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    run.push({ x: xOf(index), y: yOf(point.value) });
  });
  // The tail run has no following gap to flush it — a series ending in a value
  // is exactly the case every all-available history hits.
  if (run.length > 0) segments.push(run);
  const axisTicks =
    values.length > 0
      ? [yMin + (yMax - yMin) * 0.05, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.05]
      : [];

  return (
    <figure className="rounded-2xl border border-border bg-card p-4" data-testid={testId}>
      <figcaption className="text-sm font-semibold text-foreground">
        {title}
        <span className="ms-2 text-xs font-normal text-muted-foreground">
          {unitLabel ? `واحد: ${unitLabel}` : ''}
        </span>
      </figcaption>

      <svg
        role="img"
        aria-label={summary}
        data-testid={`${testId}-svg`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-3 h-56 w-full text-muted-foreground"
        preserveAspectRatio="xMidYMid meet"
      >
        {axisTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yOf(tick)}
              y2={yOf(tick)}
              className="stroke-border"
              strokeDasharray="3 4"
            />
            <text
              x={WIDTH - PAD_RIGHT + 8}
              y={yOf(tick) + 4}
              className="fill-muted-foreground"
              fontSize="11"
              textAnchor="start"
            >
              {toPersianDigits(roundForDisplay(tick))}
            </text>
          </g>
        ))}

        {/* Every unavailable month: a dashed guide and an em dash — never a zero point. */}
        {points.map((point, index) =>
          point.value === null ? (
            <g key={`gap-${point.period.jy}-${point.period.jm}`}>
              <line
                data-testid={`${testId}-gap-${point.period.jy}-${point.period.jm}`}
                x1={xOf(index)}
                x2={xOf(index)}
                y1={PAD_TOP}
                y2={PAD_TOP + plotHeight}
                className="stroke-border"
                strokeDasharray="2 5"
              />
              <text
                x={xOf(index)}
                y={PAD_TOP + plotHeight / 2}
                className="fill-muted-foreground"
                fontSize="16"
                textAnchor="middle"
              >
                —
              </text>
            </g>
          ) : null
        )}

        {segments.map((segment, index) =>
          segment.length > 1 ? (
            <polyline
              key={`segment-${index}`}
              data-testid={`${testId}-segment-${index}`}
              points={segment.map((node) => `${node.x},${node.y}`).join(' ')}
              className="fill-none stroke-primary"
              strokeWidth="2"
            />
          ) : null
        )}

        {points.map((point, index) =>
          point.value === null ? null : (
            <g key={`point-${point.period.jy}-${point.period.jm}`}>
              <circle
                data-testid={`${testId}-point-${point.period.jy}-${point.period.jm}`}
                cx={xOf(index)}
                cy={yOf(point.value)}
                r="4"
                className="fill-primary"
              />
              <title>{`${point.period.monthName} ${toPersianDigits(point.period.jy)}: ${toPersianDigits(roundForDisplay(point.value))} ${point.unitLabel}`}</title>
            </g>
          )
        )}

        {points.map((point, index) => (
          <text
            key={`label-${point.period.jy}-${point.period.jm}`}
            x={xOf(index)}
            y={HEIGHT - PAD_BOTTOM + 20}
            className="fill-muted-foreground"
            fontSize="10"
            textAnchor="middle"
          >
            {point.period.monthName}
          </text>
        ))}
      </svg>

      {/* The chart is never the only representation — every period as real text. */}
      <table className="mt-3 w-full text-start text-xs" data-testid={`${testId}-table`}>
        <caption className="sr-only">{summary}</caption>
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="py-1 text-start font-medium">
              بازه
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              مقدار
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              وضعیت
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr
              key={`row-${point.period.jy}-${point.period.jm}`}
              data-testid={`${testId}-row-${point.period.jy}-${point.period.jm}`}
              className="border-b border-border last:border-b-0"
            >
              <td className="py-1.5 text-foreground">
                {point.period.monthName} {toPersianDigits(point.period.jy)}
                {point.period.completed === false ? ' (در جریان)' : ''}
              </td>
              <td className="py-1.5 text-foreground">
                {point.value === null
                  ? '—'
                  : `${toPersianDigits(roundForDisplay(point.value))} ${point.unitLabel}`}
              </td>
              <td className="py-1.5 text-muted-foreground">
                {point.value === null ? 'در دسترس نیست' : 'محاسبه شده'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        ماه‌های بدون مقدار با خط‌چین و نشان «—» نمایش داده می‌شوند؛ هرگز با صفر جایگزین نمی‌شوند.
      </p>
    </figure>
  );
}
