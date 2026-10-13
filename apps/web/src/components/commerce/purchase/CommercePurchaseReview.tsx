'use client';

import { toPersianDigits } from '@/lib/calendar-api';
import type { CommercePurchaseLineDraft } from '@/lib/commerce-api';
import { commerceLineTypeLabel } from '@/lib/commerce-labels';
import { CommerceSectionHeading } from '../commerce-ui';

/**
 * PHASE UI-2: the review checkpoint before «ذخیرهٔ پیش‌نویس» / «ثبت و ارسال».
 *
 * WHAT THIS IS. A READ-ONLY restatement of exactly what will be sent: the main fields,
 * every line, and — where a value exists on the wire — its formatted twin. The user scans
 * it and decides; pressing a button is the only thing that writes anything.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a validation engine and not an arithmetic
 * engine: no subtotal, no tax total, no grand total. C1 derives `lineTotal`, the
 * document's `subtotalAmount`/`taxAmount`/`totalAmount` server-side inside the write, and
 * a number computed here could disagree with the stored one the moment the rule changes —
 * so the panel says so instead of guessing. Blank optional fields render «—» (not 0:
 * unstated and zero are different facts).
 */
export function CommercePurchaseReview({
  requesterId,
  supplierId,
  currency,
  lines,
}: {
  requesterId: string;
  supplierId: string;
  currency: string;
  lines: CommercePurchaseLineDraft[];
}) {
  return (
    <div data-testid="commerce-purchase-review" className="space-y-6">
      <section>
        <CommerceSectionHeading title="اطلاعات اصلی" />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">درخواست‌کننده</dt>
            <dd dir="ltr" className="mt-1 truncate text-start text-foreground">
              {requesterId || '—'}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">تأمین‌کننده</dt>
            <dd dir="ltr" className="mt-1 truncate text-start text-foreground">
              {supplierId.trim() || '—'}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">ارز</dt>
            <dd dir="ltr" className="mt-1 truncate text-start text-foreground">
              {currency.trim() || '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <CommerceSectionHeading
          title={`اقلام (${toPersianDigits(lines.length)} ردیف)`}
          description="ترتیب ردیف‌ها همان ترتیبی است که ثبت می‌شود."
        />

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">اقلام درخواست خرید در حال ثبت</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  ردیف
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  نوع
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  شرح
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  مقدار
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  واحد
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  قیمت واحد
                </th>
                <th scope="col" className="py-2 text-end font-medium">
                  مالیات
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key} className="border-b border-border/60 align-top">
                  <td className="py-2 pe-3 text-foreground">{toPersianDigits(index + 1)}</td>
                  <td className="py-2 pe-3 text-foreground">
                    {commerceLineTypeLabel(line.lineType)}
                  </td>
                  <td className="py-2 pe-3 text-foreground">
                    <span className="line-clamp-2">{line.technicalDescription.trim() || '—'}</span>
                  </td>
                  <td dir="ltr" className="py-2 pe-3 text-end text-foreground">
                    {line.quantity.trim() || '—'}
                  </td>
                  <td dir="ltr" className="py-2 pe-3 text-start text-foreground">
                    {line.unit.trim() || '—'}
                  </td>
                  <td dir="ltr" className="py-2 pe-3 text-end text-foreground">
                    {line.unitPrice.trim() || '—'}
                  </td>
                  <td dir="ltr" className="py-2 text-end text-foreground">
                    {line.tax.trim() || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          جمع ردیف‌ها، جمع کل و مالیات پس از ثبت سند، توسط سرور محاسبه و نمایش داده می‌شود؛
          پیش‌نمایش محاسباتی در این صفحه ارائه نمی‌شود.
        </p>
      </section>
    </div>
  );
}