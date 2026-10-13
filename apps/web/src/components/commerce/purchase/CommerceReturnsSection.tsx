'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  approveCommerceReturn,
  createCommerceReturn,
  receiveBackCommerceReturn,
  rejectCommerceReturn,
  refundCommerceReturn,
  type CommercePaymentsRead,
  type CommercePurchaseLine,
  type CommerceReceiptsRead,
  type CommerceReturn,
  type CommerceReturnsRead,
} from '@/lib/commerce-api';
import {
  COMMERCE_RETURN_CHAIN,
  commerceActionErrorMessage,
  commerceInstantLabel,
  commerceReturnStateLabel,
} from '@/lib/commerce-labels';
import { compareDecimal, decimalDisplayLabel, subtractDecimal, sumDecimals } from '@/lib/commerce-decimals';
import {
  CommerceEmptyState,
  CommerceReturnStateBadge,
  CommerceSectionHeading,
} from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';
import type { SectionState } from './section-state';

/** One editable entry of the create-return form. */
interface ReturnEntryDraft {
  key: string;
  receiptLineId: string;
  quantity: string;
}

function newReturnEntry(receiptLineId: string): ReturnEntryDraft {
  return { key: `ret-${Math.random().toString(36).slice(2, 10)}`, receiptLineId, quantity: '' };
}

type PendingCommand =
  | { kind: 'approve'; ret: CommerceReturn }
  | { kind: 'reject'; ret: CommerceReturn }
  | { kind: 'receive-back'; ret: CommerceReturn };

/** A purchase line's display label — shared shape with the receiving section. */
function lineLabel(line: CommercePurchaseLine): string {
  const description = line.technicalDescription?.trim();
  return `ردیف ${toPersianDigits(line.lineNumber)}${description ? ` — ${description}` : ''}`;
}

/**
 * PHASE UI-2: «مرجوعی‌ها» — the child lifecycle of one document (UI-0 J9, C1-S).
 *
 * A RETURN IS NOT «EDITING THE PURCHASE». It carries its own five-state machine, shown
 * as a four-step chain (REQUESTED → APPROVED → RECEIVED_BACK → REFUNDED) plus the REJECTED
 * branch, with the current state marked — a DISPLAY marker, never a legality decision:
 * only the backend's matrix decides whether a command is allowed, and every refusal
 * arrives as 409 `invalid_transition` (mapped centrally) and is followed by a refetch.
 *
 * THE COMMANDS EXPOSED ARE EXACTLY THE FOUR THE ROUTES IMPLEMENT — approve, reject,
 * receive-back, refund — plus creation. Nothing else: no cancel, no edit, no delete (the
 * backend has no such routes). Refund asks WHICH payment to compensate (Q's `paymentId`)
 * from a real select built over the payments read — never a free-text id.
 */
export function CommerceReturnsSection({
  documentId,
  state,
  receiptsState,
  paymentsState,
  purchaseLines,
  canManage,
  onRetry,
  onMutated,
  onPaymentsMutated,
}: {
  documentId: string;
  state: SectionState<CommerceReturnsRead>;
  receiptsState: SectionState<CommerceReceiptsRead>;
  paymentsState: SectionState<CommercePaymentsRead>;
  purchaseLines: CommercePurchaseLine[];
  canManage: boolean;
  onRetry: () => void;
  onMutated: () => void;
  onPaymentsMutated: () => void;
}) {
  const read = state.data;

  const [reason, setReason] = React.useState('');
  const [replacementRequired, setReplacementRequired] = React.useState(false);
  const [entries, setEntries] = React.useState<ReturnEntryDraft[]>(() => [newReturnEntry('')]);
  const [pending, setPending] = React.useState<'create' | 'command' | 'refund' | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [command, setCommand] = React.useState<PendingCommand | null>(null);

  /** The RECEIVED_BACK return currently opening its refund form, with the chosen payment. */
  const [refunding, setRefunding] = React.useState<CommerceReturn | null>(null);
  const [refundPaymentId, setRefundPaymentId] = React.useState('');
  const [refundReason, setRefundReason] = React.useState('');

  const lineById = React.useMemo(() => {
    const map = new Map<string, CommercePurchaseLine>();
    for (const line of purchaseLines) map.set(line.id, line);
    return map;
  }, [purchaseLines]);

  /** Candidate receipt lines: every REAL arrival from the receipts read. */
  const receiptLineOptions = React.useMemo(() => {
    const options: Array<{
      receiptLineId: string;
      purchaseLineId: string;
      netReceived: string | null;
    }> = [];
    for (const receipt of receiptsState.data?.receipts ?? []) {
      for (const line of receipt.lines) {
        if (line.reversesReceiptLineId !== null) continue;
        const corrections: string[] = [];
        for (const other of receiptsState.data?.receipts ?? []) {
          for (const candidate of other.lines) {
            if (candidate.reversesReceiptLineId === line.id) corrections.push(candidate.quantity);
          }
        }
        const net = subtractDecimal(
          sumDecimals([line.quantity]) ?? '0',
          sumDecimals(corrections) ?? '0'
        );
        options.push({
          receiptLineId: line.id,
          purchaseLineId: line.purchaseLineId,
          netReceived: net,
        });
      }
    }
    return options;
  }, [receiptsState.data]);

  /** How much of one receipt line is still returnable — DISPLAY-ONLY hint (S-D1 mirror). */
  const availableFor = (receiptLineId: string): string | null => {
    const option = receiptLineOptions.find((item) => item.receiptLineId === receiptLineId);
    if (!option || option.netReceived === null) return null;
    const returned = (read?.returns ?? [])
      .filter((ret) => ret.state !== 'REJECTED')
      .flatMap((ret) => ret.lines)
      .filter((line) => line.receiptLineId === receiptLineId)
      .map((line) => line.quantity);
    const already = sumDecimals(returned) ?? '0';
    return subtractDecimal(option.netReceived, already);
  };

  /** Q's compensation targets: regular, not-yet-compensated, positive payment rows. */
  const refundablePayments = React.useMemo(() => {
    const items = paymentsState.data?.items ?? [];
    const compensated = new Set(
      items.filter((row) => row.reversesPaymentId).map((row) => row.reversesPaymentId)
    );
    return items.filter(
      (row) =>
        row.reversesPaymentId === null &&
        !compensated.has(row.id) &&
        compareDecimal(row.amount, '0') === 1
    );
  }, [paymentsState.data]);

  const runCommand = async (kind: PendingCommand['kind'], ret: CommerceReturn) => {
    if (pending) return;
    setPending('command');
    setError(null);
    setMessage(null);
    try {
      if (kind === 'approve') {
        await approveCommerceReturn(documentId, ret.id);
        setMessage('مرجوعی تأیید شد؛ وضعیت جدید از سرور بازخوانی شد.');
      } else if (kind === 'reject') {
        await rejectCommerceReturn(documentId, ret.id);
        setMessage('مرجوعی رد شد؛ سند درخواست خرید دست‌نخورده مانده است.');
      } else {
        await receiveBackCommerceReturn(documentId, ret.id);
        setMessage('دریافت کالای برگشتی ثبت شد؛ وضعیت جدید از سرور بازخوانی شد.');
      }
      onMutated();
    } catch (err: unknown) {
      setError(commerceActionErrorMessage(err, 'انجام اقدام روی مرجوعی ممکن نشد.'));
      onMutated();
    } finally {
      setPending(null);
      setCommand(null);
    }
  };

  const handleCreate = async () => {
    if (pending) return;
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      setError('دلیل مرجوعی الزامی است (۱ تا ۵۰۰ نویسه).');
      return;
    }
    const parsed = entries
      .filter((entry) => entry.receiptLineId)
      .map((entry) => ({ receiptLineId: entry.receiptLineId, quantity: entry.quantity.trim() }));
    if (parsed.length === 0) {
      setError('حداقل یک ردیف برای مرجوعی لازم است.');
      return;
    }
    for (const entry of parsed) {
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(entry.quantity) || Number(entry.quantity) <= 0) {
        setError('مقدار هر ردیف باید عددی بزرگ‌تر از صفر با حداکثر چهار رقم اعشار باشد.');
        return;
      }
    }

    setPending('create');
    setError(null);
    setMessage(null);
    try {
      await createCommerceReturn(documentId, {
        reason: trimmedReason,
        replacementRequired,
        lines: parsed.map((entry) => {
          const option = receiptLineOptions.find(
            (item) => item.receiptLineId === entry.receiptLineId
          );
          return {
            purchaseLineId: option?.purchaseLineId ?? '',
            receiptLineId: entry.receiptLineId,
            quantity: Number(entry.quantity),
          };
        }),
      });
      setMessage('درخواست مرجوعی ثبت شد و در وضعیت «درخواست‌شده» قرار گرفت.');
      setReason('');
      setReplacementRequired(false);
      setEntries([newReturnEntry(receiptLineOptions[0]?.receiptLineId ?? '')]);
      onMutated();
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(err, 'ثبت مرجوعی انجام نشد؛ مقادیر واردشده حفظ شده است.')
      );
    } finally {
      setPending(null);
    }
  };

  const handleRefund = async () => {
    if (!refunding || pending) return;
    if (!refundPaymentId) {
      setError('برای بازپرداخت، یک پرداخت موردنظر را انتخاب کنید.');
      return;
    }
    setPending('refund');
    setError(null);
    setMessage(null);
    try {
      await refundCommerceReturn(documentId, refunding.id, {
        paymentId: refundPaymentId,
        ...(refundReason.trim() ? { reason: refundReason.trim() } : {}),
      });
      setMessage('بازپرداخت ثبت شد؛ رویداد جبرانی پرداخت و وضعیت مرجوعی از سرور بازخوانی شدند.');
      setRefunding(null);
      setRefundPaymentId('');
      setRefundReason('');
      onMutated();
      onPaymentsMutated();
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(err, 'بازپرداخت انجام نشد؛ وضعیت مرجوعی تغییری نکرده است.')
      );
      onMutated();
    } finally {
      setPending(null);
    }
  };

  if (state.status === 'loading') return <CoreLoading lines={4} />;
  if (state.status === 'error') {
    return <CoreError message={state.error ?? 'خطا'} onRetry={onRetry} />;
  }

  return (
    <div data-testid="commerce-returns-section">
      {canManage && (
        <div className="mb-6 rounded-2xl border border-border bg-secondary/20 p-4">
          <CommerceSectionHeading
            title="ثبت درخواست مرجوعی"
            description="مرجوعی یک چرخهٔ جداگانه است؛ سند درخواست خرید را تغییر نمی‌دهد."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="commerce-return-reason"
                className="mb-1 block text-xs text-muted-foreground"
              >
                دلیل مرجوعی
              </label>
              <input
                id="commerce-return-reason"
                type="text"
                maxLength={500}
                value={reason}
                disabled={pending !== null}
                onChange={(event) => setReason(event.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
            </div>
            <label className="flex items-center gap-2 self-end py-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={replacementRequired}
                disabled={pending !== null}
                onChange={(event) => setReplacementRequired(event.target.checked)}
                className="h-4 w-4"
              />
              جایگزینی کالا لازم است
            </label>
          </div>

          <ul className="mt-3 space-y-3">
            {entries.map((entry, index) => {
              const available = entry.receiptLineId ? availableFor(entry.receiptLineId) : null;
              return (
                <li key={entry.key} className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr,1fr,auto]">
                  <div>
                    <label
                      htmlFor={`commerce-return-entry-line-${index + 1}`}
                      className="mb-1 block text-xs text-muted-foreground"
                    >
                      رسید مبدأ
                    </label>
                    <select
                      id={`commerce-return-entry-line-${index + 1}`}
                      value={entry.receiptLineId}
                      disabled={pending !== null}
                      onChange={(event) =>
                        setEntries((prev) =>
                          prev.map((item) =>
                            item.key === entry.key
                              ? { ...item, receiptLineId: event.target.value }
                              : item
                          )
                        )
                      }
                      className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                    >
                      <option value="">انتخاب کنید…</option>
                      {receiptLineOptions.map((item) => (
                        <option key={item.receiptLineId} value={item.receiptLineId}>
                          {`${
                            lineById.get(item.purchaseLineId)
                              ? lineLabel(lineById.get(item.purchaseLineId)!)
                              : item.purchaseLineId
                          } — رسید ${item.receiptLineId.slice(0, 8)}`}
                        </option>
                      ))}
                    </select>
                    {available !== null && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        قابل مرجوعی (نمایشی): {decimalDisplayLabel(available)}
                      </p>
                    )}
                  </div>
                  <div>
                    <label
                      htmlFor={`commerce-return-entry-quantity-${index + 1}`}
                      className="mb-1 block text-xs text-muted-foreground"
                    >
                      مقدار
                    </label>
                    <input
                      id={`commerce-return-entry-quantity-${index + 1}`}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={entry.quantity}
                      disabled={pending !== null}
                      onChange={(event) =>
                        setEntries((prev) =>
                          prev.map((item) =>
                            item.key === entry.key
                              ? { ...item, quantity: event.target.value }
                              : item
                          )
                        )
                      }
                      className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                    />
                  </div>
                  <div className="flex items-end">
                    {entries.length > 1 && (
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() =>
                          setEntries((prev) => prev.filter((item) => item.key !== entry.key))
                        }
                        aria-label={`حذف ردیف ${index + 1}`}
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
              onClick={() =>
                setEntries((prev) => [...prev, newReturnEntry(receiptLineOptions[0]?.receiptLineId ?? '')])
              }
              disabled={pending !== null}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              افزودن ردیف
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreate()}
              disabled={pending !== null}
              aria-busy={pending === 'create'}
              data-testid="commerce-return-submit"
            >
              {pending === 'create' ? 'در حال ثبت…' : 'ثبت درخواست مرجوعی'}
            </Button>
          </div>
        </div>
      )}
      <CommerceSectionHeading
        title="تاریخچهٔ مرجوعی‌ها"
        description="هر مرجوعی زنجیرهٔ وضعیت خودش را دارد؛ سند درخواست خرید از آن تأثیر نمی‌پذیرد."
      />
      {(read?.returns ?? []).length === 0 ? (
        <CommerceEmptyState
          testId="commerce-returns-empty"
          message="هنوز مرجوعی‌ای برای این سند ثبت نشده است."
        />
      ) : (
        <ul data-testid="commerce-returns-history" className="space-y-4">
          {(read?.returns ?? []).map((ret) => {
            const currentIndex = COMMERCE_RETURN_CHAIN.indexOf(
              ret.state as (typeof COMMERCE_RETURN_CHAIN)[number]
            );
            return (
              <li
                key={ret.id}
                data-testid={`commerce-return-${ret.id}`}
                className="rounded-2xl border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CommerceReturnStateBadge state={ret.state} />
                  <span className="text-xs text-muted-foreground" title={ret.createdAt}>
                    {commerceInstantLabel(ret.createdAt)}
                  </span>
                </div>

                <ol
                  className="mt-3 flex flex-wrap items-center gap-2 text-xs"
                  aria-label="زنجیرهٔ وضعیت مرجوعی"
                >
                  {COMMERCE_RETURN_CHAIN.map((link) => {
                    const linkIndex = COMMERCE_RETURN_CHAIN.indexOf(link);
                    const isCurrent = ret.state !== 'REJECTED' && currentIndex === linkIndex;
                    const done = ret.state !== 'REJECTED' && currentIndex > linkIndex;
                    return (
                      <li
                        key={link}
                        aria-current={isCurrent ? 'step' : undefined}
                        className={`rounded-full border px-2 py-0.5 ${
                          isCurrent
                            ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                            : done
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                              : 'border-border text-muted-foreground'
                        }`}
                      >
                        {commerceReturnStateLabel(link)}
                      </li>
                    );
                  })}
                  {ret.state === 'REJECTED' && (
                    <li className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive">
                      {commerceReturnStateLabel('REJECTED')}
                    </li>
                  )}
                </ol>

                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {ret.lines.map((line) => {
                    const purchaseLine = lineById.get(line.purchaseLineId);
                    return (
                      <li key={line.id}>
                        {purchaseLine ? lineLabel(purchaseLine) : line.purchaseLineId} — مقدار{' '}
                        <span dir="ltr">{decimalDisplayLabel(line.quantity)}</span> علیه رسید{' '}
                        <span dir="ltr">{line.receiptLineId.slice(0, 8)}</span>
                      </li>
                    );
                  })}
                </ul>

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-primary">
                    گذارهای ثبت‌شده
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {ret.transitions.map((transition) => (
                      <li key={transition.id}>
                        {commerceReturnStateLabel(transition.state)} —{' '}
                        <span title={transition.createdAt}>
                          {commerceInstantLabel(transition.createdAt)}
                        </span>
                        {transition.reason ? ` — ${transition.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>

                {canManage && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {ret.state === 'REQUESTED' && (
                      <>
                        <Button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => setCommand({ kind: 'approve', ret })}
                          data-testid={`commerce-return-approve-${ret.id}`}
                          className="h-9 px-3 text-xs"
                        >
                          تأیید
                        </Button>
                        <Button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => setCommand({ kind: 'reject', ret })}
                          data-testid={`commerce-return-reject-${ret.id}`}
                          className="h-9 border border-border bg-background px-3 text-xs text-destructive hover:bg-destructive/10"
                        >
                          رد
                        </Button>
                      </>
                    )}
                    {ret.state === 'APPROVED' && (
                      <Button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => setCommand({ kind: 'receive-back', ret })}
                        data-testid={`commerce-return-receive-back-${ret.id}`}
                        className="h-9 px-3 text-xs"
                      >
                        ثبت دریافت کالای برگشتی
                      </Button>
                    )}
                    {ret.state === 'RECEIVED_BACK' && (
                      <Button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => {
                          setRefunding(ret);
                          setRefundPaymentId(refundablePayments[0]?.id ?? '');
                          setRefundReason('');
                        }}
                        data-testid={`commerce-return-refund-open-${ret.id}`}
                        className="h-9 px-3 text-xs"
                      >
                        ثبت بازپرداخت
                      </Button>
                    )}
                  </div>
                )}
              {refunding?.id === ret.id && (
                <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
                  <p className="text-xs text-muted-foreground">
                    بازپرداخت یک رویداد جبرانی روی پرداخت انتخابی ثبت می‌کند و وضعیت مرجوعی را به
                    «بازپرداخت‌شده» می‌برد؛ اگر جبران پرداخت ممکن نباشد، هیچ تغییری ثبت نمی‌شود.
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label
                        htmlFor="commerce-refund-payment"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        پرداخت موردنظر
                      </label>
                      <select
                        id="commerce-refund-payment"
                        value={refundPaymentId}
                        disabled={pending !== null}
                        onChange={(event) => setRefundPaymentId(event.target.value)}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                      >
                        {refundablePayments.length === 0 && (
                          <option value="">پرداخت قابل بازپرداختی موجود نیست</option>
                        )}
                        {refundablePayments.map((row) => (
                          <option key={row.id} value={row.id}>
                            {`${decimalDisplayLabel(row.amount)} ${row.currency} — ${row.id.slice(0, 8)}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="commerce-refund-reason"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        دلیل (اختیاری)
                      </label>
                      <input
                        id="commerce-refund-reason"
                        type="text"
                        maxLength={500}
                        value={refundReason}
                        disabled={pending !== null}
                        onChange={(event) => setRefundReason(event.target.value)}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <Button
                        type="button"
                        disabled={pending !== null || refundablePayments.length === 0}
                        onClick={() => void handleRefund()}
                        aria-busy={pending === 'refund'}
                        data-testid="commerce-refund-submit"
                      >
                        {pending === 'refund' ? 'در حال ثبت…' : 'ثبت بازپرداخت'}
                      </Button>
                      <button
                        type="button"
                        onClick={() => setRefunding(null)}
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
      )}
      <CommerceConfirmDialog
        open={command !== null}
        testId="commerce-return-command-dialog"
        title={
          command?.kind === 'approve'
            ? 'تأیید مرجوعی'
            : command?.kind === 'reject'
              ? 'رد مرجوعی'
              : 'ثبت دریافت کالای برگشتی'
        }
        description={
          command
            ? `وضعیت فعلی: ${commerceReturnStateLabel(command.ret.state)}`
            : undefined
        }
        consequences={
          command?.kind === 'approve'
            ? 'مرجوعی به «تأییدشده» می‌رود و مرحلهٔ بعدی آن دریافت کالای برگشتی است؛ سند درخواست خرید تغییری نمی‌کند.'
            : command?.kind === 'reject'
              ? 'مرجوعی «ردشده» می‌شود و دیگر ادامه نمی‌یابد؛ سند درخواست خرید دست‌نخورده می‌ماند.'
              : 'کالای برگشتی دریافت می‌شود و مرجوعی به «کالا برگشت خورد» می‌رود؛ بازپرداخت هنوز ثبت نشده است.'
        }
        confirmLabel={
          command?.kind === 'approve'
            ? 'تأیید مرجوعی'
            : command?.kind === 'reject'
              ? 'رد مرجوعی'
              : 'ثبت دریافت برگشتی'
        }
        confirmTone={command?.kind === 'reject' ? 'danger' : 'primary'}
        pending={pending === 'command'}
        onConfirm={() => {
          if (command) void runCommand(command.kind, command.ret);
        }}
        onCancel={() => setCommand(null)}
      />

      {message && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-returns-message"
          className="mt-4 text-xs text-emerald-600 dark:text-emerald-400"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-returns-error"
          className="mt-4 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}