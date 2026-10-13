'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { useReloadToken } from '@/hooks/use-reload-token';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  FINANCIAL_DEFAULT_PAGE_SIZE,
  fetchFinancialCheckRequestTimeline,
  type FinancialTimelinePage,
} from '@/lib/financial-api';
import { financialAuditActionLabel, financialDateLabel } from '@/lib/financial-labels';
import { FinancialCard, FinancialEmptyState, FinancialPageHeading } from './financial-ui';

/**
 * Phase F1 — FINANCIAL FOUNDATION: «سابقه گردش فرآیند» — the check-request audit
 * timeline, read from the platform Audit Port through
 * `GET /financial/check-requests/:id/timeline`.
 *
 * THE SOURCE HAD A `CheckHistory` GRID (Preflight §12) whose writer was the SharePoint
 * workflow — `NOT ESTABLISHED` (U4). This screen does NOT reconstruct that list: it reads
 * the ONE platform trail (`financial.check-request` bound to this row), exactly the
 * architecture Production and Commerce's timelines use. No module audit table exists and
 * none is invented.
 *
 * AN OUTAGE IS VISIBLE. The route answers 503 (`AUDIT_READ_FAILED`) rather than an empty
 * page, and this component renders that refusal with retry — "nothing was recorded" and
 * "we could not ask" must never be the same screen.
 */
export function CheckRequestTimeline({ requestId }: { requestId: string }) {
  const [data, setData] = React.useState<FinancialTimelinePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  // Loading/error arming lives in the pagination/retry handlers below and in
  // the requestId-change reset — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles. First mount
  // is covered by the initial `loading: true`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRequestId, setPrevRequestId] = React.useState(requestId);
  if (prevRequestId !== requestId) {
    setPrevRequestId(requestId);
    // NOTE: `page` is deliberately NOT reset — the pre-remediation effect
    // refetched with the current page on an id change; semantics preserved.
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let active = true;

    fetchFinancialCheckRequestTimeline(requestId, { page, pageSize: FINANCIAL_DEFAULT_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت تاریخچه با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [requestId, page, reloadToken]);

  const items = data?.items ?? [];

  return (
    <FinancialCard testId="financial-timeline-section">
      <FinancialPageHeading
        testId="financial-timeline-heading"
        title="سابقه گردش فرآیند"
        description="رویدادهای ثبت‌شده این درخواست، به ترتیب زمانی"
      />

      {error && (
        <div className="mb-4" data-testid="financial-timeline-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {loading ? (
        <CoreLoading lines={3} />
      ) : items.length === 0 && !error ? (
        <FinancialEmptyState
          message="رویدادی برای این درخواست ثبت نشده است."
          testId="financial-timeline-empty"
        />
      ) : (
        <ol className="space-y-3" data-testid="financial-timeline-list">
          {items.map((entry) => (
            <li
              key={entry.id}
              data-testid={`financial-timeline-row-${entry.action}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <span className="font-medium text-foreground">
                {financialAuditActionLabel(entry.action)}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                {entry.actorId && (
                  <span data-testid="financial-timeline-actor">{entry.actorId}</span>
                )}
                <span>{financialDateLabel(entry.createdAt)}</span>
                {!entry.success && <span className="text-destructive">ناموفق</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {data && data.total > data.pageSize && (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          data-testid="financial-timeline-pagination"
        >
          <button
            type="button"
            data-testid="financial-timeline-prev"
            disabled={page <= 1 || loading}
            onClick={() => {
              // Re-arm in the same commit as the page change (the removed
              // in-effect setters used to do it one render later).
              setLoading(true);
              setError(null);
              setPage((value) => value - 1);
            }}
            className="rounded-xl border border-border px-3 py-1 disabled:opacity-40"
          >
            قبلی
          </button>
          <span className="text-muted-foreground">
            صفحه {toPersianDigits(page)} از {toPersianDigits(Math.ceil(data.total / data.pageSize))}
          </span>
          <button
            type="button"
            data-testid="financial-timeline-next"
            disabled={page * data.pageSize >= data.total || loading}
            onClick={() => {
              setLoading(true);
              setError(null);
              setPage((value) => value + 1);
            }}
            className="rounded-xl border border-border px-3 py-1 disabled:opacity-40"
          >
            بعدی
          </button>
        </nav>
      )}
    </FinancialCard>
  );
}
