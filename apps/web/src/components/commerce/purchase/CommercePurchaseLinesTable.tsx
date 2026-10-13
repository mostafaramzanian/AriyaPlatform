'use client';

import * as React from 'react';

import { toPersianDigits } from '@/lib/calendar-api';
import type {
  CommerceAssignment,
  CommercePurchaseLine,
  CommerceReceivingLineProjection,
} from '@/lib/commerce-api';
import { commerceLineTypeLabel } from '@/lib/commerce-labels';
import { decimalDisplayLabel } from '@/lib/commerce-decimals';
import { CommerceAssignmentStatusBadge, CommerceReceivingStatusBadge } from '../commerce-ui';

/**
 * PHASE UI-2: the document's lines. Two DISPLAY JOINTS that UI-0 authorizes (§10.4):
 * per-line receiving projection and per-line commercial assignment — both reads of THIS
 * same document, never verdicts. While the receiving read is loading (or failed) the
 * column says so honestly; the values shown are the exact wire strings, formatted.
 */
export function CommercePurchaseLinesTable({
  lines,
  receiving,
  receivingState,
  assignments,
}: {
  lines: CommercePurchaseLine[];
  receiving: CommerceReceivingLineProjection[] | null;
  receivingState: 'loading' | 'ready' | 'error';
  assignments: CommerceAssignment[] | null;
}) {
  const receivingByLine = React.useMemo(() => {
    const map = new Map<string, CommerceReceivingLineProjection>();
    for (const row of receiving ?? []) map.set(row.purchaseLineId, row);
    return map;
  }, [receiving]);

  const assignmentByLine = React.useMemo(() => {
    const map = new Map<string, CommerceAssignment>();
    for (const row of assignments ?? []) map.set(row.purchaseLineId, row);
    return map;
  }, [assignments]);

  const headers: Array<{ key: string; label: string; align: 'start' | 'end' }> = [
    { key: 'number', label: 'ردیف', align: 'start' },
    { key: 'type', label: 'نوع', align: 'start' },
    { key: 'description', label: 'شرح', align: 'start' },
    { key: 'quantity', label: 'مقدار', align: 'end' },
    { key: 'unit', label: 'واحد', align: 'start' },
    { key: 'unitPrice', label: 'قیمت واحد', align: 'end' },
    { key: 'lineTotal', label: 'جمع ردیف', align: 'end' },
    { key: 'receiving', label: 'دریافت', align: 'start' },
    { key: 'assignment', label: 'گروه بازرگانی', align: 'start' },
  ];

  return (
    <div data-testid="commerce-document-lines">
      {receivingState === 'error' && (
        <p className="mb-3 text-xs text-muted-foreground">
          وضعیت دریافت ردیف‌ها در دسترس نیست؛ مقادیر آن ستون نمایش داده نمی‌شود.
        </p>
      )}

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">ردیف‌های درخواست خرید</caption>
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              {headers.map((header) => (
                <th
                  key={header.key}
                  scope="col"
                  className={`py-2 pe-3 font-medium ${
                    header.align === 'end' ? 'text-end' : 'text-start'
                  }`}
                >
                  {header.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const receivingRow = receivingByLine.get(line.id);
              const assignment = assignmentByLine.get(line.id);
              return (
                <tr key={line.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pe-3 text-foreground">{toPersianDigits(line.lineNumber)}</td>
                  <td className="py-2 pe-3 text-foreground">
                    {commerceLineTypeLabel(line.lineType)}
                  </td>
                  <td className="py-2 pe-3 text-foreground">
                    <span className="line-clamp-2">{line.technicalDescription ?? '—'}</span>
                    {line.itemReference && (
                      <span dir="ltr" className="mt-1 block text-xs text-muted-foreground">
                        {line.itemReference}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pe-3 text-end text-foreground">
                    {decimalDisplayLabel(line.quantity)}
                  </td>
                  <td className="py-2 pe-3 text-start text-foreground">{line.unit ?? '—'}</td>
                  <td className="py-2 pe-3 text-end text-foreground">
                    {decimalDisplayLabel(line.unitPrice)}
                  </td>
                  <td className="py-2 pe-3 text-end text-foreground">
                    {decimalDisplayLabel(line.lineTotal)}
                  </td>
                  <td className="py-2 pe-3">
                    {receivingState === 'loading' ? (
                      <span className="text-xs text-muted-foreground">در حال بارگذاری…</span>
                    ) : receivingRow ? (
                      <span className="inline-flex flex-col gap-1">
                        <CommerceReceivingStatusBadge status={receivingRow.receivingStatus} />
                        <span className="text-xs text-muted-foreground">
                          {decimalDisplayLabel(receivingRow.receivedQuantity)} از{' '}
                          {decimalDisplayLabel(receivingRow.orderedQuantity)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    {assignment ? (
                      <span className="inline-flex flex-col gap-1">
                        <CommerceAssignmentStatusBadge status={assignment.status} />
                        <span
                          dir="ltr"
                          className="max-w-[10rem] truncate text-xs text-muted-foreground"
                        >
                          {assignment.commercialGroupId ?? '—'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}