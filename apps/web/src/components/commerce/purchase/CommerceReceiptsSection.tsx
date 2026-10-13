'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  appendCommerceReceipt,
  compensateCommerceReceiptLine,
  type CommercePurchaseLine,
  type CommerceReceipt,
  type CommerceReceiptsRead,
  type CommerceReceivingLineProjection,
} from '@/lib/commerce-api';
import { commerceActionErrorMessage, commerceInstantLabel } from '@/lib/commerce-labels';
import { compareDecimal, decimalDisplayLabel, subtractDecimal } from '@/lib/commerce-decimals';
import {
  CommerceBadge,
  CommerceEmptyState,
  CommerceReceivingStatusBadge,
  CommerceSectionHeading,
} from '../commerce-ui';
import type { SectionState } from './section-state';

/** One editable entry of the append form — a client-only key plus the two wire fields. */
interface ReceiptEntryDraft {
  key: string;
  purchaseLineId: string;
  quantity: string;
}

function newEntry(purchaseLineId: string): ReceiptEntryDraft {
  return { key: `entry-${Math.random().toString(36).slice(2, 10)}`, purchaseLineId, quantity: '' };
}

/** A purchase line's own display label — «ردیف ۲ — شرح». Never invented, never a bare id. */
function lineLabel(line: CommercePurchaseLine): string {
  const description = line.technicalDescription?.trim();
  return `ردیف ${toPersianDigits(line.lineNumber)}${description ? ` — ${description}` : ''}`;
}

/**
 * PHASE UI-2: «دریافت‌ها» — the receiving events of one document (UI-0 J8, C1-R).
 *
 * EVENTS, NOT A LEDGER. The history is append-only; «ابطال (جبران)» APPENDS a
 * compensating event (a NEGATIVE quantity derived by the server) and never edits or
 * removes the arrival it corrects — the screen says that in words. Partial compensation
 * IS legal here (unlike payments), which is why the inline correction form asks for a
 * positive magnitude.
 *
 * THE REMAINING-QUANTITY HINT IS DISPLAY-ONLY (prompt §24): it is `ordered − received`
 * computed exactly from the server's own two numbers (BigInt over the wire strings, never
 * floats) and it WARNS without blocking — the server evaluates the same invariant under a
 * row lock and answers 409, which the section renders as the Persian sentence mapping in
 * `commerceActionErrorMessage` (including the three quantities the server stated).
 */
export function CommerceReceiptsSection({
  documentId,
  state,
  purchaseLines,
  canManage,
  onRetry,
  onMutated,
}: {
  documentId: string;
  state: SectionState<CommerceReceiptsRead>;
  purchaseLines: CommercePurchaseLine[];
  canManage: boolean;
  onRetry: () => void;
  onMutated: () => void;
}) {
  const read = state.data;

  const firstLineId = purchaseLines[0]?.id ?? '';
  const [entries, setEntries] = React.useState<ReceiptEntryDraft[]>(() => [newEntry(firstLineId)]);
  const [pending, setPending] = React.useState<'append' | 'compensate' | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** The selected receipt line being corrected, with the positive magnitude to compensate. */
  const [correcting, setCorrecting] = React.useState<{ receiptLine: CommerceReceipt['lines'][number] } | null>(null);
  const [correctionQuantity, setCorrectionQuantity] = React.useState('');
  const [correctionReason, setCorrectionReason] = React.useState('');

  const projectionByLine = React.useMemo(() => {
    const map = new Map<string, CommerceReceivingLineProjection>();
    for (const row of read?.lines ?? []) map.set(row.purchaseLineId, row);
    return map;
  }, [read]);

  const lineById = React.useMemo(() => {
    const map = new Map<string, CommercePurchaseLine>();
    for (const line of purchaseLines) map.set(line.id, line);
    return map;
  }, [purchaseLines]);

  const updateEntry = (key: string, patch: Partial<ReceiptEntryDraft>) => {
    setEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  };

  const remainingFor = (purchaseLineId: string): string | null => {
    const row = projectionByLine.get(purchaseLineId);
    if (!row) return null;
    return subtractDecimal(row.orderedQuantity, row.receivedQuantity);
  };

  const handleAppend = async () => {
    if (pending) return;
    const parsed = entries
      .filter((entry) => entry.purchaseLineId)
      .map((entry) => ({ purchaseLineId: entry.purchaseLineId, quantity: entry.quantity.trim() }));

    if (parsed.length === 0) {
      setError('حداقل یک ردیف برای ثبت دریافت لازم است.');
      return;
    }
    for (const entry of parsed) {
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(entry.quantity) || Number(entry.quantity) <= 0) {
        setError('مقدار هر ردیف باید عددی بزرگ‌تر از صفر با حداکثر چهار رقم اعشار باشد.');
        return;
      }
    }

    setPending('append');
    setError(null);
    setMessage(null);
    try {
      await appendCommerceReceipt(documentId, {
        lines: parsed.map((entry) => ({
          purchaseLineId: entry.purchaseLineId,
          quantity: Number(entry.quantity),
        })),
      });
      setMessage('دریافت ثبت شد و وضعیت ردیف‌ها از سرور بازخوانی شد.');
      setEntries([newEntry(firstLineId)]);
      onMutated();
    } catch (err: unknown) {
      setError(commerceActionErrorMessage(err, 'ثبت دریافت انجام نشد؛ مقادیر واردشده حفظ شده است.'));
    } finally {
      setPending(null);
    }
  };

  const handleCompensate = async () => {
    if (!correcting || pending) return;
    const trimmed = correctionQuantity.trim();
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(trimmed) || Number(trimmed) <= 0) {
      setError('مقدار جبران باید عددی بزرگ‌تر از صفر با حداکثر چهار رقم اعشار باشد.');
      return;
    }
    setPending('compensate');
    setError(null);
    setMessage(null);
    try {
      await compensateCommerceReceiptLine(documentId, correcting.receiptLine.id, {
        quantity: Number(trimmed),
        ...(correctionReason.trim() ? { reason: correctionReason.trim() } : {}),
      });
      setMessage('رویداد جبرانی ثبت شد؛ رویداد اصلی دست‌نخورده مانده و وضعیت بازخوانی شد.');
      setCorrecting(null);
      setCorrectionQuantity('');
      setCorrectionReason('');
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
    <div data-testid="commerce-receipts-section">
      <CommerceSectionHeading
        title="پیشرفت دریافت"
        description="خالص دریافت‌شدهٔ هر ردیف، از مجموع رویدادهای ثبت‌شده."
      />
      <ul data-testid="commerce-receiving-progress" className="mb-6 divide-y divide-border">
        {(read?.lines ?? []).map((row) => {
          const line = lineById.get(row.purchaseLineId);
          const remaining = subtractDecimal(row.orderedQuantity, row.receivedQuantity);
          return (
            <li
              key={row.purchaseLineId}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="text-sm text-foreground">
                {line ? lineLabel(line) : row.purchaseLineId}
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {decimalDisplayLabel(row.receivedQuantity)} از{' '}
                  {decimalDisplayLabel(row.orderedQuantity)}
                </span>
                {remaining !== null && (
                  <span className="text-xs text-muted-foreground">
                    باقی‌مانده: {decimalDisplayLabel(remaining)}
                  </span>
                )}
                <CommerceReceivingStatusBadge status={row.receivingStatus} />
              </span>
            </li>
          );
        })}
      </ul>

      {canManage && (
        <div className="mb-6 rounded-2xl border border-border bg-secondary/20 p-4">
          <CommerceSectionHeading
            title="ثبت دریافت"
            description="هر قلم یک رسید است؛ یک ردیف سفارش می‌تواند در چند نوبت دریافت شود."
          />
          <ul className="space-y-3">
            {entries.map((entry, index) => {
              const remaining = entry.purchaseLineId ? remainingFor(entry.purchaseLineId) : null;
              const exceeds =
                remaining !== null && entry.quantity.trim().length > 0
                  ? compareDecimal(entry.quantity.trim(), remaining) === 1
                  : false;
              return (
                <li key={entry.key} className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr,1fr,auto]">
                  <div>
                    <label
                      htmlFor={`receipt-entry-line-${index + 1}`}
                      className="mb-1 block text-xs text-muted-foreground"
                    >
                      ردیف سفارش
                    </label>
                    <select
                      id={`receipt-entry-line-${index + 1}`}
                      value={entry.purchaseLineId}
                      disabled={pending !== null}
                      onChange={(event) =>
                        updateEntry(entry.key, { purchaseLineId: event.target.value })
                      }
                      className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                    >
                      {purchaseLines.map((line) => (
                        <option key={line.id} value={line.id}>
                          {lineLabel(line)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor={`receipt-entry-quantity-${index + 1}`}
                      className="mb-1 block text-xs text-muted-foreground"
                    >
                      مقدار
                    </label>
                    <input
                      id={`receipt-entry-quantity-${index + 1}`}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={entry.quantity}
                      disabled={pending !== null}
                      aria-describedby={exceeds ? `receipt-entry-hint-${index + 1}` : undefined}
                      onChange={(event) => updateEntry(entry.key, { quantity: event.target.value })}
                      className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                    />
                    {exceeds && remaining !== null && (
                      <p
                        id={`receipt-entry-hint-${index + 1}`}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        بیشتر از باقی‌ماندهٔ نمایش‌داده‌شده ({decimalDisplayLabel(remaining)}) است؛
                        تصمیم نهایی با سرور است.
                      </p>
                    )}
                  </div>
                  <div className="flex items-end">
                    {entries.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setEntries((prev) => prev.filter((item) => item.key !== entry.key))
                        }
                        disabled={pending !== null}
                        aria-label={`حذف قلم ${toPersianDigits(index + 1)}`}
                        className="h-10 rounded-xl border border-border px-3 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                      >
                        حذف
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => setEntries((prev) => [...prev, newEntry(firstLineId)])}
              disabled={pending !== null}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              افزودن قلم
            </Button>
            <Button
              type="button"
              onClick={() => void handleAppend()}
              disabled={pending !== null}
              aria-busy={pending === 'append'}
              data-testid="commerce-receipt-submit"
            >
              {pending === 'append' ? 'در حال ثبت…' : 'ثبت دریافت'}
            </Button>
          </div>
        </div>
      )}

      <CommerceSectionHeading
        title="رویدادهای دریافت"
        description="از قدیمی به جدید؛ رویداد ثبت‌شده هرگز ویرایش نمی‌شود."
      />
      {(read?.receipts ?? []).length === 0 ? (
        <CommerceEmptyState
          testId="commerce-receipts-empty"
          message="هنوز رویداد دریافتی برای این سند ثبت نشده است."
        />
      ) : (
        <ul data-testid="commerce-receipts-history" className="divide-y divide-border">
          {(read?.receipts ?? []).map((receipt) => {
            const isCompensation = receipt.lines.some(
              (line) => line.reversesReceiptLineId !== null
            );
            return (
              <li
                key={receipt.id}
                data-testid={`commerce-receipt-${receipt.id}`}
                className="py-4"
              >
                <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span title={receipt.receivedAt}>{commerceInstantLabel(receipt.receivedAt)}</span>
                  {isCompensation ? (
                    <CommerceBadge tone="info">رویداد جبرانی</CommerceBadge>
                  ) : (
                    <CommerceBadge tone="muted">دریافت</CommerceBadge>
                  )}
                </p>
                <ul className="mt-2 space-y-2">
                  {receipt.lines.map((line) => {
                    const purchaseLine = lineById.get(line.purchaseLineId);
                    const isCorrecting = correcting?.receiptLine.id === line.id;
                    return (
                      <li key={line.id} className="rounded-xl border border-border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-foreground">
                            {purchaseLine ? lineLabel(purchaseLine) : line.purchaseLineId} —{' '}
                            <span dir="ltr" className="font-medium">
                              {decimalDisplayLabel(line.quantity)}
                            </span>
                          </span>
                          {canManage && line.reversesReceiptLineId === null && !isCorrecting && (
                            <button
                              type="button"
                              disabled={pending !== null}
                              onClick={() => {
                                setCorrecting({ receiptLine: line });
                                setCorrectionQuantity('');
                                setCorrectionReason('');
                              }}
                              data-testid={`commerce-receipt-compensate-${line.id}`}
                              className="h-8 rounded-lg border border-border px-2 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                            >
                              ابطال (جبران جزئی)
                            </button>
                          )}
                        </div>
                        {line.reversesReceiptLineId !== null && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            جبرانِ رویداد: <span dir="ltr">{line.reversesReceiptLineId}</span>
                          </p>
                        )}
                        {isCorrecting && (
                          <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
                            <p className="text-xs text-muted-foreground">
                              این اصلاح یک رویداد جبرانیِ جدید ثبت می‌کند؛ رویداد اصلی حذف یا
                              ویرایش نمی‌شود. مقدار مثبتِ قابل جبران را وارد کنید.
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                              <div>
                                <label
                                  htmlFor="commerce-receipt-correction-quantity"
                                  className="mb-1 block text-xs text-muted-foreground"
                                >
                                  مقدار جبران
                                </label>
                                <input
                                  id="commerce-receipt-correction-quantity"
                                  type="text"
                                  inputMode="decimal"
                                  dir="ltr"
                                  value={correctionQuantity}
                                  disabled={pending !== null}
                                  onChange={(event) => setCorrectionQuantity(event.target.value)}
                                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                                />
                              </div>
                              <div>
                                <label
                                  htmlFor="commerce-receipt-correction-reason"
                                  className="mb-1 block text-xs text-muted-foreground"
                                >
                                  دلیل (اختیاری)
                                </label>
                                <input
                                  id="commerce-receipt-correction-reason"
                                  type="text"
                                  maxLength={500}
                                  value={correctionReason}
                                  disabled={pending !== null}
                                  onChange={(event) => setCorrectionReason(event.target.value)}
                                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                                />
                              </div>
                              <div className="flex items-end gap-2">
                                <Button
                                  type="button"
                                  onClick={() => void handleCompensate()}
                                  disabled={pending !== null}
                                  aria-busy={pending === 'compensate'}
                                  data-testid="commerce-receipt-correction-submit"
                                >
                                  {pending === 'compensate' ? 'در حال ثبت…' : 'ثبت رویداد جبرانی'}
                                </Button>
                                <button
                                  type="button"
                                  onClick={() => setCorrecting(null)}
                                  disabled={pending !== null}
                                  className="h-10 rounded-xl border border-border px-3 text-xs text-foreground hover:bg-secondary disabled:opacity-50"
                                >
                                  انصراف
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {message && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-receipts-message"
          className="mt-4 text-xs text-emerald-600 dark:text-emerald-400"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-receipts-error"
          className="mt-4 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}