'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  canReadAnyKpi,
  fetchKpi,
  fetchKpiHistory,
  type KpiHistoryResult,
  type KpiResult,
} from '@/lib/kpi-api';
import {
  KPI_COMPARISON_TARGET_NOTE,
  KPI_PERFORMANCE_NOTE,
  kpiAvailabilityLabel,
  kpiCohortFieldLabel,
  kpiComparisonSummary,
  kpiComparisonUnavailableLabel,
  kpiDirectionLabel,
  kpiDisplayUnitLabel,
  kpiFormulaKindLabel,
  kpiOwnerContextLabel,
  kpiQualityClassificationLabel,
  kpiReadinessLabel,
  kpiSemanticUnitLabel,
  kpiUnavailableReasonLabel,
} from '@/lib/kpi-labels';
import { KpiTrendChart } from './KpiTrendChart';

/**
 * Phase KPI-RUNTIME — the KPI detail at `/admin/kpis/[technicalKey]`: ONE governed
 * definition, its number for one Jalali month, and every fact needed to trust it.
 *
 * WHAT THIS SCREEN PROMISES, as five statements:
 *
 *  1. THE VALUE is the runtime's own — display-converted when the catalog authorised a
 *     conversion, otherwise the governed value in its semantic unit. `NOT_AVAILABLE` renders
 *     an em dash plus the reason sentence, NEVER a `۰`.
 *  2. QUALITY IS NOT PERFORMANCE. The Green/Yellow classification is labelled as DATA
 *     readiness, and `KPI_PERFORMANCE_NOTE` states outright that performance was never
 *     assessed because no target or threshold exists.
 *  3. THE PROVENANCE is the catalog's own wording — population, exclusions, cohort field,
 *     evidence and known limitations arrive as strings from the server. Nothing here
 *     paraphrases them, because a paraphrase is a second definition.
 *  4. THE COUNTS say how much was read: cohort / valid / excluded, plus the read ceiling, so
 *     a small cohort is visibly complete rather than suspiciously small.
 *  5. NOTHING IS WRITABLE. There is no save, no target editor, no annotation box — the
 *     backend exposes two GETs and no mutation, and a screen with no verb cannot offer one.
 */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <dt className="w-40 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-6 text-foreground">{value}</dd>
    </div>
  );
}

function Bullets({ items, testId }: { items: readonly string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 ps-5 text-sm leading-6 text-foreground" data-testid={testId}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function KpiDetailView({ technicalKey }: { technicalKey: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || canReadAnyKpi(rbac.permissions);

  const [data, setData] = React.useState<KpiResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  /* ———— Phase KPI-HISTORICAL-INTELLIGENCE: history, independent of the value fetch. */
  const [periodCount, setPeriodCount] = React.useState(6);
  const [history, setHistory] = React.useState<KpiHistoryResult | null>(null);
  const [historyBusy, setHistoryBusy] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [historyReloadToken, setHistoryReloadToken] = React.useState(0);

  // Both reads used to arm themselves in their effect bodies; the arms now
  // ride render-time key adjustments. Each key mirrors its effect's exact
  // dependency list, and prev starts as `null` so the FIRST settled key is
  // detected (mount or grant arrival) — matching the old effect's first run.
  // The clears/busy arm only when the gate is open, exactly as the old
  // early-return did.
  const mainReadKey = `${isAuthenticated ? 1 : 0}|${rbac.isLoading ? 1 : 0}|${
    canRead ? 1 : 0
  }|${technicalKey}|${reloadToken}`;
  const [prevMainReadKey, setPrevMainReadKey] = React.useState<string | null>(null);
  if (prevMainReadKey !== mainReadKey) {
    setPrevMainReadKey(mainReadKey);
    if (isAuthenticated && !rbac.isLoading && canRead) {
      setError(null);
      setNotFound(false);
    }
  }

  const historyReadKey = `${isAuthenticated ? 1 : 0}|${rbac.isLoading ? 1 : 0}|${
    canRead ? 1 : 0
  }|${technicalKey}|${periodCount}|${historyReloadToken}`;
  const [prevHistoryReadKey, setPrevHistoryReadKey] = React.useState<string | null>(null);
  if (prevHistoryReadKey !== historyReadKey) {
    setPrevHistoryReadKey(historyReadKey);
    if (isAuthenticated && !rbac.isLoading && canRead) {
      setHistoryBusy(true);
      setHistoryError(null);
    }
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchKpi(technicalKey)
      .then((result) => {
        if (!active) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status = (err as { status?: number } | null)?.status;
        // 404 = no such key in the approved catalogue; anything else is a real failure.
        if (status === 404) {
          setNotFound(true);
          return;
        }
        setError('دریافت شاخص با خطا مواجه شد. لطفاً دوباره تلاش کنید.');
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, technicalKey, reloadToken]);

  /*
   * Phase KPI-HISTORICAL-INTELLIGENCE — the history the server computed for the same
   * definition through the same formula. It runs on its OWN state so a history
   * failure never hides the current value above it: the section renders its own
   * recoverable error instead of turning the whole page into one.
   */
  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchKpiHistory(technicalKey, { periodCount })
      .then((result) => {
        if (!active) return;
        setHistory(result);
        setHistoryBusy(false);
      })
      .catch(() => {
        if (!active) return;
        setHistoryBusy(false);
        setHistoryError('دریافت تاریخچه شاخص با خطا مواجه شد. لطفاً دوباره تلاش کنید.');
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, technicalKey, periodCount, historyReloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="kpi-detail-view">
        <CoreForbidden />
      </div>
    );
  }

  if (notFound) {
    return (
      <div data-testid="kpi-detail-view">
        <CoreEmpty message="چنین شاخصی در فهرست شاخص‌های مصوب وجود ندارد." />
        <Link href="/admin/kpis" className="mt-4 inline-block text-sm text-primary hover:underline">
          بازگشت به فهرست شاخص‌ها
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="kpi-detail-view">
        <CoreError message={error} onRetry={() => setReloadToken((token) => token + 1)} />
      </div>
    );
  }

  if (!data) {
    return (
      <div data-testid="kpi-detail-view">
        <CoreLoading label="در حال دریافت شاخص..." />
      </div>
    );
  }

  const available = data.availability === 'AVAILABLE';
  const valueText = available
    ? data.display
      ? `${toPersianDigits(data.display.value)} ${kpiDisplayUnitLabel(data.display.unitToken)}`
      : `${toPersianDigits(data.value ?? 0)} ${kpiSemanticUnitLabel(data.unit.semantic)}`
    : null;

  return (
    <div data-testid="kpi-detail-view">
      <div className="mb-6 flex flex-col gap-3">
        <Link
          href="/admin/kpis"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
          فهرست شاخص‌ها
        </Link>
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">{data.nameFa}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{data.nameEn}</p>
        </div>
        <p className="max-w-3xl text-sm leading-7 text-muted-foreground">{data.businessQuestion}</p>
        <p className="max-w-3xl text-sm leading-7 text-foreground">{data.definition}</p>
      </div>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-value-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {data.period.monthName} {toPersianDigits(data.period.jy)}
            {data.period.completed === false ? ' (در جریان)' : ''}
          </span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              available
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-border bg-muted text-muted-foreground'
            }`}
          >
            {kpiAvailabilityLabel(data.availability)}
          </span>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">
            داده: {kpiReadinessLabel(data.quality.readiness)}
          </span>
        </div>

        {available ? (
          <p className="mt-3 text-3xl font-bold text-foreground" data-testid="kpi-detail-value">
            {valueText}
          </p>
        ) : (
          <div className="mt-3" data-testid="kpi-detail-unavailable">
            <p className="text-3xl font-bold text-muted-foreground">—</p>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">
              {kpiUnavailableReasonLabel(data.unavailableReason)}
            </p>
          </div>
        )}

        <dl className="mt-4">
          <Row label="مالکیت شاخص" value={kpiOwnerContextLabel(data.ownerContext)} />
          <Row label="نوع محاسبه" value={kpiFormulaKindLabel(data.governance.formulaKind)} />
          <Row
            label="واحد بیان"
            value={`${kpiSemanticUnitLabel(data.unit.semantic)} — ${data.unit.presentation}`}
          />
          <Row label="ماه محاسبه" value={kpiCohortFieldLabel(data.supportingContext.cohortField)} />
          <Row
            label="بازه"
            value={`${toPersianDigits(data.period.start)} تا ${toPersianDigits(data.period.end)} (${data.period.timeZone})`}
          />
        </dl>
      </section>

      {/*
       * Phase KPI-HISTORICAL-INTELLIGENCE — comparison and trend. Movement is
       * mathematical only (no green/red verdict: no target exists), gaps are honest
       * (never zero-filled), and this block owns its own states: a history outage
       * retries HERE while the value above stays readable.
       */}
      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-history-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">مقایسه با دوره قبل و روند</h3>
          <div
            className="flex items-center gap-1.5"
            role="group"
            aria-label="بازه تاریخچه"
            data-testid="kpi-history-range"
          >
            {(
              [
                { count: 3, label: '۳ ماه اخیر' },
                { count: 6, label: '۶ ماه اخیر' },
                { count: 12, label: '۱۲ ماه اخیر' },
              ] as const
            ).map((option) => (
              <button
                key={option.count}
                type="button"
                data-testid={`kpi-history-range-${option.count}`}
                aria-pressed={periodCount === option.count}
                disabled={historyBusy}
                onClick={() => setPeriodCount(option.count)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
                  periodCount === option.count
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {historyError ? (
          <div className="mt-4" data-testid="kpi-history-error">
            <CoreError
              message={historyError}
              onRetry={() => setHistoryReloadToken((token) => token + 1)}
            />
          </div>
        ) : historyBusy && !history ? (
          <div className="mt-4" data-testid="kpi-history-loading">
            <CoreLoading label="در حال دریافت تاریخچه شاخص..." />
          </div>
        ) : history ? (
          <div className="mt-4 flex flex-col gap-4">
            {history.comparison ? (
              <div data-testid="kpi-comparison">
                {history.comparison.availability === 'AVAILABLE' ? (
                  <>
                    <p
                      className="text-sm font-semibold text-foreground"
                      data-testid="kpi-comparison-summary"
                    >
                      {kpiComparisonSummary(
                        history.comparison,
                        toPersianDigits,
                        kpiSemanticUnitLabel
                      )}
                    </p>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">
                      جهت ریاضی: {kpiDirectionLabel(history.comparison.direction)}
                      {' — '}
                      بازه فعلی: {history.comparison.currentPeriod.monthName}{' '}
                      {toPersianDigits(history.comparison.currentPeriod.jy)}
                      {history.comparison.currentPeriod.completed === false ? ' (در جریان)' : ''}
                      {'، '}
                      بازه مقایسه: {history.comparison.previousPeriod.monthName}{' '}
                      {toPersianDigits(history.comparison.previousPeriod.jy)}
                    </p>
                    {history.comparison.currentPeriod.completed === false ? (
                      <p
                        className="mt-1 text-xs leading-6 text-muted-foreground"
                        data-testid="kpi-comparison-partial"
                      >
                        بازه فعلی هنوز کامل نشده است؛ مقایسه ماه ناقص با ماه کامل را با احتیاط
                        بخوانید.
                      </p>
                    ) : null}
                    {history.comparison.unavailableReason ===
                    'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE' ? (
                      <p
                        className="mt-1 text-xs leading-6 text-muted-foreground"
                        data-testid="kpi-comparison-zero-note"
                      >
                        مقدار بازه مقایسه صفر است؛ تغییر نسبی تعریف نشده و فقط تغییر مطلق نمایش داده
                        می‌شود.
                      </p>
                    ) : null}
                    <p
                      className="mt-2 text-xs leading-6 text-muted-foreground"
                      data-testid="kpi-comparison-target"
                    >
                      {KPI_COMPARISON_TARGET_NOTE}
                    </p>
                  </>
                ) : (
                  <p
                    className="text-sm leading-7 text-muted-foreground"
                    data-testid="kpi-comparison-unavailable"
                  >
                    {kpiComparisonUnavailableLabel(history.comparison.unavailableReason)}
                  </p>
                )}
              </div>
            ) : null}

            <div data-testid="kpi-trend">
              <KpiTrendChart title="روند ماهانه" testId="kpi-trend-chart" items={history.items} />
            </div>

            {/*
             * KPI-to-report drill-down: the SOURCE register this KPI is a view of —
             * same tenant behind the same authorization, matching the period the
             * history was computed for. It is labelled as the source report, never
             * as another KPI, and it never claims record-level traceability.
             */}
            {history.supportingReport ? (
              <div data-testid="kpi-report-link">
                <Link
                  href={history.supportingReport.href}
                  data-testid="kpi-supporting-report-link"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  مشاهده گزارش مبنا: {history.supportingReport.titleFa}
                </Link>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">
                  این پیوند شما را به گزارشی می‌برد که این شاخص از آن محاسبه می‌شود — نه به شاخص
                  دیگری.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-quality-card">
        <h3 className="text-sm font-semibold text-foreground">کیفیت داده، نه ارزیابی عملکرد</h3>
        <p className="mt-2 text-sm leading-7 text-muted-foreground">
          طبقه‌بندی {kpiQualityClassificationLabel(data.quality.classification)} وضعیت کیفیت داده‌ای
          است که این شاخص از آن ساخته می‌شود: {kpiReadinessLabel(data.quality.readiness)}.
        </p>
        <p className="mt-2 text-sm leading-7 text-foreground">{KPI_PERFORMANCE_NOTE}</p>
        <ul className="mt-3 list-disc space-y-1 ps-5 text-sm leading-6 text-muted-foreground">
          <li>هدف: تعریف نشده</li>
          <li>آستانه: تعریف نشده</li>
          <li>عملکرد: ارزیابی نشده</li>
        </ul>
        {data.quality.notes.length > 0 ? (
          <div className="mt-3">
            <Bullets items={data.quality.notes} testId="kpi-quality-notes" />
          </div>
        ) : null}
      </section>

      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-context-card">
        <h3 className="text-sm font-semibold text-foreground">عدد از کجا آمده است</h3>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">موارد ماه</p>
            <p
              className="mt-1 text-lg font-semibold text-foreground"
              data-testid="kpi-count-cohort"
            >
              {toPersianDigits(data.supportingContext.counts.cohort)}
            </p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">محاسبه‌شده</p>
            <p className="mt-1 text-lg font-semibold text-foreground" data-testid="kpi-count-valid">
              {toPersianDigits(data.supportingContext.counts.valid)}
            </p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">خارج شده</p>
            <p
              className="mt-1 text-lg font-semibold text-foreground"
              data-testid="kpi-count-excluded"
            >
              {toPersianDigits(data.supportingContext.counts.excluded)}
            </p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">سقف خواندن</p>
            <p className="mt-1 text-lg font-semibold text-foreground" data-testid="kpi-read-limit">
              {toPersianDigits(data.supportingContext.readLimit)}
            </p>
          </div>
        </div>

        <dl className="mt-4">
          <Row label="جامعه آماری" value={data.supportingContext.population} />
          <Row label="استثناها" value={data.supportingContext.exclusions} />
        </dl>

        {data.supportingContext.evidence.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted-foreground">شواهد</p>
            <Bullets items={data.supportingContext.evidence} testId="kpi-evidence" />
          </div>
        ) : null}

        {data.supportingContext.knownLimitations.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted-foreground">محدودیت‌های شناخته‌شده</p>
            <Bullets
              items={data.supportingContext.knownLimitations}
              testId="kpi-known-limitations"
            />
          </div>
        ) : null}
      </section>

      {/*
       * Phase KPI-HISTORICAL-INTELLIGENCE — the guide, answering every question a
       * reader must never have to guess: what it measures, how it is calculated,
       * which period it uses, how comparison is calculated, what «not available»
       * means, whether higher/lower is mathematically meaningful, whether a target
       * exists (it does not — and the sentence says so outright).
       */}
      <section className="core-card mb-4 p-4 sm:p-5" data-testid="kpi-guide-card">
        <h3 className="text-sm font-semibold text-foreground">راهنمای شاخص</h3>
        <dl className="mt-2" data-testid="kpi-guide">
          <Row label="چه چیزی را می‌سنجد" value={data.businessQuestion} />
          <Row
            label="چگونه محاسبه می‌شود"
            value={
              data.governance.formulaKind === 'MEAN_ELAPSED'
                ? 'میانگین زمان سپری‌شده بین دو رویداد ثبت‌شده، با همان فرمول مصوب در هر بازه. موارد نامعتبر حذف می‌شوند و هرگز با صفر جایگزین نمی‌شوند.'
                : 'سهم صورت نسبت از مخرج، در بازه صفر تا صد، با همان فرمول مصوب در هر بازه. مخرج خالی یعنی «نسبتی وجود ندارد» — همان نبود گزارش می‌شود، نه صفر.'
            }
          />
          <Row
            label="بازه محاسبه"
            value={`ماه شمسی در منطقه ${data.period.timeZone} (${kpiCohortFieldLabel(data.supportingContext.cohortField)}). ماهی که هنوز پایان نیافته «در جریان» است و با ماه کامل یکسان خوانده نمی‌شود.`}
          />
          <Row
            label="مقایسه چگونه محاسبه می‌شود"
            value="تفاضل دو بازه متوالی با همان فرمول و همان جامعه آماری. برای شاخص‌های درصدی، تغییر «واحد درصد» ملاک است نه تغییر نسبی؛ اگر بازه مقایسه صفر باشد، تغییر نسبی تعریف نشده است. اگر هر دو بازه مقداری نداشته باشد، مقایسه‌ای محاسبه نمی‌شود."
          />
          <Row
            label="«در دسترس نیست» یعنی چه"
            value="در آن بازه موردی از جامعه این شاخص ثبت نشده — یا هیچ موردی با قواعد تعریف سازگار نبوده — است؛ یعنی عددی وجود ندارد، نه اینکه عدد صفر باشد."
          />
          <Row
            label="بالا یا پایین رفتن به چه معناست"
            value={
              data.unit.semantic === 'SECONDS'
                ? 'فقط جهت ریاضی: کاهش یعنی میانگین زمان کوتاه‌تر و افزایش یعنی میانگین زمان طولانی‌تر. بدون هدف تعریف‌شده، این جهت خوب یا بد تلقی نمی‌شود.'
                : 'فقط جهت ریاضی: افزایش یعنی سهم بیشتر و کاهش یعنی سهم کمتر. بدون هدف تعریف‌شده، این جهت خوب یا بد تلقی نمی‌شود.'
            }
          />
          <Row
            label="آیا هدف وجود دارد"
            value="هدف یا آستانه عملکردی برای این شاخص تعریف نشده است؛ عملکرد ارزیابی نشده است."
          />
        </dl>
      </section>

      <section className="core-card p-4 sm:p-5" data-testid="kpi-governance-card">
        <h3 className="text-sm font-semibold text-foreground">حکمرانی</h3>
        <dl className="mt-2">
          <Row label="مجوز خواندن" value={data.governance.readRemit} />
          <Row label="ماژول" value={data.governance.moduleEntitlement} />
          <Row label="قابلیت" value={data.governance.featureEntitlement} />
          <Row
            label="مجوز جدید لازم است"
            value={data.governance.newPermissionRequired ? 'بله' : 'خیر'}
          />
        </dl>
      </section>
    </div>
  );
}
