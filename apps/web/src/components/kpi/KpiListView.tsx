'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { nextMonth, previousMonth, toPersianDigits } from '@/lib/calendar-api';
import {
  canReadAnyKpi,
  fetchKpis,
  type KpiComparison,
  type KpiListResult,
  type KpiResult,
} from '@/lib/kpi-api';
import {
  KPI_PERFORMANCE_NOTE,
  kpiAvailabilityLabel,
  kpiComparisonSummary,
  kpiComparisonUnavailableLabel,
  kpiDisplayUnitLabel,
  kpiFormulaKindLabel,
  kpiReadinessLabel,
  kpiSemanticUnitLabel,
  kpiUnavailableReasonLabel,
} from '@/lib/kpi-labels';

/**
 * Phase KPI-RUNTIME — the KPI overview at `/admin/kpis`: every approved KPI this caller may
 * read, for ONE Jalali month.
 *
 * WHAT THIS SCREEN IS: a READ-ONLY surface over five governed definitions. Structure:
 *
 *   page heading (h2 — the shell header owns the document's h1)
 *        ↓
 *   one explanation sentence
 *        ↓
 *   Jalali month picker (prev / «ماه جاری» / next) + the month actually served
 *        ↓
 *   authorization honesty line («۳ از ۵ شاخص برای شما نمایش داده می‌شود»)
 *        ↓
 *   a card per KPI — value, availability, DATA readiness — linking to the detail
 *
 * WHAT IT IS NOT: no target, no threshold, no traffic light, no trend arrow, no export.
 * All five definitions carry `target: NOT_DEFINED` and `thresholds: NOT_DEFINED`, so the
 * runtime serves `performance: 'NOT_ASSESSED'` and this screen renders `KPI_PERFORMANCE_NOTE`
 * instead of inventing a verdict. The colour words a card shows are DATA readiness, and the
 * sentence beside each one says so.
 *
 * THE PERIOD IS THE SERVER'S, NOT THE BROWSER'S. `period` starts `null`, meaning "you decide,
 * server"; the picker then reads `data.period.jy/jm` back out of the RESPONSE. So the month
 * on the label is the same month the numbers were cohorted on by construction — a browser
 * clock in a different timezone can never label one month while the server computed another.
 */

/** One KPI card — value first, then the two honest qualifiers. */
function KpiCard({
  kpi,
  comparison,
}: {
  kpi: KpiResult;
  comparison: KpiComparison | null | undefined;
}) {
  const available = kpi.availability === 'AVAILABLE';

  // The authorised display conversion when one exists, otherwise the governed value in its
  // own semantic unit — never a re-derivation, and never a `0` standing in for "no value".
  const rendered = available
    ? kpi.display
      ? `${toPersianDigits(kpi.display.value)} ${kpiDisplayUnitLabel(kpi.display.unitToken)}`
      : `${toPersianDigits(kpi.value ?? 0)} ${kpiSemanticUnitLabel(kpi.unit.semantic)}`
    : null;

  return (
    <article
      className="core-card flex flex-col gap-3 p-4 sm:p-5"
      data-testid={`kpi-card-${kpi.technicalKey}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground sm:text-base">{kpi.nameFa}</h4>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          {kpiFormulaKindLabel(kpi.governance.formulaKind)}
        </span>
      </div>

      <p className="text-xs leading-6 text-muted-foreground">{kpi.businessQuestion}</p>

      {available ? (
        <p
          className="text-2xl font-bold text-foreground"
          data-testid={`kpi-value-${kpi.technicalKey}`}
        >
          {rendered}
        </p>
      ) : (
        <div data-testid={`kpi-unavailable-${kpi.technicalKey}`}>
          <p className="text-2xl font-bold text-muted-foreground">—</p>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            {kpiUnavailableReasonLabel(kpi.unavailableReason)}
          </p>
        </div>
      )}

      {/*
       * Phase KPI-HISTORICAL-INTELLIGENCE — the period-over-period delta, in NEUTRAL
       * colours on purpose: no target or threshold exists, so a decrease must not read
       * as «bad» (red) nor an increase as «good» (green). The arrow and the word state
       * the MATHEMATICAL movement only, and the period it moved across.
       */}
      {comparison ? (
        comparison.availability === 'AVAILABLE' ? (
          <p
            className="flex items-center gap-1.5 text-sm font-medium text-foreground"
            data-testid={`kpi-comparison-${kpi.technicalKey}`}
          >
            <span aria-hidden="true">
              {comparison.direction === 'INCREASE'
                ? '↑'
                : comparison.direction === 'DECREASE'
                  ? '↓'
                  : '→'}
            </span>
            <span>{kpiComparisonSummary(comparison, toPersianDigits, kpiSemanticUnitLabel)}</span>
          </p>
        ) : (
          <p
            className="text-xs leading-6 text-muted-foreground"
            data-testid={`kpi-comparison-unavailable-${kpi.technicalKey}`}
          >
            {kpiComparisonUnavailableLabel(comparison.unavailableReason)}
          </p>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          {kpi.period.monthName} {toPersianDigits(kpi.period.jy)}
          {kpi.period.completed === false ? ' (در جریان)' : ''}
        </span>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            available
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-border bg-muted text-muted-foreground'
          }`}
        >
          {kpiAvailabilityLabel(kpi.availability)}
        </span>
        <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">
          داده: {kpiReadinessLabel(kpi.quality.readiness)}
        </span>
      </div>

      <p className="text-[11px] leading-5 text-muted-foreground">{KPI_PERFORMANCE_NOTE}</p>

      <Link
        href={`/admin/kpis/${encodeURIComponent(kpi.technicalKey)}`}
        className="text-xs font-medium text-primary hover:underline"
      >
        جزئیات و شیوه محاسبه
      </Link>
    </article>
  );
}

export function KpiListView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation-only gate: the SERVER enforces `@Roles(...KPI_READ_REMITS)` plus a
  // per-definition permission and entitlement check on both routes regardless — this only
  // skips a request that cannot succeed.
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || canReadAnyKpi(rbac.permissions);

  /** `null` = "server, you pick the current month"; otherwise the month we asked for. */
  const [period, setPeriod] = React.useState<{ jy: number; jm: number } | null>(null);
  const [data, setData] = React.useState<KpiListResult | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchKpis(period ?? {})
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError('دریافت شاخص‌ها با خطا مواجه شد. لطفاً دوباره تلاش کنید.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, period, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="kpi-list-view">
        <CoreForbidden />
      </div>
    );
  }

  // The month ON SCREEN is always the month the SERVER computed for — never a browser clock.
  const served = data?.period;
  // Whether a request cycle is meaningfully in flight. `isLoading` covers retries
  // (armed by the hook above, settled by the fetch effect); the derived term covers
  // the FIRST load, where no handler ever arms it: once the gate (which by design
  // does NOT include `period` — `null` simply means the server picks the current
  // month) has settled and neither data nor error has arrived, the view is by
  // definition waiting for its first response. This replaces the previous
  // in-effect `setLoading(true)` reset (`react-hooks/set-state-in-effect`): the
  // effect body now only settles.
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead;
  const busy = isLoading || (gateSettled && data === null && error === null);

  return (
    <div data-testid="kpi-list-view">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
            شاخص‌های کلیدی عملکرد
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            پنج شاخص مصوب سازمان، برای یک ماه شمسی، به‌صورت فقط‌خواندنی
          </p>
        </div>
        <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
          هر عدد در این صفحه از تعریف مصوب شاخص محاسبه می‌شود. برچسب کنار هر شاخص وضعیت کیفیت داده
          است، نه ارزیابی عملکرد؛ هدف و آستانه برای این شاخص‌ها تعریف نشده است.
        </p>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-period-picker">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="ماه قبل"
              data-testid="kpi-prev-month"
              disabled={busy || !served}
              onClick={() => served && setPeriod(previousMonth(served.jy, served.jm))}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>

            <span className="text-sm font-medium text-foreground" data-testid="kpi-period-label">
              {served ? `${served.monthName} ${toPersianDigits(served.jy)}` : '—'}
            </span>

            <button
              type="button"
              aria-label="ماه بعد"
              data-testid="kpi-next-month"
              disabled={busy || !served}
              onClick={() => served && setPeriod(nextMonth(served.jy, served.jm))}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            data-testid="kpi-current-month"
            disabled={busy || period === null}
            onClick={() => setPeriod(null)}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ماه جاری
          </button>
        </div>

        {data && data.visible < data.total ? (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="kpi-visibility">
            {toPersianDigits(data.visible)} از {toPersianDigits(data.total)} شاخص برای شما نمایش
            داده می‌شود.
          </p>
        ) : null}
      </section>

      {error ? (
        <CoreError message={error} onRetry={reload} />
      ) : !data && busy ? (
        <CoreLoading label="در حال دریافت شاخص‌ها..." />
      ) : data && data.items.length === 0 ? (
        <div data-testid="kpi-list-empty">
          <CoreEmpty message="هیچ شاخصی برای شما مجاز نیست." />
        </div>
      ) : data ? (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="kpi-list-grid"
        >
          {data.items.map((kpi) => (
            <KpiCard
              key={kpi.technicalKey}
              kpi={kpi}
              comparison={data.comparisons?.[kpi.technicalKey]}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
