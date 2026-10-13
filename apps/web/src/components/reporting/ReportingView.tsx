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
  checkRequestReportExportPath,
  fetchCheckRequestReport,
  REPORTING_CHECK_REQUEST_PAGE_SIZE,
  REPORTING_CHECK_REQUEST_STATUSES,
  type ReportingCheckRequestPage,
  type ReportingCheckRequestReportQuery,
} from '@/lib/reporting-api';
import {
  FINANCIAL_ISSUE_TYPE_LABELS,
  financialDateLabel,
  financialErrorMessage,
  financialManagerDecisionLabel,
  financialStatusLabel,
  financialStatusTone,
  type FinancialTone,
} from '@/lib/financial-labels';
import type { FinancialCheckIssueType } from '@/lib/financial-api';
import { buildReportChartBuckets } from '@/lib/report-chart';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the first real Reporting workspace —
 * «گزارش وضعیت و گردش درخواست‌های صدور چک» at `/admin/reporting`.
 *
 * WHAT THIS SCREEN IS: a READ-ONLY analytical surface over Financial truth.
 * Structure, top to bottom (phase brief §20):
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
 * WHAT IT IS NOT: no Financial workflow screen (no approve/reject/edit — a
 * row's only affordance is its link into the READ-ONLY detail), no dashboard,
 * no export, no scheduling, no AI. The backend isolation suite pins each
 * absence; the scope test in the spec pins it here.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the two the source
 * contract supports (`status`, `search`), never a client-side sieve over one
 * page, never a date vocabulary the source lacks.
 *
 * SUMMARY HONESTY: every number is `summary` straight from the API — a
 * database aggregation over the SAME filter. The component never counts rows
 * itself and never renders a figure it did not receive.
 *
 * STATUS VOCABULARY: the API carries the source ordinals; `financialStatusLabel`
 * is the presentation mapping (the existing Financial labels) — one
 * lifecycle, one set of words, no Reporting-specific state.
 *
 * STATES: forbidden (no `financial.check.read`) → error (Persian + retry) →
 * initial loading (skeleton, table height preserved) → empty («برای این
 * فیلترها…») → data. Rows stay visible during a background refetch so the
 * table never blinks.
 */
const TONE_CLASSES: Record<FinancialTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

/** The source lifecycle word + ordinal — never colour alone (phase brief §23). */
function StatusBadge({ status }: { status: number }) {
  return (
    <span
      data-testid={`reporting-status-${status}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[financialStatusTone(status)]}`}
    >
      <span>{financialStatusLabel(status)}</span>
      <span className="opacity-60">({toPersianDigits(status)})</span>
    </span>
  );
}

export function ReportingView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `financial.check.read` on all
  // three routes regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('financial.check.read');

  const [statusFilter, setStatusFilter] = React.useState<number | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingCheckRequestPage | null>(null);
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
  const reportQuery: ReportingCheckRequestReportQuery = React.useMemo(
    () => ({
      page,
      pageSize: REPORTING_CHECK_REQUEST_PAGE_SIZE,
      status: statusFilter === '' ? undefined : statusFilter,
      search: appliedSearch,
    }),
    [page, statusFilter, appliedSearch],
  );

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the
    // route demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchCheckRequestReport(reportQuery)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const body = (err as { details?: { code?: string } }).details;
        setError(
          financialErrorMessage(body?.code, 'دریافت گزارش با خطا مواجه شد. لطفاً دوباره تلاش کنید.')
        );
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

  const selectStatus = (value: number | '') => {
    setStatusFilter(value);
    setPage(1);
  };

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="reporting-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="reporting-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش وضعیت و گردش درخواست‌های صدور چک
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            وضعیت فعلی درخواست‌های صدور چک و توزیع آن‌ها در مراحل گردش کار؛ برای مشاهده و بررسی است
            و هیچ تغییری در داده‌های مالی ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="reporting-filters">
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
            <label htmlFor="reporting-status" className="text-xs text-muted-foreground">
              وضعیت
            </label>
            <select
              id="reporting-status"
              data-testid="reporting-status-filter"
              value={statusFilter}
              disabled={busy}
              onChange={(event) =>
                selectStatus(event.target.value === '' ? '' : Number(event.target.value))
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {REPORTING_CHECK_REQUEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {financialStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="reporting-search" className="text-xs text-muted-foreground">
              جستجو در عنوان
            </label>
            <input
              id="reporting-search"
              type="search"
              data-testid="reporting-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="عنوان درخواست…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <button
            type="submit"
            data-testid="reporting-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {(statusFilter !== '' || appliedSearch !== '') && (
            <button
              type="button"
              data-testid="reporting-clear-filters"
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
        aria-label="خلاصه وضعیت درخواست‌ها"
        data-testid="reporting-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="reporting-summary-all"
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
                <span className="tabular-nums" data-testid="reporting-summary-all-count">
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {REPORTING_CHECK_REQUEST_STATUSES.map((status) => (
              <li key={status}>
                <button
                  type="button"
                  data-testid={`reporting-summary-status-${status}`}
                  aria-pressed={statusFilter === status}
                  disabled={busy}
                  onClick={() => selectStatus(statusFilter === status ? '' : status)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    statusFilter === status
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {financialStatusLabel(status)}
                  <span className="tabular-nums" data-testid={`reporting-summary-count-${status}`}>
                    {toPersianDigits(summary.byStatus[String(status)] ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : busy ? (
          // Compact placeholders with NO fake figures (phase brief §26): the
          // numbers appear only when the API supplies them.
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
            title="توزیع وضعیت درخواست‌ها"
            testId="reporting"
            buckets={buildReportChartBuckets(
              summary.byStatus,
              REPORTING_CHECK_REQUEST_STATUSES,
              (key) => financialStatusLabel(Number(key))
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="reporting"
              buildPath={(format) => checkRequestReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="reporting-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="reporting-loading" aria-busy="true">
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section className="core-card p-4 sm:p-6" data-testid="reporting-table-card">
          <ReportingEmptyState
            message="برای این فیلترها درخواستی پیدا نشد."
            testId="reporting-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="reporting-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش وضعیت و گردش درخواست‌های صدور چک</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    عنوان
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    نوع صدور چک
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    وضعیت
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    تصمیم مدیر
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
                    data-testid={`reporting-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/check-requests/${row.id}`}
                        data-testid={`reporting-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground sm:table-cell">
                      {FINANCIAL_ISSUE_TYPE_LABELS[row.checkIssueType as FinancialCheckIssueType] ??
                        row.checkIssueType}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                      {financialManagerDecisionLabel(row.managerDecision) ?? '—'}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {financialDateLabel(row.requestDate)}
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/check-requests/${row.id}`}
                        data-testid={`reporting-row-details-${row.id}`}
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
              data-testid="reporting-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="reporting-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span className="text-muted-foreground" data-testid="reporting-pagination-status">
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="reporting-pagination-next"
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
