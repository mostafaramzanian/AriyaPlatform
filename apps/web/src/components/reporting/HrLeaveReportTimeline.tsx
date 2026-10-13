'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  HR_LEAVE_REPORT_PAGE_SIZE,
  fetchHrLeaveReportTimeline,
  type ReportingLeaveTimelinePage,
} from '@/lib/hr-leave-report-api';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the report's FLOW section — the ONE
 * authoritative timeline for a selected register row.
 *
 * THE TIMELINE IS HR'S OWN TRAIL, not a reconstruction: the Reporting route
 * reads the same platform audit events (`hr.leave` bound to this row) the
 * register writes. `create` is a submission, `update` a restatement of a pending
 * request, `cancel` a withdrawal, `approve`/`reject` the flow's decisions — an
 * unknown action renders verbatim, never renamed. An outage (503) renders as a
 * refusal with retry; raw actor ids are NOT rendered (no display contract).
 */
const LEAVE_AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'ثبت درخواست',
  update: 'ویرایش درخواست',
  cancel: 'لغو درخواست',
  approve: 'تأیید',
  reject: 'رد',
};

function leaveAuditActionLabel(action: string): string {
  return LEAVE_AUDIT_ACTION_LABELS[action] ?? action;
}

export function HrLeaveReportTimeline({ rowId }: { rowId: string }) {
  const [data, setData] = React.useState<ReportingLeaveTimelinePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  // Loading/error arming lives in event handlers (retry, pagination) and in the
  // id-change reset below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRowId, setPrevRowId] = React.useState(rowId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error synchronously during render (one extra render,
  // no effect setter). Page changes arm through goToPage below, retries through
  // reload() — both in the same handler commit as their trigger, so each user
  // action still issues exactly one request.
  if (prevRowId !== rowId) {
    setPrevRowId(rowId);
    setLoading(true);
    setError(null);
  }
  const goToPage = (next: number) => {
    setPage(next);
    reload();
  };

  React.useEffect(() => {
    let active = true;

    fetchHrLeaveReportTimeline(rowId, {
      page,
      pageSize: HR_LEAVE_REPORT_PAGE_SIZE,
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
  }, [rowId, page, reloadToken]);

  const items = data?.items ?? [];

  return (
    <section className="core-card p-4 sm:p-6" data-testid="hr-leave-report-timeline">
      <h3 className="text-base font-semibold text-foreground">گردش درخواست</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        رویدادهای ثبت‌شده برای این درخواست — از همان تاریخچه‌ای که خود دفتر مرخصی می‌نویسد.
      </p>

      {loading && items.length === 0 ? (
        <div className="mt-4" data-testid="hr-leave-report-timeline-loading" aria-busy="true">
          <CoreLoading label="در حال بارگذاری گردش…" lines={3} />
        </div>
      ) : error ? (
        <div className="mt-4" data-testid="hr-leave-report-timeline-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      ) : items.length === 0 ? (
        <p
          className="mt-4 text-sm text-muted-foreground"
          data-testid="hr-leave-report-timeline-empty"
        >
          برای این درخواست هنوز رویدادی ثبت نشده است.
        </p>
      ) : (
        <ol className="mt-4 space-y-3" data-testid="hr-leave-report-timeline-list">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid={`hr-leave-report-timeline-item-${item.id}`}
              className="rounded-xl border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {leaveAuditActionLabel(item.action)}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {toPersianDigits(item.createdAt)}
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
          data-testid="hr-leave-report-timeline-pagination"
          aria-label="صفحه‌بندی گردش درخواست"
        >
          <button
            type="button"
            data-testid="hr-leave-report-timeline-prev"
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
            data-testid="hr-leave-report-timeline-next"
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
