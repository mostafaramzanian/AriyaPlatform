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
  COMMERCE_PAYMENT_METHODS,
  fetchPaymentHistoryReport,
  paymentHistoryDayToFromInstant,
  paymentHistoryDayToToInstant,
  paymentHistoryReportExportPath,
  PAYMENT_HISTORY_REPORT_PAGE_SIZE,
  type CommercePaymentMethod,
  type ReportingPaymentHistoryPage,
  type ReportingPaymentHistoryQuery,
} from '@/lib/payment-history-report-api';
import {
  commerceInstantLabel,
  commerceMoneyLabel,
  commercePaymentMethodLabel,
} from '@/lib/commerce-labels';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';
import { buildReportChartBuckets } from '@/lib/report-chart';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the eighth Reporting workspace —
 * «گزارش تاریخچه پرداخت‌های بازرگانی». A READ-ONLY surface over the tenant's
 * append-only payment register: identity → filters → summary → method chart →
 * export → table → pagination. No append, no compensate, no status column (the
 * four-member vocabulary is a per-DOCUMENT projection, never a per-row fact), no
 * timeline, no dashboard, no scheduling, no AI.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the four the source contract
 * supports (`method`, `search`, the half-open `paymentFrom/paymentTo` window on
 * `paymentDate`). SUMMARY HONESTY: every number is `summary` straight from the API.
 */
const INFO_TONE = 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';

/** The compensation badge — the product's existing «رویداد جبرانی» word, never colour alone. */
function KindBadge({ reversesPaymentId }: { reversesPaymentId: string | null }) {
  if (reversesPaymentId === null) {
    return <span className="text-sm text-foreground">پرداخت</span>;
  }
  return (
    <span
      data-testid="payment-history-report-kind-compensation"
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${INFO_TONE}`}
    >
      رویداد جبرانی
    </span>
  );
}

export function PaymentHistoryReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `commerce.read` on all four routes
  // regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [methodFilter, setMethodFilter] = React.useState<CommercePaymentMethod | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [fromInput, setFromInput] = React.useState('');
  const [toInput, setToInput] = React.useState('');
  const [appliedFrom, setAppliedFrom] = React.useState('');
  const [appliedTo, setAppliedTo] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingPaymentHistoryPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  // THE query — one object the list fetch, the chart buckets and the exported file
  // all derive from, so table, bars and file can never disagree about the active scope.
  const reportQuery: ReportingPaymentHistoryQuery = {
    page,
    pageSize: PAYMENT_HISTORY_REPORT_PAGE_SIZE,
    method: methodFilter === '' ? undefined : methodFilter,
    search: appliedSearch,
    paymentFrom: appliedFrom ? paymentHistoryDayToFromInstant(appliedFrom) : undefined,
    paymentTo: appliedTo ? paymentHistoryDayToToInstant(appliedTo) : undefined,
  };

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route
    // demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchPaymentHistoryReport(reportQuery)
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
    methodFilter,
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

  const selectMethod = (value: CommercePaymentMethod | '') => {
    setMethodFilter(value);
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
    setMethodFilter('');
    setSearchInput('');
    setAppliedSearch('');
    setFromInput('');
    setToInput('');
    setAppliedFrom('');
    setAppliedTo('');
    setPage(1);
  };

  const hasFilters =
    methodFilter !== '' || appliedSearch !== '' || appliedFrom !== '' || appliedTo !== '';

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="payment-history-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="payment-history-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش تاریخچه پرداخت‌های بازرگانی
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            رویدادهای پرداخت ثبت‌شده در برابر اسناد خرید و توزیع آن‌ها بر پایه روش پرداخت؛ برای
            مشاهده و بررسی است و هیچ تغییری در داده‌های تدارکات ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="payment-history-report-filters">
        <form
          role="search"
          aria-label="فیلترهای گزارش"
          className="flex flex-wrap items-end gap-3"
          onSubmit={applyFilters}
        >
          <div className="flex min-w-40 flex-col gap-1">
            <label
              htmlFor="payment-history-report-method"
              className="text-xs text-muted-foreground"
            >
              روش پرداخت
            </label>
            <select
              id="payment-history-report-method"
              data-testid="payment-history-report-method-filter"
              value={methodFilter}
              disabled={busy}
              onChange={(event) =>
                selectMethod(
                  (event.target.value === '' ? '' : event.target.value) as
                    CommercePaymentMethod | ''
                )
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {COMMERCE_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {commercePaymentMethodLabel(method)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label
              htmlFor="payment-history-report-search"
              className="text-xs text-muted-foreground"
            >
              جستجو در مراجع و شماره سند
            </label>
            <input
              id="payment-history-report-search"
              type="search"
              data-testid="payment-history-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="مرجع، شماره صورتحساب، شماره سند…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="payment-history-report-from" className="text-xs text-muted-foreground">
              از تاریخ پرداخت
            </label>
            <input
              id="payment-history-report-from"
              type="date"
              data-testid="payment-history-report-from-input"
              value={fromInput}
              disabled={busy}
              onChange={(event) => setFromInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>

          <div className="flex min-w-36 flex-col gap-1">
            <label htmlFor="payment-history-report-to" className="text-xs text-muted-foreground">
              تا تاریخ پرداخت
            </label>
            <input
              id="payment-history-report-to"
              type="date"
              data-testid="payment-history-report-to-input"
              value={toInput}
              disabled={busy}
              onChange={(event) => setToInput(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>

          <button
            type="submit"
            data-testid="payment-history-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {hasFilters && (
            <button
              type="button"
              data-testid="payment-history-report-clear-filters"
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
          method filter: clicking one changes the query and the numbers re-derive. */}
      <section
        aria-label="خلاصه روش‌های پرداخت"
        data-testid="payment-history-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="payment-history-report-summary-all"
                aria-pressed={methodFilter === ''}
                disabled={busy}
                onClick={() => selectMethod('')}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                  methodFilter === ''
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-background text-foreground hover:bg-secondary'
                }`}
              >
                همه
                <span
                  className="tabular-nums"
                  data-testid="payment-history-report-summary-all-count"
                >
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {COMMERCE_PAYMENT_METHODS.map((method) => (
              <li key={method}>
                <button
                  type="button"
                  data-testid={`payment-history-report-summary-method-${method}`}
                  aria-pressed={methodFilter === method}
                  disabled={busy}
                  onClick={() => selectMethod(methodFilter === method ? '' : method)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    methodFilter === method
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {commercePaymentMethodLabel(method)}
                  <span
                    className="tabular-nums"
                    data-testid={`payment-history-report-summary-count-${method}`}
                  >
                    {toPersianDigits(summary.byMethod[method] ?? 0)}
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
            title="توزیع روش پرداخت"
            testId="payment-history-report"
            buckets={buildReportChartBuckets(
              summary.byMethod,
              COMMERCE_PAYMENT_METHODS,
              commercePaymentMethodLabel
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="payment-history-report"
              buildPath={(format) => paymentHistoryReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="payment-history-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="payment-history-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section className="core-card p-4 sm:p-6" data-testid="payment-history-report-table-card">
          <ReportingEmptyState
            message="برای این فیلترها پرداختی پیدا نشد."
            testId="payment-history-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="payment-history-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش تاریخچه پرداخت‌های بازرگانی</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    شماره سند
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    نوع رویداد
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    روش پرداخت
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    مبلغ
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    مرجع صورتحساب
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    تاریخ پرداخت
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
                    data-testid={`payment-history-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/commerce/payment-history/${row.id}`}
                        data-testid={`payment-history-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.purchaseDocumentNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <KindBadge reversesPaymentId={row.reversesPaymentId} />
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground sm:table-cell">
                      <span data-testid={`payment-history-report-method-${row.method}`}>
                        {commercePaymentMethodLabel(row.method)}
                      </span>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground">
                      {commerceMoneyLabel(row.amount, row.currency)}
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                      {row.invoiceRef ?? '—'}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <span title={row.paymentDate}>{commerceInstantLabel(row.paymentDate)}</span>
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/commerce/payment-history/${row.id}`}
                        data-testid={`payment-history-report-row-details-${row.id}`}
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
              data-testid="payment-history-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="payment-history-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="payment-history-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="payment-history-report-pagination-next"
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
