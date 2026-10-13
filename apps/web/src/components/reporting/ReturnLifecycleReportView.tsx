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
  COMMERCE_RETURN_STATES,
  fetchReturnLifecycleReport,
  returnLifecycleDayToFromInstant,
  returnLifecycleDayToToInstant,
  returnLifecycleReportExportPath,
  RETURN_LIFECYCLE_REPORT_PAGE_SIZE,
  type CommerceReturnState,
  type ReportingReturnLifecyclePage,
  type ReportingReturnLifecycleQuery,
} from '@/lib/return-lifecycle-report-api';
import {
  commerceInstantLabel,
  commerceReturnStateLabel,
  commerceReturnStateTone,
  type CommerceTone,
} from '@/lib/commerce-labels';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';
import { buildReportChartBuckets } from '@/lib/report-chart';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the ninth Reporting workspace —
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی». A READ-ONLY surface over the tenant's
 * return register: identity → filters → summary → state chart → export → table →
 * pagination. No approve, no reject, no receive-back, no refund — a row's only
 * affordance is its link into the READ-ONLY detail (with its lines and its
 * audit-backed timeline), no dashboard, no scheduling, no AI.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the four the source contract
 * supports (`state`, `search`, the half-open `createdFrom/createdTo` window on
 * `createdAt`). SUMMARY HONESTY: every number is `summary` straight from the API —
 * the five predicate counts over the SAME population. STATE HONESTY: the row's
 * state is the PROJECTED lifecycle member; `commerceReturnStateLabel` /
 * `commerceReturnStateTone` are the existing Commerce presentation mappings — one
 * lifecycle, one set of words, no Reporting-specific state.
 *
 * STATES: forbidden (no `commerce.read`) → error (Persian + retry) → initial loading
 * (skeleton, table height preserved) → empty («برای این فیلترها…») → data. Rows stay
 * visible during a background refetch so the table never blinks.
 */
const TONE_CLASSES: Record<CommerceTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

/** The source lifecycle word + its tone — never colour alone (phase brief §23). */
function StateBadge({ state }: { state: string }) {
  return (
    <span
      data-testid={`return-lifecycle-report-state-${state}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-sm font-medium ${TONE_CLASSES[commerceReturnStateTone(state)]}`}
    >
      {commerceReturnStateLabel(state)}
    </span>
  );
}

export function ReturnLifecycleReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `commerce.read` on all five routes
  // regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [stateFilter, setStateFilter] = React.useState<CommerceReturnState | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [fromInput, setFromInput] = React.useState('');
  const [toInput, setToInput] = React.useState('');
  const [appliedFrom, setAppliedFrom] = React.useState('');
  const [appliedTo, setAppliedTo] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingReturnLifecyclePage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  // THE query — one object the list fetch, the chart buckets and the exported file
  // all derive from, so table, bars and file can never disagree about the active scope.
  const reportQuery: ReportingReturnLifecycleQuery = {
    page,
    pageSize: RETURN_LIFECYCLE_REPORT_PAGE_SIZE,
    state: stateFilter === '' ? undefined : stateFilter,
    search: appliedSearch,
    createdFrom: appliedFrom ? returnLifecycleDayToFromInstant(appliedFrom) : undefined,
    createdTo: appliedTo ? returnLifecycleDayToToInstant(appliedTo) : undefined,
  };

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route
    // demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchReturnLifecycleReport(reportQuery)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAuthenticated,
    rbac.isLoading,
    canRead,
    page,
    stateFilter,
    appliedSearch,
    appliedFrom,
    appliedTo,
    reloadToken,
  ]);

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

  const selectState = (value: CommerceReturnState | '') => {
    setStateFilter(value);
    setPage(1);
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedSearch(searchInput.trim());
    setAppliedFrom(fromInput);
    setAppliedTo(toInput);
    setPage(1);
  };

  const clearFilters = () => {
    setStateFilter('');
    setSearchInput('');
    setAppliedSearch('');
    setFromInput('');
    setToInput('');
    setAppliedFrom('');
    setAppliedTo('');
    setPage(1);
  };

  const hasFilters =
    stateFilter !== '' || appliedSearch !== '' || appliedFrom !== '' || appliedTo !== '';

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="return-lifecycle-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="return-lifecycle-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش چرخه حیات مرجوعی‌های بازرگانی
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            مرجوعی‌های ثبت‌شده در برابر اسناد خرید و توزیع آن‌ها بر پایه وضعیت چرخه حیات؛ برای
            مشاهده و بررسی است و هیچ تغییری در داده‌های تدارکات ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="return-lifecycle-report-filters">
        <form
          role="search"
          aria-label="فیلترهای گزارش"
          className="flex flex-wrap items-end gap-3"
          onSubmit={applyFilters}
        >
          <div className="flex min-w-40 flex-col gap-1">
            <label
              htmlFor="return-lifecycle-report-state"
              className="text-xs text-muted-foreground"
            >
              وضعیت چرخه حیات
            </label>
            <select
              id="return-lifecycle-report-state"
              data-testid="return-lifecycle-report-state-filter"
              value={stateFilter}
              disabled={busy}
              onChange={(event) =>
                selectState(
                  (event.target.value === '' ? '' : event.target.value) as CommerceReturnState | ''
                )
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {COMMERCE_RETURN_STATES.map((state) => (
                <option key={state} value={state}>
                  {commerceReturnStateLabel(state)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label
              htmlFor="return-lifecycle-report-search"
              className="text-xs text-muted-foreground"
            >
              جستجو در دلیل و شماره سند
            </label>
            <input
              id="return-lifecycle-report-search"
              type="search"
              data-testid="return-lifecycle-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="دلیل، شماره سند…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="return-lifecycle-report-from" className="text-xs text-muted-foreground">
              از تاریخ درخواست
            </label>
            <input
              id="return-lifecycle-report-from"
              type="date"
              data-testid="return-lifecycle-report-from-input"
              value={fromInput}
              disabled={busy}
              onChange={(event) => setFromInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>
          stateFilter, appliedSearch, appliedFrom, appliedTo, reloadToken, ]);
          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="return-lifecycle-report-to" className="text-xs text-muted-foreground">
              تا تاریخ درخواست
            </label>
            <input
              id="return-lifecycle-report-to"
              type="date"
              data-testid="return-lifecycle-report-to-input"
              value={toInput}
              disabled={busy}
              onChange={(event) => setToInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>
          <button
            type="submit"
            data-testid="return-lifecycle-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>
          {hasFilters && (
            <button
              type="button"
              data-testid="return-lifecycle-report-clear-filters"
              disabled={busy}
              onClick={clearFilters}
              className="h-10 rounded-xl border border-border px-4 text-sm text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              پاک‌کردن فیلترها
            </button>
          )}
        </form>
      </section>

      {/* SUMMARY STRIP — every number comes from `summary`; the chips ARE the
          state filter: clicking one changes the query and the numbers re-derive. */}
      <section
        aria-label="خلاصه وضعیت مرجوعی‌ها"
        data-testid="return-lifecycle-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="return-lifecycle-report-summary-all"
                aria-pressed={stateFilter === ''}
                disabled={busy}
                onClick={() => selectState('')}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                  stateFilter === ''
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-background text-foreground hover:bg-secondary'
                }`}
              >
                همه
                <span
                  className="tabular-nums"
                  data-testid="return-lifecycle-report-summary-all-count"
                >
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {COMMERCE_RETURN_STATES.map((state) => (
              <li key={state}>
                <button
                  type="button"
                  data-testid={`return-lifecycle-report-summary-state-${state}`}
                  aria-pressed={stateFilter === state}
                  disabled={busy}
                  onClick={() => selectState(stateFilter === state ? '' : state)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    stateFilter === state
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {commerceReturnStateLabel(state)}
                  <span
                    className="tabular-nums"
                    data-testid={`return-lifecycle-report-summary-count-${state}`}
                  >
                    {toPersianDigits(summary.byState[state] ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : busy ? (
          <div aria-hidden="true" className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-8 w-28 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
        ) : null}
      </section>

      {summary ? (
        <>
          <ReportSummaryChart
            title="توزیع وضعیت چرخه حیات"
            testId="return-lifecycle-report"
            buckets={buildReportChartBuckets(
              summary.byState,
              COMMERCE_RETURN_STATES,
              commerceReturnStateLabel
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="return-lifecycle-report"
              buildPath={(format) => returnLifecycleReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="return-lifecycle-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="return-lifecycle-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section className="core-card p-4 sm:p-6" data-testid="return-lifecycle-report-table-card">
          <ReportingEmptyState
            message="برای این فیلترها مرجوعی پیدا نشد."
            testId="return-lifecycle-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="return-lifecycle-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش چرخه حیات مرجوعی‌های بازرگانی</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    شماره سند
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    وضعیت چرخه حیات
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    دلیل
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    اقلام
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    تاریخ درخواست
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    <span className="sr-only">جزئیات</span>
                  </th>
                </tr>
              </thead>
              <tbody aria-busy={busy}>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`return-lifecycle-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/commerce/return-lifecycle/${row.id}`}
                        data-testid={`return-lifecycle-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.purchaseDocumentNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <StateBadge state={row.state} />
                    </td>
                    <td className="hidden max-w-56 truncate px-3 py-3 text-muted-foreground sm:table-cell">
                      <span title={row.reason}>{row.reason}</span>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground">
                      {toPersianDigits(row.lineCount)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <span title={row.createdAt}>{commerceInstantLabel(row.createdAt)}</span>
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/commerce/return-lifecycle/${row.id}`}
                        data-testid={`return-lifecycle-report-row-details-${row.id}`}
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
              data-testid="return-lifecycle-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="return-lifecycle-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="return-lifecycle-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="return-lifecycle-report-pagination-next"
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
