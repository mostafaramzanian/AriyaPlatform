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
  fetchProductionBomChangeReport,
  productionBomChangeReportExportPath,
  PRODUCTION_BOM_CHANGE_REPORT_PAGE_SIZE,
  PRODUCTION_BOM_CHANGE_REPORT_STATUSES,
  type ProductionBomChangeReportStatus,
  type ReportingProductionBomChangePage,
  type ReportingProductionBomChangeReportQuery,
} from '@/lib/production-bom-change-report-api';
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
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the fifth Reporting workspace —
 * «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)» at
 * `/admin/reporting/production/bom-change-requests`.
 *
 * WHAT THIS SCREEN IS: a READ-ONLY analytical surface over Production change-request
 * truth. Structure, top to bottom (the same seven steps the four sibling reports
 * established):
 *
 *   page heading (h2 — the shell header owns the document's h1)
 *        ↓
 *   report identity (h3) + one explanation sentence
 *        ↓
 *   filter bar — exactly the four source-supported filters: وضعیت + جستجو در عنوان +
 *   پروژه (exact) + شناسه BOM (uuid)
 *        ↓
 *   summary strip — per-status counts over the SAME filtered population
 *        ↓
 *   status distribution — server summary buckets, RTL horizontal bars
 *        ↓
 *   report table (the primary workspace) + pagination
 *
 * WHAT IT IS NOT: no Production workflow screen (no approve/reject/edit/submit — a
 * row's only affordance is its link into the READ-ONLY detail), no dashboard, no
 * scheduling, no AI. The backend isolation suite pins each absence.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the four the source register
 * itself proves (`status`, `search`, `projectRef`, `bomId`), never a client-side sieve
 * over one page, never a date vocabulary the source lacks, never an actor id. The
 * `bomId` field is validated against the SAME UUID-v4 rule the DTO enforces before the
 * request is issued, so a typo is a visible validation message rather than a
 * misleading «خطا» from a 422 the screen could have prevented.
 *
 * SUMMARY HONESTY: every number is `summary` straight from the API — a database
 * aggregation over the SAME filter. The component never counts rows itself and never
 * renders a figure it did not receive.
 *
 * STATUS VOCABULARY: the API carries the source's four lifecycle members;
 * `productionBomStatusLabel` / `productionBomStatusTone` are the existing Production
 * presentation mappings — one lifecycle, one set of words, no Reporting-specific
 * state. Correction is a transition back to DRAFT, never a fifth badge.
 *
 * STATES: forbidden (no `production.bom.read`) → validation (bad `bomId`) → error
 * (Persian + retry) → initial loading (skeleton, table height preserved) → empty
 * («برای این فیلترها…») → data. Rows stay visible during a background refetch so the
 * table never blinks.
 */
const TONE_CLASSES: Record<ProductionTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

/** The DTO's `@IsUUID('4')`, restated so a typo is a field message, not a 422. */
const BOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The source lifecycle word — never colour alone. */
function StatusBadge({ status }: { status: string }) {
  const key = status as ProductionBomStatus;
  return (
    <span
      data-testid={`production-bom-change-report-status-${status}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[productionBomStatusTone(key)]}`}
    >
      {productionBomStatusLabel(key)}
    </span>
  );
}

export function ProductionBomChangeReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `production.bom.read` on all five
  // routes regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');

  const [statusFilter, setStatusFilter] = React.useState<ProductionBomChangeReportStatus | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [projectInput, setProjectInput] = React.useState('');
  const [appliedProject, setAppliedProject] = React.useState('');
  const [bomInput, setBomInput] = React.useState('');
  const [appliedBom, setAppliedBom] = React.useState('');
  const [bomValidationError, setBomValidationError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingProductionBomChangePage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  // THE query — one object the list fetch, the chart buckets and the exported
  // file all derive from, so table, bars and file can never disagree about the
  // active scope. Declared BEFORE the fetch effect (never inside it): each of
  // the four would diverge if it ever built its own query object. Memoized so
  // the effect below re-runs only when one of the six query inputs actually
  // changes — the option the compiler demands (`react-hooks/immutability`:
  // a fresh object literal re-triggers on every render).
  const reportQuery: ReportingProductionBomChangeReportQuery = React.useMemo(
    () => ({
      page,
      pageSize: PRODUCTION_BOM_CHANGE_REPORT_PAGE_SIZE,
      status: statusFilter === '' ? undefined : statusFilter,
      search: appliedSearch,
      projectRef: appliedProject,
      bomId: appliedBom,
    }),
    [page, statusFilter, appliedSearch, appliedProject, appliedBom],
  );

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route
    // demands; retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchProductionBomChangeReport(reportQuery)
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
    appliedProject,
    appliedBom,
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

  const selectStatus = (value: ProductionBomChangeReportStatus | '') => {
    setStatusFilter(value);
    setPage(1);
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedBom = bomInput.trim();
    // The DTO refuses anything but a UUID v4 with a 422; validating here turns that
    // into a field-level Persian message instead of a generic fetch error.
    if (trimmedBom !== '' && !BOM_ID_PATTERN.test(trimmedBom)) {
      setBomValidationError('شناسه BOM باید یک شناسه معتبر (UUID) باشد.');
      return;
    }
    setBomValidationError(null);
    setAppliedSearch(searchInput.trim());
    setAppliedProject(projectInput.trim());
    setAppliedBom(trimmedBom);
    setPage(1);
  };

  const clearFilters = () => {
    setStatusFilter('');
    setSearchInput('');
    setAppliedSearch('');
    setProjectInput('');
    setAppliedProject('');
    setBomInput('');
    setAppliedBom('');
    setBomValidationError(null);
    setPage(1);
  };

  const hasActiveFilters =
    statusFilter !== '' || appliedSearch !== '' || appliedProject !== '' || appliedBom !== '';

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="production-bom-change-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="production-bom-change-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">
            گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            وضعیت فعلی درخواست‌های تغییر فهرست مواد و توزیع آن‌ها در مراحل چرخه تأیید، برای مشاهده و
            بررسی است و هیچ تغییری در داده‌های تولید ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section
        className="core-card mb-4 p-4 sm:p-5"
        data-testid="production-bom-change-report-filters"
      >
        <form
          role="search"
          aria-label="فیلترهای گزارش"
          className="flex flex-wrap items-end gap-3"
          onSubmit={applyFilters}
        >
          <div className="flex min-w-40 flex-col gap-1">
            <label
              htmlFor="production-bom-change-report-status"
              className="text-xs text-muted-foreground"
            >
              وضعیت
            </label>
            <select
              id="production-bom-change-report-status"
              data-testid="production-bom-change-report-status-filter"
              value={statusFilter}
              disabled={busy}
              onChange={(event) =>
                selectStatus(
                  (event.target.value === '' ? '' : event.target.value) as
                    ProductionBomChangeReportStatus | ''
                )
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">همه</option>
              {PRODUCTION_BOM_CHANGE_REPORT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {productionBomStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label
              htmlFor="production-bom-change-report-search"
              className="text-xs text-muted-foreground"
            >
              جستجو در عنوان
            </label>
            <input
              id="production-bom-change-report-search"
              type="search"
              data-testid="production-bom-change-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="عنوان…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <label
              htmlFor="production-bom-change-report-project"
              className="text-xs text-muted-foreground"
            >
              پروژه (مطابقت دقیق)
            </label>
            <input
              id="production-bom-change-report-project"
              type="search"
              data-testid="production-bom-change-report-project-input"
              value={projectInput}
              disabled={busy}
              onChange={(event) => setProjectInput(event.target.value)}
              placeholder="مرجع پروژه…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <label
              htmlFor="production-bom-change-report-bom"
              className="text-xs text-muted-foreground"
            >
              شناسه BOM
            </label>
            <input
              id="production-bom-change-report-bom"
              type="text"
              inputMode="text"
              dir="ltr"
              data-testid="production-bom-change-report-bom-input"
              value={bomInput}
              disabled={busy}
              onChange={(event) => setBomInput(event.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              aria-invalid={bomValidationError !== null}
              aria-describedby={
                bomValidationError ? 'production-bom-change-report-bom-error' : undefined
              }
              className="h-10 rounded-xl border border-border bg-background px-3 text-left font-mono text-sm text-foreground placeholder:text-muted-foreground"
            />
            {bomValidationError && (
              <p
                id="production-bom-change-report-bom-error"
                data-testid="production-bom-change-report-bom-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {bomValidationError}
              </p>
            )}
          </div>

          <button
            type="submit"
            data-testid="production-bom-change-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              data-testid="production-bom-change-report-clear-filters"
              disabled={busy}
              onClick={clearFilters}
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
        aria-label="خلاصه وضعیت درخواست‌های تغییر"
        data-testid="production-bom-change-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="production-bom-change-report-summary-all"
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
                  data-testid="production-bom-change-report-summary-all-count"
                >
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {PRODUCTION_BOM_CHANGE_REPORT_STATUSES.map((status) => (
              <li key={status}>
                <button
                  type="button"
                  data-testid={`production-bom-change-report-summary-status-${status}`}
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
                    data-testid={`production-bom-change-report-summary-count-${status}`}
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
            title="توزیع وضعیت درخواست‌ها"
            testId="production-bom-change-report"
            buckets={buildReportChartBuckets(
              summary.byStatus,
              PRODUCTION_BOM_CHANGE_REPORT_STATUSES,
              (status) => productionBomStatusLabel(status as ProductionBomStatus)
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="production-bom-change-report"
              buildPath={(format) => productionBomChangeReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="production-bom-change-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="production-bom-change-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : items.length === 0 && !error ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="production-bom-change-report-table-card"
        >
          <ReportingEmptyState
            message="برای این فیلترها درخواستی پیدا نشد."
            testId="production-bom-change-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="production-bom-change-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    عنوان
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    پروژه
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
                    شناسه BOM
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    وضعیت
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    نظر مدیر
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    تعداد اقلام تغییر
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
                    data-testid={`production-bom-change-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/production/bom-change-requests/${row.id}`}
                        data-testid={`production-bom-change-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground sm:table-cell">
                      {row.projectRef}
                    </td>
                    <td
                      dir="ltr"
                      className="hidden max-w-32 truncate px-3 py-3 text-left font-mono text-xs text-muted-foreground lg:table-cell"
                    >
                      {row.bomId}
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
                        href={`/admin/reporting/production/bom-change-requests/${row.id}`}
                        data-testid={`production-bom-change-report-row-details-${row.id}`}
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
              data-testid="production-bom-change-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="production-bom-change-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="production-bom-change-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="production-bom-change-report-pagination-next"
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
