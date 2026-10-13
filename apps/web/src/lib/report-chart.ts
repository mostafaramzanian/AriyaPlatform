/**
 * Phase REPORTING-VISUALIZATION-EXPORT: one wording-free, dependency-free helper that
 * turns a report's server summary into an ordered set of chart buckets.
 *
 * WHY A HELPER AND NOT RENDER-TO-SUMMARY LOGIC IN EVERY SCREEN. All four reports answer
 * `summary = { total, <Record<string, number>> }` computed over the SAME filtered
 * population as their tables, and all four screens must show the SAME truth in three
 * places — the strip, the bars and the accessible list. Reading the summary through one
 * function means a bucket can never be counted client-side, reordered by accident or
 * dropped when it is zero: the database answered, this function only arranges.
 *
 * NOTHING HERE IS A BUSINESS RULE. Keys come from the closed vocabulary each report
 * declares (`REPORTING_*` tuples the screens already read); unknown keys the summary
 * carries anyway are kept at the end with their raw token as the label — shown honestly,
 * never invented, never hidden.
 */
export interface ReportChartBucket {
  /** The machine key the summary counted (`APPROVED`, `MANUAL`, `2`, …). */
  key: string;
  /** The Persian word the product already uses for it on the screen. */
  label: string;
  /** The database count for that key over the current filters — zero is a real answer. */
  count: number;
}

/**
 * Buckets in VOCABULARY order (the strip's own order), with any unlisted key appended
 * raw at the end. A missing key reads as 0 rather than failing the render: the summary
 * is zero-filled by contract, and the chart must be too.
 */
export function buildReportChartBuckets(
  counts: Record<string, number>,
  order: readonly (string | number)[],
  label: (key: string) => string
): ReportChartBucket[] {
  const normalized = order.map((member) => String(member));
  const buckets = normalized.map((key) => ({
    key,
    label: label(key),
    count: typeof counts[key] === 'number' ? counts[key] : 0,
  }));

  for (const key of Object.keys(counts)) {
    if (!normalized.includes(key)) {
      buckets.push({ key, label: label(key), count: counts[key] });
    }
  }

  return buckets;
}

/** True when there is NOTHING to draw — the truthful empty state, not a fake zero axis. */
export function isReportChartEmpty(buckets: readonly ReportChartBucket[]): boolean {
  return buckets.every((bucket) => bucket.count === 0);
}
