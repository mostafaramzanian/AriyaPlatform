'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchReceivingReportRow,
  type ReportingReceivingRow,
} from '@/lib/receiving-report-api';
import {
  commerceInstantLabel,
  commerceReceivingStatusLabel,
} from '@/lib/commerce-labels';
import { decimalDisplayLabel } from '@/lib/commerce-decimals';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the READ-ONLY detail for ONE
 * receiving register row — `/admin/reporting/commerce/receiving/[id]`.
 *
 * THE ROW IS A PURCHASE LINE (scope gate A): the detail answers «which line of
 * which document, in what projected receiving state, ordered how much, received
 * how much, when was its latest receiving event, and how many compensations does
 * it carry» — and nothing more. No append, no compensate, no mutation, no link
 * into a Commerce wizard, no document editor, no timeline (the audit trail is
 * receipt-event-bound; this row's "history" as a line is the two quantity facts
 * themselves). Raw `receiverId` is never rendered (the contract withholds it);
 * the line id renders as-is, like the purchase detail's opaque refs.
 */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="min-w-32 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

export function ReceivingReportDetailView({ lineId }: { lineId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [row, setRow] = React.useState<ReportingReceivingRow | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevLineId, setPrevLineId] = React.useState(lineId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevLineId !== lineId) {
    setPrevLineId(lineId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchReceivingReportRow(lineId)
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
  }, [lineId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="receiving-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="receiving-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="receiving-report-detail-error">
        <CoreError
          message={error ?? 'این ردیف دریافت یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="receiving-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/commerce/receiving"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش وضعیت دریافت‌ها
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          ردیف خرید {row.purchaseDocumentNumber}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <span data-testid={`receiving-report-detail-status-${row.receivingStatus}`}>
            {commerceReceivingStatusLabel(row.receivingStatus)}
          </span>
        </p>
      </div>

      <section className="core-card p-4 sm:p-6" data-testid="receiving-report-detail-card">
        <h3 className="text-base font-semibold text-foreground">مشخصات ردیف دریافت</h3>
        <dl className="mt-2 divide-y divide-border/60">
          <Field label="شماره سند خرید" value={row.purchaseDocumentNumber} />
          <Field label="شناسه سند خرید" value={row.purchaseDocumentId} />
          <Field label="شناسه ردیف خرید" value={row.id} />
          <Field label="وضعیت دریافت" value={commerceReceivingStatusLabel(row.receivingStatus)} />
          <Field label="مقدار سفارش" value={decimalDisplayLabel(row.orderedQuantity)} />
          <Field label="مقدار دریافتی" value={decimalDisplayLabel(row.receivedQuantity)} />
          <Field
            label="آخرین تاریخ دریافت"
            value={row.receivedAt !== null ? commerceInstantLabel(row.receivedAt) : '—'}
          />
          <Field
            label="رویدادهای جبرانی"
            value={
              <span data-testid="receiving-report-detail-compensations">
                {row.compensationCount > 0 ? toPersianDigits(row.compensationCount) : '—'}
              </span>
            }
          />
        </dl>
      </section>

      <p className="text-xs text-muted-foreground" data-testid="receiving-report-detail-note">
        شناسه ردیف: {row.id} — مقدارها دقیقاً همان رشته‌های ثبت‌شده‌اند ({toPersianDigits(4)} رقم
        اعشار) و وضعیت از پروجکشن مقدار دریافتی در برابر مقدار سفارش محاسبه می‌شود.
      </p>
    </div>
  );
}
