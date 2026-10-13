'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchPaymentHistoryReportRow,
  type ReportingPaymentRow,
} from '@/lib/payment-history-report-api';
import {
  commerceInstantLabel,
  commerceMoneyLabel,
  commercePaymentMethodLabel,
} from '@/lib/commerce-labels';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the READ-ONLY detail for ONE payment row —
 * `/admin/reporting/commerce/payment-history/[id]`. Understanding and reviewing the
 * recorded event only: no append, no compensate, no mutation, and no link into a
 * Commerce wizard. Raw `recordedByUserId` is never rendered (the contract withholds
 * it); request-local ids render as-is, like the purchase detail's opaque `supplierId`.
 */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="min-w-32 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

export function PaymentHistoryReportDetailView({ paymentId }: { paymentId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [row, setRow] = React.useState<ReportingPaymentRow | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevPaymentId, setPrevPaymentId] = React.useState(paymentId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevPaymentId !== paymentId) {
    setPrevPaymentId(paymentId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchPaymentHistoryReportRow(paymentId)
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
  }, [paymentId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="payment-history-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="payment-history-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="payment-history-report-detail-error">
        <CoreError
          message={error ?? 'این پرداخت یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="payment-history-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/commerce/payment-history"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش تاریخچه پرداخت‌ها
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          پرداخت {row.purchaseDocumentNumber}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {commercePaymentMethodLabel(row.method)} —{' '}
          <span data-testid={`payment-history-report-method-${row.method}`}>
            {commerceMoneyLabel(row.amount, row.currency)}
          </span>
        </p>
      </div>

      <section className="core-card p-4 sm:p-6" data-testid="payment-history-report-detail-card">
        <h3 className="text-base font-semibold text-foreground">مشخصات پرداخت</h3>
        <dl className="mt-2 divide-y divide-border/60">
          <Field label="شماره سند خرید" value={row.purchaseDocumentNumber} />
          <Field
            label="نوع رویداد"
            value={
              <span data-testid="payment-history-report-detail-kind">
                {row.reversesPaymentId !== null ? 'رویداد جبرانی' : 'پرداخت'}
              </span>
            }
          />
          <Field label="روش پرداخت" value={commercePaymentMethodLabel(row.method)} />
          <Field label="مبلغ" value={commerceMoneyLabel(row.amount, row.currency)} />
          <Field label="ارز" value={row.currency ?? '—'} />
          <Field label="تاریخ پرداخت" value={commerceInstantLabel(row.paymentDate)} />
          <Field label="مرجع پرداخت‌کننده" value={row.payerRef ?? '—'} />
          <Field label="مرجع دریافت‌کننده" value={row.payeeRef ?? '—'} />
          <Field label="مرجع صورتحساب" value={row.invoiceRef ?? '—'} />
          <Field label="مرجع خارجی" value={row.externalReference ?? '—'} />
          <Field label="جبران‌کننده‌ی پرداخت" value={row.reversesPaymentId ?? '—'} />
        </dl>
      </section>

      <p className="text-xs text-muted-foreground" data-testid="payment-history-report-detail-note">
        شناسه رویداد: {row.id} — مبلغ‌ها دقیقاً همان رشته‌های ثبت‌شده‌اند ({toPersianDigits(4)} رقم
        اعشار).
      </p>
    </div>
  );
}
