'use client';

import * as React from 'react';
import Link from 'next/link';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { toPersianDigits } from '@/lib/calendar-api';
import { fetchCommercePendingDecisionsCount } from '@/lib/commerce-pending-api';
import { fetchMissionApprovalsPendingCount } from '@/lib/hr-mission-pending-count';
import { canReadAnyKpi, fetchKpis, type KpiComparison, type KpiResult } from '@/lib/kpi-api';
import {
  KPI_PERFORMANCE_NOTE,
  kpiAvailabilityLabel,
  kpiComparisonSummary,
  kpiComparisonUnavailableLabel,
  kpiDisplayUnitLabel,
  kpiReadinessLabel,
  kpiSemanticUnitLabel,
  kpiUnavailableReasonLabel,
} from '@/lib/kpi-labels';
import { ReportSummaryChart } from '@/components/reporting/ReportSummaryChart';
import { buildReportChartBuckets, isReportChartEmpty } from '@/lib/report-chart';
import { fetchCheckRequestReport, REPORTING_CHECK_REQUEST_STATUSES } from '@/lib/reporting-api';
import { fetchProductionReport, PRODUCTION_REPORT_STATUSES } from '@/lib/production-report-api';
import { fetchPurchaseReport, PURCHASE_REPORT_STATUSES } from '@/lib/purchase-report-api';
import { commerceDocumentStatusLabel } from '@/lib/commerce-labels';
import { financialStatusLabel } from '@/lib/financial-labels';
import { PRODUCTION_BOM_STATUS_LABELS } from '@/lib/production-labels';

/**
 * Phase MANAGEMENT-DASHBOARD-V1 (corrective): the management dashboard at `/admin/management`.
 *
 * A FRONTEND COMPOSITION of six existing governed sources. No new API, no cache, no polling,
 * no per-row fan-out. Each card owns its own request and state.
 *
 * PERMISSION MODEL (presentation-only; every source re-authorizes on the server):
 *   - A card whose remit the caller LACKS is NOT MOUNTED: it issues NO request and renders nothing.
 *   - A card that IS issued and then refused by its source shows FORBIDDEN (403).
 *   - A caller holding none of the four remits gets a page-level forbidden state and zero requests.
 *
 * CARD STATES: loading | ready | forbidden (403) | unavailable (404/405) | error (5xx / network).
 * A non-ready card is never rendered as a zero.
 *
 * TIME SEMANTICS: the KPI card is the flow of the current Jalali month (server-resolved, read from
 * the response). Status and queue cards are stock as-of-now («وضعیت فعلی»).
 *
 * PII RULE: the two queues show a COUNT only. No inbox row is rendered here.
 *
 * DRILL-DOWN: every card links to an EXISTING page. Financial drills to `/admin/reporting`, which IS
 * the Financial check-request register/index (its detail route is `/admin/reporting/check-requests/[id]`).
 * No dedicated rail row exists for that register; this dashboard is its primary direct entry.
 */

/** The four approved remits. Presentation mirror of the server constants; the server stays decisive. */
const REMIT_PRODUCTION = 'production.bom.read';
const REMIT_COMMERCE = 'commerce.read';
const REMIT_FINANCIAL = 'financial.check.read';
const REMIT_MISSION_APPROVE = 'hr.mission.approve';
const DASHBOARD_REMITS = [REMIT_PRODUCTION, REMIT_COMMERCE, REMIT_FINANCIAL, REMIT_MISSION_APPROVE];

type CardState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'forbidden' }
  | { status: 'unavailable' }
  | { status: 'error' };

/**
 * 403 → forbidden. 404/405 (route or deployment gap) → unavailable.
 * 5xx, network, timeout, or any other unexpected failure → error (retryable).
 * A 500 is NEVER presented as unavailable.
 */
function failureState(error: unknown): CardState<never> {
  if (error instanceof CoreApiError) {
    if (error.status === 403) return { status: 'forbidden' };
    if (error.status === 404 || error.status === 405) return { status: 'unavailable' };
  }
  return { status: 'error' };
}

/**
 * Runs one source load. `refreshToken` is the page-level manual refresh; `retryToken` is this card's
 * own retry. The card is only mounted when issued, so an absent remit never reaches this effect.
 */
function useCardSource<T>(load: () => Promise<T>, refreshToken: number) {
  const [state, setState] = React.useState<CardState<T>>({ status: 'loading' });
  const [retryToken, setRetryToken] = React.useState(0);
  const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);

  // A refresh or a retry is a NEW load: re-arm the loading state in the same
  // commit the token moves (`react-hooks/set-state-in-effect` bars the
  // effect-body arm this used to carry). Mount is covered by the initial
  // state above.
  const tokens = `${refreshToken}|${retryToken}`;
  const [prevTokens, setPrevTokens] = React.useState(tokens);
  if (prevTokens !== tokens) {
    setPrevTokens(tokens);
    setState({ status: 'loading' });
  }

  React.useEffect(() => {
    let active = true;
    load()
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (active) setState(failureState(error));
      });
    return () => {
      active = false;
    };
    // `load` is a fresh closure each render; the two tokens are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, retryToken]);

  return { state, retry };
}

/** Shared frame for every card: title, time-semantics subtitle, drill-down link, and the body. */
function CardFrame({
  testId,
  title,
  subtitle,
  drillHref,
  children,
}: {
  testId: string;
  title: string;
  subtitle: React.ReactNode;
  drillHref: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} aria-label={title} className="core-card flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground sm:text-base">{title}</h3>
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-subtitle`}>
            {subtitle}
          </p>
        </div>
        <Link href={drillHref} className="shrink-0 text-xs text-primary underline-offset-4 hover:underline">
          مشاهده جزئیات
        </Link>
      </div>
      {children}
    </section>
  );
}

/** Non-ready states shared by every card. Each is distinct; none is rendered as a zero. */
function CardFailure({
  testId,
  state,
  retry,
}: {
  testId: string;
  state: CardState<unknown>;
  retry: () => void;
}) {
  if (state.status === 'loading') return <CoreLoading lines={3} />;
  if (state.status === 'forbidden') {
    return (
      <div data-testid={`${testId}-forbidden`}>
        <CoreForbidden message="این کارت برای شما در دسترس نیست." />
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div data-testid={`${testId}-unavailable`}>
        <CoreEmpty message="در حال حاضر در دسترس نیست." />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div data-testid={`${testId}-error`}>
        <CoreError message="خطا در دریافت اطلاعات." onRetry={retry} />
      </div>
    );
  }
  return null;
}

/** MGT-QUE-01 / MGT-QUE-02: a single count of work waiting. Count only, never rows. */
function QueueCard({
  testId,
  title,
  drillHref,
  load,
  emptyMessage,
  refreshToken,
}: {
  testId: string;
  title: string;
  drillHref: string;
  load: () => Promise<number>;
  emptyMessage: string;
  refreshToken: number;
}) {
  const { state, retry } = useCardSource(load, refreshToken);

  return (
    <CardFrame testId={testId} title={title} subtitle="وضعیت فعلی" drillHref={drillHref}>
      <CardFailure testId={testId} state={state} retry={retry} />
      {state.status === 'ready' &&
        (state.data === 0 ? (
          <CoreEmpty message={emptyMessage} />
        ) : (
          <p data-testid={`${testId}-count`} className="text-2xl font-bold text-foreground">
            {toPersianDigits(state.data)}
          </p>
        ))}
    </CardFrame>
  );
}

/**
 * One KPI tile. Every number is the server's: the value, the display conversion, and the
 * comparison. Nothing is recomputed here. A missing value is «—», never a zero.
 */
function KpiTile({ kpi, comparison }: { kpi: KpiResult; comparison: KpiComparison | null | undefined }) {
  const available = kpi.availability === 'AVAILABLE';
  const rendered = !available
    ? null
    : kpi.display
      ? `${toPersianDigits(kpi.display.value)} ${kpiDisplayUnitLabel(kpi.display.unitToken)}`
      : kpi.value !== null
        ? `${toPersianDigits(kpi.value)} ${kpiSemanticUnitLabel(kpi.unit.semantic)}`
        : null;

  return (
    <li
      data-testid={`mgt-kpi-${kpi.technicalKey}`}
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <Link
        href={`/admin/kpis/${encodeURIComponent(kpi.technicalKey)}`}
        className="text-sm font-medium text-foreground hover:underline"
      >
        {kpi.nameFa}
      </Link>

      {rendered !== null ? (
        <p className="text-xl font-bold text-foreground" data-testid={`mgt-kpi-value-${kpi.technicalKey}`}>
          {rendered}
        </p>
      ) : (
        <div data-testid={`mgt-kpi-unavailable-${kpi.technicalKey}`}>
          <p className="text-xl font-bold text-muted-foreground">—</p>
          <p className="text-xs leading-6 text-muted-foreground">
            {kpiUnavailableReasonLabel(kpi.unavailableReason)}
          </p>
        </div>
      )}

      {comparison ? (
        comparison.availability === 'AVAILABLE' ? (
          <p className="text-sm text-foreground" data-testid={`mgt-kpi-comparison-${kpi.technicalKey}`}>
            {kpiComparisonSummary(comparison, toPersianDigits, kpiSemanticUnitLabel)}
          </p>
        ) : (
          <p
            className="text-xs leading-6 text-muted-foreground"
            data-testid={`mgt-kpi-comparison-unavailable-${kpi.technicalKey}`}
          >
            {kpiComparisonUnavailableLabel(comparison.unavailableReason)}
          </p>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {kpi.period.monthName} {toPersianDigits(kpi.period.jy)}
          {kpi.period.completed === false ? ' (در جریان)' : ''}
        </span>
        <span>· {kpiAvailabilityLabel(kpi.availability)}</span>
        <span>· داده: {kpiReadinessLabel(kpi.quality.readiness)}</span>
      </div>
      <p className="text-[11px] leading-5 text-muted-foreground">{KPI_PERFORMANCE_NOTE}</p>
    </li>
  );
}

/**
 * MGT-KPI-01: the KPI strip for the CURRENT Jalali month, as the server resolved it. The period
 * shown is read from the response; the browser never derives a month. Comparisons come from the
 * server's `comparisons`; no browser-side delta is computed.
 */
function KpiStripCard({ refreshToken }: { refreshToken: number }) {
  const { state, retry } = useCardSource(() => fetchKpis(), refreshToken);
  const subtitle =
    state.status === 'ready'
      ? `ماه جاری: ${state.data.period.monthName} ${toPersianDigits(state.data.period.jy)}${
          state.data.period.completed === false ? ' (در جریان)' : ''
        } · سمت سرور`
      : 'ماه جاری (سمت سرور)';

  return (
    <CardFrame testId="mgt-kpi-01" title="شاخصهای کلیدی — ماه جاری" subtitle={subtitle} drillHref="/admin/kpis">
      <CardFailure testId="mgt-kpi-01" state={state} retry={retry} />
      {state.status === 'ready' &&
        (state.data.items.length === 0 ? (
          <CoreEmpty message="شاخصی برای نمایش نیست." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {state.data.items.map((kpi) => (
              <KpiTile key={kpi.technicalKey} kpi={kpi} comparison={state.data.comparisons?.[kpi.technicalKey]} />
            ))}
          </ul>
        ))}
    </CardFrame>
  );
}

/** A status-distribution card: the report's OWN server `summary`, rendered via `ReportSummaryChart`. */
function DistributionCard<T extends { summary: { byStatus: Record<string, number> } }>({
  testId,
  title,
  drillHref,
  load,
  order,
  label,
  refreshToken,
}: {
  testId: string;
  title: string;
  drillHref: string;
  load: () => Promise<T>;
  order: readonly (string | number)[];
  label: (key: string) => string;
  refreshToken: number;
}) {
  const { state, retry } = useCardSource(load, refreshToken);

  return (
    <CardFrame testId={testId} title={title} subtitle="وضعیت فعلی" drillHref={drillHref}>
      <CardFailure testId={testId} state={state} retry={retry} />
      {state.status === 'ready' &&
        (() => {
          const buckets = buildReportChartBuckets(state.data.summary.byStatus, order, label);
          return isReportChartEmpty(buckets) ? (
            <CoreEmpty message="موردی ثبت نشده است." />
          ) : (
            <ReportSummaryChart testId={testId} title={title} buckets={buckets} />
          );
        })()}
    </CardFrame>
  );
}


function CommerceQueueCard({ refreshToken }: { refreshToken: number }) {
  return (
    <QueueCard
      testId="mgt-que-01"
      title="در انتظار تصمیم بازرگانی"
      drillHref="/admin/commerce/tasks"
      load={fetchCommercePendingDecisionsCount}
      emptyMessage="موردی در انتظار نیست."
      refreshToken={refreshToken}
    />
  );
}

function MissionQueueCard({ refreshToken }: { refreshToken: number }) {
  return (
    <QueueCard
      testId="mgt-que-02"
      title="در انتظار تأیید مأموریت"
      drillHref="/admin/hr/missions/approvals"
      load={fetchMissionApprovalsPendingCount}
      emptyMessage="موردی در انتظار نیست."
      refreshToken={refreshToken}
    />
  );
}

/** MGT-FIN-01 drills to `/admin/reporting`, the Financial check-request register/index. */
function FinancialDistributionCard({ refreshToken }: { refreshToken: number }) {
  return (
    <DistributionCard
      testId="mgt-fin-01"
      title="وضعیت درخواستهای چک"
      drillHref="/admin/reporting"
      load={() => fetchCheckRequestReport({ page: 1, pageSize: 1 })}
      order={REPORTING_CHECK_REQUEST_STATUSES}
      label={(key) => financialStatusLabel(Number(key))}
      refreshToken={refreshToken}
    />
  );
}

function CommerceDistributionCard({ refreshToken }: { refreshToken: number }) {
  return (
    <DistributionCard
      testId="mgt-com-01"
      title="وضعیت اسناد خرید"
      drillHref="/admin/reporting/purchase-requests"
      load={() => fetchPurchaseReport({ page: 1, pageSize: 1 })}
      order={PURCHASE_REPORT_STATUSES}
      label={commerceDocumentStatusLabel}
      refreshToken={refreshToken}
    />
  );
}

function ProductionDistributionCard({ refreshToken }: { refreshToken: number }) {
  return (
    <DistributionCard
      testId="mgt-prd-01"
      title="وضعیت ساختارهای BOM"
      drillHref="/admin/reporting/production"
      load={() => fetchProductionReport({ page: 1, pageSize: 1 })}
      order={PRODUCTION_REPORT_STATUSES}
      label={(key) => PRODUCTION_BOM_STATUS_LABELS[key as keyof typeof PRODUCTION_BOM_STATUS_LABELS] ?? key}
      refreshToken={refreshToken}
    />
  );
}


/**
 * The page. Permission is read once from `useCorePermissions` (presentation only). A card is mounted
 * only when the caller holds its remit, so a hidden card never reaches its source. The KPI card is
 * issued on the union of the three KPI-bearing remits; the HR queue is issued on its own remit.
 */
export function ManagementDashboardView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Presentation gate: wait for the session and RBAC before deciding what to issue.
  const ready = isAuthenticated && !rbac.isLoading;
  const granted = ready ? rbac.permissions : [];
  const has = (remit: string) => granted.includes(remit);

  const showKpi = ready && canReadAnyKpi(granted);
  const showCommerceQueue = ready && has(REMIT_COMMERCE);
  const showMissionQueue = ready && has(REMIT_MISSION_APPROVE);
  const showFinancial = ready && has(REMIT_FINANCIAL);
  const showCommerceDocs = ready && has(REMIT_COMMERCE);
  const showProduction = ready && has(REMIT_PRODUCTION);
  const anyRemit = DASHBOARD_REMITS.some((remit) => has(remit));

  // Page-level manual refresh: bumping the token re-queries every card that is currently mounted.
  const [refreshToken, setRefreshToken] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshToken((value) => value + 1), []);

  if (ready && !anyRemit) {
    return (
      <div data-testid="mgt-dashboard-forbidden">
        <CoreForbidden message="این نما برای حساب شما در دسترس نیست." />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="mgt-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">نمای مدیریت</h2>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="mgt-dashboard-scope">
            ماه جاری: شاخصها (سمت سرور) · سایر کارتها: وضعیت فعلی
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          data-testid="mgt-dashboard-refresh"
          className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          بروزرسانی
        </button>
      </div>

      {showKpi && <KpiStripCard refreshToken={refreshToken} />}

      {(showCommerceQueue || showMissionQueue) && (
        <div className="grid gap-4 md:grid-cols-2">
          {showCommerceQueue && <CommerceQueueCard refreshToken={refreshToken} />}
          {showMissionQueue && <MissionQueueCard refreshToken={refreshToken} />}
        </div>
      )}

      {(showFinancial || showCommerceDocs || showProduction) && (
        <div className="grid gap-4 md:grid-cols-3">
          {showFinancial && <FinancialDistributionCard refreshToken={refreshToken} />}
          {showCommerceDocs && <CommerceDistributionCard refreshToken={refreshToken} />}
          {showProduction && <ProductionDistributionCard refreshToken={refreshToken} />}
        </div>
      )}

      <nav aria-label="پیوندهای سریع" className="flex flex-wrap gap-4 border-t border-border pt-4 text-xs">
        <Link href="/admin/kpis" className="text-primary underline-offset-4 hover:underline">شاخصها</Link>
        <Link href="/admin/reporting" className="text-primary underline-offset-4 hover:underline">گزارش چکها</Link>
        <Link href="/admin/reporting/purchase-requests" className="text-primary underline-offset-4 hover:underline">گزارش خرید</Link>
        <Link href="/admin/reporting/production" className="text-primary underline-offset-4 hover:underline">گزارش BOM</Link>
      </nav>
    </div>
  );
}


