'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchPurchaseReportTimeline,
  PURCHASE_REPORT_PAGE_SIZE,
  type ReportingPurchaseTimelinePage,
} from '@/lib/purchase-report-api';
import { commerceDateLabel, commercePurchaseAuditActionLabel } from '@/lib/commerce-labels';

/**
 * Phase REPORTING-PURCHASE-REPORT: the report's FLOW section — the ONE authoritative
 * timeline for a selected purchase document.
 *
 * THE TIMELINE IS COMMERCE'S OWN TRAIL, not a reconstruction: the Reporting route
 * reads the same platform audit events (`commerce.purchase_document` bound to this row)
 * Commerce's own timeline route reads. No event is manufactured from timestamps, no
 * second history table exists, and nothing here writes.
 *
 * FETCHED ON DEMAND: only the selected document's timeline, only while this component
 * is mounted — never per report row.
 *
 * AN OUTAGE IS VISIBLE: the API answers 503 (`AUDIT_READ_FAILED`) rather than a
 * silent empty page, and this component renders that refusal with retry — «nothing was
 * recorded» and «we could not ask» must never look alike.
 *
 * Raw `actorId`s are deliberately NOT rendered: the contract carries them only as
 * correlation facts, and without a directory display contract an opaque uuid is noise,
 * not information.
 */
export function PurchaseReportTimeline({ documentId }: { documentId: string }) {
  const [data, setData] = React.useState<ReportingPurchaseTimelinePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  // Loading/error arming lives in event handlers (retry, pagination) and in the
  // id-change reset below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevDocumentId, setPrevDocumentId] = React.useState(documentId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error synchronously during render (one extra render,
  // no effect setter). Page changes arm through goToPage below, retries through
  // reload() — both in the same handler commit as their trigger, so each user
  // action still issues exactly one request.
  if (prevDocumentId !== documentId) {
    setPrevDocumentId(documentId);
    setLoading(true);
    setError(null);
  }
  const goToPage = (next: number) => {
    setPage(next);
    reload();
  };

  React.useEffect(() => {
    let active = true;

    fetchPurchaseReportTimeline(documentId, {
      page,
      pageSize: PURCHASE_REPORT_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت گردش درخواست با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [documentId, page, reloadToken]);

  const items = data?.items ?? [];

  return (
    <section className="core-card p-4 sm:p-6" data-testid="purchase-report-timeline">
      <h3 className="text-base font-semibold text-foreground">گردش درخواست</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        رویدادهای ثبت‌شده برای این سند — از همان تاریخچه‌ای که خود تدارکات می‌خواند.
      </p>

      {loading && items.length === 0 ? (
        <div className="mt-4" data-testid="purchase-report-timeline-loading" aria-busy="true">
          <CoreLoading label="در حال بارگذاری گردش…" lines={3} />
        </div>
      ) : error ? (
        <div className="mt-4" data-testid="purchase-report-timeline-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      ) : items.length === 0 ? (
        <p
          className="mt-4 text-sm text-muted-foreground"
          data-testid="purchase-report-timeline-empty"
        >
          برای این سند هنوز رویدادی ثبت نشده است.
        </p>
      ) : (
        <ol className="mt-4 space-y-3" data-testid="purchase-report-timeline-list">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid={`purchase-report-timeline-item-${item.id}`}
              className="rounded-xl border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {commercePurchaseAuditActionLabel(item.action)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {commerceDateLabel(item.createdAt)}
                </span>
              </div>
              {item.reason && <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>}
              {item.changedFields.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  فیلدهای تغییرکرده: {toPersianDigits(item.changedFields.length)} مورد
                </p>
              )}
              {!item.success && (
                <p className="mt-1 text-xs text-destructive">این رویداد ناموفق ثبت شده است.</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {data && data.total > data.pageSize && !error && (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          data-testid="purchase-report-timeline-pagination"
          aria-label="صفحه‌بندی گردش درخواست"
        >
          <button
            type="button"
            data-testid="purchase-report-timeline-prev"
            disabled={page <= 1 || loading}
            onClick={() => goToPage(page - 1)}
            className="rounded-xl border border-border px-3 py-1 disabled:opacity-40"
          >
            قبلی
          </button>
          <span className="text-muted-foreground">
            صفحه {toPersianDigits(page)} از{' '}
            {toPersianDigits(Math.max(1, Math.ceil(data.total / data.pageSize)))}
          </span>
          <button
            type="button"
            data-testid="purchase-report-timeline-next"
            disabled={page * data.pageSize >= data.total || loading}
            onClick={() => goToPage(page + 1)}
            className="rounded-xl border border-border px-3 py-1 disabled:opacity-40"
          >
            بعدی
          </button>
        </nav>
      )}
    </section>
  );
}
