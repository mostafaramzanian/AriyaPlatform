'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';

import { toPersianDigits } from '@/lib/calendar-api';
import {
  COMMERCE_LINE_TYPES,
  emptyPurchaseLineDraft,
  type CommerceLineType,
  type CommercePurchaseLineDraft,
} from '@/lib/commerce-api';
import { commerceLineTypeLabel } from '@/lib/commerce-labels';
import { CommerceEmptyState } from '../commerce-ui';
import { Button } from '@/components/ui/button';

/**
 * PHASE UI-2: the Purchase Create line editor.
 *
 * WHAT IT IS. One always-editable card per line — a structured editor (desktop gets a
 * dense multi-column grid, mobile the same card stacked; never a squashed table). Every
 * field the WIRE accepts is here and nothing else: `lineType`, `quantity`, `unit`,
 * `unitPrice`, `tax`, `externalRef`, `itemReference`, `technicalDescription`.
 *
 * WHAT IT IS NOT. No EXPENSE (or any other invented) line type — the select is built
 * from the backend's own `PURCHASE_LINE_TYPES` tuple. No line total, no subtotal: the
 * service derives `lineTotal` from quantity × unit price and the document's totals from
 * the lines, so a client-computed number here would be a second arithmetic that can
 * disagree with the stored one. No reorder control either — position IS array order
 * (the service numbers lines 1…n from the array), and reordering would need a
 * dependency this phase may not add; the honest alternative is that order is preserved.
 *
 * VALIDATION IS PRESENTATION-LAYER ONLY (UI-2 §5): the view checks the obvious bounds
 * the DTO states (positive quantity, ≤ 4 decimals, non-negative amounts, column widths)
 * before anything is sent — the backend re-validates everything and remains
 * authoritative. `errors` arrives ready-made from the view; this component renders each
 * message next to the field it belongs to (`aria-invalid` + `aria-describedby`).
 */

export interface CommerceLineFieldErrors {
  lineType?: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  tax?: string;
  externalRef?: string;
  itemReference?: string;
  technicalDescription?: string;
}

/** `{ [lineKey]: fieldErrors }` — keyed by the draft's client-only `key`. */
export type CommerceLinesErrors = Record<string, CommerceLineFieldErrors>;

/** The DTO's own column widths, restated for the input attributes — one place, no drift. */
export const COMMERCE_LINE_LIMITS = {
  unit: 32,
  externalRef: 128,
  itemReference: 200,
  technicalDescription: 2000,
} as const;

const inputClass =
  'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60';

function Field({
  id,
  label,
  error,
  children,
  className = '',
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A fresh draft with a unique client key. */
export function emptyDraft(): CommercePurchaseLineDraft {
  return emptyPurchaseLineDraft(`line-${Math.random().toString(36).slice(2, 10)}`);
}

export function CommercePurchaseLinesEditor({
  lines,
  onChange,
  errors,
  disabled = false,
}: {
  lines: CommercePurchaseLineDraft[];
  onChange: (lines: CommercePurchaseLineDraft[]) => void;
  errors: CommerceLinesErrors;
  disabled?: boolean;
}) {
  const update = (key: string, patch: Partial<CommercePurchaseLineDraft>) => {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const remove = (key: string) => {
    onChange(lines.filter((line) => line.key !== key));
  };

  const add = () => {
    onChange([...lines, emptyDraft()]);
  };

  return (
    <div data-testid="commerce-lines-editor">
      {lines.length === 0 ? (
        <CommerceEmptyState
          testId="commerce-lines-empty"
          message="هنوز ردیفی اضافه نشده است. برای ثبت درخواست، حداقل یک ردیف لازم است."
        />
      ) : (
        <ul className="space-y-3">
          {lines.map((line, index) => {
            const lineErrors = errors[line.key] ?? {};
            return (
              <li
                key={line.key}
                data-testid={`commerce-line-row-${index + 1}`}
                className="rounded-2xl border border-border bg-card p-4"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-foreground">
                    ردیف {toPersianDigits(index + 1)}
                  </h4>
                  <button
                    type="button"
                    onClick={() => remove(line.key)}
                    disabled={disabled}
                    aria-label={`حذف ردیف ${toPersianDigits(index + 1)}`}
                    data-testid={`commerce-line-remove-${index + 1}`}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    حذف
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field id={`line-${line.key}-type`} label="نوع ردیف" error={lineErrors.lineType}>
                    <select
                      id={`line-${line.key}-type`}
                      value={line.lineType}
                      disabled={disabled}
                      aria-invalid={lineErrors.lineType ? true : undefined}
                      aria-describedby={
                        lineErrors.lineType ? `line-${line.key}-type-error` : undefined
                      }
                      onChange={(event) =>
                        update(line.key, { lineType: event.target.value as CommerceLineType })
                      }
                      className={inputClass}
                    >
                      {COMMERCE_LINE_TYPES.map((value) => (
                        <option key={value} value={value}>
                          {commerceLineTypeLabel(value)}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field id={`line-${line.key}-quantity`} label="مقدار" error={lineErrors.quantity}>
                    <input
                      id={`line-${line.key}-quantity`}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={line.quantity}
                      disabled={disabled}
                      aria-invalid={lineErrors.quantity ? true : undefined}
                      aria-describedby={
                        lineErrors.quantity ? `line-${line.key}-quantity-error` : undefined
                      }
                      onChange={(event) => update(line.key, { quantity: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field id={`line-${line.key}-unit`} label="واحد" error={lineErrors.unit}>
                    <input
                      id={`line-${line.key}-unit`}
                      type="text"
                      dir="ltr"
                      maxLength={COMMERCE_LINE_LIMITS.unit}
                      value={line.unit}
                      disabled={disabled}
                      aria-invalid={lineErrors.unit ? true : undefined}
                      aria-describedby={lineErrors.unit ? `line-${line.key}-unit-error` : undefined}
                      onChange={(event) => update(line.key, { unit: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field
                    id={`line-${line.key}-unit-price`}
                    label="قیمت واحد"
                    error={lineErrors.unitPrice}
                  >
                    <input
                      id={`line-${line.key}-unit-price`}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={line.unitPrice}
                      disabled={disabled}
                      aria-invalid={lineErrors.unitPrice ? true : undefined}
                      aria-describedby={
                        lineErrors.unitPrice ? `line-${line.key}-unit-price-error` : undefined
                      }
                      onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field id={`line-${line.key}-tax`} label="مبلغ مالیات" error={lineErrors.tax}>
                    <input
                      id={`line-${line.key}-tax`}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={line.tax}
                      disabled={disabled}
                      aria-invalid={lineErrors.tax ? true : undefined}
                      aria-describedby={lineErrors.tax ? `line-${line.key}-tax-error` : undefined}
                      onChange={(event) => update(line.key, { tax: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field
                    id={`line-${line.key}-item-reference`}
                    label="شناسهٔ کالا/سرویس"
                    error={lineErrors.itemReference}
                  >
                    <input
                      id={`line-${line.key}-item-reference`}
                      type="text"
                      dir="ltr"
                      maxLength={COMMERCE_LINE_LIMITS.itemReference}
                      value={line.itemReference}
                      disabled={disabled}
                      aria-invalid={lineErrors.itemReference ? true : undefined}
                      aria-describedby={
                        lineErrors.itemReference
                          ? `line-${line.key}-item-reference-error`
                          : undefined
                      }
                      onChange={(event) => update(line.key, { itemReference: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field
                    id={`line-${line.key}-external-ref`}
                    label="ارجاع خارجی"
                    error={lineErrors.externalRef}
                  >
                    <input
                      id={`line-${line.key}-external-ref`}
                      type="text"
                      dir="ltr"
                      maxLength={COMMERCE_LINE_LIMITS.externalRef}
                      value={line.externalRef}
                      disabled={disabled}
                      aria-invalid={lineErrors.externalRef ? true : undefined}
                      aria-describedby={
                        lineErrors.externalRef ? `line-${line.key}-external-ref-error` : undefined
                      }
                      onChange={(event) => update(line.key, { externalRef: event.target.value })}
                      className={`${inputClass} text-start`}
                    />
                  </Field>

                  <Field
                    id={`line-${line.key}-description`}
                    label="شرح فنی / مشخصات موردنیاز"
                    error={lineErrors.technicalDescription}
                    className="sm:col-span-2 lg:col-span-4"
                  >
                    <textarea
                      id={`line-${line.key}-description`}
                      rows={3}
                      maxLength={COMMERCE_LINE_LIMITS.technicalDescription}
                      value={line.technicalDescription}
                      disabled={disabled}
                      aria-invalid={lineErrors.technicalDescription ? true : undefined}
                      aria-describedby={
                        lineErrors.technicalDescription
                          ? `line-${line.key}-description-error`
                          : undefined
                      }
                      onChange={(event) =>
                        update(line.key, { technicalDescription: event.target.value })
                      }
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm leading-7 text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                    />
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        <Button
          type="button"
          onClick={add}
          disabled={disabled}
          data-testid="commerce-line-add"
          className="border border-border bg-background text-foreground hover:bg-secondary"
        >
          افزودن ردیف
        </Button>
      </div>
    </div>
  );
}