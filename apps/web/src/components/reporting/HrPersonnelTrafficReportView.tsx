'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { CoreJalaliDatePicker } from '@/components/core/CoreJalaliDatePicker';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  getCalendarToday,
  parseDateKey,
  toPersianDigits,
  type CalendarDay,
} from '@/lib/calendar-api';
import {
  HR_ATTENDANCE_SOURCES,
  HR_PERSONNEL_TRAFFIC_PAGE_SIZE,
  fetchHrPersonnelTrafficReport,
  hrPersonnelTrafficReportExportPath,
  type HrAttendanceSource,
  type ReportingPersonnelTrafficPage,
  type ReportingPersonnelTrafficQuery,
} from '@/lib/hr-personnel-traffic-report-api';
import {
  hrAttendanceDayLabel,
  hrAttendanceSourceLabel,
  hrAttendanceSourceTone,
  hrInstantTimeLabel,
  hrWeekdayLabel,
  type HrTone,
} from '@/lib/hr-api';
import { ReportingEmptyState } from './ReportingEmptyState';
import { ReportExportButtons } from './ReportExportButtons';
import { ReportSummaryChart } from './ReportSummaryChart';
import { buildReportChartBuckets } from '@/lib/report-chart';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the fourth Reporting workspace —
 * «گزارش تردد پرسنل» at `/admin/reporting/hr/personnel-traffic`.
 *
 * WHAT THIS SCREEN IS: a READ-ONLY surface over the attendance register HR owns.
 * Structure, top to bottom (the same steps the three sibling reports established):
 *
 *   page heading (h2 — the shell header owns the document's h1)
 *        ↓
 *   report identity (h3) + one explanation sentence
 *        ↓
 *   filter bar — exactly the register-supported filters: one bounded day shape
 *   (a Jalali day OR a Gregorian range — the same mutual exclusivity the API
 *   refuses with a 400, made structural here so the screen cannot build it),
 *   the source vocabulary, and the employee-code search
 *        ↓
 *   summary strip — per-source counts over the SAME filtered population
 *        ↓
 *   report table (the primary workspace) + pagination
 *
 * WHAT IT IS NOT: no attendance workflow screen (no punch, no correction — those live
 * in HR's own register), no dashboard, no export, no scheduling, no AI, and no
 * attendance rate / duration / punctuality figure anywhere: the HR schema stores none
 * of them (§13), so no cell here computes one. The backend isolation suite pins each
 * absence; the scope test in the spec pins it here.
 *
 * FILTER HONESTY: filters go to the SERVER query — only the four the source contract
 * supports (`dateKey`/`from`+`to`, `source`, `search`), never a client-side sieve over
 * one page, never an `employeeId` raw-uuid filter the report refuses to label.
 *
 * SUMMARY HONESTY: every number is `summary` straight from the API — a database
 * aggregation over the SAME filter. The component never counts rows itself. The chips
 * ARE the source filter: clicking one changes the query and the numbers re-derive.
 *
 * SOURCE VOCABULARY: the API carries the register's two members (`DEVICE`, `MANUAL`);
 * `hrAttendanceSourceLabel` / `hrAttendanceSourceTone` are the existing HR
 * presentation mappings — one vocabulary («پانچ دستگاه» / «اصلاح دستی»), no
 * Reporting-specific state, colour always a second channel.
 *
 * STATES: forbidden (no `hr.attendance.read`) → incomplete window (prompt, no request,
 * never a fake «۰ رکورد») → error (Persian + retry) → initial loading (skeleton) →
 * empty («برای این فیلترها…») → data. Rows stay visible during a background refetch.
 */
const TONE_CLASSES: Record<HrTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** The source word — never colour alone (phase brief §25). */
function SourceBadge({ source }: { source: HrAttendanceSource }) {
  return (
    <span
      data-testid={`hr-personnel-traffic-report-source-${source}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[hrAttendanceSourceTone(source)]}`}
    >
      {hrAttendanceSourceLabel(source)}
    </span>
  );
}

type DateMode = 'day' | 'range';

interface AppliedFilters {
  dateKey: string;
  from: string;
  to: string;
  source: HrAttendanceSource | '';
  search: string;
}

const EMPTY_FILTERS: AppliedFilters = { dateKey: '', from: '', to: '', source: '', search: '' };

export function HrPersonnelTrafficReportView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `hr.attendance.read` on all three
  // routes regardless — this only skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('hr.attendance.read');

  const [dateMode, setDateMode] = React.useState<DateMode>('day');
  const [dateKeyInput, setDateKeyInput] = React.useState('');
  const [fromInput, setFromInput] = React.useState('');
  const [toInput, setToInput] = React.useState('');
  const [sourceInput, setSourceInput] = React.useState<HrAttendanceSource | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [applied, setApplied] = React.useState<AppliedFilters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ReportingPersonnelTrafficPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const seededRef = React.useRef(false);

  // The SERVER's today: the report's default window AND the month the Jalali grid
  // opens on. It is never computed here — a screen that picked the day itself could
  // report on a day the server does not call today.
  React.useEffect(() => {
    let active = true;
    getCalendarToday()
      .then((day) => {
        if (active) setToday(day);
      })
      .catch(() => {
        if (active) setToday(null);
      });
    return () => {
      active = false;
    };
  }, []);

  /** Seed the default window from the server's own today — once. */
  React.useEffect(() => {
    if (seededRef.current || !today) return;
    seededRef.current = true;
    setApplied((prev) =>
      prev.dateKey || prev.from || prev.to ? prev : { ...prev, dateKey: today.date }
    );
    setDateKeyInput((prev) => (prev ? prev : today.date));
  }, [today]);

  const hasWindow = applied.dateKey !== '' || (applied.from !== '' && applied.to !== '');

  // THE query — one object the list fetch, the export path and the chart all derive
  // from: exactly ONE date shape (the two are mutually exclusive by construction, so
  // the API's 400 for sending both cannot be reached from this screen), the source and
  // the code search. Declared BEFORE the effect that reads it, so there is a single
  // unambiguous binding per render — table and file are the same question asked twice.
  // Memoized so the effect below re-runs only when one of the five query inputs
  // actually changes (`react-hooks/immutability`: a fresh object literal would
  // re-trigger on every render) — this also lets the effect depend on the query
  // object itself instead of its spread primitives.
  const reportQuery: ReportingPersonnelTrafficQuery = React.useMemo(
    () => ({
      page,
      pageSize: HR_PERSONNEL_TRAFFIC_PAGE_SIZE,
      ...(applied.dateKey ? { dateKey: applied.dateKey } : { from: applied.from, to: applied.to }),
      source: applied.source === '' ? undefined : applied.source,
      search: applied.search,
    }),
    [page, applied],
  );

  React.useEffect(() => {
    // No request before the grants are known, none without the read the route
    // demands, and NONE without a complete window: a report that rendered «۰ رکورد»
    // for a window nobody chose would be reporting a fact it does not have.
    if (!isAuthenticated || rbac.isLoading || !canRead || !hasWindow) return;

    let active = true;

    fetchHrPersonnelTrafficReport(reportQuery)
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
  }, [isAuthenticated, rbac.isLoading, canRead, hasWindow, reportQuery, reloadToken]);

  // Whether a request cycle is meaningfully in flight. `isLoading` covers
  // retries (armed by the hook above, settled by the fetch effect); the
  // derived term covers the FIRST load, where no handler ever arms it: once
  // the gate — including this view's INCOMPLETE-WINDOW condition — has settled
  // and neither data nor error has arrived yet, the view is by definition
  // waiting for its first response. The `hasWindow` term matters: a windowless
  // mount must show the window prompt, never a skeleton (the spec pins that
  // no request is made and no fake «۰ رکورد» is rendered for it). This
  // replaces the previous in-effect `setLoading(true)` reset
  // (`react-hooks/set-state-in-effect`): the effect body now only settles.
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead && hasWindow;
  const busy = isLoading || (gateSettled && data === null && error === null);
  const items = data?.items ?? [];
  const summary = data?.summary;

  const sourceOptions = React.useMemo(
    () => [
      { value: '', label: 'همه منابع' },
      ...HR_ATTENDANCE_SOURCES.map((source) => ({
        value: source,
        label: hrAttendanceSourceLabel(source),
      })),
    ],
    []
  );

  /**
   * Switching the SHAPE of the date slot clears the other shape, because the contract
   * refuses `dateKey` together with `from`/`to`. Request-shape bookkeeping rather than
   * a business rule: the screen is choosing which of the API's two BOUNDED filters it
   * is asking with, and it makes that choice visible instead of hiding it.
   */
  const handleDateMode = (next: DateMode) => {
    setDateMode(next);
    if (next === 'day') {
      setFromInput('');
      setToInput('');
    } else {
      setDateKeyInput('');
    }
  };

  /** The month the Jalali picker opens on: the chosen day, else the SERVER's today. */
  const pickerInitialMonth = React.useMemo(() => {
    if (dateKeyInput) {
      const parsed = parseDateKey(dateKeyInput);
      if (parsed) return { jy: parsed.jy, jm: parsed.jm };
    }
    if (today) return { jy: today.jy, jm: today.jm };
    return { jy: 1405, jm: 1 };
  }, [dateKeyInput, today]);

  /** The bound THIS screen sent — a fact about the request, not a derived metric. */
  const windowLabel = hasWindow
    ? applied.dateKey
      ? `${hrAttendanceDayLabel(applied.dateKey)} (شمسی)`
      : `${applied.from} تا ${applied.to} (میلادی)`
    : '';

  let windowPrompt = 'برای اجرای گزارش یک روز شمسی انتخاب کنید.';
  if (dateMode === 'range') {
    windowPrompt = 'برای اجرای گزارش هر دو تاریخ «از» و «تا» را انتخاب کنید.';
  }

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="hr-personnel-traffic-report-view">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="hr-personnel-traffic-report-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">گزارش‌گیری</h2>
          <p className="mt-1 text-sm text-muted-foreground">فضای کاری گزارش‌های سازمان شما</p>
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground sm:text-lg">گزارش تردد پرسنل</h3>
          <p className="mt-1 max-w-3xl text-sm leading-7 text-muted-foreground">
            رکوردهای ثبت‌شده ورود و خروج پرسنل در دفتر حضور و غیاب، همراه با منبع ثبت و بازهٔ روزانه
            — خواندنی و بدون اثر؛ هیچ ثبت یا اصلاحی در دفتر ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      <section
        className="core-card mb-4 p-4 sm:p-5"
        data-testid="hr-personnel-traffic-report-filters"
      >
        <form
          role="search"
          aria-label="فیلترهای گزارش تردد پرسنل"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({
              dateKey: dateMode === 'day' ? dateKeyInput : '',
              from: dateMode === 'range' ? fromInput : '',
              to: dateMode === 'range' ? toInput : '',
              source: sourceInput,
              search: searchInput.trim(),
            });
            setPage(1);
          }}
        >
          <div className="flex min-w-44 flex-col gap-1">
            <label
              htmlFor="hr-personnel-traffic-report-date-mode"
              className="text-xs text-muted-foreground"
            >
              بازه زمانی
            </label>
            <select
              id="hr-personnel-traffic-report-date-mode"
              data-testid="hr-personnel-traffic-report-date-mode"
              value={dateMode}
              disabled={busy}
              onChange={(event) => handleDateMode(event.target.value as DateMode)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="day">یک روز (شمسی)</option>
              <option value="range">بازه میلادی (از/تا)</option>
            </select>
          </div>

          {dateMode === 'day' ? (
            <div className="flex min-w-60 flex-col gap-1">
              <span className="text-xs text-muted-foreground" id="hr-personnel-traffic-report-day">
                روز (شمسی)
              </span>
              <div data-testid="hr-personnel-traffic-report-day-picker">
                {today ? (
                  <CoreJalaliDatePicker
                    value={dateKeyInput || null}
                    onSelect={(date) => setDateKeyInput(date)}
                    initialMonth={pickerInitialMonth}
                    todayKey={today.date}
                  />
                ) : (
                  <div className="h-10 w-48 animate-pulse rounded-xl bg-muted" aria-hidden="true" />
                )}
              </div>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="hr-personnel-traffic-report-day-value"
              >
                {dateKeyInput ? hrAttendanceDayLabel(dateKeyInput) : '—'}
                <span className="sr-only" data-testid="hr-personnel-traffic-report-day-raw">
                  {dateKeyInput}
                </span>
              </span>
            </div>
          ) : (
            <>
              <div className="flex min-w-40 flex-col gap-1">
                <label
                  htmlFor="hr-personnel-traffic-report-from"
                  className="text-xs text-muted-foreground"
                >
                  از (میلادی)
                </label>
                <input
                  id="hr-personnel-traffic-report-from"
                  type="date"
                  data-testid="hr-personnel-traffic-report-from"
                  value={fromInput}
                  disabled={busy}
                  onChange={(event) => setFromInput(event.target.value)}
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
                />
              </div>
              <div className="flex min-w-40 flex-col gap-1">
                <label
                  htmlFor="hr-personnel-traffic-report-to"
                  className="text-xs text-muted-foreground"
                >
                  تا (میلادی)
                </label>
                <input
                  id="hr-personnel-traffic-report-to"
                  type="date"
                  data-testid="hr-personnel-traffic-report-to"
                  value={toInput}
                  disabled={busy}
                  onChange={(event) => setToInput(event.target.value)}
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
                />
              </div>
            </>
          )}

          <div className="flex min-w-40 flex-col gap-1">
            <label
              htmlFor="hr-personnel-traffic-report-source"
              className="text-xs text-muted-foreground"
            >
              منبع ثبت
            </label>
            <select
              id="hr-personnel-traffic-report-source"
              data-testid="hr-personnel-traffic-report-source-filter"
              value={sourceInput}
              disabled={busy}
              onChange={(event) => setSourceInput(event.target.value as HrAttendanceSource | '')}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
            >
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label
              htmlFor="hr-personnel-traffic-report-search"
              className="text-xs text-muted-foreground"
            >
              جستجو در کد پرسنلی
            </label>
            <input
              id="hr-personnel-traffic-report-search"
              type="search"
              data-testid="hr-personnel-traffic-report-search-input"
              value={searchInput}
              disabled={busy}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="کد پرسنلی…"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <button
            type="submit"
            data-testid="hr-personnel-traffic-report-apply-filters"
            disabled={busy}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            اعمال فیلترها
          </button>

          {hasWindow || sourceInput !== '' || searchInput !== '' ? (
            <button
              type="button"
              data-testid="hr-personnel-traffic-report-clear-filters"
              disabled={busy}
              onClick={() => {
                setDateKeyInput(today ? today.date : '');
                setFromInput('');
                setToInput('');
                setSourceInput('');
                setSearchInput('');
                setDateMode('day');
                setApplied(today ? { ...EMPTY_FILTERS, dateKey: today.date } : EMPTY_FILTERS);
                setPage(1);
              }}
              className="h-10 rounded-xl border border-border px-4 text-sm text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </form>
      </section>

      {/* The window THIS screen actually sent — a fact about the request, never a
          derived metric. Rendered only while one exists. */}
      {hasWindow && (
        <p
          className="mb-4 text-xs text-muted-foreground"
          data-testid="hr-personnel-traffic-report-window"
        >
          بازه پرس‌وجو: {windowLabel}
        </p>
      )}

      {/* SUMMARY STRIP — every number comes from `summary` (the API's database
          aggregation over the SAME filter); this component never counts a row.
          The chips ARE the source filter: clicking one changes the query and the
          numbers re-derive from the new population. */}
      <section
        aria-label="خلاصه منابع ثبت تردد"
        data-testid="hr-personnel-traffic-report-summary"
        className="core-card mb-4 p-4 sm:p-5"
      >
        {summary ? (
          <ul className="flex flex-wrap gap-2">
            <li>
              <button
                type="button"
                data-testid="hr-personnel-traffic-report-summary-all"
                aria-pressed={applied.source === ''}
                disabled={busy}
                onClick={() => {
                  setSourceInput('');
                  setApplied((prev) => ({ ...prev, source: '' }));
                  setPage(1);
                }}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                  applied.source === ''
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-background text-foreground hover:bg-secondary'
                }`}
              >
                همه
                <span
                  className="tabular-nums"
                  data-testid="hr-personnel-traffic-report-summary-all-count"
                >
                  {toPersianDigits(summary.total)}
                </span>
              </button>
            </li>
            {HR_ATTENDANCE_SOURCES.map((source) => (
              <li key={source}>
                <button
                  type="button"
                  data-testid={`hr-personnel-traffic-report-summary-source-${source}`}
                  aria-pressed={applied.source === source}
                  disabled={busy}
                  onClick={() => {
                    const next = applied.source === source ? '' : source;
                    setSourceInput(next);
                    setApplied((prev) => ({ ...prev, source: next }));
                    setPage(1);
                  }}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                    applied.source === source
                      ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-secondary'
                  }`}
                >
                  {hrAttendanceSourceLabel(source)}
                  <span
                    className="tabular-nums"
                    data-testid={`hr-personnel-traffic-report-summary-count-${source}`}
                  >
                    {toPersianDigits(summary.bySource[source] ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : busy ? (
          // Compact placeholders with NO fake figures: the numbers appear only
          // when the API supplies them.
          <div aria-hidden="true" className="flex flex-wrap gap-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-8 w-28 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
        ) : !hasWindow ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="hr-personnel-traffic-report-summary-prompt"
          >
            {windowPrompt}
          </p>
        ) : null}
      </section>

      {summary ? (
        <>
          <ReportSummaryChart
            title="توزیع منبع ثبت"
            testId="hr-personnel-traffic-report"
            buckets={buildReportChartBuckets(summary.bySource, HR_ATTENDANCE_SOURCES, (source) =>
              hrAttendanceSourceLabel(source as HrAttendanceSource)
            )}
          />
          <div className="mb-4 flex justify-start">
            <ReportExportButtons
              testIdPrefix="hr-personnel-traffic-report"
              buildPath={(format) => hrPersonnelTrafficReportExportPath(reportQuery, format)}
            />
          </div>
        </>
      ) : null}

      {error && (
        <div className="mb-6" data-testid="hr-personnel-traffic-report-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 && hasWindow ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="hr-personnel-traffic-report-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گزارش…" lines={5} />
        </section>
      ) : !hasWindow && items.length === 0 ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="hr-personnel-traffic-report-table-card"
        >
          <ReportingEmptyState message={windowPrompt} testId="hr-personnel-traffic-report-prompt" />
        </section>
      ) : items.length === 0 && !error ? (
        <section
          className="core-card p-4 sm:p-6"
          data-testid="hr-personnel-traffic-report-table-card"
        >
          <ReportingEmptyState
            message="برای این فیلترها رکوردی پیدا نشد."
            testId="hr-personnel-traffic-report-empty"
          />
        </section>
      ) : items.length > 0 ? (
        <section className="core-card p-4 sm:p-6" data-testid="hr-personnel-traffic-report-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">گزارش تردد پرسنل</caption>
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    کد پرسنلی
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    روز (شمسی)
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                    روز هفته
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    ورود
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    خروج
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    منبع ثبت
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
                    data-testid={`hr-personnel-traffic-report-row-${row.id}`}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/reporting/hr/personnel-traffic/${row.id}`}
                        data-testid={`hr-personnel-traffic-report-row-link-${row.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {row.employeeCode}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <span className="tabular-nums">{hrAttendanceDayLabel(row.dateKey)}</span>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground sm:table-cell">
                      {hrWeekdayLabel(row.workDate)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <span className="tabular-nums">{hrInstantTimeLabel(row.clockIn)}</span>
                    </td>
                    <td className="hidden px-3 py-3 tabular-nums text-muted-foreground md:table-cell">
                      {hrInstantTimeLabel(row.clockOut)}
                    </td>
                    <td className="px-3 py-3">
                      <SourceBadge source={row.source} />
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <Link
                        href={`/admin/reporting/hr/personnel-traffic/${row.id}`}
                        data-testid={`hr-personnel-traffic-report-row-details-${row.id}`}
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
              data-testid="hr-personnel-traffic-report-pagination"
              aria-label="صفحه‌بندی"
            >
              <button
                type="button"
                data-testid="hr-personnel-traffic-report-pagination-prev"
                disabled={page <= 1 || busy}
                onClick={() => setPage((value) => value - 1)}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
                قبلی
              </button>
              <span
                className="text-muted-foreground"
                data-testid="hr-personnel-traffic-report-pagination-status"
              >
                صفحه {toPersianDigits(page)} از{' '}
                {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
              </span>
              <button
                type="button"
                data-testid="hr-personnel-traffic-report-pagination-next"
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
