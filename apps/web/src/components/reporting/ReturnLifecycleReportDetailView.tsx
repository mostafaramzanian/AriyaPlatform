'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchReturnLifecycleReportRow,
  fetchReturnLifecycleReportTimeline,
  type ReportingReturnDetail,
  type ReportingReturnTimelinePage,
} from '@/lib/return-lifecycle-report-api';
import {
  commerceInstantLabel,
  commerceReturnStateLabel,
  commerceReturnStateTone,
  type CommerceTone,
} from '@/lib/commerce-labels';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the READ-ONLY detail for ONE return —
 * `/admin/reporting/commerce/return-lifecycle/[id]`. Understanding and reviewing
 * the recorded request only: its header facts, its returned lines, and its
 * audit-backed lifecycle timeline. No approve, no reject, no receive-back, no
 * refund, no mutation, and no link into a Commerce wizard. Raw actor ids
 * (`requestedByUserId`, transition actors) are never rendered — the contract
 * withholds them; request-local ids (line origins) render as-is, like the purchase
 * detail's opaque `supplierId`.
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

export function ReturnLifecycleReportDetailView({ returnId }: { returnId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');

  const [row, setRow] = React.useState<ReportingReturnDetail | null>(null);
  const [timeline, setTimeline] = React.useState<ReportingReturnTimelinePage | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [timelineError, setTimelineError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in `reload` (same commit as the token bump), so
  // the read effect needs no in-effect setter resets; the timeline resets
  // ride `reload` and the id adjustment below. First mount is covered by
  // `isLoading: true`.
  const { token: reloadToken, reload: reloadDetail } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadDetail();
    setTimeline(null);
    setTimelineError(null);
  };

  // A new return id is a NEW read of both the row and its timeline:
  // re-arm during render, guarded by the previous prop. Mount is a no-op
  // (isLoading already armed by its initial value).
  const [prevReturnId, setPrevReturnId] = React.useState(returnId);
  if (prevReturnId !== returnId) {
    setPrevReturnId(returnId);
    setLoading(true);
    setError(null);
    setTimeline(null);
    setTimelineError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchReturnLifecycleReportRow(returnId)
      .then((result) => {
        if (!active) return;
        setRow(result);
        setLoading(false);
        // The timeline is a SECOND read over the same id: existence was just proved
        // by the row above, and a timeline outage must not hide the row itself.
        fetchReturnLifecycleReportTimeline(returnId)
          .then((page) => {
            if (!active) return;
            setTimeline(page);
          })
          .catch(() => {
            if (!active) return;
            setTimelineError('تاریخچه چرخه در حال حاضر در دسترس نیست.');
          });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت جزئیات گزارش با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [returnId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="return-lifecycle-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="return-lifecycle-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="return-lifecycle-report-detail-error">
        <CoreError
          message={error ?? 'این مرجوعی یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="return-lifecycle-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/commerce/return-lifecycle"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش چرخه حیات مرجوعی‌ها
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          مرجوعی {row.purchaseDocumentNumber}
        </h2>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span
            data-testid={`return-lifecycle-report-state-${row.state}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[commerceReturnStateTone(row.state)]}`}
          >
            {commerceReturnStateLabel(row.state)}
          </span>
          <span title={row.createdAt}>{commerceInstantLabel(row.createdAt)}</span>
        </p>
      </div>

      <section className="core-card p-4 sm:p-6" data-testid="return-lifecycle-report-detail-card">
        <h3 className="text-base font-semibold text-foreground">مشخصات مرجوعی</h3>
        <dl className="mt-2 divide-y divide-border/60">
          <Field label="شماره سند خرید" value={row.purchaseDocumentNumber} />
          <Field label="دلیل" value={row.reason} />
          <Field label="نیازمند جایگزینی" value={row.replacementRequired ? 'بله' : 'خیر'} />
          <Field label="تعداد اقلام" value={toPersianDigits(row.lineCount)} />
          <Field label="تاریخ درخواست" value={commerceInstantLabel(row.createdAt)} />
        </dl>
      </section>

      <section className="core-card p-4 sm:p-6" data-testid="return-lifecycle-report-detail-lines">
        <h3 className="text-base font-semibold text-foreground">اقلام مرجوع‌شده</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">اقلام مرجوع‌شده</caption>
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  مقدار
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  ثبت
                </th>
              </tr>
            </thead>
            <tbody>
              {row.lines.map((line) => (
                <tr
                  key={line.id}
                  data-testid={`return-lifecycle-report-detail-line-${line.id}`}
                  className="border-b border-border/60 last:border-b-0"
                >
                  <td className="px-3 py-3 tabular-nums text-foreground">{line.quantity}</td>
                  <td className="px-3 py-3 text-muted-foreground">
                    <span title={line.createdAt}>{commerceInstantLabel(line.createdAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="core-card p-4 sm:p-6"
        data-testid="return-lifecycle-report-detail-timeline"
      >
        <h3 className="text-base font-semibold text-foreground">چرخه حیات</h3>
        {timelineError ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="return-lifecycle-report-detail-timeline-error"
          >
            {timelineError}
          </p>
        ) : timeline ? (
          timeline.items.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              هنوز رویدادی برای این مرجوعی ثبت نشده است.
            </p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2">
              {timeline.items.map((item) => (
                <li
                  key={item.id}
                  data-testid={`return-lifecycle-report-detail-timeline-${item.action}`}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="font-medium text-foreground">{item.action}</span>
                  {item.reason ? (
                    <span className="text-muted-foreground">— {item.reason}</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground" title={item.createdAt}>
                    {commerceInstantLabel(item.createdAt)}
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">در حال بارگذاری چرخه…</p>
        )}
      </section>
    </div>
  );
}
