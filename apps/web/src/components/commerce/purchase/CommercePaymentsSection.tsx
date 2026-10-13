'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import {
  appendCommercePayment,
  compensateCommercePayment,
  COMMERCE_PAYMENT_METHODS,
  type CommercePaymentMethod,
  type CommercePaymentsRead,
  type CommercePaymentRecord,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceInstantLabel,
  commercePaymentMethodLabel,
} from '@/lib/commerce-labels';
import { decimalDisplayLabel } from '@/lib/commerce-decimals';
import {
  CommerceBadge,
  CommerceEmptyState,
  CommercePaymentStatusBadge,
  CommerceSectionHeading,
} from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';
import type { SectionState } from './section-state';

/**
 * PHASE UI-2: «پرداخت‌ها» — the payment history of one document (UI-0 J7, C1-Q).
 *
 * APPEND-ONLY, AND THE SCREEN SAYS SO. Nothing here edits or deletes a row: the only two
 * writes are «ثبت پرداخت» (POST …/payments) and «ابطال (جبران)» (POST …/compensate),
 * both of which APPEND. Compensation is FULL negation of the target row — the DTO takes
 * no amount, so no partial input exists to offer — and the confirm dialog states the
 * consequence before anything is sent.
 *
 * NO OPTIMISTIC STATE, EVER. After a successful mutation the history is REFETCHED
 * (`onMutated`) and re-rendered from the server's own rows and projection; on failure the
 * entered form values are preserved and only the message changes. The projection badge
 * renders the server's `status` — including `null` as «جمع کل اعلام نشده», never as
 * «پرداخت‌نشده».
 */
export function CommercePaymentsSection({
  documentId,
  state,
  canManage,
  onRetry,
  onMutated,
}: {
  documentId: string;
  state: SectionState<CommercePaymentsRead>;
  canManage: boolean;
  onRetry: () => void;
  onMutated: () => void;
}) {
  const [amount, setAmount] = React.useState('');
  const [method, setMethod] = React.useState<CommercePaymentMethod>('CASH');
  const [invoiceRef, setInvoiceRef] = React.useState('');
  const [externalReference, setExternalReference] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'append' | 'compensate' | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<CommercePaymentRecord | null>(null);
  const [compensationReason, setCompensationReason] = React.useState('');

  const read = state.data;
  const compensatedIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const row of read?.items ?? []) {
      if (row.reversesPaymentId) ids.add(row.reversesPaymentId);
    }
    return ids;
  }, [read]);

  const handleAppend = async () => {
    if (pending) return;
    const trimmed = amount.trim();
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(trimmed) || Number(trimmed) <= 0) {
      setFieldError('مبلغ باید عددی بزرگ‌تر از صفر با حداکثر چهار رقم اعشار باشد.');
      return;
    }
    setFieldError(null);
    setPending('append');
    setError(null);
    setMessage(null);
    try {
      await appendCommercePayment(documentId, {
        amount: Number(trimmed),
        method,
        ...(invoiceRef.trim() ? { invoiceRef: invoiceRef.trim() } : {}),
        ...(externalReference.trim() ? { externalReference: externalReference.trim() } : {}),
      });
      setMessage('پرداخت ثبت شد و تاریخچه از سرور بازخوانی شد.');
      setAmount('');
      setInvoiceRef('');
      setExternalReference('');
      onMutated();
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(err, 'ثبت پرداخت انجام نشد؛ مقادیر واردشده حفظ شده است.')
      );
    } finally {
      setPending(null);
    }
  };

  const handleCompensate = async () => {
    if (!target || pending) return;
    setPending('compensate');
    setError(null);
    setMessage(null);
    try {
      // `reason` is UI-3's confirmed follow-up C: `CompensatePaymentDto.reason` (≤500,
      // optional) rides the ONE audit trail — it is never a column and never required.
      const trimmed = compensationReason.trim();
      await compensateCommercePayment(documentId, target.id, {
        ...(trimmed ? { reason: trimmed } : {}),
      });
      setMessage('رویداد جبرانی ثبت شد؛ تاریخچهٔ پرداخت از سرور بازخوانی شد.');
      setTarget(null);
      setCompensationReason('');
      onMutated();
    } catch (err: unknown) {
      setError(commerceActionErrorMessage(err, 'ثبت رویداد جبرانی انجام نشد.'));
    } finally {
      setPending(null);
    }
  };

  if (state.status === 'loading') return <CoreLoading lines={4} />;
  if (state.status === 'error') {
    return <CoreError message={state.error ?? 'خطا'} onRetry={onRetry} />;
  }

  return (
    <div data-testid="commerce-payments-section">
      <CommerceSectionHeading
        title="وضعیت پرداخت"
        description="وضعیت از کل تاریخچهٔ پرداخت این سند محاسبه می‌شود (بدون اعمال فیلتر)."
      />
      <div
        className="mb-6 flex flex-wrap items-center gap-3"
        data-testid="commerce-payments-projection"
      >
        <CommercePaymentStatusBadge status={read?.paymentStatus.status ?? null} />
        <span className="text-sm text-foreground">
          پرداخت‌شده: {decimalDisplayLabel(read?.paymentStatus.paidAmount ?? null)}
        </span>
        <span className="text-sm text-muted-foreground">
          جمع کل: {decimalDisplayLabel(read?.paymentStatus.totalAmount ?? null)}
          {read?.paymentStatus.currency ? ` ${read.paymentStatus.currency}` : ''}
        </span>
      </div>

      {canManage && (
        <div className="mb-6 rounded-2xl border border-border bg-secondary/20 p-4">
          <CommerceSectionHeading
            title="ثبت پرداخت"
            description="پرداخت جدید به انتهای تاریخچه اضافه می‌شود؛ واحد پول از سند گرفته می‌شود."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label
                htmlFor="commerce-payment-amount"
                className="mb-1 block text-xs text-muted-foreground"
              >
                مبلغ
              </label>
              <input
                id="commerce-payment-amount"
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={amount}
                disabled={pending !== null}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'commerce-payment-amount-error' : undefined}
                onChange={(event) => setAmount(event.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
              {fieldError && (
                <p id="commerce-payment-amount-error" className="mt-1 text-xs text-destructive">
                  {fieldError}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="commerce-payment-method"
                className="mb-1 block text-xs text-muted-foreground"
              >
                روش پرداخت
              </label>
              <select
                id="commerce-payment-method"
                value={method}
                disabled={pending !== null}
                onChange={(event) => setMethod(event.target.value as CommercePaymentMethod)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              >
                {COMMERCE_PAYMENT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {commercePaymentMethodLabel(value)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="commerce-payment-invoice"
                className="mb-1 block text-xs text-muted-foreground"
              >
                ارجاع فاکتور (اختیاری)
              </label>
              <input
                id="commerce-payment-invoice"
                type="text"
                dir="ltr"
                maxLength={128}
                value={invoiceRef}
                disabled={pending !== null}
                onChange={(event) => setInvoiceRef(event.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
            </div>
            <div>
              <label
                htmlFor="commerce-payment-external"
                className="mb-1 block text-xs text-muted-foreground"
              >
                ارجاع خارجی (اختیاری)
              </label>
              <input
                id="commerce-payment-external"
                type="text"
                dir="ltr"
                maxLength={128}
                value={externalReference}
                disabled={pending !== null}
                onChange={(event) => setExternalReference(event.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
            </div>
          </div>
          <div className="mt-4">
            <Button
              type="button"
              onClick={() => void handleAppend()}
              disabled={pending !== null}
              aria-busy={pending === 'append'}
              data-testid="commerce-payment-submit"
            >
              {pending === 'append' ? 'در حال ثبت…' : 'ثبت پرداخت'}
            </Button>
          </div>
        </div>
      )}

      <CommerceSectionHeading title="تاریخچهٔ پرداخت" description="از قدیمی به جدید؛ ردیف‌ها افزودنی‌اند و ویرایش نمی‌شوند." />
      {(read?.items ?? []).length === 0 ? (
        <CommerceEmptyState
          testId="commerce-payments-empty"
          message="هنوز پرداختی برای این سند ثبت نشده است."
        />
      ) : (
        <ul data-testid="commerce-payments-history" className="divide-y divide-border">
          {(read?.items ?? []).map((row) => {
            const isCompensation = row.reversesPaymentId !== null;
            const isCompensated = compensatedIds.has(row.id);
            return (
              <li key={row.id} data-testid={`commerce-payment-row-${row.id}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                    <span dir="ltr" className="font-medium">
                      {decimalDisplayLabel(row.amount)}
                    </span>
                    <span className="text-xs text-muted-foreground">{commercePaymentMethodLabel(row.method)}</span>
                    {isCompensation && <CommerceBadge tone="info">رویداد جبرانی</CommerceBadge>}
                    {isCompensated && <CommerceBadge tone="muted">جبران‌شده</CommerceBadge>}
                    {row.currency && <span className="text-xs text-muted-foreground">{row.currency}</span>}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span title={row.paymentDate ?? row.createdAt}>
                      {commerceInstantLabel(row.paymentDate ?? row.createdAt)}
                    </span>
                    {row.invoiceRef && (
                      <span className="ms-3" dir="ltr">
                        فاکتور: {row.invoiceRef}
                      </span>
                    )}
                    {row.externalReference && (
                      <span className="ms-3" dir="ltr">
                        ارجاع: {row.externalReference}
                      </span>
                    )}
                    {isCompensation && row.reversesPaymentId && (
                      <span className="ms-3" dir="ltr">
                        جبرانِ: {row.reversesPaymentId}
                      </span>
                    )}
                  </p>
                </div>
                  {canManage && !isCompensation && !isCompensated && (
                    <Button
                      type="button"
                      onClick={() => {
                        setTarget(row);
                        setCompensationReason('');
                      }}
                      disabled={pending !== null}
                      data-testid={`commerce-payment-compensate-${row.id}`}
                      className="h-9 shrink-0 border border-border bg-background px-3 text-xs text-destructive hover:bg-destructive/10"
                    >
                      ابطال (جبران)
                    </Button>
                  )}
              </li>
            );
          })}
        </ul>
      )}

      {message && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-payments-message"
          className="mt-4 text-xs text-emerald-600 dark:text-emerald-400"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-payments-error"
          className="mt-4 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <CommerceConfirmDialog
        open={target !== null}
        testId="commerce-payment-compensate-dialog"
        title="ابطال پرداخت با رویداد جبرانی"
        description={
          <span>
            این پرداخت حذف نمی‌شود؛ یک رویداد جبرانی برای آن ثبت خواهد شد.
            {target && (
              <span className="mt-1 block" dir="ltr">
                {decimalDisplayLabel(target.amount)} {target.currency}
              </span>
            )}
            <span className="mt-3 block">
              <label
                htmlFor="commerce-payment-compensation-reason"
                className="mb-1 block text-xs text-muted-foreground"
              >
                دلیل (اختیاری)
              </label>
              <input
                id="commerce-payment-compensation-reason"
                type="text"
                maxLength={500}
                value={compensationReason}
                disabled={pending === 'compensate'}
                onChange={(event) => setCompensationReason(event.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
            </span>
          </span>
        }
        consequences="مبلغ جبران، معکوس کامل همین ردیف است و مقدار جزئی قابل ورود نیست؛ این عمل قابل بازگشت نیست."
        confirmLabel="ثبت رویداد جبرانی"
        confirmTone="danger"
        pending={pending === 'compensate'}
        onConfirm={() => void handleCompensate()}
        onCancel={() => {
          setTarget(null);
          setCompensationReason('');
        }}
      />
    </div>
  );
}