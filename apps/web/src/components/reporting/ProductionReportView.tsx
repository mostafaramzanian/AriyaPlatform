'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchProductionReport,
  productionReportExportPath,
  PRODUCTION_REPORT_PAGE_SIZE,
  PRODUCTION_REPORT_STATUSES,
  type ProductionReportStatus,
  type ReportingProductionPage,
  type ReportingProductionReportQuery,
} from '@/lib/production-report-api';
import type { ProductionBomStatus } from '@/lib/production-api';
import {
  productionBomStatusLabel,
  productionBomStatusTone,
  productionDateLabel,
  productionManagerOpinionLabel,
  type ProductionTone,
} from '@/lib/production-labels';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';
import { buildReportChartBuckets } from '@/lib/report-chart';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the third Reporting workspace —
 * «گزارش خلاصه و وضعیت عملیات تولید» at `/admin/reporting/production`.
 *
 * WHAT THIS SCREEN IS: a READ-ONLY analytical surface over Production truth.
 * Structure, top to bottom (the same seven steps the first two reports established):
 *
 *   page heading (h2 — the shell header owns the document's h1)
 *        ↓
 *   report identity (h3) + one explanation sentence
 *        ↓
 *   filter bar — exactly the two source-supported filters: وضعیت + جستجو
 *        ↓
 *   summary strip — per-status counts over the SAME filtered population
 *        ↓
 *   report table (the primary workspace) + pagination
 *
 * WHAT IT IS NOT: no Production workflow screen (no approve/reject/edit/submit — a
 * row's only affordance is its link into the READ-ONLY detail), no dashboard, no
 * export, no scheduling, no AI. The backend isolation suite pins each absence; the
 * scope test in the spec pins it here.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the two the source contract
 * supports (`status`, `search`), never a client-side sieve over one page, never a date
 * vocabulary the source lacks, never `requesterUserId` (an actor id with no display
 * contract, so a screen could not label the filter honestly).
 *
 * SUMMARY HONESTY: every number is `summary` straight from the API — a database
 * aggregation over the SAME filter. The component never counts rows itself and never
 * renders a figure it did not receive.
 *
 * STATUS VOCABULARY: the API carries the source's four lifecycle members;
 * `productionBomStatusLabel` / `productionBomStatusTone` are the existing
 * Production presentation mappings — one lifecycle, one set of words, no
 * Reporting-specific state.
 *
 * STATES: forbidden (no `production.bom.read`) → error (Persian + retry) → initial
 * loading (skeleton, table height preserved) → empty («برای این فیلترها…») → data.
 * Rows stay visible during a background refetch so the table never blinks.
 */
const TONE_CLASSES: Record<ProductionTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

/** The source lifecycle word — never colour alone (phase brief §23). */
function StatusBadge({ status }: { status: string }) {
  const key = status as ProductionBomStatus;
  return (
    <span
      data-testid={`production-report-status-${status}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[productionBomStatusTone(key)]}`}
    >
      {productionBomStatusLabel(key)}
    </span>
  );
}

export function ProductionReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `production.bom.read` on all three
  // routes regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');

  const [statusFilter, setStatusFilter] = React.useState<ProductionReportStatus | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingProductionPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  // THE query — one object the list fetch, the chart buckets and the exported
  // file all derive from, so table, bars and file can never disagree about the
  // active scope. Declared BEFORE the fetch effect (never inside it): each of
  // the four would diverge if it ever built its own query object. Memoized so
  // the effect below re-runs only when one of the four query inputs actually
  // changes — the option the compiler demands (`react-hooks/immutability`:
  // a fresh object literal re-triggers on every render).
  const reportQuery: ReportingProductionReportQuery = React.useMemo(
    () => ({
      page,
      pageSize: PRODUCTION_REPORT_PAGE_SIZE,
      status: statusFilter === '' ? undefined : statusFilter,
      search: appliedSearch,
    }),
    [page, statusFilter, appliedSearch],
  );

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route
    // demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchProductionReport(reportQuery)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError('دریافت گزارش با خطا مواجه شد. لطفاً دوباره تلاش کنید.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, reportQuery, reloadToken]);

  // Whether a request cycle is meaningfully in flight. `isLoading` covers
  // retries (armed by the hook above, settled by the fetch effect); the
  // derived term covers the FIRST load, where no handler ever arms it: once
  // the gate has settled and neither data nor error has arrived yet, the view
  // is by definition waiting for its first response. This replaces the
  // previous in-effect `setLoading(true)` reset
  // (`react-hooks/set-state-in-effect`): the effect body now only settles.
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead;
  const busy = isLoading || (gateSettled && data === null && error === null);
  const items = data?.items ?? [];
  const summary = data?.summary;

  const selectStatus = (value: ProductionReportStatus | '') => {
    setStatusFilter(value);
    setPage(1);
  };

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="production-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="production-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش خلاصه و وضعیت عملیات تولید
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            وضعیت فعلی فهرست‌های مواد و توزیع آن‌ها در مراحل چرخه تأیید، برای مشاهده و بررسی است و
            هیچ تغییری در داده‌های تولید ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="production-report-filters">
        <form
          role="search"
          aria-label="فیلترهای گزارش"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedSearch(searchInput.trim());
            setPage(1);
          }}
        >
          <div className="flex min-w-40 flex-col gap-1">
            <label htmlFor="production-report-status" className="text-xs text-muted-foreground">
              وضعیت
            </label>
            <select
              id="production-report-status"
              data-testid="production-report-status-filter"
              value={statusFilter}
              disabled={busy}
              onChange={(event) =>
                selectStatus(
                  (event.target.value === '' ? '' : event.target.value) as
                    ProductionReportStatus | ''
                )
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {PRODUCTION_REPORT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {productionBomStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="production-report-search" className="text-xs text-muted-foreground">
              جستجو در عنوان
            </label>
            <input
              id="production-report-search"
              type="search"
              data-testid="production-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="عنوان…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <button
            type="submit"
            data-testid="production-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {(statusFilter !== '' || appliedSearch !== '') && (
            <button
              type="button"
              data-testid="production-report-clear-filters"
              disabled={busy}
              onClick={() => {
                setStatusFilter('');
                setSearchInput('');
                setAppliedSearch('');
                setPage(1);
              }}
              className="h-10 rounded-xl border border-border px-4 text-sm text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              پاک‌کردن فیلترها
            </button>
          )}
        </form>
      </section>

      {/* SUMMARY STRIP — every number comes from `summary` (the API's database
          aggregation over the SAME filter); this component never counts a row.
          The chips ARE the status filter: clicking one changes the query and the
          numbers re-derive from the new population. */}
      <section
        aria-label="خلاصه وضعیت فهرست‌های مواد"
        data-testid="production-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="production-report-summary-all"
                aria-pressed={statusFilter === ''}
                disabled={busy}
                onClick={() => selectStatus('')}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                  statusFilter === ''
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-background text-foreground hover:bg-secondary'
                }`}
              >
                همه
                <span className="tabular-nums" data-testid="production-report-summary-all-count">
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {PRODUCTION_REPORT_STATUSES.map((status) => (
              <li key={status}>
                <button
                  type="button"
                  data-testid={`production-report-summary-status-${status}`}
                  aria-pressed={statusFilter === status}
                  disabled={busy}
                  onClick={() => selectStatus(statusFilter === status ? '' : status)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    statusFilter === status
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {productionBomStatusLabel(status)}
                  <span
                    className="tabular-nums"
                    data-testid={`production-report-summary-count-${status}`}
                  >
                    {toPersianDigits(summary.byStatus[status] ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : busy ? (
          // Compact placeholders with NO fake figures: the numbers appear only
          // when the API supplies them.
          <div aria-hidden="true" className="flex flex-wrap gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-8 w-28 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
        ) : null}
      </section>

      {summary ? (
        <>
          <ReportSummaryChart
            title="توزیع وضعیت اقلام"
            testId="production-report"
            buckets={buildReportChartBuckets(
              summary.byStatus,
              PRODUCTION_REPORT_STATUSES,
              (status) => productionBomStatusLabel(status as ProductionBomStatus)
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="production-report"
              buildPath={(format) => productionReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="production-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="production-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section className="core-card p-4 sm:p-6" data-testid="production-report-table-card">
          <ReportingEmptyState
            message="برای این فیلترها فهرستی پیدا نشد."
            testId="production-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="production-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش خلاصه و وضعیت عملیات تولید</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    عنوان
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    پروژه
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    وضعیت
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    نظر مدیر
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    تعداد اقلام
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    تاریخ ثبت
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">عملیات</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`production-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/production/${row.id}`}
                        data-testid={`production-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground sm:table-cell">
                      {row.projectRef}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                      {productionManagerOpinionLabel(row.managerOpinion) ?? '—'}
                    </td>
                    <td className="hidden px-3 py-3 tabular-nums text-muted-foreground md:table-cell">
                      {toPersianDigits(row.itemCount)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {productionDateLabel(row.createdAt)}
                    </td>

                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/production/${row.id}`}
                        data-testid={`production-report-row-details-${row.id}`}
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        جزئیات
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.total > data.pageSize && (
            <nav
              className="mt-4 flex items-center justify-between gap-2 text-sm"
              data-testid="production-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="production-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="production-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="production-report-pagination-next"
                disabled={page * data.pageSize >= data.total || busy}
                onClick={() => setPage((value) => value + 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                بعدی
                <ChevronLeft className="h-4 w-4" />
              </button>
            </nav>
          )}
        </section>
      ) : null}
    </div>
  );
}
