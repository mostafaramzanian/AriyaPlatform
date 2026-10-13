'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchCheckRequestReportRow,
  type ReportingCheckRequestRow,
} from '@/lib/reporting-api';
import {
  FINANCIAL_ISSUE_TYPE_LABELS,
  FINANCIAL_PURCHASE_TYPE_LABELS,
  financialDateLabel,
  financialErrorMessage,
  financialManagerDecisionLabel,
  financialRequesterOpinionLabel,
  financialStatusLabel,
  financialStatusTone,
  type FinancialTone,
} from '@/lib/financial-labels';
import type {
  FinancialCheckIssueType,
  FinancialCheckPurchaseType,
} from '@/lib/financial-api';
import { CheckRequestReportTimeline } from './CheckRequestReportTimeline';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the READ-ONLY detail for ONE request
 * in the report — `/admin/reporting/check-requests/[id]`.
 *
 * WHAT THIS PAGE IS FOR, stated by its own structure: understanding and
 * reviewing the record (identity, classification, dates, status, decision,
 * flow). WHAT IT IS NOT: a Financial workflow screen — there is no approve,
 * no reject, no edit, no upload, no mutation of any kind, and no link into
 * the Financial wizard. The only navigation it offers is back to the report.
 *
 * The data is the contract's twelve-field projection (nothing richer exists
 * to leak), the status is the source ordinal rendered through the existing
 * Financial labels, and the flow section below fetches only THIS request's
 * authoritative timeline, on demand.
 *
 * Raw actor ids are deliberately NOT rendered anywhere (phase brief §31):
 * the contract withholds `requesterUserId`/`decidedByUserId`, and the
 * timeline component renders no `actorId` either — without a display
 * contract for them, an opaque uuid is noise, not information.
 */
const TONE_CLASSES: Record<FinancialTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="min-w-32 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

function ReportCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="core-card p-4 sm:p-6" data-testid={testId}>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <dl className="mt-2 divide-y divide-border/60">{children}</dl>
    </section>
  );
}

export function CheckRequestReportDetailView({ requestId }: { requestId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('financial.check.read');

  const [row, setRow] = React.useState<ReportingCheckRequestRow | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRequestId, setPrevRequestId] = React.useState(requestId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevRequestId !== requestId) {
    setPrevRequestId(requestId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchCheckRequestReportRow(requestId)
      .then((result) => {
        if (!active) return;
        setRow(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const body = (err as { details?: { code?: string }; status?: number }).details;
        const status = (err as { status?: number }).status;
        setError(
          status === 404
            ? 'این درخواست یافت نشد.'
            : financialErrorMessage(
                body?.code,
                'دریافت جزئیات گزارش با خطا مواجه شد. لطفاً دوباره تلاش کنید.'
              )
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, requestId, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="reporting-detail">
        <CoreForbidden />
      </div>
    );
  }

  return (
    <div data-testid="reporting-detail">
      <div className="mb-6 flex flex-col gap-3">
        <Link
          href="/admin/reporting"
          data-testid="reporting-detail-back"
          className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش
        </Link>
        <div>
          <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
            جزئیات درخواست صدور چک
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            مشاهده و بررسی فقط؛ این صفحه هیچ تغییری در گردش کار مالی ایجاد نمی‌کند.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6" data-testid="reporting-detail-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {loading && !row ? (
        <section className="core-card p-4 sm:p-6" data-testid="reporting-detail-loading" aria-busy="true">
          <CoreLoading label="در حال بارگذاری جزئیات…" lines={4} />
        </section>
      ) : row ? (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <ReportCard title="شناسه و طبقه‌بندی" testId="reporting-detail-identity">
              <Field label="عنوان" value={<span data-testid="reporting-detail-title">{row.title}</span>} />
              <Field
                label="نوع صدور چک"
                value={
                  FINANCIAL_ISSUE_TYPE_LABELS[row.checkIssueType as FinancialCheckIssueType] ??
                  row.checkIssueType
                }
              />
              <Field
                label="نوع خرید"
                value={
                  row.purchaseType
                    ? FINANCIAL_PURCHASE_TYPE_LABELS[row.purchaseType as FinancialCheckPurchaseType] ??
                      row.purchaseType
                    : '—'
                }
              />
              <Field label="مرجع سفارش" value={row.orderReference || '—'} />
              <Field label="مرجع پروژه" value={row.projectReference || '—'} />
            </ReportCard>

            <ReportCard title="وضعیت و تصمیم" testId="reporting-detail-status">
              <Field
                label="وضعیت"
                value={
                  <span
                    data-testid="reporting-detail-status-badge"
                    className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[financialStatusTone(row.status)]}`}
                  >
                    <span>{financialStatusLabel(row.status)}</span>
                    <span className="opacity-60">({toPersianDigits(row.status)})</span>
                  </span>
                }
              />
              <Field
                label="نظر درخواست‌کننده"
                value={financialRequesterOpinionLabel(row.requesterOpinion) ?? '—'}
              />
              <Field
                label="تصمیم مدیر"
                value={
                  <span data-testid="reporting-detail-decision">
                    {financialManagerDecisionLabel(row.managerDecision) ?? '—'}
                  </span>
                }
              />
            </ReportCard>
          </div>

          <div className="mb-4">
            <ReportCard title="تاریخ‌ها" testId="reporting-detail-dates">
              <Field label="تاریخ درخواست" value={financialDateLabel(row.requestDate)} />
              <Field label="ثبت / ارسال" value={financialDateLabel(row.submittedAt)} />
              <Field label="تصمیم" value={financialDateLabel(row.decidedAt)} />
            </ReportCard>
          </div>

          <CheckRequestReportTimeline requestId={row.id} />
        </>
      ) : null}
    </div>
  );
}

