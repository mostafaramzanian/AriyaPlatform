'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchCheckRequestReportTimeline,
  REPORTING_CHECK_REQUEST_PAGE_SIZE,
  type ReportingTimelinePage,
} from '@/lib/reporting-api';
import { financialAuditActionLabel, financialDateLabel } from '@/lib/financial-labels';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the report's FLOW section — the ONE
 * authoritative timeline for a selected request.
 *
 * THE TIMELINE IS FINANCIAL'S OWN TRAIL, not a reconstruction: the Reporting
 * route reads the same platform audit events (`financial.check-request`
 * bound to this row) the Financial timeline reads. No event is manufactured
 * from timestamps, no second history table exists, and nothing here writes
 * (phase brief §6/§32).
 *
 * FETCHED ON DEMAND: only the selected request's timeline, only while this
 * component is mounted — never per report row (phase brief §15).
 *
 * AN OUTAGE IS VISIBLE: the API answers 503 (`AUDIT_READ_FAILED`) rather than
 * a silent empty page, and this component renders that refusal with retry —
 * «nothing was recorded» and «we could not ask» must never look alike.
 */
export function CheckRequestReportTimeline({ requestId }: { requestId: string }) {
  const [data, setData] = React.useState<ReportingTimelinePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  // Loading/error arming lives in event handlers (retry, pagination) and in the
  // id-change reset below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRequestId, setPrevRequestId] = React.useState(requestId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error synchronously during render (one extra render,
  // no effect setter). Page changes arm through goToPage below, retries through
  // reload() — both in the same handler commit as their trigger, so each user
  // action still issues exactly one request.
  if (prevRequestId !== requestId) {
    setPrevRequestId(requestId);
    setLoading(true);
    setError(null);
  }
  const goToPage = (next: number) => {
    setPage(next);
    reload();
  };

  React.useEffect(() => {
    let active = true;

    fetchCheckRequestReportTimeline(requestId, {
      page,
      pageSize: REPORTING_CHECK_REQUEST_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(
          err instanceof Error ? err.message : 'دریافت گردش درخواست با خطا مواجه شد.'
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [requestId, page, reloadToken]);

  const items = data?.items ?? [];

  return (
    <section className="core-card p-4 sm:p-6" data-testid="reporting-timeline">
      <h3 className="text-base font-semibold text-foreground">گردش درخواست</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        رویدادهای ثبت‌شده این درخواست، به ترتیب زمانی
      </p>

      {error && (
        <div className="mt-4" data-testid="reporting-timeline-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {loading ? (
        <div className="mt-4">
          <CoreLoading lines={3} />
        </div>
      ) : items.length === 0 && !error ? (
        <p
          className="mt-4 rounded-xl border border-dashed border-border bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground"
          data-testid="reporting-timeline-empty"
        >
          رویدادی برای این درخواست ثبت نشده است.
        </p>
      ) : (
        <ol className="mt-4 space-y-3" data-testid="reporting-timeline-list">
          {items.map((entry) => (
            <li
              key={entry.id}
              data-testid={`reporting-timeline-row-${entry.action}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <span className="font-medium text-foreground">
                {financialAuditActionLabel(entry.action)}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{financialDateLabel(entry.createdAt)}</span>
                {!entry.success && <span className="text-destructive">ناموفق</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {data && data.total > data.pageSize && !error && (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          data-testid="reporting-timeline-pagination"
          aria-label="صفحه‌بندی گردش درخواست"
        >
          <button
            type="button"
            data-testid="reporting-timeline-prev"
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
            data-testid="reporting-timeline-next"
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
