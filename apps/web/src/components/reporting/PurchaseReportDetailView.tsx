'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import { fetchPurchaseReportRow, type ReportingPurchaseRow } from '@/lib/purchase-report-api';
import {
  commerceDateLabel,
  commerceDocumentKindLabel,
  commerceDocumentStatusLabel,
  commerceDocumentStatusTone,
  commerceMoneyLabel,
  type CommerceTone,
} from '@/lib/commerce-labels';
import { PurchaseReportTimeline } from './PurchaseReportTimeline';

/**
 * Phase REPORTING-PURCHASE-REPORT: the READ-ONLY detail for ONE purchase document in
 * the report — `/admin/reporting/purchase-requests/[id]`.
 *
 * WHAT THIS PAGE IS FOR, stated by its own structure: understanding and reviewing the
 * record (identity, classification, totals, status, completion, flow). WHAT IT IS NOT:
 * a Commerce workspace — there is no approve, no reject, no edit, no complete, no
 * upload, no mutation of any kind, and no link into the Commerce wizard. The only
 * navigation it offers is back to the report.
 *
 * The data is the contract's twelve-field projection (nothing richer exists to leak),
 * the status is the source member rendered through the existing Commerce labels, and
 * the flow section below fetches only THIS document's authoritative timeline, on demand.
 *
 * Raw actor ids are deliberately NOT rendered anywhere: the contract withholds
 * `requesterId`/`completedByUserId`, and the timeline component renders no `actorId`
 * either — without a display contract for them, an opaque uuid is noise, not
 * information.
 */
const TONE_CLASSES: Record<CommerceTone, string> = {
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

export function PurchaseReportDetailView({ documentId }: { documentId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [row, setRow] = React.useState<ReportingPurchaseRow | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevDocumentId, setPrevDocumentId] = React.useState(documentId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevDocumentId !== documentId) {
    setPrevDocumentId(documentId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchPurchaseReportRow(documentId)
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
  }, [documentId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="purchase-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="purchase-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="purchase-report-detail-error">
        <CoreError
          message={error ?? 'این سند یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="purchase-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/purchase-requests"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش درخواست‌های خرید
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          سند {row.documentNumber}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {commerceDocumentKindLabel(row.kind)} —{' '}
          <span
            data-testid={`purchase-report-status-${row.status}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[commerceDocumentStatusTone(row.status)]}`}
          >
            {commerceDocumentStatusLabel(row.status)}
          </span>
        </p>
      </div>

      <ReportCard title="مشخصات سند" testId="purchase-report-detail-card">
        <Field label="شماره سند" value={row.documentNumber} />
        <Field label="نوع" value={commerceDocumentKindLabel(row.kind)} />
        <Field
          label="وضعیت"
          value={
            <span data-testid={`purchase-report-detail-status-${row.status}`}>
              {commerceDocumentStatusLabel(row.status)}
            </span>
          }
        />
        <Field label="تأمین‌کننده" value={row.supplierId ?? '—'} />
        <Field label="ارز" value={row.currency ?? '—'} />
        <Field
          label="جمع جزء / مالیات / مبلغ کل"
          value={
            row.totalAmount !== null
              ? `${commerceMoneyLabel(row.subtotalAmount, row.currency)} / ${commerceMoneyLabel(row.taxAmount, row.currency)} / ${commerceMoneyLabel(row.totalAmount, row.currency)}`
              : 'هنوز قیمت‌گذاری نشده است.'
          }
        />
        <Field label="تعداد اقلام" value={toPersianDigits(row.lineCount)} />
        <Field label="تاریخ ثبت" value={commerceDateLabel(row.createdAt)} />
        <Field
          label="تکمیل"
          value={
            row.completedAt !== null ? commerceDateLabel(row.completedAt) : 'هنوز تکمیل نشده است.'
          }
        />
      </ReportCard>

      <PurchaseReportTimeline documentId={row.id} />
    </div>
  );
}
