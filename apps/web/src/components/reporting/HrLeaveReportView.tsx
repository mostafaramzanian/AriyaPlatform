'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  HR_LEAVE_REPORT_PAGE_SIZE,
  HR_LEAVE_REQUEST_STATUSES,
  fetchHrLeaveReport,
  hrLeaveReportExportPath,
  type HrLeaveRequestStatus,
  type ReportingLeavePage,
  type ReportingLeaveQuery,
} from '@/lib/hr-leave-report-api';
import {
  HR_MAX_PAGE_SIZE,
  fetchHrLeaveTypes,
  hrLeavePeriodLabel,
  hrLeaveRequestStatusLabel,
  hrLeaveRequestStatusTone,
  type HrLeaveType,
  type HrTone,
} from '@/lib/hr-api';
import { buildReportChartBuckets } from '@/lib/report-chart';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the sixth Reporting workspace —
 * «گزارش وضعیت درخواست‌های مرخصی» at `/admin/reporting/hr/leave-requests`.
 *
 * A READ-ONLY surface over the leave register HR owns, in the same vertical
 * order as the five siblings: identity → filters → summary → status chart →
 * table → pagination. No submit/approve/reject lives here (those stay in HR's
 * own register), and no balance, duration, rate or KPI: the HR schema stores
 * none of them (§13), so no cell computes one — the isolation suite pins each
 * absence server-side and the spec pins it here.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the three the screen
 * renders. The date window is labelled «میلادی» exactly as the register labels
 * it (the wire value IS the Gregorian day the API indexes), and its meaning is
 * «INTERSECTION with the requested period» — never submission or decision date.
 *
 * SUMMARY HONESTY: every number is `summary` straight from the API over the
 * SAME filter; the component never counts rows itself. Status words come from
 * the shared HR vocabulary — colour is always a second channel.
 */
const TONE_CLASSES: Record<HrTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** The status word + state — never colour alone. */
function StatusBadge({ status }: { status: HrLeaveRequestStatus }) {
  return (
    <span
      data-testid={`hr-leave-report-status-${status}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[hrLeaveRequestStatusTone(status)]}`}
    >
      {hrLeaveRequestStatusLabel(status)}
    </span>
  );
}

interface Filters {
  status: HrLeaveRequestStatus | '';
  from: string;
  to: string;
  leaveTypeId: string;
}

const EMPTY_FILTERS: Filters = { status: '', from: '', to: '', leaveTypeId: '' };

export function HrLeaveReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('hr.leave.read');

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<ReportingLeavePage | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  const [types, setTypes] = React.useState<HrLeaveType[]>([]);
  const [isTypeReadFailed, setTypeReadFailed] = React.useState(false);

  // A query change — filters, page, or a retry's token bump — is a NEW read:
  // re-arm `busy` and clear the error during render, guarded by the previous
  // values (`react-hooks/set-state-in-effect` bars the effect-body arm the
  // report effect used to carry). The fields mirror that effect's exact
  // dependency list; its early-return on unsettled permissions needs no arm,
  // and the catalogue effect below clears its own failure flag on its first
  // run only (no refire trigger exists), so its old in-effect setter was a
  // mount no-op and is simply gone.
  const [prevReportQuery, setPrevReportQuery] = React.useState({
    status: filters.status,
    from: filters.from,
    to: filters.to,
    leaveTypeId: filters.leaveTypeId,
    page,
    reloadToken,
  });
  const reportQueryChanged =
    prevReportQuery.status !== filters.status ||
    prevReportQuery.from !== filters.from ||
    prevReportQuery.to !== filters.to ||
    prevReportQuery.leaveTypeId !== filters.leaveTypeId ||
    prevReportQuery.page !== page ||
    prevReportQuery.reloadToken !== reloadToken;
  if (reportQueryChanged) {
    setPrevReportQuery({
      status: filters.status,
      from: filters.from,
      to: filters.to,
      leaveTypeId: filters.leaveTypeId,
      page,
      reloadToken,
    });
    setBusy(true);
    setError(null);
  }

  /** A filter change is a NEW query, never a new page of the old one. */
  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const hasFilters =
    filters.status.length > 0 ||
    filters.from.length > 0 ||
    filters.to.length > 0 ||
    filters.leaveTypeId.length > 0;

  /** The CURRENT query, built once — list, export and chart all speak it. */
  const query: ReportingLeaveQuery = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.leaveTypeId ? { leaveTypeId: filters.leaveTypeId } : {}),
    page,
    pageSize: HR_LEAVE_REPORT_PAGE_SIZE,
  };

  // The tenant's own leave catalogue, read with the report's own grant: both endpoints
  // answer to `hr.leave.read`, so the type filter never requires a second remit.
  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchHrLeaveTypes({ pageSize: HR_MAX_PAGE_SIZE })
      .then((result) => {
        if (active) setTypes(result.items);
      })
      .catch(() => {
        if (!active) return;
        setTypes([]);
        setTypeReadFailed(true);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead]);

  // The report itself — the primitives, never the rebuilt object, are the dependencies.
  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchHrLeaveReport(query)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
        setBusy(false);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : 'دریافت گزارش با خطا مواجه شد.');
        setLoading(false);
        setBusy(false);
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAuthenticated,
    rbac.isLoading,
    canRead,
    filters.status,
    filters.from,
    filters.to,
    filters.leaveTypeId,
    page,
    reloadToken,
  ]);

  const statusOptions: SelectOption[] = [
    { value: '', label: 'همه وضعیت‌ها' },
    ...HR_LEAVE_REQUEST_STATUSES.map((value) => ({
      value,
      label: hrLeaveRequestStatusLabel(value),
    })),
  ];

  /** Includes RETIRED entries: «what was recorded against this kind» is history too. */
  const typeOptions: SelectOption[] = [
    { value: '', label: 'همه انواع مرخصی' },
    ...types.map((type) => ({ value: type.id, label: `${type.name} (${type.code})` })),
  ];

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="hr-leave-report">
        <CoreForbidden message="برای مشاهده این گزارش به مجوز hr.leave.read نیاز دارید." />
      </div>
    );
  }

  return (
    <div data-testid="hr-leave-report" className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          گزارش وضعیت درخواست‌های مرخصی
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          هر درخواست مرخصی ثبت‌شده، بازه روزهای درخواست‌شده، وضعیت فعلی و گردش تأیید آن —
          با همان فیلترهای دفتر مرخصی، روی یک پرسش واحد.
        </p>
      </div>

      <section
        className="rounded-2xl border border-border bg-card p-4"
        data-testid="hr-leave-report-filters"
        aria-label="فیلترهای گزارش"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            id="hr-leave-report-status"
            name="status"
            label="وضعیت"
            value={filters.status}
            options={statusOptions}
            onChange={(event) =>
              applyFilter('status', event.target.value as HrLeaveRequestStatus | '')
            }
          />
          <Select
            id="hr-leave-report-type"
            name="leaveTypeId"
            label="نوع مرخصی"
            value={filters.leaveTypeId}
            options={typeOptions}
            onChange={(event) => applyFilter('leaveTypeId', event.target.value)}
          />
          {/* The window is GREGORIAN `YYYY-MM-DD`, the SAME wire format the API declares and
              indexes: no conversion, and the value the control holds is the value the API
              receives — the register's own pair of inputs, word for word. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-1 lg:grid-cols-1">
            <Input
              id="hr-leave-report-from"
              name="from"
              type="date"
              label="از تاریخ (میلادی)"
              value={filters.from}
              onChange={(event) => applyFilter('from', event.target.value)}
            />
            <Input
              id="hr-leave-report-to"
              name="to"
              type="date"
              label="تا تاریخ (میلادی)"
              value={filters.to}
              onChange={(event) => applyFilter('to', event.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            بازه تاریخ، روزهای <strong>درخواست‌شده</strong> را می‌سنجد: هر درخواستی که با این
            بازه هم‌پوشانی داشته باشد.
          </p>
          {hasFilters && (
            <Button
              type="button"
              data-testid="hr-leave-report-filters-reset"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              بازنشانی فیلترها
            </Button>
          )}
        </div>

        {isTypeReadFailed && (
          <p
            role="status"
            className="mt-3 text-xs text-destructive"
            data-testid="hr-leave-report-type-warning"
          >
            فهرست انواع مرخصی خوانده نشد؛ فیلتر نوع مرخصی در دسترس نیست.
          </p>
        )}
      </section>

      {error ? (
        <div data-testid="hr-leave-report-error">
          <CoreError message={error} onRetry={() => setReloadToken((value) => value + 1)} />
        </div>
      ) : isLoading && !data ? (
        <div data-testid="hr-leave-report-loading" aria-busy="true">
          <CoreLoading label="در حال بارگذاری گزارش…" lines={6} />
        </div>
      ) : data ? (
        <>
          {/* Summary — server counts over the SAME filtered population as the table.
              Neutral cards: a count is a count, not a performance verdict. */}
          <section
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            data-testid="hr-leave-report-summary"
            aria-label="خلاصه گزارش"
          >
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">کل درخواست‌ها</p>
              <p
                className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
                data-testid="hr-leave-report-summary-total"
              >
                {toPersianDigits(data.summary.total)}
              </p>
            </div>
            {HR_LEAVE_REQUEST_STATUSES.map((status) => (
              <div key={status} className="rounded-2xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{hrLeaveRequestStatusLabel(status)}</p>
                <p
                  className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
                  data-testid={`hr-leave-report-summary-${status}`}
                >
                  {toPersianDigits(data.summary.byStatus[status] ?? 0)}
                </p>
              </div>
            ))}
          </section>

          {/* The shared RTL chart over the SAME server summary the strip above renders. */}
          <ReportSummaryChart
            title="توزیع وضعیت درخواست‌ها"
            testId="hr-leave-report"
            buckets={buildReportChartBuckets(
              data.summary.byStatus,
              HR_LEAVE_REQUEST_STATUSES,
              // The chart helper's keys are `string` (a summary may carry any key);
              // the label function answers every unknown key with the raw token, so
              // the cast only re-narrows the KNOWN closed set this report declares.
              (key) => hrLeaveRequestStatusLabel(key as HrLeaveRequestStatus)
            )}
          />

          {/* The export pair over the CURRENT query — same filters as list, chart and table. */}
          <ReportExportButtons
            testIdPrefix="hr-leave-report"
            buildPath={(format) => hrLeaveReportExportPath(query, format)}
          />


          <section
            className="rounded-2xl border border-border bg-card"
            data-testid="hr-leave-report-table"
            aria-busy={busy}
          >
            {data.items.length === 0 ? (
              <ReportingEmptyState
                testId="hr-leave-report-empty"
                message="برای این فیلترها درخواست مرخصی‌ای یافت نشد."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-3 text-start font-medium">
                        کد پرسنلی
                      </th>
                      <th scope="col" className="px-3 py-3 text-start font-medium">
                        نوع مرخصی
                      </th>
                      <th scope="col" className="px-3 py-3 text-start font-medium">
                        بازه درخواست
                      </th>
                      <th scope="col" className="px-3 py-3 text-start font-medium">
                        وضعیت
                      </th>
                      <th
                        scope="col"
                        className="hidden px-3 py-3 text-start font-medium sm:table-cell"
                      >
                        تاریخ ثبت
                      </th>
                      <th
                        scope="col"
                        className="hidden px-3 py-3 text-start font-medium sm:table-cell"
                      >
                        جزئیات
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {data.items.map((row) => (
                      <tr
                        key={row.id}
                        data-testid={`hr-leave-report-row-${row.id}`}
                        className="border-b border-border/60 last:border-b-0"
                      >
                        <td className="px-3 py-3">
                          <Link
                            href={`/admin/reporting/hr/leave-requests/${row.id}`}
                            data-testid={`hr-leave-report-row-link-${row.id}`}
                            className="font-medium text-foreground underline-offset-4 hover:underline"
                          >
                            {row.employeeCode}
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">
                          {row.leaveTypeName}
                          <span className="ms-1 text-xs opacity-70">({row.leaveTypeCode})</span>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">
                          <span className="tabular-nums">
                            {hrLeavePeriodLabel(row.startDate, row.endDate)}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="hidden px-3 py-3 tabular-nums text-muted-foreground sm:table-cell">
                          {toPersianDigits(row.createdAt.slice(0, 10))}
                        </td>
                        <td className="hidden px-3 py-3 sm:table-cell">
                          <Link
                            href={`/admin/reporting/hr/leave-requests/${row.id}`}
                            data-testid={`hr-leave-report-row-details-${row.id}`}
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
            )}

            {data.total > data.pageSize && (
              <nav
                className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm"
                data-testid="hr-leave-report-pagination"
                aria-label="صفحه‌بندی"
              >
                <button
                  type="button"
                  data-testid="hr-leave-report-pagination-prev"
                  disabled={page <= 1 || busy}
                  onClick={() => setPage((value) => value - 1)}
                  className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                  قبلی
                </button>
                <span
                  className="text-muted-foreground"
                  data-testid="hr-leave-report-pagination-status"
                >
                  صفحه {toPersianDigits(page)} از{' '}
                  {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
                </span>
                <button
                  type="button"
                  data-testid="hr-leave-report-pagination-next"
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
        </>
      ) : null}
    </div>
  );
}
