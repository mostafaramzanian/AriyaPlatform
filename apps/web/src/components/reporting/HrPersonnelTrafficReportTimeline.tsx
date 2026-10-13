'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  HR_PERSONNEL_TRAFFIC_PAGE_SIZE,
  fetchHrPersonnelTrafficReportTimeline,
  type ReportingPersonnelTrafficTimelinePage,
} from '@/lib/hr-personnel-traffic-report-api';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the report's FLOW section — the ONE
 * authoritative timeline for a selected register row.
 *
 * THE TIMELINE IS HR'S OWN TRAIL, not a reconstruction: the Reporting route reads the
 * same platform audit events (`hr.attendance` bound to this row) HR's register writes.
 * No event is inferred from a timestamp, no second history table exists, nothing here
 * writes.
 *
 * ACTION VOCABULARY: the API carries the audit actions HR's register actually records —
 * `create` (the punch), `update` (the clock-out) and `adjust` (the manual correction).
 * The labels below mirror the API's audit vocabulary, the same mirroring
 * `productionBomAuditActionLabel` performs for Production. An unknown action renders
 * verbatim rather than being renamed: the screen never knows more than the trail.
 *
 * FETCHED ON DEMAND: only the selected row's timeline, only while mounted — never per
 * table row. AN OUTAGE IS VISIBLE: the API answers 503 (`AUDIT_READ_FAILED`) rather
 * than a silent empty page, and this component renders that refusal with retry —
 * «nothing was recorded» and «we could not ask» must never look alike.
 *
 * Raw `actorId`s are deliberately NOT rendered: the contract carries them only as
 * correlation facts, and without a directory display contract an opaque uuid is noise,
 * not information.
 */
const ATTENDANCE_AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'ثبت',
  update: 'به‌روزرسانی',
  adjust: 'اصلاح',
};

function attendanceAuditActionLabel(action: string): string {
  return ATTENDANCE_AUDIT_ACTION_LABELS[action] ?? action;
}

export function HrPersonnelTrafficReportTimeline({ rowId }: { rowId: string }) {
  const [data, setData] = React.useState<ReportingPersonnelTrafficTimelinePage | null>(null);
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

    fetchHrPersonnelTrafficReportTimeline(rowId, {
      page,
      pageSize: HR_PERSONNEL_TRAFFIC_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت گردش رکورد با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [rowId, page, reloadToken]);

  const items = data?.items ?? [];

  return (
    <section className="core-card p-4 sm:p-6" data-testid="hr-personnel-traffic-report-timeline">
      <h3 className="text-base font-semibold text-foreground">گردش رکورد</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        رویدادهای ثبت‌شده برای این رکورد — از همان تاریخچه‌ای که خود دفتر حضور و غیاب می‌نویسد.
      </p>

      {loading && items.length === 0 ? (
        <div
          className="mt-4"
          data-testid="hr-personnel-traffic-report-timeline-loading"
          aria-busy="true"
        >
          <CoreLoading label="در حال بارگذاری گردش…" lines={3} />
        </div>
      ) : error ? (
        <div className="mt-4" data-testid="hr-personnel-traffic-report-timeline-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      ) : items.length === 0 ? (
        <p
          className="mt-4 text-sm text-muted-foreground"
          data-testid="hr-personnel-traffic-report-timeline-empty"
        >
          برای این رکورد هنوز رویدادی ثبت نشده است.
        </p>
      ) : (
        <ol className="mt-4 space-y-3" data-testid="hr-personnel-traffic-report-timeline-list">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid={`hr-personnel-traffic-report-timeline-item-${item.id}`}
              className="rounded-xl border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {attendanceAuditActionLabel(item.action)}
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
          data-testid="hr-personnel-traffic-report-timeline-pagination"
          aria-label="صفحه‌بندی گردش رکورد"
        >
          <button
            type="button"
            data-testid="hr-personnel-traffic-report-timeline-prev"
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
            data-testid="hr-personnel-traffic-report-timeline-next"
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
