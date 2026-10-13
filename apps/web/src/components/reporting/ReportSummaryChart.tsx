'use client';

import { isReportChartEmpty, type ReportChartBucket } from '@/lib/report-chart';
import { toPersianDigits } from '@/lib/calendar-api';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the ONE report visualization — a horizontal bar
 * rendering of the report's own server summary, used by all four reporting screens.
 *
 * WHAT IT IS: bars over the SAME counts the summary strip shows (arranged by the
 * shared report-chart helper from `summary`), in the SAME vocabulary order, with the
 * SAME labels — so the chart can never disagree with the strip or the table. No chart
 * library was admitted: four denominators do not justify one (`aria-code-and-
 * architecture` reached the same decision for the two mock screens it charts in raw
 * primitives), and a hand-rolled RTL bar needs no axis engine to stay readable.
 *
 * TRUTHFULNESS RULES, ENFORCED BY TEST:
 *  * an all-zero summary renders an EMPTY MESSAGE, never a bare axis or fake zeros;
 *  * a value that is 0 still renders its row — «nothing in this state» is information,
 *    and hiding the row would be the chart lying by omission;
 *  * bars are proportional to the LARGEST bucket (per-bucket share is NOT a rate the
 *    domain sanctioned — only a visual proportion of siblings);
 *  * meaning travels in TEXT: every row carries its Persian label and its Persian-digit
 *    count as real text, so colour is decoration, hover never gates information, and
 *    the table below stays the detailed accessible counterpart.
 *
 * LAYOUT: `dir=rtl` inherited bars growing from the right, label column sized to the
 * longest word so nothing truncates, the track full-width so mobile and desktop read
 * identically, `tabular-nums` counts that never jitter the row.
 */
export function ReportSummaryChart({
  title,
  testId,
  buckets,
}: {
  /** The chart heading, e.g. «توزیع وضعیت» — the one sentence the figure needs. */
  title: string;
  /** Test-id stem for the figure and its rows. */
  testId: string;
  buckets: ReportChartBucket[];
}) {
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  if (isReportChartEmpty(buckets)) {
    return (
      <section
        data-testid={`${testId}-chart`}
        aria-label={title}
        className="rounded-2xl border border-border bg-card p-4"
      >
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p data-testid={`${testId}-chart-empty`} className="mt-2 text-sm text-muted-foreground">
          برای نمایش نمودار، داده‌ای در این محدوده وجود ندارد.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid={`${testId}-chart`}
      aria-label={title}
      className="rounded-2xl border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground">
        {title}
        <span className="ms-2 text-xs font-normal text-muted-foreground">
          (مجموع: {toPersianDigits(total)})
        </span>
      </h3>
      <ul className="mt-3 space-y-2.5">
        {buckets.map((bucket) => (
          <li
            key={bucket.key}
            data-testid={`${testId}-chart-row-${bucket.key}`}
            className="flex items-center gap-3"
          >
            <span className="w-36 shrink-0 truncate text-xs text-foreground sm:w-44">
              {bucket.label}
            </span>
            <span
              aria-hidden="true"
              className="relative h-5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <span
                data-testid={`${testId}-chart-bar-${bucket.key}`}
                className="absolute inset-y-0 right-0 rounded-full bg-primary/70 transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, (bucket.count / maximum) * 100))}%` }}
              />
            </span>
            <span
              data-testid={`${testId}-chart-count-${bucket.key}`}
              className="w-12 shrink-0 text-start text-xs tabular-nums text-muted-foreground"
            >
              {toPersianDigits(bucket.count)}
            </span>
          </li>
        ))}
      </ul>
      <p className="sr-only">
        {buckets.map((bucket) => `${bucket.label}: ${bucket.count}`).join('، ')}
      </p>
    </section>
  );
}
