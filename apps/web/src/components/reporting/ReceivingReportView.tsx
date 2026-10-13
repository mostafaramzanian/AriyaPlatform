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
  COMMERCE_RECEIVING_STATUSES,
  fetchReceivingReport,
  receivingDayToFromInstant,
  receivingDayToToInstant,
  receivingReportExportPath,
  RECEIVING_REPORT_PAGE_SIZE,
  type CommerceReceivingStatus,
  type ReportingReceivingPage,
  type ReportingReceivingQuery,
} from '@/lib/receiving-report-api';
import {
  commerceInstantLabel,
  commerceReceivingStatusLabel,
  commerceReceivingStatusTone,
} from '@/lib/commerce-labels';
import { decimalDisplayLabel } from '@/lib/commerce-decimals';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';
import { buildReportChartBuckets } from '@/lib/report-chart';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the tenth Reporting workspace —
 * «گزارش وضعیت دریافت‌های بازرگانی». A READ-ONLY line register over the tenant's
 * purchase lines and their projected receiving state: identity → filters →
 * summary → status chart → export → table → pagination. No append, no
 * compensate, no document-level status (the three-state vocabulary lives on the
 * LINE — the schema states no document status anywhere), no timeline, no
 * dashboard, no scheduling, no AI.
 *
 * ROW GRAIN (scope gate A): ONE ROW = ONE PURCHASE LINE — the register never
 * collapses lines into a document row and never sums them into an invented
 * document status.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the five the source
 * contract supports (`status`, `search` on the document number, exact document
 * and line ids, and the half-open `receivedFrom/receivedTo` window on the
 * latest receiving instant). SUMMARY HONESTY: every number is `summary` straight
 * from the API.
 */
const TONE_CLASS: Record<string, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  muted: 'border-border bg-background text-muted-foreground',
  danger: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
};

/** The status badge — the product's existing receiving words and tones, never colour alone. */
function StatusBadge({ status }: { status: CommerceReceivingStatus }) {
  return (
    <span
      data-testid={`receiving-report-status-${status}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[commerceReceivingStatusTone(status)] ?? TONE_CLASS.muted}`}
    >
      {commerceReceivingStatusLabel(status)}
    </span>
  );
}

export function ReceivingReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `commerce.read` on all four
  // routes regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [statusFilter, setStatusFilter] = React.useState<CommerceReceivingStatus | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [fromInput, setFromInput] = React.useState('');
  const [toInput, setToInput] = React.useState('');
  const [appliedFrom, setAppliedFrom] = React.useState('');
  const [appliedTo, setAppliedTo] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingReceivingPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  // THE query — one object the list fetch, the chart buckets and the exported
  // file all derive from, so table, bars and file can never disagree.
  const reportQuery: ReportingReceivingQuery = {
    page,
    pageSize: RECEIVING_REPORT_PAGE_SIZE,
    status: statusFilter === '' ? undefined : statusFilter,
    search: appliedSearch,
    receivedFrom: appliedFrom ? receivingDayToFromInstant(appliedFrom) : undefined,
    receivedTo: appliedTo ? receivingDayToToInstant(appliedTo) : undefined,
  };

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route
    // demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchReceivingReport(reportQuery)
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
    statusFilter,
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

  const selectStatus = (value: CommerceReceivingStatus | '') => {
    setStatusFilter(value);
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
    setStatusFilter('');
    setSearchInput('');
    setAppliedSearch('');
    setFromInput('');
    setToInput('');
    setAppliedFrom('');
    setAppliedTo('');
    setPage(1);
  };

  const hasFilters =
    statusFilter !== '' || appliedSearch !== '' || appliedFrom !== '' || appliedTo !== '';

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="receiving-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="receiving-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش وضعیت دریافت‌های بازرگانی
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            وضعیت دریافت هر ردیف خرید در برابر مقدار سفارشی آن، بر پایه رویدادهای دریافت
            ثبت‌شده؛ برای مشاهده و بررسی است و هیچ تغییری در دریافت‌ها ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section aria-label="فیلترهای گزارش" className="core-card mb-4 p-4 sm:p-5">
        <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-44 flex-col gap-1">
            <label htmlFor="receiving-report-status" className="text-xs text-muted-foreground">
              وضعیت دریافت
            </label>
            <select
              id="receiving-report-status"
              data-testid="receiving-report-status-select"
              value={statusFilter}
              disabled={busy}
              onChange={(event) =>
                selectStatus(event.target.value as CommerceReceivingStatus | '')
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {COMMERCE_RECEIVING_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {commerceReceivingStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="receiving-report-search" className="text-xs text-muted-foreground">
              جستجو در شماره سند
            </label>
            <input
              id="receiving-report-search"
              type="search"
              data-testid="receiving-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="شماره سند خرید…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="receiving-report-from" className="text-xs text-muted-foreground">
              از تاریخ دریافت
            </label>
            <input
              id="receiving-report-from"
              type="date"
              data-testid="receiving-report-from-input"
              value={fromInput}
              disabled={busy}
              onChange={(event) => setFromInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>

          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="receiving-report-to" className="text-xs text-muted-foreground">
              تا تاریخ دریافت
            </label>
            <input
              id="receiving-report-to"
              type="date"
              data-testid="receiving-report-to-input"
              value={toInput}
              disabled={busy}
              onChange={(event) => setToInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>

          <button
            type="submit"
            data-testid="receiving-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {hasFilters && (
            <button
              type="button"
              data-testid="receiving-report-clear-filters"
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
          status filter: clicking one changes the query and the numbers re-derive. */}
      <section
        aria-label="خلاصه وضعیت دریافت"
        data-testid="receiving-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="receiving-report-summary-all"
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
                <span
                  className="tabular-nums"
                  data-testid="receiving-report-summary-all-count"
                >
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {COMMERCE_RECEIVING_STATUSES.map((status) => (
              <li key={status}>
                <button
                  type="button"
                  data-testid={`receiving-report-summary-status-${status}`}
                  aria-pressed={statusFilter === status}
                  disabled={busy}
                  onClick={() => selectStatus(statusFilter === status ? '' : status)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    statusFilter === status
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {commerceReceivingStatusLabel(status)}
                  <span
                    className="tabular-nums"
                    data-testid={`receiving-report-summary-count-${status}`}
                  >
                    {toPersianDigits(summary.byStatus[status] ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : busy ? (
          <div aria-hidden="true" className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-8 w-28 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
        ) : null}
      </section>

      {summary ? (
        <>
          <ReportSummaryChart
            title="توزیع وضعیت دریافت"
            testId="receiving-report"
            buckets={buildReportChartBuckets(
              summary.byStatus,
              COMMERCE_RECEIVING_STATUSES,
              commerceReceivingStatusLabel
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="receiving-report"
              buildPath={(format) => receivingReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="receiving-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="receiving-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section className="core-card p-4 sm:p-6" data-testid="receiving-report-table-card">
          <ReportingEmptyState
            message="برای این فیلترها ردیف دریافتی پیدا نشد."
            testId="receiving-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="receiving-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش وضعیت دریافت‌های بازرگانی</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    شماره سند
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    وضعیت دریافت
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    مقدار سفارش
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    مقدار دریافتی
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    آخرین دریافت
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    رویدادهای جبرانی
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
                    data-testid={`receiving-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/commerce/receiving/${row.id}`}
                        data-testid={`receiving-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.purchaseDocumentNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={row.receivingStatus} />
                    </td>
                    <td className="hidden px-3 py-3 tabular-nums text-muted-foreground sm:table-cell">
                      {decimalDisplayLabel(row.orderedQuantity)}
                    </td>
                    <td className="hidden px-3 py-3 tabular-nums text-muted-foreground sm:table-cell">
                      {decimalDisplayLabel(row.receivedQuantity)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {row.receivedAt !== null ? (
                        <span title={row.receivedAt}>{commerceInstantLabel(row.receivedAt)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="hidden px-3 py-3 tabular-nums text-muted-foreground md:table-cell">
                      {row.compensationCount > 0 ? toPersianDigits(row.compensationCount) : '—'}
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/commerce/receiving/${row.id}`}
                        data-testid={`receiving-report-row-details-${row.id}`}
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
              data-testid="receiving-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="receiving-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="receiving-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="receiving-report-pagination-next"
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


