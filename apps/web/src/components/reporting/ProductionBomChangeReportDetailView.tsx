'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchProductionBomChangeReportRow,
  type ReportingProductionBomChangeRow,
} from '@/lib/production-bom-change-report-api';
import {
  productionBomStatusLabel,
  productionBomStatusTone,
  productionDateLabel,
  productionManagerOpinionLabel,
  type ProductionTone,
} from '@/lib/production-labels';
import { ProductionBomChangeReportTimeline } from './ProductionBomChangeReportTimeline';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the READ-ONLY detail for ONE change
 * request in the report — `/admin/reporting/production/bom-change-requests/[id]`.
 *
 * WHAT THIS PAGE IS FOR, stated by its own structure: understanding and reviewing the
 * record (identity, classification, status, decision, change lines, flow). WHAT IT IS
 * NOT: a Production workspace — there is no approve, no reject, no edit, no submit, no
 * request-correction, no mutation of any kind, and no link into the Production
 * change-request screens. The only navigation it offers is back to the report.
 *
 * The data is the contract's eleven-field projection (nothing richer exists to leak),
 * the status is the source member rendered through the existing Production labels, and
 * the flow section below fetches only THIS request's authoritative timeline, on demand.
 * Change-LINE detail (per-item coefficients) is deliberately NOT fetched: the report
 * carries the line COUNT; the coefficient snapshots live on Production's own detail
 * surface, not in this projection.
 *
 * Raw actor ids are deliberately NOT rendered anywhere: the contract withholds
 * `requesterUserId`/`approverUserId`/`decidedByUserId`, and the timeline component
 * renders no `actorId` either — without a display contract for them, an opaque uuid is
 * noise, not information.
 */
const TONE_CLASSES: Record<ProductionTone, string> = {
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

export function ProductionBomChangeReportDetailView({ changeId }: { changeId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');

  const [row, setRow] = React.useState<ReportingProductionBomChangeRow | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevChangeId, setPrevChangeId] = React.useState(changeId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevChangeId !== changeId) {
    setPrevChangeId(changeId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchProductionBomChangeReportRow(changeId)
      .then((result) => {
        if (!active) return;
        setRow(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت جزئیات گزارش با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [changeId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="production-bom-change-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="production-bom-change-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="production-bom-change-report-detail-error">
        <CoreError
          message={error ?? 'این درخواست تغییر یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="production-bom-change-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/production/bom-change-requests"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش درخواست‌های تغییر
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">{row.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          پروژه {row.projectRef} —{' '}
          <span
            data-testid={`production-bom-change-report-status-${row.status}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[productionBomStatusTone(row.status as never)]}`}
          >
            {productionBomStatusLabel(row.status as never)}
          </span>
        </p>
      </div>

      <ReportCard title="مشخصات درخواست تغییر" testId="production-bom-change-report-detail-card">
        <Field label="عنوان" value={row.title} />
        <Field
          label="شناسه BOM"
          value={
            <span dir="ltr" className="font-mono text-xs">
              {row.bomId}
            </span>
          }
        />
        <Field label="پروژه" value={row.projectRef} />
        <Field label="درخت محصول" value={row.productTreeRef} />
        <Field
          label="وضعیت"
          value={
            <span data-testid={`production-bom-change-report-detail-status-${row.status}`}>
              {productionBomStatusLabel(row.status as never)}
            </span>
          }
        />
        <Field label="نظر مدیر" value={productionManagerOpinionLabel(row.managerOpinion) ?? '—'} />
        <Field label="تعداد اقلام تغییر" value={toPersianDigits(row.itemCount)} />
        <Field label="تاریخ ثبت" value={productionDateLabel(row.createdAt)} />
        <Field
          label="ارجاع"
          value={
            row.submittedAt !== null ? productionDateLabel(row.submittedAt) : 'هنوز ارجاع نشده است.'
          }
        />
        <Field
          label="تصمیم"
          value={
            row.decidedAt !== null
              ? productionDateLabel(row.decidedAt)
              : 'هنوز تصمیمی ثبت نشده است.'
          }
        />
      </ReportCard>

      <ProductionBomChangeReportTimeline changeId={row.id} />
    </div>
  );
}
